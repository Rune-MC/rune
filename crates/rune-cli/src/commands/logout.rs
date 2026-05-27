//! `rune logout` — forget every saved token.
//!
//! For the common case of "I made a mistake, get me out of here" we wipe
//! everything in the token store rather than per-registry. Multi-registry
//! users can re-`rune login` against just the registries they want back.

use anyhow::Result;
use console::style;

use crate::auth;

pub async fn run() -> Result<()> {
    let path = auth::token_path()?;
    if !path.exists() {
        println!("Not logged in.");
        return Ok(());
    }
    std::fs::remove_file(&path)?;
    println!(
        "{} Forgot saved token at {}",
        style("✓").green().bold(),
        path.display()
    );
    Ok(())
}
