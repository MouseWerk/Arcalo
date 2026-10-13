//! Android stand-in for `desktop.rs`: no tray, no global shortcuts, no quick-capture or search
//! windows. The shared code calls these; they do what applies to a phone (a notification, the
//! timer pause, a line captured from the full app's start page) and nothing else.

use arcalo_core::calsync::tz::Zone;
use arcalo_core::capture::{self as cap, CaptureTarget};
use arcalo_core::desktop::CaptureOutcome;
use chrono::{Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
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

/// What `capture_submit` returns, in the desktop's shape (Android keeps no queue and no undo list).
#[derive(Serialize)]
pub struct Submitted {
    #[serde(flatten)]
    outcome: CaptureOutcome,
    id: Option<u64>,
    queued: bool,
}

/// A line of the full app's start page („Aufgabe für heute“, a task for a page), stored like the
/// desktop's quick capture: into today's daily note, the inbox or the page.
#[tauri::command]
pub fn capture_submit(
    app: AppHandle,
    state: State<AppState>,
    text: String,
    target: Option<CaptureTarget>,
) -> Result<Submitted> {
    let settings = state.settings();
    let zone = Zone::Local;
    let opts = cap::CaptureOptions {
        inbox_title: &settings.capture.inbox_title,
        thresholds: &settings.thresholds,
        zone: &zone,
        book_time: settings.time_tracking(),
    };
    let (outcome, _) = cap::capture_to(&state.db(), &text, &target.unwrap_or_default(), &opts, Utc::now(), &Local)?;
    if !outcome.bookings.is_empty() {
        let _ = app.emit("data://entries", ());
    }
    if let Some(a) = &outcome.appended {
        let _ = app.emit("data://tasks", a.page_id);
    }
    Ok(Submitted { outcome, id: None, queued: false })
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
