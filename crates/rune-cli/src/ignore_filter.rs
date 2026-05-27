//! File-walk + filtering for the pack pipeline.
//!
//! Three filters compose, in this order (anything matched by an earlier
//! stage doesn't reach the next):
//!
//! 1. **Include globs** from `[publish] include` in rune.toml. These are
//!    POSITIVE: we walk every directory but only collect files that match.
//! 2. **Default-deny list** — `node_modules`, `.git`, `target`, tests,
//!    sourcemaps, lock files. These never reach a published archive.
//! 3. **`exclude` globs** from `[publish] exclude` in rune.toml.
//! 4. **`.runeignore`** — gitignore-style file in the project root.
//!    Authors override our defaults with their own patterns.
//!
//! Order matters for the user-facing mental model: include first
//! (positive), then everything else is subtraction. Mirrors how cargo,
//! npm, and crates.io publish-time filtering all behave.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use globset::{Glob, GlobSetBuilder};
use ignore::WalkBuilder;

use crate::config::RuneToml;

/// File paths the pack pipeline categorically refuses to publish.
/// Patterns are matched against the relative path with forward slashes.
const DEFAULT_DENY: &[&str] = &[
    "**/node_modules/**",
    "**/.git/**",
    "**/.svn/**",
    "**/.hg/**",
    "**/target/**",
    "**/dist/**",
    "**/build/**",
    "**/.next/**",
    "**/.turbo/**",
    "**/.cache/**",
    "**/.DS_Store",
    "**/Thumbs.db",
    "**/*.log",
    "**/*.map",       // sourcemaps ship separately (SPEC.md §10).
    "**/.env",
    "**/.env.*",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lock",
    "**/bun.lockb",
    "**/.runeignore",
    // Tests don't ship. Authors who want test fixtures published can
    // override with an explicit include rule.
    "**/*.test.ts",
    "**/*.test.js",
    "**/*.spec.ts",
    "**/*.spec.js",
    "**/__tests__/**",
];

pub struct Walker {
    root: PathBuf,
    include: globset::GlobSet,
    deny: globset::GlobSet,
    exclude: globset::GlobSet,
}

impl Walker {
    pub fn new(root: &Path, cfg: &RuneToml) -> Result<Self> {
        Ok(Self {
            root: root.to_path_buf(),
            include: build_set(&cfg.publish.include, "include")?,
            deny: build_set_strs(DEFAULT_DENY, "default-deny")?,
            exclude: build_set(&cfg.publish.exclude, "exclude")?,
        })
    }

    /// Yields every file in the project that should be packed, relative
    /// to `root` with forward slashes. Order is stable (sorted) so the
    /// manifest's `files` array is deterministic across hosts.
    pub fn collect(&self) -> Result<Vec<PathBuf>> {
        let mut hits: Vec<PathBuf> = Vec::new();
        let walker = WalkBuilder::new(&self.root)
            // .runeignore reads exactly like .gitignore. We also enable
            // .gitignore parsing -- authors usually already have one,
            // and having pack disagree with `git ls-files` would surprise
            // them. Same logic for global gitignore + .ignore.
            .add_custom_ignore_filename(".runeignore")
            .hidden(false)          // include dotfiles unless gitignored
            .git_ignore(true)
            .git_exclude(true)
            .require_git(false)
            .build();

        for entry in walker {
            let entry = entry.context("walking project tree")?;
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let rel = match entry.path().strip_prefix(&self.root) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            let rel_str = path_to_glob_match(rel);

            // Stage 1: must match at least one include.
            if !self.include.is_match(&rel_str) {
                continue;
            }
            // Stage 2: default-deny.
            if self.deny.is_match(&rel_str) {
                continue;
            }
            // Stage 3: author exclude.
            if self.exclude.is_match(&rel_str) {
                continue;
            }

            hits.push(rel.to_path_buf());
        }

        hits.sort();
        Ok(hits)
    }
}

fn build_set(patterns: &[String], context: &str) -> Result<globset::GlobSet> {
    let strs: Vec<&str> = patterns.iter().map(String::as_str).collect();
    build_set_strs(&strs, context)
}

fn build_set_strs(patterns: &[&str], context: &str) -> Result<globset::GlobSet> {
    let mut b = GlobSetBuilder::new();
    for p in patterns {
        let glob = Glob::new(p).with_context(|| format!("{context} glob {p:?}"))?;
        b.add(glob);
    }
    b.build().with_context(|| format!("{context} globset"))
}

/// globset matches against UTF-8 strings with the platform separator
/// normalised to `/`. We use the same shape we'll emit in the manifest.
fn path_to_glob_match(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}
