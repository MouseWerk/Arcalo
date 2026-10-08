//! The Android companion app's view of the workspace: what „Heute“ shows, bookings that travel
//! to the desktop as chips in the daily note, the references booked most recently, and the
//! reference data (Projekte, Netzpläne, Vorgänge, Leistungsarten, appointments) taken over from
//! the desktop's database copy in the Git repository.
//!
//! The Git sync carries notes, not the database: a booking made on the phone is written into
//! that day's daily note as a `/zeit` chip ([`crate::chips`]), the same Markdown the desktop's
//! editor writes for a `/zeit` line. The desktop shows it as a chip from another device and
//! books it with „Erneut buchen“.

use std::path::Path;

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::{OpenFlags, OptionalExtension, params};
use serde::Serialize;

use crate::calsync::CalendarEvent;
use crate::db::Database;
use crate::error::{Error, Result};
use crate::model::{Page, TimeEntry};
use crate::settings::Settings;
use crate::tasks::{Task, TaskFilter};
use crate::timer::PauseState;
use crate::tracking::{self, LogOutcome, SlashContext, Thresholds};
use crate::{tr, trf};

/// The running timer as „Heute“ and „Zeit“ show it.
#[derive(Debug, Clone, Serialize)]
pub struct RunningTimer {
    pub entry: TimeEntry,
    /// `NP-8801/1020`.
    pub reference: String,
    /// Worked minutes so far (pauses left out).
    pub worked_minutes: i64,
    #[serde(flatten)]
    pub pause: PauseState,
}

/// What the start screen of the companion app shows.
#[derive(Debug, Clone, Serialize)]
pub struct Today {
    pub date: NaiveDate,
    /// Booked today, a running timer included.
    pub booked_minutes: i64,
    /// The day's target (Settings → Zeiterfassung, holidays and absences included).
    pub target_minutes: i64,
    /// Booked this week (Monday to today).
    pub week_minutes: i64,
    pub timer: Option<RunningTimer>,
    /// Open tasks due today or earlier, the oldest first.
    pub tasks: Vec<Task>,
    /// Today's appointments (from the desktop's calendars, see [`import_reference`]).
    pub events: Vec<CalendarEvent>,
    /// When the appointments were last taken over from the desktop.
    pub events_from: Option<String>,
    pub time_tracking: bool,
}

/// Meta key: when the reference data was last taken over (RFC 3339).
pub const REFERENCE_AT: &str = "companion.reference_at";

/// The start screen's data for the local day of `now` in `tz`.
pub fn today<Tz: TimeZone>(db: &Database, settings: &Settings, now: DateTime<Utc>, tz: &Tz) -> Result<Today> {
    let date = now.with_timezone(tz).date_naive();
    let monday = date - Duration::days(i64::from(date.weekday().num_days_from_monday()));
    let booked = crate::worktime::booked_by_day(db, tz, monday, date, now)?;
    let booked_minutes = booked.get(&date).copied().unwrap_or(0);
    let week_minutes = booked.values().sum();
    let base = crate::worktime::weekday_minutes(settings, date);
    let target_minutes = crate::worktime::gap_target(db, date, base)?;
    let timer = running(db, now)?;
    let mut tasks =
        db.list_tasks(&TaskFilter { due_before: Some(date.format("%Y-%m-%d").to_string()), ..Default::default() })?;
    tasks.retain(|t| t.due.is_some());
    tasks.sort_by(|a, b| a.due.cmp(&b.due).then(b.priority.cmp(&a.priority)));
    let start = crate::feed::day_start(date, tz);
    let end = crate::feed::day_start(date + Duration::days(1), tz);
    let sources: Vec<String> = {
        let mut st = db.conn().prepare("SELECT DISTINCT source FROM calendar_events ORDER BY source")?;
        st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
    };
    let events = if sources.is_empty() { vec![] } else { db.calendar_events(start, end, &sources)? };
    Ok(Today {
        date,
        booked_minutes,
        target_minutes,
        week_minutes,
        timer,
        tasks,
        events,
        events_from: db.meta_get(REFERENCE_AT)?.filter(|s| !s.is_empty()),
        time_tracking: settings.time_tracking(),
    })
}

/// The daily note of `date`, created with `create`. A note of that day pulled from the desktop
/// (a page titled like a daily note, without the daily mark: the repository carries the text,
/// not the mark) becomes the daily note here instead of a second one beside it.
pub fn daily(db: &Database, date: NaiveDate, create: bool) -> Result<Option<Page>> {
    let key = date.format("%Y-%m-%d").to_string();
    let marked: Option<i64> = db
        .conn()
        .query_row("SELECT id FROM pages WHERE daily_date = ?1 AND deleted_at IS NULL", [&key], |r| r.get(0))
        .optional()?;
    if let Some(id) = marked {
        return Ok(Some(db.page(id)?));
    }
    let settings = db.load_settings().unwrap_or_default();
    for title in [settings.notes.daily_title.title(date), key.clone()] {
        if let Some(p) = db.page_by_title(&title)?
            && p.daily_date.is_none()
            && p.kind.is_none()
        {
            db.conn().execute("UPDATE pages SET daily_date = ?2 WHERE id = ?1", params![p.id, key])?;
            return Ok(Some(db.page(p.id)?));
        }
    }
    if create { Ok(Some(db.daily_note(date)?)) } else { Ok(None) }
}

fn daily_page(db: &Database, date: NaiveDate) -> Result<Page> {
    daily(db, date, true)?.ok_or_else(|| Error::State("daily note".into()))
}

/// The running timer with its reference and worked minutes.
pub fn running(db: &Database, now: DateTime<Utc>) -> Result<Option<RunningTimer>> {
    let Some(entry) = db.running_timer()? else { return Ok(None) };
    let nr = db.netzplan_by_id(entry.netzplan_id)?.netzplan_nr;
    Ok(Some(RunningTimer {
        reference: crate::desktop::timer_label(&nr, entry.vorgang_nr.as_deref()),
        worked_minutes: db.timer_worked_minutes(&entry, now)?,
        pause: db.pause_state(entry.id)?,
        entry,
    }))
}

/// Books a `/zeit` line on the phone: on the WBS like the desktop (`/zeit NP-8801/1020
/// 1,5h #DEV Text`), from the daily note of the booking's day, which gets the booking's chip.
pub fn book<Tz: TimeZone>(
    db: &Database,
    line: &str,
    now: DateTime<Utc>,
    tz: &Tz,
    thresholds: &Thresholds,
) -> Result<LogOutcome>
where
    Tz::Offset: std::fmt::Display,
{
    db.atomic(|| {
        let today = daily_page(db, now.with_timezone(tz).date_naive())?;
        let ctx = SlashContext { default_ref: None, page_id: Some(today.id) };
        let out = tracking::log_slash_command_in(db, line, now, tz, thresholds, ctx)?;
        add_chips(db, std::slice::from_ref(&out.entry), tz)?;
        Ok(out)
    })
}

/// The chip of a booking, as the desktop's editor writes it.
pub fn chip_markdown<Tz: TimeZone>(db: &Database, e: &TimeEntry, tz: &Tz) -> Result<String> {
    let v = db.chip_values(e, tz)?;
    let attrs = [
        ("id", e.id.to_string()),
        ("hours", crate::chips::chip_hours(v.minutes, false)),
        ("target", v.target),
        ("la", v.leistungsart.unwrap_or_default()),
        ("date", v.date.format("%Y-%m-%d").to_string()),
    ]
    .map(|(k, v)| (k.to_owned(), v));
    Ok(crate::chips::render(&attrs, &v.text))
}

/// Writes the chips of `entries` (bookings made on the phone: a `/zeit` line, a stopped timer)
/// into the daily note of each booking's day, below „Notizen“ when it has that section, and
/// links the bookings to that note.
pub fn add_chips<Tz: TimeZone>(db: &Database, entries: &[TimeEntry], tz: &Tz) -> Result<()> {
    for e in entries {
        let day = daily_page(db, e.start_time.with_timezone(tz).date_naive())?;
        db.conn().execute("UPDATE time_entries SET page_id = ?2 WHERE id = ?1", params![e.id, day.id])?;
        let chip = chip_markdown(db, e, tz)?;
        let before = db.page_doc(day.id)?.content;
        let next = crate::capture::insert_in_notes(&before, &chip)
            .unwrap_or_else(|| crate::capture::append_markdown(&before, &chip));
        db.save_page_content(day.id, &next)?;
    }
    Ok(())
}

/// A reference booked recently (the „Zeit“ screen offers them first).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RecentTarget {
    pub netzplan_nr: String,
    pub vorgang_nr: Option<String>,
    pub leistungsart: Option<String>,
    /// `NP-8801/1020`.
    pub reference: String,
    /// The Vorgang's (else the Netzplan's) description.
    pub label: String,
    /// The text of the last booking on it.
    pub last_text: String,
}

/// The references (Netzplan, Vorgang, Leistungsart) of the last bookings, newest first, each once.
pub fn recent_targets(db: &Database, limit: usize) -> Result<Vec<RecentTarget>> {
    let mut st = db.conn().prepare(
        "SELECT n.netzplan_nr, e.vorgang_nr, e.leistungsart,
                COALESCE(NULLIF(v.description, ''), n.description), e.description, MAX(e.start_time) AS at
         FROM time_entries e
         JOIN netzplaene n ON n.id = e.netzplan_id
         LEFT JOIN vorgaenge v ON v.netzplan_id = e.netzplan_id AND v.vorgang_nr = e.vorgang_nr
         WHERE e.status_flag <> 'running'
         GROUP BY n.netzplan_nr, e.vorgang_nr, e.leistungsart
         ORDER BY at DESC
         LIMIT ?1",
    )?;
    let rows = st.query_map([limit as i64], |r| {
        let nr: String = r.get(0)?;
        let vorgang: Option<String> = r.get(1)?;
        Ok(RecentTarget {
            reference: crate::desktop::timer_label(&nr, vorgang.as_deref()),
            netzplan_nr: nr,
            vorgang_nr: vorgang,
            leistungsart: r.get(2)?,
            label: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            last_text: r.get(4)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

// ------------------------------------------------------------- reference data

/// What [`import_reference`] took over.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct ReferenceImport {
    pub projects: usize,
    pub netzplaene: usize,
    pub vorgaenge: usize,
    pub leistungsarten: usize,
    pub events: usize,
    /// Why nothing was taken over (no copy, an encrypted or newer database).
    pub skipped: Option<String>,
}

/// Days of appointments taken over around today.
const EVENTS_BEFORE: i64 = 7;
const EVENTS_AFTER: i64 = 60;

/// Takes the WBS (Projekte, Netzpläne, Vorgänge, Leistungsarten) and the appointments of the
/// coming weeks over from `copy`, the desktop's database in the repository (Einstellungen →
/// Sicherung → „Datenbank mitsichern“ on the desktop). WBS entries are matched by their numbers
/// (bookings here keep pointing at them), the appointments replace the ones taken over before.
/// `scratch` is a folder for a private copy of the file (SQLite may write next to a file it
/// opens, and the repository must stay untouched). An encrypted copy is skipped: its key stays
/// on the desktop.
pub fn import_reference(db: &Database, copy: &Path, scratch: &Path, now: DateTime<Utc>) -> Result<ReferenceImport> {
    if !copy.is_file() {
        return Ok(ReferenceImport {
            skipped: Some(
                tr!(
                    "Keine Datenbankkopie im Repository (am Desktop „Datenbank mitsichern“ einschalten)",
                    "No database copy in the repository (switch on “Include the database” on the desktop)"
                )
                .into(),
            ),
            ..Default::default()
        });
    }
    std::fs::create_dir_all(scratch)?;
    let tmp = scratch.join("companion-reference.db");
    std::fs::copy(copy, &tmp).map_err(|e| Error::file(&tmp, e))?;
    let res = read_and_apply(db, &tmp, now);
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let _ = std::fs::remove_file(scratch.join(format!("companion-reference.db{suffix}")));
    }
    let out = res?;
    if out.skipped.is_none() {
        db.meta_set(REFERENCE_AT, &now.to_rfc3339())?;
    }
    Ok(out)
}

type ProjectRow = (String, String);
type NetzplanRow = (String, String, String, String, f64);
type VorgangRow = (String, String, String, f64, f64, Option<f64>);
type EventRow = (String, String, String, i64, String, String, i64, String, String, String, String);
type EventRest = (Option<String>, Option<String>, String, i64, String);

fn read_and_apply(db: &Database, file: &Path, now: DateTime<Utc>) -> Result<ReferenceImport> {
    let src = rusqlite::Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let version: i64 = match src.pragma_query_value(None, "user_version", |r| r.get(0)) {
        Ok(v) => v,
        Err(_) => {
            return Ok(ReferenceImport {
                skipped: Some(
                    tr!(
                        "Die Datenbankkopie ist verschlüsselt – Projekte und Termine bleiben am Desktop",
                        "The database copy is encrypted – projects and appointments stay on the desktop"
                    )
                    .into(),
                ),
                ..Default::default()
            });
        }
    };
    if version > db.schema_version()? as i64 {
        return Ok(ReferenceImport {
            skipped: Some(trf!(
                "Die Datenbankkopie stammt von einer neueren Arcalo-Version (Schema {version}) – bitte die App aktualisieren",
                "The database copy comes from a newer Arcalo (schema {version}) – please update the app"
            )),
            ..Default::default()
        });
    }
    let projects: Vec<ProjectRow> = {
        let mut st = src.prepare("SELECT project_code, name FROM projects")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    let netzplaene: Vec<NetzplanRow> = {
        let mut st = src.prepare(
            "SELECT p.project_code, n.netzplan_nr, n.wbs_element, n.description, n.planned_hours
             FROM netzplaene n JOIN projects p ON p.id = n.project_id",
        )?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    let vorgaenge: Vec<VorgangRow> = {
        let mut st = src.prepare(
            "SELECT n.netzplan_nr, v.vorgang_nr, v.description, v.duration_days, v.planned_hours, v.remaining_hours
             FROM vorgaenge v JOIN netzplaene n ON n.id = v.netzplan_id",
        )?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?)))?
            .collect::<rusqlite::Result<_>>()?
    };
    let leistungsarten: Vec<ProjectRow> = {
        let mut st = src.prepare("SELECT code, description FROM leistungsarten")?;
        st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
    };
    let from = crate::db::ts(now - Duration::days(EVENTS_BEFORE));
    let to = crate::db::ts(now + Duration::days(EVENTS_AFTER));
    let has_events: bool = src
        .query_row("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'calendar_events'", [], |_| Ok(()))
        .is_ok();
    let events: Vec<(EventRow, EventRest)> = if has_events {
        let mut st = src.prepare(
            "SELECT source, uid, instance, recurring, start_at, end_at, all_day, title, location, organizer, attendees,
                    body, link, busy, private, categories
             FROM calendar_events WHERE end_at >= ?1 AND start_at <= ?2",
        )?;
        st.query_map(params![from, to], |r| {
            Ok((
                (
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                    r.get(7)?,
                    r.get(8)?,
                    r.get(9)?,
                    r.get(10)?,
                ),
                (r.get(11)?, r.get(12)?, r.get(13)?, r.get(14)?, r.get(15)?),
            ))
        })?
        .collect::<rusqlite::Result<_>>()?
    } else {
        vec![]
    };
    drop(src);

    db.atomic(|| {
        let c = db.conn();
        for (code, name) in &projects {
            c.execute(
                "INSERT INTO projects (project_code, name) VALUES (?1, ?2)
                 ON CONFLICT (project_code) DO UPDATE SET name = excluded.name",
                params![code, name],
            )?;
        }
        for (code, nr, wbs, desc, hours) in &netzplaene {
            c.execute(
                "INSERT INTO netzplaene (project_id, netzplan_nr, wbs_element, description, planned_hours)
                 VALUES ((SELECT id FROM projects WHERE project_code = ?1), ?2, ?3, ?4, ?5)
                 ON CONFLICT (netzplan_nr) DO UPDATE SET project_id = excluded.project_id,
                   wbs_element = excluded.wbs_element, description = excluded.description,
                   planned_hours = excluded.planned_hours",
                params![code, nr, wbs, desc, hours],
            )?;
        }
        for (np, nr, desc, days, hours, remaining) in &vorgaenge {
            c.execute(
                "INSERT INTO vorgaenge (netzplan_id, vorgang_nr, description, duration_days, planned_hours, remaining_hours)
                 VALUES ((SELECT id FROM netzplaene WHERE netzplan_nr = ?1), ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT (netzplan_id, vorgang_nr) DO UPDATE SET description = excluded.description,
                   duration_days = excluded.duration_days, planned_hours = excluded.planned_hours,
                   remaining_hours = excluded.remaining_hours",
                params![np, nr, desc, days, hours, remaining],
            )?;
        }
        for (code, desc) in &leistungsarten {
            c.execute(
                "INSERT INTO leistungsarten (code, description) VALUES (?1, ?2)
                 ON CONFLICT (code) DO UPDATE SET description = excluded.description",
                params![code, desc],
            )?;
        }
        if has_events {
            c.execute("DELETE FROM calendar_events", [])?;
            for (a, b) in &events {
                c.execute(
                    "INSERT INTO calendar_events (source, uid, instance, recurring, start_at, end_at, all_day, title,
                       location, organizer, attendees, body, link, busy, private, categories)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
                    params![a.0, a.1, a.2, a.3, a.4, a.5, a.6, a.7, a.8, a.9, a.10, b.0, b.1, b.2, b.3, b.4],
                )?;
            }
        }
        Ok(())
    })?;
    Ok(ReferenceImport {
        projects: projects.len(),
        netzplaene: netzplaene.len(),
        vorgaenge: vorgaenge.len(),
        leistungsarten: leistungsarten.len(),
        events: events.len(),
        skipped: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn tz() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("arcalo-companion-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn wbs(db: &Database) {
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
        db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 6.0).unwrap();
    }

    #[test]
    fn a_booking_lands_as_a_chip_in_the_daily_note() {
        let db = Database::open_in_memory().unwrap();
        wbs(&db);
        let now = at("2026-10-08T10:00:00+02:00");
        let out = book(&db, "/zeit NP-8801/1020 1,5h #DEV Abstimmung", now, &tz(), &Thresholds::default()).unwrap();
        assert_eq!(out.entry.duration_minutes, Some(90));
        let day = db.daily_note(NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()).unwrap();
        assert_eq!(out.entry.page_id, Some(day.id));
        let content = db.page_doc(day.id).unwrap().content;
        let chips = crate::chips::chips(&content);
        assert_eq!(chips.len(), 1, "{content}");
        assert_eq!(chips[0].entry_id(), Some(out.entry.id));
        assert_eq!(chips[0].attr("hours"), Some("1,50"));
        assert_eq!(chips[0].attr("target"), Some("NP-8801/1020"));
        assert_eq!(chips[0].attr("la"), Some("DEV"));
        assert_eq!(chips[0].attr("date"), Some("2026-10-08"));
        assert_eq!(chips[0].text, "Abstimmung");
        // The desktop's editor sees it as the booking of this note.
        let states = db
            .chip_states(day.id, &[crate::chips::ChipQuery { id: out.entry.id, target: "NP-8801/1020".into() }])
            .unwrap();
        assert_eq!(states[0].link, crate::chips::ChipLink::Linked);

        // An unknown reference books nothing and writes nothing.
        let before = db.page_doc(day.id).unwrap().content;
        assert!(book(&db, "/zeit NP-9999 1h Fehler", now, &tz(), &Thresholds::default()).is_err());
        assert_eq!(db.page_doc(day.id).unwrap().content, before);
    }

    #[test]
    fn today_sums_bookings_and_lists_due_tasks() {
        let db = Database::open_in_memory().unwrap();
        wbs(&db);
        let now = at("2026-10-08T15:00:00+02:00");
        book(&db, "/zeit NP-8801/1020 2h Konzept", now, &tz(), &Thresholds::default()).unwrap();
        book(&db, "/zeit NP-8801 1h Vorbereitung @gestern", now, &tz(), &Thresholds::default()).unwrap();
        let page = db.create_page(None, "Aufgaben", None).unwrap();
        db.save_page_content(page.id, "- [ ] Bericht due:2026-10-08\n- [ ] Alt due:2026-10-01 !!\n- [ ] Später due:2026-12-01\n- [x] Fertig due:2026-10-02\n")
            .unwrap();
        let settings = Settings::default();
        let t = today(&db, &settings, now, &tz()).unwrap();
        assert_eq!(t.date, NaiveDate::from_ymd_opt(2026, 10, 8).unwrap());
        assert_eq!(t.booked_minutes, 120);
        assert!(t.week_minutes >= 120);
        assert_eq!(t.tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["Alt", "Bericht"], "{:?}", t.tasks);
        assert!(t.timer.is_none());
        assert!(t.events.is_empty());

        let np = db.netzplan_by_ref("NP-8801").unwrap();
        db.start_timer(np.id, Some("1020"), None, "Läuft", now - Duration::minutes(30)).unwrap();
        let t = today(&db, &settings, now, &tz()).unwrap();
        assert_eq!(t.timer.as_ref().map(|r| r.reference.as_str()), Some("NP-8801/1020"));
        assert_eq!(t.timer.as_ref().map(|r| r.worked_minutes), Some(30));
        assert_eq!(t.booked_minutes, 150);
    }

    #[test]
    fn recent_targets_come_newest_first_and_once() {
        let db = Database::open_in_memory().unwrap();
        wbs(&db);
        let t = Thresholds::default();
        book(&db, "/zeit NP-8801/1020 1h #DEV Eins", at("2026-10-06T10:00:00Z"), &tz(), &t).unwrap();
        book(&db, "/zeit NP-8801 1h Zwei", at("2026-10-07T10:00:00Z"), &tz(), &t).unwrap();
        book(&db, "/zeit NP-8801/1020 1h #DEV Drei", at("2026-10-08T10:00:00Z"), &tz(), &t).unwrap();
        let r = recent_targets(&db, 10).unwrap();
        assert_eq!(r.iter().map(|r| r.reference.as_str()).collect::<Vec<_>>(), ["NP-8801/1020", "NP-8801"]);
        assert_eq!(r[0].label, "Systemintegration");
        assert_eq!(r[0].last_text, "Drei");
        assert_eq!(r[0].leistungsart.as_deref(), Some("DEV"));
    }

    #[test]
    fn reference_data_comes_from_the_desktops_copy() {
        let dir = tmp("reference");
        let desk_file = dir.join("desk.db");
        {
            let desk = Database::open(&desk_file).unwrap();
            wbs(&desk);
            desk.upsert_leistungsart("MEET", "Besprechung").unwrap();
            desk.conn()
                .execute(
                    "INSERT INTO calendar_events (source, uid, start_at, end_at, title)
                     VALUES ('outlook', 'a', '2026-10-08T08:00:00Z', '2026-10-08T09:00:00Z', 'Jour fixe'),
                            ('outlook', 'b', '2027-03-01T08:00:00Z', '2027-03-01T09:00:00Z', 'Zu weit weg')",
                    [],
                )
                .unwrap();
            desk.checkpoint().unwrap();
        }
        let copy = dir.join("arcalo-workspace.db");
        std::fs::copy(&desk_file, &copy).unwrap();
        let phone = Database::open_in_memory().unwrap();
        // A booking made on the phone before keeps its Netzplan.
        let p = phone.create_project("PRJ-2026-X", "Alt").unwrap();
        let np = phone.create_netzplan(p.id, "NP-8801", "alt", "alt", 1.0).unwrap();
        let now = at("2026-10-08T06:00:00Z");
        let out = import_reference(&phone, &copy, &dir.join("scratch"), now).unwrap();
        assert_eq!(out.skipped, None);
        assert_eq!((out.projects, out.netzplaene, out.vorgaenge, out.events), (1, 1, 1, 1));
        assert_eq!(phone.netzplan_by_ref("NP-8801").unwrap().id, np.id);
        assert_eq!(phone.netzplan_by_ref("NP-8801").unwrap().wbs_element, "NP-8801-1020");
        assert!(phone.list_leistungsarten().unwrap().iter().any(|(c, _)| c == "MEET"));
        let t = today(&phone, &Settings::default(), now, &tz()).unwrap();
        assert_eq!(t.events.iter().map(|e| e.event.title.as_str()).collect::<Vec<_>>(), ["Jour fixe"]);
        assert!(t.events_from.is_some());
        // The repository's file is left as it was, nothing written next to it.
        let names: Vec<String> =
            std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert!(!names.iter().any(|n| n.starts_with("arcalo-workspace.db-")), "{names:?}");
        // Again: the same rows, not twice.
        let again = import_reference(&phone, &copy, &dir.join("scratch"), now).unwrap();
        assert_eq!(again.events, 1);
        let n: i64 = phone.conn().query_row("SELECT COUNT(*) FROM calendar_events", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);

        let missing = import_reference(&phone, &dir.join("fehlt.db"), &dir.join("scratch"), now).unwrap();
        assert!(missing.skipped.is_some());
        std::fs::write(dir.join("kaputt.db"), b"not a database at all, just text").unwrap();
        let broken = import_reference(&phone, &dir.join("kaputt.db"), &dir.join("scratch"), now).unwrap();
        assert!(broken.skipped.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_daily_note_pulled_from_the_desktop_becomes_the_daily_note() {
        let db = Database::open_in_memory().unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 8).unwrap();
        assert!(daily(&db, date, false).unwrap().is_none());
        let title = Settings::default().notes.daily_title.title(date);
        let pulled = db.create_page(None, &title, Some("calendar")).unwrap();
        db.save_page_content(pulled.id, "## Notizen\n\nVom Desktop\n").unwrap();
        let found = daily(&db, date, false).unwrap().unwrap();
        assert_eq!(found.id, pulled.id);
        assert_eq!(found.daily_date.as_deref(), Some("2026-10-08"));
        assert_eq!(db.daily_note(date).unwrap().id, pulled.id, "no second daily note");
        let other = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let created = daily(&db, other, true).unwrap().unwrap();
        assert_eq!(created.daily_date.as_deref(), Some("2026-10-09"));
    }

    #[test]
    fn a_stopped_timer_is_written_into_the_note_of_its_day() {
        let db = Database::open_in_memory().unwrap();
        wbs(&db);
        let np = db.netzplan_by_ref("NP-8801").unwrap();
        let start = at("2026-10-08T09:00:00+02:00");
        db.start_timer(np.id, Some("1020"), Some("DEV"), "Workshop", start).unwrap();
        let entries = db.stop_timer_in(start + Duration::minutes(45), &[], &tz()).unwrap();
        add_chips(&db, &entries, &tz()).unwrap();
        let day = db.daily_note(NaiveDate::from_ymd_opt(2026, 10, 8).unwrap()).unwrap();
        let content = db.page_doc(day.id).unwrap().content;
        assert!(
            content.contains(r#"hours="0,75" target="NP-8801/1020" la="DEV" date="2026-10-08">Workshop</time-entry>"#),
            "{content}"
        );
        assert_eq!(db.time_entry(entries[0].id).unwrap().page_id, Some(day.id));
    }
}
