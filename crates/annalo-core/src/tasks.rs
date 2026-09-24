//! Tasks across all notes: `- [ ] text` / `- [x] text` items with an optional
//! due date (`due:2026-09-30`; the calendar marker of Obsidian Tasks is read too) and priority (`!!` hoch,
//! `!` mittel). The `tasks` table is derived from page content on every save.

use std::collections::HashSet;

use chrono::{DateTime, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};

/// The calendar marker Obsidian Tasks puts before a due date; read for imported notes,
/// never written (Annalo writes `due:`).
pub const OBSIDIAN_DUE: &str = "\u{1F4C5}";

/// A task item as found in a page's Markdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTask {
    /// 0-based among the page's (non-empty) task items.
    pub ordinal: usize,
    /// 0-based line in the Markdown.
    pub line: usize,
    /// Byte offset of the checkbox character (` ` or `x`) within the line.
    check: usize,
    pub done: bool,
    /// The text without checkbox, due date and priority markers; `[[links]]` and `#tags` stay.
    pub text: String,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    /// 0 none, 1 mittel (`!`), 2 hoch (`!!`).
    pub priority: u8,
    pub tags: Vec<String>,
}

/// A task with its page, as listed in the task view and returned to the assistant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Task {
    pub page_id: i64,
    pub page_title: String,
    pub page_icon: Option<String>,
    pub ordinal: i64,
    pub line: i64,
    pub text: String,
    pub done: bool,
    pub due: Option<String>,
    pub priority: u8,
    /// Own `#tags` plus the page's tags written outside task lines.
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    #[default]
    Open,
    Done,
    All,
}

/// Filter for [`Database::list_tasks`]. `None` fields do not filter.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskFilter {
    pub status: TaskStatus,
    /// Only tasks due on or before this day (`YYYY-MM-DD`).
    pub due_before: Option<String>,
    /// Tag of the task itself or written outside task lines on its page.
    pub tag: Option<String>,
    pub page_id: Option<i64>,
    /// Only tasks on pages saved since then: a local day `YYYY-MM-DD` (from its midnight) or
    /// an RFC 3339 time. Tasks are derived from Markdown, so this is the closest to “done since”.
    pub changed_since: Option<String>,
}

/// Counts of open tasks, see [`Database::open_task_counts`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskCounts {
    pub open: i64,
    pub overdue: i64,
    pub due_today: i64,
    /// Open tasks on the page asked for (0 without one).
    pub on_page: i64,
}

/// `tpl(id)`: the templates page („Vorlagen“, title in `?1`) and everything below it.
/// Checkboxes in templates are blueprints, not tasks.
const TEMPLATE_PAGES: &str = "WITH RECURSIVE tpl(id) AS (
                 SELECT id FROM (SELECT id FROM pages
                                 WHERE parent_id IS NULL AND deleted_at IS NULL AND title = ?1 COLLATE NOCASE
                                 ORDER BY id LIMIT 1)
                 UNION ALL
                 SELECT p.id FROM pages p JOIN tpl ON p.parent_id = tpl.id)";

/// `changed_since` as a UTC timestamp comparable with `pages.updated_at`.
fn changed_since_ts<Tz: TimeZone>(s: &str, tz: &Tz) -> Result<String> {
    let s = s.trim();
    let t = if let Some(d) = (s.len() == 10).then(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()).flatten() {
        let midnight = d.and_time(NaiveTime::MIN);
        tz.from_local_datetime(&midnight)
            .earliest()
            .or_else(|| tz.from_local_datetime(&(midnight + chrono::Duration::hours(1))).earliest())
            .map(|t| t.with_timezone(&Utc))
    } else {
        DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
    };
    t.map(crate::db::ts).ok_or_else(|| Error::Parse(format!("'changed_since' muss YYYY-MM-DD oder RFC 3339 sein: {s}")))
}

fn parse_date(s: &str) -> Option<String> {
    (s.len() == 10 && NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()).then(|| s.to_owned())
}

/// Checkbox of a list item line: (byte offset of the box character, done, text after the box).
fn checkbox(line: &str) -> Option<(usize, bool, &str)> {
    let body = line.trim_start();
    let indent = line.len() - body.len();
    // `-`, `*`, `+` or `1.` / `1)` followed by a space.
    let marker = if body.starts_with(['-', '*', '+']) {
        1
    } else {
        let digits = body.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || !body[digits..].starts_with(['.', ')']) {
            return None;
        }
        digits + 1
    };
    let after = body[marker..].strip_prefix(' ')?;
    let b = after.as_bytes();
    if b.len() < 3 || b[0] != b'[' || b[2] != b']' || !matches!(b[1], b' ' | b'x' | b'X') {
        return None;
    }
    let rest = &after[3..];
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    Some((indent + marker + 1 + 1, b[1] != b' ', rest))
}

/// All task items outside fenced code blocks.
pub fn parse_tasks(markdown: &str) -> Vec<ParsedTask> {
    let mut out = vec![];
    let mut in_fence = false;
    for (line_no, line) in markdown.lines().enumerate() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some((check, done, rest)) = checkbox(line) else { continue };
        let mut due = None;
        let mut priority = 0;
        let mut words: Vec<&str> = vec![];
        let toks: Vec<&str> = rest.split_whitespace().collect();
        let mut i = 0;
        while i < toks.len() {
            let t = toks[i];
            if t == OBSIDIAN_DUE && i + 1 < toks.len() && parse_date(toks[i + 1]).is_some() {
                due = parse_date(toks[i + 1]);
                i += 2;
                continue;
            }
            if let Some(d) = t.strip_prefix(OBSIDIAN_DUE).or_else(|| t.strip_prefix("due:")).and_then(parse_date) {
                due = Some(d);
            } else if t == "!!" {
                priority = 2;
            } else if t == "!" {
                priority = priority.max(1);
            } else {
                words.push(t);
            }
            i += 1;
        }
        let text = words.join(" ");
        if text.is_empty() {
            continue;
        }
        let tags = crate::notes::tags(&text);
        out.push(ParsedTask { ordinal: out.len(), line: line_no, check, done, text, due, priority, tags });
    }
    out
}

/// Sets the checkbox of task `ordinal`; `None` when the page has no such task.
/// Everything else, including line endings, stays byte for byte.
pub fn set_task_state(markdown: &str, ordinal: usize, done: bool) -> Option<String> {
    let task = parse_tasks(markdown).into_iter().nth(ordinal)?;
    let mut out = String::with_capacity(markdown.len());
    for (i, line) in markdown.split_inclusive('\n').enumerate() {
        if i == task.line {
            out.push_str(&line[..task.check]);
            out.push(if done { 'x' } else { ' ' });
            out.push_str(&line[task.check + 1..]);
        } else {
            out.push_str(line);
        }
    }
    Some(out)
}

impl Database {
    /// Rebuilds the task rows of one page (called from `reindex_page`).
    pub(crate) fn reindex_tasks(&self, id: i64, content: &str) -> Result<()> {
        let conn = self.conn();
        conn.execute("DELETE FROM tasks WHERE page_id = ?1", [id])?;
        let mut ins = conn.prepare_cached(
            "INSERT INTO tasks (page_id, ordinal, line, text, done, due, priority, tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        let tasks = parse_tasks(content);
        // Tags outside task lines (frontmatter, prose) belong to the page and so to each of its
        // tasks; a tag inside one task does not spread to the others.
        let task_lines: HashSet<usize> = tasks.iter().map(|t| t.line).collect();
        let prose: Vec<&str> =
            content.lines().enumerate().filter(|(i, _)| !task_lines.contains(i)).map(|(_, l)| l).collect();
        let page_tags = crate::notes::tags(&prose.join("\n"));
        for t in tasks {
            let mut tags = t.tags;
            tags.extend(page_tags.iter().filter(|p| !tags.contains(p)).cloned().collect::<Vec<_>>());
            ins.execute(params![
                id,
                t.ordinal as i64,
                t.line as i64,
                t.text,
                t.done,
                t.due,
                t.priority,
                tags.join(" ")
            ])?;
        }
        Ok(())
    }

    /// Open tasks outside templates: all, overdue and due on `today` (`YYYY-MM-DD`, the local
    /// day), and all on `page_id`; counted in SQLite (the assistant's suggestions only need
    /// the numbers, not thousands of tasks).
    pub fn open_task_counts(&self, today: &str, page_id: Option<i64>) -> Result<TaskCounts> {
        let mut st = self.conn().prepare_cached(&format!(
            "{TEMPLATE_PAGES}
             SELECT COUNT(*),
                    COALESCE(SUM(t.due IS NOT NULL AND t.due < ?2), 0),
                    COALESCE(SUM(t.due = ?2), 0),
                    COALESCE(SUM(t.page_id = ?3), 0)
             FROM tasks t JOIN pages p ON p.id = t.page_id
             WHERE p.deleted_at IS NULL AND t.page_id NOT IN tpl AND t.done = 0"
        ))?;
        Ok(st.query_row(params![crate::templates::TEMPLATES_TITLE, today, page_id], |r| {
            Ok(TaskCounts { open: r.get(0)?, overdue: r.get(1)?, due_today: r.get(2)?, on_page: r.get(3)? })
        })?)
    }

    /// Tasks of all pages: open first, then by due date (undated last), priority and page.
    pub fn list_tasks(&self, f: &TaskFilter) -> Result<Vec<Task>> {
        let done = match f.status {
            TaskStatus::Open => Some(false),
            TaskStatus::Done => Some(true),
            TaskStatus::All => None,
        };
        let tag = f.tag.as_deref().map(|t| t.trim().trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty());
        let since = f
            .changed_since
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(|s| changed_since_ts(s, &Local))
            .transpose()?;
        // Only the filters that are set go into the query, so the indexes on (done, due) and
        // (page_id, …) are used (`?1 IS NULL OR …` hides them from the planner).
        let mut conds: Vec<&str> = vec![];
        let mut args: Vec<rusqlite::types::Value> = vec![crate::templates::TEMPLATES_TITLE.to_owned().into()];
        if let Some(done) = done {
            conds.push("t.done = ?");
            args.push(done.into());
        }
        if let Some(due) = &f.due_before {
            conds.push("t.due <= ?");
            args.push(due.clone().into());
        }
        if let Some(tag) = tag {
            conds.push("instr(' ' || t.tags || ' ', ' ' || ? || ' ') > 0");
            args.push(tag.into());
        }
        if let Some(page) = f.page_id {
            conds.push("t.page_id = ?");
            args.push(page.into());
        }
        if let Some(since) = since {
            conds.push("p.updated_at >= ?");
            args.push(since.into());
        }
        let extra: String = conds.iter().map(|c| format!(" AND {c}")).collect();
        let mut st = self.conn().prepare_cached(&format!(
            "{TEMPLATE_PAGES}
             SELECT t.page_id, p.title, p.icon, t.ordinal, t.line, t.text, t.done, t.due, t.priority, t.tags
             FROM tasks t JOIN pages p ON p.id = t.page_id
             WHERE p.deleted_at IS NULL AND t.page_id NOT IN tpl{extra}
             ORDER BY t.done, t.due IS NULL, t.due, t.priority DESC, p.title COLLATE NOCASE, t.page_id, t.ordinal"
        ))?;
        let rows = st
            .query_map(rusqlite::params_from_iter(args), |r| {
                let tags: String = r.get(9)?;
                Ok(Task {
                    page_id: r.get(0)?,
                    page_title: r.get(1)?,
                    page_icon: r.get(2)?,
                    ordinal: r.get(3)?,
                    line: r.get(4)?,
                    text: r.get(5)?,
                    done: r.get(6)?,
                    due: r.get(7)?,
                    priority: r.get(8)?,
                    tags: tags.split_whitespace().map(str::to_owned).collect(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Checks or unchecks task `ordinal` of a page by rewriting exactly its
    /// checkbox, then saves the page so links, tags and the index stay consistent.
    ///
    /// `expected_text` is the task text the caller saw. If the page changed in the meantime
    /// and task `ordinal` has another text, the task with that text is used when it is unique;
    /// otherwise the call fails so the caller reloads its list.
    pub fn set_task_done(&self, page_id: i64, ordinal: i64, done: bool, expected_text: Option<&str>) -> Result<()> {
        let content: String = self
            .conn()
            .query_row("SELECT content FROM pages WHERE id = ?1", [page_id], |r| r.get(0))
            .map_err(|_| Error::not_found("page", page_id.to_string()))?;
        let missing = || Error::not_found("task", format!("{page_id}/{ordinal}"));
        let mut ordinal = usize::try_from(ordinal).map_err(|_| missing())?;
        if let Some(expected) = expected_text {
            let tasks = parse_tasks(&content);
            if tasks.get(ordinal).is_none_or(|t| t.text != expected) {
                let mut same = tasks.iter().filter(|t| t.text == expected);
                match (same.next(), same.next()) {
                    (Some(t), None) => ordinal = t.ordinal,
                    _ => return Err(Error::State("Die Aufgabe wurde inzwischen geändert – Liste neu geladen".into())),
                }
            }
        }
        let updated = set_task_state(&content, ordinal, done).ok_or_else(missing)?;
        if updated != content {
            self.save_page_content(page_id, &updated)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_due_dates_priorities_and_tags() {
        let md = "# Plan\n- [ ] Angebot an [[Kunde X]] due:2026-09-30 !! #vertrieb\n\
                  * [x] Review due:2026-09-01 !\n  - [ ] Unterpunkt\n1. [X] Nummeriert\n\
                  - [ ] \n- [] kein Task\n- normal\n- [ ]ohne Leerzeichen\n\
                  ```\n- [ ] im Code\n```\n- [ ] \u{1F4C5}2026-10-01 ungültig due:2026-13-01";
        let t = parse_tasks(md);
        let texts: Vec<_> = t.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(
            texts,
            ["Angebot an [[Kunde X]] #vertrieb", "Review", "Unterpunkt", "Nummeriert", "ungültig due:2026-13-01"]
        );
        assert_eq!((t[0].due.as_deref(), t[0].priority, t[0].done), (Some("2026-09-30"), 2, false));
        assert_eq!(t[0].tags, ["vertrieb"]);
        assert_eq!((t[1].due.as_deref(), t[1].priority, t[1].done), (Some("2026-09-01"), 1, true));
        assert!(t[3].done);
        assert_eq!(t[4].due.as_deref(), Some("2026-10-01"));
        assert_eq!(t.iter().map(|t| t.ordinal).collect::<Vec<_>>(), [0, 1, 2, 3, 4]);
        assert_eq!(t[2].line, 3);
    }

    #[test]
    fn toggles_exactly_one_checkbox() {
        let md = "Intro [ ] nicht\r\n```\n- [ ] Code\n```\n- [ ] eins\r\n  - [x] zwei\n";
        assert_eq!(set_task_state(md, 0, true).unwrap(), md.replace("- [ ] eins", "- [x] eins"));
        assert_eq!(set_task_state(md, 1, false).unwrap(), md.replace("- [x] zwei", "- [ ] zwei"));
        assert_eq!(set_task_state(md, 1, true).unwrap(), md);
        assert!(set_task_state(md, 2, true).is_none());
    }

    #[test]
    fn index_filters_and_set_task_done() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Projekt", None).unwrap();
        let b = db.create_page(None, "Privat", None).unwrap();
        db.save_page_content(a.id, "#kunde\n\n- [ ] Später\n- [ ] Bald due:2026-09-20 !\n- [x] Fertig due:2026-09-01")
            .unwrap();
        db.save_page_content(b.id, "- [ ] Einkaufen #haushalt due:2026-09-25 !!\n- [ ] Putzen").unwrap();

        let open = db.list_tasks(&TaskFilter::default()).unwrap();
        let texts: Vec<_> = open.iter().map(|t| t.text.as_str()).collect();
        assert_eq!(texts, ["Bald", "Einkaufen #haushalt", "Putzen", "Später"]);
        assert_eq!(open[0].page_title, "Projekt");

        let due = db.list_tasks(&TaskFilter { due_before: Some("2026-09-22".into()), ..Default::default() }).unwrap();
        assert_eq!(due.len(), 1);
        let kunde = db.list_tasks(&TaskFilter { tag: Some("#Kunde".into()), ..Default::default() }).unwrap();
        assert_eq!(kunde.len(), 2, "page tag matches");
        let haushalt = db.list_tasks(&TaskFilter { tag: Some("haushalt".into()), ..Default::default() }).unwrap();
        assert_eq!(haushalt.len(), 1, "task tag does not spread to other tasks");
        let all = db.list_tasks(&TaskFilter { status: TaskStatus::All, page_id: Some(a.id), ..Default::default() });
        assert_eq!(all.unwrap().len(), 3);

        db.set_task_done(a.id, 0, true, None).unwrap();
        assert_eq!(
            db.page_doc(a.id).unwrap().content,
            "#kunde\n\n- [x] Später\n- [ ] Bald due:2026-09-20 !\n- [x] Fertig due:2026-09-01"
        );
        let done = db.list_tasks(&TaskFilter { status: TaskStatus::Done, ..Default::default() }).unwrap();
        assert_eq!(done.len(), 2);
        assert!(db.set_task_done(a.id, 9, true, None).is_err());
        assert!(db.set_task_done(999, 0, true, None).is_err());

        db.delete_page(b.id).unwrap();
        assert_eq!(db.list_tasks(&TaskFilter::default()).unwrap().len(), 1);
    }

    #[test]
    fn trashed_pages_hide_their_tasks() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Liste", None).unwrap();
        db.save_page_content(p.id, "- [ ] offen\n").unwrap();
        let all = TaskFilter { status: TaskStatus::All, ..Default::default() };
        assert_eq!(db.list_tasks(&all).unwrap().len(), 1);
        db.trash_page(p.id).unwrap();
        assert!(db.list_tasks(&all).unwrap().is_empty());
    }

    #[test]
    fn changed_since_limits_to_recently_saved_pages() {
        let db = Database::open_in_memory().unwrap();
        let old = db.create_page(None, "Alt", None).unwrap();
        let new = db.create_page(None, "Neu", None).unwrap();
        db.save_page_content(old.id, "- [x] Längst erledigt").unwrap();
        db.save_page_content(new.id, "- [x] Diese Woche").unwrap();
        db.conn().execute("UPDATE pages SET updated_at = '2026-09-01T10:00:00Z' WHERE id = ?1", [old.id]).unwrap();
        db.conn().execute("UPDATE pages SET updated_at = '2026-09-21T06:00:00Z' WHERE id = ?1", [new.id]).unwrap();
        let done = |since: &str| {
            let f = TaskFilter { status: TaskStatus::Done, changed_since: Some(since.into()), ..Default::default() };
            db.list_tasks(&f).unwrap().into_iter().map(|t| t.text).collect::<Vec<_>>()
        };
        assert_eq!(done("2026-09-21T00:00:00Z"), ["Diese Woche"]);
        assert_eq!(done("2026-08-01T00:00:00+02:00").len(), 2);
        assert_eq!(done("").len(), 2, "empty does not filter");
        let bad = TaskFilter { changed_since: Some("letzte Woche".into()), ..Default::default() };
        assert!(db.list_tasks(&bad).is_err());

        // A local day starts at local midnight.
        let cet = chrono::FixedOffset::east_opt(7200).unwrap();
        assert_eq!(changed_since_ts("2026-09-21", &cet).unwrap(), "2026-09-20T22:00:00Z");
        assert_eq!(changed_since_ts("2026-09-21T08:00:00+02:00", &cet).unwrap(), "2026-09-21T06:00:00Z");
    }

    #[test]
    fn set_task_done_follows_moved_tasks() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Liste", None).unwrap();
        db.save_page_content(p.id, "- [ ] eins\n- [ ] zwei\n").unwrap();
        // The list showed „zwei“ at ordinal 1; meanwhile a task was inserted above it.
        db.save_page_content(p.id, "- [ ] neu\n- [ ] eins\n- [ ] zwei\n").unwrap();
        db.set_task_done(p.id, 1, true, Some("zwei")).unwrap();
        assert_eq!(db.page_doc(p.id).unwrap().content, "- [ ] neu\n- [ ] eins\n- [x] zwei\n");
        // Matching ordinal: used as is.
        db.set_task_done(p.id, 0, true, Some("neu")).unwrap();
        assert!(db.page_doc(p.id).unwrap().content.starts_with("- [x] neu"));

        db.save_page_content(p.id, "- [ ] doppelt\n- [ ] x\n- [ ] doppelt\n").unwrap();
        let e = db.set_task_done(p.id, 1, true, Some("doppelt")).unwrap_err();
        assert!(matches!(e, Error::State(_)), "ambiguous");
        assert!(matches!(db.set_task_done(p.id, 1, true, Some("weg")).unwrap_err(), Error::State(_)), "gone");
        assert_eq!(db.page_doc(p.id).unwrap().content, "- [ ] doppelt\n- [ ] x\n- [ ] doppelt\n");
    }

    #[test]
    fn template_tasks_are_not_listed() {
        let db = Database::open_in_memory().unwrap();
        let root = db.templates_root().unwrap();
        let t = db.create_page(Some(root.id), "Besprechung", None).unwrap();
        let nested = db.create_page(Some(t.id), "Variante", None).unwrap();
        db.save_page_content(root.id, "- [ ] Wurzel\n").unwrap();
        db.save_page_content(t.id, "- [ ] Protokoll senden\n").unwrap();
        db.save_page_content(nested.id, "- [ ] Agenda\n").unwrap();
        let p = db.create_page(None, "Echt", None).unwrap();
        db.save_page_content(p.id, "- [ ] Echte Aufgabe\n").unwrap();
        let texts: Vec<_> = db.list_tasks(&TaskFilter::default()).unwrap().into_iter().map(|t| t.text).collect();
        assert_eq!(texts, ["Echte Aufgabe"]);
        // Only the live „Vorlagen“ page is the templates root: a new one (any case) takes over.
        db.trash_page(root.id).unwrap();
        let other = db.create_page(None, "vorlagen", None).unwrap();
        db.save_page_content(other.id, "- [ ] Neu\n").unwrap();
        assert_eq!(db.list_tasks(&TaskFilter::default()).unwrap().len(), 1);
    }

    #[test]
    fn counts_and_filters_match_the_full_list() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "A", None).unwrap();
        let b = db.create_page(None, "B", None).unwrap();
        db.save_page_content(
            a.id,
            "- [ ] alt due:2026-09-01 #kunde\n- [ ] heute due:2026-09-24\n- [ ] später due:2026-12-01 !!\n- [x] fertig due:2026-09-01\n- [ ] ohne",
        )
        .unwrap();
        db.save_page_content(b.id, "#projekt\n- [ ] auch alt due:2026-09-20\n- [x] erledigt").unwrap();
        let root = db.templates_root().unwrap();
        let tpl = db.create_page(Some(root.id), "Vorlage", None).unwrap();
        db.save_page_content(tpl.id, "- [ ] Vorlagenaufgabe due:2026-01-01").unwrap();

        let open = db.list_tasks(&TaskFilter::default()).unwrap();
        let today = "2026-09-24";
        let c = db.open_task_counts(today, Some(a.id)).unwrap();
        assert_eq!(c.open, open.len() as i64);
        assert_eq!(c.open, 5);
        assert_eq!(c.overdue, open.iter().filter(|t| t.due.as_deref().is_some_and(|d| d < today)).count() as i64);
        assert_eq!(c.overdue, 2);
        assert_eq!(c.due_today, 1);
        assert_eq!(c.on_page, open.iter().filter(|t| t.page_id == a.id).count() as i64);
        assert_eq!(db.open_task_counts(today, None).unwrap().on_page, 0);

        // Every filter combination equals filtering the full list.
        let all = db.list_tasks(&TaskFilter { status: TaskStatus::All, ..Default::default() }).unwrap();
        for status in [TaskStatus::Open, TaskStatus::Done, TaskStatus::All] {
            for page_id in [None, Some(a.id)] {
                for tag in [None, Some("#Projekt".to_owned())] {
                    for due_before in [None, Some("2026-09-24".to_owned())] {
                        let f = TaskFilter {
                            status,
                            page_id,
                            tag: tag.clone(),
                            due_before: due_before.clone(),
                            ..Default::default()
                        };
                        let want: Vec<&Task> = all
                            .iter()
                            .filter(|t| match status {
                                TaskStatus::Open => !t.done,
                                TaskStatus::Done => t.done,
                                TaskStatus::All => true,
                            })
                            .filter(|t| page_id.is_none_or(|p| t.page_id == p))
                            .filter(|t| tag.is_none() || t.tags.iter().any(|x| x == "projekt"))
                            .filter(|t| due_before.as_deref().is_none_or(|d| t.due.as_deref().is_some_and(|x| x <= d)))
                            .collect();
                        let got = db.list_tasks(&f).unwrap();
                        assert_eq!(got.iter().collect::<Vec<_>>(), want, "{f:?}");
                    }
                }
            }
        }
    }
}
