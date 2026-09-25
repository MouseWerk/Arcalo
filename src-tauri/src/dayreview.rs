//! „Tagesrückblick“ in the shell: the review of a day, its summary by a local model and the
//! reminder at the end of the day. The logic lives in `annalo_core::dayreview`.
//!
//! The summary is written only by providers marked local: the review aggregates every page of
//! the day (private ones included), so it is treated as private as a whole. It does not go
//! through the router; a local model that cannot be reached is replaced by another local one,
//! never by a cloud provider.

use std::sync::atomic::{AtomicBool, Ordering};

use annalo_core::ai::client::ChatRequest;
use annalo_core::ai::router::{RouteDecision, Tier};
use annalo_core::ai::{availability, transform};
use annalo_core::calsync::outlook;
use annalo_core::dayreview::{self as core, DayReview, ReviewOptions};
use annalo_core::{Database, Error};
use chrono::{Local, NaiveDate, Utc};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::desktop::{MAIN, notify};
use crate::{AppState, ChatOutcome, Result, catalog, cost_warning, devlog, stream_completion};

/// The reminder was shown while the app was in the background: the next focus of the main
/// window opens the review.
static PENDING: AtomicBool = AtomicBool::new(false);

/// Meta row with the day of the last reminder.
const REMINDED: &str = "day_review.day";

fn review(state: &AppState, db: &Database, date: NaiveDate) -> Result<DayReview> {
    let settings = state.settings();
    let sources = settings.calendar.active_sources(outlook::available());
    core::day_review(db, date, &Local, &ReviewOptions::from_settings(&settings, Some(sources), Utc::now()))
}

/// The review of the local day `date` (default today).
#[tauri::command(async)]
pub fn day_review(state: State<AppState>, date: Option<NaiveDate>) -> Result<DayReview> {
    let date = date.unwrap_or_else(|| Local::now().date_naive());
    review(&state, &state.reader(), date)
}

/// Streams a short summary of `date` (`ai://stream` events for `request_id`), written by a
/// model of a provider marked local. Refused without one.
#[tauri::command]
pub async fn day_review_summary(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    date: NaiveDate,
) -> Result<ChatOutcome> {
    let settings = state.settings();
    let catalog = catalog(&state).await;
    if let Some(why) = core::no_local_reason(&catalog) {
        return Err(Error::State(why));
    }
    let candidates = core::local_candidates(&settings.router, &catalog);
    if candidates.is_empty() {
        return Err(Error::State(
            "Der lokale KI-Anbieter bietet kein Chat-Modell an: lade unter Einstellungen → KI ein Modell herunter \
             oder wähle es für die Stufe Lokal."
                .into(),
        ));
    }
    let messages = {
        let r = review(&state, &state.reader(), date)?;
        core::summary_messages(&r, &Local)
    };
    let mut last: Option<Error> = None;
    for (i, m) in candidates.iter().enumerate() {
        let Ok(client) = state.client_for(&m.provider) else { continue };
        // Only a provider marked local, checked once more on the client itself.
        if !client.provider().local {
            continue;
        }
        let req = ChatRequest {
            model: m.model.clone(),
            messages: messages.clone(),
            tools: vec![],
            temperature: Some(0.3),
            max_tokens: settings.ai.max_tokens,
        };
        match stream_completion(&app, &state, &client, &request_id, &req).await {
            Ok((mut completion, meter)) => {
                completion.content = transform::clean_output(&completion.content);
                let mut reasons = vec!["Tagesrückblick: nur lokale Modelle".to_owned()];
                if i > 0 {
                    reasons.push(format!("{} statt {}", m.model, candidates[0].model));
                }
                let route = RouteDecision {
                    tier: Tier::Local,
                    provider: m.provider.clone(),
                    model: m.model.clone(),
                    score: 0,
                    reasons,
                };
                return Ok(ChatOutcome {
                    completion,
                    route,
                    context: vec![],
                    meter,
                    cost_warning: cost_warning(&state),
                });
            }
            Err(e) => {
                let next = availability::unreachable(&e)
                    || matches!(&e, Error::Provider { status, body } if availability::model_unavailable(*status, body));
                if !next {
                    return Err(e);
                }
                devlog::warn("ai", format!("day review: „{}“ ({}) failed: {e}", m.model, m.provider));
                last = Some(e);
            }
        }
    }
    Err(match last {
        Some(e) => {
            Error::State(format!("Kein lokales Modell hat geantwortet. Die Zusammenfassung bleibt lokal. ({e})"))
        }
        None => Error::State("Kein lokales Modell verfügbar (Einstellungen → KI).".into()),
    })
}

/// Called with the other reminders (~30 s): „Tagesrückblick ansehen“ once a workday at the set
/// time (Settings → Benachrichtigungen, off by default).
pub fn periodic(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.notifications.day_review {
        return;
    }
    let now = Local::now().naive_local();
    let body = {
        let db = state.db();
        let last = db.meta_get(REMINDED).ok().flatten().and_then(|s| s.parse::<NaiveDate>().ok());
        if !core::review_reminder(now, &settings, last) {
            return;
        }
        let _ = db.meta_set(REMINDED, &now.date().to_string());
        review(&state, &db, now.date()).map(|r| core::reminder_body(&r)).unwrap_or_default()
    };
    notify(app, "Tagesrückblick ansehen", &body);
    let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
    if !focused {
        PENDING.store(true, Ordering::Relaxed);
    }
}

/// The main window got the focus: open the review after a reminder.
pub fn on_focus(app: &AppHandle) {
    if PENDING.swap(false, Ordering::Relaxed) {
        let _ = app.emit_to(MAIN, "nav://day-review", ());
    }
}
