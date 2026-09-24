//! Start-up failures: a broken or newer database, a data folder that cannot be written. A
//! native dialog explains it and offers a way out (restore the last backup, open the folder,
//! quit) instead of an app that closes without a window.

use std::path::{Path, PathBuf};

use annalo_core::{Error, backup, datadir};
use chrono::Utc;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};

use crate::devlog;

const RESTORE: &str = "Letzte Sicherung wiederherstellen";
const OPEN: &str = "Ordner öffnen";
const QUIT: &str = "Beenden";

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
        if msg.contains(annalo_core::db::NEWER_SCHEMA) {
            Failure::Newer(msg)
        } else if e.is_storage() {
            Failure::Folder(msg)
        } else {
            Failure::Database(msg)
        }
    }

    /// Title, text and whether restoring a backup is offered.
    fn texts(&self, dir: &Path, backups: usize) -> (&'static str, String, bool) {
        match self {
            Failure::Folder(m) => (
                "Datenordner nicht beschreibbar",
                format!(
                    "Annalo kann im Datenordner nicht schreiben:\n{}\n\n{m}\n\nIst das Laufwerk voll, schreibgeschützt oder \
                     nicht verbunden? Nach der Korrektur Annalo neu starten.",
                    dir.display()
                ),
                false,
            ),
            Failure::Newer(m) => ("Neuere Datenbank", m.clone(), false),
            Failure::Database(m) if backups > 0 => (
                "Datenbank beschädigt",
                format!(
                    "Die Datenbank im Datenordner lässt sich nicht öffnen:\n{m}\n\n„{RESTORE}“ legt die beschädigte Datei \
                     beiseite (workspace.db.broken-…) und verwendet die neueste von {backups} Sicherungen."
                ),
                true,
            ),
            Failure::Database(m) => (
                "Datenbank beschädigt",
                format!(
                    "Die Datenbank im Datenordner lässt sich nicht öffnen:\n{m}\n\nEs gibt keine Sicherung im Ordner \
                     „backups“. Die Datei workspace.db bitte nicht löschen: sie lässt sich eventuell noch retten."
                ),
                false,
            ),
        }
    }
}

fn backups_dir(dir: &Path) -> PathBuf {
    dir.join("backups")
}

/// Shows the dialog; the app ends (or restarts after a restore) when it is answered.
pub fn show(app: &AppHandle, dir: &Path, failure: Failure) {
    devlog::error("core", format!("start failed: {failure:?}"));
    let backups = backup::list_backups(&backups_dir(dir)).map(|l| l.len()).unwrap_or(0);
    let (title, text, restore) = failure.texts(dir, backups);
    let buttons = if restore {
        MessageDialogButtons::YesNoCancelCustom(RESTORE.into(), OPEN.into(), QUIT.into())
    } else {
        MessageDialogButtons::OkCancelCustom(OPEN.into(), QUIT.into())
    };
    let app2 = app.clone();
    let dir = dir.to_path_buf();
    app.dialog()
        .message(text)
        .title(format!("Annalo – {title}"))
        .kind(MessageDialogKind::Error)
        .buttons(buttons)
        .show_with_result(move |res| {
            let pressed = match res {
                MessageDialogResult::Custom(s) => s,
                MessageDialogResult::Yes => if restore { RESTORE } else { OPEN }.to_owned(),
                MessageDialogResult::Ok => OPEN.to_owned(),
                MessageDialogResult::No if restore => OPEN.to_owned(),
                _ => QUIT.to_owned(),
            };
            match pressed.as_str() {
                RESTORE => match backup::restore_latest(&dir.join(datadir::DB_FILE), &backups_dir(&dir), Utc::now()) {
                    Ok(b) => {
                        devlog::warn("core", format!("database restored from backup {}", b.file_name));
                        crate::portable::unlock_instance();
                        app2.restart();
                    }
                    Err(e) => {
                        devlog::error("core", format!("restore failed: {e}"));
                        show(&app2, &dir, Failure::Database(format!("Wiederherstellen fehlgeschlagen: {e}")));
                    }
                },
                OPEN => {
                    use tauri_plugin_opener::OpenerExt;
                    let _ = app2.opener().open_path(dir.display().to_string(), None::<&str>);
                    app2.exit(1);
                }
                _ => app2.exit(1),
            }
        });
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
        let (_, text, restore) = f.texts(&dir, 0);
        assert!(!restore && text.contains("keine Sicherung"));
        assert!(f.texts(&dir, 2).2, "restore offered with backups");
        assert!(writable(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
