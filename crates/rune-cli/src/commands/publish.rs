//! `rune publish` — pack, then push to Runebook.
//!
//! Flow:
//!   1. Pack the project (full `rune pack` pipeline).
//!   2. Look up the saved token for the target registry.
//!   3. `POST /api/v1/blobs/check` — which hashes are already known?
//!      (Quick path; cheap optimisation.)
//!   4. `POST /api/v1/runes/:name/versions` — submit the manifest.
//!      The response contains pre-signed PUT URLs for each missing blob.
//!   5. `PUT <signed url>` — direct to R2 for every missing blob.
//!   6. `POST .../finalize` — commit.
//!
//! Half-uploaded publishes are invisible: the version stays in `pending`
//! state until `finalize` returns OK. A network blip mid-upload can be
//! retried by re-running `rune publish` — content-addressed storage means
//! re-uploading the same blobs is a no-op.

use std::collections::HashMap;
use std::io::{self, Write};
use std::sync::Arc;

use anyhow::{Context, Result, anyhow, bail};
use console::style;
use indicatif::{ProgressBar, ProgressStyle};
use tokio::sync::Semaphore;
use tokio::task::JoinSet;

use crate::auth;
use crate::cli::PublishArgs;
use crate::commands::pack;
use crate::hash::Hash;
use crate::registry::Client;

/// How many R2 PUTs to keep in flight at once. R2 happily handles
/// dozens of parallel uploads; the constraint is the user's upstream
/// bandwidth. Eight is a polite default — enough to amortise round-trip
/// latency, low enough to leave headroom on a residential connection.
const MAX_PARALLEL_UPLOADS: usize = 8;

pub async fn run(args: PublishArgs) -> Result<()> {
    // ---- Step 1: pack ----
    let packed = pack::pack(&args.pack).await?;

    // ---- Step 2: token + client ----
    let entry = auth::get(&args.registry)?.ok_or_else(|| {
        anyhow!(
            "not logged in to {}. Run `rune login` first.",
            args.registry.as_str().trim_end_matches('/'),
        )
    })?;
    // Wrapped in an Arc up front so we can hand cheap clones to the
    // parallel upload tasks below without taking ownership away from
    // the post-upload finalize/yank calls.
    let client = Arc::new(Client::new(args.registry.clone(), entry.token.clone())?);

    // Confirm before any network mutation. CI / scripted publishes use
    // --yes to skip; interactive users get a chance to back out.
    if !args.yes {
        confirm_publish(&packed, &args)?;
    }

    println!(
        "{} {} {}",
        style("Publishing").cyan().bold(),
        packed.manifest.name,
        style(format!("v{}", packed.manifest.version)).dim(),
    );

    // ---- Step 3: pre-check which blobs the registry already has ----
    let all_hashes: Vec<Hash> = packed.blobs.iter().map(|b| b.hash).collect();
    let pre = client
        .blobs_check(&all_hashes)
        .await
        .context("blob existence check")?;
    let present: std::collections::HashSet<String> = pre.present.into_iter().collect();
    let dedup_savings = present.len();
    if dedup_savings > 0 {
        println!(
            "  {} {} blob{} already on the registry",
            style("dedup:").dim(),
            dedup_savings,
            if dedup_savings == 1 { "" } else { "s" },
        );
    }

    // ---- Step 4: submit manifest, learn what we need to upload ----
    let created = client
        .create_version(&packed.manifest)
        .await
        .context("submitting manifest")?;
    let needed_map: HashMap<String, String> = created
        .missing_blobs
        .iter()
        .map(|m| (m.hash.clone(), m.upload_url.clone()))
        .collect();

    // Sanity check: the server's "missing" set should be a subset of our
    // packed blobs. If it isn't, something is racing with our publish.
    let blob_lookup: HashMap<String, &pack::PackedBlob> = packed
        .blobs
        .iter()
        .map(|b| (b.hash.to_wire(), b))
        .collect();

    // ---- Step 5: upload missing blobs (parallel, bounded) ----
    if !needed_map.is_empty() {
        let total: u64 = needed_map
            .keys()
            .filter_map(|h| blob_lookup.get(h))
            .map(|b| b.size)
            .sum();
        let pb = ProgressBar::new(total);
        pb.set_style(
            ProgressStyle::with_template(
                "  {bar:32.cyan/blue} {bytes}/{total_bytes} ({eta}) {msg}",
            )
            .unwrap()
            .progress_chars("█▉▊▋▌▍▎▏ "),
        );
        pb.set_message(format!("{} parallel", MAX_PARALLEL_UPLOADS));

        // Cheap-to-clone refs we hand to each spawned upload task.
        // `ProgressBar` is internally an Arc too, so cloning it just
        // bumps a refcount.
        let sem = Arc::new(Semaphore::new(MAX_PARALLEL_UPLOADS));
        let mut set: JoinSet<Result<()>> = JoinSet::new();

        for (hash, url) in needed_map.into_iter() {
            let blob = blob_lookup
                .get(&hash)
                .ok_or_else(|| anyhow!("registry requested unknown blob {hash}"))?;
            let path = blob.path_on_disk.clone();
            let size = blob.size;
            let client = client.clone();
            let pb = pb.clone();
            let sem = sem.clone();

            set.spawn(async move {
                // Owned permit, released when the task ends. Bounds total
                // concurrency without blocking the spawner.
                let _permit = sem
                    .acquire_owned()
                    .await
                    .context("acquiring upload concurrency permit")?;
                let bytes = tokio::fs::read(&path)
                    .await
                    .with_context(|| format!("reading {}", path.display()))?;
                client
                    .upload_blob(&url, bytes)
                    .await
                    .with_context(|| format!("uploading blob {hash}"))?;
                pb.inc(size);
                Ok(())
            });
        }

        // Drain the pool, surfacing the first failure. If one task errors
        // we let the rest finish what they've already started — aborting
        // half-complete R2 PUTs doesn't save anything and tends to leak
        // partially-written objects in some storage backends.
        let mut first_err: Option<anyhow::Error> = None;
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok(Ok(())) => {}
                Ok(Err(e)) => {
                    if first_err.is_none() {
                        first_err = Some(e);
                    }
                }
                Err(join_err) => {
                    if first_err.is_none() {
                        first_err = Some(anyhow!("upload task panicked: {join_err}"));
                    }
                }
            }
        }
        pb.finish_and_clear();
        if let Some(e) = first_err {
            return Err(e);
        }
    }

    // ---- Step 6: commit ----
    let finalised = client
        .finalize(&packed.manifest.name, &packed.manifest.version)
        .await
        .context("finalising version")?;

    // Draft mode isn't a flag the registry understands — we finalise as
    // normal, then immediately yank with a synthetic reason so the version
    // never shows up in search until the author re-publishes without
    // --draft. A yank failure after a successful finalise is loud rather
    // than silent: the version IS published, just not in the "invisible"
    // state the user asked for.
    if args.draft {
        client
            .yank(
                &finalised.name,
                &finalised.version,
                "published with --draft (yanked until next publish)",
            )
            .await
            .context("auto-yanking draft publish")?;
    }

    println!();
    println!(
        "{} {} {}",
        style("✓").green().bold(),
        style("Published").green().bold(),
        format!("{}@{}", finalised.name, finalised.version),
    );
    println!("  manifest hash: {}", finalised.manifest_hash);
    println!("  install:       {}", style(finalised.install).cyan());
    if args.draft {
        println!(
            "  {} draft mode: this version is yanked. Run `rune publish` again without --draft to make it discoverable.",
            style("note:").yellow().bold(),
        );
    }
    Ok(())
}

fn confirm_publish(packed: &pack::PackResult, args: &PublishArgs) -> Result<()> {
    println!();
    println!("  {} {}", style("registry:").dim(), args.registry.as_str().trim_end_matches('/'));
    println!("  {} {}", style("name:    ").dim(), packed.manifest.name);
    println!("  {} {}", style("version: ").dim(), packed.manifest.version);
    println!("  {} {}", style("files:   ").dim(), packed.manifest.files.len());
    println!("  {} {}", style("hash:    ").dim(), packed.manifest_hash);
    if !packed.manifest.capabilities.is_empty() {
        println!("  {} {}", style("caps:    ").dim(), packed.manifest.capabilities.join(", "));
    }
    if args.draft {
        println!("  {} {}", style("mode:    ").dim(), "draft (yanked on publish)");
    }
    print!("\nPublish? [y/N] ");
    io::stdout().flush().ok();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let answer = line.trim().to_lowercase();
    if !(answer == "y" || answer == "yes") {
        bail!("publish cancelled");
    }
    Ok(())
}

