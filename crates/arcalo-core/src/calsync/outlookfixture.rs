//! The stateful stand-in for Outlook in tests and development (`ARCALO_OUTLOOK_WRITE_LOG` with
//! `ARCALO_TEST_FIXTURES=1`): the appointments written from the Kalender ([`super::writes`]) are
//! appended to the log as JSON lines (`"kind":"entry"`), and every read of the Outlook fixture
//! (`ARCALO_OUTLOOK_FIXTURE`) replays them over its items, so an appointment created in Arcalo
//! comes back with the next sync like from Outlook, once. A test stands in for a change made in
//! Outlook with a line `{"kind":"entry","op":"outlook","entryId":…,"fields":{…}}`. The writes
//! answer like the script: by marker for an appointment whose answer got lost, with conflicts,
//! the guards for series, received meetings and attendees, and `sent` for an update the user
//! confirmed. While a file `<log>.offline` exists, Outlook counts as closed.

use std::io::Write;
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, Utc};
use serde_json::{Value, json};

use super::outlook::fixture_path;
use super::tz::Zone;
use super::writes::{EntryOp, EntryResult, LOCAL_FORMAT, LocalFields, error_text};
use crate::error::{Error, Result};
use crate::outlookcom;

/// An appointment of the fixture's Outlook and the calendar it is in (`""`: the default one,
/// else the folder's EntryID).
#[derive(Debug, Clone)]
struct Item {
    folder: String,
    v: Value,
}

#[derive(Debug, Default)]
struct State {
    items: Vec<Item>,
    /// Deleted Items, by the id there.
    trash: Vec<(String, Item)>,
}

fn s(v: &Value, k: &str) -> String {
    outlookcom::text(v, k)
}

/// The local wall-clock value of `start`/`end` of an item.
fn local_of(v: &Value, k: &str) -> String {
    let local = s(v, &format!("{k}Local"));
    if !local.is_empty() {
        return local;
    }
    let utc = s(v, k);
    NaiveDateTime::parse_from_str(utc.trim_end_matches('Z'), LOCAL_FORMAT)
        .map(|t| {
            Zone::Local.to_wall(DateTime::<Utc>::from_naive_utc_and_offset(t, Utc)).format(LOCAL_FORMAT).to_string()
        })
        .unwrap_or_default()
}

fn current(v: &Value) -> LocalFields {
    LocalFields {
        subject: Some(s(v, "subject")),
        start: Some(local_of(v, "start")),
        end: Some(local_of(v, "end")),
        location: Some(s(v, "location")),
    }
}

fn set_fields(v: &mut Value, f: &Value) {
    for (key, field) in [("subject", "subject"), ("location", "location")] {
        if let Some(x) = f.get(field).and_then(Value::as_str) {
            v[key] = json!(x);
        }
    }
    for k in ["start", "end"] {
        if let Some(x) = f.get(k).and_then(Value::as_str) {
            v[format!("{k}Local")] = json!(x);
            v[k] = json!("");
        }
    }
}

/// Anyone invited besides the organizer (like the read: the count when the item has one).
fn invited(v: &Value) -> bool {
    if v.get("recipients").is_some() {
        return outlookcom::int(v, "meetingStatus") != 0 && outlookcom::int(v, "recipients") > 0;
    }
    let organizer = s(v, "organizer").to_lowercase();
    outlookcom::list(v, "attendees", &[';'])
        .iter()
        .any(|a| !a.trim().is_empty() && a.trim().to_lowercase() != organizer)
}

impl State {
    /// The items of the read fixture.
    fn base() -> State {
        let mut st = State::default();
        let Some(v) =
            fixture_path().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| outlookcom::json(&t).ok())
        else {
            return st;
        };
        for it in outlookcom::items(&v, "items") {
            st.items.push(Item { folder: String::new(), v: it });
        }
        if let Some(folders) = v["folders"].as_object() {
            for (k, f) in folders {
                for it in outlookcom::items(f, "items") {
                    st.items.push(Item { folder: k.clone(), v: it });
                }
            }
        }
        st
    }

    fn position(&self, entry: &str) -> Option<usize> {
        (!entry.is_empty()).then(|| self.items.iter().position(|i| s(&i.v, "entryId") == entry)).flatten()
    }

    /// One line of the log applied.
    fn replay(&mut self, line: &Value) {
        if line["kind"] != "entry" {
            return;
        }
        let entry = s(line, "entryId");
        let fields = &line["fields"];
        let modified = line["modified"].clone();
        match s(line, "op").as_str() {
            "create" => match self.position(&entry) {
                Some(i) => {
                    set_fields(&mut self.items[i].v, fields);
                    self.items[i].v["modified"] = modified;
                }
                None => {
                    let mut v = json!({
                        "entryId": entry, "globalId": format!("G-{entry}"), "subject": "", "start": "", "end": "",
                        "startLocal": "", "endLocal": "", "allDay": false, "recurring": false, "busy": 2,
                        "sensitivity": 0, "responseStatus": 0, "meetingStatus": 0, "location": "", "organizer": "",
                        "attendees": [], "categories": "", "body": null, "urls": [], "recipients": 0,
                        "marker": line["marker"].clone(), "modified": modified,
                    });
                    set_fields(&mut v, fields);
                    self.items.push(Item { folder: s(line, "folder"), v });
                }
            },
            "update" | "outlook" => {
                if let Some(i) = self.position(&entry) {
                    set_fields(&mut self.items[i].v, fields);
                    self.items[i].v["modified"] = modified;
                }
            }
            "delete" => {
                if let Some(i) = self.position(&entry) {
                    let it = self.items.remove(i);
                    self.trash.push((s(line, "deletedId"), it));
                }
            }
            "restore" => {
                let deleted = s(line, "deletedId");
                if let Some(i) = self.trash.iter().position(|(d, _)| *d == deleted) {
                    let (_, mut it) = self.trash.remove(i);
                    it.v["entryId"] = json!(entry);
                    it.v["modified"] = modified;
                    set_fields(&mut it.v, fields);
                    it.folder = s(line, "folder");
                    self.items.push(it);
                }
            }
            _ => {}
        }
    }

    fn load(log: &Path) -> (State, usize) {
        let mut st = State::base();
        let text = std::fs::read_to_string(log).unwrap_or_default();
        let mut n = 0;
        for l in text.lines() {
            n += 1;
            if let Ok(v) = serde_json::from_str::<Value>(l) {
                st.replay(&v);
            }
        }
        (st, n)
    }
}

/// The read fixture's output with the log's appointments replayed over it.
pub fn with_log(text: &str, log: &Path) -> Result<String> {
    let mut v = outlookcom::json(text)?;
    if outlookcom::failure(&v).is_some() {
        return Ok(text.to_owned());
    }
    let has_entries = std::fs::read_to_string(log).unwrap_or_default().contains("\"kind\":\"entry\"");
    if !has_entries {
        return Ok(text.to_owned());
    }
    let (st, _) = State::load(log);
    let of =
        |folder: &str| -> Vec<Value> { st.items.iter().filter(|i| i.folder == folder).map(|i| i.v.clone()).collect() };
    v["items"] = Value::Array(of(""));
    let mut folders: Vec<String> = st.items.iter().map(|i| i.folder.clone()).filter(|f| !f.is_empty()).collect();
    if let Some(known) = v["folders"].as_object() {
        folders.extend(known.keys().cloned());
    }
    folders.sort();
    folders.dedup();
    for f in folders {
        if !v["folders"].is_object() {
            v["folders"] = json!({});
        }
        if !v["folders"][&f].is_object() {
            v["folders"][&f] = json!({"ok": true});
        }
        if v["folders"][&f]["ok"] != Value::Bool(false) {
            v["folders"][&f]["items"] = Value::Array(of(&f));
        }
    }
    Ok(v.to_string())
}

fn offline(log: &Path) -> bool {
    let mut p = log.as_os_str().to_owned();
    p.push(".offline");
    Path::new(&p).exists()
}

fn failed(key: i64, code: &str) -> EntryResult {
    EntryResult { key, ok: false, code: Some(code.into()), error: Some(error_text(code, "")), ..Default::default() }
}

/// The writes of a run appended to the log, answered like the script.
pub fn write(log: &Path, ops: &[EntryOp]) -> Result<Vec<EntryResult>> {
    if offline(log) {
        return Err(Error::State(super::outlookwrite::not_running_entries()));
    }
    let (mut st, lines) = State::load(log);
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    let modified = Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let mut out = vec![];
    for (i, o) in ops.iter().enumerate() {
        let folder = if o.calendar.default { String::new() } else { o.calendar.entry_id.clone() };
        let by_entry = o.entry_id.as_deref().and_then(|e| st.position(e)).filter(|&i| st.items[i].folder == folder);
        let found =
            by_entry.or_else(|| st.items.iter().position(|it| it.folder == folder && s(&it.v, "marker") == o.marker));
        let fields = serde_json::to_value(&o.fields)?;
        let mut line = json!({"kind": "entry", "op": o.op, "marker": o.marker, "folder": folder, "fields": fields, "modified": modified});
        let mut res = EntryResult { key: o.key, ok: true, modified: Some(modified.clone()), ..Default::default() };
        match (o.op.as_str(), found) {
            ("create", Some(i)) => line["entryId"] = st.items[i].v["entryId"].clone(),
            ("create", None) => line["entryId"] = json!(format!("ARC-E-{}", lines + i + 1)),
            ("restore", _) => {
                let deleted = o.deleted_id.clone().unwrap_or_default();
                if !st.trash.iter().any(|(d, _)| *d == deleted) {
                    out.push(failed(o.key, "not_found"));
                    continue;
                }
                line["deletedId"] = json!(deleted);
                line["entryId"] = json!(format!("ARC-R-{}", lines + i + 1));
            }
            ("delete", None) => {
                out.push(res);
                continue;
            }
            (_, None) => {
                out.push(failed(o.key, "not_found"));
                continue;
            }
            (op, Some(i)) => {
                let v = &st.items[i].v;
                let status = outlookcom::int(v, "meetingStatus");
                if outlookcom::truthy(&v["recurring"]) {
                    out.push(failed(o.key, "series"));
                    continue;
                }
                if !matches!(status, 0 | 1) {
                    out.push(failed(o.key, "received"));
                    continue;
                }
                line["entryId"] = v["entryId"].clone();
                if op == "delete" {
                    if invited(v) {
                        out.push(failed(o.key, "needs_send"));
                        continue;
                    }
                    let deleted = format!("DEL-{}", s(v, "entryId"));
                    line["deletedId"] = json!(deleted);
                    res.deleted_id = Some(deleted);
                } else {
                    if invited(v) && !o.send {
                        out.push(failed(o.key, "needs_send"));
                        continue;
                    }
                    // A field changed in Outlook since Arcalo saw it, to another value than Arcalo's.
                    let now = current(v);
                    let differs = |seen: &Option<String>, mine: &Option<String>, now: &Option<String>| {
                        seen.is_some() && now != seen && now != mine
                    };
                    let conflict = LocalFields {
                        subject: now
                            .subject
                            .clone()
                            .filter(|_| differs(&o.seen.subject, &o.fields.subject, &now.subject)),
                        start: now.start.clone().filter(|_| differs(&o.seen.start, &o.fields.start, &now.start)),
                        end: now.end.clone().filter(|_| differs(&o.seen.end, &o.fields.end, &now.end)),
                        location: now
                            .location
                            .clone()
                            .filter(|_| differs(&o.seen.location, &o.fields.location, &now.location)),
                    };
                    if conflict != LocalFields::default() {
                        let mut r = failed(o.key, "conflict");
                        r.current = Some(conflict);
                        out.push(r);
                        continue;
                    }
                    line["sent"] = json!(o.send && status == 1 && invited(v));
                }
            }
        }
        writeln!(f, "{line}")?;
        st.replay(&line);
        if o.op != "delete" {
            res.entry_id = Some(s(&line, "entryId"));
            res.global_id = st.position(&s(&line, "entryId")).map(|i| s(&st.items[i].v, "globalId"));
        }
        out.push(res);
    }
    Ok(out)
}

/// „In Outlook öffnen“: noted in the log.
pub fn show(log: &Path, entry_id: &str) -> Result<()> {
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(log)?;
    writeln!(f, "{}", json!({"kind": "show", "entryId": entry_id}))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calsync::writes::CalendarRef;

    fn op(key: i64, op: &str, entry: Option<&str>, fields: LocalFields, seen: LocalFields) -> EntryOp {
        EntryOp {
            key,
            marker: "arcalo-entry-1".into(),
            op: op.into(),
            source: "outlook".into(),
            uid: None,
            calendar: CalendarRef { default: true, ..Default::default() },
            entry_id: entry.map(str::to_owned),
            deleted_id: None,
            fields,
            seen,
            send: false,
            seq: 1,
        }
    }

    #[test]
    fn written_appointments_come_back_with_the_next_read_and_conflict_with_outlook_changes() {
        let dir = std::env::temp_dir().join(format!("arcalo-outlookfixture-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("writes.log");
        let fields = |subject: &str| LocalFields {
            subject: Some(subject.into()),
            start: Some("2026-10-05T09:00:00".into()),
            end: Some("2026-10-05T09:30:00".into()),
            location: Some(String::new()),
        };
        let r = write(&log, &[op(1, "create", None, fields("Neu"), LocalFields::default())]).unwrap();
        let entry = r[0].entry_id.clone().unwrap();
        // Written again without its answer: found by the marker.
        let again = write(&log, &[op(2, "create", None, fields("Neu"), LocalFields::default())]).unwrap();
        assert_eq!(again[0].entry_id.as_deref(), Some(entry.as_str()));
        let read = with_log(r#"{"ok":true,"items":[]}"#, &log).unwrap();
        let v: Value = serde_json::from_str(&read).unwrap();
        assert_eq!(v["items"].as_array().unwrap().len(), 1, "seen once");
        assert_eq!(
            (v["items"][0]["subject"].as_str(), v["items"][0]["startLocal"].as_str()),
            (Some("Neu"), Some("2026-10-05T09:00:00"))
        );

        // Outlook renames it; Arcalo's rename from the old title is a conflict.
        let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
        let outlook = json!({"kind": "entry", "op": "outlook", "entryId": entry, "fields": {"subject": "Aus Outlook"}});
        writeln!(f, "{outlook}").unwrap();
        let mine = LocalFields { subject: Some("Von Arcalo".into()), ..Default::default() };
        let seen = LocalFields { subject: Some("Neu".into()), ..Default::default() };
        let r = write(&log, &[op(3, "update", Some(&entry), mine, seen)]).unwrap();
        assert_eq!((r[0].ok, r[0].code.as_deref()), (false, Some("conflict")));
        assert_eq!(r[0].current.as_ref().and_then(|c| c.subject.as_deref()), Some("Aus Outlook"));

        // Deleted to Deleted Items; a closed Outlook fails the whole run.
        let r = write(&log, &[op(4, "delete", Some(&entry), LocalFields::default(), LocalFields::default())]).unwrap();
        assert!(r[0].deleted_id.is_some());
        let v: Value = serde_json::from_str(&with_log(r#"{"ok":true,"items":[]}"#, &log).unwrap()).unwrap();
        assert!(v["items"].as_array().unwrap().is_empty());
        std::fs::write(dir.join("writes.log.offline"), "").unwrap();
        assert!(write(&log, &[op(5, "create", None, fields("x"), LocalFields::default())]).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
