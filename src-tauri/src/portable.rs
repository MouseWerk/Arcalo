//! Portable mode: a file `arcalo-portable` next to `Arcalo.exe` (or `data/.arcalo-portable`;
//! the `annalo-` markers of copies from before 1.7 count too)
//! keeps all data in `<exe dir>/data` (see `arcalo_core::datadir`). A portable copy writes
//! nothing into the user profile it runs on: no `location.json`, no autostart entry, no
//! taskbar jump list, the webview's profile in `data/webview`, and updates are downloaded
//! by hand instead of installed. Secrets stay in the OS credential store under names of
//! their own per data folder (they do not travel with the stick; see `secrets.rs`).
//! `ARCALO_EXE_DIR` stands in for the executable's folder (tests). The Microsoft Store build
//! never runs portable (its program folder is the read-only package, see `store.rs`).

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use arcalo_core::datadir;

static PORTABLE: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Looks for the marker once at startup; returns the portable data folder.
pub fn detect() -> Option<PathBuf> {
    PORTABLE
        .get_or_init(|| {
            if crate::store::active() {
                return None;
            }
            let exe = datadir::exe_dir(std::env::var_os("ARCALO_EXE_DIR").map(PathBuf::from))?;
            datadir::portable_data_dir(&exe)
        })
        .clone()
}

/// This copy runs portable.
pub fn active() -> bool {
    detect().is_some()
}

/// Held while a portable copy runs (see [`lock_instance`]): the lock file and the one of
/// 1.14 and earlier.
static INSTANCE: std::sync::Mutex<Vec<std::fs::File>> = std::sync::Mutex::new(Vec::new());

/// The lock file in the data folder.
const LOCK_FILE: &str = ".arcalo.lock";

/// A portable copy's single-instance check: a lock on a file in its own data folder. The
/// installed copy's check is keyed by the app identifier, which both share, so it would let a
/// portable copy only bring the installed one to the front (and the other way round).
/// Returns `false` when another process runs on this data folder. A copy of 1.14 or earlier
/// locks `.annalo.lock`: it is checked too, so the two never run on one folder.
pub fn lock_instance(data_dir: &Path) -> bool {
    let _ = std::fs::create_dir_all(data_dir);
    let mut held = Vec::new();
    let legacy = arcalo_core::identity::legacy(LOCK_FILE);
    for (name, create) in [(LOCK_FILE, true), (legacy.as_str(), false)] {
        let path = data_dir.join(name);
        if !create && !path.is_file() {
            continue;
        }
        let Ok(file) = std::fs::OpenOptions::new().create(create).truncate(false).write(true).open(&path) else {
            continue; // a read-only stick: no lock possible, the start reports the folder
        };
        match file.try_lock() {
            Ok(()) => held.push(file),
            Err(std::fs::TryLockError::WouldBlock) => return false,
            Err(_) => {}
        }
    }
    *INSTANCE.lock().unwrap_or_else(|e| e.into_inner()) = held;
    true
}

/// Releases the lock of [`lock_instance`] (before a restart, whose new process takes it).
pub fn unlock_instance() {
    INSTANCE.lock().unwrap_or_else(|e| e.into_inner()).clear();
}

/// Folder for the webview's profile (cookies, local storage, caches) of a portable copy, or the
/// profile of the old app identifier while its copy failed (see `identity.rs`).
pub fn webview_dir(data_dir: &Path) -> Option<PathBuf> {
    if active() {
        return Some(data_dir.join("webview"));
    }
    #[cfg(desktop)]
    return crate::identity::webview_dir();
    #[cfg(mobile)]
    None
}

/// Why a feature that needs an installation is off.
pub fn not_portable() -> &'static str {
    arcalo_core::tr!(
        "Im portablen Modus nicht verfügbar: Arcalo schreibt dann nichts in das Benutzerprofil dieses Computers",
        "Not available in portable mode: Arcalo then writes nothing into this computer's user profile"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_process_per_portable_data_folder() {
        let dir = std::env::temp_dir().join(format!("arcalo-portable-lock-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(lock_instance(&dir));
        let other = std::fs::File::open(dir.join(".arcalo.lock")).unwrap();
        assert!(matches!(other.try_lock(), Err(std::fs::TryLockError::WouldBlock)), "a second copy sees the lock");
        unlock_instance();
        assert!(other.try_lock().is_ok(), "released for a restart");
        drop(other);
        // A copy of 1.14 runs on the folder (it holds the lock of the old name).
        let old = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(".annalo.lock"))
            .unwrap();
        old.try_lock().unwrap();
        assert!(!lock_instance(&dir), "the old copy's lock counts");
        drop(old);
        assert!(lock_instance(&dir));
        unlock_instance();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
