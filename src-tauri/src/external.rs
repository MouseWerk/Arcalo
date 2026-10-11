//! Changes another process made to the workspace while the app runs: the `arcalo` command line
//! (docs/cli.md), used by people, scripts and AI agents. It records what it changed in the same
//! transaction (`arcalo_core::external`); this thread notices commits of other connections through
//! `PRAGMA data_version` on a read-only connection of its own (a cheap check, once a second) and
//! hands the recorded changes to the UI through the events it already listens to: `data://pages`
//! reloads open editors (unsaved typing is merged with the new text, as for another pane),
//! `data://entries`, `data://wbs` and `data://absences` the views, `data://external` the tree, and
//! changed settings are applied like a save (shortcuts, AI clients, language, other windows).

use std::time::Duration;

use arcalo_core::external::Change;
use arcalo_core::{Database, datadir};
use tauri::{AppHandle, Emitter, Manager};

use crate::{AppState, devlog};

/// How often the thread looks for commits of other processes.
const POLL: Duration = Duration::from_secs(1);

/// Starts the watcher (once, at start).
pub fn spawn(app: AppHandle) {
    let spawned = std::thread::Builder::new().name("external-changes".into()).spawn(move || watch(&app));
    if let Err(e) = spawned {
        devlog::warn("external", format!("changes of the command line are not watched: {e}"));
    }
}

/// The watcher's connection and what it has seen.
struct Seen {
    db: Database,
    version: i64,
    seq: u64,
}

/// The watcher's connection; `warn`: say why there is none (once, not every second).
fn open(app: &AppHandle, warn: bool) -> Option<Seen> {
    let file = app.state::<AppState>().data_dir.join(datadir::DB_FILE);
    let db = match Database::open_read_only(&file) {
        Ok(db) => db,
        Err(e) => {
            if warn {
                devlog::warn("external", format!("no connection for watching changes of the command line: {e}"));
            }
            return None;
        }
    };
    let version = db.data_version().ok()?;
    let seq = db.external_change_seq().ok()?;
    Some(Seen { db, version, seq })
}

fn watch(app: &AppHandle) {
    let mut seen: Option<Seen> = None;
    let mut failed = false;
    loop {
        std::thread::sleep(POLL);
        // Closing for an update or a restart: the workspace must be closed (and is opened again
        // if the exit does not happen after all).
        if crate::exit_prepared() {
            seen = None;
            continue;
        }
        if seen.is_none() {
            seen = open(app, !failed);
            failed = seen.is_none();
        }
        let Some(s) = seen.as_mut() else { continue };
        let Ok(version) = s.db.data_version() else { continue };
        if version == s.version {
            continue;
        }
        s.version = version;
        match s.db.external_changes_since(s.seq) {
            Ok((seq, change)) => {
                s.seq = seq;
                if let Some(c) = change {
                    apply(app, &c);
                }
            }
            Err(e) => devlog::warn("external", format!("changes of the command line not read: {e}")),
        }
    }
}

/// Tells the UI (and the parts of the shell that keep state) what changed.
fn apply(app: &AppHandle, c: &Change) {
    devlog::info(
        "external",
        format!(
            "changed by the command line: {} pages{}{}{}{}{}",
            c.pages.len(),
            if c.tree { ", tree" } else { "" },
            if c.entries { ", time entries" } else { "" },
            if c.wbs { ", WBS" } else { "" },
            if c.settings { ", settings" } else { "" },
            if c.all { " (everything)" } else { "" }
        ),
    );
    if c.settings || c.all {
        // Taken over like a save on the settings page (which also emits `settings://changed`).
        let state = app.state::<AppState>();
        let stored = state.db().load_settings();
        match stored.map_err(|e| e.to_string()).and_then(|s| serde_json::to_value(&s).map_err(|e| e.to_string())) {
            Ok(v) => {
                if let Err(e) = crate::settings_save(app.clone(), app.state(), v) {
                    devlog::warn("external", format!("settings of the command line not applied: {e}"));
                }
            }
            Err(e) => devlog::warn("external", format!("settings of the command line not read: {e}")),
        }
    }
    if c.entries || c.all {
        let _ = app.emit("data://entries", ());
        crate::desktop::refresh_tray(app);
    }
    if c.wbs || c.all {
        let _ = app.emit("data://wbs", ());
    }
    if c.absences || c.all {
        let _ = app.emit("data://absences", ());
    }
    if c.all {
        // `null`: every open editor reloads.
        let _ = app.emit("data://pages", None::<Vec<i64>>);
    } else if !c.pages.is_empty() {
        let _ = app.emit("data://pages", &c.pages);
    }
    let _ = app.emit("data://external", c);
}
