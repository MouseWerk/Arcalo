//! Focus sessions („Fokus“, Pomodoro): a fixed stretch of work on a Vorgang with an optional
//! goal, then a break. A finished session books its minutes as a draft time entry on the
//! Vorgang (the goal as description); later sessions of the same day with the same goal extend
//! that entry. Breaks are never booked. The running session lives in the database, so it
//! survives a restart; one that ran out meanwhile is completed on the next [`state`].

use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::feed::{NewActivity, day_start};
use crate::model::{EntrySource, NewTimeEntry, TimeEntry};

/// Longest session (minutes).
pub const MAX_MINUTES: f64 = 240.0;
/// Longest break (minutes).
pub const MAX_BREAK: i64 = 60;
/// Description of a booking without a goal.
pub const DEFAULT_GOAL: &str = "Fokussitzung";
/// First words of the line in the daily note.
pub const LINE_PREFIX: &str = "Fokus heute:";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FocusSession {
    pub id: i64,
    pub netzplan_id: Option<i64>,
    pub vorgang_nr: Option<String>,
    /// `NP-8801/1020`; empty for a session without Vorgang (nothing is booked then).
    pub reference: String,
    pub goal: String,
    pub started_at: DateTime<Utc>,
    pub planned_minutes: f64,
    pub break_minutes: i64,
    pub ended_at: Option<DateTime<Utc>>,
    /// `running`, `done` or `aborted`.
    pub status: String,
    pub worked_minutes: i64,
    pub booked_minutes: i64,
    pub entry_id: Option<i64>,
    pub break_until: Option<DateTime<Utc>>,
}

impl FocusSession {
    /// When the work phase ends.
    pub fn ends_at(&self) -> DateTime<Utc> {
        self.started_at + chrono::Duration::milliseconds((self.planned_minutes * 60_000.0).round() as i64)
    }
}

/// The current phase: a running session (`work`) or the break after one (`break`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FocusState {
    pub session: FocusSession,
    pub phase: &'static str,
    /// End of the work phase or of the break.
    pub ends_at: DateTime<Utc>,
    /// The session ran out while nobody was looking (app closed) and was completed by this call.
    pub completed: Option<FocusOutcome>,
}

/// What finishing or aborting a session booked.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FocusOutcome {
    pub session: FocusSession,
    /// The booked entry (new or extended); `None` when nothing was booked.
    pub entry: Option<TimeEntry>,
    /// An entry of an earlier session was extended instead of a new one created.
    pub extended: bool,
}

/// Minutes per Vorgang in a report.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FocusShare {
    /// `NP-8801/1020`, or empty for sessions without Vorgang.
    pub reference: String,
    pub sessions: i64,
    pub minutes: i64,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct FocusReport {
    pub sessions: i64,
    pub minutes: i64,
    /// Most minutes first.
    pub by_reference: Vec<FocusShare>,
}

/// `100` → `1:40 h`, `25` → `0:25 h`.
pub fn hm(minutes: i64) -> String {
    let m = minutes.max(0);
    format!("{}:{:02} h", m / 60, m % 60)
}

const COLS: &str = "id, netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, break_minutes, ended_at,
     status, worked_minutes, booked_minutes, entry_id, break_until";

fn map(r: &Row) -> rusqlite::Result<FocusSession> {
    let opt_ts = |i: usize| -> rusqlite::Result<Option<DateTime<Utc>>> {
        r.get::<_, Option<String>>(i)?.as_deref().map(parse_ts).transpose()
    };
    Ok(FocusSession {
        id: r.get(0)?,
        netzplan_id: r.get(1)?,
        vorgang_nr: r.get(2)?,
        reference: r.get(3)?,
        goal: r.get(4)?,
        started_at: parse_ts(&r.get::<_, String>(5)?)?,
        planned_minutes: r.get(6)?,
        break_minutes: r.get(7)?,
        ended_at: opt_ts(8)?,
        status: r.get(9)?,
        worked_minutes: r.get(10)?,
        booked_minutes: r.get(11)?,
        entry_id: r.get(12)?,
        break_until: opt_ts(13)?,
    })
}

fn session(db: &Database, id: i64) -> Result<FocusSession> {
    db.conn()
        .query_row(&format!("SELECT {COLS} FROM focus_sessions WHERE id = ?1"), [id], map)
        .optional()?
        .ok_or_else(|| Error::not_found("focus session", id.to_string()))
}

/// The running session, if any (without completing an overdue one).
pub fn running(db: &Database) -> Result<Option<FocusSession>> {
    Ok(db
        .conn()
        .query_row(&format!("SELECT {COLS} FROM focus_sessions WHERE status = 'running'"), [], map)
        .optional()?)
}

/// Netzplan and canonical Vorgang of `NP-8801/1020` (or a WBS element, like `/zeit`).
fn resolve(db: &Database, reference: &str) -> Result<(i64, Option<String>, String)> {
    let (np_ref, v_ref) = match reference.split_once('/') {
        Some((n, v)) => (n.trim(), Some(v.trim()).filter(|v| !v.is_empty())),
        None => (reference.trim(), None),
    };
    let np = db.netzplan_by_ref(np_ref)?;
    let vorgang = match v_ref {
        None => None,
        Some(v) => {
            let list = db.list_vorgaenge(np.id)?;
            match list.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) {
                Some(found) => Some(found.vorgang_nr.clone()),
                // A Netzplan without modelled Vorgänge accepts free activity codes (like `/zeit`).
                None if list.is_empty() => Some(v.to_owned()),
                None => return Err(Error::not_found("vorgang", format!("{}/{v}", np.netzplan_nr))),
            }
        }
    };
    let label = crate::desktop::timer_label(&np.netzplan_nr, vorgang.as_deref());
    Ok((np.id, vorgang, label))
}

/// Parameters of [`start`].
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct FocusStart {
    /// `NP-8801/1020`; empty = no Vorgang (nothing is booked).
    pub reference: String,
    pub minutes: f64,
    pub break_minutes: i64,
    pub goal: String,
}

/// Starts a session. Refused while another one runs.
pub fn start(db: &Database, s: &FocusStart, now: DateTime<Utc>) -> Result<FocusSession> {
    if !(s.minutes.is_finite() && s.minutes > 0.0 && s.minutes <= MAX_MINUTES) {
        return Err(Error::State(format!("Die Sitzung muss zwischen 1 und {MAX_MINUTES} Minuten lang sein")));
    }
    if running(db)?.is_some() {
        return Err(Error::State("Es läuft bereits eine Fokussitzung".into()));
    }
    let (np, vorgang, label) = match s.reference.trim() {
        "" => (None, None, String::new()),
        r => {
            let (np, v, label) = resolve(db, r)?;
            (Some(np), v, label)
        }
    };
    db.atomic(|| {
        // A new session ends the break of the previous one.
        db.conn().execute("UPDATE focus_sessions SET break_until = ?1 WHERE break_until > ?1", [ts(now)])?;
        db.conn().execute(
            "INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, break_minutes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![np, vorgang, label, s.goal.trim(), ts(now), s.minutes, s.break_minutes.clamp(0, MAX_BREAK)],
        )?;
        session(db, db.conn().last_insert_rowid())
    })
}

/// The current phase. A session whose time ran out is completed (and booked) first.
pub fn state<Tz: TimeZone>(db: &Database, now: DateTime<Utc>, tz: &Tz) -> Result<Option<FocusState>> {
    let mut completed = None;
    if let Some(s) = running(db)? {
        if now < s.ends_at() {
            let ends_at = s.ends_at();
            return Ok(Some(FocusState { session: s, phase: "work", ends_at, completed: None }));
        }
        completed = Some(finish(db, now, tz)?);
    }
    let last: Option<FocusSession> = db
        .conn()
        .query_row(
            &format!(
                "SELECT {COLS} FROM focus_sessions WHERE status = 'done' AND break_until > ?1 ORDER BY id DESC LIMIT 1"
            ),
            [ts(now)],
            map,
        )
        .optional()?;
    Ok(match (last, completed) {
        (Some(s), completed) => {
            let ends_at = s.break_until.unwrap_or(now);
            Some(FocusState { session: s, phase: "break", ends_at, completed })
        }
        // Completed without a break (0 minutes): report it once.
        (None, Some(c)) => {
            let ends_at = c.session.ended_at.unwrap_or(now);
            Some(FocusState { session: c.session.clone(), phase: "break", ends_at, completed: Some(c) })
        }
        (None, None) => None,
    })
}

/// Completes the running session at its planned end (it may be called a little late or, by
/// clock skew, a few seconds early) and books it.
pub fn finish<Tz: TimeZone>(db: &Database, now: DateTime<Utc>, tz: &Tz) -> Result<FocusOutcome> {
    let s = running(db)?.ok_or_else(|| Error::State("Keine Fokussitzung läuft".into()))?;
    let end = s.ends_at();
    if now + chrono::Duration::seconds(5) < end {
        return Err(Error::State("Die Fokussitzung läuft noch".into()));
    }
    // A completed session counts at least one minute (very short test sessions).
    let worked = (s.planned_minutes.round() as i64).max(1);
    close(db, &s, "done", end, worked, true, tz)
}

/// Ends the running session early; with `book` the minutes so far are booked.
pub fn abort<Tz: TimeZone>(db: &Database, now: DateTime<Utc>, book: bool, tz: &Tz) -> Result<FocusOutcome> {
    let s = running(db)?.ok_or_else(|| Error::State("Keine Fokussitzung läuft".into()))?;
    let end = now.min(s.ends_at()).max(s.started_at);
    let worked = ((end - s.started_at).num_seconds() as f64 / 60.0).round() as i64;
    close(db, &s, "aborted", end, worked, book, tz)
}

fn close<Tz: TimeZone>(
    db: &Database,
    s: &FocusSession,
    status: &str,
    end: DateTime<Utc>,
    worked: i64,
    book: bool,
    tz: &Tz,
) -> Result<FocusOutcome> {
    db.atomic(|| {
        let break_until = (status == "done").then(|| end + chrono::Duration::minutes(s.break_minutes));
        db.conn().execute(
            "UPDATE focus_sessions SET status = ?2, ended_at = ?3, worked_minutes = ?4, break_until = ?5 WHERE id = ?1",
            params![s.id, status, ts(end), worked, break_until.map(ts)],
        )?;
        let (entry, extended) = match s.netzplan_id {
            Some(np) if book && worked >= 1 => {
                let (e, ext) = book_session(db, s, np, end, worked, tz)?;
                (Some(e), ext)
            }
            _ => (None, false),
        };
        let session = session(db, s.id)?;
        let a = NewActivity {
            kind: "focus_session",
            netzplan_id: session.netzplan_id,
            vorgang_nr: session.vorgang_nr.clone(),
            entry_id: session.entry_id,
            title: session.goal.clone(),
            detail: status.to_owned(),
            amount: worked,
            ..Default::default()
        };
        db.record_activity(&a, end)?;
        Ok(FocusOutcome { session, entry, extended })
    })
}

/// Books `worked` minutes: extends today's draft entry of an earlier session with the same
/// Vorgang and goal, otherwise creates one. Rounding (Settings → Zeiterfassung) applies to the
/// entry's total.
fn book_session<Tz: TimeZone>(
    db: &Database,
    s: &FocusSession,
    np: i64,
    end: DateTime<Utc>,
    worked: i64,
    tz: &Tz,
) -> Result<(TimeEntry, bool)> {
    let description = if s.goal.trim().is_empty() { DEFAULT_GOAL.to_owned() } else { s.goal.trim().to_owned() };
    let settings = db.load_settings().unwrap_or_default();
    let day = day_start(end.with_timezone(tz).date_naive(), tz);
    let existing: Option<i64> = db
        .conn()
        .query_row(
            "SELECT e.id FROM time_entries e
             WHERE e.netzplan_id = ?1 AND IFNULL(e.vorgang_nr, '') = IFNULL(?2, '') AND e.description = ?3
               AND e.status_flag = 'draft' AND e.start_time >= ?4
               AND EXISTS (SELECT 1 FROM focus_sessions f WHERE f.entry_id = e.id)
             ORDER BY e.start_time DESC LIMIT 1",
            params![np, s.vorgang_nr, description, ts(day)],
            |r| r.get(0),
        )
        .optional()?;
    let (entry, extended) = match existing {
        Some(id) => {
            let before: i64 = db.conn().query_row(
                "SELECT IFNULL(SUM(worked_minutes), 0) FROM focus_sessions WHERE entry_id = ?1 AND id <> ?2",
                params![id, s.id],
                |r| r.get(0),
            )?;
            let total = settings.time.rounding.apply(before + worked);
            db.conn().execute(
                "UPDATE time_entries SET duration_minutes = ?2, end_time = ?3 WHERE id = ?1",
                params![id, total, ts(end)],
            )?;
            let e = db.time_entry(id)?;
            db.feed_entry("entry_changed", &e, end)?;
            (e, true)
        }
        None => {
            let nr = db.netzplan_by_id(np)?.netzplan_nr;
            let leistungsart = match settings.time.default_la_for(&nr) {
                Some(la) if db.leistungsart_exists(la)? => Some(la.to_owned()),
                _ => None,
            };
            let minutes = settings.time.rounding.apply(worked).max(1);
            let e = db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: s.vorgang_nr.clone(),
                leistungsart,
                start_time: end - chrono::Duration::minutes(minutes),
                duration_minutes: minutes,
                description,
                source: EntrySource::Timer,
                page_id: None,
            })?;
            (e, false)
        }
    };
    db.conn().execute(
        "UPDATE focus_sessions SET entry_id = ?2, booked_minutes = ?3 WHERE id = ?1",
        params![s.id, entry.id, worked],
    )?;
    Ok((entry, extended))
}

/// Ends the current break (next session or stop).
pub fn end_break(db: &Database, now: DateTime<Utc>) -> Result<()> {
    db.conn().execute("UPDATE focus_sessions SET break_until = ?1 WHERE break_until > ?1", [ts(now)])?;
    Ok(())
}

/// Whether notifications are held back now: a session is in its work phase.
pub fn holds_notifications(db: &Database, now: DateTime<Utc>) -> bool {
    matches!(running(db), Ok(Some(s)) if now < s.ends_at())
}

/// Ids of the time entries booked by focus sessions (marked in the timesheet).
pub fn entry_ids(db: &Database) -> Result<Vec<i64>> {
    let mut st = db.conn().prepare("SELECT DISTINCT entry_id FROM focus_sessions WHERE entry_id IS NOT NULL")?;
    Ok(st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

/// Finished sessions of the local days `from..=to`, with minutes per Vorgang.
pub fn report<Tz: TimeZone>(db: &Database, from: NaiveDate, to: NaiveDate, tz: &Tz) -> Result<FocusReport> {
    let (a, b) = (day_start(from, tz), day_start(to + chrono::Duration::days(1), tz));
    let mut st = db.conn().prepare(
        "SELECT reference, COUNT(*), SUM(worked_minutes) FROM focus_sessions
         WHERE status <> 'running' AND worked_minutes > 0 AND started_at >= ?1 AND started_at < ?2
         GROUP BY reference ORDER BY SUM(worked_minutes) DESC, reference",
    )?;
    let by_reference: Vec<FocusShare> = st
        .query_map(params![ts(a), ts(b)], |r| {
            Ok(FocusShare { reference: r.get(0)?, sessions: r.get(1)?, minutes: r.get(2)? })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(FocusReport {
        sessions: by_reference.iter().map(|s| s.sessions).sum(),
        minutes: by_reference.iter().map(|s| s.minutes).sum(),
        by_reference,
    })
}

/// „Fokus heute: 4 Sitzungen, 1:40 h — NP-8801/1020 1:00 h, NP-8801/1030 0:40 h“; `None` without sessions.
pub fn daily_line(r: &FocusReport) -> Option<String> {
    if r.sessions == 0 {
        return None;
    }
    let mut line = format!(
        "{LINE_PREFIX} {} {}, {}",
        r.sessions,
        if r.sessions == 1 { "Sitzung" } else { "Sitzungen" },
        hm(r.minutes)
    );
    let parts: Vec<String> = r
        .by_reference
        .iter()
        .map(|s| format!("{} {}", if s.reference.is_empty() { "ohne Vorgang" } else { &s.reference }, hm(s.minutes)))
        .collect();
    if !parts.is_empty() {
        line.push_str(" — ");
        line.push_str(&parts.join(", "));
    }
    Some(line)
}

/// Writes (or replaces) the focus line in the daily note of `day`. Returns the note's id.
pub fn write_daily_line<Tz: TimeZone>(db: &Database, day: NaiveDate, tz: &Tz) -> Result<i64> {
    let r = report(db, day, day, tz)?;
    let line = daily_line(&r).ok_or_else(|| Error::State("An diesem Tag gab es noch keine Fokussitzung".into()))?;
    db.atomic(|| {
        let page = db.daily_note(day)?;
        let content = db.page_doc(page.id)?.content;
        let mut replaced = false;
        let mut lines: Vec<String> = content
            .lines()
            .map(|l| {
                if !replaced && l.trim_start().starts_with(LINE_PREFIX) {
                    replaced = true;
                    line.clone()
                } else {
                    l.to_owned()
                }
            })
            .collect();
        if !replaced {
            while lines.last().is_some_and(|l| l.trim().is_empty()) {
                lines.pop();
            }
            if !lines.is_empty() {
                lines.push(String::new());
            }
            lines.push(line.clone());
        }
        let mut next = lines.join("\n");
        next.push('\n');
        if next != content {
            db.save_page_content(page.id, &next)?;
        }
        Ok(page.id)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    /// Whole seconds, as stored.
    fn whole(t: DateTime<Utc>) -> DateTime<Utc> {
        chrono::Timelike::with_nanosecond(&t, 0).unwrap()
    }

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn setup() -> (Database, String) {
        let (db, np) = crate::feed::seeded();
        let v = db.list_vorgaenge(np.id).unwrap()[0].vorgang_nr.clone();
        (db, format!("{}/{v}", np.netzplan_nr))
    }

    fn begin(db: &Database, reference: &str, minutes: f64, goal: &str, now: DateTime<Utc>) -> FocusSession {
        let s = FocusStart { reference: reference.into(), minutes, break_minutes: 5, goal: goal.into() };
        start(db, &s, now).unwrap()
    }

    #[test]
    fn a_finished_session_books_a_draft_entry_and_later_ones_extend_it() {
        let (db, r) = setup();
        let t0 = whole(Utc::now() - chrono::Duration::hours(3));
        let s = begin(&db, &r.to_lowercase(), 25.0, "Konzept schreiben", t0);
        assert_eq!(s.reference, r, "canonical spelling");
        assert!(start(&db, &FocusStart { minutes: 25.0, ..Default::default() }, t0).is_err(), "one at a time");
        assert!(holds_notifications(&db, t0 + chrono::Duration::minutes(10)));
        assert!(finish(&db, t0 + chrono::Duration::minutes(10), &cet()).is_err(), "still running");
        let out = finish(&db, t0 + chrono::Duration::minutes(25), &cet()).unwrap();
        let e = out.entry.unwrap();
        assert_eq!(
            (e.duration_minutes, e.description.as_str(), e.status_flag),
            (Some(25), "Konzept schreiben", crate::model::StatusFlag::Draft)
        );
        assert!(!out.extended);
        assert!(!holds_notifications(&db, t0 + chrono::Duration::minutes(26)));
        // The break follows and is not booked.
        let st = state(&db, t0 + chrono::Duration::minutes(27), &cet()).unwrap().unwrap();
        assert_eq!(st.phase, "break");
        assert_eq!(st.ends_at, t0 + chrono::Duration::minutes(30));
        // Second session after the break: the same entry grows by 25 minutes.
        let t1 = t0 + chrono::Duration::minutes(31);
        begin(&db, &r, 25.0, "Konzept schreiben", t1);
        let out = finish(&db, t1 + chrono::Duration::minutes(25), &cet()).unwrap();
        assert!(out.extended);
        assert_eq!(out.entry.as_ref().unwrap().id, e.id);
        assert_eq!(out.entry.unwrap().duration_minutes, Some(50));
        assert_eq!(entry_ids(&db).unwrap(), [e.id]);
        // Another goal: its own entry.
        let t2 = t1 + chrono::Duration::minutes(30);
        begin(&db, &r, 10.0, "Mails", t2);
        let out = finish(&db, t2 + chrono::Duration::minutes(10), &cet()).unwrap();
        assert_ne!(out.entry.unwrap().id, e.id);
        let rep =
            report(&db, t0.with_timezone(&cet()).date_naive(), t2.with_timezone(&cet()).date_naive(), &cet()).unwrap();
        assert_eq!((rep.sessions, rep.minutes), (3, 60));
        assert_eq!(rep.by_reference[0].reference, r);
        let line = daily_line(&rep).unwrap();
        assert_eq!(line, format!("Fokus heute: 3 Sitzungen, 1:00 h — {r} 1:00 h"));
    }

    #[test]
    fn aborting_books_only_on_request_and_short_sessions_count_a_minute() {
        let (db, r) = setup();
        let t0 = whole(Utc::now() - chrono::Duration::hours(1));
        begin(&db, &r, 50.0, "", t0);
        let out = abort(&db, t0 + chrono::Duration::minutes(12), false, &cet()).unwrap();
        assert!(out.entry.is_none());
        assert_eq!((out.session.status.as_str(), out.session.worked_minutes), ("aborted", 12));
        assert!(state(&db, t0 + chrono::Duration::minutes(13), &cet()).unwrap().is_none(), "no break after an abort");
        begin(&db, &r, 50.0, "", t0 + chrono::Duration::minutes(15));
        let out = abort(&db, t0 + chrono::Duration::minutes(35), true, &cet()).unwrap();
        let e = out.entry.unwrap();
        assert_eq!((e.duration_minutes, e.description.as_str()), (Some(20), DEFAULT_GOAL));
        // 0.05 minutes (a test hook): completed, booked as one minute.
        let t1 = t0 + chrono::Duration::minutes(40);
        begin(&db, &r, 0.05, "Kurz", t1);
        let out = finish(&db, t1 + chrono::Duration::seconds(3), &cet()).unwrap();
        assert_eq!(out.entry.unwrap().duration_minutes, Some(1));
        // Without a Vorgang nothing is booked, but the session counts.
        begin(&db, "", 5.0, "Lesen", t1 + chrono::Duration::minutes(2));
        let out = finish(&db, t1 + chrono::Duration::minutes(7), &cet()).unwrap();
        assert!(out.entry.is_none());
        assert!(
            start(&db, &FocusStart { reference: "NP-X/1".into(), minutes: 5.0, ..Default::default() }, t1).is_err()
        );
        assert!(start(&db, &FocusStart { minutes: 0.0, ..Default::default() }, t1).is_err());
    }

    #[test]
    fn a_session_that_ran_out_while_closed_is_completed_on_the_next_state() {
        let (db, r) = setup();
        let t0 = whole(Utc::now() - chrono::Duration::hours(2));
        begin(&db, &r, 25.0, "Review", t0);
        let st = state(&db, t0 + chrono::Duration::minutes(90), &cet()).unwrap().unwrap();
        let done = st.completed.unwrap();
        assert_eq!(done.session.status, "done");
        assert_eq!(done.session.ended_at, Some(t0 + chrono::Duration::minutes(25)));
        assert_eq!(done.entry.unwrap().duration_minutes, Some(25));
        assert!(running(&db).unwrap().is_none());
        // Break over long ago: nothing left.
        assert!(state(&db, t0 + chrono::Duration::minutes(91), &cet()).unwrap().is_none());
        let feed = crate::feed::list(
            &db,
            &crate::feed::FeedFilter { kinds: vec!["focus_session".into()], ..Default::default() },
        )
        .unwrap();
        assert_eq!((feed.len(), feed[0].amount), (1, 25));
    }

    #[test]
    fn the_daily_note_gets_one_focus_line() {
        let (db, r) = setup();
        let now = Utc::now();
        let today = now.with_timezone(&cet()).date_naive();
        assert!(write_daily_line(&db, today, &cet()).is_err(), "nothing to write yet");
        let t0 = day_start(today, &cet()) + chrono::Duration::hours(8);
        begin(&db, &r, 25.0, "A", t0);
        finish(&db, t0 + chrono::Duration::minutes(25), &cet()).unwrap();
        let id = write_daily_line(&db, today, &cet()).unwrap();
        begin(&db, &r, 50.0, "B", t0 + chrono::Duration::hours(1));
        finish(&db, t0 + chrono::Duration::minutes(110), &cet()).unwrap();
        write_daily_line(&db, today, &cet()).unwrap();
        let content = db.page_doc(id).unwrap().content;
        assert_eq!(content.matches(LINE_PREFIX).count(), 1, "{content}");
        assert!(content.contains(&format!("Fokus heute: 2 Sitzungen, 1:15 h — {r} 1:15 h")), "{content}");
        assert_eq!(hm(100), "1:40 h");
    }
}
