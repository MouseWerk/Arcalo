//! Suche nach Bedeutung (1.15): the workspace search also finds pages by meaning, so
//! „Angebot Müller“ finds a page about a „Kostenvoranschlag für Kunde Müller“.
//!
//! There is no second index: the search uses the chunks the assistant retrieves from
//! (`notes_blocks`, cut by [`crate::notes::chunks`] and kept up to date on every save) and
//! their embeddings in `notes_blocks.vector_embedding` ([`crate::ai::rag`]). What this module
//! adds:
//!
//! - [`plan`]: whether the settings allow it and with which model. Local first: the switch is
//!   on by itself only when the embedding model of Settings → KI runs on a local provider; a
//!   provider in the cloud is used only when the switch is turned on, never with „Nur lokal“,
//!   and never for chunks of private pages ([`crate::ai::rag::pending_public_blocks`]) or a
//!   query that names a privacy marker ([`query_may_embed`]).
//! - [`ensure_index_model`]: the vectors of another model are dropped before indexing.
//! - [`VectorIndex`]: an in-memory copy of the vectors (8-bit, unit length) for queries well
//!   below 150 ms on 5,000 pages; it reads only the chunks stored since the last query.
//! - [`fuse`]: exact hits (FTS5) and meaning hits in one list by reciprocal rank fusion; strong
//!   exact hits (title hits, the first three passages) stay first.
//!
//! The background indexer and the query embedding live in the shell (`src-tauri/src/semantic.rs`).

use std::collections::{HashMap, HashSet};

use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::ai::rag;
use crate::db::Database;
use crate::error::Result;
use crate::search::{self, SearchHit};
use crate::settings::Settings;

/// Meaning hits below this cosine similarity are noise for the usual embedding models.
pub const MIN_SIMILARITY: f32 = 0.5;
/// Meaning hits further than this below the best one are left out (a long tail of weak hits
/// helps nobody).
pub const SIMILARITY_WINDOW: f32 = 0.25;
/// Exact hits at these first places stay above every meaning hit.
pub const STRONG_EXACT: usize = 3;
/// Rank fusion constant (as in [`crate::ai::rag::retrieve`]).
const RRF_K: f64 = 60.0;
/// Weight of a meaning hit against an exact hit at the same rank (a tie goes to the exact hit).
const MEANING_WEIGHT: f64 = 1.0;
/// Length of the passage shown with a meaning hit.
const PASSAGE_CHARS: usize = 220;
/// `meta.` key of the model the stored vectors come from.
const INDEX_META: &str = "embedding_index";

/// Why search by meaning does not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Inactive {
    /// No embedding model in Settings → KI.
    NoModel,
    /// The embedding model's provider is missing or switched off.
    ProviderOff,
    /// The switch „Suche nach Bedeutung“ is off.
    SwitchedOff,
    /// Datenschutz „Nur lokal“ and the embedding model is not on a local provider.
    LocalOnly,
}

/// What the settings say about search by meaning.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Plan {
    /// The switch as shown: the stored choice, else on exactly with a local embedding model.
    pub switch_on: bool,
    /// Whether the choice is the automatic one (nothing stored).
    pub automatic: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    /// The embedding model runs on a local provider (may see private pages).
    pub local: bool,
    /// `None`: it runs.
    pub inactive: Option<Inactive>,
}

impl Plan {
    pub fn active(&self) -> bool {
        self.inactive.is_none()
    }

    /// The key of the model in [`ensure_index_model`].
    pub fn index_key(&self) -> Option<String> {
        Some(index_key(self.provider.as_deref()?, self.model.as_deref()?))
    }
}

pub fn index_key(provider: &str, model: &str) -> String {
    format!("{}/{}", provider.trim(), model.trim())
}

/// Resolves the settings (see the module docs).
pub fn plan(s: &Settings) -> Plan {
    let model = s.embedding_model.as_deref().map(str::trim).filter(|m| !m.is_empty()).map(str::to_owned);
    let provider = s.providers.iter().find(|p| p.id == s.embedding_provider.trim());
    let local = model.is_some() && provider.is_some_and(|p| p.local);
    let switch_on = s.search.semantic.unwrap_or(local);
    let inactive = if model.is_none() {
        Some(Inactive::NoModel)
    } else if !provider.is_some_and(|p| p.enabled) {
        Some(Inactive::ProviderOff)
    } else if !switch_on {
        Some(Inactive::SwitchedOff)
    } else if !local && s.privacy.local_only {
        Some(Inactive::LocalOnly)
    } else {
        None
    };
    Plan {
        switch_on,
        automatic: s.search.semantic.is_none(),
        provider: provider.map(|p| p.id.clone()),
        model,
        local,
        inactive,
    }
}

/// Whether the query itself may go to the embedding model: always to a local one, to another
/// only when it names no privacy marker (`#privat` …).
pub fn query_may_embed(query: &str, local: bool, markers: &[String]) -> bool {
    local || !crate::ai::privacy::any_private([query], markers)
}

/// Makes sure the stored vectors come from model `key` (`provider/model`): vectors of another
/// model are dropped (they cannot be compared with this model's). A workspace whose vectors
/// were made before the marker existed keeps them. Returns whether they were dropped.
pub fn ensure_index_model(db: &Database, key: &str) -> Result<bool> {
    match db.meta_get(INDEX_META)? {
        Some(k) if k == key => Ok(false),
        Some(_) => {
            rag::clear_embeddings(db)?;
            db.meta_set(INDEX_META, key)?;
            Ok(true)
        }
        None => {
            db.meta_set(INDEX_META, key)?;
            Ok(false)
        }
    }
}

/// Whether the stored vectors are from model `key` (or from before the marker).
pub fn index_matches(db: &Database, key: &str) -> Result<bool> {
    Ok(db.meta_get(INDEX_META)?.is_none_or(|k| k == key))
}

/// „Index neu aufbauen“: every chunk is embedded again.
pub fn rebuild(db: &Database) -> Result<()> {
    rag::clear_embeddings(db)
}

/// How far the index is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// Chunks done (embedded, or left out as private).
    pub done: u64,
    pub total: u64,
    /// Chunks of private pages that stay out of the index (a provider that is not local).
    pub private_skipped: u64,
}

/// [`Progress`] of the index for a model that is `local` or not.
pub fn progress(db: &Database, local: bool, markers: &[String]) -> Result<Progress> {
    // Chunks are never empty (`notes::chunks` trims them), so the count needs no text.
    let total: i64 = db.conn().query_row(
        "SELECT count(*) FROM notes_blocks b JOIN pages p ON p.id = b.page_id WHERE p.deleted_at IS NULL",
        [],
        |r| r.get(0),
    )?;
    let (all, public) = rag::pending_counts(db, if local { &[] } else { markers })?;
    let total = total.max(0) as u64;
    Ok(Progress { done: total.saturating_sub(public), total, private_skipped: all.saturating_sub(public) })
}

/// The next chunks to embed for a model that is `local` or not (private pages only locally).
pub fn pending(db: &Database, local: bool, markers: &[String], limit: usize) -> Result<Vec<(i64, String)>> {
    if local { rag::pending_blocks(db, limit) } else { rag::pending_public_blocks(db, limit, markers) }
}

/// A page found by meaning: its best chunk.
#[derive(Debug, Clone, PartialEq)]
pub struct Meaning {
    pub page_id: i64,
    pub block_id: i64,
    pub title: String,
    pub icon: Option<String>,
    pub passage: String,
    pub similarity: f32,
}

/// The embedded chunks in memory: unit vectors quantized to 8 bits (a quarter of the memory of
/// `f32`, 10,000 chunks of 768 dimensions take about 7.5 MB), compared by dot product.
#[derive(Debug, Default)]
pub struct VectorIndex {
    epoch: Option<u64>,
    /// Position in the store log ([`rag::stored_since`]) read so far.
    log_pos: usize,
    dims: usize,
    blocks: Vec<i64>,
    pages: Vec<i64>,
    /// Scale of each row (its largest component / 127).
    scales: Vec<f32>,
    data: Vec<i8>,
    slot: HashMap<i64, usize>,
}

/// More changed rows than this: read everything again (one scan is cheaper than many lookups).
const INCREMENTAL_MAX: usize = 2_000;

fn quantize(v: &[f32]) -> Option<(f32, Vec<i8>)> {
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if !norm.is_finite() || norm == 0.0 {
        return None;
    }
    let max = v.iter().fold(0.0f32, |m, x| m.max((x / norm).abs()));
    if max == 0.0 {
        return None;
    }
    let scale = max / 127.0;
    Some((scale, v.iter().map(|x| ((x / norm) / scale).round().clamp(-127.0, 127.0) as i8).collect()))
}

fn dot(a: &[i8], b: &[i8]) -> i32 {
    // Chunks of 8 let the compiler vectorize the loop.
    let mut acc = [0i32; 8];
    let (ca, ra) = a.as_chunks::<8>();
    let (cb, rb) = b.as_chunks::<8>();
    for (x, y) in ca.iter().zip(cb) {
        for i in 0..8 {
            acc[i] += x[i] as i32 * y[i] as i32;
        }
    }
    let mut sum: i32 = acc.iter().sum();
    for (x, y) in ra.iter().zip(rb) {
        sum += *x as i32 * *y as i32;
    }
    sum
}

impl VectorIndex {
    pub fn len(&self) -> usize {
        self.blocks.len()
    }

    pub fn is_empty(&self) -> bool {
        self.blocks.is_empty()
    }

    /// Memory of the vectors in bytes.
    pub fn bytes(&self) -> usize {
        self.data.len() + self.scales.len() * 4 + self.blocks.len() * 16
    }

    fn put(&mut self, block: i64, page: i64, v: &[f32]) {
        if self.dims == 0 {
            self.dims = v.len();
        }
        let Some((scale, q)) = quantize(v).filter(|_| v.len() == self.dims) else { return };
        match self.slot.get(&block) {
            Some(&i) => {
                self.pages[i] = page;
                self.scales[i] = scale;
                self.data[i * self.dims..(i + 1) * self.dims].copy_from_slice(&q);
            }
            None => {
                self.slot.insert(block, self.blocks.len());
                self.blocks.push(block);
                self.pages.push(page);
                self.scales.push(scale);
                self.data.extend_from_slice(&q);
            }
        }
    }

    /// Brings the copy up to date with the database: the chunks stored since the last call,
    /// or everything after the vectors were cleared (and on first use).
    pub fn sync(&mut self, db: &Database) -> Result<()> {
        let (epoch, changed, end) = rag::stored_since(self.log_pos);
        if self.epoch == Some(epoch) && changed.is_empty() {
            return Ok(());
        }
        if self.epoch != Some(epoch) || changed.len() > INCREMENTAL_MAX {
            *self = VectorIndex { epoch: Some(epoch), log_pos: end, ..Default::default() };
            let mut st = db.conn().prepare(
                "SELECT id, page_id, vector_embedding FROM notes_blocks WHERE vector_embedding IS NOT NULL ORDER BY id",
            )?;
            let mut rows = st.query([])?;
            while let Some(r) = rows.next()? {
                let blob: Vec<u8> = r.get(2)?;
                self.put(r.get(0)?, r.get(1)?, &rag::decode(&blob));
            }
            return Ok(());
        }
        let mut st = db.conn().prepare_cached(
            "SELECT page_id, vector_embedding FROM notes_blocks WHERE id = ?1 AND vector_embedding IS NOT NULL",
        )?;
        for id in changed {
            let row = st.query_row([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?))).optional()?;
            if let Some((page, blob)) = row {
                self.put(id, page, &rag::decode(&blob));
            }
        }
        self.log_pos = end;
        Ok(())
    }

    /// The best chunks for `query`: `(row, similarity)`, best first, at most `k`.
    fn top_rows(&self, query: &[f32], k: usize) -> Vec<(usize, f32)> {
        let Some((qs, q)) = quantize(query).filter(|_| query.len() == self.dims && self.dims > 0) else {
            return vec![];
        };
        let mut scored: Vec<(usize, f32)> = (0..self.blocks.len())
            .map(|i| {
                let row = &self.data[i * self.dims..(i + 1) * self.dims];
                (i, dot(row, &q) as f32 * qs * self.scales[i])
            })
            .collect();
        if scored.len() > k {
            scored.select_nth_unstable_by(k, |a, b| b.1.total_cmp(&a.1));
            scored.truncate(k);
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored
    }

    /// Pages by meaning: the best chunk of each page, best first, at most `limit` pages, above
    /// [`MIN_SIMILARITY`] and within [`SIMILARITY_WINDOW`] of the best. Pages in the trash and
    /// templates are left out, and chunks that are gone since (an edit, a deletion).
    pub fn search(&self, db: &Database, query: &[f32], limit: usize) -> Result<Vec<Meaning>> {
        let rows = self.top_rows(query, limit * 6 + 8);
        let Some(best) = rows.first().map(|r| r.1) else { return Ok(vec![]) };
        let floor = MIN_SIMILARITY.max(best - SIMILARITY_WINDOW);
        let templates = db.template_page_ids()?;
        let mut st = db.conn().prepare_cached(
            "SELECT p.id, p.title, p.icon, b.content_markdown FROM notes_blocks b JOIN pages p ON p.id = b.page_id
             WHERE b.id = ?1 AND p.deleted_at IS NULL AND b.vector_embedding IS NOT NULL",
        )?;
        let mut seen = HashSet::new();
        let mut out = vec![];
        for (row, sim) in rows {
            if sim < floor || out.len() >= limit {
                break;
            }
            let (block, page) = (self.blocks[row], self.pages[row]);
            if templates.contains(&page) || !seen.insert(page) {
                continue;
            }
            let found = st
                .query_row([block], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                    ))
                })
                .optional()?;
            let Some((page_id, title, icon, text)) = found else {
                seen.remove(&page);
                continue;
            };
            out.push(Meaning { page_id, block_id: block, title, icon, passage: passage(&text), similarity: sim });
        }
        Ok(out)
    }
}

/// The passage of a chunk as shown with a meaning hit: one line, without heading marks, at most
/// [`PASSAGE_CHARS`] characters.
pub fn passage(markdown: &str) -> String {
    let lines: Vec<&str> = markdown
        .lines()
        .map(|l| l.trim().trim_start_matches('#').trim())
        .filter(|l| !l.is_empty() && !l.starts_with("```") && *l != "---")
        .collect();
    // A heading alone says little: the text below it comes first when there is any.
    let text =
        if lines.len() > 1 && markdown.trim_start().starts_with('#') { lines[1..].join(" ") } else { lines.join(" ") };
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.chars().count() <= PASSAGE_CHARS {
        return text;
    }
    let cut: String = text.chars().take(PASSAGE_CHARS).collect();
    let cut = match cut.rfind(' ') {
        Some(i) if i > PASSAGE_CHARS / 2 => &cut[..i],
        _ => cut.as_str(),
    };
    format!("{}…", cut.trim_end_matches([',', ';', ':', '.', ' ']))
}

/// Exact hits and meaning hits in one list (see the module docs): every hit scores
/// `1 / (60 + rank)` in its list, a page in both lists adds both, a tie goes to the exact hit;
/// exact hits among the first [`STRONG_EXACT`] and title hits stay on top in their order. A
/// page that is an exact hit is not listed again as a meaning hit.
pub fn fuse(exact: Vec<SearchHit>, meaning: Vec<Meaning>, limit: usize) -> Vec<SearchHit> {
    let meaning_rank: HashMap<i64, usize> = meaning.iter().enumerate().map(|(r, m)| (m.page_id, r)).collect();
    let exact_pages: HashSet<i64> = exact.iter().filter_map(SearchHit::page_id).collect();
    let mut boosted = HashSet::new();
    let mut scored: Vec<(bool, f64, usize, SearchHit)> = Vec::with_capacity(exact.len() + meaning.len());
    for (i, mut h) in exact.into_iter().enumerate() {
        let strong = i < STRONG_EXACT || matches!(h, SearchHit::Page { .. });
        let mut score = 1.0 / (RRF_K + i as f64 + 1.0);
        if let Some(p) = h.page_id()
            && let Some(r) = meaning_rank.get(&p)
            && boosted.insert(p)
        {
            score += MEANING_WEIGHT / (RRF_K + *r as f64 + 1.0);
        }
        set_score(&mut h, score);
        scored.push((strong, score, i, h));
    }
    let base = scored.len();
    for (r, m) in meaning.into_iter().enumerate() {
        if exact_pages.contains(&m.page_id) {
            continue;
        }
        let score = MEANING_WEIGHT / (RRF_K + r as f64 + 1.0);
        let hit = SearchHit::Similar {
            page_id: m.page_id,
            title: m.title,
            icon: m.icon,
            passage: m.passage,
            similarity: m.similarity as f64,
            score,
        };
        scored.push((false, score, base + r, hit));
    }
    scored
        .sort_by(|a, b| b.0.cmp(&a.0).then(if a.0 { a.2.cmp(&b.2) } else { b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)) }));
    scored.into_iter().take(limit).map(|(_, _, _, h)| h).collect()
}

fn set_score(h: &mut SearchHit, value: f64) {
    match h {
        SearchHit::Page { score, .. }
        | SearchHit::Note { score, .. }
        | SearchHit::Similar { score, .. }
        | SearchHit::TimeEntry { score, .. } => *score = value,
    }
}

/// The search with meaning: exact hits ([`search::search`]) fused with the pages whose chunks
/// are closest to `query` (its embedding). Without an embedding, or for property filters
/// (`status:offen`), exact hits only.
pub fn search(
    db: &Database,
    index: &mut VectorIndex,
    input: &str,
    query: Option<&[f32]>,
    limit: usize,
) -> Result<Vec<SearchHit>> {
    let exact = search::search(db, input, limit)?;
    let Some(q) = query.filter(|_| !search::has_property_terms(db, input).unwrap_or(false)) else {
        return Ok(exact);
    };
    index.sync(db)?;
    let meaning = index.search(db, q, limit)?;
    Ok(fuse(exact, meaning, limit))
}

#[cfg(test)]
mod tests;
