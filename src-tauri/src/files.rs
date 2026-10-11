//! The attachment manager („Anhänge“, `attachment_manager` in the core): the file list with
//! usage, safe renames through the pages' save path, and the file trash.

use arcalo_core::Error;
use arcalo_core::attachment_manager::{self as manager, AttachmentList, RenameOutcome, TrashedFile};
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
    blocking(app, |s| manager::list(&s.reader(), &s.attachments_dir())).await
}

/// Renames a file and rewrites its embeds in every page (the previous contents are kept as
/// versions). Emits `data://pages` with the rewritten pages, so open editors reload them.
#[tauri::command]
pub async fn attachment_rename(app: AppHandle, name: String, new_name: String) -> Result<RenameOutcome> {
    let emit = app.clone();
    let out = blocking(app, move |s| {
        let _running = crate::lock(&s.git_lock);
        rename_attachment(&s.db(), &s.data_dir, &name, &new_name)
    })
    .await?;
    if !out.pages.is_empty() {
        let _ = emit.emit("data://pages", &out.pages);
    }
    Ok(out)
}

/// Renames `name` (see [`manager::rename`]); a file the Git sync kept twice stays kept under its
/// new name, and the old name leaves the server with the next sync. Callers hold the sync's lock.
pub(crate) fn rename_attachment(
    db: &arcalo_core::Database,
    data_dir: &std::path::Path,
    name: &str,
    new_name: &str,
) -> Result<RenameOutcome> {
    let files = arcalo_core::attachments::dir(data_dir);
    let out = manager::rename(db, &files, name, new_name)?;
    let repo = data_dir.join(arcalo_core::gitsync::REPO_DIR);
    let moved = match arcalo_core::gitsync::renamed_kept(&repo, name, &out.name) {
        Ok(moved) => moved,
        Err(e) => {
            crate::devlog::warn("git", format!("renamed file not kept under its new name: {e}"));
            return Ok(out);
        }
    };
    // In the working tree too: no note may link it, so the Markdown copy does not bring it.
    let tree = repo.join(arcalo_core::attachments::DIR_NAME);
    for (old, new) in moved {
        let from = files.join(&new);
        if std::fs::symlink_metadata(&from).is_ok_and(|m| m.is_file()) {
            std::fs::create_dir_all(&tree).map_err(|e| Error::file(&tree, e))?;
            arcalo_core::error::copy_file(&from, &tree.join(&new))?;
        }
        let gone = tree.join(&old);
        if std::fs::symlink_metadata(&gone).is_ok_and(|m| m.is_file()) {
            std::fs::remove_file(&gone).map_err(|e| Error::file(&gone, e))?;
        }
    }
    Ok(out)
}

/// Moves files into the file trash (`<data dir>/trash/files`).
#[tauri::command]
pub async fn attachment_trash(app: AppHandle, names: Vec<String>) -> Result<Vec<String>> {
    blocking(app, move |s| {
        let _running = crate::lock(&s.git_lock);
        trash_attachments(&s.data_dir, &names)
    })
    .await
}

/// Moves `names` into the file trash; a file the Git sync kept twice leaves its kept list (the
/// next sync removes it from the server). Callers hold the sync's lock.
pub(crate) fn trash_attachments(data_dir: &std::path::Path, names: &[String]) -> Result<Vec<String>> {
    let trashed = manager::trash_files(data_dir, names)?;
    if let Err(e) = arcalo_core::gitsync::forget_kept(&data_dir.join(arcalo_core::gitsync::REPO_DIR), names) {
        crate::devlog::warn("git", format!("trashed files not taken off the kept list: {e}"));
    }
    Ok(trashed)
}

/// Brings `name` back from the file trash; a file the Git sync kept twice before is kept again.
/// Callers hold the sync's lock.
pub(crate) fn restore_attachment(data_dir: &std::path::Path, id: &str, name: &str) -> Result<()> {
    manager::restore_file(data_dir, id, name)?;
    let repo = data_dir.join(arcalo_core::gitsync::REPO_DIR);
    let again = match arcalo_core::gitsync::restored_kept(&repo, name) {
        Ok(again) => again,
        Err(e) => {
            crate::devlog::warn("git", format!("restored file not kept again: {e}"));
            return Ok(());
        }
    };
    // Into the working tree too: no note may link it, so the Markdown copy does not bring it.
    let (files, tree) = (arcalo_core::attachments::dir(data_dir), repo.join(arcalo_core::attachments::DIR_NAME));
    for n in again {
        let from = files.join(&n);
        if std::fs::symlink_metadata(&from).is_ok_and(|m| m.is_file()) {
            std::fs::create_dir_all(&tree).map_err(|e| Error::file(&tree, e))?;
            arcalo_core::error::copy_file(&from, &tree.join(&n))?;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn attachments_trashed(app: AppHandle) -> Result<Vec<TrashedFile>> {
    blocking(app, |s| manager::trashed_files(&s.data_dir)).await
}

#[tauri::command]
pub async fn attachment_restore(app: AppHandle, id: String, name: String) -> Result<()> {
    blocking(app, move |s| {
        let _running = crate::lock(&s.git_lock);
        restore_attachment(&s.data_dir, &id, &name)
    })
    .await
}

#[tauri::command]
pub async fn attachment_purge(app: AppHandle, id: String, name: String) -> Result<()> {
    blocking(app, move |s| manager::purge_file(&s.data_dir, &id, &name)).await
}
