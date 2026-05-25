// rune_node.h -- C ABI exposed to Rust. Wraps the C++ libnode embedder API
// (CommonEnvironmentSetup, InitializeOncePerProcess, LoadEnvironment, ...)
// behind a stable, simple surface that bindgen can describe.

#ifndef RUNE_NODE_H_
#define RUNE_NODE_H_

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// Status codes -- match rune-loader's convention.
#define RUNE_NODE_OK              0
#define RUNE_NODE_ERR            -1
#define RUNE_NODE_INIT_FAILED    -2
#define RUNE_NODE_NOT_INITIALIZED -3

// Opaque handle. Owned on the C++ side; Rust holds raw pointer.
typedef struct RuneNode RuneNode;

// ---------------------------------------------------------------------------
// Process-wide platform init / shutdown. Call exactly once at startup and
// once at shutdown respectively. Subsequent envs are created against the
// shared V8 platform created here.
// ---------------------------------------------------------------------------
int  rune_node_platform_init(void);
void rune_node_platform_shutdown(void);

// ---------------------------------------------------------------------------
// Per-runtime environment.
// ---------------------------------------------------------------------------

// Allocate a backend with its own isolate + environment.
RuneNode* rune_node_new(void);
void      rune_node_free(RuneNode* rn);

// Bootstrap the runtime by evaluating `setup_js` (UTF-8 source). This is
// where Rune installs its `rune` global, console wiring, etc.
// Returns RUNE_NODE_OK on success.
int rune_node_bootstrap(RuneNode* rn, const char* setup_js);

// Load and evaluate a user script. `path` is absolute; `source` is the
// JS/TS source to execute. The path is used as the module specifier for
// import resolution.
int rune_node_load_script(RuneNode* rn, const char* path, const char* source);

// Pump libuv + V8 microtasks for up to `budget_ms` milliseconds. Returns
// RUNE_NODE_OK; non-OK indicates a runtime error during the pump.
int rune_node_tick(RuneNode* rn, int budget_ms);

// Dispatch a CBOR-encoded event to JS handlers registered via
// `rune.on(name, ...)`. `payload` may be NULL with `len == 0`.
int rune_node_dispatch_event(RuneNode* rn,
                             const char* name,
                             const uint8_t* payload,
                             size_t len);

// Drain pending host commands. Output is a CBOR array of HostCommand maps.
// Returns bytes written; -1 if `cap` too small (caller retries with larger
// buffer; the parked payload is preserved across calls).
ptrdiff_t rune_node_drain_commands(RuneNode* rn, uint8_t* out, size_t cap);

// ---------------------------------------------------------------------------
// Synchronous query upcall: Kotlin -> Panama -> rune_register_query_callback
// installs a `rune_query_callback` on the loader, which forwards it to each
// backend's shim. The shim invokes it from `__rune_invoke{,_static}` and
// `__rune_get_static_field` to satisfy reflective Bukkit method calls inline.
//
// Contract (mirrors rune_host_api::QueryCallback):
//   * `query` / `qlen` is a CBOR-encoded HostQuery.
//   * `out` / `cap` is the scratch buffer for the CBOR-encoded HostQueryResult.
//   * Returns bytes written; `-1` if `cap` too small (callee retries with a
//     larger buffer); `-2` on internal failure.
// ---------------------------------------------------------------------------
typedef ptrdiff_t (*rune_query_callback)(const uint8_t* query,
                                         size_t qlen,
                                         uint8_t* out,
                                         size_t cap);

void rune_node_set_query_callback(RuneNode* rn, rune_query_callback cb);

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // RUNE_NODE_H_
