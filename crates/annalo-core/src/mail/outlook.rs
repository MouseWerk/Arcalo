//! „Aktuelle E-Mail übernehmen“ from Outlook Classic (Windows): the bundled script
//! `outlook-mail.ps1` reads the mails selected in Outlook's main window or the mail open in
//! the window in front (never starting Outlook for that), saves chosen attachments with
//! `Attachment.SaveAsFile` and shows a mail again by `Namespace.GetItemFromID(EntryID, StoreID)`.
//! It runs through [`crate::outlookcom`] like the calendar script: hidden, as the user, with a
//! timeout, ASCII JSON on standard output.
//!
//! For development and tests `ANNALO_OUTLOOK_MAIL_FIXTURE` names a JSON file with the output
//! of `read` (only with `ANNALO_TEST_FIXTURES=1`): `save` then writes the attachments'
//! `data` (base64) and `open` appends `EntryID<TAB>StoreID` to `<fixture>.opened`.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::Value;

use super::{Mail, MailAttachment, MailSource};
use crate::error::{Error, Result};
use crate::outlookcom::{self, Script, int, list, text};

/// The script, embedded so every build carries it.
pub const SCRIPT: &str = include_str!("outlook-mail.ps1");

/// File name of the script in the data folder.
pub const SCRIPT_FILE: &str = "outlook-mail.ps1";

/// Outlook may wait for the user to allow access (object model guard).
pub const TIMEOUT: Duration = Duration::from_secs(90);

/// At most this many selected mails are read.
pub const MAX_ITEMS: usize = 20;

const SCRIPT_REF: Script = Script { file: SCRIPT_FILE, source: SCRIPT };

/// The fixture replacing the script (tests and development on other systems).
pub fn fixture_path() -> Option<PathBuf> {
    if std::env::var("ANNALO_TEST_FIXTURES").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var_os("ANNALO_OUTLOOK_MAIL_FIXTURE").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Whether „Aktuelle E-Mail übernehmen“ can be offered here.
pub fn available() -> bool {
    cfg!(windows) || fixture_path().is_some()
}

/// The German message for an error code of the script.
fn error_text(code: &str, detail: &str) -> String {
    let drop = "Alternativ die E-Mail als Datei speichern (Datei → Speichern unter, .msg) und in Annalo ziehen.";
    match code {
        "not_running" => "Outlook läuft nicht. Outlook öffnen, die E-Mail markieren und erneut „Aktuelle E-Mail übernehmen“ wählen.".into(),
        "no_selection" => "In Outlook ist keine E-Mail markiert oder geöffnet. Eine E-Mail anklicken und erneut versuchen.".into(),
        "not_installed" => format!("Outlook (klassisch) ist auf diesem Computer nicht installiert. {drop}"),
        "new_outlook" => format!("Hier läuft das neue Outlook; es erlaubt anderen Programmen keinen Zugriff auf E-Mails. {drop}"),
        "server_exec" => "Outlook läuft mit anderen Rechten als Annalo (z. B. „Als Administrator ausführen“). Outlook normal starten und erneut versuchen.".into(),
        "constrained" => format!("PowerShell ist auf diesem Computer eingeschränkt (Sprachmodus „{detail}“), der Zugriff auf Outlook ist so nicht möglich. {drop}"),
        "not_found" => "Outlook findet diese E-Mail nicht mehr (gelöscht, verschoben in ein anderes Postfach oder ein Archiv, das nicht geöffnet ist).".into(),
        "save" => format!("Ein Anhang ließ sich nicht speichern: {detail}"),
        _ => format!("Outlook hat die E-Mail nicht geliefert: {}", if detail.is_empty() { code } else { detail }),
    }
}

fn check(v: &Value) -> Result<()> {
    match outlookcom::failure(v) {
        Some((code, message)) => Err(Error::State(error_text(&code, &message))),
        None => Ok(()),
    }
}

/// `2026-09-24T12:32:00Z` (also with offset or `/Date(ms)/`).
fn instant(raw: &str) -> Option<DateTime<Utc>> {
    let r = raw.trim();
    if let Some(ms) = r.strip_prefix("/Date(").and_then(|x| x.strip_suffix(")/")) {
        let ms: i64 = ms.split(['+', '-']).next().filter(|x| !x.is_empty())?.parse().ok()?;
        return DateTime::from_timestamp_millis(ms);
    }
    let t = DateTime::parse_from_rfc3339(r).ok()?.with_timezone(&Utc);
    // Outlook's „none“ date (4501-01-01) for mails never received.
    (chrono::Datelike::year(&t) < 4000).then_some(t)
}

/// The mails of a `read` output.
pub fn parse_output(out: &str) -> Result<Vec<Mail>> {
    let v = outlookcom::json(out)?;
    check(&v)?;
    let mut mails = vec![];
    for it in outlookcom::items(&v, "items").iter().take(MAX_ITEMS) {
        let entry_id = text(it, "entryId");
        if entry_id.is_empty() {
            continue;
        }
        let attachments = outlookcom::items(it, "attachments")
            .iter()
            .map(|a| MailAttachment {
                index: int(a, "index").max(0) as u32,
                name: text(a, "name"),
                size: int(a, "size").max(0) as u64,
                inline: outlookcom::truthy(&a["inline"]),
                file: String::new(),
            })
            .filter(|a| a.index > 0)
            .collect();
        let mail = Mail {
            source: MailSource::Outlook,
            entry_id,
            store_id: text(it, "storeId"),
            subject: text(it, "subject"),
            from_name: text(it, "senderName"),
            from_email: text(it, "senderEmail"),
            to: list(it, "to", &[';']),
            cc: list(it, "cc", &[';']),
            received: instant(&text(it, "received")),
            conversation: text(it, "conversation"),
            importance: int(it, "importance").clamp(0, 2) as u8,
            categories: list(it, "categories", &[',', ';']),
            body: match &it["body"] {
                Value::String(s) => s.clone(),
                _ => String::new(),
            },
            truncated: outlookcom::truthy(&it["truncated"]),
            attachments,
            ..Default::default()
        };
        mails.push(mail.normalized());
    }
    if mails.is_empty() {
        return Err(Error::State(error_text("no_selection", "")));
    }
    Ok(mails)
}

/// The mails selected or open in Outlook (blocking).
pub fn read(script_dir: &Path) -> Result<Vec<Mail>> {
    if let Some(fixture) = fixture_path() {
        return parse_output(&std::fs::read_to_string(&fixture)?);
    }
    let args: Vec<OsString> = vec!["-Mode".into(), "read".into(), "-MaxItems".into(), MAX_ITEMS.to_string().into()];
    parse_output(&outlookcom::run(script_dir, SCRIPT_REF, &args, TIMEOUT, "Dann erneut versuchen.")?)
}

/// The files of a `save` output: `(index, path)`.
pub fn parse_saved(out: &str) -> Result<Vec<(u32, PathBuf)>> {
    let v = outlookcom::json(out)?;
    check(&v)?;
    Ok(outlookcom::items(&v, "files")
        .iter()
        .filter_map(|f| {
            let path = text(f, "path");
            (!path.is_empty()).then(|| (int(f, "index").max(0) as u32, PathBuf::from(path)))
        })
        .collect())
}

/// Saves the attachments `indexes` of `mail` into `dir/<index>/` (blocking).
pub fn save_attachments(script_dir: &Path, mail: &Mail, indexes: &[u32], dir: &Path) -> Result<Vec<(u32, PathBuf)>> {
    if indexes.is_empty() {
        return Ok(vec![]);
    }
    std::fs::create_dir_all(dir)?;
    if let Some(fixture) = fixture_path() {
        let v = outlookcom::json(&std::fs::read_to_string(&fixture)?)?;
        let item = outlookcom::items(&v, "items").into_iter().find(|it| text(it, "entryId") == mail.entry_id);
        let Some(item) = item else { return Err(Error::State(error_text("not_found", ""))) };
        let mut out = vec![];
        for a in outlookcom::items(&item, "attachments") {
            let index = int(&a, "index").max(0) as u32;
            if !indexes.contains(&index) {
                continue;
            }
            let data = base64::engine::general_purpose::STANDARD.decode(text(&a, "data")).unwrap_or_default();
            let sub = dir.join(index.to_string());
            std::fs::create_dir_all(&sub)?;
            let path = sub.join(crate::attachments::clean_name(&text(&a, "name"))?);
            std::fs::write(&path, data)?;
            out.push((index, path));
        }
        return Ok(out);
    }
    let list = indexes.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
    let args: Vec<OsString> = vec![
        "-Mode".into(),
        "save".into(),
        "-EntryId".into(),
        mail.entry_id.clone().into(),
        "-StoreId".into(),
        mail.store_id.clone().into(),
        "-Indexes".into(),
        list.into(),
        "-Dir".into(),
        dir.as_os_str().to_owned(),
    ];
    parse_saved(&outlookcom::run(script_dir, SCRIPT_REF, &args, TIMEOUT, "Dann erneut versuchen.")?)
}

/// Shows a mail in Outlook again (blocking).
pub fn open(script_dir: &Path, entry_id: &str, store_id: &str) -> Result<()> {
    if entry_id.trim().is_empty() {
        return Err(Error::State("Zu dieser E-Mail ist keine Outlook-Kennung gespeichert".into()));
    }
    if let Some(fixture) = fixture_path() {
        use std::io::Write;
        let mut log = fixture.into_os_string();
        log.push(".opened");
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(PathBuf::from(log))?;
        writeln!(f, "{entry_id}\t{store_id}")?;
        return Ok(());
    }
    let args: Vec<OsString> =
        vec!["-Mode".into(), "open".into(), "-EntryId".into(), entry_id.into(), "-StoreId".into(), store_id.into()];
    check(&outlookcom::json(&outlookcom::run(script_dir, SCRIPT_REF, &args, TIMEOUT, "Dann erneut versuchen.")?)?)
}
