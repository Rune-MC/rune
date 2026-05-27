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

pub fn save(store: &TokenStore) -> Result<()> {
    let path = token_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let raw = serde_json::to_string_pretty(store)?;
    write_private(&path, &raw)?;
    Ok(())
}

/// Set the entry for `registry`, replacing any existing one. Persists
/// the whole store back to disk in one atomic-ish write.
pub fn put(registry: &url::Url, entry: TokenEntry) -> Result<()> {
    let mut store = load()?;
    store.entries.insert(canonical_registry(registry), entry);
    save(&store)
}

pub fn get(registry: &url::Url) -> Result<Option<TokenEntry>> {
    let store = load()?;
    Ok(store.entries.get(&canonical_registry(registry)).cloned())
}

pub fn remove(registry: &url::Url) -> Result<bool> {
    let mut store = load()?;
    let removed = store.entries.remove(&canonical_registry(registry)).is_some();
    if removed {
        save(&store)?;
    }
    Ok(removed)
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

#[cfg(unix)]
fn write_private(path: &std::path::Path, contents: &str) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
        .with_context(|| format!("opening {}", path.display()))?;
    f.write_all(contents.as_bytes())?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &std::path::Path, contents: &str) -> Result<()> {
    // Windows: rely on the per-user ACL on %APPDATA%. There's no portable
    // analogue to chmod 0o600 short of dropping into win32 APIs.
    std::fs::write(path, contents)
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}
