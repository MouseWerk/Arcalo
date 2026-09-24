//! Database backups: consistent snapshots written with `VACUUM INTO` as
//! `annalo-YYYYMMDD-HHMMSS.db` (UTC, so names sort chronologically across DST
//! changes), pruned to the newest `keep`. Times are shown in local time.

use std::fs;
use std::path::Path;

use chrono::{DateTime, Local, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};

const STAMP: &str = "%Y%m%d-%H%M%S";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BackupInfo {
    pub path: String,
    pub file_name: String,
    pub created_at: DateTime<Local>,
    pub size_bytes: u64,
}

/// Parses `annalo-YYYYMMDD-HHMMSS.db` (UTC) into local time; other files in the folder are ignored.
fn backup_time(file_name: &str) -> Option<DateTime<Local>> {
    let stamp = file_name.strip_prefix("annalo-")?.strip_suffix(".db")?;
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
    // UTC stamps: the name order is the creation order.
    out.sort_by(|a, b| b.file_name.cmp(&a.file_name));
    Ok(out)
}

/// Writes a snapshot of `db` into `dir` and deletes all but the newest `keep` (at least 1) backups.
pub fn backup_to(db: &Database, dir: &Path, keep: usize) -> Result<BackupInfo> {
    backup_at(db, dir, keep, Utc::now().naive_utc())
}

/// `now` is UTC.
fn backup_at(db: &Database, dir: &Path, keep: usize, now: NaiveDateTime) -> Result<BackupInfo> {
    fs::create_dir_all(dir)?;
    let name = format!("annalo-{}.db", now.format(STAMP));
    let path = dir.join(&name);
    // VACUUM INTO refuses existing files; a second backup within the same second replaces the first.
    if path.exists() {
        fs::remove_file(&path)?;
    }
    let target = path.to_str().ok_or_else(|| Error::State(format!("Ungültiger Pfad: {}", path.display())))?;
    db.conn().execute("VACUUM INTO ?1", [target])?;
    let fresh = info(&path, &name).ok_or_else(|| Error::not_found("backup", name.clone()))?;
    // The new backup always counts as one of the kept ones, even if the clock went backwards.
    let others = list_backups(dir)?.into_iter().filter(|b| b.file_name != name);
    for old in others.skip(keep.max(1) - 1) {
        fs::remove_file(&old.path)?;
    }
    Ok(fresh)
}

/// Puts the newest backup of `backups` in place of the database `db_file` (start-up recovery
/// of a broken database). The broken file and its WAL files are kept as
/// `<name>.broken-<stamp>`. Returns the backup used.
pub fn restore_latest(db_file: &Path, backups: &Path, now: DateTime<Utc>) -> Result<BackupInfo> {
    let latest = list_backups(backups)?
        .into_iter()
        .next()
        .ok_or_else(|| Error::State(format!("Im Ordner {} liegt keine Sicherung", backups.display())))?;
    let stamp = now.format(STAMP);
    for ext in ["", "-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{ext}", db_file.display()));
        if from.exists() {
            fs::rename(&from, format!("{}{ext}.broken-{stamp}", db_file.display()))?;
        }
    }
    let tmp = db_file.with_extension("restore-part");
    fs::copy(&latest.path, &tmp)?;
    fs::rename(&tmp, db_file)?;
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
        assert!(used.file_name.starts_with("annalo-"));
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
        assert_eq!(names, ["annalo-20260923-040000.db", "annalo-20260923-030000.db"]);
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
}
