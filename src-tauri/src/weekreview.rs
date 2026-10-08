//! „Wochenrückblick“ in the shell: the review of a week, its summary and „Als Wochenbericht
//! speichern“. The logic lives in `annalo_core::weekreview`.
//!
//! The summary goes through the router like every request; a week with a private page or a
//! private appointment (or a privacy marker in its data) goes to the local model only.

use annalo_core::ai::availability;
use annalo_core::ai::client::ChatRequest;
use annalo_core::ai::transform;
use annalo_core::calsync::outlook;
use annalo_core::model::Page;
use annalo_core::weekreview::{self as core, WeekReview};
use annalo_core::{Database, Error, tr};
use chrono::{Local, NaiveDate, Utc};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{AppState, ChatOutcome, Result, complete_routed, cost_warning, prefs, route_for};

fn review(state: &AppState, db: &Database, date: NaiveDate) -> Result<WeekReview> {
    let settings = state.settings();
    // Meetings: the booking calendars (not those shared by colleagues unless chosen).
    let sources = settings.calendar.booking_sources(outlook::available());
    let r = core::week_review(db, date, &Local, &settings, Some(sources), Utc::now())?;
    // Time tracking off: no time part or booking states (also in the summary and the report).
    Ok(if settings.time_tracking() { r } else { r.without_time() })
}

/// The review of the week of `date` (default this week).
#[tauri::command(async)]
pub fn week_review(state: State<AppState>, date: Option<NaiveDate>) -> Result<WeekReview> {
    let date = date.unwrap_or_else(|| Local::now().date_naive());
    review(&state, &state.reader(), date)
}

/// Streams a short summary of the week of `date` (`ai://stream` events for `request_id`)
/// through the router; private content stays on the local model.
#[tauri::command]
pub async fn week_review_summary(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    date: NaiveDate,
    override_limit: Option<bool>,
) -> Result<ChatOutcome> {
    if !crate::briefing::ai_ready(&state) {
        return Err(Error::State(
            tr!(
                "Keine KI verbunden: Richte unter Einstellungen → KI & Modelle einen Anbieter ein.",
                "No AI connected: set up a provider under Settings → AI & models."
            )
            .into(),
        ));
    }
    prefs::check_cost_limit(&state, override_limit.unwrap_or(false))?;
    let settings = state.settings();
    let (messages, private) = {
        let db = state.reader();
        let r = review(&state, &db, date)?;
        let private = core::is_private(&db, &r, &settings.router.private_markers, &Local)?;
        (core::summary_messages(&r, &Local), private)
    };
    let prompt = messages.last().and_then(|m| m.content.clone()).unwrap_or_default();
    let mut route = route_for(&state, &prompt, &[], false, None);
    if private && !availability::local_required(&route, settings.privacy.local_only) {
        route = state.router().private_route("weekly review with private content");
    }
    let req = ChatRequest {
        model: route.model.clone(),
        messages,
        tools: vec![],
        temperature: Some(0.3),
        max_tokens: settings.ai.max_tokens,
    };
    let (mut completion, meter, route) = complete_routed(&app, &state, &request_id, req, route).await?;
    completion.content = transform::clean_output(&completion.content);
    Ok(ChatOutcome { completion, route, context: vec![], meter, cost_warning: cost_warning(&state), private })
}

#[derive(Debug, Serialize)]
pub struct SavedReport {
    pub page: Page,
    pub created: bool,
}

/// „Als Wochenbericht speichern“: writes the report of the week of `date` (with the summary
/// the view shows, if any). The week's report again gets only its generated part replaced.
#[tauri::command(async)]
pub fn week_report_save(state: State<AppState>, date: NaiveDate, summary: Option<String>) -> Result<SavedReport> {
    let body = {
        let db = state.reader();
        let r = review(&state, &db, date)?;
        core::report_markdown(&r, &Local, summary.as_deref())
    };
    let (page, created) = state.db().week_report_write(date, &body, Local::now().time())?;
    Ok(SavedReport { page, created })
}

/// The template „Wochenbericht“ in „Vorlagen“, created with the default content when missing.
#[tauri::command(async)]
pub fn week_report_template(state: State<AppState>) -> Result<Page> {
    state.db().week_report_template_ensure()
}
