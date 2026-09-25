//! „E-Mail als Aufgabe / Notiz“: reads mails (Outlook Classic, dropped `.eml`/`.msg` files,
//! pasted header blocks), takes them over as task and/or note and opens a linked mail again.
//! The logic lives in `annalo_core::mail`.
//!
//! Outlook's script and file work run in `spawn_blocking` without the database lock; the
//! database is taken for the one transaction that creates link, note and task. Mail bodies
//! never go to the assistant; „Aufgabe vorschlagen“ only asks a provider marked local.

use std::path::{Path, PathBuf};
use std::time::Duration;

use annalo_core::Error;
use annalo_core::ai::client::{ChatMessage, ChatRequest};
use annalo_core::ai::router::{RouteDecision, Tier};
use annalo_core::attachments;
use annalo_core::calsync::tz::Zone;
use annalo_core::mail::{self, Mail, MailCreated, MailImport, MailLink, MailSource, StoredFiles, Suggestion, outlook};
use chrono::{Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result, devlog, feed, prefs};

fn join(e: tauri::Error) -> Error {
    Error::State(e.to_string())
}

fn scripts(state: &AppState) -> PathBuf {
    state.data_dir.join("scripts")
}

fn temp_root(state: &AppState) -> PathBuf {
    state.data_dir.join(mail::TEMP_DIR)
}

#[derive(Serialize)]
pub struct MailStatus {
    /// „Aktuelle E-Mail übernehmen“ works here (Windows, or the test fixture).
    outlook_available: bool,
    /// Model and provider of the local tier when that provider is marked local; `None` hides
    /// „Aufgabe vorschlagen“.
    local_ai: Option<String>,
}

/// The local tier's model, when its provider is marked local (nothing else may read a mail).
fn local_model(state: &AppState) -> Option<(String, String, String)> {
    let settings = state.settings();
    let r = settings.router.tier_ref(Tier::Local);
    let p = settings.providers.iter().find(|p| p.id == r.provider && p.enabled && p.local)?;
    (!r.model.is_empty()).then(|| (p.id.clone(), p.name.clone(), r.model.clone()))
}

#[tauri::command(async)]
pub fn mail_status(state: State<AppState>) -> MailStatus {
    MailStatus {
        outlook_available: outlook::available(),
        local_ai: local_model(&state).map(|(_, name, model)| format!("{model} ({name})")),
    }
}

/// The mails selected or open in Outlook.
#[tauri::command]
pub async fn mail_outlook_current(app: AppHandle) -> Result<Vec<Mail>> {
    let dir = scripts(&app.state::<AppState>());
    let mails = tauri::async_runtime::spawn_blocking(move || outlook::read(&dir)).await.map_err(join)?;
    if let Err(e) = &mails {
        devlog::warn("mail", format!("Outlook: {e}"));
    }
    mails
}

/// Header with the percent-encoded file name of [`mail_parse_file`] (header values are ASCII).
const NAME_HEADER: &str = "x-annalo-name";

/// Reads a dropped `.eml`/`.msg` (raw bytes as the body, the name in [`NAME_HEADER`]) and keeps
/// the file and its attachments in the temp folder until the mail is taken over.
#[tauri::command]
pub async fn mail_parse_file(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<Mail> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::State("Dateiinhalt fehlt".into()));
    };
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(attachments::percent_decode)
        .ok_or_else(|| Error::State("Dateiname fehlt".into()))?;
    let bytes = bytes.clone();
    let root = temp_root(&app.state::<AppState>());
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = mail::parse_file(&name, &bytes)?;
        mail::stage(&root, &name, &bytes, parsed)
    })
    .await
    .map_err(join)?
}

/// A pasted header block (`Von:`/`From:` …) as a mail; `None` when the text has none.
#[tauri::command(async)]
pub fn mail_parse_text(text: String) -> Option<Mail> {
    mail::paste::parse(&text, &Zone::Local)
}

/// Copies a file into the attachments folder (off the runtime).
fn import(state: &AppState, path: &Path) -> Result<String> {
    let saved = attachments::import_file(&state.attachments_dir(), path)?;
    feed::file_added(state, &saved.name);
    Ok(saved.name)
}

/// The original file and the chosen attachments, stored as attachments (blocking).
fn store_files(app: &AppHandle, req: &MailImport) -> Result<StoredFiles> {
    let state = app.state::<AppState>();
    let m = &req.mail;
    let mut files = StoredFiles::default();
    let root = temp_root(&state);
    match m.source {
        MailSource::Eml | MailSource::Msg => {
            if !m.file.is_empty() {
                let path = mail::temp_file(&root, &m.file).ok_or_else(|| {
                    Error::State("Die E-Mail-Datei ist nicht mehr da; bitte erneut hineinziehen".into())
                })?;
                files.original = Some(import(&state, &path)?);
            }
            for a in m.attachments.iter().filter(|a| req.attachments.contains(&a.index)) {
                let path = mail::temp_file(&root, &a.file)
                    .ok_or_else(|| Error::State(format!("Der Anhang „{}“ ist nicht mehr da", a.name)))?;
                files.attachments.push(import(&state, &path)?);
            }
        }
        MailSource::Outlook if !req.attachments.is_empty() => {
            let dir = root.join(format!("outlook-{}", Utc::now().timestamp_millis()));
            let saved = outlook::save_attachments(&scripts(&state), m, &req.attachments, &dir);
            let result = saved.and_then(|list| {
                let mut out = vec![];
                // In the order of the mail, whatever order the script wrote them in.
                for index in &req.attachments {
                    if let Some((_, path)) = list.iter().find(|(i, _)| i == index) {
                        out.push(import(&state, path)?);
                    }
                }
                Ok(out)
            });
            let _ = std::fs::remove_dir_all(&dir);
            files.attachments = result?;
        }
        _ => {}
    }
    Ok(files)
}

/// Takes a mail over as task and/or note (attachments are copied first, without the lock).
#[tauri::command]
pub async fn mail_import(app: AppHandle, request: MailImport) -> Result<MailCreated> {
    let files = {
        let app = app.clone();
        let req = request.clone();
        tauri::async_runtime::spawn_blocking(move || store_files(&app, &req)).await.map_err(join)??
    };
    let state = app.state::<AppState>();
    let settings = state.settings();
    let marker = annalo_core::ai::privacy::normalize(&settings.router.private_markers).into_iter().next();
    let out = state.db().mail_create(&request, &files, &settings.mail, marker.as_deref(), &Zone::Local, Utc::now())?;
    let pages: Vec<i64> = [&out.task_page, &out.note_page].into_iter().flatten().map(|p| p.id).collect();
    let _ = app.emit("data://pages", &pages);
    // The staged file is not needed any more once stored.
    if let Some(dir) = request.mail.file.split('/').next()
        && dir.len() == 16
        && dir.bytes().all(|b| b.is_ascii_hexdigit())
    {
        let _ = std::fs::remove_dir_all(temp_root(&state).join(dir));
    }
    Ok(out)
}

/// What a link points to (the chip's tooltip).
#[tauri::command(async)]
pub fn mail_link_info(state: State<AppState>, id: String) -> Result<MailLink> {
    state.reader().mail_link(&id)
}

/// Opens a linked mail: in Outlook (EntryID/StoreID) or the stored `.eml`/`.msg` in its app.
#[tauri::command]
pub async fn mail_open(app: AppHandle, id: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let state = app.state::<AppState>();
    let link = state.reader().mail_link(&id)?;
    match link.source {
        MailSource::Outlook => {
            if !outlook::available() {
                return Err(Error::State(
                    "Diese E-Mail liegt in Outlook (klassisch) unter Windows und lässt sich nur dort öffnen.".into(),
                ));
            }
            let dir = scripts(&state);
            tauri::async_runtime::spawn_blocking(move || outlook::open(&dir, &link.entry_id, &link.store_id))
                .await
                .map_err(join)?
        }
        MailSource::Eml | MailSource::Msg => {
            let path = attachments::existing(&state.attachments_dir(), &link.file)?;
            app.opener()
                .open_path(path.display().to_string(), None::<&str>)
                .map_err(|e| Error::State(format!("„{}“ ließ sich nicht öffnen: {e}", link.file)))
        }
        MailSource::Text => Err(Error::State("Zu dieser E-Mail ist nichts gespeichert, das sich öffnen ließe".into())),
    }
}

/// „Aufgabe vorschlagen“: the task and a due date from the mail, by the local model only.
#[tauri::command]
pub async fn mail_suggest(app: AppHandle, request_id: String, mail: Mail) -> Result<Suggestion> {
    let state = app.state::<AppState>();
    let (provider, _, model) = local_model(&state).ok_or_else(|| {
        Error::State(
            "Kein lokales KI-Modell eingerichtet. Unter Einstellungen → KI einen Anbieter als „lokal“ markieren und ihn für \
             die Stufe „Lokal“ wählen; E-Mails gehen nie an andere Anbieter."
                .into(),
        )
    })?;
    prefs::check_cost_limit(&state, false)?;
    let (system, user) = mail::suggestion_messages(&mail, Local::now().date_naive());
    let req = ChatRequest {
        model: model.clone(),
        messages: vec![ChatMessage::system(system), ChatMessage::user(user)],
        tools: vec![],
        temperature: Some(0.1),
        max_tokens: Some(200),
    };
    // A private route: the availability check keeps it on the local tier or providers marked local.
    let route = RouteDecision {
        tier: Tier::Local,
        provider,
        model,
        score: 0,
        reasons: vec!["private marker found: e-mail text stays on the local model".into()],
    };
    let (completion, _, route) =
        tokio::time::timeout(Duration::from_secs(120), crate::complete_routed(&app, &state, &request_id, req, route))
            .await
            .map_err(|_| Error::State("Das lokale Modell hat nicht innerhalb von 2 Minuten geantwortet".into()))??;
    let settings = state.settings();
    if !settings.providers.iter().any(|p| p.id == route.provider && p.local) {
        return Err(Error::State("Kein lokales Modell verfügbar".into()));
    }
    mail::parse_suggestion(&completion.content)
        .ok_or_else(|| Error::State("Das lokale Modell hat keine Aufgabe genannt".into()))
}

/// Removes staged mails older than a day (read, never taken over).
pub fn clean_temp(app: &AppHandle) {
    let root = temp_root(&app.state::<AppState>());
    tauri::async_runtime::spawn_blocking(move || mail::clean_temp(&root, Duration::from_secs(24 * 3600)));
}

/// The global shortcut: brings the main window up and reads the current mail there.
pub fn on_shortcut(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(crate::desktop::MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit("mail://capture", ());
}
