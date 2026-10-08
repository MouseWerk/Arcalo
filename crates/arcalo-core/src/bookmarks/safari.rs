//! Safari (macOS): `~/Library/Safari/Bookmarks.plist`, a binary property list of nested
//! dictionaries (`WebBookmarkTypeList` = folder, `WebBookmarkTypeLeaf` = bookmark). macOS only
//! lets apps with „Festplattenvollzugriff“ read it.

use plist::{Dictionary, Value};

use super::{Collector, MAX_DEPTH, Node, Tree};
use crate::{Error, Result};

/// Shown when macOS refuses access to Safari's file.
pub fn no_access() -> &'static str {
    crate::tr!(
        "Kein Zugriff auf Safaris Lesezeichen. Arcalo in den Systemeinstellungen unter „Datenschutz & Sicherheit → Festplattenvollzugriff“ erlauben oder in Safari „Ablage → Exportieren → Lesezeichen …“ wählen und die HTML-Datei importieren.",
        "No access to Safari's bookmarks. Allow Arcalo under System Settings → “Privacy & Security → Full Disk Access”, or choose “File → Export → Bookmarks …” in Safari and import the HTML file."
    )
}

/// Whether an I/O error is macOS refusing access (TCC answers with EPERM).
pub fn is_denied(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(1)
}

/// Reads Safari's bookmarks file.
pub fn read(path: &std::path::Path) -> Result<Tree> {
    let bytes = std::fs::read(path)
        .map_err(|e| if is_denied(&e) { Error::State(no_access().into()) } else { Error::file(path, e) })?;
    parse(&bytes)
}

pub fn parse(bytes: &[u8]) -> Result<Tree> {
    let v = Value::from_reader(std::io::Cursor::new(bytes))
        .map_err(|e| Error::Parse(crate::trf!("Safari-Lesezeichen: {e}", "Safari bookmarks: {e}")))?;
    let root = v.as_dictionary().ok_or_else(|| {
        Error::Parse(
            crate::tr!("Safari-Lesezeichen: unerwartetes Format", "Safari bookmarks: unexpected format").into(),
        )
    })?;
    let mut c = Collector::default();
    let mut roots = Vec::new();
    let mut loose = Vec::new();
    for child in children(root) {
        let Some(d) = child.as_dictionary() else { continue };
        match kind(d) {
            "WebBookmarkTypeList" => {
                // Safari's own folders get their name from their role (in the display language).
                let (title, role) = match str_of(d, "Title") {
                    "BookmarksBar" => ("", Some("bar")),
                    "BookmarksMenu" => ("", Some("menu")),
                    "com.apple.ReadingList" => ("", Some("reading")),
                    t => (t, None),
                };
                let mut f = Node::folder(title, role);
                f.children = list(&mut c, d, 1);
                roots.push(f);
            }
            "WebBookmarkTypeLeaf" => loose.extend(leaf(&mut c, d)),
            _ => {}
        }
    }
    roots.extend(loose);
    Ok(c.finish(roots))
}

fn children(d: &Dictionary) -> impl Iterator<Item = &Value> {
    d.get("Children").and_then(Value::as_array).into_iter().flatten()
}

fn kind(d: &Dictionary) -> &str {
    str_of(d, "WebBookmarkType")
}

fn str_of<'a>(d: &'a Dictionary, key: &str) -> &'a str {
    d.get(key).and_then(Value::as_string).unwrap_or_default()
}

fn list(c: &mut Collector, d: &Dictionary, depth: usize) -> Vec<Node> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let mut out = Vec::new();
    for child in children(d) {
        let Some(cd) = child.as_dictionary() else { continue };
        match kind(cd) {
            "WebBookmarkTypeList" => {
                let mut f = Node::folder(str_of(cd, "Title").trim(), None);
                f.children = list(c, cd, depth + 1);
                out.push(f);
            }
            "WebBookmarkTypeLeaf" => out.extend(leaf(c, cd)),
            // Proxies (History) and anything newer.
            _ => {}
        }
    }
    out
}

fn leaf(c: &mut Collector, d: &Dictionary) -> Option<Node> {
    let title = d.get("URIDictionary").and_then(Value::as_dictionary).map(|u| str_of(u, "title")).unwrap_or_default();
    let added = d
        .get("ReadingList")
        .and_then(Value::as_dictionary)
        .and_then(|r| r.get("DateAdded"))
        .and_then(Value::as_date)
        .and_then(|t| std::time::SystemTime::from(t).duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64);
    c.link(title, str_of(d, "URLString"), added)
}

/// A binary `Bookmarks.plist` like Safari's, for tests: folders are `(title, children)`,
/// bookmarks `(title, url)` with an empty children list and `Some(url)`.
#[doc(hidden)]
pub fn write_fixture(path: &std::path::Path, root: &[FixtureNode]) -> Result<()> {
    let mut d = Dictionary::new();
    d.insert("WebBookmarkType".into(), Value::String("WebBookmarkTypeList".into()));
    d.insert("Title".into(), Value::String(String::new()));
    d.insert("Children".into(), Value::Array(root.iter().map(fixture_value).collect()));
    Value::Dictionary(d).to_file_binary(path).map_err(|e| Error::State(e.to_string()))
}

#[doc(hidden)]
pub enum FixtureNode {
    Folder(&'static str, Vec<FixtureNode>),
    Leaf(&'static str, &'static str),
    Proxy(&'static str),
}

fn fixture_value(n: &FixtureNode) -> Value {
    let mut d = Dictionary::new();
    match n {
        FixtureNode::Folder(title, kids) => {
            d.insert("WebBookmarkType".into(), Value::String("WebBookmarkTypeList".into()));
            d.insert("Title".into(), Value::String((*title).into()));
            d.insert("Children".into(), Value::Array(kids.iter().map(fixture_value).collect()));
        }
        FixtureNode::Leaf(title, url) => {
            let mut u = Dictionary::new();
            u.insert("title".into(), Value::String((*title).into()));
            d.insert("WebBookmarkType".into(), Value::String("WebBookmarkTypeLeaf".into()));
            d.insert("URLString".into(), Value::String((*url).into()));
            d.insert("URIDictionary".into(), Value::Dictionary(u));
        }
        FixtureNode::Proxy(title) => {
            d.insert("WebBookmarkType".into(), Value::String("WebBookmarkTypeProxy".into()));
            d.insert("Title".into(), Value::String((*title).into()));
        }
    }
    Value::Dictionary(d)
}
