use super::query::{Query, QueryResult, Source};
use super::*;
use crate::calsync::{Busy, NewEvent};
use crate::model::{EntrySource, NewTimeEntry};
use crate::properties::Filter;
use chrono::TimeZone;

/// Wednesday, 23 September 2026, noon (UTC is the local zone of these tests).
fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 23, 12, 0, 0).unwrap()
}

fn day(m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, m, d).unwrap()
}

fn at(m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, m, d, h, min, 0).unwrap()
}

const SOURCES: [&str; 2] = ["outlook", "ics:team"];

fn sources() -> Vec<String> {
    SOURCES.iter().map(|s| s.to_string()).collect()
}

struct World {
    db: Database,
    np: i64,
    other: i64,
    settings: Settings,
    sources: Vec<String>,
}

impl World {
    fn ctx(&self) -> Ctx<'_, Utc> {
        Ctx::new(&self.db, &Utc, now(), day(9, 23), &self.sources, &self.settings)
    }
    fn get(&self, p: Part) -> serde_json::Value {
        part(&self.ctx(), &p).unwrap()
    }
    fn query(&self, q: Query) -> QueryResult {
        query::run(&self.ctx(), &q).unwrap()
    }
    fn book(&self, np: i64, vorgang: Option<&str>, start: DateTime<Utc>, minutes: i64, text: &str) -> i64 {
        self.db
            .insert_time_entry(&NewTimeEntry {
                netzplan_id: np,
                vorgang_nr: vorgang.map(str::to_owned),
                leistungsart: None,
                start_time: start,
                duration_minutes: minutes,
                description: text.into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap()
            .id
    }
    fn page(&self, title: &str, parent: Option<i64>, content: &str) -> i64 {
        let p = self.db.create_page(parent, title, None).unwrap();
        self.db.save_page(p.id, content).unwrap();
        p.id
    }
}

fn event(uid: &str, start: DateTime<Utc>, minutes: i64, title: &str) -> NewEvent {
    NewEvent {
        uid: uid.into(),
        instance: String::new(),
        recurring: false,
        start,
        end: start + Duration::minutes(minutes),
        all_day: false,
        title: title.into(),
        location: String::new(),
        organizer: String::new(),
        attendees: vec![],
        body: None,
        link: None,
        busy: Busy::Busy,
        private: false,
        categories: vec![],
    }
}

fn world() -> World {
    let db = Database::open_in_memory().unwrap();
    let project = db.create_project("P-1", "Portal").unwrap();
    let np = db.create_netzplan(project.id, "NP-8801", "P-1.01", "Kundenportal", 100.0).unwrap();
    db.create_vorgang(np.id, "1010", "Konzept", 5.0, 40.0).unwrap();
    db.create_vorgang(np.id, "1020", "Umsetzung", 10.0, 60.0).unwrap();
    let other = db.create_netzplan(project.id, "NP-9900", "P-1.02", "Betrieb", 10.0).unwrap();
    World { db, np: np.id, other: other.id, settings: Settings::default(), sources: sources() }
}

#[test]
fn today_lists_meetings_bookings_and_due_tasks() {
    let w = world();
    // Tasks: overdue and due today on a page, one due later; the daily note's own open tasks.
    w.page("Aufgaben", None, "- [ ] Alt due:2026-09-20\n- [ ] Heute due:2026-09-23 !!\n- [ ] Morgen due:2026-09-24\n- [x] Fertig due:2026-09-22");
    let note = w.db.daily_note(day(9, 23)).unwrap();
    w.db.save_page(note.id, "# Heute\n\n- [ ] Notiz-Aufgabe\n- [ ] Heute due:2026-09-23").unwrap();
    w.book(w.np, Some("1010"), at(9, 23, 8, 0), 90, "Konzept");
    w.book(w.np, Some("1010"), at(9, 22, 8, 0), 60, "gestern");
    w.db.calendar_replace(
        "ics:team",
        at(9, 1, 0, 0),
        at(10, 31, 0, 0),
        &[
            event("standup", at(9, 23, 9, 0), 15, "Daily Standup"),
            event("review", at(9, 23, 14, 0), 60, "Sprint Review"),
            event("morgen", at(9, 24, 9, 0), 15, "Morgen"),
        ],
    )
    .unwrap();
    // An inactive source is not shown.
    w.db.calendar_replace("ics:alt", at(9, 1, 0, 0), at(10, 31, 0, 0), &[event("x", at(9, 23, 10, 0), 30, "Aus")])
        .unwrap();

    let v = w.get(Part::Today);
    assert_eq!(v["booked_minutes"], 90);
    assert_eq!((v["target_minutes"].as_i64(), v["workday"].as_bool()), (Some(480), Some(true)));
    assert_eq!(v["daily_note_id"], note.id);
    let events: Vec<&str> = v["events"].as_array().unwrap().iter().map(|e| e["title"].as_str().unwrap()).collect();
    assert_eq!(events, ["Daily Standup", "Sprint Review"]);
    let tasks: Vec<&str> = v["tasks"].as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap()).collect();
    // Due first (the note's copy of „Heute“ is its own task), then the note's other open tasks.
    assert_eq!(tasks, ["Alt", "Heute", "Heute", "Notiz-Aufgabe"]);
    assert_eq!(v["tasks_total"], 4);
    assert_eq!(v["calendar_configured"], true);

    // Without calendar sources: no meetings, and the UI can say why.
    let none: Vec<String> = vec![];
    let ctx = Ctx::new(&w.db, &Utc, now(), day(9, 23), &none, &w.settings);
    let v = part(&ctx, &Part::Today).unwrap();
    assert_eq!((v["events"].as_array().unwrap().len(), v["calendar_configured"].as_bool()), (0, Some(false)));
}

#[test]
fn agenda_covers_whole_local_days() {
    let w = world();
    w.db.calendar_replace(
        "outlook",
        at(9, 1, 0, 0),
        at(10, 31, 0, 0),
        &[
            event("early", at(9, 23, 0, 5), 15, "Früh"),
            event("fri", at(9, 25, 16, 0), 30, "Freitag"),
            event("next", at(9, 28, 9, 0), 30, "Nächste Woche"),
        ],
    )
    .unwrap();
    let titles = |days| {
        let v = w.get(Part::Agenda { days });
        v["events"].as_array().unwrap().iter().map(|e| e["title"].as_str().unwrap().to_owned()).collect::<Vec<_>>()
    };
    assert_eq!(titles(1), ["Früh"], "today from midnight, also what is over");
    assert_eq!(titles(3), ["Früh", "Freitag"]);
    assert_eq!(titles(999).len(), 3, "capped, not refused");
}

#[test]
fn task_filters() {
    let w = world();
    let a = w.page(
        "Projekt A",
        None,
        "- [ ] Angebot #kunde due:2026-09-21 !\n- [ ] Konzept !!\n- [ ] Später due:2026-12-01\n- [x] Erledigt",
    );
    w.page("Projekt B", None, "- [ ] Rechnung #kunde due:2026-09-28");
    let texts = |q: TaskQuery| tasks(&w.db, &q, day(9, 23)).unwrap().into_iter().map(|t| t.text).collect::<Vec<_>>();
    assert_eq!(texts(TaskQuery::default()), ["Angebot #kunde", "Rechnung #kunde", "Später", "Konzept"]);
    assert_eq!(texts(TaskQuery { due: "overdue".into(), ..Default::default() }), ["Angebot #kunde"]);
    assert_eq!(texts(TaskQuery { due: "week".into(), ..Default::default() }), ["Angebot #kunde", "Rechnung #kunde"]);
    assert_eq!(texts(TaskQuery { due: "none".into(), ..Default::default() }), ["Konzept"]);
    assert_eq!(texts(TaskQuery { priority: 1, ..Default::default() }), ["Angebot #kunde", "Konzept"]);
    assert_eq!(
        texts(TaskQuery { tag: Some("#Kunde".into()), ..Default::default() }),
        ["Angebot #kunde", "Rechnung #kunde"]
    );
    assert_eq!(texts(TaskQuery { page_id: Some(a), text: "konz".into(), ..Default::default() }), ["Konzept"]);
    assert_eq!(texts(TaskQuery { status: TaskStatus::Done, ..Default::default() }), ["Erledigt"]);
    let v = w.get(Part::Tasks { filter: TaskQuery::default(), limit: Some(2) });
    assert_eq!((v["tasks"].as_array().unwrap().len(), v["total"].as_i64()), (2, Some(4)));
}

#[test]
fn week_per_day_and_per_wbs() {
    let w = world();
    w.book(w.np, Some("1010"), at(9, 21, 8, 0), 120, "a");
    w.book(w.np, Some("1020"), at(9, 21, 13, 0), 60, "b");
    w.book(w.np, Some("1010"), at(9, 22, 8, 0), 240, "c");
    w.book(w.other, None, at(9, 23, 8, 0), 30, "d");
    // The previous Sunday and the next Monday are outside.
    w.book(w.np, None, at(9, 20, 8, 0), 30, "e");
    w.book(w.np, None, at(9, 28, 8, 0), 30, "f");
    let v = w.get(Part::Week { week_start: day(9, 21) });
    let days: Vec<i64> = v["days"].as_array().unwrap().iter().map(|d| d["minutes"].as_i64().unwrap()).collect();
    assert_eq!(days, [180, 240, 30, 0, 0, 0, 0]);
    let workdays: Vec<bool> = v["days"].as_array().unwrap().iter().map(|d| d["workday"].as_bool().unwrap()).collect();
    assert_eq!(workdays, [true, true, true, true, true, false, false]);
    let wbs: Vec<(String, i64, String)> = v["wbs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            (
                x["label"].as_str().unwrap().to_owned(),
                x["minutes"].as_i64().unwrap(),
                x["title"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        wbs,
        [
            ("NP-8801/1010".to_owned(), 360, "Konzept".to_owned()),
            ("NP-8801/1020".to_owned(), 60, "Umsetzung".to_owned()),
            ("NP-9900".to_owned(), 30, "Betrieb".to_owned())
        ]
    );
    assert_eq!(v["wbs"][0]["by_day"], serde_json::json!([120, 240, 0, 0, 0, 0, 0]));
    assert_eq!(v["target_minutes"], 480);
}

#[test]
fn budgets_carry_the_hours_of_the_last_four_weeks() {
    let w = world();
    // 20 h on 1010 within the last 28 days, 10 h before that.
    w.book(w.np, Some("1010"), at(9, 1, 8, 0), 600, "neu");
    w.book(w.np, Some("1010"), at(9, 22, 8, 0), 600, "neu");
    w.book(w.np, Some("1010"), at(8, 1, 8, 0), 600, "alt");
    let v = w.get(Part::Budgets);
    assert_eq!(v["burn_days"], BURN_DAYS);
    let row = |label: &str| v["budgets"].as_array().unwrap().iter().find(|b| b["label"] == label).unwrap().clone();
    let np = row("NP-8801");
    assert_eq!((np["booked_hours"].as_f64(), np["recent_hours"].as_f64()), (Some(30.0), Some(20.0)));
    assert_eq!(np["title"], "Kundenportal");
    let v1010 = row("NP-8801/1010");
    assert_eq!((v1010["recent_hours"].as_f64(), v1010["title"].as_str()), (Some(20.0), Some("Konzept")));
    assert_eq!(v1010["level"], "warning", "30 of 40 h");
    assert_eq!(row("NP-8801/1020")["recent_hours"].as_f64(), Some(0.0));
    // The rows are the ones of budgets_all.
    let all = tracking::all_budgets(&w.db, &w.settings.thresholds).unwrap();
    assert_eq!(v["budgets"].as_array().unwrap().len(), all.len());
}

#[test]
fn project_collects_notes_tasks_and_meetings() {
    let w = world();
    let linked = w.page(
        "Konzept Portal",
        None,
        "---\nvorgang: NP-8801/1010\n---\n# Konzept\n\n- [ ] Entwurf abstimmen\n- [x] Skizze",
    );
    let np_page = w.page("Portal", None, "---\nnetzplan: np-8801\n---\n- [ ] Kickoff planen");
    // Mentions the number only in the text, or another Netzplan: not linked.
    w.page("Nur erwähnt", None, "NP-8801 kommt vor\n- [ ] Nicht dabei");
    w.page("Betrieb", None, "---\nnetzplan: NP-9900\n---\n- [ ] Anderes");
    // Meetings: the number in the subject; a series booked on it before; others.
    let mut series = event("jf", at(9, 21, 10, 0), 60, "Jour fixe");
    series.recurring = true;
    series.instance = "1".into();
    let mut next = event("jf", at(9, 28, 10, 0), 60, "Jour fixe");
    next.recurring = true;
    next.instance = "2".into();
    w.db.calendar_replace(
        "outlook",
        at(9, 1, 0, 0),
        at(10, 31, 0, 0),
        &[
            series,
            next,
            event("np", at(9, 24, 9, 0), 30, "Abstimmung NP-8801"),
            event("x", at(9, 24, 11, 0), 30, "Mittag"),
        ],
    )
    .unwrap();
    let entry = w.book(w.np, Some("1020"), at(9, 21, 10, 0), 60, "Jour fixe");
    w.db.calendar_link_entry("outlook|jf|1", entry).unwrap();
    let v = w.get(Part::Project { netzplan_id: Some(w.np) });
    assert_eq!(
        (v["netzplan_nr"].as_str(), v["project_code"].as_str(), v["project_name"].as_str()),
        (Some("NP-8801"), Some("P-1"), Some("Portal"))
    );
    let mut pages: Vec<i64> = v["pages"].as_array().unwrap().iter().map(|p| p["id"].as_i64().unwrap()).collect();
    pages.sort();
    assert_eq!(pages, [linked, np_page]);
    let mut tasks: Vec<&str> = v["tasks"].as_array().unwrap().iter().map(|t| t["text"].as_str().unwrap()).collect();
    tasks.sort();
    assert_eq!(tasks, ["Entwurf abstimmen", "Kickoff planen"]);
    let events: Vec<&str> = v["events"].as_array().unwrap().iter().map(|e| e["title"].as_str().unwrap()).collect();
    // The series instance of Monday is over; the next one and the numbered meeting come.
    assert_eq!(events, ["Abstimmung NP-8801", "Jour fixe"]);
    assert_eq!(v["budget"].as_array().unwrap().len(), 3, "the Netzplan and its two Vorgänge");
    // Without a choice: the Netzplan booked last.
    w.book(w.other, None, at(9, 22, 8, 0), 30, "Betrieb");
    assert_eq!(w.get(Part::Project { netzplan_id: None })["netzplan_nr"], "NP-9900");
    let empty = Database::open_in_memory().unwrap();
    let ctx = Ctx::new(&empty, &Utc, now(), day(9, 23), &w.sources, &w.settings);
    assert!(part(&ctx, &Part::Project { netzplan_id: None }).unwrap().is_null());
}

#[test]
fn proposal_counts_open_days_and_unbooked_meetings() {
    let w = world();
    // Monday booked in full, Tuesday half; Wednesday is today (not counted).
    w.book(w.np, None, at(9, 21, 8, 0), 480, "voll");
    w.book(w.np, None, at(9, 22, 8, 0), 240, "halb");
    let mut free = event("frei", at(9, 22, 12, 0), 60, "Mittag");
    free.busy = Busy::Free;
    w.db.calendar_replace(
        "outlook",
        at(9, 1, 0, 0),
        at(10, 31, 0, 0),
        &[
            event("a", at(9, 22, 9, 0), 60, "Offen"),
            event("b", at(9, 22, 10, 0), 30, "Gebucht"),
            event("c", at(9, 22, 11, 0), 30, "Nicht buchen"),
            free,
            event("d", at(9, 24, 9, 0), 30, "Kommt noch"),
        ],
    )
    .unwrap();
    let e = w.book(w.np, None, at(9, 22, 10, 0), 30, "Gebucht");
    w.db.calendar_link_entry("outlook|b|", e).unwrap();
    w.db.calendar_set_skip("outlook|c|", true).unwrap();
    let v = w.get(Part::Proposal { week_start: day(9, 21) });
    let open: Vec<(String, i64)> = v["open_days"]
        .as_array()
        .unwrap()
        .iter()
        .map(|d| (d["date"].as_str().unwrap().to_owned(), d["missing_minutes"].as_i64().unwrap()))
        .collect();
    assert_eq!(open, [("2026-09-22".to_owned(), 210)]);
    assert_eq!((v["unbooked_meetings"].as_i64(), v["unbooked_minutes"].as_i64()), (Some(1), Some(60)));
    assert_eq!((v["booked_minutes"].as_i64(), v["target_minutes"].as_i64()), (Some(750), Some(2400)));
}

#[test]
fn timer_refs_are_distinct_and_newest_first() {
    let w = world();
    w.book(w.np, Some("1010"), at(9, 20, 8, 0), 30, "a");
    w.book(w.np, Some("1020"), at(9, 21, 8, 0), 30, "b");
    w.book(w.np, Some("1010"), at(9, 22, 8, 0), 30, "c");
    w.book(w.other, None, at(9, 22, 9, 0), 30, "d");
    let v = w.get(Part::TimerRefs);
    let got: Vec<&str> = v.as_array().unwrap().iter().map(|r| r["description"].as_str().unwrap()).collect();
    assert_eq!(got, ["d", "c", "b"]);
}

#[test]
fn one_call_answers_every_part_and_isolates_errors() {
    let w = world();
    let p = w.page("Eingebettet", None, "# Hallo\n\nText");
    let keyed = |key: &str, part: Part| Keyed { key: key.into(), part };
    let parts = vec![
        keyed("a", Part::Page { id: p }),
        keyed("b", Part::Page { id: 999_999 }),
        keyed("a", Part::Recent { limit: 3 }),
        keyed("c", Part::Recent { limit: 3 }),
        keyed("d", Part::Focus { week_start: day(9, 21) }),
        keyed("e", Part::Suggestions),
        keyed("f", Part::Feed { limit: 5 }),
        keyed("g", Part::Month { from: day(9, 1), to: day(9, 30) }),
    ];
    let out = dashboard_data(&w.ctx(), &parts).unwrap();
    assert_eq!(out.len(), 7, "a repeated key is answered once");
    assert_eq!(out["a"]["content"], "# Hallo\n\nText");
    assert!(out["b"]["error"].as_str().unwrap().contains("999999"), "{}", out["b"]);
    assert_eq!(out["c"][0]["id"], p);
    assert_eq!(out["d"]["today"]["sessions"], 0);
    assert_eq!(out["e"]["week_minutes"].as_array().unwrap().len(), 7);
    assert_eq!(out["g"].as_array().unwrap().len(), 30);
    // A request asking for more than MAX_PARTS parts is refused as a whole.
    let many: Vec<Keyed> = (0..=MAX_PARTS).map(|i| keyed(&i.to_string(), Part::TimerRefs)).collect();
    assert!(dashboard_data(&w.ctx(), &many).is_err());
    // The request shape the UI sends.
    let req: Request = serde_json::from_value(serde_json::json!({
        "today": "2026-09-23",
        "parts": [
            {"key": "t", "part": {"kind": "tasks", "filter": {"due": "today", "priority": 1}}},
            {"key": "q", "part": {"kind": "query", "query": {"source": "tasks", "filters": [{"field": "prio", "op": "ist", "value": "hoch"}]}}},
            {"key": "w", "part": {"kind": "week", "week_start": "2026-09-21"}}
        ]
    }))
    .unwrap();
    assert_eq!(req.parts.len(), 3);
    assert!(matches!(&req.parts[0].part, Part::Tasks { filter, .. } if filter.due == "today" && filter.priority == 1));
}

// ------------------------------------------------------------------------ query

fn f(field: &str, op: &str, value: &str) -> Filter {
    Filter { field: field.into(), op: op.into(), value: value.into() }
}

#[test]
fn query_pages_by_property_tag_and_text() {
    let w = world();
    let parent = w.page(
        "Aufgabenliste",
        None,
        "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, Fertig: grün}}\n  aufwand: zahl\n  themen: {typ: mehrfachauswahl, optionen: [UI, API]}\n---\n# Liste",
    );
    let a = w.page("Login", Some(parent), "---\nstatus: Offen\naufwand: 3\nthemen: [UI, API]\n---\nText #portal");
    let b = w.page("Suche", Some(parent), "---\nstatus: Fertig\naufwand: 8\nthemen: [API]\n---\nMehr #portal");
    let c = w.page("Export", Some(parent), "---\nstatus: offen\naufwand: 1,5\n---\nOhne Tag");
    // No frontmatter at all.
    let loose = w.page("Lose", None, "#portal nur so");
    let ids = |r: &QueryResult| {
        let mut v: Vec<i64> = r.rows.iter().map(|x| x.page_id.unwrap()).collect();
        v.sort();
        v
    };
    let r = w.query(Query { filters: vec![f("status", "ist", "offen")], ..Default::default() });
    assert_eq!(ids(&r), [a, c]);
    let r = w.query(Query { filters: vec![f("aufwand", ">", "2")], ..Default::default() });
    assert_eq!(ids(&r), [a, b]);
    let r = w.query(Query { filters: vec![f("themen", "ist", "UI")], ..Default::default() });
    assert_eq!(ids(&r), [a]);
    let r = w.query(Query { tag: Some("#portal".into()), ..Default::default() });
    assert_eq!(ids(&r), [a, b, loose]);
    let r = w.query(Query {
        tag: Some("portal".into()),
        filters: vec![f("status", "ist nicht", "Fertig")],
        ..Default::default()
    });
    assert_eq!(ids(&r), [a, loose], "as in the table view, a missing value is not „Fertig“");
    let r = w.query(Query { text: "mehr portal".into(), ..Default::default() });
    assert_eq!(ids(&r), [b]);
    let r = w.query(Query {
        parent_id: Some(parent),
        filters: vec![f("titel", "enthält", "o")],
        sort: "title".into(),
        ..Default::default()
    });
    assert_eq!(r.rows.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["Export", "Login"]);
    // Columns and groups (multi-select values count once each; empty values as „(leer)“).
    let r = w.query(Query {
        parent_id: Some(parent),
        columns: vec!["status".into(), "aufwand".into()],
        group: "themen".into(),
        ..Default::default()
    });
    let login = r.rows.iter().find(|x| x.title == "Login").unwrap();
    assert_eq!(login.cells.get("status").map(String::as_str), Some("Offen"));
    assert_eq!(login.cells.get("aufwand").map(String::as_str), Some("3"));
    let groups: Vec<(&str, f64)> = r.groups.iter().map(|g| (g.label.as_str(), g.value)).collect();
    assert_eq!(groups, [("API", 2.0), ("(leer)", 1.0), ("UI", 1.0)]);
    let r = w.query(Query { tag: Some("portal".into()), group: "tag".into(), ..Default::default() });
    assert_eq!(r.groups.iter().map(|g| (g.label.as_str(), g.value)).collect::<Vec<_>>(), [("#portal", 3.0)]);
    // Limit keeps the total.
    let r = w.query(Query { parent_id: Some(parent), limit: 1, ..Default::default() });
    assert_eq!((r.rows.len(), r.total), (1, 3));
}

#[test]
fn query_tasks_by_due_priority_and_page() {
    let w = world();
    w.page("A", None, "- [ ] Alt due:2026-09-20 !!\n- [ ] Heute due:2026-09-23\n- [ ] Bald due:2026-09-26 !\n- [ ] Offen #x\n- [x] Fertig due:2026-09-20");
    w.page("B", None, "- [ ] Später due:2026-11-01 !!");
    let texts =
        |q: Query| w.query(Query { source: Source::Tasks, ..q }).rows.into_iter().map(|r| r.title).collect::<Vec<_>>();
    assert_eq!(texts(Query { filters: vec![f("fällig", "ist", "überfällig")], ..Default::default() }), ["Alt"]);
    assert_eq!(texts(Query { filters: vec![f("fällig", "ist", "woche")], ..Default::default() }), ["Heute", "Bald"]);
    assert_eq!(texts(Query { filters: vec![f("fällig", "ist", "ohne")], ..Default::default() }), ["Offen #x"]);
    assert_eq!(
        texts(Query { filters: vec![f("fällig", "vor", "2026-09-25")], ..Default::default() }),
        ["Alt", "Heute"]
    );
    assert_eq!(texts(Query { filters: vec![f("prio", "ist", "hoch")], ..Default::default() }), ["Alt", "Später"]);
    assert_eq!(texts(Query { filters: vec![f("prio", ">=", "1")], ..Default::default() }), ["Alt", "Bald", "Später"]);
    assert_eq!(texts(Query { filters: vec![f("seite", "ist", "b")], ..Default::default() }), ["Später"]);
    assert_eq!(texts(Query { filters: vec![f("status", "ist", "erledigt")], ..Default::default() }), ["Fertig"]);
    assert_eq!(texts(Query { tag: Some("x".into()), ..Default::default() }), ["Offen #x"]);
    let r = w.query(Query { source: Source::Tasks, group: "fällig".into(), ..Default::default() });
    let groups: Vec<(&str, f64)> = r.groups.iter().map(|g| (g.label.as_str(), g.value)).collect();
    assert_eq!(groups, [("überfällig", 1.0), ("heute", 1.0), ("woche", 1.0), ("später", 1.0), ("ohne", 1.0)]);
    let row = &r.rows[0];
    assert_eq!((row.ordinal, row.done, row.priority), (Some(0), Some(false), Some(2)));
    // An unknown field matches nothing for „ist“, so a typo shows an empty list.
    assert!(texts(Query { filters: vec![f("farbe", "ist", "rot")], ..Default::default() }).is_empty());
    // English field names, words and operators run like the German ones.
    assert_eq!(texts(Query { filters: vec![f("due", "is", "overdue")], ..Default::default() }), ["Alt"]);
    assert_eq!(texts(Query { filters: vec![f("Priority", "is", "high")], ..Default::default() }), ["Alt", "Später"]);
    assert_eq!(texts(Query { filters: vec![f("status", "is", "done")], ..Default::default() }), ["Fertig"]);
    assert_eq!(texts(Query { filters: vec![f("page", "contains", "b")], ..Default::default() }), ["Später"]);
    assert_eq!(texts(Query { filters: vec![f("due", "before", "2026-09-25")], ..Default::default() }), ["Alt", "Heute"]);
    let en = w.query(Query { source: Source::Tasks, group: "due".into(), ..Default::default() });
    assert_eq!(en.groups, r.groups);
}

#[test]
fn query_entries_sum_and_group() {
    let w = world();
    w.book(w.np, Some("1010"), at(9, 21, 8, 0), 120, "Konzept Login");
    w.book(w.np, Some("1020"), at(9, 22, 8, 0), 60, "Umsetzung");
    w.book(w.other, None, at(9, 22, 10, 0), 30, "Betrieb");
    w.book(w.np, Some("1010"), at(9, 10, 8, 0), 600, "früher");
    let r = w.query(Query { source: Source::Entries, group: "wbs".into(), ..Default::default() });
    assert_eq!((r.total, r.minutes), (3, Some(210)));
    let groups: Vec<(&str, f64)> = r.groups.iter().map(|g| (g.label.as_str(), g.value)).collect();
    assert_eq!(groups, [("NP-8801/1010", 2.0), ("NP-8801/1020", 1.0), ("NP-9900", 0.5)]);
    assert_eq!(r.rows[0].title, "Betrieb", "newest first");
    let r = w.query(Query {
        source: Source::Entries,
        range: "month".into(),
        filters: vec![f("netzplan", "ist", "np-8801")],
        ..Default::default()
    });
    assert_eq!(r.minutes, Some(780));
    let r = w.query(Query {
        source: Source::Entries,
        range: "month".into(),
        filters: vec![f("stunden", ">=", "2")],
        ..Default::default()
    });
    assert_eq!(r.minutes, Some(720));
    let r = w.query(Query { source: Source::Entries, text: "login".into(), group: "tag".into(), ..Default::default() });
    assert_eq!(r.groups.iter().map(|g| g.label.as_str()).collect::<Vec<_>>(), ["2026-09-21"]);
}

#[test]
fn query_events_by_calendar_and_text() {
    let w = world();
    w.db.calendar_replace(
        "outlook",
        at(9, 1, 0, 0),
        at(10, 31, 0, 0),
        &[event("a", at(9, 23, 9, 0), 30, "Standup"), event("b", at(9, 24, 9, 0), 30, "Standup")],
    )
    .unwrap();
    w.db.calendar_replace("ics:team", at(9, 1, 0, 0), at(10, 31, 0, 0), &[event("c", at(9, 24, 14, 0), 60, "Review")])
        .unwrap();
    let r = w.query(Query { source: Source::Events, group: "tag".into(), ..Default::default() });
    assert_eq!(r.total, 3);
    assert_eq!(
        r.groups.iter().map(|g| (g.label.as_str(), g.value)).collect::<Vec<_>>(),
        [("2026-09-23", 1.0), ("2026-09-24", 2.0)]
    );
    let r = w.query(Query {
        source: Source::Events,
        filters: vec![f("kalender", "ist", "ics:team")],
        ..Default::default()
    });
    assert_eq!(r.rows.iter().map(|x| x.title.as_str()).collect::<Vec<_>>(), ["Review"]);
    assert_eq!(r.rows[0].minutes, Some(60));
    let r = w.query(Query { source: Source::Events, text: "stand".into(), days: 1, ..Default::default() });
    assert_eq!(r.total, 1);
}
