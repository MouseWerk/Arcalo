//! Saved queries of the „Abfrage“ widget: pages (tag, text, children of a page, property
//! filters like `status ist Offen`), tasks, time entries or meetings, as rows, a count or
//! groups for a bar chart. Filters use the operators of the table view
//! ([`crate::properties::matches`]); every source knows a few fields of its own (`fällig`,
//! `prio`, `netzplan`, `kalender`, …).

use std::collections::{BTreeMap, HashMap};

use chrono::{Duration, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

use super::Ctx;
use crate::db::{EntryFilter, PAGE_COLS, map_page};
use crate::error::Result;
use crate::model::{Page, StatusFlag};
use crate::properties::{self, Cell, Filter, Schema, Typed};
use crate::tasks::{Task, TaskFilter, TaskStatus};

/// Most rows handed out.
pub const MAX_ROWS: usize = 200;
/// Most groups of a bar chart; the rest is summed up as „Andere“.
pub const MAX_GROUPS: usize = 12;
/// Label of rows without a value in the grouped field.
pub const EMPTY_GROUP: &str = "(leer)";
/// Label of the groups beyond [`MAX_GROUPS`].
pub const OTHER_GROUP: &str = "Andere";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    #[default]
    Pages,
    Tasks,
    Entries,
    Events,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Query {
    pub source: Source,
    /// Pages with this tag (pages), tasks with it (tasks).
    pub tag: Option<String>,
    /// Words that must all appear (title and text of pages, task text, entry description,
    /// meeting subject and place).
    pub text: String,
    /// Only the child pages of this page (a collection).
    pub parent_id: Option<i64>,
    pub filters: Vec<Filter>,
    /// Time entries: `today`, `week` (default), `last7`, `month`, `last30`, `year`.
    pub range: String,
    /// Meetings: this many days from today (default 7).
    pub days: u32,
    /// Field to group by (bar chart).
    pub group: String,
    /// Page properties shown as table columns.
    pub columns: Vec<String>,
    /// Pages: `updated` (default) or `title`.
    pub sort: String,
    /// Rows handed out (default 20).
    pub limit: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct QueryRow {
    pub key: String,
    pub title: String,
    /// Page title of a task, WBS of an entry, place of a meeting.
    pub detail: String,
    /// Changed (pages), due (tasks), start (entries, meetings).
    pub date: Option<String>,
    pub page_id: Option<i64>,
    pub icon: Option<String>,
    /// Tasks: identify the task for ticking it off.
    pub ordinal: Option<i64>,
    pub done: Option<bool>,
    pub priority: Option<u8>,
    /// Entries: booked minutes; meetings: length.
    pub minutes: Option<i64>,
    /// Meetings: the event key.
    pub event_key: Option<String>,
    /// Pages: the requested columns as text.
    pub cells: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Group {
    pub label: String,
    /// Rows in the group (time entries: hours).
    pub value: f64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct QueryResult {
    /// Rows matching (before `limit`).
    pub total: usize,
    /// Time entries: all minutes matching.
    pub minutes: Option<i64>,
    pub rows: Vec<QueryRow>,
    pub groups: Vec<Group>,
}

/// Runs a query.
pub fn run<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &Query) -> Result<QueryResult> {
    let limit = if q.limit == 0 { 20 } else { q.limit.min(MAX_ROWS) };
    let (rows, groups, minutes) = match q.source {
        Source::Pages => pages(ctx, q)?,
        Source::Tasks => tasks(ctx, q)?,
        Source::Entries => entries(ctx, q)?,
        Source::Events => events(ctx, q)?,
    };
    let total = rows.len();
    Ok(QueryResult { total, minutes, rows: rows.into_iter().take(limit).collect(), groups: finish_groups(groups, q) })
}

type Groups = Vec<(String, f64)>;

/// Adds `value` to the group `label`.
fn bump(groups: &mut Groups, label: &str, value: f64) {
    let label = if label.trim().is_empty() { EMPTY_GROUP } else { label.trim() };
    match groups.iter_mut().find(|(l, _)| l.eq_ignore_ascii_case(label)) {
        Some(g) => g.1 += value,
        None => groups.push((label.to_owned(), value)),
    }
}

/// Largest first (days in order), at most [`MAX_GROUPS`] with the rest as „Andere“.
fn finish_groups(mut groups: Groups, q: &Query) -> Vec<Group> {
    let by_day = matches!(q.group.as_str(), "tag" | "datum" | "day") && q.source != Source::Pages
        || (q.source == Source::Tasks && q.group == "fällig");
    if by_day {
        groups.sort_by(|a, b| a.0.cmp(&b.0));
    } else {
        groups.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
    }
    if groups.len() > MAX_GROUPS {
        let rest: f64 = groups[MAX_GROUPS - 1..].iter().map(|g| g.1).sum();
        groups.truncate(MAX_GROUPS - 1);
        groups.push((OTHER_GROUP.to_owned(), rest));
    }
    // Due buckets sort in time order through a hidden `1|` prefix.
    groups
        .into_iter()
        .map(|(label, value)| Group {
            label: label.split_once('|').map_or(label.clone(), |(_, l)| l.to_owned()),
            value,
        })
        .collect()
}

fn words(text: &str) -> Vec<String> {
    text.split_whitespace().map(str::to_lowercase).collect()
}

fn text_cell(key: &str, text: impl Into<String>) -> Cell {
    let text = text.into();
    let value = (!text.is_empty()).then(|| Typed::Text(text.clone()));
    Cell { key: key.to_owned(), text, value, error: None }
}

fn number_cell(key: &str, n: f64) -> Cell {
    Cell { key: key.to_owned(), text: n.to_string(), value: Some(Typed::Number(n)), error: None }
}

fn date_cell(key: &str, date: Option<&str>) -> Cell {
    match date.filter(|d| d.len() >= 10) {
        Some(d) => Cell {
            key: key.to_owned(),
            text: d[..10].to_owned(),
            value: Some(Typed::Date(d[..10].to_owned())),
            error: None,
        },
        None => text_cell(key, ""),
    }
}

/// Whether every filter passes; `cell` gives the cell of a field (lower case), `None` when the
/// row has no such field.
fn passes(filters: &[Filter], today: NaiveDate, mut cell: impl FnMut(&str) -> Option<Cell>) -> bool {
    filters.iter().all(|f| {
        let field = f.field.trim().to_lowercase();
        let c = cell(&field);
        properties::matches(c.as_ref(), f.op.trim(), &f.value, today)
    })
}

// ------------------------------------------------------------------------ pages

fn pages<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &Query) -> Result<(Vec<QueryRow>, Groups, Option<i64>)> {
    let db = ctx.db;
    let group = q.group.trim().to_lowercase();
    let needs_props =
        !q.filters.is_empty() || !q.columns.is_empty() || !(group.is_empty() || group == "tag" || group == "eltern");
    let mut conds = vec!["p.deleted_at IS NULL".to_owned()];
    let mut args: Vec<rusqlite::types::Value> = vec![];
    if let Some(tag) =
        q.tag.as_deref().map(|t| t.trim().trim_start_matches('#').to_lowercase()).filter(|t| !t.is_empty())
    {
        conds.push("p.id IN (SELECT page_id FROM page_tags WHERE tag = ?)".into());
        args.push(tag.into());
    }
    if let Some(parent) = q.parent_id {
        conds.push("p.parent_id = ?".into());
        args.push(parent.into());
    }
    for w in words(&q.text).into_iter().take(6) {
        conds.push("(instr(lower(p.title), ?) > 0 OR instr(lower(p.content), ?) > 0)".into());
        args.push(w.clone().into());
        args.push(w.into());
    }
    // Property filters and columns read only pages with a frontmatter block from SQLite.
    let content =
        if needs_props { "CASE WHEN substr(p.content, 1, 3) = '---' THEN p.content ELSE '' END" } else { "''" };
    let order = if q.sort == "title" { "p.title COLLATE NOCASE, p.id" } else { "p.updated_at DESC, p.id DESC" };
    let sql = format!(
        "SELECT {}, {content} FROM pages p WHERE {} ORDER BY {order}",
        PAGE_COLS.split(", ").map(|c| format!("p.{c}")).collect::<Vec<_>>().join(", "),
        conds.join(" AND ")
    );
    let mut st = db.conn().prepare(&sql)?;
    let found: Vec<(Page, String)> = st
        .query_map(rusqlite::params_from_iter(args), |r| Ok((map_page(r)?, r.get::<_, String>(9)?)))?
        .collect::<rusqlite::Result<_>>()?;

    // Schemas of the parents, loaded once each.
    let mut schemas: HashMap<i64, Option<Schema>> = HashMap::new();
    let empty = Schema::default();
    let need_tags = group == "tag";
    let tags: HashMap<i64, Vec<String>> = if need_tags { page_tags(ctx)? } else { HashMap::new() };
    let need_parents = group == "eltern";
    let titles: HashMap<i64, String> = if need_parents { page_titles(ctx)? } else { HashMap::new() };

    let mut rows = vec![];
    let mut groups: Groups = vec![];
    for (page, content) in found {
        let cells: Vec<Cell> = if needs_props && !content.is_empty() {
            let schema = match page.parent_id {
                Some(p) => schemas
                    .entry(p)
                    .or_insert_with(|| {
                        db.conn()
                            .query_row("SELECT content FROM pages WHERE id = ?1", [p], |r| r.get::<_, String>(0))
                            .ok()
                            .and_then(|c| Schema::from_markdown(&c))
                    })
                    .as_ref(),
                None => None,
            };
            properties::page_cells(schema.unwrap_or(&empty), &content)
        } else {
            vec![]
        };
        let find = |key: &str| -> Option<Cell> {
            match key {
                "titel" | "title" => Some(text_cell(key, page.title.clone())),
                "geändert" | "changed" => Some(date_cell(key, Some(&page.updated_at))),
                _ => cells.iter().find(|c| c.key.to_lowercase() == key).cloned(),
            }
        };
        if !passes(&q.filters, ctx.today, find) {
            continue;
        }
        match group.as_str() {
            "" => {}
            "tag" => match tags.get(&page.id) {
                Some(list) if !list.is_empty() => list.iter().for_each(|t| bump(&mut groups, &format!("#{t}"), 1.0)),
                _ => bump(&mut groups, "", 1.0),
            },
            "eltern" => {
                let label = page.parent_id.and_then(|p| titles.get(&p).cloned()).unwrap_or_default();
                bump(&mut groups, &label, 1.0);
            }
            key => match cells.iter().find(|c| c.key.to_lowercase() == key) {
                Some(Cell { value: Some(Typed::MultiSelect(values)), .. }) if !values.is_empty() => {
                    values.iter().for_each(|v| bump(&mut groups, v, 1.0))
                }
                Some(c) => bump(&mut groups, &c.text, 1.0),
                None => bump(&mut groups, "", 1.0),
            },
        }
        let cells = q
            .columns
            .iter()
            .map(|k| {
                let key = k.to_lowercase();
                (
                    k.clone(),
                    cells.iter().find(|c| c.key.to_lowercase() == key).map(|c| c.text.clone()).unwrap_or_default(),
                )
            })
            .collect();
        rows.push(QueryRow {
            key: format!("p{}", page.id),
            title: page.title.clone(),
            date: Some(page.updated_at.clone()),
            page_id: Some(page.id),
            icon: page.icon.clone(),
            cells,
            ..Default::default()
        });
    }
    Ok((rows, groups, None))
}

fn page_tags<Tz: TimeZone>(ctx: &Ctx<Tz>) -> Result<HashMap<i64, Vec<String>>> {
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    let mut st = ctx.db.conn().prepare_cached("SELECT page_id, tag FROM page_tags ORDER BY tag")?;
    for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
        let (id, tag) = row?;
        out.entry(id).or_default().push(tag);
    }
    Ok(out)
}

fn page_titles<Tz: TimeZone>(ctx: &Ctx<Tz>) -> Result<HashMap<i64, String>> {
    let mut st = ctx.db.conn().prepare_cached("SELECT id, title FROM pages WHERE deleted_at IS NULL")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ------------------------------------------------------------------------ tasks

/// „überfällig“, „heute“, „woche“ (the next seven days), „später“ or „ohne“.
pub fn due_bucket(due: Option<&str>, today: NaiveDate) -> &'static str {
    let Some(d) = due.and_then(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()) else { return "ohne" };
    if d < today {
        "überfällig"
    } else if d == today {
        "heute"
    } else if d <= today + Duration::days(7) {
        "woche"
    } else {
        "später"
    }
}

const PRIORITY: [&str; 3] = ["keine", "mittel", "hoch"];

fn tasks<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &Query) -> Result<(Vec<QueryRow>, Groups, Option<i64>)> {
    // `status` is a filter of the database query; everything else is checked here.
    let mut status = TaskStatus::Open;
    let mut rest = vec![];
    for f in &q.filters {
        if f.field.trim().eq_ignore_ascii_case("status") && f.op.trim() == "ist" {
            status = match f.value.trim().to_lowercase().as_str() {
                "erledigt" | "done" => TaskStatus::Done,
                "alle" | "all" => TaskStatus::All,
                _ => TaskStatus::Open,
            };
        } else {
            rest.push(f.clone());
        }
    }
    let list = ctx.db.list_tasks(&TaskFilter {
        status,
        tag: q.tag.clone().filter(|t| !t.trim().is_empty()),
        page_id: q.parent_id,
        ..Default::default()
    })?;
    let words = words(&q.text);
    let group = q.group.trim().to_lowercase();
    let mut rows = vec![];
    let mut groups: Groups = vec![];
    for t in list {
        let hay = format!("{} {}", t.text, t.page_title).to_lowercase();
        if !words.iter().all(|w| hay.contains(w)) {
            continue;
        }
        let bucket = due_bucket(t.due.as_deref(), ctx.today);
        let ok = rest.iter().all(|f| task_filter(f, &t, bucket, ctx.today));
        if !ok {
            continue;
        }
        match group.as_str() {
            "" => {}
            "seite" | "page" => bump(&mut groups, &t.page_title, 1.0),
            "prio" | "priorität" => bump(&mut groups, PRIORITY[t.priority.min(2) as usize], 1.0),
            "fällig" | "due" => bump(&mut groups, bucket_order(bucket), 1.0),
            "tag" => {
                if t.tags.is_empty() {
                    bump(&mut groups, "", 1.0);
                }
                t.tags.iter().for_each(|x| bump(&mut groups, &format!("#{x}"), 1.0));
            }
            _ => bump(&mut groups, "", 1.0),
        }
        rows.push(task_row(t));
    }
    Ok((rows, groups, None))
}

/// `1|überfällig`, `2|heute`, … so the buckets sort in time order.
fn bucket_order(bucket: &str) -> &'static str {
    match bucket {
        "überfällig" => "1|überfällig",
        "heute" => "2|heute",
        "woche" => "3|woche",
        "später" => "4|später",
        _ => "5|ohne",
    }
}

fn task_filter(f: &Filter, t: &Task, bucket: &str, today: NaiveDate) -> bool {
    let field = f.field.trim().to_lowercase();
    let op = f.op.trim();
    let value = f.value.trim().to_lowercase();
    let cell = match field.as_str() {
        "fällig" | "due" => {
            if ["überfällig", "heute", "woche", "später", "ohne"].contains(&value.as_str()) {
                // „woche“ (the next seven days) includes today.
                let hit = bucket == value || (value == "woche" && bucket == "heute");
                return if op == "ist nicht" { !hit } else { hit };
            }
            date_cell(&field, t.due.as_deref())
        }
        "prio" | "priorität" | "priority" => {
            let n = match value.as_str() {
                "hoch" | "high" => Some(2.0),
                "mittel" | "medium" => Some(1.0),
                "keine" | "none" => Some(0.0),
                _ => None,
            };
            if let Some(n) = n {
                let cell = number_cell(&field, t.priority as f64);
                return properties::matches(Some(&cell), op, &n.to_string(), today);
            }
            number_cell(&field, t.priority as f64)
        }
        "seite" | "page" => text_cell(&field, t.page_title.clone()),
        "text" | "titel" => text_cell(&field, t.text.clone()),
        "tag" | "tags" => Cell {
            key: field.clone(),
            text: t.tags.join(", "),
            value: Some(Typed::MultiSelect(t.tags.clone())),
            error: None,
        },
        _ => return properties::matches(None, op, &f.value, today),
    };
    properties::matches(Some(&cell), op, &f.value, today)
}

fn task_row(t: Task) -> QueryRow {
    QueryRow {
        key: format!("t{}:{}", t.page_id, t.ordinal),
        title: t.text,
        detail: t.page_title,
        date: t.due,
        page_id: Some(t.page_id),
        icon: t.page_icon,
        ordinal: Some(t.ordinal),
        done: Some(t.done),
        priority: Some(t.priority),
        ..Default::default()
    }
}

// ---------------------------------------------------------------------- entries

/// First and last local day (inclusive) of a range name.
pub fn range_days(range: &str, today: NaiveDate) -> (NaiveDate, NaiveDate) {
    use chrono::Datelike;
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    match range {
        "today" | "heute" => (today, today),
        "last7" => (today - Duration::days(6), today),
        "month" | "monat" => (today.with_day(1).unwrap_or(today), today),
        "last30" => (today - Duration::days(29), today),
        "year" | "jahr" => (today.with_ordinal(1).unwrap_or(today), today),
        _ => (monday, monday + Duration::days(6)),
    }
}

const STATUS_NAMES: [(StatusFlag, &str); 4] = [
    (StatusFlag::Running, "läuft"),
    (StatusFlag::Draft, "entwurf"),
    (StatusFlag::Released, "freigegeben"),
    (StatusFlag::Exported, "exportiert"),
];

fn status_name(s: StatusFlag) -> &'static str {
    STATUS_NAMES.iter().find(|(f, _)| *f == s).map_or("", |(_, n)| n)
}

fn entries<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &Query) -> Result<(Vec<QueryRow>, Groups, Option<i64>)> {
    let (from, to) = range_days(&q.range, ctx.today);
    let list = ctx.db.list_time_entries(&EntryFilter {
        from: Some(ctx.day_start(from)),
        to: Some(ctx.day_start(to + Duration::days(1))),
        ..Default::default()
    })?;
    let words = words(&q.text);
    let group = q.group.trim().to_lowercase();
    let mut rows = vec![];
    let mut groups: Groups = vec![];
    let mut sum = 0;
    for r in list.into_iter().rev() {
        let e = &r.entry;
        let Some(minutes) = e.duration_minutes.filter(|_| e.status_flag != StatusFlag::Running) else { continue };
        let label = super::wbs_label(&r);
        let hay = format!("{} {label}", e.description).to_lowercase();
        if !words.iter().all(|w| hay.contains(w)) {
            continue;
        }
        let day = ctx.local_day(e.start_time).format("%Y-%m-%d").to_string();
        let find = |key: &str| -> Option<Cell> {
            Some(match key {
                "netzplan" => text_cell(key, r.netzplan_nr.clone()),
                "vorgang" => text_cell(key, e.vorgang_nr.clone().unwrap_or_default()),
                "wbs" => text_cell(key, label.clone()),
                "projekt" | "project" => text_cell(key, r.project_code.clone()),
                "leistungsart" => text_cell(key, e.leistungsart.clone().unwrap_or_default()),
                "status" => text_cell(key, status_name(e.status_flag)),
                "text" | "beschreibung" => text_cell(key, e.description.clone()),
                "stunden" | "hours" => number_cell(key, minutes as f64 / 60.0),
                "minuten" | "minutes" => number_cell(key, minutes as f64),
                "datum" | "tag" | "date" => date_cell(key, Some(&day)),
                _ => return None,
            })
        };
        if !passes(&q.filters, ctx.today, find) {
            continue;
        }
        let hours = minutes as f64 / 60.0;
        match group.as_str() {
            "" => {}
            "netzplan" => bump(&mut groups, &r.netzplan_nr, hours),
            "projekt" => bump(&mut groups, &r.project_code, hours),
            "tag" | "datum" | "day" => bump(&mut groups, &day, hours),
            "leistungsart" => bump(&mut groups, e.leistungsart.as_deref().unwrap_or(""), hours),
            "status" => bump(&mut groups, status_name(e.status_flag), hours),
            _ => bump(&mut groups, &label, hours),
        }
        sum += minutes;
        rows.push(QueryRow {
            key: format!("e{}", e.id),
            title: if e.description.is_empty() { label.clone() } else { e.description.clone() },
            detail: label,
            date: Some(e.start_time.to_rfc3339()),
            page_id: e.page_id,
            minutes: Some(minutes),
            ..Default::default()
        });
    }
    Ok((rows, groups, Some(sum)))
}

// ----------------------------------------------------------------------- events

fn events<Tz: TimeZone>(ctx: &Ctx<Tz>, q: &Query) -> Result<(Vec<QueryRow>, Groups, Option<i64>)> {
    let days = if q.days == 0 { 7 } else { q.days.min(31) } as i64;
    let list = ctx.events(ctx.day_start(ctx.today), ctx.day_start(ctx.today + Duration::days(days)))?;
    let words = words(&q.text);
    let group = q.group.trim().to_lowercase();
    let mut rows = vec![];
    let mut groups: Groups = vec![];
    for e in list {
        let ev = &e.event;
        let hay = format!("{} {}", ev.title, ev.location).to_lowercase();
        if !words.iter().all(|w| hay.contains(w)) {
            continue;
        }
        let day = ctx.local_day(ev.start).format("%Y-%m-%d").to_string();
        let find = |key: &str| -> Option<Cell> {
            Some(match key {
                "titel" | "title" => text_cell(key, ev.title.clone()),
                "ort" | "location" => text_cell(key, ev.location.clone()),
                "kalender" | "calendar" => text_cell(key, e.source.clone()),
                "organisator" => text_cell(key, ev.organizer.clone()),
                "teilnehmer" => Cell {
                    key: key.to_owned(),
                    text: ev.attendees.join(", "),
                    value: Some(Typed::MultiSelect(ev.attendees.clone())),
                    error: None,
                },
                "gebucht" => text_cell(key, if e.entry_id.is_some() { "ja" } else { "nein" }),
                "datum" | "tag" | "date" => date_cell(key, Some(&day)),
                _ => return None,
            })
        };
        if !passes(&q.filters, ctx.today, find) {
            continue;
        }
        match group.as_str() {
            "" => {}
            "kalender" | "calendar" => bump(&mut groups, &e.source, 1.0),
            _ => bump(&mut groups, &day, 1.0),
        }
        rows.push(QueryRow {
            key: format!("m{}", e.key),
            title: ev.title.clone(),
            detail: ev.location.clone(),
            date: Some(ev.start.to_rfc3339()),
            page_id: e.note_page_id,
            minutes: Some((ev.end - ev.start).num_minutes().max(0)),
            event_key: Some(e.key.clone()),
            done: Some(e.entry_id.is_some()),
            ..Default::default()
        });
    }
    Ok((rows, groups, None))
}
