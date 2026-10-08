//! Tag suggestions for a page.
//!
//! Local (no AI): the tags of similar pages. Similar are the pages linked from or to this
//! one, pages that link the same pages, and pages that share its distinctive words (found
//! through the full-text index, ranked by BM25). Each tag scores the summed similarity of the
//! pages that carry it, weighted by its inverse document frequency, so a tag every page has
//! says little; tags the page has or that were dismissed on it are left out.
//!
//! With AI („Tags mit KI vorschlagen“, the shell): the title, the first characters of the text
//! and the tag vocabulary go to the model; the answer is read by [`parse_ai_tags`], which keeps
//! tags of the vocabulary and at most two new ones.

use std::collections::{HashMap, HashSet};

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::ai::client::ChatMessage;
use crate::db::Database;
use crate::error::Result;
use crate::{tr, trf};

/// Suggestions shown under the page properties.
pub const MAX_SUGGESTIONS: usize = 5;
/// Characters of the text sent to the model.
pub const AI_TEXT_CHARS: usize = 800;
/// Tags of the vocabulary sent to the model (the most used ones).
pub const AI_VOCABULARY: usize = 200;
/// New tags (not in the vocabulary) the model may propose.
pub const AI_MAX_NEW: usize = 2;
/// Distinctive words of a page used to find pages with similar text.
const QUERY_WORDS: usize = 10;
/// Pages with similar text that count.
const SIMILAR_PAGES: i64 = 40;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TagSuggestion {
    pub tag: String,
    /// Relative score (the best suggestion is 1.0).
    pub score: f64,
    /// Similar pages that carry the tag.
    pub pages: usize,
    /// Proposed by the model and not used anywhere yet.
    #[serde(default)]
    pub new: bool,
}

/// A tag as Arcalo stores it: lower case, `#` and quotes removed, letters, digits, `_-/` only.
pub fn clean_tag(raw: &str) -> Option<String> {
    let t = raw.trim().trim_matches(['"', '\'', '`', ',', '.']).trim_start_matches('#').trim().to_lowercase();
    let t: String = t.split_whitespace().collect::<Vec<_>>().join("-");
    (!t.is_empty() && t.chars().any(char::is_alphabetic) && t.chars().all(|c| c.is_alphanumeric() || "_-/".contains(c)))
        .then_some(t)
}

/// Words that say something about a page: four or more letters, no common words, most
/// frequent first (longer words first among equals).
fn distinctive_words(markdown: &str) -> Vec<String> {
    let masked = crate::mentions::mask(markdown);
    let mut counts: HashMap<String, usize> = HashMap::new();
    for w in masked.split(|c: char| !c.is_alphanumeric()) {
        let w = w.to_lowercase();
        if w.chars().count() >= 4 && w.chars().all(char::is_alphabetic) && !crate::mentions::is_common(&w) {
            *counts.entry(w).or_default() += 1;
        }
    }
    let mut words: Vec<(String, usize)> = counts.into_iter().collect();
    words.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.chars().count().cmp(&a.0.chars().count())).then(a.0.cmp(&b.0)));
    words.into_iter().take(QUERY_WORDS).map(|(w, _)| w).collect()
}

/// Ranks tags by the pages that carry them: `neighbours` are (page id, similarity),
/// `tags_of` the tags per page, `df` the number of pages per tag out of `total`.
pub fn rank_tags(
    neighbours: &HashMap<i64, f64>,
    tags_of: &HashMap<i64, Vec<String>>,
    df: &HashMap<String, i64>,
    total: i64,
    exclude: &HashSet<String>,
) -> Vec<TagSuggestion> {
    // Summed score, number of pages and the strongest single page.
    let mut score: HashMap<&str, (f64, usize, f64)> = HashMap::new();
    for (id, w) in neighbours {
        for t in tags_of.get(id).into_iter().flatten() {
            if exclude.contains(t) {
                continue;
            }
            let idf = (1.0 + total.max(1) as f64 / *df.get(t).unwrap_or(&1).max(&1) as f64).ln();
            let e = score.entry(t.as_str()).or_default();
            e.0 += w * idf;
            e.1 += 1;
            e.2 = e.2.max(*w);
        }
    }
    let best = score.values().map(|v| v.0).fold(0.0f64, f64::max);
    let mut out: Vec<TagSuggestion> = score
        .into_iter()
        // One loosely similar page is no evidence: a tag needs two pages or a close one (a link).
        .filter(|(_, (s, n, top))| *s > 0.0 && (*n >= 2 || *top >= 0.9))
        .map(|(t, (s, n, _))| TagSuggestion { tag: t.to_owned(), score: s / best, pages: n, new: false })
        .collect();
    out.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.tag.cmp(&b.tag)));
    // Weak suggestions (a third of the best one) are noise.
    out.retain(|s| s.score >= 0.34);
    out.truncate(MAX_SUGGESTIONS);
    out
}

/// The prompt of the AI suggestions: title, the start of the text and the vocabulary.
pub fn ai_messages(title: &str, text: &str, vocabulary: &[String]) -> Vec<ChatMessage> {
    let body: String = crate::embeds::without_frontmatter(text).chars().take(AI_TEXT_CHARS).collect();
    let system = trf!(
        "Du schlägst Tags für eine Notiz vor. Antworte nur mit einer JSON-Liste von Tags (klein geschrieben, ohne #), höchstens 5. Nimm vorzugsweise Tags aus dem Vokabular; höchstens {AI_MAX_NEW} neue Tags, nur wenn keines passt.",
        "You suggest tags for a note. Answer only with a JSON list of tags (lower case, without #), at most 5. Prefer tags from the vocabulary; at most {AI_MAX_NEW} new tags, only when none fits.",
    );
    let user = format!(
        "{}: {title}\n\n{}:\n{body}\n\n{}: {}",
        tr!("Titel", "Title"),
        tr!("Text", "Text"),
        tr!("Vokabular", "Vocabulary"),
        vocabulary.join(", ")
    );
    vec![ChatMessage::system(system), ChatMessage::user(user)]
}

/// Reads the model's answer: tags of the vocabulary first, then at most [`AI_MAX_NEW`] new
/// ones (marked `new`); tags the page has are left out.
pub fn parse_ai_tags(answer: &str, vocabulary: &[String], have: &HashSet<String>) -> Vec<TagSuggestion> {
    let raw: Vec<String> = match answer.find('[').zip(answer.rfind(']')) {
        Some((a, b)) if a < b => serde_json::from_str::<Vec<String>>(&answer[a..=b])
            .unwrap_or_else(|_| answer[a + 1..b].split(',').map(str::to_owned).collect()),
        _ => answer.split([',', '\n']).map(str::to_owned).collect(),
    };
    let vocab: HashSet<&str> = vocabulary.iter().map(String::as_str).collect();
    let mut known = vec![];
    let mut fresh = vec![];
    let mut seen = HashSet::new();
    for t in raw.iter().filter_map(|r| clean_tag(r)) {
        if have.contains(&t) || !seen.insert(t.clone()) {
            continue;
        }
        if vocab.contains(t.as_str()) {
            known.push(TagSuggestion { tag: t, score: 1.0, pages: 0, new: false });
        } else if fresh.len() < AI_MAX_NEW {
            fresh.push(TagSuggestion { tag: t, score: 0.5, pages: 0, new: true });
        }
    }
    known.truncate(MAX_SUGGESTIONS);
    known.extend(fresh);
    known
}

impl Database {
    /// Tags dismissed on a page.
    fn dismissed_tags(&self, page_id: i64) -> Result<HashSet<String>> {
        let mut st = self.conn().prepare_cached("SELECT tag FROM tag_dismissals WHERE page_id = ?1")?;
        Ok(st.query_map([page_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Local tag suggestions for a page (see the module comment).
    pub fn tag_suggestions(&self, page_id: i64) -> Result<Vec<TagSuggestion>> {
        let page = self.page(page_id)?;
        let conn = self.conn();
        let content: String = conn.query_row("SELECT content FROM pages WHERE id = ?1", [page_id], |r| r.get(0))?;
        let mut exclude: HashSet<String> = self.page_tags(page_id)?.into_iter().collect();
        exclude.extend(self.dismissed_tags(page_id)?);

        let mut neighbours: HashMap<i64, f64> = HashMap::new();
        let mut add = |id: i64, w: f64| {
            if id != page_id {
                let e = neighbours.entry(id).or_default();
                *e = e.max(w);
            }
        };
        // Links in both directions, then pages that link the same pages.
        {
            let mut st = conn.prepare_cached(
                "SELECT p.id FROM page_links l JOIN pages p ON p.title = l.target COLLATE NOCASE
                 WHERE l.from_page = ?1 AND p.deleted_at IS NULL
                 UNION SELECT l.from_page FROM page_links l JOIN pages p ON p.id = l.from_page
                 WHERE l.target = ?2 AND p.deleted_at IS NULL",
            )?;
            for id in st.query_map(params![page_id, page.title.to_lowercase()], |r| r.get::<_, i64>(0))? {
                add(id?, 1.0);
            }
            let mut st = conn.prepare_cached(
                "SELECT o.from_page, count(*) FROM page_links m JOIN page_links o ON o.target = m.target
                 JOIN pages p ON p.id = o.from_page
                 WHERE m.from_page = ?1 AND o.from_page <> ?1 AND p.deleted_at IS NULL
                 GROUP BY o.from_page ORDER BY count(*) DESC LIMIT 40",
            )?;
            for row in st.query_map([page_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
                let (id, n) = row?;
                add(id, (0.4 + 0.15 * n as f64).min(0.9));
            }
        }
        // Pages with similar words (BM25 of the full-text index: rare words weigh more).
        let words = distinctive_words(&format!("{}\n{}", page.title, content));
        if !words.is_empty() {
            let query = words.iter().map(|w| format!("\"{w}\"")).collect::<Vec<_>>().join(" OR ");
            let mut st = conn.prepare_cached(
                "SELECT page_id, min(r) AS best FROM (
                     SELECT b.page_id, bm25(notes_blocks_fts) AS r FROM notes_blocks_fts f
                     JOIN notes_blocks b ON b.id = f.rowid JOIN pages p ON p.id = b.page_id
                     WHERE notes_blocks_fts MATCH ?1 AND b.page_id <> ?2 AND p.deleted_at IS NULL
                     ORDER BY rank LIMIT 400)
                 GROUP BY page_id ORDER BY best LIMIT ?3",
            )?;
            let ranked: Vec<(i64, f64)> = st
                .query_map(params![query, page_id, SIMILAR_PAGES], |r| Ok((r.get(0)?, r.get(1)?)))?
                .collect::<rusqlite::Result<_>>()?;
            let best = ranked.iter().map(|(_, r)| -r).fold(0.0f64, f64::max);
            if best > 0.0 {
                for (id, r) in ranked {
                    add(id, 0.8 * (-r / best));
                }
            }
        }
        if neighbours.is_empty() {
            return Ok(vec![]);
        }
        let mut tags_of: HashMap<i64, Vec<String>> = HashMap::new();
        {
            let mut st = conn.prepare_cached("SELECT tag FROM page_tags WHERE page_id = ?1")?;
            for id in neighbours.keys() {
                let tags: Vec<String> = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                if !tags.is_empty() {
                    tags_of.insert(*id, tags);
                }
            }
        }
        let df: HashMap<String, i64> = self.tag_counts()?.into_iter().collect();
        let total: i64 = conn.query_row(
            "SELECT (SELECT count(*) FROM pages) - (SELECT count(*) FROM pages WHERE deleted_at IS NOT NULL)",
            [],
            |r| r.get(0),
        )?;
        Ok(rank_tags(&neighbours, &tags_of, &df, total, &exclude))
    }

    /// „Verwerfen“: the tag is not suggested on this page again.
    pub fn dismiss_tag(&self, page_id: i64, tag: &str) -> Result<()> {
        if let Some(tag) = clean_tag(tag) {
            self.conn().execute(
                "INSERT OR IGNORE INTO tag_dismissals (page_id, tag) VALUES (?1, ?2)",
                params![page_id, tag],
            )?;
        }
        Ok(())
    }

    /// The most used tags (for the AI suggestions).
    pub fn tag_vocabulary(&self, limit: usize) -> Result<Vec<String>> {
        let mut counts = self.tag_counts()?;
        counts.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        Ok(counts.into_iter().take(limit).map(|(t, _)| t).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_by_similarity_and_rarity() {
        let neighbours: HashMap<i64, f64> = [(1, 1.0), (2, 0.9), (3, 0.3)].into();
        let tags_of: HashMap<i64, Vec<String>> = [
            (1, vec!["projekt-x".into(), "notiz".into()]),
            (2, vec!["projekt-x".into(), "notiz".into()]),
            (3, vec!["urlaub".into(), "notiz".into()]),
        ]
        .into();
        // „notiz“ is on almost every page: it weighs little.
        let df: HashMap<String, i64> = [("projekt-x".into(), 3), ("notiz".into(), 95), ("urlaub".into(), 2)].into();
        let out = rank_tags(&neighbours, &tags_of, &df, 100, &HashSet::new());
        assert_eq!(out[0].tag, "projekt-x");
        assert_eq!(out[0].pages, 2);
        assert!(out.iter().position(|s| s.tag == "notiz").unwrap_or(9) > 0);
        let excl: HashSet<String> = ["projekt-x".to_owned()].into();
        assert!(rank_tags(&neighbours, &tags_of, &df, 100, &excl).iter().all(|s| s.tag != "projekt-x"));
    }

    #[test]
    fn parses_ai_answers() {
        let vocab = vec!["projekt-x".to_owned(), "kunde".to_owned()];
        let have: HashSet<String> = ["kunde".to_owned()].into();
        let out =
            parse_ai_tags("Vorschlag: [\"#Projekt-X\", \"kunde\", \"neu eins\", \"zwei\", \"drei\"]", &vocab, &have);
        let tags: Vec<(&str, bool)> = out.iter().map(|s| (s.tag.as_str(), s.new)).collect();
        assert_eq!(tags, [("projekt-x", false), ("neu-eins", true), ("zwei", true)]);
        assert_eq!(parse_ai_tags("projekt-x, unsinn!!", &vocab, &HashSet::new()).len(), 1);
        assert_eq!(clean_tag("#Bau/Plan"), Some("bau/plan".into()));
        assert_eq!(clean_tag("123"), None);
    }

    #[test]
    fn suggests_tags_of_linked_and_similar_pages() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Kickoff Brückenbau", None).unwrap();
        let a = db.create_page(None, "Statik Brückenbau", None).unwrap();
        let b = db.create_page(None, "Ausschreibung", None).unwrap();
        let c = db.create_page(None, "Urlaub", None).unwrap();
        db.save_page_content(a.id, "Statik der Brücke, Brückenbau Pfeiler. #projekt-bruecke #statik").unwrap();
        db.save_page_content(b.id, "Ausschreibung für den Brückenbau mit [[Statik Brückenbau]]. #projekt-bruecke")
            .unwrap();
        db.save_page_content(c.id, "Strand und Sonne. #privat").unwrap();
        db.save_page_content(
            p.id,
            "Kickoff zum Brückenbau, Pfeiler und Statik besprechen. Siehe [[Statik Brückenbau]].",
        )
        .unwrap();
        let out = db.tag_suggestions(p.id).unwrap();
        assert_eq!(out.first().map(|s| s.tag.as_str()), Some("projekt-bruecke"), "{out:?}");
        assert!(out.iter().all(|s| s.tag != "privat"));
        db.dismiss_tag(p.id, "#projekt-bruecke").unwrap();
        assert!(db.tag_suggestions(p.id).unwrap().iter().all(|s| s.tag != "projekt-bruecke"));
        assert_eq!(db.tag_vocabulary(1).unwrap(), ["projekt-bruecke"]);
    }
}
