//! Settings → Kalender and the Kalender view: sources (the selected Outlook calendars, ICS files
//! and subscriptions), background sync, events and what the user decides about them. The logic
//! lives in `annalo_core::calsync`.
//!
//! The selected Outlook calendars are read by one run of the script (Outlook starts once);
//! each keeps its own events and status. Discovery („Kalender auswählen“) runs on demand and
//! its result is kept for this session.
//!
//! A sync reads its source without any database lock (Outlook's script and file reads in
//! `spawn_blocking`, downloads on the async runtime), parses off the runtime and only then
//! takes the database for one short transaction. Subscription addresses live in the
//! credential store (they may carry a secret token), never in the settings.

use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use annalo_core::calsync::calendars::{self, DiscoveredCalendar, OutlookChoice};
use annalo_core::calsync::tz::Zone;
use annalo_core::calsync::{
    self as core, CalendarEvent, IcsKind, IcsSource, OutlookCalendar, Privacy, SyncStatus, WbsHint, ics, outlook,
};
use annalo_core::model::Page;
use annalo_core::{Error, tr, trf};
use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::secrets::SecretStore;
use crate::{AppState, Result, devlog, lock};

/// Sources being synced right now (one sync per source at a time), and what discovery found.
#[derive(Default)]
pub struct CalendarSync {
    running: Mutex<HashSet<String>>,
    discovery: Mutex<Discovery>,
}

/// The last discovery of Outlook calendars (this session).
#[derive(Default, Clone, Serialize)]
pub struct Discovery {
    running: bool,
    at: Option<DateTime<Utc>>,
    error: Option<String>,
    #[serde(skip)]
    found: Option<Vec<DiscoveredCalendar>>,
}

#[derive(Serialize)]
pub struct SourceInfo {
    /// `outlook`, `outlook:<hash>` or `ics:<id>`.
    id: String,
    name: String,
    /// `outlook`, `url` or `file`.
    kind: &'static str,
    /// Mailbox or person of an Outlook calendar.
    owner: String,
    /// Someone else's calendar (colleague, shared mailbox, room, group).
    shared: bool,
    /// Only free/busy times are readable.
    free_busy: bool,
    /// Its meetings are proposed for booking.
    booking: bool,
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

/// A row of „Kalender auswählen“ with its sync status.
#[derive(Serialize)]
pub struct OutlookRow {
    #[serde(flatten)]
    choice: OutlookChoice,
    shared: bool,
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
    /// „Kalender auswählen“: stored and discovered Outlook calendars.
    outlook_calendars: Vec<OutlookRow>,
    discovery: Discovery,
}

pub(crate) fn secret(state: &AppState, id: &str) -> SecretStore {
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
    let discovery = lock(&app.state::<CalendarSync>().discovery).clone();
    let mut outlook_calendars = vec![];
    if available {
        for c in &settings.outlook_calendars {
            // The default calendar is listed always (its switch is „Outlook-Kalender lesen“).
            if !c.default && !c.enabled {
                continue;
            }
            sources.push(SourceInfo {
                id: c.id.clone(),
                name: c.label(),
                kind: "outlook",
                owner: c.owner.clone(),
                shared: c.kind.shared(),
                free_busy: c.free_busy,
                booking: c.booking,
                color: c.color.clone(),
                enabled: settings.outlook && c.enabled,
                address: String::new(),
                url_set: false,
                path: String::new(),
                status: status(&c.id),
                syncing: running.contains(&c.id),
            });
        }
        outlook_calendars = calendars::choices(&settings.outlook_calendars, discovery.found.as_deref())
            .into_iter()
            .map(|choice| OutlookRow {
                shared: choice.calendar.kind.shared(),
                status: status(&choice.calendar.id),
                syncing: running.contains(&choice.calendar.id),
                choice,
            })
            .collect();
    }
    for s in &settings.sources {
        let id = s.source_id();
        let url = (s.kind == IcsKind::Url).then(|| secret(&state, &s.id).get()).flatten();
        sources.push(SourceInfo {
            name: s.name.clone(),
            kind: if s.kind == IcsKind::Url { "url" } else { "file" },
            owner: String::new(),
            shared: false,
            free_busy: false,
            booking: true,
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
    Ok(CalendarStatus {
        outlook_available: available,
        sources,
        secret_storage: state.secrets.backend(),
        outlook_calendars,
        discovery,
    })
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
    save_calendar(app, |cal| f(&mut cal.sources))
}

/// Saves only the calendar settings, changed by `f` (the rest stays as it is).
fn save_calendar(app: &AppHandle, f: impl FnOnce(&mut core::CalendarSettings) -> Result<()>) -> Result<()> {
    let state = app.state::<AppState>();
    let mut settings = state.settings();
    f(&mut settings.calendar)?;
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
        return Err(Error::State(trf!("Höchstens {} Kalender", "At most {} calendars", core::MAX_SOURCES)));
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
                return Err(Error::State(trf!("Die Datei „{p}“ gibt es nicht", "The file “{p}” does not exist")));
            }
            (IcsKind::File, p.to_owned())
        }
        _ => {
            return Err(Error::State(
                tr!(
                    "Bitte eine Kalender-Adresse oder eine .ics-Datei angeben",
                    "Enter a calendar address or an .ics file"
                )
                .into(),
            ));
        }
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
        let s = list.iter_mut().find(|s| s.id == id).ok_or_else(|| Error::not_found("calendar", id.clone()))?;
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

/// Lists the calendars of Outlook (default, further folders, other mailboxes and PSTs,
/// calendars shared by colleagues, rooms, groups) and keeps the list for this session. What
/// it finds about stored calendars (names, paths, whether only free/busy is readable) is
/// taken over into the settings.
#[tauri::command]
pub async fn calendar_outlook_discover(app: AppHandle) -> Result<CalendarStatus> {
    if !outlook::available() {
        return Err(Error::State("Outlook (klassisch) gibt es nur unter Windows".into()));
    }
    {
        let sync = app.state::<CalendarSync>();
        let mut d = lock(&sync.discovery);
        if d.running {
            return Err(Error::State(
                tr!("Die Kalender werden gerade gesucht", "The calendars are being searched right now").into(),
            ));
        }
        d.running = true;
    }
    let _ = app.emit("calendar://syncing", "discovery");
    let state = app.state::<AppState>();
    let dir = state.data_dir.join("scripts");
    let people = state.settings().calendar.outlook_recipients;
    let result = tauri::async_runtime::spawn_blocking(move || outlook::discover(&dir, &people))
        .await
        .map_err(|e| Error::State(e.to_string()))
        .and_then(|r| r);
    {
        let sync = app.state::<CalendarSync>();
        let mut d = lock(&sync.discovery);
        d.running = false;
        d.at = Some(Utc::now());
        match &result {
            Ok(found) => {
                d.found = Some(found.clone());
                d.error = None;
            }
            Err(e) => d.error = Some(devlog::redact(&e.to_string())),
        }
    }
    let _ = app.emit("calendar://synced", "discovery");
    let found = result?;
    devlog::debug("calendar", format!("Outlook: {} calendars found", found.len()));
    let stale = {
        let cal = state.settings().calendar;
        cal.outlook_calendars.iter().any(|c| {
            found.iter().find(|d| d.id == c.id).is_some_and(|d| {
                let mut fresh = c.clone();
                calendars::refresh(&mut fresh, d);
                fresh != *c
            })
        })
    };
    if stale {
        save_calendar(&app, |cal| {
            for c in cal.outlook_calendars.iter_mut() {
                if let Some(d) = found.iter().find(|d| d.id == c.id) {
                    calendars::refresh(c, d);
                }
            }
            Ok(())
        })?;
    }
    status_of(&app)
}

/// Selects an Outlook calendar (or changes its color or its „Für Buchungsvorschläge
/// verwenden“); `None` keeps a value. A calendar only discovered so far is stored with it.
/// Switched on, it syncs at once.
#[tauri::command(async)]
pub fn calendar_outlook_update(
    app: AppHandle,
    id: String,
    enabled: Option<bool>,
    color: Option<String>,
    booking: Option<bool>,
) -> Result<CalendarStatus> {
    let found = lock(&app.state::<CalendarSync>().discovery).found.clone().unwrap_or_default();
    let mut resync = false;
    save_calendar(&app, |cal| {
        if !cal.outlook_calendars.iter().any(|c| c.id == id) {
            let d = found.iter().find(|d| d.id == id).ok_or_else(|| Error::not_found("calendar", id.clone()))?;
            if cal.outlook_calendars.len() >= calendars::MAX_CALENDARS {
                return Err(Error::State(trf!(
                    "Höchstens {} Outlook-Kalender",
                    "At most {} Outlook calendars",
                    calendars::MAX_CALENDARS
                )));
            }
            let mut c = OutlookCalendar::from(d);
            let used: Vec<String> = cal.outlook_calendars.iter().map(|c| c.color.clone()).collect();
            c.color = calendars::next_color(&used);
            c.enabled = false;
            cal.outlook_calendars.push(c);
        }
        let outlook_on = cal.outlook;
        let c = cal
            .outlook_calendars
            .iter_mut()
            .find(|c| c.id == id)
            .ok_or_else(|| Error::not_found("calendar", id.clone()))?;
        if let Some(e) = enabled {
            resync = e && !c.enabled && outlook_on;
            c.enabled = e;
        }
        if let Some(b) = booking {
            c.booking = b;
        }
        if let Some(col) = color {
            c.color = col.trim().to_ascii_lowercase();
            if c.default {
                cal.outlook_color = c.color.clone();
            }
        }
        Ok(())
    })?;
    if resync {
        spawn_sync(app.clone(), vec![id]);
    }
    let _ = app.emit("calendar://synced", ());
    status_of(&app)
}

/// Sets the people whose calendars discovery opens by name, then discovers again.
#[tauri::command]
pub async fn calendar_outlook_people(app: AppHandle, people: Vec<String>) -> Result<CalendarStatus> {
    save_calendar(&app, |cal| {
        cal.outlook_recipients = people;
        Ok(())
    })?;
    calendar_outlook_discover(app).await
}

/// Syncs `source` (or every active source; `outlook:*`: every selected Outlook calendar) now
/// and waits for it.
#[tauri::command]
pub async fn calendar_sync_now(app: AppHandle, source: Option<String>) -> Result<CalendarStatus> {
    let active = app.state::<AppState>().settings().calendar.active_sources(outlook::available());
    let single = source.as_deref().is_some_and(|s| s != "outlook:*");
    let ids: Vec<String> = match source {
        Some(s) if s == "outlook:*" => active.into_iter().filter(|id| calendars::is_outlook(id)).collect(),
        Some(s) => vec![s],
        None => active,
    };
    let mut errors = vec![];
    for (_, outcome) in sync_ids(&app, &ids).await {
        if let Err(e) = outcome {
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

/// Syncs `ids`: the Outlook calendars among them in one run, the others one after the other.
async fn sync_ids(app: &AppHandle, ids: &[String]) -> Vec<(String, Result<usize>)> {
    let (outlook_ids, others): (Vec<String>, Vec<String>) =
        ids.iter().cloned().partition(|id| calendars::is_outlook(id));
    let mut out = vec![];
    if !outlook_ids.is_empty() {
        out.extend(sync_outlook(app, &outlook_ids).await);
    }
    for id in others {
        let r = sync_source(app, &id).await;
        out.push((id, r));
    }
    out
}

/// Marks `id` as syncing; `false` when it already is.
fn start(app: &AppHandle, id: &str) -> bool {
    let fresh = lock(&app.state::<CalendarSync>().running).insert(id.to_owned());
    if fresh {
        let _ = app.emit("calendar://syncing", id);
    }
    fresh
}

/// Stores what a sync of `id` read (or its error) and ends it.
fn finish(app: &AppHandle, id: &str, window: Window, read: Result<Vec<core::NewEvent>>) -> Result<usize> {
    let state = app.state::<AppState>();
    let now = Utc::now();
    let outcome = read.and_then(|events| state.db().calendar_replace(id, window.0, window.1, &events));
    match &outcome {
        Ok(n) => {
            let _ = state.db().calendar_record_sync(id, now, Ok(*n));
            devlog::debug("calendar", format!("{id}: {n} appointments"));
        }
        Err(e) => {
            let msg = devlog::redact(&e.to_string());
            devlog::warn("calendar", format!("{id}: {msg}"));
            let _ = state.db().calendar_record_sync(id, now, Err(&msg));
        }
    }
    lock(&app.state::<CalendarSync>().running).remove(id);
    let _ = app.emit("calendar://synced", id);
    outcome
}

fn busy_error() -> Error {
    Error::State(tr!("Dieser Kalender wird gerade synchronisiert", "This calendar is syncing right now").into())
}

/// Reads one source and replaces its events; records the outcome.
#[tracing::instrument(name = "calendar_sync", skip(app), fields(source = "calendar"))]
async fn sync_source(app: &AppHandle, id: &str) -> Result<usize> {
    if calendars::is_outlook(id) {
        let mut out = sync_outlook(app, &[id.to_owned()]).await;
        return out.pop().map(|(_, r)| r).unwrap_or_else(|| Err(busy_error()));
    }
    if !start(app, id) {
        return Err(busy_error());
    }
    let window = window(app);
    let read = read_source(app, id, window).await;
    finish(app, id, window, read)
}

/// Reads the Outlook calendars `ids` in one run of the script; each gets its own outcome (a
/// calendar that cannot be read does not fail the others).
#[tracing::instrument(name = "calendar_sync_outlook", skip_all, fields(source = "calendar", calendars = ids.len()))]
async fn sync_outlook(app: &AppHandle, ids: &[String]) -> Vec<(String, Result<usize>)> {
    // Focus blocks waiting for Outlook first: their appointments then come back as the blocks.
    let _ = crate::timeblocks::flush(app, false).await;
    let state = app.state::<AppState>();
    let settings = state.settings().calendar;
    let mut out = vec![];
    let mut cals: Vec<OutlookCalendar> = vec![];
    for id in ids {
        match settings.outlook_calendar(id) {
            None => out.push((id.clone(), Err(Error::not_found("calendar", id.clone())))),
            Some(_) if !start(app, id) => out.push((id.clone(), Err(busy_error()))),
            Some(c) => cals.push(c.clone()),
        }
    }
    if cals.is_empty() {
        return out;
    }
    let window = window(app);
    let zone = Zone::Local;
    let privacy = Privacy::from(&settings);
    let req = outlook::Request { from: zone.to_wall(window.0), to: zone.to_wall(window.1), privacy };
    let dir = state.data_dir.join("scripts");
    let list = cals.clone();
    let reads = if outlook::available() {
        tauri::async_runtime::spawn_blocking(move || outlook::read_calendars(&dir, req, &list, &Zone::Local))
            .await
            .map_err(|e| Error::State(e.to_string()))
            .and_then(|r| r)
    } else {
        Err(Error::State("Outlook (klassisch) gibt es nur unter Windows".into()))
    };
    match reads {
        Ok(reads) => {
            for r in reads {
                if r.free_busy {
                    devlog::debug("calendar", format!("{}: free/busy only", r.id));
                }
                let outcome = finish(app, &r.id, window, r.events);
                out.push((r.id, outcome));
            }
        }
        Err(e) => {
            // Outlook itself failed: every calendar of the run reports it.
            let msg = e.to_string();
            for c in &cals {
                let outcome = finish(app, &c.id, window, Err(Error::State(msg.clone())));
                out.push((c.id.clone(), outcome));
            }
        }
    }
    out
}

type Window = (DateTime<Utc>, DateTime<Utc>);

/// The window of a sync starting now.
fn window(app: &AppHandle) -> Window {
    let settings = app.state::<AppState>().settings().calendar;
    core::sync_window(Local::now().date_naive(), &settings, &Zone::Local)
}

/// The events of an ICS source inside the sync window (no database lock is held meanwhile).
async fn read_source(app: &AppHandle, id: &str, (from, to): Window) -> Result<Vec<core::NewEvent>> {
    let state = app.state::<AppState>();
    let settings = state.settings().calendar;
    let privacy = Privacy::from(&settings);
    let join = |e: tauri::Error| Error::State(e.to_string());
    let events = {
        let src = settings.source(id).cloned().ok_or_else(|| Error::not_found("calendar", id.to_owned()))?;
        let bytes = match src.kind {
            IcsKind::File => {
                let path = src.path.clone();
                tauri::async_runtime::spawn_blocking(move || read_file(&path)).await.map_err(join)??
            }
            IcsKind::Url => {
                let url = secret(&state, &src.id).get().ok_or_else(|| {
                    Error::State(
                        tr!(
                            "Für diesen Kalender ist keine Adresse gespeichert",
                            "No address is stored for this calendar"
                        )
                        .into(),
                    )
                })?;
                let service = annalo_core::network::Service::Ics(src.id.clone());
                let http = crate::network::client_for(&state, &service)?;
                let timeout = crate::network::timeout_for(&state, &service);
                ics::fetch(&http, &url, timeout).await?
            }
        };
        tauri::async_runtime::spawn_blocking(move || ics::parse(&bytes, (from, to), &Zone::Local, privacy))
            .await
            .map_err(join)??
    };
    Ok(events)
}

fn read_file(path: &str) -> Result<Vec<u8>> {
    let p = std::path::Path::new(path);
    let meta = std::fs::metadata(p).map_err(|e| {
        Error::State(trf!(
            "Die Kalenderdatei „{path}“ ist nicht lesbar: {e}",
            "The calendar file “{path}” cannot be read: {e}"
        ))
    })?;
    if meta.len() as usize > ics::MAX_BYTES {
        return Err(Error::State(trf!(
            "Die Kalenderdatei „{path}“ ist größer als 30 MB",
            "The calendar file “{path}” is larger than 30 MB"
        )));
    }
    std::fs::read(p).map_err(|e| {
        Error::State(trf!(
            "Die Kalenderdatei „{path}“ ist nicht lesbar: {e}",
            "The calendar file “{path}” cannot be read: {e}"
        ))
    })
}

/// Syncs `ids` in the background.
pub fn spawn_sync(app: AppHandle, ids: Vec<String>) {
    tauri::async_runtime::spawn(async move {
        sync_ids(&app, &ids).await;
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
            if !due.is_empty() {
                sync_ids(&app, &due).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
