//! Time tracking: `/zeit` bookings, the timer, time entries, the week and absences.

use std::collections::HashMap;
use std::path::PathBuf;

use arcalo_core::db::EntryFilter;
use arcalo_core::export::{self, ExportFormat, ExportOptions};
use arcalo_core::external::Change;
use arcalo_core::model::{StatusFlag, TimeEntry};
use arcalo_core::tracking::{self, AlertLevel, BudgetStatus};
use arcalo_core::worktime::{self, Absence, AbsenceKind, Holiday};
use arcalo_core::{Database, Error, Result, i18n, tr, trf, zeit};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;

use crate::model::EntryOut;
use crate::output::{Failure, Outcome};
use crate::pages::{day, day_or_today};
use crate::{AbsenceCmd, Ctx, TimeCmd, TimerCmd};

/// Local midnight at the start of `d`, in UTC.
pub fn day_start(d: NaiveDate) -> DateTime<Utc> {
    let midnight = d.and_hms_opt(0, 0, 0).unwrap_or_default();
    Local.from_local_datetime(&midnight).earliest().map_or_else(|| midnight.and_utc(), |t| t.with_timezone(&Utc))
}

pub fn level_name(l: AlertLevel) -> &'static str {
    match l {
        AlertLevel::Ok => "ok",
        AlertLevel::Warning => "WARN",
        AlertLevel::Critical => "CRIT",
        AlertLevel::Exceeded => "OVER",
    }
}

fn entries_changed(page: Option<i64>) -> Change {
    Change { entries: true, pages: page.into_iter().collect(), ..Default::default() }
}

/// A booking as printed.
fn entry_out(db: &Database, e: &TimeEntry) -> Result<EntryOut> {
    let row = db.time_entry_row(e.id)?.ok_or_else(|| Error::not_found("entry", e.id.to_string()))?;
    Ok(EntryOut::of(&row))
}

fn hours(minutes: i64) -> String {
    i18n::decimal(format!("{:.2}", minutes as f64 / 60.0))
}

fn entry_text(e: &EntryOut) -> String {
    format!(
        "{}  {}  {} h  {}{}  {}  [{}]",
        e.id,
        e.start.format("%Y-%m-%d %H:%M"),
        hours(e.minutes.unwrap_or(0)),
        e.reference,
        e.activity_type.as_ref().map(|l| format!(" #{l}")).unwrap_or_default(),
        e.description,
        serde_json::to_value(e.status).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
    )
}

fn alert_line(a: &BudgetStatus) -> String {
    let (level, label) = (level_name(a.level), &a.label);
    let (booked, planned) = (format!("{:.1}", a.booked_hours), format!("{:.1}", a.planned_hours));
    let (pct, etc, eac) =
        (format!("{:.0}", a.consumed * 100.0), format!("{:.1}", a.etc_hours), format!("{:.1}", a.eac_hours));
    trf!(
        "  [{level}] {label}: {booked}h von {planned}h gebucht ({pct}%), ETC {etc}h, EAC {eac}h",
        "  [{level}] {label}: {booked}h of {planned}h booked ({pct}%), ETC {etc}h, EAC {eac}h"
    )
}

#[derive(Serialize)]
struct Booked {
    entry: EntryOut,
    alerts: Vec<BudgetStatus>,
}

/// `arcalo zeit NP-8801/1020 2.5h #DEV 'Systemintegration'`: books like `/zeit` in a note.
pub fn zeit(ctx: &Ctx, args: &[String]) -> Outcome<()> {
    let mut line = args.join(" ");
    if !zeit::is_zeit_command(&line) {
        line = format!("/zeit {line}");
    }
    let t = ctx.ws.settings.thresholds;
    let out = ctx.ws.commit(|db| {
        let out = tracking::log_slash_command(db, &line, Utc::now(), &Local, &t)?;
        Ok((out, entries_changed(None)))
    })?;
    let booked = Booked { entry: entry_out(&ctx.ws.db, &out.entry)?, alerts: out.alerts };
    ctx.out.show(&booked, |b| {
        let e = &b.entry;
        let (id, h, r, d) =
            (e.id, format!("{:.2}", e.minutes.unwrap_or(0) as f64 / 60.0), &e.reference, &e.description);
        let mut s = trf!("#{id} gebucht: {h}h auf {r} – {d}", "#{id} booked: {h}h on {r} – {d}");
        for a in &b.alerts {
            s.push('\n');
            s.push_str(&alert_line(a));
        }
        s
    })
}

pub fn timer(ctx: &Ctx, action: TimerCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    let now = Utc::now();
    match action {
        TimerCmd::Start { target, rest } => {
            let (np_ref, vorgang) = match target.split_once('/') {
                Some((a, b)) => (a.to_owned(), Some(b.to_owned())),
                None => (target, None),
            };
            let np = db.netzplan_by_ref(&np_ref)?;
            let la = rest.iter().find(|w| w.starts_with('#')).map(|w| w[1..].to_uppercase());
            let desc: Vec<_> = rest.iter().filter(|w| !w.starts_with('#')).cloned().collect();
            let e = ctx.ws.commit(|db| {
                let e = db.start_timer(np.id, vorgang.as_deref(), la.as_deref(), &desc.join(" "), now)?;
                Ok((e, entries_changed(None)))
            })?;
            let out = entry_out(db, &e)?;
            ctx.out.show(&out, |e| {
                let (id, at) = (e.id, e.start.format("%H:%M"));
                trf!("Timer #{id} läuft seit {at}", "Timer #{id} running since {at}")
            })
        }
        TimerCmd::Stop { idle } => {
            let stopped = ctx.ws.commit(|db| Ok((db.stop_timer(now, idle)?, entries_changed(None))))?;
            let list = stopped.iter().map(|e| entry_out(db, e)).collect::<Result<Vec<_>>>()?;
            ctx.out.show(&list, |l| {
                l.iter()
                    .map(|e| {
                        let (id, m) = (e.id, e.minutes.unwrap_or(0));
                        trf!("Timer #{id} gestoppt: {m} Min. gebucht", "Timer #{id} stopped: {m} min booked") + "\n"
                    })
                    .collect()
            })
        }
        TimerCmd::Status => {
            #[derive(Serialize)]
            struct Status {
                running: bool,
                entry: Option<EntryOut>,
                /// Minutes worked so far (pauses not counted).
                minutes: Option<i64>,
            }
            let status = match db.running_timer()? {
                Some(e) => Status {
                    running: true,
                    minutes: Some(db.timer_worked_minutes(&e, now)?),
                    entry: Some(entry_out(db, &e)?),
                },
                None => Status { running: false, entry: None, minutes: None },
            };
            ctx.out.show(&status, |s| match (&s.entry, s.minutes) {
                (Some(e), Some(m)) => {
                    let (id, d) = (e.id, &e.description);
                    trf!("Timer #{id} läuft seit {m} Min. – {d}", "Timer #{id} running for {m} min – {d}")
                }
                _ => tr!("Kein Timer aktiv.", "No timer running.").into(),
            })
        }
    }
}

pub struct ExportArgs {
    pub format: String,
    pub from: Option<NaiveDate>,
    pub to: Option<NaiveDate>,
    pub pernr: Option<String>,
    pub jira_map: Option<PathBuf>,
    pub mark: bool,
}

pub fn export(ctx: &Ctx, a: ExportArgs) -> Outcome<()> {
    let format = ExportFormat::parse(&a.format).ok_or_else(|| {
        Failure::Usage(trf!(
            "Unbekanntes Format „{}“ (cats, jira, csv, json)",
            "Unknown format “{}” (cats, jira, csv, json)",
            a.format
        ))
    })?;
    let jira_issue_map: HashMap<String, String> = match a.jira_map {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(&p).map_err(|e| Error::file(&p, e))?)?,
        None => HashMap::new(),
    };
    let filter = EntryFilter {
        from: a.from.map(day_start),
        to: a.to.and_then(|d| d.succ_opt()).map(day_start),
        ..Default::default()
    };
    let rows = ctx.ws.db.list_time_entries(&filter)?;
    let opts = ExportOptions { pernr: a.pernr, jira_issue_map, utc_offset_minutes: None, ..Default::default() };
    let res = export::export(&rows, format, &opts)?;
    let marked = if a.mark {
        let ids = res.exported_ids.clone();
        Some(ctx.ws.commit(|db| Ok((db.set_entry_status(&ids, StatusFlag::Exported)?, entries_changed(None))))?)
    } else {
        None
    };
    if ctx.out.json {
        let skipped: Vec<_> =
            res.skipped.iter().map(|(id, why)| serde_json::json!({ "id": id, "reason": why })).collect();
        let v = serde_json::json!({
            "content": res.content, "exported_ids": res.exported_ids, "skipped": skipped, "marked": marked,
        });
        return ctx.out.show(&v, |_| String::new());
    }
    print!("{}", res.content);
    for (id, why) in &res.skipped {
        eprintln!("{}", trf!("übersprungen #{id}: {why}", "skipped #{id}: {why}"));
    }
    match marked {
        Some(1) => eprintln!("{}", tr!("Ein Eintrag als exportiert markiert", "One entry marked as exported")),
        Some(n) => eprintln!("{}", trf!("{n} Einträge als exportiert markiert", "{n} entries marked as exported")),
        None => {}
    }
    Ok(())
}

/// Monday to Sunday of the week of `d`.
fn week_of(d: NaiveDate) -> (NaiveDate, NaiveDate) {
    let monday = d - Duration::days(d.weekday().num_days_from_monday() as i64);
    (monday, monday + Duration::days(6))
}

/// A start time: `YYYY-MM-DDTHH:MM` (or with a space) in local time, or `HH:MM` on `on`.
fn start_time(s: &str, on: NaiveDate) -> Outcome<DateTime<Utc>> {
    let s = s.trim();
    let wall = ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S"]
        .iter()
        .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
        .or_else(|| NaiveTime::parse_from_str(s, "%H:%M").ok().map(|t| on.and_time(t)));
    wall.and_then(|w| Local.from_local_datetime(&w).earliest())
        .map(|t| t.with_timezone(&Utc))
        .or_else(|| DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc)))
        .ok_or_else(|| {
            Failure::Usage(trf!(
                "Keine Startzeit: {s} (erwartet YYYY-MM-DDTHH:MM oder HH:MM)",
                "Not a start time: {s} (expected YYYY-MM-DDTHH:MM or HH:MM)"
            ))
        })
}

/// `none` (or `keine`) removes an optional value.
fn optional(v: Option<String>, current: Option<String>) -> Option<String> {
    match v {
        Some(s) if matches!(s.trim().to_lowercase().as_str(), "none" | "keine" | "") => None,
        Some(s) => Some(s.trim().to_owned()),
        None => current,
    }
}

pub fn run(ctx: &Ctx, cmd: TimeCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    match cmd {
        TimeCmd::List { from, to } => {
            let (mon, sun) = week_of(Local::now().date_naive());
            let from = from.as_deref().map(day).transpose()?.unwrap_or(mon);
            let to = to.as_deref().map(day).transpose()?.unwrap_or(if from == mon { sun } else { from });
            let filter = EntryFilter {
                from: Some(day_start(from)),
                to: Some(day_start(to + Duration::days(1))),
                ..Default::default()
            };
            let list: Vec<EntryOut> = db.list_time_entries(&filter)?.iter().map(EntryOut::of).collect();
            ctx.out.show(&list, |l| l.iter().map(|e| entry_text(e) + "\n").collect())
        }
        TimeCmd::Edit { id, duration, start, description, vorgang, activity_type } => {
            let before = db.time_entry(id)?;
            let minutes = match duration {
                Some(d) => zeit::parse_duration(&d)?,
                None => before.duration_minutes.unwrap_or(0),
            };
            let start = match start {
                Some(s) => start_time(&s, before.start_time.with_timezone(&Local).date_naive())?,
                None => before.start_time,
            };
            let vorgang = optional(vorgang, before.vorgang_nr.clone());
            let la = optional(activity_type, before.leistungsart.clone());
            let description = description.unwrap_or_else(|| before.description.clone());
            let settings = &ctx.ws.settings;
            let after = ctx.ws.commit(|db| {
                let after =
                    db.update_time_entry(id, vorgang.as_deref(), la.as_deref(), start, minutes, &description)?;
                // Posted to Jira: the app's worklog runner brings the worklog up to date.
                db.booking_edited(&before, &after, settings)?;
                Ok((after.clone(), entries_changed(after.page_id)))
            })?;
            ctx.out.show(&entry_out(db, &after)?, entry_text)
        }
        TimeCmd::Delete { id } => {
            let e = db.time_entry(id)?;
            let gone = entry_out(db, &e)?;
            let settings = &ctx.ws.settings;
            ctx.ws.commit(|db| {
                db.delete_booking(id, false, settings)?;
                Ok(((), entries_changed(e.page_id)))
            })?;
            ctx.out.show(&serde_json::json!({ "deleted": gone }), |_| {
                trf!("Eintrag #{id} gelöscht", "Entry #{id} deleted")
            })
        }
        TimeCmd::Week { date } => {
            let (from, to) = week_of(day_or_today(date.as_deref())?);
            let settings = &ctx.ws.settings;
            let booked = worktime::booked_by_day(db, &Local, from, to, Utc::now())?;
            let targets = worktime::DayTargets::load(db, settings, from, to)?;
            #[derive(Serialize)]
            struct DayOut {
                date: NaiveDate,
                booked_minutes: i64,
                target_minutes: i64,
                holiday: Option<String>,
                absence: Option<Absence>,
            }
            #[derive(Serialize)]
            struct WeekOut {
                from: NaiveDate,
                to: NaiveDate,
                booked_minutes: i64,
                target_minutes: i64,
                days: Vec<DayOut>,
            }
            let days: Vec<DayOut> = (0..7)
                .map(|i| {
                    let d = from + Duration::days(i);
                    DayOut {
                        date: d,
                        booked_minutes: booked.get(&d).copied().unwrap_or(0),
                        target_minutes: targets.get(d),
                        holiday: targets
                            .holiday(d)
                            .map(|h| if i18n::is_en() { h.name_en.clone() } else { h.name.clone() }),
                        absence: targets.absence(d).cloned(),
                    }
                })
                .collect();
            let week = WeekOut {
                from,
                to,
                booked_minutes: days.iter().map(|d| d.booked_minutes).sum(),
                target_minutes: days.iter().map(|d| d.target_minutes).sum(),
                days,
            };
            ctx.out.show(&week, |w| {
                let mut s = String::new();
                for d in &w.days {
                    let note = d
                        .holiday
                        .clone()
                        .or_else(|| d.absence.as_ref().map(|a| a.kind.as_str().to_owned()))
                        .unwrap_or_default();
                    s.push_str(&format!(
                        "{}  {:>6} h / {:>6} h  {note}\n",
                        d.date.format("%a %Y-%m-%d"),
                        hours(d.booked_minutes),
                        hours(d.target_minutes)
                    ));
                }
                let (b, t) = (hours(w.booked_minutes), hours(w.target_minutes));
                s + &trf!("Woche: {b} h von {t} h", "Week: {b} h of {t} h")
            })
        }
    }
}

fn kind(s: &str) -> Outcome<AbsenceKind> {
    serde_json::from_value(serde_json::Value::String(s.trim().to_lowercase())).map_err(|_| {
        Failure::Usage(trf!(
            "Unbekannte Abwesenheit: {s} (vacation, sick, comp, other)",
            "Unknown absence: {s} (vacation, sick, comp, other)"
        ))
    })
}

pub fn absences(ctx: &Ctx, cmd: AbsenceCmd) -> Outcome<()> {
    let db = &ctx.ws.db;
    let settings = &ctx.ws.settings;
    let changed = || Change { absences: true, ..Default::default() };
    match cmd {
        AbsenceCmd::List { from, to } => {
            let year = Local::now().date_naive().year();
            let from = from
                .as_deref()
                .map(day)
                .transpose()?
                .unwrap_or_else(|| NaiveDate::from_ymd_opt(year, 1, 1).unwrap_or_default());
            let to = to
                .as_deref()
                .map(day)
                .transpose()?
                .unwrap_or_else(|| NaiveDate::from_ymd_opt(year, 12, 31).unwrap_or_default());
            #[derive(Serialize)]
            struct List {
                absences: Vec<Absence>,
                holidays: Vec<Holiday>,
                /// The state whose public holidays count (Settings → Zeiterfassung).
                state: String,
            }
            let state = settings.time.balance.state.clone();
            let list = List {
                absences: db.absences(from, to)?,
                holidays: worktime::holidays_between(from, to, &state),
                state,
            };
            ctx.out.show(&list, |l| {
                l.absences
                    .iter()
                    .map(|a| format!("{}  {}{}  {}\n", a.date, a.kind.as_str(), if a.half { " ½" } else { "" }, a.note))
                    .collect()
            })
        }
        AbsenceCmd::Add { from, to, kind: k, half, note } => {
            let from = day(&from)?;
            let to = to.as_deref().map(day).transpose()?.unwrap_or(from);
            let k = kind(&k)?;
            let note: String = note.trim().chars().take(200).collect();
            let days =
                ctx.ws.commit(|db| Ok((worktime::save_range(db, settings, from, to, k, half, &note)?, changed())))?;
            ctx.out.show(&serde_json::json!({ "days": days }), |_| match days.len() {
                1 => tr!("Abwesenheitstag eingetragen", "Absence day entered").into(),
                n => trf!("{n} Abwesenheitstage eingetragen", "{n} absence days entered"),
            })
        }
        AbsenceCmd::Delete { from, to } => {
            let from = day(&from)?;
            let to = to.as_deref().map(day).transpose()?.unwrap_or(from);
            let n = ctx.ws.commit(|db| Ok((db.absence_remove(from, to)?, changed())))?;
            ctx.out.show(&serde_json::json!({ "removed": n }), |_| match n {
                1 => tr!("Abwesenheitstag entfernt", "Absence day removed").into(),
                n => trf!("{n} Abwesenheitstage entfernt", "{n} absence days removed"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weeks_run_from_monday_to_sunday() {
        let d = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap();
        assert_eq!(week_of(d("2026-10-11")), (d("2026-10-05"), d("2026-10-11")));
        assert_eq!(week_of(d("2026-10-12")), (d("2026-10-12"), d("2026-10-18")));
    }

    #[test]
    fn start_times_as_local_wall_time() {
        let on = NaiveDate::from_ymd_opt(2026, 10, 9).unwrap();
        let want =
            Local.from_local_datetime(&on.and_hms_opt(8, 30, 0).unwrap()).earliest().unwrap().with_timezone(&Utc);
        assert_eq!(start_time("08:30", on).unwrap(), want);
        assert_eq!(start_time("2026-10-09T08:30", on).unwrap(), want);
        assert!(start_time("halb neun", on).is_err());
        assert_eq!(optional(Some("none".into()), Some("1020".into())), None);
        assert_eq!(optional(None, Some("1020".into())).as_deref(), Some("1020"));
    }
}
