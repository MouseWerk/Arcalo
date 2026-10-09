//! Changing tasks in their notes, one or many at once: done (a repeating task gets its next
//! occurrence right below), due date, priority, repeat rule, delete, and move to another page
//! (with subtasks; `/zeit` chips take their bookings along). Every change returns what undoes it:
//! the touched pages before and after, restored only while nobody changed them since.

use std::collections::HashMap;
use std::ops::Range;

use chrono::NaiveDate;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::recurrence::Recurrence;
use crate::tasks::{ParsedTask, parse_tasks};
use crate::{tr, trf};

/// A task as the caller saw it: its page, its place among the page's tasks and its text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskRef {
    pub page_id: i64,
    pub ordinal: i64,
    pub text: String,
}

/// What to change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskEdit {
    Done {
        done: bool,
    },
    /// `YYYY-MM-DD`, or `None` to remove the due date.
    Due {
        due: Option<String>,
    },
    /// 0 none, 1 mittel, 2 hoch.
    Priority {
        priority: u8,
    },
    Recur {
        recur: Option<Recurrence>,
    },
    Delete,
    Move {
        page_id: i64,
    },
}

/// One page before and after a change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageChange {
    pub page_id: i64,
    pub before: String,
    pub after: String,
}

/// A booking that moved with its chip.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntryMove {
    pub id: i64,
    pub from: i64,
    pub to: i64,
}

/// What a change did, and what [`Database::undo_task_change`] needs to take it back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskChange {
    pub pages: Vec<PageChange>,
    #[serde(default)]
    pub entries: Vec<EntryMove>,
    /// Tasks changed (moved, deleted, …).
    pub changed: usize,
    /// Due dates of the next occurrences created for repeating tasks.
    #[serde(default)]
    pub created: Vec<String>,
    /// Tasks not found any more (the page changed meanwhile).
    #[serde(default)]
    pub skipped: usize,
}

/// A page's Markdown after [`edit_page`].
#[derive(Debug, Default)]
pub(crate) struct PageEdit {
    pub content: String,
    pub changed: usize,
    pub created: Vec<String>,
    /// Lines taken out by a move, each task with its subtasks, unindented.
    pub moved: Vec<String>,
}

/// The line without its line end, and the line end.
fn split_eol(line: &str) -> (&str, &str) {
    if let Some(b) = line.strip_suffix("\r\n") {
        (b, "\r\n")
    } else if let Some(b) = line.strip_suffix('\n') {
        (b, "\n")
    } else {
        (line, "")
    }
}

fn indent_width(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

/// The line after a task's subtasks (more indented lines up to a blank or less indented one).
fn subtree_end(lines: &[String], at: usize) -> usize {
    let base = indent_width(&lines[at]);
    let mut j = at + 1;
    while j < lines.len() {
        let (l, _) = split_eol(&lines[j]);
        if l.trim().is_empty() || indent_width(l) <= base {
            break;
        }
        j += 1;
    }
    j
}

/// Applies replacements to `line` (ranges must not overlap). A removal (empty replacement)
/// takes one neighbouring space along, but never touches anything before `min`.
fn apply(line: &str, edits: &mut [(Range<usize>, String)], min: usize) -> String {
    let ws = |b: u8| b == b' ' || b == b'\t';
    let bytes = line.as_bytes();
    for (r, with) in edits.iter_mut() {
        if with.is_empty() && r.start < r.end {
            if r.start > min && ws(bytes[r.start - 1]) {
                r.start -= 1;
            } else if r.end < bytes.len() && ws(bytes[r.end]) {
                r.end += 1;
            }
        }
    }
    edits.sort_by(|a, b| b.0.start.cmp(&a.0.start).then(b.0.end.cmp(&a.0.end)));
    let mut out = line.to_owned();
    let mut last = usize::MAX;
    for (r, with) in edits.iter() {
        // Overlaps are dropped (a marker inside a chip's text, say).
        if r.end > last {
            continue;
        }
        out.replace_range(r.clone(), with);
        last = r.start;
    }
    out
}

/// Where a new marker goes: after the text, before a block id at the end.
fn insert_at(t: &ParsedTask, token: &str) -> (Range<usize>, String) {
    match &t.marks.block_id {
        Some(b) => (b.start..b.start, format!("{token} ")),
        None => (t.marks.end..t.marks.end, format!(" {token}")),
    }
}

/// The task line with `edit` applied (done, due, priority, repeat rule).
fn edit_line(line: &str, t: &ParsedTask, edit: &TaskEdit) -> String {
    let min = t.check + 2;
    let mut edits: Vec<(Range<usize>, String)> = vec![];
    match edit {
        TaskEdit::Done { done } => edits.push((t.check..t.check + 1, if *done { "x" } else { " " }.into())),
        TaskEdit::Due { due } => {
            let mut old = t.marks.due.iter();
            match (due, old.next()) {
                // The date in its place (`due:`, `fällig:` or the calendar marker stay as written).
                (Some(d), Some(first)) => edits.push((first.end - 10..first.end, d.clone())),
                (Some(d), None) => edits.push(insert_at(t, &format!("due:{d}"))),
                (None, Some(first)) => edits.push((first.clone(), String::new())),
                (None, None) => {}
            }
            edits.extend(old.map(|r| (r.clone(), String::new())));
        }
        TaskEdit::Priority { priority } => {
            edits.extend(t.marks.priority.iter().map(|r| (r.clone(), String::new())));
            match priority {
                1 => edits.push(insert_at(t, "!")),
                2.. => edits.push(insert_at(t, "!!")),
                _ => {}
            }
        }
        TaskEdit::Recur { recur } => {
            edits.extend(t.marks.recur.iter().map(|r| (r.clone(), String::new())));
            if let Some(r) = recur {
                edits.push(insert_at(t, &r.tokens()));
            }
        }
        TaskEdit::Delete | TaskEdit::Move { .. } => {}
    }
    apply(line, &mut edits, min)
}

/// The Obsidian Tasks marker for the day a task was done; dropped from a new occurrence.
const OBSIDIAN_DONE: &str = "\u{2705}";

/// The next occurrence of a repeating task done on `today`: the same line, open, with the next
/// due date, without the bookings (`/zeit` chips stay with the done task), block id and done date.
/// `None` for a task without a rule or when the series ended.
fn next_line(line: &str, t: &ParsedTask, today: NaiveDate) -> Option<(String, NaiveDate)> {
    let rule = t.recur.as_ref()?;
    let due = t.due.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    let next = rule.next_due(due, today)?;
    let iso = next.format("%Y-%m-%d").to_string();
    let min = t.check + 2;
    let mut edits: Vec<(Range<usize>, String)> = vec![(t.check..t.check + 1, " ".into())];
    match t.marks.due.first() {
        Some(first) => edits.push((first.end - 10..first.end, iso)),
        None => edits.push(insert_at(t, &format!("due:{iso}"))),
    }
    edits.extend(t.marks.due.iter().skip(1).map(|r| (r.clone(), String::new())));
    if let Some(b) = &t.marks.block_id {
        edits.push((b.clone(), String::new()));
    }
    // A monthly or yearly rule from the 29th to 31st keeps its day (`every:monthly` from 31
    // January: `every:monthly,31`, so March is the 31st again). Only the plain `every:` form is
    // rewritten; an imported Obsidian marker stays as written.
    if let (Some(base), Some(first)) = (due.filter(|_| !rule.when_done), t.marks.recur.first())
        && let Some(pinned) = rule.pinned(base)
        && line.get(first.clone()).is_some_and(|m| m.starts_with("every:"))
    {
        edits.push((first.clone(), pinned.tokens()));
        edits.extend(t.marks.recur.iter().skip(1).map(|r| (r.clone(), String::new())));
    }
    for c in crate::chips::chips(line) {
        if c.range.start >= min {
            edits.push((c.range, String::new()));
        }
    }
    if let Some(i) = line.find(OBSIDIAN_DONE).filter(|i| *i >= min) {
        let rest = &line[i + OBSIDIAN_DONE.len()..];
        let date = rest.trim_start();
        let gap = rest.len() - date.len();
        // `get`: the text after the marker may have a multi-byte character within its first 10 bytes.
        if date.get(..10).is_some_and(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()) {
            edits.push((i..i + OBSIDIAN_DONE.len() + gap + 10, String::new()));
        }
    }
    // A removal next to the inserted due date must not swallow it: drop empty edits at its spot.
    let out = apply(line, &mut edits, min);
    Some((out, next))
}

/// Inserts `text` as a line before line `at` (at the end: after the last line, keeping a
/// missing final line end missing).
fn insert_line(lines: &mut Vec<String>, at: usize, text: String, eol: &str) {
    if at == lines.len()
        && let Some(last) = lines.last_mut()
        && !last.ends_with('\n')
    {
        last.push_str(eol);
        lines.push(text);
        return;
    }
    lines.insert(at, text + eol);
}

/// The lines without the indentation of the first one.
fn dedent(lines: &[String]) -> String {
    let prefix: String = lines[0].chars().take_while(|c| *c == ' ' || *c == '\t').collect();
    lines
        .iter()
        .map(|l| {
            let (body, _) = split_eol(l);
            let body = body.strip_prefix(prefix.as_str()).unwrap_or_else(|| body.trim_start());
            format!("{body}\n")
        })
        .collect()
}

/// Applies `edit` to the tasks `ordinals` of a page's Markdown. Only the task lines change (and a
/// next occurrence is added, or a task with its subtasks taken out); everything else, including
/// line ends, stays byte for byte.
pub(crate) fn edit_page(content: &str, ordinals: &[usize], edit: &TaskEdit, today: NaiveDate) -> PageEdit {
    let tasks = parse_tasks(content);
    let mut chosen: Vec<&ParsedTask> = ordinals.iter().filter_map(|o| tasks.get(*o)).collect();
    chosen.sort_by_key(|t| t.line);
    chosen.dedup_by_key(|t| t.line);
    let mut lines: Vec<String> = content.split_inclusive('\n').map(str::to_owned).collect();
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let mut out = PageEdit::default();
    match edit {
        TaskEdit::Delete | TaskEdit::Move { .. } => {
            // Each task with its subtasks; a chosen subtask of a chosen task goes with its parent.
            let mut ranges: Vec<Range<usize>> = vec![];
            for t in &chosen {
                if ranges.last().is_some_and(|r| r.contains(&t.line)) {
                    continue;
                }
                ranges.push(t.line..subtree_end(&lines, t.line));
            }
            out.changed = ranges.len();
            if matches!(edit, TaskEdit::Move { .. }) {
                out.moved = ranges.iter().map(|r| dedent(&lines[r.clone()])).collect();
            }
            for r in ranges.into_iter().rev() {
                lines.drain(r.clone());
                // The last line had no line end: neither has the new last one.
                if r.start == lines.len()
                    && !content.ends_with('\n')
                    && let Some(last) = lines.last_mut()
                {
                    let (body, _) = split_eol(last);
                    *last = body.to_owned();
                }
            }
        }
        _ => {
            let mut inserts: Vec<(usize, String)> = vec![];
            for t in &chosen {
                let (body, line_eol) = split_eol(&lines[t.line]);
                let body = body.to_owned();
                let line_eol = line_eol.to_owned();
                let new = edit_line(&body, t, edit);
                if matches!(edit, TaskEdit::Done { done: true })
                    && !t.done
                    && let Some((next, due)) = next_line(&body, t, today)
                {
                    inserts.push((subtree_end(&lines, t.line), next));
                    out.created.push(due.format("%Y-%m-%d").to_string());
                }
                if new != body {
                    out.changed += 1;
                    lines[t.line] = new + &line_eol;
                }
            }
            for (at, text) in inserts.into_iter().rev() {
                insert_line(&mut lines, at, text, eol);
            }
        }
    }
    out.content = lines.concat();
    out
}

/// `content` with the task blocks appended: right after a list at its end, else after a blank line.
fn append_blocks(content: &str, blocks: &[String]) -> String {
    let eol = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let body: String = blocks.concat().replace('\n', eol);
    let head = content.trim_end_matches(['\n', '\r']);
    if head.trim().is_empty() {
        return body;
    }
    let last = head.lines().last().unwrap_or("").trim_start();
    let list = last.starts_with(['-', '*', '+']) && last[1..].starts_with(' ')
        || last
            .split_once(['.', ')'])
            .is_some_and(|(n, rest)| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && rest.starts_with(' '));
    format!("{head}{eol}{}{body}", if list { "" } else { eol })
}

/// The task the caller saw: at its ordinal with the same text, else the only one with that text.
fn resolve(tasks: &[ParsedTask], r: &TaskRef) -> Option<usize> {
    let at = usize::try_from(r.ordinal).ok();
    if let Some(t) = at.and_then(|o| tasks.get(o)).filter(|t| t.text == r.text) {
        return Some(t.ordinal);
    }
    let mut same = tasks.iter().filter(|t| t.text == r.text);
    match (same.next(), same.next()) {
        (Some(t), None) => Some(t.ordinal),
        _ => None,
    }
}

/// The due date of the next occurrence of a task with this text (Markdown after the checkbox),
/// done on `today`; for the editor, which adds the next occurrence itself.
pub fn next_due_of(text: &str, today: NaiveDate) -> Option<String> {
    let t = parse_tasks(&format!("- [ ] {text}")).pop()?;
    let due = t.due.as_deref().and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok());
    Some(t.recur?.next_due(due, today)?.format("%Y-%m-%d").to_string())
}

impl Database {
    fn live_content(&self, page_id: i64) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT content FROM pages WHERE id = ?1 AND deleted_at IS NULL", [page_id], |r| r.get(0))
            .optional()?)
    }

    /// Applies `edit` to the tasks `refs` (any pages) on `today` (the local day), each page saved
    /// once; see [`TaskChange`] for the result and [`Database::undo_task_change`].
    pub fn edit_tasks(&self, refs: &[TaskRef], edit: &TaskEdit, today: NaiveDate) -> Result<TaskChange> {
        match edit {
            TaskEdit::Due { due: Some(d) } if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_err() => {
                return Err(Error::Parse(trf!("Kein Datum: {d}", "Not a date: {d}")));
            }
            TaskEdit::Priority { priority } if *priority > 2 => {
                return Err(Error::Parse(tr!("Priorität 0 bis 2", "Priority 0 to 2").into()));
            }
            _ => {}
        }
        self.atomic(|| {
            let target = match edit {
                TaskEdit::Move { page_id } => {
                    let content =
                        self.live_content(*page_id)?.ok_or_else(|| Error::not_found("page", page_id.to_string()))?;
                    if self.is_canvas(*page_id)? {
                        return Err(Error::State(
                            tr!(
                                "Aufgaben können nicht in ein Canvas verschoben werden",
                                "Tasks cannot be moved into a canvas"
                            )
                            .into(),
                        ));
                    }
                    Some((*page_id, content))
                }
                _ => None,
            };
            let mut order: Vec<i64> = vec![];
            let mut by_page: HashMap<i64, Vec<&TaskRef>> = HashMap::new();
            for r in refs {
                by_page.entry(r.page_id).or_insert_with(|| {
                    order.push(r.page_id);
                    vec![]
                });
                by_page.get_mut(&r.page_id).expect("inserted").push(r);
            }
            let mut change = TaskChange::default();
            let mut blocks: Vec<(i64, String)> = vec![];
            for page in order {
                let refs = &by_page[&page];
                if target.as_ref().is_some_and(|(t, _)| *t == page) {
                    change.skipped += refs.len();
                    continue;
                }
                let Some(content) = self.live_content(page)? else {
                    change.skipped += refs.len();
                    continue;
                };
                let tasks = parse_tasks(&content);
                let ordinals: Vec<usize> = refs.iter().filter_map(|r| resolve(&tasks, r)).collect();
                change.skipped += refs.len() - ordinals.len();
                let e = edit_page(&content, &ordinals, edit, today);
                change.changed += e.changed;
                change.created.extend(e.created);
                blocks.extend(e.moved.into_iter().map(|b| (page, b)));
                if e.content != content {
                    self.save_page_content(page, &e.content)?;
                    change.pages.push(PageChange { page_id: page, before: content, after: e.content });
                }
            }
            if let (Some((to, content)), false) = (&target, blocks.is_empty()) {
                let text: Vec<String> = blocks.iter().map(|(_, b)| b.clone()).collect();
                let after = append_blocks(content, &text);
                self.save_page_content(*to, &after)?;
                change.pages.push(PageChange { page_id: *to, before: content.clone(), after });
                // Bookings go with their chips.
                for (from, block) in &blocks {
                    for id in crate::chips::chips(block).iter().filter_map(crate::chips::Chip::entry_id) {
                        let n = self.conn().execute(
                            "UPDATE time_entries SET page_id = ?2 WHERE id = ?1 AND page_id = ?3",
                            params![id, to, from],
                        )?;
                        if n > 0 {
                            change.entries.push(EntryMove { id, from: *from, to: *to });
                        }
                    }
                }
            }
            if change.changed == 0 && change.skipped > 0 {
                return Err(Error::State(
                    tr!(
                        "Die Aufgaben wurden inzwischen geändert – Liste neu geladen",
                        "The tasks were changed meanwhile – list reloaded"
                    )
                    .into(),
                ));
            }
            Ok(change)
        })
    }

    /// Takes a change back: every page gets its content from before, but only while it still
    /// has the content the change left (else nothing is restored and the call fails).
    pub fn undo_task_change(&self, change: &TaskChange) -> Result<()> {
        self.atomic(|| {
            for p in &change.pages {
                let now: Option<String> = self
                    .conn()
                    .query_row("SELECT content FROM pages WHERE id = ?1", [p.page_id], |r| r.get(0))
                    .optional()?;
                if now.as_deref() != Some(p.after.as_str()) {
                    let title = self.page(p.page_id).map(|pg| pg.title).unwrap_or_default();
                    return Err(Error::State(trf!(
                        "„{title}“ wurde inzwischen geändert – nicht rückgängig gemacht",
                        "“{title}” was changed meanwhile – not undone"
                    )));
                }
            }
            for p in change.pages.iter().rev() {
                self.save_page_content(p.page_id, &p.before)?;
            }
            for e in &change.entries {
                self.conn().execute(
                    "UPDATE time_entries SET page_id = ?2 WHERE id = ?1 AND page_id = ?3",
                    params![e.id, e.from, e.to],
                )?;
            }
            Ok(())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn one(md: &str, ordinal: usize, edit: TaskEdit) -> String {
        edit_page(md, &[ordinal], &edit, day("2026-10-05")).content
    }

    #[test]
    fn ticking_off_with_text_after_the_done_marker() {
        // A multi-byte character within the first 10 bytes after ✅ (no date there) must not panic.
        for rest in ["✅ erledigt äh", "✅ 🎉🎉🎉", "✅ ✅ ✅ ✅"] {
            let md = format!("- [ ] Rechnung prüfen every:monthly due:2026-10-05 {rest}\n");
            let out = one(&md, 0, TaskEdit::Done { done: true });
            let lines: Vec<&str> = out.lines().collect();
            assert_eq!(lines.len(), 2, "{out}");
            assert!(lines.iter().any(|l| l.starts_with("- [x] Rechnung prüfen") && l.ends_with(rest)), "{out}");
            assert!(
                lines.iter().any(|l| l.starts_with("- [ ] Rechnung prüfen") && l.contains("due:2026-11-05")),
                "{out}"
            );
        }
    }

    #[test]
    fn a_monthly_or_yearly_series_from_the_29th_to_31st_keeps_its_day() {
        let at = |md: &str, today: &str| edit_page(md, &[0], &TaskEdit::Done { done: true }, day(today)).content;
        let next = |out: String| out.lines().nth(1).unwrap().to_owned();
        // 31 January, monthly: February takes its last day, March is the 31st again.
        let feb = next(at("- [ ] Miete every:monthly due:2026-01-31\n", "2026-01-31"));
        assert_eq!(feb, "- [ ] Miete every:monthly,31 due:2026-02-28");
        assert_eq!(next(at(&format!("{feb}\n"), "2026-02-28")), "- [ ] Miete every:monthly,31 due:2026-03-31");
        // 29 February, yearly: the 28th in other years, the 29th again in 2028.
        let mut line = "- [ ] Jahrestag every:yearly due:2024-02-29".to_owned();
        let mut dues = vec![];
        for today in ["2024-02-29", "2025-02-28", "2026-02-28", "2027-02-28"] {
            line = next(at(&format!("{line}\n"), today));
            dues.push(line.rsplit("due:").next().unwrap().to_owned());
        }
        assert_eq!(dues, ["2025-02-28", "2026-02-28", "2027-02-28", "2028-02-29"]);
        assert!(line.contains("every:yearly,29"), "{line}");
        // The 28th and earlier, a set day, an end date and Obsidian's marker stay as written.
        assert_eq!(
            next(at("- [ ] A every:monthly due:2026-01-28\n", "2026-01-28")),
            "- [ ] A every:monthly due:2026-02-28"
        );
        assert_eq!(
            next(at("- [ ] B every:monthly until:2026-12-31 due:2026-01-30\n", "2026-01-30")),
            "- [ ] B every:monthly,30 until:2026-12-31 due:2026-02-28"
        );
        let obsidian = "- [ ] C \u{1F501} every month \u{1F4C5} 2026-01-31\n";
        assert_eq!(next(at(obsidian, "2026-01-31")), "- [ ] C \u{1F501} every month \u{1F4C5} 2026-02-28");
    }

    #[test]
    fn recurrence_in_the_line() {
        let t = &parse_tasks("- [ ] Müll every:weekly due:2026-10-05 !! #haus")[0];
        assert_eq!(t.text, "Müll #haus");
        assert_eq!(t.recur.as_ref().unwrap().spec(), "weekly");
        let t = &parse_tasks("- [ ] Gießen every:alle 3 Tage until:2026-12-31 Balkon")[0];
        assert_eq!((t.text.as_str(), t.recur.as_ref().unwrap().spec()), ("Gießen Balkon", "3d".into()));
        assert_eq!(t.recur.as_ref().unwrap().until.as_deref(), Some("2026-12-31"));
        let t = &parse_tasks("- [ ] Jour fixe every:jeden Montag und Mittwoch mit Team")[0];
        assert_eq!((t.text.as_str(), t.recur.as_ref().unwrap().spec()), ("Jour fixe mit Team", "mo,we".into()));
        // A word that is no rule stays text; `until:` without a rule too.
        let t = &parse_tasks("- [ ] Lesen every:Kapitel until:2026-12-31")[0];
        assert_eq!((t.text.as_str(), t.recur.is_none()), ("Lesen every:Kapitel until:2026-12-31", true));
        // Obsidian Tasks: read, with the rule's words up to the next marker.
        let t = &parse_tasks("- [ ] Report \u{1F501} every week on Monday when done \u{1F4C5} 2026-10-05")[0];
        assert_eq!(t.text, "Report");
        assert_eq!(t.recur.as_ref().unwrap().spec(), "mo,done");
        assert_eq!(t.due.as_deref(), Some("2026-10-05"));
    }

    #[test]
    fn done_adds_the_next_occurrence_below_the_subtasks() {
        let md = "# Haus\r\n- [ ] Müll every:weekly due:2026-10-05 ^abc\r\n  - [ ] Tonne raus\r\n- [ ] Anderes\r\n";
        assert_eq!(
            one(md, 0, TaskEdit::Done { done: true }),
            "# Haus\r\n- [x] Müll every:weekly due:2026-10-05 ^abc\r\n  - [ ] Tonne raus\r\n\
             - [ ] Müll every:weekly due:2026-10-12\r\n- [ ] Anderes\r\n"
        );
        // Without a due date: from today; at the end of a file without a final line end.
        assert_eq!(
            one("- [ ] Gießen every:3d,done", 0, TaskEdit::Done { done: true }),
            "- [x] Gießen every:3d,done\n- [ ] Gießen every:3d,done due:2026-10-08"
        );
        // Bookings stay with the done task; the Obsidian done date goes.
        let chip = r#"<time-entry id="7" hours="1,00" target="NP-1/10" la="DEV" date="2026-10-05">Arbeit</time-entry>"#;
        let md = format!("- [ ] Report {chip} \u{1F501} every month \u{1F4C5} 2026-10-05 \u{2705} 2026-10-05\n");
        let out = one(&md, 0, TaskEdit::Done { done: true });
        assert_eq!(out.lines().nth(1), Some("- [ ] Report \u{1F501} every month \u{1F4C5} 2026-11-05"));
        // The series ended: done, nothing new.
        let md = "- [ ] Ende every:weekly until:2026-10-10 due:2026-10-05\n";
        assert_eq!(one(md, 0, TaskEdit::Done { done: true }), md.replace("[ ]", "[x]"));
        // Done tasks and reopening never create one.
        let md = "- [x] Müll every:weekly due:2026-10-05\n";
        assert_eq!(one(md, 0, TaskEdit::Done { done: true }), md);
        assert_eq!(one(md, 0, TaskEdit::Done { done: false }), md.replace("[x]", "[ ]"));
    }

    #[test]
    fn due_priority_and_rule_edits() {
        let md = "- [ ] A due:2026-10-01 ! ^id1\n- [ ] B \u{1F4C5} 2026-10-01\n- [ ] C\n";
        let due = |o, d: Option<&str>| one(md, o, TaskEdit::Due { due: d.map(str::to_owned) });
        assert_eq!(due(0, Some("2026-10-09")).lines().next(), Some("- [ ] A due:2026-10-09 ! ^id1"));
        assert_eq!(due(1, Some("2026-10-09")).lines().nth(1), Some("- [ ] B \u{1F4C5} 2026-10-09"));
        assert_eq!(due(2, Some("2026-10-09")).lines().nth(2), Some("- [ ] C due:2026-10-09"));
        assert_eq!(due(0, None).lines().next(), Some("- [ ] A ! ^id1"));
        assert_eq!(due(1, None).lines().nth(1), Some("- [ ] B"));
        let prio = |o, p| one(md, o, TaskEdit::Priority { priority: p });
        assert_eq!(prio(0, 2).lines().next(), Some("- [ ] A due:2026-10-01 !! ^id1"));
        assert_eq!(prio(0, 0).lines().next(), Some("- [ ] A due:2026-10-01 ^id1"));
        assert_eq!(prio(2, 1).lines().nth(2), Some("- [ ] C !"));
        let rule = Recurrence::parse("mo,we").unwrap();
        let set = one(md, 2, TaskEdit::Recur { recur: Some(rule) });
        assert_eq!(set.lines().nth(2), Some("- [ ] C every:mo,we"));
        let again = one(&set, 2, TaskEdit::Recur { recur: Recurrence::parse("monthly,31") });
        assert_eq!(again.lines().nth(2), Some("- [ ] C every:monthly,31"));
        assert_eq!(one(&again, 2, TaskEdit::Recur { recur: None }), md);
        let words = "- [ ] D every:jede Woche until:2026-12-31 mit Team\n";
        assert_eq!(one(words, 0, TaskEdit::Recur { recur: None }), "- [ ] D mit Team\n");
    }

    #[test]
    fn delete_and_move_take_subtasks() {
        let md = "Intro\n- [ ] A\n  - [ ] A1\n    Notiz\n- [ ] B\n\n- [ ] C";
        let e = edit_page(md, &[0, 1], &TaskEdit::Move { page_id: 9 }, day("2026-10-05"));
        assert_eq!(e.content, "Intro\n- [ ] B\n\n- [ ] C");
        assert_eq!(e.moved, ["- [ ] A\n  - [ ] A1\n    Notiz\n"]);
        assert_eq!(
            edit_page(md, &[3], &TaskEdit::Delete, day("2026-10-05")).content,
            "Intro\n- [ ] A\n  - [ ] A1\n    Notiz\n- [ ] B\n"
        );
        let e = edit_page("- [ ] X\n  - [ ] Unter\n", &[1], &TaskEdit::Move { page_id: 9 }, day("2026-10-05"));
        assert_eq!((e.content.as_str(), e.moved[0].as_str()), ("- [ ] X\n", "- [ ] Unter\n"));
        assert_eq!(append_blocks("# Ziel\n\n- [ ] alt\n", &e.moved), "# Ziel\n\n- [ ] alt\n- [ ] Unter\n");
        assert_eq!(append_blocks("# Ziel\r\nText", &e.moved), "# Ziel\r\nText\r\n\r\n- [ ] Unter\r\n");
        assert_eq!(append_blocks("", &e.moved), "- [ ] Unter\n");
    }

    #[test]
    fn bulk_edit_and_undo() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Projekt", None).unwrap();
        let b = db.create_page(None, "Ziel", None).unwrap();
        db.save_page_content(a.id, "- [ ] Eins due:2026-10-01\n- [ ] Zwei every:weekly due:2026-10-05\n- [ ] Drei\n")
            .unwrap();
        db.save_page_content(b.id, "# Ziel\n").unwrap();
        let r = |o: i64, text: &str| TaskRef { page_id: a.id, ordinal: o, text: text.into() };
        let today = day("2026-10-05");

        let c = db.edit_tasks(&[r(0, "Eins"), r(1, "Zwei")], &TaskEdit::Done { done: true }, today).unwrap();
        assert_eq!((c.changed, c.created.as_slice()), (2, ["2026-10-12".to_owned()].as_slice()));
        assert_eq!(
            db.page_doc(a.id).unwrap().content,
            "- [x] Eins due:2026-10-01\n- [x] Zwei every:weekly due:2026-10-05\n- [ ] Zwei every:weekly due:2026-10-12\n- [ ] Drei\n"
        );
        let open = db.list_tasks(&Default::default()).unwrap();
        assert_eq!(open[0].recur.as_ref().map(Recurrence::spec).as_deref(), Some("weekly"));
        db.undo_task_change(&c).unwrap();
        assert!(
            db.page_doc(a.id)
                .unwrap()
                .content
                .starts_with("- [ ] Eins due:2026-10-01\n- [ ] Zwei every:weekly due:2026-10-05\n- [ ] Drei")
        );

        // Stale refs: found by text; none found at all is an error.
        let c = db.edit_tasks(&[r(5, "Drei")], &TaskEdit::Due { due: Some("2026-10-06".into()) }, today).unwrap();
        assert_eq!(c.changed, 1);
        assert!(db.edit_tasks(&[r(0, "Gibt es nicht")], &TaskEdit::Delete, today).is_err());
        assert!(db.edit_tasks(&[r(0, "Eins")], &TaskEdit::Due { due: Some("morgen".into()) }, today).is_err());

        // Move with a booking: the entry goes along and comes back with the undo.
        let p = db.create_project("PRJ-1", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-1", "NP-1-10", "Integration", 40.0).unwrap().id;
        let e = db
            .insert_time_entry(&crate::model::NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: None,
                leistungsart: None,
                start_time: chrono::Utc::now(),
                duration_minutes: 60,
                description: "Arbeit".into(),
                source: crate::model::EntrySource::Slash,
                page_id: Some(a.id),
            })
            .unwrap()
            .id;
        let chip =
            format!(r#"<time-entry id="{e}" hours="1,00" target="NP-1" la="" date="2026-10-05">Arbeit</time-entry>"#);
        db.save_page_content(a.id, &format!("- [ ] Eins {chip}\n  - [ ] Teil\n- [ ] Zwei\n")).unwrap();
        let eins = parse_tasks(&db.page_doc(a.id).unwrap().content)[0].text.clone();
        let c = db.edit_tasks(&[r(0, &eins)], &TaskEdit::Move { page_id: b.id }, today).unwrap();
        assert_eq!(db.page_doc(a.id).unwrap().content, "- [ ] Zwei\n");
        assert_eq!(db.page_doc(b.id).unwrap().content, format!("# Ziel\n\n- [ ] Eins {chip}\n  - [ ] Teil\n"));
        assert_eq!(db.time_entry(e).unwrap().page_id, Some(b.id));
        // Changed meanwhile: no undo.
        db.save_page_content(b.id, "# Ziel\nanders\n").unwrap();
        assert!(db.undo_task_change(&c).is_err());
        assert_eq!(db.page_doc(a.id).unwrap().content, "- [ ] Zwei\n");
        db.save_page_content(b.id, &c.pages[1].after).unwrap();
        db.undo_task_change(&c).unwrap();
        assert_eq!(db.page_doc(a.id).unwrap().content, format!("- [ ] Eins {chip}\n  - [ ] Teil\n- [ ] Zwei\n"));
        assert_eq!(db.time_entry(e).unwrap().page_id, Some(a.id));
    }

    #[test]
    fn next_due_for_the_editor() {
        assert_eq!(next_due_of("Müll every:weekly due:2026-10-05", day("2026-10-05")).as_deref(), Some("2026-10-12"));
        assert_eq!(next_due_of("Müll every:weekly", day("2026-10-05")).as_deref(), Some("2026-10-12"));
        assert_eq!(next_due_of("Müll due:2026-10-05", day("2026-10-05")), None);
    }
}
