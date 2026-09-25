//! Import an Obsidian vault (a folder of Markdown files) and export the
//! workspace back to plain Markdown files.
//!
//! Folders become pages; a `Name.md` next to a folder `Name/` becomes that
//! folder page's content (the "folder note" convention). Titles are file
//! names without extension, so Obsidian `[[links]]` keep working.
//! Images are copied into the attachments folder under their file name, so
//! `![[bild.png]]` embeds keep working; export writes them to `attachments/`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::{Deserialize, Serialize};

use crate::attachments;
use crate::db::Database;
use crate::error::{IoAt, Result};
use crate::model::PageNode;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ImportReport {
    pub pages: usize,
    pub folders: usize,
    /// Images copied into the attachments folder.
    #[serde(default)]
    pub attachments: usize,
    /// Other files (PDFs, …) that were left out.
    pub skipped: usize,
    /// Page created to hold the import.
    pub root_page_id: i64,
    /// What the user should know (a note cut because of its size, a converted encoding).
    #[serde(default)]
    pub warnings: Vec<String>,
}

/// Progress of [`plan_import`]: files read so far of all files in the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ImportProgress {
    pub done: usize,
    pub total: usize,
}

/// A note larger than this is imported up to here (the editor cannot work with tens of
/// megabytes); the file in the vault stays as it is.
pub const MAX_NOTE_BYTES: usize = 2 * 1024 * 1024;

fn hidden(p: &Path) -> bool {
    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.') || n == "node_modules")
}

fn is_md(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn stem(p: &Path) -> String {
    p.file_stem().and_then(|s| s.to_str()).unwrap_or("Ohne Titel").to_owned()
}

/// Windows-1252 (the „ANSI“ of German Windows) for the bytes 0x80–0x9F; the others are Latin-1.
const CP1252: [char; 32] = [
    '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’',
    '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
];

/// Text of a note file: UTF-8, else Windows-1252 (old Windows editors), converted.
pub fn decode_text(bytes: &[u8]) -> (String, bool) {
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_owned(), false),
        Err(_) => {
            let text =
                bytes.iter().map(|&b| if (0x80..0xA0).contains(&b) { CP1252[(b - 0x80) as usize] } else { b as char });
            (text.collect(), true)
        }
    }
}

/// Reads a note; see [`decode_text`] and [`MAX_NOTE_BYTES`].
fn read_text(p: &Path, rel: &Path, warnings: &mut Vec<String>) -> Result<String> {
    let bytes = fs::read(p).at(p)?;
    let (text, converted) = decode_text(&bytes);
    if converted {
        warnings.push(format!("{}: kein UTF-8, als Windows-1252 gelesen", rel.display()));
    }
    let mut text = text.strip_prefix('\u{feff}').unwrap_or(&text).replace("\r\n", "\n");
    if text.len() > MAX_NOTE_BYTES {
        let mb = text.len() / 1024 / 1024;
        text.truncate(text.floor_char_boundary(MAX_NOTE_BYTES));
        text.push_str(&format!(
            "\n\n> Gekürzt beim Import: die Datei ist {mb} MB groß, der Rest steht nur im Vault.\n"
        ));
        warnings.push(format!("{}: {mb} MB groß, gekürzt auf 2 MB", rel.display()));
    }
    // Obsidian Tasks marks due dates with a calendar symbol; Annalo writes `due:`.
    Ok(text.replace(&format!("{} ", crate::tasks::OBSIDIAN_DUE), "due:").replace(crate::tasks::OBSIDIAN_DUE, "due:"))
}

/// A page to create, read from the vault without touching the database.
struct Planned {
    title: String,
    icon: &'static str,
    content: Option<String>,
    /// Folder of the note in the vault (relative), for the attachment renames.
    dir: PathBuf,
    children: Vec<Planned>,
}

/// A vault read from disk ([`plan_import`]), ready to be written ([`apply_import`]).
pub struct ImportPlan {
    name: String,
    pages: Vec<Planned>,
    report: ImportReport,
    /// Attachments stored under another name (a different file had the name): old name, new
    /// name, and the vault folder whose notes refer to it.
    renamed: Vec<(String, String, PathBuf)>,
}

/// Imports `dir` under a new top-level page named after the folder; images go to `attachments_dir`.
pub fn import_vault(db: &Database, dir: &Path, attachments_dir: &Path) -> Result<ImportReport> {
    let plan = plan_import(dir, attachments_dir, &mut |_| {}, &AtomicBool::new(false))?;
    apply_import(db, plan)
}

/// Reads the vault and copies its attachments, without the database (so the app stays usable
/// meanwhile). `cancel` stops it between two files.
pub fn plan_import(
    dir: &Path,
    attachments_dir: &Path,
    progress: &mut dyn FnMut(ImportProgress),
    cancel: &AtomicBool,
) -> Result<ImportPlan> {
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Import").to_owned();
    let mut walk = Walk {
        root: dir,
        attachments_dir,
        report: ImportReport::default(),
        renamed: vec![],
        progress: ImportProgress { done: 0, total: count_files(dir) },
        on_progress: progress,
        cancel,
    };
    let pages = walk.dir(dir)?;
    (walk.on_progress)(walk.progress);
    Ok(ImportPlan { name, pages, report: walk.report, renamed: walk.renamed })
}

/// Creates the pages of `plan` (one transaction: all or nothing).
pub fn apply_import(db: &Database, plan: ImportPlan) -> Result<ImportReport> {
    let ImportPlan { name, pages, mut report, renamed } = plan;
    db.atomic(|| {
        let root = db.create_page(None, &name, Some("library"))?;
        report.root_page_id = root.id;
        create_pages(db, root.id, pages, &renamed)?;
        Ok(report)
    })
}

fn create_pages(db: &Database, parent: i64, pages: Vec<Planned>, renamed: &[(String, String, PathBuf)]) -> Result<()> {
    for p in pages {
        let page = db.create_page(Some(parent), &p.title, Some(p.icon))?;
        if let Some(mut content) = p.content {
            // The notes refer to renamed files by their old names.
            for (old, new, scope) in renamed {
                if p.dir.starts_with(scope) {
                    content = crate::attachment_manager::replace_file_refs(&content, old, new);
                }
            }
            db.save_page_content(page.id, &content)?;
        }
        create_pages(db, page.id, p.children, renamed)?;
    }
    Ok(())
}

fn count_files(dir: &Path) -> usize {
    visible_entries(dir).map(|v| v.iter().map(|p| if p.is_dir() { count_files(p) } else { 1 }).sum()).unwrap_or(0)
}

struct Walk<'a> {
    root: &'a Path,
    attachments_dir: &'a Path,
    report: ImportReport,
    renamed: Vec<(String, String, PathBuf)>,
    progress: ImportProgress,
    on_progress: &'a mut dyn FnMut(ImportProgress),
    cancel: &'a AtomicBool,
}

impl Walk<'_> {
    fn rel(&self, p: &Path) -> PathBuf {
        p.strip_prefix(self.root).map(Path::to_path_buf).unwrap_or_default()
    }

    /// One file done: progress now and then, and the chance to stop.
    fn tick(&mut self) -> Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            return Err(crate::Error::State("Import abgebrochen".into()));
        }
        self.progress.done += 1;
        if self.progress.done.is_multiple_of(25) {
            (self.on_progress)(self.progress);
        }
        Ok(())
    }

    fn note(&mut self, path: &Path) -> Result<String> {
        self.tick()?;
        let rel = self.rel(path);
        read_text(path, &rel, &mut self.report.warnings)
    }

    fn dir(&mut self, dir: &Path) -> Result<Vec<Planned>> {
        let mut entries = visible_entries(dir)?;
        entries.sort_by_key(|p| (!p.is_dir(), p.file_name().map(|n| n.to_ascii_lowercase())));
        let here = self.rel(dir);
        // Full folder names: `v1.2/` pairs with `v1.2.md`, whose stem is also `v1.2`.
        let folder_names: Vec<String> =
            entries.iter().filter(|p| p.is_dir()).filter_map(|p| p.file_name()?.to_str().map(str::to_owned)).collect();
        let mut out = vec![];
        for path in &entries {
            if path.is_dir() && !has_markdown(path) {
                // Pure attachment folders (`assets/`) do not become pages; their files belong
                // to the notes of this folder.
                self.files_only(path, &here)?;
            } else if path.is_dir() {
                let title = path.file_name().and_then(|n| n.to_str()).unwrap_or("Ordner").to_owned();
                let note = dir.join(format!("{title}.md"));
                let content = if is_plain_file(&note) {
                    self.report.pages += 1;
                    Some(self.note(&note)?)
                } else {
                    None
                };
                self.report.folders += 1;
                let children = self.dir(path)?;
                out.push(Planned { title, icon: "folder", content, dir: here.clone(), children });
            } else if is_md(path) {
                let title = stem(path);
                if folder_names.iter().any(|f| f == &title) {
                    continue; // folder note, already used as the folder page's content
                }
                let content = self.note(path)?;
                self.report.pages += 1;
                out.push(Planned {
                    title,
                    icon: "file-text",
                    content: Some(content),
                    dir: here.clone(),
                    children: vec![],
                });
            } else {
                self.attachment(path, &here)?;
            }
        }
        Ok(out)
    }

    fn files_only(&mut self, dir: &Path, scope: &Path) -> Result<()> {
        for path in visible_entries(dir)? {
            if path.is_dir() {
                self.files_only(&path, scope)?;
            } else {
                self.attachment(&path, scope)?;
            }
        }
        Ok(())
    }

    /// Copies an attachment (image, drawing, PDF or any other file with an extension) by its
    /// file name (Obsidian resolves embeds by name). The same file under that name is kept, so
    /// importing twice does not duplicate anything; a different file of the same name is stored
    /// under a free name (`Bild 2.png`) and the notes of `scope` are pointed to it. Files above
    /// the attachment limit and empty files are skipped.
    fn attachment(&mut self, path: &Path, scope: &Path) -> Result<()> {
        self.tick()?;
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            self.report.skipped += 1;
            return Ok(());
        };
        if !attachments::embeddable(name)
            || name.contains(':')
            || fs::metadata(path).at(path)?.len() > attachments::MAX_FILE_BYTES
        {
            self.report.skipped += 1;
            return Ok(());
        }
        match attachments::import_file(self.attachments_dir, path) {
            Ok(saved) => {
                if saved.name != name {
                    self.renamed.push((name.to_owned(), saved.name, scope.to_path_buf()));
                }
                self.report.attachments += 1;
                Ok(())
            }
            Err(e @ (crate::Error::Io(_) | crate::Error::File { .. })) => Err(e),
            Err(_) => {
                self.report.skipped += 1;
                Ok(())
            }
        }
    }
}

/// Visible files and folders of `dir`. Symlinks are skipped entirely: following them could
/// copy files from outside the vault (e.g. `~/.ssh`) or recurse forever.
fn visible_entries(dir: &Path) -> Result<Vec<PathBuf>> {
    Ok(fs::read_dir(dir)
        .at(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| !t.is_symlink()))
        .map(|e| e.path())
        .filter(|p| !hidden(p))
        .collect())
}

/// A regular file, not a symlink to one.
fn is_plain_file(p: &Path) -> bool {
    fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_file())
}

fn has_markdown(dir: &Path) -> bool {
    visible_entries(dir).is_ok_and(|v| v.iter().any(|p| if p.is_dir() { has_markdown(p) } else { is_md(p) }))
}

/// Characters Windows does not allow in file names.
fn file_name(title: &str) -> String {
    let cleaned: String =
        title
            .chars()
            .map(|c| {
                if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                    '-'
                } else {
                    c
                }
            })
            .collect();
    let mut cleaned: String = cleaned.trim().trim_end_matches('.').chars().take(120).collect();
    cleaned = cleaned.trim_end_matches(['.', ' ']).to_owned();
    // CON, NUL, COM1 … are reserved device names on Windows, also with an extension.
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    let stem = cleaned.split('.').next().unwrap_or("").trim().to_ascii_uppercase();
    if RESERVED.contains(&stem.as_str()) {
        cleaned.push('_');
    }
    if cleaned.is_empty() { "Ohne Titel".into() } else { cleaned }
}

/// Where the export puts one page, relative to the export folder (`/` separated).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PagePath {
    pub page_id: i64,
    /// `Ordner/Titel.md`, `None` for a page with subpages and no content of its own.
    pub file: Option<String>,
    /// `Ordner/Titel` for a page with subpages.
    pub folder: Option<String>,
}

/// Chooses file and folder names like the export: `Titel.md`, then `Titel (2).md`, … when a
/// name is taken (case-insensitive, as on Windows; with `root`, existing files count too).
struct Planner<'a> {
    root: Option<&'a Path>,
    taken: std::collections::HashSet<String>,
}

impl Planner<'_> {
    fn unique(&mut self, dir: &str, base: &str, ext: &str) -> String {
        let join = |name: String| if dir.is_empty() { name } else { format!("{dir}/{name}") };
        let mut candidate = join(format!("{base}{ext}"));
        let mut n = 2;
        while self.taken.contains(&candidate.to_lowercase()) || self.root.is_some_and(|r| r.join(&candidate).exists()) {
            candidate = join(format!("{base} ({n}){ext}"));
            n += 1;
        }
        self.taken.insert(candidate.to_lowercase());
        candidate
    }

    /// Paths of `nodes` and their subpages; `has_content` tells whether a page has text.
    fn plan(&mut self, has_content: &dyn Fn(i64) -> bool, nodes: &[PageNode], dir: &str, out: &mut Vec<PagePath>) {
        for node in nodes {
            let base = file_name(&node.page.title);
            let written = has_content(node.page.id) || node.children.is_empty();
            let file = written.then(|| self.unique(dir, &base, ".md"));
            let folder = (!node.children.is_empty()).then(|| self.unique(dir, &base, ""));
            out.push(PagePath { page_id: node.page.id, file, folder: folder.clone() });
            if let Some(sub) = folder {
                self.plan(has_content, &node.children, &sub, out);
            }
        }
    }
}

/// The path of every page in an export into an empty folder (the Markdown mirror), in tree
/// order. The Git sync maps changed files back to pages with it.
pub fn page_paths(db: &Database) -> Result<Vec<PagePath>> {
    // Only whether a page has text matters here, not the text.
    let filled: std::collections::HashSet<i64> = db
        .conn()
        .prepare_cached("SELECT id FROM pages WHERE deleted_at IS NULL AND content <> ''")?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut out = Vec::new();
    Planner { root: None, taken: Default::default() }.plan(&|id| filled.contains(&id), &db.page_tree()?, "", &mut out);
    Ok(out)
}

/// What an export needs from the database, read at once: the page tree and every page's
/// Markdown (one query, not one per page). Writing the files then needs no database, so
/// the Markdown mirror is written without holding the database.
pub struct VaultSnapshot {
    tree: Vec<PageNode>,
    contents: std::collections::HashMap<i64, String>,
}

impl VaultSnapshot {
    pub fn read(db: &Database) -> Result<Self> {
        let tree = db.page_tree()?;
        let contents = db
            .conn()
            .prepare_cached("SELECT id, content FROM pages WHERE deleted_at IS NULL")?
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(VaultSnapshot { tree, contents })
    }

    fn content(&self, id: i64) -> &str {
        self.contents.get(&id).map_or("", String::as_str)
    }
}

/// Writes every page as a Markdown file below `dir` and the embedded attachments to
/// `dir/attachments/`. Returns the number of Markdown files.
pub fn export_vault(db: &Database, dir: &Path, attachments_dir: &Path) -> Result<usize> {
    export_snapshot(&VaultSnapshot::read(db)?, dir, attachments_dir)
}

/// [`export_vault`] from a [`VaultSnapshot`] (no database access).
pub fn export_snapshot(snap: &VaultSnapshot, dir: &Path, attachments_dir: &Path) -> Result<usize> {
    fs::create_dir_all(dir).at(dir)?;
    let mut planned = Vec::new();
    Planner { root: Some(dir), taken: Default::default() }.plan(
        &|id| !snap.content(id).is_empty(),
        &snap.tree,
        "",
        &mut planned,
    );
    let mut count = 0;
    let mut embedded: Vec<String> = vec![];
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for path in &planned {
        let content = snap.content(path.page_id);
        for name in crate::attachment_manager::export_files(content) {
            if seen.insert(name.clone()) {
                embedded.push(name);
            }
        }
        if let Some(folder) = &path.folder {
            fs::create_dir_all(dir.join(folder)).at(dir.join(folder))?;
        }
        if let Some(file) = &path.file {
            fs::write(dir.join(file), content).at(dir.join(file))?;
            count += 1;
        }
    }
    let out = dir.join(attachments::DIR_NAME);
    for name in embedded {
        if let Some(src) = attachments::resolve(attachments_dir, &name) {
            fs::create_dir_all(&out).at(&out)?;
            crate::error::copy_file(&src, &out.join(&name))?;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-vault-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn imports_obsidian_layout_and_round_trips() {
        let vault = tmp("in");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        fs::write(vault.join(".obsidian/app.json"), "{}").unwrap();
        fs::create_dir_all(vault.join("Projekte/Rollout")).unwrap();
        fs::write(vault.join("Projekte.md"), "Übersicht aller [[Rollout]]-Themen #projekt").unwrap();
        fs::write(vault.join("Projekte/Rollout/Plan.md"), "# Plan\n\nSiehe [[Projekte]]").unwrap();
        fs::write(
            vault.join("Inbox.md"),
            "- [ ] Aufgabe\n\n![[bild.png]]\n\n![[Skizze.excalidraw]]\n\n![[handbuch.pdf#page=2]]",
        )
        .unwrap();
        fs::create_dir_all(vault.join("assets")).unwrap();
        fs::write(vault.join("assets/bild.png"), [7u8; 4]).unwrap();
        // Drawings: the scene and its SVG preview travel like images.
        fs::write(vault.join("assets/Skizze.excalidraw"), r#"{"elements":[]}"#).unwrap();
        fs::write(vault.join("assets/Skizze.excalidraw.svg"), "<svg/>").unwrap();
        // Any file with an extension is an attachment (Obsidian embeds PDFs and other files too).
        fs::write(vault.join("handbuch.pdf"), [0u8; 4]).unwrap();
        fs::write(vault.join("LIESMICH"), "ohne Endung").unwrap();

        let db = Database::open_in_memory().unwrap();
        let att = tmp("att");
        let r = import_vault(&db, &vault, &att).unwrap();
        assert_eq!((r.pages, r.folders, r.attachments, r.skipped), (3, 2, 4, 1));
        assert_eq!(fs::read(att.join("handbuch.pdf")).unwrap(), [0u8; 4]);
        assert_eq!(fs::read(att.join("bild.png")).unwrap(), [7u8; 4]);
        assert!(att.join("Skizze.excalidraw").is_file() && att.join("Skizze.excalidraw.svg").is_file());
        let projekte = db.page_by_title("Projekte").unwrap().unwrap();
        assert_eq!(db.page_doc(projekte.id).unwrap().backlinks.len(), 1, "Plan links to Projekte");
        assert_eq!(db.pages_with_tag("projekt").unwrap().len(), 1);

        let out = tmp("out");
        assert_eq!(export_vault(&db, &out, &att).unwrap(), 3);
        assert_eq!(fs::read(out.join("attachments/bild.png")).unwrap(), [7u8; 4]);
        assert_eq!(fs::read_to_string(out.join("attachments/Skizze.excalidraw")).unwrap(), r#"{"elements":[]}"#);
        assert_eq!(fs::read_to_string(out.join("attachments/Skizze.excalidraw.svg")).unwrap(), "<svg/>");
        assert_eq!(fs::read(out.join("attachments/handbuch.pdf")).unwrap(), [0u8; 4]);
        let root = out.join(vault.file_name().unwrap());
        assert_eq!(fs::read_to_string(root.join("Projekte/Rollout/Plan.md")).unwrap(), "# Plan\n\nSiehe [[Projekte]]");
        assert!(root.join("Projekte.md").is_file());
        assert!(root.join("Inbox.md").is_file());
    }

    #[test]
    fn linked_files_are_exported_and_name_clashes_keep_both_files() {
        let db = Database::open_in_memory().unwrap();
        let att = tmp("att2");
        fs::write(att.join("Angebot.pdf"), "alt").unwrap();
        fs::write(att.join("Plan.xlsx"), "tabelle").unwrap();
        let p = db.create_page(None, "Kunde", None).unwrap();
        db.save_page_content(p.id, "[[Angebot.pdf]] und [Plan](Plan.xlsx)").unwrap();
        let out = tmp("out2");
        export_vault(&db, &out, &att).unwrap();
        assert_eq!(fs::read_to_string(out.join("attachments/Angebot.pdf")).unwrap(), "alt");
        assert_eq!(fs::read_to_string(out.join("attachments/Plan.xlsx")).unwrap(), "tabelle");

        // A vault with another file of the same name: both are kept, the import points to its own.
        let vault = tmp("in2");
        fs::write(vault.join("Angebot.pdf"), "neu").unwrap();
        fs::write(vault.join("Plan.xlsx"), "tabelle").unwrap();
        fs::write(vault.join("Notiz.md"), "![[Angebot.pdf]] [[Angebot.pdf|PDF]] [Plan](Plan.xlsx)").unwrap();
        let r = import_vault(&db, &vault, &att).unwrap();
        assert_eq!(r.attachments, 2);
        assert_eq!(fs::read_to_string(att.join("Angebot.pdf")).unwrap(), "alt", "existing file untouched");
        assert_eq!(fs::read_to_string(att.join("Angebot 2.pdf")).unwrap(), "neu");
        assert!(!att.join("Plan 2.xlsx").exists(), "the same file is not stored twice");
        let notiz = db.page_by_title("Notiz").unwrap().unwrap();
        assert_eq!(
            db.page_doc(notiz.id).unwrap().content,
            "![[Angebot 2.pdf]] [[Angebot 2.pdf|PDF]] [Plan](Plan.xlsx)"
        );
        assert_eq!(db.page_doc(p.id).unwrap().content, "[[Angebot.pdf]] und [Plan](Plan.xlsx)", "other pages kept");
    }

    #[test]
    fn same_named_files_in_two_folders_stay_apart() {
        let vault = tmp("in3");
        for (folder, bytes) in [("Projekt A", "a"), ("Projekt B", "b")] {
            fs::create_dir_all(vault.join(folder).join("assets")).unwrap();
            fs::write(vault.join(folder).join("assets/bild.png"), bytes).unwrap();
            fs::write(vault.join(folder).join("Notiz.md"), "![[bild.png]]").unwrap();
        }
        let db = Database::open_in_memory().unwrap();
        let att = tmp("att3");
        import_vault(&db, &vault, &att).unwrap();
        let content = |folder: &str| {
            let f = db.page_by_title(folder).unwrap().unwrap();
            let tree = db.page_tree().unwrap();
            let find = |nodes: &[PageNode]| -> Option<i64> {
                fn walk(nodes: &[PageNode], parent: i64) -> Option<i64> {
                    for n in nodes {
                        if n.page.parent_id == Some(parent) && n.page.title.starts_with("Notiz") {
                            return Some(n.page.id);
                        }
                        if let Some(x) = walk(&n.children, parent) {
                            return Some(x);
                        }
                    }
                    None
                }
                walk(nodes, f.id)
            };
            db.page_doc(find(&tree).unwrap()).unwrap().content
        };
        let (a, b) = (content("Projekt A"), content("Projekt B"));
        assert_eq!(a, "![[bild.png]]");
        assert_eq!(b, "![[bild 2.png]]");
        assert_eq!(fs::read_to_string(att.join("bild.png")).unwrap(), "a");
        assert_eq!(fs::read_to_string(att.join("bild 2.png")).unwrap(), "b");
    }

    #[test]
    fn old_encodings_and_huge_notes_are_read_with_a_warning() {
        assert_eq!(decode_text(b"Gr\xfc\xdfe \x80 \x84Zitat\x93").0, "Grüße € „Zitat“");
        assert_eq!(decode_text("schon UTF-8: ä".as_bytes()), ("schon UTF-8: ä".to_owned(), false));
        let vault = tmp("in4");
        fs::write(vault.join("Alt.md"), b"Gr\xfc\xdfe").unwrap();
        let big = "ä".repeat(MAX_NOTE_BYTES); // twice the limit in bytes
        fs::write(vault.join("Riesig.md"), &big).unwrap();
        let db = Database::open_in_memory().unwrap();
        let r = import_vault(&db, &vault, &tmp("att4")).unwrap();
        assert_eq!(r.warnings.len(), 2, "{:?}", r.warnings);
        let alt = db.page_by_title("Alt").unwrap().unwrap();
        assert_eq!(db.page_doc(alt.id).unwrap().content, "Grüße");
        let riesig = db.page_by_title("Riesig").unwrap().unwrap();
        let text = db.page_doc(riesig.id).unwrap().content;
        assert!(text.len() < MAX_NOTE_BYTES + 200 && text.contains("Gekürzt beim Import"));
    }

    #[test]
    fn an_import_reports_progress_and_can_be_cancelled() {
        let vault = tmp("in5");
        for i in 0..60 {
            fs::write(vault.join(format!("Notiz {i}.md")), "x").unwrap();
        }
        let att = tmp("att5");
        let mut seen = vec![];
        let plan = plan_import(&vault, &att, &mut |p| seen.push(p), &AtomicBool::new(false)).unwrap();
        assert_eq!(seen.last(), Some(&ImportProgress { done: 60, total: 60 }));
        assert!(seen.len() >= 3);
        let db = Database::open_in_memory().unwrap();
        assert_eq!(apply_import(&db, plan).unwrap().pages, 60);
        let err = plan_import(&vault, &att, &mut |_| {}, &AtomicBool::new(true)).err().unwrap();
        assert_eq!(err.to_string(), "Import abgebrochen");
    }

    #[test]
    fn layout_blocks_survive_import_and_export() {
        // Columns, [TOC], footnotes and foldable callouts (editor 1.3) are plain Markdown text.
        let page = "[TOC]\n\n## Plan\n\n<!-- spalten -->\n\n- [ ] Links [[Ziel]]\n\n<!-- spalte -->\n\nRechts[^1]\n\n<!-- /spalten -->\n\n> [!note]- Details\n> Versteckt\n\n[^1]: Quelle.\n[^2]: Zweite.\n";
        let vault = tmp("layout-in");
        fs::write(vault.join("Layout.md"), page).unwrap();
        let db = Database::open_in_memory().unwrap();
        let att = tmp("layout-att");
        import_vault(&db, &vault, &att).unwrap();
        let id = db.page_by_title("Layout").unwrap().unwrap().id;
        assert_eq!(db.page_doc(id).unwrap().content, page);
        // A task and a link inside a column are still found.
        assert_eq!(db.page_doc(id).unwrap().unresolved_links, vec!["Ziel".to_string()]);
        let out = tmp("layout-out");
        export_vault(&db, &out, &att).unwrap();
        let root = out.join(vault.file_name().unwrap());
        assert_eq!(fs::read_to_string(root.join("Layout.md")).unwrap(), page);
    }

    #[test]
    fn page_paths_match_the_export() {
        let db = Database::open_in_memory().unwrap();
        let a = db.create_page(None, "Projekt", None).unwrap();
        let c = db.create_page(Some(a.id), "Plan: v2", None).unwrap();
        db.save_page_content(c.id, "Plan").unwrap();
        let d = db.create_page(None, "projekt", None).unwrap();
        db.save_page_content(d.id, "Doppelt").unwrap();
        let e = db.create_page(None, "Leer mit Kind", None).unwrap();
        db.create_page(Some(e.id), "Kind", None).unwrap();
        db.save_page_content(a.id, "Übersicht").unwrap();

        let paths = page_paths(&db).unwrap();
        let file = |id: i64| paths.iter().find(|p| p.page_id == id).unwrap().clone();
        assert_eq!(
            file(a.id),
            PagePath { page_id: a.id, file: Some("Projekt.md".into()), folder: Some("Projekt".into()) }
        );
        assert_eq!(file(c.id).file.as_deref(), Some("Projekt/Plan- v2.md"));
        assert_eq!(file(d.id).file.as_deref(), Some("projekt (2).md"), "names differing in case only");
        assert_eq!((file(e.id).file, file(e.id).folder.as_deref()), (None, Some("Leer mit Kind")));

        let out = tmp("paths");
        export_vault(&db, &out, &tmp("paths-att")).unwrap();
        for p in &paths {
            if let Some(f) = &p.file {
                assert_eq!(fs::read_to_string(out.join(f)).unwrap(), db.page_doc(p.page_id).unwrap().content, "{f}");
            }
        }
    }

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(file_name("A/B: C?"), "A-B- C-");
        assert_eq!(file_name("  ...  "), "Ohne Titel");
    }

    #[test]
    fn reserved_and_long_names_are_safe() {
        assert_eq!(file_name("CON"), "CON_");
        assert_eq!(file_name("nul.txt"), "nul.txt_");
        assert_eq!(file_name(&"x".repeat(300)).len(), 120);
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped() {
        use std::os::unix::fs::symlink;
        let outside = tmp("outside");
        fs::write(outside.join("id_rsa.png"), [1u8; 4]).unwrap();
        fs::write(outside.join("Geheim.md"), "geheim").unwrap();
        let vault = tmp("links");
        fs::write(vault.join("Echt.md"), "echt").unwrap();
        symlink(&outside, vault.join("ssh")).unwrap();
        symlink(outside.join("id_rsa.png"), vault.join("key.png")).unwrap();
        symlink(outside.join("Geheim.md"), vault.join("Link.md")).unwrap();
        fs::create_dir_all(vault.join("Ordner")).unwrap();
        fs::write(vault.join("Ordner/Innen.md"), "innen").unwrap();
        symlink(&vault, vault.join("Ordner/schleife")).unwrap();
        symlink(outside.join("Geheim.md"), vault.join("Ordner.md")).unwrap();

        let db = Database::open_in_memory().unwrap();
        let att = tmp("links-att");
        let r = import_vault(&db, &vault, &att).unwrap();
        assert_eq!((r.pages, r.folders, r.attachments, r.skipped), (2, 1, 0, 0));
        assert!(fs::read_dir(&att).unwrap().next().is_none());
        assert!(db.page_by_title("Geheim").unwrap().is_none());
        assert!(db.page_by_title("Link").unwrap().is_none());
        let ordner = db.page_by_title("Ordner").unwrap().unwrap();
        assert_eq!(db.page_doc(ordner.id).unwrap().content, "", "symlinked folder note is not read");
    }
}
