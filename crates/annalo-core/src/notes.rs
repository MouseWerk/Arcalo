//! Markdown documents: saving, chunk index, [[wiki links]], backlinks, tags,
//! renames that keep links intact, daily notes and the page tree.

use std::collections::HashMap;

use chrono::NaiveDate;
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::model::Page;

/// Target size of a search/RAG chunk in characters.
const CHUNK_CHARS: usize = 1200;
/// Parent page that holds daily notes.
pub const JOURNAL_TITLE: &str = "Journal";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Backlink {
    pub page_id: i64,
    pub title: String,
    pub icon: Option<String>,
    /// The line of the source page that contains the link.
    pub context: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageDoc {
    #[serde(flatten)]
    pub page: Page,
    pub content: String,
    pub tags: Vec<String>,
    pub backlinks: Vec<Backlink>,
    /// Outgoing links whose target page does not exist yet.
    pub unresolved_links: Vec<String>,
}

/// What a save returns: the facts the save derived, not the content (the caller has it) and
/// not the backlinks (other pages' links, which a save of this page does not change).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedPage {
    pub id: i64,
    pub updated_at: String,
    pub tags: Vec<String>,
    /// Outgoing links whose target page does not exist yet.
    pub unresolved_links: Vec<String>,
}

// ------------------------------------------------------------------ parsing

/// Lines outside fenced code blocks, with their fence state resolved.
fn prose_lines(markdown: &str) -> impl Iterator<Item = &str> {
    let mut in_fence = false;
    markdown.lines().filter(move |l| {
        if l.trim_start().starts_with("```") {
            in_fence = !in_fence;
            return false;
        }
        !in_fence
    })
}

/// Removes `inline code` spans so links/tags inside them are ignored.
fn strip_inline_code(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut in_code = false;
    for c in line.chars() {
        if c == '`' {
            in_code = !in_code;
        } else if !in_code {
            out.push(c);
        }
    }
    out
}

/// Link targets of `[[Target]]`, `[[Target|Alias]]` and `[[Target#Heading]]`.
pub fn wiki_links(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    // Lower-cased targets already in `out` (a long note has thousands of links).
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for line in prose_lines(markdown) {
        if !line.contains("[[") {
            continue;
        }
        let line = strip_inline_code(line);
        let mut rest = line.as_str();
        while let Some(start) = rest.find("[[") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("]]") else { break };
            let inner = &after[..end];
            let target = inner.split(['|', '#']).next().unwrap_or("").trim();
            // `![[bild.png]]`, `![[x.excalidraw]]`, `![[doc.pdf]]` embed an attachment, they do not link a page.
            let embed = rest[..start].ends_with('!') && crate::attachments::embeddable(target);
            if !embed && !target.is_empty() && seen.insert(target.to_lowercase()) {
                out.push(target.to_owned());
            }
            rest = &after[end + 2..];
        }
    }
    out
}

fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '-' | '/')
}

/// `tags:` of a YAML frontmatter block (Obsidian: `tags: [a, b]`, `tags: a, b` or a `- a` list).
fn frontmatter_tags(markdown: &str) -> Vec<String> {
    let Some(rest) = markdown.strip_prefix("---\n").or_else(|| markdown.strip_prefix("---\r\n")) else { return vec![] };
    let Some(end) = rest.lines().position(|l| l.trim_end() == "---") else { return vec![] };
    let lines: Vec<&str> = rest.lines().take(end).collect();
    let mut out = vec![];
    let mut push = |raw: &str| {
        let t = raw.trim().trim_matches(['"', '\'']).trim_start_matches('#').to_lowercase();
        if !t.is_empty() && t.chars().all(is_tag_char) && !out.contains(&t) {
            out.push(t);
        }
    };
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        if let Some(value) = line.strip_prefix("tags:").or_else(|| line.strip_prefix("tag:")) {
            let value = value.trim().trim_start_matches('[').trim_end_matches(']');
            value.split([',', ' ']).filter(|v| !v.trim().is_empty()).for_each(&mut push);
            while i + 1 < lines.len() && lines[i + 1].trim_start().starts_with("- ") {
                i += 1;
                push(&lines[i].trim_start()[2..]);
            }
        }
        i += 1;
    }
    out
}

/// `#tags` in prose (not headings, not code, not purely numeric like `#1`) and frontmatter `tags:`.
pub fn tags(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = frontmatter_tags(markdown);
    for line in prose_lines(markdown) {
        if !line.contains('#') {
            continue;
        }
        let line = strip_inline_code(line);
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            let boundary = i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(';
            if chars[i] == '#' && boundary && i + 1 < chars.len() && is_tag_char(chars[i + 1]) {
                let mut j = i + 1;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect::<String>().trim_end_matches(['-', '/']).to_owned();
                if !tag.is_empty() && !tag.chars().all(|c| c.is_ascii_digit()) {
                    let lower = tag.to_lowercase();
                    if !out.contains(&lower) {
                        out.push(lower);
                    }
                }
                i = j;
            } else {
                i += 1;
            }
        }
    }
    out
}

/// Splits a document into search/RAG chunks: a new chunk starts at every
/// heading, and long sections are split at paragraph boundaries. Fenced code
/// blocks are never split.
pub fn chunks(markdown: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut para = String::new();
    let mut in_fence = false;

    let flush_para = |cur: &mut String, para: &mut String, out: &mut Vec<String>| {
        if para.trim().is_empty() {
            para.clear();
            return;
        }
        if !cur.is_empty() && cur.len() + para.len() > CHUNK_CHARS {
            out.push(std::mem::take(cur).trim().to_owned());
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para.trim_end());
        para.clear();
    };

    for line in markdown.lines() {
        let fence = line.trim_start().starts_with("```");
        if !in_fence && !fence && line.starts_with('#') && line.trim_start_matches('#').starts_with(' ') {
            flush_para(&mut cur, &mut para, &mut out);
            if !cur.trim().is_empty() {
                out.push(std::mem::take(&mut cur).trim().to_owned());
            }
            cur.clear();
        }
        if fence {
            in_fence = !in_fence;
        }
        if !in_fence && !fence && line.trim().is_empty() {
            flush_para(&mut cur, &mut para, &mut out);
        } else {
            para.push_str(line);
            para.push('\n');
        }
    }
    flush_para(&mut cur, &mut para, &mut out);
    if !cur.trim().is_empty() {
        out.push(cur.trim().to_owned());
    }
    out
}

// ---------------------------------------------------------------- documents

/// Makes the rows `(id, value)` of a derived table equal `wanted`: removes the ones no longer
/// wanted and inserts the new ones, leaving the rest untouched.
fn sync_rows(db: &Database, id: i64, wanted: &[String], select: &str, delete: &str, insert: &str) -> Result<()> {
    let conn = db.conn();
    let have: std::collections::HashSet<String> =
        conn.prepare_cached(select)?.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let want: std::collections::HashSet<&str> = wanted.iter().map(String::as_str).collect();
    let mut del = conn.prepare_cached(delete)?;
    for gone in have.iter().filter(|h| !want.contains(h.as_str())) {
        del.execute(params![id, gone])?;
    }
    let mut ins = conn.prepare_cached(insert)?;
    for new in wanted.iter().filter(|w| !have.contains(*w)) {
        ins.execute(params![id, new])?;
    }
    Ok(())
}

impl Database {
    /// Saves a page's Markdown and refreshes its chunks, links and tags. The previous
    /// content may be kept as a version (see [`crate::versions`]).
    pub fn save_page_content(&self, id: i64, content: &str) -> Result<()> {
        self.save_page_content_at(id, content, chrono::Utc::now())
    }

    pub(crate) fn save_page_content_at(
        &self,
        id: i64,
        content: &str,
        now: chrono::DateTime<chrono::Utc>,
    ) -> Result<()> {
        self.atomic(|| {
            let old: Option<String> =
                self.conn().query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0)).optional()?;
            let Some(old) = old else { return Err(Error::not_found("page", id.to_string())) };
            self.snapshot_before_save(id, &old, content, now)?;
            self.conn().execute(
                "UPDATE pages SET content = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, content, crate::db::ts(now)],
            )?;
            self.reindex_page(id, content)?;
            self.feed_page_saved(id, &old, content, now)
        })
    }

    /// Saves like [`Database::save_page_content`] and returns what the editor shows of the
    /// save: tags, unresolved links and the new time (no content, no backlinks).
    pub fn save_page(&self, id: i64, content: &str) -> Result<SavedPage> {
        self.save_page_content(id, content)?;
        let updated_at: String =
            self.conn().query_row("SELECT updated_at FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
        Ok(SavedPage {
            id,
            updated_at,
            tags: self.page_tags(id)?,
            unresolved_links: self.unresolved_links(wiki_links(content))?,
        })
    }

    /// Rebuilds chunk rows, links, tags and tasks of one page. Only what changed is written:
    /// chunks whose text is still on the page keep their row (and so their search entry and
    /// embedding), so editing a long note rewrites and re-embeds only the edited section.
    pub(crate) fn reindex_page(&self, id: i64, content: &str) -> Result<()> {
        let conn = self.conn();
        // Old chunk rows by text (a text may occur more than once).
        let mut old: HashMap<String, Vec<(i64, i64)>> = HashMap::new();
        {
            let mut st = conn.prepare_cached(
                "SELECT id, position, content_markdown FROM notes_blocks WHERE page_id = ?1 ORDER BY position DESC, id DESC",
            )?;
            for row in st.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?)))? {
                let (row_id, pos, text) = row?;
                old.entry(text).or_default().push((row_id, pos));
            }
        }
        let mut fresh: Vec<(i64, String)> = vec![];
        {
            let mut mv = conn.prepare_cached("UPDATE notes_blocks SET position = ?2 WHERE id = ?1")?;
            for (i, chunk) in chunks(content).into_iter().enumerate() {
                match old.get_mut(&chunk).and_then(|rows| rows.pop()) {
                    Some((_, pos)) if pos == i as i64 => {}
                    Some((row_id, _)) => {
                        mv.execute(params![row_id, i as i64])?;
                    }
                    None => fresh.push((i as i64, chunk)),
                }
            }
        }
        {
            let mut del = conn.prepare_cached("DELETE FROM notes_blocks WHERE id = ?1")?;
            for (row_id, _) in old.into_values().flatten() {
                del.execute([row_id])?;
            }
            let mut ins = conn.prepare_cached(
                "INSERT INTO notes_blocks (page_id, position, block_type, content_markdown) VALUES (?1, ?2, 'chunk', ?3)",
            )?;
            for (pos, chunk) in fresh {
                ins.execute(params![id, pos, chunk])?;
            }
        }
        // Links and tags: only added and removed rows.
        let links: Vec<String> = wiki_links(content).into_iter().map(|t| t.to_lowercase()).collect();
        sync_rows(
            self,
            id,
            &links,
            "SELECT target FROM page_links WHERE from_page = ?1",
            "DELETE FROM page_links WHERE from_page = ?1 AND target = ?2",
            "INSERT OR IGNORE INTO page_links (from_page, target) VALUES (?1, ?2)",
        )?;
        sync_rows(
            self,
            id,
            &tags(content),
            "SELECT tag FROM page_tags WHERE page_id = ?1",
            "DELETE FROM page_tags WHERE page_id = ?1 AND tag = ?2",
            "INSERT OR IGNORE INTO page_tags (page_id, tag) VALUES (?1, ?2)",
        )?;
        self.reindex_tasks(id, content)
    }

    /// The link targets among `targets` that name no page (outside the trash), in their
    /// order. One indexed query for all of them (not one per link); titles that differ only
    /// beyond ASCII case (`[[übersicht]]` → „Übersicht“) are matched like [`Database::page_by_title`].
    pub fn unresolved_links(&self, targets: Vec<String>) -> Result<Vec<String>> {
        if targets.is_empty() {
            return Ok(targets);
        }
        let conn = self.conn();
        let mut found: std::collections::HashSet<String> = std::collections::HashSet::new();
        // Well below SQLite's limit of bound parameters.
        for part in targets.chunks(500) {
            let marks = vec!["?"; part.len()].join(",");
            let mut st = conn.prepare_cached(&format!(
                "SELECT title FROM pages WHERE deleted_at IS NULL AND title COLLATE NOCASE IN ({marks})"
            ))?;
            let titles =
                st.query_map(rusqlite::params_from_iter(part.iter().map(|t| t.trim())), |r| r.get::<_, String>(0))?;
            for t in titles {
                found.insert(t?.to_lowercase());
            }
        }
        let mut missing: Vec<String> =
            targets.into_iter().filter(|t| !found.contains(&t.trim().to_lowercase())).collect();
        if missing.iter().any(|t| !t.trim().is_ascii()) {
            // SQLite's NOCASE folds ASCII only: compare the other titles once, in Rust.
            let mut st = conn.prepare_cached("SELECT title FROM pages WHERE deleted_at IS NULL")?;
            let all: std::collections::HashSet<String> =
                st.query_map([], |r| r.get::<_, String>(0))?.filter_map(|t| t.ok()).map(|t| t.to_lowercase()).collect();
            missing.retain(|t| {
                let needle = t.trim().to_lowercase();
                needle.is_ascii() || !all.contains(&needle)
            });
        }
        Ok(missing)
    }

    /// Rebuilds the derived indexes of every page (used after migrating).
    pub fn reindex_all(&self) -> Result<()> {
        let pages: Vec<(i64, String)> = {
            let mut st = self.conn().prepare("SELECT id, content FROM pages")?;
            st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
        };
        self.atomic(|| {
            for (id, content) in &pages {
                self.reindex_page(*id, content)?;
            }
            Ok(())
        })
    }

    pub fn page(&self, id: i64) -> Result<Page> {
        self.conn()
            .query_row(&format!("SELECT {} FROM pages WHERE id = ?1", crate::db::PAGE_COLS), [id], crate::db::map_page)
            .optional()?
            .ok_or_else(|| Error::not_found("page", id.to_string()))
    }

    pub fn page_by_title(&self, title: &str) -> Result<Option<Page>> {
        let found = self
            .conn()
            .query_row(
                &format!(
                    "SELECT {} FROM pages WHERE title = ?1 COLLATE NOCASE AND deleted_at IS NULL ORDER BY id LIMIT 1",
                    crate::db::PAGE_COLS
                ),
                [title.trim()],
                crate::db::map_page,
            )
            .optional()?;
        match found {
            Some(p) => Ok(Some(p)),
            None => self.page_by_title_unicode(title),
        }
    }

    /// SQLite's NOCASE only folds ASCII; `[[übersicht]]` must still find „Übersicht“.
    fn page_by_title_unicode(&self, title: &str) -> Result<Option<Page>> {
        let needle = title.trim().to_lowercase();
        if needle.is_ascii() {
            return Ok(None);
        }
        let conn = self.conn();
        let mut st = conn.prepare_cached("SELECT id, title FROM pages WHERE deleted_at IS NULL ORDER BY id")?;
        let id = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .find(|(_, t)| t.to_lowercase() == needle)
            .map(|(id, _)| id);
        id.map(|id| self.page(id)).transpose()
    }

    pub fn page_tags(&self, id: i64) -> Result<Vec<String>> {
        let mut st = self.conn().prepare_cached("SELECT tag FROM page_tags WHERE page_id = ?1 ORDER BY tag")?;
        Ok(st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?)
    }

    pub fn page_doc(&self, id: i64) -> Result<PageDoc> {
        let page = self.page(id)?;
        let tags = self.page_tags(id)?;
        let conn = self.conn();
        let content: String = conn.query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?;
        let backlinks = {
            let mut st = conn.prepare_cached(
                "SELECT p.id, p.title, p.icon, p.content FROM page_links l JOIN pages p ON p.id = l.from_page
                 WHERE l.target = ?1 AND p.id <> ?2 AND p.deleted_at IS NULL ORDER BY p.updated_at DESC",
            )?;
            let needle = page.title.to_lowercase();
            st.query_map(params![needle, id], |r| {
                let content: String = r.get(3)?;
                let context = content
                    .lines()
                    .find(|l| {
                        let l = l.to_lowercase();
                        l.contains(&format!("[[{needle}]]"))
                            || l.contains(&format!("[[{needle}|"))
                            || l.contains(&format!("[[{needle}#"))
                    })
                    .unwrap_or("")
                    .trim()
                    .to_owned();
                Ok(Backlink { page_id: r.get(0)?, title: r.get(1)?, icon: r.get(2)?, context })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
        };
        let unresolved_links = self.unresolved_links(wiki_links(&content))?;
        Ok(PageDoc { page, content, tags, backlinks, unresolved_links })
    }

    /// Renames a page. With `update_links`, `[[Old]]` links in other pages are
    /// rewritten to the new title (aliases and heading anchors are kept).
    pub fn rename_page_linked(&self, id: i64, title: &str, update_links: bool) -> Result<usize> {
        let title = clean_title(title);
        let title = title.as_str();
        if title.is_empty() {
            return Err(Error::State("Der Titel darf nicht leer sein".into()));
        }
        let old = self.page(id)?.title;
        // All or nothing: a failure must not leave some links rewritten and others not.
        self.atomic(|| {
            self.rename_page(id, title)?;
            if !update_links || old == title {
                return Ok(0);
            }
            let sources: Vec<(i64, String)> = {
                let mut st = self.conn().prepare(
                    "SELECT p.id, p.content FROM page_links l JOIN pages p ON p.id = l.from_page WHERE l.target = ?1",
                )?;
                st.query_map([old.to_lowercase()], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?
            };
            let mut changed = 0;
            let now = chrono::Utc::now();
            for (pid, content) in sources {
                let updated = replace_link_target(&content, &old, title);
                if updated != content {
                    // Rewritten by the rename, not by the user: keep what they wrote.
                    self.store_version(pid, &content, now)?;
                    self.save_page_content_at(pid, &updated, now)?;
                    changed += 1;
                }
            }
            Ok(changed)
        })
    }

    /// Moves a page under a new parent at `position` (0-based among siblings).
    pub fn move_page(&self, id: i64, parent_id: Option<i64>, position: i64) -> Result<()> {
        // Refuse to move a page into its own subtree.
        let mut cursor = parent_id;
        while let Some(p) = cursor {
            if p == id {
                return Err(Error::State("Eine Seite kann nicht in sich selbst verschoben werden".into()));
            }
            let parent = self.page(p)?;
            if parent.deleted_at.is_some() {
                return Err(Error::State("Die Zielseite liegt im Papierkorb".into()));
            }
            cursor = parent.parent_id;
        }
        self.atomic(|| {
            let conn = self.conn();
            let siblings: Vec<i64> = {
                let mut st =
                    conn.prepare("SELECT id FROM pages WHERE parent_id IS ?1 AND id <> ?2 AND deleted_at IS NULL ORDER BY position, id")?;
                st.query_map(params![parent_id, id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?
            };
            let pos = position.clamp(0, siblings.len() as i64) as usize;
            let mut order = siblings;
            order.insert(pos, id);
            for (i, pid) in order.iter().enumerate() {
                conn.execute("UPDATE pages SET position = ?2 WHERE id = ?1", params![pid, i as i64])?;
            }
            conn.execute("UPDATE pages SET parent_id = ?2 WHERE id = ?1", params![id, parent_id])?;
            Ok(())
        })
    }

    pub fn set_favorite(&self, id: i64, favorite: bool) -> Result<()> {
        self.conn().execute("UPDATE pages SET favorite = ?2 WHERE id = ?1", params![id, favorite])?;
        Ok(())
    }

    pub fn set_page_icon(&self, id: i64, icon: Option<&str>) -> Result<()> {
        self.conn().execute("UPDATE pages SET icon = ?2 WHERE id = ?1", params![id, icon])?;
        Ok(())
    }

    pub fn recent_pages(&self, limit: usize) -> Result<Vec<Page>> {
        let mut st = self.conn().prepare_cached(&format!(
            "SELECT {} FROM pages WHERE content <> '' AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT ?1",
            crate::db::PAGE_COLS
        ))?;
        let rows = st.query_map([limit as i64], crate::db::map_page)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// All tags with the number of pages using them, most used first.
    pub fn tag_counts(&self) -> Result<Vec<(String, i64)>> {
        let mut st = self
            .conn()
            .prepare_cached("SELECT tag, COUNT(*) FROM page_tags JOIN pages p ON p.id = page_id WHERE p.deleted_at IS NULL GROUP BY tag ORDER BY COUNT(*) DESC, tag")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn pages_with_tag(&self, tag: &str) -> Result<Vec<Page>> {
        let mut st = self.conn().prepare_cached(&format!(
            "SELECT {} FROM pages WHERE deleted_at IS NULL AND id IN (SELECT page_id FROM page_tags WHERE tag = ?1) ORDER BY updated_at DESC",
            crate::db::PAGE_COLS
        ))?;
        let rows = st.query_map([tag.to_lowercase()], crate::db::map_page)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Returns the daily note for `date`, creating it (and the Journal parent) if needed.
    pub fn daily_note(&self, date: NaiveDate) -> Result<Page> {
        let key = date.format("%Y-%m-%d").to_string();
        if let Some(p) = self
            .conn()
            .query_row(
                &format!("SELECT {} FROM pages WHERE daily_date = ?1 AND deleted_at IS NULL", crate::db::PAGE_COLS),
                [&key],
                crate::db::map_page,
            )
            .optional()?
        {
            return Ok(p);
        }
        let settings = self.load_settings().unwrap_or_default();
        let folder = Some(settings.notes.daily_folder.trim()).filter(|f| !f.is_empty()).unwrap_or(JOURNAL_TITLE);
        let journal = match self
            .conn()
            .query_row(
                &format!(
                    "SELECT {} FROM pages WHERE parent_id IS NULL AND title = ?1 AND deleted_at IS NULL",
                    crate::db::PAGE_COLS
                ),
                [folder],
                crate::db::map_page,
            )
            .optional()?
        {
            Some(j) => j,
            None => self.create_page(None, folder, Some("calendar-days"))?,
        };
        // The title follows Settings → Notizen; `daily_date` always keeps the ISO date.
        let mut title = settings.notes.daily_title.title(date);
        if self.page_by_title(&title)?.is_some() {
            title = key.clone();
        }
        let page = self.create_page(Some(journal.id), &title, Some("calendar"))?;
        // Newest day first under the Journal.
        self.move_page(page.id, Some(journal.id), 0)?;
        self.conn().execute("UPDATE pages SET daily_date = ?2 WHERE id = ?1", params![page.id, key])?;
        // The UI shows the weekday and date under the title, so the body starts with the sections.
        // A trashed, deleted or moved template falls back to the built-in sections.
        let template = match settings.daily_template {
            Some(id) if id != page.id && self.is_template(id)? => Some(id),
            _ => None,
        };
        let content = match template {
            Some(id) => {
                let time = chrono::Local::now().time();
                self.render_template(id, &crate::templates::TemplateVars { date, time, title: title.clone() })?
            }
            None => "## Fokus\n\n- [ ] \n\n## Notizen\n\n".to_owned(),
        };
        self.save_page_content(page.id, &content)?;
        self.page(page.id)
    }
}

/// Rewrites `[[old]]`, `[[old|alias]]` and `[[old#heading]]` (case-insensitive) to `new`.
/// Code (fenced blocks and inline spans) stays as written, as it is no link ([`wiki_links`]).
pub fn replace_link_target(content: &str, old: &str, new: &str) -> String {
    let mut out = String::with_capacity(content.len());
    let mut in_fence = false;
    for line in content.split_inclusive('\n') {
        if line.trim_start().starts_with("```") {
            in_fence = !in_fence;
            out.push_str(line);
            continue;
        }
        if in_fence {
            out.push_str(line);
            continue;
        }
        // Between backticks is inline code (an unclosed one runs to the end of the line).
        for (i, part) in line.split('`').enumerate() {
            if i > 0 {
                out.push('`');
            }
            if i % 2 == 1 { out.push_str(part) } else { replace_in_prose(part, old, new, &mut out) }
        }
    }
    out
}

fn replace_in_prose(text: &str, old: &str, new: &str, out: &mut String) {
    let mut rest = text;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let Some(end) = after.find("]]") else {
            out.push_str(&rest[start..]);
            return;
        };
        let inner = &after[..end];
        let split = inner.find(['|', '#']).unwrap_or(inner.len());
        let (target, suffix) = inner.split_at(split);
        if target.trim().to_lowercase() == old.to_lowercase() {
            out.push_str("[[");
            out.push_str(new);
            out.push_str(suffix);
            out.push_str("]]");
        } else {
            out.push_str(&rest[start..start + 2 + end + 2]);
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
}

/// Characters a page title cannot hold, because they end or split a `[[link]]`, and what
/// replaces them: brackets become parentheses, `|`, `#` and `^` their full-width forms.
pub const TITLE_REPLACEMENTS: [(char, char); 5] =
    [('[', '('), (']', ')'), ('|', '\u{FF5C}'), ('#', '\u{FF03}'), ('^', '\u{FF3E}')];

/// A title safe to link: trimmed, line breaks as spaces, [`TITLE_REPLACEMENTS`] applied.
pub fn clean_title(title: &str) -> String {
    title
        .trim()
        .chars()
        .map(|c| {
            if c == '\n' || c == '\r' {
                ' '
            } else {
                TITLE_REPLACEMENTS.iter().find(|(from, _)| *from == c).map_or(c, |(_, to)| *to)
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_with_link_characters_stay_linkable() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Alt", None).unwrap();
        let s = db.create_page(None, "Quelle", None).unwrap();
        db.save_page_content(s.id, "Siehe [[Alt]] und [[alt|A]]\n\n```\n[[Alt]] im Code\n```\n`[[Alt]]` inline\n")
            .unwrap();
        assert_eq!(db.rename_page_linked(a.id, "C# Grundlagen [Teil|1]^", true).unwrap(), 1);
        let title = db.page(a.id).unwrap().title;
        assert_eq!(title, "C\u{FF03} Grundlagen (Teil\u{FF5C}1)\u{FF3E}");
        let src = db.page_doc(s.id).unwrap();
        assert_eq!(
            src.content,
            format!("Siehe [[{title}]] und [[{title}|A]]\n\n```\n[[Alt]] im Code\n```\n`[[Alt]]` inline\n"),
            "code keeps its text"
        );
        assert!(src.unresolved_links.is_empty(), "{:?}", src.unresolved_links);
        assert_eq!(db.page_doc(a.id).unwrap().backlinks.len(), 1);
        // New pages follow the same rule.
        assert_eq!(db.create_page(None, " a|b#c\n", None).unwrap().title, "a\u{FF5C}b\u{FF03}c");
        assert_eq!(replace_link_target("x [[Alt]] `[[Alt]] ", "Alt", "Neu"), "x [[Neu]] `[[Alt]] ");
    }

    #[test]
    fn parses_links_and_tags_outside_code() {
        let md = "# Titel\nSiehe [[Architektur]] und [[Jour fixe|JF]] #projekt #1 #Rollout/phase-2\n\
                  `#nope [[Nope]]`\n```\n#code [[Code]]\n```\n## Überschrift ohne Tag";
        assert_eq!(wiki_links(md), vec!["Architektur", "Jour fixe"]);
        assert_eq!(tags(md), vec!["projekt", "rollout/phase-2"]);
    }

    #[test]
    fn chunks_split_at_headings_and_keep_code_together() {
        let md = format!("Intro\n\n# A\n\n{}\n\n{}\n\n# B\n\n```\nx\n\ny\n```\n", "a".repeat(800), "b".repeat(800));
        let c = chunks(&md);
        assert_eq!(c.len(), 4, "{c:#?}");
        assert_eq!(c[0], "Intro");
        assert!(c[1].starts_with("# A"));
        assert!(c[3].starts_with("# B") && c[3].contains("x\n\ny"));
    }

    #[test]
    fn link_rewriting_keeps_alias_and_anchor() {
        let md = "[[Alt]] [[alt|Alias]] [[Alt#Kapitel]] [[Andere]] [[offen";
        assert_eq!(replace_link_target(md, "Alt", "Neu"), "[[Neu]] [[Neu|Alias]] [[Neu#Kapitel]] [[Andere]] [[offen");
    }

    #[test]
    fn save_backlinks_rename_and_tags() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Architektur", None).unwrap();
        let b = db.create_page(None, "Meeting", None).unwrap();
        db.save_page_content(b.id, "Heute: siehe [[Architektur]] #jourfixe\n\n[[Fehlt]]").unwrap();

        let doc = db.page_doc(a.id).unwrap();
        assert_eq!(doc.backlinks.len(), 1);
        assert_eq!(doc.backlinks[0].context, "Heute: siehe [[Architektur]] #jourfixe");
        assert_eq!(db.page_doc(b.id).unwrap().unresolved_links, vec!["Fehlt"]);
        assert_eq!(db.tag_counts().unwrap(), vec![("jourfixe".to_string(), 1)]);

        assert_eq!(db.rename_page_linked(a.id, "Systemarchitektur", true).unwrap(), 1);
        assert!(db.page_doc(b.id).unwrap().content.contains("[[Systemarchitektur]]"));
        assert_eq!(db.page_doc(a.id).unwrap().backlinks.len(), 1, "backlink follows the rename");
    }

    #[test]
    fn embeddings_survive_unrelated_edits() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "P", None).unwrap();
        db.save_page_content(p.id, "# Eins\n\nerster\n\n# Zwei\n\nzweiter").unwrap();
        for (id, _) in crate::ai::rag::pending_blocks(&db, 10).unwrap() {
            crate::ai::rag::store_embedding(&db, id, &[1.0]).unwrap();
        }
        db.save_page_content(p.id, "# Eins\n\nerster\n\n# Zwei\n\nzweiter, geändert").unwrap();
        let pending = crate::ai::rag::pending_blocks(&db, 10).unwrap();
        assert_eq!(pending.len(), 1);
        assert!(pending[0].1.contains("geändert"));
    }

    #[test]
    fn move_page_reorders_and_rejects_cycles() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "A", None).unwrap();
        let b = db.create_page(None, "B", None).unwrap();
        let c = db.create_page(Some(a.id), "C", None).unwrap();
        assert!(db.move_page(a.id, Some(c.id), 0).is_err());
        db.move_page(b.id, Some(a.id), 0).unwrap();
        let tree = db.page_tree().unwrap();
        let kids: Vec<_> = tree[0].children.iter().map(|n| n.page.title.as_str()).collect();
        assert_eq!(kids, ["B", "C"]);
    }

    #[test]
    fn daily_note_is_created_once_under_journal() {
        let db = Database::open_in_memory().unwrap();
        let d = NaiveDate::from_ymd_opt(2026, 9, 23).unwrap();
        let p = db.daily_note(d).unwrap();
        assert_eq!(p.title, "2026-09-23");
        assert_eq!(db.daily_note(d).unwrap().id, p.id);
        assert!(db.page_doc(p.id).unwrap().content.starts_with("## Fokus"));
        assert_eq!(db.page(p.parent_id.unwrap()).unwrap().title, JOURNAL_TITLE);
    }

    #[test]
    fn daily_note_title_format_folder_and_retention_settings() {
        use chrono::{TimeZone, Utc};
        let db = Database::open_in_memory().unwrap();
        let mut s = db.load_settings().unwrap();
        s.notes.daily_title = crate::prefs::DailyTitle::Long;
        s.notes.daily_folder = "Tagebuch".into();
        s.notes.trash_retention_days = 7;
        s.notes.version_interval_minutes = 5;
        s.notes.max_versions = 5;
        db.save_settings(&s).unwrap();
        let d = NaiveDate::from_ymd_opt(2026, 9, 23).unwrap();
        let p = db.daily_note(d).unwrap();
        assert_eq!(p.title, "Mittwoch, 23.09.2026");
        assert_eq!(p.daily_date.as_deref(), Some("2026-09-23"));
        assert_eq!(db.page(p.parent_id.unwrap()).unwrap().title, "Tagebuch");
        assert_eq!(db.daily_note(d).unwrap().id, p.id, "found by date, not title");

        // Trash: 7 days instead of 30.
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        let old = db.create_page(None, "Alt", None).unwrap();
        db.trash_page_at(old.id, t0).unwrap();
        assert_eq!(db.purge_expired_trash(t0 + chrono::Duration::days(6)).unwrap(), 0);
        assert_eq!(db.purge_expired_trash(t0 + chrono::Duration::days(8)).unwrap(), 1);

        // Versions: a snapshot after 5 minutes, at most 5 kept.
        let v = db.create_page(None, "Versioniert", None).unwrap();
        for i in 0..8 {
            db.save_page_content(v.id, &format!("Stand {i}")).unwrap();
            db.snapshot_page_at(v.id, t0 + chrono::Duration::minutes(i * 6)).unwrap();
        }
        assert_eq!(db.list_versions(v.id).unwrap().len(), 5);
    }

    #[test]
    fn daily_note_uses_template_from_settings() {
        let db = Database::open_in_memory().unwrap();
        let root = db.templates_root().unwrap();
        let t = db.create_page(Some(root.id), "Tag", None).unwrap();
        db.save_page_content(t.id, "# {{wochentag}}, {{datum}}\n\nKW {{kw}} · {{titel}}\n").unwrap();
        let s = crate::settings::Settings { daily_template: Some(t.id), ..Default::default() };
        db.save_settings(&s).unwrap();
        let p = db.daily_note(NaiveDate::from_ymd_opt(2026, 9, 23).unwrap()).unwrap();
        assert_eq!(db.page_doc(p.id).unwrap().content, "# Mittwoch, 23.09.2026\n\nKW 39 · 2026-09-23\n");
        // A trashed template falls back to the built-in sections.
        db.trash_page(t.id).unwrap();
        let q = db.daily_note(NaiveDate::from_ymd_opt(2026, 9, 24).unwrap()).unwrap();
        assert!(db.page_doc(q.id).unwrap().content.starts_with("## Fokus"));
        // So does a deleted one.
        db.restore_page(t.id).unwrap();
        db.delete_page(t.id).unwrap();
        let r = db.daily_note(NaiveDate::from_ymd_opt(2026, 9, 25).unwrap()).unwrap();
        assert!(db.page_doc(r.id).unwrap().content.starts_with("## Fokus"));
    }

    #[test]
    fn attachment_embeds_are_not_page_links() {
        assert_eq!(
            wiki_links(
                "![[bild.png]] ![[Notiz]] [[foto.jpg]] ![[a/b.webp|200]] ![[Skizze.excalidraw]] \
                 ![[Handbuch.pdf#page=2]] ![[Angebot.docx]] ![[Version 1.2]] [[Plan.pdf]]"
            ),
            ["Notiz", "foto.jpg", "Version 1.2", "Plan.pdf"]
        );
    }

    #[test]
    fn umlaut_links_resolve_and_follow_renames() {
        let db = Database::open_in_memory().unwrap();
        let target = db.create_page(None, "Übersicht", None).unwrap();
        let src = db.create_page(None, "Quelle", None).unwrap();
        db.save_page_content(src.id, "Siehe [[übersicht]].\n").unwrap();
        let doc = db.page_doc(src.id).unwrap();
        assert!(doc.unresolved_links.is_empty(), "{:?}", doc.unresolved_links);
        assert_eq!(db.rename_page_linked(target.id, "Überblick", true).unwrap(), 1);
        assert!(db.page_doc(src.id).unwrap().content.contains("[[Überblick]]"));
    }

    #[test]
    fn frontmatter_tags_count() {
        assert_eq!(tags("---\ntags: [kunde, \"Projekt\"]\n---\nText #inline\n"), ["kunde", "projekt", "inline"]);
        assert_eq!(tags("---\nstatus: x\ntags:\n  - a\n  - '#b'\n---\n"), ["a", "b"]);
        assert!(tags("---\n\nNur eine Linie\n\n---\n").is_empty());
    }

    #[test]
    fn unresolved_links_in_one_query_match_the_lookup_per_link() {
        let db = Database::open_in_memory().unwrap();
        for t in ["Architektur", "Übersicht", "Jour fixe", "Straße"] {
            db.create_page(None, t, None).unwrap();
        }
        let trashed = db.create_page(None, "Weg", None).unwrap();
        db.trash_page(trashed.id).unwrap();
        let mut links: Vec<String> = [
            "architektur",
            "ARCHITEKTUR",
            "übersicht",
            "ÜBERSICHT",
            "jour FIXE",
            "Weg",
            "Fehlt",
            "strasse",
            "STRASSE",
            "straße",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        // Many links: more than one chunk of bound parameters.
        links.extend((0..1200).map(|i| format!("Neu {i}")));
        let one_by_one: Vec<String> =
            links.iter().filter(|t| db.page_by_title(t).unwrap().is_none()).cloned().collect();
        let batched = db.unresolved_links(links).unwrap();
        assert_eq!(batched, one_by_one);
        assert_eq!(&batched[..4], ["Weg", "Fehlt", "strasse", "STRASSE"]);
    }

    #[test]
    fn save_returns_what_the_editor_needs() {
        let db = Database::open_in_memory().unwrap();
        db.create_page(None, "Ziel", None).unwrap();
        let p = db.create_page(None, "Quelle", None).unwrap();
        let saved = db.save_page(p.id, "[[Ziel]] [[Fehlt]] #b #a").unwrap();
        let doc = db.page_doc(p.id).unwrap();
        assert_eq!(saved.id, p.id);
        assert_eq!(saved.tags, doc.tags);
        assert_eq!(saved.tags, ["a", "b"]);
        assert_eq!(saved.unresolved_links, doc.unresolved_links);
        assert_eq!(saved.unresolved_links, ["Fehlt"]);
        assert_eq!(saved.updated_at, doc.page.updated_at);
    }

    #[test]
    fn a_save_rewrites_only_changed_chunks_and_keeps_search_in_step() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Lang", None).unwrap();
        let sections: Vec<String> = (0..6).map(|i| format!("# Teil {i}\n\nAbschnitt{i} Inhalt")).collect();
        db.save_page_content(p.id, &sections.join("\n\n")).unwrap();
        let rows = |db: &Database| -> Vec<(i64, i64, String)> {
            let mut st = db
                .conn()
                .prepare("SELECT id, position, content_markdown FROM notes_blocks WHERE page_id = ?1 ORDER BY position")
                .unwrap();
            st.query_map([p.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap().map(|r| r.unwrap()).collect()
        };
        let before = rows(&db);
        assert_eq!(before.len(), 6);
        for (id, _) in crate::ai::rag::pending_blocks(&db, 10).unwrap() {
            crate::ai::rag::store_embedding(&db, id, &[1.0]).unwrap();
        }
        // Edit section 2, drop section 4, insert a new first section and repeat section 0.
        let mut next = sections.clone();
        next[2] = "# Teil 2\n\nAbschnitt2 geändert".into();
        next.remove(4);
        next.insert(0, "# Vorwort\n\nNeuanfang".into());
        next.push(sections[0].clone());
        db.save_page_content(p.id, &next.join("\n\n")).unwrap();
        let after = rows(&db);
        assert_eq!(after.iter().map(|r| r.2.clone()).collect::<Vec<_>>(), chunks(&next.join("\n\n")));
        assert_eq!(after.iter().map(|r| r.1).collect::<Vec<_>>(), (0..after.len() as i64).collect::<Vec<_>>());
        // Unchanged sections keep their rows (and embeddings); only new text waits for one.
        let kept = |text: &str| before.iter().find(|r| r.2 == text).map(|r| r.0);
        assert_eq!(after.iter().find(|r| r.2 == sections[5]).map(|r| r.0), kept(&sections[5]));
        let pending: Vec<String> =
            crate::ai::rag::pending_blocks(&db, 10).unwrap().into_iter().map(|(_, t)| t).collect();
        assert_eq!(pending.len(), 3, "{pending:?}");
        // The search index follows: new text found, removed text gone.
        let hits = |q: &str| crate::search::search(&db, q, 10).unwrap().len();
        assert!(hits("Neuanfang") > 0);
        assert!(hits("geändert") > 0);
        let fts = |q: &str| -> i64 {
            db.conn()
                .query_row("SELECT COUNT(*) FROM notes_blocks_fts WHERE notes_blocks_fts MATCH ?1", [q], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(fts("Abschnitt4"), 0);
        assert_eq!(fts("Abschnitt0"), 2);
        // The same result as indexing from scratch.
        db.reindex_all().unwrap();
        assert_eq!(rows(&db).into_iter().map(|r| r.2).collect::<Vec<_>>(), chunks(&next.join("\n\n")));
    }

    #[test]
    fn links_and_tags_follow_edits() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "P", None).unwrap();
        db.save_page_content(p.id, "[[A]] [[B]] #x #y").unwrap();
        db.save_page_content(p.id, "[[b]] [[C]] #y #z").unwrap();
        let links: Vec<String> = db
            .conn()
            .prepare("SELECT target FROM page_links WHERE from_page = ?1 ORDER BY target")
            .unwrap()
            .query_map([p.id], |r| r.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(links, ["b", "c"]);
        assert_eq!(db.page_tags(p.id).unwrap(), ["y", "z"]);
    }
}
