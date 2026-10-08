//! Three-way merge of Markdown notes at block granularity, used when a Git sync pulls a
//! note that was also changed locally.
//!
//! A note is split into blocks of whole lines: a heading, a list item (with its continuation
//! lines), a paragraph, a fenced code block, the front matter. Blank lines stay with the
//! block before them, so joining the blocks gives back the exact text. The blocks of both
//! versions are matched against the common base (longest common subsequence, compared
//! without trailing whitespace); between blocks all three share, a region changed on one
//! side only is taken from that side, the same change on both sides is taken once, and
//! different changes are a conflict the user decides. Without a base (the file was added on
//! both sides) every difference is a conflict.

use serde::{Deserialize, Serialize};

/// One piece of the merged note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Chunk {
    /// Unchanged on both sides.
    Stable { text: String },
    /// Changed on one side only, or the same way on both: taken without asking.
    Merged { text: String, from: Side },
    /// Changed differently on both sides.
    Conflict { base: Option<String>, mine: String, theirs: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Side {
    Mine,
    Theirs,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeResult {
    pub chunks: Vec<Chunk>,
    pub conflicts: usize,
}

impl MergeResult {
    /// The merged text when nothing is left to decide.
    pub fn merged(&self) -> Option<String> {
        (self.conflicts == 0).then(|| self.resolve(|_, _, _| unreachable!()))
    }

    /// The text with every conflict replaced by `pick(base, mine, theirs)`.
    pub fn resolve(&self, mut pick: impl FnMut(Option<&str>, &str, &str) -> String) -> String {
        let mut out = String::new();
        for c in &self.chunks {
            match c {
                Chunk::Stable { text } | Chunk::Merged { text, .. } => out.push_str(text),
                Chunk::Conflict { base, mine, theirs } => out.push_str(&pick(base.as_deref(), mine, theirs)),
            }
        }
        out
    }
}

fn is_fence(line: &str) -> Option<&'static str> {
    let t = line.trim_start();
    if t.starts_with("```") {
        Some("```")
    } else if t.starts_with("~~~") {
        Some("~~~")
    } else {
        None
    }
}

fn is_heading(line: &str) -> bool {
    let t = line.trim_start();
    let hashes = t.bytes().take_while(|&b| b == b'#').count();
    let rest = &t[hashes..];
    (1..=6).contains(&hashes) && (rest.trim().is_empty() || rest.starts_with([' ', '\t']))
}

fn is_list_item(line: &str) -> bool {
    let t = line.trim_start();
    if let Some(rest) = t.strip_prefix(['-', '*', '+']) {
        return rest.starts_with([' ', '\t']);
    }
    let digits = t.bytes().take_while(u8::is_ascii_digit).count();
    (1..=9).contains(&digits) && (t[digits..].starts_with(". ") || t[digits..].starts_with(") "))
}

fn is_rule(line: &str) -> bool {
    let t: String = line.chars().filter(|c| !c.is_whitespace()).collect();
    t.len() >= 3 && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_'))
}

/// Splits Markdown into blocks of whole lines (see the module docs). `blocks(s).concat() == s`.
pub fn blocks(markdown: &str) -> Vec<String> {
    let lines: Vec<&str> = markdown.split_inclusive('\n').collect();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    // Front matter: `---` on the first line up to the closing `---`.
    if lines.first().is_some_and(|l| l.trim_end() == "---")
        && let Some(end) = lines.iter().skip(1).position(|l| l.trim_end() == "---")
    {
        out.push(lines[..end + 2].concat());
        i = end + 2;
    }
    // Whether the current block may take more lines (a paragraph or a list item).
    let mut open = false;
    while i < lines.len() {
        let line = lines[i];
        if line.trim().is_empty() {
            // Blank lines stay with the block before them (or start the note).
            match out.last_mut() {
                Some(last) => last.push_str(line),
                None => out.push(line.to_owned()),
            }
            open = false;
            i += 1;
            continue;
        }
        if let Some(fence) = is_fence(line) {
            let mut block = line.to_owned();
            i += 1;
            while i < lines.len() {
                block.push_str(lines[i]);
                i += 1;
                if lines[i - 1].trim_start().starts_with(fence) {
                    break;
                }
            }
            out.push(block);
            open = false;
            continue;
        }
        let starts_block = is_heading(line) || is_list_item(line) || is_rule(line);
        if open && !starts_block {
            out.last_mut().expect("open block").push_str(line);
        } else {
            out.push(line.to_owned());
            open = !is_heading(line) && !is_rule(line);
        }
        i += 1;
    }
    out
}

/// Key a block is compared by: trailing whitespace and blank lines do not count.
fn key(block: &str) -> &str {
    block.trim_end()
}

/// Index pairs of a longest common subsequence of `a` and `b` (by key).
fn lcs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
    let (n, m) = (a.len(), b.len());
    // Common prefix and suffix first: most merges touch a few blocks of a long note.
    let mut pre = 0;
    while pre < n && pre < m && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < n - pre && suf < m - pre && a[n - 1 - suf] == b[m - 1 - suf] {
        suf += 1;
    }
    let (a_mid, b_mid) = (&a[pre..n - suf], &b[pre..m - suf]);
    let (h, w) = (a_mid.len(), b_mid.len());
    let mut table = vec![0u32; (h + 1) * (w + 1)];
    for i in (0..h).rev() {
        for j in (0..w).rev() {
            table[i * (w + 1) + j] = if a_mid[i] == b_mid[j] {
                table[(i + 1) * (w + 1) + j + 1] + 1
            } else {
                table[(i + 1) * (w + 1) + j].max(table[i * (w + 1) + j + 1])
            };
        }
    }
    let mut out: Vec<(usize, usize)> = (0..pre).map(|i| (i, i)).collect();
    let (mut i, mut j) = (0, 0);
    while i < h && j < w {
        if a_mid[i] == b_mid[j] {
            out.push((pre + i, pre + j));
            i += 1;
            j += 1;
        } else if table[(i + 1) * (w + 1) + j] >= table[i * (w + 1) + j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    out.extend((0..suf).map(|k| (n - suf + k, m - suf + k)));
    out
}

fn join(blocks: &[String]) -> String {
    blocks.concat()
}

fn same(a: &[String], b: &[String]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| key(x) == key(y))
}

/// Merges `mine` and `theirs` against their common `base` (see the module docs).
pub fn merge3(base: Option<&str>, mine: &str, theirs: &str) -> MergeResult {
    let (m, t) = (blocks(mine), blocks(theirs));
    let mk: Vec<&str> = m.iter().map(|b| key(b)).collect();
    let tk: Vec<&str> = t.iter().map(|b| key(b)).collect();
    let mut chunks: Vec<Chunk> = Vec::new();
    let mut push = |c: Chunk| {
        // Neighbouring pieces of the same kind read as one.
        match (chunks.last_mut(), &c) {
            (Some(Chunk::Stable { text }), Chunk::Stable { text: more }) => text.push_str(more),
            _ => chunks.push(c),
        }
    };

    let Some(base) = base else {
        // Two-way: blocks both have are kept, every other difference is a conflict.
        let pairs = lcs(&mk, &tk);
        let (mut mi, mut ti) = (0, 0);
        for &(a, b) in pairs.iter().chain(std::iter::once(&(m.len(), t.len()))) {
            let (ms, ts) = (&m[mi..a], &t[ti..b]);
            if !ms.is_empty() || !ts.is_empty() {
                push(Chunk::Conflict { base: None, mine: join(ms), theirs: join(ts) });
            }
            if a < m.len() {
                push(Chunk::Stable { text: m[a].clone() });
            }
            (mi, ti) = (a + 1, b + 1);
        }
        return finish(chunks);
    };

    let b = blocks(base);
    let bk: Vec<&str> = b.iter().map(|x| key(x)).collect();
    // Base blocks unchanged on both sides are the anchors; the regions between are merged.
    let to_mine: std::collections::HashMap<usize, usize> = lcs(&bk, &mk).into_iter().collect();
    let to_theirs: std::collections::HashMap<usize, usize> = lcs(&bk, &tk).into_iter().collect();
    let mut anchors: Vec<(usize, usize, usize)> =
        (0..b.len()).filter_map(|i| Some((i, *to_mine.get(&i)?, *to_theirs.get(&i)?))).collect();
    anchors.push((b.len(), m.len(), t.len()));
    let (mut bi, mut mi, mut ti) = (0, 0, 0);
    for (ab, am, at) in anchors {
        let (bs, ms, ts) = (&b[bi..ab], &m[mi..am], &t[ti..at]);
        if !(bs.is_empty() && ms.is_empty() && ts.is_empty()) {
            if same(ms, bs) {
                if !ts.is_empty() {
                    push(Chunk::Merged { text: join(ts), from: Side::Theirs });
                }
            } else if same(ts, bs) {
                if !ms.is_empty() {
                    push(Chunk::Merged { text: join(ms), from: Side::Mine });
                }
            } else if same(ms, ts) {
                if !ms.is_empty() {
                    push(Chunk::Merged { text: join(ms), from: Side::Both });
                }
            } else {
                push(Chunk::Conflict { base: Some(join(bs)), mine: join(ms), theirs: join(ts) });
            }
        }
        if ab < b.len() {
            // Both sides have the block (same key); the one with more trailing blank lines is
            // kept, so a block the other side added after it does not run into it.
            let text = if t[at].len() > m[am].len() { &t[at] } else { &m[am] };
            push(Chunk::Stable { text: text.clone() });
        }
        (bi, mi, ti) = (ab + 1, am + 1, at + 1);
    }
    finish(chunks)
}

fn finish(chunks: Vec<Chunk>) -> MergeResult {
    let conflicts = chunks.iter().filter(|c| matches!(c, Chunk::Conflict { .. })).count();
    MergeResult { chunks, conflicts }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "---\ntags: [a]\n---\n# Titel\n\nErster Absatz\nmit zwei Zeilen.\n\n- Punkt eins\n- Punkt zwei\n  weiter\n- [ ] Aufgabe\n\n```rust\nfn main() {\n\n}\n```\n\n## Ende\n\nLetzter Absatz.\n";

    #[test]
    fn blocks_round_trip_and_split_by_kind() {
        let b = blocks(BASE);
        assert_eq!(b.concat(), BASE);
        assert_eq!(
            b.iter().map(|x| x.trim_end()).collect::<Vec<_>>(),
            [
                "---\ntags: [a]\n---",
                "# Titel",
                "Erster Absatz\nmit zwei Zeilen.",
                "- Punkt eins",
                "- Punkt zwei\n  weiter",
                "- [ ] Aufgabe",
                "```rust\nfn main() {\n\n}\n```",
                "## Ende",
                "Letzter Absatz.",
            ]
        );
        for s in ["", "\n\n", "ohne Zeilenende", "1. eins\n2) zwei\n10. zehn\n---\n#hashtag\n"] {
            assert_eq!(blocks(s).concat(), s);
        }
        assert_eq!(blocks("1. eins\n2) zwei\n").len(), 2);
        assert_eq!(blocks("#hashtag am Anfang\nweiter\n").len(), 1, "a tag is not a heading");
        // An unclosed fence runs to the end.
        assert_eq!(blocks("```\ncode\n\n# kein Titel\n").len(), 1);
    }

    #[test]
    fn identical_and_unchanged_versions_merge_cleanly() {
        let r = merge3(Some(BASE), BASE, BASE);
        assert_eq!(r.conflicts, 0);
        assert_eq!(r.merged().unwrap(), BASE);
        let changed = BASE.replace("Letzter Absatz.", "Letzter Absatz, geändert.");
        let r = merge3(Some(BASE), &changed, &changed);
        assert_eq!(r.merged().unwrap(), changed);
        assert!(r.chunks.iter().any(|c| matches!(c, Chunk::Merged { from: Side::Both, .. })));
    }

    #[test]
    fn one_sided_changes_merge_without_asking() {
        let mine = BASE.replace("- Punkt eins\n", "- Punkt eins (meins)\n");
        let theirs = BASE
            .replace("Letzter Absatz.", "Letzter Absatz vom Server.")
            .replace("## Ende\n", "## Ende\n\nNeu vom Server.\n");
        let r = merge3(Some(BASE), &mine, &theirs);
        assert_eq!(r.conflicts, 0, "{:#?}", r.chunks);
        let merged = r.merged().unwrap();
        assert!(merged.contains("- Punkt eins (meins)\n"));
        assert!(merged.contains("Neu vom Server.\n\nLetzter Absatz vom Server."), "{merged}");
        assert!(r.chunks.iter().any(|c| matches!(c, Chunk::Merged { from: Side::Mine, .. })));
        assert!(r.chunks.iter().any(|c| matches!(c, Chunk::Merged { from: Side::Theirs, .. })));

        // A deletion on one side and an unrelated addition on the other.
        let mine = BASE.replace("- [ ] Aufgabe\n", "");
        let theirs = format!("{BASE}\nAnhang vom Server.\n");
        let merged = merge3(Some(BASE), &mine, &theirs).merged().unwrap();
        assert!(!merged.contains("Aufgabe") && merged.ends_with("Anhang vom Server.\n"), "{merged}");
    }

    #[test]
    fn different_changes_to_one_block_are_a_conflict() {
        let mine = BASE.replace("Erster Absatz\nmit zwei Zeilen.", "Erster Absatz, meine Fassung.");
        let theirs = BASE.replace("Erster Absatz\nmit zwei Zeilen.", "Erster Absatz, Fassung vom Server.");
        let r = merge3(Some(BASE), &mine, &theirs);
        assert_eq!(r.conflicts, 1);
        let Some(Chunk::Conflict { base, mine: m, theirs: t }) =
            r.chunks.iter().find(|c| matches!(c, Chunk::Conflict { .. }))
        else {
            panic!()
        };
        assert_eq!(base.as_deref(), Some("Erster Absatz\nmit zwei Zeilen.\n\n"));
        assert_eq!(
            (m.trim_end(), t.trim_end()),
            ("Erster Absatz, meine Fassung.", "Erster Absatz, Fassung vom Server.")
        );
        assert!(r.merged().is_none());
        // Everything around the conflict is kept; choosing a side gives a whole note.
        let mine_all = r.resolve(|_, m, _| m.to_owned());
        assert_eq!(mine_all, mine);
        assert_eq!(r.resolve(|_, _, t| t.to_owned()), theirs);
        let both = r.resolve(|_, m, t| format!("{m}{t}"));
        assert!(both.contains("meine Fassung.\n\nErster Absatz, Fassung vom Server."), "{both}");
    }

    #[test]
    fn conflicts_and_clean_changes_mix() {
        let mine = BASE.replace("# Titel", "# Titel (meins)").replace("Letzter Absatz.", "Letzter Absatz A.");
        let theirs = BASE
            .replace("# Titel", "# Titel (Server)")
            .replace("- Punkt zwei\n  weiter\n", "- Punkt zwei\n  weiter vom Server\n");
        let r = merge3(Some(BASE), &mine, &theirs);
        assert_eq!(r.conflicts, 1);
        let text = r.resolve(|_, m, _| m.to_owned());
        assert!(
            text.contains("# Titel (meins)")
                && text.contains("weiter vom Server")
                && text.contains("Letzter Absatz A.")
        );
    }

    #[test]
    fn deletion_against_edit_is_a_conflict() {
        let mine = BASE.replace("Letzter Absatz.\n", "");
        let theirs = BASE.replace("Letzter Absatz.", "Letzter Absatz, bearbeitet.");
        let r = merge3(Some(BASE), &mine, &theirs);
        assert_eq!(r.conflicts, 1);
        let Some(Chunk::Conflict { mine: m, theirs: t, .. }) = r.chunks.last() else { panic!("{:#?}", r.chunks) };
        assert_eq!((m.as_str(), t.trim_end()), ("", "Letzter Absatz, bearbeitet."));
    }

    #[test]
    fn trailing_blank_lines_do_not_conflict() {
        let mine = BASE.replace("Letzter Absatz.\n", "Letzter Absatz.\n\n\n");
        let theirs = BASE.replace("# Titel", "# Neuer Titel");
        let r = merge3(Some(BASE), &mine, &theirs);
        assert_eq!(r.conflicts, 0, "{:#?}", r.chunks);
        assert!(r.merged().unwrap().starts_with("---\ntags: [a]\n---\n# Neuer Titel\n"));
    }

    #[test]
    fn a_block_appended_after_the_last_one_stays_a_paragraph_of_its_own() {
        let base = "# A\n\nEins.\n\nZwei.\n";
        let mine = "# A\n\nEins, meins.\n\nZwei.\n";
        let theirs = "# A\n\nEins.\n\nZwei.\n\nDrei vom Server.\n";
        let r = merge3(Some(base), mine, theirs);
        assert_eq!(r.merged().unwrap(), "# A\n\nEins, meins.\n\nZwei.\n\nDrei vom Server.\n");
    }

    #[test]
    fn without_a_base_every_difference_is_a_conflict() {
        let r = merge3(None, "# A\n\nGleich\n\nNur meins\n", "# A\n\nGleich\n\nNur deren\n");
        assert_eq!(r.conflicts, 1);
        assert_eq!(r.chunks[0], Chunk::Stable { text: "# A\n\nGleich\n\n".into() });
        assert_eq!(
            r.resolve(|b, m, t| format!("{}{m}{t}", b.unwrap_or(""))),
            "# A\n\nGleich\n\nNur meins\nNur deren\n"
        );
        let r = merge3(None, "gleich\n", "gleich\n");
        assert_eq!(r.merged().as_deref(), Some("gleich\n"));
        // An addition on one side is still a conflict (without a base it could be a deletion).
        assert_eq!(merge3(None, "a\n\nb\n", "a\n").conflicts, 1);
    }

    #[test]
    fn empty_sides() {
        assert_eq!(merge3(Some(""), "", "").merged().as_deref(), Some(""));
        assert_eq!(merge3(Some(""), "neu\n", "").merged().as_deref(), Some("neu\n"));
        assert_eq!(merge3(Some("alt\n"), "", "alt\n").merged().as_deref(), Some(""));
        assert_eq!(merge3(Some(""), "a\n", "b\n").conflicts, 1);
    }
}
