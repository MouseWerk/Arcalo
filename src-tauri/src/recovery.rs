//! Start-up failures: a broken or newer database, a data folder that cannot be written. A
//! native dialog explains it and offers a way out (restore the last backup, open the folder,
//! quit) instead of an app that closes without a window.
//!
//! WebDriver cannot press the buttons of a native dialog: in debug builds the end-to-end tests
//! answer it through `ANNALO_TEST_RECOVERY_CHOICE` (`restore`, `open` or `quit`), which skips the
//! dialog and takes that way out. Release builds ignore the variable.

use std::path::{Path, PathBuf};

use std::time::Duration;

use annalo_core::backup::BackupInfo;
use annalo_core::{Error, backupdest, datadir};
use chrono::Utc;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::devlog;
use annalo_core::{tr, trf};

/// The ways out the dialog offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Choice {
    Restore,
    Open,
    Quit,
}

impl Choice {
    /// The button text (the system's language: the settings may not be readable).
    fn label(self) -> &'static str {
        match self {
            Choice::Restore => tr!("Letzte Sicherung wiederherstellen", "Restore the last backup"),
            Choice::Open => tr!("Ordner öffnen", "Open folder"),
            Choice::Quit => tr!("Beenden", "Quit"),
        }
    }

    fn of_label(label: &str) -> Choice {
        [Choice::Restore, Choice::Open].into_iter().find(|c| c.label() == label).unwrap_or(Choice::Quit)
    }
}

/// Why Annalo cannot start.
#[derive(Debug, Clone, PartialEq)]
pub enum Failure {
    /// The data folder cannot be created or written.
    Folder(String),
    /// The database cannot be opened (damaged, not a database, locked).
    Database(String),
    /// The database was written by a newer Annalo.
    Newer(String),
}

impl Failure {
    pub fn of_database(e: &Error) -> Failure {
        let msg = e.to_string();
        if annalo_core::db::is_newer_schema(&msg) {
            Failure::Newer(msg)
        } else if e.is_storage() {
            Failure::Folder(msg)
        } else {
            Failure::Database(msg)
        }
    }

    /// Title, text and whether restoring a backup is offered.
    fn texts(&self, dir: &Path, backups: usize, remote: usize) -> (&'static str, String, bool) {
        let restore = Choice::Restore.label();
        let where_ = if remote > 0 {
            trf!(" (davon {} in weiteren Sicherungszielen)", " ({} of them in other backup destinations)", remote)
        } else {
            String::new()
        };
        match self {
            Failure::Folder(m) => (
                tr!("Datenordner nicht beschreibbar", "Data folder not writable"),
                trf!(
                    "Annalo kann im Datenordner nicht schreiben:\n{}\n\n{m}\n\nIst das Laufwerk voll, schreibgeschützt oder \
                     nicht verbunden? Nach der Korrektur Annalo neu starten.",
                    "Annalo cannot write in the data folder:\n{}\n\n{m}\n\nIs the drive full, read-only or not \
                     connected? Start Annalo again once that is fixed.",
                    dir.display()
                ),
                false,
            ),
            Failure::Newer(m) => (tr!("Neuere Datenbank", "Newer database"), m.clone(), false),
            Failure::Database(m) if backups > 0 => (
                tr!("Datenbank beschädigt", "Database damaged"),
                trf!(
                    "Die Datenbank im Datenordner lässt sich nicht öffnen:\n{m}\n\n„{restore}“ legt die beschädigte Datei \
                     beiseite (workspace.db.broken-…) und verwendet die neueste von {backups} Sicherungen{where_}.",
                    "The database in the data folder cannot be opened:\n{m}\n\n“{restore}” puts the damaged file \
                     aside (workspace.db.broken-…) and uses the newest of {backups} backups{where_}."
                ),
                true,
            ),
            Failure::Database(m) => (
                tr!("Datenbank beschädigt", "Database damaged"),
                trf!(
                    "Die Datenbank im Datenordner lässt sich nicht öffnen:\n{m}\n\nEs gibt keine Sicherung im Ordner \
                     „backups“. Die Datei workspace.db bitte nicht löschen: sie lässt sich eventuell noch retten.",
                    "The database in the data folder cannot be opened:\n{m}\n\nThere is no backup in the \
                     “backups” folder. Please do not delete workspace.db: it may still be rescued."
                ),
                false,
            ),
        }
    }
}

/// The backups the recovery can use: the local backup folder and the reachable destinations
/// (Settings → Sicherung), newest first. A destination that does not answer in time is skipped.
fn candidates(dir: &Path) -> (Vec<BackupInfo>, usize) {
    let sources = backupdest::recovery_sources(dir);
    let remote_dirs: Vec<PathBuf> = sources.iter().filter(|s| s.remote).map(|s| s.path.clone()).collect();
    let all = backupdest::gather(&sources, Duration::from_secs(5));
    let remote = all.iter().filter(|b| remote_dirs.iter().any(|d| Path::new(&b.path).starts_with(d))).count();
    (all, remote)
}

/// The answer the end-to-end tests give instead of a click (debug builds only).
fn test_choice(restore: bool) -> Option<Choice> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let choice = std::env::var("ANNALO_TEST_RECOVERY_CHOICE").ok()?;
    // Only the first dialog: a failed restore shows it again, and that one quits.
    static ANSWERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let again = ANSWERED.swap(true, std::sync::atomic::Ordering::Relaxed);
    Some(match choice.trim() {
        _ if again => Choice::Quit,
        "restore" if restore => Choice::Restore,
        "open" => Choice::Open,
        _ => Choice::Quit,
    })
}

/// Shows the dialog; the app ends (or restarts after a restore) when it is answered.
pub fn show(app: &AppHandle, dir: &Path, failure: Failure) {
    devlog::error("core", format!("start failed: {failure:?}"));
    let (found, remote) = candidates(dir);
    let (title, text, restore) = failure.texts(dir, found.len(), remote);
    devlog::info("core", format!("recovery dialog “{title}”: {text}"));
    if let Some(choice) = test_choice(restore) {
        devlog::info("core", format!("recovery dialog answered by the test: {choice:?}"));
        // Like a click: once the event loop runs (an exit requested during setup loses its code).
        let (app2, dir) = (app.clone(), dir.to_path_buf());
        let _ = app.run_on_main_thread(move || answer(&app2, &dir, choice));
        return;
    }
    let buttons = if restore {
        MessageDialogButtons::YesNoCancelCustom(
            Choice::Restore.label().into(),
            Choice::Open.label().into(),
            Choice::Quit.label().into(),
        )
    } else {
        MessageDialogButtons::OkCancelCustom(Choice::Open.label().into(), Choice::Quit.label().into())
    };
    let handle = app.clone();
    let dir = dir.to_path_buf();
    app.dialog()
        .message(text)
        .title(format!("Annalo – {title}"))
        .kind(MessageDialogKind::Error)
        .buttons(buttons)
        .show_with_result(move |res| {
            let pressed = match res {
                MessageDialogResult::Custom(s) => Choice::of_label(&s),
                MessageDialogResult::Yes => {
                    if restore {
                        Choice::Restore
                    } else {
                        Choice::Open
                    }
                }
                MessageDialogResult::Ok => Choice::Open,
                MessageDialogResult::No if restore => Choice::Open,
                _ => Choice::Quit,
            };
            answer(&handle, &dir, pressed);
        });
}

/// Carries out the chosen way out: restore and restart, open the folder, or quit (exit code 1).
fn answer(app: &AppHandle, dir: &Path, pressed: Choice) {
    match pressed {
        Choice::Restore => {
            match backupdest::restore_newest(&dir.join(datadir::DB_FILE), &candidates(dir).0, Utc::now()) {
                Ok(b) => {
                    devlog::warn("core", format!("database restored from backup {}", b.file_name));
                    crate::portable::unlock_instance();
                    app.restart();
                }
                Err(e) => {
                    devlog::error("core", format!("restore failed: {}", e.detail()));
                    show(
                        app,
                        dir,
                        Failure::Database(trf!("Wiederherstellen fehlgeschlagen: {e}", "Restoring failed: {e}")),
                    );
                }
            }
        }
        Choice::Open => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_path(dir.display().to_string(), None::<&str>);
            quit(app);
        }
        _ => quit(app),
    }
}

/// Ends Annalo with exit code 1 (`AppHandle::exit` ends `App::run` with code 0).
fn quit(app: &AppHandle) {
    app.cleanup_before_exit();
    std::process::exit(1);
}

/// Whether Annalo can write into `dir` (a read-only drive or folder permissions).
pub fn writable(dir: &Path) -> bool {
    let probe = dir.join(".annalo-write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(&probe);
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_told_apart() {
        let newer =
            Error::State(format!("Die Datenbank stammt von einer {} (Schema v99)", annalo_core::db::NEWER_SCHEMA));
        assert!(matches!(Failure::of_database(&newer), Failure::Newer(_)));
        let dir = std::env::temp_dir().join(format!("annalo-recovery-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(datadir::DB_FILE), b"kein SQLite, nur Text, der lang genug ist").unwrap();
        let e = annalo_core::Database::open(dir.join(datadir::DB_FILE)).err().unwrap();
        let f = Failure::of_database(&e);
        assert!(matches!(f, Failure::Database(_)), "{f:?}");
        let (_, text, restore) = f.texts(&dir, 0, 0);
        assert!(!restore && text.contains("keine Sicherung"));
        assert!(f.texts(&dir, 2, 0).2, "restore offered with backups");
        assert!(f.texts(&dir, 3, 2).1.contains("neueste von 3 Sicherungen (davon 2 in weiteren Sicherungszielen)"));
        assert!(writable(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
