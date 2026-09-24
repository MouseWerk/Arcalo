//! Desktop integration that needs no window system: the quick-capture window
//! (text → daily note or time booking) and the reminder decisions for native
//! notifications (end of day, timer still running late in the evening).

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc};
use serde::Serialize;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::settings::Settings;
use crate::tracking::{self, LogOutcome, Thresholds};
use crate::zeit;

// ------------------------------------------------------------ quick capture

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureKind {
    /// `/zeit …` – booked as time.
    Zeit,
    /// `- [ ] …` or `todo …` – a task in the daily note.
    Task,
    /// Anything else – a bullet in the daily note.
    Note,
}

/// Classifies one quick-capture line.
pub fn classify(line: &str) -> CaptureKind {
    let t = line.trim();
    if zeit::is_zeit_command(t) {
        CaptureKind::Zeit
    } else if t.starts_with("- [ ]") || todo_text(t).is_some() {
        CaptureKind::Task
    } else {
        CaptureKind::Note
    }
}

/// `todo Angebot` / `TODO: Angebot` → `Angebot`.
fn todo_text(line: &str) -> Option<&str> {
    let head = line.get(..4)?;
    if !head.eq_ignore_ascii_case("todo") {
        return None;
    }
    let rest = &line[4..];
    let rest = rest.strip_prefix(':').unwrap_or(rest);
    (rest.starts_with(char::is_whitespace) && !rest.trim().is_empty()).then(|| rest.trim())
}

/// The Markdown line a captured task or note becomes.
fn capture_markdown(line: &str) -> String {
    let t = line.trim();
    if let Some(task) = todo_text(t) {
        format!("- [ ] {task}")
    } else if is_list_item(t) {
        t.to_owned()
    } else {
        format!("- {t}")
    }
}

fn is_list_item(line: &str) -> bool {
    let t = line.trim_start();
    t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") || t == "-" || {
        let digits = t.chars().take_while(char::is_ascii_digit).count();
        digits > 0 && (t[digits..].starts_with(". ") || t[digits..].starts_with(") "))
    }
}

/// Appends `addition` (Markdown lines) to `content`: directly below a trailing list,
/// otherwise after a blank line.
fn append_markdown(content: &str, addition: &str) -> String {
    let body = content.trim_end();
    if body.is_empty() {
        return format!("{addition}\n");
    }
    let last = body.lines().last().unwrap_or("");
    let sep = if is_list_item(last) { "\n" } else { "\n\n" };
    format!("{body}{sep}{addition}\n")
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Appended {
    /// The daily note that received the lines.
    pub page_id: i64,
    pub tasks: usize,
    pub notes: usize,
}

/// Appends each non-empty line of `text` to the daily note of `date` (created if needed):
/// `- [ ] …` and `todo …` become tasks, anything else a bullet.
pub fn append_to_daily(db: &Database, date: NaiveDate, text: &str) -> Result<Appended> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        return Err(Error::State("Nichts zu erfassen".into()));
    }
    let tasks = lines.iter().filter(|l| classify(l) == CaptureKind::Task).count();
    let addition: Vec<String> = lines.iter().map(|l| capture_markdown(l)).collect();
    db.atomic(|| {
        let page = db.daily_note(date)?;
        let content = db.page_doc(page.id)?.content;
        db.save_page_content(page.id, &append_markdown(&content, &addition.join("\n")))?;
        Ok(Appended { page_id: page.id, tasks, notes: lines.len() - tasks })
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct CaptureOutcome {
    /// Set when lines went into the daily note.
    pub appended: Option<Appended>,
    /// One per `/zeit` line.
    pub bookings: Vec<LogOutcome>,
}

/// Handles quick-capture input: `/zeit` lines are booked, all other lines go to today's
/// daily note. It is all or nothing, so a typo does not leave half of the input captured.
pub fn capture<Tz: TimeZone>(
    db: &Database,
    text: &str,
    now: DateTime<Utc>,
    tz: &Tz,
    thresholds: &Thresholds,
) -> Result<CaptureOutcome> {
    let today = now.with_timezone(tz).date_naive();
    let (zeit_lines, other): (Vec<&str>, Vec<&str>) =
        text.lines().map(str::trim).filter(|l| !l.is_empty()).partition(|l| classify(l) == CaptureKind::Zeit);
    if zeit_lines.is_empty() && other.is_empty() {
        return Err(Error::State("Nichts zu erfassen".into()));
    }
    db.atomic(|| {
        let bookings = zeit_lines
            .iter()
            .map(|l| tracking::log_slash_command(db, l, now, tz, thresholds))
            .collect::<Result<Vec<_>>>()?;
        let appended = if other.is_empty() { None } else { Some(append_to_daily(db, today, &other.join("\n"))?) };
        Ok(CaptureOutcome { appended, bookings })
    })
}

// ----------------------------------------------------------------- reminders

/// Evening hour after which a still running timer is reported once.
pub const LATE_TIMER: NaiveTime = match NaiveTime::from_hms_opt(20, 0, 0) {
    Some(t) => t,
    None => panic!("valid time"),
};

/// Parses `HH:MM` (24 h).
pub fn parse_hhmm(s: &str) -> Option<NaiveTime> {
    let (h, m) = s.trim().split_once(':')?;
    if h.is_empty() || h.len() > 2 || m.len() != 2 {
        return None;
    }
    NaiveTime::from_hms_opt(h.parse().ok()?, m.parse().ok()?, 0)
}

/// Hours in German notation with at most one decimal, rounded down so 7:59 h never reads
/// as the full 8: `330` min → `5,5`, `480` → `8`.
pub fn format_hours(minutes: f64) -> String {
    let h = (minutes / 6.0 + 1e-9).floor() / 10.0;
    let s = format!("{h:.1}");
    s.strip_suffix(".0").unwrap_or(&s).replace('.', ",")
}

/// The end-of-day notification text, when one is due: at or after the reminder time on a
/// workday, less than the daily target booked and not yet reminded today.
pub fn end_of_day_reminder(
    now: NaiveDateTime,
    settings: &Settings,
    booked_minutes: i64,
    last_notified: Option<NaiveDate>,
) -> Option<String> {
    let at = parse_hhmm(settings.reminder_time.as_deref()?)?;
    // Switched off, or in the quiet hours (Settings → Benachrichtigungen; retried afterwards).
    if !settings.notifications.end_of_day || settings.notifications.is_quiet(now.time()) {
        return None;
    }
    let today = now.date();
    let workday = settings.workdays.contains(&today.weekday().number_from_monday());
    let target = settings.daily_target_hours * 60.0;
    if !workday || now.time() < at || last_notified == Some(today) || target <= 0.0 {
        return None;
    }
    ((booked_minutes as f64) < target).then(|| {
        format!(
            "Heute {} von {} h gebucht",
            format_hours(booked_minutes as f64),
            format_hours(settings.daily_target_hours * 60.0)
        )
    })
}

/// Whether to report a timer still running after [`LATE_TIMER`]: once a day, and not for a
/// timer that was deliberately started in the evening.
pub fn late_timer_reminder(
    now: NaiveDateTime,
    running_since: Option<NaiveDateTime>,
    last_notified: Option<NaiveDate>,
) -> bool {
    let Some(since) = running_since else { return false };
    let today = now.date();
    now.time() >= LATE_TIMER && last_notified != Some(today) && since < today.and_time(LATE_TIMER)
}

/// `NP-8801/1020` for a timer on a Vorgang, `NP-8801` otherwise.
pub fn timer_label(netzplan_nr: &str, vorgang_nr: Option<&str>) -> String {
    match vorgang_nr.filter(|v| !v.is_empty()) {
        Some(v) => format!("{netzplan_nr}/{v}"),
        None => netzplan_nr.to_owned(),
    }
}

/// Tray tooltip: `NP-8801/1020 · 01:23` while a timer runs, the app name otherwise.
pub fn tray_tooltip(running: Option<(&str, i64)>) -> String {
    match running {
        Some((label, minutes)) => {
            let m = minutes.max(0);
            format!("{label} · {:02}:{:02}", m / 60, m % 60)
        }
        None => "Annalo".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 23).unwrap() // a Wednesday
    }

    fn at(date: NaiveDate, h: u32, m: u32) -> NaiveDateTime {
        date.and_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn classifies_capture_lines() {
        assert_eq!(classify("/zeit NP-8801 1h"), CaptureKind::Zeit);
        assert_eq!(classify("  /ZEIT NP-8801 1h"), CaptureKind::Zeit);
        assert_eq!(classify("- [ ] Angebot senden"), CaptureKind::Task);
        assert_eq!(classify("todo Angebot senden"), CaptureKind::Task);
        assert_eq!(classify("TODO: Angebot senden"), CaptureKind::Task);
        assert_eq!(classify("todos aufräumen"), CaptureKind::Note);
        assert_eq!(classify("todo"), CaptureKind::Note);
        assert_eq!(classify("Idee: Cache vorwärmen"), CaptureKind::Note);
        assert_eq!(capture_markdown("todo: Angebot"), "- [ ] Angebot");
        assert_eq!(capture_markdown("- [ ] Angebot"), "- [ ] Angebot");
        assert_eq!(capture_markdown("Idee"), "- Idee");
        assert_eq!(capture_markdown("* schon Liste"), "* schon Liste");
    }

    #[test]
    fn appends_below_lists_and_after_paragraphs() {
        assert_eq!(append_markdown("", "- a"), "- a\n");
        assert_eq!(append_markdown("## Notizen\n\n", "- a"), "## Notizen\n\n- a\n");
        assert_eq!(append_markdown("- x\n\n\n", "- a"), "- x\n- a\n");
        assert_eq!(append_markdown("Absatz", "- a"), "Absatz\n\n- a\n");
        assert_eq!(append_markdown("1. eins\n", "- a"), "1. eins\n- a\n");
    }

    #[test]
    fn append_to_daily_creates_the_note_and_keeps_its_sections() {
        let db = Database::open_in_memory().unwrap();
        let out = append_to_daily(&db, day(), "Idee: Cache\n\ntodo Angebot senden\n- [ ] Review").unwrap();
        assert_eq!((out.tasks, out.notes), (2, 1));
        assert_eq!(out.page_id, db.daily_note(day()).unwrap().id);
        let content = db.page_doc(out.page_id).unwrap().content;
        assert_eq!(content, "## Fokus\n\n- [ ] \n\n## Notizen\n\n- Idee: Cache\n- [ ] Angebot senden\n- [ ] Review\n");
        append_to_daily(&db, day(), "noch was").unwrap();
        assert!(db.page_doc(out.page_id).unwrap().content.ends_with("- [ ] Review\n- noch was\n"));
        // The captured tasks are indexed like typed ones.
        let tasks = db.list_tasks(&Default::default()).unwrap();
        assert!(tasks.iter().any(|t| t.text.contains("Angebot senden")));
        assert!(append_to_daily(&db, day(), "  \n ").is_err());
    }

    #[test]
    fn capture_books_zeit_lines_and_appends_the_rest() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-1", "Rollout").unwrap();
        db.create_netzplan(p.id, "NP-8801", "NP-8801", "Integration", 10.0).unwrap();
        let tz = FixedOffset::east_opt(2 * 3600).unwrap();
        let now = Utc.with_ymd_and_hms(2026, 9, 23, 15, 0, 0).unwrap();
        let t = Thresholds::default();

        let out = capture(&db, "/zeit NP-8801 1.5h #DEV 'Review'\ntodo Nacharbeit", now, &tz, &t).unwrap();
        assert_eq!(out.bookings.len(), 1);
        assert_eq!(out.bookings[0].entry.duration_minutes, Some(90));
        let content = db.page_doc(out.appended.unwrap().page_id).unwrap().content;
        assert!(content.ends_with("- [ ] Nacharbeit\n"));

        // A bad /zeit line stores nothing at all.
        assert!(capture(&db, "/zeit NP-0000 1h\nNotiz", now, &tz, &t).is_err());
        assert!(!db.page_doc(db.daily_note(day()).unwrap().id).unwrap().content.contains("- Notiz"));
        assert_eq!(db.list_time_entries(&Default::default()).unwrap().len(), 1);
    }

    #[test]
    fn parses_reminder_times_and_formats_hours() {
        assert_eq!(parse_hhmm("17:30"), NaiveTime::from_hms_opt(17, 30, 0));
        assert_eq!(parse_hhmm(" 7:05 "), NaiveTime::from_hms_opt(7, 5, 0));
        for bad in ["", "17", "25:00", "17:3", "ab:cd", "17:30:00"] {
            assert_eq!(parse_hhmm(bad), None, "{bad}");
        }
        assert_eq!(format_hours(330.0), "5,5");
        assert_eq!(format_hours(480.0), "8");
        assert_eq!(format_hours(0.0), "0");
        assert_eq!(format_hours(7.5 * 60.0), "7,5");
        assert_eq!(format_hours(479.0), "7,9");
    }

    #[test]
    fn end_of_day_reminder_rules() {
        let s = Settings::default(); // 17:30, 8 h, Mon–Fri
        let wed = day();
        assert_eq!(end_of_day_reminder(at(wed, 17, 30), &s, 330, None).as_deref(), Some("Heute 5,5 von 8 h gebucht"));
        assert_eq!(end_of_day_reminder(at(wed, 21, 0), &s, 0, None).as_deref(), Some("Heute 0 von 8 h gebucht"));
        // Too early, target reached, already reminded today.
        assert_eq!(end_of_day_reminder(at(wed, 17, 29), &s, 0, None), None);
        assert_eq!(end_of_day_reminder(at(wed, 18, 0), &s, 480, None), None);
        assert_eq!(end_of_day_reminder(at(wed, 18, 0), &s, 0, Some(wed)), None);
        // Reminded yesterday counts for yesterday only.
        assert!(end_of_day_reminder(at(wed, 18, 0), &s, 0, wed.pred_opt()).is_some());
        // Weekend and switched off.
        let sat = NaiveDate::from_ymd_opt(2026, 9, 26).unwrap();
        assert_eq!(end_of_day_reminder(at(sat, 18, 0), &s, 0, None), None);
        let off = Settings { reminder_time: None, ..Settings::default() };
        assert_eq!(end_of_day_reminder(at(wed, 18, 0), &off, 0, None), None);
        let broken = Settings { reminder_time: Some("abends".into()), ..Settings::default() };
        assert_eq!(end_of_day_reminder(at(wed, 18, 0), &broken, 0, None), None);
        let custom = Settings { reminder_time: Some("16:00".into()), daily_target_hours: 7.5, ..Settings::default() };
        assert_eq!(
            end_of_day_reminder(at(wed, 16, 0), &custom, 60, None).as_deref(),
            Some("Heute 1 von 7,5 h gebucht")
        );
    }

    #[test]
    fn late_timer_is_reported_once_and_not_for_evening_timers() {
        let wed = day();
        let morning = Some(at(wed, 9, 0));
        assert!(!late_timer_reminder(at(wed, 19, 59), morning, None));
        assert!(late_timer_reminder(at(wed, 20, 0), morning, None));
        assert!(!late_timer_reminder(at(wed, 20, 30), morning, Some(wed)));
        assert!(!late_timer_reminder(at(wed, 20, 30), None, None));
        assert!(!late_timer_reminder(at(wed, 21, 0), Some(at(wed, 20, 15)), None));
        // Left running since yesterday.
        assert!(late_timer_reminder(at(wed, 20, 0), Some(at(wed.pred_opt().unwrap(), 22, 0)), wed.pred_opt()));
    }

    #[test]
    fn tooltip_shows_running_timer() {
        assert_eq!(tray_tooltip(Some((&timer_label("NP-8801", Some("1020")), 83))), "NP-8801/1020 · 01:23");
        assert_eq!(tray_tooltip(Some((&timer_label("NP-8801", None), 600))), "NP-8801 · 10:00");
        assert_eq!(tray_tooltip(None), "Annalo");
    }
}
