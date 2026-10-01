//! Sample workspace used by `annalo demo` and the first launch of the app.

use crate::tr;
use chrono::{DateTime, Duration, Utc};

use crate::db::Database;
use crate::error::Result;
use crate::model::{EntrySource, NewTimeEntry};

/// Seeds the samples on explicit request (`annalo demo`), even if they were removed before.
pub fn seed_explicit(db: &Database, now: DateTime<Utc>) -> Result<bool> {
    db.conn().execute("DELETE FROM settings WHERE key = 'meta.demo_seeded'", [])?;
    seed(db, now)
}

/// Seeds a project with a Netzplan, Vorgänge, time entries and pages.
/// Runs once per workspace: never again after the user removed the samples,
/// and not at all if the workspace already had projects.
pub fn seed(db: &Database, now: DateTime<Utc>) -> Result<bool> {
    if db.meta_get("demo_seeded")?.is_some() {
        return Ok(false);
    }
    db.meta_set("demo_seeded", "1")?;
    if !db.list_projects()?.is_empty() {
        return Ok(false);
    }
    // The samples come in the display language (codes and numbers are the same in both).
    let p = db.create_project("PRJ-2026-X", "Annalo Rollout")?;
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
        ("1030", tr!("Schnittstellen-Design", "Interface design"), 4.0, 24.0, &["1010"][..]),
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
        (np.id, "1030", "DEV", 2, 6, 360, tr!("OpenAPI Spezifikation", "OpenAPI specification")),
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
            "Annalo ist dein lokaler Arbeitsbereich für Notizen, Projekte und Zeiterfassung.\n\n\
             ## So arbeitest du hier\n\n\
             - Notizen sind Markdown. Verlinke Seiten mit `[[Seitenname]]` und verschlagworte mit `#tag`.\n\
             - Zeit buchst du direkt im Text: tippe `/zeit NP-8801/1020 1.5h Review` und drücke Enter.\n\
             - `Ctrl K` öffnet die Befehlspalette, `Ctrl O` den Schnellwechsler, `Alt Space` funktioniert global.\n\
             - Der Assistent rechts kennt deine Notizen und Zeitlogs. Server und Token stellst du in den Einstellungen ein.\n\n\
             ## Einstieg\n\n\
             - [ ] LiteLLM-Server in den Einstellungen verbinden\n\
             - [ ] Obsidian-Vault importieren\n\
             - [ ] Erstes Projekt unter [[PRJ-2026-X Rollout]] ansehen\n",
            "Annalo is your local workspace for notes, projects and time tracking.\n\n\
             ## How you work here\n\n\
             - Notes are Markdown. Link pages with `[[Page name]]` and tag them with `#tag`.\n\
             - You book time right in the text: type `/time NP-8801/1020 1.5h Review` and press Enter.\n\
             - `Ctrl K` opens the command palette, `Ctrl O` the quick switcher, `Alt Space` works everywhere.\n\
             - The assistant on the right knows your notes and time logs. Set up the server and token in the settings.\n\n\
             ## Getting started\n\n\
             - [ ] Connect a LiteLLM server in the settings\n\
             - [ ] Import an Obsidian vault\n\
             - [ ] Look at the first project under [[PRJ-2026-X Rollout]]\n"
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
             ```powershell\nGet-Service -Name 'Annalo*' | Restart-Service\n```\n",
            "The middleware connects the ERP to the order portal through IDocs. #architecture\n\n\
             ## Components\n\n\
             - **Inbound**: IDoc receipt, mapping to the canonical data model\n\
             - **Queue**: persistent processing with retry\n\
             - **Outbound**: REST interface order data (OpenAPI 3.1)\n\n\
             > **Risk:** Activity 1020 is on the critical path. A delay moves the acceptance.\n\n\
             ## Operations\n\n\
             ```powershell\nGet-Service -Name 'Annalo*' | Restart-Service\n```\n"
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
             ## Beschlüsse\n\n- \n\n\
             ## Aufgaben\n\n- [ ] \n\n\
             > [!tip] Zeit buchen\n> Tippe `/zeit NP-8801/1020 1h Besprechung` und drücke Enter.\n",
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
    db.daily_note(now.date_naive())?;
    Ok(true)
}

/// Titles of the pages created by [`seed`], in both languages.
const DEMO_PAGES: &[&str] = &[
    "Willkommen",
    "Projekte",
    "PRJ-2026-X Rollout",
    "Architektur",
    "Jour fixe 22.09.",
    "Wissensbasis",
    "SAP CATS Leitfaden",
    crate::templates::TEMPLATES_TITLE,
    "Besprechung",
    "Kundentermin",
    "Welcome",
    "Weekly sync 22.09.",
    "Projects",
    "Architecture",
    "Knowledge base",
    "SAP CATS guide",
    crate::templates::TEMPLATES_TITLE_EN,
    "Meeting",
    "Customer meeting",
];

/// Removes the sample project (with its time entries) and the sample pages.
/// Daily notes and everything the user created are kept. Returns the number of removed subtrees.
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
        // Delete sample subtrees top-down, but keep any page that has user content below it.
        fn is_demo(n: &crate::model::PageNode) -> bool {
            n.page.daily_date.is_none() && DEMO_PAGES.contains(&n.page.title.as_str())
        }
        fn only_demo(n: &crate::model::PageNode) -> bool {
            is_demo(n) && n.children.iter().all(only_demo)
        }
        fn sweep(db: &Database, nodes: &[crate::model::PageNode], removed: &mut usize) -> Result<()> {
            for n in nodes {
                if only_demo(n) {
                    // Trashed pages below a sample page belong to the user: move them to the top level
                    // so the delete cascade spares them and they stay in the trash.
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
                    db.delete_page(n.page.id)?;
                    *removed += 1;
                } else {
                    sweep(db, &n.children, removed)?;
                }
            }
            Ok(())
        }
        let mut removed = 0;
        sweep(db, &db.page_tree()?, &mut removed)?;
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
        assert_eq!(trash.len(), 1);
        assert_eq!((trash[0].page.id, trash[0].descendants), (mine.id, 1));
        assert_eq!(db.page(mine.id).unwrap().parent_id, None);
        assert_eq!(db.page(sub.id).unwrap().parent_id, Some(mine.id));
        assert_eq!(db.restore_page(mine.id).unwrap().parent_id, None);
        // The feed keeps the user's pages and forgets the samples.
        let feed = crate::feed::list(&db, &Default::default()).unwrap();
        assert!(feed.iter().any(|a| a.page_id == Some(mine.id)));
        assert!(!feed.iter().any(|a| a.title == "SAP CATS Leitfaden" || a.kind.starts_with("entry_")), "{feed:?}");
    }
}
