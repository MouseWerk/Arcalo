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

use serde::{Deserialize, Serialize};

use crate::attachments;
use crate::db::Database;
use crate::error::Result;
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
}

fn hidden(p: &Path) -> bool {
    p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with('.') || n == "node_modules")
}

fn is_md(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("md"))
}

fn stem(p: &Path) -> String {
    p.file_stem().and_then(|s| s.to_str()).unwrap_or("Ohne Titel").to_owned()
}

/// Reads a note; invalid UTF-8 (e.g. an old ANSI file) is replaced instead of aborting the import.
fn read_text(p: &Path) -> Result<String> {
    let bytes = fs::read(p)?;
    let text = String::from_utf8_lossy(&bytes);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).replace("\r\n", "\n");
    // Obsidian Tasks marks due dates with a calendar symbol; Annalo writes `due:`.
    Ok(text.replace(&format!("{} ", crate::tasks::OBSIDIAN_DUE), "due:").replace(crate::tasks::OBSIDIAN_DUE, "due:"))
}

/// Imports `dir` under a new top-level page named after the folder; images go to `attachments_dir`.
pub fn import_vault(db: &Database, dir: &Path, attachments_dir: &Path) -> Result<ImportReport> {
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("Import").to_owned();
    db.atomic(|| {
        let root = db.create_page(None, &name, Some("library"))?;
        let mut report = ImportReport { root_page_id: root.id, ..Default::default() };
        import_dir(db, dir, root.id, attachments_dir, &mut report)?;
        Ok(report)
    })
}

/// Copies an image or drawing by its file name (Obsidian resolves embeds by name). An existing
/// file with the same name is kept, so importing twice does not duplicate anything.
fn import_attachment(path: &Path, attachments_dir: &Path) -> Result<bool> {
    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { return Ok(false) };
    if !attachments::embeddable(name) || name.contains(':') {
        return Ok(false);
    }
    fs::create_dir_all(attachments_dir)?;
    let target = attachments_dir.join(name);
    if !target.exists() {
        fs::copy(path, &target)?;
    }
    Ok(true)
}

/// Visible files and folders of `dir`. Symlinks are skipped entirely: following them could
/// copy files from outside the vault (e.g. `~/.ssh`) or recurse forever.
fn visible_entries(dir: &Path) -> Result<Vec<PathBuf>> {
    Ok(fs::read_dir(dir)?
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

fn import_files_only(dir: &Path, attachments_dir: &Path, report: &mut ImportReport) -> Result<()> {
    for path in visible_entries(dir)? {
        if path.is_dir() {
            import_files_only(&path, attachments_dir, report)?;
        } else if import_attachment(&path, attachments_dir)? {
            report.attachments += 1;
        } else {
            report.skipped += 1;
        }
    }
    Ok(())
}

fn import_dir(db: &Database, dir: &Path, parent: i64, attachments_dir: &Path, report: &mut ImportReport) -> Result<()> {
    let mut entries = visible_entries(dir)?;
    entries.sort_by_key(|p| (!p.is_dir(), p.file_name().map(|n| n.to_ascii_lowercase())));

    // Full folder names: `v1.2/` pairs with `v1.2.md`, whose stem is also `v1.2`.
    let folder_names: Vec<String> =
        entries.iter().filter(|p| p.is_dir()).filter_map(|p| p.file_name()?.to_str().map(str::to_owned)).collect();
    for path in &entries {
        if path.is_dir() && !has_markdown(path) {
            // Pure attachment folders (`assets/`) do not become pages.
            import_files_only(path, attachments_dir, report)?;
        } else if path.is_dir() {
            let title = path.file_name().and_then(|n| n.to_str()).unwrap_or("Ordner").to_owned();
            let note = dir.join(format!("{title}.md"));
            let page = db.create_page(Some(parent), &title, Some("folder"))?;
            if is_plain_file(&note) {
                db.save_page_content(page.id, &read_text(&note)?)?;
                report.pages += 1;
            }
            report.folders += 1;
            import_dir(db, path, page.id, attachments_dir, report)?;
        } else if is_md(path) {
            let title = stem(path);
            if folder_names.iter().any(|f| f == &title) {
                continue; // folder note, already used as the folder page's content
            }
            let page = db.create_page(Some(parent), &title, Some("file-text"))?;
            db.save_page_content(page.id, &read_text(path)?)?;
            report.pages += 1;
        } else if import_attachment(path, attachments_dir)? {
            report.attachments += 1;
        } else {
            report.skipped += 1;
        }
    }
    Ok(())
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

fn unique(dir: &Path, base: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{base}{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{base} ({n}){ext}"));
        n += 1;
    }
    candidate
}

/// Writes every page as a Markdown file below `dir` and the embedded images to
/// `dir/attachments/`. Returns the number of Markdown files.
pub fn export_vault(db: &Database, dir: &Path, attachments_dir: &Path) -> Result<usize> {
    fs::create_dir_all(dir)?;
    let mut count = 0;
    let mut embedded: Vec<String> = vec![];
    for node in db.page_tree()? {
        export_node(db, &node, dir, &mut count, &mut embedded)?;
    }
    let out = dir.join(attachments::DIR_NAME);
    for name in embedded {
        if let Some(src) = attachments::resolve(attachments_dir, &name) {
            fs::create_dir_all(&out)?;
            fs::copy(src, out.join(&name))?;
        }
    }
    Ok(count)
}

fn export_node(
    db: &Database,
    node: &PageNode,
    dir: &Path,
    count: &mut usize,
    embedded: &mut Vec<String>,
) -> Result<()> {
    let base = file_name(&node.page.title);
    let content = db.page_doc(node.page.id)?.content;
    for name in attachments::embeds(&content) {
        if !embedded.contains(&name) {
            embedded.push(name);
        }
    }
    let file = unique(dir, &base, ".md");
    if !content.is_empty() || node.children.is_empty() {
        fs::write(&file, content)?;
        *count += 1;
    }
    if !node.children.is_empty() {
        let sub = unique(dir, &base, "");
        fs::create_dir_all(&sub)?;
        for child in &node.children {
            export_node(db, child, &sub, count, embedded)?;
        }
    }
    Ok(())
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
        fs::write(vault.join("Inbox.md"), "- [ ] Aufgabe\n\n![[bild.png]]\n\n![[Skizze.excalidraw]]").unwrap();
        fs::create_dir_all(vault.join("assets")).unwrap();
        fs::write(vault.join("assets/bild.png"), [7u8; 4]).unwrap();
        // Drawings: the scene and its SVG preview travel like images.
        fs::write(vault.join("assets/Skizze.excalidraw"), r#"{"elements":[]}"#).unwrap();
        fs::write(vault.join("assets/Skizze.excalidraw.svg"), "<svg/>").unwrap();
        fs::write(vault.join("handbuch.pdf"), [0u8; 4]).unwrap();

        let db = Database::open_in_memory().unwrap();
        let att = tmp("att");
        let r = import_vault(&db, &vault, &att).unwrap();
        assert_eq!((r.pages, r.folders, r.attachments, r.skipped), (3, 2, 3, 1));
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
        let root = out.join(vault.file_name().unwrap());
        assert_eq!(fs::read_to_string(root.join("Projekte/Rollout/Plan.md")).unwrap(), "# Plan\n\nSiehe [[Projekte]]");
        assert!(root.join("Projekte.md").is_file());
        assert!(root.join("Inbox.md").is_file());
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
