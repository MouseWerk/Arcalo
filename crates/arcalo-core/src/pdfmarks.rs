//! Highlights in PDF attachments and taking them into a note.
//!
//! A highlight belongs to an attachment by its file name (renaming the file moves them along,
//! see [`crate::attachment_manager::rename`]); its rectangles are fractions of the page, so
//! they fit every zoom. In a note a highlight becomes a quote with a link back to its place:
//! `> „text“ ([[Bericht.pdf#page=12&hl=7|S. 12]])`. That is the file link syntax the editor,
//! the mirror and the export already know (`#page=` opens the page, also in Obsidian); `hl=`
//! makes the viewer flash the highlight.

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::{tr, trf};

/// Highlight colors (the viewer's palette).
pub const COLORS: &[&str] = &["yellow", "green", "blue", "pink", "purple"];
/// Longest highlight text kept.
const MAX_TEXT: usize = 4000;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PdfHighlight {
    pub id: i64,
    pub attachment: String,
    /// 1-based page number.
    pub page: i64,
    /// `[x, y, w, h]` per line, fractions of the page.
    pub rects: Vec<[f64; 4]>,
    pub text: String,
    pub color: String,
    pub note: String,
    pub created_at: String,
}

/// A new highlight from the viewer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewHighlight {
    pub attachment: String,
    pub page: i64,
    pub rects: Vec<[f64; 4]>,
    pub text: String,
    pub color: String,
    #[serde(default)]
    pub note: String,
}

fn check_color(color: &str) -> Result<()> {
    if COLORS.contains(&color) {
        Ok(())
    } else {
        Err(Error::State(trf!("Unbekannte Farbe „{color}“", "Unknown color “{color}”")))
    }
}

/// Collapses whitespace and joins words hyphenated at a line break (`Ver- arbeitung`).
pub fn clean_text(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::with_capacity(joined.len());
    let chars: Vec<char> = joined.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '-'
            && i > 0
            && chars[i - 1].is_lowercase()
            && chars.get(i + 1) == Some(&' ')
            && chars.get(i + 2).is_some_and(|c| c.is_lowercase())
        {
            i += 2;
            continue;
        }
        out.push(chars[i]);
        i += 1;
    }
    out.chars().take(MAX_TEXT).collect()
}

/// Escapes what Markdown would read as formatting or a link inside a quote.
fn escape_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '~' | '$' | '#') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The link back to a highlight: `[[name#page=12&hl=7|S. 12]]`.
pub fn highlight_link(h: &PdfHighlight) -> String {
    let label = trf!("S. {}", "p. {}", h.page);
    format!("[[{}#page={}&hl={}|{label}]]", h.attachment, h.page, h.id)
}

/// A highlight as a Markdown quote with its link, and its note below.
pub fn quote_markdown(h: &PdfHighlight) -> String {
    let (open, close) = if crate::i18n::is_en() { ("\u{201c}", "\u{201d}") } else { ("\u{201e}", "\u{201c}") };
    let mut out = format!("> {open}{}{close} ({})", escape_inline(&clean_text(&h.text)), highlight_link(h));
    let note = h.note.split_whitespace().collect::<Vec<_>>().join(" ");
    if !note.is_empty() {
        out.push_str(&format!("\n>\n> *{}*", escape_inline(&note)));
    }
    out.push('\n');
    out
}

/// „Alle Markierungen übernehmen“: a heading with the file and every highlight as a quote, in
/// page order.
pub fn summary_markdown(name: &str, highlights: &[PdfHighlight]) -> String {
    let mut out = trf!("### Markierungen aus [[{name}]]\n\n", "### Highlights from [[{name}]]\n\n");
    let mut sorted: Vec<&PdfHighlight> = highlights.iter().collect();
    sorted.sort_by(|a, b| {
        let top = |h: &PdfHighlight| h.rects.first().map_or(0.0, |r| r[1]);
        a.page.cmp(&b.page).then(top(a).total_cmp(&top(b))).then(a.id.cmp(&b.id))
    });
    let quotes: Vec<String> = sorted.iter().map(|h| quote_markdown(h)).collect();
    out.push_str(&quotes.join("\n"));
    out
}

fn map_row(r: &rusqlite::Row) -> rusqlite::Result<PdfHighlight> {
    let rects: String = r.get(3)?;
    Ok(PdfHighlight {
        id: r.get(0)?,
        attachment: r.get(1)?,
        page: r.get(2)?,
        rects: serde_json::from_str(&rects).unwrap_or_default(),
        text: r.get(4)?,
        color: r.get(5)?,
        note: r.get(6)?,
        created_at: r.get(7)?,
    })
}

const COLS: &str = "id, attachment, page, rects, text, color, note, created_at";

impl Database {
    /// The highlights of a PDF attachment, by page and position.
    pub fn pdf_highlights(&self, attachment: &str) -> Result<Vec<PdfHighlight>> {
        let mut st = self
            .conn()
            .prepare_cached(&format!("SELECT {COLS} FROM pdf_highlights WHERE attachment = ?1 ORDER BY page, id"))?;
        Ok(st.query_map([attachment], map_row)?.collect::<rusqlite::Result<_>>()?)
    }

    pub fn pdf_highlight(&self, id: i64) -> Result<PdfHighlight> {
        self.conn()
            .query_row(&format!("SELECT {COLS} FROM pdf_highlights WHERE id = ?1"), [id], map_row)
            .optional()?
            .ok_or_else(|| Error::not_found("highlight", id.to_string()))
    }

    pub fn add_pdf_highlight(&self, h: &NewHighlight) -> Result<PdfHighlight> {
        check_color(&h.color)?;
        let text = clean_text(&h.text);
        if text.is_empty() {
            return Err(Error::State(tr!("Die Markierung enthält keinen Text", "The highlight has no text").into()));
        }
        if h.page < 1
            || h.rects.is_empty()
            || h.rects.iter().flatten().any(|v| !v.is_finite() || *v < -0.01 || *v > 1.01)
        {
            return Err(Error::State(tr!("Ungültige Position der Markierung", "Invalid highlight position").into()));
        }
        self.conn().execute(
            "INSERT INTO pdf_highlights (attachment, page, rects, text, color, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                h.attachment,
                h.page,
                serde_json::to_string(&h.rects)?,
                text,
                h.color,
                h.note.trim(),
                crate::db::ts(chrono::Utc::now())
            ],
        )?;
        self.pdf_highlight(self.conn().last_insert_rowid())
    }

    /// Changes the color and/or the note of a highlight.
    pub fn update_pdf_highlight(&self, id: i64, color: Option<&str>, note: Option<&str>) -> Result<PdfHighlight> {
        if let Some(c) = color {
            check_color(c)?;
            self.conn().execute("UPDATE pdf_highlights SET color = ?2 WHERE id = ?1", params![id, c])?;
        }
        if let Some(n) = note {
            self.conn().execute("UPDATE pdf_highlights SET note = ?2 WHERE id = ?1", params![id, n.trim()])?;
        }
        self.pdf_highlight(id)
    }

    pub fn delete_pdf_highlight(&self, id: i64) -> Result<()> {
        self.conn().execute("DELETE FROM pdf_highlights WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Highlights follow their file when it is renamed.
    pub fn rename_pdf_highlights(&self, old: &str, new: &str) -> Result<()> {
        self.conn().execute("UPDATE pdf_highlights SET attachment = ?2 WHERE attachment = ?1", params![old, new])?;
        Ok(())
    }

    /// Appends Markdown to a page (a highlight taken into a note that is not open in an editor).
    pub fn append_to_page(&self, page_id: i64, markdown: &str) -> Result<()> {
        if self.is_canvas(page_id)? {
            return Err(Error::State(
                tr!("In eine Canvas lässt sich nichts anhängen", "Nothing can be appended to a canvas").into(),
            ));
        }
        let content: String =
            self.conn().query_row("SELECT content FROM pages WHERE id = ?1", [page_id], |r| r.get(0))?;
        self.save_page_content(page_id, &crate::capture::append_markdown(&content, markdown))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new(page: i64, text: &str) -> NewHighlight {
        NewHighlight {
            attachment: "Bericht.pdf".into(),
            page,
            rects: vec![[0.1, 0.2, 0.5, 0.02]],
            text: text.into(),
            color: "yellow".into(),
            note: String::new(),
        }
    }

    #[test]
    fn stores_updates_and_deletes_highlights() {
        let db = Database::open_in_memory().unwrap();
        let a = db.add_pdf_highlight(&new(3, "Die  Daten-\nver- arbeitung *läuft*")).unwrap();
        let b = db.add_pdf_highlight(&new(1, "Erste Seite")).unwrap();
        assert_eq!(a.text, "Die Datenverarbeitung *läuft*");
        assert_eq!(a.rects, vec![[0.1, 0.2, 0.5, 0.02]]);
        let list = db.pdf_highlights("Bericht.pdf").unwrap();
        assert_eq!(list.iter().map(|h| h.id).collect::<Vec<_>>(), [b.id, a.id]);
        let a = db.update_pdf_highlight(a.id, Some("green"), Some("  wichtig ")).unwrap();
        assert_eq!((a.color.as_str(), a.note.as_str()), ("green", "wichtig"));
        assert!(db.update_pdf_highlight(a.id, Some("rot"), None).is_err());
        assert!(db.add_pdf_highlight(&NewHighlight { text: "  ".into(), ..new(1, "") }).is_err());
        assert!(db.add_pdf_highlight(&NewHighlight { rects: vec![[0.0, 2.0, 0.1, 0.1]], ..new(1, "x") }).is_err());
        db.rename_pdf_highlights("Bericht.pdf", "Bericht 2026.pdf").unwrap();
        assert_eq!(db.pdf_highlights("Bericht 2026.pdf").unwrap().len(), 2);
        db.delete_pdf_highlight(b.id).unwrap();
        assert_eq!(db.pdf_highlights("Bericht 2026.pdf").unwrap().len(), 1);
    }

    #[test]
    fn quotes_link_back_to_the_page() {
        let h = PdfHighlight {
            id: 7,
            attachment: "Bericht.pdf".into(),
            page: 12,
            rects: vec![],
            text: "Kosten [netto] *steigen*".into(),
            color: "yellow".into(),
            note: "prüfen".into(),
            created_at: String::new(),
        };
        let q = quote_markdown(&h);
        assert_eq!(
            q,
            "> \u{201e}Kosten \\[netto\\] \\*steigen\\*\u{201c} ([[Bericht.pdf#page=12&hl=7|S. 12]])\n>\n> *prüfen*\n"
        );
        // The link is a file link: no missing page, the attachment counts as used.
        assert_eq!(crate::notes::wiki_links(&q), ["Bericht.pdf"]);
        let s =
            summary_markdown("Bericht.pdf", &[h.clone(), PdfHighlight { id: 3, page: 2, note: String::new(), ..h }]);
        assert!(s.starts_with("### Markierungen aus [[Bericht.pdf]]\n\n> "));
        assert!(s.find("hl=3").unwrap() < s.find("hl=7").unwrap());
    }

    #[test]
    fn appends_to_a_page() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Lesenotizen", None).unwrap();
        db.save_page_content(p.id, "Start").unwrap();
        db.append_to_page(p.id, "> „x“").unwrap();
        assert!(db.page_doc(p.id).unwrap().content.starts_with("Start\n\n> „x“"));
    }
}
