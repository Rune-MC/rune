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
        pub fn rune_node_invoke_js_proxy(
            rn: *mut RuneNode,
            proxy_id: u64,
            method_name: *const c_char,
            args: *const u8,
            args_len: usize,
            out: *mut u8,
            cap: usize,
        ) -> isize;
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

// eventName -> Array<{ fn, priority, ignoreCancelled }>. Command dispatch
// (the `__rune_command:...` synthetic events emitted by ScriptCommandRegistry)
// uses the same map; entries there have priority='NORMAL' and the priority
// suffix in __runeDispatch is empty, so the same loop matches.
const handlers = new Map();

// Set of `${eventName}#${priority}` keys we've already told the host about.
// Prevents the second handler at the same tuple from triggering another
// Bukkit registration on the JVM side.
const _runeSubscribedTuples = new Set();

// Bukkit's six EventPriority values + their JVM-side ordering. We accept
// any casing on the JS side and normalize to upper. Anything else is a
// user error and we throw — better than silently mapping to NORMAL.
const _RUNE_PRIORITIES = new Set([
  'LOWEST', 'LOW', 'NORMAL', 'HIGH', 'HIGHEST', 'MONITOR',
]);
function _runeNormalizePriority(p) {
  if (p == null) return 'NORMAL';
  const s = String(p).toUpperCase();
  if (!_RUNE_PRIORITIES.has(s)) {
    throw new TypeError(
      `priority "${p}" must be one of: ${[..._RUNE_PRIORITIES].join(', ')}`
    );
  }
  return s;
}

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

// Legacy String setters that have a modern Component-typed sibling.
// When the caller passes a Component to the legacy method, we transparently
// reroute to the Component variant. IDEs commonly auto-suggest the legacy
// `setX(String)` because it's the older signature; rerouting saves users
// from "no matching X(1 arg(s))" errors when they wrap their text in
// rune.mm(...) or otherwise hand over a Component.
const _LEGACY_TO_COMPONENT_METHOD = {
  setDisplayName: 'displayName',   // ItemMeta, Player
  setCustomName: 'customName',     // Entity, Nameable
  setPlayerListName: 'playerListName', // Player
  setTitle: 'title',               // BossBar, Inventory titles, Book
  setSubtitle: 'subtitle',
  setAuthor: 'author',             // Book
};

function _looksLikeComponent(v) {
  return v != null && typeof v === 'object' && v.__class === 'Component';
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
        // Auto-route legacy String setters to Component setters when the
        // caller hands over a Component. setDisplayName("text") still
        // calls setDisplayName(String); setDisplayName(rune.mm("<gold>x"))
        // reroutes to displayName(Component).
        const componentMethod = _LEGACY_TO_COMPONENT_METHOD[prop];
        if (componentMethod && args.length === 1 && _looksLikeComponent(args[0])) {
          return reviveRefs(__rune_invoke(refId, componentMethod, args));
        }
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
  // {__static: "<FQN>"}: a returned Java `Class<?>` value. Wrap as the
  // same JavaClass proxy `rune.javaClass(...)` and the package proxies
  // produce, so chains like `reg.getService().getName()` (which now
  // returns a usable proxy instead of a `toString()` string) hit
  // statics on the class. Also closes the JS->Java round trip --
  // passing this back as an arg to a Java method that expects
  // Class<?> re-encodes as the same `{__static}` envelope, which
  // ArgCoercer unwraps server-side.
  if (typeof value.__static === 'string' && value.__class === 'Class') {
    return staticClass(value.__static);
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
  on(event, fn, opts) {
    if (typeof fn !== 'function') {
      throw new TypeError('rune.on(event, fn, opts?): fn must be a function');
    }
    if (opts != null && typeof opts !== 'object') {
      throw new TypeError('rune.on(event, fn, opts): opts must be an object');
    }
    const priority = _runeNormalizePriority(opts && opts.priority);
    const ignoreCancelled = Boolean(opts && opts.ignoreCancelled);
    // Subscribe once per (event, priority) tuple — multiple JS handlers at
    // the same priority share one Bukkit registration. Without the
    // priority suffix in the subscribe call, the host couldn't know to
    // register the listener at the requested phase.
    let list = handlers.get(event);
    if (!list) {
      list = [];
      handlers.set(event, list);
    }
    const seenKey = `${event}#${priority}`;
    if (!_runeSubscribedTuples.has(seenKey)) {
      _runeSubscribedTuples.add(seenKey);
      // 2nd arg is optional; the host treats missing as "NORMAL". Older
      // host builds that ignore the extra arg degrade to NORMAL too.
      __rune_subscribe_event(String(event), priority);
    }
    list.push({ fn, priority, ignoreCancelled });
  },

  // Reflective Bukkit surface -- identical to the deno_core backend.
  bukkit:     staticClass('org.bukkit.Bukkit'),
  material:   staticFields('org.bukkit.Material'),
  entityType: staticFields('org.bukkit.entity.EntityType'),
  particle:   staticFields('org.bukkit.Particle'),
  sound:      staticFields('org.bukkit.Sound'),
  // PersistentDataType singletons -- use as `rune.pdt.STRING`,
  // `rune.pdt.INTEGER` etc. when calling
  // `meta.getPersistentDataContainer().set(key, type, value)`.
  pdt:        staticFields('org.bukkit.persistence.PersistentDataType'),

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

  /**
   * Implement (subclass) a Java abstract class or interface from JS.
   *
   *   const expansion = rune.implement(
   *     'me.clip.placeholderapi.expansion.PlaceholderExpansion',
   *     {
   *       getIdentifier:  () => 'rune',
   *       getAuthor:      () => 'rune-perms',
   *       getVersion:     () => '1.0',
   *       onRequest: (player, params) => {
   *         if (params === 'prefix') return getPrefixFor(player);
   *         return null;
   *       },
   *     },
   *   );
   *   papi.PlaceholderAPI.registerExpansion(expansion);
   *
   * Returns a Bukkit ref to the live proxy instance, which can be
   * passed into any Java API that expects the parent class/interface.
   *
   * Each method named in `methods` is called synchronously by Java
   * with `this` bound to the proxy ref and arguments wrapped the same
   * way as event payloads (so `player.getName()` works directly).
   * Abstract methods you do NOT supply will throw an
   * UnsupportedOperationException at call-time -- log and skip on
   * the JS side.
   */
  implement(className, methods) {
    if (typeof className !== 'string') {
      throw new TypeError('rune.implement(className, methods): className must be a string');
    }
    if (!methods || typeof methods !== 'object') {
      throw new TypeError('rune.implement(className, methods): methods must be an object');
    }
    const methodNames = [];
    const fnTable = Object.create(null);
    for (const k of Object.keys(methods)) {
      if (typeof methods[k] === 'function') {
        methodNames.push(k);
        fnTable[k] = methods[k];
      }
    }
    if (methodNames.length === 0) {
      throw new Error('rune.implement: at least one method implementation required');
    }
    const result = reviveRefs(__rune_create_proxy(className, methodNames));
    if (!result || typeof result.__runeProxyId !== 'string') {
      throw new Error(
        `rune.implement(${className}): host returned no proxy id`,
      );
    }
    // proxyId is a stringified u64 to survive JSON-ish marshalling; we
    // keep it as a string for the Map key (JS numbers can't safely hold
    // values >= 2^53, though our generator stays under that in practice).
    proxyImpls.set(result.__runeProxyId, { className, methods: fnTable });
    return result;
  },
};

// Java -> JS proxy dispatch. Called by the C++ shim's
// `rune_node_invoke_js_proxy` whenever a Java method on a Rune-generated
// proxy fires. `proxyId` arrives as a BigInt (so 64-bit IDs round-trip
// losslessly); we stringify for the Map lookup.
const proxyImpls = new Map();

// Sentinel returned to Kotlin when a proxy id isn't in the current
// isolate's table -- usually because /rune reload tore the isolate
// down but a Java plugin (e.g. PAPI) is still holding the old proxy
// instance. Kotlin recognises this and falls back to its argless-
// getter cache (so e.g. stale getIdentifier() can still return "rune"
// long enough for PAPI to find + unregister the old entry).
const STALE_SENTINEL = { __rune_stale: true };

globalThis.__rune_proxy_dispatch = function (proxyId, methodName, args) {
  const key = String(proxyId);
  const impl = proxyImpls.get(key);
  if (!impl) {
    // Stale -- DON'T log here; the noise floods on every /papi reload
    // tick. Kotlin handles + caches.
    return STALE_SENTINEL;
  }
  const fn = impl.methods[methodName];
  if (typeof fn !== 'function') {
    __rune_log_warn(
      `proxy dispatch: ${impl.className}.${methodName} not implemented`,
    );
    return null;
  }
  // Revive wrapped Bukkit refs in the argument array so handlers can
  // call methods directly (e.g. `player.getName()`).
  const revived = Array.isArray(args)
    ? args.map(reviveRefs)
    : [];
  try {
    return fn.apply(null, revived);
  } catch (e) {
    __rune_log_error(
      `proxy ${impl.className}.${methodName} threw: ` + (e && e.stack || e),
    );
    return null;
  }
};

// Wire the dispatcher into the C++ shim. Done AFTER `rune.implement` is
// in place so the FFI handle and the JS table are always installed in
// the same step. If this throws (e.g. fn isn't a function), the rest of
// the bootstrap still runs -- proxy use just fails later.
try {
  __rune_install_proxy_dispatch(__rune_proxy_dispatch);
} catch (e) {
  __rune_log_error('proxy dispatcher install failed: ' + (e && e.stack || e));
}

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
// Message helpers -- MiniMessage parse + send / title / actionBar.
//
// All accept MiniMessage syntax (`<gold>`, `<gradient:red:blue>`, etc.).
// `rune.msg` takes any Audience (player, world, command sender, server...)
// OR an array of audiences. `rune.mm` is the bare parser when you need
// the Component for chaining (e.g. `Component.text("X").append(rune.mm(...))`).
// ---------------------------------------------------------------------------

globalThis.rune.mm = function (template) {
  return mm.MiniMessage.miniMessage().deserialize(String(template ?? ''));
};

globalThis.rune.msg = function (audience, template) {
  const comp = rune.mm(template);
  if (Array.isArray(audience)) {
    for (const a of audience) a.sendMessage(comp);
  } else {
    audience.sendMessage(comp);
  }
};

/**
 * Show a title to `player`. All times are in ms; defaults match vanilla
 * (500/3000/500). `subtitle` may be omitted.
 *
 *   rune.title(player, "<red><bold>BOSS FIGHT");
 *   rune.title(player, "Welcome", "<gray>...to the server", { stayMs: 5000 });
 */
globalThis.rune.title = function (player, title, subtitle, opts) {
  const Title = kyori.adventure.title.Title;
  const Duration = java.time.Duration;
  const titleComp = rune.mm(title ?? '');
  const subComp = rune.mm(subtitle ?? '');
  const fadeIn = Duration.ofMillis(opts?.fadeInMs ?? 500);
  const stay = Duration.ofMillis(opts?.stayMs ?? 3000);
  const fadeOut = Duration.ofMillis(opts?.fadeOutMs ?? 500);
  const times = Title.Times.times(fadeIn, stay, fadeOut);
  player.showTitle(Title.title(titleComp, subComp, times));
};

globalThis.rune.actionBar = function (player, template) {
  player.sendActionBar(rune.mm(template));
};

// ---------------------------------------------------------------------------
// Item builder -- fluent extension of rune.itemstack.
//
//   const sword = rune.item(bukkit.Material.DIAMOND_SWORD)
//     .name("<gold>Excalibur")
//     .lore(["<gray>Wielded by kings", "<dark_gray>+10 damage"])
//     .enchant("sharpness", 5)
//     .unbreakable()
//     .glow()
//     .build();
//
// Enchant ids are minecraft-namespaced names (sharpness, mending,
// unbreaking, ...). Item flags ("HIDE_ENCHANTS", "HIDE_ATTRIBUTES", ...)
// hide the matching tooltip lines.
// ---------------------------------------------------------------------------

globalThis.rune.item = function (material) {
  const state = {
    count: 1,
    name: null,
    lore: null,
    enchants: [],
    unbreakable: false,
    customModelData: null,
    flags: [],
    pdc: [],
    skullOwner: null,
  };
  const builder = {
    amount(n)            { state.count = n | 0; return builder; },
    name(s)              { state.name = String(s); return builder; },
    lore(lines)          { state.lore = lines.map(String); return builder; },
    enchant(id, level)   { state.enchants.push({ id, level: level ?? 1 }); return builder; },
    unbreakable()        { state.unbreakable = true; return builder; },
    /** Cosmetic: adds a hidden enchant so the item shimmers. */
    glow() {
      state.enchants.push({ id: 'unbreaking', level: 1 });
      if (!state.flags.includes('HIDE_ENCHANTS')) state.flags.push('HIDE_ENCHANTS');
      return builder;
    },
    customModelData(n)   { state.customModelData = n | 0; return builder; },
    flag(name)           { state.flags.push(String(name)); return builder; },
    /**
     * Set a PersistentDataContainer entry.
     *
     *   .data("origin", "trial_chamber")           // STRING (auto)
     *   .data("level", 7)                          // INTEGER (auto)
     *   .data("weight", 3.5)                       // DOUBLE (auto)
     *   .data("magic", true)                       // BYTE 0/1 (auto)
     *   .data("count", 100n, rune.pdt.LONG)        // explicit type
     *   .data("config", JSON.stringify({hp: 100}))  // arbitrary structured -> STRING
     *
     * `key` is namespaced via `rune.key(...)` -- bare names land under
     * `rune:` (so `.data("foo")` -> `rune:foo`). Use `"plugin:foo"` to
     * place under another namespace.
     */
    data(key, value, type) {
      state.pdc.push({ key, value, type });
      return builder;
    },
    /**
     * Set the skull owner on a PLAYER_HEAD item. Accepts a Player /
     * OfflinePlayer ref, a UUID string, or a player name. Non-skull
     * materials silently ignore this. Texture resolution is best-effort:
     * it'll display the player's current skin if the server has it
     * cached, otherwise the default Steve head until Mojang responds.
     */
    skullOwner(target) {
      state.skullOwner = target;
      return builder;
    },
    build() {
      return rune.itemstack(material, state.count, (meta) => {
        if (state.name) meta.displayName(rune.mm(state.name));
        if (state.lore && state.lore.length) {
          // `meta.lore(List<Component>)` -- pass a JS array; the host-side
          // ArgCoercer converts it to a java.util.List. Earlier versions
          // tried `new java.util.ArrayList()`, but CBOR marshals every
          // Java Collection back as a JS array (no __ref / .add() once it
          // crosses the boundary), so the builder approach can't work.
          meta.lore(state.lore.map((line) => rune.mm(line)));
        }
        for (const { id, level } of state.enchants) {
          // Enchantment.getByKey(key) is the canonical lookup. Custom
          // (datapack) enchants land under their own namespace; default
          // to "minecraft" if the user omits one.
          const key = String(id).includes(':') ? String(id) : 'minecraft:' + id;
          const ench = rune.callStatic(
            'org.bukkit.enchantments.Enchantment',
            'getByKey',
            rune.key(key),
          );
          if (ench) meta.addEnchant(ench, level, /*ignoreLevelRestriction*/ true);
        }
        if (state.unbreakable) meta.setUnbreakable(true);
        if (state.customModelData != null) meta.setCustomModelData(state.customModelData);
        if (state.flags.length > 0) {
          // ItemMeta.addItemFlags(ItemFlag...) -- reflection sees the
          // signature as ItemFlag[]. ArgCoercer's `arg is Array &&
          // paramType.isArray` branch builds a real Java array of the
          // right component type and coerces each entry (here, an enum
          // name string) to ItemFlag, so we can just hand it a JS
          // array of strings. The earlier `Array.newInstance + Array.set`
          // path fought a self-inflicted bug: the host re-marshals every
          // Java array it returns as a JS list, so the `arr` we got back
          // wasn't a Java array anymore by the time `Array.set` saw it.
          meta.addItemFlags(state.flags.filter((f) => typeof f === 'string'));
        }
        if (state.skullOwner != null) {
          // SkullMeta extends ItemMeta -- if the material isn't a head,
          // setOwningPlayer just isn't on the meta and we skip silently.
          // Resolve every input shape (Player, OfflinePlayer, UUID, name)
          // to an OfflinePlayer so the texture path is identical.
          try {
            if (typeof meta.setOwningPlayer === 'function') {
              const target = state.skullOwner;
              let offline = null;
              if (target && typeof target === 'object'
                  && typeof target.getUniqueId === 'function') {
                // Player / OfflinePlayer ref -- if it's already an
                // OfflinePlayer use it directly, else look it up by uuid.
                offline = (typeof target.hasPlayedBefore === 'function')
                  ? target
                  : rune.bukkit.getOfflinePlayer(target.getUniqueId());
              } else if (typeof target === 'string') {
                // UUID-shaped strings -> lookup by UUID, names -> by name.
                const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
                offline = uuidLike
                  ? rune.bukkit.getOfflinePlayer(java.util.UUID.fromString(target))
                  : rune.bukkit.getOfflinePlayer(target);
              }
              if (offline) meta.setOwningPlayer(offline);
            }
          } catch (e) {
            __rune_log_warn('rune.item.skullOwner failed: ' + (e && e.message || e));
          }
        }
        if (state.pdc.length > 0) {
          const pdc = meta.getPersistentDataContainer();
          for (const { key, value, type } of state.pdc) {
            const namespacedKey = rune.key(String(key));
            const pdType = type ?? _autoPdType(value);
            if (!pdType) {
              __rune_log_warn(
                `rune.item.data(${key}): cannot auto-derive PersistentDataType for ` +
                  `value of type ${typeof value} -- pass an explicit type ` +
                  `(e.g. rune.pdt.STRING).`,
              );
              continue;
            }
            // Coerce JS-side so the Java-side method-resolver finds the
            // best overload of pdc.set(key, type, T).
            pdc.set(namespacedKey, pdType, _coerceForPdType(value, type));
          }
        }
      });
    },
  };
  return builder;
};

/**
 * Pick a sensible PersistentDataType for a bare JS value. Conservative:
 *   string  -> STRING
 *   integer -> INTEGER (use rune.pdt.LONG explicitly for >= 2^31)
 *   float   -> DOUBLE
 *   boolean -> BOOLEAN  (Paper-only; falls back to BYTE if absent)
 *   bigint  -> LONG
 * For anything else (objects, arrays), pass an explicit `type` and
 * pre-serialise.
 */
function _autoPdType(value) {
  switch (typeof value) {
    case 'string':  return rune.pdt.STRING;
    case 'bigint':  return rune.pdt.LONG;
    case 'boolean': return rune.pdt.BOOLEAN ?? rune.pdt.BYTE;
    case 'number':
      return Number.isInteger(value) ? rune.pdt.INTEGER : rune.pdt.DOUBLE;
    default:        return null;
  }
}

function _coerceForPdType(value, _type) {
  if (typeof value === 'boolean') return value;  // Paper BOOLEAN takes boolean
  return value;
}

// ---------------------------------------------------------------------------
// Entity spawn helper.
//
//   rune.spawn(player.getLocation(), "zombie", (zombie) => {
//     zombie.setCustomName("Boss");
//     zombie.setCustomNameVisible(true);
//   });
//
// `typeName` is matched case-insensitively against EntityType constants.
// Returns the spawned Entity ref.
// ---------------------------------------------------------------------------

globalThis.rune.spawn = function (location, typeName, configure) {
  const type = rune.getStatic(
    'org.bukkit.entity.EntityType',
    String(typeName).toUpperCase(),
  );
  if (!type) {
    throw new Error(`rune.spawn: unknown entity type '${typeName}'`);
  }
  const world = typeof location.getWorld === 'function'
    ? location.getWorld()
    : rune.bukkit.getWorld(location.world);
  const entity = world.spawnEntity(location, type);
  if (typeof configure === 'function') {
    try { configure(entity); }
    catch (e) {
      __rune_log_error('rune.spawn configure threw: ' + (e && e.stack || e));
    }
  }
  return entity;
};

// ---------------------------------------------------------------------------
// GUI factory -- chest inventory with per-slot click handlers.
//
//   const gui = rune.gui({ title: "<gold>Shop", rows: 3 }, (g) => {
//     g.border(rune.item(bukkit.Material.BLACK_STAINED_GLASS_PANE).name(" ").build());
//     g.slot(13, rune.item(bukkit.Material.DIAMOND).name("Buy").build(), (e) => {
//       e.getWhoClicked().sendMessage("Purchased!");
//       e.getWhoClicked().closeInventory();
//     });
//     g.onClose((e) => console.info(e.getPlayer().getName() + " closed shop"));
//   });
//   gui.open(player);
//
// All clicks inside the GUI are auto-cancelled (so the player can't take
// the display items). The first GUI registration wires the global
// InventoryClickEvent / InventoryCloseEvent listeners exactly once.
// ---------------------------------------------------------------------------

const _activeGuis = new Map(); // inventory __ref -> {slots, size, onClose}
let _guiEventsWired = false;

function _ensureGuiEvents() {
  if (_guiEventsWired) return;
  _guiEventsWired = true;
  rune.on('InventoryClickEvent', (e) => {
    const inv = e.getInventory();
    const refId = inv?.__ref;
    if (refId == null) return;
    const cfg = _activeGuis.get(refId);
    if (!cfg) return;
    // Cancel UNCONDITIONALLY while a Rune GUI is being viewed. Covers:
    //   * clicks on a display item in the top inventory
    //   * shift-clicks from the player's bottom inventory that would
    //     drop the item INTO the top (the click event lives in the
    //     bottom slot but the effect is in the top -- need to cancel
    //     before Bukkit applies the move)
    //   * number-key swaps, hotbar swaps, double-click collects
    // The per-slot onClick handler decides what to do AFTER cancel;
    // callers don't need to call setCancelled themselves.
    e.setCancelled(true);
    const slot = e.getRawSlot();
    if (slot < 0 || slot >= cfg.size) return; // click was in the player's own inventory
    const entry = cfg.slots.get(slot);
    if (entry && typeof entry.onClick === 'function') {
      try { entry.onClick(e); }
      catch (err) { __rune_log_error('GUI click handler threw: ' + (err && err.stack || err)); }
    }
  });
  rune.on('InventoryCloseEvent', (e) => {
    const inv = e.getInventory();
    const refId = inv?.__ref;
    if (refId == null) return;
    const cfg = _activeGuis.get(refId);
    if (!cfg) return;
    if (typeof cfg.onClose === 'function') {
      try { cfg.onClose(e); }
      catch (err) { __rune_log_error('GUI close handler threw: ' + (err && err.stack || err)); }
    }
    _activeGuis.delete(refId);
  });
}

globalThis.rune.gui = function (spec, init) {
  _ensureGuiEvents();
  const rows = Math.max(1, Math.min(6, (spec.rows | 0) || 3));
  const size = rows * 9;
  const titleComp = spec.title ? rune.mm(spec.title) : Component.text('');
  const inv = rune.bukkit.createInventory(null, size, titleComp);

  const slots = new Map();
  let onCloseHandler = null;

  const guiOwn = {
    /** Place an item at `slot`. Optional `onClick(e)` fires on click. */
    slot(idx, item, onClick) {
      slots.set(idx, { item, onClick });
      inv.setItem(idx, item);
      return gui;
    },
    /** Fill empty slots with `item`. Pre-set slots stay put. */
    fill(item, onClick) {
      for (let i = 0; i < size; i++) {
        if (!slots.has(i)) {
          slots.set(i, { item, onClick });
          inv.setItem(i, item);
        }
      }
      return gui;
    },
    /** Decorative border (top + bottom rows + first + last column). */
    border(item, onClick) {
      const rowsCount = size / 9;
      for (let r = 0; r < rowsCount; r++) {
        for (let c = 0; c < 9; c++) {
          if (r === 0 || r === rowsCount - 1 || c === 0 || c === 8) {
            const i = r * 9 + c;
            slots.set(i, { item, onClick });
            inv.setItem(i, item);
          }
        }
      }
      return gui;
    },
    onClose(fn) { onCloseHandler = fn; return gui; },
    open(player) {
      _activeGuis.set(inv.__ref, { slots, size, onClose: onCloseHandler });
      player.openInventory(inv);
      return gui;
    },
    /** Live Inventory ref -- escape hatch for direct Bukkit calls. */
    inventory: inv,
  };

  // Wrap so unknown reads forward to the underlying Inventory ref. Lets
  // scripts treat the gui as if it WERE the Inventory:
  //   event.getInventory().equals(gui)      // <- works
  //   gui.getSize()                          // <- works (delegates to inv.getSize())
  //   if (event.getClickedInventory()?.__ref === gui.__ref) { ... }
  // The CBOR encoder uses ownKeys + getOwnPropertyDescriptor when handing
  // values to Java, so we proxy those too -- otherwise passing `gui` into
  // a Java method would marshal only the builder methods (slot/fill/...)
  // and Java's ArgCoercer would fail to recognise it as an Inventory.
  const gui = new Proxy(guiOwn, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return inv[prop];
    },
    has(target, prop) {
      return prop in target || prop in inv;
    },
    ownKeys(target) {
      return [...new Set([
        ...Reflect.ownKeys(target),
        ...Reflect.ownKeys(inv),
      ])];
    },
    getOwnPropertyDescriptor(target, prop) {
      return Reflect.getOwnPropertyDescriptor(target, prop)
        ?? Reflect.getOwnPropertyDescriptor(inv, prop);
    },
  });

  if (typeof init === 'function') init(gui);
  return gui;
};

// ---------------------------------------------------------------------------
// rune.runOnMain(fn) -- promote a JS function call onto a Bukkit-managed
// thread and return a Promise that resolves with its return value (or
// rejects if the function throws). Safe to call from any thread.
//
// Uses Bukkit.getGlobalRegionScheduler() rather than the legacy
// BukkitScheduler so the same code works on both vanilla Paper (1.20.6+)
// and Folia. On Paper "main thread" is one thread; on Folia "global
// region thread" serialises cross-region work. The JS runtime is
// single-threaded either way, so global is the right place to land.
//
// Critical for HTTP handlers that need to touch world state.
// ---------------------------------------------------------------------------

let _runePluginCache = null;
function _runeGetPlugin() {
  if (_runePluginCache) return _runePluginCache;
  _runePluginCache = rune.bukkit.getPluginManager().getPlugin('Rune');
  if (!_runePluginCache) throw new Error('rune: host plugin not found');
  return _runePluginCache;
}

globalThis.rune.runOnMain = function (fn) {
  return new Promise((resolve, reject) => {
    // GlobalRegionScheduler.run takes a Consumer<ScheduledTask>, not a
    // Runnable. We ignore the task arg — it's only useful for cancellation,
    // which Promise users don't have a handle on anyway.
    const consumer = rune.implement('java.util.function.Consumer', {
      accept: () => {
        try { resolve(fn()); }
        catch (err) { reject(err); }
      },
    });
    try {
      bukkit.Bukkit.getGlobalRegionScheduler().run(_runeGetPlugin(), consumer);
    } catch (e) {
      reject(e);
    }
  });
};

// ---------------------------------------------------------------------------
// rune.serve({ port, host?, executor?, timeoutMs? }, init) -- HTTP server.
//
//   const server = rune.serve({ port: 8080 }, (app) => {
//     app.get('/api/players', async (c) => c.json(await listPlayers()));
//     app.post('/api/players/:uuid/promote', async (c) => {
//       const uuid = c.param('uuid');
//       const { track } = await c.req.json();
//       return c.json({ uuid, track });
//     });
//     app.serveStatic('/', { root: './web/dist', spaFallback: 'index.html' });
//   });
//
// The Java side (HttpServerRegistry) listens, dispatches each request as
// CBOR to our dispatch proxy, then waits on a CompletableFuture keyed by
// requestId. The dispatch handler here decodes the request, runs the
// user's async handler, then calls HttpServerRegistry.respond(...) to
// wake the parked Java thread.
//
// app.framework(prefix, { root, outDir?, install?, rebuild? }) is a sugar
// helper that builds a JS framework (Vite / Next static export / etc.)
// inside `root` (relative to script cwd) on first load, then serves the
// build output via serveStatic with SPA fallback.
// ---------------------------------------------------------------------------

const _runeServers = new Map(); // port -> { close }
const _runeSpaExtensions = new Set([
  '.html', '.js', '.mjs', '.cjs', '.css', '.json', '.png', '.jpg', '.jpeg',
  '.gif', '.svg', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.map', '.txt', '.xml', '.wasm', '.mp3', '.mp4', '.webm', '.pdf',
]);

const _runeMimeByExt = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt':  'text/plain; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':  'font/ttf',
  '.otf':  'font/otf',
  '.wasm': 'application/wasm',
  '.map':  'application/json; charset=utf-8',
};

function _runeMimeOf(filePath) {
  const i = filePath.lastIndexOf('.');
  if (i < 0) return 'application/octet-stream';
  const ext = filePath.slice(i).toLowerCase();
  return _runeMimeByExt[ext] || 'application/octet-stream';
}

globalThis.rune.serve = function (opts, init) {
  if (!opts || typeof opts.port !== 'number') {
    throw new TypeError('rune.serve: opts.port (number) is required');
  }
  const port = opts.port | 0;
  const host = opts.host || '0.0.0.0';
  const threads = (opts.executor && (opts.executor.threads | 0)) || 8;
  const timeoutMs = (opts.timeoutMs | 0) || 30000;

  // Capture the calling script's directory at the rune.serve() call site.
  // process.cwd() is the scripts/ root for every script, so relative paths
  // like "./web" would otherwise resolve to scripts/web instead of the
  // calling script's own web subdir. Walk the stack to find the first
  // frame that lives inside a real script file (not the embedded bootstrap).
  const _serveScriptDir = _runeCallerScriptDir();

  // Routing tables -- populated by init(app) below.
  const routes = []; // {method, segments, handler}
  const staticMounts = []; // {prefix, root, spaFallback}

  function addRoute(method, path, handler) {
    routes.push({ method: method.toUpperCase(), segments: _runeParsePath(path), handler });
  }

  const app = {
    get:    (p, h) => (addRoute('GET',    p, h), app),
    post:   (p, h) => (addRoute('POST',   p, h), app),
    put:    (p, h) => (addRoute('PUT',    p, h), app),
    patch:  (p, h) => (addRoute('PATCH',  p, h), app),
    delete: (p, h) => (addRoute('DELETE', p, h), app),
    all:    (p, h) => (addRoute('*',      p, h), app),
    fallback(handler) { _runeFallback = handler; return app; },
    serveStatic(prefix, options) {
      if (!options || !options.root) {
        throw new TypeError('app.serveStatic(prefix, { root, spaFallback? }) requires root');
      }
      const path = require('node:path');
      const base = _serveScriptDir || process.cwd();
      const absRoot = path.isAbsolute(options.root)
        ? options.root
        : path.resolve(base, options.root);
      staticMounts.push({
        prefix: prefix === '/' ? '' : (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix),
        root: absRoot,
        spaFallback: options.spaFallback || null,
      });
      return app;
    },
    framework(pathOrOpts, maybeOptions) {
      // Flexible signature -- the first string arg is treated as a ROOT
      // path unless it looks like a URL mount prefix (single "/" or a
      // path that doesn't start with "." / non-dot relative):
      //   app.framework("./web")                              root="./web", mount="/"
      //   app.framework("./web", { dev: true, devPort: 3001 }) root="./web", mount="/", merged opts
      //   app.framework({ root: "./web", dev: true })         root="./web", mount="/"
      //   app.framework("/admin", { root: "./web" })          mount="/admin", root="./web"
      let prefix, options;
      const looksLikeMountPrefix = (s) =>
        s === '/' || (s.startsWith('/') && !s.startsWith('/./') && !s.startsWith('/../'));

      if (typeof pathOrOpts === 'string') {
        if (looksLikeMountPrefix(pathOrOpts)) {
          prefix = pathOrOpts;
          options = maybeOptions || {};
        } else {
          // Path-style arg becomes the root; mount at "/" unless opts override.
          prefix = '/';
          options = { ...(maybeOptions || {}), root: pathOrOpts };
        }
      } else if (pathOrOpts && typeof pathOrOpts === 'object') {
        prefix = '/';
        options = pathOrOpts;
      } else {
        throw new TypeError(
          'app.framework: expected (root) | (opts) | (root, opts) | (prefix, opts)',
        );
      }
      if (!options.root) {
        throw new TypeError(
          'app.framework: `root` is required (pass as first arg or in opts)',
        );
      }
      _runeFrameworkQueue.push({ prefix, options, scriptDir: _serveScriptDir });
      return app;
    },
  };

  let _runeFallback = null;
  const _runeFrameworkQueue = [];

  // Dispatch proxy: Java calls into this for every request. Args arrive
  // pre-decoded by the bridge marshaller (headers is a plain object, body
  // is a Uint8Array). We return null immediately; the user's async handler
  // resolves separately and calls respond(requestId, ...) to wake Java.
  const dispatcher = rune.implement('app.rune.HttpRequestDispatcher', {
    dispatch: (requestId, method, path, query, headers, body, remote) => {
      const req = { requestId, method, path, query, headers, body, remote };
      Promise.resolve()
        .then(() => _runeHandleRequest(req, routes, staticMounts, _runeFallback))
        .then((response) => {
          const out = _runeNormalizeForWire(response);
          rune.callStatic(
            'app.rune.HttpServerRegistry', 'respond',
            req.requestId, out.status, JSON.stringify(out.headers), out.body,
          );
        })
        .catch((err) => {
          const stack = err && err.stack ? String(err.stack) : String(err);
          const bodyStr = process.env.NODE_ENV === 'production' ? 'Internal Server Error' : stack;
          rune.callStatic(
            'app.rune.HttpServerRegistry', 'respond',
            req.requestId, 500,
            JSON.stringify({ 'Content-Type': 'text/plain; charset=utf-8' }),
            new TextEncoder().encode(bodyStr),
          );
        });
      return null;
    },
  });

  // Hand off to Java. __runeProxyId is a string (stringified u64) so it
  // round-trips losslessly through CBOR.
  rune.callStatic(
    'app.rune.HttpServerRegistry',
    'start',
    port,
    host,
    threads,
    dispatcher.__runeProxyId,
    timeoutMs,
  );

  // Now run init() -- routes / static mounts / framework decls land in the
  // tables above. Promise so init can be async (framework build).
  const initPromise = Promise.resolve()
    .then(() => init && init(app))
    .then(async () => {
      for (const { prefix, options, scriptDir } of _runeFrameworkQueue) {
        await _runeBuildFramework(prefix, options, staticMounts, scriptDir);
      }
    })
    .catch((err) => {
      console.error('rune.serve init failed: ' + (err && err.stack || err));
    });

  const server = {
    close() {
      rune.callStatic('app.rune.HttpServerRegistry', 'stop', port);
      _runeServers.delete(port);
    },
    ready: initPromise,
  };
  _runeServers.set(port, server);
  return server;
};

function _runeParsePath(p) {
  return String(p).replace(/^\//, '').split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) return { kind: 'param', name: seg.slice(1) };
    if (seg === '*') return { kind: 'wildcard' };
    return { kind: 'literal', text: seg };
  });
}

function _runeNormalizeForWire(response) {
  // Body normalisation: string -> bytes via TextEncoder; Uint8Array /
  // ArrayBuffer -> bytes; null/undefined -> empty; everything else ->
  // JSON.stringify-d into bytes.
  const headers = { ...(response.headers || {}) };
  let body = response.body;
  if (body == null) {
    body = new Uint8Array(0);
  } else if (typeof body === 'string') {
    body = new TextEncoder().encode(body);
  } else if (body instanceof Uint8Array) {
    // already bytes
  } else if (body instanceof ArrayBuffer) {
    body = new Uint8Array(body);
  } else {
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }
    body = new TextEncoder().encode(JSON.stringify(body));
  }
  return { status: (response.status | 0) || 200, headers, body };
}

async function _runeHandleRequest(req, routes, staticMounts, fallback) {
  const url = new URL('http://x' + req.path + (req.query ? '?' + req.query : ''));
  const pathname = url.pathname;

  // 1. Try registered routes.
  for (const r of routes) {
    if (r.method !== '*' && r.method !== req.method) continue;
    const match = _runeMatch(r.segments, pathname);
    if (!match) continue;
    const ctx = _runeMakeContext(req, url, match.params);
    try {
      const result = await r.handler(ctx);
      return _runeNormalize(result, ctx);
    } catch (e) {
      throw e;
    }
  }

  // 2. Try static mounts (longest prefix wins).
  const mounts = staticMounts.slice().sort((a, b) => b.prefix.length - a.prefix.length);
  for (const m of mounts) {
    if (!pathname.startsWith(m.prefix || '/') && m.prefix !== '') continue;
    const sub = m.prefix ? pathname.slice(m.prefix.length) : pathname;
    const served = await _runeServeStaticFile(m.root, sub, m.spaFallback);
    if (served) return served;
  }

  // 3. Fallback handler.
  if (fallback) {
    const ctx = _runeMakeContext(req, url, {});
    const result = await fallback(ctx);
    return _runeNormalize(result, ctx);
  }

  return { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Not Found' };
}

function _runeMatch(segments, pathname) {
  const parts = pathname.replace(/^\//, '').split('/').filter(Boolean);
  if (segments.length === 0 && parts.length === 0) return { params: {} };
  const params = {};
  let i = 0;
  for (const seg of segments) {
    if (seg.kind === 'wildcard') {
      params['*'] = parts.slice(i).join('/');
      return { params };
    }
    if (i >= parts.length) return null;
    if (seg.kind === 'literal') {
      if (seg.text !== parts[i]) return null;
    } else if (seg.kind === 'param') {
      params[seg.name] = decodeURIComponent(parts[i]);
    }
    i++;
  }
  if (i !== parts.length) return null;
  return { params };
}

function _runeMakeContext(req, url, params) {
  const queryParams = new URLSearchParams(req.query || '');
  const headers = req.headers || {};
  const bodyBytes = req.body instanceof Uint8Array ? req.body : new Uint8Array(req.body || []);

  const fetchRequest = {
    method: req.method,
    url: url.toString(),
    headers,
    json: async () => {
      if (bodyBytes.byteLength === 0) {
        throw new Error('request body is empty (expected JSON)');
      }
      const text = new TextDecoder().decode(bodyBytes);
      try {
        return JSON.parse(text);
      } catch (e) {
        const head = text.length > 80 ? text.slice(0, 80) + '…' : text;
        throw new Error('invalid JSON body: ' + ((e && e.message) || e) + ' (got: ' + JSON.stringify(head) + ')');
      }
    },
    text: async () => new TextDecoder().decode(bodyBytes),
    arrayBuffer: async () => bodyBytes.buffer.slice(bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength),
    bytes: () => bodyBytes,
  };

  return {
    req: fetchRequest,
    param: (n) => params[n],
    params,
    query: (n) => queryParams.get(n),
    json: (data, status = 200, extra) => ({
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...(extra || {}) },
      body: JSON.stringify(data),
    }),
    text: (str, status = 200, extra) => ({
      status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', ...(extra || {}) },
      body: String(str),
    }),
    html: (str, status = 200, extra) => ({
      status,
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...(extra || {}) },
      body: String(str),
    }),
    redirect: (location, status = 302) => ({
      status,
      headers: { Location: location },
      body: '',
    }),
    notFound: (body = 'Not Found') => ({
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body,
    }),
  };
}

function _runeNormalize(result, ctx) {
  if (result == null) return { status: 204, headers: {}, body: '' };
  if (typeof result === 'string') return ctx.text(result);
  if (result && typeof result === 'object' && 'status' in result && 'headers' in result) return result;
  // Anything else -> JSON.
  return ctx.json(result);
}

async function _runeServeStaticFile(root, sub, spaFallback) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const abs = path.join(root, sub.replace(/^\//, ''));
  // Prevent path traversal: normalised path must stay within root.
  const resolvedRoot = path.resolve(root);
  const resolvedAbs = path.resolve(abs);
  if (!resolvedAbs.startsWith(resolvedRoot)) return null;

  let target = resolvedAbs;
  try {
    const st = await fs.stat(target);
    if (st.isDirectory()) {
      target = path.join(target, 'index.html');
      await fs.stat(target);
    }
  } catch (_) {
    // Not found. If the request looks like a client-side route AND we have
    // an SPA fallback, serve that. Otherwise return null so caller can
    // continue to the next mount / 404.
    if (!spaFallback) return null;
    const ext = path.extname(sub).toLowerCase();
    if (ext && _runeSpaExtensions.has(ext)) return null; // asset 404, don't fallback
    target = path.resolve(root, spaFallback);
    try { await fs.stat(target); }
    catch (_) { return null; }
  }

  const data = await fs.readFile(target);
  return {
    status: 200,
    headers: {
      'Content-Type': _runeMimeOf(target),
      'Cache-Control': 'public, max-age=3600',
    },
    body: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
}

async function _runeBuildFramework(prefix, options, staticMounts, scriptDir) {
  const path = require('node:path');
  const fs = require('node:fs/promises');
  // Resolve relative paths against the calling script's directory, NOT
  // process.cwd() (which is the shared scripts/ root).
  const base = scriptDir || process.cwd();
  const root = path.isAbsolute(options.root || '.')
    ? options.root
    : path.resolve(base, options.root || '.');
  const installFlag = options.install !== false;

  if (options.dev) {
    // Dev mode: spawn the framework's dev server as a background process
    // and DON'T mount static. The dev server owns its own port; HMR uses
    // WebSocket which JDK HttpServer can't proxy. Users hit the dev URL
    // directly; their vite.config.ts `server.proxy` should forward
    // /api/* to this Rune port. On /rune reload the dev server is kept
    // alive across script reloads (we probe the port and skip respawn).
    const devPort = (options.devPort | 0) || 5173;
    const devScript = options.devCommand || 'dev';

    if (await _runeDevPortInUse(devPort)) {
      console.info(
        '[rune.framework] reusing existing dev server at http://localhost:' + devPort,
      );
    } else {
      const pm = await _runeDetectPackageManager(root);
      if (installFlag) {
        const nm = path.join(root, 'node_modules');
        try { await fs.stat(nm); }
        catch (_) {
          console.info('[rune.framework] ' + pm + ' install in ' + root);
          await _runeSpawn(pm, ['install'], root);
        }
      }
      console.info(
        '[rune.framework] spawning ' + pm + ' run ' + devScript +
        ' in ' + root + ' (HMR on :' + devPort + ')',
      );
      _runeSpawnDevServer(pm, ['run', devScript], root, devPort);
    }
    console.info(
      '[rune.framework] open http://localhost:' + devPort +
      ' for the dev UI -- API still on Rune\'s port. ' +
      'Configure your dev server\'s proxy (vite.config.ts server.proxy) ' +
      'to forward /api/* to this Rune port for same-origin API calls.',
    );
    return;
  }

  // Production: build + mount static.
  const outDir = options.outDir || 'dist';
  const buildScript = options.buildCommand || 'build';
  const rebuild = options.rebuild || 'missing'; // 'missing' | 'always' | 'never'
  const spaFallback = options.spaFallback === false ? null : (options.spaFallback || 'index.html');
  const outPath = path.join(root, outDir);

  let needsBuild = rebuild === 'always';
  if (!needsBuild && rebuild !== 'never') {
    try { await fs.stat(path.join(outPath, spaFallback || 'index.html')); }
    catch (_) { needsBuild = true; }
  }

  if (needsBuild) {
    const pm = await _runeDetectPackageManager(root);
    if (installFlag) {
      const nm = path.join(root, 'node_modules');
      try { await fs.stat(nm); }
      catch (_) {
        console.info('[rune.framework] ' + pm + ' install in ' + root);
        await _runeSpawn(pm, ['install'], root);
      }
    }
    console.info('[rune.framework] ' + pm + ' run ' + buildScript + ' in ' + root);
    await _runeSpawn(pm, ['run', buildScript], root);
  } else {
    console.info('[rune.framework] using cached build at ' + outPath);
  }

  staticMounts.push({
    prefix: prefix === '/' ? '' : (prefix.endsWith('/') ? prefix.slice(0, -1) : prefix),
    root: outPath,
    spaFallback,
  });
}

async function _runeDevPortInUse(port) {
  // Probe BOTH IPv4 and IPv6 -- Vite tends to bind ::1 on Windows, so an
  // IPv4-only probe returns false even when something is listening.
  return (await _runeProbeHost(port, '127.0.0.1')) ||
    (await _runeProbeHost(port, '::1'));
}

function _runeProbeHost(port, host) {
  const net = require('node:net');
  return new Promise((resolve) => {
    const sock = net.connect({ port, host }, () => {
      sock.end();
      resolve(true);
    });
    sock.setTimeout(300);
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error', () => resolve(false));
  });
}

/**
 * Find every PID listening on `port` on the local machine. Empty array
 * if nothing's there. Used as the discovery step before we kill-and-retry
 * a dev-server spawn that hit EADDRINUSE.
 */
function _runeFindPortHolders(port) {
  const { execSync } = require('node:child_process');
  try {
    if (process.platform === 'win32') {
      const out = execSync('netstat -ano -p TCP', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // Match lines like "  TCP    0.0.0.0:3001  0.0.0.0:0  LISTENING  1234"
        // or "  TCP    [::]:3001  [::]:0  LISTENING  1234"
        if (!line.includes('LISTENING')) continue;
        if (!new RegExp(':' + port + '\\b').test(line)) continue;
        const m = line.match(/(\d+)\s*$/);
        if (m) pids.add(parseInt(m[1], 10));
      }
      return [...pids].filter((p) => p > 0 && p !== process.pid);
    } else {
      const out = execSync('lsof -ti tcp:' + port, { encoding: 'utf8' });
      return out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => Number.isFinite(p) && p > 0 && p !== process.pid);
    }
  } catch {
    return [];
  }
}

function _runeKillPids(pids) {
  const { execSync } = require('node:child_process');
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') {
        execSync('taskkill /F /PID ' + pid, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGKILL');
      }
      console.info('[rune.framework] killed PID ' + pid + ' holding the dev port');
    } catch (e) {
      console.warn(
        '[rune.framework] failed to kill PID ' + pid + ': ' +
        ((e && e.message) || e),
      );
    }
  }
}

/**
 * Spawn the framework dev server with one retry: if the child exits
 * non-zero within ~3s (almost always EADDRINUSE), find whoever is on
 * the port, kill them, and respawn once. Beyond that we give up so a
 * broken script can't loop us into killing things forever.
 */
function _runeSpawnDevServer(cmd, args, cwd, port) {
  let attempts = 0;
  const trySpawn = () => {
    attempts++;
    const startedAt = Date.now();
    _runeSpawnBackground(cmd, args, cwd, (code) => {
      // Callback fires on exit. Quick crash + non-zero -> likely port conflict.
      if (attempts >= 2 || code === 0 || code === null) return;
      if (Date.now() - startedAt > 5000) return;
      const holders = _runeFindPortHolders(port);
      if (holders.length === 0) return;
      console.warn(
        '[rune.framework] dev server crashed on :' + port +
        ' -- freeing the port and retrying once. PID(s): ' + holders.join(', '),
      );
      _runeKillPids(holders);
      setTimeout(trySpawn, 400);
    });
  };
  trySpawn();
}

function _runeSpawnBackground(cmd, args, cwd, onExit) {
  const { spawn } = require('node:child_process');
  const onWindows = process.platform === 'win32';
  const finalCmd = onWindows && /^(npm|pnpm|yarn)$/i.test(cmd)
    ? cmd + '.cmd'
    : cmd;
  try {
    // Pipe stdio (don't inherit) -- otherwise Vite / Webpack / Next see a
    // TTY and emit cursor-move + clear-screen escapes that hijack the
    // Minecraft server console. Piped, they fall back to plain log lines.
    // We then forward each line through our logger so it still shows up,
    // prefixed so users can tell what's emitting it.
    const proc = spawn(finalCmd, args, {
      cwd,
      shell: onWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        ...process.env,
        // Strip env hints that make tools think they're in a TTY anyway.
        FORCE_COLOR: '0',
        NO_COLOR: '1',
        CI: '1',
        TERM: 'dumb',
      },
    });
    proc.unref();

    const prefix = '[' + cmd + ']';
    const forward = (stream, log) => {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          // Drop ANSI cursor / clear sequences just in case the tool
          // emits them anyway despite TERM=dumb (some don't honour it).
          const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
          if (clean) log(prefix + ' ' + clean);
        }
      });
    };
    forward(proc.stdout, (m) => console.info(m));
    forward(proc.stderr, (m) => console.warn(m));

    proc.once('error', (e) => {
      console.warn('[rune.framework] dev server error: ' + (e && e.message || e));
    });
    proc.once('exit', (code, sig) => {
      if (code !== 0 && code !== null) {
        console.warn('[rune.framework] dev server exited (code ' + code + ')');
      } else if (sig) {
        console.info('[rune.framework] dev server exited (signal ' + sig + ')');
      }
      if (typeof onExit === 'function') {
        try { onExit(code); } catch {}
      }
    });
  } catch (e) {
    console.warn('[rune.framework] dev server spawn failed: ' + (e && e.message || e));
  }
}

async function _runeDetectPackageManager(root) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const has = async (f) => { try { await fs.stat(path.join(root, f)); return true; } catch { return false; } };
  if (await has('pnpm-lock.yaml')) return 'pnpm';
  if (await has('bun.lockb') || await has('bun.lock')) return 'bun';
  if (await has('yarn.lock')) return 'yarn';
  return 'npm';
}

function _runeSpawn(cmd, args, cwd) {
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    // Windows: npm / pnpm / yarn ship as `.cmd` shims, not real .exe files,
    // so spawning them without a shell or without the extension fails with
    // ENOENT. Use the `.cmd` variant explicitly on win32 + skip shell:true
    // (which can lose the cwd in some libnode-embedded environments).
    const onWindows = process.platform === 'win32';
    // Windows: npm / pnpm / yarn ship as `.cmd` shims, so spawn fails
    // without the extension. Bun ships as a native `bun.exe`, so we let
    // PATHEXT resolve it via shell instead of forcing `.cmd`.
    const finalCmd = onWindows && /^(npm|pnpm|yarn)$/i.test(cmd)
      ? cmd + '.cmd'
      : cmd;
    const proc = spawn(finalCmd, args, {
      cwd,
      shell: onWindows, // shell needed on win32 for .cmd resolution via PATHEXT
      stdio: 'inherit',
      windowsHide: true,
    });
    proc.once('exit', (code) => {
      if (code === 0) resolve(undefined);
      else reject(new Error(finalCmd + ' ' + args.join(' ') + ' exited with ' + code));
    });
    proc.once('error', reject);
  });
}

/**
 * Walk the V8 stack to find the first frame whose source path looks like
 * a real script file (not the embedded bootstrap, which V8 reports under
 * the host binary's name -- usually "java.exe"). Returns the dirname of
 * that file, or null if nothing matches.
 *
 * Used by `rune.serve` to capture the calling script's directory so
 * relative paths in `app.framework("./web")` / `app.serveStatic` resolve
 * against the script's location instead of the shared scripts/ cwd.
 */
function _runeCallerScriptDir() {
  const path = require('node:path');
  const err = new Error();
  const stack = err.stack || '';
  // Match either "(path:line:col)" or "at path:line:col" frames. Path can
  // be Windows ("C:\foo\bar.ts") or POSIX ("/foo/bar.ts"); accepts .ts,
  // .mjs, .js extensions. We skip frames whose path includes "java.exe"
  // (the bootstrap fake-filename) and any without an extension we care
  // about.
  const re = /(?:\(|at\s+)([A-Za-z]:[\\/][^():\n]+?\.(?:ts|mjs|cjs|js)|\/[^():\n]+?\.(?:ts|mjs|cjs|js)):\d+:\d+\)?/g;
  let m;
  while ((m = re.exec(stack)) != null) {
    const file = m[1];
    if (file.includes('java.exe')) continue;
    return path.dirname(file);
  }
  return null;
}

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

globalThis.EventHandler = function EventHandler(eventName, opts) {
  if (typeof eventName !== 'string') {
    throw new TypeError('@EventHandler("EventName", opts?): event name (a string) is required');
  }
  if (opts != null && typeof opts !== 'object') {
    throw new TypeError('@EventHandler opts must be an object: { priority?, ignoreCancelled? }');
  }
  // Validate options eagerly so a typo at script-load time surfaces as a
  // clear error, not a silent default at first event fire.
  const priority = _runeNormalizePriority(opts && opts.priority);
  const ignoreCancelled = Boolean(opts && opts.ignoreCancelled);
  return function (_method, context) {
    if (!context || context.kind !== 'method') {
      throw new Error('@EventHandler must decorate a method');
    }
    context.addInitializer(function () {
      const list = this[_EVENT_HANDLERS] ?? (this[_EVENT_HANDLERS] = []);
      list.push({ event: eventName, propName: String(context.name), priority, ignoreCancelled });
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
  const handlerMeta = probe[_EVENT_HANDLERS] || [];
  if (handlerMeta.length === 0) {
    __rune_log_error('@Listener: class has no @EventHandler methods');
    return target;
  }
  const live = new target();
  for (const meta of handlerMeta) {
    rune.on(meta.event, (e) => live[meta.propName](e), {
      priority: meta.priority,
      ignoreCancelled: meta.ignoreCancelled,
    });
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

// JS-side counter for dynamic-suggester ids. Suggesters are stored in
// `proxyImpls` alongside rune.implement proxies; we use a high range to
// avoid colliding with Kotlin-allocated proxy ids (those start at 1 and
// will never realistically reach 2^32).
let _suggesterIdNext = 4_294_967_296; // 2^32

function _runeRegister(spec, handler) {
  if (!spec.name || typeof spec.name !== 'string') {
    throw new Error('command spec missing `name`');
  }
  // For the top-level (root) call, handler is the root spec's executor;
  // legal to be undefined when the root only branches into subcommands.
  // Walk the tree and register one handler per leaf that has an
  // executor.
  const wire = _runeWalkSpec(spec, handler, /*parentPath=*/ '');
  __rune_register_command(wire);
}

/**
 * Recursively translate a (possibly nested) JS spec into the wire
 * format the Kotlin plugin expects. Side effects per node:
 *   * if `run` is provided, register it in `commandHandlers` under
 *     the dotted path
 *   * if any arg has `suggester`, allocate a suggester id and store
 *     the callback in `proxyImpls` so the Kotlin SuggestionProvider
 *     can call back through the proxy bridge
 *   * subscribe to `__rune_command:<path>` exactly once per path
 */
function _runeWalkSpec(spec, runOverride, parentPath) {
  const path = parentPath ? `${parentPath}.${spec.name}` : spec.name;
  const handler = runOverride ?? spec.run;
  const hasExecutor = typeof handler === 'function';
  if (hasExecutor) {
    commandHandlers.set(path, handler);
    const eventName = '__rune_command:' + path;
    if (!handlers.has(eventName)) {
      // Internal command-dispatch events. The host fires them directly
      // via ScriptCommandRegistry → native.dispatchEvent("__rune_command:<path>"),
      // bypassing Bukkit's listener registration entirely — so we do NOT
      // call __rune_subscribe_event for them. Boxed in the same shape as
      // real-event handlers so the dispatch loop stays uniform.
      handlers.set(eventName, [{
        fn: _runeDispatchCommand.bind(null, path),
        priority: 'NORMAL',
        ignoreCancelled: false,
      }]);
    }
  }
  const argsOut = (spec.args || []).map((a) => {
    const resolved = _resolveSuggest(a.suggest);
    return {
      name: String(a.name),
      description: String(a.description || ''),
      type: String(a.type || 'string'),
      min: a.min ?? null,
      max: a.max ?? null,
      greedy: !!a.greedy,
      optional: !!a.optional,
      suggestions: resolved.list,
      suggester_id: resolved.suggesterId,
      // Per-arg subcommands: literals that come AFTER this arg slot.
      // Path is parent-spec's path (NOT including this arg's name,
      // since args don't add path segments -- only literals do).
      subcommands: (a.subcommands || []).map(
        (sub) => _runeWalkSpec(sub, undefined, path),
      ),
    };
  });
  return {
    name: spec.name,
    description: spec.description || '',
    permission: spec.permission ?? null,
    aliases: spec.aliases || [],
    args: argsOut,
    has_executor: hasExecutor,
    subcommands: (spec.subcommands || []).map(
      (sub) => _runeWalkSpec(sub, undefined, path),
    ),
  };
}

/**
 * Resolve a `suggest` field into either:
 *   * `{ list: [...], suggesterId: null }` -- static snapshot
 *   * `{ list: [], suggesterId: <Number> }` -- dynamic callback
 *
 * The callback path registers the fn in `proxyImpls` so the Kotlin
 * SuggestionProvider can call back via the existing proxy bridge.
 * The JS dispatcher (`__rune_proxy_dispatch`) routes method
 * "suggest" against the stored function.
 */
function _resolveSuggest(suggest) {
  if (suggest == null) return { list: [], suggesterId: null };
  if (Array.isArray(suggest)) {
    return { list: suggest.map(String), suggesterId: null };
  }
  if (typeof suggest === 'function') {
    const id = _suggesterIdNext++;
    // Wrap the fn so the bridge sees a "suggest" method on a synthetic
    // proxy. JS receives [partialInput] as args; user fn can take 0 or
    // 1 args.
    proxyImpls.set(String(id), {
      className: 'RuneSuggester',
      methods: {
        suggest(input) {
          try {
            const out = suggest(String(input ?? ''));
            return Array.isArray(out) ? out.map(String) : [];
          } catch (e) {
            __rune_log_error(
              'dynamic suggester threw: ' + (e && e.stack || e),
            );
            return [];
          }
        },
      },
    });
    return { list: [], suggesterId: id };
  }
  return { list: [], suggesterId: null };
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

// Per-root accumulator for decorator-style subcommand trees. Each
// `@Command("pex user add")` decorated class adds a leaf to this Map,
// then we rebuild + re-emit the full root spec via `_runeRegister`.
// The Kotlin queue accepts updates pre-Brigadier-registration.
const _commandLeaves = new Map(); // rootName -> LeafMeta[]
const _commandRootOpts = new Map(); // rootName -> { description, permission, aliases }

globalThis.Command = function Command(pathOrName, opts) {
  // Space-separated path syntax: `@Command("pex user add")`. Leaf is the
  // last segment, ancestors form the tree above it. Single-word names
  // (the legacy form) just become a 1-segment leaf at the root.
  const segments = String(pathOrName).split(/\s+/).filter(Boolean);
  if (segments.length === 0) {
    throw new Error('@Command(""): name required');
  }
  const root = segments[0];

  return function (target, _context) {
    let probe;
    try {
      probe = new target();
    } catch (e) {
      __rune_log_error(
        `@Command ${pathOrName}: class needs a no-arg constructor (got: ` +
          (e && e.message || e) + ')',
      );
      return target;
    }
    const argList = probe[_ARG_META] || [];
    const runProp = probe[_RUN_META];

    // Root-level opts (description/permission/aliases) on the FIRST
    // decoration of a root command win -- repeats are ignored. Place
    // them on the @Command for the root path (e.g. @Command("pex"))
    // for clarity.
    if (segments.length === 1 && opts && !_commandRootOpts.has(root)) {
      _commandRootOpts.set(root, opts);
    }

    const meta = {
      path: segments,
      args: argList,
      runProp,
      target,
      opts,
    };
    const list = _commandLeaves.get(root) || [];
    list.push(meta);
    _commandLeaves.set(root, list);

    // Rebuild + re-emit the full tree for this root command. Cheap --
    // bounded by total leaf count for the root.
    try {
      _rebuildCommandTree(root);
    } catch (e) {
      __rune_log_error(
        `_rebuildCommandTree(${root}) threw: ` + (e && e.stack || e),
      );
    }
    return target;
  };
};

/**
 * Walk all leaves for `root`, dedupe shared args across siblings, and
 * emit one tree spec via `rune.command(...)`. The Kotlin queue replaces
 * the prior spec for `root` (pre-Brigadier) so each `@Command` decoration
 * effectively merges into the same tree.
 *
 * Arg placement rules:
 *   * Parent-shared args (matched by name) sit at the parent's literal
 *     level. The deepest shared arg holds any executor + further-arg
 *     children.
 *   * Children whose arg lists DON'T share with the parent attach as
 *     siblings of the parent's arg chain (no-arg-prefix literals like
 *     `/pex group list`).
 *   * Children with MORE args than the parent attach as arg.subcommands
 *     of the parent's deepest shared arg.
 */
function _rebuildCommandTree(root) {
  const leaves = _commandLeaves.get(root) || [];

  // Build a literal-only tree first: each path segment becomes a node,
  // with the leaf metadata stashed at the matching node.
  const treeRoot = { name: root, children: new Map(), leaf: null };
  for (const m of leaves) {
    let node = treeRoot;
    for (let i = 1; i < m.path.length; i++) {
      const seg = m.path[i];
      let child = node.children.get(seg);
      if (!child) {
        child = { name: seg, children: new Map(), leaf: null };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.leaf = m;
  }

  const rootOpts = _commandRootOpts.get(root) || {};
  const spec = _emitTreeSpec(treeRoot, /*parentArgs=*/ [], rootOpts);
  // Re-emit via the imperative path. _runeRegister (and the Kotlin
  // queue) handles re-registration by replacing the prior spec.
  _runeRegister(spec, spec.run);
}

function _emitTreeSpec(node, parentArgs, rootOpts) {
  // Args declared by this node's leaf (if any). Strip any prefix already
  // declared by ancestors (matched by name) so we don't re-emit them
  // mid-chain.
  const leafArgs = node.leaf?.args || [];
  const ownArgs = [];
  for (let i = 0; i < leafArgs.length; i++) {
    const matchesParent =
      i < parentArgs.length && parentArgs[i].name === leafArgs[i].name;
    if (!matchesParent) {
      ownArgs.push(...leafArgs.slice(i));
      break;
    }
  }

  const allArgs = parentArgs.concat(ownArgs);
  // Children partition by whether their leaves SHARE the full allArgs
  // chain as a prefix. Those that do attach AFTER allArgs (as
  // arg.subcommands of the deepest); those that don't are siblings
  // (spec.subcommands of THIS node).
  const childList = [...node.children.values()];
  const afterArgs = [];
  const siblings = [];
  for (const c of childList) {
    if (_childHasArgPrefix(c, allArgs)) {
      afterArgs.push(c);
    } else {
      siblings.push(c);
    }
  }

  const spec = {
    name: node.name,
    description: node.leaf?.opts?.description ?? rootOpts.description ?? '',
    permission: node.leaf?.opts?.permission ?? rootOpts.permission ?? null,
    aliases: node.leaf?.opts?.aliases ?? rootOpts.aliases ?? [],
    args: ownArgs.map((a, i) => {
      const isLast = i === ownArgs.length - 1;
      return {
        name: a.name,
        description: a.description,
        type: a.type,
        min: a.min,
        max: a.max,
        greedy: a.greedy,
        optional: a.optional,
        suggest: a.suggest,
        // Attach after-args subcommands to the deepest own arg.
        subcommands: isLast
          ? afterArgs.map((c) => _emitTreeSpec(c, allArgs, rootOpts))
          : [],
      };
    }),
    subcommands: siblings.map((c) => _emitTreeSpec(c, parentArgs, rootOpts)),
  };

  // If there are no own args, the after-arg children attach as
  // sibling-style subcommands instead (no arg to nest under).
  if (ownArgs.length === 0 && afterArgs.length > 0) {
    spec.subcommands = spec.subcommands.concat(
      afterArgs.map((c) => _emitTreeSpec(c, parentArgs, rootOpts)),
    );
  }

  // Bind the run handler if this node has a leaf with @Run.
  if (node.leaf && node.leaf.runProp) {
    const leaf = node.leaf;
    spec.run = function (ctx) {
      const inst = new leaf.target();
      for (const m of leaf.args) inst[m.propName] = ctx.args[m.name];
      return inst[leaf.runProp](ctx);
    };
  }
  return spec;
}

function _childHasArgPrefix(child, prefixArgs) {
  // Walk the child subtree DFS until we find any leaf; check its args.
  if (child.leaf) {
    const a = child.leaf.args;
    if (a.length < prefixArgs.length) return false;
    for (let i = 0; i < prefixArgs.length; i++) {
      if (a[i].name !== prefixArgs[i].name) return false;
    }
    return true;
  }
  for (const sub of child.children.values()) {
    if (_childHasArgPrefix(sub, prefixArgs)) return true;
  }
  return false;
}

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
// Also rebase process.cwd() to the scripts root so libraries that
// resolve paths from cwd (mongoose config loaders, dotenv, ...) land in
// a script-friendly place instead of the Minecraft server root (which
// is wherever the Paper JVM happened to start).
try {
  if (globalThis.process && globalThis.process.stdout) {
    globalThis.process.stdout.write = (s) => { __rune_log_info(String(s).replace(/\n$/, '')); return true; };
  }
  if (globalThis.process && globalThis.process.stderr) {
    globalThis.process.stderr.write = (s) => { __rune_log_error(String(s).replace(/\n$/, '')); return true; };
  }
  if (globalThis.process) {
    const _pathMod = require('node:path');
    // runtimeDir is plugins/Rune/runtime; its sibling /scripts holds
    // the user scripts. Resolve to absolute for libraries that pass
    // cwd() through `path.resolve()` later.
    const _scriptsRoot = _pathMod.resolve(
      _pathMod.dirname('__RUNE_RUNTIME_DIR__'),
      'scripts',
    );
    globalThis.process.cwd = () => _scriptsRoot;
    // chdir() is rarely used by Bukkit scripts; throwing keeps
    // accidental state mutation visible rather than silently
    // letting a library cd into the Minecraft server root.
    globalThis.process.chdir = (_dir) => {
      __rune_log_warn('process.chdir() ignored in Rune scripts; cwd is locked to ' + _scriptsRoot);
    };
  }
} catch (e) {
  __rune_log_error('process patching failed: ' + (e && e.stack || e));
}

// Invoked from C++ on every Bukkit event the host has been told we want.
// `payload` is a Uint8Array of CBOR bytes encoded by the Kotlin event
// forwarder. We decode it via the structured-clone-style cbor module if
// present; otherwise hand the raw bytes through. Phase 4e will pre-decode
// on the C++ side so handlers always get a plain JS object.
globalThis.__runeDispatch = function (name, payload) {
  // The host appends `#<PRIORITY>` to real-event dispatches so we can run
  // only the handlers registered at this priority. Command-dispatch events
  // (`__rune_command:...`) don't carry a suffix; for them we accept any
  // priority (effectively "match all").
  let eventName = name;
  let firedAt = null;
  const hashIdx = name.lastIndexOf('#');
  if (hashIdx > 0) {
    const maybePriority = name.substring(hashIdx + 1);
    if (_RUNE_PRIORITIES.has(maybePriority)) {
      eventName = name.substring(0, hashIdx);
      firedAt = maybePriority;
    }
  }
  const list = handlers.get(eventName);
  if (!list) return;

  let revived = payload;
  if (payload instanceof Uint8Array && typeof globalThis.__rune_decode_event === 'function') {
    try { revived = reviveRefs(globalThis.__rune_decode_event(payload)); }
    catch (_) { revived = payload; }
  } else if (payload && typeof payload === 'object') {
    revived = reviveRefs(payload);
  }

  // ignoreCancelled is implemented JS-side rather than at Bukkit
  // registration time: every handler boxed in `list` knows whether it
  // wants cancelled events skipped. The marshalled event exposes
  // isCancelled() for any class that implements Cancellable.
  const checkCancelled = revived && typeof revived.isCancelled === 'function';

  for (const h of list) {
    if (firedAt != null && h.priority !== firedAt) continue;
    if (h.ignoreCancelled && checkCancelled && revived.isCancelled()) continue;
    try {
      const result = h.fn(revived);
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

    fn invoke_js_proxy(
        &mut self,
        proxy_id: u64,
        method_name: &str,
        args: &[u8],
    ) -> Result<Vec<u8>, RuntimeError> {
        let method_c = CString::new(method_name)
            .map_err(|e| RuntimeError::Other(format!("method name not C-clean: {e}")))?;
        let (args_ptr, args_len) = if args.is_empty() {
            (std::ptr::null::<u8>(), 0usize)
        } else {
            (args.as_ptr(), args.len())
        };
        // Start with 4 KiB scratch; grow to 16 MiB on -1 (mirrors the
        // outbound query buffer-growth logic in QueryFn::call).
        let mut cap = 4096usize;
        loop {
            let mut buf = vec![0u8; cap];
            let n = unsafe {
                ffi::rune_node_invoke_js_proxy(
                    self.handle,
                    proxy_id,
                    method_c.as_ptr(),
                    args_ptr,
                    args_len,
                    buf.as_mut_ptr(),
                    buf.len(),
                )
            };
            if n == -1 {
                let next = (cap * 2).max(8192);
                if next > 16 * 1024 * 1024 {
                    return Err(RuntimeError::Other(
                        "proxy invocation result too large".into(),
                    ));
                }
                cap = next;
                continue;
            }
            if n < 0 {
                return Err(RuntimeError::Other(format!(
                    "rune_node_invoke_js_proxy returned {n}"
                )));
            }
            buf.truncate(n as usize);
            return Ok(buf);
        }
    }
}

// Workaround for the unused-import warning on c_char before phase 2 wires
// ops that take strings.
const _: *const c_char = std::ptr::null();
