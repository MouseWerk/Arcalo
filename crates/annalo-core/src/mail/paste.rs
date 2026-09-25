//! A pasted header block, as Outlook writes it above a forwarded or replied mail and as it is
//! copied from a mail's window:
//!
//! ```text
//! Von: Müller, Anna <anna.mueller@example.com>
//! Gesendet: Donnerstag, 24. September 2026 14:32
//! An: Kleindienst, Maurice <maurice@example.com>; Weiß, Jörg
//! Cc: …
//! Betreff: AW: Angebot Portal
//! Wichtigkeit: Hoch
//! ```
//!
//! English Outlook writes `From:`, `Sent:`, `To:`, `Cc:`, `Subject:`, `Importance:` and dates like
//! `Thursday, September 24, 2026 2:32 PM`; `Datum:`/`Date:` and numeric dates are read too.
//! The text after the block (after the first blank line) is the mail's text.

use chrono::{NaiveDate, NaiveDateTime, NaiveTime};

use super::{Mail, MailSource};
use crate::calsync::tz::Zone;

#[derive(Clone, Copy, PartialEq)]
enum Field {
    From,
    Sent,
    To,
    Cc,
    Subject,
    Importance,
    Categories,
}

fn field(name: &str) -> Option<Field> {
    Some(match name.trim().to_lowercase().as_str() {
        "von" | "from" | "de" | "van" => Field::From,
        "gesendet" | "sent" | "datum" | "date" | "gesendet am" | "envoyé" => Field::Sent,
        "an" | "to" | "à" | "aan" => Field::To,
        "cc" | "kopie" => Field::Cc,
        "betreff" | "subject" | "objet" | "onderwerp" => Field::Subject,
        "wichtigkeit" | "importance" | "priorität" | "priority" => Field::Importance,
        "kategorien" | "categories" => Field::Categories,
        _ => return None,
    })
}

/// `Name <address>`, `"Name" <address>`, `address`, `Name [mailto:address]`.
fn person(raw: &str) -> (String, String) {
    let raw = raw.trim();
    for (open, close) in [('<', '>'), ('[', ']')] {
        if let (Some(s), Some(e)) = (raw.rfind(open), raw.rfind(close))
            && s < e
        {
            let addr = raw[s + 1..e].trim().trim_start_matches("mailto:").trim().to_owned();
            let name = raw[..s].trim().trim_matches(['"', '\'']).trim().to_owned();
            if addr.contains('@') {
                return (name, addr);
            }
        }
    }
    if raw.contains('@') && !raw.contains(' ') {
        return (String::new(), raw.trim_start_matches("mailto:").to_owned());
    }
    (raw.trim_matches(['"', '\'']).to_owned(), String::new())
}

/// Names of a recipient list (`;`-separated; `,` inside `Nachname, Vorname` stays).
fn people(raw: &str) -> Vec<String> {
    raw.split(';')
        .map(person)
        .map(|(n, a)| if n.is_empty() { a } else { n })
        .map(|x| x.trim().to_owned())
        .filter(|x| !x.is_empty())
        .collect()
}

const MONTHS: [(&str, u32); 24] = [
    ("januar", 1),
    ("februar", 2),
    ("märz", 3),
    ("april", 4),
    ("mai", 5),
    ("juni", 6),
    ("juli", 7),
    ("august", 8),
    ("september", 9),
    ("oktober", 10),
    ("november", 11),
    ("dezember", 12),
    ("january", 1),
    ("february", 2),
    ("march", 3),
    ("may", 5),
    ("june", 6),
    ("july", 7),
    ("october", 10),
    ("december", 12),
    ("jan", 1),
    ("feb", 2),
    ("mär", 3),
    ("dez", 12),
];

fn month(word: &str) -> Option<u32> {
    let w = word.trim_matches(['.', ',']).to_lowercase();
    if w.len() < 3 {
        return None;
    }
    MONTHS.iter().find(|(m, _)| *m == w).map(|(_, n)| *n).or_else(|| {
        // Three-letter forms of the rest (Mar, Apr, Jun, Jul, Aug, Sep, Oct, Nov, Okt).
        let short = w.get(..3)?;
        [("mar", 3), ("apr", 4), ("jun", 6), ("jul", 7), ("aug", 8), ("sep", 9), ("oct", 10), ("okt", 10), ("nov", 11)]
            .iter()
            .find(|(m, _)| *m == short && w.len() <= 4)
            .map(|(_, n)| *n)
    })
}

/// `14:32`, `2:32 PM`, `14:32:05`.
fn time(tokens: &[&str]) -> Option<NaiveTime> {
    let i = tokens.iter().position(|t| t.contains(':'))?;
    let t = tokens[i].trim_matches([',', '.']);
    let mut it = t.split(':');
    let mut h: u32 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.get(..2)?.parse().ok()?;
    let ampm = tokens.get(i + 1).map(|x| x.to_ascii_lowercase()).unwrap_or_default();
    let ampm = if t.to_ascii_lowercase().ends_with("pm") { "pm".to_owned() } else { ampm };
    if ampm.starts_with("pm") && h < 12 {
        h += 12;
    } else if ampm.starts_with("am") && h == 12 {
        h = 0;
    }
    NaiveTime::from_hms_opt(h, m, 0)
}

/// A local date and time as Outlook writes it in German or English, or numerically.
pub fn parse_date(raw: &str) -> Option<NaiveDateTime> {
    let tokens: Vec<&str> = raw.split_whitespace().collect();
    let t = time(&tokens).unwrap_or(NaiveTime::MIN);
    let num = |s: &str| s.trim_matches([',', '.']).parse::<u32>().ok();
    // Numeric: 24.09.2026, 2026-09-24, 9/24/2026.
    for tok in &tokens {
        let tok = tok.trim_end_matches(',');
        for fmt in ["%d.%m.%Y", "%Y-%m-%d", "%m/%d/%Y", "%d.%m.%y"] {
            if let Ok(d) = NaiveDate::parse_from_str(tok, fmt) {
                return Some(d.and_time(t));
            }
        }
    }
    // Words: „24. September 2026“, „September 24, 2026“.
    let (mut day, mut mon, mut year) = (None, None, None);
    for tok in &tokens {
        if tok.contains(':') {
            continue;
        }
        if let Some(m) = month(tok) {
            mon.get_or_insert(m);
        } else if let Some(n) = num(tok) {
            if n > 31 {
                year.get_or_insert(n as i32);
            } else if day.is_none() {
                day = Some(n);
            }
        }
    }
    NaiveDate::from_ymd_opt(year?, mon?, day?).map(|d| d.and_time(t))
}

/// Reads a pasted header block; `None` when `text` has none (at least a sender and a subject
/// or date are needed).
pub fn parse(text: &str, zone: &Zone) -> Option<Mail> {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = text.lines().collect();
    // The block starts at the first `Von:`/`From:` line (a separator line may come before).
    let start = lines.iter().position(|l| {
        let t = l.trim().trim_start_matches(['*', '>', ' ']);
        t.split_once(':').is_some_and(|(k, _)| field(k.trim_end_matches('*')) == Some(Field::From))
    })?;
    let mut mail = Mail { source: MailSource::Text, importance: 1, ..Default::default() };
    let mut last: Option<Field> = None;
    let mut seen = vec![];
    let mut body_start = lines.len();
    for (i, raw) in lines.iter().enumerate().skip(start) {
        let line = raw.trim().trim_start_matches(['>', ' ']).replace("**", "");
        if line.trim().is_empty() {
            body_start = i + 1;
            break;
        }
        let parsed = line.split_once(':').and_then(|(k, v)| field(k).map(|f| (f, v.trim().to_owned())));
        let cont = parsed.is_none();
        let (f, value) = match parsed {
            Some(x) => x,
            // A wrapped recipient list continues the previous field.
            None => match last {
                Some(f @ (Field::To | Field::Cc | Field::Subject)) => (f, line.trim().to_owned()),
                _ => {
                    body_start = i;
                    break;
                }
            },
        };
        match f {
            Field::From => {
                let (n, a) = person(&value);
                mail.from_name = n;
                mail.from_email = a;
            }
            Field::Sent => mail.received = parse_date(&value).map(|t| zone.to_utc(t)),
            // A wrapped `<address>` belongs to the name before it.
            Field::To | Field::Cc if cont && value.starts_with('<') => {}
            Field::To => mail.to.extend(people(&value)),
            Field::Cc => mail.cc.extend(people(&value)),
            Field::Subject if cont => {
                mail.subject.push(' ');
                mail.subject.push_str(&value);
            }
            Field::Subject => mail.subject = value,
            Field::Importance => {
                let v = value.to_lowercase();
                mail.importance = if v.starts_with("hoch") || v.starts_with("high") {
                    2
                } else if v.starts_with("niedrig") || v.starts_with("low") {
                    0
                } else {
                    1
                };
            }
            Field::Categories => mail.categories = value.split([',', ';']).map(|x| x.trim().to_owned()).collect(),
        }
        seen.push(f);
        last = Some(f);
    }
    let has = |f: Field| seen.contains(&f);
    if !has(Field::From) || !(has(Field::Subject) || has(Field::Sent)) {
        return None;
    }
    mail.body = lines.get(body_start..).map(|l| l.join("\n")).unwrap_or_default();
    Some(mail.normalized())
}
