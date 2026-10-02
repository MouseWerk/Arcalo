//! Ordner & Ablage in the shell: the tidy-up (dry run, apply, undo), moving many pages at once,
//! folder sort and colors, smart folders and filed pages created by the UI (bookmark import).
//! The logic lives in `annalo_core::filing`.

use annalo_core::filing::{
    FileType, FilingPreview, FilingSettings, FolderStyle, LastMove, MoveOutcome, SmartCounts, SmartGroup, SmartKind,
    SmartPage, TidyMove,
};
use annalo_core::model::Page;
use serde::Serialize;
use tauri::State;

use crate::{AppState, Result};

#[tauri::command(async)]
pub fn filing_tidy_plan(state: State<AppState>, scope: Option<i64>) -> Result<Vec<TidyMove>> {
    state.reader().tidy_plan(scope)
}

#[tauri::command(async)]
pub fn filing_tidy_apply(state: State<AppState>, scope: Option<i64>, page_ids: Vec<i64>) -> Result<MoveOutcome> {
    state.db().tidy_apply(scope, &page_ids)
}

/// „Verschieben nach …“ for one or many pages.
#[tauri::command(async)]
pub fn pages_move(
    state: State<AppState>,
    page_ids: Vec<i64>,
    parent_id: Option<i64>,
    position: Option<i64>,
) -> Result<MoveOutcome> {
    state.db().move_pages_at(&page_ids, parent_id, position)
}

#[tauri::command(async)]
pub fn move_last(state: State<AppState>) -> Result<Option<LastMove>> {
    state.reader().last_move()
}

#[tauri::command(async)]
pub fn move_undo(state: State<AppState>) -> Result<usize> {
    state.db().undo_last_move()
}

/// „Seite testen“ in Settings → Ordner & Ablage, with the unsaved rules.
#[tauri::command(async)]
pub fn filing_preview(state: State<AppState>, page_id: i64, filing: FilingSettings) -> Result<FilingPreview> {
    state.reader().filing_preview(page_id, &filing)
}

/// Sort and color of a folder (`0`: the top level).
#[tauri::command(async)]
pub fn folder_style_get(state: State<AppState>, page_id: i64) -> Result<FolderStyle> {
    state.reader().folder_style(page_id)
}

#[tauri::command(async)]
pub fn folder_style_set(state: State<AppState>, page_id: i64, style: FolderStyle) -> Result<()> {
    state.db().set_folder_style(page_id, &style)
}

#[tauri::command(async)]
pub fn smart_counts(state: State<AppState>) -> Result<SmartCounts> {
    state.reader().smart_counts()
}

#[tauri::command(async)]
pub fn smart_pages(state: State<AppState>, kind: SmartKind, key: Option<String>) -> Result<Vec<SmartPage>> {
    state.reader().smart_pages(kind, key.as_deref())
}

#[tauri::command(async)]
pub fn smart_groups(state: State<AppState>, kind: SmartKind) -> Result<Vec<SmartGroup>> {
    state.reader().smart_groups(kind)
}

#[derive(Serialize)]
pub struct FiledPage {
    page: Page,
    /// Folders created for it (removed again by an import's undo).
    folders: Vec<i64>,
}

/// A page of `kind` filed like the app's own (the bookmark import's pages).
#[tauri::command(async)]
pub fn page_create_filed(
    state: State<AppState>,
    kind: FileType,
    title: String,
    icon: Option<String>,
    content: Option<String>,
) -> Result<FiledPage> {
    let today = chrono::Local::now().date_naive();
    let (page, folders) =
        state.db().create_filed_page(kind, &title, icon.as_deref(), content.as_deref().unwrap_or(""), today)?;
    Ok(FiledPage { page, folders })
}
