//! One-shot text transformations: the inline AI bar in the editor
//! („Kürzen“, „Übersetzen“, …) and the meeting summary of a page.
//!
//! The UI builds the instruction; this module wraps it and the text into a
//! request that asks for the result only, as Markdown, without retrieval.

use super::client::ChatMessage;

/// Longest text sent along (characters); longer pages are cut.
pub const MAX_TEXT_CHARS: usize = 60_000;

/// The system prompt of a transformation. `today` is shown to the model so
/// relative dates („nächsten Freitag“) can become `YYYY-MM-DD`.
pub fn system_prompt(today: &str) -> String {
    format!(
        "Du bearbeitest Texte in Annalo, einem Notizprogramm mit Markdown. Heute ist {today}. \
         Führe die Anweisung des Nutzers auf den Text zwischen <text> und </text> aus. Antworte \
         ausschließlich mit dem Ergebnis in Markdown: keine Einleitung, keine Erklärung, kein \
         umschließender Codeblock. Behalte Links ([[Seite]], [Text](URL)), #Tags, Aufgaben \
         (- [ ] …, 📅 JJJJ-MM-TT, !/!!) und /zeit-Zeilen unverändert bei, sofern die Anweisung \
         nichts anderes verlangt. Behalte die Sprache des Textes bei, außer beim Übersetzen."
    )
}

/// Messages for one transformation of `text` according to `instruction`.
pub fn messages(instruction: &str, text: &str, page_title: Option<&str>, today: &str) -> Vec<ChatMessage> {
    let text: String = text.chars().take(MAX_TEXT_CHARS).collect();
    let mut user = String::new();
    if let Some(t) = page_title.filter(|t| !t.trim().is_empty()) {
        user.push_str(&format!("Seite: „{}“\n\n", t.trim()));
    }
    user.push_str(&format!("Anweisung: {}\n\n<text>\n{}\n</text>", instruction.trim(), text.trim_end()));
    vec![ChatMessage::system(system_prompt(today)), ChatMessage::user(user)]
}

/// Removes a code fence the model put around the whole answer (```markdown … ```).
pub fn clean_output(answer: &str) -> String {
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
