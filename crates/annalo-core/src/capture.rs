//! Quick capture into any page: the daily note, the inbox page („Posteingang“, one entry per
//! capture with a timestamp), a picked or new page, or the note of the meeting running now.
//! `/zeit` lines are booked wherever the rest goes. Every capture can be undone for a short
//! while ([`CaptureUndo`]), and a capture the database could not take (busy, storage) waits
//! in a queue file and is retried ([`QueuedCapture`]).

use std::path::Path;

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::calsync::{CalendarEvent, tz::Zone};
use crate::db::Database;
use crate::desktop::{Appended, CaptureKind, CaptureOutcome, capture_markdown, classify, is_list_item};
use crate::error::{Error, Result};
use crate::tracking::{self, Thresholds};

/// Where the text of a capture goes.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CaptureTarget {
    /// Today's daily note (below „Notizen“ when it has that section).
    #[default]
    Daily,
    /// The inbox page (created on first use): each capture under a timestamp.
    Inbox,
    /// An existing page, appended at the end.
    Page { page_id: i64 },
    /// A page with this title: an existing one of that title, else created at the top level.
    NewPage { title: String },
    /// The meeting note of a calendar appointment (created from the Kalender template if
    /// missing), below its „Notizen“ section.
    Meeting { key: String },
}

/// Default title of the inbox page.
pub const INBOX_TITLE: &str = "Posteingang";

/// A meeting counts as „now“ while it runs and during this many minutes after its start
/// (short meetings that are already over still get their notes).
pub const MEETING_GRACE_MINUTES: i64 = 15;

/// How long a capture can be undone.
pub const UNDO_SECONDS: i64 = 30;

/// What undoing a capture restores.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CaptureUndo {
    /// The page that received text, with its content before and after the capture.
    pub page: Option<PageChange>,
    /// Entries booked from `/zeit` lines.
    pub entry_ids: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageChange {
    pub page_id: i64,
    pub title: String,
    pub before: String,
    pub after: String,
    /// The capture created the page (inbox, new page, meeting note): undo moves it to the trash.
    pub created: bool,
}

// ---------------------------------------------------------------- formatting

/// The Markdown a capture's lines (without `/zeit` lines) become, with the number of tasks
/// and other entries. Plain lines become bullets (`todo …` a task), list items keep their
/// indentation (nested lists and tasks stay), headings, quotes, tables, embeds and fenced
/// code blocks stay as they are, as blocks of their own. Blank lines between list lines
/// are dropped, so a few typed lines stay one list.
pub fn format_capture(text: &str) -> (String, usize, usize) {
    #[derive(PartialEq, Clone, Copy)]
    enum Kind {
        List,
        Quote,
        Table,
        Single,
        Fence,
    }
    let mut blocks: Vec<(Kind, Vec<String>)> = vec![];
    let mut fence: Option<&str> = None;
    let (mut tasks, mut entries) = (0, 0);
    for raw in text.lines() {
        let line = raw.trim_end();
        if let Some(marker) = fence {
            if let Some((_, b)) = blocks.last_mut() {
                b.push(line.to_owned());
            }
            if line.trim_start().starts_with(marker) {
                fence = None;
            }
            continue;
        }
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let kind = if t.starts_with("```") || t.starts_with("~~~") {
            fence = Some(&t[..3]);
            Kind::Fence
        } else if is_heading(t) || t.starts_with("![") || t == "---" || t == "***" {
            Kind::Single
        } else if t.starts_with('>') {
            Kind::Quote
        } else if t.starts_with('|') {
            Kind::Table
        } else {
            Kind::List
        };
        match kind {
            Kind::List => {
                let indent = &line[..line.len() - line.trim_start().len()];
                let nested = !indent.is_empty() && blocks.last().is_some_and(|(k, _)| *k == Kind::List);
                let md = capture_markdown(t);
                if !nested {
                    entries += 1;
                }
                if classify(t) == CaptureKind::Task || md.starts_with("- [ ]") {
                    tasks += 1;
                    if nested {
                        entries += 1;
                    }
                }
                let md = if nested { format!("{indent}{md}") } else { md };
                match blocks.last_mut() {
                    Some((Kind::List, b)) => b.push(md),
                    _ => blocks.push((Kind::List, vec![md])),
                }
            }
            Kind::Quote | Kind::Table if blocks.last().is_some_and(|(k, _)| *k == kind) => {
                if let Some((_, b)) = blocks.last_mut() {
                    b.push(t.to_owned());
                }
            }
            _ => {
                entries += 1;
                blocks
                    .push((kind, vec![if kind == Kind::Fence { line.trim_start().to_owned() } else { t.to_owned() }]));
            }
        }
    }
    let md = blocks.iter().map(|(_, b)| b.join("\n")).collect::<Vec<_>>().join("\n\n");
    let tasks = tasks.min(entries);
    (md, tasks, entries - tasks)
}

/// `# Titel` … `###### Titel` (a `#tag` at the start of a line is no heading).
fn is_heading(t: &str) -> bool {
    let hashes = t.chars().take_while(|c| *c == '#').count();
    (1..=6).contains(&hashes) && t[hashes..].starts_with(' ')
}

fn first_line(md: &str) -> &str {
    md.lines().next().unwrap_or("")
}

/// Appends `addition` to `content`: directly below a trailing list when the addition starts
/// with a list item, otherwise after a blank line.
pub fn append_markdown(content: &str, addition: &str) -> String {
    let body = content.trim_end();
    if body.is_empty() {
        return format!("{addition}\n");
    }
    let last = body.lines().last().unwrap_or("");
    let sep = if is_list_item(last) && is_list_item(first_line(addition)) { "\n" } else { "\n\n" };
    format!("{body}{sep}{addition}\n")
}

/// Inserts `addition` at the end of the section headed `## <name>` (level 2 or 3, any case),
/// before the next heading of the same or a higher level. `None` when there is no such section.
pub fn insert_in_section(content: &str, name: &str, addition: &str) -> Option<String> {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut fence = false;
    let mut found: Option<(usize, usize)> = None;
    let mut end = lines.len();
    for (i, l) in lines.iter().enumerate() {
        let t = l.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence || !is_heading(t) {
            continue;
        }
        let level = t.chars().take_while(|c| *c == '#').count();
        match found {
            None if (2..=3).contains(&level) && t[level..].trim().eq_ignore_ascii_case(name) => {
                found = Some((i, level))
            }
            Some((_, at)) if level <= at => {
                end = i;
                break;
            }
            _ => {}
        }
    }
    let (start, _) = found?;
    let head = lines[..end].join("\n");
    let head = head.trim_end();
    let body_last = lines[start + 1..end].iter().rev().find(|l| !l.trim().is_empty());
    let sep = match body_last {
        Some(l) if is_list_item(l) && is_list_item(first_line(addition)) => "\n",
        _ => "\n\n",
    };
    let tail = lines[end..].join("\n");
    Some(if end < lines.len() {
        format!("{head}{sep}{addition}\n\n{}", tail.trim_start_matches('\n'))
    } else {
        format!("{head}{sep}{addition}\n")
    })
}

/// The inbox entry of a capture: its local date and time in bold, then the Markdown.
pub fn inbox_entry<Tz: TimeZone>(md: &str, now: DateTime<Utc>, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let local = now.with_timezone(tz);
    format!("**{}**\n\n{md}", local.format("%d.%m.%Y, %H:%M"))
}

// ----------------------------------------------------------------- targets

/// Settings a capture needs besides the text.
#[derive(Debug, Clone)]
pub struct CaptureOptions<'a> {
    /// Title of the inbox page.
    pub inbox_title: &'a str,
    pub thresholds: &'a Thresholds,
    /// Time zone of meeting notes.
    pub zone: &'a Zone,
}

/// The page of `target`, and whether it was created now.
fn resolve<Tz: TimeZone>(
    db: &Database,
    target: &CaptureTarget,
    opts: &CaptureOptions,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Result<(crate::model::Page, bool)> {
    match target {
        CaptureTarget::Daily => {
            let date = now.with_timezone(tz).date_naive();
            let key = date.format("%Y-%m-%d").to_string();
            let existed: Option<i64> = db
                .conn()
                .query_row("SELECT id FROM pages WHERE daily_date = ?1 AND deleted_at IS NULL", [&key], |r| r.get(0))
                .optional()?;
            Ok((db.daily_note(date)?, existed.is_none()))
        }
        CaptureTarget::Inbox => page_titled(db, opts.inbox_title, "inbox"),
        CaptureTarget::NewPage { title } => page_titled(db, title, "file-text"),
        CaptureTarget::Page { page_id } => {
            let page = db.page(*page_id)?;
            if page.deleted_at.is_some() {
                return Err(Error::State(format!("„{}“ liegt im Papierkorb", page.title)));
            }
            Ok((page, false))
        }
        CaptureTarget::Meeting { key } => db.calendar_meeting_note(key, opts.zone),
    }
}

/// The page titled `title` (any case), else a new top-level page.
fn page_titled(db: &Database, title: &str, icon: &str) -> Result<(crate::model::Page, bool)> {
    let title = crate::notes::clean_title(title);
    if title.is_empty() {
        return Err(Error::State("Der Seitentitel fehlt".into()));
    }
    match db.page_by_title(&title)? {
        Some(p) => Ok((p, false)),
        None => Ok((db.create_page(None, &title, Some(icon))?, true)),
    }
}

/// Books the `/zeit` lines of `text` and puts the rest into `target`. All or nothing: a bad
/// `/zeit` line (or a missing page) stores nothing. Returns what to show and what undo restores.
pub fn capture_to<Tz: TimeZone>(
    db: &Database,
    text: &str,
    target: &CaptureTarget,
    opts: &CaptureOptions,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Result<(CaptureOutcome, CaptureUndo)>
where
    Tz::Offset: std::fmt::Display,
{
    let mut zeit_lines = vec![];
    let mut rest = String::new();
    let mut in_fence = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with("```") || t.starts_with("~~~") {
            in_fence = !in_fence;
        }
        if !in_fence && classify(t) == CaptureKind::Zeit {
            zeit_lines.push(t);
        } else {
            rest.push_str(line);
            rest.push('\n');
        }
    }
    let (md, tasks, notes) = format_capture(&rest);
    if zeit_lines.is_empty() && md.is_empty() {
        return Err(Error::State("Nichts zu erfassen".into()));
    }
    db.atomic(|| {
        let bookings = zeit_lines
            .iter()
            .map(|l| tracking::log_slash_command(db, l, now, tz, opts.thresholds))
            .collect::<Result<Vec<_>>>()?;
        let entry_ids = bookings.iter().map(|b| b.entry.id).collect();
        if md.is_empty() {
            return Ok((CaptureOutcome { appended: None, bookings }, CaptureUndo { page: None, entry_ids }));
        }
        let (page, created) = resolve(db, target, opts, now, tz)?;
        let before = db.page_doc(page.id)?.content;
        let next = match target {
            CaptureTarget::Inbox => append_markdown(&before, &inbox_entry(&md, now, tz)),
            CaptureTarget::Daily | CaptureTarget::Meeting { .. } => {
                insert_in_section(&before, "Notizen", &md).unwrap_or_else(|| append_markdown(&before, &md))
            }
            _ => append_markdown(&before, &md),
        };
        db.save_page_content(page.id, &next)?;
        let after = db.page_doc(page.id)?.content;
        // A daily note stays (it would be created again on the next open): undo restores it.
        let trash = created && *target != CaptureTarget::Daily;
        let appended = Appended { page_id: page.id, tasks, notes, title: page.title.clone(), created };
        let change = PageChange { page_id: page.id, title: page.title, before, after, created: trash };
        Ok((CaptureOutcome { appended: Some(appended), bookings }, CaptureUndo { page: Some(change), entry_ids }))
    })
}

/// Takes a capture back: removes its bookings and restores the page (a page the capture
/// created goes to the trash). Refused when the page was edited since.
pub fn undo_capture(db: &Database, undo: &CaptureUndo) -> Result<()> {
    db.atomic(|| {
        if let Some(p) = &undo.page {
            let trashed = db.page(p.page_id)?.deleted_at.is_some();
            if trashed || db.page_doc(p.page_id)?.content != p.after {
                return Err(Error::State(format!(
                    "„{}“ wurde seit der Erfassung geändert – nichts rückgängig gemacht",
                    p.title
                )));
            }
            if p.created {
                db.trash_page(p.page_id)?;
            } else {
                db.save_page_content(p.page_id, &p.before)?;
            }
        }
        for id in &undo.entry_ids {
            db.delete_time_entry(*id)?;
        }
        Ok(())
    })
}

// ---------------------------------------------------------------- meetings

/// The appointment to offer as target at `now`: not all-day, started, and still running or
/// started at most [`MEETING_GRACE_MINUTES`] ago. The one that started last wins.
pub fn current_meeting(db: &Database, now: DateTime<Utc>, sources: &[String]) -> Result<Option<CalendarEvent>> {
    let grace = chrono::Duration::minutes(MEETING_GRACE_MINUTES);
    let events = db.calendar_events(now - chrono::Duration::hours(12), now + chrono::Duration::seconds(1), sources)?;
    Ok(events
        .into_iter()
        .filter(|e| !e.event.all_day && e.event.start <= now && (e.event.end > now || now - e.event.start <= grace))
        .max_by_key(|e| e.event.start))
}

// ------------------------------------------------------------------- queue

/// A capture the database could not take; retried until it is stored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueuedCapture {
    pub text: String,
    #[serde(default)]
    pub target: CaptureTarget,
    /// When it was captured: the daily note, the inbox timestamp and bookings use this time.
    pub at: DateTime<Utc>,
    #[serde(default)]
    pub attempts: u32,
    /// The last error, for the log.
    #[serde(default)]
    pub error: String,
}

/// File of the capture queue in the data folder.
pub const QUEUE_FILE: &str = "capture-queue.json";

/// Whether retrying later can help: the database is busy or locked, or the storage failed.
/// Input errors (a bad `/zeit` line, a trashed page) are shown instead.
pub fn is_retryable(e: &Error) -> bool {
    use rusqlite::ErrorCode as C;
    match e {
        Error::Db(rusqlite::Error::SqliteFailure(f, _)) if matches!(f.code, C::DatabaseBusy | C::DatabaseLocked) => {
            true
        }
        _ => e.is_storage(),
    }
}

/// The error of a locked database (for tests of the queue).
pub fn busy_error() -> Error {
    let code = rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_BUSY);
    Error::Db(rusqlite::Error::SqliteFailure(code, Some("database is locked".into())))
}

/// The queued captures (none when the file is missing or unreadable).
pub fn load_queue(path: &Path) -> Vec<QueuedCapture> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

/// Writes the queue (a temporary file renamed over the old one); an empty queue removes the file.
pub fn save_queue(path: &Path, queue: &[QueuedCapture]) -> Result<()> {
    if queue.is_empty() {
        return match std::fs::remove_file(path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(Error::file(path, e)),
            _ => Ok(()),
        };
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(queue)?).map_err(|e| Error::file(&tmp, e))?;
    std::fs::rename(&tmp, path).map_err(|e| Error::file(path, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calsync::{Busy, NewEvent, OUTLOOK, event_key};
    use chrono::FixedOffset;

    fn tz() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }
    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 23, 12, 30, 0).unwrap() // 14:30 local
    }
    fn opts<'a>(t: &'a Thresholds, zone: &'a Zone) -> CaptureOptions<'a> {
        CaptureOptions { inbox_title: INBOX_TITLE, thresholds: t, zone }
    }
    fn content(db: &Database, id: i64) -> String {
        db.page_doc(id).unwrap().content
    }

    #[test]
    fn formats_lines_lists_and_blocks() {
        assert_eq!(
            format_capture("Idee\ntodo Angebot\n\n- [ ] Review"),
            ("- Idee\n- [ ] Angebot\n- [ ] Review".into(), 2, 1)
        );
        // Nested items keep their indentation; the continuation of a list stays in it.
        let (md, tasks, notes) = format_capture("Plan\n  - Schritt 1\n  todo Schritt 2\n1. eins");
        assert_eq!(md, "- Plan\n  - Schritt 1\n  - [ ] Schritt 2\n1. eins");
        assert_eq!((tasks, notes), (1, 2));
        // Headings, quotes, tables, embeds and code blocks stay blocks of their own.
        let (md, ..) = format_capture(
            "## Ergebnis\nals Punkt\n> Zitat\n> weiter\n![[bild.png]]\n```rust\nfn a() {}\n\n  // leer\n```\n| a | b |\n|---|---|",
        );
        assert_eq!(
            md,
            "## Ergebnis\n\n- als Punkt\n\n> Zitat\n> weiter\n\n![[bild.png]]\n\n```rust\nfn a() {}\n\n  // leer\n```\n\n| a | b |\n|---|---|"
        );
        // A tag at the start of a line is no heading; links and due dates stay.
        assert_eq!(format_capture("#idee Cache [[Kunde X]]").0, "- #idee Cache [[Kunde X]]");
        assert_eq!(format_capture("todo Angebot due:2026-09-25 #vertrieb").0, "- [ ] Angebot due:2026-09-25 #vertrieb");
        assert_eq!(format_capture(" \n ").0, "");
    }

    #[test]
    fn appends_and_inserts_into_sections() {
        assert_eq!(append_markdown("- x\n", "- a"), "- x\n- a\n");
        assert_eq!(append_markdown("- x\n", "**ts**\n\n- a"), "- x\n\n**ts**\n\n- a\n");
        assert_eq!(append_markdown("Text", "![[a.png]]"), "Text\n\n![[a.png]]\n");
        let meeting = "---\ndatum: 2026-09-23\n---\n# Jour fixe\n\n## Notizen\n\n\n\n## Entscheidungen\n\n- \n";
        assert_eq!(
            insert_in_section(meeting, "Notizen", "- a").unwrap(),
            "---\ndatum: 2026-09-23\n---\n# Jour fixe\n\n## Notizen\n\n- a\n\n## Entscheidungen\n\n- \n"
        );
        let once = insert_in_section(meeting, "notizen", "- a").unwrap();
        assert!(
            insert_in_section(&once, "Notizen", "- b").unwrap().contains("## Notizen\n\n- a\n- b\n\n## Entscheidungen")
        );
        // A subheading inside the section belongs to it; a heading in a code block is no heading.
        let nested = "## Notizen\n\n### Detail\n\ntext\n```\n## Notizen\n```\n# Ende\n";
        assert_eq!(
            insert_in_section(nested, "Notizen", "- a").unwrap(),
            "## Notizen\n\n### Detail\n\ntext\n```\n## Notizen\n```\n\n- a\n\n# Ende\n"
        );
        assert_eq!(insert_in_section("# Titel\n\nText", "Notizen", "- a"), None);
        assert_eq!(inbox_entry("- a", now(), &tz()), "**23.09.2026, 14:30**\n\n- a");
    }

    #[test]
    fn captures_into_daily_inbox_page_and_new_page() {
        let db = Database::open_in_memory().unwrap();
        let t = Thresholds::default();
        let zone = Zone::Fixed(tz());
        let o = opts(&t, &zone);

        let (out, undo) = capture_to(&db, "Idee\ntodo Anrufen", &CaptureTarget::Daily, &o, now(), &tz()).unwrap();
        let a = out.appended.unwrap();
        assert!(a.created && a.title.contains("2026-09-23"), "{a:?}");
        assert!(content(&db, a.page_id).ends_with("## Notizen\n\n- Idee\n- [ ] Anrufen\n"));
        assert!(!undo.page.as_ref().unwrap().created, "a daily note is restored, not trashed");

        // The inbox is created on first use; each capture gets its timestamp.
        let (out, undo) = capture_to(&db, "Erster Gedanke", &CaptureTarget::Inbox, &o, now(), &tz()).unwrap();
        let inbox = out.appended.unwrap();
        assert_eq!((inbox.title.as_str(), inbox.created), (INBOX_TITLE, true));
        assert!(undo.page.unwrap().created);
        let later = now() + chrono::Duration::minutes(75);
        capture_to(&db, "Zweiter\n![[skizze.png]]", &CaptureTarget::Inbox, &o, later, &tz()).unwrap();
        assert_eq!(
            content(&db, inbox.page_id),
            "**23.09.2026, 14:30**\n\n- Erster Gedanke\n\n**23.09.2026, 15:45**\n\n- Zweiter\n\n![[skizze.png]]\n"
        );
        assert_eq!(db.page(inbox.page_id).unwrap().icon.as_deref(), Some("inbox"));

        // A picked page gets the text at its end; a trashed one is refused.
        let p = db.create_page(None, "Kunde X", None).unwrap();
        db.save_page_content(p.id, "# Kunde X\n\nAbsatz").unwrap();
        let target = CaptureTarget::Page { page_id: p.id };
        capture_to(&db, "- [ ] Angebot due:2026-09-25", &target, &o, now(), &tz()).unwrap();
        assert_eq!(content(&db, p.id), "# Kunde X\n\nAbsatz\n\n- [ ] Angebot due:2026-09-25\n");
        let task = db.list_tasks(&Default::default()).unwrap().into_iter().find(|t| t.page_id == p.id).unwrap();
        assert_eq!(task.due.as_deref(), Some("2026-09-25"));

        // „Neue Seite“: created once, then the same page (a retried capture makes no duplicate).
        let new = CaptureTarget::NewPage { title: "Ideen Q4".into() };
        let (out, _) = capture_to(&db, "eins", &new, &o, now(), &tz()).unwrap();
        let (again, _) = capture_to(&db, "zwei", &new, &o, now(), &tz()).unwrap();
        let (a, b) = (out.appended.unwrap(), again.appended.unwrap());
        assert!(a.created && !b.created && a.page_id == b.page_id);
        assert_eq!(content(&db, a.page_id), "- eins\n- zwei\n");

        db.trash_page(p.id).unwrap();
        assert!(capture_to(&db, "x", &target, &o, now(), &tz()).unwrap_err().to_string().contains("Papierkorb"));
        assert!(capture_to(&db, "  ", &CaptureTarget::Inbox, &o, now(), &tz()).is_err());
    }

    #[test]
    fn books_zeit_lines_wherever_the_text_goes_and_undoes_everything() {
        let db = Database::open_in_memory().unwrap();
        let pr = db.create_project("PRJ-1", "Rollout").unwrap();
        db.create_netzplan(pr.id, "NP-8801", "NP-8801", "Integration", 10.0).unwrap();
        let t = Thresholds::default();
        let zone = Zone::Fixed(tz());
        let o = opts(&t, &zone);
        let p = db.create_page(None, "Projekt", None).unwrap();
        db.save_page_content(p.id, "- alt\n").unwrap();
        let target = CaptureTarget::Page { page_id: p.id };

        let (out, undo) = capture_to(&db, "/zeit NP-8801 1h #DEV 'Review'\nNotiz", &target, &o, now(), &tz()).unwrap();
        assert_eq!(out.bookings.len(), 1);
        assert_eq!(content(&db, p.id), "- alt\n- Notiz\n");
        undo_capture(&db, &undo).unwrap();
        assert_eq!(content(&db, p.id), "- alt\n");
        assert!(db.list_time_entries(&Default::default()).unwrap().is_empty());

        // A page edited since the capture is not reverted.
        let (_, undo) = capture_to(&db, "neu", &target, &o, now(), &tz()).unwrap();
        db.save_page_content(p.id, "- alt\n- neu\n- getippt\n").unwrap();
        assert!(undo_capture(&db, &undo).unwrap_err().to_string().contains("geändert"));
        assert!(content(&db, p.id).ends_with("getippt\n"));

        // Undoing a capture that created its page moves the page to the trash.
        let (out, undo) =
            capture_to(&db, "x", &CaptureTarget::NewPage { title: "Wegwerf".into() }, &o, now(), &tz()).unwrap();
        undo_capture(&db, &undo).unwrap();
        assert!(db.page(out.appended.unwrap().page_id).unwrap().deleted_at.is_some());

        // A /zeit line inside a code block is text; a bad booking stores nothing.
        let (out, _) = capture_to(&db, "```\n/zeit NP-8801 1h\n```", &target, &o, now(), &tz()).unwrap();
        assert!(out.bookings.is_empty());
        let before = content(&db, p.id);
        assert!(capture_to(&db, "/zeit NP-0000 1h\nText", &target, &o, now(), &tz()).is_err());
        assert_eq!(content(&db, p.id), before);
    }

    #[test]
    fn pasted_images_and_dropped_files_are_stored_and_embedded() {
        let dir = std::env::temp_dir().join(format!("annalo-capture-att-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
        // What the capture window does on paste (image) and drop (any file).
        let image = crate::attachments::save(&dir, &png, "image.png", "image/png").unwrap();
        let file = crate::attachments::store_file(&dir, "Protokoll Kickoff.txt", b"Protokoll").unwrap();
        assert!(dir.join(&image.name).is_file() && dir.join(&file.name).is_file());

        let db = Database::open_in_memory().unwrap();
        let t = Thresholds::default();
        let zone = Zone::Fixed(tz());
        let text = format!("Whiteboard\n{}\n{}", image.markdown, file.markdown);
        let (out, _) = capture_to(&db, &text, &CaptureTarget::Inbox, &opts(&t, &zone), now(), &tz()).unwrap();
        let md = content(&db, out.appended.unwrap().page_id);
        assert_eq!(md, format!("**23.09.2026, 14:30**\n\n- Whiteboard\n\n{}\n\n{}\n", image.markdown, file.markdown));
        // The embeds count as used attachments of the page.
        let used = crate::attachments::embeds(&md);
        assert!(used.contains(&image.name) && used.contains(&file.name), "{used:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn meeting(uid: &str, start: DateTime<Utc>, minutes: i64, title: &str) -> NewEvent {
        NewEvent {
            uid: uid.into(),
            instance: String::new(),
            recurring: false,
            start,
            end: start + chrono::Duration::minutes(minutes),
            all_day: false,
            title: title.into(),
            location: String::new(),
            organizer: String::new(),
            attendees: vec!["Anna".into()],
            body: None,
            link: None,
            busy: Busy::Busy,
            private: false,
            categories: vec![],
        }
    }

    #[test]
    fn offers_the_current_meeting_and_writes_into_its_note() {
        let db = Database::open_in_memory().unwrap();
        let src = [OUTLOOK.to_owned()];
        let n = now();
        let min = chrono::Duration::minutes;
        let events = [
            meeting("early", n - min(120), 30, "Früh"),
            meeting("short", n - min(14), 10, "Kurz"),
            meeting("jf", n - min(5), 60, "Jour fixe Kunde X"),
            meeting("later", n + min(10), 30, "Später"),
        ];
        db.calendar_replace(OUTLOOK, n - chrono::Duration::days(1), n + chrono::Duration::days(1), &events).unwrap();
        assert_eq!(current_meeting(&db, n, &src).unwrap().unwrap().event.title, "Jour fixe Kunde X");
        // A short meeting that is over counts for 15 minutes after its start.
        assert_eq!(current_meeting(&db, n - min(6), &src).unwrap().unwrap().event.title, "Kurz");
        assert!(current_meeting(&db, n - min(60), &src).unwrap().is_none());
        assert!(current_meeting(&db, n, &[]).unwrap().is_none(), "only active sources");

        let t = Thresholds::default();
        let zone = Zone::Fixed(tz());
        let key = event_key(OUTLOOK, "jf", "");
        let target = CaptureTarget::Meeting { key: key.clone() };
        let (out, undo) =
            capture_to(&db, "Budget freigegeben\ntodo Protokoll senden", &target, &opts(&t, &zone), n, &tz()).unwrap();
        let a = out.appended.unwrap();
        assert!(a.created && a.title.starts_with("Jour fixe Kunde X"));
        let md = content(&db, a.page_id);
        assert!(md.contains("## Notizen\n\n- Budget freigegeben\n- [ ] Protokoll senden\n\n## Entscheidungen"), "{md}");
        assert_eq!(db.calendar_event(&key).unwrap().note_page_id, Some(a.page_id));
        // The second capture goes into the same note.
        let (again, _) = capture_to(&db, "noch was", &target, &opts(&t, &zone), n, &tz()).unwrap();
        assert!(!again.appended.unwrap().created);
        assert!(content(&db, a.page_id).contains("- [ ] Protokoll senden\n- noch was\n\n## Entscheidungen"));
        // Undo of the first capture is refused now (the note changed since).
        assert!(undo_capture(&db, &undo).is_err());
    }

    #[test]
    fn the_queue_survives_on_disk_and_knows_what_to_retry() {
        let dir = std::env::temp_dir().join(format!("annalo-capture-queue-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(QUEUE_FILE);
        assert!(load_queue(&path).is_empty());
        let q = vec![QueuedCapture {
            text: "Idee".into(),
            target: CaptureTarget::Page { page_id: 3 },
            at: now(),
            attempts: 1,
            error: "busy".into(),
        }];
        save_queue(&path, &q).unwrap();
        assert_eq!(load_queue(&path), q);
        // Older entries without target go to the daily note.
        std::fs::write(&path, r#"[{"text":"a","at":"2026-09-23T12:30:00Z"}]"#).unwrap();
        assert_eq!(load_queue(&path)[0].target, CaptureTarget::Daily);
        save_queue(&path, &[]).unwrap();
        assert!(!path.exists());
        save_queue(&path, &[]).unwrap();
        let _ = std::fs::remove_dir_all(&dir);

        assert!(is_retryable(&busy_error()));
        assert!(is_retryable(&Error::Io(std::io::Error::other("disk"))));
        assert!(!is_retryable(&Error::State("NP-0000 unbekannt".into())));
        assert_eq!(
            serde_json::to_string(&CaptureTarget::NewPage { title: "A".into() }).unwrap(),
            r#"{"kind":"new_page","title":"A"}"#
        );
    }
}
