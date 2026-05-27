//! `rune pack` — turn a project into a publishable artifact.
//!
//! Pipeline:
//!   1. Find + parse `rune.toml`.
//!   2. Walk the project under the include/deny/exclude/.runeignore rules.
//!   3. Read each file's bytes verbatim — NO pack-time transform. The
//!      Rune runtime has its own loader-side esbuild that handles TS,
//!      decorators, and JSX at load time. Transforming twice would just
//!      shred readability + couple the published artifact to a specific
//!      target the runtime is free to change.
//!   4. Compute SHA-256 per file, build the manifest with sorted keys.
//!   5. Write the manifest + each blob + a zstd-compressed archive view.
//!
//! Output layout under `--out` (default `dist/`):
//!
//! ```text
//! dist/
//!   <name>-<version>.manifest.json   # canonical-JSON manifest
//!   blobs/<hash>                     # one per unique blob, plain bytes
//!   <name>-<version>.tar.zst         # tarball view of the same files,
//!                                    # zstd-compressed, for offline review
//! ```
//!
//! The publish command can read the manifest and `blobs/` directly — no
//! need to crack the tarball back open.

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use console::style;
use indicatif::{ProgressBar, ProgressStyle};

use crate::cli::PackArgs;
use crate::config::RuneToml;
use crate::hash::Hash;
use crate::ignore_filter::Walker;
use crate::manifest::{FileEntry, Manifest, normalise_relative};

pub struct PackResult {
    pub root: PathBuf,
    pub out_dir: PathBuf,
    pub manifest: Manifest,
    pub manifest_path: PathBuf,
    pub manifest_hash: Hash,
    /// All blobs referenced by the manifest, deduped by hash. The blob's
    /// bytes live at `out_dir/blobs/<hash>`.
    pub blobs: Vec<PackedBlob>,
}

pub struct PackedBlob {
    pub hash: Hash,
    pub size: u64,
    pub path_on_disk: PathBuf,
}

pub async fn run(args: PackArgs) -> Result<()> {
    let result = pack(&args).await?;
    print_summary(&result);
    Ok(())
}

pub async fn pack(args: &PackArgs) -> Result<PackResult> {
    let root = RuneToml::find_root(&args.dir)?;
    let cfg = RuneToml::load(&root)?;
    println!(
        "{} {} {}",
        style("Packing").cyan().bold(),
        cfg.name,
        style(format!("v{}", cfg.version)).dim(),
    );

    let out_dir = if args.out.is_absolute() {
        args.out.clone()
    } else {
        root.join(&args.out)
    };
    let blob_dir = out_dir.join("blobs");
    fs::create_dir_all(&blob_dir)
        .with_context(|| format!("creating {}", blob_dir.display()))?;

    let walker = Walker::new(&root, &cfg)?;
    let files = walker.collect()?;
    if files.is_empty() {
        bail!("no files matched the publish rules in `{}`", root.display());
    }

    let pb = ProgressBar::new(files.len() as u64);
    pb.set_style(
        ProgressStyle::with_template("  {bar:32.cyan/blue} {pos}/{len} {wide_msg}")
            .unwrap()
            .progress_chars("█▉▊▋▌▍▎▏ "),
    );

    // No esbuild at pack time. `manifest.compiler` stays at its default
    // empty form — the field is still present in canonical JSON for
    // schema stability, just blank.
    let mut manifest = Manifest::from_config(&cfg);
    let mut blobs: Vec<PackedBlob> = Vec::new();
    let mut seen: std::collections::HashSet<Hash> = std::collections::HashSet::new();

    for rel in &files {
        pb.set_message(rel.display().to_string());
        let abs = root.join(rel);
        let bytes = fs::read(&abs)
            .with_context(|| format!("reading {}", abs.display()))?;

        let hash = Hash::of_bytes(&bytes);
        let size = bytes.len() as u64;

        let manifest_path = normalise_relative(rel);
        manifest.files.push(FileEntry {
            path: manifest_path,
            hash,
            size,
        });

        if seen.insert(hash) {
            let dest = blob_dir.join(hash.to_hex());
            fs::write(&dest, &bytes)
                .with_context(|| format!("writing {}", dest.display()))?;
            blobs.push(PackedBlob { hash, size, path_on_disk: dest });
        }

        pb.inc(1);
    }
    pb.finish_and_clear();

    // Manifest is the version's identity. Serialise canonically, hash,
    // and write to disk for the publish step to slurp.
    let manifest_bytes = manifest.to_canonical_json()?;
    let manifest_hash = Hash::of_bytes(&manifest_bytes);
    let manifest_path = out_dir.join(format!(
        "{}-{}.manifest.json",
        slugify_for_filename(&cfg.name),
        cfg.version,
    ));
    fs::write(&manifest_path, &manifest_bytes)
        .with_context(|| format!("writing {}", manifest_path.display()))?;

    // Companion tarball for human inspection / offline distribution.
    // Not what the registry consumes (it gets the blobs + manifest
    // directly), but very useful when a maintainer says "what did you
    // actually publish?".
    write_archive(&out_dir, &cfg, &manifest_path, &blobs)?;

    Ok(PackResult {
        root,
        out_dir,
        manifest,
        manifest_path,
        manifest_hash,
        blobs,
    })
}

/// `@alice/foo` is fine inside a manifest but illegal in a Windows
/// filename. Strip the leading `@` and the `/` for on-disk artifacts.
fn slugify_for_filename(name: &str) -> String {
    name.trim_start_matches('@').replace('/', "__")
}

fn write_archive(
    out_dir: &Path,
    cfg: &RuneToml,
    manifest_path: &Path,
    blobs: &[PackedBlob],
) -> Result<()> {
    use std::io::Write;
    let archive_path = out_dir.join(format!(
        "{}-{}.tar.zst",
        slugify_for_filename(&cfg.name),
        cfg.version,
    ));
    let file = fs::File::create(&archive_path)
        .with_context(|| format!("creating {}", archive_path.display()))?;
    // zstd level 19 hits a good ratio for tiny TS files at the cost of
    // some CPU. Author-time CPU is cheap compared to install-time bytes;
    // we'll dial in once we have a real-world corpus.
    let encoder = zstd::Encoder::new(file, 19)
        .with_context(|| "initialising zstd encoder")?
        .auto_finish();
    let mut writer = encoder;

    // We can't use the `tar` crate's `append_path` helpers because the
    // blob files on disk are named by hash; we want the in-archive name
    // to match the manifest's `files[].path`. So we build the archive by
    // re-reading the source files we already walked, but reading the
    // ALREADY-TRANSFORMED blob bytes by manifest entry.
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)?;
    let mut tar = tar::Builder::new(&mut writer);

    for entry in &manifest.files {
        // Walk the blobs we already wrote rather than re-transforming.
        let blob = blobs
            .iter()
            .find(|b| b.hash == entry.hash)
            .ok_or_else(|| anyhow!("manifest references unknown blob {}", entry.hash))?;
        let mut data = fs::File::open(&blob.path_on_disk)?;
        let mut header = tar::Header::new_gnu();
        header.set_size(entry.size);
        header.set_mode(0o644);
        header.set_cksum();
        tar.append_data(&mut header, &entry.path, &mut data)?;
    }
    // Manifest itself rides along inside the tarball so anyone unpacking
    // it can immediately re-hash for verification.
    let manifest_bytes = fs::read(manifest_path)?;
    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_bytes.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    tar.append_data(&mut header, "manifest.json", &mut manifest_bytes.as_slice())?;
    tar.finish()?;
    drop(tar);

    writer.flush().ok();
    Ok(())
}

fn print_summary(result: &PackResult) {
    let total_bytes: u64 = result.blobs.iter().map(|b| b.size).sum();
    println!();
    println!("  {} {}", style("manifest:").dim(), result.manifest_path.display());
    println!("  {} {}", style("hash:    ").dim(), result.manifest_hash);
    println!(
        "  {} {} blob{} ({})",
        style("blobs:   ").dim(),
        result.blobs.len(),
        if result.blobs.len() == 1 { "" } else { "s" },
        human_bytes(total_bytes),
    );
}

fn human_bytes(n: u64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = KB * 1024.0;
    if (n as f64) < KB {
        format!("{n} B")
    } else if (n as f64) < MB {
        format!("{:.1} KB", n as f64 / KB)
    } else {
        format!("{:.2} MB", n as f64 / MB)
    }
}
