//! Month overview for the daily-note calendar: per local day whether a daily note
//! exists, the booked minutes, the day's target and the open tasks due that day.

use crate::trf;
use std::collections::HashMap;

use chrono::{NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::report;
use crate::settings::Settings;

/// Longest range an overview may cover (a calendar shows at most six weeks).
const MAX_DAYS: i64 = 62;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayOverview {
    pub date: NaiveDate,
    /// The daily note of that day, if one exists (and is not in the trash).
    pub note_id: Option<i64>,
    pub has_note: bool,
    /// Finished bookings whose start falls on that local day.
    pub booked_minutes: i64,
    /// The day's target as every view counts missing time ([`crate::worktime::DayTargets`]):
    /// none on a public holiday, an absence day or a day without a weekday target.
    pub target_minutes: i64,
    /// Open tasks due that day (templates excluded).
    pub open_tasks: i64,
}

/// Every local day `from..=to` with its daily note, booked minutes, target and open tasks due.
pub fn daily_overview<Tz: TimeZone>(
    db: &Database,
    settings: &Settings,
    from: NaiveDate,
    to: NaiveDate,
    offset: &Tz,
) -> Result<Vec<DayOverview>> {
    if to < from {
        return Err(Error::State(crate::tr!("Das Ende liegt vor dem Anfang", "The end lies before the start").into()));
    }
    if (to - from).num_days() >= MAX_DAYS {
        return Err(Error::State(trf!("Zeitraum länger als {MAX_DAYS} Tage", "Period longer than {MAX_DAYS} days")));
    }
    let key = |d: NaiveDate| d.format("%Y-%m-%d").to_string();

    let mut notes: HashMap<String, i64> = HashMap::new();
    {
        let mut st = db.conn().prepare_cached(
            "SELECT daily_date, id FROM pages
             WHERE daily_date BETWEEN ?1 AND ?2 AND deleted_at IS NULL",
        )?;
        let rows = st.query_map([key(from), key(to)], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
        for row in rows {
            let (d, id) = row?;
            notes.entry(d).or_insert(id);
        }
    }

    let tasks = db.open_tasks_due_per_day(&key(from), &key(to))?;

    let targets = crate::worktime::DayTargets::load(db, settings, from, to)?;
    let summary = report::time_summary(db, from, to, offset)?;
    Ok(summary
        .days
        .into_iter()
        .map(|d| {
            let k = key(d.date);
            let note_id = notes.get(&k).copied();
            DayOverview {
                date: d.date,
                note_id,
                has_note: note_id.is_some(),
                booked_minutes: (d.hours * 60.0).round() as i64,
                target_minutes: targets.get(d.date),
                open_tasks: tasks.get(&k).copied().unwrap_or(0),
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};
    use chrono::{FixedOffset, Utc};

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, d).unwrap()
    }

    #[test]
    fn notes_minutes_and_due_tasks_per_day() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 40.0).unwrap();
        let book = |d: u32, h: u32, minutes: i64| {
            let start = cet().with_ymd_and_hms(2026, 9, d, h, 0, 0).unwrap().with_timezone(&Utc);
            db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: None,
                leistungsart: None,
                start_time: start,
                duration_minutes: minutes,
                description: String::new(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        };
        book(21, 0, 30); // local midnight = 20th in UTC, counts for the 21st
        book(21, 9, 420);
        book(23, 9, 60);
        db.start_timer(np.id, None, None, "läuft", cet().with_ymd_and_hms(2026, 9, 22, 8, 0, 0).unwrap().into())
            .unwrap();

        let note = db.daily_note(day(22)).unwrap();
        let trashed = db.daily_note(day(23)).unwrap();
        db.trash_page(trashed.id).unwrap();

        let t = db.create_page(None, "Aufgaben", None).unwrap();
        db.save_page_content(
            t.id,
            "- [ ] A due:2026-09-22\n- [ ] B due:2026-09-22\n- [x] C due:2026-09-22\n- [ ] D due:2026-09-20\n- [ ] E due:2026-09-23",
        )
        .unwrap();

        let o = daily_overview(&db, &Settings::default(), day(21), day(23), &cet()).unwrap();
        assert_eq!(o.iter().map(|d| d.date).collect::<Vec<_>>(), [day(21), day(22), day(23)]);
        assert_eq!((o[0].has_note, o[0].booked_minutes, o[0].open_tasks), (false, 450, 0));
        assert_eq!(
            (o[1].note_id, o[1].booked_minutes, o[1].open_tasks),
            (Some(note.id), 0, 2),
            "running timer not counted"
        );
        assert!(o[1].has_note);
        assert_eq!((o[2].has_note, o[2].booked_minutes, o[2].open_tasks), (false, 60, 1), "trashed note ignored");

        assert!(daily_overview(&db, &Settings::default(), day(22), day(21), &cet()).is_err());
        assert!(
            daily_overview(&db, &Settings::default(), day(1), NaiveDate::from_ymd_opt(2026, 12, 1).unwrap(), &cet())
                .is_err()
        );
    }

    #[test]
    fn the_target_of_each_day_follows_holidays_absences_and_weekday_targets() {
        let db = Database::open_in_memory().unwrap();
        let mut s = Settings::default();
        s.time.balance.state = "BY".into();
        // Monday to Thursday 8 h, Friday 6 h, no weekend.
        s.time.balance.weekday_hours = vec![8.0, 8.0, 8.0, 8.0, 6.0, 0.0, 0.0];
        let d = |m: u32, day: u32| NaiveDate::from_ymd_opt(2026, m, day).unwrap();
        let vacation = crate::worktime::Absence {
            date: d(10, 28),
            kind: crate::worktime::AbsenceKind::Vacation,
            half: false,
            note: String::new(),
        };
        db.absence_put(&vacation).unwrap();
        db.absence_put(&crate::worktime::Absence { date: d(10, 29), half: true, ..vacation }).unwrap();
        // Mon 26 Oct to Mon 2 Nov 2026; Sun 1 Nov is All Saints' Day in Bavaria, Mon 2 Nov is not.
        let o = daily_overview(&db, &s, d(10, 26), d(11, 2), &cet()).unwrap();
        let targets: Vec<i64> = o.iter().map(|x| x.target_minutes).collect();
        assert_eq!(targets, [480, 480, 0, 240, 360, 0, 0, 480]);
    }
}
