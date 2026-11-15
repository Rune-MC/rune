//! `rune update-cli` — self-update the `rune` binary from GitHub Releases.
//!
//! Flow:
//!   1. Ask the GitHub Releases API for `Rune-MC/rune`'s latest tag.
//!   2. Strip the leading `v` and semver-compare to our compiled-in
//!      `CARGO_PKG_VERSION`. If we're already at or above latest, exit.
//!   3. Pick the platform asset (`rune-cli-<version>-<platform>{.exe}`)
//!      matching the host (windows-x64 / linux-x64 / macos-arm64).
//!   4. Download to a sibling temp file, atomic-rename into place.
//!      On Windows, where you can't overwrite a running exe, we first
//!      move the current binary to `<exe>.old` (Windows DOES allow
//!      renaming a running executable), then move the new file into
//!      place. The `.old` cleanup is the user's next reboot or a manual
//!      delete.
//!
//! Same install-shape semantics as the public install.{ps1,sh} scripts;
//! this is just the in-place upgrade path for users who've already got
//! the CLI on PATH.

use std::path::Path;

use anyhow::{Context, Result};
use console::style;
use semver::Version;

use crate::cli::UpdateCliArgs;

use super::release;
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn run(args: UpdateCliArgs) -> Result<()> {
    let platform = release::platform()?;
    let installed = Version::parse(CURRENT_VERSION).with_context(|| {
        format!("CARGO_PKG_VERSION {CURRENT_VERSION} is not valid semver — build bug")
    })?;

    println!(
        "{} latest rune-cli release from {}",
        style("Checking").cyan().bold(),
        style(format!("github.com/{}", release::REPO)).dim(),
    );

    let release = release::fetch(None).await?;
    let tag = release.version();
    let latest = Version::parse(tag)
        .with_context(|| format!("release tag {:?} is not valid semver", release.tag_name))?;

    println!(
        "  {} {}    {} {}",
        style("installed:").dim(),
        style(format!("v{installed}")).bold(),
        style("latest:").dim(),
        style(format!("v{latest}")).bold(),
    );

    if latest <= installed {
        println!(
            "{} you're already on the latest release.",
            style("✓").green().bold()
        );
        return Ok(());
    }

    if args.check {
        println!(
            "  {} update available — run `rune update-cli` without --check to apply.",
            style("note:").yellow(),
        );
        return Ok(());
    }

    let asset_name = format!("rune-cli-{tag}-{platform}{}", std::env::consts::EXE_SUFFIX);
    let asset = release.asset(&asset_name)?;
    let current_exe = std::env::current_exe().context("locating current rune binary")?;
    let parent = current_exe.parent().context("rune binary has no parent directory")?;
    let stage = tempfile::Builder::new().prefix(".rune-update-").tempdir_in(parent)?;
    let download_to = stage.path().join(&asset_name);

    println!(
        "{} {} ({:.1} MB)",
        style("Downloading").cyan().bold(),
        asset_name,
        asset.size as f64 / (1024.0 * 1024.0),
    );

    asset.download(&download_to).await?;

    // Make the downloaded blob executable on Unix; on Windows the .exe
    // extension itself signals executable, no chmod equivalent needed.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&download_to, std::fs::Permissions::from_mode(0o755))
            .with_context(|| format!("chmod +x {}", download_to.display()))?;
    }

    install_in_place(&current_exe, &download_to).with_context(|| {
        format!("replacing {} with the new binary", current_exe.display())
    })?;

    println!(
        "{} {} {} {}",
        style("✓").green().bold(),
        style("Updated").green().bold(),
        format!("v{installed} → v{latest}"),
        style(format!("({})", current_exe.display())).dim(),
    );
    if cfg!(windows) {
        let old = current_exe.with_extension("old");
        if old.exists() {
            println!(
                "  {} previous binary moved to {}. Delete it after confirming the new build works.",
                style("note:").dim(),
                old.display(),
            );
        }
    }
    Ok(())
}

/// Atomic-ish swap of the live binary on disk. On Unix it's a single
/// `rename` and the running process keeps executing from its own inode.
/// On Windows we first rename the live exe out of the way (allowed even
/// while running) and then rename the new file in.
fn install_in_place(current_exe: &Path, new_file: &Path) -> Result<()> {
    if cfg!(windows) {
        let backup = current_exe.with_extension("old");
        // Clean up any stale .old from a prior upgrade so this rename
        // doesn't trip over a leftover file.
        if backup.exists() {
            let _ = std::fs::remove_file(&backup);
        }
        std::fs::rename(current_exe, &backup)
            .with_context(|| format!("moving {} to {}", current_exe.display(), backup.display()))?;
        if let Err(error) = std::fs::rename(new_file, current_exe) {
            std::fs::rename(&backup, current_exe).with_context(|| {
                format!("install failed ({error}); restore the previous binary at {}", backup.display())
            })?;
            return Err(error.into());
        }
    } else {
        std::fs::rename(new_file, current_exe)
            .with_context(|| format!("moving {} to {}", new_file.display(), current_exe.display()))?;
    }
    Ok(())
}
