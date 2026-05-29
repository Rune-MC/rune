//! `rune add` — install a published Rune into a server's scripts folder.
//!
//! Flow:
//!   1. Parse `<name>[@version]` and resolve the scripts directory.
//!   2. If no version pin, ask the registry for the latest released one.
//!   3. Fetch the manifest (canonical JSON) and decode it.
//!   4. For every unique blob hash in the manifest, download in parallel
//!      and verify SHA-256 matches. Mismatched hashes abort the install —
//!      the manifest is the security boundary.
//!   5. Write each file at its manifest-declared relative path inside
//!      `<scripts>/<basename>/`, then drop a `.rune-install.json`
//!      lockfile so `rune remove` knows we own this directory.
//!
//! Hash verification is non-negotiable. Without it, a malicious R2
//! object or a stale CDN cache could swap content under us.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, anyhow, bail};
use console::style;
use indicatif::{ProgressBar, ProgressStyle};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::cli::AddArgs;
use crate::commands::install_dir::{self, InstallLock};
use crate::commands::pkg_manager;
use crate::config::validate_name;
use crate::hash::Hash;
use crate::manifest::Manifest;
use crate::registry::Client;

/// How many blob GETs to run in parallel. Same rationale as
/// `publish::MAX_PARALLEL_UPLOADS` — enough to amortise latency
/// without saturating a residential link.
const MAX_PARALLEL_DOWNLOADS: usize = 8;

pub async fn run(args: AddArgs) -> Result<()> {
    // ---- 1. Parse spec ----
    let (name, requested_version) = parse_spec(&args.spec)?;
    validate_name(&name)
        .with_context(|| format!("invalid rune name `{name}`"))?;

    // ---- 2. Locate scripts dir ----
    let scripts_dir = install_dir::resolve(args.scripts.as_deref())?;
    let target_dir = scripts_dir.join(install_dir::dir_name(&name));

    // ---- 3. Resolve version ----
    let client = Arc::new(Client::new(args.registry.clone(), String::new())?);
    let version = match requested_version {
        Some(v) => v,
        None => {
            println!(
                "{} latest version of {}...",
                style("Resolving").cyan().bold(),
                name,
            );
            let summary = client
                .get_rune(&name)
                .await
                .with_context(|| format!("looking up {name} on the registry"))?;
            summary.latest_version.ok_or_else(|| {
                anyhow!(
                    "{name} has no released versions yet on {}",
                    args.registry.as_str().trim_end_matches('/'),
                )
            })?
        }
    };

    println!(
        "{} {} {}",
        style("Installing").cyan().bold(),
        name,
        style(format!("v{version}")).dim(),
    );

    let root_manifest = install(
        &client,
        &name,
        &version,
        &target_dir,
        &args.registry,
        args.force,
    )
    .await?;

    println!();
    println!(
        "{} {} {} {}",
        style("✓").green().bold(),
        style("Installed").green().bold(),
        format!("{name}@{version}"),
        style(format!("→ {}", target_dir.display())).dim(),
    );

    if !args.no_deps && !root_manifest.dependencies.is_empty() {
        install_deps(
            &client,
            &root_manifest,
            &scripts_dir,
            &args.registry,
        )
        .await?;
    }

    println!(
        "  {} restart your server (or `/rune reload`) to load it.",
        style("next:").dim(),
    );
    Ok(())
}

/// BFS over a root manifest's `[dependencies]` and install every
/// transitive Rune the user doesn't already have at a compatible
/// version.
///
/// Resolution: for each `(name, semver-req)` pair, ask the registry for
/// the rune's full version list, drop yanked entries, pick the highest
/// version that matches the req. Pre-release versions are excluded
/// unless the req itself names one (matches Cargo behaviour).
///
/// Existing installs are honoured: if `scripts/<dir>/.rune-install.json`
/// reports a version that satisfies the req, we leave it alone and
/// recurse through ITS deps. If the existing version DOESN'T satisfy
/// the req, we surface the conflict and bail — auto-upgrading a
/// transitive dep would surprise users who pinned it intentionally.
///
/// Cycles are broken by tracking the set of resolved (name -> version)
/// pairs; revisits are skipped.
async fn install_deps(
    client: &Arc<Client>,
    root: &Manifest,
    scripts_dir: &Path,
    registry: &url::Url,
) -> Result<()> {
    // (parent_name, dep_name, semver-req) — parent only used for messages.
    let mut queue: VecDeque<(String, String, String)> = VecDeque::new();
    for (n, r) in &root.dependencies {
        queue.push_back((root.name.clone(), n.clone(), r.clone()));
    }

    // name -> resolved version (chosen on first encounter).
    let mut resolved: HashMap<String, String> = HashMap::new();
    resolved.insert(root.name.clone(), root.version.clone());

    if queue.is_empty() {
        return Ok(());
    }
    println!();
    println!(
        "{} {} (transitive)",
        style("Resolving").cyan().bold(),
        style(format!("{} dep{}", queue.len(), if queue.len() == 1 { "" } else { "s" })).dim(),
    );

    while let Some((parent, dep_name, req_str)) = queue.pop_front() {
        validate_name(&dep_name)
            .with_context(|| format!("dependency name `{dep_name}` (from {parent}) is invalid"))?;
        let req = semver::VersionReq::parse(&req_str).with_context(|| {
            format!(
                "dependency `{dep_name} = \"{req_str}\"` (from {parent}) is not a valid semver range",
            )
        })?;

        // Already resolved earlier in the walk? If the prior pick
        // satisfies this req too, we're fine; otherwise we conflict.
        if let Some(prior) = resolved.get(&dep_name) {
            let prior_v = semver::Version::parse(prior).with_context(|| {
                format!("internal: resolved version {prior} for {dep_name} is not semver")
            })?;
            if req.matches(&prior_v) {
                continue;
            }
            bail!(
                "dependency conflict on {dep_name}: pinned to {prior} earlier in the graph \
                 but {parent} requires `{req_str}`. Re-publish one of the parents with a \
                 compatible range, or install {dep_name} manually first.",
            );
        }

        let target_dir = scripts_dir.join(install_dir::dir_name(&dep_name));
        let existing = install_dir::read_lock(&target_dir)?;
        let chosen_version = match &existing {
            Some(lock) => {
                let installed_v = semver::Version::parse(&lock.version).with_context(|| {
                    format!(
                        "lockfile for {} has non-semver version {}",
                        lock.name, lock.version,
                    )
                })?;
                if req.matches(&installed_v) {
                    println!(
                        "  {} {} {} {}",
                        style("·").dim(),
                        dep_name,
                        style(format!("v{}", lock.version)).dim(),
                        style("already installed").dim(),
                    );
                    lock.version.clone()
                } else {
                    bail!(
                        "dependency conflict on {dep_name}: {} already has v{} installed \
                         but {parent} requires `{req_str}`. Run `rune update {dep_name}` \
                         after publishing a compatible release, or pin to a matching range.",
                        target_dir.display(),
                        lock.version,
                    );
                }
            }
            None => {
                let summary = client
                    .get_rune(&dep_name)
                    .await
                    .with_context(|| format!("looking up {dep_name} on the registry"))?;
                let picked = pick_version(&summary, &req).ok_or_else(|| {
                    anyhow!(
                        "no published version of {dep_name} satisfies `{req_str}` (from {parent})"
                    )
                })?;
                println!(
                    "  {} {} {}",
                    style("→").cyan().bold(),
                    dep_name,
                    style(format!("v{picked}")).green().bold(),
                );
                // Fresh install — force=false because nothing's there.
                install(client, &dep_name, &picked, &target_dir, registry, false).await?;
                picked
            }
        };
        resolved.insert(dep_name.clone(), chosen_version.clone());

        // Recurse: enqueue this dep's own [dependencies] so they get
        // resolved too. We fetch the manifest fresh — even when the
        // dep was already on disk, its on-disk manifest could be stale
        // relative to the registry (the user might have edited it).
        let dep_manifest = client
            .get_manifest(&dep_name, &chosen_version)
            .await
            .with_context(|| format!("fetching manifest for {dep_name}@{chosen_version}"))?;
        for (n, r) in dep_manifest.dependencies {
            queue.push_back((dep_name.clone(), n, r));
        }
    }
    Ok(())
}

/// Pick the highest non-yanked version of `summary` that satisfies
/// `req`. Pre-release versions are skipped unless `req` mentions one
/// (matches Cargo's filter: a bare `^1.0` won't accept `1.0.0-beta.1`).
fn pick_version(
    summary: &crate::registry::RuneSummary,
    req: &semver::VersionReq,
) -> Option<String> {
    let allow_pre = req.comparators.iter().any(|c| !c.pre.is_empty());
    let mut best: Option<semver::Version> = None;
    for v in &summary.versions {
        if v.yanked {
            continue;
        }
        let Ok(parsed) = semver::Version::parse(&v.version) else { continue };
        if !allow_pre && !parsed.pre.is_empty() {
            continue;
        }
        if !req.matches(&parsed) {
            continue;
        }
        if best.as_ref().is_none_or(|b| &parsed > b) {
            best = Some(parsed);
        }
    }
    best.map(|v| v.to_string())
}

/// Lay down a specific version of a named Rune into `target_dir`. Shared
/// by `rune add` (single install) and `rune update` (bulk replay across
/// every installed Rune that has a newer version available).
///
/// Performs the existing-dir check, manifest fetch + name/version sanity,
/// parallel verified blob download, file lay-down, lockfile write, and
/// npm install. Does NOT print the surrounding banner — callers handle
/// their own framing so update can keep its compact one-line-per-rune
/// summary.
pub async fn install(
    client: &Arc<Client>,
    name: &str,
    version: &str,
    target_dir: &Path,
    registry: &url::Url,
    force: bool,
) -> Result<Manifest> {
    if target_dir.exists() {
        if !force {
            bail!(
                "{} already exists. Re-run with --force to overwrite, or `rune remove {}` first.",
                target_dir.display(),
                install_dir::dir_name(name),
            );
        }
        // --force: remove the old install before laying down the new
        // one. We don't merge in place — a half-replaced install is
        // worse than a clean swap. node_modules vanishes with it, which
        // is fine: pkg_manager::maybe_install will repopulate at the end.
        std::fs::remove_dir_all(target_dir)
            .with_context(|| format!("clearing {}", target_dir.display()))?;
    }

    // ---- Fetch manifest ----
    let manifest = client
        .get_manifest(name, version)
        .await
        .with_context(|| format!("fetching manifest for {name}@{version}"))?;

    // Sanity: the manifest's own name/version should match what we
    // asked for. If they don't, R2 is serving stale or mis-keyed data.
    if manifest.name != name {
        bail!(
            "manifest name mismatch: asked for {name}, registry served {}",
            manifest.name
        );
    }
    if manifest.version != version {
        bail!(
            "manifest version mismatch: asked for {version}, registry served {}",
            manifest.version
        );
    }

    // ---- 5. Download blobs (parallel + verified) ----
    // Multiple manifest files can share a single blob (identical
    // content → same hash); we download each unique blob once and
    // splat it out to every path that references it.
    let unique_hashes: HashSet<String> =
        manifest.files.iter().map(|f| f.hash.to_wire()).collect();
    let total_files = manifest.files.len();
    let unique_count = unique_hashes.len();

    let total_bytes: u64 = manifest.files.iter().map(|f| f.size).sum();
    let pb = ProgressBar::new(total_bytes);
    pb.set_style(
        ProgressStyle::with_template(
            "  {bar:32.cyan/blue} {bytes}/{total_bytes} ({eta}) {msg}",
        )
        .unwrap()
        .progress_chars("█▉▊▋▌▍▎▏ "),
    );
    pb.set_message(format!(
        "{} blobs ({} files){}",
        unique_count,
        total_files,
        if unique_count < total_files {
            ", dedup"
        } else {
            ""
        }
    ));

    let sem = Arc::new(Semaphore::new(MAX_PARALLEL_DOWNLOADS));
    let mut set: JoinSet<Result<(String, Vec<u8>)>> = JoinSet::new();

    // Size-per-blob map so each task can report progress proportional
    // to the blob's bytes regardless of which file path triggered it.
    // We pick the first matching file's size — every entry with the
    // same hash has the same content and therefore the same size.
    let mut size_for_hash: HashMap<String, u64> = HashMap::new();
    for f in &manifest.files {
        size_for_hash.entry(f.hash.to_wire()).or_insert(f.size);
    }

    for wire_hash in unique_hashes {
        let hex = wire_hash
            .strip_prefix("sha256:")
            .ok_or_else(|| anyhow!("manifest hash {wire_hash} missing sha256: prefix"))?
            .to_string();
        let expected = Hash::from_wire(&wire_hash)
            .ok_or_else(|| anyhow!("manifest hash {wire_hash} is malformed"))?;
        let size = *size_for_hash.get(&wire_hash).unwrap_or(&0);
        let client = client.clone();
        let pb = pb.clone();
        let sem = sem.clone();

        set.spawn(async move {
            let _permit = sem
                .acquire_owned()
                .await
                .context("acquiring download concurrency permit")?;
            let bytes = client
                .get_blob(&hex)
                .await
                .with_context(|| format!("downloading blob {wire_hash}"))?;
            // Verify before returning. A wrong hash here means we'd be
            // about to write attacker-chosen bytes into the user's
            // server folder; aborting now is the whole point of
            // content-addressed storage.
            let actual = Hash::of_bytes(&bytes);
            if actual != expected {
                return Err(anyhow!(
                    "hash mismatch for {wire_hash}: blob hashed to {}",
                    actual.to_wire()
                ));
            }
            pb.inc(size);
            Ok((wire_hash, bytes))
        });
    }

    let mut blobs: HashMap<String, Vec<u8>> = HashMap::with_capacity(unique_count);
    let mut first_err: Option<anyhow::Error> = None;
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(Ok((hash, bytes))) => {
                blobs.insert(hash, bytes);
            }
            Ok(Err(e)) => {
                if first_err.is_none() {
                    first_err = Some(e);
                }
            }
            Err(join_err) => {
                if first_err.is_none() {
                    first_err = Some(anyhow!("download task panicked: {join_err}"));
                }
            }
        }
    }
    pb.finish_and_clear();
    if let Some(e) = first_err {
        return Err(e);
    }

    // ---- 6. Lay down files ----
    std::fs::create_dir_all(target_dir)
        .with_context(|| format!("creating {}", target_dir.display()))?;

    for file in &manifest.files {
        let bytes = blobs
            .get(&file.hash.to_wire())
            .ok_or_else(|| anyhow!("internal: blob for {} missing after download", file.path))?;
        let dest = safe_join(target_dir, &file.path)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        std::fs::write(&dest, bytes)
            .with_context(|| format!("writing {}", dest.display()))?;
    }

    // ---- 7. Lockfile ----
    let lock = InstallLock {
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        manifest_hash: manifest.hash()?.to_wire(),
        registry: registry.as_str().trim_end_matches('/').to_string(),
        installed_at: now_rfc3339_ish(),
    };
    install_dir::write_lock(target_dir, &lock)?;

    // ---- 8. npm deps ----
    // Many Runes ship a package.json whose `dependencies` (mongoose,
    // zod, etc.) the runtime resolves at script load. Running the
    // preferred PM here means the script bootstrap doesn't crash with
    // "Cannot find module 'mongoose'" on first run.
    pkg_manager::maybe_install(target_dir)?;

    Ok(manifest)
}

/// Split `name`, `name@version`, or `@scope/name@version` correctly. The
/// tricky bit is that a scoped name starts with `@`, so we can't just
/// split on the first `@` — we look for the LAST one and only treat it
/// as a version separator if it appears after a `/` (or in an unscoped
/// name).
fn parse_spec(spec: &str) -> Result<(String, Option<String>)> {
    let spec = spec.trim();
    if spec.is_empty() {
        bail!("rune spec is empty");
    }

    // Strip a leading `@scope/` if present so we only consider `@` after
    // the slash as the version separator.
    let (scope_prefix, rest) = match spec.strip_prefix('@') {
        Some(after_at) => {
            let (scope, rest) = after_at
                .split_once('/')
                .ok_or_else(|| anyhow!("scoped name {spec:?} is missing `/` after the scope"))?;
            (format!("@{scope}/"), rest.to_string())
        }
        None => (String::new(), spec.to_string()),
    };

    let (name_part, version_part) = match rest.split_once('@') {
        Some((n, v)) => (n.to_string(), Some(v.to_string())),
        None => (rest, None),
    };

    Ok((format!("{scope_prefix}{name_part}"), version_part))
}

/// Join a relative manifest path onto a target dir, refusing any `..`
/// or absolute components. The manifest is signed by hash — but the
/// `path` field is plain text and an attacker who controls a published
/// rune could try to escape into siblings (e.g. `../../../etc/passwd`).
fn safe_join(base: &std::path::Path, rel: &str) -> Result<PathBuf> {
    use std::path::Component;
    let rel_path = std::path::Path::new(rel);
    let mut out = base.to_path_buf();
    for comp in rel_path.components() {
        match comp {
            Component::Normal(seg) => out.push(seg),
            Component::CurDir => {}
            Component::ParentDir => {
                bail!("manifest path {rel:?} escapes the install dir (contains `..`)");
            }
            Component::RootDir | Component::Prefix(_) => {
                bail!("manifest path {rel:?} is absolute");
            }
        }
    }
    Ok(out)
}

/// Compact RFC-3339-ish timestamp for the lockfile. We don't need
/// subsecond precision or timezone fidelity — this field is for
/// humans inspecting `.rune-install.json`, not for ordering.
fn now_rfc3339_ish() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Avoid pulling in `chrono` just to render a timestamp. Display the
    // raw epoch — verbose but unambiguous, and any reader can paste it
    // into `date -d @<n>` or similar.
    format!("epoch:{secs}")
}
