//! Canvas pages (`arcalo_core::canvas`): creating one and the mirror path of a note card.

use arcalo_core::model::Page;
use arcalo_core::vault;
use tauri::State;

use crate::{AppState, Result};

/// A new canvas below `parent_id`, or in the canvas folder of the filing when there is none.
#[tauri::command(async)]
pub fn canvas_create(state: State<AppState>, parent_id: Option<i64>, title: String) -> Result<Page> {
    let db = state.db();
    let title = crate::unique_title(&db, &title)?;
    db.create_canvas(parent_id, &title, chrono::Local::now().date_naive())
}

/// The file of a page in the Markdown mirror (`Ordner/Titel.md`), as a note card stores it.
#[tauri::command(async)]
pub fn canvas_note_path(state: State<AppState>, page_id: i64) -> Result<String> {
    let db = state.db();
    let file = vault::page_paths(&db)?.into_iter().find(|p| p.page_id == page_id).and_then(|p| p.file);
    Ok(match file {
        Some(f) if f.to_lowercase().ends_with(".md") => f,
        _ => format!("{}.md", db.page(page_id)?.title),
    })
}
