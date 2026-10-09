//! German public holidays („gesetzliche Feiertage“) per state (Bundesland), computed: the fixed
//! ones, the ones that follow Easter (Gauss/Meeus algorithm for the Gregorian calendar) and
//! Buß- und Bettag in Sachsen (the Wednesday before 23 November).
//!
//! Holidays that only apply in some communities of a state (Fronleichnam in parts of Sachsen
//! and Thüringen, Mariä Himmelfahrt in Bavaria's Catholic communities) follow the common
//! reading: Fronleichnam not in SN/TH, Mariä Himmelfahrt in BY and SL.

use chrono::{Datelike, Duration, NaiveDate, Weekday};
use serde::Serialize;

/// The 16 states by their usual abbreviation.
pub const STATES: [&str; 16] =
    ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"];

/// One public holiday.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Holiday {
    pub date: NaiveDate,
    /// German name („Christi Himmelfahrt“).
    pub name: String,
    /// English name („Ascension Day“).
    pub name_en: String,
}

/// Easter Sunday of `year` (Gregorian calendar).
pub fn easter_sunday(year: i32) -> NaiveDate {
    let a = year % 19;
    let b = year / 100;
    let c = year % 100;
    let d = b / 4;
    let e = b % 4;
    let f = (b + 8) / 25;
    let g = (b - f + 1) / 3;
    let h = (19 * a + b - d - g + 15) % 30;
    let i = c / 4;
    let k = c % 4;
    let l = (32 + 2 * e + 2 * i - h - k) % 7;
    let m = (a + 11 * h + 22 * l) / 451;
    let month = (h + l - 7 * m + 114) / 31;
    let day = (h + l - 7 * m + 114) % 31 + 1;
    NaiveDate::from_ymd_opt(year, month as u32, day as u32).expect("Easter is a valid date")
}

/// Buß- und Bettag: the last Wednesday before 23 November.
pub fn buss_und_bettag(year: i32) -> NaiveDate {
    let mut d = NaiveDate::from_ymd_opt(year, 11, 22).expect("valid date");
    while d.weekday() != Weekday::Wed {
        d -= Duration::days(1);
    }
    d
}

/// Whether `state` is one of [`STATES`] (case-insensitive).
pub fn is_state(state: &str) -> bool {
    STATES.iter().any(|s| s.eq_ignore_ascii_case(state.trim()))
}

/// The public holidays of `year` in `state` (empty for an unknown or empty state), by date.
pub fn holidays(year: i32, state: &str) -> Vec<Holiday> {
    let state = state.trim().to_ascii_uppercase();
    if !is_state(&state) {
        return vec![];
    }
    let in_ = |list: &[&str]| list.contains(&state.as_str());
    let fixed = |m: u32, d: u32| NaiveDate::from_ymd_opt(year, m, d).expect("valid date");
    let easter = easter_sunday(year);
    let after = |days: i64| easter + Duration::days(days);
    let mut out: Vec<(NaiveDate, &str, &str)> = vec![
        (fixed(1, 1), "Neujahr", "New Year's Day"),
        (after(-2), "Karfreitag", "Good Friday"),
        (after(1), "Ostermontag", "Easter Monday"),
        (fixed(5, 1), "Tag der Arbeit", "Labour Day"),
        (after(39), "Christi Himmelfahrt", "Ascension Day"),
        (after(50), "Pfingstmontag", "Whit Monday"),
        (fixed(10, 3), "Tag der Deutschen Einheit", "German Unity Day"),
        (fixed(12, 25), "1. Weihnachtstag", "Christmas Day"),
        (fixed(12, 26), "2. Weihnachtstag", "Boxing Day"),
    ];
    if in_(&["BW", "BY", "ST"]) {
        out.push((fixed(1, 6), "Heilige Drei Könige", "Epiphany"));
    }
    if (state == "BE" && year >= 2019) || (state == "MV" && year >= 2023) {
        out.push((fixed(3, 8), "Internationaler Frauentag", "International Women's Day"));
    }
    if state == "BE" && (year == 2020 || year == 2025) {
        // Twice so far, for the 75th and the 80th anniversary of the end of the war.
        out.push((fixed(5, 8), "Tag der Befreiung", "Liberation Day"));
    }
    if state == "BB" {
        out.push((easter, "Ostersonntag", "Easter Sunday"));
        out.push((after(49), "Pfingstsonntag", "Whit Sunday"));
    }
    if in_(&["BW", "BY", "HE", "NW", "RP", "SL"]) {
        out.push((after(60), "Fronleichnam", "Corpus Christi"));
    }
    if in_(&["BY", "SL"]) {
        out.push((fixed(8, 15), "Mariä Himmelfahrt", "Assumption Day"));
    }
    if state == "TH" && year >= 2019 {
        out.push((fixed(9, 20), "Weltkindertag", "World Children's Day"));
    }
    // Reformationstag: in the north and east (in HB, HH, NI and SH since 2018).
    // 2017 (500 years of the Reformation) in every state, once.
    if in_(&["BB", "MV", "SN", "ST", "TH"]) || (in_(&["HB", "HH", "NI", "SH"]) && year >= 2018) || year == 2017 {
        out.push((fixed(10, 31), "Reformationstag", "Reformation Day"));
    }
    if in_(&["BW", "BY", "NW", "RP", "SL"]) {
        out.push((fixed(11, 1), "Allerheiligen", "All Saints' Day"));
    }
    if state == "SN" {
        out.push((buss_und_bettag(year), "Buß- und Bettag", "Day of Repentance and Prayer"));
    }
    out.sort_by_key(|h| h.0);
    out.into_iter().map(|(date, de, en)| Holiday { date, name: de.into(), name_en: en.into() }).collect()
}

/// The public holidays of `state` from `from` to `to` (both included).
pub fn holidays_between(from: NaiveDate, to: NaiveDate, state: &str) -> Vec<Holiday> {
    if to < from {
        return vec![];
    }
    (from.year()..=to.year()).flat_map(|y| holidays(y, state)).filter(|h| h.date >= from && h.date <= to).collect()
}
