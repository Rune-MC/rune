//! Shared helpers for `rune add` / `rune remove`.
//!
//! Both commands need to (a) figure out where the server's
//! `plugins/Rune/scripts/` directory is and (b) read/write the
//! per-install metadata file we drop in alongside the installed source.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

/// Filename used as the install marker / lockfile inside every Rune we
/// own on disk. Its presence tells `rune remove` "yes, this directory
/// was installed by the CLI and you may delete it"; its absence makes
/// us refuse so we don't blow away a hand-edited script of the same
/// name.
pub const LOCKFILE: &str = ".rune-install.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallLock {
    /// Canonical name on the registry, including `@scope/` if any. The
    /// install dir on disk is the unscoped basename; this field is the
    /// only place we remember the full identity.
    pub name: String,
    pub version: String,
    pub manifest_hash: String,
    pub registry: String,
    pub installed_at: String,
}

/// Resolve the server's `plugins/Rune/scripts/` directory.
///
/// Order:
///   1. Explicit `--scripts <path>` / `RUNE_SCRIPTS` env. If the user
///      pointed us straight at a `scripts` dir, use it; if they pointed
///      at a server root, descend into `plugins/Rune/scripts`.
///   2. Current dir contains `plugins/Rune/scripts/` → use that.
///   3. Current dir already IS a `plugins/Rune/scripts/` (basename
///      checks). The runtime puts every installed script inside one of
///      these, so it's a common cwd.
///   4. Otherwise error with a friendly hint.
pub fn resolve(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return canonicalize_scripts(p);
    }

    let cwd = std::env::current_dir().context("reading current working directory")?;

    let candidate = cwd.join("plugins").join("Rune").join("scripts");
    if candidate.is_dir() {
        return Ok(candidate);
    }
    if looks_like_scripts_dir(&cwd) {
        return Ok(cwd);
    }

    Err(anyhow!(
        "couldn't find a Rune scripts folder. Pass --scripts <path>, set RUNE_SCRIPTS, \n\
         or cd into your server root (the folder that contains plugins/Rune/scripts/)."
    ))
}

fn canonicalize_scripts(p: &Path) -> Result<PathBuf> {
    if !p.exists() {
        return Err(anyhow!(
            "scripts path does not exist: {}",
            p.display()
        ));
    }
    if looks_like_scripts_dir(p) {
        return Ok(p.to_path_buf());
    }
    let nested = p.join("plugins").join("Rune").join("scripts");
    if nested.is_dir() {
        return Ok(nested);
    }
    Err(anyhow!(
        "{} is neither a Rune scripts folder nor a server root containing one",
        p.display()
    ))
}

fn looks_like_scripts_dir(p: &Path) -> bool {
    // …/plugins/Rune/scripts. We only check the last three path
    // components; if the user has reorganised their server layout
    // they can use --scripts to be explicit.
    let mut comps = p.components().rev();
    match (comps.next(), comps.next(), comps.next()) {
        (Some(a), Some(b), Some(c)) => {
            a.as_os_str() == "scripts" && b.as_os_str() == "Rune" && c.as_os_str() == "plugins"
        }
        _ => false,
    }
}

/// The on-disk directory name for a given canonical rune name. Strips
/// the `@scope/` prefix so installs land at `scripts/<basename>/`
/// matching the way authors lay out their source trees.
pub fn dir_name(canonical: &str) -> &str {
    canonical
        .rsplit_once('/')
        .map(|(_, base)| base)
        .unwrap_or(canonical)
}

pub fn read_lock(install_dir: &Path) -> Result<Option<InstallLock>> {
    let path = install_dir.join(LOCKFILE);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let lock: InstallLock = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(Some(lock))
}

pub fn write_lock(install_dir: &Path, lock: &InstallLock) -> Result<()> {
    let path = install_dir.join(LOCKFILE);
    let raw = serde_json::to_string_pretty(lock)?;
    std::fs::write(&path, raw)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}
