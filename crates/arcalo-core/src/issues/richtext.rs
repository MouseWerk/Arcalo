//! Rich text of the issue view: Jira's two formats and the editor's document.
//!
//! * **ADF** (Atlassian Document Format, Jira Cloud REST v3) is a ProseMirror document, so it maps
//!   almost node for node onto the editor's document ([`adf_to_doc`], [`doc_to_adf`]).
//! * **Wiki markup** (Jira Server/Data Center REST v2) is parsed into the same document
//!   ([`wiki_to_doc`]) and written back ([`doc_to_wiki`]).
//! * The **editor's document** is the TipTap JSON of the issue editor (`ui/src/components/issue/`):
//!   paragraphs, headings, lists, code blocks, quotes, tables, rules, line breaks, the marks bold,
//!   italic, code, strike, underline and link, and nodes of its own: `panel`, `mention`,
//!   `emoji`, `jiraMedia` (an image or file of the issue, ADF) and `jiraMediaInline` (an image in
//!   wiki markup).
//!
//! What the editor cannot edit is kept, not dropped: an ADF node it does not know (an expand, a
//! status lozenge, a smart link, a decision list) or a wiki macro (`{color}`, `{anchor}`, `{toc}`)
//! becomes a `preserved` node (inline) or `preservedBlock` node holding the original, which is
//! written back unchanged. Marks it cannot show (text color, sub- and superscript) are the only
//! loss; [`adf_to_doc`] names them so the editor can say so before saving.
//!
//! [`adf_to_html`] draws ADF for the offline copy and as a fallback where Jira sent no
//! `renderedFields`; Jira's own HTML is used whenever it is there.

use serde_json::{Map, Value, json};

/// A document converted for the editor, with what saving it would lose.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct EditorDoc {
    pub doc: Value,
    /// Names of marks or attributes the editor drops (`textColor`, `subsup`, …), deduplicated.
    pub lossy: Vec<String>,
}

fn empty_doc() -> Value {
    json!({ "type": "doc", "content": [{ "type": "paragraph" }] })
}

fn kind(v: &Value) -> &str {
    v["type"].as_str().unwrap_or("")
}

fn children(v: &Value) -> &[Value] {
    v["content"].as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn note(lossy: &mut Vec<String>, what: &str) {
    if !lossy.iter().any(|l| l == what) {
        lossy.push(what.to_owned());
    }
}

/// Nodes whose children are inline (text and inline atoms).
fn holds_inline(kind: &str) -> bool {
    matches!(kind, "paragraph" | "heading")
}

/// The text a preserved node shows: its words as plain text (ADF).
fn adf_label(v: &Value) -> String {
    let t = super::jira::adf_to_text(v);
    if !t.is_empty() {
        return t;
    }
    let a = &v["attrs"];
    a["text"].as_str().or(a["url"].as_str()).or(a["title"].as_str()).unwrap_or(kind(v)).to_owned()
}

fn preserved(inline: bool, format: &str, data: String, label: String) -> Value {
    json!({
        "type": if inline { "preserved" } else { "preservedBlock" },
        "attrs": { "format": format, "data": data, "label": label },
    })
}

// ------------------------------------------------------------------ ADF → editor

/// An ADF document (Cloud) as the editor's document.
pub fn adf_to_doc(adf: &Value) -> EditorDoc {
    let mut lossy = vec![];
    if kind(adf) != "doc" {
        return EditorDoc { doc: empty_doc(), lossy };
    }
    let content: Vec<Value> = children(adf).iter().filter_map(|c| adf_node(c, false, &mut lossy)).collect();
    let doc = if content.is_empty() { empty_doc() } else { json!({ "type": "doc", "content": content }) };
    EditorDoc { doc, lossy }
}

fn adf_marks(marks: &Value, lossy: &mut Vec<String>) -> Vec<Value> {
    let mut out = vec![];
    for m in marks.as_array().into_iter().flatten() {
        let mapped = match kind(m) {
            "strong" => json!({ "type": "bold" }),
            "em" => json!({ "type": "italic" }),
            "code" => json!({ "type": "code" }),
            "strike" => json!({ "type": "strike" }),
            "underline" => json!({ "type": "underline" }),
            "link" => json!({ "type": "link", "attrs": { "href": m["attrs"]["href"].as_str().unwrap_or("") } }),
            other => {
                note(lossy, other);
                continue;
            }
        };
        out.push(mapped);
    }
    out
}

fn with_content(mut node: Value, content: Vec<Value>) -> Value {
    if !content.is_empty() {
        node["content"] = Value::Array(content);
    }
    node
}

fn adf_node(v: &Value, inline: bool, lossy: &mut Vec<String>) -> Option<Value> {
    let k = kind(v);
    let kids = |lossy: &mut Vec<String>| -> Vec<Value> {
        children(v).iter().filter_map(|c| adf_node(c, holds_inline(k), lossy)).collect()
    };
    let a = &v["attrs"];
    Some(match k {
        "text" => {
            let text = v["text"].as_str().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            let marks = adf_marks(&v["marks"], lossy);
            let mut t = json!({ "type": "text", "text": text });
            if !marks.is_empty() {
                t["marks"] = Value::Array(marks);
            }
            t
        }
        "hardBreak" => json!({ "type": "hardBreak" }),
        "mention" => json!({ "type": "mention", "attrs": {
            "id": a["id"].as_str().unwrap_or(""),
            "label": a["text"].as_str().unwrap_or("").trim_start_matches('@'),
        }}),
        "emoji" => json!({ "type": "emoji", "attrs": {
            "shortName": a["shortName"].as_str().unwrap_or(""),
            "text": a["text"].as_str().unwrap_or(""),
        }}),
        "paragraph" => with_content(json!({ "type": "paragraph" }), kids(lossy)),
        "heading" => with_content(
            json!({ "type": "heading", "attrs": { "level": a["level"].as_u64().unwrap_or(1).clamp(1, 6) } }),
            kids(lossy),
        ),
        "bulletList" | "listItem" | "blockquote" | "tableRow" => with_content(json!({ "type": k }), kids(lossy)),
        "orderedList" => with_content(
            json!({ "type": "orderedList", "attrs": { "start": a["order"].as_u64().unwrap_or(1) } }),
            kids(lossy),
        ),
        "codeBlock" => {
            let text: String = children(v).iter().filter_map(|c| c["text"].as_str()).collect();
            let mut node = json!({ "type": "codeBlock", "attrs": { "language": a["language"].as_str() } });
            if !text.is_empty() {
                node["content"] = json!([{ "type": "text", "text": text }]);
            }
            node
        }
        "rule" => json!({ "type": "horizontalRule" }),
        "table" => with_content(json!({ "type": "table" }), kids(lossy)),
        "tableHeader" | "tableCell" => {
            if a.get("background").is_some_and(|b| !b.is_null()) {
                note(lossy, "background");
            }
            let mut attrs = Map::new();
            attrs.insert("colspan".into(), json!(a["colspan"].as_u64().unwrap_or(1)));
            attrs.insert("rowspan".into(), json!(a["rowspan"].as_u64().unwrap_or(1)));
            if let Some(w) = a.get("colwidth").filter(|w| w.is_array()) {
                attrs.insert("colwidth".into(), w.clone());
            }
            let mut content = kids(lossy);
            if content.is_empty() {
                content.push(json!({ "type": "paragraph" }));
            }
            json!({ "type": k, "attrs": attrs, "content": content })
        }
        "panel" => with_content(
            json!({ "type": "panel", "attrs": { "panelType": a["panelType"].as_str().unwrap_or("info") } }),
            kids(lossy),
        ),
        "mediaSingle" | "mediaGroup" => {
            let label = media_label(v);
            json!({ "type": "jiraMedia", "attrs": { "format": "adf", "data": v.to_string(), "label": label } })
        }
        _ => {
            let block = !inline;
            preserved(!block, "adf", v.to_string(), adf_label(v))
        }
    })
}

/// The file name or alt text of an ADF media node.
fn media_label(v: &Value) -> String {
    let mut out = String::new();
    fn walk(v: &Value, out: &mut String) {
        if kind(v) == "media" {
            let a = &v["attrs"];
            if let Some(s) = a["alt"].as_str().or(a["__fileName"].as_str()).filter(|s| !s.is_empty()) {
                if !out.is_empty() {
                    out.push_str(", ");
                }
                out.push_str(s);
            }
        }
        for c in children(v) {
            walk(c, out);
        }
    }
    walk(v, &mut out);
    out
}

// ------------------------------------------------------------------ editor → ADF

/// The editor's document as ADF (what Jira Cloud stores).
pub fn doc_to_adf(doc: &Value) -> Value {
    let content: Vec<Value> = children(doc).iter().filter_map(adf_of).filter(|n| !is_empty_paragraph(n)).collect();
    json!({ "type": "doc", "version": 1, "content": content })
}

fn is_empty_paragraph(n: &Value) -> bool {
    kind(n) == "paragraph" && children(n).is_empty()
}

fn adf_of(v: &Value) -> Option<Value> {
    let k = kind(v);
    let a = &v["attrs"];
    let kids = || -> Vec<Value> { children(v).iter().filter_map(adf_of).collect() };
    Some(match k {
        "text" => {
            let text = v["text"].as_str().unwrap_or("");
            if text.is_empty() {
                return None;
            }
            let mut marks = vec![];
            for m in v["marks"].as_array().into_iter().flatten() {
                marks.push(match kind(m) {
                    "bold" => json!({ "type": "strong" }),
                    "italic" => json!({ "type": "em" }),
                    "code" => json!({ "type": "code" }),
                    "strike" => json!({ "type": "strike" }),
                    "underline" => json!({ "type": "underline" }),
                    "link" => json!({ "type": "link", "attrs": { "href": m["attrs"]["href"].as_str().unwrap_or("") } }),
                    _ => continue,
                });
            }
            // ADF allows `code` only together with `link`.
            if marks.iter().any(|m| kind(m) == "code") {
                marks.retain(|m| matches!(kind(m), "code" | "link"));
            }
            let mut t = json!({ "type": "text", "text": text });
            if !marks.is_empty() {
                t["marks"] = Value::Array(marks);
            }
            t
        }
        "hardBreak" => json!({ "type": "hardBreak" }),
        "mention" => {
            let label = a["label"].as_str().unwrap_or("");
            json!({ "type": "mention", "attrs": { "id": a["id"].as_str().unwrap_or(""), "text": format!("@{label}") } })
        }
        "emoji" => json!({ "type": "emoji", "attrs": {
            "shortName": a["shortName"].as_str().unwrap_or(""),
            "text": a["text"].as_str().unwrap_or(""),
        }}),
        "paragraph" | "bulletList" | "listItem" | "blockquote" | "tableRow" | "table" => {
            with_content(json!({ "type": k }), kids())
        }
        "heading" => {
            with_content(json!({ "type": "heading", "attrs": { "level": a["level"].as_u64().unwrap_or(1) } }), kids())
        }
        "orderedList" => with_content(
            json!({ "type": "orderedList", "attrs": { "order": a["start"].as_u64().unwrap_or(1) } }),
            kids(),
        ),
        "codeBlock" => {
            let text: String = children(v).iter().filter_map(|c| c["text"].as_str()).collect();
            let mut node = json!({ "type": "codeBlock" });
            if let Some(l) = a["language"].as_str().filter(|l| !l.is_empty() && *l != "noformat") {
                node["attrs"] = json!({ "language": l });
            }
            if !text.is_empty() {
                node["content"] = json!([{ "type": "text", "text": text }]);
            }
            node
        }
        "horizontalRule" => json!({ "type": "rule" }),
        "tableHeader" | "tableCell" => {
            let mut attrs = Map::new();
            for key in ["colspan", "rowspan"] {
                if let Some(n) = a[key].as_u64().filter(|n| *n > 1) {
                    attrs.insert(key.into(), json!(n));
                }
            }
            if let Some(w) = a.get("colwidth").filter(|w| w.is_array()) {
                attrs.insert("colwidth".into(), w.clone());
            }
            let mut content = kids();
            if content.is_empty() {
                content.push(json!({ "type": "paragraph" }));
            }
            let mut node = json!({ "type": k, "content": content });
            if !attrs.is_empty() {
                node["attrs"] = Value::Object(attrs);
            }
            node
        }
        "panel" => with_content(
            json!({ "type": "panel", "attrs": { "panelType": a["panelType"].as_str().unwrap_or("info") } }),
            kids(),
        ),
        "jiraMedia" | "jiraMediaInline" | "preserved" | "preservedBlock" => {
            let data = a["data"].as_str().unwrap_or("");
            match (a["format"].as_str(), serde_json::from_str::<Value>(data)) {
                (Some("adf"), Ok(node)) if node.is_object() => node,
                // A wiki piece in a Cloud document (moved between sites): its words.
                _ => {
                    let label = a["label"].as_str().unwrap_or(data);
                    if label.is_empty() {
                        return None;
                    }
                    let text = json!({ "type": "text", "text": label });
                    if matches!(k, "preserved" | "jiraMediaInline") {
                        text
                    } else {
                        json!({ "type": "paragraph", "content": [text] })
                    }
                }
            }
        }
        _ => return None,
    })
}

// ------------------------------------------------------------------ ADF → HTML

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Whether a link target may be shown as a link (no `javascript:` and the like).
fn safe_href(h: &str) -> bool {
    let l = h.trim().to_ascii_lowercase();
    l.starts_with("http://")
        || l.starts_with("https://")
        || l.starts_with("mailto:")
        || l.starts_with('/')
        || l.starts_with('#')
}

/// ADF as HTML (the UI sanitizes it again before showing it). Images of the issue become
/// `<img data-media-alt="file.png">`, which the view resolves to the attachment of that name.
pub fn adf_to_html(adf: &Value) -> String {
    let mut out = String::new();
    for c in children(adf) {
        html_of(c, &mut out);
    }
    out
}

fn html_of(v: &Value, out: &mut String) {
    let a = &v["attrs"];
    let inner = |out: &mut String| {
        for c in children(v) {
            html_of(c, out);
        }
    };
    let wrap = |tag: &str, attrs: &str, out: &mut String| {
        out.push_str(&format!("<{tag}{attrs}>"));
        for c in children(v) {
            html_of(c, out);
        }
        out.push_str(&format!("</{tag}>"));
    };
    match kind(v) {
        "text" => {
            let mut open = String::new();
            let mut close = vec![];
            for m in v["marks"].as_array().into_iter().flatten() {
                let (o, c) = match kind(m) {
                    "strong" => ("<strong>".to_owned(), "</strong>"),
                    "em" => ("<em>".to_owned(), "</em>"),
                    "code" => ("<code>".to_owned(), "</code>"),
                    "strike" => ("<s>".to_owned(), "</s>"),
                    "underline" => ("<u>".to_owned(), "</u>"),
                    "subsup" if m["attrs"]["type"] == "sub" => ("<sub>".to_owned(), "</sub>"),
                    "subsup" => ("<sup>".to_owned(), "</sup>"),
                    "link" => {
                        let h = m["attrs"]["href"].as_str().unwrap_or("");
                        if !safe_href(h) {
                            continue;
                        }
                        (format!("<a href=\"{}\">", esc(h)), "</a>")
                    }
                    _ => continue,
                };
                open.push_str(&o);
                close.push(c);
            }
            out.push_str(&open);
            out.push_str(&esc(v["text"].as_str().unwrap_or("")));
            for c in close.iter().rev() {
                out.push_str(c);
            }
        }
        "hardBreak" => out.push_str("<br>"),
        "paragraph" => wrap("p", "", out),
        "heading" => {
            let l = a["level"].as_u64().unwrap_or(1).clamp(1, 6);
            wrap(&format!("h{l}"), "", out)
        }
        "bulletList" => wrap("ul", "", out),
        "orderedList" => {
            let start = a["order"].as_u64().filter(|n| *n > 1).map(|n| format!(" start=\"{n}\"")).unwrap_or_default();
            wrap("ol", &start, out)
        }
        "listItem" => wrap("li", "", out),
        "blockquote" => wrap("blockquote", "", out),
        "codeBlock" => {
            let lang = a["language"].as_str().map(|l| format!(" class=\"language-{}\"", esc(l))).unwrap_or_default();
            out.push_str(&format!("<pre><code{lang}>"));
            for c in children(v) {
                out.push_str(&esc(c["text"].as_str().unwrap_or("")));
            }
            out.push_str("</code></pre>");
        }
        "rule" => out.push_str("<hr>"),
        "table" => {
            out.push_str("<table><tbody>");
            inner(out);
            out.push_str("</tbody></table>");
        }
        "tableRow" => wrap("tr", "", out),
        "tableHeader" | "tableCell" => {
            let tag = if kind(v) == "tableHeader" { "th" } else { "td" };
            let mut attrs = String::new();
            for key in ["colspan", "rowspan"] {
                if let Some(n) = a[key].as_u64().filter(|n| *n > 1) {
                    attrs.push_str(&format!(" {key}=\"{n}\""));
                }
            }
            wrap(tag, &attrs, out)
        }
        "panel" => {
            let t = a["panelType"].as_str().unwrap_or("info");
            let t = if ["info", "note", "warning", "success", "error", "tip"].contains(&t) { t } else { "info" };
            wrap("div", &format!(" class=\"jira-panel jira-panel-{t}\""), out)
        }
        "expand" | "nestedExpand" => {
            out.push_str("<details open><summary>");
            out.push_str(&esc(a["title"].as_str().unwrap_or("")));
            out.push_str("</summary>");
            inner(out);
            out.push_str("</details>");
        }
        "mention" => {
            let t = a["text"].as_str().unwrap_or("");
            let t = if t.starts_with('@') { t.to_owned() } else { format!("@{t}") };
            out.push_str(&format!("<span class=\"jira-mention\">{}</span>", esc(&t)));
        }
        // Emoji as their short names, as text (the app shows no emoji images).
        "emoji" => out.push_str(&esc(a["shortName"].as_str().or(a["text"].as_str()).unwrap_or(""))),
        "status" => {
            out.push_str(&format!("<span class=\"jira-lozenge\">{}</span>", esc(a["text"].as_str().unwrap_or(""))))
        }
        "date" => {
            let day = a["timestamp"]
                .as_str()
                .and_then(|t| t.parse::<i64>().ok())
                .and_then(chrono::DateTime::from_timestamp_millis)
                .map(|d| d.format("%Y-%m-%d").to_string())
                .unwrap_or_default();
            out.push_str(&format!("<time>{}</time>", esc(&day)));
        }
        "inlineCard" | "blockCard" | "embedCard" => {
            let url = a["url"].as_str().unwrap_or("");
            if safe_href(url) {
                out.push_str(&format!("<a href=\"{0}\">{0}</a>", esc(url)));
            }
        }
        "mediaSingle" | "mediaGroup" => {
            out.push_str("<div class=\"jira-media\">");
            inner(out);
            out.push_str("</div>");
        }
        "media" => {
            let alt = a["alt"].as_str().or(a["__fileName"].as_str()).unwrap_or("");
            out.push_str(&format!("<img data-media-alt=\"{0}\" alt=\"{0}\">", esc(alt)));
        }
        "mediaInline" => {
            let alt = a["alt"].as_str().or(a["__fileName"].as_str()).unwrap_or("");
            out.push_str(&format!("<span class=\"jira-file\">{}</span>", esc(alt)));
        }
        "taskList" | "decisionList" => wrap("ul", " class=\"jira-tasks\"", out),
        "taskItem" | "decisionItem" => {
            let done = a["state"].as_str() == Some("DONE");
            out.push_str(&format!("<li data-done=\"{done}\">"));
            inner(out);
            out.push_str("</li>");
        }
        _ => inner(out),
    }
}

// ------------------------------------------------------------------ wiki → editor

/// Wiki markup (Server/Data Center) as the editor's document.
pub fn wiki_to_doc(wiki: &str) -> EditorDoc {
    let lines: Vec<&str> = wiki.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let content = WikiBlocks::new(&lines).parse();
    let doc = if content.is_empty() { empty_doc() } else { json!({ "type": "doc", "content": content }) };
    EditorDoc { doc, lossy: vec![] }
}

/// Panel macros and the panel type they are.
const WIKI_PANELS: [(&str, &str); 5] =
    [("panel", "info"), ("info", "info"), ("note", "note"), ("warning", "warning"), ("tip", "success")];

struct WikiBlocks<'a> {
    lines: &'a [&'a str],
    at: usize,
}

/// `{name}` or `{name:params}` at the start of a line: the name and the whole tag.
fn macro_open(line: &str) -> Option<(String, String)> {
    let t = line.trim_start();
    if !t.starts_with('{') {
        return None;
    }
    let end = t.find('}')?;
    let tag = &t[..=end];
    let name = tag[1..end].split([':', '|']).next().unwrap_or("").to_ascii_lowercase();
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric())).then(|| (name, tag.to_owned()))
}

/// The list markers of a line (`*`, `**`, `#*`, `-`) and the text after them.
fn list_marker(line: &str) -> Option<(String, &str)> {
    let t = line.trim_start();
    let n = t.chars().take_while(|c| *c == '*' || *c == '#' || *c == '-').count();
    if n == 0 {
        return None;
    }
    let (marks, rest) = t.split_at(n);
    // `----` is a rule, `-` alone a dash list only with one marker.
    if marks.contains('-') && marks != "-" {
        return None;
    }
    rest.strip_prefix(' ').map(|r| (marks.to_owned(), r))
}

fn heading_of(line: &str) -> Option<(u64, &str)> {
    let t = line.trim_start();
    let b = t.as_bytes();
    (b.len() >= 3 && b[0] == b'h' && (b'1'..=b'6').contains(&b[1]) && b[2] == b'.')
        .then(|| ((b[1] - b'0') as u64, t[3..].trim_start()))
}

impl<'a> WikiBlocks<'a> {
    fn new(lines: &'a [&'a str]) -> Self {
        WikiBlocks { lines, at: 0 }
    }

    fn parse(&mut self) -> Vec<Value> {
        let mut out = vec![];
        while self.at < self.lines.len() {
            if let Some(b) = self.block() {
                out.push(b);
            }
        }
        out
    }

    /// The lines up to the closing `{name}` (the opening line's rest included), and moves past it.
    fn until_close(&mut self, name: &str, open_tag: &str) -> String {
        let close = format!("{{{name}}}");
        let first = self.lines[self.at].trim_start()[open_tag.len()..].to_owned();
        self.at += 1;
        let mut body = vec![];
        if let Some(i) = first.find(&close) {
            return first[..i].to_owned();
        }
        if !first.trim().is_empty() {
            body.push(first);
        }
        while self.at < self.lines.len() {
            let l = self.lines[self.at];
            self.at += 1;
            if let Some(i) = l.find(&close) {
                if !l[..i].is_empty() {
                    body.push(l[..i].to_owned());
                }
                break;
            }
            body.push(l.to_owned());
        }
        body.join("\n")
    }

    fn block(&mut self) -> Option<Value> {
        let line = self.lines[self.at];
        let t = line.trim();
        if t.is_empty() {
            self.at += 1;
            return None;
        }
        if t == "----" {
            self.at += 1;
            return Some(json!({ "type": "horizontalRule" }));
        }
        if let Some((level, text)) = heading_of(line) {
            self.at += 1;
            return Some(with_content(json!({ "type": "heading", "attrs": { "level": level } }), wiki_inline(text)));
        }
        if let Some(rest) = t.strip_prefix("bq. ") {
            self.at += 1;
            return Some(json!({ "type": "blockquote", "content": [para(wiki_inline(rest))] }));
        }
        if let Some((name, tag)) = macro_open(line) {
            match name.as_str() {
                "code" | "noformat" => {
                    let lang = if name == "noformat" {
                        Some("noformat".to_owned())
                    } else {
                        tag.trim_start_matches("{code")
                            .trim_end_matches('}')
                            .trim_start_matches(':')
                            .split('|')
                            .find(|p| !p.contains('=') && !p.is_empty())
                            .map(str::to_owned)
                    };
                    let body = self.until_close(&name, &tag);
                    let mut node = json!({ "type": "codeBlock", "attrs": { "language": lang } });
                    if !body.is_empty() {
                        node["content"] = json!([{ "type": "text", "text": body }]);
                    }
                    return Some(node);
                }
                "quote" => {
                    let body = self.until_close("quote", &tag);
                    let inner: Vec<&str> = body.split('\n').collect();
                    let content = WikiBlocks::new(&inner).parse();
                    return Some(with_content(json!({ "type": "blockquote" }), non_empty(content)));
                }
                n if WIKI_PANELS.iter().any(|(p, _)| *p == n) => {
                    let panel_type = WIKI_PANELS.iter().find(|(p, _)| *p == n).map(|(_, t)| *t).unwrap_or("info");
                    let body = self.until_close(n, &tag);
                    let inner: Vec<&str> = body.split('\n').collect();
                    let content = WikiBlocks::new(&inner).parse();
                    return Some(with_content(
                        json!({ "type": "panel", "attrs": { "panelType": panel_type, "source": tag } }),
                        non_empty(content),
                    ));
                }
                _ => {}
            }
        }
        if t.starts_with('|') {
            return Some(self.table());
        }
        if list_marker(line).is_some() {
            return Some(self.list(1));
        }
        // A paragraph: lines up to a blank line or the start of another block.
        let mut parts: Vec<&str> = vec![];
        while self.at < self.lines.len() {
            let l = self.lines[self.at];
            let lt = l.trim();
            let starts_block = lt.is_empty()
                || lt == "----"
                || heading_of(l).is_some()
                || lt.starts_with("bq. ")
                || lt.starts_with('|')
                || list_marker(l).is_some()
                || macro_open(l).is_some_and(|(n, _)| {
                    matches!(n.as_str(), "code" | "noformat" | "quote") || WIKI_PANELS.iter().any(|(p, _)| *p == n)
                });
            if starts_block && !parts.is_empty() {
                break;
            }
            if lt.is_empty() {
                break;
            }
            parts.push(l);
            self.at += 1;
            if starts_block {
                // A line no block took (an unknown macro opening the paragraph).
                continue;
            }
        }
        let mut content = vec![];
        for (i, p) in parts.iter().enumerate() {
            if i > 0 {
                content.push(json!({ "type": "hardBreak" }));
            }
            content.extend(wiki_inline(p));
        }
        Some(para(content))
    }

    /// A list at `depth` (the number of markers) with its nested lists.
    fn list(&mut self, depth: usize) -> Value {
        let first = list_marker(self.lines[self.at]).map(|(m, _)| m).unwrap_or_default();
        let ordered = first.chars().nth(depth - 1) == Some('#');
        let mut items: Vec<Value> = vec![];
        while self.at < self.lines.len() {
            let Some((marks, text)) = list_marker(self.lines[self.at]) else { break };
            let n = marks.chars().count();
            if n < depth {
                break;
            }
            if n > depth {
                let nested = self.list(depth + 1);
                match items.last_mut() {
                    Some(item) => item["content"].as_array_mut().map(|c| c.push(nested)).unwrap_or(()),
                    None => items.push(json!({ "type": "listItem", "content": [para(vec![]), nested] })),
                }
                continue;
            }
            if (marks.chars().nth(depth - 1) == Some('#')) != ordered {
                break;
            }
            self.at += 1;
            items.push(json!({ "type": "listItem", "content": [para(wiki_inline(text))] }));
        }
        json!({ "type": if ordered { "orderedList" } else { "bulletList" }, "content": items })
    }

    fn table(&mut self) -> Value {
        let mut rows = vec![];
        while self.at < self.lines.len() {
            let l = self.lines[self.at].trim();
            if !l.starts_with('|') {
                break;
            }
            self.at += 1;
            rows.push(json!({ "type": "tableRow", "content": table_cells(l) }));
        }
        json!({ "type": "table", "content": rows })
    }
}

fn non_empty(content: Vec<Value>) -> Vec<Value> {
    if content.is_empty() { vec![para(vec![])] } else { content }
}

fn para(content: Vec<Value>) -> Value {
    with_content(json!({ "type": "paragraph" }), content)
}

/// The cells of one table line: `||h||h||` header cells, `|c|c|` data cells (a `|` inside
/// `[link|url]` or `{{…}}` does not split).
fn table_cells(line: &str) -> Vec<Value> {
    let mut cells = vec![];
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut depth_link = 0i32;
    let mut cur = String::new();
    let mut header = false;
    let mut started = false;
    while i < chars.len() {
        let c = chars[i];
        if c == '\\' && i + 1 < chars.len() {
            cur.push(c);
            cur.push(chars[i + 1]);
            i += 2;
            continue;
        }
        match c {
            '[' => depth_link += 1,
            ']' => depth_link = (depth_link - 1).max(0),
            _ => {}
        }
        if c == '|' && depth_link == 0 {
            if started {
                let kind = if header { "tableHeader" } else { "tableCell" };
                cells.push(json!({ "type": kind, "attrs": { "colspan": 1, "rowspan": 1 }, "content": [para(wiki_inline(cur.trim()))] }));
                cur.clear();
            }
            started = true;
            header = chars.get(i + 1) == Some(&'|');
            i += if header { 2 } else { 1 };
            continue;
        }
        cur.push(c);
        i += 1;
    }
    if !cur.trim().is_empty() {
        let kind = if header { "tableHeader" } else { "tableCell" };
        cells.push(json!({ "type": kind, "attrs": { "colspan": 1, "rowspan": 1 }, "content": [para(wiki_inline(cur.trim()))] }));
    }
    cells
}

/// Wiki inline markers and the editor mark each is.
const WIKI_MARKS: [(char, &str); 4] = [('*', "bold"), ('_', "italic"), ('-', "strike"), ('+', "underline")];

fn is_word(c: Option<char>) -> bool {
    c.is_some_and(char::is_alphanumeric)
}

/// Inline wiki markup as text nodes with marks, mentions, images and preserved macros.
pub fn wiki_inline(s: &str) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    inline_into(s, &[], &mut out);
    merge_text(out)
}

fn text_node(text: &str, marks: &[Value]) -> Value {
    let mut t = json!({ "type": "text", "text": text });
    if !marks.is_empty() {
        t["marks"] = Value::Array(marks.to_vec());
    }
    t
}

fn merge_text(list: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    for n in list {
        if kind(&n) == "text" {
            if n["text"].as_str().unwrap_or("").is_empty() {
                continue;
            }
            if let Some(last) = out.last_mut()
                && kind(last) == "text"
                && last.get("marks") == n.get("marks")
            {
                let joined = format!("{}{}", last["text"].as_str().unwrap_or(""), n["text"].as_str().unwrap_or(""));
                last["text"] = Value::String(joined);
                continue;
            }
        }
        out.push(n);
    }
    out
}

fn inline_into(s: &str, marks: &[Value], out: &mut Vec<Value>) {
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let mut plain = String::new();
    let flush = |plain: &mut String, out: &mut Vec<Value>| {
        if !plain.is_empty() {
            out.push(text_node(plain, marks));
            plain.clear();
        }
    };
    let rest = |from: usize| -> String { chars[from..].iter().collect() };
    while i < chars.len() {
        let c = chars[i];
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        // `\\` is a line break, `\x` an escaped character.
        if c == '\\' {
            if chars.get(i + 1) == Some(&'\\') {
                flush(&mut plain, out);
                out.push(json!({ "type": "hardBreak" }));
                i += 2;
                continue;
            }
            if let Some(n) = chars.get(i + 1) {
                plain.push(*n);
                i += 2;
                continue;
            }
        }
        // `{{monospace}}`
        if c == '{' && chars.get(i + 1) == Some(&'{') {
            let r = rest(i + 2);
            if let Some(end) = r.find("}}") {
                flush(&mut plain, out);
                let inner = &r[..end];
                let mut m = marks.to_vec();
                m.push(json!({ "type": "code" }));
                out.push(text_node(inner, &m));
                i += 2 + inner.chars().count() + 2;
                continue;
            }
        }
        // `{macro}…{macro}` or `{macro}`: kept as written.
        if c == '{' {
            let r = rest(i);
            if let Some((name, tag)) = macro_open(&r) {
                let close = format!("{{{name}}}");
                let after = &r[tag.len()..];
                let (raw, label) = match after.find(&close) {
                    Some(end) if !["anchor", "toc"].contains(&name.as_str()) => {
                        (format!("{tag}{}{close}", &after[..end]), after[..end].to_owned())
                    }
                    _ => (tag.clone(), String::new()),
                };
                flush(&mut plain, out);
                out.push(preserved(true, "wiki", raw.clone(), label));
                i += raw.chars().count();
                continue;
            }
        }
        // `[text|url]`, `[url]`, `[~user]`, `[^file]`.
        if c == '[' {
            let r = rest(i + 1);
            if let Some(end) = r.find(']') {
                let inner = &r[..end];
                flush(&mut plain, out);
                if let Some(user) = inner.strip_prefix('~') {
                    out.push(json!({ "type": "mention", "attrs": { "id": user, "label": user } }));
                } else if inner.starts_with('^') || inner.starts_with('#') {
                    out.push(preserved(true, "wiki", format!("[{inner}]"), inner[1..].to_owned()));
                } else {
                    let (text, href) = match inner.rsplit_once('|') {
                        Some((t, h)) => (t, h.trim()),
                        None => (inner, inner.trim()),
                    };
                    let mut m = marks.to_vec();
                    m.push(json!({ "type": "link", "attrs": { "href": href } }));
                    let mut inner_out = vec![];
                    inline_into(text, &m, &mut inner_out);
                    out.extend(inner_out);
                }
                i += 1 + inner.chars().count() + 1;
                continue;
            }
        }
        // `!image.png!`, `!image.png|thumbnail!`
        if c == '!' && chars.get(i + 1).is_some_and(|n| !n.is_whitespace()) {
            let r = rest(i + 1);
            if let Some(end) = r.find('!')
                && end > 0
                && !r[..end].contains(char::is_whitespace)
            {
                flush(&mut plain, out);
                let inner = &r[..end];
                let label = inner.split('|').next().unwrap_or(inner).to_owned();
                out.push(json!({ "type": "jiraMediaInline", "attrs": { "format": "wiki", "data": format!("!{inner}!"), "label": label } }));
                i += 1 + inner.chars().count() + 1;
                continue;
            }
        }
        // `*bold*` and the other marks at word edges.
        if let Some((_, mark)) = WIKI_MARKS.iter().find(|(m, _)| *m == c)
            && !is_word(prev)
            && chars.get(i + 1).is_some_and(|n| !n.is_whitespace() && *n != c)
        {
            let mut j = i + 1;
            let mut found = None;
            while j < chars.len() {
                if chars[j] == c && !chars[j - 1].is_whitespace() && !is_word(chars.get(j + 1).copied()) {
                    found = Some(j);
                    break;
                }
                j += 1;
            }
            if let Some(end) = found {
                flush(&mut plain, out);
                let inner: String = chars[i + 1..end].iter().collect();
                let mut m = marks.to_vec();
                m.push(json!({ "type": mark }));
                inline_into(&inner, &m, out);
                i = end + 1;
                continue;
            }
        }
        plain.push(c);
        i += 1;
    }
    flush(&mut plain, out);
}

// ------------------------------------------------------------------ editor → wiki

/// The editor's document as wiki markup (what Jira Server/Data Center stores).
pub fn doc_to_wiki(doc: &Value) -> String {
    let blocks: Vec<String> = children(doc).iter().map(|b| wiki_block(b, "")).filter(|s| !s.is_empty()).collect();
    blocks.join("\n\n")
}

fn wiki_block(v: &Value, list_prefix: &str) -> String {
    let a = &v["attrs"];
    match kind(v) {
        "paragraph" => wiki_inline_of(children(v)),
        "heading" => format!("h{}. {}", a["level"].as_u64().unwrap_or(1).clamp(1, 6), wiki_inline_of(children(v))),
        "bulletList" | "orderedList" => {
            let marker = if kind(v) == "orderedList" { '#' } else { '*' };
            let prefix = format!("{list_prefix}{marker}");
            let mut lines = vec![];
            for item in children(v) {
                let mut first = true;
                for part in children(item) {
                    match kind(part) {
                        "bulletList" | "orderedList" => lines.push(wiki_block(part, &prefix)),
                        _ => {
                            let text = wiki_block(part, "");
                            if first {
                                lines.push(format!("{prefix} {text}"));
                                first = false;
                            } else if !text.is_empty() {
                                // A second paragraph of an item continues it after a line break.
                                if let Some(last) = lines.last_mut() {
                                    last.push_str(" \\\\ ");
                                    last.push_str(&text);
                                }
                            }
                        }
                    }
                }
                if first {
                    lines.push(format!("{prefix} "));
                }
            }
            lines.join("\n")
        }
        "codeBlock" => {
            let text: String = children(v).iter().filter_map(|c| c["text"].as_str()).collect();
            match a["language"].as_str().filter(|l| !l.is_empty()) {
                Some("noformat") => format!("{{noformat}}\n{text}\n{{noformat}}"),
                Some(l) => format!("{{code:{l}}}\n{text}\n{{code}}"),
                None => format!("{{code}}\n{text}\n{{code}}"),
            }
        }
        "blockquote" => {
            let inner: Vec<String> = children(v).iter().map(|b| wiki_block(b, "")).collect();
            if inner.len() == 1 && !inner[0].contains('\n') {
                format!("bq. {}", inner[0])
            } else {
                format!("{{quote}}\n{}\n{{quote}}", inner.join("\n\n"))
            }
        }
        "horizontalRule" => "----".into(),
        "table" => children(v)
            .iter()
            .map(|row| {
                let mut line = String::new();
                let mut last_header = false;
                for cell in children(row) {
                    let header = kind(cell) == "tableHeader";
                    let text: Vec<String> = children(cell).iter().map(|b| wiki_block(b, "")).collect();
                    line.push_str(if header { "||" } else { "|" });
                    line.push_str(&text.join(" \\\\ ").replace('\n', " \\\\ "));
                    last_header = header;
                }
                line.push_str(if last_header { "||" } else { "|" });
                line
            })
            .collect::<Vec<_>>()
            .join("\n"),
        "panel" => {
            let open = a["source"].as_str().filter(|s| s.starts_with('{')).map(str::to_owned).unwrap_or_else(|| {
                let name = match a["panelType"].as_str().unwrap_or("info") {
                    "note" => "note",
                    "warning" | "error" => "warning",
                    "success" | "tip" => "tip",
                    _ => "info",
                };
                format!("{{{name}}}")
            });
            let name = open[1..].split([':', '}', '|']).next().unwrap_or("info").to_owned();
            let inner: Vec<String> = children(v).iter().map(|b| wiki_block(b, "")).collect();
            format!("{open}\n{}\n{{{name}}}", inner.join("\n\n"))
        }
        "jiraMedia" | "jiraMediaInline" | "preservedBlock" | "preserved" => wiki_atom(v),
        _ => wiki_inline_of(children(v)),
    }
}

fn wiki_atom(v: &Value) -> String {
    let a = &v["attrs"];
    match a["format"].as_str() {
        Some("wiki") => a["data"].as_str().unwrap_or("").to_owned(),
        // An ADF piece in a Server document: its words.
        _ => escape_wiki(a["label"].as_str().unwrap_or("")),
    }
}

/// Characters that start wiki markup are escaped where they could: braces and brackets always,
/// emphasis markers at word edges, `!` before a word.
fn escape_wiki(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    for (i, &c) in chars.iter().enumerate() {
        let prev = if i > 0 { Some(chars[i - 1]) } else { None };
        let next = chars.get(i + 1).copied();
        let edge = |c: char| {
            let opens = !is_word(prev) && next.is_some_and(|n| !n.is_whitespace() && n != c);
            let closes = prev.is_some_and(|p| !p.is_whitespace()) && !is_word(next);
            opens || closes
        };
        let escape = match c {
            '{' | '}' | '[' | ']' | '|' => true,
            '*' | '_' | '+' | '^' | '~' => edge(c),
            // A dash between words (well-known) or as a list marker in text stays.
            '-' => edge(c) && !(prev.is_some_and(char::is_whitespace) && next.is_some_and(char::is_whitespace)),
            '!' => next.is_some_and(|n| !n.is_whitespace()),
            '\\' => next.is_some_and(|n| !n.is_alphanumeric() && !n.is_whitespace()),
            _ => false,
        };
        if escape {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

fn wiki_inline_of(nodes: &[Value]) -> String {
    let mut out = String::new();
    for n in nodes {
        match kind(n) {
            "text" => {
                let text = n["text"].as_str().unwrap_or("");
                let marks: Vec<&Value> = n["marks"].as_array().map(|m| m.iter().collect()).unwrap_or_default();
                let code = marks.iter().any(|m| kind(m) == "code");
                let mut s = if code { format!("{{{{{text}}}}}") } else { escape_wiki(text) };
                for m in &marks {
                    s = match kind(m) {
                        "bold" => format!("*{s}*"),
                        "italic" => format!("_{s}_"),
                        "strike" => format!("-{s}-"),
                        "underline" => format!("+{s}+"),
                        _ => s,
                    };
                }
                if let Some(link) = marks.iter().find(|m| kind(m) == "link") {
                    let href = link["attrs"]["href"].as_str().unwrap_or("");
                    s = if href == text { format!("[{href}]") } else { format!("[{s}|{href}]") };
                }
                out.push_str(&s);
            }
            "hardBreak" => out.push('\n'),
            "mention" => out.push_str(&format!("[~{}]", n["attrs"]["id"].as_str().unwrap_or(""))),
            "emoji" => out.push_str(n["attrs"]["shortName"].as_str().unwrap_or("")),
            "jiraMedia" | "jiraMediaInline" | "preserved" | "preservedBlock" => out.push_str(&wiki_atom(n)),
            _ => out.push_str(&wiki_inline_of(children(n))),
        }
    }
    out
}

// ------------------------------------------------------------------ plain text

/// A plain text (a comment typed without formatting) as the editor's document.
pub fn text_to_doc(text: &str) -> Value {
    let paragraphs: Vec<Value> = text
        .split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .map(|p| {
            let mut content = vec![];
            for (i, line) in p.lines().enumerate() {
                if i > 0 {
                    content.push(json!({ "type": "hardBreak" }));
                }
                if !line.is_empty() {
                    content.push(json!({ "type": "text", "text": line }));
                }
            }
            para(content)
        })
        .collect();
    if paragraphs.is_empty() { empty_doc() } else { json!({ "type": "doc", "content": paragraphs }) }
}

/// Whether the editor's document has no text and no atom (an empty comment).
pub fn doc_is_empty(doc: &Value) -> bool {
    fn has(v: &Value) -> bool {
        match kind(v) {
            "text" => v["text"].as_str().is_some_and(|t| !t.trim().is_empty()),
            "mention" | "emoji" | "jiraMedia" | "jiraMediaInline" | "preserved" | "preservedBlock"
            | "horizontalRule" | "table" => true,
            _ => children(v).iter().any(has),
        }
    }
    !has(doc)
}
