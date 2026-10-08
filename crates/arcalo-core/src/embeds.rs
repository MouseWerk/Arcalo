//! Page embeds in Obsidian syntax: `![[Seite]]` shows a whole page, `![[Seite#Überschrift]]` the
//! section of that heading (up to the next heading of the same or a higher level) and
//! `![[Seite#^block]]` the one block marked with `^block` at its end (or on the line after it).
//! The Markdown keeps the embed as written; this module only resolves what it shows. An embed
//! counts as a link of its target page (see [`crate::notes::wiki_links`]).

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::db::Database;
use crate::error::Result;

/// What an embed shows: the page (when it exists) and the embedded Markdown.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EmbedView {
    pub page_id: Option<i64>,
    /// The page's title (the target as written when there is no such page).
    pub title: String,
    pub icon: Option<String>,
    pub updated_at: Option<String>,
    /// The embedded Markdown (without frontmatter); `None` when the page or the anchor is missing.
    pub content: Option<String>,
    /// `"page"` when no page has the title, `"section"` when the heading or block is missing.
    pub missing: Option<&'static str>,
}

/// The fence marker of a line that opens or closes fenced code (```` ``` ```` or `~~~`).
fn fence_of(line: &str) -> Option<&str> {
    let t = line.trim_start();
    if t.starts_with("```") {
        Some("```")
    } else if t.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

/// For each line whether it is inside fenced code (fence lines included).
fn code_lines(lines: &[&str]) -> Vec<bool> {
    let mut open: Option<&str> = None;
    lines
        .iter()
        .map(|l| match (open, fence_of(l)) {
            (None, Some(f)) => {
                open = Some(f);
                true
            }
            (Some(o), Some(f)) if o == f && l.trim().chars().all(|c| f.starts_with(c)) => {
                open = None;
                true
            }
            (Some(_), _) => true,
            (None, None) => false,
        })
        .collect()
}

/// `## Titel ##` → (2, "Titel"); `None` for a line that is no ATX heading.
pub fn heading_of(line: &str) -> Option<(usize, &str)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &line[level..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some((level, rest.trim().trim_end_matches('#').trim_end()))
}

/// Heading text as compared with an anchor: case and inline formatting ignored, a block id at
/// its end dropped (`## Ziele ^z` is the heading „Ziele“).
fn heading_key(text: &str) -> String {
    let text = strip_block_id(text).0;
    text.chars().filter(|c| !matches!(c, '*' | '_' | '`' | '[' | ']' | '=')).collect::<String>().trim().to_lowercase()
}

/// A line without its block id at the end (`Text ^abc` → ("Text", Some("abc"))).
fn strip_block_id(line: &str) -> (&str, Option<&str>) {
    let t = line.trim_end();
    if let Some(i) = t.rfind('^') {
        let id = &t[i + 1..];
        let before = &t[..i];
        let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if valid && (before.is_empty() || before.ends_with([' ', '\t'])) {
            return (before.trim_end(), Some(id));
        }
    }
    (line, None)
}

/// The body of a page without its YAML frontmatter.
pub fn without_frontmatter(markdown: &str) -> &str {
    let Some(rest) = markdown.strip_prefix("---\n").or_else(|| markdown.strip_prefix("---\r\n")) else {
        return markdown;
    };
    let mut at = 0;
    for line in rest.split_inclusive('\n') {
        at += line.len();
        if line.trim_end() == "---" {
            return rest[at..].trim_start_matches(['\r', '\n']);
        }
    }
    markdown
}

/// The section of `heading` (the last part of `A#B`): the heading line and everything up to the
/// next heading of the same or a higher level, outside code.
pub fn heading_section(markdown: &str, heading: &str) -> Option<String> {
    let wanted = heading_key(heading.rsplit('#').next().unwrap_or(heading));
    if wanted.is_empty() {
        return None;
    }
    let lines: Vec<&str> = markdown.lines().collect();
    let code = code_lines(&lines);
    let start =
        (0..lines.len()).find(|&i| !code[i] && heading_of(lines[i]).is_some_and(|(_, t)| heading_key(t) == wanted))?;
    let (level, _) = heading_of(lines[start])?;
    let end = (start + 1..lines.len())
        .find(|&i| !code[i] && heading_of(lines[i]).is_some_and(|(l, _)| l <= level))
        .unwrap_or(lines.len());
    let mut out: Vec<&str> = lines[start..end].to_vec();
    out[0] = strip_block_id(out[0]).0;
    Some(out.join("\n").trim_end().to_owned())
}

fn indent(line: &str) -> usize {
    line.chars().take_while(|c| *c == ' ' || *c == '\t').map(|c| if c == '\t' { 4 } else { 1 }).sum()
}

fn is_list_item(line: &str) -> bool {
    let t = line.trim_start();
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    let rest = &t[digits..];
    if digits > 0 {
        return (rest.starts_with(". ") || rest.starts_with(") ")) || rest == "." || rest == ")";
    }
    t.starts_with("- ") || t.starts_with("* ") || t.starts_with("+ ") || t == "-" || t == "*"
}

/// The block marked `^id`: a list item (with its nested items), a heading line or the paragraph
/// whose last line ends with ` ^id`; with `^id` alone on a line, the block right above it.
pub fn block(markdown: &str, id: &str) -> Option<String> {
    let id = id.trim().trim_start_matches('^');
    if id.is_empty() {
        return None;
    }
    let lines: Vec<&str> = markdown.lines().collect();
    let code = code_lines(&lines);
    let at = (0..lines.len()).find(|&i| !code[i] && strip_block_id(lines[i]).1 == Some(id))?;
    let alone = strip_block_id(lines[at]).0.trim().is_empty();
    let blank = |i: usize| lines[i].trim().is_empty();
    let (from, to) = if alone {
        // The block above: skip blank lines, then up to the previous blank line.
        let mut end = at;
        while end > 0 && blank(end - 1) {
            end -= 1;
        }
        if end == 0 {
            return None;
        }
        let mut start = end - 1;
        while start > 0 && !blank(start - 1) && heading_of(lines[start]).is_none() {
            start -= 1;
        }
        (start, end)
    } else if heading_of(lines[at]).is_some() {
        (at, at + 1)
    } else if is_list_item(lines[at]) {
        let own = indent(lines[at]);
        let mut end = at + 1;
        while end < lines.len() && !blank(end) && indent(lines[end]) > own {
            end += 1;
        }
        (at, end)
    } else {
        let mut start = at;
        while start > 0 && !blank(start - 1) && heading_of(lines[start - 1]).is_none() && !is_list_item(lines[start]) {
            start -= 1;
        }
        let mut end = at + 1;
        while end < lines.len() && !blank(end) && heading_of(lines[end]).is_none() && !is_list_item(lines[end]) {
            end += 1;
        }
        (start, end)
    };
    let base = if is_list_item(lines[from]) { indent(lines[from]) } else { 0 };
    let out: Vec<String> = lines[from..to]
        .iter()
        .map(|l| {
            let l = strip_block_id(l).0;
            // A nested list item embedded alone starts at the left margin.
            l.get(base.min(indent(l))..).unwrap_or(l).to_owned()
        })
        .collect();
    Some(out.join("\n").trim_end().to_owned())
}

/// The Markdown an embed shows: the page body, a heading's section or a block; `None` when the
/// anchor is not found.
pub fn extract(markdown: &str, anchor: Option<&str>) -> Option<String> {
    let body = without_frontmatter(markdown);
    let anchor = anchor.map(|a| a.trim().trim_start_matches('#').trim()).filter(|a| !a.is_empty());
    let out = match anchor {
        None => Some(body.trim_end().to_owned()),
        Some(a) if a.starts_with('^') => block(body, a),
        Some(a) => heading_section(body, a),
    }?;
    Some(hide_block_ids(&out))
}

/// Block ids (`Text ^abc`) are markers, not text: an embed shows the lines without them.
fn hide_block_ids(markdown: &str) -> String {
    let lines: Vec<&str> = markdown.lines().collect();
    let code = code_lines(&lines);
    let kept: Vec<&str> = lines
        .iter()
        .zip(&code)
        .filter_map(|(l, &c)| {
            if c {
                return Some(*l);
            }
            let (text, id) = strip_block_id(l);
            // A line with only `^id` is dropped.
            if id.is_some() && text.trim().is_empty() { None } else { Some(text) }
        })
        .collect();
    kept.join("\n").trim_end().to_owned()
}

impl Database {
    /// Resolves `![[target#anchor]]` by page title (case-insensitive, like links).
    pub fn page_embed(&self, target: &str, anchor: Option<&str>) -> Result<EmbedView> {
        let Some(page) = self.page_by_title(target)? else {
            return Ok(EmbedView {
                page_id: None,
                title: target.trim().to_owned(),
                icon: None,
                updated_at: None,
                content: None,
                missing: Some("page"),
            });
        };
        let content: String = self
            .conn()
            .query_row("SELECT content FROM pages WHERE id = ?1", [page.id], |r| r.get(0))
            .optional()?
            .unwrap_or_default();
        let content = extract(&content, anchor);
        Ok(EmbedView {
            page_id: Some(page.id),
            title: page.title,
            icon: page.icon,
            updated_at: Some(page.updated_at),
            missing: if content.is_none() { Some("section") } else { None },
            content,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DOC: &str = "---\ntags: [a]\n---\n# Projekt\nIntro\n\n## Ziele\nSchnell sein.\n\n### Details\nMehr.\n\n```\n## Kein Titel\n```\n\n## Risiken ^r\nZu langsam. ^risk-1\nZweite Zeile\n\n- Punkt eins ^p1\n  - darunter\n- Punkt zwei\n\n> Zitat\n> weiter\n\n^quote\n";

    #[test]
    fn heading_sections_end_at_the_same_or_a_higher_level() {
        assert_eq!(
            heading_section(DOC, "Ziele").unwrap(),
            "## Ziele\nSchnell sein.\n\n### Details\nMehr.\n\n```\n## Kein Titel\n```"
        );
        assert_eq!(heading_section(DOC, "details").unwrap(), "### Details\nMehr.\n\n```\n## Kein Titel\n```");
        // `A#B` uses the last part; a block id after the heading is not part of its text.
        assert_eq!(heading_section(DOC, "Projekt#Risiken").unwrap().lines().next(), Some("## Risiken"));
        assert!(heading_section(DOC, "Kein Titel").is_none(), "headings in code do not count");
        assert!(heading_section(DOC, "Fehlt").is_none());
        assert!(
            extract(DOC, Some("#Projekt")).unwrap().ends_with("> Zitat\n> weiter"),
            "the top heading spans the page, ids hidden"
        );
    }

    #[test]
    fn blocks_by_id() {
        assert_eq!(block(DOC, "risk-1").unwrap(), "Zu langsam.\nZweite Zeile");
        assert_eq!(block(DOC, "^p1").unwrap(), "- Punkt eins\n  - darunter");
        assert_eq!(block(DOC, "quote").unwrap(), "> Zitat\n> weiter");
        assert_eq!(block(DOC, "r").unwrap(), "## Risiken");
        assert!(block(DOC, "nope").is_none());
        assert!(block("```\nText ^x\n```", "x").is_none(), "ids in code do not count");
    }

    #[test]
    fn whole_pages_drop_the_frontmatter() {
        assert!(extract(DOC, None).unwrap().starts_with("# Projekt\nIntro"));
        assert_eq!(extract("Nur Text\n", Some("")).unwrap(), "Nur Text");
        assert_eq!(extract(DOC, Some("^risk-1")).unwrap(), "Zu langsam.\nZweite Zeile");
    }

    #[test]
    fn resolves_by_title_and_reports_what_is_missing() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Übersicht", None).unwrap();
        db.save_page(p.id, "# Übersicht\n## Stand\nGut. ^s1\n").unwrap();
        let v = db.page_embed("übersicht", Some("Stand")).unwrap();
        assert_eq!((v.page_id, v.content.as_deref(), v.missing), (Some(p.id), Some("## Stand\nGut."), None));
        assert_eq!(db.page_embed("Übersicht", Some("^s1")).unwrap().content.as_deref(), Some("Gut."));
        assert_eq!(db.page_embed("Übersicht", Some("Fehlt")).unwrap().missing, Some("section"));
        let none = db.page_embed("Gibt es nicht", None).unwrap();
        assert_eq!((none.page_id, none.missing, none.title.as_str()), (None, Some("page"), "Gibt es nicht"));
    }

    #[test]
    fn embeds_count_as_backlinks() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Quelle", None).unwrap();
        let b = db.create_page(None, "Ziel", None).unwrap();
        db.save_page(b.id, "Text\n").unwrap();
        db.save_page(a.id, "![[Ziel#Abschnitt]]\n\n![[Ziel#^b1]]\n").unwrap();
        assert_eq!(crate::notes::wiki_links("![[Ziel#Abschnitt]] ![[Ziel#^b1|x]]"), ["Ziel"]);
        let doc = db.page_doc(b.id).unwrap();
        assert_eq!(doc.backlinks.iter().map(|l| l.page_id).collect::<Vec<_>>(), [a.id]);
    }
}
