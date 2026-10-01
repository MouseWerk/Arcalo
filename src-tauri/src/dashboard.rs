//! Start page („Startseite“): the data of its widgets in one call, writing a board to a file
//! (export) and filing an inbox entry. The logic lives in `annalo_core::dashboard`; the boards
//! themselves are saved with the settings (`dashboard_save`).

use std::time::Instant;

use annalo_core::Error;
use annalo_core::calsync::outlook;
use annalo_core::dashboard::{self as core, Ctx, Request, Response};
use annalo_core::error::IoAt;
use chrono::{Local, Utc};
use tauri::{AppHandle, Emitter, State};

use crate::{AppState, Result};

/// Largest board file written or read (the import reads through `settings_file_read`).
const MAX_FILE_BYTES: usize = 1024 * 1024;

/// What the visible widgets need, from the read connection: every part of `request` under
/// its key, a failing part as `{"error": …}`.
#[tauri::command(async)]
pub fn dashboard_data(state: State<AppState>, request: Request) -> Result<Response> {
    let started = Instant::now();
    let settings = state.settings();
    let sources = settings.calendar.active_sources(outlook::available());
    let parts = {
        let db = state.reader();
        let ctx = Ctx::new(&db, &Local, Utc::now(), request.today, &sources, &settings);
        core::dashboard_data(&ctx, &request.parts)?
    };
    Ok(Response { parts, ms: started.elapsed().as_secs_f64() * 1000.0 })
}

/// Takes entry `index` (still reading `text`) off the inbox page and, with `target`, appends it
/// to that page („Ablegen in …“); without, it is done („Erledigt“). Returns the target's title.
#[tauri::command(async)]
pub fn dashboard_inbox_move(
    app: AppHandle,
    state: State<AppState>,
    inbox: i64,
    index: usize,
    text: String,
    target: Option<i64>,
) -> Result<Option<String>> {
    let title = core::notes::inbox_move(&state.db(), inbox, index, &text, target)?;
    let pages: Vec<i64> = std::iter::once(inbox).chain(target).collect();
    let _ = app.emit("data://pages", &pages);
    Ok(title)
}

/// Writes an exported board (JSON the UI built) to `path`.
#[tauri::command(async)]
pub fn dashboard_file_write(path: String, json: String) -> Result<()> {
    let path = path.trim();
    if !path.to_lowercase().ends_with(".json") {
        return Err(Error::State(
            annalo_core::tr!("Bitte eine .json-Datei wählen", "Please choose a .json file").into(),
        ));
    }
    if json.len() > MAX_FILE_BYTES || serde_json::from_str::<serde_json::Value>(&json).is_err() {
        return Err(Error::State(
            annalo_core::tr!(
                "Die Startseite ließ sich nicht als Datei schreiben",
                "The start page could not be written as a file"
            )
            .into(),
        ));
    }
    std::fs::write(path, json).at(path)?;
    Ok(())
}
