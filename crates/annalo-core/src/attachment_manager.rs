//! The attachment manager („Anhänge“): every file in the attachments folder with its type,
//! size, date and the pages that embed it; safe renames that rewrite every embed; deleting
//! into a file trash (`<data dir>/trash/files`) from which files can be restored.
//!
//! Usage is found by one query over the page contents (pages whose Markdown contains an
//! embed or an image link at all), then by parsing `![[name]]`, `![[name|…]]`,
//! `![[name#page=3]]` and `![alt](path/name.png)` in those pages. Names match
//! case-insensitively, like the file systems of Windows and macOS.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::attachments::{self, file_extension, image_extension, is_drawing};
use crate::db::Database;
use crate::drawings;
use crate::error::{Error, IoAt, Result, copy_file};

/// Folder below the data directory that holds deleted files.
pub const TRASH_DIR: &str = "trash/files";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    Image,
    Drawing,
    Pdf,
    Other,
}

pub fn kind_of(name: &str) -> FileKind {
    if is_drawing(name) {
        FileKind::Drawing
    } else if image_extension(name).is_some() {
        FileKind::Image
    } else if file_extension(name).as_deref() == Some("pdf") {
        FileKind::Pdf
    } else {
        FileKind::Other
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PageUse {
    pub id: i64,
    pub title: String,
    /// The page is in the trash.
    pub trashed: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentInfo {
    pub name: String,
    pub kind: FileKind,
    /// Bytes on disk; a drawing counts its scene and its preview.
    pub size: u64,
    pub modified: Option<DateTime<Utc>>,
    /// The rendered preview of a drawing (`name.excalidraw.svg`), if it exists.
    pub preview: Option<String>,
    /// Pages that embed the file (trashed pages included, marked).
    pub used_in: Vec<PageUse>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AttachmentList {
    pub files: Vec<AttachmentInfo>,
    pub total_size: u64,
}

/// File names a note refers to: `![[…]]` embeds of files (folders dropped) and Markdown image
/// links to local files (`![alt](attachments/Bild%201.png)`). Each name once, in order.
pub fn referenced_files(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut add = |name: String| {
        if attachments::embeddable(&name) && !out.iter().any(|n| n == &name) {
            out.push(name);
        }
    };
    for r in embed_refs(markdown) {
        add(r.base.to_owned());
    }
    for r in link_refs(markdown) {
        add(r.name);
    }
    out
}

/// Files an export of the note carries next to it ([`referenced_files`]; a drawing brings its
/// SVG preview along).
pub fn export_files(markdown: &str) -> Vec<String> {
    let mut out = Vec::new();
    for name in referenced_files(markdown) {
        let preview = attachments::is_drawing(&name).then(|| format!("{name}.svg"));
        out.push(name);
        out.extend(preview);
    }
    out
}

/// Whether a `[[target]]` link (target without anchor and alias) names a file rather than a page:
/// its last path segment has a file extension (`[[Angebot.pdf]]`, `[[Ordner/Daten.xlsx]]`), see
/// [`attachments::embeddable`]. Such a link opens the attachment and is never an unresolved page
/// link; a page whose title looks like a file name (`[[Node.js]]`) still wins where it exists.
pub fn is_file_link(target: &str) -> bool {
    let target = target.trim();
    let base = target.rsplit(['/', '\\']).next().unwrap_or(target);
    !base.is_empty() && attachments::embeddable(base)
}

/// One `![[target#anchor|alt]]`: byte range of `target` inside the Markdown and its base name.
struct EmbedRef<'a> {
    /// Range of the whole target (folders included), without anchor and alias.
    target: std::ops::Range<usize>,
    base: &'a str,
}

/// `![[file]]` embeds and `[[file.pdf]]` links (a link to a name with a file extension is a
/// link to the file, see [`attachments::embeddable`]).
fn embed_refs(markdown: &str) -> Vec<EmbedRef<'_>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = markdown[from..].find("[[") {
        let start = from + i + 2;
        let Some(len) = markdown[start..].find("]]") else { break };
        let inner = &markdown[start..start + len];
        let target_len = inner.find(['|', '#']).unwrap_or(inner.len());
        let raw = &inner[..target_len];
        let lead = raw.len() - raw.trim_start().len();
        let target = raw.trim();
        let base = target.rsplit(['/', '\\']).next().unwrap_or(target);
        let embed = markdown[..from + i].ends_with('!');
        if !base.is_empty() && !inner.contains('\n') && (embed || is_file_link(target)) {
            out.push(EmbedRef { target: start + lead..start + lead + target.len(), base });
        }
        from = start + len + 2;
    }
    out
}

/// One `![alt](path)` or `[text](path)` to a local file: range of the path's last segment and
/// the decoded name.
struct LinkRef {
    segment: std::ops::Range<usize>,
    name: String,
    encoded: bool,
}

fn link_refs(markdown: &str) -> Vec<LinkRef> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = markdown[from..].find('[') {
        let at = from + i;
        from = at + 1;
        // `[[wiki links]]` are handled by `embed_refs`.
        if markdown[at..].starts_with("[[") || markdown[..at].ends_with('[') {
            continue;
        }
        let Some(close) = markdown[at + 1..].find("](") else { break };
        let alt = &markdown[at + 1..at + 1 + close];
        if alt.contains(['\n', ']', '[']) {
            continue;
        }
        let path_start = at + 1 + close + 2;
        let Some(end) = markdown[path_start..].find(')') else { break };
        let mut dest = &markdown[path_start..path_start + end];
        let mut offset = path_start;
        if dest.contains('\n') {
            continue;
        }
        // `<path with spaces>` and an optional title: `(bild.png "Titel")`.
        if let Some(inner) = dest.strip_prefix('<').and_then(|d| d.split('>').next()) {
            offset += 1;
            dest = inner;
        } else {
            let lead = dest.len() - dest.trim_start().len();
            offset += lead;
            dest = dest.trim_start().split(' ').next().unwrap_or("");
        }
        let lower = dest.to_ascii_lowercase();
        if dest.is_empty() || lower.contains("://") || lower.starts_with("data:") || lower.starts_with("mailto:") {
            continue;
        }
        let path = dest.split(['?', '#']).next().unwrap_or(dest);
        let seg_start = path.rfind(['/', '\\']).map(|p| p + 1).unwrap_or(0);
        let segment = &path[seg_start..];
        let encoded = segment.contains('%');
        let Some(name) = attachments::percent_decode(segment) else { continue };
        if !name.is_empty() {
            out.push(LinkRef { segment: offset + seg_start..offset + seg_start + segment.len(), name, encoded });
        }
        from = path_start + end + 1;
    }
    out
}

/// Encodes a file name for the path of a Markdown link (spaces and characters links break on).
fn encode_segment(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for c in name.chars() {
        match c {
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '%' => out.push_str("%25"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            _ => out.push(c),
        }
    }
    out
}

/// Rewrites every reference to the file `old` (case-insensitive) to `new`: embeds keep their
/// folder prefix, anchor and alias, image links their path.
pub fn replace_file_refs(markdown: &str, old: &str, new: &str) -> String {
    let old_l = old.to_lowercase();
    let mut edits: Vec<(std::ops::Range<usize>, String)> = Vec::new();
    for r in embed_refs(markdown) {
        if r.base.to_lowercase() == old_l {
            let target = &markdown[r.target.clone()];
            let prefix = &target[..target.len() - r.base.len()];
            edits.push((r.target, format!("{prefix}{new}")));
        }
    }
    for r in link_refs(markdown) {
        if r.name.to_lowercase() == old_l {
            let plain_ok = !new.contains([' ', '(', ')', '<', '>', '%']);
            let text = if r.encoded || !plain_ok { encode_segment(new) } else { new.to_owned() };
            edits.push((r.segment, text));
        }
    }
    edits.sort_by_key(|(r, _)| r.start);
    let mut out = String::with_capacity(markdown.len());
    let mut at = 0;
    for (range, text) in edits {
        out.push_str(&markdown[at..range.start]);
        out.push_str(&text);
        at = range.end;
    }
    out.push_str(&markdown[at..]);
    out
}

impl Database {
    /// Pages per referenced file name (lower-case), trashed pages included.
    pub fn attachment_usage(&self) -> Result<HashMap<String, Vec<PageUse>>> {
        let mut st = self.conn().prepare(
            "SELECT id, title, content, deleted_at IS NOT NULL FROM pages
             WHERE instr(content, '[[') > 0 OR instr(content, '](') > 0
             ORDER BY deleted_at IS NOT NULL, title COLLATE NOCASE, id",
        )?;
        let rows = st.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?))
        })?;
        let mut out: HashMap<String, Vec<PageUse>> = HashMap::new();
        for row in rows {
            let (id, title, content, trashed) = row?;
            for name in referenced_files(&content) {
                let uses = out.entry(name.to_lowercase()).or_default();
                if !uses.iter().any(|u| u.id == id) {
                    uses.push(PageUse { id, title: title.clone(), trashed });
                }
            }
        }
        Ok(out)
    }

    /// Pages (trashed ones too) that refer to `name`.
    pub fn pages_using(&self, name: &str) -> Result<Vec<PageUse>> {
        Ok(self.attachment_usage()?.remove(&name.to_lowercase()).unwrap_or_default())
    }
}

fn modified(meta: &fs::Metadata) -> Option<DateTime<Utc>> {
    meta.modified().ok().map(DateTime::<Utc>::from)
}

/// Visible plain files of the attachments folder (no temp or hidden files, no folders).
fn visible_files(dir: &Path) -> Result<Vec<(String, fs::Metadata)>> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return Ok(out) };
    for e in rd.flatten() {
        let Ok(name) = e.file_name().into_string() else { continue };
        let Ok(meta) = e.metadata() else { continue };
        if name.starts_with('.') || !meta.is_file() {
            continue;
        }
        out.push((name, meta));
    }
    Ok(out)
}

/// Every file in the attachments folder with its usage, sorted by name. A drawing's preview
/// is shown with its scene, not as a file of its own.
pub fn list(db: &Database, attachments_dir: &Path) -> Result<AttachmentList> {
    let files = visible_files(attachments_dir)?;
    let usage = db.attachment_usage()?;
    let names: std::collections::HashSet<String> = files.iter().map(|(n, _)| n.to_lowercase()).collect();
    let mut out = Vec::new();
    let mut total = 0;
    for (name, meta) in &files {
        let lower = name.to_lowercase();
        // `x.excalidraw.svg` belongs to `x.excalidraw` when that exists.
        if let Some(scene) = lower.strip_suffix(".svg")
            && is_drawing(scene)
            && names.contains(scene)
        {
            continue;
        }
        let mut size = meta.len();
        let mut preview = None;
        if is_drawing(name) {
            let svg = drawings::preview_name(name);
            if let Ok(m) = fs::metadata(attachments_dir.join(&svg)) {
                size += m.len();
                preview = Some(svg);
            }
        }
        total += size;
        out.push(AttachmentInfo {
            name: name.clone(),
            kind: kind_of(name),
            size,
            modified: modified(meta),
            preview,
            used_in: usage.get(&lower).cloned().unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.name.cmp(&b.name)));
    Ok(AttachmentList { files: out, total_size: total })
}

/// A file of the attachments folder by its plain name, or a clear error.
fn existing(attachments_dir: &Path, name: &str) -> Result<PathBuf> {
    attachments::existing(attachments_dir, name)
}

/// Checks a new name for `old`: a valid file name (see [`attachments::clean_name`]) with the
/// same extension, not taken by another file.
pub fn check_new_name(attachments_dir: &Path, old: &str, new: &str) -> Result<String> {
    let new = new.trim();
    let clean = attachments::clean_name(new)?;
    if clean != new {
        return Err(Error::State(format!(
            "„{new}“ ist als Dateiname nicht erlaubt (keine Ordner und keines der Zeichen : * ? \" < > | [ ] # ^) – zum Beispiel „{clean}“"
        )));
    }
    let (old_ext, new_ext) = (file_extension(old), file_extension(&clean));
    let drawing = is_drawing(old);
    if old_ext != new_ext || (drawing && !is_drawing(&clean)) {
        let ext = if drawing { ".excalidraw".to_owned() } else { format!(".{}", old_ext.unwrap_or_default()) };
        return Err(Error::State(format!("Die Dateiendung muss {ext} bleiben")));
    }
    if drawing {
        drawings::validate_name(&clean)?;
    }
    let taken = |candidate: &str| -> bool {
        let lower = candidate.to_lowercase();
        visible_files(attachments_dir).unwrap_or_default().iter().any(|(n, _)| n.to_lowercase() == lower && n != old)
    };
    if taken(&clean) || (drawing && taken(&drawings::preview_name(&clean))) {
        return Err(Error::State(format!("Eine Datei „{clean}“ gibt es schon")));
    }
    Ok(clean)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RenameOutcome {
    pub name: String,
    /// Pages whose embeds were rewritten.
    pub pages: Vec<i64>,
}

/// Renames a file (a drawing with its preview) and rewrites every reference in all pages,
/// trashed ones included. Each rewritten page is saved through the normal save path after a
/// snapshot of its previous content, like a page rename. All or nothing: when the pages
/// cannot be updated, the files get their old names back.
pub fn rename(db: &Database, attachments_dir: &Path, old: &str, new: &str) -> Result<RenameOutcome> {
    existing(attachments_dir, old)?;
    let new = check_new_name(attachments_dir, old, new)?;
    if new == old {
        return Ok(RenameOutcome { name: new, pages: vec![] });
    }
    let mut moves: Vec<(PathBuf, PathBuf)> = vec![(attachments_dir.join(old), attachments_dir.join(&new))];
    if is_drawing(old) {
        let svg = attachments_dir.join(drawings::preview_name(old));
        if svg.is_file() {
            moves.push((svg, attachments_dir.join(drawings::preview_name(&new))));
        }
    }
    let mut done: Vec<&(PathBuf, PathBuf)> = Vec::new();
    for m in &moves {
        if let Err(e) = fs::rename(&m.0, &m.1) {
            for (from, to) in done.iter().rev() {
                let _ = fs::rename(to, from);
            }
            return Err(Error::file(&m.0, e));
        }
        done.push(m);
    }
    let rewrite = db.atomic(|| {
        let uses = db.pages_using(old)?;
        let now = Utc::now();
        let mut changed = Vec::new();
        for u in uses {
            let content: String =
                db.conn().query_row("SELECT content FROM pages WHERE id = ?1", params![u.id], |r| r.get(0))?;
            let updated = replace_file_refs(&content, old, &new);
            if updated != content {
                // Rewritten by the rename, not by the user: keep what they wrote.
                db.store_version(u.id, &content, now)?;
                db.save_page_content_at(u.id, &updated, now)?;
                changed.push(u.id);
            }
        }
        Ok(changed)
    });
    match rewrite {
        Ok(pages) => Ok(RenameOutcome { name: new, pages }),
        Err(e) => {
            for (from, to) in moves.iter().rev() {
                let _ = fs::rename(to, from);
            }
            Err(e)
        }
    }
}

// ------------------------------------------------------------------ file trash

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TrashedFile {
    /// Folder in the file trash (the time of deletion), used to restore or purge.
    pub id: String,
    pub name: String,
    pub size: u64,
    pub deleted_at: DateTime<Utc>,
}

pub fn trash_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(TRASH_DIR)
}

fn stamp_dir(now: DateTime<Utc>) -> String {
    now.format("%Y%m%dT%H%M%S%.9fZ").to_string()
}

fn parse_stamp(s: &str) -> Option<DateTime<Utc>> {
    chrono::NaiveDateTime::parse_from_str(s.trim_end_matches('Z'), "%Y%m%dT%H%M%S%.9f").ok().map(|t| t.and_utc())
}

/// Moves files (a drawing with its preview) into the file trash. Returns the names moved.
pub fn trash_files(data_dir: &Path, names: &[String]) -> Result<Vec<String>> {
    trash_files_at(data_dir, names, Utc::now())
}

pub fn trash_files_at(data_dir: &Path, names: &[String], now: DateTime<Utc>) -> Result<Vec<String>> {
    let src = attachments::dir(data_dir);
    let target = trash_dir(data_dir).join(stamp_dir(now));
    let mut moved = Vec::new();
    for name in names {
        existing(&src, name)?;
    }
    for name in names {
        fs::create_dir_all(&target).at(&target)?;
        let mut files = vec![name.clone()];
        if is_drawing(name) && src.join(drawings::preview_name(name)).is_file() {
            files.push(drawings::preview_name(name));
        }
        for f in files {
            let from = src.join(&f);
            let to = target.join(&f);
            if fs::rename(&from, &to).is_err() {
                // Another volume (a linked folder): copy, then remove.
                copy_file(&from, &to)?;
                fs::remove_file(&from).at(&from)?;
            }
        }
        moved.push(name.clone());
    }
    Ok(moved)
}

/// Files in the trash, newest first (drawing previews are listed with their scene).
pub fn trashed_files(data_dir: &Path) -> Result<Vec<TrashedFile>> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(trash_dir(data_dir)) else { return Ok(out) };
    for e in rd.flatten() {
        let Ok(id) = e.file_name().into_string() else { continue };
        let Some(at) = parse_stamp(&id) else { continue };
        for (name, meta) in visible_files(&e.path())? {
            let lower = name.to_lowercase();
            if lower.strip_suffix(".svg").is_some_and(is_drawing) && e.path().join(&name[..name.len() - 4]).is_file() {
                continue;
            }
            let mut size = meta.len();
            if is_drawing(&name) {
                size += fs::metadata(e.path().join(drawings::preview_name(&name))).map(|m| m.len()).unwrap_or(0);
            }
            out.push(TrashedFile { id: id.clone(), name, size, deleted_at: at });
        }
    }
    out.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at).then(a.name.cmp(&b.name)));
    Ok(out)
}

fn trashed_path(data_dir: &Path, id: &str, name: &str) -> Result<PathBuf> {
    if parse_stamp(id).is_none() || attachments::resolve(&trash_dir(data_dir).join(id), name).is_none() {
        return Err(Error::not_found("Datei im Papierkorb", name));
    }
    Ok(trash_dir(data_dir).join(id))
}

/// Puts a file back into the attachments folder under its name; refuses when the name is
/// taken meanwhile.
pub fn restore_file(data_dir: &Path, id: &str, name: &str) -> Result<()> {
    let folder = trashed_path(data_dir, id, name)?;
    let dst = attachments::dir(data_dir);
    fs::create_dir_all(&dst).at(&dst)?;
    let mut files = vec![name.to_owned()];
    if is_drawing(name) && folder.join(drawings::preview_name(name)).is_file() {
        files.push(drawings::preview_name(name));
    }
    for f in &files {
        if dst.join(f).exists() {
            return Err(Error::State(format!("Eine Datei „{f}“ gibt es schon – zuerst umbenennen")));
        }
    }
    for f in &files {
        fs::rename(folder.join(f), dst.join(f)).at(dst.join(f))?;
    }
    let _ = fs::remove_dir(&folder); // only when empty
    Ok(())
}

/// Deletes a file from the trash for good.
pub fn purge_file(data_dir: &Path, id: &str, name: &str) -> Result<()> {
    let folder = trashed_path(data_dir, id, name)?;
    fs::remove_file(folder.join(name)).at(folder.join(name))?;
    if is_drawing(name) {
        let _ = fs::remove_file(folder.join(drawings::preview_name(name)));
    }
    let _ = fs::remove_dir(&folder);
    Ok(())
}

/// Removes trash folders older than `days` (Settings → Papierkorb). Returns the files removed.
pub fn purge_expired_files(data_dir: &Path, days: i64, now: DateTime<Utc>) -> Result<usize> {
    let mut n = 0;
    let Ok(rd) = fs::read_dir(trash_dir(data_dir)) else { return Ok(0) };
    for e in rd.flatten() {
        let Some(at) = e.file_name().to_str().and_then(parse_stamp) else { continue };
        if now - at >= chrono::Duration::days(days) {
            n += fs::read_dir(e.path()).map(|r| r.count()).unwrap_or(0);
            fs::remove_dir_all(e.path()).at(e.path())?;
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-attmgr-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(p.join("attachments")).unwrap();
        p
    }

    #[test]
    fn finds_embeds_and_image_links() {
        let md = "![[a.png]] ![[Ordner/b.JPG|300]] ![[Notiz]] [[c.png]] ![[Handbuch.pdf#page=3]]\n\
                  ![Bild](attachments/Bild%201.png) ![x](<attachments/mit leer.png> \"Titel\") \
                  ![web](https://example.com/w.png) ![d](data:image/png;base64,xx) ![[a.png]] \
                  ![[Skizze.excalidraw]] ![kein]( ) ![alt](bild.webp)\n\
                  - [ ] Aufgabe [Angebot](Angebot.pdf) [Seite](Notiz.md) [web](https://x.de/y.pdf) [a](#anker)";
        assert_eq!(
            referenced_files(md),
            [
                "a.png",
                "b.JPG",
                "c.png",
                "Handbuch.pdf",
                "Skizze.excalidraw",
                "Bild 1.png",
                "mit leer.png",
                "bild.webp",
                "Angebot.pdf"
            ]
        );
    }

    #[test]
    fn rewrites_references_and_keeps_the_rest() {
        let md = "Vorher ![[Angebot.pdf]] und ![[ordner/angebot.PDF#page=2|Seite 2]] \
                  ![[Angebot.pdf.bak]] [[Angebot.pdf]] ![A](attachments/Angebot.pdf) ![B](Angebot.pdf \"t\") \
                  [Link](Angebot.pdf) [[Angebot]]";
        let out = replace_file_refs(md, "Angebot.pdf", "Angebot 2024.pdf");
        assert_eq!(
            out,
            "Vorher ![[Angebot 2024.pdf]] und ![[ordner/Angebot 2024.pdf#page=2|Seite 2]] \
             ![[Angebot.pdf.bak]] [[Angebot 2024.pdf]] ![A](attachments/Angebot%202024.pdf) ![B](Angebot%202024.pdf \"t\") \
             [Link](Angebot%202024.pdf) [[Angebot]]"
        );
        // Encoded links stay encoded.
        assert_eq!(replace_file_refs("![x](a%20b.png)", "a b.png", "c.png"), "![x](c.png)");
        assert_eq!(replace_file_refs("![x](<a b.png>)", "a b.png", "c d.png"), "![x](<c%20d.png>)");
        assert_eq!(replace_file_refs("nichts", "a.png", "b.png"), "nichts");
    }

    fn page(db: &Database, title: &str, content: &str) -> i64 {
        let p = db.create_page(None, title, None).unwrap();
        db.save_page_content(p.id, content).unwrap();
        p.id
    }

    #[test]
    fn lists_files_with_type_size_and_usage() {
        let dir = tmp("list");
        let att = dir.join("attachments");
        fs::write(att.join("Bild.png"), b"12345").unwrap();
        fs::write(att.join("Skizze.excalidraw"), b"{}").unwrap();
        fs::write(att.join("Skizze.excalidraw.svg"), b"<svg/>").unwrap();
        fs::write(att.join("Handbuch.pdf"), b"%PDF").unwrap();
        fs::write(att.join("daten.xlsx"), b"PK").unwrap();
        fs::write(att.join(".Bild.png.tmp"), b"x").unwrap();
        fs::create_dir_all(att.join("ordner")).unwrap();
        let db = Database::open_in_memory().unwrap();
        let a = page(&db, "Alpha", "![[bild.PNG|200]] ![[Handbuch.pdf#page=2]]");
        let b = page(&db, "Beta", "![Plan](attachments/Bild.png) ![[Skizze.excalidraw]]");
        let gone = page(&db, "Weg", "![[daten.xlsx]]");
        db.trash_page(gone).unwrap();

        let l = list(&db, &att).unwrap();
        let names: Vec<&str> = l.files.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["Bild.png", "daten.xlsx", "Handbuch.pdf", "Skizze.excalidraw"]);
        assert_eq!(l.total_size, 5 + 2 + 4 + 2 + 6);
        let get = |n: &str| l.files.iter().find(|f| f.name == n).unwrap();
        assert_eq!(get("Bild.png").kind, FileKind::Image);
        assert_eq!(get("Bild.png").used_in.iter().map(|u| u.id).collect::<Vec<_>>(), [a, b]);
        let sk = get("Skizze.excalidraw");
        assert_eq!((sk.kind, sk.size, sk.preview.as_deref()), (FileKind::Drawing, 8, Some("Skizze.excalidraw.svg")));
        assert_eq!(get("Handbuch.pdf").kind, FileKind::Pdf);
        let x = get("daten.xlsx");
        assert_eq!((x.kind, x.used_in.len(), x.used_in[0].trashed), (FileKind::Other, 1, true));
        assert!(x.modified.is_some());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rename_rewrites_all_pages_and_keeps_versions() {
        let dir = tmp("rename");
        let att = dir.join("attachments");
        fs::write(att.join("Angebot.pdf"), b"%PDF").unwrap();
        fs::write(att.join("Skizze.excalidraw"), b"{}").unwrap();
        fs::write(att.join("Skizze.excalidraw.svg"), b"<svg/>").unwrap();
        fs::write(att.join("Anderes.pdf"), b"%PDF 2").unwrap();
        let db = Database::open_in_memory().unwrap();
        let a = page(&db, "A", "![[Angebot.pdf]]\n\n![[Skizze.excalidraw]]");
        let b = page(&db, "B", "Siehe ![[Angebot.pdf#page=2|S. 2]]");
        let c = page(&db, "C", "Nichts");
        let t = page(&db, "T", "![A](attachments/Angebot.pdf)");
        db.trash_page(t).unwrap();

        // Invalid names, other extensions and collisions are refused before anything changes.
        for (bad, why) in [
            ("Ange:bot.pdf", "nicht erlaubt"),
            ("ordner/x.pdf", "nicht erlaubt"),
            ("Angebot.docx", "Dateiendung"),
            ("anderes.PDF", "gibt es schon"),
            ("anderes.pdf", "gibt es schon"),
            ("Angebot", "Dateiendung"),
        ] {
            let err = rename(&db, &att, "Angebot.pdf", bad).unwrap_err().to_string();
            assert!(err.contains(why), "{bad}: {err}");
        }
        assert!(rename(&db, &att, "Fehlt.pdf", "x.pdf").is_err());
        assert!(att.join("Angebot.pdf").is_file());

        let out = rename(&db, &att, "Angebot.pdf", "Angebot 2026.pdf").unwrap();
        assert_eq!(out.name, "Angebot 2026.pdf");
        let mut pages = out.pages.clone();
        pages.sort();
        assert_eq!(pages, [a, b, t]);
        assert!(!att.join("Angebot.pdf").exists() && att.join("Angebot 2026.pdf").is_file());
        assert_eq!(db.page_doc(a).unwrap().content, "![[Angebot 2026.pdf]]\n\n![[Skizze.excalidraw]]");
        assert_eq!(db.page_doc(b).unwrap().content, "Siehe ![[Angebot 2026.pdf#page=2|S. 2]]");
        assert_eq!(db.page_doc(c).unwrap().content, "Nichts");
        let trashed: String =
            db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [t], |r| r.get(0)).unwrap();
        assert_eq!(trashed, "![A](attachments/Angebot%202026.pdf)");
        // The previous content is kept as a version.
        let v = db.list_versions(b).unwrap();
        assert_eq!(db.version_content(v[0].id).unwrap(), "Siehe ![[Angebot.pdf#page=2|S. 2]]");

        // A drawing renames its preview too; a case-only rename is allowed.
        rename(&db, &att, "Skizze.excalidraw", "Plan.excalidraw").unwrap();
        assert!(att.join("Plan.excalidraw").is_file() && att.join("Plan.excalidraw.svg").is_file());
        assert!(!att.join("Skizze.excalidraw.svg").exists());
        assert!(db.page_doc(a).unwrap().content.ends_with("![[Plan.excalidraw]]"));
        assert!(rename(&db, &att, "Plan.excalidraw", "Plan.excalidraw.svg").is_err());
        rename(&db, &att, "Anderes.pdf", "anderes.pdf").unwrap();
        assert!(att.join("anderes.pdf").is_file());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn trash_restore_and_purge() {
        let dir = tmp("trash");
        let att = dir.join("attachments");
        fs::write(att.join("alt.zip"), b"PK12").unwrap();
        fs::write(att.join("Skizze.excalidraw"), b"{}").unwrap();
        fs::write(att.join("Skizze.excalidraw.svg"), b"<svg/>").unwrap();
        let t0 = Utc::now() - chrono::Duration::days(40);
        assert!(trash_files(&dir, &["fehlt.zip".into()]).is_err());
        trash_files_at(&dir, &["alt.zip".into()], t0).unwrap();
        trash_files(&dir, &["Skizze.excalidraw".into()]).unwrap();
        assert!(!att.join("alt.zip").exists() && !att.join("Skizze.excalidraw.svg").exists());
        let t = trashed_files(&dir).unwrap();
        assert_eq!(
            t.iter().map(|f| (f.name.as_str(), f.size)).collect::<Vec<_>>(),
            [("Skizze.excalidraw", 8), ("alt.zip", 4)]
        );

        // Restore refuses a name taken meanwhile.
        fs::write(att.join("Skizze.excalidraw"), b"neu").unwrap();
        assert!(restore_file(&dir, &t[0].id, "Skizze.excalidraw").unwrap_err().to_string().contains("gibt es schon"));
        fs::remove_file(att.join("Skizze.excalidraw")).unwrap();
        restore_file(&dir, &t[0].id, "Skizze.excalidraw").unwrap();
        assert!(att.join("Skizze.excalidraw.svg").is_file());
        assert!(restore_file(&dir, "../..", "alt.zip").is_err());

        assert_eq!(purge_expired_files(&dir, 30, Utc::now()).unwrap(), 1);
        assert!(trashed_files(&dir).unwrap().is_empty());
        trash_files(&dir, &["Skizze.excalidraw".into()]).unwrap();
        let t = trashed_files(&dir).unwrap();
        purge_file(&dir, &t[0].id, "Skizze.excalidraw").unwrap();
        assert!(trashed_files(&dir).unwrap().is_empty());
        let _ = fs::remove_dir_all(&dir);
    }
}
