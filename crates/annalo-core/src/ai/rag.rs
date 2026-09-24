//! Local retrieval-augmented generation over notes and time logs.
//!
//! Embeddings are stored as little-endian `f32` BLOBs in
//! `notes_blocks.vector_embedding` and searched with an exact cosine scan,
//! which stays in the low milliseconds for tens of thousands of blocks. The
//! vector results are fused with FTS5 keyword hits (reciprocal rank fusion) so
//! exact identifiers like `NP-8801` are never lost to fuzzy similarity.
//!
//! Indexing is split into sync DB steps and one async embedding call so the
//! caller never holds the database across an `.await`.

use std::collections::HashMap;

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::search::{self, SearchHit};

pub fn encode(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| x.to_le_bytes()).collect()
}

pub fn decode(b: &[u8]) -> Vec<f32> {
    b.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 { 0.0 } else { dot / (na.sqrt() * nb.sqrt()) }
}

pub fn store_embedding(db: &Database, block_id: i64, embedding: &[f32]) -> Result<()> {
    db.conn()
        .execute("UPDATE notes_blocks SET vector_embedding = ?2 WHERE id = ?1", params![block_id, encode(embedding)])?;
    Ok(())
}

/// Blocks with text but no embedding yet: `(id, text)`.
pub fn pending_blocks(db: &Database, limit: usize) -> Result<Vec<(i64, String)>> {
    let mut st = db.conn().prepare_cached(
        "SELECT b.id, b.content_markdown FROM notes_blocks b JOIN pages p ON p.id = b.page_id
         WHERE b.vector_embedding IS NULL AND trim(b.content_markdown) <> '' AND p.deleted_at IS NULL
         ORDER BY b.id LIMIT ?1",
    )?;
    let rows = st.query_map([limit as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// [`pending_blocks`] without the blocks of private pages: pages tagged with one of `markers`
/// (`#privat` → tag `privat`) and blocks whose text contains one. They stay unembedded (found by
/// keyword search only) when the embedding model is not on a local provider.
pub fn pending_public_blocks(db: &Database, limit: usize, markers: &[String]) -> Result<Vec<(i64, String)>> {
    let markers: Vec<String> =
        markers.iter().map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty() && m != "#").collect();
    let mut sql = String::from(
        "SELECT b.id, b.content_markdown FROM notes_blocks b JOIN pages p ON p.id = b.page_id
         WHERE b.vector_embedding IS NULL AND trim(b.content_markdown) <> '' AND p.deleted_at IS NULL",
    );
    let mut args: Vec<String> = vec![];
    for m in &markers {
        args.push(m.trim_start_matches('#').to_owned());
        let tag = args.len();
        args.push(m.clone());
        let text = args.len();
        sql.push_str(&format!(
            " AND NOT EXISTS (SELECT 1 FROM page_tags t WHERE t.page_id = b.page_id AND lower(t.tag) = ?{tag})
              AND instr(lower(b.content_markdown), ?{text}) = 0"
        ));
    }
    sql.push_str(&format!(" ORDER BY b.id LIMIT {}", limit.max(1)));
    let mut st = db.conn().prepare(&sql)?;
    let rows = st
        .query_map(rusqlite::params_from_iter(args.iter()), |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContextChunk {
    pub source: String,
    /// Page the chunk belongs to, for citations in the UI.
    pub page_id: Option<i64>,
    pub text: String,
    pub score: f64,
    pub block_id: Option<i64>,
    pub time_entry_id: Option<i64>,
    /// Title of the page (`None` for time log entries).
    #[serde(default)]
    pub title: Option<String>,
    /// Headings above the chunk on its page, outermost first (`Architektur › Datenbank`).
    #[serde(default)]
    pub heading: Option<String>,
}

/// Headings (without `#`) of a Markdown text in order, with their level, outside code fences.
fn headings(markdown: &str) -> Vec<(usize, String)> {
    let mut out = vec![];
    let mut in_fence = false;
    for line in markdown.lines() {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence || !line.starts_with('#') {
            continue;
        }
        let level = line.chars().take_while(|c| *c == '#').count();
        let rest = &line[level..];
        if level <= 6 && rest.starts_with(' ') && !rest.trim().is_empty() {
            out.push((level, rest.trim().trim_end_matches('#').trim().to_owned()));
        }
    }
    out
}

/// The heading path of a chunk: the headings of all chunks before it (and its own leading
/// heading), reduced to the enclosing ones.
pub fn heading_path(chunks_up_to: &[String]) -> Option<String> {
    let mut stack: Vec<(usize, String)> = vec![];
    let n = chunks_up_to.len();
    for (i, chunk) in chunks_up_to.iter().enumerate() {
        let hs = headings(chunk);
        // Of the chunk itself only a heading at its very start counts: it titles the chunk.
        let hs = if i + 1 == n {
            if chunk.trim_start().starts_with('#') { hs.into_iter().take(1).collect() } else { vec![] }
        } else {
            hs
        };
        for (level, text) in hs {
            while stack.last().is_some_and(|(l, _)| *l >= level) {
                stack.pop();
            }
            stack.push((level, text));
        }
    }
    (!stack.is_empty()).then(|| stack.into_iter().map(|(_, t)| t).collect::<Vec<_>>().join(" › "))
}

fn block_heading(db: &Database, block_id: i64) -> Result<Option<String>> {
    let mut st = db.conn().prepare_cached(
        "SELECT b.content_markdown FROM notes_blocks b JOIN notes_blocks me ON me.id = ?1
         WHERE b.page_id = me.page_id AND b.position <= me.position ORDER BY b.position",
    )?;
    let chunks: Vec<String> = st.query_map([block_id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    Ok(heading_path(&chunks))
}

/// Exact cosine top-k over all embedded blocks: `(block_id, similarity)`.
/// Template pages („Vorlagen“) are skipped: their placeholders are no knowledge.
pub fn vector_top_k(db: &Database, query: &[f32], k: usize) -> Result<Vec<(i64, f32)>> {
    let templates = db.template_page_ids()?;
    // Trashed pages are not searched.
    let mut st = db.conn().prepare_cached(
        "SELECT b.id, b.vector_embedding, b.page_id FROM notes_blocks b JOIN pages p ON p.id = b.page_id
         WHERE b.vector_embedding IS NOT NULL AND p.deleted_at IS NULL",
    )?;
    let mut scored: Vec<(i64, f32)> = st
        .query_map([], |r| {
            let blob: Vec<u8> = r.get(1)?;
            Ok((r.get::<_, i64>(0)?, cosine(query, &decode(&blob)), r.get::<_, i64>(2)?))
        })?
        .filter(|r| r.as_ref().map_or(true, |(_, _, page)| !templates.contains(page)))
        .map(|r| r.map(|(id, score, _)| (id, score)))
        .collect::<rusqlite::Result<_>>()?;
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    scored.truncate(k);
    Ok(scored)
}

/// The best-matching chunk of a page for a keyword query.
fn best_chunk(db: &Database, page_id: i64, query_text: &str) -> Result<Option<i64>> {
    let Some(q) = search::fts_query(query_text) else { return Ok(None) };
    Ok(db
        .conn()
        .query_row(
            "SELECT b.id FROM notes_blocks_fts JOIN notes_blocks b ON b.id = notes_blocks_fts.rowid
             WHERE notes_blocks_fts MATCH ?1 AND b.page_id = ?2 ORDER BY bm25(notes_blocks_fts) LIMIT 1",
            params![q, page_id],
            |r| r.get(0),
        )
        .optional()?)
}

/// Hybrid retrieval: vector similarity (when a query embedding is given) fused
/// with keyword search over blocks and time logs. Template pages are left out.
pub fn retrieve(
    db: &Database,
    query_text: &str,
    query_embedding: Option<&[f32]>,
    k: usize,
) -> Result<Vec<ContextChunk>> {
    const RRF_K: f64 = 60.0;
    #[derive(Hash, PartialEq, Eq, Clone, Copy)]
    enum Key {
        Block(i64),
        Entry(i64),
    }
    let mut fused: HashMap<Key, f64> = HashMap::new();
    let templates = db.template_page_ids()?;

    if let Some(q) = query_embedding {
        for (rank, (id, _)) in vector_top_k(db, q, k * 2)?.into_iter().enumerate() {
            *fused.entry(Key::Block(id)).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
        }
    }
    for (rank, hit) in search::search(db, query_text, k * 2)?.into_iter().enumerate() {
        let key = match hit {
            // Title hits carry no passage; the page's chunks are found via content.
            SearchHit::Page { .. } => continue,
            SearchHit::Note { page_id, .. } if templates.contains(&page_id) => continue,
            SearchHit::Note { page_id, .. } => match best_chunk(db, page_id, query_text)? {
                Some(id) => Key::Block(id),
                None => continue,
            },
            SearchHit::TimeEntry { id, .. } => Key::Entry(id),
        };
        *fused.entry(key).or_default() += 1.0 / (RRF_K + rank as f64 + 1.0);
    }

    let mut ranked: Vec<(Key, f64)> = fused.into_iter().collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    ranked.truncate(k);

    let conn = db.conn();
    let mut out = Vec::with_capacity(ranked.len());
    for (key, score) in ranked {
        let chunk = match key {
            Key::Block(id) => conn
                .query_row(
                    "SELECT p.title, b.content_markdown, p.id FROM notes_blocks b JOIN pages p ON p.id = b.page_id WHERE b.id = ?1 AND p.deleted_at IS NULL",
                    [id],
                    |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)),
                )
                .optional()?
                .map(|(title, text, page_id)| ContextChunk {
                    source: format!("Seite: {title}"),
                    page_id: Some(page_id),
                    text,
                    score,
                    block_id: Some(id),
                    time_entry_id: None,
                    title: Some(title),
                    heading: None,
                }),
            Key::Entry(id) => conn
                .query_row(
                    "SELECT n.netzplan_nr, e.vorgang_nr, e.start_time, e.duration_minutes, e.description
                     FROM time_entries e JOIN netzplaene n ON n.id = e.netzplan_id WHERE e.id = ?1",
                    [id],
                    |r| {
                        let np: String = r.get(0)?;
                        let v: Option<String> = r.get(1)?;
                        let start: String = r.get(2)?;
                        let minutes: Option<i64> = r.get(3)?;
                        let desc: String = r.get(4)?;
                        let target = v.map_or(np.clone(), |v| format!("{np}/{v}"));
                        let hours = minutes.map_or("läuft".to_owned(), |m| format!("{:.2}h", m as f64 / 60.0));
                        Ok(format!("{} {target} {hours}: {desc}", &start[..10.min(start.len())]))
                    },
                )
                .optional()?
                .map(|text| ContextChunk {
                    source: "Zeiterfassung".into(),
                    page_id: None,
                    text,
                    score,
                    block_id: None,
                    time_entry_id: Some(id),
                    title: None,
                    heading: None,
                }),
        };
        out.extend(chunk);
    }
    for c in &mut out {
        if let Some(id) = c.block_id {
            c.heading = block_heading(db, id)?;
        }
    }
    Ok(out)
}

/// How the model cites the numbered sources of [`format_context`].
pub const CITATION_RULES: &str = "Belege jede Aussage, die auf einer dieser Quellen beruht, direkt danach \
     mit ihrer Nummer in eckigen Klammern, z. B. „… wird im Oktober freigegeben [2].“ – mehrere Quellen als [1][3]. \
     Verwende nur die Nummern der Quellen oben, erfinde keine und schreibe kein Quellenverzeichnis.";

/// Renders retrieved chunks as a system-prompt section: numbered sources `[1]`, `[2]` … with
/// page title and heading path, followed by the citation rules. The numbers are the 1-based
/// positions in `chunks`, so the UI maps `[n]` to `chunks[n - 1]`.
pub fn format_context(chunks: &[ContextChunk]) -> String {
    format_context_with(chunks, true)
}

/// [`format_context`]; without `citations` the model is not asked to cite with `[n]`.
pub fn format_context_with(chunks: &[ContextChunk], citations: bool) -> String {
    if !citations {
        let mut s = String::from("Relevanter Kontext aus dem lokalen Workspace:\n");
        for c in chunks {
            let label = match (&c.title, &c.heading) {
                (Some(t), Some(h)) => format!("Seite: {t} › {h}"),
                _ => c.source.clone(),
            };
            s.push_str(&format!("\n({label})\n{}\n", c.text.trim()));
        }
        return s;
    }
    let mut s = String::from("Relevanter Kontext aus dem lokalen Workspace (nummerierte Quellen):\n");
    for (i, c) in chunks.iter().enumerate() {
        let label = match (&c.title, &c.heading) {
            (Some(t), Some(h)) => format!("Seite: {t} › {h}"),
            _ => c.source.clone(),
        };
        s.push_str(&format!("\n[{}] ({label})\n{}\n", i + 1, c.text.trim()));
    }
    s.push('\n');
    s.push_str(CITATION_RULES);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_roundtrip_and_cosine() {
        let v = [0.5f32, -1.25, 3.0];
        assert_eq!(decode(&encode(&v)), v);
        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-6);
        assert_eq!(cosine(&[1.0, 0.0], &[0.0, 1.0]), 0.0);
        assert_eq!(cosine(&[1.0], &[1.0, 2.0]), 0.0);
    }

    #[test]
    fn hybrid_retrieval_fuses_vector_and_keyword_hits() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page(None, "Architektur", None).unwrap();
        db.save_page_content(
            page.id,
            "# Datenbank\n\nDer Datenbank-Layer nutzt SQLite mit WAL.\n\n# Netzplan\n\nNetzplan NP-8801 wird im Oktober freigegeben.\n\n# Sonstiges\n\nKaffeemaschine im 3. OG ist defekt.",
        )
        .unwrap();

        let pending = pending_blocks(&db, 10).unwrap();
        assert_eq!(pending.len(), 3);
        let (a, b, c) = (pending[0].0, pending[1].0, pending[2].0);
        store_embedding(&db, a, &[1.0, 0.0, 0.0]).unwrap();
        store_embedding(&db, b, &[0.0, 1.0, 0.0]).unwrap();
        store_embedding(&db, c, &[0.0, 0.0, 1.0]).unwrap();
        assert!(pending_blocks(&db, 10).unwrap().is_empty());

        // Vector points at the database block, keywords at the Netzplan block:
        // both must be in the top 2, the unrelated block must not.
        let chunks = retrieve(&db, "NP-8801", Some(&[0.9, 0.1, 0.0]), 2).unwrap();
        let ids: Vec<_> = chunks.iter().filter_map(|c| c.block_id).collect();
        assert!(ids.contains(&a) && ids.contains(&b), "{chunks:?}");
        assert!(format_context(&chunks).contains("[1] (Seite: Architektur"));
    }

    #[test]
    fn private_pages_are_not_embedded_by_other_providers() {
        let db = Database::open_in_memory().unwrap();
        let secret = db.create_page(None, "Gehälter", None).unwrap();
        db.save_page_content(secret.id, "# Team\n\nGehaltsrunde 2026.\n\n# Tags\n\n#Privat").unwrap();
        let marked = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(marked.id, "Offen: Rollout. Vertraulich, siehe #vertraulich-Liste").unwrap();
        let open = db.create_page(None, "Projekt", None).unwrap();
        db.save_page_content(open.id, "Der Rollout startet im Oktober.").unwrap();
        let markers = vec!["#privat".to_string(), "#vertraulich".to_string()];
        let page_of = |id: i64| -> i64 {
            db.conn().query_row("SELECT page_id FROM notes_blocks WHERE id = ?1", [id], |r| r.get(0)).unwrap()
        };
        let got: Vec<i64> =
            pending_public_blocks(&db, 10, &markers).unwrap().iter().map(|(id, _)| page_of(*id)).collect();
        assert_eq!(got, [open.id]);
        // Without markers every block is pending, as before.
        assert_eq!(pending_public_blocks(&db, 10, &[]).unwrap(), pending_blocks(&db, 10).unwrap());
    }

    #[test]
    fn template_pages_are_not_retrieved() {
        let db = Database::open_in_memory().unwrap();
        let root = db.templates_root().unwrap();
        db.save_page_content(root.id, "Vorlagen für Statusberichte zum Rollout.").unwrap();
        let tpl = db.create_page(Some(root.id), "Statusbericht", None).unwrap();
        db.save_page_content(tpl.id, "# Statusbericht {{kw}}\n\nRollout-Status: …").unwrap();
        let nested = db.create_page(Some(tpl.id), "Statusbericht kurz", None).unwrap();
        db.save_page_content(nested.id, "Rollout kurz: {{datum}}").unwrap();
        let note = db.create_page(None, "Projekt", None).unwrap();
        db.save_page_content(note.id, "Der Rollout startet im Oktober.").unwrap();
        for (i, (id, _)) in pending_blocks(&db, 10).unwrap().into_iter().enumerate() {
            store_embedding(&db, id, &[1.0, i as f32 * 0.01]).unwrap();
        }

        let pages = |chunks: Vec<ContextChunk>| chunks.into_iter().filter_map(|c| c.page_id).collect::<Vec<_>>();
        assert_eq!(pages(retrieve(&db, "Rollout", None, 5).unwrap()), [note.id], "keyword");
        assert_eq!(pages(retrieve(&db, "Rollout", Some(&[1.0, 0.0]), 5).unwrap()), [note.id], "keyword + vector");
        let vec_pages: Vec<i64> = vector_top_k(&db, &[1.0, 0.0], 10)
            .unwrap()
            .into_iter()
            .map(|(id, _)| {
                db.conn().query_row("SELECT page_id FROM notes_blocks WHERE id = ?1", [id], |r| r.get(0)).unwrap()
            })
            .collect();
        assert_eq!(vec_pages, [note.id], "vector");
    }

    #[test]
    fn heading_paths_follow_the_outline() {
        let c = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(heading_path(&c(&["Intro"])), None);
        assert_eq!(heading_path(&c(&["# A\n\ntext"])).as_deref(), Some("A"));
        assert_eq!(heading_path(&c(&["# A\n\n## B\n\nx", "## C\n\ny"])).as_deref(), Some("A › C"));
        assert_eq!(heading_path(&c(&["# A", "### Tief", "## B"])).as_deref(), Some("A › B"));
        // A continuation chunk inherits the heading of the section; a fenced `#` is no heading.
        assert_eq!(heading_path(&c(&["# A\n\n```\n# kein\n```", "weiter"])).as_deref(), Some("A"));
    }

    #[test]
    fn context_is_numbered_with_titles_headings_and_citation_rules() {
        let db = Database::open_in_memory().unwrap();
        let page = db.create_page(None, "Architektur", None).unwrap();
        db.save_page_content(page.id, "# Plan\n\n## Netzplan\n\nNetzplan NP-8801 wird im Oktober freigegeben.")
            .unwrap();
        let other = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(other.id, "NP-8801 hat Vorrang.").unwrap();

        let chunks = retrieve(&db, "NP-8801", None, 5).unwrap();
        assert_eq!(chunks.len(), 2, "{chunks:?}");
        let arch = chunks.iter().find(|c| c.page_id == Some(page.id)).unwrap();
        assert_eq!(arch.title.as_deref(), Some("Architektur"));
        assert_eq!(arch.heading.as_deref(), Some("Plan › Netzplan"));
        assert!(arch.block_id.is_some());
        let note = chunks.iter().find(|c| c.page_id == Some(other.id)).unwrap();
        assert_eq!(note.heading, None);

        let ctx = format_context(&chunks);
        for (i, c) in chunks.iter().enumerate() {
            let n = format!("[{}] (", i + 1);
            assert!(ctx.contains(&n), "{ctx}");
            assert!(ctx[ctx.find(&n).unwrap()..].contains(c.text.trim()));
        }
        assert!(ctx.contains("(Seite: Architektur › Plan › Netzplan)"), "{ctx}");
        assert!(ctx.contains("(Seite: Notiz)"), "{ctx}");
        assert!(!ctx.contains("\n[3] ("));
        assert!(ctx.trim_end().ends_with(CITATION_RULES));
    }
}
