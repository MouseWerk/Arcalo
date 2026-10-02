//! Working time beyond the bookings: the target per weekday, public holidays, absence days
//! (vacation, sick, time off in lieu, other), the overtime balance („Gleitzeitsaldo“) and the
//! vacation account. Settings → Zeiterfassung → „Saldo und Urlaub“ ([`BalancePrefs`]).
//!
//! The target of a day is the weekday's target, none on a public holiday of the chosen state,
//! half on a half absence and none on a full one, except for time off in lieu („Ausgleich“):
//! that day keeps its target for the balance (it is paid with overtime). The week proposal, the
//! day review and the reminder never treat a holiday or an absence day as a gap
//! ([`gap_target`]).

pub mod holidays;

use std::collections::{BTreeMap, HashMap};

use chrono::{DateTime, Datelike, Duration, NaiveDate, TimeZone, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::settings::Settings;
pub use holidays::{Holiday, holidays_between};

/// Settings of the balance and the vacation account (`time.balance`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct BalancePrefs {
    /// Target hours Monday..Sunday; empty: the daily target on the workdays.
    pub weekday_hours: Vec<f64>,
    /// First day the balance counts; `None`: 1 January of the current year.
    pub start: Option<NaiveDate>,
    /// Balance on the start day (hours, may be negative).
    pub opening_hours: f64,
    /// Vacation days per year.
    pub vacation_days: f64,
    /// Days carried over from the previous year.
    pub carry_over: f64,
    /// State for public holidays (`BY`, `NW`, …); empty: none.
    pub state: String,
}

impl Default for BalancePrefs {
    fn default() -> Self {
        BalancePrefs {
            weekday_hours: vec![],
            start: None,
            opening_hours: 0.0,
            vacation_days: 30.0,
            carry_over: 0.0,
            state: String::new(),
        }
    }
}

impl BalancePrefs {
    /// Values in range: seven targets of 0–24 h (or none), days of 0–366, a known state.
    pub fn normalized(mut self) -> Self {
        if self.weekday_hours.len() != 7 {
            self.weekday_hours.clear();
        }
        for h in &mut self.weekday_hours {
            *h = if h.is_finite() { h.clamp(0.0, 24.0) } else { 0.0 };
        }
        let days = |x: f64| if x.is_finite() { x.clamp(0.0, 366.0) } else { 0.0 };
        self.vacation_days = days(self.vacation_days);
        self.carry_over = days(self.carry_over);
        self.opening_hours =
            if self.opening_hours.is_finite() { self.opening_hours.clamp(-10_000.0, 10_000.0) } else { 0.0 };
        self.state = self.state.trim().to_ascii_uppercase();
        if !holidays::is_state(&self.state) {
            self.state.clear();
        }
        self
    }
}

// ------------------------------------------------------------------ absences

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AbsenceKind {
    Vacation,
    Sick,
    /// Time off in lieu: no gap, but the target stays for the balance.
    Comp,
    /// Special leave, training, …: no target.
    Other,
}

impl AbsenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AbsenceKind::Vacation => "vacation",
            AbsenceKind::Sick => "sick",
            AbsenceKind::Comp => "comp",
            AbsenceKind::Other => "other",
        }
    }
    fn parse(s: &str) -> AbsenceKind {
        match s {
            "vacation" => AbsenceKind::Vacation,
            "sick" => AbsenceKind::Sick,
            "comp" => AbsenceKind::Comp,
            _ => AbsenceKind::Other,
        }
    }
}

/// One absence day.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Absence {
    pub date: NaiveDate,
    pub kind: AbsenceKind,
    #[serde(default)]
    pub half: bool,
    #[serde(default)]
    pub note: String,
}

impl Absence {
    /// The share of the day: 1 or ½.
    pub fn days(&self) -> f64 {
        if self.half { 0.5 } else { 1.0 }
    }
}

/// Longest range one dialog may fill.
pub const MAX_RANGE_DAYS: i64 = 366;

impl Database {
    /// The absences from `from` to `to` (both included), by date.
    pub fn absences(&self, from: NaiveDate, to: NaiveDate) -> Result<Vec<Absence>> {
        let mut st = self.conn().prepare_cached(
            "SELECT date, kind, half, note FROM absences WHERE date >= ?1 AND date <= ?2 ORDER BY date",
        )?;
        let rows = st.query_map(params![from.to_string(), to.to_string()], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out = vec![];
        for row in rows {
            let (date, kind, half, note) = row?;
            let Ok(date) = date.parse::<NaiveDate>() else { continue };
            out.push(Absence { date, kind: AbsenceKind::parse(&kind), half: half != 0, note });
        }
        Ok(out)
    }

    /// Stores (or replaces) one absence day.
    pub fn absence_put(&self, a: &Absence) -> Result<()> {
        self.conn().execute(
            "INSERT INTO absences (date, kind, half, note) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(date) DO UPDATE SET kind = excluded.kind, half = excluded.half, note = excluded.note",
            params![a.date.to_string(), a.kind.as_str(), a.half as i64, a.note.trim()],
        )?;
        Ok(())
    }

    /// Removes the absences from `from` to `to`; how many there were.
    pub fn absence_remove(&self, from: NaiveDate, to: NaiveDate) -> Result<usize> {
        Ok(self.conn().execute(
            "DELETE FROM absences WHERE date >= ?1 AND date <= ?2",
            params![from.to_string(), to.to_string()],
        )?)
    }
}

/// Enters `kind` for the days `from..=to`: one day as chosen; in a longer range only the days
/// with a target (no weekend, no public holiday). Returns the days stored.
pub fn save_range(
    db: &Database,
    settings: &Settings,
    from: NaiveDate,
    to: NaiveDate,
    kind: AbsenceKind,
    half: bool,
    note: &str,
) -> Result<Vec<NaiveDate>> {
    if to < from || (to - from).num_days() >= MAX_RANGE_DAYS {
        return Err(Error::State(
            crate::tr!(
                "Bitte einen Zeitraum von höchstens einem Jahr wählen",
                "Please choose a range of at most one year"
            )
            .into(),
        ));
    }
    let prefs = &settings.time.balance;
    let holidays = holiday_map(from, to, &prefs.state);
    let mut days = vec![];
    let mut d = from;
    while d <= to {
        if from == to || (weekday_minutes(settings, d) > 0 && !holidays.contains_key(&d)) {
            days.push(d);
        }
        d += Duration::days(1);
    }
    db.atomic(|| {
        for &date in &days {
            db.absence_put(&Absence { date, kind, half, note: note.to_owned() })?;
        }
        Ok(())
    })?;
    Ok(days)
}

// ------------------------------------------------------------------ targets

/// The target of `d`'s weekday in minutes (before holidays and absences).
pub fn weekday_minutes(settings: &Settings, d: NaiveDate) -> i64 {
    let i = d.weekday().num_days_from_monday() as usize;
    let hours = &settings.time.balance.weekday_hours;
    let h = if hours.len() == 7 {
        hours[i]
    } else if settings.workdays.contains(&(i as u32 + 1)) {
        settings.daily_target_hours
    } else {
        0.0
    };
    (h.max(0.0) * 60.0).round() as i64
}

/// Holidays by date.
pub fn holiday_map(from: NaiveDate, to: NaiveDate, state: &str) -> HashMap<NaiveDate, Holiday> {
    holidays_between(from, to, state).into_iter().map(|h| (h.date, h)).collect()
}

/// The target of a day with `base` minutes: none on a holiday, half on a half absence, none
/// on a full one. `for_balance`: time off in lieu keeps the target (it is paid with overtime).
pub fn day_target(base: i64, holiday: bool, absence: Option<&Absence>, for_balance: bool) -> i64 {
    if holiday {
        return 0;
    }
    match absence {
        Some(a) if for_balance && a.kind == AbsenceKind::Comp => base,
        Some(a) if a.half => base - base / 2,
        Some(_) => 0,
        None => base,
    }
}

/// What the week proposal, the day review and the reminder take as the target of `date`,
/// given the target `base` they computed: none on a holiday or a full absence day, half on a
/// half one (so those days are no gaps).
pub fn gap_target(db: &Database, date: NaiveDate, base: i64) -> Result<i64> {
    if base <= 0 {
        return Ok(base);
    }
    let settings = db.load_settings().unwrap_or_default();
    let holiday = !holidays_between(date, date, &settings.time.balance.state).is_empty();
    let absence = db.absences(date, date)?.into_iter().next();
    Ok(day_target(base, holiday, absence.as_ref(), false))
}

/// Booked minutes per local day of `from..=to`; a running timer counts until `now`.
pub fn booked_by_day<Tz: TimeZone>(
    db: &Database,
    tz: &Tz,
    from: NaiveDate,
    to: NaiveDate,
    now: DateTime<Utc>,
) -> Result<BTreeMap<NaiveDate, i64>> {
    let start = crate::feed::day_start(from, tz);
    let end = crate::feed::day_start(to + Duration::days(1), tz);
    let mut st = db.conn().prepare_cached(
        "SELECT start_time, duration_minutes, status_flag FROM time_entries WHERE start_time >= ?1 AND start_time < ?2",
    )?;
    let rows = st.query_map(params![crate::db::ts(start), crate::db::ts(end)], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?))
    })?;
    let mut out = BTreeMap::new();
    for row in rows {
        let (at, minutes, flag) = row?;
        let Ok(at) = crate::db::parse_ts(&at) else { continue };
        let minutes = if flag == "running" { (now - at).num_minutes().max(0) } else { minutes.unwrap_or(0) };
        *out.entry(at.with_timezone(tz).date_naive()).or_default() += minutes;
    }
    Ok(out)
}

// ------------------------------------------------------------------ balance

/// The balance at the end of a week (or today for the current one).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BalancePoint {
    pub week_start: NaiveDate,
    pub minutes: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BalanceData {
    pub start: NaiveDate,
    /// The start comes from the settings (else 1 January).
    pub configured: bool,
    /// Booked minus target since the start, plus the opening balance.
    pub minutes: i64,
    pub opening_minutes: i64,
    pub booked_minutes: i64,
    pub target_minutes: i64,
    pub today_booked: i64,
    pub today_target: i64,
    /// A timer is running (its minutes count until now).
    pub running: bool,
    /// Balance at the end of each of the last weeks, oldest first.
    pub weeks: Vec<BalancePoint>,
    /// Change over the last 7 days.
    pub week_delta: i64,
}

/// The overtime balance on `today`: booked minus target of every day from the start up to
/// yesterday, and of today once its target is reached (until then today is in progress and
/// counts nothing), plus the opening balance. `weeks` points for the sparkline.
pub fn balance<Tz: TimeZone>(
    db: &Database,
    settings: &Settings,
    tz: &Tz,
    today: NaiveDate,
    now: DateTime<Utc>,
    weeks: usize,
) -> Result<BalanceData> {
    let prefs = &settings.time.balance;
    let configured = prefs.start.is_some();
    let start = prefs.start.unwrap_or_else(|| NaiveDate::from_ymd_opt(today.year(), 1, 1).unwrap_or(today));
    let opening = (prefs.opening_hours * 60.0).round() as i64;
    let running = db.running_timer()?.is_some();
    let mut data = BalanceData {
        start,
        configured,
        minutes: opening,
        opening_minutes: opening,
        booked_minutes: 0,
        target_minutes: 0,
        today_booked: 0,
        today_target: 0,
        running,
        weeks: vec![],
        week_delta: 0,
    };
    if start > today {
        return Ok(data);
    }
    let booked = booked_by_day(db, tz, start, today, now)?;
    let holidays = holiday_map(start, today, &prefs.state);
    let absences: HashMap<NaiveDate, Absence> = db.absences(start, today)?.into_iter().map(|a| (a.date, a)).collect();
    let monday = |d: NaiveDate| d - Duration::days(d.weekday().num_days_from_monday() as i64);
    let first_week = monday(today) - Duration::weeks(weeks.saturating_sub(1) as i64);
    let week_ago = today - Duration::days(7);
    let mut cum = opening;
    let mut at_week_ago = opening;
    let mut points: Vec<BalancePoint> = vec![];
    let mut d = start;
    while d <= today {
        let target = day_target(weekday_minutes(settings, d), holidays.contains_key(&d), absences.get(&d), true);
        let b = booked.get(&d).copied().unwrap_or(0);
        let delta = if d < today {
            data.booked_minutes += b;
            data.target_minutes += target;
            b - target
        } else {
            data.today_booked = b;
            data.today_target = target;
            if b >= target {
                data.booked_minutes += b;
                data.target_minutes += target;
                b - target
            } else {
                0
            }
        };
        cum += delta;
        if d == week_ago {
            at_week_ago = cum;
        }
        // The end of a week (Sunday) or today.
        if (d.weekday() == chrono::Weekday::Sun || d == today) && monday(d) >= first_week {
            points.push(BalancePoint { week_start: monday(d), minutes: cum });
        }
        d += Duration::days(1);
    }
    data.minutes = cum;
    data.week_delta = if week_ago >= start { cum - at_week_ago } else { cum - opening };
    data.weeks = points;
    Ok(data)
}

// ------------------------------------------------------------------ vacation

/// Consecutive absence days of one kind (weekends and holidays between them do not break it).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AbsenceBlock {
    pub from: NaiveDate,
    pub to: NaiveDate,
    pub kind: AbsenceKind,
    pub days: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VacationData {
    pub year: i32,
    /// Days per year plus carry-over.
    pub entitlement: f64,
    pub carry_over: f64,
    /// Vacation days up to today.
    pub taken: f64,
    /// Vacation days after today.
    pub planned: f64,
    pub left: f64,
    pub next_holiday: Option<Holiday>,
    /// The state the holidays come from (empty: none chosen).
    pub state: String,
    /// The next absences from today on (at most three blocks).
    pub upcoming: Vec<AbsenceBlock>,
}

/// Groups days into blocks: same kind, nothing but days without a target between them.
pub fn blocks(settings: &Settings, list: &[Absence], holidays: &HashMap<NaiveDate, Holiday>) -> Vec<AbsenceBlock> {
    let mut out: Vec<AbsenceBlock> = vec![];
    for a in list {
        if let Some(last) = out.last_mut()
            && last.kind == a.kind
            && a.date > last.to
        {
            let mut d = last.to + Duration::days(1);
            let mut free = true;
            while d < a.date && free {
                free = weekday_minutes(settings, d) == 0 || holidays.contains_key(&d);
                d += Duration::days(1);
            }
            if free {
                last.to = a.date;
                last.days += a.days();
                continue;
            }
        }
        out.push(AbsenceBlock { from: a.date, to: a.date, kind: a.kind, days: a.days() });
    }
    out
}

/// The vacation account of `today`'s year, the next holiday and the next absences.
pub fn vacation(db: &Database, settings: &Settings, today: NaiveDate) -> Result<VacationData> {
    let prefs = &settings.time.balance;
    let year = today.year();
    let jan = NaiveDate::from_ymd_opt(year, 1, 1).unwrap_or(today);
    let dec = NaiveDate::from_ymd_opt(year, 12, 31).unwrap_or(today);
    let in_year = db.absences(jan, dec)?;
    let vac = |past: bool| -> f64 {
        in_year
            .iter()
            .filter(|a| a.kind == AbsenceKind::Vacation && (a.date <= today) == past)
            .map(Absence::days)
            .fold(0.0, |a, b| a + b)
    };
    let (taken, planned) = (vac(true), vac(false));
    let entitlement = prefs.vacation_days + prefs.carry_over;
    let horizon = today + Duration::days(400);
    let holidays = holiday_map(today, horizon, &prefs.state);
    let mut next: Vec<&Holiday> = holidays.values().collect();
    next.sort_by_key(|h| h.date);
    let ahead = db.absences(today, today + Duration::days(366))?;
    let upcoming = blocks(settings, &ahead, &holidays).into_iter().take(3).collect();
    Ok(VacationData {
        year,
        entitlement,
        carry_over: prefs.carry_over,
        taken,
        planned,
        left: entitlement - taken - planned,
        next_holiday: next.first().map(|h| (*h).clone()),
        state: prefs.state.clone(),
        upcoming,
    })
}

#[cfg(test)]
mod tests;
