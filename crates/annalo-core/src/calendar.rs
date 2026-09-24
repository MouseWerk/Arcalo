//! Month overview for the daily-note calendar: per local day whether a daily note
//! exists, the booked minutes and the open tasks due that day.

use std::collections::HashMap;

use chrono::{NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::report;
use crate::tasks::{TaskFilter, TaskStatus};

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
    /// Open tasks due that day (templates excluded).
    pub open_tasks: i64,
}

/// Every local day `from..=to` with its daily note, booked minutes and open tasks due.
pub fn daily_overview<Tz: TimeZone>(
    db: &Database,
    from: NaiveDate,
    to: NaiveDate,
    offset: &Tz,
) -> Result<Vec<DayOverview>> {
    if to < from {
        return Err(Error::State("'to' liegt vor 'from'".into()));
    }
    if (to - from).num_days() >= MAX_DAYS {
        return Err(Error::State(format!("Zeitraum länger als {MAX_DAYS} Tage")));
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

    let mut tasks: HashMap<String, i64> = HashMap::new();
    let open =
        db.list_tasks(&TaskFilter { status: TaskStatus::Open, due_before: Some(key(to)), ..Default::default() })?;
    let first = key(from);
    for due in open.into_iter().filter_map(|t| t.due).filter(|d| *d >= first) {
        *tasks.entry(due).or_default() += 1;
    }

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
            "- [ ] A 📅 2026-09-22\n- [ ] B due:2026-09-22\n- [x] C 📅 2026-09-22\n- [ ] D 📅 2026-09-20\n- [ ] E 📅 2026-09-23",
        )
        .unwrap();

        let o = daily_overview(&db, day(21), day(23), &cet()).unwrap();
        assert_eq!(o.iter().map(|d| d.date).collect::<Vec<_>>(), [day(21), day(22), day(23)]);
        assert_eq!((o[0].has_note, o[0].booked_minutes, o[0].open_tasks), (false, 450, 0));
        assert_eq!(
            (o[1].note_id, o[1].booked_minutes, o[1].open_tasks),
            (Some(note.id), 0, 2),
            "running timer not counted"
        );
        assert!(o[1].has_note);
        assert_eq!((o[2].has_note, o[2].booked_minutes, o[2].open_tasks), (false, 60, 1), "trashed note ignored");

        assert!(daily_overview(&db, day(22), day(21), &cet()).is_err());
        assert!(daily_overview(&db, day(1), NaiveDate::from_ymd_opt(2026, 12, 1).unwrap(), &cet()).is_err());
    }
}
