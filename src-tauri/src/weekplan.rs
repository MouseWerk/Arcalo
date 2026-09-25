//! „Woche vorschlagen“ in the shell: the proposal and its takeover as IPC commands, and the
//! reminder on the last workday of the week. The logic lives in `annalo_core::weekplan`.

use std::sync::atomic::{AtomicBool, Ordering};

use annalo_core::calsync::outlook;
use annalo_core::calsync::tz::Zone;
use annalo_core::weekplan::{self as core, Accepted, Applied, ProposeOptions, WeekProposal};
use chrono::{Local, NaiveDate, Utc};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::desktop::{MAIN, notify};
use crate::{AppState, Result};

/// The reminder was shown while the app was in the background: the next focus of the main
/// window opens the proposal.
static PENDING: AtomicBool = AtomicBool::new(false);

/// Meta row with the ISO week of the last reminder.
const REMINDED: &str = "week_proposal.week";

/// The proposal for the week starting at `week_start` (local days). `rest_of_today` adds
/// today's appointments that are still to come.
#[tauri::command(async)]
pub fn week_proposal(
    state: State<AppState>,
    week_start: NaiveDate,
    rest_of_today: Option<bool>,
) -> Result<WeekProposal> {
    let sources = state.settings().calendar.active_sources(outlook::available());
    let opts = ProposeOptions { rest_of_today: rest_of_today.unwrap_or(false), sources: Some(sources) };
    core::propose(&state.reader(), week_start, Utc::now(), &Zone::Local, &opts)
}

/// Books the accepted proposals as drafts (one transaction) and links their sources.
#[tauri::command(async)]
pub fn week_proposal_apply(app: AppHandle, state: State<AppState>, items: Vec<Accepted>) -> Result<Applied> {
    let thresholds = state.settings().thresholds;
    let out = core::apply(&state.db(), &items, Utc::now(), &thresholds)?;
    let _ = app.emit("data://entries", ());
    Ok(out)
}

/// Called with the other reminders (~30 s): on the last workday of the week from 14:00, once,
/// when earlier workdays are below the target.
pub fn periodic(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.notifications.week_proposal {
        return;
    }
    let now = Local::now().naive_local();
    let body = {
        let db = state.db();
        let last = db.meta_get(REMINDED).ok().flatten();
        // Cheap checks first: most of the week nothing is due.
        let due = core::week_reminder(now, &settings, &[(now.date(), 1)], last.as_deref()).is_some();
        let msg = if due {
            core::open_days(&db, Utc::now(), &Zone::Local)
                .ok()
                .and_then(|open| core::week_reminder(now, &settings, &open, last.as_deref()))
        } else {
            None
        };
        if due {
            // Once per week, whether or not days are open.
            let _ = db.meta_set(REMINDED, &core::week_key(now.date()));
        }
        msg
    };
    if let Some(body) = body {
        notify(app, "Woche vorschlagen", &body);
        let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
        if !focused {
            PENDING.store(true, Ordering::Relaxed);
        }
    }
}

/// The main window got the focus: open the proposal after a reminder.
pub fn on_focus(app: &AppHandle) {
    if PENDING.swap(false, Ordering::Relaxed) {
        let _ = app.emit_to(MAIN, "nav://week-proposal", ());
    }
}
