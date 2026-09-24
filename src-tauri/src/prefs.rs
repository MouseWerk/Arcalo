//! Settings → Verwaltung (export, import, reset), the window geometry kept between starts
//! and the monthly AI cost status.

use std::path::{Path, PathBuf};

use annalo_core::Error;
use annalo_core::prefs::{self, CostLevel};
use annalo_core::settings::Settings;
use chrono::{Datelike, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::{AppState, Result};

/// Largest settings file that is read for an import.
const MAX_IMPORT_BYTES: u64 = 1024 * 1024;
/// Marker of an exported settings file.
pub const EXPORT_FORMAT: &str = "annalo-settings";

#[derive(Serialize)]
struct ExportFile<'a> {
    format: &'static str,
    version: u32,
    app_version: &'static str,
    exported_at: String,
    /// Secrets (API key, Git token, proxy password) are not part of the settings.
    settings: &'a Settings,
}

/// Writes all settings (no secrets) to `path` as JSON.
#[tauri::command(async)]
pub fn settings_export(state: State<'_, AppState>, path: String) -> Result<()> {
    let settings = state.settings();
    let file = ExportFile {
        format: EXPORT_FORMAT,
        version: 1,
        app_version: env!("CARGO_PKG_VERSION"),
        exported_at: Local::now().to_rfc3339(),
        settings: &settings,
    };
    std::fs::write(path.trim(), serde_json::to_string_pretty(&file)? + "\n")?;
    Ok(())
}

/// Reads a settings file for the import preview (JSON only, at most 1 MB). The UI
/// validates it and shows the differences before anything is saved.
#[tauri::command(async)]
pub fn settings_file_read(path: String) -> Result<String> {
    let path = PathBuf::from(path.trim());
    if !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        return Err(Error::State("Bitte eine .json-Datei wählen".into()));
    }
    if std::fs::metadata(&path)?.len() > MAX_IMPORT_BYTES {
        return Err(Error::State("Die Datei ist zu groß für eine Einstellungsdatei".into()));
    }
    Ok(std::fs::read_to_string(&path)?)
}

/// Writes a custom theme as a theme file (Settings → Darstellung → Exportieren).
#[tauri::command(async)]
pub fn theme_export(path: String, theme: prefs::CustomTheme) -> Result<()> {
    let theme = prefs::normalize_custom_themes(vec![theme])
        .pop()
        .ok_or_else(|| Error::State("Das Theme enthält ungültige Farben".into()))?;
    std::fs::write(path.trim(), prefs::theme_file_json(&theme))?;
    Ok(())
}

/// Reads and checks a theme file; the UI adds the theme to the custom themes.
#[tauri::command(async)]
pub fn theme_file_read(path: String) -> Result<prefs::CustomTheme> {
    let text = settings_file_read(path)?;
    prefs::parse_theme_file(&text).map_err(Error::State)
}

/// The defaults of one settings section (`network`, `appearance`, …), or of all settings
/// with `section = None`; the UI saves them through `settings_save`.
#[tauri::command]
pub fn settings_defaults(state: State<'_, AppState>, section: Option<String>) -> Result<Settings> {
    match section {
        Some(sec) => {
            let mut s = state.settings();
            s.reset_section(&sec)?;
            Ok(s)
        }
        None => {
            // Connection settings that cannot be re-entered from memory stay.
            let cur = state.settings();
            Ok(Settings {
                litellm_base_url: cur.litellm_base_url,
                router: annalo_core::ai::router::RouterConfig {
                    local_model: cur.router.local_model,
                    standard_model: cur.router.standard_model,
                    reasoning_model: cur.router.reasoning_model,
                    ..Default::default()
                },
                embedding_model: cur.embedding_model,
                pernr: cur.pernr,
                jira_issue_map: cur.jira_issue_map,
                backup_dir: cur.backup_dir,
                markdown_mirror_dir: cur.markdown_mirror_dir,
                git_sync: cur.git_sync,
                ..Default::default()
            })
        }
    }
}

// ------------------------------------------------------------ window state

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
pub struct WindowState {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

fn window_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("window.json"))
}

pub fn load_window_state(path: &Path) -> Option<WindowState> {
    let s: WindowState = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    (s.width >= 400 && s.height >= 300 && s.width <= 20_000 && s.height <= 20_000).then_some(s)
}

/// The saved geometry of the main window, if restoring is on.
pub fn saved_window(app: &AppHandle, settings: &Settings) -> Option<WindowState> {
    if !settings.start.restore_window {
        return None;
    }
    load_window_state(&window_file(app)?)
}

/// Remembers the main window's position and size (the UI reports them after moves).
#[tauri::command(async)]
pub fn window_state_save(app: AppHandle) -> Result<()> {
    let Some(w) = app.get_webview_window("main") else { return Ok(()) };
    if w.is_minimized().unwrap_or(false) || !w.is_visible().unwrap_or(true) {
        return Ok(());
    }
    let maximized = w.is_maximized().unwrap_or(false);
    let scale = w.scale_factor().unwrap_or(1.0);
    let pos = w.outer_position().map_err(|e| Error::State(e.to_string()))?.to_logical::<i32>(scale);
    let size = w.inner_size().map_err(|e| Error::State(e.to_string()))?.to_logical::<u32>(scale);
    let path = window_file(&app).ok_or_else(|| Error::State("Kein Konfigurationsordner".into()))?;
    let mut state = WindowState { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized };
    // A maximized window keeps the normal geometry saved before.
    if maximized && let Some(old) = load_window_state(&path) {
        state = WindowState { maximized: true, ..old };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, serde_json::to_string(&state)?)?;
    Ok(())
}

// --------------------------------------------------------------- AI costs

#[derive(Serialize)]
pub struct CostStatus {
    spent_usd: f64,
    limit_usd: Option<f64>,
    #[serde(flatten)]
    pub level: CostLevel,
}

/// Start of the current month in local time, as UTC.
fn month_start() -> chrono::DateTime<Utc> {
    let now = Local::now();
    Local
        .with_ymd_and_hms(now.year(), now.month(), 1, 0, 0, 0)
        .earliest()
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(Utc::now)
}

pub fn cost_status_of(state: &AppState) -> Result<CostStatus> {
    let limit = state.settings().ai.monthly_cost_limit_usd;
    let spent = state.db().ai_cost_since(month_start())?;
    Ok(CostStatus { spent_usd: spent, limit_usd: limit, level: prefs::cost_level(spent, limit) })
}

/// This month's AI costs against the limit (Settings → KI).
#[tauri::command]
pub fn ai_cost_status(state: State<'_, AppState>) -> Result<CostStatus> {
    cost_status_of(&state)
}

/// Refuses a request when the monthly limit is reached, unless the user overrode it.
pub fn check_cost_limit(state: &AppState, override_limit: bool) -> Result<()> {
    if override_limit {
        return Ok(());
    }
    let s = cost_status_of(state)?;
    if let CostLevel::Blocked { .. } = s.level {
        return Err(Error::State(format!(
            "{COST_LIMIT_PREFIX} {:.2} von {:.2} USD in diesem Monat verbraucht",
            s.spent_usd,
            s.limit_usd.unwrap_or_default()
        )));
    }
    Ok(())
}

/// Start of the error message of a blocked request (the UI offers „Trotzdem senden“).
pub const COST_LIMIT_PREFIX: &str = "KI-Kostenlimit erreicht:";
