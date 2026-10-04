//! The rename to Arcalo at start (`annalo_core::rebrand`): the autostart entry of the old name
//! and old shortcuts the installer left behind. Runs at every start and does nothing once they
//! are gone. A portable copy never wrote either; the Store package has its own startup task and
//! Start entry and leaves those of an installed copy alone.

use annalo_core::rebrand;
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt as _;

use crate::devlog;

pub fn migrate(app: &AppHandle) {
    if crate::portable::active() || crate::store::active() {
        return;
    }
    autostart(app);
    // An entry that is on follows the program file (Annalo.app renamed to Arcalo.app by hand, a
    // moved AppImage): written again with this executable.
    if matches!(app.autolaunch().is_enabled(), Ok(true))
        && let Err(e) = app.autolaunch().enable()
    {
        devlog::warn("rebrand", format!("autostart entry not refreshed: {e}"));
    }
    #[cfg(windows)]
    shortcuts(app);
}

/// The old entry's state is read first; the new entry is written before the old one goes, so a
/// failure leaves the (still working) old entry in place.
fn autostart(app: &AppHandle) {
    let Some(old) = OldEntry::find(app) else { return };
    if old.on
        && let Err(e) = app.autolaunch().enable()
    {
        devlog::warn(
            "rebrand",
            format!("autostart entry „{}“ kept: the new one could not be written: {e}", rebrand::OLD_NAME),
        );
        return;
    }
    match old.remove() {
        Ok(()) if old.on => devlog::info(
            "rebrand",
            format!("autostart entry „{}“ renamed to „{}“", rebrand::OLD_NAME, rebrand::NEW_NAME),
        ),
        Ok(()) => devlog::info("rebrand", format!("autostart entry „{}“ (switched off) removed", rebrand::OLD_NAME)),
        Err(e) => devlog::warn("rebrand", format!("autostart entry „{}“ not removed: {e}", rebrand::OLD_NAME)),
    }
}

struct OldEntry {
    on: bool,
    #[cfg(windows)]
    launch: auto_launch::AutoLaunch,
    #[cfg(not(windows))]
    file: std::path::PathBuf,
}

impl OldEntry {
    /// The Run value `Annalo` (its state honors „disabled“ in Task Manager).
    #[cfg(windows)]
    fn find(_app: &AppHandle) -> Option<Self> {
        let exe = std::env::current_exe().ok()?;
        let launch = auto_launch::AutoLaunchBuilder::new()
            .set_app_name(rebrand::OLD_NAME)
            .set_app_path(&exe.display().to_string())
            .build()
            .ok()?;
        let present = winreg_value_exists(rebrand::OLD_NAME);
        present.then(|| Self { on: launch.is_enabled().unwrap_or(false), launch })
    }

    #[cfg(windows)]
    fn remove(&self) -> Result<(), String> {
        self.launch.disable().map_err(|e| e.to_string())
    }

    /// `~/Library/LaunchAgents/Annalo.plist` or `~/.config/autostart/Annalo.desktop`.
    #[cfg(not(windows))]
    fn find(app: &AppHandle) -> Option<Self> {
        let home = app.path().home_dir().ok()?;
        let file = rebrand::legacy_autostart_file(&home, cfg!(target_os = "macos"));
        rebrand::legacy_autostart_state(&file).map(|on| Self { on, file })
    }

    #[cfg(not(windows))]
    fn remove(&self) -> Result<(), String> {
        rebrand::take_legacy_autostart_file(&self.file).map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Whether `HKCU\…\CurrentVersion\Run` has a value `name` (switched on or not).
#[cfg(windows)]
fn winreg_value_exists(name: &str) -> bool {
    use winreg::{RegKey, enums::HKEY_CURRENT_USER};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Run")
        .and_then(|k| k.get_raw_value(name))
        .is_ok()
}

/// Start menu and desktop shortcuts of the old name next to new ones (the installer replaces
/// them; this covers an installer that could not).
#[cfg(windows)]
fn shortcuts(app: &AppHandle) {
    let (Ok(roaming), Ok(desktop)) = (app.path().data_dir(), app.path().desktop_dir()) else { return };
    let programs = roaming.join("Microsoft").join("Windows").join("Start Menu").join("Programs");
    for f in rebrand::remove_stale_shortcuts(&programs, &desktop) {
        devlog::info("rebrand", format!("old shortcut removed: {}", f.display()));
    }
}
