//! Typed page properties: the schema that the child pages of a page share, their typed values
//! and property filters.
//!
//! The schema lives in the parent page's frontmatter, so it travels with the Markdown:
//!
//! ```text
//! ---
//! eigenschaften:
//!   status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}
//!   aufwand: zahl
//!   fällig: datum
//! ansicht: tabelle
//! ---
//! ```
//!
//! A property is either just its type or a flow map with `typ` and, for (multi) selects,
//! `optionen` (name → color, or a plain list). Values stay plain YAML on the child pages
//! (`status: Offen`, `aufwand: 3`, `themen: [UI, API]`). Values that do not fit their type are
//! reported, never changed. The UI (`ui/src/lib/collection.ts`) reads and writes the same format.

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::model::Page;

/// Frontmatter key of the schema on the parent page.
pub const SCHEMA_KEY: &str = "eigenschaften";
/// Frontmatter key of the view settings on the parent page (read by the UI).
pub const VIEW_KEY: &str = "ansicht";
/// Colors an option can have; the first is the default.
pub const COLORS: [&str; 9] = ["grau", "braun", "orange", "gelb", "grün", "blau", "lila", "rosa", "rot"];

// ------------------------------------------------------------------ YAML-lite

/// The YAML subset of page properties: scalars, lists and maps (block or flow style).
#[derive(Debug, Clone, PartialEq)]
pub enum Yaml {
    Str(String),
    List(Vec<Yaml>),
    Map(Vec<(String, Yaml)>),
}

impl Yaml {
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Yaml::Str(s) => Some(s),
            _ => None,
        }
    }

    /// Value of a map key (case-insensitive).
    pub fn get(&self, key: &str) -> Option<&Yaml> {
        match self {
            Yaml::Map(m) => m.iter().find(|(k, _)| k.to_lowercase() == key.to_lowercase()).map(|(_, v)| v),
            _ => None,
        }
    }
}

/// Top-level lines of a frontmatter block (between the `---` lines); `None` without one.
pub fn frontmatter_lines(markdown: &str) -> Option<Vec<&str>> {
    let rest = markdown.strip_prefix("---\n").or_else(|| markdown.strip_prefix("---\r\n"))?;
    let end = rest.lines().position(|l| l.trim_end() == "---")?;
    Some(rest.lines().take(end).collect())
}

/// A top-level frontmatter entry; `value` is `None` when it is YAML this parser does not read.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub key: String,
    pub value: Option<Yaml>,
}

/// `key: rest` of a map line; keys follow the property editor's rules (no leading indicator).
fn split_key(line: &str) -> Option<(&str, &str)> {
    let first = line.chars().next()?;
    if first.is_whitespace() || "#:-[]{}'\"".contains(first) {
        return None;
    }
    let colon = line.find(':')?;
    let rest = &line[colon + 1..];
    if !rest.is_empty() && !rest.starts_with([' ', '\t']) {
        return None;
    }
    Some((line[..colon].trim_end(), rest.trim()))
}

/// Entries of a frontmatter block, in order.
pub fn parse_entries(lines: &[&str]) -> Vec<Entry> {
    let mut out = vec![];
    let mut i = 0;
    while i < lines.len() {
        let head = lines[i];
        i += 1;
        let start = i;
        while i < lines.len() && lines[i].starts_with([' ', '\t', '-']) && !lines[i].trim().is_empty() {
            i += 1;
        }
        let Some((key, rest)) = split_key(head) else { continue };
        let cont = &lines[start..i];
        let value = if cont.is_empty() {
            parse_inline(rest)
        } else if rest.is_empty() || rest.starts_with('#') {
            parse_block(cont)
        } else {
            None
        };
        out.push(Entry { key: key.to_owned(), value });
    }
    out
}

/// The entries of a page's frontmatter (none without a block).
pub fn page_entries(markdown: &str) -> Vec<Entry> {
    frontmatter_lines(markdown).map(|l| parse_entries(&l)).unwrap_or_default()
}

struct Line<'a> {
    indent: usize,
    text: &'a str,
}

/// An indented block (the lines under `key:`): a block list or a block map.
fn parse_block(lines: &[&str]) -> Option<Yaml> {
    let lines: Vec<Line> = lines
        .iter()
        .map(|l| {
            let text = l.trim_start();
            Line { indent: l.len() - text.len(), text: text.trim_end() }
        })
        .filter(|l| !l.text.is_empty() && !l.text.starts_with('#'))
        .collect();
    if lines.is_empty() {
        return Some(Yaml::Str(String::new()));
    }
    let mut i = 0;
    let v = block_at(&lines, &mut i, lines[0].indent)?;
    (i == lines.len()).then_some(v)
}

fn is_item(text: &str) -> bool {
    text == "-" || text.starts_with("- ")
}

fn block_at(lines: &[Line], i: &mut usize, indent: usize) -> Option<Yaml> {
    if is_item(lines[*i].text) {
        let mut items = vec![];
        while *i < lines.len() && lines[*i].indent == indent && is_item(lines[*i].text) {
            let rest = lines[*i].text[1..].trim();
            *i += 1;
            let item = if rest.is_empty() {
                nested(lines, i, indent)?
            } else if split_key(rest).is_some() && !rest.starts_with(['"', '\'']) {
                return None; // maps inside block lists are not part of the subset
            } else {
                parse_inline(rest)?
            };
            items.push(item);
        }
        return Some(Yaml::List(items));
    }
    let mut map = vec![];
    while *i < lines.len() && lines[*i].indent == indent {
        let (key, rest) = split_key(lines[*i].text)?;
        *i += 1;
        let value = if rest.is_empty() || rest.starts_with('#') {
            // `key:` followed by a deeper block, or by `- items` on the same level.
            if *i < lines.len() && lines[*i].indent == indent && is_item(lines[*i].text) {
                block_at(lines, i, indent)?
            } else {
                nested(lines, i, indent)?
            }
        } else {
            parse_inline(rest)?
        };
        map.push((key.to_owned(), value));
    }
    if *i < lines.len() && lines[*i].indent > indent {
        return None;
    }
    Some(Yaml::Map(map))
}

/// The block below a line of `indent`, or an empty value when the next line is not deeper.
fn nested(lines: &[Line], i: &mut usize, indent: usize) -> Option<Yaml> {
    if *i < lines.len() && lines[*i].indent > indent {
        let deeper = lines[*i].indent;
        block_at(lines, i, deeper)
    } else {
        Some(Yaml::Str(String::new()))
    }
}

/// A value on one line: a flow list or map, or a scalar.
pub fn parse_inline(text: &str) -> Option<Yaml> {
    let text = text.trim();
    if text.starts_with(['[', '{']) {
        let chars: Vec<char> = text.chars().collect();
        let mut p = Flow { s: &chars, i: 0 };
        let v = p.value()?;
        p.ws();
        let rest: String = chars[p.i..].iter().collect();
        return (rest.is_empty() || rest.starts_with('#')).then_some(v);
    }
    scalar(text).map(Yaml::Str)
}

/// A plain or quoted scalar with an optional comment; `None` for block scalars, anchors, tags
/// and nested `a: b` values.
fn scalar(v: &str) -> Option<String> {
    let v = v.trim();
    if v.starts_with(['"', '\'']) {
        let chars: Vec<char> = v.chars().collect();
        let mut p = Flow { s: &chars, i: 0 };
        let s = p.quoted()?;
        let rest: String = chars[p.i..].iter().collect();
        let trimmed = rest.trim_start();
        return (trimmed.is_empty() || (trimmed.starts_with('#') && trimmed.len() < rest.len())).then_some(s);
    }
    let end = v
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 || v[..i].ends_with([' ', '\t'])))
        .map_or(v.len(), |(i, _)| i);
    let v = v[..end].trim();
    if v.starts_with(['[', ']', '{', '}', '&', '*', '!', '|', '>', '%']) || v.contains(": ") || v.ends_with(':') {
        return None;
    }
    Some(v.to_owned())
}

/// Recursive-descent reader of flow collections (`[a, "b, c"]`, `{typ: zahl}`).
struct Flow<'a> {
    s: &'a [char],
    i: usize,
}

impl Flow<'_> {
    fn peek(&self) -> Option<char> {
        self.s.get(self.i).copied()
    }

    fn ws(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.i += 1;
        }
    }

    fn value(&mut self) -> Option<Yaml> {
        self.ws();
        match self.peek()? {
            '[' => {
                self.i += 1;
                let mut items = vec![];
                loop {
                    self.ws();
                    if self.peek()? == ']' {
                        self.i += 1;
                        return Some(Yaml::List(items));
                    }
                    items.push(self.value()?);
                    self.ws();
                    match self.peek()? {
                        ',' => self.i += 1,
                        ']' => {}
                        _ => return None,
                    }
                }
            }
            '{' => {
                self.i += 1;
                let mut map = vec![];
                loop {
                    self.ws();
                    if self.peek()? == '}' {
                        self.i += 1;
                        return Some(Yaml::Map(map));
                    }
                    let key = match self.peek()? {
                        '"' | '\'' => self.quoted()?,
                        _ => self.plain(true),
                    };
                    self.ws();
                    if self.peek()? != ':' {
                        return None;
                    }
                    self.i += 1;
                    self.ws();
                    let value = match self.peek()? {
                        ',' | '}' => Yaml::Str(String::new()),
                        _ => self.value()?,
                    };
                    map.push((key, value));
                    self.ws();
                    match self.peek()? {
                        ',' => self.i += 1,
                        '}' => {}
                        _ => return None,
                    }
                }
            }
            '"' | '\'' => self.quoted().map(Yaml::Str),
            ']' | '}' | ',' => None,
            _ => Some(Yaml::Str(self.plain(false))),
        }
    }

    /// A plain scalar inside a flow collection: up to `,`, `]`, `}` or a `: `.
    fn plain(&mut self, key: bool) -> String {
        let start = self.i;
        while let Some(c) = self.peek() {
            if matches!(c, ',' | ']' | '}') {
                break;
            }
            if c == ':'
                && (key || self.s.get(self.i + 1).is_none_or(|n| n.is_whitespace() || matches!(n, ',' | '}' | ']')))
            {
                break;
            }
            self.i += 1;
        }
        self.s[start..self.i].iter().collect::<String>().trim().to_owned()
    }

    fn quoted(&mut self) -> Option<String> {
        let q = self.peek()?;
        self.i += 1;
        let mut out = String::new();
        loop {
            let c = self.peek()?;
            self.i += 1;
            if q == '"' && c == '\\' {
                let e = self.peek()?;
                self.i += 1;
                out.push(match e {
                    'n' => '\n',
                    't' => '\t',
                    e => e,
                });
            } else if c == q {
                if q == '\'' && self.peek() == Some('\'') {
                    self.i += 1;
                    out.push('\'');
                } else {
                    return Some(out);
                }
            } else {
                out.push(c);
            }
        }
    }
}

/// A scalar as written inside flow collections: plain when it reads back unchanged.
pub fn flow_scalar(s: &str) -> String {
    let plain = !s.is_empty()
        && s == s.trim()
        && !s.starts_with([
            '-', '?', ':', ',', '[', ']', '{', '}', '#', '&', '*', '!', '|', '>', '\'', '"', '%', '@', '`',
        ])
        && !s.contains([',', '[', ']', '{', '}', '\n'])
        && !s.contains(": ")
        && !s.contains(" #")
        && !s.ends_with(':');
    if plain {
        return s.to_owned();
    }
    let body = s.replace('\\', "\\\\").replace('"', "\\\"").replace('\n', "\\n");
    format!("\"{body}\"")
}

/// A value in flow style (`{typ: auswahl, optionen: [A, B]}`).
pub fn dump_flow(v: &Yaml) -> String {
    match v {
        Yaml::Str(s) => flow_scalar(s),
        Yaml::List(items) => format!("[{}]", items.iter().map(dump_flow).collect::<Vec<_>>().join(", ")),
        Yaml::Map(m) => {
            let pairs: Vec<String> = m.iter().map(|(k, v)| format!("{}: {}", flow_scalar(k), dump_flow(v))).collect();
            format!("{{{}}}", pairs.join(", "))
        }
    }
}

// ------------------------------------------------------------------ schema

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PropKind {
    Text,
    Select,
    MultiSelect,
    Number,
    Date,
    Person,
    Checkbox,
    Link,
}

impl PropKind {
    /// The name written in the schema.
    pub fn as_str(self) -> &'static str {
        match self {
            PropKind::Text => "text",
            PropKind::Select => "auswahl",
            PropKind::MultiSelect => "mehrfachauswahl",
            PropKind::Number => "zahl",
            PropKind::Date => "datum",
            PropKind::Person => "person",
            PropKind::Checkbox => "checkbox",
            PropKind::Link => "link",
        }
    }

    /// Reads the German names and common English ones.
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s.trim().to_lowercase().as_str() {
            "text" => PropKind::Text,
            "auswahl" | "select" => PropKind::Select,
            "mehrfachauswahl" | "multi-select" | "multiselect" | "multi_select" => PropKind::MultiSelect,
            "zahl" | "number" => PropKind::Number,
            "datum" | "date" => PropKind::Date,
            "person" => PropKind::Person,
            "checkbox" | "kontrollkästchen" | "haken" => PropKind::Checkbox,
            "link" | "url" | "verweis" => PropKind::Link,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SelectOption {
    pub name: String,
    /// One of [`COLORS`].
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PropDef {
    pub key: String,
    pub kind: PropKind,
    pub options: Vec<SelectOption>,
}

/// The shared properties of a page's child pages, in order.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct Schema {
    pub props: Vec<PropDef>,
}

fn color_of(name: &str, index: usize) -> String {
    let lower = name.trim().to_lowercase();
    let known = COLORS.iter().find(|c| **c == lower || (lower == "gruen" && **c == "grün"));
    known.map_or_else(|| COLORS[index % COLORS.len()].to_owned(), |c| (*c).to_owned())
}

impl Schema {
    /// The schema of a page's `eigenschaften:`; `None` when it has none (or it is unreadable).
    pub fn from_markdown(markdown: &str) -> Option<Schema> {
        let entry = page_entries(markdown).into_iter().find(|e| e.key.eq_ignore_ascii_case(SCHEMA_KEY))?;
        Schema::from_yaml(&entry.value?)
    }

    /// Reads the `eigenschaften:` map. Entries with an unknown type are skipped.
    pub fn from_yaml(v: &Yaml) -> Option<Schema> {
        let Yaml::Map(m) = v else {
            return v.as_str().filter(|s| s.is_empty()).map(|_| Schema::default());
        };
        let mut props: Vec<PropDef> = vec![];
        for (key, def) in m {
            let (kind, opts) = match def {
                Yaml::Str(s) => (PropKind::parse(s), None),
                Yaml::Map(_) => (
                    def.get("typ").or_else(|| def.get("type")).and_then(Yaml::as_str).and_then(PropKind::parse),
                    def.get("optionen").or_else(|| def.get("options")),
                ),
                Yaml::List(_) => (None, None),
            };
            let Some(kind) = kind else { continue };
            let mut options: Vec<SelectOption> = vec![];
            let mut push = |name: &str, color: Option<&str>| {
                let name = name.trim();
                if !name.is_empty() && !options.iter().any(|o| o.name.to_lowercase() == name.to_lowercase()) {
                    let color = color_of(color.unwrap_or(""), options.len());
                    options.push(SelectOption { name: name.to_owned(), color });
                }
            };
            match opts {
                Some(Yaml::Map(m)) => m.iter().for_each(|(n, c)| push(n, c.as_str())),
                Some(Yaml::List(items)) => items.iter().for_each(|it| match it {
                    Yaml::Str(s) => push(s, None),
                    Yaml::Map(m) => m.iter().for_each(|(n, c)| push(n, c.as_str())),
                    Yaml::List(_) => {}
                }),
                _ => {}
            }
            if !props.iter().any(|p| p.key.to_lowercase() == key.to_lowercase()) {
                props.push(PropDef { key: key.clone(), kind, options });
            }
        }
        Some(Schema { props })
    }

    /// The `eigenschaften:` block as the UI writes it.
    pub fn to_yaml(&self) -> String {
        let mut out = format!("{SCHEMA_KEY}:");
        for p in &self.props {
            let def = if p.options.is_empty() {
                p.kind.as_str().to_owned()
            } else {
                let opts = Yaml::Map(p.options.iter().map(|o| (o.name.clone(), Yaml::Str(o.color.clone()))).collect());
                format!("{{typ: {}, optionen: {}}}", p.kind.as_str(), dump_flow(&opts))
            };
            // Keys are property names: no colon, no leading indicator, so they stay plain.
            out.push_str(&format!("\n  {}: {def}", p.key));
        }
        out
    }

    pub fn prop(&self, key: &str) -> Option<&PropDef> {
        self.props.iter().find(|p| p.key.to_lowercase() == key.to_lowercase())
    }
}

// ------------------------------------------------------------------ values

/// A typed property value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "value")]
pub enum Typed {
    Text(String),
    Select(String),
    MultiSelect(Vec<String>),
    Number(f64),
    /// `YYYY-MM-DD`.
    Date(String),
    Person(String),
    Checkbox(bool),
    /// A URL or `[[Seite]]`.
    Link(String),
}

/// One property of one page: the text as written, the typed value and why it does not fit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    pub key: String,
    /// The value as text (lists joined with `, `); empty when missing.
    pub text: String,
    pub value: Option<Typed>,
    pub error: Option<String>,
}

/// A number as people type it: `3`, `-1.5`, `1,5`, `1.234,5`.
pub fn parse_number(s: &str) -> Option<f64> {
    let s = s.trim().replace([' ', '\u{a0}'], "");
    if s.is_empty() || !s.chars().all(|c| c.is_ascii_digit() || matches!(c, '-' | '+' | '.' | ',')) {
        return None;
    }
    let normalized = match (s.rfind(','), s.rfind('.')) {
        // German: `.` groups thousands, `,` is the decimal separator.
        (Some(c), Some(d)) if c > d => s.replace('.', "").replace(',', "."),
        (Some(_), Some(_)) => s.replace(',', ""),
        (Some(_), None) => s.replace(',', "."),
        _ => s,
    };
    normalized.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn is_link(s: &str) -> bool {
    let wiki = s.starts_with("[[") && s.ends_with("]]") && s.len() > 4 && !s[2..s.len() - 2].contains(['[', ']']);
    let lower = s.to_lowercase();
    let url = ["https://", "http://", "mailto:", "file:", "www."]
        .iter()
        .any(|p| lower.starts_with(p) && lower.len() > p.len() && !s.contains(char::is_whitespace));
    wiki || url
}

fn checkbox(s: &str) -> Option<bool> {
    match s.trim().to_lowercase().as_str() {
        "true" | "ja" | "yes" | "x" | "1" | "wahr" => Some(true),
        "false" | "nein" | "no" | "0" | "falsch" => Some(false),
        _ => None,
    }
}

fn items_of(v: &Yaml) -> Option<Vec<String>> {
    match v {
        Yaml::Str(s) => Some(if s.trim().is_empty() { vec![] } else { vec![s.trim().to_owned()] }),
        Yaml::List(items) => items.iter().map(|i| i.as_str().map(|s| s.trim().to_owned())).collect(),
        Yaml::Map(_) => None,
    }
}

/// Checks a value against its type. `value` is `None` for YAML this parser does not read.
pub fn validate(def: Option<&PropDef>, key: &str, value: Option<&Yaml>) -> Cell {
    let mut cell = Cell { key: key.to_owned(), text: String::new(), value: None, error: None };
    let Some(v) = value else {
        cell.error = Some("Unbekanntes YAML-Format".into());
        return cell;
    };
    let items = items_of(v);
    cell.text = match (&items, v) {
        (Some(items), _) => items.join(", "),
        (None, v) => dump_flow(v),
    };
    let Some(items) = items else {
        cell.error = Some("Unbekanntes YAML-Format".into());
        return cell;
    };
    if items.is_empty() || (items.len() == 1 && items[0].is_empty()) {
        cell.text.clear();
        return cell;
    }
    let kind = def.map_or(PropKind::Text, |d| d.kind);
    let single = matches!(v, Yaml::Str(_));
    let s = items.first().cloned().unwrap_or_default();
    let option = |name: &str| def.and_then(|d| d.options.iter().find(|o| o.name.to_lowercase() == name.to_lowercase()));
    let result: std::result::Result<Typed, String> = match kind {
        PropKind::Text => Ok(Typed::Text(cell.text.clone())),
        _ if !single && kind != PropKind::MultiSelect => Err("Liste statt einzelnem Wert".into()),
        PropKind::Select => {
            option(&s).map(|o| Typed::Select(o.name.clone())).ok_or_else(|| format!("„{s}“ ist keine Option"))
        }
        PropKind::MultiSelect => {
            let unknown: Vec<&String> = items.iter().filter(|i| option(i).is_none()).collect();
            if unknown.is_empty() {
                Ok(Typed::MultiSelect(items.iter().filter_map(|i| option(i)).map(|o| o.name.clone()).collect()))
            } else {
                let names: Vec<String> = unknown.iter().map(|u| format!("„{u}“")).collect();
                Err(format!("{} {} keine Option", names.join(", "), if unknown.len() == 1 { "ist" } else { "sind" }))
            }
        }
        PropKind::Number => parse_number(&s).map(Typed::Number).ok_or_else(|| "Keine Zahl".into()),
        PropKind::Date => chrono::NaiveDate::parse_from_str(&s, "%Y-%m-%d")
            .ok()
            .filter(|_| s.len() == 10)
            .map(|_| Typed::Date(s.clone()))
            .ok_or_else(|| "Kein Datum (JJJJ-MM-TT)".into()),
        PropKind::Person => {
            let name = s.trim_start_matches('@').trim();
            if name.is_empty() { Err("Keine Person".into()) } else { Ok(Typed::Person(name.to_owned())) }
        }
        PropKind::Checkbox => checkbox(&s).map(Typed::Checkbox).ok_or_else(|| "Weder ja noch nein".into()),
        PropKind::Link => {
            if is_link(&s) {
                Ok(Typed::Link(s.clone()))
            } else {
                Err("Kein Link (URL oder [[Seite]])".into())
            }
        }
    };
    match result {
        Ok(t) => cell.value = Some(t),
        Err(e) => cell.error = Some(e),
    }
    cell
}

/// The cells of a page: every schema property first (missing ones empty), then the page's
/// other properties as text.
pub fn page_cells(schema: &Schema, markdown: &str) -> Vec<Cell> {
    let entries = page_entries(markdown);
    let find = |key: &str| entries.iter().find(|e| e.key.to_lowercase() == key.to_lowercase());
    let mut out: Vec<Cell> = schema
        .props
        .iter()
        .map(|p| match find(&p.key) {
            Some(e) => validate(Some(p), &p.key, e.value.as_ref()),
            None => Cell { key: p.key.clone(), text: String::new(), value: None, error: None },
        })
        .collect();
    for e in &entries {
        let special = [SCHEMA_KEY, VIEW_KEY].iter().any(|k| e.key.eq_ignore_ascii_case(k));
        if !special
            && schema.prop(&e.key).is_none()
            && !out.iter().any(|c| c.key.to_lowercase() == e.key.to_lowercase())
        {
            out.push(validate(None, &e.key, e.value.as_ref()));
        }
    }
    out
}

// ------------------------------------------------------------------ filters

/// `feld op wert`, as stored in the view settings (`{feld: status, op: ist, wert: Offen}`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Filter {
    pub field: String,
    pub op: String,
    pub value: String,
}

/// Whether a cell passes a filter. Dates accept `heute`; unknown operators pass everything.
pub fn matches(cell: Option<&Cell>, op: &str, wanted: &str, today: chrono::NaiveDate) -> bool {
    let text = cell.map_or("", |c| c.text.as_str());
    let empty = text.trim().is_empty();
    let lower = wanted.trim().to_lowercase();
    let values: Vec<String> = match cell.and_then(|c| c.value.as_ref()) {
        Some(Typed::MultiSelect(v)) => v.iter().map(|s| s.to_lowercase()).collect(),
        Some(Typed::Checkbox(b)) => vec![if *b { "ja".into() } else { "nein".into() }],
        _ => vec![text.trim().to_lowercase()],
    };
    let wanted_bool = checkbox(wanted).map(|b| if b { "ja" } else { "nein" }.to_owned());
    let eq = |v: &String| *v == lower || wanted_bool.as_ref() == Some(v);
    let cmp = || -> Option<std::cmp::Ordering> {
        match cell?.value.as_ref()? {
            Typed::Number(n) => n.partial_cmp(&parse_number(wanted)?),
            Typed::Date(d) => {
                let w = if lower == "heute" {
                    today
                } else {
                    chrono::NaiveDate::parse_from_str(wanted.trim(), "%Y-%m-%d").ok()?
                };
                Some(chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok()?.cmp(&w))
            }
            _ => None,
        }
    };
    use std::cmp::Ordering::*;
    match op {
        "ist" => values.iter().any(eq) || (lower.is_empty() && empty) || cmp() == Some(Equal),
        "ist nicht" => !(values.iter().any(eq) || cmp() == Some(Equal)),
        "enthält" => text.to_lowercase().contains(&lower),
        "enthält nicht" => !text.to_lowercase().contains(&lower),
        "ist leer" => empty,
        "ist nicht leer" => !empty,
        "vor" | "<" => cmp() == Some(Less),
        "nach" | ">" => cmp() == Some(Greater),
        "<=" => matches!(cmp(), Some(Less | Equal)),
        ">=" => matches!(cmp(), Some(Greater | Equal)),
        _ => true,
    }
}

// ------------------------------------------------------------------ store

/// A page below a page with a schema, with its typed cells.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionRow {
    #[serde(flatten)]
    pub page: Page,
    /// The frontmatter block as stored (with `---` lines), for editing.
    pub frontmatter: String,
    pub cells: Vec<Cell>,
}

/// The child pages of a page as a table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Collection {
    pub parent_id: i64,
    /// `None` when the parent defines no schema (all properties are free text).
    pub schema: Option<Schema>,
    pub rows: Vec<CollectionRow>,
}

/// A child page as the table and board views load it, see [`Database::page_collection_view`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionViewRow {
    #[serde(flatten)]
    pub page: Page,
    /// The frontmatter block as stored (with `---` lines).
    pub frontmatter: String,
}

/// [`Collection`] without the cells, for the table and board views.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CollectionView {
    pub parent_id: i64,
    pub schema: Option<Schema>,
    pub rows: Vec<CollectionViewRow>,
}

/// The frontmatter block of a Markdown text with its `---` lines (line endings normalized).
fn frontmatter_block(markdown: &str) -> String {
    let Some(lines) = frontmatter_lines(markdown) else { return String::new() };
    let mut out = String::from("---\n");
    for l in lines {
        out.push_str(l);
        out.push('\n');
    }
    out.push_str("---\n");
    out
}

/// Persons named in `@Name` mentions (a letter after `@`, not inside an e-mail address).
pub fn mentions(markdown: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let chars: Vec<char> = markdown.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let boundary = i == 0 || !(chars[i - 1].is_alphanumeric() || matches!(chars[i - 1], '.' | '_' | '-' | '@'));
        if chars[i] == '@' && boundary && chars.get(i + 1).is_some_and(|c| c.is_alphabetic()) {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_alphanumeric() || matches!(chars[j], '.' | '_' | '-')) {
                j += 1;
            }
            let name: String = chars[i + 1..j].iter().collect::<String>().trim_end_matches(['.', '-', '_']).to_owned();
            if !out.contains(&name) {
                out.push(name);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

impl Database {
    fn page_content(&self, id: i64) -> Result<String> {
        Ok(self.conn().query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))?)
    }

    /// The child pages of `parent_id` (sidebar order) with their typed properties.
    pub fn page_collection(&self, parent_id: i64) -> Result<Collection> {
        let schema = Schema::from_markdown(&self.page_content(parent_id)?);
        let empty = Schema::default();
        let conn = self.conn();
        let mut st = conn.prepare_cached(&format!(
            "SELECT {}, content FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
            crate::db::PAGE_COLS
        ))?;
        let rows = st
            .query_map([parent_id], |r| Ok((crate::db::map_page(r)?, r.get::<_, String>(9)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .map(|(page, content)| CollectionRow {
                cells: page_cells(schema.as_ref().unwrap_or(&empty), &content),
                frontmatter: frontmatter_block(&content),
                page,
            })
            .collect();
        Ok(Collection { parent_id, schema, rows })
    }

    /// What the table and board views load: the child pages of `parent_id` (sidebar order)
    /// with their frontmatter only. The views derive the cells from it, so neither the
    /// pages' text nor server-side cells are sent (an 800-page folder: 0.5 MB less).
    pub fn page_collection_view(&self, parent_id: i64) -> Result<CollectionView> {
        let schema = Schema::from_markdown(&self.page_content(parent_id)?);
        let conn = self.conn();
        // Only pages that start with a frontmatter block hand their text out of SQLite.
        let mut st = conn.prepare_cached(&format!(
            "SELECT {}, CASE WHEN substr(content, 1, 3) = '---' THEN content ELSE '' END
             FROM pages WHERE parent_id = ?1 AND deleted_at IS NULL ORDER BY position, id",
            crate::db::PAGE_COLS
        ))?;
        let rows = st
            .query_map([parent_id], |r| {
                Ok(CollectionViewRow {
                    page: crate::db::map_page(r)?,
                    frontmatter: frontmatter_block(&r.get::<_, String>(9)?),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(CollectionView { parent_id, schema, rows })
    }

    /// The schema a page's properties follow: its parent's, with the parent's id.
    pub fn page_schema(&self, page_id: i64) -> Result<Option<(i64, Schema)>> {
        let Some(parent) = self.page(page_id)?.parent_id else { return Ok(None) };
        Ok(Schema::from_markdown(&self.page_content(parent)?).map(|s| (parent, s)))
    }

    /// Names for person properties: values of person properties and `@mentions`, most used first.
    pub fn known_persons(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut st = conn.prepare_cached("SELECT id, parent_id, content FROM pages WHERE deleted_at IS NULL")?;
        let pages = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let schemas: std::collections::HashMap<i64, Schema> =
            pages.iter().filter_map(|(id, _, c)| Schema::from_markdown(c).map(|s| (*id, s))).collect();
        let mut counts: Vec<(String, usize)> = vec![];
        let mut add = |name: &str| {
            let name = name.trim().trim_start_matches('@').trim();
            if name.is_empty() {
                return;
            }
            match counts.iter_mut().find(|(n, _)| n.to_lowercase() == name.to_lowercase()) {
                Some((_, c)) => *c += 1,
                None => counts.push((name.to_owned(), 1)),
            }
        };
        for (_, parent, content) in &pages {
            if let Some(schema) = parent.and_then(|p| schemas.get(&p)) {
                for cell in page_cells(schema, content) {
                    if let Some(Typed::Person(p)) = &cell.value {
                        add(p);
                    }
                }
            }
            mentions(content).iter().for_each(|m| add(m));
        }
        counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.to_lowercase().cmp(&b.0.to_lowercase())));
        Ok(counts.into_iter().map(|(n, _)| n).collect())
    }

    /// Keys of all properties the page schemas define.
    pub fn schema_property_keys(&self) -> Result<Vec<String>> {
        let conn = self.conn();
        let mut st = conn
            .prepare_cached("SELECT content FROM pages WHERE deleted_at IS NULL AND content LIKE '%' || ?1 || '%'")?;
        let mut keys: Vec<String> = vec![];
        for content in st.query_map([SCHEMA_KEY], |r| r.get::<_, String>(0))? {
            for p in Schema::from_markdown(&content?).map(|s| s.props).unwrap_or_default() {
                if !keys.iter().any(|k| k.to_lowercase() == p.key.to_lowercase()) {
                    keys.push(p.key);
                }
            }
        }
        Ok(keys)
    }

    /// Pages whose typed property `key` passes `op value` (for `status:Offen` in the search).
    /// Only properties some schema defines are considered.
    pub fn pages_with_property(&self, key: &str, op: &str, value: &str, today: chrono::NaiveDate) -> Result<Vec<Page>> {
        let conn = self.conn();
        let mut st = conn.prepare_cached(&format!(
            "SELECT {}, content FROM pages WHERE deleted_at IS NULL AND content LIKE '%' || ?1 || '%' ORDER BY updated_at DESC",
            crate::db::PAGE_COLS
        ))?;
        let parents = st
            .query_map([SCHEMA_KEY], |r| Ok((crate::db::map_page(r)?, r.get::<_, String>(9)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut out = vec![];
        for (parent, content) in parents {
            let Some(schema) = Schema::from_markdown(&content) else { continue };
            if schema.prop(key).is_none() {
                continue;
            }
            for row in self.page_collection(parent.id)?.rows {
                let cell = row.cells.iter().find(|c| c.key.to_lowercase() == key.to_lowercase());
                if matches(cell, op, value, today) {
                    out.push(row.page);
                }
            }
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PARENT: &str = "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}\n  aufwand: zahl\n  fällig: {typ: datum}\n  themen: {typ: mehrfachauswahl, optionen: [UI, \"API, intern\"]}\n  wer: person\n  erledigt: checkbox\n  quelle: link\nansicht: tabelle\n---\n# Aufgaben\n";

    fn day(s: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn reads_flow_and_block_yaml() {
        assert_eq!(
            parse_inline("[a, \"b, c\", 'd''e']"),
            Some(Yaml::List(vec![Yaml::Str("a".into()), Yaml::Str("b, c".into()), Yaml::Str("d'e".into())]))
        );
        assert_eq!(
            parse_inline("{typ: zahl, optionen: {A: rot}} # Kommentar"),
            Some(Yaml::Map(vec![
                ("typ".into(), Yaml::Str("zahl".into())),
                ("optionen".into(), Yaml::Map(vec![("A".into(), Yaml::Str("rot".into()))]))
            ]))
        );
        assert_eq!(parse_inline("https://example.org/a:b"), Some(Yaml::Str("https://example.org/a:b".into())));
        assert_eq!(parse_inline("[a, b"), None);
        assert_eq!(parse_inline("| block"), None);
        let entries =
            parse_entries(&["tags:", "  - a", "  - b", "karte:", "  x: 1", "  y:", "    - z", "leer:", "kaputt: [a"]);
        assert_eq!(entries[0].value, Some(Yaml::List(vec![Yaml::Str("a".into()), Yaml::Str("b".into())])));
        assert_eq!(
            entries[1].value,
            Some(Yaml::Map(vec![
                ("x".into(), Yaml::Str("1".into())),
                ("y".into(), Yaml::List(vec![Yaml::Str("z".into())]))
            ]))
        );
        assert_eq!(entries[2].value, Some(Yaml::Str(String::new())));
        assert_eq!(entries[3].value, None);
    }

    #[test]
    fn schema_parses_types_and_options() {
        let s = Schema::from_markdown(PARENT).unwrap();
        let keys: Vec<&str> = s.props.iter().map(|p| p.key.as_str()).collect();
        assert_eq!(keys, ["status", "aufwand", "fällig", "themen", "wer", "erledigt", "quelle"]);
        assert_eq!(s.props[0].kind, PropKind::Select);
        assert_eq!(s.props[0].options[1], SelectOption { name: "In Arbeit".into(), color: "blau".into() });
        assert_eq!(s.props[2].kind, PropKind::Date);
        // A plain option list gets the colors in order.
        assert_eq!(
            s.props[3].options.iter().map(|o| (o.name.as_str(), o.color.as_str())).collect::<Vec<_>>(),
            [("UI", "grau"), ("API, intern", "braun")]
        );
        // English type names, unknown types and pages without a schema.
        let en = Schema::from_markdown(
            "---\neigenschaften:\n  a: number\n  b: {type: select, options: [X]}\n  c: tabelle\n---\n",
        )
        .unwrap();
        assert_eq!(en.props.iter().map(|p| p.kind).collect::<Vec<_>>(), [PropKind::Number, PropKind::Select]);
        assert_eq!(Schema::from_markdown("---\nstatus: Offen\n---\n"), None);
        assert_eq!(Schema::from_markdown("# no frontmatter"), None);
    }

    #[test]
    fn schema_round_trips() {
        let s = Schema::from_markdown(PARENT).unwrap();
        let yaml = s.to_yaml();
        assert!(yaml.starts_with("eigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}\n  aufwand: zahl\n"), "{yaml}");
        assert!(
            yaml.contains("themen: {typ: mehrfachauswahl, optionen: {UI: grau, \"API, intern\": braun}}"),
            "{yaml}"
        );
        let again = Schema::from_markdown(&format!("---\n{yaml}\n---\n")).unwrap();
        assert_eq!(again, s);
        // Awkward names survive too.
        let odd = Schema {
            props: vec![PropDef {
                key: "Phase 2, [neu]".into(),
                kind: PropKind::Select,
                options: vec![
                    SelectOption { name: "[x] \"quoted\" #1".into(), color: "rot".into() },
                    SelectOption { name: "true".into(), color: "gelb".into() },
                ],
            }],
        };
        assert_eq!(Schema::from_markdown(&format!("---\n{}\n---\n", odd.to_yaml())), Some(odd));
    }

    #[test]
    fn values_are_validated_against_their_type() {
        let s = Schema::from_markdown(PARENT).unwrap();
        let child = "---\nstatus: in arbeit\naufwand: 1,5\nfällig: 2026-02-30\nthemen: [UI, Doku]\nwer: \"@Anna\"\nerledigt: ja\nquelle: \"[[Konzept]]\"\nnotiz: frei\n---\nText";
        let cells = page_cells(&s, child);
        let by = |k: &str| cells.iter().find(|c| c.key == k).unwrap();
        assert_eq!(by("status").value, Some(Typed::Select("In Arbeit".into())));
        assert_eq!(by("aufwand").value, Some(Typed::Number(1.5)));
        assert_eq!(by("fällig").error.as_deref(), Some("Kein Datum (JJJJ-MM-TT)"));
        // The invalid value is still there, as written.
        assert_eq!(by("fällig").text, "2026-02-30");
        assert_eq!(by("themen").error.as_deref(), Some("„Doku“ ist keine Option"));
        assert_eq!(by("wer").value, Some(Typed::Person("Anna".into())));
        assert_eq!(by("erledigt").value, Some(Typed::Checkbox(true)));
        assert_eq!(by("quelle").value, Some(Typed::Link("[[Konzept]]".into())));
        assert_eq!(by("notiz").value, Some(Typed::Text("frei".into())));
        let bad = page_cells(
            &s,
            "---\nstatus: Später\naufwand: viel\nerledigt: vielleicht\nquelle: kein link\nwer: [A, B]\n---\n",
        );
        let errs: Vec<Option<&str>> = bad.iter().take(7).map(|c| c.error.as_deref()).collect();
        assert_eq!(
            errs,
            [
                Some("„Später“ ist keine Option"),
                Some("Keine Zahl"),
                None,
                None,
                Some("Liste statt einzelnem Wert"),
                Some("Weder ja noch nein"),
                Some("Kein Link (URL oder [[Seite]])")
            ]
        );
        assert_eq!(parse_number("1.234,5"), Some(1234.5));
        assert_eq!(parse_number("-2.5"), Some(-2.5));
        assert_eq!(parse_number("1e9"), None);
    }

    #[test]
    fn filters_compare_typed_values() {
        let s = Schema::from_markdown(PARENT).unwrap();
        let cells =
            page_cells(&s, "---\nstatus: Offen\naufwand: 3\nfällig: 2026-09-20\nthemen: [UI]\nerledigt: false\n---\n");
        let c = |k: &str| cells.iter().find(|c| c.key == k);
        let today = day("2026-09-24");
        assert!(matches(c("status"), "ist", "offen", today));
        assert!(!matches(c("status"), "ist nicht", "Offen", today));
        assert!(matches(c("fällig"), "vor", "heute", today));
        assert!(!matches(c("fällig"), "nach", "2026-09-20", today));
        assert!(matches(c("aufwand"), ">", "2,5", today));
        assert!(matches(c("aufwand"), "<=", "3", today));
        assert!(matches(c("themen"), "ist", "UI", today));
        assert!(matches(c("erledigt"), "ist", "nein", today));
        assert!(matches(c("wer"), "ist leer", "", today));
        assert!(matches(None, "ist leer", "", today));
        assert!(matches(c("status"), "enthält", "ff", today));
    }

    #[test]
    fn mentions_skip_mail_addresses() {
        assert_eq!(
            mentions("- [ ] Angebot @Max due:2026-09-30, frag @Anna.Schmidt. Mail: a@b.de"),
            ["Max", "Anna.Schmidt"]
        );
    }

    #[test]
    fn collection_lists_children_with_cells() {
        let db = Database::open_in_memory().unwrap();
        let parent = db.create_page(None, "Aufgaben", None).unwrap();
        db.save_page_content(parent.id, PARENT).unwrap();
        let a = db.create_page(Some(parent.id), "A", None).unwrap();
        db.save_page_content(a.id, "---\nstatus: Offen\nwer: Max\n---\nText @Anna").unwrap();
        let b = db.create_page(Some(parent.id), "B", None).unwrap();
        db.save_page_content(b.id, "Nur Text").unwrap();
        let col = db.page_collection(parent.id).unwrap();
        assert_eq!(col.rows.len(), 2);
        assert_eq!(col.rows[0].frontmatter, "---\nstatus: Offen\nwer: Max\n---\n");
        assert_eq!(col.rows[0].cells[0].value, Some(Typed::Select("Offen".into())));
        assert_eq!(col.rows[1].frontmatter, "");
        assert_eq!(col.rows[1].cells.len(), 7);
        assert_eq!(db.page_schema(a.id).unwrap().map(|(p, s)| (p, s.props.len())), Some((parent.id, 7)));
        assert_eq!(db.page_schema(parent.id).unwrap(), None);
        assert_eq!(db.known_persons().unwrap(), ["Anna", "Max"]);
        let hits = db.pages_with_property("status", "ist", "offen", day("2026-09-24")).unwrap();
        assert_eq!(hits.iter().map(|p| p.title.as_str()).collect::<Vec<_>>(), ["A"]);
    }

    #[test]
    fn collection_view_has_the_frontmatter_of_the_full_collection() {
        let db = Database::open_in_memory().unwrap();
        let parent = db.create_page(None, "Aufgaben", None).unwrap();
        db.save_page_content(parent.id, PARENT).unwrap();
        let a = db.create_page(Some(parent.id), "Mit", None).unwrap();
        db.save_page_content(a.id, "---\nstatus: Offen\naufwand: 3\n---\nLanger Text\n").unwrap();
        let b = db.create_page(Some(parent.id), "Ohne", None).unwrap();
        db.save_page_content(b.id, "--- kein Frontmatter\nText").unwrap();
        db.create_page(Some(parent.id), "Leer", None).unwrap();
        let full = db.page_collection(parent.id).unwrap();
        let view = db.page_collection_view(parent.id).unwrap();
        assert_eq!(view.schema, full.schema);
        assert_eq!(view.rows.len(), 3);
        for (v, f) in view.rows.iter().zip(&full.rows) {
            assert_eq!((&v.page, &v.frontmatter), (&f.page, &f.frontmatter));
        }
        assert_eq!(view.rows[0].frontmatter, "---\nstatus: Offen\naufwand: 3\n---\n");
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("Langer Text") && !json.contains("cells"), "{json}");
    }
}
