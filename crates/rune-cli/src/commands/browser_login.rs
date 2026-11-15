use std::io::IsTerminal;
use std::time::Duration;

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, RngCore};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::{sleep, timeout};
use url::Url;

const CALLBACK_PATH: &str = "/rune/login";

#[derive(Serialize)]
struct Callback {
    uri: String,
    state: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    device_code: String,
    user_code: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
enum AuthStatus {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Approved { token: String },
}

struct BrowserCallback {
    listener: TcpListener,
    params: Callback,
}

impl BrowserCallback {
    async fn bind() -> Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listener,
            params: Callback {
                uri: format!("http://127.0.0.1:{port}{CALLBACK_PATH}"),
                state: secret(),
            },
        })
    }

    async fn wait(&self) {
        while let Ok((mut stream, _)) = self.listener.accept().await {
            let completed = timeout(
                Duration::from_secs(2),
                accept_callback(&mut stream, &self.params.state),
            )
            .await;
            if completed.is_ok_and(|valid| valid) {
                return;
            }
        }
    }
}

pub async fn run(registry: &Url, force_device: bool) -> Result<String> {
    ensure!(
        registry.scheme() == "https"
            || registry.scheme() == "http"
                && matches!(
                    registry.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]")
                ),
        "browser sign-in requires an HTTPS registry"
    );
    let http = reqwest::Client::builder()
        .user_agent(concat!("rune-cli/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let verifier = secret();
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(&verifier));
    let mut callback = if !force_device && desktop_session() {
        BrowserCallback::bind().await.ok()
    } else {
        None
    };
    let login: LoginRequest = auth_request(
        &http,
        registry.join("/api/auth/cli/start")?,
        serde_json::json!({ "challenge": challenge, "callback": callback.as_ref().map(|c| &c.params) }),
    )
    .await?;

    let web = registry.join("/cli/login")?;
    let code = &login.user_code;
    ensure!(
        code.len() == 12 && code.bytes().all(|b| b.is_ascii_hexdigit()),
        "registry returned an invalid terminal code"
    );
    println!(
        "Terminal code: {}-{}-{}",
        &code[..4],
        &code[4..8],
        &code[8..]
    );
    if callback.is_some() {
        let mut link = web.clone();
        link.query_pairs_mut().append_pair("code", code);
        if open_browser(&link).await {
            println!("Approve sign-in in your browser. You can also open {web} on another device.");
        } else {
            println!("Couldn't open the browser. Open {web} and enter the terminal code.");
            callback = None;
        }
    } else {
        println!("Open {web} on another device and enter the terminal code.");
    }
    println!("Waiting for approval. Press Ctrl+C to cancel.");

    timeout(
        Duration::from_secs(login.expires_in.min(600)),
        redeem(
            &http,
            registry.join("/api/auth/cli/token")?,
            &login,
            &verifier,
            callback,
        ),
    )
    .await
    .context("sign-in expired. Run rune login again.")?
}

async fn redeem(
    http: &reqwest::Client,
    endpoint: Url,
    login: &LoginRequest,
    verifier: &str,
    mut callback: Option<BrowserCallback>,
) -> Result<String> {
    let mut interval = Duration::from_secs(login.interval.clamp(5, 60));
    let payload = serde_json::json!({ "deviceCode": login.device_code, "verifier": verifier });
    loop {
        if let Some(listener) = &callback {
            tokio::select! {
                _ = sleep(interval) => {},
                _ = listener.wait() => callback = None,
            }
        } else {
            sleep(interval).await;
        }
        match auth_request(http, endpoint.clone(), &payload).await {
            Ok(AuthStatus::Approved { token }) => return Ok(token),
            Ok(AuthStatus::Pending) => {}
            Ok(AuthStatus::SlowDown) => interval += Duration::from_secs(5),
            Ok(AuthStatus::Expired) => bail!("sign-in expired. Run rune login again."),
            Ok(AuthStatus::Denied) => bail!("Runebook declined this sign-in."),
            Err(error)
                if error
                    .downcast_ref::<reqwest::Error>()
                    .is_some_and(|e| e.is_timeout() || e.is_connect()) =>
            {
                interval = (interval * 2).min(Duration::from_secs(60));
            }
            Err(error) => return Err(error),
        }
    }
}

async fn auth_request<T: DeserializeOwned>(
    http: &reqwest::Client,
    endpoint: Url,
    payload: impl Serialize,
) -> Result<T> {
    #[derive(Deserialize)]
    struct Envelope<T> {
        data: Option<T>,
        message: Option<String>,
    }

    let response = http.post(endpoint).json(&payload).send().await?;
    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        bail!("this registry does not support browser sign-in. Use rune login --token <PAT>.");
    }
    let envelope: Envelope<T> = response
        .json()
        .await
        .context("reading Runebook sign-in response")?;
    envelope.data.with_context(|| {
        envelope
            .message
            .unwrap_or_else(|| format!("Runebook returned {status}"))
    })
}

fn secret() -> String {
    let mut bytes = [0; 32];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

async fn accept_callback(stream: &mut TcpStream, state: &str) -> bool {
    let mut request = Vec::new();
    loop {
        let mut chunk = [0; 512];
        let Ok(size) = stream.read(&mut chunk).await else {
            return false;
        };
        if size == 0 {
            return false;
        }
        request.extend_from_slice(&chunk[..size]);
        if request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
            break;
        }
        if request.len() > 8192 {
            return false;
        }
    }
    let valid = callback_matches(&request, state);
    let (status, body) = if valid {
        (
            "200 OK",
            "Rune CLI sign-in approved. Return to your terminal.",
        )
    } else {
        ("404 Not Found", "This is not a valid Rune CLI callback.")
    };
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    valid
}

fn callback_matches(request: &[u8], state: &str) -> bool {
    std::str::from_utf8(request)
        .ok()
        .and_then(|request| request.lines().next())
        .and_then(|line| line.strip_prefix("GET ")?.split_once(' '))
        .and_then(|(target, _)| target.strip_prefix(CALLBACK_PATH)?.strip_prefix('?'))
        .is_some_and(|query| {
            url::form_urlencoded::parse(query.as_bytes())
                .any(|(key, value)| key == "state" && value == state)
        })
}

fn desktop_session() -> bool {
    use std::env::var_os;
    if !std::io::stdin().is_terminal()
        || !std::io::stdout().is_terminal()
        || ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]
            .iter()
            .any(|key| var_os(key).is_some())
    {
        return false;
    }
    match std::env::consts::OS {
        "windows" => std::env::var("SESSIONNAME")
            .is_ok_and(|name| name.eq_ignore_ascii_case("console") || name.starts_with("RDP-")),
        "macos" => true,
        "linux" => ["WAYLAND_DISPLAY", "DISPLAY"]
            .iter()
            .any(|key| var_os(key).is_some_and(|value| !value.is_empty())),
        _ => false,
    }
}

async fn open_browser(url: &Url) -> bool {
    use tokio::process::Command;
    let mut command = match std::env::consts::OS {
        "windows" => {
            let mut command = Command::new("rundll32.exe");
            command.arg("url.dll,FileProtocolHandler");
            command
        }
        "macos" => Command::new("open"),
        _ => Command::new("xdg-open"),
    };
    command
        .arg(url.as_str())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    timeout(Duration::from_secs(5), command.status())
        .await
        .is_ok_and(|status| status.is_ok_and(|status| status.success()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_requires_correct_path_and_state() {
        assert!(callback_matches(
            b"GET /rune/login?state=secret HTTP/1.1\r\n\r\n",
            "secret"
        ));
        assert!(!callback_matches(
            b"GET /rune/login?state=wrong HTTP/1.1\r\n\r\n",
            "secret"
        ));
        assert!(!callback_matches(
            b"GET /wrong?state=secret HTTP/1.1\r\n\r\n",
            "secret"
        ));
        assert!(!callback_matches(
            b"POST /rune/login?state=secret HTTP/1.1\r\n\r\n",
            "secret"
        ));
    }
}
