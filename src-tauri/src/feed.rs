//! Activity feed in the shell: IPC commands, the one-time backfill at start and the events the
//! shell itself writes (files, backups, Git syncs).

use std::path::Path;

use arcalo_core::feed::{self, Activity, FeedFilter, FeedSummary, NewActivity};
use arcalo_core::{Database, Error};
use chrono::{DateTime, Utc};
use tauri::State;

use crate::AppState;

type Result<T> = std::result::Result<T, Error>;

#[tauri::command(async)]
pub fn activity_list(state: State<AppState>, filter: Option<FeedFilter>) -> Result<Vec<Activity>> {
    feed::list(&state.reader(), &filter.unwrap_or_default())
}

/// Totals of `from..to` (UTC instants of the local day bounds).
#[tauri::command(async)]
pub fn activity_summary(state: State<AppState>, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<FeedSummary> {
    feed::summary(&state.reader(), from, to)
}

/// People mentioned in the feed (filter).
#[tauri::command(async)]
pub fn activity_people(state: State<AppState>) -> Result<Vec<String>> {
    state.reader().feed_people()
}

/// The UI painted its first frame (`window_ready`).
pub static FIRST_FRAME: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// [`backfill`] on a thread of its own once the UI painted (at most 10 s after the start), so the
/// one-time work of a large workspace does not hold up the window; the views of the history
/// reload when it is done.
pub fn backfill_later(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    let app = app.clone();
    let spawned = std::thread::Builder::new().name("feed-backfill".into()).spawn(move || {
        let start = std::time::Instant::now();
        while !FIRST_FRAME.load(std::sync::atomic::Ordering::Relaxed)
            && start.elapsed() < std::time::Duration::from_secs(10)
        {
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let state = app.state::<AppState>();
        if backfill(&state.db(), &state.attachments_dir()) > 0 {
            let _ = app.emit("data://entries", ());
        }
    });
    if let Err(e) = spawned {
        crate::devlog::warn("feed", format!("activity history not derived: {e}"));
    }
}

/// Derives the history from before the journal once (pages, versions, entries, attachments);
/// the number of events written.
pub fn backfill(db: &Database, attachments: &Path) -> usize {
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
        Ok(0) => 0,
        Ok(n) => {
            crate::devlog::info("feed", format!("activity history derived: {n} events"));
            n
        }
        Err(e) => {
            crate::devlog::warn("feed", format!("activity history not derived: {e}"));
            0
        }
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
