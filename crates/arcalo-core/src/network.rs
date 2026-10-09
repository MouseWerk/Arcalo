//! Network settings: named proxy profiles („Standard“, „Firma“, „VPN“ …) with proxy, extra
//! root certificates and timeouts, the profile each service uses, and the servers trusted by
//! certificate fingerprint.
//!
//! One place decides how a service connects: [`client_for`] builds every reqwest client
//! (a test fails when other code builds one) and [`git_env_for`] the Git environment, both
//! from the service's profile ([`NetworkSettings::profile_for`]) and its [`ProxyPlan`], so the
//! per-service test reports exactly what the app does.
//!
//! Modes of a profile:
//! * `none` – always direct (environment variables are ignored)
//! * `system` – Windows: the WinINet settings of the current user (registry
//!   `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`); elsewhere the
//!   `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` environment variables
//! * `manual` – HTTP, HTTPS and SOCKS proxy with an exception list
//! * `pac` – a proxy auto-config script. PAC files are JavaScript; the core does not embed a
//!   JS engine. The UI evaluates `FindProxyForURL` in a sandboxed frame for the hosts the app
//!   talks to and stores the answers in [`ProxyProfile::pac_results`] (host → answer,
//!   `*` = answer for the LiteLLM host, used for all other hosts).
//!
//! Proxy passwords live in the OS credential store ([`password_account`]).

use crate::{tr, trf};
use std::collections::BTreeMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use reqwest::Url;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

pub use reqwest::ClientBuilder;

/// Credential store account of the proxy password.
pub const PASSWORD_ACCOUNT: &str = "proxy-password";
/// Largest PAC file that is fetched.
const MAX_PAC_BYTES: usize = 1024 * 1024;
/// Largest CA file that is read.
const MAX_CA_BYTES: u64 = 4 * 1024 * 1024;

// ------------------------------------------------------------------ settings

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum ProxyMode {
    /// Always connect directly.
    None,
    /// The operating system's settings (WinINet on Windows, environment elsewhere).
    #[default]
    System,
    Manual,
    /// Proxy auto-config; answers evaluated by the UI.
    Pac,
}

/// Id of the profile every service uses unless it is routed elsewhere („Standard“).
pub const DEFAULT_PROFILE: &str = "standard";

/// A named way out („Firma“, „VPN“, „Direkt“): proxy, exceptions, extra root CA and timeouts.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct ProxyProfile {
    /// `[a-z0-9-]`, stable (routes and the credential account refer to it); `standard` is
    /// the default profile.
    pub id: String,
    pub name: String,
    pub mode: ProxyMode,
    /// `host:port` or a URL; used for `http://` targets.
    pub http_proxy: String,
    /// Used for `https://` targets; empty = the HTTP proxy.
    pub https_proxy: String,
    /// `host:port` or `socks5://host:port`; used when no HTTP(S) proxy is set.
    pub socks_proxy: String,
    /// Exceptions: `host`, `*.domain`, `.domain`, IP, CIDR, `<local>`, `*`; comma separated.
    pub no_proxy: String,
    /// `http(s)://` or `file://` address of a PAC script.
    pub pac_url: String,
    /// `FindProxyForURL` answers per host (`*` = default), filled by the UI.
    pub pac_results: BTreeMap<String, String>,
    /// User name for the proxy; the password is in the credential store
    /// ([`password_account`]).
    pub proxy_user: String,
    /// PEM (one or more certificates) or DER file of additional root CAs.
    pub extra_ca_path: Option<String>,
    /// Connect timeout in seconds (and the total timeout of tests and tool requests).
    pub connect_timeout_secs: u64,
    /// Read timeout in seconds; 0 = the service's own (downloads: 60 s, others none).
    pub read_timeout_secs: u64,
    /// Accept any certificate: the global switch of 1.9 and older, kept for the profiles that
    /// had it („unsicher“) until it is converted into trusted servers.
    pub legacy_accept_invalid_certs: bool,
}

impl Default for ProxyProfile {
    fn default() -> Self {
        ProxyProfile {
            id: DEFAULT_PROFILE.into(),
            name: "Standard".into(),
            mode: ProxyMode::System,
            http_proxy: String::new(),
            https_proxy: String::new(),
            socks_proxy: String::new(),
            no_proxy: "localhost, 127.0.0.1, ::1".into(),
            pac_url: String::new(),
            pac_results: BTreeMap::new(),
            proxy_user: String::new(),
            extra_ca_path: None,
            connect_timeout_secs: 30,
            read_timeout_secs: 0,
            legacy_accept_invalid_certs: false,
        }
    }
}

/// „Diesem Server vertrauen“: a host whose leaf certificate is accepted when its SHA-256
/// matches (and only then: a different certificate is rejected even if a CA vouches for it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct TrustedHost {
    /// Host name or IP address, lower case, without port.
    pub host: String,
    /// SHA-256 of the leaf certificate (DER), 64 hex digits.
    pub sha256: String,
    /// SHA-256 of its public key (`SubjectPublicKeyInfo`), Base64; Git pins with it.
    pub spki_sha256: String,
    /// Subject (CN) and expiry, for the list.
    pub subject: Option<String>,
    pub not_after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct NetworkSettings {
    /// The profiles; the one with id `standard` is the default and always exists.
    pub profiles: Vec<ProxyProfile>,
    /// Service ([`Service::key`], or its group: `ai`, `jira`, `ics`) → profile id. Services
    /// without an entry use the default profile.
    pub routes: BTreeMap<String, String>,
    /// Servers trusted by certificate fingerprint.
    pub trusted_hosts: Vec<TrustedHost>,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        NetworkSettings { profiles: vec![ProxyProfile::default()], routes: BTreeMap::new(), trusted_hosts: vec![] }
    }
}

/// Credential store account of a profile's proxy password (the default profile keeps the
/// account of 1.9 and older).
pub fn password_account(profile_id: &str) -> String {
    if profile_id == DEFAULT_PROFILE { PASSWORD_ACCOUNT.into() } else { format!("{PASSWORD_ACCOUNT}-{profile_id}") }
}

/// What an outgoing connection is for. Each one can be routed through its own profile.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Service {
    /// The update feed and the download of an update.
    Updates,
    /// Release notes of other versions from GitHub.
    ReleaseNotes,
    /// Whisper model downloads.
    VoiceModels,
    /// An AI provider by id; `local` providers (Ollama, `bypass_proxy`) go direct unless
    /// they are routed explicitly.
    Ai {
        id: String,
        local: bool,
    },
    /// A Jira site by id.
    Jira(String),
    GitSync,
    /// An ICS subscription by id.
    Ics(String),
    /// Titles of pasted links.
    LinkPreview,
    /// The assistant's `http_request` tool.
    HttpTool,
}

impl Service {
    /// `updates`, `ai:<id>`, `jira:<id>`, `ics:<id>`, …
    pub fn key(&self) -> String {
        match self {
            Service::Ai { id, .. } | Service::Jira(id) | Service::Ics(id) => format!("{}:{id}", self.group()),
            _ => self.group().into(),
        }
    }

    /// The key without the id (`ai`, `jira`, `ics`; the key itself for the others).
    pub fn group(&self) -> &'static str {
        match self {
            Service::Updates => "updates",
            Service::ReleaseNotes => "release_notes",
            Service::VoiceModels => "voice_models",
            Service::Ai { .. } => "ai",
            Service::Jira(_) => "jira",
            Service::GitSync => "git_sync",
            Service::Ics(_) => "ics",
            Service::LinkPreview => "link_preview",
            Service::HttpTool => "http_tool",
        }
    }

    /// The service of a [`key`](Self::key) (`ai:<id>` as a provider that is not local).
    pub fn parse(key: &str) -> Option<Service> {
        let (group, id) = match key.split_once(':') {
            Some((g, id)) if !id.is_empty() => (g, Some(id.to_owned())),
            Some(_) => return None,
            None => (key, None),
        };
        Some(match (group, id) {
            ("updates", None) => Service::Updates,
            ("release_notes", None) => Service::ReleaseNotes,
            ("voice_models", None) => Service::VoiceModels,
            ("git_sync", None) => Service::GitSync,
            ("link_preview", None) => Service::LinkPreview,
            ("http_tool", None) => Service::HttpTool,
            ("ai", Some(id)) => Service::Ai { id, local: false },
            ("jira", Some(id)) => Service::Jira(id),
            ("ics", Some(id)) => Service::Ics(id),
            _ => return None,
        })
    }

    /// The read timeout a service had before profiles had one (downloads).
    fn default_read_timeout(&self) -> Option<Duration> {
        matches!(self, Service::Updates | Service::ReleaseNotes | Service::VoiceModels).then(|| Duration::from_secs(60))
    }
}

/// The groups that can be routed as a whole (keys of [`NetworkSettings::routes`] and of the
/// `NetworkRoute.<service>` policy).
pub const ROUTE_GROUPS: &[&str] =
    &["updates", "release_notes", "voice_models", "ai", "jira", "git_sync", "ics", "link_preview", "http_tool"];

/// Whether `key` names a service or group that can be routed.
pub fn valid_route_key(key: &str) -> bool {
    ROUTE_GROUPS.contains(&key) || Service::parse(key).is_some()
}

impl ProxyProfile {
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.connect_timeout_secs.clamp(1, 600))
    }

    /// Trims and validates the fields; proxy addresses become URLs (`host:port` →
    /// `http://host:port`).
    pub fn normalized(&self) -> Result<ProxyProfile> {
        let mut n = self.clone();
        n.name = self.name.trim().to_owned();
        n.http_proxy = normalize_proxy_url(&self.http_proxy, "http")?.unwrap_or_default();
        n.https_proxy = normalize_proxy_url(&self.https_proxy, "http")?.unwrap_or_default();
        n.socks_proxy = normalize_proxy_url(&self.socks_proxy, "socks5")?.unwrap_or_default();
        n.no_proxy = self.no_proxy.trim().to_owned();
        n.pac_url = self.pac_url.trim().to_owned();
        if !n.pac_url.is_empty() {
            let u = Url::parse(&n.pac_url)
                .map_err(|_| Error::State(trf!("PAC-URL „{}“ ist ungültig", "PAC URL “{}” is invalid", n.pac_url)))?;
            if !matches!(u.scheme(), "http" | "https" | "file") {
                return Err(Error::State(
                    tr!(
                        "Die PAC-URL muss mit http://, https:// oder file:// beginnen",
                        "The PAC URL must start with http://, https:// or file://"
                    )
                    .into(),
                ));
            }
        }
        n.proxy_user = self.proxy_user.trim().to_owned();
        n.extra_ca_path = self.extra_ca_path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
        n.connect_timeout_secs = self.connect_timeout_secs.clamp(1, 600);
        n.read_timeout_secs = self.read_timeout_secs.min(3600);
        let named = |msg_de: &str, msg_en: &str| {
            Error::State(format!("{} „{}“: {}", tr!("Profil", "Profile"), n.name, tr!(msg_de, msg_en)))
        };
        if n.mode == ProxyMode::Manual
            && n.http_proxy.is_empty()
            && n.https_proxy.is_empty()
            && n.socks_proxy.is_empty()
        {
            return Err(named(
                "Für einen manuellen Proxy bitte mindestens eine Proxy-Adresse eintragen",
                "For a manual proxy, enter at least one proxy address",
            ));
        }
        if n.mode == ProxyMode::Pac && n.pac_url.is_empty() {
            return Err(named("Bitte die Adresse der PAC-Datei eintragen", "Enter the address of the PAC file"));
        }
        Ok(n)
    }
}

/// `Firma VPN` → `firma-vpn` (ids of new profiles).
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.trim().to_lowercase().chars() {
        let c = match c {
            'ä' => 'a',
            'ö' => 'o',
            'ü' => 'u',
            'ß' => 's',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    let out = out.trim_end_matches('-').to_owned();
    if out.is_empty() { "profil".into() } else { out }
}

/// Normalizes a SHA-256 fingerprint (`AB:CD:…`, spaces, case) to 64 lower-case hex digits.
pub fn normalize_fingerprint(raw: &str) -> Option<String> {
    let hex: String = raw.chars().filter(|c| c.is_ascii_hexdigit()).collect::<String>().to_ascii_lowercase();
    let only_hex = raw.chars().all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | ' ' | '-'));
    (only_hex && hex.len() == 64).then_some(hex)
}

impl NetworkSettings {
    /// The default profile.
    pub fn standard(&self) -> &ProxyProfile {
        static FALLBACK: std::sync::OnceLock<ProxyProfile> = std::sync::OnceLock::new();
        self.profile(DEFAULT_PROFILE)
            .or(self.profiles.first())
            .unwrap_or_else(|| FALLBACK.get_or_init(ProxyProfile::default))
    }

    pub fn profile(&self, id: &str) -> Option<&ProxyProfile> {
        self.profiles.iter().find(|p| p.id == id)
    }

    /// The profile `service` is routed to explicitly (its own key, else its group); `None`
    /// = the default profile.
    pub fn route_of(&self, service: &Service) -> Option<&str> {
        let explicit = self.routes.get(&service.key()).or_else(|| self.routes.get(service.group()));
        explicit.map(String::as_str).filter(|id| self.profile(id).is_some())
    }

    /// The settings a connection of `service` uses. A local AI provider on the default
    /// profile goes direct (with the profile's certificates and timeouts), as in 1.9.
    pub fn profile_for(&self, service: &Service) -> ProxyProfile {
        match self.route_of(service).and_then(|id| self.profile(id)) {
            Some(p) => p.clone(),
            None => {
                let p = self.standard().clone();
                match service {
                    Service::Ai { local: true, .. } => ProxyProfile { mode: ProxyMode::None, ..p },
                    _ => p,
                }
            }
        }
    }

    /// Connect timeout of the profile of `service` (also the total timeout of tool requests,
    /// Jira, calendars and tests).
    pub fn timeout_for(&self, service: &Service) -> Duration {
        self.profile_for(service).timeout()
    }

    /// Validates every profile; makes ids unique, keeps the default profile, drops routes to
    /// profiles that no longer exist and normalizes the trusted servers.
    pub fn normalized(&self) -> Result<NetworkSettings> {
        let mut profiles: Vec<ProxyProfile> = vec![];
        for p in &self.profiles {
            let mut n = p.normalized()?;
            if n.name.is_empty() {
                n.name = if n.id == DEFAULT_PROFILE { "Standard".into() } else { tr!("Profil", "Profile").into() };
            }
            let mut id = if n.id.trim().is_empty() { slug(&n.name) } else { slug(&n.id) };
            if id != DEFAULT_PROFILE || n.id == DEFAULT_PROFILE {
                let base = id.clone();
                let mut i = 2;
                while profiles.iter().any(|q| q.id == id) {
                    id = format!("{base}-{i}");
                    i += 1;
                }
            } else {
                // A new profile named „Standard“ does not take the default's id.
                id = "standard-2".into();
                let mut i = 3;
                while profiles.iter().any(|q| q.id == id) || self.profiles.iter().any(|q| q.id == id) {
                    id = format!("standard-{i}");
                    i += 1;
                }
            }
            n.id = id;
            profiles.push(n);
        }
        if !profiles.iter().any(|p| p.id == DEFAULT_PROFILE) {
            profiles.insert(0, ProxyProfile::default());
        }
        let routes = self
            .routes
            .iter()
            .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
            .filter(|(k, v)| valid_route_key(k) && profiles.iter().any(|p| &p.id == v))
            .collect();
        let mut trusted_hosts: Vec<TrustedHost> = vec![];
        for t in &self.trusted_hosts {
            let host = t.host.trim().trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
            let Some(sha256) = normalize_fingerprint(&t.sha256) else {
                return Err(Error::State(trf!(
                    "Fingerabdruck für {} ist kein SHA-256-Wert",
                    "Fingerprint for {} is not a SHA-256 value",
                    host
                )));
            };
            if host.is_empty() || host.contains(['/', ' ']) {
                return Err(Error::State(trf!("Servername „{}“ ist ungültig", "Server name “{}” is invalid", t.host)));
            }
            let entry = TrustedHost { host, sha256, spki_sha256: t.spki_sha256.trim().to_owned(), ..t.clone() };
            if !trusted_hosts.iter().any(|x| x.host == entry.host && x.sha256 == entry.sha256) {
                trusted_hosts.push(entry);
            }
        }
        Ok(NetworkSettings { profiles, routes, trusted_hosts })
    }

    /// Whether any profile still accepts every certificate (the setting of 1.9).
    pub fn insecure(&self) -> bool {
        self.profiles.iter().any(|p| p.legacy_accept_invalid_certs)
    }
}

// ------------------------------------------------------------------ policy

/// What an organization's policy fixes about the network (`NetworkRoute.<service>`,
/// `LockNetworkProfiles`; docs/admin/network.md).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct NetworkPolicy {
    /// Service key or group → profile id or name (`Standard` = the default profile).
    pub routes: BTreeMap<String, String>,
    /// Profiles cannot be added, changed or removed.
    pub lock_profiles: bool,
}

impl NetworkPolicy {
    /// Whether the route of `service` is fixed by the policy.
    pub fn locks(&self, service: &Service) -> bool {
        self.routes.contains_key(&service.key()) || self.routes.contains_key(service.group())
    }

    /// Sets the routes the policy fixes. A policy value that names no profile on this
    /// computer is ignored (returned as a warning). A group route (`ai`) replaces the
    /// service routes of that group.
    pub fn apply(&self, net: &mut NetworkSettings) -> Vec<String> {
        let mut warnings = vec![];
        // Groups first, so a policy for one provider wins over the policy for all.
        let mut keys: Vec<&String> = self.routes.keys().collect();
        keys.sort_by_key(|k| k.contains(':'));
        for key in keys {
            let want = self.routes[key].trim();
            let id = if want.eq_ignore_ascii_case(DEFAULT_PROFILE) || want.eq_ignore_ascii_case("default") {
                Some(DEFAULT_PROFILE.to_owned())
            } else {
                net.profiles
                    .iter()
                    .find(|p| p.id.eq_ignore_ascii_case(want) || p.name.eq_ignore_ascii_case(want))
                    .map(|p| p.id.clone())
            };
            let Some(id) = id else {
                warnings.push(format!("NetworkRoute.{key}: profile “{want}” not found"));
                continue;
            };
            if !key.contains(':') {
                let prefix = format!("{key}:");
                net.routes.retain(|k, _| !k.starts_with(&prefix));
            }
            if id == DEFAULT_PROFILE && !key.contains(':') {
                net.routes.remove(key);
            } else {
                net.routes.insert(key.clone(), id);
            }
        }
        warnings
    }

    /// Settings being saved: locked profiles stay as they were, locked routes as the policy
    /// says.
    pub fn enforce(&self, previous: &NetworkSettings, next: &mut NetworkSettings) {
        if self.lock_profiles {
            next.profiles = previous.profiles.clone();
        }
        self.apply(next);
    }
}

/// `host:port` → `http://host:port`; URLs keep their scheme (`socks` → `socks5`). Paths,
/// queries and fragments are dropped. `Ok(None)` for an empty string.
pub fn normalize_proxy_url(raw: &str, default_scheme: &str) -> Result<Option<String>> {
    let s = raw.trim();
    if s.is_empty() {
        return Ok(None);
    }
    let with_scheme = if s.contains("://") { s.to_owned() } else { format!("{default_scheme}://{s}") };
    let bad = || {
        Error::State(trf!(
            "Proxy-Adresse „{s}“ ist ungültig (erwartet host:port oder eine URL)",
            "Proxy address “{s}” is invalid (expected host:port or a URL)"
        ))
    };
    let mut url = Url::parse(&with_scheme).map_err(|_| bad())?;
    let scheme = match url.scheme() {
        "socks" => "socks5".to_owned(),
        s @ ("http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h") => s.to_owned(),
        other => {
            return Err(Error::State(trf!(
                "Proxy-Protokoll „{other}“ wird nicht unterstützt",
                "Proxy protocol “{other}” is not supported"
            )));
        }
    };
    if url.host_str().is_none_or(str::is_empty) {
        return Err(bad());
    }
    let host = url.host_str().unwrap_or_default().to_owned();
    let port = url.port();
    let (user, pass) = (url.username().to_owned(), url.password().map(str::to_owned));
    url = Url::parse(&format!("{scheme}://{host}")).map_err(|_| bad())?;
    let _ = url.set_port(port);
    if !user.is_empty() {
        let _ = url.set_username(&user);
        let _ = url.set_password(pass.as_deref());
    }
    Ok(Some(url.as_str().trim_end_matches('/').to_owned()))
}

/// The proxy URL without user name and password (for messages and the connection test).
pub fn display_proxy(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.as_str().trim_end_matches('/').to_owned()
        }
        Err(_) => url.to_owned(),
    }
}

// ------------------------------------------------------------------ no_proxy

#[derive(Debug, Clone, PartialEq)]
enum Bypass {
    All,
    /// `<local>`: host names without a dot.
    Local,
    /// `example.com`: the domain and its subdomains.
    Domain(String),
    /// `.example.com` / `*.example.com`: subdomains only.
    Subdomains(String),
    /// Any other pattern with `*` (e.g. `10.*`, `intra-*`).
    Glob(String),
    Ip(IpAddr),
    Cidr(IpAddr, u8),
}

/// Exception list of a proxy, as in `NO_PROXY` or the Windows „Ausnahmen“ field.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NoProxy {
    entries: Vec<Bypass>,
}

impl NoProxy {
    /// Entries separated by commas, semicolons or whitespace.
    pub fn parse(list: &str) -> NoProxy {
        let mut entries = vec![];
        for raw in list.split([',', ';', ' ', '\n', '\r', '\t']) {
            let e = raw.trim().to_ascii_lowercase();
            if e.is_empty() {
                continue;
            }
            if e == "*" {
                entries.push(Bypass::All);
            } else if e == "<local>" {
                entries.push(Bypass::Local);
            } else if let Some((ip, bits)) = e.split_once('/') {
                if let (Ok(ip), Ok(bits)) = (ip.trim_matches(['[', ']']).parse::<IpAddr>(), bits.parse::<u8>()) {
                    let max = if ip.is_ipv4() { 32 } else { 128 };
                    entries.push(Bypass::Cidr(ip, bits.min(max)));
                }
            } else if let Ok(ip) = e.trim_matches(['[', ']']).parse::<IpAddr>() {
                entries.push(Bypass::Ip(ip));
            } else {
                // `host:port` – the port is ignored.
                let host = match e.rsplit_once(':') {
                    Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !h.contains(':') => h.to_owned(),
                    _ => e,
                };
                if let Some(rest) = host.strip_prefix("*.")
                    && !rest.contains('*')
                {
                    entries.push(Bypass::Subdomains(rest.to_owned()));
                    continue;
                }
                if host.contains('*') {
                    entries.push(Bypass::Glob(host));
                } else if let Some(rest) = host.strip_prefix('.') {
                    entries.push(Bypass::Subdomains(rest.to_owned()));
                } else {
                    entries.push(Bypass::Domain(host));
                }
            }
        }
        NoProxy { entries }
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Whether `host` (a name or an IP, IPv6 with or without brackets) bypasses the proxy.
    pub fn matches(&self, host: &str) -> bool {
        let host = host.trim().trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
        let ip = host.parse::<IpAddr>().ok();
        self.entries.iter().any(|e| match e {
            Bypass::All => true,
            Bypass::Local => ip.is_none() && !host.contains('.'),
            Bypass::Domain(d) => host == *d || host.strip_suffix(d.as_str()).is_some_and(|p| p.ends_with('.')),
            Bypass::Subdomains(d) => host.strip_suffix(d.as_str()).is_some_and(|p| p.ends_with('.') && p.len() > 1),
            Bypass::Glob(p) => glob_match(p, &host),
            Bypass::Ip(a) => ip == Some(*a),
            Bypass::Cidr(net, bits) => ip.is_some_and(|ip| in_cidr(ip, *net, *bits)),
        })
    }
}

/// `*` matches any run of characters (including dots).
fn glob_match(pattern: &str, text: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return pattern == text;
    }
    let mut rest = text;
    for (i, part) in parts.iter().enumerate() {
        if i == 0 {
            let Some(r) = rest.strip_prefix(part) else { return false };
            rest = r;
        } else if i == parts.len() - 1 {
            return rest.ends_with(part);
        } else if let Some(pos) = rest.find(part) {
            rest = &rest[pos + part.len()..];
        } else {
            return false;
        }
    }
    true
}

fn in_cidr(ip: IpAddr, net: IpAddr, bits: u8) -> bool {
    match (ip, net) {
        (IpAddr::V4(a), IpAddr::V4(n)) => {
            let mask = if bits == 0 { 0 } else { u32::MAX << (32 - bits.min(32)) };
            u32::from(a) & mask == u32::from(n) & mask
        }
        (IpAddr::V6(a), IpAddr::V6(n)) => {
            let mask = if bits == 0 { 0 } else { u128::MAX << (128 - bits.min(128)) };
            u128::from(a) & mask == u128::from(n) & mask
        }
        _ => false,
    }
}

// -------------------------------------------------------------- system proxy

/// The proxy configured in the operating system.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SystemProxy {
    pub http: Option<String>,
    pub https: Option<String>,
    pub socks: Option<String>,
    /// Exceptions in [`NoProxy`] syntax.
    pub bypass: String,
    /// A PAC script configured in the system (not evaluated in mode `system`).
    pub pac_url: Option<String>,
    /// Where the values came from, for the settings page.
    pub source: String,
}

/// Interprets the WinINet values `ProxyEnable`, `ProxyServer`, `ProxyOverride` and
/// `AutoConfigURL`. `ProxyServer` is `host:port` (all protocols) or
/// `http=host:port;https=host:port;socks=host:port`.
pub fn parse_wininet(enable: u32, server: &str, overrides: &str, auto_config_url: &str) -> SystemProxy {
    let mut sp = SystemProxy {
        source: tr!("Windows-Interneteinstellungen", "Windows Internet settings").into(),
        pac_url: Some(auto_config_url.trim().to_owned()).filter(|u| !u.is_empty()),
        ..Default::default()
    };
    if enable == 0 || server.trim().is_empty() {
        return sp;
    }
    let norm = |v: &str, scheme: &str| normalize_proxy_url(v, scheme).ok().flatten();
    if server.contains('=') {
        for part in server.split(';') {
            let Some((k, v)) = part.split_once('=') else { continue };
            match k.trim().to_ascii_lowercase().as_str() {
                "http" => sp.http = norm(v, "http"),
                "https" => sp.https = norm(v, "http"),
                "socks" => sp.socks = norm(v, "socks4"),
                _ => {}
            }
        }
    } else {
        let p = norm(server, "http");
        sp.http = p.clone();
        sp.https = p;
    }
    sp.bypass = overrides.split(';').map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ");
    sp
}

/// Proxy from the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, also
/// lower case). `get` reads a variable (injected for tests).
pub fn parse_env(get: impl Fn(&str) -> Option<String>) -> SystemProxy {
    let var = |names: &[&str]| names.iter().find_map(|n| get(n)).filter(|v| !v.trim().is_empty());
    let all = var(&["ALL_PROXY", "all_proxy"]);
    let norm = |v: Option<String>, scheme: &str| v.and_then(|v| normalize_proxy_url(&v, scheme).ok().flatten());
    let socks = all.clone().filter(|a| a.trim_start().starts_with("socks"));
    let all_http = all.filter(|a| !a.trim_start().starts_with("socks"));
    SystemProxy {
        http: norm(var(&["http_proxy", "HTTP_PROXY"]).or(all_http.clone()), "http"),
        https: norm(var(&["https_proxy", "HTTPS_PROXY"]).or(all_http), "http"),
        socks: norm(socks, "socks5"),
        bypass: var(&["no_proxy", "NO_PROXY"]).unwrap_or_default(),
        pac_url: None,
        source: tr!(
            "Umgebungsvariablen (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)",
            "environment variables (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)"
        )
        .into(),
    }
}

/// Reads the proxy of the operating system now.
pub fn system_proxy() -> SystemProxy {
    #[cfg(windows)]
    {
        win::read()
    }
    #[cfg(not(windows))]
    {
        parse_env(|n| std::env::var(n).ok())
    }
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW};

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn dword(name: &str) -> u32 {
        let (key, name) = (wide(KEY), wide(name));
        let mut value = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        // SAFETY: valid NUL-terminated strings and a correctly sized output buffer.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        if rc == 0 { value } else { 0 }
    }

    fn string(name: &str) -> String {
        let (key, name) = (wide(KEY), wide(name));
        let mut buf = vec![0u16; 4096];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: as above; `size` is the buffer size in bytes.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != 0 {
            return String::new();
        }
        let len = (size as usize / 2).saturating_sub(1).min(buf.len());
        String::from_utf16_lossy(&buf[..len]).trim_end_matches('\0').to_owned()
    }

    pub fn read() -> super::SystemProxy {
        super::parse_wininet(
            dword("ProxyEnable"),
            &string("ProxyServer"),
            &string("ProxyOverride"),
            &string("AutoConfigURL"),
        )
    }
}

// --------------------------------------------------------------------- PAC

/// First usable entry of a `FindProxyForURL` answer (`PROXY a:8080; SOCKS b:1080; DIRECT`):
/// `None` = direct.
pub fn parse_pac_answer(answer: &str) -> Option<String> {
    for part in answer.split(';') {
        let mut it = part.split_whitespace();
        let kind = it.next().unwrap_or("").to_ascii_uppercase();
        let addr = it.next().unwrap_or("");
        let scheme = match kind.as_str() {
            "DIRECT" => return None,
            "PROXY" | "HTTP" => "http",
            "HTTPS" => "https",
            "SOCKS" | "SOCKS5" => "socks5",
            "SOCKS4" => "socks4",
            _ => continue,
        };
        if let Ok(Some(u)) = normalize_proxy_url(&format!("{scheme}://{addr}"), scheme) {
            return Some(u);
        }
    }
    None
}

// -------------------------------------------------------------------- plan

#[derive(Debug, Clone)]
enum Rules {
    /// No proxy (mode `none`).
    Direct,
    Fixed(Box<FixedProxies>),
    Pac(BTreeMap<String, Option<Url>>),
}

#[derive(Debug, Clone)]
struct FixedProxies {
    http: Option<Url>,
    https: Option<Url>,
    socks: Option<Url>,
}

/// Decides per URL which proxy (if any) is used.
#[derive(Debug, Clone)]
pub struct ProxyPlan {
    rules: Rules,
    bypass: NoProxy,
}

fn with_credentials(url: &str, user: &str, password: Option<&str>) -> Option<Url> {
    let mut u = Url::parse(url).ok()?;
    if !user.is_empty() && u.username().is_empty() {
        let _ = u.set_username(user);
        let _ = u.set_password(password.filter(|p| !p.is_empty()));
    }
    Some(u)
}

impl ProxyPlan {
    /// The plan for `net`; mode `system` uses `system`.
    pub fn new(net: &ProxyProfile, password: Option<&str>, system: &SystemProxy) -> ProxyPlan {
        let cred = |u: &Option<String>| u.as_deref().and_then(|u| with_credentials(u, &net.proxy_user, password));
        match net.mode {
            ProxyMode::None => ProxyPlan { rules: Rules::Direct, bypass: NoProxy::default() },
            ProxyMode::System => ProxyPlan {
                rules: Rules::Fixed(Box::new(FixedProxies {
                    http: cred(&system.http),
                    https: cred(&system.https),
                    socks: cred(&system.socks),
                })),
                bypass: NoProxy::parse(&system.bypass),
            },
            ProxyMode::Manual => {
                let n = |s: &str, scheme| normalize_proxy_url(s, scheme).ok().flatten();
                ProxyPlan {
                    rules: Rules::Fixed(Box::new(FixedProxies {
                        http: cred(&n(&net.http_proxy, "http")),
                        https: cred(&n(&net.https_proxy, "http")),
                        socks: cred(&n(&net.socks_proxy, "socks5")),
                    })),
                    bypass: NoProxy::parse(&net.no_proxy),
                }
            }
            ProxyMode::Pac => ProxyPlan {
                rules: Rules::Pac(
                    net.pac_results.iter().map(|(h, a)| (h.to_ascii_lowercase(), cred(&parse_pac_answer(a)))).collect(),
                ),
                bypass: NoProxy::parse(&net.no_proxy),
            },
        }
    }

    /// The proxy for `url`, with credentials; `None` = direct.
    pub fn resolve(&self, url: &Url) -> Option<Url> {
        let host = url.host_str()?;
        if self.bypass.matches(host) {
            return None;
        }
        match &self.rules {
            Rules::Direct => None,
            Rules::Fixed(f) => match url.scheme() {
                "https" | "wss" => f.https.clone().or_else(|| f.http.clone()).or_else(|| f.socks.clone()),
                _ => f.http.clone().or_else(|| f.socks.clone()),
            },
            Rules::Pac(map) => {
                let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
                map.get(&host).or_else(|| map.get("*")).cloned().flatten()
            }
        }
    }

    /// [`resolve`](Self::resolve) for a URL string; `Err` for an unparsable URL.
    pub fn resolve_str(&self, url: &str) -> Result<Option<Url>> {
        let u = Url::parse(url).map_err(|e| Error::Parse(format!("URL {url}: {e}")))?;
        Ok(self.resolve(&u))
    }
}

// ---------------------------------------------------------------------- CA

/// Summary of a CA file for the settings page.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CaInfo {
    pub count: usize,
    /// Common name (or organization) of the first certificate.
    pub subject: Option<String>,
    /// Expiry of the first certificate, `YYYY-MM-DD`.
    pub not_after: Option<String>,
}

/// Splits PEM (one or more `CERTIFICATE` blocks) or a single DER certificate into DER blobs.
pub fn parse_certificates(bytes: &[u8]) -> Result<Vec<Vec<u8>>> {
    let text = String::from_utf8_lossy(bytes);
    if text.contains("-----BEGIN") {
        let mut out = vec![];
        let mut rest = text.as_ref();
        while let Some(start) = rest.find("-----BEGIN CERTIFICATE-----") {
            let body = &rest[start + "-----BEGIN CERTIFICATE-----".len()..];
            let end = body
                .find("-----END CERTIFICATE-----")
                .ok_or_else(|| Error::Parse(tr!("PEM: END-Zeile fehlt", "PEM: the END line is missing").into()))?;
            let b64: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
            let der = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| Error::Parse(trf!("PEM: ungültiges Base64 ({e})", "PEM: invalid Base64 ({e})")))?;
            out.push(der);
            rest = &body[end..];
        }
        if out.is_empty() {
            return Err(Error::Parse(
                tr!("Die Datei enthält keinen Block „BEGIN CERTIFICATE“", "The file has no “BEGIN CERTIFICATE” block")
                    .into(),
            ));
        }
        return Ok(out);
    }
    if bytes.first() == Some(&0x30) && der_tlv(bytes).is_some() {
        return Ok(vec![bytes.to_vec()]);
    }
    Err(Error::Parse(tr!("Kein Zertifikat im PEM- oder DER-Format", "No certificate in PEM or DER format").into()))
}

/// Reads and summarizes a CA file.
pub fn ca_info(bytes: &[u8]) -> Result<CaInfo> {
    let certs = parse_certificates(bytes)?;
    let (subject, not_after) = certs.first().map(|c| cert_summary(c)).unwrap_or((None, None));
    Ok(CaInfo { count: certs.len(), subject, not_after })
}

fn read_ca(path: &str) -> Result<Vec<Vec<u8>>> {
    let meta =
        std::fs::metadata(path).map_err(|e| Error::State(trf!("CA-Datei {path}: {e}", "CA file {path}: {e}")))?;
    if meta.len() > MAX_CA_BYTES {
        return Err(Error::State(trf!("CA-Datei {path} ist zu groß", "CA file {path} is too large")));
    }
    let bytes = std::fs::read(path).map_err(|e| Error::State(trf!("CA-Datei {path}: {e}", "CA file {path}: {e}")))?;
    parse_certificates(&bytes).map_err(|e| Error::State(trf!("CA-Datei {path}: {e}", "CA file {path}: {e}")))
}

/// Reads a CA file and summarizes it.
pub fn ca_info_file(path: &str) -> Result<CaInfo> {
    let certs = read_ca(path)?;
    let (subject, not_after) = cert_summary(&certs[0]);
    Ok(CaInfo { count: certs.len(), subject, not_after })
}

/// `(tag, content, rest)` of one DER element.
fn der_tlv(b: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let tag = *b.first()?;
    let first = *b.get(1)? as usize;
    let (len, hdr) = if first < 0x80 {
        (first, 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *b.get(2 + i)? as usize;
        }
        (len, 2 + n)
    };
    let end = hdr.checked_add(len)?;
    (end <= b.len()).then(|| (tag, &b[hdr..end], &b[end..]))
}

/// The parts of a DER certificate the settings page shows; best effort.
struct CertFields<'a> {
    issuer: &'a [u8],
    subject: &'a [u8],
    not_after: Option<String>,
    /// The whole `SubjectPublicKeyInfo` element (tag and length included).
    spki: &'a [u8],
}

fn cert_fields(der: &[u8]) -> Option<CertFields<'_>> {
    let (_, cert, _) = der_tlv(der)?;
    let (_, tbs, _) = der_tlv(cert)?;
    let mut rest = tbs;
    let (tag, _, r) = der_tlv(rest)?;
    if tag == 0xa0 {
        rest = r; // version
    }
    let (_, _, r) = der_tlv(rest)?; // serial
    let (_, _, r) = der_tlv(r)?; // signature algorithm
    let (_, issuer, r) = der_tlv(r)?;
    let (_, validity, r) = der_tlv(r)?;
    let (_, subject, after_subject) = der_tlv(r)?;
    let spki =
        der_tlv(after_subject).map(|(_, _, rest)| &after_subject[..after_subject.len() - rest.len()]).unwrap_or(&[]);
    let (_, _, v) = der_tlv(validity)?;
    let (ttag, time, _) = der_tlv(v)?;
    let not_after = std::str::from_utf8(time).ok().and_then(|t| match ttag {
        0x17 if t.len() >= 6 && t.is_ascii() => {
            let yy: u32 = t[0..2].parse().ok()?;
            Some(format!("{}-{}-{}", if yy >= 50 { 1900 + yy } else { 2000 + yy }, &t[2..4], &t[4..6]))
        }
        0x18 if t.len() >= 8 && t.is_ascii() => Some(format!("{}-{}-{}", &t[0..4], &t[4..6], &t[6..8])),
        _ => None,
    });
    Some(CertFields { issuer, subject, not_after, spki })
}

/// CN (else O) of a DER `Name`.
fn name_label(name: &[u8]) -> Option<String> {
    let (mut cn, mut org) = (None, None);
    let mut rdns = name;
    while let Some((_, set, next)) = der_tlv(rdns) {
        let mut atvs = set;
        while let Some((_, atv, n2)) = der_tlv(atvs) {
            if let Some((0x06, oid, val)) = der_tlv(atv)
                && let Some((_, value, _)) = der_tlv(val)
            {
                let text = String::from_utf8_lossy(value).into_owned();
                match oid {
                    [0x55, 0x04, 0x03] => cn = Some(text),
                    [0x55, 0x04, 0x0a] => org = Some(text),
                    _ => {}
                }
            }
            atvs = n2;
        }
        rdns = next;
    }
    cn.or(org)
}

/// Subject (CN, else O) and notAfter of a DER certificate; best effort.
fn cert_summary(der: &[u8]) -> (Option<String>, Option<String>) {
    match cert_fields(der) {
        Some(f) => (name_label(f.subject), f.not_after),
        None => (None, None),
    }
}

/// A server's certificate for „Zertifikat anzeigen und vertrauen“.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CertDetails {
    pub host: String,
    /// SHA-256 of the certificate, 64 lower-case hex digits.
    pub sha256: String,
    /// SHA-256 of the public key, Base64 (empty when it cannot be read).
    pub spki_sha256: String,
    pub subject: Option<String>,
    pub issuer: Option<String>,
    pub not_after: Option<String>,
    /// Issuer and subject are the same.
    pub self_signed: bool,
}

/// Fingerprints and names of the DER certificate `der` of `host`.
pub fn cert_details(der: &[u8], host: &str) -> CertDetails {
    use sha2::Digest;
    let f = cert_fields(der);
    let spki_sha256 = f
        .as_ref()
        .filter(|f| !f.spki.is_empty())
        .map(|f| base64::engine::general_purpose::STANDARD.encode(sha2::Sha256::digest(f.spki)))
        .unwrap_or_default();
    CertDetails {
        host: host.trim_matches(['[', ']']).to_ascii_lowercase(),
        sha256: sha256_hex(der),
        spki_sha256,
        subject: f.as_ref().and_then(|f| name_label(f.subject)),
        issuer: f.as_ref().and_then(|f| name_label(f.issuer)),
        not_after: f.as_ref().and_then(|f| f.not_after.clone()),
        self_signed: f.as_ref().is_some_and(|f| f.issuer == f.subject),
    }
}

impl CertDetails {
    /// The entry for Settings → Netzwerk → vertraute Server.
    pub fn trusted(&self) -> TrustedHost {
        TrustedHost {
            host: self.host.clone(),
            sha256: self.sha256.clone(),
            spki_sha256: self.spki_sha256.clone(),
            subject: self.subject.clone(),
            not_after: self.not_after.clone(),
        }
    }
}

// --------------------------------------------------------------- pinning

/// SHA-256 of `bytes`, lower-case hex.
pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// A trusted host as the verifier checks it.
#[derive(Debug, Clone, PartialEq)]
struct Pin {
    host: String,
    sha256: String,
}

fn pins_of(trusted: &[TrustedHost]) -> Vec<Pin> {
    trusted
        .iter()
        .filter_map(|t| {
            let host = t.host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
            normalize_fingerprint(&t.sha256).map(|sha256| Pin { host, sha256 })
        })
        .collect()
}

/// What [`PinVerifier`] decides for a certificate of `host`: `Some(true)` accept (pinned and
/// matching), `Some(false)` reject (pinned, different certificate), `None` = not pinned (the
/// normal verification decides).
fn pin_decision(pins: &[Pin], host: &str, leaf: &[u8]) -> Option<bool> {
    let host = host.trim_matches(['[', ']']).trim_end_matches('.').to_ascii_lowercase();
    let mut own = pins.iter().filter(|p| p.host == host).peekable();
    own.peek()?;
    let fp = sha256_hex(leaf);
    Some(own.any(|p| p.sha256 == fp))
}

struct PinMismatch(String);

/// rustls shows the error with `Debug`; the user reads it in the connection test.
impl std::fmt::Debug for PinMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(self, f)
    }
}

impl std::fmt::Display for PinMismatch {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}",
            trf!(
                "Das Zertifikat von {} passt nicht zum vertrauten Fingerabdruck",
                "The certificate of {} does not match the trusted fingerprint",
                self.0
            )
        )
    }
}

impl std::error::Error for PinMismatch {}

mod tls {
    use std::sync::Arc;

    use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
    use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use rustls::{CertificateError, DigitallySignedStruct, OtherError, SignatureScheme};

    use super::{Pin, PinMismatch, pin_decision};

    pub(super) fn host_of(name: &ServerName<'_>) -> String {
        match name {
            ServerName::DnsName(d) => d.as_ref().to_owned(),
            ServerName::IpAddress(ip) => std::net::IpAddr::from(*ip).to_string(),
            _ => String::new(),
        }
    }

    /// The platform verifier (system roots plus the profile's extra CAs), except for pinned
    /// hosts, whose leaf must match the fingerprint. With `capture`, the leaf is recorded and
    /// the connection always refused (to show a certificate without sending anything).
    #[derive(Debug)]
    pub(super) struct PinVerifier {
        pub inner: Arc<dyn ServerCertVerifier>,
        pub pins: Vec<Pin>,
        pub capture: Option<super::Capture>,
    }

    impl ServerCertVerifier for PinVerifier {
        fn verify_server_cert(
            &self,
            end_entity: &CertificateDer<'_>,
            intermediates: &[CertificateDer<'_>],
            server_name: &ServerName<'_>,
            ocsp_response: &[u8],
            now: UnixTime,
        ) -> Result<ServerCertVerified, rustls::Error> {
            let host = host_of(server_name);
            if let Some(c) = &self.capture {
                if let Ok(mut slot) = c.lock() {
                    *slot = Some((end_entity.to_vec(), host));
                }
                return Err(rustls::Error::General("certificate captured".into()));
            }
            match pin_decision(&self.pins, &host, end_entity) {
                Some(true) => Ok(ServerCertVerified::assertion()),
                Some(false) => Err(rustls::Error::InvalidCertificate(CertificateError::Other(OtherError(Arc::new(
                    PinMismatch(host),
                ))))),
                None => self.inner.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now),
            }
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            self.inner.verify_tls12_signature(message, cert, dss)
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &CertificateDer<'_>,
            dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, rustls::Error> {
            self.inner.verify_tls13_signature(message, cert, dss)
        }

        fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
            self.inner.supported_verify_schemes()
        }
    }

    #[cfg(not(target_os = "android"))]
    fn verifier(
        extra_roots: &[Vec<u8>],
        provider: &Arc<rustls::crypto::CryptoProvider>,
    ) -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
        Ok(if extra_roots.is_empty() {
            Arc::new(rustls_platform_verifier::Verifier::new(provider.clone())?)
        } else {
            Arc::new(rustls_platform_verifier::Verifier::new_with_extra_roots(
                extra_roots.iter().map(|d| CertificateDer::from(d.clone())),
                provider.clone(),
            )?)
        })
    }

    /// Android: the platform verifier needs the app's JVM context and its Kotlin part; the
    /// companion app checks against Mozilla's root store (compiled in) plus the extra CAs instead.
    #[cfg(target_os = "android")]
    fn verifier(
        extra_roots: &[Vec<u8>],
        provider: &Arc<rustls::crypto::CryptoProvider>,
    ) -> Result<Arc<dyn ServerCertVerifier>, rustls::Error> {
        let mut roots = rustls::RootCertStore::empty();
        roots.add_parsable_certificates(webpki_root_certs::TLS_SERVER_ROOT_CERTS.iter().cloned());
        roots.add_parsable_certificates(extra_roots.iter().map(|d| CertificateDer::from(d.clone())));
        let v = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .map_err(|e| rustls::Error::General(e.to_string()))?;
        Ok(v)
    }

    /// A rustls configuration for reqwest with [`PinVerifier`].
    pub(super) fn config(
        extra_roots: &[Vec<u8>],
        pins: Vec<Pin>,
        capture: Option<super::Capture>,
    ) -> Result<rustls::ClientConfig, rustls::Error> {
        let provider = rustls::crypto::CryptoProvider::get_default()
            .cloned()
            .unwrap_or_else(|| Arc::new(rustls::crypto::aws_lc_rs::default_provider()));
        let inner = verifier(extra_roots, &provider)?;
        let mut cfg = rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(PinVerifier { inner, pins, capture }))
            .with_no_client_auth();
        cfg.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(cfg)
    }
}

// ----------------------------------------------------------------- clients

/// The proxy a URL takes, for the settings page and the log.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RouteInfo {
    pub profile_id: String,
    pub profile_name: String,
    pub mode: ProxyMode,
    /// The proxy (without credentials); `None` = direct.
    pub proxy: Option<String>,
    /// Mode PAC: the stored answer used for the host (`DIRECT`, `PROXY firma:8080`).
    pub pac_answer: Option<String>,
    /// The host is in the profile's exceptions.
    pub bypassed: bool,
    /// The profile accepts any certificate (setting of 1.9).
    pub insecure: bool,
}

impl RouteInfo {
    /// `über Proxy firma:8080 (Firma)` / `direkt (Standard)` / `PAC → DIRECT (Firma)`, for the log.
    pub fn summary(&self) -> String {
        let way = match (&self.pac_answer, &self.proxy) {
            (Some(a), _) => format!("PAC → {a}"),
            (None, Some(p)) => format!("proxy {p}"),
            (None, None) => "direct".into(),
        };
        format!("{way} [{}]", self.profile_name)
    }
}

/// Scheme and host of `url` only (the path or query may hold a token, e.g. ICS addresses).
pub fn redacted_target(url: &str) -> String {
    match Url::parse(url) {
        Ok(u) => match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{}://{h}:{p}", u.scheme()),
            (Some(h), None) => format!("{}://{h}", u.scheme()),
            _ => u.scheme().to_owned(),
        },
        Err(_) => "?".into(),
    }
}

/// The route `service` takes to `url` (or in general, without a URL).
pub fn describe_route(net: &NetworkSettings, service: &Service, url: Option<&str>, system: &SystemProxy) -> RouteInfo {
    let profile = net.profile_for(service);
    let plan = ProxyPlan::new(&profile, None, system);
    let target = url.and_then(|u| Url::parse(u).ok()).filter(|u| u.host_str().is_some());
    let probe = target.clone().unwrap_or_else(|| Url::parse("https://example.com/").expect("static URL"));
    let host = target.as_ref().and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()));
    let bypassed = host.as_deref().is_some_and(|h| plan.bypass.matches(h));
    let pac_answer = match (&profile.mode, bypassed) {
        (ProxyMode::Pac, false) => {
            let key = host.as_deref().unwrap_or("*");
            profile.pac_results.get(key).or_else(|| profile.pac_results.get("*")).cloned()
        }
        _ => None,
    };
    RouteInfo {
        profile_id: net.route_of(service).unwrap_or(DEFAULT_PROFILE).to_owned(),
        profile_name: profile.name.clone(),
        mode: profile.mode,
        proxy: plan.resolve(&probe).map(|u| display_proxy(u.as_str())),
        pac_answer,
        bypassed,
        insecure: profile.legacy_accept_invalid_certs,
    }
}

/// Everything needed to configure a reqwest client, resolved once (CA file read, proxy
/// plan built), so applying it cannot fail.
#[derive(Clone)]
pub struct Prepared {
    plan: Arc<ProxyPlan>,
    /// DER of the extra root CAs.
    roots: Vec<Vec<u8>>,
    certs: Vec<reqwest::Certificate>,
    accept_invalid: bool,
    pins: Vec<Pin>,
    connect_timeout: Duration,
    read_timeout: Option<Duration>,
    /// `<service> [<profile>]` for the debug log.
    label: Arc<str>,
}

impl Prepared {
    /// A client configuration for `profile`; `password` is its proxy password from the
    /// credential store.
    pub fn new(profile: &ProxyProfile, password: Option<&str>, trusted: &[TrustedHost]) -> Result<Prepared> {
        let roots = match &profile.extra_ca_path {
            Some(p) => read_ca(p)?,
            None => vec![],
        };
        let certs = roots
            .iter()
            .map(|d| {
                reqwest::Certificate::from_der(d).map_err(|e| {
                    let p = profile.extra_ca_path.as_deref().unwrap_or_default();
                    Error::State(trf!("CA-Datei {p}: {e}", "CA file {p}: {e}"))
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let system = if profile.mode == ProxyMode::System { system_proxy() } else { SystemProxy::default() };
        Ok(Prepared {
            plan: Arc::new(ProxyPlan::new(profile, password, &system)),
            roots,
            certs,
            accept_invalid: profile.legacy_accept_invalid_certs,
            pins: pins_of(trusted),
            connect_timeout: profile.timeout(),
            read_timeout: (profile.read_timeout_secs > 0).then(|| Duration::from_secs(profile.read_timeout_secs)),
            label: Arc::from(format!("[{}]", profile.name)),
        })
    }

    /// The configuration for `service`: its profile, the password of that profile, the
    /// trusted servers and the service's read timeout.
    pub fn for_service(net: &NetworkSettings, passwords: Passwords<'_>, service: &Service) -> Result<Prepared> {
        let profile = net.profile_for(service);
        let password = passwords(&profile.id);
        let mut p = Prepared::new(&profile, password.as_deref(), &net.trusted_hosts)?;
        p.read_timeout = p.read_timeout.or_else(|| service.default_read_timeout());
        p.label = Arc::from(format!("{} [{}]", service.key(), profile.name));
        Ok(p)
    }

    pub fn plan(&self) -> &ProxyPlan {
        &self.plan
    }

    pub fn timeout(&self) -> Duration {
        self.connect_timeout
    }

    fn apply(&self, mut b: ClientBuilder, capture: Option<Capture>) -> Result<ClientBuilder> {
        b = b.connect_timeout(self.connect_timeout);
        if let Some(t) = self.read_timeout {
            b = b.read_timeout(t);
        }
        if capture.is_some() || (!self.pins.is_empty() && !self.accept_invalid) {
            let cfg =
                tls::config(&self.roots, self.pins.clone(), capture).map_err(|e| Error::State(format!("TLS: {e}")))?;
            b = b.tls_backend_preconfigured(cfg);
        } else {
            if !self.certs.is_empty() {
                b = b.tls_certs_merge(self.certs.clone());
            }
            if self.accept_invalid {
                b = b.tls_danger_accept_invalid_certs(true);
            }
        }
        let plan = self.plan.clone();
        let label = self.label.clone();
        b = b.no_proxy().proxy(reqwest::Proxy::custom(move |url| {
            let proxy = plan.resolve(url);
            tracing::debug!(
                source = "net",
                "{label} {} → {}",
                redacted_target(url.as_str()),
                proxy
                    .as_ref()
                    .map(|p| format!("proxy {}", display_proxy(p.as_str())))
                    .unwrap_or_else(|| "direct".into())
            );
            proxy
        }));
        Ok(b)
    }

    pub fn client(&self) -> Result<reqwest::Client> {
        Ok(self.apply(reqwest::Client::builder(), None)?.build()?)
    }

    /// The leaf certificate `url` presents on this route, without sending a request.
    pub async fn certificate(&self, url: &str) -> Result<Option<CertDetails>> {
        let slot: Capture = Arc::new(std::sync::Mutex::new(None));
        let client = self.apply(reqwest::Client::builder(), Some(slot.clone()))?.build()?;
        let _ = client.get(url).timeout(self.connect_timeout.max(Duration::from_secs(5))).send().await;
        let got = slot.lock().ok().and_then(|mut s| s.take());
        Ok(got.map(|(der, host)| cert_details(&der, &host)))
    }
}

type Capture = Arc<std::sync::Mutex<Option<(Vec<u8>, String)>>>;

/// Looks up a profile's proxy password (profile id → password).
pub type Passwords<'a> = &'a dyn Fn(&str) -> Option<String>;

/// The HTTP client of `service`: the one place that builds clients (a test checks that no
/// other code does), so every request takes the route Settings → Netzwerk shows.
pub fn client_for(net: &NetworkSettings, passwords: Passwords<'_>, service: &Service) -> Result<reqwest::Client> {
    let p = Prepared::for_service(net, passwords, service)?;
    tracing::debug!(source = "net", "client {} ({})", p.label, net.profile_for(service).mode_label());
    p.client()
}

impl ProxyProfile {
    fn mode_label(&self) -> &'static str {
        match self.mode {
            ProxyMode::None => "direct",
            ProxyMode::System => "system",
            ProxyMode::Manual => "manual",
            ProxyMode::Pac => "pac",
        }
    }
}

/// Fetches a PAC script (directly, without proxy; the profile's extra CA applies).
pub async fn fetch_pac(profile: &ProxyProfile, url: &str) -> Result<String> {
    if let Some(path) = url.strip_prefix("file://") {
        let path = path.strip_prefix('/').filter(|p| cfg!(windows) && p.chars().nth(1) == Some(':')).unwrap_or(path);
        let text = std::fs::read_to_string(path)
            .map_err(|e| Error::State(trf!("PAC-Datei {path}: {e}", "PAC file {path}: {e}")))?;
        return Ok(text);
    }
    let direct = ProxyProfile { mode: ProxyMode::None, ..profile.clone() };
    let client = Prepared::new(&direct, None, &[])?.client()?;
    let resp = client.get(url).timeout(profile.timeout()).send().await?;
    if !resp.status().is_success() {
        return Err(Error::State(trf!("PAC-Datei: HTTP {}", "PAC file: HTTP {}", resp.status())));
    }
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_PAC_BYTES {
        return Err(Error::State(tr!("PAC-Datei ist zu groß", "The PAC file is too large").into()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Whether an error text is about the server's certificate (the test then offers to show it).
pub fn is_certificate_error(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    ["certificate", "unknownissuer", "self signed", "self-signed", "invalid peer cert", "ssl peer", "fingerprint"]
        .iter()
        .any(|k| t.contains(k))
}

// --------------------------------------------------------------------- git

/// Environment and `-c` configuration for the system `git`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct GitNetwork {
    /// `None` removes the variable.
    pub env: Vec<(String, Option<String>)>,
    /// Passed as `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`.
    pub config: Vec<(String, String)>,
    /// The proxy password (redacted from git's output).
    pub secret: Option<String>,
}

const PROXY_VARS: &[&str] = &["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"];

/// Git settings for `remote_url` on `profile`: the proxy (via `http_proxy`/`https_proxy`/
/// `no_proxy`), the CA bundle (`http.sslCAInfo`, only when `ca_bundle` is given),
/// `http.sslVerify` for the setting of 1.9, and a trusted server's public key
/// (`http.pinnedPubkey`). SSH remotes and remotes without HTTP(S) get nothing.
pub fn git_network(
    profile: &ProxyProfile,
    password: Option<&str>,
    remote_url: &str,
    system: &SystemProxy,
    ca_bundle: Option<&str>,
    trusted: &[TrustedHost],
) -> GitNetwork {
    let mut g = GitNetwork::default();
    let lower = remote_url.trim().to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return g;
    }
    let plan = ProxyPlan::new(profile, password, system);
    match plan.resolve_str(remote_url.trim()).ok().flatten() {
        Some(proxy) => {
            for v in PROXY_VARS {
                let value = if v.starts_with("all") || v.starts_with("ALL") { None } else { Some(proxy.to_string()) };
                g.env.push(((*v).into(), value));
            }
            g.env.push(("no_proxy".into(), None));
            g.env.push(("NO_PROXY".into(), None));
        }
        None => {
            for v in PROXY_VARS {
                g.env.push(((*v).into(), None));
            }
            g.env.push(("no_proxy".into(), Some("*".into())));
            g.env.push(("NO_PROXY".into(), Some("*".into())));
        }
    }
    if let Some(path) = ca_bundle {
        g.config.push(("http.sslCAInfo".into(), path.into()));
    }
    let host = Url::parse(remote_url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()));
    let pinned: Vec<&TrustedHost> =
        trusted.iter().filter(|t| Some(&t.host) == host.as_ref() && !t.spki_sha256.is_empty()).collect();
    if profile.legacy_accept_invalid_certs {
        g.config.push(("http.sslVerify".into(), "false".into()));
    } else if !pinned.is_empty() {
        // curl checks the pinned key even without the chain check.
        g.config.push(("http.sslVerify".into(), "false".into()));
        let keys: Vec<String> = pinned.iter().map(|t| format!("sha256//{}", t.spki_sha256)).collect();
        g.config.push(("http.pinnedPubkey".into(), keys.join(";")));
    }
    g.secret = password.filter(|p| !p.is_empty()).map(str::to_owned);
    g
}

/// The Git environment for `service` (Git sync): [`git_network`] with the service's profile.
pub fn git_env_for(
    net: &NetworkSettings,
    passwords: Passwords<'_>,
    service: &Service,
    remote_url: &str,
    system: &SystemProxy,
    ca_bundle: Option<&str>,
) -> GitNetwork {
    let profile = net.profile_for(service);
    let password = passwords(&profile.id);
    let g = git_network(&profile, password.as_deref(), remote_url, system, ca_bundle, &net.trusted_hosts);
    let route = g
        .env
        .iter()
        .find(|(k, _)| k == "https_proxy")
        .and_then(|(_, v)| v.as_deref())
        .map(|p| format!("proxy {}", display_proxy(p)))
        .unwrap_or_else(|| "direct".into());
    tracing::debug!(
        source = "net",
        "{} [{}] git {} → {route}",
        service.key(),
        profile.name,
        redacted_target(remote_url)
    );
    g
}

/// Well-known CA bundles of Linux distributions and macOS.
const SYSTEM_BUNDLES: &[&str] = &[
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/ssl/cert.pem",
    "/usr/local/etc/openssl/cert.pem",
];

/// Writes the extra CA (as PEM) followed by the system bundle to `out` for
/// `http.sslCAInfo`, which replaces git's default bundle. Windows' Git uses the Windows
/// certificate store (schannel) instead, so the shell does not call this there.
pub fn write_git_ca_bundle(extra_ca_path: &str, out: &std::path::Path) -> Result<()> {
    let mut pem = String::new();
    for der in read_ca(extra_ca_path)? {
        pem.push_str("-----BEGIN CERTIFICATE-----\n");
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        for chunk in b64.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
            pem.push('\n');
        }
        pem.push_str("-----END CERTIFICATE-----\n");
    }
    if let Some(sys) = SYSTEM_BUNDLES.iter().find_map(|p| std::fs::read_to_string(p).ok()) {
        pem.push_str(&sys);
    }
    std::fs::write(out, pem)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str = include_str!("../testdata/test-ca.pem");
    const PEM2: &str = include_str!("../testdata/test-ca2.pem");

    #[test]
    fn malformed_certificate_time_does_not_panic() {
        fn tlv(tag: u8, content: &[u8]) -> Vec<u8> {
            let mut v = vec![tag, content.len() as u8];
            v.extend_from_slice(content);
            v
        }
        // UTCTime with „é“ straddling byte 2, GeneralizedTime likewise at byte 4.
        for (tag, time) in [(0x17, "aé1234Z"), (0x18, "202é0101000000Z")] {
            let validity = tlv(0x30, &[tlv(0x17, b"260101000000Z"), tlv(tag, time.as_bytes())].concat());
            let tbs = tlv(0x30, &[tlv(0x02, &[1]), tlv(0x30, &[]), tlv(0x30, &[]), validity, tlv(0x30, &[])].concat());
            let _ = ca_info(&tlv(0x30, &tbs));
        }
    }

    #[test]
    fn no_proxy_matching() {
        let np = NoProxy::parse(
            "intranet.firma.de, *.corp.local; .example.org 10.0.0.0/8 192.168.1.5 <local> fd00::/8 build-*",
        );
        // Exact host and its subdomains.
        assert!(np.matches("intranet.firma.de"));
        assert!(np.matches("wiki.intranet.firma.de"));
        assert!(!np.matches("xintranet.firma.de"));
        assert!(!np.matches("firma.de"));
        // *.domain and .domain: subdomains only.
        assert!(np.matches("a.corp.local") && np.matches("b.a.corp.local"));
        assert!(!np.matches("corp.local"));
        assert!(np.matches("www.example.org") && !np.matches("example.org"));
        // CIDR and IPs.
        assert!(np.matches("10.1.2.3") && !np.matches("11.1.2.3"));
        assert!(np.matches("192.168.1.5") && !np.matches("192.168.1.6"));
        assert!(np.matches("[fd00::1]") && !np.matches("fe80::1"));
        // <local>: names without a dot, never IPs.
        assert!(np.matches("fileserver"));
        assert!(!np.matches("llm.firma.de"));
        // Globs.
        assert!(np.matches("build-07.ci") && !np.matches("mybuild-07.ci"));
        // Case and trailing dot.
        assert!(np.matches("WIKI.Intranet.Firma.DE."));
        assert!(NoProxy::parse("*").matches("anything.example"));
        assert!(!NoProxy::parse("").matches("localhost"));
        assert!(NoProxy::parse("proxy.local:8080").matches("proxy.local"));
        // Windows style list with wildcards in the middle.
        let win = NoProxy::parse("10.*;*.intra;<local>");
        assert!(win.matches("10.20.30.40") && win.matches("app.intra") && win.matches("server"));
        assert!(!win.matches("110.1.1.1"));
    }

    #[test]
    fn proxy_url_normalization() {
        let n = |s: &str| normalize_proxy_url(s, "http").unwrap();
        assert_eq!(n(""), None);
        assert_eq!(n("proxy.firma.de:8080").as_deref(), Some("http://proxy.firma.de:8080"));
        assert_eq!(n(" http://proxy:3128/ ").as_deref(), Some("http://proxy:3128"));
        assert_eq!(n("https://proxy:443/path?x=1").as_deref(), Some("https://proxy"));
        assert_eq!(n("socks://s:1080").as_deref(), Some("socks5://s:1080"));
        assert_eq!(normalize_proxy_url("s:1080", "socks5").unwrap().as_deref(), Some("socks5://s:1080"));
        assert_eq!(n("http://max:geheim@proxy:8080").as_deref(), Some("http://max:geheim@proxy:8080"));
        assert_eq!(n("[::1]:3128").as_deref(), Some("http://[::1]:3128"));
        assert!(normalize_proxy_url("ftp://proxy:21", "http").is_err());
        assert!(normalize_proxy_url("http://", "http").is_err());
        assert_eq!(display_proxy("http://max:geheim@proxy:8080"), "http://proxy:8080");
    }

    #[test]
    fn wininet_registry_strings() {
        let sp = parse_wininet(1, "proxy.firma.de:8080", "*.firma.de;10.*;<local>", "");
        assert_eq!(sp.http.as_deref(), Some("http://proxy.firma.de:8080"));
        assert_eq!(sp.https.as_deref(), Some("http://proxy.firma.de:8080"));
        assert_eq!(sp.bypass, "*.firma.de, 10.*, <local>");
        assert_eq!(sp.pac_url, None);
        let sp = parse_wininet(1, "http=web:8080;https=secure:8443;socks=sox:1080", "", "http://wpad/wpad.dat");
        assert_eq!(sp.http.as_deref(), Some("http://web:8080"));
        assert_eq!(sp.https.as_deref(), Some("http://secure:8443"));
        assert_eq!(sp.socks.as_deref(), Some("socks4://sox:1080"));
        assert_eq!(sp.pac_url.as_deref(), Some("http://wpad/wpad.dat"));
        // Disabled: no proxy, even with a server string.
        let off = parse_wininet(0, "proxy:8080", "<local>", "");
        assert_eq!((off.http, off.https), (None, None));

        let plan = ProxyPlan::new(
            &ProxyProfile::default(),
            None,
            &parse_wininet(1, "proxy.firma.de:8080", "*.firma.de;<local>", ""),
        );
        let r = |u: &str| plan.resolve_str(u).unwrap().map(|u| u.to_string());
        assert_eq!(r("https://api.openai.com/v1").as_deref(), Some("http://proxy.firma.de:8080/"));
        assert_eq!(r("https://llm.firma.de/v1"), None);
        assert_eq!(r("http://llmserver:4000"), None);
    }

    #[test]
    fn env_proxy_variables() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |n: &str| pairs.iter().find(|(k, _)| *k == n).map(|(_, v)| v.to_string())
        };
        let sp = parse_env(env(&[("HTTPS_PROXY", "proxy:3128"), ("no_proxy", "localhost,.intra")]));
        assert_eq!(sp.https.as_deref(), Some("http://proxy:3128"));
        assert_eq!(sp.http, None);
        assert_eq!(sp.bypass, "localhost,.intra");
        let sp = parse_env(env(&[("ALL_PROXY", "socks5://s:1080")]));
        assert_eq!((sp.socks.as_deref(), sp.http), (Some("socks5://s:1080"), None));
    }

    #[test]
    fn manual_plan_uses_scheme_credentials_and_exceptions() {
        let net = ProxyProfile {
            mode: ProxyMode::Manual,
            http_proxy: "proxy:8080".into(),
            socks_proxy: "socks5://s:1080".into(),
            no_proxy: "localhost, *.intra".into(),
            proxy_user: "max".into(),
            ..Default::default()
        };
        let plan = ProxyPlan::new(&net, Some("ge heim"), &SystemProxy::default());
        let r = |u: &str| plan.resolve_str(u).unwrap().map(|u| u.to_string());
        assert_eq!(r("https://llm.example.com").as_deref(), Some("http://max:ge%20heim@proxy:8080/"));
        assert_eq!(r("http://llm.example.com").as_deref(), Some("http://max:ge%20heim@proxy:8080/"));
        assert_eq!(r("http://localhost:4000"), None);
        assert_eq!(r("https://git.intra/x.git"), None);
        let socks_only = ProxyProfile { http_proxy: String::new(), proxy_user: String::new(), ..net.clone() };
        let plan = ProxyPlan::new(&socks_only, None, &SystemProxy::default());
        assert_eq!(plan.resolve_str("https://x.de").unwrap().unwrap().as_str(), "socks5://s:1080");
        let none = ProxyProfile { mode: ProxyMode::None, ..net };
        assert_eq!(ProxyPlan::new(&none, None, &SystemProxy::default()).resolve_str("https://x.de").unwrap(), None);
    }

    #[test]
    fn pac_answers_per_host() {
        assert_eq!(
            parse_pac_answer("PROXY proxy.firma.de:8080; DIRECT").as_deref(),
            Some("http://proxy.firma.de:8080")
        );
        assert_eq!(parse_pac_answer("DIRECT"), None);
        assert_eq!(parse_pac_answer("SOCKS5 s:1080").as_deref(), Some("socks5://s:1080"));
        assert_eq!(parse_pac_answer("HTTPS secure:443").as_deref(), Some("https://secure"));
        assert_eq!(parse_pac_answer("  "), None);
        let net = ProxyProfile {
            mode: ProxyMode::Pac,
            pac_url: "http://wpad/proxy.pac".into(),
            pac_results: [("*".to_owned(), "PROXY p:3128".to_owned()), ("github.com".to_owned(), "DIRECT".to_owned())]
                .into(),
            no_proxy: String::new(),
            ..Default::default()
        };
        let plan = ProxyPlan::new(&net, None, &SystemProxy::default());
        assert_eq!(plan.resolve_str("https://llm.example.com").unwrap().unwrap().as_str(), "http://p:3128/");
        assert_eq!(plan.resolve_str("https://GitHub.com/x").unwrap(), None);
    }

    #[test]
    fn ca_from_pem_bundle_and_der() {
        let info = ca_info(PEM.as_bytes()).unwrap();
        assert_eq!(info.count, 1);
        assert_eq!(info.subject.as_deref(), Some("AETHER Test Root CA"));
        assert_eq!(info.not_after.as_deref(), Some("2036-09-21"));
        let bundle = format!("# Firmen-CAs\n{PEM}\n{PEM2}");
        let certs = parse_certificates(bundle.as_bytes()).unwrap();
        assert_eq!(certs.len(), 2);
        let der = certs[0].clone();
        let from_der = ca_info(&der).unwrap();
        assert_eq!((from_der.count, from_der.subject.as_deref()), (1, Some("AETHER Test Root CA")));
        assert_eq!(cert_summary(&certs[1]).0.as_deref(), Some("Zweite CA"));
        assert!(parse_certificates(b"hallo").is_err());
        assert!(parse_certificates(b"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----").is_err());
        // Both forms are accepted by the TLS stack.
        for d in &certs {
            reqwest::Certificate::from_der(d).unwrap();
        }
        let dir = std::env::temp_dir().join(format!("arcalo-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (pem_path, der_path) = (dir.join("ca.pem"), dir.join("ca.der"));
        std::fs::write(&pem_path, &bundle).unwrap();
        std::fs::write(&der_path, &der).unwrap();
        for p in [&pem_path, &der_path] {
            let net = ProxyProfile { extra_ca_path: Some(p.display().to_string()), ..Default::default() };
            Prepared::new(&net, None, &[]).unwrap().client().unwrap();
        }
        assert_eq!(ca_info_file(&pem_path.display().to_string()).unwrap().count, 2);
        let out = dir.join("bundle.pem");
        write_git_ca_bundle(&der_path.display().to_string(), &out).unwrap();
        assert_eq!(parse_certificates(&std::fs::read(&out).unwrap()).unwrap()[0], der);
        let missing =
            ProxyProfile { extra_ca_path: Some(dir.join("fehlt.pem").display().to_string()), ..Default::default() };
        assert!(Prepared::new(&missing, None, &[]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_validation() {
        let manual = ProxyProfile { mode: ProxyMode::Manual, ..Default::default() };
        assert!(manual.normalized().is_err(), "manual needs an address");
        let ok = ProxyProfile { http_proxy: " proxy:8080 ".into(), ..manual }.normalized().unwrap();
        assert_eq!(ok.http_proxy, "http://proxy:8080");
        let pac = ProxyProfile { mode: ProxyMode::Pac, pac_url: "javascript:alert(1)".into(), ..Default::default() };
        assert!(pac.normalized().is_err());
        let t = ProxyProfile { connect_timeout_secs: 0, extra_ca_path: Some("  ".into()), ..Default::default() }
            .normalized()
            .unwrap();
        assert_eq!((t.connect_timeout_secs, t.extra_ca_path), (1, None));
    }

    #[test]
    fn git_environment() {
        let net = ProxyProfile {
            mode: ProxyMode::Manual,
            https_proxy: "proxy:8080".into(),
            no_proxy: "git.intra".into(),
            proxy_user: "max".into(),
            legacy_accept_invalid_certs: true,
            ..Default::default()
        };
        let sys = SystemProxy::default();
        let g = git_network(&net, Some("pw"), "https://github.com/a/b.git", &sys, Some("/tmp/ca.pem"), &[]);
        let get = |k: &str| g.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("https_proxy"), Some(Some("http://max:pw@proxy:8080/".into())));
        assert_eq!(get("ALL_PROXY"), Some(None));
        assert_eq!(get("no_proxy"), Some(None));
        assert!(g.config.contains(&("http.sslCAInfo".into(), "/tmp/ca.pem".into())));
        assert!(g.config.contains(&("http.sslVerify".into(), "false".into())));
        assert_eq!(g.secret.as_deref(), Some("pw"));
        // Exception: direct, and environment proxies are switched off.
        let g = git_network(&net, None, "https://git.intra/x.git", &sys, None, &[]);
        assert!(g.env.contains(&("NO_PROXY".into(), Some("*".into()))));
        assert!(g.env.contains(&("https_proxy".into(), None)));
        // SSH: untouched.
        assert_eq!(git_network(&net, None, "git@github.com:a/b.git", &sys, None, &[]), GitNetwork::default());
    }

    fn all_services() -> Vec<Service> {
        vec![
            Service::Updates,
            Service::ReleaseNotes,
            Service::VoiceModels,
            Service::Ai { id: "litellm".into(), local: false },
            Service::Jira("intern".into()),
            Service::GitSync,
            Service::Ics("team".into()),
            Service::LinkPreview,
            Service::HttpTool,
        ]
    }

    /// With one profile, every service takes the route the single setting of 1.9 gave it.
    #[test]
    fn resolver_with_the_default_profile_equals_the_single_setting() {
        let old = ProxyProfile {
            mode: ProxyMode::Manual,
            http_proxy: "proxy:8080".into(),
            https_proxy: "secure:8443".into(),
            no_proxy: "localhost, *.intra".into(),
            proxy_user: "max".into(),
            ..Default::default()
        };
        let net = NetworkSettings { profiles: vec![old.clone()], ..Default::default() };
        let pw = |id: &str| (id == DEFAULT_PROFILE).then(|| "pw".to_owned());
        let sys = SystemProxy::default();
        let old_plan = ProxyPlan::new(&old, Some("pw"), &sys);
        for s in all_services() {
            assert_eq!(net.profile_for(&s), old, "{s:?}");
            assert_eq!(net.route_of(&s), None);
            let p = Prepared::for_service(&net, &pw, &s).unwrap();
            for url in
                ["https://api.example.com/v1", "http://llm.example.com", "http://localhost:4000", "https://git.intra/x"]
            {
                assert_eq!(p.plan().resolve_str(url).unwrap(), old_plan.resolve_str(url).unwrap(), "{s:?} {url}");
            }
            assert_eq!((p.timeout(), p.accept_invalid, p.pins.len()), (Duration::from_secs(30), false, 0));
            client_for(&net, &pw, &s).unwrap();
        }
        assert_eq!(
            Prepared::for_service(&net, &pw, &Service::HttpTool).unwrap().plan().resolve_str("https://x.de").unwrap(),
            Some(Url::parse("http://max:pw@secure:8443").unwrap())
        );
        // Read timeouts as before: downloads 60 s, everything else none.
        assert_eq!(
            Prepared::for_service(&net, &pw, &Service::Updates).unwrap().read_timeout,
            Some(Duration::from_secs(60))
        );
        assert_eq!(
            Prepared::for_service(&net, &pw, &Service::VoiceModels).unwrap().read_timeout,
            Some(Duration::from_secs(60))
        );
        assert_eq!(Prepared::for_service(&net, &pw, &Service::HttpTool).unwrap().read_timeout, None);
        // A local provider (bypass_proxy) goes direct on the default profile.
        let local = Service::Ai { id: "ollama".into(), local: true };
        assert_eq!(
            Prepared::for_service(&net, &pw, &local).unwrap().plan().resolve_str("http://gpu:11434").unwrap(),
            None
        );
        // Git gets the environment the single setting gave it.
        let g = git_env_for(&net, &pw, &Service::GitSync, "https://github.com/a/b.git", &sys, None);
        assert_eq!(g, git_network(&old, Some("pw"), "https://github.com/a/b.git", &sys, None, &[]));
        assert!(g.env.contains(&("https_proxy".into(), Some("http://max:pw@secure:8443/".into()))));
        // The legacy switch keeps accepting every certificate, for clients and Git.
        let insecure = NetworkSettings {
            profiles: vec![ProxyProfile { legacy_accept_invalid_certs: true, ..old.clone() }],
            ..Default::default()
        };
        assert!(insecure.insecure());
        assert!(Prepared::for_service(&insecure, &pw, &Service::Updates).unwrap().accept_invalid);
        let g = git_env_for(&insecure, &pw, &Service::GitSync, "https://github.com/a/b.git", &sys, None);
        assert!(g.config.contains(&("http.sslVerify".into(), "false".into())));
        // Defaults: one profile „Standard“ in mode `system`, as before.
        let d = NetworkSettings::default();
        assert_eq!(
            (d.profiles.len(), d.standard().mode, d.standard().no_proxy.as_str()),
            (1, ProxyMode::System, "localhost, 127.0.0.1, ::1")
        );
        assert_eq!(d.normalized().unwrap(), d);
    }

    #[test]
    fn services_route_to_their_profiles() {
        let firma = ProxyProfile {
            id: "firma".into(),
            name: "Firma".into(),
            mode: ProxyMode::Manual,
            http_proxy: "firma:8080".into(),
            no_proxy: "".into(),
            ..Default::default()
        };
        let vpn = ProxyProfile {
            id: "vpn".into(),
            name: "VPN".into(),
            mode: ProxyMode::None,
            connect_timeout_secs: 5,
            read_timeout_secs: 120,
            ..Default::default()
        };
        let route = |k: &str, v: &str| (k.to_owned(), v.to_owned());
        let net = NetworkSettings {
            profiles: vec![ProxyProfile { mode: ProxyMode::None, ..Default::default() }, firma, vpn],
            routes: [
                route("ai", "firma"),
                route("ai:local-llm", "vpn"),
                route("jira:intern", "vpn"),
                route("updates", "firma"),
                route("ics:team", "weg"),
            ]
            .into(),
            ..Default::default()
        };
        let id = |s: &Service| net.profile_for(s).id;
        let openai = Service::Ai { id: "openai".into(), local: false };
        assert_eq!(id(&openai), "firma", "group route");
        assert_eq!(id(&Service::Ai { id: "local-llm".into(), local: false }), "vpn", "own route wins");
        assert_eq!(id(&Service::Ai { id: "ollama".into(), local: true }), "firma", "explicit route wins over bypass");
        assert_eq!(id(&Service::Jira("intern".into())), "vpn");
        assert_eq!(id(&Service::Jira("cloud".into())), DEFAULT_PROFILE);
        assert_eq!(id(&Service::Ics("team".into())), DEFAULT_PROFILE, "a missing profile falls back");
        assert_eq!(id(&Service::Updates), "firma");
        assert_eq!(id(&Service::ReleaseNotes), DEFAULT_PROFILE);
        let sys = SystemProxy::default();
        let r = describe_route(&net, &openai, Some("https://api.openai.com/v1"), &sys);
        assert_eq!((r.profile_name.as_str(), r.proxy.as_deref()), ("Firma", Some("http://firma:8080")));
        assert_eq!(r.summary(), "proxy http://firma:8080 [Firma]");
        let r = describe_route(&net, &Service::Jira("intern".into()), Some("https://jira.intern"), &sys);
        assert_eq!((r.profile_id.as_str(), r.proxy), ("vpn", None));
        let p = Prepared::for_service(&net, &|_| None, &Service::Jira("intern".into())).unwrap();
        assert_eq!((p.timeout(), p.read_timeout), (Duration::from_secs(5), Some(Duration::from_secs(120))));
        assert_eq!(net.timeout_for(&Service::Jira("intern".into())), Duration::from_secs(5));
        // Keys round-trip.
        for s in all_services() {
            assert_eq!(Service::parse(&s.key()), Some(s.clone()));
            assert!(valid_route_key(&s.key()) && valid_route_key(s.group()));
        }
        assert_eq!(Service::parse("ai:"), None);
        assert_eq!(Service::parse("outlook"), None);
        // Normalizing drops routes to missing profiles and unknown keys, keeps the default
        // profile and makes ids unique.
        let mut odd = net.clone();
        odd.routes.insert("outlook".into(), "vpn".into());
        odd.profiles.retain(|p| p.id != DEFAULT_PROFILE);
        odd.profiles.push(ProxyProfile { id: "".into(), name: "Firma".into(), ..Default::default() });
        odd.profiles.push(ProxyProfile { id: "".into(), name: "Standard".into(), ..Default::default() });
        let n = odd.normalized().unwrap();
        let ids: Vec<&str> = n.profiles.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, [DEFAULT_PROFILE, "firma", "vpn", "firma-2", "standard-2"]);
        assert!(!n.routes.contains_key("outlook") && !n.routes.contains_key("ics:team"));
        assert_eq!(n.routes.get("ai").map(String::as_str), Some("firma"));
        let bad = NetworkSettings {
            trusted_hosts: vec![TrustedHost { host: "x.de".into(), sha256: "abc".into(), ..Default::default() }],
            ..Default::default()
        };
        assert!(bad.normalized().is_err());
    }

    #[test]
    fn pinned_hosts_accept_their_certificate_and_reject_others() {
        use rustls::client::danger::ServerCertVerifier;
        use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
        let der = parse_certificates(PEM.as_bytes()).unwrap().remove(0);
        let other = parse_certificates(PEM2.as_bytes()).unwrap().remove(0);
        let fp = sha256_hex(&der);
        let colons = fp
            .as_bytes()
            .chunks(2)
            .map(|c| std::str::from_utf8(c).unwrap().to_uppercase())
            .collect::<Vec<_>>()
            .join(":");
        assert_eq!(normalize_fingerprint(&colons).as_deref(), Some(fp.as_str()));
        assert_eq!(normalize_fingerprint("zz"), None);
        let trusted = [TrustedHost { host: "git.firma.de".into(), sha256: colons, ..Default::default() }];
        let pins = pins_of(&trusted);
        assert_eq!(pin_decision(&pins, "git.firma.de", &der), Some(true));
        assert_eq!(pin_decision(&pins, "GIT.firma.de.", &der), Some(true));
        assert_eq!(pin_decision(&pins, "git.firma.de", &other), Some(false));
        assert_eq!(pin_decision(&pins, "jira.firma.de", &der), None);

        let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
        let inner = Arc::new(rustls_platform_verifier::Verifier::new(provider).unwrap());
        let v = tls::PinVerifier { inner, pins, capture: None };
        let check = |host: &'static str, cert: &[u8]| {
            v.verify_server_cert(
                &CertificateDer::from(cert.to_vec()),
                &[],
                &ServerName::try_from(host).unwrap(),
                &[],
                UnixTime::now(),
            )
        };
        assert!(check("git.firma.de", &der).is_ok(), "pinned: accepted although no CA vouches for it");
        let err = check("git.firma.de", &other).unwrap_err().to_string();
        assert!(err.contains("Fingerabdruck") || err.contains("fingerprint"), "{err}");
        assert!(check("jira.firma.de", &der).is_err(), "not pinned: the normal check decides");

        let d = cert_details(&der, "[Git.Firma.de]");
        assert_eq!((d.host.as_str(), d.sha256.as_str()), ("git.firma.de", fp.as_str()));
        assert_eq!(d.subject.as_deref(), Some("AETHER Test Root CA"));
        assert!(d.self_signed);
        assert_eq!(d.spki_sha256.len(), 44, "{}", d.spki_sha256);
        Prepared::new(&ProxyProfile::default(), None, &trusted).unwrap().client().unwrap();
        // Git pins the public key of a trusted server and turns off only the chain check.
        let direct = ProxyProfile { mode: ProxyMode::None, ..Default::default() };
        let sys = SystemProxy::default();
        let g = git_network(&direct, None, "https://git.firma.de/x.git", &sys, None, &[d.trusted()]);
        assert!(g.config.contains(&("http.pinnedPubkey".into(), format!("sha256//{}", d.spki_sha256))));
        assert!(g.config.contains(&("http.sslVerify".into(), "false".into())));
        let g = git_network(&direct, None, "https://github.com/x.git", &sys, None, &[d.trusted()]);
        assert!(g.config.is_empty(), "other hosts keep the full check");
    }

    #[test]
    fn policy_sets_and_locks_routes_and_profiles() {
        use crate::update_policy::Policy;
        let policy = Policy::from_json(
            "policy.json",
            r#"{"NetworkRoute.ai":"Firma","NetworkRoute.jira:intern":"vpn","NetworkRoute.updates":"Standard",
                "NetworkRoute.outlook":"x","LockNetworkProfiles":1}"#,
        )
        .unwrap();
        assert_eq!(policy.network_routes.len(), 3);
        assert_eq!(policy.warnings.len(), 1, "{:?}", policy.warnings);
        let np = policy.network();
        assert!(np.lock_profiles);
        let profile = |id: &str, name: &str| ProxyProfile { id: id.into(), name: name.into(), ..Default::default() };
        let mut net = NetworkSettings {
            profiles: vec![ProxyProfile::default(), profile("firma", "Firma"), profile("vpn", "VPN")],
            routes: [("ai:openai".to_owned(), "vpn".to_owned()), ("updates".to_owned(), "firma".to_owned())].into(),
            ..Default::default()
        };
        assert!(np.apply(&mut net).is_empty());
        let want: BTreeMap<String, String> =
            [("ai".to_owned(), "firma".to_owned()), ("jira:intern".to_owned(), "vpn".to_owned())].into();
        assert_eq!(net.routes, want);
        let openai = Service::Ai { id: "openai".into(), local: false };
        assert!(np.locks(&openai) && np.locks(&Service::Jira("intern".into())) && np.locks(&Service::Updates));
        assert!(!np.locks(&Service::Jira("cloud".into())) && !np.locks(&Service::GitSync));
        // Saving: locked routes and locked profiles stay.
        let before = net.clone();
        let mut next = net.clone();
        next.routes.insert("ai".into(), "vpn".into());
        next.routes.insert("git_sync".into(), "vpn".into());
        next.profiles[1].http_proxy = "anders:1".into();
        next.profiles.push(profile("neu", "Neu"));
        np.enforce(&before, &mut next);
        assert_eq!(next.profiles, before.profiles);
        assert_eq!(next.routes.get("ai").map(String::as_str), Some("firma"));
        assert_eq!(next.routes.get("git_sync").map(String::as_str), Some("vpn"), "unlocked routes are free");
        // A policy naming a profile this computer does not have is ignored with a warning.
        let missing = NetworkPolicy {
            routes: [("git_sync".to_owned(), "Gibt es nicht".to_owned())].into(),
            lock_profiles: false,
        };
        assert_eq!(missing.apply(&mut next).len(), 1);
        assert_eq!(next.routes.get("git_sync").map(String::as_str), Some("vpn"));
        // HKLM over the file.
        let hklm = Policy::from_values(
            r"HKLM\Software\Policies\MouseWerk\Arcalo",
            [("NetworkRoute.ai".to_owned(), crate::update_policy::Value::Text("VPN".into()))],
        );
        let merged = Policy::merge([hklm, policy]);
        assert_eq!(merged.network_routes.get("ai").map(String::as_str), Some("VPN"));
        assert_eq!(merged.network_routes.len(), 3);
    }

    /// Every reqwest client comes from [`client_for`] (through [`Prepared`]), so no request
    /// leaves without the route Settings → Netzwerk shows. Test code is not checked.
    #[test]
    fn no_client_is_built_outside_the_resolver() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = vec![];
        let mut stack = vec![root.join("src"), root.join("../../src-tauri/src")];
        while let Some(dir) = stack.pop() {
            for e in std::fs::read_dir(&dir).unwrap().flatten() {
                let p = e.path();
                if p.is_dir() {
                    stack.push(p);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    files.push(p);
                }
            }
        }
        assert!(files.len() > 50, "sources not found: {}", files.len());
        let patterns = [
            "reqwest::Client::new(",
            "reqwest::Client::builder(",
            " Client::new()",
            "(Client::new()",
            "Client::builder()",
            "ClientBuilder::new(",
            "reqwest::get(",
            "blocking::Client",
            "HttpClient::new(",
        ];
        let mut stray = vec![];
        for f in &files {
            if f.ends_with("src/network.rs") && f.parent().is_some_and(|d| d.ends_with("arcalo-core/src")) {
                continue;
            }
            let text = std::fs::read_to_string(f).unwrap();
            let code = text.split("#[cfg(test)]").next().unwrap_or_default();
            for (i, line) in code.lines().enumerate() {
                if patterns.iter().any(|p| line.contains(p)) && !line.trim_start().starts_with("//") {
                    stray.push(format!("{}:{}: {}", f.display(), i + 1, line.trim()));
                }
            }
        }
        assert!(stray.is_empty(), "build HTTP clients with network::client_for(Service):\n{}", stray.join("\n"));
        // The core itself builds them only in `Prepared`.
        let own = std::fs::read_to_string(root.join("src/network.rs")).unwrap();
        let code = own.split("#[cfg(test)]").next().unwrap();
        assert_eq!(code.matches("reqwest::Client::builder()").count(), 2, "Prepared::client and ::certificate");
    }
}
