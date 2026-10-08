//! Android stand-in for `desktop.rs`: no tray, no global shortcuts, no quick-capture or search
//! windows. The shared code calls these; they do what applies to a phone (a notification, the
//! timer pause) and nothing else.

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::{AppState, Result, lock};

pub const MINIMIZED_ARG: &str = "--minimized";
pub const MAIN: &str = "main";
/// Number of global shortcut slots of the desktop (the settings still carry them).
pub const SLOTS: usize = 6;

pub fn show_main(_app: &AppHandle) {}

pub fn refresh_tray(_app: &AppHandle) {}

pub fn hide_popups(_app: &AppHandle) {}

pub fn relocalize(_app: &AppHandle) {}

/// Shortcuts are a desktop setting: the companion app keeps them as they are.
pub fn validate_shortcuts(_specs: [&str; SLOTS]) -> std::result::Result<(), String> {
    Ok(())
}

pub fn apply_shortcuts(_app: &AppHandle, _specs: [Option<&str>; SLOTS]) -> std::result::Result<(), String> {
    Ok(())
}

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::devlog::warn("mobile", format!("notification failed: {e}"));
    }
}

/// Pauses (or continues) the running timer (the desktop's version without the tray).
pub fn set_timer_paused(app: &AppHandle, state: &AppState, paused: bool) -> Result<()> {
    let now = Utc::now();
    {
        let db = state.db();
        if paused {
            db.pause_timer(now)?
        } else {
            db.resume_timer(now)?
        };
    }
    lock(&state.idle).suspend(now);
    let _ = app.emit("data://entries", ());
    Ok(())
}
