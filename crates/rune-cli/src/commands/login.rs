//! `rune login` — authorize this CLI to use Runebook.

use anyhow::{Context, Result, bail};
use console::style;

use crate::auth::{self, TokenEntry};
use crate::cli::LoginArgs;
use crate::registry::Client;

pub async fn run(args: LoginArgs) -> Result<()> {
    let token = match args.token {
        Some(t) => t,
        None => super::browser_login::run(&args.registry, args.device).await?,
    };
    let token = token.trim().to_string();

    if !token.starts_with("rune_pat_") {
        bail!(
            "that doesn't look like a Rune personal access token (expected `rune_pat_…`). \
             Generate one at {}/dashboard/tokens",
            args.registry.as_str().trim_end_matches('/')
        );
    }

    // Probe the registry before saving — if the token is bad we'd rather
    // fail here with a clear error than at publish time.
    let probe = Client::new(args.registry.clone(), token.clone())?;
    let me = probe
        .whoami()
        .await
        .context("validating token with the registry")?;

    auth::put(
        &args.registry,
        TokenEntry { token, username: Some(me.username.clone()) },
    )?;

    let scopes = me
        .scopes
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| format!(" (scopes: {})", s.join(", ")))
        .unwrap_or_default();
    println!(
        "{} Logged in as {} on {}{}",
        style("✓").green().bold(),
        style(&me.username).bold(),
        args.registry.as_str().trim_end_matches('/'),
        style(scopes).dim(),
    );
    Ok(())
}
