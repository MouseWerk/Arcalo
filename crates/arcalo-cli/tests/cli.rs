//! The command line against a workspace in a temporary folder, as a script or an AI agent runs
//! it: exit codes, JSON output, errors, and what the app sees afterwards (versions, the change
//! journal, a write that waits for another connection's transaction).

use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use arcalo_core::Database;
use arcalo_core::cipher::{self, DbKey};
use arcalo_core::external::Change;
use serde_json::{Value, json};

/// A data folder with a workspace, removed afterwards.
struct Ws {
    dir: PathBuf,
}

impl Ws {
    fn new(name: &str) -> Ws {
        let dir = std::env::temp_dir().join(format!("arcalo-cli-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // The workspace as the app leaves it after its first start.
        drop(Database::open(dir.join("workspace.db")).unwrap());
        Ws { dir }
    }

    fn db(&self) -> Database {
        Database::open(self.dir.join("workspace.db")).unwrap()
    }

    fn cmd(&self, args: &[&str]) -> Command {
        let mut c = Command::new(env!("CARGO_BIN_EXE_arcalo-cli"));
        c.args(args)
            .env("ARCALO_DATA_DIR", &self.dir)
            .env("ARCALO_LOCALE", "en-US")
            .env("ARCALO_SECRET_STORE", "file")
            .env("TZ", "Europe/Berlin")
            // The mark of a running command (`arcalo_core::cmdlock`) lands here on Linux.
            .env("XDG_DATA_HOME", self.dir.join("xdg"))
            .env_remove("ARCALO_DB")
            .env_remove("ANNALO_DB")
            .env_remove("ARCALO_RECOVERY_KEY")
            .env_remove("ARCALO_DB_PASSWORD");
        c
    }

    fn run(&self, args: &[&str]) -> Output {
        self.cmd(args).output().unwrap()
    }

    fn run_stdin(&self, args: &[&str], input: &str) -> Output {
        use std::io::Write;
        let mut child =
            self.cmd(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
        child.wait_with_output().unwrap()
    }

    /// Runs with `--json`, expects success and returns the value.
    fn json(&self, args: &[&str]) -> Value {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let out = self.run(&all);
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        serde_json::from_slice(&out.stdout)
            .unwrap_or_else(|e| panic!("{args:?}: {e}: {}", String::from_utf8_lossy(&out.stdout)))
    }

    /// Runs with `--json`, expects exit code `code` and returns the error object.
    fn fails(&self, args: &[&str], code: i32) -> Value {
        let mut all = vec!["--json"];
        all.extend_from_slice(args);
        let out = self.run(&all);
        assert_eq!(out.status.code(), Some(code), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        assert!(out.stdout.is_empty(), "nothing on stdout for an error");
        let v: Value = serde_json::from_slice(&out.stderr)
            .unwrap_or_else(|e| panic!("{e}: {}", String::from_utf8_lossy(&out.stderr)));
        assert_eq!(v["error"]["exit_code"], json!(code));
        v["error"].clone()
    }

    fn text(&self, args: &[&str]) -> String {
        let out = self.run(args);
        assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).unwrap()
    }

    fn content(&self, id: i64) -> String {
        self.db().page_doc(id).unwrap().content
    }
}

impl Drop for Ws {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn id(v: &Value) -> i64 {
    v["id"].as_i64().unwrap()
}

/// `v` without the fields that change from run to run (times).
fn stable(mut v: Value) -> Value {
    fn strip(v: &mut Value) {
        match v {
            Value::Object(m) => {
                for k in ["updated_at", "created_at", "deleted_at", "start", "end", "modified"] {
                    if let Some(x) = m.get_mut(k)
                        && x.is_string()
                    {
                        *x = json!("<time>");
                    }
                }
                m.values_mut().for_each(strip);
            }
            Value::Array(a) => a.iter_mut().for_each(strip),
            _ => {}
        }
    }
    strip(&mut v);
    v
}

#[test]
fn pages_are_created_shown_changed_and_kept_as_versions() {
    let ws = Ws::new("pages");
    let folder = ws.json(&["pages", "create", "Projekte"]);
    let out = ws.run_stdin(
        &["--json", "pages", "create", "Angebot Müller", "--parent", "Projekte", "--stdin"],
        "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n",
    );
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let page: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(page["path"], json!("Projekte/Angebot Müller"));
    assert_eq!(page["parent_id"], folder["id"]);
    // JSON shape of a page with its content (times masked).
    assert_eq!(
        stable(ws.json(&["pages", "show", "Projekte/Angebot Müller"])),
        json!({
            "id": id(&page), "title": "Angebot Müller", "path": "Projekte/Angebot Müller", "parent_id": id(&folder),
            "icon": "file-text", "kind": "note", "daily_date": null, "favorite": false, "updated_at": "<time>",
            "content": "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n", "tags": ["angebot"],
            "links": ["Kunde Müller"], "unresolved_links": ["Kunde Müller"], "backlinks": [],
        })
    );
    // Times carry their offset (Europe/Berlin).
    let shown = ws.json(&["pages", "show", &format!("id:{}", id(&page))]);
    let t = shown["updated_at"].as_str().unwrap();
    assert!(t.ends_with("+02:00") || t.ends_with("+01:00"), "{t}");
    assert_eq!(
        ws.text(&["pages", "show", "Angebot Müller"]),
        "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n"
    );

    // Append: the old text is kept as a version, so the app can undo the change.
    ws.json(&["pages", "append", "Angebot Müller", "- Preis: 12.000 €"]);
    let pid = id(&page);
    assert_eq!(ws.content(pid), "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n\n- Preis: 12.000 €\n");
    let versions = ws.json(&["pages", "versions", "Angebot Müller"]);
    assert_eq!(versions.as_array().unwrap().len(), 1);
    let first = id(&versions[0]);
    assert_eq!(
        ws.text(&["pages", "version", &first.to_string()]),
        "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n"
    );

    // Replace keeps the properties; set and unset change them.
    ws.json(&["pages", "set", "Angebot Müller", "status", "offen"]);
    ws.json(&["pages", "replace", "Angebot Müller", "--body", "Neu geschrieben\n"]);
    assert_eq!(ws.content(pid), "---\nstatus: offen\n---\n\nNeu geschrieben\n");
    assert_eq!(ws.json(&["pages", "props", "Angebot Müller"]), json!({ "status": "offen" }));
    ws.json(&["pages", "set", "Angebot Müller", "team", "[Anna, Ben]"]);
    assert_eq!(ws.json(&["pages", "props", "Angebot Müller"]), json!({ "status": "offen", "team": ["Anna", "Ben"] }));
    ws.json(&["pages", "unset", "Angebot Müller", "status"]);
    ws.json(&["pages", "unset", "Angebot Müller", "team"]);
    assert_eq!(ws.content(pid), "Neu geschrieben\n");
    ws.json(&["pages", "replace", "Angebot Müller", "--whole", "--body", "Ganz neu\n"]);

    // A version back: the current text becomes a version first.
    ws.json(&["pages", "restore-version", "Angebot Müller", &first.to_string()]);
    assert_eq!(ws.content(pid), "# Angebot\n\nErster Entwurf für [[Kunde Müller]] #angebot\n");
    assert!(ws.db().list_versions(pid).unwrap().iter().any(|v| ws.db().version_content(v.id).unwrap() == "Ganz neu\n"));

    // Move, duplicate, tree and list.
    ws.json(&["pages", "move", "Angebot Müller", "--to", "/"]);
    let copy = ws.json(&["pages", "duplicate", "Angebot Müller"]);
    assert_eq!(copy["title"], json!("Angebot Müller (copy)"));
    assert_eq!(ws.content(id(&copy)), ws.content(pid));
    let list: Vec<String> = ws
        .json(&["pages", "list"])
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["path"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(list, ["Projekte", "Angebot Müller", "Angebot Müller (copy)"]);
    let tree = ws.json(&["pages", "tree"]);
    assert_eq!(tree.as_array().unwrap().len(), 3);
    assert_eq!(tree[0]["children"], json!([]));
    assert_eq!(
        ws.text(&["pages", "tree"]),
        format!("Projekte  id:{}\nAngebot Müller  id:{pid}\nAngebot Müller (copy)  id:{}\n", id(&folder), id(&copy))
    );
}

#[test]
fn every_change_is_recorded_for_the_running_app() {
    let ws = Ws::new("journal");
    let start = ws.db().external_change_seq().unwrap();
    let page = ws.json(&["pages", "create", "Neu"]);
    let (seq, change) = ws.db().external_changes_since(start).unwrap();
    assert_eq!(change.unwrap(), Change { pages: vec![id(&page)], tree: true, ..Default::default() });
    ws.json(&["pages", "append", "Neu", "Text"]);
    let (seq2, change) = ws.db().external_changes_since(seq).unwrap();
    assert_eq!(change.unwrap(), Change { pages: vec![id(&page)], ..Default::default() });
    // Reading changes nothing.
    ws.json(&["pages", "show", "Neu"]);
    ws.json(&["tasks", "list"]);
    assert_eq!(ws.db().external_changes_since(seq2).unwrap(), (seq2, None));
    ws.json(&["settings", "set", "notes.trash_retention_days", "14"]);
    assert!(ws.db().external_changes_since(seq2).unwrap().1.unwrap().settings);
}

#[test]
fn exit_codes_and_error_objects() {
    let ws = Ws::new("errors");
    // Usage: an unknown command, a bad date.
    let e = ws.fails(&["frobnicate"], 1);
    assert_eq!(e["code"], json!("usage"));
    assert_eq!(ws.run(&["frobnicate"]).status.code(), Some(1));
    assert_eq!(ws.fails(&["daily", "show", "--date", "31.12.2026"], 1)["code"], json!("usage"));
    // Not found.
    let e = ws.fails(&["pages", "show", "Gibt es nicht"], 2);
    assert_eq!(e, json!({ "code": "not_found", "message": "Page “Gibt es nicht” not found", "exit_code": 2 }));
    let out = ws.run(&["pages", "show", "Gibt es nicht"]);
    assert_eq!(String::from_utf8_lossy(&out.stderr), "Error: Page “Gibt es nicht” not found\n");
    // German when the system says so.
    let out = ws.cmd(&["pages", "show", "Gibt es nicht"]).env("ARCALO_LOCALE", "de-DE").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&out.stderr), "Fehler: Seite „Gibt es nicht“ nicht gefunden\n");
    // Conflict: a title another page has.
    ws.json(&["pages", "create", "A"]);
    ws.json(&["pages", "create", "B"]);
    assert_eq!(ws.fails(&["pages", "rename", "B", "a"], 3)["code"], json!("conflict"));
    // A workspace that does not exist.
    let out = ws.cmd(&["--json", "info"]).env("ARCALO_DATA_DIR", ws.dir.join("nirgends")).output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(!ws.dir.join("nirgends").exists(), "nothing created");
    // --help and --version succeed.
    assert!(ws.run(&["--help"]).status.success());
    assert!(String::from_utf8_lossy(&ws.run(&["--version"]).stdout).starts_with("arcalo "));
}

#[test]
fn ambiguous_titles_list_the_matches() {
    let ws = Ws::new("ambiguous");
    let (a, b) = {
        let db = ws.db();
        let p1 = db.create_page(None, "Kunde A", None).unwrap();
        let p2 = db.create_page(None, "Kunde B", None).unwrap();
        // The tree can hold a title twice (the filing's month folders, imported vaults).
        (db.create_page(Some(p1.id), "Notizen", None).unwrap(), db.create_page(Some(p2.id), "notizen", None).unwrap())
    };
    let e = ws.fails(&["pages", "show", "Notizen"], 1);
    assert_eq!(e["code"], json!("ambiguous"));
    let paths: Vec<&str> = e["matches"].as_array().unwrap().iter().map(|m| m["path"].as_str().unwrap()).collect();
    assert_eq!(paths, ["Kunde A/Notizen", "Kunde B/notizen"]);
    let err = String::from_utf8_lossy(&ws.run(&["pages", "show", "Notizen"]).stderr).into_owned();
    assert!(
        err.contains(&format!("id:{}  Kunde A/Notizen", a.id))
            && err.contains(&format!("id:{}  Kunde B/notizen", b.id)),
        "{err}"
    );
    // By path or id it is one page.
    assert_eq!(id(&ws.json(&["pages", "show", "kunde b/NOTIZEN"])), b.id);
    assert_eq!(id(&ws.json(&["pages", "show", &format!("id:{}", a.id)])), a.id);
    // A number names the page with that id, unless a page has it as its title too.
    assert_eq!(id(&ws.json(&["pages", "show", &a.id.to_string()])), a.id);
    ws.db().create_page(None, &b.id.to_string(), None).unwrap();
    assert_eq!(ws.fails(&["pages", "show", &b.id.to_string()], 1)["matches"].as_array().unwrap().len(), 2);
}

#[test]
fn trash_restore_and_purge_for_good() {
    let ws = Ws::new("trash");
    let parent = ws.json(&["pages", "create", "Alt"]);
    let child = ws.json(&["pages", "create", "Unterseite", "--parent", "Alt", "--body", "x"]);
    let t = ws.json(&["pages", "delete", "Alt"]);
    assert_eq!(t["trashed"], json!(2));
    assert_eq!(ws.json(&["pages", "list"]), json!([]));
    let trash = ws.json(&["trash", "list"]);
    assert_eq!(trash.as_array().unwrap().len(), 1);
    assert_eq!(trash[0]["descendants"], json!(1));
    assert!(trash[0]["deleted_at"].is_string());
    // Only pages in the trash are restored or purged; the page outside it is not found there.
    ws.json(&["pages", "restore", "Alt"]);
    assert_eq!(ws.json(&["pages", "list"]).as_array().unwrap().len(), 2);
    assert_eq!(ws.fails(&["pages", "purge", "Alt"], 2)["code"], json!("not_found"));
    ws.json(&["pages", "delete", "Alt"]);
    assert_eq!(ws.json(&["pages", "purge", "Alt"]), json!({ "purged": 2 }));
    assert!(ws.db().page(id(&parent)).is_err() && ws.db().page(id(&child)).is_err(), "deleted for good");
    // --now deletes a page outside the trash for good at once.
    let p = ws.json(&["pages", "create", "Sofort weg"]);
    assert_eq!(ws.json(&["pages", "purge", "Sofort weg", "--now"]), json!({ "purged": 1 }));
    assert!(ws.db().page(id(&p)).is_err());
    ws.json(&["pages", "create", "Noch eins"]);
    ws.json(&["pages", "delete", "Noch eins"]);
    assert_eq!(ws.json(&["trash", "empty"]), json!({ "purged": 1 }));
    assert_eq!(ws.json(&["trash", "list"]), json!([]));
}

#[test]
fn renaming_updates_links_as_the_app_does() {
    let ws = Ws::new("rename");
    let target = ws.json(&["pages", "create", "Kunde Müller"]);
    let a =
        ws.json(&["pages", "create", "Notiz A", "--body", "Siehe [[Kunde Müller]] und [[kunde müller|den Kunden]].\n"]);
    let b = ws.json(&["pages", "create", "Notiz B", "--body", "`[[Kunde Müller]]` im Code bleibt.\n"]);
    let r = ws.json(&["pages", "rename", "Kunde Müller", "Kunde Müller GmbH"]);
    assert_eq!(r["links_updated"], json!(1));
    assert_eq!(r["page"]["title"], json!("Kunde Müller GmbH"));
    assert_eq!(ws.content(id(&a)), "Siehe [[Kunde Müller GmbH]] und [[Kunde Müller GmbH|den Kunden]].\n");
    assert_eq!(ws.content(id(&b)), "`[[Kunde Müller]]` im Code bleibt.\n");
    // The rewritten page kept its text as a version; the links list follows.
    assert_eq!(ws.db().list_versions(id(&a)).unwrap().len(), 1);
    let links = ws.json(&["pages", "links", "Notiz A"]);
    assert_eq!(links[0]["kind"], json!("page"));
    assert_eq!(links[0]["page"]["id"], target["id"]);
    let back = ws.json(&["pages", "backlinks", "Kunde Müller GmbH"]);
    assert_eq!(back.as_array().unwrap().len(), 1);
    assert_eq!(back[0]["id"], a["id"]);
    // --keep-links leaves them.
    ws.json(&["pages", "rename", "Kunde Müller GmbH", "Müller", "--keep-links"]);
    assert!(ws.content(id(&a)).contains("[[Kunde Müller GmbH]]"));
    assert_eq!(ws.json(&["pages", "links", "Notiz A"])[0]["kind"], json!("missing"));
}

#[test]
fn tasks_are_added_listed_and_changed_in_their_notes() {
    let ws = Ws::new("tasks");
    ws.json(&["pages", "create", "Projekt", "--body", "# Projekt\n\n- [ ] Alt #kunde due:2020-01-01\n"]);
    let t =
        ws.json(&["tasks", "add", "Angebot schicken", "--page", "Projekt", "--due", "2030-05-01", "--priority", "2"]);
    assert_eq!(
        t,
        json!({
            "page_id": t["page_id"], "page_title": "Projekt", "page_path": "Projekt", "ordinal": 1, "line": 3,
            "text": "Angebot schicken", "done": false, "due": "2030-05-01", "priority": 2, "tags": [], "recur": null,
        })
    );
    let pid = t["page_id"].as_i64().unwrap();
    assert_eq!(
        ws.content(pid),
        "# Projekt\n\n- [ ] Alt #kunde due:2020-01-01\n- [ ] Angebot schicken due:2030-05-01 !!\n"
    );
    // Into today's daily note, below its notes section, as quick capture does.
    let d = ws.json(&["tasks", "add", "Anrufen", "--due", "today"]);
    let daily = ws.db().page_doc(d["page_id"].as_i64().unwrap()).unwrap();
    assert!(daily.page.daily_date.is_some());
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    assert!(daily.content.trim_end().ends_with(&format!("- [ ] Anrufen due:{today}")), "{:?}", daily.content);

    let texts = |args: &[&str]| -> Vec<String> {
        let mut all = vec!["tasks", "list"];
        all.extend_from_slice(args);
        ws.json(&all).as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap().to_owned()).collect()
    };
    assert_eq!(texts(&[]), ["Alt #kunde", "Anrufen", "Angebot schicken"]);
    assert_eq!(texts(&["--overdue"]), ["Alt #kunde"]);
    assert_eq!(texts(&["--due", "today"]), ["Anrufen"]);
    assert_eq!(texts(&["--tag", "kunde"]), ["Alt #kunde"]);
    assert_eq!(texts(&["--page", "Projekt", "--limit", "1"]), ["Alt #kunde"]);

    let done = ws.json(&["tasks", "done", "Projekt", "0"]);
    assert_eq!(done["done"], json!(true));
    assert_eq!(texts(&["--status", "done"]), ["Alt #kunde"]);
    ws.json(&["tasks", "undone", "Projekt", "0"]);
    // Text, due date and priority in one go; markers not given stay.
    let e = ws.json(&["tasks", "edit", "Projekt", "1", "--text", "Angebot nachfassen", "--due", "none"]);
    assert_eq!(
        (e["text"].clone(), e["due"].clone(), e["priority"].clone()),
        (json!("Angebot nachfassen"), json!(null), json!(2))
    );
    let e = ws.json(&["tasks", "edit", "Projekt", "1", "--repeat", "weekly"]);
    assert_eq!(e["recur"], json!("every:weekly"));
    // A task that changed meanwhile is refused.
    assert_eq!(
        ws.fails(&["tasks", "done", "Projekt", "1", "--expect", "Angebot schicken"], 3)["code"],
        json!("conflict")
    );
    assert_eq!(ws.fails(&["tasks", "edit", "Projekt", "1", "--move-to", "Später"], 2)["code"], json!("not_found"));
    let later = ws.json(&["pages", "create", "Später", "--body", "- [ ] Irgendwann\n"]);
    let moved = ws.json(&["tasks", "edit", "Projekt", "0", "--move-to", "Später"]);
    assert_eq!(
        (moved["page_id"].clone(), moved["text"].clone(), moved["ordinal"].clone()),
        (later["id"].clone(), json!("Alt #kunde"), json!(1))
    );
    assert_eq!(ws.json(&["tasks", "delete", "Später", "0"]), json!({ "deleted": 1 }));
    assert_eq!(ws.content(id(&later)), "- [ ] Alt #kunde due:2020-01-01\n");
    assert_eq!(ws.content(pid), "# Projekt\n\n- [ ] Angebot nachfassen !! every:weekly\n");
}

#[test]
fn daily_notes_take_text_below_their_notes_section() {
    let ws = Ws::new("daily");
    let a = ws.json(&["daily", "create", "--date", "2026-03-02"]);
    assert_eq!(a["daily_date"], json!("2026-03-02"));
    assert_eq!(ws.json(&["daily", "create", "--date", "2026-03-02"])["id"], a["id"], "the same note again");
    ws.json(&["daily", "append", "--date", "2026-03-02", "Notiz eins"]);
    ws.run_stdin(&["daily", "append", "--date", "2026-03-02", "--stdin"], "- Punkt\n");
    let content = ws.content(id(&a));
    assert!(
        content.ends_with("## Notes\n\nNotiz eins\n\n- Punkt\n")
            || content.ends_with("## Notizen\n\nNotiz eins\n\n- Punkt\n"),
        "{content:?}"
    );
    assert_eq!(ws.text(&["daily", "show", "--date", "2026-03-02"]), content);
}

#[test]
fn settings_are_checked_like_a_save_in_the_app() {
    let ws = Ws::new("settings");
    assert_eq!(ws.json(&["settings", "get", "editor.autosave_ms"]), json!(450));
    // Clamped to the range the app allows.
    assert_eq!(
        ws.json(&["settings", "set", "editor.autosave_ms", "99999"]),
        json!({ "key": "editor.autosave_ms", "value": 3000 })
    );
    assert_eq!(ws.db().load_settings().unwrap().editor.autosave_ms, 3000);
    assert_eq!(ws.fails(&["settings", "set", "editor.autosave_ms", "\"schnell\""], 1)["code"], json!("usage"));
    assert_eq!(ws.fails(&["settings", "get", "editor.gibts_nicht"], 2)["code"], json!("not_found"));
    assert_eq!(ws.fails(&["settings", "set", "reminder_time", "25:99"], 3)["code"], json!("conflict"));
    ws.json(&["settings", "set", "reminder_time", "7:05"]);
    assert_eq!(ws.json(&["settings", "get", "reminder_time"]), json!("07:05"));
}

#[test]
fn time_entries_the_week_absences_and_the_wbs() {
    let ws = Ws::new("time");
    for args in [
        &["project", "add", "PRJ-1", "Rollout"][..],
        &["project", "add-netzplan", "PRJ-1", "NP-1", "NP-1-WBS", "--hours", "40"],
        &["project", "add-vorgang", "NP-1", "1010", "--hours", "16"],
        &["project", "add-vorgang", "NP-1", "1020", "--hours", "8", "--after", "1010"],
    ] {
        ws.json(args);
    }
    let p = ws.json(&["project", "list"]);
    assert_eq!(p[0]["netzplaene"][0]["vorgaenge"][1]["predecessors"], json!(["1010"]));
    let booked = ws.json(&["zeit", "NP-1/1010", "1.5h", "#DEV", "Workshop"]);
    let e = &booked["entry"];
    assert_eq!(
        (e["reference"].clone(), e["minutes"].clone(), e["activity_type"].clone()),
        (json!("NP-1/1010"), json!(90), json!("DEV"))
    );
    let eid = e["id"].as_i64().unwrap().to_string();
    assert!(e["start"].as_str().unwrap().ends_with("+02:00") || e["start"].as_str().unwrap().ends_with("+01:00"));
    // The text output of 1.17 and earlier (here in English).
    let line = ws.text(&["zeit", "NP-1/1020", "2h", "Code"]);
    assert!(line.starts_with("#2 booked: 2.00h on NP-1/1020 – Code"), "{line}");
    let edited =
        ws.json(&["time", "edit", &eid, "--duration", "1:45", "--description", "Workshop lang", "--vorgang", "1020"]);
    assert_eq!((edited["minutes"].clone(), edited["reference"].clone()), (json!(105), json!("NP-1/1020")));
    assert_eq!(ws.json(&["time", "list"]).as_array().unwrap().len(), 2);
    let week = ws.json(&["time", "week"]);
    assert_eq!(week["booked_minutes"], json!(225));
    assert_eq!(week["days"].as_array().unwrap().len(), 7);
    ws.json(&["time", "delete", &eid]);
    assert_eq!(ws.json(&["time", "list"]).as_array().unwrap().len(), 1);
    assert_eq!(ws.fails(&["time", "delete", "999"], 2)["code"], json!("not_found"));

    // Absences: a range gets the working days.
    let added = ws.json(&["absences", "add", "2026-12-21", "2026-12-27", "--kind", "vacation"]);
    assert_eq!(added["days"].as_array().unwrap().len(), 5);
    let list = ws.json(&["absences", "list", "--from", "2026-12-01", "--to", "2026-12-31"]);
    assert_eq!(list["absences"][0], json!({ "date": "2026-12-21", "kind": "vacation", "half": false, "note": "" }));
    assert_eq!(ws.json(&["absences", "delete", "2026-12-21", "2026-12-22"]), json!({ "removed": 2 }));
    assert_eq!(ws.fails(&["absences", "add", "2026-12-21", "--kind", "party"], 1)["code"], json!("usage"));

    // The WBS: change and delete.
    ws.json(&["project", "edit-vorgang", "NP-1/1010", "--description", "Analyse", "--remaining", "4"]);
    let v = &ws.json(&["project", "list"])[0]["netzplaene"][0]["vorgaenge"][0];
    assert_eq!((v["description"].clone(), v["remaining_hours"].clone()), (json!("Analyse"), json!(4.0)));
    ws.json(&["project", "edit-netzplan", "NP-1", "--hours", "60"]);
    ws.json(&["project", "edit", "PRJ-1", "--name", "Rollout 2"]);
    assert_eq!(ws.fails(&["project", "delete", "PRJ-1"], 3)["code"], json!("conflict"), "booked time keeps it");
    ws.json(&["project", "delete-vorgang", "NP-1/1010"]);
    let p = ws.json(&["project", "list"]);
    assert_eq!(
        (p[0]["name"].clone(), p[0]["netzplaene"][0]["planned_hours"].clone()),
        (json!("Rollout 2"), json!(60.0))
    );
    assert_eq!(p[0]["netzplaene"][0]["vorgaenge"].as_array().unwrap().len(), 1);
}

#[test]
fn tags_search_calendar_and_attachments() {
    let ws = Ws::new("misc");
    ws.json(&["pages", "create", "Ideen", "--body", "Eine #idee zur Zeiterfassung\n"]);
    assert_eq!(ws.json(&["tags", "list"]), json!([{ "tag": "idee", "pages": 1 }]));
    assert_eq!(ws.json(&["tags", "pages", "#idee"])[0]["title"], json!("Ideen"));
    let hits = ws.json(&["search", "Zeiterfassung"]);
    assert_eq!(hits[0]["kind"], json!("note"));
    assert_eq!(hits[0]["page"]["title"], json!("Ideen"));
    assert!(!hits[0]["snippet"].as_str().unwrap().contains('\u{2}'));

    // The calendar: what the sync stored, for the active sources.
    {
        let db = ws.db();
        let mut s = db.load_settings().unwrap();
        s.calendar.sources.push(arcalo_core::calsync::IcsSource {
            id: "team".into(),
            name: "Team".into(),
            ..Default::default()
        });
        db.save_settings(&s).unwrap();
        let start = chrono::Local::now()
            .date_naive()
            .and_hms_opt(10, 0, 0)
            .unwrap()
            .and_local_timezone(chrono::Local)
            .unwrap()
            .to_utc();
        let ev = arcalo_core::calsync::NewEvent {
            uid: "u1".into(),
            instance: String::new(),
            recurring: false,
            start,
            end: start + chrono::Duration::minutes(30),
            all_day: false,
            title: "Jour fixe".into(),
            location: "Raum 1".into(),
            organizer: String::new(),
            attendees: vec![],
            body: None,
            link: None,
            busy: Default::default(),
            private: false,
            categories: vec![],
        };
        db.calendar_replace("ics:team", start - chrono::Duration::days(1), start + chrono::Duration::days(1), &[ev])
            .unwrap();
    }
    let today = ws.json(&["calendar", "today"]);
    assert_eq!(today.as_array().unwrap().len(), 1);
    assert_eq!((today[0]["title"].clone(), today[0]["key"].clone()), (json!("Jour fixe"), json!("ics:team|u1|")));
    // Shown in the local time of the command (Europe/Berlin), with the offset in JSON.
    let (from, to) = (today[0]["start"].as_str().unwrap(), today[0]["end"].as_str().unwrap());
    assert!(from.ends_with("+02:00") || from.ends_with("+01:00"), "{from}");
    let text = ws.text(&["calendar", "today"]);
    assert!(text.contains(&format!("{}–{}  Jour fixe  (Raum 1)", &from[11..16], &to[11..16])), "{text}");
    assert_eq!(ws.json(&["calendar", "events", "--from", "2001-01-01", "--to", "2001-01-31"]), json!([]));

    // Attachments: added (and embedded), listed with their pages, copied out.
    let file = ws.dir.join("Bericht Q3.txt");
    std::fs::write(&file, "Inhalt").unwrap();
    let a = ws.json(&["attachments", "add", file.to_str().unwrap(), "--page", "Ideen"]);
    assert_eq!((a["name"].clone(), a["markdown"].clone()), (json!("Bericht Q3.txt"), json!("![[Bericht Q3.txt]]")));
    assert!(ws.text(&["pages", "show", "Ideen"]).ends_with("![[Bericht Q3.txt]]\n"));
    let list = ws.json(&["attachments", "list"]);
    assert_eq!(
        stable(list[0].clone()),
        json!({ "name": "Bericht Q3.txt", "kind": "other", "size": 6, "modified": "<time>", "used_in": [{ "id": 1, "title": "Ideen", "trashed": false }] })
    );
    let out = ws.dir.join("kopie.txt");
    ws.json(&["attachments", "export", "Bericht Q3.txt", out.to_str().unwrap()]);
    assert_eq!(std::fs::read_to_string(out).unwrap(), "Inhalt");
    assert_eq!(
        ws.fails(&["attachments", "export", "../workspace.db", ws.dir.to_str().unwrap()], 2)["code"],
        json!("not_found")
    );

    let info = ws.json(&["info"]);
    assert_eq!(
        (info["encrypted"].clone(), info["counts"]["pages"].clone(), info["counts"]["attachments"].clone()),
        (json!(false), json!(1), json!(1))
    );
}

/// Encrypts the workspace in `dir` with `key`, as „Datenbank verschlüsseln“ does at the start.
fn encrypt(dir: &Path, key: &DbKey) {
    let plain = dir.join("workspace.db");
    let enc = dir.join("workspace.enc");
    {
        let db = Database::open(&plain).unwrap();
        db.checkpoint().unwrap();
    }
    cipher::export(&plain, None, &enc, Some(key)).unwrap();
    for ext in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(format!("{}{ext}", plain.display()));
    }
    std::fs::rename(&enc, &plain).unwrap();
}

#[test]
fn an_encrypted_workspace_opens_with_the_key_of_the_credential_store() {
    let ws = Ws::new("cipher");
    ws.db().create_page(None, "Geheim", None).unwrap();
    let key = DbKey::generate().unwrap();
    encrypt(&ws.dir, &key);
    assert_eq!(cipher::file_state(&ws.dir.join("workspace.db")), cipher::FileState::Encrypted);

    // Without the key: a clear message, nothing changed.
    let e = ws.fails(&["pages", "list"], 4);
    assert!(e["message"].as_str().unwrap().contains("key is missing on this computer"), "{e}");
    assert!(e["message"].as_str().unwrap().contains("ARCALO_RECOVERY_KEY"), "{e}");
    // A wrong key says so.
    std::fs::write(
        ws.dir.join("secrets.json"),
        json!({ "db_key": DbKey::generate().unwrap().to_hex().as_str() }).to_string(),
    )
    .unwrap();
    assert!(ws.fails(&["pages", "list"], 4)["message"].as_str().unwrap().contains("does not fit"));

    // The app's key (here in its file store, as on Linux without a Secret Service).
    std::fs::write(ws.dir.join("secrets.json"), json!({ "db_key": key.to_hex().as_str() }).to_string()).unwrap();
    assert_eq!(ws.json(&["pages", "list"])[0]["title"], json!("Geheim"));
    ws.json(&["pages", "append", "Geheim", "verschlüsselt geschrieben"]);
    assert_eq!(ws.json(&["info"])["encrypted"], json!(true));
    assert_eq!(cipher::file_state(&ws.dir.join("workspace.db")), cipher::FileState::Encrypted, "still encrypted");

    // The recovery key works without the store.
    std::fs::remove_file(ws.dir.join("secrets.json")).unwrap();
    let out = ws
        .cmd(&["--json", "pages", "show", "Geheim"])
        .env("ARCALO_RECOVERY_KEY", key.recovery_code())
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["content"], json!("verschlüsselt geschrieben\n"));
}

#[test]
fn a_write_waits_while_the_app_holds_a_transaction() {
    let ws = Ws::new("concurrent");
    let app = ws.db();
    let page = app.create_page(None, "Geteilt", None).unwrap();
    app.save_page_content(page.id, "Start\n").unwrap();
    // The app is in the middle of a save: it holds the write lock.
    app.conn().execute_batch("BEGIN IMMEDIATE").unwrap();
    app.conn().execute("UPDATE pages SET content = 'App\n' WHERE id = ?1", [page.id]).unwrap();
    let mut cli = ws
        .cmd(&["--json", "pages", "append", "Geteilt", "Von der Kommandozeile"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(800));
    assert!(cli.try_wait().unwrap().is_none(), "the command waits for the lock");
    app.conn().execute_batch("COMMIT").unwrap();
    let out = cli.wait_with_output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    // It read the page after the app's save: both texts are there.
    assert_eq!(ws.content(page.id), "App\n\nVon der Kommandozeile\n");
}

#[test]
fn an_explicit_database_file_keeps_working_as_before() {
    let ws = Ws::new("explicit");
    let file = ws.dir.join("sub").join("eigene.db");
    let out = ws.cmd(&["--db", file.to_str().unwrap(), "demo"]).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(file.is_file());
    let out = ws.cmd(&["project", "list"]).env("ARCALO_DB", &file).output().unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).starts_with("PRJ-2026-X"));
    // `ANNALO_DB` of 1.14 and earlier.
    let out = ws.cmd(&["--json", "info"]).env("ANNALO_DB", &file).output().unwrap();
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["database"], json!(file.display().to_string()));
}

#[test]
fn the_commands_of_1_17_print_json_too() {
    let ws = Ws::new("legacy");
    for args in [
        &["project", "add", "PRJ-1", "Rollout"][..],
        &["project", "add-netzplan", "PRJ-1", "NP-1", "NP-1-WBS", "--hours", "10"],
        &["project", "add-vorgang", "NP-1", "1010", "--days", "2", "--hours", "6"],
        &["project", "add-vorgang", "NP-1", "1020", "--days", "3", "--hours", "4", "--after", "1010"],
    ] {
        assert_eq!(ws.json(args)["ok"], json!(true));
    }
    assert_eq!(ws.json(&["timer", "status"]), json!({ "running": false, "entry": null, "minutes": null }));
    let started = ws.json(&["timer", "start", "NP-1/1010", "#DEV", "Analyse"]);
    assert_eq!(stable(started.clone())["status"], json!("running"));
    let status = ws.json(&["timer", "status"]);
    assert_eq!((status["running"].clone(), status["entry"]["id"].clone()), (json!(true), started["id"].clone()));
    assert_eq!(ws.fails(&["timer", "start", "NP-1/1010"], 3)["code"], json!("conflict"), "one timer at a time");
    let stopped = ws.json(&["timer", "stop"]);
    assert_eq!(stopped[0]["id"], started["id"]);
    ws.json(&["zeit", "NP-1/1010", "3h", "Workshop"]);

    let budget = ws.json(&["budget", "NP-1"]);
    assert_eq!(budget[0]["label"], json!("NP-1"));
    assert_eq!(budget[0]["planned_hours"], json!(10.0));
    let schedule = ws.json(&["schedule", "NP-1"]);
    assert_eq!(schedule["duration"], json!(5.0));
    assert_eq!(schedule["critical_path"].as_array().unwrap().len(), 2);
    assert!(ws.text(&["schedule", "NP-1"]).contains("critical path: 1010 → 1020"));

    let export = ws.json(&["export", "--format", "csv", "--mark"]);
    assert_eq!(export["exported_ids"].as_array().unwrap().len(), 2);
    assert_eq!(export["marked"], json!(2));
    assert!(export["content"].as_str().unwrap().contains("Workshop"));
    assert_eq!(
        ws.json(&["time", "list"]).as_array().unwrap().iter().filter(|e| e["status"] == json!("exported")).count(),
        2
    );

    // Vault out and in again.
    ws.json(&["pages", "create", "Notiz", "--body", "Text mit [[Link]]\n"]);
    let vault = ws.dir.join("vault");
    assert_eq!(ws.json(&["export-vault", vault.to_str().unwrap()])["files"], json!(1));
    let report = ws.json(&["import", vault.to_str().unwrap()]);
    assert_eq!(report["pages"], json!(1));
    let root = report["root_page_id"].as_i64().unwrap();
    assert_eq!(ws.json(&["pages", "list", "--parent", &format!("id:{root}")])[0]["title"], json!("Notiz"));
    ws.json(&["pages", "delete", &format!("id:{root}")]);
    assert_eq!(ws.json(&["pages", "list", "--trash"])[0]["id"], json!(root));
    let meta = ws.text(&["pages", "show", "Notiz", "--meta"]);
    assert!(meta.starts_with("# Notiz  (id:") && meta.ends_with("Text mit [[Link]]\n"), "{meta}");
}

/// A running command marks itself for an update of the app, locked by the operating system, and
/// the mark goes when it ends. Only its command words are in the mark, not its text.
#[cfg(target_os = "linux")]
#[test]
fn a_running_command_holds_its_mark_until_it_ends() {
    use std::io::Write;
    let ws = Ws::new("cmdlock");
    let dir = ws.dir.join("xdg/de.mousewerk.arcalo/commands");
    let mut child = ws
        .cmd(&["--json", "pages", "create", "Geheim", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mark = dir.join(format!("{} pages create.lock", child.id()));
    for _ in 0..200 {
        if mark.is_file() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    assert!(mark.is_file(), "no mark in {}", dir.display());
    let other = std::fs::OpenOptions::new().read(true).write(true).open(&mark).unwrap();
    assert!(matches!(other.try_lock(), Err(std::fs::TryLockError::WouldBlock)), "the mark is locked");
    drop(other);
    let running = arcalo_core::cmdlock::running(&dir);
    assert_eq!(running.len(), 1);
    assert_eq!(running[0].command, "pages create");
    child.stdin.take().unwrap().write_all(b"Text\n").unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(!mark.exists(), "the mark goes with the command");
    assert_eq!(arcalo_core::cmdlock::running(&dir), vec![]);
}
