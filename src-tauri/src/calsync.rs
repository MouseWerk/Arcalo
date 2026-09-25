//! Settings → Kalender and the Kalender view: sources (Outlook, ICS files and subscriptions),
//! background sync, events and what the user decides about them. The logic lives in
//! `annalo_core::calsync`.
//!
//! A sync reads its source without any database lock (Outlook's script and file reads in
//! `spawn_blocking`, downloads on the async runtime), parses off the runtime and only then
//! takes the database for one short transaction. Subscription addresses live in the
//! credential store (they may carry a secret token), never in the settings.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use annalo_core::Error;
use annalo_core::calsync::tz::Zone;
use annalo_core::calsync::{
    self as core, CalendarEvent, IcsKind, IcsSource, OUTLOOK, Privacy, SyncStatus, WbsHint, ics, outlook,
};
use annalo_core::model::Page;
use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::secrets::SecretStore;
use crate::{AppState, Result, devlog, lock};

/// Sources being synced right now (one sync per source at a time).
#[derive(Default)]
pub struct CalendarSync {
    running: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
pub struct SourceInfo {
    /// `outlook` or `ics:<id>`.
    id: String,
    name: String,
    /// `outlook`, `url` or `file`.
    kind: &'static str,
    color: String,
    enabled: bool,
    /// Scheme and host of a subscription (the full address stays in the credential store).
    address: String,
    /// Whether a subscription's address is stored.
    url_set: bool,
    path: String,
    status: Option<SyncStatus>,
    syncing: bool,
}

#[derive(Serialize)]
pub struct CalendarStatus {
    /// Outlook Classic can be read here (Windows, or the test fixture).
    outlook_available: bool,
    sources: Vec<SourceInfo>,
    /// Where subscription addresses are stored.
    secret_storage: &'static str,
}

fn secret(state: &AppState, id: &str) -> SecretStore {
    SecretStore::calendar(&state.data_dir, id)
}

fn status_of(app: &AppHandle) -> Result<CalendarStatus> {
    let state = app.state::<AppState>();
    let settings = state.settings().calendar;
    let statuses = state.reader().calendar_sync_status()?;
    let running = lock(&app.state::<CalendarSync>().running).clone();
    let status = |id: &str| statuses.iter().find(|s| s.source == id).cloned();
    let available = outlook::available();
    let mut sources = vec![];
    if available {
        sources.push(SourceInfo {
            id: OUTLOOK.into(),
            name: "Outlook".into(),
            kind: "outlook",
            color: settings.outlook_color.clone(),
            enabled: settings.outlook,
            address: String::new(),
            url_set: false,
            path: String::new(),
            status: status(OUTLOOK),
            syncing: running.contains(OUTLOOK),
        });
    }
    for s in &settings.sources {
        let id = s.source_id();
        let url = (s.kind == IcsKind::Url).then(|| secret(&state, &s.id).get()).flatten();
        sources.push(SourceInfo {
            name: s.name.clone(),
            kind: if s.kind == IcsKind::Url { "url" } else { "file" },
            color: s.color.clone(),
            enabled: s.enabled,
            address: url.as_deref().map(ics::display_url).unwrap_or_default(),
            url_set: url.is_some(),
            path: s.path.clone(),
            status: status(&id),
            syncing: running.contains(&id),
            id,
        });
    }
    Ok(CalendarStatus { outlook_available: available, sources, secret_storage: state.secrets.backend() })
}

#[tauri::command(async)]
pub fn calendar_status(app: AppHandle) -> Result<CalendarStatus> {
    status_of(&app)
}

/// Events of the active sources overlapping `from..to`.
#[tauri::command(async)]
pub fn calendar_events(state: State<AppState>, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<CalendarEvent>> {
    let active = state.settings().calendar.active_sources(outlook::available());
    state.reader().calendar_events(from, to, &active)
}

/// Saves only the calendar sources (the rest of the settings stays as it is).
fn save_sources(app: &AppHandle, f: impl FnOnce(&mut Vec<IcsSource>) -> Result<()>) -> Result<()> {
    let state = app.state::<AppState>();
    let mut settings = state.settings();
    f(&mut settings.calendar.sources)?;
    settings.calendar = settings.calendar.normalized();
    state.db().save_settings(&settings)?;
    state.ai.write().unwrap_or_else(|e| e.into_inner()).settings = settings;
    let _ = app.emit("settings://changed", ());
    Ok(())
}

/// Adds an ICS subscription (`url`, stored in the credential store) or file (`path`) and syncs it.
#[tauri::command(async)]
pub fn calendar_source_add(
    app: AppHandle,
    name: String,
    url: Option<String>,
    path: Option<String>,
) -> Result<CalendarStatus> {
    let state = app.state::<AppState>();
    let sources = state.settings().calendar.sources;
    if sources.len() >= core::MAX_SOURCES {
        return Err(Error::State(format!("Höchstens {} Kalender", core::MAX_SOURCES)));
    }
    let id = core::new_source_id(&sources);
    let (kind, path) = match (url.as_deref().map(str::trim).filter(|u| !u.is_empty()), path.as_deref().map(str::trim)) {
        (Some(u), _) => {
            ics::fetch_url(u)?;
            devlog::remember_secret(Some(u));
            secret(&state, &id).set(Some(u)).map_err(Error::State)?;
            (IcsKind::Url, String::new())
        }
        (None, Some(p)) if !p.is_empty() => {
            if !std::path::Path::new(p).is_file() {
                return Err(Error::State(format!("Die Datei „{p}“ gibt es nicht")));
            }
            (IcsKind::File, p.to_owned())
        }
        _ => return Err(Error::State("Bitte eine Kalender-Adresse oder eine .ics-Datei angeben".into())),
    };
    let color = core::PALETTE[(sources.len() + 1) % core::PALETTE.len()].to_owned();
    let source = IcsSource { id: id.clone(), name: name.trim().to_owned(), kind, path, color, enabled: true };
    save_sources(&app, |list| {
        list.push(source);
        Ok(())
    })?;
    spawn_sync(app.clone(), vec![format!("ics:{id}")]);
    status_of(&app)
}

/// Changes name, color, switch, file or address of an ICS source (`None` keeps a value).
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn calendar_source_update(
    app: AppHandle,
    id: String,
    name: Option<String>,
    color: Option<String>,
    enabled: Option<bool>,
    url: Option<String>,
    path: Option<String>,
) -> Result<CalendarStatus> {
    let state = app.state::<AppState>();
    let id = id.strip_prefix("ics:").unwrap_or(&id).to_owned();
    if let Some(u) = url.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        ics::fetch_url(u)?;
        devlog::remember_secret(Some(u));
        secret(&state, &id).set(Some(u)).map_err(Error::State)?;
    }
    let mut resync = url.is_some() || path.is_some() || enabled == Some(true);
    save_sources(&app, |list| {
        let s = list.iter_mut().find(|s| s.id == id).ok_or_else(|| Error::not_found("Kalender", id.clone()))?;
        if let Some(n) = name {
            s.name = n;
        }
        if let Some(c) = color {
            s.color = c;
        }
        if let Some(e) = enabled {
            resync &= !s.enabled;
            s.enabled = e;
        }
        if let Some(p) = path {
            s.path = p;
        }
        Ok(())
    })?;
    if resync {
        spawn_sync(app.clone(), vec![format!("ics:{id}")]);
    }
    status_of(&app)
}

/// Removes an ICS source with its address and its events.
#[tauri::command(async)]
pub fn calendar_source_remove(app: AppHandle, id: String) -> Result<CalendarStatus> {
    let state = app.state::<AppState>();
    let id = id.strip_prefix("ics:").unwrap_or(&id).to_owned();
    save_sources(&app, |list| {
        list.retain(|s| s.id != id);
        Ok(())
    })?;
    if let Err(e) = secret(&state, &id).set(None) {
        devlog::warn("calendar", format!("address of the removed calendar not deleted: {e}"));
    }
    state.db().calendar_remove_source(&format!("ics:{id}"))?;
    let _ = app.emit("calendar://synced", ());
    status_of(&app)
}

/// Syncs `source` (or every active source) now and waits for it.
#[tauri::command]
pub async fn calendar_sync_now(app: AppHandle, source: Option<String>) -> Result<CalendarStatus> {
    let active = app.state::<AppState>().settings().calendar.active_sources(outlook::available());
    let single = source.is_some();
    let ids: Vec<String> = match source {
        Some(s) => vec![s],
        None => active,
    };
    let mut errors = vec![];
    for id in ids {
        if let Err(e) = sync_source(&app, &id).await {
            errors.push(e.to_string());
        }
    }
    let status = status_of(&app)?;
    // One source asked for: its error is the answer (the status shows every source's).
    if single && !errors.is_empty() {
        return Err(Error::State(errors.remove(0)));
    }
    Ok(status)
}

/// Marks an appointment „nicht buchen“ (or takes the mark back).
#[tauri::command(async)]
pub fn calendar_set_skip(state: State<AppState>, key: String, skip: bool) -> Result<()> {
    state.db().calendar_set_skip(&key, skip)
}

/// Links a time entry booked from an appointment (booked mark, WBS suggestion next time).
#[tauri::command(async)]
pub fn calendar_link_entry(state: State<AppState>, key: String, entry_id: i64) -> Result<()> {
    state.db().calendar_link_entry(&key, entry_id)
}

/// The WBS last booked for this series or subject.
#[tauri::command(async)]
pub fn calendar_wbs_hint(state: State<AppState>, key: String) -> Result<Option<WbsHint>> {
    state.reader().calendar_wbs_hint(&key)
}

#[derive(Serialize)]
pub struct MeetingNote {
    page: Page,
    created: bool,
}

/// The meeting note of an appointment, created on first use.
#[tauri::command(async)]
pub fn calendar_meeting_note(state: State<AppState>, key: String) -> Result<MeetingNote> {
    let (page, created) = state.db().calendar_meeting_note(&key, &Zone::Local)?;
    Ok(MeetingNote { page, created })
}

/// Reads one source and replaces its events; records the outcome.
async fn sync_source(app: &AppHandle, id: &str) -> Result<usize> {
    {
        let sync = app.state::<CalendarSync>();
        let mut running = lock(&sync.running);
        if !running.insert(id.to_owned()) {
            return Err(Error::State("Dieser Kalender wird gerade synchronisiert".into()));
        }
    }
    let _ = app.emit("calendar://syncing", id);
    let result = read_source(app, id).await;
    let state = app.state::<AppState>();
    let now = Utc::now();
    let outcome = match result {
        Ok((from, to, events)) => {
            let n = state.db().calendar_replace(id, from, to, &events);
            match n {
                Ok(n) => {
                    let _ = state.db().calendar_record_sync(id, now, Ok(n));
                    devlog::debug("calendar", format!("{id}: {n} appointments"));
                    Ok(n)
                }
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(e),
    };
    if let Err(e) = &outcome {
        let msg = devlog::redact(&e.to_string());
        devlog::warn("calendar", format!("{id}: {msg}"));
        let _ = state.db().calendar_record_sync(id, now, Err(&msg));
    }
    lock(&app.state::<CalendarSync>().running).remove(id);
    let _ = app.emit("calendar://synced", id);
    outcome
}

type Window = (DateTime<Utc>, DateTime<Utc>);

/// The events of a source inside the sync window (no database lock is held meanwhile).
async fn read_source(app: &AppHandle, id: &str) -> Result<(DateTime<Utc>, DateTime<Utc>, Vec<core::NewEvent>)> {
    let state = app.state::<AppState>();
    let settings = state.settings().calendar;
    let zone = Zone::Local;
    let (from, to): Window = core::sync_window(Local::now().date_naive(), &settings, &zone);
    let privacy = Privacy::from(&settings);
    let join = |e: tauri::Error| Error::State(e.to_string());
    let events = if id == OUTLOOK {
        if !outlook::available() {
            return Err(Error::State("Outlook (klassisch) gibt es nur unter Windows".into()));
        }
        let dir = state.data_dir.join("scripts");
        let req = outlook::Request { from: zone.to_wall(from), to: zone.to_wall(to), privacy };
        tauri::async_runtime::spawn_blocking(move || outlook::read(&dir, req, &Zone::Local)).await.map_err(join)??
    } else {
        let src = settings.source(id).cloned().ok_or_else(|| Error::not_found("Kalender", id.to_owned()))?;
        let bytes = match src.kind {
            IcsKind::File => {
                let path = src.path.clone();
                tauri::async_runtime::spawn_blocking(move || read_file(&path)).await.map_err(join)??
            }
            IcsKind::Url => {
                let url = secret(&state, &src.id)
                    .get()
                    .ok_or_else(|| Error::State("Für diesen Kalender ist keine Adresse gespeichert".into()))?;
                let (http, network_error, timeout) = {
                    let ai = state.ai.read().unwrap_or_else(|e| e.into_inner());
                    (ai.tools_http.clone(), ai.network_error.clone(), ai.settings.network.timeout())
                };
                let http =
                    http.ok_or_else(|| Error::State(network_error.unwrap_or_else(|| "Kein Netzwerk-Client".into())))?;
                ics::fetch(&http, &url, timeout).await?
            }
        };
        tauri::async_runtime::spawn_blocking(move || ics::parse(&bytes, (from, to), &Zone::Local, privacy))
            .await
            .map_err(join)??
    };
    Ok((from, to, events))
}

fn read_file(path: &str) -> Result<Vec<u8>> {
    let p = std::path::Path::new(path);
    let meta =
        std::fs::metadata(p).map_err(|e| Error::State(format!("Die Kalenderdatei „{path}“ ist nicht lesbar: {e}")))?;
    if meta.len() as usize > ics::MAX_BYTES {
        return Err(Error::State(format!("Die Kalenderdatei „{path}“ ist größer als 30 MB")));
    }
    std::fs::read(p).map_err(|e| Error::State(format!("Die Kalenderdatei „{path}“ ist nicht lesbar: {e}")))
}

/// Syncs `ids` in the background.
pub fn spawn_sync(app: AppHandle, ids: Vec<String>) {
    tauri::async_runtime::spawn(async move {
        for id in ids {
            let _ = sync_source(&app, &id).await;
        }
    });
}

/// How long after the start the first background sync runs: 20 s, or
/// `ANNALO_CALENDAR_DELAY_SECS` (tests).
fn startup_delay() -> Duration {
    let secs = std::env::var("ANNALO_CALENDAR_DELAY_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(20);
    Duration::from_secs(secs)
}

/// Background sync: every active source whose last attempt is older than the interval.
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(startup_delay()).await;
        loop {
            let state = app.state::<AppState>();
            let settings = state.settings().calendar;
            let interval = chrono::TimeDelta::minutes(settings.sync_minutes as i64);
            let statuses = state.reader().calendar_sync_status().unwrap_or_default();
            let now = Utc::now();
            let due: Vec<String> = settings
                .active_sources(outlook::available())
                .into_iter()
                .filter(|id| {
                    statuses
                        .iter()
                        .find(|s| &s.source == id)
                        .and_then(|s| s.attempted_at)
                        .is_none_or(|t| now - t >= interval)
                })
                .collect();
            for id in due {
                let _ = sync_source(&app, &id).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
