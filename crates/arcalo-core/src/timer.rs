//! The running timer's pauses and how a stopped run becomes bookings: pauses (and, when the
//! user chooses so, idle and sleep time) are not booked, and a run over midnight becomes one
//! booking per local day.

use crate::tr;
use chrono::{DateTime, Days, NaiveTime, TimeZone, Utc};
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::model::{EntrySource, NewTimeEntry, StatusFlag, TimeEntry};

/// A stretch inside a timer run that is not booked: a pause, idle or sleep time.
pub type Gap = (DateTime<Utc>, DateTime<Utc>);

/// A pause of the running timer: start, and end once it is over.
pub type Pause = (DateTime<Utc>, Option<DateTime<Utc>>);

/// One day's share of a timer run: first and last worked instant and the worked minutes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub minutes: i64,
}

/// Pause state of the running timer (for the timer display).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct PauseState {
    /// Since when the timer is paused, `None` while it runs.
    pub paused_since: Option<DateTime<Utc>>,
    /// Seconds of the pauses that are over.
    pub paused_seconds: i64,
}

/// Sorted, merged gaps clipped to `from..to`.
fn normalize(gaps: &[Gap], from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<Gap> {
    let mut v: Vec<Gap> = gaps.iter().map(|&(a, b)| (a.max(from), b.min(to))).filter(|(a, b)| a < b).collect();
    v.sort();
    let mut out: Vec<Gap> = Vec::with_capacity(v.len());
    for (a, b) in v {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

/// The next local midnight after `t` (DST-safe: the first instant of the next local date).
fn next_midnight<Tz: TimeZone>(t: DateTime<Utc>, tz: &Tz) -> DateTime<Utc> {
    let day = t.with_timezone(tz).date_naive() + Days::new(1);
    let local = day.and_time(NaiveTime::MIN);
    tz.from_local_datetime(&local)
        .earliest()
        // Midnight skipped by a clock change: the first hour that exists.
        .or_else(|| tz.from_local_datetime(&(local + chrono::Duration::hours(1))).earliest())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or(t + chrono::Duration::days(1))
}

/// Splits the run `start..end` into one [`Segment`] per local day, without the `gaps`. Days
/// with nothing worked are left out; minutes are rounded from the worked seconds.
pub fn split_run<Tz: TimeZone>(start: DateTime<Utc>, end: DateTime<Utc>, gaps: &[Gap], tz: &Tz) -> Vec<Segment> {
    let mut out = vec![];
    if end <= start {
        return out;
    }
    let gaps = normalize(gaps, start, end);
    let mut day_start = start;
    while day_start < end {
        let day_end = next_midnight(day_start, tz).min(end);
        // Worked pieces of this day: the day minus the gaps.
        let mut pieces = vec![];
        let mut cur = day_start;
        for &(a, b) in gaps.iter().filter(|(a, b)| *b > day_start && *a < day_end) {
            if a > cur {
                pieces.push((cur, a));
            }
            cur = cur.max(b);
        }
        if cur < day_end {
            pieces.push((cur, day_end));
        }
        let seconds: i64 = pieces.iter().map(|(a, b)| (*b - *a).num_seconds()).sum();
        if let (Some(first), Some(last)) = (pieces.first(), pieces.last())
            && seconds > 0
        {
            out.push(Segment { start: first.0, end: last.1, minutes: (seconds as f64 / 60.0).round() as i64 });
        }
        day_start = day_end;
    }
    out
}

impl Database {
    /// The pauses of a (running) timer entry, oldest first; the last one may still be open.
    pub fn timer_pauses(&self, entry_id: i64) -> Result<Vec<Pause>> {
        let mut st = self.conn().prepare_cached(
            "SELECT start_time, end_time FROM timer_pauses WHERE entry_id = ?1 ORDER BY start_time, id",
        )?;
        let rows = st.query_map([entry_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))?;
        let mut out = vec![];
        for row in rows {
            let (a, b) = row?;
            out.push((parse_ts(&a)?, b.as_deref().map(parse_ts).transpose()?));
        }
        Ok(out)
    }

    /// Whether the timer `entry_id` is paused, and how long its finished pauses took.
    pub fn pause_state(&self, entry_id: i64) -> Result<PauseState> {
        let mut s = PauseState::default();
        for (a, b) in self.timer_pauses(entry_id)? {
            match b {
                Some(b) => s.paused_seconds += (b - a).num_seconds().max(0),
                None => s.paused_since = Some(a),
            }
        }
        Ok(s)
    }

    /// Worked minutes of the running timer up to `now` (pauses left out).
    pub fn timer_worked_minutes(&self, e: &TimeEntry, now: DateTime<Utc>) -> Result<i64> {
        let p = self.pause_state(e.id)?;
        let until = p.paused_since.unwrap_or(now).max(e.start_time);
        Ok(((until - e.start_time).num_seconds() - p.paused_seconds).max(0) / 60)
    }

    fn running_or_err(&self) -> Result<TimeEntry> {
        self.running_timer()?.ok_or_else(|| Error::State(tr!("Es läuft kein Timer", "No timer is running").into()))
    }

    /// „Timer pausieren“: the time from `at` until it is resumed is not booked.
    pub fn pause_timer(&self, at: DateTime<Utc>) -> Result<TimeEntry> {
        let e = self.running_or_err()?;
        if self.pause_state(e.id)?.paused_since.is_some() {
            return Err(Error::State(tr!("Der Timer ist bereits pausiert", "The timer is already paused").into()));
        }
        // Not before the start or the end of the last pause (a clock that went back).
        let last_end = self.timer_pauses(e.id)?.last().and_then(|p| p.1);
        let at = at.max(e.start_time).max(last_end.unwrap_or(e.start_time));
        self.conn()
            .execute("INSERT INTO timer_pauses (entry_id, start_time) VALUES (?1, ?2)", params![e.id, ts(at)])?;
        Ok(e)
    }

    /// „Fortsetzen“: ends the open pause of the running timer.
    pub fn resume_timer(&self, at: DateTime<Utc>) -> Result<TimeEntry> {
        let e = self.running_or_err()?;
        let open: Option<(i64, String)> = self
            .conn()
            .query_row(
                "SELECT id, start_time FROM timer_pauses WHERE entry_id = ?1 AND end_time IS NULL",
                [e.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((id, since)) = open else {
            return Err(Error::State(tr!("Der Timer ist nicht pausiert", "The timer is not paused").into()));
        };
        let at = at.max(parse_ts(&since)?);
        self.conn().execute("UPDATE timer_pauses SET end_time = ?2 WHERE id = ?1", params![id, ts(at)])?;
        Ok(e)
    }

    /// Stops the running timer at `at` and books it: its pauses and the given `idle` stretches
    /// are left out, and a run over midnight becomes one booking per local day of `tz` (each
    /// rounded as set in Settings → Zeiterfassung). Returns the bookings, oldest first; when
    /// nothing is left to book, the stopped entry with 0 minutes (the caller discards it).
    pub fn stop_timer_in<Tz: TimeZone>(&self, at: DateTime<Utc>, idle: &[Gap], tz: &Tz) -> Result<Vec<TimeEntry>> {
        let running = self.running_or_err()?;
        if at < running.start_time {
            return Err(Error::State(tr!("Das Ende liegt vor dem Beginn", "The end is before the start").into()));
        }
        let mut gaps: Vec<Gap> =
            self.timer_pauses(running.id)?.into_iter().map(|(a, b)| (a, b.unwrap_or(at))).collect();
        gaps.extend_from_slice(idle);
        let rounding = self.load_settings().map(|s| s.time.rounding).unwrap_or_default();
        let segments: Vec<(Segment, i64)> = split_run(running.start_time, at, &gaps, tz)
            .into_iter()
            .map(|s| (s, rounding.apply(s.minutes)))
            .filter(|(_, m)| *m > 0)
            .collect();
        self.atomic(|| {
            self.conn().execute("DELETE FROM timer_pauses WHERE entry_id = ?1", [running.id])?;
            let Some(((first, minutes), rest)) = segments.split_first() else {
                // Nothing worked: the entry stays with 0 minutes for the caller to discard.
                self.conn().execute(
                    "UPDATE time_entries SET end_time = ?2, duration_minutes = 0, status_flag = 'draft' WHERE id = ?1",
                    params![running.id, ts(at)],
                )?;
                return Ok(vec![self.time_entry(running.id)?]);
            };
            self.conn().execute(
                "UPDATE time_entries SET start_time = ?2, end_time = ?3, duration_minutes = ?4, status_flag = 'draft'
                 WHERE id = ?1",
                params![running.id, ts(first.start), ts(first.end), minutes],
            )?;
            let entry = self.time_entry(running.id)?;
            self.feed_entry("entry_created", &entry, at)?;
            let mut out = vec![entry];
            for (s, minutes) in rest {
                out.push(self.insert_time_entry(&NewTimeEntry {
                    netzplan_id: running.netzplan_id,
                    vorgang_nr: running.vorgang_nr.clone(),
                    leistungsart: running.leistungsart.clone(),
                    start_time: s.start,
                    duration_minutes: *minutes,
                    description: running.description.clone(),
                    source: EntrySource::Timer,
                    page_id: running.page_id,
                })?);
            }
            debug_assert!(out.iter().all(|e| e.status_flag == StatusFlag::Draft));
            Ok(out)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, Timelike};

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(3600).unwrap()
    }
    /// 2026-09-01 at hh:mm local (CET, UTC+1).
    fn at(day: u32, h: u32, m: u32) -> DateTime<Utc> {
        cet().with_ymd_and_hms(2026, 9, day, h, m, 0).unwrap().with_timezone(&Utc)
    }

    #[test]
    fn a_run_within_one_day_is_one_segment_without_gaps() {
        let s = split_run(at(1, 9, 0), at(1, 11, 0), &[(at(1, 9, 30), at(1, 10, 0))], &cet());
        assert_eq!(s, vec![Segment { start: at(1, 9, 0), end: at(1, 11, 0), minutes: 90 }]);
        // Overlapping gaps (a pause during idle time) count once; gaps outside the run not at all.
        let s = split_run(
            at(1, 9, 0),
            at(1, 11, 0),
            &[(at(1, 9, 30), at(1, 10, 0)), (at(1, 9, 45), at(1, 10, 15)), (at(1, 7, 0), at(1, 8, 0))],
            &cet(),
        );
        assert_eq!(s[0].minutes, 75);
        // A gap at the end: the last worked instant is the end.
        let s = split_run(at(1, 9, 0), at(1, 11, 0), &[(at(1, 10, 30), at(1, 11, 0))], &cet());
        assert_eq!((s[0].end, s[0].minutes), (at(1, 10, 30), 90));
    }

    #[test]
    fn a_run_over_midnight_is_split_per_day() {
        let s = split_run(at(1, 22, 0), at(2, 1, 30), &[], &cet());
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].start, s[0].end, s[0].minutes), (at(1, 22, 0), at(2, 0, 0), 120));
        assert_eq!((s[1].start, s[1].end, s[1].minutes), (at(2, 0, 0), at(2, 1, 30), 90));
        // Paused over night: the second day starts when work went on.
        let s = split_run(at(1, 22, 0), at(2, 10, 0), &[(at(1, 23, 0), at(2, 8, 0))], &cet());
        assert_eq!(s.len(), 2);
        assert_eq!((s[0].end, s[0].minutes), (at(1, 23, 0), 60));
        assert_eq!((s[1].start, s[1].minutes), (at(2, 8, 0), 120));
        // A day with nothing worked is left out (three days, the middle one paused through).
        let s = split_run(at(1, 23, 0), at(3, 1, 0), &[(at(1, 23, 30), at(3, 0, 30))], &cet());
        assert_eq!(s.iter().map(|x| x.minutes).collect::<Vec<_>>(), vec![30, 30]);
        assert_eq!(s[1].start.with_timezone(&cet()).hour(), 0);
    }

    #[test]
    fn days_follow_the_local_zone_over_a_clock_change() {
        let berlin = chrono_tz_free_berlin();
        // 2026-10-25: clocks go back at 03:00; the day has 25 hours.
        let start = berlin.with_ymd_and_hms(2026, 10, 24, 23, 0, 0).unwrap().with_timezone(&Utc);
        let end = berlin.with_ymd_and_hms(2026, 10, 25, 23, 30, 0).unwrap().with_timezone(&Utc);
        let s = split_run(start, end, &[], &berlin);
        assert_eq!(s.iter().map(|x| x.minutes).collect::<Vec<_>>(), vec![60, 24 * 60 + 30]);
    }

    /// Europe/Berlin through `Local` is not available in tests; a zone with the 2026 change.
    fn chrono_tz_free_berlin() -> BerlinLike {
        BerlinLike
    }

    #[derive(Clone, Copy)]
    struct BerlinLike;
    impl BerlinLike {
        fn offset_at_utc(utc: chrono::NaiveDateTime) -> FixedOffset {
            // CEST until 2026-10-25 01:00 UTC, CET after.
            let change = chrono::NaiveDate::from_ymd_opt(2026, 10, 25).unwrap().and_hms_opt(1, 0, 0).unwrap();
            FixedOffset::east_opt(if utc < change { 7200 } else { 3600 }).unwrap()
        }
    }
    impl TimeZone for BerlinLike {
        type Offset = FixedOffset;
        fn from_offset(_: &FixedOffset) -> Self {
            BerlinLike
        }
        fn offset_from_local_date(&self, _: &chrono::NaiveDate) -> chrono::LocalResult<FixedOffset> {
            chrono::LocalResult::None
        }
        fn offset_from_local_datetime(&self, local: &chrono::NaiveDateTime) -> chrono::LocalResult<FixedOffset> {
            let summer = FixedOffset::east_opt(7200).unwrap();
            let winter = FixedOffset::east_opt(3600).unwrap();
            let a = Self::offset_at_utc(*local - chrono::Duration::hours(2)) == summer;
            let b = Self::offset_at_utc(*local - chrono::Duration::hours(1)) == winter;
            match (a, b) {
                (true, true) => chrono::LocalResult::Ambiguous(summer, winter),
                (true, false) => chrono::LocalResult::Single(summer),
                (false, true) => chrono::LocalResult::Single(winter),
                (false, false) => chrono::LocalResult::None,
            }
        }
        fn offset_from_utc_date(&self, _: &chrono::NaiveDate) -> FixedOffset {
            FixedOffset::east_opt(3600).unwrap()
        }
        fn offset_from_utc_datetime(&self, utc: &chrono::NaiveDateTime) -> FixedOffset {
            Self::offset_at_utc(*utc)
        }
    }

    fn seeded() -> (Database, i64) {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration", 40.0).unwrap();
        (db, np.id)
    }

    #[test]
    fn pauses_are_not_booked_and_overnight_runs_become_one_booking_per_day() {
        let (db, np) = seeded();
        db.start_timer(np, Some("1020"), Some("DEV"), "Nachtschicht", at(1, 21, 0)).unwrap();
        db.pause_timer(at(1, 22, 0)).unwrap();
        assert!(db.pause_timer(at(1, 22, 5)).is_err(), "already paused");
        let e = db.running_timer().unwrap().unwrap();
        assert_eq!(db.pause_state(e.id).unwrap().paused_since, Some(at(1, 22, 0)));
        assert_eq!(db.timer_worked_minutes(&e, at(1, 23, 0)).unwrap(), 60, "the clock stands still");
        db.resume_timer(at(1, 22, 30)).unwrap();
        assert!(db.resume_timer(at(1, 22, 40)).is_err(), "not paused");
        assert_eq!(db.pause_state(e.id).unwrap(), PauseState { paused_since: None, paused_seconds: 1800 });
        assert_eq!(db.timer_worked_minutes(&e, at(1, 23, 30)).unwrap(), 120);
        // Idle for 20 minutes after midnight; stopped at 02:00.
        let out = db.stop_timer_in(at(2, 2, 0), &[(at(2, 0, 30), at(2, 0, 50))], &cet()).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].id, out[0].start_time, out[0].duration_minutes), (e.id, at(1, 21, 0), Some(150)));
        assert_eq!((out[1].start_time, out[1].duration_minutes), (at(2, 0, 0), Some(100)));
        assert_eq!((out[1].vorgang_nr.as_deref(), out[1].leistungsart.as_deref()), (Some("1020"), Some("DEV")));
        assert_eq!(out[1].source, EntrySource::Timer);
        assert!(db.running_timer().unwrap().is_none());
        assert!(db.timer_pauses(e.id).unwrap().is_empty(), "pauses go with the stop");
    }

    #[test]
    fn stopping_while_paused_books_until_the_pause() {
        let (db, np) = seeded();
        db.start_timer(np, None, None, "", at(1, 9, 0)).unwrap();
        db.pause_timer(at(1, 9, 45)).unwrap();
        let out = db.stop_timer_in(at(1, 12, 0), &[], &cet()).unwrap();
        assert_eq!((out.len(), out[0].duration_minutes, out[0].end_time), (1, Some(45), Some(at(1, 9, 45))));
        // Paused right away: nothing to book, the entry stays with 0 minutes for the caller.
        db.start_timer(np, None, None, "", at(1, 13, 0)).unwrap();
        db.pause_timer(at(1, 13, 0)).unwrap();
        let out = db.stop_timer_in(at(1, 14, 0), &[], &cet()).unwrap();
        assert_eq!((out.len(), out[0].duration_minutes), (1, Some(0)));
    }
}
