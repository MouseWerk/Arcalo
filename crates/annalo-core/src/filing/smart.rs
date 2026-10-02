//! Smart folders in the sidebar: virtual, read-only lists computed by SQL — recently edited,
//! favorites, pages without a folder, orphans (no links in or out), and pages by tag, by Jira
//! project and by Netzplan.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;

/// How many pages a smart folder lists at most.
pub const SMART_LIMIT: usize = 200;
/// „Zuletzt bearbeitet“ lists this many.
pub const SMART_RECENT: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SmartKind {
    Recent,
    Favorites,
    Unfiled,
    Orphans,
    Tags,
    Jira,
    Netzplan,
}

/// The number of entries of each smart folder (groups for tags, Jira and Netzplan).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmartCounts {
    pub recent: usize,
    pub favorites: usize,
    pub unfiled: usize,
    pub orphans: usize,
    pub tags: usize,
    pub jira: usize,
    pub netzplan: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmartPage {
    pub id: i64,
    pub title: String,
    pub icon: Option<String>,
    pub updated_at: String,
}

/// A tag, Jira project or Netzplan with its pages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SmartGroup {
    pub key: String,
    pub label: String,
    pub count: usize,
}

const LIVE: &str = "p.deleted_at IS NULL AND p.system_folder IS NULL";
const LEAF: &str = "NOT EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL)";

/// Pages with a `jira:` property and their project key.
const JIRA_CTE: &str = "WITH j AS (
    SELECT p.id, ltrim(substr(p.content, instr(p.content, char(10) || 'jira:') + 6, 40)) AS k
      FROM pages p WHERE p.deleted_at IS NULL AND p.content LIKE '---%' AND instr(p.content, char(10) || 'jira:') > 0
), jp AS (
    SELECT id, upper(substr(k, 1, instr(k, '-') - 1)) AS proj FROM j WHERE instr(k, '-') > 1
)";

/// Pages with a Netzplan: from `vorgang: NP/…` or `netzplan: NP` in the frontmatter and from
/// their bookings.
const NETZPLAN_CTE: &str = "WITH v AS (
    SELECT p.id, ltrim(substr(p.content, instr(p.content, char(10) || 'vorgang:') + 9, 60)) AS t
      FROM pages p WHERE p.deleted_at IS NULL AND p.content LIKE '---%' AND instr(p.content, char(10) || 'vorgang:') > 0
), n AS (
    SELECT p.id, ltrim(substr(p.content, instr(p.content, char(10) || 'netzplan:') + 10, 60)) AS t
      FROM pages p WHERE p.deleted_at IS NULL AND p.content LIKE '---%' AND instr(p.content, char(10) || 'netzplan:') > 0
), np AS (
    SELECT id, trim(substr(t, 1, instr(t, '/') - 1), ' \"''') AS nr FROM v
     WHERE instr(t, '/') > 1 AND instr(t, '/') < instr(t || char(10), char(10))
    UNION
    SELECT id, trim(substr(t, 1, instr(t || char(10), char(10)) - 1), ' \"''' || char(13)) FROM n
    UNION
    SELECT e.page_id, z.netzplan_nr FROM time_entries e JOIN netzplaene z ON z.id = e.netzplan_id
     JOIN pages p ON p.id = e.page_id AND p.deleted_at IS NULL WHERE e.page_id IS NOT NULL
)";

fn page_row(r: &rusqlite::Row) -> rusqlite::Result<SmartPage> {
    Ok(SmartPage { id: r.get(0)?, title: r.get(1)?, icon: r.get(2)?, updated_at: r.get(3)? })
}

impl Database {
    /// The pages of a list smart folder (recent, favorites, unfiled, orphans) or of one group
    /// (`key`: the tag, project key or Netzplan).
    pub fn smart_pages(&self, kind: SmartKind, key: Option<&str>) -> Result<Vec<SmartPage>> {
        let cols = "p.id, p.title, p.icon, p.updated_at";
        let limit = SMART_LIMIT as i64;
        let key = key.unwrap_or("");
        let sql = match kind {
            SmartKind::Recent => format!(
                "SELECT {cols} FROM pages p WHERE {LIVE} AND p.content <> '' ORDER BY p.updated_at DESC, p.id DESC LIMIT {SMART_RECENT}"
            ),
            SmartKind::Favorites => format!("SELECT {cols} FROM pages p WHERE {LIVE} AND p.favorite = 1 ORDER BY p.title COLLATE NOCASE LIMIT ?1"),
            SmartKind::Unfiled => format!(
                "SELECT {cols} FROM pages p WHERE {LIVE} AND p.parent_id IS NULL AND {LEAF} ORDER BY p.title COLLATE NOCASE LIMIT ?1"
            ),
            SmartKind::Orphans => return self.orphans(),
            SmartKind::Tags => format!(
                "SELECT {cols} FROM pages p JOIN page_tags t ON t.page_id = p.id WHERE {LIVE} AND t.tag = ?2
                 ORDER BY p.updated_at DESC LIMIT ?1"
            ),
            SmartKind::Jira => format!(
                "{JIRA_CTE} SELECT {cols} FROM pages p JOIN jp ON jp.id = p.id WHERE {LIVE} AND jp.proj = upper(?2)
                 ORDER BY p.title COLLATE NOCASE LIMIT ?1"
            ),
            SmartKind::Netzplan => format!(
                "{NETZPLAN_CTE} SELECT DISTINCT {cols} FROM pages p JOIN np ON np.id = p.id WHERE {LIVE} AND np.nr = ?2 COLLATE NOCASE
                 ORDER BY p.updated_at DESC LIMIT ?1"
            ),
        };
        let mut st = self.conn().prepare(&sql)?;
        let n = st.parameter_count();
        let rows = match n {
            0 => st.query_map([], page_row)?.collect::<rusqlite::Result<_>>()?,
            1 => st.query_map(rusqlite::params![limit], page_row)?.collect::<rusqlite::Result<_>>()?,
            _ => st.query_map(rusqlite::params![limit, key], page_row)?.collect::<rusqlite::Result<_>>()?,
        };
        Ok(rows)
    }

    /// Pages without links in or out (no daily notes, no folders, no templates). The candidates come from SQL;
    /// a title with non-ASCII letters is checked once more against the link targets, which are
    /// lower-cased by Rust's rules (SQLite's `lower` only knows ASCII).
    fn orphans(&self) -> Result<Vec<SmartPage>> {
        let sql = format!(
            "SELECT p.id, p.title, p.icon, p.updated_at FROM pages p
             WHERE {LIVE} AND p.daily_date IS NULL AND {LEAF}
               AND (p.parent_id IS NULL OR p.parent_id NOT IN (SELECT t.id FROM pages t WHERE t.parent_id IS NULL
                    AND t.title IN ('{tpl}' COLLATE NOCASE, '{tpl_en}' COLLATE NOCASE)))
               AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.from_page = p.id)
               AND NOT EXISTS (SELECT 1 FROM page_links l JOIN pages s ON s.id = l.from_page AND s.deleted_at IS NULL
                               WHERE l.target = lower(p.title))
             ORDER BY p.updated_at DESC",
            tpl = crate::templates::TEMPLATES_TITLE,
            tpl_en = crate::templates::TEMPLATES_TITLE_EN,
        );
        let all: Vec<SmartPage> =
            self.conn().prepare(&sql)?.query_map([], page_row)?.collect::<rusqlite::Result<_>>()?;
        let mut st = self.conn().prepare_cached(
            "SELECT 1 FROM page_links l JOIN pages s ON s.id = l.from_page AND s.deleted_at IS NULL WHERE l.target = ?1 LIMIT 1",
        )?;
        let mut out = Vec::new();
        for p in all {
            if !p.title.is_ascii() && st.exists([p.title.to_lowercase()])? {
                continue;
            }
            out.push(p);
            if out.len() >= SMART_LIMIT {
                break;
            }
        }
        Ok(out)
    }

    /// The groups of a grouped smart folder (tags, Jira projects, Netzplans) with their counts.
    pub fn smart_groups(&self, kind: SmartKind) -> Result<Vec<SmartGroup>> {
        let rows: Vec<(String, i64)> = match kind {
            SmartKind::Tags => self
                .conn()
                .prepare(&format!(
                    "SELECT t.tag, COUNT(*) FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE {LIVE}
                     GROUP BY t.tag ORDER BY t.tag"
                ))?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?,
            SmartKind::Jira => self
                .conn()
                .prepare(&format!(
                    "{JIRA_CTE} SELECT jp.proj, COUNT(*) FROM jp JOIN pages p ON p.id = jp.id WHERE {LIVE} GROUP BY jp.proj ORDER BY jp.proj"
                ))?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?,
            SmartKind::Netzplan => self
                .conn()
                .prepare(&format!(
                    "{NETZPLAN_CTE} SELECT np.nr, COUNT(DISTINCT np.id) FROM np JOIN pages p ON p.id = np.id
                     WHERE {LIVE} AND np.nr <> '' GROUP BY np.nr COLLATE NOCASE ORDER BY np.nr COLLATE NOCASE"
                ))?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?,
            _ => return Ok(vec![]),
        };
        let names: BTreeMap<String, String> = match kind {
            SmartKind::Jira => self
                .conn()
                .prepare("SELECT key, name FROM issue_projects WHERE name <> ''")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?,
            SmartKind::Netzplan => self
                .conn()
                .prepare("SELECT upper(netzplan_nr), description FROM netzplaene WHERE description <> ''")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?,
            _ => BTreeMap::new(),
        };
        Ok(rows
            .into_iter()
            .map(|(key, count)| {
                let label = match names.get(&key.to_uppercase()).or_else(|| names.get(&key)) {
                    Some(n) => format!("{key} {n}"),
                    None if kind == SmartKind::Tags => format!("#{key}"),
                    None => key.clone(),
                };
                SmartGroup { key, label, count: count as usize }
            })
            .collect())
    }

    /// All counts at once (for the section headers).
    pub fn smart_counts(&self) -> Result<SmartCounts> {
        let count =
            |sql: String| -> Result<usize> { Ok(self.conn().query_row(&sql, [], |r| r.get::<_, i64>(0))? as usize) };
        Ok(SmartCounts {
            recent: count(format!(
                "SELECT MIN(COUNT(*), {SMART_RECENT}) FROM pages p WHERE {LIVE} AND p.content <> ''"
            ))?,
            favorites: count(format!("SELECT COUNT(*) FROM pages p WHERE {LIVE} AND p.favorite = 1"))?,
            unfiled: count(format!("SELECT COUNT(*) FROM pages p WHERE {LIVE} AND p.parent_id IS NULL AND {LEAF}"))?,
            orphans: self.orphans()?.len(),
            tags: count(format!(
                "SELECT COUNT(DISTINCT t.tag) FROM page_tags t JOIN pages p ON p.id = t.page_id WHERE {LIVE}"
            ))?,
            jira: count(format!(
                "{JIRA_CTE} SELECT COUNT(DISTINCT jp.proj) FROM jp JOIN pages p ON p.id = jp.id WHERE {LIVE}"
            ))?,
            netzplan: count(format!(
                "{NETZPLAN_CTE} SELECT COUNT(DISTINCT upper(np.nr)) FROM np JOIN pages p ON p.id = np.id WHERE {LIVE} AND np.nr <> ''"
            ))?,
        })
    }
}
