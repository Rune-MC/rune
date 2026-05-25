// build.rs -- compiles the C++ shim against libnode headers and links the
// resulting cdylib against libnode.{lib,dll}.
//
// The path to a built Node source tree is read from RUNE_NODE_ROOT. The
// directory layout we expect:
//   $RUNE_NODE_ROOT/src/                 -- node.h, node_api.h, ...
//   $RUNE_NODE_ROOT/deps/v8/include/     -- v8.h, v8-*.h
//   $RUNE_NODE_ROOT/deps/uv/include/     -- uv.h
//   $RUNE_NODE_ROOT/out/Release/         -- libnode.lib, libnode.dll

use std::env;
use std::path::{Path, PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=shim/rune_node.h");
    println!("cargo:rerun-if-changed=shim/rune_node.cc");
    println!("cargo:rerun-if-env-changed=RUNE_NODE_ROOT");
    println!("cargo:rerun-if-env-changed=RUNE_NODE_VERSION");

    let node_root = resolve_node_root();

    let src_dir = node_root.join("src");
    let v8_inc = node_root.join("deps/v8/include");
    let uv_inc = node_root.join("deps/uv/include");
    let lib_dir = node_root.join("out/Release");

    assert!(
        src_dir.join("node.h").exists(),
        "libnode source not found: {}/src/node.h missing",
        node_root.display()
    );
    assert!(
        lib_dir.join("libnode.lib").exists(),
        "libnode build artifact not found: {}/out/Release/libnode.lib missing",
        node_root.display()
    );

    let mut build = cc::Build::new();
    build
        .cpp(true)
        .file("shim/rune_node.cc")
        .include(&src_dir)
        .include(&v8_inc)
        .include(&uv_inc)
        .include("shim");

    if cfg!(target_env = "msvc") {
        build
            .flag("/std:c++20")
            .flag("/EHsc")
            .define("NOMINMAX", None)
            .define("WIN32_LEAN_AND_MEAN", None)
            // We're a consumer of v8 + libuv compiled into libnode.dll, NOT
            // building our own copy. Without these, v8/uv inline helpers get
            // instantiated locally AND in libnode -> LNK2005 duplicates.
            .define("BUILDING_NODE_EXTENSION", None)
            .define("USING_V8_SHARED", "1")
            .define("USING_UV_SHARED", "1");
        // V8 pointer-compression settings MUST match libnode.dll's build.
        // Node 22 defaults to pointer compression DISABLED (so heaps can
        // exceed 4 GB). If the user built libnode with --experimental-enable-
        // pointer-compression, set RUNE_NODE_V8_PTRCOMP=1 in the env to flip
        // the defines back on -- otherwise V8 aborts in InitializeOncePerProcess
        // with "Embedder-vs-V8 build configuration mismatch".
        if env::var("RUNE_NODE_V8_PTRCOMP").as_deref() == Ok("1") {
            build
                .define("V8_COMPRESS_POINTERS", None)
                .define("V8_31BIT_SMIS_ON_64BIT_ARCH", None);
        }
    } else {
        build.flag("-std=c++20");
    }

    build.compile("rune_node");

    // Tell the linker where libnode.lib lives and to link against it.
    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    println!("cargo:rustc-link-lib=dylib=libnode");

    // V8 headers always emit out-of-line copies of inline methods
    // (Isolate::Enter, TryCatch ctor, etc.) into the consuming object file.
    // libnode.dll also exports those symbols. Allow the linker to pick one
    // -- standard Node-addon-build dance. /IGNORE:4006 suppresses the
    // matching LNK4006 second-definition warnings.
    if cfg!(target_env = "msvc") {
        println!("cargo:rustc-link-arg=/FORCE:MULTIPLE");
        println!("cargo:rustc-link-arg=/IGNORE:4006");
        println!("cargo:rustc-link-arg=/IGNORE:4088");
    }

    // On Windows we also need to copy libnode.dll next to the final cdylib
    // so it loads at runtime. The plugin's NativeLibraryExtractor needs to
    // ship both DLLs in resources/native/<os>-<arch>/.
    println!(
        "cargo:warning=remember to ship {}/libnode.dll alongside rune_loader.dll",
        lib_dir.display()
    );
}

/// Locate a usable libnode tree. Search order:
///   1. `$RUNE_NODE_ROOT` -- explicit override; respected as-is.
///   2. `tools/libnode-cache/v<RUNE_NODE_VERSION>/<host-platform>/`
///      -- populated by `node tools/fetch-libnode.mjs` (the recommended
///      path for contributors who haven't built libnode by hand).
///   3. Hard error with the actionable fix.
fn resolve_node_root() -> PathBuf {
    if let Ok(v) = env::var("RUNE_NODE_ROOT") {
        return PathBuf::from(v);
    }

    let version = env::var("RUNE_NODE_VERSION").unwrap_or_else(|_| "22.18.0".into());
    let platform = detect_host_platform();
    // build.rs lives at crates/rune-runtime-node/build.rs; repo root is two up.
    let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent().and_then(|p| p.parent())
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf();
    let cache = repo_root
        .join("tools")
        .join("libnode-cache")
        .join(format!("v{version}"))
        .join(&platform);
    if cache.join("src/node.h").exists() {
        return cache;
    }

    panic!(
        "rune-runtime-node: no libnode found.\n\
         \n\
         Tried:\n\
         \t1. $RUNE_NODE_ROOT (unset)\n\
         \t2. {cache_display} (missing)\n\
         \n\
         Fix:\n\
         \t* If you have a libnode source tree elsewhere, set\n\
         \t  $env:RUNE_NODE_ROOT = 'C:\\path\\to\\node'\n\
         \t* OR fetch the pre-built tarball with:\n\
         \t  node tools/fetch-libnode.mjs\n\
         \t* OR build libnode from source (slow); see\n\
         \t  https://github.com/nodejs/node/blob/main/BUILDING.md",
        cache_display = cache.display(),
    );
}

fn detect_host_platform() -> String {
    let os = if cfg!(target_os = "windows") { "windows" }
        else if cfg!(target_os = "linux") { "linux" }
        else if cfg!(target_os = "macos") { "macos" }
        else { "unknown" };
    let arch = if cfg!(target_arch = "x86_64") { "x64" }
        else if cfg!(target_arch = "aarch64") { "arm64" }
        else { "unknown" };
    format!("{os}-{arch}")
}
