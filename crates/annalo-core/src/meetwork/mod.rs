//! Smart meeting work (1.10): „Besprechung vorbereiten“ ([`prep`]), „Statusbericht“
//! ([`status`]) and „Nachfass-Mail“ ([`followup`]).
//!
//! All three build pages or mails from the local stores (calendar, notes, tasks, the Jira
//! cache, time entries) without any AI; a short AI paragraph is optional and built from
//! titles, excerpts and counts only, within a fixed character budget per feature
//! ([`prep::PROMPT_BUDGET`], [`status::PROMPT_BUDGET`], [`followup::PROMPT_BUDGET`]). The shell
//! routes a request with private content (`#privat`, a private appointment) to the local model.
//!
//! Pages the app writes again on „Aktualisieren“ keep their generated part between two
//! markers ([`block`]); what the user writes outside stays.

pub mod block;
pub mod followup;
pub mod prep;
pub mod status;

#[cfg(test)]
mod tests;

/// The items of the list sections of a note, by heading: `(heading in lower case, items)`.
/// Items are the text of `- …`, `* …` and `1. …` lines (task boxes kept as written), up to
/// the next heading of the same or a higher level. Code blocks are skipped.
pub fn list_sections(markdown: &str) -> Vec<(String, Vec<String>)> {
    let mut out: Vec<(String, usize, Vec<String>)> = vec![];
    let mut fence = false;
    for line in markdown.lines() {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
            continue;
        }
        if fence {
            continue;
        }
        if let Some(level) = heading_level(t) {
            let title = t[level..].trim().trim_end_matches(':').trim_matches('*').trim().to_lowercase();
            out.push((title, level, vec![]));
            continue;
        }
        if let Some(item) = list_item(line)
            && let Some(last) = out.last_mut()
        {
            // Only top-level items; nested ones belong to their parent.
            if line.len() - t.len() <= 1 {
                last.2.push(item.to_owned());
            } else if let Some(prev) = last.2.last_mut() {
                prev.push_str(" – ");
                prev.push_str(item);
            }
        }
    }
    out.into_iter().map(|(h, _, items)| (h, items)).collect()
}

/// The level of a Markdown heading line (`## x` → 2).
pub fn heading_level(line: &str) -> Option<usize> {
    let n = line.bytes().take_while(|b| *b == b'#').count();
    (1..=6).contains(&n).then_some(n).filter(|n| line[*n..].starts_with(' '))
}

/// The text of a list item line, or `None`.
pub fn list_item(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix("- ").or_else(|| t.strip_prefix("* ")).or_else(|| t.strip_prefix("+ ")) {
        let rest = rest.trim();
        return (!rest.is_empty() && rest != "[ ]" && rest != "[x]").then_some(rest);
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 {
        let rest = &t[digits..];
        if let Some(r) = rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")) {
            let r = r.trim();
            return (!r.is_empty()).then_some(r);
        }
    }
    None
}

/// Headings of decision sections (lower case).
pub const DECISION_HEADINGS: &[&str] =
    &["entscheidungen", "entscheidung", "beschlüsse", "beschluss", "decisions", "decision", "decisions made"];
/// Headings of result sections (lower case).
pub const RESULT_HEADINGS: &[&str] =
    &["ergebnisse", "ergebnis", "results", "result", "outcomes", "outcome", "zusammenfassung", "summary"];
/// Headings of open point sections (lower case).
pub const OPEN_HEADINGS: &[&str] = &[
    "offene punkte",
    "offene fragen",
    "offen",
    "open points",
    "open issues",
    "open questions",
    "parking lot",
    "risiken",
    "risks",
];

/// Items of the sections whose heading is one of `headings`; empty placeholder items („-“,
/// „keine“) are left out.
pub fn items_under(markdown: &str, headings: &[&str]) -> Vec<String> {
    list_sections(markdown)
        .into_iter()
        .filter(|(h, _)| headings.contains(&h.as_str()))
        .flat_map(|(_, items)| items)
        .map(|i| i.trim().to_owned())
        .filter(|i| {
            !matches!(i.to_lowercase().as_str(), "" | "-" | "—" | "keine" | "keine." | "none" | "none." | "n/a")
        })
        .collect()
}

/// `text` cut to `max` characters at a word boundary, with „…“.
pub fn clip(text: &str, max: usize) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= max {
        return text;
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    let whole_word = text.chars().nth(max.saturating_sub(1)).is_some_and(char::is_whitespace);
    let cut = match cut.rfind(' ') {
        _ if whole_word => cut,
        Some(at) if at > max / 2 => cut[..at].to_owned(),
        _ => cut,
    };
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.', ' ']))
}

/// The forms a person's name is written in: „Müller, Anna“ also as „Anna Müller“ and back.
pub fn name_forms(name: &str) -> Vec<String> {
    let entry = name.trim();
    let name = crate::calsync::attendee_name(entry);
    let mut out = vec![name.to_owned()];
    // `Anna Müller <anna@firma.de>`: the address is a form too.
    if name != entry {
        out.push(entry[name.len()..].trim().trim_start_matches('<').trim_end_matches('>').to_owned());
    }
    if let Some((last, first)) = name.split_once(", ") {
        out.push(format!("{} {}", first.trim(), last.trim()));
    } else if !name.contains('@') {
        let words: Vec<&str> = name.split_whitespace().collect();
        if words.len() == 2 {
            out.push(format!("{}, {}", words[1], words[0]));
        }
    }
    out.retain(|s| s.chars().count() >= 3);
    out.dedup();
    out
}

/// The displayable form of a person's name („Müller, Anna“ → „Anna Müller“).
pub fn display_name(name: &str) -> String {
    let name = crate::calsync::attendee_name(name);
    match name.trim().split_once(", ") {
        Some((last, first)) if !name.contains('@') => format!("{} {}", first.trim(), last.trim()),
        _ => name.trim().to_owned(),
    }
}

/// Whether two names stand for the same person (any of their forms, ignoring case).
pub fn same_person(a: &str, b: &str) -> bool {
    let b_forms: Vec<String> = name_forms(b).into_iter().map(|s| s.to_lowercase()).collect();
    name_forms(a).into_iter().any(|f| b_forms.contains(&f.to_lowercase()))
}
