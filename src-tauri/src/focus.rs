//! Focus sessions in the shell: IPC commands, the silent „Pause“ notification, holding back
//! desktop notifications while a session runs, and the daily note line at the end of the day.

use std::sync::Mutex;

use annalo_core::focus::{self, FocusOutcome, FocusReport, FocusStart, FocusState};
use annalo_core::{Error, desktop as core};
use chrono::{Local, NaiveDate, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

use crate::{AppState, lock};

type Result<T> = std::result::Result<T, Error>;

/// A desktop notification held back during a session.
#[derive(Debug, Clone, Serialize)]
pub struct Held {
    pub title: String,
    pub body: String,
}

static HELD: Mutex<Vec<Held>> = Mutex::new(Vec::new());

/// Holds a desktop notification back while a focus session runs; true when it was held.
pub fn hold(app: &AppHandle, title: &str, body: &str) -> bool {
    let Some(state) = app.try_state::<AppState>() else { return false };
    if !focus::holds_notifications(&state.db(), Utc::now()) {
        return false;
    }
    let mut held = lock(&HELD);
    if held.len() < 50 {
        held.push(Held { title: title.to_owned(), body: body.to_owned() });
    }
    true
}

/// A finished or aborted session, with the notifications held back meanwhile.
#[derive(Serialize)]
pub struct FocusDone {
    #[serde(flatten)]
    outcome: FocusOutcome,
    held: Vec<Held>,
}

fn done(app: &AppHandle, outcome: FocusOutcome, notify: bool) -> FocusDone {
    let held = std::mem::take(&mut *lock(&HELD));
    let _ = app.emit("data://entries", ());
    let _ = app.emit("focus://changed", ());
    if notify {
        pause_notification(app, &outcome);
    }
    FocusDone { outcome, held }
}

/// „Pause“ without a sound when a session was completed.
fn pause_notification(app: &AppHandle, o: &FocusOutcome) {
    if o.session.status != "done" {
        return;
    }
    let what = if o.session.reference.is_empty() { String::new() } else { format!(" auf {}", o.session.reference) };
    let body = if o.session.break_minutes > 0 {
        format!(
            "{} Fokus{what} geschafft. {} Min. Pause.",
            focus::hm(o.session.worked_minutes),
            o.session.break_minutes
        )
    } else {
        format!("{} Fokus{what} geschafft.", focus::hm(o.session.worked_minutes))
    };
    if let Err(e) = app.notification().builder().title("Pause").body(body).silent().show() {
        crate::devlog::warn("focus", format!("notification failed: {e}"));
    }
}

#[derive(Serialize)]
pub struct FocusStateView {
    #[serde(flatten)]
    state: FocusState,
    /// Notifications held back by a session that was completed by this call.
    held: Vec<Held>,
}

/// The current phase; completes (and books) a session that ran out meanwhile.
#[tauri::command]
pub fn focus_state(app: AppHandle, state: State<AppState>) -> Result<Option<FocusStateView>> {
    let st = focus::state(&state.db(), Utc::now(), &Local)?;
    Ok(st.map(|s| {
        let held = if let Some(c) = &s.completed { done(&app, c.clone(), true).held } else { vec![] };
        FocusStateView { state: s, held }
    }))
}

#[tauri::command]
pub fn focus_start(app: AppHandle, state: State<AppState>, start: FocusStart) -> Result<FocusState> {
    // One that ran out meanwhile is booked first.
    let completed = focus::state(&state.db(), Utc::now(), &Local)?.and_then(|s| s.completed);
    if let Some(c) = completed {
        done(&app, c, false);
    }
    let session = focus::start(&state.db(), &start, Utc::now())?;
    lock(&HELD).clear();
    let _ = app.emit("focus://changed", ());
    let ends_at = session.ends_at();
    Ok(FocusState { session, phase: "work", ends_at, completed: None })
}

/// Completes the running session at its end (called by the UI's countdown).
#[tauri::command]
pub fn focus_finish(app: AppHandle, state: State<AppState>) -> Result<FocusDone> {
    let outcome = focus::finish(&state.db(), Utc::now(), &Local)?;
    Ok(done(&app, outcome, true))
}

/// Ends the running session early; with `book` the minutes so far are booked.
#[tauri::command]
pub fn focus_abort(app: AppHandle, state: State<AppState>, book: bool) -> Result<FocusDone> {
    let outcome = focus::abort(&state.db(), Utc::now(), book, &Local)?;
    Ok(done(&app, outcome, false))
}

#[tauri::command]
pub fn focus_end_break(app: AppHandle, state: State<AppState>) -> Result<()> {
    focus::end_break(&state.db(), Utc::now())?;
    let _ = app.emit("focus://changed", ());
    Ok(())
}

/// Sessions and minutes per Vorgang of the local days `from..=to`.
#[tauri::command]
pub fn focus_report(state: State<AppState>, from: NaiveDate, to: NaiveDate) -> Result<FocusReport> {
    focus::report(&state.db(), from, to, &Local)
}

/// Writes „Fokus heute: …“ into the daily note of `date` (default today); returns its page id.
#[tauri::command]
pub fn focus_daily_line(state: State<AppState>, date: Option<NaiveDate>) -> Result<i64> {
    focus::write_daily_line(&state.db(), date.unwrap_or_else(|| Local::now().date_naive()), &Local)
}

/// Time entries booked by focus sessions (marked in the timesheet).
#[tauri::command]
pub fn focus_entry_ids(state: State<AppState>) -> Result<Vec<i64>> {
    focus::entry_ids(&state.db())
}

const NOTE_DAY: &str = "focus.note_day";

/// Every ~30 s: completes a session that ran out while the window slept, and at the end of the
/// day (reminder time, default 18:00) writes the focus line into the daily note once.
pub fn periodic(app: &AppHandle) {
    let state = app.state::<AppState>();
    let completed = {
        let db = state.db();
        focus::state(&db, Utc::now(), &Local).ok().flatten().and_then(|s| s.completed)
    };
    if let Some(c) = completed {
        // The UI shows the same summary as after a session it completed itself.
        let d = done(app, c, true);
        let _ = app.emit("focus://completed", &d);
    }
    let now = Local::now();
    let at = state.settings().reminder_time.as_deref().and_then(core::parse_hhmm);
    let evening = at.unwrap_or_else(|| chrono::NaiveTime::from_hms_opt(18, 0, 0).unwrap_or_default());
    if now.time() < evening {
        return;
    }
    let today = now.date_naive();
    let db = state.db();
    if db.meta_get(NOTE_DAY).ok().flatten().as_deref() == Some(&today.to_string())
        || focus::running(&db).ok().flatten().is_some()
    {
        return;
    }
    if focus::report(&db, today, today, &Local).is_ok_and(|r| r.sessions > 0) {
        match focus::write_daily_line(&db, today, &Local) {
            Ok(page) => {
                let _ = db.meta_set(NOTE_DAY, &today.to_string());
                // Open editors of the daily note take over the new line.
                let _ = app.emit("data://tasks", page);
            }
            Err(e) => crate::devlog::warn("focus", format!("daily note line not written: {e}")),
        }
    }
}
