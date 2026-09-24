//! Git sync, the way back: notes the server changed (another computer synced) are taken over
//! into the workspace; a note that was also changed here becomes a conflict. Both versions
//! are kept (this computer's in the page, the server's in the conflict record and in the
//! repository, see `gitsync::sync`), the page is marked „Konflikt“ and the user merges it in
//! the conflict view (`merge::merge3`). „Übernehmen“ saves the result and syncs again.
//!
//! Conflicts live in the meta row `gitsync.conflicts` (JSON); while one is open its file is
//! held at the server's version in the sync's working tree (`SyncRequest::hold`).

use std::collections::HashMap;

use annalo_core::gitsync::{self, RemoteChange, SyncOutcome};
use annalo_core::merge::{self, MergeResult};
use annalo_core::notes::PageDoc;
use annalo_core::{Database, Error, vault};
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
}

fn stem(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    let stem = name.len().checked_sub(3).and_then(|n| name.get(..n)).unwrap_or(name);
    if stem.trim().is_empty() { "Ohne Titel".into() } else { stem.to_owned() }
}

fn is_page_path(lower: &str) -> bool {
    lower.ends_with(".md") && lower != "readme.md" && !lower.starts_with("zeiterfassung/")
}

/// Takes over the notes the server changed. A note unchanged here since the last sync gets
/// the server's content (the previous content is kept as a version), is created or moved to
/// the trash; a note changed on both sides, or edited here since the mirror was written,
/// becomes a conflict. Files outside the notes (README, time CSVs) are skipped.
pub fn apply(db: &Database, changes: &[RemoteChange], now: DateTime<Local>) -> Result<Pulled> {
    db.atomic(|| {
        let paths = vault::page_paths(db)?;
        let by_file: HashMap<String, i64> =
            paths.iter().filter_map(|p| Some((p.file.as_ref()?.to_lowercase(), p.page_id))).collect();
        let mut by_folder: HashMap<String, i64> =
            paths.iter().filter_map(|p| Some((p.folder.as_ref()?.to_lowercase(), p.page_id))).collect();
        let mut conflicts = load(db);
        let mut out = Pulled::default();
        // Deleting many pages at once (another computer's mirror went missing, a wrong folder)
        // is not taken over: the pages stay and go back to the server with the next sync.
        let deletions = changes
            .iter()
            .filter(|c| c.theirs.is_none() && !c.conflict && by_file.contains_key(&c.path.to_lowercase()))
            .count();
        let tracked = by_file.keys().filter(|k| is_page_path(k)).count();
        let refuse_deletions = gitsync::mass_deletion(deletions, tracked);
        for c in changes {
            let lower = c.path.to_lowercase();
            if !is_page_path(&lower) {
                continue;
            }
            match by_file.get(&lower) {
                Some(&id) => {
                    let current = db.page_doc(id)?.content;
                    let unchanged_here = c.mine.as_deref() == Some(current.as_str());
                    match (&c.theirs, c.conflict || !unchanged_here) {
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
                    let dir = c.path.rsplit_once('/').map(|(d, _)| d.to_lowercase());
                    let parent = dir.and_then(|d| by_folder.get(&d).copied());
                    let page = db.create_page(parent, &stem(&c.path), Some("file-text"))?;
                    db.save_page_content(page.id, theirs)?;
                    out.created.push(page.id);
                    // Its subpages (later in the list) go below it.
                    if let Some(folder) = lower.strip_suffix(".md") {
                        by_folder.entry(folder.to_owned()).or_insert(page.id);
                    }
                }
            }
        }
        store(db, &conflicts)?;
        Ok(out)
    })
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
#[tauri::command]
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
    /// Block merge of this computer's current content and the server's version.
    merge: MergeResult,
}

/// Both versions of a conflicted page and their block merge.
#[tauri::command]
pub fn git_conflict_get(state: State<AppState>, page_id: i64) -> Result<ConflictView> {
    let db = state.db();
    let c = live(&db)?
        .into_iter()
        .find(|c| c.page_id == page_id)
        .ok_or_else(|| Error::State("Für diese Seite gibt es keinen Konflikt (mehr)".into()))?;
    let mine = db.page_doc(page_id)?.content;
    let merge = merge::merge3(c.base.as_deref(), &mine, &c.theirs);
    Ok(ConflictView { page_id, title: db.page(page_id)?.title, at: c.at, base: c.base, mine, theirs: c.theirs, merge })
}

#[derive(Serialize)]
pub struct Resolved {
    doc: PageDoc,
    /// The sync that followed, when Git sync is set up.
    sync: Option<SyncOutcome>,
    sync_error: Option<String>,
}

/// „Übernehmen“: saves the merged content (the previous one is kept as a version), closes
/// the conflict and syncs, so the server gets the result.
#[tauri::command]
pub async fn git_conflict_resolve(app: AppHandle, page_id: i64, content: String) -> Result<Resolved> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        {
            let db = state.db();
            if !live(&db)?.iter().any(|c| c.page_id == page_id) {
                return Err(Error::State("Für diese Seite gibt es keinen Konflikt (mehr)".into()));
            }
            db.atomic(|| {
                db.snapshot_page(page_id)?;
                db.save_page_content(page_id, &content)?;
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
                change("Zeiterfassung/2026-09.md", None, None, Some("x"), false),
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
        use annalo_core::gitsync::{Git, GitSyncSettings, SyncRequest};
        use std::path::Path;
        use std::process::Command;
        if !Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success()) {
            return;
        }
        let base = std::env::temp_dir().join(format!("annalo-two-pcs-{}", std::process::id()));
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
            annalo_core::mirror::write_mirror(db, &own, &files, &Local).unwrap();
            let out = annalo_core::gitsync::sync(
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
}
