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

/// Folder for the webview's profile (cookies, local storage, caches) of a portable copy.
pub fn webview_dir(data_dir: &Path) -> Option<PathBuf> {
    active().then(|| data_dir.join("webview"))
}

/// Why a feature that needs an installation is off.
pub const NOT_PORTABLE: &str =
    "Im portablen Modus nicht verfügbar: Annalo schreibt dann nichts in das Benutzerprofil dieses Rechners";
