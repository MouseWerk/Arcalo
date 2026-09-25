use chrono::TimeZone;

use super::*;
use crate::calsync::{NewEvent, OUTLOOK, event_key};
use crate::model::TimeEntry;

/// Monday 21.09.2026 (UTC in the pure tests).
fn t(day: u32, h: u32, m: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, day, h, m, 0).unwrap()
}

fn day(d: u32, workday: bool, booked: i64) -> Day {
    Day {
        date: NaiveDate::from_ymd_opt(2026, 9, d).unwrap(),
        from: t(d, 0, 0),
        to: t(d, 0, 0) + Duration::days(1),
        workday,
        booked_minutes: booked,
    }
}

fn plan(step: i64, round_up: bool, target: i64) -> Plan {
    Plan { step, round_up, target_minutes: target, until: t(28, 0, 0), bridge_minutes: step.max(15) }
}

fn wbs(np: i64, v: &str, confidence: Confidence) -> Option<WbsGuess> {
    Some(WbsGuess {
        netzplan_id: np,
        vorgang_nr: Some(v.into()),
        leistungsart: None,
        reference: format!("NP-{np}/{v}"),
        confidence,
        basis: Basis::Link,
        reason: format!("Grund {np}/{v}"),
    })
}

fn sig(
    kind: SourceKind,
    id: &str,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    text: &str,
    w: Option<WbsGuess>,
) -> Signal {
    Signal {
        kind,
        start,
        end,
        text: text.into(),
        source: SourceRef { kind, id: id.into(), label: text.into() },
        wbs: w,
    }
}

/// (start HH:MM, minutes, text) of the proposals.
fn spans(p: &[Proposal]) -> Vec<(String, i64, String)> {
    p.iter().map(|p| (p.start.format("%H:%M").to_string(), p.minutes, p.text.clone())).collect()
}

#[test]
fn proposals_never_overlap_existing_bookings() {
    let s = [sig(SourceKind::Calendar, "a", t(21, 9, 0), t(21, 11, 0), "Workshop", wbs(1, "1010", Confidence::High))];
    let busy = [(t(21, 9, 30), t(21, 10, 7))];
    let (p, days) = build(&[day(21, true, 37)], &s, &busy, &plan(15, true, 0));
    // The booking ends at 10:07: the slot 10:00–10:15 is taken as well.
    assert_eq!(spans(&p), [("09:00".into(), 30, "Workshop".into()), ("10:15".into(), 45, "Workshop".into())]);
    for x in &p {
        let end = x.start + Duration::minutes(x.minutes);
        assert!(busy.iter().all(|&(b0, b1)| end <= b0 || x.start >= b1), "{x:?} overlaps");
    }
    assert_eq!(days[0].proposed_minutes, 75);
    // A running timer (busy until now) blocks the same way; nothing after `until`.
    let mut p2 = plan(15, true, 0);
    p2.until = t(21, 10, 20);
    let (p, _) = build(&[day(21, true, 0)], &s, &[(t(21, 9, 45), t(21, 10, 20))], &p2);
    assert_eq!(spans(&p), [("09:00".into(), 45, "Workshop".into())]);
}

#[test]
fn adjacent_blocks_of_the_same_wbs_merge_and_others_stay_apart() {
    let w = wbs(1, "1020", Confidence::High);
    let s = [
        sig(SourceKind::Calendar, "a", t(21, 9, 0), t(21, 10, 0), "Jour fixe", w.clone()),
        sig(SourceKind::Page, "7", t(21, 10, 0), t(21, 10, 40), "Konzept Portal", w.clone()),
        // A hole of 10 minutes, then the same WBS again: bridged.
        sig(SourceKind::Focus, "3", t(21, 10, 50), t(21, 11, 30), "Mapping", w),
        sig(SourceKind::Calendar, "b", t(21, 11, 30), t(21, 12, 0), "Budgetrunde", wbs(2, "2010", Confidence::Medium)),
        // Two blocks of the same page without WBS merge; a different page does not.
        sig(SourceKind::Page, "8", t(21, 13, 0), t(21, 13, 50), "Notizen", None),
        sig(SourceKind::Page, "8", t(21, 14, 0), t(21, 14, 30), "Notizen", None),
        sig(SourceKind::Page, "9", t(21, 14, 30), t(21, 15, 0), "Andere", None),
    ];
    let (p, _) = build(&[day(21, true, 0)], &s, &[], &plan(5, true, 0));
    assert_eq!(
        spans(&p),
        [
            ("09:00".into(), 150, "Jour fixe; Konzept Portal; Mapping".into()),
            ("11:30".into(), 30, "Budgetrunde".into()),
            ("13:00".into(), 90, "Notizen".into()),
            ("14:30".into(), 30, "Andere".into()),
        ]
    );
    let kinds: Vec<SourceKind> = p[0].sources.iter().map(|s| s.kind).collect();
    assert_eq!(kinds, [SourceKind::Calendar, SourceKind::Page, SourceKind::Focus]);
    assert_eq!(p[0].kind, SourceKind::Calendar, "most time from the meeting");
    assert_eq!((p[2].confidence, p[2].reason.as_str()), (Confidence::None, "Kein passender Vorgang gefunden"));
}

#[test]
fn slots_follow_the_rounding_step_and_mode() {
    let s = [sig(SourceKind::Calendar, "a", t(21, 10, 5), t(21, 10, 50), "Review", wbs(1, "1030", Confidence::High))];
    // Nearest: a slot needs half of it covered (10:00 yes with 10 min, 10:45 no with 5 min).
    let (p, _) = build(&[day(21, true, 0)], &s, &[], &plan(15, false, 0));
    assert_eq!(spans(&p), [("10:00".into(), 45, "Review".into())]);
    // Up: every touched slot counts.
    let (p, _) = build(&[day(21, true, 0)], &s, &[], &plan(15, true, 0));
    assert_eq!(spans(&p), [("10:00".into(), 60, "Review".into())]);
    // Without rounding the grid is five minutes.
    let mut settings = crate::settings::Settings::default();
    settings.time.rounding = crate::prefs::Rounding { step_minutes: 0, ..Default::default() };
    let p5 = Plan::from_settings(&settings, t(28, 0, 0));
    assert_eq!((p5.step, p5.target_minutes), (5, 480));
    let (p, _) = build(&[day(21, true, 0)], &s, &[], &p5);
    assert_eq!(spans(&p), [("10:05".into(), 45, "Review".into())]);
}

#[test]
fn contested_slots_go_to_focus_then_meetings_then_pages() {
    let s = [
        sig(SourceKind::Page, "7", t(21, 9, 0), t(21, 11, 0), "Konzept", wbs(1, "1010", Confidence::High)),
        sig(SourceKind::Calendar, "a", t(21, 9, 30), t(21, 10, 30), "Jour fixe", wbs(2, "2010", Confidence::High)),
        sig(SourceKind::Focus, "1", t(21, 10, 0), t(21, 10, 15), "Fokus", wbs(3, "3010", Confidence::High)),
    ];
    let (p, _) = build(&[day(21, true, 0)], &s, &[], &plan(15, true, 0));
    assert_eq!(
        spans(&p),
        [
            ("09:00".into(), 30, "Konzept".into()),
            ("09:30".into(), 30, "Jour fixe".into()),
            ("10:00".into(), 15, "Fokus".into()),
            ("10:15".into(), 15, "Jour fixe".into()),
            ("10:30".into(), 30, "Konzept".into()),
        ]
    );
}

#[test]
fn work_days_targets_caps_and_gaps() {
    let s = [
        // Monday: 1 h meeting, 2 h page edits of low confidence; 6 h booked of 8.
        sig(SourceKind::Calendar, "a", t(21, 9, 0), t(21, 10, 0), "Jour fixe", wbs(1, "1010", Confidence::High)),
        sig(SourceKind::Page, "7", t(21, 13, 0), t(21, 15, 0), "Konzept", wbs(1, "1020", Confidence::Low)),
        // Tuesday: 30 minutes of 8 h, nothing booked.
        sig(SourceKind::Focus, "1", t(22, 9, 0), t(22, 9, 30), "Fokus", wbs(1, "1020", Confidence::High)),
        // Saturday: page edits do not count on days off, a focus session does (without a cap).
        sig(SourceKind::Page, "7", t(26, 10, 0), t(26, 11, 0), "Konzept", wbs(1, "1020", Confidence::High)),
        sig(SourceKind::Focus, "2", t(26, 11, 0), t(26, 12, 0), "Wochenende", None),
    ];
    let days = [day(21, true, 360), day(22, true, 0), day(23, true, 0), day(26, false, 0)];
    let mut pl = plan(15, true, 480);
    pl.until = t(26, 13, 0);
    let (p, sum) = build(&days, &s, &[], &pl);
    // Monday: 2 h left to the target; the meeting stays, the page edits lose their last hour.
    assert_eq!(
        spans(&p),
        [
            ("09:00".into(), 60, "Jour fixe".into()),
            ("13:00".into(), 60, "Konzept".into()),
            ("09:00".into(), 30, "Fokus".into()),
            ("11:00".into(), 60, "Wochenende".into()),
        ]
    );
    let row = |d: &DaySummary| {
        (d.target_minutes, d.booked_minutes, d.proposed_minutes, d.gap_minutes, d.capped_minutes, d.started)
    };
    assert_eq!(row(&sum[0]), (480, 360, 120, 0, 60, true));
    // „Di 7,5 h ohne Vorschlag“
    assert_eq!(row(&sum[1]), (480, 0, 30, 450, 0, true));
    // Wednesday: nothing at all.
    assert_eq!(row(&sum[2]), (480, 0, 0, 480, 0, true));
    assert_eq!(row(&sum[3]), (0, 0, 60, 0, 0, true), "no target on days off");
}

#[test]
fn edit_sessions_are_estimated_from_the_saves_of_an_hour() {
    // 40 saves, the last at 10:50: 60 minutes at most, not before the hour.
    assert_eq!(edit_block("page_edited", t(21, 10, 50), 40), (t(21, 10, 0), t(21, 10, 50)));
    // 8 saves → 16 minutes before the last save.
    assert_eq!(edit_block("page_edited", t(21, 10, 50), 8), (t(21, 10, 34), t(21, 10, 50)));
    // Few saves early in the hour: at least ten minutes.
    assert_eq!(edit_block("page_edited", t(21, 10, 3), 2), (t(21, 10, 0), t(21, 10, 10)));
    // A created page starts at its creation.
    assert_eq!(edit_block("page_created", t(21, 10, 20), 10), (t(21, 10, 20), t(21, 10, 40)));
    assert_eq!(edit_block("page_created", t(21, 10, 55), 30), (t(21, 10, 55), t(21, 11, 5)));
}

#[test]
fn words_and_similarity() {
    assert_eq!(words("Konzept für das Portal (v2), Termin"), ["konzept", "portal"]);
    let target = Target {
        netzplan_id: 1,
        vorgang_nr: Some("1040".into()),
        reference: "NP-8801/1040".into(),
        title: "Integrationstest".into(),
        title_words: words("Integrationstest"),
        context_words: words("Systemintegration ERP · PRJ-2026-X Rollout"),
        leistungsarten: vec![],
    };
    assert_eq!(similarity(&words("Integration vorbereiten"), &target), 2);
    assert_eq!(similarity(&words("ERP Rollout"), &target), 2);
    assert_eq!(similarity(&words("Mittagessen"), &target), 0);
}

// ------------------------------------------------------------------ database

struct Fx {
    db: Database,
    np: i64,
    np2: i64,
}

fn setup() -> Fx {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
    let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration ERP", 100.0).unwrap();
    for (nr, d) in [("1010", "Anforderungsanalyse"), ("1020", "Systemintegration"), ("1030", "Portal Konzept")] {
        db.create_vorgang(np.id, nr, d, 2.0, 20.0).unwrap();
    }
    let np2 = db.create_netzplan(p.id, "NP-8802", "NP-8802-2010", "Schulung", 40.0).unwrap();
    db.create_vorgang(np2.id, "2010", "Key-User-Schulung", 2.0, 16.0).unwrap();
    let mut s = db.load_settings().unwrap();
    s.time.rounding = crate::prefs::Rounding { step_minutes: 15, mode: crate::prefs::RoundMode::Up, min_minutes: 0 };
    db.save_settings(&s).unwrap();
    Fx { db, np: np.id, np2: np2.id }
}

fn book(db: &Database, np: i64, v: Option<&str>, start: DateTime<Utc>, minutes: i64, desc: &str) -> TimeEntry {
    db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np,
        vorgang_nr: v.map(str::to_owned),
        leistungsart: Some("DEV".into()),
        start_time: start,
        duration_minutes: minutes,
        description: desc.into(),
        source: EntrySource::Manual,
        page_id: None,
    })
    .unwrap()
}

fn event(uid: &str, instance: &str, start: DateTime<Utc>, minutes: i64, title: &str) -> NewEvent {
    NewEvent {
        uid: uid.into(),
        instance: instance.into(),
        recurring: !instance.is_empty(),
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

/// A page edit session: `count` saves of the hour, the last at `at`.
fn edited(db: &Database, page: i64, at: DateTime<Utc>, count: i64) {
    db.conn()
        .execute(
            "INSERT INTO activity (at, kind, page_id, title, amount, count) VALUES (?1, 'page_edited', ?2, 'x', 500, ?3)",
            params![ts(at), page, count],
        )
        .unwrap();
}

fn focus(db: &Database, np: Option<i64>, v: Option<&str>, goal: &str, start: DateTime<Utc>, minutes: i64) -> i64 {
    db.conn()
        .execute(
            "INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, ended_at, status, worked_minutes)
             VALUES (?1, ?2, '', ?3, ?4, ?5, ?6, 'done', ?5)",
            params![np, v, goal, ts(start), minutes, ts(start + Duration::minutes(minutes))],
        )
        .unwrap();
    db.conn().last_insert_rowid()
}

fn page(db: &Database, parent: Option<i64>, title: &str, content: &str) -> i64 {
    let p = db.create_page(parent, title, None).unwrap();
    db.save_page_content(p.id, content).unwrap();
    // Only the edits a test writes count.
    db.conn().execute("DELETE FROM activity", []).unwrap();
    p.id
}

fn week(db: &Database, now: DateTime<Utc>) -> WeekProposal {
    propose(db, NaiveDate::from_ymd_opt(2026, 9, 21).unwrap(), now, &Zone::Utc, &ProposeOptions::default()).unwrap()
}

#[test]
fn a_week_from_meetings_focus_and_pages() {
    let Fx { db, np, .. } = setup();
    let portal = page(&db, None, "Konzept Portal", "---\nvorgang: NP-8801/1030\n---\nEntwurf\n");
    let daily = db.daily_note(NaiveDate::from_ymd_opt(2026, 9, 21).unwrap()).unwrap();
    let events = vec![
        event("jf", "2026-09-21T08:00:00Z", t(21, 8, 0), 60, "Jour fixe Kunde X"),
        event("skip", "", t(21, 12, 0), 30, "Mittagspause"),
        event("booked", "", t(22, 8, 0), 60, "Architektur"),
        event("hand", "", t(22, 13, 0), 30, "Budgetrunde"),
        event("later", "", t(24, 15, 0), 60, "Ausblick"),
        {
            let mut e = event("free", "", t(21, 15, 0), 60, "Frei");
            e.busy = Busy::Free;
            e
        },
    ];
    db.calendar_replace(OUTLOOK, t(1, 0, 0), t(30, 0, 0), &events).unwrap();
    db.calendar_set_skip(&event_key(OUTLOOK, "skip", ""), true).unwrap();
    let e = book(&db, np, Some("1010"), t(22, 7, 0), 60, "Architektur (gebucht)");
    db.calendar_link_entry(&event_key(OUTLOOK, "booked", ""), e.id).unwrap();
    // Booked by hand on the same day at another time, described like the subject.
    book(&db, np, Some("1010"), t(22, 16, 0), 30, "Budgetrunde");
    let f = focus(&db, Some(np), Some("1020"), "Mapping", t(21, 13, 0), 50);
    edited(&db, portal, t(21, 10, 50), 40);
    edited(&db, daily.id, t(21, 11, 30), 40);

    // Thursday 12:00: the appointment on Thursday afternoon lies ahead.
    let w = week(&db, t(24, 12, 0));
    let spans: Vec<(String, i64, &str, Option<&str>)> = w
        .proposals
        .iter()
        .map(|p| {
            (
                p.start.format("%d. %H:%M").to_string(),
                p.minutes,
                p.text.as_str(),
                p.wbs.as_ref().map(|w| w.reference.as_str()),
            )
        })
        .collect();
    assert_eq!(
        spans,
        [
            ("21. 08:00".into(), 60, "Jour fixe Kunde X", None),
            ("21. 10:00".into(), 60, "Konzept Portal", Some("NP-8801/1030")),
            ("21. 13:00".into(), 60, "Mapping", Some("NP-8801/1020")),
        ]
    );
    let portal_p = &w.proposals[1];
    assert_eq!(
        (portal_p.confidence, portal_p.reason.as_str()),
        (Confidence::High, "Seite „Konzept Portal“ gehört zu NP-8801/1030")
    );
    assert_eq!(
        portal_p.sources,
        [SourceRef { kind: SourceKind::Page, id: portal.to_string(), label: "Konzept Portal".into() }]
    );
    assert_eq!(w.proposals[2].sources[0].id, f.to_string());
    assert_eq!(w.proposals[2].reason, "Fokus-Sitzung auf NP-8801/1020");
    assert_eq!(w.step_minutes, 15);
    assert_eq!(w.days[1].booked_minutes, 90);
    assert_eq!((w.days[4].started, w.days[4].gap_minutes), (false, 0));

    // With the rest of today, Thursday's appointment is proposed as well.
    let opts = ProposeOptions { rest_of_today: true, sources: None };
    let w = propose(&db, NaiveDate::from_ymd_opt(2026, 9, 21).unwrap(), t(24, 12, 0), &Zone::Utc, &opts).unwrap();
    assert!(w.proposals.iter().any(|p| p.text == "Ausblick"));
    // Only the active sources are read.
    let opts = ProposeOptions { rest_of_today: false, sources: Some(vec!["ics:s1".into()]) };
    let w = propose(&db, NaiveDate::from_ymd_opt(2026, 9, 21).unwrap(), t(24, 12, 0), &Zone::Utc, &opts).unwrap();
    assert!(w.proposals.iter().all(|p| p.kind != SourceKind::Calendar));
}

#[test]
fn wbs_resolution_order_for_pages() {
    let Fx { db, np, np2 } = setup();
    let ctx = || WbsContext::load(&db, t(24, 12, 0), &Zone::Utc).unwrap();
    let project = page(&db, None, "Projekt X", "---\nvorgang: NP-8802/2010\n---\n");
    let sub = page(&db, Some(project), "Protokolle", "");
    let deep = page(&db, Some(sub), "Konzept Portal", "Offene Punkte zu NP-8801/1010 und NP-8801/1010.\n");
    // A parent's link wins over what the text mentions.
    let g = ctx().for_page(&db, deep).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis, g.confidence), ("NP-8802/2010", Basis::Link, Confidence::Medium));
    assert_eq!(g.reason, "Seite „Konzept Portal“ liegt unter „Projekt X“ (NP-8802/2010)");
    // Its own property wins over the parent's.
    db.save_page_content(deep, "---\nvorgang: NP-8801/1020\n---\nText\n").unwrap();
    let g = ctx().for_page(&db, deep).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.confidence), ("NP-8801/1020", Confidence::High));
    // Remembered from a proposal: wins over the property, until the property changes.
    remember(&db, "page", &deep.to_string(), Some(deep), np2, Some("2010"), None, t(24, 12, 0)).unwrap();
    let g = ctx().for_page(&db, deep).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis), ("NP-8802/2010", Basis::Learned));
    db.save_page_content(deep, "---\nvorgang: NP-8801/1010\n---\nText\n").unwrap();
    assert_eq!(ctx().for_page(&db, deep).unwrap().unwrap().reference, "NP-8801/1010");

    // Without any link: what the text mentions, then history, then similarity.
    let loose = page(&db, None, "Lose Notiz", "Siehe NP-8801/1010, später NP-8801/1020 und nochmal NP-8801/1010.\n");
    let g = ctx().for_page(&db, loose).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis, g.confidence), ("NP-8801/1010", Basis::Link, Confidence::Medium));
    let tagged = page(&db, None, "Getaggt", "Stand #np-8802\n");
    assert_eq!(ctx().for_page(&db, tagged).unwrap().unwrap().reference, "NP-8802");
    let hist = page(&db, None, "Mapping Materialstamm", "nur Text\n");
    let e = book(&db, np, Some("1020"), t(14, 9, 0), 60, "irgendwas");
    db.conn().execute("UPDATE time_entries SET page_id = ?2 WHERE id = ?1", params![e.id, hist]).unwrap();
    let g = ctx().for_page(&db, hist).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis), ("NP-8801/1020", Basis::History));
    assert_eq!(g.reason, "am 14.09. von „Mapping Materialstamm“ auf NP-8801/1020 gebucht");
    assert_eq!(g.leistungsart.as_deref(), Some("DEV"), "the Leistungsart of that booking");
    let similar = page(&db, None, "Portal-Konzept Workshop", "nur Text\n");
    let g = ctx().for_page(&db, similar).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis, g.confidence), ("NP-8801/1030", Basis::Similar, Confidence::Low));
    assert_eq!(g.reason, "ähnlich wie „Portal Konzept“ (NP-8801/1030)");
    let nothing = page(&db, None, "Mittagessen", "nur Text\n");
    assert_eq!(ctx().for_page(&db, nothing).unwrap(), None);
}

#[test]
fn wbs_resolution_order_for_meetings_and_focus() {
    let Fx { db, np, np2 } = setup();
    let ctx = || WbsContext::load(&db, t(28, 12, 0), &Zone::Utc).unwrap();
    let series = [
        event("jf", "2026-09-14T08:00:00Z", t(14, 8, 0), 60, "Jour fixe Kunde X"),
        event("jf", "2026-09-21T08:00:00Z", t(21, 8, 0), 60, "Jour fixe Kunde X"),
        event("jf", "2026-09-28T08:00:00Z", t(28, 8, 0), 60, "Jour fixe Kunde X"),
    ];
    let other = [event("s", "", t(22, 9, 0), 30, "Schulung planen"), event("n", "", t(22, 10, 0), 30, "Lenkungskreis")];
    db.calendar_replace(OUTLOOK, t(1, 0, 0), t(30, 0, 0), &[&series[..], &other[..]].concat()).unwrap();
    let ev = |uid: &str, inst: &str| db.calendar_event(&event_key(OUTLOOK, uid, inst)).unwrap();
    // Nothing known: similarity (Schulung → Key-User-Schulung), else nothing.
    let g = ctx().for_event(&db, &ev("s", "")).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis), ("NP-8802/2010", Basis::Similar));
    assert_eq!(ctx().for_event(&db, &ev("jf", "2026-09-21T08:00:00Z")).unwrap(), None);
    // An entry described like the subject: history.
    book(&db, np, None, t(10, 9, 0), 60, "Lenkungskreis");
    let g = ctx().for_event(&db, &ev("n", "")).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis, g.confidence), ("NP-8801", Basis::History, Confidence::Medium));
    // The meeting note's `vorgang:` wins over history.
    let note = page(&db, None, "Lenkungskreis 22.09.2026", "---\nvorgang: NP-8802/2010\n---\n");
    db.conn()
        .execute(
            "INSERT INTO calendar_marks (key, note_page_id, updated_at) VALUES (?1, ?2, ?3)",
            params![event_key(OUTLOOK, "n", ""), note, ts(t(22, 0, 0))],
        )
        .unwrap();
    let g = ctx().for_event(&db, &ev("n", "")).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis), ("NP-8802/2010", Basis::Link));
    // Last week's appointment of the series was booked: „wie letzte Woche“.
    let e = book(&db, np, Some("1020"), t(14, 8, 0), 60, "Jour fixe");
    db.calendar_link_entry(&event_key(OUTLOOK, "jf", "2026-09-14T08:00:00Z"), e.id).unwrap();
    let g = ctx().for_event(&db, &ev("jf", "2026-09-21T08:00:00Z")).unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis, g.confidence), ("NP-8801/1020", Basis::Learned, Confidence::High));
    assert_eq!(g.reason, "wie letzte Woche (Serie): Jour fixe Kunde X");
    let g = ctx().for_event(&db, &ev("jf", "2026-09-28T08:00:00Z")).unwrap().unwrap();
    assert_eq!(g.reason, "wie am 14.09. (Serie): Jour fixe Kunde X");

    // Focus: its Vorgang, else a remembered goal, else a booking described alike, else similarity.
    let g = ctx().for_focus(&db, Some(np2), Some("2010"), "Folien").unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.confidence), ("NP-8802/2010", Confidence::High));
    assert_eq!(ctx().for_focus(&db, None, None, crate::focus::DEFAULT_GOAL).unwrap(), None);
    book(&db, np, Some("1010"), t(11, 9, 0), 30, "Folien");
    assert_eq!(ctx().for_focus(&db, None, None, "Folien").unwrap().unwrap().basis, Basis::History);
    remember(&db, "text", "folien", None, np2, Some("2010"), None, t(24, 0, 0)).unwrap();
    let g = ctx().for_focus(&db, None, None, "Folien").unwrap().unwrap();
    assert_eq!((g.reference.as_str(), g.basis), ("NP-8802/2010", Basis::Learned));
}

#[test]
fn applying_books_drafts_links_sources_and_learns() {
    let Fx { db, np, np2 } = setup();
    let portal = page(&db, None, "Konzept Portal", "---\nvorgang: NP-8801/1030\n---\n");
    db.calendar_replace(
        OUTLOOK,
        t(1, 0, 0),
        t(30, 0, 0),
        &[
            event("jf", "2026-09-21T08:00:00Z", t(21, 8, 0), 60, "Jour fixe"),
            event("jf", "2026-09-28T08:00:00Z", t(28, 8, 0), 60, "Jour fixe"),
        ],
    )
    .unwrap();
    let f = focus(&db, None, None, "Folien bauen", t(21, 13, 0), 50);
    edited(&db, portal, t(21, 10, 50), 40);
    let w = week(&db, t(25, 16, 0));
    assert_eq!(w.proposals.len(), 3);
    let accept = |p: &Proposal, np: i64, v: &str, changed: bool| Accepted {
        start: p.start,
        minutes: p.minutes,
        text: p.text.clone(),
        netzplan_id: np,
        vorgang_nr: Some(v.into()),
        leistungsart: None,
        sources: p.sources.clone(),
        wbs_changed: changed,
        original_text: p.text.clone(),
    };
    // The page's WBS changed by the user, the meeting and focus given one.
    let items = vec![
        accept(&w.proposals[0], np2, "2010", true),
        accept(&w.proposals[1], np2, "2010", true),
        Accepted { text: "Folien für Schulung".into(), ..accept(&w.proposals[2], np, "1010", true) },
    ];
    // One bad item: nothing is booked.
    let mut bad = items.clone();
    bad[2].vorgang_nr = Some("9999".into());
    assert!(apply(&db, &bad, t(25, 16, 0), &Thresholds::default()).is_err());
    assert!(db.list_time_entries(&EntryFilter::default()).unwrap().is_empty());
    assert_eq!(db.calendar_event(&event_key(OUTLOOK, "jf", "2026-09-21T08:00:00Z")).unwrap().entry_id, None);

    let out = apply(&db, &items, t(25, 16, 0), &Thresholds::default()).unwrap();
    assert_eq!(out.entry_ids.len(), 3);
    let entries = db.list_time_entries(&EntryFilter::default()).unwrap();
    assert!(entries.iter().all(|r| r.entry.status_flag == StatusFlag::Draft && r.entry.source == EntrySource::Auto));
    let page_entry = entries.iter().find(|r| r.entry.description == "Konzept Portal").unwrap();
    assert_eq!((page_entry.entry.page_id, page_entry.entry.vorgang_nr.as_deref()), (Some(portal), Some("2010")));
    assert_eq!(
        db.calendar_event(&event_key(OUTLOOK, "jf", "2026-09-21T08:00:00Z")).unwrap().entry_id,
        Some(out.entry_ids[0])
    );
    let linked: Option<i64> =
        db.conn().query_row("SELECT entry_id FROM focus_sessions WHERE id = ?1", [f], |r| r.get(0)).unwrap();
    assert_eq!(linked, Some(out.entry_ids[2]));
    assert_eq!(
        entries.iter().find(|r| r.entry.id == out.entry_ids[2]).unwrap().entry.description,
        "Folien für Schulung"
    );

    // The same week again: everything is booked.
    assert!(week(&db, t(25, 16, 0)).proposals.is_empty());
    // Next week the page and the series come with the chosen WBS, the goal as well.
    // Edited right after the meeting: one block with it.
    edited(&db, portal, t(28, 9, 50), 40);
    focus(&db, None, None, "Folien bauen", t(28, 13, 0), 30);
    let next = propose(
        &db,
        NaiveDate::from_ymd_opt(2026, 9, 28).unwrap(),
        t(28, 16, 0),
        &Zone::Utc,
        &ProposeOptions::default(),
    )
    .unwrap();
    let refs: Vec<(&str, Option<&str>, Basis)> = next
        .proposals
        .iter()
        .map(|p| (p.text.as_str(), p.wbs.as_ref().map(|w| w.reference.as_str()), p.wbs.as_ref().unwrap().basis))
        .collect();
    assert_eq!(
        refs,
        [
            ("Jour fixe; Konzept Portal", Some("NP-8802/2010"), Basis::Learned),
            ("Folien bauen", Some("NP-8801/1010"), Basis::Learned),
        ]
    );
    assert_eq!(next.proposals[0].reason, "wie letzte Woche (Serie): Jour fixe");
}

#[test]
fn a_week_across_the_clock_change() {
    let Fx { db, np, .. } = setup();
    let berlin = Zone::named("Europe/Berlin").unwrap();
    // Sunday 29.03.2026 has 23 hours; Monday 30.03. is summer time (UTC+2).
    let mut s = db.load_settings().unwrap();
    s.workdays = vec![1, 2, 3, 4, 5, 7];
    db.save_settings(&s).unwrap();
    focus(&db, Some(np), Some("1020"), "Sonntag", Utc.with_ymd_and_hms(2026, 3, 29, 8, 0, 0).unwrap(), 60);
    focus(&db, Some(np), Some("1010"), "Samstag", Utc.with_ymd_and_hms(2026, 3, 28, 22, 30, 0).unwrap(), 60);
    let w = propose(
        &db,
        NaiveDate::from_ymd_opt(2026, 3, 23).unwrap(),
        Utc.with_ymd_and_hms(2026, 4, 1, 12, 0, 0).unwrap(),
        &berlin,
        &ProposeOptions::default(),
    )
    .unwrap();
    let got: Vec<(String, String, i64)> = w
        .proposals
        .iter()
        .map(|p| (p.date.to_string(), berlin.to_wall(p.start).format("%H:%M").to_string(), p.minutes))
        .collect();
    // Saturday 23:30–00:30 local is cut at midnight (the next week is another proposal).
    assert_eq!(
        got,
        [
            ("2026-03-28".into(), "23:30".into(), 30),
            ("2026-03-29".into(), "00:00".into(), 30),
            ("2026-03-29".into(), "10:00".into(), 60)
        ]
    );
    assert_eq!(w.days[6].target_minutes, 480);
    assert_eq!(w.days[6].gap_minutes, 480 - 90);
}

#[test]
fn the_reminder_comes_on_the_last_workday_afternoon_once_a_week() {
    let s = crate::settings::Settings::default();
    let fri = |h: u32| NaiveDate::from_ymd_opt(2026, 9, 25).unwrap().and_hms_opt(h, 0, 0).unwrap();
    let open =
        [(NaiveDate::from_ymd_opt(2026, 9, 21).unwrap(), 150), (NaiveDate::from_ymd_opt(2026, 9, 23).unwrap(), 60)];
    assert_eq!(
        week_reminder(fri(15), &s, &open, None).as_deref(),
        Some("Noch offen: Mo 2,5 h, Mi 1 h. Annalo schlägt die Buchungen aus Terminen, Fokus und Seiten vor.")
    );
    assert_eq!(week_reminder(fri(13), &s, &open, None), None, "before 14:00");
    assert_eq!(week_reminder(fri(15), &s, &[], None), None, "nothing open");
    assert_eq!(week_reminder(fri(15), &s, &open, Some("2026-W39")), None, "already this week");
    assert!(week_reminder(fri(15), &s, &open, Some("2026-W38")).is_some());
    let thu = NaiveDate::from_ymd_opt(2026, 9, 24).unwrap().and_hms_opt(15, 0, 0).unwrap();
    assert_eq!(week_reminder(thu, &s, &open, None), None, "not the last workday");
    let mut four = s.clone();
    four.workdays = vec![1, 2, 3, 4];
    assert!(week_reminder(thu, &four, &open, None).is_some());
    let mut off = s.clone();
    off.notifications.week_proposal = false;
    assert_eq!(week_reminder(fri(15), &off, &open, None), None);
    let mut quiet = s;
    quiet.notifications.quiet_hours = true;
    quiet.notifications.quiet_from = "14:30".into();
    quiet.notifications.quiet_to = "18:00".into();
    assert_eq!(week_reminder(fri(15), &quiet, &open, None), None, "quiet hours");
}

#[test]
fn open_days_are_the_earlier_workdays_below_the_target() {
    let Fx { db, np, .. } = setup();
    book(&db, np, None, t(21, 8, 0), 330, "Mo");
    book(&db, np, None, t(22, 8, 0), 480, "Di");
    // Friday: Monday misses 2,5 h, Wednesday and Thursday everything; Friday itself does not count.
    let open = open_days(&db, t(25, 15, 0), &Zone::Utc).unwrap();
    let days: Vec<(u32, i64)> = open.iter().map(|(d, m)| (d.day(), *m)).collect();
    assert_eq!(days, [(21, 150), (23, 480), (24, 480)]);
    assert_eq!(week_key(NaiveDate::from_ymd_opt(2026, 9, 25).unwrap()), "2026-W39");
}
