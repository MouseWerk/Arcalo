//! Parser for the in-line `/zeit` slash command.
//!
//! ```text
//! /zeit <netzplan>[/<vorgang>] <dauer> [#LEISTUNGSART] ['Beschreibung'] [@datum] [@hh:mm]
//! ```
//!
//! Examples:
//!
//! * `/zeit NP-8801/1020 2.5h 'Systemintegration'`
//! * `/zeit NP-8801/ACT-001 1h30m #DEV "API Review" @gestern`
//! * `/zeit NP-8801-1020 90m Abstimmung mit Kunde @22.09.2026 @08:30`
//!
//! Durations accept `2.5h`, `2,5h`, `2.5std`, `90m`, `90min`, `1h30m` and `1:30`.
//! Unquoted trailing words become the description. `/time` is an alias.
//! With a default reference (a page linked to a Vorgang) the reference may be left
//! out: `/zeit 1.5h Abstimmung`. A first token that is a duration means "no reference".

use crate::{tr, trf};
use chrono::{Datelike, NaiveDate, NaiveTime};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZeitCommand {
    /// Netzplan number or WBS element, resolved by [`crate::Database::netzplan_by_ref`].
    pub netzplan_ref: String,
    pub vorgang_nr: Option<String>,
    pub duration_minutes: i64,
    pub leistungsart: Option<String>,
    pub description: String,
    pub date: DateSpec,
    pub start: Option<NaiveTime>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "date")]
pub enum DateSpec {
    Today,
    Yesterday,
    On(NaiveDate),
}

impl DateSpec {
    pub fn resolve(self, today: NaiveDate) -> NaiveDate {
        match self {
            DateSpec::Today => today,
            DateSpec::Yesterday => today.pred_opt().unwrap_or(today),
            DateSpec::On(d) => d,
        }
    }
}

/// Returns `true` if the line is a `/zeit` (or `/time`) command.
pub fn is_zeit_command(line: &str) -> bool {
    let first = line.split_whitespace().next().unwrap_or("");
    first.eq_ignore_ascii_case("/zeit") || first.eq_ignore_ascii_case("/time")
}

/// Parses a `/zeit` command. `today` is only used to complete `@dd.mm.` dates.
pub fn parse(line: &str, today: NaiveDate) -> Result<ZeitCommand> {
    parse_with_default(line, today, None)
}

/// Like [`parse`]; a command without reference books on `default_ref` (`NP-8801` or `NP-8801/1020`).
pub fn parse_with_default(line: &str, today: NaiveDate, default_ref: Option<&str>) -> Result<ZeitCommand> {
    let tokens = tokenize(line)?;
    let mut it = tokens.into_iter().peekable();

    match it.next() {
        Some(Token::Word(w)) if is_zeit_command(&w) => {}
        _ => {
            return Err(Error::Parse(
                tr!("Der Befehl muss mit /zeit beginnen", "The command must start with /time").into(),
            ));
        }
    }

    let default_ref = default_ref.map(str::trim).filter(|r| !r.is_empty());
    let target = match (it.peek(), default_ref) {
        (Some(Token::Word(w)), Some(d)) if parse_duration(w).is_ok() => d.to_owned(),
        (Some(Token::Word(w)), _) => {
            let w = w.clone();
            it.next();
            w
        }
        _ => {
            return Err(Error::Parse(
                tr!("Netzplan fehlt, z. B. NP-8801/1020", "Network missing, e.g. NP-8801/1020").into(),
            ));
        }
    };
    let (netzplan_ref, vorgang_nr) = match target.split_once('/') {
        Some((np, v)) if !np.is_empty() && !v.is_empty() => (np.to_owned(), Some(v.to_owned())),
        Some(_) => return Err(Error::Parse(trf!("Ungültiger Bezug „{target}“", "Invalid reference “{target}”"))),
        None => (target, None),
    };

    let duration_minutes = match it.next() {
        Some(Token::Word(w)) => parse_duration(&w)?,
        _ => {
            return Err(Error::Parse(
                tr!("Dauer fehlt, z. B. 2,5h oder 90m", "Duration missing, e.g. 2.5h or 90m").into(),
            ));
        }
    };

    let mut leistungsart = None;
    let mut date = DateSpec::Today;
    let mut start = None;
    let mut quoted: Option<String> = None;
    let mut words: Vec<String> = vec![];

    for tok in it {
        match tok {
            Token::Quoted(q) => {
                if quoted.replace(q).is_some() {
                    return Err(Error::Parse(
                        tr!(
                            "Nur eine Beschreibung in Anführungszeichen erlaubt",
                            "Only one description in quotes is allowed"
                        )
                        .into(),
                    ));
                }
            }
            Token::Word(w) if w.len() > 1 && w.starts_with('#') => {
                let code = w[1..].to_uppercase();
                if leistungsart.replace(code).is_some() {
                    return Err(Error::Parse(
                        tr!("Nur eine Leistungsart (#CODE) erlaubt", "Only one activity type (#CODE) is allowed")
                            .into(),
                    ));
                }
            }
            Token::Word(w) if w.len() > 1 && w.starts_with('@') => {
                let spec = &w[1..];
                if let Some(t) = parse_time(spec) {
                    start = Some(t);
                } else {
                    date = parse_date(spec, today)?;
                }
            }
            Token::Word(w) => words.push(w),
        }
    }

    let description = match (quoted, words.is_empty()) {
        (Some(q), true) => q,
        (None, _) => words.join(" "),
        (Some(_), false) => {
            return Err(Error::Parse(trf!(
                "Unerwarteter Text nach dem Bezug: „{}“",
                "Unexpected text after the reference: “{}”",
                words.join(" ")
            )));
        }
    };

    Ok(ZeitCommand { netzplan_ref, vorgang_nr, duration_minutes, leistungsart, description, date, start })
}

#[derive(Debug, PartialEq)]
enum Token {
    Word(String),
    Quoted(String),
}

fn closing_quote(open: char) -> Option<char> {
    match open {
        '\'' => Some('\''),
        '"' => Some('"'),
        '‘' => Some('’'),
        '“' => Some('”'),
        '„' => Some('“'),
        '«' => Some('»'),
        _ => None,
    }
}

fn tokenize(line: &str) -> Result<Vec<Token>> {
    let mut out = vec![];
    let mut chars = line.trim().chars().peekable();
    while let Some(&c) = chars.peek() {
        if c.is_whitespace() {
            chars.next();
            continue;
        }
        if let Some(close) = closing_quote(c) {
            chars.next();
            let mut s = String::new();
            loop {
                match chars.next() {
                    Some(ch) if ch == close => break,
                    // Accept a straight double quote closing a typographic opener.
                    Some('"') if matches!(c, '“' | '„') => break,
                    Some(ch) => s.push(ch),
                    None => {
                        return Err(Error::Parse(
                            tr!("Anführungszeichen nicht geschlossen", "Quotes not closed").into(),
                        ));
                    }
                }
            }
            out.push(Token::Quoted(s.trim().to_owned()));
        } else {
            let mut s = String::new();
            while let Some(&ch) = chars.peek() {
                if ch.is_whitespace() {
                    break;
                }
                s.push(ch);
                chars.next();
            }
            out.push(Token::Word(s));
        }
    }
    Ok(out)
}

/// Parses a duration token into whole minutes (rounded).
pub fn parse_duration(s: &str) -> Result<i64> {
    let err = || {
        Error::Parse(trf!(
            "Ungültige Dauer „{s}“ (z. B. 2,5h, 90m, 1h30m oder 1:30)",
            "Invalid duration “{s}” (e.g. 2.5h, 90m, 1h30m or 1:30)"
        ))
    };
    let lower = s.trim().to_lowercase().replace(',', ".");

    let minutes = if let Some((h, m)) = lower.split_once(':') {
        let h: u32 = h.parse().map_err(|_| err())?;
        let m: u32 = m.parse().map_err(|_| err())?;
        if m >= 60 || h > 24 {
            return Err(err());
        }
        f64::from(h * 60 + m)
    } else {
        // Sequence of <number><unit> pairs, e.g. "1h30m".
        let mut total = 0.0;
        let mut rest = lower.as_str();
        let mut seen = false;
        while !rest.is_empty() {
            let num_len = rest.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(rest.len());
            if num_len == 0 {
                return Err(err());
            }
            let value: f64 = rest[..num_len].parse().map_err(|_| err())?;
            rest = &rest[num_len..];
            let unit_len = rest.find(|c: char| c.is_ascii_digit() || c == '.').unwrap_or(rest.len());
            let factor = match &rest[..unit_len] {
                "h" | "std" | "stunde" | "stunden" | "hr" | "hrs" | "hour" | "hours" => 60.0,
                "m" | "min" | "mins" | "minute" | "minuten" | "minutes" => 1.0,
                _ => return Err(err()),
            };
            rest = &rest[unit_len..];
            total += value * factor;
            seen = true;
        }
        if !seen {
            return Err(err());
        }
        total
    };

    let minutes = minutes.round() as i64;
    if minutes <= 0 || minutes > 24 * 60 {
        return Err(Error::Parse(trf!(
            "Die Dauer „{s}“ muss zwischen 1 Minute und 24 Stunden liegen",
            "The duration “{s}” must be between 1 minute and 24 hours"
        )));
    }
    Ok(minutes)
}

fn parse_time(s: &str) -> Option<NaiveTime> {
    if !s.contains(':') || s.contains(['-', '.']) {
        return None;
    }
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}

/// A weekday written in German or English, short or long (`mo`, `montag`, `mon`, `monday`).
pub fn weekday_word(w: &str) -> Option<chrono::Weekday> {
    use chrono::Weekday::*;
    Some(match w.trim().trim_end_matches('.').to_lowercase().as_str() {
        "mo" | "montag" | "mon" | "monday" => Mon,
        "di" | "dienstag" | "tue" | "tues" | "tuesday" => Tue,
        "mi" | "mittwoch" | "wed" | "wednesday" => Wed,
        "do" | "donnerstag" | "thu" | "thur" | "thurs" | "thursday" => Thu,
        "fr" | "freitag" | "fri" | "friday" => Fri,
        "sa" | "samstag" | "sat" | "saturday" => Sat,
        "so" | "sonntag" | "sun" | "sunday" => Sun,
        _ => return None,
    })
}

fn parse_date(s: &str, today: NaiveDate) -> Result<DateSpec> {
    match s.to_lowercase().as_str() {
        "heute" | "today" => return Ok(DateSpec::Today),
        "gestern" | "yesterday" => return Ok(DateSpec::Yesterday),
        w => {
            // A weekday in either language: the most recent such day (today on that weekday).
            if let Some(wd) = weekday_word(w) {
                let back = (today.weekday().num_days_from_monday() + 7 - wd.num_days_from_monday()) % 7;
                return Ok(DateSpec::On(today - chrono::Days::new(u64::from(back))));
            }
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return Ok(DateSpec::On(d));
    }
    let trimmed = s.trim_end_matches('.');
    // "22.09.2026" or "22.9.26".
    if trimmed.matches('.').count() == 2 {
        let year = trimmed.rsplit('.').next().unwrap_or("");
        let fmt = if year.len() == 2 { "%d.%m.%y" } else { "%d.%m.%Y" };
        if let Ok(d) = NaiveDate::parse_from_str(trimmed, fmt)
            && d.year() >= 2000
        {
            return Ok(DateSpec::On(d));
        }
        return Err(Error::Parse(trf!(
            "Ungültiges Datum „@{s}“ (z. B. @heute, @gestern, @mo, @2026-09-22 oder @22.09.)",
            "Invalid date “@{s}” (e.g. @today, @yesterday, @mon, @2026-09-22 or @22.09.)"
        )));
    }
    // "22.09." or "22.09": the most recent such day (Dec dates in early January mean last year).
    if let Ok(d) = NaiveDate::parse_from_str(&format!("{trimmed}.{}", today.year()), "%d.%m.%Y") {
        let d = if d > today { d.with_year(today.year() - 1).unwrap_or(d) } else { d };
        return Ok(DateSpec::On(d));
    }
    Err(Error::Parse(trf!(
        "Ungültiges Datum „@{s}“ (z. B. @heute, @gestern, @mo, @2026-09-22 oder @22.09.)",
        "Invalid date “@{s}” (e.g. @today, @yesterday, @mon, @2026-09-22 or @22.09.)"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn huge_clock_duration_is_rejected_not_wrapped() {
        assert!(parse_duration("71582789:00").is_err());
    }

    #[test]
    fn dates_near_new_year_and_two_digit_years() {
        let jan2 = NaiveDate::from_ymd_opt(2027, 1, 2).unwrap();
        assert_eq!(parse_date("30.12.", jan2).unwrap(), DateSpec::On(NaiveDate::from_ymd_opt(2026, 12, 30).unwrap()));
        assert_eq!(parse_date("22.9.26", jan2).unwrap(), DateSpec::On(NaiveDate::from_ymd_opt(2026, 9, 22).unwrap()));
        assert!(parse_date("22.9.0026", jan2).is_err());
    }

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 23).unwrap()
    }

    #[test]
    fn parses_the_canonical_example() {
        let c = parse("/zeit NP-8801/1020 2.5h 'Systemintegration'", today()).unwrap();
        assert_eq!(c.netzplan_ref, "NP-8801");
        assert_eq!(c.vorgang_nr.as_deref(), Some("1020"));
        assert_eq!(c.duration_minutes, 150);
        assert_eq!(c.description, "Systemintegration");
        assert_eq!(c.date, DateSpec::Today);
        assert_eq!(c.leistungsart, None);
    }

    #[test]
    fn parses_all_options() {
        let c = parse("/zeit NP-8801/ACT-001 1h30m #dev „API Review“ @gestern @08:30", today()).unwrap();
        assert_eq!(c.vorgang_nr.as_deref(), Some("ACT-001"));
        assert_eq!(c.duration_minutes, 90);
        assert_eq!(c.leistungsart.as_deref(), Some("DEV"));
        assert_eq!(c.description, "API Review");
        assert_eq!(c.date.resolve(today()), NaiveDate::from_ymd_opt(2026, 9, 22).unwrap());
        assert_eq!(c.start, NaiveTime::from_hms_opt(8, 30, 0));
    }

    #[test]
    fn unquoted_words_become_description() {
        let c = parse("/time NP-8801-1020 90m Abstimmung mit Kunde @22.09.", today()).unwrap();
        assert_eq!(c.netzplan_ref, "NP-8801-1020");
        assert_eq!(c.vorgang_nr, None);
        assert_eq!(c.description, "Abstimmung mit Kunde");
        assert_eq!(c.date, DateSpec::On(NaiveDate::from_ymd_opt(2026, 9, 22).unwrap()));
    }

    #[test]
    fn duration_formats() {
        for (s, m) in [("2,5h", 150), ("2.5std", 150), ("45min", 45), ("1:05", 65), ("0.25h", 15), ("1h", 60)] {
            assert_eq!(parse_duration(s).unwrap(), m, "{s}");
        }
        for bad in ["", "h", "2x", "1:75", "25h", "0m", "-1h", "2.5"] {
            assert!(parse_duration(bad).is_err(), "{bad} should fail");
        }
    }

    #[test]
    fn english_and_german_words() {
        // Units in both languages.
        for (s, m) in [
            ("1.5h", 90),
            ("1,5h", 90),
            ("30m", 30),
            ("2hours", 120),
            ("1hr30mins", 90),
            ("2stunden", 120),
            ("20minuten", 20),
        ] {
            assert_eq!(parse_duration(s).unwrap(), m, "{s}");
        }
        // 2026-09-23 is a Wednesday: weekdays mean the most recent such day.
        let on = |d| DateSpec::On(NaiveDate::from_ymd_opt(2026, 9, d).unwrap());
        for (w, d) in [
            ("mon", 21),
            ("Monday", 21),
            ("Mo", 21),
            ("montag", 21),
            ("wed", 23),
            ("Mi", 23),
            ("fri", 18),
            ("Fr", 18),
            ("sun", 20),
            ("So", 20),
        ] {
            assert_eq!(parse_date(w, today()).unwrap(), on(d), "{w}");
        }
        assert_eq!(parse_date("yesterday", today()).unwrap(), DateSpec::Yesterday);
        assert_eq!(parse_date("gestern", today()).unwrap(), DateSpec::Yesterday);
        let c = parse("/time NP-8801/1020 1.5h review @yesterday", today()).unwrap();
        assert_eq!((c.duration_minutes, c.date), (90, DateSpec::Yesterday));
        let c = parse("/zeit NP-8801/1020 1,5h Review @Mo", today()).unwrap();
        assert_eq!((c.duration_minutes, c.date), (90, on(21)));
        let c = parse("/time NP-8801 30m standup @monday", today()).unwrap();
        assert_eq!((c.duration_minutes, c.date), (30, on(21)));
    }

    #[test]
    fn default_reference_when_the_first_token_is_a_duration() {
        let c = parse_with_default("/zeit 1.5h Abstimmung mit Kunde", today(), Some("NP-8801/1020")).unwrap();
        assert_eq!((c.netzplan_ref.as_str(), c.vorgang_nr.as_deref()), ("NP-8801", Some("1020")));
        assert_eq!((c.duration_minutes, c.description.as_str()), (90, "Abstimmung mit Kunde"));
        let c = parse_with_default("/zeit 90m #DEV", today(), Some("NP-8801")).unwrap();
        assert_eq!((c.netzplan_ref.as_str(), c.vorgang_nr), ("NP-8801", None));
        assert_eq!(c.leistungsart.as_deref(), Some("DEV"));
        // An explicit reference wins over the default.
        let c = parse_with_default("/zeit NP-7700/10 1h x", today(), Some("NP-8801/1020")).unwrap();
        assert_eq!((c.netzplan_ref.as_str(), c.vorgang_nr.as_deref()), ("NP-7700", Some("10")));
        // Without a default a leading duration is still an error, as is a blank default.
        assert!(parse("/zeit 1h x", today()).is_err());
        assert!(parse_with_default("/zeit 1h x", today(), Some("  ")).is_err());
        assert!(parse_with_default("/zeit", today(), Some("NP-8801")).is_err());
    }

    #[test]
    fn rejects_malformed_commands() {
        for bad in [
            "/zeit",
            "/zeit NP-8801/1020",
            "/zeit /1020 1h",
            "/zeit NP-8801/1020 1h 'open",
            "/zeit NP-8801 1h 'a' 'b'",
            "/zeit NP-8801 1h #DEV #PM",
            "/zeit NP-8801 1h @nextweek",
            "/note NP-8801 1h",
        ] {
            assert!(parse(bad, today()).is_err(), "{bad} should fail");
        }
    }
}
