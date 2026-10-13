//! Tests of the guided setup against fake provider servers (GitHub, GitLab, Gitea and Bitbucket
//! APIs on 127.0.0.1) and a Git server over HTTP (`gitserve`). Never the real internet.

use super::*;
use crate::gitsync::Git;
use crate::gitsync::gitserve::{self, GitServer};
use crate::network::{NetworkSettings, ProxyMode, ProxyProfile, Service};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

const TOKEN: &str = "ghp_SetupGeheim4711";

// ------------------------------------------------------------------ fake server

#[derive(Debug, Clone)]
struct Req {
    method: String,
    /// Path and query (absolute-form when the server acts as a proxy).
    target: String,
    headers: Vec<(String, String)>,
    body: String,
}

impl Req {
    fn header(&self, k: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }
    fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or("")
    }
    fn query(&self, k: &str) -> Option<String> {
        let q = self.target.split_once('?')?.1;
        q.split('&').find_map(|p| p.split_once('=').filter(|(n, _)| *n == k).map(|(_, v)| v.replace("%2F", "/")))
    }
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
}

struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn reply(status: u16, body: Value) -> Reply {
    Reply { status, headers: vec![("Content-Type".into(), "application/json".into())], body: body.to_string() }
}

fn with(mut r: Reply, k: &str, v: &str) -> Reply {
    r.headers.push((k.into(), v.into()));
    r
}

type Handler = Arc<dyn Fn(&Req) -> Reply + Send + Sync>;

struct Fake {
    base: String,
    seen: Arc<Mutex<Vec<Req>>>,
    stop: Arc<AtomicBool>,
    port: u16,
}

impl Fake {
    fn start(handler: Handler) -> Fake {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (seen2, stop2) = (seen.clone(), stop.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (h, seen) = (handler.clone(), seen2.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, &h, &seen);
                });
            }
        });
        Fake { base: format!("http://127.0.0.1:{port}"), seen, stop, port }
    }

    fn seen(&self) -> Vec<Req> {
        self.seen.lock().unwrap().clone()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn serve(conn: TcpStream, handler: &Handler, seen: &Mutex<Vec<Req>>) -> std::io::Result<()> {
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
        let mut headers = vec![];
        loop {
            let mut h = String::new();
            reader.read_line(&mut h)?;
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                headers.push((k.trim().to_ascii_lowercase(), v.trim().to_owned()));
            }
        }
        let n = headers.iter().find(|(k, _)| k == "content-length").and_then(|(_, v)| v.parse::<usize>().ok());
        let mut body = vec![0; n.unwrap_or(0)];
        reader.read_exact(&mut body)?;
        let req = Req { method, target, headers, body: String::from_utf8_lossy(&body).into_owned() };
        let r = handler(&req);
        seen.lock().unwrap().push(req);
        let mut head = format!("HTTP/1.1 {} X\r\nContent-Length: {}\r\n", r.status, r.body.len());
        for (k, v) in &r.headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        out.write_all(r.body.as_bytes())?;
        out.flush()?;
    }
}

fn direct() -> NetworkSettings {
    NetworkSettings {
        profiles: vec![ProxyProfile { mode: ProxyMode::None, ..Default::default() }],
        ..Default::default()
    }
}

fn client() -> Client {
    crate::network::client_for(&direct(), &|_| None, &Service::GitSync).unwrap()
}

const T: Duration = Duration::from_secs(10);

fn server(provider: Provider, web: &str) -> Server {
    Server { provider, web: web.into() }
}

/// No request carried the token anywhere but in its `Authorization` header.
fn token_only_in_header(seen: &[Req], token: &str) {
    for r in seen {
        assert!(!r.target.contains(token), "token in the URL: {}", r.target);
        assert!(!r.body.contains(token), "token in the body");
        for (k, v) in &r.headers {
            if k != "authorization" && k != "private-token" {
                assert!(!v.contains(token), "token in header {k}");
            }
        }
    }
}

fn tmp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("arcalo-gitsetup-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

/// Pushes one commit with `files` to the bare repository `bare` (branch main).
fn push_files(bare: &Path, files: &[(&str, &str)]) {
    let work = bare.with_extension("work");
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).unwrap();
    let run = |args: &[&str]| {
        let ok = Command::new("git")
            .args(["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
            .args(args)
            .current_dir(&work)
            .output()
            .unwrap();
        assert!(ok.status.success(), "{args:?}: {}", String::from_utf8_lossy(&ok.stderr));
    };
    run(&["init", "-q", "-b", "main"]);
    for (name, text) in files {
        std::fs::write(work.join(name), text).unwrap();
    }
    run(&["add", "-A"]);
    run(&["commit", "-q", "-m", "first"]);
    run(&["push", "-q", bare.to_str().unwrap(), "main"]);
}

// ------------------------------------------------------------------ fake providers

/// What a fake provider knows: its repositories (name → can push, clone address), the token it
/// accepts and how it answers a wrong one.
#[derive(Clone)]
struct World {
    token: String,
    owner: String,
    repos: Arc<Mutex<Vec<(String, bool, String)>>>,
    scopes: Option<String>,
    expired: bool,
    /// The repository's `.gitattributes` per name.
    attributes: Arc<Mutex<Vec<(String, String)>>>,
    /// Clone address of a created repository.
    create_url: String,
}

impl World {
    fn new(n: usize) -> World {
        let repos = (0..n)
            .map(|i| (format!("repo-{i:03}"), true, format!("https://example.invalid/mia/repo-{i:03}.git")))
            .collect();
        World {
            token: TOKEN.into(),
            owner: "mia".into(),
            repos: Arc::new(Mutex::new(repos)),
            scopes: Some("repo, read:org".into()),
            expired: false,
            attributes: Arc::new(Mutex::new(vec![])),
            create_url: String::new(),
        }
    }
    fn add(&self, name: &str, push: bool, clone: &str) {
        self.repos.lock().unwrap().push((name.into(), push, clone.into()));
    }
    fn find(&self, name: &str) -> Option<(String, bool, String)> {
        self.repos.lock().unwrap().iter().find(|r| r.0 == name).cloned()
    }
}

fn github(w: World) -> Handler {
    Arc::new(move |r: &Req| {
        if r.header("authorization") != Some(&format!("Bearer {}", w.token)) {
            return reply(401, json!({"message": "Bad credentials"}));
        }
        if r.header("user-agent").is_none_or(|u| !u.starts_with("Arcalo/")) {
            return reply(
                403,
                json!({"message": "Request forbidden by administrative rules. Please make sure your request has a User-Agent header"}),
            );
        }
        let repo = |name: &str, push: bool, clone: &str| {
            json!({"name": name, "full_name": format!("{}/{name}", w.owner), "owner": {"login": w.owner}, "private": true,
                   "clone_url": clone, "html_url": format!("https://example.invalid/{}/{name}", w.owner),
                   "default_branch": "main", "permissions": {"admin": push, "push": push, "pull": true}, "pushed_at": "2026-10-01T10:00:00Z"})
        };
        let scoped = |rep: Reply| match &w.scopes {
            Some(s) => with(rep, "X-OAuth-Scopes", s),
            None => rep,
        };
        let p = r.path().strip_prefix("/api/v3").unwrap_or("");
        let segs: Vec<&str> = p.trim_matches('/').split('/').collect();
        match (r.method.as_str(), segs.as_slice()) {
            ("GET", ["user"]) => with(
                scoped(reply(200, json!({"login": w.owner, "name": "Mia Meyer"}))),
                "github-authentication-token-expiration",
                "2026-12-31 10:00:00 UTC",
            ),
            ("GET", ["user", "repos"]) => {
                let per: usize = r.query("per_page").and_then(|v| v.parse().ok()).unwrap_or(30);
                let page: usize = r.query("page").and_then(|v| v.parse().ok()).unwrap_or(1);
                let all = w.repos.lock().unwrap().clone();
                let items: Vec<Value> =
                    all.iter().skip((page - 1) * per).take(per).map(|(n, p, c)| repo(n, *p, c)).collect();
                reply(200, Value::Array(items))
            }
            ("POST", ["user", "repos"]) => {
                let name = r.json()["name"].as_str().unwrap_or_default().to_owned();
                assert_eq!(r.json()["private"], json!(true), "always private");
                if w.find(&name).is_some() {
                    return reply(
                        422,
                        json!({"message": "Repository creation failed.", "errors": [{"resource": "Repository", "field": "name", "message": "name already exists on this account"}]}),
                    );
                }
                w.add(&name, true, &w.create_url);
                reply(201, repo(&name, true, &w.create_url))
            }
            ("GET", ["repos", owner, name]) if *owner == w.owner => match w.find(name) {
                Some((n, push, clone)) => scoped(reply(200, repo(&n, push, &clone))),
                None => reply(404, json!({"message": "Not Found"})),
            },
            ("GET", ["repos", _, name, "contents", ".gitattributes"]) => {
                match w.attributes.lock().unwrap().iter().find(|(n, _)| n == name) {
                    Some((_, text)) => {
                        use base64::Engine;
                        let b64 = base64::engine::general_purpose::STANDARD.encode(text);
                        // GitHub wraps the Base64 at 60 characters.
                        let wrapped: Vec<String> =
                            b64.as_bytes().chunks(60).map(|c| String::from_utf8_lossy(c).into_owned()).collect();
                        reply(200, json!({"encoding": "base64", "content": wrapped.join("\n")}))
                    }
                    None => reply(404, json!({"message": "Not Found"})),
                }
            }
            _ => reply(404, json!({"message": "Not Found"})),
        }
    })
}

fn gitlab(w: World) -> Handler {
    Arc::new(move |r: &Req| {
        if r.header("authorization") != Some(&format!("Bearer {}", w.token)) {
            return reply(401, json!({"message": "401 Unauthorized"}));
        }
        if w.expired {
            return reply(
                401,
                json!({"error": "invalid_token", "error_description": "Token is expired. You can either do re-authorization or token refresh."}),
            );
        }
        let project = |name: &str, level: u64, clone: &str| {
            json!({"path_with_namespace": format!("{}/sub/{name}", w.owner), "path": name, "visibility": "private",
                   "http_url_to_repo": clone, "web_url": format!("https://gitlab.example/{}/sub/{name}", w.owner),
                   "default_branch": "main", "empty_repo": false, "last_activity_at": "2026-10-01T10:00:00Z",
                   "permissions": {"project_access": {"access_level": level}, "group_access": null}})
        };
        let p = r.path().strip_prefix("/gitlab/api/v4").unwrap_or("");
        match (r.method.as_str(), p) {
            ("GET", "/user") => reply(200, json!({"username": w.owner, "name": "Mia Meyer"})),
            ("GET", "/personal_access_tokens/self") => {
                let scopes: Vec<&str> =
                    w.scopes.as_deref().unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
                reply(200, json!({"scopes": scopes, "expires_at": "2026-12-31"}))
            }
            ("GET", "/projects") => {
                assert_eq!(r.query("membership").as_deref(), Some("true"));
                let page: usize = r.query("page").and_then(|v| v.parse().ok()).unwrap_or(1);
                let all = w.repos.lock().unwrap().clone();
                let items: Vec<Value> = all
                    .iter()
                    .skip((page - 1) * 100)
                    .take(100)
                    .map(|(n, p, c)| project(n, if *p { 40 } else { 20 }, c))
                    .collect();
                let next = if page * 100 < all.len() { (page + 1).to_string() } else { String::new() };
                with(reply(200, Value::Array(items)), "X-Next-Page", &next)
            }
            ("POST", "/projects") => {
                let name = r.json()["name"].as_str().unwrap_or_default().to_owned();
                assert_eq!(r.json()["visibility"], json!("private"));
                if w.find(&name).is_some() {
                    return reply(
                        400,
                        json!({"message": {"name": ["has already been taken"], "path": ["has already been taken"]}}),
                    );
                }
                w.add(&name, true, &w.create_url);
                reply(201, project(&name, 50, &w.create_url))
            }
            ("GET", path) if path.starts_with("/projects/") => {
                // `mia%2Fsub%2Fname`, the project path as one segment.
                let id = path.trim_start_matches("/projects/").replace("%2F", "/");
                if let Some(rest) = id.strip_suffix("/repository/files/.gitattributes/raw") {
                    let name = rest.rsplit('/').next().unwrap_or_default();
                    return match w.attributes.lock().unwrap().iter().find(|(n, _)| n == name) {
                        Some((_, t)) => Reply { status: 200, headers: vec![], body: t.clone() },
                        None => reply(404, json!({"message": "404 File Not Found"})),
                    };
                }
                let name = id.rsplit('/').next().unwrap_or_default();
                match w.find(name) {
                    Some((n, p, c)) if id == format!("{}/sub/{n}", w.owner) => {
                        reply(200, project(&n, if p { 30 } else { 20 }, &c))
                    }
                    _ => reply(404, json!({"message": "404 Project Not Found"})),
                }
            }
            _ => reply(404, json!({"message": "404 Not Found"})),
        }
    })
}

fn gitea(w: World) -> Handler {
    Arc::new(move |r: &Req| {
        if r.header("authorization") != Some(&format!("token {}", w.token)) {
            return reply(401, json!({"message": "user does not exist [uid: 0, name: ]"}));
        }
        let repo = |name: &str, push: bool, clone: &str| {
            json!({"name": name, "full_name": format!("{}/{name}", w.owner), "owner": {"login": w.owner}, "private": true,
                   "clone_url": clone, "html_url": format!("https://gitea.example/{}/{name}", w.owner), "default_branch": "main",
                   "empty": false, "permissions": {"admin": false, "push": push, "pull": true}, "updated_at": "2026-10-01T10:00:00Z"})
        };
        let p = r.path().strip_prefix("/api/v1").unwrap_or("");
        let segs: Vec<&str> = p.trim_matches('/').split('/').collect();
        match (r.method.as_str(), segs.as_slice()) {
            ("GET", ["user"]) => reply(200, json!({"login": w.owner, "full_name": "Mia Meyer"})),
            ("GET", ["user", "repos"]) => {
                let limit: usize = r.query("limit").and_then(|v| v.parse().ok()).unwrap_or(30);
                let page: usize = r.query("page").and_then(|v| v.parse().ok()).unwrap_or(1);
                let all = w.repos.lock().unwrap().clone();
                reply(
                    200,
                    Value::Array(
                        all.iter().skip((page - 1) * limit).take(limit).map(|(n, p, c)| repo(n, *p, c)).collect(),
                    ),
                )
            }
            ("POST", ["user", "repos"]) => {
                let name = r.json()["name"].as_str().unwrap_or_default().to_owned();
                if w.find(&name).is_some() {
                    return reply(409, json!({"message": "The repository with the same name already exists."}));
                }
                w.add(&name, true, &w.create_url);
                reply(201, repo(&name, true, &w.create_url))
            }
            ("GET", ["repos", _, name]) => match w.find(name) {
                Some((n, p, c)) => reply(200, repo(&n, p, &c)),
                None => reply(404, json!({"message": "The target couldn't be found."})),
            },
            ("GET", ["repos", _, name, "raw", ".gitattributes"]) => {
                match w.attributes.lock().unwrap().iter().find(|(n, _)| n == name) {
                    Some((_, t)) => Reply { status: 200, headers: vec![], body: t.clone() },
                    None => reply(404, json!({"message": "The target couldn't be found."})),
                }
            }
            _ => reply(404, json!({"message": "not found"})),
        }
    })
}

const MARKED: &str = "# Arcalo Git-Synchronisierung\n* text=auto\n";

// ------------------------------------------------------------------ tests

#[test]
fn api_bases_of_the_providers() {
    let base = |p, w| server(p, w).api_base().map(|u| u.to_string().trim_end_matches('/').to_owned());
    assert_eq!(base(Provider::Github, "https://github.com/").unwrap(), "https://api.github.com");
    assert_eq!(base(Provider::Github, "https://www.github.com").unwrap(), "https://api.github.com");
    assert_eq!(base(Provider::Github, "https://ghe.firma.de").unwrap(), "https://ghe.firma.de/api/v3");
    assert_eq!(base(Provider::Gitlab, "https://gitlab.com").unwrap(), "https://gitlab.com/api/v4");
    assert_eq!(base(Provider::Gitlab, "https://firma.de/gitlab/").unwrap(), "https://firma.de/gitlab/api/v4");
    assert_eq!(base(Provider::Gitea, "https://codeberg.org").unwrap(), "https://codeberg.org/api/v1");
    assert_eq!(base(Provider::Gitea, "http://127.0.0.1:3000").unwrap(), "http://127.0.0.1:3000/api/v1");
    assert_eq!(base(Provider::Bitbucket, "https://bitbucket.org").unwrap(), "https://api.bitbucket.org/2.0");
    // A user in the address is dropped, never sent.
    assert_eq!(base(Provider::Gitea, "https://bob:pw@git.firma.de/?x=1").unwrap(), "https://git.firma.de/api/v1");
    assert_eq!(base(Provider::Other, "https://git.firma.de").unwrap_err().kind, ProblemKind::NotApi);
    for bad in ["git@github.com:mia/x.git", "ftp://x.de", "", "github.com"] {
        assert_eq!(base(Provider::Github, bad).unwrap_err().kind, ProblemKind::BadAddress, "{bad}");
    }
}

#[test]
fn git_and_connection_errors_are_classified() {
    use ProblemKind::*;
    let cases: &[(&str, ProblemKind)] = &[
        // git over HTTPS, as `failure_message` wraps it.
        (
            "Anmeldung am Git-Server fehlgeschlagen – Zugangstoken bzw. SSH-Schlüssel prüfen (fatal: Authentication failed for 'https://github.com/mia/x.git/')",
            TokenInvalid,
        ),
        (
            "Sign-in to the Git server failed – check the access token or SSH key (fatal: could not read Username for 'https://gitlab.com': terminal prompts disabled)",
            TokenInvalid,
        ),
        ("fatal: unable to access 'https://github.com/mia/x.git/': The requested URL returned error: 403", TokenScope),
        ("remote: Permission to mia/x.git denied to bob.", TokenScope),
        (
            "remote: HTTP Basic: Access denied. If a password was provided for Git authentication, the password was incorrect or you're required to use a token instead of a password. The provided password or token is incorrect or your account has 2FA enabled and you must use a personal access token instead of a password. 401",
            TokenInvalid,
        ),
        ("remote: Your token has expired.", TokenExpired),
        (
            "Git-Repository nicht erreichbar (remote: Repository not found. · fatal: repository 'https://github.com/mia/fehlt.git/' not found)",
            NotFound,
        ),
        ("fatal: '/tmp/fehlt.git' does not appear to be a git repository", NotFound),
        (
            "Git repository not reachable (fatal: unable to access 'https://git.firma.de/x.git/': Could not resolve host: git.firma.de)",
            Unreachable,
        ),
        (
            "fatal: unable to access 'https://github.com/x.git/': Failed to connect to github.com port 443 after 21 ms: Connection refused",
            Unreachable,
        ),
        (
            "fatal: unable to access 'https://git.firma.de/x.git/': SSL certificate problem: unable to get local issuer certificate",
            Certificate,
        ),
        (
            "fatal: unable to access 'https://git.firma.de/x.git/': server certificate verification failed. CAfile: none CRLfile: none",
            Certificate,
        ),
        ("fatal: unable to access 'https://github.com/x.git/': Received HTTP code 407 from proxy after CONNECT", Proxy),
        ("fatal: unable to access 'https://github.com/x.git/': Could not resolve proxy: proxy.firma.de", Proxy),
        ("fatal: unable to access 'https://github.com/x.git/': Operation timed out after 30000 milliseconds", Timeout),
        ("git ls-remote hat nicht innerhalb von 60 s geantwortet und wurde abgebrochen", Timeout),
        ("git@github.com: Permission denied (publickey).", Ssh),
        (
            "Auf dem Telefon geht nur eine HTTPS-Adresse mit Zugangstoken, kein SSH. Trage die HTTPS-Adresse des Repositorys ein.",
            Ssh,
        ),
        (
            "The phone supports HTTPS addresses with an access token only, no SSH. Enter the repository's HTTPS address.",
            Ssh,
        ),
        ("Host key verification failed.", Ssh),
        ("Git ist nicht installiert (git-scm.com)", GitMissing),
        ("Git is not installed (git-scm.com)", GitMissing),
        // reqwest's chains.
        (
            "error sending request for url (https://api.github.com/user): client error (Connect): dns error: failed to lookup address information",
            Unreachable,
        ),
        (
            "error sending request for url (https://api.github.com/user): client error (Connect): invalid peer certificate: UnknownIssuer",
            Certificate,
        ),
        (
            "error sending request for url (https://api.github.com/user): client error (Connect): unsuccessful tunnel",
            Proxy,
        ),
        ("something else entirely", Other),
    ];
    for (text, want) in cases {
        assert_eq!(classify_text(text), *want, "{text}");
    }
}

#[test]
fn error_answers_are_classified_per_provider() {
    use ProblemKind::*;
    let none = HeaderMap::new();
    let mut limited = HeaderMap::new();
    limited.insert("x-ratelimit-remaining", "0".parse().unwrap());
    let mut sso = HeaderMap::new();
    sso.insert("x-github-sso", "required; url=https://github.com/orgs/x/sso".parse().unwrap());
    let c = |p, s, h: &HeaderMap, b: &str| classify_status(p, s, h, b).kind;
    assert_eq!(c(Provider::Github, 401, &none, r#"{"message":"Bad credentials"}"#), TokenInvalid);
    assert_eq!(
        c(Provider::Gitlab, 401, &none, r#"{"error":"invalid_token","error_description":"Token is expired."}"#),
        TokenExpired
    );
    assert_eq!(c(Provider::Github, 403, &limited, r#"{"message":"API rate limit exceeded"}"#), RateLimited);
    assert_eq!(c(Provider::Gitea, 429, &none, ""), RateLimited);
    assert_eq!(
        c(Provider::Github, 403, &sso, r#"{"message":"Resource protected by organization SAML enforcement."}"#),
        TokenScope
    );
    assert_eq!(
        c(Provider::Github, 403, &none, r#"{"message":"Resource not accessible by personal access token"}"#),
        TokenScope
    );
    assert_eq!(
        c(
            Provider::Gitlab,
            403,
            &none,
            r#"{"error":"insufficient_scope","error_description":"The request requires higher privileges than provided by the access token."}"#
        ),
        TokenScope
    );
    assert_eq!(
        c(
            Provider::Gitea,
            403,
            &none,
            r#"{"message":"token does not have at least one of required scope(s): [write:repository]"}"#
        ),
        TokenScope
    );
    assert_eq!(c(Provider::Github, 404, &none, r#"{"message":"Not Found"}"#), NotFound);
    assert_eq!(c(Provider::Github, 407, &none, "<html>Proxy Authentication Required</html>"), Proxy);
    assert_eq!(
        c(Provider::Gitea, 409, &none, r#"{"message":"The repository with the same name already exists."}"#),
        Exists
    );
    assert_eq!(
        c(
            Provider::Github,
            422,
            &none,
            r#"{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}"#
        ),
        Exists
    );
    assert_eq!(c(Provider::Gitlab, 400, &none, r#"{"message":{"name":["has already been taken"]}}"#), Exists);
    assert_eq!(c(Provider::Github, 502, &none, "<html>Bad gateway</html>"), Server);
    assert_eq!(c(Provider::Github, 418, &none, ""), Other);
    // The detail is the server's message, never the markup of a web page.
    assert_eq!(
        classify_status(Provider::Github, 401, &none, r#"{"message":"Bad credentials"}"#).detail,
        "HTTP 401: Bad credentials"
    );
    assert_eq!(classify_status(Provider::Github, 502, &none, "<html><body>x</body></html>").detail, "HTTP 502");
    assert_eq!(
        classify_status(
            Provider::Gitlab,
            401,
            &none,
            r#"{"error":"invalid_token","error_description":"Token is expired."}"#
        )
        .detail,
        "HTTP 401: Token is expired."
    );
}

#[test]
fn repository_names() {
    for ok in ["arcalo-notizen", "Notes_2026", "a.b", "x"] {
        assert!(valid_repo_name(ok), "{ok}");
    }
    for bad in ["", "  ", ".hidden", "-x", "a b", "notizen.git", "ä", "a/b", &"x".repeat(101)] {
        assert!(!valid_repo_name(bad), "{bad}");
    }
}

#[tokio::test]
async fn github_lists_every_page_creates_private_repositories_and_reads_the_rights() {
    let w = World::new(130);
    let w2 = World { create_url: "https://example.invalid/mia/arcalo-notizen.git".into(), ..w.clone() };
    let fake = Fake::start(github(w2.clone()));
    let c = client();
    let srv = server(Provider::Github, &fake.base);
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();

    let me = account(&api).await.unwrap().unwrap();
    assert_eq!(me.login, "mia");
    assert_eq!(me.name.as_deref(), Some("Mia Meyer"));
    assert_eq!(me.expires.as_deref(), Some("2026-12-31 10:00:00 UTC"));
    assert_eq!(me.scopes, Some(vec!["repo".to_owned(), "read:org".to_owned()]));

    let repos = list_repos(&api).await.unwrap();
    assert_eq!(repos.len(), 130, "two pages of 100");
    assert_eq!(repos[0].full_name, "mia/repo-000");
    assert_eq!(repos[129].name, "repo-129");
    assert_eq!(repos[0].can_push, Some(true));
    assert_eq!(repos[0].default_branch.as_deref(), Some("main"));
    let pages: Vec<String> =
        fake.seen().iter().filter(|r| r.path() == "/api/v3/user/repos").filter_map(|r| r.query("page")).collect();
    assert_eq!(pages, ["1", "2"]);

    let made = create_repo(&api, PROPOSED_NAME).await.unwrap();
    assert_eq!(made.full_name, "mia/arcalo-notizen");
    assert!(made.private);
    assert_eq!(made.empty, Some(true));
    assert_eq!(made.clone_url, "https://example.invalid/mia/arcalo-notizen.git");
    assert_eq!(create_repo(&api, PROPOSED_NAME).await.unwrap_err().kind, ProblemKind::Exists);
    assert_eq!(create_repo(&api, "kein name").await.unwrap_err().kind, ProblemKind::BadName);

    let a = repo_access(&api, "mia", "repo-001", Some(&me)).await.unwrap();
    assert_eq!((a.write, a.write_problem.map(|p| p.kind)), (Some(true), None));
    w.add("nur-lesen", false, "https://example.invalid/mia/nur-lesen.git");
    let a = repo_access(&api, "mia", "nur-lesen", Some(&me)).await.unwrap();
    assert_eq!((a.write, a.write_problem.map(|p| p.kind)), (Some(false), Some(ProblemKind::NoWrite)));
    assert_eq!(repo_access(&api, "mia", "fehlt", Some(&me)).await.unwrap_err().kind, ProblemKind::NotFound);
    token_only_in_header(&fake.seen(), TOKEN);

    // A classic token without `repo` cannot push to a private repository.
    let fake2 = Fake::start(github(World { scopes: Some("read:user, gist".into()), ..World::new(2) }));
    let srv2 = server(Provider::Github, &fake2.base);
    let api2 = Api::new(&c, &srv2, TOKEN, T).unwrap();
    let a = repo_access(&api2, "mia", "repo-000", None).await.unwrap();
    assert_eq!((a.write, a.write_problem.map(|p| p.kind)), (Some(false), Some(ProblemKind::TokenScope)));
    // A fine-grained token names no scopes: the account's right decides.
    let fake3 = Fake::start(github(World { scopes: None, ..World::new(2) }));
    let srv3 = server(Provider::Github, &fake3.base);
    let api3 = Api::new(&c, &srv3, TOKEN, T).unwrap();
    assert_eq!(repo_access(&api3, "mia", "repo-000", None).await.unwrap().write, Some(true));

    // A wrong token: in plain words, never echoed.
    let wrong = Api::new(&c, &srv, "ghp_falsch", T).unwrap();
    let p = account(&wrong).await.unwrap_err();
    assert_eq!(p.kind, ProblemKind::TokenInvalid);
    assert_eq!(p.status, Some(401));
    assert!(!p.detail.contains("ghp_falsch"));
    assert_eq!(Api::new(&c, &srv, "  ", T).err().map(|p| p.kind), Some(ProblemKind::TokenMissing));
}

#[tokio::test]
async fn gitlab_pages_by_header_reads_access_levels_and_token_scopes() {
    let w = World { scopes: Some("read_repository, write_repository, read_api".into()), ..World::new(120) };
    w.add("lesen", false, "https://gitlab.example/mia/sub/lesen.git");
    let fake =
        Fake::start(gitlab(World { create_url: "https://gitlab.example/mia/arcalo-notizen.git".into(), ..w.clone() }));
    let c = client();
    // A GitLab below a path of its server.
    let srv = server(Provider::Gitlab, &format!("{}/gitlab", fake.base));
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    let me = account(&api).await.unwrap().unwrap();
    assert_eq!(me.login, "mia");
    assert_eq!(me.scopes.as_ref().map(Vec::len), Some(3));
    assert_eq!(me.expires.as_deref(), Some("2026-12-31"));

    let repos = list_repos(&api).await.unwrap();
    assert_eq!(repos.len(), 121);
    assert_eq!((repos[0].owner.as_str(), repos[0].name.as_str()), ("mia/sub", "repo-000"));
    assert_eq!(repos[0].can_push, Some(true));
    assert_eq!(repos.iter().find(|r| r.name == "lesen").unwrap().can_push, Some(false));

    // The project path is one encoded segment.
    let a = repo_access(&api, "mia/sub", "repo-005", Some(&me)).await.unwrap();
    assert_eq!(a.write, Some(true));
    assert!(fake.seen().iter().any(|r| r.target.starts_with("/gitlab/api/v4/projects/mia%2Fsub%2Frepo-005")));
    let a = repo_access(&api, "mia/sub", "lesen", Some(&me)).await.unwrap();
    assert_eq!(a.write_problem.map(|p| p.kind), Some(ProblemKind::NoWrite));
    // Developer rights, but a token for reading only.
    let reader = Account { scopes: Some(vec!["read_repository".into(), "read_api".into()]), ..me.clone() };
    let a = repo_access(&api, "mia/sub", "repo-005", Some(&reader)).await.unwrap();
    assert_eq!(a.write_problem.map(|p| p.kind), Some(ProblemKind::TokenScope));

    let made = create_repo(&api, PROPOSED_NAME).await.unwrap();
    assert!(made.private);
    assert_eq!(create_repo(&api, PROPOSED_NAME).await.unwrap_err().kind, ProblemKind::Exists);
    token_only_in_header(&fake.seen(), TOKEN);

    let expired = Fake::start(gitlab(World { expired: true, ..World::new(1) }));
    let srv = server(Provider::Gitlab, &format!("{}/gitlab", expired.base));
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    assert_eq!(account(&api).await.unwrap_err().kind, ProblemKind::TokenExpired);
}

#[tokio::test]
async fn gitea_pages_by_fifty_and_signs_in_with_its_token_header() {
    let w = World::new(75);
    w.add("lesen", false, "https://gitea.example/mia/lesen.git");
    w.attributes.lock().unwrap().push(("repo-001".into(), MARKED.into()));
    w.attributes.lock().unwrap().push(("repo-002".into(), "*.png binary\n".into()));
    let fake =
        Fake::start(gitea(World { create_url: "https://gitea.example/mia/arcalo-notizen.git".into(), ..w.clone() }));
    let c = client();
    let srv = server(Provider::Gitea, &fake.base);
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    assert_eq!(account(&api).await.unwrap().unwrap().name.as_deref(), Some("Mia Meyer"));
    let repos = list_repos(&api).await.unwrap();
    assert_eq!(repos.len(), 76);
    let pages: Vec<String> =
        fake.seen().iter().filter(|r| r.path() == "/api/v1/user/repos").filter_map(|r| r.query("page")).collect();
    assert_eq!(pages, ["1", "2"]);
    assert_eq!(
        repo_access(&api, "mia", "lesen", None).await.unwrap().write_problem.map(|p| p.kind),
        Some(ProblemKind::NoWrite)
    );
    assert_eq!(holds_sync(&api, "mia", "repo-001", "main").await, Some(true));
    assert_eq!(holds_sync(&api, "mia", "repo-002", "main").await, Some(false));
    assert_eq!(holds_sync(&api, "mia", "repo-003", "main").await, Some(false));
    create_repo(&api, PROPOSED_NAME).await.unwrap();
    assert_eq!(create_repo(&api, PROPOSED_NAME).await.unwrap_err().kind, ProblemKind::Exists);
    token_only_in_header(&fake.seen(), TOKEN);
}

#[tokio::test]
async fn bitbucket_follows_only_its_own_next_links() {
    let base = Arc::new(Mutex::new(String::new()));
    let b2 = base.clone();
    let fake = Fake::start(Arc::new(move |r: &Req| {
        let item = |n: &str| {
            json!({"full_name": format!("team/{n}"), "slug": n, "is_private": true, "workspace": {"slug": "team"},
                   "mainbranch": {"name": "main"},
                   "links": {"clone": [{"name": "https", "href": format!("https://mia@bitbucket.org/team/{n}.git")}, {"name": "ssh", "href": "git@bitbucket.org:team/x.git"}],
                             "html": {"href": format!("https://bitbucket.org/team/{n}")}}})
        };
        let me = b2.lock().unwrap().clone();
        match r.query("page").as_deref() {
            None => reply(
                200,
                json!({"values": [item("eins")], "next": format!("{me}/2.0/repositories?role=member&page=2")}),
            ),
            Some("2") => {
                reply(200, json!({"values": [item("zwei")], "next": "https://evil.example/2.0/repositories?page=3"}))
            }
            _ => reply(500, json!({})),
        }
    }));
    *base.lock().unwrap() = fake.base.clone();
    let c = client();
    let srv = server(Provider::Bitbucket, &fake.base);
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    let repos = list_repos(&api).await.unwrap();
    assert_eq!(repos.iter().map(|r| r.full_name.as_str()).collect::<Vec<_>>(), ["team/eins", "team/zwei"]);
    // The user name Bitbucket puts into its addresses is not kept.
    assert_eq!(repos[0].clone_url, "https://bitbucket.org/team/eins.git");
    assert_eq!(fake.seen().len(), 2, "the foreign next link is not followed");
}

#[tokio::test]
async fn requests_take_the_proxy_of_the_git_sync_profile() {
    // The fake answers as a proxy: requests arrive in absolute form.
    let proxy = Fake::start(Arc::new(|r: &Req| {
        if r.target.starts_with("http://git.firma.invalid/api/v1/user") {
            reply(200, json!({"login": "mia"}))
        } else {
            reply(502, json!({}))
        }
    }));
    let profile = ProxyProfile {
        id: "firma".into(),
        name: "Firma".into(),
        mode: ProxyMode::Manual,
        http_proxy: proxy.base.clone(),
        no_proxy: String::new(),
        ..Default::default()
    };
    let mut net = direct();
    net.profiles.push(profile);
    net.routes.insert("git_sync".into(), "firma".into());
    let c = crate::network::client_for(&net, &|_| None, &Service::GitSync).unwrap();
    let srv = server(Provider::Gitea, "http://git.firma.invalid");
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    assert_eq!(account(&api).await.unwrap().unwrap().login, "mia");
    assert_eq!(proxy.seen().len(), 1);
}

#[tokio::test]
async fn a_server_that_does_not_answer_or_answers_with_a_web_page() {
    let c = client();
    // A port nobody listens on.
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let srv = server(Provider::Github, &format!("http://127.0.0.1:{port}"));
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    assert_eq!(account(&api).await.unwrap_err().kind, ProblemKind::Unreachable);
    // A login page of a proxy or the wrong provider's site.
    let page = Fake::start(Arc::new(|_r: &Req| Reply {
        status: 200,
        headers: vec![("Content-Type".into(), "text/html".into())],
        body: "<html>Anmelden</html>".into(),
    }));
    let srv = server(Provider::Gitlab, &page.base);
    let api = Api::new(&c, &srv, TOKEN, T).unwrap();
    assert_eq!(account(&api).await.unwrap_err().kind, ProblemKind::NotApi);
    // No answer in time.
    let slow = Fake::start(Arc::new(|_r: &Req| {
        std::thread::sleep(Duration::from_millis(1500));
        reply(200, json!({}))
    }));
    let srv = server(Provider::Gitea, &slow.base);
    let api = Api::new(&c, &srv, TOKEN, Duration::from_millis(300)).unwrap();
    assert_eq!(account(&api).await.unwrap_err().kind, ProblemKind::Timeout);
}

/// A Git server with a token, a fake GitHub that points to it, and the check as the shell runs it.
struct Rig {
    _git: GitServer,
    fake: Fake,
    world: World,
    root: PathBuf,
    git_base: String,
}

impl Rig {
    fn new(name: &str, git_token: &str) -> Rig {
        let root = tmp(name);
        let git = GitServer::start(&root, Some(git_token));
        let git_base = git.base.clone();
        let world = World::new(0);
        let fake = Fake::start(github(world.clone()));
        Rig { _git: git, fake, world, root, git_base }
    }

    /// A repository on both: on the Git server (bare, maybe with files) and in the API.
    fn repo(&self, name: &str, push: bool, files: &[(&str, &str)]) {
        let bare = gitserve::bare(&self.root, &format!("{name}.git"));
        if !files.is_empty() {
            push_files(&bare, files);
        }
        self.world.add(name, push, &format!("{}/{name}.git", self.git_base));
        if let Some((_, text)) = files.iter().find(|(f, _)| *f == ".gitattributes") {
            self.world.attributes.lock().unwrap().push((name.into(), (*text).into()));
        }
    }

    async fn check(&self, name: &str, token: &str) -> Check {
        let c = client();
        let srv = server(Provider::Github, &self.fake.base);
        let api = Api::new(&c, &srv, token, T).unwrap();
        let url = format!("{}/{name}.git", self.git_base);
        let target = Target { url: url.clone(), owner: Some("mia".into()), name: Some(name.into()) };
        let git = Git::new(Some(token.to_owned()), &url);
        check(Some(&api), &target, Some(token), move || git.ls_remote(&url)).await
    }
}

fn states(c: &Check) -> Vec<(StepId, StepState)> {
    c.steps.iter().map(|s| (s.id, s.state)).collect()
}

#[tokio::test]
async fn the_check_reads_rights_branch_and_content_with_git_ls_remote() {
    if !git_available() {
        return;
    }
    use StepId::*;
    use StepState::*;
    let rig = Rig::new("check", TOKEN);
    rig.repo("leer", true, &[]);
    rig.repo("arcalo", true, &[(".gitattributes", MARKED), ("Notiz.md", "# Notiz\n")]);
    rig.repo("fremd", true, &[("README.md", "# Projekt\n"), ("src.txt", "x")]);
    rig.repo("lesen", false, &[]);

    let c = rig.check("leer", TOKEN).await;
    assert_eq!(c.problem, None, "{c:?}");
    assert_eq!(states(&c), [(Server, Ok), (Token, Ok), (Repository, Ok), (Write, Ok), (Git, Ok), (Branch, Ok)]);
    assert_eq!((c.content, c.branch.as_deref(), c.branches.len()), (Some(Content::Empty), Some("main"), 0));
    assert_eq!(c.account.as_ref().map(|a| a.login.as_str()), Some("mia"));

    // Notes of Arcalo: adopted and merged by the first sync, on its branch.
    let c = rig.check("arcalo", TOKEN).await;
    assert_eq!((c.content, c.branch.as_deref()), (Some(Content::Arcalo), Some("main")), "{c:?}");
    assert_eq!(c.branches, ["main"]);

    // Other files stay untouched: the notes go to a branch of their own.
    let c = rig.check("fremd", TOKEN).await;
    assert_eq!(
        (c.content, c.branch.as_deref(), c.default_branch.as_deref()),
        (Some(Content::Other), Some(OWN_BRANCH), Some("main"))
    );

    // Read only: stops at the write right, in plain words.
    let c = rig.check("lesen", TOKEN).await;
    assert_eq!(c.problem.as_ref().map(|p| p.kind), Some(ProblemKind::NoWrite));
    assert_eq!(states(&c)[3], (Write, Fail));
    assert_eq!(states(&c)[4], (Git, Skipped));

    // Not there.
    let c = rig.check("fehlt", TOKEN).await;
    assert_eq!(c.problem.as_ref().map(|p| p.kind), Some(ProblemKind::NotFound));
    assert_eq!(states(&c)[2], (Repository, Fail));

    // A token the API does not accept.
    let c = rig.check("leer", "ghp_falsch").await;
    assert_eq!(c.problem.as_ref().map(|p| p.kind), Some(ProblemKind::TokenInvalid));
    assert_eq!(states(&c)[..2], [(Server, Ok), (Token, Fail)]);
    assert!(!format!("{c:?}").contains("ghp_falsch"));
}

#[tokio::test]
async fn git_refusing_the_token_and_ssh_addresses_fail_the_check() {
    if !git_available() {
        return;
    }
    // The API takes the token, the Git server wants another one (a token for the API only).
    let rig = Rig::new("gitrefuse", "ghp_andererToken");
    rig.repo("leer", true, &[]);
    let c = rig.check("leer", TOKEN).await;
    assert_eq!(c.problem.as_ref().map(|p| p.kind), Some(ProblemKind::TokenInvalid), "{c:?}");
    assert_eq!(states(&c)[4], (StepId::Git, StepState::Fail));
    assert!(!c.problem.unwrap().detail.contains(TOKEN));

    let c =
        check(None, &Target { url: "git@github.com:mia/x.git".into(), owner: None, name: None }, None, || Ok(vec![]))
            .await;
    assert_eq!(c.problem.map(|p| p.kind), Some(ProblemKind::Ssh));
}

#[tokio::test]
async fn another_server_is_checked_with_git_alone() {
    if !git_available() {
        return;
    }
    let root = tmp("other");
    let git = GitServer::start(&root, Some(TOKEN));
    let bare = gitserve::bare(&root, "notizen.git");
    push_files(&bare, &[("README.md", "x")]);
    let url = git.url("notizen.git");
    let g = Git::new(Some(TOKEN.into()), &url);
    let target = Target { url: url.clone(), owner: None, name: None };
    let c = check(None, &target, Some(TOKEN), move || g.ls_remote(&url)).await;
    assert_eq!(c.problem, None);
    assert_eq!(
        states(&c),
        [(StepId::Git, StepState::Ok), (StepId::Write, StepState::Unknown), (StepId::Branch, StepState::Ok)]
    );
    assert_eq!((c.content, c.branch.as_deref()), (Some(Content::Unknown), Some("main")));
    let url = git.url("fehlt.git");
    let g = Git::new(Some(TOKEN.into()), &url);
    let c = check(None, &Target { url: url.clone(), owner: None, name: None }, Some(TOKEN), move || g.ls_remote(&url))
        .await;
    assert_eq!(c.problem.map(|p| p.kind), Some(ProblemKind::NotFound));
    let _ = std::fs::remove_dir_all(&root);
}
