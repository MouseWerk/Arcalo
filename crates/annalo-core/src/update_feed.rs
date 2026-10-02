//! Where updates come from and how they arrive: the ordered feed sources (an organization's
//! server or network share first, GitHub as the fallback), `latest.json` and its platform
//! entries, a download that resumes after an interruption, and the signature check.
//!
//! Every file is checked against the public key compiled into the app, whatever the source:
//! a mirror on an internal share can deliver the files, but it cannot change them.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};

use crate::{tr, trf};

/// The release feeds on GitHub, in order (the repository was renamed twice; old names redirect).
/// Kept equal to `plugins.updater.endpoints` in `tauri.conf.json` (a test in the shell checks it).
pub const GITHUB_FEEDS: [&str; 3] = [
    "https://github.com/MouseWerk/Arcalo/releases/latest/download/latest.json",
    "https://github.com/MouseWerk/Annalo/releases/latest/download/latest.json",
    "https://github.com/mauricekleindienst/annalo/releases/latest/download/latest.json",
];

/// The feed file in a folder source.
pub const FEED_FILE: &str = "latest.json";

/// One place to look for `latest.json`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// An HTTP(S) address of a `latest.json` (or of the folder holding it).
    Url(String),
    /// A folder (local, mounted or UNC like `\\server\share\arcalo`) with `latest.json` and the files.
    Folder(PathBuf),
}

impl Source {
    /// Reads a source as an administrator writes it: an http(s) URL, a `file://` URL, or a path
    /// (to the folder or to its `latest.json`). Blank is none.
    pub fn parse(raw: &str) -> Option<Source> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        let lower = raw.to_ascii_lowercase();
        if lower.starts_with("http://") || lower.starts_with("https://") {
            let url = if lower.ends_with(".json") {
                raw.to_string()
            } else {
                format!("{}/{FEED_FILE}", raw.trim_end_matches('/'))
            };
            return Some(Source::Url(url));
        }
        let path = match lower.strip_prefix("file://") {
            Some(_) => file_url_path(raw)?,
            None => PathBuf::from(raw),
        };
        let folder =
            if lower.ends_with(".json") { path.parent().map(Path::to_path_buf).unwrap_or_default() } else { path };
        Some(Source::Folder(folder))
    }

    /// Where `latest.json` is read from (for messages and the log).
    pub fn label(&self) -> String {
        match self {
            Source::Url(u) => u.clone(),
            Source::Folder(f) => f.join(FEED_FILE).display().to_string(),
        }
    }

    /// Whether this is one of the GitHub feeds.
    pub fn is_github(&self) -> bool {
        matches!(self, Source::Url(u) if GITHUB_FEEDS.contains(&u.as_str()))
    }
}

fn file_url_path(raw: &str) -> Option<PathBuf> {
    let rest = &raw["file://".len()..];
    // file:///C:/x, file:///srv/x, file://server/share/x (UNC)
    let rest = percent_decode(rest);
    if let Some(local) = rest.strip_prefix('/') {
        let is_drive = local.as_bytes().get(1) == Some(&b':');
        return Some(PathBuf::from(if is_drive { local.to_string() } else { format!("/{local}") }));
    }
    if rest.is_empty() {
        return None;
    }
    Some(PathBuf::from(format!(r"\\{}", rest.replace('/', r"\"))))
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// The sources in the order they are asked: the organization's (or the user's) own source, then
/// GitHub unless that is switched off. `github` is the GitHub list (a test feed in debug runs).
pub fn sources(custom: Option<&str>, allow_github: bool, github: &[String]) -> Vec<Source> {
    let mut out: Vec<Source> = custom.and_then(Source::parse).into_iter().collect();
    if allow_github {
        out.extend(github.iter().filter_map(|g| Source::parse(g)));
    }
    out.dedup();
    out
}

/// `latest.json` as the Tauri bundler writes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub platforms: BTreeMap<String, Platform>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Platform {
    pub url: String,
    pub signature: String,
}

/// The platform keys this copy accepts, most specific first (`windows-x86_64-nsis`, then `windows-x86_64`).
pub fn targets(os_arch: &str, installer: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(i) = installer.filter(|i| !i.is_empty()) {
        out.push(format!("{os_arch}-{i}"));
    }
    out.push(os_arch.to_string());
    out
}

/// The entry of `manifest` for the first of `targets` it has.
pub fn platform<'a>(manifest: &'a Manifest, targets: &[String]) -> Option<&'a Platform> {
    targets.iter().find_map(|t| manifest.platforms.get(t))
}

/// Where an update file is read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "at", rename_all = "lowercase")]
pub enum Location {
    Http(String),
    File(PathBuf),
}

/// Resolves the `url` of a platform entry against the source it came from: absolute URLs and
/// paths stay, a bare file name (a mirrored folder) is next to `latest.json`.
pub fn locate(base: &Source, url: &str) -> Location {
    let url = url.trim();
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Location::Http(url.to_string());
    }
    if lower.starts_with("file://")
        && let Some(p) = file_url_path(url)
    {
        return Location::File(p);
    }
    let absolute = Path::new(url).is_absolute() || url.starts_with(r"\\") || url.as_bytes().get(1) == Some(&b':');
    match base {
        _ if absolute => Location::File(PathBuf::from(url)),
        Source::Folder(dir) => Location::File(dir.join(url)),
        Source::Url(feed) => {
            let joined = reqwest::Url::parse(feed).and_then(|b| b.join(url)).map(|u| u.to_string());
            Location::Http(joined.unwrap_or_else(|_| url.to_string()))
        }
    }
}

/// Why a source gave no usable `latest.json`, or a download failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedError {
    /// No `latest.json` there (HTTP 404, file missing).
    Missing,
    Connect,
    Timeout,
    /// The connection broke off midway.
    Interrupted,
    /// The server answered with another error status.
    Status(u16),
    /// `latest.json` could not be read as a feed.
    Invalid(String),
    /// A file of the share could not be read (the message names it).
    Io(String),
    /// The signature does not match the file or the key.
    Signature(String),
    /// No file for this system in that version.
    NoPlatform,
}

impl FeedError {
    pub fn message(&self) -> String {
        match self {
            FeedError::Missing => tr!(
                "Der Update-Server hat keine Versionsinformation geliefert",
                "The update server sent no version information"
            )
            .into(),
            FeedError::Connect => tr!(
                "Keine Verbindung zum Update-Server (offline, oder Proxy unter Einstellungen → Netzwerk prüfen)",
                "No connection to the update server (offline, or check the proxy under Settings → Network)"
            )
            .into(),
            FeedError::Timeout => tr!(
                "Zeitüberschreitung – der Update-Server antwortet nicht",
                "Timed out – the update server does not answer"
            )
            .into(),
            FeedError::Interrupted => tr!("Die Verbindung wurde unterbrochen", "The connection was interrupted").into(),
            FeedError::Status(code) => trf!(
                "Der Server hat die Datei nicht geliefert (Status {})",
                "The server did not deliver the file (status {})",
                code
            ),
            FeedError::Invalid(_) => {
                tr!("Die Versionsinformation ist ungültig", "The version information is invalid").into()
            }
            FeedError::Io(e) => e.clone(),
            FeedError::Signature(_) => tr!(
                "Die Signatur des Updates ist ungültig – die Datei wurde verworfen, es wurde nichts installiert",
                "The update's signature is invalid – the file was discarded, nothing was installed"
            )
            .into(),
            FeedError::NoPlatform => tr!(
                "Für dieses System gibt es in dieser Version kein Update-Paket",
                "This version has no update package for this system"
            )
            .into(),
        }
    }

    fn of_reqwest(e: &reqwest::Error) -> FeedError {
        if e.is_timeout() {
            FeedError::Timeout
        } else if e.is_connect() {
            FeedError::Connect
        } else if e.is_body() || e.is_decode() || e.is_request() {
            FeedError::Interrupted
        } else {
            FeedError::Io(e.to_string())
        }
    }

    fn of_io(path: &Path, e: &std::io::Error) -> FeedError {
        if e.kind() == std::io::ErrorKind::NotFound {
            return FeedError::Missing;
        }
        FeedError::Io(trf!("{} ist nicht lesbar ({})", "{} cannot be read ({})", path.display(), e))
    }
}

/// A `latest.json` that was read, and from which source.
#[derive(Debug, Clone, PartialEq)]
pub struct Found {
    pub source: Source,
    pub manifest: Manifest,
}

/// Asks the sources in order and returns the first usable `latest.json`. When all fail, the
/// error of each source (in order) is returned; the first one is what the user is told.
pub async fn fetch(client: &reqwest::Client, sources: &[Source]) -> Result<Found, Vec<(Source, FeedError)>> {
    let mut errors = Vec::new();
    for source in sources {
        match fetch_one(client, source).await {
            Ok(manifest) => return Ok(Found { source: source.clone(), manifest }),
            Err(e) => errors.push((source.clone(), e)),
        }
    }
    Err(errors)
}

async fn fetch_one(client: &reqwest::Client, source: &Source) -> Result<Manifest, FeedError> {
    let text = match source {
        Source::Url(url) => {
            let res = client
                .get(url)
                .header(reqwest::header::ACCEPT, "application/json")
                .send()
                .await
                .map_err(|e| FeedError::of_reqwest(&e))?;
            match res.status().as_u16() {
                200..=299 => {}
                404 => return Err(FeedError::Missing),
                code => return Err(FeedError::Status(code)),
            }
            res.text().await.map_err(|e| FeedError::of_reqwest(&e))?
        }
        Source::Folder(dir) => {
            let path = dir.join(FEED_FILE);
            // A share can take a moment to answer; that never blocks the async workers.
            tokio::task::spawn_blocking(move || std::fs::read_to_string(&path).map_err(|e| FeedError::of_io(&path, &e)))
                .await
                .map_err(|e| FeedError::Io(e.to_string()))??
        }
    };
    let manifest: Manifest =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| FeedError::Invalid(e.to_string()))?;
    if semver::Version::parse(manifest.version.trim().trim_start_matches('v')).is_err() {
        return Err(FeedError::Invalid(format!("version {}", manifest.version)));
    }
    Ok(manifest)
}

/// How a download ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Done,
    /// Stopped on request; the part file stays for [`download`] to resume.
    Paused,
}

const CHUNK: usize = 256 * 1024;

/// Downloads `from` into `part`, continuing an earlier part (HTTP `Range`, or an offset in the
/// share's file). `pause` stops it between chunks; `progress(done, total)` reports each chunk.
pub async fn download(
    client: &reqwest::Client,
    from: &Location,
    part: &Path,
    pause: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<Step, FeedError> {
    if let Some(dir) = part.parent() {
        std::fs::create_dir_all(dir).map_err(|e| FeedError::of_io(dir, &e))?;
    }
    let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    let open = |append: bool| {
        std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(append)
            .truncate(!append)
            .open(part)
            .map_err(|e| FeedError::of_io(part, &e))
    };
    match from {
        Location::Http(url) => {
            let mut req = client.get(url).header(reqwest::header::ACCEPT, "application/octet-stream");
            if have > 0 {
                req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
            }
            let res = req.send().await.map_err(|e| FeedError::of_reqwest(&e))?;
            let status = res.status().as_u16();
            // The part was complete already.
            if status == 416 && have > 0 {
                progress(have, Some(have));
                return Ok(Step::Done);
            }
            if !(200..300).contains(&status) {
                return Err(if status == 404 { FeedError::Status(404) } else { FeedError::Status(status) });
            }
            // 206: the server continues where the part ends; 200: it sends the whole file again.
            let resumed = status == 206 && have > 0;
            let mut done = if resumed { have } else { 0 };
            let total = res.content_length().map(|l| l + done);
            let mut file = open(resumed)?;
            progress(done, total);
            let mut stream = res.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| FeedError::of_reqwest(&e))?;
                file.write_all(&chunk).map_err(|e| FeedError::of_io(part, &e))?;
                done += chunk.len() as u64;
                progress(done, total);
                if pause.load(Ordering::SeqCst) {
                    let _ = file.flush();
                    return Ok(Step::Paused);
                }
            }
            if total.is_some_and(|t| done < t) {
                return Err(FeedError::Interrupted);
            }
            file.flush().map_err(|e| FeedError::of_io(part, &e))?;
            Ok(Step::Done)
        }
        Location::File(path) => {
            let mut src = std::fs::File::open(path).map_err(|e| FeedError::of_io(path, &e))?;
            let total = src.metadata().map(|m| m.len()).ok();
            let start = if total.is_some_and(|t| have <= t) { have } else { 0 };
            src.seek(SeekFrom::Start(start)).map_err(|e| FeedError::of_io(path, &e))?;
            let mut file = open(start > 0)?;
            let mut done = start;
            let mut buf = vec![0u8; CHUNK];
            progress(done, total);
            loop {
                let n = src.read(&mut buf).map_err(|e| FeedError::of_io(path, &e))?;
                if n == 0 {
                    break;
                }
                file.write_all(&buf[..n]).map_err(|e| FeedError::of_io(part, &e))?;
                done += n as u64;
                progress(done, total);
                if pause.load(Ordering::SeqCst) {
                    return Ok(Step::Paused);
                }
                // Lets other tasks run between chunks of a large file on a slow share.
                tokio::task::yield_now().await;
            }
            Ok(Step::Done)
        }
    }
}

/// Checks `data` against the minisign `signature` (base64 of the `.sig` file, as in
/// `latest.json`) with `pubkey` (base64 of the public key file), and that the signed trusted
/// comment names `version`: a feed cannot pair a new version number with an older file.
pub fn verify(data: &[u8], signature: &str, pubkey: &str, version: &str) -> Result<(), FeedError> {
    let b64 = |s: &str| {
        base64::engine::general_purpose::STANDARD
            .decode(s.trim())
            .ok()
            .and_then(|b| String::from_utf8(b).ok())
            .ok_or_else(|| FeedError::Signature("not base64".into()))
    };
    let key = minisign_verify::PublicKey::decode(&b64(pubkey)?).map_err(|e| FeedError::Signature(e.to_string()))?;
    let sig = minisign_verify::Signature::decode(&b64(signature)?).map_err(|e| FeedError::Signature(e.to_string()))?;
    key.verify(data, &sig, true).map_err(|e| FeedError::Signature(e.to_string()))?;
    let signed = sig.trusted_comment().split('\t').find_map(|f| f.strip_prefix("version:"));
    let same = |a: &str, b: &str| {
        let p = |v: &str| semver::Version::parse(v.trim().trim_start_matches('v')).ok();
        p(a).is_some() && p(a) == p(b)
    };
    match signed {
        Some(s) if same(s, version) => Ok(()),
        Some(s) => Err(FeedError::Signature(format!("signed for {s}, announced {version}"))),
        None => Err(FeedError::Signature("no signed version".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // A throwaway key and the signature of PAYLOAD for version 1.9.1 (e2e/lib/update-feed.js made them).
    const PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgKGFubmFsbyBlMmUpClJXVGxVOEJ0eDQ1MC9XaEV1YjM3S0cvcTFlTjRWNkVDTlVhbHFqZXZPRHNrVjQxazVxSVlLNDQrCg==";
    const SIG: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIGFubmFsbyBlMmUga2V5ClJXVGxVOEJ0eDQ1MC9XNXRSSENVbUpGRDdYdEVSeGpwUit5OUJHWk1pZWhvS09vR0Z2SVRtUWtmT1o0WVZtNlQxbzQvdVdZT0NwYjlHSDdNL3VKWDY5UklhYkRrdGh4VEpnVT0KdHJ1c3RlZCBjb21tZW50OiB0aW1lc3RhbXA6MTc5MDkzMjMxNwlmaWxlOmFubmFsby11cGRhdGUuYmluCXZlcnNpb246MS45LjEKYVh2WGIwNXAvc01TTDJCcVNIdGlsazBBQzZnQ3loN0lXOU9qdTdBcyt4SHNKenJMQnFJUXpPYVUwY1lwbEJTLzNWRzUya0JWaFVYcjBjcGY1YU5ZQlE9PQo=";
    const PAYLOAD: &[u8] = b"arcalo update payload";

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("annalo-feed-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sources_parse_urls_folders_and_shares() {
        assert_eq!(Source::parse(" "), None);
        assert_eq!(
            Source::parse("https://updates.corp/arcalo/"),
            Some(Source::Url("https://updates.corp/arcalo/latest.json".into()))
        );
        assert_eq!(Source::parse("https://x/feed.json"), Some(Source::Url("https://x/feed.json".into())));
        assert_eq!(
            Source::parse(r"\\server\share\arcalo"),
            Some(Source::Folder(PathBuf::from(r"\\server\share\arcalo")))
        );
        assert_eq!(Source::parse("/srv/arcalo/latest.json"), Some(Source::Folder(PathBuf::from("/srv/arcalo"))));
        assert_eq!(Source::parse("file:///srv/ar%20calo"), Some(Source::Folder(PathBuf::from("/srv/ar calo"))));
        assert_eq!(
            Source::parse("file://server/share/arcalo"),
            Some(Source::Folder(PathBuf::from(r"\\server\share\arcalo")))
        );
    }

    #[test]
    fn own_source_first_github_only_when_allowed() {
        let gh: Vec<String> = GITHUB_FEEDS.iter().map(|s| s.to_string()).collect();
        let all = sources(Some(r"\\srv\arcalo"), true, &gh);
        assert_eq!(all.len(), 4);
        assert_eq!(all[0], Source::Folder(PathBuf::from(r"\\srv\arcalo")));
        assert!(all[1..].iter().all(Source::is_github));
        assert_eq!(sources(Some(r"\\srv\arcalo"), false, &gh), vec![Source::Folder(PathBuf::from(r"\\srv\arcalo"))]);
        assert_eq!(sources(None, true, &gh).len(), 3);
        assert!(sources(None, false, &gh).is_empty(), "no source at all: nothing is asked");
    }

    #[test]
    fn platform_entries_and_relative_files() {
        let m: Manifest = serde_json::from_str(
            r#"{"version":"1.9.1","platforms":{"windows-x86_64":{"url":"Arcalo_1.9.1_x64-setup.exe","signature":"s"},
            "linux-x86_64-appimage":{"url":"https://h/a.AppImage","signature":"t"}}}"#,
        )
        .unwrap();
        assert_eq!(platform(&m, &targets("windows-x86_64", Some("nsis"))).unwrap().signature, "s");
        assert_eq!(platform(&m, &targets("linux-x86_64", Some("appimage"))).unwrap().signature, "t");
        assert!(platform(&m, &targets("darwin-aarch64", Some("app"))).is_none());
        let share = Source::Folder(PathBuf::from("/srv/arcalo"));
        assert_eq!(locate(&share, "Arcalo.exe"), Location::File(PathBuf::from("/srv/arcalo/Arcalo.exe")));
        assert_eq!(locate(&share, "https://h/a"), Location::Http("https://h/a".into()));
        let web = Source::Url("https://corp/arcalo/latest.json".into());
        assert_eq!(locate(&web, "Arcalo.exe"), Location::Http("https://corp/arcalo/Arcalo.exe".into()));
        assert_eq!(locate(&web, r"\\srv\x\Arcalo.exe"), Location::File(PathBuf::from(r"\\srv\x\Arcalo.exe")));
    }

    #[test]
    fn signatures_are_checked_with_the_key_and_the_signed_version() {
        assert_eq!(verify(PAYLOAD, SIG, PUBKEY, "1.9.1"), Ok(()));
        assert_eq!(verify(PAYLOAD, SIG, PUBKEY, "v1.9.1"), Ok(()));
        let mut tampered = PAYLOAD.to_vec();
        tampered[3] ^= 1;
        assert!(matches!(verify(&tampered, SIG, PUBKEY, "1.9.1"), Err(FeedError::Signature(_))));
        // A feed announcing another version for this file.
        assert!(matches!(verify(PAYLOAD, SIG, PUBKEY, "1.9.2"), Err(FeedError::Signature(_))));
        assert!(matches!(verify(PAYLOAD, "garbage", PUBKEY, "1.9.1"), Err(FeedError::Signature(_))));
        assert!(FeedError::Signature(String::new()).message().contains("Signatur"));
    }

    /// A tiny HTTP server: `latest.json` answers per path, `/file` honors `Range`.
    async fn serve(routes: Vec<(&'static str, u16, Vec<u8>)>) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let handle = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let path = req.split_whitespace().nth(1).unwrap_or("/").to_string();
                let range = req
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("range: bytes=")
                            .map(|r| r.trim_end_matches('-').to_string())
                    })
                    .and_then(|r| r.parse::<usize>().ok());
                let (status, body) = routes
                    .iter()
                    .find(|(p, _, _)| *p == path)
                    .map(|(_, s, b)| (*s, b.clone()))
                    .unwrap_or((404, b"Not Found".to_vec()));
                let (status, body) = match range {
                    Some(from) if status == 200 && from <= body.len() => (206, body[from..].to_vec()),
                    _ => (status, body),
                };
                let head =
                    format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            }
        });
        (base, handle)
    }

    fn feed(version: &str, url: &str) -> Vec<u8> {
        format!(r#"{{"version":"{version}","platforms":{{"linux-x86_64":{{"url":"{url}","signature":"{SIG}"}}}}}}"#)
            .into_bytes()
    }

    #[tokio::test]
    async fn fallback_order_skips_failing_sources_and_verifies_the_file() {
        let (base, server) = serve(vec![
            ("/broken/latest.json", 200, b"{not json".to_vec()),
            ("/error/latest.json", 500, vec![]),
            ("/good/latest.json", 200, feed("1.9.1", "file")),
            ("/good/file", 200, PAYLOAD.to_vec()),
        ])
        .await;
        let client = reqwest::Client::new();
        let dead = Source::Url("http://127.0.0.1:9/latest.json".into());
        let missing_dir = Source::Folder(tmp("missing").join("nothing"));
        let order = vec![
            dead.clone(),
            missing_dir.clone(),
            Source::Url(format!("{base}/missing/latest.json")),
            Source::Url(format!("{base}/broken/latest.json")),
            Source::Url(format!("{base}/error/latest.json")),
            Source::Url(format!("{base}/good/latest.json")),
        ];
        let found = fetch(&client, &order).await.unwrap();
        assert_eq!(found.source, order[5]);
        assert_eq!(found.manifest.version, "1.9.1");
        let errors = fetch(&client, &order[..5]).await.unwrap_err();
        let kinds: Vec<_> = errors.iter().map(|(_, e)| e.clone()).collect();
        assert_eq!(kinds[0], FeedError::Connect);
        assert_eq!(kinds[1], FeedError::Missing);
        assert_eq!(kinds[2], FeedError::Missing);
        assert!(matches!(kinds[3], FeedError::Invalid(_)));
        assert_eq!(kinds[4], FeedError::Status(500));

        // The file, relative to the feed, resumed from a part, and checked against the key.
        let entry = platform(&found.manifest, &targets("linux-x86_64", None)).unwrap();
        let at = locate(&found.source, &entry.url);
        let dir = tmp("dl");
        let part = dir.join("update.part");
        std::fs::write(&part, &PAYLOAD[..5]).unwrap();
        let mut seen = vec![];
        let step = download(&client, &at, &part, &AtomicBool::new(false), |d, t| seen.push((d, t))).await.unwrap();
        assert_eq!(step, Step::Done);
        assert_eq!(seen.first(), Some(&(5, Some(PAYLOAD.len() as u64))), "continues at the part's end");
        let bytes = std::fs::read(&part).unwrap();
        assert_eq!(bytes, PAYLOAD);
        assert_eq!(verify(&bytes, &entry.signature, PUBKEY, &found.manifest.version), Ok(()));
        server.abort();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn a_share_folder_is_a_source_and_downloads_pause_and_resume() {
        let share = tmp("share");
        let big: Vec<u8> = (0..(CHUNK * 3 + 17)).map(|i| (i % 251) as u8).collect();
        std::fs::write(share.join("Arcalo.AppImage"), &big).unwrap();
        std::fs::write(share.join(FEED_FILE), feed("2.0.0", "Arcalo.AppImage")).unwrap();
        let client = reqwest::Client::new();
        let found = fetch(&client, &[Source::Folder(share.clone())]).await.unwrap();
        let at = locate(&found.source, &found.manifest.platforms["linux-x86_64"].url);
        assert_eq!(at, Location::File(share.join("Arcalo.AppImage")));
        let part = share.join("dl").join("x.part");
        let pause = AtomicBool::new(true);
        assert_eq!(download(&client, &at, &part, &pause, |_, _| {}).await.unwrap(), Step::Paused);
        let first = std::fs::metadata(&part).unwrap().len();
        assert_eq!(first, CHUNK as u64, "stopped after one chunk");
        pause.store(false, Ordering::SeqCst);
        let mut starts = None;
        download(&client, &at, &part, &pause, |d, _| {
            starts.get_or_insert(d);
        })
        .await
        .unwrap();
        assert_eq!(starts, Some(first));
        assert_eq!(std::fs::read(&part).unwrap(), big);
        let _ = std::fs::remove_dir_all(&share);
    }
}
