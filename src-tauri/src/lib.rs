//! Annalo desktop shell: exposes `annalo-core` to the web UI over Tauri IPC.

// Built on every platform (so Linux/Windows CI type-checks it); installed on macOS only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod appmenu;
mod desktop;
mod devlog;
mod jumplist;
mod network;
mod prefs;
mod secrets;
mod updates;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use annalo_core::activity::{self, IdleAccumulator, WindowUsage};
use annalo_core::ai::LiteLlmClient;
use annalo_core::ai::client::{ChatMessage, ChatRequest, Completion, StreamEvent};
use annalo_core::ai::metrics::SessionMeter;
use annalo_core::ai::rag::{self, ContextChunk};
use annalo_core::ai::router::{ModelRouter, RouteDecision, RouteInput, RouterConfig, Tier};
use annalo_core::ai::tools::{self, Risk, SystemCall};
use annalo_core::ai::transform;
use annalo_core::ai::zeitguess::{self, ZeitGuess};
use annalo_core::attachments::{self, SavedAttachment};
use annalo_core::backup::{self, BackupInfo};
use annalo_core::calendar::{self, DayOverview};
use annalo_core::db::EntryFilter;
use annalo_core::export::{self, ExportFormat, ExportOptions, ExportResult};
use annalo_core::gitsync::{self, GitSyncStatus, SyncMode, SyncOutcome, SyncRequest};
use annalo_core::mirror::{self, MirrorReport};
use annalo_core::model::*;
use annalo_core::network::Purpose;
use annalo_core::netzplan::{self, Schedule};
use annalo_core::notes::PageDoc;
use annalo_core::pagework::{self, PageWork};
use annalo_core::report;
use annalo_core::search::{self, SearchHit};
use annalo_core::settings::{Dashboard, Settings};
use annalo_core::tasks::{Task, TaskFilter};
use annalo_core::templates::TemplateVars;
use annalo_core::tracking::{self, BudgetStatus, LogOutcome};
use annalo_core::trash::TrashEntry;
use annalo_core::vault::{self, ImportReport};
use annalo_core::versions::VersionInfo;
use annalo_core::{Database, Error, datadir, demo};
use base64::Engine;
use chrono::{DateTime, Local, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::ShortcutState;

use secrets::SecretStore;

type Result<T> = std::result::Result<T, Error>;

// -------------------------------------------------------------------- state

/// AI configuration derived from the settings; rebuilt when they change (also the network
/// settings: proxy, extra CA and timeouts apply to both HTTP clients).
struct AiRuntime {
    settings: Settings,
    client: Arc<LiteLlmClient>,
    router: Arc<ModelRouter>,
    /// Client of the assistant's `http_request` tool.
    tools_http: tools::HttpClient,
}

impl AiRuntime {
    fn new(settings: Settings, api_key: Option<String>, proxy_password: Option<String>) -> Self {
        devlog::remember_secret(api_key.as_deref());
        devlog::remember_secret(proxy_password.as_deref());
        let http = |purpose| {
            annalo_core::network::http_client(&settings.network, proxy_password.as_deref(), purpose).unwrap_or_else(
                |e| {
                    devlog::warn("net", format!("network settings not applied: {e}"));
                    tools::HttpClient::new()
                },
            )
        };
        let client = LiteLlmClient::with_http(settings.litellm_base_url.clone(), api_key, http(Purpose::Ai));
        AiRuntime {
            client: Arc::new(client),
            router: Arc::new(ModelRouter::new(settings.router.clone())),
            tools_http: http(Purpose::Tools),
            settings,
        }
    }
}

/// Rebuilds the AI runtime (clients, router) from `settings` and the stored secrets.
pub(crate) fn rebuild_ai(state: &AppState, settings: Settings) {
    let rt = AiRuntime::new(settings, state.secrets.get(), state.proxy_secret.get());
    *state.ai.write().unwrap_or_else(|e| e.into_inner()) = rt;
}

pub struct AppState {
    db: Mutex<Database>,
    ai: RwLock<AiRuntime>,
    secrets: SecretStore,
    /// Access token of the Git sync.
    git_secret: SecretStore,
    /// Password of the proxy (Settings → Netzwerk).
    proxy_secret: SecretStore,
    /// One Git sync at a time (scheduler, backup and „Jetzt synchronisieren“).
    git_lock: Mutex<()>,
    data_dir: PathBuf,
    /// What happened to the data folder at startup (pending move, fallback).
    data_dir_notice: Option<datadir::Notice>,
    meter: Mutex<SessionMeter>,
    session_id: String,
    idle: Mutex<IdleAccumulator>,
    usage: Mutex<WindowUsage>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock leaves SQLite consistent (transactions roll back).
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    fn db(&self) -> MutexGuard<'_, Database> {
        lock(&self.db)
    }
    fn settings(&self) -> Settings {
        self.ai.read().unwrap_or_else(|e| e.into_inner()).settings.clone()
    }
    fn client(&self) -> Arc<LiteLlmClient> {
        self.ai.read().unwrap_or_else(|e| e.into_inner()).client.clone()
    }
    fn router(&self) -> Arc<ModelRouter> {
        self.ai.read().unwrap_or_else(|e| e.into_inner()).router.clone()
    }
    /// The configured backup folder, or `backups` in the data folder.
    fn backup_dir(&self) -> PathBuf {
        match self.settings().backup_dir.filter(|d| !d.trim().is_empty()) {
            Some(d) => PathBuf::from(d.trim()),
            None => self.data_dir.join("backups"),
        }
    }

    /// The configured Markdown mirror folder, or `markdown` in the backup folder.
    fn mirror_dir(&self) -> PathBuf {
        match self.settings().markdown_mirror_dir.filter(|d| !d.trim().is_empty()) {
            Some(d) => PathBuf::from(d.trim()),
            None => self.backup_dir().join("markdown"),
        }
    }

    fn attachments_dir(&self) -> PathBuf {
        attachments::dir(&self.data_dir)
    }
}

// ------------------------------------------------------------------- pages

#[tauri::command]
fn workspace_tree(state: State<AppState>) -> Result<Vec<PageNode>> {
    state.db().page_tree()
}

#[tauri::command]
fn page_get(state: State<AppState>, id: i64) -> Result<PageDoc> {
    state.db().page_doc(id)
}

#[tauri::command]
fn page_save(state: State<AppState>, id: i64, content: String) -> Result<PageDoc> {
    let db = state.db();
    db.save_page_content(id, &content)?;
    db.page_doc(id)
}

// ---------------------------------------------------------------- versions

#[tauri::command]
fn page_versions(state: State<AppState>, page_id: i64) -> Result<Vec<VersionInfo>> {
    state.db().list_versions(page_id)
}

#[tauri::command]
fn page_version_content(state: State<AppState>, version_id: i64) -> Result<String> {
    state.db().version_content(version_id)
}

/// Snapshots the page now („Jetzt Version sichern“); `None` when nothing changed.
#[tauri::command]
fn page_snapshot(state: State<AppState>, page_id: i64) -> Result<Option<i64>> {
    state.db().snapshot_page(page_id)
}

#[tauri::command]
fn page_version_restore(state: State<AppState>, page_id: i64, version_id: i64) -> Result<PageDoc> {
    let db = state.db();
    db.restore_version(page_id, version_id)?;
    db.page_doc(page_id)
}

#[tauri::command]
fn page_create(
    state: State<AppState>,
    parent_id: Option<i64>,
    title: String,
    icon: Option<String>,
    content: Option<String>,
) -> Result<Page> {
    let db = state.db();
    let page = db.create_page(parent_id, &unique_title(&db, &title)?, icon.as_deref())?;
    if let Some(c) = content {
        db.save_page_content(page.id, &c)?;
    }
    Ok(page)
}

/// Avoid duplicate titles so [[links]] stay unambiguous.
fn unique_title(db: &Database, title: &str) -> Result<String> {
    let base = title.trim().to_owned();
    let mut name = base.clone();
    let mut n = 2;
    while db.page_by_title(&name)?.is_some() {
        name = format!("{base} {n}");
        n += 1;
    }
    Ok(name)
}

#[tauri::command]
fn page_rename(state: State<AppState>, id: i64, title: String, update_links: bool) -> Result<usize> {
    let db = state.db();
    if let Some(other) = db.page_by_title(&title)?
        && other.id != id
    {
        return Err(Error::State(format!("Eine Seite „{}“ existiert bereits", other.title)));
    }
    db.rename_page_linked(id, &title, update_links)
}

/// Moves a page and its subpages to the trash. Returns the number of pages moved.
#[tauri::command]
fn page_delete(state: State<AppState>, id: i64) -> Result<usize> {
    state.db().trash_page(id)
}

#[tauri::command]
fn page_restore(state: State<AppState>, id: i64) -> Result<Page> {
    state.db().restore_page(id)
}

#[tauri::command]
fn page_purge(state: State<AppState>, id: i64) -> Result<usize> {
    state.db().purge_page(id)
}

#[tauri::command]
fn trash_list(state: State<AppState>) -> Result<Vec<TrashEntry>> {
    state.db().list_trash()
}

#[tauri::command]
fn trash_empty(state: State<AppState>) -> Result<usize> {
    state.db().empty_trash()
}

#[tauri::command]
fn page_move(state: State<AppState>, id: i64, parent_id: Option<i64>, position: i64) -> Result<()> {
    state.db().move_page(id, parent_id, position)
}

#[tauri::command]
fn page_set_favorite(state: State<AppState>, id: i64, favorite: bool) -> Result<()> {
    state.db().set_favorite(id, favorite)
}

#[tauri::command]
fn page_set_icon(state: State<AppState>, id: i64, icon: Option<String>) -> Result<()> {
    state.db().set_page_icon(id, icon.as_deref())
}

/// Resolves a [[link]] target; with `create`, a missing page is created at the top level.
#[tauri::command]
fn page_resolve(state: State<AppState>, title: String, create: bool) -> Result<Option<Page>> {
    let db = state.db();
    match db.page_by_title(&title)? {
        Some(p) => Ok(Some(p)),
        None if create => Ok(Some(db.create_page(None, &title, Some("file-text"))?)),
        None => Ok(None),
    }
}

#[tauri::command]
fn recent_pages(state: State<AppState>, limit: usize) -> Result<Vec<Page>> {
    state.db().recent_pages(limit)
}

#[tauri::command]
fn daily_note(state: State<AppState>, date: Option<NaiveDate>) -> Result<Page> {
    state.db().daily_note(date.unwrap_or_else(|| Local::now().date_naive()))
}

/// Per day `from..=to` (local): daily note, booked minutes and open tasks due, for the calendar.
#[tauri::command]
fn daily_overview(state: State<AppState>, from: NaiveDate, to: NaiveDate) -> Result<Vec<DayOverview>> {
    calendar::daily_overview(&state.db(), from, to, &Local)
}

#[tauri::command]
fn tags_list(state: State<AppState>) -> Result<Vec<(String, i64)>> {
    state.db().tag_counts()
}

#[tauri::command]
fn tag_pages(state: State<AppState>, tag: String) -> Result<Vec<Page>> {
    state.db().pages_with_tag(&tag)
}

#[tauri::command]
fn tasks_list(state: State<AppState>, filter: Option<TaskFilter>) -> Result<Vec<Task>> {
    state.db().list_tasks(&filter.unwrap_or_default())
}

/// Checks or unchecks one task in its page's Markdown; the UI then reloads open editors of that page.
#[tauri::command]
fn task_set_done(
    app: AppHandle,
    state: State<AppState>,
    page_id: i64,
    ordinal: i64,
    done: bool,
    expected_text: Option<String>,
) -> Result<()> {
    state.db().set_task_done(page_id, ordinal, done, expected_text.as_deref())?;
    let _ = app.emit("data://tasks", page_id);
    Ok(())
}

#[tauri::command]
fn search_workspace(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>> {
    search::search(&state.db(), &query, limit.unwrap_or(30))
}

#[tauri::command]
fn vault_import(state: State<AppState>, path: String) -> Result<ImportReport> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(Error::State(format!("„{path}“ ist kein Ordner")));
    }
    vault::import_vault(&state.db(), &dir, &state.attachments_dir())
}

#[tauri::command]
fn vault_export(state: State<AppState>, path: String) -> Result<usize> {
    vault::export_vault(&state.db(), &PathBuf::from(path), &state.attachments_dir())
}

// ------------------------------------------------------------- templates

fn template_vars(title: &str) -> TemplateVars {
    let now = Local::now();
    TemplateVars { date: now.date_naive(), time: now.time(), title: title.trim().to_owned() }
}

/// Pages below „Vorlagen“.
#[tauri::command]
fn templates_list(state: State<AppState>) -> Result<Vec<Page>> {
    state.db().list_templates()
}

/// The „Vorlagen“ page, created on first use.
#[tauri::command]
fn templates_root(state: State<AppState>) -> Result<Page> {
    state.db().templates_root()
}

/// Markdown of a template with its placeholders filled in.
#[tauri::command]
fn template_render(state: State<AppState>, id: i64, title: Option<String>) -> Result<String> {
    state.db().render_template(id, &template_vars(title.as_deref().unwrap_or("")))
}

#[tauri::command]
fn page_from_template(state: State<AppState>, template_id: i64, title: String, parent_id: Option<i64>) -> Result<Page> {
    let db = state.db();
    let name = unique_title(&db, &title)?;
    let content = db.render_template(template_id, &template_vars(&name))?;
    let icon = db.page(template_id)?.icon.unwrap_or_else(|| "file-text".into());
    db.atomic(|| {
        let page = db.create_page(parent_id, &name, Some(&icon))?;
        db.save_page_content(page.id, &content)?;
        Ok(page)
    })
}

// ------------------------------------------------------------ attachments

/// Stores an image (base64, optionally as a `data:` URL) and returns its `![[name]]` embed.
#[tauri::command]
fn attachment_save(
    state: State<AppState>,
    data: String,
    name: String,
    mime: Option<String>,
) -> Result<SavedAttachment> {
    let bytes = decode_attachment(&data)?;
    attachments::save(&state.attachments_dir(), &bytes, &name, mime.as_deref().unwrap_or(""))
}

/// Decodes base64 (optionally a `data:` URL, possibly line-wrapped). Oversized input is
/// rejected before anything is decoded, so a huge paste cannot allocate the decoded bytes.
fn decode_attachment(data: &str) -> Result<Vec<u8>> {
    let b64 = if data.starts_with("data:") { data.split_once(',').map_or("", |(_, d)| d) } else { data };
    let len = b64.bytes().filter(|b| !b.is_ascii_whitespace()).count();
    if len > attachments::MAX_BYTES.div_ceil(3) * 4 + 4 {
        return Err(Error::State(format!("Datei ist größer als {} MB", attachments::MAX_BYTES / 1024 / 1024)));
    }
    let compact: String = b64.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| Error::Parse(format!("Ungültige Bilddaten: {e}")))
}

/// Serves `annalo-asset://localhost/<name>`: only plain file names inside the attachments folder.
fn serve_attachment(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            // SVGs are images here, never documents that run scripts.
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
            .body(body)
            .unwrap_or_default()
    };
    let Some(state) = app.try_state::<AppState>() else { return respond(503, "text/plain", vec![]) };
    let raw = request.uri().path().trim_start_matches('/');
    let found = attachments::percent_decode(raw).and_then(|name| attachments::resolve(&state.attachments_dir(), &name));
    match found.map(|p| (std::fs::read(&p), p)) {
        Some((Ok(bytes), p)) => respond(200, attachments::mime_for(&p.to_string_lossy()), bytes),
        _ => respond(404, "text/plain", b"not found".to_vec()),
    }
}

// --------------------------------------------------------------------- WBS

#[derive(Serialize)]
struct NetzplanTree {
    #[serde(flatten)]
    netzplan: Netzplan,
    vorgaenge: Vec<Vorgang>,
}

#[derive(Serialize)]
struct ProjectTree {
    #[serde(flatten)]
    project: Project,
    netzplaene: Vec<NetzplanTree>,
}

/// Projects → Netzpläne → Vorgänge.
#[tauri::command]
fn wbs_tree(state: State<AppState>) -> Result<Vec<ProjectTree>> {
    let db = state.db();
    db.list_projects()?
        .into_iter()
        .map(|p| {
            let netzplaene = db
                .list_netzplaene(Some(p.id))?
                .into_iter()
                .map(|n| Ok(NetzplanTree { vorgaenge: db.list_vorgaenge(n.id)?, netzplan: n }))
                .collect::<Result<_>>()?;
            Ok(ProjectTree { project: p, netzplaene })
        })
        .collect()
}

fn required(value: &str, what: &str) -> Result<String> {
    let v = value.trim();
    if v.is_empty() { Err(Error::State(format!("{what} fehlt"))) } else { Ok(v.to_owned()) }
}

#[tauri::command]
fn project_create(state: State<AppState>, code: String, name: String) -> Result<Project> {
    state.db().create_project(&required(&code, "Projekt-ID")?, &required(&name, "Name")?)
}

#[tauri::command]
fn project_update(state: State<AppState>, id: i64, name: String) -> Result<()> {
    state.db().update_project(id, &required(&name, "Name")?)
}

#[tauri::command]
fn project_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_project(id)
}

#[tauri::command]
fn netzplan_create(
    state: State<AppState>,
    project_id: i64,
    netzplan_nr: String,
    wbs_element: String,
    description: String,
    planned_hours: f64,
) -> Result<Netzplan> {
    let nr = required(&netzplan_nr, "Netzplan-Nr.")?;
    let wbs = if wbs_element.trim().is_empty() { nr.clone() } else { wbs_element.trim().to_owned() };
    state.db().create_netzplan(project_id, &nr, &wbs, description.trim(), planned_hours.max(0.0))
}

#[tauri::command]
fn netzplan_update(
    state: State<AppState>,
    id: i64,
    wbs_element: String,
    description: String,
    planned_hours: f64,
) -> Result<()> {
    state.db().update_netzplan(id, &wbs_element, &description, planned_hours.max(0.0))
}

#[tauri::command]
fn netzplan_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_netzplan(id)
}

/// Adds a Vorgang; `predecessors` are Vorgang numbers of the same Netzplan.
#[tauri::command]
fn vorgang_create(
    state: State<AppState>,
    netzplan_id: i64,
    vorgang_nr: String,
    description: String,
    duration_days: f64,
    planned_hours: f64,
    predecessors: Vec<String>,
) -> Result<Vorgang> {
    let nr = required(&vorgang_nr, "Vorgangsnummer")?;
    let db = state.db();
    let existing = db.list_vorgaenge(netzplan_id)?;
    let preds: Vec<i64> = predecessors
        .iter()
        .map(|p| {
            existing
                .iter()
                .find(|v| v.vorgang_nr == *p)
                .map(|v| v.id)
                .ok_or_else(|| Error::not_found("vorgang", p.clone()))
        })
        .collect::<Result<_>>()?;
    db.atomic(|| {
        // A new Vorgang has no successors, so linking it cannot create a cycle.
        let mut v =
            db.create_vorgang(netzplan_id, &nr, description.trim(), duration_days.max(0.0), planned_hours.max(0.0))?;
        for p in preds {
            db.link_vorgaenge(p, v.id)?;
            v.predecessors.push(p);
        }
        Ok(v)
    })
}

#[tauri::command]
fn vorgang_update(
    state: State<AppState>,
    id: i64,
    description: String,
    duration_days: f64,
    planned_hours: f64,
    remaining_hours: Option<f64>,
) -> Result<()> {
    state.db().update_vorgang(id, &description, duration_days.max(0.0), planned_hours.max(0.0), remaining_hours)
}

#[tauri::command]
fn vorgang_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_vorgang(id)
}

#[tauri::command]
fn leistungsarten_list(state: State<AppState>) -> Result<Vec<(String, String)>> {
    state.db().list_leistungsarten()
}

#[tauri::command]
fn leistungsart_save(state: State<AppState>, code: String, description: String) -> Result<()> {
    state.db().upsert_leistungsart(&code, &description)
}

#[tauri::command]
fn leistungsart_delete(state: State<AppState>, code: String) -> Result<()> {
    state.db().delete_leistungsart(&code)
}

// ---------------------------------------------------------- time tracking

#[tauri::command]
fn log_time(state: State<AppState>, line: String, page_id: Option<i64>) -> Result<LogOutcome> {
    let t = state.settings().thresholds;
    let db = state.db();
    // Typed on a page linked to a Vorgang: `/zeit 1.5h …` books on that Vorgang.
    let default_ref = page_id.map(|id| db.page_reference(id)).transpose()?.flatten();
    let ctx = tracking::SlashContext { default_ref: default_ref.as_deref(), page_id };
    tracking::log_slash_command_in(&db, &line, Utc::now(), &Local, &t, ctx)
}

/// Budget and bookings of the Vorgang a page is linked to (`vorgang:` property).
#[tauri::command]
fn page_work(state: State<AppState>, page_id: i64) -> Result<Option<PageWork>> {
    let t = state.settings().thresholds;
    pagework::page_work(&state.db(), page_id, &t)
}

#[derive(Serialize)]
struct TimerStatus {
    entry: TimeEntry,
    idle_minutes: i64,
    is_idle: bool,
}

#[tauri::command]
fn timer_status(state: State<AppState>) -> Result<Option<TimerStatus>> {
    let running = state.db().running_timer()?;
    let idle = lock(&state.idle);
    Ok(running.map(|entry| TimerStatus { entry, idle_minutes: idle.idle_minutes(Utc::now()), is_idle: idle.is_idle() }))
}

#[tauri::command]
fn timer_start(
    app: AppHandle,
    state: State<AppState>,
    netzplan_id: i64,
    vorgang_nr: Option<String>,
    leistungsart: Option<String>,
    description: String,
) -> Result<TimeEntry> {
    let db = state.db();
    // Without a Leistungsart the Netzplan's default applies (Settings → Zeiterfassung).
    let leistungsart = match leistungsart.filter(|l| !l.is_empty()) {
        Some(l) => Some(l),
        None => {
            let nr = db.netzplan_by_id(netzplan_id)?.netzplan_nr;
            state.settings().time.default_la_for(&nr).map(str::to_owned)
        }
    };
    let e = db.start_timer(netzplan_id, vorgang_nr.as_deref(), leistungsart.as_deref(), &description, Utc::now())?;
    drop(db);
    lock(&state.idle).reset();
    let _ = app.emit("data://entries", ());
    desktop::refresh_tray(&app);
    Ok(e)
}

#[derive(Serialize)]
struct StopOutcome {
    entry: TimeEntry,
    idle_minutes: i64,
    alerts: Vec<BudgetStatus>,
    /// True when less than a minute was recorded and nothing was booked.
    discarded: bool,
}

/// Stops the timer. With `subtract_idle` the detected idle time is not booked.
#[tauri::command]
fn timer_stop(app: AppHandle, state: State<AppState>, subtract_idle: bool) -> Result<StopOutcome> {
    let now = Utc::now();
    let idle_minutes = lock(&state.idle).idle_minutes(now);
    let thresholds = state.settings().thresholds;
    let db = state.db();
    let entry = db.stop_timer(now, if subtract_idle { idle_minutes } else { 0 })?;
    lock(&state.idle).reset();
    let _ = app.emit("data://entries", ());
    drop(db);
    desktop::refresh_tray(&app);
    let db = state.db();
    if entry.duration_minutes.unwrap_or(0) < 1 {
        db.delete_time_entry(entry.id)?;
        return Ok(StopOutcome { entry, idle_minutes, alerts: vec![], discarded: true });
    }
    let alerts = tracking::alerts_for(&db, entry.netzplan_id, entry.vorgang_nr.as_deref(), &thresholds)?;
    Ok(StopOutcome { entry, idle_minutes, alerts, discarded: false })
}

#[tauri::command]
fn timer_discard(app: AppHandle, state: State<AppState>) -> Result<()> {
    state.db().discard_timer()?;
    let _ = app.emit("data://entries", ());
    desktop::refresh_tray(&app);
    Ok(())
}

#[tauri::command]
fn time_entries(
    state: State<AppState>,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<Vec<TimeEntryRow>> {
    state.db().list_time_entries(&EntryFilter { from, to, ..Default::default() })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn time_entry_create(
    state: State<AppState>,
    netzplan_id: i64,
    vorgang_nr: Option<String>,
    leistungsart: Option<String>,
    start_time: DateTime<Utc>,
    duration_minutes: i64,
    description: String,
) -> Result<LogOutcome> {
    if !(1..=24 * 60).contains(&duration_minutes) {
        return Err(Error::State("Dauer muss zwischen 1 Minute und 24 Stunden liegen".into()));
    }
    let settings = state.settings();
    let t = settings.thresholds;
    let db = state.db();
    let leistungsart = match leistungsart.filter(|v| !v.is_empty()) {
        Some(l) => Some(l),
        None => settings.time.default_la_for(&db.netzplan_by_id(netzplan_id)?.netzplan_nr).map(str::to_owned),
    };
    let entry = db.insert_time_entry(&NewTimeEntry {
        netzplan_id,
        vorgang_nr: vorgang_nr.filter(|v| !v.is_empty()),
        leistungsart,
        start_time,
        duration_minutes: settings.time.rounding.apply(duration_minutes),
        description,
        source: EntrySource::Manual,
        page_id: None,
    })?;
    let alerts = tracking::alerts_for(&db, entry.netzplan_id, entry.vorgang_nr.as_deref(), &t)?;
    let np = db.netzplan_by_id(entry.netzplan_id)?.netzplan_nr;
    let reference = entry.vorgang_nr.as_ref().map_or(np.clone(), |v| format!("{np}/{v}"));
    Ok(LogOutcome { entry, alerts, reference })
}

#[tauri::command]
fn time_entry_update(
    state: State<AppState>,
    id: i64,
    vorgang_nr: Option<String>,
    leistungsart: Option<String>,
    start_time: DateTime<Utc>,
    duration_minutes: i64,
    description: String,
) -> Result<TimeEntry> {
    state.db().update_time_entry(
        id,
        vorgang_nr.as_deref().filter(|v| !v.is_empty()),
        leistungsart.as_deref().filter(|v| !v.is_empty()),
        start_time,
        duration_minutes,
        &description,
    )
}

#[tauri::command]
fn set_entry_status(state: State<AppState>, ids: Vec<i64>, status: StatusFlag) -> Result<usize> {
    state.db().set_entry_status(&ids, status)
}

#[tauri::command]
fn delete_time_entry(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_time_entry(id)
}

#[tauri::command]
fn budget(state: State<AppState>, netzplan_id: i64) -> Result<Vec<BudgetStatus>> {
    let t = state.settings().thresholds;
    tracking::budget_status(&state.db(), netzplan_id, &t)
}

#[tauri::command]
fn schedule(state: State<AppState>, netzplan_id: i64) -> Result<Schedule> {
    netzplan::schedule(&state.db().list_vorgaenge(netzplan_id)?)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // IPC arguments map 1:1 to the UI call
fn export_entries(
    state: State<AppState>,
    format: ExportFormat,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
    only_released: bool,
    mark_exported: bool,
    path: Option<String>,
    include_exported: Option<bool>,
) -> Result<ExportResult> {
    let settings = state.settings();
    let db = state.db();
    let status = only_released.then_some(StatusFlag::Released);
    let mut rows = db.list_time_entries(&EntryFilter { from, to, status, ..Default::default() })?;
    // Exported entries were already booked in SAP/Jira; exporting them again duplicates bookings.
    if !include_exported.unwrap_or(false) {
        rows.retain(|r| r.entry.status_flag != StatusFlag::Exported);
    }
    let options = ExportOptions {
        pernr: settings.pernr.clone(),
        jira_issue_map: settings.jira_issue_map.clone(),
        utc_offset_minutes: None,
        cats_delimiter: settings.time.cats_delimiter,
        cats_columns: settings.time.cats_columns,
    };
    let res = export::export(&rows, format, &options)?;
    if let Some(p) = path {
        std::fs::write(&p, &res.content)?;
    }
    if mark_exported {
        db.set_entry_status(&res.exported_ids, StatusFlag::Exported)?;
    }
    Ok(res)
}

// ----------------------------------------------------------------- backups

fn run_backup(app: &AppHandle) -> Result<BackupInfo> {
    let res = backup_once(app);
    match &res {
        Ok(info) => devlog::debug("backup", format!("backup written: {}", info.path)),
        Err(e) => devlog::error("backup", e.to_string()),
    }
    res
}

fn backup_once(app: &AppHandle) -> Result<BackupInfo> {
    let state = app.state::<AppState>();
    let dir = state.backup_dir();
    let keep = state.settings().backup_keep;
    let info = backup::backup_to(&state.db(), &dir, keep)?;
    // Images live next to the database; names are content hashes, so copying new ones suffices.
    let src = state.attachments_dir();
    if src.is_dir() {
        copy_new_attachments(&src, &dir.join("attachments"))?;
    }
    let mut mirror_fresh = false;
    if state.settings().markdown_mirror {
        // The backup itself succeeded; a failed mirror is reported in the settings, not as a failed backup.
        match run_mirror(&state) {
            Ok(_) => mirror_fresh = true,
            Err(e) => devlog::error("backup", format!("markdown mirror failed: {e}")),
        }
    }
    let gs = state.settings().git_sync;
    if gs.enabled && gs.mode == SyncMode::WithBackup && !gs.remote_url.is_empty() {
        // Like the mirror, a failed sync does not fail the backup (reported via event, status and log).
        let _ = run_git_sync(app, mirror_fresh);
    }
    Ok(info)
}

// ----------------------------------------------------------------- git sync

const GIT_LAST: &str = "gitsync.last";
const GIT_COMMIT: &str = "gitsync.commit";
const GIT_BRANCH: &str = "gitsync.branch";
const GIT_ERROR: &str = "gitsync.error";

impl AppState {
    /// Working tree of the Git sync.
    fn git_repo_dir(&self) -> PathBuf {
        self.data_dir.join(gitsync::REPO_DIR)
    }

    /// What the sync commits: the Markdown mirror, or (mirror switched off) an export of its own.
    fn git_source_dir(&self) -> PathBuf {
        if self.settings().markdown_mirror { self.mirror_dir() } else { self.data_dir.join("git-sync-export") }
    }
}

/// Refreshes the source (unless the mirror was just written), syncs, records the outcome
/// and emits `gitsync://done` or `gitsync://failed`. Never holds the database lock while git runs.
fn run_git_sync(app: &AppHandle, mirror_fresh: bool) -> Result<SyncOutcome> {
    let state = app.state::<AppState>();
    let _running = lock(&state.git_lock);
    let settings = state.settings();
    let token = state.git_secret.get();
    devlog::remember_secret(token.as_deref());
    let res = (|| {
        let source = state.git_source_dir();
        if settings.markdown_mirror {
            if !mirror_fresh {
                run_mirror(&state)?;
            }
        } else {
            let db = state.db();
            mirror::write_mirror(&db, &source, &state.attachments_dir(), &Local)?;
        }
        let database = if settings.git_sync.include_database {
            backup::list_backups(&state.backup_dir())?.into_iter().next().map(|b| PathBuf::from(b.path))
        } else {
            None
        };
        let git = network::git(&state, token.clone(), &settings.git_sync.remote_url);
        gitsync::sync(
            &git,
            &SyncRequest {
                repo: &state.git_repo_dir(),
                source: &source,
                database: database.as_deref(),
                settings: &settings.git_sync,
                host: &gitsync::hostname(),
                now: Local::now(),
            },
        )
    })();
    let db = state.db();
    match &res {
        Ok(out) => {
            db.meta_set(GIT_LAST, &Local::now().to_rfc3339())?;
            db.meta_set(GIT_COMMIT, out.commit.as_deref().unwrap_or(""))?;
            db.meta_set(GIT_BRANCH, &out.branch)?;
            db.meta_set(GIT_ERROR, "")?;
            devlog::debug(
                "git",
                format!("sync done: branch {}, commit {}", out.branch, out.commit.as_deref().unwrap_or("–")),
            );
            let _ = app.emit("gitsync://done", out);
        }
        Err(e) => {
            // Errors from git are redacted already; this is the last line of defence.
            let msg = gitsync::redact(&e.to_string(), token.as_deref());
            db.meta_set(GIT_ERROR, &msg)?;
            let _ = app.emit("gitsync://failed", &msg);
            let err = Error::State(msg);
            // Same text as the error the UI gets, so the log keeps only this line.
            devlog::error("git", err.to_string());
            return Err(err);
        }
    }
    res
}

/// Syncs now (also when the automatic sync is off, as long as a remote is set).
#[tauri::command]
async fn git_sync_now(app: AppHandle) -> Result<SyncOutcome> {
    if app.state::<AppState>().settings().git_sync.remote_url.trim().is_empty() {
        return Err(Error::State("Bitte zuerst die Remote-URL eintragen und speichern".into()));
    }
    tauri::async_runtime::spawn_blocking(move || run_git_sync(&app, false))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

fn git_status_of(state: &AppState) -> Result<GitSyncStatus> {
    let settings = state.settings();
    let (last_at, last_commit, last_branch, last_error) = {
        let db = state.db();
        let get = |k: &str| -> Result<Option<String>> { Ok(db.meta_get(k)?.filter(|v| !v.is_empty())) };
        (
            get(GIT_LAST)?.and_then(|s| DateTime::parse_from_rfc3339(&s).ok()).map(|t| t.with_timezone(&Local)),
            get(GIT_COMMIT)?,
            get(GIT_BRANCH)?,
            get(GIT_ERROR)?,
        )
    };
    Ok(GitSyncStatus {
        enabled: settings.git_sync.enabled,
        repo_path: state.git_repo_dir().display().to_string(),
        last_at,
        last_commit,
        last_branch,
        last_error,
        pending_changes: gitsync::pending_changes(&state.git_source_dir(), &state.git_repo_dir()),
        token_set: state.git_secret.get().is_some(),
    })
}

/// Last run, pending changes and whether a token is stored (never the token itself).
#[tauri::command]
async fn git_sync_status(app: AppHandle) -> Result<GitSyncStatus> {
    tauri::async_runtime::spawn_blocking(move || git_status_of(&app.state::<AppState>()))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

/// Stores (or with `None`, removes) the Git access token in the OS credential store.
#[tauri::command]
async fn git_token_set(app: AppHandle, token: Option<String>) -> Result<GitSyncStatus> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.git_secret.set(token.as_deref().map(str::trim)).map_err(Error::State)?;
        devlog::remember_secret(token.as_deref());
        git_status_of(&state)
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

#[derive(Serialize)]
struct GitTest {
    ok: bool,
    latency_ms: u64,
    branches: Vec<String>,
    error: Option<String>,
}

/// Checks URL and credentials with `git ls-remote`. An unsaved URL or token can be tested.
#[tauri::command]
async fn git_sync_test(app: AppHandle, url: Option<String>, token: Option<String>) -> Result<GitTest> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let url = url.map(|u| u.trim().to_owned()).unwrap_or_else(|| state.settings().git_sync.remote_url);
        if url.is_empty() {
            return Ok(GitTest { ok: false, latency_ms: 0, branches: vec![], error: Some("Keine Remote-URL".into()) });
        }
        let token = token.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).or_else(|| state.git_secret.get());
        let git = network::git(&state, token.clone(), &url);
        let start = Instant::now();
        let res = git.version().and_then(|_| git.ls_remote(&url));
        let latency_ms = start.elapsed().as_millis() as u64;
        Ok(match res {
            Ok(branches) => GitTest { ok: true, latency_ms, branches, error: None },
            Err(e) => GitTest {
                ok: false,
                latency_ms,
                branches: vec![],
                error: Some(gitsync::redact(&e.to_string(), token.as_deref())),
            },
        })
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

/// Clones `url` (depth 1) into a temporary folder and imports it as a vault under a new
/// top-level page „Git-Import <Datum>“. The stored token is only sent to the configured remote.
#[tauri::command]
async fn git_restore_import(app: AppHandle, url: String) -> Result<ImportReport> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let gs = state.settings().git_sync;
        let url = url.trim().to_owned();
        gitsync::check_url(&url)?;
        let configured = url == gs.remote_url.trim();
        let token = if configured { state.git_secret.get() } else { None };
        let git = network::git(&state, token.clone(), &url);
        git.version()?;
        let now = Local::now();
        let tmp = std::env::temp_dir().join(format!(
            "annalo-git-import-{}-{}",
            std::process::id(),
            now.format("%Y%m%d%H%M%S%f")
        ));
        let dir = tmp.join(format!("Git-Import {}", now.format("%d.%m.%Y")));
        std::fs::create_dir_all(&tmp)?;
        let res = (|| {
            git.clone_shallow(&url, configured.then_some(gs.branch.as_str()), &dir)?;
            gitsync::strip_sync_files(&dir)?;
            vault::import_vault(&state.db(), &dir, &state.attachments_dir())
        })();
        let _ = std::fs::remove_dir_all(&tmp);
        res.map_err(|e| Error::State(gitsync::redact(&e.to_string(), token.as_deref())))
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

const MIRROR_LAST: &str = "mirror.last";
const MIRROR_ERROR: &str = "mirror.error";

/// Rebuilds the Markdown mirror and records the outcome (time or error) for the settings.
fn run_mirror(state: &AppState) -> Result<MirrorReport> {
    let dir = state.mirror_dir();
    let db = state.db();
    let res = mirror::write_mirror(&db, &dir, &state.attachments_dir(), &Local);
    match &res {
        Ok(r) => {
            db.meta_set(MIRROR_LAST, &r.created_at.to_rfc3339())?;
            db.meta_set(MIRROR_ERROR, "")?;
        }
        Err(e) => db.meta_set(MIRROR_ERROR, &e.to_string())?,
    }
    res
}

#[derive(Serialize)]
struct MirrorStatus {
    enabled: bool,
    /// Effective mirror folder (the configured one or the default).
    path: String,
    last_at: Option<DateTime<Local>>,
    error: Option<String>,
}

#[tauri::command]
fn mirror_status(state: State<AppState>) -> Result<MirrorStatus> {
    let db = state.db();
    let last_at =
        db.meta_get(MIRROR_LAST)?.and_then(|s| DateTime::parse_from_rfc3339(&s).ok()).map(|t| t.with_timezone(&Local));
    Ok(MirrorStatus {
        enabled: state.settings().markdown_mirror,
        path: state.mirror_dir().display().to_string(),
        last_at,
        error: db.meta_get(MIRROR_ERROR)?.filter(|e| !e.is_empty()),
    })
}

/// Opens the mirror folder in the file manager.
#[tauri::command]
fn mirror_open(app: AppHandle, state: State<AppState>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = state.mirror_dir();
    if !dir.is_dir() {
        return Err(Error::State("Die Markdown-Kopie wurde noch nicht erstellt – zuerst sichern".into()));
    }
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| Error::State(e.to_string()))
}

/// Copies regular files from `src` that `dst` lacks. Hidden files and symlinks are skipped;
/// each file is written under a temporary name and renamed, so an interrupted copy never
/// leaves a truncated file that later runs would take as complete.
fn copy_new_attachments(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)?.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if name_str.starts_with('.') || !entry.file_type()?.is_file() {
            continue;
        }
        let to = dst.join(&name);
        if to.exists() {
            continue;
        }
        let tmp = dst.join(format!(".{name_str}.part"));
        let copied = std::fs::copy(entry.path(), &tmp).and_then(|_| std::fs::rename(&tmp, &to));
        if let Err(e) = copied {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.into());
        }
    }
    Ok(())
}

/// Async so the snapshot and the Markdown mirror do not block the main (UI) thread.
#[tauri::command]
async fn backup_now(app: AppHandle) -> Result<BackupInfo> {
    tauri::async_runtime::spawn_blocking(move || run_backup(&app)).await.map_err(|e| Error::State(e.to_string()))?
}

#[tauri::command]
fn backup_list(state: State<AppState>) -> Result<Vec<BackupInfo>> {
    backup::list_backups(&state.backup_dir())
}

/// Backs up once a day: on start when the newest backup is older than 24 h, then checks hourly.
/// The hourly Git sync (mode `hourly`) runs in the same loop.
fn spawn_backup_scheduler(app: AppHandle) {
    const DAY: chrono::TimeDelta = chrono::TimeDelta::hours(24);
    std::thread::spawn(move || {
        loop {
            let state = app.state::<AppState>();
            let due = match backup::list_backups(&state.backup_dir()) {
                Ok(list) => list.first().is_none_or(|b| Local::now() - b.created_at >= DAY),
                Err(_) => true,
            };
            let mut backed_up = false;
            if due {
                // Failures are logged by `run_backup` and `run_git_sync`.
                match run_backup(&app) {
                    Ok(_) => backed_up = true,
                    Err(e) => {
                        let _ = app.emit("backup://failed", e.to_string());
                    }
                }
            }
            let gs = state.settings().git_sync;
            if gs.enabled && gs.mode == SyncMode::Hourly && !gs.remote_url.is_empty() {
                let _ = run_git_sync(&app, backed_up && state.settings().markdown_mirror);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
struct SettingsView {
    settings: Settings,
    api_key_set: bool,
    api_key_storage: &'static str,
    data_dir: String,
    /// Effective backup folder (the configured one or the default).
    backup_dir: String,
    version: &'static str,
}

#[tauri::command]
fn settings_get(state: State<AppState>) -> SettingsView {
    SettingsView {
        settings: state.settings(),
        api_key_set: state.secrets.get().is_some(),
        api_key_storage: state.secrets.backend(),
        data_dir: state.data_dir.display().to_string(),
        backup_dir: state.backup_dir().display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// Saves settings and applies them immediately (no restart needed).
#[tauri::command]
fn settings_save(app: AppHandle, state: State<AppState>, settings: Settings) -> Result<SettingsView> {
    let url = settings.litellm_base_url.trim().to_owned();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(Error::State("Die Server-URL muss mit http:// oder https:// beginnen".into()));
    }
    let mut settings = settings;
    settings.litellm_base_url = url.trim_end_matches('/').to_owned();
    settings.backup_keep = settings.backup_keep.clamp(1, 365);
    settings.backup_dir = settings.backup_dir.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    settings.markdown_mirror_dir = settings.markdown_mirror_dir.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    settings.git_sync = gitsync::normalize(&settings.git_sync)?;
    settings.network = settings.network.normalized()?;
    settings.normalize();
    // A missing or unreadable CA file is reported now, not on the next request.
    annalo_core::network::Prepared::new(&settings.network, state.proxy_secret.get().as_deref(), Purpose::Ai)?;
    settings.reminder_time = settings.reminder_time.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    if let Some(t) = &settings.reminder_time {
        let time = annalo_core::desktop::parse_hhmm(t)
            .ok_or_else(|| Error::State(format!("Erinnerungszeit „{t}“ ungültig, erwartet HH:MM")))?;
        settings.reminder_time = Some(time.format("%H:%M").to_string());
    }
    settings.capture_shortcut = settings.capture_shortcut.trim().to_owned();
    settings.palette_shortcut = settings.palette_shortcut.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    settings.search_shortcut = settings.search_shortcut.trim().to_owned();
    // The start page saves its widgets itself (`dashboard_save`); a settings draft opened
    // earlier must not overwrite them.
    settings.dashboard = state.settings().dashboard;
    let specs = |s: &Settings| {
        [s.capture_shortcut.clone(), s.palette_shortcut.clone().unwrap_or_default(), s.search_shortcut.clone()]
    };
    let new_specs = specs(&settings);
    desktop::validate_shortcuts(new_specs.each_ref().map(String::as_str)).map_err(Error::State)?;
    let old_specs = specs(&state.settings());
    let changed: Vec<bool> = new_specs.iter().zip(&old_specs).map(|(a, b)| a != b).collect();
    let only_changed =
        |v: &[String; 3]| -> [Option<String>; 3] { std::array::from_fn(|i| changed[i].then(|| v[i].clone())) };
    let apply = |v: &[String; 3]| {
        let v = only_changed(v);
        desktop::apply_shortcuts(&app, v.each_ref().map(Option::as_deref))
    };
    let any_changed = changed.contains(&true);
    // Registered before saving: a shortcut taken by another program is reported and the
    // previous one stays active and saved.
    if any_changed {
        apply(&new_specs).map_err(Error::State)?;
    }
    if let Err(e) = state.db().save_settings(&settings) {
        if any_changed {
            let _ = apply(&old_specs);
        }
        return Err(e);
    }
    lock(&state.idle).set_threshold(Duration::from_secs(settings.idle_threshold_minutes * 60));
    devlog::set_verbose(settings.dev_log_verbose);
    rebuild_ai(&state, settings);
    // Other windows (and a settings page opened elsewhere) take over the change.
    let _ = app.emit("settings://changed", ());
    Ok(settings_get(state))
}

/// Saves only the start page's widgets and scratch note (the rest of the settings stays as it is).
#[tauri::command]
fn dashboard_save(state: State<AppState>, dashboard: Dashboard) -> Result<SettingsView> {
    let mut settings = state.settings();
    settings.dashboard = dashboard.normalized();
    state.db().save_settings(&settings)?;
    state.ai.write().unwrap_or_else(|e| e.into_inner()).settings = settings;
    Ok(settings_get(state))
}

/// Stores (or with `None`, removes) the LiteLLM API key in the OS credential store.
#[tauri::command]
fn api_key_set(state: State<AppState>, key: Option<String>) -> Result<SettingsView> {
    state.secrets.set(key.as_deref().map(str::trim)).map_err(Error::State)?;
    rebuild_ai(&state, state.settings());
    Ok(settings_get(state))
}

#[derive(Serialize)]
struct ConnectionTest {
    ok: bool,
    latency_ms: u64,
    models: Vec<String>,
    error: Option<String>,
}

/// Checks a LiteLLM server by listing its models. Unsaved URL/key values can be tested.
#[tauri::command]
async fn ai_test_connection(
    state: State<'_, AppState>,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<ConnectionTest> {
    let settings = state.settings();
    let url = base_url.unwrap_or_else(|| settings.litellm_base_url.clone());
    let key = api_key.filter(|k| !k.is_empty()).or_else(|| state.secrets.get());
    let http = annalo_core::network::http_client(&settings.network, state.proxy_secret.get().as_deref(), Purpose::Ai)?;
    let client = LiteLlmClient::with_http(url.trim().trim_end_matches('/').to_owned(), key, http);
    let start = Instant::now();
    let res = client.models().await;
    let latency_ms = start.elapsed().as_millis() as u64;
    Ok(match res {
        Ok(mut models) => {
            models.sort();
            ConnectionTest { ok: true, latency_ms, models, error: None }
        }
        Err(e) => {
            devlog::warn("ai", format!("connection test failed: {e}"));
            ConnectionTest { ok: false, latency_ms, models: vec![], error: Some(e.to_string()) }
        }
    })
}

// ----------------------------------------------------------------------- AI

fn system_prompt(settings: &Settings) -> String {
    let now = Local::now();
    let mut s = format!(
        "Du bist der Assistent von Annalo, einem lokalen Arbeitsbereich für Notizen, Projekte und \
         Zeiterfassung. Heute ist {}. Antworte präzise und auf Deutsch, sofern der Nutzer nicht anders \
         schreibt. Nutze Markdown. Verweise auf Seiten mit [[Seitenname]]. Zeit wird mit der /zeit-Syntax \
         gebucht, z. B. /zeit NP-8801/1020 2.5h #DEV 'Beschreibung'. Nutze Tools nur, wenn nötig.",
        now.format("%A, %d.%m.%Y %H:%M")
    );
    if !settings.assistant_instructions.trim().is_empty() {
        s.push_str("\n\nZusätzliche Anweisungen des Nutzers:\n");
        s.push_str(settings.assistant_instructions.trim());
    }
    s
}

#[derive(Serialize, Clone)]
struct StreamPayload<'a> {
    request_id: &'a str,
    event: &'a StreamEvent,
}

#[derive(Serialize)]
struct ChatOutcome {
    completion: Completion,
    route: RouteDecision,
    context: Vec<ContextChunk>,
    meter: SessionMeter,
    /// Share of the monthly cost limit used, once it is at least 80 %.
    cost_warning: Option<f64>,
}

/// The cost warning after a request (at least 80 % of the monthly limit).
fn cost_warning(state: &AppState) -> Option<f64> {
    match prefs::cost_status_of(state).ok()?.level {
        annalo_core::prefs::CostLevel::Warning { fraction } | annalo_core::prefs::CostLevel::Blocked { fraction } => {
            Some(fraction)
        }
        annalo_core::prefs::CostLevel::Ok => None,
    }
}

fn route_for(
    state: &AppState,
    prompt: &str,
    context: &[String],
    uses_tools: bool,
    tier: Option<Tier>,
) -> RouteDecision {
    let settings = state.settings();
    // Settings → Datenschutz: everything stays on the local model.
    let force = if settings.privacy.local_only {
        Some(Tier::Local)
    } else {
        tier.or((!settings.auto_route).then_some(Tier::Standard))
    };
    state.router().route(&RouteInput { prompt, context, uses_tools, force })
}

#[tauri::command]
fn ai_route_preview(state: State<AppState>, prompt: String, use_tools: bool, tier: Option<Tier>) -> RouteDecision {
    route_for(&state, &prompt, &[], use_tools, tier)
}

#[tauri::command]
fn ai_models(state: State<AppState>) -> RouterConfig {
    state.settings().router
}

#[tauri::command]
fn ai_meter(state: State<AppState>) -> SessionMeter {
    lock(&state.meter).clone()
}

/// Runs one chat turn with retrieval and streams deltas as `ai://stream` events.
/// Tool calls in the result are executed by the UI via the `ai_*_tool` commands.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ai_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    messages: Vec<ChatMessage>,
    use_tools: bool,
    tier: Option<Tier>,
    page_id: Option<i64>,
    override_limit: Option<bool>,
) -> Result<ChatOutcome> {
    prefs::check_cost_limit(&state, override_limit.unwrap_or(false))?;
    let prompt = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .and_then(|m| m.content.clone())
        .ok_or_else(|| Error::State("no user message".into()))?;
    let settings = state.settings();
    let client = state.client();

    // Retrieval: embeddings are optional; keyword search always works offline.
    let query_embedding = match &settings.embedding_model {
        Some(m) if !m.is_empty() => client.embed(m, std::slice::from_ref(&prompt)).await.ok().and_then(|mut v| v.pop()),
        _ => None,
    };
    let (context, active, source_tags) = {
        let db = state.db();
        let context = rag::retrieve(&db, &prompt, query_embedding.as_deref(), 6)?;
        // Settings → Datenschutz: the open page is only sent when allowed.
        let active = match page_id.filter(|_| settings.privacy.read_open_page) {
            Some(id) => db.page_doc(id).ok().map(|d| (d.page.title, d.content)),
            None => None,
        };
        // A chunk rarely contains its page's #privat tag, so the tags of every source page count too.
        let mut ids: Vec<i64> = context.iter().filter_map(|c| c.page_id).collect();
        ids.sort_unstable();
        ids.dedup();
        let mut tags = vec![];
        for id in ids {
            tags.extend(db.page_tags(id)?.into_iter().map(|t| format!("#{t}")));
        }
        (context, active, tags.join(" "))
    };
    let mut context_texts: Vec<String> = context.iter().map(|c| c.text.clone()).collect();
    if let Some((_, text)) = &active {
        context_texts.push(text.clone());
    }
    context_texts.push(source_tags);
    // Earlier turns (and tool results) of the conversation are sent again, so they count as well.
    context_texts.extend(messages.iter().filter_map(|m| m.content.clone()));
    let route = route_for(&state, &prompt, &context_texts, use_tools, tier);

    let mut full = vec![ChatMessage::system(system_prompt(&settings))];
    if let Some((title, text)) = &active {
        let text: String = text.chars().take(12_000).collect();
        full.push(ChatMessage::system(format!("Aktuell geöffnete Seite „{title}“:\n\n{text}")));
    }
    if !context.is_empty() {
        full.push(ChatMessage::system(rag::format_context_with(&context, settings.ai.citations)));
    }
    full.extend(messages);
    let req = ChatRequest {
        model: route.model.clone(),
        messages: full,
        tools: if use_tools { tools::definitions_allowed(&settings.ai.allowed_tools) } else { vec![] },
        temperature: Some(settings.ai.temperature),
        max_tokens: settings.ai.max_tokens,
    };

    let (completion, meter) = stream_completion(&app, &state, &client, &request_id, &req).await?;
    Ok(ChatOutcome { completion, route, context, meter, cost_warning: cost_warning(&state) })
}

/// Streams `req` as `ai://stream` events for `request_id` (cancellable through `ai_cancel`)
/// and records the usage.
async fn stream_completion(
    app: &AppHandle,
    state: &AppState,
    client: &LiteLlmClient,
    request_id: &str,
    req: &ChatRequest,
) -> Result<(Completion, SessionMeter)> {
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&state.cancels).insert(request_id.to_owned(), cancel.clone());
    let result = client
        .chat_stream(req, Some(&cancel), |event| {
            let _ = app.emit("ai://stream", StreamPayload { request_id, event: &event });
        })
        .await;
    lock(&state.cancels).remove(request_id);
    let completion = result.inspect_err(|e| devlog::error("ai", e.to_string()))?;
    let u = &completion.usage;
    devlog::debug(
        "ai",
        format!(
            "{}: {} + {} tokens, finish {:?}",
            u.model, u.prompt_tokens, u.completion_tokens, completion.finish_reason
        ),
    );

    state.db().record_ai_usage(&state.session_id, &completion.usage)?;
    let meter = {
        let mut m = lock(&state.meter);
        m.add(&completion.usage);
        m.clone()
    };
    let _ = app.emit("ai://meter", &meter);
    Ok((completion, meter))
}

/// Rewrites `text` according to `instruction` (inline AI bar, meeting summary) and streams the
/// result like `ai_chat`, without retrieval or tools. The page's content and tags count for the
/// privacy markers, so a `#privat` page stays on the local model.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn ai_transform(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    instruction: String,
    text: String,
    page_id: Option<i64>,
    tier: Option<Tier>,
    override_limit: Option<bool>,
) -> Result<ChatOutcome> {
    if instruction.trim().is_empty() {
        return Err(Error::State("Keine Anweisung".into()));
    }
    prefs::check_cost_limit(&state, override_limit.unwrap_or(false))?;
    let client = state.client();
    let page = match page_id {
        Some(id) => {
            let db = state.db();
            db.page_doc(id).ok()
        }
        None => None,
    };
    let mut context = vec![text.clone()];
    if let Some(doc) = &page {
        context.push(doc.content.clone());
        context.push(doc.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    let route = route_for(&state, &instruction, &context, false, tier);
    let today = Local::now().format("%A, %d.%m.%Y").to_string();
    let req = ChatRequest {
        model: route.model.clone(),
        messages: transform::messages(&instruction, &text, page.as_ref().map(|d| d.page.title.as_str()), &today),
        tools: vec![],
        temperature: Some(0.2),
        max_tokens: state.settings().ai.max_tokens,
    };
    let (mut completion, meter) = stream_completion(&app, &state, &client, &request_id, &req).await?;
    completion.content = transform::clean_output(&completion.content);
    Ok(ChatOutcome { completion, route, context: vec![], meter, cost_warning: cost_warning(&state) })
}

/// Smart `/zeit`: a line with a duration but no reference, typed on a page without a linked
/// Vorgang, is matched to a Vorgang by the model. Returns `None` when the page has a linked
/// Vorgang (the line books on it as is). Nothing is booked here: the UI asks first.
/// The page's content and tags count for the privacy markers, so `#privat` pages stay local.
#[tauri::command]
async fn zeit_suggest_ai(
    app: AppHandle,
    state: State<'_, AppState>,
    line: String,
    page_id: Option<i64>,
) -> Result<Option<ZeitGuess>> {
    if zeitguess::unreferenced(&line).is_none() {
        return Err(Error::Parse("Die Zeile braucht eine Dauer direkt nach /zeit, z. B. /zeit 2h Beschreibung".into()));
    }
    let (candidates, las, page) = {
        let db = state.db();
        if let Some(id) = page_id
            && db.page_reference(id)?.is_some()
        {
            return Ok(None);
        }
        let page = page_id.and_then(|id| db.page_doc(id).ok());
        (zeitguess::candidates(&db, Utc::now())?, db.list_leistungsarten()?, page)
    };
    if candidates.is_empty() {
        return Err(Error::State("Keine Netzpläne oder Vorgänge angelegt".into()));
    }
    if state.secrets.get().is_none() {
        return Err(Error::State("Keine KI verbunden (LiteLLM-Token fehlt)".into()));
    }
    prefs::check_cost_limit(&state, false)?;
    let messages = zeitguess::messages(&line, &candidates, &las, page.as_ref().map(|d| d.page.title.as_str()));
    let mut context = vec![line.clone()];
    if let Some(doc) = &page {
        context.push(doc.content.clone());
        context.push(doc.tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" "));
    }
    let route = route_for(&state, &line, &context, false, None);
    let req = ChatRequest {
        model: route.model.clone(),
        messages,
        tools: vec![],
        temperature: Some(0.0),
        max_tokens: Some(300),
    };
    let request_id = format!("zeitguess-{}", Utc::now().timestamp_nanos_opt().unwrap_or_default());
    let client = state.client();
    let (completion, _) = stream_completion(&app, &state, &client, &request_id, &req).await?;
    let raw = zeitguess::parse_answer(&completion.content)?;
    zeitguess::validate(&line, &raw, &candidates, &las, Local::now().date_naive()).map(Some)
}

#[tauri::command]
fn ai_cancel(state: State<AppState>, request_id: String) {
    if let Some(flag) = lock(&state.cancels).get(&request_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[derive(Serialize)]
#[serde(tag = "risk", rename_all = "snake_case")]
enum ToolPlan {
    Workspace,
    RequiresApproval { call: SystemCall, summary: String },
}

/// Classifies a tool call so the UI knows whether to ask the user first.
#[tauri::command]
fn ai_plan_tool(state: State<AppState>, name: String, arguments: String) -> Result<ToolPlan> {
    tools::check_allowed(&name, &state.settings().ai.allowed_tools)?;
    Ok(match tools::classify(&name) {
        Risk::Workspace => ToolPlan::Workspace,
        Risk::RequiresApproval => {
            let call = SystemCall::from_tool_call(&name, &arguments)?;
            ToolPlan::RequiresApproval { summary: call.describe(), call }
        }
    })
}

#[tauri::command]
fn ai_run_workspace_tool(app: AppHandle, state: State<AppState>, name: String, arguments: String) -> Result<String> {
    tools::check_allowed(&name, &state.settings().ai.allowed_tools)?;
    let args: serde_json::Value = serde_json::from_str(&arguments)?;
    let arg = |k: &str| args[k].as_str().unwrap_or_default().to_owned();
    let t = state.settings().thresholds;
    let db = state.db();
    let out = match name.as_str() {
        "log_time" => {
            let mut line = arg("command");
            if !annalo_core::zeit::is_zeit_command(&line) {
                line = format!("/zeit {line}");
            }
            let res = serde_json::to_string(&tracking::log_slash_command(&db, &line, Utc::now(), &Local, &t)?)?;
            let _ = app.emit("data://entries", ());
            res
        }
        // Snippets mark hits with STX/ETX; the model does not need them.
        "search_workspace" => serde_json::to_string(&search::search(&db, &arg("query"), 10)?)?
            .replace("\\u0002", "")
            .replace("\\u0003", ""),
        "budget_status" => {
            let np = db.netzplan_by_ref(&arg("netzplan"))?;
            serde_json::to_string(&tracking::budget_status(&db, np.id, &t)?)?
        }
        "time_summary" => {
            let date = |k: &str| {
                NaiveDate::parse_from_str(arg(k).trim(), "%Y-%m-%d")
                    .map_err(|_| Error::Parse(format!("'{k}' muss ein Datum YYYY-MM-DD sein")))
            };
            serde_json::to_string(&report::time_summary(&db, date("from")?, date("to")?, &Local)?)?
        }
        "list_tasks" => {
            let filter: TaskFilter = serde_json::from_value(args.clone())?;
            let mut list = db.list_tasks(&filter)?;
            list.truncate(100);
            serde_json::to_string(&list)?
        }
        other => return Err(Error::State(format!("'{other}' is not a workspace tool"))),
    };
    Ok(out)
}

/// Executes a system tool. The UI calls this only after the user approved
/// the exact summary returned by `ai_plan_tool`.
#[tauri::command]
async fn ai_run_system_tool(state: State<'_, AppState>, call: SystemCall) -> Result<String> {
    let name = match &call {
        SystemCall::RunPowershell { .. } => "run_powershell",
        SystemCall::Git { .. } => "git",
        SystemCall::HttpRequest { .. } => "http_request",
    };
    let settings = state.settings();
    tools::check_allowed(name, &settings.ai.allowed_tools)?;
    let http = state.ai.read().unwrap_or_else(|e| e.into_inner()).tools_http.clone();
    tools::execute_system_tool(&call, &http, settings.network.timeout()).await
}

/// Embeds note chunks that have no embedding yet. Returns the number indexed.
#[tauri::command]
async fn ai_index_pending(state: State<'_, AppState>) -> Result<usize> {
    let model = state
        .settings()
        .embedding_model
        .filter(|m| !m.is_empty())
        .ok_or_else(|| Error::State("Kein Embedding-Modell in den Einstellungen gewählt".into()))?;
    let client = state.client();
    let mut total = 0;
    loop {
        let batch = rag::pending_blocks(&state.db(), 32)?;
        if batch.is_empty() {
            return Ok(total);
        }
        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let vectors = client.embed(&model, &texts).await?;
        let db = state.db();
        for ((id, _), v) in batch.iter().zip(&vectors) {
            rag::store_embedding(&db, *id, v)?;
        }
        total += batch.len();
    }
}

// --------------------------------------------------------------- activity

#[derive(Serialize, Clone)]
struct ActivityTick {
    idle_seconds: Option<u64>,
    window: Option<activity::WindowInfo>,
    timer_idle_minutes: Option<i64>,
    is_idle: bool,
}

/// Samples input idleness and the foreground window every 5 seconds.
fn spawn_activity_sampler(app: AppHandle) {
    const INTERVAL: Duration = Duration::from_secs(5);
    std::thread::spawn(move || {
        let probe = activity::system_probe();
        let mut ticks = 0u32;
        loop {
            std::thread::sleep(INTERVAL);
            // Tray tooltip and reminders every 30 s.
            if ticks.is_multiple_of(6) {
                desktop::periodic(&app);
            }
            ticks = ticks.wrapping_add(1);
            let state = app.state::<AppState>();
            let idle = probe.idle_duration();
            let window = probe.foreground_window();
            let threshold = Duration::from_secs(state.settings().idle_threshold_minutes * 60);
            let is_idle = idle.is_some_and(|d| d >= threshold);
            let running = state.db().running_timer().ok().flatten().is_some();
            let timer_idle_minutes = if running {
                let mut acc = lock(&state.idle);
                if let Some(d) = idle {
                    acc.observe(Utc::now(), d);
                }
                Some(acc.idle_minutes(Utc::now()))
            } else {
                None
            };
            lock(&state.usage).record(window.as_ref(), is_idle, INTERVAL);
            let tick = ActivityTick { idle_seconds: idle.map(|d| d.as_secs()), window, timer_idle_minutes, is_idle };
            let _ = app.emit("activity://tick", tick);
        }
    });
}

/// Whether to show the first-run choice: nothing in the workspace yet and not answered before.
#[tauri::command]
fn onboarding_needed(state: State<AppState>) -> Result<bool> {
    let db = state.db();
    Ok(db.meta_get("onboarded")?.is_none() && db.list_projects()?.is_empty() && db.page_tree()?.is_empty())
}

/// Finishes the first-run choice, optionally with the sample workspace.
#[tauri::command]
fn onboarding_finish(app: AppHandle, state: State<AppState>, samples: bool) -> Result<()> {
    let db = state.db();
    if samples {
        demo::seed_explicit(&db, Utc::now())?;
    }
    db.meta_set("onboarded", "1")?;
    let _ = app.emit("data://entries", ());
    Ok(())
}

/// Removes the sample project and pages created on first start.
#[tauri::command]
fn demo_remove(app: AppHandle, state: State<AppState>) -> Result<usize> {
    let n = demo::remove(&state.db())?;
    let _ = app.emit("data://entries", ());
    Ok(n)
}

/// Windows 11 (build 22000+) supports the Mica backdrop.
#[cfg(windows)]
fn supports_mica() -> bool {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid, correctly sized OSVERSIONINFOW.
    unsafe { RtlGetVersion(&mut info) == 0 && info.dwBuildNumber >= 22000 }
}

#[cfg(not(windows))]
fn supports_mica() -> bool {
    false
}

fn create_main_window(
    app: &tauri::App,
    visible: bool,
    geometry: Option<prefs::WindowState>,
    mica_on: bool,
    custom_frame: bool,
) -> tauri::Result<tauri::WebviewWindow> {
    // Transparent whenever Mica is possible, so switching it on later needs no restart.
    let mica = supports_mica();
    let mut builder = tauri::WebviewWindowBuilder::new(app, desktop::MAIN, tauri::WebviewUrl::default())
        .visible(visible)
        .title("Annalo")
        .min_inner_size(900.0, 560.0)
        // The native file-drop handler swallows HTML5 drag & drop on Windows (image drop, tabs, sidebar).
        .disable_drag_drop_handler();
    builder = match geometry {
        Some(g) => {
            builder.inner_size(g.width as f64, g.height as f64).position(g.x as f64, g.y as f64).maximized(g.maximized)
        }
        None => builder.inner_size(1480.0, 920.0).center(),
    };
    #[cfg(windows)]
    let builder = if mica {
        let b = builder.transparent(true);
        if mica_on {
            b.effects(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::window::Effect::Mica],
                ..Default::default()
            })
        } else {
            b
        }
    } else {
        builder
    };
    // Windows: own title bar. The UI draws the window buttons, the tab bar moves the window
    // (data-tauri-drag-region); resizing at the edges and the shadow stay with the system.
    #[cfg(windows)]
    let builder = builder.decorations(!custom_frame);
    CUSTOM_FRAME.store(cfg!(windows) && custom_frame, std::sync::atomic::Ordering::Relaxed);
    let _ = (mica, mica_on);
    // macOS: the tab bar sits in the title bar; the UI leaves room for the traffic lights (`os-macos`).
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    let window = builder.build()?;
    // A saved position on a monitor that is gone: center instead.
    if geometry.is_some()
        && let (Ok(pos), Ok(monitors)) = (window.outer_position(), window.available_monitors())
    {
        let visible = monitors.iter().any(|m| {
            let (p, s) = (m.position(), m.size());
            pos.x + 40 >= p.x
                && pos.y + 10 >= p.y
                && pos.x < p.x + s.width as i32 - 40
                && pos.y < p.y + s.height as i32 - 40
        });
        if !monitors.is_empty() && !visible {
            let _ = window.center();
        }
    }
    Ok(window)
}

/// Whether the main window was created with the app's own title bar (Windows only).
static CUSTOM_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the main window draws its own title bar (Settings → Darstellung, Windows). Reflects
/// the window as created: a changed setting applies at the next start.
#[tauri::command]
fn window_frame() -> bool {
    CUSTOM_FRAME.load(std::sync::atomic::Ordering::Relaxed)
}

/// Whether the window has a Mica backdrop (the UI then lets it show through). Off when
/// switched off under Settings → Darstellung.
#[tauri::command]
fn window_backdrop(state: State<AppState>) -> bool {
    supports_mica() && state.settings().appearance.mica
}

/// Switches the Mica variant to match the app theme (Windows 11 only).
#[tauri::command]
fn window_set_theme(app: AppHandle, dark: bool) {
    #[cfg(windows)]
    if supports_mica()
        && let Some(w) = app.get_webview_window("main")
    {
        let on = app.state::<AppState>().settings().appearance.mica;
        let effect = if dark { tauri::window::Effect::MicaDark } else { tauri::window::Effect::MicaLight };
        let effects = if on { vec![effect] } else { vec![] };
        let _ = w.set_effects(tauri::utils::config::WindowEffectsConfig { effects, ..Default::default() });
    }
    let _ = (app, dark);
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    data_dir: String,
    platform: &'static str,
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: state.data_dir.display().to_string(),
        platform: std::env::consts::OS,
    }
}

// --------------------------------------------------------------- data folder

#[derive(Serialize)]
struct DataDirStatus {
    data_dir: String,
    /// The folder is a network share or inside OneDrive/Dropbox.
    synced: bool,
    /// Folder the workspace moves to on the next start.
    pending_move: Option<String>,
    /// Result of a move or a fallback at startup.
    notice: Option<datadir::Notice>,
}

fn config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path().app_config_dir().map_err(|e| Error::State(e.to_string()))
}

fn data_dir_status_of(app: &AppHandle, state: &AppState) -> DataDirStatus {
    let dir = state.data_dir.display().to_string();
    let pending = config_dir(app).ok().and_then(|c| datadir::read_location_file(&c)).and_then(|l| l.pending_move);
    DataDirStatus {
        synced: datadir::is_synced_or_network(&dir),
        data_dir: dir,
        pending_move: pending,
        notice: state.data_dir_notice.clone(),
    }
}

#[tauri::command]
fn data_dir_status(app: AppHandle, state: State<AppState>) -> DataDirStatus {
    data_dir_status_of(&app, &state)
}

fn data_dir_env_guard() -> Result<()> {
    if std::env::var_os("ANNALO_DATA_DIR").is_some() {
        return Err(Error::State("Der Speicherort ist über ANNALO_DATA_DIR festgelegt".into()));
    }
    Ok(())
}

/// Checks a folder chosen as the new data folder (writable, not the current one) and
/// whether it already holds a workspace.
#[tauri::command(async)]
fn data_dir_inspect(state: State<'_, AppState>, path: String) -> Result<datadir::Target> {
    datadir::check_target(&state.data_dir, &PathBuf::from(path.trim()))
}

/// Chooses `path` as the data folder from the next start on. Nothing is copied now, so
/// edits made until the restart are not lost: the next start copies the closed workspace
/// (see `datadir::prepare`). With `use_existing`, a workspace already in `path` is opened
/// instead (the current one stays where it is).
#[tauri::command(async)]
fn data_dir_set(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    use_existing: Option<bool>,
) -> Result<DataDirStatus> {
    data_dir_env_guard()?;
    let to = PathBuf::from(path.trim());
    let target = datadir::check_target(&state.data_dir, &to)?;
    let config = config_dir(&app)?;
    if target.has_workspace {
        if !use_existing.unwrap_or(false) {
            return Err(Error::State(format!("Im Zielordner liegt bereits ein Arbeitsbereich ({})", datadir::DB_FILE)));
        }
        datadir::write_location(&config, &to)?;
    } else {
        datadir::write_pending_move(&config, &state.data_dir, &to)?;
    }
    Ok(data_dir_status_of(&app, &state))
}

/// Discards a pending move (the current folder stays in use).
#[tauri::command(async)]
fn data_dir_cancel(app: AppHandle, state: State<'_, AppState>) -> Result<DataDirStatus> {
    data_dir_env_guard()?;
    datadir::write_location(&config_dir(&app)?, &state.data_dir)?;
    Ok(data_dir_status_of(&app, &state))
}

/// Restarts the app (in the foreground, even when it was autostarted minimized). The
/// database is closed first, so a pending move at the next start copies a finished file.
#[tauri::command]
fn app_restart(app: AppHandle) -> Result<()> {
    restart(&app)
}

/// Closes the workspace and releases the single-instance lock before this process ends
/// and another one (a restart, or the update installer's relaunch) takes over.
pub(crate) fn prepare_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        let mut db = state.db();
        let _ = db.checkpoint();
        // Dropping the connection closes the workspace; late writes land in memory.
        if let Ok(mem) = Database::open_in_memory() {
            *db = mem;
        }
    }
    // Otherwise the new process would only focus this one.
    tauri_plugin_single_instance::destroy(app);
}

pub(crate) fn restart(app: &AppHandle) -> Result<()> {
    let exe = tauri::process::current_binary(&app.env())?;
    prepare_exit(app);
    let args = std::env::args_os().skip(1).filter(|a| a != desktop::MINIMIZED_ARG);
    std::process::Command::new(exe).args(args).spawn()?;
    app.exit(0);
    Ok(())
}

// ------------------------------------------------------------------ startup

#[derive(Deserialize, Default)]
struct StartupOptions {
    /// Seed the demo workspace on first start (tests; users choose in the onboarding).
    demo: Option<bool>,
}

pub fn run() {
    let mut builder = tauri::Builder::default();
    // Two processes on one SQLite workspace would overwrite each other's edits: a second
    // launch only brings the running window to the front. Test runs (ANNALO_DATA_DIR)
    // use their own workspace each and may overlap.
    if std::env::var_os("ANNALO_DATA_DIR").is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| match jumplist::parse(&args) {
            // A taskbar jump-list entry while the app runs.
            Some(action) => jumplist::run(app, action, true),
            None => desktop::show_main(app),
        }));
    }
    // Only in release builds with an update key; others never contact the update server.
    if let Some(updater) = updates::plugin() {
        builder = builder.plugin(updater);
    }
    let autostart = tauri_plugin_autostart::Builder::new().arg(desktop::MINIMIZED_ARG);
    // A login item in ~/Library/LaunchAgents (no AppleScript permission prompt).
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    // macOS has a menu bar (⌘C/⌘V in the webview need its Edit menu); Windows and Linux keep none.
    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(appmenu::build).on_menu_event(appmenu::on_event);
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(autostart.build())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    match desktop::shortcut_role(app, shortcut) {
                        Some(desktop::Role::Capture) => desktop::open_capture(app),
                        Some(desktop::Role::Search) => desktop::open_search(app, true),
                        Some(desktop::Role::Palette) => {
                            // In front already: the shortcut toggles the palette; from the
                            // background (hidden, minimized, unfocused) it always opens it.
                            let mut foreground = false;
                            if let Some(w) = app.get_webview_window("main") {
                                foreground = w.is_visible().unwrap_or(false)
                                    && !w.is_minimized().unwrap_or(false)
                                    && w.is_focused().unwrap_or(false);
                                let _ = w.unminimize();
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("palette://toggle", foreground);
                        }
                        None => {}
                    }
                })
                .build(),
        )
        .register_uri_scheme_protocol("annalo-asset", |ctx, request| serve_attachment(ctx.app_handle(), &request))
        .register_uri_scheme_protocol("annalo-pac", |_ctx, _request| network::pac_sandbox())
        .on_window_event(desktop::on_window_event)
        .setup(move |app| {
            // ANNALO_DATA_DIR lets tests run against a throw-away workspace; otherwise
            // `location.json` in the config folder may point to a chosen data folder.
            // A pending move is carried out here, before the database is opened.
            let startup = datadir::prepare(
                std::env::var_os("ANNALO_DATA_DIR").map(PathBuf::from),
                app.path().app_config_dir().ok().as_deref(),
                app.path().app_data_dir()?,
            );
            let dir = startup.dir.clone();
            std::fs::create_dir_all(&dir)?;
            devlog::init(&dir, false);
            devlog::info(
                "core",
                format!(
                    "Annalo {} started ({} {}), data folder {}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    dir.display()
                ),
            );
            if let Some(n) = &startup.notice {
                devlog::warn("core", format!("data folder: {}", n.message));
            }
            let opts: StartupOptions =
                std::env::var("ANNALO_STARTUP").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            let db = Database::open(dir.join(datadir::DB_FILE))?;
            if opts.demo.unwrap_or(false) {
                demo::seed(&db, Utc::now())?;
            }
            if let Err(e) = db.purge_expired_trash(Utc::now()) {
                devlog::warn("core", format!("trash cleanup failed: {e}"));
            }
            if let Err(e) = db.prune_versions(Utc::now()) {
                devlog::warn("core", format!("version cleanup failed: {e}"));
            }
            if let Err(e) = db.migrate_palette_default() {
                devlog::warn("core", format!("settings migration failed: {e}"));
            }
            let settings = db.load_settings()?;
            devlog::set_verbose(settings.dev_log_verbose);
            let shortcuts = [
                settings.capture_shortcut.clone(),
                settings.palette_shortcut.clone().unwrap_or_default(),
                settings.search_shortcut.clone(),
            ];
            let secrets = SecretStore::new(&dir);
            let proxy_secret = SecretStore::proxy(&dir);
            let idle_threshold = Duration::from_secs(settings.idle_threshold_minutes * 60);
            let start = settings.start.clone();
            let mica_on = settings.appearance.mica;
            let custom_frame = settings.appearance.custom_titlebar;
            let geometry = prefs::saved_window(app.handle(), &settings);
            let ai = AiRuntime::new(settings, secrets.get(), proxy_secret.get());

            app.manage(AppState {
                db: Mutex::new(db),
                ai: RwLock::new(ai),
                secrets,
                git_secret: SecretStore::git(&dir),
                proxy_secret,
                git_lock: Mutex::new(()),
                data_dir: dir,
                data_dir_notice: startup.notice,
                meter: Mutex::new(SessionMeter::default()),
                session_id: Utc::now().format("%Y%m%dT%H%M%S").to_string(),
                idle: Mutex::new(IdleAccumulator::new(idle_threshold)),
                usage: Mutex::new(WindowUsage::default()),
                cancels: Mutex::new(HashMap::new()),
            });

            app.manage(desktop::Desktop::default());
            app.manage(updates::Updates::default());
            // No tray (e.g. a Linux desktop without StatusNotifier): the app still works,
            // closing then minimizes instead of hiding.
            if let Err(e) = desktop::setup_tray(app.handle()) {
                devlog::warn("desktop", format!("tray icon not available: {e}"));
            }
            let tray = app.state::<desktop::Desktop>().has_tray();
            // Autostart, or Settings → Start „Minimiert starten“: hidden in the tray, or minimized without one.
            let wants_minimized = start.minimized || std::env::args().any(|a| a == desktop::MINIMIZED_ARG);
            let minimized = tray && wants_minimized;
            jumplist::set_app_id(&app.config().identifier);
            let window = create_main_window(app, !minimized, geometry, mica_on, custom_frame)?;
            // Started from a taskbar jump-list entry: runs once the UI listens (`jump_take`).
            if let Some(action) = jumplist::parse(&std::env::args().collect::<Vec<_>>()) {
                jumplist::run(app.handle(), action, false);
            }
            jumplist::refresh(app.handle());
            if wants_minimized && !tray {
                let _ = window.minimize();
            }

            // Another instance may already own the shortcut; Ctrl+K still works in-app.
            // Registered one by one: one taken shortcut must not block the others.
            for (i, spec) in shortcuts.iter().enumerate() {
                let mut specs = [None; 3];
                specs[i] = Some(spec.as_str());
                if let Err(e) = desktop::apply_shortcuts(app.handle(), specs) {
                    devlog::warn("desktop", format!("global shortcut not available: {e}"));
                }
            }
            spawn_activity_sampler(app.handle().clone());
            spawn_backup_scheduler(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            workspace_tree,
            page_get,
            page_save,
            page_versions,
            page_version_content,
            page_snapshot,
            page_version_restore,
            page_create,
            page_rename,
            page_delete,
            page_restore,
            page_purge,
            trash_list,
            trash_empty,
            page_move,
            page_set_favorite,
            page_set_icon,
            page_resolve,
            recent_pages,
            daily_note,
            daily_overview,
            tags_list,
            tag_pages,
            tasks_list,
            task_set_done,
            search_workspace,
            vault_import,
            vault_export,
            templates_list,
            templates_root,
            template_render,
            page_from_template,
            attachment_save,
            wbs_tree,
            project_create,
            project_update,
            project_delete,
            netzplan_create,
            netzplan_update,
            netzplan_delete,
            vorgang_create,
            vorgang_update,
            vorgang_delete,
            leistungsarten_list,
            leistungsart_save,
            leistungsart_delete,
            log_time,
            page_work,
            timer_status,
            timer_start,
            timer_stop,
            timer_discard,
            time_entries,
            time_entry_create,
            time_entry_update,
            set_entry_status,
            delete_time_entry,
            budget,
            schedule,
            export_entries,
            backup_now,
            backup_list,
            mirror_status,
            mirror_open,
            git_sync_now,
            git_sync_status,
            git_token_set,
            git_sync_test,
            git_restore_import,
            settings_get,
            settings_save,
            api_key_set,
            ai_test_connection,
            ai_route_preview,
            ai_models,
            ai_meter,
            ai_chat,
            ai_transform,
            zeit_suggest_ai,
            ai_cancel,
            ai_plan_tool,
            ai_run_workspace_tool,
            ai_run_system_tool,
            ai_index_pending,
            network::network_status,
            network::network_test,
            network::network_fetch_pac,
            network::network_ca_info,
            network::proxy_password_set,
            prefs::settings_export,
            prefs::settings_file_read,
            prefs::settings_defaults,
            prefs::window_state_save,
            prefs::ai_cost_status,
            app_info,
            data_dir_status,
            data_dir_inspect,
            data_dir_set,
            data_dir_cancel,
            app_restart,
            demo_remove,
            onboarding_needed,
            onboarding_finish,
            window_backdrop,
            window_frame,
            jumplist::jump_take,
            window_set_theme,
            desktop::window_hide,
            desktop::app_quit,
            desktop::capture_submit,
            desktop::capture_hide,
            desktop::search_hide,
            desktop::search_open,
            desktop::timer_resume_last,
            dashboard_save,
            desktop::desktop_info,
            desktop::autostart_set,
            updates::update_status,
            updates::update_check,
            updates::update_install,
            devlog::devlog_write,
            devlog::devlog_read,
            devlog::devlog_stats,
            devlog::devlog_clear,
            devlog::devlog_open_folder,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Annalo")
        .run(on_run_event);
}

fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    // macOS: closing hides the window and the app stays in the Dock; clicking the Dock icon
    // brings the window back.
    #[cfg(target_os = "macos")]
    if let tauri::RunEvent::Reopen { .. } = event {
        desktop::show_main(app);
    }
    let _ = (app, event);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachment_base64_is_bounded_and_whitespace_tolerant() {
        assert_eq!(decode_attachment("data:image/png;base64,aGFs\r\nbG8=").unwrap(), b"hallo");
        assert_eq!(decode_attachment(" aGFs bG8=\n").unwrap(), b"hallo");
        let huge = "A".repeat(attachments::MAX_BYTES.div_ceil(3) * 4 + 8);
        assert!(matches!(decode_attachment(&huge), Err(Error::State(_))));
        assert!(matches!(decode_attachment("%%%"), Err(Error::Parse(_))));
    }

    #[test]
    fn backup_copies_only_plain_visible_files() {
        let base = std::env::temp_dir().join(format!("annalo-att-copy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let (src, dst) = (base.join("src"), base.join("dst"));
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.png"), [1u8; 3]).unwrap();
        std::fs::write(src.join(".hidden"), [2u8; 3]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(src.join("a.png"), src.join("link.png")).unwrap();
        copy_new_attachments(&src, &dst).unwrap();
        let mut names: Vec<_> =
            std::fs::read_dir(&dst).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["a.png"]);
        assert_eq!(std::fs::read(dst.join("a.png")).unwrap(), [1u8; 3]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
