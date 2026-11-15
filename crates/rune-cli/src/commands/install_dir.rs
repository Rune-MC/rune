//! Shared helpers for `rune add` / `rune remove`.
//!
//! Both commands need to (a) figure out where the server's
//! `plugins/Rune/scripts/` directory is and (b) read/write the
//! per-install metadata file we drop in alongside the installed source.

use std::path::{Path, PathBuf};
use std::fs::{File, OpenOptions};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

use crate::cli::ScriptsArgs;

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
///   2. Look for `plugins/Rune/scripts/` from the current directory and
///      its parents, including when running inside an installed Rune.
pub fn resolve(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(p) = explicit {
        return canonicalize_scripts(p);
    }

    let cwd = std::env::current_dir().context("reading current working directory")?;

    for dir in cwd.ancestors() {
        let candidate = dir.join("plugins/Rune/scripts");
        if candidate.is_dir() {
            return Ok(candidate);
        }
        if looks_like_scripts_dir(dir) {
            return Ok(dir.to_path_buf());
        }
    }

    Err(anyhow!(
        "couldn't find a Rune scripts folder. Pass --scripts <path>, set RUNE_SCRIPTS, \n\
         or cd into your server root (the folder that contains plugins/Rune/scripts/)."
    ))
}

fn canonicalize_scripts(p: &Path) -> Result<PathBuf> {
    let dir = std::path::absolute(p)?;
    if !dir.is_dir() {
        return Err(anyhow!("scripts path is not a directory: {}", p.display()));
    }
    if looks_like_scripts_dir(&dir) {
        return Ok(dir);
    }
    let nested = dir.join("plugins/Rune/scripts");
    if nested.is_dir() {
        return Ok(nested);
    }
    Err(anyhow!(
        "{} is neither a Rune scripts folder nor a server root containing one",
        p.display()
    ))
}

pub fn list(args: ScriptsArgs) -> Result<()> {
    let scripts = resolve(args.scripts.as_deref())?;
    let installs = collect_installed(&scripts)?;
    if installs.is_empty() {
        println!("No Runebook packages installed in {}", scripts.display());
    }
    for (_, lock) in installs {
        println!("{}\t{}\t{}", lock.name, lock.version, lock.registry);
    }
    Ok(())
}

pub fn collect_installed(scripts_dir: &Path) -> Result<Vec<(PathBuf, InstallLock)>> {
    let mut installs = Vec::new();
    let entries = std::fs::read_dir(scripts_dir)
        .with_context(|| format!("reading {}", scripts_dir.display()))?;
    for entry in entries {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let dir = entry.path();
        if let Some(lock) = read_lock(&dir)? {
            installs.push((dir, lock));
        }
    }
    installs.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    Ok(installs)
}

/// Serialize changes to one scripts folder across CLI processes. Keep the
/// lock file on disk so all contenders lock the same file.
pub fn lock_directory(dir: &Path) -> Result<File> {
    let path = dir.join(".rune-cli.lock");
    let file = OpenOptions::new().write(true).create(true).truncate(false).open(&path)
        .with_context(|| format!("opening {}", path.display()))?;
    file.try_lock().with_context(|| format!("locking {} (another Rune command may be running)", path.display()))?;
    Ok(file)
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

/// The on-disk directory name for a given canonical rune name.
///
/// Scoped names (`@scope/pkg`) flatten to `@scope-pkg/` so every install
/// lives as a single top-level folder under `scripts/`. We deliberately
/// avoid the literal `@scope/pkg/` layout — it would force a nested
/// directory (and Rune's loader would treat the `@scope` parent as a
/// folder-script with no entry, producing noise on enable).
pub fn dir_name(canonical: &str) -> String {
    if let Some((scope, base)) = canonical.split_once('/') {
        format!("{scope}-{base}")
    } else {
        canonical.to_string()
    }
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
