//! „Statusbericht“ on demand: for a scope (a Netzplan, a Jira project, a folder or a tag) and a
//! period (this week, last week, this or last month, custom) – the hours booked per WBS element
//! and activity type against the budget, the Jira progress (done, in progress, new, blocked;
//! the active sprint's numbers), the notes changed and the decisions written in them, the
//! deadlines ahead and the risks. Written as a page from a template of sections ([`SECTIONS`],
//! [`markdown`]) with an optional AI paragraph (at most [`PROMPT_BUDGET`] characters of
//! context), exported by the UI to PDF, Markdown or a mail draft.
//!
//! The same scope and period write the same page again: only its generated part is replaced
//! ([`super::block`]). Templates (scope, period, sections) are kept per workspace
//! ([`TEMPLATES_KEY`]); the last report is what the start page widget shows ([`LAST_KEY`]).

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use super::{DECISION_HEADINGS, block, clip, heading_level, items_under};
use crate::ai::client::ChatMessage;
use crate::db::{Database, EntryFilter};
use crate::error::{Error, Result};
use crate::issues::{Issue, IssueFilter, find_keys, project_of};
use crate::model::{Page, StatusFlag};
use crate::settings::Settings;
use crate::tasks::{TaskFilter, TaskStatus};
use crate::tracking::AlertLevel;
use crate::{tr, trf};

/// Characters of context in the request for the summary paragraph (about 600 tokens).
pub const PROMPT_BUDGET: usize = 2400;
/// Meta row with the saved templates (JSON list of [`ReportTemplate`]).
pub const TEMPLATES_KEY: &str = "status.templates";
/// Meta row with the last report ([`LastReport`] as JSON).
pub const LAST_KEY: &str = "status.last";
/// Meta row prefix: `status.page.<scope>:<from>:<to>` → the report page of that scope and period.
pub const PAGE_KEY: &str = "status.page.";
/// The sections in their default order.
pub const SECTIONS: [&str; 6] = ["summary", "hours", "jira", "notes", "deadlines", "risks"];
/// Rows per list.
const MAX_ROWS: usize = 15;
/// Days ahead for „Termine und Fristen“.
const AHEAD_DAYS: i64 = 42;
/// Longest custom period.
const MAX_DAYS: i64 = 370;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Netzplan,
    Jira,
    Folder,
    Tag,
}

/// What a report is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Scope {
    pub kind: ScopeKind,
    /// The Netzplan's or the folder's id, the Jira project key, the tag (without `#`).
    pub id: String,
    pub label: String,
}

impl Scope {
    fn key(&self) -> String {
        let kind = serde_json::to_value(self.kind).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default();
        format!("{kind}:{}", self.id)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeriodKind {
    #[default]
    ThisWeek,
    LastWeek,
    Month,
    LastMonth,
    Custom,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Period {
    pub kind: PeriodKind,
    #[serde(default)]
    pub from: Option<NaiveDate>,
    #[serde(default)]
    pub to: Option<NaiveDate>,
}

/// The days of `p` as of `today` (both inclusive).
pub fn resolve(p: &Period, today: NaiveDate) -> Result<(NaiveDate, NaiveDate)> {
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let first = today.with_day(1).unwrap_or(today);
    let out = match p.kind {
        PeriodKind::ThisWeek => (monday, monday + Duration::days(6)),
        PeriodKind::LastWeek => (monday - Duration::days(7), monday - Duration::days(1)),
        PeriodKind::Month => {
            let next = if first.month() == 12 {
                NaiveDate::from_ymd_opt(first.year() + 1, 1, 1)
            } else {
                NaiveDate::from_ymd_opt(first.year(), first.month() + 1, 1)
            };
            (first, next.map_or(first, |n| n - Duration::days(1)))
        }
        PeriodKind::LastMonth => {
            let end = first - Duration::days(1);
            (end.with_day(1).unwrap_or(end), end)
        }
        PeriodKind::Custom => {
            let (Some(from), Some(to)) = (p.from, p.to) else {
                return Err(Error::State(
                    tr!("Bitte Anfang und Ende wählen", "Please choose a start and an end").into(),
                ));
            };
            if to < from {
                return Err(Error::State(tr!("Das Ende liegt vor dem Anfang", "The end is before the start").into()));
            }
            if (to - from).num_days() > MAX_DAYS {
                return Err(Error::State(tr!("Höchstens ein Jahr", "At most one year").into()));
            }
            (from, to)
        }
    };
    Ok(out)
}

/// The period as a title part: „KW 40/2026“, „Oktober 2026“, „01.10.2026–15.10.2026“.
pub fn period_label(p: &Period, from: NaiveDate, to: NaiveDate) -> String {
    match p.kind {
        PeriodKind::ThisWeek | PeriodKind::LastWeek => {
            let w = from.iso_week();
            trf!("KW {}/{}", "Week {} {}", w.week(), w.year())
        }
        PeriodKind::Month | PeriodKind::LastMonth => {
            format!("{} {}", crate::filing::month_name(from.month(), crate::i18n::lang()), from.year())
        }
        PeriodKind::Custom => {
            let f = tr!("%d.%m.%Y", "%Y-%m-%d");
            format!("{}–{}", from.format(f), to.format(f))
        }
    }
}

/// A saved report template.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportTemplate {
    pub id: String,
    pub name: String,
    pub scope: Scope,
    pub period: PeriodKind,
    /// Section ids in order ([`SECTIONS`]).
    pub sections: Vec<String>,
    #[serde(default)]
    pub ai: bool,
}

/// What to write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportRequest {
    pub scope: Scope,
    pub period: Period,
    /// Section ids in order; empty = all.
    #[serde(default)]
    pub sections: Vec<String>,
    #[serde(default)]
    pub ai: bool,
}

/// The last report written (start page widget).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LastReport {
    pub page_id: i64,
    pub title: String,
    pub request: ReportRequest,
    pub at: DateTime<Utc>,
}

// ------------------------------------------------------------------ data

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HoursRow {
    /// `NP-8801/1020`.
    pub label: String,
    pub title: String,
    pub leistungsart: String,
    pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetRow {
    pub label: String,
    pub planned_hours: f64,
    pub booked_hours: f64,
    pub consumed: f64,
    pub level: AlertLevel,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportHours {
    pub total_minutes: i64,
    pub rows: Vec<HoursRow>,
    pub budget: Vec<BudgetRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportIssue {
    pub key: String,
    pub summary: String,
    pub status: String,
    pub assignee: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SprintNumbers {
    pub name: String,
    pub total: usize,
    pub done: usize,
    pub remaining: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ReportJira {
    /// Resolved within the period.
    pub done: Vec<ReportIssue>,
    pub in_progress: Vec<ReportIssue>,
    pub new: Vec<ReportIssue>,
    pub blocked: Vec<ReportIssue>,
    pub sprint: Option<SprintNumbers>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReportNote {
    pub page_id: i64,
    pub title: String,
    pub updated: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Decision {
    pub text: String,
    pub page_title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Deadline {
    /// `YYYY-MM-DD`.
    pub date: String,
    pub text: String,
    /// The page title of a task, the key of an issue.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Risk {
    /// `blocked`, `overdue`, `budget` or `noted` (a risk list in a note).
    pub kind: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusReport {
    pub scope: Scope,
    pub from: NaiveDate,
    pub to: NaiveDate,
    /// `None` while time tracking is off.
    pub hours: Option<ReportHours>,
    /// `None` without a Jira site.
    pub jira: Option<ReportJira>,
    pub notes: Vec<ReportNote>,
    pub decisions: Vec<Decision>,
    pub deadlines: Vec<Deadline>,
    pub risks: Vec<Risk>,
    /// Something private is in it: the AI text is written by the local model only.
    pub private: bool,
}

/// The pages of a scope: `(id, title, content, updated_at)`.
fn scope_pages(db: &Database, scope: &Scope) -> Result<Vec<(i64, String, String, String)>> {
    let c = db.conn();
    let map = |r: &rusqlite::Row| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?));
    let alive = "deleted_at IS NULL AND IFNULL(kind, '') <> 'canvas'";
    let rows: Vec<(i64, String, String, String)> = match scope.kind {
        ScopeKind::Folder => {
            let id: i64 =
                scope.id.parse().map_err(|_| Error::State(tr!("Ordner nicht gefunden", "Folder not found").into()))?;
            let mut st = c.prepare(&format!(
                "WITH RECURSIVE sub(id) AS (SELECT ?1 UNION ALL SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
                 SELECT id, title, content, updated_at FROM pages WHERE id IN (SELECT id FROM sub) AND {alive}"
            ))?;
            st.query_map([id], map)?.collect::<rusqlite::Result<_>>()?
        }
        ScopeKind::Tag => {
            let tag = scope.id.trim_start_matches('#').to_lowercase();
            let mut st = c.prepare(&format!(
                "SELECT id, title, content, updated_at FROM pages
                 WHERE id IN (SELECT page_id FROM page_tags WHERE tag = ?1) AND {alive}"
            ))?;
            st.query_map([tag], map)?.collect::<rusqlite::Result<_>>()?
        }
        ScopeKind::Netzplan => {
            let id: i64 = scope.id.parse().map_err(|_| Error::not_found("netzplan", scope.id.clone()))?;
            let np = db.netzplan_by_id(id)?;
            let mut st = c.prepare(&format!(
                "SELECT id, title, content, updated_at FROM pages
                 WHERE {alive} AND (instr(content, ?1) > 0 OR (?2 <> '' AND instr(content, ?2) > 0)
                       OR id IN (SELECT page_id FROM time_entries WHERE netzplan_id = ?3 AND page_id IS NOT NULL))"
            ))?;
            st.query_map(params![np.netzplan_nr, np.wbs_element, id], map)?.collect::<rusqlite::Result<_>>()?
        }
        ScopeKind::Jira => {
            let key = scope.id.to_uppercase();
            let projects: HashSet<String> = [key.clone()].into_iter().collect();
            let mut st = c.prepare(&format!(
                "SELECT id, title, content, updated_at FROM pages
                 WHERE {alive} AND (instr(content, ?1) > 0 OR file_group = ?2 OR substr(file_group, 1, length(?3)) = ?3)"
            ))?;
            let rows: Vec<(i64, String, String, String)> = st
                .query_map(params![format!("{key}-"), key, format!("{key} ")], map)?
                .collect::<rusqlite::Result<_>>()?;
            rows.into_iter()
                .filter(|(_, title, content, _)| {
                    !find_keys(content, &projects).is_empty() || title.starts_with(&key) || content.contains(&key)
                })
                .collect()
        }
    };
    // Prep pages and earlier reports are not „notes of the project“.
    Ok(rows
        .into_iter()
        .filter(|(id, _, _, _)| {
            db.meta_get(&format!("{}{id}", super::prep::EVENT_KEY)).ok().flatten().is_none()
                && db.meta_get(&format!("{REPORT_PAGE}{id}")).ok().flatten().is_none()
        })
        .collect())
}

/// Meta row prefix marking a report page (`status.report.<page id>`).
const REPORT_PAGE: &str = "status.report.";

/// The issues of a scope.
fn scope_issues(db: &Database, scope: &Scope, pages: &[(i64, String, String, String)]) -> Result<Vec<Issue>> {
    let all = db.issues_list(&IssueFilter { all: true, limit: Some(5000), ..Default::default() })?;
    let projects = db.issue_project_keys()?;
    let mut keys: HashSet<String> = HashSet::new();
    for (_, _, content, _) in pages {
        for (_, _, k) in find_keys(content, &projects) {
            keys.insert(k);
        }
    }
    let mut mapped_projects: HashSet<String> = HashSet::new();
    match scope.kind {
        ScopeKind::Jira => {
            mapped_projects.insert(scope.id.to_uppercase());
        }
        ScopeKind::Netzplan => {
            let np = db.netzplan_by_id(scope.id.parse().unwrap_or_default())?;
            for m in db.issue_wbs_list()? {
                let base = m.reference.split('/').next().unwrap_or("").trim();
                if base.eq_ignore_ascii_case(&np.netzplan_nr) || (!np.wbs_element.is_empty() && base == np.wbs_element)
                {
                    if m.kind == "project" {
                        mapped_projects.insert(m.key.to_uppercase());
                    } else {
                        keys.insert(m.key.clone());
                    }
                }
            }
        }
        _ => {}
    }
    Ok(all
        .into_iter()
        .filter(|i| mapped_projects.contains(&i.project_key.to_uppercase()) || keys.contains(&i.key))
        .collect())
}

fn report_issue(i: &Issue) -> ReportIssue {
    ReportIssue {
        key: i.key.clone(),
        summary: i.summary.clone(),
        status: i.status.clone(),
        assignee: i.assignee.clone(),
        url: i.url.clone(),
    }
}

/// The Jira part from the scope's issues for the days `from..=to`.
pub fn jira_progress(issues: &[Issue], from: NaiveDate, to: NaiveDate) -> ReportJira {
    let mut j = ReportJira::default();
    let resolved_in = |i: &Issue| {
        i.resolved
            .as_deref()
            .and_then(|r| DateTime::parse_from_rfc3339(r).ok())
            .map(|t| t.date_naive())
            .is_some_and(|d| d >= from && d <= to)
    };
    let mut sorted: Vec<&Issue> = issues.iter().collect();
    sorted.sort_by(|a, b| a.key.cmp(&b.key));
    for i in &sorted {
        if i.done() {
            if resolved_in(i) {
                j.done.push(report_issue(i));
            }
        } else if crate::briefing::is_blocked(i) {
            j.blocked.push(report_issue(i));
        } else if i.status_category == "new" {
            j.new.push(report_issue(i));
        } else {
            j.in_progress.push(report_issue(i));
        }
    }
    // The active sprint most of the scope's issues are in.
    let mut sprints: BTreeMap<&str, usize> = BTreeMap::new();
    for i in issues.iter().filter(|i| i.sprint_state == "active" && !i.sprint.is_empty()) {
        *sprints.entry(i.sprint.as_str()).or_default() += 1;
    }
    if let Some((name, _)) = sprints.iter().max_by_key(|(_, n)| **n) {
        let in_sprint: Vec<&Issue> = issues.iter().filter(|i| i.sprint == *name).collect();
        let done = in_sprint.iter().filter(|i| i.done()).count();
        j.sprint = Some(SprintNumbers {
            name: (*name).to_owned(),
            total: in_sprint.len(),
            done,
            remaining: in_sprint.len() - done,
        });
    }
    j
}

/// Decisions in a note: the items under decision headings, headings that name a decision
/// („### Entscheidung: …“) and lines tagged `#entscheidung` / `#decision`.
pub fn decisions_in(content: &str) -> Vec<String> {
    let mut out: Vec<String> = items_under(content, DECISION_HEADINGS);
    for line in content.lines() {
        let t = line.trim();
        if let Some(level) = heading_level(t) {
            let h = t[level..].trim();
            let lower = h.to_lowercase();
            if !DECISION_HEADINGS.contains(&lower.trim_end_matches(':')) {
                for p in ["entscheidung:", "decision:", "beschluss:"] {
                    if lower.starts_with(p) {
                        out.push(h[p.len()..].trim().to_owned());
                    }
                }
            }
            continue;
        }
        let lower = t.to_lowercase();
        if lower.contains("#entscheidung") || lower.contains("#decision") {
            let text = super::list_item(t).unwrap_or(t);
            let cleaned: Vec<&str> = text
                .split_whitespace()
                .filter(|w| !w.eq_ignore_ascii_case("#entscheidung") && !w.eq_ignore_ascii_case("#decision"))
                .collect();
            out.push(cleaned.join(" "));
        }
    }
    out.retain(|d| !d.trim().is_empty());
    out.dedup();
    out
}

/// The report of `req` as of `today` (local days in `tz`).
pub fn build<Tz: TimeZone>(
    db: &Database,
    req: &ReportRequest,
    settings: &Settings,
    today: NaiveDate,
    tz: &Tz,
) -> Result<StatusReport> {
    let (from, to) = resolve(&req.period, today)?;
    if req.scope.kind == ScopeKind::Jira && settings.jira.active().next().is_none() {
        return Err(Error::State(
            tr!("Jira ist nicht eingerichtet (Einstellungen → Jira).", "Jira is not set up (Settings → Jira).").into(),
        ));
    }
    let markers = crate::ai::privacy::normalize(&settings.router.private_markers);
    let marked = |t: &str| crate::ai::privacy::any_private([t], &markers);
    let mut private = false;
    let pages = scope_pages(db, &req.scope)?;
    let start = crate::feed::day_start(from, tz);
    let end = crate::feed::day_start(to + Duration::days(1), tz);
    let in_period = |updated: &str| crate::db::parse_ts(updated).is_ok_and(|t| t >= start && t < end);

    // ---- hours
    let hours = if settings.time_tracking() { Some(hours(db, req, &pages, start, end, settings)?) } else { None };

    // ---- Jira
    let issues =
        if settings.jira.active().next().is_some() { Some(scope_issues(db, &req.scope, &pages)?) } else { None };
    let jira = issues.as_ref().map(|list| jira_progress(list, from, to));
    if let Some(list) = &issues {
        private |= list.iter().any(|i| marked(&i.summary));
    }

    // ---- notes and decisions
    let mut changed: Vec<&(i64, String, String, String)> = pages.iter().filter(|p| in_period(&p.3)).collect();
    changed.sort_by(|a, b| b.3.cmp(&a.3));
    let mut notes = vec![];
    let mut decisions = vec![];
    for (id, title, content, updated) in &changed {
        private |= marked(content);
        if notes.len() < MAX_ROWS {
            notes.push(ReportNote { page_id: *id, title: title.clone(), updated: updated.clone() });
        }
        for d in decisions_in(content) {
            if decisions.len() < MAX_ROWS {
                decisions.push(Decision { text: clip(&d, 220), page_title: title.clone() });
            }
        }
    }

    // ---- deadlines and risks
    let today_s = today.format("%Y-%m-%d").to_string();
    let horizon = (today + Duration::days(AHEAD_DAYS)).format("%Y-%m-%d").to_string();
    let mut deadlines = vec![];
    let mut risks = vec![];
    for (id, title, _, _) in &pages {
        for t in db.list_tasks(&TaskFilter { status: TaskStatus::Open, page_id: Some(*id), ..Default::default() })? {
            let Some(due) = t.due.clone() else { continue };
            if due < today_s {
                risks.push(Risk {
                    kind: "overdue".into(),
                    text: trf!("{} (fällig {due}, {title})", "{} (due {due}, {title})", t.text),
                });
            } else if due <= horizon {
                deadlines.push(Deadline { date: due, text: t.text, source: title.clone() });
            }
        }
    }
    if let Some(list) = &issues {
        for i in list.iter().filter(|i| !i.done()) {
            match i.due_date.as_deref() {
                Some(d) if d < today_s.as_str() => risks.push(Risk {
                    kind: "overdue".into(),
                    text: trf!("{} {} (fällig {d})", "{} {} (due {d})", i.key, i.summary),
                }),
                Some(d) if d <= horizon.as_str() => {
                    deadlines.push(Deadline { date: d.to_owned(), text: i.summary.clone(), source: i.key.clone() })
                }
                _ => {}
            }
            if crate::briefing::is_blocked(i) {
                risks.push(Risk { kind: "blocked".into(), text: format!("{} {} ({})", i.key, i.summary, i.status) });
            }
        }
    }
    if let Some(h) = &hours {
        for b in h.budget.iter().filter(|b| matches!(b.level, AlertLevel::Critical | AlertLevel::Exceeded)) {
            risks.push(Risk {
                kind: "budget".into(),
                text: trf!(
                    "{}: {:.1} von {:.1} h verbraucht ({:.0} %)",
                    "{}: {:.1} of {:.1} h used ({:.0} %)",
                    b.label,
                    b.booked_hours,
                    b.planned_hours,
                    b.consumed * 100.0
                ),
            });
        }
    }
    for (_, title, content, _) in &changed {
        for r in items_under(content, &["risiken", "risks", "risiko", "risk"]) {
            risks.push(Risk { kind: "noted".into(), text: format!("{} ({title})", clip(&r, 200)) });
        }
    }
    deadlines.sort_by(|a, b| a.date.cmp(&b.date).then_with(|| a.text.cmp(&b.text)));
    deadlines.truncate(MAX_ROWS);
    risks.truncate(MAX_ROWS);
    Ok(StatusReport { scope: req.scope.clone(), from, to, hours, jira, notes, decisions, deadlines, risks, private })
}

/// Hours of the period in the scope: per WBS element and activity type, plus the budget of the
/// Netzplan (of a Jira project: the Netzplan it books on).
fn hours(
    db: &Database,
    req: &ReportRequest,
    pages: &[(i64, String, String, String)],
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    settings: &Settings,
) -> Result<ReportHours> {
    let netzplan = match req.scope.kind {
        ScopeKind::Netzplan => req.scope.id.parse::<i64>().ok(),
        ScopeKind::Jira => db
            .conn()
            .query_row(
                "SELECT reference FROM issue_wbs_map WHERE kind = 'project' AND key = ?1",
                [req.scope.id.to_uppercase()],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|r| db.netzplan_by_ref(r.split('/').next().unwrap_or("")).ok())
            .map(|np| np.id),
        _ => None,
    };
    let entries = db.list_time_entries(&EntryFilter {
        from: Some(start),
        to: Some(end),
        netzplan_id: if req.scope.kind == ScopeKind::Netzplan { netzplan } else { None },
        status: None,
    })?;
    let page_ids: HashSet<i64> = pages.iter().map(|p| p.0).collect();
    let jira_entries: HashSet<i64> = if req.scope.kind == ScopeKind::Jira {
        let mut st = db.conn().prepare("SELECT entry_id, issue_key FROM time_entry_issues")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        let key = req.scope.id.to_uppercase();
        rows.filter_map(|r| r.ok()).filter(|(_, k)| project_of(k) == key).map(|(id, _)| id).collect()
    } else {
        HashSet::new()
    };
    let mut rows: Vec<HoursRow> = vec![];
    let mut total = 0;
    let mut titles: BTreeMap<i64, Vec<crate::model::Vorgang>> = BTreeMap::new();
    for row in entries {
        let e = &row.entry;
        if e.status_flag == StatusFlag::Running {
            continue;
        }
        let keep = match req.scope.kind {
            ScopeKind::Netzplan => true,
            ScopeKind::Jira => jira_entries.contains(&e.id),
            ScopeKind::Folder | ScopeKind::Tag => e.page_id.is_some_and(|p| page_ids.contains(&p)),
        };
        let Some(minutes) = e.duration_minutes.filter(|_| keep) else { continue };
        total += minutes;
        let label = match &e.vorgang_nr {
            Some(v) => format!("{}/{v}", row.netzplan_nr),
            None => row.netzplan_nr.clone(),
        };
        let la = e.leistungsart.clone().unwrap_or_default();
        if let Some(r) = rows.iter_mut().find(|r| r.label.eq_ignore_ascii_case(&label) && r.leistungsart == la) {
            r.minutes += minutes;
            continue;
        }
        if let std::collections::btree_map::Entry::Vacant(v) = titles.entry(e.netzplan_id) {
            v.insert(db.list_vorgaenge(e.netzplan_id)?);
        }
        let title = match &e.vorgang_nr {
            Some(v) => titles[&e.netzplan_id]
                .iter()
                .find(|x| x.vorgang_nr.eq_ignore_ascii_case(v))
                .map(|x| x.description.clone())
                .unwrap_or_default(),
            None => db.netzplan_by_id(e.netzplan_id).map(|n| n.description).unwrap_or_default(),
        };
        rows.push(HoursRow { label, title, leistungsart: la, minutes });
    }
    rows.sort_by(|a, b| b.minutes.cmp(&a.minutes).then_with(|| a.label.cmp(&b.label)));
    let budget = match netzplan {
        Some(id) => crate::tracking::budget_status(db, id, &settings.thresholds)?
            .into_iter()
            .filter(|b| b.planned_hours > 0.0 || b.booked_hours > 0.0)
            .map(|b| BudgetRow {
                label: b.label,
                planned_hours: b.planned_hours,
                booked_hours: b.booked_hours,
                consumed: b.consumed,
                level: b.level,
            })
            .collect(),
        None => vec![],
    };
    Ok(ReportHours { total_minutes: total, rows, budget })
}

// ------------------------------------------------------------------ page

fn hm(minutes: i64) -> String {
    format!("{}:{:02}", minutes / 60, minutes % 60)
}

fn issue_line(i: &ReportIssue) -> String {
    let key = if i.url.is_empty() { i.key.clone() } else { format!("[{}]({})", i.key, i.url) };
    let who = if i.assignee.is_empty() { String::new() } else { format!(" · {}", i.assignee) };
    format!("- {key} {} – {}{who}\n", i.summary, i.status)
}

/// The sections of `r` in the order of `sections` (empty: [`SECTIONS`]) as the generated part of
/// the report page; `ai` is the summary paragraph.
pub fn markdown(r: &StatusReport, sections: &[String], ai: Option<&str>, generated: &str) -> String {
    let order: Vec<&str> = if sections.is_empty() {
        SECTIONS.to_vec()
    } else {
        sections.iter().map(String::as_str).filter(|s| SECTIONS.contains(s)).collect()
    };
    let f = tr!("%d.%m.%Y", "%Y-%m-%d");
    let mut m = trf!(
        "*{} · {}–{} · erstellt {generated}*\n\n",
        "*{} · {}–{} · generated {generated}*\n\n",
        r.scope.label,
        r.from.format(f),
        r.to.format(f)
    );
    for s in order {
        match s {
            "summary" => {
                if let Some(text) = ai.map(str::trim).filter(|t| !t.is_empty()) {
                    m.push_str(tr!("## Zusammenfassung\n\n", "## Summary\n\n"));
                    m.push_str(text);
                    m.push_str("\n\n");
                }
            }
            "hours" => {
                let Some(h) = &r.hours else { continue };
                m.push_str(tr!("## Gebuchte Stunden\n\n", "## Hours booked\n\n"));
                if h.rows.is_empty() {
                    m.push_str(tr!("Keine Buchungen im Zeitraum.\n\n", "No bookings in the period.\n\n"));
                } else {
                    m.push_str(tr!(
                        "| PSP / Vorgang | Bezeichnung | Leistungsart | Stunden |\n|---|---|---|---:|\n",
                        "| WBS / activity | Description | Activity type | Hours |\n|---|---|---|---:|\n"
                    ));
                    for row in &h.rows {
                        m.push_str(&format!(
                            "| {} | {} | {} | {} |\n",
                            row.label,
                            row.title.replace('|', "/"),
                            row.leistungsart,
                            hm(row.minutes)
                        ));
                    }
                    m.push_str(&trf!(
                        "| **Summe** | | | **{}** |\n\n",
                        "| **Total** | | | **{}** |\n\n",
                        hm(h.total_minutes)
                    ));
                }
                if !h.budget.is_empty() {
                    m.push_str(tr!(
                        "**Budget (gesamt)**\n\n| PSP / Vorgang | Plan (h) | Gebucht (h) | Verbrauch |\n|---|---:|---:|---:|\n",
                        "**Budget (overall)**\n\n| WBS / activity | Plan (h) | Booked (h) | Used |\n|---|---:|---:|---:|\n"
                    ));
                    for b in &h.budget {
                        let flag = match b.level {
                            AlertLevel::Exceeded => tr!(" (überschritten)", " (exceeded)"),
                            AlertLevel::Critical => tr!(" (kritisch)", " (critical)"),
                            _ => "",
                        };
                        m.push_str(&format!(
                            "| {} | {:.1} | {:.1} | {:.0} %{flag} |\n",
                            b.label,
                            b.planned_hours,
                            b.booked_hours,
                            b.consumed * 100.0
                        ));
                    }
                    m.push('\n');
                }
            }
            "jira" => {
                let Some(j) = &r.jira else { continue };
                m.push_str(tr!("## Jira-Fortschritt\n\n", "## Jira progress\n\n"));
                m.push_str(&trf!(
                    "Erledigt: {} · In Arbeit: {} · Neu: {} · Blockiert: {}\n\n",
                    "Done: {} · In progress: {} · New: {} · Blocked: {}\n\n",
                    j.done.len(),
                    j.in_progress.len(),
                    j.new.len(),
                    j.blocked.len()
                ));
                if let Some(s) = &j.sprint {
                    m.push_str(&trf!(
                        "Sprint „{}“: {} von {} erledigt, {} offen\n\n",
                        "Sprint “{}”: {} of {} done, {} remaining\n\n",
                        s.name,
                        s.done,
                        s.total,
                        s.remaining
                    ));
                }
                for (title, list) in [
                    (tr!("Erledigt", "Done"), &j.done),
                    (tr!("In Arbeit", "In progress"), &j.in_progress),
                    (tr!("Neu", "New"), &j.new),
                    (tr!("Blockiert", "Blocked"), &j.blocked),
                ] {
                    if list.is_empty() {
                        continue;
                    }
                    m.push_str(&format!("**{title}**\n\n"));
                    for i in list.iter().take(MAX_ROWS) {
                        m.push_str(&issue_line(i));
                    }
                    if list.len() > MAX_ROWS {
                        m.push_str(&trf!("- … und {} weitere\n", "- … and {} more\n", list.len() - MAX_ROWS));
                    }
                    m.push('\n');
                }
            }
            "notes" => {
                m.push_str(tr!("## Notizen und Entscheidungen\n\n", "## Notes and decisions\n\n"));
                if r.notes.is_empty() {
                    m.push_str(tr!("Keine geänderten Notizen im Zeitraum.\n\n", "No notes changed in the period.\n\n"));
                } else {
                    for n in &r.notes {
                        m.push_str(&format!("- [[{}]]\n", n.title.replace(['[', ']'], "")));
                    }
                    m.push('\n');
                }
                if !r.decisions.is_empty() {
                    m.push_str(tr!("**Entscheidungen**\n\n", "**Decisions**\n\n"));
                    for d in &r.decisions {
                        m.push_str(&format!("- {} ({})\n", d.text, d.page_title));
                    }
                    m.push('\n');
                }
            }
            "deadlines" => {
                m.push_str(tr!("## Termine und Fristen\n\n", "## Milestones and deadlines\n\n"));
                if r.deadlines.is_empty() {
                    m.push_str(tr!("Keine anstehenden Fristen.\n\n", "No upcoming deadlines.\n\n"));
                } else {
                    for d in &r.deadlines {
                        let date = NaiveDate::parse_from_str(&d.date, "%Y-%m-%d")
                            .map(|x| x.format(f).to_string())
                            .unwrap_or_else(|_| d.date.clone());
                        m.push_str(&format!("- {date}: {} ({})\n", d.text, d.source));
                    }
                    m.push('\n');
                }
            }
            "risks" => {
                m.push_str(tr!("## Risiken und Blockaden\n\n", "## Risks and blockers\n\n"));
                if r.risks.is_empty() {
                    m.push_str(tr!("Keine bekannten Risiken.\n\n", "No known risks.\n\n"));
                } else {
                    for x in &r.risks {
                        m.push_str(&format!("- {}\n", x.text));
                    }
                    m.push('\n');
                }
            }
            _ => {}
        }
    }
    m.trim_end().to_owned()
}

/// The request for the summary paragraph: counts and titles, at most [`PROMPT_BUDGET`]
/// characters.
pub fn ai_messages(r: &StatusReport) -> Vec<ChatMessage> {
    let system = tr!(
        "Du schreibst die Zusammenfassung eines Projekt-Statusberichts. Antworte auf Deutsch mit einem Absatz aus 3 \
         bis 5 sachlichen Sätzen: Fortschritt, Aufwand, Risiken, nächste Fristen. Nenne nur, was in den Daten steht; \
         keine Überschrift, keine Liste.",
        "You write the summary of a project status report. Answer in English with one paragraph of 3 to 5 factual \
         sentences: progress, effort, risks, next deadlines. Mention only what is in the data; no heading, no list."
    );
    let mut c = format!("Scope: {} ({} to {})\n", clip(&r.scope.label, 100), r.from, r.to);
    if let Some(h) = &r.hours {
        c.push_str(&format!("Hours booked: {}\n", hm(h.total_minutes)));
        for b in h.budget.iter().take(4) {
            c.push_str(&format!("- budget {}: {:.0} % used\n", b.label, b.consumed * 100.0));
        }
    }
    if let Some(j) = &r.jira {
        c.push_str(&format!(
            "Jira: {} done, {} in progress, {} new, {} blocked\n",
            j.done.len(),
            j.in_progress.len(),
            j.new.len(),
            j.blocked.len()
        ));
        for i in j.done.iter().take(5) {
            c.push_str(&format!("- done: {} {}\n", i.key, clip(&i.summary, 80)));
        }
        for i in j.blocked.iter().take(3) {
            c.push_str(&format!("- blocked: {} {}\n", i.key, clip(&i.summary, 80)));
        }
        if let Some(s) = &j.sprint {
            c.push_str(&format!("Sprint {}: {}/{} done\n", clip(&s.name, 40), s.done, s.total));
        }
    }
    c.push_str(&format!("Notes changed: {}\n", r.notes.len()));
    for d in r.decisions.iter().take(5) {
        c.push_str(&format!("- decision: {}\n", clip(&d.text, 120)));
    }
    for d in r.deadlines.iter().take(4) {
        c.push_str(&format!("- deadline {}: {}\n", d.date, clip(&d.text, 80)));
    }
    for x in r.risks.iter().take(4) {
        c.push_str(&format!("- risk: {}\n", clip(&x.text, 120)));
    }
    vec![ChatMessage::system(system), ChatMessage::user(super::followup::clip_block(&c, PROMPT_BUDGET))]
}

/// The answer as one paragraph.
pub fn clean_ai(text: &str) -> String {
    super::followup::clean_intro(text)
}

/// Templates: their saved list, normalized (known sections once each, a name).
pub fn normalize_template(mut t: ReportTemplate) -> ReportTemplate {
    let mut sections: Vec<String> = vec![];
    for s in t.sections {
        if SECTIONS.contains(&s.as_str()) && !sections.contains(&s) {
            sections.push(s);
        }
    }
    t.sections = if sections.is_empty() { SECTIONS.iter().map(|s| (*s).to_owned()).collect() } else { sections };
    t.name = t.name.trim().chars().take(80).collect();
    if t.name.is_empty() {
        t.name = t.scope.label.clone();
    }
    t
}

impl Database {
    pub fn status_templates(&self) -> Result<Vec<ReportTemplate>> {
        Ok(self.meta_get(TEMPLATES_KEY)?.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default())
    }

    /// Saves (adds or replaces by id) a template; returns the list.
    pub fn status_template_save(&self, t: ReportTemplate) -> Result<Vec<ReportTemplate>> {
        let mut list = self.status_templates()?;
        let mut t = normalize_template(t);
        if t.id.trim().is_empty() {
            let mut n = list.len() + 1;
            while list.iter().any(|x| x.id == format!("t{n}")) {
                n += 1;
            }
            t.id = format!("t{n}");
        }
        match list.iter_mut().find(|x| x.id == t.id) {
            Some(x) => *x = t,
            None => list.push(t),
        }
        self.meta_set(TEMPLATES_KEY, &serde_json::to_string(&list)?)?;
        Ok(list)
    }

    pub fn status_template_delete(&self, id: &str) -> Result<Vec<ReportTemplate>> {
        let mut list = self.status_templates()?;
        list.retain(|x| x.id != id);
        self.meta_set(TEMPLATES_KEY, &serde_json::to_string(&list)?)?;
        Ok(list)
    }

    /// The last report, while its page exists.
    pub fn status_last(&self) -> Result<Option<LastReport>> {
        let Some(last) = self.meta_get(LAST_KEY)?.and_then(|v| serde_json::from_str::<LastReport>(&v).ok()) else {
            return Ok(None);
        };
        let alive: Option<i64> = self
            .conn()
            .query_row("SELECT id FROM pages WHERE id = ?1 AND deleted_at IS NULL", [last.page_id], |r| r.get(0))
            .optional()?;
        Ok(alive.map(|_| last))
    }

    /// Writes the report page: the page of the same scope and period again (its generated part
    /// only), else a new one in „Statusberichte“. Returns the page and whether it was created.
    pub fn status_write(
        &self,
        req: &ReportRequest,
        r: &StatusReport,
        body: &str,
        now: DateTime<Utc>,
    ) -> Result<(Page, bool)> {
        self.atomic(|| {
            let key = format!("{PAGE_KEY}{}:{}:{}", req.scope.key(), r.from, r.to);
            let existing = self.meta_get(&key)?.and_then(|v| v.parse::<i64>().ok()).filter(|id| {
                self.conn()
                    .query_row("SELECT 1 FROM pages WHERE id = ?1 AND deleted_at IS NULL", [id], |_| Ok(()))
                    .optional()
                    .ok()
                    .flatten()
                    .is_some()
            });
            let (page, created) = match existing {
                Some(id) => {
                    let doc = self.page_doc(id)?;
                    let next = block::replace(&doc.content, body);
                    if next != doc.content {
                        self.save_page_content(id, &next)?;
                    }
                    (self.page(id)?, false)
                }
                None => {
                    let folder = self.reports_folder()?;
                    let base = crate::notes::clean_title(&trf!(
                        "Statusbericht {} {}",
                        "Status report {} {}",
                        req.scope.label,
                        period_label(&req.period, r.from, r.to)
                    ));
                    let mut title = base.clone();
                    let mut n = 2;
                    while self.page_by_title(&title)?.is_some() {
                        title = format!("{base} {n}");
                        n += 1;
                    }
                    let page = self.create_page(Some(folder), &title, Some("chart"))?;
                    let content = format!("{}\n\n{}", block::wrap(body), tr!("## Anmerkungen\n\n", "## Remarks\n\n"));
                    self.save_page_content(page.id, &content)?;
                    self.meta_set(&key, &page.id.to_string())?;
                    self.meta_set(&format!("{REPORT_PAGE}{}", page.id), "1")?;
                    (self.page(page.id)?, true)
                }
            };
            let last = LastReport { page_id: page.id, title: page.title.clone(), request: req.clone(), at: now };
            self.meta_set(LAST_KEY, &serde_json::to_string(&last)?)?;
            Ok((page, created))
        })
    }

    /// The top-level folder „Statusberichte“ (created when missing).
    fn reports_folder(&self) -> Result<i64> {
        let found: Option<i64> = self
            .conn()
            .query_row(
                "SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL
                   AND title IN ('Statusberichte' COLLATE NOCASE, 'Status reports' COLLATE NOCASE)
                 ORDER BY id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .optional()?;
        match found {
            Some(id) => Ok(id),
            None => Ok(self.create_page(None, tr!("Statusberichte", "Status reports"), Some("folder-kanban"))?.id),
        }
    }

    /// Whether `page_id` is a report page.
    pub fn status_is_report(&self, page_id: i64) -> Result<bool> {
        Ok(self.meta_get(&format!("{REPORT_PAGE}{page_id}"))?.is_some())
    }
}

/// The scopes to choose from: Netzplans (with time tracking), Jira projects (with a site),
/// folders (pages with subpages) and the most used tags.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScopeChoices {
    pub netzplaene: Vec<Scope>,
    pub jira: Vec<Scope>,
    pub folders: Vec<Scope>,
    pub tags: Vec<Scope>,
}

pub fn scope_choices(db: &Database, settings: &Settings) -> Result<ScopeChoices> {
    let netzplaene = if settings.time_tracking() {
        db.list_netzplaene(None)?
            .into_iter()
            .map(|n| Scope {
                kind: ScopeKind::Netzplan,
                id: n.id.to_string(),
                label: if n.description.is_empty() {
                    n.netzplan_nr
                } else {
                    format!("{} {}", n.netzplan_nr, n.description)
                },
            })
            .collect()
    } else {
        vec![]
    };
    let jira = if settings.jira.active().next().is_some() {
        let mut seen = HashSet::new();
        db.issue_projects()?
            .into_iter()
            .filter(|(_, key, _)| seen.insert(key.clone()))
            .map(|(_, key, name)| Scope {
                kind: ScopeKind::Jira,
                label: if name.is_empty() { key.clone() } else { format!("{key} {name}") },
                id: key,
            })
            .collect()
    } else {
        vec![]
    };
    let mut st = db.conn().prepare(
        "SELECT p.id, p.title FROM pages p WHERE p.deleted_at IS NULL
           AND EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL)
         ORDER BY p.parent_id IS NOT NULL, p.title COLLATE NOCASE LIMIT 60",
    )?;
    let folders = st
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(|r| r.ok())
        .map(|(id, title)| Scope { kind: ScopeKind::Folder, id: id.to_string(), label: title })
        .collect();
    let tags = db
        .tag_counts()?
        .into_iter()
        .take(40)
        .map(|(t, _)| Scope { kind: ScopeKind::Tag, label: format!("#{t}"), id: t })
        .collect();
    Ok(ScopeChoices { netzplaene, jira, folders, tags })
}
