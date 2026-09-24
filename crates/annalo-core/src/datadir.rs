//! Where the workspace lives.
//!
//! The data folder holds `workspace.db` (+ WAL files), `attachments/`, `backups/` and
//! `secrets.json`. By default it is the app data folder; a bootstrap file `location.json`
//! (`{"data_dir": "…"}`) in the app config folder points elsewhere, and the
//! `ANNALO_DATA_DIR` environment variable (tests) overrides both.
//!
//! Moving happens in two steps so no edit is lost: choosing a folder only records a
//! pending move (`{"data_dir": old, "pending_move": new}`); the next start copies the
//! closed workspace before the database is opened ([`prepare`]). The old folder is left
//! untouched.
//!
//! Portable mode: a file `annalo-portable` next to the executable (or a folder `data/` there
//! holding the marker `.annalo-portable`) keeps everything in `<exe dir>/data`, and
//! `location.json` is neither read nor written ([`portable_data_dir`], [`prepare_portable`]).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};

pub const DB_FILE: &str = "workspace.db";
/// Name of the bootstrap file in the app config folder.
pub const LOCATION_FILE: &str = "location.json";
/// Staging folder inside the target while a move copies files.
pub const STAGING_DIR: &str = ".annalo-move-tmp";
/// Folders and files next to the database that move with it (the database goes last).
const DATA_DIRS: [&str; 2] = ["attachments", "backups"];
const DATA_FILES: [&str; 1] = ["secrets.json"];

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
    std::fs::create_dir_all(config_dir)?;
    let json = serde_json::to_string_pretty(loc)?;
    let tmp = config_dir.join(format!(".{LOCATION_FILE}.part"));
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, config_dir.join(LOCATION_FILE))?;
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

/// The data folder to open: `env` (ANNALO_DATA_DIR) wins, then `location.json`, then `default`.
pub fn resolve(env: Option<PathBuf>, config_dir: Option<&Path>, default: PathBuf) -> PathBuf {
    env.filter(|p| !p.as_os_str().is_empty()).or_else(|| config_dir.and_then(read_location)).unwrap_or(default)
}

/// Marker file next to the executable that switches on portable mode.
pub const PORTABLE_MARKER: &str = "annalo-portable";
/// The data folder of a portable copy, next to the executable.
pub const PORTABLE_DATA: &str = "data";
/// Marker inside `data/`: the folder alone (without [`PORTABLE_MARKER`]) also means portable.
pub const PORTABLE_DATA_MARKER: &str = ".annalo-portable";

/// The folder of the running executable; `env` (`ANNALO_EXE_DIR`, tests) stands in for it.
pub fn exe_dir(env: Option<PathBuf>) -> Option<PathBuf> {
    env.filter(|p| !p.as_os_str().is_empty())
        .or_else(|| std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)))
}

/// `<exe dir>/data` when the copy next to `exe_dir` is portable, else `None`.
pub fn portable_data_dir(exe_dir: &Path) -> Option<PathBuf> {
    let data = exe_dir.join(PORTABLE_DATA);
    (exe_dir.join(PORTABLE_MARKER).is_file() || data.join(PORTABLE_DATA_MARKER).is_file()).then_some(data)
}

/// Like [`prepare`], with a portable data folder first: `env` still wins (tests), then
/// `portable` (`location.json` is ignored), then the usual order.
pub fn prepare_portable(
    env: Option<PathBuf>,
    portable: Option<PathBuf>,
    config_dir: Option<&Path>,
    default: PathBuf,
) -> Startup {
    let env = env.filter(|p| !p.as_os_str().is_empty());
    match (env, portable) {
        (None, Some(dir)) => Startup { dir, notice: None },
        (env, _) => prepare(env, config_dir, default),
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
}

impl Notice {
    fn new(kind: &'static str, message: String) -> Self {
        Notice { kind, message }
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
    if let Some(dir) = env.filter(|p| !p.as_os_str().is_empty()) {
        return Startup { dir, notice: None };
    }
    let Some(config_dir) = config_dir else { return Startup { dir: default, notice: None } };
    let Some(loc) = read_location_file(config_dir) else { return Startup { dir: default, notice: None } };
    let current = Some(loc.data_dir.trim()).filter(|d| !d.is_empty()).map(PathBuf::from);
    let mut notice = None;
    if let Some(to) = loc.pending_move.as_deref().map(str::trim).filter(|d| !d.is_empty()).map(PathBuf::from) {
        let from = current.clone().unwrap_or_else(|| default.clone());
        match move_workspace(&from, &to).and_then(|_| write_location(config_dir, &to)) {
            Ok(()) => {
                let msg = format!(
                    "Die Daten wurden nach {} verschoben. Der bisherige Ordner {} bleibt unverändert erhalten.",
                    to.display(),
                    from.display()
                );
                return Startup { dir: to, notice: Some(Notice::new("info", msg)) };
            }
            Err(e) => {
                let keep = Location { data_dir: loc.data_dir.clone(), pending_move: None };
                let _ = write_location_file(config_dir, &keep);
                let msg = format!(
                    "Die Daten konnten nicht nach {} verschoben werden ({e}). Es wird weiter der bisherige Ordner verwendet.",
                    to.display()
                );
                notice = Some(Notice::new("error", msg));
            }
        }
    }
    let Some(dir) = current else { return Startup { dir: default, notice } };
    if dir != default && !dir.join(DB_FILE).is_file() {
        let why = if dir.is_dir() { "enthält keinen Arbeitsbereich" } else { "ist nicht erreichbar" };
        let msg = format!(
            "Der Datenordner {} {why}. Vorübergehend wird der Standardordner {} verwendet.",
            dir.display(),
            default.display()
        );
        return Startup { dir: default, notice: notice.or(Some(Notice::new("warning", msg))) };
    }
    Startup { dir, notice }
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
        return Err(Error::State("Kein Zielordner angegeben".into()));
    }
    if !to.is_absolute() {
        return Err(Error::State("Bitte einen vollständigen Ordnerpfad wählen".into()));
    }
    std::fs::create_dir_all(to)
        .map_err(|e| Error::State(format!("Der Ordner {} kann nicht angelegt werden: {e}", to.display())))?;
    let to_c = to.canonicalize()?;
    if let Ok(from_c) = from.canonicalize() {
        if from_c == to_c {
            return Err(Error::State("Die Daten liegen bereits in diesem Ordner".into()));
        }
        if to_c.starts_with(&from_c) {
            return Err(Error::State("Der Zielordner liegt im bisherigen Datenordner".into()));
        }
    }
    let probe = to.join(".annalo-write-test");
    std::fs::write(&probe, b"ok")
        .map_err(|e| Error::State(format!("In den Ordner {} kann nicht geschrieben werden: {e}", to.display())))?;
    let _ = std::fs::remove_file(&probe);
    Ok(Target { has_workspace: to.join(DB_FILE).exists(), synced: is_synced_or_network(&to.display().to_string()) })
}

/// Copies the closed workspace in `from` to `to`: everything goes to a staging folder
/// `to/.annalo-move-tmp` first and is then renamed into place, the database last. An
/// interrupted move leaves no half-copied workspace behind and can simply be repeated.
/// Refuses a folder that already holds a workspace. Returns the files copied.
///
/// The database must be closed (or checkpointed) while this runs.
pub fn copy_workspace(from: &Path, to: &Path) -> Result<usize> {
    check_target(from, to)?;
    if to.join(DB_FILE).exists() {
        return Err(Error::State(format!("Im Zielordner liegt bereits eine Datenbank ({DB_FILE})")));
    }
    if !from.join(DB_FILE).is_file() {
        return Err(Error::State(format!("Im bisherigen Ordner {} liegt keine Datenbank", from.display())));
    }
    let staging = to.join(STAGING_DIR);
    if staging.exists() {
        std::fs::remove_dir_all(&staging)?; // left over from an interrupted attempt
    }
    std::fs::create_dir_all(&staging)?;
    let result = stage_and_commit(from, to, &staging);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// The files of the database, main file last.
fn db_files() -> [String; 3] {
    [format!("{DB_FILE}-wal"), format!("{DB_FILE}-shm"), DB_FILE.to_owned()]
}

fn stage_and_commit(from: &Path, to: &Path, staging: &Path) -> Result<usize> {
    let mut n = 0;
    for dir in DATA_DIRS {
        let src = from.join(dir);
        if src.is_dir() {
            n += copy_dir(&src, &staging.join(dir))?;
        }
    }
    for name in DATA_FILES.iter().map(|s| s.to_string()).chain(db_files()) {
        let src = from.join(&name);
        if src.is_file() {
            std::fs::copy(&src, staging.join(&name))?;
            n += 1;
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
        for entry in std::fs::read_dir(src)?.flatten() {
            move_into(&entry.path(), &dst.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::rename(src, dst)?;
    Ok(())
}

/// Copies regular files and folders recursively; symlinks are skipped.
fn copy_dir(src: &Path, dst: &Path) -> Result<usize> {
    std::fs::create_dir_all(dst)?;
    let mut n = 0;
    for entry in std::fs::read_dir(src)?.flatten() {
        let kind = entry.file_type()?;
        let to = dst.join(entry.file_name());
        if kind.is_dir() {
            n += copy_dir(&entry.path(), &to)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), &to)?;
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
            r"\\server\share\Annalo",
            "//nas/daten",
            r"C:\Users\anna\OneDrive - Firma\Annalo",
            r"C:\Users\anna\onedrive\x",
            "/home/anna/Dropbox/annalo",
        ] {
            assert!(is_synced_or_network(p), "{p}");
        }
        for p in [r"C:\Users\anna\AppData\Roaming\app.annalo.desktop", "/home/anna/.local/share/annalo", r"D:\Daten"] {
            assert!(!is_synced_or_network(p), "{p}");
        }
    }

    fn temp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("annalo-datadir-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn portable_marker_decides_the_data_folder() {
        let base = temp("portable");
        let (exe, cfg, default) = (base.join("stick"), base.join("cfg"), base.join("default"));
        std::fs::create_dir_all(&exe).unwrap();
        assert_eq!(portable_data_dir(&exe), None, "no marker: installed");
        write_location(&cfg, &base.join("anderswo")).unwrap();
        let start = |portable| prepare_portable(None, portable, Some(&cfg), default.clone());
        assert_eq!(start(portable_data_dir(&exe)).dir, default, "location.json of a missing folder: default");

        std::fs::write(exe.join(PORTABLE_MARKER), b"").unwrap();
        assert_eq!(portable_data_dir(&exe), Some(exe.join("data")));
        assert_eq!(
            start(portable_data_dir(&exe)),
            Startup { dir: exe.join("data"), notice: None },
            "location.json ignored"
        );
        // The environment variable (tests) still wins; an empty one does not count.
        let env = prepare_portable(Some(base.join("env")), portable_data_dir(&exe), Some(&cfg), default.clone());
        assert_eq!(env.dir, base.join("env"));
        let empty = prepare_portable(Some(PathBuf::new()), portable_data_dir(&exe), Some(&cfg), default.clone());
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
        write_location(&cfg, Path::new("/daten/annalo")).unwrap();
        assert_eq!(read_location(&cfg), Some(PathBuf::from("/daten/annalo")));
        assert_eq!(resolve(None, Some(&cfg), default.clone()), PathBuf::from("/daten/annalo"));
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
        std::fs::write(from.join("backups/annalo-1.db"), [3u8]).unwrap();
        std::fs::write(from.join("backups/attachments/bild.png"), [1u8, 2]).unwrap();
        std::fs::write(from.join("secrets.json"), b"{}").unwrap();
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
        assert!(copy_workspace(&from, &to).unwrap() >= 5);
        assert!(!to.join(STAGING_DIR).exists(), "staging folder removed");
        let copy = Database::open(to.join(DB_FILE)).unwrap();
        assert_eq!(copy.page_doc(id).unwrap().content, "Inhalt im WAL");
        assert_eq!(std::fs::read(to.join("attachments/bild.png")).unwrap(), [1, 2]);
        assert!(to.join("backups/attachments/bild.png").is_file());
        assert!(to.join("secrets.json").is_file());
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
}
