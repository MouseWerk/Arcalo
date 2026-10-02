//! Unlinked mentions: text that names another page (its title or one of its `aliases:`)
//! without a `[[link]]`, and the rewrite that turns such a mention into one.
//!
//! What can become a link is prose only: frontmatter, fenced and inline code, existing wiki
//! and Markdown links, URLs, HTML, tags and e-mail addresses are masked first ([`mask`]); the
//! masked text keeps every byte offset of the original, so a match maps back 1:1. Matching is
//! case-insensitive at word boundaries, for terms of at least three characters that are not
//! common words; at one place the longest term wins. A German inflection (`Projekts` for
//! „Projekt“) counts too and links as `[[Projekt|Projekts]]`.
//!
//! Both directions stay cheap on large workspaces: the mentions in the open page are one pass
//! over its text with a first-word index of all titles; the pages that mention the open page
//! come from the full-text index (`notes_blocks_fts`), and only those are read.

use std::collections::{HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::tr;

/// Shortest term (in characters) that is suggested as a link.
pub const MIN_TERM_CHARS: usize = 3;
/// Characters of context on each side of a mention.
const CONTEXT_CHARS: usize = 60;
/// Pages read for the mentions of the open page in other pages.
const MAX_SOURCES: usize = 300;

/// Words too common to suggest a page for, should a page be titled like one (German, English).
const STOPWORDS: &[&str] = &[
    "aber",
    "alle",
    "allem",
    "also",
    "andere",
    "auch",
    "auf",
    "aus",
    "bei",
    "beim",
    "bin",
    "bis",
    "bitte",
    "da",
    "dann",
    "das",
    "dass",
    "dein",
    "dem",
    "den",
    "denn",
    "der",
    "des",
    "die",
    "dies",
    "diese",
    "dieser",
    "dieses",
    "doch",
    "dort",
    "durch",
    "eine",
    "einem",
    "einen",
    "einer",
    "eines",
    "etwa",
    "für",
    "gegen",
    "geht",
    "gibt",
    "habe",
    "haben",
    "hat",
    "hier",
    "ich",
    "ihr",
    "ihre",
    "immer",
    "ist",
    "jetzt",
    "kann",
    "kein",
    "keine",
    "man",
    "mehr",
    "mein",
    "mit",
    "muss",
    "nach",
    "neu",
    "neue",
    "nicht",
    "noch",
    "nur",
    "oder",
    "ohne",
    "sehr",
    "sich",
    "sie",
    "sind",
    "schon",
    "soll",
    "über",
    "und",
    "uns",
    "unter",
    "vom",
    "von",
    "vor",
    "war",
    "was",
    "weil",
    "wenn",
    "wer",
    "wie",
    "wir",
    "wird",
    "zum",
    "zur",
    "zwei",
    "drei",
    "heute",
    "morgen",
    "gestern",
    "woche",
    "notiz",
    "notizen",
    "seite",
    "aufgabe",
    "aufgaben",
    "todo",
    "and",
    "are",
    "but",
    "can",
    "for",
    "from",
    "has",
    "have",
    "her",
    "his",
    "how",
    "into",
    "its",
    "not",
    "now",
    "one",
    "our",
    "out",
    "she",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "two",
    "use",
    "was",
    "way",
    "were",
    "what",
    "when",
    "which",
    "who",
    "will",
    "with",
    "you",
    "your",
    "all",
    "any",
    "new",
    "note",
    "notes",
    "page",
    "task",
    "tasks",
    "today",
    "inbox",
    "journal",
    "meeting",
    "meetings",
    "tomorrow",
    "yesterday",
    "week",
    "test",
    "tests",
];

/// Endings of German inflections a mention may add to a term of four or more letters.
const SUFFIXES: &[&str] = &["ern", "ens", "en", "er", "es", "ns", "e", "n", "s"];

/// Whether `term` (lower case) is too short or too common to be suggested.
pub fn is_common(term: &str) -> bool {
    let t = term.trim();
    t.chars().count() < MIN_TERM_CHARS || !t.chars().any(char::is_alphabetic) || STOPWORDS.contains(&t)
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

// ------------------------------------------------------------------ masking

/// `md` with everything that must not become a link replaced by spaces (newlines stay), byte
/// for byte: frontmatter, fenced code, inline code, `[[links]]` and embeds, Markdown links and
/// images, footnotes and callout markers, HTML and autolinks, URLs, `#tags` and e-mail addresses.
pub fn mask(md: &str) -> String {
    let mut out = md.as_bytes().to_vec();
    let blank = |out: &mut Vec<u8>, from: usize, to: usize| {
        for b in &mut out[from..to] {
            if *b != b'\n' && *b != b'\r' {
                *b = b' ';
            }
        }
    };
    let body_start = md.len() - crate::embeds::without_frontmatter(md).len();
    blank(&mut out, 0, body_start);
    let mut at = body_start;
    let mut fence: Option<&str> = None;
    for line in md[body_start..].split_inclusive('\n') {
        let start = at;
        at += line.len();
        let trimmed = line.trim_start();
        let marker = if trimmed.starts_with("```") {
            Some("```")
        } else if trimmed.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        };
        if let Some(f) = fence {
            blank(&mut out, start, at);
            if marker == Some(f) {
                fence = None;
            }
            continue;
        }
        if let Some(m) = marker {
            fence = Some(m);
            blank(&mut out, start, at);
            continue;
        }
        mask_line(line, start, &mut out);
    }
    // Only spaces were written over whole characters: still valid UTF-8.
    String::from_utf8(out).unwrap_or_default()
}

fn mask_line(line: &str, offset: usize, out: &mut [u8]) {
    let bytes = line.as_bytes();
    let blank = |out: &mut [u8], from: usize, to: usize| {
        for b in &mut out[offset + from..offset + to] {
            if *b != b'\n' && *b != b'\r' {
                *b = b' ';
            }
        }
    };
    let end_of_token = |from: usize| line[from..].find(char::is_whitespace).map_or(line.len(), |e| from + e);
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        let prev_word = i > 0 && line[..i].chars().next_back().is_some_and(is_word);
        match c {
            b'\\' => {
                let n = line[i + 1..].chars().next().map_or(0, char::len_utf8);
                blank(out, i, i + 1 + n);
                i += 1 + n;
            }
            b'`' => {
                let run = bytes[i..].iter().take_while(|b| **b == b'`').count();
                let fence = &line[i..i + run];
                let close = line[i + run..].find(fence).map(|e| i + run + e + run);
                let to = close.unwrap_or(i + run);
                blank(out, i, to);
                i = to;
            }
            b'!' | b'[' if line[i..].starts_with("[[") || line[i..].starts_with("![[") => {
                let open = if c == b'!' { i + 3 } else { i + 2 };
                let to = line[open..].find("]]").map_or(line.len(), |e| open + e + 2);
                blank(out, i, to);
                i = to;
            }
            b'!' if line[i..].starts_with("![") => {
                let to = bracket_link_end(line, i + 1).unwrap_or(i + 1);
                blank(out, i, to);
                i = to;
            }
            b'[' => {
                if let Some(to) = bracket_link_end(line, i) {
                    blank(out, i, to);
                    i = to;
                } else if line[i..].starts_with("[!") || line[i..].starts_with("[^") {
                    let to = line[i..].find(']').map_or(i + 1, |e| i + e + 1);
                    blank(out, i, to);
                    i = to;
                } else {
                    i += 1;
                }
            }
            b'<' => {
                let next = line[i + 1..].chars().next();
                let close = line[i..].find('>');
                match (next, close) {
                    (Some(n), Some(e)) if n.is_ascii_alphabetic() || n == '/' || n == '!' => {
                        blank(out, i, i + e + 1);
                        i += e + 1;
                    }
                    _ => i += 1,
                }
            }
            b'#' if !prev_word && line[i + 1..].chars().next().is_some_and(|n| n.is_alphanumeric() || n == '_') => {
                let len = line[i + 1..]
                    .find(|ch: char| !(ch.is_alphanumeric() || "_-/".contains(ch)))
                    .unwrap_or(line.len() - i - 1);
                blank(out, i, i + 1 + len);
                i += 1 + len;
            }
            b'@' => {
                let from = line[..i].rfind(char::is_whitespace).map_or(0, |s| s + 1);
                let to = end_of_token(i);
                blank(out, from, to);
                i = to;
            }
            _ if !prev_word && (c.is_ascii_alphabetic()) && starts_url(&line[i..]) => {
                let to = end_of_token(i);
                blank(out, i, to);
                i = to;
            }
            _ => i += line[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
}

/// End (exclusive) of a Markdown link `[text](url)` or reference `[text][ref]` starting at `[`.
fn bracket_link_end(line: &str, open: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut close = None;
    for (k, ch) in line[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    close = Some(open + k);
                    break;
                }
            }
            _ => {}
        }
    }
    let close = close?;
    let rest = &line[close + 1..];
    if rest.starts_with('(') {
        rest.find(')').map(|e| close + 1 + e + 1)
    } else if rest.starts_with('[') {
        rest.find(']').map(|e| close + 1 + e + 1)
    } else {
        None
    }
}

/// Whether `s` starts with a URL (`scheme://`, `www.`, `mailto:`).
fn starts_url(s: &str) -> bool {
    let lower = s.get(..s.len().min(16)).unwrap_or(s).to_ascii_lowercase();
    if lower.starts_with("www.") || lower.starts_with("mailto:") {
        return true;
    }
    let scheme = s.find(|c: char| !(c.is_ascii_alphanumeric() || "+.-".contains(c))).unwrap_or(s.len());
    scheme > 0 && s[scheme..].starts_with("://")
}

// ------------------------------------------------------------------ matching

/// A term a page can be found by: its title or an alias.
#[derive(Debug, Clone)]
struct Term {
    page_id: i64,
    title: String,
    /// Lower case, whitespace runs as one space.
    lower: String,
    chars: usize,
}

/// All terms by their first word (lower case), longest first.
#[derive(Debug, Default)]
pub struct TitleIndex {
    terms: Vec<Term>,
    by_first: HashMap<String, Vec<usize>>,
}

fn normalize_term(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

impl TitleIndex {
    /// Adds `term` for the page `title` unless it is too short or too common. A title that a
    /// `[[link]]` cannot hold (`[`, `]`, `|`, `#`, `^`: a page from before titles were cleaned)
    /// is left out: its link would point elsewhere.
    pub fn add(&mut self, page_id: i64, title: &str, term: &str) {
        let lower = normalize_term(term);
        if is_common(&lower) || title.contains(['[', ']', '|', '#', '^']) {
            return;
        }
        let first: String = lower.chars().take_while(|c| is_word(*c)).collect();
        if first.is_empty() {
            return;
        }
        let chars = lower.chars().count();
        self.terms.push(Term { page_id, title: title.to_owned(), lower, chars });
        self.by_first.entry(first).or_default().push(self.terms.len() - 1);
    }

    fn finish(mut self) -> Self {
        let terms = &self.terms;
        for list in self.by_first.values_mut() {
            list.sort_by(|a, b| terms[*b].chars.cmp(&terms[*a].chars).then(terms[*a].page_id.cmp(&terms[*b].page_id)));
        }
        self
    }

    pub fn is_empty(&self) -> bool {
        self.terms.is_empty()
    }
}

/// Builds an index from `(page id, title, aliases)`.
pub fn title_index<'a>(pages: impl IntoIterator<Item = (i64, &'a str, Vec<String>)>) -> TitleIndex {
    let mut index = TitleIndex::default();
    for (id, title, aliases) in pages {
        index.add(id, title, title);
        for a in aliases {
            index.add(id, title, &a);
        }
    }
    index.finish()
}

/// An unlinked mention: `text` at `start..end` (bytes) names the page `title`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mention {
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub page_id: i64,
    pub title: String,
    /// Text of the same line before and after the mention (shortened).
    pub before: String,
    pub after: String,
}

/// Where `term` matches `text` at byte `i` (case-insensitive, whitespace runs as one space):
/// the end of the match.
fn match_at(text: &str, i: usize, term: &str) -> Option<usize> {
    let mut want = term.chars().peekable();
    let mut src = text[i..].char_indices().peekable();
    while let Some(&w) = want.peek() {
        let (k, c) = src.next()?;
        if w == ' ' {
            if c != ' ' && c != '\t' {
                return None;
            }
            while src.peek().is_some_and(|(_, c)| *c == ' ' || *c == '\t') {
                src.next();
            }
            want.next();
            continue;
        }
        for lc in c.to_lowercase() {
            if want.next() != Some(lc) {
                return None;
            }
        }
        if want.peek().is_none() {
            return Some(i + k + c.len_utf8());
        }
    }
    None
}

/// The end of a mention whose term ends at `end`: right there at a word boundary, or after a
/// German ending (terms of four or more letters ending in a letter).
fn boundary_end(text: &str, end: usize, term: &Term) -> Option<usize> {
    let next = text[end..].chars().next();
    if !next.is_some_and(is_word) {
        return Some(end);
    }
    if term.chars < 4 || !term.lower.chars().last().is_some_and(char::is_alphabetic) {
        return None;
    }
    let rest = &text[end..];
    SUFFIXES.iter().find_map(|s| {
        let tail = rest.get(..s.len())?;
        (tail.eq_ignore_ascii_case(s) && !rest[s.len()..].chars().next().is_some_and(is_word)).then(|| end + s.len())
    })
}

fn context(original: &str, start: usize, end: usize) -> (String, String) {
    let line_start = original[..start].rfind('\n').map_or(0, |p| p + 1);
    let line_end = original[end..].find('\n').map_or(original.len(), |p| end + p);
    let before: Vec<char> = original[line_start..start].chars().collect();
    let after: Vec<char> = original[end..line_end].chars().collect();
    let mut b: String = before[before.len().saturating_sub(CONTEXT_CHARS)..].iter().collect();
    let mut a: String = after[..after.len().min(CONTEXT_CHARS)].iter().collect();
    if before.len() > CONTEXT_CHARS {
        b = format!("…{}", b.trim_start());
    } else {
        b = b.trim_start().trim_start_matches(['#', '>', '-', '*']).trim_start().to_owned();
    }
    if after.len() > CONTEXT_CHARS {
        a = format!("{}…", a.trim_end());
    }
    (b, a.trim_end().to_owned())
}

/// The unlinked mentions in `original` of the terms in `index`, in text order, skipping terms
/// of `skip_page` (the page itself). At one place the longest term wins; matches never overlap.
pub fn find_mentions(original: &str, index: &TitleIndex, skip_page: Option<i64>) -> Vec<Mention> {
    let mut out = vec![];
    if index.is_empty() {
        return out;
    }
    let masked = mask(original);
    let text = masked.as_str();
    let mut i = 0;
    let mut prev: Option<char> = None;
    while i < text.len() {
        let c = text[i..].chars().next().unwrap_or(' ');
        let starts_word = is_word(c) && !prev.is_some_and(is_word);
        if starts_word {
            let first: String = text[i..].chars().take_while(|c| is_word(*c)).flat_map(char::to_lowercase).collect();
            // The first word as written, or without a German ending (`Projekts` → „Projekt“).
            let mut keys = vec![first.as_str()];
            keys.extend(SUFFIXES.iter().filter_map(|s| first.strip_suffix(s)).filter(|k| k.chars().count() >= 4));
            let mut cands: Vec<usize> = keys.iter().filter_map(|k| index.by_first.get(*k)).flatten().copied().collect();
            if !cands.is_empty() {
                let terms = &index.terms;
                cands.sort_by(|a, b| {
                    terms[*b].chars.cmp(&terms[*a].chars).then(terms[*a].page_id.cmp(&terms[*b].page_id))
                });
                let found = cands.iter().map(|k| &terms[*k]).filter(|t| Some(t.page_id) != skip_page).find_map(|t| {
                    let end = match_at(text, i, &t.lower)?;
                    let end = boundary_end(text, end, t)?;
                    // A masked part inside the match (code between two words) is no mention.
                    (original.get(i..end) == text.get(i..end)).then_some((t, end))
                });
                if let Some((t, end)) = found {
                    let (before, after) = context(original, i, end);
                    out.push(Mention {
                        start: i,
                        end,
                        text: original[i..end].to_owned(),
                        page_id: t.page_id,
                        title: t.title.clone(),
                        before,
                        after,
                    });
                    prev = text[..end].chars().next_back();
                    i = end;
                    continue;
                }
            }
        }
        prev = Some(c);
        i += c.len_utf8();
    }
    out
}

/// The link that replaces a mention: `[[Title]]` when the text is the title as written,
/// `[[Title|text]]` otherwise (other case, inflection or alias); `\|` in a table row.
pub fn link_markup(title: &str, text: &str, in_table: bool) -> String {
    if text == title {
        format!("[[{title}]]")
    } else {
        let pipe = if in_table { "\\|" } else { "|" };
        // `]` or `|` in the shown text would end the link early.
        let shown = text.replace(['[', ']', '|'], " ");
        format!("[[{title}{pipe}{}]]", shown.split_whitespace().collect::<Vec<_>>().join(" "))
    }
}

/// `original` with each of `mentions` replaced by its link. Mentions that no longer match
/// the text (it changed since) are left alone.
pub fn apply_links(original: &str, mentions: &[Mention]) -> (String, usize) {
    let mut sorted: Vec<&Mention> = mentions.iter().collect();
    sorted.sort_by(|a, b| b.start.cmp(&a.start));
    let mut out = original.to_owned();
    let mut last_start = usize::MAX;
    let mut n = 0;
    for m in sorted {
        if m.end > last_start || original.get(m.start..m.end) != Some(m.text.as_str()) {
            continue;
        }
        let line_start = original[..m.start].rfind('\n').map_or(0, |p| p + 1);
        let in_table = original[line_start..].trim_start().starts_with('|');
        out.replace_range(m.start..m.end, &link_markup(&m.title, &m.text, in_table));
        last_start = m.start;
        n += 1;
    }
    (out, n)
}

/// The `aliases:` (or `alias:`) of a page's frontmatter.
pub fn aliases(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for e in crate::properties::page_entries(markdown) {
        if !matches!(e.key.to_lowercase().as_str(), "aliases" | "alias") {
            continue;
        }
        let values = match e.value {
            Some(crate::properties::Yaml::Str(s)) => s.split(',').map(str::to_owned).collect(),
            Some(crate::properties::Yaml::List(l)) => l.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect(),
            _ => vec![],
        };
        for v in values {
            let v = v.trim().trim_matches(['"', '\'']).trim().to_owned();
            if !v.is_empty() && !out.iter().any(|o| o.eq_ignore_ascii_case(&v)) {
                out.push(v);
            }
        }
    }
    out
}

// ------------------------------------------------------------------ database

/// Unlinked mentions grouped by page: the page they name (in the open page) or the page they
/// are in (mentions of the open page elsewhere).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MentionGroup {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    pub mentions: Vec<Mention>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MentionReport {
    /// Other pages named in the open page without a link, by the page named.
    pub outgoing: Vec<MentionGroup>,
    /// Other pages that name the open page without linking it, by the page they are in.
    pub incoming: Vec<MentionGroup>,
}

/// FTS5 phrase query of a term (`"w1 w2"*`: the last word as a prefix for inflections).
fn fts_phrase(term: &str) -> Option<String> {
    let words: Vec<String> =
        term.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase).collect();
    (!words.is_empty()).then(|| format!("\"{}\"*", words.join(" ")))
}

impl Database {
    /// Keeps `page_aliases` in step with a page's frontmatter (from [`Database::reindex_page`]).
    pub(crate) fn reindex_aliases(&self, id: i64, content: &str) -> Result<()> {
        let wanted: Vec<String> = aliases(content).iter().map(|a| normalize_term(a)).collect();
        crate::notes::sync_rows(
            self,
            id,
            &wanted,
            "SELECT alias FROM page_aliases WHERE page_id = ?1",
            "DELETE FROM page_aliases WHERE page_id = ?1 AND alias = ?2",
            "INSERT OR IGNORE INTO page_aliases (page_id, alias) VALUES (?1, ?2)",
        )
    }

    /// Titles and aliases of the pages outside the trash (all of them, or one page's).
    fn mention_index(&self, only: Option<i64>) -> Result<TitleIndex> {
        let conn = self.conn();
        let mut aliases: HashMap<i64, Vec<String>> = HashMap::new();
        {
            let mut st =
                conn.prepare_cached("SELECT page_id, alias FROM page_aliases WHERE ?1 IS NULL OR page_id = ?1")?;
            for row in st.query_map([only], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (id, a) = row?;
                aliases.entry(id).or_default().push(a);
            }
        }
        let mut st = conn.prepare_cached(
            "SELECT id, title FROM pages WHERE deleted_at IS NULL AND (?1 IS NULL OR id = ?1) AND daily_date IS NULL",
        )?;
        let pages: Vec<(i64, String)> =
            st.query_map([only], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(title_index(pages.iter().map(|(id, t)| (*id, t.as_str(), aliases.remove(id).unwrap_or_default()))))
    }

    fn mention_ignores(&self, page_id: i64) -> Result<HashSet<String>> {
        let mut st = self.conn().prepare_cached("SELECT term FROM mention_ignores WHERE page_id = ?1")?;
        Ok(st.query_map([page_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    fn content_of(&self, id: i64) -> Result<String> {
        Ok(self.conn().query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?)
    }

    /// The unlinked mentions of the open page in both directions. Terms a page already links
    /// (once linked, the rest of the page needs no link) and ignored terms are left out.
    pub fn unlinked_mentions(&self, page_id: i64) -> Result<MentionReport> {
        let page = self.page(page_id)?;
        if self.is_canvas(page_id)? {
            return Ok(MentionReport::default());
        }
        let content = self.content_of(page_id)?;
        let linked: HashSet<String> = crate::notes::wiki_links(&content).iter().map(|l| l.to_lowercase()).collect();
        let ignored = self.mention_ignores(page_id)?;
        let index = self.mention_index(None)?;
        let mut groups: Vec<MentionGroup> = vec![];
        for m in find_mentions(&content, &index, Some(page_id)) {
            let title = m.title.to_lowercase();
            let term = normalize_term(&m.text);
            if linked.contains(&title) || ignored.contains(&title) || ignored.contains(&term) {
                continue;
            }
            match groups.iter_mut().find(|g| g.page_id == m.page_id) {
                Some(g) => g.mentions.push(m),
                None => groups.push(MentionGroup {
                    page_id: m.page_id,
                    title: m.title.clone(),
                    icon: None,
                    mentions: vec![m],
                }),
            }
        }
        for g in &mut groups {
            g.icon = self.page(g.page_id)?.icon;
        }
        let incoming = self.incoming_mentions(page_id, &page.title)?;
        Ok(MentionReport { outgoing: groups, incoming })
    }

    /// Pages that name `title` (or an alias of the page) without linking it, found by the
    /// full-text index and then matched exactly.
    fn incoming_mentions(&self, page_id: i64, title: &str) -> Result<Vec<MentionGroup>> {
        let index = self.mention_index(Some(page_id))?;
        if index.is_empty() {
            return Ok(vec![]);
        }
        let terms: Vec<String> = index.terms.iter().map(|t| t.lower.clone()).collect();
        let query = terms.iter().filter_map(|t| fts_phrase(t)).collect::<Vec<_>>().join(" OR ");
        if query.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn();
        let sources: Vec<(i64, String, Option<String>)> = {
            let mut st = conn.prepare_cached(
                "SELECT DISTINCT p.id, p.title, p.icon FROM notes_blocks_fts f
                 JOIN notes_blocks b ON b.id = f.rowid JOIN pages p ON p.id = b.page_id
                 WHERE notes_blocks_fts MATCH ?1 AND p.id <> ?2 AND p.deleted_at IS NULL AND p.kind IS NULL
                 ORDER BY p.updated_at DESC LIMIT ?3",
            )?;
            st.query_map(params![query, page_id, MAX_SOURCES as i64], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .collect::<rusqlite::Result<_>>()?
        };
        let lower_title = title.to_lowercase();
        let mut linking = conn.prepare_cached("SELECT target FROM page_links WHERE from_page = ?1")?;
        let mut out = vec![];
        for (id, src_title, icon) in sources {
            let links: HashSet<String> = linking.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
            if links.contains(&lower_title) || terms.iter().any(|t| links.contains(t)) {
                continue;
            }
            let ignored = self.mention_ignores(id)?;
            if ignored.contains(&lower_title) {
                continue;
            }
            let mentions: Vec<Mention> = find_mentions(&self.content_of(id)?, &index, None)
                .into_iter()
                .filter(|m| !ignored.contains(&normalize_term(&m.text)))
                .collect();
            if !mentions.is_empty() {
                out.push(MentionGroup { page_id: id, title: src_title, icon, mentions });
            }
        }
        Ok(out)
    }

    /// Turns the mentions of page `target` in page `source` into links: the one at byte
    /// `start`, or all of them. Returns how many were linked; the page is saved like an edit.
    pub fn link_mentions(&self, source: i64, target: i64, start: Option<usize>) -> Result<usize> {
        if self.is_canvas(source)? {
            return Err(Error::State(tr!("Eine Canvas wird nicht verlinkt", "A canvas is not linked this way").into()));
        }
        let content = self.content_of(source)?;
        let index = self.mention_index(Some(target))?;
        let mentions: Vec<Mention> =
            find_mentions(&content, &index, None).into_iter().filter(|m| start.is_none_or(|s| m.start == s)).collect();
        if mentions.is_empty() {
            return Err(Error::State(
                tr!("Die Erwähnung steht nicht mehr im Text", "The mention is no longer in the text").into(),
            ));
        }
        let (updated, n) = apply_links(&content, &mentions);
        if n > 0 {
            self.save_page_content(source, &updated)?;
        }
        Ok(n)
    }

    /// „Ignorieren“: `term` is no longer suggested as a link on page `page_id`.
    pub fn ignore_mention(&self, page_id: i64, term: &str) -> Result<()> {
        let term = normalize_term(term);
        if term.is_empty() {
            return Ok(());
        }
        self.conn()
            .execute("INSERT OR IGNORE INTO mention_ignores (page_id, term) VALUES (?1, ?2)", params![page_id, term])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn idx(pages: &[(i64, &str)]) -> TitleIndex {
        title_index(pages.iter().map(|(id, t)| (*id, *t, vec![])))
    }

    fn texts(md: &str, index: &TitleIndex) -> Vec<String> {
        find_mentions(md, index, None).into_iter().map(|m| m.text).collect()
    }

    #[test]
    fn matches_at_word_boundaries_case_insensitively() {
        let index = idx(&[(1, "Arcalo"), (2, "Rust")]);
        assert_eq!(texts("Wir bauen arcalo in Rust, nicht Rusty oder Trust.", &index), ["arcalo", "Rust"]);
        assert!(texts("ArcaloX und xArcalo", &index).is_empty());
    }

    #[test]
    fn prefers_the_longest_title() {
        let index = idx(&[(1, "Projekt"), (2, "Projekt Alpha"), (3, "Alpha")]);
        let found = find_mentions("Status von Projekt Alpha und Projekt  Beta.", &index, None);
        let got: Vec<(&str, i64)> = found.iter().map(|m| (m.text.as_str(), m.page_id)).collect();
        assert_eq!(got, [("Projekt Alpha", 2), ("Projekt", 1)]);
    }

    #[test]
    fn skips_code_links_urls_tags_and_frontmatter() {
        let index = idx(&[(1, "Server")]);
        let md = "---\ntitle: Server\n---\n`Server` [[Server]] [Server](https://x.de) https://server.de/Server #Server\n```\nServer\n```\nmail@server.de <a title=\"Server\">";
        assert!(texts(md, &index).is_empty(), "{:?}", texts(md, &index));
        assert_eq!(texts("Der Server läuft.", &index), ["Server"]);
    }

    #[test]
    fn ignores_short_and_common_titles_and_matches_inflections() {
        let index = idx(&[(1, "KI"), (2, "Und"), (3, "Projekt")]);
        assert_eq!(texts("KI und des Projekts Ziel, Projekte, Projektion", &index), ["Projekts", "Projekte"]);
    }

    #[test]
    fn rewrites_mentions_without_breaking_markdown() {
        let index = idx(&[(1, "Projekt Alpha"), (2, "Server")]);
        let md = "Das projekt alpha nutzt den Server.\n\n| A | B |\n|---|---|\n| Servers | x |\n\n`Server`";
        let found = find_mentions(md, &index, None);
        let (out, n) = apply_links(md, &found);
        assert_eq!(n, 3);
        assert_eq!(
            out,
            "Das [[Projekt Alpha|projekt alpha]] nutzt den [[Server]].\n\n| A | B |\n|---|---|\n| [[Server\\|Servers]] | x |\n\n`Server`"
        );
        // Stale mentions (the text changed) are left alone.
        let (same, n) = apply_links("ganz anderer Text", &found);
        assert_eq!((same.as_str(), n), ("ganz anderer Text", 0));
    }

    #[test]
    fn titles_a_link_cannot_hold_are_not_suggested() {
        let index = idx(&[(1, "C# Grundlagen"), (2, "Plan [alt]"), (3, "Projekt")]);
        assert_eq!(texts("C# Grundlagen und Plan [alt] im Projekt", &index), ["Projekt"]);
    }

    #[test]
    fn reads_aliases_from_frontmatter() {
        assert_eq!(aliases("---\naliases: [AC, Arcalo App]\n---\nx"), ["AC", "Arcalo App"]);
        assert_eq!(aliases("---\naliases:\n  - Eins\n  - Zwei\n---\n"), ["Eins", "Zwei"]);
        assert!(aliases("kein frontmatter").is_empty());
    }

    #[test]
    fn database_reports_and_links_both_directions() {
        let db = Database::open_in_memory().unwrap();
        let alpha = db.create_page(None, "Projekt Alpha", None).unwrap();
        let other = db.create_page(None, "Kundenserver", None).unwrap();
        let src = db.create_page(None, "Besprechung", None).unwrap();
        db.save_page_content(alpha.id, "---\naliases: [PA]\n---\nAlpha läuft auf dem Kundenserver.").unwrap();
        db.save_page_content(src.id, "Zu Projekt Alpha: der Kundenserver. Später mehr zu projekt alpha.").unwrap();
        db.save_page_content(other.id, "Nur [[Projekt Alpha]] verlinkt.").unwrap();

        let r = db.unlinked_mentions(alpha.id).unwrap();
        assert_eq!(r.outgoing.len(), 1);
        assert_eq!(r.outgoing[0].page_id, other.id);
        assert_eq!(r.incoming.len(), 1, "the page that links already is no candidate");
        assert_eq!(r.incoming[0].page_id, src.id);
        assert_eq!(r.incoming[0].mentions.len(), 2);

        // Link one, then the rest of the page needs none.
        let first = r.incoming[0].mentions[0].start;
        assert_eq!(db.link_mentions(src.id, alpha.id, Some(first)).unwrap(), 1);
        assert!(db.content_of(src.id).unwrap().starts_with("Zu [[Projekt Alpha]]: "));
        assert!(db.unlinked_mentions(alpha.id).unwrap().incoming.is_empty());
        // All of them.
        assert_eq!(db.link_mentions(src.id, alpha.id, None).unwrap(), 1);
        assert!(db.content_of(src.id).unwrap().ends_with("[[Projekt Alpha|projekt alpha]]."));

        // Ignored terms are not suggested again.
        db.ignore_mention(alpha.id, "Kundenserver").unwrap();
        assert!(db.unlinked_mentions(alpha.id).unwrap().outgoing.is_empty());
    }

    #[test]
    fn aliases_find_mentions_elsewhere() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Arcalo Desktop", None).unwrap();
        let s = db.create_page(None, "Log", None).unwrap();
        db.save_page_content(p.id, "---\naliases: [ArcDesk]\n---\n").unwrap();
        db.save_page_content(s.id, "Heute ArcDesk gebaut.").unwrap();
        let r = db.unlinked_mentions(p.id).unwrap();
        assert_eq!(r.incoming[0].mentions[0].text, "ArcDesk");
        db.link_mentions(s.id, p.id, None).unwrap();
        assert_eq!(db.content_of(s.id).unwrap(), "Heute [[Arcalo Desktop|ArcDesk]] gebaut.");
    }

    #[test]
    fn mention_scan_is_fast_on_5k_pages() {
        let db = Database::open_in_memory().unwrap();
        let words = ["Server", "Planung", "Kunde", "Budget", "Release", "Analyse", "Konzept", "Termin"];
        db.atomic(|| {
            let conn = db.conn();
            for i in 0..5000 {
                let title = |j: usize| format!("{} {}", words[j % words.len()], j);
                let body = format!(
                    "Notiz {i} zu {} und {}. Weitere Gedanken zum Thema {}.",
                    title((i + 7) % 5000),
                    title((i * 7) % 5000),
                    words[(i + 3) % 8]
                );
                let title = title(i);
                conn.execute("INSERT INTO pages (title, position, content) VALUES (?1, ?2, ?3)", params![title, i as i64, body])?;
                let id = conn.last_insert_rowid();
                conn.execute(
                    "INSERT INTO notes_blocks (page_id, position, block_type, content_markdown) VALUES (?1, 0, 'chunk', ?2)",
                    params![id, body],
                )?;
            }
            Ok(())
        })
        .unwrap();
        let id: i64 = db.conn().query_row("SELECT id FROM pages WHERE title = 'Kunde 2'", [], |r| r.get(0)).unwrap();
        let mut best = std::time::Duration::MAX;
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let r = db.unlinked_mentions(id).unwrap();
            best = best.min(t.elapsed());
            assert!(!r.outgoing.is_empty() && !r.incoming.is_empty());
        }
        // The budget guards against a scan of every page (seconds, not milliseconds); shared CI
        // runners run the tests in parallel and get a wider margin.
        let budget = if std::env::var_os("CI").is_some() { 250 } else { 50 };
        assert!(best.as_millis() < budget, "mention scan took {best:?} (budget {budget} ms)");
    }
}
