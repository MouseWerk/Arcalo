//! Time summaries for status reports: booked hours per Netzplan/Vorgang with
//! what was done (entry descriptions), plus totals per day.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::db::{Database, EntryFilter};
use crate::error::{Error, Result};
use crate::model::{StatusFlag, Vorgang};

/// Longest range a summary may cover (one year), so a typo cannot scan everything.
const MAX_DAYS: i64 = 366;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TimeSummary {
    /// First day (local), inclusive.
    pub from: NaiveDate,
    /// Last day (local), inclusive.
    pub to: NaiveDate,
    pub total_hours: f64,
    /// Every day of the range, also the ones without bookings.
    pub days: Vec<DayTotal>,
    /// Booked WBS elements, most hours first.
    pub items: Vec<SummaryItem>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DayTotal {
    pub date: NaiveDate,
    pub hours: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SummaryItem {
    /// `NP-8801/1020`, or `NP-8801` for entries without Vorgang.
    pub label: String,
    pub project_code: String,
    pub netzplan_nr: String,
    pub vorgang_nr: Option<String>,
    /// Description of the Vorgang, else of the Netzplan.
    pub title: String,
    pub hours: f64,
    /// Distinct entry descriptions in booking order (empty ones left out).
    pub descriptions: Vec<String>,
}

/// First instant of local day `d`. `resolve` maps a local time to UTC (earliest of an
/// ambiguous time, `None` inside a gap). Where midnight is skipped by a DST change
/// (e.g. America/Santiago, Asia/Beirut), the day starts at the end of the gap, one hour later.
fn day_start(d: NaiveDate, resolve: impl Fn(&NaiveDateTime) -> Option<DateTime<Utc>>) -> Result<DateTime<Utc>> {
    let midnight = d.and_time(NaiveTime::MIN);
    resolve(&midnight)
        .or_else(|| resolve(&(midnight + Duration::hours(1))))
        .ok_or_else(|| Error::State(format!("Ortszeit {midnight} existiert nicht")))
}

/// Summarizes the finished time entries whose start falls on the local days `from..=to`.
/// Running timers are not counted.
pub fn time_summary<Tz: TimeZone>(db: &Database, from: NaiveDate, to: NaiveDate, offset: &Tz) -> Result<TimeSummary> {
    if to < from {
        return Err(Error::State("'to' liegt vor 'from'".into()));
    }
    if (to - from).num_days() >= MAX_DAYS {
        return Err(Error::State(format!("Zeitraum länger als {MAX_DAYS} Tage")));
    }
    let start_of =
        |d: NaiveDate| day_start(d, |dt| offset.from_local_datetime(dt).earliest().map(|t| t.with_timezone(&Utc)));
    let end_day = to.succ_opt().ok_or_else(|| Error::State("date out of range".into()))?;
    let rows = db.list_time_entries(&EntryFilter {
        from: Some(start_of(from)?),
        to: Some(start_of(end_day)?),
        ..Default::default()
    })?;

    let mut days: BTreeMap<NaiveDate, i64> = from.iter_days().take_while(|d| *d <= to).map(|d| (d, 0)).collect();
    // Keyed by (netzplan_id, lower-cased Vorgang) so spelling variants land together.
    let mut items: Vec<(i64, Option<String>, i64, SummaryItem)> = vec![];
    // Netzplan description and Vorgänge, loaded once per Netzplan.
    let mut wbs: HashMap<i64, (String, Vec<Vorgang>)> = HashMap::new();

    for row in rows {
        let e = &row.entry;
        let Some(minutes) = e.duration_minutes.filter(|_| e.status_flag != StatusFlag::Running) else { continue };
        let day = e.start_time.with_timezone(offset).date_naive();
        *days.entry(day).or_default() += minutes;

        let key_v = e.vorgang_nr.as_ref().map(|v| v.to_lowercase());
        let idx = match items.iter().position(|(np, v, _, _)| *np == e.netzplan_id && *v == key_v) {
            Some(i) => i,
            None => {
                let (np_title, vs) = match wbs.entry(e.netzplan_id) {
                    Entry::Occupied(o) => o.into_mut(),
                    Entry::Vacant(v) => {
                        v.insert((db.netzplan_by_id(e.netzplan_id)?.description, db.list_vorgaenge(e.netzplan_id)?))
                    }
                };
                let v_title = e.vorgang_nr.as_ref().and_then(|v| {
                    vs.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)).map(|x| x.description.clone())
                });
                let label = match &e.vorgang_nr {
                    Some(v) => format!("{}/{v}", row.netzplan_nr),
                    None => row.netzplan_nr.clone(),
                };
                items.push((
                    e.netzplan_id,
                    key_v,
                    0,
                    SummaryItem {
                        label,
                        project_code: row.project_code.clone(),
                        netzplan_nr: row.netzplan_nr.clone(),
                        vorgang_nr: e.vorgang_nr.clone(),
                        title: v_title.unwrap_or_else(|| np_title.clone()),
                        hours: 0.0,
                        descriptions: vec![],
                    },
                ));
                items.len() - 1
            }
        };
        let (_, _, total, item) = &mut items[idx];
        *total += minutes;
        let d = e.description.trim();
        if !d.is_empty() && !item.descriptions.iter().any(|x| x.eq_ignore_ascii_case(d)) {
            item.descriptions.push(d.to_owned());
        }
    }

    let hours = |m: i64| m as f64 / 60.0;
    let mut items: Vec<SummaryItem> = items
        .into_iter()
        .map(|(_, _, minutes, mut item)| {
            item.hours = hours(minutes);
            item
        })
        .collect();
    items.sort_by(|a, b| b.hours.total_cmp(&a.hours).then_with(|| a.label.cmp(&b.label)));
    let days: Vec<DayTotal> = days.into_iter().map(|(date, m)| DayTotal { date, hours: hours(m) }).collect();
    Ok(TimeSummary { from, to, total_hours: days.iter().map(|d| d.hours).sum(), days, items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};
    use chrono::FixedOffset;

    fn cet() -> FixedOffset {
        FixedOffset::east_opt(2 * 3600).unwrap()
    }

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, d).unwrap()
    }

    fn book(db: &Database, np: i64, v: Option<&str>, local: (u32, u32), minutes: i64, desc: &str) {
        let start = cet().with_ymd_and_hms(2026, 9, local.0, local.1, 0, 0).unwrap().with_timezone(&Utc);
        db.insert_time_entry(&NewTimeEntry {
            netzplan_id: np,
            vorgang_nr: v.map(str::to_owned),
            leistungsart: None,
            start_time: start,
            duration_minutes: minutes,
            description: desc.into(),
            source: EntrySource::Manual,
            page_id: None,
        })
        .unwrap();
    }

    #[test]
    fn sums_per_wbs_element_and_day() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 40.0).unwrap();
        db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 16.0).unwrap();
        let np2 = db.create_netzplan(p.id, "NP-8802", "NP-8802-2010", "Schulung", 8.0).unwrap();

        book(&db, np.id, Some("1020"), (21, 9), 90, "Schnittstelle getestet");
        book(&db, np.id, Some("1020"), (22, 9), 60, "schnittstelle getestet");
        book(&db, np.id, Some("1020"), (22, 14), 30, "Review");
        book(&db, np2.id, None, (23, 0), 45, "");
        // Local midnight on the 21st is the 20th in UTC: still counts for the 21st.
        book(&db, np2.id, None, (21, 0), 15, "Agenda");
        // Outside the range.
        book(&db, np.id, Some("1020"), (28, 9), 60, "später");

        let s = time_summary(&db, day(21), day(27), &cet()).unwrap();
        assert_eq!(s.days.len(), 7);
        assert_eq!((s.days[0].date, s.days[0].hours), (day(21), 1.75));
        assert_eq!(s.days[1].hours, 1.5);
        assert_eq!(s.days[2].hours, 0.75);
        assert_eq!(s.days[6].hours, 0.0);
        assert_eq!(s.total_hours, 4.0);

        assert_eq!(s.items.len(), 2);
        let a = &s.items[0];
        assert_eq!((a.label.as_str(), a.title.as_str(), a.hours), ("NP-8801/1020", "Systemintegration", 3.0));
        assert_eq!(a.descriptions, ["Schnittstelle getestet", "Review"], "deduplicated, case-insensitive");
        let b = &s.items[1];
        assert_eq!((b.label.as_str(), b.title.as_str(), b.hours), ("NP-8802", "Schulung", 1.0));
        assert_eq!(b.descriptions, ["Agenda"]);
    }

    #[test]
    fn skips_running_timers_and_rejects_bad_ranges() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 40.0).unwrap();
        db.start_timer(np.id, None, None, "läuft", Utc::now()).unwrap();
        let today = Utc::now().with_timezone(&cet()).date_naive();
        let s = time_summary(&db, today, today, &cet()).unwrap();
        assert!(s.items.is_empty());
        assert_eq!(s.total_hours, 0.0);

        assert!(time_summary(&db, day(22), day(21), &cet()).is_err());
        assert!(time_summary(&db, day(1), NaiveDate::from_ymd_opt(2027, 12, 1).unwrap(), &cet()).is_err());
    }

    #[test]
    fn day_start_skips_a_missing_midnight() {
        let d = day(6);
        let utc = |dt: &NaiveDateTime| Some(dt.and_utc());
        assert_eq!(day_start(d, utc).unwrap(), Utc.with_ymd_and_hms(2026, 9, 6, 0, 0, 0).unwrap());
        // DST starts at midnight: 00:00–00:59 do not exist, the day starts at 01:00 (= 04:00 UTC at -3h).
        let gap = |dt: &NaiveDateTime| {
            (dt.time() >= NaiveTime::from_hms_opt(1, 0, 0).unwrap()).then(|| dt.and_utc() + Duration::hours(3))
        };
        assert_eq!(day_start(d, gap).unwrap(), Utc.with_ymd_and_hms(2026, 9, 6, 4, 0, 0).unwrap());
        let err = day_start(d, |_| None).unwrap_err().to_string();
        assert!(err.contains("existiert nicht"), "{err}");
    }
}
