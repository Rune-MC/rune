// rune_node.cc -- C++ shim wrapping libnode's embedder API behind the
// stable C ABI declared in rune_node.h.
//
// PHASE 3-4a SCOPE: time-budgeted `rune_node_tick` (loop uv_run until
// deadline, pump microtasks each iteration); a per-RuneNode CBOR command
// queue plus the first real V8-native op (`__rune_broadcast`) registered
// directly via the V8 API. Subsequent ops (log_*, subscribe_event, invoke,
// invoke_static, get_static_field) follow the same pattern in phase 4b.

#include "rune_node.h"

#include "node.h"
#include "uv.h"
#include "v8.h"

#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace {

// ---------------------------------------------------------------------------
// Process-wide platform.
// ---------------------------------------------------------------------------

std::shared_ptr<node::InitializationResult> g_init_result;
std::unique_ptr<node::MultiIsolatePlatform> g_platform;
std::once_flag g_platform_once;
bool g_platform_ok = false;

int InitPlatformOnce() {
  std::call_once(g_platform_once, []() {
    // process.argv-equivalent for the embedded Node. Flags here:
    //   --no-warnings   -- silence MODULE_TYPELESS_PACKAGE_JSON and the
    //                      ExperimentalWarning that strip-types emits.
    //                      Without it every dynamic import() of a folder
    //                      script without {"type":"module"} pollutes the
    //                      Paper server log.
    //   --no-deprecation -- libraries like mongoose pull in deprecated
    //                      Node APIs at top level; we don't want to inherit
    //                      their lint output.
    // --experimental-transform-types extends strip-types with TS syntax
    // that has runtime effects: enums, namespaces, parameter properties.
    // (Decorators are NOT covered by amaro 1.1.8 / Node 22.x's transform
    // pipeline -- they'll land when Node bumps to amaro 2.x+ or we ship a
    // bundled transpiler. Users register commands via `rune.command({...})`
    // or `rune.command(name).executes(...)` until then.)
    std::vector<std::string> args = {
        "rune",
        "--no-warnings",
        "--no-deprecation",
        "--experimental-transform-types",
    };
    g_init_result = node::InitializeOncePerProcess(
        args,
        {node::ProcessInitializationFlags::kNoInitializeV8,
         node::ProcessInitializationFlags::kNoInitializeNodeV8Platform});
    if (g_init_result->early_return()) {
      std::fprintf(stderr,
                   "[rune-node] InitializeOncePerProcess early return, exit=%d\n",
                   g_init_result->exit_code());
      return;
    }
    g_platform = node::MultiIsolatePlatform::Create(/* thread_pool_size */ 4);
    v8::V8::InitializePlatform(g_platform.get());
    v8::V8::Initialize();
    g_platform_ok = true;
  });
  return g_platform_ok ? RUNE_NODE_OK : RUNE_NODE_INIT_FAILED;
}

void ShutdownPlatform() {
  if (!g_platform_ok) return;
  v8::V8::Dispose();
  v8::V8::DisposePlatform();
  node::TearDownOncePerProcess();
  g_platform.reset();
  g_init_result.reset();
  g_platform_ok = false;
}

// ---------------------------------------------------------------------------
// CBOR encoder helpers. Hand-rolled because we only ever emit a handful of
// small map shapes. Matches RFC 8949 / what `ciborium` produces on Rust.
// ---------------------------------------------------------------------------

void cbor_uint(std::vector<uint8_t>& out, uint8_t major, uint64_t value) {
  // `major` is the 3-bit major type shifted left to bits 5..7 (so callers
  // pass 0x00, 0x20, 0x40, 0x60, 0x80, 0xA0, ...).
  if (value < 24) {
    out.push_back(major | static_cast<uint8_t>(value));
  } else if (value < 0x100) {
    out.push_back(major | 24);
    out.push_back(static_cast<uint8_t>(value));
  } else if (value < 0x10000) {
    out.push_back(major | 25);
    out.push_back(static_cast<uint8_t>(value >> 8));
    out.push_back(static_cast<uint8_t>(value));
  } else if (value < 0x100000000ULL) {
    out.push_back(major | 26);
    out.push_back(static_cast<uint8_t>(value >> 24));
    out.push_back(static_cast<uint8_t>(value >> 16));
    out.push_back(static_cast<uint8_t>(value >> 8));
    out.push_back(static_cast<uint8_t>(value));
  } else {
    out.push_back(major | 27);
    for (int i = 7; i >= 0; --i) {
      out.push_back(static_cast<uint8_t>(value >> (i * 8)));
    }
  }
}

void cbor_text(std::vector<uint8_t>& out, const char* s, size_t len) {
  cbor_uint(out, 0x60, static_cast<uint64_t>(len));
  out.insert(out.end(), s, s + len);
}

void cbor_text(std::vector<uint8_t>& out, const std::string& s) {
  cbor_text(out, s.data(), s.size());
}

void cbor_map_header(std::vector<uint8_t>& out, uint64_t pairs) {
  cbor_uint(out, 0xA0, pairs);
}

void cbor_array_header(std::vector<uint8_t>& out, uint64_t items) {
  cbor_uint(out, 0x80, items);
}

// ---------------------------------------------------------------------------
// Caller-script identification: walk the V8 stack and return a short
// identifier (folder name for `index.{js,mjs,ts}`, file stem otherwise),
// skipping internal frames (bootstrap, `node:*`, anonymous evals).
// Mirrors the deno_core backend's `current_script_name`.
// ---------------------------------------------------------------------------

// Strip a leading `file:///` (Windows) or `file://` (POSIX) from a URL so
// the path-style logic in DeriveScriptId works uniformly.
std::string StripFileUrlPrefix(const std::string& s) {
  if (s.rfind("file:///", 0) == 0) return s.substr(8);
  if (s.rfind("file://", 0) == 0) return s.substr(7);
  return s;
}

// Trim a `?...` query string (we cache-bust imports with `?t=<ts>`) and
// any `#fragment` so they don't end up in the derived id.
std::string StripQueryAndFragment(const std::string& s) {
  size_t q = s.find_first_of("?#");
  return q == std::string::npos ? s : s.substr(0, q);
}

std::string DeriveScriptId(const std::string& raw) {
  std::string path = StripQueryAndFragment(StripFileUrlPrefix(raw));
  size_t slash = path.find_last_of("/\\");
  std::string base = (slash == std::string::npos) ? path : path.substr(slash + 1);
  size_t dot = base.find_last_of('.');
  std::string stem = (dot == std::string::npos) ? base : base.substr(0, dot);
  if (stem == "index" && slash != std::string::npos) {
    std::string parent = path.substr(0, slash);
    size_t pslash = parent.find_last_of("/\\");
    return (pslash == std::string::npos) ? parent : parent.substr(pslash + 1);
  }
  return stem;
}

// Recognise frames whose resource name is a real script file. Node's
// embedder pushes a synthetic root frame whose `script` is argv[0] (the
// `java.exe` path of the host JVM in our case); a bare path-shape check
// would happily derive the "java" stem from that. Restricting to known
// JS/TS extensions filters out:
//   * argv[0] paths (`...\java.exe`, `node`, etc.)
//   * `node:internal/...` modules
//   * any `<embedder>`-style synthetic names
bool LooksLikeUserScript(const std::string& s) {
  if (s.empty()) return false;
  std::string base = StripQueryAndFragment(s);
  static constexpr const char* kExts[] = {
      ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"};
  for (const char* ext : kExts) {
    size_t len = std::strlen(ext);
    if (base.size() >= len &&
        base.compare(base.size() - len, len, ext) == 0) {
      return true;
    }
  }
  return false;
}

std::string GetCallerScript(v8::Isolate* isolate) {
  v8::Local<v8::StackTrace> stack =
      v8::StackTrace::CurrentStackTrace(isolate, 32);
  int count = stack->GetFrameCount();
  for (int i = 0; i < count; i++) {
    v8::Local<v8::StackFrame> frame = stack->GetFrame(isolate, i);
    // SourceURL is set by `//# sourceURL=` comments AND falls back to the
    // ScriptOrigin name when no comment is present -- so it's a strict
    // superset of GetScriptName().
    v8::Local<v8::String> name = frame->GetScriptNameOrSourceURL();
    if (name.IsEmpty()) continue;
    v8::String::Utf8Value utf8(isolate, name);
    if (!*utf8) continue;
    std::string s(*utf8, utf8.length());
    if (!LooksLikeUserScript(s)) continue;
    return DeriveScriptId(s);
  }
  return "rune";
}

// ---------------------------------------------------------------------------
// Error reporting.
// ---------------------------------------------------------------------------

void ReportException(v8::Isolate* isolate,
                     v8::Local<v8::Context> context,
                     v8::TryCatch* try_catch,
                     const char* where) {
  v8::HandleScope hs(isolate);
  v8::Local<v8::Value> exception = try_catch->Exception();
  v8::String::Utf8Value msg(isolate, exception);
  v8::Local<v8::Message> message = try_catch->Message();

  std::fprintf(stderr, "[rune-node] %s threw: %s\n",
               where, *msg ? *msg : "<no message>");

  if (!message.IsEmpty()) {
    v8::String::Utf8Value resource(isolate, message->GetScriptResourceName());
    int line = message->GetLineNumber(context).FromMaybe(0);
    int col = message->GetStartColumn(context).FromMaybe(0);
    std::fprintf(stderr, "[rune-node]   at %s:%d:%d\n",
                 *resource ? *resource : "<anon>", line, col);
  }

  v8::Local<v8::Value> stack_v;
  if (try_catch->StackTrace(context).ToLocal(&stack_v)) {
    v8::String::Utf8Value stack(isolate, stack_v);
    if (*stack) std::fprintf(stderr, "[rune-node]   %s\n", *stack);
  }
}

}  // namespace

// ---------------------------------------------------------------------------
// RuneNode -- one V8 isolate + Node Environment per instance.
// ---------------------------------------------------------------------------

struct RuneNode {
  std::unique_ptr<node::CommonEnvironmentSetup> setup;
  bool bootstrapped = false;
  // Cached __runeDispatch for fast event dispatch.
  v8::Global<v8::Function> dispatch_fn;
  // Outbound HostCommand queue. Each entry is a fully CBOR-encoded map.
  // Drained as a CBOR array by `rune_node_drain_commands`.
  std::mutex commands_mu;
  std::vector<std::vector<uint8_t>> pending_commands;
  // If a previous drain saw `cap` too small, the assembled CBOR array is
  // parked here for the caller to retry with a larger buffer (mirrors the
  // semantics of the deno_core backend).
  std::vector<uint8_t> parked_drain;
  // Sync upcall back into Kotlin for reflective Bukkit method calls. Set
  // via `rune_node_set_query_callback` after the Kotlin plugin has wired
  // its Panama upcallStub through `rune_register_query_callback`.
  rune_query_callback query_cb = nullptr;
};

namespace {

// Look up the RuneNode* attached to a JS function via the External in Data().
RuneNode* GetRune(const v8::FunctionCallbackInfo<v8::Value>& args) {
  return static_cast<RuneNode*>(args.Data().As<v8::External>()->Value());
}

// Push a fully-encoded HostCommand onto the per-RuneNode queue.
void EnqueueCommand(RuneNode* rn, std::vector<uint8_t>&& bytes) {
  std::lock_guard<std::mutex> lock(rn->commands_mu);
  rn->pending_commands.push_back(std::move(bytes));
}

// ---------------------------------------------------------------------------
// v8::Value <-> CBOR conversion. Used by the sync-upcall query ops to marshal
// method arguments out to Kotlin and decode returned Bukkit objects back into
// JS. Matches what ciborium::value::Value (de)serialises into.
//
// Supported shapes:
//   undefined -> null
//   null      -> null
//   bool      -> bool
//   int/i32   -> CBOR unsigned/negint
//   double    -> CBOR float64 (0xfb)
//   string    -> CBOR text
//   Uint8Array-> CBOR byte string
//   array     -> CBOR array
//   object    -> CBOR map (string keys only; non-string keys are skipped)
// ---------------------------------------------------------------------------

void cbor_negint(std::vector<uint8_t>& out, uint64_t enc) {
  cbor_uint(out, 0x20, enc);
}

void cbor_bytes(std::vector<uint8_t>& out, const uint8_t* p, size_t len) {
  cbor_uint(out, 0x40, static_cast<uint64_t>(len));
  out.insert(out.end(), p, p + len);
}

void cbor_double(std::vector<uint8_t>& out, double v) {
  uint64_t bits;
  std::memcpy(&bits, &v, sizeof(bits));
  out.push_back(0xFB);
  for (int i = 7; i >= 0; --i) {
    out.push_back(static_cast<uint8_t>(bits >> (i * 8)));
  }
}

void EncodeCborValue(v8::Isolate* isolate,
                     v8::Local<v8::Context> context,
                     v8::Local<v8::Value> v,
                     std::vector<uint8_t>& out);

void EncodeCborArray(v8::Isolate* isolate,
                     v8::Local<v8::Context> context,
                     v8::Local<v8::Array> arr,
                     std::vector<uint8_t>& out) {
  uint32_t len = arr->Length();
  cbor_array_header(out, len);
  for (uint32_t i = 0; i < len; ++i) {
    v8::Local<v8::Value> item;
    if (!arr->Get(context, i).ToLocal(&item)) {
      out.push_back(0xF6);  // null
      continue;
    }
    EncodeCborValue(isolate, context, item, out);
  }
}

void EncodeCborObject(v8::Isolate* isolate,
                      v8::Local<v8::Context> context,
                      v8::Local<v8::Object> obj,
                      std::vector<uint8_t>& out) {
  v8::Local<v8::Array> keys;
  if (!obj->GetOwnPropertyNames(context).ToLocal(&keys)) {
    cbor_map_header(out, 0);
    return;
  }
  // First pass: filter to string keys only. Number/symbol keys cannot
  // round-trip through ciborium's Value::Map (which is Vec<(Value, Value)>
  // but treats string keys as canonical).
  std::vector<v8::Local<v8::Value>> str_keys;
  str_keys.reserve(keys->Length());
  for (uint32_t i = 0; i < keys->Length(); ++i) {
    v8::Local<v8::Value> k;
    if (!keys->Get(context, i).ToLocal(&k)) continue;
    if (!k->IsString()) continue;
    str_keys.push_back(k);
  }
  cbor_map_header(out, str_keys.size());
  for (auto& k : str_keys) {
    v8::String::Utf8Value ks(isolate, k);
    cbor_text(out, *ks ? *ks : "", *ks ? static_cast<size_t>(ks.length()) : 0);
    v8::Local<v8::Value> val;
    if (!obj->Get(context, k).ToLocal(&val)) {
      out.push_back(0xF6);
      continue;
    }
    EncodeCborValue(isolate, context, val, out);
  }
}

void EncodeCborValue(v8::Isolate* isolate,
                     v8::Local<v8::Context> context,
                     v8::Local<v8::Value> v,
                     std::vector<uint8_t>& out) {
  if (v.IsEmpty() || v->IsNullOrUndefined()) {
    out.push_back(0xF6);  // null
    return;
  }
  if (v->IsBoolean()) {
    out.push_back(v->IsTrue() ? 0xF5 : 0xF4);
    return;
  }
  if (v->IsInt32()) {
    int32_t i = v.As<v8::Int32>()->Value();
    if (i >= 0) {
      cbor_uint(out, 0x00, static_cast<uint64_t>(i));
    } else {
      // CBOR negative int encodes as -(n+1). i in [INT32_MIN, -1].
      uint64_t enc = static_cast<uint64_t>(-(static_cast<int64_t>(i) + 1));
      cbor_negint(out, enc);
    }
    return;
  }
  if (v->IsUint32()) {
    uint32_t u = v.As<v8::Uint32>()->Value();
    cbor_uint(out, 0x00, static_cast<uint64_t>(u));
    return;
  }
  if (v->IsNumber()) {
    double d = v.As<v8::Number>()->Value();
    // Prefer integer encoding if it round-trips exactly and fits in
    // signed 64-bit -- Java side will then unbox to a primitive type.
    if (std::isfinite(d) && d == std::floor(d) &&
        d >= -9.2233720368547758e18 && d <= 9.2233720368547758e18) {
      int64_t i = static_cast<int64_t>(d);
      if (static_cast<double>(i) == d) {
        if (i >= 0) {
          cbor_uint(out, 0x00, static_cast<uint64_t>(i));
        } else {
          uint64_t enc = static_cast<uint64_t>(-(i + 1));
          cbor_negint(out, enc);
        }
        return;
      }
    }
    cbor_double(out, d);
    return;
  }
  if (v->IsString()) {
    v8::String::Utf8Value s(isolate, v);
    cbor_text(out, *s ? *s : "", *s ? static_cast<size_t>(s.length()) : 0);
    return;
  }
  if (v->IsUint8Array()) {
    v8::Local<v8::Uint8Array> u8 = v.As<v8::Uint8Array>();
    size_t len = u8->ByteLength();
    std::vector<uint8_t> tmp(len);
    if (len > 0) u8->CopyContents(tmp.data(), len);
    cbor_bytes(out, tmp.data(), len);
    return;
  }
  if (v->IsArrayBuffer()) {
    v8::Local<v8::ArrayBuffer> ab = v.As<v8::ArrayBuffer>();
    size_t len = ab->ByteLength();
    cbor_bytes(out, static_cast<const uint8_t*>(ab->Data()), len);
    return;
  }
  if (v->IsArray()) {
    EncodeCborArray(isolate, context, v.As<v8::Array>(), out);
    return;
  }
  if (v->IsObject()) {
    EncodeCborObject(isolate, context, v.As<v8::Object>(), out);
    return;
  }
  // Functions, Symbols, etc. -- not representable. Encode as null so the
  // host sees a placeholder rather than the call failing entirely.
  out.push_back(0xF6);
}

// CBOR decoder: walk `p` advancing it, returning a v8::Value. Throws via
// the isolate's exception channel on malformed input; returns undefined in
// that case (caller checks try_catch).
struct CborReader {
  const uint8_t* p;
  const uint8_t* end;

  bool has(size_t n) const { return p + n <= end; }
  uint8_t get8() { return *p++; }
  uint64_t getN(int n) {
    uint64_t v = 0;
    for (int i = 0; i < n; ++i) v = (v << 8) | get8();
    return v;
  }
  bool read_head(uint8_t& major, uint8_t& ai, uint64_t& value) {
    if (!has(1)) return false;
    uint8_t b = get8();
    major = b & 0xE0;
    ai = b & 0x1F;
    if (ai < 24) { value = ai; return true; }
    if (ai == 24) { if (!has(1)) return false; value = getN(1); return true; }
    if (ai == 25) { if (!has(2)) return false; value = getN(2); return true; }
    if (ai == 26) { if (!has(4)) return false; value = getN(4); return true; }
    if (ai == 27) { if (!has(8)) return false; value = getN(8); return true; }
    return false;
  }
};

double float16_to_double(uint16_t bits) {
  uint16_t sign = (bits >> 15) & 0x1;
  uint16_t exp = (bits >> 10) & 0x1F;
  uint16_t frac = bits & 0x3FF;
  double v;
  if (exp == 0) {
    v = std::ldexp(static_cast<double>(frac), -24);
  } else if (exp == 0x1F) {
    v = (frac == 0) ? std::numeric_limits<double>::infinity()
                    : std::numeric_limits<double>::quiet_NaN();
  } else {
    v = std::ldexp(static_cast<double>(frac + 1024), exp - 25);
  }
  return sign ? -v : v;
}

v8::Local<v8::Value> DecodeCborValue(v8::Isolate* isolate,
                                     v8::Local<v8::Context> context,
                                     CborReader& r,
                                     bool& ok);

v8::Local<v8::Value> DecodeCborArray(v8::Isolate* isolate,
                                     v8::Local<v8::Context> context,
                                     CborReader& r,
                                     uint64_t len,
                                     bool& ok) {
  v8::Local<v8::Array> arr =
      v8::Array::New(isolate, static_cast<int>(len));
  for (uint64_t i = 0; i < len; ++i) {
    v8::Local<v8::Value> item = DecodeCborValue(isolate, context, r, ok);
    if (!ok) return v8::Undefined(isolate);
    arr->Set(context, static_cast<uint32_t>(i), item).Check();
  }
  return arr;
}

v8::Local<v8::Value> DecodeCborMap(v8::Isolate* isolate,
                                   v8::Local<v8::Context> context,
                                   CborReader& r,
                                   uint64_t pairs,
                                   bool& ok) {
  v8::Local<v8::Object> obj = v8::Object::New(isolate);
  for (uint64_t i = 0; i < pairs; ++i) {
    v8::Local<v8::Value> k = DecodeCborValue(isolate, context, r, ok);
    if (!ok) return v8::Undefined(isolate);
    v8::Local<v8::Value> v = DecodeCborValue(isolate, context, r, ok);
    if (!ok) return v8::Undefined(isolate);
    obj->Set(context, k, v).Check();
  }
  return obj;
}

v8::Local<v8::Value> DecodeCborValue(v8::Isolate* isolate,
                                     v8::Local<v8::Context> context,
                                     CborReader& r,
                                     bool& ok) {
  uint8_t major;
  uint8_t ai;
  uint64_t value;
  if (!r.read_head(major, ai, value)) {
    ok = false;
    return v8::Undefined(isolate);
  }
  switch (major) {
    case 0x00:  // unsigned int
      if (value <= 0x7FFFFFFF) {
        return v8::Integer::NewFromUnsigned(isolate,
                                            static_cast<uint32_t>(value));
      }
      return v8::Number::New(isolate, static_cast<double>(value));
    case 0x20: {  // negative int: -(value + 1)
      int64_t i = -static_cast<int64_t>(value) - 1;
      if (i >= INT32_MIN) {
        return v8::Integer::New(isolate, static_cast<int32_t>(i));
      }
      return v8::Number::New(isolate, static_cast<double>(i));
    }
    case 0x40: {  // byte string
      if (!r.has(value)) { ok = false; return v8::Undefined(isolate); }
      std::unique_ptr<v8::BackingStore> store =
          v8::ArrayBuffer::NewBackingStore(isolate, value);
      if (value > 0) std::memcpy(store->Data(), r.p, value);
      r.p += value;
      v8::Local<v8::ArrayBuffer> ab =
          v8::ArrayBuffer::New(isolate, std::move(store));
      return v8::Uint8Array::New(ab, 0, value);
    }
    case 0x60: {  // text string
      if (!r.has(value)) { ok = false; return v8::Undefined(isolate); }
      v8::Local<v8::String> s;
      if (!v8::String::NewFromUtf8(isolate,
                                   reinterpret_cast<const char*>(r.p),
                                   v8::NewStringType::kNormal,
                                   static_cast<int>(value))
               .ToLocal(&s)) {
        ok = false;
        return v8::Undefined(isolate);
      }
      r.p += value;
      return s;
    }
    case 0x80:  // array
      return DecodeCborArray(isolate, context, r, value, ok);
    case 0xA0:  // map
      return DecodeCborMap(isolate, context, r, value, ok);
    case 0xC0: {  // tag -- skip and decode inner
      v8::Local<v8::Value> inner = DecodeCborValue(isolate, context, r, ok);
      return inner;
    }
    case 0xE0:  // simple values + floats
      if (ai < 24) {
        // Simple value in low 5 bits of the head byte.
        switch (value) {
          case 20: return v8::False(isolate);
          case 21: return v8::True(isolate);
          case 22: return v8::Null(isolate);
          case 23: return v8::Undefined(isolate);
          default: return v8::Undefined(isolate);  // unknown simple value
        }
      }
      if (ai == 24) {
        // Extended simple value -- 8-bit code follows.
        switch (value) {
          case 20: return v8::False(isolate);
          case 21: return v8::True(isolate);
          case 22: return v8::Null(isolate);
          case 23: return v8::Undefined(isolate);
          default: return v8::Undefined(isolate);
        }
      }
      if (ai == 25) {  // float16
        return v8::Number::New(isolate,
                               float16_to_double(static_cast<uint16_t>(value)));
      }
      if (ai == 26) {  // float32
        uint32_t bits = static_cast<uint32_t>(value);
        float f;
        std::memcpy(&f, &bits, sizeof(f));
        return v8::Number::New(isolate, static_cast<double>(f));
      }
      if (ai == 27) {  // float64
        double d;
        std::memcpy(&d, &value, sizeof(d));
        return v8::Number::New(isolate, d);
      }
      ok = false;
      return v8::Undefined(isolate);
    default:
      ok = false;
      return v8::Undefined(isolate);
  }
}

// Invoke the registered query callback with `query` (CBOR-encoded HostQuery).
// Decodes the CBOR-encoded HostQueryResult and either returns the value or
// throws the error message back into JS. Returns v8::Undefined() if the
// query callback is not registered (with an exception thrown).
v8::Local<v8::Value> CallQuery(v8::Isolate* isolate,
                               v8::Local<v8::Context> context,
                               RuneNode* rn,
                               const std::vector<uint8_t>& query) {
  if (!rn->query_cb) {
    isolate->ThrowException(v8::Exception::Error(
        v8::String::NewFromUtf8Literal(isolate,
                                       "rune query callback not registered")));
    return v8::Undefined(isolate);
  }
  std::vector<uint8_t> buf(4096);
  ptrdiff_t n = 0;
  for (;;) {
    n = rn->query_cb(query.data(), query.size(), buf.data(), buf.size());
    if (n == -1) {
      size_t next = buf.size() * 2;
      if (next > 16 * 1024 * 1024) {
        isolate->ThrowException(v8::Exception::Error(
            v8::String::NewFromUtf8Literal(isolate, "query response too large")));
        return v8::Undefined(isolate);
      }
      buf.resize(next);
      continue;
    }
    break;
  }
  if (n < 0) {
    isolate->ThrowException(v8::Exception::Error(
        v8::String::NewFromUtf8Literal(isolate, "query callback failure")));
    return v8::Undefined(isolate);
  }
  // The response is HostQueryResult: a CBOR map with "type" + ("value" | "message").
  CborReader r{buf.data(), buf.data() + static_cast<size_t>(n)};
  bool ok = true;
  uint8_t major;
  uint8_t ai;
  uint64_t pairs;
  if (!r.read_head(major, ai, pairs) || major != 0xA0) {
    isolate->ThrowException(v8::Exception::Error(
        v8::String::NewFromUtf8Literal(isolate, "malformed query response")));
    return v8::Undefined(isolate);
  }
  std::string variant;
  v8::Local<v8::Value> value_out = v8::Undefined(isolate);
  std::string err_msg;
  bool has_value = false;
  for (uint64_t i = 0; i < pairs; ++i) {
    v8::Local<v8::Value> k = DecodeCborValue(isolate, context, r, ok);
    if (!ok) {
      isolate->ThrowException(v8::Exception::Error(
          v8::String::NewFromUtf8Literal(isolate, "malformed query response key")));
      return v8::Undefined(isolate);
    }
    v8::String::Utf8Value ks(isolate, k);
    std::string key = *ks ? std::string(*ks, ks.length()) : "";
    if (key == "type") {
      v8::Local<v8::Value> v = DecodeCborValue(isolate, context, r, ok);
      if (!ok) {
        isolate->ThrowException(v8::Exception::Error(
            v8::String::NewFromUtf8Literal(isolate, "malformed query response")));
        return v8::Undefined(isolate);
      }
      v8::String::Utf8Value vs(isolate, v);
      if (*vs) variant.assign(*vs, vs.length());
    } else if (key == "value") {
      value_out = DecodeCborValue(isolate, context, r, ok);
      has_value = true;
      if (!ok) {
        isolate->ThrowException(v8::Exception::Error(
            v8::String::NewFromUtf8Literal(isolate, "malformed query value")));
        return v8::Undefined(isolate);
      }
    } else if (key == "message") {
      v8::Local<v8::Value> v = DecodeCborValue(isolate, context, r, ok);
      if (!ok) {
        isolate->ThrowException(v8::Exception::Error(
            v8::String::NewFromUtf8Literal(isolate, "malformed query message")));
        return v8::Undefined(isolate);
      }
      v8::String::Utf8Value vs(isolate, v);
      if (*vs) err_msg.assign(*vs, vs.length());
    } else {
      // Unknown key; skip its value.
      DecodeCborValue(isolate, context, r, ok);
      if (!ok) {
        isolate->ThrowException(v8::Exception::Error(
            v8::String::NewFromUtf8Literal(isolate, "malformed query response")));
        return v8::Undefined(isolate);
      }
    }
  }
  if (variant == "err") {
    v8::Local<v8::String> msg =
        v8::String::NewFromUtf8(isolate, err_msg.c_str(),
                                v8::NewStringType::kNormal,
                                static_cast<int>(err_msg.size()))
            .ToLocalChecked();
    isolate->ThrowException(v8::Exception::Error(msg));
    return v8::Undefined(isolate);
  }
  if (variant == "ok") {
    if (has_value) return value_out;
    return v8::Local<v8::Value>(v8::Undefined(isolate));
  }
  isolate->ThrowException(v8::Exception::Error(
      v8::String::NewFromUtf8Literal(isolate, "unknown query response variant")));
  return v8::Undefined(isolate);
}

// __rune_invoke(refId: number, method: string, argsArray: any[]) -> any
//
// CBOR query: { "type": "invoke", "ref_id": <u32>, "method": <s>, "args": [...] }
void JS_Invoke(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 3 || !args[1]->IsString() || !args[2]->IsArray()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_invoke(refId, method, args[])")));
    return;
  }
  uint32_t ref_id = args[0]->Uint32Value(context).FromMaybe(0);
  v8::String::Utf8Value method(isolate, args[1]);
  v8::Local<v8::Array> argv = args[2].As<v8::Array>();

  std::vector<uint8_t> q;
  cbor_map_header(q, 4);
  cbor_text(q, "type");
  cbor_text(q, "invoke");
  cbor_text(q, "ref_id");
  cbor_uint(q, 0x00, static_cast<uint64_t>(ref_id));
  cbor_text(q, "method");
  cbor_text(q, *method, static_cast<size_t>(method.length()));
  cbor_text(q, "args");
  EncodeCborArray(isolate, context, argv, q);

  args.GetReturnValue().Set(CallQuery(isolate, context, GetRune(args), q));
}

// __rune_invoke_static(className: string, method: string, argsArray: any[]) -> any
void JS_InvokeStatic(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 3 || !args[0]->IsString() || !args[1]->IsString() ||
      !args[2]->IsArray()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_invoke_static(className, method, args[])")));
    return;
  }
  v8::String::Utf8Value cls(isolate, args[0]);
  v8::String::Utf8Value method(isolate, args[1]);
  v8::Local<v8::Array> argv = args[2].As<v8::Array>();

  std::vector<uint8_t> q;
  cbor_map_header(q, 4);
  cbor_text(q, "type");
  cbor_text(q, "invoke_static");
  cbor_text(q, "class_name");
  cbor_text(q, *cls, static_cast<size_t>(cls.length()));
  cbor_text(q, "method");
  cbor_text(q, *method, static_cast<size_t>(method.length()));
  cbor_text(q, "args");
  EncodeCborArray(isolate, context, argv, q);

  args.GetReturnValue().Set(CallQuery(isolate, context, GetRune(args), q));
}

// __rune_decode_event(payload: Uint8Array) -> any
//
// Decode a CBOR-encoded HostEvent payload into a plain JS object. Used by
// __runeDispatch so user handlers always get an object, not a Uint8Array.
void JS_DecodeEvent(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 1 || !args[0]->IsUint8Array()) {
    args.GetReturnValue().Set(v8::Null(isolate));
    return;
  }
  v8::Local<v8::Uint8Array> u8 = args[0].As<v8::Uint8Array>();
  size_t len = u8->ByteLength();
  if (len == 0) {
    args.GetReturnValue().Set(v8::Null(isolate));
    return;
  }
  std::vector<uint8_t> tmp(len);
  u8->CopyContents(tmp.data(), len);
  CborReader r{tmp.data(), tmp.data() + len};
  bool ok = true;
  v8::Local<v8::Value> v = DecodeCborValue(isolate, context, r, ok);
  if (!ok) {
    args.GetReturnValue().Set(v8::Null(isolate));
    return;
  }
  args.GetReturnValue().Set(v);
}

// __rune_construct(className: string, argsArray: any[]) -> any
//
// Constructs a new instance of `className`. Returns the constructed object
// as a Bukkit ref (wrapped by JS reviveRefs into a Proxy).
//
// CBOR query: { "type": "construct", "class_name": <s>, "args": [...] }
void JS_Construct(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 2 || !args[0]->IsString() || !args[1]->IsArray()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_construct(className, args[])")));
    return;
  }
  v8::String::Utf8Value cls(isolate, args[0]);
  v8::Local<v8::Array> argv = args[1].As<v8::Array>();

  std::vector<uint8_t> q;
  cbor_map_header(q, 3);
  cbor_text(q, "type");
  cbor_text(q, "construct");
  cbor_text(q, "class_name");
  cbor_text(q, *cls, static_cast<size_t>(cls.length()));
  cbor_text(q, "args");
  EncodeCborArray(isolate, context, argv, q);

  args.GetReturnValue().Set(CallQuery(isolate, context, GetRune(args), q));
}

// __rune_get_static_field(className: string, field: string) -> any
void JS_GetStaticField(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 2 || !args[0]->IsString() || !args[1]->IsString()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_get_static_field(className, field)")));
    return;
  }
  v8::String::Utf8Value cls(isolate, args[0]);
  v8::String::Utf8Value field(isolate, args[1]);

  std::vector<uint8_t> q;
  cbor_map_header(q, 3);
  cbor_text(q, "type");
  cbor_text(q, "get_static_field");
  cbor_text(q, "class_name");
  cbor_text(q, *cls, static_cast<size_t>(cls.length()));
  cbor_text(q, "field");
  cbor_text(q, *field, static_cast<size_t>(field.length()));

  args.GetReturnValue().Set(CallQuery(isolate, context, GetRune(args), q));
}

// __rune_broadcast(message: string) -> undefined
//
// CBOR shape: { "op": "broadcast", "message": <string> }
void JS_Broadcast(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() < 1) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(isolate,
                                       "rune.broadcast(message): missing message")));
    return;
  }
  v8::String::Utf8Value msg(isolate, args[0]);
  if (!*msg) return;

  std::vector<uint8_t> bytes;
  cbor_map_header(bytes, 2);
  cbor_text(bytes, "op");
  cbor_text(bytes, "broadcast");
  cbor_text(bytes, "message");
  cbor_text(bytes, *msg, static_cast<size_t>(msg.length()));

  EnqueueCommand(GetRune(args), std::move(bytes));
}

// Shared body for the four __rune_log_* ops. `level` is one of
// "debug" | "info" | "warn" | "error" -- matches the Rust enum.
//
// CBOR shape: { "op": "log", "script": <id>, "level": <level>, "message": <s> }
void JS_LogImpl(const v8::FunctionCallbackInfo<v8::Value>& args,
                const char* level) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() < 1) return;
  v8::String::Utf8Value msg(isolate, args[0]);
  if (!*msg) return;

  std::string script = GetCallerScript(isolate);

  std::vector<uint8_t> bytes;
  cbor_map_header(bytes, 4);
  cbor_text(bytes, "op");
  cbor_text(bytes, "log");
  cbor_text(bytes, "script");
  cbor_text(bytes, script);
  cbor_text(bytes, "level");
  cbor_text(bytes, level, std::strlen(level));
  cbor_text(bytes, "message");
  cbor_text(bytes, *msg, static_cast<size_t>(msg.length()));

  EnqueueCommand(GetRune(args), std::move(bytes));
}

void JS_LogDebug(const v8::FunctionCallbackInfo<v8::Value>& args) {
  JS_LogImpl(args, "debug");
}
void JS_LogInfo(const v8::FunctionCallbackInfo<v8::Value>& args) {
  JS_LogImpl(args, "info");
}
void JS_LogWarn(const v8::FunctionCallbackInfo<v8::Value>& args) {
  JS_LogImpl(args, "warn");
}
void JS_LogError(const v8::FunctionCallbackInfo<v8::Value>& args) {
  JS_LogImpl(args, "error");
}

// __rune_register_command(spec: object) -> undefined
//
// Encodes the JS spec object inline as the body of a `register_command`
// HostCommand. Spec shape (see rune_host_api::CommandSpec):
//   { name, description, permission?, aliases: string[], args: [...] }
//
// Each spec field lives at the SAME level as the `op` discriminator so the
// Rust enum's tagged-enum codec (`#[serde(tag = "op")]`) deserialises it
// straight into the variant.
void JS_RegisterCommand(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  v8::Local<v8::Context> context = isolate->GetCurrentContext();
  if (args.Length() < 1 || !args[0]->IsObject()) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_register_command(spec): spec must be an object")));
    return;
  }
  v8::Local<v8::Object> spec = args[0].As<v8::Object>();

  // Pull the field names off the spec to size the outer CBOR map.
  v8::Local<v8::Array> keys;
  if (!spec->GetOwnPropertyNames(context).ToLocal(&keys)) return;
  std::vector<v8::Local<v8::String>> str_keys;
  str_keys.reserve(keys->Length());
  for (uint32_t i = 0; i < keys->Length(); ++i) {
    v8::Local<v8::Value> k;
    if (!keys->Get(context, i).ToLocal(&k) || !k->IsString()) continue;
    str_keys.push_back(k.As<v8::String>());
  }

  std::vector<uint8_t> bytes;
  // +1 for the "op" tag itself.
  cbor_map_header(bytes, str_keys.size() + 1);
  cbor_text(bytes, "op");
  cbor_text(bytes, "register_command");
  for (auto& key : str_keys) {
    v8::String::Utf8Value ks(isolate, key);
    if (!*ks) continue;
    cbor_text(bytes, *ks, static_cast<size_t>(ks.length()));
    v8::Local<v8::Value> val;
    if (!spec->Get(context, key).ToLocal(&val)) {
      bytes.push_back(0xF6);  // null
      continue;
    }
    EncodeCborValue(isolate, context, val, bytes);
  }

  EnqueueCommand(GetRune(args), std::move(bytes));
}

// __rune_subscribe_event(name: string) -> undefined
//
// CBOR shape: { "op": "subscribe_event", "name": <event-class> }
void JS_SubscribeEvent(const v8::FunctionCallbackInfo<v8::Value>& args) {
  v8::Isolate* isolate = args.GetIsolate();
  if (args.Length() < 1) {
    isolate->ThrowException(v8::Exception::TypeError(
        v8::String::NewFromUtf8Literal(
            isolate, "__rune_subscribe_event(name): missing event name")));
    return;
  }
  v8::String::Utf8Value name(isolate, args[0]);
  if (!*name) return;

  std::vector<uint8_t> bytes;
  cbor_map_header(bytes, 2);
  cbor_text(bytes, "op");
  cbor_text(bytes, "subscribe_event");
  cbor_text(bytes, "name");
  cbor_text(bytes, *name, static_cast<size_t>(name.length()));

  EnqueueCommand(GetRune(args), std::move(bytes));
}

// Install the rune-* V8-native ops onto globalThis as `__rune_*` so the
// bootstrap JS can wire them into the user-facing `rune` global / `console`.
void InstallNativeOps(v8::Isolate* isolate,
                      v8::Local<v8::Context> context,
                      RuneNode* rn) {
  v8::Local<v8::Object> global = context->Global();
  v8::Local<v8::External> data = v8::External::New(isolate, rn);

  auto bind = [&](const char* name, v8::FunctionCallback cb) {
    v8::Local<v8::Function> fn =
        v8::Function::New(context, cb, data).ToLocalChecked();
    v8::Local<v8::String> key =
        v8::String::NewFromUtf8(isolate, name).ToLocalChecked();
    global->Set(context, key, fn).Check();
  };

  bind("__rune_broadcast", JS_Broadcast);
  bind("__rune_log_debug", JS_LogDebug);
  bind("__rune_log_info", JS_LogInfo);
  bind("__rune_log_warn", JS_LogWarn);
  bind("__rune_log_error", JS_LogError);
  bind("__rune_subscribe_event", JS_SubscribeEvent);
  bind("__rune_register_command", JS_RegisterCommand);
  bind("__rune_invoke", JS_Invoke);
  bind("__rune_invoke_static", JS_InvokeStatic);
  bind("__rune_get_static_field", JS_GetStaticField);
  bind("__rune_construct", JS_Construct);
  bind("__rune_decode_event", JS_DecodeEvent);
}

}  // namespace

extern "C" {

int rune_node_platform_init(void) {
  return InitPlatformOnce();
}

void rune_node_platform_shutdown(void) {
  ShutdownPlatform();
}

RuneNode* rune_node_new(void) {
  if (!g_platform_ok) return nullptr;

  auto* rn = new RuneNode();
  std::vector<std::string> args = {"rune"};
  std::vector<std::string> exec_args = {};
  std::vector<std::string> errors;
  rn->setup = node::CommonEnvironmentSetup::Create(
      g_platform.get(), &errors, args, exec_args);
  if (!rn->setup) {
    for (const auto& e : errors) {
      std::fprintf(stderr, "[rune-node] env setup error: %s\n", e.c_str());
    }
    delete rn;
    return nullptr;
  }
  return rn;
}

void rune_node_free(RuneNode* rn) {
  if (!rn) return;
  if (rn->setup) {
    v8::Isolate* isolate = rn->setup->isolate();
    uv_loop_t* loop = rn->setup->event_loop();
    {
      v8::Locker locker(isolate);
      v8::Isolate::Scope iscope(isolate);
      v8::HandleScope hscope(isolate);
      v8::Context::Scope cscope(rn->setup->context());

      // Drop globals BEFORE telling Node to stop, otherwise the dispatch
      // function's persistent handle keeps the context alive longer than
      // the env::Stop tries to tear it down.
      rn->dispatch_fn.Reset();

      // 1. Tell Node to terminate the environment. Schedules the env to
      //    exit at the next safe yield point: pending JS throws "Script
      //    execution terminated", cleanup hooks fire, internal async
      //    handles get closed by Node itself.
      node::Stop(rn->setup->env());

      // 2. Spin the loop with a wall-clock budget. UV_RUN_NOWAIT advances
      //    one iteration of timers / pending I/O without blocking, so each
      //    tick is microseconds when there's nothing to do. We pump until
      //    the loop says it's idle OR 500ms elapses -- whichever first.
      //
      //    We DELIBERATELY don't force-close uv handles anymore: the
      //    previous attempt hit asserts in libuv because Node's own
      //    teardown was concurrently closing the same handles (race in
      //    uv_close's UV_HANDLE_CLOSING flag check). Letting Node drive
      //    the close itself is safer; a user script with a stuck
      //    setInterval will simply make this loop hit the 500ms cap and
      //    then setup.reset() does the final, possibly-slow teardown.
      const auto deadline =
          std::chrono::steady_clock::now() + std::chrono::milliseconds(500);
      while (uv_loop_alive(loop) &&
             std::chrono::steady_clock::now() < deadline) {
        uv_run(loop, UV_RUN_NOWAIT);
        isolate->PerformMicrotaskCheckpoint();
      }
    }
    // ~CommonEnvironmentSetup acquires the locker internally and runs
    // FreeEnvironment + DisposeIsolate. With the handle table empty above,
    // this returns quickly. Must happen OUTSIDE the locker scope or we'd
    // double-acquire.
    rn->setup.reset();
  }
  delete rn;
}

int rune_node_bootstrap(RuneNode* rn, const char* setup_js) {
  if (!rn || !rn->setup) return RUNE_NODE_NOT_INITIALIZED;
  if (!setup_js) return RUNE_NODE_ERR;
  if (rn->bootstrapped) return RUNE_NODE_OK;

  v8::Isolate* isolate = rn->setup->isolate();
  v8::Locker locker(isolate);
  v8::Isolate::Scope iscope(isolate);
  v8::HandleScope hscope(isolate);
  v8::Local<v8::Context> context = rn->setup->context();
  v8::Context::Scope cscope(context);

  // Install __rune_* native ops BEFORE evaluating the bootstrap so it can
  // wire them into the `rune` global it installs.
  InstallNativeOps(isolate, context, rn);

  v8::TryCatch try_catch(isolate);
  v8::MaybeLocal<v8::Value> result =
      node::LoadEnvironment(rn->setup->env(), setup_js);
  if (result.IsEmpty() || try_catch.HasCaught()) {
    if (try_catch.HasCaught()) {
      ReportException(isolate, context, &try_catch, "bootstrap");
    } else {
      std::fprintf(stderr, "[rune-node] bootstrap LoadEnvironment empty result\n");
    }
    return RUNE_NODE_ERR;
  }

  v8::Local<v8::Object> global = context->Global();
  v8::Local<v8::Value> key;
  if (!v8::String::NewFromUtf8(isolate, "__runeDispatch").ToLocal(&key)) {
    return RUNE_NODE_ERR;
  }
  v8::Local<v8::Value> val;
  if (global->Get(context, key).ToLocal(&val) && val->IsFunction()) {
    rn->dispatch_fn.Reset(isolate, val.As<v8::Function>());
  } else {
    std::fprintf(stderr,
                 "[rune-node] bootstrap did not install __runeDispatch\n");
    return RUNE_NODE_ERR;
  }

  rn->bootstrapped = true;
  return RUNE_NODE_OK;
}

// Drive the uv loop until `promise` settles, or `timeout_ms` elapses.
// Returns RUNE_NODE_OK on fulfilled; RUNE_NODE_ERR on rejected or timeout.
// On rejection writes a [rune-node] line describing the reason.
int AwaitPromise(RuneNode* rn,
                 v8::Isolate* isolate,
                 v8::Local<v8::Context> context,
                 v8::Local<v8::Promise> promise,
                 const char* where,
                 int timeout_ms) {
  uv_loop_t* loop = rn->setup->event_loop();
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
  while (promise->State() == v8::Promise::kPending) {
    // UV_RUN_ONCE blocks until at least one event fires (or the loop
    // empties). With a tight `--experimental-strip-types` import this
    // typically returns in microseconds; with mongoose-style heavy
    // first-load it may take much longer.
    uv_run(loop, UV_RUN_ONCE);
    isolate->PerformMicrotaskCheckpoint();
    if (std::chrono::steady_clock::now() > deadline) {
      std::fprintf(stderr,
                   "[rune-node] %s timed out after %dms\n",
                   where, timeout_ms);
      return RUNE_NODE_ERR;
    }
  }
  if (promise->State() == v8::Promise::kRejected) {
    v8::Local<v8::Value> reason = promise->Result();
    v8::String::Utf8Value msg(isolate, reason);
    std::fprintf(stderr,
                 "[rune-node] %s rejected: %s\n",
                 where, *msg ? *msg : "<no message>");
    // If the reason is an Error with a stack, dump it too.
    if (reason->IsObject()) {
      v8::Local<v8::Object> obj = reason.As<v8::Object>();
      v8::Local<v8::Value> stack_v;
      v8::Local<v8::String> stack_key =
          v8::String::NewFromUtf8Literal(isolate, "stack");
      if (obj->Get(context, stack_key).ToLocal(&stack_v) &&
          stack_v->IsString()) {
        v8::String::Utf8Value stack(isolate, stack_v);
        if (*stack) std::fprintf(stderr, "[rune-node]   %s\n", *stack);
      }
    }
    return RUNE_NODE_ERR;
  }
  return RUNE_NODE_OK;
}

int rune_node_load_script(RuneNode* rn, const char* path, const char* source) {
  if (!rn || !rn->bootstrapped) return RUNE_NODE_NOT_INITIALIZED;
  if (!path) return RUNE_NODE_ERR;
  (void)source;  // Node's loader reads the file itself; source is ignored.

  v8::Isolate* isolate = rn->setup->isolate();
  v8::Locker locker(isolate);
  v8::Isolate::Scope iscope(isolate);
  v8::HandleScope hscope(isolate);
  v8::Local<v8::Context> context = rn->setup->context();
  v8::Context::Scope cscope(context);
  v8::TryCatch try_catch(isolate);

  // Look up the bootstrap-installed __rune_load_script helper.
  v8::Local<v8::Object> global = context->Global();
  v8::Local<v8::String> loader_key =
      v8::String::NewFromUtf8Literal(isolate, "__rune_load_script");
  v8::Local<v8::Value> loader_v;
  if (!global->Get(context, loader_key).ToLocal(&loader_v) ||
      !loader_v->IsFunction()) {
    std::fprintf(stderr,
                 "[rune-node] __rune_load_script not installed by bootstrap\n");
    return RUNE_NODE_ERR;
  }
  v8::Local<v8::Function> loader = loader_v.As<v8::Function>();

  v8::Local<v8::String> path_v;
  if (!v8::String::NewFromUtf8(isolate, path).ToLocal(&path_v)) {
    return RUNE_NODE_ERR;
  }
  v8::Local<v8::Value> args[] = {path_v};
  v8::Local<v8::Value> result;
  if (!loader->Call(context, global, 1, args).ToLocal(&result)) {
    ReportException(isolate, context, &try_catch, "load_script call");
    return RUNE_NODE_ERR;
  }
  if (!result->IsPromise()) {
    // __rune_load_script is async so should always return a promise. If it
    // doesn't, the user replaced it -- treat the sync return as success.
    return RUNE_NODE_OK;
  }
  return AwaitPromise(rn, isolate, context, result.As<v8::Promise>(),
                      "load_script", /* timeout_ms */ 30000);
}

int rune_node_tick(RuneNode* rn, int budget_ms) {
  if (!rn || !rn->setup) return RUNE_NODE_NOT_INITIALIZED;

  v8::Isolate* isolate = rn->setup->isolate();
  v8::Locker locker(isolate);
  v8::Isolate::Scope iscope(isolate);
  v8::HandleScope hscope(isolate);
  v8::Context::Scope cscope(rn->setup->context());

  // Time-budgeted loop: run uv work + microtasks repeatedly until either
  // the loop is idle or the deadline passes. With Paper at 20 TPS, a 5ms
  // budget gives async work ~100ms/sec on the main thread.
  const int budget = budget_ms > 0 ? budget_ms : 5;
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::milliseconds(budget);
  uv_loop_t* loop = rn->setup->event_loop();
  do {
    uv_run(loop, UV_RUN_NOWAIT);
    isolate->PerformMicrotaskCheckpoint();
    if (uv_loop_alive(loop) == 0) break;
  } while (std::chrono::steady_clock::now() < deadline);
  return RUNE_NODE_OK;
}

int rune_node_dispatch_event(RuneNode* rn,
                             const char* name,
                             const uint8_t* payload,
                             size_t len) {
  if (!rn || !rn->bootstrapped) return RUNE_NODE_NOT_INITIALIZED;
  if (!name) return RUNE_NODE_ERR;
  if (rn->dispatch_fn.IsEmpty()) return RUNE_NODE_ERR;

  v8::Isolate* isolate = rn->setup->isolate();
  v8::Locker locker(isolate);
  v8::Isolate::Scope iscope(isolate);
  v8::HandleScope hscope(isolate);
  v8::Local<v8::Context> context = rn->setup->context();
  v8::Context::Scope cscope(context);
  v8::TryCatch try_catch(isolate);

  v8::Local<v8::Function> dispatch = rn->dispatch_fn.Get(isolate);

  v8::Local<v8::String> name_v;
  if (!v8::String::NewFromUtf8(isolate, name).ToLocal(&name_v)) {
    return RUNE_NODE_ERR;
  }

  v8::Local<v8::Value> payload_v;
  if (payload && len > 0) {
    std::unique_ptr<v8::BackingStore> store =
        v8::ArrayBuffer::NewBackingStore(isolate, len);
    std::memcpy(store->Data(), payload, len);
    v8::Local<v8::ArrayBuffer> ab =
        v8::ArrayBuffer::New(isolate, std::move(store));
    payload_v = v8::Uint8Array::New(ab, 0, len);
  } else {
    payload_v = v8::Null(isolate);
  }

  v8::Local<v8::Value> args[] = {name_v, payload_v};
  v8::MaybeLocal<v8::Value> result =
      dispatch->Call(context, context->Global(), 2, args);
  if (result.IsEmpty()) {
    ReportException(isolate, context, &try_catch, "dispatch");
    return RUNE_NODE_ERR;
  }
  return RUNE_NODE_OK;
}

void rune_node_set_query_callback(RuneNode* rn, rune_query_callback cb) {
  if (!rn) return;
  rn->query_cb = cb;
}

ptrdiff_t rune_node_drain_commands(RuneNode* rn, uint8_t* out, size_t cap) {
  if (!rn) return -2;
  if (!out && cap > 0) return -2;

  // Re-serve a parked payload from a previous "buffer too small" call
  // before draining anything new -- commands must never be lost.
  if (!rn->parked_drain.empty()) {
    const size_t n = rn->parked_drain.size();
    if (n > cap) return -1;
    std::memcpy(out, rn->parked_drain.data(), n);
    rn->parked_drain.clear();
    return static_cast<ptrdiff_t>(n);
  }

  std::vector<std::vector<uint8_t>> drained;
  {
    std::lock_guard<std::mutex> lock(rn->commands_mu);
    drained.swap(rn->pending_commands);
  }
  if (drained.empty()) return 0;

  std::vector<uint8_t> encoded;
  cbor_array_header(encoded, drained.size());
  for (auto& cmd : drained) {
    encoded.insert(encoded.end(), cmd.begin(), cmd.end());
  }

  if (encoded.size() > cap) {
    rn->parked_drain = std::move(encoded);
    return -1;
  }
  std::memcpy(out, encoded.data(), encoded.size());
  return static_cast<ptrdiff_t>(encoded.size());
}

}  // extern "C"
