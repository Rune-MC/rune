//! SHA-256 helpers.
//!
//! Hashes are a security boundary, not a corruption check (SPEC.md §9).
//! Everything that touches blob or manifest identity goes through here so
//! there's one place to audit the algorithm choice + serialisation format.

use std::fmt;

use sha2::{Digest, Sha256};

/// 32-byte SHA-256 digest. We pass these around as a typed value
/// (instead of `[u8; 32]` raw) so a function signature alone tells you
/// which slot a hash plugs into: blob, manifest, archive, version.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Hash([u8; 32]);

impl Hash {
    pub fn of_bytes(bytes: &[u8]) -> Self {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        Self(hasher.finalize().into())
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    /// Canonical wire form: lowercase hex with the `sha256:` prefix. Same
    /// shape the manifest JSON uses and the registry API expects.
    pub fn to_wire(self) -> String {
        format!("sha256:{}", hex::encode(self.0))
    }

    pub fn from_wire(s: &str) -> Option<Self> {
        let hex = s.strip_prefix("sha256:")?;
        let bytes = hex::decode(hex).ok()?;
        if bytes.len() != 32 {
            return None;
        }
        let mut out = [0u8; 32];
        out.copy_from_slice(&bytes);
        Some(Self(out))
    }
}

impl fmt::Debug for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Hash({})", self.to_wire())
    }
}

impl fmt::Display for Hash {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_wire())
    }
}

impl serde::Serialize for Hash {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_wire())
    }
}

impl<'de> serde::Deserialize<'de> for Hash {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Self::from_wire(&s).ok_or_else(|| serde::de::Error::custom("expected sha256:<64-hex>"))
    }
}
