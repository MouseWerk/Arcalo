//! „Wochenrückblick“: one ISO week (Monday to Sunday) on one page – time booked per day against
//! the day's target (targets per weekday, public holidays and absences as in the balance), the
//! unbooked gaps and the top Netzpläne/Vorgänge, tasks done and still open, meetings of the
//! synced calendars by day, focus sessions and focus blocks, and the pages worked on.
//!
//! The week is built from the seven day reviews ([`crate::dayreview::day_review`]), so a day
//! means the same in both (DST days of 23 or 25 hours included); the targets come from
//! [`crate::worktime`]. A repeating task counts once per occurrence it was checked off; any
//! other task once, however often it was checked and unchecked in the week.
//!
//! „Als Wochenbericht speichern“ writes the page „Wochenbericht KW 41 2026“ ([`report_title`])
//! filed like a journal page (year/month folders, the filing rules apply), from the template
//! „Wochenbericht“ in „Vorlagen“ when there is one ([`default_template`] otherwise). The
//! generated part stands between the markers of [`crate::meetwork::block`]: saving the week
//! again replaces only that part, the user's notes around it stay.
//!
//! The optional summary goes through the router; the week counts as private (local model only)
//! when one of its pages or meetings is ([`is_private`]).

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::ai::client::ChatMessage;
use crate::dayreview::{self, ReviewGap, ReviewMeeting, ReviewOptions, ReviewWbs};
use crate::db::{Database, ts};
use crate::error::{Error, Result};
use crate::feed::day_start;
use crate::filing::{FileInfo, FileType};
use crate::focus::hm;
use crate::meetwork::block;
use crate::model::Page;
use crate::settings::Settings;
use crate::templates::{TemplateVars, apply_template};
use crate::worktime;
use crate::{tr, trf};

/// At most this many tasks per list and pages (the totals count all).
const MAX_TASKS: usize = 50;
const MAX_PAGES: usize = 60;
/// At most this many entry descriptions per Netzplan/Vorgang.
const MAX_DESCRIPTIONS: usize = 6;
/// Meta row prefix: `week_report.page.<Monday>` → the report page of that week.
pub const PAGE_KEY: &str = "week_report.page.";
/// Names of the report template in „Vorlagen“.
pub const TEMPLATE_NAMES: [&str; 2] = ["Wochenbericht", "Weekly report"];
/// Page icon of the reports and the template.
pub const ICON: &str = "clipboard-list";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekReview {
    pub monday: NaiveDate,
    pub sunday: NaiveDate,
    /// ISO week and its year (the year of the week's Thursday).
    pub week: u32,
    pub year: i32,
    /// UTC bounds of the local week.
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    /// Monday to Sunday.
    pub days: Vec<WeekDay>,
    pub time: WeekTime,
    pub tasks: WeekTasks,
    /// By start, each with its day.
    pub meetings: Vec<WeekMeeting>,
    pub focus: WeekFocus,
    /// Most recently worked on first.
    pub pages: Vec<WeekPage>,
    pub pages_total: i64,
    /// The saved report of this week, if there is one.
    pub report_page_id: Option<i64>,
    /// Time tracking is off ([`WeekReview::without_time`]): nothing about booking in it.
    #[serde(default)]
    pub without_time: bool,
}

/// One day of the week.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeekDay {
    pub date: NaiveDate,
    /// The target after holidays and absences (0 on days off).
    pub target_minutes: i64,
    pub booked_minutes: i64,
    /// A timer started that day and still running.
    pub running_minutes: i64,
    /// Target minus booked, never negative, once the day is over ([`worktime::day_is_over`]);
    /// 0 for days still ahead and for today before the evening.
    pub missing_minutes: i64,
    /// After today.
    pub future: bool,
    /// A workday before the workspace was set up ([`worktime::counts_from`]): no target, but
    /// not a day off either.
    #[serde(default)]
    pub before_setup: bool,
    /// Name of the public holiday (display language).
    pub holiday: Option<String>,
    /// `vacation`, `sick`, `comp` or `other`.
    pub absence: Option<String>,
    pub absence_half: bool,
    /// Unbooked stretches between the day's bookings.
    pub gaps: Vec<ReviewGap>,
    pub meetings: i64,
    pub pages: i64,
    pub tasks_done: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeekTime {
    pub target_minutes: i64,
    /// Targets of the days up to today (the whole week once it is over).
    pub target_to_date: i64,
    pub booked_minutes: i64,
    pub running_minutes: i64,
    /// Sum of the days' missing minutes (the days that are over).
    pub missing_minutes: i64,
    /// Per Netzplan/Vorgang, most minutes first.
    pub items: Vec<ReviewWbs>,
    /// Unbooked stretches between bookings: how many and how long together.
    pub gaps: i64,
    pub gap_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekTask {
    pub page_id: Option<i64>,
    pub page_title: String,
    pub text: String,
    /// The day it was checked off (done tasks).
    pub day: Option<NaiveDate>,
    pub due: Option<String>,
    /// A repeating task (`every:`): each occurrence checked off counts.
    pub repeating: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeekTasks {
    /// Checked off in the week, in order.
    pub done: Vec<WeekTask>,
    /// Still open and due in the week.
    pub open: Vec<WeekTask>,
    /// Still open and due before the week.
    pub overdue: Vec<WeekTask>,
    pub done_total: i64,
    pub open_total: i64,
    pub overdue_total: i64,
    /// Written in the week and not done yet.
    pub added_total: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekMeeting {
    pub day: NaiveDate,
    #[serde(flatten)]
    pub meeting: ReviewMeeting,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WeekFocus {
    /// Minutes worked in finished focus sessions, and how many sessions.
    pub minutes: i64,
    pub sessions: i64,
    /// Planned focus blocks of the Kalender.
    pub blocks: Vec<WeekBlock>,
    pub planned_minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekBlock {
    pub id: i64,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub minutes: i64,
    /// The linked task is done (`None`: no task).
    pub task_done: Option<bool>,
    /// Minutes worked in focus sessions started from the block.
    pub focus_minutes: i64,
    pub booked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WeekPage {
    pub page_id: Option<i64>,
    pub title: String,
    pub icon: Option<String>,
    pub gone: bool,
    pub created: bool,
    pub daily: bool,
    pub edits: i64,
    /// Estimated editing time.
    pub minutes: i64,
    /// Days of the week it was worked on.
    pub days: i64,
    pub last_at: DateTime<Utc>,
    pub word_delta: Option<i64>,
}

impl WeekReview {
    /// The review for a workspace without time tracking: no time part, meetings that are over
    /// are `done`, blocks without their booking. Only the view changes; the data stays.
    pub fn without_time(mut self) -> Self {
        self.without_time = true;
        self.time = WeekTime::default();
        for d in &mut self.days {
            *d = WeekDay {
                date: d.date,
                future: d.future,
                holiday: d.holiday.take(),
                absence: d.absence.take(),
                absence_half: d.absence_half,
                meetings: d.meetings,
                pages: d.pages,
                tasks_done: d.tasks_done,
                ..WeekDay::default()
            };
        }
        for m in &mut self.meetings {
            if matches!(m.meeting.state.as_str(), "booked" | "skipped" | "open") {
                m.meeting.state = "done".into();
            }
            m.meeting.entry_id = None;
        }
        for b in &mut self.focus.blocks {
            b.booked = false;
        }
        self
    }

    /// Nothing happened (and nothing was planned) that week.
    pub fn is_empty(&self) -> bool {
        self.pages.is_empty()
            && self.time.booked_minutes == 0
            && self.time.running_minutes == 0
            && self.tasks.done.is_empty()
            && self.meetings.is_empty()
            && self.focus.sessions == 0
            && self.focus.blocks.is_empty()
    }
}

// ------------------------------------------------------------------ helpers

/// The Monday of `date`'s week.
pub fn monday_of(date: NaiveDate) -> NaiveDate {
    date - Duration::days(date.weekday().num_days_from_monday() as i64)
}

/// „Wochenbericht KW 41 2026“ (ISO week and its year).
pub fn report_title(monday: NaiveDate) -> String {
    let w = monday.iso_week();
    trf!("Wochenbericht KW {:02} {}", "Weekly report week {:02} {}", w.week(), w.year())
}

/// Both languages' titles of the report (an existing one is found after a language switch).
fn report_titles(monday: NaiveDate) -> [String; 2] {
    let w = monday.iso_week();
    [
        format!("Wochenbericht KW {:02} {}", w.week(), w.year()),
        format!("Weekly report week {:02} {}", w.week(), w.year()),
    ]
}

/// „05.10.–11.10.2026“ (`2026-10-05 – 2026-10-11` in English).
pub fn range_label(monday: NaiveDate) -> String {
    let sunday = monday + Duration::days(6);
    if crate::i18n::is_en() {
        format!("{} – {}", monday.format("%Y-%m-%d"), sunday.format("%Y-%m-%d"))
    } else if monday.year() == sunday.year() {
        format!("{}–{}", monday.format("%d.%m."), sunday.format("%d.%m.%Y"))
    } else {
        format!("{}–{}", monday.format("%d.%m.%Y"), sunday.format("%d.%m.%Y"))
    }
}

/// Minutes as hours with at most two decimals: `390` → „6,5 h“.
pub fn hours(minutes: i64) -> String {
    let h = (minutes as f64 / 60.0 * 100.0).round() / 100.0;
    let s = format!("{h:.2}");
    let s = s.trim_end_matches('0').trim_end_matches('.').to_owned();
    format!("{} h", crate::i18n::decimal(s))
}

/// Signed hours: „+1,5 h“, „−2 h“, „0 h“.
fn signed_hours(minutes: i64) -> String {
    match minutes.signum() {
        1 => format!("+{}", hours(minutes)),
        -1 => format!("−{}", hours(-minutes)),
        _ => hours(0),
    }
}

/// „Mo 05.10.“ / „Mon 10/05“.
fn day_label(d: NaiveDate) -> String {
    const DE: [&str; 7] = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
    const EN: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    let i = d.weekday().num_days_from_monday() as usize;
    if crate::i18n::is_en() {
        format!("{} {}", EN[i], d.format("%m/%d"))
    } else {
        format!("{} {}", DE[i], d.format("%d.%m."))
    }
}

/// Plain text for one Markdown line: no line breaks, no table pipes.
fn inline(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ").replace('|', "/")
}

/// A page as a wiki link, plain when it is gone (link characters removed either way).
fn page_ref(title: &str, gone: bool) -> String {
    let t = inline(&title.replace(['[', ']', '|', '#', '^'], " "));
    if gone || t.is_empty() { t } else { format!("[[{t}]]") }
}

fn absence_label(kind: &str, half: bool) -> String {
    let name = match kind {
        "vacation" => tr!("Urlaub", "Vacation"),
        "sick" => tr!("krank", "Sick"),
        "comp" => tr!("Ausgleich", "Time off in lieu"),
        _ => tr!("abwesend", "Absent"),
    };
    if half { trf!("{name} (halber Tag)", "{name} (half day)") } else { name.to_owned() }
}

/// Whether the task `text` on page `page_id` repeats (its rule is not part of the text).
fn repeats(db: &Database, page_id: Option<i64>, text: &str) -> Result<bool> {
    let Some(id) = page_id else { return Ok(false) };
    Ok(db
        .conn()
        .prepare_cached("SELECT 1 FROM tasks WHERE page_id = ?1 AND text = ?2 AND recur IS NOT NULL LIMIT 1")?
        .query_row(params![id, text], |_| Ok(()))
        .optional()?
        .is_some())
}

// -------------------------------------------------------------------- query

/// The review of the week of `date` in `tz`. `sources`: the calendars to include (`None`: all
/// stored ones); `now`: what counts as past and how long a running timer has run.
pub fn week_review<Tz: TimeZone>(
    db: &Database,
    date: NaiveDate,
    tz: &Tz,
    settings: &Settings,
    sources: Option<Vec<String>>,
    now: DateTime<Utc>,
) -> Result<WeekReview> {
    let monday = monday_of(date);
    let sunday = monday + Duration::days(6);
    let next = sunday
        .succ_opt()
        .ok_or_else(|| Error::State(tr!("Datum außerhalb des gültigen Bereichs", "Date out of range").into()))?;
    let (from, to) = (day_start(monday, tz), day_start(next, tz));
    let today = now.with_timezone(tz).date_naive();
    let opts = ReviewOptions::from_settings(settings, sources, now);
    // The rule of every view: the weekday's target, none on a holiday, half on a half absence.
    let targets = worktime::DayTargets::load(db, settings, monday, sunday)?;
    let en = crate::i18n::is_en();

    let mut days = Vec::with_capacity(7);
    let mut reviews = Vec::with_capacity(7);
    for i in 0..7 {
        let d = monday + Duration::days(i);
        // The open tasks are read once for the week below, not per day.
        let r = dayreview::review_day(db, d, tz, &opts, settings, &targets, false)?;
        let holiday = targets.holiday(d);
        let absence = targets.absence(d);
        let target = targets.get(d);
        let future = d > today;
        days.push(WeekDay {
            date: d,
            target_minutes: target,
            booked_minutes: r.time.booked_minutes,
            running_minutes: r.time.running_minutes,
            missing_minutes: if worktime::day_is_over(d, now, tz) {
                (target - r.time.booked_minutes).max(0)
            } else {
                0
            },
            future,
            before_setup: r.time.before_setup,
            holiday: holiday.map(|h| if en { h.name_en.clone() } else { h.name.clone() }),
            absence: absence.map(|a| a.kind.as_str().to_owned()),
            absence_half: absence.is_some_and(|a| a.half),
            gaps: if future { vec![] } else { r.time.gaps.clone() },
            meetings: r.meetings.len() as i64,
            pages: r.pages.len() as i64,
            tasks_done: r.tasks.done_total,
        });
        reviews.push(r);
    }

    // ---- time: the days summed, the Netzpläne/Vorgänge merged.
    let mut time = WeekTime::default();
    for d in &days {
        time.target_minutes += d.target_minutes;
        if !d.future {
            time.target_to_date += d.target_minutes;
        }
        time.booked_minutes += d.booked_minutes;
        time.running_minutes += d.running_minutes;
        time.missing_minutes += d.missing_minutes;
        time.gaps += d.gaps.len() as i64;
        time.gap_minutes += d.gaps.iter().map(|g| g.minutes).sum::<i64>();
    }
    let mut index: HashMap<(i64, Option<String>), usize> = HashMap::new();
    for item in reviews.iter().flat_map(|r| &r.time.items) {
        let key = (item.netzplan_id, item.vorgang_nr.as_ref().map(|v| v.to_lowercase()));
        match index.get(&key) {
            Some(&i) => {
                let w = &mut time.items[i];
                w.minutes += item.minutes;
                w.entries += item.entries;
                for d in &item.descriptions {
                    if w.descriptions.len() < MAX_DESCRIPTIONS
                        && !w.descriptions.iter().any(|x| x.eq_ignore_ascii_case(d))
                    {
                        w.descriptions.push(d.clone());
                    }
                }
            }
            None => {
                index.insert(key, time.items.len());
                let mut w = item.clone();
                w.descriptions.truncate(MAX_DESCRIPTIONS);
                time.items.push(w);
            }
        }
    }
    time.items.sort_by(|x, y| y.minutes.cmp(&x.minutes).then_with(|| x.label.cmp(&y.label)));

    // ---- tasks: check-offs of the days; a task that does not repeat counts once (the last).
    let mut done: Vec<WeekTask> = vec![];
    let mut repeating: HashMap<(Option<i64>, String), bool> = HashMap::new();
    for r in &reviews {
        for t in &r.tasks.done {
            let key = (t.page_id, t.text.clone());
            let rep = match repeating.get(&key) {
                Some(&v) => v,
                None => {
                    let v = repeats(db, t.page_id, &t.text)?;
                    repeating.insert(key, v);
                    v
                }
            };
            if !rep {
                done.retain(|x| !(x.page_id == t.page_id && x.text == t.text));
            }
            done.push(WeekTask {
                page_id: t.page_id,
                page_title: t.page_title.clone(),
                text: t.text.clone(),
                day: Some(r.date),
                due: None,
                repeating: rep,
            });
        }
    }
    let added_total = {
        let done_keys: HashSet<(Option<i64>, &str)> = done.iter().map(|t| (t.page_id, t.text.as_str())).collect();
        let mut seen = HashSet::new();
        reviews
            .iter()
            .flat_map(|r| &r.tasks.added)
            .filter(|t| !t.done && !done_keys.contains(&(t.page_id, t.text.as_str())))
            .filter(|t| seen.insert((t.page_id, t.text.clone())))
            .count() as i64
    };
    // Still open: due in the week, and overdue before it (the first ones, counted in SQLite).
    let key = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let open_tasks = |from: Option<&str>, before: &str| -> Result<(Vec<WeekTask>, i64)> {
        let (list, total) = db.open_tasks_due(from, before, MAX_TASKS)?;
        let list = list
            .into_iter()
            .map(|t| WeekTask {
                page_id: Some(t.page_id),
                page_title: t.page_title,
                repeating: t.recur.is_some(),
                text: t.text,
                day: None,
                due: t.due,
            })
            .collect();
        Ok((list, total))
    };
    let (open, open_total) = open_tasks(Some(&key(monday)), &key(next))?;
    let (overdue, overdue_total) = open_tasks(None, &key(monday))?;
    let cap = |mut v: Vec<WeekTask>| {
        v.truncate(MAX_TASKS);
        v
    };
    let tasks = WeekTasks {
        done_total: done.len() as i64,
        open_total,
        overdue_total,
        added_total,
        done: cap(done),
        open,
        overdue,
    };

    // ---- meetings by day; one running over midnight shows on its first day.
    let mut keys = HashSet::new();
    let meetings: Vec<WeekMeeting> = reviews
        .iter()
        .flat_map(|r| r.meetings.iter().map(move |m| (r.date, m)))
        .filter(|(_, m)| keys.insert(m.key.clone()))
        .map(|(day, m)| WeekMeeting { day, meeting: m.clone() })
        .collect();

    // ---- focus: sessions of the days, blocks planned in the week.
    let blocks: Vec<WeekBlock> = db
        .blocks_in(from, to)?
        .into_iter()
        .map(|b| WeekBlock {
            minutes: b.minutes(),
            id: b.id,
            title: b.title,
            start: b.start,
            end: b.end,
            task_done: b.task_done,
            focus_minutes: b.focus_minutes,
            booked: b.entry_id.is_some(),
        })
        .collect();
    let focus = WeekFocus {
        minutes: reviews.iter().map(|r| r.focus.minutes).sum(),
        sessions: reviews
            .iter()
            .map(|r| r.focus.sessions.iter().filter(|s| s.status != "running").count() as i64)
            .sum(),
        planned_minutes: blocks.iter().map(|b| b.minutes).sum(),
        blocks,
    };

    // ---- pages: the days merged per page; folders the filing made, templates and the week's
    // own report are no work on the week.
    let report_page_id = db.week_report_page(monday)?.map(|p| p.id);
    let mut skip: HashSet<i64> = db.template_page_ids()?;
    skip.extend(
        db.conn()
            .prepare_cached("SELECT id FROM pages WHERE system_folder IS NOT NULL")?
            .query_map([], |r| r.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?,
    );
    skip.extend(report_page_id);
    let mut pages: Vec<WeekPage> = vec![];
    let mut at: HashMap<(Option<i64>, String), usize> = HashMap::new();
    for p in reviews.iter().flat_map(|r| &r.pages).filter(|p| p.page_id.is_none_or(|id| !skip.contains(&id))) {
        // A page deleted for good has no id: its old title keeps it apart.
        let key = (p.page_id, if p.page_id.is_some() { String::new() } else { p.title.clone() });
        match at.get(&key) {
            Some(&i) => {
                let w = &mut pages[i];
                w.edits += p.edits;
                w.minutes += p.minutes;
                w.days += 1;
                w.created |= p.created;
                w.last_at = w.last_at.max(p.last_at);
            }
            None => {
                at.insert(key, pages.len());
                pages.push(WeekPage {
                    page_id: p.page_id,
                    title: p.title.clone(),
                    icon: p.icon.clone(),
                    gone: p.gone,
                    created: p.created,
                    daily: p.daily,
                    edits: p.edits,
                    minutes: p.minutes,
                    days: 1,
                    last_at: p.last_at,
                    word_delta: None,
                });
            }
        }
    }
    pages.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    let pages_total = pages.len() as i64;
    pages.truncate(MAX_PAGES);
    let (a, b) = (ts(from), ts(to));
    for p in pages.iter_mut().filter(|p| !p.gone) {
        let Some(id) = p.page_id else { continue };
        p.word_delta = dayreview::word_delta(db, id, p.created, &a, &b)?;
    }

    let w = monday.iso_week();
    Ok(WeekReview {
        monday,
        sunday,
        week: w.week(),
        year: w.year(),
        from,
        to,
        days,
        time,
        tasks,
        meetings,
        focus,
        pages,
        pages_total,
        report_page_id,
        without_time: false,
    })
}

/// Whether the week holds something private (a page with a privacy marker or a private
/// meeting, or a marker in its text): then the summary is written by the local model only.
pub fn is_private<Tz: TimeZone>(db: &Database, r: &WeekReview, markers: &[String], tz: &Tz) -> Result<bool>
where
    Tz::Offset: std::fmt::Display,
{
    if r.meetings.iter().any(|m| m.meeting.private) {
        return Ok(true);
    }
    let ids = r.pages.iter().filter(|p| !p.gone).filter_map(|p| p.page_id);
    let ids = ids.chain(r.tasks.done.iter().chain(&r.tasks.open).chain(&r.tasks.overdue).filter_map(|t| t.page_id));
    if !crate::ai::privacy::private_pages(db, ids, markers)?.is_empty() {
        return Ok(true);
    }
    Ok(crate::ai::privacy::any_private([describe(r, tz).as_str()], markers))
}

// ------------------------------------------------------------------ summary

/// The week as plain text for the model: numbers and names, no page contents. Private meetings
/// appear without their subject.
pub fn describe<Tz: TimeZone>(r: &WeekReview, tz: &Tz) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let t = |at: DateTime<Utc>| at.with_timezone(tz).format("%H:%M").to_string();
    let (week, range) = (r.week, range_label(r.monday));
    let mut out = trf!("Woche: KW {week} ({range})\n", "Week: {week} ({range})\n");
    if !r.without_time {
        let tm = &r.time;
        let (booked, target) = (hours(tm.booked_minutes), hours(tm.target_minutes));
        out.push_str(&trf!("Gebucht: {booked} von {target} Soll", "Booked: {booked} of {target} target"));
        if tm.missing_minutes > 0 {
            let missing = hours(tm.missing_minutes);
            out.push_str(&trf!(", bis heute fehlen {missing}", ", {missing} missing so far"));
        }
        out.push('\n');
        for d in &r.days {
            let mut line =
                format!("- {}: {} / {}", day_label(d.date), hours(d.booked_minutes), hours(d.target_minutes));
            if let Some(h) = &d.holiday {
                line.push_str(&trf!(" (Feiertag {h})", " (holiday {h})"));
            }
            if let Some(a) = &d.absence {
                line.push_str(&format!(" ({})", absence_label(a, d.absence_half)));
            }
            if d.future {
                line.push_str(tr!(" (steht noch an)", " (still ahead)"));
            }
            out.push_str(&line);
            out.push('\n');
        }
        if !tm.items.is_empty() {
            out.push_str(tr!("Nach Netzplan/Vorgang:\n", "By network/activity:\n"));
            for w in tm.items.iter().take(10) {
                let what =
                    if w.descriptions.is_empty() { String::new() } else { format!(": {}", w.descriptions.join("; ")) };
                out.push_str(&format!("- {} {} ({}){what}\n", w.label, hours(w.minutes), w.title));
            }
        }
        if tm.gaps > 0 {
            let (n, len) = (tm.gaps, hm(tm.gap_minutes));
            out.push_str(&trf!("Lücken ohne Buchung: {n} ({len})\n", "Gaps without a time entry: {n} ({len})\n"));
        }
    }
    if !r.meetings.is_empty() {
        out.push_str(tr!("Termine:\n", "Meetings:\n"));
        for m in r.meetings.iter().take(40) {
            let e = &m.meeting;
            let title =
                if e.private { tr!("(privater Termin)", "(private meeting)").to_owned() } else { e.title.clone() };
            let when = if e.all_day { tr!("ganztägig", "all day").to_owned() } else { t(e.start) };
            let state = match e.state.as_str() {
                "booked" => tr!("gebucht", "booked"),
                "open" => tr!("noch nicht gebucht", "not booked yet"),
                "skipped" => tr!("nicht zu buchen", "not to be booked"),
                "upcoming" => tr!("steht noch an", "still to come"),
                "done" => tr!("vorbei", "over"),
                _ => tr!("frei", "free"),
            };
            out.push_str(&format!("- {} {when} {title} ({state})\n", day_label(m.day)));
        }
    }
    if r.focus.sessions > 0 || !r.focus.blocks.is_empty() {
        let (n, len, planned) = (r.focus.sessions, hm(r.focus.minutes), hm(r.focus.planned_minutes));
        out.push_str(&trf!(
            "Fokus: {n} Sitzungen, {len}; geplante Fokusblöcke: {planned}\n",
            "Focus: {n} sessions, {len}; planned focus blocks: {planned}\n"
        ));
    }
    if !r.pages.is_empty() {
        out.push_str(tr!("Seiten:\n", "Pages:\n"));
        for p in r.pages.iter().take(25) {
            let verb = if p.created { tr!("angelegt", "created") } else { tr!("bearbeitet", "edited") };
            out.push_str(&format!("- {} ({verb}, {} min)\n", p.title, p.minutes));
        }
    }
    let list = |out: &mut String, head: &str, tasks: &[WeekTask], total: i64| {
        if tasks.is_empty() {
            return;
        }
        out.push_str(&format!("{head} ({total}):\n"));
        for task in tasks.iter().take(20) {
            let due = task.due.as_deref().map(|d| trf!(", fällig {d}", ", due {d}")).unwrap_or_default();
            let (text, page) = (&task.text, &task.page_title);
            out.push_str(&trf!("- {text} (Seite {page}{due})\n", "- {text} (page {page}{due})\n"));
        }
    };
    list(&mut out, tr!("Erledigte Aufgaben", "Tasks done"), &r.tasks.done, r.tasks.done_total);
    list(&mut out, tr!("Offen, diese Woche fällig", "Open, due this week"), &r.tasks.open, r.tasks.open_total);
    list(&mut out, tr!("Überfällig", "Overdue"), &r.tasks.overdue, r.tasks.overdue_total);
    if r.is_empty() {
        out.push_str(tr!("In dieser Woche wurde nichts aufgezeichnet.\n", "Nothing was recorded this week.\n"));
    }
    out
}

/// The request for the summary: 4–8 sentences in the display language and „Offen für nächste Woche“.
pub fn summary_messages<Tz: TimeZone>(r: &WeekReview, tz: &Tz) -> Vec<ChatMessage>
where
    Tz::Offset: std::fmt::Display,
{
    let with_time = tr!(
        "Du schreibst in Arcalo, einem Notiz- und Zeiterfassungsprogramm, den Wochenrückblick des Nutzers. \
        Fasse die Woche auf Deutsch in 4 bis 8 Sätzen zusammen: woran gearbeitet wurde, wie viel Zeit gegen das \
        Soll gebucht ist, welche Termine und Aufgaben wichtig waren. Sprich den Nutzer mit „du“ an, bleibe sachlich \
        und erfinde nichts, was nicht in den Daten steht. Schreibe danach eine Zeile „**Offen für nächste Woche:**“ \
        und darunter 1 bis 5 Stichpunkte (- …): fehlende Buchungen, offene und überfällige Aufgaben. Ist nichts \
        offen, schreibe „- Nichts Dringendes.“. Antworte nur mit dem Text in Markdown, ohne Überschrift.",
        "You write the user's weekly review in Arcalo, a notes and time tracking app. Summarize the week in English \
        in 4 to 8 sentences: what was worked on, how much time is booked against the target, which meetings and \
        tasks mattered. Address the user as “you”, stay factual and invent nothing that is not in the data. Then \
        write a line “**Open for next week:**” and below it 1 to 5 bullet points (- …): missing time entries, open \
        and overdue tasks. If nothing is open, write “- Nothing urgent.”. Answer with the text in Markdown only, \
        without a heading."
    );
    let without_time = tr!(
        "Du schreibst in Arcalo, einem Notizprogramm mit Kalender, den Wochenrückblick des Nutzers. Fasse die \
        Woche auf Deutsch in 4 bis 8 Sätzen zusammen: woran gearbeitet wurde, welche Termine und Aufgaben wichtig \
        waren. Sprich den Nutzer mit „du“ an, bleibe sachlich und erfinde nichts, was nicht in den Daten steht. \
        Schreibe danach eine Zeile „**Offen für nächste Woche:**“ und darunter 1 bis 5 Stichpunkte (- …) mit \
        offenen und überfälligen Aufgaben. Ist nichts offen, schreibe „- Nichts Dringendes.“. Antworte nur mit dem \
        Text in Markdown, ohne Überschrift.",
        "You write the user's weekly review in Arcalo, a notes app with a calendar. Summarize the week in English \
        in 4 to 8 sentences: what was worked on, which meetings and tasks mattered. Address the user as “you”, \
        stay factual and invent nothing that is not in the data. Then write a line “**Open for next week:**” and \
        below it 1 to 5 bullet points (- …) with open and overdue tasks. If nothing is open, write “- Nothing \
        urgent.”. Answer with the text in Markdown only, without a heading."
    );
    let system = if r.without_time { without_time } else { with_time };
    let data = describe(r, tz);
    vec![
        ChatMessage::system(system.to_owned()),
        ChatMessage::user(trf!("Daten der Woche:\n\n{data}", "The week's data:\n\n{data}")),
    ]
}

// ------------------------------------------------------------------- report

/// The summary as it goes into the page: checkboxes become plain bullets (the report must not
/// add tasks), headings bold lines.
pub fn clean_summary(text: &str) -> String {
    let lines: Vec<String> = text
        .replace('\r', "")
        .lines()
        .map(|l| {
            let t = l.trim_start();
            let indent = &l[..l.len() - t.len()];
            let t = ["- [ ] ", "- [x] ", "- [X] ", "* [ ] ", "* [x] "]
                .iter()
                .find_map(|p| t.strip_prefix(p).map(|rest| format!("- {rest}")))
                .unwrap_or_else(|| t.to_owned());
            let rest = t.trim_start_matches('#');
            let t =
                if rest.len() < t.len() && rest.starts_with(' ') { format!("**{}**", rest.trim()) } else { t.clone() };
            format!("{indent}{t}")
        })
        .collect();
    let mut out = lines.join("\n");
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out.trim().to_owned()
}

/// The generated part of the report (without its markers): the summary, time as tables, tasks
/// as lists (no checkboxes: the report adds no tasks), meetings by day, focus and the pages as
/// links.
pub fn report_markdown<Tz: TimeZone>(r: &WeekReview, tz: &Tz, summary: Option<&str>) -> String
where
    Tz::Offset: std::fmt::Display,
{
    let t = |at: DateTime<Utc>| at.with_timezone(tz).format("%H:%M").to_string();
    let mut out = String::new();
    let summary = summary.map(clean_summary).filter(|s| !s.is_empty());
    if let Some(s) = summary {
        out.push_str(tr!("## Zusammenfassung\n\n", "## Summary\n\n"));
        out.push_str(&s);
        out.push_str("\n\n");
    }

    if !r.without_time {
        let tm = &r.time;
        out.push_str(tr!("## Zeit\n\n", "## Time\n\n"));
        out.push_str(tr!(
            "| Tag | Gebucht | Soll | Differenz |\n| --- | ---: | ---: | ---: |\n",
            "| Day | Booked | Target | Difference |\n| --- | ---: | ---: | ---: |\n"
        ));
        for d in &r.days {
            let mut label = day_label(d.date);
            if let Some(h) = &d.holiday {
                label.push_str(&format!(" ({})", inline(h)));
            } else if let Some(a) = &d.absence {
                label.push_str(&format!(" ({})", absence_label(a, d.absence_half)));
            }
            let diff = if d.future { String::new() } else { signed_hours(d.booked_minutes - d.target_minutes) };
            out.push_str(&format!(
                "| {label} | {} | {} | {diff} |\n",
                hours(d.booked_minutes),
                hours(d.target_minutes)
            ));
        }
        let week = tr!("Woche", "Week");
        out.push_str(&format!(
            "| **{week}** | **{}** | **{}** | **{}** |\n\n",
            hours(tm.booked_minutes),
            hours(tm.target_minutes),
            signed_hours(tm.booked_minutes - tm.target_to_date)
        ));
        // Days below their target (the difference above nets them against overtime).
        let short: Vec<String> = r
            .days
            .iter()
            .filter(|d| d.missing_minutes > 0)
            .map(|d| format!("{} ({})", day_label(d.date), hours(d.missing_minutes)))
            .collect();
        if !short.is_empty() {
            out.push_str(&format!("**{}** {}\n\n", tr!("Unter dem Soll:", "Below the target:"), short.join(", ")));
        }
        if tm.gaps > 0 {
            let gaps: Vec<String> = r
                .days
                .iter()
                .flat_map(|d| d.gaps.iter().map(move |g| (d.date, g)))
                .map(|(day, g)| format!("{} {}–{}", day_label(day), t(g.start), t(g.end)))
                .collect();
            out.push_str(&format!(
                "**{}** {}\n\n",
                tr!("Lücken ohne Buchung:", "Gaps without a time entry:"),
                gaps.join(", ")
            ));
        }
        if !tm.items.is_empty() {
            out.push_str(tr!(
                "| Netzplan/Vorgang | Beschreibung | Stunden |\n| --- | --- | ---: |\n",
                "| Network/activity | Description | Hours |\n| --- | --- | ---: |\n"
            ));
            for w in &tm.items {
                out.push_str(&format!("| {} | {} | {} |\n", w.label, inline(&w.title), hours(w.minutes)));
            }
            out.push('\n');
        }
    }

    let k = &r.tasks;
    out.push_str(tr!("## Aufgaben\n\n", "## Tasks\n\n"));
    if k.done_total == 0 && k.open_total == 0 && k.overdue_total == 0 {
        out.push_str(tr!("Keine Aufgaben in dieser Woche.\n\n", "No tasks this week.\n\n"));
    }
    let list = |out: &mut String, head: String, tasks: &[WeekTask], total: i64, done: bool| {
        if tasks.is_empty() {
            return;
        }
        out.push_str(&format!("**{head} ({total})**\n\n"));
        for task in tasks {
            let mut line = format!("- {}", inline(&task.text));
            if done && let Some(d) = task.day {
                line.push_str(&format!(" ({})", day_label(d)));
            }
            if let Some(due) = task.due.as_deref().and_then(|d| d.parse::<NaiveDate>().ok()) {
                let due = day_label(due);
                line.push_str(&trf!(" (fällig {due})", " (due {due})"));
            }
            if !task.page_title.trim().is_empty() {
                line.push_str(&format!(" – {}", page_ref(&task.page_title, task.page_id.is_none())));
            }
            out.push_str(&line);
            out.push('\n');
        }
        if (tasks.len() as i64) < total {
            let more = total - tasks.len() as i64;
            out.push_str(&trf!("- … und {more} weitere\n", "- … and {more} more\n"));
        }
        out.push('\n');
    };
    list(&mut out, tr!("Erledigt", "Done").to_owned(), &k.done, k.done_total, true);
    list(&mut out, tr!("Offen, diese Woche fällig", "Open, due this week").to_owned(), &k.open, k.open_total, false);
    list(&mut out, tr!("Überfällig", "Overdue").to_owned(), &k.overdue, k.overdue_total, false);

    out.push_str(tr!("## Termine\n\n", "## Meetings\n\n"));
    if r.meetings.is_empty() {
        out.push_str(tr!("Keine Termine in dieser Woche.\n\n", "No meetings this week.\n\n"));
    }
    let mut day: Option<NaiveDate> = None;
    for m in &r.meetings {
        if day != Some(m.day) {
            if day.is_some() {
                out.push('\n');
            }
            out.push_str(&format!("**{}**\n\n", day_label(m.day)));
            day = Some(m.day);
        }
        let e = &m.meeting;
        let when =
            if e.all_day { tr!("ganztägig", "all day").to_owned() } else { format!("{}–{}", t(e.start), t(e.end)) };
        let title = if e.title.trim().is_empty() { tr!("Termin", "Meeting").to_owned() } else { inline(&e.title) };
        let state = match e.state.as_str() {
            "booked" => tr!(" (gebucht)", " (booked)"),
            "open" => tr!(" (nicht gebucht)", " (not booked)"),
            "skipped" => tr!(" (nicht buchen)", " (not to book)"),
            "upcoming" => tr!(" (steht an)", " (upcoming)"),
            _ => "",
        };
        out.push_str(&format!("- {when} {title}{state}\n"));
    }
    if day.is_some() {
        out.push('\n');
    }

    let f = &r.focus;
    if f.sessions > 0 || !f.blocks.is_empty() {
        out.push_str(tr!("## Fokus\n\n", "## Focus\n\n"));
        if f.sessions > 0 {
            let (n, len) = (f.sessions, hm(f.minutes));
            out.push_str(&trf!("- Fokussitzungen: {n}, {len}\n", "- Focus sessions: {n}, {len}\n"));
        }
        for b in &f.blocks {
            let day = day_label(b.start.with_timezone(tz).date_naive());
            let mut line = format!("- {day} {}–{} {}", t(b.start), t(b.end), inline(&b.title));
            if b.task_done == Some(true) {
                line.push_str(tr!(" (erledigt)", " (done)"));
            } else if b.booked {
                line.push_str(tr!(" (gebucht)", " (booked)"));
            }
            out.push_str(&line);
            out.push('\n');
        }
        out.push('\n');
    }

    out.push_str(tr!("## Seiten\n\n", "## Pages\n\n"));
    let pages: Vec<&WeekPage> = r.pages.iter().filter(|p| !p.daily).collect();
    if pages.is_empty() {
        out.push_str(tr!("Keine Seiten bearbeitet.\n", "No pages worked on.\n"));
    }
    for p in &pages {
        let mut bits = vec![];
        if p.created {
            bits.push(tr!("neu", "new").to_owned());
        }
        if p.edits > 0 {
            let n = p.edits;
            bits.push(if n == 1 {
                tr!("1 Änderung", "1 change").to_owned()
            } else {
                trf!("{n} Änderungen", "{n} changes")
            });
        }
        let bits = if bits.is_empty() { String::new() } else { format!(" ({})", bits.join(", ")) };
        out.push_str(&format!("- {}{bits}\n", page_ref(&p.title, p.gone)));
    }
    let more = r.pages_total - r.pages.len() as i64;
    if more > 0 {
        out.push_str(&trf!("- … und {more} weitere\n", "- … and {more} more\n"));
    }
    out.trim_end().to_owned()
}

/// The template a new report starts from: `{{rückblick}}` (or `{{review}}`) is where the
/// generated part goes, `{{zeitraum}}` (`{{range}}`) the week's dates, `{{kw}}` its number.
pub fn default_template() -> &'static str {
    tr!(
        "KW {{kw}} · {{zeitraum}}\n\n{{rückblick}}\n\n## Notizen\n\n\n\n## Nächste Woche\n\n- \n",
        "Week {{week}} · {{range}}\n\n{{review}}\n\n## Notes\n\n\n\n## Next week\n\n- \n"
    )
}

/// `template` filled in for the week of `monday` with the generated part `body`. Without a
/// `{{rückblick}}` placeholder the part goes below the template's first heading (or first).
pub fn fill_template(template: &str, monday: NaiveDate, now: NaiveTime, body: &str) -> String {
    let vars = TemplateVars { date: monday, time: now, title: report_title(monday) };
    let range = range_label(monday);
    let mut out = apply_template(template, &vars);
    for key in ["zeitraum", "range"] {
        out = replace_placeholder(&out, key, &range);
    }
    let block = block::wrap(body);
    let mut placed = false;
    for key in ["rückblick", "review", "bericht", "report"] {
        let next = replace_placeholder(&out, key, &block);
        placed |= next != out;
        out = next;
    }
    if placed { out } else { block::replace(&out, body) }
}

/// `{{key}}` (any case, inner spaces) replaced by `value`.
fn replace_placeholder(text: &str, key: &str, value: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) if after[..end].trim().to_lowercase() == key => {
                out.push_str(value);
                rest = &after[end + 2..];
            }
            _ => {
                out.push_str("{{");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

impl Database {
    /// The saved report of the week starting `monday`: the page written for it (while it
    /// exists), else a page with its title in either language.
    pub fn week_report_page(&self, monday: NaiveDate) -> Result<Option<Page>> {
        let key = format!("{PAGE_KEY}{monday}");
        if let Some(id) = self.meta_get(&key)?.and_then(|v| v.parse::<i64>().ok()) {
            let alive: Option<i64> = self
                .conn()
                .query_row("SELECT id FROM pages WHERE id = ?1 AND deleted_at IS NULL", [id], |r| r.get(0))
                .optional()?;
            if alive.is_some() {
                return Ok(Some(self.page(id)?));
            }
        }
        for title in report_titles(monday) {
            if let Some(p) = self.page_by_title(&title)? {
                return Ok(Some(p));
            }
        }
        Ok(None)
    }

    /// The template „Wochenbericht“ (or „Weekly report“) in „Vorlagen“, if there is one.
    pub fn week_report_template(&self) -> Result<Option<Page>> {
        Ok(self
            .list_templates()?
            .into_iter()
            .find(|p| TEMPLATE_NAMES.iter().any(|name| p.title.eq_ignore_ascii_case(name))))
    }

    /// The template „Wochenbericht“, created in „Vorlagen“ with [`default_template`] when missing.
    pub fn week_report_template_ensure(&self) -> Result<Page> {
        if let Some(p) = self.week_report_template()? {
            return Ok(p);
        }
        self.atomic(|| {
            let root = self.templates_root()?;
            let page = self.create_page(Some(root.id), tr!(TEMPLATE_NAMES[0], TEMPLATE_NAMES[1]), Some(ICON))?;
            self.save_page_content(page.id, default_template())?;
            self.page(page.id)
        })
    }

    /// Writes the report of the week starting `monday` with the generated part `body`: the
    /// existing report gets only that part replaced; a new one starts from the template and is
    /// filed like a journal page of the week's Thursday. Returns the page and whether it was
    /// created.
    pub fn week_report_write(&self, monday: NaiveDate, body: &str, now: NaiveTime) -> Result<(Page, bool)> {
        let monday = monday_of(monday);
        self.atomic(|| {
            let key = format!("{PAGE_KEY}{monday}");
            if let Some(p) = self.week_report_page(monday)? {
                let doc = self.page_doc(p.id)?;
                let next = block::replace(&doc.content, body);
                if next != doc.content {
                    self.save_page_content(p.id, &next)?;
                }
                self.meta_set(&key, &p.id.to_string())?;
                return Ok((self.page(p.id)?, false));
            }
            let template = match self.week_report_template()? {
                Some(t) => crate::templates::strip_frontmatter(&self.page_doc(t.id)?.content).to_owned(),
                None => default_template().to_owned(),
            };
            let content = fill_template(&template, monday, now, body);
            let base = crate::notes::clean_title(&report_title(monday));
            let mut title = base.clone();
            let mut n = 2;
            while self.page_by_title(&title)?.is_some() {
                title = format!("{base} {n}");
                n += 1;
            }
            let page = self.create_page(None, &title, Some(ICON))?;
            self.save_page_content(page.id, &content)?;
            // The year/month folder of the week (its Thursday decides, as for the week number).
            let date = monday + Duration::days(3);
            self.file_page(page.id, &FileInfo { kind: FileType::Journal, date, group: None })?;
            self.meta_set(&key, &page.id.to_string())?;
            Ok((self.page(page.id)?, true))
        })
    }
}

#[cfg(test)]
mod tests;
