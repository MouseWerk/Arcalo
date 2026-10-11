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
    // The connection, and with it the entry the watcher starts after, is taken now, before the UI
    // reads anything: a command that writes while the app starts (an agent that started it and
    // goes on at once) is shown too. Taken by the thread later, such a change counted as seen.
    let seen = open(&app, true, None);
    let spawned = std::thread::Builder::new().name("external-changes".into()).spawn(move || watch(&app, seen));
    if let Err(e) = spawned {
        devlog::warn("external", format!("changes of the command line are not watched: {e}"));
    }
}

/// The watcher's connection and what it has seen.
struct Seen {
    db: Database,
    /// `None` until the first check: the journal is read then in any case.
    version: Option<i64>,
    seq: u64,
}

/// The watcher's connection, reading after entry `seq` (`None`: the newest one); `warn`: say why
/// there is none (once, not every second).
fn open(app: &AppHandle, warn: bool, seq: Option<u64>) -> Option<Seen> {
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
    let seq = match seq {
        Some(seq) => seq,
        None => db.external_change_seq().ok()?,
    };
    Some(Seen { db, version: None, seq })
}

fn watch(app: &AppHandle, mut seen: Option<Seen>) {
    let mut failed = seen.is_none();
    // The last entry handled, also while the connection is closed for an exit that may not happen.
    let mut handled = seen.as_ref().map(|s| s.seq);
    loop {
        std::thread::sleep(POLL);
        // Closing for an update or a restart: the workspace must be closed (and is opened again
        // if the exit does not happen after all).
        if crate::exit_prepared() {
            seen = None;
            continue;
        }
        if seen.is_none() {
            seen = open(app, !failed, handled);
            failed = seen.is_none();
        }
        let Some(s) = seen.as_mut() else { continue };
        let Ok(version) = s.db.data_version() else { continue };
        if s.version == Some(version) {
            continue;
        }
        s.version = Some(version);
        match s.db.external_changes_since(s.seq) {
            Ok((seq, change)) => {
                s.seq = seq;
                handled = Some(seq);
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
