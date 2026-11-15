use std::path::Path;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

pub const REPO: &str = "Rune-MC/rune";
const USER_AGENT: &str = concat!("rune-cli/", env!("CARGO_PKG_VERSION"));
pub const PLATFORMS: &[&str] = &["windows-x64", "linux-x64", "macos-arm64"];

pub fn platform() -> Result<&'static str> {
    use std::env::consts::{ARCH, OS};
    match (OS, ARCH) {
        ("windows", "x86_64") => Ok("windows-x64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        ("macos", "aarch64") => Ok("macos-arm64"),
        _ => bail!("Rune has no prebuilt releases for {OS}/{ARCH}"),
    }
}

#[derive(Deserialize)]
pub struct Release {
    pub tag_name: String,
    assets: Vec<Asset>,
}

impl Release {
    pub fn version(&self) -> &str {
        self.tag_name.trim_start_matches('v')
    }

    pub fn asset(&self, name: &str) -> Result<&Asset> {
        self.assets
            .iter()
            .find(|asset| asset.name == name)
            .with_context(|| format!("release {} has no asset named {name}", self.tag_name))
    }
}

#[derive(Deserialize)]
pub struct Asset {
    pub name: String,
    browser_download_url: String,
    pub size: u64,
    digest: Option<String>,
}

impl Asset {
    pub async fn download(&self, dest: &Path) -> Result<()> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(300))
            .user_agent(USER_AGENT)
            .build()?;
        let mut response = client
            .get(&self.browser_download_url)
            .send()
            .await
            .with_context(|| format!("downloading {}", self.name))?
            .error_for_status()?;
        let mut file = tokio::fs::File::create(dest).await?;
        let mut hash = Sha256::new();
        let mut bytes = 0;
        while let Some(chunk) = response.chunk().await? {
            bytes += chunk.len() as u64;
            ensure!(bytes <= self.size, "{} exceeds its release size", self.name);
            file.write_all(&chunk).await?;
            hash.update(&chunk);
        }
        file.flush().await?;
        ensure!(
            bytes > 0 && bytes == self.size,
            "{} did not match its release size",
            self.name
        );
        if let Some(expected) = &self.digest {
            let actual = format!("sha256:{:x}", hash.finalize());
            ensure!(
                &actual == expected,
                "{} did not match its release checksum",
                self.name
            );
        }
        Ok(())
    }
}

pub async fn fetch(tag: Option<&str>) -> Result<Release> {
    let path = if let Some(tag) = tag {
        let version = semver::Version::parse(tag.strip_prefix('v').unwrap_or(tag))
            .with_context(|| format!("invalid release tag {tag:?}; use a tag like v0.4.4"))?;
        let tag = format!("v{version}");
        let encoded: String = url::form_urlencoded::byte_serialize(tag.as_bytes()).collect();
        format!("tags/{encoded}")
    } else {
        "latest".to_owned()
    };
    let url = format!("https://api.github.com/repos/{REPO}/releases/{path}");
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(USER_AGENT)
        .build()?;
    let release: Release = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "application/vnd.github+json")
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .with_context(|| format!("fetching Rune release from {url}"))?
        .json()
        .await
        .context("decoding GitHub release")?;
    semver::Version::parse(release.version()).context("invalid Rune release version")?;
    Ok(release)
}
