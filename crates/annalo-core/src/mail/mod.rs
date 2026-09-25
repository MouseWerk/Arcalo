//! „E-Mail als Aufgabe / Notiz“: an e-mail becomes a task, a note or both, linked back to the
//! mail so it can be opened again.
//!
//! * [`outlook`] – the selected or open mails of Outlook Classic (COM through a bundled
//!   PowerShell script, Windows only), saving their attachments and showing a mail again
//! * [`eml`] – `.eml` files (MIME, encoded words, quoted-printable, base64)
//! * [`msg`] – Outlook `.msg` files (compound file with MAPI property streams)
//! * [`paste`] – a pasted header block of a forwarded or copied mail (`Von:`/`From:` …)
//!
//! The link in the Markdown is `[E-Mail: Betreff (Absender, 24.09.2026)](annalo-mail://k3v9x2qa)`:
//! the text says what it is in any other Markdown tool, the id points to a row of `mail_links`
//! (migration 0011) with the Outlook EntryID/StoreID, or the stored `.eml`/`.msg` file. So the
//! Markdown stays clean and carries no mailbox ids; the explicit Markdown export writes the text
//! only ([`export_text`]). Mail bodies stay local: nothing here is offered to the assistant, the
//! notes are tagged with the first privacy marker when asked (default), and the optional task
//! suggestion only goes to a provider marked local.

pub mod eml;
pub mod msg;
pub mod outlook;
pub mod paste;

use std::path::{Path, PathBuf};

use chrono::{DateTime, NaiveDate, Utc};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::calsync::tz::Zone;
use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::model::Page;

/// Scheme of the links to a mail (`annalo-mail://<id>`).
pub const SCHEME: &str = "annalo-mail://";

/// Parent page of new mail notes when the settings name none.
pub const DEFAULT_PARENT: &str = "E-Mails";

/// Longest mail text kept (characters), like the Outlook script cuts it.
pub const MAX_BODY: usize = 20_000;

/// Largest file taken as a mail (`.eml`/`.msg`).
pub const MAX_FILE: usize = 50 * 1024 * 1024;

/// Folder below the data directory for the files of mails read but not yet taken over.
pub const TEMP_DIR: &str = "mail-temp";

/// Where a mail came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum MailSource {
    /// Outlook Classic (EntryID and StoreID).
    Outlook,
    /// An `.eml` file.
    Eml,
    /// An Outlook `.msg` file.
    Msg,
    /// A pasted header block: nothing to open again.
    #[default]
    Text,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MailAttachment {
    /// 1-based position in the mail (Outlook's `Attachments.Item(i)`).
    pub index: u32,
    pub name: String,
    pub size: u64,
    /// An image of the text (content id, hidden): not offered by default.
    pub inline: bool,
    /// Of a file source: the extracted file, relative to the temp folder.
    pub file: String,
}

/// A mail as read from any source.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Mail {
    pub source: MailSource,
    pub entry_id: String,
    pub store_id: String,
    /// Of a file source: the original file, relative to the temp folder.
    pub file: String,
    /// Of a file source: its name (`Angebot.eml`).
    pub file_name: String,
    pub subject: String,
    pub from_name: String,
    pub from_email: String,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub received: Option<DateTime<Utc>>,
    pub conversation: String,
    /// 0 low, 1 normal, 2 high (Outlook's `Importance`).
    pub importance: u8,
    pub categories: Vec<String>,
    /// Plain text, at most [`MAX_BODY`] characters.
    pub body: String,
    /// The text was cut.
    pub truncated: bool,
    pub attachments: Vec<MailAttachment>,
}

impl Mail {
    /// The sender as shown: the name, else the address.
    pub fn sender(&self) -> &str {
        if self.from_name.trim().is_empty() { self.from_email.trim() } else { self.from_name.trim() }
    }

    /// `Name <address>` (or whichever is known).
    pub fn sender_full(&self) -> String {
        match (self.from_name.trim(), self.from_email.trim()) {
            ("", e) => e.to_owned(),
            (n, "") => n.to_owned(),
            (n, e) if n.eq_ignore_ascii_case(e) => e.to_owned(),
            (n, e) => format!("{n} <{e}>"),
        }
    }

    /// Cuts the text at [`MAX_BODY`] characters and trims names, lists and line ends.
    pub fn normalized(mut self) -> Mail {
        self.subject = one_line(&self.subject);
        self.from_name = one_line(self.from_name.trim_matches(['"', '\'']));
        self.from_email = one_line(&self.from_email);
        // An Exchange (X.500) address the script could not resolve is no address to show.
        if self.from_email.starts_with('/') || !self.from_email.contains('@') {
            self.from_email.clear();
        }
        for list in [&mut self.to, &mut self.cc, &mut self.categories] {
            let mut out: Vec<String> = vec![];
            for x in list.iter().map(|x| one_line(x.trim_matches(['"', '\'']))) {
                if !x.is_empty() && !out.contains(&x) {
                    out.push(x);
                }
            }
            *list = out;
        }
        let body = self.body.replace("\r\n", "\n").replace('\r', "\n");
        let body = body.trim_matches('\n').trim_end();
        if body.chars().count() > MAX_BODY {
            self.body = body.chars().take(MAX_BODY).collect();
            self.truncated = true;
        } else {
            self.body = body.to_owned();
        }
        self.importance = self.importance.min(2);
        self
    }
}

/// Collapses whitespace (line breaks included) into single spaces.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Settings → Kalender → E-Mail (Outlook).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MailSettings {
    /// Top-level page below which mail notes are created.
    pub notes_parent: String,
    /// Global shortcut of „Aktuelle E-Mail übernehmen“ (`""` = off, the default).
    pub shortcut: String,
    /// Attachments are ticked when the dialog opens.
    pub save_attachments: bool,
    /// Mail notes get the first privacy marker as tag, so the assistant keeps them on the
    /// local model.
    pub private_notes: bool,
    /// What the dialog offers first: `task`, `note` or `both`.
    pub default_action: String,
}

impl Default for MailSettings {
    fn default() -> Self {
        MailSettings {
            notes_parent: DEFAULT_PARENT.into(),
            shortcut: String::new(),
            save_attachments: false,
            private_notes: true,
            default_action: "task".into(),
        }
    }
}

impl MailSettings {
    pub fn normalized(mut self) -> MailSettings {
        self.notes_parent = crate::notes::clean_title(&self.notes_parent);
        if self.notes_parent.is_empty() {
            self.notes_parent = DEFAULT_PARENT.into();
        }
        self.shortcut = self.shortcut.trim().to_owned();
        if !matches!(self.default_action.as_str(), "task" | "note" | "both") {
            self.default_action = "task".into();
        }
        self
    }
}

// ------------------------------------------------------------------------------ links

/// Text of the link to a mail: `E-Mail: Betreff (Absender, 24.09.2026)`. Brackets, `#` and
/// line breaks are replaced, so the text never ends the link or becomes a tag.
pub fn link_text(mail: &Mail, zone: &Zone) -> String {
    let subject = if mail.subject.trim().is_empty() { "(ohne Betreff)" } else { mail.subject.trim() };
    let mut detail: Vec<String> = vec![];
    if !mail.sender().is_empty() {
        detail.push(mail.sender().to_owned());
    }
    if let Some(t) = mail.received {
        detail.push(zone.to_wall(t).format("%d.%m.%Y").to_string());
    }
    let text = if detail.is_empty() {
        format!("E-Mail: {subject}")
    } else {
        format!("E-Mail: {subject} ({})", detail.join(", "))
    };
    safe_text(&text)
}

/// Link text or task text that stays one line and never ends a link or becomes a tag.
pub fn safe_text(s: &str) -> String {
    one_line(s)
        .chars()
        .map(|c| match c {
            '[' => '(',
            ']' => ')',
            '#' => '＃',
            '|' => '｜',
            '`' => '\'',
            c => c,
        })
        .collect()
}

/// `[text](annalo-mail://id)`.
pub fn link_markdown(id: &str, text: &str) -> String {
    format!("[{text}]({SCHEME}{id})")
}

/// Spans `(start, end, text, id)` of the mail links in `markdown`.
fn link_spans(markdown: &str) -> Vec<(usize, usize, &str, &str)> {
    let mut out = vec![];
    let needle = format!("]({SCHEME}");
    let mut from = 0;
    while let Some(rel) = markdown[from..].find(&needle) {
        let mid = from + rel;
        let id_start = mid + needle.len();
        let id_len = markdown[id_start..].bytes().take_while(|b| b.is_ascii_alphanumeric()).count();
        let close = id_start + id_len;
        from = id_start;
        if id_len == 0 || !markdown[close..].starts_with(')') {
            continue;
        }
        // The opening bracket on the same line (link texts have no brackets of their own).
        let line_start = markdown[..mid].rfind('\n').map_or(0, |i| i + 1);
        let Some(open) = markdown[line_start..mid].rfind('[').map(|i| line_start + i) else { continue };
        if markdown[open + 1..mid].contains(']') {
            continue;
        }
        out.push((open, close + 1, &markdown[open + 1..mid], &markdown[id_start..close]));
        from = close + 1;
    }
    out
}

/// The ids of the mail links in `markdown`.
pub fn link_ids(markdown: &str) -> Vec<String> {
    link_spans(markdown).into_iter().map(|(.., id)| id.to_owned()).collect()
}

/// `markdown` with every mail link replaced by its text, for Markdown that leaves Annalo
/// (the export): `E-Mail: Betreff (Absender, Datum)`.
pub fn export_text(markdown: &str) -> String {
    let spans = link_spans(markdown);
    if spans.is_empty() {
        return markdown.to_owned();
    }
    let mut out = String::with_capacity(markdown.len());
    let mut at = 0;
    for (start, end, text, _) in spans {
        out.push_str(&markdown[at..start]);
        out.push_str(text);
        at = end;
    }
    out.push_str(&markdown[at..]);
    out
}

/// A mail as stored for its links.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MailLink {
    pub id: String,
    pub source: MailSource,
    pub entry_id: String,
    pub store_id: String,
    /// The stored `.eml`/`.msg` (attachment name).
    pub file: String,
    pub subject: String,
    pub sender: String,
    pub sender_email: String,
    pub received: Option<DateTime<Utc>>,
    pub vorgang: String,
    pub created_at: DateTime<Utc>,
}

fn source_str(s: MailSource) -> &'static str {
    match s {
        MailSource::Outlook => "outlook",
        MailSource::Eml => "eml",
        MailSource::Msg => "msg",
        MailSource::Text => "text",
    }
}

fn source_of(s: &str) -> MailSource {
    match s {
        "outlook" => MailSource::Outlook,
        "eml" => MailSource::Eml,
        "msg" => MailSource::Msg,
        _ => MailSource::Text,
    }
}

/// A short id (8 characters `[0-9a-z]`) derived from `seed`.
fn short_id(seed: &str) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    Sha256::digest(seed.as_bytes()).iter().take(8).map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

impl Database {
    /// The link row of a mail: an existing one for the same Outlook item or stored file, else a
    /// new one. Returns its id.
    pub fn mail_link_upsert(&self, mail: &Mail, file: &str, vorgang: &str, now: DateTime<Utc>) -> Result<String> {
        let existing: Option<String> = match mail.source {
            MailSource::Outlook if !mail.entry_id.is_empty() => self
                .conn()
                .query_row(
                    "SELECT id FROM mail_links WHERE source = 'outlook' AND entry_id = ?1 AND store_id = ?2",
                    params![mail.entry_id, mail.store_id],
                    |r| r.get(0),
                )
                .optional()?,
            MailSource::Eml | MailSource::Msg if !file.is_empty() => self
                .conn()
                .query_row(
                    "SELECT id FROM mail_links WHERE source = ?1 AND file = ?2",
                    params![source_str(mail.source), file],
                    |r| r.get(0),
                )
                .optional()?,
            _ => None,
        };
        if let Some(id) = existing {
            if !vorgang.is_empty() {
                self.conn().execute("UPDATE mail_links SET vorgang = ?2 WHERE id = ?1", params![id, vorgang])?;
            }
            return Ok(id);
        }
        let mut n = 0;
        let id = loop {
            let id = short_id(&format!(
                "{}|{}|{}|{}|{n}",
                mail.entry_id,
                file,
                mail.subject,
                now.timestamp_nanos_opt().unwrap_or(0)
            ));
            let taken: bool =
                self.conn().query_row("SELECT EXISTS(SELECT 1 FROM mail_links WHERE id = ?1)", [&id], |r| r.get(0))?;
            if !taken {
                break id;
            }
            n += 1;
        };
        self.conn().execute(
            "INSERT INTO mail_links (id, source, entry_id, store_id, file, subject, sender, sender_email, received_at, vorgang, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id,
                source_str(mail.source),
                mail.entry_id,
                mail.store_id,
                file,
                mail.subject,
                mail.from_name,
                mail.from_email,
                mail.received.map(ts),
                vorgang,
                ts(now)
            ],
        )?;
        Ok(id)
    }

    pub fn mail_link(&self, id: &str) -> Result<MailLink> {
        self.conn()
            .query_row(
                "SELECT id, source, entry_id, store_id, file, subject, sender, sender_email, received_at, vorgang, created_at
                 FROM mail_links WHERE id = ?1",
                [id.trim()],
                |r| {
                    let received: Option<String> = r.get(8)?;
                    Ok(MailLink {
                        id: r.get(0)?,
                        source: source_of(&r.get::<_, String>(1)?),
                        entry_id: r.get(2)?,
                        store_id: r.get(3)?,
                        file: r.get(4)?,
                        subject: r.get(5)?,
                        sender: r.get(6)?,
                        sender_email: r.get(7)?,
                        received: received.as_deref().map(parse_ts).transpose()?,
                        vorgang: r.get(9)?,
                        created_at: parse_ts(&r.get::<_, String>(10)?)?,
                    })
                },
            )
            .optional()?
            .ok_or_else(|| Error::State("Diese E-Mail ist in Annalo nicht (mehr) verknüpft".into()))
    }
}

// ------------------------------------------------------------------------ taking over

/// Where the task goes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TaskTarget {
    /// Today's daily note.
    Daily,
    /// A page (the current one or a chosen one).
    Page { id: i64 },
    /// The note created from the same mail.
    Note,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskSpec {
    pub target: TaskTarget,
    pub text: String,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub due: Option<String>,
    /// 0 none, 1 mittel, 2 hoch.
    #[serde(default)]
    pub priority: u8,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NoteSpec {
    /// Top-level parent page (created when missing); empty = the settings'.
    pub parent: String,
    /// Title of the note; empty = the subject.
    pub title: String,
}

/// What to make of a mail.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MailImport {
    pub mail: Mail,
    pub task: Option<TaskSpec>,
    pub note: Option<NoteSpec>,
    /// `NP-8801/1020`, for booking later (note: `vorgang:` property; task: named in the text).
    pub vorgang: String,
    /// Tags (the Outlook categories the user took over).
    pub tags: Vec<String>,
    /// Indexes of the attachments to store.
    pub attachments: Vec<u32>,
}

/// Files stored for a mail before it is taken over.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct StoredFiles {
    /// The `.eml`/`.msg` itself (attachment name).
    pub original: Option<String>,
    /// The chosen attachments (attachment names).
    pub attachments: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MailCreated {
    /// Id of the mail link (`None` for a pasted mail: nothing to open).
    pub link: Option<String>,
    pub task_page: Option<Page>,
    pub note_page: Option<Page>,
    pub attachments: Vec<String>,
}

/// A tag as written (`#Projekt X` → `projekt-x`); empty when nothing is left.
pub fn tag_of(category: &str) -> String {
    let mut out = String::new();
    for c in category.trim().trim_start_matches('#').chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' || c == '/' {
            out.extend(c.to_lowercase());
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    let out = out.trim_matches(['-', '/']).to_owned();
    if out.chars().all(|c| c.is_ascii_digit()) { String::new() } else { out }
}

/// The task line: `- [ ] Text [E-Mail: …](annalo-mail://id) (NP/VG) due:… !! #tag`.
pub fn task_line(spec: &TaskSpec, link: Option<&str>, vorgang: &str, tags: &[String]) -> String {
    let mut line = format!("- [ ] {}", safe_text(spec.text.trim()));
    if let Some(l) = link {
        line.push(' ');
        line.push_str(l);
    }
    if !vorgang.trim().is_empty() {
        line.push_str(&format!(" ({})", vorgang.trim()));
    }
    if let Some(d) = spec.due.as_deref().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()) {
        line.push_str(&format!(" due:{d}"));
    }
    match spec.priority {
        2 => line.push_str(" !!"),
        1 => line.push_str(" !"),
        _ => {}
    }
    for t in tags.iter().map(|t| tag_of(t)).filter(|t| !t.is_empty()) {
        line.push_str(&format!(" #{t}"));
    }
    line
}

/// Adds a task line to a page: below the last item of an `Aufgaben`/`Tasks` section, else at the end.
pub fn insert_task(content: &str, line: &str) -> String {
    let lines: Vec<&str> = content.lines().collect();
    let heading = lines.iter().position(|l| {
        let t = l.trim_start_matches('#').trim();
        l.starts_with('#')
            && (t.eq_ignore_ascii_case("aufgaben") || t.eq_ignore_ascii_case("tasks") || t.eq_ignore_ascii_case("todo"))
    });
    if let Some(h) = heading {
        let level = lines[h].chars().take_while(|c| *c == '#').count();
        let end = lines[h + 1..]
            .iter()
            .position(|l| l.starts_with('#') && l.chars().take_while(|c| *c == '#').count() <= level)
            .map_or(lines.len(), |i| h + 1 + i);
        // After the last non-empty line of the section; an empty `- [ ]` placeholder is replaced.
        let mut last = h;
        for (i, l) in lines.iter().enumerate().take(end).skip(h + 1) {
            if !l.trim().is_empty() {
                last = i;
            }
        }
        let mut out: Vec<String> = lines.iter().map(|l| (*l).to_owned()).collect();
        if last > h && matches!(out[last].trim(), "- [ ]" | "- [ ] " | "-") {
            out[last] = line.to_owned();
        } else if last == h {
            out.insert(h + 1, String::new());
            out.insert(h + 2, line.to_owned());
        } else {
            out.insert(last + 1, line.to_owned());
        }
        let mut s = out.join("\n");
        s.push('\n');
        return s;
    }
    let body = content.trim_end();
    if body.is_empty() {
        return format!("{line}\n");
    }
    let last = body.lines().last().unwrap_or("").trim_start();
    let sep = if last.starts_with("- ") || last.starts_with("* ") { "\n" } else { "\n\n" };
    format!("{body}{sep}{line}\n")
}

fn yaml(v: &str) -> String {
    format!("\"{}\"", one_line(v).replace('\\', "\\\\").replace('"', "\\\""))
}

/// The Markdown of a mail note: front matter (von, an, cc, datum, betreff, e-mail link,
/// vorgang, tags), the link, the text as a quote and the attachments.
pub fn note_markdown(
    mail: &Mail,
    link: Option<&str>,
    link_id: Option<&str>,
    vorgang: &str,
    tags: &[String],
    files: &StoredFiles,
    zone: &Zone,
) -> String {
    let mut front = vec![];
    if !mail.sender_full().is_empty() {
        front.push(format!("von: {}", yaml(&mail.sender_full())));
    }
    if !mail.to.is_empty() {
        front.push(format!("an: {}", yaml(&mail.to.join("; "))));
    }
    if !mail.cc.is_empty() {
        front.push(format!("cc: {}", yaml(&mail.cc.join("; "))));
    }
    if let Some(t) = mail.received {
        front.push(format!("datum: {}", zone.to_wall(t).format("%Y-%m-%d %H:%M")));
    }
    front.push(format!("betreff: {}", yaml(&mail.subject)));
    if let Some(id) = link_id {
        front.push(format!("e-mail: {SCHEME}{id}"));
    }
    if !vorgang.trim().is_empty() {
        front.push(format!("vorgang: {}", vorgang.trim()));
    }
    let tags: Vec<String> = tags.iter().map(|t| tag_of(t)).filter(|t| !t.is_empty()).collect();
    if !tags.is_empty() {
        front.push(format!("tags: [{}]", tags.join(", ")));
    }
    let mut body = String::new();
    if let Some(l) = link {
        body.push_str(l);
        body.push_str("\n\n");
    }
    if mail.body.trim().is_empty() {
        body.push_str("> *(kein Text)*\n");
    } else {
        for l in mail.body.lines() {
            let l = l.trim_end();
            if l.is_empty() {
                body.push_str(">\n");
            } else {
                body.push_str("> ");
                body.push_str(l);
                body.push('\n');
            }
        }
        if mail.truncated {
            body.push_str(">\n> *(gekürzt)*\n");
        }
    }
    if !files.attachments.is_empty() {
        body.push_str("\n## Anhänge\n\n");
        for a in &files.attachments {
            body.push_str(&format!("![[{a}]]\n\n"));
        }
    }
    if let Some(o) = &files.original {
        body.push_str(&format!("\nOriginal: [[{o}]]\n"));
    }
    let mut body = body.trim_end().to_owned();
    body.push_str("\n\n## Notizen\n\n");
    format!("---\n{}\n---\n{body}", front.join("\n"))
}

impl Database {
    /// Takes a mail over: the link row, the note (below the parent page) and the task line, all
    /// in one transaction. `files` were stored before (no lock held while copying).
    pub fn mail_create(
        &self,
        req: &MailImport,
        files: &StoredFiles,
        settings: &MailSettings,
        private_marker: Option<&str>,
        zone: &Zone,
        now: DateTime<Utc>,
    ) -> Result<MailCreated> {
        let mail = &req.mail;
        if req.task.is_none() && req.note.is_none() {
            return Err(Error::State("Bitte „Aufgabe“ oder „Notiz“ wählen".into()));
        }
        if let Some(t) = &req.task
            && t.text.trim().is_empty()
        {
            return Err(Error::State("Die Aufgabe braucht einen Text".into()));
        }
        if matches!(req.task.as_ref().map(|t| &t.target), Some(TaskTarget::Note)) && req.note.is_none() {
            return Err(Error::State("Die Aufgabe soll in die Notiz, es wird aber keine Notiz angelegt".into()));
        }
        let vorgang = req.vorgang.trim();
        self.atomic(|| {
            let linkable = match mail.source {
                MailSource::Outlook => !mail.entry_id.is_empty(),
                MailSource::Eml | MailSource::Msg => files.original.is_some(),
                MailSource::Text => false,
            };
            let link_id = if linkable {
                Some(self.mail_link_upsert(mail, files.original.as_deref().unwrap_or(""), vorgang, now)?)
            } else {
                None
            };
            let link = link_id.as_deref().map(|id| link_markdown(id, &link_text(mail, zone)));
            let mut note_page = None;
            if let Some(spec) = &req.note {
                let parent_title = match crate::notes::clean_title(&spec.parent) {
                    t if t.is_empty() => settings.notes_parent.clone(),
                    t => t,
                };
                let parent_title = if parent_title.is_empty() { DEFAULT_PARENT.to_owned() } else { parent_title };
                let parent = match self
                    .conn()
                    .query_row(
                        "SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
                        [&parent_title],
                        |r| r.get::<_, i64>(0),
                    )
                    .optional()?
                {
                    Some(id) => id,
                    None => self.create_page(None, &parent_title, Some("mail"))?.id,
                };
                let base = match crate::notes::clean_title(if spec.title.trim().is_empty() { &mail.subject } else { &spec.title }) {
                    t if t.is_empty() => "E-Mail".to_owned(),
                    t => t,
                };
                let mut title = base.clone();
                if self.page_by_title(&title)?.is_some()
                    && let Some(t) = mail.received
                {
                    title = crate::notes::clean_title(&format!("{base} {}", zone.to_wall(t).format("%d.%m.%Y")));
                }
                let dated = title.clone();
                let mut n = 2;
                while self.page_by_title(&title)?.is_some() {
                    title = format!("{dated} {n}");
                    n += 1;
                }
                let mut tags: Vec<String> = vec!["e-mail".into()];
                tags.extend(req.tags.iter().cloned());
                if settings.private_notes
                    && let Some(m) = private_marker.map(tag_of).filter(|m| !m.is_empty())
                {
                    tags.push(m);
                }
                let mut seen = std::collections::HashSet::new();
                tags.retain(|t| seen.insert(tag_of(t)));
                let page = self.create_page(Some(parent), &title, Some("mail"))?;
                let mut content = note_markdown(mail, link.as_deref(), link_id.as_deref(), vorgang, &tags, files, zone);
                if let Some(t) = req.task.as_ref().filter(|t| t.target == TaskTarget::Note) {
                    content.push_str(&task_line(t, None, "", &req.tags));
                    content.push('\n');
                }
                self.save_page_content(page.id, &content)?;
                note_page = Some(self.page(page.id)?);
            }
            let mut task_page = None;
            if let Some(spec) = req.task.as_ref().filter(|t| t.target != TaskTarget::Note) {
                let page = match spec.target {
                    TaskTarget::Daily => self.daily_note(zone.to_wall(now).date())?,
                    TaskTarget::Page { id } => {
                        let p = self.page(id)?;
                        if p.deleted_at.is_some() {
                            return Err(Error::State(format!("„{}“ liegt im Papierkorb", p.title)));
                        }
                        p
                    }
                    TaskTarget::Note => unreachable!(),
                };
                let mut link = link.clone();
                if let Some(n) = &note_page {
                    link = Some(match link {
                        Some(l) => format!("{l} [[{}]]", n.title),
                        None => format!("[[{}]]", n.title),
                    });
                }
                // With a note the reference is in its properties already.
                let vg = if note_page.is_some() { "" } else { vorgang };
                let line = task_line(spec, link.as_deref(), vg, &req.tags);
                let content = self.page_doc(page.id)?.content;
                self.save_page_content(page.id, &insert_task(&content, &line))?;
                task_page = Some(self.page(page.id)?);
            }
            Ok(MailCreated { link: link_id, task_page, note_page, attachments: files.attachments.clone() })
        })
    }
}

// ------------------------------------------------------------------------- temp files

/// A mail read from a file, with the bytes of its attachments (by index, 1-based).
#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub mail: Mail,
    pub parts: Vec<Vec<u8>>,
}

/// Reads an `.eml` or `.msg` file (by content: a compound file is a `.msg`).
pub fn parse_file(name: &str, bytes: &[u8]) -> Result<Parsed> {
    if bytes.is_empty() {
        return Err(Error::State(format!("„{name}“ ist leer")));
    }
    if bytes.len() > MAX_FILE {
        return Err(Error::State(format!("„{name}“ ist größer als {} MB", MAX_FILE / 1024 / 1024)));
    }
    let mut parsed = if msg::is_compound(bytes) {
        msg::parse(bytes)
            .map_err(|e| Error::State(format!("„{name}“ ließ sich nicht als Outlook-Nachricht lesen: {e}")))?
    } else if name.to_ascii_lowercase().ends_with(".msg") {
        return Err(Error::State(format!("„{name}“ ist keine Outlook-Nachricht (.msg)")));
    } else {
        eml::parse(bytes).ok_or_else(|| Error::State(format!("„{name}“ ist keine lesbare E-Mail (.eml)")))?
    };
    parsed.mail.file_name = name.rsplit(['/', '\\']).next().unwrap_or(name).to_owned();
    parsed.mail = std::mem::take(&mut parsed.mail).normalized();
    Ok(parsed)
}

/// Writes the original file and the attachments of a parsed mail to `temp_root/<hash>/` and
/// returns the mail pointing at them (relative paths).
pub fn stage(temp_root: &Path, name: &str, bytes: &[u8], parsed: Parsed) -> Result<Mail> {
    let hash: String = Sha256::digest(bytes).iter().take(8).map(|b| format!("{b:02x}")).collect();
    let dir = temp_root.join(&hash);
    std::fs::create_dir_all(&dir)?;
    let clean = crate::attachments::clean_name(name).unwrap_or_else(|_| {
        if parsed.mail.source == MailSource::Msg { "E-Mail.msg".into() } else { "E-Mail.eml".into() }
    });
    std::fs::write(dir.join(&clean), bytes)?;
    let mut mail = parsed.mail;
    mail.file = format!("{hash}/{clean}");
    for (i, a) in mail.attachments.iter_mut().enumerate() {
        let Some(data) = parsed.parts.get(i) else { continue };
        let Ok(file) = crate::attachments::clean_name(&a.name) else { continue };
        let sub = dir.join(a.index.to_string());
        std::fs::create_dir_all(&sub)?;
        std::fs::write(sub.join(&file), data)?;
        a.file = format!("{hash}/{}/{file}", a.index);
    }
    Ok(mail)
}

/// A file below the temp folder named by a mail (`hash/name`, `hash/2/name`); nothing else.
pub fn temp_file(temp_root: &Path, rel: &str) -> Option<PathBuf> {
    let parts: Vec<&str> = rel.split('/').collect();
    let ok = (2..=3).contains(&parts.len())
        && parts.iter().all(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains(['\\', ':', '\0']))
        && parts[0].len() == 16
        && parts[0].bytes().all(|b| b.is_ascii_hexdigit());
    let path = parts.iter().fold(temp_root.to_path_buf(), |p, x| p.join(x));
    (ok && path.is_file()).then_some(path)
}

/// Removes staged mails older than `max_age` (read but never taken over).
pub fn clean_temp(temp_root: &Path, max_age: std::time::Duration) {
    let Ok(entries) = std::fs::read_dir(temp_root) else { return };
    for e in entries.flatten() {
        let old =
            e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|a| a > max_age);
        if old {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

// ------------------------------------------------------------------ task suggestion (local AI)

/// What the local model suggests.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Suggestion {
    pub task: String,
    pub due: Option<String>,
}

/// The instruction for the local model (German, JSON answer).
pub fn suggestion_messages(mail: &Mail, today: NaiveDate) -> (String, String) {
    let system = format!(
        "Du liest eine E-Mail und formulierst daraus genau eine Aufgabe für den Empfänger. Antworte nur mit JSON: \
         {{\"aufgabe\": \"kurzer Imperativ, höchstens 12 Wörter\", \"faellig\": \"YYYY-MM-DD oder null\"}}. \
         Ein Datum nur, wenn die E-Mail eine Frist nennt; relative Angaben (bis Freitag, nächste Woche) von heute aus \
         umrechnen. Heute ist {} ({}).",
        today.format("%Y-%m-%d"),
        weekday_de(today)
    );
    let body: String = mail.body.chars().take(6000).collect();
    let user = format!("Betreff: {}\nVon: {}\n\n{}", mail.subject, mail.sender(), body);
    (system, user)
}

fn weekday_de(d: NaiveDate) -> &'static str {
    use chrono::Datelike;
    ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"]
        [d.weekday().num_days_from_monday() as usize]
}

/// Reads the model's answer: JSON (also inside a code fence or after some text), else the
/// first line as the task.
pub fn parse_suggestion(answer: &str) -> Option<Suggestion> {
    let a = answer.trim();
    if let (Some(s), Some(e)) = (a.find('{'), a.rfind('}'))
        && s < e
        && let Ok(v) = serde_json::from_str::<serde_json::Value>(&a[s..=e])
    {
        let task = ["aufgabe", "task", "text"].iter().find_map(|k| v[k].as_str()).unwrap_or("").trim().to_owned();
        let due = ["faellig", "fällig", "due"]
            .iter()
            .find_map(|k| v[k].as_str())
            .map(str::trim)
            .filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok())
            .map(str::to_owned);
        return (!task.is_empty()).then(|| Suggestion { task: safe_text(&task), due });
    }
    let line = a
        .lines()
        .map(|l| l.trim().trim_start_matches(['-', '*', ' ']))
        .find(|l| !l.is_empty() && !l.starts_with("```"))?;
    Some(Suggestion { task: safe_text(line.trim_matches('"')), due: None })
}

#[cfg(test)]
mod tests;
