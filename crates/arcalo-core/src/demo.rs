//! Sample workspace used by `arcalo demo` and the first launch of the app.

use crate::tr;
use chrono::{DateTime, Duration, TimeZone, Utc};

use crate::db::Database;
use crate::error::Result;
use crate::model::{EntrySource, NewTimeEntry, PageNode};
use std::collections::HashSet;

/// Seeds the samples on explicit request (`arcalo demo`), even if they were removed before.
pub fn seed_explicit<Tz: TimeZone>(db: &Database, now: DateTime<Tz>) -> Result<bool> {
    db.conn().execute("DELETE FROM settings WHERE key = 'meta.demo_seeded'", [])?;
    seed(db, now)
}

/// Seeds a project with a Netzplan, Vorgänge, time entries and pages.
/// Runs once per workspace: never again after the user removed the samples,
/// and not at all if the workspace already had projects. `now` in the user's time zone (`Local`):
/// today's daily note is the one of the local date, not of UTC's.
pub fn seed<Tz: TimeZone>(db: &Database, now: DateTime<Tz>) -> Result<bool> {
    if db.meta_get("demo_seeded")?.is_some() {
        return Ok(false);
    }
    db.meta_set("demo_seeded", "1")?;
    if !db.list_projects()?.is_empty() {
        return Ok(false);
    }
    let today = now.date_naive();
    let now = now.with_timezone(&Utc);
    // The samples come in the display language (codes and numbers are the same in both).
    let p = db.create_project("PRJ-2026-X", "Arcalo Rollout")?;
    let np = db.create_netzplan(
        p.id,
        "NP-8801",
        "NP-8801-1020",
        tr!("Systemintegration ERP", "ERP system integration"),
        120.0,
    )?;
    let np2 =
        db.create_netzplan(p.id, "NP-8802", "NP-8802-2010", tr!("Schulung & Go-Live", "Training & go-live"), 40.0)?;

    let spec = [
        ("1010", tr!("Anforderungsanalyse", "Requirements analysis"), 3.0, 16.0, &[][..]),
        ("1020", tr!("Systemintegration", "System integration"), 5.0, 40.0, &["1010"][..]),
        ("1030", tr!("Schnittstellendesign", "Interface design"), 4.0, 24.0, &["1010"][..]),
        ("1040", tr!("Integrationstest", "Integration test"), 3.0, 24.0, &["1020", "1030"][..]),
        ("1050", tr!("Dokumentation", "Documentation"), 2.0, 8.0, &["1030"][..]),
        ("1060", tr!("Abnahme", "Acceptance"), 1.0, 8.0, &["1040", "1050"][..]),
    ];
    let mut ids = std::collections::HashMap::new();
    for (nr, desc, days, hours, preds) in spec {
        let v = db.create_vorgang(np.id, nr, desc, days, hours)?;
        for p in preds {
            db.link_vorgaenge(ids[p], v.id)?;
        }
        ids.insert(nr, v.id);
    }
    db.create_vorgang(np2.id, "2010", tr!("Key-User-Schulung", "Key user training"), 2.0, 16.0)?;

    let day = |d: i64, h: i64| now - Duration::days(d) - Duration::hours(h);
    let entries = [
        (
            np.id,
            "1010",
            "CONSULTING",
            9,
            6,
            240,
            tr!("Workshop Anforderungen mit Fachbereich", "Requirements workshop with the business team"),
        ),
        (np.id, "1010", "CONSULTING", 8, 6, 330, tr!("Lastenheft finalisiert", "Requirements specification finalized")),
        (np.id, "1010", "PM", 7, 7, 150, tr!("Abstimmung Scope & Budget", "Scope & budget alignment")),
        (np.id, "1020", "DEV", 6, 6, 420, tr!("Systemintegration Middleware", "Middleware system integration")),
        (np.id, "1020", "DEV", 5, 6, 450, tr!("IDoc-Mapping Materialstamm", "IDoc mapping material master")),
        (np.id, "1030", "DEV", 4, 6, 300, tr!("REST-Schnittstelle Auftragsdaten", "REST interface order data")),
        (np.id, "1020", "DEV", 3, 6, 480, tr!("Fehleranalyse Queue-Verarbeitung", "Error analysis queue processing")),
        (np.id, "1030", "DEV", 2, 6, 360, tr!("OpenAPI-Spezifikation", "OpenAPI specification")),
        (np.id, "1020", "DEV", 1, 6, 390, tr!("Systemintegration Delta-Load", "System integration delta load")),
        (np2.id, "2010", "CONSULTING", 1, 2, 90, tr!("Schulungsunterlagen Entwurf", "Training material draft")),
    ];
    for (npid, v, la, d, h, minutes, desc) in entries {
        db.insert_time_entry(&NewTimeEntry {
            netzplan_id: npid,
            vorgang_nr: Some(v.into()),
            leistungsart: Some(la.into()),
            start_time: day(d, h),
            duration_minutes: minutes,
            description: desc.into(),
            source: EntrySource::Manual,
            page_id: None,
        })?;
    }

    let start = db.create_page(None, tr!("Willkommen", "Welcome"), Some("sparkles"))?;
    db.save_page_content(
        start.id,
        tr!(
            "Arcalo ist dein ganzer Arbeitstag in einer App: Notizen, Aufgaben, Besprechungen und Zeit, lokal auf deinem Computer.\n\n\
             ## So arbeitest du hier\n\n\
             - Notizen sind Markdown. Verlinke Seiten mit `[[Seitenname]]` und verschlagworte mit `#tag`.\n\
             - Aufgaben sind Checkboxen in jeder Notiz, zum Beispiel `- [ ] Angebot senden due:2026-10-15`. Alle offenen stehen unter Aufgaben.\n\
             - Termine aus Outlook oder einem ICS-Link stehen im Kalender und in der Tagesnotiz; ein Klick legt die Besprechungsnotiz an.\n\
             - Wenn du Zeit buchst: tippe `/zeit NP-8801/1020 1.5h Review` direkt in den Text und drücke die Eingabetaste.\n\
             - `Strg K` öffnet die Befehlspalette, `Strg O` den Schnellwechsler.\n\n\
             ## Einstieg\n\n\
             - [ ] Die Besprechungsnotiz [[Jour fixe 22.09.]] ansehen\n\
             - [ ] Das Projekt unter [[PRJ-2026-X Rollout]] ansehen\n\
             - [ ] Den eigenen Kalender in den Einstellungen verbinden\n",
            "Arcalo is your whole workday in one app: notes, tasks, meetings and time, on your own computer.\n\n\
             ## How you work here\n\n\
             - Notes are Markdown. Link pages with `[[Page name]]` and tag them with `#tag`.\n\
             - Tasks are checkboxes in any note, for example `- [ ] Send the offer due:2026-10-15`. All open ones are listed under Tasks.\n\
             - Meetings from Outlook or an ICS link show in the calendar and in your daily note; one click creates the meeting note.\n\
             - If you book time: type `/time NP-8801/1020 1.5h Review` right in the text and press Enter.\n\
             - `Ctrl K` opens the command palette, `Ctrl O` the quick switcher.\n\n\
             ## Getting started\n\n\
             - [ ] Look at the meeting note [[Weekly sync 22.09.]]\n\
             - [ ] Look at the project under [[PRJ-2026-X Rollout]]\n\
             - [ ] Connect your own calendar in the settings\n"
        ),
    )?;

    let projects = db.create_page(None, tr!("Projekte", "Projects"), Some("folder-kanban"))?;
    let proj = db.create_page(Some(projects.id), "PRJ-2026-X Rollout", Some("briefcase"))?;
    db.save_page_content(
        proj.id,
        tr!(
            "Einführung der ERP-Middleware bei Kunde X. #projekt #rollout\n\n\
             ## Ziele\n\n\
             1. IDoc-Schnittstellen für Material- und Auftragsdaten produktiv\n\
             2. Key-User geschult, Go-Live bis Ende Oktober\n\n\
             ## Netzpläne\n\n\
             | Netzplan | Inhalt | Plan |\n|---|---|---|\n\
             | NP-8801 | Systemintegration ERP | 120 h |\n\
             | NP-8802 | Schulung & Go-Live | 40 h |\n\n\
             Technische Details in [[Architektur]], Abstimmungen im [[Jour fixe 22.09.]].\n",
            "Rollout of the ERP middleware at customer X. #project #rollout\n\n\
             ## Goals\n\n\
             1. IDoc interfaces for material and order data in production\n\
             2. Key users trained, go-live by the end of October\n\n\
             ## Networks\n\n\
             | Network | Content | Plan |\n|---|---|---|\n\
             | NP-8801 | ERP system integration | 120 h |\n\
             | NP-8802 | Training & go-live | 40 h |\n\n\
             Technical details in [[Architecture]], alignment in the [[Weekly sync 22.09.]].\n"
        ),
    )?;
    let arch = db.create_page(Some(proj.id), tr!("Architektur", "Architecture"), Some("blocks"))?;
    db.save_page_content(
        arch.id,
        tr!(
            "Die Middleware verbindet das ERP über IDocs mit dem Auftragsportal. #architektur\n\n\
             ## Komponenten\n\n\
             - **Inbound**: IDoc-Empfang, Mapping auf das kanonische Datenmodell\n\
             - **Queue**: persistente Verarbeitung mit Retry\n\
             - **Outbound**: REST-Schnittstelle Auftragsdaten (OpenAPI 3.1)\n\n\
             > **Risiko:** Vorgang 1020 liegt auf dem kritischen Pfad. Verzug verschiebt die Abnahme.\n\n\
             ## Betrieb\n\n\
             ```powershell\nGet-Service -Name 'Arcalo*' | Restart-Service\n```\n",
            "The middleware connects the ERP to the order portal through IDocs. #architecture\n\n\
             ## Components\n\n\
             - **Inbound**: IDoc receipt, mapping to the canonical data model\n\
             - **Queue**: persistent processing with retry\n\
             - **Outbound**: REST interface order data (OpenAPI 3.1)\n\n\
             > **Risk:** Activity 1020 is on the critical path. A delay moves the acceptance.\n\n\
             ## Operations\n\n\
             ```powershell\nGet-Service -Name 'Arcalo*' | Restart-Service\n```\n"
        ),
    )?;
    let jf = db.create_page(Some(proj.id), tr!("Jour fixe 22.09.", "Weekly sync 22.09."), Some("users"))?;
    db.save_page_content(
        jf.id,
        tr!(
            "Teilnehmer: Fachbereich, IT-Betrieb, Projektleitung #meeting\n\n\
             ## Ergebnisse\n\n\
             - Delta-Load läuft stabil, nächster Schritt ist der Integrationstest (siehe [[Architektur]])\n\
             - Schulungstermine für NP-8802 werden bis Freitag fixiert\n\n\
             ## Aufgaben\n\n\
             - [x] Budget NP-8801 prüfen\n\
             - [ ] Testdaten für 1040 bereitstellen\n\
             - [ ] Schulungstermine 2010 fixieren\n",
            "Attendees: business team, IT operations, project management #meeting\n\n\
             ## Results\n\n\
             - The delta load runs stable, the next step is the integration test (see [[Architecture]])\n\
             - Training dates for NP-8802 are fixed by Friday\n\n\
             ## Tasks\n\n\
             - [x] Check the NP-8801 budget\n\
             - [ ] Provide test data for 1040\n\
             - [ ] Fix the 2010 training dates\n"
        ),
    )?;
    let kb = db.create_page(None, tr!("Wissensbasis", "Knowledge base"), Some("book-open"))?;
    let cats = db.create_page(Some(kb.id), tr!("SAP CATS Leitfaden", "SAP CATS guide"), Some("file-text"))?;
    db.save_page_content(
        cats.id,
        tr!(
            "Zeiten werden wöchentlich in CATS übertragen. #sap #zeiterfassung\n\n\
             1. Einträge der Woche prüfen und **freigeben**\n\
             2. Export im Format *SAP CATS* erzeugen\n\
             3. Datei in der CATS-Upload-Transaktion einlesen\n\n\
             Leistungsarten: `DEV`, `CONSULTING`, `PM`, `TEST`.\n",
            "Times are transferred to CATS weekly. #sap #timetracking\n\n\
             1. Check the week's entries and **release** them\n\
             2. Create an export in the *SAP CATS* format\n\
             3. Load the file in the CATS upload transaction\n\n\
             Activity types: `DEV`, `CONSULTING`, `PM`, `TEST`.\n"
        ),
    )?;
    let templates = db.templates_root()?;
    let meeting = db.create_page(Some(templates.id), tr!("Besprechung", "Meeting"), Some("users"))?;
    db.save_page_content(
        meeting.id,
        tr!(
            "{{wochentag}}, {{datum}} · {{zeit}} Uhr #meeting\n\n\
             ## Teilnehmer\n\n- \n\n\
             ## Agenda\n\n1. \n\n\
             ## Entscheidungen\n\n- \n\n\
             ## Aufgaben\n\n- [ ] \n\n\
             > [!tip] Zeit buchen\n> Tippe `/zeit NP-8801/1020 1h Besprechung` und drücke die Eingabetaste.\n",
            "{{weekday}}, {{date}} · {{time}} #meeting\n\n\
             ## Attendees\n\n- \n\n\
             ## Agenda\n\n1. \n\n\
             ## Decisions\n\n- \n\n\
             ## Tasks\n\n- [ ] \n\n\
             > [!tip] Book time\n> Type `/time NP-8801/1020 1h Meeting` and press Enter.\n"
        ),
    )?;
    let customer = db.create_page(Some(templates.id), tr!("Kundentermin", "Customer meeting"), Some("briefcase"))?;
    db.save_page_content(
        customer.id,
        tr!(
            "Termin: {{titel}}\nKunde: \nOrt: \nDatum: {{datum}}, {{zeit}} Uhr (KW {{kw}}) #kunde\n\n\
             ## Ziel des Termins\n\n\n\
             ## Gesprächsnotizen\n\n- \n\n\
             ## Vereinbarungen\n\n- \n\n\
             ## Nächste Schritte\n\n- [ ] Protokoll an den Kunden senden\n- [ ] \n",
            "Meeting: {{title}}\nCustomer: \nPlace: \nDate: {{date}}, {{time}} (week {{week}}) #customer\n\n\
             ## Goal of the meeting\n\n\n\
             ## Conversation notes\n\n- \n\n\
             ## Agreements\n\n- \n\n\
             ## Next steps\n\n- [ ] Send the minutes to the customer\n- [ ] \n"
        ),
    )?;
    db.set_favorite(proj.id, true)?;
    db.set_favorite(arch.id, true)?;
    // „Beispiele entfernen“ goes by these ids: a page of the user's with a sample's title stays.
    let ids = [start.id, projects.id, proj.id, arch.id, jf.id, kb.id, cats.id, templates.id, meeting.id, customer.id];
    db.meta_set(DEMO_IDS, &ids.map(|id| id.to_string()).join(","))?;
    db.daily_note(today)?;
    Ok(true)
}

/// The ids of the sample pages (comma-separated; samples seeded before 1.18 have none).
const DEMO_IDS: &str = "demo_pages";

/// Titles and icons of the pages created by [`seed`], in both languages: samples seeded before
/// their ids were kept are told by both.
const DEMO_PAGES: &[(&str, &str)] = &[
    ("Willkommen", "sparkles"),
    ("Projekte", "folder-kanban"),
    ("PRJ-2026-X Rollout", "briefcase"),
    ("Architektur", "blocks"),
    ("Jour fixe 22.09.", "users"),
    ("Wissensbasis", "book-open"),
    ("SAP CATS Leitfaden", "file-text"),
    (crate::templates::TEMPLATES_TITLE, "layout-template"),
    ("Besprechung", "users"),
    ("Kundentermin", "briefcase"),
    ("Welcome", "sparkles"),
    ("Weekly sync 22.09.", "users"),
    ("Projects", "folder-kanban"),
    ("Architecture", "blocks"),
    ("Knowledge base", "book-open"),
    ("SAP CATS guide", "file-text"),
    (crate::templates::TEMPLATES_TITLE_EN, "layout-template"),
    ("Meeting", "users"),
    ("Customer meeting", "briefcase"),
];

/// Removes the sample project (with its time entries) and moves the sample pages to the trash
/// (with what was written into them, they can be restored from there). Daily notes and everything
/// the user created are kept. Returns the number of removed subtrees.
pub fn remove(db: &Database) -> Result<usize> {
    db.atomic(|| {
        if let Ok(p) = db.project_by_code("PRJ-2026-X") {
            // The feed forgets the sample bookings too.
            db.conn().execute(
                "DELETE FROM activity WHERE netzplan_id IN (SELECT id FROM netzplaene WHERE project_id = ?1)",
                [p.id],
            )?;
            db.conn().execute(
                "DELETE FROM time_entries WHERE netzplan_id IN (SELECT id FROM netzplaene WHERE project_id = ?1)",
                [p.id],
            )?;
            db.delete_project(p.id)?;
        }
        let ids: Option<HashSet<i64>> =
            db.meta_get(DEMO_IDS)?.map(|v| v.split(',').filter_map(|x| x.trim().parse().ok()).collect());
        let is_demo = |n: &PageNode| {
            n.page.daily_date.is_none()
                && match &ids {
                    Some(ids) => ids.contains(&n.page.id),
                    None => DEMO_PAGES
                        .iter()
                        .any(|(title, icon)| n.page.title == *title && n.page.icon.as_deref() == Some(*icon)),
                }
        };
        // Sample subtrees top-down; a page with the user's pages below it stays.
        fn only_demo(n: &PageNode, is_demo: &dyn Fn(&PageNode) -> bool) -> bool {
            is_demo(n) && n.children.iter().all(|c| only_demo(c, is_demo))
        }
        fn sweep(
            db: &Database,
            nodes: &[PageNode],
            is_demo: &dyn Fn(&PageNode) -> bool,
            at: DateTime<Utc>,
            removed: &mut usize,
        ) -> Result<()> {
            for n in nodes {
                if only_demo(n, is_demo) {
                    // Pages the user trashed below a sample page stay entries of their own, at the
                    // top level.
                    db.conn().execute(
                        "WITH RECURSIVE sub(id) AS (
                             SELECT ?1 UNION ALL
                             SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id WHERE p.deleted_at IS NULL)
                         UPDATE pages SET parent_id = NULL WHERE deleted_at IS NOT NULL AND parent_id IN sub",
                        [n.page.id],
                    )?;
                    db.conn().execute(
                        "WITH RECURSIVE sub(id) AS (
                             SELECT ?1 UNION ALL
                             SELECT p.id FROM pages p JOIN sub ON p.parent_id = sub.id)
                         DELETE FROM activity WHERE page_id IN sub",
                        [n.page.id],
                    )?;
                    db.trash_page_at(n.page.id, at)?;
                    *removed += 1;
                } else {
                    sweep(db, &n.children, is_demo, at, removed)?;
                }
            }
            Ok(())
        }
        let mut removed = 0;
        sweep(db, &db.page_tree()?, &is_demo, Utc::now(), &mut removed)?;
        db.conn().execute("DELETE FROM settings WHERE key = ?1", [format!("meta.{DEMO_IDS}")])?;
        Ok(removed)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_is_consistent_and_idempotent() {
        let db = Database::open_in_memory().unwrap();
        assert!(seed(&db, Utc::now()).unwrap());
        assert!(!seed(&db, Utc::now()).unwrap(), "second run must not duplicate data");
        remove(&db).unwrap();
        assert!(!seed(&db, Utc::now()).unwrap(), "removed samples stay removed");
        assert!(seed_explicit(&db, Utc::now()).unwrap());
        let np = db.netzplan_by_ref("NP-8801").unwrap();
        let s = crate::netzplan::schedule(&db.list_vorgaenge(np.id).unwrap()).unwrap();
        assert_eq!(s.duration, 12.0);
        assert_eq!(db.list_time_entries(&Default::default()).unwrap().len(), 10);
        let arch = db.page_by_title("Architektur").unwrap().unwrap();
        assert_eq!(db.page_doc(arch.id).unwrap().backlinks.len(), 2);
        let titles: Vec<_> = db.list_templates().unwrap().into_iter().map(|p| p.title).collect();
        assert_eq!(titles, ["Besprechung", "Kundentermin"]);

        let mine = db.create_page(Some(arch.id), "Meine Notiz", None).unwrap();
        let n = remove(&db).unwrap();
        assert_eq!(n, 4, "Willkommen, Jour fixe, the Wissensbasis and the Vorlagen subtree");
        assert!(db.list_projects().unwrap().is_empty());
        assert!(db.list_time_entries(&Default::default()).unwrap().is_empty());
        assert!(db.page(mine.id).is_ok(), "user pages survive");
        assert!(db.page_by_title("Architektur").unwrap().is_some(), "parent of a user page is kept");
        assert!(db.page_by_title("SAP CATS Leitfaden").unwrap().is_none());
    }

    #[test]
    fn todays_daily_note_is_the_local_date() {
        // 00:30 in Berlin is still yesterday in UTC.
        let berlin = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let now = berlin.with_ymd_and_hms(2026, 10, 11, 0, 30, 0).unwrap();
        let db = Database::open_in_memory().unwrap();
        assert!(seed(&db, now).unwrap());
        let days: Vec<_> = db.page_tree().unwrap().iter().flat_map(walk).filter_map(|p| p.daily_date.clone()).collect();
        assert_eq!(days, ["2026-10-11"]);
    }

    fn walk(n: &crate::model::PageNode) -> Vec<crate::model::Page> {
        std::iter::once(n.page.clone()).chain(n.children.iter().flat_map(walk)).collect()
    }

    #[test]
    fn remove_keeps_trashed_user_pages() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, Utc::now()).unwrap();
        let cats = db.page_by_title("SAP CATS Leitfaden").unwrap().unwrap();
        let mine = db.create_page(Some(cats.id), "Meine Notiz", None).unwrap();
        let sub = db.create_page(Some(mine.id), "Unterseite", None).unwrap();
        db.trash_page(mine.id).unwrap();
        remove(&db).unwrap();
        assert!(db.page_by_title("Wissensbasis").unwrap().is_none(), "sample subtree is gone");
        let trash = db.list_trash().unwrap();
        let entry = trash.iter().find(|e| e.page.id == mine.id).expect("the user's page stays in the trash");
        assert_eq!(entry.descendants, 1);
        assert_eq!(db.page(mine.id).unwrap().parent_id, None);
        assert_eq!(db.page(sub.id).unwrap().parent_id, Some(mine.id));
        assert_eq!(db.restore_page(mine.id).unwrap().parent_id, None);
        // The feed keeps the user's pages and forgets the samples.
        let feed = crate::feed::list(&db, &Default::default()).unwrap();
        assert!(feed.iter().any(|a| a.page_id == Some(mine.id)));
        assert!(!feed.iter().any(|a| a.title == "SAP CATS Leitfaden" || a.kind.starts_with("entry_")), "{feed:?}");
    }

    #[test]
    fn remove_keeps_user_pages_with_sample_titles_and_trashes_the_samples() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, Utc::now()).unwrap();
        // The user's own pages that happen to have a sample's title.
        let meeting = db.create_page(None, "Besprechung", None).unwrap();
        db.save_page_content(meeting.id, "Meine Notizen zur Besprechung\n").unwrap();
        let projects = db.create_page(None, "Projekte", Some("folder-kanban")).unwrap();
        db.save_page_content(projects.id, "Meine Projektliste\n").unwrap();
        // Text written into a sample page.
        let welcome = db.page_by_title("Willkommen").unwrap().unwrap();
        db.save_page_content(welcome.id, "Meine Gedanken\n").unwrap();
        remove(&db).unwrap();
        assert_eq!(db.page_doc(meeting.id).unwrap().content, "Meine Notizen zur Besprechung\n");
        assert_eq!(db.page_doc(projects.id).unwrap().content, "Meine Projektliste\n");
        assert!(
            db.page(meeting.id).unwrap().deleted_at.is_none() && db.page(projects.id).unwrap().deleted_at.is_none()
        );
        // The samples are in the trash, not gone: what was written into them comes back.
        assert!(db.page(welcome.id).unwrap().deleted_at.is_some());
        db.restore_page(welcome.id).unwrap();
        assert_eq!(db.page_doc(welcome.id).unwrap().content, "Meine Gedanken\n");
        let kb =
            db.list_trash().unwrap().into_iter().find(|e| e.page.title == "Wissensbasis").expect("sample in the trash");
        assert_eq!(kb.descendants, 1, "with its subpage");
    }

    #[test]
    fn samples_seeded_without_their_ids_are_told_by_title_and_icon() {
        let db = Database::open_in_memory().unwrap();
        seed(&db, Utc::now()).unwrap();
        db.conn().execute("DELETE FROM settings WHERE key = 'meta.demo_pages'", []).unwrap();
        let mine = db.create_page(None, "Meeting", None).unwrap();
        db.save_page_content(mine.id, "Notes\n").unwrap();
        let n = remove(&db).unwrap();
        assert_eq!(n, 4, "Willkommen, Projekte, the Wissensbasis and the Vorlagen subtree");
        assert!(db.page(mine.id).unwrap().deleted_at.is_none(), "the user's page stays");
        assert!(db.page_by_title("Architektur").unwrap().is_none());
    }
}
