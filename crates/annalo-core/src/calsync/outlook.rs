//! Outlook Classic (Windows): the bundled PowerShell script reads the default calendar through
//! Outlook's COM object model (`Outlook.Application` → MAPI → `GetDefaultFolder(9)`, items sorted
//! by start with recurrences, restricted to the window) and prints JSON; this module runs it
//! (hidden, with a timeout, off the async runtime by the caller) and turns its output into
//! events. No admin rights and no app registration are needed: the script runs as the user,
//! against the Outlook profile that is already signed in.
//!
//! For development and tests, `ANNALO_OUTLOOK_FIXTURE` names a JSON file that replaces the
//! script's output; it is only honored when `ANNALO_TEST_FIXTURES=1` is set as well.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde_json::Value;

use super::tz::Zone;
use super::{Busy, NewEvent, Privacy, instant_id, meeting_link};
use crate::error::{Error, Result};
use crate::outlookcom::{self, Script};

/// The script, embedded so every build (and every installer) carries it.
pub const SCRIPT: &str = include_str!("outlook.ps1");

/// File name of the script in the data folder (written before each run when it differs).
pub const SCRIPT_FILE: &str = "outlook-calendar.ps1";

/// Outlook may have to start first; a security prompt may wait for the user.
pub const TIMEOUT: Duration = Duration::from_secs(120);

/// The fixture file replacing the script (tests and development on other systems).
pub fn fixture_path() -> Option<PathBuf> {
    if std::env::var("ANNALO_TEST_FIXTURES").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var_os("ANNALO_OUTLOOK_FIXTURE").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Whether the Outlook source can be offered here.
pub fn available() -> bool {
    cfg!(windows) || fixture_path().is_some()
}

/// Formats a local time for `Items.Restrict` like the user's regional settings do: the short
/// date pattern (`dd.MM.yyyy`, `M/d/yyyy`, …) and the short time pattern (`HH:mm`, `h:mm tt`).
/// Day and month names are not used by these patterns and written as numbers.
pub fn restrict_value(t: NaiveDateTime, date_pattern: &str, time_pattern: &str, am: &str, pm: &str) -> String {
    format!("{} {}", dotnet_format(t, date_pattern, am, pm), dotnet_format(t, time_pattern, am, pm)).trim().to_owned()
}

/// A .NET custom date/time pattern (`d dd M MM yy yyyy H HH h hh m mm s ss t tt`, quoted literals).
fn dotnet_format(t: NaiveDateTime, pattern: &str, am: &str, pm: &str) -> String {
    use chrono::{Datelike, Timelike};
    let chars: Vec<char> = pattern.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let mut n = 1;
        while i + n < chars.len() && chars[i + n] == c {
            n += 1;
        }
        let pad = |v: u32, width: usize| format!("{v:0width$}");
        let h12 = match t.hour() % 12 {
            0 => 12,
            h => h,
        };
        match c {
            'd' => out.push_str(&pad(t.day(), n.min(2))),
            'M' => out.push_str(&pad(t.month(), n.min(2))),
            'y' => {
                if n <= 2 {
                    out.push_str(&pad(t.year() as u32 % 100, n));
                } else {
                    out.push_str(&pad(t.year() as u32, n));
                }
            }
            'H' => out.push_str(&pad(t.hour(), n.min(2))),
            'h' => out.push_str(&pad(h12, n.min(2))),
            'm' => out.push_str(&pad(t.minute(), n.min(2))),
            's' => out.push_str(&pad(t.second(), n.min(2))),
            't' => {
                let d = if t.hour() < 12 { am } else { pm };
                out.push_str(if n == 1 { d.get(..1).unwrap_or("") } else { d });
            }
            '\'' | '"' => {
                // Quoted literal.
                let mut j = i + 1;
                while j < chars.len() && chars[j] != c {
                    out.push(chars[j]);
                    j += 1;
                }
                i = j + 1;
                continue;
            }
            _ => {
                for _ in 0..n {
                    out.push(c);
                }
            }
        }
        i += n;
    }
    out.trim().to_owned()
}

/// The user's short date and time patterns and AM/PM designators (Windows regional settings,
/// which Outlook uses to read the dates of a Restrict filter).
#[cfg(windows)]
pub fn regional_patterns() -> Option<(String, String, String, String)> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_SZ, RegGetValueW};
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }
    fn string(name: &str) -> String {
        let (key, name) = (wide(r"Control Panel\International"), wide(name));
        let mut buf = vec![0u16; 256];
        let mut size = (buf.len() * 2) as u32;
        // SAFETY: valid NUL-terminated strings and a buffer of `size` bytes.
        let rc = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buf.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if rc != 0 {
            return String::new();
        }
        let len = (size as usize / 2).saturating_sub(1).min(buf.len());
        String::from_utf16_lossy(&buf[..len]).trim_end_matches('\0').to_owned()
    }
    let date = string("sShortDate");
    let time = match string("sShortTime") {
        t if t.is_empty() => string("sTimeFormat"),
        t => t,
    };
    if date.is_empty() || time.is_empty() {
        return None;
    }
    Some((date, time, string("s1159"), string("s2359")))
}

#[cfg(not(windows))]
pub fn regional_patterns() -> Option<(String, String, String, String)> {
    None
}

/// What to read.
#[derive(Debug, Clone, Copy)]
pub struct Request {
    /// Local wall-clock times.
    pub from: NaiveDateTime,
    pub to: NaiveDateTime,
    pub privacy: Privacy,
}

/// Reads the Outlook calendar (blocking: run it off the async runtime). `script_dir` receives
/// the script file.
pub fn read(script_dir: &Path, req: Request, local: &Zone) -> Result<Vec<NewEvent>> {
    if let Some(fixture) = fixture_path() {
        let text = std::fs::read_to_string(&fixture)?;
        return parse_output(&text, local, req.privacy);
    }
    if !cfg!(windows) {
        return Err(Error::State(
            "Outlook (klassisch) gibt es nur unter Windows. Hier den Kalender als ICS-Datei oder -Adresse einbinden."
                .into(),
        ));
    }
    let fmt = |t: NaiveDateTime| t.format("%Y-%m-%dT%H:%M:%S").to_string();
    let mut args: Vec<OsString> = vec!["-From".into(), fmt(req.from).into(), "-To".into(), fmt(req.to).into()];
    if let Some((date, time, am, pm)) = regional_patterns() {
        args.extend([
            "-FilterFrom".into(),
            restrict_value(req.from, &date, &time, &am, &pm).into(),
            "-FilterTo".into(),
            restrict_value(req.to, &date, &time, &am, &pm).into(),
        ]);
    }
    for (on, flag) in [
        (req.privacy.private_details, "-Private"),
        (req.privacy.include_body, "-Body"),
        (req.privacy.meeting_links, "-Links"),
    ] {
        if on {
            args.push(flag.into());
        }
    }
    let stdout = outlookcom::run(
        script_dir,
        Script { file: SCRIPT_FILE, source: SCRIPT },
        &args,
        TIMEOUT,
        "Später erneut synchronisieren.",
    )?;
    parse_output(&stdout, local, req.privacy)
}

/// The German message for an error code of the script.
fn error_text(code: &str, detail: &str) -> String {
    let ics = "Stattdessen den Kalender als ICS-Adresse abonnieren (Outlook im Web: Einstellungen → Kalender → \
               Freigegebene Kalender → Kalender veröffentlichen) oder als .ics-Datei einbinden.";
    match code {
        "not_installed" => format!("Outlook (klassisch) ist auf diesem Computer nicht installiert. {ics}"),
        "new_outlook" => format!("Hier läuft das neue Outlook; es erlaubt anderen Programmen keinen Zugriff auf den Kalender. {ics}"),
        "server_exec" => "Outlook läuft mit anderen Rechten als Annalo (z. B. „Als Administrator ausführen“). Outlook normal starten und erneut synchronisieren.".into(),
        "constrained" => format!("PowerShell ist auf diesem Computer eingeschränkt (Sprachmodus „{detail}“), der Zugriff auf Outlook ist so nicht möglich. {ics}"),
        "folder" => format!("Der Outlook-Kalender ließ sich nicht öffnen ({detail}). Ist in Outlook ein Konto eingerichtet?"),
        _ => format!("Outlook hat den Kalender nicht geliefert: {}", if detail.is_empty() { code } else { detail }),
    }
}

use outlookcom::{int as n, list, text as s};

fn b(v: &Value, k: &str) -> bool {
    outlookcom::truthy(&v[k])
}

/// `2026-09-25T08:00:00Z`, `…+02:00`, a local `2026-09-25T10:00:00` or `/Date(1758787200000)/`.
fn instant(raw: &str, local: &Zone) -> Option<DateTime<Utc>> {
    let r = raw.trim();
    if let Some(ms) = r.strip_prefix("/Date(").and_then(|x| x.strip_suffix(")/")) {
        let ms: i64 = ms.split(['+', '-']).next().filter(|x| !x.is_empty())?.parse().ok()?;
        return Utc.timestamp_millis_opt(ms).single();
    }
    if let Ok(t) = DateTime::parse_from_rfc3339(r) {
        return Some(t.with_timezone(&Utc));
    }
    let naive = NaiveDateTime::parse_from_str(r.trim_end_matches(['Z', 'z']), "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    Some(if r.ends_with(['Z', 'z']) { Utc.from_utc_datetime(&naive) } else { local.to_utc(naive) })
}

fn local_date(raw: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(raw.trim().get(..10)?, "%Y-%m-%d").ok()
}

/// The script's output as events. Declined and cancelled meetings are left out.
pub fn parse_output(text: &str, local: &Zone, privacy: Privacy) -> Result<Vec<NewEvent>> {
    let v = outlookcom::json(text)?;
    if let Some((code, message)) = outlookcom::failure(&v) {
        return Err(Error::State(error_text(&code, &message)));
    }
    let items = outlookcom::items(&v, "items");
    let mut out = vec![];
    for it in &items {
        // olResponseDeclined; olMeetingCanceled / olMeetingReceivedAndCanceled.
        if n(it, "responseStatus") == 4 || matches!(n(it, "meetingStatus"), 5 | 7) {
            continue;
        }
        let uid = match s(it, "globalId") {
            g if !g.is_empty() => g,
            _ => s(it, "entryId"),
        };
        if uid.is_empty() {
            continue;
        }
        let all_day = b(it, "allDay");
        let (start, end) = if all_day {
            let (Some(d0), Some(d1)) = (local_date(&s(it, "startLocal")), local_date(&s(it, "endLocal"))) else {
                continue;
            };
            // An all-day end is midnight of the next day; a stray time rounds up.
            let d1 = if s(it, "endLocal").get(11..).is_some_and(|t| !t.starts_with("00:00")) {
                d1.succ_opt().unwrap_or(d1)
            } else {
                d1
            };
            let midnight = |d: NaiveDate| local.to_utc(d.and_hms_opt(0, 0, 0).unwrap());
            (midnight(d0), midnight(d1.max(d0.succ_opt().unwrap_or(d0))))
        } else {
            let start = instant(&s(it, "start"), local).or_else(|| instant(&s(it, "startLocal"), local));
            let end = instant(&s(it, "end"), local).or_else(|| instant(&s(it, "endLocal"), local));
            let (Some(start), Some(end)) = (start, end) else { continue };
            (start, end.max(start))
        };
        let recurring = b(it, "recurring");
        let instance = match (recurring, all_day) {
            (false, _) => String::new(),
            (true, true) => {
                local_date(&s(it, "startLocal")).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
            }
            (true, false) => instant_id(start),
        };
        let location = s(it, "location");
        let urls = list(it, "urls", &[' ']);
        let sensitivity = n(it, "sensitivity");
        let mut ev = NewEvent {
            uid,
            instance,
            recurring,
            start,
            end,
            all_day,
            title: s(it, "subject"),
            organizer: s(it, "organizer"),
            attendees: list(it, "attendees", &[';']),
            body: Some(s(it, "body")).filter(|x| !x.is_empty()),
            link: meeting_link(urls.iter().map(String::as_str).chain([location.as_str()])),
            location,
            busy: match n(it, "busy") {
                0 => Busy::Free,
                1 => Busy::Tentative,
                3 => Busy::Oof,
                4 => Busy::Elsewhere,
                _ => Busy::Busy,
            },
            private: sensitivity == 2 || sensitivity == 3,
            categories: list(it, "categories", &[',', ';']),
        };
        ev.redact(privacy);
        out.push(ev);
    }
    out.sort_by(|a, b| a.start.cmp(&b.start).then_with(|| a.title.cmp(&b.title)));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: Privacy = Privacy { private_details: false, include_body: false, meeting_links: true };

    fn berlin() -> Zone {
        Zone::named("Europe/Berlin").unwrap()
    }

    fn utc(m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, m, d, h, min, 0).unwrap()
    }

    fn wall(y: i32, m: u32, d: u32, h: u32, min: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d).unwrap().and_hms_opt(h, min, 0).unwrap()
    }

    /// What the script prints on a German Outlook: non-ASCII as \u escapes, a recurring
    /// meeting (two instances, one after the change to winter time), an all-day event, a
    /// private appointment, a declined and a cancelled meeting, single values PowerShell
    /// did not wrap in arrays.
    const SAMPLE: &str = r#"WARNING: some profile noise
{"ok":true,"version":"16.0.0.17928","mode":"restrict","skipped":0,"items":[
 {"entryId":"00000000A1","globalId":"040000008200E00074C5B7101A82E0080000000011","subject":"Jour fixe Änderungsanträge","start":"2026-10-21T08:00:00Z","end":"2026-10-21T09:00:00Z","startLocal":"2026-10-21T10:00:00","endLocal":"2026-10-21T11:00:00","allDay":false,"recurring":true,"busy":2,"sensitivity":0,"responseStatus":3,"meetingStatus":3,"location":"Microsoft Teams-Besprechung","organizer":"Müller, Anna","attendees":["Müller, Anna","Weiß, Jörg"],"categories":"Projekt X, Kunde","body":null,"urls":["https://teams.microsoft.com/l/meetup-join/19%3ameeting_Y%40thread.v2/0"]},
 {"entryId":"00000000A1","globalId":"040000008200E00074C5B7101A82E0080000000011","subject":"Jour fixe Änderungsanträge","start":"2026-10-28T09:00:00Z","end":"2026-10-28T10:00:00Z","startLocal":"2026-10-28T10:00:00","endLocal":"2026-10-28T11:00:00","allDay":false,"recurring":true,"busy":2,"sensitivity":0,"responseStatus":3,"meetingStatus":3,"location":"","organizer":"Müller, Anna","attendees":"Weiß, Jörg","categories":"","urls":[]},
 {"entryId":"00000000B2","globalId":"","subject":"Betriebsausflug","start":"2026-10-01T22:00:00Z","end":"2026-10-02T22:00:00Z","startLocal":"2026-10-02T00:00:00","endLocal":"2026-10-03T00:00:00","allDay":true,"recurring":false,"busy":0,"sensitivity":0,"responseStatus":0,"meetingStatus":0,"location":"","organizer":"","attendees":[],"categories":"","urls":[]},
 {"entryId":"00000000C3","globalId":"GC3","subject":"","start":"2026-10-05T15:00:00Z","end":"2026-10-05T16:00:00Z","startLocal":"2026-10-05T17:00:00","endLocal":"2026-10-05T18:00:00","allDay":false,"recurring":false,"busy":3,"sensitivity":2,"responseStatus":0,"meetingStatus":0,"location":"","organizer":"","attendees":[],"categories":"","urls":[]},
 {"entryId":"00000000D4","globalId":"GD4","subject":"Abgelehnt","start":"2026-10-06T08:00:00Z","end":"2026-10-06T09:00:00Z","startLocal":"2026-10-06T10:00:00","endLocal":"2026-10-06T11:00:00","allDay":"False","recurring":"False","busy":"2","sensitivity":0,"responseStatus":4,"meetingStatus":3},
 {"entryId":"00000000E5","globalId":"GE5","subject":"Abgesagt: Review","start":"2026-10-07T08:00:00Z","end":"2026-10-07T09:00:00Z","startLocal":"2026-10-07T10:00:00","endLocal":"2026-10-07T11:00:00","allDay":false,"recurring":false,"busy":2,"sensitivity":0,"responseStatus":3,"meetingStatus":7},
 {"entryId":"00000000F6","globalId":"GF6","subject":"Alt","start":"/Date(1795000000000)/","end":"/Date(1795003600000)/","allDay":false,"recurring":"True","busy":"1","sensitivity":0,"responseStatus":0,"meetingStatus":0}
]}"#;

    #[test]
    fn script_output_becomes_events() {
        let evs = parse_output(SAMPLE, &berlin(), ALL).unwrap();
        let titles: Vec<_> = evs.iter().map(|e| e.title.as_str()).collect();
        assert_eq!(
            titles,
            ["Betriebsausflug", "Privater Termin", "Jour fixe Änderungsanträge", "Jour fixe Änderungsanträge", "Alt"]
        );
        let jf = &evs[2];
        assert_eq!((jf.start, jf.end), (utc(10, 21, 8, 0), utc(10, 21, 9, 0)));
        assert_eq!(evs[3].start, utc(10, 28, 9, 0), "10:00 local after the change to winter time");
        assert!(jf.recurring && jf.instance == "2026-10-21T08:00:00Z" && evs[3].instance == "2026-10-28T09:00:00Z");
        assert_eq!(jf.uid, "040000008200E00074C5B7101A82E0080000000011");
        assert_eq!(jf.attendees, ["Müller, Anna", "Weiß, Jörg"]);
        assert_eq!(evs[3].attendees, ["Weiß, Jörg"], "a single attendee as a plain string");
        assert_eq!(jf.organizer, "Müller, Anna");
        assert_eq!(jf.categories, ["Projekt X", "Kunde"]);
        assert_eq!(jf.link.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/19%3ameeting_Y%40thread.v2/0"));
        let trip = &evs[0];
        assert!(trip.all_day && trip.instance.is_empty());
        assert_eq!(trip.uid, "00000000B2", "EntryID without a global id");
        assert_eq!((trip.start, trip.end, trip.busy), (utc(10, 1, 22, 0), utc(10, 2, 22, 0), Busy::Free));
        assert_eq!((evs[1].busy, evs[1].private), (Busy::Oof, true));
        let old = &evs[4];
        assert_eq!(
            (old.start, old.busy, old.recurring),
            (Utc.timestamp_millis_opt(1795000000000).unwrap(), Busy::Tentative, true)
        );
    }

    #[test]
    fn privacy_applies_to_outlook_details_too() {
        // Even if the script sent details of a private appointment, they are dropped.
        let out = r#"{"ok":true,"items":{"entryId":"X","subject":"Arzt","start":"2026-10-05T15:00:00Z","end":"2026-10-05T16:00:00Z","sensitivity":2,"location":"Praxis","body":"Befund","urls":["https://zoom.us/j/1"]}}"#;
        let evs =
            parse_output(out, &berlin(), Privacy { private_details: false, include_body: true, meeting_links: true })
                .unwrap();
        assert_eq!(
            (evs[0].title.as_str(), evs[0].location.as_str(), evs[0].body.as_deref(), evs[0].link.as_deref()),
            ("Privater Termin", "", None, None)
        );
        let evs =
            parse_output(out, &berlin(), Privacy { private_details: true, include_body: false, meeting_links: false })
                .unwrap();
        assert_eq!((evs[0].title.as_str(), evs[0].body.as_deref(), evs[0].link.as_deref()), ("Arzt", None, None));
    }

    #[test]
    fn script_errors_become_german_messages() {
        let err = |code: &str| {
            parse_output(&format!(r#"{{"ok":false,"error":"{code}","message":"0x80040154"}}"#), &berlin(), ALL)
                .unwrap_err()
                .to_string()
        };
        assert!(err("not_installed").contains("nicht installiert") && err("not_installed").contains("ICS"));
        assert!(err("new_outlook").contains("neue Outlook"));
        assert!(err("server_exec").contains("Administrator"));
        assert!(err("constrained").contains("eingeschränkt"));
        assert!(err("com").contains("0x80040154"));
        assert!(parse_output("garbage", &berlin(), ALL).unwrap_err().to_string().contains("unlesbar"));
        assert_eq!(parse_output("\u{feff}{\"ok\":true,\"items\":[]}", &berlin(), ALL).unwrap(), vec![]);
    }

    #[test]
    fn restrict_dates_follow_the_regional_format() {
        let t = wall(2026, 9, 5, 8, 7);
        let pm = wall(2026, 12, 24, 20, 30);
        // German, US, ISO, British, Dutch with quoted literal.
        assert_eq!(restrict_value(t, "dd.MM.yyyy", "HH:mm", "", ""), "05.09.2026 08:07");
        assert_eq!(restrict_value(pm, "dd.MM.yyyy", "HH:mm", "", ""), "24.12.2026 20:30");
        assert_eq!(restrict_value(t, "M/d/yyyy", "h:mm tt", "AM", "PM"), "9/5/2026 8:07 AM");
        assert_eq!(restrict_value(pm, "M/d/yyyy", "h:mm tt", "AM", "PM"), "12/24/2026 8:30 PM");
        assert_eq!(restrict_value(t, "yyyy-MM-dd", "HH:mm", "", ""), "2026-09-05 08:07");
        assert_eq!(restrict_value(t, "dd/MM/yy", "H:mm", "", ""), "05/09/26 8:07");
        assert_eq!(
            restrict_value(wall(2026, 1, 1, 0, 5), "d-M-yyyy", "hh:mm tt", "a.m.", "p.m."),
            "1-1-2026 12:05 a.m."
        );
        assert_eq!(restrict_value(t, "dd' de 'MM' de 'yyyy", "HH:mm", "", ""), "05 de 09 de 2026 08:07");
    }

    #[test]
    fn the_script_is_ascii_and_takes_the_documented_parameters() {
        assert!(SCRIPT.is_ascii(), "Windows PowerShell reads scripts without BOM as ANSI");
        for p in ["$From", "$To", "$FilterFrom", "$FilterTo", "[switch]$Private", "[switch]$Body", "[switch]$Links"] {
            assert!(SCRIPT.contains(p), "{p}");
        }
        for needle in [
            "GetDefaultFolder(9)",
            "IncludeRecurrences = $true",
            "Sort('[Start]')",
            "Restrict(",
            "InvariantCulture",
            "StartUTC",
        ] {
            assert!(SCRIPT.contains(needle), "{needle}");
        }
    }

    #[test]
    fn the_fixture_needs_the_test_switch() {
        // Without ANNALO_TEST_FIXTURES=1 the variable alone does nothing (checked without
        // touching the environment of other tests: only when the switch is absent).
        if std::env::var("ANNALO_TEST_FIXTURES").is_err() {
            assert_eq!(fixture_path(), None);
        }
    }
}
