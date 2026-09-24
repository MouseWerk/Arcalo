//! The attachment manager („Anhänge“, `attachment_manager` in the core): the file list with
//! usage, safe renames through the pages' save path, and the file trash.

use annalo_core::Error;
use annalo_core::attachment_manager::{self as manager, AttachmentList, RenameOutcome, TrashedFile};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, Result};

async fn blocking<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&AppState) -> Result<T> + Send + 'static,
) -> Result<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>()))
        .await
        .map_err(|e| Error::State(e.to_string()))?
}

/// Every file in the attachments folder with type, size, date and the pages using it.
#[tauri::command]
pub async fn attachments_list(app: AppHandle) -> Result<AttachmentList> {
    blocking(app, |s| manager::list(&s.db(), &s.attachments_dir())).await
}

/// Renames a file and rewrites its embeds in every page (the previous contents are kept as
/// versions). Emits `data://pages` with the rewritten pages, so open editors reload them.
#[tauri::command]
pub async fn attachment_rename(app: AppHandle, name: String, new_name: String) -> Result<RenameOutcome> {
    let emit = app.clone();
    let out = blocking(app, move |s| manager::rename(&s.db(), &s.attachments_dir(), &name, &new_name)).await?;
    if !out.pages.is_empty() {
        let _ = emit.emit("data://pages", &out.pages);
    }
    Ok(out)
}

/// Moves files into the file trash (`<data dir>/trash/files`).
#[tauri::command]
pub async fn attachment_trash(app: AppHandle, names: Vec<String>) -> Result<Vec<String>> {
    blocking(app, move |s| manager::trash_files(&s.data_dir, &names)).await
}

#[tauri::command]
pub async fn attachments_trashed(app: AppHandle) -> Result<Vec<TrashedFile>> {
    blocking(app, |s| manager::trashed_files(&s.data_dir)).await
}

#[tauri::command]
pub async fn attachment_restore(app: AppHandle, id: String, name: String) -> Result<()> {
    blocking(app, move |s| manager::restore_file(&s.data_dir, &id, &name)).await
}

#[tauri::command]
pub async fn attachment_purge(app: AppHandle, id: String, name: String) -> Result<()> {
    blocking(app, move |s| manager::purge_file(&s.data_dir, &id, &name)).await
}
