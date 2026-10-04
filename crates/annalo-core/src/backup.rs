//! Database backups: consistent snapshots written with `VACUUM INTO` as
//! `arcalo-YYYYMMDD-HHMMSS.db` (UTC, so names sort chronologically across DST
//! changes), pruned to the newest `keep`. Times are shown in local time. Backups from before
//! the rename to Arcalo (`annalo-YYYYMMDD-HHMMSS.db`) are listed, restored and pruned alike.

use crate::trf;
use std::fs;
use std::path::Path;

use chrono::{DateTime, Local, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, IoAt, Result};

const STAMP: &str = "%Y%m%d-%H%M%S";
/// File name prefix of new backups.
pub const PREFIX: &str = "arcalo-";
/// File name prefix of backups written before 1.7 (Annalo).
pub const LEGACY_PREFIX: &str = "annalo-";

/// The `YYYYMMDD-HHMMSS` part of a backup's file name (`arcalo-….db` or `annalo-….db`).
pub fn stamp_part(file_name: &str) -> Option<&str> {
    file_name.strip_prefix(PREFIX).or_else(|| file_name.strip_prefix(LEGACY_PREFIX))?.strip_suffix(".db")
}

/// Whether `file_name` is named like a backup of this app (either prefix, any stamp).
pub fn has_backup_prefix(file_name: &str) -> bool {
    (file_name.starts_with(PREFIX) || file_name.starts_with(LEGACY_PREFIX)) && file_name.ends_with(".db")
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupInfo {
    pub path: String,
    pub file_name: String,
    pub created_at: DateTime<Local>,
    pub size_bytes: u64,
}

/// Parses `arcalo-YYYYMMDD-HHMMSS.db` (or `annalo-…`, UTC) into local time; other files in the
/// folder are ignored.
fn backup_time(file_name: &str) -> Option<DateTime<Local>> {
    let stamp = stamp_part(file_name)?;
    let naive = NaiveDateTime::parse_from_str(stamp, STAMP).ok()?;
    Some(naive.and_utc().with_timezone(&Local))
}

fn info(path: &Path, file_name: &str) -> Option<BackupInfo> {
    let meta = fs::metadata(path).ok().filter(|m| m.is_file())?;
    Some(BackupInfo {
        path: path.display().to_string(),
        file_name: file_name.to_owned(),
        created_at: backup_time(file_name)?,
        size_bytes: meta.len(),
    })
}

/// Backups in `dir`, newest first. A missing folder has none.
pub fn list_backups(dir: &Path) -> Result<Vec<BackupInfo>> {
    let Ok(entries) = fs::read_dir(dir) else { return Ok(vec![]) };
    let mut out: Vec<BackupInfo> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_owned();
            info(&e.path(), &name)
        })
        .collect();
    // Newest first by the UTC stamp in the name (both prefixes mix in one folder after the rename).
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at).then_with(|| b.file_name.cmp(&a.file_name)));
    Ok(out)
}

/// Writes a snapshot of `db` into `dir` and deletes all but the newest `keep` (at least 1) backups.
pub fn backup_to(db: &Database, dir: &Path, keep: usize) -> Result<BackupInfo> {
    backup_at(db, dir, keep, Utc::now().naive_utc())
}

/// `now` is UTC.
fn backup_at(db: &Database, dir: &Path, keep: usize, now: NaiveDateTime) -> Result<BackupInfo> {
    fs::create_dir_all(dir).at(dir)?;
    remove_stale_partials(dir);
    let name = format!("{PREFIX}{}.db", now.format(STAMP));
    let path = dir.join(&name);
    // A second backup within the same second replaces the first (once it is complete).
    vacuum_into(db, &path)?;
    let fresh = info(&path, &name).ok_or_else(|| Error::not_found("backup", name.clone()))?;
    prune(dir, keep, &name)?;
    Ok(fresh)
}

/// Suffix of a backup while it is written.
const PARTIAL: &str = ".partial";

/// Writes a snapshot of `db` to `path` through `<path>.partial` (synced, then renamed over
/// `path`), so a backup cut off by a kill, a full disk or a vanished drive never leaves a
/// truncated file under a backup's name, where it would count as the newest backup (retention,
/// destinations, the start-up recovery) and push a good one out of the rotation.
fn vacuum_into(db: &Database, path: &Path) -> Result<()> {
    let part = std::path::PathBuf::from(format!("{}{PARTIAL}", path.display()));
    // VACUUM INTO refuses an existing file.
    let _ = fs::remove_file(&part);
    let target =
        part.to_str().ok_or_else(|| Error::State(trf!("Ungültiger Pfad: {}", "Invalid path: {}", path.display())))?;
    if let Err(e) = db.conn().execute("VACUUM INTO ?1", [target]) {
        let _ = fs::remove_file(&part);
        return Err(e.into());
    }
    let res = fs::File::open(&part).and_then(|f| f.sync_all()).and_then(|()| fs::rename(&part, path));
    if let Err(e) = res {
        let _ = fs::remove_file(&part);
        return Err(Error::file(path, e));
    }
    Ok(())
}

/// Removes backups of an earlier run that never finished (`arcalo-….db.partial`).
fn remove_stale_partials(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.strip_suffix(PARTIAL).is_some_and(has_backup_prefix) {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Deletes all but the newest `keep` (at least 1) backups in `dir`; `fresh` always counts as one
/// of the kept ones, even if the clock went backwards. Returns the names deleted.
pub fn prune(dir: &Path, keep: usize, fresh: &str) -> Result<Vec<String>> {
    let others = list_backups(dir)?.into_iter().filter(|b| b.file_name != fresh);
    let mut gone = Vec::new();
    for old in others.skip(keep.max(1) - 1) {
        fs::remove_file(&old.path).at(&old.path)?;
        gone.push(old.file_name);
    }
    Ok(gone)
}

/// Writes a snapshot of `db` as `dir/name` (a tagged backup such as the one before an update,
/// which the rotation of [`backup_to`] does not count or delete). Older files starting with
/// `tag` are deleted except the newest `keep_tagged` (the new one included).
pub fn backup_named(
    db: &Database,
    dir: &Path,
    name: &str,
    tag: &str,
    keep_tagged: usize,
) -> Result<std::path::PathBuf> {
    fs::create_dir_all(dir).at(dir)?;
    let path = dir.join(name);
    vacuum_into(db, &path)?;
    let mut tagged: Vec<(std::time::SystemTime, std::path::PathBuf)> = fs::read_dir(dir)
        .at(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_str().is_some_and(|n| n.starts_with(tag) && n != name))
        .map(|e| (e.metadata().and_then(|m| m.modified()).unwrap_or(std::time::UNIX_EPOCH), e.path()))
        .collect();
    tagged.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, old) in tagged.into_iter().skip(keep_tagged.max(1) - 1) {
        let _ = fs::remove_file(old);
    }
    Ok(path)
}

/// What [`restore_from`] set aside: [`SetAside::undo`] puts the previous database back.
#[derive(Debug)]
pub struct SetAside {
    db_file: std::path::PathBuf,
    /// `(original name, kept name)` of the database and its WAL files.
    moved: Vec<(std::path::PathBuf, std::path::PathBuf)>,
}

impl SetAside {
    /// Removes the restored file and renames the kept files back (a later step failed).
    pub fn undo(&self) -> Result<()> {
        for ext in ["-wal", "-shm"] {
            let _ = fs::remove_file(format!("{}{ext}", self.db_file.display()));
        }
        if self.db_file.exists() {
            fs::remove_file(&self.db_file).at(&self.db_file)?;
        }
        for (from, kept) in &self.moved {
            fs::rename(kept, from).at(kept)?;
        }
        Ok(())
    }
}

/// Puts the backup file `backup` in place of the database `db_file`. The current file and its
/// WAL files are kept as `<name>.<keep_as>-<stamp>`; when the copy fails they are put back.
pub fn restore_from(db_file: &Path, backup: &Path, keep_as: &str, now: DateTime<Utc>) -> Result<SetAside> {
    let stamp = now.format(STAMP);
    let mut aside = SetAside { db_file: db_file.to_path_buf(), moved: vec![] };
    for ext in ["", "-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{ext}", db_file.display()));
        if from.exists() {
            let kept = std::path::PathBuf::from(format!("{}{ext}.{keep_as}-{stamp}", db_file.display()));
            if let Err(e) = fs::rename(&from, &kept).at(&from) {
                let _ = aside.undo();
                return Err(e);
            }
            aside.moved.push((from, kept));
        }
    }
    let tmp = db_file.with_extension("restore-part");
    if let Err(e) = fs::copy(backup, &tmp).and_then(|_| fs::rename(&tmp, db_file)).at(db_file) {
        let _ = fs::remove_file(&tmp);
        let _ = aside.undo();
        return Err(e);
    }
    Ok(aside)
}

/// Puts the newest backup of `backups` in place of the database `db_file` (start-up recovery
/// of a broken database). The broken file and its WAL files are kept as
/// `<name>.broken-<stamp>`. Returns the backup used.
pub fn restore_latest(db_file: &Path, backups: &Path, now: DateTime<Utc>) -> Result<BackupInfo> {
    let latest = list_backups(backups)?.into_iter().next().ok_or_else(|| {
        Error::State(trf!(
            "Im Ordner {} liegt keine Sicherung",
            "There is no backup in the folder {}",
            backups.display()
        ))
    })?;
    restore_from(db_file, Path::new(&latest.path), "broken", now)?;
    Ok(latest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_broken_database_is_replaced_by_the_newest_backup() {
        let dir = std::env::temp_dir().join(format!("annalo-restore-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db_file = dir.join("workspace.db");
        let backups = dir.join("backups");
        assert!(restore_latest(&db_file, &backups, Utc::now()).is_err(), "no backup yet");
        {
            let db = Database::open(&db_file).unwrap();
            let p = db.create_page(None, "Gesichert", None).unwrap();
            db.save_page_content(p.id, "aus der Sicherung").unwrap();
            backup_to(&db, &backups, 3).unwrap();
        }
        fs::write(&db_file, b"kein SQLite").unwrap();
        assert!(Database::open(&db_file).is_err());
        let used = restore_latest(&db_file, &backups, Utc::now()).unwrap();
        assert!(used.file_name.starts_with("arcalo-"));
        let db = Database::open(&db_file).unwrap();
        let p = db.page_by_title("Gesichert").unwrap().unwrap();
        assert_eq!(db.page_doc(p.id).unwrap().content, "aus der Sicherung");
        let kept = fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains(".broken-"));
        assert!(kept, "the broken file is kept");
        drop(db);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn snapshots_are_readable_and_pruned() {
        let dir = std::env::temp_dir().join(format!("annalo-backup-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Gesichert", None).unwrap();
        db.save_page_content(p.id, "Wichtiger Inhalt").unwrap();

        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("notiz.txt"), "fremd").unwrap();
        let at = |h: u32| chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap().and_hms_opt(h, 0, 0).unwrap();
        for h in 1..=4 {
            backup_at(&db, &dir, 2, at(h)).unwrap();
        }
        let list = list_backups(&dir).unwrap();
        let names: Vec<_> = list.iter().map(|b| b.file_name.as_str()).collect();
        assert_eq!(names, ["arcalo-20260923-040000.db", "arcalo-20260923-030000.db"]);
        assert!(list[0].size_bytes > 0);
        assert!(dir.join("notiz.txt").exists(), "other files are left alone");

        // Same second again: replaced, not failed.
        backup_at(&db, &dir, 2, at(4)).unwrap();
        let copy = Database::open(&list[0].path).unwrap();
        assert_eq!(copy.page_doc(p.id).unwrap().content, "Wichtiger Inhalt");
        drop(copy);

        let fresh = backup_at(&db, &dir, 1, at(5)).unwrap();
        assert_eq!(list_backups(&dir).unwrap(), vec![fresh]);

        // A clock that went backwards never costs the new backup.
        let earlier = backup_at(&db, &dir, 1, at(2)).unwrap();
        assert_eq!(list_backups(&dir).unwrap(), vec![earlier.clone()]);
        assert_eq!(earlier.created_at, at(2).and_utc().with_timezone(&Local), "UTC name, local display");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_backup_leaves_no_file_under_a_backup_name() {
        let dir = std::env::temp_dir().join(format!("annalo-backup-partial-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Gesichert", None).unwrap();
        db.save_page_content(p.id, "erste Sicherung").unwrap();
        let at = chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap().and_hms_opt(1, 0, 0).unwrap();
        let first = backup_at(&db, &dir, 3, at).unwrap();
        // A backup killed mid-write left its partial file: never listed, removed by the next run.
        let stale = dir.join("arcalo-20260923-005900.db.partial");
        fs::write(&stale, b"abgebrochen").unwrap();
        assert_eq!(list_backups(&dir).unwrap(), vec![first.clone()]);
        // The next backup of the same second cannot be written (a folder takes its partial
        // path): the complete backup under that name stays.
        let blocked = dir.join(format!("{}.partial", first.file_name));
        fs::create_dir_all(&blocked).unwrap();
        assert!(backup_at(&db, &dir, 3, at).is_err());
        let copy = Database::open(&first.path).unwrap();
        assert_eq!(copy.page_doc(p.id).unwrap().content, "erste Sicherung");
        drop(copy);
        assert!(!stale.exists(), "stale partial removed");
        fs::remove_dir_all(&blocked).unwrap();
        let named = backup_named(&db, &dir, "arcalo-pre-update-1.11.0-1.12.0.db", "arcalo-pre-update-", 2).unwrap();
        assert!(named.is_file());
        let left =
            fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".partial"));
        assert_eq!(left.count(), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn backups_from_before_the_rename_are_listed_restored_and_pruned() {
        let dir = std::env::temp_dir().join(format!("annalo-backup-legacy-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).unwrap();
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Alt", None).unwrap();
        db.save_page_content(p.id, "aus Annalo 1.6").unwrap();
        // Written by 1.6: an `annalo-` name, newer than the `arcalo-` one beside it.
        let at = |h: u32| chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap().and_hms_opt(h, 0, 0).unwrap();
        backup_at(&db, &backups, 5, at(1)).unwrap();
        let legacy = backups.join("annalo-20260923-020000.db");
        db.conn().execute("VACUUM INTO ?1", [legacy.to_str().unwrap()]).unwrap();
        let names: Vec<_> = list_backups(&backups).unwrap().into_iter().map(|b| b.file_name).collect();
        assert_eq!(names, ["annalo-20260923-020000.db", "arcalo-20260923-010000.db"], "newest first, both prefixes");
        assert_eq!(stamp_part("annalo-20260923-020000.db"), Some("20260923-020000"));
        assert!(has_backup_prefix("annalo-x.db") && has_backup_prefix("arcalo-x.db") && !has_backup_prefix("x.db"));

        let db_file = dir.join("workspace.db");
        fs::write(&db_file, b"kaputt").unwrap();
        let used = restore_latest(&db_file, &backups, Utc::now()).unwrap();
        assert_eq!(used.file_name, "annalo-20260923-020000.db");
        let restored = Database::open(&db_file).unwrap();
        assert_eq!(restored.page_doc(p.id).unwrap().content, "aus Annalo 1.6");
        drop(restored);

        // A new backup prunes the old names like its own.
        backup_at(&db, &backups, 1, at(3)).unwrap();
        let names: Vec<_> = list_backups(&backups).unwrap().into_iter().map(|b| b.file_name).collect();
        assert_eq!(names, ["arcalo-20260923-030000.db"]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn tagged_backups_stay_out_of_the_rotation() {
        let dir = std::env::temp_dir().join(format!("annalo-backup-tagged-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let db = Database::open_in_memory().unwrap();
        let tag = "arcalo-pre-update-";
        let a = backup_named(&db, &dir, "arcalo-pre-update-1.8.0-1.9.0.db", tag, 2).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        backup_named(&db, &dir, "arcalo-pre-update-1.9.0-1.9.1.db", tag, 2).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let c = backup_named(&db, &dir, "arcalo-pre-update-1.9.1-1.9.2.db", tag, 2).unwrap();
        assert!(!a.exists(), "only the newest two are kept");
        assert!(c.exists() && dir.join("arcalo-pre-update-1.9.0-1.9.1.db").exists());
        assert!(list_backups(&dir).unwrap().is_empty(), "not listed with the regular backups");
        backup_to(&db, &dir, 1).unwrap();
        assert!(c.exists(), "the rotation leaves them alone");
        // Restoring keeps the current file aside.
        let db_file = dir.join("workspace.db");
        fs::write(&db_file, b"now").unwrap();
        fs::write(dir.join("workspace.db-wal"), b"wal").unwrap();
        let aside = restore_from(&db_file, &c, "before-rollback", Utc::now()).unwrap();
        assert_eq!(fs::read(&db_file).unwrap(), fs::read(&c).unwrap());
        assert!(!dir.join("workspace.db-wal").exists());
        assert!(
            fs::read_dir(&dir).unwrap().any(|e| e
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with("workspace.db.before-rollback-"))
        );
        // A later step failed: the previous file and its WAL come back.
        aside.undo().unwrap();
        assert_eq!(fs::read(&db_file).unwrap(), b"now");
        assert_eq!(fs::read(dir.join("workspace.db-wal")).unwrap(), b"wal");
        // A backup that cannot be read leaves the database as it was.
        assert!(restore_from(&db_file, &dir.join("missing.db"), "x", Utc::now()).is_err());
        assert_eq!(fs::read(&db_file).unwrap(), b"now");
        assert_eq!(fs::read(dir.join("workspace.db-wal")).unwrap(), b"wal");
        let _ = fs::remove_dir_all(&dir);
    }
}
