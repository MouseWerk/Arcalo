//! Changes another process made to the workspace while the app runs (the `arcalo` command line),
//! so the open app shows them without a restart.
//!
//! The writer records what it changed in the same transaction as the change
//! ([`Database::record_external_change`]): a numbered entry in the meta row `external.changes`,
//! the last [`KEEP`] kept. The app notices commits of other connections through `PRAGMA data_version`
//! and reads the entries after the last one it handled ([`Database::external_changes_since`]),
//! then reloads what they name: open editors through the reload path that merges unsaved typing,
//! the tree, bookings, the WBS, absences or the settings.

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;

/// Meta key of the journal.
const META_KEY: &str = "external.changes";
/// Entries kept; an app that fell further behind reloads everything.
pub const KEEP: usize = 64;

/// What one change touched.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Change {
    /// Pages whose content, title or place changed (open editors reload them).
    pub pages: Vec<i64>,
    /// Pages were created, renamed, moved, trashed, restored or purged: the tree reloads.
    pub tree: bool,
    /// Time entries or the timer.
    pub entries: bool,
    /// Projects, Netzpläne, Vorgänge or Leistungsarten.
    pub wbs: bool,
    pub absences: bool,
    pub settings: bool,
    /// Too many changes to name them (the reader fell behind the journal): reload everything.
    pub all: bool,
}

impl Change {
    pub fn is_empty(&self) -> bool {
        *self == Change::default()
    }

    /// `other` added to this one (pages once each, in order).
    pub fn merge(&mut self, other: &Change) {
        for p in &other.pages {
            if !self.pages.contains(p) {
                self.pages.push(*p);
            }
        }
        self.tree |= other.tree;
        self.entries |= other.entries;
        self.wbs |= other.wbs;
        self.absences |= other.absences;
        self.settings |= other.settings;
        self.all |= other.all;
    }

    /// A change that reloads everything.
    pub fn everything() -> Change {
        Change { tree: true, entries: true, wbs: true, absences: true, settings: true, all: true, ..Default::default() }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Journal {
    /// Number of the newest entry (0: none yet).
    seq: u64,
    /// The newest entries, oldest first: `(number, change)`.
    log: Vec<(u64, Change)>,
}

impl Database {
    fn journal(&self) -> Result<Journal> {
        Ok(self.meta_get(META_KEY)?.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default())
    }

    /// Records `change` for a running app. Call it inside the transaction of the change, so the
    /// app never sees the one without the other. Returns the entry's number.
    pub fn record_external_change(&self, change: &Change) -> Result<u64> {
        if change.is_empty() {
            return Ok(self.journal()?.seq);
        }
        self.atomic(|| {
            let mut j = self.journal()?;
            j.seq += 1;
            j.log.push((j.seq, change.clone()));
            let over = j.log.len().saturating_sub(KEEP);
            j.log.drain(..over);
            self.meta_set(META_KEY, &serde_json::to_string(&j)?)?;
            Ok(j.seq)
        })
    }

    /// The number of the newest recorded change (where a reader starts).
    pub fn external_change_seq(&self) -> Result<u64> {
        Ok(self.journal()?.seq)
    }

    /// Everything recorded after entry `seq`, merged, with the newest number. `None` when nothing
    /// is new; [`Change::everything`] when entries after `seq` were dropped already.
    pub fn external_changes_since(&self, seq: u64) -> Result<(u64, Option<Change>)> {
        let j = self.journal()?;
        if j.seq <= seq {
            // Equal: nothing new. Lower: the journal started anew (a restored backup), nothing to name.
            return Ok((j.seq, None));
        }
        let oldest = j.log.first().map_or(j.seq + 1, |(n, _)| *n);
        if oldest > seq + 1 {
            return Ok((j.seq, Some(Change::everything())));
        }
        let mut out = Change::default();
        for (_, c) in j.log.iter().filter(|(n, _)| *n > seq) {
            out.merge(c);
        }
        Ok((j.seq, Some(out)))
    }

    /// A number that changes whenever another connection (or process) committed to the
    /// database since this connection last asked (`PRAGMA data_version`); cheap to ask often.
    pub fn data_version(&self) -> Result<i64> {
        Ok(self.conn().pragma_query_value(None, "data_version", |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(ids: &[i64]) -> Change {
        Change { pages: ids.to_vec(), ..Default::default() }
    }

    #[test]
    fn a_reader_gets_the_changes_after_its_last_one_merged() {
        let db = Database::open_in_memory().unwrap();
        let start = db.external_change_seq().unwrap();
        assert_eq!(db.external_changes_since(start).unwrap(), (0, None));
        db.record_external_change(&pages(&[3, 1])).unwrap();
        db.record_external_change(&Change { tree: true, pages: vec![1, 7], ..Default::default() }).unwrap();
        db.record_external_change(&Change::default()).unwrap();
        let (seq, change) = db.external_changes_since(start).unwrap();
        assert_eq!(seq, 2);
        assert_eq!(change.unwrap(), Change { pages: vec![3, 1, 7], tree: true, ..Default::default() });
        let (_, later) = db.external_changes_since(1).unwrap();
        assert_eq!(later.unwrap().pages, vec![1, 7]);
        assert_eq!(db.external_changes_since(2).unwrap(), (2, None));
    }

    #[test]
    fn a_reader_that_fell_behind_reloads_everything() {
        let db = Database::open_in_memory().unwrap();
        for i in 0..(KEEP as i64 + 5) {
            db.record_external_change(&pages(&[i])).unwrap();
        }
        let (seq, change) = db.external_changes_since(2).unwrap();
        assert_eq!(seq, KEEP as u64 + 5);
        assert!(change.unwrap().all);
        // Within the kept entries the pages are named.
        let (_, change) = db.external_changes_since(seq - 2).unwrap();
        assert_eq!(change.unwrap().pages, vec![KEEP as i64 + 3, KEEP as i64 + 4]);
    }

    #[test]
    fn data_version_moves_with_commits_of_other_connections_only() {
        let path = std::env::temp_dir().join(format!("arcalo-dataversion-{}.db", std::process::id()));
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
        let reader = Database::open(&path).unwrap();
        let before = reader.data_version().unwrap();
        reader.create_page(None, "Eigene", None).unwrap();
        assert_eq!(reader.data_version().unwrap(), before, "own commits do not count");
        let other = Database::open(&path).unwrap();
        other.create_page(None, "Fremde", None).unwrap();
        assert_ne!(reader.data_version().unwrap(), before);
        drop((reader, other));
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }
}
