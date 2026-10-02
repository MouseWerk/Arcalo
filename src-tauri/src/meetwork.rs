//! Smart meeting work in the shell: „Besprechung vorbereiten“ (also by itself before a
//! meeting, Settings → Briefing), „Statusbericht“ and „Nachfass-Mail“ with the Outlook draft.
//! The logic lives in `annalo_core::meetwork`.
//!
//! The AI paragraphs go through the router like every request; content with a privacy marker,
//! a private appointment or a private page is routed to the local model. A failed AI request
//! never stops the page or the mail: they are written without the paragraph.

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

use annalo_core::ai::availability;
use annalo_core::ai::client::{ChatMessage, ChatRequest};
use annalo_core::ai::router::Tier;
use annalo_core::ai::transform;
use annalo_core::calsync::tz::Zone;
use annalo_core::calsync::{CalendarEvent, outlook as calendar_outlook};
use annalo_core::mail::outlook as mail_outlook;
use annalo_core::meetwork::followup::{self, FollowUp, FollowUpView};
use annalo_core::meetwork::status::{self, LastReport, ReportRequest, ReportTemplate, ScopeChoices};
use annalo_core::meetwork::{block, prep};
use annalo_core::model::Page;
use annalo_core::{Error, tr};
use chrono::{Duration, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::desktop::MAIN;
use crate::{AppState, Result, prefs};

fn join(e: tauri::Error) -> Error {
    Error::State(e.to_string())
}

/// What a request for an AI paragraph gave.
#[derive(Debug, Default, Serialize)]
pub struct AiOutcome {
    /// The paragraph, when one was written.
    pub text: Option<String>,
    /// Why there is none although it was asked for (no provider, an error).
    pub error: Option<String>,
    /// Written by the local model.
    pub local: bool,
}

/// One short AI paragraph; private content stays on the local model. Errors are returned as
/// the outcome's `error`, never as a failure of the whole command; without any AI provider
/// nothing is asked and there is no error (the page is complete without the paragraph).
async fn ask(
    app: &AppHandle,
    state: &AppState,
    request_id: &str,
    messages: Vec<ChatMessage>,
    private: bool,
    max_tokens: u32,
    why: &str,
) -> AiOutcome {
    if !crate::briefing::ai_ready(state) {
        return AiOutcome::default();
    }
    if let Err(e) = prefs::check_cost_limit(state, false) {
        return AiOutcome { error: Some(e.to_string()), ..Default::default() };
    }
    let prompt = messages.last().and_then(|m| m.content.clone()).unwrap_or_default();
    let local_only = state.settings().privacy.local_only;
    let mut route = crate::route_for(state, &prompt, &[], false, None);
    if private && !availability::local_required(&route, local_only) {
        route = state.router().private_route(why);
    }
    let req = ChatRequest {
        model: route.model.clone(),
        messages,
        tools: vec![],
        temperature: Some(0.2),
        max_tokens: Some(max_tokens),
    };
    match crate::complete_routed(app, state, request_id, req, route).await {
        Ok((completion, _, route)) => {
            let text = transform::clean_output(&completion.content);
            if text.trim().is_empty() {
                AiOutcome {
                    error: Some(tr!("Die KI hat nichts geschrieben.", "The AI wrote nothing.").into()),
                    ..Default::default()
                }
            } else {
                AiOutcome { text: Some(text), error: None, local: route.tier == Tier::Local }
            }
        }
        Err(e) => AiOutcome { error: Some(e.to_string()), ..Default::default() },
    }
}

// ------------------------------------------------------------------ prep

/// The user's own names: the Jira accounts (left out of the attendees' notes).
fn me(state: &AppState) -> Vec<String> {
    state
        .reader()
        .issue_sync_status()
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.account)
        .filter(|a| !a.is_empty())
        .collect()
}

/// The appointments of the last 120 days before `e` (the last meetings with each attendee).
fn history(state: &AppState, e: &CalendarEvent) -> Result<Vec<CalendarEvent>> {
    let sources = state.settings().calendar.active_sources(calendar_outlook::available());
    state.reader().calendar_events(e.event.start - Duration::days(120), e.event.start, &sources)
}

#[derive(Debug, Serialize)]
pub struct PrepOutcome {
    pub page: Page,
    pub created: bool,
    pub ai: AiOutcome,
}

/// Writes (or refreshes) the prep page of `key`; with `ai` also „Worauf achten“.
async fn prepare(app: &AppHandle, state: &AppState, request_id: &str, key: &str, ai: bool) -> Result<PrepOutcome> {
    // One reader at a time: the reader is a lock.
    let e = state.reader().calendar_event(key)?;
    let (past, mine) = (history(state, &e)?, me(state));
    let data = prep::prep_data(&state.reader(), &e, &past, &state.settings(), &mine)?;
    let event = e;
    let outcome = if ai {
        let messages = prep::ai_messages(&data, &Zone::Local);
        let mut o = ask(app, state, request_id, messages, data.private, 300, "meeting prep with private content").await;
        o.text = o.text.map(|t| prep::clean_ai(&t));
        o
    } else {
        AiOutcome::default()
    };
    let body = prep::markdown(&data, outcome.text.as_deref(), &Zone::Local, Local::now().naive_local());
    let (page, created) = state.db().meeting_prep_write(&event, &body, &Zone::Local)?;
    Ok(PrepOutcome { page, created, ai: outcome })
}

/// „Besprechung vorbereiten“: the prep page of an appointment, written or refreshed in place.
/// Streams `ai://stream` events for `request_id` while „Worauf achten“ is written.
#[tauri::command]
pub async fn meeting_prep(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    key: String,
    ai: Option<bool>,
) -> Result<PrepOutcome> {
    prepare(&app, &state, &request_id, &key, ai.unwrap_or(true)).await
}

/// The prep page of an appointment, if there is one.
#[tauri::command(async)]
pub fn meeting_prep_page(state: State<AppState>, key: String) -> Result<Option<i64>> {
    state.reader().meeting_prep_page_id(&key)
}

/// The appointment of a prep page (its „Aktualisieren“).
#[tauri::command(async)]
pub fn meeting_prep_key(state: State<AppState>, page_id: i64) -> Result<Option<String>> {
    state.reader().meeting_prep_key(page_id)
}

/// Appointments prepared by themselves in this run (one try each).
static TRIED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Called with the other reminders (~30 s): prepares the meetings that start within the set
/// minutes (Settings → Briefing, off by default) once, from the booking calendars, while the
/// app is not locked. No AI: the page is there when the meeting comes.
pub fn periodic(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    if !settings.briefing.prep_auto || crate::security::is_locked() {
        return;
    }
    let now = Utc::now();
    let minutes = i64::from(settings.briefing.prep_minutes);
    let sources = settings.calendar.booking_sources(calendar_outlook::available());
    let candidates: Vec<CalendarEvent> = {
        let db = state.reader();
        let Ok(list) = db.calendar_events(now, now + Duration::minutes(minutes + 1), &sources) else { return };
        list.into_iter()
            .filter(|e| prep::auto_candidate(e, now, minutes))
            .filter(|e| {
                db.meta_get(&format!("{}{}", prep::AUTO_KEY, e.key)).ok().flatten().is_none()
                    && db.meeting_prep_page_id(&e.key).ok().flatten().is_none()
            })
            .collect()
    };
    for e in candidates {
        {
            let mut tried = TRIED.lock().unwrap_or_else(|p| p.into_inner());
            if !tried.get_or_insert_with(HashSet::new).insert(e.key.clone()) {
                continue;
            }
        }
        let _ = state.db().meta_set(&format!("{}{}", prep::AUTO_KEY, e.key), "1");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<AppState>();
            match prepare(&app, &state, "", &e.key, false).await {
                Ok(p) => {
                    let _ = app.emit_to(MAIN, "prep://created", serde_json::json!({ "key": e.key, "page": p.page }));
                }
                Err(err) => crate::devlog::warn("meetwork", format!("auto prep: {}", err.detail())),
            }
        });
    }
}

// ------------------------------------------------------------------ status report

#[tauri::command(async)]
pub fn status_scopes(state: State<AppState>) -> Result<ScopeChoices> {
    status::scope_choices(&state.reader(), &state.settings())
}

#[tauri::command(async)]
pub fn status_templates(state: State<AppState>) -> Result<Vec<ReportTemplate>> {
    state.reader().status_templates()
}

#[tauri::command(async)]
pub fn status_template_save(state: State<AppState>, template: ReportTemplate) -> Result<Vec<ReportTemplate>> {
    state.db().status_template_save(template)
}

#[tauri::command(async)]
pub fn status_template_delete(state: State<AppState>, id: String) -> Result<Vec<ReportTemplate>> {
    state.db().status_template_delete(&id)
}

/// The last report (start page widget), while its page exists.
#[tauri::command(async)]
pub fn status_last(state: State<AppState>) -> Result<Option<LastReport>> {
    state.reader().status_last()
}

#[derive(Debug, Serialize)]
pub struct StatusOutcome {
    pub page: Page,
    pub created: bool,
    pub ai: AiOutcome,
}

/// „Statusbericht“: writes (or refreshes) the report page of a scope and period.
#[tauri::command]
pub async fn status_report(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    request: ReportRequest,
) -> Result<StatusOutcome> {
    let settings = state.settings();
    let report = status::build(&state.reader(), &request, &settings, Local::now().date_naive(), &Local)?;
    let wants_summary = request.sections.is_empty() || request.sections.iter().any(|s| s == "summary");
    let outcome = if request.ai && wants_summary {
        let mut o = ask(
            &app,
            &state,
            &request_id,
            status::ai_messages(&report),
            report.private,
            400,
            "status report with private content",
        )
        .await;
        o.text = o.text.map(|t| status::clean_ai(&t));
        o
    } else {
        AiOutcome::default()
    };
    let generated = Local::now().format(tr!("%d.%m.%Y %H:%M", "%Y-%m-%d %H:%M")).to_string();
    let body = status::markdown(&report, &request.sections, outcome.text.as_deref(), &generated);
    let (page, created) = state.db().status_write(&request, &report, &body, Utc::now())?;
    Ok(StatusOutcome { page, created, ai: outcome })
}

/// „Als Markdown exportieren“: the page without the markers of its generated part.
#[tauri::command(async)]
pub fn page_markdown_write(state: State<AppState>, page_id: i64, path: String) -> Result<()> {
    let path = path.trim();
    if !path.to_lowercase().ends_with(".md") {
        return Err(Error::State(tr!("Bitte eine .md-Datei wählen", "Please choose a .md file").into()));
    }
    let doc = state.reader().page_doc(page_id)?;
    // The file carries the page title as its heading.
    let body = block::strip_markers(&doc.content);
    let text = if body.trim_start().starts_with("# ") { body } else { format!("# {}\n\n{body}", doc.page.title) };
    std::fs::write(PathBuf::from(path), text)?;
    Ok(())
}

/// A page as plain Markdown (without the markers): „Als Text kopieren“, the `mailto:` text.
#[tauri::command(async)]
pub fn page_markdown_text(state: State<AppState>, page_id: i64) -> Result<String> {
    Ok(block::strip_markers(&state.reader().page_doc(page_id)?.content))
}

// ------------------------------------------------------------------ mail

/// Whether a draft can be made in Outlook here (Windows, Outlook Classic; or the test fixture).
#[tauri::command]
pub fn mail_draft_available() -> bool {
    mail_outlook::available()
}

/// A new mail in Outlook: shown, never sent.
#[tauri::command]
pub async fn mail_draft(state: State<'_, AppState>, to: Vec<String>, subject: String, html: String) -> Result<()> {
    if !mail_outlook::available() {
        return Err(Error::State(
            tr!(
                "Outlook (klassisch) ist hier nicht verfügbar. Stattdessen das E-Mail-Programm öffnen oder den Text kopieren.",
                "Outlook (classic) is not available here. Open the mail program instead or copy the text."
            )
            .into(),
        ));
    }
    let dir = state.data_dir.join("scripts");
    tauri::async_runtime::spawn_blocking(move || mail_outlook::draft(&dir, &to, &subject, &html)).await.map_err(join)?
}

/// The attendees of the appointment a meeting note belongs to, its subject and day.
fn note_meeting(state: &AppState, page_id: i64) -> Result<(String, Option<chrono::NaiveDate>, Vec<String>, bool)> {
    let db = state.reader();
    let page = db.page(page_id)?;
    let key: Option<String> = db
        .conn()
        .query_row("SELECT key FROM calendar_marks WHERE note_page_id = ?1 ORDER BY key LIMIT 1", [page_id], |r| {
            r.get(0)
        })
        .ok();
    if let Some(e) = key.and_then(|k| db.calendar_event(&k).ok()) {
        let day = Zone::Local.to_wall(e.event.start).date();
        return Ok((e.event.title.clone(), Some(day), e.event.attendees.clone(), e.event.private));
    }
    // Not linked: the title without its date, the attendees listed in the note.
    let doc = db.page_doc(page_id)?;
    let (_, body) = followup::split_front_matter(&doc.content);
    let to: Vec<String> = annalo_core::meetwork::items_under(body, &["teilnehmer", "attendees", "participants"])
        .into_iter()
        .map(|a| followup::plain(&a))
        .filter(|a| !a.is_empty())
        .collect();
    let day = db
        .conn()
        .query_row("SELECT file_date FROM pages WHERE id = ?1", [page_id], |r| r.get::<_, Option<String>>(0))
        .ok()
        .flatten()
        .and_then(|d| chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok());
    Ok((annalo_core::filing::series_name(&page.title), day, to, false))
}

/// „Nachfass-Mail“: the mail of a meeting note, built without AI.
#[tauri::command(async)]
pub fn followup_build(state: State<AppState>, page_id: i64) -> Result<FollowUpView> {
    Ok(followup::view(build_followup(&state, page_id)?, mail_outlook::available()))
}

/// The user's own addresses and names, left out of a follow-up mail's recipients: Settings →
/// E-Mail „Eigene Adressen“, the Jira accounts and the Git sync's author (Outlook's signed-in
/// account is left out by the draft itself).
fn own_identities(state: &AppState) -> Vec<String> {
    let settings = state.settings();
    let mut own = settings.mail.own_addresses.clone();
    own.extend(me(state));
    own.push(settings.git_sync.author_email.clone());
    own.retain(|o| !o.trim().is_empty());
    own
}

fn build_followup(state: &AppState, page_id: i64) -> Result<FollowUp> {
    let (meeting, date, to, private_event) = note_meeting(state, page_id)?;
    let doc = state.reader().page_doc(page_id)?;
    let ui = if annalo_core::i18n::is_en() { "en" } else { "de" };
    let to = followup::without_own(to, &own_identities(state));
    let mut f = followup::extract(page_id, &doc.content, &meeting, date, to, ui, Local::now().date_naive());
    let markers = annalo_core::ai::privacy::normalize(&state.settings().router.private_markers);
    let tags = annalo_core::ai::privacy::tag_text(&doc.tags);
    f.private = private_event || annalo_core::ai::privacy::any_private([doc.content.as_str(), tags.as_str()], &markers);
    Ok(f)
}

/// „Mit KI formulieren“: the same mail with an opening paragraph written by the AI.
#[tauri::command]
pub async fn followup_polish(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    page_id: i64,
) -> Result<FollowUpView> {
    let mut f = build_followup(&state, page_id)?;
    let o = ask(
        &app,
        &state,
        &request_id,
        followup::polish_messages(&f),
        f.private,
        300,
        "follow-up mail with private content",
    )
    .await;
    match o.text {
        Some(t) => {
            f.intro = followup::clean_intro(&t);
            f.polished = true;
        }
        None => {
            return Err(Error::State(o.error.unwrap_or_else(|| {
                tr!("Keine KI verbunden (Einstellungen → KI).", "No AI connected (Settings → AI).").into()
            })));
        }
    }
    Ok(followup::view(f, mail_outlook::available()))
}
