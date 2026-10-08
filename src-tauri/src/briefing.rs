//! „Morgen-Briefing“ in the shell: the briefing of today in one call, its text „Was ist heute
//! wichtig“ (cached per day), the first start of the day and the notification at a set time.
//! The logic lives in `arcalo_core::briefing`.
//!
//! The text goes through the router like every request; a briefing with private content
//! (`#privat`, a private appointment or page) is routed to the local model.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use arcalo_core::ai::availability;
use arcalo_core::ai::client::ChatRequest;
use arcalo_core::ai::router::Tier;
use arcalo_core::ai::transform;
use arcalo_core::briefing::{self as core, Briefing, BriefingMode, BriefingSummary, StartAction};
use arcalo_core::calsync::outlook;
use arcalo_core::{Database, Error, tr};
use chrono::{Local, NaiveDate, Utc};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::desktop::MAIN;
use crate::{AppState, Result, prefs};

/// The notification was shown while the app was in the background: the next focus of the
/// main window opens the briefing.
static PENDING: AtomicBool = AtomicBool::new(false);

/// The day of the last first-start check (none until the UI ran it after the start). Left in
/// the tray overnight, the app runs the check again on the new day ([`core::new_day_check`]).
static SEEN: Mutex<Option<NaiveDate>> = Mutex::new(None);

fn seen() -> Option<NaiveDate> {
    *SEEN.lock().unwrap_or_else(|e| e.into_inner())
}

fn set_seen(day: NaiveDate) {
    *SEEN.lock().unwrap_or_else(|e| e.into_inner()) = Some(day);
}

/// Debug builds: `ARCALO_TEST_BRIEFING_DAY=<yyyy-mm-dd>` is taken as the day of the check at
/// the start, so the next tick or focus sees a new day.
fn test_seen_day() -> Option<NaiveDate> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var("ARCALO_TEST_BRIEFING_DAY").ok()?.trim().parse().ok()
}

/// Whether any AI provider can be asked (one with a key, or one that needs none).
pub(crate) fn ai_ready(state: &AppState) -> bool {
    state.clients().iter().any(|(_, c)| c.has_key() || !c.provider().needs_key())
}

/// Today's briefing with the meetings of the booking calendars (not those of colleagues
/// unless chosen) that the views do not hide (`hidden`, kept per computer by the UI).
fn build(state: &AppState, db: &Database, hidden: &[String]) -> Result<Briefing> {
    let settings = state.settings();
    let sources: Vec<String> =
        settings.calendar.booking_sources(outlook::available()).into_iter().filter(|s| !hidden.contains(s)).collect();
    let mut b = core::briefing(db, Local::now().date_naive(), &Local, &settings, &sources, Utc::now())?;
    b.ai_ready = ai_ready(state);
    Ok(b)
}

fn last_day(db: &Database) -> Option<NaiveDate> {
    db.meta_get(core::DAY_KEY).ok().flatten().and_then(|s| s.parse::<NaiveDate>().ok())
}

/// Today's briefing: meetings, Jira, tasks, the last workday and the cached text, at once.
#[tauri::command(async)]
pub fn briefing(state: State<AppState>, hidden: Option<Vec<String>>) -> Result<Briefing> {
    build(&state, &state.reader(), &hidden.unwrap_or_default())
}

/// „Was heute wichtig ist“: the cached text of today, or (with `refresh`, or none yet) a new
/// one written from titles, times and counts. Streams `ai://stream` events for `request_id`.
#[tauri::command]
pub async fn briefing_summary(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    hidden: Option<Vec<String>>,
    refresh: Option<bool>,
) -> Result<BriefingSummary> {
    let b = build(&state, &state.reader(), &hidden.unwrap_or_default())?;
    if !refresh.unwrap_or(false)
        && let Some(s) = b.summary.clone()
    {
        return Ok(s);
    }
    if !b.ai_ready {
        return Err(Error::State(
            tr!("Keine KI verbunden (Einstellungen → KI & Modelle).", "No AI connected (Settings → AI & models).")
                .into(),
        ));
    }
    prefs::check_cost_limit(&state, false)?;
    let messages = core::summary_messages(&b, &Local);
    let prompt = messages.last().and_then(|m| m.content.clone()).unwrap_or_default();
    let local_only = state.settings().privacy.local_only;
    let mut route = crate::route_for(&state, &prompt, &[], false, None);
    // Private content stays on the local model, also when no marker is in the text itself.
    if b.private && !availability::local_required(&route, local_only) {
        route = state.router().private_route("morning briefing with private content");
    }
    let req = ChatRequest {
        model: route.model.clone(),
        messages,
        tools: vec![],
        temperature: Some(0.2),
        max_tokens: Some(400),
    };
    let (completion, _, route) = crate::complete_routed(&app, &state, &request_id, req, route).await?;
    let text = core::clean_summary(&transform::clean_output(&completion.content));
    if text.is_empty() {
        return Err(Error::State(tr!("Die KI hat nichts geschrieben.", "The AI wrote nothing.").into()));
    }
    let s =
        BriefingSummary { date: b.date, text, model: route.model, at: Utc::now(), local: route.tier == Tier::Local };
    if let Ok(json) = serde_json::to_string(&s) {
        state.db().meta_set(core::SUMMARY_KEY, &json)?;
    }
    Ok(s)
}

/// Called once by the UI after the start: on the first start of a briefing day it opens the
/// briefing (`open`) or notifies (`notify`, notification mode without a time); stored per day.
#[tauri::command(async)]
pub fn briefing_start(app: AppHandle, state: State<AppState>) -> Result<StartAction> {
    let today = Local::now().date_naive();
    set_seen(test_seen_day().filter(|_| seen().is_none()).unwrap_or(today));
    start_check(&app, &state, today)
}

/// The first-start check of `today` (see [`briefing_start`]); sends the notification itself.
fn start_check(app: &AppHandle, state: &AppState, today: NaiveDate) -> Result<StartAction> {
    let settings = state.settings();
    if settings.briefing.mode == BriefingMode::Off {
        return Ok(StartAction::None);
    }
    let body = {
        let db = state.db();
        let day = core::is_briefing_day(&db, &settings, today)?;
        let action = core::start_action(&settings.briefing, today, last_day(&db), day);
        if action == StartAction::None {
            return Ok(action);
        }
        db.meta_set(core::DAY_KEY, &today.to_string())?;
        if action == StartAction::Open {
            return Ok(action);
        }
        build(state, &db, &[]).map(|b| core::notify_body(&b)).unwrap_or_default()
    };
    crate::notifyact::show(app, crate::notifyact::Note::briefing(&body));
    Ok(StartAction::Notify)
}

/// The app ran into a new day and the user is there (`present`): the first-start check of the
/// new day, as at a start. The UI opens the briefing or offers it like after its own call.
fn new_day(app: &AppHandle, present: bool) {
    let today = Local::now().date_naive();
    if !core::new_day_check(seen(), today, present) {
        return;
    }
    set_seen(today);
    let state = app.state::<AppState>();
    match start_check(app, &state, today) {
        Ok(StartAction::Open) => {
            let _ = app.emit_to(MAIN, "nav://briefing", ());
        }
        Ok(StartAction::Notify) => {
            let _ = app.emit_to(MAIN, "briefing://notified", ());
        }
        Ok(StartAction::None) => {}
        Err(e) => crate::devlog::warn("briefing", format!("check on a new day: {}", e.detail())),
    }
}

/// Input after a pause (activity sampler): the user is back, maybe on a new day.
pub fn on_activity(app: &AppHandle) {
    new_day(app, true);
}

/// Called with the other reminders (~30 s): the notification at the set time, once a
/// briefing day (Settings → Briefing, notification mode).
pub fn periodic(app: &AppHandle) {
    let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
    new_day(app, focused);
    let state = app.state::<AppState>();
    let settings = state.settings();
    if settings.briefing.mode != BriefingMode::Notify || settings.briefing.notify_time.is_empty() {
        return;
    }
    let now = Local::now().naive_local();
    let body = {
        let db = state.db();
        let day = core::is_briefing_day(&db, &settings, now.date()).unwrap_or(false);
        if !core::notify_due(now, &settings, last_day(&db), day) {
            return;
        }
        let _ = db.meta_set(core::DAY_KEY, &now.date().to_string());
        build(&state, &db, &[]).map(|b| core::notify_body(&b)).unwrap_or_default()
    };
    crate::notifyact::show(app, crate::notifyact::Note::briefing(&body));
    let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
    if focused {
        // In the app already: it offers the briefing itself.
        let _ = app.emit_to(MAIN, "briefing://notified", ());
    } else {
        PENDING.store(true, Ordering::Relaxed);
    }
}

/// „Öffnen“ on (or a click on) the briefing notification. During a first start the briefing
/// opens once the window gets the focus.
pub fn open(app: &AppHandle, ready: bool) {
    crate::desktop::show_main(app);
    if ready {
        PENDING.store(false, Ordering::Relaxed);
        let _ = app.emit_to(MAIN, "nav://briefing", ());
    } else {
        PENDING.store(true, Ordering::Relaxed);
    }
}

/// The main window got the focus: open the briefing after the notification.
pub fn on_focus(app: &AppHandle) {
    new_day(app, true);
    if PENDING.swap(false, Ordering::Relaxed) {
        let _ = app.emit_to(MAIN, "nav://briefing", ());
    }
}
