//! Appointments created, changed, moved and deleted in the Kalender and written to Outlook
//! Classic (1.21, Settings → Kalender → „Termine in Outlook eintragen“).
//!
//! Every change queues one write per appointment in `calendar_outbox` (migration 39): a
//! `create` (found again in Outlook by its marker, the user property `ArcaloEntry`, so a write
//! whose answer got lost adds no second appointment), an `update` with only the fields the user
//! changed and the values Arcalo last saw of them, a `delete` (to Outlook's Deleted Items, so
//! „Rückgängig“ can move it back with a `restore`). A change while a write waits merges into it;
//! a field changed back to the value Outlook has leaves it, and an update without fields is
//! dropped. The writer ([`EntryWriter`], the script's write mode on Windows) runs without the
//! database lock; Outlook is never started for it, a closed Outlook makes the writes wait with a
//! growing delay ([`crate::timeblocks::retry_minutes`]).
//!
//! Outlook compares the seen values before saving: a field changed there since Arcalo saw it is
//! a conflict, which the user settles („Outlook-Version übernehmen“ / „Meine Änderung
//! behalten“); different fields never conflict. Until Outlook has a change, the Kalender shows
//! it from the queue ([`Database::calendar_overlay`]); a new appointment has the key
//! `<source>|<marker>|` until then, and what the user marked on it (booked, note) moves to its
//! real key when it is written.
//!
//! What can be changed ([`editability`]): appointments in the user's own Outlook calendars
//! without attendees, and meetings the user organizes; a change of an organized meeting with
//! attendees is only saved once the user confirmed that Outlook sends the update to them.
//! Meetings received from others, series and free/busy calendars stay read-only („In Outlook
//! öffnen“), and so does everything of ICS sources. A write Outlook refuses (the appointment
//! became part of a series, is gone, or could not be saved) is not retried: it waits with its
//! message until the user drops it („Änderung verwerfen“) or changes the appointment again.

use std::collections::HashMap;

use chrono::{DateTime, Duration, NaiveDateTime, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::calendars::{OutlookCalendar, OutlookKind};
use super::tz::Zone;
use super::{Busy, CalendarEvent, EventMeta, NewEvent, event_key, is_no_subject_title, is_private_title};
use crate::db::{Database, ts};
use crate::error::{Error, Result};
use crate::{tr, trf};

/// Length of a new appointment made with a double click or `N` (Settings → Kalender may change it).
pub const DEFAULT_MINUTES: u32 = 30;
/// Longest appointment made or stretched in Arcalo.
pub const MAX_DAYS: i64 = 14;
/// Start of the markers of new appointments (`arcalo-entry-<32 hex>`).
pub const MARKER_PREFIX: &str = "arcalo-entry-";
/// A done delete is kept this long for its „Rückgängig“.
pub const UNDO_HOURS: i64 = 24;

/// Whether appointments of this Outlook calendar can be written: the user's own calendars
/// (mailbox and files), not colleagues', rooms', groups' or free/busy ones.
pub fn writable_calendar(c: &OutlookCalendar) -> bool {
    matches!(c.kind, OutlookKind::Own | OutlookKind::File) && !c.free_busy && (c.default || !c.entry_id.is_empty())
}

/// Whether an appointment can be changed in Arcalo, or why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Editability {
    /// It can be changed, moved and deleted.
    Yes,
    /// A meeting the user organizes with attendees: a change is saved only after the user
    /// confirmed sending the update; it is not deleted in Arcalo (cancelling is done in Outlook).
    Confirm,
    /// It could be, but „Termine in Outlook eintragen“ is off (the Kalender offers it).
    Off,
    /// An ICS calendar (read only).
    Ics,
    /// No Outlook Classic here (macOS, Linux, the new Outlook).
    Unavailable,
    /// A calendar of someone else (colleague, shared mailbox, room, group).
    Shared,
    /// Only free/busy times are known.
    FreeBusy,
    /// A meeting received from someone else.
    Received,
    /// Part of a series.
    Series,
    /// Read before 1.21: the next sync brings what is needed to write it.
    Unknown,
}

impl Editability {
    /// Changes are allowed (with `Confirm`: after the confirmation).
    pub fn can(self) -> bool {
        matches!(self, Editability::Yes | Editability::Confirm)
    }
}

/// What [`editability`] needs to know besides the appointment.
#[derive(Debug, Clone, Copy)]
pub struct WriteContext<'a> {
    /// „Termine in Outlook eintragen“.
    pub enabled: bool,
    /// Outlook Classic can be written here (Windows, or the test fixture).
    pub available: bool,
    pub calendars: &'a [OutlookCalendar],
}

/// Whether `e` can be changed in Arcalo, or why not.
pub fn editability(e: &CalendarEvent, ctx: &WriteContext) -> Editability {
    if !super::calendars::is_outlook(&e.source) {
        return Editability::Ics;
    }
    let Some(cal) = ctx.calendars.iter().find(|c| c.id == e.source) else { return Editability::Shared };
    if cal.free_busy {
        return Editability::FreeBusy;
    }
    if !writable_calendar(cal) {
        return Editability::Shared;
    }
    if !ctx.available {
        return Editability::Unavailable;
    }
    let pending_create = e.write.as_ref().is_some_and(|w| w.op == "create");
    if e.event.recurring {
        return Editability::Series;
    }
    if !matches!(e.event.meta.meeting, 0 | 1) {
        return Editability::Received;
    }
    if e.event.meta.outlook_id.is_none() && !pending_create {
        return Editability::Unknown;
    }
    if !ctx.enabled {
        return Editability::Off;
    }
    if e.event.meta.meeting == 1 && e.event.meta.has_attendees {
        return Editability::Confirm;
    }
    Editability::Yes
}

/// The fields Arcalo writes: a change sets only what the user changed (a redacted title or a
/// text Arcalo never read is never written).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Fields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

impl Fields {
    pub fn is_empty(&self) -> bool {
        self.title.is_none() && self.start.is_none() && self.end.is_none() && self.location.is_none()
    }

    /// The event with these fields.
    pub fn apply(&self, e: &mut NewEvent) {
        if let Some(t) = &self.title {
            e.title = t.clone();
        }
        if let Some(t) = self.start {
            e.start = t;
        }
        if let Some(t) = self.end {
            e.end = t;
        }
        if let Some(l) = &self.location {
            e.location = l.clone();
        }
    }

    /// `other` over these fields.
    fn merge(&mut self, other: &Fields) {
        if other.title.is_some() {
            self.title = other.title.clone();
        }
        if other.start.is_some() {
            self.start = other.start;
        }
        if other.end.is_some() {
            self.end = other.end;
        }
        if other.location.is_some() {
            self.location = other.location.clone();
        }
    }

    /// The values of `e` for the fields set in `like`. What Arcalo shows instead of Outlook's
    /// value is left out: the title of a private appointment and its dropped place, and the
    /// title of one without a subject (they are not Outlook's, would conflict with it, and
    /// Outlook's private values must not come back in a conflict).
    fn of(e: &NewEvent, like: &Fields) -> Fields {
        let veiled = e.private && is_private_title(&e.title);
        let stand_in = veiled || is_no_subject_title(&e.title);
        Fields {
            title: like.title.as_ref().filter(|_| !stand_in).map(|_| e.title.clone()),
            start: like.start.map(|_| e.start),
            end: like.end.map(|_| e.end),
            location: like.location.as_ref().filter(|_| !veiled).map(|_| e.location.clone()),
        }
    }

    /// Drops the fields that equal `seen` (changed back): nothing to write for them.
    fn without_unchanged(mut self, seen: &Fields) -> Fields {
        if self.title.is_some() && self.title == seen.title {
            self.title = None;
        }
        if self.start.is_some() && self.start == seen.start {
            self.start = None;
        }
        if self.end.is_some() && self.end == seen.end {
            self.end = None;
        }
        if self.location.is_some() && self.location == seen.location {
            self.location = None;
        }
        self
    }

    /// Trims the texts and checks the times (start before end, at most [`MAX_DAYS`] when they
    /// change: a longer appointment made in Outlook keeps its length with a new title or place).
    fn cleaned(mut self, start: DateTime<Utc>, end: DateTime<Utc>) -> Result<Fields> {
        if let Some(t) = &self.title {
            let t = t.trim();
            self.title =
                Some(if t.is_empty() { tr!("Neuer Termin", "New appointment").to_owned() } else { t.to_owned() });
        }
        if let Some(l) = &self.location {
            self.location = Some(l.trim().to_owned());
        }
        let (s, e) = (self.start.unwrap_or(start), self.end.unwrap_or(end));
        if e <= s {
            return Err(Error::State(tr!("Das Ende liegt vor dem Beginn", "The end is before the start").into()));
        }
        if (self.start.is_some() || self.end.is_some()) && e - s > Duration::days(MAX_DAYS) {
            return Err(Error::State(trf!(
                "Ein Termin dauert höchstens {} Tage",
                "An appointment lasts at most {} days",
                MAX_DAYS
            )));
        }
        Ok(self)
    }
}

/// A new appointment.
#[derive(Debug, Clone, Deserialize)]
pub struct EntryDraft {
    /// The calendar (`outlook` or another own Outlook calendar).
    pub source: String,
    #[serde(default)]
    pub title: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    #[serde(default)]
    pub location: String,
}

/// A change of an appointment in the Kalender that Outlook does not have yet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WriteState {
    /// `create`, `update`, `delete` or `restore`.
    pub op: String,
    /// `pending`, `conflict` or `refused` (Outlook refused it: it waits for the user, never
    /// retried by itself).
    pub state: String,
    /// Why the last write failed (retried while `pending`).
    pub error: Option<String>,
    /// A conflict: Outlook's values of the fields changed on both sides.
    pub outlook: Option<Fields>,
    /// The user's values of those fields.
    pub mine: Option<Fields>,
    /// The user confirmed sending the update to the attendees.
    pub send: bool,
}

/// One write of the writer.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EntryOp {
    /// The queue row; the result names it.
    pub key: i64,
    pub marker: String,
    /// `create`, `update`, `delete` or `restore`.
    pub op: String,
    pub source: String,
    /// The appointment's uid (none for a new one).
    pub uid: Option<String>,
    /// The Outlook calendar: the default one, or another by its ids.
    pub calendar: CalendarRef,
    pub entry_id: Option<String>,
    /// The item in Deleted Items (`restore`).
    pub deleted_id: Option<String>,
    /// What to write and what Arcalo last saw, in local wall-clock time.
    pub fields: LocalFields,
    pub seen: LocalFields,
    pub send: bool,
    #[serde(skip)]
    pub seq: i64,
}

/// The folder of an Outlook calendar.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct CalendarRef {
    pub default: bool,
    pub entry_id: String,
    pub store_id: String,
}

/// [`Fields`] as Outlook takes them (`Subject`, local `Start`/`End`, `Location`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalFields {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

/// Outlook's local time format (invariant culture).
pub const LOCAL_FORMAT: &str = "%Y-%m-%dT%H:%M:%S";

impl LocalFields {
    pub fn from_fields(f: &Fields, zone: &Zone) -> LocalFields {
        let wall = |t: DateTime<Utc>| zone.to_wall(t).format(LOCAL_FORMAT).to_string();
        LocalFields {
            subject: f.title.clone(),
            start: f.start.map(wall),
            end: f.end.map(wall),
            location: f.location.clone(),
        }
    }

    pub fn to_fields(&self, zone: &Zone) -> Fields {
        let utc = |s: &String| NaiveDateTime::parse_from_str(s.trim(), LOCAL_FORMAT).ok().map(|t| zone.to_utc(t));
        Fields {
            title: self.subject.clone(),
            start: self.start.as_ref().and_then(utc),
            end: self.end.as_ref().and_then(utc),
            location: self.location.clone(),
        }
    }
}

/// What the writer reports for one write.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct EntryResult {
    /// [`EntryOp::key`].
    pub key: i64,
    pub ok: bool,
    pub entry_id: Option<String>,
    pub global_id: Option<String>,
    /// Outlook's `LastModificationTime` after the write (RFC 3339 UTC).
    pub modified: Option<String>,
    /// A delete: the item in Deleted Items.
    pub deleted_id: Option<String>,
    /// `conflict`, `not_found`, `needs_send`, `series`, `received`, `save`, …
    pub code: Option<String>,
    pub error: Option<String>,
    /// A conflict: Outlook's values of the fields changed on both sides.
    pub current: Option<LocalFields>,
}

/// Writes appointments to Outlook: the script on Windows, the fixture in tests.
pub trait EntryWriter {
    /// Runs `ops` in one go; an `Err` means none was done (Outlook closed, no Outlook).
    fn write(&self, ops: &[EntryOp]) -> Result<Vec<EntryResult>>;
}

/// A queue row.
#[derive(Debug, Clone)]
struct Row {
    id: i64,
    marker: String,
    source: String,
    op: String,
    uid: Option<String>,
    entry_id: Option<String>,
    fields: Fields,
    seen: Fields,
    send: bool,
    seq: i64,
    state: String,
    error: Option<String>,
    conflict: Option<Fields>,
    deleted_id: Option<String>,
    snapshot: Option<NewEvent>,
    /// Handed to Outlook at least once (a create may be there even without an answer).
    sent: bool,
}

const ROW_COLS: &str = "id, marker, source, op, uid, entry_id, fields, seen, send, seq, state, error, conflict,
     deleted_id, snapshot, sent";

fn parsed<T: serde::de::DeserializeOwned>(s: Option<String>) -> Option<T> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<Row> {
    let json = parsed::<Fields>;
    Ok(Row {
        id: r.get(0)?,
        marker: r.get(1)?,
        source: r.get(2)?,
        op: r.get(3)?,
        uid: r.get(4)?,
        entry_id: r.get(5)?,
        fields: json(r.get(6)?).unwrap_or_default(),
        seen: json(r.get(7)?).unwrap_or_default(),
        send: r.get(8)?,
        seq: r.get(9)?,
        state: r.get(10)?,
        error: r.get(11)?,
        conflict: parsed(r.get(12)?),
        deleted_id: r.get(13)?,
        snapshot: parsed(r.get(14)?),
        sent: r.get(15)?,
    })
}

impl Row {
    fn write_state(&self) -> WriteState {
        WriteState {
            op: self.op.clone(),
            state: self.state.clone(),
            error: self.error.clone(),
            mine: self.conflict.as_ref().map(|c| self.fields.restricted_to(c)),
            outlook: self.conflict.clone(),
            send: self.send,
        }
    }
}

impl Fields {
    /// These fields where `like` has one.
    fn restricted_to(&self, like: &Fields) -> Fields {
        Fields {
            title: self.title.clone().filter(|_| like.title.is_some()),
            start: self.start.filter(|_| like.start.is_some()),
            end: self.end.filter(|_| like.end.is_some()),
            location: self.location.clone().filter(|_| like.location.is_some()),
        }
    }
}

/// `source`, `uid` and `instance` of an event key.
pub fn split_key(key: &str) -> Option<(&str, &str, &str)> {
    let mut it = key.splitn(3, '|');
    Some((it.next()?, it.next()?, it.next().unwrap_or("")))
}

fn new_marker() -> String {
    use std::fmt::Write;
    let mut bytes = [0u8; 16];
    // A clock-based fallback is unique enough for a marker if the system has no randomness.
    if getrandom::fill(&mut bytes).is_err() {
        bytes =
            Utc::now().timestamp_nanos_opt().unwrap_or_default().to_le_bytes().repeat(2).try_into().unwrap_or_default();
    }
    let mut s = String::from(MARKER_PREFIX);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn json(v: &impl Serialize) -> Result<String> {
    Ok(serde_json::to_string(v)?)
}

fn gone() -> Error {
    Error::State(
        tr!(
            "Der Termin ist nicht mehr im Kalender (inzwischen geändert oder gelöscht)",
            "The appointment is no longer in the calendar (changed or deleted meanwhile)"
        )
        .into(),
    )
}

/// The message of a write Outlook refused.
pub fn error_text(code: &str, detail: &str) -> String {
    match code {
        "not_found" => tr!("Der Termin ist in Outlook nicht mehr da", "The appointment is gone from Outlook").into(),
        "series" => tr!(
            "Termine einer Serie lassen sich nur in Outlook ändern",
            "Appointments of a series can only be changed in Outlook"
        )
        .into(),
        "received" => tr!(
            "Besprechungen anderer lassen sich nur in Outlook ändern",
            "Meetings of others can only be changed in Outlook"
        )
        .into(),
        "needs_send" => tr!(
            "Die Besprechung hat Teilnehmende: Änderungen gehen nur mit Aktualisierung an sie",
            "The meeting has attendees: changes need an update sent to them"
        )
        .into(),
        _ => trf!(
            "Outlook hat den Termin nicht gespeichert: {}",
            "Outlook did not save the appointment: {}",
            if detail.is_empty() { code } else { detail }
        ),
    }
}

/// A new appointment's event as shown before Outlook has it.
fn draft_event(marker: &str, f: &Fields) -> Option<NewEvent> {
    Some(NewEvent {
        uid: marker.to_owned(),
        instance: String::new(),
        recurring: false,
        start: f.start?,
        end: f.end?,
        all_day: false,
        title: f.title.clone().unwrap_or_default(),
        location: f.location.clone().unwrap_or_default(),
        organizer: String::new(),
        attendees: vec![],
        body: None,
        link: None,
        busy: Busy::Busy,
        private: false,
        categories: vec![],
        meta: EventMeta::default(),
    })
}

impl Database {
    fn outbox_rows(&self, filter: &str, args: impl rusqlite::Params) -> Result<Vec<Row>> {
        let mut st =
            self.conn().prepare(&format!("SELECT {ROW_COLS} FROM calendar_outbox WHERE {filter} ORDER BY id"))?;
        let rows = st.query_map(args, map_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// The waiting row of the appointment `source`/`uid` (a create by its marker).
    fn outbox_row_for(&self, source: &str, uid: &str) -> Result<Option<Row>> {
        let rows = if uid.starts_with(MARKER_PREFIX) {
            self.outbox_rows("marker = ?1", [uid])?
        } else {
            self.outbox_rows("source = ?1 AND uid = ?2", [source, uid])?
        };
        Ok(rows.into_iter().last())
    }

    /// The stored event of a key, without changes waiting for Outlook.
    fn stored_event(&self, key: &str) -> Result<Option<CalendarEvent>> {
        let Some((source, uid, instance)) = split_key(key) else { return Ok(None) };
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {} FROM calendar_events e
                     LEFT JOIN calendar_marks m ON m.key = e.source || '|' || e.uid || '|' || e.instance
                     LEFT JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL
                     LEFT JOIN time_entries t ON t.id = m.entry_id
                     WHERE e.source = ?1 AND e.uid = ?2 AND e.instance = ?3",
                    super::EVENT_COLS
                ),
                [source, uid, instance],
                super::map_event,
            )
            .optional()?)
    }

    /// What Arcalo knows of an appointment Outlook has: the stored event, else the one its
    /// waiting row keeps (brought back from Deleted Items, or refused and gone since).
    fn known_event(&self, key: &str, row: Option<&Row>) -> Result<NewEvent> {
        match self.stored_event(key)? {
            Some(e) => Ok(e.event),
            None => row.and_then(|r| r.snapshot.clone()).ok_or_else(gone),
        }
    }

    /// Booked entry, meeting note and „nicht buchen“ of a key (events shown from the queue).
    fn marks_of(&self, key: &str) -> Result<(bool, Option<i64>, Option<i64>)> {
        Ok(self
            .conn()
            .query_row(
                "SELECT m.skip, p.id, t.id FROM calendar_marks m
                 LEFT JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL
                 LEFT JOIN time_entries t ON t.id = m.entry_id WHERE m.key = ?1",
                [key],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .unwrap_or((false, None, None)))
    }

    fn shown(&self, source: &str, ev: NewEvent, row: &Row) -> Result<CalendarEvent> {
        let key = event_key(source, &ev.uid, &ev.instance);
        let (skip, note_page_id, entry_id) = self.marks_of(&key)?;
        Ok(CalendarEvent {
            key,
            source: source.to_owned(),
            event: ev,
            skip,
            note_page_id,
            entry_id,
            also_in: vec![],
            write: Some(row.write_state()),
            editable: None,
        })
    }

    /// The Kalender's view of `events` (of `sources`, overlapping `from..to`) with the changes
    /// that wait for Outlook: new appointments added, changed ones shown as changed (also when
    /// they come into the range by it), deleted ones left out.
    pub fn calendar_overlay(
        &self,
        events: &mut Vec<CalendarEvent>,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        sources: &[String],
    ) -> Result<()> {
        let rows = self.outbox_rows("state <> 'done'", [])?;
        if rows.is_empty() {
            return Ok(());
        }
        let overlaps = |e: &NewEvent| e.start < to && e.end > from;
        for row in rows {
            if !sources.contains(&row.source) {
                continue;
            }
            match row.op.as_str() {
                "create" => {
                    // Written meanwhile and read back by a sync: shown once, as the waiting one.
                    if let Some(entry) = &row.entry_id {
                        events.retain(|e| !(e.source == row.source && e.event.meta.outlook_id.as_ref() == Some(entry)));
                    }
                    if let Some(ev) = draft_event(&row.marker, &row.fields).filter(overlaps) {
                        events.push(self.shown(&row.source, ev, &row)?);
                    }
                }
                // Only the appointment itself: occurrences of a series share its uid.
                "delete" if row.state != "refused" => {
                    events.retain(|e| {
                        !(e.source == row.source
                            && Some(&e.event.uid) == row.uid.as_ref()
                            && e.event.instance.is_empty())
                    });
                }
                // A refused delete stays visible with its message, like a refused change.
                "update" | "restore" | "delete" => {
                    let uid = row.uid.clone().unwrap_or_default();
                    let at = events
                        .iter()
                        .position(|e| e.source == row.source && e.event.uid == uid && e.event.instance.is_empty());
                    let mut shown = match at {
                        Some(i) => events.remove(i),
                        None => match self.stored_event(&event_key(&row.source, &uid, ""))? {
                            Some(e) => e,
                            None => match row.snapshot.clone() {
                                Some(ev) => self.shown(&row.source, ev, &row)?,
                                None => continue,
                            },
                        },
                    };
                    row.fields.apply(&mut shown.event);
                    shown.write = Some(row.write_state());
                    if overlaps(&shown.event) {
                        events.push(shown);
                    }
                }
                _ => {}
            }
        }
        events.sort_by(|a, b| {
            a.event
                .start
                .cmp(&b.event.start)
                .then(b.event.all_day.cmp(&a.event.all_day))
                .then(a.event.title.cmp(&b.event.title))
        });
        Ok(())
    }

    /// One event by its key, with a change waiting for Outlook (also a new appointment).
    pub(crate) fn calendar_event_shown(&self, key: &str) -> Result<Option<CalendarEvent>> {
        let Some((source, uid, instance)) = split_key(key) else { return Ok(None) };
        let stored = self.stored_event(key)?;
        if !instance.is_empty() {
            // An occurrence of a series is never written; a change of the appointment it once
            // was is not its own.
            return Ok(stored);
        }
        let row = self.outbox_row_for(source, uid)?.filter(|r| r.state != "done");
        let Some(row) = row else { return Ok(stored) };
        match (row.op.as_str(), stored) {
            ("create", _) => draft_event(&row.marker, &row.fields).map(|ev| self.shown(source, ev, &row)).transpose(),
            ("delete", _) if row.state != "refused" => Ok(None),
            (_, Some(mut e)) => {
                row.fields.apply(&mut e.event);
                e.write = Some(row.write_state());
                Ok(Some(e))
            }
            (_, None) => row
                .snapshot
                .clone()
                .map(|mut ev| {
                    row.fields.apply(&mut ev);
                    self.shown(source, ev, &row)
                })
                .transpose(),
        }
    }

    /// Creates an appointment in `d.source` (queued for Outlook); returns it as the Kalender shows it.
    pub fn entry_create(&self, d: &EntryDraft, now: DateTime<Utc>) -> Result<CalendarEvent> {
        if !super::calendars::is_outlook(&d.source) {
            return Err(Error::State(
                tr!(
                    "Termine lassen sich nur in Outlook-Kalendern anlegen",
                    "Appointments can only be created in Outlook calendars"
                )
                .into(),
            ));
        }
        let fields = Fields {
            title: Some(d.title.clone()),
            start: Some(d.start),
            end: Some(d.end),
            location: Some(d.location.clone()),
        }
        .cleaned(d.start, d.end)?;
        let marker = new_marker();
        self.conn().execute(
            "INSERT INTO calendar_outbox (marker, source, op, fields, created_at) VALUES (?1, ?2, 'create', ?3, ?4)",
            params![marker, d.source, json(&fields)?, ts(now)],
        )?;
        self.calendar_event_shown(&event_key(&d.source, &marker, ""))?.ok_or_else(gone)
    }

    /// Changes an appointment (only the fields in `patch`). `send`: the user confirmed sending
    /// the update of an organized meeting to its attendees (without it such a change is refused).
    pub fn entry_update(&self, key: &str, patch: &Fields, send: bool, now: DateTime<Utc>) -> Result<CalendarEvent> {
        let (source, uid, _) = split_key(key).ok_or_else(gone)?;
        let shown = self.calendar_event_shown(key)?.ok_or_else(gone)?;
        let patch = patch.clone().cleaned(shown.event.start, shown.event.end)?;
        self.atomic(|| {
            let row = self.outbox_row_for(source, uid)?.filter(|r| r.state != "done");
            if let Some(row) = row.as_ref().filter(|r| r.op == "create") {
                let mut fields = row.fields.clone();
                fields.merge(&patch);
                self.conn().execute(
                    "UPDATE calendar_outbox SET fields = ?2, seq = seq + 1, attempts = 0, next_try = NULL WHERE id = ?1",
                    params![row.id, json(&fields)?],
                )?;
                return Ok(());
            }
            let e = &self.known_event(key, row.as_ref())?;
            if e.recurring {
                return Err(Error::State(error_text("series", "")));
            }
            if !matches!(e.meta.meeting, 0 | 1) {
                return Err(Error::State(error_text("received", "")));
            }
            let confirm = e.meta.meeting == 1 && e.meta.has_attendees;
            if confirm && !send {
                return Err(Error::State(error_text("needs_send", "")));
            }
            let (mut fields, mut seen, keep_send) = match &row {
                Some(r) => (r.fields.clone(), r.seen.clone(), r.send),
                None => (Fields::default(), Fields::default(), false),
            };
            // The value Arcalo saw first stays the one Outlook is compared with.
            let first = Fields::of(e, &patch);
            let mut seen_new = first.clone();
            seen_new.merge(&seen);
            seen = seen_new;
            fields.merge(&patch);
            let fields = fields.without_unchanged(&seen);
            let seen = seen.restricted_to(&fields);
            match row {
                Some(r) if fields.is_empty() && r.op == "update" => {
                    self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [r.id])?;
                }
                // A refused change is tried again with the user's new one.
                Some(r) => {
                    self.conn().execute(
                        "UPDATE calendar_outbox SET fields = ?2, seen = ?3, send = ?4, seq = seq + 1, attempts = 0,
                           next_try = NULL, error = NULL, state = CASE state WHEN 'refused' THEN 'pending' ELSE state END
                         WHERE id = ?1",
                        params![r.id, json(&fields)?, json(&seen)?, (send || keep_send) && confirm],
                    )?;
                }
                None if fields.is_empty() => {}
                None => {
                    self.conn().execute(
                        "INSERT INTO calendar_outbox (marker, source, op, uid, entry_id, fields, seen, send, created_at)
                         VALUES (?1, ?2, 'update', ?3, ?4, ?5, ?6, ?7, ?8)",
                        params![
                            new_marker(),
                            source,
                            uid,
                            e.meta.outlook_id,
                            json(&fields)?,
                            json(&seen)?,
                            send && confirm,
                            ts(now)
                        ],
                    )?;
                }
            }
            Ok(())
        })?;
        self.calendar_event_shown(key)?.ok_or_else(gone)
    }

    /// Deletes an appointment (to Outlook's Deleted Items; queued). [`Database::entry_undo`]
    /// brings it back.
    pub fn entry_delete(&self, key: &str, now: DateTime<Utc>) -> Result<()> {
        let (source, uid, _) = split_key(key).ok_or_else(gone)?;
        let shown = self.calendar_event_shown(key)?.ok_or_else(gone)?;
        self.atomic(|| {
            let row = self.outbox_row_for(source, uid)?.filter(|r| r.state != "done");
            let snapshot = json(&shown.event)?;
            if let Some(r) = row.as_ref().filter(|r| r.op == "create") {
                // Never handed to Outlook: kept aside for the undo. Handed to it before (also a
                // write still under way, or one whose answer got lost): deleted in Outlook by its
                // marker.
                let state = if !r.sent && r.entry_id.is_none() { "done" } else { "pending" };
                self.conn().execute(
                    "UPDATE calendar_outbox SET op = 'delete', state = ?2, snapshot = ?3, seq = seq + 1, attempts = 0,
                       next_try = NULL, error = NULL, conflict = NULL, created_at = ?4 WHERE id = ?1",
                    params![r.id, state, snapshot, ts(now)],
                )?;
                return Ok(());
            }
            if let Some(r) = row.as_ref().filter(|r| r.op == "restore" && r.deleted_id.is_some()) {
                // Brought back from Deleted Items, but not there yet: it stays in Deleted Items
                // and its undo is offered again. A restore under way is deleted again by its answer.
                self.conn().execute(
                    "UPDATE calendar_outbox SET op = 'delete', state = 'done', snapshot = ?2, seq = seq + 1, attempts = 0,
                       next_try = NULL, error = NULL, conflict = NULL, created_at = ?3 WHERE id = ?1",
                    params![r.id, snapshot, ts(now)],
                )?;
                return Ok(());
            }
            let e = &self.known_event(key, row.as_ref())?;
            if e.recurring {
                return Err(Error::State(error_text("series", "")));
            }
            if e.meta.meeting != 0 && (e.meta.meeting != 1 || e.meta.has_attendees) {
                return Err(Error::State(
                    tr!(
                        "Besprechungen mit Teilnehmenden werden in Outlook abgesagt",
                        "Meetings with attendees are cancelled in Outlook"
                    )
                    .into(),
                ));
            }
            match row {
                // A waiting change stays in the row: an undo makes it an update again.
                Some(r) => self.conn().execute(
                    "UPDATE calendar_outbox SET op = 'delete', state = 'pending', snapshot = ?2, entry_id = COALESCE(entry_id, ?3),
                       seq = seq + 1, attempts = 0, next_try = NULL, error = NULL, conflict = NULL WHERE id = ?1",
                    params![r.id, snapshot, e.meta.outlook_id],
                )?,
                None => self.conn().execute(
                    "INSERT INTO calendar_outbox (marker, source, op, uid, entry_id, snapshot, created_at)
                     VALUES (?1, ?2, 'delete', ?3, ?4, ?5, ?6)",
                    params![new_marker(), source, uid, e.meta.outlook_id, snapshot, ts(now)],
                )?,
            };
            Ok(())
        })
    }

    /// Takes back the delete of `key`: a waiting one is dropped (a change that waited before
    /// it waits again), a done one moves the appointment back from Deleted Items.
    pub fn entry_undo(&self, key: &str) -> Result<CalendarEvent> {
        let (source, uid, _) = split_key(key).ok_or_else(gone)?;
        let row = self.outbox_row_for(source, uid)?.filter(|r| r.op == "delete").ok_or_else(gone)?;
        if row.state == "done" && row.deleted_id.is_none() && row.uid.is_some() {
            // Deleted, but Outlook's answer with the item in Deleted Items got lost.
            return Err(Error::State(
                tr!(
                    "Der Termin lässt sich hier nicht zurückholen; er liegt in Outlook unter „Gelöschte Elemente“",
                    "The appointment cannot be brought back here; it is in Outlook's Deleted Items"
                )
                .into(),
            ));
        }
        self.atomic(|| {
            let back = if row.deleted_id.is_some() {
                // In Deleted Items: moved back.
                "restore"
            } else if row.uid.is_none() {
                // A new appointment not written yet: created after all (by its marker, never twice).
                "create"
            } else if row.fields.is_empty() {
                // A delete that may be under way: its answer brings the appointment back.
                self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [row.id])?;
                return Ok(());
            } else {
                "update"
            };
            self.conn().execute(
                "UPDATE calendar_outbox SET op = ?2, state = 'pending', seq = seq + 1, attempts = 0, next_try = NULL,
                   error = NULL WHERE id = ?1",
                params![row.id, back],
            )?;
            Ok(())
        })?;
        self.calendar_event_shown(key)?.ok_or_else(gone)
    }

    /// Settles a conflict: `keep_mine` writes the user's values over Outlook's, otherwise
    /// Outlook's version is taken (the change is dropped and Outlook's values are shown).
    pub fn entry_resolve(&self, key: &str, keep_mine: bool) -> Result<()> {
        let (source, uid, _) = split_key(key).ok_or_else(gone)?;
        let row = self.outbox_row_for(source, uid)?.filter(|r| r.state == "conflict").ok_or_else(gone)?;
        let outlook = row.conflict.clone().unwrap_or_default();
        self.atomic(|| {
            if keep_mine {
                // Outlook's values are what Arcalo has now seen: the next write passes the check.
                let mut seen = row.seen.clone();
                seen.merge(&outlook);
                self.conn().execute(
                    "UPDATE calendar_outbox SET seen = ?2, state = 'pending', conflict = NULL, seq = seq + 1, attempts = 0,
                       next_try = NULL, error = NULL WHERE id = ?1",
                    params![row.id, json(&seen.restricted_to(&row.fields))?],
                )?;
                return Ok(());
            }
            // Outlook's values shown at once; other fields of the change still wait.
            if let Some(mut e) = self.stored_event(&event_key(source, uid, ""))?.map(|e| e.event) {
                outlook.apply(&mut e);
                self.store_event_fields(source, &e)?;
            }
            let fields = Fields {
                title: row.fields.title.clone().filter(|_| outlook.title.is_none()),
                start: row.fields.start.filter(|_| outlook.start.is_none()),
                end: row.fields.end.filter(|_| outlook.end.is_none()),
                location: row.fields.location.clone().filter(|_| outlook.location.is_none()),
            };
            if fields.is_empty() {
                self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [row.id])?;
            } else {
                self.conn().execute(
                    "UPDATE calendar_outbox SET fields = ?2, seen = ?3, state = 'pending', conflict = NULL, seq = seq + 1,
                       attempts = 0, next_try = NULL, error = NULL WHERE id = ?1",
                    params![row.id, json(&fields)?, json(&row.seen.restricted_to(&fields))?],
                )?;
            }
            Ok(())
        })
    }

    /// „Änderung verwerfen“: drops a change that Outlook refused or that still waits (a
    /// conflict has its own choice). A new appointment is gone (one whose write may have reached
    /// Outlook comes back with the next sync), a changed or deleted one shows as Outlook has it,
    /// one brought back from Deleted Items stays there (its undo is offered again).
    pub fn entry_discard(&self, key: &str) -> Result<()> {
        let (source, uid, _) = split_key(key).ok_or_else(gone)?;
        let row = self
            .outbox_row_for(source, uid)?
            .filter(|r| matches!(r.state.as_str(), "pending" | "refused"))
            .ok_or_else(gone)?;
        if row.op == "restore" && row.deleted_id.is_some() {
            self.conn().execute(
                "UPDATE calendar_outbox SET op = 'delete', state = 'done', seq = seq + 1, attempts = 0, next_try = NULL,
                   error = NULL WHERE id = ?1",
                [row.id],
            )?;
        } else {
            self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [row.id])?;
        }
        Ok(())
    }

    /// Writes title, times and place of a stored event (after a write, or Outlook's version taken).
    fn store_event_fields(&self, source: &str, e: &NewEvent) -> Result<()> {
        self.conn().execute(
            "UPDATE calendar_events SET title = ?3, start_at = ?4, end_at = ?5, location = ?6,
               entry_id = COALESCE(?7, entry_id), modified = COALESCE(?8, modified)
             WHERE source = ?1 AND uid = ?2",
            params![source, e.uid, e.title, ts(e.start), ts(e.end), e.location, e.meta.outlook_id, e.meta.modified],
        )?;
        Ok(())
    }

    /// Stores an appointment Outlook has now (a new or restored one) until the next sync reads it.
    fn store_event(&self, source: &str, e: &NewEvent) -> Result<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO calendar_events
               (source, uid, instance, recurring, start_at, end_at, all_day, title, location, organizer,
                attendees, body, link, busy, private, categories, entry_id, modified, meeting, has_attendees)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)",
            params![
                source,
                e.uid,
                e.instance,
                e.recurring,
                ts(e.start),
                ts(e.end),
                e.all_day,
                e.title,
                e.location,
                e.organizer,
                serde_json::to_string(&e.attendees)?,
                e.body,
                e.link,
                super::busy_str(e.busy),
                e.private,
                serde_json::to_string(&e.categories)?,
                e.meta.outlook_id,
                e.meta.modified,
                e.meta.meeting,
                e.meta.has_attendees,
            ],
        )?;
        Ok(())
    }

    /// The writes due at `now` (all waiting ones with `force`); `calendars` names the folders.
    /// Done deletes older than a day are dropped (their undo is over).
    pub fn entry_outbox_due(
        &self,
        now: DateTime<Utc>,
        zone: &Zone,
        force: bool,
        calendars: &[OutlookCalendar],
    ) -> Result<Vec<EntryOp>> {
        self.conn().execute(
            "DELETE FROM calendar_outbox WHERE state = 'done' AND created_at < ?1",
            [ts(now - Duration::hours(UNDO_HOURS))],
        )?;
        let rows = self
            .outbox_rows("state = 'pending' AND (?2 OR next_try IS NULL OR next_try <= ?1)", params![ts(now), force])?;
        let mut out = vec![];
        for r in rows {
            let Some(cal) = calendars.iter().find(|c| c.id == r.source) else { continue };
            if !r.sent {
                self.conn().execute("UPDATE calendar_outbox SET sent = 1 WHERE id = ?1", [r.id])?;
            }
            out.push(EntryOp {
                key: r.id,
                marker: r.marker.clone(),
                op: r.op.clone(),
                source: r.source.clone(),
                uid: r.uid.clone(),
                calendar: CalendarRef {
                    default: cal.default,
                    entry_id: cal.entry_id.clone(),
                    store_id: cal.store_id.clone(),
                },
                entry_id: r.entry_id.clone(),
                deleted_id: r.deleted_id.clone(),
                fields: LocalFields::from_fields(&r.fields, zone),
                seen: LocalFields::from_fields(&r.seen, zone),
                send: r.send,
                seq: r.seq,
            });
        }
        Ok(out)
    }

    /// Stores what the writer did with `ops`: done writes leave the queue (unless changed again
    /// meanwhile), the stored events and marks follow them, conflicts wait for the user, failed
    /// writes for their next try.
    pub fn entry_outbox_apply(
        &self,
        ops: &[EntryOp],
        results: &Result<Vec<EntryResult>>,
        now: DateTime<Utc>,
        zone: &Zone,
    ) -> Result<()> {
        self.atomic(|| {
            let fail = |op: &EntryOp, msg: &str| -> Result<()> {
                let attempts: i64 = self
                    .conn()
                    .query_row("SELECT attempts FROM calendar_outbox WHERE id = ?1", [op.key], |r| r.get(0))
                    .optional()?
                    .unwrap_or(0);
                let next = now + Duration::minutes(crate::timeblocks::retry_minutes(attempts));
                self.conn().execute(
                    "UPDATE calendar_outbox SET attempts = attempts + 1, next_try = ?3, error = ?4 WHERE id = ?1 AND seq = ?2",
                    params![op.key, op.seq, ts(next), msg],
                )?;
                Ok(())
            };
            // Outlook refused it (a series now, received, saving failed, gone): it waits with its
            // message until the user drops it („Änderung verwerfen“) or changes it again, and
            // stays visible even when the appointment is gone from Outlook.
            let refuse = |op: &EntryOp, msg: &str| -> Result<()> {
                let kept = match &op.uid {
                    Some(u) => self.stored_event(&event_key(&op.source, u, ""))?.map(|e| json(&e.event)).transpose()?,
                    None => None,
                };
                self.conn().execute(
                    "UPDATE calendar_outbox SET state = 'refused', error = ?3, next_try = NULL, snapshot = COALESCE(snapshot, ?4)
                     WHERE id = ?1 AND seq = ?2",
                    params![op.key, op.seq, msg, kept],
                )?;
                Ok(())
            };
            let results = match results {
                Err(e) => {
                    for op in ops {
                        fail(op, &e.to_string())?;
                    }
                    return Ok(());
                }
                Ok(r) => r,
            };
            for op in ops {
                let Some(res) = results.iter().find(|r| r.key == op.key) else {
                    fail(op, tr!("Outlook hat nicht geantwortet", "Outlook did not answer"))?;
                    continue;
                };
                let row = self.outbox_rows("id = ?1", [op.key])?.pop();
                if !res.ok {
                    match res.code.as_deref() {
                        Some("conflict") => {
                            let current = res.current.as_ref().map(|c| c.to_fields(zone)).unwrap_or_default();
                            self.conn().execute(
                                "UPDATE calendar_outbox SET state = 'conflict', conflict = ?3, error = NULL
                                 WHERE id = ?1 AND seq = ?2",
                                params![op.key, op.seq, json(&current)?],
                            )?;
                        }
                        // A restore whose item is not in Deleted Items anymore was moved back by a
                        // try whose answer got lost, or Deleted Items was emptied: the next sync
                        // shows which.
                        Some("not_found") if op.op == "restore" => {
                            self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1 AND seq = ?2", params![op.key, op.seq])?;
                        }
                        _ => refuse(op, res.error.as_deref().unwrap_or(""))?,
                    }
                    continue;
                }
                let entry = res.entry_id.clone().filter(|e| !e.is_empty());
                let uid = res.global_id.clone().filter(|g| !g.is_empty()).or_else(|| entry.clone());
                let same = row.as_ref().is_some_and(|r| r.seq == op.seq);
                match op.op.as_str() {
                    "create" | "restore" => {
                        let Some(row) = row else { continue };
                        if row.op == "delete" {
                            // Deleted while it was written: deleted in Outlook as well.
                            self.conn().execute(
                                "UPDATE calendar_outbox SET entry_id = COALESCE(?2, entry_id), uid = COALESCE(uid, ?3),
                                   state = 'pending', attempts = 0, next_try = NULL WHERE id = ?1",
                                params![row.id, entry, uid],
                            )?;
                            continue;
                        }
                        let ev = if op.op == "create" {
                            draft_event(&row.marker, &row.fields)
                        } else {
                            row.snapshot.clone().map(|mut e| {
                                row.fields.apply(&mut e);
                                e
                            })
                        };
                        if !same {
                            // Changed meanwhile: the rest is written to the appointment that is there now.
                            self.conn().execute(
                                "UPDATE calendar_outbox SET entry_id = COALESCE(?2, entry_id), uid = COALESCE(uid, ?3),
                                   op = 'update', seen = '{}', deleted_id = NULL WHERE id = ?1",
                                params![row.id, entry, uid],
                            )?;
                            if let (Some(mut ev), Some(uid)) = (ev, uid.clone()) {
                                let old = event_key(&row.source, &ev.uid, "");
                                ev.uid = uid;
                                ev.meta.outlook_id = entry.clone();
                                ev.meta.modified = res.modified.clone();
                                self.store_event(&row.source, &ev)?;
                                self.move_marks(&old, &event_key(&row.source, &ev.uid, ""))?;
                            }
                            continue;
                        }
                        self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [row.id])?;
                        if let (Some(mut ev), Some(uid)) = (ev, uid) {
                            let old = event_key(&row.source, &ev.uid, "");
                            ev.uid = uid;
                            ev.meta.outlook_id = entry.clone();
                            ev.meta.modified = res.modified.clone();
                            self.store_event(&row.source, &ev)?;
                            self.move_marks(&old, &event_key(&row.source, &ev.uid, ""))?;
                        }
                    }
                    "update" => {
                        // What Outlook has now is what Arcalo saw last.
                        if let Some(r) = &row {
                            let ruid = r.uid.clone().unwrap_or_default();
                            if let Some(mut e) = self.stored_event(&event_key(&r.source, &ruid, ""))?.map(|e| e.event) {
                                op.fields.to_fields(zone).apply(&mut e);
                                e.meta.outlook_id = entry.clone().or(e.meta.outlook_id);
                                e.meta.modified = res.modified.clone().or(e.meta.modified);
                                self.store_event_fields(&r.source, &e)?;
                            }
                            if same {
                                self.conn().execute("DELETE FROM calendar_outbox WHERE id = ?1", [r.id])?;
                            } else {
                                // Changed again meanwhile: the written values are the seen ones now.
                                let written = op.fields.to_fields(zone);
                                let mut seen = r.seen.clone();
                                seen.merge(&written);
                                self.conn().execute(
                                    "UPDATE calendar_outbox SET seen = ?2, entry_id = COALESCE(?3, entry_id) WHERE id = ?1",
                                    params![r.id, json(&seen.restricted_to(&r.fields))?, entry],
                                )?;
                            }
                        }
                    }
                    "delete" => {
                        if row.is_none()
                            && let (Some(d), Some(u)) = (&res.deleted_id, &op.uid)
                        {
                            let again = self
                                .outbox_rows("source = ?1 AND uid = ?2 AND op = 'delete' AND state = 'pending'", [
                                    &op.source, u,
                                ])?
                                .pop();
                            if let Some(again) = again {
                                // Undone and deleted again while it was deleted: it stays in
                                // Deleted Items, and that delete is done with it.
                                self.conn().execute(
                                    "UPDATE calendar_outbox SET state = 'done', deleted_id = ?2, entry_id = NULL, created_at = ?3
                                     WHERE id = ?1",
                                    params![again.id, d, ts(now)],
                                )?;
                                self.conn().execute(
                                    "DELETE FROM calendar_events WHERE source = ?1 AND uid = ?2",
                                    params![op.source, u],
                                )?;
                            } else {
                                // Undone while it was deleted: moved back from Deleted Items.
                                let snapshot = self.stored_event(&event_key(&op.source, u, ""))?.map(|e| e.event);
                                self.conn().execute(
                                    "INSERT INTO calendar_outbox (marker, source, op, uid, deleted_id, snapshot, created_at)
                                     VALUES (?1, ?2, 'restore', ?3, ?4, ?5, ?6)",
                                    params![new_marker(), op.source, u, d, snapshot.map(|e| json(&e)).transpose()?, ts(now)],
                                )?;
                            }
                        }
                        if let Some(r) = &row {
                            if r.op == "delete" {
                                self.conn().execute(
                                    "UPDATE calendar_outbox SET state = 'done', deleted_id = ?2, entry_id = NULL, created_at = ?3
                                     WHERE id = ?1",
                                    params![r.id, res.deleted_id, ts(now)],
                                )?;
                                if let Some(u) = &r.uid {
                                    self.conn().execute(
                                        "DELETE FROM calendar_events WHERE source = ?1 AND uid = ?2",
                                        params![r.source, u],
                                    )?;
                                }
                            } else if let Some(d) = &res.deleted_id {
                                // Undone while it was deleted: moved back from Deleted Items.
                                self.conn().execute(
                                    "UPDATE calendar_outbox SET op = 'restore', deleted_id = ?2, entry_id = NULL,
                                       attempts = 0, next_try = NULL WHERE id = ?1",
                                    params![r.id, d],
                                )?;
                            }
                        }
                    }
                    _ => {}
                }
            }
            Ok(())
        })
    }

    /// Moves what the user marked on a new appointment (booked, note) to its real key.
    fn move_marks(&self, from: &str, to: &str) -> Result<()> {
        if from == to {
            return Ok(());
        }
        self.conn().execute("UPDATE OR IGNORE calendar_marks SET key = ?2 WHERE key = ?1", params![from, to])?;
        Ok(())
    }

    /// Writes waiting for Outlook (not conflicts, which wait for the user).
    pub fn entry_outbox_len(&self) -> Result<i64> {
        Ok(self.conn().query_row("SELECT COUNT(*) FROM calendar_outbox WHERE state = 'pending'", [], |r| r.get(0))?)
    }

    /// Changes waiting per state (Settings → Kalender shows them).
    pub fn entry_outbox_counts(&self) -> Result<HashMap<String, i64>> {
        let mut st =
            self.conn().prepare("SELECT state, COUNT(*) FROM calendar_outbox WHERE state <> 'done' GROUP BY state")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }
}

/// One round of writes with `writer` (tests; the app runs the writer without holding the database).
pub fn flush(
    db: &Database,
    writer: &dyn EntryWriter,
    now: DateTime<Utc>,
    zone: &Zone,
    force: bool,
    calendars: &[OutlookCalendar],
) -> Result<usize> {
    let ops = db.entry_outbox_due(now, zone, force, calendars)?;
    if ops.is_empty() {
        return Ok(0);
    }
    let results = writer.write(&ops);
    db.entry_outbox_apply(&ops, &results, now, zone)?;
    results.map(|r| r.iter().filter(|x| x.ok).count())
}

/// The ops for the script (`-Ops`, together with focus blocks' writes).
pub fn ops_json(ops: &[EntryOp]) -> Value {
    Value::Array(
        ops.iter()
            .map(|o| {
                serde_json::json!({
                    "id": o.key,
                    "kind": "entry",
                    "op": o.op,
                    "marker": o.marker,
                    "entryId": o.entry_id.clone().unwrap_or_default(),
                    "deletedId": o.deleted_id.clone().unwrap_or_default(),
                    "calendar": {"default": o.calendar.default, "entryId": o.calendar.entry_id, "storeId": o.calendar.store_id},
                    "fields": o.fields,
                    "seen": o.seen,
                    "send": o.send,
                })
            })
            .collect(),
    )
}

/// The script's answer for entry ops: `{"ok":true,"results":[{id, ok, entryId, globalId,
/// modified, deletedId, error, message, current}]}`.
pub fn parse_results(v: &Value) -> Vec<EntryResult> {
    use crate::outlookcom::{int, items, text, truthy};
    items(v, "results")
        .iter()
        .map(|r| {
            let ok = truthy(&r["ok"]);
            let opt = |k: &str| Some(text(r, k)).filter(|x| !x.is_empty());
            let code = (!ok).then(|| text(r, "error"));
            EntryResult {
                key: int(r, "id"),
                ok,
                entry_id: opt("entryId"),
                global_id: opt("globalId"),
                modified: opt("modified"),
                deleted_id: opt("deletedId"),
                error: code.as_deref().map(|c| error_text(c, &text(r, "message"))),
                current: r
                    .get("current")
                    .filter(|c| c.is_object())
                    .and_then(|c| serde_json::from_value(c.clone()).ok()),
                code,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests;
