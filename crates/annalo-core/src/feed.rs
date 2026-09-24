//! Activity feed („Aktivität“): a journal of what happened in the workspace – pages created
//! and edited (merged per page and hour, with the characters changed), tasks added and done,
//! time bookings (created, changed, released, exported), files, focus sessions, backups and
//! Git syncs.
//!
//! New events are written by the store itself (page saves, time entries) and by the shell
//! (files, backups, syncs). History from before the journal existed is derived once from
//! pages, versions, time entries and the attachments folder ([`backfill`]).

use std::collections::HashMap;

use chrono::{DateTime, NaiveDate, NaiveTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::tasks::parse_tasks;

/// Every kind of event, in the order the filter lists them.
pub const KINDS: &[&str] = &[
    "page_created",
    "page_edited",
    "task_added",
    "task_done",
    "entry_created",
    "entry_changed",
    "entry_released",
    "entry_exported",
    "file_added",
    "focus_session",
    "backup",
    "sync",
];

/// Where the journal starts (set by migration v7).
const SINCE: &str = "feed.since";
/// Set once the history before [`SINCE`] was derived.
const BACKFILLED: &str = "feed.backfilled";

/// An event to write.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct NewActivity {
    pub kind: &'static str,
    pub page_id: Option<i64>,
    pub entry_id: Option<i64>,
    pub netzplan_id: Option<i64>,
    pub vorgang_nr: Option<String>,
    pub title: String,
    pub detail: String,
    pub amount: i64,
    pub people: Vec<String>,
}

/// An event as listed in the feed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Activity {
    pub id: i64,
    /// RFC 3339, UTC.
    pub at: String,
    pub kind: String,
    pub page_id: Option<i64>,
    /// Current title of the page (`None` when it is gone or in the trash; `title` has the old one).
    pub page_title: Option<String>,
    pub page_icon: Option<String>,
    pub entry_id: Option<i64>,
    pub netzplan_id: Option<i64>,
    /// `NP-8801/1020` or `NP-8801`.
    pub reference: Option<String>,
    pub project_code: Option<String>,
    pub title: String,
    pub detail: String,
    /// Characters changed (pages), minutes (bookings, focus) or a count (status changes).
    pub amount: i64,
    /// Events merged into this one (edits of a page within the hour).
    pub count: i64,
    pub people: Vec<String>,
}

/// Filter of [`list`]; `None` and empty fields do not filter.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FeedFilter {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub kinds: Vec<String>,
    pub project_id: Option<i64>,
    pub netzplan_id: Option<i64>,
    pub vorgang_nr: Option<String>,
    /// A person (`@name` mention or owner), without `@`.
    pub person: Option<String>,
    /// Words that must all appear in the title, details, page title or reference.
    pub query: Option<String>,
    /// At most this many (newest first); default 2000.
    pub limit: Option<usize>,
}

/// Totals for the header of a day (or range).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FeedSummary {
    /// Distinct pages created or edited.
    pub pages_edited: i64,
    pub tasks_done: i64,
    pub tasks_added: i64,
    /// Finished time entries starting in the range.
    pub booked_minutes: i64,
    pub focus_sessions: i64,
    pub focus_minutes: i64,
}

// ------------------------------------------------------------------ helpers

/// Characters changed between two texts: the longer of the differing middles once the common
/// prefix and suffix are removed (one edit session is usually one contiguous change).
pub fn changed_chars(old: &str, new: &str) -> i64 {
    let a: Vec<char> = old.chars().collect();
    let b: Vec<char> = new.chars().collect();
    let prefix = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let max_suffix = a.len().min(b.len()) - prefix;
    let suffix = a.iter().rev().zip(b.iter().rev()).take(max_suffix).take_while(|(x, y)| x == y).count();
    (a.len() - prefix - suffix).max(b.len() - prefix - suffix) as i64
}

/// `@name` mentions (outside code, not in `/zeit` lines where `@` starts a date or time) and the
/// `owner:` / `verantwortlich:` / `person:` properties, lower-cased and deduplicated.
pub fn people(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |name: &str| {
        let n = name.trim().trim_start_matches('@').trim_matches(|c: char| c == '"' || c == '\'').to_lowercase();
        if !n.is_empty() && n.len() <= 60 && !out.contains(&n) {
            out.push(n);
        }
    };
    for key in ["owner", "verantwortlich", "person"] {
        if let Some(v) = crate::pagework::frontmatter_value(markdown, key) {
            for part in v.trim_matches(|c| c == '[' || c == ']').split(',') {
                push(part);
            }
        }
    }
    let mut fence = false;
    for line in markdown.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence || t.starts_with("/zeit") || t.starts_with("/time") || t.contains("<time-entry") {
            continue;
        }
        let chars: Vec<(usize, char)> = line.char_indices().collect();
        let mut in_code = false;
        for (i, &(at, c)) in chars.iter().enumerate() {
            if c == '`' {
                in_code = !in_code;
                continue;
            }
            if c != '@' || in_code || (i > 0 && !chars[i - 1].1.is_whitespace() && chars[i - 1].1 != '(') {
                continue;
            }
            let rest = &line[at + 1..];
            let first = rest.chars().next();
            if !first.is_some_and(char::is_alphabetic) {
                continue;
            }
            let end = rest
                .char_indices()
                .find(|(_, c)| !(c.is_alphanumeric() || matches!(c, '.' | '_' | '-')))
                .map_or(rest.len(), |(i, _)| i);
            let name = rest[..end].trim_end_matches(['.', '-']);
            // `@heute`, `@gestern`: dates of the capture syntax, not people.
            if !matches!(
                name.to_lowercase().as_str(),
                "heute" | "gestern" | "vorgestern" | "morgen" | "today" | "yesterday"
            ) {
                push(name);
            }
        }
    }
    out
}

/// Start and end of the UTC hour of `t` (edits are merged per page and hour).
fn hour_range(t: DateTime<Utc>) -> (String, String) {
    let s = ts(t);
    let start = format!("{}:00:00Z", &s[..13]);
    let end = parse_ts(&start).map(|h| ts(h + chrono::Duration::hours(1))).unwrap_or_else(|_| s.clone());
    (start, end)
}

/// Netzplan id and Vorgang of a page's `vorgang:` / `netzplan:` property, when it resolves.
fn page_wbs(db: &Database, markdown: &str) -> (Option<i64>, Option<String>) {
    let Some(reference) = crate::pagework::page_reference(markdown) else { return (None, None) };
    let (np, v) = match reference.split_once('/') {
        Some((n, v)) => (n.trim().to_owned(), Some(v.trim().to_owned()).filter(|v| !v.is_empty())),
        None => (reference.trim().to_owned(), None),
    };
    match db.netzplan_by_ref(&np) {
        Ok(n) => (Some(n.id), v),
        Err(_) => (None, None),
    }
}

/// Local midnight of `day` as UTC.
pub fn day_start<Tz: TimeZone>(day: NaiveDate, tz: &Tz) -> DateTime<Utc> {
    let midnight = day.and_time(NaiveTime::MIN);
    tz.from_local_datetime(&midnight)
        .earliest()
        .or_else(|| tz.from_local_datetime(&(midnight + chrono::Duration::hours(1))).earliest())
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|| midnight.and_utc())
}

// -------------------------------------------------------------------- store

/// Clears the texts (title, task text, mentions) of the page events of page `?1`, before the
/// page is deleted for good.
pub(crate) const SCRUB_ACTIVITY: &str = "UPDATE activity SET title = '(gelöscht)', detail = '', people = ''
     WHERE page_id = ?1 AND kind IN ('page_created', 'page_edited', 'task_added', 'task_done')";

/// Activity, AI usage and focus sessions are kept this long.
pub const HISTORY_DAYS: i64 = 400;

impl Database {
    /// Removes activity, AI usage and finished focus sessions older than [`HISTORY_DAYS`], and
    /// the texts of page events whose page is gone. Returns the number of rows removed.
    pub fn prune_history(&self, now: DateTime<Utc>) -> Result<usize> {
        let cutoff = ts(now - chrono::Duration::days(HISTORY_DAYS));
        self.atomic(|| {
            let c = self.conn();
            let mut n = c.execute("DELETE FROM activity WHERE at < ?1", [&cutoff])?;
            n += c.execute("DELETE FROM ai_usage WHERE created_at < ?1", [&cutoff])?;
            n += c.execute("DELETE FROM focus_sessions WHERE started_at < ?1 AND status <> 'running'", [&cutoff])?;
            // Pages deleted before this was done at purge time.
            c.execute(
                "UPDATE activity SET title = '(gelöscht)', detail = '', people = ''
                 WHERE page_id IS NULL AND title <> '(gelöscht)'
                   AND kind IN ('page_created', 'page_edited', 'task_added', 'task_done')",
                [],
            )?;
            Ok(n)
        })
    }

    /// Writes one event at `now`.
    pub fn record_activity(&self, a: &NewActivity, now: DateTime<Utc>) -> Result<i64> {
        self.conn().execute(
            "INSERT INTO activity (at, kind, page_id, entry_id, netzplan_id, vorgang_nr, title, detail, amount, people)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                ts(now),
                a.kind,
                a.page_id,
                a.entry_id,
                a.netzplan_id,
                a.vorgang_nr,
                a.title,
                a.detail,
                a.amount,
                a.people.join(" ")
            ],
        )?;
        Ok(self.conn().last_insert_rowid())
    }

    /// A new page.
    pub(crate) fn feed_page_created(&self, page_id: i64, title: &str, now: DateTime<Utc>) -> Result<()> {
        let a =
            NewActivity { kind: "page_created", page_id: Some(page_id), title: title.to_owned(), ..Default::default() };
        self.record_activity(&a, now).map(|_| ())
    }

    /// A page was saved with `new` instead of `old`: merges the edit into this hour's event of the
    /// page and records tasks that were added or checked off.
    pub(crate) fn feed_page_saved(&self, page_id: i64, old: &str, new: &str, now: DateTime<Utc>) -> Result<()> {
        if old == new {
            return Ok(());
        }
        let title: String = self.conn().query_row("SELECT title FROM pages WHERE id = ?1", [page_id], |r| r.get(0))?;
        let changed = changed_chars(old, new);
        let who = people(new).join(" ");
        let (np, vorgang) = page_wbs(self, new);
        let (hour, hour_end) = hour_range(now);
        let merge: Option<(i64, String)> = self
            .conn()
            .query_row(
                "SELECT id, kind FROM activity WHERE page_id = ?1 AND kind IN ('page_edited', 'page_created')
                   AND at >= ?2 AND at < ?3
                 ORDER BY at DESC, id DESC LIMIT 1",
                params![page_id, hour, hour_end],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        match merge {
            Some((id, kind)) => {
                // A created page keeps its creation time; edits move to the latest save.
                let at = if kind == "page_created" { None } else { Some(ts(now)) };
                self.conn().execute(
                    "UPDATE activity SET at = COALESCE(?2, at), amount = amount + ?3, count = count + 1, title = ?4,
                            people = ?5, netzplan_id = ?6, vorgang_nr = ?7 WHERE id = ?1",
                    params![id, at, changed, title, who, np, vorgang],
                )?;
            }
            None => {
                let a = NewActivity {
                    kind: "page_edited",
                    page_id: Some(page_id),
                    netzplan_id: np,
                    vorgang_nr: vorgang.clone(),
                    title: title.clone(),
                    amount: changed,
                    people: who.split_whitespace().map(str::to_owned).collect(),
                    ..Default::default()
                };
                self.record_activity(&a, now)?;
            }
        }
        self.feed_tasks(page_id, &title, old, new, np, vorgang.as_deref(), now)
    }

    /// Tasks added or checked off by a save. While a task is being typed each autosave sees a
    /// "new" text: an event of this hour whose text is no longer on the page takes the new text.
    #[allow(clippy::too_many_arguments)]
    fn feed_tasks(
        &self,
        page_id: i64,
        page_title: &str,
        old: &str,
        new: &str,
        np: Option<i64>,
        vorgang: Option<&str>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let before = parse_tasks(old);
        let after = parse_tasks(new);
        if before.is_empty() && after.is_empty() {
            return Ok(());
        }
        let mut old_state: HashMap<&str, Vec<bool>> = HashMap::new();
        for t in &before {
            old_state.entry(t.text.as_str()).or_default().push(t.done);
        }
        let texts: Vec<&str> = after.iter().map(|t| t.text.as_str()).collect();
        let (hour, hour_end) = hour_range(now);
        for t in &after {
            if t.text.trim().is_empty() {
                continue;
            }
            let was = old_state.get_mut(t.text.as_str()).and_then(|v| (!v.is_empty()).then(|| v.remove(0)));
            match was {
                // Checked off now.
                Some(false) if t.done => {
                    let a = NewActivity {
                        kind: "task_done",
                        page_id: Some(page_id),
                        netzplan_id: np,
                        vorgang_nr: vorgang.map(str::to_owned),
                        title: t.text.clone(),
                        detail: page_title.to_owned(),
                        ..Default::default()
                    };
                    self.record_activity(&a, now)?;
                }
                // Unchecked again: a check-off of this hour is taken back.
                Some(true) if !t.done => {
                    self.conn().execute(
                        "DELETE FROM activity WHERE id = (SELECT id FROM activity WHERE page_id = ?1 AND kind = 'task_done'
                           AND title = ?2 AND at >= ?3 AND at < ?4 ORDER BY at DESC LIMIT 1)",
                        params![page_id, t.text, hour, hour_end],
                    )?;
                }
                Some(_) => {}
                None => {
                    // New text: an earlier event of this hour for a text that is gone is the same
                    // task being typed (or edited).
                    let stale: Vec<(i64, String)> = {
                        let mut st = self.conn().prepare_cached(
                            "SELECT id, title FROM activity WHERE page_id = ?1 AND kind = 'task_added' AND at >= ?2 AND at < ?3
                             ORDER BY at DESC",
                        )?;
                        st.query_map(params![page_id, hour, hour_end], |r| Ok((r.get(0)?, r.get(1)?)))?
                            .collect::<rusqlite::Result<_>>()?
                    };
                    if let Some((id, _)) = stale.iter().find(|(_, title)| !texts.contains(&title.as_str())) {
                        self.conn().execute(
                            "UPDATE activity SET title = ?2, at = ?3 WHERE id = ?1",
                            params![id, t.text, ts(now)],
                        )?;
                    } else {
                        let a = NewActivity {
                            kind: if t.done { "task_done" } else { "task_added" },
                            page_id: Some(page_id),
                            netzplan_id: np,
                            vorgang_nr: vorgang.map(str::to_owned),
                            title: t.text.clone(),
                            detail: page_title.to_owned(),
                            ..Default::default()
                        };
                        self.record_activity(&a, now)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// A time entry was booked, changed or had its status changed.
    pub(crate) fn feed_entry(
        &self,
        kind: &'static str,
        entry: &crate::model::TimeEntry,
        now: DateTime<Utc>,
    ) -> Result<()> {
        let a = NewActivity {
            kind,
            page_id: entry.page_id,
            entry_id: Some(entry.id),
            netzplan_id: Some(entry.netzplan_id),
            vorgang_nr: entry.vorgang_nr.clone(),
            title: entry.description.clone(),
            detail: entry.source.as_str().to_owned(),
            amount: entry.duration_minutes.unwrap_or(0),
            ..Default::default()
        };
        self.record_activity(&a, now).map(|_| ())
    }

    /// Several entries changed status (released, exported, back to draft): one event.
    pub(crate) fn feed_status(&self, ids: &[i64], status: crate::model::StatusFlag, now: DateTime<Utc>) -> Result<()> {
        use crate::model::StatusFlag;
        if ids.is_empty() {
            return Ok(());
        }
        let kind = match status {
            StatusFlag::Released => "entry_released",
            StatusFlag::Exported => "entry_exported",
            _ => "entry_changed",
        };
        let mut refs: Vec<String> = Vec::new();
        let mut minutes = 0;
        let mut np_ids: Vec<i64> = Vec::new();
        for id in ids {
            let row: Option<(String, Option<String>, Option<i64>, i64)> = self
                .conn()
                .query_row(
                    "SELECT n.netzplan_nr, e.vorgang_nr, e.duration_minutes, n.id FROM time_entries e
                     JOIN netzplaene n ON n.id = e.netzplan_id WHERE e.id = ?1",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .optional()?;
            if let Some((np, v, d, np_id)) = row {
                let r = crate::desktop::timer_label(&np, v.as_deref());
                if !refs.contains(&r) {
                    refs.push(r);
                }
                if !np_ids.contains(&np_id) {
                    np_ids.push(np_id);
                }
                minutes += d.unwrap_or(0);
            }
        }
        let n = ids.len();
        let a = NewActivity {
            kind,
            entry_id: (n == 1).then(|| ids[0]),
            netzplan_id: (np_ids.len() == 1).then(|| np_ids[0]),
            title: if n == 1 { "1 Eintrag".into() } else { format!("{n} Einträge") },
            detail: refs.join(", "),
            amount: minutes,
            ..Default::default()
        };
        self.record_activity(&a, now).map(|_| ())
    }

    /// A file was stored in the attachments folder (once per name).
    pub fn feed_file(&self, name: &str, now: DateTime<Utc>) -> Result<()> {
        let seen: bool = self.conn().query_row(
            "SELECT EXISTS(SELECT 1 FROM activity WHERE kind = 'file_added' AND title = ?1)",
            [name],
            |r| r.get(0),
        )?;
        if seen {
            return Ok(());
        }
        let a = NewActivity {
            kind: "file_added",
            title: name.to_owned(),
            detail: file_kind(name).into(),
            ..Default::default()
        };
        self.record_activity(&a, now).map(|_| ())
    }

    /// Names mentioned as people in the feed, most frequent first (for the filter).
    pub fn feed_people(&self) -> Result<Vec<String>> {
        let mut st = self.conn().prepare("SELECT people FROM activity WHERE people <> ''")?;
        let mut counts: HashMap<String, usize> = HashMap::new();
        for row in st.query_map([], |r| r.get::<_, String>(0))? {
            for p in row?.split_whitespace() {
                *counts.entry(p.to_owned()).or_default() += 1;
            }
        }
        let mut list: Vec<(String, usize)> = counts.into_iter().collect();
        list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        Ok(list.into_iter().map(|(p, _)| p).collect())
    }
}

/// „Zeichnung“, „Bild“ or „Datei“ for a file name.
pub fn file_kind(name: &str) -> &'static str {
    if crate::attachments::is_drawing(name) {
        "Zeichnung"
    } else if crate::attachments::image_extension(name).is_some() {
        "Bild"
    } else {
        "Datei"
    }
}

// -------------------------------------------------------------------- query

/// Events matching `f`, newest first.
pub fn list(db: &Database, f: &FeedFilter) -> Result<Vec<Activity>> {
    let kinds: Vec<&str> = f.kinds.iter().map(String::as_str).filter(|k| KINDS.contains(k)).collect();
    let kinds = (!kinds.is_empty()).then(|| format!(" {} ", kinds.join(" ")));
    let person = f.person.as_deref().map(|p| p.trim().trim_start_matches('@').to_lowercase()).filter(|p| !p.is_empty());
    let words: Vec<String> = f
        .query
        .as_deref()
        .unwrap_or("")
        .split_whitespace()
        .map(|w| format!("%{}%", w.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))
        .take(6)
        .collect();
    let mut sql = String::from(
        "SELECT a.id, a.at, a.kind, a.page_id, p.title, p.icon, a.entry_id, a.netzplan_id, n.netzplan_nr, a.vorgang_nr,
                pr.project_code, a.title, a.detail, a.amount, a.count, a.people
         FROM activity a
         LEFT JOIN pages p ON p.id = a.page_id AND p.deleted_at IS NULL
         LEFT JOIN netzplaene n ON n.id = a.netzplan_id
         LEFT JOIN projects pr ON pr.id = n.project_id
         WHERE (?1 IS NULL OR a.at >= ?1) AND (?2 IS NULL OR a.at < ?2)
           AND (?3 IS NULL OR n.project_id = ?3) AND (?4 IS NULL OR a.netzplan_id = ?4)
           AND (?5 IS NULL OR a.vorgang_nr = ?5 COLLATE NOCASE)
           AND (?6 IS NULL OR instr(' ' || a.people || ' ', ' ' || ?6 || ' ') > 0)
           AND (?7 IS NULL OR instr(?7, ' ' || a.kind || ' ') > 0)",
    );
    for i in 0..words.len() {
        let p = 9 + i;
        sql.push_str(&format!(
            " AND (a.title LIKE ?{p} ESCAPE '\\' OR a.detail LIKE ?{p} ESCAPE '\\' OR IFNULL(p.title, '') LIKE ?{p} ESCAPE '\\'
                  OR (IFNULL(n.netzplan_nr, '') || '/' || IFNULL(a.vorgang_nr, '')) LIKE ?{p} ESCAPE '\\'
                  OR a.people LIKE ?{p} ESCAPE '\\')"
        ));
    }
    sql.push_str(" ORDER BY a.at DESC, a.id DESC LIMIT ?8");
    let mut values: Vec<rusqlite::types::Value> = vec![
        f.from.map(ts).into(),
        f.to.map(ts).into(),
        f.project_id.into(),
        f.netzplan_id.into(),
        f.vorgang_nr.clone().filter(|v| !v.is_empty()).into(),
        person.into(),
        kinds.into(),
        (f.limit.unwrap_or(2000).clamp(1, 20_000) as i64).into(),
    ];
    values.extend(words.into_iter().map(rusqlite::types::Value::from));
    let mut st = db.conn().prepare(&sql)?;
    let rows = st
        .query_map(rusqlite::params_from_iter(values), |r| {
            let np: Option<String> = r.get(8)?;
            let v: Option<String> = r.get(9)?;
            Ok(Activity {
                id: r.get(0)?,
                at: r.get(1)?,
                kind: r.get(2)?,
                page_id: r.get(3)?,
                page_title: r.get(4)?,
                page_icon: r.get(5)?,
                entry_id: r.get(6)?,
                netzplan_id: r.get(7)?,
                reference: np.map(|n| crate::desktop::timer_label(&n, v.as_deref())),
                project_code: r.get(10)?,
                title: r.get(11)?,
                detail: r.get(12)?,
                amount: r.get(13)?,
                count: r.get(14)?,
                people: r.get::<_, String>(15)?.split_whitespace().map(str::to_owned).collect(),
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Totals of the UTC range `from..to`.
pub fn summary(db: &Database, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<FeedSummary> {
    let (a, b) = (ts(from), ts(to));
    let c = db.conn();
    let count = |sql: &str| -> Result<i64> { Ok(c.query_row(sql, params![a, b], |r| r.get(0))?) };
    Ok(FeedSummary {
        pages_edited: count(
            "SELECT COUNT(DISTINCT page_id) FROM activity WHERE kind IN ('page_created', 'page_edited') AND at >= ?1 AND at < ?2",
        )?,
        tasks_done: count("SELECT COUNT(*) FROM activity WHERE kind = 'task_done' AND at >= ?1 AND at < ?2")?,
        tasks_added: count("SELECT COUNT(*) FROM activity WHERE kind = 'task_added' AND at >= ?1 AND at < ?2")?,
        booked_minutes: count(
            "SELECT IFNULL(SUM(duration_minutes), 0) FROM time_entries
             WHERE status_flag <> 'running' AND start_time >= ?1 AND start_time < ?2",
        )?,
        focus_sessions: count(
            "SELECT COUNT(*) FROM focus_sessions WHERE status <> 'running' AND started_at >= ?1 AND started_at < ?2",
        )?,
        focus_minutes: count(
            "SELECT IFNULL(SUM(worked_minutes), 0) FROM focus_sessions WHERE status <> 'running' AND started_at >= ?1 AND started_at < ?2",
        )?,
    })
}

/// Pages [`describe_days`] mentions (for the privacy check of the assistant's tool results).
pub fn day_pages<Tz: TimeZone>(db: &Database, from: NaiveDate, to: NaiveDate, tz: &Tz) -> Result<Vec<i64>> {
    let (start, end) = (day_start(from, tz), day_start(to + chrono::Duration::days(1), tz));
    let items = list(db, &FeedFilter { from: Some(start), to: Some(end), limit: Some(400), ..Default::default() })?;
    Ok(items.iter().filter_map(|a| a.page_id).collect())
}

/// „Was habe ich am … gemacht?“ as text for the assistant: the summary and the events of the
/// local days `from..=to`, oldest first.
pub fn describe_days<Tz: TimeZone>(db: &Database, from: NaiveDate, to: NaiveDate, tz: &Tz) -> Result<String>
where
    Tz::Offset: std::fmt::Display,
{
    if to < from || (to - from).num_days() > 62 {
        return Err(Error::State("Zeitraum ungültig (höchstens 62 Tage)".into()));
    }
    let start = day_start(from, tz);
    let end = day_start(to + chrono::Duration::days(1), tz);
    let s = summary(db, start, end)?;
    let mut items = list(db, &FeedFilter { from: Some(start), to: Some(end), limit: Some(400), ..Default::default() })?;
    items.reverse();
    let mut out = format!(
        "Zeitraum {from} bis {to}: {} Seiten bearbeitet, {} Aufgaben erledigt, {} Aufgaben neu, {} gebucht, {} Fokussitzungen.\n",
        s.pages_edited,
        s.tasks_done,
        s.tasks_added,
        crate::focus::hm(s.booked_minutes),
        s.focus_sessions
    );
    for a in &items {
        let when =
            parse_ts(&a.at).map(|t| t.with_timezone(tz).format("%Y-%m-%d %H:%M").to_string()).unwrap_or_default();
        let page = a.page_title.clone().unwrap_or_else(|| a.title.clone());
        let line = match a.kind.as_str() {
            "page_created" => format!("Seite angelegt: {page}"),
            "page_edited" => format!("Seite bearbeitet: {page} ({} Änderungen, ~{} Zeichen)", a.count, a.amount),
            "task_added" => format!("Aufgabe neu: {} (Seite {})", a.title, a.detail),
            "task_done" => format!("Aufgabe erledigt: {} (Seite {})", a.title, a.detail),
            "entry_created" => format!(
                "Zeit gebucht: {} {} {}",
                a.reference.clone().unwrap_or_default(),
                crate::focus::hm(a.amount),
                a.title
            ),
            "entry_changed" => {
                format!("Buchung geändert: {} {}", a.reference.clone().unwrap_or(a.detail.clone()), a.title)
            }
            "entry_released" => format!("{} freigegeben ({})", a.title, a.detail),
            "entry_exported" => format!("{} exportiert ({})", a.title, a.detail),
            "file_added" => format!("{} hinzugefügt: {}", a.detail, a.title),
            "focus_session" => format!(
                "Fokussitzung: {} {} {}",
                a.reference.clone().unwrap_or_default(),
                crate::focus::hm(a.amount),
                a.title
            ),
            "backup" => "Sicherung erstellt".to_owned(),
            "sync" => format!("Git-Synchronisierung: {}", a.detail),
            other => other.to_owned(),
        };
        out.push_str(&format!("- {when} {}\n", line.trim()));
    }
    if items.is_empty() {
        out.push_str("Keine Aktivität aufgezeichnet.\n");
    }
    Ok(out)
}

// ----------------------------------------------------------------- backfill

/// Derives the history from before the journal once: pages created, edit sessions from the
/// version snapshots (with tasks added and checked off between them), time entries and the
/// files of the attachments folder (`files`: name and modification time). Returns the number
/// of events written; 0 when it already ran.
pub fn backfill(db: &Database, files: &[(String, DateTime<Utc>)]) -> Result<usize> {
    if db.meta_get(BACKFILLED)?.is_some() {
        return Ok(0);
    }
    let since = match db.meta_get(SINCE)? {
        Some(s) => parse_ts(&s).map_err(Error::Db)?,
        None => Utc::now(),
    };
    db.atomic(|| {
        let mut n = 0;
        let pages: Vec<(i64, String, String, String, String)> = {
            let mut st = db.conn().prepare(
                "SELECT id, title, created_at, updated_at, content FROM pages p WHERE deleted_at IS NULL AND created_at < ?1
                   AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.page_id = p.id AND a.kind = 'page_created')",
            )?;
            st.query_map([ts(since)], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        for (id, title, created, updated, content) in pages {
            let created_at = parse_ts(&created).map_err(Error::Db)?;
            db.feed_page_created(id, &title, created_at)?;
            n += 1;
            let versions: Vec<(String, String)> = {
                let mut st = db.conn().prepare(
                    "SELECT created_at, content FROM page_versions WHERE page_id = ?1 AND created_at < ?2 ORDER BY created_at, id",
                )?;
                st.query_map(params![id, ts(since)], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            let updated_at = parse_ts(&updated).map_err(Error::Db)?.min(since);
            // Session i starts at version i and ends where version i + 1 (or the page) begins.
            for (i, (at, before)) in versions.iter().enumerate() {
                let after = versions.get(i + 1).map_or(content.as_str(), |(_, c)| c.as_str());
                let when = if i + 1 == versions.len() { updated_at } else { parse_ts(at).map_err(Error::Db)? };
                db.feed_page_saved(id, before, after, when)?;
                n += 1;
            }
            if versions.is_empty() && updated_at > created_at + chrono::Duration::minutes(1) && !content.is_empty() {
                let a = NewActivity { kind: "page_edited", page_id: Some(id), title: title.clone(), ..Default::default() };
                db.record_activity(&a, updated_at)?;
                n += 1;
            }
        }
        let entries: Vec<crate::model::TimeEntry> = {
            let rows = db.list_time_entries(&crate::db::EntryFilter { to: Some(since), ..Default::default() })?;
            rows.into_iter().map(|r| r.entry).filter(|e| e.status_flag != crate::model::StatusFlag::Running).collect()
        };
        for e in entries {
            // Booked after the journal started (with a start time in the past): already recorded.
            let known: bool = db.conn().query_row(
                "SELECT EXISTS(SELECT 1 FROM activity WHERE entry_id = ?1)",
                [e.id],
                |r| r.get(0),
            )?;
            if known {
                continue;
            }
            db.feed_entry("entry_created", &e, e.end_time.unwrap_or(e.start_time).min(since))?;
            n += 1;
        }
        for (name, mtime) in files {
            if *mtime < since && !name.ends_with(".excalidraw.svg") {
                db.feed_file(name, *mtime)?;
                n += 1;
            }
        }
        db.meta_set(BACKFILLED, "1")?;
        Ok(n)
    })
}

/// A workspace with one project, Netzplan `NP-8801` and Vorgang `1020` (tests).
#[cfg(test)]
pub(crate) fn seeded() -> (Database, crate::model::Netzplan) {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_project("PRJ-2026-X", "Annalo Rollout").unwrap();
    let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration", 40.0).unwrap();
    db.create_vorgang(np.id, "1020", "Schnittstellen", 5.0, 20.0).unwrap();
    (db, np)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry, StatusFlag};
    use chrono::FixedOffset;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn history_is_pruned_and_purged_pages_leave_no_text() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Diagnose Kardiologie", None).unwrap();
        db.save_page_content(p.id, "- [ ] Termin beim Arzt @anna").unwrap();
        let texts = |db: &Database| -> Vec<String> {
            let mut st = db.conn().prepare("SELECT title || detail || people FROM activity ORDER BY id").unwrap();
            st.query_map([], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
        };
        assert!(texts(&db).iter().any(|t| t.contains("Kardiologie") || t.contains("Arzt")));
        db.trash_page(p.id).unwrap();
        db.purge_page(p.id).unwrap();
        assert!(texts(&db).iter().all(|t| !t.contains("Kardiologie") && !t.contains("Arzt") && !t.contains("anna")));

        let now = Utc::now();
        let old = now - chrono::Duration::days(HISTORY_DAYS + 1);
        db.record_activity(&NewActivity { kind: "backup", title: "alt".into(), ..Default::default() }, old).unwrap();
        db.conn()
            .execute(
                "INSERT INTO ai_usage (session_id, model, prompt_tokens, completion_tokens, cost_usd, created_at)
                 VALUES ('s', 'm', 1, 1, 0.0, ?1)",
                [ts(old)],
            )
            .unwrap();
        let before = texts(&db).len();
        assert_eq!(db.prune_history(now).unwrap(), 2);
        assert_eq!(texts(&db).len(), before - 1);
        let usage: i64 = db.conn().query_row("SELECT COUNT(*) FROM ai_usage", [], |r| r.get(0)).unwrap();
        assert_eq!(usage, 0);
    }

    #[test]
    fn changed_chars_counts_the_differing_middle() {
        assert_eq!(changed_chars("Hallo Welt", "Hallo schöne Welt"), 7);
        assert_eq!(changed_chars("abc", "abc"), 0);
        assert_eq!(changed_chars("", "neu"), 3);
        assert_eq!(changed_chars("aaaa", "aa"), 2);
    }

    #[test]
    fn people_are_mentions_and_owner_but_not_dates_or_code() {
        let md = "---\nowner: Anna\n---\nMit @Bernd und (@carla.m) besprochen, mail@example.com\n\
                  /zeit NP-1 1h @gestern\n`@code` @heute\n```\n@fenced\n```\n";
        assert_eq!(people(md), ["anna", "bernd", "carla.m"]);
    }

    #[test]
    fn edits_merge_per_page_and_hour_and_tasks_are_tracked() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Plan", None).unwrap();
        let t0 = at("2026-09-22T09:05:00Z");
        db.save_page_content_at(p.id, "- [ ] Angebot", t0).unwrap();
        // Typing the task further: the same "added" event takes the longer text.
        db.save_page_content_at(p.id, "- [ ] Angebot schreiben", t0 + chrono::Duration::minutes(1)).unwrap();
        db.save_page_content_at(p.id, "- [x] Angebot schreiben\n\nMit @Bernd", t0 + chrono::Duration::minutes(20))
            .unwrap();
        // Next hour: a new edit event.
        db.save_page_content_at(p.id, "- [x] Angebot schreiben\n\nMit @Bernd besprochen", at("2026-09-22T10:10:00Z"))
            .unwrap();
        let all = list(&db, &FeedFilter::default()).unwrap();
        let kinds: Vec<&str> = all.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(kinds.iter().filter(|k| **k == "task_added").count(), 1);
        let added = all.iter().find(|a| a.kind == "task_added").unwrap();
        assert_eq!(added.title, "Angebot schreiben");
        assert_eq!(all.iter().filter(|a| a.kind == "task_done").count(), 1);
        // 09:05, 09:06 and 09:25 are one edit event; 10:10 is its own.
        let edits: Vec<&Activity> = all.iter().filter(|a| a.kind == "page_edited").collect();
        assert!(!edits.is_empty());
        assert!(edits.iter().any(|a| a.at == "2026-09-22T10:10:00Z" && a.count == 1 && a.amount == 11));
        let nine = edits.iter().find(|a| a.at.starts_with("2026-09-22T09")).unwrap();
        assert_eq!(nine.count, 3);
        assert_eq!(nine.people, ["bernd"]);
        // Unchecking within the hour takes the check-off back.
        db.save_page_content_at(p.id, "- [ ] Angebot schreiben\n\nMit @Bernd besprochen", at("2026-09-22T10:20:00Z"))
            .unwrap();
        db.save_page_content_at(p.id, "- [x] Angebot schreiben\n\nMit @Bernd besprochen", at("2026-09-22T10:25:00Z"))
            .unwrap();
        db.save_page_content_at(p.id, "- [ ] Angebot schreiben\n\nMit @Bernd besprochen", at("2026-09-22T10:30:00Z"))
            .unwrap();
        let done = list(&db, &FeedFilter { kinds: vec!["task_done".into()], ..Default::default() }).unwrap();
        assert_eq!(done.len(), 1, "only the 09:25 check-off stays");
        // Filters: person, query, range.
        let f = FeedFilter { person: Some("@Bernd".into()), ..Default::default() };
        assert!(list(&db, &f).unwrap().iter().all(|a| a.people.contains(&"bernd".to_owned())));
        let f = FeedFilter { query: Some("angebot schr".into()), ..Default::default() };
        assert!(list(&db, &f).unwrap().iter().all(|a| a.title.to_lowercase().contains("angebot")));
        let f = FeedFilter {
            from: Some(at("2026-09-22T10:00:00Z")),
            to: Some(at("2026-09-22T11:00:00Z")),
            kinds: vec!["page_edited".into()],
            ..Default::default()
        };
        assert_eq!(list(&db, &f).unwrap().len(), 1);
    }

    #[test]
    fn bookings_and_status_changes_are_recorded_with_their_reference() {
        let (db, np) = seeded();
        let v = db.list_vorgaenge(np.id).unwrap()[0].vorgang_nr.clone();
        let e = db
            .insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: Some(v.clone()),
                leistungsart: None,
                start_time: Utc::now() - chrono::Duration::hours(2),
                duration_minutes: 90,
                description: "Review".into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        db.set_entry_status(&[e.id], StatusFlag::Released).unwrap();
        db.set_entry_status(&[e.id], StatusFlag::Exported).unwrap();
        let all = list(&db, &FeedFilter { netzplan_id: Some(np.id), ..Default::default() }).unwrap();
        let kinds: Vec<&str> = all.iter().map(|a| a.kind.as_str()).collect();
        assert_eq!(kinds, ["entry_exported", "entry_released", "entry_created"]);
        assert_eq!(all[2].reference.as_deref(), Some(format!("{}/{v}", np.netzplan_nr).as_str()));
        assert_eq!(all[2].amount, 90);
        assert_eq!(all[0].detail, format!("{}/{v}", np.netzplan_nr));
        let project = db.netzplan_by_id(np.id).unwrap().project_id;
        assert_eq!(list(&db, &FeedFilter { project_id: Some(project), ..Default::default() }).unwrap().len(), 3);
        assert_eq!(list(&db, &FeedFilter { project_id: Some(project + 99), ..Default::default() }).unwrap().len(), 0);
        let day = summary(&db, Utc::now() - chrono::Duration::days(1), Utc::now() + chrono::Duration::days(1)).unwrap();
        assert_eq!(day.booked_minutes, 90);
        // Files once per name.
        db.feed_file("skizze.excalidraw", Utc::now()).unwrap();
        db.feed_file("skizze.excalidraw", Utc::now()).unwrap();
        let files = list(&db, &FeedFilter { kinds: vec!["file_added".into()], ..Default::default() }).unwrap();
        assert_eq!((files.len(), files[0].detail.as_str()), (1, "Zeichnung"));
    }

    #[test]
    fn backfill_derives_history_once_and_only_before_the_journal() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Alt", None).unwrap();
        // Pretend everything so far happened before the journal: clear it and move the start.
        db.conn().execute("DELETE FROM activity", []).unwrap();
        db.conn()
            .execute("UPDATE pages SET created_at = '2026-01-05T08:00:00Z', updated_at = '2026-01-06T12:00:00Z', content = ?2 WHERE id = ?1",
                params![p.id, "- [x] Erledigt\n- [ ] Neu"])
            .unwrap();
        db.conn()
            .execute(
                "INSERT INTO page_versions (page_id, content, created_at) VALUES (?1, '- [ ] Erledigt', '2026-01-06T09:00:00Z')",
                [p.id],
            )
            .unwrap();
        db.meta_set(SINCE, "2026-02-01T00:00:00Z").unwrap();
        let files = vec![
            ("bild.png".to_owned(), at("2026-01-07T10:00:00Z")),
            ("neu.png".to_owned(), at("2026-03-01T10:00:00Z")),
            ("x.excalidraw.svg".to_owned(), at("2026-01-07T10:00:00Z")),
        ];
        let n = backfill(&db, &files).unwrap();
        assert!(n >= 3);
        assert_eq!(backfill(&db, &files).unwrap(), 0, "runs once");
        let all = list(&db, &FeedFilter::default()).unwrap();
        let kinds: Vec<&str> = all.iter().map(|a| a.kind.as_str()).collect();
        assert!(kinds.contains(&"page_created"));
        assert!(kinds.contains(&"task_done"));
        assert!(kinds.contains(&"task_added"));
        assert_eq!(all.iter().filter(|a| a.kind == "file_added").count(), 1);
        let created = all.iter().find(|a| a.kind == "page_created").unwrap();
        assert_eq!(created.at, "2026-01-05T08:00:00Z");
        let done = all.iter().find(|a| a.kind == "task_done").unwrap();
        assert_eq!(done.at, "2026-01-06T12:00:00Z");
    }

    #[test]
    fn describe_days_reads_like_a_diary() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Kickoff", None).unwrap();
        db.save_page_content_at(p.id, "- [x] Agenda", at("2026-09-22T08:30:00Z")).unwrap();
        let cet = FixedOffset::east_opt(2 * 3600).unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 9, 22).unwrap();
        db.conn().execute("UPDATE activity SET at = '2026-09-22T08:30:00Z'", []).unwrap();
        let text = describe_days(&db, day, day, &cet).unwrap();
        assert!(text.contains("1 Seiten bearbeitet"), "{text}");
        assert!(text.contains("2026-09-22 10:30 Aufgabe erledigt: Agenda"), "{text}");
        assert!(describe_days(&db, day, day - chrono::Duration::days(1), &cet).is_err());
    }
}
