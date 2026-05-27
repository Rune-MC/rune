//! Manifest types + canonical JSON serialiser.
//!
//! The manifest is the version's identity: `archive_hash =
//! sha256(canonical_json(manifest))`. The registry stores it both in
//! Mongo (for indexing) and in R2 (as `manifests/<hash>` for offline
//! re-verification). Any byte-level disagreement between author, CLI,
//! registry, and runtime produces a different hash and a rejected install.
//!
//! Canonical form: UTF-8, sorted object keys, no trailing whitespace,
//! `\n` line endings, no BOM. See SPEC.md §5.3.

use std::collections::BTreeMap;
use std::path::Path;

use anyhow::Result;
use serde::{Deserialize, Serialize};

use crate::config::{Author, RuneToml};
use crate::hash::Hash;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub name: String,
    pub version: String,
    pub language: String,
    pub entry: String,

    pub files: Vec<FileEntry>,

    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,

    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dependencies: BTreeMap<String, String>,

    pub metadata: Metadata,
    pub compiler: CompilerInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Forward-slash path RELATIVE to the project root. Windows
    /// backslashes are normalised at pack time — the manifest is the
    /// portable cross-platform contract.
    pub path: String,
    pub hash: Hash,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub authors: Vec<Author>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompilerInfo {
    /// esbuild version string. Empty when `--no-transform` or there were
    /// no transformable files; still emitted so the field shape is stable.
    pub esbuild: String,
    /// `es2022` etc. Must match the runtime's loader esbuild target
    /// (SPEC.md §5 / runtime's esbuild config). Drift here breaks scripts
    /// silently at load.
    pub target: String,
    pub preset: String,
}

impl Manifest {
    /// Build a manifest skeleton from rune.toml. `files` and `compiler`
    /// are filled in by the pack pipeline; everything else is metadata
    /// that comes straight from the project config.
    pub fn from_config(cfg: &RuneToml) -> Self {
        Self {
            name: cfg.name.clone(),
            version: cfg.version.clone(),
            language: cfg.language.clone(),
            entry: normalise_path(&cfg.entry),
            files: Vec::new(),
            capabilities: cfg.capabilities.required.clone(),
            dependencies: cfg.dependencies.clone(),
            metadata: Metadata {
                description: cfg.description.clone(),
                license: cfg.license.clone(),
                homepage: cfg.homepage.clone(),
                repository: cfg.repository.clone(),
                keywords: cfg.keywords.clone(),
                authors: cfg.authors.clone(),
            },
            compiler: CompilerInfo {
                esbuild: String::new(),
                target: "es2022".into(),
                preset: "publish".into(),
            },
        }
    }

    /// Encode to canonical-JSON bytes. Sorted keys, no trailing newline,
    /// no whitespace. This is the byte stream we feed into the manifest
    /// hash.
    ///
    /// `serde_json::to_writer` with a `CanonicalFormatter` would be neat
    /// but the crate doesn't expose one; we hand-roll on top of
    /// `serde_json::Value` since that keeps insertion order via the
    /// `preserve_order` feature, and we sort keys ourselves.
    pub fn to_canonical_json(&self) -> Result<Vec<u8>> {
        let value: serde_json::Value = serde_json::to_value(self)?;
        let sorted = sort_keys(&value);
        let bytes = serde_json::to_vec(&sorted)?;
        Ok(bytes)
    }

    #[allow(dead_code)]
    pub fn hash(&self) -> Result<Hash> {
        Ok(Hash::of_bytes(&self.to_canonical_json()?))
    }
}

/// Recursively rebuild a `serde_json::Value` with object keys sorted
/// lexicographically. Arrays preserve order (array order IS semantically
/// significant — file lists are insertion-ordered for human readability).
fn sort_keys(v: &serde_json::Value) -> serde_json::Value {
    use serde_json::Value;
    match v {
        Value::Object(map) => {
            let mut sorted: Vec<(String, Value)> = map
                .iter()
                .map(|(k, v)| (k.clone(), sort_keys(v)))
                .collect();
            sorted.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out = serde_json::Map::new();
            for (k, v) in sorted {
                out.insert(k, v);
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(sort_keys).collect()),
        other => other.clone(),
    }
}

/// Posix-style relative path. We never store `\` in a manifest — the
/// install side may run on Linux, the publish side may run on Windows.
pub fn normalise_path(p: &str) -> String {
    p.replace('\\', "/")
}

pub fn normalise_relative(p: &Path) -> String {
    normalise_path(&p.to_string_lossy())
}
