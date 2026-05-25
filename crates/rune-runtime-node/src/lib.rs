//! Node.js (libnode) backend for Rune.
//!
//! Phase 1 scope: scaffolding only. The C++ shim (`shim/rune_node.cc`)
//! initialises a Node `MultiIsolatePlatform` + `CommonEnvironmentSetup`
//! and runs a `LoadEnvironment` bootstrap string. Script loading, event
//! dispatch, command drain, and event-loop ticking are stubbed -- they
//! compile but do nothing useful until phase 2-4.
//!
//! See `DESIGN_SPEC.md` §6 for the trait contract.

use std::ffi::{CString, c_char};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use rune_host_api::{HostCommand, LanguageRuntime, QueryCallback, RuntimeError};

// ---------------------------------------------------------------------------
// FFI surface -- mirrors shim/rune_node.h exactly.
// ---------------------------------------------------------------------------

#[allow(non_camel_case_types, dead_code)]
mod ffi {
    use std::ffi::c_char;

    #[repr(C)]
    pub struct RuneNode {
        _private: [u8; 0],
    }

    pub const RUNE_NODE_OK: i32 = 0;
    pub const _RUNE_NODE_ERR: i32 = -1;
    pub const _RUNE_NODE_INIT_FAILED: i32 = -2;
    pub const _RUNE_NODE_NOT_INITIALIZED: i32 = -3;

    unsafe extern "C" {
        pub fn rune_node_platform_init() -> i32;
        pub fn rune_node_platform_shutdown();

        pub fn rune_node_new() -> *mut RuneNode;
        pub fn rune_node_free(rn: *mut RuneNode);

        pub fn rune_node_bootstrap(rn: *mut RuneNode, setup_js: *const c_char) -> i32;
        pub fn rune_node_load_script(
            rn: *mut RuneNode,
            path: *const c_char,
            source: *const c_char,
        ) -> i32;
        pub fn rune_node_tick(rn: *mut RuneNode, budget_ms: i32) -> i32;
        pub fn rune_node_dispatch_event(
            rn: *mut RuneNode,
            name: *const c_char,
            payload: *const u8,
            len: usize,
        ) -> i32;
        pub fn rune_node_drain_commands(
            rn: *mut RuneNode,
            out: *mut u8,
            cap: usize,
        ) -> isize;
        pub fn rune_node_set_query_callback(
            rn: *mut RuneNode,
            cb: super::QueryCallback,
        );
    }
}

// ---------------------------------------------------------------------------
// Process-wide platform init -- exactly once per JVM lifetime.
// ---------------------------------------------------------------------------

// Stored as String because RuntimeError isn't Clone; we wrap on each call.
static PLATFORM_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_platform() -> Result<(), RuntimeError> {
    match PLATFORM_INIT.get_or_init(|| {
        let rc = unsafe { ffi::rune_node_platform_init() };
        if rc == ffi::RUNE_NODE_OK {
            Ok(())
        } else {
            Err(format!("rune_node_platform_init returned {rc}"))
        }
    }) {
        Ok(()) => Ok(()),
        Err(msg) => Err(RuntimeError::Other(msg.clone())),
    }
}

// Bootstrap source -- the Node-side equivalent of our deno_core setup.js.
// Phase 3 + 4a-c:
//   * `rune.broadcast(msg)` routes via `__rune_broadcast` (V8-native) into
//     the C++ command queue, drained by the Kotlin tick as
//     `HostCommand::Broadcast`.
//   * `rune.on(name, fn)` registers a JS handler; the first subscription
//     per event name notifies the host via `__rune_subscribe_event` so
//     unsubscribed events skip the FFI dispatch path entirely.
//   * `console.{log,info,warn,error,debug}` are rewired to `__rune_log_*`
//     so all script output ends up in the Paper server log instead of
//     stdout. `process.{stdout,stderr}.write` is also redirected so
//     libraries that bypass console land in the same place.
//   * `__runeDispatch(name, payload)` is invoked from C++ on every Bukkit
//     event the host has been told we care about.
// Phase 4d will add `__rune_invoke{,_static}` + `__rune_get_static_field`
// behind a sync upcall callback for reflective Bukkit method calls.
// Build the bootstrap JS with the runtime directory substituted in.
// Runtime dir holds esbuild.cjs/.wasm + ts-loader.mjs (extracted by the
// Kotlin plugin from resources/runtime/). The bootstrap registers
// ts-loader.mjs as a Node module hook so user .ts files with decorators
// get esbuild-transformed BEFORE Node's amaro 1.1.8 pipeline sees them.
fn build_bootstrap_js(runtime_dir: &Path) -> String {
    // Always forward-slashes for safe JS string literal embedding (Node
    // accepts both forms on Windows).
    let dir = runtime_dir.to_string_lossy().replace('\\', "/");
    BOOTSTRAP_JS_TEMPLATE.replace("__RUNE_RUNTIME_DIR__", &dir)
}

const BOOTSTRAP_JS_TEMPLATE: &str = r#"
'use strict';

// ---- Runtime TS loader ---------------------------------------------------
// Register the esbuild-backed loader hook BEFORE any user import runs.
// process.env.RUNE_ESBUILD_DIR is read by ts-loader.mjs to find the
// esbuild WASM blob. The replace is performed by Rust at construction.
(function _runeInstallTsLoader() {
  const runtimeDir = '__RUNE_RUNTIME_DIR__';
  process.env.RUNE_ESBUILD_DIR = runtimeDir;
  try {
    const { register } = require('node:module');
    const { pathToFileURL } = require('node:url');
    register(pathToFileURL(runtimeDir + '/ts-loader.mjs').href);
  } catch (e) {
    __rune_log_error('failed to register ts-loader: ' + (e && e.stack || e));
  }
})();

const handlers = new Map();

function _fmt(args) {
  let out = '';
  for (let i = 0; i < args.length; i++) {
    if (i > 0) out += ' ';
    const a = args[i];
    if (typeof a === 'string') {
      out += a;
    } else if (a instanceof Error) {
      out += (a.stack || a.message || String(a));
    } else {
      try { out += JSON.stringify(a); } catch (_) { out += String(a); }
    }
  }
  return out;
}

// Bukkit objects arrive from the host as plain objects with `__ref` and
// `__class`. wrapRef returns a Proxy where unknown property reads become
// methods that invoke through the sync query callback. Returns are revived
// recursively so chains like `world.getBlockAt(x,y,z).getType()` work.
function wrapRef(snapshot) {
  const refId = snapshot.__ref;
  return new Proxy(snapshot, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === Symbol.toPrimitive || prop === 'toString') {
        return () => {
          // If the marshaller embedded a `text` snapshot (e.g. for
          // Adventure Components), use it -- that's the natural human
          // representation. Falls back to a class+id tag so other refs
          // don't print as [object Object] from console.log.
          if (typeof target.text === 'string') return target.text;
          return `[${target.__class}#${target.__ref}]`;
        };
      }
      if (typeof prop !== 'string') return undefined;
      return function (...args) {
        return reviveRefs(__rune_invoke(refId, prop, args));
      };
    },
  });
}

function reviveRefs(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = reviveRefs(value[i]);
    return value;
  }
  for (const k of Object.keys(value)) {
    value[k] = reviveRefs(value[k]);
  }
  if (typeof value.__ref === 'number') {
    return wrapRef(value);
  }
  return value;
}

// Heuristic: a property name that's ALL_CAPS_WITH_UNDERSCORES is almost
// always a static constant (enum value or `public static final` field).
// Java method names are camelCase by convention, so the false-positive
// rate is negligible. Used by staticClass so `bukkit.Material.DIAMOND`
// resolves to the field value instead of a method dispatcher.
function isConstantName(prop) {
  return /^[A-Z][A-Z0-9_]*$/.test(prop);
}

// Static-class proxy that ALSO acts as a constructor:
//   * `Cls.FIELD`                  -> static field (ALL_CAPS heuristic)
//   * `Cls.foo(...)`               -> static method foo (camelCase)
//   * `new Cls(...)` or `Cls(...)` -> reflective constructor
//
// The proxy target is a function (required for `new` to work). Static
// dispatch goes through the get trap; the function/construct traps route
// to __rune_construct.
function staticClass(className) {
  const target = function (...args) {
    // Calling without `new` -- still construct. Mirrors how
    // `Number(x)` / `String(x)` etc. behave for JS built-ins.
    return reviveRefs(__rune_construct(className, args));
  };
  target.__static = className;
  return new Proxy(target, {
    construct(_t, args) {
      return reviveRefs(__rune_construct(className, args));
    },
    get(t, prop) {
      if (prop === '__static') return className;
      if (typeof prop !== 'string') return t[prop];
      // Symbol / inherited Function props (Symbol.toPrimitive, name, length,
      // apply, call, bind, ...) should pass through so the proxy still
      // behaves like a function for libraries that introspect it.
      if (prop in t) return t[prop];
      if (isConstantName(prop)) {
        return reviveRefs(__rune_get_static_field(className, prop));
      }
      return function (...args) {
        return reviveRefs(__rune_invoke_static(className, prop, args));
      };
    },
  });
}

// Java package-navigation proxy. `bukkit.inventory.ItemStack` walks
// `org.bukkit.inventory.ItemStack`; the leaf class is constructable, has
// static methods, and resolves ALL_CAPS as fields (via staticClass).
//
// Convention: identifiers starting with an uppercase letter are CLASSES,
// lowercase are SUB-PACKAGES. Matches every reasonable Java codebase.
// (Exceptions like `org.bukkit.NMS` would need rune.javaClass.)
function makeJavaPackage(prefix) {
  const cache = new Map();
  return new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop === '__pkg') return prefix;
      let cached = cache.get(prop);
      if (cached !== undefined) return cached;
      const fqn = prefix + '.' + prop;
      const first = prop.charCodeAt(0);
      const isClassName = first >= 65 && first <= 90; // A-Z
      const value = isClassName ? staticClass(fqn) : makeJavaPackage(fqn);
      cache.set(prop, value);
      return value;
    },
  });
}

function staticFields(className) {
  return new Proxy({}, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined;
      return reviveRefs(__rune_get_static_field(className, prop));
    },
  });
}

globalThis.rune = {
  broadcast(message) {
    __rune_broadcast(String(message));
  },
  on(event, fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('rune.on(event, fn): fn must be a function');
    }
    let list = handlers.get(event);
    if (!list) {
      list = [];
      handlers.set(event, list);
      __rune_subscribe_event(String(event));
    }
    list.push(fn);
  },

  // Reflective Bukkit surface -- identical to the deno_core backend.
  bukkit:     staticClass('org.bukkit.Bukkit'),
  material:   staticFields('org.bukkit.Material'),
  entityType: staticFields('org.bukkit.entity.EntityType'),
  particle:   staticFields('org.bukkit.Particle'),
  sound:      staticFields('org.bukkit.Sound'),

  callStatic(className, method, ...args) {
    return reviveRefs(__rune_invoke_static(className, method, args));
  },
  getStatic(className, field) {
    return reviveRefs(__rune_get_static_field(className, field));
  },
  /**
   * Construct a Java instance reflectively.
   *   rune.new('org.bukkit.inventory.ItemStack', material, 64)
   *   rune.new('org.bukkit.Location', world, x, y, z)
   * Equivalent to `new rune.javaClass(name)(...args)`.
   */
  new(className, ...args) {
    return reviveRefs(__rune_construct(className, args));
  },
  javaClass(className) { return staticClass(className); },
  javaEnum(className) { return staticFields(className); },
};

// ---------------------------------------------------------------------------
// Scheduling helpers. Our Node uv loop ticks on the Paper main thread
// (per-tick `rune_node_tick(5ms)` from CommandExecutor), so plain JS
// setTimeout/setInterval already fire on the main thread -- safe for
// Bukkit calls. These wrappers just give a tick-based API since that's
// the unit Minecraft scripters think in.
// ---------------------------------------------------------------------------

globalThis.rune.schedule = {
  afterTicks(fn, ticks)  { return setTimeout(fn, Math.max(0, ticks) * 50); },
  everyTicks(fn, ticks)  { return setInterval(fn, Math.max(1, ticks) * 50); },
  afterMs(fn, ms)        { return setTimeout(fn, ms); },
  everyMs(fn, ms)        { return setInterval(fn, ms); },
  cancel(handle)         { clearTimeout(handle); clearInterval(handle); },
  /** Run `fn` on the next server tick. */
  nextTick(fn)           { return setTimeout(fn, 0); },
};

// ---------------------------------------------------------------------------
// Constructor helpers for the most common `new X(...)` patterns. Saves
// boilerplate and (for itemstack) bundles the meta-mutate-rebind dance.
// ---------------------------------------------------------------------------

/**
 * Build an ItemStack, optionally mutating its meta via a callback.
 *
 *   rune.itemstack(bukkit.Material.DIAMOND_SWORD, 1, (meta) => {
 *     meta.displayName(Component.text("Legendary").color(NamedColor.GOLD));
 *     meta.lore([Component.text("+10 damage")]);
 *   });
 */
globalThis.rune.itemstack = function (material, count, metaFn) {
  const item = (count == null)
    ? new bukkit.inventory.ItemStack(material)
    : new bukkit.inventory.ItemStack(material, count);
  if (typeof metaFn === 'function') {
    const meta = item.getItemMeta();
    metaFn(meta);
    item.setItemMeta(meta);
  }
  return item;
};

/**
 * Build a NamespacedKey. `"foo"` => `rune:foo`; `"plugin:foo"` =>
 * `plugin:foo`. Saves the verbose two-arg constructor for the common
 * case where the namespace is just your script's identity.
 */
globalThis.rune.key = function (key) {
  const s = String(key);
  const colon = s.indexOf(':');
  if (colon >= 0) {
    return new bukkit.NamespacedKey(s.substring(0, colon), s.substring(colon + 1));
  }
  return new bukkit.NamespacedKey('rune', s);
};

/** Shorthand for `new bukkit.Location(world, x, y, z, yaw?, pitch?)`. */
globalThis.rune.location = function (world, x, y, z, yaw, pitch) {
  if (yaw == null && pitch == null) {
    return new bukkit.Location(world, x, y, z);
  }
  return new bukkit.Location(world, x, y, z, yaw ?? 0, pitch ?? 0);
};

// ---------------------------------------------------------------------------
// @EventHandler / @Listener decorators. Sugar over `rune.on(...)`.
//
//   @Listener
//   export class MyHandlers {
//     @EventHandler("PlayerJoinEvent")
//     onJoin(e) { e.player.sendMessage("hi"); }
//
//     @EventHandler("BlockBreakEvent")
//     onBreak(e) { console.log(e.player.name + " broke " + e.block.material); }
//   }
// ---------------------------------------------------------------------------

const _EVENT_HANDLERS = Symbol('rune:eventHandlers'); // instance -> [{event, propName}]

globalThis.EventHandler = function EventHandler(eventName) {
  if (typeof eventName !== 'string') {
    throw new TypeError('@EventHandler("EventName"): event name (a string) is required');
  }
  return function (_method, context) {
    if (!context || context.kind !== 'method') {
      throw new Error('@EventHandler must decorate a method');
    }
    context.addInitializer(function () {
      const list = this[_EVENT_HANDLERS] ?? (this[_EVENT_HANDLERS] = []);
      list.push({ event: eventName, propName: String(context.name) });
    });
  };
};

globalThis.Listener = function Listener(target, _context) {
  // Probe once to populate _EVENT_HANDLERS via addInitializer. Then
  // construct ONCE more as the live singleton whose methods we bind --
  // this matches @Command's pattern where decorator metadata is gathered
  // on a throwaway, then a fresh instance owns the handlers.
  let probe;
  try { probe = new target(); }
  catch (e) {
    __rune_log_error('@Listener: class needs a no-arg constructor: ' + (e && e.message || e));
    return target;
  }
  const handlers = probe[_EVENT_HANDLERS] || [];
  if (handlers.length === 0) {
    __rune_log_error('@Listener: class has no @EventHandler methods');
    return target;
  }
  const live = new target();
  for (const { event, propName } of handlers) {
    rune.on(event, (e) => live[propName](e));
  }
  return target;
};

// ---------------------------------------------------------------------------
// Persistent state. `rune.store(name)` returns a Map-like API backed by
// `plugins/Rune/store/<name>.json`. Survives /rune reload AND server
// restarts. Auto-saves on every set/delete.
// ---------------------------------------------------------------------------

(function _runeInstallStore() {
  const fs = require('node:fs');
  const path = require('node:path');
  // scriptsDir = sibling of runtime/. The bootstrap substitutes runtime,
  // so derive scripts from it and place the store one level above scripts
  // (in the plugin's dataFolder). Keeps user files in scripts/ clean.
  const runtimeDir = '__RUNE_RUNTIME_DIR__';
  const storeDir = path.join(path.dirname(runtimeDir), 'store');

  function load(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e && e.code !== 'ENOENT') throw e; return {}; }
  }
  function save(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  const _stores = new Map(); // name -> { data, file }

  globalThis.rune.store = function (name) {
    const key = String(name);
    if (!_stores.has(key)) {
      const file = path.join(storeDir, key + '.json');
      _stores.set(key, { data: load(file), file });
    }
    const slot = _stores.get(key);
    return {
      get(k)        { return slot.data[k]; },
      set(k, v)     { slot.data[k] = v; save(slot.file, slot.data); return v; },
      has(k)        { return Object.prototype.hasOwnProperty.call(slot.data, k); },
      delete(k)     { delete slot.data[k]; save(slot.file, slot.data); },
      clear()       { slot.data = {}; save(slot.file, slot.data); },
      keys()        { return Object.keys(slot.data); },
      values()      { return Object.values(slot.data); },
      entries()     { return Object.entries(slot.data); },
      all()         { return JSON.parse(JSON.stringify(slot.data)); },
      get size()    { return Object.keys(slot.data).length; },
    };
  };
})();

// ---------------------------------------------------------------------------
// Command surface: `rune.command(...)` imperative builder + `@Command` /
// `@Arg` / `@Run` decorators. Both push through `__rune_register_command`
// and store the handler under the command name in `commandHandlers`.
//
// When Paper invokes the command, the Kotlin Brigadier executor dispatches
// an event named `__rune_command:<name>` whose payload is `{ sender, args,
// label }`. The bootstrap subscribes a single fan-out handler that looks
// up the per-command function by name and invokes it with a ctx object.
// ---------------------------------------------------------------------------

const commandHandlers = new Map();

function _runeRegister(spec, handler) {
  if (!spec.name || typeof spec.name !== 'string') {
    throw new Error('command spec missing `name`');
  }
  if (typeof handler !== 'function') {
    throw new Error(`command "${spec.name}" missing handler (use .executes / @Run)`);
  }
  commandHandlers.set(spec.name, handler);
  // Ensure the dispatch fan-out is wired before the host gets a chance to
  // fire the event.
  const eventName = '__rune_command:' + spec.name;
  if (!handlers.has(eventName)) {
    handlers.set(eventName, [_runeDispatchCommand.bind(null, spec.name)]);
    __rune_subscribe_event(eventName);
  }
  __rune_register_command({
    name: spec.name,
    description: spec.description || '',
    permission: spec.permission ?? null,
    aliases: spec.aliases || [],
    args: (spec.args || []).map((a) => ({
      name: String(a.name),
      description: String(a.description || ''),
      type: String(a.type || 'string'),
      min: a.min ?? null,
      max: a.max ?? null,
      greedy: !!a.greedy,
      optional: !!a.optional,
      // Snapshot suggest at registration time. `suggest` accepts
      // a string[] OR a function returning one. Dynamic-per-keystroke
      // suggesters need a sync Kotlin->JS callback (follow-up).
      suggestions: _resolveSuggest(a.suggest),
    })),
  });
}

function _resolveSuggest(suggest) {
  if (suggest == null) return [];
  if (Array.isArray(suggest)) return suggest.map(String);
  if (typeof suggest === 'function') {
    try {
      const out = suggest();
      if (Array.isArray(out)) return out.map(String);
    } catch (e) {
      __rune_log_error('@Arg suggest() threw: ' + (e && e.stack || e));
    }
  }
  return [];
}

async function _runeDispatchCommand(name, payload) {
  const handler = commandHandlers.get(name);
  if (!handler) return;
  try {
    const result = handler(payload);
    if (result && typeof result.then === 'function') {
      await result;
    }
  } catch (e) {
    _runeReportCommandError(name, payload, e);
  }
}

// Log the failure to the server log AND -- if a player ran the command --
// send them a red, clickable message that copies the full error text on
// click (Adventure clickEvent(copyToClipboard)). Console senders just see
// the raw text since they can scroll/copy anyway.
function _runeReportCommandError(name, payload, e) {
  const text = (e && e.stack) || String(e);
  __rune_log_error(`command "${name}" threw: ` + text);
  try {
    const sender = payload && payload.sender;
    if (!sender || !sender.isPlayer) return;
    const Component = kyori.adventure.text.Component;
    const ClickEvent = kyori.adventure.text.event.ClickEvent;
    const NamedTextColor = kyori.adventure.text.format.NamedTextColor;
    const msg = Component.text(`[Rune] error in /${name} (click to copy)`)
      .color(NamedTextColor.RED)
      .clickEvent(ClickEvent.copyToClipboard(text));
    sender.sendMessage(msg);
  } catch (inner) {
    // Don't let the error-reporter throw -- we're already in an error
    // path. Log and move on.
    __rune_log_error(`failed to send clickable error to player: ` + (inner && inner.stack || inner));
  }
}

class CommandBuilder {
  constructor(name) {
    this._spec = { name, args: [] };
    this._handler = null;
  }
  description(s) { this._spec.description = String(s); return this; }
  permission(s)  { this._spec.permission  = String(s); return this; }
  aliases(...names) { this._spec.aliases = names.map(String); return this; }
  arg(name, type, opts) {
    this._spec.args.push({
      name: String(name),
      type: String(type),
      description: opts?.description ?? '',
      min: opts?.min, max: opts?.max,
      greedy: !!opts?.greedy, optional: !!opts?.optional,
    });
    return this;
  }
  executes(fn) { this._handler = fn; return this; }
  register() { _runeRegister(this._spec, this._handler); return this; }
}

// `rune.command(name)` returns a builder; `rune.command(spec)` takes a full
// object spec INCLUDING a `run` function and registers immediately. Pick
// whichever shape fits the script.
globalThis.rune.command = function (nameOrSpec) {
  if (typeof nameOrSpec === 'string') {
    return new CommandBuilder(nameOrSpec);
  }
  if (nameOrSpec && typeof nameOrSpec === 'object') {
    const { run, ...spec } = nameOrSpec;
    _runeRegister(spec, run);
    return spec.name;
  }
  throw new TypeError('rune.command(arg): expected string or spec object');
};

// ----- Stage 3 decorators (TC39 / TS 5+) ----------------------------------
// esbuild (via the ts-loader hook) transforms `@Command(...)`-style syntax
// into the runtime calls these implement. Decorator order in TS 5+:
//   1. Field decorators (@Arg) -- run BEFORE the class is finalised
//   2. Method decorators (@Run) -- same
//   3. Class decorator (@Command) -- runs LAST, sees a finalised class
//
// We collect arg/run metadata on the class via a hidden field initialised
// by @Arg's addInitializer (which runs at instance construction). The class
// decorator probes the class with a no-arg `new` to populate the metadata,
// then registers the command + a per-call factory that hydrates fields.

const _ARG_META = Symbol('rune:argMeta');   // instance -> [{ propName, name, ... }]
const _RUN_META = Symbol('rune:runMeta');   // instance -> propName

globalThis.Arg = function Arg(name, descriptionOrOpts, maybeOpts) {
  const description = typeof descriptionOrOpts === 'string' ? descriptionOrOpts : '';
  const opts = (typeof descriptionOrOpts === 'object' && descriptionOrOpts !== null)
    ? descriptionOrOpts
    : (maybeOpts || {});
  return function (_value, context) {
    if (!context || context.kind !== 'field') {
      throw new Error('@Arg must decorate a class field');
    }
    context.addInitializer(function () {
      const list = this[_ARG_META] ?? (this[_ARG_META] = []);
      list.push({
        propName: String(context.name),
        name,
        description,
        type: opts.type || 'string',
        min: opts.min, max: opts.max,
        greedy: !!opts.greedy, optional: !!opts.optional,
      });
    });
  };
};

globalThis.Run = function Run(method, context) {
  if (!context || context.kind !== 'method') {
    throw new Error('@Run must decorate a method');
  }
  context.addInitializer(function () {
    this[_RUN_META] = String(context.name);
  });
  return method;
};

globalThis.Command = function Command(name, opts) {
  return function (target, _context) {
    // Probe the class to trigger @Arg / @Run initializers, then
    // discard the instance.
    let probe;
    try {
      probe = new target();
    } catch (e) {
      __rune_log_error(
        `@Command ${name}: class needs a no-arg constructor (got: ` +
          (e && e.message || e) + ')',
      );
      return target;
    }
    const argList = probe[_ARG_META] || [];
    const runProp = probe[_RUN_META];
    if (!runProp) {
      throw new Error(`@Command ${name}: missing @Run method on the class`);
    }

    _runeRegister(
      {
        name,
        description: opts?.description,
        permission: opts?.permission,
        aliases: opts?.aliases,
        args: argList,
      },
      function (ctx) {
        // Fresh instance per invocation so handler state stays isolated.
        const inst = new target();
        for (const m of argList) {
          inst[m.propName] = ctx.args[m.name];
        }
        return inst[runProp](ctx);
      },
    );
    return target;
  };
};

// Top-level package proxies. Anything reachable on the Paper classpath is
// reachable from JS without explicit setup. Examples:
//
//   new bukkit.inventory.ItemStack(rune.material.DIAMOND)
//   new java.util.HashMap()
//   const Material = bukkit.Material;           // static class
//   const stone = bukkit.Material.STONE;        // static field (ALL_CAPS)
//   bukkit.Bukkit.broadcast(component, null);   // static method
//
// `bukkit` is a shortcut for `org.bukkit.*`; the full FQN paths under
// `org` / `java` / `net` / `io` / `com` work too. Anything else, fall
// back to `rune.javaClass('full.class.Name')`.
// `Events.<EventName>` -> the literal string "<EventName>" at runtime,
// but typed at compile-time as `EventKey<TheEventInterface>` via the
// auto-generated events.d.ts. Lets `rune.on(Events.AsyncChatEvent, ...)`
// and `@EventHandler(Events.AsyncChatEvent)` carry the event type through
// without users typing event names as raw strings.
globalThis.Events = new Proxy(Object.create(null), {
  get(_target, prop) {
    return typeof prop === 'string' ? prop : undefined;
  },
});

globalThis.bukkit  = makeJavaPackage('org.bukkit');
globalThis.paper   = makeJavaPackage('io.papermc.paper');
globalThis.kyori   = makeJavaPackage('net.kyori');
globalThis.org     = makeJavaPackage('org');
globalThis.java    = makeJavaPackage('java');
globalThis.javax   = makeJavaPackage('javax');
globalThis.net     = makeJavaPackage('net');
globalThis.io      = makeJavaPackage('io');
globalThis.com     = makeJavaPackage('com');
globalThis.me      = makeJavaPackage('me');
globalThis.dev     = makeJavaPackage('dev');
globalThis.xyz     = makeJavaPackage('xyz');

// ---- User-configured aliases --------------------------------------------
// rune.jsonc's `aliases` (+ plugin `alias` shortcuts) get materialised to
// runtime/aliases.json by the Kotlin plugin. Each entry is `name ->
// dotted.path` -- we resolve the dotted path against globalThis and bind
// the leaf as a top-level global. Done AFTER the package roots above so
// `inventory -> bukkit.inventory`-style aliases resolve correctly.
(function _runeInstallAliases() {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join('__RUNE_RUNTIME_DIR__', 'aliases.json');
  let data;
  try {
    data = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return;  // no aliases configured
    __rune_log_error('aliases: read failed: ' + (e && e.message || e));
    return;
  }
  let map;
  try {
    map = JSON.parse(data);
  } catch (e) {
    __rune_log_error('aliases: JSON parse failed: ' + (e && e.message || e));
    return;
  }
  for (const [name, target] of Object.entries(map)) {
    const parts = String(target).split('.');
    let value = globalThis;
    for (const p of parts) {
      if (value == null) break;
      value = value[p];
    }
    if (value === undefined) {
      __rune_log_error(`aliases: '${name}' -> '${target}' did not resolve`);
      continue;
    }
    globalThis[name] = value;
  }
})();

// Rewire console to flow through the host logger. Keep the same shape as
// the deno_core backend's setup.js so user code is portable across both.
globalThis.console = {
  log:   (...args) => __rune_log_info(_fmt(args)),
  info:  (...args) => __rune_log_info(_fmt(args)),
  warn:  (...args) => __rune_log_warn(_fmt(args)),
  error: (...args) => __rune_log_error(_fmt(args)),
  debug: (...args) => __rune_log_debug(_fmt(args)),
  trace: (...args) => __rune_log_debug(_fmt(args)),
  dir:   (a) => __rune_log_info(_fmt([a])),
  group: () => {},
  groupCollapsed: () => {},
  groupEnd: () => {},
  table: (a) => __rune_log_info(_fmt([a])),
  assert: (cond, ...args) => { if (!cond) __rune_log_error('Assertion failed: ' + _fmt(args)); },
  time: () => {},
  timeEnd: () => {},
  count: () => {},
  countReset: () => {},
  clear: () => {},
};

// Catch libraries that write directly to process.std{out,err}. process is
// a Node built-in so it already exists; we just override .write.
try {
  if (globalThis.process && globalThis.process.stdout) {
    globalThis.process.stdout.write = (s) => { __rune_log_info(String(s).replace(/\n$/, '')); return true; };
  }
  if (globalThis.process && globalThis.process.stderr) {
    globalThis.process.stderr.write = (s) => { __rune_log_error(String(s).replace(/\n$/, '')); return true; };
  }
} catch (_) {}

// Invoked from C++ on every Bukkit event the host has been told we want.
// `payload` is a Uint8Array of CBOR bytes encoded by the Kotlin event
// forwarder. We decode it via the structured-clone-style cbor module if
// present; otherwise hand the raw bytes through. Phase 4e will pre-decode
// on the C++ side so handlers always get a plain JS object.
globalThis.__runeDispatch = function (name, payload) {
  const list = handlers.get(name);
  if (!list) return;
  let revived = payload;
  if (payload instanceof Uint8Array && typeof globalThis.__rune_decode_event === 'function') {
    try { revived = reviveRefs(globalThis.__rune_decode_event(payload)); }
    catch (_) { revived = payload; }
  } else if (payload && typeof payload === 'object') {
    revived = reviveRefs(payload);
  }
  for (const fn of list) {
    try {
      const result = fn(revived);
      // Async handlers: don't await (the host expects dispatch_event to
      // be effectively sync), but DO attach a .catch so a rejected
      // promise doesn't escape as an unhandledRejection and potentially
      // tear down the runtime.
      if (result && typeof result.then === 'function') {
        result.catch((e) => __rune_log_error(
          `async handler for "${name}" threw: ` + (e && e.stack || e),
        ));
      }
    } catch (e) {
      __rune_log_error(`handler for "${name}" threw: ` + (e && e.stack || e));
    }
  }
};

// Last-resort safety net. Anything that escapes our per-handler try/catch
// (unhandled promise rejection in user code that isn't an event/command
// handler -- e.g. a `setTimeout(async () => ...)` whose async function
// rejects) lands here. Node's default behaviour for unhandled rejections
// in modern versions is to crash the process; logging at SEVERE keeps the
// server alive instead.
process.on('unhandledRejection', (reason) => {
  __rune_log_error('unhandled rejection: ' + (reason && reason.stack || reason));
});
process.on('uncaughtException', (err) => {
  __rune_log_error('uncaught exception: ' + (err && err.stack || err));
});

// `__rune_load_script(path)` is the C++ shim's entry into Node's real
// module loader. Goes through dynamic `import()` so .js / .mjs / .cjs / .ts
// (Node 22.7+ strip-types is on by default) all work AND both `import`
// statements and `require()` (CJS interop) are supported in user code.
//
// We resolve via file:// URL so absolute paths with backslashes and
// drive letters survive Node's URL parser. Returns a promise the C++
// side awaits by pumping uv until it settles.
const { pathToFileURL } = require('node:url');
globalThis.__rune_load_script = async function (path) {
  const url = pathToFileURL(path).href;
  // Cache-bust on reload so the same path re-imports fresh. Node's
  // ESM loader keys the cache on the full URL including query string.
  return import(url + '?t=' + Date.now());
};

__rune_log_info('rune-node runtime initialised');
"#;
// ^ End of BOOTSTRAP_JS_TEMPLATE. Caller calls build_bootstrap_js() to
//   substitute __RUNE_RUNTIME_DIR__ before passing to LoadEnvironment.

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

pub struct NodeBackend {
    handle: *mut ffi::RuneNode,
    /// Directory containing extracted runtime assets (esbuild + ts-loader).
    /// Cached so reload() can re-bootstrap with the same path embedded.
    runtime_dir: PathBuf,
    /// Script paths that have been successfully loaded since the last
    /// reload. Replayed in-order when `reload()` rebuilds the environment.
    loaded_scripts: Vec<PathBuf>,
    /// The query callback the loader handed us via `set_query_callback`.
    /// Cached so we can re-register it on the freshly-spawned shim after
    /// a reload -- the C++ side stores it on the RuneNode struct which
    /// gets freed and rebuilt.
    query_cb: Option<QueryCallback>,
}

unsafe impl Send for NodeBackend {}

impl NodeBackend {
    pub fn new(runtime_dir: PathBuf) -> Result<Self, RuntimeError> {
        ensure_platform()?;
        let handle = spawn_and_bootstrap(&runtime_dir)?;
        Ok(NodeBackend {
            handle,
            runtime_dir,
            loaded_scripts: Vec::new(),
            query_cb: None,
        })
    }
}

/// Allocate a fresh `RuneNode` and run the bootstrap JS against it. The
/// returned pointer is owned by the caller -- `rune_node_free` releases it.
fn spawn_and_bootstrap(runtime_dir: &Path) -> Result<*mut ffi::RuneNode, RuntimeError> {
    let handle = unsafe { ffi::rune_node_new() };
    if handle.is_null() {
        return Err(RuntimeError::Other("rune_node_new returned null".into()));
    }
    let bootstrap = build_bootstrap_js(runtime_dir);
    let setup = CString::new(bootstrap)
        .map_err(|e| RuntimeError::Other(e.to_string()))?;
    let rc = unsafe { ffi::rune_node_bootstrap(handle, setup.as_ptr()) };
    if rc != ffi::RUNE_NODE_OK {
        unsafe { ffi::rune_node_free(handle) };
        return Err(RuntimeError::Other(format!(
            "rune_node_bootstrap returned {rc}"
        )));
    }
    Ok(handle)
}

impl Drop for NodeBackend {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe { ffi::rune_node_free(self.handle) };
            self.handle = std::ptr::null_mut();
        }
    }
}

impl LanguageRuntime for NodeBackend {
    fn name(&self) -> &'static str {
        "node"
    }

    fn extensions(&self) -> &[&'static str] {
        // Node accepts these natively; .ts requires --experimental-strip-types
        // (default-on in Node 23+ but opt-in pre-23).
        &["js", "mjs", "cjs", "ts"]
    }

    fn load_script(&mut self, path: &Path) -> Result<(), RuntimeError> {
        // Idempotent against the CURRENT env. If we've already imported
        // this path since the last env rebuild, skip the FFI call. This
        // handles the post-reload race where:
        //   1. NodeBackend::reload() replays every script in
        //      `loaded_scripts` into the freshly-spawned env.
        //   2. RunePlugin.handleReload then re-walks the scripts dir to
        //      pick up newly-added files, calling load_script for each
        //      file found (including the already-replayed ones).
        // Without this guard, step (2) re-imports every previously-loaded
        // script and side effects (command registrations, recipe inserts,
        // mongoose.connect, ...) fire twice.
        //
        // reload() clears `loaded_scripts` before its replay loop, so the
        // first-load-after-reload path still goes through.
        if self.loaded_scripts.iter().any(|p| p == path) {
            return Ok(());
        }
        // Node's module loader reads the file itself (so it can apply
        // strip-types for .ts and pick CJS/ESM by extension + package.json).
        // We just hand it the absolute path via the bootstrap-installed
        // __rune_load_script helper -- see shim/rune_node.cc.
        let path_c = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|e| RuntimeError::Load(e.to_string()))?;
        let rc = unsafe {
            ffi::rune_node_load_script(self.handle, path_c.as_ptr(), std::ptr::null())
        };
        if rc != ffi::RUNE_NODE_OK {
            return Err(RuntimeError::Load(format!(
                "rune_node_load_script returned {rc}"
            )));
        }
        self.loaded_scripts.push(path.to_path_buf());
        Ok(())
    }

    fn dispatch_event(&mut self, name: &str, payload: &[u8]) -> Result<(), RuntimeError> {
        let name_c =
            CString::new(name).map_err(|e| RuntimeError::Dispatch(e.to_string()))?;
        let (ptr, len) = if payload.is_empty() {
            (std::ptr::null::<u8>(), 0)
        } else {
            (payload.as_ptr(), payload.len())
        };
        let rc = unsafe {
            ffi::rune_node_dispatch_event(self.handle, name_c.as_ptr(), ptr, len)
        };
        if rc != ffi::RUNE_NODE_OK {
            return Err(RuntimeError::Dispatch(format!(
                "rune_node_dispatch_event returned {rc}"
            )));
        }
        Ok(())
    }

    fn reload(&mut self) -> Result<(), RuntimeError> {
        // Snapshot the script list before we free the env -- the freed
        // env's RuneNode owns no Rust state, so loaded_scripts on `self`
        // survives the rebuild, but we take() it so the replay path adds
        // entries fresh (avoiding double-push on the next load_script).
        let scripts = std::mem::take(&mut self.loaded_scripts);

        // Tear down the current env. This force-closes uv handles + drops
        // the isolate; see rune_node_free in the C++ shim. The Drop impl
        // would do the same, but we want to control ordering so the new
        // handle is in place before any subsequent load_script call.
        unsafe { ffi::rune_node_free(self.handle) };
        self.handle = std::ptr::null_mut();

        // Spin up a fresh env + run the bootstrap against it. Bootstrap
        // is built with the same runtime_dir as the original construction
        // so the ts-loader hook re-registers correctly.
        self.handle = spawn_and_bootstrap(&self.runtime_dir)?;

        // The C++ shim stored the query callback on the OLD RuneNode.
        // The new one starts with query_cb = nullptr -- restore it so
        // `rune.bukkit.*` and friends work immediately after reload.
        if let Some(cb) = self.query_cb {
            unsafe { ffi::rune_node_set_query_callback(self.handle, cb) };
        }

        // Replay every previously-loaded script. load_script re-adds them
        // to self.loaded_scripts, so subsequent reloads stay in sync.
        let mut first_err: Option<RuntimeError> = None;
        for path in &scripts {
            if let Err(e) = self.load_script(path) {
                log::error!("reload: re-loading {} failed: {}", path.display(), e);
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
        }
        match first_err {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    fn drain_commands(&mut self) -> Vec<HostCommand> {
        // The shim returns -1 when the assembled CBOR array doesn't fit in
        // `cap`; in that case it parks the payload internally and returns
        // it verbatim on the next call. Double the buffer and retry so a
        // single tick can drain everything queued since the last tick.
        let mut cap = 8192usize;
        loop {
            let mut buf = vec![0u8; cap];
            let n = unsafe {
                ffi::rune_node_drain_commands(self.handle, buf.as_mut_ptr(), buf.len())
            };
            if n == 0 {
                return Vec::new();
            }
            if n < 0 {
                // -1 == buffer too small; -2 == bad arg (shouldn't happen).
                if n == -1 && cap < 64 * 1024 * 1024 {
                    cap *= 2;
                    continue;
                }
                return Vec::new();
            }
            return ciborium::from_reader(&buf[..n as usize]).unwrap_or_default();
        }
    }

    fn tick(&mut self) {
        // 5ms budget mirrors the deno_core backend's tick.
        let _ = unsafe { ffi::rune_node_tick(self.handle, 5) };
    }

    fn set_query_callback(&mut self, cb: QueryCallback) {
        self.query_cb = Some(cb);
        unsafe { ffi::rune_node_set_query_callback(self.handle, cb) };
    }
}

// Workaround for the unused-import warning on c_char before phase 2 wires
// ops that take strings.
const _: *const c_char = std::ptr::null();
