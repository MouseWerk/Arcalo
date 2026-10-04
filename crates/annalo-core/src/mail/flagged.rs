//! Flagged Outlook mails for the start page („Markierte E-Mails“): the To-Do list of Outlook
//! Classic read by `outlook-mail.ps1 -Mode flagged` (never starting Outlook), each mail as
//! „Aktuelle E-Mail übernehmen“ reads it plus the flag's due date and text, so „Als Aufgabe“
//! hands it to the same dialog.
//!
//! For tests and development `ANNALO_OUTLOOK_FLAGGED_FIXTURE` names a JSON file with the
//! script's output (only with `ANNALO_TEST_FIXTURES=1`); „open“ then appends
//! `EntryID<TAB>StoreID` to `<fixture>.opened` like the mail fixture.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use chrono::NaiveDate;
use serde::Serialize;

use super::Mail;
use super::outlook::{SCRIPT, SCRIPT_FILE, TIMEOUT};
use crate::error::{Error, Result};
use crate::outlookcom::{self, Script, text};
use crate::tr;

/// At most this many flagged mails are listed.
pub const MAX_FLAGGED: usize = 30;

/// Characters of a mail's text handed to the task dialog.
const MAX_BODY: usize = 4000;

const SCRIPT_REF: Script = Script { file: SCRIPT_FILE, source: SCRIPT };

/// A flagged mail.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FlaggedMail {
    #[serde(flatten)]
    pub mail: Mail,
    /// Due date of the flag (`None`: no date).
    pub flag_due: Option<NaiveDate>,
    /// The flag's text („Zur Nachverfolgung“, „Antworten“).
    pub flag_request: String,
}

/// The fixture replacing the script.
pub fn fixture_path() -> Option<PathBuf> {
    if std::env::var("ANNALO_TEST_FIXTURES").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var_os("ANNALO_OUTLOOK_FLAGGED_FIXTURE").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Whether the widget can list flagged mails here (Windows, or the fixture).
pub fn available() -> bool {
    cfg!(windows) || fixture_path().is_some()
}

/// The flagged mails of a `flagged` output, in the script's order (earliest due first).
pub fn parse_output(out: &str) -> Result<Vec<FlaggedMail>> {
    let v = outlookcom::json(out)?;
    if let Some((code, message)) = outlookcom::failure(&v) {
        return Err(Error::State(match code.as_str() {
            "not_running" => tr!(
                "Outlook läuft nicht. Sobald Outlook geöffnet ist, erscheinen hier die markierten E-Mails.",
                "Outlook is not running. Once Outlook is open, the flagged e-mails appear here."
            )
            .into(),
            "not_installed" | "new_outlook" => {
                tr!("Markierte E-Mails gibt es nur mit Outlook (klassisch).", "Flagged e-mails need Outlook (classic).")
                    .into()
            }
            _ => crate::trf!(
                "Outlook hat die Liste nicht geliefert: {}. Outlook neu starten und die Liste neu laden.",
                "Outlook did not return the list: {}. Restart Outlook and reload the list.",
                message.trim_end_matches('.')
            ),
        }));
    }
    // The items are what `read` returns: parse them the same way.
    let mut out = vec![];
    for it in outlookcom::items(&v, "items").iter().take(MAX_FLAGGED) {
        let one = serde_json::json!({ "ok": true, "items": [it] });
        let Ok(mut mails) = super::outlook::parse_output(&one.to_string()) else { continue };
        let Some(mut mail) = mails.pop() else { continue };
        if mail.body.chars().count() > MAX_BODY {
            mail.body = mail.body.chars().take(MAX_BODY).collect();
            mail.truncated = true;
        }
        out.push(FlaggedMail {
            mail,
            flag_due: text(it, "flagDue").get(..10).and_then(|d| d.parse().ok()),
            flag_request: text(it, "flagRequest"),
        });
    }
    Ok(out)
}

/// The flagged mails (blocking; runs the script).
pub fn list(script_dir: &Path) -> Result<Vec<FlaggedMail>> {
    if let Some(fixture) = fixture_path() {
        return parse_output(&std::fs::read_to_string(&fixture)?);
    }
    let args: Vec<OsString> = vec![
        "-Mode".into(),
        "flagged".into(),
        "-MaxItems".into(),
        MAX_FLAGGED.to_string().into(),
        "-MaxBody".into(),
        MAX_BODY.to_string().into(),
    ];
    parse_output(&outlookcom::run(
        script_dir,
        SCRIPT_REF,
        &args,
        TIMEOUT,
        tr!("Dann erneut versuchen.", "Then try again."),
    )?)
}

/// Shows a flagged mail in Outlook (blocking).
pub fn open(script_dir: &Path, entry_id: &str, store_id: &str) -> Result<()> {
    if let Some(fixture) = fixture_path() {
        use std::io::Write;
        let mut log = fixture.into_os_string();
        log.push(".opened");
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(PathBuf::from(log))?;
        writeln!(f, "{entry_id}\t{store_id}")?;
        return Ok(());
    }
    super::outlook::open(script_dir, entry_id, store_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flagged_output_is_parsed_with_due_dates() {
        let out = r#"{"ok":true,"version":"16.0","items":[
            {"entryId":"E1","storeId":"S","subject":"Angebot prüfen","senderName":"Müller, Anna","senderEmail":"anna@example.com",
             "to":"","cc":"","received":"2026-09-24T12:32:00Z","conversation":"","importance":2,"categories":"","body":"Bitte bis Freitag",
             "truncated":false,"attachments":[],"flagDue":"2026-10-02","flagRequest":"Zur Nachverfolgung"},
            {"entryId":"E2","storeId":"S","subject":"Ohne Datum","senderName":"Weiss","senderEmail":"w@example.com","received":"",
             "importance":1,"body":"","attachments":[],"flagDue":"","flagRequest":"Antworten"},
            {"entryId":"","subject":"kaputt"}]}"#;
        let list = parse_output(out).unwrap();
        assert_eq!(list.len(), 2, "an item without id is left out");
        assert_eq!(list[0].mail.subject, "Angebot prüfen");
        assert_eq!(list[0].flag_due, NaiveDate::from_ymd_opt(2026, 10, 2));
        assert_eq!(list[0].mail.importance, 2);
        assert_eq!((list[1].flag_due, list[1].flag_request.as_str()), (None, "Antworten"));
        let json = serde_json::to_value(&list[0]).unwrap();
        assert_eq!(json["entry_id"], "E1");
        assert_eq!(json["flag_due"], "2026-10-02");
    }

    #[test]
    fn script_failures_become_readable_errors() {
        let e = parse_output(r#"{"ok":false,"error":"not_running","message":"OUTLOOK"}"#).unwrap_err();
        assert!(e.to_string().contains("Outlook"));
        assert!(parse_output(r#"{"ok":true,"items":[]}"#).unwrap().is_empty());
    }
}
