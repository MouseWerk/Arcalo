//! The folders of the app identifier of 1.14 and earlier (`app.annalo.desktop`), taken over at
//! start before the WebView exists (see `arcalo_core::identity`): the data and config folder, the
//! WebView's storage (`EBWebView` in the local app data on Windows, WebKitGTK's in the data
//! folder on Linux, `~/Library/WebKit/<id>` on macOS) and the caches. A folder whose copy failed
//! is used where it is for this start ([`data_dir`], [`config_dir`], [`webview_dir`]).
//!
//! Skipped for a portable copy (everything lives next to the executable) and under
//! `ARCALO_DATA_DIR` (tests).

use std::path::PathBuf;
use std::sync::OnceLock;

use arcalo_core::datadir::Notice;
use arcalo_core::identity::{self as core, Mode, Outcome};
use tauri::{AppHandle, Manager};

#[derive(Default)]
struct Taken {
    /// Folders used in place of the new ones (their copy failed).
    data: Option<PathBuf>,
    config: Option<PathBuf>,
    webview: Option<PathBuf>,
    /// Lines for the developer log (written once it is open, see [`log`]).
    lines: Vec<(bool, String)>,
    notice: Option<Notice>,
}

static TAKEN: OnceLock<Taken> = OnceLock::new();

/// Takes over the folders of the old identifier; runs once, first thing in `setup`.
pub fn migrate(app: &AppHandle) {
    TAKEN.get_or_init(|| {
        if crate::portable::detect().is_some() || core::env_os("ARCALO_DATA_DIR").is_some() {
            return Taken::default();
        }
        let path = app.path();
        let mut bases = Vec::new();
        for (dir, mode) in [
            (path.data_dir(), Mode::Copy),
            (path.config_dir(), Mode::Copy),
            (path.local_data_dir(), Mode::Copy),
            (path.cache_dir(), Mode::Move),
        ] {
            if let Ok(d) = dir {
                bases.push((d, mode));
            }
        }
        // WKWebView keeps its storage by bundle id, outside the app's folders.
        #[cfg(target_os = "macos")]
        if let Ok(home) = path.home_dir() {
            bases.push((home.join("Library").join("WebKit"), Mode::Copy));
            bases.push((home.join("Library").join("HTTPStorages"), Mode::Move));
        }
        let outcomes = core::migrate(&core::pairs(&bases));
        let used = |new: Result<PathBuf, tauri::Error>| -> Option<PathBuf> {
            let new = new.ok()?;
            let o: &Outcome = outcomes.iter().find(|o| o.pair.to == new)?;
            (o.usable() != new).then(|| o.usable().to_path_buf())
        };
        Taken {
            data: used(path.app_data_dir()),
            config: used(path.app_config_dir()),
            webview: used(path.app_local_data_dir()),
            lines: outcomes
                .iter()
                .filter_map(|o| core::describe(o).map(|l| (matches!(o.status, core::Status::Failed(_)), l)))
                .collect(),
            notice: core::notice(&outcomes),
        }
    });
}

fn taken() -> Option<&'static Taken> {
    TAKEN.get()
}

/// The app data folder: the new one, or the old one while its copy failed.
pub fn data_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    match taken().and_then(|t| t.data.clone()) {
        Some(d) => Ok(d),
        None => app.path().app_data_dir(),
    }
}

/// The app config folder (`location.json`, `window.json`, the shared settings).
pub fn config_dir(app: &AppHandle) -> tauri::Result<PathBuf> {
    match taken().and_then(|t| t.config.clone()) {
        Some(d) => Ok(d),
        None => app.path().app_config_dir(),
    }
}

/// The WebView's profile folder while the copy of the old one failed (`None`: the default).
pub fn webview_dir() -> Option<PathBuf> {
    taken().and_then(|t| t.webview.clone())
}

/// For the user: a copy that failed or an older version's data taken over again.
pub fn notice() -> Option<Notice> {
    taken().and_then(|t| t.notice.clone())
}

/// Writes what [`migrate`] did into the developer log (once it is open).
pub fn log() {
    for (failed, line) in taken().map(|t| t.lines.as_slice()).unwrap_or_default() {
        if *failed {
            crate::devlog::warn("identity", line.clone());
        } else {
            crate::devlog::info("identity", line.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_identifier_is_the_one_tauri_runs_under() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], arcalo_core::identity::IDENTIFIER);
        // The MSIX package keeps both folders out of write virtualization (the copy must see them).
        let manifest = include_str!("../../packaging/msix/AppxManifest.xml");
        for id in [arcalo_core::identity::IDENTIFIER, arcalo_core::identity::LEGACY_IDENTIFIER] {
            assert!(manifest.contains(&format!(r"$(KnownFolder:RoamingAppData)\{id}<")), "{id}");
            assert!(manifest.contains(&format!(r"$(KnownFolder:LocalAppData)\{id}<")), "{id}");
        }
    }
}
