//! Token storage at `~/.config/rune/token` (cross-platform via `dirs`).
//!
//! The file holds a JSON object keyed by registry URL so a single user
//! can hold credentials for prod and a dev Runebook at the same time
//! without one clobbering the other:
//!
//! ```json
//! {
//!   "https://runemc.dev":     { "token": "rune_pat_…", "username": "alice" },
//!   "http://localhost:3000":  { "token": "rune_pat_…", "username": "alice" }
//! }
//! ```
//!
//! Permissions: 0o600 on Unix; on Windows we lean on the per-user AppData
//! ACL the OS already applies. Either way, never the world-readable
//! `/etc/passwd`-style permissions.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TokenStore {
    #[serde(default, flatten)]
    pub entries: BTreeMap<String, TokenEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenEntry {
    pub token: String,
    /// Cached display name from the registry's whoami response. Refreshed
    /// each time we successfully authenticate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

pub fn token_path() -> Result<PathBuf> {
    if let Some(dir) = std::env::var_os("RUNE_CONFIG_DIR").filter(|dir| !dir.is_empty()) {
        return Ok(PathBuf::from(dir).join("token"));
    }
    // `dirs::config_dir()` returns:
    //   * Linux:   ~/.config            -> ~/.config/rune/token
    //   * macOS:   ~/Library/Application Support -> .../rune/token
    //   * Windows: %APPDATA%             -> %APPDATA%/rune/token
    // All three are private-by-default for the current user.
    let dir = dirs::config_dir()
        .ok_or_else(|| anyhow!("could not resolve user config directory"))?;
    Ok(dir.join("rune").join("token"))
}

pub fn load() -> Result<TokenStore> {
    let path = token_path()?;
    if !path.exists() {
        return Ok(TokenStore::default());
    }
    let raw = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    let store: TokenStore = serde_json::from_str(&raw)
        .with_context(|| format!("parsing {}", path.display()))?;
    Ok(store)
}

fn save(store: &TokenStore) -> Result<()> {
    let path = token_path()?;
    let parent = path.parent().context("token path has no parent")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer_pretty(&mut file, store)?;
    file.flush()?;
    file.persist(&path)
        .with_context(|| format!("saving {}", path.display()))?;
    Ok(())
}

/// Set the entry for `registry`, replacing any existing one. Persists
/// the whole store back to disk in one atomic-ish write.
pub fn put(registry: &url::Url, entry: TokenEntry) -> Result<()> {
    let _lock = lock_config()?;
    let mut store = load()?;
    store.entries.insert(canonical_registry(registry), entry);
    save(&store)
}

pub fn get(registry: &url::Url) -> Result<Option<TokenEntry>> {
    let store = load()?;
    Ok(store.entries.get(&canonical_registry(registry)).cloned())
}

pub fn clear() -> Result<bool> {
    let _lock = lock_config()?;
    match std::fs::remove_file(token_path()?) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn lock_config() -> Result<File> {
    let path = token_path()?;
    let parent = path.parent().context("token path has no parent")?;
    std::fs::create_dir_all(parent)?;
    let lock = OpenOptions::new().write(true).create(true).truncate(false)
        .open(parent.join(".token.lock"))?;
    lock.try_lock().context("another Rune command is updating saved credentials")?;
    Ok(lock)
}

/// Strip trailing slash + lowercase scheme + host. So `HTTPS://Runemc.dev/`
/// and `https://runemc.dev` hash to the same store key.
fn canonical_registry(u: &url::Url) -> String {
    let mut s = u.as_str().trim_end_matches('/').to_string();
    // The scheme+host are case-insensitive; the path is not. Lowercase
    // the prefix only.
    if let Some(rest) = s.strip_prefix("https://") {
        s = format!("https://{}", rest.to_lowercase());
    } else if let Some(rest) = s.strip_prefix("http://") {
        s = format!("http://{}", rest.to_lowercase());
    }
    s
}
