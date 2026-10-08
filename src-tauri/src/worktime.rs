//! Absence days and public holidays (the overtime balance and vacation widgets, the absence
//! dialog in the Kalender) and the flagged Outlook mails of the start page. The logic lives in
//! `arcalo_core::worktime` and `arcalo_core::mail::flagged`.

use arcalo_core::Error;
use arcalo_core::mail::flagged::{self, FlaggedMail};
use arcalo_core::worktime::{self, Absence, AbsenceKind, Holiday};
use chrono::NaiveDate;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result, devlog};

#[derive(Serialize)]
pub struct AbsenceList {
    pub absences: Vec<Absence>,
    /// Public holidays of the state in the settings (none without one).
    pub holidays: Vec<Holiday>,
    pub state: String,
}

/// Absences and public holidays from `from` to `to` (both included).
#[tauri::command(async)]
pub fn absence_list(state: State<AppState>, from: NaiveDate, to: NaiveDate) -> Result<AbsenceList> {
    if to < from || (to - from).num_days() > 800 {
        return Err(Error::State("range".into()));
    }
    let settings = state.settings();
    let st = settings.time.balance.state.clone();
    Ok(AbsenceList {
        absences: state.reader().absences(from, to)?,
        holidays: worktime::holidays_between(from, to, &st),
        state: st,
    })
}

/// Enters an absence for `from..=to` (a longer range only on days with a target); the days.
#[tauri::command(async)]
pub fn absence_save(
    app: AppHandle,
    state: State<AppState>,
    from: NaiveDate,
    to: NaiveDate,
    kind: AbsenceKind,
    half: bool,
    note: String,
) -> Result<Vec<NaiveDate>> {
    let settings = state.settings();
    let note: String = note.trim().chars().take(200).collect();
    let days = worktime::save_range(&state.db(), &settings, from, to, kind, half, &note)?;
    let _ = app.emit("data://absences", ());
    Ok(days)
}

/// Removes the absences of `from..=to`; how many there were.
#[tauri::command(async)]
pub fn absence_remove(app: AppHandle, state: State<AppState>, from: NaiveDate, to: NaiveDate) -> Result<usize> {
    let n = state.db().absence_remove(from, to)?;
    let _ = app.emit("data://absences", ());
    Ok(n)
}

#[derive(Serialize)]
pub struct FlaggedList {
    /// Outlook can be asked here (Windows, or the test fixture).
    pub available: bool,
    pub mails: Vec<FlaggedMail>,
}

/// The flagged mails of Outlook's To-Do list (empty and unavailable off Windows).
#[tauri::command]
pub async fn mail_flagged(app: AppHandle) -> Result<FlaggedList> {
    if !flagged::available() {
        return Ok(FlaggedList { available: false, mails: vec![] });
    }
    let dir = app.state::<AppState>().data_dir.join("scripts");
    let mails = tauri::async_runtime::spawn_blocking(move || flagged::list(&dir))
        .await
        .map_err(|e| Error::State(e.to_string()))?;
    if let Err(e) = &mails {
        devlog::warn("mail", format!("Outlook (flagged): {e}"));
    }
    Ok(FlaggedList { available: true, mails: mails? })
}

/// Shows a flagged mail in Outlook.
#[tauri::command]
pub async fn mail_flagged_open(app: AppHandle, entry_id: String, store_id: String) -> Result<()> {
    let dir = app.state::<AppState>().data_dir.join("scripts");
    tauri::async_runtime::spawn_blocking(move || flagged::open(&dir, &entry_id, &store_id))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

/// Whether flagged mails can be listed here (the gallery offers the widget only then).
#[tauri::command(async)]
pub fn mail_flagged_available() -> bool {
    flagged::available()
}
