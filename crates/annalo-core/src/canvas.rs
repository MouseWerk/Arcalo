//! Canvas pages: an infinite board of cards and connections, stored as a JSON Canvas document
//! (jsoncanvas.org, the format of Obsidian's `.canvas` files) in `pages.content`, exactly as
//! written. Nodes are `text`, `file`, `link` and `group`; edges join two nodes. Arcalo's own
//! additions are extra fields the format allows (`issue` on a link node for a Jira issue,
//! `path` on an edge for a straight line), so Obsidian opens the files and keeps them.
//!
//! The text never goes through a JSON serializer here: the derived indexes read it, and
//! rewrites (a renamed page or attachment) replace single string values in place
//! ([`rewrite_strings`]), so unknown fields, their order and the formatting stay untouched.
//!
//! - A note card is a `file` node with the page's mirror path (`Ordner/Titel.md`); it counts as
//!   a link to that page (backlinks, rename), resolved by the file's stem like a `[[link]]`.
//! - Other `file` nodes are attachments (`attachments/bild.png`), exported with the canvas.
//! - Text cards are Markdown: their `[[links]]` and `#tags` count like a note's.

use rusqlite::{OptionalExtension, params};
use serde::Deserialize;
use serde_json::Value;

use crate::db::Database;
use crate::error::Result;
use crate::model::Page;

/// `pages.kind` of a canvas.
pub const KIND: &str = "canvas";
/// File extension of a canvas in the mirror, the vault export and the Git sync.
pub const EXTENSION: &str = "canvas";
/// A new, empty canvas (Obsidian writes the same).
pub const EMPTY: &str = "{\"nodes\":[],\"edges\":[]}";

/// True for a `.canvas` file name or path.
pub fn is_canvas_path(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| ext.eq_ignore_ascii_case(EXTENSION))
}

#[derive(Deserialize, Default)]
struct Doc {
    #[serde(default)]
    nodes: Vec<Value>,
    #[serde(default)]
    edges: Vec<Value>,
}

fn doc(content: &str) -> Doc {
    if content.trim().is_empty() {
        return Doc::default();
    }
    serde_json::from_str(content).unwrap_or_default()
}

/// True when `content` is a JSON Canvas document (an object; `nodes` and `edges`, where
/// present, are arrays of objects with an `id`).
pub fn is_valid(content: &str) -> bool {
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(content) else { return false };
    ["nodes", "edges"].iter().all(|k| match map.get(*k) {
        None => true,
        Some(Value::Array(items)) => items.iter().all(|n| n.get("id").is_some_and(Value::is_string)),
        Some(_) => false,
    })
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// The last path component of a `file` value (`Ordner/Plan.md` → `Plan.md`).
fn base_name(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// The page title a note card's file names (`Ordner/Plan.md` → `Plan`), `None` for other files.
pub fn note_title(path: &str) -> Option<&str> {
    let name = base_name(path);
    let (stem, ext) = name.rsplit_once('.')?;
    (ext.eq_ignore_ascii_case("md") && !stem.trim().is_empty()).then_some(stem)
}

/// Text cards' Markdown, in node order.
fn texts(d: &Doc) -> impl Iterator<Item = &str> {
    d.nodes.iter().filter(|n| str_field(n, "type") == Some("text")).filter_map(|n| str_field(n, "text"))
}

/// The pages the canvas links to: note cards (by title) and `[[links]]` in text cards, in
/// order, without repeats (case-insensitive).
pub fn links(content: &str) -> Vec<String> {
    let d = doc(content);
    let mut out: Vec<String> = vec![];
    let mut push = |t: String| {
        if !out.iter().any(|o| o.eq_ignore_ascii_case(&t)) {
            out.push(t);
        }
    };
    for n in &d.nodes {
        if str_field(n, "type") == Some("file")
            && let Some(title) = str_field(n, "file").and_then(note_title)
        {
            push(title.to_owned());
        }
    }
    for text in texts(&d) {
        for l in crate::notes::wiki_links(text) {
            push(l);
        }
    }
    out
}

/// Attachments the canvas shows (file cards other than notes), by file name.
pub fn files(content: &str) -> Vec<String> {
    let d = doc(content);
    let mut out: Vec<String> = vec![];
    for n in &d.nodes {
        if str_field(n, "type") != Some("file") {
            continue;
        }
        let Some(path) = str_field(n, "file") else { continue };
        let name = base_name(path);
        if note_title(path).is_none() && !name.is_empty() && !out.iter().any(|o| o == name) {
            out.push(name.to_owned());
        }
    }
    // Images and files embedded in text cards travel too.
    for text in texts(&d) {
        for name in crate::attachment_manager::export_files(text) {
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// What search, tags and the assistant see of a canvas: the text cards' Markdown, group
/// labels, link cards and the titles of note and file cards, one block per card.
pub fn index_markdown(content: &str) -> String {
    let d = doc(content);
    let mut parts: Vec<String> = vec![];
    for n in &d.nodes {
        let part = match str_field(n, "type") {
            Some("text") => str_field(n, "text").map(str::to_owned),
            Some("group") => str_field(n, "label").map(|l| format!("## {l}")),
            Some("link") => {
                str_field(n, "url").map(|u| str_field(n, "issue").map_or_else(|| u.to_owned(), |k| format!("{k} {u}")))
            }
            Some("file") => str_field(n, "file").map(|f| note_title(f).unwrap_or(base_name(f)).to_owned()),
            _ => None,
        };
        if let Some(p) = part.filter(|p| !p.trim().is_empty()) {
            parts.push(p);
        }
    }
    for e in &d.edges {
        if let Some(l) = str_field(e, "label").filter(|l| !l.trim().is_empty()) {
            parts.push(l.to_owned());
        }
    }
    parts.join("\n\n")
}

/// Rewrites string values in place: `f(key, value)` returns the new value of a member
/// `"key": "value"` (at any depth) or `None` to keep it. Everything else of the text (other
/// fields, their order, white space, escapes) stays byte for byte. Text that is no JSON is
/// returned unchanged.
pub fn rewrite_strings(json: &str, mut f: impl FnMut(&str, &str) -> Option<String>) -> String {
    let bytes = json.as_bytes();
    let mut out = String::with_capacity(json.len());
    let mut copied = 0;
    let mut i = 0;
    // The key whose value comes next (set after `"key":`).
    let mut key: Option<String> = None;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => {
                let start = i;
                i += 1;
                while i < bytes.len() && bytes[i] != b'"' {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                if i >= bytes.len() {
                    return json.to_owned();
                }
                let end = i + 1;
                i = end;
                let Ok(text) = serde_json::from_str::<String>(&json[start..end]) else { return json.to_owned() };
                let mut j = i;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
                if j < bytes.len() && bytes[j] == b':' {
                    key = Some(text);
                    i = j + 1;
                    continue;
                }
                if let Some(k) = key.take()
                    && let Some(new) = f(&k, &text)
                    && new != text
                {
                    out.push_str(&json[copied..start]);
                    out.push_str(&serde_json::to_string(&new).unwrap_or_default());
                    copied = end;
                }
            }
            b if b.is_ascii_whitespace() => i += 1,
            _ => {
                key = None;
                i += 1;
            }
        }
    }
    out.push_str(&json[copied..]);
    out
}

/// After page `old` was renamed to `new`: note cards that named it point to the new file name
/// (same folder) and `[[links]]` in text cards follow, like in notes.
pub fn rename_page(content: &str, old: &str, new: &str) -> String {
    rewrite_strings(content, |key, value| match key {
        "file" => {
            let title = note_title(value)?;
            if !title.eq_ignore_ascii_case(old) && title.to_lowercase() != old.to_lowercase() {
                return None;
            }
            let dir = &value[..value.len() - base_name(value).len()];
            Some(format!("{dir}{}.md", crate::vault::file_name(new)))
        }
        "text" => Some(crate::notes::replace_link_target(value, old, new)),
        _ => None,
    })
}

/// After an attachment was renamed (or stored under another name on import): file cards and
/// embeds in text cards follow.
pub fn rename_file(content: &str, old: &str, new: &str) -> String {
    rewrite_strings(content, |key, value| match key {
        "file" if base_name(value).eq_ignore_ascii_case(old) => {
            Some(format!("{}{new}", &value[..value.len() - base_name(value).len()]))
        }
        "text" => Some(crate::attachment_manager::replace_file_refs(value, old, new)),
        _ => None,
    })
}

/// For an export into a vault: note cards point to the pages' current files (`paths`: the
/// lower-cased title → the file in the export), so Obsidian finds them after moves.
pub fn with_paths(content: &str, paths: &std::collections::HashMap<String, String>) -> String {
    rewrite_strings(content, |key, value| {
        if key != "file" {
            return None;
        }
        paths.get(&note_title(value)?.to_lowercase()).cloned()
    })
}

impl Database {
    /// `pages.kind` of a page (`None`: a note).
    pub fn page_kind(&self, id: i64) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT kind FROM pages WHERE id = ?1", [id], |r| r.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    pub(crate) fn is_canvas(&self, id: i64) -> Result<bool> {
        Ok(self.page_kind(id)?.as_deref() == Some(KIND))
    }

    /// Makes a page a canvas (`content`: its JSON Canvas document; an empty board when blank).
    pub fn make_canvas(&self, id: i64, content: &str) -> Result<()> {
        let content = if content.trim().is_empty() { EMPTY } else { content };
        if !is_valid(content) {
            return Err(crate::Error::State(
                crate::tr!("Keine gültige Canvas-Datei (JSON Canvas)", "Not a valid canvas file (JSON Canvas)").into(),
            ));
        }
        self.atomic(|| {
            self.conn().execute("UPDATE pages SET kind = ?2 WHERE id = ?1", params![id, KIND])?;
            self.save_page_content(id, content)
        })
    }

    /// A new canvas below `parent_id`, or filed like the app's own pages (Settings → Ordner &
    /// Ablage, type „Canvas“) when there is none.
    pub fn create_canvas(&self, parent_id: Option<i64>, title: &str, today: chrono::NaiveDate) -> Result<Page> {
        self.atomic(|| {
            let page = match parent_id {
                Some(p) => self.create_page(Some(p), title, Some(ICON))?,
                None => self.create_filed_page(crate::filing::FileType::Canvas, title, Some(ICON), "", today)?.0,
            };
            self.make_canvas(page.id, EMPTY)?;
            self.page(page.id)
        })
    }
}

/// Page icon of a canvas.
pub const ICON: &str = "canvas";

#[cfg(test)]
mod tests {
    use super::*;

    const OBSIDIAN: &str = r##"{
	"nodes":[
		{"id":"a1","type":"text","text":"# Phase 1\nSee [[Kickoff]] #sap","x":-120,"y":40,"width":250,"height":140,"color":"4"},
		{"id":"b2","type":"file","file":"Projekte/SAP Rollout.md","x":200,"y":40,"width":400,"height":300,"subpath":"#Ziele"},
		{"id":"c3","type":"file","file":"assets/plan.png","x":0,"y":400,"width":300,"height":200},
		{"id":"d4","type":"link","url":"https://jira.example.com/browse/SAP-12","issue":"SAP-12","x":0,"y":0,"width":200,"height":80},
		{"id":"g1","type":"group","label":"Vorbereitung","x":-200,"y":-40,"width":900,"height":700,"background":"bg.png","backgroundStyle":"cover","futureField":{"nested":[1,2,"x"]}}
	],
	"edges":[
		{"id":"e1","fromNode":"a1","fromSide":"right","toNode":"b2","toSide":"left","toEnd":"arrow","label":"führt zu","color":"#ff8800","path":"straight"}
	],
	"x-unknown-top":true
}"##;

    #[test]
    fn reads_links_files_and_text_of_a_canvas() {
        assert!(is_valid(OBSIDIAN));
        assert!(is_valid(EMPTY));
        assert!(!is_valid("[1,2]") && !is_valid("{\"nodes\":{}}") && !is_valid("{\"nodes\":[{\"x\":1}]}"));
        assert_eq!(links(OBSIDIAN), ["SAP Rollout", "Kickoff"]);
        assert_eq!(files(OBSIDIAN), ["plan.png"]);
        let text = index_markdown(OBSIDIAN);
        assert!(text.contains("# Phase 1") && text.contains("## Vorbereitung") && text.contains("SAP-12 https://"));
        assert!(text.contains("führt zu") && text.contains("SAP Rollout"));
        assert!(is_canvas_path("Board.CANVAS") && !is_canvas_path("Board.md"));
        assert_eq!(note_title("a/b/Plan v1.2.md"), Some("Plan v1.2"));
        assert_eq!(links("kaputt"), Vec::<String>::new());
    }

    #[test]
    fn rewrites_keep_everything_else_byte_for_byte() {
        // Nothing to change: the very same text.
        assert_eq!(rewrite_strings(OBSIDIAN, |_, _| None), OBSIDIAN);
        let renamed = rename_page(OBSIDIAN, "SAP Rollout", "SAP Einführung");
        assert_eq!(renamed, OBSIDIAN.replace("Projekte/SAP Rollout.md", "Projekte/SAP Einführung.md"));
        let renamed = rename_page(OBSIDIAN, "kickoff", "Start");
        assert_eq!(renamed, OBSIDIAN.replace("[[Kickoff]]", "[[Start]]"));
        // Keys are never rewritten, only values of the key.
        assert_eq!(
            rename_page(r#"{"text":"file","file":"text.md"}"#, "text", "Neu"),
            r#"{"text":"file","file":"Neu.md"}"#
        );
        // Escapes in other strings survive.
        let esc = r#"{"nodes":[{"id":"x","type":"text","text":"Zeile\n\"[[A]]\" ä"}]}"#;
        let out = rename_page(esc, "A", "B");
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["nodes"][0]["text"], "Zeile\n\"[[B]]\" ä");
        assert_eq!(
            rename_file(OBSIDIAN, "plan.png", "plan 2.png"),
            OBSIDIAN.replace("assets/plan.png", "assets/plan 2.png")
        );
        let mut paths = std::collections::HashMap::new();
        paths.insert("sap rollout".to_owned(), "Arbeit/SAP Rollout.md".to_owned());
        assert_eq!(with_paths(OBSIDIAN, &paths), OBSIDIAN.replace("Projekte/SAP Rollout.md", "Arbeit/SAP Rollout.md"));
        assert_eq!(rewrite_strings("{\"a\": \"unterminated", |_, _| Some("x".into())), "{\"a\": \"unterminated");
    }

    #[test]
    fn canvas_pages_round_trip_and_count_as_links() {
        let db = Database::open_in_memory().unwrap();
        let note = db.create_page(None, "SAP Rollout", None).unwrap();
        let kick = db.create_page(None, "Kickoff", None).unwrap();
        let board = db.create_page(None, "Board", None).unwrap();
        db.make_canvas(board.id, OBSIDIAN).unwrap();
        // Exactly as written, unknown fields included.
        assert_eq!(db.page_doc(board.id).unwrap().content, OBSIDIAN);
        assert_eq!(db.page(board.id).unwrap().kind.as_deref(), Some(KIND));
        assert_eq!(db.page(note.id).unwrap().kind, None);
        assert!(db.make_canvas(board.id, "{\"nodes\":7}").is_err());
        // Note cards and text-card links are backlinks.
        let back = db.page_doc(note.id).unwrap().backlinks;
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].page_id, board.id);
        assert_eq!(db.page_doc(kick.id).unwrap().backlinks.len(), 1);
        assert_eq!(db.page_tags(board.id).unwrap(), ["sap"]);
        // No task rows from a JSON line.
        db.save_page_content(board.id, &OBSIDIAN.replace("# Phase 1", "- [ ] Aufgabe")).unwrap();
        assert_eq!(db.conn().query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
        db.save_page_content(board.id, OBSIDIAN).unwrap();
        // A rename follows into the canvas.
        assert_eq!(db.rename_page_linked(note.id, "SAP Einführung", true).unwrap(), 1);
        let content = db.page_doc(board.id).unwrap().content;
        assert_eq!(content, OBSIDIAN.replace("Projekte/SAP Rollout.md", "Projekte/SAP Einführung.md"));
        assert_eq!(db.page_doc(note.id).unwrap().backlinks.len(), 1);
    }

    #[test]
    fn new_canvases_are_filed_flat() {
        let db = Database::open_in_memory().unwrap();
        let today = chrono::NaiveDate::from_ymd_opt(2026, 10, 2).unwrap();
        let c = db.create_canvas(None, "Planung", today).unwrap();
        assert_eq!(c.kind.as_deref(), Some(KIND));
        assert_eq!(db.page_doc(c.id).unwrap().content, EMPTY);
        let parent = db.page(c.parent_id.expect("filed into the canvas folder")).unwrap();
        assert_eq!(parent.parent_id, None, "no date folders");
        let sub = db.create_canvas(Some(parent.id), "Zweite", today).unwrap();
        assert_eq!(sub.parent_id, Some(parent.id));
    }
}
