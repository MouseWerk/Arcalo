//! The guided setup of the Git sync (Settings → Sicherung → „Einrichten“, the same steps on the
//! phone): the provider's REST API with the access token (whom it belongs to, the repositories to
//! pick from, a new private one) and the check before saving (server, token, read and write
//! rights, `git ls-remote`, branch, what the repository holds). Every failure is classified
//! ([`ProblemKind`]) so the UI can say in plain words what is wrong and how to fix it.
//!
//! Sign-in stays token-only. The token travels in a header, never in a URL or a log line; the
//! requests use the Git sync's client (`network::client_for` with `Service::GitSync`: its proxy
//! profile, certificates and timeouts). Pagination links from a server are only followed on the
//! server's own API address.

use std::time::Duration;

use reqwest::header::HeaderMap;
use reqwest::{Client, Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::Result;
use crate::gitsync;

/// The most repositories listed (pages of 100, or 50 on Gitea).
pub const MAX_REPOS: usize = 1000;
/// The largest answer read from a provider.
const MAX_BYTES: usize = 8 * 1024 * 1024;
/// The name proposed for a new repository.
pub const PROPOSED_NAME: &str = "arcalo-notizen";
/// The branch proposed for a repository that holds other files.
pub const OWN_BRANCH: &str = "arcalo";

// ------------------------------------------------------------------ provider

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Github,
    Gitlab,
    /// Gitea and Forgejo (Codeberg): the same API.
    Gitea,
    /// Bitbucket Cloud.
    Bitbucket,
    /// Any other Git server: no API, only `git ls-remote`.
    Other,
}

/// Where the provider lives: its web address (`https://github.com`, `https://git.firma.de/gitea`,
/// a path prefix is kept).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Server {
    pub provider: Provider,
    pub web: String,
}

impl Server {
    /// The web address as a URL without user, query or trailing slash; only http(s).
    pub fn web_url(&self) -> std::result::Result<Url, Problem> {
        let bad = || Problem::new(ProblemKind::BadAddress, None, self.web.trim());
        let mut u = Url::parse(self.web.trim()).map_err(|_| bad())?;
        if !matches!(u.scheme(), "http" | "https") || u.host_str().is_none_or(str::is_empty) {
            return Err(bad());
        }
        let _ = u.set_username("");
        let _ = u.set_password(None);
        u.set_query(None);
        u.set_fragment(None);
        let path = u.path().trim_end_matches('/').to_owned();
        u.set_path(&path);
        Ok(u)
    }

    fn host(&self) -> Option<String> {
        self.web_url().ok().and_then(|u| u.host_str().map(|h| h.trim_start_matches("www.").to_ascii_lowercase()))
    }

    /// The REST API's base address: `api.github.com` and `/api/v3` on GitHub Enterprise, `/api/v4`
    /// on GitLab, `/api/v1` on Gitea and Forgejo, `api.bitbucket.org/2.0` (another host: the same
    /// API below `/2.0`, e.g. a gateway). `Err` for another server, which has none.
    pub fn api_base(&self) -> std::result::Result<Url, Problem> {
        let web = self.web_url()?;
        let host = self.host().unwrap_or_default();
        let below = |suffix: &str| {
            let mut u = web.clone();
            u.set_path(&format!("{}/{suffix}", web.path().trim_end_matches('/')));
            u
        };
        let fixed = |s: &str| Url::parse(s).map_err(|_| Problem::new(ProblemKind::BadAddress, None, s));
        match self.provider {
            Provider::Github if host == "github.com" => fixed("https://api.github.com"),
            Provider::Github => Ok(below("api/v3")),
            Provider::Gitlab => Ok(below("api/v4")),
            Provider::Gitea => Ok(below("api/v1")),
            Provider::Bitbucket if host == "bitbucket.org" => fixed("https://api.bitbucket.org/2.0"),
            Provider::Bitbucket => Ok(below("2.0")),
            Provider::Other => Err(Problem::new(ProblemKind::NotApi, None, "")),
        }
    }
}

// ------------------------------------------------------------------ problems

/// What went wrong, for the UI's plain words and the fix (`gitsetup.problem.<kind>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProblemKind {
    /// No token entered and none stored.
    TokenMissing,
    /// The server does not accept the token (wrong, revoked, not copied completely).
    TokenInvalid,
    TokenExpired,
    /// The token lacks a scope or permission (GitHub `repo`, GitLab `write_repository`, …).
    TokenScope,
    /// The account may only read the repository.
    NoWrite,
    /// No such repository, or the token has no access to it.
    NotFound,
    /// A repository of that name exists already.
    Exists,
    /// A name a repository cannot have.
    BadName,
    /// An address that is no http(s) web address.
    BadAddress,
    RateLimited,
    Proxy,
    Certificate,
    Unreachable,
    Timeout,
    /// An SSH address: the sync signs in with a token over HTTPS.
    Ssh,
    GitMissing,
    /// The address answers, but not as this provider's API (another provider, a login page).
    NotApi,
    /// The server reports an error of its own (5xx).
    Server,
    Other,
}

/// A failure with its kind, the HTTP status and the technical detail (redacted, shortened).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Problem {
    pub kind: ProblemKind,
    pub status: Option<u16>,
    pub detail: String,
}

impl Problem {
    pub fn new(kind: ProblemKind, status: Option<u16>, detail: impl Into<String>) -> Problem {
        let mut detail: String = detail.into();
        if detail.chars().count() > 300 {
            detail = detail.chars().take(300).collect::<String>() + "…";
        }
        Problem { kind, status, detail }
    }

    /// Without `secret` in the detail.
    fn redacted(mut self, secret: &str) -> Problem {
        self.detail = gitsync::redact(&self.detail, Some(secret));
        self
    }
}

/// The kind of a failure described by a text: a git error (also its translated wrappers), a
/// connection error. Checked in this order, because the texts nest (a proxy's 407 is also an
/// authentication, a certificate error also says „unable to access“).
pub fn classify_text(text: &str) -> ProblemKind {
    let t = without_urls(&text.to_lowercase());
    // A status code counts as a number of its own, never as part of a longer one.
    let any = |ps: &[&str]| {
        ps.iter().any(|p| {
            if !p.bytes().all(|b| b.is_ascii_digit()) {
                return t.contains(p);
            }
            t.match_indices(p).any(|(i, _)| {
                let before = t[..i].bytes().next_back();
                let after = t[i + p.len()..].bytes().next();
                !before.is_some_and(|b| b.is_ascii_digit()) && !after.is_some_and(|b| b.is_ascii_digit())
            })
        })
    };
    if any(&[
        "kein ssh",
        "no ssh",
        "publickey",
        "host key verification",
        "unsupported url protocol",
        "ssh: could not resolve",
    ]) {
        ProblemKind::Ssh
    } else if any(&["git ist nicht installiert", "git is not installed"]) {
        ProblemKind::GitMissing
    } else if any(&["407", "proxy", "tunnel"]) {
        ProblemKind::Proxy
    } else if crate::network::is_certificate_error(&t) || any(&["ssl peer", "tls handshake"]) {
        ProblemKind::Certificate
    } else if any(&["timed out", "timeout", "did not answer within", "nicht innerhalb von"]) {
        ProblemKind::Timeout
    } else if any(&["expired", "abgelaufen"]) {
        ProblemKind::TokenExpired
    } else if any(&["403", "write access to repository not granted", "permission to ", "insufficient_scope"]) {
        ProblemKind::TokenScope
    } else if any(&[
        "401",
        "authentication failed",
        "could not read username",
        "could not read password",
        "invalid username or password",
        "terminal prompts disabled",
        "bad credentials",
        "invalid credentials",
        "anmeldung am git-server fehlgeschlagen",
        "sign-in to the git server failed",
    ]) {
        ProblemKind::TokenInvalid
    } else if any(&["not found", "404", "does not appear to be a git repository", "does not exist"]) {
        ProblemKind::NotFound
    } else if any(&[
        "could not resolve",
        "couldn't connect",
        "could not connect",
        "failed to connect",
        "connection refused",
        "network is unreachable",
        "no route to host",
        "dns error",
        "failed to lookup",
        "error sending request",
        "unable to access",
        "nicht erreichbar",
        "not reachable",
    ]) {
        ProblemKind::Unreachable
    } else {
        ProblemKind::Other
    }
}

/// The text without the addresses in it: a port or a path (`http://127.0.0.1:40325`,
/// `/repos/404-notes`) is not a status code or an error.
fn without_urls(t: &str) -> String {
    t.split(' ')
        .map(|w| {
            let bare = w.trim_start_matches(['\'', '"', '(', '<', '`']);
            if ["http://", "https://", "ssh://", "git://", "file://"].iter().any(|s| bare.starts_with(s)) {
                "<url>"
            } else {
                w
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A request that got no answer.
pub fn classify_transport(e: &reqwest::Error) -> Problem {
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(s) = source {
        let next = s.to_string();
        if !text.contains(&next) {
            text.push_str(&format!(": {next}"));
        }
        source = s.source();
    }
    let kind = if e.is_timeout() {
        ProblemKind::Timeout
    } else {
        match classify_text(&text) {
            k @ (ProblemKind::Proxy | ProblemKind::Certificate | ProblemKind::Timeout) => k,
            _ => ProblemKind::Unreachable,
        }
    };
    Problem::new(kind, None, text)
}

/// An answer with an error status: what it means on `provider`.
pub fn classify_status(provider: Provider, status: u16, headers: &HeaderMap, body: &str) -> Problem {
    let lower = body.to_lowercase();
    let header = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or_default();
    let detail = message_of(body);
    let kind = match status {
        401 if lower.contains("expired") => ProblemKind::TokenExpired,
        401 => ProblemKind::TokenInvalid,
        403 | 429 if header("x-ratelimit-remaining") == "0" || lower.contains("rate limit") => ProblemKind::RateLimited,
        429 => ProblemKind::RateLimited,
        403 if provider == Provider::Github && !header("x-github-sso").is_empty() => ProblemKind::TokenScope,
        403 if lower.contains("expired") => ProblemKind::TokenExpired,
        403 => ProblemKind::TokenScope,
        404 | 410 => ProblemKind::NotFound,
        407 => ProblemKind::Proxy,
        409 => ProblemKind::Exists,
        400 | 422
            if ["already exists", "already been taken", "name already", "is taken"]
                .iter()
                .any(|p| lower.contains(p)) =>
        {
            ProblemKind::Exists
        }
        500..=599 => ProblemKind::Server,
        _ => ProblemKind::Other,
    };
    let detail = if detail.is_empty() { format!("HTTP {status}") } else { format!("HTTP {status}: {detail}") };
    Problem::new(kind, Some(status), detail)
}

/// The server's own message of an error answer (`message`, `error_description`, `error.message`).
fn message_of(body: &str) -> String {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        let text = body.trim();
        // A web page (a proxy's or a login page) says nothing useful in its markup.
        return if text.starts_with('<') { String::new() } else { text.chars().take(200).collect() };
    };
    let pick = |v: &Value| v.as_str().map(str::to_owned).or_else(|| v.as_array().map(|a| format!("{a:?}")));
    ["error_description", "message", "error"]
        .iter()
        .find_map(|k| match v.get(k) {
            Some(Value::Object(o)) => o.get("message").and_then(pick),
            Some(x) => pick(x),
            None => None,
        })
        .unwrap_or_default()
}

// ------------------------------------------------------------------ requests

/// The REST API of one provider with one token.
pub struct Api<'a> {
    client: &'a Client,
    provider: Provider,
    base: Url,
    token: String,
    timeout: Duration,
}

/// An answer: status, headers, body.
struct Answer {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

impl<'a> Api<'a> {
    /// `timeout` is the total time of one request.
    pub fn new(
        client: &'a Client,
        server: &Server,
        token: &str,
        timeout: Duration,
    ) -> std::result::Result<Api<'a>, Problem> {
        let token = token.trim();
        if token.is_empty() {
            return Err(Problem::new(ProblemKind::TokenMissing, None, ""));
        }
        Ok(Api { client, provider: server.provider, base: server.api_base()?, token: token.to_owned(), timeout })
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// `<base>/<segments…>?<query>`; each segment is encoded (a GitLab project path becomes one).
    fn url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        let mut u = self.base.clone();
        if let Ok(mut p) = u.path_segments_mut() {
            p.pop_if_empty();
            for s in segments {
                p.push(s);
            }
        }
        if !query.is_empty() {
            u.query_pairs_mut().extend_pairs(query);
        }
        u
    }

    /// A link the server sent (pagination) only when it points to its own API.
    fn own_link(&self, link: &str) -> Option<Url> {
        let u = Url::parse(link).ok()?;
        let same = u.scheme() == self.base.scheme()
            && u.host_str() == self.base.host_str()
            && u.port_or_known_default() == self.base.port_or_known_default()
            && u.path().starts_with(self.base.path().trim_end_matches('/'));
        same.then_some(u)
    }

    async fn send(&self, method: Method, url: Url, body: Option<Value>) -> std::result::Result<Answer, Problem> {
        let mut req = self
            .client
            .request(method, url)
            .timeout(self.timeout)
            .header("User-Agent", concat!("Arcalo/", env!("CARGO_PKG_VERSION")));
        req = match self.provider {
            Provider::Github => req
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .bearer_auth(&self.token),
            Provider::Gitea => {
                req.header("Accept", "application/json").header("Authorization", format!("token {}", self.token))
            }
            _ => req.header("Accept", "application/json").bearer_auth(&self.token),
        };
        if let Some(b) = body {
            req = req.json(&b);
        }
        let res = req.send().await.map_err(|e| classify_transport(&e).redacted(&self.token))?;
        let status = res.status();
        let headers = res.headers().clone();
        if res.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
            return Err(Problem::new(ProblemKind::Other, Some(status.as_u16()), "answer too large"));
        }
        let bytes = res.bytes().await.map_err(|e| classify_transport(&e).redacted(&self.token))?;
        if bytes.len() > MAX_BYTES {
            return Err(Problem::new(ProblemKind::Other, Some(status.as_u16()), "answer too large"));
        }
        Ok(Answer { status, headers, body: String::from_utf8_lossy(&bytes).into_owned() })
    }

    /// A successful answer, else its problem.
    async fn ok(&self, method: Method, url: Url, body: Option<Value>) -> std::result::Result<Answer, Problem> {
        let a = self.send(method, url, body).await?;
        if a.status.is_success() {
            Ok(a)
        } else {
            Err(classify_status(self.provider, a.status.as_u16(), &a.headers, &a.body).redacted(&self.token))
        }
    }

    /// A successful JSON answer; anything else (a login page, another server) is [`ProblemKind::NotApi`].
    async fn json(
        &self,
        method: Method,
        url: Url,
        body: Option<Value>,
    ) -> std::result::Result<(Value, HeaderMap), Problem> {
        let a = self.ok(method, url, body).await?;
        let v = serde_json::from_str::<Value>(&a.body).map_err(|_| {
            let start: String = a.body.trim().chars().take(80).collect();
            Problem::new(ProblemKind::NotApi, Some(a.status.as_u16()), start)
        })?;
        Ok((v, a.headers))
    }

    async fn get(&self, segments: &[&str], query: &[(&str, &str)]) -> std::result::Result<(Value, HeaderMap), Problem> {
        self.json(Method::GET, self.url(segments, query), None).await
    }
}

// ------------------------------------------------------------------ account

/// Whom the token belongs to.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Account {
    pub login: String,
    pub name: Option<String>,
    /// When the token expires (as the server says it), if it does.
    pub expires: Option<String>,
    /// The token's scopes when the server names them (GitHub classic tokens, GitLab).
    pub scopes: Option<Vec<String>>,
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn scopes_header(headers: &HeaderMap) -> Option<Vec<String>> {
    let raw = headers.get("x-oauth-scopes")?.to_str().ok()?;
    Some(raw.split(',').map(|s| s.trim().to_owned()).filter(|s| !s.is_empty()).collect())
}

/// Whom the token belongs to; `None` on Bitbucket when its access token stands for no user (the
/// check proves it on the repository).
pub async fn account(api: &Api<'_>) -> std::result::Result<Option<Account>, Problem> {
    match api.provider {
        Provider::Github => {
            let (v, h) = api.get(&["user"], &[]).await?;
            Ok(Some(Account {
                login: text(&v, "login").unwrap_or_default(),
                name: text(&v, "name"),
                expires: h
                    .get("github-authentication-token-expiration")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_owned),
                scopes: scopes_header(&h),
            }))
        }
        Provider::Gitlab => {
            let (v, _) = api.get(&["user"], &[]).await?;
            let mut a = Account {
                login: text(&v, "username").unwrap_or_default(),
                name: text(&v, "name"),
                ..Default::default()
            };
            // Older servers and other token kinds do not know `self`: then the scopes stay unknown.
            if let Ok((t, _)) = api.get(&["personal_access_tokens", "self"], &[]).await {
                a.expires = text(&t, "expires_at");
                a.scopes = t
                    .get("scopes")
                    .and_then(Value::as_array)
                    .map(|s| s.iter().filter_map(Value::as_str).map(str::to_owned).collect());
            }
            Ok(Some(a))
        }
        Provider::Gitea => {
            let (v, _) = api.get(&["user"], &[]).await?;
            Ok(Some(Account {
                login: text(&v, "login").unwrap_or_default(),
                name: text(&v, "full_name"),
                ..Default::default()
            }))
        }
        Provider::Bitbucket => match api.get(&["user"], &[]).await {
            Ok((v, _)) => Ok(Some(Account {
                login: text(&v, "username").or_else(|| text(&v, "nickname")).unwrap_or_default(),
                name: text(&v, "display_name"),
                ..Default::default()
            })),
            // An access token of a repository or workspace stands for no user: the repository
            // itself proves it (a wrong token fails there as well).
            Err(p) if matches!(p.status, Some(401 | 403)) => Ok(None),
            Err(p) => Err(p),
        },
        Provider::Other => Ok(None),
    }
}

// ------------------------------------------------------------------ repositories

/// A repository to pick.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Repo {
    /// User, organization, group (GitLab: the full path of the group) or workspace.
    pub owner: String,
    pub name: String,
    pub full_name: String,
    pub private: bool,
    /// The HTTPS address git uses (without a user name).
    pub clone_url: String,
    pub web_url: String,
    pub default_branch: Option<String>,
    /// The server says it is empty (no commit yet).
    pub empty: Option<bool>,
    /// The account may push to it.
    pub can_push: Option<bool>,
    pub updated: Option<String>,
    pub description: Option<String>,
}

/// `https://user@bitbucket.org/x.git` → `https://bitbucket.org/x.git`.
fn without_user(url: &str) -> String {
    match Url::parse(url) {
        Ok(mut u) => {
            let _ = u.set_username("");
            let _ = u.set_password(None);
            u.to_string()
        }
        Err(_) => url.to_owned(),
    }
}

fn repo_of(provider: Provider, v: &Value) -> Repo {
    let s = |k: &str| text(v, k);
    match provider {
        Provider::Github | Provider::Gitea => {
            let owner = v.get("owner").and_then(|o| text(o, "login")).unwrap_or_default();
            let name = s("name").unwrap_or_default();
            Repo {
                full_name: s("full_name").unwrap_or_else(|| format!("{owner}/{name}")),
                owner,
                name,
                private: v.get("private").and_then(Value::as_bool).unwrap_or(false),
                clone_url: s("clone_url").map(|u| without_user(&u)).unwrap_or_default(),
                web_url: s("html_url").unwrap_or_default(),
                default_branch: s("default_branch"),
                // GitHub says nothing about emptiness (its `size` lags); Gitea does.
                empty: v.get("empty").and_then(Value::as_bool),
                can_push: v.get("permissions").and_then(|p| p.get("push")).and_then(Value::as_bool),
                updated: s("pushed_at").or_else(|| s("updated_at")),
                description: s("description"),
            }
        }
        Provider::Gitlab => {
            let full = s("path_with_namespace").unwrap_or_default();
            let (owner, name) = full.rsplit_once('/').map(|(o, n)| (o.to_owned(), n.to_owned())).unwrap_or_default();
            let level = |k: &str| {
                v.get("permissions").and_then(|p| p.get(k)).and_then(|a| a.get("access_level")).and_then(Value::as_u64)
            };
            let access = level("project_access").max(level("group_access"));
            Repo {
                owner,
                name,
                full_name: full,
                private: s("visibility").is_none_or(|v| v != "public"),
                clone_url: s("http_url_to_repo").unwrap_or_default(),
                web_url: s("web_url").unwrap_or_default(),
                default_branch: s("default_branch"),
                empty: v.get("empty_repo").and_then(Value::as_bool),
                // Developer (30) and above may push.
                can_push: v.get("permissions").map(|_| access.is_some_and(|a| a >= 30)),
                updated: s("last_activity_at"),
                description: s("description"),
            }
        }
        Provider::Bitbucket => {
            let full = s("full_name").unwrap_or_default();
            let owner = v
                .get("workspace")
                .and_then(|w| text(w, "slug"))
                .or_else(|| full.split_once('/').map(|(o, _)| o.to_owned()))
                .unwrap_or_default();
            let name = s("slug").or_else(|| full.split_once('/').map(|(_, n)| n.to_owned())).unwrap_or_default();
            let clone = v
                .get("links")
                .and_then(|l| l.get("clone"))
                .and_then(Value::as_array)
                .and_then(|a| a.iter().find(|c| text(c, "name").as_deref() == Some("https")))
                .and_then(|c| text(c, "href"))
                .map(|u| without_user(&u))
                .unwrap_or_default();
            Repo {
                full_name: if full.is_empty() { format!("{owner}/{name}") } else { full },
                owner,
                name,
                private: v.get("is_private").and_then(Value::as_bool).unwrap_or(true),
                clone_url: clone,
                web_url: v.get("links").and_then(|l| l.get("html")).and_then(|h| text(h, "href")).unwrap_or_default(),
                default_branch: v.get("mainbranch").and_then(|m| text(m, "name")),
                empty: None,
                can_push: None,
                updated: s("updated_on"),
                description: s("description"),
            }
        }
        Provider::Other => Repo::default(),
    }
}

/// The repositories the token's account belongs to (owner, collaborator, member), newest first,
/// at most [`MAX_REPOS`].
pub async fn list_repos(api: &Api<'_>) -> std::result::Result<Vec<Repo>, Problem> {
    let mut out: Vec<Repo> = vec![];
    let push_page = |out: &mut Vec<Repo>, items: &Value| -> usize {
        let list = items.as_array().cloned().unwrap_or_default();
        for item in &list {
            let r = repo_of(api.provider, item);
            if !r.name.is_empty() && !out.iter().any(|x| x.full_name == r.full_name) {
                out.push(r);
            }
        }
        list.len()
    };
    match api.provider {
        Provider::Github | Provider::Gitea => {
            let per = if api.provider == Provider::Gitea { 50 } else { 100 };
            let per_s = per.to_string();
            for page in 1..=(MAX_REPOS / per) {
                let page_s = page.to_string();
                let query: Vec<(&str, &str)> = if api.provider == Provider::Github {
                    vec![("per_page", &per_s), ("page", &page_s), ("sort", "pushed")]
                } else {
                    vec![("limit", &per_s), ("page", &page_s)]
                };
                let (v, _) = api.get(&["user", "repos"], &query).await?;
                if push_page(&mut out, &v) < per {
                    break;
                }
            }
        }
        Provider::Gitlab => {
            let mut page = "1".to_owned();
            for _ in 0..(MAX_REPOS / 100) {
                let query = [
                    ("membership", "true"),
                    ("per_page", "100"),
                    ("page", page.as_str()),
                    ("order_by", "last_activity_at"),
                    ("archived", "false"),
                ];
                let (v, h) = api.get(&["projects"], &query).await?;
                let n = push_page(&mut out, &v);
                let next = h.get("x-next-page").and_then(|v| v.to_str().ok()).map(str::trim).unwrap_or_default();
                if n == 0 || next.is_empty() {
                    break;
                }
                page = next.to_owned();
            }
        }
        Provider::Bitbucket => {
            let mut url =
                api.url(&["repositories"], &[("role", "member"), ("pagelen", "100"), ("sort", "-updated_on")]);
            for _ in 0..(MAX_REPOS / 100) {
                let (v, _) = api.json(Method::GET, url, None).await?;
                push_page(&mut out, v.get("values").unwrap_or(&Value::Null));
                match v.get("next").and_then(Value::as_str).and_then(|n| api.own_link(n)) {
                    Some(next) => url = next,
                    None => break,
                }
            }
        }
        Provider::Other => {}
    }
    out.truncate(MAX_REPOS);
    Ok(out)
}

/// A name a new repository can have on every provider: letters, digits, `.`, `-`, `_`, not
/// starting with a dot or a dash, at most 100 characters.
pub fn valid_repo_name(name: &str) -> bool {
    let n = name.trim();
    !n.is_empty()
        && n.len() <= 100
        && !n.starts_with(['.', '-'])
        && !n.ends_with(".git")
        && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Creates a new private, empty repository `name` in the token's account.
pub async fn create_repo(api: &Api<'_>, name: &str) -> std::result::Result<Repo, Problem> {
    let name = name.trim();
    if !valid_repo_name(name) {
        return Err(Problem::new(ProblemKind::BadName, None, name));
    }
    let description = "Arcalo";
    let (v, _) = match api.provider {
        Provider::Github => {
            let body = json!({ "name": name, "private": true, "auto_init": false, "description": description });
            api.json(Method::POST, api.url(&["user", "repos"], &[]), Some(body)).await?
        }
        Provider::Gitea => {
            let body = json!({ "name": name, "private": true, "auto_init": false, "description": description });
            api.json(Method::POST, api.url(&["user", "repos"], &[]), Some(body)).await?
        }
        Provider::Gitlab => {
            let body = json!({ "name": name, "path": name, "visibility": "private", "initialize_with_readme": false, "description": description });
            api.json(Method::POST, api.url(&["projects"], &[]), Some(body)).await?
        }
        Provider::Bitbucket => {
            // The sync signs in to Bitbucket with an access token of a repository, project or
            // workspace: it stands for no user and cannot create a repository (the setup does
            // not offer it there; the repository is created in Bitbucket).
            return Err(Problem::new(
                ProblemKind::TokenScope,
                None,
                "Bitbucket access tokens cannot create repositories",
            ));
        }
        Provider::Other => return Err(Problem::new(ProblemKind::NotApi, None, "")),
    };
    let mut repo = repo_of(api.provider, &v);
    // Just created, nothing in it yet.
    repo.empty = Some(true);
    Ok(repo)
}

/// A repository with what the token may do there.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Access {
    pub repo: Repo,
    /// May push: `None` when the server does not say (Bitbucket, a fine-grained GitHub token's own
    /// permission).
    pub write: Option<bool>,
    /// Why not: [`ProblemKind::NoWrite`] (the account) or [`ProblemKind::TokenScope`] (the token).
    pub write_problem: Option<Problem>,
}

/// The repository `owner/name` as the token sees it, with its read and write rights.
pub async fn repo_access(
    api: &Api<'_>,
    owner: &str,
    name: &str,
    account: Option<&Account>,
) -> std::result::Result<Access, Problem> {
    let (v, headers) = match api.provider {
        Provider::Github | Provider::Gitea => api.get(&["repos", owner, name], &[]).await?,
        Provider::Gitlab => api.get(&["projects", &format!("{owner}/{name}")], &[]).await?,
        Provider::Bitbucket => api.get(&["repositories", owner, &name.to_ascii_lowercase()], &[]).await?,
        Provider::Other => return Err(Problem::new(ProblemKind::NotApi, None, "")),
    };
    let repo = repo_of(api.provider, &v);
    let no_write = |what: &str| Some(Problem::new(ProblemKind::NoWrite, None, what));
    let scope = |what: &str| Some(Problem::new(ProblemKind::TokenScope, None, what));
    let (write, write_problem) = match api.provider {
        Provider::Github => {
            // A classic token names its scopes; a fine-grained one does not (its own permission
            // for the contents cannot be read: the first upload proves it).
            let scopes = scopes_header(&headers).or_else(|| account.and_then(|a| a.scopes.clone()));
            let scoped = scopes.as_ref().is_none_or(|s| {
                s.iter().any(|x| x == "repo") || (!repo.private && s.iter().any(|x| x == "public_repo"))
            });
            match (repo.can_push, scoped) {
                (Some(false), _) => (Some(false), no_write("permissions.push = false")),
                (_, false) => (Some(false), scope("scope repo missing")),
                (Some(true), true) => (Some(true), None),
                (None, true) => (None, None),
            }
        }
        Provider::Gitlab => {
            let scopes = account.and_then(|a| a.scopes.clone());
            let scoped = scopes.as_ref().is_none_or(|s| s.iter().any(|x| x == "write_repository" || x == "api"));
            match (repo.can_push, scoped) {
                (Some(false), _) => (Some(false), no_write("access level below Developer")),
                (_, false) => (Some(false), scope("scope write_repository missing")),
                (w, true) => (w, None),
            }
        }
        Provider::Gitea => match repo.can_push {
            Some(false) => (Some(false), no_write("permissions.push = false")),
            w => (w, None),
        },
        _ => (None, None),
    };
    Ok(Access { repo, write, write_problem })
}

/// Whether the repository's `.gitattributes` on `branch` is the sync's: `Some(true)` (notes of
/// Arcalo), `Some(false)` (none, or another one), `None` (the server did not say).
pub async fn holds_sync(api: &Api<'_>, owner: &str, name: &str, branch: &str) -> Option<bool> {
    let file = gitsync::ATTRIBUTES_FILE;
    let res = match api.provider {
        Provider::Github => {
            api.get(&["repos", owner, name, "contents", file], &[("ref", branch)]).await.map(|(v, _)| {
                let b64: String =
                    text(&v, "content").unwrap_or_default().chars().filter(|c| !c.is_whitespace()).collect();
                use base64::Engine;
                let raw = base64::engine::general_purpose::STANDARD.decode(b64).unwrap_or_default();
                String::from_utf8_lossy(&raw).into_owned()
            })
        }
        Provider::Gitlab => {
            let url = api
                .url(&["projects", &format!("{owner}/{name}"), "repository", "files", file, "raw"], &[("ref", branch)]);
            api.ok(Method::GET, url, None).await.map(|a| a.body)
        }
        Provider::Gitea => {
            let url = api.url(&["repos", owner, name, "raw", file], &[("ref", branch)]);
            api.ok(Method::GET, url, None).await.map(|a| a.body)
        }
        Provider::Bitbucket => {
            let url = api.url(&["repositories", owner, &name.to_ascii_lowercase(), "src", branch, file], &[]);
            api.ok(Method::GET, url, None).await.map(|a| a.body)
        }
        Provider::Other => return None,
    };
    match res {
        Ok(text) => Some(gitsync::is_sync_attributes(&text)),
        Err(p) if p.kind == ProblemKind::NotFound => Some(false),
        Err(_) => None,
    }
}

// ------------------------------------------------------------------ check

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepId {
    /// The provider's API answers.
    Server,
    /// It accepts the token.
    Token,
    /// The repository exists and the token sees it.
    Repository,
    /// The token may push.
    Write,
    /// `git ls-remote` with the token, as the sync will run it.
    Git,
    /// The branch to sync and what the repository holds.
    Branch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StepState {
    Ok,
    /// Could not be checked here (the first upload proves it).
    Unknown,
    Fail,
    /// Not reached (an earlier step failed) or not applicable.
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Step {
    pub id: StepId,
    pub state: StepState,
}

/// What the repository holds before the first sync.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Content {
    /// No branch yet: the first sync uploads the notes.
    Empty,
    /// Notes of Arcalo (another computer, the phone): adopted and merged, nothing overwritten.
    Arcalo,
    /// Other files: left as they are; the notes go to a branch of their own.
    Other,
    /// Not empty, and the server cannot tell what it holds (another server).
    Unknown,
}

/// The repository to check: the address git uses, and on a provider its owner and name.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Target {
    pub url: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

/// The check before saving.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Check {
    pub steps: Vec<Step>,
    /// The first failure.
    pub problem: Option<Problem>,
    pub account: Option<Account>,
    /// The branch to sync (`None` when the check failed before).
    pub branch: Option<String>,
    pub default_branch: Option<String>,
    pub branches: Vec<String>,
    pub content: Option<Content>,
    pub write: Option<bool>,
}

impl Check {
    fn new(api: bool) -> Check {
        // Without an API, git proves server, token and repository in one.
        let ids: &[StepId] = if api {
            &[StepId::Server, StepId::Token, StepId::Repository, StepId::Write, StepId::Git, StepId::Branch]
        } else {
            &[StepId::Git, StepId::Write, StepId::Branch]
        };
        Check {
            steps: ids.iter().map(|&id| Step { id, state: StepState::Skipped }).collect(),
            problem: None,
            account: None,
            branch: None,
            default_branch: None,
            branches: vec![],
            content: None,
            write: None,
        }
    }

    /// A check that stops at `id` before anything was asked (no token, no client).
    pub fn failed(id: StepId, problem: Problem) -> Check {
        Check::new(true).fail(id, problem)
    }

    fn set(&mut self, id: StepId, state: StepState) {
        if let Some(s) = self.steps.iter_mut().find(|s| s.id == id) {
            s.state = state;
        }
    }

    fn fail(mut self, id: StepId, problem: Problem) -> Check {
        self.set(id, StepState::Fail);
        self.problem = Some(problem);
        self
    }
}

/// The branch to sync: the server's default when the repository has it (or is empty), else
/// `main`, `master` or the first one.
fn pick_branch(default: Option<&str>, branches: &[String]) -> String {
    if let Some(d) = default.filter(|d| branches.is_empty() || branches.iter().any(|b| b == d)) {
        return d.to_owned();
    }
    ["main", "master"]
        .iter()
        .find(|b| branches.iter().any(|x| x == *b))
        .map(|b| (*b).to_owned())
        .or_else(|| branches.first().cloned())
        .unwrap_or_else(|| "main".into())
}

/// Checks `target` before it is saved: with `api` (a provider) the server, the token, the
/// repository and the rights; then `ls_remote` (`git ls-remote` with the token, as the sync runs
/// it, off the async threads); then the branch and what the repository holds. Stops at the first
/// failure. `token` is redacted from every detail.
pub async fn check<F>(api: Option<&Api<'_>>, target: &Target, token: Option<&str>, ls_remote: F) -> Check
where
    F: FnOnce() -> Result<Vec<String>> + Send + 'static,
{
    check_saved(api, target, None, token, ls_remote).await
}

/// [`check`] of the repository that is set up already (the setup opened again): `saved` is the
/// branch the sync uses now. It stays when it still exists and holds the notes (on another
/// server, where nothing can be read, when it exists), so every computer keeps syncing the same
/// branch.
pub async fn check_saved<F>(
    api: Option<&Api<'_>>,
    target: &Target,
    saved: Option<&str>,
    token: Option<&str>,
    ls_remote: F,
) -> Check
where
    F: FnOnce() -> Result<Vec<String>> + Send + 'static,
{
    let mut c = Check::new(api.is_some());
    let url = target.url.trim();
    if gitsync::needs_ssh(url) {
        return c.fail(StepId::Git, Problem::new(ProblemKind::Ssh, None, url));
    }
    let mut access: Option<Access> = None;
    if let Some(api) = api {
        let (owner, name) = match (target.owner.as_deref(), target.name.as_deref()) {
            (Some(o), Some(n)) if !o.is_empty() && !n.is_empty() => (o, n),
            _ => return c.fail(StepId::Repository, Problem::new(ProblemKind::NotFound, None, url)),
        };
        match account(api).await {
            Ok(a) => {
                c.set(StepId::Server, StepState::Ok);
                c.set(StepId::Token, if a.is_some() { StepState::Ok } else { StepState::Unknown });
                c.account = a;
            }
            Err(p) => {
                let at_server = matches!(
                    p.kind,
                    ProblemKind::Unreachable
                        | ProblemKind::Timeout
                        | ProblemKind::Proxy
                        | ProblemKind::Certificate
                        | ProblemKind::NotApi
                        | ProblemKind::Server
                        | ProblemKind::BadAddress
                );
                if at_server {
                    return c.fail(StepId::Server, p);
                }
                c.set(StepId::Server, StepState::Ok);
                return c.fail(StepId::Token, p);
            }
        }
        match repo_access(api, owner, name, c.account.as_ref()).await {
            Ok(a) => {
                c.set(StepId::Repository, StepState::Ok);
                // A Bitbucket access token without a user: it works when it sees the repository.
                c.set(StepId::Token, StepState::Ok);
                c.write = a.write;
                if let Some(p) = a.write_problem.clone() {
                    return c.fail(StepId::Write, p);
                }
                c.set(StepId::Write, if a.write == Some(true) { StepState::Ok } else { StepState::Unknown });
                access = Some(a);
            }
            Err(p)
                if c.account.is_none() && matches!(p.kind, ProblemKind::TokenInvalid | ProblemKind::TokenExpired) =>
            {
                return c.fail(StepId::Token, p);
            }
            Err(p) => return c.fail(StepId::Repository, p),
        }
    } else {
        // Another server: git proves the rest; write rights only the first upload.
        c.set(StepId::Write, StepState::Unknown);
    }
    let listed = tokio::task::spawn_blocking(ls_remote).await;
    let branches = match listed {
        Ok(Ok(b)) => b,
        Ok(Err(e)) => {
            let text = gitsync::redact(&e.to_string(), token);
            return c.fail(StepId::Git, Problem::new(classify_text(&text), None, text));
        }
        Err(e) => return c.fail(StepId::Git, Problem::new(ProblemKind::Other, None, e.to_string())),
    };
    c.set(StepId::Git, StepState::Ok);
    let default = access.as_ref().and_then(|a| a.repo.default_branch.clone());
    let (branch, content) = branch_to_sync(api.zip(access.as_ref()), default.as_deref(), saved, &branches).await;
    c.set(StepId::Branch, StepState::Ok);
    c.default_branch = default.or_else(|| (!branches.is_empty()).then(|| pick_branch(None, &branches)));
    c.branch = Some(branch);
    c.branches = branches;
    c.content = Some(content);
    c
}

/// The branch to sync and what the repository holds. The notes are where a `.gitattributes` of
/// the sync is, looked for in this order: the saved branch, the default one, the sync's own
/// branch ([`OWN_BRANCH`], made by an earlier setup next to other files). Without notes: the
/// default branch is taken when the server cannot tell; with other files on it the notes go to a
/// branch of their own when there is none of that name yet (else the sync keeps them on its
/// fallback branch). Nothing is overwritten either way.
async fn branch_to_sync(
    provider: Option<(&Api<'_>, &Access)>,
    default: Option<&str>,
    saved: Option<&str>,
    branches: &[String],
) -> (String, Content) {
    let first = pick_branch(default, branches);
    if branches.is_empty() {
        return (first, Content::Empty);
    }
    let exists = |b: &str| branches.iter().any(|x| x == b);
    let saved = saved.map(str::trim).filter(|b| !b.is_empty() && exists(b));
    let Some((api, access)) = provider else {
        // Another server says nothing about the content: the saved branch stays while it exists.
        return (saved.unwrap_or(&first).to_owned(), Content::Unknown);
    };
    let mut candidates: Vec<&str> = vec![];
    for b in [saved, Some(first.as_str()), Some(OWN_BRANCH).filter(|b| exists(b))].into_iter().flatten() {
        if !candidates.contains(&b) {
            candidates.push(b);
        }
    }
    let mut on_first = None;
    for b in candidates {
        let holds = holds_sync(api, &access.repo.owner, &access.repo.name, b).await;
        if holds == Some(true) {
            return (b.to_owned(), Content::Arcalo);
        }
        if b == first {
            on_first = holds;
        }
    }
    match on_first {
        Some(false) if !exists(OWN_BRANCH) => (OWN_BRANCH.to_owned(), Content::Other),
        Some(false) => (first, Content::Other),
        _ => (first, Content::Unknown),
    }
}

/// Host and port of an http(s) address (`None` for anything else), `www.` ignored.
fn host_port(url: &str) -> Option<(String, u16)> {
    let u = Url::parse(url.trim()).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?.trim_start_matches("www.").to_ascii_lowercase();
    (!host.is_empty()).then(|| (host, u.port_or_known_default().unwrap_or(0)))
}

/// Whether two http(s) addresses are on the same server (host and port): the stored token only
/// goes to the server of the saved repository.
pub fn same_host(a: &str, b: &str) -> bool {
    matches!((host_port(a), host_port(b)), (Some(x), Some(y)) if x == y)
}

/// Whether two addresses name the same repository: the same server and path, with or without
/// `.git`, a trailing slash or a user name.
pub fn same_repository(a: &str, b: &str) -> bool {
    let path = |u: &str| {
        Url::parse(u.trim()).ok().map(|u| u.path().trim_end_matches('/').trim_end_matches(".git").to_ascii_lowercase())
    };
    same_host(a, b) && path(a).is_some_and(|p| Some(p) == path(b))
}

#[cfg(test)]
#[path = "gitsetup_tests.rs"]
mod tests;
