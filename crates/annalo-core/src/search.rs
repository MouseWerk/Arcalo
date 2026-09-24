//! Workspace-wide full-text search (SQLite FTS5, BM25 ranking).

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum SearchHit {
    /// The page title matches.
    Page {
        page_id: i64,
        title: String,
        icon: Option<String>,
        score: f64,
    },
    /// A passage of a note matches.
    Note {
        page_id: i64,
        title: String,
        icon: Option<String>,
        /// Matched terms are wrapped in `\u{2}` … `\u{3}`.
        snippet: String,
        score: f64,
    },
    TimeEntry {
        id: i64,
        netzplan_nr: String,
        vorgang_nr: Option<String>,
        snippet: String,
        score: f64,
    },
}

impl SearchHit {
    pub fn score(&self) -> f64 {
        match self {
            SearchHit::Page { score, .. } | SearchHit::Note { score, .. } | SearchHit::TimeEntry { score, .. } => {
                *score
            }
        }
    }
}

/// Turns free user input into a safe FTS5 query: every term is quoted (so
/// operators and punctuation are literal) and the last term is a prefix match
/// for search-as-you-type. Returns `None` for blank input.
pub fn fts_query(input: &str) -> Option<String> {
    let terms: Vec<String> = input
        .split_whitespace()
        .map(|t| t.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"", t.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(format!("{}*", terms.join(" ")))
}

/// Title matches are boosted so that typing a page name finds the page first.
const TITLE_BOOST: f64 = 10.0;

/// Splits `status:Offen` terms off the input: a term counts when some page schema defines the
/// property (`crate::properties`). Returns the filters and the remaining text.
fn property_terms(db: &Database, input: &str) -> Result<(Vec<(String, String)>, String)> {
    if !input.contains(':') {
        return Ok((vec![], input.to_owned()));
    }
    let keys = db.schema_property_keys()?;
    let mut filters = vec![];
    let mut rest = vec![];
    for term in input.split_whitespace() {
        match term.split_once(':') {
            Some((k, v)) if !v.is_empty() && keys.iter().any(|key| key.to_lowercase() == k.to_lowercase()) => {
                filters.push((k.to_owned(), v.to_owned()));
            }
            _ => rest.push(term),
        }
    }
    Ok((filters, rest.join(" ")))
}

pub fn search(db: &Database, input: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let (filters, text) = property_terms(db, input)?;
    if !filters.is_empty() {
        // Pages whose properties match every term; other text narrows them further.
        let today = chrono::Local::now().date_naive();
        let mut allowed: Option<Vec<crate::model::Page>> = None;
        for (k, v) in &filters {
            let op = if v.contains(['*', '~']) { "enthält" } else { "ist" };
            let found = db.pages_with_property(k, op, v.trim_matches(['*', '~']), today)?;
            allowed = Some(match allowed {
                None => found,
                Some(prev) => prev.into_iter().filter(|p| found.iter().any(|f| f.id == p.id)).collect(),
            });
        }
        let allowed = allowed.unwrap_or_default();
        if text.trim().is_empty() {
            return Ok(allowed
                .into_iter()
                .take(limit)
                .map(|p| SearchHit::Page { page_id: p.id, title: p.title, icon: p.icon, score: TITLE_BOOST })
                .collect());
        }
        let ids: std::collections::HashSet<i64> = allowed.iter().map(|p| p.id).collect();
        let mut hits = search(db, &text, limit * 4)?;
        hits.retain(|h| match h {
            SearchHit::Page { page_id, .. } | SearchHit::Note { page_id, .. } => ids.contains(page_id),
            SearchHit::TimeEntry { .. } => false,
        });
        hits.truncate(limit);
        return Ok(hits);
    }
    let Some(q) = fts_query(input) else { return Ok(vec![]) };
    let conn = db.conn();
    let limit_i = limit as i64;
    let mut hits: Vec<SearchHit> = vec![];

    let mut st = conn.prepare_cached(
        "SELECT p.id, p.title, p.icon, bm25(pages_fts) FROM pages_fts JOIN pages p ON p.id = pages_fts.rowid
         WHERE pages_fts MATCH ?1 AND p.deleted_at IS NULL ORDER BY bm25(pages_fts) LIMIT ?2",
    )?;
    for h in st.query_map(params![q, limit_i], |r| {
        Ok(SearchHit::Page {
            page_id: r.get(0)?,
            title: r.get(1)?,
            icon: r.get(2)?,
            score: TITLE_BOOST - r.get::<_, f64>(3)?,
        })
    })? {
        hits.push(h?);
    }

    // Best passage per page (rows arrive best first; later ones of the same page are dropped).
    let mut st = conn.prepare_cached(
        "SELECT b.page_id, p.title, p.icon, snippet(notes_blocks_fts, 0, char(2), char(3), '…', 14), bm25(notes_blocks_fts)
         FROM notes_blocks_fts
         JOIN notes_blocks b ON b.id = notes_blocks_fts.rowid
         JOIN pages p ON p.id = b.page_id
         WHERE notes_blocks_fts MATCH ?1 AND p.deleted_at IS NULL
         ORDER BY bm25(notes_blocks_fts) LIMIT ?2",
    )?;
    let mut seen = std::collections::HashSet::new();
    for h in st.query_map(params![q, limit_i * 4], |r| {
        Ok(SearchHit::Note {
            page_id: r.get(0)?,
            title: r.get(1)?,
            icon: r.get(2)?,
            snippet: r.get(3)?,
            // bm25() is "lower is better"; flip it so higher is better everywhere.
            score: -r.get::<_, f64>(4)?,
        })
    })? {
        let h = h?;
        if let SearchHit::Note { page_id, .. } = &h
            && seen.insert(*page_id)
        {
            hits.push(h);
        }
    }

    let mut st = conn.prepare_cached(
        "SELECT e.id, n.netzplan_nr, e.vorgang_nr,
                snippet(time_entries_fts, 0, char(2), char(3), '…', 12), bm25(time_entries_fts)
         FROM time_entries_fts
         JOIN time_entries e ON e.id = time_entries_fts.rowid
         JOIN netzplaene n ON n.id = e.netzplan_id
         WHERE time_entries_fts MATCH ?1
         ORDER BY bm25(time_entries_fts) LIMIT ?2",
    )?;
    for h in st.query_map(params![q, limit_i], |r| {
        Ok(SearchHit::TimeEntry {
            id: r.get(0)?,
            netzplan_nr: r.get(1)?,
            vorgang_nr: r.get(2)?,
            snippet: r.get(3)?,
            score: -r.get::<_, f64>(4)?,
        })
    })? {
        hits.push(h?);
    }

    hits.sort_by(|a, b| b.score().total_cmp(&a.score()));
    hits.truncate(limit);
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, NewTimeEntry};

    #[test]
    fn query_sanitising() {
        assert_eq!(fts_query("  "), None);
        assert_eq!(fts_query("NEAR( foo OR \"bar"), Some("\"NEAR\" \"foo\" \"OR\" \"bar\"*".into()));
    }

    #[test]
    fn finds_titles_notes_and_time_entries() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page(None, "Kickoff Systemintegration", None).unwrap();
        db.save_page_content(page.id, "Die Systemintegration beginnt im Oktober.\n\nBudget für Schnittstellen prüfen")
            .unwrap();
        let p = db.create_project("PRJ", "P").unwrap();
        let np = db.create_netzplan(p.id, "NP-1", "NP-1-1", "", 1.0).unwrap();
        db.insert_time_entry(&NewTimeEntry {
            netzplan_id: np.id,
            vorgang_nr: Some("1020".into()),
            leistungsart: None,
            start_time: chrono::Utc::now(),
            duration_minutes: 30,
            description: "Systemintegration Tests".into(),
            source: EntrySource::Manual,
            page_id: None,
        })
        .unwrap();

        let hits = search(&db, "systemint", 10).unwrap();
        assert_eq!(hits.len(), 3, "{hits:#?}");
        assert!(matches!(hits[0], SearchHit::Page { .. }), "title match ranks first");
        assert!(hits.iter().any(|h| matches!(h, SearchHit::TimeEntry { vorgang_nr: Some(v), .. } if v == "1020")));

        // remove_diacritics: "prufen" matches "prüfen".
        let hits = search(&db, "prufen", 10).unwrap();
        assert!(matches!(&hits[..], [SearchHit::Note { page_id, .. }] if *page_id == page.id));

        // Saving replaces the index.
        db.save_page_content(page.id, "nichts mehr").unwrap();
        assert!(search(&db, "prufen", 10).unwrap().is_empty());
    }

    #[test]
    fn property_terms_filter_pages_of_a_schema() {
        let db = Database::open_in_memory().unwrap();
        let parent = db.create_page(None, "Aufgaben", None).unwrap();
        db.save_page_content(
            parent.id,
            "---\neigenschaften:\n  status: {typ: auswahl, optionen: [Offen, Fertig]}\n---\n",
        )
        .unwrap();
        for (title, status, body) in
            [("Login", "Offen", "Formular bauen"), ("Export", "Fertig", "Formular prüfen"), ("Suche", "offen", "Index")]
        {
            let p = db.create_page(Some(parent.id), title, None).unwrap();
            db.save_page_content(p.id, &format!("---\nstatus: {status}\n---\n{body}")).unwrap();
        }
        let titles = |q: &str| -> Vec<String> {
            let mut t: Vec<String> = search(&db, q, 10)
                .unwrap()
                .into_iter()
                .filter_map(|h| match h {
                    SearchHit::Page { title, .. } | SearchHit::Note { title, .. } => Some(title),
                    SearchHit::TimeEntry { .. } => None,
                })
                .collect();
            t.sort();
            t
        };
        assert_eq!(titles("status:offen"), ["Login", "Suche"]);
        assert_eq!(titles("status:Offen formular"), ["Login"]);
        // Unknown keys stay plain search text.
        assert!(titles("phase:offen").is_empty());
    }
}
