//! HTTP client for the Runebook API.
//!
//! Lifecycle of a publish:
//!   1. `POST /api/v1/blobs/check`  — which hashes are already in R2?
//!   2. `POST /api/v1/runes/:name/versions` — submit the manifest; get
//!      pre-signed PUT URLs for missing blobs.
//!   3. `PUT <signed url>` (one per missing blob) — direct to R2.
//!   4. `POST /api/v1/runes/:name/versions/:version/finalize` — commit.
//!   5. Optionally `POST .../yank` (used for `--draft` publishes).
//!
//! Every CLI-authenticated call carries `Authorization: Bearer rune_pat_…`.
//! R2 PUTs are unauthenticated against our API — they use the pre-signed
//! URL's own signature.
//!
//! ## Response envelope
//!
//! Every Runebook JSON response is shaped:
//!
//! ```json
//! { "success": true,  "code": 200, "data": <T> }
//! { "success": false, "code": 422, "error": "VALIDATION_ERROR",
//!   "message": "…", "details": <optional> }
//! ```
//!
//! We unwrap `data` into the caller's response type and translate the
//! error envelope into a readable anyhow error.

use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HeaderMap, HeaderValue, USER_AGENT,
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::hash::Hash;
use crate::manifest::Manifest;

/// `User-Agent` is shown in the registry's request logs so operators can
/// trace which CLI build hit them. Format mirrors how npm and cargo
/// identify themselves.
const UA: &str = concat!("rune-cli/", env!("CARGO_PKG_VERSION"));

/// URL-encode a rune name for use as a single dynamic path segment.
///
/// Next.js's `[name]` dynamic segments match exactly one path component;
/// a literal `/` inside the name (as in `@hylandia/core`) breaks the
/// match and routes to 404. Percent-encoding the slash as `%2F` puts the
/// name back into a single component, and Next.js decodes it before
/// handing the value to the route handler — so on the server side
/// `params.name` reads back as `@hylandia/core` unchanged.
///
/// We also encode `@` for symmetry, even though the apex char is legal
/// in URL paths — keeps the resulting URL purely ASCII-letter+digit
/// plus percent escapes, which avoids surprises from any intermediate
/// proxy that decides to "normalize" the path.
fn encode_name_segment(name: &str) -> String {
    name.replace('@', "%40").replace('/', "%2F")
}

pub struct Client {
    base: url::Url,
    http: reqwest::Client,
    token: String,
}

impl Client {
    pub fn new(base: url::Url, token: String) -> Result<Self> {
        let mut default_headers = HeaderMap::new();
        default_headers.insert(USER_AGENT, HeaderValue::from_static(UA));
        default_headers.insert(ACCEPT, HeaderValue::from_static("application/json"));

        let http = reqwest::Client::builder()
            // Publish requests routinely hit a server while it's verifying
            // dozens of blobs in R2. 30s is comfortable headroom; tighten
            // once we measure real timing.
            .timeout(Duration::from_secs(30))
            .default_headers(default_headers)
            .build()
            .context("building HTTP client")?;
        Ok(Self { base, http, token })
    }

    fn auth_header(&self) -> Result<HeaderValue> {
        HeaderValue::from_str(&format!("Bearer {}", self.token))
            .context("token contains characters not valid in an Authorization header")
    }

    fn url(&self, path: &str) -> Result<url::Url> {
        Ok(self.base.join(path)?)
    }

    /// Quick existence check before the heavy publish call. Saves us
    /// re-encoding + re-uploading blobs the registry has already seen
    /// (most likely the @rune/sdk and other transitive deps).
    pub async fn blobs_check(&self, hashes: &[Hash]) -> Result<BlobsCheckResponse> {
        let url = self.url("/api/v1/blobs/check")?;
        let body = BlobsCheckRequest {
            hashes: hashes.iter().map(|h| h.to_wire()).collect(),
        };
        let resp = self
            .http
            .post(url)
            .header(AUTHORIZATION, self.auth_header()?)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .context("POST /api/v1/blobs/check")?;
        unwrap_envelope(resp, "blobs/check").await
    }

    /// Submit the manifest. The registry checks ownership + version
    /// uniqueness + capability shape, returns signed R2 URLs for every
    /// blob it doesn't already have.
    ///
    /// `visibility` is honored only on the FIRST publish of a rune —
    /// subsequent versions inherit whatever was set when the rune was
    /// created (the registry ignores it on existing runes). Visibility
    /// changes after first publish go through a separate
    /// `PATCH /api/v1/runes/:name/visibility` endpoint.
    pub async fn create_version(
        &self,
        manifest: &Manifest,
        visibility: Option<Visibility>,
    ) -> Result<CreateVersionResponse> {
        let url = self.url(&format!(
            "/api/v1/runes/{}/versions",
            encode_name_segment(&manifest.name)
        ))?;
        let body = CreateVersionRequest { manifest, visibility };
        let resp = self
            .http
            .post(url)
            .header(AUTHORIZATION, self.auth_header()?)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .context("POST /api/v1/runes/:name/versions")?;
        unwrap_envelope(resp, "create-version").await
    }

    /// Upload one blob directly to R2 via a pre-signed PUT URL the
    /// registry handed back from `create_version`. The signature is on
    /// the URL — no auth header.
    pub async fn upload_blob(&self, signed_url: &str, bytes: Vec<u8>) -> Result<()> {
        // R2 (via the AWS SigV4 PUT signature) requires Content-Length.
        // reqwest infers it from a `Vec<u8>` body for non-empty payloads
        // but omits the header on zero-byte uploads, which R2 rejects
        // with 411. Set it explicitly so empty blobs (sha256:e3b0…b855)
        // also succeed.
        let content_length = bytes.len() as u64;
        let resp = self
            .http
            .put(signed_url)
            // `If-None-Match: *` enforces the immutability invariant
            // server-side: R2 refuses to overwrite an existing object,
            // so a hash collision on a different content wins-the-race
            // produces a 4xx rather than silently corrupting the bucket.
            .header("If-None-Match", "*")
            .header(CONTENT_TYPE, "application/octet-stream")
            .header(CONTENT_LENGTH, content_length)
            .body(bytes)
            .send()
            .await
            .context("PUT to R2 signed URL")?;
        if !resp.status().is_success() {
            // R2 may return 412 from `If-None-Match: *` when the blob is
            // already present. The intended state holds; treat as success.
            if resp.status() == reqwest::StatusCode::PRECONDITION_FAILED {
                return Ok(());
            }
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(if body.is_empty() {
                anyhow!("R2 returned {status}")
            } else {
                anyhow!("R2 returned {status}: {body}")
            });
        }
        Ok(())
    }

    /// Commit. Idempotent in spirit — but the server returns 409 if the
    /// version is already finalised. Callers that want "publish-or-noop"
    /// behaviour should treat 409 as success.
    pub async fn finalize(&self, name: &str, version: &str) -> Result<FinalizeResponse> {
        let url = self.url(&format!(
            "/api/v1/runes/{}/versions/{version}/finalize",
            encode_name_segment(name)
        ))?;
        let resp = self
            .http
            .post(url)
            .header(AUTHORIZATION, self.auth_header()?)
            .header(CONTENT_TYPE, "application/json")
            // The endpoint takes no body, but sending an empty JSON object
            // keeps proxies that strip zero-length POST bodies happy.
            .json(&serde_json::json!({}))
            .send()
            .await
            .context("POST .../finalize")?;
        unwrap_envelope(resp, "finalize").await
    }

    /// Mark a finalised version as yanked. Used by `rune publish --draft`
    /// to keep new versions out of search results until the author
    /// explicitly re-publishes without the flag.
    pub async fn yank(&self, name: &str, version: &str, reason: &str) -> Result<YankResponse> {
        let url = self.url(&format!(
            "/api/v1/runes/{}/versions/{version}/yank",
            encode_name_segment(name)
        ))?;
        let body = YankRequest { reason };
        let resp = self
            .http
            .post(url)
            .header(AUTHORIZATION, self.auth_header()?)
            .header(CONTENT_TYPE, "application/json")
            .json(&body)
            .send()
            .await
            .context("POST .../yank")?;
        unwrap_envelope(resp, "yank").await
    }

    /// `GET /api/v1/runes/:name` — resolve the rune's metadata, including
    /// the latest released version. Used by `rune add <name>` (no version
    /// pin) to decide which version to fetch.
    pub async fn get_rune(&self, name: &str) -> Result<RuneSummary> {
        let url = self.url(&format!("/api/v1/runes/{}", encode_name_segment(name)))?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .context("GET /api/v1/runes/:name")?;
        unwrap_envelope(resp, "get-rune").await
    }

    /// `GET /api/v1/runes/:name/v/:version/manifest` — pulls the canonical
    /// manifest JSON via R2 (the route 302's to a signed URL). The body
    /// is the raw manifest, not the API envelope, so we deserialize
    /// directly.
    pub async fn get_manifest(&self, name: &str, version: &str) -> Result<Manifest> {
        let url = self.url(&format!(
            "/api/v1/runes/{}/v/{version}/manifest",
            encode_name_segment(name)
        ))?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .context("GET /api/v1/runes/:name/v/:version/manifest")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(if body.is_empty() {
                anyhow!("manifest fetch returned {status}")
            } else {
                anyhow!("manifest fetch returned {status}: {body}")
            });
        }
        let bytes = resp.bytes().await.context("reading manifest body")?;
        serde_json::from_slice(&bytes).context("decoding manifest JSON")
    }

    /// `GET /api/v1/blobs/:hash` — fetches one content-addressed blob,
    /// following the 302 redirect to R2. `hash_hex` is the bare 64-char
    /// hex digest (no `sha256:` prefix — that's the wire format for
    /// manifests, not blob URLs).
    pub async fn get_blob(&self, hash_hex: &str) -> Result<Vec<u8>> {
        let url = self.url(&format!("/api/v1/blobs/{hash_hex}"))?;
        let resp = self
            .http
            .get(url)
            .send()
            .await
            .context("GET /api/v1/blobs/:hash")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(if body.is_empty() {
                anyhow!("blob fetch returned {status}")
            } else {
                anyhow!("blob fetch returned {status}: {body}")
            });
        }
        let bytes = resp.bytes().await.context("reading blob body")?;
        Ok(bytes.to_vec())
    }

    /// `GET /api/v1/whoami` — confirms the saved token still maps to a
    /// user. Used by `rune login` (pre-save validation) and `rune whoami`.
    pub async fn whoami(&self) -> Result<WhoamiResponse> {
        let url = self.url("/api/v1/whoami")?;
        let resp = self
            .http
            .get(url)
            .header(AUTHORIZATION, self.auth_header()?)
            .send()
            .await
            .context("GET /api/v1/whoami")?;
        unwrap_envelope(resp, "whoami").await
    }
}

/// Decode the Runebook response envelope. On success, returns `data`. On
/// failure, formats the error envelope (or falls back to the raw body)
/// into an anyhow error.
async fn unwrap_envelope<T: DeserializeOwned>(
    resp: reqwest::Response,
    op: &str,
) -> Result<T> {
    let status = resp.status();
    let bytes = resp
        .bytes()
        .await
        .with_context(|| format!("reading {op} response body"))?;

    if status.is_success() {
        let env: SuccessEnvelope<T> = serde_json::from_slice(&bytes)
            .with_context(|| format!("decoding {op} success envelope"))?;
        return Ok(env.data);
    }

    // Try the structured error envelope first; fall back to raw text if
    // the response wasn't JSON (e.g. an upstream proxy 502 with HTML).
    if let Ok(err) = serde_json::from_slice::<ErrorEnvelope>(&bytes) {
        return Err(format_error_envelope(&err));
    }
    let body = String::from_utf8_lossy(&bytes);
    if body.is_empty() {
        Err(anyhow!("registry returned {status}"))
    } else {
        Err(anyhow!("registry returned {status}: {body}"))
    }
}

fn format_error_envelope(err: &ErrorEnvelope) -> anyhow::Error {
    // `VALIDATION_ERROR` carries a Zod issues array we can render nicely.
    // Everything else: just code + message.
    if err.error == "VALIDATION_ERROR" {
        if let Some(serde_json::Value::Array(issues)) = &err.details {
            let mut lines = vec![format!("{}: {}", err.error, err.message)];
            for issue in issues {
                let path = issue
                    .get("path")
                    .and_then(|p| p.as_array())
                    .map(|p| {
                        p.iter()
                            .filter_map(|s| s.as_str())
                            .collect::<Vec<_>>()
                            .join(".")
                    })
                    .unwrap_or_default();
                let msg = issue
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("(no message)");
                lines.push(format!("  - {path}: {msg}"));
            }
            return anyhow!(lines.join("\n"));
        }
    }
    anyhow!("{}: {}", err.error, err.message)
}

#[derive(Debug, Deserialize)]
struct SuccessEnvelope<T> {
    #[allow(dead_code)]
    success: bool,
    #[allow(dead_code)]
    code: u16,
    data: T,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    #[allow(dead_code)]
    #[serde(default)]
    success: bool,
    #[allow(dead_code)]
    #[serde(default)]
    code: u16,
    error: String,
    message: String,
    #[serde(default)]
    details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct BlobsCheckRequest {
    hashes: Vec<String>,
}

// Types below describe the on-the-wire API contract. Some fields we
// don't currently consume on the CLI side (e.g. `expires_at`) but they
// stay declared so anyone reading the struct sees the full shape of
// what the registry sends back.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct BlobsCheckResponse {
    pub present: Vec<String>,
    pub missing: Vec<String>,
}

#[derive(Debug, Serialize)]
struct CreateVersionRequest<'a> {
    manifest: &'a Manifest,
    // Omitted from the wire when the caller didn't pass --private/--public;
    // the registry's default is "public", so leaving the field off matches
    // pre-flag behaviour exactly.
    #[serde(skip_serializing_if = "Option::is_none")]
    visibility: Option<Visibility>,
}

/// Mirrors the Zod enum on the website side:
/// `z.enum(["public", "private"]).optional()`. Lowercased on the wire.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Visibility {
    Public,
    Private,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct CreateVersionResponse {
    pub version_id: String,
    pub manifest_hash: String,
    #[serde(default)]
    pub missing_blobs: Vec<MissingBlob>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct MissingBlob {
    pub hash: String,
    pub upload_url: String,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct FinalizeResponse {
    pub name: String,
    pub version: String,
    pub manifest_hash: String,
    pub install: String,
}

#[derive(Debug, Serialize)]
struct YankRequest<'a> {
    reason: &'a str,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct YankResponse {
    pub name: String,
    pub version: String,
    pub yanked: bool,
    pub reason: String,
}

/// `GET /api/v1/runes/:name` response. Only the fields the CLI actually
/// reads are typed — the registry returns more (owners, descriptions,
/// timestamps) that we ignore.
#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct RuneSummary {
    pub name: String,
    #[serde(default)]
    pub latest_version: Option<String>,
    #[serde(default)]
    pub versions: Vec<RuneVersionSummary>,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct RuneVersionSummary {
    pub version: String,
    pub manifest_hash: String,
    #[serde(default)]
    pub yanked: bool,
}

#[allow(dead_code)]
#[derive(Debug, Deserialize)]
pub struct WhoamiResponse {
    pub username: String,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    /// `"cli"` when the request authenticated with a PAT, `"session"`
    /// when a browser cookie was used. Always `"cli"` for us.
    #[serde(default)]
    pub via: Option<String>,
    /// PAT scopes when `via == "cli"`; `None` when the registry response
    /// was a session login.
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
}
