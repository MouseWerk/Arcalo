//! The JSON shapes of `--json` (documented in docs/cli.md; fields are only ever added) and how a
//! page is named on the command line: `id:42`, its exact title or its path `Projekte/Alpha`.

use std::cell::RefCell;
use std::collections::HashMap;

use arcalo_core::model::Page;
use arcalo_core::{Database, Result, tr, trf};
use serde::Serialize;

use crate::output::{Failure, Outcome};

/// A page. `path` is the titles from the top level down, joined with `/`.
#[derive(Debug, Clone, Serialize)]
pub struct PageOut {
    pub id: i64,
    pub title: String,
    pub path: String,
    pub parent_id: Option<i64>,
    pub icon: Option<String>,
    /// `note` or `canvas`.
    pub kind: String,
    /// `YYYY-MM-DD` for a daily note.
    pub daily_date: Option<String>,
    pub favorite: bool,
    pub updated_at: String,
    /// Set while the page is in the trash.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

/// The pages of the workspace by id, for paths and references; pages outside the list (trashed
/// subpages) are read when a path needs them.
pub struct Pages<'a> {
    db: &'a Database,
    by_id: RefCell<HashMap<i64, Page>>,
    /// Live pages in tree order (position, id).
    pub live: Vec<Page>,
    /// The entries of the trash (pages trashed on their own, with their subtree).
    pub trash: Vec<Page>,
}

impl<'a> Pages<'a> {
    pub fn load(db: &'a Database) -> Result<Pages<'a>> {
        let live = db.list_pages()?;
        let trash: Vec<Page> = db.list_trash()?.into_iter().map(|e| e.page).collect();
        let by_id = live.iter().chain(&trash).map(|p| (p.id, p.clone())).collect();
        Ok(Pages { db, by_id: RefCell::new(by_id), live, trash })
    }

    fn get(&self, id: i64) -> Option<Page> {
        if let Some(p) = self.by_id.borrow().get(&id) {
            return Some(p.clone());
        }
        let p = self.db.page(id).ok()?;
        self.by_id.borrow_mut().insert(id, p.clone());
        Some(p)
    }

    /// `Projekte/Alpha/Notizen`.
    pub fn path(&self, id: i64) -> String {
        let mut parts = vec![];
        let mut cursor = Some(id);
        // A cycle cannot be stored, but a broken file must not hang the command.
        while let Some(p) = cursor.and_then(|id| self.get(id)).filter(|_| parts.len() < 256) {
            parts.push(p.title.clone());
            cursor = p.parent_id;
        }
        parts.reverse();
        parts.join("/")
    }

    pub fn out(&self, p: &Page) -> PageOut {
        PageOut {
            id: p.id,
            title: p.title.clone(),
            path: self.path(p.id),
            parent_id: p.parent_id,
            icon: p.icon.clone(),
            kind: p.kind.clone().unwrap_or_else(|| "note".into()),
            daily_date: p.daily_date.clone(),
            favorite: p.favorite,
            updated_at: local_text(&p.updated_at),
            deleted_at: p.deleted_at.as_deref().map(local_text),
        }
    }

    /// The page `reference` names among the live pages (`trash`: among the trash's entries):
    /// `id:42`; a number that is an id (unless a page has it as its title too); the exact title
    /// (any case); or the path from the top level. A reference that fits several pages fails
    /// with the list of them.
    pub fn resolve(&self, reference: &str, trash: bool) -> Outcome<Page> {
        let r = reference.trim();
        let pool: &[Page] = if trash { &self.trash } else { &self.live };
        let in_scope = |p: &Page| p.deleted_at.is_some() == trash;
        if let Some(id) = r.strip_prefix("id:").map(str::trim) {
            let id: i64 = id.parse().map_err(|_| Failure::Usage(trf!("Keine Seiten-ID: {r}", "Not a page id: {r}")))?;
            return self.get(id).filter(in_scope).ok_or_else(|| not_found(r));
        }
        if r.is_empty() {
            return Err(Failure::Usage(tr!("Die Seite fehlt", "The page is missing").into()));
        }
        let lower = r.to_lowercase();
        let mut found: Vec<Page> = pool.iter().filter(|p| p.title.to_lowercase() == lower).cloned().collect();
        if let Ok(id) = r.parse::<i64>()
            && let Some(p) = self.get(id).filter(in_scope)
            && !found.iter().any(|f| f.id == p.id)
        {
            found.push(p);
        }
        if found.is_empty() && r.contains('/') {
            found = self.by_path(r, pool);
        }
        match found.len() {
            0 => Err(not_found(r)),
            1 => Ok(found.remove(0)),
            _ => Err(Failure::Ambiguous {
                message: trf!(
                    "„{r}“ passt zu {} Seiten: mit id:… oder dem Pfad eindeutig angeben",
                    "“{r}” fits {} pages: name one with id:… or its path",
                    found.len()
                ),
                matches: found.iter().map(|p| self.out(p)).collect(),
            }),
        }
    }

    /// Pages whose path is `path` (segments compared in any case).
    fn by_path(&self, path: &str, pool: &[Page]) -> Vec<Page> {
        let want: Vec<String> = path.split('/').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
        pool.iter()
            .filter(|p| {
                let have: Vec<String> = self.path(p.id).split('/').map(|s| s.trim().to_lowercase()).collect();
                have == want
            })
            .cloned()
            .collect()
    }
}

fn not_found(r: &str) -> Failure {
    Failure::NotFound(trf!("Seite „{r}“ nicht gefunden", "Page “{r}” not found"))
}

/// A page with its Markdown and what links to and from it.
#[derive(Debug, Serialize)]
pub struct PageDocOut {
    #[serde(flatten)]
    pub page: PageOut,
    pub content: String,
    pub tags: Vec<String>,
    /// Targets of the page's `[[links]]` (as written).
    pub links: Vec<String>,
    /// The targets among them that name no page yet.
    pub unresolved_links: Vec<String>,
    pub backlinks: Vec<BacklinkOut>,
}

#[derive(Debug, Serialize)]
pub struct BacklinkOut {
    pub id: i64,
    pub title: String,
    /// The line with the link.
    pub context: String,
}

/// A task, addressed by its page and its ordinal (0-based among the page's tasks).
#[derive(Debug, Serialize)]
pub struct TaskOut {
    pub page_id: i64,
    pub page_title: String,
    pub page_path: String,
    pub ordinal: i64,
    /// 0-based line of the task in the page's Markdown.
    pub line: i64,
    pub text: String,
    pub done: bool,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    /// 0 none, 1 medium (`!`), 2 high (`!!`).
    pub priority: u8,
    pub tags: Vec<String>,
    /// The repeat rule as written (`every:weekly`).
    pub recur: Option<String>,
}

impl TaskOut {
    pub fn of(t: &arcalo_core::tasks::Task, pages: &Pages) -> TaskOut {
        TaskOut {
            page_id: t.page_id,
            page_title: t.page_title.clone(),
            page_path: pages.path(t.page_id),
            ordinal: t.ordinal,
            line: t.line,
            text: t.text.clone(),
            done: t.done,
            due: t.due.clone(),
            priority: t.priority,
            tags: t.tags.clone(),
            recur: t.recur.as_ref().map(|r| r.tokens()),
        }
    }
}

/// A booking.
#[derive(Debug, Serialize)]
pub struct EntryOut {
    pub id: i64,
    /// `NP-8801/1020`, or the Netzplan alone.
    pub reference: String,
    pub project: String,
    pub netzplan: String,
    pub vorgang: Option<String>,
    pub activity_type: Option<String>,
    pub start: chrono::DateTime<chrono::FixedOffset>,
    pub end: Option<chrono::DateTime<chrono::FixedOffset>>,
    pub minutes: Option<i64>,
    pub description: String,
    /// `running`, `draft`, `released` or `exported`.
    pub status: arcalo_core::model::StatusFlag,
    /// The page it was booked from (`/zeit` in a note).
    pub page_id: Option<i64>,
}

/// A stored UTC time (RFC 3339) in the local zone with its offset; as stored when it is no time.
pub fn local_text(stored: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(stored)
        .map(|t| local(t.with_timezone(&chrono::Utc)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|_| stored.to_owned())
}

/// A time in the local zone with its offset (`2026-10-11T09:30:00+02:00`).
pub fn local(t: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::FixedOffset> {
    t.with_timezone(&chrono::Local).fixed_offset()
}

impl EntryOut {
    pub fn of(r: &arcalo_core::model::TimeEntryRow) -> EntryOut {
        let e = &r.entry;
        EntryOut {
            id: e.id,
            reference: e.vorgang_nr.as_ref().map_or(r.netzplan_nr.clone(), |v| format!("{}/{v}", r.netzplan_nr)),
            project: r.project_code.clone(),
            netzplan: r.netzplan_nr.clone(),
            vorgang: e.vorgang_nr.clone(),
            activity_type: e.leistungsart.clone(),
            start: local(e.start_time),
            end: e.end_time.map(local),
            minutes: e.duration_minutes,
            description: e.description.clone(),
            status: e.status_flag,
            page_id: e.page_id,
        }
    }
}
