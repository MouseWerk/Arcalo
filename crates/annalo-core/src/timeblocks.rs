//! Time blocking („Fokusblöcke“): stretches of time planned in the Kalender for a task, a Jira
//! issue or a page, optionally on a Netzplan/Vorgang. Blocks snap to 15 minutes. A block can
//! start a focus session ([`crate::focus`], which remembers the block) and, while unbooked and
//! over, becomes a signal of „Woche vorschlagen“ ([`crate::weekplan`]).
//!
//! **Outlook** (optional, Settings → Kalender, Windows with Outlook Classic): every change of a
//! block queues a write of its appointment in the default calendar ([`Database::block_outbox_due`]
//! → a [`Bridge`] → [`Database::block_outbox_apply`]; the bridge runs without the database
//! lock). Outlook is never started for it: while it is closed the writes wait and are retried
//! with a growing delay. The appointment's ids are stored, so the calendar sync shows it as the
//! block and not as a meeting a second time ([`Database::calendar_events`]).

use crate::{tr, trf};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::calsync::Busy;
use crate::calsync::tz::Zone;
use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};

/// Blocks start and end on this grid (minutes).
pub const SNAP: i64 = 15;
/// Length of a block dropped into the Kalender (Settings → Kalender may change it).
pub const DEFAULT_MINUTES: u32 = 60;
/// Longest block.
pub const MAX_MINUTES: i64 = 12 * 60;
/// Category of the Outlook appointments.
pub const CATEGORY: &str = "Arcalo";
/// Working hours the free slots of „Im Kalender planen…“ are looked for in (local).
pub const DAY_START: (u32, u32) = (8, 0);
pub const DAY_END: (u32, u32) = (18, 0);
/// At most this many free slots are offered.
pub const MAX_SLOTS: usize = 20;

/// What a block is for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BlockLink {
    #[default]
    None,
    /// A task as [`crate::tasks`] names it: page and ordinal; the text finds it again when
    /// lines move.
    Task {
        page_id: i64,
        ordinal: i64,
        text: String,
    },
    /// A Jira issue (`PROJ-123`).
    Issue {
        key: String,
    },
    Page {
        page_id: i64,
    },
}

/// A new block.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct NewBlock {
    /// Empty: the task's text, the issue's key and summary or the page's title.
    pub title: String,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    pub link: BlockLink,
    /// `NP-8801/1020`; empty = none.
    pub reference: String,
}

/// A change of a block; `None` leaves a field as it is.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct BlockPatch {
    pub title: Option<String>,
    pub start: Option<DateTime<Utc>>,
    pub end: Option<DateTime<Utc>>,
    /// `Some("")` removes the Netzplan/Vorgang.
    pub reference: Option<String>,
}

/// State of a block's Outlook appointment.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OutlookState {
    /// Not in Outlook.
    None,
    /// A write waits (Outlook closed, or not yet run).
    Pending,
    /// The appointment is up to date.
    Written,
}

/// A block as the Kalender shows it: the stored row plus what its link resolves to.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FocusBlock {
    pub id: i64,
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub link: BlockLink,
    pub netzplan_id: Option<i64>,
    pub vorgang_nr: Option<String>,
    /// The Netzplan/Vorgang set on the block (`NP-8801/1020`), empty without one.
    pub reference: String,
    /// The block's reference, else the issue's mapped WBS or the page's `vorgang:` (what a
    /// focus session started from the block is booked on).
    pub suggested_reference: Option<String>,
    /// Title of the linked page (or of the task's page).
    pub page_title: Option<String>,
    /// The linked task is done; `None`: no task link, or the task is gone.
    pub task_done: Option<bool>,
    pub issue_summary: Option<String>,
    pub issue_status: Option<String>,
    pub issue_url: Option<String>,
    pub outlook: OutlookState,
    /// Why the last Outlook write failed (it is retried).
    pub outlook_error: Option<String>,
    pub outlook_entry_id: Option<String>,
    /// Time entry booked from the block („Woche vorschlagen“).
    pub entry_id: Option<i64>,
    /// Minutes worked in focus sessions started from the block.
    pub focus_minutes: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl FocusBlock {
    pub fn minutes(&self) -> i64 {
        (self.end - self.start).num_minutes()
    }
}

/// `t` on the 15-minute grid (nearest).
pub fn snap(t: DateTime<Utc>) -> DateTime<Utc> {
    let s = t.timestamp();
    let step = SNAP * 60;
    let snapped = (s + step / 2).div_euclid(step) * step;
    DateTime::from_timestamp(snapped, 0).unwrap_or(t)
}

/// Start and end snapped, the end at least one step after the start and at most
/// [`MAX_MINUTES`] later.
pub fn normalize(start: DateTime<Utc>, end: DateTime<Utc>) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = snap(start);
    let end = snap(end).max(start + Duration::minutes(SNAP));
    (start, end.min(start + Duration::minutes(MAX_MINUTES)))
}

/// Whether `a0..a1` and `b0..b1` share time (touching ends do not).
pub fn overlaps(a0: DateTime<Utc>, a1: DateTime<Utc>, b0: DateTime<Utc>, b1: DateTime<Utc>) -> bool {
    a0 < b1 && b0 < a1
}

/// Starts of free stretches of `minutes` inside `from..to` that touch none of `busy`: the start
/// of every free gap and the full and half hours after it, on the grid, earliest first, at most
/// [`MAX_SLOTS`].
pub fn free_slots(
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    busy: &[(DateTime<Utc>, DateTime<Utc>)],
    minutes: i64,
) -> Vec<DateTime<Utc>> {
    let len = Duration::minutes(minutes.clamp(SNAP, MAX_MINUTES));
    let step = SNAP * 60;
    // The first start on the grid at or after `from`.
    let first = DateTime::from_timestamp((from.timestamp() + step - 1).div_euclid(step) * step, 0).unwrap_or(from);
    let free = |s: DateTime<Utc>| s + len <= to && !busy.iter().any(|&(b0, b1)| overlaps(s, s + len, b0, b1));
    let mut out: Vec<DateTime<Utc>> = vec![];
    let mut t = first;
    let mut gap_start = true;
    while t + len <= to && out.len() < MAX_SLOTS {
        if free(t) {
            if gap_start || t.timestamp() % 1800 == 0 {
                out.push(t);
            }
            gap_start = false;
        } else {
            gap_start = true;
        }
        t += Duration::minutes(SNAP);
    }
    out
}

/// Subject of the Outlook appointment of a block.
pub fn outlook_subject(title: &str) -> String {
    trf!("Fokus: {}", "Focus: {}", title.trim())
}

const COLS: &str =
    "b.id, b.title, b.start_at, b.end_at, b.link_kind, b.page_id, b.task_ordinal, b.task_text, b.issue_key,
     b.netzplan_id, b.vorgang_nr, n.netzplan_nr, b.outlook_entry_id, b.entry_id, b.created_at, b.updated_at,
     p.title, p.content,
     (SELECT t.done FROM tasks t WHERE t.page_id = b.page_id AND t.text = b.task_text
       ORDER BY ABS(t.ordinal - b.task_ordinal) LIMIT 1),
     i.summary, i.status, i.url,
     o.id IS NOT NULL, o.error,
     (SELECT IFNULL(SUM(f.worked_minutes), 0) FROM focus_sessions f WHERE f.block_id = b.id)";

const FROM: &str = "focus_blocks b
     LEFT JOIN netzplaene n ON n.id = b.netzplan_id
     LEFT JOIN pages p ON p.id = b.page_id AND p.deleted_at IS NULL
     LEFT JOIN issues i ON i.key = b.issue_key AND i.rowid = (SELECT MIN(rowid) FROM issues WHERE key = b.issue_key)
     LEFT JOIN focus_block_outbox o ON o.marker = b.marker AND o.op = 'upsert'";

/// A row of [`COLS`]; the issue mapping of the suggested reference is filled in afterwards.
fn map(r: &Row) -> rusqlite::Result<(FocusBlock, Option<String>)> {
    let kind: String = r.get(4)?;
    let page_id: Option<i64> = r.get(5)?;
    let link = match (kind.as_str(), page_id) {
        ("task", Some(page_id)) => BlockLink::Task {
            page_id,
            ordinal: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            text: r.get::<_, Option<String>>(7)?.unwrap_or_default(),
        },
        ("page", Some(page_id)) => BlockLink::Page { page_id },
        ("issue", _) => BlockLink::Issue { key: r.get::<_, Option<String>>(8)?.unwrap_or_default() },
        _ => BlockLink::None,
    };
    let vorgang: Option<String> = r.get(10)?;
    let np_nr: Option<String> = r.get(11)?;
    let reference = np_nr.as_deref().map(|n| crate::desktop::timer_label(n, vorgang.as_deref())).unwrap_or_default();
    let content: Option<String> = r.get(17)?;
    let page_ref = content.as_deref().and_then(crate::pagework::page_reference);
    let pending: bool = r.get(22)?;
    let entry: Option<String> = r.get(12)?;
    let is_task = matches!(link, BlockLink::Task { .. });
    Ok((
        FocusBlock {
            id: r.get(0)?,
            title: r.get(1)?,
            start: parse_ts(&r.get::<_, String>(2)?)?,
            end: parse_ts(&r.get::<_, String>(3)?)?,
            netzplan_id: r.get(9)?,
            vorgang_nr: vorgang,
            suggested_reference: Some(reference.clone()).filter(|r| !r.is_empty()),
            reference,
            page_title: r.get(16)?,
            task_done: if is_task { r.get(18)? } else { None },
            issue_summary: r.get(19)?,
            issue_status: r.get(20)?,
            issue_url: r.get::<_, Option<String>>(21)?.filter(|u| !u.is_empty()),
            outlook: match (pending, &entry) {
                (true, _) => OutlookState::Pending,
                (false, Some(_)) => OutlookState::Written,
                (false, None) => OutlookState::None,
            },
            outlook_error: r.get(23)?,
            outlook_entry_id: entry,
            entry_id: r.get(13)?,
            focus_minutes: r.get(24)?,
            created_at: parse_ts(&r.get::<_, String>(14)?)?,
            updated_at: parse_ts(&r.get::<_, String>(15)?)?,
            link,
        },
        page_ref,
    ))
}

/// One write of the Outlook bridge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteOp {
    /// The queue row (never reused); the result names it.
    pub key: i64,
    /// The block's marker, stamped on the appointment: a write whose answer was lost finds it
    /// again by it (no second appointment), a delete without EntryID too.
    pub marker: String,
    /// `upsert` (create, or update the appointment `entry_id`) or `delete`.
    pub op: String,
    pub entry_id: Option<String>,
    pub subject: String,
    /// Local wall-clock times (Outlook's `Start`/`End`).
    pub start: Option<NaiveDateTime>,
    pub end: Option<NaiveDateTime>,
    /// The change the write was made for (see `focus_block_outbox.seq`).
    #[serde(skip)]
    pub seq: i64,
}

/// What the bridge reports for one write.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteResult {
    /// [`WriteOp::key`].
    pub key: i64,
    pub ok: bool,
    /// The appointment's EntryID (upsert; a new one when it was created again).
    pub entry_id: Option<String>,
    /// Its global appointment id (what the calendar sync uses as uid).
    pub global_id: Option<String>,
    pub error: Option<String>,
}

/// Writes appointments to Outlook: the PowerShell script on Windows, a fixture in tests.
pub trait Bridge {
    /// Runs `ops` in one go; an `Err` means none was done (Outlook closed, no Outlook).
    fn write(&self, ops: &[WriteOp]) -> Result<Vec<WriteResult>>;
}

/// Minutes until the next try after `attempts` failures: 1, 2, 4 … 30.
pub fn retry_minutes(attempts: i64) -> i64 {
    1i64.checked_shl(attempts.clamp(0, 10) as u32).unwrap_or(30).min(30)
}

fn block_missing(id: i64) -> Error {
    Error::not_found("focus block", id.to_string())
}

impl Database {
    /// Blocks overlapping `from..to`, by start.
    pub fn blocks_in(&self, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<FocusBlock>> {
        let mut st = self.conn().prepare_cached(&format!(
            "SELECT {COLS} FROM {FROM} WHERE b.start_at < ?2 AND b.end_at > ?1 ORDER BY b.start_at, b.id"
        ))?;
        let rows = st.query_map(params![ts(from), ts(to)], map)?;
        let mut out = vec![];
        for r in rows {
            let (b, page_ref) = r?;
            out.push(self.with_suggestion(b, page_ref)?);
        }
        Ok(out)
    }

    /// One block.
    pub fn block(&self, id: i64) -> Result<FocusBlock> {
        let row = self
            .conn()
            .query_row(&format!("SELECT {COLS} FROM {FROM} WHERE b.id = ?1"), [id], map)
            .optional()?
            .ok_or_else(|| block_missing(id))?;
        self.with_suggestion(row.0, row.1)
    }

    fn with_suggestion(&self, mut b: FocusBlock, page_ref: Option<String>) -> Result<FocusBlock> {
        if b.suggested_reference.is_none() {
            b.suggested_reference = match &b.link {
                BlockLink::Issue { key } => self.issue_wbs_for(key)?,
                BlockLink::Task { .. } | BlockLink::Page { .. } => page_ref,
                BlockLink::None => None,
            };
        }
        Ok(b)
    }

    /// The title a block gets from its link.
    fn link_title(&self, link: &BlockLink) -> Result<String> {
        Ok(match link {
            BlockLink::None => String::new(),
            BlockLink::Task { text, .. } => text.clone(),
            BlockLink::Issue { key } => {
                let summary: Option<String> = self
                    .conn()
                    .query_row("SELECT summary FROM issues WHERE key = ?1 LIMIT 1", [key], |r| r.get(0))
                    .optional()?;
                match summary.filter(|s| !s.trim().is_empty()) {
                    Some(s) => format!("{key} {}", s.trim()),
                    None => key.clone(),
                }
            }
            BlockLink::Page { page_id } => self
                .conn()
                .query_row("SELECT title FROM pages WHERE id = ?1", [page_id], |r| r.get(0))
                .optional()?
                .ok_or_else(|| Error::not_found("page", page_id.to_string()))?,
        })
    }

    /// Netzplan id and Vorgang of a reference; `""` → none.
    fn block_reference(&self, reference: &str) -> Result<(Option<i64>, Option<String>)> {
        match reference.trim() {
            "" => Ok((None, None)),
            r => {
                let (np, v, _) = crate::focus::resolve(self, r)?;
                Ok((Some(np), v))
            }
        }
    }

    fn block_marker(&self, id: i64) -> Result<String> {
        Ok(self.conn().query_row("SELECT marker FROM focus_blocks WHERE id = ?1", [id], |r| r.get(0))?)
    }

    /// Queues the write of block `id`'s appointment: one waiting write per block, a change
    /// while it waits (or is under way) bumps it.
    fn block_enqueue_upsert(&self, id: i64) -> Result<()> {
        let marker = self.block_marker(id)?;
        let bumped = self.conn().execute(
            "UPDATE focus_block_outbox SET seq = seq + 1, attempts = 0, next_try = NULL
             WHERE marker = ?1 AND op = 'upsert'",
            [&marker],
        )?;
        if bumped == 0 {
            self.conn().execute("INSERT INTO focus_block_outbox (marker, op) VALUES (?1, 'upsert')", [&marker])?;
        }
        Ok(())
    }

    /// Queues the delete of the appointment `marker` (a row of its own, nothing merges into
    /// it). Without `entry_id` the bridge looks the appointment up by its marker.
    fn block_enqueue_delete(&self, marker: &str, entry_id: Option<&str>, uid: Option<&str>) -> Result<()> {
        let updated = self.conn().execute(
            "UPDATE focus_block_outbox SET entry_id = COALESCE(?2, entry_id), uid = COALESCE(?3, uid),
               seq = seq + 1, attempts = 0, next_try = NULL
             WHERE marker = ?1 AND op = 'delete'",
            params![marker, entry_id, uid],
        )?;
        if updated == 0 {
            self.conn().execute(
                "INSERT INTO focus_block_outbox (marker, op, entry_id, uid) VALUES (?1, 'delete', ?2, ?3)",
                params![marker, entry_id, uid],
            )?;
        }
        Ok(())
    }

    /// Creates a block (snapped to 15 minutes). `outlook`: write it to Outlook as well.
    pub fn block_create(&self, b: &NewBlock, now: DateTime<Utc>, outlook: bool) -> Result<FocusBlock> {
        let (Some(start), Some(end)) = (b.start, b.end) else {
            return Err(Error::State(tr!("Beginn und Ende fehlen", "Start and end are missing").into()));
        };
        let (start, end) = normalize(start, end);
        let link = match &b.link {
            BlockLink::Issue { key } if key.trim().is_empty() => BlockLink::None,
            BlockLink::Issue { key } => BlockLink::Issue { key: key.trim().to_ascii_uppercase() },
            l => l.clone(),
        };
        let mut title = b.title.trim().to_owned();
        if title.is_empty() {
            title = self.link_title(&link)?;
        }
        if title.is_empty() {
            title = tr!("Fokusblock", "Focus block").into();
        }
        let (np, vorgang) = self.block_reference(&b.reference)?;
        let (kind, page_id, ordinal, text, key) = match &link {
            BlockLink::None => ("", None, None, None, None),
            BlockLink::Task { page_id, ordinal, text } => {
                ("task", Some(*page_id), Some(*ordinal), Some(text.clone()), None)
            }
            BlockLink::Issue { key } => ("issue", None, None, None, Some(key.clone())),
            BlockLink::Page { page_id } => ("page", Some(*page_id), None, None, None),
        };
        self.atomic(|| {
            self.conn().execute(
                "INSERT INTO focus_blocks (title, start_at, end_at, link_kind, page_id, task_ordinal, task_text, issue_key,
                   netzplan_id, vorgang_nr, created_at, updated_at, marker)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11, 'arcalo-' || lower(hex(randomblob(16))))",
                params![title, ts(start), ts(end), kind, page_id, ordinal, text, key, np, vorgang, ts(now)],
            )?;
            let id = self.conn().last_insert_rowid();
            if outlook {
                self.block_enqueue_upsert(id)?;
            }
            self.block(id)
        })
    }

    /// Moves, resizes or renames a block, or sets its Netzplan/Vorgang. A change of time or
    /// title updates its Outlook appointment (`outlook`, or when it has one).
    pub fn block_update(&self, id: i64, p: &BlockPatch, now: DateTime<Utc>, outlook: bool) -> Result<FocusBlock> {
        let old = self.block(id)?;
        let (start, end) = normalize(p.start.unwrap_or(old.start), p.end.unwrap_or(old.end));
        let title = match p.title.as_deref().map(str::trim) {
            Some("") | None => old.title.clone(),
            Some(t) => t.to_owned(),
        };
        let (np, vorgang) = match &p.reference {
            Some(r) => self.block_reference(r)?,
            None => (old.netzplan_id, old.vorgang_nr.clone()),
        };
        self.atomic(|| {
            self.conn().execute(
                "UPDATE focus_blocks SET title = ?2, start_at = ?3, end_at = ?4, netzplan_id = ?5, vorgang_nr = ?6,
                   updated_at = ?7 WHERE id = ?1",
                params![id, title, ts(start), ts(end), np, vorgang, ts(now)],
            )?;
            let changed = start != old.start || end != old.end || title != old.title;
            if changed && (outlook || old.outlook_entry_id.is_some()) {
                self.block_enqueue_upsert(id)?;
            }
            self.block(id)
        })
    }

    /// Deletes a block; its Outlook appointment is deleted too (queued). A first write that
    /// is still waiting or under way may have created one: then the delete is queued as well
    /// (by marker until the write's answer brings the EntryID).
    pub fn block_delete(&self, id: i64) -> Result<()> {
        let old = self.block(id)?;
        self.atomic(|| {
            let (marker, uid): (String, Option<String>) =
                self.conn().query_row("SELECT marker, outlook_uid FROM focus_blocks WHERE id = ?1", [id], |r| {
                    Ok((r.get(0)?, r.get(1)?))
                })?;
            let waiting =
                self.conn().execute("DELETE FROM focus_block_outbox WHERE marker = ?1 AND op = 'upsert'", [&marker])?
                    > 0;
            if old.outlook_entry_id.is_some() || waiting {
                self.block_enqueue_delete(&marker, old.outlook_entry_id.as_deref(), uid.as_deref())?;
            }
            self.conn().execute("DELETE FROM focus_blocks WHERE id = ?1", [id])?;
            Ok(())
        })
    }

    /// Ticks off the block's task.
    pub fn block_task_done(&self, id: i64) -> Result<()> {
        match self.block(id)?.link {
            BlockLink::Task { page_id, ordinal, text } => self.set_task_done(page_id, ordinal, true, Some(&text)),
            _ => Err(Error::State(tr!("Der Block gehört zu keiner Aufgabe", "The block has no task").into())),
        }
    }

    /// Free starts on `day` (local working hours, from now on today) for a block of `minutes`:
    /// busy meetings of `sources` and other blocks are avoided.
    pub fn block_free_slots(
        &self,
        day: NaiveDate,
        minutes: i64,
        now: DateTime<Utc>,
        zone: &Zone,
        sources: &[String],
    ) -> Result<Vec<DateTime<Utc>>> {
        let at = |h: u32, m: u32| zone.to_utc(day.and_time(NaiveTime::from_hms_opt(h, m, 0).unwrap_or_default()));
        let from = at(DAY_START.0, DAY_START.1).max(now);
        let to = at(DAY_END.0, DAY_END.1);
        let midnight = zone.to_utc(day.and_time(NaiveTime::MIN));
        let next = zone.to_utc((day + chrono::Days::new(1)).and_time(NaiveTime::MIN));
        let mut busy: Vec<(DateTime<Utc>, DateTime<Utc>)> = self
            .calendar_events(midnight, next, sources)?
            .into_iter()
            .filter(|e| !e.event.all_day && !matches!(e.event.busy, Busy::Free))
            .map(|e| (e.event.start, e.event.end))
            .collect();
        busy.extend(self.blocks_in(midnight, next)?.into_iter().map(|b| (b.start, b.end)));
        Ok(free_slots(from, to, &busy, minutes))
    }

    /// The Outlook writes due at `now` (all of them with `force`), with what to write.
    pub fn block_outbox_due(&self, now: DateTime<Utc>, zone: &Zone, force: bool) -> Result<Vec<WriteOp>> {
        let rows: Vec<(i64, String, String, Option<String>, i64)> = {
            let mut st = self.conn().prepare_cached(
                "SELECT id, marker, op, entry_id, seq FROM focus_block_outbox
                 WHERE ?2 OR next_try IS NULL OR next_try <= ?1 ORDER BY id",
            )?;
            st.query_map(params![ts(now), force], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut out = vec![];
        for (key, marker, op, entry_id, seq) in rows {
            if op == "delete" {
                out.push(WriteOp { key, marker, op, entry_id, subject: String::new(), start: None, end: None, seq });
                continue;
            }
            let id: Option<i64> = self
                .conn()
                .query_row("SELECT id FROM focus_blocks WHERE marker = ?1", [&marker], |r| r.get(0))
                .optional()?;
            match id.map(|id| self.block(id)).transpose()? {
                Some(b) => out.push(WriteOp {
                    key,
                    marker,
                    op,
                    entry_id: b.outlook_entry_id.clone(),
                    subject: outlook_subject(&b.title),
                    start: Some(zone.to_wall(b.start)),
                    end: Some(zone.to_wall(b.end)),
                    seq,
                }),
                // Gone meanwhile (its delete, if one is needed, is queued separately).
                None => {
                    self.conn().execute("DELETE FROM focus_block_outbox WHERE id = ?1", [key])?;
                }
            }
        }
        Ok(out)
    }

    /// Stores what the bridge did with `ops`: the appointment ids of the blocks, done writes
    /// leave the queue (unless the block changed again meanwhile), failed ones wait for their
    /// next try. An appointment written for a block deleted meanwhile is deleted again.
    pub fn block_outbox_apply(
        &self,
        ops: &[WriteOp],
        results: &Result<Vec<WriteResult>>,
        now: DateTime<Utc>,
    ) -> Result<()> {
        self.atomic(|| {
            let fail = |op: &WriteOp, msg: &str| -> Result<()> {
                let attempts: i64 = self
                    .conn()
                    .query_row("SELECT attempts FROM focus_block_outbox WHERE id = ?1", [op.key], |r| r.get(0))
                    .optional()?
                    .unwrap_or(0);
                let next = now + Duration::minutes(retry_minutes(attempts));
                self.conn().execute(
                    "UPDATE focus_block_outbox SET attempts = attempts + 1, next_try = ?3, error = ?4
                     WHERE id = ?1 AND seq = ?2",
                    params![op.key, op.seq, ts(next), msg],
                )?;
                Ok(())
            };
            match results {
                Err(e) => {
                    let msg = e.to_string();
                    for op in ops {
                        fail(op, &msg)?;
                    }
                }
                Ok(results) => {
                    for op in ops {
                        let Some(r) = results.iter().find(|r| r.key == op.key) else {
                            fail(op, tr!("Outlook hat nicht geantwortet", "Outlook did not answer"))?;
                            continue;
                        };
                        if !r.ok {
                            fail(op, r.error.as_deref().unwrap_or(""))?;
                            continue;
                        }
                        if op.op == "upsert" {
                            // An answer without ids keeps the stored ones.
                            let entry = r.entry_id.clone().filter(|e| !e.is_empty());
                            let uid = r.global_id.clone().filter(|g| !g.is_empty()).or_else(|| entry.clone());
                            let stored = self.conn().execute(
                                "UPDATE focus_blocks SET outlook_entry_id = COALESCE(?2, outlook_entry_id),
                                   outlook_uid = COALESCE(?3, outlook_uid) WHERE marker = ?1",
                                params![op.marker, entry, uid],
                            )?;
                            if stored == 0 {
                                self.block_enqueue_delete(&op.marker, entry.as_deref(), uid.as_deref())?;
                            }
                        }
                        self.conn().execute(
                            "DELETE FROM focus_block_outbox WHERE id = ?1 AND seq = ?2",
                            params![op.key, op.seq],
                        )?;
                    }
                }
            }
            Ok(())
        })
    }

    /// Writes waiting for Outlook.
    pub fn block_outbox_len(&self) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM focus_block_outbox", [], |r| r.get(0))?)
    }
}

/// One round of Outlook writes with `bridge` (tests; the app runs the bridge without holding
/// the database).
pub fn flush(db: &Database, bridge: &dyn Bridge, now: DateTime<Utc>, zone: &Zone, force: bool) -> Result<usize> {
    let ops = db.block_outbox_due(now, zone, force)?;
    if ops.is_empty() {
        return Ok(0);
    }
    let results = bridge.write(&ops);
    db.block_outbox_apply(&ops, &results, now)?;
    results.map(|r| r.iter().filter(|x| x.ok).count())
}

#[cfg(test)]
mod tests;
