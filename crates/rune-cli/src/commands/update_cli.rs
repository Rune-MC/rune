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
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use console::style;
use reqwest::header::{ACCEPT, HeaderMap, HeaderValue, USER_AGENT};
use semver::Version;
use serde::Deserialize;

use crate::cli::UpdateCliArgs;

const GITHUB_REPO: &str = "Rune-MC/rune";
const UA: &str = concat!("rune-cli/", env!("CARGO_PKG_VERSION"));
const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

pub async fn run(args: UpdateCliArgs) -> Result<()> {
    let platform = detect_platform()?;
    let installed = Version::parse(CURRENT_VERSION).with_context(|| {
        format!("CARGO_PKG_VERSION {CURRENT_VERSION} is not valid semver — build bug")
    })?;

    println!(
        "{} latest rune-cli release from {}",
        style("Checking").cyan().bold(),
        style(format!("github.com/{GITHUB_REPO}")).dim(),
    );

    let release = fetch_latest_release().await?;
    let tag = release.tag_name.trim_start_matches('v').to_string();
    let latest = Version::parse(&tag)
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

    let asset_name = format!(
        "rune-cli-{}-{}{}",
        tag,
        platform.suffix,
        if platform.exe { ".exe" } else { "" }
    );
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == asset_name)
        .ok_or_else(|| {
            anyhow!(
                "release v{tag} has no asset named {asset_name}. Available: {}",
                release
                    .assets
                    .iter()
                    .map(|a| a.name.as_str())
                    .filter(|n| n.starts_with("rune-cli-"))
                    .collect::<Vec<_>>()
                    .join(", "),
            )
        })?;

    let current_exe = std::env::current_exe().context("locating current rune binary")?;
    let download_to = current_exe.with_extension("download");

    println!(
        "{} {} ({:.1} MB)",
        style("Downloading").cyan().bold(),
        asset_name,
        asset.size as f64 / (1024.0 * 1024.0),
    );

    download_to_file(&asset.browser_download_url, &download_to)
        .await
        .with_context(|| format!("downloading {} to {}", asset.browser_download_url, download_to.display()))?;

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
        std::fs::rename(new_file, current_exe)
            .with_context(|| format!("moving {} to {}", new_file.display(), current_exe.display()))?;
    } else {
        std::fs::rename(new_file, current_exe)
            .with_context(|| format!("moving {} to {}", new_file.display(), current_exe.display()))?;
    }
    Ok(())
}

async fn fetch_latest_release() -> Result<GhRelease> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    headers.insert(ACCEPT, HeaderValue::from_static("application/vnd.github+json"));
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .default_headers(headers)
        .build()
        .context("building HTTP client")?;
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases/latest");
    let resp = http
        .get(&url)
        .send()
        .await
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("GitHub returned {status}: {body}");
    }
    Ok(resp.json::<GhRelease>().await.context("decoding release JSON")?)
}

async fn download_to_file(url: &str, dest: &Path) -> Result<()> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(UA));
    let http = reqwest::Client::builder()
        // Big enough to fetch a ~10 MB binary on a slow connection.
        .timeout(Duration::from_secs(120))
        .default_headers(headers)
        .build()
        .context("building HTTP client")?;
    let resp = http.get(url).send().await.context("starting download")?;
    if !resp.status().is_success() {
        bail!("download returned {}", resp.status());
    }
    let bytes = resp.bytes().await.context("reading download body")?;
    std::fs::write(dest, &bytes)
        .with_context(|| format!("writing {}", dest.display()))?;
    Ok(())
}

struct Platform {
    suffix: &'static str,
    exe: bool,
}

/// Match the platform-suffix scheme used by release.yml: `windows-x64`,
/// `linux-x64`, `macos-arm64`. Anything else: fail with a clear pointer
/// — we don't ship binaries for it.
fn detect_platform() -> Result<Platform> {
    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    match (os, arch) {
        ("windows", "x86_64") => Ok(Platform { suffix: "windows-x64", exe: true }),
        ("linux", "x86_64") => Ok(Platform { suffix: "linux-x64", exe: false }),
        ("macos", "aarch64") => Ok(Platform { suffix: "macos-arm64", exe: false }),
        _ => bail!(
            "no prebuilt rune-cli for {os}/{arch}. \
             Open an issue at https://github.com/{GITHUB_REPO}/issues if you want it added."
        ),
    }
}

#[derive(Debug, Deserialize)]
struct GhRelease {
    tag_name: String,
    assets: Vec<GhAsset>,
}

#[derive(Debug, Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
    size: u64,
}

