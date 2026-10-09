//! Tasks across all notes: `- [ ] text` / `- [x] text` items with an optional
//! due date (`due:2026-09-30`; the calendar marker of Obsidian Tasks is read too) and priority (`!!` hoch,
//! `!` mittel). The `tasks` table is derived from page content on every save.

use crate::{tr, trf};
use std::collections::{HashMap, HashSet};
use std::ops::Range;

use chrono::{DateTime, Local, NaiveDate, NaiveTime, TimeZone, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::recurrence::{OBSIDIAN_RECUR, Recurrence};

/// The calendar marker Obsidian Tasks puts before a due date; read for imported notes,
/// never written (Arcalo writes `due:`).
pub const OBSIDIAN_DUE: &str = "\u{1F4C5}";

/// A task item as found in a page's Markdown.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedTask {
    /// 0-based among the page's (non-empty) task items.
    pub ordinal: usize,
    /// 0-based line in the Markdown.
    pub line: usize,
    /// Byte offset of the checkbox character (` ` or `x`) within the line.
    pub(crate) check: usize,
    pub done: bool,
    /// The text without checkbox, due date, priority and repeat markers; `[[links]]` and `#tags` stay.
    pub text: String,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    /// 0 none, 1 mittel (`!`), 2 hoch (`!!`).
    pub priority: u8,
    pub tags: Vec<String>,
    /// The repeat rule (`every:weekly`), see [`crate::recurrence`].
    pub recur: Option<Recurrence>,
    pub(crate) marks: Marks,
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
    /// The repeat rule, see [`crate::recurrence`].
    #[serde(default)]
    pub recur: Option<Recurrence>,
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

/// A row of `tasks` without its page and ordinal (see [`Database::reindex_tasks`]).
#[derive(Debug, PartialEq)]
struct TaskRow {
    line: i64,
    text: String,
    done: bool,
    due: Option<String>,
    priority: i64,
    tags: String,
    recur: Option<String>,
}

/// Compares like SQLite's `COLLATE NOCASE`: bytes, ASCII letters folded.
fn nocase_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.bytes().map(|c| c.to_ascii_lowercase()).cmp(b.bytes().map(|c| c.to_ascii_lowercase()))
}

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
    t.map(crate::db::ts).ok_or_else(|| {
        Error::Parse(trf!(
            "'changed_since' muss YYYY-MM-DD oder RFC 3339 sein: {s}",
            "'changed_since' must be YYYY-MM-DD or RFC 3339: {s}"
        ))
    })
}

/// A rule as stored in `tasks.recur` (`every:weekly until:2026-12-31`).
fn stored_rule(s: &str) -> Option<Recurrence> {
    parse_tasks(&format!("- [ ] x {s}")).pop()?.recur
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

/// Byte ranges of a task's markers within its line, for rewriting them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Marks {
    pub due: Vec<Range<usize>>,
    pub priority: Vec<Range<usize>>,
    /// The repeat rule (`every:…` and its words, or the Obsidian marker with its words) and `until:`.
    pub recur: Vec<Range<usize>>,
    /// A block id (`^abc123`) at the end of the line.
    pub block_id: Option<Range<usize>>,
    /// Where the task's text ends (before trailing whitespace).
    pub end: usize,
}

/// Whitespace-separated words of `s` with their byte offsets.
fn words_at(s: &str) -> Vec<(usize, &str)> {
    let mut out = vec![];
    let mut start = None;
    for (i, c) in s.char_indices() {
        if c.is_whitespace() {
            if let Some(st) = start.take() {
                out.push((st, &s[st..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(st) = start {
        out.push((st, &s[st..]));
    }
    out
}

/// A word that can continue a repeat rule written in words (`every:jede Woche`): not another
/// marker, link, tag or two-letter abbreviation (`so`, `do` are words in the text, too).
fn rule_word(w: &str) -> bool {
    w.chars().all(|c| c.is_alphanumeric() || c == '.' || c == ',' || c == '-')
        && !(w.chars().count() <= 2 && w.chars().all(char::is_alphabetic))
}

/// Starts of a repeat rule: `every:` (also `Every:`, German `wdh:`).
fn rule_value(t: &str) -> Option<&str> {
    ["every:", "Every:", "EVERY:", "wdh:", "Wdh:"].iter().find_map(|p| t.strip_prefix(p))
}

/// All task items outside fenced code blocks (```` ``` ```` or `~~~`, each closed by its own marker).
pub fn parse_tasks(markdown: &str) -> Vec<ParsedTask> {
    let mut out = vec![];
    let mut fence: Option<&str> = None;
    for (line_no, line) in markdown.lines().enumerate() {
        match (fence, crate::notes::fence_marker(line)) {
            (Some(f), m) => {
                if m == Some(f) {
                    fence = None;
                }
                continue;
            }
            (None, Some(m)) => {
                fence = Some(m);
                continue;
            }
            (None, None) => {}
        }
        let Some((check, done, rest)) = checkbox(line) else { continue };
        let base = check + 2;
        let mut due = None;
        let mut priority = 0;
        let mut recur: Option<Recurrence> = None;
        let mut until: Option<(usize, &str, Range<usize>, String)> = None;
        let mut marks = Marks::default();
        let mut words: Vec<&str> = vec![];
        let toks = words_at(rest);
        let span = |a: usize, b: usize| base + toks[a].0..base + toks[b].0 + toks[b].1.len();
        let mut i = 0;
        while i < toks.len() {
            let t = toks[i].1;
            if t == OBSIDIAN_DUE && i + 1 < toks.len() && parse_date(toks[i + 1].1).is_some() {
                due = parse_date(toks[i + 1].1);
                marks.due.push(span(i, i + 1));
                i += 2;
                continue;
            }
            // Obsidian Tasks: the marker, then the rule in words up to the next marker.
            if t == OBSIDIAN_RECUR && recur.is_none() {
                let mut j = i + 1;
                while j < toks.len() && toks[j].1.chars().all(|c| c.is_alphanumeric() || ".,-".contains(c)) {
                    j += 1;
                }
                let phrase: Vec<&str> = toks[i + 1..j].iter().map(|t| t.1).collect();
                if let Some(r) = (j > i + 1).then(|| Recurrence::parse(&phrase.join(" "))).flatten() {
                    recur = Some(r);
                    marks.recur.push(span(i, j - 1));
                    i = j;
                    continue;
                }
            }
            if let Some(value) = rule_value(t).filter(|_| recur.is_none()) {
                // The value alone (`every:weekly`), else the fewest following words that make a
                // rule, extended while each further word still changes it (`every:jeden Montag
                // und Mittwoch`).
                let mut found = (!value.is_empty()).then(|| Recurrence::parse(value)).flatten().map(|r| (r, i));
                if found.is_none() {
                    let mut phrase = value.to_owned();
                    let mut j = i + 1;
                    while j < toks.len() && j <= i + 6 && rule_word(toks[j].1) {
                        phrase.push(' ');
                        phrase.push_str(toks[j].1);
                        if let Some(r) = Recurrence::parse(&phrase)
                            && found.as_ref().is_none_or(|(prev, _)| *prev != r)
                        {
                            found = Some((r, j));
                        }
                        j += 1;
                    }
                }
                if let Some((r, last)) = found {
                    recur = Some(r);
                    marks.recur.push(span(i, last));
                    i = last + 1;
                    continue;
                }
            }
            if until.is_none()
                && let Some(d) =
                    ["until:", "Until:", "bis:", "Bis:"].iter().find_map(|p| t.strip_prefix(p)).and_then(parse_date)
            {
                until = Some((words.len(), t, span(i, i), d));
                i += 1;
                continue;
            }
            let due_word = ["due:", "Due:", "fällig:", "Fällig:"].iter().find_map(|p| t.strip_prefix(p));
            if let Some(d) = t.strip_prefix(OBSIDIAN_DUE).or(due_word).and_then(parse_date) {
                due = Some(d);
                marks.due.push(span(i, i));
            } else if t == "!!" {
                priority = 2;
                marks.priority.push(span(i, i));
            } else if t == "!" {
                priority = priority.max(1);
                marks.priority.push(span(i, i));
            } else {
                words.push(t);
            }
            i += 1;
        }
        // `until:` belongs to a rule; without one it is text.
        match (&mut recur, until) {
            (Some(r), Some((_, _, range, d))) => {
                r.until = Some(d);
                marks.recur.push(range);
            }
            (None, Some((at, word, _, _))) => words.insert(at, word),
            _ => {}
        }
        if let Some(&(off, last)) = toks.last() {
            marks.end = base + off + last.len();
            if last.len() > 1
                && last.starts_with('^')
                && last[1..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                marks.block_id = Some(base + off..marks.end);
            }
        } else {
            marks.end = base.min(line.len());
        }
        let text = words.join(" ");
        if text.is_empty() {
            continue;
        }
        let tags = crate::notes::tags(&text);
        out.push(ParsedTask {
            ordinal: out.len(),
            line: line_no,
            check,
            done,
            text,
            due,
            priority,
            tags,
            recur,
            marks,
        });
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
    /// Brings the task rows of one page up to date (called from `reindex_page`): only rows that
    /// changed are written (an edit of a long page left its thousands of tasks as they were, yet
    /// rewrote every row).
    pub(crate) fn reindex_tasks(&self, id: i64, content: &str) -> Result<()> {
        let conn = self.conn();
        let tasks = parse_tasks(content);
        // Tags outside task lines (frontmatter, prose) belong to the page and so to each of its
        // tasks; a tag inside one task does not spread to the others.
        let task_lines: HashSet<usize> = tasks.iter().map(|t| t.line).collect();
        let prose: Vec<&str> =
            content.lines().enumerate().filter(|(i, _)| !task_lines.contains(i)).map(|(_, l)| l).collect();
        let page_tags = crate::notes::tags(&prose.join("\n"));
        let fresh: Vec<TaskRow> = tasks
            .into_iter()
            .map(|t| {
                let mut tags = t.tags;
                tags.extend(page_tags.iter().filter(|p| !tags.contains(p)).cloned().collect::<Vec<_>>());
                TaskRow {
                    line: t.line as i64,
                    text: t.text,
                    done: t.done,
                    due: t.due,
                    priority: t.priority as i64,
                    tags: tags.join(" "),
                    recur: t.recur.as_ref().map(Recurrence::tokens),
                }
            })
            .collect();
        let stored: Vec<TaskRow> = conn
            .prepare_cached(
                "SELECT line, text, done, due, priority, tags, recur FROM tasks WHERE page_id = ?1 ORDER BY ordinal",
            )?
            .query_map([id], |r| {
                Ok(TaskRow {
                    line: r.get(0)?,
                    text: r.get(1)?,
                    done: r.get(2)?,
                    due: r.get(3)?,
                    priority: r.get(4)?,
                    tags: r.get(5)?,
                    recur: r.get(6)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        if stored == fresh {
            return Ok(());
        }
        let mut put = conn.prepare_cached(
            "INSERT INTO tasks (page_id, ordinal, line, text, done, due, priority, tags, recur)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(page_id, ordinal) DO UPDATE SET line = excluded.line, text = excluded.text,
               done = excluded.done, due = excluded.due, priority = excluded.priority, tags = excluded.tags,
               recur = excluded.recur",
        )?;
        for (ordinal, t) in fresh.iter().enumerate() {
            if stored.get(ordinal) != Some(t) {
                put.execute(params![id, ordinal as i64, t.line, t.text, t.done, t.due, t.priority, t.tags, t.recur])?;
            }
        }
        if stored.len() > fresh.len() {
            conn.prepare_cached("DELETE FROM tasks WHERE page_id = ?1 AND ordinal >= ?2")?
                .execute(params![id, fresh.len() as i64])?;
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
             FROM tasks t
             WHERE t.page_id NOT IN (SELECT id FROM pages WHERE deleted_at IS NOT NULL)
               AND t.page_id NOT IN tpl AND t.done = 0"
        ))?;
        Ok(st.query_row(params![self.templates_title()?, today, page_id], |r| {
            Ok(TaskCounts { open: r.get(0)?, overdue: r.get(1)?, due_today: r.get(2)?, on_page: r.get(3)? })
        })?)
    }

    /// Open tasks outside templates per due day in `from..=to` (`YYYY-MM-DD`), counted in
    /// SQLite from the index (the Kalender and the week bars only need the numbers).
    pub fn open_tasks_due_per_day(&self, from: &str, to: &str) -> Result<HashMap<String, i64>> {
        let mut st = self.conn().prepare_cached(&format!(
            "{TEMPLATE_PAGES}
             SELECT t.due, COUNT(*) FROM tasks t
             WHERE t.done = 0 AND t.due >= ?2 AND t.due <= ?3
               AND t.page_id NOT IN (SELECT id FROM pages WHERE deleted_at IS NOT NULL)
               AND t.page_id NOT IN tpl
             GROUP BY t.due"
        ))?;
        let rows = st.query_map(params![self.templates_title()?, from, to], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Open tasks outside templates due in `from..before` (`YYYY-MM-DD`; no lower bound
    /// without `from`), in the order of [`Database::list_tasks`]: the first `limit` and how many
    /// there are. Sorted and cut in SQLite (the day and week review show a few of thousands).
    pub fn open_tasks_due(&self, from: Option<&str>, before: &str, limit: usize) -> Result<(Vec<Task>, i64)> {
        let tpl = self.templates_title()?;
        let total: i64 = self
            .conn()
            .prepare_cached(&format!(
                "{TEMPLATE_PAGES}
             SELECT COUNT(*) FROM tasks t JOIN pages p ON p.id = t.page_id
             WHERE t.done = 0 AND t.due IS NOT NULL AND t.due >= COALESCE(?2, '') AND t.due < ?3
               AND p.deleted_at IS NULL AND t.page_id NOT IN tpl"
            ))?
            .query_row(params![tpl, from, before], |r| r.get(0))?;
        let mut st = self.conn().prepare_cached(&format!(
            "{TEMPLATE_PAGES}
             SELECT t.page_id, p.title, p.icon, t.ordinal, t.line, t.text, t.due, t.priority, t.tags, t.recur
             FROM tasks t JOIN pages p ON p.id = t.page_id
             WHERE t.done = 0 AND t.due IS NOT NULL AND t.due >= COALESCE(?2, '') AND t.due < ?3
               AND p.deleted_at IS NULL AND t.page_id NOT IN tpl
             ORDER BY t.due, t.priority DESC, p.title COLLATE NOCASE, t.page_id, t.ordinal
             LIMIT ?4"
        ))?;
        let list = st
            .query_map(params![tpl, from, before, limit as i64], |r| {
                let tags: String = r.get(8)?;
                let recur: Option<String> = r.get(9)?;
                Ok(Task {
                    page_id: r.get(0)?,
                    page_title: r.get(1)?,
                    page_icon: r.get(2)?,
                    ordinal: r.get(3)?,
                    line: r.get(4)?,
                    text: r.get(5)?,
                    done: false,
                    due: r.get(6)?,
                    priority: r.get(7)?,
                    tags: tags.split_whitespace().map(str::to_owned).collect(),
                    recur: recur.as_deref().and_then(stored_rule),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok((list, total))
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
        let mut args: Vec<rusqlite::types::Value> = vec![self.templates_title()?.into()];
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
        let extra: String = conds.iter().map(|c| format!(" AND {c}")).collect();
        // The tasks without their pages: joining each of thousands of tasks to its page row (the
        // Markdown lives there) cost more than reading the live pages once from their index.
        let mut st = self.conn().prepare_cached(&format!(
            "{TEMPLATE_PAGES}
             SELECT t.page_id, t.ordinal, t.line, t.text, t.done, t.due, t.priority, t.tags, t.recur
             FROM tasks t WHERE t.page_id NOT IN tpl{extra}"
        ))?;
        let rows: Vec<Task> = st
            .query_map(rusqlite::params_from_iter(args), |r| {
                let tags: String = r.get(7)?;
                let recur: Option<String> = r.get(8)?;
                Ok(Task {
                    page_id: r.get(0)?,
                    page_title: String::new(),
                    page_icon: None,
                    ordinal: r.get(1)?,
                    line: r.get(2)?,
                    text: r.get(3)?,
                    done: r.get(4)?,
                    due: r.get(5)?,
                    priority: r.get(6)?,
                    tags: tags.split_whitespace().map(str::to_owned).collect(),
                    recur: recur.as_deref().and_then(stored_rule),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        // Title, icon and change time of the live pages (only the one page when filtered by it).
        let mut pages: HashMap<i64, (String, Option<String>, String)> = HashMap::new();
        {
            let sql = if f.page_id.is_some() {
                "SELECT id, title, icon, updated_at FROM pages WHERE deleted_at IS NULL AND id = ?1"
            } else {
                "SELECT id, title, icon, updated_at FROM pages WHERE deleted_at IS NULL AND ?1 IS NULL"
            };
            let mut st = self.conn().prepare_cached(sql)?;
            for row in st.query_map([f.page_id], |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?))))? {
                let (id, page) = row?;
                pages.insert(id, page);
            }
        }
        let mut out: Vec<Task> = rows
            .into_iter()
            .filter_map(|mut t| {
                let (title, icon, updated) = pages.get(&t.page_id)?;
                if since.as_deref().is_some_and(|s| updated.as_str() < s) {
                    return None;
                }
                t.page_title = title.clone();
                t.page_icon = icon.clone();
                Some(t)
            })
            .collect();
        // ORDER BY done, due IS NULL, due, priority DESC, page title COLLATE NOCASE, page, ordinal.
        out.sort_by(|a, b| {
            a.done
                .cmp(&b.done)
                .then(a.due.is_none().cmp(&b.due.is_none()))
                .then_with(|| a.due.cmp(&b.due))
                .then(b.priority.cmp(&a.priority))
                .then_with(|| nocase_cmp(&a.page_title, &b.page_title))
                .then(a.page_id.cmp(&b.page_id))
                .then(a.ordinal.cmp(&b.ordinal))
        });
        Ok(out)
    }

    /// Checks or unchecks task `ordinal` of a page by rewriting exactly its
    /// checkbox (a repeating task done gets its next occurrence below it), then saves the page so
    /// links, tags and the index stay consistent.
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
                    _ => {
                        return Err(Error::State(
                            tr!(
                                "Die Aufgabe wurde inzwischen geändert – Liste neu geladen",
                                "The task was changed meanwhile – list reloaded"
                            )
                            .into(),
                        ));
                    }
                }
            }
        }
        if parse_tasks(&content).get(ordinal).is_none() {
            return Err(missing());
        }
        // A repeating task done gets its next occurrence (see `taskedit`).
        let edit = crate::taskedit::TaskEdit::Done { done };
        let updated = crate::taskedit::edit_page(&content, &[ordinal], &edit, Local::now().date_naive()).content;
        if updated != content {
            self.save_page_content(page_id, &updated)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A long page of tasks (a paste, a restored version, a pulled note): the first save stays
    /// linear (it was cubic: 10 s in a release build for 2,400 tasks), and a small edit writes
    /// only what changed (it rewrote every task row).
    #[test]
    fn saving_a_page_of_thousands_of_tasks_stays_fast() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Liste", None).unwrap();
        let tasks: String = (0..2400)
            .map(|i| format!("- [ ] Aufgabe {i} für das Projekt mit etwas Text due:2026-11-{:02} #liste\n", i % 28 + 1))
            .collect();
        let body = format!("Notiz\n{tasks}");
        let t = std::time::Instant::now();
        db.save_page_content(p.id, &body).unwrap();
        let first = t.elapsed();
        let added: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM activity WHERE kind = 'task_added' AND page_id = ?1", [p.id], |r| r.get(0))
            .unwrap();
        assert_eq!(added, 2400);
        // Debug build on a shared machine; the cubic version took 44 s here.
        assert!(first < std::time::Duration::from_secs(8), "first save {first:?}");

        // One character in the prose: no task row is written.
        let before = db.conn().total_changes();
        db.save_page_content(p.id, &format!("Notiz!\n{tasks}")).unwrap();
        let task_rows = db.conn().total_changes() - before;
        assert!(task_rows < 100, "{task_rows} rows written");
        // One task checked off: its row and nothing else of the 2,400.
        let checked = format!("Notiz!\n{}", tasks.replacen("- [ ] Aufgabe 7 ", "- [x] Aufgabe 7 ", 1));
        let before = db.conn().total_changes();
        db.save_page_content(p.id, &checked).unwrap();
        assert!(db.conn().total_changes() - before < 100);
        let done: i64 = db
            .conn()
            .query_row("SELECT COUNT(*) FROM tasks WHERE page_id = ?1 AND done = 1", [p.id], |r| r.get(0))
            .unwrap();
        assert_eq!(done, 1);
        // Tasks removed: the rows go.
        db.save_page_content(p.id, "- [ ] nur noch eine\n").unwrap();
        let rows: Vec<String> = db
            .list_tasks(&TaskFilter { page_id: Some(p.id), ..Default::default() })
            .unwrap()
            .into_iter()
            .map(|t| t.text)
            .collect();
        assert_eq!(rows, ["nur noch eine"]);
    }

    #[test]
    fn tasks_in_tilde_code_blocks_are_code() {
        let md = "- [ ] eins\n~~~\n- [ ] Code\n```\n- [ ] auch Code\n~~~\n- [ ] zwei\n```\n- [ ] drei ~~~\n```\n- [ ] vier\n";
        let texts: Vec<String> = parse_tasks(md).into_iter().map(|t| t.text).collect();
        assert_eq!(texts, ["eins", "zwei", "vier"]);
        let done = set_task_state(md, 1, true).unwrap();
        assert!(done.contains("- [x] zwei") && done.contains("- [ ] Code"), "{done}");
    }

    #[test]
    fn due_in_either_language() {
        let t = parse_tasks("- [ ] Angebot fällig:2026-09-30 !\n- [ ] Offer due:2026-10-01 !!\n- [ ] x Due:2026-10-02");
        let due: Vec<_> = t.iter().map(|t| (t.text.as_str(), t.due.as_deref(), t.priority)).collect();
        assert_eq!(
            due,
            [("Angebot", Some("2026-09-30"), 1), ("Offer", Some("2026-10-01"), 2), ("x", Some("2026-10-02"), 0)]
        );
    }

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
    fn task_order_matches_the_sql_order() {
        // The list is sorted in Rust since 1.11; it must keep the order the query had.
        let db = Database::open_in_memory().unwrap();
        let notes = [
            ("beta", "- [ ] b1 due:2026-05-02\n- [x] b2\n- [ ] b3 !!\n- [ ] b4 due:2026-05-02 !"),
            ("Alpha", "- [ ] a1 due:2026-05-02\n- [ ] a2\n- [x] a3 due:2026-01-01"),
            ("alpha2", "- [ ] c1 due:2026-05-02 !\n- [ ] c2 due:2026-04-30"),
            ("Ärger", "- [ ] d1\n- [ ] d2 due:2026-05-02"),
            ("_Gelöscht", "- [ ] e1"),
        ];
        let mut ids = vec![];
        for (title, md) in notes {
            let p = db.create_page(None, title, None).unwrap();
            db.save_page_content(p.id, md).unwrap();
            ids.push(p.id);
        }
        db.trash_page(ids[4]).unwrap();
        let expected: Vec<(i64, i64)> = db
            .conn()
            .prepare(
                "SELECT t.page_id, t.ordinal FROM tasks t JOIN pages p ON p.id = t.page_id WHERE p.deleted_at IS NULL
                 ORDER BY t.done, t.due IS NULL, t.due, t.priority DESC, p.title COLLATE NOCASE, t.page_id, t.ordinal",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let got: Vec<(i64, i64)> = db
            .list_tasks(&TaskFilter { status: TaskStatus::All, ..Default::default() })
            .unwrap()
            .iter()
            .map(|t| (t.page_id, t.ordinal))
            .collect();
        assert_eq!(got.len(), 11);
        assert_eq!(got, expected);
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
