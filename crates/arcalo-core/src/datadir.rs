//! Where the workspace lives.
//!
//! The data folder holds `workspace.db` (+ WAL files), `attachments/`, `backups/` and
//! `secrets.json`. By default it is the app data folder; a bootstrap file `location.json`
//! (`{"data_dir": "…"}`) in the app config folder points elsewhere, and the
//! `ARCALO_DATA_DIR` environment variable (tests; `ANNALO_DATA_DIR` of 1.14 and earlier still works)
//! overrides both.
//!
//! Moving happens in two steps so no edit is lost: choosing a folder only records a
//! pending move (`{"data_dir": old, "pending_move": new}`); the next start copies the
//! closed workspace before the database is opened ([`prepare`]). The old folder is left
//! untouched.
//!
//! Portable mode: a file `arcalo-portable` next to the executable (or a folder `data/` there
//! holding the marker `.arcalo-portable`) keeps everything in `<exe dir>/data`, and
//! `location.json` is neither read nor written ([`portable_data_dir`], [`prepare_portable`]).
//! The markers of copies from before the rename to Arcalo (`annalo-portable`,
//! `data/.annalo-portable`) count too, so the new ZIP unpacked over an old folder keeps its data.

use crate::{tr, trf};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, IoAt, Result, copy_file};

pub const DB_FILE: &str = "workspace.db";
/// Name of the bootstrap file in the app config folder.
pub const LOCATION_FILE: &str = "location.json";
/// Staging folder inside the target while a move copies files.
pub const STAGING_DIR: &str = ".arcalo-move-tmp";
/// Folders and files next to the database that move with it (the database goes last): files,
/// backups, the file trash, the logs, the Git sync's working tree, unfinished recordings, the
/// secrets file, the password-wrapped key and the state of an encryption switch, the capture
/// queue, the marker of a restore the Git sync has to compare first, the backup destinations
/// and a restore waiting for the next start. Everything else the app keeps there is in
/// [`STAYS`]; a test makes sure every name the app writes is in one of the lists.
pub const DATA_DIRS: [&str; 6] = ["attachments", "backups", "trash", "logs", "git-sync", "voice"];
pub const DATA_FILES: [&str; 12] = [
    "secrets.json",
    CREDENTIALS_MOVED,
    crate::cipher::MARKER,
    crate::cipher::NEW_FILE,
    crate::cipher::OLD_FILE,
    crate::cipher::WRAPPED_FILE,
    crate::cipher::WRAPPED_NEXT_FILE,
    crate::capture::QUEUE_FILE,
    crate::gitsync::RESTORED_FILE,
    crate::backupdest::REGISTRY_FILE,
    crate::backupdest::PENDING_RESTORE,
    "restore-pending.db.from",
];
/// What stays in the old folder on a move: bound to this installation (updates, rollback,
/// health, the instance and command locks, the portable copy's WebView profile, the Android
/// update state), written anew when needed (scripts, mail temp files, the CA bundle for Git,
/// the export of a sync without mirror, caches) or downloaded again (speech models).
pub const STAYS: [&str; 14] = [
    "models",
    crate::update_state::UPDATES_DIR,
    crate::update_state::ROLLBACK_DIR,
    crate::update_state::HEALTH_FILE,
    crate::cmdlock::DIR,
    ".arcalo.lock",
    "webview",
    "cache",
    "scripts",
    crate::mail::TEMP_DIR,
    crate::cmdlock::WORKSPACE_LOCK,
    "git-sync-export",
    "network-ca-bundle.pem",
    "android-update.json",
];
/// Credential store entries taken over from the service of 1.14 and earlier (the shell's
/// `secrets.rs`); it moves with the data, so a moved workspace does not read old entries again.
pub const CREDENTIALS_MOVED: &str = "credentials-moved.json";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Location {
    pub data_dir: String,
    /// Folder the workspace moves to on the next start.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_move: Option<String>,
}

/// The contents of `location.json` in `config_dir`, if it is readable.
pub fn read_location_file(config_dir: &Path) -> Option<Location> {
    let raw = std::fs::read_to_string(config_dir.join(LOCATION_FILE)).ok()?;
    serde_json::from_str(&raw).ok()
}

/// The data folder `location.json` in `config_dir` points to, if any.
pub fn read_location(config_dir: &Path) -> Option<PathBuf> {
    let loc = read_location_file(config_dir)?;
    let dir = loc.data_dir.trim();
    (!dir.is_empty()).then(|| PathBuf::from(dir))
}

/// Writes `location.json` (via a temporary file, so a crash never leaves half a file).
pub fn write_location_file(config_dir: &Path, loc: &Location) -> Result<()> {
    std::fs::create_dir_all(config_dir).at(config_dir)?;
    let json = serde_json::to_string_pretty(loc)?;
    let tmp = config_dir.join(format!(".{LOCATION_FILE}.part"));
    let file = config_dir.join(LOCATION_FILE);
    std::fs::write(&tmp, json).and_then(|()| std::fs::rename(&tmp, &file)).at(&file)?;
    Ok(())
}

/// Points `location.json` at `data_dir` (no pending move).
pub fn write_location(config_dir: &Path, data_dir: &Path) -> Result<()> {
    write_location_file(config_dir, &Location { data_dir: data_dir.display().to_string(), pending_move: None })
}

/// Records a move of the workspace from `from` to `to` for the next start.
pub fn write_pending_move(config_dir: &Path, from: &Path, to: &Path) -> Result<()> {
    write_location_file(
        config_dir,
        &Location { data_dir: from.display().to_string(), pending_move: Some(to.display().to_string()) },
    )
}

/// The data folder to open: `env` (ARCALO_DATA_DIR) wins, then `location.json`, then `default`.
pub fn resolve(env: Option<PathBuf>, config_dir: Option<&Path>, default: PathBuf) -> PathBuf {
    env.filter(|p| !p.as_os_str().is_empty()).or_else(|| config_dir.and_then(read_location)).unwrap_or(default)
}

/// Marker file next to the executable that switches on portable mode.
pub const PORTABLE_MARKER: &str = "arcalo-portable";
/// [`PORTABLE_MARKER`] of copies from before 1.7 (Annalo).
pub const LEGACY_PORTABLE_MARKER: &str = "annalo-portable";
/// The data folder of a portable copy, next to the executable.
pub const PORTABLE_DATA: &str = "data";
/// Marker inside `data/`: the folder alone (without [`PORTABLE_MARKER`]) also means portable.
pub const PORTABLE_DATA_MARKER: &str = ".arcalo-portable";
/// [`PORTABLE_DATA_MARKER`] of copies from before 1.7 (Annalo).
pub const LEGACY_PORTABLE_DATA_MARKER: &str = ".annalo-portable";

/// The folder of the running executable; `env` (`ARCALO_EXE_DIR`, tests) stands in for it.
pub fn exe_dir(env: Option<PathBuf>) -> Option<PathBuf> {
    env.filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)))
}

/// `<exe dir>/data` when the copy next to `exe_dir` is portable, else `None`.
pub fn portable_data_dir(exe_dir: &Path) -> Option<PathBuf> {
    let data = exe_dir.join(PORTABLE_DATA);
    let marked = [PORTABLE_MARKER, LEGACY_PORTABLE_MARKER].iter().any(|m| exe_dir.join(m).is_file())
        || [PORTABLE_DATA_MARKER, LEGACY_PORTABLE_DATA_MARKER].iter().any(|m| data.join(m).is_file());
    marked.then_some(data)
}

/// Like [`prepare`], with a portable data folder first: `env` still wins (tests), then
/// `portable` (`location.json` is ignored), then the usual order. `commands`: the folder of the
/// marks of running commands ([`crate::cmdlock`]), waited for before a move.
pub fn prepare_portable(
    env: Option<PathBuf>,
    portable: Option<PathBuf>,
    config_dir: Option<&Path>,
    default: PathBuf,
    commands: Option<&Path>,
) -> Startup {
    let env = env.filter(|p| !p.as_os_str().is_empty());
    match (env, portable) {
        (None, Some(dir)) => Startup { dir, notice: None },
        (env, _) => prepare_with(env, config_dir, default, commands, crate::cmdlock::START_WAIT),
    }
}

/// The data folder the app uses while it runs (or opens at its next start), for a program that
/// works on the same workspace next to it (the `arcalo` command line): like [`prepare_portable`],
/// but a pending move is never carried out (the app does that at its start, with the workspace
/// closed): `env` (ARCALO_DATA_DIR) wins, then the portable copy's folder, then the folder of
/// `location.json` when it holds a workspace, else `default`.
pub fn locate(env: Option<PathBuf>, portable: Option<PathBuf>, config_dir: Option<&Path>, default: PathBuf) -> PathBuf {
    if let Some(dir) = env.filter(|p| !p.as_os_str().is_empty()) {
        return dir;
    }
    if let Some(dir) = portable {
        return dir;
    }
    match config_dir.and_then(read_location) {
        Some(dir) if dir == default || dir.join(DB_FILE).is_file() => dir,
        _ => default,
    }
}

/// Suffix for credential-store entries of a portable copy (`git-token@3f2a…`): the Windows
/// credential store and the macOS keychain belong to the user, not to the folder, so two
/// portable copies (or a portable and an installed one) must not share or overwrite secrets.
/// Derived from the data folder's path; secrets do not travel with the folder.
pub fn secret_namespace(data_dir: &Path) -> String {
    use sha2::{Digest, Sha256};
    let path = data_dir.canonicalize().unwrap_or_else(|_| data_dir.to_path_buf());
    let key = path.display().to_string().to_lowercase();
    Sha256::digest(key.as_bytes()).iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// Whether `path` is a network share or inside a OneDrive/Dropbox folder. SQLite's locking
/// does not survive sync clients or SMB well; such a database can be corrupted.
pub fn is_synced_or_network(path: &str) -> bool {
    let p = path.trim();
    let unc = p.starts_with("\\\\") || p.starts_with("//");
    let lower = p.to_lowercase();
    unc || lower.contains("onedrive") || lower.contains("dropbox")
}

impl Database {
    /// Moves the WAL contents into the main database file and truncates the WAL.
    pub fn checkpoint(&self) -> Result<()> {
        self.conn().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(())
    }
}

/// What happened while choosing the data folder at startup.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Notice {
    /// `info`, `warning` or `error`.
    pub kind: &'static str,
    pub message: String,
    /// Heading of the notice; without one the UI names a data-folder move.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

impl Notice {
    fn new(kind: &'static str, message: String) -> Self {
        Notice { kind, message, title: None }
    }

    /// Another start-up problem (`kind` `warning` or `error`) with its own heading.
    pub fn titled(kind: &'static str, title: &str, message: String) -> Self {
        Notice { kind, message, title: Some(title.to_owned()) }
    }
}

/// The data folder to open, and what the UI should be told about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Startup {
    pub dir: PathBuf,
    pub notice: Option<Notice>,
}

/// Picks the data folder at startup, before the database is opened: carries out a pending
/// move (on failure the old folder stays in use) and falls back to `default` when the
/// chosen folder is missing or holds no workspace (e.g. a disconnected drive).
pub fn prepare(env: Option<PathBuf>, config_dir: Option<&Path>, default: PathBuf) -> Startup {
    prepare_with(env, config_dir, default, None, crate::cmdlock::START_WAIT)
}

/// [`prepare`] that waits up to `wait` for the commands marked in `commands` and for every
/// command holding the workspace before a move; when they do not end, the move waits for the
/// next start.
pub fn prepare_with(
    env: Option<PathBuf>,
    config_dir: Option<&Path>,
    default: PathBuf,
    commands: Option<&Path>,
    wait: std::time::Duration,
) -> Startup {
    if let Some(dir) = env.filter(|p| !p.as_os_str().is_empty()) {
        return Startup { dir, notice: None };
    }
    let Some(config_dir) = config_dir else { return Startup { dir: default, notice: None } };
    let Some(loc) = read_location_file(config_dir) else { return Startup { dir: default, notice: None } };
    let current = Some(loc.data_dir.trim()).filter(|d| !d.is_empty()).map(PathBuf::from);
    let mut notice = None;
    if let Some(to) = loc.pending_move.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(PathBuf::from) {
        let from = current.clone().unwrap_or_else(|| default.clone());
        // No command may write to the workspace while it is copied, and none may open the old
        // folder once `location.json` points to the new one: both happen under the hold.
        let moved = match crate::cmdlock::exclusive(&from, commands, wait) {
            Ok(_hold) => match move_workspace(&from, &to).and_then(|_| write_location(config_dir, &to)) {
                // A program that does not take part (an older one) holds the database.
                Err(e) if e.is_busy() => Err(NotMoved::Busy(String::new())),
                other => other.map_err(NotMoved::Failed),
            },
            Err(running) => Err(NotMoved::Busy(
                running.iter().map(|r| format!("arcalo {}", r.command)).collect::<Vec<_>>().join(", "),
            )),
        };
        match moved {
            Err(NotMoved::Busy(running)) => {
                let msg = if running.is_empty() {
                    trf!(
                        "Ein anderes Programm arbeitet gerade mit den Daten. Der Umzug nach {} folgt beim nächsten Start.",
                        "Another program is working with the data right now. The move to {} follows at the next start.",
                        to.display()
                    )
                } else {
                    trf!(
                        "Im Terminal läuft noch {running}. Der Umzug nach {} folgt beim nächsten Start.",
                        "{running} is still running in a terminal. The move to {} follows at the next start.",
                        to.display()
                    )
                };
                notice = Some(Notice::new("warning", msg));
            }
            Ok(()) => {
                let msg = trf!(
                    "Die Daten wurden nach {} verschoben. Der bisherige Ordner {} bleibt unverändert erhalten.",
                    "The data was moved to {}. The previous folder {} is kept unchanged.",
                    to.display(),
                    from.display()
                );
                return Startup { dir: to, notice: Some(Notice::new("info", msg)) };
            }
            Err(NotMoved::Failed(e)) => {
                let keep = Location { data_dir: loc.data_dir.clone(), pending_move: None };
                let _ = write_location_file(config_dir, &keep);
                let msg = trf!(
                    "Die Daten konnten nicht nach {} verschoben werden ({e}). Es wird weiter der bisherige Ordner verwendet.",
                    "The data could not be moved to {} ({e}). The previous folder is still used.",
                    to.display()
                );
                notice = Some(Notice::new("error", msg));
            }
        }
    }
    let Some(dir) = current else { return Startup { dir: default, notice } };
    if dir != default && !dir.join(DB_FILE).is_file() {
        let why = if dir.is_dir() {
            tr!("enthält keinen Arbeitsbereich", "contains no workspace")
        } else {
            tr!("ist nicht erreichbar", "is not reachable")
        };
        let msg = trf!(
            "Der Datenordner {} {why}. Vorübergehend wird der Standardordner {} verwendet.",
            "The data folder {} {why}. The default folder {} is used for now.",
            dir.display(),
            default.display()
        );
        return Startup { dir: default, notice: notice.or(Some(Notice::new("warning", msg))) };
    }
    Startup { dir, notice }
}

/// Why a pending move did not happen at this start.
enum NotMoved {
    /// Commands (named, or a program that holds the database) still work on the workspace: the
    /// move stays pending.
    Busy(String),
    /// The move failed: it is dropped.
    Failed(Error),
}

/// What a folder chosen as the new data folder looks like.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Target {
    /// The folder already holds a workspace (`workspace.db`).
    pub has_workspace: bool,
    /// The folder is a network share or inside OneDrive/Dropbox.
    pub synced: bool,
}

/// Checks that `to` can become the data folder of the workspace in `from`: an absolute,
/// writable folder that is neither `from` nor inside it. Creates `to` if needed.
pub fn check_target(from: &Path, to: &Path) -> Result<Target> {
    if to.as_os_str().is_empty() {
        return Err(Error::State(tr!("Kein Zielordner angegeben", "No target folder given").into()));
    }
    if !to.is_absolute() {
        return Err(Error::State(
            tr!("Bitte einen vollständigen Ordnerpfad wählen", "Please choose a full folder path").into(),
        ));
    }
    std::fs::create_dir_all(to).map_err(|e| Error::File { path: to.to_path_buf(), dir: true, source: e })?;
    let to_c = to.canonicalize().at(to)?;
    if let Ok(from_c) = from.canonicalize() {
        if from_c == to_c {
            return Err(Error::State(
                tr!("Die Daten liegen bereits in diesem Ordner", "The data is already in this folder").into(),
            ));
        }
        if to_c.starts_with(&from_c) {
            return Err(Error::State(
                tr!(
                    "Der Zielordner liegt im bisherigen Datenordner",
                    "The target folder is inside the current data folder"
                )
                .into(),
            ));
        }
    }
    let probe = to.join(".arcalo-write-test");
    std::fs::write(&probe, b"ok").at(to)?;
    let _ = std::fs::remove_file(&probe);
    Ok(Target { has_workspace: to.join(DB_FILE).exists(), synced: is_synced_or_network(&to.display().to_string()) })
}

/// Copies the closed workspace in `from` to `to`: everything goes to a staging folder
/// `to/.arcalo-move-tmp` first and is then renamed into place, the database last. An
/// interrupted move leaves no half-copied workspace behind and can simply be repeated.
/// Refuses a folder that already holds a workspace. Returns the files copied.
///
/// The database must be closed (or checkpointed) while this runs.
pub fn copy_workspace(from: &Path, to: &Path) -> Result<usize> {
    check_target(from, to)?;
    if to.join(DB_FILE).exists() {
        return Err(Error::State(trf!(
            "Im Zielordner liegt bereits eine Datenbank ({DB_FILE})",
            "The target folder already contains a database ({DB_FILE})"
        )));
    }
    if !from.join(DB_FILE).is_file() {
        return Err(Error::State(trf!(
            "Im bisherigen Ordner {} liegt keine Datenbank",
            "There is no database in the previous folder {}",
            from.display()
        )));
    }
    let staging = to.join(STAGING_DIR);
    // Left over from an interrupted attempt (of 1.14 and earlier: the old name).
    for left in [staging.clone(), to.join(crate::identity::legacy(STAGING_DIR))] {
        if left.exists() {
            std::fs::remove_dir_all(&left).at(&left)?;
        }
    }
    std::fs::create_dir_all(&staging).at(to)?;
    let result = stage_and_commit(from, to, &staging);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// The files of the database, main file last.
fn db_files() -> [String; 3] {
    [format!("{DB_FILE}-wal"), format!("{DB_FILE}-shm"), DB_FILE.to_owned()]
}

/// Holds the plain database `db` against every other connection until the returned connection
/// closes (`locking_mode=EXCLUSIVE`: the lock of a write transaction is kept). `None` for a file
/// that is missing or encrypted (it cannot be read without its key; the workspace lock of
/// [`crate::cmdlock`] alone keeps commands out then). A busy error when another program holds it.
fn lock_database(db: &Path) -> Result<Option<rusqlite::Connection>> {
    if crate::cipher::file_state(db) != crate::cipher::FileState::Plain {
        return Ok(None);
    }
    let conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(std::time::Duration::from_secs(2))?;
    conn.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;")?;
    Ok(Some(conn))
}

fn stage_and_commit(from: &Path, to: &Path, staging: &Path) -> Result<usize> {
    // First, so nothing is copied while another program writes.
    let held = lock_database(&from.join(DB_FILE))?;
    let mut n = 0;
    for dir in DATA_DIRS {
        let src = from.join(dir);
        if src.is_dir() {
            n += copy_dir(&src, &staging.join(dir))?;
        }
    }
    for name in DATA_FILES {
        let src = from.join(name);
        if src.is_file() {
            copy_file(&src, &staging.join(name))?;
            n += 1;
        }
    }
    match &held {
        // A consistent copy of the database with its WAL, through SQLite.
        Some(conn) => {
            conn.backup(rusqlite::MAIN_DB, staging.join(DB_FILE), None)?;
            n += 1;
        }
        // Encrypted: the files as they are (no program writes, see above).
        None => {
            for name in db_files() {
                let src = from.join(&name);
                if src.is_file() {
                    copy_file(&src, &staging.join(&name))?;
                    n += 1;
                }
            }
        }
    }
    // Commit: rename into place; the database file last, so a workspace only appears
    // in `to` once everything else is there.
    for name in DATA_DIRS.iter().chain(DATA_FILES.iter()).map(|s| s.to_string()).chain(db_files()) {
        let src = staging.join(&name);
        if src.exists() {
            move_into(&src, &to.join(&name))?;
        }
    }
    Ok(n)
}

/// Carries out a pending move of the closed workspace (see [`copy_workspace`]).
pub fn move_workspace(from: &Path, to: &Path) -> Result<usize> {
    copy_workspace(from, to)
}

/// Renames `src` to `dst`; merges into an existing folder entry by entry.
fn move_into(src: &Path, dst: &Path) -> Result<()> {
    if src.is_dir() && dst.is_dir() {
        for entry in std::fs::read_dir(src).at(src)?.flatten() {
            move_into(&entry.path(), &dst.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::rename(src, dst).at(dst)?;
    Ok(())
}

/// Copies regular files and folders recursively; symlinks are skipped.
fn copy_dir(src: &Path, dst: &Path) -> Result<usize> {
    std::fs::create_dir_all(dst).at(dst)?;
    let mut n = 0;
    for entry in std::fs::read_dir(src).at(src)?.flatten() {
        let kind = entry.file_type().at(entry.path())?;
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            n += copy_dir(&entry.path(), &to)?;
        } else if kind.is_file() {
            copy_file(&entry.path(), &to)?;
            n += 1;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_network_and_synced_folders() {
        for p in [
            r"\\server\share\Arcalo",
            "//nas/daten",
            r"C:\Users\anna\OneDrive - Firma\Arcalo",
            r"C:\Users\anna\onedrive\x",
            "/home/anna/Dropbox/arcalo",
        ] {
            assert!(is_synced_or_network(p), "{p}");
        }
        for p in [r"C:\Users\anna\AppData\Roaming\de.mousewerk.arcalo", "/home/anna/.local/share/arcalo", r"D:\Daten"] {
            assert!(!is_synced_or_network(p), "{p}");
        }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("arcalo-datadir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_program_beside_the_app_finds_its_data_folder_without_moving_it() {
        let base = temp("locate");
        let (cfg, default, chosen, target) =
            (base.join("cfg"), base.join("default"), base.join("chosen"), base.join("neu"));
        assert_eq!(locate(None, None, Some(&cfg), default.clone()), default, "no location.json");
        write_location(&cfg, &chosen).unwrap();
        assert_eq!(locate(None, None, Some(&cfg), default.clone()), default, "no workspace there (yet)");
        std::fs::create_dir_all(&chosen).unwrap();
        std::fs::write(chosen.join(DB_FILE), b"").unwrap();
        assert_eq!(locate(None, None, Some(&cfg), default.clone()), chosen);
        // A pending move stays pending: the workspace is still in the old folder.
        write_pending_move(&cfg, &chosen, &target).unwrap();
        assert_eq!(locate(None, None, Some(&cfg), default.clone()), chosen);
        assert!(!target.exists() && read_location_file(&cfg).unwrap().pending_move.is_some());
        // Portable, then the environment variable win.
        assert_eq!(locate(None, Some(base.join("stick")), Some(&cfg), default.clone()), base.join("stick"));
        assert_eq!(
            locate(Some(base.join("env")), Some(base.join("stick")), Some(&cfg), default.clone()),
            base.join("env")
        );
        assert_eq!(locate(Some(PathBuf::new()), None, None, default.clone()), default);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn portable_marker_decides_the_data_folder() {
        let base = temp("portable");
        let (exe, cfg, default) = (base.join("stick"), base.join("cfg"), base.join("default"));
        std::fs::create_dir_all(&exe).unwrap();
        assert_eq!(portable_data_dir(&exe), None, "no marker: installed");
        write_location(&cfg, &base.join("anderswo")).unwrap();
        let start = |portable| prepare_portable(None, portable, Some(&cfg), default.clone(), None);
        assert_eq!(start(portable_data_dir(&exe)).dir, default, "location.json of a missing folder: default");

        std::fs::write(exe.join(PORTABLE_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(&exe), Some(exe.join("data")));
        assert_eq!(
            start(portable_data_dir(&exe)),
            Startup { dir: exe.join("data"), notice: None },
            "location.json ignored"
        );
        // The environment variable (tests) still wins; an empty one does not count.
        let env = prepare_portable(Some(base.join("env")), portable_data_dir(&exe), Some(&cfg), default.clone(), None);
        assert_eq!(env.dir, base.join("env"));
        let empty = prepare_portable(Some(PathBuf::new()), portable_data_dir(&exe), Some(&cfg), default.clone(), None);
        assert_eq!(empty.dir, exe.join("data"));

        // A marker inside data/ alone also counts; a folder data/ without it does not.
        std::fs::remove_file(exe.join(PORTABLE_MARKER)).unwrap();
        std::fs::create_dir_all(exe.join("data")).unwrap();
        assert_eq!(portable_data_dir(&exe), None);
        std::fs::write(exe.join("data").join(PORTABLE_DATA_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(&exe), Some(exe.join("data")));
        // A marker that is a folder is not a marker.
        std::fs::remove_file(exe.join("data").join(PORTABLE_DATA_MARKER)).unwrap();
        std::fs::create_dir_all(exe.join(PORTABLE_MARKER)).unwrap();
        assert_eq!(portable_data_dir(&exe), None);
        // The markers of an Annalo copy (the new ZIP unpacked over an old folder) count too.
        std::fs::write(exe.join(LEGACY_PORTABLE_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(&exe), Some(exe.join("data")));
        std::fs::remove_file(exe.join(LEGACY_PORTABLE_MARKER)).unwrap();
        std::fs::write(exe.join("data").join(LEGACY_PORTABLE_DATA_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(&exe), Some(exe.join("data")));
        std::fs::remove_file(exe.join("data").join(LEGACY_PORTABLE_DATA_MARKER)).unwrap();
        assert_eq!(portable_data_dir(&exe), None);

        assert_eq!(exe_dir(Some(exe.clone())), Some(exe.clone()));
        assert!(exe_dir(None).is_some_and(|d| d.is_dir()));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn secret_namespace_is_per_folder() {
        let (a, b) = (temp("ns-a"), temp("ns-b"));
        let na = secret_namespace(&a);
        assert_eq!(na.len(), 12);
        assert!(na.bytes().all(|c| c.is_ascii_hexdigit()));
        std::fs::create_dir_all(a.join("x")).unwrap();
        assert_eq!(na, secret_namespace(&a.join("x").join("..")), "same folder, same namespace");
        assert_ne!(na, secret_namespace(&b));
        let _ = (std::fs::remove_dir_all(&a), std::fs::remove_dir_all(&b));
    }

    #[test]
    fn location_file_and_precedence() {
        let cfg = temp("cfg");
        let default = PathBuf::from("/default");
        assert_eq!(resolve(None, Some(&cfg), default.clone()), default);
        write_location(&cfg, Path::new("/daten/arcalo")).unwrap();
        assert_eq!(read_location(&cfg), Some(PathBuf::from("/daten/arcalo")));
        assert_eq!(resolve(None, Some(&cfg), default.clone()), PathBuf::from("/daten/arcalo"));
        assert_eq!(resolve(Some(PathBuf::from("/env")), Some(&cfg), default.clone()), PathBuf::from("/env"));
        std::fs::write(cfg.join(LOCATION_FILE), "kaputt").unwrap();
        assert_eq!(resolve(None, Some(&cfg), default.clone()), default, "a broken file is ignored");
        let _ = std::fs::remove_dir_all(&cfg);
    }

    fn sample_workspace(from: &Path) -> i64 {
        std::fs::create_dir_all(from).unwrap();
        let db = Database::open(from.join(DB_FILE)).unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(p.id, "Inhalt im WAL").unwrap();
        drop(db);
        std::fs::create_dir_all(from.join("attachments")).unwrap();
        std::fs::write(from.join("attachments/bild.png"), [1u8, 2]).unwrap();
        std::fs::create_dir_all(from.join("backups/attachments")).unwrap();
        std::fs::write(from.join("backups/arcalo-1.db"), [3u8]).unwrap();
        std::fs::write(from.join("backups/attachments/bild.png"), [1u8, 2]).unwrap();
        std::fs::write(from.join("secrets.json"), b"{}").unwrap();
        for f in ["trash/files/20260901T000000Z/alt.pdf", "logs/arcalo.log", "git-sync/.git/HEAD", "git-sync/Notiz.md"]
        {
            std::fs::create_dir_all(from.join(f).parent().unwrap()).unwrap();
            std::fs::write(from.join(f), b"x").unwrap();
        }
        p.id
    }

    #[test]
    fn copies_database_attachments_backups_and_secrets() {
        let from = temp("from");
        let to = temp("to").join("neu");
        let id = sample_workspace(&from);

        assert!(copy_workspace(&from, &from).is_err(), "same folder");
        assert!(copy_workspace(&from, &from.join("sub")).is_err(), "nested folder");
        assert!(copy_workspace(&from, Path::new("relativ")).is_err(), "relative path");
        // A failed earlier attempt left a staging folder: the retry cleans it up.
        std::fs::create_dir_all(to.join(STAGING_DIR).join("attachments")).unwrap();
        std::fs::write(to.join(STAGING_DIR).join(DB_FILE), b"halb").unwrap();
        std::fs::create_dir_all(to.join(".annalo-move-tmp")).unwrap(); // of 1.14
        assert!(copy_workspace(&from, &to).unwrap() >= 5);
        assert!(!to.join(STAGING_DIR).exists(), "staging folder removed");
        assert!(!to.join(".annalo-move-tmp").exists(), "and the one of 1.14");
        let copy = Database::open(to.join(DB_FILE)).unwrap();
        assert_eq!(copy.page_doc(id).unwrap().content, "Inhalt im WAL");
        assert_eq!(std::fs::read(to.join("attachments/bild.png")).unwrap(), [1, 2]);
        assert!(to.join("backups/attachments/bild.png").is_file());
        assert!(to.join("secrets.json").is_file());
        for f in ["trash/files/20260901T000000Z/alt.pdf", "logs/arcalo.log", "git-sync/.git/HEAD", "git-sync/Notiz.md"]
        {
            assert!(to.join(f).is_file(), "{f} moves along");
        }
        drop(copy);
        assert!(copy_workspace(&from, &to).is_err(), "never overwrites a workspace");
        assert!(from.join(DB_FILE).is_file(), "the old folder stays");
        let _ = std::fs::remove_dir_all(&from);
        let _ = std::fs::remove_dir_all(to.parent().unwrap());
    }

    #[test]
    fn target_check_reports_an_existing_workspace() {
        let from = temp("chk-from");
        let to = temp("chk-to");
        assert_eq!(check_target(&from, &to).unwrap(), Target { has_workspace: false, synced: false });
        std::fs::write(to.join(DB_FILE), b"").unwrap();
        assert_eq!(check_target(&from, &to).unwrap(), Target { has_workspace: true, synced: false });
        assert!(check_target(&from, &from).is_err());
        let _ = std::fs::remove_dir_all(&from);
        let _ = std::fs::remove_dir_all(&to);
    }

    #[test]
    fn startup_performs_a_pending_move() {
        let base = temp("pending");
        let (cfg, default, to) = (base.join("cfg"), base.join("default"), base.join("neu"));
        let id = sample_workspace(&default);
        assert_eq!(prepare(None, Some(&cfg), default.clone()), Startup { dir: default.clone(), notice: None });

        write_pending_move(&cfg, &default, &to).unwrap();
        let s = prepare(None, Some(&cfg), default.clone());
        assert_eq!(s.dir, to);
        assert_eq!(s.notice.unwrap().kind, "info");
        assert_eq!(
            read_location_file(&cfg).unwrap(),
            Location { data_dir: to.display().to_string(), pending_move: None }
        );
        assert_eq!(Database::open(to.join(DB_FILE)).unwrap().page_doc(id).unwrap().content, "Inhalt im WAL");
        // Next start: plain location, no notice.
        assert_eq!(prepare(None, Some(&cfg), default.clone()), Startup { dir: to.clone(), notice: None });

        // A move into a folder that already holds a workspace fails: the old folder stays.
        write_pending_move(&cfg, &to, &default).unwrap();
        let s = prepare(None, Some(&cfg), default.clone());
        assert_eq!(s.dir, to);
        assert_eq!(s.notice.unwrap().kind, "error");
        assert_eq!(read_location_file(&cfg).unwrap().pending_move, None, "pending move cleared");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// While the move copies a plain database, no other connection reads or writes it.
    #[test]
    fn the_database_is_held_while_it_is_copied() {
        let dir = temp("held");
        sample_workspace(&dir);
        let held = lock_database(&dir.join(DB_FILE)).unwrap().unwrap();
        let other = rusqlite::Connection::open(dir.join(DB_FILE)).unwrap();
        let err = other.execute("UPDATE pages SET title = 'x'", []).unwrap_err();
        assert!(Error::from(err).is_busy());
        drop(held);
        other.execute("UPDATE pages SET title = 'x'", []).unwrap();
        drop(other);
        // An encrypted (here: unreadable) or missing file is not held.
        std::fs::write(dir.join("other.db"), [7u8; 4096]).unwrap();
        assert!(lock_database(&dir.join("other.db")).unwrap().is_none());
        assert!(lock_database(&dir.join("missing.db")).unwrap().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A command line program writing to the workspace while the app starts: the move waits
    /// instead of copying a database that is being written.
    #[test]
    fn a_pending_move_waits_while_another_program_writes() {
        let base = temp("busy-move");
        let (cfg, default, to) = (base.join("cfg"), base.join("default"), base.join("neu"));
        let id = sample_workspace(&default);
        write_pending_move(&cfg, &default, &to).unwrap();
        // A command holds the workspace (its share): the move waits for the next start.
        let command = crate::cmdlock::share(&default).unwrap();
        let s = prepare_with(None, Some(&cfg), default.clone(), None, std::time::Duration::from_millis(200));
        assert_eq!((s.dir.clone(), s.notice.unwrap().kind), (default.clone(), "warning"));
        assert!(!to.join(DB_FILE).exists());
        drop(command);
        // Another program writes without taking part.
        let writer = Database::open(default.join(DB_FILE)).unwrap();
        writer.conn().execute_batch("BEGIN IMMEDIATE").unwrap();
        writer.conn().execute("UPDATE pages SET title = 'Während des Umzugs' WHERE id = ?1", [id]).unwrap();
        let s = prepare(None, Some(&cfg), default.clone());
        assert_eq!(s.dir, default, "the workspace stays where it is");
        assert_eq!(s.notice.unwrap().kind, "warning");
        assert!(!to.join(DB_FILE).exists());
        assert_eq!(read_location_file(&cfg).unwrap().pending_move, Some(to.display().to_string()), "still pending");
        writer.conn().execute_batch("COMMIT").unwrap();
        drop(writer);
        let s = prepare(None, Some(&cfg), default.clone());
        assert_eq!(s.dir, to);
        let copy = Database::open(to.join(DB_FILE)).unwrap();
        let title: String = copy.conn().query_row("SELECT title FROM pages WHERE id = ?1", [id], |r| r.get(0)).unwrap();
        assert_eq!(title, "Während des Umzugs");
        assert_eq!(copy.page_doc(id).unwrap().content, "Inhalt im WAL");
        drop(copy);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn startup_falls_back_when_the_folder_is_missing() {
        let base = temp("missing");
        let (cfg, default) = (base.join("cfg"), base.join("default"));
        write_location(&cfg, &base.join("usb-stick")).unwrap();
        let s = prepare(None, Some(&cfg), default.clone());
        assert_eq!(s.dir, default);
        let n = s.notice.unwrap();
        assert_eq!(n.kind, "warning");
        assert!(n.message.contains("nicht erreichbar"), "{}", n.message);
        // An existing folder without a workspace is not used either.
        std::fs::create_dir_all(base.join("leer")).unwrap();
        write_location(&cfg, &base.join("leer")).unwrap();
        assert!(prepare(None, Some(&cfg), default.clone()).notice.unwrap().message.contains("keinen Arbeitsbereich"));
        // The location file is kept, so the folder is used again once it is back.
        assert_eq!(read_location(&cfg), Some(base.join("leer")));
        // The environment variable wins.
        assert_eq!(prepare(Some(base.join("env")), Some(&cfg), default).dir, base.join("env"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Every file and folder the app keeps in the data folder and that belongs to the workspace
    /// moves with it; what is bound to this installation or rebuilt stays.
    #[test]
    fn a_move_takes_every_file_of_the_workspace() {
        let base = temp("every");
        let (from, to) = (base.join("alt"), base.join("neu"));
        sample_workspace(&from);
        let moved = [
            crate::cipher::MARKER.to_owned(),
            crate::cipher::NEW_FILE.to_owned(),
            crate::cipher::OLD_FILE.to_owned(),
            crate::cipher::WRAPPED_FILE.to_owned(),
            crate::cipher::WRAPPED_NEXT_FILE.to_owned(),
            crate::capture::QUEUE_FILE.to_owned(),
            crate::gitsync::RESTORED_FILE.to_owned(),
            crate::backupdest::REGISTRY_FILE.to_owned(),
            crate::backupdest::PENDING_RESTORE.to_owned(),
            format!("{}.from", crate::backupdest::PENDING_RESTORE),
            CREDENTIALS_MOVED.to_owned(),
            "secrets.json".to_owned(),
            "voice/rec-18f.wav".to_owned(),
            format!("{}/a.png", crate::attachments::DIR_NAME),
            format!("{}/x/b.pdf", crate::attachment_manager::TRASH_DIR),
            format!("{}/Notiz.md", crate::gitsync::REPO_DIR),
        ];
        let stays = [
            format!("{}/whisper/base.bin", "models"),
            format!("{}/state.json", crate::update_state::UPDATES_DIR),
            format!("{}/1.20.0/x", crate::update_state::ROLLBACK_DIR),
            format!("{}/1 time.lock", crate::cmdlock::DIR),
            crate::update_state::HEALTH_FILE.to_owned(),
            format!("{}/x.msg", crate::mail::TEMP_DIR),
            "scripts/outlook.ps1".to_owned(),
            "webview/x".to_owned(),
        ];
        for f in moved.iter().chain(&stays) {
            std::fs::create_dir_all(from.join(f).parent().unwrap()).unwrap();
            std::fs::write(from.join(f), f.as_bytes()).unwrap();
        }
        copy_workspace(&from, &to).unwrap();
        let missing: Vec<&String> =
            moved.iter().filter(|f| std::fs::read(to.join(f)).ok() != Some(f.as_bytes().to_vec())).collect();
        assert!(missing.is_empty(), "left in the old folder: {missing:?}");
        let taken: Vec<&String> = stays.iter().filter(|f| to.join(f).exists()).collect();
        assert!(taken.is_empty(), "moved although bound to the installation: {taken:?}");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn sources() -> Vec<PathBuf> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let mut files = vec![];
        let mut stack = vec![root.join("src"), root.join("../../src-tauri/src"), root.join("../arcalo-cli/src")];
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
        files
    }

    /// `const NAME: &str = <value>;` of a source file (the value as written).
    fn consts(code: &str) -> std::collections::HashMap<String, String> {
        let mut out = std::collections::HashMap::new();
        for line in code.lines() {
            let line = line.trim_start().trim_start_matches("pub(crate) ").trim_start_matches("pub ");
            let Some(rest) = line.strip_prefix("const ") else { continue };
            let Some((name, value)) = rest.split_once(": &str = ") else { continue };
            out.insert(name.trim().to_owned(), value.trim().trim_end_matches(';').to_owned());
        }
        out
    }

    type Consts = std::collections::HashMap<String, String>;

    /// The name a `data_dir.join(<arg>)` refers to: a literal, a constant (of the same file
    /// first) or a `format!` of constants; `None` for a legacy name of 1.14 and earlier.
    fn resolve_name(arg: &str, own: &Consts, all: &[Consts]) -> Option<String> {
        let arg = arg.trim().trim_start_matches('&');
        if arg.contains("legacy(") {
            return None;
        }
        if let Some(lit) = arg.strip_prefix('"') {
            return Some(lit.split('"').next().unwrap_or_default().to_owned());
        }
        let lookup = |name: &str| {
            own.get(name)
                .or_else(|| all.iter().find_map(|m| m.get(name)))
                .and_then(|v| resolve_name(v, own, all))
                .unwrap_or_else(|| panic!("constant {name} not found"))
        };
        if let Some(f) = arg.strip_prefix("format!(\"") {
            let mut text = f.split('"').next().unwrap_or_default().to_owned();
            while let Some(start) = text.find('{') {
                let end = text[start..].find('}').map_or(text.len() - 1, |e| start + e);
                let value = lookup(&text[start + 1..end]);
                text.replace_range(start..=end, &value);
            }
            return Some(text);
        }
        Some(lookup(arg.rsplit("::").next().unwrap_or(arg)))
    }

    /// Every name the app joins to the data folder moves with the workspace or is named in
    /// [`STAYS`], so a file added later cannot be left behind by a move unnoticed.
    #[test]
    fn every_name_in_the_data_folder_is_moved_or_stays_on_purpose() {
        let files = sources();
        assert!(files.len() > 50, "sources not found: {}", files.len());
        let texts: Vec<String> = files.iter().map(|f| std::fs::read_to_string(f).unwrap()).collect();
        let all: Vec<Consts> = texts.iter().map(|t| consts(t)).collect();
        let known: Vec<String> =
            DATA_DIRS.iter().chain(&DATA_FILES).chain(&STAYS).map(|s| s.to_string()).chain(db_files()).collect();
        let (mut seen, mut unknown) = (0, vec![]);
        for ((file, text), own) in files.iter().zip(&texts).zip(&all) {
            let code = text.split("#[cfg(test)]").next().unwrap_or_default();
            for pattern in ["data_dir.join(", "data_dir().join("] {
                for (at, _) in code.match_indices(pattern) {
                    let rest = &code[at + pattern.len()..];
                    // The argument, up to its closing parenthesis.
                    let mut depth = 0;
                    let mut end = rest.len();
                    for (i, c) in rest.char_indices() {
                        match c {
                            '(' => depth += 1,
                            ')' if depth == 0 => {
                                end = i;
                                break;
                            }
                            ')' => depth -= 1,
                            _ => {}
                        }
                    }
                    let arg = rest[..end].trim();
                    // The two lock files of the instance check, joined in a loop.
                    if file.ends_with("portable.rs") && arg == "name" {
                        continue;
                    }
                    seen += 1;
                    let Some(name) = resolve_name(arg, own, &all) else { continue };
                    // Temporary files of an atomic write.
                    if name.starts_with('.') && (name.ends_with(".part") || name.ends_with(".partial")) {
                        continue;
                    }
                    let first = name.split('/').next().unwrap_or_default();
                    if !known.iter().any(|k| k == first || *k == name) {
                        unknown.push(format!("{}: {arg} = {name}", file.display()));
                    }
                }
            }
        }
        assert!(seen > 30, "too few uses of the data folder found: {seen}");
        assert!(
            unknown.is_empty(),
            "add to DATA_DIRS/DATA_FILES (moved) or STAYS in datadir.rs:\n{}",
            unknown.join("\n")
        );
    }
}
