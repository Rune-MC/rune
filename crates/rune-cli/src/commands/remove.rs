//! `rune remove` — uninstall a Rune from a server's scripts folder.
//!
//! We're deliberately conservative: a directory matching the requested
//! name is only deleted if it contains a `.rune-install.json` lockfile
//! that `rune add` wrote. Without that marker we refuse, because the
//! folder might be a hand-written script the user named the same thing
//! by coincidence — and recursively rm-ing someone's source code over
//! a name collision is exactly the kind of "tool destroyed my work"
//! incident we never want to read about.

use std::io::{self, Write};

use anyhow::{Context, Result, bail};
use console::style;

use crate::cli::RemoveArgs;
use crate::commands::install_dir;

pub async fn run(args: RemoveArgs) -> Result<()> {
    let scripts_dir = install_dir::resolve(args.scripts.as_deref())?;
    let basename = install_dir::dir_name(&args.name);
    let target_dir = scripts_dir.join(&basename);

    if !target_dir.exists() {
        bail!(
            "no installed Rune named {basename:?} under {} (looked in {})",
            scripts_dir.display(),
            target_dir.display(),
        );
    }

    let lock = install_dir::read_lock(&target_dir)?;
    let lock = lock.ok_or_else(|| {
        anyhow::anyhow!(
            "{} has no {} lockfile — refusing to delete it.\n\
             If you're sure, remove the folder manually.",
            target_dir.display(),
            install_dir::LOCKFILE,
        )
    })?;

    println!(
        "{} {} {} {}",
        style("Removing").yellow().bold(),
        lock.name,
        style(format!("v{}", lock.version)).dim(),
        style(format!("from {}", target_dir.display())).dim(),
    );

    if !args.yes && !confirm()? {
        bail!("remove cancelled");
    }

    std::fs::remove_dir_all(&target_dir)
        .with_context(|| format!("deleting {}", target_dir.display()))?;

    println!(
        "{} {} {}",
        style("✓").green().bold(),
        style("Removed").green().bold(),
        format!("{}@{}", lock.name, lock.version),
    );
    println!(
        "  {} restart your server (or `/rune reload`) to unload it.",
        style("next:").dim(),
    );
    Ok(())
}

fn confirm() -> Result<bool> {
    print!("Remove this rune? [y/N] ");
    io::stdout().flush().ok();
    let mut line = String::new();
    io::stdin().read_line(&mut line)?;
    let answer = line.trim().to_lowercase();
    Ok(answer == "y" || answer == "yes")
}
