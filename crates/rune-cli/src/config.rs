//! Parser + types for the `rune.toml` project manifest.
//!
//! The file is the author-facing source of truth for what a Rune *is*:
//! its name, version, entry point, what files it ships, what capabilities
//! it needs, what other Runes it depends on. The pack pipeline reads it,
//! walks the project per its include/exclude rules, and produces the
//! content-addressed [`crate::manifest::Manifest`] that gets uploaded.
//!
//! Schema is intentionally small. Add fields only when there's a use
//! case the runtime or registry already handles — the registry's
//! manifest validation (Zod schema on the website side) must accept
//! whatever we write here, and that schema is what enforces taste.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

/// The `[package]` table is mandatory; everything else has sane defaults.
///
/// Example:
/// ```toml
/// name    = "@alice/welcome-msg"
/// version = "1.2.0"
/// language = "typescript"
/// entry   = "src/index.ts"
/// description = "Sends a welcome message on player join."
/// license = "MIT"
///
/// [publish]
/// include = ["src/**", "README.md", "LICENSE"]
/// exclude = ["src/**/*.test.ts"]
///
/// [capabilities]
/// required = ["host:bukkit", "host:player.message"]
///
/// [dependencies]
/// "@rune/sdk" = "^0.4.0"
/// ```
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuneToml {
    pub name: String,
    pub version: String,
    pub language: String,
    /// Path to the entry-point source file, relative to `rune.toml`.
    /// Required regardless of language so the runtime knows where to
    /// start loading.
    pub entry: String,

    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub repository: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub authors: Vec<Author>,

    #[serde(default)]
    pub publish: PublishSection,
    #[serde(default)]
    pub capabilities: CapabilitiesSection,
    #[serde(default)]
    pub dependencies: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct Author {
    pub name: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub github: Option<String>,
}

/// Controls what files get packed. The pack pipeline starts from
/// `include` (defaulted to a sensible set), then strips anything matching
/// `exclude` AND anything matching the default-deny list AND anything
/// matching `.runeignore`. Order: include → default-deny → exclude → runeignore.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct PublishSection {
    #[serde(default = "default_includes")]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl Default for PublishSection {
    fn default() -> Self {
        Self { include: default_includes(), exclude: Vec::new() }
    }
}

fn default_includes() -> Vec<String> {
    vec![
        "src/**".into(),
        "rune.toml".into(),
        "README*".into(),
        "LICENSE*".into(),
    ]
}

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
pub struct CapabilitiesSection {
    #[serde(default)]
    pub required: Vec<String>,
}

impl RuneToml {
    /// Find the nearest `rune.toml` walking UP from `start`. Mirrors
    /// `cargo`'s search behaviour so users can run `rune pack` from any
    /// sub-directory of the project.
    pub fn find_root(start: &Path) -> Result<PathBuf> {
        let start = start.canonicalize().with_context(|| {
            format!("project directory does not exist: {}", start.display())
        })?;
        for dir in start.ancestors() {
            let candidate = dir.join("rune.toml");
            if candidate.is_file() {
                return Ok(dir.to_path_buf());
            }
        }
        Err(anyhow!(
            "no rune.toml found in {} or any parent directory",
            start.display()
        ))
    }

    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("rune.toml");
        let raw = std::fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;
        let cfg: Self = toml::from_str(&raw)
            .with_context(|| format!("parsing {}", path.display()))?;
        cfg.validate()?;
        Ok(cfg)
    }

    /// Reject obviously-wrong fields BEFORE the pack pipeline runs, so the
    /// user sees one good error rather than a cryptic downstream one.
    fn validate(&self) -> Result<()> {
        validate_name(&self.name)
            .with_context(|| format!("invalid `name = \"{}\"`", self.name))?;
        semver::Version::parse(&self.version)
            .with_context(|| format!("invalid `version = \"{}\"` (must be semver)", self.version))?;
        if !matches!(self.language.as_str(), "typescript" | "wasm") {
            return Err(anyhow!(
                "invalid `language = \"{}\"` (supported: typescript, wasm)",
                self.language
            ));
        }
        if self.entry.is_empty() {
            return Err(anyhow!("`entry` is required"));
        }
        Ok(())
    }
}

/// `name` rules: `foo-bar`, `@alice/foo-bar`. Lowercase, hyphen, digits,
/// optional scope. Mirrors the website's name validation in SPEC.md §5.
pub fn validate_name(name: &str) -> Result<()> {
    if name.is_empty() {
        return Err(anyhow!("name must not be empty"));
    }
    if name.len() > 128 {
        return Err(anyhow!("name must be at most 128 chars"));
    }
    let (scope, base) = if let Some(rest) = name.strip_prefix('@') {
        let (scope, rest) = rest
            .split_once('/')
            .ok_or_else(|| anyhow!("scoped names must contain `/` (e.g. `@alice/foo`)"))?;
        (Some(scope), rest)
    } else {
        (None, name)
    };
    if let Some(scope) = scope {
        validate_segment(scope, "scope")?;
    }
    validate_segment(base, "name")?;
    Ok(())
}

fn validate_segment(seg: &str, what: &str) -> Result<()> {
    if seg.is_empty() {
        return Err(anyhow!("{what} segment must not be empty"));
    }
    if !seg
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err(anyhow!(
            "{what} segment {seg:?} must be lowercase ASCII letters, digits, `-`, or `_`"
        ));
    }
    if seg.starts_with('-') || seg.starts_with('_') {
        return Err(anyhow!("{what} segment {seg:?} must not start with `-` or `_`"));
    }
    Ok(())
}
