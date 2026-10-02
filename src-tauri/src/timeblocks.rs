//! Focus blocks („Fokusblöcke“) in the shell: IPC commands for the Kalender and the „Im
//! Kalender planen…“ picker, and the Outlook writes of the blocks (Settings → Kalender). The
//! logic lives in `annalo_core::timeblocks`.
//!
//! An Outlook write runs the bridge without the database lock: the due writes are read, the
//! script runs in `spawn_blocking`, then its answer is stored. Writes that found Outlook closed
//! are retried every minute or so (and before each Outlook sync), never by starting Outlook.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use annalo_core::calsync::outlook;
use annalo_core::calsync::outlookwrite::{self, OutlookBridge};
use annalo_core::calsync::tz::Zone;
use annalo_core::timeblocks::{BlockPatch, Bridge, FocusBlock, NewBlock};
use annalo_core::{Error, tr};
use chrono::{DateTime, NaiveDate, Utc};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result, devlog};

/// One run of Outlook writes at a time.
static FLUSHING: AtomicBool = AtomicBool::new(false);

/// Whether a change of a block is written to Outlook.
fn writes_outlook(state: &AppState) -> bool {
    state.settings().calendar.blocks_outlook && outlookwrite::available()
}

fn changed(app: &AppHandle) {
    let _ = app.emit("blocks://changed", ());
}

/// Blocks overlapping `from..to`.
#[tauri::command(async)]
pub fn blocks_list(state: State<AppState>, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<FocusBlock>> {
    if to <= from || to - from > chrono::TimeDelta::days(62) {
        return Err(Error::State(tr!("Ungültiger Zeitraum", "Invalid period").into()));
    }
    state.reader().blocks_in(from, to)
}

#[tauri::command(async)]
pub fn block_create(app: AppHandle, state: State<AppState>, block: NewBlock) -> Result<FocusBlock> {
    let outlook = writes_outlook(&state);
    let b = state.db().block_create(&block, Utc::now(), outlook)?;
    changed(&app);
    if outlook {
        spawn_flush(app.clone(), false);
    }
    Ok(b)
}

#[tauri::command(async)]
pub fn block_update(app: AppHandle, state: State<AppState>, id: i64, patch: BlockPatch) -> Result<FocusBlock> {
    let outlook = writes_outlook(&state);
    let b = state.db().block_update(id, &patch, Utc::now(), outlook)?;
    changed(&app);
    spawn_flush(app.clone(), false);
    Ok(b)
}

#[tauri::command(async)]
pub fn block_delete(app: AppHandle, state: State<AppState>, id: i64) -> Result<()> {
    state.db().block_delete(id)?;
    changed(&app);
    spawn_flush(app.clone(), false);
    Ok(())
}

/// Ticks off the block's task (open editors of its page reload).
#[tauri::command(async)]
pub fn block_task_done(app: AppHandle, state: State<AppState>, id: i64) -> Result<()> {
    let page_id = match state.reader().block(id)?.link {
        annalo_core::timeblocks::BlockLink::Task { page_id, .. } => page_id,
        _ => -1,
    };
    state.db().block_task_done(id)?;
    let _ = app.emit("data://tasks", page_id);
    changed(&app);
    Ok(())
}

/// Free starts on `date` for a block of `minutes` (meetings of the shown calendars and other
/// blocks avoided).
#[tauri::command(async)]
pub fn block_free_slots(state: State<AppState>, date: NaiveDate, minutes: i64) -> Result<Vec<DateTime<Utc>>> {
    let sources = state.settings().calendar.active_sources(outlook::available());
    state.reader().block_free_slots(date, minutes, Utc::now(), &Zone::Local, &sources)
}

/// Writes what waits for Outlook now (the „Erneut versuchen“ of the block detail).
#[tauri::command]
pub async fn blocks_outlook_retry(app: AppHandle) -> Result<()> {
    flush(&app, true).await
}

/// Runs the due Outlook writes; `force`: also those waiting for their next try.
pub async fn flush(app: &AppHandle, force: bool) -> Result<()> {
    if !outlookwrite::available() || FLUSHING.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let out = flush_inner(app, force).await;
    FLUSHING.store(false, Ordering::Release);
    out
}

async fn flush_inner(app: &AppHandle, force: bool) -> Result<()> {
    let state = app.state::<AppState>();
    let ops = state.db().block_outbox_due(Utc::now(), &Zone::Local, force)?;
    if ops.is_empty() {
        return Ok(());
    }
    let bridge = OutlookBridge { script_dir: state.data_dir.join("scripts") };
    let run = ops.clone();
    let results = tauri::async_runtime::spawn_blocking(move || bridge.write(&run))
        .await
        .map_err(|e| Error::State(e.to_string()))
        .and_then(|r| r);
    match &results {
        Ok(r) => devlog::debug("blocks", format!("{} Outlook writes", r.iter().filter(|x| x.ok).count())),
        Err(e) => devlog::warn("blocks", format!("Outlook writes wait: {}", devlog::redact(&e.to_string()))),
    }
    state.db().block_outbox_apply(&ops, &results, Utc::now())?;
    changed(app);
    results.map(|_| ())
}

/// Runs the due writes in the background.
pub fn spawn_flush(app: AppHandle, force: bool) {
    tauri::async_runtime::spawn(async move {
        let _ = flush(&app, force).await;
    });
}

/// Retries waiting writes about every minute (cheap when nothing waits).
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(60)).await;
            let waiting = app.state::<AppState>().reader().block_outbox_len().unwrap_or(0);
            if waiting > 0 {
                let _ = flush(&app, false).await;
            }
        }
    });
}
