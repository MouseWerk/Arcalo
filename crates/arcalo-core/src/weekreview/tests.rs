use super::*;
use crate::calsync::{Busy, NewEvent};
use crate::model::{EntrySource, NewTimeEntry};
use crate::prefs::Language;
use crate::timeblocks::NewBlock;
use crate::worktime::{Absence, AbsenceKind};
use chrono_tz::Europe::Berlin;

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

/// A wall-clock time in Berlin as UTC.
fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Berlin.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap().with_timezone(&Utc)
}

fn settings() -> Settings {
    Settings { daily_target_hours: 8.0, workdays: vec![1, 2, 3, 4, 5], ..Settings::default() }
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
fn an_empty_week_has_its_targets_and_nothing_else() {
    let db = Database::open_in_memory().unwrap();
    let now = berlin(2026, 10, 20, 12, 0);
    // Any day of the week gives the same week.
    let r = week_review(&db, day(2026, 10, 15), &Berlin, &settings(), None, now).unwrap();
    assert_eq!((r.monday, r.sunday, r.week, r.year), (day(2026, 10, 12), day(2026, 10, 18), 42, 2026));
    assert_eq!(r, week_review(&db, day(2026, 10, 18), &Berlin, &settings(), None, now).unwrap());
    assert!(r.is_empty());
    assert_eq!(r.days.len(), 7);
    let targets: Vec<i64> = r.days.iter().map(|d| d.target_minutes).collect();
    assert_eq!(targets, [480, 480, 480, 480, 480, 0, 0]);
    assert_eq!((r.time.target_minutes, r.time.target_to_date, r.time.missing_minutes), (2400, 2400, 2400));
    assert!(r.time.items.is_empty() && r.tasks.done.is_empty() && r.meetings.is_empty());
    assert_eq!(r.report_page_id, None);
    assert!(describe(&r, &Berlin).contains("nichts aufgezeichnet"));
    let md = report_markdown(&r, &Berlin, None);
    assert!(md.contains("| **Woche** | **0 h** | **40 h** | **−40 h** |"), "{md}");
    assert!(md.contains("Keine Aufgaben") && md.contains("Keine Termine") && md.contains("Keine Seiten"));

    // The current week: days still ahead have their target but nothing missing.
    let now = berlin(2026, 10, 14, 12, 0);
    let r = week_review(&db, day(2026, 10, 14), &Berlin, &settings(), None, now).unwrap();
    let future: Vec<bool> = r.days.iter().map(|d| d.future).collect();
    assert_eq!(future, [false, false, false, true, true, true, true]);
    assert_eq!((r.time.target_minutes, r.time.target_to_date, r.time.missing_minutes), (2400, 1440, 1440));
}

#[test]
fn the_week_with_the_dst_change_and_its_bookings() {
    // 25 October 2026: clocks go back in Berlin, the week has 169 hours.
    let (db, np) = crate::feed::seeded();
    let now = berlin(2026, 10, 27, 9, 0);
    book(&db, np.id, Some("1020"), berlin(2026, 10, 19, 0, 15), 60, "Montag früh");
    book(&db, np.id, Some("1020"), berlin(2026, 10, 19, 9, 0), 120, "Konzept");
    book(&db, np.id, Some("1020"), berlin(2026, 10, 19, 13, 0), 60, "Konzept");
    book(&db, np.id, None, berlin(2026, 10, 21, 8, 0), 240, "Abstimmung");
    // 02:30 CET on Sunday, the repeated hour.
    book(&db, np.id, Some("1020"), Utc.with_ymd_and_hms(2026, 10, 25, 1, 30, 0).unwrap(), 30, "Nachtarbeit");
    // Before and after the week: not in it.
    book(&db, np.id, Some("1020"), berlin(2026, 10, 18, 23, 30), 20, "Vorwoche");
    book(&db, np.id, Some("1020"), berlin(2026, 10, 26, 0, 10), 20, "Folgewoche");

    let r = week_review(&db, day(2026, 10, 22), &Berlin, &settings(), None, now).unwrap();
    assert_eq!((r.to - r.from).num_hours(), 169);
    assert_eq!(r.from, Utc.with_ymd_and_hms(2026, 10, 18, 22, 0, 0).unwrap());
    assert_eq!(r.to, Utc.with_ymd_and_hms(2026, 10, 25, 23, 0, 0).unwrap());
    let booked: Vec<i64> = r.days.iter().map(|d| d.booked_minutes).collect();
    assert_eq!(booked, [240, 0, 240, 0, 0, 0, 30]);
    assert_eq!(r.time.booked_minutes, 510);
    // Missing per day: 4 h Monday, 8 h Tuesday, 4 h Wednesday, 8 h Thursday and Friday.
    assert_eq!(r.time.missing_minutes, 240 + 480 + 240 + 480 + 480);
    // Monday's gap between 10:15 and 13:00 (00:15–01:15 and 09:00–11:00 leave 7:45 h too).
    assert_eq!(r.days[0].gaps.len(), 2);
    assert_eq!(r.time.gaps, 2);
    // Top Vorgänge: 1020 (3:30 h over two days), then the Netzplan itself.
    let items: Vec<(&str, i64, i64)> = r.time.items.iter().map(|w| (w.label.as_str(), w.minutes, w.entries)).collect();
    assert_eq!(items, [("NP-8801/1020", 270, 4), ("NP-8801", 240, 1)]);
    assert_eq!(r.time.items[0].descriptions, ["Montag früh", "Konzept", "Nachtarbeit"]);

    let md = report_markdown(&r, &Berlin, None);
    assert!(md.contains("| Mo 19.10. | 4 h | 8 h | −4 h |"), "{md}");
    assert!(
        md.contains(
            "**Unter dem Soll:** Mo 19.10. (4 h), Di 20.10. (8 h), Mi 21.10. (4 h), Do 22.10. (8 h), Fr 23.10. (8 h)"
        ),
        "{md}"
    );
    assert!(md.contains("| So 25.10. | 0,5 h | 0 h | +0,5 h |"), "{md}");
    assert!(md.contains("| NP-8801/1020 | Schnittstellen | 4,5 h |"), "{md}");
    assert!(md.contains("**Lücken ohne Buchung:** Mo 19.10. 01:15–09:00, Mo 19.10. 11:00–13:00"), "{md}");
    let text = describe(&r, &Berlin);
    assert!(text.contains("Gebucht: 8,5 h von 40 h Soll"), "{text}");
}

#[test]
fn holidays_absences_and_targets_per_weekday() {
    let db = Database::open_in_memory().unwrap();
    let mut s = settings();
    // Friday short, Saturday a little: the weekday targets replace the daily target.
    s.time.balance.weekday_hours = vec![8.0, 8.0, 8.0, 8.0, 5.0, 2.0, 0.0];
    s.time.balance.state = "BY".into();
    // 11–17 May 2026: Ascension Day on Thursday; vacation on Monday, half a day sick on Tuesday.
    db.absence_put(&Absence { date: day(2026, 5, 11), kind: AbsenceKind::Vacation, half: false, note: String::new() })
        .unwrap();
    db.absence_put(&Absence { date: day(2026, 5, 12), kind: AbsenceKind::Sick, half: true, note: String::new() })
        .unwrap();
    let r = week_review(&db, day(2026, 5, 11), &Berlin, &s, None, berlin(2026, 5, 20, 9, 0)).unwrap();
    let targets: Vec<i64> = r.days.iter().map(|d| d.target_minutes).collect();
    assert_eq!(targets, [0, 240, 480, 0, 300, 120, 0]);
    assert_eq!(r.time.target_minutes, 1140);
    assert_eq!(r.days[3].holiday.as_deref(), Some("Christi Himmelfahrt"));
    assert_eq!((r.days[0].absence.as_deref(), r.days[0].absence_half), (Some("vacation"), false));
    assert_eq!((r.days[1].absence.as_deref(), r.days[1].absence_half), (Some("sick"), true));
    // Days off are no gaps.
    assert_eq!((r.days[0].missing_minutes, r.days[3].missing_minutes), (0, 0));
    let md = report_markdown(&r, &Berlin, None);
    assert!(md.contains("| Do 14.05. (Christi Himmelfahrt) | 0 h | 0 h | 0 h |"), "{md}");
    assert!(md.contains("| Mo 11.05. (Urlaub) |"), "{md}");
    assert!(md.contains("| Di 12.05. (krank (halber Tag)) | 0 h | 4 h | −4 h |"), "{md}");
    // In English the holiday has its English name.
    crate::i18n::with_lang(Language::En, || {
        let r = week_review(&db, day(2026, 5, 11), &Berlin, &s, None, berlin(2026, 5, 20, 9, 0)).unwrap();
        assert_eq!(r.days[3].holiday.as_deref(), Some("Ascension Day"));
        let md = report_markdown(&r, &Berlin, None);
        assert!(md.contains("| Day | Booked | Target | Difference |"), "{md}");
        assert!(md.contains("| Thu 05/14 (Ascension Day) |"), "{md}");
    });
}

#[test]
fn repeating_tasks_count_per_occurrence_others_once() {
    let db = Database::open_in_memory().unwrap();
    let p = page_at(&db, "Routinen", berlin(2026, 10, 1, 9, 0));
    let save = |content: &str, at: DateTime<Utc>| db.save_page_content_at(p, content, at).unwrap();
    save(
        "- [ ] Standup-Notiz every:daily due:2026-10-05\n- [ ] Angebot\n- [ ] Alt due:2026-10-01\n- [ ] Diese Woche due:2026-10-09",
        berlin(2026, 10, 1, 9, 5),
    );
    // Monday: the routine done (its next occurrence added) and the offer.
    save(
        "- [x] Standup-Notiz every:daily due:2026-10-05\n- [ ] Standup-Notiz every:daily due:2026-10-06\n- [x] Angebot\n- [ ] Alt due:2026-10-01\n- [ ] Diese Woche due:2026-10-09",
        berlin(2026, 10, 5, 9, 0),
    );
    // Tuesday: the routine again; the offer unchecked …
    save(
        "- [x] Standup-Notiz every:daily due:2026-10-05\n- [x] Standup-Notiz every:daily due:2026-10-06\n- [ ] Standup-Notiz every:daily due:2026-10-07\n- [ ] Angebot\n- [ ] Alt due:2026-10-01\n- [ ] Diese Woche due:2026-10-09",
        berlin(2026, 10, 6, 9, 0),
    );
    // … and checked off again on Wednesday: one task.
    save(
        "- [x] Standup-Notiz every:daily due:2026-10-05\n- [x] Standup-Notiz every:daily due:2026-10-06\n- [ ] Standup-Notiz every:daily due:2026-10-07\n- [x] Angebot\n- [ ] Alt due:2026-10-01\n- [ ] Diese Woche due:2026-10-09",
        berlin(2026, 10, 7, 9, 0),
    );
    let r = week_review(&db, day(2026, 10, 5), &Berlin, &settings(), None, berlin(2026, 10, 12, 9, 0)).unwrap();
    let done: Vec<(&str, Option<NaiveDate>, bool)> =
        r.tasks.done.iter().map(|t| (t.text.as_str(), t.day, t.repeating)).collect();
    assert_eq!(
        done,
        [
            ("Standup-Notiz", Some(day(2026, 10, 5)), true),
            ("Standup-Notiz", Some(day(2026, 10, 6)), true),
            ("Angebot", Some(day(2026, 10, 7)), false),
        ]
    );
    assert_eq!(r.tasks.done_total, 3);
    // Still open: due in the week (the routine's next one, the Friday task), overdue before it.
    let open: Vec<&str> = r.tasks.open.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(open, ["Standup-Notiz", "Diese Woche"]);
    assert!(r.tasks.open[0].repeating);
    let overdue: Vec<&str> = r.tasks.overdue.iter().map(|t| t.text.as_str()).collect();
    assert_eq!(overdue, ["Alt"]);
    let md = report_markdown(&r, &Berlin, None);
    assert!(md.contains("**Erledigt (3)**\n\n- Standup-Notiz (Mo 05.10.) – [[Routinen]]"), "{md}");
    assert!(md.contains("- Diese Woche (fällig Fr 09.10.) – [[Routinen]]"), "{md}");
    assert!(!md.contains("- [ ]") && !md.contains("- [x]"), "the report adds no tasks: {md}");
}

#[test]
fn meetings_by_day_focus_blocks_and_pages() {
    let (db, np) = crate::feed::seeded();
    let now = berlin(2026, 10, 9, 18, 0);
    book(&db, np.id, Some("1020"), berlin(2026, 10, 5, 9, 0), 30, "Jour fixe");
    let mut private = event("m3", berlin(2026, 10, 6, 15, 0), 60, "Arzt");
    private.private = true;
    db.calendar_replace(
        "ics:a",
        berlin(2026, 10, 1, 0, 0),
        berlin(2026, 10, 20, 0, 0),
        &[
            event("m1", berlin(2026, 10, 5, 9, 0), 30, "Jour fixe"),
            event("m2", berlin(2026, 10, 6, 11, 0), 60, "Kundentermin"),
            private,
            // Over midnight: once, on its first day.
            event("m4", berlin(2026, 10, 7, 23, 0), 120, "Nachtwartung"),
            event("m5", berlin(2026, 10, 14, 9, 0), 30, "Nächste Woche"),
        ],
    )
    .unwrap();
    db.block_create(
        &NewBlock {
            title: "Konzept schreiben".into(),
            start: Some(berlin(2026, 10, 8, 10, 0)),
            end: Some(berlin(2026, 10, 8, 11, 30)),
            ..Default::default()
        },
        now,
        false,
    )
    .unwrap();
    let konzept = page_at(&db, "Konzept Portal", berlin(2026, 10, 5, 8, 0));
    db.save_page_content_at(konzept, "Erste Gedanken", berlin(2026, 10, 5, 8, 5)).unwrap();
    db.save_page_content_at(konzept, "Erste Gedanken zum Portal und mehr", berlin(2026, 10, 7, 14, 0)).unwrap();
    let alt = page_at(&db, "Alte Seite", berlin(2026, 9, 1, 8, 0));
    db.save_page_content_at(alt, "Nachtrag", berlin(2026, 10, 6, 10, 0)).unwrap();

    let r = week_review(&db, day(2026, 10, 7), &Berlin, &settings(), None, now).unwrap();
    let meetings: Vec<(NaiveDate, &str, &str)> =
        r.meetings.iter().map(|m| (m.day, m.meeting.title.as_str(), m.meeting.state.as_str())).collect();
    assert_eq!(
        meetings,
        [
            (day(2026, 10, 5), "Jour fixe", "booked"),
            (day(2026, 10, 6), "Kundentermin", "open"),
            (day(2026, 10, 6), "Arzt", "open"),
            (day(2026, 10, 7), "Nachtwartung", "open"),
        ]
    );
    assert_eq!(r.days.iter().map(|d| d.meetings).collect::<Vec<_>>(), [1, 2, 1, 1, 0, 0, 0]);
    assert_eq!(r.focus.blocks.len(), 1);
    assert_eq!((r.focus.planned_minutes, r.focus.blocks[0].booked), (90, false));
    // Pages merged over the days: the concept on two days, created that week.
    let pages: Vec<(&str, bool, i64)> = r.pages.iter().map(|p| (p.title.as_str(), p.created, p.days)).collect();
    assert_eq!(pages, [("Konzept Portal", true, 2), ("Alte Seite", false, 1)]);
    assert_eq!(r.pages[0].word_delta, Some(6));

    // The private meeting keeps the week on the local model and stays out of the text.
    let text = describe(&r, &Berlin);
    assert!(!text.contains("Arzt") && text.contains("(privater Termin)"), "{text}");
    assert!(is_private(&db, &r, &["#privat".to_owned()], &Berlin).unwrap());

    let md = report_markdown(&r, &Berlin, Some("Gute Woche.\n\n- [ ] Nachfassen\n# Ausblick"));
    assert!(md.starts_with("## Zusammenfassung\n\nGute Woche.\n\n- Nachfassen\n**Ausblick**"), "{md}");
    assert!(md.contains("**Mo 05.10.**\n\n- 09:00–09:30 Jour fixe (gebucht)\n\n**Di 06.10.**\n\n- 11:00–12:00 Kundentermin (nicht gebucht)"), "{md}");
    assert!(md.contains("- Do 08.10. 10:00–11:30 Konzept schreiben"), "{md}");
    assert!(md.contains("- [[Konzept Portal]] (neu, "), "{md}");

    // Without time tracking: no time part, meetings over are just over.
    let off = r.clone().without_time();
    assert_eq!(off.time, WeekTime::default());
    assert!(off.meetings.iter().all(|m| m.meeting.state == "done" && m.meeting.entry_id.is_none()));
    let md = report_markdown(&off, &Berlin, None);
    assert!(!md.contains("## Zeit") && !md.contains("Soll") && !md.contains("gebucht"), "{md}");
    assert!(!describe(&off, &Berlin).contains("Gebucht"));
    assert!(summary_messages(&off, &Berlin)[0].content.as_deref().unwrap().contains("Notizprogramm mit Kalender"));
}

#[test]
fn private_pages_keep_the_summary_local() {
    let db = Database::open_in_memory().unwrap();
    let p = page_at(&db, "Gehalt", berlin(2026, 10, 5, 8, 0));
    db.save_page_content_at(p, "Gehalt besprechen", berlin(2026, 10, 5, 9, 0)).unwrap();
    let markers = vec!["#privat".to_owned()];
    let r = week_review(&db, day(2026, 10, 5), &Berlin, &settings(), None, berlin(2026, 10, 9, 9, 0)).unwrap();
    assert!(!is_private(&db, &r, &markers, &Berlin).unwrap());
    db.save_page_content_at(p, "Gehalt besprechen #privat", berlin(2026, 10, 5, 10, 0)).unwrap();
    let r = week_review(&db, day(2026, 10, 5), &Berlin, &settings(), None, berlin(2026, 10, 9, 9, 0)).unwrap();
    assert!(is_private(&db, &r, &markers, &Berlin).unwrap());
}

#[test]
fn the_report_is_filed_and_written_again_in_place() {
    let db = Database::open_in_memory().unwrap();
    let monday = day(2026, 10, 5);
    let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    assert_eq!(report_title(monday), "Wochenbericht KW 41 2026");
    assert_eq!(range_label(monday), "05.10.–11.10.2026");
    assert_eq!(range_label(day(2026, 12, 28)), "28.12.2026–03.01.2027");
    // ISO week 53 of 2026 ends in 2027; week 1 of 2027 starts in it.
    assert_eq!(report_title(day(2026, 12, 28)), "Wochenbericht KW 53 2026");
    assert_eq!(report_title(day(2027, 1, 4)), "Wochenbericht KW 01 2027");

    let (page, created) = db.week_report_write(day(2026, 10, 8), "## Zeit\n\nerste Fassung", nine).unwrap();
    assert!(created);
    assert_eq!(page.title, "Wochenbericht KW 41 2026");
    assert_eq!(page.icon.as_deref(), Some(ICON));
    // Filed like a journal page: year and month folder of the week.
    let path = db.page_path(page.id).unwrap();
    assert!(path.ends_with(&format!("2026 / {}", crate::filing::month_folder(10, Language::De))), "{path}");
    let content = db.page_doc(page.id).unwrap().content;
    assert!(
        content.starts_with(
            "KW 41 · 05.10.–11.10.2026\n\n<!-- arcalo:auto -->\n\n## Zeit\n\nerste Fassung\n\n<!-- /arcalo:auto -->"
        ),
        "{content}"
    );
    assert!(content.contains("## Nächste Woche"));
    assert_eq!(db.week_report_page(monday).unwrap().map(|p| p.id), Some(page.id));

    // The user writes notes; saving again replaces only the generated part.
    let edited = content.replace("## Notizen\n\n", "## Notizen\n\nMeine Notiz\n");
    db.save_page_content(page.id, &edited).unwrap();
    let (again, created) = db.week_report_write(monday, "## Zeit\n\nzweite Fassung", nine).unwrap();
    assert!(!created);
    assert_eq!(again.id, page.id);
    let content = db.page_doc(page.id).unwrap().content;
    assert!(content.contains("zweite Fassung") && !content.contains("erste Fassung"), "{content}");
    assert!(content.contains("Meine Notiz"));
    assert_eq!(content.matches("<!-- arcalo:auto -->").count(), 1);
    // The review knows its report.
    let r = week_review(&db, monday, &Berlin, &settings(), None, berlin(2026, 10, 9, 9, 0)).unwrap();
    assert_eq!(r.report_page_id, Some(page.id));

    // A renamed report is found by what was written for the week; a trashed one is not.
    db.trash_page(page.id).unwrap();
    assert_eq!(db.week_report_page(monday).unwrap(), None);
    let (fresh, created) = db.week_report_write(monday, "neu", nine).unwrap();
    assert!(created && fresh.id != page.id);
}

#[test]
fn a_user_template_shapes_the_report() {
    let db = Database::open_in_memory().unwrap();
    let nine = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
    assert_eq!(db.week_report_template().unwrap(), None);
    let t = db.week_report_template_ensure().unwrap();
    assert_eq!(t.title, "Wochenbericht");
    assert_eq!(db.week_report_template_ensure().unwrap().id, t.id, "created once");
    assert!(db.list_templates().unwrap().iter().any(|p| p.id == t.id));
    db.save_page_content(
        t.id,
        "---\ntags: [vorlage]\n---\n# Bericht {{kw}}\n\nTeam A · {{ Zeitraum }}\n\n{{rückblick}}\n\nUnterschrift\n",
    )
    .unwrap();
    let (page, _) = db.week_report_write(day(2026, 10, 5), "Inhalt", nine).unwrap();
    let content = db.page_doc(page.id).unwrap().content;
    assert_eq!(
        content,
        "# Bericht 41\n\nTeam A · 05.10.–11.10.2026\n\n<!-- arcalo:auto -->\n\nInhalt\n\n<!-- /arcalo:auto -->\n\nUnterschrift\n"
    );
    // A template without the placeholder: the part goes below its heading.
    let filled = fill_template("# Woche {{kw}}\n\nNotizen\n", day(2026, 10, 5), nine, "Teil");
    assert_eq!(filled, "# Woche 41\n\n<!-- arcalo:auto -->\n\nTeil\n\n<!-- /arcalo:auto -->\n\nNotizen\n");
}

#[test]
fn the_english_report() {
    crate::i18n::with_lang(Language::En, || {
        let db = Database::open_in_memory().unwrap();
        let monday = day(2026, 10, 5);
        assert_eq!(report_title(monday), "Weekly report week 41 2026");
        assert_eq!(range_label(monday), "2026-10-05 – 2026-10-11");
        let (page, _) = db.week_report_write(monday, "Body", NaiveTime::MIN).unwrap();
        let content = db.page_doc(page.id).unwrap().content;
        assert!(content.starts_with("Week 41 · 2026-10-05 – 2026-10-11\n\n<!-- arcalo:auto -->"), "{content}");
        assert!(content.contains("## Next week"));
        assert_eq!(db.week_report_template_ensure().unwrap().title, "Weekly report");
    });
    // A German workspace finds the English report of the same week.
    let db = Database::open_in_memory().unwrap();
    let p = db.create_page(None, "Weekly report week 41 2026", None).unwrap();
    assert_eq!(db.week_report_page(day(2026, 10, 7)).unwrap().map(|x| x.id), Some(p.id));
}

#[test]
fn hours_and_summary_cleaning() {
    assert_eq!(hours(390), "6,5 h");
    assert_eq!(hours(0), "0 h");
    assert_eq!(hours(20), "0,33 h");
    assert_eq!(signed_hours(-90), "−1,5 h");
    assert_eq!(signed_hours(45), "+0,75 h");
    assert_eq!(
        clean_summary("\n## Kopf\n\n\n\n* [x] fertig\n  - [ ] eingerückt\n"),
        "**Kopf**\n\n- fertig\n  - eingerückt"
    );
    assert_eq!(monday_of(day(2026, 10, 11)), day(2026, 10, 5));
    assert_eq!(monday_of(day(2026, 10, 5)), day(2026, 10, 5));
}

#[test]
fn folders_templates_and_the_report_are_no_pages_worked_on() {
    let db = Database::open_in_memory().unwrap();
    let now = Utc::now();
    let today = now.with_timezone(&Berlin).date_naive();
    let p = db.create_page(None, "Echte Arbeit", None).unwrap();
    db.save_page_content(p.id, "Inhalt").unwrap();
    db.week_report_template_ensure().unwrap();
    let (report, _) = db.week_report_write(today, "Teil", NaiveTime::MIN).unwrap();
    let r = week_review(&db, today, &Berlin, &settings(), None, now).unwrap();
    let titles: Vec<&str> = r.pages.iter().map(|p| p.title.as_str()).collect();
    assert_eq!(titles, ["Echte Arbeit"], "no year/month folders, templates or the report itself");
    assert_eq!(r.pages_total, 1);
    assert_eq!(r.report_page_id, Some(report.id));
}
