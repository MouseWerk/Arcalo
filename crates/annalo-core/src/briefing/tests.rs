use super::*;
use crate::calsync::NewEvent;
use crate::issues::{JiraSite, SiteKind};
use crate::model::{EntrySource, NewTimeEntry};
use crate::worktime::AbsenceKind;
use chrono_tz::Europe::Berlin;

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Berlin.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap().with_timezone(&Utc)
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

fn settings() -> Settings {
    let mut s = Settings { workdays: vec![1, 2, 3, 4, 5], daily_target_hours: 8.0, ..Default::default() };
    s.time.balance.state = "BY".into();
    s
}

fn issue(key: &str, status: &str, category: &str, due: Option<&str>) -> Issue {
    Issue {
        site: "s1".into(),
        key: key.into(),
        summary: format!("Summary {key}"),
        status: status.into(),
        status_category: category.into(),
        due_date: due.map(str::to_owned),
        matches: vec!["mine".into()],
        ..Default::default()
    }
}

#[test]
fn sections_keep_their_order_and_unknown_ones_go() {
    let s = BriefingSettings {
        mode: BriefingMode::Start,
        notify_time: " 8:30 ".into(),
        sections: vec![
            BriefingSection { id: "time".into(), on: true },
            BriefingSection { id: "bogus".into(), on: true },
            BriefingSection { id: "meetings".into(), on: false },
            BriefingSection { id: "time".into(), on: false },
        ],
    }
    .normalized();
    let ids: Vec<&str> = s.sections.iter().map(|x| x.id.as_str()).collect();
    assert_eq!(ids, ["time", "meetings", "ai", "tasks", "jira"]);
    assert_eq!(s.notify_time, "08:30");
    assert_eq!(s.enabled(), ["time", "ai", "tasks", "jira"]);
    let bad = BriefingSettings { notify_time: "25:00".into(), ..Default::default() }.normalized();
    assert_eq!(bad.notify_time, "");
    // An unknown mode from a newer version reads as off.
    let m: BriefingMode = serde_json::from_str("\"later\"").unwrap();
    assert_eq!(m, BriefingMode::Off);
}

#[test]
fn workdays_holidays_and_absences() {
    let s = settings();
    // Friday 2 October 2026 is a workday, Saturday is not, 3 October is a holiday anyway.
    assert!(briefing_day(&s, day(2026, 10, 2), &[], None));
    assert!(!briefing_day(&s, day(2026, 10, 3), &[], None));
    let unity = holidays_between(day(2026, 10, 5), day(2026, 10, 5), "BY");
    assert!(unity.is_empty());
    // Whit Monday in Bavaria.
    let whit = holidays_between(day(2026, 5, 25), day(2026, 5, 25), "BY");
    assert!(!briefing_day(&s, day(2026, 5, 25), &whit, None));
    let full = Absence { date: day(2026, 10, 2), kind: AbsenceKind::Vacation, half: false, note: String::new() };
    let half = Absence { half: true, ..full.clone() };
    assert!(!briefing_day(&s, day(2026, 10, 2), &[], Some(&full)));
    assert!(briefing_day(&s, day(2026, 10, 2), &[], Some(&half)));

    let db = Database::open_in_memory().unwrap();
    assert!(is_briefing_day(&db, &s, day(2026, 10, 2)).unwrap());
    db.absence_put(&full).unwrap();
    assert!(!is_briefing_day(&db, &s, day(2026, 10, 2)).unwrap());
    assert!(!is_briefing_day(&db, &s, day(2026, 5, 25)).unwrap());
}

#[test]
fn first_start_of_the_day() {
    let today = day(2026, 10, 2);
    let yesterday = Some(day(2026, 10, 1));
    let mut b = BriefingSettings::default();
    assert_eq!(start_action(&b, today, None, true), StartAction::None, "off by default");
    b.mode = BriefingMode::Start;
    assert_eq!(start_action(&b, today, yesterday, true), StartAction::Open);
    assert_eq!(start_action(&b, today, Some(today), true), StartAction::None, "only the first start");
    assert_eq!(start_action(&b, today, yesterday, false), StartAction::None, "no workday");
    b.mode = BriefingMode::Notify;
    assert_eq!(start_action(&b, today, yesterday, true), StartAction::Notify, "no time: at the start");
    b.notify_time = "08:30".into();
    assert_eq!(start_action(&b, today, yesterday, true), StartAction::None, "the time decides");

    let mut s = settings();
    s.briefing = b;
    let at = |h, m| today.and_hms_opt(h, m, 0).unwrap();
    assert!(!notify_due(at(8, 29), &s, yesterday, true));
    assert!(notify_due(at(8, 30), &s, yesterday, true));
    assert!(notify_due(at(11, 0), &s, None, true));
    assert!(!notify_due(at(9, 0), &s, Some(today), true));
    assert!(!notify_due(at(9, 0), &s, yesterday, false));
    s.notifications.quiet_hours = true;
    s.notifications.quiet_from = "07:00".into();
    s.notifications.quiet_to = "09:00".into();
    assert!(!notify_due(at(8, 45), &s, yesterday, true), "quiet hours");
    s.briefing.mode = BriefingMode::Start;
    assert!(!notify_due(at(10, 0), &s, yesterday, true));
}

#[test]
fn the_last_workday_skips_the_weekend() {
    let s = settings();
    assert_eq!(last_workday(&s, day(2026, 10, 5), &[], &[]), Some(day(2026, 10, 2)), "Monday → Friday");
    assert_eq!(last_workday(&s, day(2026, 10, 2), &[], &[]), Some(day(2026, 10, 1)));
    let none = Settings { workdays: vec![], ..settings() };
    assert_eq!(last_workday(&none, day(2026, 10, 2), &[], &[]), None);
}

#[test]
fn the_last_workday_skips_holidays_absences_and_days_without_hours() {
    let s = settings();
    // Tuesday after Easter: Easter Monday and Good Friday are holidays → Thursday.
    let holidays = crate::worktime::holidays_between(day(2026, 3, 20), day(2026, 4, 7), "BY");
    assert_eq!(last_workday(&s, day(2026, 4, 7), &holidays, &[]), Some(day(2026, 4, 2)));
    // A full vacation day is skipped, a half one is not.
    let off = |d: NaiveDate, half: bool| crate::worktime::Absence {
        date: d,
        kind: crate::worktime::AbsenceKind::Vacation,
        half,
        note: String::new(),
    };
    assert_eq!(last_workday(&s, day(2026, 10, 2), &[], &[off(day(2026, 10, 1), false)]), Some(day(2026, 9, 30)));
    assert_eq!(last_workday(&s, day(2026, 10, 2), &[], &[off(day(2026, 10, 1), true)]), Some(day(2026, 10, 1)));
    // Per-weekday hours decide (Friday without hours), for the briefing day as well.
    let mut h = settings();
    h.time.balance.weekday_hours = vec![8.0, 8.0, 8.0, 8.0, 0.0, 0.0, 0.0];
    assert_eq!(last_workday(&h, day(2026, 10, 5), &[], &[]), Some(day(2026, 10, 1)));
    assert!(!briefing_day(&h, day(2026, 10, 2), &[], None));
}

#[test]
fn jira_lists_due_overdue_and_blocked() {
    let today = day(2026, 10, 2);
    let list = vec![
        issue("A-1", "In Progress", "indeterminate", Some("2026-09-30")),
        issue("A-2", "To Do", "new", Some("2026-10-02")),
        issue("A-3", "Blocked", "indeterminate", None),
        issue("A-4", "Impediment", "indeterminate", Some("2026-10-02")),
        issue("A-5", "Done", "done", Some("2026-09-01")),
        issue("A-6", "To Do", "new", Some("2026-10-09")),
        issue("A-7", "Blockiert", "done", None),
    ];
    let j = jira_section(&list, today);
    let keys = |v: &[BriefingIssue]| v.iter().map(|i| i.key.clone()).collect::<Vec<_>>();
    assert_eq!(keys(&j.overdue), ["A-1"]);
    assert_eq!(keys(&j.due), ["A-2", "A-4"]);
    assert_eq!(keys(&j.blocked), ["A-3"]);
    assert!(j.due[1].blocked && !j.due[0].blocked);
    assert_eq!((j.overdue_total, j.due_total, j.blocked_total), (1, 2, 1));
}

#[test]
fn the_whole_briefing_from_the_stores() {
    let (db, np) = crate::feed::seeded();
    let mut s = settings();
    let today = day(2026, 10, 2);
    let now = berlin(2026, 10, 2, 8, 0);

    // Meetings: a series with a note on an earlier instance, one with its own note, one free.
    db.calendar_replace(
        "ics:a",
        berlin(2026, 9, 25, 0, 0),
        berlin(2026, 9, 26, 0, 0),
        &[event("jf", "2026-09-25", berlin(2026, 9, 25, 9, 0), 30, "Jour fixe")],
    )
    .unwrap();
    let earlier = db.calendar_events(berlin(2026, 9, 25, 0, 0), berlin(2026, 9, 26, 0, 0), &["ics:a".into()]).unwrap();
    let zone = crate::calsync::tz::Zone::Iana(Berlin);
    let (old_note, _) = db.calendar_meeting_note(&earlier[0].key, &zone).unwrap();
    let mut call = event("call", "", berlin(2026, 10, 2, 7, 0), 30, "Frühstück");
    call.busy = Busy::Free;
    let mut review = event("rv", "", berlin(2026, 10, 2, 14, 0), 60, "Sprint Review");
    review.link = Some("https://teams.microsoft.com/l/meetup-join/x".into());
    db.calendar_replace(
        "ics:a",
        berlin(2026, 10, 2, 0, 0),
        berlin(2026, 10, 3, 0, 0),
        &[call, event("jf", "2026-10-02", berlin(2026, 10, 2, 9, 0), 30, "Jour fixe"), review],
    )
    .unwrap();
    // A subject seen before without a series: found by the note's title.
    let todays = db.calendar_events(berlin(2026, 10, 2, 0, 0), berlin(2026, 10, 3, 0, 0), &["ics:a".into()]).unwrap();
    let rv_key = todays.iter().find(|e| e.event.uid == "rv").unwrap().key.clone();
    let (own, _) = db.calendar_meeting_note(&rv_key, &zone).unwrap();

    // Tasks: overdue, due today, later, a private one.
    let p = db.create_page(None, "Aufgaben", None).unwrap();
    db.save_page_content(
        p.id,
        "- [ ] Angebot schicken due:2026-09-30\n- [ ] Bericht lesen due:2026-10-02\n- [ ] Später due:2026-10-20\n",
    )
    .unwrap();

    // Thursday: 6 h of 8 h booked.
    db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np.id,
        vorgang_nr: None,
        leistungsart: None,
        start_time: berlin(2026, 10, 1, 8, 0),
        duration_minutes: 360,
        description: "Konzept".into(),
        source: EntrySource::Manual,
        page_id: None,
    })
    .unwrap();

    let sources = vec!["ics:a".to_owned()];
    let b = briefing(&db, today, &Berlin, &s, &sources, now).unwrap();
    assert!(b.workday);
    assert_eq!(b.sections, ["ai", "meetings", "tasks", "time"], "no Jira site: no Jira section");
    assert_eq!(b.meetings.len(), 3);
    let jf = b.meetings.iter().find(|m| m.title == "Jour fixe").unwrap();
    let prep = jf.prep.as_ref().unwrap();
    assert_eq!((prep.page_id, prep.kind.as_str()), (old_note.id, "series"));
    let rv = b.meetings.iter().find(|m| m.title == "Sprint Review").unwrap();
    assert_eq!(rv.prep.as_ref().map(|p| (p.page_id, p.kind.as_str())), Some((own.id, "own")));
    assert_eq!(rv.link.as_deref(), Some("https://teams.microsoft.com/l/meetup-join/x"));
    let free = b.meetings.iter().find(|m| m.title == "Frühstück").unwrap();
    assert!(free.free && free.past);
    assert_eq!(b.next_meeting.as_deref(), Some(jf.key.as_str()));
    assert_eq!((b.tasks.overdue_total, b.tasks.today_total), (1, 1));
    assert_eq!(b.tasks.today[0].text, "Bericht lesen");
    let tm = b.time.as_ref().unwrap();
    assert_eq!((tm.date, tm.target_minutes, tm.booked_minutes, tm.missing_minutes), (day(2026, 10, 1), 480, 360, 120));
    assert!(!b.private);
    assert!(b.summary.is_none());
    assert_eq!(notify_body(&b), "2 Termine · 2 Aufgaben fällig · 2 h nicht gebucht");

    // A later Jour fixe without a series note finds the subject's note by its title.
    db.conn().execute("UPDATE calendar_marks SET series = '', title = ''", []).unwrap();
    let e = db.calendar_event(&jf.key).unwrap();
    let mut other = e.clone();
    other.event.recurring = false;
    other.key = "ics:b|x|".into();
    assert_eq!(prep_kind(&db, &other), Some("subject".into()));

    // Jira configured, time tracking off, a section switched off, a private task.
    s.jira.sites.push(JiraSite {
        id: "s1".into(),
        name: "Jira".into(),
        color: String::new(),
        kind: SiteKind::Cloud,
        url: "https://x.atlassian.net".into(),
        email: String::new(),
        enabled: true,
        log_work: false,
        allow_writes: false,
    });
    db.issue_put("s1", &issue("A-1", "Blocked", "indeterminate", None), now).unwrap();
    s.time.enabled = false;
    s.briefing.sections.iter_mut().find(|x| x.id == "meetings").unwrap().on = false;
    db.save_page_content(p.id, "- [ ] Arzt anrufen #privat due:2026-10-02\n").unwrap();
    let b = briefing(&db, today, &Berlin, &s, &sources, now).unwrap();
    assert_eq!(b.sections, ["ai", "tasks", "jira"]);
    assert!(b.time.is_none());
    assert_eq!(b.jira.as_ref().unwrap().blocked_total, 1);
    assert!(b.private, "a #privat task keeps the text local");

    // The cached text of the day comes along; one of another day does not.
    let cached = BriefingSummary { date: today, text: "- Angebot".into(), model: "m".into(), at: now, local: false };
    db.meta_set(SUMMARY_KEY, &serde_json::to_string(&cached).unwrap()).unwrap();
    assert_eq!(briefing(&db, today, &Berlin, &s, &sources, now).unwrap().summary, Some(cached));
    assert!(briefing(&db, day(2026, 10, 5), &Berlin, &s, &sources, now).unwrap().summary.is_none());
}

fn prep_kind(db: &Database, e: &CalendarEvent) -> Option<String> {
    prep(db, e).unwrap().map(|p| p.kind)
}

#[test]
fn holidays_and_absences_leave_no_gap() {
    let db = Database::open_in_memory().unwrap();
    let s = settings();
    let now = berlin(2026, 5, 26, 8, 0);
    // Whit Monday in Bavaria: no target, nothing missing.
    let t = last_day(&db, &s, day(2026, 5, 25), &Berlin, now).unwrap();
    assert_eq!((t.target_minutes, t.missing_minutes), (0, 0));
    assert_eq!(t.holiday.as_deref(), Some("Pfingstmontag"));
    // Half a vacation day: half the target.
    db.absence_put(&Absence { date: day(2026, 5, 27), kind: AbsenceKind::Vacation, half: true, note: String::new() })
        .unwrap();
    let t = last_day(&db, &s, day(2026, 5, 27), &Berlin, now).unwrap();
    assert_eq!((t.target_minutes, t.missing_minutes, t.half), (240, 240, true));
    assert_eq!(t.absence.as_deref(), Some("vacation"));
}

#[test]
fn the_prompt_has_titles_times_and_counts_only() {
    let mut b = Briefing {
        date: day(2026, 10, 2),
        workday: true,
        sections: SECTIONS.iter().map(|s| (*s).to_owned()).collect(),
        meetings: vec![BriefingMeeting {
            key: "k".into(),
            source: "ics:a".into(),
            title: "Jour fixe".into(),
            start: berlin(2026, 10, 2, 9, 0),
            end: berlin(2026, 10, 2, 9, 30),
            all_day: false,
            location: "Raum 4".into(),
            link: Some("https://zoom.us/j/1".into()),
            free: false,
            past: false,
            note_page_id: None,
            prep: None,
        }],
        next_meeting: Some("k".into()),
        jira: Some(BriefingJira {
            blocked: vec![BriefingIssue {
                site: "s1".into(),
                key: "A-3".into(),
                summary: "Login kaputt".into(),
                status: "Blocked".into(),
                priority: String::new(),
                due_date: None,
                url: String::new(),
                blocked: true,
            }],
            blocked_total: 1,
            ..Default::default()
        }),
        tasks: BriefingTasks {
            overdue: (0..10)
                .map(|i| BriefingTask {
                    page_id: 1,
                    page_title: "Seite".into(),
                    ordinal: i,
                    text: format!("Aufgabe {i}"),
                    due: Some("2026-09-30".into()),
                    priority: 0,
                })
                .collect(),
            overdue_total: 14,
            ..Default::default()
        },
        time: Some(BriefingTime {
            date: day(2026, 10, 1),
            target_minutes: 480,
            booked_minutes: 390,
            missing_minutes: 90,
            holiday: None,
            absence: None,
            half: false,
        }),
        private: false,
        summary: None,
        ai_ready: true,
    };
    let text = describe(&b, &Berlin);
    assert!(text.starts_with("Heute: Freitag, 02.10.2026\n"));
    assert!(text.contains("Termine (1):\n- 09:00–09:30 Jour fixe (ohne Notiz)\n"));
    assert!(text.contains("Aufgaben überfällig: 14\n- Aufgabe 0 (2026-09-30)\n"));
    assert!(text.contains("- … und 6 weitere\n"), "{text}");
    assert!(!text.contains("Aufgabe 8"));
    assert!(text.contains("Jira blockiert: 1\n- A-3 Login kaputt (Blocked, blockiert)\n"));
    assert!(text.contains("Donnerstag: 6:30 h von 8:00 h gebucht, 1:30 h fehlen\n"), "{text}");
    // No locations, links or page contents.
    assert!(!text.contains("Raum 4") && !text.contains("zoom.us") && !text.contains("Seite"));
    let msgs = summary_messages(&b, &Berlin);
    assert_eq!(msgs.len(), 2);
    assert!(msgs[1].content.as_deref().unwrap_or_default().len() < 900);

    b.meetings.clear();
    b.time = None;
    assert!(describe(&b, &Berlin).contains("Termine: keine\n"));
    assert_eq!(clean_summary("\n- a\n\n- b\n- c\n- d\n- e\n"), "- a\n- b\n- c\n- d");
}
