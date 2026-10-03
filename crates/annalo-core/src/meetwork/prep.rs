//! „Besprechung vorbereiten“: a page per meeting with what to know before it – the last
//! minutes of the series (or of a meeting with the same subject) with their decisions and
//! open points, the tasks of those minutes still open, matching Jira issues (keys named in the
//! series' notes, issues of a project named in the subject, issues assigned to attendees),
//! notes that mention the attendees and the last meetings with them, and optionally a short
//! paragraph „Worauf achten“ written by the AI from these (titles, excerpts and counts only,
//! at most [`PROMPT_BUDGET`] characters).
//!
//! The page is filed like a meeting note (Settings → Ordner & Ablage, by the meeting's series)
//! and remembered per appointment ([`PAGE_KEY`]); „Aktualisieren“ replaces the generated part
//! only ([`super::block`]). Meetings start being prepared by themselves N minutes before
//! (Settings → Briefing, off by default) when [`auto_candidate`] says so.

use std::collections::HashSet;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{DECISION_HEADINGS, OPEN_HEADINGS, RESULT_HEADINGS, block, clip, display_name, items_under, name_forms};
use crate::ai::client::ChatMessage;
use crate::calsync::tz::Zone;
use crate::calsync::{Busy, CalendarEvent, is_private_title};
use crate::db::{Database, parse_ts};
use crate::error::{Error, Result};
use crate::issues::{Issue, IssueFilter, find_keys};
use crate::model::Page;
use crate::settings::Settings;
use crate::tasks::{TaskFilter, TaskStatus};
use crate::{tr, trf};

/// Characters of context in the request for „Worauf achten“ (about 600 tokens).
pub const PROMPT_BUDGET: usize = 2400;
/// Meta row prefix: `prep.page.<event key>` → id of the prep page.
pub const PAGE_KEY: &str = "prep.page.";
/// Meta row prefix: `prep.event.<page id>` → event key (the page's „Aktualisieren“).
pub const EVENT_KEY: &str = "prep.event.";
/// Meta row prefix: `prep.auto.<event key>`: prepared by itself once (not again after a delete).
pub const AUTO_KEY: &str = "prep.auto.";
/// Earlier notes of the series looked at.
const SERIES_PAGES: usize = 3;
const MAX_ITEMS: usize = 8;
const MAX_TASKS: usize = 12;
const MAX_ISSUES: usize = 12;
const MAX_PEOPLE: usize = 8;
const PER_PERSON: usize = 3;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageRef {
    pub page_id: i64,
    pub title: String,
}

/// The last minutes of the series or subject.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepPrevious {
    pub page_id: i64,
    pub title: String,
    /// `series` or `subject`.
    pub kind: String,
    pub at: DateTime<Utc>,
    pub decisions: Vec<String>,
    pub open_points: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepTask {
    pub page_id: i64,
    pub page_title: String,
    pub text: String,
    pub due: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub assignee: String,
    pub url: String,
    pub blocked: bool,
    /// `mentioned` (in the series' notes), `project` (named in the subject) or `assignee`.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepMeetingRef {
    pub key: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub note_page_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepPerson {
    pub name: String,
    pub pages: Vec<PageRef>,
    pub meetings: Vec<PrepMeetingRef>,
}

/// Everything the prep page shows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PrepData {
    pub key: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub location: String,
    pub attendees: Vec<String>,
    pub previous: Option<PrepPrevious>,
    pub tasks: Vec<PrepTask>,
    /// `None` without a Jira site.
    pub issues: Option<Vec<PrepIssue>>,
    pub people: Vec<PrepPerson>,
    /// Something private is in it: the AI text is written by the local model only.
    pub private: bool,
}

/// Whether `e` gets prepared by itself `minutes` before it starts: a meeting with at least two
/// attendees, not all day, not private, busy, starting within the next `minutes`.
pub fn auto_candidate(e: &CalendarEvent, now: DateTime<Utc>, minutes: i64) -> bool {
    let ev = &e.event;
    !ev.all_day
        && !ev.private
        && !is_private_title(&ev.title)
        && !matches!(ev.busy, Busy::Free | Busy::Oof)
        && ev.attendees.len() >= 2
        && ev.start > now
        && ev.start <= now + Duration::minutes(minutes)
}

/// The earlier notes of `e`'s series or subject, newest first: `(page id, title, created)`.
fn series_pages(db: &Database, e: &CalendarEvent) -> Result<Vec<(i64, String, String)>> {
    let ev = &e.event;
    let (series, prefix) = if ev.recurring && !ev.uid.is_empty() {
        (ev.uid.clone(), format!("{}|{}|", e.source, ev.uid))
    } else {
        (String::new(), String::new())
    };
    let title = if is_private_title(&ev.title) { String::new() } else { ev.title.trim().to_lowercase() };
    let mut st = db.conn().prepare(
        "SELECT p.id, p.title, p.created_at FROM calendar_marks m
         JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL
         WHERE m.key <> ?1
           AND ((?2 <> '' AND (m.series = ?2 OR substr(m.key, 1, length(?3)) = ?3)) OR (?4 <> '' AND m.title = ?4))
         ORDER BY p.created_at DESC LIMIT ?5",
    )?;
    let rows = st.query_map(params![e.key, series, prefix, title, SERIES_PAGES as i64], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

/// The day of the meeting a note belongs to: its appointment's start, else its filing date.
fn minutes_date(db: &Database, page_id: i64) -> Result<Option<DateTime<Utc>>> {
    let start: Option<String> = db
        .conn()
        .query_row(
            "SELECT e.start_at FROM calendar_marks m
             JOIN calendar_events e ON e.source || '|' || e.uid || '|' || e.instance = m.key
             WHERE m.note_page_id = ?1 ORDER BY e.start_at DESC LIMIT 1",
            [page_id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(t) = start.and_then(|s| parse_ts(&s).ok()) {
        return Ok(Some(t));
    }
    let filed: Option<String> =
        db.conn().query_row("SELECT file_date FROM pages WHERE id = ?1", [page_id], |r| r.get(0)).optional()?.flatten();
    Ok(filed
        .and_then(|d| chrono::NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok())
        .and_then(|d| d.and_hms_opt(12, 0, 0))
        .map(|t| t.and_utc()))
}

fn issue_row(i: &Issue, reason: &str) -> PrepIssue {
    PrepIssue {
        key: i.key.clone(),
        summary: i.summary.clone(),
        status: i.status.clone(),
        assignee: i.assignee.clone(),
        url: i.url.clone(),
        blocked: crate::briefing::is_blocked(i),
        reason: reason.into(),
    }
}

/// Whether `word` stands alone in `text` (not inside another word).
fn has_word(text: &str, word: &str) -> bool {
    if word.is_empty() {
        return false;
    }
    let lower = text.to_lowercase();
    let w = word.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(&w).map(|i| from + i) {
        let before = lower[..at].chars().next_back();
        let after = lower[at + w.len()..].chars().next();
        if !before.is_some_and(char::is_alphanumeric) && !after.is_some_and(char::is_alphanumeric) {
            return true;
        }
        from = at + w.len();
    }
    false
}

/// The content of the prep page of `e`. `history`: earlier appointments (for the last meetings
/// with each attendee); `me`: the user's own names (left out of the attendees' notes).
pub fn prep_data(
    db: &Database,
    e: &CalendarEvent,
    history: &[CalendarEvent],
    settings: &Settings,
    me: &[String],
) -> Result<PrepData> {
    let ev = &e.event;
    if ev.private && is_private_title(&ev.title) {
        return Err(Error::State(
            tr!(
                "Ein privater Termin ohne Details lässt sich nicht vorbereiten.",
                "A private appointment without details cannot be prepared."
            )
            .into(),
        ));
    }
    let markers = crate::ai::privacy::normalize(&settings.router.private_markers);
    let marked = |t: &str| crate::ai::privacy::any_private([t], &markers);
    let mut private = ev.private || marked(&ev.title);
    let own_prep = db.meeting_prep_page_id(&e.key)?;

    // ---- the last minutes and the earlier notes of the series
    let mut pages = series_pages(db, e)?;
    let mut probe = e.clone();
    probe.note_page_id = None;
    let last = crate::briefing::prep(db, &probe)?.filter(|p| Some(p.page_id) != own_prep);
    if let Some(p) = &last
        && !pages.iter().any(|(id, _, _)| *id == p.page_id)
    {
        pages.insert(0, (p.page_id, p.title.clone(), p.at.to_rfc3339()));
    }
    let mut series_text = String::new();
    let mut previous = None;
    for (i, (id, title, created)) in pages.iter().enumerate() {
        let doc = db.page_doc(*id)?;
        if i == 0 {
            let mut decisions: Vec<String> = items_under(&doc.content, DECISION_HEADINGS);
            if decisions.is_empty() {
                decisions = items_under(&doc.content, RESULT_HEADINGS);
            }
            let open_points = items_under(&doc.content, OPEN_HEADINGS);
            let clipped = |v: Vec<String>| -> Vec<String> {
                v.iter().filter(|s| !s.starts_with("[ ]")).take(MAX_ITEMS).map(|s| clip(s, 200)).collect()
            };
            let kind = last.as_ref().filter(|p| p.page_id == *id).map_or("series", |p| p.kind.as_str());
            previous = Some(PrepPrevious {
                page_id: *id,
                title: title.clone(),
                kind: if kind == "subject" { "subject".into() } else { "series".into() },
                at: minutes_date(db, *id)?.or_else(|| parse_ts(created).ok()).unwrap_or(ev.start),
                decisions: clipped(decisions),
                open_points: clipped(open_points),
            });
        }
        series_text.push_str(&doc.content);
        series_text.push('\n');
    }
    if !markers.is_empty() && !pages.is_empty() {
        private |= !crate::ai::privacy::private_pages(db, pages.iter().map(|p| p.0), &markers)?.is_empty();
    }

    // ---- tasks of those notes still open
    let mut tasks = vec![];
    for (id, title, _) in &pages {
        for t in db.list_tasks(&TaskFilter { status: TaskStatus::Open, page_id: Some(*id), ..Default::default() })? {
            if tasks.len() >= MAX_TASKS {
                break;
            }
            private |= marked(&t.text);
            tasks.push(PrepTask { page_id: *id, page_title: title.clone(), text: t.text, due: t.due });
        }
    }

    // ---- Jira
    let attendees: Vec<&String> =
        ev.attendees.iter().filter(|a| !me.iter().any(|m| super::same_person(a, m))).collect();
    let issues = if settings.jira.active().next().is_some() {
        let mut out: Vec<PrepIssue> = vec![];
        let mut seen: HashSet<String> = HashSet::new();
        let projects = db.issue_project_keys()?;
        let mut text = series_text.clone();
        text.push_str(&ev.title);
        text.push('\n');
        if let Some(b) = &ev.body {
            text.push_str(b);
        }
        for (_, _, key) in find_keys(&text, &projects) {
            if out.len() >= MAX_ISSUES {
                break;
            }
            if seen.insert(key.clone())
                && let Some(i) = db.issue_get(&key)?
            {
                out.push(issue_row(&i, "mentioned"));
            }
        }
        let all = db.issues_list(&IssueFilter { all: true, limit: Some(2000), ..Default::default() })?;
        let named: Vec<String> = db
            .issue_projects()?
            .into_iter()
            .filter(|(_, key, name)| {
                has_word(&ev.title, key) || (name.chars().count() >= 3 && has_word(&ev.title, name))
            })
            .map(|(_, key, _)| key)
            .collect();
        let mut open: Vec<&Issue> = all.iter().filter(|i| !i.done()).collect();
        open.sort_by(|a, b| b.updated.cmp(&a.updated).then_with(|| a.key.cmp(&b.key)));
        let mut per_project = 0;
        for i in open.iter().filter(|i| named.contains(&i.project_key)) {
            if per_project >= 6 || out.len() >= MAX_ISSUES {
                break;
            }
            if seen.insert(i.key.clone()) {
                out.push(issue_row(i, "project"));
                per_project += 1;
            }
        }
        for i in &open {
            if out.len() >= MAX_ISSUES {
                break;
            }
            if !i.assignee.is_empty()
                && attendees.iter().any(|a| super::same_person(a, &i.assignee))
                && seen.insert(i.key.clone())
            {
                out.push(issue_row(i, "assignee"));
            }
        }
        private |= out.iter().any(|i| marked(&i.summary));
        Some(out)
    } else {
        None
    };

    // ---- the attendees: notes that mention them, the last meetings with them
    let mut people = vec![];
    let mut person_pages: Vec<i64> = vec![];
    for a in attendees.iter().take(MAX_PEOPLE) {
        // The name in its forms and, for `Name <address>`, the address.
        let forms = name_forms(a);
        let mut found: Vec<PageRef> = vec![];
        let mut st = db.conn().prepare_cached(
            "SELECT id, title FROM pages
             WHERE deleted_at IS NULL AND IFNULL(kind, '') <> 'canvas' AND IFNULL(file_type, '') <> 'meeting'
               AND instr(content, ?1) > 0
             ORDER BY updated_at DESC LIMIT ?2",
        )?;
        for f in &forms {
            for r in
                st.query_map(params![f, PER_PERSON as i64 + 1], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            {
                let (id, title) = r?;
                if Some(id) != own_prep && !found.iter().any(|p| p.page_id == id) && found.len() < PER_PERSON {
                    found.push(PageRef { page_id: id, title });
                }
            }
        }
        person_pages.extend(found.iter().map(|p| p.page_id));
        let mut meetings: Vec<&CalendarEvent> = history
            .iter()
            .filter(|h| h.key != e.key && h.event.end <= ev.start)
            .filter(|h| h.event.attendees.iter().any(|x| super::same_person(x, a)))
            .collect();
        meetings.sort_by(|x, y| y.event.start.cmp(&x.event.start));
        meetings.truncate(PER_PERSON);
        people.push(PrepPerson {
            name: display_name(a),
            pages: found,
            meetings: meetings
                .into_iter()
                .map(|h| PrepMeetingRef {
                    key: h.key.clone(),
                    title: h.event.title.clone(),
                    start: h.event.start,
                    note_page_id: h.note_page_id,
                })
                .collect(),
        });
    }
    if !markers.is_empty() && !person_pages.is_empty() {
        private |= !crate::ai::privacy::private_pages(db, person_pages, &markers)?.is_empty();
    }

    Ok(PrepData {
        key: e.key.clone(),
        title: ev.title.clone(),
        start: ev.start,
        end: ev.end,
        all_day: ev.all_day,
        location: ev.location.clone(),
        attendees: ev.attendees.iter().map(|a| display_name(a)).collect(),
        previous,
        tasks,
        issues,
        people,
        private,
    })
}

// ------------------------------------------------------------------ page

/// `[[Title]]` for a page link (brackets in titles would end the link early).
fn link(title: &str) -> String {
    format!("[[{}]]", title.replace(['[', ']'], ""))
}

fn date_label(t: DateTime<Utc>, zone: &Zone) -> String {
    zone.to_wall(t).format(tr!("%d.%m.%Y", "%Y-%m-%d")).to_string()
}

/// The generated part of the prep page (between the markers).
pub fn markdown(d: &PrepData, ai: Option<&str>, zone: &Zone, now: NaiveDateTime) -> String {
    let mut m = String::new();
    let start = zone.to_wall(d.start);
    let end = zone.to_wall(d.end);
    let when = if d.all_day {
        format!("{} · {}", start.format(tr!("%d.%m.%Y", "%Y-%m-%d")), tr!("ganztägig", "all day"))
    } else {
        format!("{} {}–{}", start.format(tr!("%d.%m.%Y", "%Y-%m-%d")), start.format("%H:%M"), end.format("%H:%M"))
    };
    m.push_str(&trf!(
        "*Besprechung: {when}{} · Stand: {}*\n\n",
        "*Meeting: {when}{} · As of: {}*\n\n",
        if d.location.is_empty() { String::new() } else { format!(" · {}", d.location) },
        now.format(tr!("%d.%m.%Y %H:%M", "%Y-%m-%d %H:%M"))
    ));
    if let Some(text) = ai.map(str::trim).filter(|t| !t.is_empty()) {
        m.push_str(tr!("## Worauf achten\n\n", "## What to watch for\n\n"));
        m.push_str(text);
        m.push_str("\n\n");
    }

    m.push_str(tr!("## Letztes Protokoll\n\n", "## Last minutes\n\n"));
    match &d.previous {
        Some(p) => {
            let kind = if p.kind == "subject" {
                tr!("gleicher Betreff", "same subject")
            } else {
                tr!("gleiche Serie", "same series")
            };
            m.push_str(&format!("{} ({}, {kind})\n\n", link(&p.title), date_label(p.at, zone)));
            if !p.decisions.is_empty() {
                m.push_str(tr!("**Entscheidungen**\n\n", "**Decisions**\n\n"));
                for x in &p.decisions {
                    m.push_str(&format!("- {x}\n"));
                }
                m.push('\n');
            }
            if !p.open_points.is_empty() {
                m.push_str(tr!("**Offene Punkte**\n\n", "**Open points**\n\n"));
                for x in &p.open_points {
                    m.push_str(&format!("- {x}\n"));
                }
                m.push('\n');
            }
        }
        None => m.push_str(tr!(
            "Kein früheres Protokoll dieser Serie oder dieses Betreffs.\n\n",
            "No earlier minutes of this series or subject.\n\n"
        )),
    }

    m.push_str(tr!("## Offene Aufgaben\n\n", "## Open tasks\n\n"));
    if d.tasks.is_empty() {
        m.push_str(tr!("Keine offenen Aufgaben aus den Protokollen.\n\n", "No open tasks from the minutes.\n\n"));
    } else {
        // Plain list items: checkboxes here would be second copies of the tasks.
        for t in &d.tasks {
            let due = t
                .due
                .as_deref()
                .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
                .map(|d| {
                    let d = d.format(tr!("%d.%m.%Y", "%Y-%m-%d"));
                    trf!(" (fällig {d})", " (due {d})")
                })
                .unwrap_or_default();
            m.push_str(&format!("- {}{due} – {}\n", t.text, link(&t.page_title)));
        }
        m.push('\n');
    }

    if let Some(issues) = &d.issues {
        m.push_str(tr!("## Jira\n\n", "## Jira\n\n"));
        if issues.is_empty() {
            m.push_str(tr!("Keine passenden Vorgänge.\n\n", "No matching issues.\n\n"));
        } else {
            for i in issues {
                let why = match i.reason.as_str() {
                    "mentioned" => tr!("in den Notizen genannt", "named in the notes"),
                    "project" => tr!("Projekt im Betreff", "project in the subject"),
                    _ => tr!("Teilnehmer zugewiesen", "assigned to an attendee"),
                };
                let who = if i.assignee.is_empty() { String::new() } else { format!(" · {}", i.assignee) };
                let blocked = if i.blocked { tr!(" · **blockiert**", " · **blocked**") } else { "" };
                let key = if i.url.is_empty() { i.key.clone() } else { format!("[{}]({})", i.key, i.url) };
                m.push_str(&format!("- {key} {} – {}{who}{blocked} ({why})\n", i.summary, i.status));
            }
            m.push('\n');
        }
    }

    m.push_str(tr!("## Teilnehmer\n\n", "## Attendees\n\n"));
    if d.people.is_empty() {
        m.push_str(tr!("Keine weiteren Teilnehmer.\n\n", "No other attendees.\n\n"));
    }
    for p in &d.people {
        m.push_str(&format!("- **{}**", p.name));
        if p.pages.is_empty() && p.meetings.is_empty() {
            m.push_str(tr!(": nichts gefunden\n", ": nothing found\n"));
            continue;
        }
        m.push('\n');
        if !p.pages.is_empty() {
            let list: Vec<String> = p.pages.iter().map(|x| link(&x.title)).collect();
            m.push_str(&trf!("  - Erwähnt in: {}\n", "  - Mentioned in: {}\n", list.join(", ")));
        }
        if !p.meetings.is_empty() {
            let list: Vec<String> =
                p.meetings.iter().map(|x| format!("{} ({})", x.title, date_label(x.start, zone))).collect();
            m.push_str(&trf!("  - Letzte Besprechungen: {}\n", "  - Last meetings: {}\n", list.join(", ")));
        }
    }
    m
}

/// The request for „Worauf achten“: titles, excerpts and counts, at most [`PROMPT_BUDGET`]
/// characters of context.
pub fn ai_messages(d: &PrepData, zone: &Zone) -> Vec<ChatMessage> {
    let system = tr!(
        "Du bereitest eine Person auf eine Besprechung vor: „Worauf achten“. Antworte auf Deutsch mit 2 bis 4 kurzen \
         Stichpunkten (Markdown-Liste, je höchstens 20 Wörter): offene Punkte und Aufgaben aus dem letzten Mal, \
         blockierte oder fällige Vorgänge, was mit den Teilnehmern zu klären ist. Nenne nur, was in den Daten steht; \
         keine Begrüßung, keine Überschrift.",
        "You prepare a person for a meeting: “What to watch for”. Answer in English with 2 to 4 short bullet points \
         (a Markdown list, at most 20 words each): open points and tasks from last time, blocked or due issues, what \
         to settle with the attendees. Mention only what is in the data; no greeting, no heading."
    );
    let mut c = format!(
        "Meeting: {} ({})\nAttendees: {}\n",
        clip(&d.title, 120),
        date_label(d.start, zone),
        clip(&d.attendees.join(", "), 200)
    );
    if let Some(p) = &d.previous {
        c.push_str(&format!("Last minutes: {}\n", clip(&p.title, 100)));
        for x in p.decisions.iter().take(4) {
            c.push_str(&format!("- decision: {}\n", clip(x, 140)));
        }
        for x in p.open_points.iter().take(4) {
            c.push_str(&format!("- open: {}\n", clip(x, 140)));
        }
    }
    if !d.tasks.is_empty() {
        c.push_str(&format!("Open tasks ({}):\n", d.tasks.len()));
        for t in d.tasks.iter().take(5) {
            c.push_str(&format!("- {}\n", clip(&t.text, 120)));
        }
    }
    if let Some(issues) = d.issues.as_ref().filter(|i| !i.is_empty()) {
        c.push_str(&format!("Jira ({}):\n", issues.len()));
        for i in issues.iter().take(6) {
            let blocked = if i.blocked { ", blocked" } else { "" };
            c.push_str(&format!("- {} {} ({}{blocked})\n", i.key, clip(&i.summary, 90), i.status));
        }
    }
    for p in d.people.iter().filter(|p| !p.pages.is_empty() || !p.meetings.is_empty()).take(6) {
        c.push_str(&format!("{}: {} notes, {} earlier meetings\n", p.name, p.pages.len(), p.meetings.len()));
    }
    vec![ChatMessage::system(system), ChatMessage::user(super::followup::clip_block(&c, PROMPT_BUDGET))]
}

/// The answer as at most four list lines.
pub fn clean_ai(text: &str) -> String {
    crate::briefing::clean_summary(text)
}

impl Database {
    /// The prep page of an appointment, when there is one (not in the trash).
    pub fn meeting_prep_page_id(&self, key: &str) -> Result<Option<i64>> {
        let Some(id) = self.meta_get(&format!("{PAGE_KEY}{key}"))?.and_then(|v| v.parse::<i64>().ok()) else {
            return Ok(None);
        };
        let alive: Option<i64> = self
            .conn()
            .query_row("SELECT id FROM pages WHERE id = ?1 AND deleted_at IS NULL", [id], |r| r.get(0))
            .optional()?;
        Ok(alive)
    }

    /// The appointment a prep page belongs to.
    pub fn meeting_prep_key(&self, page_id: i64) -> Result<Option<String>> {
        self.meta_get(&format!("{EVENT_KEY}{page_id}"))
    }

    /// Writes the prep page of `e` with the generated part `body`: a new page (filed like the
    /// meeting's notes) or the existing one with only its generated part replaced. Returns the
    /// page and whether it was created now.
    pub fn meeting_prep_write(&self, e: &CalendarEvent, body: &str, zone: &Zone) -> Result<(Page, bool)> {
        self.atomic(|| {
            if let Some(id) = self.meeting_prep_page_id(&e.key)? {
                let doc = self.page_doc(id)?;
                let next = block::replace(&doc.content, body);
                if next != doc.content {
                    self.save_page_content(id, &next)?;
                }
                return Ok((self.page(id)?, false));
            }
            let ev = &e.event;
            let date = zone.to_wall(ev.start).date();
            let base = crate::notes::clean_title(&trf!(
                "Vorbereitung {} {}",
                "Prep {} {}",
                ev.title,
                date.format(tr!("%d.%m.%Y", "%Y-%m-%d"))
            ));
            let mut title = base.clone();
            let mut n = 2;
            while self.page_by_title(&title)?.is_some() {
                title = format!("{base} {n}");
                n += 1;
            }
            let page = self.create_page(None, &title, Some("clipboard-list"))?;
            // The page title names the meeting; no second title in the text.
            let content = format!("{}\n\n{}", block::wrap(body), tr!("## Eigene Notizen\n\n", "## My notes\n\n"));
            self.save_page_content(page.id, &content)?;
            let info = crate::filing::FileInfo {
                kind: crate::filing::FileType::Meeting,
                date,
                group: Some(crate::notes::clean_title(&ev.title)).filter(|t| !t.is_empty()),
            };
            self.file_page(page.id, &info)?;
            self.meta_set(&format!("{PAGE_KEY}{}", e.key), &page.id.to_string())?;
            self.meta_set(&format!("{EVENT_KEY}{}", page.id), &e.key)?;
            Ok((self.page(page.id)?, true))
        })
    }
}
