//! `rune whoami` — show the username the saved token resolves to.
//!
//! Hits the registry's `/api/v1/whoami` rather than trusting the cached
//! username in the token store. A live probe means a revoked token shows
//! up here too, not just at publish time.

use anyhow::{Result, bail};
use console::style;

use crate::auth;
use crate::registry::Client;

pub async fn run() -> Result<()> {
    let store = auth::load()?;
    if store.entries.is_empty() {
        bail!("not logged in. Run `rune login`.");
    }

    for (registry, entry) in &store.entries {
        let url: url::Url = registry.parse()?;
        let client = Client::new(url.clone(), entry.token.clone())?;
        match client.whoami().await {
            Ok(me) => println!(
                "{} on {}",
                style(&me.username).bold(),
                registry,
            ),
            Err(e) => println!(
                "{} on {}: {}",
                style("?").yellow().bold(),
                registry,
                e,
            ),
        }
    }
    Ok(())
}
