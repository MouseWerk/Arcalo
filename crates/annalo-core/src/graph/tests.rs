use super::*;

fn page(db: &Database, parent: Option<i64>, title: &str, content: &str) -> i64 {
    let p = db.create_page(parent, title, None).unwrap();
    if !content.is_empty() {
        db.save_page(p.id, content).unwrap();
    }
    p.id
}

fn ids(d: &GraphData) -> Vec<i64> {
    d.nodes.iter().map(|n| n.id).collect()
}

fn node(d: &GraphData, id: i64) -> &GraphNode {
    d.nodes.iter().find(|n| n.id == id).unwrap()
}

fn links(d: &GraphData) -> Vec<(i64, i64)> {
    let mut v: Vec<(i64, i64)> = d.links.iter().map(|l| (l.from, l.to)).collect();
    v.sort();
    v
}

/// Projekte/Portal links Kunde A and embeds Konzept; Konzept links a missing page and a file.
struct Ws {
    db: Database,
    projekte: i64,
    portal: i64,
    kunde: i64,
    konzept: i64,
    daily: i64,
}

fn workspace() -> Ws {
    let db = Database::open_in_memory().unwrap();
    let projekte = page(&db, None, "Projekte", "");
    let portal = page(
        &db,
        Some(projekte),
        "Portal",
        "---\njira: ABC-12\nnetzplan: NP-4711\n---\nSiehe [[Kunde A]] und ![[Konzept]] #projekt/portal",
    );
    let kunde = page(&db, None, "Kunde A", "Kunde mit [[Portal]] #kunde");
    let konzept = page(&db, Some(projekte), "Konzept", "Offen: [[Fehlt Noch]] und [[Angebot.pdf]] ![[skizze.png]]");
    let daily = db.daily_note(chrono::NaiveDate::from_ymd_opt(2026, 9, 1).unwrap()).unwrap().id;
    db.save_page(daily, "Heute [[Portal]]").unwrap();
    Ws { db, projekte, portal, kunde, konzept, daily }
}

#[test]
fn nodes_carry_their_attributes_and_links() {
    let w = workspace();
    let d = w.db.graph_data(&GraphFilter::default()).unwrap();
    // The folder „Projekte“ has no text of its own: no node, unless something links to it.
    assert!(!ids(&d).contains(&w.projekte));
    w.db.save_page(w.kunde, "Kunde mit [[Portal]] in [[Projekte]] #kunde").unwrap();
    assert!(ids(&w.db.graph_data(&GraphFilter::default()).unwrap()).contains(&w.projekte));
    w.db.save_page(w.kunde, "Kunde mit [[Portal]] #kunde").unwrap();
    assert!(ids(&d).contains(&w.daily));
    let p = node(&d, w.portal);
    assert_eq!(p.folder, "Projekte");
    assert_eq!(p.tags, ["projekt/portal"]);
    assert_eq!(p.jira.as_deref(), Some("ABC-12"));
    assert_eq!(p.netzplan, ["NP-4711"]);
    assert_eq!((p.links_in, p.links_out), (2, 2));
    assert!(node(&d, w.daily).daily);
    // Links and embeds are edges.
    assert_eq!(links(&d), {
        let mut v = vec![(w.portal, w.kunde), (w.portal, w.konzept), (w.kunde, w.portal), (w.daily, w.portal)];
        v.sort();
        v
    });
    // The missing page keeps its spelling; files are no ghosts and only come when asked for.
    assert_eq!(d.unresolved.len(), 1);
    assert_eq!(
        (d.unresolved[0].from, d.unresolved[0].key.as_str(), d.unresolved[0].title.as_str()),
        (w.konzept, "fehlt noch", "Fehlt Noch")
    );
    assert!(d.files.is_empty());
    let with_files = w.db.graph_data(&GraphFilter { attachments: true, ..Default::default() }).unwrap();
    let mut names: Vec<&str> = with_files.files.iter().map(|f| f.name.as_str()).collect();
    names.sort();
    assert_eq!(names, ["angebot.pdf", "skizze.png"]);
}

#[test]
fn filters_run_in_sql() {
    let w = workspace();
    let q = |f: GraphFilter| {
        let mut v = ids(&w.db.graph_data(&f).unwrap());
        v.sort();
        v
    };
    // A tag matches its subtags.
    assert_eq!(q(GraphFilter { tags: vec!["#projekt".into()], ..Default::default() }), [w.portal]);
    assert_eq!(q(GraphFilter { tags: vec!["kunde".into(), "projekt/portal".into()], ..Default::default() }), {
        let mut v = vec![w.portal, w.kunde];
        v.sort();
        v
    });
    // The folder's subtree.
    assert_eq!(q(GraphFilter { folder: Some(w.projekte), ..Default::default() }), [w.portal, w.konzept]);
    assert_eq!(q(GraphFilter { netzplan: Some("np-4711".into()), ..Default::default() }), [w.portal]);
    assert_eq!(q(GraphFilter { jira_project: Some("abc".into()), ..Default::default() }), [w.portal]);
    assert!(!q(GraphFilter { daily: false, ..Default::default() }).contains(&w.daily));
    // Date range on created or modified.
    w.db.conn().execute("UPDATE pages SET created_at = '2025-01-10T08:00:00Z' WHERE id = ?1", [w.kunde]).unwrap();
    let old = GraphFilter { date_field: GraphDateField::Created, to: Some("2025-12-31".into()), ..Default::default() };
    assert_eq!(q(old), [w.kunde]);
    let new =
        GraphFilter { date_field: GraphDateField::Created, from: Some("2026-01-01".into()), ..Default::default() };
    assert!(!q(new).contains(&w.kunde));
    // Only links between pages of the result are edges.
    let d = w.db.graph_data(&GraphFilter { folder: Some(w.projekte), ..Default::default() }).unwrap();
    assert_eq!(links(&d), [(w.portal, w.konzept)]);
}

#[test]
fn deleted_and_template_pages_are_left_out() {
    let w = workspace();
    let tpl = page(&w.db, None, crate::templates::TEMPLATES_TITLE, "");
    let t = page(&w.db, Some(tpl), "Besprechung", "[[Portal]] [[{{titel}}]]");
    w.db.delete_page(w.kunde).unwrap();
    let d = w.db.graph_data(&GraphFilter::default()).unwrap();
    assert!(!ids(&d).contains(&t) && !ids(&d).contains(&tpl) && !ids(&d).contains(&w.kunde));
    // The link to the deleted page is unresolved now.
    assert!(d.unresolved.iter().any(|g| g.from == w.portal && g.key == "kunde a"));
}

#[test]
fn titles_beyond_ascii_resolve_like_the_index() {
    let db = Database::open_in_memory().unwrap();
    let u = page(&db, None, "Übersicht", "x");
    let a = page(&db, None, "A", "[[übersicht]]");
    let d = db.graph_data(&GraphFilter::default()).unwrap();
    assert_eq!(links(&d), [(a, u)]);
    assert_eq!(node(&d, u).links_in, 1);
    assert!(d.unresolved.is_empty());
}

#[test]
fn patch_follows_saves_and_renames() {
    let w = workspace();
    let f = GraphFilter::default();
    // A save: the page with its new outgoing links.
    w.db.save_page(w.kunde, "Nur noch [[Konzept]]").unwrap();
    let p = w.db.graph_patch(&[w.kunde], &f).unwrap();
    // Pages linking to „Kunde A“ come along (their link counts and targets may change).
    let mut got = ids(&p);
    got.sort();
    assert_eq!(got, [w.portal, w.kunde]);
    assert!(p.links.contains(&GraphLink { from: w.kunde, to: w.konzept }));
    assert!(!p.links.contains(&GraphLink { from: w.kunde, to: w.portal }));
    assert_eq!(node(&p, w.kunde).links_out, 1);
    assert!(p.removed.is_empty());

    // A rename resolves the ghost „Fehlt Noch“: the linking page comes with the new edge.
    let n = page(&w.db, None, "Neu", "Text");
    w.db.rename_page_linked(n, "Fehlt Noch", false).unwrap();
    let p = w.db.graph_patch(&[n], &f).unwrap();
    assert!(ids(&p).contains(&w.konzept));
    assert!(p.links.contains(&GraphLink { from: w.konzept, to: n }));
    assert!(p.unresolved.iter().all(|g| g.key != "fehlt noch"));
    assert_eq!(node(&p, n).links_in, 1);

    // Out of the filter or deleted: removed.
    let only_projects = GraphFilter { folder: Some(w.projekte), ..Default::default() };
    let p = w.db.graph_patch(&[w.kunde], &only_projects).unwrap();
    assert_eq!(p.removed, [w.kunde]);
    w.db.delete_page(n).unwrap();
    let p = w.db.graph_patch(&[n], &f).unwrap();
    assert_eq!(p.removed, [n]);
}

#[test]
fn view_state_is_stored_per_workspace() {
    let db = Database::open_in_memory().unwrap();
    assert_eq!(db.graph_state("layout").unwrap(), None);
    let v = serde_json::json!({ "p:1": [1.5, -2.0] });
    db.set_graph_state("layout", &v).unwrap();
    assert_eq!(db.graph_state("layout").unwrap(), Some(v));
    assert!(db.set_graph_state("app", &serde_json::json!(1)).is_err());
}
