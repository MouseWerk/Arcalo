//! Downloads a model file from its sources in order (see [`super::models::sources`]): written to
//! `<file>.part`, resumed with an HTTP range request (or from the same offset of a file on a
//! share) after an interruption, then checked against the fixed size and SHA-256 and only then
//! renamed to its final name. A source that fails or delivers other bytes is skipped; a wrong
//! file is deleted, never used. Blocking file I/O: run it on a thread of its own.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};

use super::models::{ModelInfo, Source};
use crate::error::{Error, IoAt, Result};
use crate::{tr, trf};

/// What is downloaded: the file name and what it must be.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub file: String,
    pub size: u64,
    pub sha256: String,
}

impl From<&ModelInfo> for Target {
    fn from(m: &ModelInfo) -> Self {
        Self { file: m.file.into(), size: m.size, sha256: m.sha256.into() }
    }
}

/// Progress of a download: bytes so far (including a resumed part) and the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Progress {
    pub received: u64,
    pub total: u64,
    pub source: String,
}

/// `ggml-small.bin` → `ggml-small.bin.part`.
pub fn part_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

pub fn cancelled_text() -> &'static str {
    tr!("Download abgebrochen", "Download cancelled")
}

const CHUNK: usize = 256 * 1024;

/// Fetches `target` into `dir` from the first source that delivers the right file; returns its
/// path. `progress` is called for every chunk. Cancelling keeps the part for a later resume.
pub async fn fetch(
    client: &reqwest::Client,
    target: &Target,
    sources: &[Source],
    dir: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(&Progress),
) -> Result<PathBuf> {
    fs::create_dir_all(dir).at(dir)?;
    let dest = dir.join(&target.file);
    if verify(&dest, target)? {
        return Ok(dest);
    }
    let part = part_path(&dest);
    let mut problems: Vec<String> = Vec::new();
    for source in sources {
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::State(cancelled_text().into()));
        }
        let label = source.label();
        let got = match source {
            Source::Url(url) => fetch_url(client, url, target, &part, cancel, &label, &mut progress).await,
            Source::File(path) => copy_file(path, target, &part, cancel, &label, &mut progress),
        };
        if cancel.load(Ordering::Relaxed) {
            return Err(Error::State(cancelled_text().into()));
        }
        match got {
            Ok(()) if verify(&part, target)? => {
                fs::rename(&part, &dest).at(&dest)?;
                return Ok(dest);
            }
            Ok(()) => {
                // Other bytes than the checksum says: never kept, never resumed.
                let _ = fs::remove_file(&part);
                problems.push(trf!("{label}: Prüfsumme stimmt nicht", "{label}: checksum mismatch"));
            }
            Err(e) => problems.push(format!("{label}: {e}")),
        }
    }
    Err(Error::State(trf!(
        "Modell „{}“ nicht geladen.\n{}",
        "Model “{}” not downloaded.\n{}",
        target.file,
        problems.join("\n")
    )))
}

/// Whether `path` is exactly the target (size first, then SHA-256).
pub fn verify(path: &Path, target: &Target) -> Result<bool> {
    match fs::metadata(path) {
        Ok(m) if m.len() == target.size => Ok(sha256_file(path)? == target.sha256),
        _ => Ok(false),
    }
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut f = File::open(path).at(path)?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).at(path)?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Length of the part to resume from (a part longer than the file starts over).
fn resume_from(part: &Path, target: &Target) -> u64 {
    match fs::metadata(part) {
        Ok(m) if m.len() <= target.size => m.len(),
        Ok(_) => {
            let _ = fs::remove_file(part);
            0
        }
        Err(_) => 0,
    }
}

fn open_part(part: &Path, from: u64) -> Result<File> {
    let mut f = OpenOptions::new().create(true).write(true).truncate(false).open(part).at(part)?;
    f.set_len(from).at(part)?;
    f.seek(SeekFrom::Start(from)).at(part)?;
    Ok(f)
}

fn too_large() -> Error {
    Error::State(
        tr!("Die Quelle liefert mehr Daten als erwartet", "The source delivers more data than expected").into(),
    )
}

async fn fetch_url(
    client: &reqwest::Client,
    url: &str,
    target: &Target,
    part: &Path,
    cancel: &AtomicBool,
    label: &str,
    progress: &mut impl FnMut(&Progress),
) -> Result<()> {
    let mut have = resume_from(part, target);
    if have == target.size {
        return Ok(());
    }
    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let mut resp = req.send().await?;
    let status = resp.status();
    // A server that answers a range with its start honours it; anything else starts over.
    let resumed = status == reqwest::StatusCode::PARTIAL_CONTENT
        && resp
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with(&format!("bytes {have}-")));
    if !status.is_success() {
        return Err(Error::State(format!("HTTP {}", status.as_u16())));
    }
    if !resumed {
        have = 0;
    }
    let mut file = open_part(part, have)?;
    progress(&Progress { received: have, total: target.size, source: label.to_owned() });
    while let Some(chunk) = resp.chunk().await? {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        have += chunk.len() as u64;
        if have > target.size {
            drop(file);
            let _ = fs::remove_file(part);
            return Err(too_large());
        }
        file.write_all(&chunk).at(part)?;
        progress(&Progress { received: have, total: target.size, source: label.to_owned() });
    }
    file.flush().at(part)?;
    Ok(())
}

fn copy_file(
    source: &Path,
    target: &Target,
    part: &Path,
    cancel: &AtomicBool,
    label: &str,
    progress: &mut impl FnMut(&Progress),
) -> Result<()> {
    let mut input = File::open(source).at(source)?;
    let len = input.metadata().at(source)?.len();
    if len != target.size {
        return Err(Error::State(trf!("{} statt {} Bytes", "{} instead of {} bytes", len, target.size)));
    }
    let mut have = resume_from(part, target);
    input.seek(SeekFrom::Start(have)).at(source)?;
    let mut file = open_part(part, have)?;
    let mut buf = vec![0u8; CHUNK];
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let n = input.read(&mut buf).at(source)?;
        if n == 0 {
            break;
        }
        have += n as u64;
        if have > target.size {
            return Err(too_large());
        }
        file.write_all(&buf[..n]).at(part)?;
        progress(&Progress { received: have, total: target.size, source: label.to_owned() });
    }
    file.flush().at(part)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A small HTTP server: `routes` maps a path to its body (missing = 404); `Range: bytes=N-`
    /// is honoured when `ranges` is set. Every request is recorded as `path` or `path@range`.
    struct Mock {
        base: String,
        log: Arc<Mutex<Vec<String>>>,
    }

    async fn mock(routes: HashMap<&'static str, Vec<u8>>, ranges: bool) -> Mock {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let log = Arc::new(Mutex::new(Vec::new()));
        let routes = Arc::new(routes);
        let rec = log.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let routes = routes.clone();
                let rec = rec.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let req = String::from_utf8_lossy(&buf[..n]).to_string();
                    let path = req.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let range = req
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("range: bytes=")
                                .map(|r| r.trim_end_matches('-').to_owned())
                        })
                        .and_then(|r| r.parse::<usize>().ok());
                    rec.lock().unwrap().push(match range {
                        Some(r) => format!("{path}@{r}"),
                        None => path.clone(),
                    });
                    let resp = match routes.get(path.as_str()) {
                        None => b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(),
                        Some(body) => match range.filter(|_| ranges) {
                            Some(from) => {
                                let rest = &body[from.min(body.len())..];
                                let mut r = format!(
                                    "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len().saturating_sub(1),
                                    body.len(),
                                    rest.len()
                                )
                                .into_bytes();
                                r.extend_from_slice(rest);
                                r
                            }
                            None => {
                                let mut r = format!(
                                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                    body.len()
                                )
                                .into_bytes();
                                r.extend_from_slice(body);
                                r
                            }
                        },
                    };
                    let _ = sock.write_all(&resp).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Mock { base, log }
    }

    fn client() -> reqwest::Client {
        reqwest::Client::builder().no_proxy().build().unwrap()
    }

    fn model_bytes() -> Vec<u8> {
        (0..600_000u32).map(|i| (i % 251) as u8).collect()
    }

    fn target(bytes: &[u8]) -> Target {
        let sha = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
        Target { file: "ggml-test.bin".into(), size: bytes.len() as u64, sha256: sha }
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("annalo-dl-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[tokio::test]
    async fn falls_back_in_order_and_rejects_a_wrong_checksum() {
        let good = model_bytes();
        let mut bad = good.clone();
        bad[1000] ^= 0xff;
        let server = mock(HashMap::from([("/gh/ggml-test.bin", bad), ("/hf/ggml-test.bin", good.clone())]), true).await;
        let t = target(&good);
        let b = &server.base;
        let sources = [
            Source::Url(format!("{b}/admin/ggml-test.bin")),
            Source::Url(format!("{b}/gh/ggml-test.bin")),
            Source::Url(format!("{b}/hf/ggml-test.bin")),
        ];
        let dir = tmp("order");
        let mut seen = Vec::new();
        let path = fetch(&client(), &t, &sources, &dir, &AtomicBool::new(false), |p| seen.push(p.source.clone()))
            .await
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), good);
        assert!(!part_path(&path).exists());
        assert_eq!(*server.log.lock().unwrap(), ["/admin/ggml-test.bin", "/gh/ggml-test.bin", "/hf/ggml-test.bin"]);
        assert!(seen.last().unwrap().ends_with("/hf/ggml-test.bin"));
        // Present and correct: nothing is fetched again.
        fetch(&client(), &t, &sources, &dir, &AtomicBool::new(false), |_| {}).await.unwrap();
        assert_eq!(server.log.lock().unwrap().len(), 3);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn only_wrong_files_is_an_error_and_nothing_is_kept() {
        let good = model_bytes();
        let server = mock(HashMap::from([("/m/ggml-test.bin", vec![7u8; good.len()])]), true).await;
        let dir = tmp("wrong");
        let err = fetch(
            &client(),
            &target(&good),
            &[
                Source::Url(format!("{}/m/ggml-test.bin", server.base)),
                Source::Url(format!("{}/x/ggml-test.bin", server.base)),
            ],
            &dir,
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap_err()
        .to_string();
        assert!(err.contains("Prüfsumme stimmt nicht"), "{err}");
        assert!(err.contains("HTTP 404"), "{err}");
        assert!(fs::read_dir(&dir).unwrap().next().is_none(), "no file and no part left");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn resumes_an_interrupted_download_with_a_range_request() {
        let good = model_bytes();
        let t = target(&good);
        let dir = tmp("resume");
        fs::write(part_path(&dir.join(&t.file)), &good[..250_000]).unwrap();
        let server = mock(HashMap::from([("/m/ggml-test.bin", good.clone())]), true).await;
        let mut first = None;
        let path = fetch(
            &client(),
            &t,
            &[Source::Url(format!("{}/m/ggml-test.bin", server.base))],
            &dir,
            &AtomicBool::new(false),
            |p| {
                first.get_or_insert(p.received);
            },
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), good);
        assert_eq!(*server.log.lock().unwrap(), ["/m/ggml-test.bin@250000"]);
        assert_eq!(first, Some(250_000));

        // A server without range support sends everything again: the part starts over.
        fs::remove_file(&path).unwrap();
        fs::write(part_path(&path), &good[..100]).unwrap();
        let plain = mock(HashMap::from([("/m/ggml-test.bin", good.clone())]), false).await;
        let path = fetch(
            &client(),
            &t,
            &[Source::Url(format!("{}/m/ggml-test.bin", plain.base))],
            &dir,
            &AtomicBool::new(false),
            |_| {},
        )
        .await
        .unwrap();
        assert_eq!(fs::read(&path).unwrap(), good);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn copies_from_a_folder_and_keeps_the_part_when_cancelled() {
        let good = model_bytes();
        let t = target(&good);
        let share = tmp("share");
        fs::write(share.join("ggml-test.bin"), &good).unwrap();
        let dir = tmp("folder");
        // Cancelled: the part stays for a resume.
        fs::write(part_path(&dir.join(&t.file)), &good[..1000]).unwrap();
        let err =
            fetch(&client(), &t, &[Source::File(share.join("ggml-test.bin"))], &dir, &AtomicBool::new(true), |_| {})
                .await
                .unwrap_err();
        assert_eq!(err.to_string(), cancelled_text());
        assert_eq!(fs::metadata(part_path(&dir.join(&t.file))).unwrap().len(), 1000);
        let path =
            fetch(&client(), &t, &[Source::File(share.join("ggml-test.bin"))], &dir, &AtomicBool::new(false), |_| {})
                .await
                .unwrap();
        assert_eq!(fs::read(&path).unwrap(), good);
        // A file of the wrong size on the share is refused before copying.
        fs::write(share.join("ggml-test.bin"), b"short").unwrap();
        fs::remove_file(&path).unwrap();
        let err =
            fetch(&client(), &t, &[Source::File(share.join("ggml-test.bin"))], &dir, &AtomicBool::new(false), |_| {})
                .await
                .unwrap_err()
                .to_string();
        assert!(err.contains("5 statt 600000 Bytes"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
        fs::remove_dir_all(&share).unwrap();
    }
}
