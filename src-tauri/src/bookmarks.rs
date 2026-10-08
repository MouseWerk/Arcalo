//! „Lesezeichen importieren“: lists the browsers' bookmarks on this computer and reads them
//! (read-only, off the main thread). The logic lives in `arcalo_core::bookmarks`; what goes into
//! the ribbon is decided by the dialog and saved through `quick_links_save`.

use std::path::PathBuf;

use arcalo_core::Error;
use arcalo_core::bookmarks::{self, Location, Os, Roots, Source, Tree, discover};
use serde::Serialize;

use crate::Result;

fn roots() -> Result<Roots> {
    Roots::from_env().ok_or_else(|| {
        Error::State(arcalo_core::tr!("Der Benutzerordner ist nicht bekannt.", "The user folder is not known.").into())
    })
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| Error::State(e.to_string()))?
}

/// The browser profiles with bookmarks, with how many each holds.
#[tauri::command]
pub async fn bookmarks_sources() -> Result<Vec<Source>> {
    blocking(|| Ok(discover::sources(Os::current(), &roots()?))).await
}

#[derive(Serialize)]
pub struct SourceTree {
    source: Location,
    tree: Tree,
}

/// The bookmarks of the source `id` (from [`bookmarks_sources`]).
#[tauri::command]
pub async fn bookmarks_read(source: String) -> Result<SourceTree> {
    blocking(move || {
        let (source, tree) = discover::read_source(Os::current(), &roots()?, &source)?;
        Ok(SourceTree { source, tree })
    })
    .await
}

/// A bookmarks file the user chose (a browser's HTML export).
#[tauri::command]
pub async fn bookmarks_read_file(path: String) -> Result<Tree> {
    blocking(move || bookmarks::read_export_file(&PathBuf::from(path))).await
}

/// The text of a dropped bookmarks file.
#[tauri::command]
pub async fn bookmarks_read_text(text: String) -> Result<Tree> {
    blocking(move || bookmarks::parse_export(&text)).await
}
