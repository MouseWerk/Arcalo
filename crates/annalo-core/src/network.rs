//! Network settings: proxy, extra root certificate and timeouts for every outgoing
//! connection (LiteLLM, the assistant's HTTP tool, Git, the updater).
//!
//! One place decides which proxy a URL goes through ([`ProxyPlan`]); the reqwest clients
//! ([`http_client`]), the Git environment ([`git_network`]) and the updater ([`Prepared`])
//! are all built from it, so the connection test reports exactly what the app does.
//!
//! Modes:
//! * `none` – always direct (environment variables are ignored)
//! * `system` – Windows: the WinINet settings of the current user (registry
//!   `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`); elsewhere the
//!   `HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` environment variables
//! * `manual` – HTTP, HTTPS and SOCKS proxy with an exception list
//! * `pac` – a proxy auto-config script. PAC files are JavaScript; the core does not embed a
//!   JS engine. The UI evaluates `FindProxyForURL` in a sandboxed frame for the hosts the app
//!   talks to and stores the answers in [`NetworkSettings::pac_results`] (host → answer,
//!   `*` = answer for the LiteLLM host, used for all other hosts).
//!
//! The proxy password lives in the OS credential store (account [`PASSWORD_ACCOUNT`]).

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

/// Which connections use the proxy settings. Connections that do not keep the program's
/// default behavior (reqwest and Git read the proxy environment variables).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ApplyTo {
    pub ai: bool,
    pub git: bool,
    pub updates: bool,
    pub tools: bool,
}

impl Default for ApplyTo {
    fn default() -> Self {
        ApplyTo { ai: true, git: true, updates: true, tools: true }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NetworkSettings {
    pub mode: ProxyMode,
    /// `host:port` or a URL; used for `http://` targets.
    pub http_proxy: String,
    /// Used for `https://` targets; empty = the HTTP proxy.
    pub https_proxy: String,
    /// `host:port` or `socks5://host:port`; used when no HTTP(S) proxy is set.
    pub socks_proxy: String,
    /// Exceptions: `host`, `*.domain`, `.domain`, IP, CIDR, `<local>`, `*`; comma separated.
    pub no_proxy: String,
    pub pac_url: String,
    /// `FindProxyForURL` answers per host (`*` = default), filled by the UI.
    pub pac_results: BTreeMap<String, String>,
    /// User name for the proxy; the password is in the credential store.
    pub proxy_user: String,
    /// PEM (one or more certificates) or DER file of an additional root CA.
    pub extra_ca_path: Option<String>,
    /// Accept any certificate (dangerous; only for diagnosis).
    pub accept_invalid_certs: bool,
    /// Connect timeout in seconds (and the total timeout of tests and tool requests).
    pub timeout_secs: u64,
    pub apply_to: ApplyTo,
}

impl Default for NetworkSettings {
    fn default() -> Self {
        NetworkSettings {
            mode: ProxyMode::System,
            http_proxy: String::new(),
            https_proxy: String::new(),
            socks_proxy: String::new(),
            no_proxy: "localhost, 127.0.0.1, ::1".into(),
            pac_url: String::new(),
            pac_results: BTreeMap::new(),
            proxy_user: String::new(),
            extra_ca_path: None,
            accept_invalid_certs: false,
            timeout_secs: 30,
            apply_to: ApplyTo::default(),
        }
    }
}

/// What a connection is for (decides whether [`ApplyTo`] covers it).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Purpose {
    Ai,
    Git,
    Updates,
    Tools,
}

impl NetworkSettings {
    pub fn applies(&self, p: Purpose) -> bool {
        match p {
            Purpose::Ai => self.apply_to.ai,
            Purpose::Git => self.apply_to.git,
            Purpose::Updates => self.apply_to.updates,
            Purpose::Tools => self.apply_to.tools,
        }
    }

    pub fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_secs.clamp(1, 600))
    }

    /// Trims and validates the fields; proxy addresses become URLs (`host:port` →
    /// `http://host:port`).
    pub fn normalized(&self) -> Result<NetworkSettings> {
        let mut n = self.clone();
        n.http_proxy = normalize_proxy_url(&self.http_proxy, "http")?.unwrap_or_default();
        n.https_proxy = normalize_proxy_url(&self.https_proxy, "http")?.unwrap_or_default();
        n.socks_proxy = normalize_proxy_url(&self.socks_proxy, "socks5")?.unwrap_or_default();
        n.no_proxy = self.no_proxy.trim().to_owned();
        n.pac_url = self.pac_url.trim().to_owned();
        if !n.pac_url.is_empty() {
            let u =
                Url::parse(&n.pac_url).map_err(|_| Error::State(format!("PAC-URL „{}“ ist ungültig", n.pac_url)))?;
            if !matches!(u.scheme(), "http" | "https" | "file") {
                return Err(Error::State("Die PAC-URL muss mit http://, https:// oder file:// beginnen".into()));
            }
        }
        n.proxy_user = self.proxy_user.trim().to_owned();
        n.extra_ca_path = self.extra_ca_path.as_deref().map(str::trim).filter(|p| !p.is_empty()).map(str::to_owned);
        n.timeout_secs = self.timeout_secs.clamp(1, 600);
        if n.mode == ProxyMode::Manual
            && n.http_proxy.is_empty()
            && n.https_proxy.is_empty()
            && n.socks_proxy.is_empty()
        {
            return Err(Error::State("Für einen manuellen Proxy bitte mindestens eine Proxy-Adresse eintragen".into()));
        }
        if n.mode == ProxyMode::Pac && n.pac_url.is_empty() {
            return Err(Error::State("Bitte die Adresse der PAC-Datei eintragen".into()));
        }
        Ok(n)
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
    let bad = || Error::State(format!("Proxy-Adresse „{s}“ ist ungültig (erwartet host:port oder eine URL)"));
    let mut url = Url::parse(&with_scheme).map_err(|_| bad())?;
    let scheme = match url.scheme() {
        "socks" => "socks5".to_owned(),
        s @ ("http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h") => s.to_owned(),
        other => return Err(Error::State(format!("Proxy-Protokoll „{other}“ wird nicht unterstützt"))),
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
        source: "Windows-Interneteinstellungen".into(),
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
        source: "Umgebungsvariablen (HTTP_PROXY, HTTPS_PROXY, NO_PROXY)".into(),
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
    pub fn new(net: &NetworkSettings, password: Option<&str>, system: &SystemProxy) -> ProxyPlan {
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
            let end =
                body.find("-----END CERTIFICATE-----").ok_or_else(|| Error::Parse("PEM: END-Zeile fehlt".into()))?;
            let b64: String = body[..end].chars().filter(|c| !c.is_whitespace()).collect();
            let der = base64::engine::general_purpose::STANDARD
                .decode(b64)
                .map_err(|e| Error::Parse(format!("PEM: ungültiges Base64 ({e})")))?;
            out.push(der);
            rest = &body[end..];
        }
        if out.is_empty() {
            return Err(Error::Parse("Die Datei enthält keinen Block „BEGIN CERTIFICATE“".into()));
        }
        return Ok(out);
    }
    if bytes.first() == Some(&0x30) && der_tlv(bytes).is_some() {
        return Ok(vec![bytes.to_vec()]);
    }
    Err(Error::Parse("Kein Zertifikat im PEM- oder DER-Format".into()))
}

/// Reads and summarizes a CA file.
pub fn ca_info(bytes: &[u8]) -> Result<CaInfo> {
    let certs = parse_certificates(bytes)?;
    let (subject, not_after) = certs.first().map(|c| cert_summary(c)).unwrap_or((None, None));
    Ok(CaInfo { count: certs.len(), subject, not_after })
}

fn read_ca(path: &str) -> Result<Vec<Vec<u8>>> {
    let meta = std::fs::metadata(path).map_err(|e| Error::State(format!("CA-Datei {path}: {e}")))?;
    if meta.len() > MAX_CA_BYTES {
        return Err(Error::State(format!("CA-Datei {path} ist zu groß")));
    }
    let bytes = std::fs::read(path).map_err(|e| Error::State(format!("CA-Datei {path}: {e}")))?;
    parse_certificates(&bytes).map_err(|e| Error::State(format!("CA-Datei {path}: {e}")))
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

/// Subject (CN, else O) and notAfter of a DER certificate; best effort.
fn cert_summary(der: &[u8]) -> (Option<String>, Option<String>) {
    let parse = || -> Option<(Option<String>, Option<String>)> {
        let (_, cert, _) = der_tlv(der)?;
        let (_, tbs, _) = der_tlv(cert)?;
        let mut rest = tbs;
        let (tag, _, r) = der_tlv(rest)?;
        if tag == 0xa0 {
            rest = r; // version
        }
        let (_, _, r) = der_tlv(rest)?; // serial
        let (_, _, r) = der_tlv(r)?; // signature algorithm
        let (_, _, r) = der_tlv(r)?; // issuer
        let (_, validity, r) = der_tlv(r)?;
        let (_, subject, _) = der_tlv(r)?;
        let (_, _, v) = der_tlv(validity)?;
        let (ttag, time, _) = der_tlv(v)?;
        let t = std::str::from_utf8(time).ok()?;
        let not_after = match ttag {
            0x17 if t.len() >= 6 && t.is_ascii() => {
                let yy: u32 = t[0..2].parse().ok()?;
                Some(format!("{}-{}-{}", if yy >= 50 { 1900 + yy } else { 2000 + yy }, &t[2..4], &t[4..6]))
            }
            0x18 if t.len() >= 8 && t.is_ascii() => Some(format!("{}-{}-{}", &t[0..4], &t[4..6], &t[6..8])),
            _ => None,
        };
        let (mut cn, mut org) = (None, None);
        let mut rdns = subject;
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
        Some((cn.or(org), not_after))
    };
    parse().unwrap_or((None, None))
}

// ----------------------------------------------------------------- clients

/// Everything needed to configure a reqwest client, resolved once (CA file read, proxy
/// plan built), so applying it cannot fail.
#[derive(Clone)]
pub struct Prepared {
    plan: Option<Arc<ProxyPlan>>,
    certs: Vec<reqwest::Certificate>,
    accept_invalid: bool,
    connect_timeout: Duration,
}

impl Prepared {
    /// `password` is the proxy password from the credential store.
    pub fn new(net: &NetworkSettings, password: Option<&str>, purpose: Purpose) -> Result<Prepared> {
        let certs = match &net.extra_ca_path {
            Some(p) => read_ca(p)?
                .iter()
                .map(|d| reqwest::Certificate::from_der(d).map_err(|e| Error::State(format!("CA-Datei {p}: {e}"))))
                .collect::<Result<Vec<_>>>()?,
            None => vec![],
        };
        let plan = net.applies(purpose).then(|| {
            let system = if net.mode == ProxyMode::System { system_proxy() } else { SystemProxy::default() };
            Arc::new(ProxyPlan::new(net, password, &system))
        });
        Ok(Prepared { plan, certs, accept_invalid: net.accept_invalid_certs, connect_timeout: net.timeout() })
    }

    pub fn plan(&self) -> Option<&ProxyPlan> {
        self.plan.as_deref()
    }

    pub fn apply(&self, mut b: ClientBuilder) -> ClientBuilder {
        b = b.connect_timeout(self.connect_timeout);
        if !self.certs.is_empty() {
            b = b.tls_certs_merge(self.certs.clone());
        }
        if self.accept_invalid {
            b = b.tls_danger_accept_invalid_certs(true);
        }
        if let Some(plan) = &self.plan {
            b = b.no_proxy();
            if !matches!(plan.rules, Rules::Direct) {
                let plan = plan.clone();
                b = b.proxy(reqwest::Proxy::custom(move |url| plan.resolve(url)));
            }
        }
        b
    }

    pub fn client(&self) -> Result<reqwest::Client> {
        Ok(self.apply(reqwest::Client::builder()).build()?)
    }
}

/// The HTTP client for `purpose` (LiteLLM, the HTTP tool, tests).
pub fn http_client(net: &NetworkSettings, password: Option<&str>, purpose: Purpose) -> Result<reqwest::Client> {
    Prepared::new(net, password, purpose)?.client()
}

/// Fetches a PAC script (directly, without proxy; the extra CA applies).
pub async fn fetch_pac(net: &NetworkSettings, url: &str) -> Result<String> {
    if let Some(path) = url.strip_prefix("file://") {
        let path = path.strip_prefix('/').filter(|p| cfg!(windows) && p.chars().nth(1) == Some(':')).unwrap_or(path);
        let text = std::fs::read_to_string(path).map_err(|e| Error::State(format!("PAC-Datei {path}: {e}")))?;
        return Ok(text);
    }
    let direct = NetworkSettings { mode: ProxyMode::None, ..net.clone() };
    let client = Prepared::new(&direct, None, Purpose::Ai)?.client()?;
    let resp = client.get(url).timeout(net.timeout()).send().await?;
    if !resp.status().is_success() {
        return Err(Error::State(format!("PAC-Datei: HTTP {}", resp.status())));
    }
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_PAC_BYTES {
        return Err(Error::State("PAC-Datei ist zu groß".into()));
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
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

/// Git settings for `remote_url`: the proxy (via `http_proxy`/`https_proxy`/`no_proxy`), the
/// CA bundle (`http.sslCAInfo`, only when `ca_bundle` is given) and `http.sslVerify`.
/// SSH remotes and remotes without HTTP(S) get nothing. Empty when `apply_to.git` is off.
pub fn git_network(
    net: &NetworkSettings,
    password: Option<&str>,
    remote_url: &str,
    system: &SystemProxy,
    ca_bundle: Option<&str>,
) -> GitNetwork {
    let mut g = GitNetwork::default();
    let lower = remote_url.trim().to_ascii_lowercase();
    if !net.apply_to.git || !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return g;
    }
    let plan = ProxyPlan::new(net, password, system);
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
    if net.accept_invalid_certs {
        g.config.push(("http.sslVerify".into(), "false".into()));
    }
    g.secret = password.filter(|p| !p.is_empty()).map(str::to_owned);
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
            &NetworkSettings::default(),
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
        let net = NetworkSettings {
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
        let socks_only = NetworkSettings { http_proxy: String::new(), proxy_user: String::new(), ..net.clone() };
        let plan = ProxyPlan::new(&socks_only, None, &SystemProxy::default());
        assert_eq!(plan.resolve_str("https://x.de").unwrap().unwrap().as_str(), "socks5://s:1080");
        let none = NetworkSettings { mode: ProxyMode::None, ..net };
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
        let net = NetworkSettings {
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
        let dir = std::env::temp_dir().join(format!("annalo-ca-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (pem_path, der_path) = (dir.join("ca.pem"), dir.join("ca.der"));
        std::fs::write(&pem_path, &bundle).unwrap();
        std::fs::write(&der_path, &der).unwrap();
        for p in [&pem_path, &der_path] {
            let net = NetworkSettings { extra_ca_path: Some(p.display().to_string()), ..Default::default() };
            http_client(&net, None, Purpose::Ai).unwrap();
        }
        assert_eq!(ca_info_file(&pem_path.display().to_string()).unwrap().count, 2);
        let out = dir.join("bundle.pem");
        write_git_ca_bundle(&der_path.display().to_string(), &out).unwrap();
        assert_eq!(parse_certificates(&std::fs::read(&out).unwrap()).unwrap()[0], der);
        let missing =
            NetworkSettings { extra_ca_path: Some(dir.join("fehlt.pem").display().to_string()), ..Default::default() };
        assert!(http_client(&missing, None, Purpose::Ai).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_validation() {
        let manual = NetworkSettings { mode: ProxyMode::Manual, ..Default::default() };
        assert!(manual.normalized().is_err(), "manual needs an address");
        let ok = NetworkSettings { http_proxy: " proxy:8080 ".into(), ..manual }.normalized().unwrap();
        assert_eq!(ok.http_proxy, "http://proxy:8080");
        let pac = NetworkSettings { mode: ProxyMode::Pac, pac_url: "javascript:alert(1)".into(), ..Default::default() };
        assert!(pac.normalized().is_err());
        let t = NetworkSettings { timeout_secs: 0, extra_ca_path: Some("  ".into()), ..Default::default() }
            .normalized()
            .unwrap();
        assert_eq!((t.timeout_secs, t.extra_ca_path), (1, None));
    }

    #[test]
    fn git_environment() {
        let net = NetworkSettings {
            mode: ProxyMode::Manual,
            https_proxy: "proxy:8080".into(),
            no_proxy: "git.intra".into(),
            proxy_user: "max".into(),
            accept_invalid_certs: true,
            ..Default::default()
        };
        let sys = SystemProxy::default();
        let g = git_network(&net, Some("pw"), "https://github.com/a/b.git", &sys, Some("/tmp/ca.pem"));
        let get = |k: &str| g.env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        assert_eq!(get("https_proxy"), Some(Some("http://max:pw@proxy:8080/".into())));
        assert_eq!(get("ALL_PROXY"), Some(None));
        assert_eq!(get("no_proxy"), Some(None));
        assert!(g.config.contains(&("http.sslCAInfo".into(), "/tmp/ca.pem".into())));
        assert!(g.config.contains(&("http.sslVerify".into(), "false".into())));
        assert_eq!(g.secret.as_deref(), Some("pw"));
        // Exception: direct, and environment proxies are switched off.
        let g = git_network(&net, None, "https://git.intra/x.git", &sys, None);
        assert!(g.env.contains(&("NO_PROXY".into(), Some("*".into()))));
        assert!(g.env.contains(&("https_proxy".into(), None)));
        // SSH and apply_to.git = false: untouched.
        assert_eq!(git_network(&net, None, "git@github.com:a/b.git", &sys, None), GitNetwork::default());
        let off = NetworkSettings { apply_to: ApplyTo { git: false, ..Default::default() }, ..net };
        assert_eq!(git_network(&off, None, "https://github.com/a/b.git", &sys, None), GitNetwork::default());
    }
}
