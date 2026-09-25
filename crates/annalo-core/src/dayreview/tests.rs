use super::*;
use crate::ai::provider::AiProvider;
use crate::calsync::NewEvent;
use crate::feed::NewActivity;
use crate::model::{EntrySource, NewTimeEntry};
use chrono::FixedOffset;
use chrono_tz::Europe::Berlin;

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

/// A wall-clock time in Berlin as UTC.
fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Berlin.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap().with_timezone(&Utc)
}

fn opts(now: DateTime<Utc>) -> ReviewOptions {
    ReviewOptions { daily_target_hours: 8.0, workdays: vec![1, 2, 3, 4, 5], sources: None, now }
}

fn book(db: &Database, np: i64, vorgang: Option<&str>, start: DateTime<Utc>, minutes: i64, text: &str) -> i64 {
    db.insert_time_entry(&NewTimeEntry {
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

/// A page created at `at` (the journal's creation event moved there).
fn page_at(db: &Database, title: &str, at: DateTime<Utc>) -> i64 {
    let p = db.create_page(None, title, None).unwrap();
    db.conn()
        .execute("UPDATE activity SET at = ?2 WHERE page_id = ?1 AND kind = 'page_created'", params![p.id, ts(at)])
        .unwrap();
    db.conn()
        .execute("UPDATE pages SET created_at = ?2, updated_at = ?2 WHERE id = ?1", params![p.id, ts(at)])
        .unwrap();
    p.id
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

#[test]
fn an_empty_day_has_the_target_and_nothing_else() {
    let db = Database::open_in_memory().unwrap();
    let now = berlin(2026, 9, 25, 18, 0);
    let r = day_review(&db, day(2026, 9, 24), &Berlin, &opts(now)).unwrap();
    assert!(r.is_empty());
    assert_eq!((r.time.workday, r.time.target_minutes, r.time.missing_minutes), (true, 480, 480));
    assert_eq!(r.daily_note_id, None);
    assert!(r.time.gaps.is_empty() && r.time.items.is_empty());
    // A Saturday has no target.
    let sat = day_review(&db, day(2026, 9, 26), &Berlin, &opts(now)).unwrap();
    assert_eq!((sat.time.workday, sat.time.target_minutes, sat.time.missing_minutes), (false, 0, 0));
    assert!(describe(&sat, &Berlin).contains("nichts aufgezeichnet"));
}

#[test]
fn a_full_day_on_the_long_dst_day() {
    // 25 October 2026: clocks go back in Berlin, the day has 25 hours.
    let (db, np) = crate::feed::seeded();
    let date = day(2026, 10, 25);
    let now = berlin(2026, 10, 25, 14, 0);
    let r0 = day_review(&db, date, &Berlin, &opts(now)).unwrap();
    assert_eq!((r0.to - r0.from).num_hours(), 25);
    assert_eq!(r0.from, Utc.with_ymd_and_hms(2026, 10, 24, 22, 0, 0).unwrap());
    // A Sunday: no target.
    assert_eq!(r0.time.target_minutes, 0);

    // Pages: created just after midnight (still the 24th in UTC), edited late in the evening;
    // an edit after midnight belongs to the next day.
    let konzept = page_at(&db, "Konzept Portal", berlin(2026, 10, 25, 0, 30));
    db.save_page_content_at(konzept, "Erste Gedanken zum Portal", berlin(2026, 10, 25, 0, 35)).unwrap();
    db.save_page_content_at(konzept, "Erste Gedanken zum Portal und mehr", berlin(2026, 10, 25, 0, 40)).unwrap();
    db.save_page_content_at(
        konzept,
        "Erste Gedanken zum Portal und mehr\n\n- [ ] Angebot schreiben due:2026-10-26\n- [ ] Review",
        berlin(2026, 10, 25, 23, 30),
    )
    .unwrap();
    let later = page_at(&db, "Morgen", berlin(2026, 10, 26, 0, 10));

    // Tasks: one checked off that day, one open and overdue, one due that day.
    let tasks = page_at(&db, "Aufgaben", berlin(2026, 10, 20, 9, 0));
    db.save_page_content_at(
        tasks,
        "- [ ] Rechnung prüfen\n- [ ] Alt due:2026-10-20\n- [ ] Heute fällig due:2026-10-25",
        berlin(2026, 10, 20, 9, 5),
    )
    .unwrap();
    db.save_page_content_at(
        tasks,
        "- [x] Rechnung prüfen\n- [ ] Alt due:2026-10-20\n- [ ] Heute fällig due:2026-10-25",
        berlin(2026, 10, 25, 11, 0),
    )
    .unwrap();

    // Bookings: 08:00–09:00 and 09:00–10:30 (no gap), 13:00–13:30 (gap of 2:30 h), one at
    // 00:30 in the repeated hour, and a running timer.
    book(&db, np.id, Some("1020"), berlin(2026, 10, 25, 8, 0), 60, "Jour fixe");
    book(&db, np.id, Some("1020"), berlin(2026, 10, 25, 9, 0), 90, "Konzept");
    book(&db, np.id, None, berlin(2026, 10, 25, 13, 0), 30, "Abstimmung");
    let repeated = Utc.with_ymd_and_hms(2026, 10, 25, 1, 30, 0).unwrap(); // 02:30 CET, the second time
    book(&db, np.id, Some("1020"), repeated, 15, "Nachtarbeit");
    book(&db, np.id, Some("1020"), berlin(2026, 10, 26, 0, 30), 45, "Nächster Tag");
    db.start_timer(np.id, Some("1020"), None, "läuft", now - Duration::minutes(25)).unwrap();

    // Meetings: booked by its subject, open, marked „nicht buchen“, still to come, all-day.
    db.calendar_replace(
        "ics:a",
        berlin(2026, 10, 25, 0, 0),
        berlin(2026, 10, 26, 0, 0),
        &[
            event("m1", berlin(2026, 10, 25, 8, 0), 60, "Jour fixe"),
            event("m2", berlin(2026, 10, 25, 11, 0), 30, "Kundentermin"),
            event("m3", berlin(2026, 10, 25, 12, 0), 30, "Mittagsrunde"),
            event("m4", berlin(2026, 10, 25, 16, 0), 60, "Retro"),
            NewEvent {
                all_day: true,
                start: berlin(2026, 10, 25, 0, 0),
                end: berlin(2026, 10, 26, 0, 0),
                ..event("m5", berlin(2026, 10, 25, 0, 0), 0, "Release")
            },
        ],
    )
    .unwrap();
    db.calendar_set_skip(&crate::calsync::event_key("ics:a", "m3", ""), true).unwrap();

    // Focus sessions and a file.
    for (start, minutes, status, entry) in
        [(berlin(2026, 10, 25, 9, 0), 25, "done", Some(1)), (berlin(2026, 10, 25, 10, 0), 10, "aborted", None)]
    {
        db.conn()
            .execute(
                "INSERT INTO focus_sessions (netzplan_id, vorgang_nr, reference, goal, started_at, planned_minutes, status,
                   worked_minutes, entry_id) VALUES (?1, '1020', 'NP-8801/1020', 'Konzept', ?2, 25, ?3, ?4, ?5)",
                params![np.id, ts(start), status, minutes, entry],
            )
            .unwrap();
    }
    db.feed_file("skizze.png", berlin(2026, 10, 25, 15, 0)).unwrap();
    db.feed_file("gestern.png", berlin(2026, 10, 24, 23, 59)).unwrap();

    let r = day_review(&db, date, &Berlin, &opts(now)).unwrap();
    assert!(!r.is_empty());

    // Pages: the concept page (created) and the task page; not tomorrow's.
    let titles: Vec<&str> = r.pages.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, ["Konzept Portal", "Aufgaben"], "latest first");
    assert!(r.pages.iter().all(|p| p.page_id != Some(later)));
    let k = &r.pages[0];
    assert!(k.created && !k.gone && !k.daily);
    assert_eq!(k.edits, 3, "two edits merged into the creation hour, one in the evening");
    assert_eq!(k.minutes, 6);
    assert_eq!(k.word_delta, Some(10), "created that day: all words are new");
    assert_eq!(r.pages[1].word_delta, Some(0), "checking a task off adds no word");

    // Time: per WBS, the repeated hour counts, the next day does not.
    assert_eq!(r.time.booked_minutes, 60 + 90 + 30 + 15);
    assert_eq!(r.time.running_minutes, 25);
    assert_eq!(r.time.items.len(), 2);
    assert_eq!((r.time.items[0].label.as_str(), r.time.items[0].minutes), ("NP-8801/1020", 165));
    assert_eq!(r.time.items[0].descriptions, ["Nachtarbeit", "Jour fixe", "Konzept"]);
    assert_eq!(r.time.items[0].title, "Schnittstellen");
    assert_eq!((r.time.items[1].label.as_str(), r.time.items[1].entries), ("NP-8801", 1));
    // Gaps: 02:45 (CET) to 08:00 and 10:30 to 13:00.
    let gaps: Vec<i64> = r.time.gaps.iter().map(|g| g.minutes).collect();
    assert_eq!(gaps, [5 * 60 + 15, 150]);
    assert_eq!(r.time.gaps[1].start, berlin(2026, 10, 25, 10, 30));

    // Tasks.
    let done: Vec<&str> = r.tasks.done.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(done, ["Rechnung prüfen"]);
    assert_eq!(r.tasks.done[0].page_id, Some(tasks));
    let added: Vec<&str> = r.tasks.added.iter().map(|t| t.text.as_str()).collect();
    assert!(added.contains(&"Angebot schreiben") && added.contains(&"Review"), "{added:?}");
    assert!(!added.contains(&"Rechnung prüfen"), "added on the 20th");
    assert_eq!(r.tasks.due.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["Heute fällig"]);
    assert_eq!(r.tasks.overdue.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["Alt"]);
    assert_eq!((r.tasks.done_total, r.tasks.due_total, r.tasks.overdue_total), (1, 1, 1));

    // Meetings with their state.
    let states: Vec<(&str, &str)> = r.meetings.iter().map(|m| (m.title.as_str(), m.state.as_str())).collect();
    assert_eq!(
        states,
        [
            ("Release", "free"),
            ("Jour fixe", "booked"),
            ("Kundentermin", "open"),
            ("Mittagsrunde", "skipped"),
            ("Retro", "upcoming")
        ]
    );
    assert!(r.meetings[1].entry_id.is_some());
    assert_eq!((r.meetings[0].minutes, r.meetings[2].minutes), (0, 30));

    // Focus and files.
    assert_eq!((r.focus.sessions.len(), r.focus.minutes), (2, 35));
    assert_eq!(r.files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["skizze.png"]);
    assert_eq!(r.files[0].kind, "Bild");

    // The text for the model: numbers and names, the open meeting, the gap.
    let text = describe(&r, &Berlin);
    assert!(text.starts_with("Tag: Sonntag, 25.10.2026\n"), "{text}");
    assert!(text.contains("Gebucht: 3:15 h (kein Arbeitstag)"), "{text}");
    assert!(text.contains("Kundentermin (noch nicht gebucht)"), "{text}");
    assert!(text.contains("Lücke ohne Buchung: 10:30–13:00"), "{text}");
    assert!(text.contains("- Alt (Seite Aufgaben, fällig 2026-10-20)"), "{text}");
    assert!(!text.contains("Erste Gedanken"), "no page contents");
    let m = summary_messages(&r, &Berlin);
    assert_eq!(m.len(), 2);
    assert!(m[0].content.as_deref().unwrap().contains("Offen für morgen"));
}

#[test]
fn the_short_dst_day_and_other_offsets() {
    // 29 March 2026: 23 hours in Berlin.
    let (db, np) = crate::feed::seeded();
    let date = day(2026, 3, 29);
    book(&db, np.id, None, berlin(2026, 3, 29, 23, 30), 20, "spät");
    book(&db, np.id, None, berlin(2026, 3, 30, 0, 0), 20, "Montag");
    book(&db, np.id, None, berlin(2026, 3, 28, 23, 59), 20, "Samstag");
    let r = day_review(&db, date, &Berlin, &opts(berlin(2026, 4, 1, 12, 0))).unwrap();
    assert_eq!((r.to - r.from).num_hours(), 23);
    assert_eq!(r.time.booked_minutes, 20);
    assert_eq!(r.time.entries[0].description, "spät");
    // The same instants seen from UTC+14: other days.
    let kiribati = FixedOffset::east_opt(14 * 3600).unwrap();
    let r = day_review(&db, day(2026, 3, 30), &kiribati, &opts(berlin(2026, 4, 1, 12, 0))).unwrap();
    assert_eq!(r.time.entries.iter().map(|e| e.description.as_str()).collect::<Vec<_>>(), ["spät", "Montag"]);
}

#[test]
fn word_delta_from_snapshots_and_the_daily_note() {
    let db = Database::open_in_memory().unwrap();
    let date = day(2026, 9, 24);
    let note = db.daily_note(date).unwrap();
    let p = page_at(&db, "Protokoll", berlin(2026, 9, 1, 9, 0));
    db.conn()
        .execute(
            "UPDATE pages SET content = 'eins zwei drei', updated_at = ?2 WHERE id = ?1",
            params![p, ts(berlin(2026, 9, 1, 9, 0))],
        )
        .unwrap();
    // The first save of the day snapshots the content it replaces.
    db.save_page_content_at(p, "eins zwei drei vier fünf", berlin(2026, 9, 24, 10, 0)).unwrap();
    db.save_page_content_at(p, "eins zwei drei vier fünf sechs", berlin(2026, 9, 24, 10, 30)).unwrap();
    let r = day_review(&db, date, &Berlin, &opts(berlin(2026, 9, 24, 18, 0))).unwrap();
    let protokoll = r.pages.iter().find(|x| x.page_id == Some(p)).unwrap();
    assert_eq!(protokoll.word_delta, Some(3));
    assert_eq!(r.daily_note_id, Some(note.id));
    // The next day's first save snapshots the end of this day; the page moved on since.
    db.save_page_content_at(p, "eins", berlin(2026, 9, 25, 8, 0)).unwrap();
    let r = day_review(&db, date, &Berlin, &opts(berlin(2026, 9, 25, 18, 0))).unwrap();
    assert_eq!(r.pages.iter().find(|x| x.page_id == Some(p)).unwrap().word_delta, Some(3));
    // A trashed page is listed, not clickable.
    db.trash_page(p).unwrap();
    let r = day_review(&db, date, &Berlin, &opts(berlin(2026, 9, 25, 18, 0))).unwrap();
    let gone = r.pages.iter().find(|x| x.page_id == Some(p)).unwrap();
    assert!(gone.gone);
    assert_eq!(gone.title, "Protokoll");
}

#[test]
fn words_skip_front_matter_and_symbols() {
    assert_eq!(word_count("---\ntags: [a, b]\n---\n# Titel\n\nZwei Wörter - und ein 2. Satz"), 7);
    assert_eq!(word_count(""), 0);
    assert_eq!(word_count("- [ ] Aufgabe\n- [x] Erledigt"), 2);
}

#[test]
fn gaps_merge_overlapping_bookings() {
    let t = |h: u32, m: u32| Utc.with_ymd_and_hms(2026, 9, 24, h, m, 0).unwrap();
    let g = gaps(vec![(t(13, 0), t(14, 0)), (t(8, 0), t(10, 0)), (t(9, 0), t(11, 0)), (t(11, 20), t(12, 0))]);
    assert_eq!(g.len(), 1);
    assert_eq!((g[0].start, g[0].end, g[0].minutes), (t(12, 0), t(13, 0), 60));
    assert!(gaps(vec![]).is_empty());
}

#[test]
fn only_providers_marked_local_are_candidates() {
    let cloud = AiProvider { id: "cloud".into(), name: "Cloud".into(), ..Default::default() };
    let ollama = AiProvider::ollama("ollama", "http://localhost:11434");
    let mut config =
        RouterConfig { local_provider: "cloud".into(), local_model: "cloud-small".into(), ..Default::default() };
    let models = HashMap::from([
        ("cloud".to_owned(), vec!["cloud-small".to_owned()]),
        ("ollama".to_owned(), vec!["nomic-embed-text".to_owned(), "llama3.2:latest".to_owned()]),
    ]);
    // Only a cloud provider: nothing, and the reason says why.
    let only_cloud = Catalog::new(vec![cloud.clone()], models.clone());
    assert!(local_candidates(&config, &only_cloud).is_empty());
    assert!(no_local_reason(&only_cloud).unwrap().contains("lokal"));
    // The local tier on the cloud provider does not count; the Ollama chat model does.
    let both = Catalog::new(vec![cloud.clone(), ollama.clone()], models.clone());
    assert_eq!(no_local_reason(&both), None);
    assert_eq!(local_candidates(&config, &both), [ModelRef::new("ollama", "llama3.2:latest")]);
    // The local tier's model on a local provider comes first; hand-added models follow.
    config.local_provider = "ollama".into();
    config.local_model = "qwen3:8b".into();
    let mut ollama2 = ollama.clone();
    ollama2.models = vec!["mistral".into()];
    let listed = HashMap::from([("ollama".to_owned(), vec![])]);
    let c = Catalog::new(vec![cloud, ollama2], listed);
    assert_eq!(
        local_candidates(&config, &c),
        [ModelRef::new("ollama", "qwen3:8b"), ModelRef::new("ollama", "mistral")]
    );
    // A switched-off local provider is none.
    let mut off = ollama;
    off.enabled = false;
    assert!(no_local_reason(&Catalog::new(vec![off], models)).is_some());
}

#[test]
fn a_deleted_page_keeps_its_old_title() {
    let db = Database::open_in_memory().unwrap();
    let at = berlin(2026, 9, 24, 9, 0);
    db.record_activity(&NewActivity { kind: "page_edited", title: "Weg".into(), amount: 5, ..Default::default() }, at)
        .unwrap();
    let r = day_review(&db, day(2026, 9, 24), &Berlin, &opts(at)).unwrap();
    assert_eq!(r.pages.len(), 1);
    assert!(r.pages[0].gone && r.pages[0].page_id.is_none());
    assert_eq!(r.pages[0].title, "Weg");
}

#[test]
fn the_reminder_is_off_by_default_and_once_a_workday() {
    let mut s = crate::settings::Settings::default();
    let at = |d: u32, h: u32, m: u32| day(2026, 9, d).and_hms_opt(h, m, 0).unwrap();
    assert!(!review_reminder(at(24, 18, 0), &s, None), "off by default");
    s.notifications.day_review = true;
    assert!(!review_reminder(at(24, 17, 29), &s, None));
    assert!(review_reminder(at(24, 17, 30), &s, None));
    assert!(!review_reminder(at(24, 19, 0), &s, Some(day(2026, 9, 24))), "once a day");
    assert!(review_reminder(at(25, 19, 0), &s, Some(day(2026, 9, 24))));
    assert!(!review_reminder(at(26, 19, 0), &s, None), "Saturday");
    s.notifications.quiet_hours = true;
    s.notifications.quiet_from = "17:00".into();
    assert!(!review_reminder(at(24, 18, 0), &s, None), "quiet hours");

    let db = Database::open_in_memory().unwrap();
    let r = day_review(&db, day(2026, 9, 24), &Berlin, &opts(berlin(2026, 9, 24, 18, 0))).unwrap();
    assert_eq!(reminder_body(&r), "0 h gebucht");
}
