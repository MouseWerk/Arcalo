//! Focus blocks written to Outlook Classic (Windows): the write mode of the calendar script
//! (`-Mode write -Ops <file>`) creates, updates and deletes the appointments of the blocks in
//! the default calendar (busy, category „Arcalo“, no reminder). It only attaches to an Outlook
//! that is already running and never starts one: with Outlook closed the whole run fails with
//! `not_running` and the writes wait in the queue ([`crate::timeblocks`]). Every appointment
//! carries the block's marker (user property `ArcaloBlock`): a write without EntryID looks it up
//! by that first, so a write whose answer got lost does not add a second appointment.
//!
//! For development and tests, `ANNALO_OUTLOOK_WRITE_LOG` (with `ANNALO_TEST_FIXTURES=1`) names a
//! file the writes are appended to as JSON lines instead; the appointments get the EntryID
//! `ARC-<write>-<n>` (global id `G-` and the same) and are found by marker like in Outlook.
//! While a file `<log>.offline` exists, Outlook counts as closed.

use crate::{tr, trf};
use std::ffi::OsString;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

use super::outlook::{SCRIPT, SCRIPT_FILE};
use crate::error::{Error, Result};
use crate::outlookcom::{self, Script};
use crate::timeblocks::{Bridge, CATEGORY, WriteOp, WriteResult};

/// The writes of a run, next to the script.
pub const OPS_FILE: &str = "outlook-writes.json";

/// Writing a few appointments is quick once Outlook runs.
pub const TIMEOUT: Duration = Duration::from_secs(60);

/// The log replacing Outlook (tests and development on other systems).
pub fn fixture_log() -> Option<PathBuf> {
    if std::env::var("ANNALO_TEST_FIXTURES").ok().as_deref() != Some("1") {
        return None;
    }
    std::env::var_os("ANNALO_OUTLOOK_WRITE_LOG").map(PathBuf::from).filter(|p| !p.as_os_str().is_empty())
}

/// Whether blocks can be written to Outlook here.
pub fn available() -> bool {
    cfg!(windows) || fixture_log().is_some()
}

/// The message of a run that found Outlook closed.
pub fn not_running() -> String {
    tr!(
        "Outlook ist nicht geöffnet. Der Termin wird eingetragen, sobald Outlook läuft.",
        "Outlook is not open. The appointment is added once Outlook runs."
    )
    .into()
}

fn error_text(code: &str, detail: &str) -> String {
    match code {
        "not_running" => not_running(),
        "not_found" => tr!("Der Termin ist in Outlook nicht mehr da", "The appointment is gone from Outlook").into(),
        "new_outlook" | "not_installed" => tr!(
            "Outlook (klassisch) ist hier nicht verfügbar; Fokusblöcke bleiben nur in Arcalo.",
            "Outlook (classic) is not available here; focus blocks stay in Arcalo only."
        )
        .into(),
        _ => trf!(
            "Outlook hat den Termin nicht gespeichert: {}",
            "Outlook did not save the appointment: {}",
            if detail.is_empty() { code } else { detail }
        ),
    }
}

/// The ops for the script (`-Ops`): ASCII is not needed here, the script reads the file as UTF-8.
pub fn ops_json(ops: &[WriteOp]) -> Value {
    let fmt = |t: Option<chrono::NaiveDateTime>| t.map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string());
    Value::Array(
        ops.iter()
            .map(|o| {
                json!({
                    "id": o.key,
                    "marker": o.marker,
                    "op": o.op,
                    "entryId": o.entry_id.clone().unwrap_or_default(),
                    "subject": o.subject,
                    "start": fmt(o.start),
                    "end": fmt(o.end),
                    "category": CATEGORY,
                })
            })
            .collect(),
    )
}

/// The script's answer: `{"ok":true,"results":[{id, ok, entryId, globalId, error, message}]}`.
pub fn parse_output(text: &str) -> Result<Vec<WriteResult>> {
    let v = outlookcom::json(text)?;
    if let Some((code, message)) = outlookcom::failure(&v) {
        return Err(Error::State(error_text(&code, &message)));
    }
    Ok(outlookcom::items(&v, "results")
        .iter()
        .map(|r| {
            let ok = outlookcom::truthy(&r["ok"]);
            let opt = |k: &str| Some(outlookcom::text(r, k)).filter(|x| !x.is_empty());
            WriteResult {
                key: outlookcom::int(r, "id"),
                ok,
                entry_id: opt("entryId"),
                global_id: opt("globalId"),
                error: (!ok).then(|| error_text(&outlookcom::text(r, "error"), &outlookcom::text(r, "message"))),
            }
        })
        .collect())
}

/// Appends the writes to the fixture log and answers like the script.
fn fixture_write(log: &Path, ops: &[WriteOp]) -> Result<Vec<WriteResult>> {
    let mut offline = log.as_os_str().to_owned();
    offline.push(".offline");
    if Path::new(&offline).exists() {
        return Err(Error::State(not_running()));
    }
    let text = std::fs::read_to_string(log).unwrap_or_default();
    let lines = text.lines().count();
    // The appointments in the fixture's "Outlook" by marker (the last write of each).
    let mut by_marker: std::collections::HashMap<String, Option<String>> = Default::default();
    for v in text.lines().filter_map(|l| serde_json::from_str::<Value>(l).ok()) {
        let entry = v["entryId"].as_str().filter(|e| !e.is_empty()).map(str::to_owned);
        by_marker.insert(v["marker"].as_str().unwrap_or_default().to_owned(), entry.filter(|_| v["op"] == "upsert"));
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    let mut out = vec![];
    for (i, o) in ops.iter().enumerate() {
        let found = by_marker.get(&o.marker).cloned().flatten();
        let entry = match (&o.op[..], &o.entry_id) {
            ("upsert", None) => Some(found.unwrap_or_else(|| format!("ARC-{}-{}", o.key, lines + i + 1))),
            (_, None) => found,
            (_, e) => e.clone(),
        };
        let mut line = ops_json(std::slice::from_ref(o))[0].clone();
        line["entryId"] = json!(entry.clone().unwrap_or_default());
        line["busy"] = json!(2);
        line["reminder"] = json!(false);
        writeln!(f, "{line}")?;
        out.push(WriteResult {
            key: o.key,
            ok: true,
            global_id: entry.as_ref().filter(|_| o.op == "upsert").map(|e| format!("G-{e}")),
            entry_id: entry,
            error: None,
        });
    }
    Ok(out)
}

/// Runs the writes (blocking: off the async runtime).
pub fn write(script_dir: &Path, ops: &[WriteOp]) -> Result<Vec<WriteResult>> {
    if let Some(log) = fixture_log() {
        return fixture_write(&log, ops);
    }
    if !cfg!(windows) {
        return Err(Error::State(error_text("not_installed", "")));
    }
    std::fs::create_dir_all(script_dir)?;
    let file = script_dir.join(OPS_FILE);
    std::fs::write(&file, ops_json(ops).to_string())?;
    let args: Vec<OsString> = vec!["-Mode".into(), "write".into(), "-Ops".into(), file.clone().into_os_string()];
    let out = outlookcom::run(
        script_dir,
        Script { file: SCRIPT_FILE, source: SCRIPT },
        &args,
        TIMEOUT,
        tr!("Der Termin wird später erneut eingetragen.", "The appointment is added again later."),
    );
    let _ = std::fs::remove_file(&file);
    parse_output(&out?)
}

/// The bridge of the app: the script (or the fixture) in `script_dir`.
pub struct OutlookBridge {
    pub script_dir: PathBuf,
}

impl Bridge for OutlookBridge {
    fn write(&self, ops: &[WriteOp]) -> Result<Vec<WriteResult>> {
        write(&self.script_dir, ops)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_is_parsed_per_write_and_closed_outlook_fails_the_run() {
        let out = r#"{"ok":true,"results":[{"id":3,"ok":true,"entryId":"00A","globalId":"040000"},
            {"id":"4","ok":false,"error":"save","message":"Kein Zugriff"}]}"#;
        let r = parse_output(out).unwrap();
        assert_eq!(
            (r[0].key, r[0].ok, r[0].entry_id.as_deref(), r[0].global_id.as_deref()),
            (3, true, Some("00A"), Some("040000"))
        );
        assert_eq!((r[1].key, r[1].ok), (4, false));
        assert!(r[1].error.as_deref().unwrap().contains("Kein Zugriff"));
        let e = parse_output(r#"{"ok":false,"error":"not_running","message":""}"#).unwrap_err();
        assert!(e.to_string().contains("nicht geöffnet"), "{e}");
    }

    #[test]
    fn ops_carry_local_times_and_the_category() {
        let op = WriteOp {
            key: 7,
            marker: "arcalo-1".into(),
            op: "upsert".into(),
            entry_id: None,
            subject: "Fokus: Bericht".into(),
            start: chrono::NaiveDate::from_ymd_opt(2026, 10, 5).unwrap().and_hms_opt(9, 0, 0),
            end: chrono::NaiveDate::from_ymd_opt(2026, 10, 5).unwrap().and_hms_opt(10, 0, 0),
            seq: 1,
        };
        let v = ops_json(&[op]);
        assert_eq!(v[0]["start"], "2026-10-05T09:00:00");
        assert_eq!(v[0]["category"], "Arcalo");
        assert_eq!(v[0]["entryId"], "");
        assert_eq!(v[0]["marker"], "arcalo-1");
    }

    #[test]
    fn the_script_has_a_write_mode_that_never_starts_outlook() {
        assert!(SCRIPT.is_ascii());
        assert!(SCRIPT.contains("$Mode -eq 'write'"));
        assert!(SCRIPT.contains("GetActiveObject('Outlook.Application')"));
        assert!(SCRIPT.contains("ReminderSet = $false"));
        assert!(SCRIPT.contains("Find-Marked"), "a write without EntryID looks the appointment up first");
        assert!(SCRIPT.contains("$item.Parent.EntryID -ne $calendar.EntryID"), "one in Deleted Items is gone");
    }
}
