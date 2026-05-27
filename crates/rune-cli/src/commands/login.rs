//! `rune login` — save a Runebook PAT for future publishes.

use std::io::{self, Write};

use anyhow::{Context, Result, bail};
use console::style;

use crate::auth::{self, TokenEntry};
use crate::cli::LoginArgs;
use crate::registry::Client;

pub async fn run(args: LoginArgs) -> Result<()> {
    let token = match args.token {
        Some(t) => t,
        None => prompt_for_token(&args.registry)?,
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

fn prompt_for_token(registry: &url::Url) -> Result<String> {
    let prompt = format!(
        "Paste a Rune personal access token from {}/dashboard/tokens:\n> ",
        registry.as_str().trim_end_matches('/'),
    );
    print!("{prompt}");
    io::stdout().flush().ok();
    let mut buf = String::new();
    io::stdin().read_line(&mut buf).context("reading stdin")?;
    Ok(buf)
}
