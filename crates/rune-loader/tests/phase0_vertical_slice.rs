//! End-to-end test of the Phase 0 acceptance criterion ("join the server, see
//! a broadcast from a .js file") with the Bukkit half stubbed.
//!
//! Drives the rune-loader C ABI in-process via the rlib facet of the crate.
//! This does NOT exercise the actual cdylib link surface that Kotlin uses;
//! that path is validated by the Kotlin plugin's runtime smoke test instead.
//! Both paths share the same function bodies, so this test is sufficient to
//! catch logic regressions in the loader, the JS backend, and CBOR encoding.

use std::ffi::CString;
use std::fs;
use std::path::Path;

use ciborium::value::Value;
use rune_host_api::HostCommand;
use rune_loader::{
    rune_dispatch_event, rune_drain_commands, rune_init, rune_load_script, rune_shutdown,
    rune_tick,
};

/// Build a CBOR map payload from `(key, string_value)` pairs.
fn cbor_string_map(pairs: &[(&str, &str)]) -> Vec<u8> {
    let value = Value::Map(
        pairs
            .iter()
            .map(|(k, v)| (Value::Text((*k).into()), Value::Text((*v).into())))
            .collect(),
    );
    let mut buf = Vec::with_capacity(64);
    ciborium::into_writer(&value, &mut buf).expect("encode cbor map");
    buf
}

/// Loads `script_path` into a fresh runtime, dispatches a `PlayerJoinEvent`
/// for `player_name`, and asserts the runtime emits exactly one Broadcast
/// matching `expected_message`.
fn drive_join_test(script_path: &Path, player_name: &str, expected_message: &str) {
    unsafe {
        let scripts_root_c =
            CString::new(script_path.parent().unwrap().to_string_lossy().as_bytes()).unwrap();
        let loader = rune_init(scripts_root_c.as_ptr());
        assert!(!loader.is_null(), "rune_init returned null");

        let c_path = CString::new(script_path.to_string_lossy().as_bytes()).unwrap();
        let rc = rune_load_script(loader, c_path.as_ptr());
        assert_eq!(rc, 0, "load_script returned {rc}");

        let cbor = cbor_string_map(&[("name", player_name)]);
        let c_name = CString::new("PlayerJoinEvent").unwrap();
        let rc = rune_dispatch_event(loader, c_name.as_ptr(), cbor.as_ptr(), cbor.len());
        assert_eq!(rc, 0, "dispatch_event returned {rc}");

        rune_tick(loader);

        let mut buf = vec![0u8; 8192];
        let n = rune_drain_commands(loader, buf.as_mut_ptr(), buf.len());
        assert!(n > 0, "expected drained commands, got {n}");
        let n = n as usize;

        let commands: Vec<HostCommand> =
            ciborium::from_reader(&buf[..n]).expect("decode commands");
        // Find the broadcast (the script may also emit a log command first).
        let broadcast = commands.iter().find_map(|c| match c {
            HostCommand::Broadcast { message } => Some(message.as_str()),
            _ => None,
        });
        assert_eq!(
            broadcast,
            Some(expected_message),
            "expected Broadcast in {commands:?}"
        );

        let n = rune_drain_commands(loader, buf.as_mut_ptr(), buf.len());
        assert_eq!(n, 0, "expected empty drain on second call, got {n}");

        rune_shutdown(loader);
    }
}

#[test]
fn js_join_event_broadcasts() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let script_path = tmp.path().join("welcome.js");
    fs::write(
        &script_path,
        r#"
        rune.on('PlayerJoinEvent', (e) => {
            rune.broadcast(`welcome ${e.name}`);
        });
        "#,
    )
    .expect("write script");

    drive_join_test(&script_path, "Test", "welcome Test");
}

#[test]
fn folder_script_with_relative_import() {
    let tmp = tempfile::tempdir().expect("tempdir");
    let folder = tmp.path().join("welcome");
    std::fs::create_dir(&folder).expect("create welcome/");

    std::fs::write(
        folder.join("greeter.ts"),
        r#"
        export function greet(name: string): string {
            return `hello from greeter, ${name}!`;
        }
        "#,
    )
    .expect("write greeter.ts");

    let index_path = folder.join("index.ts");
    std::fs::write(
        &index_path,
        r#"
        import { greet } from './greeter.ts';
        rune.on('PlayerJoinEvent', (e: { name: string }) => {
            rune.broadcast(greet(e.name));
        });
        "#,
    )
    .expect("write index.ts");

    drive_join_test(&index_path, "Alice", "hello from greeter, Alice!");
}

#[test]
fn folder_script_via_directory_path() {
    // Same as folder_script_with_relative_import but loads via the FOLDER
    // path (not index.ts directly) so the FS-completion that promotes a
    // folder to its index entry is exercised.
    let tmp = tempfile::tempdir().expect("tempdir");
    let folder = tmp.path().join("welcome");
    std::fs::create_dir(&folder).expect("create welcome/");
    std::fs::write(
        folder.join("index.ts"),
        r#"
        rune.on('PlayerJoinEvent', (e: { name: string }) => {
            rune.broadcast(`hi ${e.name}`);
        });
        "#,
    )
    .expect("write index.ts");

    drive_join_test(&folder, "Bob", "hi Bob");
}

#[test]
fn ts_join_event_broadcasts() {
    // Same handler shape but with TypeScript type annotations and an
    // interface declaration -- exercises the deno_ast transpile path.
    let tmp = tempfile::tempdir().expect("tempdir");
    let script_path = tmp.path().join("welcome.ts");
    fs::write(
        &script_path,
        r#"
        interface JoinEvent {
            name: string;
        }
        rune.on('PlayerJoinEvent', (e: JoinEvent): void => {
            const greeting: string = `hello ${e.name}`;
            rune.broadcast(greeting);
        });
        "#,
    )
    .expect("write script");

    drive_join_test(&script_path, "TypeScripter", "hello TypeScripter");
}
