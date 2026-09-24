//! High-level time tracking: slash-command logging and budget / ETC alerts.

use chrono::{DateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::db::{BookedMinutes, Database};
use crate::error::{Error, Result};
use crate::model::{EntrySource, Netzplan, NewTimeEntry, TimeEntry, Vorgang};
use crate::netzplan::{self, Schedule};
use crate::zeit;

/// Default start time for entries booked on a past day without `@hh:mm`.
const DEFAULT_START: NaiveTime = match NaiveTime::from_hms_opt(8, 0, 0) {
    Some(t) => t,
    None => unreachable!(),
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogOutcome {
    pub entry: TimeEntry,
    /// Budget alerts for the Netzplan / Vorgang the entry was booked on.
    pub alerts: Vec<BudgetStatus>,
    /// Canonical reference the entry was booked on (`NP-8801/1020`).
    #[serde(default)]
    pub reference: String,
}

/// Where a `/zeit` line was typed: the page it books from and that page's linked reference.
#[derive(Debug, Clone, Copy, Default)]
pub struct SlashContext<'a> {
    /// Used when the line has no reference (`/zeit 1.5h Abstimmung`).
    pub default_ref: Option<&'a str>,
    pub page_id: Option<i64>,
}

/// Parses a `/zeit` line, validates it against the WBS and books it.
///
/// `offset` is the user's time zone, used to interpret dates and `@hh:mm`.
pub fn log_slash_command<Tz: TimeZone>(
    db: &Database,
    line: &str,
    now: DateTime<Utc>,
    offset: &Tz,
    thresholds: &Thresholds,
) -> Result<LogOutcome> {
    log_slash_command_in(db, line, now, offset, thresholds, SlashContext::default())
}

/// [`log_slash_command`] for a line typed on a page.
pub fn log_slash_command_in<Tz: TimeZone>(
    db: &Database,
    line: &str,
    now: DateTime<Utc>,
    offset: &Tz,
    thresholds: &Thresholds,
    ctx: SlashContext,
) -> Result<LogOutcome> {
    let local_now = now.with_timezone(offset);
    let mut cmd = zeit::parse_with_default(line, local_now.date_naive(), ctx.default_ref)?;
    // Settings → Zeiterfassung: rounding, minimum booking and default Leistungsart.
    let time = db.load_settings().map(|s| s.time).unwrap_or_default();
    cmd.duration_minutes = time.rounding.apply(cmd.duration_minutes);

    let np = db.netzplan_by_ref(&cmd.netzplan_ref)?;
    let mut vorgang_nr = cmd.vorgang_nr.clone();
    if let Some(v) = &cmd.vorgang_nr {
        let vorgaenge = db.list_vorgaenge(np.id)?;
        // A Netzplan without modelled Vorgänge accepts free activity codes.
        if !vorgaenge.is_empty() {
            // Store the canonical spelling so budgets and exports match.
            let Some(found) = vorgaenge.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) else {
                return Err(Error::not_found("vorgang", format!("{}/{v}", np.netzplan_nr)));
            };
            vorgang_nr = Some(found.vorgang_nr.clone());
        }
    }
    if cmd.leistungsart.is_none()
        && let Some(la) = time.default_la_for(&np.netzplan_nr)
        && db.leistungsart_exists(la)?
    {
        cmd.leistungsart = Some(la.to_owned());
    }
    if let Some(la) = &cmd.leistungsart
        && !db.leistungsart_exists(la)?
    {
        return Err(Error::not_found("leistungsart", la.clone()));
    }

    let duration = chrono::Duration::minutes(cmd.duration_minutes);
    let today = local_now.date_naive();
    // Today without a start time: the work just ended. Shortly after midnight it still counts
    // for today (the day the user books on), so the start is not moved before midnight.
    let mut clamped = false;
    let start = match (cmd.date, cmd.start) {
        (_, Some(t)) => local_to_utc(offset, cmd.date.resolve(today).and_time(t))?,
        (d, None) if d.resolve(today) == today => {
            let midnight = local_to_utc(offset, today.and_time(NaiveTime::MIN))?;
            clamped = now - duration < midnight;
            (now - duration).max(midnight)
        }
        (d, None) => local_to_utc(offset, d.resolve(today).and_time(DEFAULT_START))?,
    };
    if !clamped && start + duration > now + chrono::Duration::minutes(1) {
        return Err(Error::State("Buchungen dürfen nicht in der Zukunft enden".into()));
    }

    let entry = db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np.id,
        vorgang_nr: vorgang_nr.clone(),
        leistungsart: cmd.leistungsart,
        start_time: start,
        duration_minutes: cmd.duration_minutes,
        description: cmd.description,
        source: EntrySource::Slash,
        page_id: ctx.page_id,
    })?;

    let alerts = alerts_for(db, np.id, vorgang_nr.as_deref(), thresholds)?;
    let reference = match &vorgang_nr {
        Some(v) => format!("{}/{v}", np.netzplan_nr),
        None => np.netzplan_nr.clone(),
    };
    Ok(LogOutcome { entry, alerts, reference })
}

/// Resolves a local wall-clock time in the given zone (per date, so DST is honoured). A time
/// that occurs twice (clocks go back) is the first one; a time the clocks skip (spring
/// forward, 02:30 does not exist) is taken an hour later, as the clock showed it then.
fn local_to_utc<Tz: TimeZone>(offset: &Tz, dt: chrono::NaiveDateTime) -> Result<DateTime<Utc>> {
    offset
        .from_local_datetime(&dt)
        .earliest()
        .or_else(|| offset.from_local_datetime(&(dt + chrono::Duration::hours(1))).earliest())
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| {
            Error::State(format!("Die Uhrzeit {} gibt es wegen der Zeitumstellung nicht", dt.format("%d.%m.%Y %H:%M")))
        })
}

// ------------------------------------------------------------------- budgets

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Thresholds {
    /// Consumed share of the plan that raises a warning (e.g. 0.75).
    pub warning: f64,
    /// Consumed share of the plan that raises a critical alert (e.g. 0.9).
    pub critical: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds { warning: 0.75, critical: 0.9 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlertLevel {
    Ok,
    Warning,
    /// Consumption above the critical threshold, or the forecast (EAC) exceeds the plan.
    Critical,
    /// More hours booked than planned.
    Exceeded,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetStatus {
    /// `NP-8801` for a Netzplan, `NP-8801/1020` for a Vorgang.
    pub label: String,
    pub netzplan_id: i64,
    pub vorgang_nr: Option<String>,
    pub planned_hours: f64,
    pub booked_hours: f64,
    /// Estimate to complete.
    pub etc_hours: f64,
    /// Estimate at completion = booked + ETC.
    pub eac_hours: f64,
    /// booked / planned (0 when nothing is planned).
    pub consumed: f64,
    pub level: AlertLevel,
}

fn classify(planned: f64, booked: f64, eac: f64, t: &Thresholds) -> (f64, AlertLevel) {
    if planned <= 0.0 {
        let level = if booked > 0.0 { AlertLevel::Exceeded } else { AlertLevel::Ok };
        return (0.0, level);
    }
    let consumed = booked / planned;
    let eps = 1e-9;
    let level = if booked > planned + eps {
        AlertLevel::Exceeded
    } else if consumed >= t.critical || eac > planned + eps {
        AlertLevel::Critical
    } else if consumed >= t.warning {
        AlertLevel::Warning
    } else {
        AlertLevel::Ok
    };
    (consumed, level)
}

/// Budget status of a Netzplan followed by each of its Vorgänge.
pub fn budget_status(db: &Database, netzplan_id: i64, t: &Thresholds) -> Result<Vec<BudgetStatus>> {
    let np = db.netzplan_by_id(netzplan_id)?;
    let vorgaenge = db.list_vorgaenge(netzplan_id)?;
    budget_rows(&np, &vorgaenge, |v| db.booked_hours(netzplan_id, v), t)
}

/// The rows of [`budget_status`] from the Netzplan, its Vorgänge and the booked hours
/// (`booked(None)` for the whole Netzplan, `booked(Some(nr))` for one Vorgang).
fn budget_rows(
    np: &Netzplan,
    vorgaenge: &[Vorgang],
    booked: impl Fn(Option<&str>) -> Result<f64>,
    t: &Thresholds,
) -> Result<Vec<BudgetStatus>> {
    let mut out = Vec::with_capacity(vorgaenge.len() + 1);
    let mut etc_sum = 0.0;
    for v in vorgaenge {
        let booked = booked(Some(&v.vorgang_nr))?;
        let etc = v.remaining_hours.unwrap_or((v.planned_hours - booked).max(0.0)).max(0.0);
        etc_sum += etc;
        let eac = booked + etc;
        let (consumed, level) = classify(v.planned_hours, booked, eac, t);
        out.push(BudgetStatus {
            label: format!("{}/{}", np.netzplan_nr, v.vorgang_nr),
            netzplan_id: np.id,
            vorgang_nr: Some(v.vorgang_nr.clone()),
            planned_hours: v.planned_hours,
            booked_hours: booked,
            etc_hours: etc,
            eac_hours: eac,
            consumed,
            level,
        });
    }

    let booked = booked(None)?;
    let etc = if vorgaenge.is_empty() { (np.planned_hours - booked).max(0.0) } else { etc_sum };
    let eac = booked + etc;
    let (consumed, level) = classify(np.planned_hours, booked, eac, t);
    out.insert(
        0,
        BudgetStatus {
            label: np.netzplan_nr.clone(),
            netzplan_id: np.id,
            vorgang_nr: None,
            planned_hours: np.planned_hours,
            booked_hours: booked,
            etc_hours: etc,
            eac_hours: eac,
            consumed,
            level,
        },
    );
    Ok(out)
}

/// Budget and schedule of one Netzplan (the Projekte view shows both).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NetzplanOverview {
    pub netzplan_id: i64,
    /// As [`budget_status`]: the Netzplan, then its Vorgänge.
    pub budget: Vec<BudgetStatus>,
    /// `None` when the Vorgänge cannot be scheduled (a cycle).
    pub schedule: Option<Schedule>,
}

/// [`budget_status`] (and, with `schedules`, the schedule) of every Netzplan, ordered by
/// Netzplan number: a handful of queries in all instead of several per Netzplan.
pub fn netzplan_overview(db: &Database, t: &Thresholds, schedules: bool) -> Result<Vec<NetzplanOverview>> {
    let booked = db.booked_minutes_all()?;
    let mut vorgaenge = db.vorgaenge_by_netzplan()?;
    let none = BookedMinutes::default();
    db.list_netzplaene(None)?
        .into_iter()
        .map(|np| {
            let list = vorgaenge.remove(&np.id).unwrap_or_default();
            let b = booked.get(&np.id).unwrap_or(&none);
            let hours = |v: Option<&str>| Ok(v.map_or(b.total, |nr| b.vorgang(nr)) as f64 / 60.0);
            Ok(NetzplanOverview {
                netzplan_id: np.id,
                budget: budget_rows(&np, &list, hours, t)?,
                schedule: if schedules { netzplan::schedule(&list).ok() } else { None },
            })
        })
        .collect()
}

/// The budget rows of every Netzplan, see [`netzplan_overview`].
pub fn all_budgets(db: &Database, t: &Thresholds) -> Result<Vec<BudgetStatus>> {
    Ok(netzplan_overview(db, t, false)?.into_iter().flat_map(|o| o.budget).collect())
}

/// The most critical of `budgets` that is not OK: highest level, then most consumed.
pub fn worst_budget(budgets: &[BudgetStatus]) -> Option<&BudgetStatus> {
    budgets
        .iter()
        .filter(|b| b.level != AlertLevel::Ok)
        .max_by(|a, b| a.level.cmp(&b.level).then(a.consumed.total_cmp(&b.consumed)).then(b.label.cmp(&a.label)))
}

/// Non-OK budget states relevant to a booking on `netzplan_id` / `vorgang_nr`.
pub fn alerts_for(
    db: &Database,
    netzplan_id: i64,
    vorgang_nr: Option<&str>,
    t: &Thresholds,
) -> Result<Vec<BudgetStatus>> {
    Ok(budget_status(db, netzplan_id, t)?
        .into_iter()
        .filter(|s| {
            s.vorgang_nr.is_none()
                || matches!((s.vorgang_nr.as_deref(), vorgang_nr), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
        })
        .filter(|s| s.level != AlertLevel::Ok)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn setup() -> (Database, i64) {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
        db.create_vorgang(np.id, "1010", "Konzept", 2.0, 4.0).unwrap();
        db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 6.0).unwrap();
        (db, np.id)
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 23, 15, 0, 0).unwrap()
    }

    fn cet() -> chrono::FixedOffset {
        chrono::FixedOffset::east_opt(2 * 3600).unwrap()
    }

    #[test]
    fn stores_canonical_vorgang_spelling_and_counts_budget() {
        let (db, np) = setup();
        let t = Thresholds::default();
        let v = db.list_vorgaenge(np).unwrap()[0].vorgang_nr.clone();
        let line = format!("/zeit NP-8801/{} 1h x", v.to_lowercase());
        let out = log_slash_command(&db, &line, now(), &cet(), &t).unwrap();
        assert_eq!(out.entry.vorgang_nr.as_deref(), Some(v.as_str()));
        assert!((db.booked_hours(np, Some(&v.to_lowercase())).unwrap() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn todays_date_without_time_ends_now() {
        let (db, _) = setup();
        // 17:00 local; 2 h ending now is fine even when the date is spelled out.
        let out =
            log_slash_command(&db, "/zeit NP-8801/1020 2h x @23.09.", now(), &cet(), &Thresholds::default()).unwrap();
        assert_eq!(out.entry.start_time, now() - chrono::Duration::hours(2));
    }

    #[test]
    fn logs_canonical_command_ending_now() {
        let (db, _) = setup();
        let out = log_slash_command(
            &db,
            "/zeit NP-8801/1020 2.5h 'Systemintegration'",
            now(),
            &cet(),
            &Thresholds::default(),
        )
        .unwrap();
        assert_eq!(out.entry.duration_minutes, Some(150));
        assert_eq!(out.entry.end_time, Some(now()));
        assert_eq!(out.entry.source, EntrySource::Slash);
        assert!(out.alerts.is_empty(), "2.5h of 6h is fine: {:?}", out.alerts);
    }

    #[test]
    fn rounding_minimum_and_default_leistungsart_apply_to_bookings_and_timer() {
        let (db, np) = setup();
        let mut s = db.load_settings().unwrap();
        s.time.rounding =
            crate::prefs::Rounding { step_minutes: 15, mode: crate::prefs::RoundMode::Up, min_minutes: 30 };
        s.time.default_leistungsart.insert("np-8801".into(), "DEV".into());
        db.save_settings(&s).unwrap();
        let t = Thresholds::default();
        // 10 min → minimum 30; 40 min → 45 (up to the quarter hour).
        let a = log_slash_command(&db, "/zeit NP-8801/1020 10m kurz", now(), &cet(), &t).unwrap();
        assert_eq!(a.entry.duration_minutes, Some(30));
        assert_eq!(a.entry.start_time, now() - chrono::Duration::minutes(30), "still ends now");
        assert_eq!(a.entry.leistungsart.as_deref(), Some("DEV"), "default Leistungsart of the Netzplan");
        let b = log_slash_command(&db, "/zeit NP-8801/1020 40m #TEST x", now(), &cet(), &t).unwrap();
        assert_eq!(b.entry.duration_minutes, Some(45));
        assert_eq!(b.entry.leistungsart.as_deref(), Some("TEST"), "an explicit Leistungsart wins");
        // Timer: 52 min → 60; nothing recorded stays nothing.
        db.start_timer(np, Some("1020"), None, "Timer", now()).unwrap();
        let e = db.stop_timer(now() + chrono::Duration::minutes(52), 0).unwrap();
        assert_eq!(e.duration_minutes, Some(60));
        db.start_timer(np, Some("1020"), None, "Timer", now()).unwrap();
        let e = db.stop_timer(now() + chrono::Duration::seconds(20), 0).unwrap();
        assert_eq!(e.duration_minutes, Some(0));
    }

    #[test]
    fn page_context_supplies_reference_and_page() {
        let (db, _) = setup();
        let page = db.create_page(None, "Integration", None).unwrap();
        let ctx = SlashContext { default_ref: Some("np-8801/1020"), page_id: Some(page.id) };
        let t = Thresholds::default();
        let out = log_slash_command_in(&db, "/zeit 0.5h Abstimmung", now(), &cet(), &t, ctx).unwrap();
        assert_eq!(out.reference, "NP-8801/1020");
        assert_eq!((out.entry.vorgang_nr.as_deref(), out.entry.page_id), (Some("1020"), Some(page.id)));
        assert_eq!(out.entry.description, "Abstimmung");
        // An explicit reference still wins; the page is recorded either way.
        let out = log_slash_command_in(&db, "/zeit NP-8801/1010 1h x", now(), &cet(), &t, ctx).unwrap();
        assert_eq!((out.reference.as_str(), out.entry.page_id), ("NP-8801/1010", Some(page.id)));
        // Purging the page keeps the entry, only the link goes.
        db.delete_page(page.id).unwrap();
        assert_eq!(db.time_entry(out.entry.id).unwrap().page_id, None);
    }

    #[test]
    fn explicit_local_start_time_is_converted_to_utc() {
        let (db, _) = setup();
        let out = log_slash_command(
            &db,
            "/zeit NP-8801/1010 1h #DEV Konzept @gestern @08:30",
            now(),
            &cet(),
            &Thresholds::default(),
        )
        .unwrap();
        assert_eq!(out.entry.start_time, Utc.with_ymd_and_hms(2026, 9, 22, 6, 30, 0).unwrap());
        assert_eq!(out.entry.leistungsart.as_deref(), Some("DEV"));
    }

    #[test]
    fn rejects_unknown_wbs_elements() {
        let (db, _) = setup();
        let t = Thresholds::default();
        assert!(log_slash_command(&db, "/zeit NP-9999 1h x", now(), &cet(), &t).is_err());
        assert!(log_slash_command(&db, "/zeit NP-8801/7777 1h x", now(), &cet(), &t).is_err());
        assert!(log_slash_command(&db, "/zeit NP-8801/1020 1h #NOPE x", now(), &cet(), &t).is_err());
        assert!(log_slash_command(&db, "/zeit NP-8801/1020 1h x @23:00", now(), &cet(), &t).is_err(), "future");
    }

    #[test]
    fn budget_levels_and_etc() {
        let (db, np) = setup();
        let t = Thresholds::default();
        // 5h on a 6h Vorgang: 83% consumed → warning.
        log_slash_command(&db, "/zeit NP-8801/1020 5h a @22.09. @08:00", now(), &cet(), &t).unwrap();
        let s = budget_status(&db, np, &t).unwrap();
        let v = s.iter().find(|s| s.vorgang_nr.as_deref() == Some("1020")).unwrap();
        assert_eq!(v.level, AlertLevel::Warning);
        assert!((v.etc_hours - 1.0).abs() < 1e-9);

        // A manual remaining estimate that pushes EAC over plan → critical.
        let id = db.list_vorgaenge(np).unwrap().into_iter().find(|v| v.vorgang_nr == "1020").unwrap().id;
        db.set_remaining_hours(id, Some(3.0)).unwrap();
        let v = budget_status(&db, np, &t).unwrap().remove(2);
        assert_eq!((v.level, v.eac_hours), (AlertLevel::Critical, 8.0));

        // Booking beyond plan → exceeded; alert is reported with the booking.
        let out = log_slash_command(&db, "/zeit NP-8801/1020 2h b @21.09. @08:00", now(), &cet(), &t).unwrap();
        assert!(out.alerts.iter().any(|a| a.label == "NP-8801/1020" && a.level == AlertLevel::Exceeded));
        let total = &budget_status(&db, np, &t).unwrap()[0];
        // Netzplan: 7h booked of 10h, ETC = 4h (1010) + 3h (1020 manual) → EAC 14h > 10h.
        assert_eq!(total.level, AlertLevel::Critical);
        assert!((total.eac_hours - 14.0).abs() < 1e-9);
    }

    #[test]
    fn booking_shortly_after_midnight_stays_on_today() {
        let (db, _) = setup();
        // 00:30 local time on the 24th.
        let now = Utc.with_ymd_and_hms(2026, 9, 23, 22, 30, 0).unwrap();
        let out = log_slash_command(&db, "/zeit NP-8801 2h Nachtschicht", now, &cet(), &Thresholds::default()).unwrap();
        let start = out.entry.start_time.with_timezone(&cet());
        assert_eq!(start.format("%d.%m. %H:%M").to_string(), "24.09. 00:00");
        assert_eq!(out.entry.duration_minutes, Some(120));
        // Earlier in the day nothing changes: the work just ended.
        let later = Utc.with_ymd_and_hms(2026, 9, 24, 10, 0, 0).unwrap();
        let out = log_slash_command(&db, "/zeit NP-8801 2h x", later, &cet(), &Thresholds::default()).unwrap();
        assert_eq!(out.entry.start_time, later - chrono::Duration::hours(2));
    }

    /// Central European time with the switch to summer time on 29.03.2026 at 02:00.
    #[derive(Clone, Copy, Debug)]
    struct Berlin;

    impl TimeZone for Berlin {
        type Offset = chrono::FixedOffset;
        fn from_offset(_: &chrono::FixedOffset) -> Self {
            Berlin
        }
        fn offset_from_local_date(&self, d: &chrono::NaiveDate) -> chrono::LocalResult<chrono::FixedOffset> {
            self.offset_from_local_datetime(&d.and_time(NaiveTime::MIN))
        }
        fn offset_from_local_datetime(&self, dt: &chrono::NaiveDateTime) -> chrono::LocalResult<chrono::FixedOffset> {
            let switch = chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(2, 0, 0).unwrap();
            if *dt < switch {
                chrono::LocalResult::Single(chrono::FixedOffset::east_opt(3600).unwrap())
            } else if *dt < switch + chrono::Duration::hours(1) {
                chrono::LocalResult::None
            } else {
                chrono::LocalResult::Single(chrono::FixedOffset::east_opt(7200).unwrap())
            }
        }
        fn offset_from_utc_date(&self, d: &chrono::NaiveDate) -> chrono::FixedOffset {
            self.offset_from_utc_datetime(&d.and_time(NaiveTime::MIN))
        }
        fn offset_from_utc_datetime(&self, dt: &chrono::NaiveDateTime) -> chrono::FixedOffset {
            let switch = chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(1, 0, 0).unwrap();
            chrono::FixedOffset::east_opt(if *dt < switch { 3600 } else { 7200 }).unwrap()
        }
    }

    #[test]
    fn a_time_skipped_by_the_clock_change_is_taken_an_hour_later() {
        let gap = chrono::NaiveDate::from_ymd_opt(2026, 3, 29).unwrap().and_hms_opt(2, 30, 0).unwrap();
        assert_eq!(local_to_utc(&Berlin, gap).unwrap(), Utc.with_ymd_and_hms(2026, 3, 29, 1, 30, 0).unwrap());
        let before = gap - chrono::Duration::hours(1);
        assert_eq!(local_to_utc(&Berlin, before).unwrap(), Utc.with_ymd_and_hms(2026, 3, 29, 0, 30, 0).unwrap());
    }

    #[test]
    fn overview_matches_the_per_netzplan_budget_and_schedule() {
        let (db, np) = setup();
        let p = db.project_by_code("PRJ-2026-X").unwrap();
        let other = db.create_netzplan(p.id, "NP-8802", "NP-8802-1", "Ohne Vorgänge", 5.0).unwrap();
        let empty = db.create_netzplan(p.id, "NP-8803", "NP-8803-1", "Nichts gebucht", 0.0).unwrap();
        let v = db.list_vorgaenge(np).unwrap();
        db.link_vorgaenge(v[0].id, v[1].id).unwrap();
        db.set_remaining_hours(v[1].id, Some(1.5)).unwrap();
        let book = |np: i64, vorgang: Option<&str>, minutes: i64| {
            db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: vorgang.map(str::to_owned),
                leistungsart: None,
                start_time: now(),
                duration_minutes: minutes,
                description: "x".into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        };
        db.create_vorgang(np, "A10", "Abnahme", 1.0, 2.0).unwrap();
        book(np, Some("1010"), 150);
        book(np, Some("1020"), 60);
        // Another spelling of the same Vorgang counts for it (as `COLLATE NOCASE` does).
        book(np, Some("a10"), 30);
        book(np, None, 45);
        book(other.id, Some("frei"), 400);
        // A running timer is not booked.
        db.start_timer(np, Some("1020"), None, "läuft", now()).unwrap();
        let t = Thresholds::default();

        let overview = netzplan_overview(&db, &t, true).unwrap();
        assert_eq!(overview.iter().map(|o| o.netzplan_id).collect::<Vec<_>>(), [np, other.id, empty.id]);
        for o in &overview {
            assert_eq!(o.budget, budget_status(&db, o.netzplan_id, &t).unwrap(), "budget of {}", o.netzplan_id);
            let schedule = netzplan::schedule(&db.list_vorgaenge(o.netzplan_id).unwrap()).ok();
            assert_eq!(o.schedule, schedule);
        }
        let all = all_budgets(&db, &t).unwrap();
        assert_eq!(all.len(), 4 + 1 + 1);
        assert_eq!(all.iter().find(|b| b.label == "NP-8801/A10").unwrap().booked_hours, 0.5);
        assert_eq!(all, overview.iter().flat_map(|o| o.budget.clone()).collect::<Vec<_>>());
        // NP-8802: 400 h planned 5 h → exceeded; the most critical one.
        assert_eq!(worst_budget(&all).map(|b| b.label.as_str()), Some("NP-8802"));
        assert!(worst_budget(&all[..1]).is_none_or(|b| b.level != AlertLevel::Ok));
    }

    #[test]
    fn grouped_booked_minutes_match_single_queries() {
        let (db, np) = setup();
        for (v, m) in [(Some("1010"), 30), (Some("1010"), 15), (None, 20)] {
            db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: v.map(str::to_owned),
                leistungsart: None,
                start_time: now(),
                duration_minutes: m,
                description: String::new(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        }
        let all = db.booked_minutes_all().unwrap();
        let b = &all[&np];
        assert_eq!(b.total as f64 / 60.0, db.booked_hours(np, None).unwrap());
        assert_eq!(b.vorgang("1010") as f64 / 60.0, db.booked_hours(np, Some("1010")).unwrap());
        assert_eq!(b.vorgang("1020"), 0);
    }
}
