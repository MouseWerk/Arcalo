//! Backup destinations: further folders that receive a copy of every local backup – a network
//! share (`\\server\freigabe\Annalo`), a mapped drive (`Z:\Sicherung`), a mounted NAS
//! (`/Volumes/…`, `/mnt/…`) or a synced cloud folder (OneDrive, Nextcloud).
//!
//! The backup is always written locally first ([`crate::backup`]); the copies follow in the
//! background. A copy is written as `<name>.partial`, flushed to the disk, checked for its size
//! and only then renamed, with the SHA-256 checksum next to it (`<name>.sha256`, the format of
//! `sha256sum`). A half-written file therefore never looks like a backup, and a synced cloud
//! folder only ever uploads complete files.
//!
//! Each computer writes into its own subfolder (`<ziel>/<rechnername>/`), so two installations
//! sharing one folder never prune each other's backups. Pruning only touches files that match
//! `annalo-YYYYMMDD-HHMMSS.db` and have their checksum file: other files in the folder are
//! never deleted.
//!
//! A share that stops answering (VPN off, server down) can block a file operation for minutes.
//! Copies therefore run on threads of their own, watched by [`run_watched`]: when a copy makes
//! no progress for a while it is given up (the thread is left behind and stops at its next
//! step), so neither the app, other destinations nor quitting ever wait for a hung share.
//! Failed destinations stay pending and are tried again with a growing pause ([`backoff`]);
//! a warning is only due after a day or three missed backups ([`DestState::should_warn`]).

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use chrono::{DateTime, Local, NaiveDateTime, TimeDelta, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::backup::{self, BackupInfo};
use crate::error::{Error, IoAt, Result};

/// Suffix of a copy that is still being written.
pub const PARTIAL: &str = ".partial";
/// Suffix of the checksum file next to a copied backup.
pub const SUM: &str = ".sha256";
/// Status and destinations for the start-up recovery, in the data folder (readable without the database).
pub const REGISTRY_FILE: &str = "backup-destinations.json";
/// A backup chosen for restoring, put in place at the next start ([`apply_pending_restore`]).
pub const PENDING_RESTORE: &str = "restore-pending.db";
/// Most destinations one workspace may have.
pub const MAX_DESTINATIONS: usize = 8;
/// Pause after which a copy without progress is given up.
pub const STALL: Duration = Duration::from_secs(60);
/// Longest wait for listing the backups of one destination.
pub const LIST_TIMEOUT: Duration = Duration::from_secs(8);

const STAMP: &str = "%Y%m%d-%H%M%S";
const CHUNK: usize = 1 << 20;

// ------------------------------------------------------------------ settings

/// One further folder for backups (Settings → Sicherung → „Weitere Sicherungsziele“).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Destination {
    /// Stable id (derived from the path when empty).
    pub id: String,
    /// Folder as the user entered it (UNC paths keep their backslashes).
    pub path: String,
    pub enabled: bool,
    /// Backups kept in the destination (1–365).
    pub keep: usize,
    /// Backups older than this many days are deleted as well; 0 = only `keep` counts.
    pub keep_days: u32,
    /// Also copy the attachments folder (images, drawings, files), incrementally.
    pub attachments: bool,
    /// Also copy the Markdown copy (only when it is switched on).
    pub markdown: bool,
}

impl Default for Destination {
    fn default() -> Self {
        Destination {
            id: String::new(),
            path: String::new(),
            enabled: true,
            keep: 14,
            keep_days: 0,
            attachments: true,
            markdown: false,
        }
    }
}

/// All destinations of the workspace.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BackupTargets {
    pub destinations: Vec<Destination>,
    /// The destinations replace the local folder: once every switched-on destination has the
    /// newest backup, the local folder keeps only that one.
    pub local_latest_only: bool,
}

impl BackupTargets {
    /// Trims paths, drops empty and duplicate ones, fills ids and clamps the numbers.
    pub fn normalize(&mut self) {
        let mut seen: Vec<String> = Vec::new();
        let mut out = Vec::new();
        for mut d in std::mem::take(&mut self.destinations) {
            d.path = d.path.trim().to_owned();
            let key = same_path_key(&d.path);
            if d.path.is_empty() || seen.contains(&key) || out.len() >= MAX_DESTINATIONS {
                continue;
            }
            seen.push(key);
            d.id = d.id.trim().to_owned();
            if d.id.is_empty() || out.iter().any(|o: &Destination| o.id == d.id) {
                d.id = id_for(&d.path);
            }
            d.keep = d.keep.clamp(1, 365);
            d.keep_days = d.keep_days.min(3650);
            out.push(d);
        }
        self.destinations = out;
    }

    pub fn enabled(&self) -> impl Iterator<Item = &Destination> {
        self.destinations.iter().filter(|d| d.enabled)
    }
}

/// Paths that name the same folder compare equal: separators and case do not matter.
fn same_path_key(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_lowercase()
}

/// Id of a new destination: a short hash of its path.
pub fn id_for(path: &str) -> String {
    let hash = Sha256::digest(same_path_key(path).as_bytes());
    format!("d{}", hash.iter().take(5).map(|b| format!("{b:02x}")).collect::<String>())
}

// ------------------------------------------------------------------ paths

/// What kind of folder a destination is (for the label and the hints in the settings).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PathKind {
    /// A Windows share: `\\server\freigabe\…`.
    Unc,
    /// A Windows drive letter (local or mapped network drive).
    Drive,
    /// A mounted volume or share on macOS or Linux (`/Volumes`, `/mnt`, `/media`, gvfs, …).
    Mount,
    /// A folder kept in sync by a cloud client (OneDrive, Nextcloud, Dropbox, …).
    Cloud,
    /// Any other folder.
    Local,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PathInfo {
    pub kind: PathKind,
    /// Server and share of a UNC path.
    pub server: Option<String>,
    pub share: Option<String>,
    /// Name of the cloud client of a synced folder.
    pub cloud: Option<String>,
}

const CLOUDS: [(&str, &str); 9] = [
    ("onedrive", "OneDrive"),
    ("nextcloud", "Nextcloud"),
    ("owncloud", "ownCloud"),
    ("dropbox", "Dropbox"),
    ("icloud", "iCloud Drive"),
    ("mobile documents", "iCloud Drive"),
    ("google drive", "Google Drive"),
    ("seafile", "Seafile"),
    ("pcloud", "pCloud"),
];

/// Classifies a destination path by its text only (works for Windows paths on every system,
/// so it can be tested anywhere).
pub fn describe(path: &str) -> PathInfo {
    let p = path.trim();
    let mut info = PathInfo { kind: PathKind::Local, server: None, share: None, cloud: None };
    if let Some((server, share)) = unc_parts(p) {
        info.kind = PathKind::Unc;
        info.server = Some(server);
        info.share = Some(share);
    } else if is_drive_path(p) {
        info.kind = PathKind::Drive;
    } else {
        let lower = p.to_lowercase();
        let mounts = ["/volumes/", "/mnt/", "/media/", "/run/media/", "/net/", "/smb/", "/nfs/", "/gvfs/"];
        if mounts.iter().any(|m| lower.starts_with(m)) || lower.contains("/gvfs/") {
            info.kind = PathKind::Mount;
        }
    }
    let lower = p.replace('\\', "/").to_lowercase();
    if let Some((_, name)) = CLOUDS.iter().find(|(needle, _)| lower.split('/').any(|seg| seg.contains(needle))) {
        info.cloud = Some((*name).to_owned());
        if info.kind != PathKind::Unc {
            info.kind = PathKind::Cloud;
        }
    }
    info
}

/// Server and share of `\\server\share\…`, `//server/share/…` or `\\?\UNC\server\share\…`.
pub fn unc_parts(path: &str) -> Option<(String, String)> {
    let p = path.replace('/', "\\");
    let rest = p.strip_prefix(r"\\?\UNC\").or_else(|| p.strip_prefix(r"\\").filter(|r| !r.starts_with("?\\")))?;
    let mut parts = rest.split('\\').filter(|s| !s.is_empty());
    let server = parts.next()?.to_owned();
    let share = parts.next()?.to_owned();
    Some((server, share))
}

/// `C:\…` or `Z:/…`.
fn is_drive_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

/// The extended-length form of a Windows path (`\\?\C:\…`, `\\?\UNC\server\share\…`), which
/// lifts the limit of 260 characters. Other paths are returned as they are.
pub fn extended_path(path: &str) -> String {
    if path.starts_with(r"\\?\") {
        return path.to_owned();
    }
    let p = path.replace('/', "\\");
    if let Some(rest) = p.strip_prefix(r"\\") {
        return format!(r"\\?\UNC\{rest}");
    }
    if is_drive_path(&p) {
        return format!(r"\\?\{p}");
    }
    path.to_owned()
}

/// The path handed to the file system: on Windows, long paths get the extended-length form.
pub fn os_path(path: &Path) -> PathBuf {
    if cfg!(windows) && path.as_os_str().len() > 240 {
        let text = path.display().to_string();
        return PathBuf::from(extended_path(&text));
    }
    path.to_path_buf()
}

/// Checks a destination entered by the user: absolute, and not a UNC path where the system
/// cannot open one. An error carries [`Problem::Invalid`].
pub fn validate(path: &str) -> std::result::Result<PathBuf, Failure> {
    let p = path.trim();
    if p.is_empty() {
        return Err(Failure::new(Problem::Invalid, "Kein Ordner angegeben", p));
    }
    if unc_parts(p).is_some() && !cfg!(windows) {
        return Err(Failure::new(
            Problem::UncUnsupported,
            "Netzwerkpfade wie \\\\server\\freigabe gibt es nur unter Windows. Die Freigabe zuerst verbinden \
             (macOS: Finder → „Mit Server verbinden“, dann /Volumes/…; Linux: einhängen, z. B. unter /mnt/…) und \
             diesen Ordner wählen.",
            p,
        ));
    }
    if (p.starts_with("\\\\") || p.starts_with("//")) && unc_parts(p).is_none() {
        return Err(Failure::new(Problem::Invalid, "Unvollständiger Netzwerkpfad: \\\\server\\freigabe\\Ordner", p));
    }
    let path = PathBuf::from(p);
    if !path.is_absolute() {
        return Err(Failure::new(Problem::Invalid, "Bitte einen vollständigen Ordnerpfad angeben", p));
    }
    Ok(path)
}

/// This computer's subfolder name in a shared destination.
pub fn host_folder(host: &str) -> String {
    let h = crate::gitsync::sanitize_host(host);
    if h.is_empty() { "annalo".to_owned() } else { h }
}

// ------------------------------------------------------------------ errors

/// Why a destination failed; the UI shows its own text per kind (German or English).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    /// The folder or share is not there (offline, VPN off, drive not mounted).
    Unreachable,
    /// Access denied: the share wants a login or the user lacks the right.
    Denied,
    ReadOnly,
    Full,
    /// No progress for too long.
    Timeout,
    /// The copy has the wrong size or checksum.
    Checksum,
    /// The previous copy to this destination still hangs.
    Busy,
    /// Not a usable folder path.
    Invalid,
    /// A UNC path on macOS or Linux.
    UncUnsupported,
    Other,
}

/// A failed destination operation: the kind, the German text (log, fallback) and the path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Failure {
    pub problem: Problem,
    pub message: String,
    pub path: String,
}

impl Failure {
    pub fn new(problem: Problem, message: impl Into<String>, path: impl Into<String>) -> Self {
        Failure { problem, message: message.into(), path: path.into() }
    }

    /// `e` as a failure; the path is the one the error names, else `path`.
    pub fn of(e: &Error, path: &Path) -> Self {
        let at = if let Error::File { path, .. } = e { path } else { path };
        Failure::new(classify(e), e.to_string(), at.display().to_string())
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// The kind of an I/O error on a destination.
pub fn classify(e: &Error) -> Problem {
    let io = match e {
        Error::File { source, .. } | Error::Io(source) => source,
        _ => return Problem::Other,
    };
    classify_io(io)
}

pub fn classify_io(e: &std::io::Error) -> Problem {
    use std::io::ErrorKind as K;
    if cfg!(windows)
        && let Some(code) = e.raw_os_error()
    {
        // Windows system error codes of shares and drives.
        match code {
            5 | 86 | 1244 | 1326 | 1327 | 1331 | 1909 => return Problem::Denied,
            19 => return Problem::ReadOnly,
            39 | 112 => return Problem::Full,
            121 | 1460 => return Problem::Timeout,
            3 | 15 | 21 | 51 | 53 | 54 | 55 | 59 | 64 | 67 | 1203 | 1222 | 1231 | 1311 | 2250 => {
                return Problem::Unreachable;
            }
            _ => {}
        }
    }
    match e.kind() {
        K::PermissionDenied => Problem::Denied,
        K::ReadOnlyFilesystem => Problem::ReadOnly,
        K::StorageFull | K::QuotaExceeded => Problem::Full,
        K::TimedOut => Problem::Timeout,
        K::NotFound
        | K::NetworkUnreachable
        | K::HostUnreachable
        | K::NetworkDown
        | K::NotConnected
        | K::ConnectionReset
        | K::ConnectionAborted
        | K::StaleNetworkFileHandle => Problem::Unreachable,
        K::InvalidFilename | K::NotADirectory => Problem::Invalid,
        _ => Problem::Other,
    }
}

// ------------------------------------------------------------------ progress and watchdog

/// Called before every step of a copy with the path it is about to touch (tests slow a
/// destination down with it).
pub type Hook = Arc<dyn Fn(&Path) + Send + Sync>;

/// Progress of one running copy, shared with its watchdog.
pub struct Activity {
    start: Instant,
    /// Milliseconds since `start` of the last step.
    last: AtomicU64,
    bytes: AtomicU64,
    cancelled: AtomicBool,
    hook: Option<Hook>,
}

impl Activity {
    pub fn new(hook: Option<Hook>) -> Arc<Self> {
        Arc::new(Activity {
            start: Instant::now(),
            last: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            cancelled: AtomicBool::new(false),
            hook,
        })
    }

    /// One step is about to touch `path`: records progress, and stops a copy that was given up.
    pub fn step(&self, path: &Path) -> Result<()> {
        if let Some(hook) = &self.hook {
            hook(path);
        }
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(Error::file(path, std::io::Error::from(std::io::ErrorKind::TimedOut)));
        }
        self.last.store(self.start.elapsed().as_millis() as u64, Ordering::Relaxed);
        Ok(())
    }

    fn add_bytes(&self, n: u64) {
        self.bytes.fetch_add(n, Ordering::Relaxed);
    }

    pub fn bytes(&self) -> u64 {
        self.bytes.load(Ordering::Relaxed)
    }

    fn idle(&self) -> Duration {
        let now = self.start.elapsed().as_millis() as u64;
        Duration::from_millis(now.saturating_sub(self.last.load(Ordering::Relaxed)))
    }
}

/// Runs `work` on a thread of its own and waits while it makes progress. When it has not
/// reported a step ([`Activity::step`]) for `stall`, the wait ends with a timeout for `path`;
/// the thread is left behind (it may hang in the operating system) and ends at its next step.
pub fn run_watched<T: Send + 'static>(
    path: &Path,
    stall: Duration,
    activity: Arc<Activity>,
    work: impl FnOnce(&Activity) -> std::result::Result<T, Failure> + Send + 'static,
) -> std::result::Result<T, Failure> {
    let (tx, rx) = std::sync::mpsc::channel();
    let act = activity.clone();
    let spawned = std::thread::Builder::new().name("annalo-backup-copy".into()).spawn(move || {
        let _ = tx.send(work(&act));
    });
    if let Err(e) = spawned {
        return Err(Failure::new(Problem::Other, e.to_string(), path.display().to_string()));
    }
    let poll = (stall / 4).clamp(Duration::from_millis(20), Duration::from_millis(250));
    loop {
        match rx.recv_timeout(poll) {
            Ok(res) => return res,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Failure::new(Problem::Other, "Kopiervorgang abgebrochen", path.display().to_string()));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) if activity.idle() >= stall => {
                activity.cancelled.store(true, Ordering::Relaxed);
                let secs = stall.as_secs().max(1);
                return Err(Failure::new(
                    Problem::Timeout,
                    format!("Zeitüberschreitung bei {} (seit {secs} s keine Antwort)", path.display()),
                    path.display().to_string(),
                ));
            }
            Err(_) => {}
        }
    }
}

/// Runs `f` on a thread of its own and waits at most `timeout` for it (`None`: no answer in time).
pub fn with_timeout<T: Send + 'static>(timeout: Duration, f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .name("annalo-backup-probe".into())
        .spawn(move || {
            let _ = tx.send(f());
        })
        .ok()?;
    rx.recv_timeout(timeout).ok()
}

// ------------------------------------------------------------------ copying

/// Copies `from` to `to` in chunks (reporting progress) and flushes it to the disk. Returns the
/// size and the SHA-256 checksum of what was read.
pub fn copy_hashed(from: &Path, to: &Path, act: &Activity) -> Result<(u64, String)> {
    act.step(to)?;
    let mut src = fs::File::open(os_path(from)).at(from)?;
    let mut dst = fs::File::create(os_path(to)).at(to)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    let mut total = 0u64;
    loop {
        let n = src.read(&mut buf).at(from)?;
        if n == 0 {
            break;
        }
        act.step(to)?;
        hasher.update(&buf[..n]);
        dst.write_all(&buf[..n]).at(to)?;
        total += n as u64;
        act.add_bytes(n as u64);
    }
    act.step(to)?;
    dst.flush().at(to)?;
    sync_file(&dst, to)?;
    Ok((total, format!("{:x}", hasher.finalize())))
}

/// `fsync`; shares and file systems that do not support it are accepted as they are.
fn sync_file(f: &fs::File, path: &Path) -> Result<()> {
    match f.sync_all() {
        Ok(()) => Ok(()),
        Err(e) if matches!(e.kind(), std::io::ErrorKind::Unsupported | std::io::ErrorKind::InvalidInput) => Ok(()),
        Err(e) => Err(Error::file(path, e)),
    }
}

/// SHA-256 of a file, hex.
pub fn file_sha256(path: &Path) -> Result<String> {
    let mut f = fs::File::open(os_path(path)).at(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; CHUNK];
    loop {
        let n = f.read(&mut buf).at(path)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// The checksum file of `backup`: `<name>.sha256`.
pub fn sum_path(backup: &Path) -> PathBuf {
    PathBuf::from(format!("{}{SUM}", backup.display()))
}

/// The checksum recorded next to `backup`, if there is one.
pub fn read_sum(backup: &Path) -> Option<String> {
    let text = fs::read_to_string(os_path(&sum_path(backup))).ok()?;
    let hex = text.split_whitespace().next()?.to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

/// Renames `from` to `to`, replacing `to` (Windows does not replace on rename).
fn replace(from: &Path, to: &Path) -> Result<()> {
    if cfg!(windows) && to.exists() {
        fs::remove_file(os_path(to)).at(to)?;
    }
    fs::rename(os_path(from), os_path(to)).at(to)
}

/// What one copy to a destination did.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Delivered {
    pub file: String,
    /// The backup's path in the destination.
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub ms: u64,
    /// Old backups deleted by the retention.
    pub removed: Vec<String>,
    /// Attachment files copied (new or changed).
    pub attachments: usize,
}

/// One copy to do: the local backup and the destination.
pub struct Job {
    /// The local backup file (`annalo-….db`).
    pub backup: PathBuf,
    /// The destination folder as configured.
    pub dest: PathBuf,
    /// This computer's name (the subfolder is [`host_folder`] of it).
    pub host: String,
    pub keep: usize,
    pub keep_days: u32,
    /// The attachments folder, when it is copied along.
    pub attachments: Option<PathBuf>,
    /// The Markdown copy, when it is copied along.
    pub markdown: Option<PathBuf>,
    /// The destination worked before: when its folder is missing now the share is offline,
    /// and the folder is not created again (that would write onto the local disk below an
    /// unmounted mount point).
    pub reached_before: bool,
    pub now: DateTime<Utc>,
}

/// Makes sure the destination folder is there without creating a missing share or mount: the
/// folder itself may be created (the first time), its parent must exist.
pub fn ensure_dest(dest: &Path, reached_before: bool, act: &Activity) -> Result<()> {
    act.step(dest)?;
    match fs::metadata(os_path(dest)) {
        Ok(m) if m.is_dir() => return Ok(()),
        Ok(_) => return Err(Error::file(dest, std::io::Error::from(std::io::ErrorKind::NotADirectory))),
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(Error::file(dest, e)),
        Err(_) => {}
    }
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty());
    let parent_ok = parent.is_some_and(|p| fs::metadata(os_path(p)).is_ok_and(|m| m.is_dir()));
    if reached_before || !parent_ok {
        return Err(Error::File { path: dest.to_path_buf(), dir: true, source: std::io::ErrorKind::NotFound.into() });
    }
    act.step(dest)?;
    fs::create_dir(os_path(dest)).or_else(|e| if dest.is_dir() { Ok(()) } else { Err(e) }).at(dest)
}

/// Copies the backup of `job` into the destination (see the module docs), then the
/// attachments and the Markdown copy, and prunes old backups of this computer there.
pub fn deliver(job: &Job, act: &Activity) -> std::result::Result<Delivered, Failure> {
    let started = Instant::now();
    let fail = |e: Error| Failure::of(&e, &job.dest);
    ensure_dest(&job.dest, job.reached_before, act).map_err(fail)?;
    let dir = job.dest.join(host_folder(&job.host));
    act.step(&dir).map_err(fail)?;
    fs::create_dir_all(os_path(&dir)).at(&dir).map_err(fail)?;
    let name = job
        .backup
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| {
            Failure::new(Problem::Invalid, "Ungültiger Name der Sicherung", job.backup.display().to_string())
        })?
        .to_owned();
    let size = fs::metadata(&job.backup).at(&job.backup).map_err(fail)?.len();
    let target = dir.join(&name);
    let part = dir.join(format!("{name}{PARTIAL}"));
    let copied = copy_hashed(&job.backup, &part, act);
    let (bytes, sha) = match copied {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(os_path(&part));
            return Err(fail(e));
        }
    };
    act.step(&part).map_err(fail)?;
    let written = fs::metadata(os_path(&part)).at(&part).map_err(fail)?.len();
    if written != size || bytes != size {
        let _ = fs::remove_file(os_path(&part));
        return Err(Failure::new(
            Problem::Checksum,
            format!("Die Kopie ist unvollständig ({written} von {size} Bytes): {}", target.display()),
            target.display().to_string(),
        ));
    }
    // The checksum first: a backup without it is not taken as one of ours (and never pruned).
    let sum = sum_path(&target);
    let sum_part = PathBuf::from(format!("{}{PARTIAL}", sum.display()));
    let write_sum = || -> Result<()> {
        act.step(&sum)?;
        let mut f = fs::File::create(os_path(&sum_part)).at(&sum_part)?;
        f.write_all(format!("{sha}  {name}\n").as_bytes()).at(&sum_part)?;
        sync_file(&f, &sum_part)?;
        drop(f);
        replace(&sum_part, &sum)
    };
    write_sum().map_err(fail)?;
    act.step(&target).map_err(fail)?;
    replace(&part, &target).map_err(fail)?;
    let mut attachments = 0;
    if let Some(src) = job.attachments.as_deref().filter(|p| p.is_dir()) {
        attachments = sync_files(src, &dir.join(crate::attachments::DIR_NAME), act).map_err(fail)?;
    }
    if let Some(src) = job.markdown.as_deref().filter(|p| p.is_dir()) {
        sync_tree(src, &dir.join("markdown"), act).map_err(fail)?;
    }
    let removed = prune(&dir, job.keep, job.keep_days, job.now, &name, act).map_err(fail)?;
    Ok(Delivered {
        file: name,
        path: target.display().to_string(),
        bytes,
        sha256: sha,
        ms: started.elapsed().as_millis() as u64,
        removed,
        attachments,
    })
}

/// Copies the regular, visible files of `src` that are missing in `dst` or differ in size or
/// are newer (a drawing saved again). Each file is written as `.<name>.partial` and renamed.
/// Nothing in `dst` is deleted. Returns the number of files copied.
pub fn sync_files(src: &Path, dst: &Path, act: &Activity) -> Result<usize> {
    act.step(dst)?;
    fs::create_dir_all(os_path(dst)).at(dst)?;
    let mut copied = 0;
    for entry in fs::read_dir(src).at(src)?.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        if name_str.starts_with('.') || !ft.is_file() {
            continue;
        }
        let from = entry.path();
        let to = dst.join(&name);
        act.step(&to)?;
        if !differs(&from, &to) {
            continue;
        }
        let tmp = dst.join(format!(".{name_str}{PARTIAL}"));
        let res = copy_hashed(&from, &tmp, act).and_then(|_| replace(&tmp, &to));
        if let Err(e) = res {
            let _ = fs::remove_file(os_path(&tmp));
            return Err(e);
        }
        copied += 1;
    }
    Ok(copied)
}

/// Whether `to` is missing or older than `from` or of another size.
fn differs(from: &Path, to: &Path) -> bool {
    let (Ok(a), Ok(b)) = (fs::metadata(from), fs::metadata(os_path(to))) else { return true };
    if a.len() != b.len() {
        return true;
    }
    match (a.modified(), b.modified()) {
        (Ok(src), Ok(dst)) => src > dst,
        _ => false,
    }
}

/// Makes `dst` a copy of the folder tree `src`: new and changed files are copied, files and
/// folders that are no longer in `src` are deleted – only inside `dst`, which belongs to Annalo.
pub fn sync_tree(src: &Path, dst: &Path, act: &Activity) -> Result<()> {
    sync_files(src, dst, act)?;
    let mut keep = std::collections::HashSet::new();
    for entry in fs::read_dir(src).at(src)?.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        keep.insert(name.clone());
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            sync_tree(&entry.path(), &dst.join(&name), act)?;
        }
    }
    for entry in fs::read_dir(os_path(dst)).at(dst)?.flatten() {
        let name = entry.file_name();
        if keep.contains(&name) || name.to_string_lossy().starts_with('.') {
            continue;
        }
        act.step(&entry.path())?;
        let gone = if entry.file_type().is_ok_and(|t| t.is_dir()) {
            fs::remove_dir_all(entry.path())
        } else {
            fs::remove_file(entry.path())
        };
        gone.at(entry.path())?;
    }
    Ok(())
}

/// Parses `annalo-YYYYMMDD-HHMMSS.db` (UTC).
fn stamp_of(name: &str) -> Option<NaiveDateTime> {
    let stamp = name.strip_prefix("annalo-")?.strip_suffix(".db")?;
    NaiveDateTime::parse_from_str(stamp, STAMP).ok().filter(|_| stamp.len() == 15)
}

/// Deletes old backups in one computer's folder `dir`: beyond the newest `keep` and (with
/// `keep_days`) older than that many days. Only Annalo's own files are touched: names of the
/// form `annalo-YYYYMMDD-HHMMSS.db` with their `.sha256` next to them. `fresh` (the backup just
/// written) always stays. Left-over `.partial` files of such names older than a day go too.
pub fn prune(
    dir: &Path,
    keep: usize,
    keep_days: u32,
    now: DateTime<Utc>,
    fresh: &str,
    act: &Activity,
) -> Result<Vec<String>> {
    act.step(dir)?;
    let mut ours: Vec<(String, NaiveDateTime)> = Vec::new();
    let mut stale = Vec::new();
    let day_ago = std::time::SystemTime::now() - Duration::from_secs(24 * 3600);
    for entry in fs::read_dir(os_path(dir)).at(dir)?.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        if let Some(base) = name.strip_suffix(PARTIAL) {
            let base = base.strip_suffix(SUM).unwrap_or(base);
            let base = base.strip_prefix('.').unwrap_or(base);
            let old = entry.metadata().and_then(|m| m.modified()).is_ok_and(|t| t < day_ago);
            if stamp_of(base).is_some() && old {
                stale.push(entry.path());
            }
            continue;
        }
        if let Some(t) = stamp_of(&name)
            && dir.join(format!("{name}{SUM}")).is_file()
        {
            ours.push((name, t));
        }
    }
    ours.sort_by(|a, b| b.0.cmp(&a.0));
    let cutoff = (keep_days > 0).then(|| now.naive_utc() - TimeDelta::days(keep_days as i64));
    let mut removed = Vec::new();
    let mut kept = 0;
    for (name, t) in ours {
        let too_old = cutoff.is_some_and(|c| t < c);
        if name == fresh || (kept < keep.max(1) && !too_old) {
            kept += 1;
            continue;
        }
        let path = dir.join(&name);
        act.step(&path)?;
        fs::remove_file(os_path(&path)).at(&path)?;
        let _ = fs::remove_file(os_path(&sum_path(&path)));
        removed.push(name);
    }
    for path in stale {
        let _ = fs::remove_file(os_path(&path));
    }
    Ok(removed)
}

// ------------------------------------------------------------------ probing

/// Result of „Jetzt testen“.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Probe {
    pub path: String,
    pub info: PathInfo,
    /// Milliseconds for writing (with flush), reading back and deleting the probe file.
    pub write_ms: u64,
    pub delete_ms: u64,
    pub bytes: u64,
    /// Whether this computer's subfolder already holds backups.
    pub existing: usize,
}

/// Writes a probe file of 256 KiB into `dest`, reads it back and deletes it. Creates `dest`
/// when its parent exists (never a missing share or mount point).
pub fn probe(dest: &Path, host: &str, act: &Activity) -> std::result::Result<Probe, Failure> {
    let fail = |e: Error| Failure::of(&e, dest);
    ensure_dest(dest, false, act).map_err(fail)?;
    let file = dest.join(format!(".annalo-probe-{}-{}", host_folder(host), std::process::id()));
    let data: Vec<u8> = (0..256 * 1024u32).map(|i| (i % 251) as u8).collect();
    let t = Instant::now();
    let write = || -> Result<()> {
        act.step(&file)?;
        let mut f = fs::File::create(os_path(&file)).at(&file)?;
        f.write_all(&data).at(&file)?;
        sync_file(&f, &file)?;
        drop(f);
        act.step(&file)?;
        let back = fs::read(os_path(&file)).at(&file)?;
        if back != data {
            return Err(Error::file(&file, std::io::ErrorKind::InvalidData.into()));
        }
        Ok(())
    };
    let written = write();
    let write_ms = t.elapsed().as_millis() as u64;
    let t = Instant::now();
    let removed = act.step(&file).and_then(|_| fs::remove_file(os_path(&file)).at(&file));
    let delete_ms = t.elapsed().as_millis() as u64;
    if let Err(e) = written {
        let _ = fs::remove_file(os_path(&file));
        return Err(fail(e));
    }
    removed.map_err(fail)?;
    let existing = list_own(&dest.join(host_folder(host))).len();
    Ok(Probe {
        path: dest.display().to_string(),
        info: describe(&dest.display().to_string()),
        write_ms,
        delete_ms,
        bytes: data.len() as u64,
        existing,
    })
}

// ------------------------------------------------------------------ listing and restoring

/// A backup in a destination.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteBackup {
    #[serde(flatten)]
    pub info: BackupInfo,
    /// The computer that wrote it (its subfolder).
    pub host: String,
    /// Whether the checksum file is there.
    pub has_sum: bool,
}

/// Complete backups in one computer's folder, newest first.
fn list_own(dir: &Path) -> Vec<BackupInfo> {
    backup::list_backups(&os_path(dir)).unwrap_or_default()
}

/// Backups of every computer in destination `dest`, newest first.
pub fn list_remote(dest: &Path) -> Result<Vec<RemoteBackup>> {
    let mut out = Vec::new();
    for entry in fs::read_dir(os_path(dest)).at(dest)?.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let host = entry.file_name().to_string_lossy().into_owned();
        if host.starts_with('.') {
            continue;
        }
        for mut info in list_own(&entry.path()) {
            info.path = dest.join(&host).join(&info.file_name).display().to_string();
            let has_sum = sum_path(Path::new(&info.path)).is_file();
            out.push(RemoteBackup { info, host: host.clone(), has_sum });
        }
    }
    out.sort_by(|a, b| b.info.created_at.cmp(&a.info.created_at));
    Ok(out)
}

/// Copies `backup` to `to` (through `<to>.partial`), checks its checksum when one was recorded
/// and that it is an intact SQLite database. Returns whether a checksum was verified.
pub fn fetch_verified(backup: &Path, to: &Path, act: &Activity) -> std::result::Result<bool, Failure> {
    let fail = |e: Error| Failure::of(&e, backup);
    let part = PathBuf::from(format!("{}{PARTIAL}", to.display()));
    let expected = read_sum(backup);
    let res = (|| {
        let (_, sha) = copy_hashed(backup, &part, act).map_err(fail)?;
        if let Some(want) = &expected
            && *want != sha
        {
            return Err(Failure::new(
                Problem::Checksum,
                format!("Die Prüfsumme der Sicherung stimmt nicht – die Datei ist beschädigt: {}", backup.display()),
                backup.display().to_string(),
            ));
        }
        check_sqlite(&part)
            .map_err(|e| Failure::new(Problem::Checksum, e.to_string(), backup.display().to_string()))?;
        replace(&part, to).map_err(fail)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&part);
    }
    res.map(|()| expected.is_some())
}

/// Whether `path` is an intact SQLite database (`PRAGMA quick_check`).
pub fn check_sqlite(path: &Path) -> Result<()> {
    use rusqlite::{Connection, OpenFlags};
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let res: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
    if res != "ok" {
        return Err(Error::State(format!("Die Sicherung ist beschädigt ({res}): {}", path.display())));
    }
    Ok(())
}

/// Copies `backup` into the data folder as [`PENDING_RESTORE`] (verified); the next start puts
/// it in place of the database ([`apply_pending_restore`]).
pub fn stage_restore(backup: &Path, data_dir: &Path, act: &Activity) -> std::result::Result<bool, Failure> {
    let verified = fetch_verified(backup, &data_dir.join(PENDING_RESTORE), act)?;
    let name = backup.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let _ = fs::write(data_dir.join(format!("{PENDING_RESTORE}.from")), format!("{}\n{name}\n", backup.display()));
    Ok(verified)
}

/// Puts a staged restore in place (before the database is opened). The previous database and
/// its WAL files are kept as `workspace.db.before-restore-<stamp>`. Returns where the backup
/// came from.
pub fn apply_pending_restore(data_dir: &Path, now: DateTime<Utc>) -> Result<Option<String>> {
    let pending = data_dir.join(PENDING_RESTORE);
    if !pending.is_file() {
        return Ok(None);
    }
    let from_file = data_dir.join(format!("{PENDING_RESTORE}.from"));
    let from =
        fs::read_to_string(&from_file).ok().and_then(|t| t.lines().next().map(str::to_owned)).unwrap_or_default();
    let db_file = data_dir.join(crate::datadir::DB_FILE);
    let stamp = now.format(STAMP);
    for ext in ["", "-wal", "-shm"] {
        let old = PathBuf::from(format!("{}{ext}", db_file.display()));
        if old.exists() {
            fs::rename(&old, format!("{}{ext}.before-restore-{stamp}", db_file.display())).at(&old)?;
        }
    }
    fs::rename(&pending, &db_file).at(&db_file)?;
    let _ = fs::remove_file(&from_file);
    Ok(Some(from))
}

/// A place backups may be restored from (start-up recovery).
#[derive(Debug, Clone, PartialEq)]
pub struct Source {
    pub path: PathBuf,
    /// Destination folder (listed per computer) or a plain local backup folder.
    pub remote: bool,
}

/// The backups of `sources` that can be reached within `timeout` each, newest first.
pub fn gather(sources: &[Source], timeout: Duration) -> Vec<BackupInfo> {
    let handles: Vec<_> = sources
        .iter()
        .map(|s| {
            let (path, remote) = (s.path.clone(), s.remote);
            std::thread::spawn(move || {
                with_timeout(timeout, move || {
                    if remote {
                        list_remote(&path).map(|l| l.into_iter().map(|r| r.info).collect()).unwrap_or_default()
                    } else {
                        backup::list_backups(&path).unwrap_or_default()
                    }
                })
                .unwrap_or_default()
            })
        })
        .collect();
    let mut all: Vec<BackupInfo> = handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect();
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    all
}

/// Start-up recovery: replaces the database `db_file` by the newest usable backup of `backups`
/// (newest first). Each is copied next to the database and verified (checksum, SQLite check)
/// before the broken file is set aside as `<name>.broken-<stamp>`; a backup that fails the check
/// is skipped. Returns the backup used.
pub fn restore_newest(db_file: &Path, backups: &[BackupInfo], now: DateTime<Utc>) -> Result<BackupInfo> {
    let part = db_file.with_extension("restore-part");
    let mut last_error = None;
    for b in backups {
        let act = Activity::new(None);
        let (src, to) = (PathBuf::from(&b.path), part.clone());
        let res = run_watched(&src.clone(), STALL, act, move |a| fetch_verified(&src, &to, a));
        match res {
            Ok(_) => {
                let stamp = now.format(STAMP);
                for ext in ["", "-wal", "-shm"] {
                    let from = PathBuf::from(format!("{}{ext}", db_file.display()));
                    if from.exists() {
                        fs::rename(&from, format!("{}{ext}.broken-{stamp}", db_file.display())).at(&from)?;
                    }
                }
                fs::rename(&part, db_file).at(db_file)?;
                return Ok(b.clone());
            }
            Err(f) => last_error = Some(f),
        }
    }
    Err(Error::State(match last_error {
        Some(f) => f.message,
        None => "Keine Sicherung gefunden".into(),
    }))
}

// ------------------------------------------------------------------ status

/// Pause before the next attempt after `failures` failed ones in a row: 1, 5, then 15 minutes.
pub fn backoff(failures: u32) -> TimeDelta {
    match failures {
        0 | 1 => TimeDelta::minutes(1),
        2 => TimeDelta::minutes(5),
        _ => TimeDelta::minutes(15),
    }
}

/// How a destination is doing, kept across restarts in [`REGISTRY_FILE`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct DestState {
    pub last_ok: Option<DateTime<Utc>>,
    /// The backup delivered last.
    pub last_file: Option<String>,
    pub last_bytes: Option<u64>,
    pub last_ms: Option<u64>,
    pub last_error: Option<Failure>,
    pub last_error_at: Option<DateTime<Utc>>,
    /// Since when the newest backup is waiting for this destination (`None` = up to date).
    pub pending_since: Option<DateTime<Utc>>,
    /// Failed attempts in a row.
    pub failures: u32,
    /// Backups that failed to reach the destination since it last worked.
    pub missed: u32,
    /// The backup the last failure was about (counted once in `missed`).
    pub failed_file: Option<String>,
    /// Not before this time again (unless asked to).
    pub next_try: Option<DateTime<Utc>>,
    /// The warning for this outage was shown.
    pub warned: bool,
    /// The destination worked at least once.
    pub reached: bool,
}

/// The state shown in the settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Health {
    /// Has the newest backup.
    Ok,
    /// Nothing copied yet (no attempt).
    Waiting,
    /// Not reached yet, will try again (quiet).
    Pending,
    /// Failing for more than a day or three backups (warn).
    Failing,
    Off,
}

impl DestState {
    pub fn succeeded(&mut self, now: DateTime<Utc>, d: &Delivered) {
        *self = DestState {
            last_ok: Some(now),
            last_file: Some(d.file.clone()),
            last_bytes: Some(d.bytes),
            last_ms: Some(d.ms),
            reached: true,
            ..DestState::default()
        };
    }

    /// A failed attempt to deliver `file`.
    pub fn failed(&mut self, now: DateTime<Utc>, file: &str, failure: Failure) {
        self.failures += 1;
        self.pending_since.get_or_insert(now);
        if self.failed_file.as_deref() != Some(file) {
            self.missed += 1;
            self.failed_file = Some(file.to_owned());
        }
        self.last_error = Some(failure);
        self.last_error_at = Some(now);
        self.next_try = Some(now + backoff(self.failures));
    }

    /// A new local backup was written: it is due right away.
    pub fn new_backup(&mut self, now: DateTime<Utc>) {
        self.pending_since.get_or_insert(now);
        self.next_try = None;
    }

    /// Whether `latest` should be copied now.
    pub fn due(&self, now: DateTime<Utc>, latest: &str) -> bool {
        self.last_file.as_deref() != Some(latest) && self.next_try.is_none_or(|t| now >= t)
    }

    /// Whether the outage is long enough to tell the user (more than a day or three backups).
    pub fn failing(&self, now: DateTime<Utc>) -> bool {
        self.failures > 0 && (self.missed >= 3 || self.pending_since.is_some_and(|s| now - s > TimeDelta::hours(24)))
    }

    /// [`DestState::failing`] and not told yet.
    pub fn should_warn(&self, now: DateTime<Utc>) -> bool {
        !self.warned && self.failing(now)
    }

    pub fn health(&self, now: DateTime<Utc>, latest: Option<&str>) -> Health {
        if self.failing(now) {
            Health::Failing
        } else if self.failures > 0 {
            Health::Pending
        } else if (latest.is_some() && self.last_file.as_deref() == latest)
            || (self.last_ok.is_some() && latest.is_none())
        {
            Health::Ok
        } else {
            Health::Waiting
        }
    }
}

/// [`REGISTRY_FILE`]: what the start-up recovery needs without the database (the backup
/// folder and the destinations) and the destinations' status.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Registry {
    /// The local backup folder in effect.
    pub local_dir: Option<String>,
    pub destinations: Vec<Destination>,
    pub status: BTreeMap<String, DestState>,
}

pub fn read_registry(data_dir: &Path) -> Registry {
    fs::read_to_string(data_dir.join(REGISTRY_FILE))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn write_registry(data_dir: &Path, reg: &Registry) -> Result<()> {
    let file = data_dir.join(REGISTRY_FILE);
    let tmp = data_dir.join(format!(".{REGISTRY_FILE}{PARTIAL}"));
    fs::write(&tmp, serde_json::to_string_pretty(reg)?).and_then(|()| fs::rename(&tmp, &file)).at(&file)
}

/// Where the start-up recovery looks for backups: the local folder, then every destination.
pub fn recovery_sources(data_dir: &Path) -> Vec<Source> {
    let reg = read_registry(data_dir);
    let local = reg.local_dir.filter(|d| !d.trim().is_empty()).map(PathBuf::from);
    let mut out = vec![Source { path: data_dir.join("backups"), remote: false }];
    if let Some(l) = local.filter(|l| *l != data_dir.join("backups")) {
        out.push(Source { path: l, remote: false });
    }
    for d in reg.destinations.iter().filter(|d| d.enabled) {
        out.push(Source { path: PathBuf::from(&d.path), remote: true });
    }
    out
}

/// Local time of a backup name, for messages.
pub fn backup_label(info: &BackupInfo) -> String {
    info.created_at.with_timezone(&Local).format("%d.%m.%Y %H:%M").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("annalo-dest-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn backup_in(dir: &Path, stamp: &str, body: &[u8]) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let p = dir.join(format!("annalo-{stamp}.db"));
        fs::write(&p, body).unwrap();
        p
    }

    fn job(backup: &Path, dest: &Path, host: &str, keep: usize) -> Job {
        Job {
            backup: backup.to_path_buf(),
            dest: dest.to_path_buf(),
            host: host.into(),
            keep,
            keep_days: 0,
            attachments: None,
            markdown: None,
            reached_before: false,
            now: Utc::now(),
        }
    }

    #[test]
    fn unc_and_drive_paths_are_recognized_on_every_system() {
        let i = describe(r"\\nas01\Team Daten\Annalo");
        assert_eq!(i.kind, PathKind::Unc);
        assert_eq!((i.server.as_deref(), i.share.as_deref()), (Some("nas01"), Some("Team Daten")));
        assert_eq!(unc_parts("//srv/share/x"), Some(("srv".into(), "share".into())));
        assert_eq!(unc_parts(r"\\?\UNC\srv\share\x"), Some(("srv".into(), "share".into())));
        assert_eq!(unc_parts(r"\\srv"), None, "no share");
        assert_eq!(unc_parts(r"\\?\C:\x"), None, "extended local path is no share");
        assert_eq!(describe(r"Z:\Sicherung\Annalo").kind, PathKind::Drive);
        assert_eq!(describe("/Volumes/Daten/Annalo").kind, PathKind::Mount);
        assert_eq!(describe("/mnt/nas/annalo").kind, PathKind::Mount);
        assert_eq!(describe("/run/user/1000/gvfs/smb-share:server=nas,share=daten/Annalo").kind, PathKind::Mount);
        let c = describe(r"C:\Users\Jörg Müller\OneDrive - Firma\Annalo");
        assert_eq!((c.kind, c.cloud.as_deref()), (PathKind::Cloud, Some("OneDrive")));
        assert_eq!(describe("/home/ana/Nextcloud/Sicherung").cloud.as_deref(), Some("Nextcloud"));
        assert_eq!(describe("/home/ana/Sicherung").kind, PathKind::Local);
        // A share that is synced as well stays a share.
        assert_eq!(describe(r"\\srv\OneDrive\x").kind, PathKind::Unc);
    }

    #[test]
    fn long_windows_paths_get_the_extended_form() {
        assert_eq!(extended_path(r"\\srv\share\Annalo"), r"\\?\UNC\srv\share\Annalo");
        assert_eq!(extended_path("//srv/share/a b/ä"), r"\\?\UNC\srv\share\a b\ä");
        assert_eq!(extended_path(r"Z:\Sicherung"), r"\\?\Z:\Sicherung");
        assert_eq!(extended_path(r"\\?\Z:\x"), r"\\?\Z:\x", "already extended");
        assert_eq!(extended_path("/mnt/x"), "/mnt/x");
        // Short paths stay as they are (messages name them as the user wrote them).
        assert_eq!(os_path(Path::new("/mnt/x")), PathBuf::from("/mnt/x"));
    }

    #[test]
    fn destinations_are_validated_and_normalized() {
        if !cfg!(windows) {
            let e = validate(r"\\srv\share\Annalo").unwrap_err();
            assert_eq!(e.problem, Problem::UncUnsupported);
            assert!(e.message.contains("/Volumes"), "{}", e.message);
        }
        assert_eq!(validate("relativ/ordner").unwrap_err().problem, Problem::Invalid);
        assert_eq!(validate("  ").unwrap_err().problem, Problem::Invalid);
        assert_eq!(validate(r"\\srv").unwrap_err().problem, Problem::Invalid);
        let abs = std::env::temp_dir().join("Sicherung mit Ümlaut");
        assert_eq!(validate(&abs.display().to_string()).unwrap(), abs);

        let mut t = BackupTargets {
            destinations: vec![
                Destination { path: "  /mnt/nas/Annalo ".into(), keep: 0, ..Default::default() },
                Destination { path: "/mnt/nas/Annalo/".into(), ..Default::default() },
                Destination { path: "".into(), ..Default::default() },
                Destination { path: "/Volumes/B".into(), keep: 999, id: "fest".into(), ..Default::default() },
            ],
            local_latest_only: false,
        };
        t.normalize();
        let paths: Vec<_> = t.destinations.iter().map(|d| d.path.as_str()).collect();
        assert_eq!(paths, ["/mnt/nas/Annalo", "/Volumes/B"], "trimmed, empty and duplicate dropped");
        assert_eq!((t.destinations[0].keep, t.destinations[1].keep), (1, 365));
        assert_eq!(t.destinations[0].id, id_for("/mnt/nas/Annalo"));
        assert_eq!(t.destinations[1].id, "fest", "a given id stays");
    }

    #[test]
    fn a_copy_is_written_verified_and_renamed_with_its_checksum() {
        let root = tmp("copy");
        let local = root.join("backups");
        let b = backup_in(&local, "20260925-120000", &vec![7u8; 3 * CHUNK + 17]);
        let dest = root.join("Freigabe mit Ümlaut");
        let act = Activity::new(None);
        let d = deliver(&job(&b, &dest, "LAPTOP-MK", 3), &act).unwrap();
        let copy = dest.join("laptop-mk").join("annalo-20260925-120000.db");
        assert_eq!(d.path, copy.display().to_string());
        assert_eq!(fs::read(&copy).unwrap(), fs::read(&b).unwrap());
        assert_eq!(d.bytes, 3 * CHUNK as u64 + 17);
        assert_eq!(read_sum(&copy).as_deref(), Some(file_sha256(&b).unwrap().as_str()));
        let text = fs::read_to_string(sum_path(&copy)).unwrap();
        assert!(text.ends_with("  annalo-20260925-120000.db\n"), "sha256sum format: {text}");
        let leftovers: Vec<_> = fs::read_dir(copy.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(PARTIAL))
            .collect();
        assert!(leftovers.is_empty(), "no .partial left");
        assert_eq!(act.bytes(), d.bytes);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_copy_leaves_no_file_that_looks_like_a_backup() {
        let root = tmp("fail");
        let b = backup_in(&root.join("backups"), "20260925-120000", b"daten");
        let dest = root.join("ziel");
        // The hook fails the copy after it started (like a share that drops away).
        let hook: Hook = Arc::new(|p: &Path| {
            if p.to_string_lossy().ends_with(".db.partial") {
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let act = Activity::new(Some(hook));
        act.cancelled.store(true, Ordering::Relaxed);
        let err = deliver(&job(&b, &dest, "pc", 3), &act).unwrap_err();
        assert_eq!(err.problem, Problem::Timeout);
        assert!(list_own(&dest.join("pc")).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_share_and_unmounted_folder_are_unreachable_not_created() {
        let root = tmp("missing");
        let b = backup_in(&root.join("backups"), "20260925-120000", b"daten");
        // The parent (the share / mount) is not there.
        let offline = root.join("nicht-verbunden").join("Annalo");
        let e = deliver(&job(&b, &offline, "pc", 3), &Activity::new(None)).unwrap_err();
        assert_eq!(e.problem, Problem::Unreachable, "{e:?}");
        assert!(!root.join("nicht-verbunden").exists(), "nothing created");
        // The folder worked before and is gone now (mount point without the share): not created again.
        let gone = root.join("Annalo");
        let mut j = job(&b, &gone, "pc", 3);
        j.reached_before = true;
        assert_eq!(deliver(&j, &Activity::new(None)).unwrap_err().problem, Problem::Unreachable);
        assert!(!gone.exists());
        // The first time the folder itself is created below an existing parent.
        j.reached_before = false;
        deliver(&j, &Activity::new(None)).unwrap();
        assert!(gone.join("pc").is_dir());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_read_only_destination_is_reported_as_denied() {
        use std::os::unix::fs::PermissionsExt;
        let root = tmp("ro");
        let b = backup_in(&root.join("backups"), "20260925-120000", b"daten");
        let dest = root.join("nur-lesen");
        fs::create_dir_all(&dest).unwrap();
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o555)).unwrap();
        // Root may write anyway; the check only means something for a normal user.
        let probe_file = dest.join("x");
        let writable = fs::write(&probe_file, b"x").is_ok();
        let _ = fs::remove_file(&probe_file);
        if !writable {
            let e = deliver(&job(&b, &dest, "pc", 3), &Activity::new(None)).unwrap_err();
            assert!(matches!(e.problem, Problem::Denied | Problem::ReadOnly), "{e:?}");
            let e = probe(&dest, "pc", &Activity::new(None)).unwrap_err();
            assert!(matches!(e.problem, Problem::Denied | Problem::ReadOnly), "{e:?}");
        }
        fs::set_permissions(&dest, fs::Permissions::from_mode(0o755)).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn errors_are_classified() {
        use std::io::ErrorKind as K;
        let at = |k: K| classify(&Error::file("/x/y", std::io::Error::from(k)));
        assert_eq!(at(K::PermissionDenied), Problem::Denied);
        assert_eq!(at(K::NotFound), Problem::Unreachable);
        assert_eq!(at(K::HostUnreachable), Problem::Unreachable);
        assert_eq!(at(K::TimedOut), Problem::Timeout);
        assert_eq!(at(K::StorageFull), Problem::Full);
        assert_eq!(at(K::ReadOnlyFilesystem), Problem::ReadOnly);
        assert_eq!(classify(&Error::State("x".into())), Problem::Other);
    }

    #[test]
    fn pruning_only_touches_own_backups_with_checksums() {
        let root = tmp("prune");
        let dir = root.join("pc");
        let now = "2026-09-25T12:00:00Z".parse::<DateTime<Utc>>().unwrap();
        for day in 15..=24 {
            let p = backup_in(&dir, &format!("202609{day}-120000"), b"x");
            fs::write(sum_path(&p), "0  x\n").unwrap();
        }
        // Not ours: no checksum, other names, a foreign file with a checksum-like name.
        backup_in(&dir, "20260101-120000", b"ohne pruefsumme");
        fs::write(dir.join("annalo-kopie.db"), b"x").unwrap();
        fs::write(dir.join("annalo-kopie.db.sha256"), b"x").unwrap();
        fs::write(dir.join("Notizen.txt"), b"fremd").unwrap();
        fs::write(dir.join("annalo-20260910-120000.db.partial"), b"halb").unwrap(); // fresh: kept
        let act = Activity::new(None);
        let removed = prune(&dir, 3, 0, now, "annalo-20260924-120000.db", &act).unwrap();
        assert_eq!(removed.len(), 7);
        let mut left: Vec<_> =
            fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        left.sort();
        assert_eq!(
            left,
            [
                "Notizen.txt",
                "annalo-20260101-120000.db",
                "annalo-20260910-120000.db.partial",
                "annalo-20260922-120000.db",
                "annalo-20260922-120000.db.sha256",
                "annalo-20260923-120000.db",
                "annalo-20260923-120000.db.sha256",
                "annalo-20260924-120000.db",
                "annalo-20260924-120000.db.sha256",
                "annalo-kopie.db",
                "annalo-kopie.db.sha256",
            ]
        );
        // Days: older than 2 days go even though `keep` would allow more; the fresh one stays.
        let removed = prune(&dir, 10, 2, now, "annalo-20260922-120000.db", &act).unwrap();
        assert!(removed.is_empty(), "22nd is fresh, 23rd and 24th are young: {removed:?}");
        let removed = prune(&dir, 10, 1, now, "annalo-20260924-120000.db", &act).unwrap();
        assert_eq!(removed, ["annalo-20260923-120000.db", "annalo-20260922-120000.db"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn two_computers_sharing_a_folder_keep_their_own_backups() {
        let root = tmp("hosts");
        let share = root.join("share");
        fs::create_dir_all(&share).unwrap();
        for (i, host) in ["BUERO-PC", "Laptop"].iter().enumerate() {
            for h in 1..=3 {
                let b = backup_in(&root.join(format!("local{i}")), &format!("20260925-0{h}000{i}"), b"x");
                deliver(&job(&b, &share, host, 2), &Activity::new(None)).unwrap();
            }
        }
        assert_eq!(list_own(&share.join("buero-pc")).len(), 2);
        assert_eq!(list_own(&share.join("laptop")).len(), 2, "the other computer's pruning left these alone");
        let all = list_remote(&share).unwrap();
        assert_eq!(all.len(), 4);
        assert!(all.iter().all(|r| r.has_sum));
        assert_eq!(all[0].host, "laptop");
        assert_eq!(all[0].info.file_name, "annalo-20260925-030001.db");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn attachments_are_copied_incrementally_and_the_markdown_tree_mirrored() {
        let root = tmp("files");
        let src = root.join("attachments");
        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("a.png"), b"bild").unwrap();
        fs::write(src.join("Plan.excalidraw"), b"v1").unwrap();
        fs::write(src.join(".versteckt"), b"x").unwrap();
        let dst = root.join("dest");
        let act = Activity::new(None);
        assert_eq!(sync_files(&src, &dst, &act).unwrap(), 2);
        assert_eq!(sync_files(&src, &dst, &act).unwrap(), 0, "nothing new");
        fs::write(src.join("Plan.excalidraw"), b"v2 laenger").unwrap();
        assert_eq!(sync_files(&src, &dst, &act).unwrap(), 1, "a changed drawing is copied again");
        assert_eq!(fs::read(dst.join("Plan.excalidraw")).unwrap(), b"v2 laenger");
        assert!(!dst.join(".versteckt").exists());
        fs::remove_file(src.join("a.png")).unwrap();
        sync_files(&src, &dst, &act).unwrap();
        assert!(dst.join("a.png").exists(), "attachments are never deleted in the backup");

        let md = root.join("markdown");
        fs::create_dir_all(md.join("Projekte")).unwrap();
        fs::write(md.join("Projekte/Übersicht.md"), b"# x").unwrap();
        fs::write(md.join("README.txt"), b"r").unwrap();
        let out = root.join("dest-md");
        sync_tree(&md, &out, &act).unwrap();
        assert!(out.join("Projekte/Übersicht.md").is_file());
        fs::remove_dir_all(md.join("Projekte")).unwrap();
        sync_tree(&md, &out, &act).unwrap();
        assert!(!out.join("Projekte").exists(), "removed pages leave the mirror copy");
        assert!(out.join("README.txt").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_hanging_destination_times_out_without_blocking_others() {
        let root = tmp("hang");
        let b = backup_in(&root.join("backups"), "20260925-120000", &vec![1u8; 2 * CHUNK]);
        let slow = root.join("langsam");
        let fast = root.join("schnell");
        // Every step to the slow destination hangs for 2 s (a share that stopped answering).
        let hook: Hook = Arc::new(|p: &Path| {
            if p.to_string_lossy().contains("langsam") {
                std::thread::sleep(Duration::from_secs(2));
            }
        });
        let started = Instant::now();
        let run = |dest: PathBuf| {
            let b = b.clone();
            let hook = hook.clone();
            std::thread::spawn(move || {
                let job = job(&b, &dest, "pc", 3);
                run_watched(&dest.clone(), Duration::from_millis(300), Activity::new(Some(hook)), move |a| {
                    deliver(&job, a)
                })
            })
        };
        let (s, f) = (run(slow.clone()), run(fast.clone()));
        let fast_res = f.join().unwrap();
        assert!(fast_res.is_ok(), "{fast_res:?}");
        let slow_res = s.join().unwrap().unwrap_err();
        assert_eq!(slow_res.problem, Problem::Timeout);
        assert!(slow_res.message.contains("Zeitüberschreitung"), "{}", slow_res.message);
        assert!(
            started.elapsed() < Duration::from_millis(1800),
            "gave up long before the hang ended: {:?}",
            started.elapsed()
        );
        // The abandoned copy stops at its next step and never renames a partial file into place.
        std::thread::sleep(Duration::from_millis(2500));
        assert!(list_own(&slow.join("pc")).is_empty());
        // A slow but steady copy is not given up: progress keeps it alive.
        let steady: Hook = Arc::new(|_: &Path| std::thread::sleep(Duration::from_millis(100)));
        let job2 = job(&b, &root.join("stetig"), "pc", 3);
        let ok = run_watched(&root.join("stetig"), Duration::from_millis(300), Activity::new(Some(steady)), move |a| {
            deliver(&job2, a)
        });
        assert!(ok.is_ok(), "{ok:?}");
        assert!(with_timeout(Duration::from_millis(50), || std::thread::sleep(Duration::from_secs(1))).is_none());
        assert_eq!(with_timeout(Duration::from_secs(1), || 5), Some(5));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn backoff_waits_longer_and_warns_only_after_a_day_or_three_backups() {
        let t0 = "2026-09-25T08:00:00Z".parse::<DateTime<Utc>>().unwrap();
        let fail = || Failure::new(Problem::Unreachable, "weg", "/x");
        let mut s = DestState::default();
        assert!(s.due(t0, "a.db"));
        assert_eq!(s.health(t0, Some("a.db")), Health::Waiting);
        s.failed(t0, "a.db", fail());
        assert_eq!(s.health(t0, Some("a.db")), Health::Pending);
        assert!(!s.due(t0 + TimeDelta::seconds(30), "a.db"), "backoff");
        assert!(s.due(t0 + TimeDelta::minutes(1), "a.db"));
        s.failed(t0 + TimeDelta::minutes(1), "a.db", fail());
        assert_eq!(s.next_try, Some(t0 + TimeDelta::minutes(6)));
        s.failed(t0 + TimeDelta::minutes(6), "a.db", fail());
        s.failed(t0 + TimeDelta::minutes(21), "a.db", fail());
        assert_eq!(s.next_try, Some(t0 + TimeDelta::minutes(36)), "at most every 15 minutes");
        assert_eq!(s.missed, 1, "one backup, many attempts");
        assert!(!s.should_warn(t0 + TimeDelta::hours(2)), "quiet for a few hours");
        // The next backups: due at once, and counted.
        s.new_backup(t0 + TimeDelta::hours(3));
        assert!(s.due(t0 + TimeDelta::hours(3), "b.db"));
        s.failed(t0 + TimeDelta::hours(3), "b.db", fail());
        s.new_backup(t0 + TimeDelta::hours(4));
        s.failed(t0 + TimeDelta::hours(4), "c.db", fail());
        assert!(s.should_warn(t0 + TimeDelta::hours(4)), "three backups missed");
        assert_eq!(s.health(t0 + TimeDelta::hours(4), Some("c.db")), Health::Failing);
        s.warned = true;
        assert!(!s.should_warn(t0 + TimeDelta::hours(5)), "told once");
        // Or a day with one backup only.
        let mut d = DestState::default();
        d.failed(t0, "a.db", fail());
        assert!(!d.should_warn(t0 + TimeDelta::hours(23)));
        assert!(d.should_warn(t0 + TimeDelta::hours(25)));
        // Success clears it all.
        let ok = Delivered {
            file: "c.db".into(),
            path: "/x/c.db".into(),
            bytes: 1,
            sha256: String::new(),
            ms: 3,
            removed: vec![],
            attachments: 0,
        };
        s.succeeded(t0 + TimeDelta::hours(6), &ok);
        assert_eq!(s.health(t0 + TimeDelta::hours(6), Some("c.db")), Health::Ok);
        assert!(!s.due(t0 + TimeDelta::hours(6), "c.db"));
        assert!(s.reached && s.failures == 0 && s.missed == 0 && !s.warned);
    }

    #[test]
    fn restoring_verifies_the_checksum_and_copies_locally_first() {
        let root = tmp("restore");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let db_file = data.join(crate::datadir::DB_FILE);
        {
            let db = Database::open(&db_file).unwrap();
            let p = db.create_page(None, "Im Netz gesichert", None).unwrap();
            db.save_page_content(p.id, "vom NAS").unwrap();
            backup::backup_to(&db, &data.join("backups"), 3).unwrap();
        }
        let local = backup::list_backups(&data.join("backups")).unwrap().remove(0);
        let share = root.join("nas");
        fs::create_dir_all(&share).unwrap();
        deliver(&job(Path::new(&local.path), &share, "pc", 3), &Activity::new(None)).unwrap();
        let remote = list_remote(&share).unwrap().remove(0);

        // A damaged copy is refused (checksum), and nothing is staged.
        let damaged = root.join("nas-kaputt");
        fs::create_dir_all(damaged.join("pc")).unwrap();
        let bad = damaged.join("pc").join(&remote.info.file_name);
        fs::copy(&remote.info.path, &bad).unwrap();
        fs::copy(sum_path(Path::new(&remote.info.path)), sum_path(&bad)).unwrap();
        let mut bytes = fs::read(&bad).unwrap();
        bytes[200] ^= 0xff;
        fs::write(&bad, bytes).unwrap();
        let e = stage_restore(&bad, &data, &Activity::new(None)).unwrap_err();
        assert_eq!(e.problem, Problem::Checksum);
        assert!(!data.join(PENDING_RESTORE).exists());

        // The intact one is staged and put in place at the next start.
        assert!(stage_restore(Path::new(&remote.info.path), &data, &Activity::new(None)).unwrap(), "checksum verified");
        {
            let db = Database::open(&db_file).unwrap();
            db.create_page(None, "Später", None).unwrap();
        }
        let now = Utc::now();
        let from = apply_pending_restore(&data, now).unwrap().unwrap();
        assert_eq!(from, remote.info.path);
        assert!(apply_pending_restore(&data, now).unwrap().is_none(), "once");
        let db = Database::open(&db_file).unwrap();
        assert!(db.page_by_title("Im Netz gesichert").unwrap().is_some());
        assert!(db.page_by_title("Später").unwrap().is_none());
        let kept = fs::read_dir(&data)
            .unwrap()
            .flatten()
            .any(|e| e.file_name().to_string_lossy().contains(".before-restore-"));
        assert!(kept, "previous state kept");
        drop(db);

        // Start-up recovery: the newest verified backup of all sources, skipping a damaged one.
        fs::write(&db_file, b"kaputt").unwrap();
        let mut newest = remote.info.clone();
        newest.path = bad.display().to_string();
        newest.created_at += TimeDelta::hours(1);
        let reg = Registry {
            local_dir: None,
            destinations: vec![Destination { path: share.display().to_string(), ..Default::default() }],
            status: BTreeMap::new(),
        };
        write_registry(&data, &reg).unwrap();
        let sources = recovery_sources(&data);
        assert_eq!(sources.len(), 2);
        let mut found = gather(&sources, Duration::from_secs(5));
        assert_eq!(found.len(), 2, "local and on the share");
        found.insert(0, newest);
        let used = restore_newest(&db_file, &found, now).unwrap();
        assert_ne!(used.path, bad.display().to_string(), "the damaged newest one was skipped");
        let db = Database::open(&db_file).unwrap();
        assert!(db.page_by_title("Im Netz gesichert").unwrap().is_some());
        drop(db);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn probe_writes_and_deletes() {
        let root = tmp("probe");
        let dest = root.join("Neuer Ordner äöü");
        let p = probe(&dest, "PC 1", &Activity::new(None)).unwrap();
        assert_eq!(p.bytes, 256 * 1024);
        assert_eq!(p.existing, 0);
        assert_eq!(fs::read_dir(&dest).unwrap().count(), 0, "probe file deleted");
        let e = probe(&root.join("fehlt/tiefer"), "pc", &Activity::new(None)).unwrap_err();
        assert_eq!(e.problem, Problem::Unreachable);
        let _ = fs::remove_dir_all(&root);
    }
}
