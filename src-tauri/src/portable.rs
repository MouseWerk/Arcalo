//! Portable mode: a file `annalo-portable` next to `Annalo.exe` (or `data/.annalo-portable`)
//! keeps all data in `<exe dir>/data` (see `annalo_core::datadir`). A portable copy writes
//! nothing into the user profile it runs on: no `location.json`, no autostart entry, no
//! taskbar jump list, the webview's profile in `data/webview`, and updates are downloaded
//! by hand instead of installed. Secrets stay in the OS credential store under names of
//! their own per data folder (they do not travel with the stick; see `secrets.rs`).
//! `ANNALO_EXE_DIR` stands in for the executable's folder (tests).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use annalo_core::datadir;

static PORTABLE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Looks for the marker once at startup; returns the portable data folder.
pub fn detect() -> Option<PathBuf> {
    PORTABLE
        .get_or_init(|| {
            let exe = datadir::exe_dir(std::env::var_os("ANNALO_EXE_DIR").map(PathBuf::from))?;
            datadir::portable_data_dir(&exe)
        })
        .clone()
}

/// This copy runs portable.
pub fn active() -> bool {
    detect().is_some()
}

/// Held while a portable copy runs (see [`lock_instance`]).
static INSTANCE: std::sync::Mutex<Option<std::fs::File>> = std::sync::Mutex::new(None);

/// A portable copy's single-instance check: a lock on a file in its own data folder. The
/// installed copy's check is keyed by the app identifier, which both share, so it would let a
/// portable copy only bring the installed one to the front (and the other way round).
/// Returns `false` when another process runs on this data folder.
pub fn lock_instance(data_dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(data_dir);
    let Ok(file) =
        std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(data_dir.join(".annalo.lock"))
    else {
        return true; // a read-only stick: no lock possible, the start reports the folder
    };
    match file.try_lock() {
        Ok(()) => {
            *INSTANCE.lock().unwrap_or_else(|e| e.into_inner()) = Some(file);
            true
        }
        Err(std::fs::TryLockError::WouldBlock) => false,
        Err(_) => true,
    }
}

/// Releases the lock of [`lock_instance`] (before a restart, whose new process takes it).
pub fn unlock_instance() {
    INSTANCE.lock().unwrap_or_else(|e| e.into_inner()).take();
}

/// Folder for the webview's profile (cookies, local storage, caches) of a portable copy.
pub fn webview_dir(data_dir: &Path) -> Option<PathBuf> {
    active().then(|| data_dir.join("webview"))
}

/// Why a feature that needs an installation is off.
pub const NOT_PORTABLE: &str =
    "Im portablen Modus nicht verfügbar: Annalo schreibt dann nichts in das Benutzerprofil dieses Rechners";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_process_per_portable_data_folder() {
        let dir = std::env::temp_dir().join(format!("annalo-portable-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(lock_instance(&dir));
        let other = std::fs::File::open(dir.join(".annalo.lock")).unwrap();
        assert!(matches!(other.try_lock(), Err(std::fs::TryLockError::WouldBlock)), "a second copy sees the lock");
        unlock_instance();
        assert!(other.try_lock().is_ok(), "released for a restart");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
