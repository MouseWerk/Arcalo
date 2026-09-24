//! Smart `/zeit`: a line with a duration but without a WBS reference
//! (`/zeit 2h habe am Interface-Mapping gearbeitet`) is matched to a Vorgang by the model.
//!
//! The prompt lists the bookable references (recently booked ones first, with the
//! Leistungsarten and descriptions used on them) and asks for strict JSON
//! `{"reference", "leistungsart", "confidence", "reason"}`. The answer is validated against
//! the database: unknown references are rejected, unknown Leistungsarten dropped. The caller
//! shows the suggestion and books only after the user confirmed it.

use std::collections::HashMap;

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use super::client::ChatMessage;
use crate::db::Database;
use crate::error::{Error, Result};
use crate::zeit;

/// Bookings of the last this many days count as "recently booked".
pub const RECENT_DAYS: i64 = 60;
/// At most this many references go into the prompt.
pub const MAX_CANDIDATES: usize = 80;

/// A bookable reference offered to the model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Candidate {
    /// `NP-8801/1020`, or `NP-8801` for a Netzplan without Vorgänge.
    pub reference: String,
    /// Vorgang (or Netzplan) description.
    pub title: String,
    /// `Systemintegration ERP · PRJ-2026-X Annalo Rollout`
    pub context: String,
    /// Leistungsarten booked on it recently, most used first.
    pub leistungsarten: Vec<String>,
    /// Recent booking descriptions, newest first (at most 3).
    pub recent: Vec<String>,
    /// Bookings in the last [`RECENT_DAYS`] days (0 = not recently booked).
    pub recent_count: u32,
}

/// The bookable references, recently booked ones first (most bookings, then newest).
pub fn candidates(db: &Database, now: DateTime<Utc>) -> Result<Vec<Candidate>> {
    #[derive(Default)]
    struct Usage {
        count: u32,
        last: String,
        las: HashMap<String, u32>,
        recent: Vec<String>,
    }
    let since = crate::db::ts(now - Duration::days(RECENT_DAYS));
    let mut usage: HashMap<String, Usage> = HashMap::new();
    {
        let mut st = db.conn().prepare_cached(
            "SELECT n.netzplan_nr, e.vorgang_nr, e.leistungsart, e.description, e.start_time
             FROM time_entries e JOIN netzplaene n ON n.id = e.netzplan_id
             WHERE e.start_time >= ?1 ORDER BY e.start_time DESC, e.id DESC",
        )?;
        let rows = st.query_map([since], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        for row in rows {
            let (np, v, la, desc, start) = row?;
            let key = match v {
                Some(v) => format!("{np}/{v}"),
                None => np,
            }
            .to_lowercase();
            let u = usage.entry(key).or_default();
            u.count += 1;
            if u.last.is_empty() {
                u.last = start;
            }
            if let Some(la) = la {
                *u.las.entry(la).or_default() += 1;
            }
            let desc = desc.trim().to_owned();
            if !desc.is_empty() && u.recent.len() < 3 && !u.recent.contains(&desc) {
                u.recent.push(desc);
            }
        }
    }

    let mut out = vec![];
    for p in db.list_projects()? {
        for n in db.list_netzplaene(Some(p.id))? {
            let context = format!("{} · {} {}", n.description, p.project_code, p.name);
            let vorgaenge = db.list_vorgaenge(n.id)?;
            let mut refs: Vec<(String, String)> = vorgaenge
                .iter()
                .map(|v| (format!("{}/{}", n.netzplan_nr, v.vorgang_nr), v.description.clone()))
                .collect();
            if refs.is_empty() {
                refs.push((n.netzplan_nr.clone(), n.description.clone()));
            }
            for (reference, title) in refs {
                let u = usage.get(&reference.to_lowercase());
                let mut las: Vec<(String, u32)> =
                    u.map(|u| u.las.iter().map(|(k, v)| (k.clone(), *v)).collect()).unwrap_or_default();
                las.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
                out.push((
                    u.map(|u| u.last.clone()).unwrap_or_default(),
                    Candidate {
                        reference,
                        title,
                        context: context.clone(),
                        leistungsarten: las.into_iter().map(|(k, _)| k).collect(),
                        recent: u.map(|u| u.recent.clone()).unwrap_or_default(),
                        recent_count: u.map_or(0, |u| u.count),
                    },
                ));
            }
        }
    }
    out.sort_by(|(la, a), (lb, b)| {
        b.recent_count
            .min(1)
            .cmp(&a.recent_count.min(1))
            .then_with(|| lb.cmp(la))
            .then_with(|| a.reference.cmp(&b.reference))
    });
    let mut out: Vec<Candidate> = out.into_iter().map(|(_, c)| c).collect();
    out.truncate(MAX_CANDIDATES);
    Ok(out)
}

/// The parts of a `/zeit` line without reference: `/zeit <dauer> <rest>`.
#[derive(Debug, Clone, PartialEq)]
pub struct Unreferenced<'a> {
    pub command: &'a str,
    pub duration: &'a str,
    pub rest: &'a str,
}

/// Splits `/zeit 2h habe gearbeitet`; `None` when the line is no `/zeit` command or its
/// first argument is not a duration (then it has a reference already).
pub fn unreferenced(line: &str) -> Option<Unreferenced<'_>> {
    let line = line.trim();
    let (command, rest) = line.split_once(char::is_whitespace)?;
    if !zeit::is_zeit_command(command) {
        return None;
    }
    let rest = rest.trim_start();
    let (duration, rest) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
    zeit::parse_duration(duration).ok()?;
    Some(Unreferenced { command, duration, rest: rest.trim() })
}

pub const SYSTEM_PROMPT: &str = "Du ordnest Zeitbuchungen in Annalo dem passenden Vorgang zu. \
Wähle aus der Liste der buchbaren Referenzen genau die, zu der die Tätigkeit am besten passt. \
Zuletzt gebuchte Referenzen stehen oben und sind bei ähnlicher Eignung vorzuziehen. \
Antworte ausschließlich mit einem JSON-Objekt, ohne Codeblock und ohne weiteren Text: \
{\"reference\": \"<Referenz exakt aus der Liste>\", \"leistungsart\": \"<Code aus der Liste>\" oder null, \
\"confidence\": <Zahl von 0 bis 1>, \"reason\": \"<kurze Begründung auf Deutsch>\"}. \
Erfinde keine Referenzen. Wenn nichts passt, wähle die wahrscheinlichste und gib eine niedrige confidence an.";

/// The request for one line: system rules, then the candidates, Leistungsarten and the text.
pub fn messages(
    line: &str,
    candidates: &[Candidate],
    leistungsarten: &[(String, String)],
    page_title: Option<&str>,
) -> Vec<ChatMessage> {
    let text = unreferenced(line).map_or(line.trim(), |u| u.rest);
    let mut user = String::from("Buchbare Referenzen:\n");
    for c in candidates {
        user.push_str(&format!("- {} | {} | {}", c.reference, c.title, c.context));
        if c.recent_count > 0 {
            user.push_str(&format!(" | zuletzt gebucht ({}×)", c.recent_count));
            if !c.leistungsarten.is_empty() {
                user.push_str(&format!(", Leistungsarten: {}", c.leistungsarten.join(", ")));
            }
            if !c.recent.is_empty() {
                user.push_str(&format!(", z. B. „{}“", c.recent.join("“, „")));
            }
        }
        user.push('\n');
    }
    user.push_str("\nLeistungsarten:\n");
    for (code, desc) in leistungsarten {
        user.push_str(&format!("- {code}: {desc}\n"));
    }
    if let Some(t) = page_title.filter(|t| !t.trim().is_empty()) {
        user.push_str(&format!("\nNotizseite: „{}“\n", t.trim()));
    }
    user.push_str(&format!("\nTätigkeit: {text}"));
    vec![ChatMessage::system(SYSTEM_PROMPT), ChatMessage::user(user)]
}

/// The model's answer as sent.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RawGuess {
    pub reference: String,
    #[serde(default)]
    pub leistungsart: Option<String>,
    #[serde(default)]
    pub confidence: Option<f64>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// Extracts the JSON object of an answer, tolerating a code fence or text around it.
pub fn parse_answer(answer: &str) -> Result<RawGuess> {
    let bad =
        || Error::Parse(format!("KI-Antwort ist kein gültiges JSON: {}", answer.chars().take(160).collect::<String>()));
    let start = answer.find('{').ok_or_else(bad)?;
    let end = answer.rfind('}').filter(|e| *e > start).ok_or_else(bad)?;
    serde_json::from_str(&answer[start..=end]).map_err(|_| bad())
}

/// A validated suggestion, ready to confirm.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ZeitGuess {
    /// Canonical reference from the candidates.
    pub reference: String,
    /// Description of the Vorgang.
    pub title: String,
    pub leistungsart: Option<String>,
    /// Description of the Leistungsart.
    pub leistungsart_title: Option<String>,
    pub confidence: f64,
    pub reason: String,
    /// The line with reference (and Leistungsart) inserted, to book on confirmation.
    pub line: String,
}

/// Checks the answer against the candidates and Leistungsarten; unknown references fail,
/// an unknown Leistungsart is dropped.
pub fn validate(
    line: &str,
    raw: &RawGuess,
    candidates: &[Candidate],
    leistungsarten: &[(String, String)],
    today: NaiveDate,
) -> Result<ZeitGuess> {
    let wanted = raw.reference.trim();
    let norm = |s: &str| s.to_lowercase().replace(char::is_whitespace, "");
    let Some(c) = candidates.iter().find(|c| norm(&c.reference) == norm(wanted)) else {
        return Err(Error::State(format!("Die KI schlug die unbekannte Referenz „{wanted}“ vor")));
    };
    let la = raw
        .leistungsart
        .as_deref()
        .map(|l| l.trim().trim_start_matches('#'))
        .filter(|l| !l.is_empty())
        .and_then(|l| leistungsarten.iter().find(|(code, _)| code.eq_ignore_ascii_case(l)));
    let confidence = raw.confidence.filter(|c| c.is_finite()).unwrap_or(0.5).clamp(0.0, 1.0);
    let line = apply(line, &c.reference, la.map(|(code, _)| code.as_str()))?;
    // The line must book as is; its Leistungsart (the user's own wins) is what gets booked.
    let cmd = zeit::parse(&line, today)?;
    let la_title =
        cmd.leistungsart.as_deref().and_then(|l| leistungsarten.iter().find(|(code, _)| code.eq_ignore_ascii_case(l)));
    Ok(ZeitGuess {
        reference: c.reference.clone(),
        title: c.title.clone(),
        leistungsart: cmd.leistungsart.clone(),
        leistungsart_title: la_title.map(|(_, d)| d.clone()),
        confidence,
        reason: raw.reason.as_deref().unwrap_or("").trim().to_owned(),
        line,
    })
}

/// Inserts `reference` before the duration and `#LA` after it, unless the line has one.
pub fn apply(line: &str, reference: &str, leistungsart: Option<&str>) -> Result<String> {
    let u = unreferenced(line).ok_or_else(|| Error::Parse("Die Zeile hat bereits eine Referenz".into()))?;
    let has_la = u.rest.split_whitespace().any(|w| w.len() > 1 && w.starts_with('#'));
    let mut out = format!("{} {reference} {}", u.command, u.duration);
    if let Some(la) = leistungsart.filter(|_| !has_la) {
        out.push_str(&format!(" #{la}"));
    }
    if !u.rest.is_empty() {
        out.push(' ');
        out.push_str(u.rest);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};

    fn day() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 9, 24).unwrap()
    }

    fn setup() -> (Database, DateTime<Utc>) {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration ERP", 120.0).unwrap();
        db.create_vorgang(np.id, "1010", "Anforderungsanalyse", 3.0, 16.0).unwrap();
        db.create_vorgang(np.id, "1020", "Systemintegration", 5.0, 40.0).unwrap();
        db.create_netzplan(p.id, "NP-9000", "NP-9000-1", "Wartung", 10.0).unwrap();
        let now = Utc::now();
        for (v, la, d, desc) in
            [("1020", "DEV", 2, "IDoc-Mapping"), ("1020", "DEV", 1, "Delta-Load"), ("1010", "PM", 3, "Scope")]
        {
            db.insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: Some(v.into()),
                leistungsart: Some(la.into()),
                start_time: now - Duration::days(d),
                duration_minutes: 60,
                description: desc.into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        }
        (db, now)
    }

    #[test]
    fn candidates_put_recent_references_first() {
        let (db, now) = setup();
        let c = candidates(&db, now).unwrap();
        let refs: Vec<_> = c.iter().map(|c| c.reference.as_str()).collect();
        assert_eq!(refs, ["NP-8801/1020", "NP-8801/1010", "NP-9000"]);
        assert_eq!(c[0].recent_count, 2);
        assert_eq!(c[0].leistungsarten, ["DEV"]);
        assert_eq!(c[0].recent, ["Delta-Load", "IDoc-Mapping"]);
        assert_eq!(c[2].recent_count, 0);
        assert!(c[0].context.contains("Systemintegration ERP"));
    }

    #[test]
    fn prompt_lists_candidates_leistungsarten_and_the_text() {
        let (db, now) = setup();
        let c = candidates(&db, now).unwrap();
        let las = db.list_leistungsarten().unwrap();
        let m = messages("/zeit 2h habe am Interface-Mapping gearbeitet", &c, &las, Some("Jour fixe"));
        assert_eq!(m.len(), 2);
        assert!(m[0].content.as_deref().unwrap().contains("\"reference\""));
        let user = m[1].content.as_deref().unwrap();
        assert!(user.contains("- NP-8801/1020 | Systemintegration | Systemintegration ERP · PRJ-2026-X Rollout | zuletzt gebucht (2×), Leistungsarten: DEV, z. B. „Delta-Load“, „IDoc-Mapping“"), "{user}");
        assert!(user.contains("- NP-9000 | Wartung"));
        assert!(user.contains("- DEV: "));
        assert!(user.contains("Notizseite: „Jour fixe“"));
        assert!(user.ends_with("Tätigkeit: habe am Interface-Mapping gearbeitet"));
        // Recent first in the prompt as well.
        assert!(user.find("NP-8801/1020").unwrap() < user.find("NP-9000").unwrap());
    }

    #[test]
    fn unreferenced_lines() {
        let u = unreferenced("  /zeit 2h habe gearbeitet ").unwrap();
        assert_eq!((u.command, u.duration, u.rest), ("/zeit", "2h", "habe gearbeitet"));
        assert_eq!(unreferenced("/time 1:30").unwrap().rest, "");
        assert!(unreferenced("/zeit NP-8801/1020 2h x").is_none());
        assert!(unreferenced("zeit 2h x").is_none());
        assert!(unreferenced("/zeit").is_none());
    }

    #[test]
    fn parses_strict_and_wrapped_json() {
        let g = parse_answer(
            r#"{"reference":"NP-8801/1020","leistungsart":"DEV","confidence":0.82,"reason":"Mapping ist Integration"}"#,
        )
        .unwrap();
        assert_eq!(g.reference, "NP-8801/1020");
        assert_eq!(g.leistungsart.as_deref(), Some("DEV"));
        let g = parse_answer("```json\n{\"reference\": \"NP-9000\", \"leistungsart\": null, \"confidence\": 0.3, \"reason\": \"?\"}\n```").unwrap();
        assert_eq!((g.reference.as_str(), g.leistungsart), ("NP-9000", None));
        let g = parse_answer("Gern: {\"reference\": \"NP-9000\"} – fertig").unwrap();
        assert_eq!(g.confidence, None);
    }

    #[test]
    fn malformed_answers_fail() {
        for bad in
            ["", "NP-8801/1020", "{reference: NP-8801}", "{\"leistungsart\": \"DEV\"}", "} {", "{\"reference\": 42}"]
        {
            assert!(parse_answer(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn validation_rejects_unknown_references_and_builds_the_line() {
        let (db, now) = setup();
        let c = candidates(&db, now).unwrap();
        let las = db.list_leistungsarten().unwrap();
        let line = "/zeit 2h habe am Interface-Mapping gearbeitet";
        let raw = |r: &str, la: Option<&str>, conf: Option<f64>| RawGuess {
            reference: r.into(),
            leistungsart: la.map(Into::into),
            confidence: conf,
            reason: Some(" passt ".into()),
        };

        let g = validate(line, &raw("np-8801/1020", Some("dev"), Some(0.9)), &c, &las, day()).unwrap();
        assert_eq!(g.reference, "NP-8801/1020", "canonical spelling");
        assert_eq!(g.title, "Systemintegration");
        assert_eq!(g.leistungsart.as_deref(), Some("DEV"));
        assert!(g.leistungsart_title.is_some());
        assert_eq!(g.reason, "passt");
        assert_eq!(g.line, "/zeit NP-8801/1020 2h #DEV habe am Interface-Mapping gearbeitet");

        let err = validate(line, &raw("NP-7777/1", None, None), &c, &las, day()).unwrap_err();
        assert!(err.to_string().contains("NP-7777/1"));
        assert!(validate(line, &raw("", None, None), &c, &las, day()).is_err());

        // Unknown Leistungsart dropped, confidence clamped / defaulted.
        let g = validate(line, &raw("NP-9000", Some("XYZ"), Some(7.0)), &c, &las, day()).unwrap();
        assert_eq!((g.leistungsart, g.confidence), (None, 1.0));
        assert_eq!(g.line, "/zeit NP-9000 2h habe am Interface-Mapping gearbeitet");
        assert_eq!(validate(line, &raw("NP-9000", None, None), &c, &las, day()).unwrap().confidence, 0.5);
        assert_eq!(validate(line, &raw("NP-9000", None, Some(f64::NAN)), &c, &las, day()).unwrap().confidence, 0.5);

        // A Leistungsart the user wrote wins.
        let g = validate("/zeit 1h #PM Abstimmung", &raw("NP-8801/1010", Some("DEV"), None), &c, &las, day()).unwrap();
        assert_eq!(g.line, "/zeit NP-8801/1010 1h #PM Abstimmung");
        assert_eq!(g.leistungsart.as_deref(), Some("PM"));
        // A line that already has a reference is no case for the AI.
        assert!(validate("/zeit NP-9000 1h x", &raw("NP-9000", None, None), &c, &las, day()).is_err());
    }
}
