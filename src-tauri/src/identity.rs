//! The folders of the app identifier of 1.14 and earlier (`app.annalo.desktop`), taken over at
//! start before the WebView exists (see `arcalo_core::identity`): the data and config folder, the
//! WebView's storage (`EBWebView` in the local app data on Windows, WebKitGTK's in the data
//! folder on Linux, `~/Library/WebKit/<id>` on macOS) and the caches. A folder whose copy failed
//! is used where it is for this start ([`data_dir`], [`config_dir`], [`webview_dir`]).
//!
//! Skipped for a portable copy (everything lives next to the executable) and under
//! `ARCALO_DATA_DIR` (tests).
//!
//! 1.17 deletes the old folders once their copy is in use, and then the credential store's
//! entries of the old service name ([`spawn_cleanup`], see `arcalo_core::identity::cleanup`).

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use arcalo_core::datadir::Notice;
use arcalo_core::identity::cleanup::{self, Reason, Step};
use arcalo_core::identity::{self as core, Mode, Outcome};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default)]
struct Taken {
    /// Folders used in place of the new ones (their copy failed).
    data: Option<PathBuf>,
    config: Option<PathBuf>,
    webview: Option<PathBuf>,
    /// Lines for the developer log (written once it is open, see [`log`]).
    lines: Vec<(bool, String)>,
    notice: Option<Notice>,
    /// What the migration found per pair (empty when it was skipped).
    outcomes: Vec<Outcome>,
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
            outcomes,
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

/// How long after the start the old folders are deleted: the start's own work (the first sync,
/// the backup check) comes first, and the window is long up. `ARCALO_CLEANUP_DELAY_SECS` (tests).
fn cleanup_delay() -> Duration {
    let secs = std::env::var("ARCALO_CLEANUP_DELAY_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(10);
    Duration::from_secs(secs)
}

/// Deletes the folders of the old identifier whose copy is in use, then the credential store's
/// entries of the old service name, once no old folder is left (an older version started on one
/// would still need them). In the background, a while after the start; nothing of it can stop or
/// slow the app: every failure keeps the old data and goes to the log.
pub fn spawn_cleanup(app: &AppHandle) {
    if crate::portable::active() {
        crate::devlog::debug("identity", "portable copy: the old folders and credential entries are left alone");
        return;
    }
    if taken().is_none_or(|t| t.outcomes.is_empty()) {
        return;
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("legacy-cleanup".into()).spawn(move || {
        std::thread::sleep(cleanup_delay());
        clean_up(&app);
    });
    if let Err(e) = spawned {
        crate::devlog::warn("identity", format!("the cleanup of the old folders did not start: {e}"));
    }
}

fn clean_up(app: &AppHandle) {
    let (Some(t), Some(state)) = (taken(), app.try_state::<crate::AppState>()) else { return };
    let Ok(config) = config_dir(app) else { return };
    // Settings that could not be read (the defaults are in use) might name a folder inside.
    let settings = state.db().load_settings_checked().ok().filter(|(_, broken)| broken.is_empty()).map(|(s, _)| s);
    let exe = arcalo_core::datadir::exe_dir(std::env::var_os("ARCALO_EXE_DIR").map(PathBuf::from));
    let version = crate::updates::current_version(app);
    let ctx = cleanup::Context {
        data_dir: &state.data_dir,
        config_dir: Some(&config),
        settings: settings.as_ref(),
        exe_dir: exe.as_deref(),
        portable: crate::portable::active(),
        version: &version,
    };
    let folders = cleanup::run(&t.outcomes, &ctx);
    for f in &folders {
        match &f.step {
            Step::Removed { .. } => crate::devlog::info("identity", f.describe()),
            Step::Kept(Reason::Failed(_)) => crate::devlog::warn("identity", f.describe()),
            Step::Kept(_) => crate::devlog::info("identity", f.describe()),
        }
    }
    let before = cleanup::read_log(&config);
    let (credentials, done) = if cleanup::legacy_left(&t.outcomes) || before.credentials_done {
        (Vec::new(), before.credentials_done)
    } else {
        crate::secrets::remove_legacy_all(&state.data_dir)
    };
    if folders.is_empty() && credentials.is_empty() && done == before.credentials_done {
        return;
    }
    match cleanup::record(&config, &folders, &credentials, done, chrono::Utc::now()) {
        Ok(log) if log.untold.is_some() => {
            let _ = app.emit("identity://cleaned", ());
        }
        Ok(_) => {}
        Err(e) => crate::devlog::warn("identity", format!("the cleanup's record not written: {e}")),
    }
}

/// One take at a time: the start and the event may ask together.
static NOTICE_LOCK: Mutex<()> = Mutex::new(());

/// What the cleanup removed, for a notice; once (`None` afterwards, and when nothing was removed).
#[tauri::command]
pub fn legacy_cleanup_notice(app: AppHandle) -> Option<String> {
    taken().filter(|t| !t.outcomes.is_empty())?;
    let _guard = crate::lock(&NOTICE_LOCK);
    cleanup::take_notice(&config_dir(&app).ok()?)
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
