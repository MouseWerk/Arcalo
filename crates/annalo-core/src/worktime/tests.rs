use super::holidays::{buss_und_bettag, easter_sunday, holidays};
use super::*;
use crate::model::{EntrySource, NewTimeEntry};
use chrono::TimeZone;

fn d(y: i32, m: u32, day: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, day).unwrap()
}

fn names(year: i32, state: &str) -> Vec<(NaiveDate, String)> {
    holidays(year, state).into_iter().map(|h| (h.date, h.name)).collect()
}

fn has(year: i32, state: &str, name: &str) -> Option<NaiveDate> {
    holidays(year, state).into_iter().find(|h| h.name == name).map(|h| h.date)
}

#[test]
fn easter_based_holidays_2025_to_2030() {
    // Karfreitag, Ostermontag, Christi Himmelfahrt, Pfingstmontag, Fronleichnam.
    let expected = [
        (2025, d(2025, 4, 20), d(2025, 4, 18), d(2025, 4, 21), d(2025, 5, 29), d(2025, 6, 9), d(2025, 6, 19)),
        (2026, d(2026, 4, 5), d(2026, 4, 3), d(2026, 4, 6), d(2026, 5, 14), d(2026, 5, 25), d(2026, 6, 4)),
        (2027, d(2027, 3, 28), d(2027, 3, 26), d(2027, 3, 29), d(2027, 5, 6), d(2027, 5, 17), d(2027, 5, 27)),
        (2028, d(2028, 4, 16), d(2028, 4, 14), d(2028, 4, 17), d(2028, 5, 25), d(2028, 6, 5), d(2028, 6, 15)),
        (2029, d(2029, 4, 1), d(2029, 3, 30), d(2029, 4, 2), d(2029, 5, 10), d(2029, 5, 21), d(2029, 5, 31)),
        (2030, d(2030, 4, 21), d(2030, 4, 19), d(2030, 4, 22), d(2030, 5, 30), d(2030, 6, 10), d(2030, 6, 20)),
    ];
    for (y, easter, kf, om, ch, pm, fl) in expected {
        assert_eq!(easter_sunday(y), easter, "Easter {y}");
        assert_eq!(has(y, "BY", "Karfreitag"), Some(kf), "{y}");
        assert_eq!(has(y, "HH", "Ostermontag"), Some(om), "{y}");
        assert_eq!(has(y, "SN", "Christi Himmelfahrt"), Some(ch), "{y}");
        assert_eq!(has(y, "BE", "Pfingstmontag"), Some(pm), "{y}");
        assert_eq!(has(y, "NW", "Fronleichnam"), Some(fl), "{y}");
        assert_eq!(has(y, "BE", "Fronleichnam"), None, "no Fronleichnam in Berlin {y}");
    }
}

#[test]
fn buss_und_bettag_only_in_saxony() {
    let expected = [(2025, 19), (2026, 18), (2027, 17), (2028, 22), (2029, 21), (2030, 20)];
    for (y, day) in expected {
        assert_eq!(buss_und_bettag(y), d(y, 11, day), "{y}");
        assert_eq!(buss_und_bettag(y).weekday(), chrono::Weekday::Wed);
        assert_eq!(has(y, "SN", "Buß- und Bettag"), Some(d(y, 11, day)));
        assert_eq!(has(y, "BY", "Buß- und Bettag"), None);
    }
}

#[test]
fn state_specific_holidays() {
    for y in 2025..=2030 {
        // Heilige Drei Könige: BW, BY, ST.
        for s in ["BW", "BY", "ST"] {
            assert_eq!(has(y, s, "Heilige Drei Könige"), Some(d(y, 1, 6)), "{s} {y}");
        }
        assert_eq!(has(y, "NW", "Heilige Drei Könige"), None);
        // Frauentag: Berlin (and MV since 2023).
        assert_eq!(has(y, "BE", "Internationaler Frauentag"), Some(d(y, 3, 8)));
        assert_eq!(has(y, "HE", "Internationaler Frauentag"), None);
        // Mariä Himmelfahrt: BY and SL.
        assert_eq!(has(y, "SL", "Mariä Himmelfahrt"), Some(d(y, 8, 15)));
        assert_eq!(has(y, "BY", "Mariä Himmelfahrt"), Some(d(y, 8, 15)));
        assert_eq!(has(y, "BW", "Mariä Himmelfahrt"), None);
        // Weltkindertag: Thüringen.
        assert_eq!(has(y, "TH", "Weltkindertag"), Some(d(y, 9, 20)));
        assert_eq!(has(y, "SN", "Weltkindertag"), None);
        // Reformationstag in the north and east, Allerheiligen in the south and west.
        for s in ["BB", "HB", "HH", "MV", "NI", "SN", "ST", "SH", "TH"] {
            assert_eq!(has(y, s, "Reformationstag"), Some(d(y, 10, 31)), "{s} {y}");
        }
        for s in ["BW", "BY", "BE", "HE", "NW", "RP", "SL"] {
            assert_eq!(has(y, s, "Reformationstag"), None, "{s} {y}");
        }
        for s in ["BW", "BY", "NW", "RP", "SL"] {
            assert_eq!(has(y, s, "Allerheiligen"), Some(d(y, 11, 1)), "{s} {y}");
        }
        // Everywhere.
        for s in super::holidays::STATES {
            for (m, day) in [(1, 1), (5, 1), (10, 3), (12, 25), (12, 26)] {
                assert!(holidays(y, s).iter().any(|h| h.date == d(y, m, day)), "{s} {y}-{m}-{day}");
            }
        }
    }
    assert_eq!(has(2025, "BE", "Tag der Befreiung"), Some(d(2025, 5, 8)));
    assert_eq!(has(2026, "BE", "Tag der Befreiung"), None);
    // The Reformation's 500th anniversary was a holiday everywhere.
    assert_eq!(has(2017, "BY", "Reformationstag"), Some(d(2017, 10, 31)));
    assert_eq!(has(2018, "BY", "Reformationstag"), None);
    assert_eq!(has(2022, "MV", "Internationaler Frauentag"), None);
    assert_eq!(has(2023, "MV", "Internationaler Frauentag"), Some(d(2023, 3, 8)));
    // Counts: Bavaria has the most, Berlin and the north the fewest regular ones.
    assert_eq!(names(2026, "BY").len(), 13);
    assert_eq!(names(2026, "NW").len(), 11);
    assert_eq!(names(2026, "BE").len(), 10);
    assert_eq!(names(2026, "SN").len(), 11);
    assert!(holidays(2026, "").is_empty() && holidays(2026, "XX").is_empty());
    assert_eq!(holidays(2026, "by"), holidays(2026, "BY"), "case-insensitive");
    let sorted = names(2026, "BY");
    assert!(sorted.windows(2).all(|w| w[0].0 < w[1].0), "by date");
}

#[test]
fn day_targets_follow_holidays_and_absences() {
    let a = |kind, half| Absence { date: d(2026, 9, 1), kind, half, note: String::new() };
    assert_eq!(day_target(480, false, None, true), 480);
    assert_eq!(day_target(480, true, None, true), 0);
    assert_eq!(day_target(480, false, Some(&a(AbsenceKind::Vacation, false)), true), 0);
    assert_eq!(day_target(480, false, Some(&a(AbsenceKind::Sick, true)), true), 240);
    assert_eq!(day_target(450, false, Some(&a(AbsenceKind::Other, true)), true), 225);
    // Time off in lieu keeps the target for the balance, but is no gap.
    assert_eq!(day_target(480, false, Some(&a(AbsenceKind::Comp, false)), true), 480);
    assert_eq!(day_target(480, false, Some(&a(AbsenceKind::Comp, false)), false), 0);
}

fn world() -> (Database, i64, Settings) {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_project("PRJ", "Projekt").unwrap();
    let np = db.create_netzplan(p.id, "NP-1", "NP-1-1", "Netz", 100.0).unwrap();
    let mut s = Settings::default();
    s.time.balance.state = "BY".into();
    (db, np.id, s)
}

fn book(db: &Database, np: i64, day: NaiveDate, minutes: i64) {
    db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np,
        vorgang_nr: None,
        leistungsart: None,
        start_time: Utc.from_utc_datetime(&day.and_hms_opt(8, 0, 0).unwrap()),
        duration_minutes: minutes,
        description: String::new(),
        source: EntrySource::Manual,
        page_id: None,
    })
    .unwrap();
}

#[test]
fn balance_counts_holidays_absences_half_days_and_the_opening_balance() {
    let (db, np, mut s) = world();
    // Monday 28 September to Friday 2 October 2026; Thursday 1 October noon is „now“.
    s.time.balance.start = Some(d(2026, 9, 28));
    s.time.balance.opening_hours = 5.5;
    let today = d(2026, 10, 1);
    let now = Utc.with_ymd_and_hms(2026, 10, 1, 12, 0, 0).unwrap();
    book(&db, np, d(2026, 9, 28), 540); // +60
    book(&db, np, d(2026, 9, 29), 240); // half vacation: target 240 → 0
    db.absence_put(&Absence { date: d(2026, 9, 29), kind: AbsenceKind::Vacation, half: true, note: String::new() })
        .unwrap();
    // Wednesday sick: no target, nothing booked.
    db.absence_put(&Absence { date: d(2026, 9, 30), kind: AbsenceKind::Sick, half: false, note: String::new() })
        .unwrap();
    // Today: 3 h booked of 8 → in progress, counts nothing yet.
    book(&db, np, today, 180);
    let b = balance(&db, &s, &Utc, today, now, 4).unwrap();
    assert_eq!(b.minutes, 330 + 60);
    assert_eq!((b.today_booked, b.today_target), (180, 480));
    assert_eq!(b.booked_minutes, 780);
    assert_eq!(b.target_minutes, 480 + 240);
    assert!(b.configured && !b.running);
    // A running timer since 9:00 counts until now: 180 + 180 = 360, still below the target.
    db.start_timer(np, None, None, "", Utc.with_ymd_and_hms(2026, 10, 1, 9, 0, 0).unwrap()).unwrap();
    let b = balance(&db, &s, &Utc, today, now, 4).unwrap();
    assert!(b.running);
    assert_eq!(b.today_booked, 360);
    assert_eq!(b.minutes, 390);
    // At 17:00 the target is passed: 180 + 480 = 660 → +180 today.
    let later = Utc.with_ymd_and_hms(2026, 10, 1, 17, 0, 0).unwrap();
    let b = balance(&db, &s, &Utc, today, later, 4).unwrap();
    assert_eq!(b.minutes, 390 + 180);
    // Sparkline: the end of last week does not exist (start this week), today is the point.
    assert_eq!(b.weeks.last().map(|p| p.minutes), Some(b.minutes));
}

#[test]
fn balance_over_weeks_with_a_public_holiday() {
    let (db, np, mut s) = world();
    // Allerheiligen 2027 is a Monday; Fridays have a target of 6 h.
    s.time.balance.start = Some(d(2027, 11, 1));
    s.time.balance.weekday_hours = vec![8.0, 8.0, 8.0, 8.0, 6.0, 0.0, 0.0];
    for i in 1..=5 {
        book(&db, np, d(2027, 11, i), 480);
    }
    let today = d(2027, 11, 8);
    let now = Utc.with_ymd_and_hms(2027, 11, 8, 6, 0, 0).unwrap();
    let b = balance(&db, &s, &Utc, today, now, 3).unwrap();
    // Monday a holiday (+480), Tuesday–Thursday ±0, Friday 6 h target (+120).
    assert_eq!(b.minutes, 600);
    assert_eq!(b.weeks.len(), 2, "the week from 1 November and this one");
    assert_eq!(b.weeks[0], BalancePoint { week_start: d(2027, 11, 1), minutes: 600 });
    // Comp time today keeps the target: the balance pays for it once the day is over.
    db.absence_put(&Absence { date: today, kind: AbsenceKind::Comp, half: false, note: String::new() }).unwrap();
    let tomorrow = balance(&db, &s, &Utc, today + Duration::days(1), now + Duration::days(1), 3).unwrap();
    assert_eq!(tomorrow.minutes, 600 - 480);
    let _ = np;
}

#[test]
fn ranges_skip_weekends_and_holidays_and_vacation_is_counted() {
    let (db, _, mut s) = world();
    s.time.balance.vacation_days = 30.0;
    s.time.balance.carry_over = 2.5;
    // Friday 30 October to Tuesday 3 November 2026: Sat, Sun and Allerheiligen (Sunday) skipped.
    let days = save_range(&db, &s, d(2026, 10, 30), d(2026, 11, 3), AbsenceKind::Vacation, false, "Herbst").unwrap();
    assert_eq!(days, vec![d(2026, 10, 30), d(2026, 11, 2), d(2026, 11, 3)]);
    // One day is stored as chosen, even on a weekend; a half day counts ½.
    save_range(&db, &s, d(2026, 9, 1), d(2026, 9, 1), AbsenceKind::Vacation, true, "").unwrap();
    save_range(&db, &s, d(2026, 9, 2), d(2026, 9, 2), AbsenceKind::Sick, false, "").unwrap();
    let v = vacation(&db, &s, d(2026, 10, 1)).unwrap();
    assert_eq!((v.entitlement, v.taken, v.planned, v.left), (32.5, 0.5, 3.0, 29.0));
    assert_eq!(v.next_holiday.as_ref().map(|h| h.date), Some(d(2026, 10, 3)));
    assert_eq!(v.upcoming.len(), 1);
    assert_eq!((v.upcoming[0].from, v.upcoming[0].to, v.upcoming[0].days), (d(2026, 10, 30), d(2026, 11, 3), 3.0));
    assert!(save_range(&db, &s, d(2026, 1, 1), d(2027, 6, 1), AbsenceKind::Other, false, "").is_err());
    assert_eq!(db.absence_remove(d(2026, 11, 2), d(2026, 11, 3)).unwrap(), 2);
    // No gap on an absence day: the week proposal's target is 0, a half day half.
    assert_eq!(gap_target(&db, d(2026, 10, 30), 480).unwrap(), 0);
    assert_eq!(gap_target(&db, d(2026, 9, 1), 480).unwrap(), 240);
    assert_eq!(gap_target(&db, d(2026, 9, 3), 480).unwrap(), 480);
}

#[test]
fn prefs_are_normalized() {
    let p = BalancePrefs {
        weekday_hours: vec![8.0, 30.0, -1.0],
        vacation_days: f64::NAN,
        carry_over: 400.0,
        state: " nw ".into(),
        ..Default::default()
    }
    .normalized();
    assert!(p.weekday_hours.is_empty(), "not seven values");
    assert_eq!((p.vacation_days, p.carry_over, p.state.as_str()), (0.0, 366.0, "NW"));
    let p = BalancePrefs {
        weekday_hours: vec![9.0, 30.0, -1.0, 8.0, 6.0, 0.0, 0.0],
        state: "XY".into(),
        ..Default::default()
    }
    .normalized();
    assert_eq!(p.weekday_hours[1..3], [24.0, 0.0]);
    assert_eq!(p.state, "");
    let mut s = Settings::default();
    s.time.balance = p;
    assert_eq!(weekday_minutes(&s, d(2026, 9, 28)), 540);
    assert_eq!(weekday_minutes(&s, d(2026, 10, 2)), 360);
}
