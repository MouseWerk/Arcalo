//! The large workspace of the performance benchmark (`docs/performance.md`): 5,000 pages with
//! 20,000 links and 30,000 tasks, three years of daily notes, two years of bookings, 300
//! attachments, a canvas of 200 cards, 2,000 Jira issues in 50 projects and three calendars.
//!
//! Generate it (deterministic, about a minute in a debug build) into a data folder:
//!
//! ```sh
//! ARCALO_BIG_DIR=/tmp/big cargo test -p arcalo-core --test bigworkspace -- --ignored --nocapture
//! ```
//!
//! The test then times the main core queries on it. `e2e/lib/bigworkspace.js` uses the same
//! folder for the UI measurements.

use std::path::PathBuf;
use std::time::Instant;

use arcalo_core::Database;
use arcalo_core::calsync::{Busy, IcsSource, NewEvent};
use arcalo_core::issues::{Issue, IssueComment, JiraSite};
use arcalo_core::model::{EntrySource, NewTimeEntry};
use chrono::{Datelike, Duration, NaiveDate, TimeZone, Utc, Weekday};

const PAGES: usize = 5_000;
const LINKS_PER_PAGE: usize = 4;
const TASKS_PER_PAGE: usize = 6;
const DAILY_DAYS: i64 = 3 * 365;
const BOOKING_DAYS: i64 = 2 * 365;
const ATTACHMENTS: usize = 300;
const CANVAS_CARDS: usize = 200;
const JIRA_PROJECTS: usize = 50;
const JIRA_ISSUES: usize = 2_000;
const CALENDARS: usize = 3;

const WORDS: &[&str] = &[
    "Projekt",
    "Termin",
    "Abstimmung",
    "Konzept",
    "Umsetzung",
    "Kunde",
    "Schnittstelle",
    "Daten",
    "Prüfung",
    "Freigabe",
    "Planung",
    "Risiko",
    "Budget",
    "Meilenstein",
    "Anforderung",
    "Test",
    "Migration",
    "Bericht",
    "und",
    "mit",
    "für",
    "die",
    "der",
    "das",
    "nach",
    "vor",
    "wird",
    "ist",
    "nicht",
    "auch",
    "noch",
    "bereits",
];

/// A small deterministic generator (no extra dependency).
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n as u64) as usize
    }
    fn words(&mut self, n: usize) -> String {
        let mut s = String::with_capacity(n * 8);
        for i in 0..n {
            if i > 0 {
                s.push(' ');
            }
            s.push_str(WORDS[self.below(WORDS.len())]);
        }
        s
    }
}

fn title(i: usize) -> String {
    format!("Seite {i:04} {}", WORDS[i % 18])
}

/// A page of about 300 words with links, tasks, tags and an occasional attachment.
fn page_body(i: usize, rng: &mut Rng, today: NaiveDate) -> String {
    let mut s = String::new();
    if i.is_multiple_of(5) {
        s.push_str(&format!("---\nstatus: {}\nvorgang: 1010\n---\n", ["offen", "aktiv", "fertig"][i % 3]));
    }
    s.push_str(&format!("# {}\n\n", title(i)));
    for p in 0..3 {
        s.push_str(&rng.words(80));
        s.push_str(&format!(" #thema{} #bereich{}\n\n", i % 40, p));
        if p == 1 {
            s.push_str("## Abschnitt\n\n");
        }
    }
    s.push_str("Verweise: ");
    for l in 0..LINKS_PER_PAGE {
        let t = (i * 7 + l * 131 + 1) % PAGES;
        s.push_str(&format!("[[{}]] ", title(t)));
    }
    s.push_str("\n\n");
    for t in 0..TASKS_PER_PAGE {
        let done = if (i + t).is_multiple_of(3) { "x" } else { " " };
        let due = today + Duration::days(((i * 3 + t * 11) % 120) as i64 - 30);
        let prio = ["", " !", " !!"][(i + t) % 3];
        s.push_str(&format!("- [{done}] Aufgabe {i}-{t} {}{prio} due:{}\n", rng.words(4), due.format("%Y-%m-%d")));
    }
    if i.is_multiple_of(17) {
        s.push_str(&format!("\n![[anhang-{:03}.png]]\n", i % ATTACHMENTS));
    }
    s
}

/// The large page: about 10,000 words with tables, embeds and a Mermaid diagram.
fn large_page(rng: &mut Rng) -> String {
    let mut s = String::from("# Großes Dokument\n\n");
    for sec in 0..40 {
        s.push_str(&format!("## Kapitel {}\n\n", sec + 1));
        for _ in 0..3 {
            s.push_str(&rng.words(80));
            s.push_str("\n\n");
        }
        if sec % 4 == 0 {
            s.push_str("| Spalte A | Spalte B | Spalte C | Spalte D |\n| --- | --- | --- | --- |\n");
            for r in 0..12 {
                s.push_str(&format!("| {} | {} | {r} | {} |\n", rng.words(2), rng.words(3), rng.words(2)));
            }
            s.push('\n');
        }
        if sec % 8 == 1 {
            s.push_str("```mermaid\ngraph TD\n  A[Start] --> B{Prüfung}\n  B -->|ja| C[Freigabe]\n  B -->|nein| D[Nacharbeit]\n  D --> B\n```\n\n");
        }
        if sec % 10 == 2 {
            s.push_str(&format!("![[{}]]\n\n![[anhang-{:03}.png]]\n\n", title(sec), sec));
        }
        s.push_str(&format!("- [ ] Offener Punkt {sec}\n- [x] Erledigt {sec}\n\n"));
    }
    s
}

/// A 1x1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49,
    0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0, 0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D,
    0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

fn generate(dir: &std::path::Path) {
    let started = Instant::now();
    std::fs::create_dir_all(dir.join("attachments")).unwrap();
    let db = Database::open(dir.join(arcalo_core::datadir::DB_FILE)).unwrap();
    let today = Utc::now().date_naive();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);

    // Attachments.
    for i in 0..ATTACHMENTS {
        std::fs::write(dir.join("attachments").join(format!("anhang-{i:03}.png")), PNG).unwrap();
    }

    // Pages: 50 folders, each with subfolders; created first, then filled (links resolve).
    db.atomic(|| {
        let mut ids = Vec::with_capacity(PAGES);
        let mut folders = vec![];
        for f in 0..50 {
            folders.push(db.create_page(None, &format!("Bereich {f:02}"), None)?.id);
        }
        for i in 0..PAGES {
            let parent =
                if i % 10 == 0 { folders[i % 50] } else { ids.get(i - i % 10).copied().unwrap_or(folders[i % 50]) };
            ids.push(db.create_page(Some(parent), &title(i), None)?.id);
        }
        for (i, id) in ids.iter().enumerate() {
            db.save_page(*id, &page_body(i, &mut rng, today))?;
        }
        let big = db.create_page(None, "Großes Dokument", None)?;
        db.save_page(big.id, &large_page(&mut rng))?;
        Ok(())
    })
    .unwrap();
    eprintln!("pages: {:.1?}", started.elapsed());

    // Daily notes.
    db.atomic(|| {
        for d in 0..DAILY_DAYS {
            let date = today - Duration::days(d);
            let p = db.daily_note(date)?;
            let body = format!(
                "# {}\n\n{}\n\n- [ ] Tagesaufgabe {d}\n- [x] Erledigt {d}\n\n[[{}]]\n",
                date.format("%d.%m.%Y"),
                rng.words(60),
                title(d as usize % PAGES)
            );
            db.save_page(p.id, &body)?;
        }
        Ok(())
    })
    .unwrap();
    eprintln!("daily notes: {:.1?}", started.elapsed());

    // Canvas.
    db.atomic(|| {
        let c = db.create_canvas(None, "Große Leinwand", today)?;
        let mut nodes = vec![];
        let mut edges = vec![];
        for i in 0..CANVAS_CARDS {
            let (x, y) = ((i % 20) as i64 * 320, (i / 20) as i64 * 220);
            if i % 5 == 0 {
                nodes.push(serde_json::json!({"id": format!("n{i}"), "type": "file", "file": format!("{}.md", title(i)), "x": x, "y": y, "width": 280, "height": 180}));
            } else {
                nodes.push(serde_json::json!({"id": format!("n{i}"), "type": "text", "text": format!("Karte {i}\n\n{}", rng.words(20)), "x": x, "y": y, "width": 280, "height": 180}));
            }
            if i > 0 {
                edges.push(serde_json::json!({"id": format!("e{i}"), "fromNode": format!("n{}", i - 1), "toNode": format!("n{i}"), "fromSide": "right", "toSide": "left"}));
            }
        }
        db.save_page(c.id, &serde_json::json!({"nodes": nodes, "edges": edges}).to_string())?;
        Ok(())
    })
    .unwrap();

    // Bookings: five projects, ten Netzpläne with five Vorgänge each, four entries per workday.
    db.atomic(|| {
        let mut wbs = vec![];
        for p in 0..5 {
            let proj = db.create_project(&format!("PRJ-2026-{p}"), &format!("Projekt {p}"))?;
            for n in 0..2 {
                let nr = format!("NP-9{p}{n}0");
                let np =
                    db.create_netzplan(proj.id, &nr, &format!("{nr}-1000"), &format!("Netzplan {p}.{n}"), 800.0)?;
                for v in 0..5 {
                    db.create_vorgang(np.id, &format!("10{v}0"), &format!("Vorgang {v}"), 10.0, 160.0)?;
                }
                wbs.push(np.id);
            }
        }
        for d in 0..BOOKING_DAYS {
            let date = today - Duration::days(d);
            if matches!(date.weekday(), Weekday::Sat | Weekday::Sun) {
                continue;
            }
            for k in 0..4 {
                let start = Utc.from_utc_datetime(&date.and_hms_opt(7 + 2 * k as u32, 0, 0).unwrap());
                db.insert_time_entry(&NewTimeEntry {
                    netzplan_id: wbs[(d as usize + k) % wbs.len()],
                    vorgang_nr: Some(format!("10{}0", (d as usize + k) % 5)),
                    leistungsart: Some("DEV".into()),
                    start_time: start,
                    duration_minutes: 90 + 15 * (k as i64 % 3),
                    description: rng.words(5),
                    source: EntrySource::Manual,
                    page_id: None,
                })?;
            }
        }
        Ok(())
    })
    .unwrap();
    eprintln!("bookings: {:.1?}", started.elapsed());

    // Jira: one site (unreachable, so the cache stays), 50 projects, 2,000 issues.
    let mut settings = db.load_settings().unwrap();
    settings.jira.sites = vec![JiraSite {
        id: "big".into(),
        name: "Jira".into(),
        url: "http://127.0.0.1:9".into(),
        email: "perf@example.com".into(),
        ..Default::default()
    }];
    settings.calendar.sources = (0..CALENDARS)
        .map(|c| IcsSource { id: format!("big{c}"), name: format!("Kalender {c}"), ..Default::default() })
        .collect();
    db.save_settings(&settings).unwrap();
    let now = Utc::now();
    db.atomic(|| {
        for p in 0..JIRA_PROJECTS {
            db.conn().execute(
                "INSERT OR REPLACE INTO issue_projects (site, key, name) VALUES ('big', ?1, ?2)",
                [format!("P{p:02}"), format!("Projekt {p}")],
            )?;
        }
        for i in 0..JIRA_ISSUES {
            let p = i % JIRA_PROJECTS;
            let cat = ["new", "indeterminate", "done"][i % 3];
            let issue = Issue {
                site: "big".into(),
                key: format!("P{p:02}-{}", i / JIRA_PROJECTS + 1),
                remote_id: i.to_string(),
                summary: rng.words(6),
                status: ["Offen", "In Arbeit", "Erledigt"][i % 3].into(),
                status_category: cat.into(),
                priority: "Medium".into(),
                priority_level: 3,
                assignee: "Perf Nutzer".into(),
                reporter: "Perf Nutzer".into(),
                issue_type: "Task".into(),
                project_key: format!("P{p:02}"),
                project_name: format!("Projekt {p}"),
                sprint: format!("Sprint {}", i % 7),
                sprint_state: "active".into(),
                due_date: Some((today + Duration::days((i % 60) as i64 - 20)).format("%Y-%m-%d").to_string()),
                updated: Some((now - Duration::hours(i as i64)).to_rfc3339()),
                url: format!("http://127.0.0.1:9/browse/P{p:02}-{i}"),
                description: rng.words(40),
                comments: vec![IssueComment { author: "Perf".into(), created: now.to_rfc3339(), body: rng.words(10) }],
                matches: vec!["mine".into()],
                ..Default::default()
            };
            db.issue_put("big", &issue, now)?;
        }
        Ok(())
    })
    .unwrap();

    // Calendars: the sync window around today, four appointments per workday each.
    for c in 0..CALENDARS {
        let mut events = vec![];
        let (from, to) = (today - Duration::days(120), today + Duration::days(180));
        let mut d = from;
        while d < to {
            if !matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                for k in 0..4 {
                    let start = Utc.from_utc_datetime(&d.and_hms_opt(7 + 2 * k + c as u32, 30, 0).unwrap());
                    events.push(NewEvent {
                        uid: format!("c{c}-{d}-{k}"),
                        instance: String::new(),
                        recurring: false,
                        start,
                        end: start + Duration::minutes(45),
                        all_day: false,
                        title: format!("Termin {}", rng.words(3)),
                        location: "Raum 1".into(),
                        organizer: "Perf".into(),
                        attendees: vec!["Anna".into(), "Jörg".into()],
                        body: None,
                        link: None,
                        busy: Busy::Busy,
                        private: false,
                        categories: vec![],
                    });
                }
            }
            d += Duration::days(1);
        }
        let range = (
            Utc.from_utc_datetime(&from.and_hms_opt(0, 0, 0).unwrap()),
            Utc.from_utc_datetime(&to.and_hms_opt(0, 0, 0).unwrap()),
        );
        db.calendar_replace(&format!("ics:big{c}"), range.0, range.1, &events).unwrap();
        db.calendar_record_sync(&format!("ics:big{c}"), now, Ok(events.len())).unwrap();
    }
    eprintln!("generated in {:.1?}", started.elapsed());
}

fn time<T>(label: &str, runs: usize, mut f: impl FnMut() -> T) {
    let mut best = f64::MAX;
    for _ in 0..runs {
        let t = Instant::now();
        std::hint::black_box(f());
        best = best.min(t.elapsed().as_secs_f64() * 1000.0);
    }
    println!("core {label}: {best:.1} ms");
}

#[test]
#[ignore = "generates a large workspace; run explicitly (see the module docs)"]
fn big_workspace() {
    let dir = PathBuf::from(std::env::var("ARCALO_BIG_DIR").expect("ARCALO_BIG_DIR"));
    if !dir.join(arcalo_core::datadir::DB_FILE).exists() {
        generate(&dir);
    }
    let db = Database::open(dir.join(arcalo_core::datadir::DB_FILE)).unwrap();
    let big = db
        .conn()
        .query_row("SELECT id FROM pages WHERE title = 'Großes Dokument'", [], |r| r.get::<_, i64>(0))
        .unwrap();
    let content: String = db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [big], |r| r.get(0)).unwrap();
    time("page_tree", 5, || db.page_tree().unwrap());
    time("search 'abstimmung'", 5, || arcalo_core::search::search(&db, "abstimmung", 20));
    time("tasks open", 5, || db.list_tasks(&Default::default()).unwrap());
    time("page_doc small", 5, || db.page_doc(100).unwrap());
    time("page_doc large", 5, || db.page_doc(big).unwrap());
    let today = chrono::Local::now().date_naive();
    let monday = today - Duration::days(today.weekday().num_days_from_monday() as i64);
    let t = db.load_settings().unwrap().thresholds;
    let tl = chrono::Local;
    time("daily_overview week", 5, || {
        arcalo_core::calendar::daily_overview(&db, monday, monday + Duration::days(6), &tl).unwrap()
    });
    time("daily_overview 6 weeks", 5, || {
        arcalo_core::calendar::daily_overview(&db, monday, monday + Duration::days(41), &tl).unwrap()
    });
    time("open_task_counts", 5, || db.open_task_counts(&today.to_string(), Some(100)).unwrap());
    time("all_budgets", 5, || arcalo_core::tracking::all_budgets(&db, &t).unwrap());
    time("tag_suggestions", 5, || db.tag_suggestions(100).unwrap());
    time("duplicate_hints", 5, || db.duplicate_hints(100).unwrap());
    time("tag_counts", 5, || db.tag_counts().unwrap());
    time("issues_list", 5, || db.issues_list(&Default::default()).unwrap());
    time("graph_data", 3, || db.graph_data(&Default::default()).unwrap());
    time("page_schema", 5, || db.page_schema(100).unwrap());
    time("page_work", 5, || arcalo_core::pagework::page_work(&db, 100, &t).unwrap());
    time("leistungsarten", 5, || db.list_leistungsarten().unwrap());
    time("time_summary week", 5, || {
        arcalo_core::report::time_summary(&db, monday, monday + Duration::days(6), &tl).unwrap()
    });
    let (from, to) = (Utc::now() - Duration::days(7), Utc::now() + Duration::days(35));
    let sources: Vec<String> = (0..CALENDARS).map(|c| format!("ics:big{c}")).collect();
    time("calendar_events 6 weeks", 5, || db.calendar_events(from, to, &sources).unwrap());
    let settings = db.load_settings().unwrap();
    let ctx = arcalo_core::dashboard::Ctx::new(&db, &tl, Utc::now(), today, &sources, &settings);
    let np = db.list_netzplaene(None).unwrap()[0].id;
    for part in [
        serde_json::json!({"kind": "today"}),
        serde_json::json!({"kind": "agenda", "days": 7}),
        serde_json::json!({"kind": "tasks"}),
        serde_json::json!({"kind": "week", "week_start": monday}),
        serde_json::json!({"kind": "budgets"}),
        serde_json::json!({"kind": "project", "netzplan_id": np}),
        serde_json::json!({"kind": "recent", "limit": 10}),
        serde_json::json!({"kind": "feed", "limit": 20}),
        serde_json::json!({"kind": "focus", "week_start": monday}),
        serde_json::json!({"kind": "review", "date": today - Duration::days(1)}),
        serde_json::json!({"kind": "timer_refs"}),
        serde_json::json!({"kind": "month", "from": monday, "to": monday + Duration::days(41)}),
        serde_json::json!({"kind": "query", "query": {"source": "entries", "range": "month", "group": "wbs"}}),
    ] {
        let label = format!("dashboard {}", part["kind"].as_str().unwrap());
        let part: arcalo_core::dashboard::Part = serde_json::from_value(part).unwrap();
        time(&label, 3, || arcalo_core::dashboard::part(&ctx, &part).unwrap());
    }
    time("save large page", 3, || db.save_page(big, &content).unwrap());
    time("save small page", 5, || {
        let c: String = db.conn().query_row("SELECT content FROM pages WHERE id = 100", [], |r| r.get(0)).unwrap();
        db.save_page(100, &c).unwrap()
    });
    drop(db);

    // The same reads on an encrypted copy (SQLCipher), in a fresh process state each.
    let enc = dir.join("workspace-encrypted.db");
    let key = arcalo_core::cipher::DbKey::from_bytes(&[7u8; 32]).unwrap();
    if !enc.exists() {
        arcalo_core::cipher::export(&dir.join(arcalo_core::datadir::DB_FILE), None, &enc, Some(&key)).unwrap();
    }
    for (label, path, key) in [("plain", dir.join(arcalo_core::datadir::DB_FILE), None), ("encrypted", enc, Some(key))]
    {
        arcalo_core::cipher::set_key(key);
        let t0 = Instant::now();
        let db = Database::open(&path).unwrap();
        println!("core {label} open: {:.1} ms", t0.elapsed().as_secs_f64() * 1000.0);
        time(&format!("{label} first page_tree"), 1, || db.page_tree().unwrap());
        time(&format!("{label} page_tree"), 3, || db.page_tree().unwrap());
        time(&format!("{label} search"), 3, || arcalo_core::search::search(&db, "abstimmung", 20).unwrap());
        time(&format!("{label} tasks"), 3, || db.list_tasks(&Default::default()).unwrap());
        time(&format!("{label} tag_counts"), 3, || db.tag_counts().unwrap());
        time(&format!("{label} page_doc large"), 3, || db.page_doc(big).unwrap());
    }
    arcalo_core::cipher::set_key(None);
}

/// `EXPLAIN QUERY PLAN` and the best of three runs of the queries in the file `ARCALO_BIG_SQL`
/// (separated by `;;`; a first line `--[…]` holds the parameters as JSON) on the large workspace.
#[test]
#[ignore = "needs ARCALO_BIG_DIR and ARCALO_BIG_SQL"]
fn explain_queries() {
    let dir = PathBuf::from(std::env::var("ARCALO_BIG_DIR").expect("ARCALO_BIG_DIR"));
    let db = Database::open(dir.join(arcalo_core::datadir::DB_FILE)).unwrap();
    let text = std::fs::read_to_string(std::env::var("ARCALO_BIG_SQL").expect("ARCALO_BIG_SQL")).unwrap();
    for q in text.split(";;").map(str::trim).filter(|q| !q.is_empty()) {
        let (params, sql) = match q.strip_prefix("--") {
            Some(rest) => rest.split_once('\n').unwrap(),
            None => ("[]", q),
        };
        let params: Vec<serde_json::Value> = serde_json::from_str(params).unwrap();
        let values: Vec<rusqlite::types::Value> = params
            .iter()
            .map(|v| match v {
                serde_json::Value::Number(n) => n.as_i64().unwrap().into(),
                serde_json::Value::Null => rusqlite::types::Value::Null,
                other => other.as_str().unwrap().to_owned().into(),
            })
            .collect();
        println!("{}", sql.lines().next().unwrap_or(""));
        let mut st = db.conn().prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan: Vec<String> =
            st.query_map(rusqlite::params_from_iter(&values), |r| r.get(3)).unwrap().map(Result::unwrap).collect();
        println!("    {}", plan.join("\n    "));
        time("query", 3, || {
            let mut st = db.conn().prepare(sql).unwrap();
            let n = st.query_map(rusqlite::params_from_iter(&values), |_| Ok(())).unwrap().count();
            std::hint::black_box(n)
        });
    }
}

/// Search by meaning on the large workspace: every chunk gets a deterministic 768-dimensional
/// vector (the size of `nomic-embed-text`), then the query side is timed.
#[test]
#[ignore = "needs ARCALO_BIG_DIR; run explicitly (see the module docs)"]
fn semantic_search() {
    const DIMS: usize = 768;
    let dir = PathBuf::from(std::env::var("ARCALO_BIG_DIR").expect("ARCALO_BIG_DIR"));
    if !dir.join(arcalo_core::datadir::DB_FILE).exists() {
        generate(&dir);
    }
    let db = Database::open(dir.join(arcalo_core::datadir::DB_FILE)).unwrap();
    let vector = |seed: u64| -> Vec<f32> {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1);
        (0..DIMS).map(|_| (rng.below(2000) as f32 - 1000.0) / 1000.0).collect()
    };
    let t = Instant::now();
    let mut n = 0;
    loop {
        let batch = arcalo_core::ai::rag::pending_blocks(&db, 512).unwrap();
        if batch.is_empty() {
            break;
        }
        db.conn().execute_batch("BEGIN").unwrap();
        for (id, _) in &batch {
            arcalo_core::ai::rag::store_embedding(&db, *id, &vector(*id as u64)).unwrap();
        }
        db.conn().execute_batch("COMMIT").unwrap();
        n += batch.len();
    }
    let blocks: i64 = db.conn().query_row("SELECT count(*) FROM notes_blocks", [], |r| r.get(0)).unwrap();
    println!("core embedded {n} chunks in {:.1?} ({blocks} chunks in all)", t.elapsed());
    let q = vector(42);
    time("assistant vector_top_k (database scan)", 3, || arcalo_core::ai::rag::vector_top_k(&db, &q, 40).unwrap());
    let t = Instant::now();
    let mut index = arcalo_core::semantic::VectorIndex::default();
    index.sync(&db).unwrap();
    println!(
        "core semantic index load: {:.1} ms, {} chunks, {:.1} MB",
        t.elapsed().as_secs_f64() * 1000.0,
        index.len(),
        index.bytes() as f64 / 1e6
    );
    time("semantic search (exact + meaning, 30 hits)", 5, || {
        arcalo_core::semantic::search(&db, &mut index, "abstimmung", Some(&q), 30).unwrap()
    });
    time("exact search (30 hits)", 5, || arcalo_core::search::search(&db, "abstimmung", 30).unwrap());
    // After an edit: only the new chunk is read again.
    let page: i64 =
        db.conn().query_row("SELECT id FROM pages WHERE title LIKE 'Seite 0100%'", [], |r| r.get(0)).unwrap();
    let content: String = db.conn().query_row("SELECT content FROM pages WHERE id = ?1", [page], |r| r.get(0)).unwrap();
    db.save_page(page, &format!("{content}\n\nNachtrag zur Abstimmung.")).unwrap();
    for (id, _) in arcalo_core::ai::rag::pending_blocks(&db, 10).unwrap() {
        arcalo_core::ai::rag::store_embedding(&db, id, &vector(id as u64)).unwrap();
    }
    time("semantic search after an edit", 1, || {
        arcalo_core::semantic::search(&db, &mut index, "abstimmung", Some(&q), 30).unwrap()
    });
}
