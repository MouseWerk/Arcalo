use super::*;
use crate::backup;
use crate::db::Database;

/// The key every test that needs the process key uses (tests run in parallel and share it).
fn test_key() -> DbKey {
    DbKey::from_bytes(&[7u8; KEY_LEN]).unwrap()
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("arcalo-cipher-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

/// A workspace with a few pages and entries.
fn sample(dir: &Path) {
    let db = Database::open(dir.join(DB_FILE)).unwrap();
    for i in 0..20 {
        let p = db.create_page(None, &format!("Seite {i}"), None).unwrap();
        db.save_page_content(p.id, &format!("Inhalt {i} mit #tag und [[Seite {}]]", (i + 1) % 20)).unwrap();
    }
}

fn content(dir: &Path, title: &str) -> String {
    let db = Database::open(dir.join(DB_FILE)).unwrap();
    let p = db.page_by_title(title).unwrap().unwrap();
    db.page_doc(p.id).unwrap().content
}

#[test]
fn recovery_codes_round_trip_and_catch_typos() {
    let k = DbKey::generate().unwrap();
    let code = k.recovery_code();
    assert_eq!(code.len(), 14 * 4 + 13, "{code}");
    assert!(
        code.split('-').all(|g| g.len() == 4 && g.chars().all(|c| c.is_ascii_uppercase() || ('2'..='7').contains(&c)))
    );
    assert_eq!(DbKey::from_recovery_code(&code).unwrap(), k);
    // As typed: lower case, spaces instead of dashes, no separators.
    assert_eq!(DbKey::from_recovery_code(&code.to_lowercase().replace('-', " ")).unwrap(), k);
    assert_eq!(DbKey::from_recovery_code(&code.replace('-', "")).unwrap(), k);
    // Look-alikes: O/0, I/1, B/8.
    let lookalike = code.replace('O', "0").replace('I', "1").replace('B', "8");
    assert_eq!(DbKey::from_recovery_code(&lookalike).unwrap(), k);
    // One wrong character, one missing group: refused (not another key).
    let mut typo: Vec<char> = code.chars().collect();
    typo[5] = if typo[5] == 'A' { 'C' } else { 'A' };
    assert!(DbKey::from_recovery_code(&typo.into_iter().collect::<String>()).is_err());
    assert!(DbKey::from_recovery_code(&code[5..]).is_err());
    assert!(DbKey::from_recovery_code("").is_err());
    // Hex (the credential store) round-trips; Debug never prints the key.
    assert_eq!(DbKey::from_hex(&k.to_hex()).unwrap(), k);
    assert_eq!(format!("{k:?}"), "DbKey(…)");
}

#[test]
fn an_encrypted_copy_needs_the_right_key() {
    let dir = tmp("access");
    sample(&dir);
    let db = dir.join(DB_FILE);
    let enc = dir.join("enc.db");
    let key = DbKey::generate().unwrap();
    assert_eq!(file_state(&db), FileState::Plain);
    assert_eq!(access(&db, None), Access::Plain);
    export(&db, None, &enc, Some(&key)).unwrap();
    verify(&db, None, &enc, Some(&key)).unwrap();
    assert_eq!(file_state(&enc), FileState::Encrypted);
    let raw = fs::read(&enc).unwrap();
    assert!(!raw.windows(6).any(|w| w == b"Inhalt"), "no plain text in the encrypted file");
    assert_eq!(access(&enc, None), Access::MissingKey);
    assert_eq!(access(&enc, Some(&key)), Access::Unlocked);
    assert_eq!(access(&enc, Some(&DbKey::generate().unwrap())), Access::WrongKey);
    let wrong = open_with(&enc, OpenFlags::default(), Some(&DbKey::generate().unwrap())).unwrap_err();
    assert_eq!(wrong.to_string(), wrong_key_text());
    // And back: the decrypted copy is a plain SQLite file with the same rows.
    let back = dir.join("back.db");
    export(&enc, Some(&key), &back, None).unwrap();
    verify(&enc, Some(&key), &back, None).unwrap();
    assert_eq!(file_state(&back), FileState::Plain);
    // Missing or empty files count as plain (SQLite creates them).
    assert_eq!(file_state(&dir.join("nope.db")), FileState::Missing);
    // A damaged file (not whole pages) is not taken for an encrypted one: the start-up recovery
    // offers the backups instead of asking for a key.
    let junk = dir.join("junk.db");
    fs::write(&junk, "kein SQLite\n".repeat(300)).unwrap();
    assert_eq!(file_state(&junk), FileState::Plain);
    assert_eq!(access(&junk, None), Access::Plain);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn verify_finds_missing_rows() {
    let dir = tmp("verify");
    sample(&dir);
    let db = dir.join(DB_FILE);
    let copy = dir.join("copy.db");
    let key = DbKey::generate().unwrap();
    export(&db, None, &copy, Some(&key)).unwrap();
    {
        let c = open_with(&copy, OpenFlags::default(), Some(&key)).unwrap();
        c.execute("DELETE FROM pages WHERE id = (SELECT max(id) FROM pages)", []).unwrap();
    }
    let e = verify(&db, None, &copy, Some(&key)).unwrap_err().to_string();
    assert!(e.contains("pages: "), "{e}");
    // A plain copy where an encrypted one is expected is refused too.
    let plain = dir.join("plain.db");
    export(&db, None, &plain, None).unwrap();
    assert!(verify(&db, None, &plain, Some(&key)).is_err());
    let _ = fs::remove_dir_all(&dir);
}

/// Encrypts with a crash at `point` (if any), starts again, and checks the outcome.
fn encrypt_with_crash(point: Option<&str>) {
    let dir = tmp(&format!("kill-{}", point.unwrap_or("none")));
    sample(&dir);
    let key = test_key();
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    if let Some(p) = point {
        let hook = |at: &str| at == p;
        assert!(run_pending_with(&dir, Some(&key), &hook).is_err(), "crash at {p}");
        // Whatever the crash left: the data is in exactly one usable place.
        let db = dir.join(DB_FILE);
        assert!(db.exists() || dir.join(NEW_FILE).exists(), "{p}: no database left");
    }
    let done = run_pending(&dir, Some(&key)).unwrap();
    assert_eq!(done, Some(Outcome { direction: Direction::Encrypt }), "{point:?}");
    assert_eq!(file_state(&dir.join(DB_FILE)), FileState::Encrypted);
    assert!(!dir.join(NEW_FILE).exists());
    assert_eq!(file_state(&dir.join(OLD_FILE)), FileState::Plain, "the original is kept");
    set_key(Some(test_key()));
    assert_eq!(content(&dir, "Seite 3"), "Inhalt 3 mit #tag und [[Seite 4]]");
    // Nothing more to do at the next start; the original goes at the one after.
    assert_eq!(run_pending(&dir, Some(&key)).unwrap(), None);
    assert!(!confirm_open(&dir).unwrap());
    assert!(old_left(&dir));
    assert!(confirm_open(&dir).unwrap());
    assert!(!old_left(&dir));
    assert!(read_marker(&dir).is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn encrypting_survives_a_crash_at_every_step() {
    for p in [None, Some("exported"), Some("verified"), Some("old-moved"), Some("new-moved")] {
        encrypt_with_crash(p);
    }
}

#[test]
fn a_crash_while_exporting_leaves_the_original_alone() {
    let dir = tmp("partial");
    sample(&dir);
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    // A half-written export from a crash: it is thrown away and written again.
    fs::write(dir.join(NEW_FILE), b"half").unwrap();
    assert!(run_pending(&dir, Some(&test_key())).unwrap().is_some());
    set_key(Some(test_key()));
    assert_eq!(content(&dir, "Seite 0"), "Inhalt 0 mit #tag und [[Seite 1]]");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_check_rolls_back() {
    let dir = tmp("rollback");
    sample(&dir);
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    // No key: nothing is touched, the request is dropped.
    assert!(run_pending(&dir, None).is_err());
    assert!(read_marker(&dir).is_none());
    assert_eq!(file_state(&dir.join(DB_FILE)), FileState::Plain);
    assert!(!dir.join(NEW_FILE).exists());
    // A request for what the file already is is refused.
    assert!(request(&dir, Direction::Decrypt, Utc::now()).is_err());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn decrypting_works_the_same_way() {
    let dir = tmp("decrypt");
    sample(&dir);
    let key = test_key();
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    run_pending(&dir, Some(&key)).unwrap();
    drop_old(&dir).unwrap();
    request(&dir, Direction::Decrypt, Utc::now()).unwrap();
    let hook = |at: &str| at == "old-moved";
    assert!(run_pending_with(&dir, Some(&key), &hook).is_err());
    assert_eq!(run_pending(&dir, Some(&key)).unwrap(), Some(Outcome { direction: Direction::Decrypt }));
    assert_eq!(file_state(&dir.join(DB_FILE)), FileState::Plain);
    assert_eq!(file_state(&dir.join(OLD_FILE)), FileState::Encrypted);
    assert_eq!(content(&dir, "Seite 19"), "Inhalt 19 mit #tag und [[Seite 0]]");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn backups_of_an_encrypted_database_are_encrypted_and_restore_with_the_recovery_key() {
    let dir = tmp("backup");
    sample(&dir);
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    run_pending(&dir, Some(&test_key())).unwrap();
    set_key(Some(test_key()));
    let backups = dir.join("backups");
    let info = {
        let db = Database::open(dir.join(DB_FILE)).unwrap();
        let p = db.page_by_title("Seite 1").unwrap().unwrap();
        db.save_page_content(p.id, "Stand der Sicherung").unwrap();
        backup::backup_to(&db, &backups, 3).unwrap()
    };
    let file = PathBuf::from(&info.path);
    assert_eq!(file_state(&file), FileState::Encrypted, "VACUUM INTO keeps the key");
    assert!(!fs::read(&file).unwrap().windows(9).any(|w| w == b"Stand der"), "no plain text in the backup");
    // The checksum and copy logic only see bytes; the check reads it with the key.
    crate::backupdest::check_sqlite(&file).unwrap();
    assert!(plain_backups(&backups).is_empty());
    // On a new computer: no key; the recovery key opens the backup.
    let code = test_key().recovery_code();
    assert_eq!(access(&file, None), Access::MissingKey);
    let from_code = DbKey::from_recovery_code(&code).unwrap();
    assert_eq!(access(&file, Some(&from_code)), Access::Unlocked);
    // Restored over a broken database, it opens with that key.
    fs::write(dir.join(DB_FILE), b"kaputt").unwrap();
    backup::restore_latest(&dir.join(DB_FILE), &backups, Utc::now()).unwrap();
    assert_eq!(access(&dir.join(DB_FILE), Some(&from_code)), Access::Unlocked);
    assert_eq!(content(&dir, "Seite 1"), "Stand der Sicherung");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_backup_from_before_the_encryption_is_encrypted_when_restored() {
    use crate::backupdest::{Activity, PENDING_RESTORE, apply_pending_restore, stage_restore};
    let dir = tmp("restore-plain");
    sample(&dir);
    let backups = dir.join("backups");
    let plain = {
        let db = Database::open(dir.join(DB_FILE)).unwrap();
        let p = db.page_by_title("Seite 2").unwrap().unwrap();
        db.save_page_content(p.id, "vor der Verschlüsselung").unwrap();
        backup::backup_to(&db, &backups, 3).unwrap()
    };
    assert_eq!(file_state(Path::new(&plain.path)), FileState::Plain);
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    run_pending(&dir, Some(&test_key())).unwrap();
    confirm_open(&dir).unwrap();
    assert_eq!(file_state(&dir.join(DB_FILE)), FileState::Encrypted);
    // Settings → Sicherung → „Wiederherstellen“ of the plain backup, then the next start.
    stage_restore(Path::new(&plain.path), &dir, &Activity::new(None)).unwrap();
    assert!(dir.join(PENDING_RESTORE).is_file());
    let restored = apply_pending_restore(&dir, Utc::now()).unwrap().unwrap();
    assert!(restored.encrypt, "the encryption is asked for again");
    assert_eq!(run_pending(&dir, Some(&test_key())).unwrap(), Some(Outcome { direction: Direction::Encrypt }));
    assert_eq!(file_state(&dir.join(DB_FILE)), FileState::Encrypted, "the workspace stays encrypted");
    assert_eq!(access(&dir.join(DB_FILE), Some(&test_key())), Access::Unlocked);
    let db = open_with(&dir.join(DB_FILE), OpenFlags::default(), Some(&test_key())).unwrap();
    let text: String = db.query_row("SELECT content FROM pages WHERE title = 'Seite 2'", [], |r| r.get(0)).unwrap();
    assert_eq!(text, "vor der Verschlüsselung");
    drop(db);
    // Restoring a backup of a plain workspace asks for nothing.
    let again = dir.join("plain-again");
    fs::create_dir_all(&again).unwrap();
    sample(&again);
    stage_restore(Path::new(&plain.path), &again, &Activity::new(None)).unwrap();
    assert!(!apply_pending_restore(&again, Utc::now()).unwrap().unwrap().encrypt);
    assert!(read_marker(&again).is_none());
    let _ = fs::remove_dir_all(&dir);
}

/// A page's text read with `key` (not the process key: tests share that one).
fn content_with(db: &Path, key: &DbKey, title: &str) -> String {
    let conn = open_with(db, OpenFlags::default(), Some(key)).unwrap();
    conn.query_row("SELECT content FROM pages WHERE title = ?1", [title], |r| r.get(0)).unwrap()
}

/// Changes the key with a crash at `point` (if any), starts again, and checks the outcome.
fn rekey_with_crash(point: Option<&str>) {
    let dir = tmp(&format!("rekey-{}", point.unwrap_or("none")));
    sample(&dir);
    let (old, new) = (test_key(), DbKey::from_bytes(&[9u8; KEY_LEN]).unwrap());
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    run_pending(&dir, Some(&old)).unwrap();
    drop_old(&dir).unwrap();
    let db = dir.join(DB_FILE);

    request(&dir, Direction::Rekey, Utc::now()).unwrap();
    // Asked for, not yet run: the new key is kept for the start that runs it.
    assert_eq!(next_key_fate(&dir, &new), NextKey::Keep);
    if let Some(p) = point {
        let hook = |at: &str| at == p;
        assert!(run_pending_keys(&dir, Some(&old), Some(&new), &hook).is_err(), "crash at {p}");
        // Whatever the crash left, one of the two keys opens a complete database.
        let usable = [(&db, &old), (&db, &new), (&dir.join(NEW_FILE), &new)]
            .iter()
            .any(|(f, k)| f.exists() && access(f, Some(k)) == Access::Unlocked);
        assert!(usable, "{p}: no usable database left");
    }
    let done = run_pending_keys(&dir, Some(&old), Some(&new), &|_| false).unwrap();
    assert_eq!(done, Some(Outcome { direction: Direction::Rekey }), "{point:?}");
    // Never written unencrypted; the new key opens it, the old one no longer does.
    assert_eq!(file_state(&db), FileState::Encrypted);
    assert_eq!(access(&db, Some(&new)), Access::Unlocked);
    assert_eq!(access(&db, Some(&old)), Access::WrongKey);
    assert_eq!(next_key_fate(&dir, &new), NextKey::Promote);
    assert_eq!(content_with(&db, &new, "Seite 3"), "Inhalt 3 mit #tag und [[Seite 4]]");
    // The previous file (old key) goes like after any switch.
    assert_eq!(access(&dir.join(OLD_FILE), Some(&old)), Access::Unlocked);
    assert!(!confirm_open(&dir).unwrap());
    assert!(confirm_open(&dir).unwrap());
    assert!(!old_left(&dir));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn changing_the_key_survives_a_crash_at_every_step() {
    for p in [None, Some("exported"), Some("verified"), Some("old-moved"), Some("new-moved")] {
        rekey_with_crash(p);
    }
}

#[test]
fn a_key_change_without_the_new_key_rolls_back_and_backups_use_the_new_key() {
    let dir = tmp("rekey-rollback");
    sample(&dir);
    let (old, new) = (test_key(), DbKey::from_bytes(&[11u8; KEY_LEN]).unwrap());
    let db = dir.join(DB_FILE);
    // Only an encrypted database can change its key.
    assert!(request(&dir, Direction::Rekey, Utc::now()).is_err());
    request(&dir, Direction::Encrypt, Utc::now()).unwrap();
    run_pending(&dir, Some(&old)).unwrap();
    drop_old(&dir).unwrap();

    request(&dir, Direction::Rekey, Utc::now()).unwrap();
    assert!(run_pending_keys(&dir, Some(&old), None, &|_| false).is_err());
    assert!(read_marker(&dir).is_none());
    assert_eq!(access(&db, Some(&old)), Access::Unlocked, "unchanged");
    assert_eq!(next_key_fate(&dir, &new), NextKey::Drop);

    request(&dir, Direction::Rekey, Utc::now()).unwrap();
    run_pending_keys(&dir, Some(&old), Some(&new), &|_| false).unwrap();
    // A backup made afterwards (VACUUM INTO, as `backup::backup_to`) has the new key.
    let backup = dir.join("arcalo-nach-dem-wechsel.db");
    let conn = open_with(&db, OpenFlags::default(), Some(&new)).unwrap();
    conn.execute("VACUUM INTO ?1", [backup.to_str().unwrap()]).unwrap();
    drop(conn);
    assert_eq!(access(&backup, Some(&new)), Access::Unlocked);
    assert_eq!(access(&backup, Some(&old)), Access::WrongKey);
    // The recovery key of the new key opens it; the old recovery key does not.
    let code = new.recovery_code();
    assert_eq!(access(&db, Some(&DbKey::from_recovery_code(&code).unwrap())), Access::Unlocked);
    assert_eq!(access(&db, Some(&DbKey::from_recovery_code(&old.recovery_code()).unwrap())), Access::WrongKey);
    // The password file follows the change.
    WrappedKey::wrap(&old, "ein langes Passwort", (8, 1, 1)).unwrap().write(&dir).unwrap();
    WrappedKey::wrap(&new, "ein langes Passwort", (8, 1, 1)).unwrap().write_next(&dir).unwrap();
    WrappedKey::promote_next(&dir).unwrap();
    assert_eq!(WrappedKey::read(&dir).unwrap().unwrap_key("ein langes Passwort").unwrap(), new);
    assert!(!dir.join(WRAPPED_NEXT_FILE).exists());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_password_wraps_the_key() {
    let dir = tmp("wrap");
    let key = DbKey::generate().unwrap();
    // Small cost in tests; the app uses WRAP_COST.
    let w = WrappedKey::wrap(&key, "Korrekt Pferd Batterie", (1024, 1, 1)).unwrap();
    w.write(&dir).unwrap();
    let back = WrappedKey::read(&dir).unwrap();
    assert_eq!(back.unwrap_key("Korrekt Pferd Batterie").unwrap(), key);
    assert!(back.unwrap_key("korrekt pferd batterie").is_err());
    let text = fs::read_to_string(dir.join(WRAPPED_FILE)).unwrap();
    assert!(!text.contains(key.to_hex().as_str()));
    WrappedKey::remove(&dir).unwrap();
    assert!(WrappedKey::read(&dir).is_none());
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn a_failed_password_change_keeps_the_wrapped_key() {
    let dir = tmp("wrap-fail");
    let key = DbKey::generate().unwrap();
    WrappedKey::wrap(&key, "altes Passwort", (1024, 1, 1)).unwrap().write(&dir).unwrap();
    // The new file cannot be written (here: a folder where its temporary file goes).
    fs::create_dir_all(dir.join(format!(".{WRAPPED_FILE}.tmp")).join("x")).unwrap();
    let next = WrappedKey::wrap(&key, "neues Passwort", (1024, 1, 1)).unwrap();
    assert!(next.write(&dir).is_err());
    assert_eq!(WrappedKey::read(&dir).unwrap().unwrap_key("altes Passwort").unwrap(), key, "the old one still opens");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn secure_delete_overwrites_then_removes() {
    let dir = tmp("shred");
    let f = dir.join("old.db");
    fs::write(&f, vec![0xAB; 200_000]).unwrap();
    secure_delete(&f).unwrap();
    assert!(!f.exists());
    secure_delete(&f).unwrap();
    let _ = fs::remove_dir_all(&dir);
}

/// SQLCipher bundles an older SQLite (3.51) than the plain build had (3.53): SQL that needs a
/// newer one fails at run time only. The functions added after 3.51 are not used anywhere.
#[test]
fn no_sql_newer_than_the_bundled_sqlite() {
    let version: String =
        Database::open_in_memory().unwrap().conn().query_row("SELECT sqlite_version()", [], |r| r.get(0)).unwrap();
    assert!(version.starts_with("3.51."), "bundled SQLite {version}: check the list below against its release notes");
    const NEWER: [&str; 2] = ["json_array_insert", "jsonb_array_insert"];
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        for e in fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "rs" || x == "sql") {
                out.push(p);
            }
        }
    }
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = vec![];
    walk(&root.join("src"), &mut files);
    walk(&root.join("migrations"), &mut files);
    walk(&root.join("../../src-tauri/src"), &mut files);
    for f in &files {
        let text = fs::read_to_string(f).unwrap_or_default().to_lowercase();
        for name in NEWER {
            assert!(!text.contains(&format!("{name}(")), "{} uses {name}, which SQLite 3.51 lacks", f.display());
        }
    }
}
