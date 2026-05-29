//! `rune update` — bring every installed Rune up to its registry-latest.
//!
//! Flow:
//!   1. Resolve the scripts dir the same way `add` / `remove` do.
//!   2. Enumerate immediate subdirs that carry a `.rune-install.json`
//!      lockfile — that's our marker for "this folder was installed by
//!      the CLI". Hand-edited scripts (no lockfile) are skipped.
//!   3. For each candidate, ask the registry for the latest version of
//!      that rune. If it's newer than the lockfile's `version`, replay
//!      the full install through `add::install` with `force = true`.
//!   4. Print a compact summary at the end: counts of updated /
//!      already-current / failed.
//!
//! Versions are compared with semver — string compare would let "0.1.10"
//! lose to "0.1.2". The npm-deps install at the end of each update runs
//! through the same pkg_manager helper `rune add` uses.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result, anyhow};
use console::style;
use semver::Version;

use crate::cli::UpdateArgs;
use crate::commands::{add, install_dir};
use crate::registry::Client;

pub async fn run(args: UpdateArgs) -> Result<()> {
    let scripts_dir = install_dir::resolve(args.scripts.as_deref())?;
    let client = Arc::new(Client::new(args.registry.clone(), String::new())?);

    let candidates = collect_installed(&scripts_dir)?;
    if candidates.is_empty() {
        println!(
            "{} no installed Runes under {}",
            style("•").dim(),
            scripts_dir.display(),
        );
        return Ok(());
    }

    println!(
        "{} {} installed Rune{} in {}",
        style("Checking").cyan().bold(),
        candidates.len(),
        if candidates.len() == 1 { "" } else { "s" },
        style(scripts_dir.display().to_string()).dim(),
    );

    let mut updated = 0usize;
    let mut current = 0usize;
    let mut failed = 0usize;

    for (target_dir, lock) in candidates {
        // The name filter — when set, skip everything else and surface
        // a clear error if the requested rune isn't installed (the
        // loop iteration will print nothing for unrelated entries).
        if let Some(filter) = &args.name {
            if &lock.name != filter && install_dir::dir_name(&lock.name).as_str() != filter.as_str() {
                continue;
            }
        }

        match update_one(&client, &target_dir, &lock, &args.registry).await {
            Ok(UpdateOutcome::Updated { from, to }) => {
                println!(
                    "  {} {} {} {} {}",
                    style("✓").green().bold(),
                    lock.name,
                    style(from).dim(),
                    style("→").dim(),
                    style(to).green().bold(),
                );
                updated += 1;
            }
            Ok(UpdateOutcome::Current { version }) => {
                println!(
                    "  {} {} {} {}",
                    style("·").dim(),
                    lock.name,
                    style(format!("v{version}")).dim(),
                    style("up to date").dim(),
                );
                current += 1;
            }
            Err(e) => {
                println!(
                    "  {} {}: {}",
                    style("✗").red().bold(),
                    lock.name,
                    e,
                );
                failed += 1;
            }
        }
    }

    if args.name.is_some() && updated + current + failed == 0 {
        anyhow::bail!(
            "no installed Rune matched {:?} under {}",
            args.name.as_deref().unwrap_or(""),
            scripts_dir.display(),
        );
    }

    println!();
    println!(
        "{} {} updated, {} current, {} failed",
        style("Summary:").bold(),
        style(updated).green().bold(),
        style(current).dim(),
        if failed > 0 {
            style(failed).red().bold()
        } else {
            style(failed).dim()
        },
    );
    if updated > 0 {
        println!(
            "  {} restart your server (or `/rune reload`) to pick up the new code.",
            style("next:").dim(),
        );
    }
    Ok(())
}

enum UpdateOutcome {
    Updated { from: String, to: String },
    Current { version: String },
}

async fn update_one(
    client: &Arc<Client>,
    target_dir: &std::path::Path,
    lock: &install_dir::InstallLock,
    registry: &url::Url,
) -> Result<UpdateOutcome> {
    let summary = client
        .get_rune(&lock.name)
        .await
        .with_context(|| format!("looking up {}", lock.name))?;

    let latest = summary
        .latest_version
        .ok_or_else(|| anyhow!("registry has no released versions for {}", lock.name))?;

    // Semver-aware compare so 0.1.10 doesn't lose to 0.1.2 the way a
    // raw string compare would. Pre-release tags are respected.
    let installed_v = Version::parse(&lock.version).with_context(|| {
        format!(
            "lockfile {} version is not valid semver: {}",
            install_dir::LOCKFILE,
            lock.version
        )
    })?;
    let latest_v = Version::parse(&latest)
        .with_context(|| format!("registry returned non-semver version {latest:?}"))?;

    if latest_v <= installed_v {
        return Ok(UpdateOutcome::Current { version: lock.version.clone() });
    }

    // Replay the full install flow with --force, including npm install.
    add::install(client, &lock.name, &latest, target_dir, registry, true).await?;

    Ok(UpdateOutcome::Updated {
        from: format!("v{}", lock.version),
        to: format!("v{latest}"),
    })
}

/// Walk every immediate subdir of `scripts_dir` and collect the ones
/// that carry a CLI-written lockfile. We only consider direct children;
/// nested installs (a script that contains another script's source) are
/// out of scope for v1.
fn collect_installed(
    scripts_dir: &std::path::Path,
) -> Result<Vec<(PathBuf, install_dir::InstallLock)>> {
    let mut out: Vec<(PathBuf, install_dir::InstallLock)> = Vec::new();
    let entries = std::fs::read_dir(scripts_dir)
        .with_context(|| format!("reading {}", scripts_dir.display()))?;
    for entry in entries {
        let entry = entry.with_context(|| format!("iterating {}", scripts_dir.display()))?;
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let dir = entry.path();
        if let Some(lock) = install_dir::read_lock(&dir)? {
            out.push((dir, lock));
        }
    }
    // Deterministic order for human-readable output.
    out.sort_by(|a, b| a.1.name.cmp(&b.1.name));
    Ok(out)
}
