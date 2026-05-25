//! Shared contract between `rune-loader` and each language backend.
//!
//! See `DESIGN_SPEC.md` §6 for the cross-FFI contract. Backends implement
//! [`LanguageRuntime`]; the loader owns instances of each and routes by
//! file extension.

use std::cell::Cell;
use std::path::Path;
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use thiserror::Error;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, Error)]
pub enum RuntimeError {
    #[error("script load failed: {0}")]
    Load(String),

    #[error("event dispatch failed: {0}")]
    Dispatch(String),

    #[error("runtime not initialized")]
    NotInitialized,

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("{0}")]
    Other(String),
}

// ---------------------------------------------------------------------------
// Shared value types (mirrors `wit/rune.wit` `types` interface)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct BlockPos {
    pub x: i32,
    pub y: i32,
    pub z: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Vec3 {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

// ---------------------------------------------------------------------------
// HostCommand — guest -> host, state-mutating, executed on the Paper main
// thread after `rune_drain_commands`. Tagged enum: each variant encodes as a
// CBOR map with an "op" string discriminant.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum HostCommand {
    /// Broadcast a chat message to every online player.
    Broadcast { message: String },

    /// Emit a log line into the Paper server log. `script` is the
    /// identity of the originating script (`welcome` for a single file,
    /// folder name for `welcome/index.ts`); `level` is one of
    /// `"debug" | "info" | "warn" | "error"`.
    Log {
        script: String,
        level: String,
        message: String,
    },

    /// Tell the host that at least one script has registered a handler for
    /// the given Bukkit event class (e.g. `"PlayerJoinEvent"`). The host
    /// uses this set to skip the CBOR encode + FFI dispatch for events that
    /// no script cares about (otherwise high-frequency events like
    /// `EntityMoveEvent` would dominate the per-tick budget).
    SubscribeEvent { name: String },

    /// Register a Brigadier command. Specs are collected on the host side
    /// and built into Brigadier trees when Paper's `LifecycleEvents.COMMANDS`
    /// fires (immediately after plugin enable). Commands added after the
    /// lifecycle event fires require a server restart -- this is documented
    /// to users as the trade-off for typed args + tab completion.
    ///
    /// When the player invokes the command, the host dispatches an event
    /// named `__rune_command:<name>` whose payload carries the resolved
    /// `sender` (as a ref) and the parsed `args` (map from arg-name to
    /// value). The JS bootstrap routes that to the registered handler.
    RegisterCommand(CommandSpec),
}

/// Full description of one user-script command. Marshalled JS-side from the
/// `@Command` decorator or the `rune.command(...).register()` builder.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandSpec {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub permission: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub args: Vec<CommandArg>,
}

/// One positional Brigadier argument. `type_` is a tag the Kotlin side maps
/// to a Paper `ArgumentType`:
///   `string`     -> StringArgumentType.string() (quoted-string)
///   `greedy`     -> StringArgumentType.greedyString() (rest-of-line)
///   `word`       -> StringArgumentType.word()
///   `int`        -> IntegerArgumentType.integer(min, max)
///   `long`       -> LongArgumentType.longArg(min, max)
///   `double`     -> DoubleArgumentType.doubleArg(min, max)
///   `bool`       -> BoolArgumentType.bool()
///   `player`     -> ArgumentTypes.player()  (Paper)
///   `players`    -> ArgumentTypes.players()
///   `entity`     -> ArgumentTypes.entity()
///   `entities`   -> ArgumentTypes.entities()
///   `world`      -> ArgumentTypes.world()
///   `block_pos`  -> ArgumentTypes.blockPosition()
/// Unknown tags are treated as `string`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandArg {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "type", default = "default_arg_type")]
    pub type_: String,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    /// If true, this arg consumes the rest of the line (greedyString-style).
    /// Only meaningful for the LAST arg in the list.
    #[serde(default)]
    pub greedy: bool,
    /// If true, the arg is optional (a path through the Brigadier tree exists
    /// that stops before this node). Optional args must come after required.
    #[serde(default)]
    pub optional: bool,
}

fn default_arg_type() -> String { "string".to_string() }

// ---------------------------------------------------------------------------
// HostQuery -- synchronous guest -> host calls via an upcall callback.
//
// Where `HostCommand` is fire-and-forget through the tick-drained queue, a
// `HostQuery` is a same-thread function call: Rust invokes a callback that
// Kotlin registered at init time, the callback runs synchronously and
// returns the response bytes. Used for reflective Bukkit method calls that
// have a return value, static method invocations, and static field reads.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostQuery {
    /// Reflectively call an instance method on the Bukkit object registered
    /// under `ref_id`, returning the result.
    Invoke {
        ref_id: u32,
        method: String,
        args: Vec<ciborium::value::Value>,
    },
    /// Reflectively call a static method on `class_name`.
    InvokeStatic {
        class_name: String,
        method: String,
        args: Vec<ciborium::value::Value>,
    },
    /// Read a static field from `class_name` (e.g. `Material.STONE`).
    GetStaticField {
        class_name: String,
        field: String,
    },
    /// Construct a new instance of `class_name` via its public constructor
    /// whose arity + arg types match. Returns the new instance as a ref
    /// (i.e. `{__ref, __class, ...snapshot}`), wrapped by the JS proxy.
    Construct {
        class_name: String,
        args: Vec<ciborium::value::Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostQueryResult {
    Ok { value: ciborium::value::Value },
    Err { message: String },
}

// The signature of the upcall the Kotlin plugin registers. CBOR query in,
// CBOR response out. Returns bytes written, or `-1` if `cap` was too small
// (the loader doubles its buffer and retries), `-2` on internal failure.
pub type QueryCallback = unsafe extern "C" fn(
    query: *const u8,
    qlen: usize,
    out: *mut u8,
    cap: usize,
) -> isize;

/// A handle to the host's query callback shared between the loader and each
/// backend. The cell is mutated when the Kotlin plugin calls
/// `rune_register_query_callback`. Single-threaded by design -- runtimes
/// are pinned to the Paper main thread.
#[derive(Clone, Default)]
pub struct QueryFn {
    inner: Rc<Cell<Option<QueryCallback>>>,
}

impl QueryFn {
    pub fn new() -> Self {
        Self { inner: Rc::new(Cell::new(None)) }
    }

    pub fn set(&self, cb: QueryCallback) {
        self.inner.set(Some(cb));
    }

    pub fn is_set(&self) -> bool {
        self.inner.get().is_some()
    }

    /// Marshal `query` to the host, return the response bytes. Doubles the
    /// output buffer on -1 (too small) up to 16 MiB.
    pub fn call(&self, query: &[u8]) -> Result<Vec<u8>, RuntimeError> {
        let cb = self
            .inner
            .get()
            .ok_or_else(|| RuntimeError::Other("query callback not registered".into()))?;
        let mut out = vec![0u8; 4096];
        loop {
            let n = unsafe { cb(query.as_ptr(), query.len(), out.as_mut_ptr(), out.len()) };
            if n == -1 {
                let new_size = (out.len() * 2).max(8192);
                if new_size > 16 * 1024 * 1024 {
                    return Err(RuntimeError::Other("query result too large".into()));
                }
                out.resize(new_size, 0);
                continue;
            }
            if n < 0 {
                return Err(RuntimeError::Other(format!(
                    "query callback returned {n}"
                )));
            }
            out.truncate(n as usize);
            return Ok(out);
        }
    }
}

// HostEvent is intentionally NOT a typed enum.
//
// Events cross the FFI as `(event_class: &str, payload: &[u8])` where payload
// is whatever CBOR map the host wanted to serialise for that event class.
// Backends decode the bytes into their guest language's native object form
// (e.g. a JS plain object via serde_v8) without the loader ever needing to
// know the field shape -- so adding a new Bukkit event is a Kotlin-side
// listener registration, not a Rust schema change.
//
// See `DESIGN_SPEC.md` §5.1; the per-event field shapes are owned by
// `rune.d.ts` (auto-generated alongside the plugin).

// Re-export ciborium so backends don't all pin it independently.
pub use ciborium;

// ---------------------------------------------------------------------------
// The trait every backend implements
// ---------------------------------------------------------------------------

/// Implemented by each language backend.
///
/// **Threading:** all methods are called from the Paper main thread; the
/// loader never moves a runtime across threads (see `DESIGN_SPEC.md` §7).
/// `Send` is intentionally *not* required so backends like `deno_core` whose
/// internal types are thread-pinned can implement this directly.
pub trait LanguageRuntime {
    /// Human-readable backend name, e.g. `"js"`.
    fn name(&self) -> &'static str;

    /// File extensions this backend claims, lowercase, no leading dot.
    /// Routing is by exact extension match.
    fn extensions(&self) -> &[&'static str];

    /// Load a script file. Implementations should record enough state to
    /// re-execute on [`reload`].
    fn load_script(&mut self, path: &Path) -> Result<(), RuntimeError>;

    /// Dispatch a host event. `payload` is CBOR-encoded `HostEvent`.
    fn dispatch_event(&mut self, name: &str, payload: &[u8]) -> Result<(), RuntimeError>;

    /// Tear down and rebuild the guest environment, then re-load every script.
    fn reload(&mut self) -> Result<(), RuntimeError>;

    /// Drain pending host commands queued by the guest since the last call.
    fn drain_commands(&mut self) -> Vec<HostCommand>;

    /// Pump runtime-internal scheduling (e.g. JS microtasks, timers).
    /// Called once per Paper server tick.
    fn tick(&mut self) {}

    /// Hand the sync query callback to backends that route it through a
    /// non-`QueryFn` channel (e.g. an FFI C pointer stored in a C++ shim).
    /// JS/deno backends ignore this -- they share `QueryFn` via Rc clones.
    fn set_query_callback(&mut self, _cb: QueryCallback) {}
}
