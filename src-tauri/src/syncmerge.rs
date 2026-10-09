//! Git sync, the way back: notes the server changed (another computer synced) are taken over
//! into the workspace; a note that was also changed here becomes a conflict. Both versions
//! are kept (this computer's in the page, the server's in the conflict record and in the
//! repository, see `gitsync::sync`), the page is marked „Konflikt“ and the user merges it in
//! the conflict view (`merge::merge3`). „Übernehmen“ saves the result and syncs again.
//!
//! Conflicts live in the meta row `gitsync.conflicts` (JSON); while one is open its file is
//! held at the server's version in the sync's working tree (`SyncRequest::hold`).

use std::collections::{HashMap, HashSet};

use arcalo_core::gitsync::{self, RemoteChange, SyncOutcome};
use arcalo_core::merge::{self, MergeResult};
use arcalo_core::notes::PageDoc;
use arcalo_core::{Database, Error, vault};
use chrono::{DateTime, Local};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result};

const CONFLICTS: &str = "gitsync.conflicts";

/// An undecided conflict. This computer's version is the page's current content.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Conflict {
    pub page_id: i64,
    pub title: String,
    /// Path of the note in the repository.
    pub path: String,
    /// Content both sides started from, if known.
    pub base: Option<String>,
    /// The server's version.
    pub theirs: String,
    pub at: DateTime<Local>,
}

pub fn load(db: &Database) -> Vec<Conflict> {
    db.meta_get(CONFLICTS).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn store(db: &Database, list: &[Conflict]) -> Result<()> {
    db.meta_set(CONFLICTS, &serde_json::to_string(list)?)
}

/// Repository paths the sync keeps at the server's version until merged.
pub fn hold_paths(db: &Database) -> Vec<String> {
    load(db).into_iter().map(|c| c.path).collect()
}

/// What a sync took over from the server.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Pulled {
    /// Pages whose content changed (editors reload them).
    pub pages: Vec<i64>,
    pub created: Vec<i64>,
    pub trashed: Vec<i64>,
    /// Pages with a new or updated conflict.
    pub conflicts: Vec<i64>,
    /// Pages the server deleted that stay here: too many at once (see `gitsync::mass_deletion`).
    /// The next sync uploads them again.
    pub kept: Vec<i64>,
    /// Pages moved or renamed like on the other computer.
    pub moved: Vec<i64>,
    /// Pages deleted here that the other computer edited meanwhile: back with that text.
    pub restored: Vec<i64>,
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let ext = if is_canvas_path(&name.to_lowercase()) { ".canvas".len() } else { 3 };
    let stem = name.len().checked_sub(ext).and_then(|n| name.get(..n)).unwrap_or(name);
    if stem.trim().is_empty() { arcalo_core::tr!("Ohne Titel", "Untitled").into() } else { stem.to_owned() }
}

fn is_canvas_path(lower: &str) -> bool {
    lower.ends_with(".canvas")
}

/// A note of a page: not the sync's own README (in 1.15 and earlier a page could take that
/// name) and nothing in the attachments folder. Pages below a folder „Zeiterfassung“ are pages
/// (the time sheets there are `.csv`).
fn is_page_path(lower: &str) -> bool {
    (lower.ends_with(".md") || is_canvas_path(lower)) && lower != "readme.md" && !lower.starts_with("attachments/")
}

/// The page of the folder `dir` of a pulled note (`None`: the top level). A folder without a page
/// here (a page without text of its own is written as a folder only, such as the year and month
/// folders of „Aufräumen“) gets one, so the note keeps its place.
fn folder_page(
    db: &Database,
    dir: Option<&str>,
    by_file: &HashMap<String, i64>,
    by_folder: &mut HashMap<String, i64>,
    out: &mut Pulled,
) -> Result<Option<i64>> {
    let Some(dir) = dir.filter(|d| !d.is_empty()) else { return Ok(None) };
    let key = dir.to_lowercase();
    if let Some(&id) = by_folder.get(&key).or_else(|| by_file.get(&format!("{key}.md"))) {
        by_folder.insert(key, id);
        return Ok(Some(id));
    }
    let parent = folder_page(db, parent_dir(dir), by_file, by_folder, out)?;
    let page = db.create_page(parent, dir.rsplit('/').next().unwrap_or(dir), Some("folder"))?;
    out.created.push(page.id);
    by_folder.insert(key, page.id);
    Ok(Some(page.id))
}

/// A path without its extension (`.md`, `.canvas`): the folder of the page's subpages.
fn without_ext(lower: &str) -> &str {
    lower.strip_suffix(".md").or_else(|| lower.strip_suffix(".canvas")).unwrap_or(lower)
}

fn parent_dir(path: &str) -> Option<&str> {
    path.rsplit_once('/').map(|(d, _)| d)
}

/// Whether a file named `stem` is where the mirror puts a page titled `title`: its file name,
/// or that name with the number the mirror adds when two pages share it (`Notiz (2)`).
fn names_title(stem: &str, title: &str) -> bool {
    let name = vault::file_name(title).to_lowercase();
    let stem = stem.to_lowercase();
    let numbered = || {
        let n = stem.strip_prefix(&name)?.strip_prefix(" (")?.strip_suffix(')')?;
        n.parse::<u32>().ok()
    };
    stem == name || numbered().is_some()
}

/// Folders (lower case) of pages written as a folder only: no text, so no file of their own.
fn folders_only(by_file: &HashMap<String, i64>, by_folder: &HashMap<String, i64>) -> HashMap<String, i64> {
    by_folder
        .iter()
        .filter(|(k, _)| !by_file.contains_key(&format!("{k}.md")) && !by_file.contains_key(&format!("{k}.canvas")))
        .map(|(k, id)| (k.clone(), *id))
        .collect()
}

/// Folder-only pages whose notes all moved to one other, new folder: the folder was renamed or
/// moved there. `(old folder, new folder)`, outer folders first.
fn folder_moves(
    changes: &[RemoteChange],
    by_file: &HashMap<String, i64>,
    by_folder: &HashMap<String, i64>,
    only: &HashMap<String, i64>,
) -> Vec<(String, String)> {
    let moves: HashMap<String, &str> =
        changes.iter().filter_map(|c| Some((c.from.as_ref()?.to_lowercase(), c.path.as_str()))).collect();
    let target_of = |folder: &str| -> Option<String> {
        let prefix = format!("{folder}/");
        let mut target: Option<String> = None;
        for file in by_file.keys().filter(|f| f.starts_with(&prefix)) {
            let rest = &file[prefix.len()..];
            let mut parts: Vec<&str> = moves.get(file)?.split('/').collect();
            let depth = rest.split('/').count();
            if parts.len() <= depth {
                return None;
            }
            let tail = parts.split_off(parts.len() - depth).join("/");
            let dir = parts.join("/");
            if tail.to_lowercase() != rest || target.as_ref().is_some_and(|t| *t != dir) {
                return None;
            }
            target = Some(dir);
        }
        let key = target.as_ref()?.to_lowercase();
        let fresh = key != folder
            && !key.starts_with(&prefix)
            && !by_folder.contains_key(&key)
            && !by_file.contains_key(&format!("{key}.md"));
        target.filter(|_| fresh)
    };
    let mut out: Vec<(String, String)> =
        only.keys().filter_map(|folder| Some((folder.clone(), target_of(folder)?))).collect();
    out.sort_by_key(|(old, _)| (old.matches('/').count(), old.clone()));
    out
}

/// Takes over the notes the server changed. A note unchanged here since the last sync gets
/// the server's content (the previous content is kept as a version), is created or moved to
/// the trash; a note changed on both sides, or edited here since the mirror was written,
/// becomes a conflict. A note the server moved or renamed moves here too: the page keeps its
/// id, versions, time entries and links. Files outside the notes (the sync's README, time
/// sheets, attachments) are skipped.
pub fn apply(db: &Database, changes: &[RemoteChange], now: DateTime<Local>) -> Result<Pulled> {
    db.atomic(|| {
        let paths = vault::page_paths(db)?;
        let mut by_file: HashMap<String, i64> =
            paths.iter().filter_map(|p| Some((p.file.as_ref()?.to_lowercase(), p.page_id))).collect();
        let mut by_folder: HashMap<String, i64> =
            paths.iter().filter_map(|p| Some((p.folder.as_ref()?.to_lowercase(), p.page_id))).collect();
        let only = folders_only(&by_file, &by_folder);
        let mut conflicts = load(db);
        let mut out = Pulled::default();
        // Pages a change of this pull names.
        let mut named: HashSet<i64> = HashSet::new();
        // Deleting many pages at once (another computer's mirror went missing, a wrong folder)
        // is not taken over: the pages stay and go back to the server with the next sync. Moves
        // are no deletions.
        let deletions = changes
            .iter()
            .filter(|c| c.theirs.is_none() && !c.conflict && by_file.contains_key(&c.path.to_lowercase()))
            .count();
        let tracked = by_file.keys().filter(|k| is_page_path(k)).count();
        let refuse_deletions = gitsync::mass_deletion(deletions, tracked);
        // Folders renamed or moved there: the folder's page follows (its notes follow below).
        for (old, new) in folder_moves(changes, &by_file, &by_folder, &only) {
            let Some(&id) = by_folder.get(&old) else { continue };
            let parent = folder_page(db, parent_dir(&new), &by_file, &mut by_folder, &mut out)?;
            let page = db.page(id)?;
            if page.parent_id != parent && db.move_page(id, parent, i64::MAX).is_err() {
                continue;
            }
            let name = new.rsplit('/').next().unwrap_or(&new);
            if !names_title(name, &page.title) {
                db.rename_page(id, name)?;
            }
            out.moved.push(id);
            named.insert(id);
            by_folder.remove(&old);
            by_folder.insert(new.to_lowercase(), id);
        }
        for c in changes {
            let lower = c.path.to_lowercase();
            if !is_page_path(&lower) {
                continue;
            }
            let dir = parent_dir(&c.path);
            // Moved or renamed there: the page of the old path moves here as well.
            let moved = c.from.as_deref().and_then(|f| by_file.get(&f.to_lowercase()).copied());
            if let (Some(id), Some(from)) = (moved, c.from.as_deref()) {
                let parent = folder_page(db, dir, &by_file, &mut by_folder, &mut out)?;
                let page = db.page(id)?;
                // Never into its own subpages (a loop): then it keeps its place here.
                let placed = page.parent_id == parent || db.move_page(id, parent, i64::MAX).is_ok();
                let name = stem(&c.path);
                if stem(from) != name && !names_title(&name, &page.title) {
                    db.rename_page(id, &name)?;
                }
                if placed {
                    out.moved.push(id);
                }
                let old = from.to_lowercase();
                by_file.remove(&old);
                if let Some(sub) = by_folder.remove(without_ext(&old)) {
                    by_folder.insert(without_ext(&lower).to_owned(), sub);
                }
            }
            // A folder-only page here (no text of its own) that has text there.
            let as_folder = || {
                let id = *only.get(without_ext(&lower))?;
                (lower.ends_with(".md") && by_folder.get(without_ext(&lower)) == Some(&id)).then_some(id)
            };
            match moved.or_else(|| by_file.get(&lower).copied()).or_else(as_folder) {
                Some(id) => {
                    named.insert(id);
                    by_file.insert(lower.clone(), id);
                    let current = db.page_doc(id)?.content;
                    // A page without text here takes the server's text as a new note.
                    let unchanged_here =
                        c.mine.as_deref() == Some(current.as_str()) || (c.mine.is_none() && current.is_empty());
                    match (&c.theirs, c.conflict || !unchanged_here) {
                        // A canvas the server holds as unreadable JSON stays as it is here.
                        (Some(theirs), false) if is_canvas_path(&lower) && !arcalo_core::canvas::is_valid(theirs) => {}
                        (Some(theirs), false) => {
                            if &current != theirs {
                                db.snapshot_page(id)?;
                                db.save_page_content(id, theirs)?;
                                out.pages.push(id);
                            }
                        }
                        (None, false) if refuse_deletions => out.kept.push(id),
                        (None, false) => {
                            db.trash_page(id)?;
                            out.trashed.push(id);
                        }
                        (Some(theirs), true) if &current != theirs => {
                            // An open conflict keeps its original base.
                            let base =
                                conflicts.iter().find(|x| x.page_id == id).map_or(c.base.clone(), |x| x.base.clone());
                            conflicts.retain(|x| x.page_id != id);
                            let title = db.page(id)?.title;
                            conflicts.push(Conflict {
                                page_id: id,
                                title,
                                path: c.path.clone(),
                                base,
                                theirs: theirs.clone(),
                                at: now,
                            });
                            out.conflicts.push(id);
                        }
                        // Same text on both sides, or deleted there and edited here: this side stays.
                        _ => {}
                    }
                }
                None => {
                    let Some(theirs) = &c.theirs else { continue };
                    let canvas = is_canvas_path(&lower);
                    if canvas && !arcalo_core::canvas::is_valid(theirs) {
                        // An unreadable canvas from another computer (or Obsidian) stays on the server.
                        continue;
                    }
                    let parent = folder_page(db, dir, &by_file, &mut by_folder, &mut out)?;
                    // Deleted here while the other computer edited it: the edit brings it back, as
                    // the page from the trash when it was deleted on its own.
                    let came_back = c.mine.is_none() && c.base.is_some();
                    let from_trash =
                        if came_back { restore_from_trash(db, parent, &stem(&c.path), canvas)? } else { None };
                    let id = match from_trash {
                        Some(id) => {
                            db.snapshot_page(id)?;
                            db.save_page_content(id, theirs)?;
                            id
                        }
                        None if canvas => {
                            let page = db.create_page(parent, &stem(&c.path), Some(arcalo_core::canvas::ICON))?;
                            db.make_canvas(page.id, theirs)?;
                            out.created.push(page.id);
                            page.id
                        }
                        None => {
                            let page = db.create_page(parent, &stem(&c.path), Some("file-text"))?;
                            db.save_page_content(page.id, theirs)?;
                            out.created.push(page.id);
                            page.id
                        }
                    };
                    if came_back {
                        out.restored.push(id);
                    }
                    named.insert(id);
                    by_file.insert(lower.clone(), id);
                    // Its subpages (later in the list) go below it.
                    by_folder.entry(without_ext(&lower).to_owned()).or_insert(id);
                }
            }
        }
        // A folder-only page whose subpages all went there (deleted or moved away) is gone there
        // too: kept here, it would go back to the other computer as an empty page.
        if !out.trashed.is_empty() || !out.moved.is_empty() {
            let live: Vec<arcalo_core::model::Page> = db.list_pages()?;
            for &id in only.values().filter(|id| !named.contains(id)) {
                let has_children = live.iter().any(|p| p.parent_id == Some(id));
                if !has_children && live.iter().any(|p| p.id == id) && db.page_doc(id)?.content.is_empty() {
                    db.trash_page(id)?;
                    out.trashed.push(id);
                }
            }
        }
        store(db, &conflicts)?;
        Ok(out)
    })
}

/// A page deleted here that the other computer edited since: the trashed page of that name below
/// `parent`, trashed on its own (no subpages with it), is put back. `None`: a new page.
fn restore_from_trash(db: &Database, parent: Option<i64>, name: &str, canvas: bool) -> Result<Option<i64>> {
    let entry = db.list_trash()?.into_iter().find(|e| {
        e.descendants == 0
            && e.page.parent_id == parent
            && (e.page.kind.as_deref() == Some(arcalo_core::canvas::KIND)) == canvas
            && names_title(name, &e.page.title)
    });
    match entry {
        Some(e) => Ok(Some(db.restore_page(e.page.id)?.id)),
        None => Ok(None),
    }
}

/// Drops conflicts of pages that are gone or in the trash.
fn live(db: &Database) -> Result<Vec<Conflict>> {
    let all = load(db);
    let kept: Vec<Conflict> =
        all.iter().filter(|c| db.page(c.page_id).is_ok_and(|p| p.deleted_at.is_none())).cloned().collect();
    if kept.len() != all.len() {
        store(db, &kept)?;
    }
    Ok(kept)
}

#[derive(Serialize)]
pub struct ConflictInfo {
    page_id: i64,
    title: String,
    path: String,
    at: DateTime<Local>,
}

/// Pages with an undecided conflict („Konflikt“).
#[tauri::command(async)]
pub fn git_conflicts(state: State<AppState>) -> Result<Vec<ConflictInfo>> {
    let db = state.db();
    Ok(live(&db)?
        .into_iter()
        .map(|c| ConflictInfo { page_id: c.page_id, title: c.title, path: c.path, at: c.at })
        .collect())
}

#[derive(Serialize)]
pub struct ConflictView {
    page_id: i64,
    title: String,
    at: DateTime<Local>,
    base: Option<String>,
    mine: String,
    theirs: String,
    /// A canvas (JSON): decided as a whole („Meine“, „Andere“, „Beide behalten“), not merged
    /// by text.
    canvas: bool,
    /// Block merge of this computer's current content and the server's version.
    merge: MergeResult,
}

fn is_canvas_page(db: &Database, page_id: i64) -> Result<bool> {
    Ok(db.page_kind(page_id)?.as_deref() == Some(arcalo_core::canvas::KIND))
}

/// Both versions of a conflicted page and their block merge.
#[tauri::command(async)]
pub fn git_conflict_get(state: State<AppState>, page_id: i64) -> Result<ConflictView> {
    let db = state.db();
    let c = live(&db)?.into_iter().find(|c| c.page_id == page_id).ok_or_else(no_conflict)?;
    let mine = db.page_doc(page_id)?.content;
    let canvas = is_canvas_page(&db, page_id)?;
    let merge = merge::merge3(c.base.as_deref(), &mine, &c.theirs);
    Ok(ConflictView {
        page_id,
        title: db.page(page_id)?.title,
        at: c.at,
        base: c.base,
        mine,
        theirs: c.theirs,
        canvas,
        merge,
    })
}

#[derive(Serialize)]
pub struct Resolved {
    doc: PageDoc,
    /// The sync that followed, when Git sync is set up.
    sync: Option<SyncOutcome>,
    sync_error: Option<String>,
}

/// „Übernehmen“: saves the merged content (the previous one is kept as a version), closes
/// the conflict and syncs, so the server gets the result. A canvas only takes a whole, valid
/// JSON Canvas document (one side), never a text merge.
#[tauri::command]
pub async fn git_conflict_resolve(app: AppHandle, page_id: i64, content: String) -> Result<Resolved> {
    close_and_sync(app, page_id, move |db| {
        if is_canvas_page(db, page_id)? && !arcalo_core::canvas::is_valid(&content) {
            return Err(Error::State(
                arcalo_core::tr!("Keine gültige Canvas-Datei (JSON Canvas)", "Not a valid canvas file (JSON Canvas)")
                    .into(),
            ));
        }
        db.snapshot_page(page_id)?;
        db.save_page_content(page_id, &content)
    })
    .await
}

/// „Beide behalten“ for a canvas: this computer's version stays in the page, the server's
/// becomes a new canvas next to it („<Titel> (Server)“).
#[tauri::command]
pub async fn git_conflict_keep_both(app: AppHandle, page_id: i64) -> Result<Resolved> {
    close_and_sync(app, page_id, move |db| {
        let c = load(db).into_iter().find(|c| c.page_id == page_id).ok_or_else(no_conflict)?;
        keep_theirs_as_copy(db, page_id, &c.theirs).map(|_| ())
    })
    .await
}

/// The server's version of a conflicted canvas as a new canvas below the same parent.
fn keep_theirs_as_copy(db: &Database, page_id: i64, theirs: &str) -> Result<i64> {
    let page = db.page(page_id)?;
    let title = crate::unique_title(db, &format!("{} (Server)", page.title))?;
    let copy = db.create_page(page.parent_id, &title, Some(arcalo_core::canvas::ICON))?;
    db.make_canvas(copy.id, theirs)?;
    Ok(copy.id)
}

fn no_conflict() -> Error {
    Error::State(
        arcalo_core::tr!(
            "Für diese Seite gibt es keinen Konflikt (mehr)",
            "There is no conflict (any more) for this page"
        )
        .into(),
    )
}

/// Applies `decide` and closes the conflict in one transaction, then syncs.
async fn close_and_sync(
    app: AppHandle,
    page_id: i64,
    decide: impl FnOnce(&Database) -> Result<()> + Send + 'static,
) -> Result<Resolved> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        {
            let db = state.db();
            if !live(&db)?.iter().any(|c| c.page_id == page_id) {
                return Err(no_conflict());
            }
            db.atomic(|| {
                decide(&db)?;
                let rest: Vec<Conflict> = load(&db).into_iter().filter(|c| c.page_id != page_id).collect();
                store(&db, &rest)
            })?;
        }
        let _ = app.emit("gitsync://conflicts", ());
        let gs = state.settings().git_sync;
        let (sync, sync_error) = if gs.remote_url.trim().is_empty() {
            (None, None)
        } else {
            match crate::run_git_sync(&app, false, false) {
                Ok(out) => (Some(out), None),
                Err(e) => (None, Some(e.to_string())),
            }
        };
        Ok(Resolved { doc: state.db().page_doc(page_id)?, sync, sync_error })
    })
    .await
    .map_err(|e| Error::State(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(
        path: &str,
        base: Option<&str>,
        mine: Option<&str>,
        theirs: Option<&str>,
        conflict: bool,
    ) -> RemoteChange {
        RemoteChange {
            path: path.into(),
            from: None,
            base: base.map(Into::into),
            mine: mine.map(Into::into),
            theirs: theirs.map(Into::into),
            conflict,
        }
    }

    #[test]
    fn pulled_notes_are_taken_over_or_become_conflicts() {
        let db = Database::open_in_memory().unwrap();
        let projekt = db.create_page(None, "Projekt", None).unwrap();
        db.save_page_content(projekt.id, "Übersicht").unwrap();
        let plan = db.create_page(Some(projekt.id), "Plan", None).unwrap();
        db.save_page_content(plan.id, "alt").unwrap();
        let notiz = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(notiz.id, "meins").unwrap();
        let weg = db.create_page(None, "Weg", None).unwrap();
        db.save_page_content(weg.id, "weg").unwrap();
        let edited = db.create_page(None, "Bearbeitet", None).unwrap();
        db.save_page_content(edited.id, "seit dem Spiegel geändert").unwrap();
        let now = Local::now();

        let out = apply(
            &db,
            &[
                change("Projekt/Plan.md", Some("alt"), Some("alt"), Some("neu vom Server"), false),
                change("Notiz.md", Some("basis"), Some("meins"), Some("deren"), true),
                change("Weg.md", Some("weg"), Some("weg"), None, false),
                change("Projekt/Neu.md", None, None, Some("ganz neu"), false),
                change("Bearbeitet.md", Some("stand"), Some("stand"), Some("vom Server"), false),
                change("README.md", None, None, Some("x"), false),
                change("Zeiterfassung/2026-09.csv", None, None, Some("x"), false),
                change("attachments/notiz.md", None, None, Some("x"), false),
            ],
            now,
        )
        .unwrap();
        assert_eq!(out.pages, [plan.id]);
        assert_eq!(db.page_doc(plan.id).unwrap().content, "neu vom Server");
        assert_eq!(db.version_content(db.list_versions(plan.id).unwrap()[0].id).unwrap(), "alt", "kept as a version");
        assert_eq!(out.trashed, [weg.id]);
        assert!(db.page(weg.id).unwrap().deleted_at.is_some());
        assert_eq!(out.created.len(), 1);
        let neu = db.page(out.created[0]).unwrap();
        assert_eq!((neu.title.as_str(), neu.parent_id), ("Neu", Some(projekt.id)));
        assert_eq!(db.page_doc(neu.id).unwrap().content, "ganz neu");
        // Both sides changed, or edited here after the mirror was written: a conflict, nothing overwritten.
        assert_eq!(out.conflicts, [notiz.id, edited.id]);
        assert_eq!(db.page_doc(notiz.id).unwrap().content, "meins");
        assert_eq!(db.page_doc(edited.id).unwrap().content, "seit dem Spiegel geändert");
        let list = load(&db);
        assert_eq!(list.len(), 2);
        assert_eq!((list[0].base.as_deref(), list[0].theirs.as_str()), (Some("basis"), "deren"));
        assert_eq!(hold_paths(&db), ["Notiz.md", "Bearbeitet.md"]);
        assert!(db.page_by_title("README").unwrap().is_none());

        // A newer server version updates the open conflict and keeps its base.
        apply(&db, &[change("Notiz.md", Some("deren"), Some("deren"), Some("deren 2"), false)], now).unwrap();
        let list = load(&db);
        let n = list.iter().find(|c| c.page_id == notiz.id).unwrap();
        assert_eq!((n.base.as_deref(), n.theirs.as_str(), list.len()), (Some("basis"), "deren 2", 2));
        // A trashed page's conflict disappears.
        db.trash_page(edited.id).unwrap();
        assert_eq!(live(&db).unwrap().len(), 1);
        assert_eq!(hold_paths(&db), ["Notiz.md"]);
    }

    #[test]
    fn canvases_come_back_from_the_server() {
        let db = Database::open_in_memory().unwrap();
        let board = db.create_page(None, "Board", None).unwrap();
        let old = r#"{"nodes":[],"edges":[]}"#;
        db.make_canvas(board.id, old).unwrap();
        let new = r#"{"nodes":[{"id":"a","type":"text","text":"Neu","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
        let out = apply(
            &db,
            &[
                change("Board.canvas", Some(old), Some(old), Some(new), false),
                change("Zweites.canvas", None, None, Some(new), false),
                change("Kaputt.canvas", None, None, Some("{kein json"), false),
            ],
            Local::now(),
        )
        .unwrap();
        assert_eq!(out.pages, [board.id]);
        assert_eq!(db.page_doc(board.id).unwrap().content, new);
        assert_eq!(out.created.len(), 1);
        let created = db.page(out.created[0]).unwrap();
        assert_eq!((created.title.as_str(), created.kind.as_deref()), ("Zweites", Some("canvas")));
        assert_eq!(db.page_doc(created.id).unwrap().content, new);
    }

    #[test]
    fn many_deletions_from_the_server_are_kept() {
        let db = Database::open_in_memory().unwrap();
        let mut changes = Vec::new();
        for i in 0..12 {
            let p = db.create_page(None, &format!("Notiz {i}"), None).unwrap();
            db.save_page_content(p.id, "x").unwrap();
            changes.push(change(&format!("Notiz {i}.md"), Some("x"), Some("x"), None, false));
        }
        let out = apply(&db, &changes, Local::now()).unwrap();
        assert!(out.trashed.is_empty());
        assert_eq!(out.kept.len(), 12);
        assert_eq!(db.list_pages().unwrap().iter().filter(|p| p.deleted_at.is_none()).count(), 12);
        // One deletion is taken over as before.
        let out = apply(&db, &changes[..1], Local::now()).unwrap();
        assert_eq!((out.trashed.len(), out.kept.len()), (1, 0));
    }

    /// Two computers (two data folders) with one bare remote, end to end: mirror, sync, take over.
    #[test]
    fn two_computers_share_one_remote_without_losing_notes() {
        use arcalo_core::gitsync::{Git, GitSyncSettings, SyncRequest};
        use std::path::Path;
        use std::process::Command;
        if !Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success()) {
            return;
        }
        let base = std::env::temp_dir().join(format!("arcalo-two-pcs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let bare = base.join("remote.git");
        assert!(Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).status().unwrap().success());
        let settings = GitSyncSettings { enabled: true, remote_url: bare.display().to_string(), ..Default::default() };
        let run = |db: &Database, pc: &str, mirror: Option<&Path>| {
            let dir = base.join(pc);
            let files = dir.join("attachments");
            std::fs::create_dir_all(&files).unwrap();
            let own = dir.join("mirror");
            arcalo_core::mirror::write_mirror(db, &own, &files, &Local).unwrap();
            let out = arcalo_core::gitsync::sync(
                &Git::new(None, &settings.remote_url),
                &SyncRequest {
                    repo: &dir.join("git-sync"),
                    source: mirror.unwrap_or(&own),
                    database: None,
                    settings: &settings,
                    host: pc,
                    now: Local::now(),
                    hold: &hold_paths(db),
                    allow_deletions: false,
                    settings_file: None,
                    companion: false,
                },
            )?;
            apply(db, &out.remote_changes, Local::now())
        };
        let live_titles = |db: &Database| {
            let mut t: Vec<String> =
                db.list_pages().unwrap().into_iter().filter(|p| p.deleted_at.is_none()).map(|p| p.title).collect();
            t.sort();
            t
        };

        let a = Database::open_in_memory().unwrap();
        let projekt = a.create_page(None, "Projekt", None).unwrap();
        a.save_page_content(projekt.id, "Übersicht").unwrap();
        let plan = a.create_page(Some(projekt.id), "Plan", None).unwrap();
        a.save_page_content(plan.id, "Schritte").unwrap();
        let notiz = a.create_page(None, "Notiz", None).unwrap();
        a.save_page_content(notiz.id, "eins").unwrap();
        run(&a, "a", None).unwrap();

        // A new second computer: its first sync creates the server's notes here.
        let b = Database::open_in_memory().unwrap();
        let heute = b.create_page(None, "Heute", None).unwrap();
        b.save_page_content(heute.id, "## Fokus").unwrap();
        let pulled = run(&b, "b", None).unwrap();
        assert_eq!(pulled.created.len(), 3, "{pulled:?}");
        assert!(pulled.trashed.is_empty());
        assert_eq!(live_titles(&b), ["Heute", "Notiz", "Plan", "Projekt"]);
        let plan_b = b.page_by_title("Plan").unwrap().unwrap();
        assert_eq!(plan_b.parent_id, b.page_by_title("Projekt").unwrap().map(|p| p.id), "hierarchy kept");

        // The first computer syncs: it gets B's page and trashes nothing.
        let pulled = run(&a, "a", None).unwrap();
        assert!(pulled.trashed.is_empty() && pulled.kept.is_empty(), "{pulled:?}");
        assert_eq!(live_titles(&a), ["Heute", "Notiz", "Plan", "Projekt"]);
        // B syncs again: nothing to delete, nothing new.
        let pulled = run(&b, "b", None).unwrap();
        assert!(pulled.trashed.is_empty() && pulled.created.is_empty(), "{pulled:?}");

        // Missing and foreign mirror folders are refused on B; A still has everything.
        let err = run(&b, "b", Some(&base.join("fehlt"))).unwrap_err().to_string();
        assert!(err.contains("keine Markdown-Kopie"), "{err}");
        let foreign = base.join("Dokumente");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("Brief.txt"), "privat").unwrap();
        assert!(run(&b, "b", Some(&foreign)).is_err());
        run(&a, "a", None).unwrap();
        assert_eq!(live_titles(&a), ["Heute", "Notiz", "Plan", "Projekt"]);
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Two computers on one bare remote for the tests below: `sync(db, pc)` writes the mirror,
    /// syncs and takes over what came back.
    struct Pcs {
        base: std::path::PathBuf,
        settings: arcalo_core::gitsync::GitSyncSettings,
    }

    impl Pcs {
        fn new(name: &str) -> Option<Pcs> {
            use std::process::Command;
            if !Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success()) {
                return None;
            }
            let base = std::env::temp_dir().join(format!("arcalo-pcs-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            let bare = base.join("remote.git");
            assert!(Command::new("git").args(["init", "-q", "--bare"]).arg(&bare).status().unwrap().success());
            let settings = arcalo_core::gitsync::GitSyncSettings {
                enabled: true,
                remote_url: bare.display().to_string(),
                ..Default::default()
            };
            Some(Pcs { base, settings })
        }

        fn sync(&self, db: &Database, pc: &str) -> Pulled {
            let dir = self.base.join(pc);
            let files = dir.join("attachments");
            std::fs::create_dir_all(&files).unwrap();
            let own = dir.join("mirror");
            arcalo_core::mirror::write_mirror(db, &own, &files, &Local).unwrap();
            let out = gitsync::sync(
                &gitsync::Git::new(None, &self.settings.remote_url),
                &gitsync::SyncRequest {
                    repo: &dir.join("git-sync"),
                    source: &own,
                    database: None,
                    settings: &self.settings,
                    host: pc,
                    now: Local::now(),
                    hold: &hold_paths(db),
                    allow_deletions: false,
                    settings_file: None,
                    companion: false,
                },
            )
            .unwrap();
            apply(db, &out.remote_changes, Local::now()).unwrap()
        }
    }

    impl Drop for Pcs {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.base);
        }
    }

    /// `(title, parent title)` of every live page, sorted.
    fn tree(db: &Database) -> Vec<(String, Option<String>)> {
        let pages = db.list_pages().unwrap();
        let title = |id: Option<i64>| id.and_then(|id| pages.iter().find(|p| p.id == id)).map(|p| p.title.clone());
        let mut t: Vec<(String, Option<String>)> =
            pages.iter().map(|p| (p.title.clone(), title(p.parent_id))).collect();
        t.sort();
        t
    }

    #[test]
    fn moved_pages_keep_their_id_on_the_other_computer() {
        let Some(pcs) = Pcs::new("moves") else { return };
        let a = Database::open_in_memory().unwrap();
        let mut ids = vec![];
        for i in 0..12 {
            let p = a.create_page(None, &format!("Notiz {i:02}"), None).unwrap();
            a.save_page_content(p.id, &format!("Text {i}")).unwrap();
            ids.push(p.id);
        }
        let leer = a.create_page(None, "Leer", None).unwrap();
        pcs.sync(&a, "a");
        let b = Database::open_in_memory().unwrap();
        pcs.sync(&b, "b");
        let on_b = |t: &str| b.page_by_title(t).unwrap().unwrap();
        let first = on_b("Notiz 00");
        b.snapshot_page(first.id).unwrap();
        let versions = b.list_versions(first.id).unwrap().len();

        // One page moved below a new page, one renamed, on A.
        let archiv = a.create_page(None, "Archiv", None).unwrap();
        a.save_page_content(archiv.id, "Ordner").unwrap();
        a.move_page(ids[0], Some(archiv.id), 0).unwrap();
        a.rename_page(ids[1], "Notiz eins").unwrap();
        pcs.sync(&a, "a");
        let out = pcs.sync(&b, "b");
        assert!(out.trashed.is_empty() && out.kept.is_empty(), "{out:?}");
        assert_eq!(out.created, [on_b("Archiv").id]);
        let moved = on_b("Notiz 00");
        assert_eq!((moved.id, moved.parent_id), (first.id, Some(on_b("Archiv").id)), "same page, new place");
        assert_eq!(b.list_versions(first.id).unwrap().len(), versions, "its versions stay");
        assert!(b.page_by_title("Notiz 01").unwrap().is_none());
        assert_eq!(on_b("Notiz eins").parent_id, None);

        // „Aufräumen“ on A: the other eleven into year and month folders (folder-only pages).
        let jahr = a.create_page(None, "2026", Some("folder")).unwrap();
        let monat = a.create_page(Some(jahr.id), "10 – Oktober", Some("folder")).unwrap();
        for id in ids[2..].iter().chain([&leer.id]) {
            a.move_page(*id, Some(monat.id), 99).unwrap();
        }
        let before: Vec<i64> = (2..12).map(|i| on_b(&format!("Notiz {i:02}")).id).collect();
        pcs.sync(&a, "a");
        let out = pcs.sync(&b, "b");
        assert!(out.trashed.is_empty() && out.kept.is_empty(), "{out:?}");
        assert_eq!(out.moved.len(), 11, "{out:?}");
        let after: Vec<i64> = (2..12).map(|i| on_b(&format!("Notiz {i:02}")).id).collect();
        assert_eq!(before, after);
        assert_eq!(tree(&a), tree(&b));
        assert!(b.list_trash().unwrap().is_empty());

        // And back: no duplicates on either side, nothing moves again.
        let out = pcs.sync(&b, "b");
        assert!(out.created.is_empty() && out.moved.is_empty(), "{out:?}");
        let out = pcs.sync(&a, "a");
        assert!(out.created.is_empty() && out.trashed.is_empty() && out.moved.is_empty(), "{out:?}");
        assert_eq!(tree(&a), tree(&b));
        assert_eq!(a.list_pages().unwrap().len(), 16);

        // A folder-only page renamed on B: the page follows on A, with its notes.
        b.rename_page(on_b("10 – Oktober").id, "Oktober").unwrap();
        pcs.sync(&b, "b");
        let out = pcs.sync(&a, "a");
        assert!(out.created.is_empty() && out.trashed.is_empty(), "{out:?}");
        assert_eq!(a.page(monat.id).unwrap().title, "Oktober");
        assert_eq!(tree(&a), tree(&b));
    }

    #[test]
    fn a_page_deleted_here_and_edited_there_comes_back() {
        let Some(pcs) = Pcs::new("delete-edit") else { return };
        let a = Database::open_in_memory().unwrap();
        for i in 0..6 {
            let p = a.create_page(None, &format!("N{i}"), None).unwrap();
            a.save_page_content(p.id, "x").unwrap();
        }
        let notiz = a.create_page(None, "Notiz", None).unwrap();
        a.save_page_content(notiz.id, "v1").unwrap();
        pcs.sync(&a, "a");
        let b = Database::open_in_memory().unwrap();
        pcs.sync(&b, "b");
        let on_b = b.page_by_title("Notiz").unwrap().unwrap();
        b.save_page_content(on_b.id, "wichtige Ergänzung von B").unwrap();
        pcs.sync(&b, "b");
        a.trash_page(notiz.id).unwrap();
        let out = pcs.sync(&a, "a");
        assert_eq!(out.restored, [notiz.id], "{out:?}");
        let back = a.page(notiz.id).unwrap();
        assert!(back.deleted_at.is_none());
        assert_eq!(a.page_doc(notiz.id).unwrap().content, "wichtige Ergänzung von B");
        // B keeps its page.
        let out = pcs.sync(&b, "b");
        assert!(out.trashed.is_empty(), "{out:?}");
        assert_eq!(b.page_doc(on_b.id).unwrap().content, "wichtige Ergänzung von B");
    }

    #[test]
    fn pages_named_like_the_syncs_own_files_reach_the_other_computer() {
        let Some(pcs) = Pcs::new("own-names") else { return };
        let a = Database::open_in_memory().unwrap();
        let z = a.create_page(None, "Zeiterfassung", None).unwrap();
        a.save_page_content(z.id, "Wie ich buche").unwrap();
        let k = a.create_page(Some(z.id), "Regeln für SAP", None).unwrap();
        a.save_page_content(k.id, "Immer bis Freitag").unwrap();
        let r = a.create_page(None, "README", None).unwrap();
        a.save_page_content(r.id, "Lies mich").unwrap();
        let att = a.create_page(None, "attachments", None).unwrap();
        let sub = a.create_page(Some(att.id), "Liste", None).unwrap();
        a.save_page_content(sub.id, "Anhänge").unwrap();
        pcs.sync(&a, "a");
        let b = Database::open_in_memory().unwrap();
        let out = pcs.sync(&b, "b");
        assert_eq!(out.created.len(), 5, "{out:?}");
        let text = |db: &Database, t: &str| db.page_doc(db.page_by_title(t).unwrap().unwrap().id).unwrap().content;
        assert_eq!(text(&b, "Regeln für SAP"), "Immer bis Freitag");
        let readme = b.list_pages().unwrap().into_iter().find(|p| p.title.starts_with("README")).unwrap();
        assert_eq!(b.page_doc(readme.id).unwrap().content, "Lies mich");
        assert_eq!(text(&b, "Liste"), "Anhänge");
        // Nothing goes back and forth.
        for pc in ["b", "a", "b"] {
            let out = pcs.sync(if pc == "a" { &a } else { &b }, pc);
            assert!(out.created.is_empty() && out.trashed.is_empty() && out.kept.is_empty(), "{pc}: {out:?}");
        }
    }

    #[test]
    fn canvas_conflicts_are_decided_whole() {
        let db = Database::open_in_memory().unwrap();
        let mine =
            r#"{"nodes":[{"id":"a","type":"text","text":"hier","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
        let theirs =
            r#"{"nodes":[{"id":"b","type":"text","text":"dort","x":0,"y":0,"width":10,"height":10}],"edges":[]}"#;
        let board = db.create_page(None, "Board", None).unwrap();
        db.make_canvas(board.id, mine).unwrap();
        let now = Local::now();
        // Unreadable JSON from the server never replaces a readable board.
        let broken = "<<<<<<< ours\n{}";
        let out = apply(&db, &[change("Board.canvas", Some(mine), Some(mine), Some(broken), false)], now).unwrap();
        assert!(out.pages.is_empty());
        assert_eq!(db.page_doc(board.id).unwrap().content, mine);
        // „Beide behalten“: the server's board becomes a canvas of its own next to it.
        let copy = keep_theirs_as_copy(&db, board.id, theirs).unwrap();
        let page = db.page(copy).unwrap();
        assert_eq!(page.title, "Board (Server)");
        assert_eq!(page.parent_id, board.parent_id);
        assert!(is_canvas_page(&db, copy).unwrap());
        assert_eq!(db.page_doc(copy).unwrap().content, theirs);
        assert_eq!(db.page_doc(board.id).unwrap().content, mine);
        assert!(keep_theirs_as_copy(&db, board.id, broken).is_err());
    }
}
