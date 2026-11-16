//! q124 round 7 (hunt B, data safety): backups, restore and the start-up recovery.

use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use arcalo_core::Database;
use arcalo_core::backup;
use arcalo_core::backupdest::{self, Activity, Destination, Registry};
use chrono::{TimeDelta, Utc};

/// A fresh, empty folder (removed on drop).
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "arcalo-r7b-bm-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Two computers (or two colleagues) share one destination, each in its own subfolder. The
/// database of this computer breaks; „Letzte Sicherung wiederherstellen“ must bring back this
/// computer's workspace, not the newest backup of whichever computer wrote last.
#[test]
fn the_start_up_recovery_restores_this_computers_backup_not_another_computers() {
    let root = TempDir::new("hosts");
    let data = root.0.join("data");
    let share = root.0.join("share");
    fs::create_dir_all(data.join("backups")).unwrap();
    fs::create_dir_all(&share).unwrap();
    let db_file = data.join(arcalo_core::datadir::DB_FILE);
    let this_host = arcalo_core::gitsync::hostname();

    // This computer's workspace, backed up locally and copied to the share.
    let own = {
        let db = Database::open(&db_file).unwrap();
        db.create_page(None, "Mein Stand", None).unwrap();
        backup::backup_to(&db, &data.join("backups"), 5).unwrap()
    };
    let job = backupdest::Job {
        backup: PathBuf::from(&own.path),
        dest: share.clone(),
        host: this_host.clone(),
        keep: 5,
        keep_days: 0,
        attachments: None,
        markdown: None,
        reached_before: false,
        now: Utc::now(),
    };
    backupdest::deliver(&job, &Activity::new(None)).unwrap();

    // A colleague's computer backs up into the same share an hour later (its own workspace).
    let other_dir = root.0.join("other");
    fs::create_dir_all(&other_dir).unwrap();
    let theirs = {
        let db = Database::open(other_dir.join("workspace.db")).unwrap();
        db.create_page(None, "Gehaltsliste der Kollegin", None).unwrap();
        backup::backup_to(&db, &other_dir.join("backups"), 5).unwrap()
    };
    let later = (Utc::now() + TimeDelta::hours(1)).format("%Y%m%d-%H%M%S");
    let renamed = other_dir.join(format!("arcalo-{later}.db"));
    fs::copy(&theirs.path, &renamed).unwrap();
    let job = backupdest::Job { backup: renamed, host: "KOLLEGIN-PC".into(), ..job };
    backupdest::deliver(&job, &Activity::new(None)).unwrap();

    let reg = Registry {
        local_dir: None,
        destinations: vec![Destination { path: share.display().to_string(), ..Default::default() }],
        status: Default::default(),
    };
    backupdest::write_registry(&data, &reg).unwrap();

    // The database breaks; the recovery dialog's „Letzte Sicherung wiederherstellen“.
    fs::write(&db_file, b"kaputt").unwrap();
    let found = backupdest::gather(&backupdest::recovery_sources(&data), Duration::from_secs(5));
    let used = backupdest::restore_newest(&db_file, &found, Utc::now()).unwrap();
    let db = Database::open(&db_file).unwrap();
    assert!(
        db.page_by_title("Gehaltsliste der Kollegin").unwrap().is_none(),
        "the workspace of another computer was put in place: {}",
        used.path
    );
    assert!(db.page_by_title("Mein Stand").unwrap().is_some(), "this computer's notes are back");
}

/// A backup is restored (Settings → Sicherung → „Wiederherstellen…“). Since the backup, the
/// image a page embedded was removed from the page and moved to the file trash. The restored
/// page embeds it again; the file is in the file trash and in the backup folder's attachments
/// copy, but not where the page looks for it.
#[test]
fn a_restored_backup_brings_back_the_files_its_pages_embed() {
    let root = TempDir::new("files");
    let data = root.0.join("data");
    let backups = data.join("backups");
    let att = arcalo_core::attachments::dir(&data);
    fs::create_dir_all(&att).unwrap();
    fs::write(att.join("Grundriss.png"), [137u8, 80, 78, 71]).unwrap();
    let db_file = data.join(arcalo_core::datadir::DB_FILE);
    let page = {
        let db = Database::open(&db_file).unwrap();
        let p = db.create_page(None, "Umbau", None).unwrap();
        db.save_page_content(p.id, "Plan:\n\n![[Grundriss.png]]\n").unwrap();
        p
    };
    // The daily backup: the database and (as the shell does) the attachments copied along.
    let saved = {
        let db = Database::open(&db_file).unwrap();
        backup::backup_to(&db, &backups, 14).unwrap()
    };
    backupdest::sync_files(&att, &backups.join("attachments"), &Activity::new(None)).unwrap();

    // Later: the image is taken out of the page and the unused file moved to the file trash.
    {
        let db = Database::open(&db_file).unwrap();
        db.save_page_content(page.id, "Plan: verworfen\n").unwrap();
    }
    arcalo_core::attachment_manager::trash_files(&data, &["Grundriss.png".to_owned()]).unwrap();

    // The backup is restored and the app restarts.
    backupdest::stage_restore(PathBuf::from(&saved.path).as_path(), &data, &Activity::new(None)).unwrap();
    backupdest::apply_pending_restore(&data, Utc::now()).unwrap().unwrap();
    let db = Database::open(&db_file).unwrap();
    // The start that opens the restored database (the shell, before the file trash is emptied).
    assert_eq!(backupdest::bring_back_files(&db, &data).unwrap(), ["Grundriss.png"]);
    assert!(db.page_doc(page.id).unwrap().content.contains("![[Grundriss.png]]"), "the backup's text is back");
    assert!(
        att.join("Grundriss.png").is_file(),
        "the restored page embeds Grundriss.png, which stays in the file trash: the page shows a broken image"
    );
}

/// Switching the encryption on (Settings → Sicherheit, then a restart). The export is written and
/// checked, the marker says „verified“, then the swap's first rename fails (on Windows a file
/// another program holds open, e.g. a virus scanner or an indexer, cannot be renamed). The kill
/// hook at „verified“ leaves exactly the state that failing `fs::rename(db, old)?` leaves: an
/// error, the marker at `Verified`, the export next to the untouched database. The shell shows
/// „Die Datenbank wurde nicht umgestellt und ist unverändert“ and opens the database; the user works
/// on. At the next start the swap resumes with the export of the earlier start and the day's work
/// lies in `workspace.db.cipher-old`, which the start after that overwrites and deletes.
#[test]
fn work_done_after_a_failed_encryption_swap_is_kept_at_the_next_start() {
    use arcalo_core::cipher::{self, DbKey, Direction};
    let root = TempDir::new("cipher");
    let dir = root.0.clone();
    let db_file = dir.join(arcalo_core::datadir::DB_FILE);
    {
        let db = Database::open(&db_file).unwrap();
        let p = db.create_page(None, "Vorher", None).unwrap();
        db.save_page_content(p.id, "schon da").unwrap();
    }
    let key = DbKey::from_bytes(&[9u8; cipher::KEY_LEN]).unwrap();
    cipher::request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    // Start 1: the swap fails right after the check.
    let failed = cipher::run_pending_with(&dir, Some(&key), &|at| at == "verified");
    assert!(failed.is_err(), "the switch reports a failure");
    assert_eq!(cipher::file_state(&db_file), cipher::FileState::Plain, "the database is unchanged");
    // The app opens the (plain) database as the shell does after the error and the user works.
    {
        let db = Database::open(&db_file).unwrap();
        let p = db.create_page(None, "Heute geschrieben", None).unwrap();
        db.save_page_content(p.id, "ein ganzer Arbeitstag").unwrap();
    }
    // Start 2: the switch resumes.
    cipher::run_pending(&dir, Some(&key)).unwrap();
    cipher::set_key(Some(key.clone()));
    let db = Database::open(&db_file).unwrap();
    assert!(db.page_by_title("Vorher").unwrap().is_some());
    assert!(
        db.page_by_title("Heute geschrieben").unwrap().is_some(),
        "the work done after the failed switch is gone from the database (left only in {})",
        cipher::OLD_FILE
    );
}

/// The Markdown copy's README.txt names the way back without the database: „diesen Ordner in
/// Arcalo als Obsidian-Vault importieren“. Imported into a new workspace, every page has to come
/// back under its title, so the links between the notes still find their pages.
#[test]
fn a_markdown_copy_imported_as_a_vault_brings_back_every_page_under_its_title() {
    let root = TempDir::new("mirror-import");
    let att = root.0.join("att");
    fs::create_dir_all(&att).unwrap();
    let db = Database::open_in_memory().unwrap();
    for (title, text) in [
        ("Q3: Ziele", "Umsatz +10 %"),
        (".NET Migration", "Framework 4.8 auf .NET 8"),
        ("Übersicht", "[[Q3: Ziele]] und [[.NET Migration]]"),
    ] {
        let p = db.create_page(None, title, None).unwrap();
        db.save_page_content(p.id, text).unwrap();
    }
    let target = root.0.join("markdown");
    let report = arcalo_core::mirror::write_mirror(&db, &target, &att, &Utc).unwrap();
    assert_eq!(report.pages, 3, "all three pages are in the copy");

    // The way back: a new workspace imports the folder.
    let fresh = Database::open_in_memory().unwrap();
    arcalo_core::vault::import_vault(&fresh, &target, &root.0.join("att2")).unwrap();
    let links = fresh.page_by_title("Übersicht").unwrap().expect("Übersicht imported");
    assert!(fresh.page_doc(links.id).unwrap().content.contains("[[Q3: Ziele]]"));
    let missing: Vec<&str> =
        ["Q3: Ziele", ".NET Migration"].into_iter().filter(|t| fresh.page_by_title(t).unwrap().is_none()).collect();
    assert!(missing.is_empty(), "pages the links of „Übersicht“ name are not back under their titles: {missing:?}");
}

/// As above, with the file gone from the file trash too (emptied after its retention): it comes
/// from the attachments the backup folder keeps next to the backups.
#[test]
fn a_restored_backup_takes_a_purged_file_from_the_backup_folders_attachments() {
    let root = TempDir::new("files-purged");
    let data = root.0.join("data");
    let backups = data.join("backups");
    let att = arcalo_core::attachments::dir(&data);
    fs::create_dir_all(&att).unwrap();
    fs::write(att.join("Skizze.png"), [137u8, 80, 78, 71, 1]).unwrap();
    let db_file = data.join(arcalo_core::datadir::DB_FILE);
    let saved = {
        let db = Database::open(&db_file).unwrap();
        let p = db.create_page(None, "Entwurf", None).unwrap();
        db.save_page_content(p.id, "![[Skizze.png]]").unwrap();
        backup::backup_to(&db, &backups, 14).unwrap()
    };
    backupdest::sync_files(&att, &backups.join("attachments"), &Activity::new(None)).unwrap();
    let then = Utc::now() - TimeDelta::days(60);
    arcalo_core::attachment_manager::trash_files_at(&data, &["Skizze.png".to_owned()], then).unwrap();
    assert_eq!(arcalo_core::attachment_manager::purge_expired_files(&data, 30, Utc::now()).unwrap(), 1);

    backupdest::stage_restore(PathBuf::from(&saved.path).as_path(), &data, &Activity::new(None)).unwrap();
    backupdest::apply_pending_restore(&data, Utc::now()).unwrap().unwrap();
    let db = Database::open(&db_file).unwrap();
    assert_eq!(backupdest::bring_back_files(&db, &data).unwrap(), ["Skizze.png"]);
    assert_eq!(fs::read(att.join("Skizze.png")).unwrap(), [137u8, 80, 78, 71, 1]);
    assert!(backupdest::bring_back_files(&db, &data).unwrap().is_empty(), "once");
}
