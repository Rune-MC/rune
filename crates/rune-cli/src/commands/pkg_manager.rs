//! Detect and run a JavaScript package manager for installed Runes.
//!
//! Most Runes ship a `package.json` whose `dependencies` describe runtime
//! npm packages (mongoose, zod, etc.) that the Rune Node loader will
//! resolve at script-load. Without those installed on the target server,
//! the script crashes with `Cannot find module 'mongoose'` the first time
//! it runs. So after `rune add` / `rune update` lays the source down, we
//! shell out to whichever package manager the host has.
//!
//! Preference order is bun > pnpm > yarn > npm, with two priors:
//!   1. Speed — bun's install is dramatically faster than the others on
//!      cold caches, pnpm is next, npm is slowest.
//!   2. Disk usage — pnpm's content-addressed store and bun's global
//!      cache mean less duplication across multiple installed Runes.
//!
//! If the package.json has no `dependencies` field (or none of the four
//! managers is on PATH), we no-op — emit a short warning when nothing's
//! available, but don't fail the whole install. Authors who already have
//! `node_modules/` checked in can still use the rune.

use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;
use console::style;

/// Manager names in the order we try them. The first one we find on PATH
/// wins; we never fall through to a slower one if a faster one is present.
const PREFERRED_ORDER: &[&str] = &["bun", "pnpm", "yarn", "npm"];

#[derive(Debug, Clone)]
pub struct PackageManager {
    pub name: &'static str,
    pub path: PathBuf,
}

impl PackageManager {
    /// Build the install command. Every manager spells "install
    /// dependencies from package.json" as `<bin> install` (with bun,
    /// the literal `install` subcommand is what triggers package.json
    /// resolution; bare `bun` would just run a script).
    fn install_command(&self, cwd: &Path) -> Command {
        let mut cmd = Command::new(&self.path);
        cmd.arg("install").current_dir(cwd);
        cmd
    }
}

/// Walk `PATH` (and `PATHEXT` on Windows) looking for the preferred
/// package managers. Returns the first one found, or `None` if none are
/// installed.
pub fn detect() -> Option<PackageManager> {
    for name in PREFERRED_ORDER {
        if let Some(path) = which(name) {
            return Some(PackageManager { name, path });
        }
    }
    None
}

/// Run `<pm> install` in `install_dir` if the directory has a
/// `package.json` with a non-empty `dependencies` (or `devDependencies`)
/// block. Prints a one-line status to stdout either way.
///
/// Returns Ok(()) on success OR on benign skip (no package.json, no PM
/// available). Surfaces errors only when the install command itself
/// exits non-zero — and even then we keep the file install successful;
/// the user can re-run manually.
pub fn maybe_install(install_dir: &Path) -> Result<()> {
    let pkg_path = install_dir.join("package.json");
    if !pkg_path.is_file() {
        return Ok(());
    }
    if !has_runtime_deps(&pkg_path)? {
        // package.json exists but declares nothing to install. Common for
        // pure-typescript Runes whose only dep is the runtime itself.
        return Ok(());
    }

    let Some(pm) = detect() else {
        println!(
            "  {} no package manager found on PATH; install npm deps manually",
            style("warn:").yellow().bold(),
        );
        println!(
            "  {} expected one of: {}",
            style("    ").dim(),
            PREFERRED_ORDER.join(", "),
        );
        return Ok(());
    };

    println!(
        "  {} npm deps with {} {}",
        style("Installing").cyan().bold(),
        style(pm.name).bold(),
        style(format!("({})", pm.path.display())).dim(),
    );

    let mut cmd = pm.install_command(install_dir);
    // Inherit stdio so the user sees the manager's own progress output.
    // Bun + pnpm in particular have tight, fast progress bars; piping them
    // through us would lose that UX.
    let status = cmd.status();
    match status {
        Ok(s) if s.success() => Ok(()),
        Ok(s) => {
            // Don't fail the whole `rune add` — files are already on
            // disk; the user can retry the install manually.
            println!(
                "  {} {} install exited with status {}",
                style("warn:").yellow().bold(),
                pm.name,
                s.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()),
            );
            println!(
                "  {} re-run manually: cd {} && {} install",
                style("    ").dim(),
                install_dir.display(),
                pm.name,
            );
            Ok(())
        }
        Err(e) => {
            println!(
                "  {} couldn't spawn {}: {}",
                style("warn:").yellow().bold(),
                pm.name,
                e,
            );
            Ok(())
        }
    }
}

/// Cheap check: does package.json declare any deps? We don't want to
/// pay the cost of spawning a package manager when there's nothing to
/// install. Uses serde_json since we already pull it in for the manifest.
fn has_runtime_deps(pkg_path: &Path) -> Result<bool> {
    let raw = std::fs::read_to_string(pkg_path)?;
    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        // A malformed package.json shouldn't crash `rune add`; treat as
        // "nothing to install" and let the user notice on first run.
        Err(_) => return Ok(false),
    };
    let has_block = |key: &str| -> bool {
        json.get(key)
            .and_then(|v| v.as_object())
            .map(|m| !m.is_empty())
            .unwrap_or(false)
    };
    Ok(has_block("dependencies") || has_block("devDependencies"))
}

/// Cross-platform `which`. On Unix, walks `PATH` looking for an executable
/// named exactly `name`. On Windows, walks `PATH` × `PATHEXT` — bun ships
/// as `bun.exe`, pnpm as `pnpm.cmd`, yarn as `yarn.cmd`, npm as `npm.cmd`.
/// Rust's std `Command::new(name)` does NOT do PATHEXT resolution on
/// Windows, so we have to look ourselves before spawning.
fn which(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        let raw = std::env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
        raw.split(';')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect()
    } else {
        // On Unix the binary name doesn't carry an extension; checking
        // the bare name once is enough.
        vec![String::new()]
    };
    for dir in std::env::split_paths(&path_var) {
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
