//! Trash: deleting a page moves it with its subtree to the trash. Entries can
//! be restored or purged; entries older than [`RETENTION_DAYS`] are purged on start.
//!
//! Pages trashed together share one `deleted_at` stamp, which is how an entry's
//! subtree is told apart from children that were trashed separately before.

use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, PAGE_COLS, map_page};
use crate::error::{Error, Result};
use crate::model::Page;

/// Trashed pages older than this are purged automatically.
pub const RETENTION_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrashEntry {
    #[serde(flatten)]
    pub page: Page,
    /// Pages trashed together with this one (its subtree).
    pub descendants: usize,
    /// Title of the former parent page, if it still exists.
    pub parent_title: Option<String>,
}

/// Millisecond precision keeps separate deletions apart.
fn stamp(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Millis, true)
}

impl Database {
    /// `root` and the pages below it that were trashed together with it.
    fn trashed_subtree(&self, root: i64, deleted_at: &str) -> Result<Vec<i64>> {
        let mut st = self.conn().prepare_cached(
            "WITH RECURSIVE sub(id) AS (
                 SELECT ?1 UNION ALL
                 SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at = ?2)
             SELECT id FROM sub",
        )?;
        Ok(st.query_map(params![root, deleted_at], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    fn trashed(&self, id: i64) -> Result<(Page, String)> {
        let page = self.page(id)?;
        match page.deleted_at.clone() {
            Some(at) => Ok((page, at)),
            None => Err(Error::State(format!("„{}“ liegt nicht im Papierkorb", page.title))),
        }
    }

    /// Moves a page and its subtree to the trash. Returns the number of pages moved.
    pub fn trash_page(&self, id: i64) -> Result<usize> {
        self.trash_page_at(id, Utc::now())
    }

    pub fn trash_page_at(&self, id: i64, at: DateTime<Utc>) -> Result<usize> {
        let page = self.page(id)?;
        if page.deleted_at.is_some() {
            return Err(Error::State(format!("„{}“ liegt bereits im Papierkorb", page.title)));
        }
        Ok(self.conn().execute(
            "WITH RECURSIVE sub(id) AS (
                 SELECT ?1 UNION ALL
                 SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL)
             UPDATE pages SET deleted_at = ?2 WHERE id IN sub",
            params![id, stamp(at)],
        )?)
    }

    /// Restores a trashed page with the subtree trashed together with it. If
    /// its parent is gone or trashed, it returns at the top level. Title and
    /// daily-note clashes with pages created in the meantime are resolved.
    pub fn restore_page(&self, id: i64) -> Result<Page> {
        let (page, at) = self.trashed(id)?;
        let ids = self.trashed_subtree(id, &at)?;
        self.atomic(|| {
            let conn = self.conn();
            let parent_live = match page.parent_id {
                Some(p) => {
                    conn.query_row("SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL", [p], |_| Ok(()))
                        .optional()?
                        .is_some()
                }
                None => true,
            };
            if !parent_live {
                conn.execute(
                    "UPDATE pages SET parent_id = NULL,
                         position = (SELECT COALESCE(MAX(position) + 1, 0) FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL)
                     WHERE id = ?1",
                    [id],
                )?;
            }
            for pid in &ids {
                conn.execute(
                    "UPDATE pages SET daily_date = NULL WHERE id = ?1 AND daily_date IN
                         (SELECT daily_date FROM pages WHERE deleted_at IS NULL AND daily_date IS NOT NULL)",
                    [pid],
                )?;
                conn.execute("UPDATE pages SET deleted_at = NULL WHERE id = ?1", [pid])?;
                let title = self.page(*pid)?.title;
                // Same semantics as `page_by_title`: case-insensitive beyond ASCII („Übersicht“ = „übersicht“).
                let others: std::collections::HashSet<String> = {
                    let mut st =
                        conn.prepare_cached("SELECT title FROM pages WHERE deleted_at IS NULL AND id <> ?1")?;
                    st.query_map([pid], |r| r.get::<_, String>(0))?
                        .map(|t| t.map(|t| t.trim().to_lowercase()))
                        .collect::<rusqlite::Result<_>>()?
                };
                let taken = |t: &str| others.contains(&t.trim().to_lowercase());
                if taken(&title) {
                    let mut n = 2;
                    while taken(&format!("{title} {n}")) {
                        n += 1;
                    }
                    self.rename_page(*pid, &format!("{title} {n}"))?;
                }
            }
            self.page(id)
        })
    }

    /// Trash entries (pages deleted as a whole, not their subpages), newest first.
    pub fn list_trash(&self) -> Result<Vec<TrashEntry>> {
        let pages: Vec<Page> = {
            let mut st = self.conn().prepare_cached(&format!(
                "SELECT {PAGE_COLS} FROM pages c WHERE c.deleted_at IS NOT NULL AND NOT EXISTS
                     (SELECT 1 FROM pages p WHERE p.id = c.parent_id AND p.deleted_at = c.deleted_at)
                 ORDER BY c.deleted_at DESC, c.id"
            ))?;
            st.query_map([], map_page)?.collect::<rusqlite::Result<_>>()?
        };
        pages
            .into_iter()
            .map(|page| {
                let descendants = self.trashed_subtree(page.id, page.deleted_at.as_deref().unwrap_or(""))?.len() - 1;
                let parent_title = match page.parent_id {
                    Some(p) => self.page(p).ok().map(|p| p.title),
                    None => None,
                };
                Ok(TrashEntry { page, descendants, parent_title })
            })
            .collect()
    }

    /// Deletes a trashed page and the subtree trashed with it permanently.
    /// Subpages trashed separately stay in the trash. Returns the number of pages deleted.
    pub fn purge_page(&self, id: i64) -> Result<usize> {
        let (_, at) = self.trashed(id)?;
        let ids = self.trashed_subtree(id, &at)?;
        self.atomic(|| {
            for pid in &ids {
                // Detach children that are not part of this deletion so the cascade spares them.
                self.conn().execute(
                    "UPDATE pages SET parent_id = NULL WHERE parent_id = ?1 AND deleted_at IS NOT ?2",
                    params![pid, at],
                )?;
            }
            self.conn().execute("DELETE FROM pages WHERE id = ?1", [id])?;
            Ok(ids.len())
        })
    }

    /// Purges every trash entry. Returns the number of pages deleted.
    pub fn empty_trash(&self) -> Result<usize> {
        self.atomic(|| self.list_trash()?.iter().map(|e| self.purge_page(e.page.id)).sum())
    }

    /// Purges entries trashed more than the retention (Settings → Notizen, default
    /// [`RETENTION_DAYS`]) before `now`.
    pub fn purge_expired_trash(&self, now: DateTime<Utc>) -> Result<usize> {
        let days = self.load_settings().map(|s| s.notes.trash_retention_days as i64).unwrap_or(RETENTION_DAYS);
        self.purge_trash_older_than(now, days)
    }

    /// Purges entries trashed more than `days` before `now`.
    pub fn purge_trash_older_than(&self, now: DateTime<Utc>, days: i64) -> Result<usize> {
        let cutoff = stamp(now - Duration::days(days.max(1)));
        self.atomic(|| {
            self.list_trash()?
                .iter()
                .filter(|e| e.page.deleted_at.as_deref().is_some_and(|d| d < cutoff.as_str()))
                .map(|e| self.purge_page(e.page.id))
                .sum()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn t(day: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, day, 10, 0, 0).unwrap()
    }

    #[test]
    fn trashed_subtree_is_hidden_everywhere() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Architektur", None).unwrap();
        let child = db.create_page(Some(a.id), "Datenbank", None).unwrap();
        let src = db.create_page(None, "Meeting", None).unwrap();
        db.save_page_content(a.id, "Schnittstellen #projekt\n\n[[Meeting]]").unwrap();
        db.save_page_content(child.id, "Kapselung der Schnittstellen").unwrap();
        db.save_page_content(src.id, "Siehe [[Architektur]]").unwrap();

        assert_eq!(db.trash_page_at(a.id, t(1)).unwrap(), 2);
        assert!(db.trash_page(a.id).is_err(), "already trashed");
        let tree = db.page_tree().unwrap();
        assert_eq!(tree.iter().map(|n| n.page.title.as_str()).collect::<Vec<_>>(), ["Meeting"]);
        assert!(db.page_by_title("Architektur").unwrap().is_none());
        assert!(crate::search::search(&db, "Schnittstellen", 10).unwrap().is_empty());
        assert!(crate::search::search(&db, "Datenbank", 10).unwrap().is_empty());
        assert!(db.tag_counts().unwrap().is_empty());
        assert!(db.pages_with_tag("projekt").unwrap().is_empty());
        assert!(db.recent_pages(10).unwrap().iter().all(|p| p.id == src.id));
        assert!(db.page_doc(src.id).unwrap().unresolved_links.contains(&"Architektur".to_string()));
        assert!(db.page_doc(src.id).unwrap().backlinks.is_empty(), "trashed pages do not link");
        assert!(crate::ai::rag::pending_blocks(&db, 10).unwrap().iter().all(|(_, t)| !t.contains("Schnittstellen")));
        assert!(crate::ai::rag::retrieve(&db, "Schnittstellen", None, 5).unwrap().is_empty());
        assert!(db.create_page(Some(a.id), "Neu", None).is_err(), "no children under trashed pages");

        let trash = db.list_trash().unwrap();
        assert_eq!(trash.len(), 1);
        assert_eq!((trash[0].page.id, trash[0].descendants), (a.id, 1));

        let restored = db.restore_page(a.id).unwrap();
        assert!(restored.deleted_at.is_none());
        assert_eq!(db.page_tree().unwrap()[0].children[0].page.id, child.id);
        assert_eq!(crate::search::search(&db, "Schnittstellen", 10).unwrap().len(), 2);
        assert!(db.list_trash().unwrap().is_empty());
    }

    #[test]
    fn restore_goes_to_root_when_parent_is_trashed_and_resolves_clashes() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Eltern", None).unwrap();
        let c = db.create_page(Some(p.id), "Kind", None).unwrap();
        db.trash_page_at(c.id, t(1)).unwrap();
        db.trash_page_at(p.id, t(2)).unwrap();
        let trash = db.list_trash().unwrap();
        assert_eq!(trash.iter().map(|e| e.page.id).collect::<Vec<_>>(), [p.id, c.id], "newest first, separately");
        assert_eq!(trash[1].parent_title.as_deref(), Some("Eltern"));

        // Restoring the parent leaves the separately trashed child in the trash.
        db.restore_page(p.id).unwrap();
        assert!(db.page_tree().unwrap()[0].children.is_empty());
        db.trash_page_at(p.id, t(3)).unwrap();
        db.create_page(None, "Kind", None).unwrap();
        let back = db.restore_page(c.id).unwrap();
        assert_eq!((back.parent_id, back.title.as_str()), (None, "Kind 2"));

        // Clashes are found beyond ASCII case folding.
        let u = db.create_page(None, "Übersicht", None).unwrap();
        db.trash_page_at(u.id, t(4)).unwrap();
        db.create_page(None, "ÜBERSICHT", None).unwrap();
        assert_eq!(db.restore_page(u.id).unwrap().title, "Übersicht 2");
    }

    #[test]
    fn purge_empty_and_expiry() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Alt", None).unwrap();
        let c = db.create_page(Some(p.id), "Unterseite", None).unwrap();
        let q = db.create_page(None, "Neu", None).unwrap();
        db.trash_page_at(c.id, t(1)).unwrap();
        db.trash_page_at(p.id, t(2)).unwrap();
        assert!(db.purge_page(q.id).is_err(), "live pages cannot be purged");

        assert_eq!(db.purge_page(p.id).unwrap(), 1);
        assert!(db.page(p.id).is_err());
        assert_eq!(db.page(c.id).unwrap().parent_id, None, "separately trashed child survives");

        db.trash_page_at(q.id, t(20)).unwrap();
        // 30 days after the 1st: only the child entry is expired.
        assert_eq!(db.purge_expired_trash(t(1) + Duration::days(31)).unwrap(), 1);
        assert_eq!(db.list_trash().unwrap().len(), 1);
        assert_eq!(db.empty_trash().unwrap(), 1);
        assert!(db.list_trash().unwrap().is_empty());
    }

    #[test]
    fn trashed_daily_note_does_not_block_a_new_one() {
        let db = Database::open_in_memory().unwrap();
        let d = chrono::NaiveDate::from_ymd_opt(2026, 9, 23).unwrap();
        let first = db.daily_note(d).unwrap();
        db.trash_page_at(first.id, t(1)).unwrap();
        let second = db.daily_note(d).unwrap();
        assert_ne!(first.id, second.id);
        let back = db.restore_page(first.id).unwrap();
        assert_eq!(back.daily_date, None, "the live note keeps the day");
        assert_eq!(db.daily_note(d).unwrap().id, second.id);
    }
}
