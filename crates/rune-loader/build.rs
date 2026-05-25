fn main() {
    // V8 (pulled via deno_core) ships ICU, whose Windows timezone code calls
    // RegOpenKeyExW / RegQueryValueExW (advapi32). The v8 crate doesn't emit
    // these link directives itself in 0.101, so as the leaf cdylib we declare
    // them here.
    #[cfg(target_os = "windows")]
    {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
