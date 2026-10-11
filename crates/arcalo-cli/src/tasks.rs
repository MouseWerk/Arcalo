//! Tasks: the `- [ ]` items of all pages, changed in their notes as the app's task view does.

use arcalo_core::external::Change;
use arcalo_core::recurrence::Recurrence;
use arcalo_core::taskedit::{TaskEdit, TaskRef};
use arcalo_core::tasks::{Task, TaskFilter, TaskStatus, parse_tasks};
use arcalo_core::{Database, Error, Result, capture, tr, trf};
use chrono::Duration;

use crate::model::{Pages, TaskOut};
use crate::output::{Failure, Outcome};
use crate::pages::{day, day_or_today};
use crate::{Ctx, TaskAt, TasksCmd};

fn task_text(t: &TaskOut) -> String {
    let mut s = format!("{} {}  [{}] {}", t.page_id, t.ordinal, if t.done { "x" } else { " " }, t.text);
    if let Some(d) = &t.due {
        s.push_str(&format!("  due:{d}"));
    }
    match t.priority {
        1 => s.push_str("  !"),
        2.. => s.push_str("  !!"),
        _ => {}
    }
    if let Some(r) = &t.recur {
        s.push_str(&format!("  {r}"));
    }
    s.push_str(&format!("  ({})", t.page_path));
    s
}

fn status(s: &str) -> Outcome<TaskStatus> {
    match s.trim().to_lowercase().as_str() {
        "open" | "offen" => Ok(TaskStatus::Open),
        "done" | "erledigt" => Ok(TaskStatus::Done),
        "all" | "alle" => Ok(TaskStatus::All),
        _ => Err(Failure::Usage(trf!(
            "Unbekannter Status: {s} (open, done, all)",
            "Unknown status: {s} (open, done, all)"
        ))),
    }
}

/// The task `ordinal` of a page as listed (any state).
fn task_at(db: &Database, page_id: i64, ordinal: i64) -> Result<Option<Task>> {
    let f = TaskFilter { status: TaskStatus::All, page_id: Some(page_id), ..Default::default() };
    Ok(db.list_tasks(&f)?.into_iter().find(|t| t.ordinal == ordinal))
}

/// The task the caller means: its current text, or the one given with `--expect` (then a changed
/// task is refused, as in the app).
fn task_ref(db: &Database, at: &TaskAt, page_id: i64) -> Result<TaskRef> {
    let text = match &at.expect {
        Some(t) => t.clone(),
        None => {
            let content = db.page_doc(page_id)?.content;
            let found = usize::try_from(at.ordinal).ok().and_then(|o| parse_tasks(&content).into_iter().nth(o));
            found.ok_or_else(|| Error::not_found("task", format!("{page_id}/{}", at.ordinal)))?.text
        }
    };
    Ok(TaskRef { page_id, ordinal: at.ordinal, text })
}

fn show_task(ctx: &Ctx, page_id: i64, ordinal: i64) -> Outcome<()> {
    let pages = Pages::load(&ctx.ws.db)?;
    let t = task_at(&ctx.ws.db, page_id, ordinal)?
        .ok_or_else(|| Error::not_found("task", format!("{page_id}/{ordinal}")))?;
    let out = TaskOut::of(&t, &pages);
    ctx.out.show(&out, task_text)
}

/// The Markdown line of a new task.
fn task_line(text: &str, due: Option<&str>, priority: u8) -> String {
    let mut line = format!("- [ ] {}", text.trim());
    if let Some(d) = due {
        line.push_str(&format!(" due:{d}"));
    }
    match priority {
        1 => line.push_str(" !"),
        2.. => line.push_str(" !!"),
        _ => {}
    }
    line
}

fn check_priority(p: Option<u8>) -> Outcome<()> {
    match p {
        Some(3..) => Err(Failure::Usage(tr!("Priorität 0 bis 2", "Priority 0 to 2").into())),
        _ => Ok(()),
    }
}

pub fn run(ctx: &Ctx, cmd: TasksCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match cmd {
        TasksCmd::List { status: st, due, due_before, overdue, tag, page, limit } => {
            let pages = Pages::load(db)?;
            let today = chrono::Local::now().date_naive();
            let due = due.as_deref().map(day).transpose()?;
            let mut before = due_before.as_deref().map(day).transpose()?;
            if overdue {
                let yesterday = today - Duration::days(1);
                before = Some(before.map_or(yesterday, |b| b.min(yesterday)));
            }
            if let Some(d) = due {
                before = Some(before.map_or(d, |b| b.min(d)));
            }
            let page_id = page.map(|r| pages.resolve(&r, false)).transpose()?.map(|p| p.id);
            let f = TaskFilter {
                status: status(&st)?,
                due_before: before.map(|d| d.format("%Y-%m-%d").to_string()),
                tag,
                page_id,
                changed_since: None,
            };
            let want = due.map(|d| d.format("%Y-%m-%d").to_string());
            let list: Vec<TaskOut> = db
                .list_tasks(&f)?
                .iter()
                .filter(|t| want.is_none() || t.due == want)
                .take(limit.unwrap_or(usize::MAX))
                .map(|t| TaskOut::of(t, &pages))
                .collect();
            ctx.out.show(&list, |l| l.iter().map(|t| task_text(t) + "\n").collect())
        }
        TasksCmd::Add { text, page, daily, due, priority } => add(ctx, &text, page, daily, due, priority),
        TasksCmd::Done(at) => toggle(ctx, at, true),
        TasksCmd::Undone(at) => toggle(ctx, at, false),
        TasksCmd::Edit { at, text, due, priority, repeat, move_to } => {
            check_priority(priority)?;
            let pages = Pages::load(db)?;
            let page_id = pages.resolve(&at.page, false)?.id;
            let today = chrono::Local::now().date_naive();
            let mut edits = vec![];
            if let Some(t) = text {
                edits.push(TaskEdit::Text { text: t });
            }
            if let Some(d) = due {
                let due = match d.trim().to_lowercase().as_str() {
                    "none" | "keine" | "" => None,
                    _ => Some(day(&d)?.format("%Y-%m-%d").to_string()),
                };
                edits.push(TaskEdit::Due { due });
            }
            if let Some(p) = priority {
                edits.push(TaskEdit::Priority { priority: p });
            }
            if let Some(r) = repeat {
                let rule = r.trim();
                let recur = match rule.to_lowercase().as_str() {
                    "none" | "keine" | "" => None,
                    _ => Some(Recurrence::parse(rule.strip_prefix("every:").unwrap_or(rule)).ok_or_else(|| {
                        Failure::Usage(trf!("Keine Wiederholungsregel: {rule}", "Not a repeat rule: {rule}"))
                    })?),
                };
                edits.push(TaskEdit::Recur { recur });
            }
            let target = move_to.map(|r| pages.resolve(&r, false)).transpose()?.map(|p| p.id);
            if let Some(to) = target {
                edits.push(TaskEdit::Move { page_id: to });
            }
            if edits.is_empty() {
                return Err(Failure::Usage(
                    tr!(
                        "Nichts zu ändern: --text, --due, --priority, --repeat oder --move-to angeben",
                        "Nothing to change: give --text, --due, --priority, --repeat or --move-to"
                    )
                    .into(),
                ));
            }
            let moved_text = ctx.ws.commit(|db| {
                let mut r = task_ref(db, &at, page_id)?;
                let mut pages = vec![page_id];
                for edit in &edits {
                    let change = db.edit_tasks(std::slice::from_ref(&r), edit, today)?;
                    pages.extend(change.pages.iter().map(|p| p.page_id));
                    // The next edit names the task by its text after this one (a move is the last).
                    if !matches!(edit, TaskEdit::Move { .. })
                        && let Some(p) = change.pages.iter().find(|p| p.page_id == page_id)
                        && let Some(t) =
                            usize::try_from(r.ordinal).ok().and_then(|o| parse_tasks(&p.after).into_iter().nth(o))
                    {
                        r.text = t.text;
                    }
                }
                pages.dedup();
                Ok((r.text, Change { pages, ..Default::default() }))
            })?;
            match target {
                // Moved: the task is the last one with its text on the target page.
                Some(to) => {
                    let f = TaskFilter { status: TaskStatus::All, page_id: Some(to), ..Default::default() };
                    let t = db.list_tasks(&f)?.into_iter().filter(|t| t.text == moved_text).max_by_key(|t| t.line);
                    let t = t.ok_or_else(|| Error::not_found("task", moved_text.clone()))?;
                    show_task(ctx, to, t.ordinal)
                }
                None => show_task(ctx, page_id, at.ordinal),
            }
        }
        TasksCmd::Delete(at) => {
            let page_id = Pages::load(db)?.resolve(&at.page, false)?.id;
            let today = chrono::Local::now().date_naive();
            let n = ctx.ws.commit(|db| {
                let r = task_ref(db, &at, page_id)?;
                let change = db.edit_tasks(&[r], &TaskEdit::Delete, today)?;
                Ok((change.changed, Change { pages: vec![page_id], ..Default::default() }))
            })?;
            ctx.out.show(&serde_json::json!({ "deleted": n }), |_| match n {
                1 => tr!("Aufgabe gelöscht", "Task deleted").into(),
                n => trf!("{n} Aufgaben gelöscht", "{n} tasks deleted"),
            })
        }
    }
}

fn toggle(ctx: &Ctx, at: TaskAt, done: bool) -> Outcome<()> {
    let page_id = Pages::load(&ctx.ws.db)?.resolve(&at.page, false)?.id;
    ctx.ws.commit(|db| {
        db.set_task_done(page_id, at.ordinal, done, at.expect.as_deref())?;
        Ok(((), Change { pages: vec![page_id], ..Default::default() }))
    })?;
    show_task(ctx, page_id, at.ordinal)
}

fn add(
    ctx: &Ctx,
    text: &str,
    page: Option<String>,
    daily: Option<String>,
    due: Option<String>,
    priority: Option<u8>,
) -> Outcome<()> {
    check_priority(priority)?;
    if text.trim().is_empty() || text.contains(['\n', '\r']) {
        return Err(Failure::Usage(
            tr!("Der Aufgabentext muss eine nicht leere Zeile sein", "The task text must be one non-empty line").into(),
        ));
    }
    let due = due.as_deref().map(day).transpose()?.map(|d| d.format("%Y-%m-%d").to_string());
    let line = task_line(text, due.as_deref(), priority.unwrap_or(0));
    let target = match page {
        Some(r) => Some(Pages::load(&ctx.ws.db)?.resolve(&r, false)?.id),
        None => None,
    };
    let date = day_or_today(daily.as_deref())?;
    let page_id = ctx.ws.commit(|db| {
        let (id, created) = match target {
            Some(id) => (id, false),
            None => {
                let key = date.format("%Y-%m-%d").to_string();
                let existed = db.list_pages()?.iter().any(|p| p.daily_date.as_deref() == Some(key.as_str()));
                (db.daily_note(date)?.id, !existed)
            }
        };
        let content = db.page_doc(id)?.content;
        // The daily note takes it below „Notizen“, as quick capture does; other pages at the end.
        let next = match target {
            Some(_) => capture::append_markdown(&content, &line),
            None => {
                capture::insert_in_notes(&content, &line).unwrap_or_else(|| capture::append_markdown(&content, &line))
            }
        };
        crate::pages::save(db, id, &next)?;
        Ok((id, Change { pages: vec![id], tree: created, ..Default::default() }))
    })?;
    // The new task: the last one with its text on the page.
    let f = TaskFilter { status: TaskStatus::All, page_id: Some(page_id), ..Default::default() };
    let parsed = parse_tasks(&line).pop().map(|t| t.text).unwrap_or_default();
    let t = ctx.ws.db.list_tasks(&f)?.into_iter().filter(|t| t.text == parsed).max_by_key(|t| t.line);
    let t = t.ok_or_else(|| Error::not_found("task", parsed.clone()))?;
    let pages = Pages::load(&ctx.ws.db)?;
    ctx.out.show(&TaskOut::of(&t, &pages), task_text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_new_task_line_reads_back_as_written() {
        let line = task_line(" Angebot schicken #kunde ", Some("2026-10-12"), 2);
        assert_eq!(line, "- [ ] Angebot schicken #kunde due:2026-10-12 !!");
        let t = parse_tasks(&line).pop().unwrap();
        assert_eq!((t.text.as_str(), t.due.as_deref(), t.priority), ("Angebot schicken #kunde", Some("2026-10-12"), 2));
    }
}
