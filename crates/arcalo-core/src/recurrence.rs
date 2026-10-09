//! Recurring tasks: the rule in a task line and the date of its next occurrence.
//!
//! The rule is plain text that other tools show as written: `every:daily`, `every:weekly`,
//! `every:mo,we`, `every:monthly`, `every:monthly,31`, `every:3d`, `every:2w`, an optional
//! `,done` (count from the day the task was done instead of its due date) and an optional end
//! `until:2026-12-31`. The value may also be words in German or English (`every:jede Woche`,
//! `every:wöchentlich`, `every:alle 3 Tage`, `every:jeden Montag und Mittwoch`). The repeat
//! marker of Obsidian Tasks (`every week on Monday when done` after its emoji) is read in imported
//! notes but never written.
//!
//! The next due date counts from the due date (from the day it was done with `,done`, or when the
//! task has no due date); dates that are already past are skipped, so ticking off an overdue task
//! gives one new task after today, not a backlog. Holidays are not taken into account.

use chrono::{Datelike, Duration, NaiveDate};
use serde::{Deserialize, Serialize};

/// The repeat marker of Obsidian Tasks; read in imported notes, never written.
pub const OBSIDIAN_RECUR: &str = "\u{1F501}";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Unit {
    Day,
    Week,
    Month,
    Year,
}

/// A repeat rule, see the module docs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recurrence {
    pub unit: Unit,
    /// Every `interval` units (at least 1).
    pub interval: u32,
    /// Weekly on these days, 0 Monday … 6 Sunday, sorted; empty: the weekday of the base date.
    #[serde(default)]
    pub weekdays: Vec<u8>,
    /// Monthly (or yearly, in the base date's month) on this day (1–31; a shorter month takes its
    /// last day); `None`: the base date's day.
    #[serde(default)]
    pub month_day: Option<u8>,
    /// No occurrence after this day (`YYYY-MM-DD`).
    #[serde(default)]
    pub until: Option<String>,
    /// Count from the day the task was done, not from its due date.
    #[serde(default)]
    pub when_done: bool,
}

const WEEKDAYS: [&str; 7] = ["mo", "tu", "we", "th", "fr", "sa", "su"];

fn weekday(w: &str) -> Option<u8> {
    Some(match w {
        "mo" | "mon" | "monday" | "mondays" | "montag" | "montags" | "montagen" => 0,
        "tu" | "tue" | "tues" | "tuesday" | "tuesdays" | "di" | "dienstag" | "dienstags" | "dienstagen" => 1,
        "we" | "wed" | "wednesday" | "wednesdays" | "mi" | "mittwoch" | "mittwochs" | "mittwochen" => 2,
        "th" | "thu" | "thur" | "thurs" | "thursday" | "thursdays" | "do" | "donnerstag" | "donnerstags"
        | "donnerstagen" => 3,
        "fr" | "fri" | "friday" | "fridays" | "freitag" | "freitags" | "freitagen" => 4,
        "sa" | "sat" | "saturday" | "saturdays" | "samstag" | "samstags" | "samstagen" | "sonnabend" => 5,
        "su" | "sun" | "sunday" | "sundays" | "so" | "sonntag" | "sonntags" | "sonntagen" => 6,
        _ => return None,
    })
}

/// A unit as a word (`week`, `wöchentlich`, `Tage`).
fn unit_word(w: &str) -> Option<Unit> {
    Some(match w {
        "day" | "days" | "daily" | "tag" | "tage" | "tagen" | "täglich" | "taeglich" => Unit::Day,
        "week" | "weeks" | "weekly" | "woche" | "wochen" | "wöchentlich" | "woechentlich" => Unit::Week,
        "month" | "months" | "monthly" | "monat" | "monate" | "monaten" | "monatlich" => Unit::Month,
        "year" | "years" | "yearly" | "annually" | "jahr" | "jahre" | "jahren" | "jährlich" | "jaehrlich" => {
            Unit::Year
        }
        _ => return None,
    })
}

/// A unit after a number without a space (`3d`, `2w`, `6m`, `1y`, `3tage`).
fn unit_suffix(s: &str) -> Option<Unit> {
    match s {
        "d" | "t" => Some(Unit::Day),
        "w" | "wk" => Some(Unit::Week),
        "m" => Some(Unit::Month),
        "y" | "j" => Some(Unit::Year),
        _ => unit_word(s),
    }
}

/// `YYYY-MM-DD` or `DD.MM.YYYY` as `YYYY-MM-DD`.
fn date_word(w: &str) -> Option<String> {
    NaiveDate::parse_from_str(w, "%Y-%m-%d")
        .or_else(|_| NaiveDate::parse_from_str(w, "%d.%m.%Y"))
        .ok()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

impl Recurrence {
    /// Reads a rule: the compact form (`weekly`, `mo,we`, `3d`, `monthly,31,done`) or words
    /// (`jede Woche`, `alle 3 Tage`, `every week on Monday when done`, `am 15.`). `None` when
    /// any word is not understood, so ordinary text never turns into a rule by accident.
    pub fn parse(spec: &str) -> Option<Recurrence> {
        // `-`, `_` and `,` separate words (`alle-3-tage`, `mo,we`), except inside a date.
        let lower = spec.to_lowercase();
        let norm: Vec<String> = lower
            .split([' ', '\t', ','])
            .flat_map(|w| {
                if date_word(w).is_some() {
                    vec![w.to_owned()]
                } else {
                    w.split(['-', '_', '+', ';', '/']).map(str::to_owned).collect()
                }
            })
            .filter(|w| !w.is_empty())
            .collect();
        let words: Vec<&str> = norm.iter().map(String::as_str).collect();
        let mut unit: Option<Unit> = None;
        let mut interval: Option<u32> = None;
        let mut weekdays: Vec<u8> = vec![];
        let mut month_day: Option<u8> = None;
        let mut until = None;
        let mut when_done = false;
        // A number not yet followed by its unit (`3 tage`); without one it is a day of the month
        // (`monthly 15`), but only in a rule that says monthly.
        let mut number: Option<u32> = None;
        let mut bare_day = false;
        let mut meaningful = false;
        let set_unit = |unit: &mut Option<Unit>, u: Unit| -> Option<()> {
            match unit {
                Some(cur) if *cur != u => None,
                _ => {
                    *unit = Some(u);
                    Some(())
                }
            }
        };
        let mut i = 0;
        while i < words.len() {
            let w = words[i];
            i += 1;
            if let Some(n) = number.take() {
                if let Some(u) = unit_word(w) {
                    set_unit(&mut unit, u)?;
                    interval = Some(n);
                    meaningful = true;
                    continue;
                }
                month_day = Some(u8::try_from(n).ok().filter(|d| (1..=31).contains(d))?);
                bare_day = true;
            }
            match w {
                "every" | "each" | "jede" | "jeden" | "jedes" | "jeder" | "jedem" | "alle" | "all" | "on" | "am"
                | "an" | "the" | "at" | "und" | "and" | "of" | "im" | "in" | "der" | "des" | "den" | "dem" | "ab"
                | "nach" | "from" | "after" => {}
                "other" | "zweite" | "zweiten" => interval = Some(2),
                "when" if words.get(i) == Some(&"done") => {
                    when_done = true;
                    i += 1;
                }
                "done" | "erledigt" | "erledigung" => when_done = true,
                "until" | "bis" | "ends" | "endet" => {
                    until = Some(date_word(words.get(i)?)?);
                    i += 1;
                }
                "last" | "letzten" | "letzter" | "letztes" | "ultimo" => {
                    month_day = Some(31);
                    if words.get(i).is_some_and(|n| matches!(*n, "day" | "tag" | "tage")) {
                        i += 1;
                    }
                    meaningful = true;
                }
                "weekday" | "weekdays" | "werktag" | "werktags" | "werktage" | "werktagen" => {
                    weekdays.extend(0..5);
                    meaningful = true;
                }
                "weekend" | "weekends" | "wochenende" | "wochenenden" => {
                    weekdays.extend(5..7);
                    meaningful = true;
                }
                "fortnight" | "fortnightly" => {
                    set_unit(&mut unit, Unit::Week)?;
                    interval = Some(2);
                    meaningful = true;
                }
                _ => {
                    if let Some(d) = weekday(w) {
                        weekdays.push(d);
                    } else if let Some(u) = unit_word(w) {
                        set_unit(&mut unit, u)?;
                    } else {
                        let digits = w.bytes().take_while(u8::is_ascii_digit).count();
                        if digits == 0 || digits > 3 {
                            return None;
                        }
                        let n: u32 = w[..digits].parse().ok()?;
                        match &w[digits..] {
                            "" => number = Some(n),
                            "." | "st" | "nd" | "rd" | "th" => {
                                month_day = Some(u8::try_from(n).ok().filter(|d| (1..=31).contains(d))?)
                            }
                            suffix => {
                                set_unit(&mut unit, unit_suffix(suffix)?)?;
                                interval = Some(n);
                            }
                        }
                    }
                    meaningful = true;
                }
            }
        }
        if let Some(n) = number {
            month_day = Some(u8::try_from(n).ok().filter(|d| (1..=31).contains(d))?);
            bare_day = true;
        }
        if bare_day && !matches!(unit, Some(Unit::Month | Unit::Year)) {
            return None;
        }
        if !meaningful {
            return None;
        }
        weekdays.sort_unstable();
        weekdays.dedup();
        let unit = match unit {
            Some(u) => u,
            None if !weekdays.is_empty() => Unit::Week,
            None if month_day.is_some() => Unit::Month,
            None => return None,
        };
        // Weekdays belong to weekly rules, a day of the month to monthly ones.
        let unit = if unit == Unit::Day && !weekdays.is_empty() && interval.is_none() { Unit::Week } else { unit };
        if (!weekdays.is_empty() && unit != Unit::Week)
            || (month_day.is_some() && !matches!(unit, Unit::Month | Unit::Year))
        {
            return None;
        }
        let interval = interval.unwrap_or(1);
        if !(1..=999).contains(&interval) {
            return None;
        }
        Some(Recurrence { unit, interval, weekdays, month_day, until, when_done })
    }

    /// The compact form written into notes (`weekly`, `2w,mo,we`, `monthly,31,done`).
    pub fn spec(&self) -> String {
        let n = self.interval.max(1);
        let mut parts: Vec<String> = vec![];
        match self.unit {
            Unit::Day => parts.push(if n == 1 { "daily".into() } else { format!("{n}d") }),
            Unit::Week if self.weekdays.is_empty() => {
                parts.push(if n == 1 { "weekly".into() } else { format!("{n}w") })
            }
            Unit::Week => {
                if n > 1 {
                    parts.push(format!("{n}w"));
                }
                parts.extend(self.weekdays.iter().filter_map(|d| WEEKDAYS.get(*d as usize)).map(|d| d.to_string()));
            }
            Unit::Month => {
                parts.push(if n == 1 { "monthly".into() } else { format!("{n}m") });
                if let Some(d) = self.month_day {
                    parts.push(d.to_string());
                }
            }
            Unit::Year => {
                parts.push(if n == 1 { "yearly".into() } else { format!("{n}y") });
                if let Some(d) = self.month_day {
                    parts.push(d.to_string());
                }
            }
        }
        if self.when_done {
            parts.push("done".into());
        }
        parts.join(",")
    }

    /// The tokens for a task line: `every:weekly`, plus ` until:2026-12-31` with an end.
    pub fn tokens(&self) -> String {
        match &self.until {
            Some(u) => format!("every:{} until:{u}", self.spec()),
            None => format!("every:{}", self.spec()),
        }
    }

    /// The occurrence after `d`.
    pub fn step(&self, d: NaiveDate) -> Option<NaiveDate> {
        let n = self.interval.max(1);
        match self.unit {
            Unit::Day => d.checked_add_signed(Duration::days(n.into())),
            Unit::Week if self.weekdays.is_empty() => d.checked_add_signed(Duration::weeks(n.into())),
            Unit::Week => {
                let wd = d.weekday().num_days_from_monday() as u8;
                if let Some(&later) = self.weekdays.iter().find(|&&x| x > wd) {
                    return d.checked_add_signed(Duration::days((later - wd).into()));
                }
                // The first chosen day of the week `n` weeks on.
                let monday = d - Duration::days(wd.into());
                monday.checked_add_signed(Duration::weeks(n.into()) + Duration::days(self.weekdays[0].into()))
            }
            Unit::Month => {
                // The chosen day may still lie ahead in this month (`monthly,15` due on the 10th).
                if let Some(day) = self.month_day
                    && let Some(this) = add_months(d, 0, day.into()).filter(|this| *this > d)
                {
                    return Some(this);
                }
                add_months(d, n, self.month_day.map_or(d.day(), u32::from))
            }
            Unit::Year => add_months(d, n.checked_mul(12)?, self.month_day.map_or(d.day(), u32::from)),
        }
    }

    /// The rule with the series' day of the month written into it, when the next occurrence of a
    /// task due on `base` would otherwise lose it: a monthly or yearly rule without a day, from
    /// the 29th, 30th or 31st (else 31 January, 28 February, 28 March … and 29 February,
    /// 28 February for good). `None` when nothing needs to change.
    pub fn pinned(&self, base: NaiveDate) -> Option<Recurrence> {
        let unpinned = matches!(self.unit, Unit::Month | Unit::Year) && self.month_day.is_none() && !self.when_done;
        (unpinned && base.day() > 28).then(|| Recurrence { month_day: u8::try_from(base.day()).ok(), ..self.clone() })
    }

    /// The due date of the next occurrence of a task due on `due` (if it has one) and done on
    /// `done_on`; `None` when the series ended (`until`).
    pub fn next_due(&self, due: Option<NaiveDate>, done_on: NaiveDate) -> Option<NaiveDate> {
        let base = match due {
            Some(d) if !self.when_done => d,
            _ => done_on,
        };
        let mut next = self.step(base)?;
        // Skip what is already past; bounded for a rule of every day over decades.
        let mut guard = 0;
        while next <= done_on && guard < 20_000 {
            next = self.step(next)?;
            guard += 1;
        }
        let until = self.until.as_deref().and_then(|u| NaiveDate::parse_from_str(u, "%Y-%m-%d").ok());
        (until.is_none_or(|u| next <= u)).then_some(next)
    }

    /// The next `n` due dates from a task due on `due` (or from `today`), for the dialog's preview.
    pub fn preview(&self, due: Option<NaiveDate>, today: NaiveDate, n: usize) -> Vec<NaiveDate> {
        let mut out = vec![];
        let mut cur = due;
        let mut done_on = today;
        while out.len() < n {
            let Some(next) = self.next_due(cur, done_on) else { break };
            out.push(next);
            cur = Some(next);
            done_on = next;
        }
        out
    }
}

/// `d` moved by `months`, on `day` (a shorter month takes its last day).
fn add_months(d: NaiveDate, months: u32, day: u32) -> Option<NaiveDate> {
    let total = d.year() * 12 + d.month0() as i32 + i32::try_from(months).ok()?;
    let (y, m) = (total.div_euclid(12), total.rem_euclid(12) as u32 + 1);
    let first_next = if m == 12 { NaiveDate::from_ymd_opt(y + 1, 1, 1) } else { NaiveDate::from_ymd_opt(y, m + 1, 1) }?;
    let last = (first_next - Duration::days(1)).day();
    NaiveDate::from_ymd_opt(y, m, day.clamp(1, last))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    fn r(s: &str) -> Recurrence {
        Recurrence::parse(s).unwrap_or_else(|| panic!("{s} not parsed"))
    }

    #[test]
    fn compact_and_word_forms() {
        for (input, spec) in [
            ("daily", "daily"),
            ("täglich", "daily"),
            ("jeden Tag", "daily"),
            ("weekly", "weekly"),
            ("jede Woche", "weekly"),
            ("wöchentlich", "weekly"),
            ("every week", "weekly"),
            ("mo,mi", "mo,we"),
            ("Mo, We", "mo,we"),
            ("jeden Montag und Mittwoch", "mo,we"),
            ("every week on Monday, Wednesday", "mo,we"),
            ("montags", "mo"),
            ("werktags", "mo,tu,we,th,fr"),
            ("monthly", "monthly"),
            ("monatlich", "monthly"),
            ("monthly,31", "monthly,31"),
            ("every month on the 15th", "monthly,15"),
            ("jeden Monat am 15.", "monthly,15"),
            ("am 15.", "monthly,15"),
            ("monatlich am letzten Tag", "monthly,31"),
            ("3d", "3d"),
            ("alle 3 Tage", "3d"),
            ("alle-3-tage", "3d"),
            ("every 3 days", "3d"),
            ("2w", "2w"),
            ("alle 2 Wochen", "2w"),
            ("every other week", "2w"),
            ("2w,mo,fr", "2w,mo,fr"),
            ("alle 2 Wochen am Freitag", "2w,fr"),
            ("3m", "3m"),
            ("yearly", "yearly"),
            ("jährlich", "yearly"),
            ("every day when done", "daily,done"),
            ("3d,done", "3d,done"),
            ("alle 3 Tage ab Erledigung", "3d,done"),
        ] {
            assert_eq!(r(input).spec(), spec, "{input}");
            assert_eq!(r(spec), r(input), "{spec} reads back");
        }
        let u = r("every week until 2026-12-31");
        assert_eq!(u.until.as_deref(), Some("2026-12-31"));
        assert_eq!(u.tokens(), "every:weekly until:2026-12-31");
        assert_eq!(r("wöchentlich bis 31.12.2026").until.as_deref(), Some("2026-12-31"));
    }

    #[test]
    fn ordinary_words_are_no_rule() {
        for s in [
            "",
            "Bericht",
            "weekly Bericht",
            "jede",
            "3",
            "40",
            "monthly mo",
            "mo,15",
            "daily weekly",
            "0d",
            "1000d",
            "bis",
            "jede Woche bis morgen",
        ] {
            assert_eq!(Recurrence::parse(s), None, "{s}");
        }
    }

    #[test]
    fn a_day_of_the_month_still_ahead_comes_first_and_yearly_keeps_a_set_day() {
        assert_eq!(r("monthly,15").next_due(Some(d("2026-01-10")), d("2026-01-10")), Some(d("2026-01-15")));
        assert_eq!(r("monthly,15").next_due(Some(d("2026-01-15")), d("2026-01-15")), Some(d("2026-02-15")));
        assert_eq!(r("monthly,15").next_due(Some(d("2026-01-20")), d("2026-01-20")), Some(d("2026-02-15")));
        assert_eq!(r("3m,15").next_due(Some(d("2026-01-10")), d("2026-01-10")), Some(d("2026-01-15")));
        assert_eq!(r("monthly,31").next_due(Some(d("2026-04-10")), d("2026-04-10")), Some(d("2026-04-30")));
        assert_eq!(r("yearly,29").spec(), "yearly,29");
        let feb29: Vec<NaiveDate> = r("yearly,29").preview(Some(d("2024-02-29")), d("2024-02-29"), 4);
        assert_eq!(feb29, [d("2025-02-28"), d("2026-02-28"), d("2027-02-28"), d("2028-02-29")]);
        assert_eq!(r("monthly").pinned(d("2026-01-31")).map(|p| p.spec()), Some("monthly,31".into()));
        assert_eq!(r("yearly").pinned(d("2024-02-29")).map(|p| p.spec()), Some("yearly,29".into()));
        assert_eq!(r("monthly").pinned(d("2026-01-28")), None);
        assert_eq!(r("monthly,15").pinned(d("2026-01-31")), None);
        assert_eq!(r("weekly").pinned(d("2026-01-31")), None);
        // A bare day only with a monthly or yearly unit.
        assert!(Recurrence::parse("weekly 15").is_none());
    }

    #[test]
    fn next_dates() {
        // From the due date, past dates skipped.
        assert_eq!(r("daily").next_due(Some(d("2026-10-05")), d("2026-10-05")), Some(d("2026-10-06")));
        assert_eq!(r("daily").next_due(Some(d("2026-10-01")), d("2026-10-05")), Some(d("2026-10-06")));
        assert_eq!(r("weekly").next_due(Some(d("2026-10-05")), d("2026-10-03")), Some(d("2026-10-12")));
        assert_eq!(r("3d").next_due(Some(d("2026-10-05")), d("2026-10-05")), Some(d("2026-10-08")));
        // Weekdays: Monday 5 Oct -> Wednesday, Wednesday -> Monday next week.
        assert_eq!(r("mo,we").next_due(Some(d("2026-10-05")), d("2026-10-05")), Some(d("2026-10-07")));
        assert_eq!(r("mo,we").next_due(Some(d("2026-10-07")), d("2026-10-07")), Some(d("2026-10-12")));
        assert_eq!(r("2w,mo,we").next_due(Some(d("2026-10-07")), d("2026-10-07")), Some(d("2026-10-19")));
        // Monthly: clamped to the last day; an explicit day comes back after a short month.
        assert_eq!(r("monthly").next_due(Some(d("2026-01-31")), d("2026-01-31")), Some(d("2026-02-28")));
        assert_eq!(r("monthly,31").next_due(Some(d("2026-02-28")), d("2026-02-28")), Some(d("2026-03-31")));
        assert_eq!(r("monthly,31").next_due(Some(d("2028-01-31")), d("2028-01-31")), Some(d("2028-02-29")));
        assert_eq!(r("3m").next_due(Some(d("2026-11-15")), d("2026-11-15")), Some(d("2027-02-15")));
        assert_eq!(r("yearly").next_due(Some(d("2028-02-29")), d("2028-02-29")), Some(d("2029-02-28")));
        // When done, or without a due date: from the day it was done.
        assert_eq!(r("3d,done").next_due(Some(d("2026-10-01")), d("2026-10-02")), Some(d("2026-10-05")));
        assert_eq!(r("weekly").next_due(None, d("2026-10-07")), Some(d("2026-10-14")));
        assert_eq!(r("mo").next_due(None, d("2026-10-07")), Some(d("2026-10-12")));
        // The end.
        let mut until = r("weekly");
        until.until = Some("2026-10-12".into());
        assert_eq!(until.next_due(Some(d("2026-10-05")), d("2026-10-05")), Some(d("2026-10-12")));
        assert_eq!(until.next_due(Some(d("2026-10-12")), d("2026-10-12")), None);
        assert_eq!(
            r("mo,fr").preview(Some(d("2026-10-05")), d("2026-10-05"), 3),
            [d("2026-10-09"), d("2026-10-12"), d("2026-10-16")]
        );
    }
}
