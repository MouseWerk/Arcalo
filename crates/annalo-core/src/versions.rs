//! Page version history („Versionen“, like Obsidian's file recovery).
//!
//! Saving a page keeps the content it had before as a snapshot when the page's newest
//! snapshot is older than [`SNAPSHOT_INTERVAL_MINUTES`] (autosave runs every few hundred
//! milliseconds, so this yields one version per editing session, not per keystroke).
//! Restores and link rewrites by a rename always snapshot first. Each page keeps at most
//! [`MAX_VERSIONS_PER_PAGE`]; versions older than [`RETENTION_DAYS`] are pruned on start.

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};

/// A save snapshots the previous content when the newest snapshot is at least this old.
pub const SNAPSHOT_INTERVAL_MINUTES: i64 = 10;
/// Older snapshots of a page beyond this number are dropped.
pub const MAX_VERSIONS_PER_PAGE: usize = 50;
/// Snapshots older than this are pruned on start.
pub const RETENTION_DAYS: i64 = 30;
/// Characters of a version shown in the list.
const PREVIEW_CHARS: usize = 120;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct VersionInfo {
    pub id: i64,
    pub page_id: i64,
    pub created_at: DateTime<Utc>,
    /// Size of the content in bytes.
    pub size: usize,
    /// The first characters, whitespace collapsed.
    pub preview: String,
}

fn preview(content: &str) -> String {
    let flat = content.split_whitespace().collect::<Vec<_>>().join(" ");
    flat.chars().take(PREVIEW_CHARS).collect()
}

impl Database {
    fn current_content(&self, page_id: i64) -> Result<String> {
        self.conn()
            .query_row("SELECT content FROM pages WHERE id = ?1", [page_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::not_found("page", page_id.to_string()))
    }

    /// When the page's newest snapshot was taken (only the time: a save asks this every time,
    /// and a snapshot of a long note is large).
    fn latest_version_at(&self, page_id: i64) -> Result<Option<DateTime<Utc>>> {
        let at: Option<String> = self
            .conn()
            .prepare_cached(
                "SELECT created_at FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
            )?
            .query_row([page_id], |r| r.get(0))
            .optional()?;
        at.map(|t| parse_ts(&t)).transpose().map_err(Error::Db)
    }

    /// Whether the page's newest snapshot holds exactly `content` (compared in SQLite).
    fn latest_version_is(&self, page_id: i64, content: &str) -> Result<bool> {
        let same: Option<bool> = self
            .conn()
            .prepare_cached(
                "SELECT content = ?2 FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC, id DESC LIMIT 1",
            )?
            .query_row(params![page_id, content], |r| r.get(0))
            .optional()?;
        Ok(same.unwrap_or(false))
    }

    /// (snapshot interval in minutes, versions kept per page) from Settings → Notizen.
    fn version_policy(&self) -> (i64, usize) {
        self.load_settings()
            .map(|s| (s.notes.version_interval_minutes as i64, s.notes.max_versions as usize))
            .unwrap_or((SNAPSHOT_INTERVAL_MINUTES, MAX_VERSIONS_PER_PAGE))
    }

    /// Stores `content` as a snapshot of the page unless it is empty or equals the newest
    /// snapshot; keeps at most the configured number (default [`MAX_VERSIONS_PER_PAGE`]).
    /// Returns the new version's id.
    pub(crate) fn store_version(&self, page_id: i64, content: &str, now: DateTime<Utc>) -> Result<Option<i64>> {
        if content.trim().is_empty() {
            return Ok(None);
        }
        if self.latest_version_is(page_id, content)? {
            return Ok(None);
        }
        let conn = self.conn();
        conn.execute(
            "INSERT INTO page_versions (page_id, content, created_at) VALUES (?1, ?2, ?3)",
            params![page_id, content, ts(now)],
        )?;
        let id = conn.last_insert_rowid();
        conn.execute(
            "DELETE FROM page_versions WHERE page_id = ?1 AND id NOT IN
               (SELECT id FROM page_versions WHERE page_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2)",
            params![page_id, self.version_policy().1 as i64],
        )?;
        Ok(Some(id))
    }

    /// Called before a save replaces `old` with `new`: snapshots `old` when the content
    /// changes and the newest snapshot is older than [`SNAPSHOT_INTERVAL_MINUTES`].
    pub(crate) fn snapshot_before_save(&self, page_id: i64, old: &str, new: &str, now: DateTime<Utc>) -> Result<()> {
        if old == new {
            return Ok(());
        }
        let due = match self.latest_version_at(page_id)? {
            Some(at) => now - at >= Duration::minutes(self.version_policy().0),
            None => true,
        };
        if due {
            self.store_version(page_id, old, now)?;
        }
        Ok(())
    }

    /// Snapshots the page's current content now („Jetzt Version sichern“). `None` when there
    /// is nothing new to keep (empty page, or identical to the newest snapshot).
    pub fn snapshot_page(&self, page_id: i64) -> Result<Option<i64>> {
        self.snapshot_page_at(page_id, Utc::now())
    }

    pub fn snapshot_page_at(&self, page_id: i64, now: DateTime<Utc>) -> Result<Option<i64>> {
        let content = self.current_content(page_id)?;
        self.store_version(page_id, &content, now)
    }

    /// The page's snapshots, newest first.
    pub fn list_versions(&self, page_id: i64) -> Result<Vec<VersionInfo>> {
        let mut st = self.conn().prepare_cached(
            "SELECT id, page_id, created_at, content FROM page_versions WHERE page_id = ?1
             ORDER BY created_at DESC, id DESC",
        )?;
        let rows = st
            .query_map([page_id], |r| {
                let content: String = r.get(3)?;
                Ok(VersionInfo {
                    id: r.get(0)?,
                    page_id: r.get(1)?,
                    created_at: parse_ts(&r.get::<_, String>(2)?)?,
                    size: content.len(),
                    preview: preview(&content),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn version_content(&self, version_id: i64) -> Result<String> {
        self.conn()
            .query_row("SELECT content FROM page_versions WHERE id = ?1", [version_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| Error::not_found("version", version_id.to_string()))
    }

    /// Puts a snapshot back as the page's content. The current content is snapshotted
    /// first, so a restore can itself be undone. Saves through [`Database::save_page_content`],
    /// so search, links, tags and tasks follow.
    pub fn restore_version(&self, page_id: i64, version_id: i64) -> Result<()> {
        let owner: Option<i64> = self
            .conn()
            .query_row("SELECT page_id FROM page_versions WHERE id = ?1", [version_id], |r| r.get(0))
            .optional()?;
        if owner != Some(page_id) {
            return Err(Error::not_found("version", version_id.to_string()));
        }
        let content = self.version_content(version_id)?;
        self.atomic(|| {
            self.snapshot_page_at(page_id, Utc::now())?;
            self.save_page_content(page_id, &content)
        })
    }

    /// Drops snapshots older than [`RETENTION_DAYS`] and trims every page to
    /// [`MAX_VERSIONS_PER_PAGE`]. Returns the number of removed snapshots.
    pub fn prune_versions(&self, now: DateTime<Utc>) -> Result<usize> {
        let cutoff = ts(now - Duration::days(RETENTION_DAYS));
        self.atomic(|| {
            let conn = self.conn();
            let mut n = conn.execute("DELETE FROM page_versions WHERE created_at < ?1", [cutoff])?;
            n += conn.execute(
                "DELETE FROM page_versions WHERE id IN (
                   SELECT id FROM (
                     SELECT id, ROW_NUMBER() OVER (PARTITION BY page_id ORDER BY created_at DESC, id DESC) AS rn
                     FROM page_versions)
                   WHERE rn > ?1)",
                [self.version_policy().1 as i64],
            )?;
            Ok(n)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(min: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap() + Duration::minutes(min)
    }

    #[test]
    fn saves_snapshot_the_previous_content_at_most_every_ten_minutes() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content_at(p.id, "eins", t(0)).unwrap();
        assert!(db.list_versions(p.id).unwrap().is_empty(), "an empty page has nothing to keep");
        db.save_page_content_at(p.id, "zwei", t(1)).unwrap();
        db.save_page_content_at(p.id, "drei", t(5)).unwrap();
        db.save_page_content_at(p.id, "drei", t(30)).unwrap();
        let v = db.list_versions(p.id).unwrap();
        assert_eq!(v.len(), 1, "one per editing session; unchanged saves take none");
        assert_eq!(db.version_content(v[0].id).unwrap(), "eins");
        db.save_page_content_at(p.id, "vier", t(12)).unwrap();
        let v = db.list_versions(p.id).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(db.version_content(v[0].id).unwrap(), "drei", "newest first");
        assert_eq!((v[0].size, v[0].preview.as_str()), (4, "drei"));
    }

    #[test]
    fn restore_snapshots_first_and_updates_the_index() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(p.id, "alt #alpha\n- [ ] Aufgabe").unwrap();
        let first = db.snapshot_page(p.id).unwrap().unwrap();
        assert_eq!(db.snapshot_page(p.id).unwrap(), None, "identical to the newest snapshot");
        db.save_page_content(p.id, "neu #beta").unwrap();
        db.restore_version(p.id, first).unwrap();
        let doc = db.page_doc(p.id).unwrap();
        assert_eq!(doc.content, "alt #alpha\n- [ ] Aufgabe");
        assert_eq!(doc.tags, ["alpha"]);
        assert_eq!(db.list_tasks(&Default::default()).unwrap().len(), 1);
        let contents: Vec<String> =
            db.list_versions(p.id).unwrap().iter().map(|v| db.version_content(v.id).unwrap()).collect();
        assert!(contents.contains(&"neu #beta".to_string()), "the replaced content is kept: {contents:?}");
        // A version of another page cannot be restored here.
        let q = db.create_page(None, "Andere", None).unwrap();
        assert!(db.restore_version(q.id, first).is_err());
    }

    #[test]
    fn rename_keeps_the_rewritten_pages() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Alt", None).unwrap();
        let b = db.create_page(None, "Quelle", None).unwrap();
        db.save_page_content(b.id, "Siehe [[Alt]]").unwrap();
        db.snapshot_page(b.id).unwrap();
        db.save_page_content(b.id, "Siehe [[Alt]] und mehr").unwrap();
        db.rename_page_linked(a.id, "Neu", true).unwrap();
        let v = db.list_versions(b.id).unwrap();
        assert_eq!(db.version_content(v[0].id).unwrap(), "Siehe [[Alt]] und mehr");
    }

    #[test]
    fn keeps_fifty_per_page_and_prunes_old_ones() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        for i in 0..60 {
            db.save_page_content_at(p.id, &format!("Stand {i}"), t(i * 11)).unwrap();
        }
        let v = db.list_versions(p.id).unwrap();
        assert_eq!(v.len(), MAX_VERSIONS_PER_PAGE);
        assert_eq!(db.version_content(v[0].id).unwrap(), "Stand 58");
        assert_eq!(db.prune_versions(t(0) + Duration::days(RETENTION_DAYS)).unwrap(), 0);
        let later = t(59 * 11) + Duration::days(RETENTION_DAYS);
        assert_eq!(db.prune_versions(later).unwrap(), 49, "all but the last snapshot are older than 30 days");
        // Purging the page removes its history.
        db.delete_page(p.id).unwrap();
        assert!(db.list_versions(p.id).unwrap().is_empty());
    }
}
