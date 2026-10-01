use super::*;
use crate::calsync::calendars::{OutlookCalendar, OutlookKind};
use crate::calsync::{Busy, NewEvent};
use crate::dashboard::Part;
use crate::model::{EntrySource, NewTimeEntry};
use crate::settings::Settings;
use chrono::TimeZone;

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 1, 10, 0, 0).unwrap()
}
fn today() -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()
}
fn at(d: u32, h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, d, h, m, 0).unwrap()
}
fn slot(a: DateTime<Utc>, b: DateTime<Utc>, presence: Presence, title: &str) -> Slot {
    Slot { start: a, end: b, presence, title: title.into() }
}

#[test]
fn availability_now_and_the_next_change() {
    // Free now, a meeting at 11, then out of office from 14.
    let slots = vec![
        slot(at(1, 11, 0), at(1, 12, 0), Presence::Busy, "Review"),
        slot(at(1, 14, 0), at(2, 0, 0), Presence::Oof, "Arzt"),
        slot(at(1, 8, 0), at(1, 9, 0), Presence::Busy, "vorbei"),
        slot(at(1, 9, 30), at(1, 10, 30), Presence::Free, "frei"),
    ];
    let a = availability(&slots, now());
    assert_eq!(
        (a.state, a.until, a.next, a.title.as_str()),
        (Presence::Free, Some(at(1, 11, 0)), Some(Presence::Busy), "")
    );
    let a = availability(&slots, at(1, 11, 15));
    assert_eq!(
        (a.state, a.until, a.next, a.title.as_str()),
        (Presence::Busy, Some(at(1, 12, 0)), Some(Presence::Free), "Review")
    );
    // Back-to-back meetings: busy until the end of the last one.
    let chain = vec![
        slot(at(1, 9, 0), at(1, 10, 30), Presence::Busy, "A"),
        slot(at(1, 10, 30), at(1, 11, 0), Presence::Busy, "B"),
        slot(at(1, 10, 45), at(1, 12, 0), Presence::Tentative, "C"),
    ];
    let a = availability(&chain, now());
    assert_eq!((a.state, a.until, a.next), (Presence::Busy, Some(at(1, 11, 0)), Some(Presence::Tentative)));
    // Out of office beats busy; nothing ahead: no change in the window.
    let away = vec![
        slot(at(1, 0, 0), at(3, 0, 0), Presence::Oof, "Urlaub"),
        slot(at(1, 9, 0), at(1, 11, 0), Presence::Busy, "X"),
    ];
    let a = availability(&away, now());
    assert_eq!(
        (a.state, a.until, a.next, a.title.as_str()),
        (Presence::Oof, Some(at(3, 0, 0)), Some(Presence::Free), "Urlaub")
    );
    let a = availability(&[], now());
    assert_eq!((a.state, a.until, a.next), (Presence::Free, None, None));
}

fn event(uid: &str, a: DateTime<Utc>, b: DateTime<Utc>, busy: Busy) -> NewEvent {
    NewEvent {
        uid: uid.into(),
        instance: String::new(),
        recurring: false,
        start: a,
        end: b,
        all_day: false,
        title: format!("Termin {uid}"),
        location: String::new(),
        organizer: String::new(),
        attendees: vec![],
        body: None,
        link: None,
        busy,
        private: false,
        categories: vec![],
    }
}

fn cal(id: &str, owner: &str, kind: OutlookKind, free_busy: bool) -> OutlookCalendar {
    OutlookCalendar {
        id: id.into(),
        owner: owner.into(),
        name: "Kalender".into(),
        kind,
        free_busy,
        enabled: true,
        ..Default::default()
    }
}

#[test]
fn team_reads_the_shared_calendars_only() {
    let db = Database::open_in_memory().unwrap();
    let mut s = Settings::default();
    s.calendar.outlook_calendars = vec![
        cal("outlook", "", OutlookKind::Own, false),
        cal("outlook:anna", "Anna Müller", OutlookKind::Shared, false),
        cal("outlook:joerg", "Jörg Weiß", OutlookKind::Shared, true),
        cal("outlook:team", "Team Vertrieb", OutlookKind::Mailbox, false),
    ];
    let w = |from, to| (from, to);
    let (from, to) = w(now() - Duration::days(2), now() + Duration::days(8));
    db.calendar_replace("outlook:anna", from, to, &[event("a1", at(1, 9, 30), at(1, 10, 30), Busy::Busy)]).unwrap();
    db.calendar_replace("outlook:joerg", from, to, &[event("j1", at(1, 0, 0), at(2, 0, 0), Busy::Oof)]).unwrap();
    db.calendar_replace("outlook", from, to, &[event("o1", at(1, 9, 0), at(1, 11, 0), Busy::Busy)]).unwrap();
    let sources: Vec<String> = vec!["outlook".into(), "outlook:anna".into(), "outlook:joerg".into()];
    let ctx = Ctx::new(&db, &Utc, now(), today(), &sources, &s);
    let t = team(&ctx, &[]).unwrap();
    // The own calendar is no team member; the mailbox is not synced (not an active source).
    assert_eq!(t.available.iter().map(|a| a.1.as_str()).collect::<Vec<_>>(), ["Anna Müller", "Jörg Weiß"]);
    let states: Vec<_> =
        t.members.iter().map(|m| (m.name.as_str(), m.availability.state, m.availability.title.as_str())).collect();
    assert_eq!(states, [("Anna Müller", Presence::Busy, "Termin a1"), ("Jörg Weiß", Presence::Oof, "")]);
    assert_eq!(t.members[0].availability.until, Some(at(1, 10, 30)));
    let t = team(&ctx, &["outlook:joerg".into()]).unwrap();
    assert_eq!(t.members.len(), 1);
    assert!(t.members[0].free_busy);
}

fn world() -> (Database, i64, Settings) {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_project("PRJ", "Projekt").unwrap();
    let np = db.create_netzplan(p.id, "NP-1", "NP-1-1", "Portal", 100.0).unwrap();
    (db, np.id, Settings::default())
}

fn book(db: &Database, np: i64, vorgang: Option<&str>, la: Option<&str>, t: DateTime<Utc>, minutes: i64) {
    db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np,
        vorgang_nr: vorgang.map(Into::into),
        leistungsart: la.map(Into::into),
        start_time: t,
        duration_minutes: minutes,
        description: String::new(),
        source: EntrySource::Manual,
        page_id: None,
    })
    .unwrap();
}

#[test]
fn bookings_chart_groups_in_sql() {
    let (db, np, s) = world();
    let p = db.create_project("PRJ2", "Zwei").unwrap();
    let np2 = db.create_netzplan(p.id, "NP-2", "NP-2-1", "Intranet", 10.0).unwrap().id;
    book(&db, np, Some("0010"), Some("DEV"), at(1, 8, 0), 120);
    book(&db, np, None, Some("PM"), Utc.with_ymd_and_hms(2026, 9, 22, 8, 0, 0).unwrap(), 60);
    book(&db, np2, None, Some("DEV"), Utc.with_ymd_and_hms(2026, 9, 29, 8, 0, 0).unwrap(), 240);
    // Older than the range.
    book(&db, np2, None, None, Utc.with_ymd_and_hms(2026, 6, 1, 8, 0, 0).unwrap(), 600);
    let sources = vec![];
    let ctx = Ctx::new(&db, &Utc, now(), today(), &sources, &s);
    let q =
        |group: &str| ChartQuery { source: ChartSource::Bookings, group: group.into(), weeks: 4, ..Default::default() };
    let c = bookings_chart(&ctx, &q("netzplan")).unwrap();
    let pts: Vec<_> = c.points.iter().map(|p| (p.label.as_str(), p.detail.as_str(), p.value)).collect();
    assert_eq!(pts, [("NP-2", "Intranet", 240.0), ("NP-1", "Portal", 180.0)]);
    assert_eq!((c.unit.as_str(), c.total), ("minutes", 420.0));
    let c = bookings_chart(&ctx, &q("activity")).unwrap();
    assert_eq!(
        c.points.iter().map(|p| (p.label.as_str(), p.value)).collect::<Vec<_>>(),
        [("DEV", 360.0), ("PM", 60.0)]
    );
    let c = bookings_chart(&ctx, &q("vorgang")).unwrap();
    assert_eq!(c.points.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), ["NP-2", "NP-1/0010", "NP-1"]);
    // Weeks: four buckets from Monday 7 September, empty weeks as zero, oldest first.
    let c = bookings_chart(&ctx, &q("week")).unwrap();
    assert!(c.ordered);
    assert_eq!(c.points.iter().map(|p| p.value).collect::<Vec<_>>(), [0.0, 0.0, 60.0, 360.0]);
    assert_eq!(c.points[3].date, NaiveDate::from_ymd_opt(2026, 9, 28));
    // Time tracking off: the bookings are not charted.
    let mut off = s.clone();
    off.time.enabled = false;
    let ctx = Ctx::new(&db, &Utc, now(), today(), &sources, &off);
    assert!(part(&ctx, &WorkPart::Chart { chart: q("netzplan") }).is_err());
    assert!(part(&ctx, &WorkPart::Balance { weeks: 8 }).is_err());
}

const PARENT: &str = "---\neigenschaften:\n  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}\n  aufwand: zahl\n  fällig: datum\n  themen: mehrfachauswahl\n---\n# Aufgaben\n";

fn collection(db: &Database) -> i64 {
    let parent = db.create_page(None, "Projekte", None).unwrap();
    db.save_page_content(parent.id, PARENT).unwrap();
    let child = |title: &str, fm: &str| {
        let p = db.create_page(Some(parent.id), title, None).unwrap();
        db.save_page_content(p.id, &format!("---\n{fm}\n---\n# {title}\n")).unwrap();
    };
    child("Login", "status: Offen\naufwand: 3\nfällig: 2026-10-04\nthemen: [UI, API]");
    child("Export", "status: In Arbeit\naufwand: 5,5\nfällig: 2026-09-25");
    child("Suche", "status: Offen\naufwand: 2\nthemen: [UI]");
    child("Alt", "status: Fertig\nfällig: 2026-09-30");
    child("Rest", "aufwand: x");
    parent.id
}

#[test]
fn pages_chart_counts_and_sums_by_property() {
    let (db, _, _) = world();
    let parent = collection(&db);
    let q = |group: &str, value: &str, field: &str| ChartQuery {
        source: ChartSource::Pages,
        page: Some(parent),
        group: group.into(),
        value: value.into(),
        field: field.into(),
        ..Default::default()
    };
    // A select keeps its options' order and colors, then pages without a value.
    let c = pages_chart(&db, &q("status", "count", "")).unwrap();
    let pts: Vec<_> = c.points.iter().map(|p| (p.label.as_str(), p.value, p.color.as_deref())).collect();
    assert_eq!(
        pts,
        [
            ("Offen", 2.0, Some("grau")),
            ("In Arbeit", 1.0, Some("blau")),
            ("Fertig", 1.0, Some("grün")),
            ("", 1.0, None)
        ]
    );
    assert_eq!((c.total, c.unit.as_str(), c.ordered), (5.0, "count", true));
    // Sum of a number property (1,5 notation too; an invalid value counts 0).
    let c = pages_chart(&db, &q("Status", "sum", "aufwand")).unwrap();
    assert_eq!(c.points.iter().map(|p| p.value).collect::<Vec<_>>(), [5.0, 5.5, 0.0, 0.0]);
    assert_eq!(c.unit, "number");
    // Multi-select: a page counts in each of its values.
    let c = pages_chart(&db, &q("themen", "count", "")).unwrap();
    let pts: Vec<_> = c.points.iter().map(|p| (p.label.as_str(), p.value)).collect();
    assert_eq!(pts, [("", 3.0), ("UI", 2.0), ("API", 1.0)]);
    // Dates by month.
    let c = pages_chart(&db, &q("fällig", "count", "")).unwrap();
    assert_eq!(
        c.points.iter().map(|p| (p.label.as_str(), p.value)).collect::<Vec<_>>(),
        [("", 2.0), ("2026-09", 2.0), ("2026-10", 1.0)]
    );
    assert!(pages_chart(&db, &ChartQuery::default()).unwrap().points.is_empty());
}

#[test]
fn deadlines_from_tasks_and_date_properties() {
    let (db, _, _) = world();
    collection(&db);
    let note = db.create_page(None, "Plan", None).unwrap();
    db.save_page_content(
        note.id,
        "# Plan\n- [ ] Angebot schicken due:2026-10-03 !!\n- [ ] Alt due:2026-09-01\n- [ ] Später due:2026-12-01\n- [x] Fertig due:2026-10-02\n",
    )
    .unwrap();
    let d = deadlines(&db, today(), 14, &[]).unwrap();
    let items: Vec<_> = d.items.iter().map(|x| (x.date.to_string(), x.title.as_str(), x.source.as_str())).collect();
    assert_eq!(
        items,
        [
            ("2026-09-01".into(), "Alt", "tasks"),
            ("2026-09-25".into(), "Export", "properties"),
            ("2026-10-03".into(), "Angebot schicken", "tasks"),
            ("2026-10-04".into(), "Login", "properties"),
        ],
        "overdue tasks of any age, pages of the last 14 days, nothing done (Alt is „Fertig“), nothing beyond the horizon"
    );
    assert_eq!(d.items[2].priority, 2);
    assert_eq!(d.items[1].detail, "Projekte · fällig");
    let only = deadlines(&db, today(), 14, &["tasks".into()]).unwrap();
    assert!(only.items.iter().all(|x| x.source == "properties"));
    assert_eq!(DEADLINE_PROVIDERS.iter().map(|p| p.0).collect::<Vec<_>>(), ["tasks", "properties"]);
}

#[test]
fn heatmap_counts_pages_per_day_and_hours() {
    let (db, np, s) = world();
    let ids: Vec<i64> = (0..3).map(|i| db.create_page(None, &format!("P{i}"), None).unwrap().id).collect();
    db.conn().execute("DELETE FROM activity", []).unwrap();
    for (when, page) in [
        ("2026-09-30T08:00:00Z", 0),
        ("2026-09-30T09:00:00Z", 0),
        ("2026-09-30T10:00:00Z", 1),
        ("2026-09-28T10:00:00Z", 2),
    ] {
        db.conn()
            .execute(
                "INSERT INTO activity (at, kind, page_id) VALUES (?1, 'page_edited', ?2)",
                params![when, ids[page]],
            )
            .unwrap();
    }
    book(&db, np, None, None, at(1, 8, 0), 90);
    let sources = vec![];
    let ctx = Ctx::new(&db, &Utc, now(), today(), &sources, &s);
    let from = NaiveDate::from_ymd_opt(2026, 9, 1).unwrap();
    let h = heatmap(&ctx, HeatMode::Notes, from, today()).unwrap();
    assert_eq!(h.days.iter().map(|d| (d.0.day(), d.1)).collect::<Vec<_>>(), [(28, 1), (30, 2)]);
    assert_eq!((h.max, h.total, h.active), (2, 3, 2));
    let h = heatmap(&ctx, HeatMode::Hours, from, today()).unwrap();
    assert_eq!(h.days, [(today(), 90)]);
    assert!(heatmap(&ctx, HeatMode::Notes, from - Duration::days(500), today()).is_err());
}

#[test]
fn work_parts_come_through_the_part_enum() {
    let p: Part = serde_json::from_str(r#"{"kind":"deadlines","days":7}"#).unwrap();
    assert_eq!(p, Part::Work(WorkPart::Deadlines { days: 7, off: vec![] }));
    let p: Part =
        serde_json::from_str(r#"{"kind":"chart","chart":{"source":"bookings","group":"week","weeks":8}}"#).unwrap();
    assert!(matches!(p, Part::Work(WorkPart::Chart { chart }) if chart.weeks == 8 && chart.group == "week"));
    let p: Part = serde_json::from_str(r#"{"kind":"today"}"#).unwrap();
    assert_eq!(p, Part::Today);
    assert!(serde_json::from_str::<Part>(r#"{"kind":"nonsense"}"#).is_err());
}

#[test]
fn kanban_hands_out_the_frontmatter() {
    let (db, _, _) = world();
    let parent = collection(&db);
    let k = kanban(&db, parent).unwrap();
    assert!(k.frontmatter.starts_with("---\neigenschaften:"));
    assert_eq!(k.rows.len(), 5);
    assert!(k.rows[0].frontmatter.contains("status: Offen"));
}
