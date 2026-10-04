use super::jira::*;
use super::*;
use crate::tracking::{SlashContext, Thresholds, log_slash_command, log_slash_command_in};
use chrono::TimeZone;
use serde_json::json;

fn projects(list: &[&str]) -> HashSet<String> {
    list.iter().map(|s| (*s).to_owned()).collect()
}

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 9, 23, 15, 0, 0).unwrap()
}

fn cet() -> chrono::FixedOffset {
    chrono::FixedOffset::east_opt(2 * 3600).unwrap()
}

fn setup() -> Database {
    let db = Database::open_in_memory().unwrap();
    let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
    let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
    db.create_vorgang(np.id, "1010", "Konzept", 2.0, 4.0).unwrap();
    db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 6.0).unwrap();
    db
}

fn issue(key: &str, category: &str) -> Issue {
    Issue {
        site: "acme".into(),
        key: key.into(),
        summary: format!("Summary of {key}"),
        status: if category == "done" { "Done".into() } else { "In Progress".into() },
        status_category: category.into(),
        project_key: project_of(key).into(),
        project_name: "Project".into(),
        url: browse_url("https://acme.atlassian.net", key),
        ..Default::default()
    }
}

fn store(db: &Database, list: &[(Issue, &[&str])]) -> StoreOutcome {
    let mut f = Fetched::default();
    for (i, m) in list {
        let mut i = i.clone();
        i.matches = m.iter().map(|s| (*s).to_owned()).collect();
        f.issues.insert(i.key.clone(), i);
    }
    db.issues_store("acme", &f, now()).unwrap()
}

#[test]
fn a_failed_saved_search_keeps_the_issues_it_found_last_time() {
    let db = setup();
    store(&db, &[(issue("PROJ-1", "indeterminate"), &["mine", "q1"]), (issue("PROJ-2", "new"), &["q1", "q2"])]);
    // q1 fails now; q2 no longer finds PROJ-2, mine still finds PROJ-1.
    let mut f = Fetched::default();
    let mut i = issue("PROJ-1", "indeterminate");
    i.matches = vec!["mine".into()];
    f.issues.insert(i.key.clone(), i);
    f.failed.push(("q1".into(), "400".into()));
    db.issues_store("acme", &f, now()).unwrap();
    let matches = |key: &str| -> Vec<String> {
        let m: String = db.conn().query_row("SELECT matches FROM issues WHERE key = ?1", [key], |r| r.get(0)).unwrap();
        serde_json::from_str(&m).unwrap()
    };
    assert_eq!(matches("PROJ-1"), ["mine", "q1"]);
    assert_eq!(matches("PROJ-2"), ["q1"], "q2 ran and did not find it");
    // q1 works again and finds nothing: its issues go.
    store(&db, &[(issue("PROJ-1", "indeterminate"), &["mine"])]);
    assert_eq!(matches("PROJ-1"), ["mine"]);
    assert!(matches("PROJ-2").is_empty());
}

#[test]
fn switching_log_work_off_drops_the_waiting_worklogs_of_the_site() {
    let db = setup();
    let mut s = db.load_settings().unwrap();
    s.jira.sites.push(JiraSite { id: "acme".into(), name: "Acme".into(), log_work: true, ..Default::default() });
    db.save_settings(&s).unwrap();
    store(&db, &[(issue("PROJ-5", "new"), &["mine"])]);
    let a = log_slash_command(&db, "/zeit NP-8801/1020 45m PROJ-5 a", now(), &cet(), &Thresholds::default()).unwrap();
    let b = log_slash_command(&db, "/zeit NP-8801/1020 30m PROJ-5 b", now(), &cet(), &Thresholds::default()).unwrap();
    db.worklog_claim(b.entry.id).unwrap();
    db.worklog_posted(b.entry.id, "77").unwrap();
    assert_eq!(db.worklogs_due(now()).unwrap().len(), 1);
    assert_eq!(db.worklogs_cancel_site("acme").unwrap(), 1);
    assert!(db.worklogs_due(now() + Duration::days(1)).unwrap().is_empty());
    let e = db.issue_entries(&[a.entry.id, b.entry.id]).unwrap();
    let states: Vec<&str> = e.iter().map(|x| x.worklog_state.as_str()).collect();
    assert!(states.contains(&"none") && states.contains(&"posted"), "{states:?}");
}

// ------------------------------------------------------------------ JQL and URLs

#[test]
fn search_urls_for_cloud_and_server() {
    let cloud =
        search_url("https://acme.atlassian.net/", SiteKind::Cloud, DEFAULT_JQL, "summary", &PageAt::Token(None), 100);
    assert!(
        cloud.starts_with("https://acme.atlassian.net/rest/api/3/search/jql?jql=assignee+%3D+currentUser%28%29"),
        "{cloud}"
    );
    assert!(cloud.ends_with("&fields=summary&maxResults=100"), "first page has no token: {cloud}");
    let next =
        search_url("https://acme.atlassian.net", SiteKind::Cloud, "x", "f", &PageAt::Token(Some("abc=".into())), 50);
    assert!(next.ends_with("&maxResults=50&nextPageToken=abc%3D"), "{next}");
    let server =
        search_url("https://jira.firma.de/jira", SiteKind::Server, "project = A", "f", &PageAt::Start(200), 100);
    assert_eq!(
        server,
        "https://jira.firma.de/jira/rest/api/2/search?jql=project+%3D+A&fields=f&maxResults=100&startAt=200"
    );
    assert_eq!(api_url("jira.firma.de", SiteKind::Server, "/myself"), "https://jira.firma.de/rest/api/2/myself");
    assert_eq!(
        agile_url("https://x.atlassian.net/", "board?projectKeyOrId=A"),
        "https://x.atlassian.net/rest/agile/1.0/board?projectKeyOrId=A"
    );
    assert_eq!(browse_url("https://x.atlassian.net/", "A-1"), "https://x.atlassian.net/browse/A-1");
}

#[test]
fn jql_is_built_and_quoted() {
    assert_eq!(quote(r#"say "hi" \ now"#), r#""say \"hi\" \\ now""#);
    assert_eq!(text_jql("login fails"), r#"text ~ "login fails" ORDER BY updated DESC"#);
    assert_eq!(keys_jql(&["AB-1", "nope", "BC-22"]), "key in (AB-1, BC-22) ORDER BY key");
    assert_eq!(search_jql("PROJ-12"), "key = PROJ-12");
    assert_eq!(search_jql("project = PROJ AND status = Done"), "project = PROJ AND status = Done");
    assert_eq!(search_jql("assignee = currentUser()"), "assignee = currentUser()");
    assert_eq!(search_jql("Login Fehler"), r#"text ~ "Login Fehler" ORDER BY updated DESC"#);
}

#[test]
fn auth_headers() {
    assert_eq!(auth_header(SiteKind::Cloud, "me@x.de", "tok"), "Basic bWVAeC5kZTp0b2s=");
    assert_eq!(auth_header(SiteKind::Server, "", " pat "), "Bearer pat");
    assert_eq!(SiteKind::guess("acme.atlassian.net"), SiteKind::Cloud);
    assert_eq!(SiteKind::guess("https://jira.firma.de/"), SiteKind::Server);
    // Addresses copied from the browser keep only the site's base.
    for (raw, base) in [
        ("acme.atlassian.net", "https://acme.atlassian.net"),
        (
            "https://acme.atlassian.net/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-2",
            "https://acme.atlassian.net",
        ),
        ("https://acme.atlassian.net/browse/PROJ-123", "https://acme.atlassian.net"),
        ("https://jira.firma.de/browse/PROJ-123", "https://jira.firma.de"),
        ("https://jira.firma.de/jira/secure/Dashboard.jspa", "https://jira.firma.de/jira"),
        ("https://firma.de/jira/", "https://firma.de/jira"),
        ("http://jira:8080/projects/OPS/issues/OPS-7?filter=x", "http://jira:8080"),
        ("https://jira.firma.de/login.jsp#top", "https://jira.firma.de"),
        ("  https://jira  ", "https://jira"),
        ("", ""),
    ] {
        assert_eq!(normalize_url(raw), base, "{raw}");
    }
}

// ------------------------------------------------------------------ parsing

fn cloud_issue() -> serde_json::Value {
    json!({
        "id": "10001", "key": "PROJ-123",
        "fields": {
            "summary": "Login fails on SSO",
            "status": { "name": "In Progress", "statusCategory": { "key": "indeterminate" } },
            "priority": { "name": "High" },
            "assignee": { "displayName": "Mia Meyer", "accountId": "abc" },
            "reporter": { "displayName": "Tom" },
            "issuetype": { "name": "Bug" },
            "project": { "key": "PROJ", "name": "Portal" },
            "duedate": "2026-10-05",
            "updated": "2026-09-30T10:15:30.000+0200",
            "resolutiondate": null,
            "customfield_10020": [
                { "id": 1, "name": "Sprint 3", "state": "closed" },
                { "id": 2, "name": "Sprint 4", "state": "active" }
            ],
            "description": { "type": "doc", "version": 1, "content": [
                { "type": "heading", "attrs": { "level": 2 }, "content": [{ "type": "text", "text": "Steps" }] },
                { "type": "orderedList", "content": [
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Open " }, { "type": "text", "text": "login", "marks": [{ "type": "strong" }] }] }] },
                    { "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Click SSO" }] }] }
                ] },
                { "type": "paragraph", "content": [{ "type": "text", "text": "Seen by " }, { "type": "mention", "attrs": { "text": "@Tom" } }, { "type": "hardBreak" }, { "type": "text", "text": "twice" }] }
            ] },
            "comment": { "comments": (0..7).map(|n| json!({
                "author": { "displayName": format!("User {n}") },
                "created": "2026-09-29T08:00:00.000+0000",
                "body": { "type": "doc", "version": 1, "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": format!("Comment {n}") }] }] }
            })).collect::<Vec<_>>() }
        }
    })
}

#[test]
fn parses_a_cloud_v3_issue_with_adf() {
    let i = parse_issue(&cloud_issue(), "acme", "https://acme.atlassian.net", Some("customfield_10020")).unwrap();
    assert_eq!(
        (i.key.as_str(), i.summary.as_str(), i.status_category.as_str()),
        ("PROJ-123", "Login fails on SSO", "indeterminate")
    );
    assert_eq!(
        (i.priority.as_str(), i.assignee.as_str(), i.reporter.as_str(), i.issue_type.as_str()),
        ("High", "Mia Meyer", "Tom", "Bug")
    );
    assert_eq!((i.project_key.as_str(), i.project_name.as_str()), ("PROJ", "Portal"));
    assert_eq!((i.sprint.as_str(), i.sprint_state.as_str()), ("Sprint 4", "active"), "the active sprint wins");
    assert_eq!(i.due_date.as_deref(), Some("2026-10-05"));
    assert_eq!(i.updated.as_deref(), Some("2026-09-30T08:15:30Z"), "UTC");
    assert_eq!(i.url, "https://acme.atlassian.net/browse/PROJ-123");
    assert_eq!(i.description, "Steps\n\n1. Open login\n2. Click SSO\n\nSeen by @Tom\ntwice");
    assert_eq!(i.comments.len(), MAX_COMMENTS, "the newest comments only");
    assert_eq!((i.comments[0].body.as_str(), i.comments[4].author.as_str()), ("Comment 2", "User 6"));
    assert_eq!(i.comments[0].created, "2026-09-29T08:00:00Z");
}

#[test]
fn parses_a_server_v2_issue_with_wiki_markup() {
    let v = json!({
        "id": "200", "key": "OPS-7",
        "fields": {
            "summary": "Backup job", "status": { "name": "Erledigt", "statusCategory": { "key": "done" } },
            "priority": null, "assignee": { "name": "mmeyer", "displayName": "Mia Meyer" }, "reporter": null,
            "issuetype": { "name": "Task" }, "project": { "key": "OPS", "name": "Operations" },
            "duedate": null, "updated": "2026-09-01T12:00:00.000+0000", "resolutiondate": "2026-09-02T09:30:00.000+0200",
            "customfield_10104": ["com.atlassian.greenhopper.service.sprint.Sprint@5f[id=12,rapidViewId=3,state=CLOSED,name=Ops, Sprint 9,startDate=2026-08-01T10:00:00.000+02:00,endDate=<null>,sequence=12]"],
            "description": "h2. Why\nThe *nightly* job fails, see [the log|https://logs/1].\n{code:bash}\nrun.sh\n{code}",
            "comment": { "comments": [{ "author": { "displayName": "Ops Bot" }, "created": "2026-09-01T12:00:00.000+0000", "body": "Restarted _twice_" }] }
        }
    });
    let i = parse_issue(&v, "corp", "https://jira.firma.de", Some("customfield_10104")).unwrap();
    assert!(i.done());
    assert_eq!((i.assignee.as_str(), i.priority.as_str(), i.reporter.as_str()), ("Mia Meyer", "", ""));
    assert_eq!((i.sprint.as_str(), i.sprint_state.as_str()), ("Ops, Sprint 9", "closed"));
    assert_eq!(i.resolved.as_deref(), Some("2026-09-02T07:30:00Z"));
    assert_eq!(i.description, "Why\nThe nightly job fails, see the log.\n\nrun.sh");
    assert_eq!(i.comments[0].body, "Restarted twice");
    assert_eq!(i.url, "https://jira.firma.de/browse/OPS-7");
}

#[test]
fn search_pages_continue_until_the_end() {
    let page = json!({ "issues": [cloud_issue()], "nextPageToken": "t2", "isLast": false });
    let (list, next) = parse_search_page(&page, SiteKind::Cloud, &PageAt::Token(None), "acme", "https://a", None);
    assert_eq!((list.len(), next), (1, Some(PageAt::Token(Some("t2".into())))));
    let last = json!({ "issues": [cloud_issue()], "isLast": true });
    assert_eq!(
        parse_search_page(&last, SiteKind::Cloud, &PageAt::Token(Some("t2".into())), "acme", "https://a", None).1,
        None
    );
    let server = json!({ "startAt": 0, "total": 3, "issues": [cloud_issue(), cloud_issue()] });
    assert_eq!(
        parse_search_page(&server, SiteKind::Server, &PageAt::Start(0), "c", "https://a", None).1,
        Some(PageAt::Start(2))
    );
    let end = json!({ "startAt": 2, "total": 3, "issues": [cloud_issue()] });
    assert_eq!(parse_search_page(&end, SiteKind::Server, &PageAt::Start(2), "c", "https://a", None).1, None);
    assert_eq!(sprint_field_of(&json!([{ "id": "x" }, { "id": "customfield_7", "schema": { "custom": "com.pyxis.greenhopper.jira:gh-sprint" } }])).as_deref(), Some("customfield_7"));
}

#[test]
fn bodies_and_accounts() {
    let adf = body_value(SiteKind::Cloud, "One\ntwo\n\nThree");
    assert_eq!(adf_to_text(&adf), "One\ntwo\n\nThree");
    assert_eq!(body_value(SiteKind::Server, "x"), json!("x"));
    assert_eq!(parse_account(&json!({ "accountId": "a1", "displayName": "Mia", "emailAddress": "m@x" })).id, "a1");
    assert_eq!(parse_account(&json!({ "name": "mmeyer", "displayName": "Mia" })).id, "mmeyer");
    assert_eq!(worklog_started(Utc.with_ymd_and_hms(2026, 10, 1, 8, 5, 0).unwrap()), "2026-10-01T08:05:00.000+0000");
}

#[test]
fn errors_are_worded_for_the_user() {
    let captcha = status_error(SiteKind::Server, 403, Some("CAPTCHA_CHALLENGE; login-url=https://jira/login.jsp"), "");
    assert!(captcha.to_string().contains("CAPTCHA"), "{captcha}");
    assert!(status_error(SiteKind::Server, 401, None, "").to_string().contains("401"));
    let nf = status_error(SiteKind::Server, 404, None, r#"{"errorMessages":["Issue does not exist"]}"#).to_string();
    assert!(nf.contains("Issue does not exist") && nf.contains("404"), "{nf}");
    let bad = status_error(SiteKind::Server, 400, None, r#"{"errorMessages":[],"errors":{"summary":"required"}}"#)
        .to_string();
    assert!(bad.contains("summary: required"), "{bad}");
    let base = std::time::Duration::from_millis(100);
    assert_eq!(retry_after(Some("2"), 0, base), std::time::Duration::from_secs(2));
    assert_eq!(retry_after(Some("999"), 0, base), std::time::Duration::from_secs(60));
    assert_eq!(retry_after(None, 2, base), std::time::Duration::from_millis(400));
    // Jira is not the AI server: the message stands alone, with what to do.
    let login = status_error(SiteKind::Server, 401, None, "").to_string();
    assert!(login.starts_with("Jira hat die Anmeldung abgelehnt (401)"), "{login}");
    assert!(!login.contains("KI-Server"), "{login}");
    let down = status_error(SiteKind::Server, 502, None, "<html>Bad Gateway</html>").to_string();
    assert!(down.contains("Fehler 502") && down.contains("In ein paar Minuten"), "{down}");
    let proxy = status_error(SiteKind::Server, 407, None, "").to_string();
    assert!(proxy.contains("Proxy") && proxy.contains("Einstellungen → Netzwerk"), "{proxy}");
    assert!(login.contains("Zugriffstoken") && !login.contains("API-Token"), "{login}");
    let cloud = status_error(SiteKind::Cloud, 401, None, "").to_string();
    assert!(cloud.contains("API-Token") && cloud.contains("id.atlassian.com"), "{cloud}");
    crate::i18n::with_lang(crate::prefs::Language::En, || {
        let login = status_error(SiteKind::Server, 401, None, "").to_string();
        assert!(login.starts_with("Jira refused the login (401)"), "{login}");
    });
}

/// A Jira client through a proxy profile, built the way `client_for` builds it.
fn jira_via(url: &str, profile: crate::network::ProxyProfile) -> JiraClient {
    let http = crate::network::Prepared::new(&profile, None, &[]).unwrap().client().unwrap();
    JiraClient::new("s", url, SiteKind::Server, "", "t", http, std::time::Duration::from_secs(5))
}

fn direct_jira(url: &str) -> JiraClient {
    jira_via(url, crate::network::ProxyProfile { mode: crate::network::ProxyMode::None, ..Default::default() })
}

#[tokio::test]
async fn network_errors_name_the_cause_and_the_fix() {
    // Nothing listens: offline or a wrong address.
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let refused = direct_jira(&format!("http://127.0.0.1:{port}")).whoami().await.unwrap_err().to_string();
    assert!(refused.contains("nicht erreichbar"), "{refused}");
    // A server name that does not exist.
    let name = direct_jira("http://jira.example.invalid").whoami().await.unwrap_err().to_string();
    assert!(name.contains("nicht auffindbar") || name.contains("Zeitüberschreitung"), "{name}");
    // A proxy that refuses the connection.
    let manual = crate::network::ProxyProfile {
        mode: crate::network::ProxyMode::Manual,
        http_proxy: format!("http://127.0.0.1:{port}"),
        https_proxy: format!("http://127.0.0.1:{port}"),
        ..Default::default()
    };
    let proxy = jira_via("https://jira.firma.de", manual).whoami().await.unwrap_err().to_string();
    assert!(proxy.contains("Proxy"), "{proxy}");
}

// ------------------------------------------------------------------ keys

#[test]
fn keys_of_known_projects_only() {
    let p = projects(&["PROJ", "OPS"]);
    let found: Vec<String> =
        find_keys("Fix PROJ-123 and OPS-7, not ISO-9001 or UTF-8.", &p).into_iter().map(|k| k.2).collect();
    assert_eq!(found, ["PROJ-123", "OPS-7"]);
    assert_eq!(find_keys("PROJ-12", &p)[0], (0, 7, "PROJ-12".into()));
    for text in [
        "xPROJ-1",
        "PROJ-1x",
        "PROJ-0",
        "proj-1",
        "/PROJ-1",
        "https://j/browse/PROJ-1",
        "PROJ-1-2",
        "PROJ-1.5",
        "#PROJ-1",
    ] {
        assert!(find_keys(text, &p).is_empty(), "{text}");
    }
    assert_eq!(find_keys("(PROJ-9) „OPS-1“ PROJ-2.", &p).len(), 3);
    assert_eq!(find_keys("Ärger mit PROJ-5", &p)[0].2, "PROJ-5", "after non-ASCII text");
    assert!(mentions("- [ ] PROJ-5 deploy", "PROJ-5") && !mentions("PROJ-55", "PROJ-5"));
    assert!(is_key("AB_2-10") && !is_key("A-1") && !is_key("AB-") && !is_key("AB-01"));
}

// ------------------------------------------------------------------ cache

#[test]
fn a_sync_is_stored_and_kept_offline() {
    let db = setup();
    let out = store(
        &db,
        &[
            (issue("PROJ-1", "new"), &["mine"]),
            (issue("PROJ-2", "indeterminate"), &["mine", "q1"]),
            (issue("OPS-3", "new"), &["q1"]),
        ],
    );
    assert_eq!(out.issues, 3);
    let mine = db.issues_list(&IssueFilter { query: "mine".into(), ..Default::default() }).unwrap();
    assert_eq!(mine.len(), 2);
    let q1 = db.issues_list(&IssueFilter { query: "q1".into(), ..Default::default() }).unwrap();
    assert_eq!(q1.iter().map(|i| i.key.as_str()).collect::<HashSet<_>>(), HashSet::from(["PROJ-2", "OPS-3"]));
    assert_eq!(db.issue_project_keys().unwrap(), projects(&["PROJ", "OPS"]));
    // PROJ-1 is done now and no search finds it: it stays cached for chips, not listed.
    let out = store(&db, &[(issue("PROJ-1", "done"), &[]), (issue("PROJ-2", "indeterminate"), &["mine"])]);
    assert_eq!(out.newly_done, ["PROJ-1"]);
    assert_eq!(db.issues_list(&IssueFilter::default()).unwrap().len(), 1);
    assert!(db.issue_get("PROJ-1").unwrap().unwrap().done());
    assert!(db.issue_get("OPS-3").unwrap().unwrap().matches.is_empty());
    assert_eq!(db.issues_open_keys("acme").unwrap(), ["OPS-3", "PROJ-2"]);
    db.issue_sync_record("acme", now(), Ok((1, "Mia"))).unwrap();
    db.issue_sync_record("acme", now(), Err("offline")).unwrap();
    let st = &db.issue_sync_status().unwrap()[0];
    assert_eq!((st.issues, st.account.as_str(), st.error.as_deref()), (1, "Mia", Some("offline")));
    assert!(st.synced_at.is_some(), "the last success stays");
    db.issues_remove_site("acme").unwrap();
    assert!(db.issue_get("PROJ-2").unwrap().is_none() && db.issue_project_keys().unwrap().is_empty());
}

#[test]
fn done_issues_tick_their_tasks_and_backlinks_find_pages() {
    let db = setup();
    store(&db, &[(issue("PROJ-1", "new"), &["mine"])]);
    let page = db.create_page(None, "Plan", None).unwrap();
    db.save_page_content(page.id, "- [ ] PROJ-1 Deploy\n- [ ] PROJ-11 other\n- [ ] see PROJ-1\n").unwrap();
    let note = db.create_page(None, "PROJ-1 Summary", None).unwrap();
    db.save_page_content(note.id, "---\njira: PROJ-1\n---\n\nNotes").unwrap();
    assert_eq!(db.issue_note("PROJ-1").unwrap(), Some(note.id));
    let links = db.issue_backlinks("PROJ-1").unwrap();
    assert_eq!(links.iter().map(|l| (l.page_id, l.note)).collect::<Vec<_>>(), [(note.id, true), (page.id, false)]);
    assert_eq!(db.issues_tick_tasks(&["PROJ-1".into()]).unwrap(), [page.id]);
    let tasks = db
        .list_tasks(&crate::tasks::TaskFilter { status: crate::tasks::TaskStatus::All, ..Default::default() })
        .unwrap();
    let mut done: Vec<(String, bool)> =
        tasks.iter().filter(|t| t.page_id == page.id).map(|t| (t.text.clone(), t.done)).collect();
    done.sort();
    assert_eq!(
        done,
        [("PROJ-1 Deploy".to_owned(), true), ("PROJ-11 other".to_owned(), false), ("see PROJ-1".to_owned(), true)]
    );
}

// ------------------------------------------------------------------ time tracking

#[test]
fn zeit_with_an_issue_key_learns_and_reuses_the_wbs() {
    let db = setup();
    store(&db, &[(issue("PROJ-123", "indeterminate"), &["mine"])]);
    let t = Thresholds::default();
    // No reference and no mapping: a clear error, nothing booked.
    let err = log_slash_command(&db, "/zeit 1h PROJ-123 fix login", now(), &cet(), &t).unwrap_err().to_string();
    assert!(err.contains("PROJ-123") && err.contains("NP-8801/1020"), "{err}");
    // The first booking with a reference teaches the mapping.
    let out = log_slash_command(&db, "/time NP-8801/1020 30m PROJ-123 analysis", now(), &cet(), &t).unwrap();
    assert_eq!(out.issue.as_deref(), Some("PROJ-123"));
    assert_eq!(db.issue_wbs_for("PROJ-123").unwrap().as_deref(), Some("NP-8801/1020"));
    assert_eq!(db.issue_wbs_for("PROJ-999").unwrap().as_deref(), Some("NP-8801/1020"), "the project learned it too");
    // Now the key alone books on it, also over a page's own reference.
    let ctx = SlashContext { default_ref: Some("NP-8801/1010"), page_id: None };
    let out = log_slash_command_in(&db, "/zeit 1h PROJ-123 fix login", now(), &cet(), &t, ctx).unwrap();
    assert_eq!((out.reference.as_str(), out.entry.description.as_str()), ("NP-8801/1020", "PROJ-123 fix login"));
    let links = db.issue_entries(&[out.entry.id]).unwrap();
    assert_eq!((links[0].issue_key.as_str(), links[0].worklog_state.as_str()), ("PROJ-123", "none"));
    // A mapping set by hand wins; unknown projects are plain text.
    db.issue_wbs_set("issue", "PROJ-123", "np-8801/1010", false).unwrap();
    assert_eq!(db.issue_wbs_for("PROJ-123").unwrap().as_deref(), Some("NP-8801/1010"), "canonical spelling");
    assert!(db.issue_wbs_set("issue", "PROJ-123", "NP-9999", false).is_err());
    let out = log_slash_command(&db, "/zeit NP-8801 15m ABC-1 talk", now(), &cet(), &t).unwrap();
    assert_eq!(out.issue, None);
    db.issue_wbs_set("issue", "PROJ-123", "", false).unwrap();
    assert_eq!(db.issue_wbs_list().unwrap().len(), 1, "only the project mapping is left");
}

#[test]
fn worklogs_are_never_posted_twice() {
    let db = setup();
    let mut s = db.load_settings().unwrap();
    s.jira.sites.push(JiraSite {
        id: "acme".into(),
        name: "Acme".into(),
        url: "https://acme.atlassian.net".into(),
        log_work: true,
        ..Default::default()
    });
    db.save_settings(&s).unwrap();
    store(&db, &[(issue("PROJ-5", "new"), &["mine"])]);
    let out =
        log_slash_command(&db, "/zeit NP-8801/1020 45m PROJ-5 review", now(), &cet(), &Thresholds::default()).unwrap();
    let id = out.entry.id;
    let due = db.worklogs_due(now()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(
        (due[0].site.as_str(), due[0].work.key.as_str(), due[0].work.minutes, due[0].retry),
        ("acme", "PROJ-5", 45, false)
    );
    // Two runs at once: only one gets it.
    assert!(db.worklog_claim(id).unwrap());
    // A failure waits, then counts as a retry (look for the worklog first).
    db.worklog_failed(id, "offline", now()).unwrap();
    assert!(db.worklogs_due(now()).unwrap().is_empty(), "waits a minute");
    let later = now() + Duration::minutes(2);
    assert!(db.worklogs_due(later).unwrap()[0].retry);
    assert!(db.worklog_claim(id).unwrap());
    db.worklog_posted(id, "10042").unwrap();
    assert!(!db.worklog_claim(id).unwrap(), "posted: never again");
    assert!(db.worklogs_due(later + Duration::hours(5)).unwrap().is_empty());
    db.worklog_failed(id, "late error", later).unwrap();
    let e = &db.issue_entries(&[id]).unwrap()[0];
    assert_eq!(
        (e.worklog_state.as_str(), e.worklog_id.as_deref()),
        ("posted", Some("10042")),
        "a posted worklog stays posted"
    );
    // An interrupted post that reached Jira is found on the issue.
    let work = WorkLog { key: "PROJ-5".into(), started: now(), minutes: 45, comment: String::new() };
    let list = vec![
        RemoteWorklog { id: "1".into(), started: now(), seconds: 1800, author: "abc".into() },
        RemoteWorklog { id: "2".into(), started: now() + Duration::seconds(20), seconds: 2700, author: "abc".into() },
    ];
    assert_eq!(matching_worklog(&list, &work, "abc").map(|w| w.id.as_str()), Some("2"));
    assert!(matching_worklog(&list, &work, "other").is_none());
    assert_eq!(worklog_retry_delay(1), Duration::minutes(1));
    assert_eq!(worklog_retry_delay(9), Duration::hours(1));
}

#[test]
fn deleting_an_entry_drops_its_link() {
    let db = setup();
    store(&db, &[(issue("PROJ-5", "new"), &["mine"])]);
    let out =
        log_slash_command(&db, "/zeit NP-8801/1020 45m PROJ-5 review", now(), &cet(), &Thresholds::default()).unwrap();
    db.delete_time_entry(out.entry.id).unwrap();
    assert!(db.issue_entries(&[out.entry.id]).unwrap().is_empty());
}

// ------------------------------------------------------------------ provider

struct Fake {
    results: HashMap<String, Vec<Issue>>,
}

impl IssueProvider for Fake {
    fn site(&self) -> &str {
        "acme"
    }
    async fn whoami(&self) -> Result<Account> {
        Ok(Account { display_name: "Mia".into(), ..Default::default() })
    }
    async fn search(&self, query: &str, _limit: usize) -> Result<Vec<Issue>> {
        self.results.get(query).cloned().ok_or_else(|| Error::State(format!("bad query {query}")))
    }
    async fn get(&self, key: &str) -> Result<Issue> {
        Err(Error::not_found("issue", key))
    }
    async fn projects(&self) -> Result<Vec<RemoteProject>> {
        Ok(vec![])
    }
    async fn create(&self, _new: &NewIssue) -> Result<String> {
        Ok("PROJ-9".into())
    }
    async fn comment(&self, _key: &str, _body: &str) -> Result<()> {
        Ok(())
    }
    async fn transition(&self, _key: &str, to: &str) -> Result<String> {
        Ok(to.into())
    }
    async fn log_work(&self, _work: &WorkLog) -> Result<String> {
        Ok("1".into())
    }
    async fn worklogs(&self, _key: &str) -> Result<Vec<RemoteWorklog>> {
        Ok(vec![])
    }
    async fn update_work(&self, id: &str, _work: &WorkLog) -> Result<()> {
        match id {
            "gone" => Err(Error::Remote { status: 404, message: String::new() }),
            "down" => Err(Error::Remote { status: 503, message: String::new() }),
            _ => Ok(()),
        }
    }
    async fn delete_work(&self, _key: &str, _id: &str) -> Result<()> {
        Ok(())
    }
    async fn sprint(&self, _project: &str) -> Result<Option<Sprint>> {
        Ok(None)
    }
}

#[test]
fn the_week_proposal_reads_issue_keys() {
    use crate::calsync::tz::Zone;
    use crate::weekplan::{Basis, WbsContext};
    let db = setup();
    store(&db, &[(issue("PROJ-5", "new"), &["mine"])]);
    let page = db.create_page(None, "PROJ-5 Review", None).unwrap();
    let note = db.create_page(None, "Notizen", None).unwrap();
    db.save_page_content(note.id, "---\njira: PROJ-5\n---\n\nText").unwrap();
    let ctx = WbsContext::load(&db, now(), &Zone::Utc).unwrap();
    assert!(ctx.for_page(&db, page.id).unwrap().is_none_or(|g| g.basis != Basis::Link), "no mapping yet");
    db.issue_wbs_set("project", "PROJ", "NP-8801/1010", false).unwrap();
    let ctx = WbsContext::load(&db, now(), &Zone::Utc).unwrap();
    for id in [page.id, note.id] {
        let g = ctx.for_page(&db, id).unwrap().unwrap();
        assert_eq!((g.reference.as_str(), g.basis), ("NP-8801/1010", Basis::Link));
        assert!(g.reason.contains("PROJ-5"), "{}", g.reason);
    }
    let g = ctx.for_focus(&db, None, None, "PROJ-5 fertig machen").unwrap().unwrap();
    assert_eq!(g.reference, "NP-8801/1010");
}

#[tokio::test]
async fn fetching_a_site_merges_searches_and_refreshes_stale_issues() {
    let fake = Fake {
        results: HashMap::from([
            (DEFAULT_JQL.to_owned(), vec![issue("PROJ-1", "new"), issue("PROJ-2", "new")]),
            ("project = OPS".to_owned(), vec![issue("PROJ-2", "new"), issue("OPS-1", "new")]),
            (keys_jql(&["PROJ-7"]), vec![issue("PROJ-7", "done")]),
        ]),
    };
    let searches = vec![
        (MINE.to_owned(), DEFAULT_JQL.to_owned()),
        ("q1".to_owned(), "project = OPS".to_owned()),
        ("q2".to_owned(), "broken".to_owned()),
    ];
    let f = fetch_site(&fake, &searches, &["PROJ-1".into(), "PROJ-7".into()]).await.unwrap();
    assert_eq!(f.issues["PROJ-2"].matches, ["mine", "q1"]);
    assert_eq!(f.issues["OPS-1"].matches, ["q1"]);
    assert!(f.issues["PROJ-7"].matches.is_empty() && f.refreshed.contains("PROJ-7"));
    assert_eq!(f.failed.len(), 1, "a broken saved query does not fail the site");
    let failing = Fake { results: HashMap::new() };
    assert!(fetch_site(&failing, &searches, &[]).await.is_err(), "the default search failing fails the site");
    assert_eq!(fake.whoami().await.unwrap().display_name, "Mia");
}

#[tokio::test]
async fn a_worklog_deleted_in_jira_is_posted_again() {
    let fake = Fake { results: HashMap::new() };
    let work = WorkLog { key: "PROJ-5".into(), started: now(), minutes: 45, comment: "review".into() };
    assert_eq!(update_or_post(&fake, "7", &work).await.unwrap(), "7");
    assert_eq!(update_or_post(&fake, "gone", &work).await.unwrap(), "1", "a new worklog");
    assert!(update_or_post(&fake, "down", &work).await.is_err(), "other errors stay errors (retried later)");
}

// ------------------------------------------------------------------ settings and burndown

#[test]
fn settings_are_normalized() {
    let s = IssueSettings {
        sites: vec![
            JiraSite {
                name: " Acme Cloud ".into(),
                url: "acme.atlassian.net/".into(),
                color: "x".into(),
                ..Default::default()
            },
            JiraSite { name: "Acme Cloud".into(), url: "https://jira.firma.de".into(), ..Default::default() },
        ],
        queries: vec![
            SavedQuery { site: "acme-cloud".into(), jql: " project = A ".into(), ..Default::default() },
            SavedQuery { site: "gone".into(), jql: "x".into(), ..Default::default() },
        ],
        sync_minutes: 0,
        tick_done_tasks: true,
    }
    .normalized();
    assert_eq!(s.sites.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["acme-cloud", "acme-cloud-2"]);
    assert_eq!(
        (s.sites[0].url.as_str(), s.sites[0].name.as_str(), s.sites[0].color.as_str()),
        ("https://acme.atlassian.net", "Acme Cloud", PALETTE[0])
    );
    assert_eq!(s.queries.len(), 1);
    assert_eq!(
        (s.queries[0].id.as_str(), s.queries[0].jql.as_str(), s.queries[0].name.as_str()),
        ("q1", "project = A", "project = A")
    );
    assert_eq!(s.sync_minutes, 1);
    assert_eq!(s.searches("acme-cloud").len(), 2);
    assert_eq!(s.new_site_id("Acme Cloud"), "acme-cloud-3");
    assert_eq!(IssueSettings::default().sync_minutes, 10);
}

#[test]
fn burndown_counts_open_issues_per_day() {
    let d = |n: u32| NaiveDate::from_ymd_opt(2026, 9, n).unwrap();
    let mut a = issue("A-1", "done");
    a.resolved = Some("2026-09-02T10:00:00Z".into());
    let b = issue("A-2", "new");
    let c = issue("A-3", "done");
    let points = burndown(d(1), d(5), &[a, b, c], d(3));
    assert_eq!(points.len(), 5);
    assert_eq!(points.iter().map(|p| p.remaining).collect::<Vec<_>>(), [Some(3), Some(2), Some(1), None, None]);
    assert_eq!((points[0].ideal, points[4].ideal), (3.0, 0.0));
}

#[test]
fn open_issues_with_a_due_date_are_deadlines() {
    let db = setup();
    let due = |key: &str, cat: &str, d: &str, prio: &str| {
        let mut i = issue(key, cat);
        i.due_date = Some(d.into());
        i.priority = prio.into();
        i
    };
    store(
        &db,
        &[
            (due("PROJ-1", "new", "2026-09-20", "High"), &["mine"]),
            (due("PROJ-2", "done", "2026-09-25", "Low"), &["mine"]),
            (due("PROJ-3", "indeterminate", "2026-10-30", "Medium"), &["q1"]),
            (due("PROJ-4", "new", "2026-12-30", "Medium"), &["mine"]),
        ],
    );
    let w = crate::dashboard::work::DeadlineWindow {
        today: NaiveDate::from_ymd_opt(2026, 9, 23).unwrap(),
        until: NaiveDate::from_ymd_opt(2026, 11, 1).unwrap(),
    };
    let list = jira_deadlines(&db, &w).unwrap();
    assert_eq!(
        list.iter().map(|d| (d.key.as_str(), d.priority)).collect::<Vec<_>>(),
        [("jira:PROJ-1", 2), ("jira:PROJ-3", 1)]
    );
    assert_eq!(list[0].title, "PROJ-1 Summary of PROJ-1");
    assert!(list[0].url.as_deref().is_some_and(|u| u.ends_with("/browse/PROJ-1")));
    let all = crate::dashboard::work::deadlines(&db, w.today, 40, &[]).unwrap();
    assert!(all.items.iter().any(|d| d.source == "jira"));
}

#[test]
fn a_posted_worklog_follows_edits_and_deletion() {
    let db = setup();
    let mut s = db.load_settings().unwrap();
    s.jira.sites.push(JiraSite { id: "acme".into(), name: "Acme".into(), log_work: true, ..Default::default() });
    db.save_settings(&s).unwrap();
    store(&db, &[(issue("PROJ-5", "new"), &["mine"])]);
    let out =
        log_slash_command(&db, "/zeit NP-8801/1020 45m PROJ-5 review", now(), &cet(), &Thresholds::default()).unwrap();
    let id = out.entry.id;
    assert!(db.entry_worklog(id).unwrap().is_none(), "not posted yet");
    assert!(!db.worklog_changed(id).unwrap(), "unposted: the post reads the entry as it is");
    assert!(db.worklog_claim(id).unwrap());
    db.worklog_posted(id, "10042").unwrap();
    assert_eq!(db.entry_worklog(id).unwrap(), Some(("acme".into(), "PROJ-5".into(), "10042".into())));

    // Only duration, start and comment reach Jira.
    let before = db.time_entry(id).unwrap();
    let same = db.update_time_entry(id, Some("1010"), None, before.start_time, 45, &before.description).unwrap();
    assert!(!worklog_differs(&before, &same), "another Vorgang is no change for Jira");
    let after = db.update_time_entry(id, Some("1020"), None, before.start_time, 60, "review and fixes").unwrap();
    assert!(worklog_differs(&before, &after));
    assert!(db.worklog_changed(id).unwrap());
    let due = db.worklogs_due(now()).unwrap();
    assert_eq!(due.len(), 1);
    assert_eq!(
        (due[0].worklog_id.as_deref(), due[0].work.minutes, due[0].work.comment.as_str(), due[0].retry),
        (Some("10042"), 60, "review and fixes", false)
    );
    assert!(db.worklog_claim(id).unwrap());
    // A failed update waits and keeps the worklog id (never posted as a second worklog).
    db.worklog_failed(id, "offline", now()).unwrap();
    let e = &db.issue_entries(&[id]).unwrap()[0];
    assert_eq!((e.worklog_state.as_str(), e.worklog_id.as_deref()), ("failed", Some("10042")));
    db.worklog_retry_now(id).unwrap();
    assert_eq!(db.worklogs_due(now()).unwrap()[0].worklog_id.as_deref(), Some("10042"));
    assert!(db.worklog_claim(id).unwrap());
    db.worklog_posted(id, "10042").unwrap();
    assert!(db.worklogs_due(now() + Duration::hours(2)).unwrap().is_empty());

    // Deleting the entry queues the worklog's deletion; it outlives the entry.
    assert!(db.worklog_queue_delete(id).unwrap());
    db.delete_time_entry(id).unwrap();
    let del = db.worklog_deletes_due(now()).unwrap();
    assert_eq!(del.len(), 1);
    assert_eq!((del[0].issue_key.as_str(), del[0].worklog_id.as_str()), ("PROJ-5", "10042"));
    db.worklog_delete_failed(del[0].id, "offline", now()).unwrap();
    assert!(db.worklog_deletes_due(now()).unwrap().is_empty(), "waits");
    assert_eq!(db.worklog_deletes_due(now() + Duration::minutes(2)).unwrap().len(), 1);
    db.worklog_deleted(del[0].id).unwrap();
    assert!(db.worklog_deletes_due(now() + Duration::days(1)).unwrap().is_empty());
    // An entry without a posted worklog queues nothing.
    let other =
        log_slash_command(&db, "/zeit NP-8801/1020 15m PROJ-5 call", now(), &cet(), &Thresholds::default()).unwrap();
    assert!(!db.worklog_queue_delete(other.entry.id).unwrap());
}

#[test]
fn priorities_get_levels_in_any_language() {
    // Names Jira ships, English and German, and the classic Server scheme.
    for (name, level) in [("Highest", 5), ("Höchste", 5), ("Hoch", 4), ("Mittel", 3), ("Niedrig", 2), ("Niedrigste", 1)]
    {
        assert_eq!(priority_level(name, "", ""), level, "{name}");
    }
    assert_eq!(priority_level("Blocker", "", ""), 5);
    assert_eq!(priority_level("Minor", "", ""), 2);
    // A renamed or translated priority: the default icon, then the default id.
    assert_eq!(priority_level("Sofort", "10001", "https://jira.firma.de/images/icons/priorities/highest.svg"), 5);
    assert_eq!(priority_level("Wichtig", "", "https://acme.atlassian.net/images/icons/priorities/high_new.svg?x=1"), 0);
    assert_eq!(priority_level("Wichtig", "2", "https://jira.firma.de/custom/42.png"), 4);
    assert_eq!(priority_level("Kaum", "5", ""), 1);
    assert_eq!(priority_level("Eigene", "10200", "https://jira.firma.de/custom/42.png"), 0);
    // Custom priorities by the instance's order (highest first).
    let ids: Vec<String> = ["10200", "10201", "10202"].iter().map(|s| (*s).to_owned()).collect();
    let order = levels_by_order(&ids);
    assert_eq!((order["10200"], order["10201"], order["10202"]), (5, 3, 1));
    let five: Vec<String> = (1..=5).map(|n| n.to_string()).collect();
    let o5 = levels_by_order(&five);
    assert_eq!(five.iter().map(|i| o5[i]).collect::<Vec<_>>(), [5, 4, 3, 2, 1]);
    assert_eq!(levels_by_order(&ids[..1])["10200"], 3);

    // Parsed from Jira: the id and icon come along; a custom one gets its place on sync.
    let mut v = cloud_issue();
    v["fields"]["priority"] = json!({ "name": "Dringend", "id": "10201", "iconUrl": "https://x/custom.png" });
    let i = parse_issue(&v, "acme", "https://acme.atlassian.net", None).unwrap();
    assert_eq!((i.priority_level, i.priority_id.as_str()), (0, "10201"));
    let mut f = Fetched::default();
    f.issues.insert(i.key.clone(), i);
    assert!(needs_priority_order(&f));
    assert_eq!(apply_priority_order(&mut f, &order), 1);
    assert_eq!(f.issues["PROJ-123"].priority_level, 3);
    assert!(!needs_priority_order(&f));
    assert_eq!(parse_priorities(&json!([{ "id": "1" }, { "id": 2 }, {}])), ["1", "2"]);

    // Stored and read back.
    let db = setup();
    let mut hi = issue("PROJ-7", "new");
    hi.priority = "Höchste".into();
    hi.priority_level = 5;
    store(&db, &[(hi, &["mine"])]);
    assert_eq!(db.issue_get("PROJ-7").unwrap().unwrap().priority_level, 5);
}
