//! The Microsoft Store build (docs/release/microsoft-store.md, packaging/msix/). The Store
//! installs Arcalo as an MSIX package and updates it itself, so this copy never updates or rolls
//! back on its own: no update checks, downloads or install on quit, no rollback. Portable mode
//! is off. Autostart is the package's startup task (`windows.startupTask` in the manifest, not
//! the Run key), the `arcalo-notify:` address of the notification buttons is declared in the
//! manifest (not written to HKCU\Software\Classes), and toasts and the taskbar use the package's
//! app id.
//!
//! Selected at build time by the cargo feature `store`, and at run time by the package identity
//! (`GetCurrentPackageFullName`): the regular Windows binary behaves the same way when it runs
//! from a package. Debug builds pretend with `ANNALO_STORE=1` (tests).

use std::sync::OnceLock;

/// The startup task's `TaskId` in `packaging/msix/AppxManifest.xml`.
#[cfg_attr(not(windows), allow(dead_code))]
pub const STARTUP_TASK: &str = "ArcaloStartup";

/// Microsoft Store page of the app's updates (the user's library with „Updates abrufen“).
pub const STORE_UPDATES_URI: &str = "ms-windows-store://downloadsandupdates";

/// This copy came from the Microsoft Store (or runs packaged): updates come from there.
pub fn active() -> bool {
    static ACTIVE: OnceLock<bool> = OnceLock::new();
    *ACTIVE.get_or_init(|| {
        cfg!(feature = "store")
            || packaged()
            || annalo_core::update::test_override(cfg!(debug_assertions), std::env::var("ANNALO_STORE").ok().as_deref())
                .is_some_and(|v| v != "0")
    })
}

/// Runs with a package identity (installed from an MSIX package).
pub fn packaged() -> bool {
    static PACKAGED: OnceLock<bool> = OnceLock::new();
    *PACKAGED.get_or_init(|| package_full_name().is_some())
}

/// `Arcalo_1.12.0.0_x64__<publisher id>`, or `None` without a package identity.
fn package_full_name() -> Option<String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
        use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
        let mut len = 0u32;
        // Unpackaged: APPMODEL_ERROR_NO_PACKAGE; packaged: the length it needs.
        if unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) } != ERROR_INSUFFICIENT_BUFFER {
            return None;
        }
        let mut buf = vec![0u16; len as usize];
        if unsafe { GetCurrentPackageFullName(&mut len, buf.as_mut_ptr()) } != 0 {
            return None;
        }
        Some(String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]))
    }
    #[cfg(not(windows))]
    None
}

/// The package's app execution alias (`Arcalo.exe` in `%LOCALAPPDATA%\Microsoft\WindowsApps`,
/// `uap3:AppExecutionAlias` in the manifest): starts the app with its package identity. `None`
/// when this copy is not packaged or the alias is missing.
pub fn alias() -> Option<std::path::PathBuf> {
    if !packaged() {
        return None;
    }
    let local = std::env::var_os("LOCALAPPDATA")?;
    let path = std::path::Path::new(&local).join("Microsoft").join("WindowsApps").join("Arcalo.exe");
    // A reparse point that `is_file` may not follow: its entry is enough.
    std::fs::symlink_metadata(&path).is_ok().then_some(path)
}

/// Why the app's own update functions are off.
pub fn updates_from_store() -> &'static str {
    annalo_core::tr!("Updates kommen über den Microsoft Store", "Updates come from the Microsoft Store")
}

/// Started by the package's startup task at sign-in (it passes no arguments, so the
/// activation kind tells): the app starts hidden, as with `--minimized`.
pub fn started_at_login() -> bool {
    #[cfg(windows)]
    if packaged() {
        use windows::ApplicationModel::Activation::ActivationKind;
        use windows::ApplicationModel::AppInstance;
        return AppInstance::GetActivatedEventArgs()
            .and_then(|a| a.Kind())
            .is_ok_and(|k| k == ActivationKind::StartupTask);
    }
    false
}

/// The startup task: on, or `None` when it cannot be read (no package).
pub fn autostart_enabled() -> Option<Result<bool, String>> {
    #[cfg(windows)]
    if packaged() {
        return Some(win::task().and_then(|t| t.State()).map(win::is_on).map_err(|e| e.message()));
    }
    None
}

/// Switches the startup task. Windows does not let an app switch on a task the user switched off
/// in Settings or Task Manager (or the organization by policy); the error says where to do it.
pub fn set_autostart(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    if packaged() {
        return win::set(enabled);
    }
    let _ = enabled;
    Err(no_package().into())
}

#[cfg_attr(windows, allow(dead_code))]
fn no_package() -> &'static str {
    annalo_core::tr!("Arcalo läuft nicht aus dem Paket", "Arcalo does not run from its package")
}

#[cfg(windows)]
mod win {
    use windows::ApplicationModel::{StartupTask, StartupTaskState};
    use windows::core::HSTRING;

    pub fn task() -> windows::core::Result<StartupTask> {
        StartupTask::GetAsync(&HSTRING::from(super::STARTUP_TASK))?.get()
    }

    pub fn is_on(state: StartupTaskState) -> bool {
        state == StartupTaskState::Enabled || state == StartupTaskState::EnabledByPolicy
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let task = task().map_err(|e| e.message())?;
        if !enabled {
            return task.Disable().map_err(|e| e.message());
        }
        let state = task.RequestEnableAsync().and_then(|op| op.get()).map_err(|e| e.message())?;
        match state {
            s if is_on(s) => Ok(()),
            StartupTaskState::DisabledByPolicy => Err(annalo_core::tr!(
                "Deine Organisation hat den Autostart abgeschaltet",
                "Your organization has turned autostart off"
            )
            .into()),
            _ => Err(annalo_core::tr!(
                "Der Autostart ist in den Windows-Einstellungen ausgeschaltet: dort unter „Apps“ → „Autostart“ für Arcalo wieder einschalten",
                "Autostart is turned off in Windows Settings: turn it on again for Arcalo under “Apps” → “Startup”"
            )
            .into()),
        }
    }
}

/// Settings → Über → Updates „Microsoft Store öffnen“: the Store's page of downloads and updates.
#[tauri::command]
pub fn store_open_updates(app: tauri::AppHandle) -> crate::Result<()> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_url(STORE_UPDATES_URI, None::<&str>).map_err(|e| annalo_core::Error::State(e.to_string()))
}
