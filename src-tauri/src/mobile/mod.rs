//! The Android app: the same state and commands as the desktop shell, without its windows, tray,
//! shortcuts and voice notes (see docs/android.md). Its updates are its own (`apkupdate.rs`): an
//! APK checked and handed to Android's installer.
//!
//! Two interfaces share this shell: the phone app (`ui/src/mobile/`, `mobile.html`) and, on large
//! screens (a tablet, desktop mode, an external display, Android on a PC), the full desktop app
//! (`index.html`, 1.20; `ui/src/lib/uiswitch.ts` chooses with [`android_display`]). Both use every
//! shared command but the desktop-only ones ([`crate::platform::DESKTOP_ONLY`]); the phone app
//! also uses the few below for what a phone does differently: the start screen in one call,
//! bookings that go into the daily note as chips, the sync followed by the reference data from
//! the desktop's database copy, the window around the WebView and text shared to the app.

pub mod android;
pub mod apkupdate;
pub mod keystore;

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;
use std::sync::{Mutex, RwLock};
use std::time::Duration;

use arcalo_core::activity::{IdleAccumulator, WindowUsage};
use arcalo_core::ai::capability::Capabilities;
use arcalo_core::ai::metrics::SessionMeter;
use arcalo_core::companion::{self, RecentTarget, ReferenceImport, Today};
use arcalo_core::gitsync::{self, SyncOutcome};
use arcalo_core::model::Page;
use arcalo_core::tracking::LogOutcome;
use arcalo_core::{Database, Error, datadir};
use chrono::{Local, NaiveDate, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::secrets::SecretStore;
use crate::{AiRuntime, AppState, Result, devlog, lock};

/// How often the app syncs while it is open (and the sync is on).
const SYNC_EVERY: Duration = Duration::from_secs(15 * 60);

#[tauri::mobile_entry_point]
pub fn run() {
    crate::PROCESS_START.get_or_init(std::time::Instant::now);
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        // The full app's questions and Android's document picker for files (1.20).
        .plugin(tauri_plugin_dialog::init())
        .plugin(keystore::plugin())
        .plugin(android::plugin())
        .register_uri_scheme_protocol("arcalo-asset", |ctx, request| {
            crate::serve_attachment(ctx.app_handle(), &request)
        })
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(off_main_thread(crate::commands()))
        .build(tauri::generate_context!())
        .expect("error while running Arcalo")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                crate::checkpoint_on_exit(app);
                devlog::shutdown();
            }
        });
}

/// Opens the workspace in the app's private folder and manages the shared state.
fn setup(app: &AppHandle) -> std::result::Result<(), Box<dyn std::error::Error>> {
    let dir = app.path().app_data_dir()?;
    let system = arcalo_core::i18n::lang_of_locale(&crate::os_locale().unwrap_or_default());
    arcalo_core::i18n::set_system_lang(system);
    arcalo_core::i18n::set_lang(system);
    std::fs::create_dir_all(&dir)?;
    devlog::init(&dir);
    if let Ok(cache) = app.path().app_cache_dir() {
        crate::picked::init(cache);
    }
    devlog::info(
        "core",
        format!("Arcalo {} (Android) started, data folder {}", env!("CARGO_PKG_VERSION"), dir.display()),
    );
    let db = Database::open(dir.join(datadir::DB_FILE))?;
    if let Err(e) = db.migrate_settings() {
        devlog::warn("settings", format!("settings migration failed: {e}"));
    }
    let settings = db.load_settings().unwrap_or_default();
    arcalo_core::i18n::set_lang(settings.locale.lang());
    arcalo_core::i18n::set_number_format(settings.locale.number_format);
    if let Err(e) = db.localize_default_leistungsarten() {
        devlog::warn("core", format!("activity types not localized: {e}"));
    }
    let _ = db.purge_expired_trash(Utc::now());
    let _ = db.prune_versions(Utc::now());
    let _ = db.prune_history(Utc::now());
    crate::secrets::init(&dir);
    #[cfg(target_os = "android")]
    if let Err(e) = gitsync::gitlib::init_tls(&dir) {
        devlog::warn("git", format!("certificates for HTTPS not written: {e}"));
    }
    let readers = (0..crate::READERS)
        .filter_map(|_| Database::open_read_only(dir.join(datadir::DB_FILE)).ok())
        .map(Mutex::new)
        .collect();
    // No AI on the phone: no keys are read (the Keystore is not asked before the UI runs).
    let ai = AiRuntime::new(settings, &HashMap::new(), &HashMap::new());
    app.manage(AppState {
        db: Mutex::new(db),
        readers,
        next_reader: AtomicUsize::new(0),
        ai: RwLock::new(ai),
        secrets: SecretStore::new(&dir),
        git_secret: SecretStore::git(&dir),
        git_lock: Mutex::new(()),
        data_dir: dir,
        data_dir_notice: None,
        meter: Mutex::new(SessionMeter::default()),
        session_id: Utc::now().format("%Y%m%dT%H%M%S").to_string(),
        idle: Mutex::new(IdleAccumulator::new(Duration::from_secs(3600))),
        usage: Mutex::new(WindowUsage::default()),
        cancels: Mutex::new(HashMap::new()),
        server_models: Mutex::new(HashMap::new()),
        caps: Mutex::new(Capabilities::default()),
    });
    app.manage(crate::calsync::CalendarSync::default());
    app.manage(crate::jira::JiraSync::default());
    app.manage(crate::semantic::Semantic::default());
    // Saving the settings tells the backup destinations (none on the phone) about it.
    app.manage(crate::backupdest::Destinations::default());
    app.manage(apkupdate::Updater::new(app, &app.state::<AppState>().data_dir));
    spawn_sync_scheduler(app.clone());
    apkupdate::spawn_scheduler(app.clone());
    spawn_network_watch(app.clone());
    // What the full app does in the background as on the desktop (each only when set up):
    // calendar subscriptions, Jira, the calendar's focus blocks, the index for search by meaning.
    crate::calsync::spawn_scheduler(app.clone());
    crate::jira::spawn_scheduler(app.clone());
    crate::timeblocks::spawn_scheduler(app.clone());
    crate::calwrite::spawn_scheduler(app.clone());
    crate::semantic::spawn_indexer(app.clone());
    spawn_ai_keys(app.clone());
    Ok(())
}

/// The assistant's keys are in the Android Keystore, which answers once the UI runs: read a few
/// seconds after the start, on a worker thread, and the AI clients built with them.
fn spawn_ai_keys(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let state = app.state::<AppState>();
        if state.settings().providers.iter().any(|p| p.enabled) {
            crate::rebuild_ai(&state, state.settings());
        }
    });
}

/// Android runs a command without `async` on the main thread, where the Kotlin plugins (the
/// Keystore, the window, the files picked) answer too: such a command that reads a secret would
/// wait forever. The full app's commands run on one worker thread instead, in the order they
/// came, as they would one after the other on the main thread; `async` ones go on from there.
fn off_main_thread<F>(inner: F) -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<tauri::ipc::Invoke<tauri::Wry>>();
    let worker = std::thread::Builder::new().name("commands".into()).spawn(move || {
        for invoke in rx {
            let resolver = invoke.resolver.clone();
            let command = invoke.message.command().to_owned();
            if !inner(invoke) {
                resolver.reject(format!("Command {command} not found"));
            }
        }
    });
    if let Err(e) = &worker {
        devlog::error("mobile", format!("no thread for the commands: {e}"));
    }
    move |invoke| {
        let resolver = invoke.resolver.clone();
        if tx.send(invoke).is_err() {
            resolver.reject("the app's commands are not available");
        }
        true
    }
}

/// How often Android's proxy and the user's certificates are read again (a Wi-Fi can bring a
/// proxy of its own); a sync reads them right before it, too.
const NETWORK_EVERY: Duration = Duration::from_secs(60);

fn spawn_network_watch(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            refresh_network(&app);
            std::thread::sleep(NETWORK_EVERY);
        }
    });
}

/// Android's proxy for mode „System“ of the network settings (the default: the app has no proxy
/// of its own, 1.19), and the certificates the user installed for the built-in git. Only off the
/// main thread: the Kotlin plugin answers on it.
fn refresh_network(app: &AppHandle) {
    static LAST: Mutex<Option<String>> = Mutex::new(None);
    match android::system_proxy() {
        Ok(p) => {
            let route = p.https.clone().unwrap_or_else(|| "direct".into());
            let seen = format!(
                "{route} (except {}){}",
                p.bypass,
                p.pac_url.as_deref().map(|u| format!(", PAC {u} not evaluated")).unwrap_or_default()
            );
            let mut last = lock(&LAST);
            if last.as_deref() != Some(seen.as_str()) {
                devlog::info("net", format!("Android proxy: {seen}"));
                *last = Some(seen);
            }
            arcalo_core::network::set_platform_proxy(Some(p));
        }
        Err(e) => devlog::warn("net", format!("Android proxy not read: {e}")),
    }
    #[cfg(target_os = "android")]
    add_user_certificates(app);
    #[cfg(not(target_os = "android"))]
    let _ = app;
}

/// The certificates the user installed, for the built-in git's HTTPS (the app's network security
/// config trusts them, see docs/android.md). Only between syncs: while one runs (it holds the
/// git lock) the bundle stays as it is, the next round or sync takes the change.
#[cfg(target_os = "android")]
fn add_user_certificates(app: &AppHandle) {
    let state = app.state::<AppState>();
    let _idle = match state.git_lock.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    match android::user_certificates() {
        Ok(pem) => match gitsync::gitlib::set_user_certificates(&pem) {
            Ok(true) => devlog::info("git", "the certificates installed by the user were added for HTTPS"),
            Ok(false) => {}
            Err(e) => devlog::warn("git", format!("user certificates not added: {e}")),
        },
        Err(e) => devlog::warn("git", format!("user certificates not read: {e}")),
    }
}

/// Syncs a few seconds after the start and then every [`SYNC_EVERY`] while the app runs (when
/// the sync is on); the UI syncs as well when the app comes back to the front.
fn spawn_sync_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            let gs = app.state::<AppState>().settings().git_sync;
            if gs.enabled && !gs.remote_url.trim().is_empty() && https_only(&gs.remote_url).is_ok() {
                let _ = sync_and_import(&app, false, None);
            }
            std::thread::sleep(SYNC_EVERY);
        }
    });
}

/// What the phone's sync did: the sync's outcome and what was taken over from the desktop's
/// database copy.
#[derive(Serialize)]
pub struct MobileSync {
    #[serde(flatten)]
    pub outcome: SyncOutcome,
    reference: ReferenceImport,
}

/// The sync (mirror, commit, merge with the server, pull) followed by the reference data.
pub(crate) fn sync_and_import(
    app: &AppHandle,
    allow_deletions: bool,
    after_restore: Option<gitsync::AfterRestore>,
) -> Result<MobileSync> {
    refresh_network(app);
    let outcome = crate::run_git_sync_with(app, false, allow_deletions, after_restore)?;
    let state = app.state::<AppState>();
    let copy = gitsync::db_copy(&state.git_repo_dir());
    let reference = {
        let db = state.db();
        companion::import_reference(&db, &copy, &state.data_dir, Utc::now())
    };
    let reference = match reference {
        Ok(r) => r,
        Err(e) => {
            devlog::warn("mobile", format!("reference data not taken over: {e}"));
            ReferenceImport { skipped: Some(e.to_string()), ..Default::default() }
        }
    };
    if reference.skipped.is_none() {
        devlog::info(
            "mobile",
            format!(
                "taken over from the desktop: {} Netzpläne, {} Vorgänge, {} appointments",
                reference.netzplaene, reference.vorgaenge, reference.events
            ),
        );
        let _ = app.emit("data://entries", ());
    }
    Ok(MobileSync { outcome, reference })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::State(e.to_string()))?
}

/// The settings (on a worker thread: the view names which secrets are set).
#[tauri::command(async)]
pub fn mobile_settings_get(state: State<AppState>) -> crate::SettingsView {
    crate::settings_get(state)
}

/// Saves the settings like the desktop (on a worker thread, see [`mobile_settings_get`]).
#[tauri::command(async)]
pub fn mobile_settings_save(
    app: AppHandle,
    state: State<AppState>,
    settings: serde_json::Value,
) -> Result<crate::SettingsView> {
    crate::settings_save(app, state, settings)
}

/// „Heute“: date, booked time and target, the timer, due tasks and today's appointments.
#[tauri::command(async)]
pub fn mobile_today(state: State<AppState>) -> Result<Today> {
    let settings = state.settings();
    companion::today(&state.reader(), &settings, Utc::now(), &Local)
}

/// The daily note of `date` (today without one); created only with `create`, so looking at an
/// empty day does not make a note that would meet the desktop's one as a conflict.
#[tauri::command(async)]
pub fn mobile_daily(state: State<AppState>, date: Option<NaiveDate>, create: bool) -> Result<Option<Page>> {
    let date = date.unwrap_or_else(|| Local::now().date_naive());
    companion::daily(&state.db(), date, create)
}

/// Books a `/zeit` line; its chip goes into the daily note.
#[tauri::command(async)]
pub fn mobile_book(app: AppHandle, state: State<AppState>, line: String) -> Result<LogOutcome> {
    let settings = state.settings();
    settings.require_time_tracking()?;
    let out = companion::book(&state.db(), &line, Utc::now(), &Local, &settings.thresholds)?;
    let _ = app.emit("data://entries", ());
    Ok(out)
}

/// Schnellerfassung of a note or a task: into today's daily note or the inbox.
#[tauri::command(async)]
pub fn mobile_capture(app: AppHandle, state: State<AppState>, text: String, inbox: bool) -> Result<Page> {
    let settings = state.settings();
    let target =
        if inbox { arcalo_core::capture::CaptureTarget::Inbox } else { arcalo_core::capture::CaptureTarget::Daily };
    let zone = arcalo_core::calsync::tz::Zone::Local;
    let opts = arcalo_core::capture::CaptureOptions {
        inbox_title: &settings.capture.inbox_title,
        thresholds: &settings.thresholds,
        zone: &zone,
        book_time: false,
    };
    let db = state.db();
    if !inbox {
        // A daily note pulled from the desktop is today's (no second one beside it).
        companion::daily(&db, Local::now().date_naive(), false)?;
    }
    let (out, _) = arcalo_core::capture::capture_to(&db, &text, &target, &opts, Utc::now(), &Local)?;
    let page_id = out
        .appended
        .map(|a| a.page_id)
        .ok_or_else(|| Error::State(arcalo_core::tr!("Nichts zu erfassen", "Nothing to capture").into()))?;
    let page = db.page(page_id)?;
    let _ = app.emit("data://pages", ());
    Ok(page)
}

/// Stops the timer; its booking (one per day over midnight) goes into the daily note as a chip
/// ([`companion::stop_timer`]).
#[tauri::command(async)]
pub fn mobile_timer_stop(app: AppHandle, state: State<AppState>) -> Result<Vec<arcalo_core::model::TimeEntry>> {
    let db = state.db();
    let kept = companion::stop_timer(&db, Utc::now(), &Local)?;
    lock(&state.idle).reset();
    drop(db);
    let _ = app.emit("data://entries", ());
    Ok(kept)
}

/// The references booked most recently (Netzplan, Vorgang, Leistungsart), newest first.
#[tauri::command(async)]
pub fn mobile_recent_targets(state: State<AppState>) -> Result<Vec<RecentTarget>> {
    companion::recent_targets(&state.reader(), 8)
}

/// „Jetzt synchronisieren“: the sync, then the desktop's projects and appointments.
#[tauri::command]
pub async fn mobile_sync(
    app: AppHandle,
    allow_deletions: Option<bool>,
    after_restore: Option<gitsync::AfterRestore>,
) -> Result<MobileSync> {
    if app.state::<AppState>().settings().git_sync.remote_url.trim().is_empty() {
        return Err(Error::State(
            arcalo_core::tr!(
                "Bitte zuerst die Remote-URL eintragen und speichern",
                "Enter and save the remote URL first"
            )
            .into(),
        ));
    }
    https_only(&app.state::<AppState>().settings().git_sync.remote_url)?;
    let allow = allow_deletions.unwrap_or(false);
    blocking(move || sync_and_import(&app, allow, after_restore)).await
}

/// The phone's git (libgit2 without SSH) reaches HTTP(S) remotes only; an SSH address gets a
/// message that says so instead of libgit2's „unsupported URL protocol“.
pub(crate) fn https_only(remote: &str) -> Result<()> {
    let l = remote.trim().to_ascii_lowercase();
    if l.starts_with("https://") || l.starts_with("http://") {
        return Ok(());
    }
    Err(Error::State(
        arcalo_core::tr!(
            "Auf dem Telefon geht nur eine HTTPS-Adresse mit Zugangstoken, kein SSH. Trage die HTTPS-Adresse des Repositorys ein.",
            "The phone supports HTTPS addresses with an access token only, no SSH. Enter the repository's HTTPS address."
        )
        .into(),
    ))
}

/// Text shared to the app from another one („Teilen“ → Arcalo), once; the UI opens a capture.
#[tauri::command(async)]
pub fn mobile_shared_text() -> Option<String> {
    android::shared_text().unwrap_or_else(|e| {
        devlog::warn("mobile", format!("shared text not read: {e}"));
        None
    })
}

/// The colors behind the system bars follow the app's theme (`#rrggbb`).
#[tauri::command(async)]
pub fn mobile_bars(dark: bool, top: String, bottom: String) {
    if let Err(e) = android::set_bars(dark, &top, &bottom) {
        devlog::warn("mobile", format!("system bar colors not set: {e}"));
    }
}

/// What the UI needs to choose between the phone app and the full app (`ui/src/lib/uiswitch.ts`):
/// the window and the device as Android reports them (none when it does not answer) and the
/// setting „Oberfläche“.
#[derive(Serialize)]
pub struct AndroidDisplay {
    facts: Option<android::DisplayFacts>,
    choice: &'static str,
}

#[tauri::command(async)]
pub fn android_display(state: State<AppState>) -> AndroidDisplay {
    let facts = android::display().map_err(|e| devlog::warn("mobile", format!("window and device not read: {e}"))).ok();
    AndroidDisplay { facts, choice: state.settings().appearance.android_interface.as_str() }
}

/// The back button on the start screen: the app goes to the background and keeps its state.
#[tauri::command(async)]
pub fn mobile_to_background() {
    if let Err(e) = android::move_to_back() {
        devlog::warn("mobile", format!("not moved to the background: {e}"));
    }
}
