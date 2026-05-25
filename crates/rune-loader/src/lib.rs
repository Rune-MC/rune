//! Rune loader: C ABI surface that the Kotlin Paper plugin calls via Panama
//! FFM. Owns one instance of each enabled backend, routes scripts by file
//! extension, aggregates outbound commands.
//!
//! ABI contract documented in `DESIGN_SPEC.md` §6.4. Return-code convention:
//!   *  0  success
//!   * -1  generic failure (also: drain buffer too small)
//!   * -2  no runtime claims this extension
//!
//! All strings crossing the boundary are NUL-terminated UTF-8.

use std::ffi::{CStr, c_char};
use std::path::{Path, PathBuf};

use rune_host_api::{HostCommand, LanguageRuntime, QueryCallback, QueryFn};

const RUNE_OK: i32 = 0;
const RUNE_ERR: i32 = -1;
const RUNE_NO_RUNTIME: i32 = -2;

/// Drain buffer too small — `out_cap` was less than the required size.
const RUNE_DRAIN_BUF_TOO_SMALL: isize = -1;
/// Drain encountered an internal error.
const RUNE_DRAIN_INTERNAL_ERR: isize = -2;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/// Opaque from C. Holds one instance of each backend enabled at compile time.
pub struct Loader {
    backends: Vec<Box<dyn LanguageRuntime>>,
    /// If a previous `rune_drain_commands` produced a buffer too small for
    /// the caller, the encoded payload is parked here so the caller can
    /// retry without losing commands.
    pending_drain: Option<Vec<u8>>,
    /// Shared with every backend's JS op state -- the Kotlin host installs a
    /// callback into it via `rune_register_query_callback`. See
    /// `rune_host_api::QueryFn`.
    query_fn: QueryFn,
}

impl Loader {
    fn new(scripts_root: PathBuf) -> Self {
        let query_fn = QueryFn::new();
        let mut backends: Vec<Box<dyn LanguageRuntime>> = Vec::new();
        // Convention enforced by RunePlugin: scripts live at
        // <dataFolder>/scripts and runtime assets (esbuild + ts-loader)
        // at <dataFolder>/runtime. Derive the latter from the former.
        let runtime_dir = scripts_root
            .parent()
            .map(|p| p.join("runtime"))
            .unwrap_or_else(|| scripts_root.join("../runtime"));
        match rune_runtime_node::NodeBackend::new(runtime_dir) {
            Ok(node) => backends.push(Box::new(node)),
            Err(e) => log::error!("node backend init failed: {e}"),
        }
        Self {
            backends,
            pending_drain: None,
            query_fn,
        }
    }

    fn route(&mut self, path: &Path) -> Option<&mut Box<dyn LanguageRuntime>> {
        // Promote folder-scripts to their index entry's extension. Caller
        // (`rune_load_script`) hands us the directory path; the backend's
        // own FS resolution handles the actual entry file.
        let ext_owned: String = if path.is_dir() {
            ["ts", "mjs", "js"]
                .iter()
                .find(|e| path.join(format!("index.{e}")).exists())
                .map(|e| (*e).to_string())?
        } else {
            path.extension()?.to_str()?.to_ascii_lowercase()
        };
        self.backends
            .iter_mut()
            .find(|b| b.extensions().iter().any(|e| *e == ext_owned.as_str()))
    }
}

// ---------------------------------------------------------------------------
// C ABI entry points
// ---------------------------------------------------------------------------

/// Create a loader. Caller owns the returned pointer until `rune_shutdown`.
///
/// `scripts_dir` is the root directory under which user scripts live. The JS
/// module loader uses it as the upper bound when walking `node_modules` for
/// bare imports. May be NULL or empty, in which case the current working
/// directory is used (mainly useful for tests).
///
/// # Safety
/// If non-null, `scripts_dir` must be a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_init(scripts_dir: *const c_char) -> *mut Loader {
    let _ = env_logger::try_init();
    let scripts_root: PathBuf = if scripts_dir.is_null() {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    } else {
        match unsafe { CStr::from_ptr(scripts_dir) }.to_str() {
            Ok(s) if !s.is_empty() => PathBuf::from(s),
            _ => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
        }
    };
    Box::into_raw(Box::new(Loader::new(scripts_root)))
}

/// Load and execute a script. The backend is selected by file extension.
///
/// # Safety
/// `loader` must come from `rune_init` and not yet have been freed.
/// `path` must be a valid NUL-terminated UTF-8 string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_load_script(loader: *mut Loader, path: *const c_char) -> i32 {
    if loader.is_null() || path.is_null() {
        return RUNE_ERR;
    }
    let loader = unsafe { &mut *loader };
    let path_str = match unsafe { CStr::from_ptr(path) }.to_str() {
        Ok(s) => s,
        Err(_) => return RUNE_ERR,
    };
    let path = Path::new(path_str);
    let Some(backend) = loader.route(path) else {
        log::warn!("no runtime claims extension for {path:?}");
        return RUNE_NO_RUNTIME;
    };
    match backend.load_script(path) {
        Ok(()) => RUNE_OK,
        Err(e) => {
            log::error!("load_script({path:?}) failed: {e}");
            RUNE_ERR
        }
    }
}

/// Fan a CBOR-encoded `HostEvent` payload out to every backend.
///
/// # Safety
/// `loader` must come from `rune_init` and not yet have been freed.
/// `name` must be a NUL-terminated UTF-8 string.
/// `payload` must point to at least `len` bytes (or be null with `len == 0`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_dispatch_event(
    loader: *mut Loader,
    name: *const c_char,
    payload: *const u8,
    len: usize,
) -> i32 {
    if loader.is_null() || name.is_null() {
        return RUNE_ERR;
    }
    let loader = unsafe { &mut *loader };
    let name_str = match unsafe { CStr::from_ptr(name) }.to_str() {
        Ok(s) => s,
        Err(_) => return RUNE_ERR,
    };
    let payload_slice: &[u8] = if payload.is_null() || len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(payload, len) }
    };
    let mut had_error = false;
    for backend in loader.backends.iter_mut() {
        if let Err(e) = backend.dispatch_event(name_str, payload_slice) {
            log::error!(
                "dispatch_event({name_str}) -> {}: {e}",
                backend.name()
            );
            had_error = true;
        }
    }
    if had_error { RUNE_ERR } else { RUNE_OK }
}

/// Drain pending host commands across all backends into `out`. Output is a
/// CBOR array of `HostCommand` values.
///
/// Returns the number of bytes written on success. Returns
/// `RUNE_DRAIN_BUF_TOO_SMALL` if the caller's buffer is too small; the
/// commands are *not* lost — they remain parked in the loader and the next
/// call retrieves them once the caller provides a larger buffer.
///
/// # Safety
/// `loader` must come from `rune_init`. `out` must point to at least `cap`
/// writable bytes (or be null with `cap == 0`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_drain_commands(
    loader: *mut Loader,
    out: *mut u8,
    cap: usize,
) -> isize {
    if loader.is_null() {
        return RUNE_DRAIN_INTERNAL_ERR;
    }
    if out.is_null() && cap > 0 {
        return RUNE_DRAIN_INTERNAL_ERR;
    }
    let loader = unsafe { &mut *loader };

    // If we have a parked payload from a previous too-small call, try to
    // ship that first; otherwise drain fresh.
    let encoded: Vec<u8> = match loader.pending_drain.take() {
        Some(buf) => buf,
        None => {
            let mut commands: Vec<HostCommand> = Vec::new();
            for backend in loader.backends.iter_mut() {
                commands.extend(backend.drain_commands());
            }
            if commands.is_empty() {
                return 0;
            }
            let mut buf = Vec::with_capacity(128);
            if let Err(e) = ciborium::into_writer(&commands, &mut buf) {
                log::error!("encode HostCommand list: {e}");
                return RUNE_DRAIN_INTERNAL_ERR;
            }
            buf
        }
    };

    let n = encoded.len();
    if n > cap {
        // Park for the next call so commands aren't lost.
        loader.pending_drain = Some(encoded);
        return RUNE_DRAIN_BUF_TOO_SMALL;
    }
    if n > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(encoded.as_ptr(), out, n);
        }
    }
    n as isize
}

/// Pump per-backend internal scheduling. Called once per Paper server tick.
///
/// # Safety
/// `loader` must come from `rune_init`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_tick(loader: *mut Loader) {
    if loader.is_null() {
        return;
    }
    let loader = unsafe { &mut *loader };
    for backend in loader.backends.iter_mut() {
        backend.tick();
    }
}

/// Tear down and re-build every backend, re-loading previously-loaded scripts.
///
/// # Safety
/// `loader` must come from `rune_init`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_reload(loader: *mut Loader) -> i32 {
    if loader.is_null() {
        return RUNE_ERR;
    }
    let loader = unsafe { &mut *loader };
    let mut had_error = false;
    for backend in loader.backends.iter_mut() {
        if let Err(e) = backend.reload() {
            log::error!("reload({}) failed: {e}", backend.name());
            had_error = true;
        }
    }
    if had_error { RUNE_ERR } else { RUNE_OK }
}

/// Install the synchronous-upcall query callback. The Kotlin plugin creates
/// a Panama `upcallStub` pointing at its `QueryHandler` and passes the
/// resulting function pointer in. Subsequent `op_invoke` / `op_invoke_static`
/// / `op_get_static_field` calls from JS marshal a CBOR query through this
/// callback and decode the response synchronously.
///
/// # Safety
/// `loader` must come from `rune_init`. `cb` must be a valid C function
/// pointer that remains live for as long as the loader is in use.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_register_query_callback(
    loader: *mut Loader,
    cb: QueryCallback,
) {
    if loader.is_null() {
        return;
    }
    let loader = unsafe { &mut *loader };
    loader.query_fn.set(cb);
    // Forward to any backend that needs a direct C pointer (e.g. the
    // libnode shim stores it in its C++ struct). Backends that already
    // received `query_fn` at construction (`JsBackend`) get a no-op
    // default impl.
    for backend in loader.backends.iter_mut() {
        backend.set_query_callback(cb);
    }
}

/// Synchronously invoke a JS-installed proxy method (Java -> JS direction).
///
/// Used by the Kotlin plugin when a Java method on a ByteBuddy-generated
/// proxy (e.g. a PAPI `PlaceholderExpansion` subclass) is invoked: the
/// generated body forwards `(proxy_id, method, cbor_args)` through Panama
/// into here, this function routes it to the first backend that owns the
/// proxy, and the JS handler's return value comes back as CBOR.
///
/// `args` may be null with `args_len == 0` for zero-argument methods.
///
/// Returns the number of bytes written into `out`.
/// `-1` -> `out`/`cap` too small (caller should retry with a larger buffer).
/// `-2` -> internal error (e.g. no JS dispatcher installed, isolate gone).
///
/// # Safety
/// `loader` must come from `rune_init`. `method_name` must be a valid
/// NUL-terminated UTF-8 string. `args` must point to at least `args_len`
/// readable bytes (or be NULL with `args_len == 0`). `out` must point to
/// at least `cap` writable bytes (or be NULL with `cap == 0`).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_invoke_js_proxy(
    loader: *mut Loader,
    proxy_id: u64,
    method_name: *const c_char,
    args: *const u8,
    args_len: usize,
    out: *mut u8,
    cap: usize,
) -> isize {
    if loader.is_null() || method_name.is_null() {
        return -2;
    }
    if out.is_null() && cap > 0 {
        return -2;
    }
    let loader = unsafe { &mut *loader };
    let method_str = match unsafe { CStr::from_ptr(method_name) }.to_str() {
        Ok(s) => s,
        Err(_) => return -2,
    };
    let args_slice: &[u8] = if args.is_null() || args_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(args, args_len) }
    };

    // First backend that can satisfy the call wins. Proxy IDs are unique
    // per loader (allocated by Kotlin's JsProxyFactory); the JS dispatch
    // root returns a CBOR `null` if the proxy_id is unknown -- so even if
    // a future loader hosts multiple runtimes, only one will own each ID.
    for backend in loader.backends.iter_mut() {
        match backend.invoke_js_proxy(proxy_id, method_str, args_slice) {
            Ok(bytes) => {
                if bytes.len() > cap {
                    // The caller's buffer was too small. We DON'T park
                    // these bytes because the same Java call can simply
                    // re-invoke us with a bigger buffer -- the JS handler
                    // is referentially transparent from the loader's POV.
                    return -1;
                }
                if !bytes.is_empty() {
                    unsafe {
                        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
                    }
                }
                return bytes.len() as isize;
            }
            Err(e) => {
                log::error!(
                    "invoke_js_proxy({proxy_id}, {method_str}) -> {}: {e}",
                    backend.name()
                );
            }
        }
    }
    -2
}

/// Free the loader. After this call, the pointer is invalid.
///
/// # Safety
/// `loader` must come from `rune_init` and must not have been freed already.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rune_shutdown(loader: *mut Loader) {
    if loader.is_null() {
        return;
    }
    drop(unsafe { Box::from_raw(loader) });
}
