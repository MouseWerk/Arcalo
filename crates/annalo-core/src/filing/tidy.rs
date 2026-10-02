//! „Aufräumen …“: the moves that would bring existing pages into the scheme of their type and
//! the rules, shown as a dry run; the chosen ones are applied in one transaction. A page is only
//! taken out of the top level or a system folder (one the filing created or adopted), never out
//! of a folder the user made, unless a rule names it. „Verschieben nach …“ moves many pages at
//! once. Both remember the last bulk move for „Rückgängig“.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{FileInfo, FileType, Granularity, Kids, PageFacts, Target, filing_target, root_folder, series_name};
use crate::db::Database;
use crate::error::{Error, Result};
use crate::tr;

/// One proposed move.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TidyMove {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    /// Folder path now (empty: the top level).
    pub from: String,
    /// Folder path after the move.
    pub to: String,
    pub kind: Option<FileType>,
    /// The id of the rule that decided.
    pub rule: Option<String>,
    /// Whether folders are created for it.
    pub creates: bool,
}

/// What a bulk move did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MoveOutcome {
    pub moved: usize,
    pub folders: usize,
}

/// The last bulk move that can be undone.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LastMove {
    /// `tidy` or `move`.
    pub label: String,
    pub pages: usize,
}

struct Row {
    id: i64,
    parent: Option<i64>,
    title: String,
    icon: Option<String>,
    system_folder: Option<String>,
    file_type: Option<String>,
    file_date: Option<String>,
    file_group: Option<String>,
    daily_date: Option<String>,
    created: String,
    head: String,
}

/// The pages, tags and meeting notes the plan looks at, read at once.
pub(crate) struct Snapshot {
    rows: HashMap<i64, Row>,
    order: Vec<i64>,
    children: HashMap<i64, Vec<i64>>,
    tags: HashMap<i64, Vec<String>>,
    meetings: HashSet<i64>,
    settings: crate::settings::Settings,
    /// Root folder id → its type.
    roots: HashMap<i64, FileType>,
}

fn date_of(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s.get(..10)?, "%Y-%m-%d").ok()
}

impl Snapshot {
    pub(crate) fn read(db: &Database) -> Result<Self> {
        let conn = db.conn();
        let mut rows = HashMap::new();
        let mut order = Vec::new();
        let mut children: HashMap<i64, Vec<i64>> = HashMap::new();
        {
            // The first 4000 characters hold the frontmatter rules and the Jira key look at.
            let mut st = conn.prepare(
                "SELECT id, parent_id, title, icon, system_folder, file_type, file_date, file_group, daily_date, created_at,
                        substr(content, 1, 4000)
                 FROM pages WHERE deleted_at IS NULL ORDER BY position, id",
            )?;
            let it = st.query_map([], |r| {
                Ok(Row {
                    id: r.get(0)?,
                    parent: r.get(1)?,
                    title: r.get(2)?,
                    icon: r.get(3)?,
                    system_folder: r.get(4)?,
                    file_type: r.get(5)?,
                    file_date: r.get(6)?,
                    file_group: r.get(7)?,
                    daily_date: r.get(8)?,
                    created: r.get(9)?,
                    head: r.get(10)?,
                })
            })?;
            for row in it {
                let row = row?;
                if let Some(p) = row.parent {
                    children.entry(p).or_default().push(row.id);
                }
                order.push(row.id);
                rows.insert(row.id, row);
            }
        }
        let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
        {
            let mut st = conn.prepare("SELECT page_id, tag FROM page_tags")?;
            for r in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (id, tag) = r?;
                tags.entry(id).or_default().push(tag);
            }
        }
        let meetings = conn
            .prepare("SELECT note_page_id FROM calendar_marks WHERE note_page_id IS NOT NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let settings = db.load_settings().unwrap_or_default();
        let mut roots = HashMap::new();
        let mut kids = Kids::new(db);
        for kind in FileType::ALL {
            let (title, alts) = root_folder(&settings, kind);
            if title.is_empty() {
                continue;
            }
            let info = FileInfo { kind, date: NaiveDate::from_ymd_opt(2000, 1, 1).unwrap_or_default(), group: None };
            let cfg = super::TypeFiling { folder: String::new(), granularity: Granularity::None };
            let segs = super::type_path(&cfg, &info, &title, &alts, crate::i18n::lang());
            let (found, all) = kids.lookup(&segs, kind.as_str())?;
            if all && let Some(id) = found.last() {
                roots.insert(*id, kind);
            }
        }
        Ok(Snapshot { rows, order, children, tags, meetings, settings, roots })
    }

    fn system(&self, id: i64) -> bool {
        self.roots.contains_key(&id) || self.rows.get(&id).is_some_and(|r| r.system_folder.is_some())
    }

    /// The type a folder belongs to.
    fn folder_type(&self, id: i64) -> Option<FileType> {
        self.roots.get(&id).copied().or_else(|| self.rows.get(&id)?.system_folder.as_deref().and_then(FileType::parse))
    }

    fn facts(&self, r: &Row) -> PageFacts {
        PageFacts {
            title: r.title.clone(),
            tags: self.tags.get(&r.id).cloned().unwrap_or_default(),
            content: r.head.clone(),
        }
    }

    fn group(&self, db: &Database, kind: FileType, r: &Row) -> Option<String> {
        if let Some(g) = r.file_group.clone().filter(|g| !g.is_empty()) {
            return Some(g);
        }
        match kind {
            FileType::Meeting => Some(series_name(&r.title)).filter(|s| !s.is_empty()),
            FileType::Jira => {
                let project = super::jira_project(&r.title, &r.head)?;
                db.jira_group(&format!("{project}-1")).ok()
            }
            _ => None,
        }
    }

    /// The recorded type of a page, else one it is recognized by: a daily note, a meeting
    /// note, a Jira issue note, or a page without children inside a type's folders.
    pub(crate) fn info_of(&self, db: &Database, id: i64) -> Option<FileInfo> {
        let r = self.rows.get(&id)?;
        let created = date_of(&r.created).unwrap_or_default();
        let kind = r
            .file_type
            .as_deref()
            .and_then(FileType::parse)
            .or_else(|| r.daily_date.is_some().then_some(FileType::Journal))
            .or_else(|| self.meetings.contains(&id).then_some(FileType::Meeting))
            .or_else(|| crate::pagework::frontmatter_value(&r.head, "jira").is_some().then_some(FileType::Jira))
            .or_else(|| {
                if self.children.contains_key(&id) || r.system_folder.is_some() {
                    return None;
                }
                let mut cursor = r.parent;
                while let Some(p) = cursor {
                    if let Some(t) = self.folder_type(p) {
                        return Some(t);
                    }
                    if !self.system(p) {
                        return None;
                    }
                    cursor = self.rows.get(&p)?.parent;
                }
                None
            })?;
        let date = r
            .file_date
            .as_deref()
            .and_then(date_of)
            .or_else(|| r.daily_date.as_deref().and_then(date_of))
            .unwrap_or(created);
        Some(FileInfo { kind, date, group: self.group(db, kind, r) })
    }

    fn path_of(&self, parent: Option<i64>) -> String {
        let mut parts = Vec::new();
        let mut cursor = parent;
        while let Some(id) = cursor {
            let Some(r) = self.rows.get(&id) else { break };
            parts.push(r.title.as_str());
            cursor = r.parent;
        }
        parts.reverse();
        parts.join(" / ")
    }

    fn within(&self, id: i64, ancestor: i64) -> bool {
        let mut cursor = Some(id);
        while let Some(c) = cursor {
            if c == ancestor {
                return true;
            }
            cursor = self.rows.get(&c).and_then(|r| r.parent);
        }
        false
    }
}

pub(crate) struct Planned {
    pub view: TidyMove,
    pub target: Target,
    pub info: Option<FileInfo>,
    /// The type was recognized, not recorded: the apply records it.
    pub record: bool,
}

impl Database {
    /// The dry run of „Aufräumen …“ for the whole workspace or the pages below `scope`.
    pub fn tidy_plan(&self, scope: Option<i64>) -> Result<Vec<TidyMove>> {
        Ok(self.tidy_moves(scope)?.into_iter().map(|p| p.view).collect())
    }

    pub(crate) fn tidy_moves(&self, scope: Option<i64>) -> Result<Vec<Planned>> {
        let snap = Snapshot::read(self)?;
        let mut kids = Kids::new(self);
        let mut out = Vec::new();
        for &id in &snap.order {
            let r = &snap.rows[&id];
            if r.system_folder.is_some() || snap.roots.contains_key(&id) {
                continue;
            }
            if let Some(s) = scope
                && (s == id || !snap.within(id, s))
            {
                continue;
            }
            let info = snap.info_of(self, id);
            let Some(target) = filing_target(&snap.settings, &snap.facts(r), info.as_ref()) else { continue };
            // Out of a folder the user made only by a rule.
            if target.rule.is_none() && r.parent.is_some_and(|p| !snap.system(p)) {
                continue;
            }
            let (found, all) = kids.lookup(&target.segments, &target.mark)?;
            if all && found.last().copied() == r.parent {
                continue;
            }
            // Never into itself (a rule naming a folder below the page).
            if found.iter().any(|f| snap.within(*f, id)) {
                continue;
            }
            out.push(Planned {
                view: TidyMove {
                    page_id: id,
                    title: r.title.clone(),
                    icon: r.icon.clone(),
                    from: snap.path_of(r.parent),
                    to: target.path(),
                    kind: info.as_ref().map(|i| i.kind),
                    rule: target.rule.clone(),
                    creates: !all,
                },
                record: r.file_type.is_none() && info.is_some(),
                target,
                info,
            });
        }
        Ok(out)
    }

    /// Applies the planned moves of `page_ids` (a new plan, so nothing stale is applied) in one
    /// transaction and remembers them for [`Database::undo_last_move`].
    pub fn tidy_apply(&self, scope: Option<i64>, page_ids: &[i64]) -> Result<MoveOutcome> {
        let wanted: HashSet<i64> = page_ids.iter().copied().collect();
        self.atomic(|| {
            let plan: Vec<Planned> = self.tidy_moves(scope)?.into_iter().filter(|p| wanted.contains(&p.view.page_id)).collect();
            self.conn().execute("DELETE FROM move_undo", [])?;
            let mut kids = Kids::new(self);
            let mut out = MoveOutcome::default();
            let mut journal_folders = HashSet::new();
            for p in plan {
                let mut created = Vec::new();
                let parent = kids.ensure(&p.target.segments, &p.target.mark, &mut created)?;
                for f in &created {
                    self.conn().execute("INSERT INTO move_undo (page_id, created, label) VALUES (?1, 1, 'tidy')", [f])?;
                }
                out.folders += created.len();
                let old = self.page(p.view.page_id)?;
                if p.record
                    && let Some(i) = &p.info
                {
                    self.conn().execute(
                        "UPDATE pages SET file_type = ?2, file_date = ?3, file_group = ?4 WHERE id = ?1",
                        params![old.id, i.kind.as_str(), i.date.format("%Y-%m-%d").to_string(), i.group],
                    )?;
                }
                self.remember_move(&old, "tidy")?;
                self.append_child(old.id, parent)?;
                kids.moved(old.id, &old.title, old.parent_id, parent);
                if p.info.as_ref().is_some_and(|i| i.kind == FileType::Journal) && p.target.rule.is_none() {
                    journal_folders.insert(parent);
                }
                out.moved += 1;
            }
            // Daily notes newest first, as new ones are put.
            for f in journal_folders {
                self.conn().execute(
                    "UPDATE pages SET position = (SELECT COUNT(*) FROM pages s WHERE s.parent_id IS ?1 AND s.deleted_at IS NULL
                         AND s.daily_date IS NOT NULL AND s.daily_date > pages.daily_date)
                     WHERE parent_id IS ?1 AND deleted_at IS NULL AND daily_date IS NOT NULL",
                    [f],
                )?;
            }
            Ok(out)
        })
    }

    fn remember_move(&self, page: &crate::model::Page, label: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO move_undo (page_id, old_parent, old_position, label) VALUES (?1, ?2, ?3, ?4)",
            params![page.id, page.parent_id, page.position, label],
        )?;
        Ok(())
    }

    /// Puts a page last below `parent` (no renumbering of the old or new siblings).
    fn append_child(&self, id: i64, parent: Option<i64>) -> Result<()> {
        let pos: i64 = self.conn().query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM pages WHERE parent_id IS ?1 AND deleted_at IS NULL AND id <> ?2",
            params![parent, id],
            |r| r.get(0),
        )?;
        self.conn()
            .execute("UPDATE pages SET parent_id = ?2, position = ?3 WHERE id = ?1", params![id, parent, pos])?;
        Ok(())
    }

    fn ancestors(&self, id: i64) -> Result<Vec<i64>> {
        let mut out = Vec::new();
        let mut cursor = self.page(id)?.parent_id;
        while let Some(p) = cursor {
            if out.contains(&p) {
                break;
            }
            out.push(p);
            cursor = self.page(p)?.parent_id;
        }
        Ok(out)
    }

    /// „Verschieben nach …“: moves the pages below `parent` (last), in one transaction. Pages
    /// whose parent is moved too go along with it; a page is never moved into itself.
    pub fn move_pages(&self, page_ids: &[i64], parent: Option<i64>) -> Result<MoveOutcome> {
        if let Some(p) = parent
            && self.page(p)?.deleted_at.is_some()
        {
            return Err(Error::State(
                tr!("Die Zielseite liegt im Papierkorb", "The target page is in the trash").into(),
            ));
        }
        let set: HashSet<i64> = page_ids.iter().copied().collect();
        let target_line = match parent {
            Some(p) => {
                let mut a = self.ancestors(p)?;
                a.push(p);
                a
            }
            None => vec![],
        };
        self.atomic(|| {
            self.conn().execute("DELETE FROM move_undo", [])?;
            let mut out = MoveOutcome::default();
            let mut done = HashSet::new();
            for &id in page_ids {
                if !done.insert(id) {
                    continue;
                }
                let page = self.page(id)?;
                if page.deleted_at.is_some() || page.parent_id == parent || target_line.contains(&id) {
                    continue;
                }
                if self.ancestors(id)?.iter().any(|a| set.contains(a)) {
                    continue;
                }
                self.remember_move(&page, "move")?;
                self.append_child(id, parent)?;
                out.moved += 1;
            }
            Ok(out)
        })
    }

    /// The last bulk move, if it can still be undone.
    pub fn last_move(&self) -> Result<Option<LastMove>> {
        let (label, pages): (Option<String>, i64) =
            self.conn().query_row("SELECT MAX(label), COUNT(*) FROM move_undo WHERE created = 0", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        Ok(label.filter(|_| pages > 0).map(|label| LastMove { label, pages: pages as usize }))
    }

    /// Puts the pages of the last bulk move back where they were and removes the folders it
    /// created (when they are empty again). Returns the number of pages moved back.
    pub fn undo_last_move(&self) -> Result<usize> {
        self.atomic(|| {
            let rows: Vec<(i64, Option<i64>, i64, bool)> = self
                .conn()
                .prepare("SELECT page_id, old_parent, old_position, created FROM move_undo ORDER BY seq DESC")?
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let alive = |id: i64| -> Result<bool> {
                Ok(self
                    .conn()
                    .query_row("SELECT COUNT(*) FROM pages WHERE id = ?1 AND deleted_at IS NULL", [id], |r| r.get::<_, i64>(0))?
                    > 0)
            };
            let mut restored = 0;
            for (id, old_parent, pos, created) in &rows {
                if *created || !alive(*id)? {
                    continue;
                }
                let parent = match old_parent {
                    Some(p) if alive(*p)? => Some(*p),
                    _ => None,
                };
                self.move_page(*id, parent, *pos)?;
                restored += 1;
            }
            for (id, _, _, created) in &rows {
                if *created {
                    self.conn().execute(
                        "DELETE FROM pages WHERE id = ?1 AND content = '' AND NOT EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = ?1)",
                        [id],
                    )?;
                }
            }
            self.conn().execute("DELETE FROM move_undo", [])?;
            Ok(restored)
        })
    }
}
