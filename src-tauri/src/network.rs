//! Settings → Netzwerk: proxy password, connection test, PAC download, CA file summary
//! and the network configuration of Git. The decisions live in `annalo_core::network`.

use std::time::Instant;

use annalo_core::Error;
use annalo_core::gitsync::Git;
use annalo_core::network::{self as core, CaInfo, NetworkSettings, Purpose, SystemProxy};
use annalo_core::settings::Settings;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{AppState, Result};

/// File the Git CA bundle (extra CA + system CAs) is written to, in the data folder.
const GIT_CA_BUNDLE: &str = "network-ca-bundle.pem";

/// Git for `remote_url` with the token and the proxy/CA settings.
pub fn git(state: &AppState, token: Option<String>, remote_url: &str) -> Git {
    let settings = state.settings();
    let net = &settings.network;
    let system = if net.mode == core::ProxyMode::System { core::system_proxy() } else { SystemProxy::default() };
    // Windows' Git verifies with the Windows certificate store (schannel); `http.sslCAInfo`
    // would replace it, so the bundle is only used on other systems.
    let bundle = match (&net.extra_ca_path, cfg!(windows)) {
        (Some(ca), false) => {
            let out = state.data_dir.join(GIT_CA_BUNDLE);
            match core::write_git_ca_bundle(ca, &out) {
                Ok(()) => Some(out.display().to_string()),
                Err(e) => {
                    eprintln!("git CA bundle: {e}");
                    None
                }
            }
        }
        _ => None,
    };
    let password = state.proxy_secret.get();
    Git::new(token, remote_url).with_network(core::git_network(
        net,
        password.as_deref(),
        remote_url,
        &system,
        bundle.as_deref(),
    ))
}

#[derive(Serialize)]
pub struct NetworkStatus {
    password_set: bool,
    /// The operating system's proxy (shown in mode „System“).
    system: SystemProxy,
    /// The configured CA file, or why it cannot be used.
    ca: Option<CaInfo>,
    ca_error: Option<String>,
    platform: &'static str,
}

fn status_of(state: &AppState, settings: &Settings) -> NetworkStatus {
    let (ca, ca_error) = match &settings.network.extra_ca_path {
        Some(p) => match core::ca_info_file(p) {
            Ok(i) => (Some(i), None),
            Err(e) => (None, Some(e.to_string())),
        },
        None => (None, None),
    };
    NetworkStatus {
        password_set: state.proxy_secret.get().is_some(),
        system: without_credentials(core::system_proxy()),
        ca,
        ca_error,
        platform: std::env::consts::OS,
    }
}

/// The system proxy for display: user names and passwords (e.g. in `HTTPS_PROXY`) are removed.
fn without_credentials(mut sp: SystemProxy) -> SystemProxy {
    for p in [&mut sp.http, &mut sp.https, &mut sp.socks] {
        *p = p.as_deref().map(core::display_proxy);
    }
    sp
}

#[tauri::command(async)]
pub fn network_status(state: State<'_, AppState>) -> NetworkStatus {
    status_of(&state, &state.settings())
}

/// Stores (or with `None`, removes) the proxy password in the credential store and rebuilds
/// the clients.
#[tauri::command(async)]
pub fn proxy_password_set(app: AppHandle, password: Option<String>) -> Result<NetworkStatus> {
    let state = app.state::<AppState>();
    state.proxy_secret.set(password.as_deref()).map_err(Error::State)?;
    crate::rebuild_ai(&state, state.settings());
    Ok(status_of(&state, &state.settings()))
}

/// Summary of a CA file (count, first subject, expiry) for the file picker.
#[tauri::command(async)]
pub fn network_ca_info(path: String) -> Result<CaInfo> {
    core::ca_info_file(path.trim())
}

/// Downloads a PAC file for the UI, which evaluates it.
#[tauri::command]
pub async fn network_fetch_pac(
    state: State<'_, AppState>,
    url: String,
    network: Option<NetworkSettings>,
) -> Result<String> {
    let net = network.unwrap_or_else(|| state.settings().network);
    core::fetch_pac(&net, url.trim()).await
}

#[derive(Serialize)]
pub struct NetworkTest {
    ok: bool,
    /// The URL that was tested (LiteLLM's model list).
    url: String,
    /// Proxy used for it (without credentials); `None` = direct.
    proxy: Option<String>,
    status: Option<u16>,
    latency_ms: u64,
    error: Option<String>,
}

/// Requests `<LiteLLM>/v1/models` with the given (unsaved) network settings and reports the
/// proxy that was chosen for it. An unsaved password can be tested too.
#[tauri::command]
pub async fn network_test(
    state: State<'_, AppState>,
    network: Option<NetworkSettings>,
    base_url: Option<String>,
    password: Option<String>,
) -> Result<NetworkTest> {
    let settings = state.settings();
    let net = match network {
        Some(n) => n.normalized()?,
        None => settings.network.clone(),
    };
    let base = base_url.unwrap_or(settings.litellm_base_url).trim().trim_end_matches('/').to_owned();
    let url = format!("{base}/v1/models");
    let password = password.filter(|p| !p.is_empty()).or_else(|| state.proxy_secret.get());
    let prepared = core::Prepared::new(&net, password.as_deref(), Purpose::Ai)?;
    let proxy =
        prepared.plan().and_then(|p| p.resolve_str(&url).ok().flatten()).map(|u| core::display_proxy(u.as_str()));
    let client = prepared.client()?;
    let mut req = client.get(&url).timeout(net.timeout());
    if let Some(k) = state.secrets.get() {
        req = req.bearer_auth(k);
    }
    let start = Instant::now();
    let res = req.send().await;
    let latency_ms = start.elapsed().as_millis() as u64;
    Ok(match res {
        Ok(r) => {
            let status = r.status().as_u16();
            let ok = r.status().is_success();
            let error = (!ok).then(|| format!("HTTP {status}"));
            NetworkTest { ok, url, proxy, status: Some(status), latency_ms, error }
        }
        Err(e) => {
            let mut msg = e.to_string();
            let mut source = std::error::Error::source(&e);
            while let Some(s) = source {
                msg.push_str(&format!(": {s}"));
                source = s.source();
            }
            if let Some(p) = &password {
                msg = msg.replace(p.as_str(), "***");
            }
            NetworkTest { ok: false, url, proxy, status: None, latency_ms, error: Some(msg) }
        }
    })
}

/// The page of the `annalo-pac:` scheme: a sandboxed frame (opaque origin, no IPC) in which
/// the UI evaluates PAC scripts. PAC files are JavaScript; the app's own pages forbid
/// `eval`, this frame allows it and nothing else (no network, no storage).
pub fn pac_sandbox() -> tauri::http::Response<Vec<u8>> {
    const PAGE: &str = r#"<!doctype html><meta charset="utf-8"><title>PAC</title><script>
addEventListener("message", function (e) {
  var d = e.data || {}, r;
  try { r = { id: d.id, ok: true, value: String(new Function(d.code)()) }; }
  catch (x) { r = { id: d.id, ok: false, error: String((x && x.message) || x) }; }
  parent.postMessage(r, "*");
});
parent.postMessage({ ready: true }, "*");
</script>"#;
    tauri::http::Response::builder()
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'")
        .header("Cache-Control", "no-store")
        .body(PAGE.as_bytes().to_vec())
        .unwrap_or_default()
}
