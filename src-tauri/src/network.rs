//! Settings → Netzwerk: proxy profiles and their passwords, the profile of each service with
//! its route and a real test per service, trusted servers („Zertifikat anzeigen und
//! vertrauen“), PAC download, CA file summary, the admin policy, and the client and Git
//! environment every outgoing connection gets. The decisions live in `annalo_core::network`.

use std::collections::{BTreeMap, HashMap};
use std::time::Instant;

use annalo_core::Error;
use annalo_core::gitsync::Git;
use annalo_core::network::{
    self as core, CaInfo, CertDetails, DEFAULT_PROFILE, NetworkSettings, ProxyProfile, RouteInfo, Service, SystemProxy,
};
use annalo_core::settings::Settings;
use annalo_core::{tr, trf};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::secrets::SecretStore;
use crate::{AppState, Result, devlog};

/// File the Git CA bundle (extra CA + system CAs) is written to, in the data folder.
const GIT_CA_BUNDLE: &str = "network-ca-bundle.pem";

// ------------------------------------------------------------- resolver

/// The credential of a profile's proxy password.
pub fn secret(state: &AppState, profile_id: &str) -> SecretStore {
    SecretStore::proxy_profile(&state.data_dir, profile_id)
}

/// The proxy passwords of `net`'s profiles, by profile id (read once for a batch of clients).
pub fn passwords_of(data_dir: &std::path::Path, net: &NetworkSettings) -> HashMap<String, String> {
    net.profiles
        .iter()
        .filter_map(|p| SecretStore::proxy_profile(data_dir, &p.id).get().map(|pw| (p.id.clone(), pw)))
        .collect()
}

/// The network settings in force: the user's, with the routes an admin policy fixes.
pub fn effective(net: &NetworkSettings) -> NetworkSettings {
    let mut n = net.clone();
    crate::policy::get().network().apply(&mut n);
    n
}

/// Why `net` cannot be applied (a CA file of a profile is missing), for every request.
pub fn check(net: &NetworkSettings) -> std::result::Result<(), Error> {
    for p in &net.profiles {
        core::Prepared::new(p, None, &net.trusted_hosts)
            .map_err(|e| Error::State(format!("{} „{}“: {e}", tr!("Profil", "Profile"), p.name)))?;
    }
    Ok(())
}

/// The HTTP client of `service` with the current settings (cached until they change).
pub fn client_for(state: &AppState, service: &Service) -> Result<reqwest::Client> {
    let ai = state.ai.read().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = &ai.network_error {
        return Err(Error::State(e.clone()));
    }
    let key = service.key();
    if let Some(c) = crate::lock(&ai.http).get(&key) {
        return Ok(c.clone());
    }
    let net = effective(&ai.settings.network);
    let pw = |id: &str| secret(state, id).get();
    let client = core::client_for(&net, &pw, service)?;
    crate::lock(&ai.http).insert(key, client.clone());
    Ok(client)
}

/// Connect timeout of `service`'s profile (also the total timeout of tool requests, Jira and
/// calendar fetches).
pub fn timeout_for(state: &AppState, service: &Service) -> std::time::Duration {
    effective(&state.settings().network).timeout_for(service)
}

/// Git for `remote_url` with the token and the network of the Git sync.
pub fn git(state: &AppState, token: Option<String>, remote_url: &str) -> Git {
    git_with(state, &effective(&state.settings().network), token, remote_url, None)
}

/// Git with the given (possibly unsaved) settings; `password` replaces the stored one of the
/// Git sync's profile.
fn git_with(
    state: &AppState,
    net: &NetworkSettings,
    token: Option<String>,
    remote_url: &str,
    password: Option<&str>,
) -> Git {
    let service = Service::GitSync;
    let profile = net.profile_for(&service);
    let system = if profile.mode == core::ProxyMode::System { core::system_proxy() } else { SystemProxy::default() };
    // Windows' Git verifies with the Windows certificate store (schannel); `http.sslCAInfo`
    // would replace it, so the bundle is only used on other systems.
    let bundle = match (&profile.extra_ca_path, cfg!(windows)) {
        (Some(ca), false) => {
            let out = state.data_dir.join(GIT_CA_BUNDLE);
            match core::write_git_ca_bundle(ca, &out) {
                Ok(()) => Some(out.display().to_string()),
                Err(e) => {
                    devlog::warn("git", format!("CA bundle: {e}"));
                    None
                }
            }
        }
        _ => None,
    };
    let pw = |id: &str| match password {
        Some(p) if id == profile.id => Some(p.to_owned()),
        _ => secret(state, id).get(),
    };
    Git::new(token, remote_url).with_network(core::git_env_for(
        net,
        &pw,
        &service,
        remote_url,
        &system,
        bundle.as_deref(),
    ))
}

// ------------------------------------------------------------- status

#[derive(Serialize)]
pub struct NetworkPolicyView {
    /// Service key or group → profile id the policy fixes.
    routes: BTreeMap<String, String>,
    lock_profiles: bool,
    origins: Vec<String>,
}

#[derive(Serialize)]
pub struct NetworkStatus {
    /// The default profile has a stored password (kept for scripts of 1.9).
    password_set: bool,
    /// Ids of the profiles with a stored password.
    passwords: Vec<String>,
    /// The operating system's proxy (shown in mode „System“).
    system: SystemProxy,
    platform: &'static str,
    policy: NetworkPolicyView,
}

fn status_of(state: &AppState, settings: &Settings) -> NetworkStatus {
    let passwords: Vec<String> = settings
        .network
        .profiles
        .iter()
        .filter(|p| secret(state, &p.id).get().is_some())
        .map(|p| p.id.clone())
        .collect();
    let policy = crate::policy::get();
    let mut routes = BTreeMap::new();
    let mut net = settings.network.clone();
    policy.network().apply(&mut net);
    for k in policy.network_routes.keys() {
        if let Some(id) = net.routes.get(k) {
            routes.insert(k.clone(), id.clone());
        } else if !k.contains(':') {
            routes.insert(k.clone(), DEFAULT_PROFILE.to_owned());
        }
    }
    let managed = !policy.network_routes.is_empty() || policy.lock_network_profiles.is_some();
    NetworkStatus {
        password_set: passwords.iter().any(|p| p == DEFAULT_PROFILE),
        passwords,
        system: without_credentials(core::system_proxy()),
        platform: std::env::consts::OS,
        policy: NetworkPolicyView {
            routes,
            lock_profiles: policy.lock_network_profiles.unwrap_or(false),
            origins: if managed { policy.origins.clone() } else { vec![] },
        },
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

/// Stores (or with `None`, removes) a profile's proxy password in the credential store and
/// rebuilds the clients. Without `profile`: the default profile.
#[tauri::command(async)]
pub fn proxy_password_set(app: AppHandle, password: Option<String>, profile: Option<String>) -> Result<NetworkStatus> {
    let state = app.state::<AppState>();
    let id = profile.filter(|p| !p.trim().is_empty()).unwrap_or_else(|| DEFAULT_PROFILE.to_owned());
    if crate::policy::get().lock_network_profiles == Some(true) {
        return Err(Error::State(
            tr!(
                "Die Proxy-Profile werden von der Organisation verwaltet",
                "The proxy profiles are managed by your organization"
            )
            .into(),
        ));
    }
    secret(&state, &id).set(password.as_deref()).map_err(Error::State)?;
    devlog::remember_secret(password.as_deref());
    crate::rebuild_ai(&state, state.settings());
    Ok(status_of(&state, &state.settings()))
}

/// Summary of a CA file (count, first subject, expiry) for the file picker.
#[tauri::command(async)]
pub fn network_ca_info(path: String) -> Result<CaInfo> {
    core::ca_info_file(path.trim())
}

/// Downloads a PAC file for the UI, which evaluates it (directly, with the profile's CA).
#[tauri::command]
pub async fn network_fetch_pac(
    state: State<'_, AppState>,
    url: String,
    profile: Option<ProxyProfile>,
) -> Result<String> {
    let profile = profile.unwrap_or_else(|| state.settings().network.standard().clone());
    core::fetch_pac(&profile, url.trim()).await
}

// ------------------------------------------------------------- services

/// One row of the services table.
#[derive(Serialize)]
pub struct ServiceRow {
    key: String,
    group: &'static str,
    /// Provider, site or calendar name (empty for the fixed services).
    name: String,
    /// Scheme and host of the target (`None`: no fixed target).
    target: Option<String>,
    route: RouteInfo,
    /// The admin policy fixes the profile.
    locked: bool,
}

/// The target a service test requests, with what to send.
struct Target {
    url: String,
    /// Bearer or provider key, Jira needs none for `serverInfo`.
    auth: Option<(annalo_core::ai::provider::AiProvider, Option<String>)>,
}

/// The services of `settings` (switched-on providers, sites and calendars included).
fn services(settings: &Settings) -> Vec<(Service, String)> {
    let mut out = vec![(Service::Updates, String::new()), (Service::ReleaseNotes, String::new())];
    for p in settings.providers.iter().filter(|p| p.enabled) {
        out.push((p.service(), p.name.clone()));
    }
    for s in settings.jira.sites.iter().filter(|s| s.enabled) {
        out.push((Service::Jira(s.id.clone()), s.name.clone()));
    }
    out.push((Service::GitSync, String::new()));
    for c in settings.calendar.sources.iter().filter(|c| c.enabled && c.kind == annalo_core::calsync::IcsKind::Url) {
        out.push((Service::Ics(c.id.clone()), c.name.clone()));
    }
    out.push((Service::VoiceModels, String::new()));
    out.push((Service::LinkPreview, String::new()));
    out.push((Service::HttpTool, String::new()));
    out
}

/// What the test of `service` requests (`None`: no fixed target, or none configured).
fn target(app: &AppHandle, settings: &Settings, service: &Service) -> Option<Target> {
    let state = app.state::<AppState>();
    let url = match service {
        Service::Updates => crate::updates::feed_url(app)?,
        Service::ReleaseNotes => crate::updates::release_notes_url(env!("CARGO_PKG_VERSION")),
        Service::VoiceModels => crate::voice::model_source_url(&settings.voice.source_url)?,
        Service::Ai { id, .. } => {
            let p = settings.providers.iter().find(|p| &p.id == id)?;
            let key = state.provider_secret(id).get();
            return Some(Target {
                url: p.models_url().unwrap_or_else(|| p.base_url.trim_end_matches('/').to_owned()),
                auth: Some((p.clone(), key)),
            });
        }
        Service::Jira(id) => {
            let s = settings.jira.site(id)?;
            format!("{}/rest/api/2/serverInfo", s.url.trim().trim_end_matches('/'))
        }
        Service::GitSync => Some(settings.git_sync.remote_url.trim().to_owned()).filter(|u| !u.is_empty())?,
        Service::Ics(id) => crate::calsync::secret(&state, id).get()?,
        Service::LinkPreview | Service::HttpTool => return None,
    };
    Some(Target { url, auth: None })
}

/// The settings to show or test: the unsaved draft, else the saved ones; with the policy.
fn draft_or_saved(state: &AppState, network: Option<NetworkSettings>) -> Result<(Settings, NetworkSettings)> {
    let settings = state.settings();
    let net = match network {
        Some(n) => n.normalized()?,
        None => settings.network.clone(),
    };
    Ok((settings, effective(&net)))
}

/// The services table: each service, its profile and the route it takes now.
#[tauri::command(async)]
pub fn network_services(app: AppHandle, network: Option<NetworkSettings>) -> Result<Vec<ServiceRow>> {
    let state = app.state::<AppState>();
    let (settings, net) = draft_or_saved(&state, network)?;
    let policy = crate::policy::get().network();
    let system = core::system_proxy();
    Ok(services(&settings)
        .into_iter()
        .map(|(service, name)| {
            let url = target(&app, &settings, &service).map(|t| t.url);
            let http = url.as_deref().filter(|u| u.starts_with("http://") || u.starts_with("https://"));
            ServiceRow {
                key: service.key(),
                group: service.group(),
                name,
                target: url.as_deref().map(|u| if http.is_some() { core::redacted_target(u) } else { u.to_owned() }),
                route: core::describe_route(&net, &service, http, &system),
                locked: policy.locks(&service),
            }
        })
        .collect())
}

#[derive(Serialize)]
pub struct NetworkTest {
    ok: bool,
    /// What was tested (scheme and host; the full URL for the LiteLLM test of 1.9).
    url: String,
    /// Proxy used for it (without credentials); `None` = direct.
    proxy: Option<String>,
    route: Option<RouteInfo>,
    status: Option<u16>,
    latency_ms: u64,
    error: Option<String>,
    /// The server's certificate when the error is about it („Zertifikat anzeigen und vertrauen“).
    certificate: Option<CertDetails>,
}

fn error_text(e: &dyn std::error::Error, password: Option<&str>) -> String {
    let mut msg = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        let next = s.to_string();
        if !msg.contains(&next) {
            msg.push_str(&format!(": {next}"));
        }
        source = s.source();
    }
    if let Some(p) = password.filter(|p| !p.is_empty()) {
        msg = msg.replace(p, "***");
    }
    msg
}

/// Requests `url` the way `service` does and reports status, latency and route; on a
/// certificate error the server's certificate comes along.
async fn http_test(
    net: &NetworkSettings,
    service: &Service,
    target: Target,
    password: Option<String>,
    shown_url: String,
) -> Result<NetworkTest> {
    let profile = net.profile_for(service);
    let pw = |id: &str| if id == profile.id { password.clone() } else { None };
    let prepared = core::Prepared::for_service(net, &pw, service)?;
    let proxy = prepared.plan().resolve_str(&target.url).ok().flatten().map(|u| core::display_proxy(u.as_str()));
    let route = core::describe_route(net, service, Some(&target.url), &core::system_proxy());
    let client = prepared.client()?;
    let mut req = client.get(&target.url).timeout(profile.timeout());
    if let Some((provider, key)) = &target.auth {
        req = provider.authorize(req, key.as_deref());
    }
    let start = Instant::now();
    let res = req.send().await;
    let latency_ms = start.elapsed().as_millis() as u64;
    let mut t = NetworkTest {
        ok: false,
        url: shown_url,
        proxy,
        route: Some(route),
        status: None,
        latency_ms,
        error: None,
        certificate: None,
    };
    match res {
        Ok(r) => {
            let status = r.status();
            t.status = Some(status.as_u16());
            t.ok = status.is_success() || status.is_redirection();
            t.error = (!t.ok).then(|| format!("HTTP {}", status.as_u16()));
        }
        Err(e) => {
            let msg = error_text(&e, password.as_deref());
            if target.url.starts_with("https://") && core::is_certificate_error(&msg) {
                t.certificate = prepared.certificate(&target.url).await.ok().flatten();
            }
            t.error = Some(msg);
        }
    }
    devlog::debug(
        "net",
        format!(
            "test {} {} → {} ({})",
            service.key(),
            core::redacted_target(&target.url),
            t.route.as_ref().map(RouteInfo::summary).unwrap_or_default(),
            if t.ok {
                "ok".to_owned()
            } else {
                t.status.map(|s| format!("HTTP {s}")).unwrap_or_else(|| "error".into())
            }
        ),
    );
    Ok(t)
}

/// „Testen“ of a service row: a real request to the service's target (the update feed, the
/// AI provider's model list, the Jira site, `git ls-remote` of the remote, the model
/// source, the calendar) with the given (unsaved) settings. `password` is an unsaved
/// password of the service's profile.
#[tauri::command]
pub async fn network_service_test(
    app: AppHandle,
    service: String,
    network: Option<NetworkSettings>,
    password: Option<String>,
) -> Result<NetworkTest> {
    let state = app.state::<AppState>();
    let svc = Service::parse(&service).ok_or_else(|| Error::not_found("service", &service))?;
    let (settings, net) = draft_or_saved(&state, network)?;
    // The provider's own flag (bypass_proxy) comes from the settings.
    let svc = match svc {
        Service::Ai { id, .. } => settings
            .providers
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.service())
            .unwrap_or(Service::Ai { id, local: false }),
        s => s,
    };
    let profile = net.profile_for(&svc);
    let password = password.filter(|p| !p.is_empty()).or_else(|| secret(&state, &profile.id).get());
    let Some(target) = target(&app, &settings, &svc) else {
        return Err(Error::State(
            tr!("Für diesen Dienst ist kein Ziel eingerichtet", "No target is set up for this service").into(),
        ));
    };
    if svc == Service::GitSync {
        return git_test(app.clone(), net, target.url, password).await;
    }
    if !(target.url.starts_with("http://") || target.url.starts_with("https://")) {
        return Ok(NetworkTest {
            ok: true,
            url: target.url,
            proxy: None,
            route: None,
            status: None,
            latency_ms: 0,
            error: None,
            certificate: None,
        });
    }
    let shown = core::redacted_target(&target.url);
    http_test(&net, &svc, target, password, shown).await
}

/// `git ls-remote` of the remote through the Git sync's profile.
async fn git_test(app: AppHandle, net: NetworkSettings, url: String, password: Option<String>) -> Result<NetworkTest> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let token = state.git_secret.get();
        let git = git_with(&state, &net, token.clone(), &url, password.as_deref());
        let http = url.starts_with("http://") || url.starts_with("https://");
        let route = http.then(|| core::describe_route(&net, &Service::GitSync, Some(&url), &core::system_proxy()));
        let start = Instant::now();
        let res = git.version().and_then(|_| git.ls_remote(&url));
        let latency_ms = start.elapsed().as_millis() as u64;
        let shown =
            if http { core::redacted_target(&url) } else { annalo_core::gitsync::redact(&url, token.as_deref()) };
        let mut t = NetworkTest {
            ok: res.is_ok(),
            url: shown,
            proxy: route.as_ref().and_then(|r| r.proxy.clone()),
            route,
            status: None,
            latency_ms,
            error: None,
            certificate: None,
        };
        if let Err(e) = res {
            let mut msg = annalo_core::gitsync::redact(&e.to_string(), token.as_deref());
            if let Some(p) = password.as_deref().filter(|p| !p.is_empty()) {
                msg = msg.replace(p, "***");
            }
            if url.starts_with("https://") && core::is_certificate_error(&msg) {
                let profile = net.profile_for(&Service::GitSync);
                let prepared = core::Prepared::new(&profile, password.as_deref(), &net.trusted_hosts)?;
                t.certificate = tauri::async_runtime::block_on(prepared.certificate(&url)).ok().flatten();
            }
            t.error = Some(msg);
        }
        devlog::debug("net", format!("test git_sync {} → {}", t.url, if t.ok { "ok" } else { "error" }));
        Ok(t)
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

/// The connection test of 1.9: LiteLLM's model list (`<base>/v1/models`) with the given
/// (unsaved) settings, through the profile of the LiteLLM provider.
#[tauri::command]
pub async fn network_test(
    state: State<'_, AppState>,
    network: Option<NetworkSettings>,
    base_url: Option<String>,
    password: Option<String>,
) -> Result<NetworkTest> {
    let (settings, net) = draft_or_saved(&state, network)?;
    let base = base_url.unwrap_or(settings.litellm_base_url).trim().trim_end_matches('/').to_owned();
    let url = format!("{base}/v1/models");
    let service = Service::Ai { id: annalo_core::ai::provider::LEGACY_ID.into(), local: false };
    let profile = net.profile_for(&service);
    let password = password.filter(|p| !p.is_empty()).or_else(|| secret(&state, &profile.id).get());
    let provider = annalo_core::ai::provider::AiProvider::litellm(&base);
    let target = Target { url: url.clone(), auth: Some((provider, state.secrets.get())) };
    http_test(&net, &service, target, password, url).await
}

/// The certificate `url` presents on `service`'s route, for „Zertifikat anzeigen“.
#[tauri::command]
pub async fn network_certificate(
    state: State<'_, AppState>,
    url: String,
    service: Option<String>,
    network: Option<NetworkSettings>,
) -> Result<Option<CertDetails>> {
    let (_, net) = draft_or_saved(&state, network)?;
    let svc = service.as_deref().and_then(Service::parse).unwrap_or(Service::HttpTool);
    let profile = net.profile_for(&svc);
    let pw = secret(&state, &profile.id).get();
    let prepared = core::Prepared::new(&profile, pw.as_deref(), &[])?;
    let url = url.trim();
    if !url.starts_with("https://") {
        return Err(Error::State(
            tr!("Nur https-Adressen haben ein Zertifikat", "Only https addresses have a certificate").into(),
        ));
    }
    prepared.certificate(url).await
}

#[derive(Serialize)]
pub struct LegacyProbe {
    host: String,
    /// The certificate passes the normal check (nothing to trust).
    valid: bool,
    certificate: Option<CertDetails>,
    error: Option<String>,
}

/// „In vertraute Server umwandeln“ for a profile with the switch of 1.9: checks the https
/// targets of the services on it with the normal certificate check and returns the
/// certificates that fail it (the UI adds them as trusted servers and clears the switch).
#[tauri::command]
pub async fn network_legacy_probe(app: AppHandle, profile: String) -> Result<Vec<LegacyProbe>> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let net = effective(&settings.network);
    let mut hosts: Vec<(String, Service)> = vec![];
    for (service, _) in services(&settings) {
        if net.profile_for(&service).id != profile {
            continue;
        }
        let Some(t) = target(&app, &settings, &service) else { continue };
        if t.url.starts_with("https://")
            && !hosts.iter().any(|(u, _)| core::redacted_target(u) == core::redacted_target(&t.url))
        {
            hosts.push((t.url, service));
        }
    }
    let mut out = vec![];
    for (url, service) in hosts {
        let mut p = net.profile_for(&service);
        p.legacy_accept_invalid_certs = false;
        let pw = secret(&state, &p.id).get();
        let prepared = core::Prepared::new(&p, pw.as_deref(), &net.trusted_hosts)?;
        let host = reqwest::Url::parse(&url).ok().and_then(|u| u.host_str().map(str::to_owned)).unwrap_or_default();
        let res = prepared.client()?.head(&url).timeout(p.timeout()).send().await;
        let probe = match res {
            Ok(_) => LegacyProbe { host, valid: true, certificate: None, error: None },
            Err(e) => {
                let msg = error_text(&e, pw.as_deref());
                let certificate = if core::is_certificate_error(&msg) {
                    prepared.certificate(&url).await.ok().flatten()
                } else {
                    None
                };
                LegacyProbe { host, valid: false, certificate, error: Some(msg) }
            }
        };
        out.push(probe);
    }
    Ok(out)
}

/// Settings being saved: what an admin policy locks stays; returns an error text when a
/// profile with a password is removed (the password goes too).
pub fn enforce_policy(previous: &NetworkSettings, next: &mut NetworkSettings) {
    let policy = crate::policy::get().network();
    policy.enforce(previous, next);
}

/// Removes the stored passwords of profiles that no longer exist.
pub fn forget_removed(state: &AppState, previous: &NetworkSettings, next: &NetworkSettings) {
    for p in &previous.profiles {
        if p.id != DEFAULT_PROFILE && next.profile(&p.id).is_none() {
            let _ = secret(state, &p.id).set(None);
        }
    }
}

/// A message for the log when the policy names profiles this computer does not have.
pub fn policy_warnings(net: &NetworkSettings) {
    let mut n = net.clone();
    for w in crate::policy::get().network().apply(&mut n) {
        devlog::warn("net", trf!("Richtlinie ignoriert: {}", "Policy ignored: {}", w));
    }
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
