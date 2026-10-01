//! Browser bookmarks for the ribbon: reads them read-only from the local profiles of the
//! Chromium family (Chrome, Edge, Brave, Vivaldi, Opera, Arc, Chromium), Firefox and Safari, or
//! from a Netscape HTML export, into one tree of folders and bookmarks. Nothing here writes to
//! a browser's files: Firefox's database is read from a copy.
//!
//! Only `http`, `https` and `file` addresses are kept; bookmarklets (`javascript:`) and the
//! browsers' own pages (`chrome://`, `about:`, `place:` …) are listed as skipped. Folders that
//! end up without a bookmark are left out.

use serde::{Deserialize, Serialize};

pub mod chromium;
pub mod discover;
pub mod firefox;
pub mod html;
pub mod safari;

pub use discover::{Location, Os, Roots, Source, SourceStatus};

/// At most this many bookmarks are read from one source (a runaway file stays harmless).
pub const MAX_BOOKMARKS: usize = 50_000;
/// Folders nested deeper than this are not followed.
pub const MAX_DEPTH: usize = 64;

/// A folder (no `url`) or a bookmark.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub title: String,
    /// The address of a bookmark; `None` for a folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// When it was added (Unix seconds), where the browser keeps it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub added: Option<i64>,
    /// What a top folder of the browser is: `bar` (bookmarks bar / toolbar / favorites bar),
    /// `menu`, `other`, `mobile` or `reading` (Safari's reading list).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Node>,
}

impl Node {
    pub fn folder(title: impl Into<String>, role: Option<&str>) -> Node {
        Node { title: title.into(), role: role.map(str::to_owned), ..Default::default() }
    }

    pub fn is_folder(&self) -> bool {
        self.url.is_none()
    }

    /// Bookmarks in this folder and its subfolders (1 for a bookmark).
    pub fn count(&self) -> usize {
        if self.is_folder() { self.children.iter().map(Node::count).sum() } else { 1 }
    }
}

/// Why an entry was not taken over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkipReason {
    /// A bookmarklet (`javascript:`).
    Script,
    /// A page of the browser itself (`chrome://`, `about:`, `place:`, extensions …).
    Internal,
    /// Any other scheme (`ftp:`, `mailto:`, `data:` …).
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Skipped {
    pub title: String,
    pub url: String,
    pub reason: SkipReason,
}

/// What a source holds: the top folders (and loose bookmarks) in the browser's order.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Tree {
    pub roots: Vec<Node>,
    /// Entries left out (bookmarklets, browser pages), in reading order.
    pub skipped: Vec<Skipped>,
    /// Bookmarks in `roots`.
    pub links: usize,
    /// More than [`MAX_BOOKMARKS`] were found; the rest was not read.
    pub truncated: bool,
}

/// Whether an address can go into the ribbon: `Err` says why not.
pub fn classify(url: &str) -> Result<(), SkipReason> {
    let u = url.trim();
    let Some((scheme, _)) = u.split_once(':') else { return Err(SkipReason::Other) };
    let scheme = scheme.to_ascii_lowercase();
    match scheme.as_str() {
        "http" | "https" | "file" => Ok(()),
        "javascript" => Err(SkipReason::Script),
        "chrome" | "chrome-extension" | "chrome-search" | "chrome-native" | "edge" | "brave" | "vivaldi" | "opera"
        | "arc" | "about" | "place" | "moz-extension" | "resource" | "view-source" | "extension"
        | "safari-extension" | "devtools" => Err(SkipReason::Internal),
        _ => Err(SkipReason::Other),
    }
}

/// Collects the bookmarks of one source: filters addresses, counts, stops at the limit.
#[derive(Debug, Default)]
pub struct Collector {
    skipped: Vec<Skipped>,
    links: usize,
    truncated: bool,
}

impl Collector {
    /// A bookmark node for `url`, or `None` when it is skipped (or the limit is reached).
    pub fn link(&mut self, title: &str, url: &str, added: Option<i64>) -> Option<Node> {
        let url = url.trim();
        let title = title.trim();
        if let Err(reason) = classify(url) {
            if self.skipped.len() < 1000 {
                self.skipped.push(Skipped { title: title.to_owned(), url: url.chars().take(300).collect(), reason });
            }
            return None;
        }
        if self.links >= MAX_BOOKMARKS {
            self.truncated = true;
            return None;
        }
        self.links += 1;
        let title = if title.is_empty() { url.to_owned() } else { title.to_owned() };
        Some(Node { title, url: Some(url.to_owned()), added: added.filter(|t| *t > 0), ..Default::default() })
    }

    /// The tree of `roots` without empty folders.
    pub fn finish(self, roots: Vec<Node>) -> Tree {
        let roots: Vec<Node> = roots.into_iter().filter_map(prune).collect();
        let links = roots.iter().map(Node::count).sum();
        Tree { roots, skipped: self.skipped, links, truncated: self.truncated }
    }
}

/// The folder without empty subfolders, or `None` when nothing is left in it.
fn prune(mut n: Node) -> Option<Node> {
    if !n.is_folder() {
        return Some(n);
    }
    n.children = std::mem::take(&mut n.children).into_iter().filter_map(prune).collect();
    (!n.children.is_empty()).then_some(n)
}

/// Reads an exported file: a Netscape bookmarks HTML file, or a Chromium `Bookmarks` JSON file.
pub fn parse_export(text: &str) -> crate::Result<Tree> {
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if head.starts_with('{') {
        return chromium::parse(text);
    }
    let lower = head.get(..head.len().min(4096)).unwrap_or(head).to_ascii_lowercase();
    if lower.contains("netscape-bookmark") || lower.contains("<dl") || lower.contains("<dt") {
        return Ok(html::parse(text));
    }
    Err(crate::Error::Parse("Keine Lesezeichen-Datei (erwartet: HTML-Export eines Browsers)".into()))
}

/// The largest export file that is read.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// Reads an exported bookmarks file from disk (see [`parse_export`]).
pub fn read_export_file(path: &std::path::Path) -> crate::Result<Tree> {
    let meta = std::fs::metadata(path).map_err(|e| crate::Error::file(path, e))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(crate::Error::State("Die Datei ist zu groß für einen Lesezeichen-Export.".into()));
    }
    let bytes = std::fs::read(path).map_err(|e| crate::Error::file(path, e))?;
    parse_export(&String::from_utf8_lossy(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_and_file_addresses_are_kept() {
        assert_eq!(classify("https://a.de"), Ok(()));
        assert_eq!(classify("HTTP://a.de"), Ok(()));
        assert_eq!(classify("file:///C:/x"), Ok(()));
        assert_eq!(classify("javascript:alert(1)"), Err(SkipReason::Script));
        assert_eq!(classify("chrome://settings"), Err(SkipReason::Internal));
        assert_eq!(classify("about:blank"), Err(SkipReason::Internal));
        assert_eq!(classify("place:sort=8"), Err(SkipReason::Internal));
        assert_eq!(classify("ftp://x"), Err(SkipReason::Other));
        assert_eq!(classify("no scheme"), Err(SkipReason::Other));
    }

    #[test]
    fn empty_folders_are_pruned() {
        let mut c = Collector::default();
        let mut f = Node::folder("A", None);
        f.children.push(Node::folder("leer", None));
        f.children.extend(c.link("x", "javascript:void(0)", None));
        let mut g = Node::folder("B", Some("bar"));
        g.children.extend(c.link("", "https://b.de", Some(5)));
        let t = c.finish(vec![f, g]);
        assert_eq!(t.roots.len(), 1);
        assert_eq!(t.roots[0].children[0].title, "https://b.de");
        assert_eq!(t.links, 1);
        assert_eq!(t.skipped.len(), 1);
    }
}
