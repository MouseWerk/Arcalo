//! High-level time tracking: slash-command logging and budget / ETC alerts.

use chrono::{DateTime, NaiveTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::model::{EntrySource, NewTimeEntry, TimeEntry};
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
    let start = match (cmd.date, cmd.start) {
        (_, Some(t)) => local_to_utc(offset, cmd.date.resolve(local_now.date_naive()).and_time(t))?,
        // Today without a start time: the work just ended.
        (d, None) if d.resolve(local_now.date_naive()) == local_now.date_naive() => now - duration,
        (d, None) => local_to_utc(offset, d.resolve(local_now.date_naive()).and_time(DEFAULT_START))?,
    };
    if start + duration > now + chrono::Duration::minutes(1) {
        return Err(Error::State("time entries cannot end in the future".into()));
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

/// Resolves a local wall-clock time in the given zone (per date, so DST is honoured).
fn local_to_utc<Tz: TimeZone>(offset: &Tz, dt: chrono::NaiveDateTime) -> Result<DateTime<Utc>> {
    offset
        .from_local_datetime(&dt)
        .earliest()
        .map(|t| t.with_timezone(&Utc))
        .ok_or_else(|| Error::State(format!("ambiguous local time {dt}")))
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
    let mut out = Vec::with_capacity(vorgaenge.len() + 1);

    let mut etc_sum = 0.0;
    for v in &vorgaenge {
        let booked = db.booked_hours(netzplan_id, Some(&v.vorgang_nr))?;
        let etc = v.remaining_hours.unwrap_or((v.planned_hours - booked).max(0.0)).max(0.0);
        etc_sum += etc;
        let eac = booked + etc;
        let (consumed, level) = classify(v.planned_hours, booked, eac, t);
        out.push(BudgetStatus {
            label: format!("{}/{}", np.netzplan_nr, v.vorgang_nr),
            netzplan_id,
            vorgang_nr: Some(v.vorgang_nr.clone()),
            planned_hours: v.planned_hours,
            booked_hours: booked,
            etc_hours: etc,
            eac_hours: eac,
            consumed,
            level,
        });
    }

    let booked = db.booked_hours(netzplan_id, None)?;
    let etc = if vorgaenge.is_empty() { (np.planned_hours - booked).max(0.0) } else { etc_sum };
    let eac = booked + etc;
    let (consumed, level) = classify(np.planned_hours, booked, eac, t);
    out.insert(
        0,
        BudgetStatus {
            label: np.netzplan_nr.clone(),
            netzplan_id,
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
}
