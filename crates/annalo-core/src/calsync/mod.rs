//! Calendar sync („Kalender“): meetings from Outlook Classic (COM through a bundled PowerShell
//! script, Windows only) and from ICS files and subscriptions, stored locally next to the booked
//! time. Events are local data: nothing here is offered to the AI assistant.
//!
//! * [`ics`] – iCalendar parser with RRULE/EXDATE/RECURRENCE-ID expansion inside a window
//! * [`outlook`] – the PowerShell script, its JSON output and the Restrict date format
//! * [`tz`] – IANA, Windows and `VTIMEZONE` time zones
//!
//! Each sync replaces the events of one source inside its window (`calendar_replace`); what the
//! user decided about an event (booked entry, meeting note, „nicht buchen“) lives in
//! `calendar_marks` under the event's key and survives every sync.

pub mod ics;
pub mod outlook;
pub mod tz;

use chrono::{DateTime, NaiveDate, SecondsFormat, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::model::Page;

/// Source id of the Outlook calendar; ICS sources are `ics:<id>`.
pub const OUTLOOK: &str = "outlook";

/// Colors given to new sources in turn (the first is Outlook's).
pub const PALETTE: [&str; 8] = ["#2563eb", "#0d9488", "#9333ea", "#ea580c", "#db2777", "#65a30d", "#0891b2", "#ca8a04"];

/// Where an ICS source comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum IcsKind {
    /// A subscription URL; the URL (it may carry a secret token) lives in the credential store.
    #[default]
    Url,
    /// A local `.ics` file, read again on every sync.
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IcsSource {
    /// `[a-z0-9]`, stable; the source id is `ics:<id>`.
    pub id: String,
    pub name: String,
    pub kind: IcsKind,
    /// The file of a file source (empty for URL sources: their URL is a secret).
    pub path: String,
    /// `#rrggbb`.
    pub color: String,
    pub enabled: bool,
}

impl Default for IcsSource {
    fn default() -> Self {
        IcsSource {
            id: String::new(),
            name: String::new(),
            kind: IcsKind::Url,
            path: String::new(),
            color: PALETTE[1].into(),
            enabled: true,
        }
    }
}

impl IcsSource {
    pub fn source_id(&self) -> String {
        format!("ics:{}", self.id)
    }
}

/// Settings → Kalender.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CalendarSettings {
    /// Read the default calendar of Outlook Classic (Windows).
    pub outlook: bool,
    pub outlook_color: String,
    /// ICS files and subscriptions.
    pub sources: Vec<IcsSource>,
    /// Minutes between background syncs.
    pub sync_minutes: u32,
    /// Window of a sync: days back and ahead of today.
    pub past_days: u32,
    pub future_days: u32,
    /// Keep subject, place and attendees of private appointments (otherwise „Privater Termin“).
    pub private_details: bool,
    /// Keep the text (body/description) of appointments.
    pub include_body: bool,
    /// Look for a Teams/Zoom/Webex link in the appointment text (only the link is kept).
    pub meeting_links: bool,
}

impl Default for CalendarSettings {
    fn default() -> Self {
        CalendarSettings {
            outlook: false,
            outlook_color: PALETTE[0].into(),
            sources: vec![],
            sync_minutes: 15,
            past_days: 30,
            future_days: 90,
            private_details: false,
            include_body: false,
            meeting_links: true,
        }
    }
}

/// At most this many ICS sources.
pub const MAX_SOURCES: usize = 20;

fn valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
}

impl CalendarSettings {
    /// Clamps the numbers, cleans names and ids, gives every source a color.
    pub fn normalized(mut self) -> CalendarSettings {
        self.sync_minutes = self.sync_minutes.clamp(5, 24 * 60);
        self.past_days = self.past_days.clamp(1, 365);
        self.future_days = self.future_days.clamp(1, 365);
        if !valid_color(&self.outlook_color) {
            self.outlook_color = PALETTE[0].into();
        }
        let mut seen = std::collections::HashSet::new();
        let mut out = vec![];
        for (i, mut s) in std::mem::take(&mut self.sources).into_iter().enumerate() {
            s.id = s.id.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_ascii_lowercase();
            if s.id.is_empty() || !seen.insert(s.id.clone()) {
                continue;
            }
            s.name = s.name.trim().to_owned();
            if s.name.is_empty() {
                s.name = format!("Kalender {}", i + 1);
            }
            s.path = s.path.trim().to_owned();
            if s.kind == IcsKind::Url {
                s.path.clear();
            }
            s.color = s.color.trim().to_ascii_lowercase();
            if !valid_color(&s.color) {
                s.color = PALETTE[(i + 1) % PALETTE.len()].into();
            }
            out.push(s);
        }
        out.truncate(MAX_SOURCES);
        self.sources = out;
        self
    }

    /// The source ids that sync (Outlook only where it exists).
    pub fn active_sources(&self, outlook_available: bool) -> Vec<String> {
        let mut out = vec![];
        if self.outlook && outlook_available {
            out.push(OUTLOOK.to_owned());
        }
        out.extend(self.sources.iter().filter(|s| s.enabled).map(IcsSource::source_id));
        out
    }

    pub fn source(&self, source_id: &str) -> Option<&IcsSource> {
        source_id.strip_prefix("ics:").and_then(|id| self.sources.iter().find(|s| s.id == id))
    }
}

/// A new id for an ICS source that none of `sources` uses.
pub fn new_source_id(sources: &[IcsSource]) -> String {
    let mut n = sources.len() + 1;
    loop {
        let id = format!("s{n}");
        if !sources.iter().any(|s| s.id == id) {
            return id;
        }
        n += 1;
    }
}

/// How an appointment blocks the time (Outlook's BusyStatus, ICS TRANSP and Microsoft's CDO status).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Busy {
    Free,
    Tentative,
    #[default]
    Busy,
    /// Out of office.
    Oof,
    /// Working elsewhere.
    Elsewhere,
}

/// One appointment (one instance of a series) as read from a source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewEvent {
    pub uid: String,
    /// Original start of an instance of a series (RFC 3339 UTC, or `YYYY-MM-DD` all day);
    /// empty for single appointments. With `uid` it names the instance across syncs.
    pub instance: String,
    pub recurring: bool,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    /// All-day: `start`/`end` are local midnights, `end` exclusive.
    pub all_day: bool,
    pub title: String,
    pub location: String,
    pub organizer: String,
    pub attendees: Vec<String>,
    pub body: Option<String>,
    /// Teams/Zoom/Webex/Meet link.
    pub link: Option<String>,
    pub busy: Busy,
    pub private: bool,
    pub categories: Vec<String>,
}

/// Title shown instead of a private appointment's subject.
pub const PRIVATE_TITLE: &str = "Privater Termin";

/// What of an appointment is kept (Settings → Kalender).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Privacy {
    pub private_details: bool,
    pub include_body: bool,
    pub meeting_links: bool,
}

impl From<&CalendarSettings> for Privacy {
    fn from(s: &CalendarSettings) -> Self {
        Privacy { private_details: s.private_details, include_body: s.include_body, meeting_links: s.meeting_links }
    }
}

impl NewEvent {
    /// Applies the privacy settings: private appointments keep only their time, the text is
    /// dropped unless wanted, and so is a meeting link unless wanted.
    pub fn redact(&mut self, p: Privacy) {
        if !p.meeting_links {
            self.link = None;
        }
        if !p.include_body {
            self.body = None;
        }
        if self.private && !p.private_details {
            self.title = PRIVATE_TITLE.into();
            self.location.clear();
            self.organizer.clear();
            self.attendees.clear();
            self.body = None;
            self.link = None;
            self.categories.clear();
        }
        self.title = self.title.trim().to_owned();
        if self.title.is_empty() {
            self.title = "(Ohne Betreff)".into();
        }
    }
}

/// The first online-meeting link in `texts` (Teams, Zoom, Webex, Google Meet, GoToMeeting).
pub fn meeting_link<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    const HOSTS: [&str; 7] = [
        "teams.microsoft.com",
        "teams.live.com",
        "zoom.us",
        "webex.com",
        "meet.google.com",
        "gotomeeting.com",
        "meet.goto.com",
    ];
    for text in texts {
        let mut rest = text;
        while let Some(i) = rest.find("https://") {
            let url: String = rest[i..]
                .chars()
                .take_while(|c| !c.is_whitespace() && !matches!(c, '<' | '>' | '"' | '\'' | ')' | ']' | '|'))
                .collect();
            let url = url.trim_end_matches(['.', ',', ';']).to_owned();
            let host = url[8..].split(['/', '?', '#', ':']).next().unwrap_or("").to_ascii_lowercase();
            if HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
                return Some(url);
            }
            rest = &rest[i + 8..];
        }
    }
    None
}

/// The key of an event instance: source, uid and instance.
pub fn event_key(source: &str, uid: &str, instance: &str) -> String {
    format!("{source}|{uid}|{instance}")
}

/// An appointment as the calendar view shows it: stored event plus what the user decided.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CalendarEvent {
    pub key: String,
    pub source: String,
    #[serde(flatten)]
    pub event: NewEvent,
    /// Marked „nicht buchen“.
    pub skip: bool,
    /// The meeting note of this appointment.
    pub note_page_id: Option<i64>,
    /// The time entry booked from this appointment.
    pub entry_id: Option<i64>,
}

/// Result of the last sync of a source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SyncStatus {
    pub source: String,
    /// Last successful sync.
    pub synced_at: Option<DateTime<Utc>>,
    pub attempted_at: Option<DateTime<Utc>>,
    /// Why the last attempt failed (`None` after a success).
    pub error: Option<String>,
    /// Events stored by the last successful sync.
    pub events: i64,
}

/// WBS last used for an appointment of the same series or with the same subject.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WbsHint {
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    pub leistungsart: Option<String>,
    /// `NP-8801/1020` or `NP-8801`.
    pub reference: String,
}

/// Where a [`WbsHint`] comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HintBasis {
    /// An earlier appointment of the same series was booked.
    Series,
    /// An appointment with the same subject was booked.
    Subject,
    /// An entry is described like the subject.
    Description,
}

/// A [`WbsHint`] with its basis and the booking it was taken from.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WbsMemory {
    pub hint: WbsHint,
    pub basis: HintBasis,
    /// Start of that booking.
    pub booked_at: DateTime<Utc>,
    /// Its description.
    pub description: String,
}

/// The window of a sync around `today`.
pub fn sync_window(today: NaiveDate, s: &CalendarSettings, zone: &tz::Zone) -> (DateTime<Utc>, DateTime<Utc>) {
    let from = today - chrono::Days::new(s.past_days as u64);
    let to = today + chrono::Days::new(s.future_days as u64 + 1);
    (zone.to_utc(from.and_hms_opt(0, 0, 0).unwrap()), zone.to_utc(to.and_hms_opt(0, 0, 0).unwrap()))
}

const EVENT_COLS: &str = "e.source, e.uid, e.instance, e.recurring, e.start_at, e.end_at, e.all_day, e.title, e.location, \
     e.organizer, e.attendees, e.body, e.link, e.busy, e.private, e.categories, \
     COALESCE(m.skip, 0), p.id, t.id";

fn busy_str(b: Busy) -> &'static str {
    match b {
        Busy::Free => "free",
        Busy::Tentative => "tentative",
        Busy::Busy => "busy",
        Busy::Oof => "oof",
        Busy::Elsewhere => "elsewhere",
    }
}

fn busy_of(s: &str) -> Busy {
    match s {
        "free" => Busy::Free,
        "tentative" => Busy::Tentative,
        "oof" => Busy::Oof,
        "elsewhere" => Busy::Elsewhere,
        _ => Busy::Busy,
    }
}

fn map_event(r: &rusqlite::Row) -> rusqlite::Result<CalendarEvent> {
    let list = |s: String| serde_json::from_str::<Vec<String>>(&s).unwrap_or_default();
    let source: String = r.get(0)?;
    let uid: String = r.get(1)?;
    let instance: String = r.get(2)?;
    Ok(CalendarEvent {
        key: event_key(&source, &uid, &instance),
        event: NewEvent {
            uid,
            instance,
            recurring: r.get(3)?,
            start: parse_ts(&r.get::<_, String>(4)?)?,
            end: parse_ts(&r.get::<_, String>(5)?)?,
            all_day: r.get(6)?,
            title: r.get(7)?,
            location: r.get(8)?,
            organizer: r.get(9)?,
            attendees: list(r.get(10)?),
            body: r.get(11)?,
            link: r.get(12)?,
            busy: busy_of(&r.get::<_, String>(13)?),
            private: r.get(14)?,
            categories: list(r.get(15)?),
        },
        source,
        skip: r.get(16)?,
        note_page_id: r.get(17)?,
        entry_id: r.get(18)?,
    })
}

impl Database {
    /// Replaces the events of `source` that overlap `from..to` with `events` (one sync).
    /// Events outside the window stay (history); marks are never touched.
    pub fn calendar_replace(
        &self,
        source: &str,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        events: &[NewEvent],
    ) -> Result<usize> {
        self.atomic(|| {
            let c = self.conn();
            c.execute(
                "DELETE FROM calendar_events WHERE source = ?1 AND start_at < ?3 AND end_at > ?2",
                params![source, ts(from), ts(to)],
            )?;
            let mut st = c.prepare_cached(
                "INSERT OR REPLACE INTO calendar_events
                   (source, uid, instance, recurring, start_at, end_at, all_day, title, location, organizer,
                    attendees, body, link, busy, private, categories)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            )?;
            let mut n = 0;
            for e in events {
                st.execute(params![
                    source,
                    e.uid,
                    e.instance,
                    e.recurring,
                    ts(e.start),
                    ts(e.end.max(e.start)),
                    e.all_day,
                    e.title,
                    e.location,
                    e.organizer,
                    serde_json::to_string(&e.attendees)?,
                    e.body,
                    e.link,
                    busy_str(e.busy),
                    e.private,
                    serde_json::to_string(&e.categories)?,
                ])?;
                n += 1;
            }
            Ok(n)
        })
    }

    /// Events of the given sources overlapping `from..to`, by start.
    pub fn calendar_events(
        &self,
        from: DateTime<Utc>,
        to: DateTime<Utc>,
        sources: &[String],
    ) -> Result<Vec<CalendarEvent>> {
        let mut st = self.conn().prepare_cached(&format!(
            "SELECT {EVENT_COLS} FROM calendar_events e
             LEFT JOIN calendar_marks m ON m.key = e.source || '|' || e.uid || '|' || e.instance
             LEFT JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL
             LEFT JOIN time_entries t ON t.id = m.entry_id
             WHERE e.start_at < ?2 AND e.end_at > ?1
             ORDER BY e.start_at, e.all_day DESC, e.title"
        ))?;
        let rows = st.query_map(params![ts(from), ts(to)], map_event)?;
        let mut out = vec![];
        for r in rows {
            let e = r?;
            if sources.contains(&e.source) {
                out.push(e);
            }
        }
        Ok(out)
    }

    /// One event by its key.
    pub fn calendar_event(&self, key: &str) -> Result<CalendarEvent> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT {EVENT_COLS} FROM calendar_events e
                     LEFT JOIN calendar_marks m ON m.key = e.source || '|' || e.uid || '|' || e.instance
                     LEFT JOIN pages p ON p.id = m.note_page_id AND p.deleted_at IS NULL
                     LEFT JOIN time_entries t ON t.id = m.entry_id
                     WHERE e.source || '|' || e.uid || '|' || e.instance = ?1"
                ),
                [key],
                map_event,
            )
            .optional()?
            .ok_or_else(|| {
                Error::State("Der Termin ist nicht mehr im Kalender (inzwischen geändert oder gelöscht)".into())
            })
    }

    /// Removes the events and the status of a source (the source was removed).
    pub fn calendar_remove_source(&self, source: &str) -> Result<()> {
        self.atomic(|| {
            self.conn().execute("DELETE FROM calendar_events WHERE source = ?1", [source])?;
            self.conn().execute("DELETE FROM calendar_sync WHERE source = ?1", [source])?;
            Ok(())
        })
    }

    /// Records a sync attempt: success with the number of events, or the error.
    pub fn calendar_record_sync(
        &self,
        source: &str,
        at: DateTime<Utc>,
        outcome: std::result::Result<usize, &str>,
    ) -> Result<()> {
        match outcome {
            Ok(n) => self.conn().execute(
                "INSERT INTO calendar_sync (source, synced_at, attempted_at, error, events) VALUES (?1, ?2, ?2, NULL, ?3)
                 ON CONFLICT(source) DO UPDATE SET synced_at = ?2, attempted_at = ?2, error = NULL, events = ?3",
                params![source, ts(at), n as i64],
            )?,
            Err(e) => self.conn().execute(
                "INSERT INTO calendar_sync (source, attempted_at, error) VALUES (?1, ?2, ?3)
                 ON CONFLICT(source) DO UPDATE SET attempted_at = ?2, error = ?3",
                params![source, ts(at), e],
            )?,
        };
        Ok(())
    }

    pub fn calendar_sync_status(&self) -> Result<Vec<SyncStatus>> {
        let mut st = self.conn().prepare_cached(
            "SELECT source, synced_at, attempted_at, error, events FROM calendar_sync ORDER BY source",
        )?;
        let opt_ts = |s: Option<String>| s.and_then(|s| parse_ts(&s).ok());
        let rows = st.query_map([], |r| {
            Ok(SyncStatus {
                source: r.get(0)?,
                synced_at: opt_ts(r.get(1)?),
                attempted_at: opt_ts(r.get(2)?),
                error: r.get(3)?,
                events: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn calendar_mark_row(&self, key: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO calendar_marks (key, updated_at) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET updated_at = ?2",
            params![key, ts(Utc::now())],
        )?;
        Ok(())
    }

    /// Marks an appointment „nicht buchen“ (or takes the mark back).
    pub fn calendar_set_skip(&self, key: &str, skip: bool) -> Result<()> {
        self.calendar_event(key)?;
        self.calendar_mark_row(key)?;
        self.conn().execute("UPDATE calendar_marks SET skip = ?2 WHERE key = ?1", params![key, skip])?;
        Ok(())
    }

    /// Links the time entry booked from an appointment; remembers its subject and series for
    /// the next booking suggestion.
    pub fn calendar_link_entry(&self, key: &str, entry_id: i64) -> Result<()> {
        let ev = self.calendar_event(key)?;
        self.time_entry(entry_id)?;
        self.calendar_mark_row(key)?;
        let series = if ev.event.recurring { ev.event.uid.clone() } else { String::new() };
        self.conn().execute(
            "UPDATE calendar_marks SET entry_id = ?2, skip = 0, title = ?3, series = ?4 WHERE key = ?1",
            params![key, entry_id, ev.event.title.to_lowercase(), series],
        )?;
        Ok(())
    }

    /// The WBS for booking `key`: the one last booked from the same series, else from an
    /// appointment with the same subject, else of the newest entry described like the subject.
    pub fn calendar_wbs_hint(&self, key: &str) -> Result<Option<WbsHint>> {
        Ok(self.calendar_wbs_memory(&self.calendar_event(key)?)?.map(|m| m.hint))
    }

    /// [`Database::calendar_wbs_hint`] of an event, with where it comes from and the booking it
    /// was taken from (the week proposal explains its choice with them).
    pub fn calendar_wbs_memory(&self, ev: &CalendarEvent) -> Result<Option<WbsMemory>> {
        let title = ev.event.title.to_lowercase();
        let c = self.conn();
        type Row = (i64, Option<String>, Option<String>, String, String);
        let pick = |sql: &str, arg: &str| -> Result<Option<Row>> {
            Ok(c.query_row(sql, [arg], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).optional()?)
        };
        let from_marks =
            "SELECT t.netzplan_id, t.vorgang_nr, t.leistungsart, t.start_time, t.description FROM calendar_marks m
                          JOIN time_entries t ON t.id = m.entry_id";
        let mut hit = None;
        if ev.event.recurring {
            hit = pick(&format!("{from_marks} WHERE m.series = ?1 ORDER BY m.updated_at DESC LIMIT 1"), &ev.event.uid)?
                .map(|r| (r, HintBasis::Series));
        }
        if hit.is_none() && !title.is_empty() && ev.event.title != PRIVATE_TITLE {
            hit = pick(&format!("{from_marks} WHERE m.title = ?1 ORDER BY m.updated_at DESC LIMIT 1"), &title)?
                .map(|r| (r, HintBasis::Subject));
            if hit.is_none() {
                hit = pick(
                    "SELECT netzplan_id, vorgang_nr, leistungsart, start_time, description FROM time_entries
                     WHERE description = ?1 COLLATE NOCASE AND status_flag <> 'running' ORDER BY start_time DESC LIMIT 1",
                    &ev.event.title,
                )?
                .map(|r| (r, HintBasis::Description));
            }
        }
        let Some(((netzplan_id, vorgang_nr, leistungsart, start, description), basis)) = hit else { return Ok(None) };
        let np = self.netzplan_by_id(netzplan_id)?;
        let reference = match &vorgang_nr {
            Some(v) if !v.is_empty() => format!("{}/{v}", np.netzplan_nr),
            _ => np.netzplan_nr.clone(),
        };
        Ok(Some(WbsMemory {
            hint: WbsHint { netzplan_id, vorgang_nr, leistungsart, reference },
            basis,
            booked_at: parse_ts(&start)?,
            description,
        }))
    }

    /// The meeting note of an appointment: the linked page, or a new page below
    /// „Besprechungen“ from the template „Besprechung“ (in „Vorlagen“) or a built-in one.
    /// Returns the page and whether it was created now.
    pub fn calendar_meeting_note(&self, key: &str, zone: &tz::Zone) -> Result<(Page, bool)> {
        let ev = self.calendar_event(key)?;
        if let Some(id) = ev.note_page_id {
            return Ok((self.page(id)?, false));
        }
        let hint = self.calendar_wbs_hint(key)?;
        let e = &ev.event;
        let start = zone.to_wall(e.start);
        let end = zone.to_wall(e.end);
        let date = start.date();
        let time = if e.all_day {
            "ganztägig".to_owned()
        } else {
            format!("{}–{}", start.format("%H:%M"), end.format("%H:%M"))
        };
        let attendees = e.attendees.join(", ");
        let yaml = |v: &str| format!("\"{}\"", v.replace('\\', "\\\\").replace('"', "\\\""));
        let mut front = vec![format!("datum: {}", date.format("%Y-%m-%d")), format!("uhrzeit: {}", yaml(&time))];
        if !e.location.is_empty() {
            front.push(format!("ort: {}", yaml(&e.location)));
        }
        if !e.organizer.is_empty() {
            front.push(format!("organisator: {}", yaml(&e.organizer)));
        }
        if !attendees.is_empty() {
            front.push(format!("teilnehmer: {}", yaml(&attendees)));
        }
        if let Some(h) = &hint {
            front.push(format!("vorgang: {}", h.reference));
        }
        let vars = crate::templates::TemplateVars { date, time: start.time(), title: e.title.clone() };
        let template = self.list_templates()?.into_iter().find(|p| p.title.eq_ignore_ascii_case("Besprechung"));
        let body = match template {
            Some(t) => {
                let mut b = self
                    .render_template(t.id, &vars)?
                    .replace("{{teilnehmer}}", &attendees)
                    .replace("{{ort}}", &e.location)
                    .replace("{{uhrzeit}}", &time);
                // An empty attendee list in the template is filled in.
                if !e.attendees.is_empty() {
                    let list: String = e.attendees.iter().map(|a| format!("- {a}\n")).collect();
                    for empty in ["## Teilnehmer\n\n- \n", "## Teilnehmer\n- \n"] {
                        if let Some(at) = b.find(empty) {
                            let head = &empty[..empty.len() - 3];
                            b.replace_range(at..at + empty.len(), &format!("{head}{list}"));
                            break;
                        }
                    }
                }
                if let Some(link) = &e.link {
                    b = format!("[Besprechung beitreten]({link})\n\n{b}");
                }
                b
            }
            None => {
                let mut b = format!("# {}\n\n", e.title);
                b.push_str(&format!("{} · {time}", date.format("%d.%m.%Y")));
                if !e.location.is_empty() {
                    b.push_str(&format!(" · {}", e.location));
                }
                b.push_str("\n\n");
                if let Some(link) = &e.link {
                    b.push_str(&format!("[Besprechung beitreten]({link})\n\n"));
                }
                if !e.attendees.is_empty() {
                    b.push_str("## Teilnehmer\n\n");
                    for a in &e.attendees {
                        b.push_str(&format!("- {a}\n"));
                    }
                    b.push('\n');
                }
                b.push_str("## Agenda\n\n- \n\n## Notizen\n\n\n\n## Entscheidungen\n\n- \n\n## Aufgaben\n\n- [ ] \n");
                b
            }
        };
        let content = format!("---\n{}\n---\n{body}", front.join("\n"));
        self.atomic(|| {
            let parent = match self.conn().query_row(
                "SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
                [MEETINGS_TITLE],
                |r| r.get::<_, i64>(0),
            ).optional()? {
                Some(id) => id,
                None => self.create_page(None, MEETINGS_TITLE, Some("users"))?.id,
            };
            let base = crate::notes::clean_title(&format!("{} {}", e.title, date.format("%d.%m.%Y")));
            let mut title = base.clone();
            let mut n = 2;
            while self.page_by_title(&title)?.is_some() {
                title = format!("{base} {n}");
                n += 1;
            }
            let page = self.create_page(Some(parent), &title, Some("users"))?;
            self.save_page_content(page.id, &content)?;
            self.calendar_mark_row(key)?;
            self.conn().execute("UPDATE calendar_marks SET note_page_id = ?2 WHERE key = ?1", params![key, page.id])?;
            Ok((self.page(page.id)?, true))
        })
    }
}

/// Parent page of the meeting notes.
pub const MEETINGS_TITLE: &str = "Besprechungen";

/// RFC 3339 in UTC with seconds (instance ids).
pub(crate) fn instant_id(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};
    use chrono::TimeZone;

    fn at(d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, d, h, 0, 0).unwrap()
    }

    fn ev(uid: &str, instance: &str, d: u32, h: u32, title: &str) -> NewEvent {
        NewEvent {
            uid: uid.into(),
            instance: instance.into(),
            recurring: !instance.is_empty(),
            start: at(d, h),
            end: at(d, h + 1),
            all_day: false,
            title: title.into(),
            location: "Raum 1".into(),
            organizer: "Anna Müller".into(),
            attendees: vec!["Jörg".into(), "Zoë".into()],
            body: None,
            link: None,
            busy: Busy::Busy,
            private: false,
            categories: vec![],
        }
    }

    #[test]
    fn a_sync_replaces_the_window_and_keeps_marks() {
        let db = Database::open_in_memory().unwrap();
        let src = [OUTLOOK.to_owned(), "ics:s1".to_owned()];
        let first = vec![ev("a", "", 10, 8, "Alt"), ev("b", "", 20, 8, "Jour fixe"), ev("c", "", 1, 8, "Vorher")];
        db.calendar_replace(OUTLOOK, at(5, 0), at(28, 0), &first).unwrap();
        db.calendar_replace("ics:s1", at(5, 0), at(28, 0), &[ev("x", "", 20, 9, "Andere Quelle")]).unwrap();
        let key_b = event_key(OUTLOOK, "b", "");
        db.calendar_set_skip(&key_b, true).unwrap();

        // Second sync: "a" was deleted in Outlook, "b" moved, "d" is new. "c" lies outside the window and stays.
        let second = vec![ev("b", "", 21, 10, "Jour fixe"), ev("d", "", 22, 8, "Neu")];
        assert_eq!(db.calendar_replace(OUTLOOK, at(5, 0), at(28, 0), &second).unwrap(), 2);
        let all = db.calendar_events(at(1, 0), at(30, 0), &src).unwrap();
        let titles: Vec<_> = all.iter().map(|e| e.event.title.as_str()).collect();
        assert_eq!(titles, ["Vorher", "Andere Quelle", "Jour fixe", "Neu"]);
        let b = all.iter().find(|e| e.key == key_b).unwrap();
        assert!(b.skip, "the mark survives the sync");
        assert_eq!(b.event.start, at(21, 10));
        assert_eq!(b.event.attendees, ["Jörg", "Zoë"]);
        // Only listed sources are returned; removing a source removes its events.
        assert_eq!(db.calendar_events(at(1, 0), at(30, 0), &src[..1]).unwrap().len(), 3);
        db.calendar_remove_source("ics:s1").unwrap();
        assert_eq!(db.calendar_events(at(1, 0), at(30, 0), &src).unwrap().len(), 3);
        assert!(db.calendar_set_skip("outlook|nope|", true).is_err());
    }

    #[test]
    fn sync_status_records_success_and_failure() {
        let db = Database::open_in_memory().unwrap();
        db.calendar_record_sync(OUTLOOK, at(1, 8), Ok(12)).unwrap();
        db.calendar_record_sync(OUTLOOK, at(1, 9), Err("Outlook antwortet nicht")).unwrap();
        let s = &db.calendar_sync_status().unwrap()[0];
        assert_eq!((s.synced_at, s.attempted_at, s.events), (Some(at(1, 8)), Some(at(1, 9)), 12));
        assert_eq!(s.error.as_deref(), Some("Outlook antwortet nicht"));
        db.calendar_record_sync(OUTLOOK, at(1, 10), Ok(3)).unwrap();
        let s = &db.calendar_sync_status().unwrap()[0];
        assert_eq!((s.error.as_deref(), s.events), (None, 3));
    }

    #[test]
    fn bookings_link_and_suggest_the_wbs() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 40.0).unwrap();
        let book = |desc: &str, vorgang: Option<&str>| {
            db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: vorgang.map(str::to_owned),
                leistungsart: Some("PM".into()),
                start_time: at(1, 8),
                duration_minutes: 60,
                description: desc.into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap()
        };
        let series = vec![
            ev("jf", "2026-09-14T08:00:00Z", 14, 8, "Jour fixe"),
            ev("jf", "2026-09-21T08:00:00Z", 21, 8, "Jour fixe"),
        ];
        let other = vec![ev("x", "", 22, 8, "Weekly Sync"), ev("y", "", 23, 8, "Lenkungskreis")];
        db.calendar_replace(OUTLOOK, at(1, 0), at(30, 0), &[series.clone(), other].concat()).unwrap();
        let k1 = event_key(OUTLOOK, "jf", "2026-09-14T08:00:00Z");
        let k2 = event_key(OUTLOOK, "jf", "2026-09-21T08:00:00Z");
        assert_eq!(db.calendar_wbs_hint(&k1).unwrap(), None);

        let entry = book("Jour fixe Projekt", Some("1020"));
        db.calendar_link_entry(&k1, entry.id).unwrap();
        let hint = db.calendar_wbs_hint(&k2).unwrap().unwrap();
        assert_eq!(
            (hint.netzplan_id, hint.vorgang_nr.as_deref(), hint.reference.as_str()),
            (np.id, Some("1020"), "NP-8801/1020")
        );
        let e = db.calendar_event(&k1).unwrap();
        assert_eq!(e.entry_id, Some(entry.id));

        // Same subject in another appointment, or a manual entry described like it.
        book("Lenkungskreis", None);
        let h = db.calendar_wbs_hint(&event_key(OUTLOOK, "y", "")).unwrap().unwrap();
        assert_eq!((h.vorgang_nr, h.reference.as_str()), (None, "NP-8801"));
        assert_eq!(db.calendar_wbs_hint(&event_key(OUTLOOK, "x", "")).unwrap(), None);

        // A deleted entry no longer counts as booked.
        db.delete_time_entry(entry.id).unwrap();
        assert_eq!(db.calendar_event(&k1).unwrap().entry_id, None);
    }

    #[test]
    fn meeting_notes_are_created_once_from_the_event() {
        let db = Database::open_in_memory().unwrap();
        db.calendar_replace(OUTLOOK, at(1, 0), at(30, 0), &[ev("m", "", 24, 8, "Abstimmung Änderungen")]).unwrap();
        let key = event_key(OUTLOOK, "m", "");
        let zone = tz::Zone::named("Europe/Berlin").unwrap();
        let (page, created) = db.calendar_meeting_note(&key, &zone).unwrap();
        assert!(created);
        assert_eq!(page.title, "Abstimmung Änderungen 24.09.2026");
        let content = db.page_doc(page.id).unwrap().content;
        assert!(content.starts_with("---\ndatum: 2026-09-24\nuhrzeit: \"10:00–11:00\"\nort: \"Raum 1\""), "{content}");
        assert!(
            content.contains("teilnehmer: \"Jörg, Zoë\"") && content.contains("## Teilnehmer\n\n- Jörg\n- Zoë"),
            "{content}"
        );
        let parent = db.page(page.parent_id.unwrap()).unwrap();
        assert_eq!(parent.title, MEETINGS_TITLE);
        let (again, created) = db.calendar_meeting_note(&key, &zone).unwrap();
        assert_eq!((again.id, created), (page.id, false));
        // A trashed note is replaced by a new one.
        db.trash_page(page.id).unwrap();
        let (fresh, created) = db.calendar_meeting_note(&key, &zone).unwrap();
        assert!(created && fresh.id != page.id);
        assert_eq!(db.calendar_event(&key).unwrap().note_page_id, Some(fresh.id));

        // The user's template „Besprechung“ is used; its empty attendee list is filled in.
        let root = db.templates_root().unwrap();
        let t = db.create_page(Some(root.id), "Besprechung", None).unwrap();
        db.save_page_content(
            t.id,
            "{{wochentag}}, {{datum}} · {{zeit}} Uhr\n\n## Teilnehmer\n\n- \n\n## Agenda\n\n1. \n",
        )
        .unwrap();
        let mut other = ev("t", "", 25, 12, "Review");
        other.link = Some("https://teams.microsoft.com/l/meetup-join/x".into());
        db.calendar_replace("ics:s1", at(25, 0), at(26, 0), &[other]).unwrap();
        let (page, _) = db.calendar_meeting_note(&event_key("ics:s1", "t", ""), &zone).unwrap();
        let content = db.page_doc(page.id).unwrap().content;
        assert!(
            content.contains("[Besprechung beitreten](https://teams.microsoft.com/l/meetup-join/x)\n\nFreitag, 25.09.2026 · 14:00 Uhr"),
            "{content}"
        );
        assert!(content.contains("## Teilnehmer\n\n- Jörg\n- Zoë\n\n## Agenda"), "{content}");
    }

    #[test]
    fn private_events_keep_only_their_time() {
        let mut e = ev("p", "", 1, 8, "Arzt");
        e.private = true;
        e.body = Some("Praxis Dr. X".into());
        e.link = Some("https://teams.microsoft.com/l/meetup-join/1".into());
        let mut kept = e.clone();
        e.redact(Privacy { private_details: false, include_body: true, meeting_links: true });
        assert_eq!(
            (e.title.as_str(), e.location.as_str(), e.body.as_deref(), e.attendees.len()),
            (PRIVATE_TITLE, "", None, 0)
        );
        kept.redact(Privacy { private_details: true, include_body: false, meeting_links: true });
        assert_eq!((kept.title.as_str(), kept.body.as_deref()), ("Arzt", None));
        assert!(kept.link.is_some());
    }

    #[test]
    fn the_assistant_has_no_tool_that_reads_the_calendar() {
        // Appointments are local data; a later feature has to add AI access deliberately.
        for d in crate::ai::tools::definitions() {
            let text = d.to_string().to_lowercase();
            assert!(!text.contains("calendar_events") && !text.contains("termin"), "{}", d["function"]["name"]);
        }
    }

    #[test]
    fn meeting_links_are_found_in_text() {
        let body = "Hallo,\n________________\nMicrosoft Teams-Besprechung\nJetzt an der Besprechung teilnehmen <https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d>\n";
        assert_eq!(
            meeting_link([body]).as_deref(),
            Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%22Tid%22%7d")
        );
        assert_eq!(
            meeting_link(["Raum 3", "https://firma.zoom.us/j/123?pwd=x."]).as_deref(),
            Some("https://firma.zoom.us/j/123?pwd=x")
        );
        assert_eq!(meeting_link(["https://example.com/teams.microsoft.com/x"]), None);
        assert_eq!(meeting_link(["kein Link"]), None);
    }

    #[test]
    fn settings_are_normalized() {
        let s = CalendarSettings {
            sync_minutes: 1,
            future_days: 9999,
            outlook_color: "rot".into(),
            sources: vec![
                IcsSource {
                    id: "S-1".into(),
                    name: "  Team ".into(),
                    path: "x".into(),
                    color: "#ABCDEF".into(),
                    ..Default::default()
                },
                IcsSource { id: "s1".into(), ..Default::default() },
                IcsSource {
                    id: "f".into(),
                    kind: IcsKind::File,
                    path: " /tmp/a.ics ".into(),
                    color: "".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
        .normalized();
        assert_eq!((s.sync_minutes, s.future_days, s.outlook_color.as_str()), (5, 365, PALETTE[0]));
        assert_eq!(s.sources.len(), 2, "duplicate id dropped");
        assert_eq!(
            (s.sources[0].id.as_str(), s.sources[0].name.as_str(), s.sources[0].path.as_str()),
            ("s1", "Team", "")
        );
        assert_eq!(s.sources[0].color, "#abcdef");
        assert_eq!((s.sources[1].path.as_str(), s.sources[1].color.starts_with('#')), ("/tmp/a.ics", true));
        assert_eq!(s.active_sources(false), ["ics:s1", "ics:f"]);
        assert_eq!(new_source_id(&s.sources), "s3");
    }
}
