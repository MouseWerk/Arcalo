//! „Morgen-Briefing“: what today holds, on one page – the meetings of the synced calendars with
//! their preparation (the meeting's note, else the last note of the same series or subject)
//! and join link, Jira issues due, overdue or blocked, tasks overdue and due today, the hours
//! the last workday is still missing against its target, and a short text „Was ist heute
//! wichtig“ written by the assistant from these sections.
//!
//! Everything comes from the local stores in one call ([`briefing`]). The text is built from
//! titles, times and counts only ([`summary_messages`]), never from page contents; when any of
//! it is private (a `#privat` marker, a private appointment or page) the request stays on the
//! local model. It is cached per day ([`SUMMARY_KEY`]) and written again on demand.
//!
//! Settings → Briefing ([`BriefingSettings`]): off, open on the first start of a workday, or
//! a desktop notification (at a set time or at the first start). Holidays and full absence
//! days are no briefing days ([`briefing_day`]); the day is stored in [`DAY_KEY`].

use crate::{tr, trf};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::ai::client::ChatMessage;
use crate::calsync::{Busy, CalendarEvent, is_private_title};
use crate::db::{Database, parse_ts};
use crate::error::{Error, Result};
use crate::feed::day_start;
use crate::focus::hm;
use crate::issues::{Issue, IssueFilter};
use crate::settings::Settings;
use crate::tasks::{TaskFilter, TaskStatus};
use crate::worktime::{Absence, Holiday, holidays_between};

/// Meta row with the day the briefing was last opened or notified.
pub const DAY_KEY: &str = "briefing.day";
/// Meta row with the cached text of the day ([`BriefingSummary`] as JSON).
pub const SUMMARY_KEY: &str = "briefing.summary";
/// Rows per list (the counts stay complete).
pub const MAX_ROWS: usize = 12;
/// Items per list in the request to the model.
const MAX_PROMPT_ITEMS: usize = 8;

/// The sections in their default order.
pub const SECTIONS: [&str; 5] = ["ai", "meetings", "tasks", "jira", "time"];

// ------------------------------------------------------------------ settings

/// When the briefing shows up by itself.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BriefingMode {
    /// Opens with the first start of a workday.
    Start,
    /// A desktop notification that opens it.
    Notify,
    /// Only when opened (palette, ribbon, Heute, tray); also an unknown mode.
    #[default]
    #[serde(other)]
    Off,
}

/// One section with its switch; the list order is the order on the page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingSection {
    pub id: String,
    pub on: bool,
}

/// Settings → Briefing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BriefingSettings {
    pub mode: BriefingMode,
    /// `HH:MM` of the notification; empty = at the first start of the day.
    pub notify_time: String,
    pub sections: Vec<BriefingSection>,
}

impl Default for BriefingSettings {
    fn default() -> Self {
        BriefingSettings {
            mode: BriefingMode::Off,
            notify_time: String::new(),
            sections: SECTIONS.iter().map(|id| BriefingSection { id: (*id).into(), on: true }).collect(),
        }
    }
}

impl BriefingSettings {
    /// Known sections once each, in the saved order, missing ones appended (switched on); a
    /// time that does not parse is cleared.
    pub fn normalized(mut self) -> Self {
        let mut out: Vec<BriefingSection> = vec![];
        for s in std::mem::take(&mut self.sections) {
            if SECTIONS.contains(&s.id.as_str()) && !out.iter().any(|x| x.id == s.id) {
                out.push(s);
            }
        }
        for id in SECTIONS {
            if !out.iter().any(|x| x.id == id) {
                out.push(BriefingSection { id: id.into(), on: true });
            }
        }
        self.sections = out;
        self.notify_time = match crate::desktop::parse_hhmm(self.notify_time.trim()) {
            Some(t) => t.format("%H:%M").to_string(),
            None => String::new(),
        };
        self
    }

    /// The switched-on sections in order.
    pub fn enabled(&self) -> Vec<String> {
        let s = self.clone().normalized();
        s.sections.into_iter().filter(|x| x.on).map(|x| x.id).collect()
    }
}

// ------------------------------------------------------------------ data

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Briefing {
    pub date: NaiveDate,
    /// A workday without a holiday or a full absence.
    pub workday: bool,
    /// The sections to show, in order: switched on, Jira only when configured, the time only
    /// with time tracking.
    pub sections: Vec<String>,
    pub meetings: Vec<BriefingMeeting>,
    /// Key of the meeting under way or next (all-day ones aside).
    pub next_meeting: Option<String>,
    /// `None` without a Jira site.
    pub jira: Option<BriefingJira>,
    pub tasks: BriefingTasks,
    /// `None` while time tracking is off.
    pub time: Option<BriefingTime>,
    /// Something private is in it: the text is written by the local model only.
    pub private: bool,
    /// The text of the day when one was written.
    pub summary: Option<BriefingSummary>,
    /// An AI provider is usable (set by the shell).
    pub ai_ready: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingMeeting {
    pub key: String,
    pub source: String,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub all_day: bool,
    pub location: String,
    /// Teams, Zoom, Webex, … link.
    pub link: Option<String>,
    /// Free, out of office or a private appointment: not a work meeting.
    pub free: bool,
    /// Over by now.
    pub past: bool,
    /// The meeting's own note (opened or created with „Notiz“).
    pub note_page_id: Option<i64>,
    pub prep: Option<Prep>,
}

/// What to read before a meeting.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Prep {
    pub page_id: i64,
    pub title: String,
    /// `own` (this meeting's note), `series` (an earlier meeting of the series) or `subject`
    /// (an earlier meeting with the same subject).
    pub kind: String,
    pub at: DateTime<Utc>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BriefingJira {
    pub overdue: Vec<BriefingIssue>,
    pub due: Vec<BriefingIssue>,
    /// Blocked issues that are neither due nor overdue (those carry `blocked` themselves).
    pub blocked: Vec<BriefingIssue>,
    pub overdue_total: i64,
    pub due_total: i64,
    pub blocked_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingIssue {
    pub site: String,
    pub key: String,
    pub summary: String,
    pub status: String,
    pub priority: String,
    pub due_date: Option<String>,
    pub url: String,
    pub blocked: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BriefingTasks {
    pub overdue: Vec<BriefingTask>,
    pub today: Vec<BriefingTask>,
    pub overdue_total: i64,
    pub today_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingTask {
    pub page_id: i64,
    pub page_title: String,
    pub ordinal: i64,
    pub text: String,
    pub due: Option<String>,
    pub priority: u8,
}

/// The last workday against its target.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingTime {
    pub date: NaiveDate,
    pub target_minutes: i64,
    pub booked_minutes: i64,
    pub missing_minutes: i64,
    /// The public holiday of that day (in the UI language).
    pub holiday: Option<String>,
    /// `vacation`, `sick`, `comp` or `other`.
    pub absence: Option<String>,
    pub half: bool,
}

/// The cached text of a day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BriefingSummary {
    pub date: NaiveDate,
    pub text: String,
    pub model: String,
    pub at: DateTime<Utc>,
    /// Written by the local model because something private is in the briefing.
    #[serde(default)]
    pub local: bool,
}

// ------------------------------------------------------------------ days

/// Whether `date` gets a briefing: a workday of the settings that is no public holiday and no
/// full absence day (a half one still is).
pub fn briefing_day(settings: &Settings, date: NaiveDate, holidays: &[Holiday], absence: Option<&Absence>) -> bool {
    settings.workdays.contains(&date.weekday().number_from_monday())
        && holidays.iter().all(|h| h.date != date)
        && absence.is_none_or(|a| a.half)
}

/// [`briefing_day`] with the holidays of the chosen state and the stored absences.
pub fn is_briefing_day(db: &Database, settings: &Settings, date: NaiveDate) -> Result<bool> {
    let holidays = holidays_between(date, date, &settings.time.balance.state);
    let absence = db.absences(date, date)?.into_iter().next();
    Ok(briefing_day(settings, date, &holidays, absence.as_ref()))
}

/// What the first start of a day does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StartAction {
    None,
    Open,
    Notify,
}

/// The first start of `today` (`last`: the day stored in [`DAY_KEY`]): open the briefing, or
/// notify when no notification time is set (with a time, [`notify_due`] does it). Nothing
/// on a day that is no briefing day, or a second time.
pub fn start_action(
    s: &BriefingSettings,
    today: NaiveDate,
    last: Option<NaiveDate>,
    briefing_day: bool,
) -> StartAction {
    if last == Some(today) || !briefing_day {
        return StartAction::None;
    }
    match s.mode {
        BriefingMode::Off => StartAction::None,
        BriefingMode::Start => StartAction::Open,
        BriefingMode::Notify if crate::desktop::parse_hhmm(&s.notify_time).is_none() => StartAction::Notify,
        BriefingMode::Notify => StartAction::None,
    }
}

/// Whether the notification at the set time is due now: notification mode with a time, at or
/// after it, not yet today, not in the quiet hours (retried after them), a briefing day.
pub fn notify_due(now: NaiveDateTime, settings: &Settings, last: Option<NaiveDate>, briefing_day: bool) -> bool {
    let b = &settings.briefing;
    let Some(at) = crate::desktop::parse_hhmm(&b.notify_time) else { return false };
    b.mode == BriefingMode::Notify
        && briefing_day
        && now.time() >= at
        && last != Some(now.date())
        && !settings.notifications.is_quiet(now.time())
}

/// The workday before `today` (by the weekday targets), at most two weeks back.
pub fn last_workday(settings: &Settings, today: NaiveDate) -> Option<NaiveDate> {
    (1..=14).map(|n| today - Duration::days(n)).find(|d| crate::worktime::weekday_minutes(settings, *d) > 0)
}

// ------------------------------------------------------------------ build

/// Whether a Jira status reads as blocked („Blocked“, „Impediment“, „Blockiert“, „Behindert“).
pub fn is_blocked(i: &Issue) -> bool {
    let s = i.status.to_lowercase();
    !i.done() && ["block", "imped", "behinder", "on hold"].iter().any(|w| s.contains(w))
}

fn issue(i: &Issue) -> BriefingIssue {
    BriefingIssue {
        site: i.site.clone(),
        key: i.key.clone(),
        summary: i.summary.clone(),
        status: i.status.clone(),
        priority: i.priority.clone(),
        due_date: i.due_date.clone(),
        url: i.url.clone(),
        blocked: is_blocked(i),
    }
}

/// The issue lists of `today` from the cached issues (open ones only).
pub fn jira_section(issues: &[Issue], today: NaiveDate) -> BriefingJira {
    let key = today.format("%Y-%m-%d").to_string();
    let mut j = BriefingJira::default();
    let mut open: Vec<&Issue> = issues.iter().filter(|i| !i.done()).collect();
    open.sort_by(|a, b| a.due_date.cmp(&b.due_date).then_with(|| a.key.cmp(&b.key)));
    for i in open {
        match i.due_date.as_deref() {
            Some(d) if d < key.as_str() => j.overdue.push(issue(i)),
            Some(d) if d == key => j.due.push(issue(i)),
            _ if is_blocked(i) => j.blocked.push(issue(i)),
            _ => {}
        }
    }
    j.overdue_total = j.overdue.len() as i64;
    j.due_total = j.due.len() as i64;
    j.blocked_total = j.blocked.len() as i64;
    j.overdue.truncate(MAX_ROWS);
    j.due.truncate(MAX_ROWS);
    j.blocked.truncate(MAX_ROWS);
    j
}

/// The note to prepare `e` with: its own, else the newest note of an earlier meeting of the
/// same series, else of one with the same subject (also found by the title meeting notes get).
pub fn prep(db: &Database, e: &CalendarEvent) -> Result<Option<Prep>> {
    let c = db.conn();
    let row = |sql: &str, args: &[&dyn rusqlite::ToSql]| -> Result<Option<(i64, String, String)>> {
        Ok(c.query_row(sql, args, |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?)
    };
    let make = |(page_id, title, at): (i64, String, String), kind: &str| -> Result<Prep> {
        Ok(Prep { page_id, title, kind: kind.into(), at: parse_ts(&at)? })
    };
    if let Some(id) = e.note_page_id
        && let Some(r) = row("SELECT id, title, updated_at FROM pages WHERE id = ?1 AND deleted_at IS NULL", &[&id])?
    {
        return Ok(Some(make(r, "own")?));
    }
    let ev = &e.event;
    const MARKED: &str = "SELECT p.id, p.title, p.created_at FROM calendar_marks m
                          JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL WHERE m.key <> ?1";
    if ev.recurring && !ev.uid.is_empty() {
        let prefix = format!("{}|{}|", e.source, ev.uid);
        let sql = format!(
            "{MARKED} AND (m.series = ?2 OR substr(m.key, 1, length(?3)) = ?3) ORDER BY p.created_at DESC LIMIT 1"
        );
        if let Some(r) = row(&sql, &[&e.key, &ev.uid, &prefix])? {
            return Ok(Some(make(r, "series")?));
        }
    }
    let title = ev.title.trim();
    if title.is_empty() || is_private_title(title) {
        return Ok(None);
    }
    let sql = format!("{MARKED} AND m.title = ?2 ORDER BY p.created_at DESC LIMIT 1");
    if let Some(r) = row(&sql, &[&e.key, &title.to_lowercase()])? {
        return Ok(Some(make(r, "subject")?));
    }
    // Meeting notes are titled „<subject> <date>“.
    let base = format!("{} ", crate::notes::clean_title(title).to_lowercase());
    let sql = "SELECT id, title, created_at FROM pages
               WHERE deleted_at IS NULL AND substr(lower(title), 1, length(?1)) = ?1
                 AND parent_id IN (SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL
                                   AND title IN (?2 COLLATE NOCASE, ?3 COLLATE NOCASE))
               ORDER BY created_at DESC LIMIT 1";
    let found = row(sql, &[&base, &crate::calsync::MEETINGS_TITLE, &crate::calsync::MEETINGS_TITLE_EN])?;
    found.map(|r| make(r, "subject")).transpose()
}

/// The briefing of the local day `date` with the meetings of `sources`.
pub fn briefing<Tz: TimeZone>(
    db: &Database,
    date: NaiveDate,
    tz: &Tz,
    settings: &Settings,
    sources: &[String],
    now: DateTime<Utc>,
) -> Result<Briefing> {
    let next = date
        .succ_opt()
        .ok_or_else(|| Error::State(tr!("Datum außerhalb des gültigen Bereichs", "Date out of range").into()))?;
    let (from, to) = (day_start(date, tz), day_start(next, tz));
    let key = date.format("%Y-%m-%d").to_string();
    let markers = crate::ai::privacy::normalize(&settings.router.private_markers);
    let marked = |text: &str| crate::ai::privacy::any_private([text], &markers);
    let mut private = false;

    let time_on = settings.time_tracking();
    let jira_on = settings.jira.active().next().is_some();
    let sections: Vec<String> = settings
        .briefing
        .enabled()
        .into_iter()
        .filter(|s| (s != "jira" || jira_on) && (s != "time" || time_on))
        .collect();
    let wants = |id: &str| sections.iter().any(|s| s == id);
    // The text is built from every section shown.
    let ai = wants("ai");

    // ---- meetings
    let mut meetings = vec![];
    if wants("meetings") || ai {
        let events = db.calendar_events(from, to, sources)?;
        let mut prep_pages = vec![];
        for e in &events {
            let ev = &e.event;
            let free = matches!(ev.busy, Busy::Free | Busy::Oof) || (ev.private && is_private_title(&ev.title));
            private |= ev.private || marked(&ev.title);
            let p = prep(db, e)?;
            if let Some(p) = &p {
                prep_pages.push(p.page_id);
            }
            meetings.push(BriefingMeeting {
                key: e.key.clone(),
                source: e.source.clone(),
                title: ev.title.clone(),
                start: ev.start,
                end: ev.end,
                all_day: ev.all_day,
                location: ev.location.clone(),
                link: ev.link.clone(),
                free,
                past: !ev.all_day && ev.end <= now,
                note_page_id: e.note_page_id,
                prep: p,
            });
        }
        if !markers.is_empty() && !prep_pages.is_empty() {
            private |= !crate::ai::privacy::private_pages(db, prep_pages, &markers)?.is_empty();
        }
    }
    let next_meeting = meetings.iter().find(|m| !m.all_day && !m.free && m.end > now).map(|m| m.key.clone());

    // ---- Jira
    let jira = if jira_on && (wants("jira") || ai) {
        let list = db.issues_list(&IssueFilter { limit: Some(2000), ..Default::default() })?;
        let j = jira_section(&list, date);
        private |= j.overdue.iter().chain(&j.due).chain(&j.blocked).any(|i| marked(&i.summary));
        Some(j)
    } else {
        None
    };

    // ---- tasks
    let mut tasks = BriefingTasks::default();
    if wants("tasks") || ai {
        let open = db.list_tasks(&TaskFilter {
            status: TaskStatus::Open,
            due_before: Some(key.clone()),
            ..Default::default()
        })?;
        for t in open {
            let Some(due) = t.due.clone() else { continue };
            private |= marked(&t.text) || t.tags.iter().any(|g| marked(&format!("#{g}")));
            let row = BriefingTask {
                page_id: t.page_id,
                page_title: t.page_title,
                ordinal: t.ordinal,
                text: t.text,
                due: t.due,
                priority: t.priority,
            };
            if due == key { tasks.today.push(row) } else { tasks.overdue.push(row) }
        }
        tasks.overdue_total = tasks.overdue.len() as i64;
        tasks.today_total = tasks.today.len() as i64;
        tasks.overdue.truncate(MAX_ROWS);
        tasks.today.truncate(MAX_ROWS);
    }

    // ---- the last workday
    let time = if time_on && (wants("time") || ai) {
        last_workday(settings, date).map(|d| last_day(db, settings, d, tz, now)).transpose()?
    } else {
        None
    };

    let summary = db
        .meta_get(SUMMARY_KEY)?
        .and_then(|s| serde_json::from_str::<BriefingSummary>(&s).ok())
        .filter(|s| s.date == date);
    let workday = is_briefing_day(db, settings, date)?;
    Ok(Briefing {
        date,
        workday,
        sections,
        meetings,
        next_meeting,
        jira,
        tasks,
        time,
        private,
        summary,
        ai_ready: false,
    })
}

/// Day `d` against its target: none on a holiday or full absence day, half on a half one.
fn last_day<Tz: TimeZone>(
    db: &Database,
    settings: &Settings,
    d: NaiveDate,
    tz: &Tz,
    now: DateTime<Utc>,
) -> Result<BriefingTime> {
    let holiday = holidays_between(d, d, &settings.time.balance.state).into_iter().next();
    let absence = db.absences(d, d)?.into_iter().next();
    let base = crate::worktime::weekday_minutes(settings, d);
    let target = crate::worktime::day_target(base, holiday.is_some(), absence.as_ref(), false);
    let booked = crate::worktime::booked_by_day(db, tz, d, d, now)?.get(&d).copied().unwrap_or(0);
    let en = crate::i18n::is_en();
    Ok(BriefingTime {
        date: d,
        target_minutes: target,
        booked_minutes: booked,
        missing_minutes: (target - booked).max(0),
        holiday: holiday.map(|h| if en { h.name_en } else { h.name }),
        absence: absence.as_ref().map(|a| a.kind.as_str().to_owned()),
        half: absence.is_some_and(|a| a.half),
    })
}

// ------------------------------------------------------------------ text

fn plural(n: i64, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// The notification: „3 Termine · 2 Aufgaben überfällig · 1,5 h von Montag offen“.
pub fn notify_body(b: &Briefing) -> String {
    let mut parts = vec![];
    let n = b.meetings.iter().filter(|m| !m.free).count() as i64;
    if n > 0 {
        parts.push(plural(n, tr!("Termin", "meeting"), tr!("Termine", "meetings")));
    }
    let due = b.tasks.overdue_total + b.tasks.today_total;
    if due > 0 {
        let n = plural(due, tr!("Aufgabe", "task"), tr!("Aufgaben", "tasks"));
        parts.push(trf!("{n} fällig", "{n} due"));
    }
    if let Some(j) = &b.jira {
        let n = j.overdue_total + j.due_total + j.blocked_total;
        if n > 0 {
            let n = plural(n, tr!("Vorgang", "issue"), tr!("Vorgänge", "issues"));
            parts.push(trf!("{n} in Jira", "{n} in Jira"));
        }
    }
    if let Some(t) = b.time.as_ref().filter(|t| t.missing_minutes > 0) {
        let h = crate::desktop::format_hours(t.missing_minutes as f64);
        parts.push(trf!("{h} h nicht gebucht", "{h} h not booked"));
    }
    if parts.is_empty() {
        return tr!("Nichts Dringendes heute.", "Nothing urgent today.").into();
    }
    parts.join(" · ")
}

/// The briefing as compact text for the model: titles, times and counts, no page contents.
pub fn describe<Tz: TimeZone>(b: &Briefing, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let t = |at: DateTime<Utc>| at.with_timezone(tz).format("%H:%M").to_string();
    let en = crate::i18n::is_en();
    const WEEKDAYS: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];
    let weekday = |d: NaiveDate| {
        if en { d.format("%A").to_string() } else { WEEKDAYS[d.weekday().num_days_from_monday() as usize].to_owned() }
    };
    let mut out = if en {
        format!("Today: {}, {}\n", weekday(b.date), b.date.format("%Y-%m-%d"))
    } else {
        format!("Heute: {}, {}\n", weekday(b.date), b.date.format("%d.%m.%Y"))
    };
    let more = |out: &mut String, shown: usize, total: i64| {
        if total > shown as i64 {
            let n = total - shown as i64;
            out.push_str(&trf!("- … und {n} weitere\n", "- … and {n} more\n"));
        }
    };
    let meetings: Vec<&BriefingMeeting> = b.meetings.iter().filter(|m| !m.free).collect();
    if meetings.is_empty() {
        out.push_str(tr!("Termine: keine\n", "Meetings: none\n"));
    } else {
        let n = meetings.len();
        out.push_str(&trf!("Termine ({n}):\n", "Meetings ({n}):\n"));
        for m in meetings.iter().take(MAX_PROMPT_ITEMS) {
            let when = if m.all_day {
                tr!("ganztägig", "all day").to_owned()
            } else {
                format!("{}–{}", t(m.start), t(m.end))
            };
            let mut line = format!("- {when} {}", m.title);
            if m.past {
                line.push_str(tr!(" (vorbei)", " (over)"));
            } else if m.prep.is_none() {
                line.push_str(tr!(" (ohne Notiz)", " (no notes)"));
            }
            out.push_str(&line);
            out.push('\n');
        }
        more(&mut out, MAX_PROMPT_ITEMS.min(n), n as i64);
    }
    let tk = &b.tasks;
    for (label, list, total, dated) in [
        (tr!("Aufgaben überfällig", "Tasks overdue"), &tk.overdue, tk.overdue_total, true),
        (tr!("Aufgaben heute fällig", "Tasks due today"), &tk.today, tk.today_total, false),
    ] {
        out.push_str(&format!("{label}: {total}\n"));
        for x in list.iter().take(MAX_PROMPT_ITEMS) {
            match x.due.as_deref().filter(|_| dated) {
                Some(due) => out.push_str(&format!("- {} ({due})\n", x.text)),
                None => out.push_str(&format!("- {}\n", x.text)),
            }
        }
        more(&mut out, list.len().min(MAX_PROMPT_ITEMS), total);
    }
    if let Some(j) = &b.jira {
        for (label, list, total) in [
            (tr!("Jira überfällig", "Jira overdue"), &j.overdue, j.overdue_total),
            (tr!("Jira heute fällig", "Jira due today"), &j.due, j.due_total),
            (tr!("Jira blockiert", "Jira blocked"), &j.blocked, j.blocked_total),
        ] {
            if total == 0 {
                continue;
            }
            out.push_str(&format!("{label}: {total}\n"));
            for i in list.iter().take(MAX_PROMPT_ITEMS) {
                let blocked = if i.blocked { format!(", {}", tr!("blockiert", "blocked")) } else { String::new() };
                out.push_str(&format!("- {} {} ({}{blocked})\n", i.key, i.summary, i.status));
            }
            more(&mut out, list.len().min(MAX_PROMPT_ITEMS), total);
        }
    }
    if let Some(tm) = &b.time {
        let day = weekday(tm.date);
        if tm.target_minutes <= 0 {
            out.push_str(&trf!("{day}: kein Soll\n", "{day}: no target\n"));
        } else {
            let (booked, target, missing) = (hm(tm.booked_minutes), hm(tm.target_minutes), hm(tm.missing_minutes));
            out.push_str(&trf!(
                "{day}: {booked} von {target} gebucht, {missing} fehlen\n",
                "{day}: {booked} of {target} booked, {missing} missing\n"
            ));
        }
    }
    out
}

/// The request for „Was ist heute wichtig“: a few lines from [`describe`].
pub fn summary_messages<Tz: TimeZone>(b: &Briefing, tz: &Tz) -> Vec<ChatMessage>
where
    Tz::Offset: std::fmt::Display,
{
    let system = tr!(
        "Du schreibst das Morgen-Briefing einer Person: „Was ist heute wichtig“. Antworte auf Deutsch mit 2 bis 4 \
         kurzen Stichpunkten (Markdown-Liste, je höchstens 15 Wörter): zuerst Fälliges und Blockiertes, dann Termine, \
         die Vorbereitung brauchen, dann offene Stunden. Nenne nur, was in den Daten steht; keine Begrüßung, keine \
         Überschrift. Ist nichts dringend, schreibe „- Nichts Dringendes heute.“.",
        "You write a person's morning briefing: “What matters today”. Answer in English with 2 to 4 short bullet \
         points (a Markdown list, at most 15 words each): first what is due or blocked, then meetings that need \
         preparation, then unbooked hours. Mention only what is in the data; no greeting, no heading. If nothing \
         is urgent, write “- Nothing urgent today.”."
    );
    vec![ChatMessage::system(system), ChatMessage::user(describe(b, tz))]
}

/// The first lines of the answer, as a list (at most four points).
pub fn clean_summary(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim_end).filter(|l| !l.trim().is_empty()).take(4).collect();
    lines.join("\n")
}

#[cfg(test)]
mod tests;
