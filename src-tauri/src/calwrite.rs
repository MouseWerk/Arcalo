//! Appointments created, changed, moved and deleted in the Kalender and written to Outlook
//! Classic (Settings → Kalender → „Termine in Outlook eintragen“). The logic lives in
//! `arcalo_core::calsync::writes`.
//!
//! Like the focus blocks' writes, a run reads the due writes, runs the script in
//! `spawn_blocking` without the database lock and then stores its answer; Outlook is never
//! started for it, writes that found it closed are retried about every minute and before each
//! Outlook sync. One lock covers every Outlook write of the app (blocks and appointments); an
//! Outlook read waits for it and keeps writes out until it has stored what it read.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use arcalo_core::calsync::outlookwrite::{self, OutlookEntryWriter};
use arcalo_core::calsync::tz::Zone;
use arcalo_core::calsync::writes::{self, EntryDraft, EntryWriter, Fields, WriteContext};
use arcalo_core::calsync::{CalendarEvent, CalendarSettings};
use arcalo_core::{Error, tr};
use chrono::Utc;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result, devlog};

/// One run of appointment writes at a time.
static FLUSHING: AtomicBool = AtomicBool::new(false);

/// Every Outlook write of the app (focus blocks and appointments) runs under this lock: one
/// script at a time, each with its own list of writes.
pub static OUTLOOK_WRITES: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Runs `read` (an Outlook read and storing what it saw) after the Outlook write under way and
/// keeps new writes out until it is done: a read that overtook a write would store what Outlook
/// had before it (a new appointment gone again, an old title that later looks like a conflict).
/// Called after the flushes, never inside one (the lock is not reentrant).
pub async fn after_writes<T>(read: impl std::future::Future<Output = T>) -> T {
    let _outlook = OUTLOOK_WRITES.lock().await;
    read.await
}

/// What decides whether an appointment can be changed here.
pub fn context(cal: &CalendarSettings) -> WriteContext<'_> {
    WriteContext {
        enabled: cal.entries_outlook,
        available: outlookwrite::available(),
        calendars: &cal.outlook_calendars,
    }
}

/// Sets `editable` on events for the Kalender.
pub fn annotate(events: &mut [CalendarEvent], cal: &CalendarSettings) {
    let ctx = context(cal);
    for e in events {
        e.editable = Some(writes::editability(e, &ctx));
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("calendar://entries", ());
}

fn off() -> Error {
    Error::State(
        tr!(
            "„Termine in Outlook eintragen“ ist ausgeschaltet (Einstellungen → Kalender)",
            "“Write appointments to Outlook” is switched off (Settings → Calendar)"
        )
        .into(),
    )
}

fn read_only() -> Error {
    Error::State(
        tr!("Dieser Termin lässt sich nur in Outlook ändern", "This appointment can only be changed in Outlook").into(),
    )
}

/// The settings, refusing when writing is off or Outlook Classic is not there.
fn writing(state: &AppState) -> Result<CalendarSettings> {
    let cal = state.settings().calendar;
    if !outlookwrite::available() {
        return Err(Error::State(
            tr!("Outlook (klassisch) gibt es nur unter Windows", "Outlook (classic) is only available on Windows")
                .into(),
        ));
    }
    if !cal.entries_outlook {
        return Err(off());
    }
    Ok(cal)
}

/// The event `key` as the Kalender shows it, refused unless it can be changed.
fn editable(state: &AppState, cal: &CalendarSettings, key: &str) -> Result<CalendarEvent> {
    let mut e = state.reader().calendar_event(key)?;
    annotate(std::slice::from_mut(&mut e), cal);
    if !e.editable.is_some_and(|x| x.can()) {
        return Err(read_only());
    }
    Ok(e)
}

fn shown(state: &AppState, cal: &CalendarSettings, key: &str) -> Result<CalendarEvent> {
    let mut e = state.reader().calendar_event(key)?;
    annotate(std::slice::from_mut(&mut e), cal);
    Ok(e)
}

/// Switches „Termine in Outlook eintragen“ (the Kalender's offer on first use, the settings).
#[tauri::command(async)]
pub fn calendar_entries_enable(app: AppHandle, on: bool) -> Result<()> {
    crate::calsync::save_calendar(&app, |cal| {
        cal.entries_outlook = on;
        Ok(())
    })?;
    if on {
        spawn_flush(app.clone(), false);
    }
    changed(&app);
    Ok(())
}

/// A new appointment in `draft.source` (empty: the calendar chosen in the settings).
#[tauri::command(async)]
pub fn calendar_entry_create(app: AppHandle, state: State<AppState>, mut draft: EntryDraft) -> Result<CalendarEvent> {
    let cal = writing(&state)?;
    if draft.source.is_empty() {
        draft.source = cal.entry_target.clone();
    }
    let target = cal.outlook_calendar(&draft.source).filter(|c| writes::writable_calendar(c) && c.enabled);
    if target.is_none() {
        draft.source = arcalo_core::calsync::OUTLOOK.into();
    }
    let e = state.db().entry_create(&draft, Utc::now())?;
    changed(&app);
    spawn_flush(app.clone(), false);
    shown(&state, &cal, &e.key)
}

/// Changes title, time or place of an appointment (only what is given). `send`: the user
/// confirmed that Outlook sends the update of an organized meeting to its attendees.
#[tauri::command(async)]
pub fn calendar_entry_update(
    app: AppHandle,
    state: State<AppState>,
    key: String,
    patch: Fields,
    send: bool,
) -> Result<CalendarEvent> {
    let cal = writing(&state)?;
    editable(&state, &cal, &key)?;
    let e = state.db().entry_update(&key, &patch, send, Utc::now())?;
    changed(&app);
    spawn_flush(app.clone(), false);
    shown(&state, &cal, &e.key)
}

/// Deletes an appointment (to Outlook's Deleted Items); `calendar_entry_undo` takes it back.
#[tauri::command(async)]
pub fn calendar_entry_delete(app: AppHandle, state: State<AppState>, key: String) -> Result<()> {
    let cal = writing(&state)?;
    editable(&state, &cal, &key)?;
    state.db().entry_delete(&key, Utc::now())?;
    changed(&app);
    spawn_flush(app.clone(), false);
    Ok(())
}

/// „Rückgängig“ of a delete.
#[tauri::command(async)]
pub fn calendar_entry_undo(app: AppHandle, state: State<AppState>, key: String) -> Result<CalendarEvent> {
    let cal = writing(&state)?;
    let e = state.db().entry_undo(&key)?;
    changed(&app);
    spawn_flush(app.clone(), false);
    shown(&state, &cal, &e.key)
}

/// Settles a conflict: „Meine Änderung behalten“ (`keep_mine`) or „Outlook-Version übernehmen“.
#[tauri::command(async)]
pub fn calendar_entry_resolve(app: AppHandle, state: State<AppState>, key: String, keep_mine: bool) -> Result<()> {
    state.db().entry_resolve(&key, keep_mine)?;
    changed(&app);
    if keep_mine {
        spawn_flush(app.clone(), true);
    } else {
        // Outlook's whole version shows with the next sync.
        crate::calsync::spawn_sync(app.clone(), vec![key.split('|').next().unwrap_or_default().to_owned()]);
    }
    Ok(())
}

/// „In Outlook öffnen“: the appointment in an Outlook window (attendees, Teams link, series).
#[tauri::command]
pub async fn calendar_entry_show(app: AppHandle, key: String) -> Result<()> {
    let state = app.state::<AppState>();
    let e = state.reader().calendar_event(&key)?;
    let entry = e.event.meta.outlook_id.clone().ok_or_else(|| {
        Error::State(
            tr!(
                "Der Termin ist erst nach der nächsten Synchronisierung in Outlook zu finden",
                "The appointment can be found in Outlook after the next sync"
            )
            .into(),
        )
    })?;
    let dir = state.data_dir.join("scripts");
    tauri::async_runtime::spawn_blocking(move || outlookwrite::show(&dir, &entry))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

/// Writes what waits for Outlook now („Erneut versuchen“).
#[tauri::command]
pub async fn calendar_entries_retry(app: AppHandle) -> Result<()> {
    flush(&app, true).await
}

/// Runs the due writes; `force`: also those waiting for their next try.
pub async fn flush(app: &AppHandle, force: bool) -> Result<()> {
    if !outlookwrite::available() || FLUSHING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let _outlook = OUTLOOK_WRITES.lock().await;
    let mut out = flush_inner(app, force).await;
    // Changes made while a run was under way go in the next round; failed ones wait.
    for _ in 0..3 {
        if !matches!(out, Ok(true)) {
            break;
        }
        out = flush_inner(app, false).await;
    }
    FLUSHING.store(false, Ordering::Release);
    out.map(|_| ())
}

/// One run; `Ok(true)` when it wrote something.
async fn flush_inner(app: &AppHandle, force: bool) -> Result<bool> {
    let state = app.state::<AppState>();
    let cal = state.settings().calendar;
    if !cal.entries_outlook {
        return Ok(false);
    }
    let ops = state.db().entry_outbox_due(Utc::now(), &Zone::Local, force, &cal.outlook_calendars)?;
    if ops.is_empty() {
        return Ok(false);
    }
    let writer = OutlookEntryWriter { script_dir: state.data_dir.join("scripts") };
    let run = ops.clone();
    let results = tauri::async_runtime::spawn_blocking(move || writer.write(&run))
        .await
        .map_err(|e| Error::State(e.to_string()))
        .and_then(|r| r);
    match &results {
        Ok(r) => devlog::debug("calendar", format!("{} appointment writes", r.iter().filter(|x| x.ok).count())),
        Err(e) => devlog::warn("calendar", format!("appointment writes wait: {}", devlog::redact(&e.to_string()))),
    }
    state.db().entry_outbox_apply(&ops, &results, Utc::now(), &Zone::Local)?;
    changed(app);
    results.map(|r| r.iter().any(|x| x.ok))
}

/// Runs the due writes in the background.
pub fn spawn_flush(app: AppHandle, force: bool) {
    tauri::async_runtime::spawn(async move {
        let _ = flush(&app, force).await;
    });
}

/// Removes a list of writes a run left behind, then retries waiting writes about every minute
/// (cheap when nothing waits).
pub fn spawn_scheduler(app: AppHandle) {
    outlookwrite::remove_leftover(&app.state::<AppState>().data_dir.join("scripts"));
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let waiting = app.state::<AppState>().reader().entry_outbox_len().unwrap_or(0);
            if waiting > 0 {
                let _ = flush(&app, false).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn an_outlook_read_waits_for_a_write_under_way_and_keeps_new_ones_out() {
        tauri::async_runtime::block_on(async {
            let log = Arc::new(Mutex::new(Vec::<&str>::new()));
            let push = |l: &Arc<Mutex<Vec<&'static str>>>, s| l.lock().unwrap().push(s);
            // A write under way (another flush holds the lock while its script runs).
            let write = OUTLOOK_WRITES.lock().await;
            let l = log.clone();
            let read = tauri::async_runtime::spawn(async move {
                after_writes(async {
                    push(&l, "read");
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    push(&l, "read stored");
                })
                .await
            });
            tokio::time::sleep(Duration::from_millis(50)).await;
            push(&log, "write done");
            drop(write);
            // A write that starts while the read runs waits for it.
            tokio::time::sleep(Duration::from_millis(10)).await;
            let next = OUTLOOK_WRITES.lock().await;
            push(&log, "next write");
            drop(next);
            read.await.unwrap();
            assert_eq!(*log.lock().unwrap(), ["write done", "read", "read stored", "next write"]);
        });
    }

    #[test]
    fn the_outlook_sync_reads_after_the_writes() {
        let src = include_str!("calsync.rs");
        let body = &src[src.find("async fn sync_outlook").unwrap()..];
        let body = &body[..body.find("\n}\n").unwrap()];
        let wait = body.find("crate::calwrite::after_writes(").expect("the read waits for the writes");
        assert!(body.find("crate::calwrite::flush(").unwrap() < wait, "flushed before, not inside (no deadlock)");
        assert!(wait < body.find("read_calendars").unwrap());
        assert!(wait < body.find("finish(").unwrap(), "what it read is stored before a write runs again");
    }
}
