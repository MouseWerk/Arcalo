use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use chrono_tz::Europe::Berlin;

use super::followup::{self, FollowUp};
use super::prep::{self, PrepData};
use super::status::{self, Period, PeriodKind, ReportRequest, Scope, ScopeKind};
use super::*;
use crate::calsync::tz::Zone;
use crate::calsync::{Busy, CalendarEvent, NewEvent};
use crate::db::Database;
use crate::i18n::with_lang;
use crate::issues::{Issue, JiraSite, SiteKind};
use crate::model::{EntrySource, NewTimeEntry};
use crate::prefs::Language;
use crate::settings::Settings;

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn berlin(y: i32, m: u32, d: u32, h: u32, min: u32) -> DateTime<Utc> {
    Berlin.with_ymd_and_hms(y, m, d, h, min, 0).earliest().unwrap().with_timezone(&Utc)
}

fn event(uid: &str, instance: &str, start: DateTime<Utc>, title: &str, attendees: &[&str]) -> NewEvent {
    NewEvent {
        uid: uid.into(),
        instance: instance.into(),
        recurring: !instance.is_empty(),
        start,
        end: start + Duration::minutes(30),
        all_day: false,
        title: title.into(),
        location: String::new(),
        organizer: String::new(),
        attendees: attendees.iter().map(|a| (*a).to_owned()).collect(),
        body: None,
        link: None,
        busy: Busy::Busy,
        private: false,
        categories: vec![],
    }
}

fn issue(key: &str, summary: &str, status: &str, category: &str, assignee: &str) -> Issue {
    Issue {
        site: "s1".into(),
        key: key.into(),
        summary: summary.into(),
        status: status.into(),
        status_category: category.into(),
        assignee: assignee.into(),
        project_key: crate::issues::project_of(key).into(),
        project_name: if key.starts_with("PORT") { "Portal".into() } else { String::new() },
        url: format!("https://x.atlassian.net/browse/{key}"),
        matches: vec!["mine".into()],
        ..Default::default()
    }
}

fn jira_settings() -> Settings {
    let mut s = Settings::default();
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
    s
}

fn events(db: &Database, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<CalendarEvent> {
    db.calendar_events(from, to, &["ics:a".into()]).unwrap()
}

// ------------------------------------------------------------------ helpers

#[test]
fn list_sections_and_names() {
    let md = "# T\n\n## Entscheidungen\n\n- Go-Live im November\n  - mit Pilot\n- \n\n## Offene Punkte\n1. Preis klären\n\n```\n## Kein Kopf\n- kein Punkt\n```\n";
    assert_eq!(items_under(md, DECISION_HEADINGS), ["Go-Live im November – mit Pilot"]);
    assert_eq!(items_under(md, OPEN_HEADINGS), ["Preis klären"]);
    assert!(list_sections(md).iter().all(|(h, _)| h != "kein kopf"), "code blocks are skipped");
    assert_eq!(name_forms("Müller, Anna"), ["Müller, Anna", "Anna Müller"]);
    assert_eq!(name_forms("Anna Müller"), ["Anna Müller", "Müller, Anna"]);
    assert!(same_person("Müller, Anna", "anna müller"));
    assert!(!same_person("Müller, Anna", "Anna Meyer"));
    assert_eq!(display_name("Weiß, Jörg"), "Jörg Weiß");
    assert_eq!(clip("eins zwei drei vier fünf sechs", 15), "eins zwei drei…");
}

// ------------------------------------------------------------------ managed block

#[test]
fn the_managed_block_keeps_user_edits() {
    let first = block::replace("# Vorbereitung\n\nMeine Frage oben\n", "## Teil\n\n- alt");
    assert_eq!(first, format!("# Vorbereitung\n\n{}\n\nMeine Frage oben\n", block::wrap("## Teil\n\n- alt")));
    // The user writes above and below the block and edits inside it.
    let edited = first
        .replace("Meine Frage oben", "Meine Frage oben\n\n## Eigene Notizen\n\n- [ ] Anna fragen")
        .replace("# Vorbereitung\n\n", "# Vorbereitung\n\nGanz oben\n\n")
        .replace("- alt", "- alt (von Hand geändert)");
    let again = block::replace(&edited, "## Teil\n\n- neu");
    assert!(
        again.starts_with(
            "# Vorbereitung\n\nGanz oben\n\n<!-- arcalo:auto -->\n\n## Teil\n\n- neu\n\n<!-- /arcalo:auto -->\n"
        ),
        "{again}"
    );
    assert!(again.ends_with("## Eigene Notizen\n\n- [ ] Anna fragen\n"), "{again}");
    assert!(!again.contains("von Hand"), "inside the block is regenerated");
    assert_eq!(block::current(&again), Some("## Teil\n\n- neu"));
    // Running it twice changes nothing.
    assert_eq!(block::replace(&again, "## Teil\n\n- neu"), again);

    // Markers deleted: a new block below the front matter and the heading, nothing lost.
    let lost = "---\ndatum: 2026-10-02\n---\n# Titel\nText des Nutzers\n";
    let out = block::replace(lost, "neu");
    assert_eq!(
        out,
        "---\ndatum: 2026-10-02\n---\n# Titel\n\n<!-- arcalo:auto -->\n\nneu\n\n<!-- /arcalo:auto -->\n\nText des Nutzers\n"
    );
    // A marker inside a code block is no marker.
    let fenced = format!("```\n{}\n```\n", block::BEGIN);
    assert!(block::current(&fenced).is_none());
    assert_eq!(
        block::strip_markers(&again),
        "# Vorbereitung\n\nGanz oben\n\n## Teil\n\n- neu\n\nMeine Frage oben\n\n## Eigene Notizen\n\n- [ ] Anna fragen\n"
    );
}

// ------------------------------------------------------------------ follow-up mail

const MINUTES: &str = "---\ndatum: 2026-10-02\nteilnehmer: \"Müller, Anna, Weiß, Jörg\"\n---\n# Jour fixe\n\n\
## Ergebnisse\n\n- Pilot läuft seit Montag\n- Schnittstelle <SAP> & Portal getestet\n\n\
## Entscheidungen\n\n- Go-Live im November\n- \n\n## Notizen\n\n- Entscheidung: Release-Zug alle 2 Wochen\n\n\
## Aufgaben\n\n- [ ] Angebot an [[Kunde X]] schicken @Anna_Müller due:2026-10-09\n- [x] Raum buchen @Jörg\n- [ ] Testplan prüfen\n";

#[test]
fn action_items_decisions_and_results_without_ai() {
    let f = followup::extract(
        7,
        MINUTES,
        "Jour fixe",
        Some(day(2026, 10, 2)),
        vec!["Müller, Anna".into()],
        "en",
        day(2026, 10, 2),
    );
    assert_eq!(f.lang, "de", "the note's language wins over the display language");
    assert_eq!(f.subject, "Zusammenfassung: Jour fixe (02.10.2026)");
    assert_eq!(f.results, ["Pilot läuft seit Montag", "Schnittstelle <SAP> & Portal getestet"]);
    assert_eq!(f.decisions, ["Go-Live im November", "Release-Zug alle 2 Wochen"]);
    assert_eq!(f.actions.len(), 3);
    assert_eq!(f.actions[0].text, "Angebot an Kunde X schicken");
    assert_eq!(f.actions[0].owner.as_deref(), Some("Anna Müller"));
    assert_eq!(f.actions[0].due.as_deref(), Some("2026-10-09"));
    assert!(f.actions[1].done);
    assert_eq!(f.actions[2].owner, None);

    // An English note, no date: English subject.
    let en = followup::extract(
        8,
        "## Decisions\n\n- We ship on Friday\n\n## Action items\n\n- [ ] Write the release notes @Ben due:2026-10-05\n",
        "Weekly",
        None,
        vec![],
        "de",
        day(2026, 10, 2),
    );
    assert_eq!(en.lang, "en");
    assert_eq!(en.subject, "Summary: Weekly");
    assert_eq!(en.decisions, ["We ship on Friday"]);
    assert_eq!(followup::note_lang("ok"), None, "too little text: the display language");
}

#[test]
fn the_mail_body_escapes_and_keeps_umlauts() {
    let mut f =
        followup::extract(7, MINUTES, "Jour fixe <Portal>", Some(day(2026, 10, 2)), vec![], "de", day(2026, 10, 2));
    f.intro = "Danke für \"die\" Runde & bis bald".into();
    let html = followup::html_body(&f);
    assert!(html.contains("<meta charset=\"utf-8\">"));
    assert!(html.contains("Schnittstelle &lt;SAP&gt; &amp; Portal getestet"), "{html}");
    assert!(html.contains("„Jour fixe &lt;Portal&gt;“ vom 02.10.2026."), "{html}");
    assert!(html.contains("Danke für &quot;die&quot; Runde &amp; bis bald"));
    assert!(!html.contains("<SAP>") && !html.contains("<Portal>"), "no text gets through unescaped");
    assert!(html.contains(
        "<td style=\"border:1px solid #d0d7de;padding:4px 8px;text-align:left;vertical-align:top\">Anna Müller</td>"
    ));
    assert!(html.contains("09.10.2026"), "due dates in the mail's format");
    assert!(html.contains("Raum buchen (erledigt)"));
    let text = followup::text_body(&f);
    assert!(
        text.contains("- Angebot an Kunde X schicken (Verantwortlich: Anna Müller) – Fällig: 09.10.2026\n"),
        "{text}"
    );
    assert_eq!(followup::escape_html("<a href='x'>&"), "&lt;a href=&#39;x&#39;&gt;&amp;");
}

#[test]
fn mailto_is_encoded_and_shortened() {
    let mut f = followup::extract(
        7,
        MINUTES,
        "Jour fixe",
        Some(day(2026, 10, 2)),
        vec!["anna@example.com".into(), "Weiß, Jörg".into()],
        "de",
        day(2026, 10, 2),
    );
    let (url, cut) = followup::mailto(&f);
    assert!(!cut);
    assert!(
        url.starts_with(
            "mailto:anna%40example.com?subject=Zusammenfassung%3A%20Jour%20fixe%20%2802.10.2026%29&body=Hallo"
        ),
        "{url}"
    );
    assert!(url.contains("Gr%C3%BC%C3%9Fe"), "umlauts as UTF-8");
    f.results = (0..200).map(|i| format!("Ergebnis Nummer {i} mit etwas Text")).collect();
    let (long, cut) = followup::mailto(&f);
    assert!(cut);
    assert!(long.len() <= followup::MAILTO_MAX, "{}", long.len());
    assert!(long.contains("Gek%C3%BCrzt"), "with a hint");
}

#[test]
fn the_polish_request_is_compact() {
    let mut f: FollowUp = followup::extract(7, MINUTES, "Jour fixe", None, vec![], "de", day(2026, 10, 2));
    f.results = (0..100).map(|i| format!("Ergebnis {i} {}", "x".repeat(300))).collect();
    let m = followup::polish_messages(&f);
    let ctx = m[1].content.clone().unwrap();
    assert!(ctx.chars().count() <= followup::PROMPT_BUDGET + 1, "{}", ctx.chars().count());
    assert!(ctx.contains("Meeting: Jour fixe"));
    assert_eq!(followup::clean_intro("- Erster Satz.\n\n- Zweiter Satz."), "Erster Satz. Zweiter Satz.");
}

// ------------------------------------------------------------------ prep

/// A Jour fixe series: last week's instance has minutes (decisions, open points, tasks, a key),
/// today's is to be prepared.
fn prep_fixture() -> (Database, Settings, CalendarEvent, Vec<CalendarEvent>, i64) {
    let db = Database::open_in_memory().unwrap();
    let mut s = jira_settings();
    s.router.private_markers = vec!["#privat".into()];
    let zone = Zone::Iana(Berlin);
    let who = ["Müller, Anna", "Kleindienst, Maurice", "Weiß, Jörg"];
    db.calendar_replace(
        "ics:a",
        berlin(2026, 9, 25, 0, 0),
        berlin(2026, 9, 26, 0, 0),
        &[event("jf", "2026-09-25", berlin(2026, 9, 25, 9, 0), "Jour fixe Portal", &who)],
    )
    .unwrap();
    let old = events(&db, berlin(2026, 9, 25, 0, 0), berlin(2026, 9, 26, 0, 0));
    let (note, _) = db.calendar_meeting_note(&old[0].key, &zone).unwrap();
    db.save_page_content(
        note.id,
        "# Jour fixe Portal\n\n## Entscheidungen\n\n- Go-Live im November\n\n## Offene Punkte\n\n- Preis für PORT-7 klären\n\n## Aufgaben\n\n- [ ] Angebot schicken @Anna due:2026-10-01\n- [x] Raum buchen\n",
    )
    .unwrap();
    // An unrelated meeting with the same people (for „last meetings with them“).
    db.calendar_replace(
        "ics:a",
        berlin(2026, 9, 28, 0, 0),
        berlin(2026, 9, 29, 0, 0),
        &[event("rv", "", berlin(2026, 9, 28, 14, 0), "Review Schnittstellen", &["Weiß, Jörg"])],
    )
    .unwrap();
    db.calendar_replace(
        "ics:a",
        berlin(2026, 10, 2, 0, 0),
        berlin(2026, 10, 3, 0, 0),
        &[event("jf", "2026-10-02", berlin(2026, 10, 2, 9, 0), "Jour fixe Portal", &who)],
    )
    .unwrap();
    let today = events(&db, berlin(2026, 10, 2, 0, 0), berlin(2026, 10, 3, 0, 0)).remove(0);
    let history = events(&db, berlin(2026, 9, 1, 0, 0), berlin(2026, 10, 2, 0, 0));
    let now = Utc::now();
    db.issue_put("s1", &issue("PORT-7", "Preisblatt", "In Progress", "indeterminate", "Max Mustermann"), now).unwrap();
    db.issue_put("s1", &issue("PORT-9", "Login-Seite", "Blocked", "indeterminate", ""), now).unwrap();
    db.issue_put("s1", &issue("PORT-10", "Fertig", "Done", "done", ""), now).unwrap();
    db.issue_put("s1", &issue("OPS-3", "Server tauschen", "To Do", "new", "Jörg Weiß"), now).unwrap();
    db.issue_put("s1", &issue("OPS-4", "Für mich", "To Do", "new", "Maurice Kleindienst"), now).unwrap();
    // Notes about the attendees.
    let p = db.create_page(None, "Kunde X", None).unwrap();
    db.save_page_content(p.id, "Ansprechpartnerin ist Anna Müller.\n").unwrap();
    let q = db.create_page(None, "Telefonnotiz", None).unwrap();
    db.save_page_content(q.id, "Gespräch mit Müller, Anna über Preise.\n").unwrap();
    (db, s, today, history, note.id)
}

#[test]
fn prep_selects_series_open_points_issues_and_attendees() {
    with_lang(Language::De, || {
        let (db, s, ev, history, note) = prep_fixture();
        let me = vec!["Maurice Kleindienst".to_owned()];
        let d: PrepData = prep::prep_data(&db, &ev, &history, &s, &me).unwrap();
        let prev = d.previous.as_ref().expect("last minutes of the series");
        assert_eq!(prev.page_id, note);
        assert_eq!(prev.kind, "series");
        assert_eq!(prev.decisions, ["Go-Live im November"]);
        assert_eq!(prev.open_points, ["Preis für PORT-7 klären"]);
        // Only the open task, not the done one.
        assert_eq!(d.tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["Angebot schicken @Anna"]);
        let issues = d.issues.as_ref().unwrap();
        let by = |key: &str| issues.iter().find(|i| i.key == key).map(|i| i.reason.as_str());
        assert_eq!(by("PORT-7"), Some("mentioned"), "named in the series' notes");
        assert_eq!(by("PORT-9"), Some("project"), "„Portal“ is in the subject");
        assert!(issues.iter().find(|i| i.key == "PORT-9").unwrap().blocked);
        assert_eq!(by("PORT-10"), None, "done issues are left out");
        assert_eq!(by("OPS-3"), Some("assignee"), "assigned to an attendee");
        assert_eq!(by("OPS-4"), None, "the user's own issues are not an attendee's");
        // Attendees without the user; notes in either name form; last meetings.
        let names: Vec<&str> = d.people.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, ["Anna Müller", "Jörg Weiß"]);
        let anna = &d.people[0];
        let mut titles: Vec<&str> = anna.pages.iter().map(|p| p.title.as_str()).collect();
        titles.sort();
        assert_eq!(titles, ["Kunde X", "Telefonnotiz"]);
        assert_eq!(anna.meetings.len(), 1, "the earlier Jour fixe");
        let joerg = &d.people[1];
        assert_eq!(
            joerg.meetings.iter().map(|m| m.title.as_str()).collect::<Vec<_>>(),
            ["Review Schnittstellen", "Jour fixe Portal"]
        );
        assert!(!d.private);

        // The page: written, filed, found again, refreshed in place.
        let zone = Zone::Iana(Berlin);
        let now = berlin(2026, 10, 2, 8, 30).naive_utc();
        let body = prep::markdown(&d, Some("- Preis klären"), &zone, now);
        assert!(body.contains("## Worauf achten\n\n- Preis klären"));
        assert!(body.contains("[[Jour fixe Portal 25.09.2026]] (25.09.2026, gleiche Serie)"), "{body}");
        assert!(
            body.contains("- Angebot schicken @Anna (fällig 01.10.2026) – [[Jour fixe Portal 25.09.2026]]"),
            "{body}"
        );
        assert!(body.contains("[PORT-9](https://x.atlassian.net/browse/PORT-9) Login-Seite – Blocked · **blockiert** (Projekt im Betreff)"), "{body}");
        assert!(!body.contains("- [ ]"), "no second copies of tasks");
        let (page, created) = db.meeting_prep_write(&ev, &body, &zone).unwrap();
        assert!(created);
        assert_eq!(db.meeting_prep_page_id(&ev.key).unwrap(), Some(page.id));
        assert_eq!(db.meeting_prep_key(page.id).unwrap().as_deref(), Some(ev.key.as_str()));
        let mut content = db.page_doc(page.id).unwrap().content;
        assert!(content.starts_with("<!-- arcalo:auto -->"));
        assert_eq!(page.title, "Vorbereitung Jour fixe Portal 02.10.2026");
        content.push_str("- [ ] Eigene Frage an Anna\n");
        db.save_page_content(page.id, &content).unwrap();
        let (again, created) = db.meeting_prep_write(&ev, "neu", &zone).unwrap();
        assert!(!created);
        assert_eq!(again.id, page.id);
        let after = db.page_doc(page.id).unwrap().content;
        assert!(after.contains("<!-- arcalo:auto -->\n\nneu\n\n<!-- /arcalo:auto -->"));
        assert!(after.ends_with("## Eigene Notizen\n\n- [ ] Eigene Frage an Anna\n"), "{after}");
        // The series' next prep does not take the prep page for minutes.
        let d2 = prep::prep_data(&db, &ev, &history, &s, &me).unwrap();
        assert_eq!(d2.previous.unwrap().page_id, note);
        // The page went where meeting notes go.
        let ty: Option<String> =
            db.conn().query_row("SELECT file_type FROM pages WHERE id = ?1", [page.id], |r| r.get(0)).unwrap();
        assert_eq!(ty.as_deref(), Some("meeting"));
    });
}

#[test]
fn prep_without_jira_privacy_and_the_prompt_budget() {
    let (db, mut s, mut ev, history, note) = prep_fixture();
    s.jira.sites.clear();
    let d = prep::prep_data(&db, &ev, &history, &s, &[]).unwrap();
    assert!(d.issues.is_none(), "no Jira section without a site");
    assert_eq!(d.people.len(), 3);
    // A #privat marker in the minutes keeps the AI local.
    db.save_page_content(note, "## Entscheidungen\n\n- Gehalt #privat\n").unwrap();
    assert!(prep::prep_data(&db, &ev, &history, &s, &[]).unwrap().private);
    // The prompt stays within its budget however much there is.
    let mut big = d.clone();
    big.tasks = (0..50)
        .map(|i| prep::PrepTask { page_id: 1, page_title: "x".into(), text: "y".repeat(400 + i), due: None })
        .collect();
    let m = prep::ai_messages(&big, &Zone::Iana(Berlin));
    assert!(m[1].content.as_ref().unwrap().chars().count() <= prep::PROMPT_BUDGET + 1);
    // A private appointment without details cannot be prepared.
    ev.event.private = true;
    ev.event.title = crate::calsync::PRIVATE_TITLE.into();
    assert!(prep::prep_data(&db, &ev, &history, &s, &[]).is_err());
}

#[test]
fn which_meetings_get_prepared_by_themselves() {
    let now = berlin(2026, 10, 2, 8, 0);
    let mk = |f: &dyn Fn(&mut NewEvent)| {
        let mut e = event("x", "", berlin(2026, 10, 2, 8, 20), "Abstimmung", &["A", "B"]);
        f(&mut e);
        CalendarEvent {
            key: "k".into(),
            source: "ics:a".into(),
            event: e,
            skip: false,
            note_page_id: None,
            entry_id: None,
            also_in: vec![],
        }
    };
    assert!(prep::auto_candidate(&mk(&|_| {}), now, 30));
    assert!(!prep::auto_candidate(&mk(&|_| {}), now, 10), "not yet");
    assert!(!prep::auto_candidate(&mk(&|e| e.attendees.truncate(1)), now, 30), "one attendee");
    assert!(!prep::auto_candidate(&mk(&|e| e.all_day = true), now, 30));
    assert!(!prep::auto_candidate(&mk(&|e| e.private = true), now, 30));
    assert!(!prep::auto_candidate(&mk(&|e| e.busy = Busy::Free), now, 30));
    assert!(!prep::auto_candidate(&mk(&|e| e.start = now - Duration::minutes(1)), now, 30), "started");
}

// ------------------------------------------------------------------ status report

#[test]
fn periods() {
    let today = day(2026, 10, 2); // a Friday
    let p = |kind| Period { kind, from: None, to: None };
    assert_eq!(status::resolve(&p(PeriodKind::ThisWeek), today).unwrap(), (day(2026, 9, 28), day(2026, 10, 4)));
    assert_eq!(status::resolve(&p(PeriodKind::LastWeek), today).unwrap(), (day(2026, 9, 21), day(2026, 9, 27)));
    assert_eq!(status::resolve(&p(PeriodKind::Month), today).unwrap(), (day(2026, 10, 1), day(2026, 10, 31)));
    assert_eq!(status::resolve(&p(PeriodKind::LastMonth), today).unwrap(), (day(2026, 9, 1), day(2026, 9, 30)));
    assert_eq!(status::resolve(&p(PeriodKind::Month), day(2026, 12, 5)).unwrap().1, day(2026, 12, 31));
    let custom = Period { kind: PeriodKind::Custom, from: Some(day(2026, 10, 5)), to: Some(day(2026, 10, 1)) };
    assert!(status::resolve(&custom, today).is_err());
    with_lang(Language::De, || {
        assert_eq!(status::period_label(&p(PeriodKind::ThisWeek), day(2026, 9, 28), day(2026, 10, 4)), "KW 40/2026");
        assert_eq!(status::period_label(&p(PeriodKind::Month), day(2026, 10, 1), day(2026, 10, 31)), "Oktober 2026");
    });
}

fn entry(
    db: &Database,
    np: i64,
    v: Option<&str>,
    la: &str,
    start: DateTime<Utc>,
    minutes: i64,
    page: Option<i64>,
) -> i64 {
    db.insert_time_entry(&NewTimeEntry {
        netzplan_id: np,
        vorgang_nr: v.map(str::to_owned),
        leistungsart: Some(la.into()),
        start_time: start,
        duration_minutes: minutes,
        description: "x".into(),
        source: EntrySource::Manual,
        page_id: page,
    })
    .unwrap()
    .id
}

#[test]
fn status_report_per_scope_and_period() {
    with_lang(Language::De, || {
        let (db, np) = crate::feed::seeded();
        let mut s = jira_settings();
        s.time.enabled = true;
        let today = day(2026, 10, 2);
        // Notes of the project: one changed this week with decisions, one about another project.
        let folder = db.create_page(None, "Portal", None).unwrap();
        let a = db.create_page(Some(folder.id), "Jour fixe Portal 01.10.2026", None).unwrap();
        db.save_page_content(
            a.id,
            "Zu NP-8801 und PORT-1.\n\n## Entscheidungen\n\n- Go-Live im November\n\n### Entscheidung: Pilot mit drei Kunden\n\n- Rollback-Plan steht #entscheidung\n\n## Risiken\n\n- Lieferant spät\n\n- [ ] Abnahme vorbereiten due:2026-10-20\n- [ ] Doku nachziehen due:2026-09-30\n",
        )
        .unwrap();
        let b = db.create_page(None, "Anderes", None).unwrap();
        db.save_page_content(b.id, "Nichts zum Projekt.\n").unwrap();
        // Hours: two this week (one booked from the note), one last week.
        entry(&db, np.id, Some("1020"), "DEV", berlin(2026, 9, 29, 9, 0), 120, Some(a.id));
        entry(&db, np.id, Some("1020"), "DEV", berlin(2026, 9, 30, 9, 0), 60, None);
        entry(&db, np.id, None, "PM", berlin(2026, 10, 1, 9, 0), 30, None);
        let jira_entry = entry(&db, np.id, Some("1020"), "DEV", berlin(2026, 9, 30, 13, 0), 45, None);
        entry(&db, np.id, Some("1020"), "DEV", berlin(2026, 9, 22, 9, 0), 600, None);
        // Issues: PORT is the Netzplan's project.
        let now = Utc::now();
        let mut done = issue("PORT-1", "Login", "Done", "done", "Anna");
        done.resolved = Some("2026-09-30T10:00:00Z".into());
        done.sprint = "Sprint 4".into();
        done.sprint_state = "active".into();
        let mut old = issue("PORT-2", "Alt", "Done", "done", "");
        old.resolved = Some("2026-08-01T10:00:00Z".into());
        let mut wip = issue("PORT-3", "Suche", "In Progress", "indeterminate", "Ben");
        wip.sprint = "Sprint 4".into();
        wip.sprint_state = "active".into();
        wip.due_date = Some("2026-10-10".into());
        let blocked = issue("PORT-4", "Zahlung", "Blocked", "indeterminate", "");
        let new = issue("PORT-5", "Export", "To Do", "new", "");
        for i in [&done, &old, &wip, &blocked, &new, &issue("OPS-1", "Fremd", "To Do", "new", "")] {
            db.issue_put("s1", i, now).unwrap();
        }
        db.issue_wbs_set("project", "PORT", "NP-8801", false).unwrap();
        db.issue_link_entry(jira_entry, "PORT-3", None).unwrap();

        let req = |kind, id: &str| ReportRequest {
            scope: Scope { kind, id: id.into(), label: "Portal".into() },
            period: Period { kind: PeriodKind::ThisWeek, from: None, to: None },
            sections: vec![],
            ai: false,
        };
        let r = status::build(&db, &req(ScopeKind::Netzplan, &np.id.to_string()), &s, today, &Berlin).unwrap();
        assert_eq!((r.from, r.to), (day(2026, 9, 28), day(2026, 10, 4)));
        let h = r.hours.as_ref().unwrap();
        assert_eq!(h.total_minutes, 255, "last week's 10 h are not in this week");
        assert_eq!(h.rows[0].label, "NP-8801/1020");
        assert_eq!(h.rows[0].title, "Schnittstellen");
        assert_eq!(h.rows[0].minutes, 225);
        assert_eq!((h.rows[1].label.as_str(), h.rows[1].leistungsart.as_str()), ("NP-8801", "PM"));
        assert!(h.budget.iter().any(|b| b.label == "NP-8801/1020" && b.booked_hours > 13.0));
        let j = r.jira.as_ref().unwrap();
        let keys = |l: &Vec<status::ReportIssue>| l.iter().map(|i| i.key.clone()).collect::<Vec<_>>();
        assert_eq!(keys(&j.done), ["PORT-1"], "resolved in the period only");
        assert_eq!(keys(&j.in_progress), ["PORT-3"]);
        assert_eq!(keys(&j.new), ["PORT-5"]);
        assert_eq!(keys(&j.blocked), ["PORT-4"]);
        assert_eq!(j.sprint.as_ref().map(|x| (x.total, x.done, x.remaining)), Some((2, 1, 1)));
        assert_eq!(r.notes.iter().map(|n| n.title.as_str()).collect::<Vec<_>>(), ["Jour fixe Portal 01.10.2026"]);
        let decisions: Vec<&str> = r.decisions.iter().map(|d| d.text.as_str()).collect();
        assert_eq!(decisions, ["Go-Live im November", "Pilot mit drei Kunden", "Rollback-Plan steht"]);
        assert_eq!(r.deadlines.iter().map(|d| d.date.as_str()).collect::<Vec<_>>(), ["2026-10-10", "2026-10-20"]);
        let risks: Vec<&str> = r.risks.iter().map(|x| x.kind.as_str()).collect();
        assert!(risks.contains(&"overdue") && risks.contains(&"blocked") && risks.contains(&"noted"), "{risks:?}");

        // The Jira project: only the hours booked on its issues, the budget of its Netzplan.
        let r = status::build(&db, &req(ScopeKind::Jira, "PORT"), &s, today, &Berlin).unwrap();
        assert_eq!(r.hours.as_ref().unwrap().total_minutes, 45);
        assert!(!r.hours.as_ref().unwrap().budget.is_empty());
        assert_eq!(keys(&r.jira.as_ref().unwrap().blocked), ["PORT-4"]);

        // A folder: hours booked from its notes; issues named in them.
        let r = status::build(&db, &req(ScopeKind::Folder, &folder.id.to_string()), &s, today, &Berlin).unwrap();
        assert_eq!(r.hours.as_ref().unwrap().total_minutes, 120);
        assert_eq!(keys(&r.jira.as_ref().unwrap().done), ["PORT-1"]);

        // Last week: other hours, no notes.
        let mut last = req(ScopeKind::Netzplan, &np.id.to_string());
        last.period.kind = PeriodKind::LastWeek;
        let r2 = status::build(&db, &last, &s, today, &Berlin).unwrap();
        assert_eq!(r2.hours.as_ref().unwrap().total_minutes, 600);
        assert!(r2.notes.is_empty());

        // Time tracking off and no Jira: those sections go.
        let mut off = Settings::default();
        off.time.enabled = false;
        let r3 = status::build(&db, &req(ScopeKind::Folder, &folder.id.to_string()), &off, today, &Berlin).unwrap();
        assert!(r3.hours.is_none() && r3.jira.is_none());
        let md = status::markdown(&r3, &[], None, "02.10.2026 10:00");
        assert!(!md.contains("## Gebuchte Stunden") && !md.contains("## Jira"));
        assert!(
            status::build(&db, &req(ScopeKind::Jira, "PORT"), &off, today, &Berlin).is_err(),
            "no Jira scope without Jira"
        );

        // The page: sections in the template's order; written again in place.
        let md = status::markdown(&r, &["risks".into(), "hours".into()], Some("Alles im Plan."), "02.10.2026 10:00");
        assert!(md.find("## Risiken").unwrap() < md.find("## Gebuchte Stunden").unwrap());
        assert!(!md.contains("## Zusammenfassung"), "the summary only where the template has it");
        let rq = req(ScopeKind::Netzplan, &np.id.to_string());
        let (page, created) = db.status_write(&rq, &r, &md, now).unwrap();
        assert!(created);
        assert_eq!(page.title, "Statusbericht Portal KW 40/2026");
        let mut c = db.page_doc(page.id).unwrap().content;
        c.push_str("Eigene Anmerkung\n");
        db.save_page_content(page.id, &c).unwrap();
        let (again, created) = db.status_write(&rq, &r, "neu", now).unwrap();
        assert!(!created && again.id == page.id);
        assert!(db.page_doc(page.id).unwrap().content.ends_with("Eigene Anmerkung\n"));
        assert_eq!(db.status_last().unwrap().unwrap().page_id, page.id);
        assert!(db.status_is_report(page.id).unwrap());
        // A report is no note of the project.
        let r4 = status::build(&db, &req(ScopeKind::Netzplan, &np.id.to_string()), &s, today, &Berlin).unwrap();
        assert!(r4.notes.iter().all(|n| n.page_id != page.id));
        let ai = status::ai_messages(&r4);
        assert!(ai[1].content.as_ref().unwrap().chars().count() <= status::PROMPT_BUDGET + 1);

        // Templates.
        let list = db
            .status_template_save(status::ReportTemplate {
                id: String::new(),
                name: " ".into(),
                scope: rq.scope.clone(),
                period: PeriodKind::LastWeek,
                sections: vec!["risks".into(), "bogus".into(), "risks".into()],
                ai: true,
            })
            .unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "t1");
        assert_eq!(list[0].name, "Portal");
        assert_eq!(list[0].sections, ["risks"]);
        assert!(db.status_template_delete("t1").unwrap().is_empty());
    });
}

#[test]
fn settings_step_adds_the_prep_keys() {
    let mut v = serde_json::json!({ "version": 6, "briefing": { "mode": "start" } });
    let m = crate::settings_migrate::migrate(&mut v);
    assert!(m.notes.iter().any(|n| n.contains("meeting-prep")), "{:?}", m.notes);
    assert_eq!(v["briefing"]["prep_auto"], false);
    assert_eq!(v["briefing"]["prep_minutes"], 30);
    // Already set: kept.
    let mut w = serde_json::json!({ "version": 6, "briefing": { "prep_auto": true, "prep_minutes": 10 } });
    crate::settings_migrate::migrate(&mut w);
    assert_eq!(w["briefing"]["prep_auto"], true);
    assert_eq!(w["briefing"]["prep_minutes"], 10);
}
