//! Copies of every backup to further folders (Settings → Sicherung → „Weitere Sicherungsziele“),
//! see `annalo_core::backupdest`. A worker thread delivers the newest local backup to each
//! switched-on destination: right after a backup, when the settings change, on „Erneut
//! versuchen“ and every minute for destinations whose pause after a failure is over. Each copy
//! runs on a thread of its own under a watchdog, never holds the database lock and never
//! keeps the app from quitting. The status lives in `backup-destinations.json` in the data
//! folder, next to what the start-up recovery needs (the destinations).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use annalo_core::backup::{self, BackupInfo};
use annalo_core::backupdest::{
    self as dest, Activity, DestState, Destination, Failure, Health, Hook, Job, PathInfo, Probe, Problem, Registry,
};
use annalo_core::{Error, Result, datadir};
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, devlog, lock};
use annalo_core::{tr, trf};

/// State of the destinations: their status, the copies running now and the worker's inbox.
#[derive(Default)]
pub struct Destinations {
    registry: Mutex<Registry>,
    /// Destinations with a copy still running (maybe hanging in the operating system).
    busy: Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Wakes the worker; `true` retries at once, ignoring the pause after failures.
    wake: Mutex<Option<Sender<bool>>>,
}

impl Destinations {
    fn status(&self, id: &str) -> DestState {
        lock(&self.registry).status.get(id).cloned().unwrap_or_default()
    }

    fn is_busy(&self, id: &str) -> bool {
        lock(&self.busy).get(id).is_some_and(|b| b.load(Ordering::Relaxed))
    }

    fn wake(&self, force: bool) {
        if let Some(tx) = lock(&self.wake).as_ref() {
            let _ = tx.send(force);
        }
    }
}

/// Clears a busy flag when the copy's thread ends, however it ends.
struct Busy(Arc<AtomicBool>);

impl Drop for Busy {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

fn host() -> String {
    annalo_core::gitsync::hostname()
}

/// Pause after which a copy without progress is given up; `ANNALO_BACKUP_STALL_SECS` in debug builds (tests).
fn stall() -> Duration {
    if cfg!(debug_assertions)
        && let Some(secs) = std::env::var("ANNALO_BACKUP_STALL_SECS").ok().and_then(|s| s.trim().parse().ok())
    {
        return Duration::from_secs(secs);
    }
    dest::STALL
}

/// Debug builds: `ANNALO_TEST_SLOW_DEST=<text>=<ms>` makes every step of a copy to a path
/// containing `<text>` take that long (a share that stops answering, for the end-to-end tests).
fn test_hook() -> Option<Hook> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let spec = std::env::var("ANNALO_TEST_SLOW_DEST").ok()?;
    let (needle, ms) = spec.rsplit_once('=')?;
    let (needle, ms) = (needle.to_owned(), ms.trim().parse::<u64>().ok()?);
    Some(Arc::new(move |p: &Path| {
        if p.to_string_lossy().contains(&needle) {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }))
}

/// Puts a backup staged by [`backup_restore`] in place of the database (at start, before the
/// database is opened); the notice tells the user.
pub fn apply_pending_restore(dir: &Path) -> Option<datadir::Notice> {
    match dest::apply_pending_restore(dir, Utc::now()) {
        Ok(None) => None,
        Ok(Some(from)) => {
            devlog::warn("backup", format!("database restored from {from}"));
            Some(datadir::Notice::titled(
                "info",
                tr!("Sicherung wiederhergestellt", "Backup restored"),
                trf!(
                    "Die Sicherung {from} wurde wiederhergestellt. Der vorherige Stand liegt als \
                     workspace.db.before-restore-… im Datenordner.",
                    "The backup {from} was restored. The previous state is in the data folder as \
                     workspace.db.before-restore-…."
                ),
            ))
        }
        Err(e) => {
            devlog::error("backup", format!("restore failed: {}", e.detail()));
            Some(datadir::Notice::titled(
                "error",
                tr!("Wiederherstellen fehlgeschlagen", "Restoring failed"),
                trf!(
                    "Die gewählte Sicherung konnte nicht eingesetzt werden: {e}",
                    "The chosen backup could not be put in place: {e}"
                ),
            ))
        }
    }
}

/// Loads the status, records the destinations for the start-up recovery and starts the worker.
pub fn init(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dests = app.state::<Destinations>();
    *lock(&dests.registry) = dest::read_registry(&state.data_dir);
    persist(app);
    let (tx, rx) = std::sync::mpsc::channel();
    *lock(&dests.wake) = Some(tx);
    let handle = app.clone();
    std::thread::Builder::new().name("annalo-backup-destinations".into()).spawn(move || worker(handle, rx)).ok();
}

/// Writes `backup-destinations.json` with the current settings and status.
fn persist(app: &AppHandle) {
    let state = app.state::<AppState>();
    let dests = app.state::<Destinations>();
    let settings = state.settings();
    // Written under the lock: copies finishing at the same time must not interleave their writes.
    let mut reg = lock(&dests.registry);
    reg.local_dir = Some(state.backup_dir().display().to_string());
    reg.destinations = settings.backup_targets.destinations.clone();
    // Status of removed destinations goes with them.
    let ids: Vec<String> = reg.destinations.iter().map(|d| d.id.clone()).collect();
    reg.status.retain(|id, _| ids.contains(id));
    if let Err(e) = dest::write_registry(&state.data_dir, &reg) {
        devlog::warn("backup", format!("destination status not saved: {}", e.detail()));
    }
}

/// The settings changed (destinations added, removed, switched on): copy what is missing now.
pub fn settings_changed(app: &AppHandle) {
    persist(app);
    app.state::<Destinations>().wake(false);
}

/// A local backup was written: every destination is due at once.
pub fn backup_written(app: &AppHandle, info: &BackupInfo) {
    let state = app.state::<AppState>();
    let dests = app.state::<Destinations>();
    let now = Utc::now();
    {
        let mut reg = lock(&dests.registry);
        for d in state.settings().backup_targets.enabled() {
            reg.status.entry(d.id.clone()).or_default().new_backup(now);
        }
    }
    devlog::debug("backup", format!("copying {} to the destinations", info.file_name));
    persist(app);
    dests.wake(false);
}

fn worker(app: AppHandle, rx: Receiver<bool>) {
    loop {
        let force = match rx.recv_timeout(Duration::from_secs(60)) {
            Ok(force) => force,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
        };
        // Several wakes at once (a backup right after a settings change) make one pass.
        let force = force | rx.try_iter().fold(false, |a, b| a | b);
        pass(&app, force);
    }
}

/// Starts a copy to every destination that is due (and not still busy with an earlier one).
fn pass(app: &AppHandle, force: bool) {
    let state = app.state::<AppState>();
    let dests = app.state::<Destinations>();
    let settings = state.settings();
    let Some(latest) = backup::list_backups(&state.backup_dir()).ok().and_then(|l| l.into_iter().next()) else {
        return;
    };
    let now = Utc::now();
    for d in settings.backup_targets.enabled() {
        let st = dests.status(&d.id);
        let due =
            if force { st.last_file.as_deref() != Some(&latest.file_name) } else { st.due(now, &latest.file_name) };
        if !due {
            continue;
        }
        if dests.is_busy(&d.id) {
            devlog::debug("backup", format!("destination {} still busy with the previous copy", d.path));
            continue;
        }
        let markdown = (d.markdown && settings.markdown_mirror).then(|| state.mirror_dir());
        let attachments = d.attachments.then(|| state.attachments_dir());
        start_copy(app, d.clone(), &latest, st.reached, attachments, markdown);
    }
}

fn start_copy(
    app: &AppHandle,
    d: Destination,
    latest: &BackupInfo,
    reached: bool,
    attachments: Option<PathBuf>,
    markdown: Option<PathBuf>,
) {
    let dests = app.state::<Destinations>();
    let flag = Arc::new(AtomicBool::new(true));
    lock(&dests.busy).insert(d.id.clone(), flag.clone());
    let job = Job {
        backup: PathBuf::from(&latest.path),
        dest: PathBuf::from(&d.path),
        host: host(),
        keep: d.keep,
        keep_days: d.keep_days,
        attachments,
        markdown,
        reached_before: reached,
        now: Utc::now(),
    };
    let file = latest.file_name.clone();
    let app = app.clone();
    let _ = app.emit("backup://destinations", ());
    std::thread::Builder::new()
        .name("annalo-backup-destination".into())
        .spawn(move || {
            let path = job.dest.clone();
            let res = match dest::validate(&d.path) {
                Err(f) => {
                    drop(Busy(flag));
                    Err(f)
                }
                Ok(_) => dest::run_watched(&path, stall(), Activity::new(test_hook()), move |a| {
                    let _busy = Busy(flag);
                    dest::deliver(&job, a)
                }),
            };
            finish(&app, &d, &file, res);
        })
        .ok();
}

/// Records the outcome of one copy, tells the UI and warns once a destination fails for long.
fn finish(app: &AppHandle, d: &Destination, file: &str, res: std::result::Result<dest::Delivered, Failure>) {
    let dests = app.state::<Destinations>();
    let now = Utc::now();
    let warn = {
        let mut reg = lock(&dests.registry);
        let st = reg.status.entry(d.id.clone()).or_default();
        match &res {
            Ok(done) => {
                st.succeeded(now, done);
                devlog::debug(
                    "backup",
                    format!(
                        "copied {} to {} in {} ms ({} bytes, {} files)",
                        done.file, d.path, done.ms, done.bytes, done.attachments
                    ),
                );
                if !done.removed.is_empty() {
                    devlog::debug("backup", format!("old backups removed in {}: {}", d.path, done.removed.join(", ")));
                }
                None
            }
            Err(f) => {
                st.failed(now, file, f.clone());
                devlog::warn("backup", format!("copy to {} failed ({:?}): {}", d.path, f.problem, f.message));
                if st.should_warn(now) {
                    st.warned = true;
                    Some(Warning {
                        id: d.id.clone(),
                        path: d.path.clone(),
                        failure: f.clone(),
                        since: st.pending_since,
                    })
                } else {
                    None
                }
            }
        }
    };
    persist(app);
    if let Some(w) = warn {
        devlog::error(
            "backup",
            format!("backup destination {} failing since {:?}: {}", w.path, w.since, w.failure.message),
        );
        let _ = app.emit("backup://destination-failed", w);
    }
    let _ = app.emit("backup://destinations", ());
    if res.is_ok() {
        prune_local(app, file);
    }
}

/// „Lokal nur die neueste behalten“: once every switched-on destination has `file`, the local
/// folder keeps only it.
fn prune_local(app: &AppHandle, file: &str) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let targets = &settings.backup_targets;
    if !targets.local_latest_only || targets.enabled().next().is_none() {
        return;
    }
    let dests = app.state::<Destinations>();
    if !targets.enabled().all(|d| dests.status(&d.id).last_file.as_deref() == Some(file)) {
        return;
    }
    match backup::prune(&state.backup_dir(), 1, file) {
        Ok(gone) if !gone.is_empty() => devlog::debug("backup", format!("local backups removed: {}", gone.join(", "))),
        Ok(_) => {}
        Err(e) => devlog::warn("backup", format!("local backups not pruned: {}", e.detail())),
    }
}

#[derive(Clone, Serialize)]
struct Warning {
    id: String,
    path: String,
    failure: Failure,
    since: Option<chrono::DateTime<Utc>>,
}

// ------------------------------------------------------------------ commands

#[derive(Serialize)]
pub struct DestView {
    id: String,
    path: String,
    enabled: bool,
    info: PathInfo,
    state: DestState,
    health: Health,
    /// A copy is running (or hanging) now.
    busy: bool,
    /// This computer's subfolder in the destination.
    folder: String,
}

/// The destinations with their status (Settings → Sicherung).
#[tauri::command(async)]
pub fn backup_destinations(state: State<AppState>, dests: State<Destinations>) -> Vec<DestView> {
    let latest = backup::list_backups(&state.backup_dir()).ok().and_then(|l| l.into_iter().next()).map(|b| b.file_name);
    let now = Utc::now();
    state
        .settings()
        .backup_targets
        .destinations
        .iter()
        .map(|d| {
            let st = dests.status(&d.id);
            DestView {
                id: d.id.clone(),
                path: d.path.clone(),
                enabled: d.enabled,
                info: dest::describe(&d.path),
                health: if d.enabled { st.health(now, latest.as_deref()) } else { Health::Off },
                busy: dests.is_busy(&d.id),
                state: st,
                folder: dest::host_folder(&host()),
            }
        })
        .collect()
}

#[derive(Serialize)]
pub struct TestResult {
    ok: bool,
    probe: Option<Probe>,
    failure: Option<Failure>,
    info: PathInfo,
}

/// „Jetzt testen“: writes, reads back and deletes a probe file in `path` (at most 20 s).
#[tauri::command]
pub async fn backup_destination_test(path: String) -> Result<TestResult> {
    let info = dest::describe(&path);
    let res = tauri::async_runtime::spawn_blocking(move || {
        let dir = dest::validate(&path)?;
        let d = dir.clone();
        let stall = stall().min(Duration::from_secs(20));
        dest::run_watched(&dir, stall, Activity::new(test_hook()), move |a| dest::probe(&d, &host(), a))
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?;
    Ok(match res {
        Ok(p) => TestResult { ok: true, probe: Some(p), failure: None, info },
        Err(f) => TestResult { ok: false, probe: None, failure: Some(f), info },
    })
}

/// „Erneut versuchen“: copies to every destination that lacks the newest backup now.
#[tauri::command]
pub fn backup_destination_retry(dests: State<Destinations>) {
    dests.wake(true);
}

#[derive(Serialize, Clone)]
pub struct SourcedBackup {
    #[serde(flatten)]
    info: BackupInfo,
    /// Destination id; `local` for the local folder.
    source: String,
    /// The destination folder.
    source_path: String,
    /// The computer that wrote it.
    host: String,
    has_sum: bool,
}

#[derive(Serialize)]
pub struct RemoteList {
    backups: Vec<SourcedBackup>,
    /// Destinations that could not be listed.
    offline: Vec<Failure>,
}

/// The backups in the switched-on destinations (each listed for at most a few seconds).
#[tauri::command]
pub async fn backup_remote_list(app: AppHandle) -> Result<RemoteList> {
    let settings = app.state::<AppState>().settings();
    let list: Vec<Destination> = settings.backup_targets.enabled().cloned().collect();
    tauri::async_runtime::spawn_blocking(move || remote_list(list)).await.map_err(|e| Error::State(e.to_string()))
}

fn remote_list(list: Vec<Destination>) -> RemoteList {
    let handles: Vec<_> = list
        .into_iter()
        .map(|d| {
            std::thread::spawn(move || {
                let path = PathBuf::from(&d.path);
                let p2 = path.clone();
                let res = dest::with_timeout(dest::LIST_TIMEOUT, move || dest::list_remote(&p2));
                let res = match res {
                    None => Err(Failure::new(
                        Problem::Timeout,
                        trf!("Zeitüberschreitung bei {}", "Timed out at {}", d.path),
                        &d.path,
                    )),
                    Some(Err(e)) => Err(Failure::of(&e, &path)),
                    Some(Ok(l)) => Ok(l),
                };
                (d, res)
            })
        })
        .collect();
    let mut out = RemoteList { backups: vec![], offline: vec![] };
    for h in handles {
        let Ok((d, res)) = h.join() else { continue };
        match res {
            Ok(list) => out.backups.extend(list.into_iter().map(|r| SourcedBackup {
                info: r.info,
                source: d.id.clone(),
                source_path: d.path.clone(),
                host: r.host,
                has_sum: r.has_sum,
            })),
            Err(f) => out.offline.push(f),
        }
    }
    out.backups.sort_by(|a, b| b.info.created_at.cmp(&a.info.created_at));
    out
}

#[derive(Serialize)]
pub struct Staged {
    ok: bool,
    /// Whether a checksum was compared (local backups have none; they are checked as SQLite files).
    verified: bool,
    failure: Option<Failure>,
}

/// Prepares restoring the backup `path` (local or in a destination): it is copied into the data
/// folder and checked; the next start puts it in place of the database (the UI restarts right
/// after). Only the app's own backups in the backup folder or a destination are accepted.
#[tauri::command]
pub async fn backup_restore(app: AppHandle, path: String) -> Result<Staged> {
    let state = app.state::<AppState>();
    let file = PathBuf::from(path.trim());
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_owned();
    let local = state.backup_dir();
    let settings = state.settings();
    // A destination holds one folder per computer: <destination>/<computer>/arcalo-….db
    // (annalo-….db before 1.7).
    let in_dest = |d: &Destination| {
        let root = file.parent().and_then(Path::parent);
        root.is_some_and(|p| dest::id_for(&p.display().to_string()) == dest::id_for(&d.path))
    };
    let known = file.parent() == Some(local.as_path()) || settings.backup_targets.destinations.iter().any(in_dest);
    if !known || !annalo_core::backup::has_backup_prefix(&name) {
        let f = Failure::new(
            Problem::Invalid,
            trf!("Keine Sicherung von Arcalo: {}", "Not an Arcalo backup: {}", file.display()),
            &path,
        );
        return Ok(Staged { ok: false, verified: false, failure: Some(f) });
    }
    let data_dir = state.data_dir.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let f2 = file.clone();
        dest::run_watched(&file, stall(), Activity::new(test_hook()), move |a| dest::stage_restore(&f2, &data_dir, a))
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?;
    Ok(match res {
        Ok(verified) => {
            devlog::warn("backup", format!("restore of {name} prepared, applied at the next start"));
            Staged { ok: true, verified, failure: None }
        }
        Err(f) => {
            devlog::error("backup", format!("restore of {name} failed: {}", f.message));
            Staged { ok: false, verified: false, failure: Some(f) }
        }
    })
}
