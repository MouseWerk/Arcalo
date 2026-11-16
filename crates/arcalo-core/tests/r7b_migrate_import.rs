//! q124 round 7 (hunt B): an Obsidian vault and the command line's neighbours as data.

use std::fs;
use std::path::PathBuf;

use arcalo_core::Database;
use arcalo_core::model::PageNode;
use arcalo_core::vault::import_vault;

/// A fresh, empty folder (removed on drop).
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "arcalo-r7b-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// The page at `path` (titles from the top level down), if any.
fn page_at(db: &Database, path: &[&str]) -> Option<i64> {
    fn walk(nodes: &[PageNode], path: &[&str]) -> Option<i64> {
        let (first, rest) = path.split_first()?;
        let n = nodes.iter().find(|n| n.page.title == *first)?;
        if rest.is_empty() { Some(n.page.id) } else { walk(&n.children, rest) }
    }
    walk(&db.page_tree().unwrap(), path)
}

/// A note next to a folder of the same name that holds only its files (Notion's export layout:
/// `Reise.md` and `Reise/` with its images) is a page of the vault like every other note.
#[test]
fn a_note_next_to_a_folder_of_its_files_is_imported() {
    let vault = TempDir::new("vault");
    let root = vault.0.join("Notizen");
    fs::create_dir_all(root.join("Reise")).unwrap();
    fs::write(root.join("Reise.md"), "# Reise\n\nPackliste und Route.\n\n![](Reise/karte.png)\n").unwrap();
    fs::write(root.join("Reise/karte.png"), [0x89, b'P', b'N', b'G', 1, 2, 3]).unwrap();
    fs::write(root.join("Andere.md"), "Text").unwrap();
    let att = TempDir::new("att");
    let db = Database::open_in_memory().unwrap();
    let report = import_vault(&db, &root, &att.0).unwrap();
    assert_eq!(report.attachments, 1);
    let page = page_at(&db, &["Notizen", "Reise"]);
    assert!(page.is_some(), "the note Reise.md is missing after the import (report: {} pages)", report.pages);
    assert!(db.page_doc(page.unwrap()).unwrap().content.contains("Packliste und Route."));
}

/// A bare file name in a note names the file next to it (its own folder first, then one above).
/// With `Projekt/bild.png` and `Projekt/Unter/bild.png`, the note in `Unter` keeps showing its own
/// image, not the one of the folder above.
#[test]
fn a_bare_embed_keeps_the_file_of_its_own_folder_when_a_folder_above_has_one_of_that_name() {
    let vault = TempDir::new("vault");
    let root = vault.0.join("Vault");
    fs::create_dir_all(root.join("Projekt/Unter")).unwrap();
    fs::write(root.join("Projekt/bild.png"), "oben").unwrap();
    fs::write(root.join("Projekt/Plan.md"), "![[bild.png]]").unwrap();
    fs::write(root.join("Projekt/Unter/bild.png"), "unten").unwrap();
    fs::write(root.join("Projekt/Unter/Notiz.md"), "![[bild.png]]").unwrap();
    let att = TempDir::new("att");
    let db = Database::open_in_memory().unwrap();
    import_vault(&db, &root, &att.0).unwrap();
    let shown = |path: &[&str]| {
        let content = db.page_doc(page_at(&db, path).unwrap()).unwrap().content;
        let name = content.trim().trim_start_matches("![[").trim_end_matches("]]").to_owned();
        fs::read_to_string(att.0.join(&name)).unwrap_or_else(|_| format!("<no file {name}>"))
    };
    assert_eq!(shown(&["Vault", "Projekt", "Plan"]), "oben", "the note in Projekt");
    assert_eq!(shown(&["Vault", "Projekt", "Unter", "Notiz"]), "unten", "the note in Projekt/Unter");
}

/// Obsidian writes a link with its path when two notes share a name, and always with the link
/// format „Absolute path in vault“ or „Relative path to file“: `[[Projekte/Plan]]`,
/// `[[Projekte/Plan|der Plan]]`. After the import such a link names the imported page, as it
/// did in the vault (no missing page, no new empty page „Projekte/Plan“ on a click).
#[test]
fn links_with_a_vault_path_name_the_imported_page() {
    let vault = TempDir::new("vault");
    let root = vault.0.join("Vault");
    fs::create_dir_all(root.join("Projekte")).unwrap();
    fs::write(root.join("Projekte/Plan.md"), "Der Plan").unwrap();
    fs::write(root.join("Start.md"), "Siehe [[Projekte/Plan]] und [[Projekte/Plan|den Plan]].\n").unwrap();
    let att = TempDir::new("att");
    let db = Database::open_in_memory().unwrap();
    import_vault(&db, &root, &att.0).unwrap();
    let start = page_at(&db, &["Vault", "Start"]).unwrap();
    assert!(page_at(&db, &["Vault", "Projekte", "Plan"]).is_some());
    let content = db.page_doc(start).unwrap().content;
    let missing = db.unresolved_links(db.outgoing_links(start, &content).unwrap()).unwrap();
    assert!(missing.is_empty(), "links naming no page after the import: {missing:?} in {content:?}");
}
