//! Start page („Startseite“) data: what the visible widgets need, computed in one call.
//!
//! The UI sends one [`Part`] per distinct thing its widgets show (the day, the next meetings,
//! a task filter, the budgets, a saved query, …), each under a key of its own; the answer maps
//! every key to its data or to `{"error": …}`, so one failing widget does not blank the others.
//! Things several parts need (the budgets, the burn of the last four weeks) are loaded once per
//! call. Everything reads; nothing here writes.
//!
//! [`query`] evaluates the saved queries of the „Abfrage“ widget, [`notes`] answers the notes
//! widgets (a year ago, writing, pulled by Git sync, the inbox).

pub mod notes;
pub mod query;
pub mod work;

use crate::trf;
use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::calendar;
use crate::calsync::CalendarEvent;
use crate::dayreview::{self, ReviewOptions};
use crate::db::{Database, EntryFilter};
use crate::error::{Error, Result};
use crate::feed::{self, FeedFilter, day_start};
use crate::focus::{self, FocusReport};
use crate::model::{Page, StatusFlag, TimeEntryRow};
use crate::settings::Settings;
use crate::tasks::{Task, TaskFilter, TaskStatus};
use crate::tracking::{self, BudgetStatus};

/// Days the budget forecast looks back for the current pace.
pub const BURN_DAYS: i64 = 28;
/// Most parts one call may ask for.
pub const MAX_PARTS: usize = 64;
/// Longest agenda (days).
const MAX_AGENDA_DAYS: u32 = 31;
/// Longest embedded page text handed out (characters).
const MAX_EMBED_CHARS: usize = 60_000;

/// What one widget (or several with the same settings) needs.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
    /// „Heute“: today's meetings, booked minutes, due and overdue tasks, focus.
    Today,
    /// „Termine“: the meetings of today and the next days.
    Agenda { days: u32 },
    /// „Aufgaben“: open tasks by a filter.
    Tasks {
        #[serde(default)]
        filter: TaskQuery,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// „Zeit diese Woche“: booked minutes per day and per WBS of the week from `week_start`.
    Week { week_start: NaiveDate },
    /// „Budget“: every budget row with the hours of the last four weeks.
    Budgets,
    /// „Projekt“: one Netzplan with its budget, notes, open tasks and next meetings; without
    /// one the Netzplan booked last (`null` when there is none).
    Project {
        #[serde(default)]
        netzplan_id: Option<i64>,
    },
    /// „Zuletzt bearbeitet“.
    Recent { limit: usize },
    /// „Seite einbetten“: one page's text.
    Page { id: i64 },
    /// „Abfrage“: a saved query.
    Query { query: query::Query },
    /// „Aktivität“: the newest feed events.
    Feed { limit: usize },
    /// „Fokus“: sessions today and this week.
    Focus { week_start: NaiveDate },
    /// „Wochenvorschlag“: what the week's proposal would fill.
    Proposal { week_start: NaiveDate },
    /// „Tagesrückblick“ of a (past) day, condensed.
    Review { date: NaiveDate },
    /// The last few references booked (quick timer start).
    TimerRefs,
    /// „Kalender“: daily notes, bookings and due tasks per day.
    Month { from: NaiveDate, to: NaiveDate },
    /// „KI-Vorschläge“: counts the suggestions are built from.
    Suggestions,
    /// „Vor einem Jahr“: this day in earlier years and a random older note picked by `seed`.
    Resurface {
        #[serde(default)]
        seed: u64,
    },
    /// „Schreiben“: words and new pages per day of the last `days` days.
    Writing { days: u32 },
    /// „Per Git-Sync geändert“: pages the last syncs pulled from others.
    Pulled { limit: usize },
    /// „Posteingang“: the captures waiting on the inbox page.
    Inbox { limit: usize },
    /// The work and chart widgets of 1.7 (balance, vacation, deadlines, team, charts, …).
    #[serde(untagged)]
    Work(work::WorkPart),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Keyed {
    pub key: String,
    pub part: Part,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    /// The local day of the UI (it may run past midnight with an old date; the UI decides).
    pub today: NaiveDate,
    pub parts: Vec<Keyed>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Response {
    /// Data (or `{"error": …}`) by the key of each part.
    pub parts: BTreeMap<String, serde_json::Value>,
    /// Time spent in the backend (ms).
    pub ms: f64,
}

/// Filter of the „Aufgaben“ widget. Everything optional; open tasks by default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TaskQuery {
    pub status: TaskStatus,
    /// `any` (default), `overdue`, `today` (due today or overdue), `week` (due within 7 days
    /// or overdue), `dated` (with a due date), `none` (without).
    pub due: String,
    pub tag: Option<String>,
    pub page_id: Option<i64>,
    /// 0 all, 1 at least „mittel“, 2 only „hoch“.
    pub priority: u8,
    /// Words that must appear in the task text or its page title.
    pub text: String,
}

/// What the widgets get.
#[derive(Debug, Clone, Serialize)]
pub struct TodayData {
    pub date: NaiveDate,
    pub daily_note_id: Option<i64>,
    pub booked_minutes: i64,
    pub target_minutes: i64,
    pub workday: bool,
    pub events: Vec<CalendarEvent>,
    /// Overdue and due today, then the open tasks of today's daily note.
    pub tasks: Vec<Task>,
    pub tasks_total: usize,
    pub focus: FocusReport,
    pub calendar_configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgendaData {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub events: Vec<CalendarEvent>,
    pub configured: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct TasksData {
    pub tasks: Vec<Task>,
    pub total: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekDay {
    pub date: NaiveDate,
    pub minutes: i64,
    /// The weekday has a target.
    pub workday: bool,
    /// The day's target ([`crate::worktime::DayTargets`]: none on a holiday, an absence day or
    /// before the workspace existed).
    pub target_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekWbs {
    /// `NP-8801/1020`.
    pub label: String,
    pub title: String,
    pub minutes: i64,
    /// Minutes per day of the week (seven values).
    pub by_day: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WeekData {
    pub week_start: NaiveDate,
    pub days: Vec<WeekDay>,
    /// Most booked first.
    pub wbs: Vec<WeekWbs>,
    /// The targets of the days summed.
    pub target_minutes: i64,
}

/// A budget row with its recent pace.
#[derive(Debug, Clone, Serialize)]
pub struct BudgetRow {
    #[serde(flatten)]
    pub status: BudgetStatus,
    /// Description of the Vorgang (or the Netzplan).
    pub title: String,
    /// Hours booked in the last [`BURN_DAYS`] days.
    pub recent_hours: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BudgetsData {
    pub budgets: Vec<BudgetRow>,
    pub burn_days: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProjectData {
    pub netzplan_id: i64,
    pub netzplan_nr: String,
    pub description: String,
    pub project_code: String,
    pub project_name: String,
    /// The Netzplan first, then its Vorgänge.
    pub budget: Vec<BudgetRow>,
    /// Notes linked to the Netzplan (`netzplan:` / `vorgang:`), last edited first.
    pub pages: Vec<Page>,
    pub tasks: Vec<Task>,
    pub tasks_total: usize,
    /// Meetings of the next two weeks about it (its number in the text, or booked on it before).
    pub events: Vec<CalendarEvent>,
    pub burn_days: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PageData {
    pub id: i64,
    pub title: String,
    pub icon: Option<String>,
    pub updated_at: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FocusData {
    pub today: FocusReport,
    pub week: FocusReport,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenDay {
    pub date: NaiveDate,
    pub booked_minutes: i64,
    pub missing_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ProposalData {
    pub week_start: NaiveDate,
    /// Past workdays of the week below the target (today and later are still open).
    pub open_days: Vec<OpenDay>,
    pub missing_minutes: i64,
    /// Meetings of the week that are over, not booked and not marked „nicht buchen“.
    pub unbooked_meetings: usize,
    pub unbooked_minutes: i64,
    pub booked_minutes: i64,
    pub target_minutes: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewLine {
    pub label: String,
    pub minutes: i64,
    pub page_id: Option<i64>,
    pub icon: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReviewData {
    pub date: NaiveDate,
    pub workday: bool,
    pub booked_minutes: i64,
    pub target_minutes: i64,
    pub pages_edited: usize,
    pub pages_created: usize,
    pub tasks_done: i64,
    pub tasks_added: i64,
    pub meetings: usize,
    pub meetings_open: usize,
    pub focus_minutes: i64,
    pub top_wbs: Vec<ReviewLine>,
    pub top_pages: Vec<ReviewLine>,
    pub empty: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestionData {
    pub open_tasks: i64,
    pub overdue: i64,
    pub due_today: i64,
    pub worst_budget: Option<String>,
    /// Booked minutes Monday..Sunday of this week.
    pub week_minutes: Vec<i64>,
    /// The targets of these days ([`crate::worktime::DayTargets`]).
    pub week_targets: Vec<i64>,
}

/// Everything a call needs besides the database.
pub struct Ctx<'a, Tz: TimeZone> {
    pub db: &'a Database,
    pub tz: &'a Tz,
    pub now: DateTime<Utc>,
    pub today: NaiveDate,
    /// The active calendar sources (Outlook when available, the switched-on ICS sources).
    pub sources: &'a [String],
    pub settings: &'a Settings,
    budgets: OnceCell<Vec<BudgetRow>>,
}

impl<'a, Tz: TimeZone> Ctx<'a, Tz> {
    pub fn new(
        db: &'a Database,
        tz: &'a Tz,
        now: DateTime<Utc>,
        today: NaiveDate,
        sources: &'a [String],
        settings: &'a Settings,
    ) -> Self {
        Ctx { db, tz, now, today, sources, settings, budgets: OnceCell::new() }
    }

    /// The targets of `from..=to` by the rule every view uses.
    fn targets(&self, from: NaiveDate, to: NaiveDate) -> Result<crate::worktime::DayTargets> {
        crate::worktime::DayTargets::load(self.db, self.settings, from, to)
    }

    /// The weekday has a target (a Saturday with own hours too).
    fn is_workday(&self, d: NaiveDate) -> bool {
        crate::worktime::weekday_minutes(self.settings, d) > 0
    }

    fn day_start(&self, d: NaiveDate) -> DateTime<Utc> {
        day_start(d, self.tz)
    }

    fn local_day(&self, t: DateTime<Utc>) -> NaiveDate {
        t.with_timezone(self.tz).date_naive()
    }

    fn events(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<CalendarEvent>> {
        if self.sources.is_empty() {
            return Ok(vec![]);
        }
        self.db.calendar_events(from, to, self.sources)
    }

    /// Every budget row with its recent hours, loaded once per call.
    fn budgets(&self) -> Result<&[BudgetRow]> {
        if let Some(b) = self.budgets.get() {
            return Ok(b);
        }
        let rows = budget_rows(self.db, self.settings, self.day_start(self.today) + Duration::days(1))?;
        Ok(self.budgets.get_or_init(|| rows))
    }
}

/// Answers every part of `req`; a part that fails carries its error.
pub fn dashboard_data<Tz: TimeZone>(ctx: &Ctx<Tz>, parts: &[Keyed]) -> Result<BTreeMap<String, serde_json::Value>> {
    if parts.len() > MAX_PARTS {
        return Err(Error::State(trf!(
            "Zu viele Widget-Abfragen auf einmal (höchstens {MAX_PARTS})",
            "Too many widget queries at once (at most {MAX_PARTS})"
        )));
    }
    let mut out = BTreeMap::new();
    for k in parts {
        if out.contains_key(&k.key) {
            continue;
        }
        let v = match part(ctx, &k.part) {
            Ok(v) => v,
            Err(e) => serde_json::json!({ "error": e.to_string() }),
        };
        out.insert(k.key.clone(), v);
    }
    Ok(out)
}

fn json<T: Serialize>(v: T) -> Result<serde_json::Value> {
    Ok(serde_json::to_value(v)?)
}

/// The data of one part.
pub fn part<Tz: TimeZone>(ctx: &Ctx<Tz>, p: &Part) -> Result<serde_json::Value> {
    match p {
        Part::Today => json(today(ctx)?),
        Part::Agenda { days } => json(agenda(ctx, *days)?),
        Part::Tasks { filter, limit } => {
            let all = tasks(ctx.db, filter, ctx.today)?;
            let total = all.len();
            json(TasksData { tasks: all.into_iter().take(limit.unwrap_or(50).clamp(1, 200)).collect(), total })
        }
        Part::Week { week_start } => json(week(ctx, *week_start)?),
        Part::Budgets => json(BudgetsData { budgets: ctx.budgets()?.to_vec(), burn_days: BURN_DAYS }),
        Part::Project { netzplan_id } => {
            match netzplan_id.map_or_else(|| last_booked_netzplan(ctx.db), |id| Ok(Some(id)))? {
                Some(id) => json(project(ctx, id)?),
                None => Ok(serde_json::Value::Null),
            }
        }
        Part::Recent { limit } => json(ctx.db.recent_pages((*limit).clamp(1, 30))?),
        Part::Page { id } => json(embed(ctx.db, *id)?),
        Part::Query { query } => json(query::run(ctx, query)?),
        Part::Feed { limit } => {
            let f = FeedFilter { limit: Some((*limit).clamp(1, 50)), ..Default::default() };
            json(feed::list(ctx.db, &f)?)
        }
        Part::Focus { week_start } => json(FocusData {
            today: focus::report(ctx.db, ctx.today, ctx.today, ctx.tz)?,
            week: focus::report(ctx.db, *week_start, *week_start + Duration::days(6), ctx.tz)?,
        }),
        Part::Proposal { week_start } => json(proposal(ctx, *week_start)?),
        Part::Review { date } => json(review(ctx, *date)?),
        Part::TimerRefs => json(timer_refs(ctx)?),
        Part::Month { from, to } => json(calendar::daily_overview(ctx.db, *from, *to, ctx.tz)?),
        Part::Suggestions => json(suggestions(ctx)?),
        Part::Resurface { seed } => json(notes::resurface(ctx, *seed)?),
        Part::Writing { days } => json(notes::writing(ctx, *days)?),
        Part::Pulled { limit } => json(notes::pulled(ctx, *limit)?),
        Part::Inbox { limit } => json(notes::inbox(ctx, *limit)?),
        Part::Work(p) => work::part(ctx, p),
    }
}

// ------------------------------------------------------------------------ parts

fn today<Tz: TimeZone>(ctx: &Ctx<Tz>) -> Result<TodayData> {
    let day = ctx.today;
    let from = ctx.day_start(day);
    let to = ctx.day_start(day + Duration::days(1));
    let overview = calendar::daily_overview(ctx.db, day, day, ctx.tz)?.into_iter().next();
    let key = day.format("%Y-%m-%d").to_string();
    let mut list =
        ctx.db.list_tasks(&TaskFilter { status: TaskStatus::Open, due_before: Some(key), ..Default::default() })?;
    let note_id = overview.as_ref().and_then(|o| o.note_id);
    if let Some(id) = note_id {
        let seen: HashSet<(i64, i64)> = list.iter().map(|t| (t.page_id, t.ordinal)).collect();
        let on_note =
            ctx.db.list_tasks(&TaskFilter { status: TaskStatus::Open, page_id: Some(id), ..Default::default() })?;
        list.extend(on_note.into_iter().filter(|t| !seen.contains(&(t.page_id, t.ordinal))));
    }
    let total = list.len();
    list.truncate(30);
    Ok(TodayData {
        date: day,
        daily_note_id: note_id,
        booked_minutes: overview.map_or(0, |o| o.booked_minutes),
        target_minutes: ctx.targets(day, day)?.get(day),
        workday: ctx.is_workday(day),
        events: ctx.events(from, to)?,
        tasks: list,
        tasks_total: total,
        focus: focus::report(ctx.db, day, day, ctx.tz)?,
        calendar_configured: !ctx.sources.is_empty(),
    })
}

fn agenda<Tz: TimeZone>(ctx: &Ctx<Tz>, days: u32) -> Result<AgendaData> {
    let days = days.clamp(1, MAX_AGENDA_DAYS) as i64;
    let from = ctx.day_start(ctx.today);
    let to = ctx.day_start(ctx.today + Duration::days(days));
    Ok(AgendaData { from, to, events: ctx.events(from, to)?, configured: !ctx.sources.is_empty() })
}

/// The tasks of a [`TaskQuery`], in the order of the task list.
pub fn tasks(db: &Database, q: &TaskQuery, today: NaiveDate) -> Result<Vec<Task>> {
    let key = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    let due_before = match q.due.as_str() {
        "overdue" => Some(key(today - Duration::days(1))),
        "today" => Some(key(today)),
        "week" => Some(key(today + Duration::days(7))),
        _ => None,
    };
    let list = db.list_tasks(&TaskFilter {
        status: q.status,
        due_before,
        tag: q.tag.clone().filter(|t| !t.trim().is_empty()),
        page_id: q.page_id,
        changed_since: None,
    })?;
    let words: Vec<String> = q.text.split_whitespace().map(str::to_lowercase).collect();
    Ok(list
        .into_iter()
        .filter(|t| match q.due.as_str() {
            "dated" => t.due.is_some(),
            "none" => t.due.is_none(),
            _ => true,
        })
        .filter(|t| t.priority >= q.priority)
        .filter(|t| {
            let hay = format!("{} {}", t.text, t.page_title).to_lowercase();
            words.iter().all(|w| hay.contains(w))
        })
        .collect())
}

/// Finished entries of the local days `from..to` (exclusive).
fn entries<Tz: TimeZone>(ctx: &Ctx<Tz>, from: NaiveDate, to: NaiveDate) -> Result<Vec<TimeEntryRow>> {
    Ok(ctx
        .db
        .list_time_entries(&EntryFilter {
            from: Some(ctx.day_start(from)),
            to: Some(ctx.day_start(to)),
            ..Default::default()
        })?
        .into_iter()
        .filter(|r| r.entry.status_flag != StatusFlag::Running && r.entry.duration_minutes.is_some())
        .collect())
}

fn wbs_label(r: &TimeEntryRow) -> String {
    match &r.entry.vorgang_nr {
        Some(v) if !v.is_empty() => format!("{}/{v}", r.netzplan_nr),
        _ => r.netzplan_nr.clone(),
    }
}

fn week<Tz: TimeZone>(ctx: &Ctx<Tz>, start: NaiveDate) -> Result<WeekData> {
    let rows = entries(ctx, start, start + Duration::days(7))?;
    let targets = ctx.targets(start, start + Duration::days(6))?;
    let mut days: Vec<WeekDay> = (0..7)
        .map(|i| {
            let date = start + Duration::days(i);
            WeekDay { date, minutes: 0, workday: ctx.is_workday(date), target_minutes: targets.get(date) }
        })
        .collect();
    let mut wbs: Vec<WeekWbs> = vec![];
    let titles = wbs_titles(ctx.db)?;
    for r in &rows {
        let minutes = r.entry.duration_minutes.unwrap_or(0);
        let i = (ctx.local_day(r.entry.start_time) - start).num_days();
        if !(0..7).contains(&i) {
            continue;
        }
        days[i as usize].minutes += minutes;
        let label = wbs_label(r);
        let at = match wbs.iter().position(|w| w.label.eq_ignore_ascii_case(&label)) {
            Some(at) => at,
            None => {
                let title = titles.get(&label.to_lowercase()).cloned().unwrap_or_default();
                wbs.push(WeekWbs { label, title, minutes: 0, by_day: vec![0; 7] });
                wbs.len() - 1
            }
        };
        wbs[at].minutes += minutes;
        wbs[at].by_day[i as usize] += minutes;
    }
    wbs.sort_by(|a, b| b.minutes.cmp(&a.minutes).then_with(|| a.label.cmp(&b.label)));
    let target_minutes = days.iter().map(|d| d.target_minutes).sum();
    Ok(WeekData { week_start: start, days, wbs, target_minutes })
}

/// Descriptions of every Netzplan and Vorgang by lower-cased label (`np-8801/1020`).
fn wbs_titles(db: &Database) -> Result<HashMap<String, String>> {
    let mut out = HashMap::new();
    let mut st = db.conn().prepare_cached(
        "SELECT n.netzplan_nr, n.description, v.vorgang_nr, v.description
         FROM netzplaene n LEFT JOIN vorgaenge v ON v.netzplan_id = n.id",
    )?;
    for row in st.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Option<String>>(2)?,
            r.get::<_, Option<String>>(3)?,
        ))
    })? {
        let (nr, desc, v, vdesc) = row?;
        out.entry(nr.to_lowercase()).or_insert_with(|| desc.clone());
        if let Some(v) = v {
            out.insert(format!("{nr}/{v}").to_lowercase(), vdesc.filter(|d| !d.is_empty()).unwrap_or(desc));
        }
    }
    Ok(out)
}

/// Every budget row (like [`tracking::all_budgets`]) with the hours booked in the
/// [`BURN_DAYS`] days before `until`.
pub fn budget_rows(db: &Database, settings: &Settings, until: DateTime<Utc>) -> Result<Vec<BudgetRow>> {
    let budgets = tracking::all_budgets(db, &settings.thresholds)?;
    let since = until - Duration::days(BURN_DAYS);
    let mut recent: HashMap<(i64, Option<String>), i64> = HashMap::new();
    let mut st = db.conn().prepare_cached(
        "SELECT netzplan_id, lower(vorgang_nr), SUM(duration_minutes) FROM time_entries
         WHERE status_flag <> 'running' AND start_time >= ?1 AND start_time < ?2
         GROUP BY netzplan_id, lower(vorgang_nr)",
    )?;
    for row in st.query_map([crate::db::ts(since), crate::db::ts(until)], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0)))
    })? {
        let (np, v, minutes) = row?;
        *recent.entry((np, None)).or_default() += minutes;
        if let Some(v) = v {
            *recent.entry((np, Some(v))).or_default() += minutes;
        }
    }
    let titles = wbs_titles(db)?;
    Ok(budgets
        .into_iter()
        .map(|b| {
            let key = (b.netzplan_id, b.vorgang_nr.as_ref().map(|v| v.to_lowercase()));
            BudgetRow {
                title: titles.get(&b.label.to_lowercase()).cloned().unwrap_or_default(),
                recent_hours: recent.get(&key).copied().unwrap_or(0) as f64 / 60.0,
                status: b,
            }
        })
        .collect())
}

/// Pages whose `netzplan:` / `vorgang:` property names the Netzplan `nr`, last edited first.
fn project_pages(db: &Database, nr: &str, limit: usize) -> Result<Vec<Page>> {
    let mut st = db.conn().prepare_cached(&format!(
        "SELECT {}, content FROM pages
         WHERE deleted_at IS NULL AND substr(content, 1, 3) = '---' AND instr(lower(content), lower(?1)) > 0
         ORDER BY updated_at DESC, id DESC",
        crate::db::PAGE_COLS
    ))?;
    let mut out = vec![];
    for row in st.query_map([nr], |r| Ok((crate::db::map_page(r)?, r.get::<_, String>(10)?)))? {
        let (page, content) = row?;
        let linked = crate::pagework::page_reference(&content).is_some_and(|r| {
            let r = r.trim();
            r.eq_ignore_ascii_case(nr) || r.to_lowercase().starts_with(&format!("{}/", nr.to_lowercase()))
        });
        if linked {
            out.push(page);
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// The Netzplan of the newest booking, else the first Netzplan; `None` without any.
fn last_booked_netzplan(db: &Database) -> Result<Option<i64>> {
    use rusqlite::OptionalExtension;
    let booked = db
        .conn()
        .query_row("SELECT netzplan_id FROM time_entries ORDER BY start_time DESC, id DESC LIMIT 1", [], |r| r.get(0))
        .optional()?;
    Ok(booked.or(db.list_netzplaene(None)?.first().map(|n| n.id)))
}

fn project<Tz: TimeZone>(ctx: &Ctx<Tz>, netzplan_id: i64) -> Result<ProjectData> {
    let np = ctx.db.netzplan_by_id(netzplan_id)?;
    let project = ctx.db.project_by_id(np.project_id)?;
    let budget: Vec<BudgetRow> =
        ctx.budgets()?.iter().filter(|b| b.status.netzplan_id == netzplan_id).cloned().collect();
    let pages = project_pages(ctx.db, &np.netzplan_nr, 40)?;
    // Open tasks of the linked pages, in one query.
    let ids: Vec<i64> = pages.iter().map(|p| p.id).collect();
    let mut tasks: Vec<Task> = vec![];
    if !ids.is_empty() {
        let all = ctx.db.list_tasks(&TaskFilter { status: TaskStatus::Open, ..Default::default() })?;
        let set: HashSet<i64> = ids.iter().copied().collect();
        tasks = all.into_iter().filter(|t| set.contains(&t.page_id)).collect();
    }
    let tasks_total = tasks.len();
    tasks.truncate(8);
    // Meetings: the number in subject, place or text, or the series / subject booked on it before.
    let from = ctx.day_start(ctx.today);
    let events = ctx.events(from, ctx.day_start(ctx.today + Duration::days(14)))?;
    let mut series = HashSet::new();
    let mut titles = HashSet::new();
    {
        let mut st = ctx.db.conn().prepare_cached(
            "SELECT m.series, m.title FROM calendar_marks m JOIN time_entries t ON t.id = m.entry_id
             WHERE t.netzplan_id = ?1",
        )?;
        for row in st.query_map([netzplan_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (s, t) = row?;
            if !s.is_empty() {
                series.insert(s);
            }
            if !t.is_empty() {
                titles.insert(t);
            }
        }
    }
    let nr = np.netzplan_nr.to_lowercase();
    let events: Vec<CalendarEvent> = events
        .into_iter()
        .filter(|e| e.event.end > ctx.now)
        .filter(|e| {
            let ev = &e.event;
            let text = format!("{} {} {}", ev.title, ev.location, ev.body.as_deref().unwrap_or("")).to_lowercase();
            text.contains(&nr)
                || (ev.recurring && series.contains(&ev.uid))
                || titles.contains(&ev.title.to_lowercase())
        })
        .take(4)
        .collect();
    Ok(ProjectData {
        netzplan_id,
        netzplan_nr: np.netzplan_nr,
        description: np.description,
        project_code: project.project_code,
        project_name: project.name,
        budget,
        pages: pages.into_iter().take(6).collect(),
        tasks,
        tasks_total,
        events,
        burn_days: BURN_DAYS,
    })
}

fn embed(db: &Database, id: i64) -> Result<PageData> {
    let page = db.page(id)?;
    if page.deleted_at.is_some() {
        return Err(Error::not_found("page", id.to_string()));
    }
    let content: String = db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
    let truncated = content.chars().count() > MAX_EMBED_CHARS;
    let content = if truncated { content.chars().take(MAX_EMBED_CHARS).collect() } else { content };
    Ok(PageData { id, title: page.title, icon: page.icon, updated_at: page.updated_at, content, truncated })
}

fn proposal<Tz: TimeZone>(ctx: &Ctx<Tz>, start: NaiveDate) -> Result<ProposalData> {
    let w = week(ctx, start)?;
    let mut open_days: Vec<OpenDay> = vec![];
    // Holidays, absence days and the days before the workspace existed are no gaps; today counts
    // once it is over, as on the week widget, in the timesheet and in the reviews.
    for d in w.days.iter().filter(|d| crate::worktime::day_is_over(d.date, ctx.now, ctx.tz)) {
        if d.minutes < d.target_minutes {
            open_days.push(OpenDay {
                date: d.date,
                booked_minutes: d.minutes,
                missing_minutes: d.target_minutes - d.minutes,
            });
        }
    }
    let events = ctx.events(ctx.day_start(start), ctx.day_start(start + Duration::days(7)))?;
    let unbooked: Vec<&CalendarEvent> = events
        .iter()
        .filter(|e| {
            let ev = &e.event;
            ev.end <= ctx.now
                && !ev.all_day
                && e.entry_id.is_none()
                && !e.skip
                && !matches!(ev.busy, crate::calsync::Busy::Free | crate::calsync::Busy::Oof)
        })
        .collect();
    Ok(ProposalData {
        week_start: start,
        missing_minutes: open_days.iter().map(|d| d.missing_minutes).sum(),
        open_days,
        unbooked_meetings: unbooked.len(),
        unbooked_minutes: unbooked.iter().map(|e| (e.event.end - e.event.start).num_minutes().max(0)).sum(),
        booked_minutes: w.days.iter().map(|d| d.minutes).sum(),
        target_minutes: w.target_minutes,
    })
}

fn review<Tz: TimeZone>(ctx: &Ctx<Tz>, date: NaiveDate) -> Result<ReviewData> {
    let opts = ReviewOptions::from_settings(ctx.settings, Some(ctx.sources.to_vec()), ctx.now);
    let r = dayreview::day_review(ctx.db, date, ctx.tz, &opts)?;
    let mut pages: Vec<&dayreview::ReviewPage> = r.pages.iter().filter(|p| !p.gone && !p.daily).collect();
    pages.sort_by(|a, b| b.minutes.cmp(&a.minutes).then(b.chars.cmp(&a.chars)));
    Ok(ReviewData {
        date,
        workday: r.time.workday,
        booked_minutes: r.time.booked_minutes,
        target_minutes: r.time.target_minutes,
        pages_edited: r.pages.iter().filter(|p| !p.created).count(),
        pages_created: r.pages.iter().filter(|p| p.created).count(),
        tasks_done: r.tasks.done_total,
        tasks_added: r.tasks.added_total,
        meetings: r.meetings.iter().filter(|m| m.state != "free").count(),
        meetings_open: r.meetings.iter().filter(|m| m.state == "open").count(),
        focus_minutes: r.focus.minutes,
        top_wbs: r
            .time
            .items
            .iter()
            .take(3)
            .map(|w| ReviewLine { label: w.label.clone(), minutes: w.minutes, page_id: None, icon: None })
            .collect(),
        top_pages: pages
            .iter()
            .take(3)
            .map(|p| ReviewLine {
                label: p.title.clone(),
                minutes: p.minutes,
                page_id: p.page_id,
                icon: p.icon.clone(),
            })
            .collect(),
        empty: r.is_empty(),
    })
}

/// The last three distinct references booked in the last 60 days, newest first.
fn timer_refs<Tz: TimeZone>(ctx: &Ctx<Tz>) -> Result<Vec<TimeEntryRow>> {
    let rows =
        ctx.db.list_time_entries(&EntryFilter { from: Some(ctx.now - Duration::days(60)), ..Default::default() })?;
    let mut seen = HashSet::new();
    let mut out = vec![];
    for r in rows.into_iter().rev() {
        if r.entry.status_flag == StatusFlag::Running {
            continue;
        }
        if seen.insert((r.entry.netzplan_id, r.entry.vorgang_nr.clone().unwrap_or_default().to_lowercase())) {
            out.push(r);
            if out.len() == 3 {
                break;
            }
        }
    }
    Ok(out)
}

fn suggestions<Tz: TimeZone>(ctx: &Ctx<Tz>) -> Result<SuggestionData> {
    let today = ctx.today.format("%Y-%m-%d").to_string();
    let counts = ctx.db.open_task_counts(&today, None)?;
    let statuses: Vec<BudgetStatus> = ctx.budgets()?.iter().map(|b| b.status.clone()).collect();
    let monday = ctx.today - Duration::days(ctx.today.weekday().num_days_from_monday() as i64);
    let w = week(ctx, monday)?;
    Ok(SuggestionData {
        open_tasks: counts.open,
        overdue: counts.overdue,
        due_today: counts.due_today,
        worst_budget: tracking::worst_budget(&statuses).map(|b| b.label.clone()),
        week_minutes: w.days.iter().map(|d| d.minutes).collect(),
        week_targets: w.days.iter().map(|d| d.target_minutes).collect(),
    })
}

#[cfg(test)]
mod tests;
