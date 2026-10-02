//! Folders & filing („Ordner & Ablage“): the one place that decides where the pages the app
//! creates go. Every creator (daily notes, meeting notes, voice notes, Jira issue notes, mail
//! notes, imported bookmarks, the capture inbox) calls [`Database::file_page`] once the page
//! has its content, so rules can look at its tags and properties.
//!
//! A type has a root folder (reused when a top-level page of that name exists, in either
//! language) and a granularity: `Journal/2026/10 – Oktober`. Meetings can go by series, Jira
//! notes always go by project: `Jira/ABC Projekt/ABC-12 Titel`. The user's rules („#kunde-x →
//! Kunden/X“) come first; the first matching rule wins. Existing pages are never moved on
//! their own: the tidy-up ([`tidy`]) proposes moves and applies the ones the user picked, with
//! an undo. Folders the filing created or adopted are marked (`system_folder`, `system_key`),
//! so a month folder is found again after a language switch and the tidy-up knows which
//! folders it may take pages out of.

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{Datelike, NaiveDate};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::prefs::Language;
use crate::settings::Settings;
use crate::tr;

mod smart;
mod tidy;

pub use smart::*;
pub use tidy::*;

#[cfg(test)]
mod tests;

/// The kinds of pages the app creates and files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileType {
    Journal,
    Meeting,
    Voice,
    Jira,
    Mail,
    Bookmarks,
    Inbox,
}

impl FileType {
    pub const ALL: [FileType; 7] = [
        FileType::Journal,
        FileType::Meeting,
        FileType::Voice,
        FileType::Jira,
        FileType::Mail,
        FileType::Bookmarks,
        FileType::Inbox,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            FileType::Journal => "journal",
            FileType::Meeting => "meeting",
            FileType::Voice => "voice",
            FileType::Jira => "jira",
            FileType::Mail => "mail",
            FileType::Bookmarks => "bookmarks",
            FileType::Inbox => "inbox",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == s)
    }

    /// The root folder of a new workspace in German and English (empty: the top level).
    pub fn default_titles(self) -> [&'static str; 2] {
        match self {
            FileType::Journal => [crate::notes::JOURNAL_TITLE, "Journal"],
            FileType::Meeting => [crate::calsync::MEETINGS_TITLE, crate::calsync::MEETINGS_TITLE_EN],
            FileType::Voice => ["Sprachnotizen", "Voice notes"],
            FileType::Jira => ["Jira", "Jira"],
            FileType::Mail => [crate::mail::DEFAULT_PARENT, "Emails"],
            FileType::Bookmarks => ["Lesezeichen", "Bookmarks"],
            FileType::Inbox => ["", ""],
        }
    }

    /// [`FileType::default_titles`] in the display language.
    pub fn default_title(self) -> &'static str {
        let [de, en] = self.default_titles();
        tr!(de, en)
    }

    pub fn icon(self) -> &'static str {
        match self {
            FileType::Journal => "calendar-days",
            FileType::Meeting => "users",
            FileType::Voice => "mic",
            FileType::Jira => "ticket",
            FileType::Mail => "mail",
            FileType::Bookmarks => "link",
            FileType::Inbox => "inbox",
        }
    }

    pub fn default_granularity(self) -> Granularity {
        match self {
            FileType::Journal | FileType::Meeting | FileType::Voice | FileType::Mail => Granularity::Month,
            FileType::Jira | FileType::Bookmarks | FileType::Inbox => Granularity::None,
        }
    }
}

/// Date subfolders below a type's root (`Series`: meetings by their subject instead).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Granularity {
    #[default]
    None,
    Year,
    Month,
    Week,
    Series,
}

/// Settings → Ordner & Ablage, one type.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct TypeFiling {
    /// Root folder (a path `A/B` is allowed); empty: the default name (journal and mail:
    /// Settings → Notizen / E-Mail).
    pub folder: String,
    pub granularity: Granularity,
}

/// What a rule looks at.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleKind {
    /// `key` is the tag (without `#`; subtags `key/…` match too).
    Tag,
    /// Frontmatter `key: value` (an empty value: the property is set).
    Property,
    /// `key` is a Jira project key (`jira:` property or a title starting with `ABC-12`).
    Jira,
    /// `key` is a Netzplan (`vorgang: NP-1/0010` or `netzplan: NP-1`).
    Netzplan,
    /// The title starts with `key`.
    Title,
}

/// „Wenn … → Ordner“.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilingRule {
    #[serde(default)]
    pub id: String,
    pub kind: RuleKind,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub value: String,
    /// Folder path from the top level, `Kunden/X`.
    #[serde(default)]
    pub folder: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FilingSettings {
    /// Per type; a missing type uses its defaults.
    pub types: BTreeMap<FileType, TypeFiling>,
    /// In order: the first matching rule wins.
    pub rules: Vec<FilingRule>,
}

impl FilingSettings {
    /// The settings of `kind`, its defaults when not set.
    pub fn get(&self, kind: FileType) -> TypeFiling {
        self.types
            .get(&kind)
            .cloned()
            .unwrap_or(TypeFiling { folder: String::new(), granularity: kind.default_granularity() })
    }

    /// Clean folder paths, series only for meetings, rules with a key and a folder and a unique id.
    pub fn normalized(mut self) -> Self {
        for (kind, t) in self.types.iter_mut() {
            t.folder = clean_path(&t.folder);
            if t.granularity == Granularity::Series && *kind != FileType::Meeting {
                t.granularity = Granularity::None;
            }
        }
        self.rules.retain_mut(|r| {
            r.key = r.key.trim().to_owned();
            if r.kind == RuleKind::Tag {
                r.key = r.key.trim_start_matches('#').to_owned();
            }
            r.value = r.value.trim().to_owned();
            r.folder = clean_path(&r.folder);
            !r.key.is_empty() && !r.folder.is_empty()
        });
        let mut seen = HashSet::new();
        let mut n = 1;
        for r in &mut self.rules {
            if r.id.trim().is_empty() || !seen.insert(r.id.clone()) {
                while self_has(&seen, n) {
                    n += 1;
                }
                r.id = format!("r{n}");
                seen.insert(r.id.clone());
            }
        }
        self
    }
}

fn self_has(seen: &HashSet<String>, n: usize) -> bool {
    seen.contains(&format!("r{n}"))
}

/// `" A / /B "` → `A/B` (each part a clean page title).
pub fn clean_path(path: &str) -> String {
    path.split('/').map(crate::notes::clean_title).filter(|s| !s.is_empty()).collect::<Vec<_>>().join("/")
}

const MONTHS_DE: [&str; 12] = [
    "Januar",
    "Februar",
    "März",
    "April",
    "Mai",
    "Juni",
    "Juli",
    "August",
    "September",
    "Oktober",
    "November",
    "Dezember",
];
const MONTHS_EN: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

/// The name of month `month` (1–12).
pub fn month_name(month: u32, lang: Language) -> &'static str {
    let i = (month.clamp(1, 12) - 1) as usize;
    if lang == Language::En { MONTHS_EN[i] } else { MONTHS_DE[i] }
}

/// `10 – Oktober`: the number first, so the folders sort by name.
pub fn month_folder(month: u32, lang: Language) -> String {
    format!("{month:02} – {}", month_name(month, lang))
}

/// `KW 05` / `Week 05` (ISO week).
pub fn week_folder(week: u32, lang: Language) -> String {
    if lang == Language::En { format!("Week {week:02}") } else { format!("KW {week:02}") }
}

fn other(lang: Language) -> Language {
    if lang == Language::En { Language::De } else { Language::En }
}

/// One folder of a filing path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Segment {
    pub title: String,
    /// Place in the scheme (`root`, `y2026`, `m2026-10`, `w2026-40`, `g:…`); none for the
    /// parts of a custom root path and for rule folders (found by title).
    pub key: Option<String>,
    /// Other titles the same folder may have (the other language).
    pub alts: Vec<String>,
    pub icon: &'static str,
}

impl Segment {
    fn titled(title: &str) -> Self {
        Segment { title: title.to_owned(), key: None, alts: vec![], icon: "folder" }
    }
}

/// What the filing of one page needs to know.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileInfo {
    pub kind: FileType,
    /// The day the date folders follow (the meeting's day, the recording's day, …).
    pub date: NaiveDate,
    /// Meeting series (subject) or Jira project folder (`ABC Projekt`).
    pub group: Option<String>,
}

/// The root folder of `kind` and the other titles an existing one may have.
pub fn root_folder(settings: &Settings, kind: FileType) -> (String, Vec<String>) {
    let cfg = settings.filing.get(kind);
    let legacy = match kind {
        FileType::Journal => settings.notes.daily_folder.as_str(),
        FileType::Mail => settings.mail.notes_parent.as_str(),
        _ => "",
    };
    let [de, en] = kind.default_titles();
    let title = [cfg.folder.as_str(), legacy]
        .into_iter()
        .map(clean_path)
        .find(|t| !t.is_empty())
        .unwrap_or_else(|| kind.default_title().to_owned());
    let defaults = [de, en, legacy];
    let alts = if defaults.iter().any(|d| d.eq_ignore_ascii_case(&title)) {
        defaults.iter().filter(|d| !d.is_empty() && !d.eq_ignore_ascii_case(&title)).map(|d| (*d).to_owned()).collect()
    } else {
        vec![]
    };
    (title, alts)
}

fn year_segment(year: i32) -> Segment {
    Segment { title: year.to_string(), key: Some(format!("y{year}")), alts: vec![], icon: "folder" }
}

/// The folders from the top level a page of `info` goes into: the root (`root`, may be a
/// path), the series or project, then the date folders of the granularity.
pub fn type_path(cfg: &TypeFiling, info: &FileInfo, root: &str, root_alts: &[String], lang: Language) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    let parts: Vec<&str> = root.split('/').filter(|s| !s.trim().is_empty()).collect();
    for (i, p) in parts.iter().enumerate() {
        let mut seg = Segment::titled(p);
        if i + 1 == parts.len() {
            seg.key = Some("root".into());
            seg.icon = info.kind.icon();
            if parts.len() == 1 {
                seg.alts = root_alts.to_vec();
            }
        }
        out.push(seg);
    }
    let group = info.group.as_deref().map(crate::notes::clean_title).filter(|g| !g.is_empty());
    let by_group =
        info.kind == FileType::Jira || (info.kind == FileType::Meeting && cfg.granularity == Granularity::Series);
    if by_group && let Some(g) = group {
        out.push(Segment {
            key: Some(format!("g:{}", g.to_lowercase())),
            title: g,
            alts: vec![],
            icon: if info.kind == FileType::Jira { "folder-kanban" } else { "users" },
        });
    }
    let (y, m) = (info.date.year(), info.date.month());
    match cfg.granularity {
        Granularity::Year => out.push(year_segment(y)),
        Granularity::Month => {
            out.push(year_segment(y));
            out.push(Segment {
                title: month_folder(m, lang),
                key: Some(format!("m{y}-{m:02}")),
                alts: vec![month_folder(m, other(lang))],
                icon: "folder",
            });
        }
        Granularity::Week => {
            let w = info.date.iso_week();
            out.push(year_segment(w.year()));
            out.push(Segment {
                title: week_folder(w.week(), lang),
                key: Some(format!("w{}-{:02}", w.year(), w.week())),
                alts: vec![week_folder(w.week(), other(lang))],
                icon: "folder",
            });
        }
        Granularity::None | Granularity::Series => {}
    }
    out
}

/// The folders of a rule's path (found by title, created where missing).
pub fn rule_path(folder: &str) -> Vec<Segment> {
    clean_path(folder).split('/').filter(|s| !s.is_empty()).map(Segment::titled).collect()
}

/// What rules look at.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PageFacts {
    pub title: String,
    pub tags: Vec<String>,
    pub content: String,
}

/// The Jira project of a page: its `jira:` property, else a title starting with an issue key.
pub fn jira_project(title: &str, content: &str) -> Option<String> {
    let key = crate::pagework::frontmatter_value(content, "jira")
        .filter(|k| crate::issues::is_key(k))
        .or_else(|| title.split_whitespace().next().filter(|w| crate::issues::is_key(w)).map(str::to_owned))?;
    key.split_once('-').map(|(p, _)| p.to_owned())
}

/// The Netzplan a page books on (`vorgang: NP-1/0010`, `netzplan: NP-1`).
pub fn netzplan_of(content: &str) -> Option<String> {
    let r = crate::pagework::page_reference(content)?;
    let np = r.split('/').next().unwrap_or("").trim().to_owned();
    (!np.is_empty()).then_some(np)
}

impl FilingRule {
    pub fn matches(&self, f: &PageFacts) -> bool {
        let key = self.key.trim();
        if key.is_empty() {
            return false;
        }
        match self.kind {
            RuleKind::Tag => {
                let k = key.trim_start_matches('#').to_lowercase();
                let sub = format!("{k}/");
                f.tags.iter().map(|t| t.trim_start_matches('#').to_lowercase()).any(|t| t == k || t.starts_with(&sub))
            }
            RuleKind::Property => crate::pagework::frontmatter_value(&f.content, key)
                .is_some_and(|v| self.value.is_empty() || v.to_lowercase() == self.value.to_lowercase()),
            RuleKind::Jira => jira_project(&f.title, &f.content).is_some_and(|p| p.eq_ignore_ascii_case(key)),
            RuleKind::Netzplan => netzplan_of(&f.content).is_some_and(|n| n.eq_ignore_ascii_case(key)),
            RuleKind::Title => f.title.to_lowercase().starts_with(&key.to_lowercase()),
        }
    }
}

/// Where a page goes and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub segments: Vec<Segment>,
    /// The `system_folder` of folders created on the way: the type, or `rule`.
    pub mark: String,
    /// The id of the rule that decided.
    pub rule: Option<String>,
}

impl Target {
    pub fn path(&self) -> String {
        self.segments.iter().map(|s| s.title.as_str()).collect::<Vec<_>>().join(" / ")
    }
}

/// The first enabled rule matching `facts`, else the type's default (`None`: neither applies).
pub fn filing_target(settings: &Settings, facts: &PageFacts, info: Option<&FileInfo>) -> Option<Target> {
    filing_target_in(settings, facts, info, None)
}

/// [`filing_target`] with the type's root replaced by `root` (a mail note's chosen parent).
fn filing_target_in(
    settings: &Settings,
    facts: &PageFacts,
    info: Option<&FileInfo>,
    root: Option<&str>,
) -> Option<Target> {
    if let Some(r) = settings.filing.rules.iter().find(|r| r.enabled && r.matches(facts)) {
        return Some(Target { segments: rule_path(&r.folder), mark: "rule".into(), rule: Some(r.id.clone()) });
    }
    let info = info?;
    let (title, alts) = match root.map(clean_path).filter(|r| !r.is_empty()) {
        Some(r) => (r, vec![]),
        None => root_folder(settings, info.kind),
    };
    let segments = type_path(&settings.filing.get(info.kind), info, &title, &alts, crate::i18n::lang());
    Some(Target { segments, mark: info.kind.as_str().into(), rule: None })
}

/// The meeting series of a meeting note title: the subject without the date and counter
/// („Jour fixe 02.10.2026 2“ → „Jour fixe“).
pub fn series_name(title: &str) -> String {
    let mut words: Vec<&str> = title.split_whitespace().collect();
    if words.len() > 1 && words.last().is_some_and(|w| w.len() <= 2 && w.chars().all(|c| c.is_ascii_digit())) {
        words.pop();
    }
    if words.len() > 1
        && words.last().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-') && w.len() >= 8)
    {
        words.pop();
    }
    words.join(" ")
}

/// Sort and color of a folder's children (Ordner → Sortieren, Farbe).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FolderStyle {
    /// `manual`, `name`, `modified` or `created`.
    pub sort: String,
    pub folders_first: bool,
    /// A theme color token: `accent`, `info`, `success`, `warning`, `danger`, `violet`, `muted`.
    pub color: Option<String>,
}

impl Default for FolderStyle {
    fn default() -> Self {
        FolderStyle { sort: "manual".into(), folders_first: false, color: None }
    }
}

pub const FOLDER_SORTS: [&str; 4] = ["manual", "name", "modified", "created"];
pub const FOLDER_COLORS: [&str; 7] = ["accent", "info", "success", "warning", "danger", "violet", "muted"];

impl FolderStyle {
    fn normalized(mut self) -> Self {
        if !FOLDER_SORTS.contains(&self.sort.as_str()) {
            self.sort = "manual".into();
        }
        self.color = self.color.filter(|c| FOLDER_COLORS.contains(&c.as_str()));
        self
    }
}

/// Children of a parent as the filing sees them, read once per parent.
pub(crate) struct Kids<'a> {
    db: &'a Database,
    cache: HashMap<Option<i64>, Vec<Kid>>,
}

#[derive(Debug, Clone)]
pub(crate) struct Kid {
    pub id: i64,
    pub title: String,
    pub folder: Option<String>,
    pub key: Option<String>,
}

impl<'a> Kids<'a> {
    pub fn new(db: &'a Database) -> Self {
        Kids { db, cache: HashMap::new() }
    }

    pub fn forget(&mut self, parent: Option<i64>) {
        self.cache.remove(&parent);
    }

    /// A page moved from `from` to `to` (last): the cached lists follow without a new query.
    pub fn moved(&mut self, id: i64, title: &str, from: Option<i64>, to: Option<i64>) {
        if let Some(kids) = self.cache.get_mut(&from) {
            kids.retain(|k| k.id != id);
        }
        if let Some(kids) = self.cache.get_mut(&to) {
            kids.push(Kid { id, title: title.to_owned(), folder: None, key: None });
        }
    }

    fn of(&mut self, parent: Option<i64>) -> Result<&Vec<Kid>> {
        if !self.cache.contains_key(&parent) {
            let mut st = self.db.conn().prepare_cached(
                "SELECT id, title, system_folder, system_key FROM pages
                 WHERE parent_id IS ?1 AND deleted_at IS NULL ORDER BY position, id",
            )?;
            let kids = st
                .query_map([parent], |r| {
                    Ok(Kid { id: r.get(0)?, title: r.get(1)?, folder: r.get(2)?, key: r.get(3)? })
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            self.cache.insert(parent, kids);
        }
        Ok(&self.cache[&parent])
    }

    /// The child of `parent` that is `seg`: by key (marked with `mark`), else by title or one
    /// of its other titles (a folder marked `mark` first).
    pub fn find(&mut self, parent: Option<i64>, seg: &Segment, mark: &str) -> Result<Option<Kid>> {
        let kids = self.of(parent)?;
        if let Some(k) = &seg.key
            && let Some(c) = kids.iter().find(|c| c.key.as_deref() == Some(k) && c.folder.as_deref() == Some(mark))
        {
            return Ok(Some(c.clone()));
        }
        let names: Vec<String> = std::iter::once(&seg.title).chain(&seg.alts).map(|t| t.to_lowercase()).collect();
        let hits: Vec<&Kid> = kids.iter().filter(|c| names.contains(&c.title.to_lowercase())).collect();
        Ok(hits.iter().find(|c| c.folder.as_deref() == Some(mark)).or(hits.first()).map(|c| (*c).clone()))
    }

    /// The ids of the existing folders along `segs` and whether all of them exist.
    pub fn lookup(&mut self, segs: &[Segment], mark: &str) -> Result<(Vec<i64>, bool)> {
        let mut parent = None;
        let mut found = Vec::new();
        for s in segs {
            match self.find(parent, s, mark)? {
                Some(k) => {
                    found.push(k.id);
                    parent = Some(k.id);
                }
                None => return Ok((found, false)),
            }
        }
        Ok((found, true))
    }

    /// The folder at the end of `segs`, creating missing ones (their ids into `created`).
    /// Existing folders with a key are adopted (marked), except for rule paths.
    pub fn ensure(&mut self, segs: &[Segment], mark: &str, created: &mut Vec<i64>) -> Result<Option<i64>> {
        let mut parent = None;
        for s in segs {
            let id = match self.find(parent, s, mark)? {
                Some(k) => {
                    if k.folder.is_none() && s.key.is_some() && mark != "rule" {
                        self.db.conn().execute(
                            "UPDATE pages SET system_folder = ?2, system_key = ?3 WHERE id = ?1",
                            params![k.id, mark, s.key],
                        )?;
                        self.forget(parent);
                    }
                    k.id
                }
                None => {
                    let page = self.db.create_page(parent, &s.title, Some(s.icon))?;
                    self.db.conn().execute(
                        "UPDATE pages SET system_folder = ?2, system_key = ?3 WHERE id = ?1",
                        params![page.id, mark, s.key],
                    )?;
                    if let Some(key) = &s.key {
                        self.place(page.id, parent, key)?;
                    }
                    self.forget(parent);
                    created.push(page.id);
                    page.id
                }
            };
            parent = Some(id);
        }
        Ok(parent)
    }

    /// Puts a new keyed folder among its kind: date folders newest first, groups by name.
    fn place(&mut self, id: i64, parent: Option<i64>, key: &str) -> Result<()> {
        fn kind(k: &str) -> &str {
            if k.starts_with("g:") { "g" } else { &k[..1] }
        }
        let mine = kind(key);
        if mine == "r" {
            return Ok(());
        }
        let kids: Vec<Kid> = self.of(parent)?.iter().filter(|c| c.id != id).cloned().collect();
        let same: Vec<(usize, &str)> = kids
            .iter()
            .enumerate()
            .filter_map(|(i, c)| c.key.as_deref().filter(|k| kind(k) == mine).map(|k| (i, k)))
            .collect();
        let pos = if mine == "g" {
            same.iter()
                .find(|(_, k)| *k > key)
                .map(|(i, _)| *i)
                .or(same.last().map(|(i, _)| i + 1))
                .unwrap_or(kids.len())
        } else {
            same.iter().find(|(_, k)| *k < key).map(|(i, _)| *i).or(same.last().map(|(i, _)| i + 1)).unwrap_or(0)
        };
        self.db.move_page(id, parent, pos as i64)
    }
}

impl Database {
    /// Title, content and tags of a page, for the rules.
    pub fn page_facts(&self, page_id: i64) -> Result<PageFacts> {
        let (title, content): (String, String) =
            self.conn().query_row("SELECT title, content FROM pages WHERE id = ?1", [page_id], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })?;
        let tags = self
            .conn()
            .prepare_cached("SELECT tag FROM page_tags WHERE page_id = ?1 ORDER BY tag")?
            .query_map([page_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(PageFacts { title, tags, content })
    }

    /// Files a page the app just created (and saved): records its type, date and group, then
    /// moves it into the folder of the first matching rule or of its type, creating folders as
    /// needed. Daily notes go first in their folder, the rest last. Returns the folder.
    pub fn file_page(&self, page_id: i64, info: &FileInfo) -> Result<Option<i64>> {
        self.file_page_in(page_id, info, None)
    }

    /// [`Database::file_page`] below `root` instead of the type's root folder.
    pub fn file_page_in(&self, page_id: i64, info: &FileInfo, root: Option<&str>) -> Result<Option<i64>> {
        self.atomic(|| {
            self.conn().execute(
                "UPDATE pages SET file_type = ?2, file_date = ?3, file_group = ?4 WHERE id = ?1",
                params![page_id, info.kind.as_str(), info.date.format("%Y-%m-%d").to_string(), info.group],
            )?;
            let settings = self.load_settings().unwrap_or_default();
            let facts = self.page_facts(page_id)?;
            let Some(target) = filing_target_in(&settings, &facts, Some(info), root) else {
                return Ok(self.page(page_id)?.parent_id);
            };
            let parent = Kids::new(self).ensure(&target.segments, &target.mark, &mut Vec::new())?;
            let pos = if info.kind == FileType::Journal { 0 } else { i64::MAX };
            self.move_page(page_id, parent, pos)?;
            Ok(parent)
        })
    }

    /// Creates a page of `kind` (title made unique) with `content` and files it. Returns the
    /// page and the folders that were created for it (an import's undo removes them).
    pub fn create_filed_page(
        &self,
        kind: FileType,
        title: &str,
        icon: Option<&str>,
        content: &str,
        today: NaiveDate,
    ) -> Result<(crate::model::Page, Vec<i64>)> {
        self.atomic(|| {
            let before: HashSet<i64> = self.system_folder_ids()?;
            let base = crate::notes::clean_title(title);
            let mut name = base.clone();
            let mut n = 2;
            while self.page_by_title(&name)?.is_some() {
                name = format!("{base} {n}");
                n += 1;
            }
            let page = self.create_page(None, &name, icon)?;
            if !content.is_empty() {
                self.save_page_content(page.id, content)?;
            }
            self.file_page(page.id, &FileInfo { kind, date: today, group: None })?;
            let created = self.system_folder_ids()?.into_iter().filter(|id| !before.contains(id)).collect();
            Ok((self.page(page.id)?, created))
        })
    }

    fn system_folder_ids(&self) -> Result<HashSet<i64>> {
        Ok(self
            .conn()
            .prepare_cached("SELECT id FROM pages WHERE system_folder IS NOT NULL AND deleted_at IS NULL")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// „Regel testen“: where `page_id` would go under `filing` (unsaved settings), and why.
    pub fn filing_preview(&self, page_id: i64, filing: &FilingSettings) -> Result<FilingPreview> {
        let mut settings = self.load_settings().unwrap_or_default();
        settings.filing = filing.clone().normalized();
        let facts = self.page_facts(page_id)?;
        let info = self.page_file_info(page_id)?;
        let target = filing_target(&settings, &facts, info.as_ref());
        Ok(FilingPreview {
            kind: info.map(|i| i.kind),
            rule: target.as_ref().and_then(|t| t.rule.clone()),
            path: target.map(|t| t.path()),
            current: self.page_path(page_id)?,
        })
    }

    /// The recorded (or recognizable) type of a page.
    pub fn page_file_info(&self, page_id: i64) -> Result<Option<FileInfo>> {
        let plan = tidy::Snapshot::read(self)?;
        Ok(plan.info_of(self, page_id))
    }

    /// „Ordner / Unterordner“ of the page's parent (empty at the top level).
    pub fn page_path(&self, page_id: i64) -> Result<String> {
        let mut parts = Vec::new();
        let mut cursor = self.page(page_id)?.parent_id;
        while let Some(id) = cursor {
            let p = self.page(id)?;
            parts.push(p.title);
            cursor = p.parent_id;
        }
        parts.reverse();
        Ok(parts.join(" / "))
    }

    /// The Jira project folder of an issue: `ABC Projektname` (the key alone without a name).
    pub fn jira_group(&self, issue_key: &str) -> Result<String> {
        let project = issue_key.split_once('-').map_or(issue_key, |(p, _)| p);
        let name: Option<String> = self
            .conn()
            .query_row(
                "SELECT name FROM issue_projects WHERE key = ?1 AND name <> '' ORDER BY site LIMIT 1",
                [project],
                |r| r.get(0),
            )
            .optional()?;
        Ok(match name {
            Some(n) => crate::notes::clean_title(&format!("{project} {n}")),
            None => project.to_owned(),
        })
    }

    /// Sort and color of a folder (`0`: the top level).
    pub fn folder_style(&self, page_id: i64) -> Result<FolderStyle> {
        Ok(self
            .conn()
            .query_row("SELECT sort, folders_first, color FROM folder_prefs WHERE page_id = ?1", [page_id], |r| {
                Ok(FolderStyle { sort: r.get(0)?, folders_first: r.get(1)?, color: r.get(2)? })
            })
            .optional()?
            .unwrap_or_default())
    }

    pub fn set_folder_style(&self, page_id: i64, style: &FolderStyle) -> Result<()> {
        let s = style.clone().normalized();
        if s == FolderStyle::default() {
            self.conn().execute("DELETE FROM folder_prefs WHERE page_id = ?1", [page_id])?;
        } else {
            self.conn().execute(
                "INSERT INTO folder_prefs (page_id, sort, folders_first, color) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(page_id) DO UPDATE SET sort = excluded.sort, folders_first = excluded.folders_first, color = excluded.color",
                params![page_id, s.sort, s.folders_first, s.color],
            )?;
        }
        Ok(())
    }
}

/// Result of „Regel testen“.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FilingPreview {
    pub kind: Option<FileType>,
    /// The id of the deciding rule.
    pub rule: Option<String>,
    /// The folder the page would go to (`None`: it stays where it is).
    pub path: Option<String>,
    /// Where it is now.
    pub current: String,
}
