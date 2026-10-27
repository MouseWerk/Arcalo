//! The issue view: real-shaped answers of Jira Cloud (REST v3) and Server/Data Center (REST v2),
//! every field type, rendered descriptions, transitions, editmeta, the conversions of rich text
//! and the writes of both flavors.

use super::jira::JiraClient;
use super::richtext::*;
use super::view::*;
use super::{Account, SiteKind};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

const CLOUD_ISSUE: &str = include_str!("fixtures/cloud_issue.json");
const CLOUD_COMMENTS: &str = include_str!("fixtures/cloud_comments.json");
const CLOUD_EXTRAS: &str = include_str!("fixtures/cloud_extras.json");
const SERVER_ISSUE: &str = include_str!("fixtures/server_issue.json");
const SERVER_COMMENTS: &str = include_str!("fixtures/server_comments.json");

fn j(s: &str) -> Value {
    serde_json::from_str(s).unwrap()
}

fn cloud() -> IssueFull {
    let extras = j(CLOUD_EXTRAS);
    let me = Account { id: "acc-mia".into(), display_name: "Mia Meyer".into(), email: String::new() };
    let a = Answers {
        issue: &j(CLOUD_ISSUE),
        comments: &j(CLOUD_COMMENTS),
        remote_links: &extras["remotelinks"],
        permissions: &extras["mypermissions"],
        me: &me,
    };
    parse_full(&a, "acme", "https://acme.atlassian.net", SiteKind::Cloud).unwrap()
}

fn server() -> IssueFull {
    let me = Account { id: "mmeyer".into(), display_name: "Mia Meyer".into(), email: String::new() };
    let a = Answers {
        issue: &j(SERVER_ISSUE),
        comments: &j(SERVER_COMMENTS),
        remote_links: &json!([]),
        permissions: &Value::Null,
        me: &me,
    };
    parse_full(&a, "corp", "https://jira.firma.de", SiteKind::Server).unwrap()
}

fn custom<'a>(i: &'a IssueFull, name: &str) -> &'a Shown {
    &i.custom.iter().find(|f| f.name == name).unwrap_or_else(|| panic!("no field {name}")).value
}

// ------------------------------------------------------------------ parsing

#[test]
fn a_cloud_issue_is_read_with_every_section() {
    let i = cloud();
    assert_eq!(
        (i.key.as_str(), i.id.as_str(), i.url.as_str()),
        ("PROJ-42", "10042", "https://acme.atlassian.net/browse/PROJ-42")
    );
    assert_eq!(i.issue_type.name, "Bug");
    assert!(!i.subtask);
    assert_eq!((i.status.name.as_str(), i.status.category.as_str()), ("In Progress", "indeterminate"));
    assert_eq!((i.project.icon.as_str(), i.project.name.as_str()), ("PROJ", "Portal"));
    let parent = i.parent.as_ref().unwrap();
    assert_eq!(
        (parent.key.as_str(), parent.summary.as_str(), parent.issue_type.as_str()),
        ("PROJ-10", "Payments 2.0", "Epic")
    );
    assert_eq!(i.epic, None, "the parent is the epic");
    // Jira's rendered HTML is used as it is (the UI sanitizes it).
    assert!(
        i.description_html.starts_with("<h2>") && i.description_html.contains("/rest/api/3/attachment/content/10500")
    );
    assert_eq!(i.description["type"], "doc");
    assert_eq!(i.environment_html, "<p>Chrome 130, macOS</p>");
    let a = i.assignee.as_ref().unwrap();
    assert_eq!(
        (a.id.as_str(), a.name.as_str(), a.avatar.as_str()),
        ("acc-mia", "Mia Meyer", "https://secure.gravatar.com/avatar/mia?d=48")
    );
    assert_eq!(i.reporter.as_ref().unwrap().name, "Tom Berger");
    assert_eq!(i.creator.as_ref().unwrap().id, "acc-tom");
    assert_eq!(i.priority.as_ref().map(|p| p.name.as_str()), Some("High"));
    assert_eq!(i.labels, ["checkout", "eu"]);
    assert_eq!(i.components, ["Payments"]);
    assert_eq!(
        (i.fix_versions.clone(), i.affects_versions.clone()),
        (vec!["2026.11".to_owned()], vec!["2026.10".to_owned()])
    );
    assert_eq!(
        i.sprints.iter().map(|s| (s.name.as_str(), s.state.as_str())).collect::<Vec<_>>(),
        [("Sprint 7", "active"), ("Sprint 6", "closed")]
    );
    assert_eq!((i.story_points, i.story_points_field.as_str()), (Some(5.0), "customfield_10016"));
    assert_eq!(i.due_date.as_deref(), Some("2026-11-01"));
    assert_eq!((i.time.original, i.time.remaining, i.time.spent), (Some(57600), Some(43200), Some(14400)));
    assert_eq!((i.time.original_text.as_str(), i.time.remaining_text.as_str()), ("2d", "1d 4h"));
    assert_eq!(
        (i.created.as_str(), i.updated.as_str(), i.resolved.as_str()),
        ("2026-10-01T09:00:00.000+0200", "2026-10-20T11:22:33.123+0200", "")
    );
    assert_eq!((i.watchers, i.watching, i.votes, i.voted), (4, true, 2, false));
}

#[test]
fn custom_fields_are_shown_by_name_and_schema_type() {
    let i = cloud();
    let names: Vec<&str> = i.custom.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(
        names,
        [
            "Customer ref",
            "Detected at",
            "Environment type",
            "Go-live",
            "Incident",
            "Planned in",
            "Platforms",
            "QA owner",
            "Region",
            "Revenue at risk",
            "Root cause"
        ],
        "empty fields, the rank, the development panel, the sprint and the story points are not listed"
    );
    assert_eq!(custom(&i, "Environment type"), &Shown::Options(vec!["Production".into()]));
    assert_eq!(custom(&i, "Platforms"), &Shown::Options(vec!["iOS".into(), "Android".into()]));
    assert!(matches!(custom(&i, "QA owner"), Shown::Users(u) if u[0].name == "Quinn Adams" && u[0].id == "acc-qa"));
    assert_eq!(custom(&i, "Go-live"), &Shown::Date("2026-11-15".into()));
    assert_eq!(
        custom(&i, "Incident"),
        &Shown::Link {
            url: "https://status.example.com/incidents/42".into(),
            label: "https://status.example.com/incidents/42".into()
        }
    );
    assert_eq!(custom(&i, "Root cause"), &Shown::Html("<p>Timeout at the <b>PSP</b>.</p>".into()));
    assert_eq!(custom(&i, "Region"), &Shown::Cascade("Europe".into(), Some("Germany".into())));
    assert_eq!(custom(&i, "Planned in"), &Shown::Options(vec!["2026.11".into()]));
    assert_eq!(custom(&i, "Revenue at risk"), &Shown::Number(1200.5));
    assert_eq!(custom(&i, "Detected at"), &Shown::DateTime("2026-10-20T09:30:00.000+0200".into()));
    assert_eq!(custom(&i, "Customer ref"), &Shown::Text("ACME-7781".into()));
    assert_eq!(i.custom.iter().find(|f| f.name == "Platforms").unwrap().kind, "array/option");
}

#[test]
fn subtasks_links_attachments_remote_links_comments_and_history() {
    let i = cloud();
    assert_eq!(
        i.subtasks.iter().map(|s| (s.key.as_str(), s.status.category.as_str())).collect::<Vec<_>>(),
        [("PROJ-43", "done"), ("PROJ-44", "new")]
    );
    let groups: Vec<(&str, Vec<&str>)> =
        i.links.iter().map(|g| (g.label.as_str(), g.issues.iter().map(|l| l.issue.key.as_str()).collect())).collect();
    assert_eq!(
        groups,
        [("blocks", vec!["PROJ-50", "PROJ-52"]), ("is blocked by", vec!["OPS-3"]), ("relates to", vec!["PROJ-51"])]
    );
    assert_eq!(i.links[1].issues[0].issue.status.category, "done");
    assert_eq!(i.attachments.len(), 2);
    let shot = &i.attachments[0];
    assert_eq!((shot.filename.as_str(), shot.mime.as_str(), shot.size), ("screenshot.png", "image/png", 48213));
    assert_eq!(shot.thumbnail, "https://acme.atlassian.net/rest/api/3/attachment/thumbnail/10500");
    assert_eq!(i.attachments[1].thumbnail, "", "a log has no thumbnail");
    assert_eq!(i.remote_links.len(), 1, "a link without an address is left out");
    assert_eq!(
        (i.remote_links[0].title.as_str(), i.remote_links[0].relationship.as_str()),
        ("Fix EU 3DS flow", "mentioned in")
    );
    // Comments newest first; the user's own are marked; a comment Jira did not render is drawn.
    assert_eq!(i.comments.total, 3);
    assert_eq!(
        i.comments.items.iter().map(|c| (c.id.as_str(), c.own)).collect::<Vec<_>>(),
        [("50003", true), ("50002", false), ("50001", false)]
    );
    assert_eq!(i.comments.items[2].html, "<p>Seen in prod.</p>");
    assert_eq!(i.comments.items[0].body["type"], "doc", "the stored body for editing");
    // History newest first, with from and to.
    let h: Vec<(&str, &str, &str, &str)> = i
        .history
        .items
        .iter()
        .flat_map(|e| e.items.iter().map(move |c| (e.id.as_str(), c.field.as_str(), c.from.as_str(), c.to.as_str())))
        .collect();
    assert_eq!(
        h,
        [
            ("30002", "assignee", "", "Mia Meyer"),
            ("30002", "labels", "", "checkout eu"),
            ("30001", "status", "To Do", "In Progress")
        ]
    );
    assert_eq!(i.worklogs.items.len(), 1);
    assert_eq!(
        (i.worklogs.items[0].seconds, i.worklogs.items[0].comment.as_str(), i.worklogs.items[0].own),
        (14400, "Analysis", true)
    );
}

#[test]
fn editmeta_transitions_and_permissions() {
    let i = cloud();
    let kind = |id: &str| i.edit.iter().find(|f| f.id == id).map(|f| f.kind);
    assert_eq!(kind("summary"), Some(EditKind::Text));
    assert_eq!(kind("description"), Some(EditKind::Rich));
    assert_eq!(kind("labels"), Some(EditKind::Labels));
    assert_eq!(kind("priority"), Some(EditKind::Select));
    assert_eq!(kind("assignee"), Some(EditKind::User));
    assert_eq!(kind("duedate"), Some(EditKind::Date));
    assert_eq!(kind("components"), Some(EditKind::MultiSelect));
    assert_eq!(kind("customfield_10016"), Some(EditKind::Number));
    assert_eq!(kind("customfield_10020"), Some(EditKind::Unsupported), "the sprint is changed on the board");
    assert_eq!(kind("customfield_10050"), Some(EditKind::Select));
    assert_eq!(kind("customfield_10051"), Some(EditKind::MultiSelect));
    assert_eq!(kind("customfield_10052"), Some(EditKind::User));
    assert_eq!(kind("customfield_10055"), Some(EditKind::Rich));
    assert_eq!(kind("customfield_10056"), Some(EditKind::Cascade));
    assert_eq!(kind("customfield_10059"), Some(EditKind::DateTime));
    let region = i.edit.iter().find(|f| f.id == "customfield_10056").unwrap();
    assert_eq!(region.allowed[0].children.iter().map(|c| c.label.as_str()).collect::<Vec<_>>(), ["Germany", "France"]);
    let env = i.editable("customfield_10050").unwrap();
    assert_eq!(
        env.allowed.iter().map(|c| (c.id.as_str(), c.label.as_str())).collect::<Vec<_>>(),
        [("10300", "Production"), ("10301", "Staging")]
    );
    assert!(i.editable("reporter").is_none(), "not in editmeta: read only");
    assert!(i.edit.iter().find(|f| f.id == "summary").unwrap().required);

    assert_eq!(i.transitions.len(), 2);
    let done = &i.transitions[1];
    assert_eq!(
        (done.name.as_str(), done.to.name.as_str(), done.to.category.as_str(), done.has_screen),
        ("Done", "Done", "done", true)
    );
    let res = done.fields.iter().find(|f| f.id == "resolution").unwrap();
    assert!(res.required && res.kind == EditKind::Select && res.allowed.len() == 2);

    assert!(
        i.perms.comment
            && i.perms.edit_own_comments
            && !i.perms.edit_all_comments
            && i.perms.log_work
            && i.perms.assign
    );
}

#[test]
fn a_server_issue_with_wiki_markup_old_sprint_strings_and_an_epic_link() {
    let i = server();
    assert_eq!((i.key.as_str(), i.kind), ("ERP-7", SiteKind::Server));
    assert_eq!(i.status.category, "new");
    assert_eq!(i.epic.as_deref(), Some("ERP-1"));
    assert!(i.parent.is_none());
    assert_eq!(i.description.as_str().map(|d| d.starts_with("h2. Goal")), Some(true), "the wiki markup for editing");
    assert!(
        i.description_html.contains("<h2>") && i.description_html.contains("/secure/thumbnail/30100/_thumb_30100.png")
    );
    assert_eq!(i.environment_html, "<p>SAP ECC 6.0</p>");
    let a = i.assignee.as_ref().unwrap();
    assert_eq!((a.id.as_str(), a.name.as_str()), ("mmeyer", "Mia Meyer"), "Server users go by name");
    assert_eq!(
        i.sprints.iter().map(|s| (s.name.as_str(), s.state.as_str())).collect::<Vec<_>>(),
        [("ERP Sprint 12", "active"), ("ERP Sprint 11", "closed")]
    );
    assert_eq!(
        (i.story_points, i.story_points_field.as_str()),
        (Some(8.0), "customfield_10106"),
        "Story Points by name"
    );
    assert_eq!(custom(&i, "Severity"), &Shown::Options(vec!["High".into()]));
    assert!(matches!(custom(&i, "Reviewers"), Shown::Users(u) if u.len() == 2 && u[1].id == "jdoe"));
    assert_eq!(custom(&i, "Notes"), &Shown::Html("<p>Plain <b>wiki</b> text</p>".into()));
    assert_eq!(i.time.spent, None);
    assert_eq!(i.time.original, Some(86400));
    // Comments newest first, own marked by user name, Jira's HTML.
    assert_eq!(
        i.comments.items.iter().map(|c| (c.id.as_str(), c.own)).collect::<Vec<_>>(),
        [("70002", true), ("70001", false)]
    );
    assert_eq!(i.comments.items[1].html, "<p>Please check <b>both</b> sites.</p>");
    assert_eq!(i.comments.items[0].body, json!("Done for Hamburg.\n\nBremen next."));
    // No permissions answer: editmeta and the transitions tell.
    assert!(!i.perms.comment, "no comment field in editmeta");
    assert!(i.perms.assign && i.perms.transition);
    let sev = i.editable("customfield_10300").unwrap();
    assert!(sev.required && sev.kind == EditKind::Select);
    let fix = i.transitions[1].fields.iter().find(|f| f.id == "fixVersions").unwrap();
    assert_eq!(fix.kind, EditKind::MultiSelect);
    assert_eq!(i.history.items[0].items[0].field, "duedate");
    let brief = i.brief();
    assert_eq!(
        (brief.summary.as_str(), brief.sprint.as_str(), brief.assignee.as_str()),
        ("Interface to the warehouse", "ERP Sprint 12", "Mia Meyer")
    );
    assert!(brief.detailed && brief.description.starts_with("Goal"));
}

#[test]
fn the_brief_of_a_cloud_issue_feeds_the_cache() {
    let b = cloud().brief();
    assert_eq!(
        (b.site.as_str(), b.key.as_str(), b.priority.as_str(), b.priority_level),
        ("acme", "PROJ-42", "High", 4)
    );
    assert_eq!(
        (b.status_category.as_str(), b.project_key.as_str(), b.sprint_state.as_str()),
        ("indeterminate", "PROJ", "active")
    );
    assert_eq!(b.updated.as_deref(), Some("2026-10-20T09:22:33Z"));
    assert_eq!(
        b.comments.last().map(|c| c.body.as_str()),
        Some("Fixed on staging."),
        "oldest first, as the cache keeps them"
    );
}

// ------------------------------------------------------------------ writing

fn field(i: &IssueFull, id: &str) -> EditField {
    i.edit.iter().find(|f| f.id == id).cloned().unwrap()
}

#[test]
fn values_are_written_as_each_flavor_wants_them() {
    let c = cloud();
    let s = server();
    let text = |t: &str| FieldInput::Text(t.into());
    let cloud_w = |id: &str, input: &FieldInput| write_value(&field(&c, id), SiteKind::Cloud, input);
    let server_w = |id: &str, input: &FieldInput| write_value(&field(&s, id), SiteKind::Server, input);
    assert_eq!(cloud_w("summary", &text("  New title ")).unwrap(), json!("New title"));
    assert!(cloud_w("summary", &text(" ")).unwrap_err().to_string().contains("Pflichtfeld"));
    assert!(cloud_w("summary", &text(&"x".repeat(256))).is_err());
    // Users: Cloud by account id, Server by name; empty unassigns.
    assert_eq!(
        cloud_w("assignee", &FieldInput::User(Some("acc-qa".into()))).unwrap(),
        json!({ "accountId": "acc-qa" })
    );
    assert_eq!(server_w("assignee", &FieldInput::User(Some("jdoe".into()))).unwrap(), json!({ "name": "jdoe" }));
    assert_eq!(cloud_w("assignee", &FieldInput::User(None)).unwrap(), Value::Null);
    assert_eq!(
        server_w("customfield_10301", &FieldInput::Users(vec!["a".into(), "b".into()])).unwrap(),
        json!([{ "name": "a" }, { "name": "b" }])
    );
    // Options by id, only the allowed ones; a required one cannot be emptied.
    assert_eq!(
        cloud_w("customfield_10050", &FieldInput::Choice(Some("10301".into()))).unwrap(),
        json!({ "id": "10301" })
    );
    assert!(cloud_w("customfield_10050", &FieldInput::Choice(Some("999".into()))).is_err());
    assert!(server_w("customfield_10300", &FieldInput::Choice(None)).is_err());
    assert_eq!(
        cloud_w("customfield_10051", &FieldInput::Choices(vec!["10310".into(), "10312".into()])).unwrap(),
        json!([{ "id": "10310" }, { "id": "10312" }])
    );
    assert_eq!(
        cloud_w("customfield_10056", &FieldInput::Cascade(Some("10400".into()), Some("10402".into()))).unwrap(),
        json!({ "id": "10400", "child": { "id": "10402" } })
    );
    assert_eq!(cloud_w("priority", &FieldInput::Choice(Some("1".into()))).unwrap(), json!({ "id": "1" }));
    // Labels: no spaces, no doubles.
    assert_eq!(
        cloud_w("labels", &FieldInput::Labels(vec!["a".into(), " b ".into(), "a".into()])).unwrap(),
        json!(["a", "b"])
    );
    assert!(
        cloud_w("labels", &FieldInput::Labels(vec!["two words".into()]))
            .unwrap_err()
            .to_string()
            .contains("Leerzeichen")
    );
    // Numbers, dates, dates with time.
    assert_eq!(cloud_w("customfield_10016", &FieldInput::Number(Some(3.5))).unwrap(), json!(3.5));
    assert_eq!(cloud_w("customfield_10016", &FieldInput::Number(None)).unwrap(), Value::Null);
    assert_eq!(cloud_w("duedate", &FieldInput::Date(Some("2026-12-24".into()))).unwrap(), json!("2026-12-24"));
    assert!(cloud_w("duedate", &FieldInput::Date(Some("24.12.2026".into()))).is_err());
    assert_eq!(
        cloud_w("customfield_10059", &FieldInput::Date(Some("2026-10-20T09:30:00+02:00".into()))).unwrap(),
        json!("2026-10-20T09:30:00.000+0200")
    );
    // A kind of input that does not fit.
    assert!(cloud_w("duedate", &text("x")).is_err());
}

#[test]
fn rich_text_is_written_as_adf_on_cloud_and_wiki_markup_on_server() {
    let c = cloud();
    let s = server();
    let doc = json!({ "type": "doc", "content": [
        { "type": "heading", "attrs": { "level": 3 }, "content": [{ "type": "text", "text": "Plan" }] },
        { "type": "paragraph", "content": [
            { "type": "text", "text": "Ship " }, { "type": "text", "text": "today", "marks": [{ "type": "bold" }] },
            { "type": "text", "text": " via " }, { "type": "text", "text": "docs", "marks": [{ "type": "link", "attrs": { "href": "https://d.e/x" } }] },
        ] },
        { "type": "bulletList", "content": [{ "type": "listItem", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "one" }] }] }] },
    ]});
    let adf = write_value(&field(&c, "description"), SiteKind::Cloud, &FieldInput::Doc(doc.clone())).unwrap();
    assert_eq!(adf["type"], "doc");
    assert_eq!(adf["version"], 1);
    assert_eq!(
        adf["content"][0],
        json!({ "type": "heading", "attrs": { "level": 3 }, "content": [{ "type": "text", "text": "Plan" }] })
    );
    assert_eq!(
        adf["content"][1]["content"][1],
        json!({ "type": "text", "text": "today", "marks": [{ "type": "strong" }] })
    );
    assert_eq!(
        adf["content"][1]["content"][3]["marks"][0],
        json!({ "type": "link", "attrs": { "href": "https://d.e/x" } })
    );
    let wiki = write_value(&field(&s, "description"), SiteKind::Server, &FieldInput::Doc(doc)).unwrap();
    assert_eq!(wiki, json!("h3. Plan\n\nShip *today* via [docs|https://d.e/x]\n\n* one"));
    // Emptied: null (the description is not required).
    let empty = json!({ "type": "doc", "content": [{ "type": "paragraph" }] });
    assert_eq!(write_value(&field(&c, "description"), SiteKind::Cloud, &FieldInput::Doc(empty)).unwrap(), Value::Null);
    // A comment body: the same formats, never empty.
    assert!(comment_body(SiteKind::Cloud, &text_to_doc("  ")).is_err());
    assert_eq!(comment_body(SiteKind::Server, &text_to_doc("Hi *there*")).unwrap(), json!("Hi \\*there\\*"));
}

#[test]
fn an_edit_can_be_undone_with_the_value_before() {
    let c = cloud();
    let issue = j(CLOUD_ISSUE);
    let raw = &issue["fields"];
    for id in [
        "summary",
        "customfield_10050",
        "customfield_10051",
        "customfield_10056",
        "customfield_10052",
        "labels",
        "duedate",
        "customfield_10016",
        "priority",
    ] {
        let before = &raw[id];
        let f = field(&c, id);
        let undo = input_from_raw(&f, before).unwrap_or_else(|| panic!("{id}: no undo"));
        let back = write_value(&f, SiteKind::Cloud, &undo).unwrap();
        let expect = match f.kind {
            EditKind::Select => json!({ "id": before["id"] }),
            EditKind::MultiSelect => {
                json!(before.as_array().unwrap().iter().map(|o| json!({ "id": o["id"] })).collect::<Vec<_>>())
            }
            EditKind::Cascade => json!({ "id": before["id"], "child": { "id": before["child"]["id"] } }),
            EditKind::User => json!({ "accountId": before["accountId"] }),
            _ => before.clone(),
        };
        assert_eq!(back, expect, "{id}");
    }
    // The description: the same ADF again (supported nodes), unknown nodes kept.
    let desc = field(&c, "description");
    let undo = input_from_raw(&desc, &raw["description"]).unwrap();
    let back = write_value(&desc, SiteKind::Cloud, &undo).unwrap();
    assert_eq!(back["content"].as_array().unwrap().len(), raw["description"]["content"].as_array().unwrap().len());
    assert_eq!(back["content"][9], raw["description"]["content"][9], "the expand comes back unchanged");
    assert_eq!(back["content"][7], raw["description"]["content"][7], "the image comes back unchanged");
    // A conflict shows what is in Jira now.
    assert_eq!(
        conflict_shown(&field(&c, "customfield_10050"), &raw["customfield_10050"], &Value::Null),
        Some(Shown::Options(vec!["Production".into()]))
    );
    assert!(
        matches!(conflict_shown(&desc, &raw["description"], &json!("<p>x</p>")), Some(Shown::Html(h)) if h == "<p>x</p>")
    );
}

#[test]
fn durations_are_read_like_jira_reads_them() {
    assert_eq!(parse_duration("1h 30m"), Some(5400));
    assert_eq!(parse_duration("2d"), Some(57600));
    assert_eq!(parse_duration("1w"), Some(144000));
    assert_eq!(parse_duration("45m"), Some(2700));
    assert_eq!(parse_duration("1,5h"), Some(5400));
    assert_eq!(parse_duration("90"), Some(5400), "minutes without a unit");
    assert_eq!(parse_duration("abc"), None);
    assert_eq!(parse_duration("30s"), None, "under a minute");
    assert_eq!(parse_duration(""), None);
    assert_eq!(initials("Mia Meyer"), "MM");
    assert_eq!(initials("quinn"), "QU");
}

// ------------------------------------------------------------------ rich text

#[test]
fn adf_round_trips_through_the_editor() {
    let issue = j(CLOUD_ISSUE);
    let adf = &issue["fields"]["description"];
    let doc = adf_to_doc(adf);
    assert_eq!(doc.lossy, ["textColor", "background"], "what the editor cannot keep is named");
    let types: Vec<&str> = doc.doc["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        [
            "heading",
            "paragraph",
            "bulletList",
            "codeBlock",
            "panel",
            "blockquote",
            "table",
            "jiraMedia",
            "horizontalRule",
            "preservedBlock"
        ]
    );
    let p = &doc.doc["content"][1]["content"];
    assert_eq!(p[1], json!({ "type": "text", "text": "checkout", "marks": [{ "type": "bold" }] }));
    assert_eq!(p[3]["marks"], json!([{ "type": "italic" }]), "the text color is dropped");
    assert_eq!(p[8], json!({ "type": "mention", "attrs": { "id": "acc-tom", "label": "Tom Berger" } }));
    assert_eq!(p[10]["attrs"]["shortName"], ":warning:");
    assert_eq!(p[12]["type"], "preserved");
    assert_eq!(p[12]["attrs"]["label"], "BLOCKED");
    assert_eq!(doc.doc["content"][2]["content"][1]["content"][1]["attrs"]["start"], 3);
    // Back to ADF: the same nodes, the unknown ones byte for byte.
    let back = doc_to_adf(&doc.doc);
    let orig = adf["content"].as_array().unwrap();
    let again = back["content"].as_array().unwrap();
    assert_eq!(again.len(), orig.len());
    for i in [0, 2, 3, 4, 5, 7, 8, 9] {
        assert_eq!(again[i], orig[i], "node {i}");
    }
    assert_eq!(again[1]["content"][12], orig[1]["content"][12], "the status lozenge");
    assert_eq!(again[1]["content"][8]["attrs"], json!({ "id": "acc-tom", "text": "@Tom Berger" }));
    // ADF allows code only with a link.
    let code = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "x", "marks": [{ "type": "bold" }, { "type": "code" }] }] }] });
    assert_eq!(doc_to_adf(&code)["content"][0]["content"][0]["marks"], json!([{ "type": "code" }]));
}

#[test]
fn adf_is_drawn_as_html_without_unsafe_links() {
    let issue = j(CLOUD_ISSUE);
    let html = adf_to_html(&issue["fields"]["description"]);
    for part in [
        "<h2>Steps</h2>",
        "<strong>checkout</strong>",
        "<a href=\"https://wiki.acme.de/runbook\">the runbook</a>",
        "<span class=\"jira-mention\">@Tom Berger</span>",
        ":warning:",
        "<span class=\"jira-lozenge\">BLOCKED</span>",
        "<ol start=\"3\">",
        "<pre><code class=\"language-json\">{&quot;code&quot;: &quot;PSP_TIMEOUT&quot;}</code></pre>",
        "<div class=\"jira-panel jira-panel-warning\">",
        "<blockquote>",
        "<th><p>Card</p></th>",
        "<img data-media-alt=\"screenshot.png\" alt=\"screenshot.png\">",
        "<hr>",
        "<details open><summary>Logs</summary>",
    ] {
        assert!(html.contains(part), "missing {part} in {html}");
    }
    let bad = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "<b>x</b>", "marks": [{ "type": "link", "attrs": { "href": "javascript:alert(1)" } }] }] }] });
    assert_eq!(adf_to_html(&bad), "<p>&lt;b&gt;x&lt;/b&gt;</p>");
}

#[test]
fn wiki_markup_is_read_into_the_editor() {
    let issue = j(SERVER_ISSUE);
    let wiki = issue["fields"]["description"].as_str().unwrap();
    let doc = wiki_to_doc(wiki).doc;
    let types: Vec<&str> = doc["content"].as_array().unwrap().iter().map(|n| n["type"].as_str().unwrap()).collect();
    assert_eq!(
        types,
        ["heading", "paragraph", "bulletList", "orderedList", "codeBlock", "panel", "table", "paragraph", "paragraph"]
    );
    let p = &doc["content"][1]["content"];
    assert_eq!(p[1], json!({ "type": "text", "text": "stock", "marks": [{ "type": "bold" }] }));
    assert_eq!(p[3], json!({ "type": "text", "text": "15 minutes", "marks": [{ "type": "italic" }] }));
    assert_eq!(p[5]["type"], "hardBreak");
    assert_eq!(
        p[7],
        json!({ "type": "text", "text": "the spec", "marks": [{ "type": "link", "attrs": { "href": "https://wiki.firma.de/x/ERP" } }] })
    );
    assert_eq!(p[9], json!({ "type": "mention", "attrs": { "id": "jdoe", "label": "jdoe" } }));
    assert_eq!(doc["content"][2]["content"][0]["content"][1]["type"], "bulletList", "** nests");
    assert_eq!(doc["content"][4]["attrs"]["language"], "sql");
    assert_eq!(doc["content"][4]["content"][0]["text"], "SELECT * FROM stock;");
    assert_eq!(doc["content"][5]["attrs"]["panelType"], "info");
    assert_eq!(doc["content"][6]["content"][0]["content"][0]["type"], "tableHeader");
    assert_eq!(doc["content"][6]["content"][1]["content"][1]["content"][0]["content"][0]["text"], "1200");
    assert_eq!(
        doc["content"][7]["content"][0],
        json!({ "type": "jiraMediaInline", "attrs": { "format": "wiki", "data": "!diagram.png|thumbnail!", "label": "diagram.png" } })
    );
    let last = &doc["content"][8]["content"];
    assert_eq!(last[0]["type"], "preserved");
    assert_eq!(last[0]["attrs"]["data"], "{color:red}urgent{color}");
    assert_eq!(last[2], json!({ "type": "text", "text": "mono", "marks": [{ "type": "code" }] }));
}

#[test]
fn wiki_markup_round_trips() {
    let issue = j(SERVER_ISSUE);
    let wiki = issue["fields"]["description"].as_str().unwrap();
    let back = doc_to_wiki(&wiki_to_doc(wiki).doc);
    assert_eq!(
        back,
        "h2. Goal\n\nSync the *stock* levels every _15 minutes_.\nSee [the spec|https://wiki.firma.de/x/ERP] and ask [~jdoe].\n\n* first\n** nested\n\n# one\n\n{code:sql}\nSELECT * FROM stock;\n{code}\n\n{info}\nOnly the main warehouse.\n{info}\n\n||Site||Rows||\n|Hamburg|1200|\n\n!diagram.png|thumbnail!\n\n{color:red}urgent{color} and {{mono}}"
    );
    // Literal characters stay literal, markup characters at word edges are escaped.
    let doc = text_to_doc("well-known a*b {x} [y] *star* - dash !bang");
    assert_eq!(doc_to_wiki(&doc), "well-known a*b \\{x\\} \\[y\\] \\*star\\* - dash \\!bang");
    for w in [
        "bq. quoted",
        "{quote}\nline one\n\nline two\n{quote}",
        "{noformat}\nraw *text*\n{noformat}",
        "----",
        "# a\n## b\n# c",
        "{panel:title=Note}\ninside\n{panel}",
    ] {
        assert_eq!(doc_to_wiki(&wiki_to_doc(w).doc), w, "{w}");
    }
    assert_eq!(doc_to_wiki(&wiki_to_doc("a \\\\ b").doc), "a \n b", "a forced break becomes a line break");
}

// ------------------------------------------------------------------ the client against a fake Jira

/// One recorded request: method, path with query, the login header and the body.
#[derive(Debug, Clone)]
struct Seen {
    method: String,
    target: String,
    auth: Option<String>,
    body: Value,
}

type Route = Box<dyn Fn(&str, &str) -> Option<(u16, String)> + Send + Sync>;

/// A Jira that answers by `route(method, target)` and records every request.
fn fake_jira(route: Route) -> (String, Arc<Mutex<Vec<Seen>>>) {
    use std::io::{BufRead, BufReader, Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            let _ = reader.read_line(&mut line);
            let mut len = 0usize;
            let mut auth = None;
            loop {
                let mut h = String::new();
                if reader.read_line(&mut h).unwrap_or(0) == 0 || h == "\r\n" {
                    break;
                }
                let lower = h.to_ascii_lowercase();
                if let Some(v) = lower.strip_prefix("content-length:") {
                    len = v.trim().parse().unwrap_or(0);
                }
                if lower.starts_with("authorization:") {
                    auth = Some(h["authorization:".len()..].trim().to_owned());
                }
            }
            let mut body = vec![0; len];
            let _ = reader.read_exact(&mut body);
            let mut parts = line.split_whitespace();
            let method = parts.next().unwrap_or("").to_owned();
            let target = parts.next().unwrap_or("").to_owned();
            log.lock().unwrap().push(Seen {
                method: method.clone(),
                target: target.clone(),
                auth,
                body: serde_json::from_slice(&body).unwrap_or(Value::Null),
            });
            let (status, out) = route(&method, &target).unwrap_or((404, r#"{"errorMessages":["not found"]}"#.into()));
            let mut w = stream;
            let _ = write!(
                w,
                "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{out}",
                out.len()
            );
        }
    });
    (url, seen)
}

fn client(url: &str, kind: SiteKind) -> JiraClient {
    let profile = crate::network::ProxyProfile { mode: crate::network::ProxyMode::None, ..Default::default() };
    let http = crate::network::Prepared::new(&profile, None, &[]).unwrap().client().unwrap();
    JiraClient::new("s", url, kind, "mia@acme.de", "tok", http, std::time::Duration::from_secs(5))
}

#[tokio::test]
async fn an_edit_saves_only_when_nobody_changed_the_issue() {
    let updated = Arc::new(Mutex::new("2026-10-20T11:22:33.123+0200".to_owned()));
    let u = updated.clone();
    let (url, seen) = fake_jira(Box::new(move |m, t| {
        if m == "GET" && t.starts_with("/rest/api/3/issue/PROJ-42?") {
            let body = json!({ "key": "PROJ-42", "fields": { "updated": *u.lock().unwrap(), "customfield_10050": { "id": "10300", "value": "Production" } }, "renderedFields": {} });
            return Some((200, body.to_string()));
        }
        if m == "PUT" && t == "/rest/api/3/issue/PROJ-42" {
            return Some((204, String::new()));
        }
        if t.starts_with("/rest/api/3/issue/PROJ-42/changelog") {
            let body = json!({ "total": 1, "values": [{ "id": "1", "author": { "accountId": "acc-tom", "displayName": "Tom Berger" }, "created": "2026-10-21T08:00:00.000+0200", "items": [] }] });
            return Some((200, body.to_string()));
        }
        None
    }));
    let jira = client(&url, SiteKind::Cloud);
    let f = field(&cloud(), "customfield_10050");
    let pick = FieldInput::Choice(Some("10301".into()));
    let out = jira.update_checked("PROJ-42", &f, &pick, "2026-10-20T11:22:33.123+0200").await.unwrap();
    assert_eq!(out, UpdateOutcome::Saved { undo: Some(FieldInput::Choice(Some("10300".into()))) });
    let put = seen.lock().unwrap().iter().find(|r| r.method == "PUT").cloned().unwrap();
    assert_eq!(put.body, json!({ "fields": { "customfield_10050": { "id": "10301" } } }));
    assert!(put.auth.as_deref().is_some_and(|a| a.starts_with("Basic ")));
    // Someone else saved meanwhile: nothing is written, the fresh value and who changed it come back.
    *updated.lock().unwrap() = "2026-10-21T08:00:00.000+0200".into();
    let before = seen.lock().unwrap().iter().filter(|r| r.method == "PUT").count();
    let out = jira.update_checked("PROJ-42", &f, &pick, "2026-10-20T11:22:33.123+0200").await.unwrap();
    match out {
        UpdateOutcome::Conflict { updated, value, by } => {
            assert_eq!(updated, "2026-10-21T08:00:00.000+0200");
            assert_eq!(value, Some(Shown::Options(vec!["Production".into()])));
            assert_eq!(by.map(|u| u.name), Some("Tom Berger".into()));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(seen.lock().unwrap().iter().filter(|r| r.method == "PUT").count(), before, "never overwritten silently");
}

#[tokio::test]
async fn a_server_edit_writes_wiki_markup() {
    let (url, seen) = fake_jira(Box::new(|m, t| {
        if m == "GET" && t.starts_with("/rest/api/2/issue/ERP-7?") {
            let body = json!({ "key": "ERP-7", "fields": { "updated": "u1", "description": "old *text*" }, "renderedFields": { "description": "<p>old <b>text</b></p>" } });
            return Some((200, body.to_string()));
        }
        (m == "PUT").then(|| (204, String::new()))
    }));
    let jira = client(&url, SiteKind::Server);
    let f = field(&server(), "description");
    let doc = json!({ "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "new", "marks": [{ "type": "italic" }] }] }] });
    let out = jira.update_checked("ERP-7", &f, &FieldInput::Doc(doc), "u1").await.unwrap();
    let UpdateOutcome::Saved { undo: Some(FieldInput::Doc(before)) } = out else { panic!("{out:?}") };
    assert_eq!(doc_to_wiki(&before), "old *text*", "the undo writes the old markup again");
    let put = seen.lock().unwrap().iter().find(|r| r.method == "PUT").cloned().unwrap();
    assert_eq!(put.body, json!({ "fields": { "description": "_new_" } }));
    assert_eq!(put.auth.as_deref(), Some("Bearer tok"));
}

#[tokio::test]
async fn a_transition_sends_its_screen_fields_and_a_comment() {
    let (url, seen) = fake_jira(Box::new(|m, _| (m == "POST").then(|| (204, String::new()))));
    let jira = client(&url, SiteKind::Cloud);
    let done = cloud().transitions[1].clone();
    // The required resolution is missing: nothing is sent.
    let err = jira.do_transition("PROJ-42", &done, &[], None).await.unwrap_err().to_string();
    assert!(err.contains("Resolution") && err.contains("Pflichtfeld"), "{err}");
    assert!(seen.lock().unwrap().is_empty());
    let comment = text_to_doc("Shipped");
    let inputs = [("resolution".to_owned(), FieldInput::Choice(Some("10000".into())))];
    jira.do_transition("PROJ-42", &done, &inputs, Some(&comment)).await.unwrap();
    let post = seen.lock().unwrap()[0].clone();
    assert_eq!(post.target, "/rest/api/3/issue/PROJ-42/transitions");
    assert_eq!(post.body["transition"], json!({ "id": "31" }));
    assert_eq!(post.body["fields"], json!({ "resolution": { "id": "10000" } }));
    assert_eq!(post.body["update"]["comment"][0]["add"]["body"]["content"][0]["content"][0]["text"], "Shipped");
}

#[tokio::test]
async fn comments_come_newest_first_even_from_a_jira_that_ignores_the_order() {
    // 120 comments, answered oldest first whatever is asked.
    let (url, seen) = fake_jira(Box::new(|m, t| {
        if m != "GET" || !t.starts_with("/rest/api/2/issue/ERP-7/comment") {
            return None;
        }
        let q = reqwest::Url::parse(&format!("http://x{t}")).unwrap();
        let get = |k: &str| q.query_pairs().find(|(n, _)| n == k).map(|(_, v)| v.parse::<usize>().unwrap_or(0));
        let start = get("startAt").unwrap_or(0);
        let max = get("maxResults").unwrap_or(50);
        let list: Vec<Value> = (start..(start + max).min(120))
            .map(|n| {
                json!({
                    "id": n.to_string(),
                    "author": { "name": if n % 2 == 0 { "mmeyer" } else { "jdoe" }, "displayName": "X" },
                    "body": format!("c{n}"),
                    "created": format!("2026-09-{:02}T{:02}:00:00.000+0200", 1 + n / 24, n % 24),
                })
            })
            .collect();
        Some((200, json!({ "startAt": start, "maxResults": max, "total": 120, "comments": list }).to_string()))
    }));
    let jira = client(&url, SiteKind::Server);
    let me = User { id: "mmeyer".into(), ..Default::default() };
    let page = jira.comment_page("ERP-7", 0, &me).await.unwrap();
    assert_eq!(page.total, 120);
    assert_eq!(page.items.len(), 50);
    assert_eq!(page.items[0].id, "119", "the newest first");
    assert_eq!(page.items[49].id, "70");
    assert!(page.items.iter().all(|c| c.own == (c.id.parse::<usize>().unwrap().is_multiple_of(2))));
    assert_eq!(page.items[0].html, "<p>c119</p>", "a body without rendered HTML is drawn");
    let next = jira.comment_page("ERP-7", 50, &me).await.unwrap();
    assert_eq!((next.items[0].id.as_str(), next.items[49].id.as_str(), next.start), ("69", "20", 50));
    let last = jira.comment_page("ERP-7", 100, &me).await.unwrap();
    assert_eq!(last.items.first().map(|c| c.id.as_str()), Some("19"));
    assert_eq!(last.items.len(), 20);
    assert!(seen.lock().unwrap().iter().any(|r| r.target.contains("orderBy=-created")));
}

#[tokio::test]
async fn images_get_the_login_only_on_the_site() {
    let (url, seen) = fake_jira(Box::new(|_, _| Some((200, "PNGDATA".into()))));
    let jira = client(&url, SiteKind::Cloud);
    let (_, bytes) = jira.bytes(&format!("{url}/rest/api/3/attachment/thumbnail/10500"), 1_000).await.unwrap();
    assert_eq!(bytes, b"PNGDATA");
    jira.bytes("/secure/thumbnail/1/x.png", 1_000).await.unwrap();
    // The same server under another name (a public avatar host): no login.
    let other = url.replace("127.0.0.1", "localhost");
    jira.bytes(&format!("{other}/avatar.png"), 1_000).await.unwrap();
    let seen_now = seen.lock().unwrap().clone();
    assert!(seen_now[0].auth.as_deref().is_some_and(|a| a.starts_with("Basic ")));
    assert_eq!(seen_now[1].target, "/secure/thumbnail/1/x.png");
    assert!(seen_now[1].auth.is_some(), "a relative address is on the site");
    assert_eq!(seen_now[2].auth, None, "never sent to another host");
    assert!(jira.bytes(&format!("{url}/big"), 3).await.unwrap_err().to_string().contains("größer"));
    assert!(jira.bytes("file:///etc/passwd", 10).await.is_err());
}

#[tokio::test]
async fn user_searches_use_each_flavors_parameters() {
    let (url, seen) = fake_jira(Box::new(|_, t| {
        let body = if t.contains("/rest/api/3/") {
            json!([{ "accountId": "acc-qa", "displayName": "Quinn Adams", "active": true }, { "accountId": "old", "displayName": "Gone", "active": false }])
        } else {
            json!([{ "name": "jdoe", "key": "JIRAUSER10001", "displayName": "John Doe", "active": true }])
        };
        Some((200, body.to_string()))
    }));
    let cloud_users = client(&url, SiteKind::Cloud).user_search("PROJ-42", "qu", true).await.unwrap();
    assert_eq!(
        cloud_users.iter().map(|u| u.id.as_str()).collect::<Vec<_>>(),
        ["acc-qa"],
        "inactive users are left out"
    );
    let server_users = client(&url, SiteKind::Server).user_search("ERP-7", "jo", false).await.unwrap();
    assert_eq!(server_users[0].id, "jdoe");
    let seen_now = seen.lock().unwrap().clone();
    assert_eq!(seen_now[0].target, "/rest/api/3/user/assignable/search?issueKey=PROJ-42&query=qu&maxResults=20");
    assert_eq!(seen_now[1].target, "/rest/api/2/user/search?username=jo&maxResults=20");
}

#[tokio::test]
async fn the_full_issue_is_loaded_with_the_right_expands() {
    let (url, seen) = fake_jira(Box::new(|m, t| {
        if m != "GET" {
            return None;
        }
        let extras = j(CLOUD_EXTRAS);
        let path = t.split('?').next().unwrap_or("");
        let body = match path {
            "/rest/api/3/issue/PROJ-42" => CLOUD_ISSUE.to_owned(),
            "/rest/api/3/issue/PROJ-42/comment" => CLOUD_COMMENTS.to_owned(),
            "/rest/api/3/issue/PROJ-42/remotelink" => extras["remotelinks"].to_string(),
            "/rest/api/3/issue/PROJ-42/worklog" => j(CLOUD_ISSUE)["fields"]["worklog"].to_string(),
            "/rest/api/3/mypermissions" => extras["mypermissions"].to_string(),
            "/rest/api/3/myself" => extras["myself"].to_string(),
            _ => return None,
        };
        Some((200, body))
    }));
    let full = client(&url, SiteKind::Cloud).full("PROJ-42").await.unwrap();
    assert_eq!(
        (full.key.as_str(), full.comments.items.len(), full.remote_links.len(), full.worklogs.items.len()),
        ("PROJ-42", 3, 1, 1)
    );
    assert_eq!(full.me.id, "acc-mia");
    assert!(full.comments.items[0].own);
    let seen_now = seen.lock().unwrap().clone();
    let get = seen_now.iter().find(|r| r.target.starts_with("/rest/api/3/issue/PROJ-42?")).unwrap();
    let q = reqwest::Url::parse(&format!("http://x{}", get.target)).unwrap();
    let expand = q.query_pairs().find(|(k, _)| k == "expand").map(|(_, v)| v.into_owned()).unwrap();
    for e in ["renderedFields", "names", "schema", "editmeta", "transitions", "changelog"] {
        assert!(expand.split(',').any(|x| x == e), "{e} missing in {expand}");
    }
    assert!(client(&url, SiteKind::Cloud).full("not a key").await.is_err());
}

#[test]
fn the_last_copy_stays_readable_offline() {
    let db = crate::db::Database::open_in_memory().unwrap();
    let now = chrono::Utc::now();
    let full = cloud();
    db.issue_full_put(&full, now).unwrap();
    let cached = db.issue_full_get(None, "PROJ-42").unwrap().unwrap();
    assert_eq!(cached.issue, full);
    assert_eq!(cached.fetched_at.timestamp(), now.timestamp());
    assert!(db.issue_full_get(Some("other"), "PROJ-42").unwrap().is_none());
    // The list cache follows: the chips and the Issues page see the same issue.
    let row = db.issue_get("PROJ-42").unwrap().unwrap();
    assert_eq!(
        (row.summary.as_str(), row.status.as_str(), row.detailed),
        ("Checkout fails for EU cards", "In Progress", true)
    );
    assert!(db.issue_project_keys().unwrap().contains("PROJ"));
    // Copies not opened for 90 days go with the next one stored.
    let mut old = server();
    old.site = "acme".into();
    db.issue_full_put(&old, now - chrono::Duration::days(91)).unwrap();
    db.issue_full_put(&full, now).unwrap();
    assert!(db.issue_full_get(None, "ERP-7").unwrap().is_none());
    db.issues_remove_site("acme").unwrap();
    assert!(db.issue_full_get(None, "PROJ-42").unwrap().is_none(), "removed with its site");
}

#[test]
fn every_editable_field_starts_with_its_value_now() {
    let c = cloud();
    let cur = |id: &str| field(&c, id).current;
    assert_eq!(cur("summary"), Some(FieldInput::Text("Checkout fails for EU cards".into())));
    assert_eq!(cur("customfield_10050"), Some(FieldInput::Choice(Some("10300".into()))));
    assert_eq!(cur("customfield_10051"), Some(FieldInput::Choices(vec!["10310".into(), "10311".into()])));
    assert_eq!(cur("customfield_10056"), Some(FieldInput::Cascade(Some("10400".into()), Some("10401".into()))));
    assert_eq!(cur("assignee"), Some(FieldInput::User(Some("acc-mia".into()))));
    assert_eq!(cur("components"), Some(FieldInput::Choices(vec!["10100".into()])));
    assert_eq!(cur("customfield_10016"), Some(FieldInput::Number(Some(5.0))));
    assert_eq!(cur("customfield_10059"), Some(FieldInput::Date(Some("2026-10-20T07:30:00Z".into()))));
    assert!(matches!(cur("description"), Some(FieldInput::Doc(d)) if d["content"][0]["type"] == "heading"));
    assert_eq!(field(&c, "description").lossy, ["textColor", "background"]);
    assert_eq!(cur("customfield_10020"), None, "not editable here");
    let res = c.transitions[1].fields.iter().find(|f| f.id == "resolution").unwrap();
    assert_eq!(res.current, Some(FieldInput::Choice(None)));
    let s = server();
    assert!(
        matches!(field(&s, "description").current, Some(FieldInput::Doc(d)) if d["content"][0]["content"][0]["text"] == "Goal")
    );
    assert_eq!(field(&s, "customfield_10301").current, Some(FieldInput::Users(vec!["mmeyer".into(), "jdoe".into()])));
}

#[test]
fn estimates_are_edited_as_jira_words_them() {
    let c = cloud();
    let f = field(&c, "timetracking");
    assert_eq!(f.kind, EditKind::TimeTracking);
    assert_eq!(f.current, Some(FieldInput::Estimates(Some("2d".into()), Some("1d 4h".into()))));
    let w = |o: Option<&str>, r: Option<&str>| {
        write_value(&f, SiteKind::Cloud, &FieldInput::Estimates(o.map(Into::into), r.map(Into::into)))
    };
    assert_eq!(
        w(Some("3d"), Some(" 1h   30m ")).unwrap(),
        json!({ "originalEstimate": "3d", "remainingEstimate": "1h 30m" })
    );
    assert_eq!(w(None, Some("4h")).unwrap(), json!({ "remainingEstimate": "4h" }));
    assert!(w(Some("soon"), None).unwrap_err().to_string().contains("keine Dauer"));
    assert!(w(None, None).is_err());
    let raw = &j(CLOUD_ISSUE)["fields"]["timetracking"];
    assert_eq!(conflict_shown(&f, raw, &Value::Null), Some(Shown::Text("2d / 1d 4h".into())));
}
