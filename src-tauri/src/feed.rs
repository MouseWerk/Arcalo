//! Activity feed in the shell: IPC commands, the one-time backfill at start and the events the
//! shell itself writes (files, backups, Git syncs).

use std::path::Path;

use annalo_core::feed::{self, Activity, FeedFilter, FeedSummary, NewActivity};
use annalo_core::{Database, Error};
use chrono::{DateTime, Utc};
use tauri::State;

use crate::AppState;

type Result<T> = std::result::Result<T, Error>;

#[tauri::command]
pub fn activity_list(state: State<AppState>, filter: Option<FeedFilter>) -> Result<Vec<Activity>> {
    feed::list(&state.db(), &filter.unwrap_or_default())
}

/// Totals of `from..to` (UTC instants of the local day bounds).
#[tauri::command]
pub fn activity_summary(state: State<AppState>, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<FeedSummary> {
    feed::summary(&state.db(), from, to)
}

/// People mentioned in the feed (filter).
#[tauri::command]
pub fn activity_people(state: State<AppState>) -> Result<Vec<String>> {
    state.db().feed_people()
}

/// Derives the history from before the journal once (pages, versions, entries, attachments).
pub fn backfill(db: &Database, attachments: &Path) {
    let files: Vec<(String, DateTime<Utc>)> = std::fs::read_dir(attachments)
        .map(|dir| {
            dir.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let meta = e.metadata().ok().filter(|m| m.is_file())?;
                    let name = e.file_name().into_string().ok().filter(|n| !n.starts_with('.'))?;
                    Some((name, DateTime::<Utc>::from(meta.modified().ok()?)))
                })
                .collect()
        })
        .unwrap_or_default();
    match feed::backfill(db, &files) {
        Ok(0) => {}
        Ok(n) => crate::devlog::info("feed", format!("activity history derived: {n} events")),
        Err(e) => crate::devlog::warn("feed", format!("activity history not derived: {e}")),
    }
}

/// A file stored in the attachments folder (once per name; failures only logged).
pub fn file_added(state: &AppState, name: &str) {
    if let Err(e) = state.db().feed_file(name, Utc::now()) {
        crate::devlog::warn("feed", format!("activity not recorded: {e}"));
    }
}

/// A backup or Git sync.
pub fn record(state: &AppState, kind: &'static str, title: &str, detail: &str) {
    let a = NewActivity { kind, title: title.to_owned(), detail: detail.to_owned(), ..Default::default() };
    if let Err(e) = state.db().record_activity(&a, Utc::now()) {
        crate::devlog::warn("feed", format!("activity not recorded: {e}"));
    }
}
