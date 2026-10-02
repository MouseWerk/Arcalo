//! Issue trackers: the issue model, its offline cache and what notes and time tracking do with it.
//!
//! A tracker is reached through an [`IssueProvider`] (today [`jira::JiraClient`] for Jira Cloud
//! and Jira Server/Data Center; GitHub, GitLab or Azure DevOps would be further providers). The
//! shell syncs each site in the background: [`fetch_site`] runs the searches (network only), then
//! [`Database::issues_store`] writes the result in one transaction, so the database is never held
//! during a request. Everything shown afterwards reads the cache and works offline.
//!
//! * **Keys in notes**: [`find_keys`] finds `PROJ-123` of projects that have synced issues only, so
//!   `ISO-9001` or `UTF-8` never become chips.
//! * **Time tracking**: `/zeit 1h PROJ-123 Login` books on the WBS mapped to the issue or its
//!   project ([`Database::issue_wbs_for`]); the first booking with an explicit reference
//!   remembers the mapping. The key is stored with the entry (`time_entry_issues`), which also
//!   holds the state of the optional Jira worklog: a worklog id once posted, so an entry is
//!   never posted twice ([`Database::worklog_claim`]).
//! * **Tasks**: a task whose text names an issue is ticked when the issue is done in Jira.

pub mod jira;
#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Duration, NaiveDate, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::model::TimeEntry;
use crate::{tr, trf};

// ------------------------------------------------------------------ settings

/// Cloud (REST v3, e-mail and API token) or Server/Data Center (REST v2, personal access token).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum SiteKind {
    #[default]
    Cloud,
    Server,
}

impl SiteKind {
    /// The kind a site address suggests: `*.atlassian.net` (and Jira's other cloud hosts) is
    /// Cloud, anything else is a server of the company.
    pub fn guess(url: &str) -> SiteKind {
        let host = reqwest::Url::parse(&normalize_url(url))
            .ok()
            .and_then(|u| u.host_str().map(str::to_ascii_lowercase))
            .unwrap_or_default();
        if host.ends_with(".atlassian.net") || host.ends_with(".jira.com") || host.ends_with(".atlassian.com") {
            SiteKind::Cloud
        } else {
            SiteKind::Server
        }
    }
}

/// A Jira site. Its token lives in the credential store (`jira-<id>`), never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct JiraSite {
    /// `[a-z0-9-]`, stable (credential account, cache rows).
    pub id: String,
    pub name: String,
    /// `#rrggbb`.
    pub color: String,
    pub kind: SiteKind,
    /// `https://firma.atlassian.net` or `https://jira.firma.de` (a context path is kept).
    pub url: String,
    /// Cloud: the e-mail of the Atlassian account (with the API token as password).
    pub email: String,
    pub enabled: bool,
    /// „Arbeit auch in Jira protokollieren“: a booking with an issue key posts a worklog.
    pub log_work: bool,
    /// The assistant may comment on issues and change their status (each after a confirmation).
    pub allow_writes: bool,
}

impl Default for JiraSite {
    fn default() -> Self {
        JiraSite {
            id: String::new(),
            name: String::new(),
            color: PALETTE[0].into(),
            kind: SiteKind::Cloud,
            url: String::new(),
            email: String::new(),
            enabled: true,
            log_work: false,
            allow_writes: false,
        }
    }
}

/// A saved JQL search: its issues are synced with the default search and it can be shown as a
/// „Jira-Abfrage“ widget.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct SavedQuery {
    pub id: String,
    /// The site id.
    pub site: String,
    pub name: String,
    pub jql: String,
}

/// Settings → Jira.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct IssueSettings {
    pub sites: Vec<JiraSite>,
    pub queries: Vec<SavedQuery>,
    /// Minutes between background syncs.
    pub sync_minutes: u32,
    /// Tick a task naming an issue once the issue is done in Jira.
    pub tick_done_tasks: bool,
}

impl Default for IssueSettings {
    fn default() -> Self {
        IssueSettings { sites: vec![], queries: vec![], sync_minutes: 10, tick_done_tasks: true }
    }
}

/// Colors offered for sites (same as the calendars).
pub const PALETTE: [&str; 8] = crate::calsync::PALETTE;
/// At most this many sites …
pub const MAX_SITES: usize = 8;
/// … and saved queries.
pub const MAX_QUERIES: usize = 30;
/// Issues read per search and sync.
pub const MAX_PER_SEARCH: usize = 500;
/// Comments kept per issue (the newest).
pub const MAX_COMMENTS: usize = 5;
/// Characters of a description kept.
pub const MAX_DESCRIPTION: usize = 8_000;
/// The default search of every site.
pub const DEFAULT_JQL: &str = "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC";
/// The id of the default search in `matches`.
pub const MINE: &str = "mine";

/// `https://x` without a trailing slash; `x.atlassian.net` becomes `https://x.atlassian.net`.
pub fn normalize_url(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    if u.is_empty() || u.contains("://") { u.to_owned() } else { format!("https://{u}") }
}

fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(24).collect()
}

impl IssueSettings {
    /// Trims the fields, gives sites and queries unique ids, drops queries of removed sites and
    /// caps the counts.
    pub fn normalized(mut self) -> Self {
        self.sites.truncate(MAX_SITES);
        let mut ids = HashSet::new();
        for (i, s) in self.sites.iter_mut().enumerate() {
            s.name = s.name.trim().chars().take(60).collect();
            s.url = normalize_url(&s.url);
            s.email = s.email.trim().to_owned();
            if s.name.is_empty() {
                s.name = reqwest::Url::parse(&s.url)
                    .ok()
                    .and_then(|u| u.host_str().map(str::to_owned))
                    .unwrap_or_else(|| "Jira".into());
            }
            let base = if s.id.trim().is_empty() { slug(&s.name) } else { slug(&s.id) };
            let base = if base.is_empty() { format!("site-{}", i + 1) } else { base };
            let mut id = base.clone();
            let mut n = 2;
            while !ids.insert(id.clone()) {
                id = format!("{base}-{n}");
                n += 1;
            }
            s.id = id;
            if !(s.color.len() == 7 && s.color.starts_with('#')) {
                s.color = PALETTE[i % PALETTE.len()].into();
            }
        }
        let sites: HashSet<String> = self.sites.iter().map(|s| s.id.clone()).collect();
        self.queries.retain(|q| sites.contains(&q.site) && !q.jql.trim().is_empty());
        self.queries.truncate(MAX_QUERIES);
        let mut qids = HashSet::new();
        qids.insert(MINE.to_owned());
        for (i, q) in self.queries.iter_mut().enumerate() {
            q.jql = q.jql.trim().to_owned();
            q.name = q.name.trim().chars().take(60).collect();
            if q.name.is_empty() {
                q.name = q.jql.chars().take(40).collect();
            }
            let base = if q.id.trim().is_empty() { format!("q{}", i + 1) } else { slug(&q.id) };
            let mut id = base.clone();
            let mut n = 2;
            while !qids.insert(id.clone()) {
                id = format!("{base}-{n}");
                n += 1;
            }
            q.id = id;
        }
        self.sync_minutes = self.sync_minutes.clamp(1, 1440);
        self
    }

    pub fn site(&self, id: &str) -> Option<&JiraSite> {
        self.sites.iter().find(|s| s.id == id)
    }

    /// The sites that sync.
    pub fn active(&self) -> impl Iterator<Item = &JiraSite> {
        self.sites.iter().filter(|s| s.enabled)
    }

    /// The searches of `site`: the default one, then its saved queries.
    pub fn searches(&self, site: &str) -> Vec<(String, String)> {
        let mut out = vec![(MINE.to_owned(), DEFAULT_JQL.to_owned())];
        out.extend(self.queries.iter().filter(|q| q.site == site).map(|q| (q.id.clone(), q.jql.clone())));
        out
    }

    /// A new site id not taken yet.
    pub fn new_site_id(&self, name: &str) -> String {
        let base = match slug(name) {
            s if s.is_empty() => "jira".to_owned(),
            s => s,
        };
        let mut id = base.clone();
        let mut n = 2;
        while self.sites.iter().any(|s| s.id == id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        id
    }
}

// ------------------------------------------------------------------ model

/// Jira's three status categories.
pub const CATEGORIES: [&str; 3] = ["new", "indeterminate", "done"];

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct IssueComment {
    pub author: String,
    /// RFC 3339.
    pub created: String,
    pub body: String,
}

/// An issue as cached and shown.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Issue {
    pub site: String,
    pub key: String,
    pub remote_id: String,
    pub summary: String,
    pub status: String,
    /// `new`, `indeterminate` or `done`.
    pub status_category: String,
    pub priority: String,
    /// The priority as a level 1 (lowest) to 5 (highest), 0 unknown ([`priority_level`]): the
    /// colors do not depend on the language or names of the Jira instance.
    #[serde(default)]
    pub priority_level: u8,
    /// Jira's id of the priority (only while syncing: the order of the instance's list maps
    /// custom priorities, [`apply_priority_order`]).
    #[serde(default, skip_serializing)]
    pub priority_id: String,
    pub assignee: String,
    pub reporter: String,
    pub issue_type: String,
    pub project_key: String,
    pub project_name: String,
    /// Name of the newest sprint the issue is in (`""` without Agile).
    pub sprint: String,
    /// `active`, `future` or `closed`.
    pub sprint_state: String,
    /// `YYYY-MM-DD`.
    pub due_date: Option<String>,
    /// RFC 3339.
    pub updated: Option<String>,
    /// RFC 3339: when it was resolved.
    pub resolved: Option<String>,
    pub url: String,
    pub description: String,
    pub comments: Vec<IssueComment>,
    /// Searches that found it in the last sync (`mine`, saved query ids).
    #[serde(default)]
    pub matches: Vec<String>,
}

impl Issue {
    pub fn done(&self) -> bool {
        self.status_category == "done"
    }
}

/// Who a token belongs to („Verbindung testen“).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Account {
    pub display_name: String,
    /// Cloud `accountId`, Server user name.
    pub id: String,
    pub email: String,
}

/// A project with the issue types an issue can be created with.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RemoteProject {
    pub key: String,
    pub name: String,
    pub issue_types: Vec<String>,
}

/// A new issue („Jira-Issue anlegen“ on a task).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct NewIssue {
    pub project: String,
    pub issue_type: String,
    pub summary: String,
    pub description: String,
}

/// A worklog to post.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkLog {
    pub key: String,
    pub started: DateTime<Utc>,
    pub minutes: i64,
    pub comment: String,
}

/// A worklog found on an issue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteWorklog {
    pub id: String,
    pub started: DateTime<Utc>,
    pub seconds: i64,
    pub author: String,
}

/// The active sprint of a board with its issues.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Sprint {
    pub id: i64,
    pub name: String,
    pub goal: String,
    pub board: String,
    /// RFC 3339.
    pub start: Option<String>,
    pub end: Option<String>,
    pub issues: Vec<Issue>,
}

/// One day of a burndown: the issues still open at its end, and the ideal line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BurnPoint {
    pub date: NaiveDate,
    /// `None` for days still ahead.
    pub remaining: Option<usize>,
    pub ideal: f64,
}

/// A tracker an issue site lives on. Jira today; GitHub, GitLab or Azure DevOps could follow
/// with the same calls.
#[allow(async_fn_in_trait)]
pub trait IssueProvider {
    /// The site id (cache rows, keys of the settings).
    fn site(&self) -> &str;
    /// The account the token belongs to.
    async fn whoami(&self) -> Result<Account>;
    /// Issues of a query in the tracker's language (JQL), at most `limit`.
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Issue>>;
    /// One issue with its comments.
    async fn get(&self, key: &str) -> Result<Issue>;
    /// Projects the user can create issues in.
    async fn projects(&self) -> Result<Vec<RemoteProject>>;
    /// Creates an issue; returns its key.
    async fn create(&self, new: &NewIssue) -> Result<String>;
    async fn comment(&self, key: &str, body: &str) -> Result<()>;
    /// Moves the issue to the status (or transition) named `to`; returns the new status.
    async fn transition(&self, key: &str, to: &str) -> Result<String>;
    /// Posts a worklog; returns its id.
    async fn log_work(&self, work: &WorkLog) -> Result<String>;
    /// The worklogs of an issue (to find one an interrupted post left).
    async fn worklogs(&self, key: &str) -> Result<Vec<RemoteWorklog>>;
    /// Changes a posted worklog (the entry's duration, start or comment changed).
    async fn update_work(&self, id: &str, work: &WorkLog) -> Result<()>;
    /// Deletes a posted worklog (its entry was deleted). One that is gone already counts as done.
    async fn delete_work(&self, key: &str, id: &str) -> Result<()>;
    /// The active sprint of the project's board; `None` without Agile or without a sprint.
    async fn sprint(&self, project: &str) -> Result<Option<Sprint>>;
}

// ------------------------------------------------------------------ keys

fn key_char(c: char) -> bool {
    c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'
}

/// Whether `s` has the form of an issue key (`PROJ-123`).
pub fn is_key(s: &str) -> bool {
    let Some((p, n)) = s.split_once('-') else { return false };
    p.len() >= 2
        && p.len() <= 12
        && p.starts_with(|c: char| c.is_ascii_uppercase())
        && p.chars().all(key_char)
        && !n.is_empty()
        && n.len() <= 7
        && n.chars().all(|c| c.is_ascii_digit())
        && !n.starts_with('0')
}

/// The project of a key (`PROJ` of `PROJ-123`).
pub fn project_of(key: &str) -> &str {
    key.split_once('-').map_or(key, |(p, _)| p)
}

/// Issue keys in `text` whose project is in `projects`: byte ranges and keys, in order. A key
/// must stand alone (not inside a word, a path or an address).
pub fn find_keys(text: &str, projects: &HashSet<String>) -> Vec<(usize, usize, String)> {
    let bytes = text.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        let boundary = i == 0 || {
            let prev = text[..i].chars().next_back().unwrap_or(' ');
            !(prev.is_alphanumeric() || matches!(prev, '-' | '_' | '/' | '.' | '@' | '#' | '='))
        };
        if c.is_ascii_uppercase() && boundary {
            let mut j = i;
            while j < bytes.len() && key_char(bytes[j] as char) {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'-' {
                let mut k = j + 1;
                while k < bytes.len() && bytes[k].is_ascii_digit() {
                    k += 1;
                }
                let after_ok = k >= bytes.len() || {
                    let next = text[k..].chars().next().unwrap_or(' ');
                    let decimal = next == '.' && text[k + 1..].starts_with(|c: char| c.is_ascii_digit());
                    !(next.is_alphanumeric() || matches!(next, '-' | '_' | '/') || decimal)
                };
                let key = &text[i..k];
                if k > j + 1 && after_ok && is_key(key) && projects.contains(&text[i..j]) {
                    out.push((i, k, key.to_owned()));
                    i = k;
                    continue;
                }
            }
            i = j.max(i + 1);
            continue;
        }
        i += text[i..].chars().next().map_or(1, char::len_utf8);
    }
    out
}

/// Whether `text` names `key` on its own (case-sensitive, at word boundaries).
pub fn mentions(text: &str, key: &str) -> bool {
    let projects = HashSet::from([project_of(key).to_owned()]);
    find_keys(text, &projects).iter().any(|(_, _, k)| k == key)
}

// ------------------------------------------------------------------ worklog

/// Minutes Jira gets for an entry (Jira refuses worklogs under a minute).
pub fn worklog_seconds(minutes: i64) -> i64 {
    minutes.max(1) * 60
}

/// A worklog on the issue that is the one an entry posted before (same start to the minute and
/// same duration, by the same account): a post interrupted after Jira stored it is adopted
/// instead of posted again.
pub fn matching_worklog<'a>(list: &'a [RemoteWorklog], work: &WorkLog, account: &str) -> Option<&'a RemoteWorklog> {
    let want = worklog_seconds(work.minutes);
    list.iter().find(|w| {
        (w.started - work.started).num_seconds().abs() < 60
            && w.seconds == want
            && (account.is_empty() || w.author.is_empty() || w.author == account)
    })
}

/// Wait before the next try of a failed worklog: 1, 5, 15 minutes, then hourly.
pub fn worklog_retry_delay(attempts: i64) -> Duration {
    match attempts {
        ..=1 => Duration::minutes(1),
        2 => Duration::minutes(5),
        3 => Duration::minutes(15),
        _ => Duration::hours(1),
    }
}

/// A worklog to post: the entry, the issue and what to send.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PendingWorklog {
    pub entry_id: i64,
    pub site: String,
    pub work: WorkLog,
    /// Posted before: the entry changed and this worklog is updated.
    pub worklog_id: Option<String>,
    /// A try before this one may have reached Jira: look for its worklog first.
    pub retry: bool,
}

/// The worklog of a deleted entry that Jira still has to remove.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorklogDelete {
    pub id: i64,
    pub site: String,
    pub issue_key: String,
    pub worklog_id: String,
}

/// Whether a change of an entry reaches its Jira worklog: its duration (as Jira gets it), its
/// start to the minute or its comment changed.
pub fn worklog_differs(before: &TimeEntry, after: &TimeEntry) -> bool {
    worklog_seconds(before.duration_minutes.unwrap_or(0)) != worklog_seconds(after.duration_minutes.unwrap_or(0))
        || (before.start_time - after.start_time).num_seconds().abs() >= 60
        || before.description.trim() != after.description.trim()
}

/// The worklog state of a time entry (Zeiterfassung shows it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EntryIssue {
    pub entry_id: i64,
    pub issue_key: String,
    pub site: String,
    pub worklog_state: String,
    pub worklog_id: Option<String>,
    pub error: Option<String>,
    /// Whether changes reach Jira (time tracking on, the site logs work; set by the shell).
    #[serde(default)]
    pub syncs: bool,
}

// ------------------------------------------------------------------ priority

/// The level of a priority name Jira ships (English, German, Server's classic scheme): 5
/// highest to 1 lowest, 0 for a name it does not know.
fn level_of_name(name: &str) -> u8 {
    match name.trim().to_lowercase().as_str() {
        "highest" | "blocker" | "höchste" | "hoechste" | "sehr hoch" => 5,
        "high" | "critical" | "hoch" | "kritisch" => 4,
        "medium" | "major" | "mittel" | "normal" | "schwer" | "schwerwiegend" => 3,
        "low" | "minor" | "niedrig" | "gering" | "geringfügig" => 2,
        "lowest" | "trivial" | "niedrigste" | "sehr niedrig" => 1,
        _ => 0,
    }
}

/// The level of a priority, independent of the instance's language and names: a known name,
/// else the default icon (`…/images/icons/priorities/high.svg`, the same in every language),
/// else Jira's default ids 1 (highest) to 5 (lowest). 0 when nothing fits (a custom priority:
/// [`apply_priority_order`] places it by the instance's order).
pub fn priority_level(name: &str, id: &str, icon_url: &str) -> u8 {
    let by_name = level_of_name(name);
    if by_name > 0 {
        return by_name;
    }
    let file = icon_url.split(['?', '#']).next().unwrap_or("").rsplit('/').next().unwrap_or("");
    let by_icon = level_of_name(file.split('.').next().unwrap_or(""));
    if by_icon > 0 {
        return by_icon;
    }
    match id.trim().parse::<u8>() {
        Ok(n @ 1..=5) => 6 - n,
        _ => 0,
    }
}

/// Levels by position in the instance's priority list (`GET priority`, highest first): the
/// first is 5, the last 1, the others spread between.
pub fn levels_by_order(ids: &[String]) -> HashMap<String, u8> {
    let n = ids.len();
    ids.iter()
        .enumerate()
        .map(|(i, id)| {
            let level = if n <= 1 { 3 } else { 5 - ((i * 4 + (n - 1) / 2) / (n - 1)) as u8 };
            (id.clone(), level)
        })
        .collect()
}

/// Whether some issue's priority needs the instance's order to get a level.
pub fn needs_priority_order(fetched: &Fetched) -> bool {
    fetched.issues.values().any(|i| i.priority_level == 0 && !i.priority_id.is_empty())
}

/// Gives the issues whose priority is unknown by name, icon and id their place in the
/// instance's order. Returns how many changed.
pub fn apply_priority_order(fetched: &mut Fetched, order: &HashMap<String, u8>) -> usize {
    let mut n = 0;
    for i in fetched.issues.values_mut() {
        if i.priority_level == 0
            && let Some(l) = order.get(&i.priority_id)
        {
            i.priority_level = *l;
            n += 1;
        }
    }
    n
}

// ------------------------------------------------------------------ burndown

/// A simple burndown of `issues` from `start` to `end`: per day the issues not resolved by its
/// end (days after `today` stay empty), and the ideal straight line.
pub fn burndown(start: NaiveDate, end: NaiveDate, issues: &[Issue], today: NaiveDate) -> Vec<BurnPoint> {
    let end = end.max(start);
    let days = (end - start).num_days().clamp(0, 120);
    let total = issues.len();
    let resolved: Vec<Option<NaiveDate>> = issues
        .iter()
        .map(|i| {
            let at = i.resolved.as_deref().and_then(|r| DateTime::parse_from_rfc3339(r).ok()).map(|t| t.date_naive());
            match at {
                Some(d) => Some(d),
                // Done without a resolution date: counted as done today.
                None if i.done() => Some(today),
                None => None,
            }
        })
        .collect();
    (0..=days)
        .map(|n| {
            let date = start + Duration::days(n);
            let remaining =
                (date <= today).then(|| total - resolved.iter().filter(|r| r.is_some_and(|d| d <= date)).count());
            let ideal = if days == 0 { 0.0 } else { total as f64 * (1.0 - n as f64 / days as f64) };
            BurnPoint { date, remaining, ideal }
        })
        .collect()
}

// ------------------------------------------------------------------ sync

/// What the searches of one site found.
#[derive(Debug, Clone, Default)]
pub struct Fetched {
    /// By key, with the searches that found each.
    pub issues: BTreeMap<String, Issue>,
    /// Keys asked for again because no search found them any more (done, reassigned).
    pub refreshed: HashSet<String>,
    /// Searches that failed (id, message); the others are still stored.
    pub failed: Vec<(String, String)>,
}

/// Runs the searches of a site (`(id, jql)`), then asks again for the cached open issues
/// `stale` no search found (to learn that they are done). Network only: no database lock.
pub async fn fetch_site<P: IssueProvider>(p: &P, searches: &[(String, String)], stale: &[String]) -> Result<Fetched> {
    let mut out = Fetched::default();
    for (id, jql) in searches {
        match p.search(jql, MAX_PER_SEARCH).await {
            Ok(list) => {
                for mut issue in list {
                    let entry = out.issues.entry(issue.key.clone()).or_insert_with(|| {
                        issue.matches.clear();
                        issue
                    });
                    if !entry.matches.contains(id) {
                        entry.matches.push(id.clone());
                    }
                }
            }
            // The default search failing means the site failed (token, network).
            Err(e) if id == MINE => return Err(e),
            Err(e) => out.failed.push((id.clone(), e.to_string())),
        }
    }
    let missing: Vec<&String> = stale.iter().filter(|k| !out.issues.contains_key(*k)).collect();
    for chunk in missing.chunks(50) {
        let keys: Vec<&str> = chunk.iter().map(|k| k.as_str()).collect();
        // Deleted or moved issues make Jira reject the whole `key in (…)`: then they are left as they are.
        if let Ok(list) = p.search(&jira::keys_jql(&keys), keys.len()).await {
            for mut issue in list {
                issue.matches.clear();
                out.refreshed.insert(issue.key.clone());
                out.issues.insert(issue.key.clone(), issue);
            }
        }
    }
    Ok(out)
}

/// What storing a sync changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct StoreOutcome {
    pub issues: usize,
    /// Issues that are done now and were not before (their tasks may be ticked).
    pub newly_done: Vec<String>,
}

/// How the Issues page and the widgets ask for cached issues.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssueFilter {
    /// Site id; `""` = all.
    pub site: String,
    /// `mine`, a saved query id, or `""` = everything any search found.
    pub query: String,
    /// Also issues no search finds any more (the chips' cache).
    pub all: bool,
    pub limit: Option<usize>,
}

/// The sync state of a site.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SiteSync {
    pub site: String,
    pub synced_at: Option<DateTime<Utc>>,
    pub attempted_at: Option<DateTime<Utc>>,
    pub error: Option<String>,
    pub issues: i64,
    pub account: String,
}

/// A WBS mapping of an issue or a project.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WbsMapping {
    /// `issue` or `project`.
    pub kind: String,
    pub key: String,
    pub reference: String,
    pub learned: bool,
}

/// A page that names an issue.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IssueBacklink {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    /// The page is the issue's note (`jira:` property).
    pub note: bool,
}

const ISSUE_COLS: &str = "site, key, remote_id, summary, status, status_category, priority, assignee, reporter, issue_type, \
     project_key, project_name, sprint, sprint_state, due_date, updated, resolved, url, description, comments, matches, priority_level";

fn map_issue(r: &rusqlite::Row) -> rusqlite::Result<Issue> {
    let comments: String = r.get(19)?;
    let matches: String = r.get(20)?;
    Ok(Issue {
        site: r.get(0)?,
        key: r.get(1)?,
        remote_id: r.get(2)?,
        summary: r.get(3)?,
        status: r.get(4)?,
        status_category: r.get(5)?,
        priority: r.get(6)?,
        assignee: r.get(7)?,
        reporter: r.get(8)?,
        issue_type: r.get(9)?,
        project_key: r.get(10)?,
        project_name: r.get(11)?,
        sprint: r.get(12)?,
        sprint_state: r.get(13)?,
        due_date: r.get(14)?,
        updated: r.get(15)?,
        resolved: r.get(16)?,
        url: r.get(17)?,
        description: r.get(18)?,
        comments: serde_json::from_str(&comments).unwrap_or_default(),
        matches: serde_json::from_str(&matches).unwrap_or_default(),
        priority_level: r.get(21)?,
        priority_id: String::new(),
    })
}

/// Cached issues no search found for this long are dropped.
const KEEP_UNMATCHED_DAYS: i64 = 30;

impl Database {
    /// Stores a sync of `site`: found issues are written (with their searches), cached issues
    /// that no search found any more keep their row without searches, rows not seen for 30 days
    /// go, and the projects of the site's issues are kept for key detection. A saved search
    /// that failed this time keeps the issues it found last time (its widget does not empty).
    pub fn issues_store(&self, site: &str, fetched: &Fetched, now: DateTime<Utc>) -> Result<StoreOutcome> {
        self.atomic(|| {
            let mut out = StoreOutcome::default();
            let before: HashMap<String, String> = {
                let mut st = self.conn().prepare("SELECT key, status_category FROM issues WHERE site = ?1")?;
                st.query_map([site], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            let failed: HashSet<&str> = fetched.failed.iter().map(|(id, _)| id.as_str()).collect();
            let kept: HashMap<String, Vec<String>> = if failed.is_empty() {
                HashMap::new()
            } else {
                let mut st = self.conn().prepare("SELECT key, matches FROM issues WHERE site = ?1")?;
                let rows: Vec<(String, String)> =
                    st.query_map([site], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
                rows.into_iter()
                    .map(|(k, m)| {
                        let m: Vec<String> = serde_json::from_str(&m).unwrap_or_default();
                        (k, m.into_iter().filter(|id| failed.contains(id.as_str())).collect::<Vec<_>>())
                    })
                    .filter(|(_, m)| !m.is_empty())
                    .collect()
            };
            self.conn().execute("UPDATE issues SET matches = '[]' WHERE site = ?1", [site])?;
            for (key, m) in &kept {
                self.conn().execute(
                    "UPDATE issues SET matches = ?3 WHERE site = ?1 AND key = ?2",
                    params![site, key, serde_json::to_string(m)?],
                )?;
            }
            for issue in fetched.issues.values() {
                if issue.done() && before.get(&issue.key).is_some_and(|c| c != "done") {
                    out.newly_done.push(issue.key.clone());
                }
                match kept.get(&issue.key) {
                    Some(old) if !issue.matches.is_empty() => {
                        let mut i = issue.clone();
                        i.matches.extend(old.iter().filter(|id| !issue.matches.contains(id)).cloned());
                        self.issue_put(site, &i, now)?;
                    }
                    _ => self.issue_put(site, issue, now)?,
                }
            }
            out.issues = fetched.issues.values().filter(|i| !i.matches.is_empty()).count();
            self.conn().execute(
                "DELETE FROM issues WHERE site = ?1 AND matches = '[]' AND seen_at < ?2",
                params![site, ts(now - Duration::days(KEEP_UNMATCHED_DAYS))],
            )?;
            self.conn().execute("DELETE FROM issue_projects WHERE site = ?1", [site])?;
            self.conn().execute(
                "INSERT OR IGNORE INTO issue_projects (site, key, name)
                 SELECT site, project_key, MAX(project_name) FROM issues WHERE site = ?1 AND project_key <> '' GROUP BY project_key",
                [site],
            )?;
            Ok(out)
        })
    }

    /// Writes one issue (keeps nothing of an older row but its place).
    pub fn issue_put(&self, site: &str, i: &Issue, now: DateTime<Utc>) -> Result<()> {
        self.conn().execute(
            &format!(
                "INSERT INTO issues ({ISSUE_COLS}, seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?23, ?22)
                 ON CONFLICT (site, key) DO UPDATE SET remote_id = ?3, summary = ?4, status = ?5, status_category = ?6, priority = ?7,
                   assignee = ?8, reporter = ?9, issue_type = ?10, project_key = ?11, project_name = ?12, sprint = ?13, sprint_state = ?14,
                   due_date = ?15, updated = ?16, resolved = ?17, url = ?18, description = ?19, comments = ?20,
                   matches = CASE WHEN ?21 = '[]' THEN matches ELSE ?21 END, seen_at = ?22, priority_level = ?23"
            ),
            params![
                site,
                i.key,
                i.remote_id,
                i.summary,
                i.status,
                i.status_category,
                i.priority,
                i.assignee,
                i.reporter,
                i.issue_type,
                i.project_key,
                i.project_name,
                i.sprint,
                i.sprint_state,
                i.due_date,
                i.updated,
                i.resolved,
                i.url,
                i.description,
                serde_json::to_string(&i.comments)?,
                serde_json::to_string(&i.matches)?,
                ts(now),
                i.priority_level,
            ],
        )?;
        if !i.project_key.is_empty() {
            self.conn().execute(
                "INSERT OR IGNORE INTO issue_projects (site, key, name) VALUES (?1, ?2, ?3)",
                params![site, i.project_key, i.project_name],
            )?;
        }
        Ok(())
    }

    /// Cached issues, newest change first.
    pub fn issues_list(&self, f: &IssueFilter) -> Result<Vec<Issue>> {
        let mut sql = format!("SELECT {ISSUE_COLS} FROM issues WHERE (?1 = '' OR site = ?1)");
        if !f.all {
            sql.push_str(" AND matches <> '[]'");
        }
        if !f.query.is_empty() {
            sql.push_str(" AND EXISTS (SELECT 1 FROM json_each(matches) WHERE value = ?2)");
        } else {
            sql.push_str(" AND ?2 = ''");
        }
        sql.push_str(" ORDER BY IFNULL(updated, '') DESC, key LIMIT ?3");
        let limit = f.limit.unwrap_or(2000).min(5000) as i64;
        let mut st = self.conn().prepare(&sql)?;
        Ok(st.query_map(params![f.site, f.query, limit], map_issue)?.collect::<rusqlite::Result<_>>()?)
    }

    /// The cached issue `key` (of any site; the first site wins when two have it).
    pub fn issue_get(&self, key: &str) -> Result<Option<Issue>> {
        Ok(self
            .conn()
            .query_row(
                &format!("SELECT {ISSUE_COLS} FROM issues WHERE key = ?1 ORDER BY site LIMIT 1"),
                [key],
                map_issue,
            )
            .optional()?)
    }

    /// Keys of the cached projects, upper-case (only they become chips).
    pub fn issue_project_keys(&self) -> Result<HashSet<String>> {
        let mut st = self.conn().prepare_cached("SELECT DISTINCT key FROM issue_projects")?;
        Ok(st.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<_>>()?)
    }

    /// The cached projects by site (`site`, `key`, `name`).
    pub fn issue_projects(&self) -> Result<Vec<(String, String, String)>> {
        let mut st = self.conn().prepare("SELECT site, key, name FROM issue_projects ORDER BY site, key")?;
        Ok(st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Open cached issues of `site` (asked for again when no search finds them).
    pub fn issues_open_keys(&self, site: &str) -> Result<Vec<String>> {
        let mut st =
            self.conn().prepare("SELECT key FROM issues WHERE site = ?1 AND status_category <> 'done' ORDER BY key")?;
        Ok(st.query_map([site], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Removes the cache of a site (it was removed from the settings).
    pub fn issues_remove_site(&self, site: &str) -> Result<()> {
        self.atomic(|| {
            for t in ["issues", "issue_projects", "issue_sync"] {
                self.conn().execute(&format!("DELETE FROM {t} WHERE site = ?1"), [site])?;
            }
            Ok(())
        })
    }

    /// Worklogs of `site` still waiting are not posted any more (its „Arbeitszeit in Jira
    /// buchen“ was switched off): switching it on again later does not post old bookings.
    pub fn worklogs_cancel_site(&self, site: &str) -> Result<usize> {
        Ok(self.conn().execute(
            "UPDATE time_entry_issues SET worklog_state = 'none', error = NULL, next_try = NULL
             WHERE site = ?1 AND worklog_id IS NULL AND worklog_state IN ('pending', 'failed')",
            [site],
        )?)
    }

    /// Records the outcome of a sync of `site` (or only the attempt, with `Err`).
    pub fn issue_sync_record(
        &self,
        site: &str,
        now: DateTime<Utc>,
        outcome: std::result::Result<(usize, &str), &str>,
    ) -> Result<()> {
        match outcome {
            Ok((n, account)) => self.conn().execute(
                "INSERT INTO issue_sync (site, synced_at, attempted_at, error, issues, account) VALUES (?1, ?2, ?2, NULL, ?3, ?4)
                 ON CONFLICT (site) DO UPDATE SET synced_at = ?2, attempted_at = ?2, error = NULL, issues = ?3,
                   account = CASE WHEN ?4 = '' THEN account ELSE ?4 END",
                params![site, ts(now), n as i64, account],
            )?,
            Err(e) => self.conn().execute(
                "INSERT INTO issue_sync (site, attempted_at, error) VALUES (?1, ?2, ?3)
                 ON CONFLICT (site) DO UPDATE SET attempted_at = ?2, error = ?3",
                params![site, ts(now), e],
            )?,
        };
        Ok(())
    }

    pub fn issue_sync_status(&self) -> Result<Vec<SiteSync>> {
        let mut st = self
            .conn()
            .prepare("SELECT site, synced_at, attempted_at, error, issues, account FROM issue_sync ORDER BY site")?;
        let rows = st.query_map([], |r| {
            let t = |i: usize| -> rusqlite::Result<Option<DateTime<Utc>>> {
                r.get::<_, Option<String>>(i)?.map(|s| parse_ts(&s)).transpose()
            };
            Ok(SiteSync {
                site: r.get(0)?,
                synced_at: t(1)?,
                attempted_at: t(2)?,
                error: r.get(3)?,
                issues: r.get(4)?,
                account: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    // ---------------------------------------------------------------- tasks and pages

    /// Ticks the open tasks that name one of `keys` (the issues are done in Jira). Returns the
    /// pages changed.
    pub fn issues_tick_tasks(&self, keys: &[String]) -> Result<Vec<i64>> {
        let mut pages = vec![];
        for key in keys {
            let rows: Vec<(i64, i64, String)> = {
                let mut st = self.conn().prepare_cached(
                    "SELECT t.page_id, t.ordinal, t.text FROM tasks t JOIN pages p ON p.id = t.page_id
                     WHERE t.done = 0 AND p.deleted_at IS NULL AND instr(t.text, ?1) > 0",
                )?;
                st.query_map([key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?
            };
            for (page, ordinal, text) in rows {
                if mentions(&text, key)
                    && self.set_task_done(page, ordinal, true, Some(&text)).is_ok()
                    && !pages.contains(&page)
                {
                    pages.push(page);
                }
            }
        }
        Ok(pages)
    }

    /// Pages that name `key`, the issue's note (`jira: KEY`) first.
    pub fn issue_backlinks(&self, key: &str) -> Result<Vec<IssueBacklink>> {
        let rows: Vec<(i64, String, Option<String>, String)> = {
            let mut st = self.conn().prepare(
                "SELECT id, title, icon, content FROM pages WHERE deleted_at IS NULL AND (instr(content, ?1) > 0 OR instr(title, ?1) > 0)
                 ORDER BY updated_at DESC LIMIT 200",
            )?;
            st.query_map([key], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut out: Vec<IssueBacklink> = rows
            .into_iter()
            .filter_map(|(page_id, title, icon, content)| {
                let note =
                    crate::pagework::frontmatter_value(&content, "jira").is_some_and(|v| v.eq_ignore_ascii_case(key));
                (note || mentions(&content, key) || mentions(&title, key)).then_some(IssueBacklink {
                    page_id,
                    title,
                    icon,
                    note,
                })
            })
            .collect();
        out.sort_by_key(|b| !b.note);
        Ok(out)
    }

    /// The note page of an issue (`jira: KEY` property).
    pub fn issue_note(&self, key: &str) -> Result<Option<i64>> {
        Ok(self.issue_backlinks(key)?.into_iter().find(|b| b.note).map(|b| b.page_id))
    }

    // ---------------------------------------------------------------- WBS mapping

    pub fn issue_wbs_list(&self) -> Result<Vec<WbsMapping>> {
        let mut st =
            self.conn().prepare("SELECT kind, key, reference, learned FROM issue_wbs_map ORDER BY kind DESC, key")?;
        Ok(st
            .query_map([], |r| {
                Ok(WbsMapping { kind: r.get(0)?, key: r.get(1)?, reference: r.get(2)?, learned: r.get(3)? })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// Sets (or with an empty reference, removes) the WBS of an issue or project. The reference
    /// must resolve (`NP-8801/1020`, `NP-8801` or a WBS element).
    pub fn issue_wbs_set(&self, kind: &str, key: &str, reference: &str, learned: bool) -> Result<()> {
        let key = key.trim().to_uppercase();
        if !matches!(kind, "issue" | "project") || key.is_empty() {
            return Err(Error::State(tr!("Ungültige Zuordnung", "Invalid mapping").into()));
        }
        if kind == "issue" && !is_key(&key) {
            return Err(Error::State(trf!("„{key}“ ist kein Issue-Schlüssel", "“{key}” is not an issue key")));
        }
        let reference = reference.trim();
        if reference.is_empty() {
            self.conn().execute("DELETE FROM issue_wbs_map WHERE kind = ?1 AND key = ?2", params![kind, key])?;
            return Ok(());
        }
        let canonical = self.canonical_reference(reference)?;
        self.conn().execute(
            "INSERT INTO issue_wbs_map (kind, key, reference, learned, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (kind, key) DO UPDATE SET reference = ?3, learned = ?4",
            params![kind, key, canonical, learned, ts(Utc::now())],
        )?;
        Ok(())
    }

    /// `NP-8801/1020` as stored for budgets (canonical spellings); an error when it does not resolve.
    fn canonical_reference(&self, reference: &str) -> Result<String> {
        let (np, v) = match reference.split_once('/') {
            Some((n, v)) => (n.trim(), Some(v.trim()).filter(|v| !v.is_empty())),
            None => (reference.trim(), None),
        };
        let n = self.netzplan_by_ref(np)?;
        Ok(match v {
            None => n.netzplan_nr,
            Some(v) => {
                let list = self.list_vorgaenge(n.id)?;
                match list.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) {
                    Some(found) => format!("{}/{}", n.netzplan_nr, found.vorgang_nr),
                    None if list.is_empty() => format!("{}/{v}", n.netzplan_nr),
                    None => return Err(Error::not_found("vorgang", format!("{}/{v}", n.netzplan_nr))),
                }
            }
        })
    }

    /// The WBS an issue books on: its own mapping, else its project's.
    pub fn issue_wbs_for(&self, key: &str) -> Result<Option<String>> {
        let own: Option<String> = self
            .conn()
            .query_row("SELECT reference FROM issue_wbs_map WHERE kind = 'issue' AND key = ?1", [key], |r| r.get(0))
            .optional()?;
        if own.is_some() {
            return Ok(own);
        }
        Ok(self
            .conn()
            .query_row(
                "SELECT reference FROM issue_wbs_map WHERE kind = 'project' AND key = ?1",
                [project_of(key)],
                |r| r.get(0),
            )
            .optional()?)
    }

    /// The first known issue key in `text`.
    pub fn issue_key_in(&self, text: &str) -> Result<Option<String>> {
        let projects = self.issue_project_keys()?;
        if projects.is_empty() {
            return Ok(None);
        }
        Ok(find_keys(text, &projects).into_iter().next().map(|(_, _, k)| k))
    }

    // ---------------------------------------------------------------- entries and worklogs

    /// Links a booked entry to its issue; `log_work` queues a worklog for the issue's site.
    pub fn issue_link_entry(&self, entry_id: i64, key: &str, log_work_site: Option<&str>) -> Result<()> {
        let site = log_work_site.map(str::to_owned).or_else(|| self.issue_get(key).ok().flatten().map(|i| i.site));
        self.conn().execute(
            "INSERT INTO time_entry_issues (entry_id, issue_key, site, worklog_state) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (entry_id) DO UPDATE SET issue_key = ?2, site = ?3",
            params![entry_id, key, site.unwrap_or_default(), if log_work_site.is_some() { "pending" } else { "none" }],
        )?;
        Ok(())
    }

    pub fn issue_entries(&self, entry_ids: &[i64]) -> Result<Vec<EntryIssue>> {
        let mut st = self.conn().prepare_cached(
            "SELECT entry_id, issue_key, site, worklog_state, worklog_id, error FROM time_entry_issues WHERE entry_id = ?1",
        )?;
        let mut out = vec![];
        for id in entry_ids {
            if let Some(e) = st
                .query_row([id], |r| {
                    Ok(EntryIssue {
                        entry_id: r.get(0)?,
                        issue_key: r.get(1)?,
                        site: r.get(2)?,
                        worklog_state: r.get(3)?,
                        worklog_id: r.get(4)?,
                        error: r.get(5)?,
                        syncs: false,
                    })
                })
                .optional()?
            {
                out.push(e);
            }
        }
        Ok(out)
    }

    /// Worklogs due to be posted now (pending, or failed and waiting long enough; an entry that
    /// was being posted when the app stopped counts as failed).
    pub fn worklogs_due(&self, now: DateTime<Utc>) -> Result<Vec<PendingWorklog>> {
        let mut st = self.conn().prepare(
            "SELECT l.entry_id, l.site, l.issue_key, e.start_time, IFNULL(e.duration_minutes, 0), e.description, l.attempts, l.worklog_state, l.worklog_id
             FROM time_entry_issues l JOIN time_entries e ON e.id = l.entry_id
             WHERE e.status_flag <> 'running'
               AND (l.worklog_state IN ('pending', 'posting') OR (l.worklog_state = 'failed' AND IFNULL(l.next_try, '') <= ?1))
             ORDER BY l.entry_id LIMIT 50",
        )?;
        let rows = st.query_map([ts(now)], |r| {
            let start: String = r.get(3)?;
            let attempts: i64 = r.get(6)?;
            let state: String = r.get(7)?;
            let worklog_id: Option<String> = r.get(8)?;
            Ok(PendingWorklog {
                entry_id: r.get(0)?,
                site: r.get(1)?,
                work: WorkLog { key: r.get(2)?, started: parse_ts(&start)?, minutes: r.get(4)?, comment: r.get(5)? },
                retry: worklog_id.is_none() && (attempts > 0 || state == "posting"),
                worklog_id,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Claims a worklog for posting (or, posted before, for its update); `false` when it is
    /// posted and unchanged (never posted twice: a posted one keeps its id and is updated).
    pub fn worklog_claim(&self, entry_id: i64) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE time_entry_issues SET worklog_state = 'posting'
             WHERE entry_id = ?1 AND worklog_state IN ('pending', 'failed', 'posting')",
            [entry_id],
        )?;
        Ok(n == 1)
    }

    /// Records a posted worklog.
    pub fn worklog_posted(&self, entry_id: i64, worklog_id: &str) -> Result<()> {
        self.conn().execute(
            "UPDATE time_entry_issues SET worklog_state = 'posted', worklog_id = ?2, error = NULL, next_try = NULL WHERE entry_id = ?1",
            params![entry_id, worklog_id],
        )?;
        Ok(())
    }

    /// Records a failed try; the next one waits ([`worklog_retry_delay`]).
    pub fn worklog_failed(&self, entry_id: i64, error: &str, now: DateTime<Utc>) -> Result<()> {
        let attempts: i64 = self
            .conn()
            .query_row("SELECT attempts FROM time_entry_issues WHERE entry_id = ?1", [entry_id], |r| r.get(0))
            .optional()?
            .unwrap_or(0)
            + 1;
        self.conn().execute(
            "UPDATE time_entry_issues SET worklog_state = 'failed', attempts = ?2, error = ?3, next_try = ?4
             WHERE entry_id = ?1 AND worklog_state <> 'posted'",
            params![entry_id, attempts, error, ts(now + worklog_retry_delay(attempts))],
        )?;
        Ok(())
    }

    /// „Erneut versuchen“: a failed worklog is tried at the next run.
    pub fn worklog_retry_now(&self, entry_id: i64) -> Result<()> {
        self.conn().execute(
            "UPDATE time_entry_issues SET next_try = NULL WHERE entry_id = ?1 AND worklog_state = 'failed'",
            [entry_id],
        )?;
        Ok(())
    }

    /// The posted worklog of an entry (site, issue, worklog id), if any.
    pub fn entry_worklog(&self, entry_id: i64) -> Result<Option<(String, String, String)>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT site, issue_key, worklog_id FROM time_entry_issues WHERE entry_id = ?1 AND worklog_id IS NOT NULL",
                [entry_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?)
    }

    /// The entry changed after its worklog was posted: the worklog is updated at the next run.
    /// Returns whether one is due now.
    pub fn worklog_changed(&self, entry_id: i64) -> Result<bool> {
        let n = self.conn().execute(
            "UPDATE time_entry_issues SET worklog_state = 'pending', attempts = 0, next_try = NULL, error = NULL
             WHERE entry_id = ?1 AND worklog_id IS NOT NULL",
            [entry_id],
        )?;
        Ok(n == 1)
    }

    /// The entry is being deleted: its posted worklog is queued for deletion in Jira.
    pub fn worklog_queue_delete(&self, entry_id: i64) -> Result<bool> {
        let n = self.conn().execute(
            "INSERT INTO jira_worklog_deletes (site, issue_key, worklog_id)
             SELECT site, issue_key, worklog_id FROM time_entry_issues WHERE entry_id = ?1 AND worklog_id IS NOT NULL",
            [entry_id],
        )?;
        Ok(n == 1)
    }

    /// Worklog deletions due now (new, or failed and waiting long enough).
    pub fn worklog_deletes_due(&self, now: DateTime<Utc>) -> Result<Vec<WorklogDelete>> {
        let mut st = self.conn().prepare(
            "SELECT id, site, issue_key, worklog_id FROM jira_worklog_deletes
             WHERE IFNULL(next_try, '') <= ?1 ORDER BY id LIMIT 50",
        )?;
        let rows = st.query_map([ts(now)], |r| {
            Ok(WorklogDelete { id: r.get(0)?, site: r.get(1)?, issue_key: r.get(2)?, worklog_id: r.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Jira removed the worklog (or it was gone already).
    pub fn worklog_deleted(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM jira_worklog_deletes WHERE id = ?1", [id])?;
        Ok(())
    }

    /// A deletion failed; the next try waits ([`worklog_retry_delay`]).
    pub fn worklog_delete_failed(&self, id: i64, error: &str, now: DateTime<Utc>) -> Result<()> {
        self.conn().execute(
            "UPDATE jira_worklog_deletes SET attempts = attempts + 1, error = ?2,
               next_try = CASE attempts WHEN 0 THEN ?3 WHEN 1 THEN ?4 WHEN 2 THEN ?5 ELSE ?6 END
             WHERE id = ?1",
            params![
                id,
                error,
                ts(now + worklog_retry_delay(1)),
                ts(now + worklog_retry_delay(2)),
                ts(now + worklog_retry_delay(3)),
                ts(now + worklog_retry_delay(4)),
            ],
        )?;
        Ok(())
    }
}

/// Before a `/zeit` line is booked: the issue key it names, and the WBS to book on when the line
/// has no reference of its own (the issue's or project's mapping wins over the page's).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ZeitIssue {
    pub key: Option<String>,
    /// Mapped reference to use as default.
    pub mapped: Option<String>,
}

/// Looks at a `/zeit` line for an issue key of a known project.
pub fn zeit_issue(db: &Database, line: &str) -> Result<ZeitIssue> {
    let Some(key) = db.issue_key_in(line)? else { return Ok(ZeitIssue::default()) };
    let mapped = db.issue_wbs_for(&key)?;
    Ok(ZeitIssue { key: Some(key), mapped })
}

/// Whether the first argument of a `/zeit` line is a duration (no reference given).
pub fn zeit_without_reference(line: &str) -> bool {
    line.split_whitespace().nth(1).is_some_and(|w| crate::zeit::parse_duration(w).is_ok())
}

/// The error of a line with an issue key but neither reference nor mapping.
pub fn unmapped_error(key: &str) -> Error {
    Error::State(trf!(
        "Für {key} ist kein Netzplan/Vorgang zugeordnet. Einmal mit Bezug buchen (z. B. /zeit NP-8801/1020 1h {key} …) oder unter Einstellungen → Jira zuordnen.",
        "{key} has no network/activity yet. Book it once with a reference (e.g. /time NP-8801/1020 1h {key} …) or map it under Settings → Jira."
    ))
}

/// Due dates of the synced open issues for the start page's „Fristen“ widget
/// ([`crate::dashboard::work::DEADLINE_PROVIDERS`]): everything due up to the window's end,
/// overdue ones included; they open in Jira.
pub fn jira_deadlines(
    db: &Database,
    w: &crate::dashboard::work::DeadlineWindow,
) -> Result<Vec<crate::dashboard::work::Deadline>> {
    let until = w.until.format("%Y-%m-%d").to_string();
    let mut st = db.conn().prepare(
        "SELECT key, MAX(summary), MAX(project_name), MAX(project_key), MAX(due_date), MAX(url), MAX(priority), MAX(priority_level) FROM issues
         WHERE status_category <> 'done' AND matches <> '[]' AND due_date IS NOT NULL AND due_date <= ?1
         GROUP BY key ORDER BY key",
    )?;
    type Row = (String, String, String, String, String, String, String, u8);
    let rows: Vec<Row> = st
        .query_map([until], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(key, summary, project_name, project_key, due, url, name, level)| {
            // Rows cached before the levels came: by the name.
            let priority = if level > 0 { level } else { priority_level(&name, "", "") };
            let date = NaiveDate::parse_from_str(&due, "%Y-%m-%d").ok()?;
            Some(crate::dashboard::work::Deadline {
                source: "jira".into(),
                title: format!("{key} {summary}"),
                detail: if project_name.is_empty() { project_key } else { project_name },
                date,
                page_id: None,
                ordinal: None,
                url: Some(url).filter(|u| !u.is_empty()),
                priority: match priority {
                    4.. => 2,
                    3 => 1,
                    _ => 0,
                },
                key: format!("jira:{key}"),
            })
        })
        .collect())
}
