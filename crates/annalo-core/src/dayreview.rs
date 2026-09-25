//! „Tagesrückblick“: what happened on one local day, on one page – pages created and edited
//! (with an estimate of the editing time and the word delta where snapshots allow it), time
//! booked per WBS against the daily target with the gaps between bookings, tasks done, added
//! and still open, meetings from the calendar with their booking state, focus sessions and
//! files added.
//!
//! Everything is read with a handful of grouped queries over the journal (`activity`), the
//! time entries, the calendar, focus sessions and tasks. The optional text summary is built
//! from this structure ([`summary_messages`]) and only ever goes to a provider marked local
//! ([`local_candidates`]): the review aggregates every page of the day, private ones included.

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::ai::availability::Catalog;
use crate::ai::client::ChatMessage;
use crate::ai::router::{ModelRef, RouterConfig, Tier};
use crate::calsync::{Busy, CalendarEvent, PRIVATE_TITLE};
use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::feed::day_start;
use crate::focus::hm;
use crate::tasks::{TaskFilter, TaskStatus};

/// Estimated editing time per save (autosave), as in the week proposal, and the most one
/// hour's edits of a page count.
const MINUTES_PER_SAVE: i64 = 2;
const MAX_MINUTES_PER_HOUR: i64 = 60;
/// Unbooked stretches between two bookings shorter than this are no gap (a coffee).
pub const GAP_MINUTES: i64 = 30;
/// At most this many tasks per list (the totals count all).
const MAX_TASKS: usize = 50;

/// What the review needs besides the database.
#[derive(Debug, Clone)]
pub struct ReviewOptions {
    pub daily_target_hours: f64,
    /// ISO weekdays (1 = Monday) that are workdays.
    pub workdays: Vec<u32>,
    /// Calendar sources to include (`None` = all stored ones).
    pub sources: Option<Vec<String>>,
    /// The current time: meetings after it are „upcoming“, a running timer counts up to it.
    pub now: DateTime<Utc>,
}

impl ReviewOptions {
    pub fn from_settings(s: &crate::settings::Settings, sources: Option<Vec<String>>, now: DateTime<Utc>) -> Self {
        ReviewOptions { daily_target_hours: s.daily_target_hours, workdays: s.workdays.clone(), sources, now }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayReview {
    pub date: NaiveDate,
    /// UTC bounds of the local day (23 or 25 hours at a DST change).
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    /// The daily note of the day, if there is one.
    pub daily_note_id: Option<i64>,
    pub pages: Vec<ReviewPage>,
    pub time: ReviewTime,
    pub tasks: ReviewTasks,
    pub meetings: Vec<ReviewMeeting>,
    pub focus: ReviewFocus,
    pub files: Vec<ReviewFile>,
}

impl DayReview {
    /// Nothing happened (and nothing was planned) that day.
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
            && self.time.entries.is_empty()
            && self.time.running_minutes == 0
            && self.tasks.done.is_empty()
            && self.tasks.added.is_empty()
            && self.meetings.is_empty()
            && self.focus.sessions.is_empty()
            && self.files.is_empty()
    }
}

/// A page created or edited that day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewPage {
    /// `None` when the page was deleted for good.
    pub page_id: Option<i64>,
    pub title: String,
    pub icon: Option<String>,
    /// The page is in the trash or gone (not clickable).
    pub gone: bool,
    pub created: bool,
    /// The page is a daily note.
    pub daily: bool,
    /// Saves (autosaves merged per hour count one each).
    pub edits: i64,
    /// Characters changed (see [`crate::feed::changed_chars`]).
    pub chars: i64,
    /// Estimated editing time.
    pub minutes: i64,
    pub first_at: DateTime<Utc>,
    pub last_at: DateTime<Utc>,
    /// Words added (negative: removed) over the day, where the content at the start and at
    /// the end of the day is known (page created that day, version snapshots).
    pub word_delta: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReviewTime {
    /// Daily target (0 on days off).
    pub target_minutes: i64,
    pub workday: bool,
    /// Finished entries starting that day.
    pub booked_minutes: i64,
    /// A timer started that day and still running: its minutes so far.
    pub running_minutes: i64,
    /// Target minus booked (never negative).
    pub missing_minutes: i64,
    /// Per WBS, most minutes first.
    pub items: Vec<ReviewWbs>,
    /// Finished entries by start.
    pub entries: Vec<ReviewEntry>,
    /// Unbooked stretches of at least [`GAP_MINUTES`] between the first and last booking.
    pub gaps: Vec<ReviewGap>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewWbs {
    /// `NP-8801/1020` or `NP-8801`.
    pub label: String,
    pub project_code: String,
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    /// Description of the Vorgang, else of the Netzplan.
    pub title: String,
    pub minutes: i64,
    pub entries: i64,
    /// Distinct entry descriptions in booking order.
    pub descriptions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewEntry {
    pub id: i64,
    pub label: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub minutes: i64,
    pub description: String,
    /// `draft`, `released` or `exported`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewGap {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub minutes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReviewTasks {
    /// Checked off that day.
    pub done: Vec<ReviewTask>,
    /// Written that day.
    pub added: Vec<ReviewTask>,
    /// Still open and due that day.
    pub due: Vec<ReviewTask>,
    /// Still open and due before that day.
    pub overdue: Vec<ReviewTask>,
    pub done_total: i64,
    pub added_total: i64,
    pub due_total: i64,
    pub overdue_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewTask {
    pub page_id: Option<i64>,
    pub page_title: String,
    pub text: String,
    /// When it was added or checked off (journal tasks).
    pub at: Option<DateTime<Utc>>,
    pub due: Option<String>,
    /// Done now (an added task that was also checked off).
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewMeeting {
    pub key: String,
    pub source: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub location: String,
    /// Minutes within the day (0 for all-day appointments).
    pub minutes: i64,
    /// `booked`, `skipped` („nicht buchen“), `open` (to book), `upcoming` (not over yet) or
    /// `free` (all-day, free, out of office or private: nothing to book).
    pub state: String,
    pub entry_id: Option<i64>,
    pub note_page_id: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReviewFocus {
    pub minutes: i64,
    pub sessions: Vec<ReviewFocusSession>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewFocusSession {
    pub id: i64,
    /// `NP-8801/1020`; empty without Vorgang.
    pub reference: String,
    pub goal: String,
    pub started_at: DateTime<Utc>,
    pub worked_minutes: i64,
    /// `running`, `done` or `aborted`.
    pub status: String,
    pub entry_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReviewFile {
    pub name: String,
    /// „Bild“, „Zeichnung“ or „Datei“.
    pub kind: String,
    pub at: DateTime<Utc>,
}

// ------------------------------------------------------------------ helpers

/// Words of a note: whitespace-separated tokens with a letter or digit, front matter and
/// checkboxes left out (checking a task off adds no word).
pub fn word_count(markdown: &str) -> i64 {
    let body = match markdown.strip_prefix("---\n") {
        Some(rest) => rest.split_once("\n---").map_or(markdown, |(_, after)| after),
        None => markdown,
    };
    body.split_whitespace().filter(|w| !matches!(*w, "[x]" | "[X]") && w.chars().any(char::is_alphanumeric)).count()
        as i64
}

/// Lower case with single spaces (entry descriptions against appointment subjects).
fn norm(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn label(netzplan_nr: &str, vorgang: Option<&str>) -> String {
    crate::desktop::timer_label(netzplan_nr, vorgang)
}

/// Unbooked stretches of at least [`GAP_MINUTES`] between the intervals (any order).
pub fn gaps(mut spans: Vec<(DateTime<Utc>, DateTime<Utc>)>) -> Vec<ReviewGap> {
    spans.sort();
    let mut out = vec![];
    let mut covered: Option<DateTime<Utc>> = None;
    for (a, b) in spans {
        if let Some(end) = covered {
            let minutes = (a - end).num_minutes();
            if minutes >= GAP_MINUTES {
                out.push(ReviewGap { start: end, end: a, minutes });
            }
        }
        covered = Some(covered.map_or(b, |c| c.max(b)));
    }
    out
}

// -------------------------------------------------------------------- query

/// The review of the local day `date` in `tz`.
pub fn day_review<Tz: TimeZone>(db: &Database, date: NaiveDate, tz: &Tz, opts: &ReviewOptions) -> Result<DayReview> {
    let next = date.succ_opt().ok_or_else(|| Error::State("Datum außerhalb des gültigen Bereichs".into()))?;
    let (from, to) = (day_start(date, tz), day_start(next, tz));
    let (a, b) = (ts(from), ts(to));
    let key = date.format("%Y-%m-%d").to_string();
    let c = db.conn();

    let daily_note_id: Option<i64> = c
        .query_row("SELECT id FROM pages WHERE daily_date = ?1 AND deleted_at IS NULL", [&key], |r| r.get(0))
        .optional()?;

    // ---- pages: the journal's rows of the day, one per page.
    let mut pages: Vec<ReviewPage> = {
        let mut st = c.prepare_cached(
            "SELECT a.page_id, MAX(a.title), p.title, p.icon, p.daily_date IS NOT NULL, p.id IS NULL OR p.deleted_at IS NOT NULL,
                    SUM(a.kind = 'page_created'),
                    SUM(CASE WHEN a.kind = 'page_created' THEN a.count - 1 ELSE a.count END),
                    SUM(a.amount),
                    SUM(MIN(?3, ?4 * CASE WHEN a.kind = 'page_created' THEN a.count - 1 ELSE a.count END)),
                    MIN(a.at), MAX(a.at)
             FROM activity a LEFT JOIN pages p ON p.id = a.page_id
             WHERE a.kind IN ('page_created', 'page_edited') AND a.at >= ?1 AND a.at < ?2
             GROUP BY COALESCE(a.page_id, -a.id)
             ORDER BY MAX(a.at) DESC",
        )?;
        let rows = st.query_map(params![a, b, MAX_MINUTES_PER_HOUR, MINUTES_PER_SAVE], |r| {
            let old_title: String = r.get(1)?;
            let gone: bool = r.get(5)?;
            Ok(ReviewPage {
                page_id: r.get(0)?,
                title: r.get::<_, Option<String>>(2)?.filter(|_| !gone).unwrap_or(old_title),
                icon: r.get(3)?,
                gone,
                daily: r.get(4)?,
                created: r.get::<_, i64>(6)? > 0,
                edits: r.get(7)?,
                chars: r.get(8)?,
                minutes: r.get(9)?,
                first_at: parse_ts(&r.get::<_, String>(10)?)?,
                last_at: parse_ts(&r.get::<_, String>(11)?)?,
                word_delta: None,
            })
        })?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for p in pages.iter_mut().filter(|p| !p.gone) {
        let Some(id) = p.page_id else { continue };
        p.word_delta = word_delta(db, id, p.created, &a, &b)?;
    }

    // ---- time: finished entries starting that day, and a running timer.
    let mut time =
        ReviewTime { workday: opts.workdays.contains(&date.weekday().number_from_monday()), ..Default::default() };
    if time.workday {
        time.target_minutes = (opts.daily_target_hours.max(0.0) * 60.0).round() as i64;
    }
    {
        let mut st = c.prepare_cached(
            "SELECT e.id, e.netzplan_id, e.vorgang_nr, e.start_time, e.duration_minutes, e.description, e.status_flag,
                    n.netzplan_nr, pr.project_code, COALESCE(NULLIF(v.description, ''), n.description)
             FROM time_entries e
             JOIN netzplaene n ON n.id = e.netzplan_id
             JOIN projects pr ON pr.id = n.project_id
             LEFT JOIN vorgaenge v ON v.netzplan_id = e.netzplan_id AND v.vorgang_nr = e.vorgang_nr COLLATE NOCASE
             WHERE e.start_time >= ?1 AND e.start_time < ?2
             ORDER BY e.start_time, e.id",
        )?;
        type Row = (i64, i64, Option<String>, String, Option<i64>, String, String, String, String, String);
        let rows: Vec<Row> = st
            .query_map(params![a, b], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                ))
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut index: HashMap<(i64, Option<String>), usize> = HashMap::new();
        for (id, np, vorgang, start, minutes, description, status, nr, project, title) in rows {
            let start = parse_ts(&start)?;
            if status == "running" {
                time.running_minutes += (opts.now - start).num_minutes().max(0);
                continue;
            }
            let minutes = minutes.unwrap_or(0);
            let l = label(&nr, vorgang.as_deref());
            time.booked_minutes += minutes;
            time.entries.push(ReviewEntry {
                id,
                label: l.clone(),
                start,
                end: start + Duration::minutes(minutes),
                minutes,
                description: description.clone(),
                status,
            });
            let k = (np, vorgang.as_ref().map(|v| v.to_lowercase()));
            let i = *index.entry(k).or_insert_with(|| {
                time.items.push(ReviewWbs {
                    label: l,
                    project_code: project,
                    netzplan_id: np,
                    vorgang_nr: vorgang.clone(),
                    title,
                    minutes: 0,
                    entries: 0,
                    descriptions: vec![],
                });
                time.items.len() - 1
            });
            let item = &mut time.items[i];
            item.minutes += minutes;
            item.entries += 1;
            let d = description.trim();
            if !d.is_empty() && !item.descriptions.iter().any(|x| x.eq_ignore_ascii_case(d)) {
                item.descriptions.push(d.to_owned());
            }
        }
        time.items.sort_by(|x, y| y.minutes.cmp(&x.minutes).then_with(|| x.label.cmp(&y.label)));
        time.missing_minutes = (time.target_minutes - time.booked_minutes).max(0);
        time.gaps = gaps(time.entries.iter().filter(|e| e.minutes > 0).map(|e| (e.start, e.end)).collect());
    }

    // ---- tasks: the journal's check-offs and new tasks, and what is still open.
    let journal = |kind: &str| -> Result<Vec<ReviewTask>> {
        let mut st = c.prepare_cached(
            "SELECT a.page_id, COALESCE(CASE WHEN p.deleted_at IS NULL THEN p.title END, a.detail), a.title, MAX(a.at)
             FROM activity a LEFT JOIN pages p ON p.id = a.page_id
             WHERE a.kind = ?3 AND a.at >= ?1 AND a.at < ?2
             GROUP BY a.page_id, a.title ORDER BY MAX(a.at)",
        )?;
        let rows = st.query_map(params![a, b, kind], |r| {
            Ok(ReviewTask {
                page_id: r.get(0)?,
                page_title: r.get(1)?,
                text: r.get(2)?,
                at: Some(parse_ts(&r.get::<_, String>(3)?)?),
                due: None,
                done: kind == "task_done",
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    };
    let done = journal("task_done")?;
    let mut added = journal("task_added")?;
    let done_keys: HashSet<(Option<i64>, &str)> = done.iter().map(|t| (t.page_id, t.text.as_str())).collect();
    for t in &mut added {
        t.done = done_keys.contains(&(t.page_id, t.text.as_str()));
    }
    let open =
        db.list_tasks(&TaskFilter { status: TaskStatus::Open, due_before: Some(key.clone()), ..Default::default() })?;
    let (due, overdue): (Vec<ReviewTask>, Vec<ReviewTask>) = open
        .into_iter()
        .filter(|t| t.due.is_some())
        .map(|t| ReviewTask {
            page_id: Some(t.page_id),
            page_title: t.page_title,
            text: t.text,
            at: None,
            due: t.due,
            done: false,
        })
        .partition(|t| t.due.as_deref() == Some(key.as_str()));
    let cap = |mut v: Vec<ReviewTask>| {
        v.truncate(MAX_TASKS);
        v
    };
    let tasks = ReviewTasks {
        done_total: done.len() as i64,
        added_total: added.len() as i64,
        due_total: due.len() as i64,
        overdue_total: overdue.len() as i64,
        done: cap(done),
        added: cap(added),
        due: cap(due),
        overdue: cap(overdue),
    };

    // ---- meetings of the calendar sources.
    let events = match &opts.sources {
        Some(s) => db.calendar_events(from, to, s)?,
        None => {
            let all: Vec<String> = {
                let mut st = c.prepare_cached("SELECT DISTINCT source FROM calendar_events")?;
                st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            db.calendar_events(from, to, &all)?
        }
    };
    let meetings = events.iter().map(|e| meeting(e, &time.entries, from, to, opts.now)).collect();

    // ---- focus sessions started that day.
    let sessions: Vec<ReviewFocusSession> = {
        let mut st = c.prepare_cached(
            "SELECT id, reference, goal, started_at, worked_minutes, status, entry_id FROM focus_sessions
             WHERE started_at >= ?1 AND started_at < ?2 ORDER BY started_at",
        )?;
        st.query_map(params![a, b], |r| {
            Ok(ReviewFocusSession {
                id: r.get(0)?,
                reference: r.get(1)?,
                goal: r.get(2)?,
                started_at: parse_ts(&r.get::<_, String>(3)?)?,
                worked_minutes: r.get(4)?,
                status: r.get(5)?,
                entry_id: r.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?
    };
    let focus = ReviewFocus {
        minutes: sessions.iter().filter(|s| s.status != "running").map(|s| s.worked_minutes).sum(),
        sessions,
    };

    // ---- files stored that day.
    let files: Vec<ReviewFile> = {
        let mut st = c.prepare_cached(
            "SELECT title, detail, at FROM activity WHERE kind = 'file_added' AND at >= ?1 AND at < ?2 ORDER BY at",
        )?;
        st.query_map(params![a, b], |r| {
            Ok(ReviewFile { name: r.get(0)?, kind: r.get(1)?, at: parse_ts(&r.get::<_, String>(2)?)? })
        })?
        .collect::<rusqlite::Result<_>>()?
    };

    Ok(DayReview { date, from, to, daily_note_id, pages, time, tasks, meetings, focus, files })
}

/// Words added over the day on page `id`: the content at the start of the day is the first
/// snapshot taken that day (a save snapshots the content it replaces) or empty for a page
/// created that day; the content at the end is the first snapshot after the day, or the page
/// itself when it was not saved since. `None` when either is unknown.
fn word_delta(db: &Database, id: i64, created: bool, from: &str, to: &str) -> Result<Option<i64>> {
    let c = db.conn();
    let first_version = |after: &str, before: Option<&str>| -> Result<Option<String>> {
        let mut st = c.prepare_cached(
            "SELECT content FROM page_versions WHERE page_id = ?1 AND created_at >= ?2 AND (?3 IS NULL OR created_at < ?3)
             ORDER BY created_at, id LIMIT 1",
        )?;
        Ok(st.query_row(params![id, after, before], |r| r.get(0)).optional()?)
    };
    let start = if created { Some(String::new()) } else { first_version(from, Some(to))? };
    let Some(start) = start else { return Ok(None) };
    let end = match first_version(to, None)? {
        Some(v) => Some(v),
        None => c
            .query_row("SELECT content FROM pages WHERE id = ?1 AND updated_at < ?2", params![id, to], |r| r.get(0))
            .optional()?,
    };
    Ok(end.map(|e: String| word_count(&e) - word_count(&start)))
}

/// An appointment with its booking state: linked when booked from the calendar, or an entry
/// of the day that overlaps it and carries its subject (the calendar view's rule).
fn meeting(
    e: &CalendarEvent,
    entries: &[ReviewEntry],
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    now: DateTime<Utc>,
) -> ReviewMeeting {
    let ev = &e.event;
    let title = norm(&ev.title);
    let matched = e.entry_id.or_else(|| {
        (!title.is_empty())
            .then(|| {
                entries.iter().find(|x| {
                    let text = norm(&x.description);
                    let overlaps = if ev.all_day { x.start < ev.end } else { x.start < ev.end && x.end > ev.start };
                    overlaps && !text.is_empty() && (text == title || text.contains(&title) || title.contains(&text))
                })
            })
            .flatten()
            .map(|x| x.id)
    });
    let not_work = ev.all_day || matches!(ev.busy, Busy::Free | Busy::Oof) || (ev.private && ev.title == PRIVATE_TITLE);
    let state = if matched.is_some() {
        "booked"
    } else if e.skip {
        "skipped"
    } else if not_work {
        "free"
    } else if ev.start > now {
        "upcoming"
    } else {
        "open"
    };
    let minutes = if ev.all_day { 0 } else { (ev.end.min(to) - ev.start.max(from)).num_minutes().max(0) };
    ReviewMeeting {
        key: e.key.clone(),
        source: e.source.clone(),
        title: ev.title.clone(),
        start: ev.start,
        end: ev.end,
        all_day: ev.all_day,
        location: ev.location.clone(),
        minutes,
        state: state.into(),
        entry_id: matched,
        note_page_id: e.note_page_id,
    }
}

// ----------------------------------------------------------------- reminder

/// Whether to show „Tagesrückblick ansehen“ now: switched on, a workday, at or after the set
/// time, not yet today and not in the quiet hours (retried after them).
pub fn review_reminder(now: NaiveDateTime, settings: &crate::settings::Settings, last: Option<NaiveDate>) -> bool {
    let n = &settings.notifications;
    let Some(at) = crate::desktop::parse_hhmm(&n.day_review_time) else { return false };
    let today = now.date();
    n.day_review
        && !n.is_quiet(now.time())
        && settings.workdays.contains(&today.weekday().number_from_monday())
        && now.time() >= at
        && last != Some(today)
}

/// The text of the reminder: „3 Seiten · 6,5 h gebucht · 2 Aufgaben erledigt“.
pub fn reminder_body(r: &DayReview) -> String {
    let plural = |n: usize, one: &str, many: &str| format!("{n} {}", if n == 1 { one } else { many });
    let mut parts = vec![];
    if !r.pages.is_empty() {
        parts.push(plural(r.pages.len(), "Seite", "Seiten"));
    }
    parts.push(format!("{} h gebucht", crate::desktop::format_hours(r.time.booked_minutes as f64)));
    if r.tasks.done_total > 0 {
        parts.push(format!("{} erledigt", plural(r.tasks.done_total as usize, "Aufgabe", "Aufgaben")));
    }
    let open = r.meetings.iter().filter(|m| m.state == "open").count();
    if open > 0 {
        parts.push(format!("{} ohne Buchung", plural(open, "Termin", "Termine")));
    }
    parts.join(" · ")
}

// ------------------------------------------------------------------ summary

/// The models the summary may go to, in order: the local tier's model when its provider is
/// marked local, then the models the local providers list or were given by hand. Providers
/// that are not marked local never appear, whatever the tiers say.
pub fn local_candidates(config: &RouterConfig, catalog: &Catalog) -> Vec<ModelRef> {
    let local: Vec<&crate::ai::provider::AiProvider> =
        catalog.providers.iter().filter(|p| p.enabled && p.local).collect();
    let mut out: Vec<ModelRef> = vec![];
    let mut push = |r: ModelRef| {
        if !r.model.is_empty() && !r.model.to_lowercase().contains("embed") && !out.contains(&r) {
            out.push(r);
        }
    };
    let tier = catalog.canonical(config.tier_ref(Tier::Local));
    if local.iter().any(|p| p.id == tier.provider) && catalog.offers(&tier) {
        push(tier);
    }
    for p in &local {
        for m in catalog.models.get(&p.id).into_iter().flatten().chain(&p.models) {
            push(ModelRef::new(&p.id, m));
        }
    }
    out
}

/// Why no summary can be written, or `None` when a local provider is there.
pub fn no_local_reason(catalog: &Catalog) -> Option<String> {
    if catalog.providers.iter().any(|p| p.enabled && p.local) {
        return None;
    }
    Some(
        "Der Tagesrückblick enthält alle Seiten des Tages, auch vertrauliche. Die Zusammenfassung schreibt deshalb \
         nur ein lokales Modell (z. B. Ollama): markiere unter Einstellungen → KI einen Anbieter als lokal."
            .into(),
    )
}

/// The day as plain text for the model: numbers and names, no page contents.
pub fn describe<Tz: TimeZone>(r: &DayReview, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let t = |at: DateTime<Utc>| at.with_timezone(tz).format("%H:%M").to_string();
    const WEEKDAYS: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
    let weekday = WEEKDAYS[r.date.weekday().num_days_from_monday() as usize];
    let mut out = format!("Tag: {weekday}, {}\n", r.date.format("%d.%m.%Y"));
    let tm = &r.time;
    out.push_str(&format!("Gebucht: {}", hm(tm.booked_minutes)));
    if tm.target_minutes > 0 {
        out.push_str(&format!(" von {} Soll", hm(tm.target_minutes)));
        if tm.missing_minutes > 0 {
            out.push_str(&format!(", es fehlen {}", hm(tm.missing_minutes)));
        }
    } else {
        out.push_str(" (kein Arbeitstag)");
    }
    out.push('\n');
    if tm.running_minutes > 0 {
        out.push_str(&format!("Ein Timer läuft noch ({}).\n", hm(tm.running_minutes)));
    }
    for w in &tm.items {
        let what = if w.descriptions.is_empty() { String::new() } else { format!(": {}", w.descriptions.join("; ")) };
        out.push_str(&format!("- {} {} ({}){what}\n", w.label, hm(w.minutes), w.title));
    }
    for g in &tm.gaps {
        out.push_str(&format!("Lücke ohne Buchung: {}–{} ({})\n", t(g.start), t(g.end), hm(g.minutes)));
    }
    if !r.meetings.is_empty() {
        out.push_str("Termine:\n");
        for m in &r.meetings {
            let state = match m.state.as_str() {
                "booked" => "gebucht",
                "skipped" => "nicht zu buchen",
                "open" => "noch nicht gebucht",
                "upcoming" => "steht noch an",
                _ => "frei",
            };
            let when = if m.all_day { "ganztägig".to_owned() } else { format!("{}–{}", t(m.start), t(m.end)) };
            out.push_str(&format!("- {when} {} ({state})\n", m.title));
        }
    }
    if !r.pages.is_empty() {
        out.push_str("Seiten:\n");
        for p in &r.pages {
            let verb = if p.created { "angelegt" } else { "bearbeitet" };
            let words = match p.word_delta {
                Some(d) if d != 0 => format!(", {d:+} Wörter"),
                _ => String::new(),
            };
            out.push_str(&format!("- {} ({verb}, ~{} min{words})\n", p.title, p.minutes));
        }
    }
    let list = |out: &mut String, head: &str, tasks: &[ReviewTask], total: i64| {
        if tasks.is_empty() {
            return;
        }
        out.push_str(&format!("{head} ({total}):\n"));
        for task in tasks.iter().take(20) {
            let due = task.due.as_deref().map(|d| format!(", fällig {d}")).unwrap_or_default();
            out.push_str(&format!("- {} (Seite {}{due})\n", task.text, task.page_title));
        }
    };
    list(&mut out, "Erledigte Aufgaben", &r.tasks.done, r.tasks.done_total);
    let fresh: Vec<ReviewTask> = r.tasks.added.iter().filter(|x| !x.done).cloned().collect();
    list(&mut out, "Neue offene Aufgaben", &fresh, fresh.len() as i64);
    list(&mut out, "Heute fällig, offen", &r.tasks.due, r.tasks.due_total);
    list(&mut out, "Überfällig", &r.tasks.overdue, r.tasks.overdue_total);
    if !r.focus.sessions.is_empty() {
        out.push_str(&format!("Fokus: {} Sitzungen, {}\n", r.focus.sessions.len(), hm(r.focus.minutes)));
        for s in &r.focus.sessions {
            let what = if s.goal.is_empty() { &s.reference } else { &s.goal };
            out.push_str(&format!("- {} {} {}\n", t(s.started_at), hm(s.worked_minutes), what));
        }
    }
    if !r.files.is_empty() {
        let names: Vec<&str> = r.files.iter().map(|f| f.name.as_str()).collect();
        out.push_str(&format!("Dateien hinzugefügt: {}\n", names.join(", ")));
    }
    if r.is_empty() {
        out.push_str("An diesem Tag wurde nichts aufgezeichnet.\n");
    }
    out
}

/// The request for the summary: 3–6 German sentences and „Offen für morgen“.
pub fn summary_messages<Tz: TimeZone>(r: &DayReview, tz: &Tz) -> Vec<ChatMessage>
where
    Tz::Offset: std::fmt::Display,
{
    let system = "Du schreibst in Annalo, einem Notiz- und Zeiterfassungsprogramm, den Tagesrückblick des Nutzers. \
        Fasse den Tag auf Deutsch in 3 bis 6 Sätzen zusammen: woran gearbeitet wurde, wie viel Zeit gebucht ist, \
        welche Termine und Aufgaben wichtig waren. Sprich den Nutzer mit „du“ an, bleibe sachlich und erfinde nichts, \
        was nicht in den Daten steht. Schreibe danach eine Zeile „**Offen für morgen:**“ und darunter 1 bis 5 \
        Stichpunkte (- …) mit dem, was offen ist: fehlende Buchungen, nicht gebuchte Termine, fällige und \
        überfällige Aufgaben. Ist nichts offen, schreibe „- Nichts Dringendes.“. Antworte nur mit dem Text in \
        Markdown, ohne Überschrift und ohne Einleitung.";
    vec![ChatMessage::system(system.to_owned()), ChatMessage::user(format!("Daten des Tages:\n\n{}", describe(r, tz)))]
}

#[cfg(test)]
mod tests;
