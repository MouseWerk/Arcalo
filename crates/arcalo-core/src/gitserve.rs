//! A Git server over HTTP for the sync's tests: `git http-backend` (the CGI program of the
//! installed git) behind a small HTTP/1.1 server on 127.0.0.1, with HTTP Basic sign-in like
//! GitHub's (`x-access-token` and the token). Every request is recorded, so a test sees what the
//! client sent and how often it was turned away. Never the real internet.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One request as the server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    /// Path and query.
    pub target: String,
    /// The `Authorization` header (`None` when the client sent none).
    pub authorization: Option<String>,
    /// The status the server answered with.
    pub status: u16,
}

pub struct GitServer {
    /// `http://127.0.0.1:<port>`; a repository `x.git` below the root is `<base>/x.git`.
    pub base: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
    /// While set, uploads (`git-receive-pack`) fail with 500, as on a connection lost mid-push.
    pub fail_push: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    port: u16,
}

impl GitServer {
    /// Serves the repositories below `root`. With `token`, every request must carry it (HTTP
    /// Basic, any user name), else the answer is 401 with a Basic challenge.
    pub fn start(root: &Path, token: Option<&str>) -> GitServer {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let fail_push = Arc::new(AtomicBool::new(false));
        let (root, token) = (root.to_path_buf(), token.map(str::to_owned));
        let (seen2, stop2, fail2) = (seen.clone(), stop.clone(), fail_push.clone());
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                if stop2.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(conn) = conn else { continue };
                let (root, token, seen, fail) = (root.clone(), token.clone(), seen2.clone(), fail2.clone());
                std::thread::spawn(move || {
                    let _ = serve(conn, &root, token.as_deref(), &seen, &fail);
                });
            }
        });
        GitServer { base: format!("http://127.0.0.1:{port}"), seen, fail_push, stop, port }
    }

    pub fn url(&self, repo: &str) -> String {
        format!("{}/{repo}", self.base)
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// Requests answered with 401.
    pub fn refused(&self) -> usize {
        self.seen().iter().filter(|s| s.status == 401).count()
    }
}

impl Drop for GitServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wakes the accepting thread up.
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn basic_ok(header: Option<&str>, token: &str) -> bool {
    use base64::Engine;
    let Some(b64) = header.and_then(|h| h.strip_prefix("Basic ")) else { return false };
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(b64.trim()) else { return false };
    String::from_utf8_lossy(&raw).split_once(':').is_some_and(|(_, pw)| pw == token)
}

/// Requests of one connection (keep-alive), until the client closes it.
fn serve(
    conn: TcpStream,
    root: &Path,
    token: Option<&str>,
    seen: &Mutex<Vec<Seen>>,
    fail_push: &AtomicBool,
) -> std::io::Result<()> {
    let mut out = conn.try_clone()?;
    let mut reader = BufReader::new(conn);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let (method, target) = (parts.next().unwrap_or("").to_owned(), parts.next().unwrap_or("").to_owned());
        let mut headers: Vec<(String, String)> = Vec::new();
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
        let header = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        if header("expect").is_some_and(|e| e.eq_ignore_ascii_case("100-continue")) {
            out.write_all(b"HTTP/1.1 100 Continue\r\n\r\n")?;
        }
        let mut body = Vec::new();
        if header("transfer-encoding").is_some_and(|t| t.eq_ignore_ascii_case("chunked")) {
            loop {
                let mut size = String::new();
                reader.read_line(&mut size)?;
                let n = usize::from_str_radix(size.trim().split(';').next().unwrap_or("0"), 16).unwrap_or(0);
                let mut chunk = vec![0; n + 2];
                reader.read_exact(&mut chunk)?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
        } else if let Some(n) = header("content-length").and_then(|n| n.parse::<usize>().ok()) {
            body.resize(n, 0);
            reader.read_exact(&mut body)?;
        }
        let authorization = header("authorization").map(str::to_owned);
        let close = header("connection").is_some_and(|c| c.eq_ignore_ascii_case("close"));
        let allowed = token.is_none_or(|t| basic_ok(authorization.as_deref(), t));
        let upload = method == "POST" && target.ends_with("/git-receive-pack");
        let (status, reason, extra, payload) = if !allowed {
            (
                401,
                "Unauthorized".to_owned(),
                vec![("WWW-Authenticate".to_owned(), "Basic realm=\"git\"".to_owned())],
                vec![],
            )
        } else if upload && fail_push.load(Ordering::SeqCst) {
            (500, "Internal Server Error".to_owned(), vec![], vec![])
        } else {
            cgi(root, &method, &target, &headers, &body)
        };
        seen.lock().unwrap().push(Seen { method, target, authorization, status });
        let mut head = format!("HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\n", payload.len());
        for (k, v) in extra {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        out.write_all(&payload)?;
        out.flush()?;
        if close {
            return Ok(());
        }
    }
}

type Answer = (u16, String, Vec<(String, String)>, Vec<u8>);

/// Runs `git http-backend` for one request.
fn cgi(root: &Path, method: &str, target: &str, headers: &[(String, String)], body: &[u8]) -> Answer {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let header = |k: &str| headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap_or_default();
    let mut cmd = Command::new("git");
    cmd.arg("http-backend")
        .env("GIT_PROJECT_ROOT", root)
        .env("GIT_HTTP_EXPORT_ALL", "1")
        .env("REQUEST_METHOD", method)
        .env("PATH_INFO", path)
        .env("QUERY_STRING", query)
        .env("CONTENT_TYPE", header("content-type"))
        .env("CONTENT_LENGTH", body.len().to_string())
        .env("HTTP_CONTENT_ENCODING", header("content-encoding"))
        .env("GIT_PROTOCOL", header("git-protocol"))
        // Pushing over HTTP needs a signed-in user.
        .env("REMOTE_USER", "arcalo")
        .env("REMOTE_ADDR", "127.0.0.1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let Ok(mut child) = cmd.spawn() else { return (500, "No git".into(), vec![], vec![]) };
    let mut stdin = child.stdin.take().unwrap();
    let input = body.to_vec();
    let writer = std::thread::spawn(move || {
        let _ = stdin.write_all(&input);
    });
    let output = child.wait_with_output().unwrap();
    let _ = writer.join();
    let raw = output.stdout;
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4));
    let split = split.or_else(|| raw.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2)));
    let Some((at, len)) = split else { return (500, "Bad CGI".into(), vec![], raw) };
    let (mut status, mut reason, mut extra) = (200, "OK".to_owned(), Vec::new());
    for line in String::from_utf8_lossy(&raw[..at]).lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        if k.eq_ignore_ascii_case("status") {
            let mut it = v.trim().splitn(2, ' ');
            status = it.next().and_then(|s| s.parse().ok()).unwrap_or(500);
            reason = it.next().unwrap_or("").to_owned();
        } else {
            extra.push((k.trim().to_owned(), v.trim().to_owned()));
        }
    }
    (status, reason, extra, raw[at + len..].to_vec())
}

/// A bare repository `name` below `root` that accepts pushes over HTTP.
pub fn bare(root: &Path, name: &str) -> PathBuf {
    let dir = root.join(name);
    let ok = Command::new("git").args(["init", "-q", "--bare", "-b", "main"]).arg(&dir).status().unwrap();
    assert!(ok.success());
    let ok = Command::new("git").args(["config", "http.receivepack", "true"]).current_dir(&dir).status().unwrap();
    assert!(ok.success());
    dir
}
