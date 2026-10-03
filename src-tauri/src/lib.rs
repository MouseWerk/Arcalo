//! Arcalo desktop shell: exposes `annalo-core` to the web UI over Tauri IPC.

// Built on every platform (so Linux/Windows CI type-checks it); installed on macOS only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
mod appmenu;
mod backdrop;
mod backupdest;
mod bookmarks;
mod briefing;
mod calsync;
mod canvas;
mod chats;
mod dashboard;
mod dayreview;
mod desktop;
mod devlog;
mod diagnostics;
mod feed;
mod files;
mod filing;
mod focus;
mod graph;
mod jira;
mod jumplist;
mod linking;
mod mail;
mod meetwork;
mod network;
mod notifyact;
mod policy;
mod portable;
mod prefs;
mod present;
mod rebrand;
mod recovery;
mod rollback;
mod secrets;
mod security;
mod syncmerge;
mod timeblocks;
mod updates;
mod voice;
mod weekplan;
mod worktime;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};
use std::time::{Duration, Instant};

use annalo_core::activity::{self, IdleAccumulator, WindowUsage};
use annalo_core::ai::availability::{Catalog, Exclude};
use annalo_core::ai::capability::{self, Capabilities};
use annalo_core::ai::client::{ChatMessage, ChatRequest, Completion, StreamEvent};
use annalo_core::ai::metrics::PriceTable;
use annalo_core::ai::metrics::SessionMeter;
use annalo_core::ai::privacy;
use annalo_core::ai::provider::AiProvider;
use annalo_core::ai::rag::{self, ContextChunk};
use annalo_core::ai::router::{ModelRef, ModelRouter, RouteDecision, RouteInput, RouterConfig, Tier};
use annalo_core::ai::tools::{self, Risk, SystemCall};
use annalo_core::ai::transform;
use annalo_core::ai::zeitguess::{self, ZeitGuess};
use annalo_core::ai::{AiClient, availability};
use annalo_core::attachment_manager;
use annalo_core::attachments::{self, SavedAttachment};
use annalo_core::backup::{self, BackupInfo};
use annalo_core::calendar::{self, DayOverview};
use annalo_core::db::EntryFilter;
use annalo_core::drawings;
use annalo_core::error::IoAt;
use annalo_core::export::{self, ExportFormat, ExportOptions, ExportResult};
use annalo_core::gitsync::{self, GitSyncStatus, SyncMode, SyncOutcome, SyncRequest};
use annalo_core::mirror::{self, MirrorReport};
use annalo_core::model::*;
use annalo_core::network::Service;
use annalo_core::netzplan::{self, Schedule};
use annalo_core::notes::{PageDoc, SavedPage};
use annalo_core::pagework::{self, PageWork};
use annalo_core::properties;
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
use annalo_core::{tr, trf};
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
    /// Clients of the switched-on AI providers, by provider id.
    clients: HashMap<String, Arc<AiClient>>,
    router: Arc<ModelRouter>,
    /// HTTP clients of the other services by service key (`network::client_for`), built on
    /// first use with these settings.
    http: Mutex<HashMap<String, tools::HttpClient>>,
    /// Why the network settings cannot be applied (a missing CA file): requests fail with this
    /// instead of going out without proxy and certificates.
    network_error: Option<String>,
}

/// A client of `provider`: its key, the network profile it is routed to (direct on the
/// default profile when it bypasses the proxy) and the price table.
fn provider_client(
    settings: &Settings,
    provider: &AiProvider,
    key: Option<String>,
    passwords: annalo_core::network::Passwords<'_>,
) -> Result<AiClient> {
    let net = network::effective(&settings.network);
    let service = provider.service();
    let http = annalo_core::network::client_for(&net, passwords, &service)?;
    let mut client = AiClient::for_provider(provider.clone(), key, http);
    client.prices = PriceTable::from_rules(&settings.prices, &provider.id);
    client.request_timeout = net.timeout_for(&service);
    Ok(client)
}

/// The proxy passwords of the profiles, as the clients look them up.
fn proxy_passwords(state: &AppState) -> impl Fn(&str) -> Option<String> + '_ {
    |id| network::secret(state, id).get()
}

/// The stored keys of `providers`, by id.
fn provider_keys(data_dir: &std::path::Path, providers: &[AiProvider]) -> HashMap<String, String> {
    providers.iter().filter_map(|p| SecretStore::provider(data_dir, &p.id).get().map(|k| (p.id.clone(), k))).collect()
}

impl AiRuntime {
    fn new(settings: Settings, keys: &HashMap<String, String>, proxy_passwords: &HashMap<String, String>) -> Self {
        for k in keys.values().chain(proxy_passwords.values()) {
            devlog::remember_secret(Some(k));
        }
        let passwords = |id: &str| proxy_passwords.get(id).cloned();
        let mut network_error = None;
        let mut failed = |e: Error| {
            let msg = trf!(
                "Netzwerkeinstellungen ungültig: {e} (Einstellungen → Netzwerk)",
                "Network settings invalid: {e} (Settings → Network)"
            );
            devlog::error("net", &msg);
            network_error = Some(msg);
        };
        let _ = network::check(&network::effective(&settings.network)).map_err(&mut failed);
        let mut clients = HashMap::new();
        for p in settings.providers.iter().filter(|p| p.enabled) {
            let key = keys.get(&p.id).cloned();
            match provider_client(&settings, p, key, &passwords) {
                Ok(client) => {
                    clients.insert(p.id.clone(), Arc::new(client));
                }
                Err(e) => failed(e),
            }
        }
        let router = Arc::new(ModelRouter::new(settings.router.clone()));
        AiRuntime { clients, router, http: Mutex::new(HashMap::new()), network_error, settings }
    }
}

/// Rebuilds the AI runtime (clients, router) from `settings` and the stored secrets.
pub(crate) fn rebuild_ai(state: &AppState, settings: Settings) {
    let keys = provider_keys(&state.data_dir, &settings.providers);
    let rt = AiRuntime::new(settings.clone(), &keys, &network::passwords_of(&state.data_dir, &settings.network));
    *state.ai.write().unwrap_or_else(|e| e.into_inner()) = rt;
    // Another server or key may offer other models, and a fixed server gets another chance.
    lock(&state.server_models).clear();
    lock(&state.caps).clear();
}

/// When a provider was asked for its models, and the answer (`None` = it could not be asked).
type ModelList = (Instant, Option<Vec<String>>);

pub struct AppState {
    db: Mutex<Database>,
    /// Read-only connections for commands that only read (WAL: they see the last committed
    /// state and neither wait for a save nor hold one up); several, so one long read (the task
    /// list, the graph) does not hold up the small reads of a page switch. Empty when they could
    /// not be opened; reads then use `db`. Never held while taking `db`, or the other way round.
    readers: Vec<Mutex<Database>>,
    /// The reader to wait for when all are busy (round robin).
    next_reader: AtomicUsize,
    ai: RwLock<AiRuntime>,
    secrets: SecretStore,
    /// Access token of the Git sync.
    git_secret: SecretStore,
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
    /// Models each provider offers, by provider id: when asked, and the names (`None` = it could
    /// not be asked). Cleared whenever the clients are rebuilt.
    server_models: Mutex<HashMap<String, ModelList>>,
    /// What this session learned about the models: embedding support, rejected parameters.
    /// Cleared whenever the clients are rebuilt.
    caps: Mutex<Capabilities>,
}

/// Read-only connections of [`AppState`].
const READERS: usize = 3;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock leaves SQLite consistent (transactions roll back).
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl AppState {
    fn db(&self) -> MutexGuard<'_, Database> {
        lock(&self.db)
    }
    /// The connection for commands that only read (see [`AppState::reader`]).
    fn reader(&self) -> MutexGuard<'_, Database> {
        if self.readers.is_empty() {
            return lock(&self.db);
        }
        for r in &self.readers {
            match r.try_lock() {
                Ok(g) => return g,
                Err(std::sync::TryLockError::Poisoned(e)) => return e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => {}
            }
        }
        lock(&self.readers[self.next_reader.fetch_add(1, Ordering::Relaxed) % self.readers.len()])
    }
    /// A fresh read-only connection for one long read (Markdown mirror, export, backup), so
    /// neither connection above is held meanwhile; `None` falls back to the main one.
    fn snapshot_db(&self) -> Option<Database> {
        Database::open_read_only(self.data_dir.join(datadir::DB_FILE)).ok()
    }
    fn settings(&self) -> Settings {
        self.ai.read().unwrap_or_else(|e| e.into_inner()).settings.clone()
    }
    /// The client of the provider `id` (`""` = the first one); an error when it is missing or off.
    fn client_for(&self, id: &str) -> Result<Arc<AiClient>> {
        let ai = self.ai.read().unwrap_or_else(|e| e.into_inner());
        let id = match id {
            "" => ai.settings.providers.iter().find(|p| p.enabled).map(|p| p.id.as_str()).unwrap_or_default(),
            id => id,
        };
        ai.clients.get(id).cloned().ok_or_else(|| match &ai.network_error {
            Some(e) => Error::State(e.clone()),
            None => Error::State(trf!(
                "Der KI-Anbieter „{id}“ ist nicht eingerichtet oder ausgeschaltet (Einstellungen → KI & Modelle)",
                "The AI provider “{id}” is not set up or is switched off (Settings → AI & models)"
            )),
        })
    }
    /// The clients of the switched-on providers, in the order of the settings.
    fn clients(&self) -> Vec<(String, Arc<AiClient>)> {
        let ai = self.ai.read().unwrap_or_else(|e| e.into_inner());
        ai.settings.providers.iter().filter_map(|p| ai.clients.get(&p.id).map(|c| (p.id.clone(), c.clone()))).collect()
    }
    /// The credential of the provider `id`.
    fn provider_secret(&self, id: &str) -> SecretStore {
        SecretStore::provider(&self.data_dir, id)
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

// Commands that touch the database run off the main thread (`async`): the main thread
// handles the window (title, focus, drag), which must never wait for the database.

#[tauri::command(async)]
fn workspace_tree(state: State<AppState>) -> Result<Vec<PageNode>> {
    state.reader().page_tree()
}

#[tauri::command(async)]
fn page_get(state: State<AppState>, id: i64) -> Result<PageDoc> {
    state.reader().page_doc(id)
}

/// What `![[target#anchor]]` shows: the page, its section or block (see `annalo_core::embeds`).
#[tauri::command(async)]
fn page_embed(
    state: State<AppState>,
    target: String,
    anchor: Option<String>,
) -> Result<annalo_core::embeds::EmbedView> {
    state.reader().page_embed(&target, anchor.as_deref())
}

/// Saves a page. Returns tags, unresolved links and the new time only: the caller has the
/// content, and a save does not change the page's backlinks.
#[tauri::command(async)]
fn page_save(state: State<AppState>, id: i64, content: String) -> Result<SavedPage> {
    state.db().save_page(id, &content)
}

// ---------------------------------------------------------------- typed properties

/// The child pages of a page with their frontmatter (table and board views).
#[tauri::command(async)]
fn page_collection(state: State<AppState>, parent_id: i64) -> Result<properties::CollectionView> {
    state.reader().page_collection_view(parent_id)
}

/// The schema a page's properties follow (its parent's) and the parent's id.
#[tauri::command(async)]
fn page_schema(state: State<AppState>, page_id: i64) -> Result<Option<(i64, properties::Schema)>> {
    state.db().page_schema(page_id)
}

/// Names for person properties: person values and `@mentions`, most used first.
#[tauri::command(async)]
fn known_persons(state: State<AppState>) -> Result<Vec<String>> {
    state.reader().known_persons()
}

// ---------------------------------------------------------------- versions

#[tauri::command(async)]
fn page_versions(state: State<AppState>, page_id: i64) -> Result<Vec<VersionInfo>> {
    state.reader().list_versions(page_id)
}

#[tauri::command(async)]
fn page_version_content(state: State<AppState>, version_id: i64) -> Result<String> {
    state.db().version_content(version_id)
}

/// Snapshots the page now („Jetzt Version sichern“); `None` when nothing changed.
#[tauri::command(async)]
fn page_snapshot(state: State<AppState>, page_id: i64) -> Result<Option<i64>> {
    state.db().snapshot_page(page_id)
}

#[tauri::command(async)]
fn page_version_restore(state: State<AppState>, page_id: i64, version_id: i64) -> Result<PageDoc> {
    let db = state.db();
    db.restore_version(page_id, version_id)?;
    db.page_doc(page_id)
}

#[tauri::command(async)]
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
pub(crate) fn unique_title(db: &Database, title: &str) -> Result<String> {
    let base = annalo_core::notes::clean_title(title);
    let mut name = base.clone();
    let mut n = 2;
    while db.page_by_title(&name)?.is_some() {
        name = format!("{base} {n}");
        n += 1;
    }
    Ok(name)
}

#[tauri::command(async)]
fn page_rename(state: State<AppState>, id: i64, title: String, update_links: bool) -> Result<usize> {
    let db = state.db();
    // `[ ] | # ^` are replaced (see `notes::clean_title`); the UI applies the same rule while typing.
    let title = annalo_core::notes::clean_title(&title);
    if let Some(other) = db.page_by_title(&title)?
        && other.id != id
    {
        return Err(Error::State(trf!("Eine Seite „{}“ existiert bereits", "A page “{}” already exists", other.title)));
    }
    db.rename_page_linked(id, &title, update_links)
}

/// Moves a page and its subpages to the trash. Returns the number of pages moved.
#[tauri::command(async)]
fn page_delete(state: State<AppState>, id: i64) -> Result<usize> {
    state.db().trash_page(id)
}

#[tauri::command(async)]
fn page_restore(state: State<AppState>, id: i64) -> Result<Page> {
    state.db().restore_page(id)
}

#[tauri::command(async)]
fn page_purge(state: State<AppState>, id: i64) -> Result<usize> {
    state.db().purge_page(id)
}

#[tauri::command(async)]
fn trash_list(state: State<AppState>) -> Result<Vec<TrashEntry>> {
    state.db().list_trash()
}

#[tauri::command(async)]
fn trash_empty(state: State<AppState>) -> Result<usize> {
    state.db().empty_trash()
}

#[tauri::command(async)]
fn page_move(state: State<AppState>, id: i64, parent_id: Option<i64>, position: i64) -> Result<()> {
    state.db().move_page(id, parent_id, position)
}

#[tauri::command(async)]
fn page_set_favorite(state: State<AppState>, id: i64, favorite: bool) -> Result<()> {
    state.db().set_favorite(id, favorite)
}

#[tauri::command(async)]
fn page_set_icon(state: State<AppState>, id: i64, icon: Option<String>) -> Result<()> {
    state.db().set_page_icon(id, icon.as_deref())
}

/// Resolves a [[link]] target; with `create`, a missing page is created at the top level.
#[tauri::command(async)]
fn page_resolve(state: State<AppState>, title: String, create: bool) -> Result<Option<Page>> {
    let db = state.db();
    match db.page_by_title(&title)? {
        Some(p) => Ok(Some(p)),
        None if create => Ok(Some(db.create_page(None, &title, Some("file-text"))?)),
        None => Ok(None),
    }
}

#[tauri::command(async)]
fn recent_pages(state: State<AppState>, limit: usize) -> Result<Vec<Page>> {
    state.reader().recent_pages(limit)
}

#[tauri::command(async)]
fn daily_note(state: State<AppState>, date: Option<NaiveDate>) -> Result<Page> {
    state.db().daily_note(date.unwrap_or_else(|| Local::now().date_naive()))
}

/// Per day `from..=to` (local): daily note, booked minutes and open tasks due, for the calendar.
#[tauri::command(async)]
fn daily_overview(state: State<AppState>, from: NaiveDate, to: NaiveDate) -> Result<Vec<DayOverview>> {
    calendar::daily_overview(&state.reader(), from, to, &Local)
}

#[tauri::command(async)]
fn tags_list(state: State<AppState>) -> Result<Vec<(String, i64)>> {
    state.reader().tag_counts()
}

#[tauri::command(async)]
fn tag_pages(state: State<AppState>, tag: String) -> Result<Vec<Page>> {
    state.reader().pages_with_tag(&tag)
}

#[tauri::command(async)]
fn tasks_list(state: State<AppState>, filter: Option<TaskFilter>) -> Result<Vec<Task>> {
    state.reader().list_tasks(&filter.unwrap_or_default())
}

/// Checks or unchecks one task in its page's Markdown; the UI then reloads open editors of that page.
#[tauri::command(async)]
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

#[tauri::command(async)]
fn search_workspace(state: State<AppState>, query: String, limit: Option<usize>) -> Result<Vec<SearchHit>> {
    search::search(&state.reader(), &query, limit.unwrap_or(30))
}

/// Set by `vault_import_cancel`; the running import stops at the next file.
static VAULT_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Imports a vault off the main thread: the files are read (and attachments copied) without
/// the database lock, with `vault://progress` events; only creating the pages takes the lock.
#[tauri::command]
async fn vault_import(app: AppHandle, path: String) -> Result<ImportReport> {
    let dir = PathBuf::from(&path);
    if !dir.is_dir() {
        return Err(Error::State(trf!("„{path}“ ist kein Ordner", "“{path}” is not a folder")));
    }
    VAULT_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let mut progress = |p: vault::ImportProgress| {
            let _ = app.emit("vault://progress", p);
        };
        let plan = vault::plan_import(&dir, &state.attachments_dir(), &mut progress, &VAULT_CANCEL)?;
        let report = vault::apply_import(&state.db(), plan)?;
        for w in &report.warnings {
            devlog::warn("import", w);
        }
        Ok(report)
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

/// The operating system's locale (`de-DE`, `en-US` …): the language the first run suggests.
#[tauri::command]
fn os_locale() -> Option<String> {
    // Tests and support: ANNALO_LOCALE stands in for the system's.
    std::env::var("ANNALO_LOCALE").ok().filter(|l| !l.trim().is_empty()).or_else(sys_locale::get_locale)
}

#[tauri::command]
fn vault_import_cancel() {
    VAULT_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
}

/// Exports off the main thread; the pages are read at once through a connection of its own,
/// then the files are written without holding the database.
#[tauri::command]
async fn vault_export(app: AppHandle, path: String) -> Result<usize> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let snap = match state.snapshot_db() {
            Some(db) => db.read_snapshot(vault::VaultSnapshot::read)?,
            None => vault::VaultSnapshot::read(&state.db())?,
        };
        vault::export_snapshot(&snap.for_export(), &PathBuf::from(path), &state.attachments_dir())
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

// ------------------------------------------------------------- templates

fn template_vars(title: &str) -> TemplateVars {
    let now = Local::now();
    TemplateVars { date: now.date_naive(), time: now.time(), title: title.trim().to_owned() }
}

/// Pages below „Vorlagen“.
#[tauri::command(async)]
fn templates_list(state: State<AppState>) -> Result<Vec<Page>> {
    state.reader().list_templates()
}

/// The „Vorlagen“ page, created on first use.
#[tauri::command(async)]
fn templates_root(state: State<AppState>) -> Result<Page> {
    state.db().templates_root()
}

/// Markdown of a template with its placeholders filled in.
#[tauri::command(async)]
fn template_render(state: State<AppState>, id: i64, title: Option<String>) -> Result<String> {
    state.db().render_template(id, &template_vars(title.as_deref().unwrap_or("")))
}

#[tauri::command(async)]
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
    let saved = attachments::save(&state.attachments_dir(), &bytes, &name, mime.as_deref().unwrap_or(""))?;
    feed::file_added(&state, &saved.name);
    Ok(saved)
}

/// Header with the percent-encoded file name of [`attachment_store`] (header values are ASCII).
const NAME_HEADER: &str = "x-annalo-name";

/// Stores a dropped or pasted file under its own (sanitized) name. The body is the raw file
/// (no base64 round trip for files up to 100 MB), the name comes in [`NAME_HEADER`].
/// Async, so hashing and writing a large file does not block the main thread.
#[tauri::command]
async fn attachment_store(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Result<SavedAttachment> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(Error::State("Dateiinhalt fehlt".into()));
    };
    let name = request
        .headers()
        .get(NAME_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(attachments::percent_decode)
        .ok_or_else(|| Error::State("Dateiname fehlt".into()))?;
    let saved = attachments::store_file(&state.attachments_dir(), &name, bytes)?;
    feed::file_added(&state, &saved.name);
    Ok(saved)
}

/// Copies a file chosen in the file dialog into the attachments folder (streamed, by path).
#[tauri::command]
async fn attachment_import(state: State<'_, AppState>, path: String) -> Result<SavedAttachment> {
    let dir = state.attachments_dir();
    let saved =
        tauri::async_runtime::spawn_blocking(move || attachments::import_file(&dir, std::path::Path::new(&path)))
            .await
            .map_err(|e| Error::State(e.to_string()))??;
    feed::file_added(&state, &saved.name);
    Ok(saved)
}

/// The bytes of an attachment as a raw IPC response (PDF preview and viewer).
#[tauri::command]
async fn attachment_read(state: State<'_, AppState>, name: String) -> Result<tauri::ipc::Response> {
    let path = attachments::existing(&state.attachments_dir(), &name)?;
    if std::fs::metadata(&path).at(&path)?.len() > attachments::MAX_FILE_BYTES {
        return Err(Error::State(trf!(
            "„{name}“ ist zu groß für die Vorschau",
            "“{name}” is too large for the preview"
        )));
    }
    Ok(tauri::ipc::Response::new(std::fs::read(&path).at(&path)?))
}

/// Size in bytes of an attachment, `None` when the file is missing (file chips).
#[tauri::command]
fn attachment_size(state: State<AppState>, name: String) -> Option<u64> {
    attachments::resolve(&state.attachments_dir(), &name).and_then(|p| std::fs::metadata(p).ok()).map(|m| m.len())
}

/// Title of the web page `url` for a pasted link (smart paste), through the client with the
/// network settings; the URL itself when there is none or the page cannot be read.
#[tauri::command]
async fn link_title(state: State<'_, AppState>, url: String) -> Result<String> {
    let Ok(http) = network::client_for(&state, &Service::LinkPreview) else {
        return Ok(url);
    };
    match annalo_core::linktitle::fetch_title(&http, &url).await {
        Ok(Some(title)) => Ok(title),
        Ok(None) => Ok(url),
        Err(_) => {
            // Without the error: it carries the URL, which may hold a token.
            devlog::debug("net", "link title not available");
            Ok(url)
        }
    }
}

/// Writes a page shared as one HTML file (the path comes from the save dialog).
#[tauri::command]
fn html_file_write(path: String, html: String) -> Result<()> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "html" && ext != "htm" {
        return Err(Error::State(
            tr!("Nur .html-Dateien können so gespeichert werden", "Only .html files can be saved this way").into(),
        ));
    }
    std::fs::write(p, html).at(p)?;
    Ok(())
}

/// Writes an exported diagram (`.svg` or `.png`, from a Mermaid block) to `path`.
#[tauri::command(async)]
fn diagram_file_write(path: String, data: Vec<u8>) -> Result<()> {
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "svg" && ext != "png" {
        return Err(Error::State(
            tr!(
                "Nur .svg- und .png-Dateien können so gespeichert werden",
                "Only .svg and .png files can be saved this way"
            )
            .into(),
        ));
    }
    std::fs::write(p, data).at(p)?;
    Ok(())
}

/// Opens a file of the attachments folder in its default app, or shows it in the file
/// manager (`reveal`). Only names inside that folder are accepted. Programs and scripts are
/// always only shown in the file manager, never started.
#[tauri::command]
fn attachment_open(app: AppHandle, state: State<AppState>, name: String, reveal: bool) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let path = attachments::existing(&state.attachments_dir(), &name)?;
    let opened = if reveal || attachments::is_executable(&name) {
        app.opener().reveal_item_in_dir(&path)
    } else {
        app.opener().open_path(path.display().to_string(), None::<&str>)
    };
    opened.map_err(|e| Error::State(trf!("„{name}“ ließ sich nicht öffnen: {e}", "“{name}” could not be opened: {e}")))
}

/// Creates an empty drawing (`<title>.excalidraw`) and returns its `![[name]]` embed.
#[tauri::command]
fn drawing_create(state: State<AppState>, title: String) -> Result<SavedAttachment> {
    let saved = drawings::create(&state.attachments_dir(), &title)?;
    feed::file_added(&state, &saved.name);
    Ok(saved)
}

/// The Excalidraw scene (JSON) of a drawing.
#[tauri::command]
fn drawing_read(state: State<AppState>, name: String) -> Result<String> {
    drawings::read(&state.attachments_dir(), &name)
}

/// Stores a drawing's scene and its SVG preview (none for an empty drawing).
#[tauri::command]
fn drawing_save(state: State<AppState>, name: String, scene: String, svg: Option<String>) -> Result<()> {
    drawings::save(&state.attachments_dir(), &name, &scene, svg.as_deref())
}

/// Decodes base64 (optionally a `data:` URL, possibly line-wrapped). Oversized input is
/// rejected before anything is decoded, so a huge paste cannot allocate the decoded bytes.
fn decode_attachment(data: &str) -> Result<Vec<u8>> {
    let b64 = if data.starts_with("data:") { data.split_once(',').map_or("", |(_, d)| d) } else { data };
    let len = b64.bytes().filter(|b| !b.is_ascii_whitespace()).count();
    if len > attachments::MAX_BYTES.div_ceil(3) * 4 + 4 {
        return Err(Error::State(trf!(
            "Datei ist größer als {} MB",
            "The file is larger than {} MB",
            attachments::MAX_BYTES / 1024 / 1024
        )));
    }
    let compact: String = b64.chars().filter(|c| !c.is_ascii_whitespace()).collect();
    base64::engine::general_purpose::STANDARD
        .decode(compact)
        .map_err(|e| Error::Parse(trf!("Ungültige Bilddaten: {e}", "Invalid image data: {e}")))
}

/// Serves `annalo-asset://localhost/<name>`: only plain file names inside the attachments folder.
fn serve_attachment(app: &AppHandle, request: &tauri::http::Request<Vec<u8>>) -> tauri::http::Response<Vec<u8>> {
    let respond = |status: u16, mime: &str, body: Vec<u8>| {
        tauri::http::Response::builder()
            .status(status)
            .header("Content-Type", mime)
            .header("X-Content-Type-Options", "nosniff")
            // SVGs are images here, never documents that run scripts. Drawing previews
            // (Excalidraw) carry their fonts inline as `data:` URLs.
            .header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; font-src data:")
            .body(body)
            .unwrap_or_default()
    };
    let Some(state) = app.try_state::<AppState>() else { return respond(503, "text/plain", vec![]) };
    let raw = request.uri().path().trim_start_matches('/');
    let found = attachments::percent_decode(raw).and_then(|name| attachments::resolve(&state.attachments_dir(), &name));
    match found.map(|p| (std::fs::read(&p), p)) {
        Some((Ok(bytes), p)) => {
            let mime = attachments::mime_for(&p.to_string_lossy());
            // Audio players (voice notes) ask for ranges to seek; WebView2 needs them for that.
            let range = request
                .headers()
                .get("range")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| attachments::byte_range(v, bytes.len() as u64));
            match range {
                Some((from, to)) => {
                    let total = bytes.len();
                    let mut res = respond(206, mime, bytes[from as usize..=to as usize].to_vec());
                    let h = res.headers_mut();
                    if let Ok(v) = format!("bytes {from}-{to}/{total}").parse() {
                        h.insert("Content-Range", v);
                    }
                    h.insert("Accept-Ranges", tauri::http::HeaderValue::from_static("bytes"));
                    res
                }
                None => {
                    let mut res = respond(200, mime, bytes);
                    res.headers_mut().insert("Accept-Ranges", tauri::http::HeaderValue::from_static("bytes"));
                    res
                }
            }
        }
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
#[tauri::command(async)]
fn wbs_tree(state: State<AppState>) -> Result<Vec<ProjectTree>> {
    let db = state.reader();
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
    if v.is_empty() { Err(Error::State(trf!("{what} fehlt", "{what} is missing"))) } else { Ok(v.to_owned()) }
}

#[tauri::command(async)]
fn project_create(state: State<AppState>, code: String, name: String) -> Result<Project> {
    state
        .db()
        .create_project(&required(&code, tr!("Projekt-ID", "Project ID"))?, &required(&name, tr!("Name", "Name"))?)
}

#[tauri::command(async)]
fn project_update(state: State<AppState>, id: i64, name: String) -> Result<()> {
    state.db().update_project(id, &required(&name, tr!("Name", "Name"))?)
}

#[tauri::command(async)]
fn project_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_project(id)
}

#[tauri::command(async)]
fn netzplan_create(
    state: State<AppState>,
    project_id: i64,
    netzplan_nr: String,
    wbs_element: String,
    description: String,
    planned_hours: f64,
) -> Result<Netzplan> {
    let nr = required(&netzplan_nr, tr!("Netzplan-Nr.", "Network no."))?;
    let wbs = if wbs_element.trim().is_empty() { nr.clone() } else { wbs_element.trim().to_owned() };
    state.db().create_netzplan(project_id, &nr, &wbs, description.trim(), planned_hours.max(0.0))
}

#[tauri::command(async)]
fn netzplan_update(
    state: State<AppState>,
    id: i64,
    wbs_element: String,
    description: String,
    planned_hours: f64,
) -> Result<()> {
    state.db().update_netzplan(id, &wbs_element, &description, planned_hours.max(0.0))
}

#[tauri::command(async)]
fn netzplan_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_netzplan(id)
}

/// Adds a Vorgang; `predecessors` are Vorgang numbers of the same Netzplan.
#[tauri::command(async)]
fn vorgang_create(
    state: State<AppState>,
    netzplan_id: i64,
    vorgang_nr: String,
    description: String,
    duration_days: f64,
    planned_hours: f64,
    predecessors: Vec<String>,
) -> Result<Vorgang> {
    let nr = required(&vorgang_nr, tr!("Vorgangsnummer", "Activity number"))?;
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

#[tauri::command(async)]
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

#[tauri::command(async)]
fn vorgang_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_vorgang(id)
}

#[tauri::command(async)]
fn leistungsarten_list(state: State<AppState>) -> Result<Vec<(String, String)>> {
    state.reader().list_leistungsarten()
}

#[tauri::command(async)]
fn leistungsart_save(state: State<AppState>, code: String, description: String) -> Result<()> {
    state.db().upsert_leistungsart(&code, &description)
}

#[tauri::command(async)]
fn leistungsart_delete(state: State<AppState>, code: String) -> Result<()> {
    state.db().delete_leistungsart(&code)
}

// ---------------------------------------------------------- time tracking

#[tauri::command(async)]
fn log_time(app: AppHandle, state: State<AppState>, line: String, page_id: Option<i64>) -> Result<LogOutcome> {
    let settings = state.settings();
    settings.require_time_tracking()?;
    let t = settings.thresholds;
    let out = {
        let db = state.db();
        // Typed on a page linked to a Vorgang: `/zeit 1.5h …` books on that Vorgang.
        let default_ref = page_id.map(|id| db.page_reference(id)).transpose()?.flatten();
        let ctx = tracking::SlashContext { default_ref: default_ref.as_deref(), page_id };
        tracking::log_slash_command_in(&db, &line, Utc::now(), &Local, &t, ctx)?
    };
    // Booked with an issue key: its Jira worklog (when the site logs work) goes out now.
    if out.issue.is_some() {
        jira::kick_worklogs(app);
    }
    Ok(out)
}

/// Budget and bookings of the Vorgang a page is linked to (`vorgang:` property).
#[tauri::command(async)]
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

#[tauri::command(async)]
fn timer_status(state: State<AppState>) -> Result<Option<TimerStatus>> {
    let running = state.reader().running_timer()?;
    let idle = lock(&state.idle);
    Ok(running.map(|entry| TimerStatus { entry, idle_minutes: idle.idle_minutes(Utc::now()), is_idle: idle.is_idle() }))
}

#[tauri::command(async)]
fn timer_start(
    app: AppHandle,
    state: State<AppState>,
    netzplan_id: i64,
    vorgang_nr: Option<String>,
    leistungsart: Option<String>,
    description: String,
) -> Result<TimeEntry> {
    state.settings().require_time_tracking()?;
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
#[tauri::command(async)]
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

#[tauri::command(async)]
fn timer_discard(app: AppHandle, state: State<AppState>) -> Result<()> {
    state.db().discard_timer()?;
    let _ = app.emit("data://entries", ());
    desktop::refresh_tray(&app);
    Ok(())
}

#[tauri::command(async)]
fn time_entries(
    state: State<AppState>,
    from: Option<DateTime<Utc>>,
    to: Option<DateTime<Utc>>,
) -> Result<Vec<TimeEntryRow>> {
    // Without a range: the last year, not years of entries (megabytes) nobody looks at at once.
    let from = from.or_else(|| to.is_none().then(|| Utc::now() - chrono::TimeDelta::days(DEFAULT_ENTRY_DAYS)));
    state.reader().list_time_entries(&EntryFilter { from, to, ..Default::default() })
}

/// Days of entries `time_entries` returns when asked without any range.
const DEFAULT_ENTRY_DAYS: i64 = 366;

#[tauri::command(async)]
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
        return Err(Error::State(
            tr!(
                "Dauer muss zwischen 1 Minute und 24 Stunden liegen",
                "The duration must be between 1 minute and 24 hours"
            )
            .into(),
        ));
    }
    let settings = state.settings();
    settings.require_time_tracking()?;
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
    Ok(LogOutcome { entry, alerts, reference, issue: None })
}

#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
fn time_entry_update(
    app: AppHandle,
    state: State<AppState>,
    id: i64,
    vorgang_nr: Option<String>,
    leistungsart: Option<String>,
    start_time: DateTime<Utc>,
    duration_minutes: i64,
    description: String,
) -> Result<TimeEntry> {
    let before = state.reader().time_entry(id)?;
    let after = state.db().update_time_entry(
        id,
        vorgang_nr.as_deref().filter(|v| !v.is_empty()),
        leistungsart.as_deref().filter(|v| !v.is_empty()),
        start_time,
        duration_minutes,
        &description,
    )?;
    // Posted to Jira: the worklog follows a new duration, start or comment.
    jira::after_entry_edit(&app, &before, &after);
    Ok(after)
}

#[tauri::command(async)]
fn set_entry_status(state: State<AppState>, ids: Vec<i64>, status: StatusFlag) -> Result<usize> {
    state.db().set_entry_status(&ids, status)
}

#[tauri::command(async)]
fn delete_time_entry(app: AppHandle, state: State<AppState>, id: i64) -> Result<()> {
    // Posted to Jira: the worklog goes too.
    if jira::delete_entry(&state, id)? {
        jira::kick_worklogs(app);
    }
    Ok(())
}

#[tauri::command(async)]
fn budget(state: State<AppState>, netzplan_id: i64) -> Result<Vec<BudgetStatus>> {
    let t = state.settings().thresholds;
    tracking::budget_status(&state.reader(), netzplan_id, &t)
}

#[tauri::command(async)]
fn schedule(state: State<AppState>, netzplan_id: i64) -> Result<Schedule> {
    netzplan::schedule(&state.reader().list_vorgaenge(netzplan_id)?)
}

/// Budget and schedule of every Netzplan (Projekte), instead of two calls per Netzplan.
#[tauri::command(async)]
fn netzplan_overview(state: State<AppState>) -> Result<Vec<tracking::NetzplanOverview>> {
    let t = state.settings().thresholds;
    tracking::netzplan_overview(&state.reader(), &t, true)
}

/// The budget rows of every Netzplan (dashboard, `/zeit` completion) in one call.
#[tauri::command(async)]
fn budgets_all(state: State<AppState>) -> Result<Vec<BudgetStatus>> {
    let t = state.settings().thresholds;
    tracking::all_budgets(&state.reader(), &t)
}

/// What the assistant's suggestions are built from, counted in the database.
#[derive(Serialize)]
struct SuggestionFacts {
    open_tasks: i64,
    overdue: i64,
    due_today: i64,
    /// Open tasks on `page_id` (0 without one).
    page_open_tasks: i64,
    /// Label of the most critical budget that is not OK (`NP-8801/1020`).
    worst_budget: Option<String>,
}

/// Counts of open tasks (`today` is the local day, `YYYY-MM-DD`) and the most critical budget.
#[tauri::command(async)]
fn suggestion_facts(state: State<AppState>, today: String, page_id: Option<i64>) -> Result<SuggestionFacts> {
    let settings = state.settings();
    let t = settings.thresholds;
    let db = state.reader();
    let counts = db.open_task_counts(today.trim(), page_id)?;
    // Time tracking off: no budget hint.
    let budgets = if settings.time_tracking() { tracking::all_budgets(&db, &t)? } else { vec![] };
    Ok(SuggestionFacts {
        open_tasks: counts.open,
        overdue: counts.overdue,
        due_today: counts.due_today,
        page_open_tasks: counts.on_page,
        worst_budget: tracking::worst_budget(&budgets).map(|b| b.label.clone()),
    })
}

#[tauri::command(async)]
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
        std::fs::write(&p, &res.content).at(&p)?;
    }
    if mark_exported {
        db.set_entry_status(&res.exported_ids, StatusFlag::Exported)?;
    }
    Ok(res)
}

// ----------------------------------------------------------------- backups

/// Backs up; the flag tells whether the Markdown mirror was refreshed as well.
fn run_backup(app: &AppHandle) -> Result<(BackupInfo, bool)> {
    let _running = lock(&BACKUP_RUNNING);
    let res = backup_once(app);
    match &res {
        Ok((info, _)) => devlog::debug("backup", format!("backup written: {}", info.path)),
        Err(e) => devlog::error("backup", e.detail()),
    }
    res
}

#[tracing::instrument(name = "backup", skip_all, fields(source = "backup"))]
fn backup_once(app: &AppHandle) -> Result<(BackupInfo, bool)> {
    let state = app.state::<AppState>();
    let dir = state.backup_dir();
    let keep = state.settings().backup_keep;
    // `VACUUM INTO` through a connection of its own: saves are not held up by the snapshot.
    let info = match state.snapshot_db() {
        Some(db) => backup::backup_to(&db, &dir, keep)?,
        None => backup::backup_to(&state.db(), &dir, keep)?,
    };
    feed::record(&state, "backup", &info.file_name, "");
    // Attachments live next to the database: new files and changed ones (a drawing saved again)
    // are copied, nothing is deleted.
    let src = state.attachments_dir();
    if src.is_dir() {
        let act = annalo_core::backupdest::Activity::new(None);
        annalo_core::backupdest::sync_files(&src, &dir.join("attachments"), &act)?;
    }
    let mut mirror_fresh = false;
    if state.settings().markdown_mirror {
        // The backup itself succeeded; a failed mirror is reported in the settings, not as a failed backup.
        // Mirror and Git sync never run at the same time (both use the mirror folder).
        let _running = lock(&state.git_lock);
        match run_mirror(&state) {
            Ok(_) => mirror_fresh = true,
            Err(e) => devlog::error("backup", format!("markdown mirror failed: {e}")),
        }
    }
    // Copies to network and cloud folders follow in the background.
    backupdest::backup_written(app, &info);
    let gs = state.settings().git_sync;
    if gs.enabled && gs.mode == SyncMode::WithBackup && !gs.remote_url.is_empty() {
        // Like the mirror, a failed sync does not fail the backup (reported via event, status and log).
        let _ = run_git_sync(app, mirror_fresh, false);
    }
    Ok((info, mirror_fresh))
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
/// `allow_deletions`: the user confirmed a commit that deletes many notes.
#[tracing::instrument(name = "git_sync", skip(app), fields(source = "git"))]
pub(crate) fn run_git_sync(app: &AppHandle, mirror_fresh: bool, allow_deletions: bool) -> Result<SyncOutcome> {
    let state = app.state::<AppState>();
    let _running = lock(&state.git_lock);
    let settings = state.settings();
    let token = state.git_secret.get();
    devlog::remember_secret(token.as_deref());
    // Notes with an open conflict keep the server's version until merged.
    let hold = syncmerge::hold_paths(&state.db());
    // The settings file, when the settings are synced too.
    let settings_file = if settings.git_sync.sync_settings {
        match state.db().settings_sync_file(&gitsync::hostname()) {
            Ok(f) => Some(f),
            Err(e) => {
                devlog::warn("settings", format!("settings file for the sync not written: {e}"));
                None
            }
        }
    } else {
        None
    };
    let res = (|| {
        let source = state.git_source_dir();
        if settings.markdown_mirror {
            if !mirror_fresh {
                run_mirror(&state)?;
            }
        } else {
            mirror::write_snapshot(&mirror_snapshot(&state)?, &source, &state.attachments_dir(), &Local)?;
        }
        let database = if settings.git_sync.include_database {
            backup::list_backups(&state.backup_dir())?.into_iter().next().map(|b| PathBuf::from(b.path))
        } else {
            None
        };
        let git = network::git(&state, token.clone(), &settings.git_sync.remote_url);
        // Locks of a git that was stopped (timeout, crash) would block every sync from now on.
        for lock in gitsync::remove_stale_locks(&state.git_repo_dir(), gitsync::DEFAULT_TIMEOUT) {
            devlog::warn("git", format!("removed a stale git lock: {}", lock.display()));
        }
        gitsync::sync(
            &git,
            &SyncRequest {
                repo: &state.git_repo_dir(),
                source: &source,
                database: database.as_deref(),
                settings: &settings.git_sync,
                host: &gitsync::hostname(),
                now: Local::now(),
                hold: &hold,
                allow_deletions,
                settings_file: settings_file.clone(),
            },
        )
    })();
    if let Ok(out) = &res
        && !out.remote_changes.is_empty()
    {
        take_over_pulled(app, &state, out);
    }
    if let Ok(SyncOutcome { settings_file: Some(text), .. }) = &res {
        take_over_settings(app, text);
    }
    let db = state.db();
    match &res {
        Ok(out) => {
            drop(db);
            feed::record(&state, "sync", &out.branch, out.commit.as_deref().unwrap_or(""));
            let db = state.db();
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

/// Takes over the notes a sync pulled from the server (and the attachments they embed) and
/// tells the UI (`gitsync://pulled`: pages to reload, conflicts to show).
fn take_over_pulled(app: &AppHandle, state: &AppState, out: &SyncOutcome) {
    let pulled = syncmerge::apply(&state.db(), &out.remote_changes, Local::now());
    match pulled {
        Ok(p) => {
            // For the start page's „Per Git-Sync geändert“.
            use annalo_core::dashboard::notes::{PulledChange, record_pulled};
            let changes: Vec<(i64, PulledChange)> = p
                .conflicts
                .iter()
                .map(|id| (*id, PulledChange::Conflict))
                .chain(p.created.iter().map(|id| (*id, PulledChange::Created)))
                .chain(p.trashed.iter().map(|id| (*id, PulledChange::Trashed)))
                .chain(p.pages.iter().map(|id| (*id, PulledChange::Changed)))
                .collect();
            if let Err(e) = record_pulled(&state.db(), &changes, chrono::Utc::now()) {
                devlog::warn("git", format!("pulled pages not recorded for the start page: {e}"));
            }
            let files = state.git_repo_dir().join(attachments::DIR_NAME);
            if files.is_dir()
                && let Err(e) = copy_new_attachments(&files, &state.attachments_dir())
            {
                devlog::warn("git", format!("attachments from the server not copied: {e}"));
            }
            devlog::info(
                "git",
                format!(
                    "pulled from the server: {} changed, {} new, {} trashed, {} conflicts",
                    p.pages.len(),
                    p.created.len(),
                    p.trashed.len(),
                    p.conflicts.len()
                ),
            );
            if !p.kept.is_empty() {
                devlog::warn(
                    "git",
                    format!(
                        "the server deleted {} pages at once: too many, kept here and uploaded again",
                        p.kept.len()
                    ),
                );
            }
            let _ = app.emit("gitsync://pulled", &p);
        }
        Err(e) => devlog::error("git", format!("taking over the server's notes failed: {e}")),
    }
}

/// Syncs now (also when the automatic sync is off, as long as a remote is set).
/// `allow_deletions`: „Löschungen übertragen“ after a sync stopped before deleting many notes.
#[tauri::command]
async fn git_sync_now(app: AppHandle, allow_deletions: Option<bool>) -> Result<SyncOutcome> {
    if app.state::<AppState>().settings().git_sync.remote_url.trim().is_empty() {
        return Err(Error::State(
            tr!("Bitte zuerst die Remote-URL eintragen und speichern", "Enter and save the remote URL first").into(),
        ));
    }
    let allow = allow_deletions.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || run_git_sync(&app, false, allow))
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
        blocked_deletions: last_error.as_deref().and_then(gitsync::guard_count),
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
            return Ok(GitTest {
                ok: false,
                latency_ms: 0,
                branches: vec![],
                error: Some(tr!("Keine Remote-URL", "No remote URL").into()),
            });
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
        let dir = tmp.join(trf!("Git-Import {}", "Git import {}", now.format("%d.%m.%Y")));
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

/// What the Markdown mirror holds, read through a connection of its own (saves go on
/// meanwhile); the main one when that cannot be opened.
fn mirror_snapshot(state: &AppState) -> Result<mirror::MirrorSnapshot> {
    match state.snapshot_db() {
        Some(db) => mirror::MirrorSnapshot::read(&db),
        None => mirror::MirrorSnapshot::read(&state.db()),
    }
}

/// Rebuilds the Markdown mirror and records the outcome (time or error) for the settings.
/// The files are written without holding the database.
fn run_mirror(state: &AppState) -> Result<MirrorReport> {
    let dir = state.mirror_dir();
    let res =
        mirror_snapshot(state).and_then(|snap| mirror::write_snapshot(&snap, &dir, &state.attachments_dir(), &Local));
    let db = state.db();
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

#[tauri::command(async)]
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
        return Err(Error::State(
            tr!(
                "Die Markdown-Kopie wurde noch nicht erstellt – zuerst sichern",
                "The Markdown copy has not been made yet – back up first"
            )
            .into(),
        ));
    }
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| Error::State(e.to_string()))
}

/// Copies regular files from `src` that `dst` lacks. Hidden files and symlinks are skipped;
/// each file is written under a temporary name and renamed, so an interrupted copy never
/// leaves a truncated file that later runs would take as complete.
fn copy_new_attachments(src: &std::path::Path, dst: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(dst).at(dst)?;
    for entry in std::fs::read_dir(src).at(src)?.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else { continue };
        if name_str.starts_with('.') || !entry.file_type().at(entry.path())?.is_file() {
            continue;
        }
        let to = dst.join(&name);
        if to.exists() {
            continue;
        }
        let tmp = dst.join(format!(".{name_str}.part"));
        let copied =
            annalo_core::error::copy_file(&entry.path(), &tmp).and_then(|_| std::fs::rename(&tmp, &to).at(&to));
        if let Err(e) = copied {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    }
    Ok(())
}

/// Async so the snapshot and the Markdown mirror do not block the main (UI) thread.
#[tauri::command]
async fn backup_now(app: AppHandle) -> Result<BackupInfo> {
    tauri::async_runtime::spawn_blocking(move || run_backup(&app).map(|(info, _)| info))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

#[tauri::command(async)]
fn backup_list(state: State<AppState>) -> Result<Vec<BackupInfo>> {
    backup::list_backups(&state.backup_dir())
}

/// Backs up once a day: a few minutes after the start when the newest backup is older than
/// 24 h, then checks hourly. The hourly Git sync (mode `hourly`) runs in the same loop.
fn spawn_backup_scheduler(app: AppHandle) {
    const DAY: chrono::TimeDelta = chrono::TimeDelta::hours(24);
    std::thread::spawn(move || {
        // Not while the app starts and the first notes open (the mirror writes every page).
        std::thread::sleep(startup_backup_delay());
        loop {
            let state = app.state::<AppState>();
            let due = match backup::list_backups(&state.backup_dir()) {
                Ok(list) => list.first().is_none_or(|b| Local::now() - b.created_at >= DAY),
                Err(_) => true,
            };
            // Whether the backup also refreshed the mirror (a failed mirror is written again by the sync).
            let mut mirror_fresh = false;
            if due {
                // Failures are logged by `run_backup` and `run_git_sync`.
                match run_backup(&app) {
                    Ok((_, fresh)) => mirror_fresh = fresh,
                    Err(e) => {
                        let _ = app.emit("backup://failed", e.to_string());
                    }
                }
            }
            let gs = state.settings().git_sync;
            if gs.enabled && gs.mode == SyncMode::Hourly && !gs.remote_url.is_empty() {
                let _ = run_git_sync(&app, mirror_fresh, false);
            }
            std::thread::sleep(Duration::from_secs(3600));
        }
    });
}

/// How long after the start the scheduler first looks for a due backup: 3 minutes, or
/// `ANNALO_BACKUP_DELAY_SECS` (tests).
fn startup_backup_delay() -> Duration {
    let secs = std::env::var("ANNALO_BACKUP_DELAY_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(180);
    Duration::from_secs(secs)
}

// ---------------------------------------------------------------- settings

#[derive(Serialize)]
struct SettingsView {
    settings: Settings,
    /// Whether the key of the provider `litellm` (the LiteLLM token of earlier versions) is set.
    api_key_set: bool,
    api_key_storage: &'static str,
    /// Ids of the providers with a stored key (the keys themselves never leave the shell).
    provider_keys: Vec<String>,
    data_dir: String,
    /// Effective backup folder (the configured one or the default).
    backup_dir: String,
    version: &'static str,
    /// Per shareable section: „Für alle Arbeitsbereiche“ (`global`) or „Nur dieser“ (`workspace`).
    scopes: std::collections::BTreeMap<String, annalo_core::settings_layers::Scope>,
    /// Whether sections can be shared at all (a shared folder is set).
    shared: bool,
    /// The last settings sync that changed settings here (for „Rückgängig“).
    sync_last: Option<annalo_core::settings_sync::LastMerge>,
}

#[tauri::command]
fn settings_get(state: State<AppState>) -> SettingsView {
    SettingsView {
        settings: state.settings(),
        api_key_set: state.secrets.get().is_some(),
        api_key_storage: state.secrets.backend(),
        provider_keys: {
            let ai = state.ai.read().unwrap_or_else(|e| e.into_inner());
            ai.settings
                .providers
                .iter()
                .filter(|p| state.provider_secret(&p.id).get().is_some())
                .map(|p| p.id.clone())
                .collect()
        },
        data_dir: state.data_dir.display().to_string(),
        backup_dir: state.backup_dir().display().to_string(),
        version: env!("CARGO_PKG_VERSION"),
        scopes: annalo_core::settings_layers::scopes(&state.settings()),
        shared: annalo_core::settings_layers::shared_dir().is_some(),
        sync_last: state.db().settings_sync_last().ok().flatten(),
    }
}

/// Saves settings and applies them immediately (no restart needed).
#[tauri::command]
fn settings_save(app: AppHandle, state: State<AppState>, settings: serde_json::Value) -> Result<SettingsView> {
    let previous = state.settings();
    // Settings without the provider list (scripts, an older settings page) keep the stored
    // providers and their keys instead of falling back to the default one.
    let has_providers = settings.get("providers").is_some();
    let mut settings: Settings = serde_json::from_value(settings).map_err(|e| Error::Parse(e.to_string()))?;
    if !has_providers {
        settings.providers = previous.providers.clone();
    }
    // Scripts and older settings pages set only `litellm_base_url`; it moves the LiteLLM provider.
    settings.sync_legacy(&previous);
    settings.normalize_ai()?;
    settings.backup_keep = settings.backup_keep.clamp(1, 365);
    settings.backup_dir = settings.backup_dir.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    settings.markdown_mirror_dir = settings.markdown_mirror_dir.map(|d| d.trim().to_owned()).filter(|d| !d.is_empty());
    settings.git_sync = gitsync::normalize(&settings.git_sync)?;
    settings.network = settings.network.normalized()?;
    // What an organization's policy fixes (routes, locked profiles) stays as it says.
    network::enforce_policy(&previous.network, &mut settings.network);
    settings.normalize();
    // A missing or unreadable CA file is reported now, not on the next request.
    network::check(&settings.network)?;
    network::forget_removed(&state, &previous.network, &settings.network);
    settings.reminder_time = settings.reminder_time.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty());
    if let Some(t) = &settings.reminder_time {
        let time = annalo_core::desktop::parse_hhmm(t).ok_or_else(|| {
            Error::State(trf!(
                "Erinnerungszeit „{t}“ ungültig, erwartet HH:MM",
                "Reminder time “{t}” is invalid, expected HH:MM"
            ))
        })?;
        settings.reminder_time = Some(time.format("%H:%M").to_string());
    }
    settings.capture_shortcut = settings.capture_shortcut.trim().to_owned();
    settings.palette_shortcut = settings.palette_shortcut.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
    settings.search_shortcut = settings.search_shortcut.trim().to_owned();
    // What is stored (the database, which a scope change or a settings sync may have changed
    // ahead of the running settings).
    let stored = state.db().load_settings()?;
    // The start page saves its widgets itself (`dashboard_save`); a settings draft opened
    // earlier must not overwrite them.
    settings.dashboard = stored.dashboard.clone();
    // The same for the sidebar's links (`quick_links_save`).
    settings.quick_links = stored.quick_links.clone();
    // And for the calendar sources (`calendar_source_*`; their addresses are secrets).
    settings.calendar.sources = stored.calendar.sources.clone();
    // And for the shared sections' scopes (`settings_scope_set`) and the version of the shape.
    settings.workspace_scopes = stored.workspace_scopes.clone();
    settings.version = stored.version.max(annalo_core::settings_migrate::SETTINGS_VERSION);
    // And for the chosen Outlook calendars (`calendar_outlook_*`); the default one takes the color.
    let stored_cal = stored.calendar.clone();
    settings.calendar.outlook_calendars = stored_cal.outlook_calendars;
    settings.calendar.outlook_recipients = stored_cal.outlook_recipients;
    settings.calendar = std::mem::take(&mut settings.calendar).normalized();
    // And for the first-run flags (`onboarding_complete` / `onboarding_reset`).
    settings.onboarding = stored.onboarding.clone();
    // And for the Jira sites (`jira_site_*`; their tokens are secrets).
    settings.jira.sites = stored.jira.sites.clone();
    settings.jira = std::mem::take(&mut settings.jira).normalized();
    // An inbox title still at the other language's default follows the language.
    let page = |t: &str| state.reader().page_by_title(t).ok().flatten().is_some();
    annalo_core::capture::localize_inbox_title(&mut settings.capture, settings.locale.language, page);
    let specs = |s: &Settings| {
        [
            s.capture_shortcut.clone(),
            s.palette_shortcut.clone().unwrap_or_default(),
            s.search_shortcut.clone(),
            s.capture.selection_shortcut.clone(),
            s.mail.shortcut.clone(),
            s.voice.shortcut.clone(),
        ]
    };
    let new_specs = specs(&settings);
    desktop::validate_shortcuts(new_specs.each_ref().map(String::as_str)).map_err(Error::State)?;
    let old_specs = specs(&state.settings());
    let changed: Vec<bool> = new_specs.iter().zip(&old_specs).map(|(a, b)| a != b).collect();
    let only_changed = |v: &[String; desktop::SLOTS]| -> [Option<String>; desktop::SLOTS] {
        std::array::from_fn(|i| changed[i].then(|| v[i].clone()))
    };
    let apply = |v: &[String; desktop::SLOTS]| {
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
    devlog::apply_settings(&settings);
    // Keys of removed providers are deleted with them.
    for gone in previous.providers.iter().filter(|p| !settings.providers.iter().any(|n| n.id == p.id)) {
        if let Err(e) = state.provider_secret(&gone.id).set(None) {
            devlog::warn("ai", format!("key of the removed provider “{}” not deleted: {e}", gone.id));
        }
    }
    // Outlook switched on, another window or other privacy rules: read the calendars again now.
    let (old_cal, new_cal) = (&previous.calendar, &settings.calendar);
    let resync = (!old_cal.outlook && new_cal.outlook)
        || (old_cal.past_days, old_cal.future_days) != (new_cal.past_days, new_cal.future_days)
        || annalo_core::calsync::Privacy::from(old_cal) != annalo_core::calsync::Privacy::from(new_cal);
    let active = new_cal.active_sources(annalo_core::calsync::outlook::available());
    let relocalize = annalo_core::i18n::set_lang(settings.locale.language);
    annalo_core::i18n::set_number_format(settings.locale.number_format);
    let chat_retention = previous.ai.chat_history != settings.ai.chat_history;
    // Another saved Jira search: its issues are read now.
    let jira_resync: Vec<String> = if previous.jira.queries != settings.jira.queries {
        settings.jira.active().map(|s| s.id.clone()).collect()
    } else {
        vec![]
    };
    let time_switched = previous.time_tracking() != settings.time_tracking();
    rebuild_ai(&state, settings);
    // Time tracking switched: tray menu and jump list without (or with) the timer entries.
    if time_switched {
        desktop::refresh_tray(&app);
    }
    if chat_retention {
        chats::prune(&state);
    }
    backupdest::settings_changed(&app);
    if resync && !active.is_empty() {
        calsync::spawn_sync(app.clone(), active);
    }
    if !jira_resync.is_empty() {
        jira::spawn_sync(app.clone(), jira_resync);
    }
    // Another language: the tray, the menu bar and the jump list follow, and the built-in
    // activity types (unless edited).
    if relocalize {
        desktop::relocalize(&app);
        if let Err(e) = state.db().localize_default_leistungsarten() {
            devlog::warn("core", format!("activity types not localized: {e}"));
        }
    }
    // Other windows (and a settings page opened elsewhere) take over the change.
    let _ = app.emit("settings://changed", ());
    Ok(settings_get(state))
}

/// Settings → a shareable section: „Für alle Arbeitsbereiche“ or „Nur dieser Arbeitsbereich“.
/// To „Für alle“ the shared value is taken (when there is one) and applied like a save.
#[tauri::command]
fn settings_scope_set(
    app: AppHandle,
    state: State<AppState>,
    section: String,
    scope: annalo_core::settings_layers::Scope,
) -> Result<SettingsView> {
    let s = state.db().set_settings_scope(&section, scope)?;
    devlog::info("settings", format!("section {section} now {scope:?}"));
    settings_save(app, state, serde_json::to_value(&s)?)
}

/// Takes back the settings the last settings sync took from the server.
#[tauri::command]
fn settings_sync_undo(app: AppHandle, state: State<AppState>) -> Result<SettingsView> {
    let s = state.db().settings_sync_undo()?;
    devlog::info("settings", "last settings sync taken back");
    settings_save(app, state, serde_json::to_value(&s)?)
}

/// Applies the settings file of a sync (see `settings_sync`): what changed later on another
/// computer is taken over, logged and announced (`settings://synced`, with „Rückgängig“).
fn take_over_settings(app: &AppHandle, text: &str) {
    let state = app.state::<AppState>();
    let applied = state.db().settings_sync_apply(text);
    match applied {
        Ok((next, changes)) if !changes.is_empty() => {
            let keys: Vec<&str> = changes.iter().map(|c| c.key.as_str()).collect();
            devlog::info(
                "settings",
                format!("settings sync: {} taken from the server: {}", keys.len(), keys.join(", ")),
            );
            match serde_json::to_value(&next)
                .map_err(Error::from)
                .and_then(|v| settings_save(app.clone(), app.state(), v))
            {
                Ok(_) => {
                    let _ = app.emit("settings://synced", keys.len());
                }
                Err(e) => devlog::error("settings", format!("synced settings not applied: {e}")),
            }
        }
        Ok(_) => {}
        Err(e) => devlog::error("settings", format!("settings sync failed: {e}")),
    }
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

/// Saves only the sidebar's links (the rest of the settings stays as it is).
#[tauri::command]
fn quick_links_save(
    app: AppHandle,
    state: State<AppState>,
    links: Vec<annalo_core::settings::QuickLink>,
) -> Result<SettingsView> {
    let mut settings = state.settings();
    settings.quick_links = annalo_core::settings::normalize_quick_links(links);
    state.db().save_settings(&settings)?;
    state.ai.write().unwrap_or_else(|e| e.into_inner()).settings = settings;
    let _ = app.emit("settings://changed", ());
    Ok(settings_get(state))
}

/// Opens the ribbon link at `index` (with `item`: that entry of the group there). Only saved
/// links can be opened this way; the page cannot hand in arbitrary paths. Programs are started.
/// Tests set `ANNALO_TEST_OPEN_LOG` to a file: the targets are appended there instead.
#[tauri::command]
fn quick_link_open(app: AppHandle, state: State<AppState>, index: usize, item: Option<usize>) -> Result<()> {
    use annalo_core::settings::{LinkKind, LinkTarget};
    use tauri_plugin_opener::OpenerExt;
    let links = state.settings().quick_links;
    let link = annalo_core::settings::quick_link_at(&links, index, item)
        .cloned()
        .ok_or_else(|| Error::not_found("link", index.to_string()))?;
    let home = |p: String| match p.strip_prefix("~/") {
        Some(rest) => app.path().home_dir().map(|h| h.join(rest).display().to_string()).unwrap_or(p),
        None => p,
    };
    let target = match (link.kind, link.target()) {
        (_, LinkTarget::Url(u)) => ("url", u),
        (LinkKind::App, LinkTarget::Path(p)) => ("app", home(p)),
        (_, LinkTarget::Path(p)) => ("path", home(p)),
    };
    if let Ok(log) = std::env::var("ANNALO_TEST_OPEN_LOG") {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
        writeln!(f, "{}\t{}", target.0, target.1)?;
        return Ok(());
    }
    let opened = match target {
        ("url", u) => app.opener().open_url(u, None::<&str>),
        ("app", p) => {
            return start_program(&app, &p).map_err(|e| {
                Error::State(trf!("„{}“ ließ sich nicht starten: {e}", "“{}” could not be started: {e}", link.name))
            });
        }
        (_, p) => app.opener().open_path(p, None::<&str>),
    };
    opened
        .map_err(|e| Error::State(trf!("„{}“ ließ sich nicht öffnen: {e}", "“{}” could not be opened: {e}", link.name)))
}

/// Starts a program from the ribbon. Windows and macOS start programs (`.exe`, `.lnk`, `.app`)
/// through the shell; on Linux an executable file is run directly (the file manager would only
/// show it), anything else (a `.desktop` file, a script without the x bit) goes to the shell.
fn start_program(app: &AppHandle, path: &str) -> std::result::Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
            let mut child = std::process::Command::new(path)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .map_err(|e| e.to_string())?;
            // Reaped when it ends (no zombie while Arcalo runs).
            std::thread::spawn(move || child.wait());
            return Ok(());
        }
    }
    app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Stores (or with `None`, removes) the LiteLLM API key in the OS credential store.
#[tauri::command]
fn api_key_set(state: State<AppState>, key: Option<String>) -> Result<SettingsView> {
    state.secrets.set(key.as_deref().map(str::trim)).map_err(Error::State)?;
    rebuild_ai(&state, state.settings());
    Ok(settings_get(state))
}

/// Stores (or with `None`, removes) the API key of the provider `id` in the OS credential store.
/// The provider need not be saved yet (the dialog stores the key before the settings).
#[tauri::command]
fn provider_key_set(state: State<AppState>, id: String, key: Option<String>) -> Result<SettingsView> {
    let id = annalo_core::ai::provider::slug(&id);
    if id.is_empty() {
        return Err(Error::State(tr!("Anbieter ohne Kennung", "Provider without an id").into()));
    }
    state.provider_secret(&id).set(key.as_deref().map(str::trim)).map_err(Error::State)?;
    rebuild_ai(&state, state.settings());
    Ok(settings_get(state))
}

#[derive(Serialize)]
struct ConnectionTest {
    ok: bool,
    latency_ms: u64,
    models: Vec<String>,
    /// The models that compute embeddings (by the provider's word, else by name): the only
    /// ones the embedding picker offers.
    embedding_models: Vec<String>,
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
    let mut provider = settings
        .providers
        .iter()
        .find(|p| p.id == annalo_core::ai::provider::LEGACY_ID)
        .cloned()
        .unwrap_or_else(|| AiProvider::litellm(&settings.litellm_base_url));
    if let Some(url) = base_url {
        provider.base_url = url.trim().trim_end_matches('/').to_owned();
    }
    provider_models(&state, provider, api_key).await
}

/// Lists the models of a provider, saved or not (the dialog tests unsaved values); a new key
/// can be tried before it is stored. The answer of a saved, unchanged provider is cached.
async fn provider_models(state: &AppState, provider: AiProvider, key: Option<String>) -> Result<ConnectionTest> {
    let settings = state.settings();
    let unchanged = key.as_deref().is_none_or(str::is_empty) && settings.providers.contains(&provider);
    let key = key.filter(|k| !k.is_empty()).or_else(|| state.provider_secret(&provider.id).get());
    let client = provider_client(&settings, &provider, key, &proxy_passwords(state))?;
    let start = Instant::now();
    let res = client.models().await;
    let latency_ms = start.elapsed().as_millis() as u64;
    Ok(match res {
        Ok(mut models) => {
            models.sort();
            let modes = model_modes(&client).await;
            if unchanged {
                lock(&state.server_models).insert(provider.id.clone(), (Instant::now(), Some(models.clone())));
                if let Some(modes) = &modes {
                    lock(&state.caps).set_modes(&provider.id, modes.clone());
                }
            }
            let modes = modes.unwrap_or_default();
            let embedding_models = models
                .iter()
                .filter(|m| capability::embedding_capable(m, modes.get(*m).map(String::as_str)))
                .cloned()
                .collect();
            ConnectionTest { ok: true, latency_ms, models, embedding_models, error: None }
        }
        Err(e) => {
            devlog::warn("ai", format!("model list of “{}” failed: {e}", provider.display_name()));
            ConnectionTest {
                ok: false,
                latency_ms,
                models: vec![],
                embedding_models: vec![],
                error: Some(e.to_string()),
            }
        }
    })
}

/// What the provider says about its models' kinds (LiteLLM's `/model/info`), briefly; `None`
/// when it could not be asked (older LiteLLM, a key without access): names decide then.
async fn model_modes(client: &AiClient) -> Option<HashMap<String, String>> {
    match tokio::time::timeout(Duration::from_secs(5), client.model_modes()).await {
        Ok(Ok(modes)) => Some(modes),
        Ok(Err(e)) => {
            devlog::debug("ai", format!("model info of “{}”: {e}", client.provider().id));
            None
        }
        Err(_) => None,
    }
}

/// Asks a provider for its models' kinds once per session (see [`model_modes`]).
async fn learn_modes(state: &AppState, client: &AiClient) {
    let id = client.provider().id.clone();
    if lock(&state.caps).has_modes(&id) {
        return;
    }
    let modes = model_modes(client).await.unwrap_or_default();
    lock(&state.caps).set_modes(&id, modes);
}

/// The models of a provider (Settings → KI: status dots and model pickers).
#[tauri::command]
async fn ai_provider_models(
    state: State<'_, AppState>,
    provider: AiProvider,
    key: Option<String>,
) -> Result<ConnectionTest> {
    provider_models(&state, provider, key).await
}

#[derive(Serialize)]
struct TestStep {
    /// `reach`, `auth`, `chat`, `tools` or `embed`.
    id: &'static str,
    /// `None` = skipped (nothing to test, or an earlier step failed).
    ok: Option<bool>,
    detail: String,
    latency_ms: u64,
}

#[derive(Serialize)]
struct ProviderTest {
    steps: Vec<TestStep>,
    models: Vec<String>,
    /// The chat model the test used.
    model: Option<String>,
}

/// Short form of a provider error for the test steps.
fn short_error(e: &Error) -> String {
    let text = match e {
        Error::Provider { status: 0, body } => body.clone(),
        Error::Provider { status, body } => format!("HTTP {status}: {body}"),
        Error::Http(e) => {
            let mut msg = e.to_string();
            let mut source = std::error::Error::source(e);
            while let Some(s) = source {
                msg.push_str(&format!(": {s}"));
                source = s.source();
            }
            msg
        }
        e => e.to_string(),
    };
    text.chars().take(240).collect()
}

/// „Verbindung testen“ of a provider (saved or not): reachability, key, a short chat, tool
/// support and embeddings, each with its own result. Nothing is recorded as usage.
#[tauri::command]
async fn ai_provider_test(
    state: State<'_, AppState>,
    provider: AiProvider,
    key: Option<String>,
    model: Option<String>,
) -> Result<ProviderTest> {
    let settings = state.settings();
    let mut provider = provider;
    provider.base_url = provider.base_url.trim().trim_end_matches('/').to_owned();
    let key = key.filter(|k| !k.is_empty()).or_else(|| state.provider_secret(&provider.id).get());
    let has_key = key.is_some();
    let mut client = provider_client(&settings, &provider, key, &proxy_passwords(&state))?;
    // A test must end: a server that accepts but never answers fails the step after a minute.
    client.first_byte_timeout = Duration::from_secs(60);
    let mut steps = vec![];
    let step = |id, ok: Option<bool>, detail: String, start: Instant| TestStep {
        id,
        ok,
        detail,
        latency_ms: start.elapsed().as_millis() as u64,
    };
    let skipped = |id, why: &str| TestStep { id, ok: None, detail: why.into(), latency_ms: 0 };

    // 1 + 2: the model list answers (reachable) and accepts the key.
    let start = Instant::now();
    let listed = if provider.kind == annalo_core::ai::ProviderKind::Ollama {
        client.ollama_version().await.map(|v| format!("Ollama {v}"))
    } else {
        Ok(String::new())
    };
    let models = match (listed, client.models().await) {
        (Err(e), _) | (_, Err(e @ Error::Http(_))) => {
            steps.push(step("reach", Some(false), short_error(&e), start));
            for id in ["auth", "chat", "tools", "embed"] {
                steps.push(skipped(id, tr!("Nicht erreichbar", "Not reachable")));
            }
            return Ok(ProviderTest { steps, models: vec![], model: None });
        }
        (Ok(version), Err(e)) => {
            steps.push(step("reach", Some(true), version, start));
            let denied = matches!(e, Error::Provider { status: 401 | 403, .. });
            let detail = if denied && !has_key {
                tr!("Kein API-Schlüssel hinterlegt", "No API key stored").into()
            } else {
                short_error(&e)
            };
            steps.push(step("auth", Some(false), detail, start));
            for id in ["chat", "tools", "embed"] {
                steps.push(skipped(
                    id,
                    if denied {
                        tr!("Zugang abgelehnt", "Access denied")
                    } else {
                        tr!("Modellliste nicht lesbar", "Model list not readable")
                    },
                ));
            }
            return Ok(ProviderTest { steps, models: vec![], model: None });
        }
        (Ok(version), Ok(mut models)) => {
            models.sort();
            steps.push(step("reach", Some(true), version, start));
            let detail = match (provider.models_url().is_some(), has_key) {
                (false, _) => tr!("Wird beim Chat geprüft", "Checked with the chat").into(),
                (true, true) => trf!("Schlüssel angenommen · {} Modelle", "Key accepted · {} models", models.len()),
                (true, false) if !provider.needs_key() => {
                    trf!("Kein Schlüssel nötig · {} Modelle", "No key needed · {} models", models.len())
                }
                (true, false) => trf!("Ohne Schlüssel · {} Modelle", "Without a key · {} models", models.len()),
            };
            steps.push(step("auth", Some(true), detail, start));
            models
        }
    };

    // 3: a short chat on the given model, a tier's model of this provider or the first chat model.
    let tiers = [Tier::Local, Tier::Standard, Tier::Reasoning].map(|t| settings.router.tier_ref(t));
    let chat_model = model.filter(|m| !m.trim().is_empty()).or_else(|| {
        tiers
            .iter()
            .filter(|r| r.provider == provider.id && !r.model.is_empty())
            .map(|r| r.model.clone())
            .find(|m| models.is_empty() || models.contains(m))
            .or_else(|| models.iter().find(|m| capability::chat_capable(m, None)).cloned())
    });
    let Some(chat_model) = chat_model else {
        steps.push(skipped("chat", tr!("Kein Chat-Modell bekannt", "No chat model known")));
        steps.push(skipped("tools", tr!("Kein Chat-Modell bekannt", "No chat model known")));
        steps.push(embed_step(&client, &settings, &provider, &models).await);
        return Ok(ProviderTest { steps, models, model: None });
    };
    let ask = |tools: Vec<serde_json::Value>| ChatRequest {
        model: chat_model.clone(),
        messages: vec![ChatMessage::user(tr!("Antworte nur mit: OK", "Answer only with: OK"))],
        tools,
        temperature: None,
        max_tokens: Some(16),
    };
    let start = Instant::now();
    match client.chat_stream(&ask(vec![]), None, |_| {}).await {
        // A model that spends its 16 tokens on thinking answers with nothing: it still answers.
        Err(Error::State(m)) if m.starts_with("Leere Antwort") => {
            steps.push(step("chat", Some(true), format!("{chat_model}: antwortet (ohne Text)"), start));
        }
        Ok(c) => {
            let answer: String = c.content.trim().chars().take(40).collect();
            let detail = if answer.is_empty() {
                chat_model.clone()
            } else {
                trf!("{chat_model}: „{answer}“", "{chat_model}: “{answer}”")
            };
            steps.push(step("chat", Some(true), detail, start));
        }
        Err(e) => {
            let auth = matches!(e, Error::Provider { status: 401 | 403, .. });
            steps.push(step("chat", Some(false), short_error(&e), start));
            if auth && let Some(s) = steps.iter_mut().find(|s| s.id == "auth") {
                s.ok = Some(false);
                s.detail = if has_key {
                    tr!("Schlüssel abgelehnt", "Key rejected").into()
                } else {
                    tr!("Kein API-Schlüssel hinterlegt", "No API key stored").into()
                };
            }
            steps.push(skipped("tools", tr!("Chat fehlgeschlagen", "Chat failed")));
            steps.push(embed_step(&client, &settings, &provider, &models).await);
            return Ok(ProviderTest { steps, models, model: Some(chat_model) });
        }
    }

    // 4: tools: the request with a tool definition is accepted.
    let ping = serde_json::json!({
        "type": "function",
        "function": {"name": "ping", "description": tr!("Antwortet mit pong", "Answers with pong"), "parameters": {"type": "object", "properties": {}}}
    });
    let start = Instant::now();
    steps.push(match client.chat_stream(&ask(vec![ping]), None, |_| {}).await {
        Ok(_) => step("tools", Some(true), "Werkzeuge werden angenommen".into(), start),
        Err(Error::State(m)) if m.starts_with("Leere Antwort") => {
            step("tools", Some(true), "Werkzeuge werden angenommen".into(), start)
        }
        Err(Error::Provider { status, body }) => {
            let unsupported =
                matches!(availability::retry_for(status, &body, true, false), availability::Retry::Without { .. });
            let detail = if unsupported {
                tr!("Das Modell unterstützt keine Werkzeuge", "The model does not support tools").into()
            } else {
                format!("HTTP {status}")
            };
            step("tools", Some(false), detail, start)
        }
        Err(e) => step("tools", Some(false), short_error(&e), start),
    });

    // 5: embeddings.
    steps.push(embed_step(&client, &settings, &provider, &models).await);
    Ok(ProviderTest { steps, models, model: Some(chat_model) })
}

/// The embedding step of the provider test: the configured embedding model when it is on this
/// provider, else a listed model with "embed" in its name.
async fn embed_step(client: &AiClient, settings: &Settings, provider: &AiProvider, models: &[String]) -> TestStep {
    let configured =
        settings.embedding_model.clone().filter(|m| !m.is_empty() && settings.embedding_provider == provider.id);
    // A chat model is not asked for embeddings, not even here: on LiteLLM the failure would put
    // it into cooldown.
    let modes = model_modes(client).await.unwrap_or_default();
    let capable = |m: &String| capability::embedding_capable(m, modes.get(m).map(String::as_str));
    if let Some(m) = configured.as_ref().filter(|m| !capable(m)) {
        let detail = trf!(
            "„{m}“ ist kein Embedding-Modell – nur Stichwortsuche",
            "“{m}” is not an embedding model – keyword search only"
        );
        return TestStep { id: "embed", ok: None, detail, latency_ms: 0 };
    }
    let Some(model) = configured.or_else(|| models.iter().find(|m| capable(m)).cloned()) else {
        return TestStep {
            id: "embed",
            ok: None,
            detail: tr!("Kein Embedding-Modell", "No embedding model").into(),
            latency_ms: 0,
        };
    };
    let start = Instant::now();
    let res = client.embed(&model, &["Arcalo".to_string()]).await;
    let latency_ms = start.elapsed().as_millis() as u64;
    match res {
        Ok(v) => TestStep {
            id: "embed",
            ok: Some(true),
            detail: format!("{model}: {} Dimensionen", v.first().map_or(0, Vec::len)),
            latency_ms,
        },
        Err(e) => {
            TestStep { id: "embed", ok: Some(false), detail: format!("{model}: {}", short_error(&e)), latency_ms }
        }
    }
}

#[derive(Serialize)]
struct OllamaDetect {
    found: bool,
    url: String,
    version: Option<String>,
    models: Vec<String>,
}

/// Looks for an Ollama at `base_url` (default `http://localhost:11434`), directly and briefly.
#[tauri::command]
async fn ollama_detect(state: State<'_, AppState>, base_url: Option<String>) -> Result<OllamaDetect> {
    let url = base_url.filter(|u| !u.trim().is_empty()).unwrap_or_else(|| annalo_core::ai::provider::OLLAMA_URL.into());
    let provider = AiProvider::ollama("ollama", url.trim());
    let url = provider.root();
    let client = provider_client(&state.settings(), &provider, None, &proxy_passwords(&state))?;
    let probe = async {
        let version = client.ollama_version().await?;
        let models = client.models().await.unwrap_or_default();
        Ok::<_, Error>((version, models))
    };
    Ok(match tokio::time::timeout(Duration::from_secs(3), probe).await {
        Ok(Ok((version, models))) => OllamaDetect { found: true, url, version: Some(version), models },
        _ => OllamaDetect { found: false, url, version: None, models: vec![] },
    })
}

#[derive(Serialize, Clone)]
struct PullPayload<'a> {
    request_id: &'a str,
    status: &'a str,
    total: Option<u64>,
    completed: Option<u64>,
}

/// Downloads `model` into an Ollama (saved or not), reporting progress as `ai://pull` events;
/// cancellable through `ai_cancel`.
#[tauri::command]
async fn ollama_pull(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
    provider: AiProvider,
    model: String,
) -> Result<()> {
    let model = model.trim().to_owned();
    if model.is_empty() {
        return Err(Error::State(tr!("Kein Modellname", "No model name").into()));
    }
    let client = provider_client(&state.settings(), &provider, None, &proxy_passwords(&state))?;
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&state.cancels).insert(request_id.clone(), cancel.clone());
    let res = client
        .ollama_pull(&model, Some(&cancel), |p| {
            let _ = app.emit(
                "ai://pull",
                PullPayload { request_id: &request_id, status: &p.status, total: p.total, completed: p.completed },
            );
        })
        .await;
    lock(&state.cancels).remove(&request_id);
    lock(&state.server_models).remove(&provider.id);
    res.inspect(|()| devlog::info("ai", format!("pulled “{model}” into {}", provider.root())))
}

// ----------------------------------------------------------------------- AI

fn system_prompt(settings: &Settings) -> String {
    let now = Local::now();
    // The answers follow the display language (unless the user writes in another one). Time
    // tracking off: a notes, tasks and calendar workspace; nothing about SAP booking.
    let mut s = if settings.time_tracking() {
        trf!(
            "Du bist der Assistent von Arcalo, einem lokalen Arbeitsbereich für Notizen, Projekte und \
             Zeiterfassung. Heute ist {}. Antworte präzise und auf Deutsch, sofern der Nutzer nicht anders \
             schreibt. Nutze Markdown. Verweise auf Seiten mit [[Seitenname]]. Zeit wird mit der /zeit-Syntax \
             gebucht, z. B. /zeit NP-8801/1020 2.5h #DEV 'Beschreibung'. Nutze Werkzeuge nur, wenn nötig.",
            "You are the assistant of Arcalo, a local workspace for notes, projects and time tracking. \
             Today is {}. Answer precisely and in English, unless the user writes in another language. \
             Use Markdown. Refer to pages with [[Page name]]. Time is booked with the /time syntax, e.g. \
             /time NP-8801/1020 2.5h #DEV 'Description'. Use tools only when needed.",
            now.format(tr!("%A, %d.%m.%Y %H:%M", "%A, %B %-d, %Y %H:%M"))
        )
    } else {
        trf!(
            "Du bist der Assistent von Arcalo, einem lokalen Arbeitsbereich für Notizen, Aufgaben und \
             Termine. Heute ist {}. Antworte präzise und auf Deutsch, sofern der Nutzer nicht anders \
             schreibt. Nutze Markdown. Verweise auf Seiten mit [[Seitenname]]. Nutze Werkzeuge nur, wenn nötig.",
            "You are the assistant of Arcalo, a local workspace for notes, tasks and meetings. \
             Today is {}. Answer precisely and in English, unless the user writes in another language. \
             Use Markdown. Refer to pages with [[Page name]]. Use tools only when needed.",
            now.format(tr!("%A, %d.%m.%Y %H:%M", "%A, %B %-d, %Y %H:%M"))
        )
    };
    if !settings.assistant_instructions.trim().is_empty() {
        s.push_str(tr!("\n\nZusätzliche Anweisungen des Nutzers:\n", "\n\nAdditional instructions from the user:\n"));
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
    /// The turn touched private content (a marker, „Nur lokal“ or a private conversation).
    private: bool,
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
fn ai_route_preview(
    state: State<AppState>,
    prompt: String,
    use_tools: bool,
    tier: Option<Tier>,
    conversation_id: Option<i64>,
) -> RouteDecision {
    let route = route_for(&state, &prompt, &[], use_tools, tier);
    let private_chat = conversation_id.is_some_and(|id| state.db().chat_is_private(id).unwrap_or(false));
    if private_chat && !availability::local_required(&route, state.settings().privacy.local_only) {
        return state.router().private_route("private conversation, kept on the local model");
    }
    route
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
    conversation_id: Option<i64>,
) -> Result<ChatOutcome> {
    prefs::check_cost_limit(&state, override_limit.unwrap_or(false))?;
    let prompt = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .and_then(|m| m.content.clone())
        .ok_or_else(|| Error::State(tr!("Keine Nachricht", "No message").into()))?;
    let settings = state.settings();
    // A saved conversation that touched private content stays on the local model.
    let private_chat = match conversation_id {
        Some(id) => state.db().chat_is_private(id)?,
        None => false,
    };

    // Retrieval: embeddings are optional; keyword search always works offline. A private
    // question is not sent to an embedding model of a provider that is not local.
    let lower = prompt.to_lowercase();
    let private = private_chat
        || settings.privacy.local_only
        || settings.router.private_markers.iter().any(|m| !m.trim().is_empty() && lower.contains(&m.to_lowercase()));
    // A chat model is never asked for embeddings, and a model that failed is not asked again:
    // on a LiteLLM proxy each failure counts against the model and can put it into cooldown.
    let (embedder, mut embed_note) = match embedding_client(&state).filter(|(c, _)| !private || c.provider().local) {
        Some((client, r)) => {
            learn_modes(&state, &client).await;
            let mut caps = lock(&state.caps);
            match caps.embedding_usable(&r) {
                Ok(()) => (Some((client, r)), None),
                Err(why) => {
                    let note = caps.tell_once(&r).then(|| {
                        devlog::warn("ai", format!("no embeddings with “{}”, keyword search only: {why}", r.model));
                        trf!(
                            "Embedding-Modell „{}“ nicht nutzbar → nur Stichwortsuche",
                            "Embedding model “{}” not usable → keyword search only",
                            r.model
                        )
                    });
                    (None, note)
                }
            }
        }
        None => (None, None),
    };
    let query_embedding = match &embedder {
        // Bounded: a slow or missing embedding model must not hold up the answer.
        Some((client, r)) => {
            let m = &r.model;
            match tokio::time::timeout(Duration::from_secs(8), client.embed(m, std::slice::from_ref(&prompt))).await {
                Ok(Ok(mut v)) => {
                    lock(&state.caps).embed_succeeded(r);
                    v.pop()
                }
                Ok(Err(e)) => {
                    let mut caps = lock(&state.caps);
                    if caps.embed_failed(r, &e) {
                        caps.tell_once(r);
                        devlog::warn(
                            "ai",
                            format!("embedding with “{m}” failed, keyword search only for this session: {e}"),
                        );
                        embed_note = Some(trf!(
                            "Embedding-Modell „{m}“ antwortet nicht ({}) → nur Stichwortsuche",
                            "Embedding model “{m}” does not answer ({}) → keyword search only",
                            capability::embedding_failure_text(&e)
                        ));
                    } else {
                        devlog::warn("ai", format!("embedding with “{m}” failed, keyword search only: {e}"));
                    }
                    None
                }
                Err(_) => {
                    devlog::warn("ai", format!("embedding with “{m}” timed out, keyword search only"));
                    None
                }
            }
        }
        _ => None,
    };
    let (context, active, source_marker) = {
        let db = state.db();
        let context = rag::retrieve(&db, &prompt, query_embedding.as_deref(), 6)?;
        // Settings → Datenschutz: the open page is only sent when allowed.
        // Its tags count as well (front matter `tags: [privat]` is not in the text as #privat).
        let active = match page_id.filter(|_| settings.privacy.read_open_page) {
            Some(id) => db.page_doc(id).ok().map(|d| (d.page.title, d.content, privacy::tag_text(&d.tags))),
            None => None,
        };
        // A chunk rarely contains its page's #privat tag, so the privacy of every source page counts too.
        let ids: Vec<i64> = context.iter().filter_map(|c| c.page_id).collect();
        let private = privacy::private_pages(&db, ids, &settings.router.private_markers)?;
        (
            context,
            active,
            privacy::mark_tool_result(String::new(), !private.is_empty(), &settings.router.private_markers),
        )
    };
    let mut context_texts: Vec<String> = context.iter().map(|c| c.text.clone()).collect();
    if let Some((_, text, tags)) = &active {
        context_texts.push(text.clone());
        context_texts.push(tags.clone());
    }
    context_texts.push(source_marker);
    // Earlier turns (and tool results) of the conversation are sent again, so they count as well.
    context_texts.extend(messages.iter().filter_map(|m| m.content.clone()));
    let mut route = route_for(&state, &prompt, &context_texts, use_tools, tier);
    if private_chat && !availability::local_required(&route, settings.privacy.local_only) {
        route = state.router().private_route("private conversation, kept on the local model");
    }
    // What makes the conversation private from now on (the UI saves it with the turn).
    let touched_private = private_chat
        || settings.privacy.local_only
        || annalo_core::ai::privacy::any_private(
            std::iter::once(prompt.as_str()).chain(context_texts.iter().map(String::as_str)),
            &settings.router.private_markers,
        );
    if touched_private && let Some(id) = conversation_id {
        state.db().chat_mark_private(id)?;
    }

    // One system message, as in the inline AI: chat templates of many models (vLLM, Mistral,
    // Gemma) accept a system message only at the very start.
    let mut system = system_prompt(&settings);
    if let Some((title, text, _)) = &active {
        let text: String = text.chars().take(12_000).collect();
        system.push_str(&trf!(
            "\n\nAktuell geöffnete Seite „{title}“:\n\n{text}",
            "\n\nThe page open right now, “{title}”:\n\n{text}"
        ));
    }
    if !context.is_empty() {
        system.push_str("\n\n");
        system.push_str(&rag::format_context_with(&context, settings.ai.citations));
    }
    let mut full = vec![ChatMessage::system(system)];
    full.extend(messages);
    let req = ChatRequest {
        model: route.model.clone(),
        messages: full,
        tools: if use_tools { tools::definitions_allowed(&settings.allowed_tools()) } else { vec![] },
        temperature: Some(settings.ai.temperature),
        max_tokens: settings.ai.max_tokens,
    };

    let (completion, meter, mut route) = complete_routed(&app, &state, &request_id, req, route).await?;
    route.reasons.extend(embed_note);
    Ok(ChatOutcome { completion, route, context, meter, cost_warning: cost_warning(&state), private: touched_private })
}

/// The client and model for embeddings, when an embedding model is set and its provider is on.
fn embedding_client(state: &AppState) -> Option<(Arc<AiClient>, ModelRef)> {
    let settings = state.settings();
    let model = settings.embedding_model.filter(|m| !m.trim().is_empty())?;
    let client = state.client_for(&settings.embedding_provider).ok()?;
    let r = ModelRef::new(&client.provider().id, model.trim());
    Some((client, r))
}

#[derive(Serialize)]
struct EmbeddingStatus {
    model: Option<String>,
    provider: String,
    /// Whether the assistant uses the model for its search.
    usable: bool,
    /// Why not (German), when a model is set.
    reason: Option<String>,
}

/// Whether the configured embedding model is used (Settings → KI shows why not, once).
#[tauri::command]
async fn ai_embedding_status(state: State<'_, AppState>) -> Result<EmbeddingStatus> {
    let settings = state.settings();
    let provider = settings.embedding_provider.clone();
    let Some((client, r)) = embedding_client(&state) else {
        let model = settings.embedding_model.filter(|m| !m.trim().is_empty());
        let reason = model.as_ref().map(|_| {
            tr!(
                "Der Anbieter des Embedding-Modells ist ausgeschaltet oder fehlt.",
                "The embedding model's provider is switched off or missing."
            )
            .into()
        });
        return Ok(EmbeddingStatus { model, provider, usable: false, reason });
    };
    learn_modes(&state, &client).await;
    let usable = lock(&state.caps).embedding_usable(&r);
    Ok(EmbeddingStatus { model: Some(r.model), provider, usable: usable.is_ok(), reason: usable.err() })
}

/// Streams `req` as `ai://stream` events for `request_id` (cancellable through `ai_cancel`)
/// and records the usage.
async fn stream_completion(
    app: &AppHandle,
    state: &AppState,
    client: &AiClient,
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
    let completion =
        result.inspect_err(|e| devlog::error("ai", format!("{} ({}): {e}", req.model, client.provider().id)))?;
    for w in &completion.warnings {
        devlog::warn("ai", format!("{} ({}): {w}", req.model, client.provider().id));
    }
    let u = &completion.usage;
    devlog::debug(
        "ai",
        format!(
            "{} ({}): {} + {} tokens, finish {:?}",
            u.model,
            client.provider().id,
            u.prompt_tokens,
            u.completion_tokens,
            completion.finish_reason
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

/// What the switched-on providers offer: their model lists, cached for a few minutes (a
/// provider that could not be asked for half a minute). A list is empty when unknown (the
/// provider does not list its models or cannot be reached: the request then shows the real error).
async fn catalog(state: &AppState) -> Catalog {
    const FRESH: Duration = Duration::from_secs(300);
    const RETRY: Duration = Duration::from_secs(30);
    let settings = state.settings();
    let mut models = HashMap::new();
    let mut ask = vec![];
    {
        let cache = lock(&state.server_models);
        for (id, client) in state.clients() {
            match cache.get(&id) {
                Some((at, list)) if at.elapsed() < if list.is_some() { FRESH } else { RETRY } => {
                    models.insert(id, list.clone().unwrap_or_default());
                }
                _ => ask.push((id, client)),
            }
        }
    }
    // The client's connect/read timeouts (Settings → Netzwerk) bound the wait, and so does this.
    for (id, res) in annalo_core::ai::client::list_models(&ask, Duration::from_secs(10)).await {
        let list = res.inspect_err(|e| devlog::debug("ai", format!("model list of “{id}”: {e}"))).ok();
        lock(&state.server_models).insert(id.clone(), (Instant::now(), list.clone()));
        models.insert(id, list.unwrap_or_default());
    }
    Catalog::new(settings.providers, models)
}

/// Streams `req` on the route's provider and model. A model its provider does not offer is
/// replaced by another configured model before sending; when the provider still has no
/// deployment for it or its backend fails, the request is repeated on another model, and when
/// the provider cannot be reached at all, on the next provider. A short cooldown of the model
/// (LiteLLM: „Try again in 5 seconds“) is waited out on the same model first. Parameters a
/// model rejected (tools, temperature) are left out for it from then on. Private content only
/// ever goes to the local tier's model or to providers marked local.
async fn complete_routed(
    app: &AppHandle,
    state: &AppState,
    request_id: &str,
    mut req: ChatRequest,
    route: RouteDecision,
) -> Result<(Completion, SessionMeter, RouteDecision)> {
    /// Waits for one model's cooldown per request.
    const MAX_WAITS: u32 = 2;
    let settings = state.settings();
    let local_only = settings.privacy.local_only;
    let mut catalog = catalog(state).await;
    let requested = format!("{} ({})", route.model, route.provider);
    let mut route = availability::resolve(&settings.router, &route, &catalog, local_only).map_err(Error::State)?;
    if format!("{} ({})", route.model, route.provider) != requested {
        devlog::warn(
            "ai",
            format!("“{requested}” is not offered, used “{} ({})” instead", route.model, route.provider),
        );
    }
    req.model = route.model.clone();
    let tools = std::mem::take(&mut req.tools);
    let temperature = req.temperature;
    let mut exclude = Exclude::default();
    let mut attempts = 0;
    let mut waits = 0;
    loop {
        attempts += 1;
        let current = ModelRef::new(&route.provider, &route.model);
        {
            let caps = lock(&state.caps);
            let skip_tools = !tools.is_empty() && caps.rejects_tools(&current);
            req.tools = if skip_tools { vec![] } else { tools.clone() };
            req.temperature = temperature.filter(|_| !caps.rejects_temperature(&current));
            // Said visibly once (when the server rejects them), later only in the route details.
            let told =
                trf!("„{}“ unterstützt keine Werkzeuge → ohne", "“{}” does not support tools → without", route.model);
            let note = trf!(
                "„{}“ ohne Werkzeuge (vom Server abgelehnt)",
                "“{}” without tools (rejected by the server)",
                route.model
            );
            if skip_tools && !route.reasons.contains(&told) && !route.reasons.contains(&note) {
                route.reasons.push(note);
            }
        }
        let client = state.client_for(&route.provider)?;
        let err = match stream_completion(app, state, &client, request_id, &req).await {
            Ok((c, m)) => return Ok((c, m, route)),
            Err(e) => e,
        };
        let down = availability::unreachable(&err);
        let mut retry = match &err {
            _ if down => availability::Retry::OtherModel,
            Error::Provider { status, body } => {
                availability::retry_for(*status, body, !req.tools.is_empty(), req.temperature.is_some())
            }
            _ => return Err(err),
        };
        let give_up = |err: Error| match err {
            Error::Provider { status, body } if availability::model_unavailable(status, &body) => {
                Error::State(availability::unavailable_message(&req.model, &body))
            }
            e => e,
        };
        if attempts >= 6 {
            return Err(give_up(err));
        }
        if matches!(retry, availability::Retry::Wait { .. }) && waits >= MAX_WAITS {
            retry = availability::Retry::OtherModel;
        }
        match retry {
            availability::Retry::Without { tools, temperature } => {
                devlog::warn(
                    "ai",
                    format!(
                        "“{}” rejects {}, repeating without (remembered for this session)",
                        req.model,
                        if tools { "tools" } else { "the temperature" }
                    ),
                );
                lock(&state.caps).rejected(&current, tools, temperature);
                if tools {
                    route.reasons.push(trf!(
                        "„{}“ unterstützt keine Werkzeuge → ohne",
                        "“{}” does not support tools → without",
                        route.model
                    ));
                }
            }
            availability::Retry::Wait { seconds } => {
                waits += 1;
                devlog::warn(
                    "ai",
                    format!(
                        "“{}” ({}) is cooling down on the server, retrying in {seconds} s",
                        req.model, route.provider
                    ),
                );
                let event = StreamEvent::Waiting { seconds, model: route.model.clone() };
                let _ = app.emit("ai://stream", StreamPayload { request_id, event: &event });
                if !wait_cancellable(state, request_id, Duration::from_secs(seconds)).await {
                    let completion = cancelled_completion(&req.model);
                    return Ok((completion, lock(&state.meter).clone(), route));
                }
                if !route.reasons.iter().any(|r| r.starts_with(tr!("Server kurz ausgelastet", "Server briefly busy"))) {
                    route.reasons.push(trf!(
                        "Server kurz ausgelastet → nach {seconds} s erneut „{}“",
                        "Server briefly busy → “{}” again after {seconds} s",
                        route.model
                    ));
                }
            }
            availability::Retry::OtherModel => {
                let failed = current;
                if down {
                    exclude.providers.push(failed.provider.clone());
                } else {
                    exclude.models.push(failed.clone());
                    // The list may be stale: ask this provider again before picking another model.
                    lock(&state.server_models).remove(&failed.provider);
                    catalog = self::catalog(state).await;
                }
                let private = availability::local_required(&route, local_only);
                let Some(next) = availability::fallback(&settings.router, route.tier, &catalog, &exclude, private)
                else {
                    if private && down {
                        devlog::warn(
                            "ai",
                            format!("“{}” not reachable, private content not sent elsewhere: {err}", failed.provider),
                        );
                        return Err(Error::State(trf!(
                            "{} ist nicht erreichbar. Vertrauliche Inhalte bleiben lokal: Sie gehen nicht an Anbieter, \
                             die nicht als lokal markiert sind.",
                            "{} is not reachable. Confidential content stays local: it does not go to providers \
                             that are not marked as local.",
                            catalog.name(&failed.provider)
                        )));
                    }
                    return Err(give_up(err));
                };
                let label = catalog.label(&next);
                devlog::warn(
                    "ai",
                    format!("“{}” ({}) failed: {err}; retrying on “{label}”", failed.model, failed.provider),
                );
                route.reasons.push(if down {
                    trf!("{} nicht erreichbar → {label}", "{} not reachable → {label}", catalog.name(&failed.provider))
                } else {
                    trf!(
                        "„{}“ ohne erreichbare Instanz → {label}",
                        "“{}” without a reachable instance → {label}",
                        failed.model
                    )
                });
                route.reasons.extend(availability::weaker_fallback_note(&settings.router, &catalog, &failed, &next));
                route.provider = next.provider;
                route.model = next.model.clone();
                req.model = next.model;
                waits = 0;
            }
            availability::Retry::No => return Err(give_up(err)),
        }
    }
}

/// Sleeps for `wait` unless the request is cancelled through `ai_cancel` meanwhile (then `false`).
async fn wait_cancellable(state: &AppState, request_id: &str, wait: Duration) -> bool {
    let cancel = Arc::new(AtomicBool::new(false));
    lock(&state.cancels).insert(request_id.to_owned(), cancel.clone());
    let end = Instant::now() + wait;
    let mut done = true;
    while Instant::now() < end {
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            done = false;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100).min(end - Instant::now())).await;
    }
    lock(&state.cancels).remove(request_id);
    done && !cancel.load(std::sync::atomic::Ordering::Relaxed)
}

/// The answer of a request stopped before anything arrived.
fn cancelled_completion(model: &str) -> Completion {
    Completion {
        content: String::new(),
        tool_calls: vec![],
        finish_reason: Some("cancelled".into()),
        usage: annalo_core::ai::UsageRecord {
            model: model.to_owned(),
            prompt_tokens: 0,
            completion_tokens: 0,
            cost_usd: 0.0,
            ttft_ms: None,
            tokens_per_second: None,
        },
        exact_usage: false,
        warnings: vec![],
    }
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
        return Err(Error::State(tr!("Keine Anweisung", "No instruction").into()));
    }
    prefs::check_cost_limit(&state, override_limit.unwrap_or(false))?;
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
        context.push(privacy::tag_text(&doc.tags));
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
    let (mut completion, meter, route) = complete_routed(&app, &state, &request_id, req, route).await?;
    completion.content = transform::clean_output(&completion.content);
    Ok(ChatOutcome { completion, route, context: vec![], meter, cost_warning: cost_warning(&state), private: false })
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
        return Err(Error::Parse(
            tr!(
                "Die Zeile braucht eine Dauer direkt nach /zeit, z. B. /zeit 2h Beschreibung",
                "The line needs a duration right after /time, e.g. /time 2h Description"
            )
            .into(),
        ));
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
        return Err(Error::State(
            tr!("Keine Netzpläne oder Vorgänge angelegt", "No networks or activities set up").into(),
        ));
    }
    // Without a usable provider (none, or all lack their key) there is nothing to ask.
    if !state.clients().iter().any(|(_, c)| c.has_key() || !c.provider().needs_key()) {
        return Err(Error::State(
            tr!("Keine KI verbunden (API-Schlüssel fehlt)", "No AI connected (API key missing)").into(),
        ));
    }
    prefs::check_cost_limit(&state, false)?;
    let messages = zeitguess::messages(&line, &candidates, &las, page.as_ref().map(|d| d.page.title.as_str()));
    let mut context = vec![line.clone()];
    if let Some(doc) = &page {
        context.push(doc.content.clone());
        context.push(privacy::tag_text(&doc.tags));
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
    let (completion, _, _) = complete_routed(&app, &state, &request_id, req, route).await?;
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
#[tauri::command(async)]
fn ai_plan_tool(state: State<AppState>, name: String, arguments: String) -> Result<ToolPlan> {
    state.settings().check_tool(&name)?;
    Ok(match tools::classify(&name) {
        Risk::Workspace => ToolPlan::Workspace,
        Risk::RequiresApproval => {
            let call = SystemCall::from_tool_call(&name, &arguments)?;
            ToolPlan::RequiresApproval { summary: call.describe(), call }
        }
    })
}

#[tauri::command(async)]
fn ai_run_workspace_tool(app: AppHandle, state: State<AppState>, name: String, arguments: String) -> Result<String> {
    state.settings().check_tool(&name)?;
    let args: serde_json::Value = serde_json::from_str(&arguments)?;
    let arg = |k: &str| args[k].as_str().unwrap_or_default().to_owned();
    let t = state.settings().thresholds;
    let db = state.db();
    // Pages whose text the result carries: a private one keeps the conversation local.
    let mut pages: Vec<i64> = vec![];
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
        "search_workspace" => {
            let hits = search::search(&db, &arg("query"), 10)?;
            pages.extend(hits.iter().filter_map(|h| match h {
                search::SearchHit::Page { page_id, .. } | search::SearchHit::Note { page_id, .. } => Some(*page_id),
                search::SearchHit::TimeEntry { .. } => None,
            }));
            serde_json::to_string(&hits)?.replace("\\u0002", "").replace("\\u0003", "")
        }
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
        "activity_log" => {
            let date = |k: &str| {
                NaiveDate::parse_from_str(arg(k).trim(), "%Y-%m-%d")
                    .map_err(|_| Error::Parse(format!("'{k}' muss ein Datum YYYY-MM-DD sein")))
            };
            let from = date("from")?;
            let to = if arg("to").trim().is_empty() { from } else { date("to")? };
            pages = annalo_core::feed::day_pages(&db, from, to, &Local)?;
            annalo_core::feed::describe_days(&db, from, to, &Local)?
        }
        "list_tasks" => {
            let filter: TaskFilter = serde_json::from_value(args.clone())?;
            let mut list = db.list_tasks(&filter)?;
            list.truncate(100);
            pages.extend(list.iter().map(|t| t.page_id));
            serde_json::to_string(&list)?
        }
        other => {
            return Err(Error::State(trf!(
                "„{other}“ ist kein Werkzeug des Arbeitsbereichs",
                "“{other}” is not a workspace tool"
            )));
        }
    };
    let markers = state.settings().router.private_markers;
    let private = privacy::private_pages(&db, pages, &markers)?;
    Ok(privacy::mark_tool_result(out, !private.is_empty(), &markers))
}

/// Executes a system tool. The UI calls this only after the user approved
/// the exact summary returned by `ai_plan_tool`.
#[tauri::command]
async fn ai_run_system_tool(app: AppHandle, state: State<'_, AppState>, call: SystemCall) -> Result<String> {
    let name = match &call {
        SystemCall::RunPowershell { .. } => "run_powershell",
        SystemCall::Git { .. } => "git",
        SystemCall::HttpRequest { .. } => "http_request",
        SystemCall::JiraComment { .. } => "jira_comment",
        SystemCall::JiraTransition { .. } => "jira_transition",
    };
    let settings = state.settings();
    settings.check_tool(name)?;
    if matches!(call, SystemCall::JiraComment { .. } | SystemCall::JiraTransition { .. }) {
        call.validate()?;
        return jira::run_write(&app, &call).await;
    }
    let http = network::client_for(&state, &Service::HttpTool)?;
    tools::execute_system_tool(&call, &http, network::timeout_for(&state, &Service::HttpTool)).await
}

/// Embeds note chunks that have no embedding yet. Returns the number indexed. An embedding
/// model on a provider that is not local gets no private pages (they stay keyword-searchable),
/// and nothing at all with Settings → Datenschutz „Nur lokal“.
#[tauri::command]
async fn ai_index_pending(state: State<'_, AppState>) -> Result<usize> {
    let settings = state.settings();
    if settings.embedding_model.as_deref().is_none_or(|m| m.trim().is_empty()) {
        return Err(Error::State(
            tr!("Kein Embedding-Modell in den Einstellungen gewählt", "No embedding model chosen in the settings")
                .into(),
        ));
    }
    let (client, r) = embedding_client(&state).ok_or_else(|| {
        Error::State(
            tr!(
                "Der Anbieter des Embedding-Modells ist nicht eingerichtet oder ausgeschaltet",
                "The embedding model's provider is not set up or switched off"
            )
            .into(),
        )
    })?;
    // Indexing is asked for explicitly, so a model with an unusual name is tried; one the
    // provider reports as a chat model is not (its failures would count against it).
    learn_modes(&state, &client).await;
    if let Some(mode) = lock(&state.caps).mode(&r).filter(|m| !capability::embedding_capable(&r.model, Some(m))) {
        return Err(Error::State(trf!(
            "„{}“ ist laut KI-Server kein Embedding-Modell (Typ „{mode}“). Wähle unter Einstellungen → KI & Modelle ein \
             Embedding-Modell oder „Keine (nur Stichwortsuche)“.",
            "According to the AI server “{}” is not an embedding model (type “{mode}”). Choose an embedding \
             model or “None (keyword search only)” under Settings → AI & models.",
            r.model
        )));
    }
    let model = r.model.clone();
    let local = client.provider().local;
    if !local && settings.privacy.local_only {
        return Err(Error::State(
            tr!(
                "Datenschutz „Nur lokal“: Das Embedding-Modell liegt bei einem Anbieter, der nicht als lokal markiert ist",
                "Privacy “Local only”: the embedding model is at a provider that is not marked as local"
            )
            .into(),
        ));
    }
    let mut total = 0;
    loop {
        // Indexing counts toward the monthly cost limit like any other request (a local model costs nothing).
        if !local {
            prefs::check_cost_limit(&state, false)?;
        }
        let batch = if local {
            rag::pending_blocks(&state.db(), 32)?
        } else {
            rag::pending_public_blocks(&state.db(), 32, &settings.router.private_markers)?
        };
        if batch.is_empty() {
            return Ok(total);
        }
        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let vectors = match client.embed(&model, &texts).await {
            Ok(v) => {
                lock(&state.caps).embed_succeeded(&r);
                v
            }
            Err(e) if lock(&state.caps).embed_failed(&r, &e) => {
                devlog::warn("ai", format!("indexing with “{model}” failed: {e}"));
                return Err(Error::State(trf!(
                    "„{model}“ liefert keine Embeddings ({}). Wähle unter Einstellungen → KI & Modelle ein Embedding-Modell \
                     oder „Keine (nur Stichwortsuche)“.",
                    "“{model}” returns no embeddings ({}). Choose an embedding model or “None (keyword search \
                     only)” under Settings → AI & models.",
                    capability::embedding_failure_text(&e)
                )));
            }
            Err(e) => return Err(e),
        };
        let usage = annalo_core::ai::metrics::embedding_usage(&model, &texts, &client.prices);
        let db = state.db();
        db.record_ai_usage(&state.session_id, &usage)?;
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

/// How often the activity sampler looks at the idle time (also the pace the timer's idle
/// detection expects: a much longer gap is the computer sleeping).
const IDLE_SAMPLE_INTERVAL: Duration = Duration::from_secs(5);

/// Samples input idleness and the foreground window every 5 seconds.
fn spawn_activity_sampler(app: AppHandle) {
    const INTERVAL: Duration = IDLE_SAMPLE_INTERVAL;
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
            security::tick(&app, idle);
            let window = probe.foreground_window();
            let threshold = Duration::from_secs(state.settings().idle_threshold_minutes * 60);
            let is_idle = idle.is_some_and(|d| d >= threshold);
            // Input within the last minute: the user is there (Morgen-Briefing on a new day).
            if idle.is_some_and(|d| d < Duration::from_secs(60)) {
                briefing::on_activity(&app);
            }
            // Time tracking off: no idle detection for a timer (one left running is not tracked).
            let running = state.settings().time_tracking() && state.db().running_timer().ok().flatten().is_some();
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
#[tauri::command(async)]
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

/// Test builds only: `ANNALO_SKIP_ONBOARDING=1` keeps the intro and the upgrade hint away (e2e).
fn skip_onboarding() -> bool {
    cfg!(debug_assertions) && std::env::var("ANNALO_SKIP_ONBOARDING").is_ok_and(|v| v == "1")
}

/// Whether to play the intro and setup, or to show the hint for upgraded workspaces.
#[tauri::command(async)]
fn onboarding_status(state: State<AppState>) -> Result<annalo_core::onboarding::OnboardingStatus> {
    state.db().onboarding_status(skip_onboarding())
}

/// Stores the settings the first-run flags changed (and tells the other windows).
fn onboarding_store(app: &AppHandle, state: &State<AppState>, settings: Settings) -> SettingsView {
    state.ai.write().unwrap_or_else(|e| e.into_inner()).settings = settings;
    // The setup may have switched time tracking: tray menu and jump list follow.
    desktop::refresh_tray(app);
    let _ = app.emit("settings://changed", ());
    settings_get(state.clone())
}

/// The setup was finished or closed: stores `onboarding.completed_version` and `completed_at`.
#[tauri::command(async)]
fn onboarding_complete(app: AppHandle, state: State<AppState>) -> Result<SettingsView> {
    let settings = state.db().onboarding_complete(Utc::now())?;
    Ok(onboarding_store(&app, &state, settings))
}

/// The one-time hint for an upgraded workspace was shown.
#[tauri::command(async)]
fn onboarding_hint_shown(state: State<AppState>) -> Result<()> {
    state.db().onboarding_hint_shown()
}

/// The notice of the rename to Arcalo was shown (once per workspace).
#[tauri::command(async)]
fn rebrand_notice_shown(state: State<AppState>) -> Result<()> {
    state.db().rebrand_notice_shown()
}

/// „Einrichtung zurücksetzen“: the first-run flags only; nothing else is touched.
#[tauri::command(async)]
fn onboarding_reset(app: AppHandle, state: State<AppState>) -> Result<SettingsView> {
    let settings = state.db().onboarding_reset()?;
    Ok(onboarding_store(&app, &state, settings))
}

/// Removes the sample project and pages created on first start.
#[tauri::command(async)]
fn demo_remove(app: AppHandle, state: State<AppState>) -> Result<usize> {
    let n = demo::remove(&state.db())?;
    let _ = app.emit("data://entries", ());
    Ok(n)
}

fn create_main_window(
    app: &tauri::App,
    visible: bool,
    geometry: Option<prefs::WindowState>,
    effect: annalo_core::prefs::WindowEffect,
    custom_frame: bool,
    webview_dir: Option<PathBuf>,
) -> tauri::Result<tauri::WebviewWindow> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, desktop::MAIN, tauri::WebviewUrl::default())
        .visible(visible)
        .title("Arcalo")
        .min_inner_size(900.0, 560.0)
        // The native file-drop handler swallows HTML5 drag & drop on Windows (image drop, tabs, sidebar).
        .disable_drag_drop_handler();
    // Portable: the webview's profile stays in the data folder, not in the user profile.
    if let Some(dir) = webview_dir {
        builder = builder.data_directory(dir);
    }
    builder = match geometry {
        Some(g) => {
            builder.inner_size(g.width as f64, g.height as f64).position(g.x as f64, g.y as f64).maximized(g.maximized)
        }
        None => builder.inner_size(1480.0, 920.0).center(),
    };
    // Transparent whenever an effect is possible, so switching one on later needs no restart.
    #[cfg(windows)]
    let builder = if backdrop::transparent_window() {
        let b = builder.transparent(true);
        match backdrop::initial(effect) {
            Some(effects) => b.effects(effects),
            None => b,
        }
    } else {
        builder
    };
    // Windows: own title bar. The UI draws the window buttons, the tab bar moves the window
    // (data-tauri-drag-region); resizing at the edges and the shadow stay with the system.
    #[cfg(windows)]
    let builder = builder.decorations(!custom_frame);
    CUSTOM_FRAME.store(cfg!(windows) && custom_frame, std::sync::atomic::Ordering::Relaxed);
    let _ = effect;
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

/// The main window is waiting to be shown for the first time (not when started minimized).
static PENDING_SHOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn show_main_once(app: &AppHandle, why: &str) {
    if !PENDING_SHOW.swap(false, std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    if why != "ui" {
        devlog::warn("desktop", format!("main window shown without the UI's first frame ({why})"));
    }
    if let Some(w) = app.get_webview_window(desktop::MAIN) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The UI painted its first frame (the splash, or the app when the splash is off).
#[tauri::command]
fn window_ready(app: AppHandle) {
    show_main_once(&app, "ui");
    // The health check of the update rollback: this version started fine.
    updates::mark_healthy(&app);
    desktop::precreate_capture(&app);
}

/// Whether the main window was created with the app's own title bar (Windows only).
static CUSTOM_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether the main window draws its own title bar (Settings → Darstellung, Windows). Reflects
/// the window as created: a changed setting applies at the next start.
#[tauri::command]
fn window_frame() -> bool {
    CUSTOM_FRAME.load(std::sync::atomic::Ordering::Relaxed)
}

/// The effects this system offers and the one the window shows (the UI then lets it show
/// through). None when switched off under Settings → Darstellung or not available.
#[tauri::command]
fn window_backdrop(state: State<AppState>) -> backdrop::Backdrop {
    backdrop::state(state.settings().appearance.window_effect)
}

/// Shows the effect (`none`, `mica`, `acrylic`) in the variant of the app theme. The UI passes
/// the effect, so a change applies before (and whether or not) the settings are saved.
#[tauri::command]
fn window_set_backdrop(app: AppHandle, effect: String, dark: bool) -> backdrop::Backdrop {
    let effect = annalo_core::prefs::WindowEffect::parse(&effect).unwrap_or_default();
    match app.get_webview_window(desktop::MAIN) {
        Some(w) => backdrop::apply(&w, effect, dark),
        None => backdrop::state(effect),
    }
}

#[derive(Serialize)]
struct AppInfo {
    version: &'static str,
    data_dir: String,
    platform: &'static str,
    /// Portable mode (data next to the executable, see `portable.rs`).
    portable: bool,
}

#[tauri::command]
fn app_info(state: State<AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        data_dir: state.data_dir.display().to_string(),
        platform: std::env::consts::OS,
        portable: portable::active(),
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
    /// Portable mode: the data folder is fixed next to the executable.
    portable: bool,
}

/// Folder of the settings shared by every workspace on this computer (see `settings_layers`):
/// the app's config folder; in portable mode the folder next to `data`; with
/// `ANNALO_DATA_DIR` (tests) `ANNALO_SHARED_SETTINGS_DIR` or the data folder itself.
fn shared_settings_dir(app: &AppHandle, data_dir: &std::path::Path) -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("ANNALO_SHARED_SETTINGS_DIR") {
        return Some(PathBuf::from(d));
    }
    if std::env::var_os("ANNALO_DATA_DIR").is_some() {
        return Some(data_dir.to_path_buf());
    }
    if portable::active() {
        return data_dir.parent().map(std::path::Path::to_path_buf);
    }
    app.path().app_config_dir().ok()
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
        portable: portable::active(),
    }
}

#[tauri::command]
fn data_dir_status(app: AppHandle, state: State<AppState>) -> DataDirStatus {
    data_dir_status_of(&app, &state)
}

fn data_dir_env_guard() -> Result<()> {
    if portable::active() {
        return Err(Error::State(
            tr!(
                "Im portablen Modus liegen die Daten immer im Ordner „data“ neben Arcalo.exe",
                "In portable mode the data is always in the “data” folder next to Arcalo.exe"
            )
            .into(),
        ));
    }
    if std::env::var_os("ANNALO_DATA_DIR").is_some() {
        return Err(Error::State(
            tr!("Der Speicherort ist über ANNALO_DATA_DIR festgelegt", "The location is set by ANNALO_DATA_DIR").into(),
        ));
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
            return Err(Error::State(trf!(
                "Im Zielordner liegt bereits ein Arbeitsbereich ({})",
                "The target folder already contains a workspace ({})",
                datadir::DB_FILE
            )));
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
    // A backup cut off by the exit would be a truncated newest backup, the one a recovery restores.
    let until = Instant::now() + Duration::from_secs(30);
    while matches!(BACKUP_RUNNING.try_lock(), Err(std::sync::TryLockError::WouldBlock)) && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(100));
    }
    EXIT_PREPARED.store(true, std::sync::atomic::Ordering::SeqCst);
    // A running recording is closed properly (its WAV file stays under `voice/`).
    voice::shutdown(app);
    if let Some(state) = app.try_state::<AppState>() {
        let mut db = state.db();
        let _ = db.checkpoint();
        // Dropping the connection closes the workspace; late writes land in memory.
        if let Ok(mem) = Database::open_in_memory() {
            *db = mem;
        }
        drop(db);
        for reader in &state.readers {
            if let Ok(mem) = Database::open_in_memory() {
                *lock(reader) = mem;
            }
        }
    }
    // Otherwise the new process would only focus this one.
    if portable::active() {
        portable::unlock_instance();
    } else {
        tauri_plugin_single_instance::destroy(app);
    }
}

/// The process ends: writes the WAL into the database file. Runs on the main thread, so it never
/// waits for a save in progress (that one stays in the WAL, which the next start reads).
fn checkpoint_on_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>()
        && let Ok(db) = state.db.try_lock()
    {
        let _ = db.checkpoint();
    }
}

/// Held while a backup is written (see [`prepare_exit`]).
static BACKUP_RUNNING: Mutex<()> = Mutex::new(());
/// [`prepare_exit`] ran; [`resume_after_failed_exit`] undoes it.
static EXIT_PREPARED: AtomicBool = AtomicBool::new(false);

/// The process did not end after all (the update installer or the new process could not be
/// started): opens the workspace again, so edits are not written into the in-memory stand-in.
pub(crate) fn resume_after_failed_exit(app: &AppHandle) {
    if !EXIT_PREPARED.swap(false, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    if let Some(state) = app.try_state::<AppState>() {
        let file = state.data_dir.join(datadir::DB_FILE);
        match Database::open(&file) {
            Ok(db) => *state.db() = db,
            Err(e) => devlog::error("core", format!("workspace not reopened after a failed restart: {e}")),
        }
        for reader in &state.readers {
            if let Ok(r) = Database::open_read_only(&file) {
                *lock(reader) = r;
            }
        }
        if portable::active() {
            portable::lock_instance(&state.data_dir);
        }
    }
    desktop::show_main(app);
}

pub(crate) fn restart(app: &AppHandle) -> Result<()> {
    let exe = tauri::process::current_binary(&app.env())?;
    prepare_exit(app);
    let args = std::env::args_os().skip(1).filter(|a| a != desktop::MINIMIZED_ARG && !notifyact::is_activation(a));
    if let Err(e) = std::process::Command::new(exe).args(args).spawn() {
        resume_after_failed_exit(app);
        return Err(e.into());
    }
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
    // A portable copy checks its own data folder instead (the identifier is shared with the
    // installed copy, which may run at the same time on its own data).
    let portable = portable::detect().filter(|_| std::env::var_os("ANNALO_DATA_DIR").is_none());
    if let Some(dir) = &portable
        && !portable::lock_instance(dir)
    {
        eprintln!("Arcalo already runs on {}", dir.display());
        return;
    }
    if std::env::var_os("ANNALO_DATA_DIR").is_none() && portable.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // A notification button (Windows starts Arcalo with its `arcalo-notify:` address).
            if let Some((subject, act)) = notifyact::from_args(&args) {
                return notifyact::activate(app, subject, act, true);
            }
            match jumplist::parse(&args) {
                // A taskbar jump-list entry while the app runs.
                Some(action) => jumplist::run(app, action, true),
                None => desktop::show_main(app),
            }
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
                    // Locked: every shortcut shows the lock screen (no capture, search or recording).
                    if security::is_locked() {
                        desktop::show_main(app);
                        return;
                    }
                    match desktop::shortcut_role(app, shortcut) {
                        Some(desktop::Role::Capture) => desktop::open_capture(app, false),
                        Some(desktop::Role::Selection) => desktop::open_capture(app, true),
                        Some(desktop::Role::Search) => desktop::open_search(app, true),
                        Some(desktop::Role::Mail) => mail::on_shortcut(app),
                        Some(desktop::Role::Voice) => voice::on_shortcut(app),
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
            // A pending move is carried out here, before the database is opened. A portable
            // copy (marker next to the executable) keeps its data in `<exe dir>/data`.
            let startup = datadir::prepare_portable(
                std::env::var_os("ANNALO_DATA_DIR").map(PathBuf::from),
                portable::detect(),
                app.path().app_config_dir().ok().as_deref(),
                app.path().app_data_dir()?,
            );
            let dir = startup.dir.clone();
            // Until the settings are read (and on the recovery screens): the system's language.
            annalo_core::i18n::set_lang(annalo_core::i18n::lang_of_locale(&os_locale().unwrap_or_default()));
            let folder_error = std::fs::create_dir_all(&dir).err();
            devlog::init(&dir);
            if let Some(e) = folder_error {
                recovery::show(app.handle(), &dir, recovery::Failure::Folder(Error::file(&dir, e).to_string()));
                return Ok(());
            }
            devlog::info(
                "core",
                format!(
                    "Arcalo {} started ({} {}), data folder {}{}",
                    env!("CARGO_PKG_VERSION"),
                    std::env::consts::OS,
                    std::env::consts::ARCH,
                    dir.display(),
                    if portable::active() { " (portable)" } else { "" }
                ),
            );
            if let Some(n) = &startup.notice {
                devlog::warn("core", format!("data folder: {}", n.message));
            }
            // Before the database is opened: failed starts of a fresh update offer the way back.
            let version = updates::current_version(app.handle());
            rollback::early_check(app.handle(), &dir, &version);
            // Started by the update (or after an installer that did not finish).
            let after_update = annalo_core::update::take_restart_marker(&dir, &version);
            if let Some(a) = &after_update {
                let how = if a.installed { "installed" } else { "not installed, still the old version" };
                devlog::info("update", format!("first start after the update to {}: {how}", a.version));
            }
            let opts: StartupOptions =
                std::env::var("ANNALO_STARTUP").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
            // A backup chosen under Settings → Sicherung → „Wiederherstellen“ replaces the database now.
            let restored = backupdest::apply_pending_restore(&dir);
            // Encrypted database: its key, a requested switch (Settings → Sicherheit), and the
            // recovery screen when the key is missing or wrong.
            let prepared = security::prepare(&dir);
            if let Some(reason) = prepared.blocked {
                security::show_keygate(app.handle(), &dir, reason);
                return Ok(());
            }
            let db = match Database::open(dir.join(datadir::DB_FILE)) {
                Ok(db) => db,
                Err(e) => {
                    recovery::show(app.handle(), &dir, recovery::Failure::of_database(&e));
                    return Ok(());
                }
            };
            security::opened(&dir);
            // Settings of an older version are brought up to date once, then the sections
            // shared by every workspace on this computer are taken over.
            match db.migrate_settings() {
                Ok(m) if m.ran() => devlog::info(
                    "settings",
                    format!("settings version {} → {}: {}", m.from, m.to, if m.notes.is_empty() { "no changes".to_owned() } else { m.notes.join("; ") }),
                ),
                Ok(_) => {}
                Err(e) => devlog::warn("settings", format!("settings migration failed: {e}")),
            }
            annalo_core::settings_layers::set_shared_dir(shared_settings_dir(app.handle(), &dir));
            match db.adopt_shared_settings() {
                Ok(taken) if !taken.is_empty() => {
                    devlog::info("settings", format!("shared settings taken over: {}", taken.join(", ")))
                }
                Ok(_) => {}
                Err(e) => devlog::warn("settings", format!("shared settings not read: {e}")),
            }
            // The language of the settings, as the UI shows it (the first run sets it from the
            // system's language).
            if let Ok(mut s) = db.load_settings() {
                annalo_core::i18n::set_lang(s.locale.language);
                annalo_core::i18n::set_number_format(s.locale.number_format);
                let page = |t: &str| db.page_by_title(t).ok().flatten().is_some();
                if annalo_core::capture::localize_inbox_title(&mut s.capture, s.locale.language, page) {
                    let _ = db.save_settings(&s);
                }
            }
            if let Err(e) = db.localize_default_leistungsarten() {
                devlog::warn("core", format!("activity types not localized: {e}"));
            }
            // A read-only folder (write-protected stick, permissions) still shows the notes,
            // with a notice that nothing is saved.
            let mut notice = prepared.notice.or(restored).or(startup.notice.clone());
            if !recovery::writable(&dir) {
                devlog::error("core", format!("data folder is not writable: {}", dir.display()));
                notice = Some(datadir::Notice::titled("error", tr!("Datenordner schreibgeschützt", "Data folder is read-only"), trf!(
                    "In den Datenordner {} kann nicht geschrieben werden (schreibgeschützt oder voll) – Änderungen \
                     werden nicht gespeichert.",
                    "The data folder {} cannot be written to (read-only or full) – changes are not saved.",
                    dir.display()
                )));
            }
            if opts.demo.unwrap_or(false) {
                demo::seed(&db, Utc::now())?;
            }
            // Once: a workspace from before 1.7 gets the notice of the rename to Arcalo (before
            // the intro's classification, whose first row tells a 1.6 workspace).
            if let Err(e) = db.rebrand_classify() {
                devlog::warn("rebrand", format!("rename check failed: {e}"));
            }
            // The autostart entry and shortcuts of the old name (every start; nothing once done).
            rebrand::migrate(app.handle());
            // Once: a workspace from before the intro is an upgrade (no intro, a hint instead).
            if let Err(e) = db.onboarding_classify() {
                devlog::warn("core", format!("first-run check failed: {e}"));
            }
            if let Err(e) = db.purge_expired_trash(Utc::now()) {
                devlog::warn("core", format!("trash cleanup failed: {e}"));
            }
            if let Err(e) = db.prune_versions(Utc::now()) {
                devlog::warn("core", format!("version cleanup failed: {e}"));
            }
            if let Err(e) = db.prune_history(Utc::now()) {
                devlog::warn("core", format!("activity cleanup failed: {e}"));
            }
            let trash_days = db.load_settings().map(|s| s.notes.trash_retention_days as i64).unwrap_or(30);
            if let Err(e) = attachment_manager::purge_expired_files(&dir, trash_days.max(1), Utc::now()) {
                devlog::warn("core", format!("file trash cleanup failed: {e}"));
            }
            if let Err(e) = db.migrate_palette_default() {
                devlog::warn("core", format!("settings migration failed: {e}"));
            }
            if let Err(e) = db.migrate_appearance_defaults() {
                devlog::warn("core", format!("appearance migration failed: {e}"));
            }
            if let Err(e) = db.migrate_activity_tool() {
                devlog::warn("core", format!("settings migration failed: {e}"));
            }
            feed::backfill(&db, &attachments::dir(&dir));
            let (settings, unreadable) = db.load_settings_checked()?;
            if !unreadable.is_empty() {
                // Kept for a look (and a fix by hand); the defaults are used meanwhile.
                if let Ok(Some(raw)) = db.conn().query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| {
                    r.get::<_, String>(0).map(Some)
                }) {
                    let _ = db.meta_set("settings.broken", &raw);
                }
                devlog::warn("core", format!("settings not readable, defaults used for: {}", unreadable.join(", ")));
                if notice.is_none() {
                    notice = Some(datadir::Notice::titled("warning", tr!("Einstellungen zurückgesetzt", "Settings reset"), trf!(
                        "Einige Einstellungen waren nicht lesbar und stehen wieder auf dem Standard ({}).",
                        "Some settings could not be read and are back at their defaults ({}).",
                        unreadable.join(", ")
                    )));
                }
            }
            // Network settings that cannot be applied (a missing CA file): requests fail with the
            // reason instead of going out without the proxy.
            network::policy_warnings(&settings.network);
            if let Err(e) = network::check(&settings.network)
                && notice.is_none()
            {
                notice = Some(datadir::Notice::titled("warning", tr!("Netzwerkeinstellungen ungültig", "Network settings invalid"), trf!(
                    "Netzwerkeinstellungen ungültig: {e} – KI-Anfragen und Links werden nicht gesendet, bis das unter \
                     Einstellungen → Netzwerk korrigiert ist.",
                    "Network settings invalid: {e} – AI requests and links are not sent until this is corrected under \
                     Settings → Network."
                )));
            }
            devlog::apply_settings(&settings);
            if let Err(e) = db.chat_prune(settings.ai.chat_history, Utc::now()) {
                devlog::warn("ai", format!("chat history cleanup failed: {e}"));
            }
            let shortcuts = [
                settings.capture_shortcut.clone(),
                settings.palette_shortcut.clone().unwrap_or_default(),
                settings.search_shortcut.clone(),
                settings.capture.selection_shortcut.clone(),
                settings.mail.shortcut.clone(),
                settings.voice.shortcut.clone(),
            ];
            secrets::init(&dir);
            let secrets = SecretStore::new(&dir);
            let proxy_passwords = network::passwords_of(&dir, &settings.network);
            let idle_threshold = Duration::from_secs(settings.idle_threshold_minutes * 60);
            let start = settings.start.clone();
            let effect = settings.appearance.window_effect;
            let custom_frame = settings.appearance.custom_titlebar;
            let geometry = prefs::saved_window(app.handle(), &settings);
            let keys = provider_keys(&dir, &settings.providers);
            let ai = AiRuntime::new(settings, &keys, &proxy_passwords);

            let readers = match (0..READERS)
                .map(|_| Database::open_read_only(dir.join(datadir::DB_FILE)))
                .collect::<annalo_core::Result<Vec<_>>>()
            {
                Ok(list) => list.into_iter().map(Mutex::new).collect(),
                Err(e) => {
                    devlog::warn("core", format!("no second connection for reading, reads share the main one: {e}"));
                    vec![]
                }
            };
            let state_dir = dir.clone();
            app.manage(AppState {
                db: Mutex::new(db),
                readers,
                next_reader: AtomicUsize::new(0),
                ai: RwLock::new(ai),
                secrets,
                git_secret: SecretStore::git(&dir),
                git_lock: Mutex::new(()),
                data_dir: dir,
                data_dir_notice: notice,
                meter: Mutex::new(SessionMeter::default()),
                session_id: Utc::now().format("%Y%m%dT%H%M%S").to_string(),
                idle: Mutex::new(IdleAccumulator::new(idle_threshold).sampled_every(IDLE_SAMPLE_INTERVAL)),
                usage: Mutex::new(WindowUsage::default()),
                cancels: Mutex::new(HashMap::new()),
                server_models: Mutex::new(HashMap::new()),
                caps: Mutex::new(Capabilities::default()),
            });

            // App-Sperre: locked before the first frame when it is on.
            security::init_lock(app.handle());
            app.manage(desktop::Desktop::default());
            app.manage(voice::Voice::default());
            app.manage(calsync::CalendarSync::default());
            app.manage(jira::JiraSync::default());
            // The window after an update always shows: the user clicked „Installieren“ and waits for it.
            let updated = after_update.is_some();
            app.manage(updates::Updates::after(after_update, rollback::take_notice(&state_dir)));
            updates::load_staged(app.handle());
            app.manage(backupdest::Destinations::default());
            // No tray (e.g. a Linux desktop without StatusNotifier): the app still works,
            // closing then minimizes instead of hiding.
            if let Err(e) = desktop::setup_tray(app.handle()) {
                devlog::warn("desktop", format!("tray icon not available: {e}"));
            }
            // The menu bar was built before the settings were read.
            #[cfg(target_os = "macos")]
            if let Ok(menu) = appmenu::build(app.handle()) {
                let _ = app.set_menu(menu);
            }
            let tray = app.state::<desktop::Desktop>().has_tray();
            // Autostart, or Settings → Start „Minimiert starten“: hidden in the tray, or minimized without one.
            let wants_minimized =
                !updated && (start.minimized || std::env::args().any(|a| a == desktop::MINIMIZED_ARG));
            let minimized = tray && wants_minimized;
            // A portable copy leaves the taskbar alone (the jump list lives in the user profile).
            if !portable::active() {
                jumplist::set_app_id(&app.config().identifier);
            }
            // Hidden until the UI has painted its first frame (`window_ready`): shown right away,
            // Windows showed the unstyled page, then the webview's white, then the splash.
            let webview_dir = portable::webview_dir(&app.state::<AppState>().data_dir);
            let window = create_main_window(app, false, geometry, effect, custom_frame, webview_dir)?;
            PENDING_SHOW.store(!minimized, std::sync::atomic::Ordering::Relaxed);
            // Should the UI never report (a script error), the window still appears.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                show_main_once(&handle, "fallback");
            });
            // Started from a taskbar jump-list entry: runs once the UI listens (`jump_take`).
            if let Some(action) = jumplist::parse(&std::env::args().collect::<Vec<_>>()) {
                jumplist::run(app.handle(), action, false);
            }
            // Started by a notification button while Arcalo was not running.
            notifyact::register(app.handle());
            if let Some((subject, act)) = notifyact::from_args(&std::env::args().collect::<Vec<_>>()) {
                notifyact::activate(app.handle(), subject, act, false);
            }
            jumplist::refresh(app.handle());
            if wants_minimized && !tray {
                let _ = window.minimize();
            }

            // Another instance may already own the shortcut; Ctrl+K still works in-app.
            // Registered one by one: one taken shortcut must not block the others.
            for (i, spec) in shortcuts.iter().enumerate() {
                let mut specs = [None; desktop::SLOTS];
                specs[i] = Some(spec.as_str());
                if let Err(e) = desktop::apply_shortcuts(app.handle(), specs) {
                    devlog::warn("desktop", format!("global shortcut not available: {e}"));
                }
            }
            spawn_activity_sampler(app.handle().clone());
            backupdest::init(app.handle());
            spawn_backup_scheduler(app.handle().clone());
            calsync::spawn_scheduler(app.handle().clone());
            timeblocks::spawn_scheduler(app.handle().clone());
            jira::spawn_scheduler(app.handle().clone());
            mail::clean_temp(app.handle());
            Ok(())
        })
        .invoke_handler(security::guard(tauri::generate_handler![
            security::keygate_status,
            security::keygate_unlock,
            security::keygate_quit,
            security::keygate_restore,
            security::keygate_open_folder,
            security::cipher_status,
            security::cipher_recovery_key,
            security::cipher_recovery_save,
            security::cipher_switch,
            security::cipher_password,
            security::cipher_drop_old,
            security::cipher_drop_plain_backups,
            security::applock_status,
            security::applock_configure,
            security::applock_unlock,
            security::applock_unlock_os,
            security::applock_reset,
            security::applock_lock_now,
            security::applock_flushed,
            security::applock_show_main,
            security::applock_test_idle,
            workspace_tree,
            page_get,
            page_save,
            page_collection,
            netzplan_overview,
            budgets_all,
            suggestion_facts,
            page_schema,
            known_persons,
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
            vault_import_cancel,
            vault_export,
            templates_list,
            templates_root,
            template_render,
            page_from_template,
            attachment_save,
            attachment_store,
            attachment_import,
            attachment_read,
            attachment_size,
            page_embed,
            diagram_file_write,
            link_title,
            html_file_write,
            drawing_create,
            drawing_read,
            drawing_save,
            files::attachments_list,
            files::attachment_rename,
            files::attachment_trash,
            files::attachments_trashed,
            files::attachment_restore,
            files::attachment_purge,
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
            backupdest::backup_destinations,
            backupdest::backup_destination_test,
            backupdest::backup_destination_retry,
            backupdest::backup_remote_list,
            backupdest::backup_restore,
            mirror_status,
            mirror_open,
            git_sync_now,
            git_sync_status,
            git_token_set,
            git_sync_test,
            git_restore_import,
            syncmerge::git_conflicts,
            syncmerge::git_conflict_get,
            syncmerge::git_conflict_resolve,
            syncmerge::git_conflict_keep_both,
            settings_get,
            settings_save,
            settings_scope_set,
            settings_sync_undo,
            api_key_set,
            ai_test_connection,
            provider_key_set,
            ai_provider_models,
            ai_provider_test,
            ollama_detect,
            ollama_pull,
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
            ai_embedding_status,
            network::network_status,
            network::network_test,
            network::network_services,
            network::network_service_test,
            network::network_certificate,
            network::network_legacy_probe,
            network::network_fetch_pac,
            network::network_ca_info,
            network::proxy_password_set,
            prefs::settings_export,
            prefs::settings_file_read,
            prefs::theme_export,
            prefs::theme_file_read,
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
            onboarding_status,
            onboarding_complete,
            onboarding_hint_shown,
            rebrand_notice_shown,
            onboarding_reset,
            window_backdrop,
            window_frame,
            window_ready,
            os_locale,
            jumplist::jump_take,
            window_set_backdrop,
            desktop::window_hide,
            desktop::window_close_action,
            desktop::app_quit,
            desktop::capture_submit,
            desktop::capture_hide,
            desktop::capture_show,
            desktop::capture_ready,
            desktop::capture_context,
            desktop::capture_undo,
            desktop::capture_open,
            desktop::search_hide,
            desktop::search_open,
            desktop::timer_resume_last,
            dashboard_save,
            dashboard::dashboard_data,
            dashboard::dashboard_file_write,
            dashboard::dashboard_inbox_move,
            worktime::absence_list,
            worktime::absence_save,
            worktime::absence_remove,
            worktime::mail_flagged,
            worktime::mail_flagged_open,
            worktime::mail_flagged_available,
            quick_links_save,
            quick_link_open,
            bookmarks::bookmarks_sources,
            bookmarks::bookmarks_read,
            bookmarks::bookmarks_read_file,
            bookmarks::bookmarks_read_text,
            attachment_open,
            desktop::desktop_info,
            desktop::autostart_set,
            chats::chat_list,
            chats::chat_get,
            chats::chat_create,
            chats::chat_append,
            chats::chat_truncate,
            chats::chat_update,
            chats::chat_delete,
            chats::chat_restore,
            chats::chat_delete_all,
            chats::chat_duplicate,
            focus::focus_state,
            focus::focus_start,
            focus::focus_finish,
            focus::focus_abort,
            focus::focus_end_break,
            focus::focus_report,
            focus::focus_daily_line,
            focus::focus_entry_ids,
            feed::activity_list,
            feed::activity_summary,
            feed::activity_people,
            present::presentation_begin,
            present::presentation_end,
            present::presenter_open,
            present::presenter_close,
            updates::update_status,
            updates::update_check,
            updates::update_install,
            updates::update_download,
            updates::update_pause,
            updates::update_restart_now,
            updates::update_skip,
            updates::update_unskip,
            updates::update_remind,
            updates::update_whats_new_seen,
            updates::update_rollback,
            updates::update_release_notes,
            devlog::devlog_write,
            devlog::devlog_read,
            devlog::devlog_stats,
            devlog::devlog_clear,
            devlog::devlog_open_folder,
            diagnostics::diagnostics_bundle,
            secrets::secrets_status,
            notifyact::notify_test,
            jira::jira_status,
            jira::jira_site_save,
            jira::jira_site_remove,
            jira::jira_test,
            jira::jira_wbs_set,
            jira::jira_sync_now,
            jira::jira_issues,
            jira::jira_index,
            jira::jira_issue_view,
            jira::jira_issue_fetch,
            jira::jira_issue_note,
            filing::filing_tidy_plan,
            filing::filing_tidy_apply,
            filing::pages_move,
            filing::move_last,
            filing::move_undo,
            filing::filing_preview,
            filing::folder_style_get,
            filing::folder_style_set,
            filing::smart_counts,
            filing::smart_pages,
            filing::smart_groups,
            graph::graph_data,
            graph::graph_patch,
            graph::graph_state_get,
            graph::graph_state_set,
            filing::page_create_filed,
            canvas::canvas_create,
            canvas::canvas_note_path,
            linking::mentions_get,
            linking::mentions_link,
            linking::mentions_ignore,
            linking::tags_suggest,
            linking::tags_dismiss,
            linking::tags_suggest_ai,
            linking::duplicates_for,
            linking::duplicates_all,
            linking::duplicates_ignore,
            linking::pages_merge,
            linking::pages_merge_undo,
            linking::pdf_highlights_list,
            linking::pdf_highlight_add,
            linking::pdf_highlight_update,
            linking::pdf_highlight_delete,
            linking::pdf_highlight_markdown,
            linking::page_append,
            jira::jira_add_task,
            jira::jira_entry_issues,
            jira::jira_projects,
            jira::jira_issue_types,
            jira::jira_create_issue,
            jira::jira_sprint,
            jira::jira_worklog_retry,
            jira::jira_tool,
            calsync::calendar_status,
            calsync::calendar_events,
            calsync::calendar_source_add,
            calsync::calendar_source_update,
            calsync::calendar_source_remove,
            calsync::calendar_sync_now,
            calsync::calendar_outlook_discover,
            calsync::calendar_outlook_update,
            calsync::calendar_outlook_people,
            calsync::calendar_set_skip,
            calsync::calendar_link_entry,
            calsync::calendar_wbs_hint,
            calsync::calendar_meeting_note,
            timeblocks::blocks_list,
            timeblocks::block_create,
            timeblocks::block_update,
            timeblocks::block_delete,
            timeblocks::block_task_done,
            timeblocks::block_free_slots,
            timeblocks::blocks_outlook_retry,
            weekplan::week_proposal,
            weekplan::week_proposal_apply,
            mail::mail_status,
            mail::mail_outlook_current,
            mail::mail_parse_file,
            mail::mail_parse_text,
            mail::mail_import,
            mail::mail_link_info,
            mail::mail_open,
            mail::mail_suggest,
            dayreview::day_review,
            dayreview::day_review_summary,
            briefing::briefing,
            briefing::briefing_summary,
            meetwork::meeting_prep,
            meetwork::meeting_prep_page,
            meetwork::meeting_prep_key,
            meetwork::status_scopes,
            meetwork::status_templates,
            meetwork::status_template_save,
            meetwork::status_template_delete,
            meetwork::status_last,
            meetwork::status_report,
            meetwork::page_markdown_write,
            meetwork::page_markdown_text,
            meetwork::mail_draft_available,
            meetwork::mail_draft,
            meetwork::followup_build,
            meetwork::followup_polish,
            briefing::briefing_start,
            voice::voice_devices,
            voice::voice_start,
            voice::voice_pause,
            voice::voice_stop,
            voice::voice_discard,
            voice::voice_status,
            voice::voice_job_cancel,
            voice::voice_summary_apply,
            voice::voice_models,
            voice::voice_model_download,
            voice::voice_model_cancel,
            voice::voice_model_import,
            voice::voice_model_delete,
            voice::voice_transcribe_again,
            voice::voice_unfinished,
            voice::voice_unfinished_save,
            voice::voice_unfinished_discard,
        ]))
        .build(tauri::generate_context!())
        .expect("error while running Arcalo")
        .run(on_run_event);
}

fn on_run_event(app: &AppHandle, event: tauri::RunEvent) {
    match event {
        // macOS: closing hides the window and the app stays in the Dock; clicking the Dock icon
        // (or opening Arcalo again) brings the window back, also while a popup is visible.
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => desktop::show_main(app),
        // The process ends: ⌘Q/„Beenden“ after the UI stored its editors, but also a quit the UI
        // never hears of (macOS: Dock menu „Beenden“, logging out).
        tauri::RunEvent::Exit => {
            // A downloaded update is installed (macOS, Linux; Windows at the next quit).
            updates::on_exit(app);
            checkpoint_on_exit(app);
            devlog::shutdown();
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_time_tracking_the_assistant_knows_nothing_about_booking() {
        let mut s = Settings::default();
        assert!(system_prompt(&s).contains("/zeit"));
        assert!(s.allowed_tools().iter().any(|t| t == "log_time"));
        s.time.enabled = false;
        let prompt = system_prompt(&s);
        assert!(!prompt.contains("/zeit") && !prompt.contains("Zeiterfassung") && !prompt.contains("NP-"), "{prompt}");
        let tools = s.allowed_tools();
        for t in tools::TIME_TOOLS {
            assert!(!tools.iter().any(|x| x == t), "{t} offered");
            assert!(s.check_tool(t).unwrap_err().to_string().contains("Zeiterfassung ist ausgeschaltet"));
        }
        assert!(tools.iter().any(|t| t == "list_tasks"));
        assert!(s.check_tool("list_tasks").is_ok());
    }

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
