//! Action items of a meeting summary. The summary prompt asks for `- [ ] Text @Person due:…`
//! lines in its tasks section; models do not always keep to it („- Anna: Angebot schicken bis
//! Freitag“, „1. Offer (owner: Ben, by 10/12)“). [`summary_block`] turns every item of that
//! section into a real task line, so the tasks view, the due dates and the dashboard pick them up.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActionItem {
    pub text: String,
    pub assignee: Option<String>,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    pub done: bool,
    /// `!` or `!!` as written.
    pub priority: Option<String>,
}

impl ActionItem {
    /// `- [ ] Angebot schicken @Anna due:2026-10-05 !`
    pub fn task_line(&self) -> String {
        let mut line = format!("- [{}] {}", if self.done { "x" } else { " " }, self.text);
        if let Some(a) = &self.assignee {
            line.push_str(&format!(" @{}", a.split_whitespace().collect::<Vec<_>>().join("_")));
        }
        if let Some(d) = &self.due {
            line.push_str(&format!(" due:{d}"));
        }
        if let Some(p) = &self.priority {
            line.push(' ');
            line.push_str(p);
        }
        line
    }
}

/// Headings of the tasks section (lower case, without `#`).
const TASK_HEADINGS: &[&str] = &[
    "aufgaben",
    "aufgaben / to-dos",
    "to-dos",
    "todos",
    "to-do",
    "maßnahmen",
    "nächste schritte",
    "tasks",
    "action items",
    "actions",
    "next steps",
];

/// Items that say there is nothing.
const NONE: &[&str] = &["keine", "keine.", "none", "none.", "n/a", "-", "—"];

fn is_task_heading(line: &str) -> bool {
    let t = line.trim_start_matches('#').trim().trim_end_matches(':').trim_matches('*').trim().to_lowercase();
    line.starts_with('#') && TASK_HEADINGS.contains(&t.as_str())
        || (line.starts_with("**") && TASK_HEADINGS.contains(&t.as_str()))
}

/// The list item text of `line` (`- …`, `* …`, `1. …`), or `None`.
fn list_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")) {
        return Some(rest.trim());
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            return Some(r.trim());
        }
    }
    None
}

/// The action items of the tasks section of `summary`; relative dates count from `today`.
pub fn parse(summary: &str, today: NaiveDate) -> Vec<ActionItem> {
    let mut out = Vec::new();
    let mut inside = false;
    for line in summary.lines() {
        if line.starts_with('#') || (line.starts_with("**") && line.trim_end().ends_with("**")) {
            inside = is_task_heading(line);
            continue;
        }
        if !inside {
            continue;
        }
        if let Some(item) = list_item(line).and_then(|t| parse_item(t, today)) {
            out.push(item);
        }
    }
    out
}

/// One item: checkbox, `@Person`, „Verantwortlich: …“ / „owner: …“, a leading „Name:“, the due
/// date (`due:`, `fällig:`, „bis …“, „by …“; ISO, `05.10.2026`, `05.10.`, weekdays, „morgen“).
pub fn parse_item(raw: &str, today: NaiveDate) -> Option<ActionItem> {
    let mut text = raw.trim().to_owned();
    let mut done = false;
    for (prefix, d) in [("[ ] ", false), ("[x] ", true), ("[X] ", true)] {
        if let Some(rest) = text.strip_prefix(prefix) {
            text = rest.trim().to_owned();
            done = d;
        }
    }
    if NONE.contains(&text.to_lowercase().as_str()) || text.is_empty() {
        return None;
    }
    let mut priority = None;
    for p in ["!!", "!"] {
        if let Some(rest) = text.strip_suffix(&format!(" {p}")) {
            priority = Some(p.to_owned());
            text = rest.trim_end().to_owned();
            break;
        }
    }
    let mut assignee = None;
    let mut due = None;

    // Parenthesized details: „(Verantwortlich: Anna, bis 05.10.)“.
    if let Some(open) = text.rfind('(')
        && text.ends_with(')')
    {
        let inner = text[open + 1..text.len() - 1].to_owned();
        let mut used = false;
        for part in inner.split([',', ';']) {
            let part = part.trim();
            if let Some(a) =
                labeled(part, &["verantwortlich", "zuständig", "owner", "assignee", "responsible", "wer", "who"])
            {
                assignee = Some(a.to_owned());
                used = true;
            } else if let Some(d) = date_phrase(part, today) {
                due = Some(d);
                used = true;
            }
        }
        if used {
            text = text[..open].trim_end().to_owned();
        }
    }

    // Tokens: `@Name`, `due:…`, `fällig:…`.
    let mut words: Vec<String> = Vec::new();
    for w in text.split_whitespace() {
        if let Some(name) = w.strip_prefix('@').filter(|n| !n.is_empty()) {
            assignee.get_or_insert_with(|| name.trim_end_matches([',', '.', ';']).replace('_', " "));
            continue;
        }
        let lower = w.to_lowercase();
        if let Some(d) = ["due:", "fällig:"].iter().find_map(|p| lower.strip_prefix(p)) {
            if let Some(d) = parse_date(d, today) {
                due.get_or_insert(d);
                continue;
            }
        }
        words.push(w.to_owned());
    }
    text = words.join(" ");

    // „bis Freitag“ / „by 2026-10-05“ at the end.
    if due.is_none() {
        for kw in [" bis zum ", " bis ", " by ", " until ", " due "] {
            if let Some(at) = text.to_lowercase().rfind(kw) {
                let tail = text[at + kw.len()..].trim().trim_end_matches('.');
                if let Some(d) = parse_date(tail, today) {
                    due = Some(d);
                    text = text[..at].trim_end().to_owned();
                    break;
                }
            }
        }
    }

    // „Anna: Angebot schicken“.
    if assignee.is_none()
        && let Some((who, rest)) = text.split_once(": ")
        && is_name(who)
        && !rest.trim().is_empty()
    {
        assignee = Some(who.trim_matches('*').to_owned());
        text = rest.trim().to_owned();
    }
    let text = text.trim().trim_end_matches([',', ';']).trim().to_owned();
    if text.is_empty() {
        return None;
    }
    Some(ActionItem { text, assignee, due, done, priority })
}

/// `Verantwortlich: Anna` → `Anna` for one of `labels`.
fn labeled<'a>(part: &'a str, labels: &[&str]) -> Option<&'a str> {
    let (label, value) = part.split_once(':')?;
    let value = value.trim();
    (labels.contains(&label.trim().to_lowercase().as_str()) && !value.is_empty()).then_some(value)
}

/// „bis 05.10.“, „by Friday“, „fällig 2026-10-05“, or a bare date.
fn date_phrase(part: &str, today: NaiveDate) -> Option<String> {
    let lower = part.to_lowercase();
    let rest = ["bis zum ", "bis ", "by ", "until ", "due ", "due:", "fällig:", "fällig ", "termin:", "deadline:"]
        .iter()
        .find_map(|p| lower.strip_prefix(p))
        .unwrap_or(&lower);
    parse_date(rest.trim(), today)
}

/// One or two capitalized words („Anna“, „Ben Weiß“, „Team Vertrieb“), so a sentence with a
/// colon is not taken for a name.
fn is_name(s: &str) -> bool {
    let s = s.trim().trim_matches('*');
    let words: Vec<&str> = s.split_whitespace().collect();
    (1..=2).contains(&words.len())
        && words.iter().all(|w| {
            w.chars().next().is_some_and(char::is_uppercase)
                && w.chars().all(|c| c.is_alphabetic() || c == '-' || c == '.')
        })
}

const WEEKDAYS: [(&str, Weekday); 14] = [
    ("montag", Weekday::Mon),
    ("dienstag", Weekday::Tue),
    ("mittwoch", Weekday::Wed),
    ("donnerstag", Weekday::Thu),
    ("freitag", Weekday::Fri),
    ("samstag", Weekday::Sat),
    ("sonntag", Weekday::Sun),
    ("monday", Weekday::Mon),
    ("tuesday", Weekday::Tue),
    ("wednesday", Weekday::Wed),
    ("thursday", Weekday::Thu),
    ("friday", Weekday::Fri),
    ("saturday", Weekday::Sat),
    ("sunday", Weekday::Sun),
];

/// A date at the start of `s`: `2026-10-05`, `05.10.2026`, `5.10.`, a weekday (the next one
/// after today), „heute“/„today“, „morgen“/„tomorrow“, „Ende der Woche“/„end of week“ (Friday).
pub fn parse_date(s: &str, today: NaiveDate) -> Option<String> {
    let s = s.trim().trim_end_matches(['.', ',', ')']).trim();
    let lower = s.to_lowercase();
    let first = lower.split_whitespace().next().unwrap_or("");
    let iso = |d: NaiveDate| d.format("%Y-%m-%d").to_string();
    if let Ok(d) = NaiveDate::parse_from_str(first, "%Y-%m-%d") {
        return Some(iso(d));
    }
    let token = first.trim_end_matches(['.', ',']);
    let parts: Vec<&str> = token.split('.').collect();
    if (2..=3).contains(&parts.len())
        && let (Ok(d), Ok(m)) = (parts[0].parse::<u32>(), parts[1].parse::<u32>())
    {
        let year = match parts.get(2).filter(|y| !y.is_empty()) {
            Some(y) => {
                let y: i32 = y.parse().ok()?;
                if y < 100 { 2000 + y } else { y }
            }
            None => today.year(),
        };
        let mut date = NaiveDate::from_ymd_opt(year, m, d)?;
        // „bis 05.01.“ in December means next year.
        if parts.get(2).is_none_or(|y| y.is_empty()) && date < today {
            date = NaiveDate::from_ymd_opt(year + 1, m, d)?;
        }
        return Some(iso(date));
    }
    match first {
        "heute" | "today" => return Some(iso(today)),
        "morgen" | "tomorrow" => return Some(iso(today + Duration::days(1))),
        "übermorgen" => return Some(iso(today + Duration::days(2))),
        _ => {}
    }
    if lower.starts_with("ende der woche") || lower.starts_with("end of week") || lower.starts_with("end of the week") {
        return Some(iso(next_weekday(today, Weekday::Fri, true)));
    }
    let name = first.trim_end_matches([',', '.']);
    WEEKDAYS.iter().find(|(n, _)| *n == name).map(|(_, wd)| iso(next_weekday(today, *wd, false)))
}

/// The next `wd` after `today` (`today` itself when `inclusive`).
fn next_weekday(today: NaiveDate, wd: Weekday, inclusive: bool) -> NaiveDate {
    let mut d = if inclusive { today } else { today + Duration::days(1) };
    while d.weekday() != wd {
        d += Duration::days(1);
    }
    d
}

/// The summary as it goes onto the page: its headings one level down (below the voice-note
/// heading) and every item of the tasks section a task line.
pub fn summary_block(summary: &str, today: NaiveDate) -> String {
    let mut out = Vec::new();
    let mut inside = false;
    for line in summary.trim().lines() {
        if line.starts_with('#') {
            inside = is_task_heading(line);
            let level = line.bytes().take_while(|b| *b == b'#').count();
            out.push(format!("{} {}", "#".repeat((level + 1).clamp(3, 6)), line[level..].trim()));
            continue;
        }
        if line.starts_with("**") && line.trim_end().ends_with("**") {
            inside = is_task_heading(line);
        }
        if inside && let Some(raw) = list_item(line) {
            if let Some(item) = parse_item(raw, today) {
                out.push(item.task_line());
            }
            continue;
        }
        out.push(line.to_owned());
    }
    let mut text = out.join("\n");
    text.push('\n');
    text
}

#[cfg(test)]
mod tests {
    use super::*;

    fn today() -> NaiveDate {
        // A Thursday.
        NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()
    }

    #[test]
    fn task_lines_are_kept() {
        let items = parse("## Aufgaben\n- [ ] Angebot schicken @Anna due:2026-10-05 !\n- [x] Raum buchen\n", today());
        assert_eq!(
            items,
            [
                ActionItem {
                    text: "Angebot schicken".into(),
                    assignee: Some("Anna".into()),
                    due: Some("2026-10-05".into()),
                    done: false,
                    priority: Some("!".into())
                },
                ActionItem { text: "Raum buchen".into(), assignee: None, due: None, done: true, priority: None },
            ]
        );
        assert_eq!(items[0].task_line(), "- [ ] Angebot schicken @Anna due:2026-10-05 !");
    }

    #[test]
    fn free_form_items_get_assignee_and_due_date() {
        let md = "## Summary\nText.\n\n## Decisions\n- Budget approved\n\n## Action items\n\
                  1. Ben Weiß: Prepare the offer by Friday\n\
                  2. Send minutes (owner: Carla, by 05.10.)\n\
                  - Update the roadmap until 2026-11-02\n\
                  - Book the room tomorrow\n\
                  - None\n\n## Open points\n- Pricing\n";
        let items = parse(md, today());
        let got: Vec<_> = items.iter().map(|i| (i.text.as_str(), i.assignee.as_deref(), i.due.as_deref())).collect();
        assert_eq!(
            got,
            [
                ("Prepare the offer", Some("Ben Weiß"), Some("2026-10-02")),
                ("Send minutes", Some("Carla"), Some("2026-10-05")),
                ("Update the roadmap", None, Some("2026-11-02")),
                ("Book the room tomorrow", None, None),
            ]
        );
        assert_eq!(items[0].task_line(), "- [ ] Prepare the offer @Ben_Weiß due:2026-10-02");
    }

    #[test]
    fn german_items_and_dates() {
        let md = "**Aufgaben**\n- Anna: Protokoll verteilen bis morgen\n- Folien überarbeiten (Verantwortlich: Jörg; fällig: 3.1.)\n- Keine\n";
        let items = parse(md, today());
        assert_eq!(items.len(), 2);
        assert_eq!((items[0].assignee.as_deref(), items[0].due.as_deref()), (Some("Anna"), Some("2026-10-02")));
        assert_eq!(items[0].text, "Protokoll verteilen");
        // Day and month without year in the past: next year.
        assert_eq!(items[1].due.as_deref(), Some("2027-01-03"));
        assert_eq!(items[1].assignee.as_deref(), Some("Jörg"));
        // A sentence with a colon is no name.
        let s = parse_item("Wichtig ist folgendes: Budget prüfen", today()).unwrap();
        assert_eq!(s.assignee, None);
        assert_eq!(parse_date("Freitag", today()).as_deref(), Some("2026-10-02"));
        assert_eq!(parse_date("Donnerstag", today()).as_deref(), Some("2026-10-08"));
        assert_eq!(parse_date("Ende der Woche", today()).as_deref(), Some("2026-10-02"));
        assert_eq!(parse_date("31.02.2026", today()), None);
        assert_eq!(parse_date("irgendwann", today()), None);
    }

    #[test]
    fn summary_block_demotes_headings_and_writes_tasks() {
        let md = "## Zusammenfassung\nKurz.\n\n## Aufgaben\n- Anna: Angebot schicken bis 05.10.2026\n- [ ] Raum buchen @Ben\n\n## Offene Punkte\n- Preis\n";
        assert_eq!(
            summary_block(md, today()),
            "### Zusammenfassung\nKurz.\n\n### Aufgaben\n- [ ] Angebot schicken @Anna due:2026-10-05\n- [ ] Raum buchen @Ben\n\n### Offene Punkte\n- Preis\n"
        );
        // Items outside the tasks section stay as they are.
        assert!(summary_block("## Entscheidungen\n- Anna: zuständig\n", today()).contains("- Anna: zuständig"));
        // The result is read as tasks.
        let tasks = crate::tasks::parse_tasks(&summary_block(md, today()));
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].due.as_deref(), Some("2026-10-05"));
    }
}
