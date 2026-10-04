//! Return to the previous version when an update does not start (see
//! `annalo_core::update_state`). Before an update is installed, the database is backed up
//! (`arcalo-pre-update-<from>-<to>.db` in the backup folder) and a copy of the running version
//! is kept where the platform allows: the program folder (Windows, per-user install), the
//! `.app` as `.tar.gz` (macOS), the AppImage file (Linux). A .deb, a portable copy and test
//! runs keep none (only the database can return).
//!
//! Limits: the check runs in the app's own startup. A new version that fails before that point
//! (a missing system library, a crash in the runtime before `setup`) never reaches it; then
//! the previous version has to be installed by hand (docs/admin/updates.md).
//!
//! Test hooks (debug builds only): `ANNALO_TEST_FAIL_START=1` ends the start right after the
//! health marker, like a crash; `ANNALO_TEST_ROLLBACK_ANSWER=yes|no` answers the question
//! instead of the native dialog; `ANNALO_UPDATE_FAKE_INSTALL=1` keeps a "test" copy.

use std::path::{Path, PathBuf};

use annalo_core::update_state::{self as st, CopyKind, RollbackRecord, StartCheck, UpdateState};
use annalo_core::{Error, tr, trf};
use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::Result;

/// Written after a rollback; the next start (the previous version) tells the user.
const NOTICE_FILE: &str = "rolled-back.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Notice {
    /// The version returned to.
    pub from: String,
    /// The version that did not start (skipped from now on).
    pub to: String,
    /// The database was put back to the state before the update.
    pub database: bool,
}

fn test_var(name: &str) -> Option<String> {
    annalo_core::update::test_override(cfg!(debug_assertions), std::env::var(name).ok().as_deref()).map(str::to_string)
}

/// Updates are installed with a test stand-in instead of the updater (e2e runs).
pub fn fake_install() -> bool {
    test_var("ANNALO_UPDATE_FAKE_INSTALL").is_some()
}

/// Early in the start, before the database is opened: counts failed starts of this version
/// and, after two in a row of a freshly installed one, asks whether to return. Returns only
/// when this process should go on starting.
pub fn early_check(app: &tauri::AppHandle, dir: &Path, version: &str) {
    // The Store installs and rolls back its packages itself; a record in a data folder shared
    // with an installed copy is not this copy's to act on.
    if crate::store::active() {
        return;
    }
    let record = RollbackRecord::load(dir);
    let check = st::begin_start(dir, version, record.as_ref());
    if test_var("ANNALO_TEST_FAIL_START").is_some() {
        crate::devlog::warn("update", "test: start fails on purpose");
        std::process::exit(3);
    }
    match check {
        StartCheck::Normal => {}
        StartCheck::Failed { failures } => {
            crate::devlog::warn("update", format!("{failures} earlier start(s) of {version} did not finish"));
        }
        StartCheck::OfferRollback { from, to, failures } => {
            crate::devlog::error("update", format!("{failures} starts of {to} failed in a row, offering {from}"));
            let Some(record) = record else { return };
            if !ask(&from, &to) {
                crate::devlog::info("update", "rollback declined");
                st::reset_failures(dir, version);
                return;
            }
            match restore(dir, &record) {
                Ok(Restart::Previous(exe)) => {
                    crate::devlog::info("update", format!("rolled back to {from}, starting {}", exe.display()));
                    // Otherwise the previous version would only bring this process to the front.
                    if crate::portable::active() {
                        crate::portable::unlock_instance();
                    } else {
                        tauri_plugin_single_instance::destroy(app);
                    }
                    if let Err(e) = spawn(&exe) {
                        message(&trf!(
                            "Die vorherige Version wurde wiederhergestellt, ließ sich aber nicht starten ({}). Bitte Arcalo neu starten.",
                            "The previous version was restored but could not be started ({}). Please start Arcalo again.",
                            e
                        ));
                    }
                    std::process::exit(0);
                }
                Ok(Restart::Continue) => {}
                Err(e) => {
                    crate::devlog::error("update", format!("rollback failed: {e}"));
                    message(&trf!(
                        "Die Rückkehr zur vorherigen Version ist fehlgeschlagen: {}",
                        "Returning to the previous version failed: {}",
                        e
                    ));
                }
            }
        }
    }
}

fn ask(from: &str, to: &str) -> bool {
    if let Some(answer) = test_var("ANNALO_TEST_ROLLBACK_ANSWER") {
        return answer.eq_ignore_ascii_case("yes");
    }
    let text = trf!(
        "Arcalo {to} konnte zweimal nicht starten – zu {from} zurückkehren?\n\nDie Datenbank wird auf den Stand vor dem Update \
         zurückgesetzt; Änderungen seit dem Update gehen verloren. Version {to} wird danach übersprungen.",
        "Arcalo {to} could not start twice – return to {from}?\n\nThe database is put back to its state before the update; \
         changes made since the update are lost. Version {to} is skipped from then on."
    );
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Warning)
        .set_title("Arcalo")
        .set_description(text)
        .set_buttons(rfd::MessageButtons::YesNo)
        .show()
        == rfd::MessageDialogResult::Yes
}

fn message(text: &str) {
    if test_var("ANNALO_TEST_ROLLBACK_ANSWER").is_some() {
        return;
    }
    rfd::MessageDialog::new()
        .set_level(rfd::MessageLevel::Error)
        .set_title("Arcalo")
        .set_description(text)
        .set_buttons(rfd::MessageButtons::Ok)
        .show();
}

/// What follows a rollback.
pub enum Restart {
    /// Start this program (the previous version) and end this process.
    Previous(PathBuf),
    /// Nothing to start (test runs): this process goes on.
    Continue,
}

/// Puts the database of before the update back, records the version as bad and reinstalls
/// the previous version. The database must not be open.
pub fn restore(dir: &Path, record: &RollbackRecord) -> Result<Restart> {
    let backup = record.backup.as_ref().filter(|b| b.is_file()).ok_or_else(|| {
        Error::State(
            tr!("Die Sicherung von vor dem Update fehlt", "The backup from before the update is missing").into(),
        )
    })?;
    // The database first, then the program: the previous version must never start on the
    // database the new one migrated. When the program cannot be put back, the database goes
    // back too (the new version keeps running on its own database).
    let aside = annalo_core::backup::restore_from(
        &dir.join(annalo_core::datadir::DB_FILE),
        backup,
        "before-rollback",
        Utc::now(),
    )?;
    let restart = match reinstall(record) {
        Ok(r) => r,
        Err(e) => {
            if let Err(undo) = aside.undo() {
                crate::devlog::error("update", format!("database of the new version not put back: {undo}"));
            }
            return Err(e);
        }
    };
    let mut state = UpdateState::load(dir);
    state.mark_bad(&record.to);
    if state.skipped.as_deref() == Some(record.to.as_str()) {
        state.skipped = None;
    }
    let _ = state.save(dir);
    let notice = Notice { from: record.from.clone(), to: record.to.clone(), database: true };
    let _ =
        std::fs::write(dir.join(st::UPDATES_DIR).join(NOTICE_FILE), serde_json::to_string(&notice).unwrap_or_default());
    RollbackRecord::clear(dir);
    // The previous version starts with its own count.
    let _ = std::fs::remove_file(dir.join(st::HEALTH_FILE));
    Ok(restart)
}

/// Reads and removes the note of a rollback (shown once).
pub fn take_notice(dir: &Path) -> Option<Notice> {
    let path = dir.join(st::UPDATES_DIR).join(NOTICE_FILE);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    serde_json::from_str(&text).ok()
}

/// Keeps a copy of the running version (`from`) before `to` is installed and writes the record.
pub fn keep_previous(dir: &Path, from: &str, to: &str, backup: Option<PathBuf>) -> RollbackRecord {
    RollbackRecord::clear(dir);
    let target = st::copy_dir(dir, from);
    let (kind, copy) = if fake_install() {
        (CopyKind::Test, None)
    } else {
        match copy_running(&target) {
            Ok(found) => found,
            Err(e) => {
                crate::devlog::warn("update", format!("no copy of {from} kept: {e}"));
                (CopyKind::None, None)
            }
        }
    };
    let record = RollbackRecord { from: from.into(), to: to.into(), backup, copy, kind, created: Utc::now() };
    if let Err(e) = record.save(dir) {
        crate::devlog::warn("update", format!("rollback record not written: {e}"));
    }
    record
}

#[cfg(any(windows, target_os = "macos"))]
fn exe() -> Result<PathBuf> {
    Ok(std::env::current_exe()?)
}

/// Copies the program into `target`; which kind depends on the platform and install.
fn copy_running(target: &Path) -> Result<(CopyKind, Option<PathBuf>)> {
    if crate::portable::active() {
        return Ok((CopyKind::None, None));
    }
    #[cfg(windows)]
    {
        let dir = exe()?.parent().map(Path::to_path_buf).ok_or_else(|| Error::State("no program folder".into()))?;
        let to = target.join("app");
        copy_tree(&dir, &to)?;
        Ok((CopyKind::WindowsDir, Some(to)))
    }
    #[cfg(target_os = "macos")]
    {
        let bundle = app_bundle()?;
        std::fs::create_dir_all(target)?;
        let to = target.join("Arcalo.app.tar.gz");
        let parent = bundle.parent().ok_or_else(|| Error::State("no parent".into()))?;
        let name = bundle.file_name().ok_or_else(|| Error::State("no bundle name".into()))?;
        let ok =
            std::process::Command::new("tar").arg("-czf").arg(&to).arg("-C").arg(parent).arg(name).status()?.success();
        if !ok {
            return Err(Error::State("tar failed".into()));
        }
        Ok((CopyKind::MacApp, Some(to)))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let Some(image) = std::env::var_os("APPIMAGE").map(PathBuf::from).filter(|p| p.is_file()) else {
            // A .deb or a build run: the package manager owns the program.
            return Ok((CopyKind::None, None));
        };
        std::fs::create_dir_all(target)?;
        let to = target.join("Arcalo.AppImage");
        std::fs::copy(&image, &to)?;
        Ok((CopyKind::AppImage, Some(to)))
    }
}

#[cfg(target_os = "macos")]
fn app_bundle() -> Result<PathBuf> {
    // Arcalo.app/Contents/MacOS/Arcalo
    exe()?
        .ancestors()
        .nth(3)
        .filter(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf)
        .ok_or_else(|| Error::State("not running from an .app bundle".into()))
}

#[cfg(windows)]
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        if entry.file_type()?.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// Puts the kept copy back in place of the running program.
fn reinstall(record: &RollbackRecord) -> Result<Restart> {
    let copy = record.copy.clone().filter(|c| c.exists());
    match (record.kind, copy) {
        (CopyKind::Test | CopyKind::None, _) => Ok(Restart::Continue),
        (_, None) => Err(Error::State(
            tr!("Die Kopie der vorherigen Version fehlt", "The copy of the previous version is missing").into(),
        )),
        #[cfg(windows)]
        (CopyKind::WindowsDir, Some(copy)) => {
            let exe = exe()?;
            let dir = exe.parent().map(Path::to_path_buf).ok_or_else(|| Error::State("no program folder".into()))?;
            // A running program may be renamed (not overwritten) on Windows.
            let aside = exe.with_extension("exe.rollback-old");
            let _ = std::fs::remove_file(&aside);
            std::fs::rename(&exe, &aside)?;
            if let Err(e) = copy_tree(&copy, &dir) {
                let _ = std::fs::rename(&aside, &exe);
                return Err(e.into());
            }
            Ok(Restart::Previous(exe))
        }
        #[cfg(target_os = "macos")]
        (CopyKind::MacApp, Some(copy)) => {
            let bundle = app_bundle()?;
            let parent = bundle.parent().map(Path::to_path_buf).ok_or_else(|| Error::State("no parent".into()))?;
            let unpack = parent.join(".arcalo-rollback");
            let _ = std::fs::remove_dir_all(&unpack);
            std::fs::create_dir_all(&unpack)?;
            if !std::process::Command::new("tar").arg("-xzf").arg(&copy).arg("-C").arg(&unpack).status()?.success() {
                return Err(Error::State("tar failed".into()));
            }
            let name = bundle.file_name().ok_or_else(|| Error::State("no bundle name".into()))?;
            let aside = parent.join(".arcalo-rollback-old.app");
            let _ = std::fs::remove_dir_all(&aside);
            std::fs::rename(&bundle, &aside)?;
            if let Err(e) = std::fs::rename(unpack.join(name), &bundle) {
                let _ = std::fs::rename(&aside, &bundle);
                return Err(e.into());
            }
            let _ = std::fs::remove_dir_all(&aside);
            let _ = std::fs::remove_dir_all(&unpack);
            Ok(Restart::Previous(bundle.join("Contents").join("MacOS").join(exe()?.file_name().unwrap_or_default())))
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        (CopyKind::AppImage, Some(copy)) => {
            use std::os::unix::fs::PermissionsExt;
            let image = std::env::var_os("APPIMAGE")
                .map(PathBuf::from)
                .ok_or_else(|| Error::State("not running as an AppImage".into()))?;
            let tmp = image.with_extension("rollback-new");
            std::fs::copy(&copy, &tmp)?;
            std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))?;
            // Replacing a running file's name is fine on Linux; the running process keeps the old inode.
            std::fs::rename(&tmp, &image)?;
            Ok(Restart::Previous(image))
        }
        #[allow(unreachable_patterns)]
        _ => Err(Error::State(
            tr!("Diese Kopie passt nicht zu diesem System", "This copy does not fit this system").into(),
        )),
    }
}

fn spawn(exe: &Path) -> std::io::Result<()> {
    std::process::Command::new(exe).spawn().map(|_| ())
}

/// „Zur vorherigen Version zurückkehren“ (Settings → Über) while the app runs: closes the
/// workspace, puts the database and the program back, and starts the previous version.
pub fn return_now(app: &tauri::AppHandle, dir: &Path, current: &str) -> Result<()> {
    let record = RollbackRecord::load(dir).filter(|r| r.can_return(current)).ok_or_else(|| {
        Error::State(
            tr!("Es gibt keine vorherige Version zum Zurückkehren", "There is no previous version to return to").into(),
        )
    })?;
    crate::prepare_exit(app);
    match restore(dir, &record) {
        Ok(Restart::Previous(exe)) => {
            if let Err(e) = spawn(&exe) {
                crate::devlog::error("update", format!("previous version not started: {e}"));
            }
            app.exit(0);
            Ok(())
        }
        // Test runs: the restored database opens again in this process.
        Ok(Restart::Continue) => {
            crate::resume_after_failed_exit(app);
            Ok(())
        }
        Err(e) => {
            crate::resume_after_failed_exit(app);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_program_swap_leaves_the_new_database_in_place() {
        let dir = std::env::temp_dir().join(format!("arcalo-rollback-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join(annalo_core::datadir::DB_FILE);
        std::fs::write(&db, b"migrated by the new version").unwrap();
        let backup = dir.join("pre-update.db");
        std::fs::write(&backup, b"before the update").unwrap();
        // The copy of the previous program is gone: the swap fails.
        let record = RollbackRecord {
            from: "1.9.0".into(),
            to: "1.10.0".into(),
            backup: Some(backup.clone()),
            copy: None,
            kind: CopyKind::AppImage,
            created: Utc::now(),
        };
        assert!(restore(&dir, &record).is_err());
        assert_eq!(std::fs::read(&db).unwrap(), b"migrated by the new version");
        // Nothing to swap (a .deb, test runs): the database returns.
        let record = RollbackRecord { kind: CopyKind::None, ..record };
        assert!(matches!(restore(&dir, &record), Ok(Restart::Continue)));
        assert_eq!(std::fs::read(&db).unwrap(), b"before the update");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
