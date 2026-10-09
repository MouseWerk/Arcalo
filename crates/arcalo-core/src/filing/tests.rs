use chrono::{NaiveDate, Utc};

use super::*;
use crate::i18n::with_lang;

fn day(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).unwrap()
}

fn path(db: &Database, id: i64) -> String {
    db.page_path(id).unwrap()
}

fn titles(segs: &[Segment]) -> Vec<String> {
    segs.iter().map(|s| s.title.clone()).collect()
}

#[test]
fn month_and_week_names_per_language() {
    assert_eq!(month_name(3, Language::De), "März");
    assert_eq!(month_name(3, Language::En), "March");
    assert_eq!(month_folder(10, Language::De), "10 – Oktober");
    assert_eq!(month_folder(10, Language::En), "10 – October");
    assert_eq!(month_folder(1, Language::De), "01 – Januar");
    assert_eq!(week_folder(5, Language::De), "KW 05");
    assert_eq!(week_folder(40, Language::En), "Week 40");
    // The number first: sorting by name is sorting by month.
    let mut names: Vec<String> = (1..=12).map(|m| month_folder(m, Language::De)).collect();
    let sorted = {
        let mut s = names.clone();
        s.sort();
        s
    };
    assert_eq!(names, sorted);
    names.reverse();
    assert_ne!(names, sorted);
}

#[test]
fn type_paths_per_granularity_and_language() {
    let info = |kind, group: Option<&str>| FileInfo { kind, date: day(2026, 10, 2), group: group.map(str::to_owned) };
    let month = TypeFiling { folder: String::new(), granularity: Granularity::Month };
    let journal = type_path(&month, &info(FileType::Journal, None), "Journal", &[], Language::De);
    assert_eq!(titles(&journal), ["Journal", "2026", "10 – Oktober"]);
    assert_eq!(journal[2].key.as_deref(), Some("m2026-10"));
    assert_eq!(journal[2].alts, ["10 – October"]);
    let en = type_path(&month, &info(FileType::Voice, None), "Voice notes", &[], Language::En);
    assert_eq!(titles(&en), ["Voice notes", "2026", "10 – October"]);

    let year = TypeFiling { folder: String::new(), granularity: Granularity::Year };
    assert_eq!(
        titles(&type_path(&year, &info(FileType::Mail, None), "E-Mails", &[], Language::De)),
        ["E-Mails", "2026"]
    );
    let week = TypeFiling { folder: String::new(), granularity: Granularity::Week };
    assert_eq!(
        titles(&type_path(&week, &info(FileType::Meeting, None), "Besprechungen", &[], Language::De)),
        ["Besprechungen", "2026", "KW 40"]
    );
    // Meetings by series, Jira always by project.
    let series = TypeFiling { folder: String::new(), granularity: Granularity::Series };
    assert_eq!(
        titles(&type_path(&series, &info(FileType::Meeting, Some("Jour fixe")), "Besprechungen", &[], Language::De)),
        ["Besprechungen", "Jour fixe"]
    );
    let none = TypeFiling::default();
    assert_eq!(
        titles(&type_path(&none, &info(FileType::Jira, Some("ABC Portal")), "Jira", &[], Language::De)),
        ["Jira", "ABC Portal"]
    );
    // A root path, and the inbox at the top level.
    assert_eq!(
        titles(&type_path(&year, &info(FileType::Journal, None), "Arbeit/Journal", &[], Language::De)),
        ["Arbeit", "Journal", "2026"]
    );
    assert!(type_path(&none, &info(FileType::Inbox, None), "", &[], Language::De).is_empty());
    assert_eq!(series_name("Jour fixe 02.10.2026 2"), "Jour fixe");
    assert_eq!(series_name("Weekly sync 2026-10-02"), "Weekly sync");
}

#[test]
fn new_pages_land_in_their_folders_in_both_languages() {
    let db = Database::open_in_memory().unwrap();
    let daily = db.daily_note(day(2026, 10, 2)).unwrap();
    assert_eq!(path(&db, daily.id), "Journal / 2026 / 10 – Oktober");
    // The same month in English finds the German folder by its key; a new month is English.
    let en = with_lang(Language::En, || {
        let a = db.daily_note(day(2026, 10, 3)).unwrap();
        let b = db.daily_note(day(2026, 11, 1)).unwrap();
        (a, b)
    });
    assert_eq!(en.0.parent_id, daily.parent_id);
    assert_eq!(path(&db, en.1.id), "Journal / 2026 / 11 – November");
    // Newest month first, newest day first.
    let year = db.page(daily.parent_id.unwrap()).unwrap().parent_id.unwrap();
    let months: Vec<String> =
        db.page_tree().unwrap()[0].children[0].children.iter().map(|n| n.page.title.clone()).collect();
    assert_eq!(db.page_tree().unwrap()[0].children[0].page.id, year);
    assert_eq!(months, ["11 – November", "10 – Oktober"]);

    // Voice notes in English, a workspace without the German folder.
    let voice = with_lang(Language::En, || {
        db.voice_begin(None, day(2026, 10, 2).and_hms_opt(9, 0, 0).unwrap(), None, "t").unwrap()
    });
    assert_eq!(path(&db, voice.id), "Voice notes / 2026 / 10 – October");
    let folders: Vec<Option<String>> = db
        .conn()
        .prepare("SELECT system_key FROM pages WHERE system_folder = 'voice' ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    assert_eq!(folders, [Some("root".into()), Some("y2026".into()), Some("m2026-10".into())]);
}

#[test]
fn an_existing_root_is_reused_and_adopted() {
    let db = Database::open_in_memory().unwrap();
    let mine = db.create_page(None, "Meetings", Some("users")).unwrap();
    let old = db.create_page(Some(mine.id), "Old note", None).unwrap();
    let p = db.create_page(None, "Kickoff 02.10.2026", None).unwrap();
    db.file_page(p.id, &FileInfo { kind: FileType::Meeting, date: day(2026, 10, 2), group: Some("Kickoff".into()) })
        .unwrap();
    assert_eq!(path(&db, p.id), "Meetings / 2026 / 10 – Oktober");
    assert_eq!(db.page(mine.id).unwrap().title, "Meetings", "never renamed");
    assert_eq!(db.page(old.id).unwrap().parent_id, Some(mine.id), "existing pages stay");

    // By series instead.
    let mut s = db.load_settings().unwrap();
    s.filing.types.insert(FileType::Meeting, TypeFiling { folder: String::new(), granularity: Granularity::Series });
    db.save_settings(&s).unwrap();
    let q = db.create_page(None, "Kickoff 09.10.2026", None).unwrap();
    db.file_page(q.id, &FileInfo { kind: FileType::Meeting, date: day(2026, 10, 9), group: Some("Kickoff".into()) })
        .unwrap();
    assert_eq!(path(&db, q.id), "Meetings / Kickoff");

    // Jira notes by project.
    let j = db.create_page(None, "ABC-12 Login", None).unwrap();
    db.save_page_content(j.id, "---\njira: ABC-12\n---\n").unwrap();
    db.file_page(
        j.id,
        &FileInfo { kind: FileType::Jira, date: day(2026, 10, 2), group: Some(db.jira_group("ABC-12").unwrap()) },
    )
    .unwrap();
    assert_eq!(path(&db, j.id), "Jira / ABC");
}

#[test]
fn rules_come_first_in_order() {
    let db = Database::open_in_memory().unwrap();
    let mut s = db.load_settings().unwrap();
    let rule = |kind, key: &str, value: &str, folder: &str| FilingRule {
        id: String::new(),
        kind,
        key: key.into(),
        value: value.into(),
        folder: folder.into(),
        enabled: true,
    };
    s.filing.rules = vec![
        rule(RuleKind::Tag, "#kunde-x", "", "Kunden / X"),
        rule(RuleKind::Tag, "kunde-x", "", "never"),
        rule(RuleKind::Property, "status", "Offen", "Offen"),
        rule(RuleKind::Jira, "ABC", "", "Projekte/ABC"),
        rule(RuleKind::Netzplan, "NP-1", "", "Projekte/NP-1"),
        rule(RuleKind::Title, "Angebot", "", "Vertrieb"),
        rule(RuleKind::Title, "", "", "dropped"),
    ];
    s.filing = s.filing.clone().normalized();
    db.save_settings(&s).unwrap();
    let s = db.load_settings().unwrap();
    assert_eq!(s.filing.rules.len(), 6, "a rule without key is dropped");
    assert_eq!(s.filing.rules[0].folder, "Kunden/X");
    assert_eq!(s.filing.rules[0].key, "kunde-x");
    assert!(s.filing.rules.iter().all(|r| !r.id.is_empty()));

    let facts = |title: &str, tags: &[&str], content: &str| PageFacts {
        title: title.into(),
        tags: tags.iter().map(|t| (*t).to_owned()).collect(),
        content: content.into(),
    };
    let target = |f: &PageFacts| filing_target(&s, f, None).map(|t| t.path());
    assert_eq!(target(&facts("A", &["kunde-x/projekt"], "")).as_deref(), Some("Kunden / X"));
    assert_eq!(target(&facts("A", &[], "---\nstatus: offen\n---\n")).as_deref(), Some("Offen"));
    assert_eq!(target(&facts("ABC-7 Fix", &[], "")).as_deref(), Some("Projekte / ABC"));
    assert_eq!(target(&facts("x", &[], "---\njira: ABC-9\n---\n")).as_deref(), Some("Projekte / ABC"));
    assert_eq!(target(&facts("x", &[], "---\nvorgang: NP-1/0010\n---\n")).as_deref(), Some("Projekte / NP-1"));
    assert_eq!(target(&facts("Angebot Müller", &[], "")).as_deref(), Some("Vertrieb"));
    assert_eq!(target(&facts("Sonstiges", &[], "")), None);

    // On create: the rule wins over the type's folder.
    let p = db.create_page(None, "Sprachnotiz", None).unwrap();
    db.save_page_content(p.id, "Notiz #kunde-x").unwrap();
    db.file_page(p.id, &FileInfo { kind: FileType::Voice, date: day(2026, 10, 2), group: None }).unwrap();
    assert_eq!(path(&db, p.id), "Kunden / X");
    // The preview of a page with unsaved rules.
    let mut other = s.filing.clone();
    other.rules.remove(0);
    other.rules.remove(0);
    let pv = db.filing_preview(p.id, &other).unwrap();
    assert_eq!(pv.kind, Some(FileType::Voice));
    assert_eq!(pv.path.as_deref(), Some("Sprachnotizen / 2026 / 10 – Oktober"));
    assert_eq!(pv.current, "Kunden / X");
}

#[test]
fn tidy_up_plans_applies_and_undoes() {
    let db = Database::open_in_memory().unwrap();
    // Before 1.9: daily notes flat in the Journal, a meeting note at the top level of
    // „Besprechungen“, a page the user put into a folder of their own.
    let journal = db.create_page(None, "Journal", None).unwrap();
    let d1 = db.create_page(Some(journal.id), "01.09.2026", None).unwrap();
    let d2 = db.create_page(Some(journal.id), "02.10.2026", None).unwrap();
    for (p, d) in [(d1.id, "2026-09-01"), (d2.id, "2026-10-02")] {
        db.conn()
            .execute(
                "UPDATE pages SET daily_date = ?2, created_at = ?2 || 'T08:00:00Z' WHERE id = ?1",
                rusqlite::params![p, d],
            )
            .unwrap();
    }
    let meetings = db.create_page(None, "Besprechungen", None).unwrap();
    let m = db.create_page(Some(meetings.id), "Kickoff 02.10.2026", None).unwrap();
    db.conn().execute("UPDATE pages SET created_at = '2026-10-02T08:00:00Z' WHERE id = ?1", [m.id]).unwrap();
    let project = db.create_page(None, "Projekt X", None).unwrap();
    let placed = db.create_page(Some(project.id), "05.10.2026", None).unwrap();
    db.conn().execute("UPDATE pages SET daily_date = '2026-10-05' WHERE id = ?1", [placed.id]).unwrap();
    let tagged = db.create_page(Some(project.id), "Notiz", None).unwrap();
    db.save_page_content(tagged.id, "#archiv").unwrap();
    let loose = db.create_page(None, "Lose", None).unwrap();

    let plan = db.tidy_plan(None).unwrap();
    let ids: Vec<i64> = plan.iter().map(|m| m.page_id).collect();
    assert!(ids.contains(&d1.id) && ids.contains(&d2.id) && ids.contains(&m.id), "{plan:?}");
    assert!(!ids.contains(&placed.id), "a page the user placed stays");
    assert!(!ids.contains(&tagged.id) && !ids.contains(&loose.id));
    let d1m = plan.iter().find(|p| p.page_id == d1.id).unwrap();
    assert_eq!((d1m.from.as_str(), d1m.to.as_str()), ("Journal", "Journal / 2026 / 09 – September"));
    assert!(d1m.creates);
    assert_eq!(plan.iter().find(|p| p.page_id == m.id).unwrap().to, "Besprechungen / 2026 / 10 – Oktober");

    // An explicit rule takes a page out of the user's folder.
    let mut s = db.load_settings().unwrap();
    s.filing.rules.push(FilingRule {
        id: "a".into(),
        kind: RuleKind::Tag,
        key: "archiv".into(),
        value: String::new(),
        folder: "Archiv".into(),
        enabled: true,
    });
    db.save_settings(&s).unwrap();
    let plan = db.tidy_plan(None).unwrap();
    let t = plan.iter().find(|p| p.page_id == tagged.id).expect("rule move");
    assert_eq!((t.from.as_str(), t.to.as_str(), t.rule.as_deref()), ("Projekt X", "Archiv", Some("a")));
    // Scoped to a folder.
    assert!(db.tidy_plan(Some(meetings.id)).unwrap().iter().all(|p| p.page_id == m.id));

    // Apply all but the meeting note.
    let before = db.page_tree().unwrap();
    let chosen: Vec<i64> = plan.iter().map(|p| p.page_id).filter(|id| *id != m.id).collect();
    let out = db.tidy_apply(None, &chosen).unwrap();
    assert_eq!(out.moved, 3);
    assert_eq!(out.folders, 4, "2026, two months, Archiv");
    assert_eq!(path(&db, d2.id), "Journal / 2026 / 10 – Oktober");
    assert_eq!(path(&db, tagged.id), "Archiv");
    assert_eq!(db.page(m.id).unwrap().parent_id, Some(meetings.id));
    assert_eq!(db.page(journal.id).unwrap().title, "Journal");
    assert_eq!(db.last_move().unwrap(), Some(LastMove { label: "tidy".into(), pages: 3 }));
    // Nothing left to do for them.
    assert!(db.tidy_plan(None).unwrap().iter().all(|p| p.page_id == m.id));

    // Undo: back where they were, the new folders gone.
    assert_eq!(db.undo_last_move().unwrap(), 3);
    let strip = |t: Vec<crate::model::PageNode>| -> Vec<(i64, Vec<i64>)> {
        fn walk(n: &[crate::model::PageNode], out: &mut Vec<(i64, Vec<i64>)>) {
            for x in n {
                out.push((x.page.id, x.children.iter().map(|c| c.page.id).collect()));
                walk(&x.children, out);
            }
        }
        let mut out = vec![];
        walk(&t, &mut out);
        out
    };
    assert_eq!(strip(db.page_tree().unwrap()), strip(before));
    assert_eq!(db.last_move().unwrap(), None);
}

#[test]
fn moving_many_keeps_links_and_undo() {
    let db = Database::open_in_memory().unwrap();
    let a = db.create_page(None, "Alpha", None).unwrap();
    let b = db.create_page(None, "Beta", None).unwrap();
    let c = db.create_page(Some(b.id), "Gamma", None).unwrap();
    let target = db.create_page(None, "Ziel", None).unwrap();
    db.save_page_content(a.id, "Siehe [[Beta]] und [[Gamma]]").unwrap();
    db.save_page_content(c.id, "Zurück zu [[Alpha]]").unwrap();

    // Gamma goes along with Beta; nothing into itself.
    let out = db.move_pages(&[b.id, c.id, a.id, target.id], Some(target.id)).unwrap();
    assert_eq!(out.moved, 2);
    assert_eq!(db.page(c.id).unwrap().parent_id, Some(b.id));
    assert_eq!(path(&db, c.id), "Ziel / Beta");
    // Links go by title: they still resolve after the move, in both directions.
    let doc = db.page_doc(a.id).unwrap();
    assert!(doc.unresolved_links.is_empty(), "{:?}", doc.unresolved_links);
    assert_eq!(db.page_doc(b.id).unwrap().backlinks.len(), 1);
    assert_eq!(db.page_doc(a.id).unwrap().backlinks.len(), 1);
    assert_eq!(db.page_by_title("Gamma").unwrap().map(|p| p.id), Some(c.id));

    assert_eq!(db.undo_last_move().unwrap(), 2);
    assert_eq!(db.page(a.id).unwrap().parent_id, None);
    assert_eq!(db.page(b.id).unwrap().parent_id, None);
    assert!(db.move_pages(&[a.id], Some(target.id)).is_ok());
}

#[test]
fn the_mirror_follows_a_move() {
    let base = std::env::temp_dir().join(format!("arcalo-filing-mirror-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&base);
    let db = Database::open_in_memory().unwrap();
    let folder = db.create_page(None, "Ordner", None).unwrap();
    let note = db.create_page(None, "Notiz", None).unwrap();
    db.save_page_content(note.id, "Text mit [[Ordner]]").unwrap();
    db.save_page_content(folder.id, "Ordnertext").unwrap();
    let att = base.join("att");
    std::fs::create_dir_all(&att).unwrap();
    let target = base.join("mirror");
    crate::mirror::write_mirror(&db, &target, &att, &Utc).unwrap();
    assert!(target.join("Notiz.md").exists());

    db.move_pages(&[note.id], Some(folder.id)).unwrap();
    crate::mirror::write_mirror(&db, &target, &att, &Utc).unwrap();
    assert!(!target.join("Notiz.md").exists(), "no copy left behind");
    assert_eq!(std::fs::read_to_string(target.join("Ordner/Notiz.md")).unwrap(), "Text mit [[Ordner]]");
    assert_eq!(std::fs::read_to_string(target.join("Ordner.md")).unwrap(), "Ordnertext");

    // The Git working tree gets one removal and one addition of the same bytes (Git records a
    // rename), nothing else is rewritten.
    let repo = base.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    let first = base.join("first");
    db.undo_last_move().unwrap();
    crate::mirror::write_mirror(&db, &first, &att, &Utc).unwrap();
    crate::gitsync::sync_tree(&first, &repo, true).unwrap();
    let moved = crate::gitsync::sync_tree(&target, &repo, true).unwrap();
    assert_eq!((moved.added, moved.removed, moved.updated), (1, 1, 0), "only Notiz moved");
    let _ = std::fs::remove_dir_all(&base);
}

#[test]
fn smart_folders() {
    let db = Database::open_in_memory().unwrap();
    let a = db.create_page(None, "Alpha", None).unwrap();
    let b = db.create_page(None, "Beta", None).unwrap();
    let f = db.create_page(None, "Ordner", None).unwrap();
    let c = db.create_page(Some(f.id), "Übersicht", None).unwrap();
    let d = db.create_page(Some(f.id), "Delta", None).unwrap();
    db.save_page_content(a.id, "Link [[Übersicht]] #kunde").unwrap();
    db.save_page_content(b.id, "---\njira: ABC-1\nvorgang: NP-1/0010\n---\nText #kunde").unwrap();
    db.save_page_content(d.id, "---\nnetzplan: NP-2\n---\n").unwrap();
    db.set_favorite(b.id, true).unwrap();

    let ids = |v: Vec<SmartPage>| -> Vec<i64> { v.into_iter().map(|p| p.id).collect() };
    assert_eq!(ids(db.smart_pages(SmartKind::Favorites, None).unwrap()), [b.id]);
    assert_eq!(ids(db.smart_pages(SmartKind::Unfiled, None).unwrap()), [a.id, b.id]);
    // Alpha links out, Übersicht is linked to (non-ASCII title), Beta and Delta are orphans.
    let mut orphans = ids(db.smart_pages(SmartKind::Orphans, None).unwrap());
    orphans.sort();
    assert_eq!(orphans, [b.id, d.id]);
    let tags = db.smart_groups(SmartKind::Tags).unwrap();
    assert_eq!(tags, [SmartGroup { key: "kunde".into(), label: "#kunde".into(), count: 2 }]);
    assert_eq!(db.smart_pages(SmartKind::Tags, Some("kunde")).unwrap().len(), 2);
    let jira = db.smart_groups(SmartKind::Jira).unwrap();
    assert_eq!((jira[0].key.as_str(), jira[0].count), ("ABC", 1));
    assert_eq!(ids(db.smart_pages(SmartKind::Jira, Some("abc")).unwrap()), [b.id]);
    let np: Vec<String> = db.smart_groups(SmartKind::Netzplan).unwrap().into_iter().map(|g| g.key).collect();
    assert_eq!(np, ["NP-1", "NP-2"]);
    assert_eq!(ids(db.smart_pages(SmartKind::Netzplan, Some("NP-2")).unwrap()), [d.id]);
    let counts = db.smart_counts().unwrap();
    assert_eq!(
        (counts.favorites, counts.unfiled, counts.orphans, counts.tags, counts.jira, counts.netzplan),
        (1, 2, 2, 1, 1, 2)
    );
    assert_eq!(counts.recent, 3);
    let _ = c;
}

#[test]
fn folder_styles_and_filed_pages() {
    let db = Database::open_in_memory().unwrap();
    let f = db.create_page(None, "Ordner", None).unwrap();
    let style = FolderStyle { sort: "name".into(), folders_first: true, color: Some("danger".into()) };
    db.set_folder_style(f.id, &style).unwrap();
    db.set_folder_style(0, &FolderStyle { sort: "bogus".into(), folders_first: false, color: Some("pink".into()) })
        .unwrap();
    assert_eq!(db.folder_style(f.id).unwrap(), style);
    assert_eq!(db.folder_style(0).unwrap(), FolderStyle::default(), "invalid values fall back");
    let node = db.page_tree().unwrap().into_iter().find(|n| n.page.id == f.id).unwrap();
    assert_eq!(node.style, Some(style));
    assert!(!node.created_at.is_empty());

    let (page, created) =
        db.create_filed_page(FileType::Bookmarks, "Links", Some("link"), "- a", day(2026, 10, 2)).unwrap();
    assert_eq!(path(&db, page.id), "Lesezeichen");
    assert_eq!(created.len(), 1);
    let (again, created) =
        db.create_filed_page(FileType::Bookmarks, "Links", Some("link"), "", day(2026, 10, 2)).unwrap();
    assert_eq!((again.title.as_str(), created.len()), ("Links 2", 0));
    assert_eq!(db.page(again.id).unwrap().parent_id, db.page(page.id).unwrap().parent_id);
    // The inbox stays at the top level by default.
    let (inbox, _) = db.create_filed_page(FileType::Inbox, "Eingang", None, "", day(2026, 10, 2)).unwrap();
    assert_eq!(db.page(inbox.id).unwrap().parent_id, None);
    // Purging the folder removes its style.
    db.delete_page(f.id).unwrap();
    let n: i64 =
        db.conn().query_row("SELECT COUNT(*) FROM folder_prefs WHERE page_id = ?1", [f.id], |r| r.get(0)).unwrap();
    assert_eq!(n, 0);
}

#[test]
fn five_thousand_pages_stay_fast() {
    let db = Database::open_in_memory().unwrap();
    db.atomic(|| {
        let journal = db.create_page(None, "Journal", None)?;
        for i in 0..5000 {
            let parent = if i % 2 == 0 { Some(journal.id) } else { None };
            db.conn().execute(
                "INSERT INTO pages (parent_id, title, position, content, daily_date) VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    parent,
                    format!("Seite {i}"),
                    i,
                    if i % 3 == 0 { "---\njira: ABC-1\n---\n" } else { "Text" },
                    (i % 2 == 0)
                        .then(|| (day(2020, 1, 1) + chrono::Duration::days(i / 2)).format("%Y-%m-%d").to_string()),
                ],
            )?;
        }
        Ok(())
    })
    .unwrap();
    let t = std::time::Instant::now();
    assert_eq!(db.page_tree().unwrap().len(), 2501);
    let counts = db.smart_counts().unwrap();
    assert_eq!(counts.jira, 1);
    assert!(counts.unfiled >= 2500);
    let plan = db.tidy_plan(None).unwrap();
    assert_eq!(plan.iter().filter(|m| m.kind == Some(FileType::Journal)).count(), 2500);
    let out = db.tidy_apply(None, &plan.iter().map(|m| m.page_id).collect::<Vec<_>>()).unwrap();
    assert!(out.moved >= 2500);
    assert!(t.elapsed() < std::time::Duration::from_secs(12), "{:?}", t.elapsed());
}

#[test]
fn undo_leaves_pages_moved_by_hand_since() {
    let db = Database::open_in_memory().unwrap();
    let a = db.create_page(None, "Alpha", None).unwrap();
    let b = db.create_page(None, "Beta", None).unwrap();
    let target = db.create_page(None, "Ziel", None).unwrap();
    let elsewhere = db.create_page(None, "Woanders", None).unwrap();
    assert_eq!(db.move_pages(&[a.id, b.id], Some(target.id)).unwrap().moved, 2);
    // Beta is put elsewhere by hand after the bulk move: the undo leaves it there.
    db.move_page(b.id, Some(elsewhere.id), 0).unwrap();
    assert_eq!(db.undo_last_move().unwrap(), 1);
    assert_eq!(db.page(a.id).unwrap().parent_id, None);
    assert_eq!(db.page(b.id).unwrap().parent_id, Some(elsewhere.id));
}

#[test]
fn moving_many_to_a_position_keeps_their_order_there() {
    let db = Database::open_in_memory().unwrap();
    let folder = db.create_page(None, "Ordner", None).unwrap();
    let kids: Vec<i64> =
        ["Eins", "Zwei", "Drei"].iter().map(|n| db.create_page(Some(folder.id), n, None).unwrap().id).collect();
    let x = db.create_page(None, "X", None).unwrap();
    let y = db.create_page(None, "Y", None).unwrap();
    let order = |db: &Database| -> Vec<String> {
        let mut c: Vec<_> = db.list_pages().unwrap().into_iter().filter(|p| p.parent_id == Some(folder.id)).collect();
        c.sort_by_key(|p| p.position);
        c.into_iter().map(|p| p.title).collect()
    };
    // Dropped after „Eins“ (position 1 among the pages that stay).
    db.move_pages_at(&[y.id, x.id], Some(folder.id), Some(1)).unwrap();
    assert_eq!(order(&db), ["Eins", "Y", "X", "Zwei", "Drei"]);
    // Pages of the same folder are reordered by a drop at a position.
    db.move_pages_at(&[kids[2], kids[0]], Some(folder.id), Some(0)).unwrap();
    assert_eq!(order(&db), ["Drei", "Eins", "Y", "X", "Zwei"]);
}

#[test]
fn tidy_files_by_the_local_creation_day() {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_page(None, "Sprachnotiz", None).unwrap();
    // Created 00:30 on 1 November in Berlin: 23:30 on 31 October in UTC.
    db.conn()
        .execute(
            "UPDATE pages SET created_at = '2026-10-31T23:30:00Z', file_type = 'voice', file_date = NULL WHERE id = ?1",
            [p.id],
        )
        .unwrap();
    let in_berlin = tidy::Snapshot::read_in(&db, &chrono_tz::Europe::Berlin).unwrap();
    assert_eq!(in_berlin.info_of(&db, p.id).map(|i| i.date), Some(day(2026, 11, 1)));
    let in_utc = tidy::Snapshot::read_in(&db, &Utc).unwrap();
    assert_eq!(in_utc.info_of(&db, p.id).map(|i| i.date), Some(day(2026, 10, 31)));
}
