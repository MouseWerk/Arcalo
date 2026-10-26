//! What the app can do where it runs (1.20). The Android app shows the full desktop UI on large
//! screens (docs/android.md), the iOS app on the iPad and in wide windows (docs/ios.md); the
//! parts of the desktop that do not exist there (tray, global shortcuts, autostart, the command
//! line, the desktop updater, quick-capture and search windows, voice notes, local folders, the
//! encryption and the app lock) are hidden by the UI after these capabilities instead of failing
//! when used. iOS has Android's capabilities without the APK updates.
//!
//! The commands of those parts are not registered on Android and iOS (`#[cfg(desktop)]` in
//! [`crate::commands`]); [`DESKTOP_ONLY`] names them. A debug build started with
//! `ARCALO_SIMULATE_ANDROID=1` reports the Android capabilities on the desktop and refuses those
//! commands like Android does, so the end-to-end tests check the full app as Android runs it.

use serde::Serialize;
use tauri::Wry;

/// The capabilities the UI reads at the start (`app_capabilities`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// `windows`, `macos`, `linux`, `android` or `ios`.
    pub platform: &'static str,
    /// The Android or iOS app (also when simulated).
    pub mobile: bool,
    /// The Android capabilities on a desktop build (tests).
    pub simulated: bool,
    /// An icon in the tray or menu bar (the desktop still asks `desktop_info` whether it shows).
    pub tray: bool,
    /// Shortcuts that work while another app is in front.
    pub global_shortcuts: bool,
    /// Start with the system.
    pub autostart: bool,
    /// The program is also the command line (`arcalo pages …`, PATH).
    pub command_line: bool,
    /// The desktop's updater (installer, rollback); Android updates through its installer.
    pub desktop_updater: bool,
    /// The Android app's updates (`apk_update_*`).
    pub android_updater: bool,
    /// Windows of their own: quick capture, quick search, the presenter view.
    pub popup_windows: bool,
    /// The window's frame: own title bar and buttons, backdrop, closing to the tray, quitting.
    pub window_frame: bool,
    /// Choosing and opening local folders (data folder, backups, Markdown copy, vault import and
    /// export, a file's folder).
    pub folders: bool,
    /// Opening a file with the program the system has for it (on Android a copy, handed to the
    /// app Android has for its type; on iOS the share sheet with the copy).
    pub open_files: bool,
    /// Starting programs (quick links to a program or a local path).
    pub programs: bool,
    /// Voice notes (recording, Whisper models).
    pub voice: bool,
    /// The encryption of the database and the app lock.
    pub security: bool,
    /// Local backups, backup destinations and restoring a backup.
    pub backups: bool,
    /// Restarting the app from the app (a moved data folder, a restored backup).
    pub restart: bool,
    /// Proxy auto-configuration scripts evaluated by the app (a sandboxed WebView).
    pub pac: bool,
}

impl Capabilities {
    /// The desktop app on this operating system.
    pub fn desktop() -> Capabilities {
        Capabilities {
            platform: std::env::consts::OS,
            mobile: false,
            simulated: false,
            tray: true,
            global_shortcuts: true,
            autostart: true,
            command_line: true,
            desktop_updater: true,
            android_updater: false,
            popup_windows: true,
            window_frame: true,
            folders: true,
            open_files: true,
            programs: true,
            voice: true,
            security: true,
            backups: true,
            restart: true,
            pac: true,
        }
    }

    /// The Android app (the phone app and the full app on a large screen).
    pub fn android() -> Capabilities {
        Capabilities {
            platform: "android",
            mobile: true,
            simulated: false,
            tray: false,
            global_shortcuts: false,
            autostart: false,
            command_line: false,
            desktop_updater: false,
            android_updater: true,
            popup_windows: false,
            window_frame: false,
            folders: false,
            open_files: true,
            programs: false,
            voice: false,
            security: false,
            backups: false,
            restart: false,
            pac: false,
        }
    }

    /// The iOS app (iPhone and iPad): Android's, without the APK updates (the App Store updates
    /// the app; an app may not update itself there).
    pub fn ios() -> Capabilities {
        Capabilities { platform: "ios", android_updater: false, ..Capabilities::android() }
    }

    /// The capabilities of this build, as the UI gets them.
    pub fn current() -> Capabilities {
        if cfg!(target_os = "ios") {
            Capabilities::ios()
        } else if cfg!(mobile) {
            Capabilities::android()
        } else if simulated_android() {
            Capabilities { simulated: true, ..Capabilities::android() }
        } else {
            Capabilities::desktop()
        }
    }
}

/// A debug build started with `ARCALO_SIMULATE_ANDROID=1` (end-to-end tests): the UI gets the
/// Android capabilities and the commands Android does not have are refused.
pub fn simulated_android() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        cfg!(debug_assertions) && arcalo_core::identity::env("ARCALO_SIMULATE_ANDROID").is_some_and(|v| v.trim() == "1")
    })
}

#[tauri::command]
pub fn app_capabilities() -> Capabilities {
    Capabilities::current()
}

/// The commands only the desktop registers (`#[cfg(desktop)]` in [`crate::commands`]; a test
/// checks that both lists agree).
pub const DESKTOP_ONLY: &[&str] = &[
    "window_ready",
    "legacy_cleanup_notice",
    "jump_take",
    "window_hide",
    "window_close_action",
    "app_quit",
    "clipboard_write",
    "clipboard_write_image",
    "capture_hide",
    "capture_show",
    "capture_ready",
    "capture_context",
    "capture_undo",
    "capture_open",
    "search_hide",
    "search_open",
    "timer_resume_last",
    "desktop_info",
    "autostart_set",
    "cli_path_info",
    "cli_path_set",
    "presentation_begin",
    "presentation_end",
    "presenter_open",
    "presenter_close",
    "update_status",
    "update_flushed",
    "update_check",
    "update_install",
    "update_download",
    "update_pause",
    "update_restart_now",
    "update_skip",
    "update_unskip",
    "update_remind",
    "update_whats_new_seen",
    "update_rollback",
    "update_release_notes",
    "store_open_updates",
    "notify_test",
    "voice_devices",
    "voice_start",
    "voice_pause",
    "voice_stop",
    "voice_discard",
    "voice_status",
    "voice_job_cancel",
    "voice_summary_apply",
    "voice_models",
    "voice_model_download",
    "voice_model_cancel",
    "voice_model_import",
    "voice_model_delete",
    "voice_transcribe_again",
    "voice_unfinished",
    "voice_unfinished_save",
    "voice_unfinished_discard",
];

/// Wraps the command handler: with the Android capabilities simulated, the desktop-only commands
/// are refused as Android refuses a command it does not have.
pub fn guard<F>(inner: F) -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        let cmd = invoke.message.command();
        if simulated_android() && DESKTOP_ONLY.contains(&cmd) {
            crate::devlog::warn("platform", format!("{cmd} refused: not available on Android (simulated)"));
            let msg = format!("Command {cmd} not found");
            invoke.resolver.reject(msg);
            return true;
        }
        inner(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The names in the `generate_handler!` list of `commands()` with the `cfg` attribute before
    /// each (`None` for the shared ones).
    fn handler_list() -> Vec<(Option<String>, String)> {
        let src = include_str!("lib.rs");
        let start = src.find("pub(crate) fn commands()").expect("commands() in lib.rs");
        let body = &src[start..];
        let list = &body[body.find("generate_handler![").unwrap() + "generate_handler![".len()..];
        let list = &list[..list.find("])").unwrap()];
        let mut out = vec![];
        let mut cfg = None;
        for line in list.lines().map(str::trim).filter(|l| !l.is_empty() && !l.starts_with("//")) {
            if let Some(c) = line.strip_prefix("#[cfg(").and_then(|c| c.strip_suffix(")]")) {
                cfg = Some(c.to_owned());
                continue;
            }
            let name = line.trim_end_matches(',').rsplit("::").next().unwrap().to_owned();
            out.push((cfg.take(), name));
        }
        out
    }

    #[test]
    fn the_desktop_only_commands_are_the_ones_android_does_not_register() {
        let list = handler_list();
        assert!(list.len() > 400, "the list was not read: {}", list.len());
        let desktop: BTreeSet<&str> =
            list.iter().filter(|(c, _)| c.as_deref() == Some("desktop")).map(|(_, n)| n.as_str()).collect();
        let named: BTreeSet<&str> = DESKTOP_ONLY.iter().copied().collect();
        assert_eq!(desktop, named, "DESKTOP_ONLY and the #[cfg(desktop)] commands differ");
        // Only `desktop`, `mobile` and the two mobile systems are used; the mobile apps' own
        // commands are theirs alone, the APK updates Android's and the simulator check iOS's.
        const ANDROID: &str = "target_os = \"android\"";
        const IOS: &str = "target_os = \"ios\"";
        for (c, n) in &list {
            assert!(
                matches!(c.as_deref(), None | Some("desktop") | Some("mobile") | Some(ANDROID) | Some(IOS)),
                "{n}: cfg({c:?})"
            );
            if n.starts_with("apk_") {
                assert_eq!(c.as_deref(), Some(ANDROID), "{n}");
            } else if n.starts_with("ios_") {
                assert_eq!(c.as_deref(), Some(IOS), "{n}");
            } else if n.starts_with("mobile_") || n.starts_with("android_") {
                assert_eq!(c.as_deref(), Some("mobile"), "{n}");
            }
        }
        let names: BTreeSet<&str> = list.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(names.len(), list.len(), "a command is listed twice");
        assert!(names.contains("app_capabilities"));
    }

    #[test]
    fn android_has_none_of_the_desktop_only_parts() {
        let a = Capabilities::android();
        assert!(a.mobile && a.android_updater && !a.desktop_updater);
        assert!(!(a.tray || a.global_shortcuts || a.autostart || a.command_line || a.popup_windows));
        assert!(!(a.window_frame || a.folders || a.programs || a.voice || a.security || a.backups || a.restart));
        assert!(a.open_files, "attachments open in the app Android has for them");
        let d = Capabilities::desktop();
        assert!(!d.mobile && d.desktop_updater && !d.android_updater && d.folders && d.voice);
        // Without the variable (tests never set it) the desktop reports itself.
        if !simulated_android() {
            assert_eq!(Capabilities::current(), d);
        }
        let json = serde_json::to_value(a).unwrap();
        assert_eq!(json["platform"], "android");
        assert_eq!(json["globalShortcuts"], false);
    }

    #[test]
    fn ios_is_android_without_the_apk_updates() {
        let i = Capabilities::ios();
        assert_eq!(i.platform, "ios");
        assert!(i.mobile && !i.android_updater && !i.desktop_updater, "the App Store updates the app");
        assert_eq!(Capabilities { platform: "android", android_updater: true, ..i }, Capabilities::android());
        assert!(!(i.voice || i.command_line || i.folders || i.programs || i.security || i.backups));
        assert!(i.open_files, "attachments go to the share sheet");
        assert_eq!(serde_json::to_value(i).unwrap()["androidUpdater"], false);
    }
}
