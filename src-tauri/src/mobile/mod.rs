//! The Android companion app: the same state and commands as the desktop shell, without its
//! windows, tray, shortcuts, updates and voice notes (see docs/android.md).
//!
//! The UI (`ui/src/mobile/`) uses the shared commands for pages, tasks, time and the Git sync,
//! and the few below for what a phone does differently: the start screen in one call, bookings
//! that go into the daily note as chips, the sync followed by the reference data from the
//! desktop's database copy.

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
        .plugin(keystore::plugin())
        .register_uri_scheme_protocol("arcalo-asset", |ctx, request| {
            crate::serve_attachment(ctx.app_handle(), &request)
        })
        .setup(|app| {
            setup(app.handle())?;
            Ok(())
        })
        .invoke_handler(crate::security::guard(tauri::generate_handler![
            crate::workspace_tree,
            crate::page_get,
            crate::page_save,
            crate::page_create,
            crate::recent_pages,
            crate::search_workspace,
            crate::tasks_list,
            crate::tasks_compact,
            crate::task_set_done,
            crate::task_next_due,
            crate::wbs_tree,
            crate::leistungsarten_list,
            crate::timer_status,
            crate::timer_start,
            crate::timer_pause,
            crate::timer_discard,
            crate::time_entries,
            crate::delete_time_entry,
            crate::git_sync_status,
            crate::git_token_set,
            crate::git_sync_test,
            crate::syncmerge::git_conflicts,
            crate::syncmerge::git_conflict_get,
            crate::syncmerge::git_conflict_resolve,
            crate::syncmerge::git_conflict_keep_both,
            crate::app_info,
            crate::os_locale,
            mobile_settings_get,
            mobile_settings_save,
            mobile_today,
            mobile_daily,
            mobile_book,
            mobile_capture,
            mobile_timer_stop,
            mobile_recent_targets,
            mobile_sync,
        ]))
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
    // Saving the settings tells the backup destinations (none on the phone) about it.
    app.manage(crate::backupdest::Destinations::default());
    spawn_sync_scheduler(app.clone());
    Ok(())
}

/// Syncs a few seconds after the start and then every [`SYNC_EVERY`] while the app runs (when
/// the sync is on); the UI syncs as well when the app comes back to the front.
fn spawn_sync_scheduler(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(5));
        loop {
            let gs = app.state::<AppState>().settings().git_sync;
            if gs.enabled && !gs.remote_url.trim().is_empty() {
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
    outcome: SyncOutcome,
    reference: ReferenceImport,
}

/// The sync (mirror, commit, merge with the server, pull) followed by the reference data.
fn sync_and_import(
    app: &AppHandle,
    allow_deletions: bool,
    after_restore: Option<gitsync::AfterRestore>,
) -> Result<MobileSync> {
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
fn mobile_settings_get(state: State<AppState>) -> crate::SettingsView {
    crate::settings_get(state)
}

/// Saves the settings like the desktop (on a worker thread, see [`mobile_settings_get`]).
#[tauri::command(async)]
fn mobile_settings_save(
    app: AppHandle,
    state: State<AppState>,
    settings: serde_json::Value,
) -> Result<crate::SettingsView> {
    crate::settings_save(app, state, settings)
}

/// „Heute“: date, booked time and target, the timer, due tasks and today's appointments.
#[tauri::command(async)]
fn mobile_today(state: State<AppState>) -> Result<Today> {
    let settings = state.settings();
    companion::today(&state.reader(), &settings, Utc::now(), &Local)
}

/// The daily note of `date` (today without one); created only with `create`, so looking at an
/// empty day does not make a note that would meet the desktop's one as a conflict.
#[tauri::command(async)]
fn mobile_daily(state: State<AppState>, date: Option<NaiveDate>, create: bool) -> Result<Option<Page>> {
    let date = date.unwrap_or_else(|| Local::now().date_naive());
    companion::daily(&state.db(), date, create)
}

/// Books a `/zeit` line; its chip goes into the daily note.
#[tauri::command(async)]
fn mobile_book(app: AppHandle, state: State<AppState>, line: String) -> Result<LogOutcome> {
    let settings = state.settings();
    settings.require_time_tracking()?;
    let out = companion::book(&state.db(), &line, Utc::now(), &Local, &settings.thresholds)?;
    let _ = app.emit("data://entries", ());
    Ok(out)
}

/// Schnellerfassung of a note or a task: into today's daily note or the inbox.
#[tauri::command(async)]
fn mobile_capture(app: AppHandle, state: State<AppState>, text: String, inbox: bool) -> Result<Page> {
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
fn mobile_timer_stop(app: AppHandle, state: State<AppState>) -> Result<Vec<arcalo_core::model::TimeEntry>> {
    let db = state.db();
    let kept = companion::stop_timer(&db, Utc::now(), &Local)?;
    lock(&state.idle).reset();
    drop(db);
    let _ = app.emit("data://entries", ());
    Ok(kept)
}

/// The references booked most recently (Netzplan, Vorgang, Leistungsart), newest first.
#[tauri::command(async)]
fn mobile_recent_targets(state: State<AppState>) -> Result<Vec<RecentTarget>> {
    companion::recent_targets(&state.reader(), 8)
}

/// „Jetzt synchronisieren“: the sync, then the desktop's projects and appointments.
#[tauri::command]
async fn mobile_sync(
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
    let allow = allow_deletions.unwrap_or(false);
    blocking(move || sync_and_import(&app, allow, after_restore)).await
}
