//! Parts of the work and chart widgets (1.7): overtime balance, vacation, deadlines, team
//! availability, charts over a page's table or the bookings, the activity heatmap and the
//! Kanban mini-board. Everything is aggregated here, in SQL where it can be, so the UI only
//! draws.
//!
//! Deadlines come from providers ([`DEADLINE_PROVIDERS`]): the open tasks with a due date and
//! the date properties of pages. Another source (Jira due dates) adds one function of type
//! [`DeadlineProvider`] to that list; the widget shows whatever the providers return, sorted
//! by date, and its settings can switch each provider off by its name.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::Ctx;
use crate::calsync::Busy;
use crate::db::Database;
use crate::error::{Error, Result};
use crate::properties::{CollectionViewRow, PropKind, Schema, Typed};
use crate::tasks::{TaskFilter, TaskStatus};
use crate::worktime;

/// Longest chart range over the bookings (weeks).
const MAX_CHART_WEEKS: u32 = 104;
/// Most bars or slices; the rest is summed up as `__other`.
const MAX_GROUPS: usize = 12;
/// Longest heatmap (days).
const MAX_HEATMAP_DAYS: i64 = 400;
/// How far the team widget looks ahead for the next change.
const TEAM_DAYS: i64 = 7;

/// The parts of the work and chart widgets (`kind` as in [`super::Part`]).
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkPart {
    /// „Gleitzeitsaldo“ with `weeks` points for the sparkline.
    Balance {
        #[serde(default = "twelve")]
        weeks: usize,
    },
    /// „Urlaub“: the vacation account of this year and the next holiday.
    Vacation,
    /// „Fristen“: due dates of the next `days` days and what is overdue.
    Deadlines {
        #[serde(default = "fourteen")]
        days: u32,
        /// Providers switched off (by name).
        #[serde(default)]
        off: Vec<String>,
    },
    /// „Team“: who of the chosen calendars is free, busy or away now (all shared ones without).
    Team {
        #[serde(default)]
        sources: Vec<String>,
    },
    /// „Diagramm“.
    Chart { chart: ChartQuery },
    /// „Aktivitäts-Heatmap“: notes edited or hours booked per day.
    Heatmap { mode: HeatMode, from: NaiveDate, to: NaiveDate },
    /// „Kanban“: a page's children grouped like its board view.
    Kanban { page: i64 },
}

fn twelve() -> usize {
    12
}
fn fourteen() -> u32 {
    14
}

/// The data of one work part.
pub fn part<Tz: TimeZone>(ctx: &Ctx<Tz>, p: &WorkPart) -> Result<serde_json::Value> {
    let json = |v: serde_json::Result<serde_json::Value>| -> Result<serde_json::Value> { Ok(v?) };
    let time = || ctx.settings.require_time_tracking();
    match p {
        WorkPart::Balance { weeks } => {
            time()?;
            json(serde_json::to_value(worktime::balance(
                ctx.db,
                ctx.settings,
                ctx.tz,
                ctx.today,
                ctx.now,
                (*weeks).clamp(2, 52),
            )?))
        }
        WorkPart::Vacation => {
            time()?;
            json(serde_json::to_value(worktime::vacation(ctx.db, ctx.settings, ctx.today)?))
        }
        WorkPart::Deadlines { days, off } => json(serde_json::to_value(deadlines(ctx.db, ctx.today, *days, off)?)),
        WorkPart::Team { sources } => json(serde_json::to_value(team(ctx, sources)?)),
        WorkPart::Chart { chart } => {
            if chart.source == ChartSource::Bookings {
                time()?;
            }
            json(serde_json::to_value(run_chart(ctx, chart)?))
        }
        WorkPart::Heatmap { mode, from, to } => {
            if *mode == HeatMode::Hours {
                time()?;
            }
            json(serde_json::to_value(heatmap(ctx, *mode, *from, *to)?))
        }
        WorkPart::Kanban { page } => json(serde_json::to_value(kanban(ctx.db, *page)?)),
    }
}

// ------------------------------------------------------------------ deadlines

/// One due date.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Deadline {
    /// Unique within its provider (`task:12:3`, `prop:40:fällig`, `jira:ABC-12`).
    pub key: String,
    /// The provider's name.
    pub source: String,
    pub title: String,
    /// Page, property or project it belongs to.
    pub detail: String,
    pub date: NaiveDate,
    pub page_id: Option<i64>,
    /// Task ordinal on the page (tasks only).
    pub ordinal: Option<i64>,
    /// Where it opens outside Annalo (Jira).
    pub url: Option<String>,
    /// 0 none, 1 medium, 2 high.
    pub priority: u8,
}

/// The days a provider is asked about: everything due up to `until`; open items before `today`
/// are overdue (tasks: every open one; dated pages: the last [`OVERDUE_DAYS`] days).
#[derive(Debug, Clone, Copy)]
pub struct DeadlineWindow {
    pub today: NaiveDate,
    pub until: NaiveDate,
}

/// How far back a page's date counts as overdue.
pub const OVERDUE_DAYS: i64 = 14;

/// A source of due dates.
pub type DeadlineProvider = fn(&Database, &DeadlineWindow) -> Result<Vec<Deadline>>;

/// Every source of due dates, by name. Add a provider here (Jira: `("jira", jira_deadlines)`).
pub const DEADLINE_PROVIDERS: &[(&str, DeadlineProvider)] =
    &[("tasks", task_deadlines), ("properties", property_deadlines)];

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DeadlinesData {
    pub today: NaiveDate,
    pub until: NaiveDate,
    pub items: Vec<Deadline>,
    /// Providers that failed (name and message); the others still show.
    pub errors: Vec<(String, String)>,
}

/// The due dates of the next `days` days and the overdue ones, by date, at most 100.
pub fn deadlines(db: &Database, today: NaiveDate, days: u32, off: &[String]) -> Result<DeadlinesData> {
    let w = DeadlineWindow { today, until: today + Duration::days(days.clamp(1, 366) as i64) };
    let mut items = vec![];
    let mut errors = vec![];
    for (name, provider) in DEADLINE_PROVIDERS {
        if off.iter().any(|o| o == name) {
            continue;
        }
        match provider(db, &w) {
            Ok(list) => items.extend(list.into_iter().filter(|d| d.date <= w.until)),
            Err(e) => errors.push((name.to_string(), e.to_string())),
        }
    }
    items.sort_by(|a, b| a.date.cmp(&b.date).then(b.priority.cmp(&a.priority)).then_with(|| a.title.cmp(&b.title)));
    items.truncate(100);
    Ok(DeadlinesData { today, until: w.until, items, errors })
}

/// Open tasks due up to the end of the window (overdue ones included).
pub fn task_deadlines(db: &Database, w: &DeadlineWindow) -> Result<Vec<Deadline>> {
    let list = db.list_tasks(&TaskFilter {
        status: TaskStatus::Open,
        due_before: Some(w.until.format("%Y-%m-%d").to_string()),
        ..Default::default()
    })?;
    Ok(list
        .into_iter()
        .filter_map(|t| {
            let date = t.due.as_deref()?.parse::<NaiveDate>().ok()?;
            Some(Deadline {
                key: format!("task:{}:{}", t.page_id, t.ordinal),
                source: "tasks".into(),
                title: t.text,
                detail: t.page_title,
                date,
                page_id: Some(t.page_id),
                ordinal: Some(t.ordinal),
                url: None,
                priority: t.priority,
            })
        })
        .collect())
}

/// Select values (and checkboxes) that mark a page as finished: its dates are no deadlines.
const DONE_VALUES: [&str; 8] =
    ["fertig", "erledigt", "abgeschlossen", "geschlossen", "done", "closed", "completed", "finished"];

/// Date properties of pages below a page with a schema; pages marked done are left out.
pub fn property_deadlines(db: &Database, w: &DeadlineWindow) -> Result<Vec<Deadline>> {
    let from = w.today - Duration::days(OVERDUE_DAYS);
    let mut out = vec![];
    for (parent_id, parent_title, schema) in schema_parents(db)? {
        let dates: Vec<String> =
            schema.props.iter().filter(|p| p.kind == PropKind::Date).map(|p| p.key.to_lowercase()).collect();
        if dates.is_empty() {
            continue;
        }
        for row in db.page_collection(parent_id)?.rows {
            let done = row.cells.iter().any(|c| match &c.value {
                Some(Typed::Checkbox(true)) => {
                    let k = c.key.to_lowercase();
                    k.contains("erledigt") || k.contains("done") || k.contains("fertig")
                }
                Some(Typed::Select(v)) => DONE_VALUES.contains(&v.trim().to_lowercase().as_str()),
                _ => false,
            });
            if done {
                continue;
            }
            for c in &row.cells {
                let Some(Typed::Date(d)) = &c.value else { continue };
                if !dates.contains(&c.key.to_lowercase()) {
                    continue;
                }
                let Ok(date) = d.parse::<NaiveDate>() else { continue };
                if date < from || date > w.until {
                    continue;
                }
                out.push(Deadline {
                    key: format!("prop:{}:{}", row.page.id, c.key),
                    source: "properties".into(),
                    title: row.page.title.clone(),
                    detail: format!("{parent_title} · {}", c.key),
                    date,
                    page_id: Some(row.page.id),
                    ordinal: None,
                    url: None,
                    priority: 0,
                });
            }
        }
    }
    Ok(out)
}

/// Pages that define a schema for their children: id, title and schema.
fn schema_parents(db: &Database) -> Result<Vec<(i64, String, Schema)>> {
    let mut st = db.conn().prepare_cached(
        "SELECT id, title, content FROM pages WHERE deleted_at IS NULL AND substr(content, 1, 3) = '---'
         AND (instr(content, ?1) > 0 OR instr(content, 'properties') > 0)",
    )?;
    let rows = st.query_map([crate::properties::SCHEMA_KEY], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
    })?;
    let mut out = vec![];
    for row in rows {
        let (id, title, content) = row?;
        if let Some(s) = Schema::from_markdown(&content) {
            out.push((id, title, s));
        }
    }
    Ok(out)
}

// ------------------------------------------------------------------ team

/// What someone's calendar says about a moment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Presence {
    Free,
    Tentative,
    Elsewhere,
    Busy,
    Oof,
}

impl From<Busy> for Presence {
    fn from(b: Busy) -> Self {
        match b {
            Busy::Free => Presence::Free,
            Busy::Tentative => Presence::Tentative,
            Busy::Busy => Presence::Busy,
            Busy::Oof => Presence::Oof,
            Busy::Elsewhere => Presence::Elsewhere,
        }
    }
}

/// One appointment as the availability sees it.
#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub presence: Presence,
    pub title: String,
}

/// Someone's availability now: the state, until when it lasts and what comes next.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Availability {
    pub state: Presence,
    /// When the current state ends (`None`: not within the window).
    pub until: Option<DateTime<Utc>>,
    /// The next state and when it begins.
    pub next: Option<Presence>,
    /// The appointment behind the current state (empty when free or unknown).
    pub title: String,
}

/// The strongest state at `t` (out of office before busy before elsewhere before tentative).
fn presence_at(slots: &[Slot], t: DateTime<Utc>) -> Option<&Slot> {
    slots.iter().filter(|s| s.start <= t && t < s.end && s.presence != Presence::Free).max_by_key(|s| s.presence)
}

/// Availability at `now` from the appointments of one calendar.
pub fn availability(slots: &[Slot], now: DateTime<Utc>) -> Availability {
    let current = presence_at(slots, now);
    let state = current.map_or(Presence::Free, |s| s.presence);
    let mut points: Vec<DateTime<Utc>> = slots.iter().flat_map(|s| [s.start, s.end]).filter(|t| *t > now).collect();
    points.sort();
    points.dedup();
    let change = points.into_iter().find_map(|t| {
        let p = presence_at(slots, t).map_or(Presence::Free, |s| s.presence);
        (p != state).then_some((t, p))
    });
    Availability {
        state,
        until: change.map(|c| c.0),
        next: change.map(|c| c.1),
        title: current.map(|s| s.title.clone()).unwrap_or_default(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TeamMember {
    pub source: String,
    pub name: String,
    pub color: String,
    pub free_busy: bool,
    #[serde(flatten)]
    pub availability: Availability,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TeamData {
    pub members: Vec<TeamMember>,
    /// Shared calendars that could be chosen (source, name).
    pub available: Vec<(String, String)>,
}

/// The availability of the chosen shared calendars (all synced shared ones without a choice).
pub fn team<Tz: TimeZone>(ctx: &Ctx<Tz>, chosen: &[String]) -> Result<TeamData> {
    let cal = &ctx.settings.calendar;
    let shared: Vec<_> =
        cal.outlook_calendars.iter().filter(|c| c.kind.shared() && ctx.sources.contains(&c.id)).collect();
    let available: Vec<(String, String)> =
        shared.iter().map(|c| (c.id.clone(), if c.owner.is_empty() { c.label() } else { c.owner.clone() })).collect();
    let picked: Vec<_> = shared.iter().filter(|c| chosen.is_empty() || chosen.contains(&c.id)).collect();
    if picked.is_empty() {
        return Ok(TeamData { members: vec![], available });
    }
    let ids: Vec<String> = picked.iter().map(|c| c.id.clone()).collect();
    let from = ctx.now - Duration::days(1);
    let to = ctx.now + Duration::days(TEAM_DAYS);
    let events = ctx.db.calendar_events(from, to, &ids)?;
    let mut by_source: HashMap<&str, Vec<Slot>> = HashMap::new();
    for e in &events {
        let slot = Slot {
            start: e.event.start,
            end: e.event.end,
            presence: e.event.busy.into(),
            title: if crate::calsync::is_private_title(&e.event.title) { String::new() } else { e.event.title.clone() },
        };
        // A meeting several of them attend is stored once, with the others in `also_in`.
        for s in std::iter::once(&e.source).chain(e.also_in.iter()) {
            by_source.entry(s.as_str()).or_default().push(slot.clone());
        }
    }
    let members = picked
        .iter()
        .map(|c| {
            let slots = by_source.get(c.id.as_str()).map(Vec::as_slice).unwrap_or(&[]);
            let mut availability = availability(slots, ctx.now);
            if c.free_busy {
                availability.title.clear();
            }
            TeamMember {
                source: c.id.clone(),
                name: if c.owner.is_empty() { c.label() } else { c.owner.clone() },
                color: c.color.clone(),
                free_busy: c.free_busy,
                availability,
            }
        })
        .collect();
    Ok(TeamData { members, available })
}

// ------------------------------------------------------------------ charts

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChartSource {
    /// The child pages of a page (its table or board).
    #[default]
    Pages,
    Bookings,
}

/// What a chart shows.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChartQuery {
    pub source: ChartSource,
    /// Pages: the parent page.
    pub page: Option<i64>,
    /// Pages: a property key. Bookings: `netzplan`, `vorgang`, `activity`, `week` or `month`.
    pub group: String,
    /// `count` (pages) or `sum` (of the number property `field`; bookings always sum hours).
    pub value: String,
    pub field: String,
    /// Bookings: how many weeks back from today.
    pub weeks: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChartPoint {
    /// `""` for pages without a value, `__other` for the rest beyond the largest groups.
    pub label: String,
    /// Description (Netzplan, Leistungsart).
    pub detail: String,
    pub value: f64,
    /// Color name of a select option.
    pub color: Option<String>,
    /// First day of the week or month of a time group.
    pub date: Option<NaiveDate>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ChartData {
    /// `count`, `number` or `minutes`.
    pub unit: String,
    pub points: Vec<ChartPoint>,
    pub total: f64,
    /// The groups are in a fixed order (options, time): no sorting by size.
    pub ordered: bool,
}

fn point(label: impl Into<String>, value: f64) -> ChartPoint {
    ChartPoint { label: label.into(), detail: String::new(), value, color: None, date: None }
}

/// The largest `MAX_GROUPS - 1` groups and the rest as `__other` (unless in a fixed order).
fn cap(mut points: Vec<ChartPoint>, ordered: bool) -> Vec<ChartPoint> {
    if !ordered {
        points.sort_by(|a, b| b.value.total_cmp(&a.value).then_with(|| a.label.cmp(&b.label)));
    }
    if points.len() <= MAX_GROUPS || ordered {
        return points;
    }
    let rest: f64 = points[MAX_GROUPS - 1..].iter().map(|p| p.value).sum();
    points.truncate(MAX_GROUPS - 1);
    points.push(point("__other", rest));
    points
}

pub fn run_chart<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &ChartQuery) -> Result<ChartData> {
    match q.source {
        ChartSource::Pages => pages_chart(ctx.db, q),
        ChartSource::Bookings => bookings_chart(ctx, q),
    }
}

/// The child pages of `q.page` grouped by a property: counted, or a number property summed.
pub fn pages_chart(db: &Database, q: &ChartQuery) -> Result<ChartData> {
    let Some(page) = q.page else {
        return Ok(ChartData { unit: "count".into(), points: vec![], total: 0.0, ordered: false });
    };
    let coll = db.page_collection(page)?;
    let key = q.group.trim().to_lowercase();
    let def = coll.schema.as_ref().and_then(|s| s.props.iter().find(|p| p.key.to_lowercase() == key));
    let multi = def.is_some_and(|d| d.kind == PropKind::MultiSelect);
    let sum = q.value == "sum" && !q.field.trim().is_empty();
    let field = q.field.trim().to_lowercase();
    let mut acc: BTreeMap<String, f64> = BTreeMap::new();
    let mut total = 0.0;
    for row in &coll.rows {
        let v = if sum {
            match row.cells.iter().find(|c| c.key.to_lowercase() == field).and_then(|c| c.value.as_ref()) {
                Some(Typed::Number(n)) => *n,
                _ => 0.0,
            }
        } else {
            1.0
        };
        let cell = row.cells.iter().find(|c| c.key.to_lowercase() == key);
        let labels: Vec<String> = match cell.and_then(|c| c.value.as_ref()) {
            Some(Typed::MultiSelect(list)) if !list.is_empty() => list.clone(),
            Some(Typed::Checkbox(b)) => vec![if *b { "__yes" } else { "__no" }.into()],
            // Dates by month.
            Some(Typed::Date(d)) => vec![d.get(..7).unwrap_or(d).to_owned()],
            // A list with values that are no option yet: by its text.
            _ if multi => {
                let text = cell.map(|c| c.text.as_str()).unwrap_or("");
                let list: Vec<String> =
                    text.split(',').map(|x| x.trim().to_owned()).filter(|x| !x.is_empty()).collect();
                if list.is_empty() { vec![String::new()] } else { list }
            }
            _ => vec![cell.map(|c| c.text.trim().to_owned()).unwrap_or_default()],
        };
        for l in labels {
            *acc.entry(l).or_default() += v;
        }
        total += v;
    }
    let unit = if sum { "number" } else { "count" };
    // A select keeps the order (and colors) of its options; dates go by month.
    let (points, ordered) = match def {
        Some(d) if matches!(d.kind, PropKind::Select | PropKind::MultiSelect) => {
            let mut pts: Vec<ChartPoint> = d
                .options
                .iter()
                .map(|o| ChartPoint {
                    color: Some(o.color.clone()),
                    ..point(o.name.clone(), acc.remove(&o.name).unwrap_or(0.0))
                })
                .collect();
            let mut rest: Vec<ChartPoint> = acc.into_iter().map(|(l, v)| point(l, v)).collect();
            rest.sort_by(|a, b| b.value.total_cmp(&a.value));
            pts.extend(rest);
            pts.truncate(MAX_GROUPS);
            (pts, true)
        }
        Some(d) if d.kind == PropKind::Date => (acc.into_iter().map(|(l, v)| point(l, v)).collect(), true),
        _ => (cap(acc.into_iter().map(|(l, v)| point(l, v)).collect(), false), false),
    };
    Ok(ChartData { unit: unit.into(), points, total, ordered })
}

/// Booked minutes of the last `q.weeks` weeks grouped by Netzplan, Vorgang, Leistungsart, week
/// or month (in SQL; time groups from the per-day sums, with empty weeks as zero).
pub fn bookings_chart<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &ChartQuery) -> Result<ChartData> {
    let weeks = q.weeks.clamp(1, MAX_CHART_WEEKS) as i64;
    let monday = ctx.today - Duration::days(ctx.today.weekday().num_days_from_monday() as i64);
    let first = monday - Duration::weeks(weeks - 1);
    let from = crate::feed::day_start(first, ctx.tz);
    let to = crate::feed::day_start(ctx.today + Duration::days(1), ctx.tz);
    let minutes = |points: &[ChartPoint]| points.iter().map(|p| p.value).sum::<f64>();
    let time = |month: bool| -> Result<ChartData> {
        let days = worktime::booked_by_day(ctx.db, ctx.tz, first, ctx.today, ctx.now)?;
        let mut acc: BTreeMap<NaiveDate, f64> = BTreeMap::new();
        let bucket = |d: NaiveDate| {
            if month {
                d.with_day(1).unwrap_or(d)
            } else {
                d - Duration::days(d.weekday().num_days_from_monday() as i64)
            }
        };
        let mut d = first;
        while d <= ctx.today {
            acc.entry(bucket(d)).or_default();
            d += Duration::days(1);
        }
        for (d, m) in days {
            *acc.entry(bucket(d)).or_default() += m as f64;
        }
        let points: Vec<ChartPoint> =
            acc.into_iter().map(|(d, v)| ChartPoint { date: Some(d), ..point(d.to_string(), v) }).collect();
        Ok(ChartData { unit: "minutes".into(), total: minutes(&points), points, ordered: true })
    };
    let sql = match q.group.as_str() {
        "week" => return time(false),
        "month" => return time(true),
        "activity" => {
            "SELECT COALESCE(e.leistungsart, ''), COALESCE(MAX(l.description), ''), SUM(e.duration_minutes)
             FROM time_entries e LEFT JOIN leistungsarten l ON l.code = e.leistungsart
             WHERE e.status_flag <> 'running' AND e.start_time >= ?1 AND e.start_time < ?2
             GROUP BY 1"
        }
        "vorgang" => {
            "SELECT n.netzplan_nr || CASE WHEN COALESCE(e.vorgang_nr, '') = '' THEN '' ELSE '/' || e.vorgang_nr END,
                    COALESCE(MAX(NULLIF(v.description, '')), MAX(n.description)), SUM(e.duration_minutes)
             FROM time_entries e JOIN netzplaene n ON n.id = e.netzplan_id
             LEFT JOIN vorgaenge v ON v.netzplan_id = e.netzplan_id AND lower(v.vorgang_nr) = lower(e.vorgang_nr)
             WHERE e.status_flag <> 'running' AND e.start_time >= ?1 AND e.start_time < ?2
             GROUP BY 1"
        }
        _ => {
            "SELECT n.netzplan_nr, MAX(n.description), SUM(e.duration_minutes)
             FROM time_entries e JOIN netzplaene n ON n.id = e.netzplan_id
             WHERE e.status_flag <> 'running' AND e.start_time >= ?1 AND e.start_time < ?2
             GROUP BY n.id"
        }
    };
    let mut st = ctx.db.conn().prepare_cached(sql)?;
    let rows = st.query_map(params![crate::db::ts(from), crate::db::ts(to)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0)))
    })?;
    let mut points = vec![];
    for row in rows {
        let (label, detail, m) = row?;
        if m > 0 {
            points.push(ChartPoint { detail, ..point(label, m as f64) });
        }
    }
    let points = cap(points, false);
    Ok(ChartData { unit: "minutes".into(), total: minutes(&points), points, ordered: false })
}

// ------------------------------------------------------------------ heatmap

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeatMode {
    /// Distinct pages edited or created per day.
    Notes,
    /// Booked minutes per day.
    Hours,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct HeatmapData {
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// Days with a value (others are 0), by date.
    pub days: Vec<(NaiveDate, i64)>,
    pub max: i64,
    pub total: i64,
    /// Days with a value.
    pub active: usize,
}

pub fn heatmap<Tz: TimeZone>(ctx: &Ctx<Tz>, mode: HeatMode, from: NaiveDate, to: NaiveDate) -> Result<HeatmapData> {
    if to < from || (to - from).num_days() > MAX_HEATMAP_DAYS {
        return Err(Error::State(
            crate::tr!("Der Zeitraum der Heatmap ist zu lang", "The heatmap's range is too long").into(),
        ));
    }
    let days: BTreeMap<NaiveDate, i64> = match mode {
        HeatMode::Hours => worktime::booked_by_day(ctx.db, ctx.tz, from, to, ctx.now)?,
        HeatMode::Notes => {
            // Edits are merged per page and hour in the journal: one row per page and hour.
            let mut st = ctx.db.conn().prepare_cached(
                "SELECT at, page_id FROM activity
                 WHERE kind IN ('page_edited', 'page_created') AND page_id IS NOT NULL AND at >= ?1 AND at < ?2",
            )?;
            let a = crate::db::ts(crate::feed::day_start(from, ctx.tz));
            let b = crate::db::ts(crate::feed::day_start(to + Duration::days(1), ctx.tz));
            let mut seen: HashSet<(NaiveDate, i64)> = HashSet::new();
            for row in st.query_map(params![a, b], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                let (at, page) = row?;
                if let Ok(t) = crate::db::parse_ts(&at) {
                    seen.insert((t.with_timezone(ctx.tz).date_naive(), page));
                }
            }
            let mut out = BTreeMap::new();
            for (d, _) in seen {
                *out.entry(d).or_default() += 1;
            }
            out
        }
    };
    let days: Vec<(NaiveDate, i64)> = days.into_iter().filter(|(_, v)| *v > 0).collect();
    Ok(HeatmapData {
        from,
        to,
        max: days.iter().map(|d| d.1).max().unwrap_or(0),
        total: days.iter().map(|d| d.1).sum(),
        active: days.len(),
        days,
    })
}

// ------------------------------------------------------------------ kanban

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct KanbanData {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    /// The page's frontmatter block (schema and view settings), as the board view reads it.
    pub frontmatter: String,
    pub rows: Vec<CollectionViewRow>,
}

pub fn kanban(db: &Database, page: i64) -> Result<KanbanData> {
    let p = db.page(page)?;
    if p.deleted_at.is_some() {
        return Err(Error::not_found("page", page.to_string()));
    }
    let content: String = db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [page], |r| r.get(0))?;
    let view = db.page_collection_view(page)?;
    Ok(KanbanData {
        page_id: page,
        title: p.title,
        icon: p.icon,
        frontmatter: crate::properties::frontmatter_block(&content),
        rows: view.rows,
    })
}

#[cfg(test)]
mod tests;
