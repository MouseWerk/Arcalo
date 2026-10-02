//! Duplicate hints: notes that are probably the same note twice.
//!
//! Two signals: near-identical titles (compared after [`normalize_title`]: case, umlauts,
//! punctuation, dates and „Kopie“ do not count) and similar text (the Jaccard similarity of the
//! word 3-grams). For the text, every save keeps a MinHash signature of the page and its LSH
//! bands (`page_minhash`, `page_minhash_bands`, migration 26), so the candidates of a page are
//! an indexed lookup; the shown percentage is then the exact Jaccard of the two texts.
//!
//! „Zusammenführen“ appends the other page's text to this one, points every link to the other
//! page here, moves its subpages and puts it in the trash; the last merge can be undone.

use std::collections::{HashMap, HashSet};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::tr;

/// Hash functions of a signature.
pub const HASHES: usize = 64;
/// LSH bands of [`ROWS`] hashes each (`BANDS * ROWS == HASHES`): pairs from about 50 %
/// similarity on share a band.
const BANDS: usize = 16;
const ROWS: usize = HASHES / BANDS;
/// Pages with fewer 3-grams than this (about a dozen words) have no text signature.
pub const MIN_SHINGLES: usize = 12;
/// Text similarity from which a page counts as a likely duplicate.
pub const TEXT_THRESHOLD: f64 = 0.6;
/// Title similarity from which a page counts as a likely duplicate.
pub const TITLE_THRESHOLD: f64 = 0.9;
/// Meta key of the last merge (for „Rückgängig“).
const MERGE_UNDO: &str = "merge_undo";

/// Lower case, umlauts spelled out, without dates, punctuation and copy markers.
pub fn normalize_title(title: &str) -> String {
    let mut s = String::with_capacity(title.len());
    for c in title.to_lowercase().chars() {
        match c {
            'ä' => s.push_str("ae"),
            'ö' => s.push_str("oe"),
            'ü' => s.push_str("ue"),
            'ß' => s.push_str("ss"),
            _ => s.push(c),
        }
    }
    // Dates: runs of digits and `.-/` with at least one separator between digits
    // (2026-10-02, 02.10.2026, 2.10., 10/2026).
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_ascii_digit() {
            let mut j = i;
            while j < chars.len() && (chars[j].is_ascii_digit() || matches!(chars[j], '.' | '-' | '/')) {
                j += 1;
            }
            let run: String = chars[i..j].iter().collect();
            let run = run.trim_end_matches(['.', '-', '/']);
            let date =
                run.contains(['.', '-', '/']) && run.split(['.', '-', '/']).filter(|p| !p.is_empty()).count() >= 2;
            if date {
                out.push(' ');
            } else {
                out.extend(&chars[i..j]);
            }
            i = j;
        } else {
            out.push(chars[i]);
            i += 1;
        }
    }
    out.split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty() && !matches!(*w, "kopie" | "copy" | "duplikat" | "duplicate"))
        .collect::<Vec<_>>()
        .join(" ")
}

fn bigrams(s: &str) -> Vec<(char, char)> {
    let c: Vec<char> = s.chars().collect();
    let mut b: Vec<(char, char)> = c.windows(2).map(|w| (w[0], w[1])).collect();
    b.sort_unstable();
    b
}

/// Similarity of two normalized titles: 1.0 when equal, else the Dice coefficient of their
/// character bigrams.
pub fn title_similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let (x, y) = (bigrams(a), bigrams(b));
    if x.is_empty() || y.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0, 0, 0);
    while i < x.len() && j < y.len() {
        match x[i].cmp(&y[j]) {
            std::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    2.0 * common as f64 / (x.len() + y.len()) as f64
}

fn fnv(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn mix(mut x: u64) -> u64 {
    x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    x = (x ^ (x >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    x = (x ^ (x >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    x ^ (x >> 31)
}

/// The hashed word 3-grams of a page's text (frontmatter left out), sorted, without repeats.
pub fn shingles(markdown: &str) -> Vec<u64> {
    let body = crate::embeds::without_frontmatter(markdown);
    let words: Vec<String> = body
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| normalize_title(w).replace(' ', ""))
        .filter(|w| !w.is_empty())
        .collect();
    let mut out: Vec<u64> = words.windows(3).map(|w| fnv(&w.join(" "))).collect();
    out.sort_unstable();
    out.dedup();
    out
}

/// The exact Jaccard similarity of two shingle sets (as from [`shingles`]).
pub fn jaccard(a: &[u64], b: &[u64]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (mut i, mut j, mut common) = (0, 0, 0usize);
    while i < a.len() && j < b.len() {
        match a[i].cmp(&b[j]) {
            std::cmp::Ordering::Equal => {
                common += 1;
                i += 1;
                j += 1;
            }
            std::cmp::Ordering::Less => i += 1,
            std::cmp::Ordering::Greater => j += 1,
        }
    }
    common as f64 / (a.len() + b.len() - common) as f64
}

/// The MinHash signature of a shingle set.
pub fn signature(shingles: &[u64]) -> Vec<u32> {
    (0..HASHES)
        .map(|i| {
            let seed = mix(i as u64 + 1);
            shingles.iter().map(|s| (mix(s ^ seed) >> 32) as u32).min().unwrap_or(u32::MAX)
        })
        .collect()
}

/// The estimated Jaccard similarity of two signatures.
pub fn estimate(a: &[u32], b: &[u32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    a.iter().zip(b).filter(|(x, y)| x == y).count() as f64 / a.len() as f64
}

/// The LSH band keys of a signature.
pub fn bands(sig: &[u32]) -> Vec<i64> {
    sig.chunks(ROWS)
        .enumerate()
        .map(|(b, rows)| {
            let mut h = mix(b as u64 ^ 0xb5ad_4ece_da1c_e2a9);
            for r in rows {
                h = mix(h ^ *r as u64);
            }
            h as i64
        })
        .collect()
}

fn sig_blob(sig: &[u32]) -> Vec<u8> {
    sig.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn blob_sig(blob: &[u8]) -> Vec<u32> {
    blob.chunks_exact(4).map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// A page that is probably a duplicate of the open one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicateHint {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    /// The shown similarity (0–1): the higher of text and title similarity.
    pub score: f64,
    pub text_score: f64,
    pub title_score: f64,
}

/// A likely duplicate pair of „Doppelte Seiten finden“.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DuplicatePair {
    pub a: i64,
    pub a_title: String,
    pub b: i64,
    pub b_title: String,
    pub score: f64,
    pub text_score: f64,
    pub title_score: f64,
}

/// What a merge did; the merge can be undone until the next one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergeOutcome {
    pub keep: i64,
    pub other: i64,
    /// Pages whose links now point to the kept page.
    pub relinked: usize,
    /// Every page whose content changed (the kept one included), for the editors to reload.
    pub changed: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MergeUndo {
    keep: i64,
    other: i64,
    /// Contents before the merge of every page it changed (the kept one included).
    contents: Vec<(i64, String)>,
    /// Subpages of the other page moved to the kept one: id and former position.
    children: Vec<(i64, i64)>,
}

fn pair(a: i64, b: i64) -> (i64, i64) {
    if a < b { (a, b) } else { (b, a) }
}

impl Database {
    /// Keeps the duplicate index of a page in step with its content (from [`Database::reindex_page`]).
    /// Daily notes, canvases and short pages have no signature.
    pub(crate) fn reindex_minhash(&self, id: i64, content: &str) -> Result<()> {
        let conn = self.conn();
        let daily: bool = conn
            .query_row("SELECT daily_date IS NOT NULL FROM pages WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or(true);
        let sh = if daily || content.is_empty() { vec![] } else { shingles(content) };
        if sh.len() < MIN_SHINGLES {
            conn.prepare_cached("DELETE FROM page_minhash WHERE page_id = ?1")?.execute([id])?;
            conn.prepare_cached("DELETE FROM page_minhash_bands WHERE page_id = ?1")?.execute([id])?;
            return Ok(());
        }
        let blob = sig_blob(&signature(&sh));
        let old: Option<Vec<u8>> = conn
            .prepare_cached("SELECT sig FROM page_minhash WHERE page_id = ?1")?
            .query_row([id], |r| r.get(0))
            .optional()?;
        if old.as_deref() == Some(blob.as_slice()) {
            return Ok(());
        }
        conn.prepare_cached("INSERT OR REPLACE INTO page_minhash (page_id, sig, shingles) VALUES (?1, ?2, ?3)")?
            .execute(params![id, blob, sh.len() as i64])?;
        conn.prepare_cached("DELETE FROM page_minhash_bands WHERE page_id = ?1")?.execute([id])?;
        let mut ins =
            conn.prepare_cached("INSERT OR IGNORE INTO page_minhash_bands (band, page_id) VALUES (?1, ?2)")?;
        for b in bands(&blob_sig(&blob)) {
            ins.execute(params![b, id])?;
        }
        Ok(())
    }

    fn duplicate_ignored(&self) -> Result<HashSet<(i64, i64)>> {
        let mut st = self.conn().prepare_cached("SELECT a, b FROM duplicate_ignores")?;
        Ok(st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
    }

    /// Notes (no daily notes, no canvases) outside the trash: id, title and icon.
    fn duplicate_pages(&self) -> Result<Vec<(i64, String, Option<String>)>> {
        let mut st = self.conn().prepare_cached(
            "SELECT id, title, icon FROM pages WHERE deleted_at IS NULL AND daily_date IS NULL AND kind IS NULL",
        )?;
        Ok(st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?)
    }

    fn page_shingles(&self, id: i64) -> Result<Vec<u64>> {
        let content: String = self.conn().query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
        Ok(shingles(&content))
    }

    /// Likely duplicates of a page, most similar first (ignored pairs left out).
    pub fn duplicate_hints(&self, page_id: i64) -> Result<Vec<DuplicateHint>> {
        let page = self.page(page_id)?;
        if page.deleted_at.is_some() || page.daily_date.is_some() || self.is_canvas(page_id)? {
            return Ok(vec![]);
        }
        let ignored = self.duplicate_ignored()?;
        let conn = self.conn();
        let mut candidates: HashMap<i64, f64> = HashMap::new();
        {
            let mut st = conn.prepare_cached(
                "SELECT DISTINCT o.page_id FROM page_minhash_bands m JOIN page_minhash_bands o ON o.band = m.band
                 WHERE m.page_id = ?1 AND o.page_id <> ?1",
            )?;
            for id in st.query_map([page_id], |r| r.get::<_, i64>(0))? {
                candidates.insert(id?, 0.0);
            }
        }
        let norm = normalize_title(&page.title);
        let pages = self.duplicate_pages()?;
        let mut titles: HashMap<i64, f64> = HashMap::new();
        for (id, title, _) in &pages {
            if *id == page_id {
                continue;
            }
            let other = normalize_title(title);
            // Cheap length filter first: a Dice of 0.9 needs similar lengths.
            let (l1, l2) = (norm.chars().count() as f64, other.chars().count() as f64);
            if l1.min(l2) < 3.0 || (l1 - l2).abs() > 0.25 * l1.max(l2) {
                continue;
            }
            let s = title_similarity(&norm, &other);
            if s >= TITLE_THRESHOLD {
                titles.insert(*id, s);
                candidates.entry(*id).or_insert(0.0);
            }
        }
        if candidates.is_empty() {
            return Ok(vec![]);
        }
        let mine = self.page_shingles(page_id)?;
        let info: HashMap<i64, (&String, &Option<String>)> = pages.iter().map(|(id, t, i)| (*id, (t, i))).collect();
        let mut out = vec![];
        for (id, _) in candidates {
            let Some((title, icon)) = info.get(&id) else { continue };
            if ignored.contains(&pair(page_id, id)) {
                continue;
            }
            let text_score = jaccard(&mine, &self.page_shingles(id)?);
            let title_score = titles.get(&id).copied().unwrap_or(0.0);
            if text_score < TEXT_THRESHOLD && title_score < TITLE_THRESHOLD {
                continue;
            }
            out.push(DuplicateHint {
                page_id: id,
                title: (*title).clone(),
                icon: (*icon).clone(),
                score: text_score.max(title_score),
                text_score,
                title_score,
            });
        }
        out.sort_by(|a, b| b.score.total_cmp(&a.score).then(a.page_id.cmp(&b.page_id)));
        out.truncate(5);
        Ok(out)
    }

    /// „Doppelte Seiten finden“: all likely duplicate pairs, most similar first.
    pub fn all_duplicates(&self) -> Result<Vec<DuplicatePair>> {
        let pages = self.duplicate_pages()?;
        let info: HashMap<i64, &String> = pages.iter().map(|(id, t, _)| (*id, t)).collect();
        let ignored = self.duplicate_ignored()?;
        let conn = self.conn();
        let sigs: HashMap<i64, Vec<u32>> = {
            let mut st = conn.prepare("SELECT page_id, sig FROM page_minhash")?;
            st.query_map([], |r| Ok((r.get::<_, i64>(0)?, blob_sig(&r.get::<_, Vec<u8>>(1)?))))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut pairs: HashMap<(i64, i64), f64> = HashMap::new();
        {
            let mut st = conn.prepare(
                "SELECT group_concat(page_id) FROM page_minhash_bands GROUP BY band HAVING count(*) > 1 AND count(*) <= 50",
            )?;
            for ids in st.query_map([], |r| r.get::<_, String>(0))? {
                let ids: Vec<i64> = ids?.split(',').filter_map(|s| s.parse().ok()).collect();
                for (k, a) in ids.iter().enumerate() {
                    for b in &ids[k + 1..] {
                        pairs.entry(pair(*a, *b)).or_insert(0.0);
                    }
                }
            }
        }
        let mut by_title: HashMap<String, Vec<i64>> = HashMap::new();
        for (id, title, _) in &pages {
            let n = normalize_title(title);
            if n.chars().count() >= 3 {
                by_title.entry(n).or_default().push(*id);
            }
        }
        for ids in by_title.values().filter(|v| v.len() > 1) {
            for (k, a) in ids.iter().enumerate() {
                for b in &ids[k + 1..] {
                    pairs.insert(pair(*a, *b), 1.0);
                }
            }
        }
        let mut cache: HashMap<i64, Vec<u64>> = HashMap::new();
        let mut out = vec![];
        for ((a, b), title_score) in pairs {
            let (Some(at), Some(bt)) = (info.get(&a), info.get(&b)) else { continue };
            if ignored.contains(&(a, b)) {
                continue;
            }
            // The estimate decides which pairs are worth reading both texts for.
            if title_score < TITLE_THRESHOLD
                && sigs.get(&a).zip(sigs.get(&b)).is_none_or(|(x, y)| estimate(x, y) < TEXT_THRESHOLD - 0.15)
            {
                continue;
            }
            for id in [a, b] {
                if let std::collections::hash_map::Entry::Vacant(e) = cache.entry(id) {
                    e.insert(self.page_shingles(id)?);
                }
            }
            let text_score = jaccard(&cache[&a], &cache[&b]);
            if text_score < TEXT_THRESHOLD && title_score < TITLE_THRESHOLD {
                continue;
            }
            out.push(DuplicatePair {
                a,
                a_title: (*at).clone(),
                b,
                b_title: (*bt).clone(),
                score: text_score.max(title_score),
                text_score,
                title_score,
            });
        }
        out.sort_by(|x, y| y.score.total_cmp(&x.score).then(x.a.cmp(&y.a)).then(x.b.cmp(&y.b)));
        Ok(out)
    }

    /// „Ignorieren“: the two pages are not shown as duplicates again.
    pub fn ignore_duplicate(&self, a: i64, b: i64) -> Result<()> {
        let (a, b) = pair(a, b);
        self.conn().execute("INSERT OR IGNORE INTO duplicate_ignores (a, b) VALUES (?1, ?2)", params![a, b])?;
        Ok(())
    }

    /// „Zusammenführen“: appends `other`'s text to `keep` (below a heading with its title, its
    /// frontmatter tags as `#tags`), rewrites every `[[other]]` link to `[[keep]]`, moves its
    /// subpages below `keep` and puts `other` in the trash. All or nothing; undo with
    /// [`Database::undo_merge`].
    pub fn merge_pages(&self, keep: i64, other: i64) -> Result<MergeOutcome> {
        if keep == other {
            return Err(Error::State(
                tr!(
                    "Eine Seite lässt sich nicht mit sich selbst zusammenführen",
                    "A page cannot be merged with itself"
                )
                .into(),
            ));
        }
        let k = self.page(keep)?;
        let o = self.page(other)?;
        if k.deleted_at.is_some() || o.deleted_at.is_some() {
            return Err(Error::State(tr!("Die Seite liegt im Papierkorb", "The page is in the trash").into()));
        }
        if self.is_canvas(keep)? || self.is_canvas(other)? {
            return Err(Error::State(
                tr!("Canvas-Seiten lassen sich nicht zusammenführen", "Canvas pages cannot be merged").into(),
            ));
        }
        self.atomic(|| {
            let conn = self.conn();
            let now = chrono::Utc::now();
            let content_of = |id: i64| -> Result<String> {
                Ok(conn.query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?)
            };
            let keep_content = content_of(keep)?;
            let other_content = content_of(other)?;
            let mut contents: Vec<(i64, String)> = vec![(keep, keep_content.clone())];

            // Text and tags of the other page.
            let body = crate::embeds::without_frontmatter(&other_content).trim();
            let have: HashSet<String> = crate::notes::tags(&keep_content).into_iter().collect();
            let in_body: HashSet<String> = crate::notes::tags(body).into_iter().collect();
            let extra: Vec<String> = crate::notes::tags(&other_content)
                .into_iter()
                .filter(|t| !have.contains(t) && !in_body.contains(t))
                .map(|t| format!("#{t}"))
                .collect();
            let mut merged = keep_content.trim_end().to_owned();
            if !merged.is_empty() {
                merged.push_str("\n\n");
            }
            merged.push_str(&format!("## {}\n\n", o.title));
            if !body.is_empty() {
                merged.push_str(body);
                merged.push('\n');
            }
            if !extra.is_empty() {
                merged.push_str(&format!("\n{}\n", extra.join(" ")));
            }
            let merged = crate::notes::replace_link_target(&merged, &o.title, &k.title);

            // Links to the other page elsewhere.
            let sources: Vec<(i64, String)> = {
                let mut st = conn.prepare(
                    "SELECT p.id, p.content FROM page_links l JOIN pages p ON p.id = l.from_page
                     WHERE l.target = ?1 AND p.id NOT IN (?2, ?3) AND p.deleted_at IS NULL",
                )?;
                st.query_map(params![o.title.to_lowercase(), keep, other], |r| Ok((r.get(0)?, r.get(1)?)))?
                    .collect::<rusqlite::Result<_>>()?
            };
            let mut changed = vec![keep];
            for (pid, content) in sources {
                let updated = if self.is_canvas(pid)? {
                    crate::canvas::rename_page(&content, &o.title, &k.title)
                } else {
                    crate::notes::replace_link_target(&content, &o.title, &k.title)
                };
                if updated != content {
                    self.store_version(pid, &content, now)?;
                    self.save_page_content_at(pid, &updated, now)?;
                    contents.push((pid, content));
                    changed.push(pid);
                }
            }
            let relinked = changed.len() - 1;
            self.store_version(keep, &keep_content, now)?;
            self.save_page_content_at(keep, &merged, now)?;

            // Subpages stay: they move below the kept page.
            let children: Vec<(i64, i64)> = {
                let mut st =
                    conn.prepare("SELECT id, position FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL")?;
                st.query_map([other], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            let base: i64 = conn.query_row(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL",
                [keep],
                |r| r.get(0),
            )?;
            for (i, (cid, _)) in children.iter().enumerate() {
                conn.execute(
                    "UPDATE pages SET parent_id = ?2, position = ?3 WHERE id = ?1",
                    params![cid, keep, base + i as i64],
                )?;
            }
            self.trash_page(other)?;
            let undo = MergeUndo { keep, other, contents, children };
            self.meta_set(MERGE_UNDO, &serde_json::to_string(&undo)?)?;
            Ok(MergeOutcome { keep, other, relinked, changed })
        })
    }

    /// Undoes the last merge: the other page comes back from the trash with its subpages, and
    /// every page the merge changed gets its content from before (the merged state stays as a
    /// version). Returns the pages whose content changed.
    pub fn undo_merge(&self) -> Result<Vec<i64>> {
        let Some(raw) = self.meta_get(MERGE_UNDO)?.filter(|r| !r.is_empty()) else {
            return Err(Error::State(tr!("Nichts zum Rückgängigmachen", "Nothing to undo").into()));
        };
        let undo: MergeUndo = serde_json::from_str(&raw)?;
        self.atomic(|| {
            let conn = self.conn();
            let now = chrono::Utc::now();
            let other = self.page(undo.other)?;
            if other.deleted_at.is_some() {
                self.restore_page(undo.other)?;
            }
            for (cid, pos) in &undo.children {
                conn.execute(
                    "UPDATE pages SET parent_id = ?2, position = ?3 WHERE id = ?1",
                    params![cid, undo.other, pos],
                )?;
            }
            let mut changed = vec![];
            for (pid, content) in &undo.contents {
                let Ok(current) =
                    conn.query_row("SELECT content FROM pages WHERE id = ?1", [pid], |r| r.get::<_, String>(0))
                else {
                    continue;
                };
                if &current != content {
                    self.store_version(*pid, &current, now)?;
                    self.save_page_content_at(*pid, content, now)?;
                    changed.push(*pid);
                }
            }
            conn.execute("DELETE FROM settings WHERE key = ?1", [format!("meta.{MERGE_UNDO}")])?;
            Ok(changed)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEXT: &str = "Die Migration des Kundenservers auf die neue Plattform startet im November. \
        Vorher prüfen wir die Backups, die Zugänge und die Abhängigkeiten der Dienste. \
        Danach folgt ein Lasttest mit realistischen Daten und ein Rollback-Plan für den Notfall.";

    #[test]
    fn normalizes_titles() {
        assert_eq!(normalize_title("Übersicht: Größe (Kopie)"), "uebersicht groesse");
        assert_eq!(normalize_title("Meeting 2026-10-02"), "meeting");
        assert_eq!(normalize_title("Meeting 02.10.2026"), "meeting");
        assert_eq!(normalize_title("Projekt 2"), "projekt 2");
        assert_eq!(title_similarity("uebersicht", "uebersicht"), 1.0);
        assert!(title_similarity("kundenserver migration", "kundenserver migrationen") > 0.9);
        assert!(title_similarity("projekt alpha", "budget beta") < 0.3);
    }

    #[test]
    fn scores_text_similarity() {
        let a = shingles(TEXT);
        let b = shingles(&format!("{TEXT} Ein Satz mehr am Ende."));
        let c = shingles(
            "Ganz anderer Inhalt über Urlaubsplanung, Reisen nach Norwegen und das Wetter im Sommer dort oben.",
        );
        assert!(jaccard(&a, &b) > 0.8, "{}", jaccard(&a, &b));
        assert!(jaccard(&a, &c) < 0.05);
        // The MinHash estimate is close to the exact value.
        let est = estimate(&signature(&a), &signature(&b));
        assert!((est - jaccard(&a, &b)).abs() < 0.2, "{est}");
        assert_eq!(signature(&a), signature(&a.clone()));
    }

    #[test]
    fn finds_hints_incrementally_and_pairs() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Kundenserver Migration", None).unwrap();
        let b = db.create_page(None, "Migration Kundenserver Notizen", None).unwrap();
        let c = db.create_page(None, "Urlaub", None).unwrap();
        let d = db.create_page(None, "kundenserver-migration (Kopie)", None).unwrap();
        db.save_page_content(a.id, TEXT).unwrap();
        db.save_page_content(c.id, "Urlaub in Norwegen, Fjorde und Wanderungen, viel Regen und gutes Essen in Bergen.")
            .unwrap();
        assert!(db.duplicate_hints(a.id).unwrap().iter().all(|h| h.page_id != b.id));
        // Saving b updates the index: now a and b are duplicates.
        db.save_page_content(b.id, &format!("{TEXT} Ergänzung.")).unwrap();
        let hints = db.duplicate_hints(a.id).unwrap();
        let hb = hints.iter().find(|h| h.page_id == b.id).expect("text duplicate");
        assert!(hb.text_score > 0.8);
        // d by its title.
        let hd = hints.iter().find(|h| h.page_id == d.id).expect("title duplicate");
        assert_eq!(hd.title_score, 1.0);
        assert!(hints.iter().all(|h| h.page_id != c.id));

        let pairs = db.all_duplicates().unwrap();
        assert!(pairs.iter().any(|p| (p.a, p.b) == pair(a.id, b.id)));
        assert!(pairs.iter().any(|p| (p.a, p.b) == pair(a.id, d.id)));

        db.ignore_duplicate(b.id, a.id).unwrap();
        assert!(db.duplicate_hints(a.id).unwrap().iter().all(|h| h.page_id != b.id));
        assert!(db.all_duplicates().unwrap().iter().all(|p| (p.a, p.b) != pair(a.id, b.id)));
    }

    #[test]
    fn merges_moves_links_and_undoes() {
        let db = Database::open_in_memory().unwrap();
        let keep = db.create_page(None, "Server", None).unwrap();
        let other = db.create_page(None, "Server alt", None).unwrap();
        let child = db.create_page(Some(other.id), "Unterseite", None).unwrap();
        let src = db.create_page(None, "Log", None).unwrap();
        db.save_page_content(keep.id, "Neuer Stand.").unwrap();
        db.save_page_content(other.id, "---\ntags: [infra]\n---\nAlter Stand mit [[Server alt#Teil]].").unwrap();
        db.save_page_content(src.id, "Siehe [[Server alt]] und [[server alt|den alten]].").unwrap();

        let out = db.merge_pages(keep.id, other.id).unwrap();
        assert_eq!(out.relinked, 1);
        let kept = db.page_doc(keep.id).unwrap();
        assert_eq!(kept.content, "Neuer Stand.\n\n## Server alt\n\nAlter Stand mit [[Server#Teil]].\n\n#infra\n");
        assert_eq!(db.page_doc(src.id).unwrap().content, "Siehe [[Server]] und [[Server|den alten]].");
        assert_eq!(kept.backlinks.len(), 1, "the backlinks moved to the kept page");
        assert!(db.page(other.id).unwrap().deleted_at.is_some());
        assert_eq!(db.page(child.id).unwrap().parent_id, Some(keep.id));
        assert!(db.page(child.id).unwrap().deleted_at.is_none());

        let changed = db.undo_merge().unwrap();
        assert!(changed.contains(&keep.id) && changed.contains(&src.id));
        assert_eq!(db.page_doc(keep.id).unwrap().content, "Neuer Stand.");
        assert_eq!(db.page_doc(src.id).unwrap().content, "Siehe [[Server alt]] und [[server alt|den alten]].");
        assert!(db.page(other.id).unwrap().deleted_at.is_none());
        assert_eq!(db.page(child.id).unwrap().parent_id, Some(other.id));
        assert_eq!(db.page_doc(other.id).unwrap().backlinks.len(), 1);
        assert!(db.undo_merge().is_err(), "undo works once");
        assert!(db.merge_pages(keep.id, keep.id).is_err());
    }
}
