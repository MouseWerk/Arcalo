//! „Nachfass-Mail“: a summary mail of a meeting from its note – the results, the decisions
//! and the action items with owner and due date – as an Outlook draft (shown, never sent), a
//! `mailto:` link with a shortened plain text, or text/HTML to copy.
//!
//! Without AI the content comes from the note itself ([`extract`]): the tasks (`- [ ] … @Anna
//! due:…`) and the lists under „Ergebnisse“, „Entscheidungen“, „Results“, „Decisions“ (and
//! similar headings). „Mit KI formulieren“ only adds a short opening paragraph written from
//! these items ([`polish_messages`], at most [`PROMPT_BUDGET`] characters of context).
//!
//! The mail is written in the note's language when it can be told ([`note_lang`]), else in
//! the display language.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use super::{DECISION_HEADINGS, RESULT_HEADINGS, clip, display_name, items_under, list_sections, same_person};
use crate::ai::client::ChatMessage;

/// Characters of meeting content in the request of „Mit KI formulieren“ (about 500 tokens).
pub const PROMPT_BUDGET: usize = 2000;
/// Longest `mailto:` link: mail programs and Windows cut longer ones (about 2000 characters).
pub const MAILTO_MAX: usize = 1800;
/// Items per list in the mail.
const MAX_ITEMS: usize = 30;

/// One action item of the mail.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FollowAction {
    pub text: String,
    pub owner: Option<String>,
    /// `YYYY-MM-DD`.
    pub due: Option<String>,
    pub done: bool,
}

/// The follow-up mail of a meeting note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowUp {
    pub page_id: i64,
    /// The attendees as the calendar has them (names or addresses).
    pub to: Vec<String>,
    pub subject: String,
    /// `de` or `en`: the language of the mail.
    pub lang: String,
    /// The meeting's subject.
    pub meeting: String,
    pub date: Option<NaiveDate>,
    /// An opening paragraph: the note's summary, or the one written by the AI.
    pub intro: String,
    pub results: Vec<String>,
    pub decisions: Vec<String>,
    pub actions: Vec<FollowAction>,
    /// The note or the appointment is private: the AI request stays local.
    pub private: bool,
    /// The opening was written by the AI.
    #[serde(default)]
    pub polished: bool,
}

/// What the dialog shows and copies.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FollowUpView {
    pub followup: FollowUp,
    pub html: String,
    pub text: String,
    pub mailto: String,
    /// The text in the `mailto:` link was shortened.
    pub mailto_truncated: bool,
    /// An Outlook draft can be made here (Windows, Outlook Classic).
    pub outlook: bool,
}

// ------------------------------------------------------------------ language

/// The fixed texts of the mail in one language.
struct Words {
    greeting: &'static str,
    lead: &'static str,
    results: &'static str,
    decisions: &'static str,
    actions: &'static str,
    task: &'static str,
    owner: &'static str,
    due: &'static str,
    done: &'static str,
    nothing: &'static str,
    closing: &'static str,
    subject: &'static str,
    date_format: &'static str,
    cut: &'static str,
}

const DE: Words = Words {
    greeting: "Hallo zusammen,",
    lead: "hier die Zusammenfassung unserer Besprechung",
    results: "Ergebnisse",
    decisions: "Entscheidungen",
    actions: "Aufgaben",
    task: "Aufgabe",
    owner: "Verantwortlich",
    due: "Fällig",
    done: "erledigt",
    nothing: "Keine Einträge.",
    closing: "Viele Grüße",
    subject: "Zusammenfassung",
    date_format: "%d.%m.%Y",
    cut: "[…] Gekürzt: den vollständigen Text in Arcalo mit „Als Text kopieren“ übernehmen.",
};

const EN: Words = Words {
    greeting: "Hello all,",
    lead: "here is the summary of our meeting",
    results: "Results",
    decisions: "Decisions",
    actions: "Action items",
    task: "Task",
    owner: "Owner",
    due: "Due",
    done: "done",
    nothing: "None.",
    closing: "Best regards",
    subject: "Summary",
    date_format: "%Y-%m-%d",
    cut: "[…] Shortened: paste the full text with “Copy as text” in Arcalo.",
};

fn words(lang: &str) -> &'static Words {
    if lang == "en" { &EN } else { &DE }
}

const DE_WORDS: &[&str] = &[
    "und",
    "der",
    "die",
    "das",
    "nicht",
    "mit",
    "für",
    "ist",
    "wir",
    "bis",
    "ein",
    "eine",
    "zu",
    "auf",
    "im",
    "den",
    "dem",
    "von",
    "wird",
    "sind",
    "aufgaben",
    "entscheidungen",
    "ergebnisse",
    "teilnehmer",
    "notizen",
];
const EN_WORDS: &[&str] = &[
    "the",
    "and",
    "to",
    "of",
    "with",
    "for",
    "is",
    "we",
    "by",
    "a",
    "on",
    "in",
    "will",
    "are",
    "be",
    "tasks",
    "decisions",
    "results",
    "attendees",
    "notes",
    "action",
];

/// `de` or `en` when the note's words say so clearly; `None` for too little text.
pub fn note_lang(markdown: &str) -> Option<&'static str> {
    let (mut de, mut en) = (0usize, 0usize);
    for w in markdown.split(|c: char| !c.is_alphanumeric() && c != 'ä' && c != 'ö' && c != 'ü' && c != 'ß') {
        let w = w.to_lowercase();
        if w.is_empty() {
            continue;
        }
        de += usize::from(DE_WORDS.contains(&w.as_str()));
        en += usize::from(EN_WORDS.contains(&w.as_str()));
    }
    if de + en < 4 {
        return None;
    }
    if de * 3 >= en * 4 && de > en {
        Some("de")
    } else if en * 3 >= de * 4 && en > de {
        Some("en")
    } else {
        None
    }
}

// ------------------------------------------------------------------ extraction

/// Markdown of a list item as plain text: links to their text, emphasis and code marks gone.
pub fn plain(md: &str) -> String {
    let mut s = md.to_owned();
    // [[Seite|Text]] and [[Seite]].
    while let Some(open) = s.find("[[") {
        let Some(close) = s[open..].find("]]").map(|c| open + c) else { break };
        let inner = &s[open + 2..close];
        let text = inner.split_once('|').map_or(inner, |(_, t)| t).to_owned();
        s.replace_range(open..close + 2, &text);
    }
    // [Text](url).
    while let Some(open) = s.find('[') {
        let Some(mid) = s[open..].find("](").map(|m| open + m) else { break };
        let Some(close) = s[mid..].find(')').map(|c| mid + c) else { break };
        let text = s[open + 1..mid].to_owned();
        s.replace_range(open..close + 1, &text);
    }
    for mark in ["**", "__", "~~", "`"] {
        s = s.replace(mark, "");
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Strips a front matter block; returns it (without the fences) and the rest.
pub fn split_front_matter(content: &str) -> (&str, &str) {
    if let Some(rest) = content.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---\n")
    {
        return (&rest[..end], &rest[end + 5..]);
    }
    if let Some(rest) = content.strip_prefix("---\n")
        && let Some(end) = rest.strip_suffix("\n---").map(str::len)
    {
        return (&rest[..end], "");
    }
    ("", content)
}

/// The first paragraph below a summary heading („Zusammenfassung“, „Summary“), up to 600
/// characters.
fn summary_paragraph(body: &str) -> String {
    let mut inside = false;
    let mut out: Vec<&str> = vec![];
    for line in body.lines() {
        let t = line.trim();
        if let Some(level) = super::heading_level(t) {
            if inside {
                break;
            }
            let h = t[level..].trim().trim_end_matches(':').to_lowercase();
            inside = h == "zusammenfassung" || h == "summary";
            continue;
        }
        if !inside {
            continue;
        }
        if t.is_empty() {
            if out.is_empty() {
                continue;
            }
            break;
        }
        if super::list_item(line).is_some() {
            break;
        }
        out.push(t);
    }
    clip(&plain(&out.join(" ")), 600)
}

/// The content of the mail from a meeting note (no AI): `meeting`/`date`/`to` come from the
/// appointment when the note belongs to one, else from the note. `ui_lang` is used when the
/// note's language cannot be told.
pub fn extract(
    page_id: i64,
    content: &str,
    meeting: &str,
    date: Option<NaiveDate>,
    to: Vec<String>,
    ui_lang: &str,
    today: NaiveDate,
) -> FollowUp {
    let (_, body) = split_front_matter(content);
    let lang = note_lang(body).unwrap_or(if ui_lang == "en" { "en" } else { "de" }).to_owned();
    let w = words(&lang);
    let mut results: Vec<String> = items_under(body, RESULT_HEADINGS).iter().map(|i| plain(i)).collect();
    results.retain(|r| !r.starts_with("[ ]") && !r.starts_with("[x]"));
    let mut decisions: Vec<String> = items_under(body, DECISION_HEADINGS).iter().map(|i| plain(i)).collect();
    // „- Entscheidung: …“ anywhere else.
    for (h, items) in list_sections(body) {
        if DECISION_HEADINGS.contains(&h.as_str()) {
            continue;
        }
        for i in items {
            let lower = i.to_lowercase();
            for p in ["entscheidung:", "beschluss:", "decision:", "decided:"] {
                if lower.starts_with(p) {
                    decisions.push(plain(i[p.len()..].trim()));
                }
            }
        }
    }
    let mut actions = vec![];
    for t in crate::tasks::parse_tasks(body) {
        let parsed = crate::voice::actions::parse_item(&t.text, today);
        let (text, owner) = match parsed {
            Some(a) => (a.text, a.assignee),
            None => (t.text.clone(), None),
        };
        let text = plain(&text);
        if text.is_empty() {
            continue;
        }
        actions.push(FollowAction { text, owner: owner.map(|o| display_name(&o)), due: t.due, done: t.done });
    }
    results.truncate(MAX_ITEMS);
    decisions.dedup();
    decisions.truncate(MAX_ITEMS);
    actions.truncate(MAX_ITEMS);
    let meeting = meeting.trim().to_owned();
    let subject = match date {
        Some(d) => format!("{}: {meeting} ({})", w.subject, d.format(w.date_format)),
        None => format!("{}: {meeting}", w.subject),
    };
    FollowUp {
        page_id,
        to,
        subject,
        lang,
        meeting,
        date,
        intro: summary_paragraph(body),
        results,
        decisions,
        actions,
        private: false,
        polished: false,
    }
}

// ------------------------------------------------------------------ bodies

/// The addresses in a recipient entry (`Anna Müller <anna@firma.de>`, `anna@firma.de`), lower case.
fn addresses_in(entry: &str) -> Vec<String> {
    entry
        .split(|c: char| c.is_whitespace() || matches!(c, '<' | '>' | ',' | ';' | '(' | ')' | '"'))
        .filter(|w| w.contains('@'))
        .map(|w| w.trim_start_matches("mailto:").to_lowercase())
        .collect()
}

/// `to` without the user's own entries: `own` holds addresses and names (the settings' own
/// addresses, the Jira accounts, Outlook's signed-in account). An entry is the user's when one
/// of its addresses is an own address, or its name is an own name in any form
/// („Müller, Anna“ = „Anna Müller“).
pub fn without_own(to: Vec<String>, own: &[String]) -> Vec<String> {
    let own_addresses: Vec<String> = own.iter().flat_map(|o| addresses_in(o)).collect();
    let own_names: Vec<&str> = own.iter().map(|o| o.trim()).filter(|o| !o.is_empty() && !o.contains('@')).collect();
    to.into_iter()
        .filter(|entry| {
            let addresses = addresses_in(entry);
            if addresses.iter().any(|a| own_addresses.contains(a)) {
                return false;
            }
            // The name part of `Name <address>`.
            let name = entry.split('<').next().unwrap_or("").trim().trim_matches('"');
            name.is_empty() || name.contains('@') || !own_names.iter().any(|o| same_person(name, o))
        })
        .collect()
}

/// Escapes text for HTML (element content and attribute values).
pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn due_text(due: &str, w: &Words) -> String {
    NaiveDate::parse_from_str(due, "%Y-%m-%d").map(|d| d.format(w.date_format).to_string()).unwrap_or(due.to_owned())
}

fn lead(f: &FollowUp, w: &Words) -> String {
    let quoted = if f.lang == "en" { format!("“{}”", f.meeting) } else { format!("„{}“", f.meeting) };
    match f.date {
        Some(d) if f.lang == "en" => format!("{} {quoted} on {}.", w.lead, d.format(w.date_format)),
        Some(d) => format!("{} {quoted} vom {}.", w.lead, d.format(w.date_format)),
        None => format!("{} {quoted}.", w.lead),
    }
}

/// The mail as HTML (Outlook's `HTMLBody`, „Als HTML kopieren“). Every text from the note is
/// escaped.
pub fn html_body(f: &FollowUp) -> String {
    let w = words(&f.lang);
    let mut h = String::from(
        "<html><head><meta charset=\"utf-8\"></head>\
         <body style=\"font-family:'Segoe UI',Arial,sans-serif;font-size:11pt;color:#1f2328\">\n",
    );
    h.push_str(&format!("<p>{}</p>\n<p>{}</p>\n", escape_html(w.greeting), escape_html(&lead(f, w))));
    if !f.intro.trim().is_empty() {
        h.push_str(&format!("<p>{}</p>\n", escape_html(f.intro.trim())));
    }
    let list = |h: &mut String, title: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        h.push_str(&format!("<h3 style=\"font-size:12pt;margin:16px 0 6px\">{}</h3>\n<ul>\n", escape_html(title)));
        for i in items {
            h.push_str(&format!("<li>{}</li>\n", escape_html(i)));
        }
        h.push_str("</ul>\n");
    };
    list(&mut h, w.results, &f.results);
    list(&mut h, w.decisions, &f.decisions);
    if !f.actions.is_empty() {
        let cell = "style=\"border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top\"";
        h.push_str(&format!("<h3 style=\"font-size:12pt;margin:16px 0 6px\">{}</h3>\n", escape_html(w.actions)));
        h.push_str("<table style=\"border-collapse:collapse\">\n<tr>");
        for head in [w.task, w.owner, w.due] {
            h.push_str(&format!("<th {cell}>{}</th>", escape_html(head)));
        }
        h.push_str("</tr>\n");
        for a in &f.actions {
            let text = if a.done { format!("{} ({})", escape_html(&a.text), w.done) } else { escape_html(&a.text) };
            h.push_str(&format!(
                "<tr><td {cell}>{text}</td><td {cell}>{}</td><td {cell}>{}</td></tr>\n",
                escape_html(a.owner.as_deref().unwrap_or("–")),
                escape_html(&a.due.as_deref().map(|d| due_text(d, w)).unwrap_or_else(|| "–".into())),
            ));
        }
        h.push_str("</table>\n");
    }
    if f.results.is_empty() && f.decisions.is_empty() && f.actions.is_empty() && f.intro.trim().is_empty() {
        h.push_str(&format!("<p>{}</p>\n", escape_html(w.nothing)));
    }
    h.push_str(&format!("<p>{}</p>\n</body></html>\n", escape_html(w.closing)));
    h
}

/// The mail as plain text (`mailto:`, „Als Text kopieren“).
pub fn text_body(f: &FollowUp) -> String {
    let w = words(&f.lang);
    let mut t = format!("{}\n\n{}\n", w.greeting, lead(f, w));
    if !f.intro.trim().is_empty() {
        t.push_str(&format!("\n{}\n", f.intro.trim()));
    }
    let list = |t: &mut String, title: &str, items: &[String]| {
        if items.is_empty() {
            return;
        }
        t.push_str(&format!("\n{title}\n"));
        for i in items {
            t.push_str(&format!("- {i}\n"));
        }
    };
    list(&mut t, w.results, &f.results);
    list(&mut t, w.decisions, &f.decisions);
    if !f.actions.is_empty() {
        t.push_str(&format!("\n{}\n", w.actions));
        for a in &f.actions {
            let mut line = format!("- {}", a.text);
            if let Some(o) = &a.owner {
                line.push_str(&format!(" ({}: {o})", w.owner));
            }
            if let Some(d) = &a.due {
                line.push_str(&format!(" – {}: {}", w.due, due_text(d, w)));
            }
            if a.done {
                line.push_str(&format!(" [{}]", w.done));
            }
            t.push_str(&line);
            t.push('\n');
        }
    }
    t.push_str(&format!("\n{}\n", w.closing));
    t
}

/// Percent-encoding of a `mailto:` part (RFC 6068): everything but unreserved characters.
fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The address of a recipient entry for a `mailto:` link (RFC 6068 takes bare addresses):
/// `Anna Müller <anna@firma.de>` → `anna@firma.de`; entries without an address are left out.
fn mailto_address(entry: &str) -> Option<&str> {
    let e = entry.trim();
    let a = match e.strip_suffix('>').and_then(|rest| rest.rsplit_once('<')) {
        Some((_, address)) => address.trim(),
        None => e.trim_start_matches("mailto:"),
    };
    (a.contains('@') && !a.contains(char::is_whitespace)).then_some(a)
}

/// The `mailto:` link: the attendees' addresses, subject and the plain text,
/// shortened line by line to [`MAILTO_MAX`] with a hint. Returns the link and whether the
/// text was shortened.
pub fn mailto(f: &FollowUp) -> (String, bool) {
    let w = words(&f.lang);
    let to: Vec<String> = f.to.iter().filter_map(|a| mailto_address(a)).map(encode).collect();
    let head = format!("mailto:{}?subject={}&body=", to.join(","), encode(&f.subject));
    let text = text_body(f).replace('\n', "\r\n");
    let full = format!("{head}{}", encode(&text));
    if full.len() <= MAILTO_MAX {
        return (full, false);
    }
    let hint = format!("\r\n{}\r\n", w.cut);
    let budget = MAILTO_MAX.saturating_sub(head.len() + encode(&hint).len());
    let mut body = String::new();
    let mut used = 0;
    for line in text.split_inclusive("\r\n") {
        let enc = encode(line);
        if used + enc.len() > budget {
            break;
        }
        used += enc.len();
        body.push_str(line);
    }
    body.push_str(&hint);
    (format!("{head}{}", encode(&body)), true)
}

/// Everything the dialog needs.
pub fn view(f: FollowUp, outlook: bool) -> FollowUpView {
    let html = html_body(&f);
    let text = text_body(&f);
    let (mailto, mailto_truncated) = mailto(&f);
    FollowUpView { followup: f, html, text, mailto, mailto_truncated, outlook }
}

// ------------------------------------------------------------------ AI

/// The request of „Mit KI formulieren“: an opening paragraph from the subject and the items
/// (each clipped, the whole context at most [`PROMPT_BUDGET`] characters).
pub fn polish_messages(f: &FollowUp) -> Vec<ChatMessage> {
    let system = if f.lang == "en" {
        "You write the opening paragraph of a follow-up e-mail after a meeting. Answer in English with 2 or 3 \
         friendly, factual sentences that summarize the outcome. Mention only what is in the data; no greeting, no \
         sign-off, no list, no heading."
    } else {
        "Du schreibst den Einleitungsabsatz einer Nachfass-Mail nach einer Besprechung. Antworte auf Deutsch mit 2 \
         bis 3 freundlichen, sachlichen Sätzen, die das Ergebnis zusammenfassen. Nenne nur, was in den Daten steht; \
         keine Anrede, kein Gruß, keine Liste, keine Überschrift."
    };
    let mut ctx = format!("Meeting: {}\n", clip(&f.meeting, 120));
    let mut push = |label: &str, items: &mut dyn Iterator<Item = String>| {
        let mut part = String::new();
        for i in items.take(8) {
            part.push_str(&format!("- {}\n", clip(&i, 160)));
        }
        if !part.is_empty() {
            ctx.push_str(&format!("{label}:\n{part}"));
        }
    };
    push("Results", &mut f.results.iter().cloned());
    push("Decisions", &mut f.decisions.iter().cloned());
    push(
        "Actions",
        &mut f.actions.iter().map(|a| match &a.owner {
            Some(o) => format!("{} ({o})", a.text),
            None => a.text.clone(),
        }),
    );
    if f.actions.len() > 8 {
        ctx.push_str(&format!("({} actions in total)\n", f.actions.len()));
    }
    if !f.intro.is_empty() {
        ctx.push_str(&format!("Summary: {}\n", clip(&f.intro, 300)));
    }
    let ctx = clip_block(&ctx, PROMPT_BUDGET);
    vec![ChatMessage::system(system), ChatMessage::user(ctx)]
}

/// A multi-line context cut to `max` characters at a line end.
pub fn clip_block(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out = String::new();
    for line in text.lines() {
        if out.chars().count() + line.chars().count() + 2 > max {
            out.push('…');
            break;
        }
        out.push_str(line);
        out.push('\n');
    }
    out
}

/// The answer as one paragraph (lists and headings flattened), at most 700 characters.
pub fn clean_intro(text: &str) -> String {
    let joined: Vec<&str> =
        text.lines().map(|l| l.trim().trim_start_matches(['-', '*', '#']).trim()).filter(|l| !l.is_empty()).collect();
    clip(&joined.join(" "), 700)
}
