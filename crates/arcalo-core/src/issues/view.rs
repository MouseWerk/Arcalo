//! The issue view („Issue-Ansicht“): one issue with everything Jira's own issue page shows, and
//! the edits it allows.
//!
//! [`parse_full`] turns the answers of Jira (the issue with `renderedFields`, `names`, `schema`,
//! `editmeta`, `transitions` and `changelog`, a page of comments, the remote links, the user's
//! permissions and account) into an [`IssueFull`] for both flavors: Cloud (REST v3, users by
//! `accountId`, ADF) and Server/Data Center (REST v2, users by name, wiki markup). Every custom
//! field with a value is listed under its display name (`names`) and shown by its schema type.
//!
//! Edits follow `editmeta`: [`edit_field`] reads what a field is and which values it allows,
//! [`write_value`] turns what the user entered ([`FieldInput`]) into the value Jira expects for
//! that field and flavor, and [`input_from_raw`] turns the value before the edit back into an
//! input, so a saved edit can be undone. [`JiraClient::update_checked`] saves only when the issue
//! did not change in Jira since it was loaded (`updated`); otherwise it answers with the fresh
//! value and saves nothing.

use chrono::NaiveDate;
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::IssueProvider;
use super::jira::{JiraClient, adf_to_text, api_url, browse_url, parse_account, parse_sprint, wiki_to_text};
use super::richtext::{self, EditorDoc};
use super::{Account, SiteKind};
use crate::error::{Error, Result};
use crate::{tr, trf};

/// What the issue is asked for with.
pub const VIEW_EXPAND: &str = "renderedFields,names,schema,editmeta,transitions,transitions.fields,changelog";
/// Comments, worklogs and history entries per page.
pub const PAGE_SIZE: usize = 50;

// ------------------------------------------------------------------ model

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct User {
    /// Cloud `accountId`, Server user name.
    pub id: String,
    pub name: String,
    /// The 48 px avatar (loaded through the site's client).
    pub avatar: String,
    pub active: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StatusRef {
    pub id: String,
    pub name: String,
    /// `new`, `indeterminate` or `done`.
    pub category: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssueRef {
    pub key: String,
    pub summary: String,
    pub status: StatusRef,
    pub issue_type: String,
    pub priority: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Named {
    pub id: String,
    pub name: String,
    pub icon: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SprintRef {
    pub name: String,
    /// `active`, `future` or `closed`.
    pub state: String,
}

/// Time tracking in seconds and as Jira words it (`1w 2d`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TimeTracking {
    pub original: Option<i64>,
    pub remaining: Option<i64>,
    pub spent: Option<i64>,
    pub original_text: String,
    pub remaining_text: String,
    pub spent_text: String,
}

/// A field value as shown, by the field's schema type.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum Shown {
    Text(String),
    /// Jira's rendered HTML (sanitized by the UI).
    Html(String),
    Number(f64),
    /// `YYYY-MM-DD`.
    Date(String),
    /// As Jira sent it.
    DateTime(String),
    Options(Vec<String>),
    Users(Vec<User>),
    Link {
        url: String,
        label: String,
    },
    Issue(String),
    Sprints(Vec<SprintRef>),
    Cascade(String, Option<String>),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FieldShown {
    pub id: String,
    pub name: String,
    /// The schema type (`option`, `array/user`, `com.…:textarea`), for the UI's icon.
    pub kind: String,
    pub value: Shown,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkedIssue {
    pub link_id: String,
    pub issue: IssueRef,
}

/// Links of one direction of one link type („blocks“, „is blocked by“).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LinkGroup {
    pub label: String,
    pub issues: Vec<LinkedIssue>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub size: i64,
    pub mime: String,
    pub created: String,
    pub author: Option<User>,
    /// The content and thumbnail addresses on the site (loaded with the site's login).
    pub content: String,
    pub thumbnail: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RemoteLink {
    pub id: String,
    pub title: String,
    pub url: String,
    pub summary: String,
    pub relationship: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Comment {
    pub id: String,
    pub author: Option<User>,
    pub created: String,
    pub updated: String,
    /// Jira's rendered HTML, else drawn from the body.
    pub html: String,
    /// The body as Jira stores it (ADF or wiki markup), for editing.
    pub body: Value,
    /// Written by the user of this token.
    pub own: bool,
}

/// A page of comments, newest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct CommentPage {
    pub total: usize,
    /// How many of the newest are loaded before this page.
    pub start: usize,
    pub items: Vec<Comment>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Worklog {
    pub id: String,
    pub author: Option<User>,
    pub started: String,
    pub seconds: i64,
    pub time_spent: String,
    pub comment: String,
    pub own: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WorklogPage {
    pub total: usize,
    pub start: usize,
    pub items: Vec<Worklog>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Change {
    pub field: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryEntry {
    pub id: String,
    pub author: Option<User>,
    pub created: String,
    pub items: Vec<Change>,
}

/// History entries, newest first.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct HistoryPage {
    pub total: usize,
    pub start: usize,
    pub items: Vec<HistoryEntry>,
}

/// How a field is edited.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EditKind {
    Text,
    /// Rich text: ADF on Cloud, wiki markup on Server.
    Rich,
    Number,
    Date,
    DateTime,
    Select,
    MultiSelect,
    Cascade,
    User,
    Users,
    Labels,
    Url,
    /// The original and remaining estimate (`timetracking`).
    TimeTracking,
    #[default]
    Unsupported,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Choice {
    pub id: String,
    pub label: String,
    pub icon: String,
    pub children: Vec<Choice>,
}

/// A field Jira allows to edit (`editmeta`) or asks for on a transition screen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EditField {
    pub id: String,
    pub name: String,
    pub required: bool,
    pub kind: EditKind,
    pub allowed: Vec<Choice>,
    pub operations: Vec<String>,
    /// The schema's system or custom type, for the write format.
    pub schema: String,
    /// The value it has now, as the editor starts with it.
    pub current: Option<FieldInput>,
    /// Rich text: what the editor cannot keep of the value now (`textColor`, …).
    pub lossy: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Transition {
    pub id: String,
    pub name: String,
    pub to: StatusRef,
    pub has_screen: bool,
    /// The fields of its screen.
    pub fields: Vec<EditField>,
}

/// What the user may do on the issue (`mypermissions`; `editmeta` where Jira did not say).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Perms {
    pub comment: bool,
    pub edit_own_comments: bool,
    pub edit_all_comments: bool,
    pub delete_own_comments: bool,
    pub delete_all_comments: bool,
    pub log_work: bool,
    pub assign: bool,
    pub assignable: bool,
    pub transition: bool,
}

/// One issue as the issue view shows it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct IssueFull {
    pub site: String,
    pub kind: SiteKind,
    /// The site's address (relative links in Jira's HTML).
    pub base: String,
    pub key: String,
    pub id: String,
    pub url: String,
    pub summary: String,
    pub issue_type: Named,
    pub subtask: bool,
    pub status: StatusRef,
    pub resolution: String,
    pub project: Named,
    pub parent: Option<IssueRef>,
    /// The epic of a Server or older Cloud issue (Epic Link), when it is not the parent.
    pub epic: Option<String>,
    pub description_html: String,
    /// The description as stored (ADF or wiki markup).
    pub description: Value,
    pub environment_html: String,
    pub assignee: Option<User>,
    pub reporter: Option<User>,
    pub creator: Option<User>,
    pub priority: Option<Named>,
    pub labels: Vec<String>,
    pub components: Vec<String>,
    pub fix_versions: Vec<String>,
    pub affects_versions: Vec<String>,
    pub sprints: Vec<SprintRef>,
    pub story_points: Option<f64>,
    /// The id of the story points field, to edit it in place.
    pub story_points_field: String,
    pub due_date: Option<String>,
    pub time: TimeTracking,
    pub created: String,
    /// As Jira sent it: compared before every save.
    pub updated: String,
    pub resolved: String,
    pub custom: Vec<FieldShown>,
    pub subtasks: Vec<IssueRef>,
    pub links: Vec<LinkGroup>,
    pub attachments: Vec<Attachment>,
    pub remote_links: Vec<RemoteLink>,
    pub comments: CommentPage,
    pub worklogs: WorklogPage,
    pub history: HistoryPage,
    pub watchers: i64,
    pub watching: bool,
    pub votes: i64,
    pub voted: bool,
    pub edit: Vec<EditField>,
    pub transitions: Vec<Transition>,
    pub perms: Perms,
    pub me: User,
}

// ------------------------------------------------------------------ parsing

fn s(v: &Value) -> String {
    v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string())).unwrap_or_default()
}

/// A user of either flavor; `None` for an empty field.
pub fn parse_user(v: &Value) -> Option<User> {
    if !v.is_object() {
        return None;
    }
    let id = v["accountId"].as_str().or(v["name"].as_str()).or(v["key"].as_str()).unwrap_or("").to_owned();
    let name = v["displayName"].as_str().or(v["name"].as_str()).unwrap_or("").to_owned();
    if id.is_empty() && name.is_empty() {
        return None;
    }
    let av = &v["avatarUrls"];
    Some(User {
        id,
        name,
        avatar: av["48x48"].as_str().or(av["32x32"].as_str()).or(av["24x24"].as_str()).unwrap_or("").to_owned(),
        active: v["active"].as_bool().unwrap_or(true),
    })
}

fn parse_status(v: &Value) -> StatusRef {
    let cat = v["statusCategory"]["key"].as_str().unwrap_or("new");
    StatusRef {
        id: s(&v["id"]),
        name: v["name"].as_str().unwrap_or("").to_owned(),
        category: if super::CATEGORIES.contains(&cat) { cat.to_owned() } else { "new".into() },
    }
}

fn parse_named(v: &Value) -> Option<Named> {
    let name = v["name"].as_str().or(v["value"].as_str()).unwrap_or("");
    if name.is_empty() {
        return None;
    }
    Some(Named { id: s(&v["id"]), name: name.to_owned(), icon: v["iconUrl"].as_str().unwrap_or("").to_owned() })
}

/// An issue as Jira nests it (parent, subtasks, links): key and the few fields it sends along.
pub fn parse_ref(v: &Value) -> IssueRef {
    let f = &v["fields"];
    IssueRef {
        key: v["key"].as_str().unwrap_or("").to_owned(),
        summary: f["summary"].as_str().unwrap_or("").to_owned(),
        status: parse_status(&f["status"]),
        issue_type: f["issuetype"]["name"].as_str().unwrap_or("").to_owned(),
        priority: f["priority"]["name"].as_str().unwrap_or("").to_owned(),
    }
}

fn names_of(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter().filter_map(|x| x.as_str().map(str::to_owned).or_else(|| parse_named(x).map(|n| n.name))).collect()
        })
        .unwrap_or_default()
}

/// Sprints of a sprint field, objects or the old Server strings, active first.
fn sprints_of(v: &Value) -> Vec<SprintRef> {
    let list: Vec<SprintRef> = v
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let (name, state) = parse_sprint(&json!([x]));
            (!name.is_empty()).then_some(SprintRef { name, state })
        })
        .collect();
    let mut out = list;
    out.sort_by_key(|s| match s.state.as_str() {
        "active" => 0,
        "future" => 1,
        _ => 2,
    });
    out
}

/// Fields shown in their own place, not among the other fields.
const OWN_PLACE: [&str; 33] = [
    "summary",
    "status",
    "issuetype",
    "project",
    "parent",
    "description",
    "environment",
    "assignee",
    "reporter",
    "creator",
    "priority",
    "labels",
    "components",
    "fixVersions",
    "versions",
    "duedate",
    "timetracking",
    "timeoriginalestimate",
    "timeestimate",
    "timespent",
    "aggregatetimeoriginalestimate",
    "aggregatetimeestimate",
    "aggregatetimespent",
    "aggregateprogress",
    "progress",
    "created",
    "updated",
    "resolutiondate",
    "resolution",
    "attachment",
    "issuelinks",
    "subtasks",
    "comment",
];
/// System fields that are never shown (Jira's page does not show them either).
const HIDDEN: [&str; 8] = [
    "watches",
    "votes",
    "worklog",
    "workratio",
    "lastViewed",
    "thumbnail",
    "statuscategorychangedate",
    "issuerestriction",
];
/// Custom field types that are never shown: the board rank, the development panel, an epic's color.
const HIDDEN_CUSTOM: [&str; 4] = [
    "com.pyxis.greenhopper.jira:gh-lexo-rank",
    "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummary",
    "com.atlassian.jira.plugins.jira-development-integration-plugin:devsummarycf",
    "com.pyxis.greenhopper.jira:gh-epic-color",
];
const SPRINT: &str = "com.pyxis.greenhopper.jira:gh-sprint";
const EPIC_LINK: &str = "com.pyxis.greenhopper.jira:gh-epic-link";
const STORY_POINTS: &str = "com.pyxis.greenhopper.jira:jsw-story-points";

fn is_empty_value(v: &Value) -> bool {
    match v {
        Value::Null => true,
        Value::String(s) => s.trim().is_empty(),
        Value::Array(a) => a.is_empty(),
        Value::Object(o) => o.is_empty(),
        _ => false,
    }
}

/// A field's value shown by its schema type.
pub fn shown_of(value: &Value, schema: &Value, rendered: &Value) -> Option<Shown> {
    if is_empty_value(value) {
        return None;
    }
    let t = schema["type"].as_str().unwrap_or("");
    let items = schema["items"].as_str().unwrap_or("");
    let custom = schema["custom"].as_str().unwrap_or("");
    let html = rendered.as_str().filter(|h| !h.trim().is_empty());
    Some(match (t, items) {
        _ if custom == SPRINT => Shown::Sprints(sprints_of(value)),
        _ if custom == EPIC_LINK => Shown::Issue(value.as_str()?.to_owned()),
        _ if custom.ends_with(":url") => {
            let url = value.as_str()?.to_owned();
            Shown::Link { label: url.clone(), url }
        }
        ("string", _) if custom.ends_with(":textarea") || html.is_some_and(|h| h.contains('<')) => {
            match (html, value) {
                (Some(h), _) => Shown::Html(h.to_owned()),
                (None, Value::Object(_)) => Shown::Html(richtext::adf_to_html(value)),
                (None, v) => Shown::Text(wiki_to_text(v.as_str().unwrap_or(""))),
            }
        }
        ("string", _) => match value {
            Value::Object(_) => Shown::Html(richtext::adf_to_html(value)),
            v => Shown::Text(s(v)),
        },
        ("number", _) => Shown::Number(value.as_f64()?),
        ("date", _) => Shown::Date(value.as_str()?.to_owned()),
        ("datetime", _) => Shown::DateTime(value.as_str()?.to_owned()),
        ("option-with-child", _) => {
            Shown::Cascade(value["value"].as_str()?.to_owned(), value["child"]["value"].as_str().map(str::to_owned))
        }
        ("user", _) => Shown::Users(vec![parse_user(value)?]),
        ("array", "user") => Shown::Users(value.as_array()?.iter().filter_map(parse_user).collect()),
        ("array", "string") if custom.is_empty() || custom.ends_with(":labels") => Shown::Options(names_of(value)),
        _ => match value {
            Value::String(x) => Shown::Text(x.clone()),
            Value::Number(n) => Shown::Number(n.as_f64()?),
            Value::Bool(b) => Shown::Text(b.to_string()),
            Value::Array(_) => {
                let list = names_of(value);
                if list.is_empty() {
                    return None;
                }
                Shown::Options(list)
            }
            Value::Object(o) => {
                if let Some(u) =
                    (o.contains_key("accountId") || o.contains_key("emailAddress")).then(|| parse_user(value)).flatten()
                {
                    Shown::Users(vec![u])
                } else if let Some(n) = parse_named(value).or_else(|| {
                    value["displayName"].as_str().map(|d| Named { name: d.to_owned(), ..Default::default() })
                }) {
                    Shown::Options(vec![n.name])
                } else if value["type"] == "doc" {
                    Shown::Html(richtext::adf_to_html(value))
                } else {
                    return None;
                }
            }
            Value::Null => return None,
        },
    })
}

/// What a field schema edits as.
pub fn edit_kind(schema: &Value) -> EditKind {
    let t = schema["type"].as_str().unwrap_or("");
    let items = schema["items"].as_str().unwrap_or("");
    let system = schema["system"].as_str().unwrap_or("");
    let custom = schema["custom"].as_str().unwrap_or("");
    match (t, items) {
        _ if custom == SPRINT || custom == EPIC_LINK => EditKind::Unsupported,
        ("string", _) if matches!(system, "description" | "environment") || custom.ends_with(":textarea") => {
            EditKind::Rich
        }
        ("string", _) if custom.ends_with(":url") => EditKind::Url,
        ("string", _)
            if system == "summary" || custom.ends_with(":textfield") || (system.is_empty() && custom.is_empty()) =>
        {
            EditKind::Text
        }
        ("string", _) => EditKind::Text,
        ("number", _) => EditKind::Number,
        ("date", _) => EditKind::Date,
        ("datetime", _) => EditKind::DateTime,
        ("option", _)
        | ("priority", _)
        | ("resolution", _)
        | ("version", _)
        | ("component", _)
        | ("securitylevel", _) => EditKind::Select,
        ("issuetype", _) => EditKind::Select,
        ("option-with-child", _) => EditKind::Cascade,
        ("timetracking", _) => EditKind::TimeTracking,
        ("array", "option" | "version" | "component") => EditKind::MultiSelect,
        ("user", _) => EditKind::User,
        ("array", "user") => EditKind::Users,
        ("array", "string") if system == "labels" || custom.ends_with(":labels") || custom.is_empty() => {
            EditKind::Labels
        }
        _ => EditKind::Unsupported,
    }
}

fn choice_of(v: &Value) -> Option<Choice> {
    let id = s(&v["id"]);
    let label = v["name"].as_str().or(v["value"].as_str()).or(v["displayName"].as_str()).unwrap_or("").to_owned();
    if id.is_empty() && label.is_empty() {
        return None;
    }
    let children = v["children"].as_array().map(|a| a.iter().filter_map(choice_of).collect()).unwrap_or_default();
    Some(Choice { id, label, icon: v["iconUrl"].as_str().unwrap_or("").to_owned(), children })
}

/// One field of `editmeta` (or of a transition screen).
pub fn edit_field(id: &str, meta: &Value) -> EditField {
    let schema = &meta["schema"];
    EditField {
        id: id.to_owned(),
        name: meta["name"].as_str().unwrap_or(id).to_owned(),
        required: meta["required"].as_bool().unwrap_or(false),
        kind: edit_kind(schema),
        allowed: meta["allowedValues"].as_array().map(|a| a.iter().filter_map(choice_of).collect()).unwrap_or_default(),
        operations: meta["operations"]
            .as_array()
            .map(|a| a.iter().filter_map(|o| o.as_str().map(str::to_owned)).collect())
            .unwrap_or_default(),
        schema: schema["custom"].as_str().or(schema["system"].as_str()).unwrap_or("").to_owned(),
        current: None,
        lossy: vec![],
    }
}

/// Gives each field the value it has now in `fields` (the start of an edit).
fn with_current(list: &mut [EditField], fields: &Value) {
    for f in list.iter_mut() {
        let raw = &fields[f.id.as_str()];
        f.current = input_from_raw(f, raw);
        if f.kind == EditKind::Rich && !raw.is_null() {
            f.lossy = body_to_doc(raw).lossy;
        }
    }
}

fn edit_fields(map: &Value) -> Vec<EditField> {
    let mut out: Vec<EditField> =
        map.as_object().map(|o| o.iter().map(|(id, m)| edit_field(id, m)).collect()).unwrap_or_default();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn parse_transition(v: &Value) -> Transition {
    Transition {
        id: s(&v["id"]),
        name: v["name"].as_str().unwrap_or("").to_owned(),
        to: parse_status(&v["to"]),
        has_screen: v["hasScreen"].as_bool().unwrap_or(false),
        fields: edit_fields(&v["fields"]),
    }
}

fn parse_attachment(v: &Value) -> Attachment {
    Attachment {
        id: s(&v["id"]),
        filename: v["filename"].as_str().unwrap_or("").to_owned(),
        size: v["size"].as_i64().unwrap_or(0),
        mime: v["mimeType"].as_str().unwrap_or("").to_owned(),
        created: v["created"].as_str().unwrap_or("").to_owned(),
        author: parse_user(&v["author"]),
        content: v["content"].as_str().unwrap_or("").to_owned(),
        thumbnail: v["thumbnail"].as_str().unwrap_or("").to_owned(),
    }
}

/// Issue links grouped by type and direction, in the order Jira sent them.
pub fn link_groups(links: &Value) -> Vec<LinkGroup> {
    let mut out: Vec<LinkGroup> = vec![];
    for l in links.as_array().into_iter().flatten() {
        let (label, other) = if l["outwardIssue"].is_object() {
            (l["type"]["outward"].as_str(), &l["outwardIssue"])
        } else {
            (l["type"]["inward"].as_str(), &l["inwardIssue"])
        };
        let label = label.or(l["type"]["name"].as_str()).unwrap_or("").to_owned();
        let item = LinkedIssue { link_id: s(&l["id"]), issue: parse_ref(other) };
        match out.iter_mut().find(|g| g.label == label) {
            Some(g) => g.issues.push(item),
            None => out.push(LinkGroup { label, issues: vec![item] }),
        }
    }
    out
}

fn body_html(rendered: &Value, body: &Value) -> String {
    match rendered.as_str().filter(|h| !h.trim().is_empty()) {
        Some(h) => h.to_owned(),
        None => match body {
            Value::Object(_) => richtext::adf_to_html(body),
            Value::String(t) => text_html(t),
            _ => String::new(),
        },
    }
}

/// Plain text as HTML paragraphs (a body Jira did not render).
pub fn text_html(t: &str) -> String {
    let esc = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    t.split("\n\n")
        .filter(|p| !p.trim().is_empty())
        .map(|p| format!("<p>{}</p>", esc(p).replace('\n', "<br>")))
        .collect()
}

fn is_me(author: &Option<User>, me: &User) -> bool {
    !me.id.is_empty() && author.as_ref().is_some_and(|a| a.id == me.id)
}

/// A page of `GET issue/{key}/comment` (with `renderedBody`), newest first. `asked_newest`: the
/// request asked for the newest first (`orderBy=-created`); Jira versions that ignore it answer
/// oldest first, which is turned around here.
pub fn parse_comments(v: &Value, me: &User) -> CommentPage {
    let mut items: Vec<Comment> = v["comments"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| {
            let author = parse_user(&c["author"]);
            Comment {
                id: s(&c["id"]),
                own: is_me(&author, me),
                author,
                created: c["created"].as_str().unwrap_or("").to_owned(),
                updated: c["updated"].as_str().unwrap_or("").to_owned(),
                html: body_html(&c["renderedBody"], &c["body"]),
                body: c["body"].clone(),
            }
        })
        .collect();
    sort_newest(&mut items, |c| &c.created);
    CommentPage { total: v["total"].as_u64().map(|n| n as usize).unwrap_or(items.len()), start: 0, items }
}

fn sort_newest<T>(items: &mut [T], key: impl Fn(&T) -> &String) {
    items.sort_by(|a, b| {
        let ta = super::jira::parse_time(key(a)).unwrap_or_default();
        let tb = super::jira::parse_time(key(b)).unwrap_or_default();
        tb.cmp(&ta)
    });
}

/// A page of `GET issue/{key}/worklog`, newest first.
pub fn parse_worklog_page(v: &Value, me: &User) -> WorklogPage {
    let mut items: Vec<Worklog> = v["worklogs"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|w| {
            let author = parse_user(&w["author"]);
            Worklog {
                id: s(&w["id"]),
                own: is_me(&author, me),
                author,
                started: w["started"].as_str().unwrap_or("").to_owned(),
                seconds: w["timeSpentSeconds"].as_i64().unwrap_or(0),
                time_spent: w["timeSpent"].as_str().unwrap_or("").to_owned(),
                comment: match &w["comment"] {
                    Value::Object(_) => adf_to_text(&w["comment"]),
                    Value::String(t) => wiki_to_text(t),
                    _ => String::new(),
                },
            }
        })
        .collect();
    sort_newest(&mut items, |w| &w.started);
    WorklogPage { total: v["total"].as_u64().map(|n| n as usize).unwrap_or(items.len()), start: 0, items }
}

/// History entries of `changelog` (embedded or `GET issue/{key}/changelog`), newest first.
pub fn parse_history(v: &Value) -> HistoryPage {
    let list = v["histories"].as_array().or(v["values"].as_array());
    let mut items: Vec<HistoryEntry> = list
        .into_iter()
        .flatten()
        .map(|h| HistoryEntry {
            id: s(&h["id"]),
            author: parse_user(&h["author"]),
            created: h["created"].as_str().unwrap_or("").to_owned(),
            items: h["items"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|i| Change {
                    field: i["field"].as_str().unwrap_or("").to_owned(),
                    from: i["fromString"].as_str().map(str::to_owned).unwrap_or_else(|| s(&i["from"])),
                    to: i["toString"].as_str().map(str::to_owned).unwrap_or_else(|| s(&i["to"])),
                })
                .collect(),
        })
        .collect();
    let n = items.len();
    sort_newest(&mut items, |h| &h.created);
    HistoryPage { total: v["total"].as_u64().map(|t| t as usize).unwrap_or(n), start: 0, items }
}

/// The permissions of `GET mypermissions`; without an answer, what `editmeta` tells.
pub fn parse_perms(v: &Value, edit: &[EditField], transitions: &[Transition]) -> Perms {
    let p = &v["permissions"];
    let has = |k: &str| p[k]["havePermission"].as_bool();
    let meta = |id: &str| edit.iter().any(|f| f.id == id);
    Perms {
        comment: has("ADD_COMMENTS").unwrap_or_else(|| meta("comment")),
        edit_own_comments: has("EDIT_OWN_COMMENTS").unwrap_or_else(|| meta("comment")),
        edit_all_comments: has("EDIT_ALL_COMMENTS").unwrap_or(false),
        delete_own_comments: has("DELETE_OWN_COMMENTS").unwrap_or_else(|| meta("comment")),
        delete_all_comments: has("DELETE_ALL_COMMENTS").unwrap_or(false),
        log_work: has("WORK_ON_ISSUES").unwrap_or_else(|| meta("worklog") || meta("timetracking")),
        assign: has("ASSIGN_ISSUES").unwrap_or_else(|| meta("assignee")),
        assignable: has("ASSIGNABLE_USER").unwrap_or(true),
        transition: has("TRANSITION_ISSUES").unwrap_or(!transitions.is_empty()),
    }
}

/// Everything Jira answered, read into the issue view.
pub struct Answers<'a> {
    pub issue: &'a Value,
    pub comments: &'a Value,
    pub remote_links: &'a Value,
    pub permissions: &'a Value,
    pub me: &'a Account,
}

/// The issue view of the answers of a site of `kind` at `base`.
pub fn parse_full(a: &Answers, site: &str, base: &str, kind: SiteKind) -> Option<IssueFull> {
    let v = a.issue;
    let key = v["key"].as_str()?.to_owned();
    let f = &v["fields"];
    let r = &v["renderedFields"];
    let names = &v["names"];
    let schema = &v["schema"];
    let me = User { id: a.me.id.clone(), name: a.me.display_name.clone(), ..Default::default() };

    let mut custom = vec![];
    let mut story_points = None;
    let mut story_points_field = String::new();
    let mut sprints = vec![];
    let mut epic = None;
    let mut ids: Vec<&String> = f.as_object().map(|o| o.keys().collect()).unwrap_or_default();
    ids.sort();
    for id in ids {
        let value = &f[id.as_str()];
        let sch = &schema[id.as_str()];
        let custom_type = sch["custom"].as_str().unwrap_or("");
        let name = names[id.as_str()].as_str().unwrap_or(id).to_owned();
        if custom_type == SPRINT {
            sprints = sprints_of(value);
            continue;
        }
        if custom_type == EPIC_LINK {
            epic = value.as_str().filter(|k| !k.is_empty()).map(str::to_owned);
            continue;
        }
        if custom_type == STORY_POINTS
            || (sch["type"] == "number" && name.to_lowercase().contains("story point") && story_points_field.is_empty())
        {
            story_points_field = id.clone();
            story_points = value.as_f64();
            continue;
        }
        if OWN_PLACE.contains(&id.as_str())
            || HIDDEN.contains(&id.as_str())
            || HIDDEN_CUSTOM.contains(&custom_type)
            || (!id.starts_with("customfield_") && id != "security")
        {
            continue;
        }
        if let Some(value) = shown_of(value, sch, &r[id.as_str()]) {
            let kind = match (sch["type"].as_str(), sch["items"].as_str()) {
                (Some(t), Some(i)) => format!("{t}/{i}"),
                (Some(t), None) => t.to_owned(),
                _ => String::new(),
            };
            custom.push(FieldShown { id: id.clone(), name, kind, value });
        }
    }
    custom.sort_by(|x, y| x.name.to_lowercase().cmp(&y.name.to_lowercase()));

    let tt = &f["timetracking"];
    let time = TimeTracking {
        original: tt["originalEstimateSeconds"].as_i64().or(f["timeoriginalestimate"].as_i64()),
        remaining: tt["remainingEstimateSeconds"].as_i64().or(f["timeestimate"].as_i64()),
        spent: tt["timeSpentSeconds"].as_i64().or(f["timespent"].as_i64()),
        original_text: tt["originalEstimate"].as_str().unwrap_or("").to_owned(),
        remaining_text: tt["remainingEstimate"].as_str().unwrap_or("").to_owned(),
        spent_text: tt["timeSpent"].as_str().unwrap_or("").to_owned(),
    };

    let mut edit = edit_fields(&v["editmeta"]["fields"]);
    with_current(&mut edit, f);
    let mut transitions: Vec<Transition> =
        v["transitions"].as_array().into_iter().flatten().map(parse_transition).collect();
    for t in transitions.iter_mut() {
        with_current(&mut t.fields, f);
    }
    let perms = parse_perms(a.permissions, &edit, &transitions);
    let parent = f["parent"].is_object().then(|| parse_ref(&f["parent"]));
    let epic = epic.filter(|e| parent.as_ref().is_none_or(|p| &p.key != e));

    let remote_links = a
        .remote_links
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            let o = &l["object"];
            let url = o["url"].as_str().unwrap_or("").to_owned();
            (!url.is_empty()).then(|| RemoteLink {
                id: s(&l["id"]),
                title: o["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(&url).to_owned(),
                summary: o["summary"].as_str().unwrap_or("").to_owned(),
                relationship: l["relationship"].as_str().unwrap_or("").to_owned(),
                url,
            })
        })
        .collect();

    let comments = parse_comments(a.comments, &me);
    let worklogs = parse_worklog_page(&f["worklog"], &me);

    Some(IssueFull {
        site: site.to_owned(),
        kind,
        base: super::normalize_url(base),
        url: browse_url(base, &key),
        id: s(&v["id"]),
        summary: f["summary"].as_str().unwrap_or("").to_owned(),
        issue_type: parse_named(&f["issuetype"]).unwrap_or_default(),
        subtask: f["issuetype"]["subtask"].as_bool().unwrap_or(false),
        status: parse_status(&f["status"]),
        resolution: f["resolution"]["name"].as_str().unwrap_or("").to_owned(),
        project: Named {
            id: s(&f["project"]["id"]),
            name: f["project"]["name"].as_str().unwrap_or("").to_owned(),
            icon: f["project"]["key"].as_str().unwrap_or(super::project_of(&key)).to_owned(),
        },
        parent,
        epic,
        description_html: body_html(&r["description"], &f["description"]),
        description: f["description"].clone(),
        environment_html: body_html(&r["environment"], &f["environment"]),
        assignee: parse_user(&f["assignee"]),
        reporter: parse_user(&f["reporter"]),
        creator: parse_user(&f["creator"]),
        priority: parse_named(&f["priority"]),
        labels: names_of(&f["labels"]),
        components: names_of(&f["components"]),
        fix_versions: names_of(&f["fixVersions"]),
        affects_versions: names_of(&f["versions"]),
        sprints,
        story_points,
        story_points_field,
        due_date: f["duedate"].as_str().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()).map(str::to_owned),
        time,
        created: f["created"].as_str().unwrap_or("").to_owned(),
        updated: f["updated"].as_str().unwrap_or("").to_owned(),
        resolved: f["resolutiondate"].as_str().unwrap_or("").to_owned(),
        custom,
        subtasks: f["subtasks"].as_array().into_iter().flatten().map(parse_ref).collect(),
        links: link_groups(&f["issuelinks"]),
        attachments: f["attachment"].as_array().into_iter().flatten().map(parse_attachment).collect(),
        remote_links,
        comments,
        worklogs,
        history: parse_history(&v["changelog"]),
        watchers: f["watches"]["watchCount"].as_i64().unwrap_or(0),
        watching: f["watches"]["isWatching"].as_bool().unwrap_or(false),
        votes: f["votes"]["votes"].as_i64().unwrap_or(0),
        voted: f["votes"]["hasVoted"].as_bool().unwrap_or(false),
        edit,
        transitions,
        perms,
        me,
        key,
    })
}

impl IssueFull {
    /// The issue as the cache of lists and chips keeps it ([`super::Issue`]).
    pub fn brief(&self) -> super::Issue {
        let description = match &self.description {
            Value::Object(_) => adf_to_text(&self.description),
            Value::String(t) => wiki_to_text(t),
            _ => String::new(),
        };
        let priority = self.priority.clone().unwrap_or_default();
        let sprint = self.sprints.first().cloned().unwrap_or_default();
        super::Issue {
            site: self.site.clone(),
            key: self.key.clone(),
            remote_id: self.id.clone(),
            summary: self.summary.clone(),
            status: self.status.name.clone(),
            status_category: self.status.category.clone(),
            priority_level: super::priority_level(&priority.name, &priority.id, &priority.icon),
            priority: priority.name,
            priority_id: priority.id,
            assignee: self.assignee.as_ref().map(|u| u.name.clone()).unwrap_or_default(),
            reporter: self.reporter.as_ref().map(|u| u.name.clone()).unwrap_or_default(),
            issue_type: self.issue_type.name.clone(),
            project_key: self.project.icon.clone(),
            project_name: self.project.name.clone(),
            sprint: sprint.name,
            sprint_state: sprint.state,
            due_date: self.due_date.clone(),
            updated: super::jira::parse_time(&self.updated),
            resolved: super::jira::parse_time(&self.resolved),
            url: self.url.clone(),
            description: description.chars().take(super::MAX_DESCRIPTION).collect(),
            comments: self
                .comments
                .items
                .iter()
                .take(super::MAX_COMMENTS)
                .rev()
                .map(|c| super::IssueComment {
                    author: c.author.as_ref().map(|u| u.name.clone()).unwrap_or_default(),
                    created: super::jira::parse_time(&c.created).unwrap_or_default(),
                    body: match &c.body {
                        Value::Object(_) => adf_to_text(&c.body),
                        Value::String(t) => wiki_to_text(t),
                        _ => String::new(),
                    },
                })
                .collect(),
            matches: vec![],
            detailed: true,
        }
    }

    /// The editmeta field `id`, when Jira allows to edit it.
    pub fn editable(&self, id: &str) -> Option<&EditField> {
        self.edit.iter().find(|f| f.id == id && f.operations.iter().any(|o| o == "set" || o == "add" || o == "edit"))
    }
}

// ------------------------------------------------------------------ writing

/// What the user entered for a field.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "snake_case")]
pub enum FieldInput {
    Text(String),
    /// The editor's document (rich text).
    Doc(Value),
    Number(Option<f64>),
    /// `YYYY-MM-DD`, or for a date and time RFC 3339.
    Date(Option<String>),
    Choice(Option<String>),
    Choices(Vec<String>),
    User(Option<String>),
    Users(Vec<String>),
    Labels(Vec<String>),
    Cascade(Option<String>, Option<String>),
    /// Original and remaining estimate as Jira words them (`2d`, `1h 30m`).
    Estimates(Option<String>, Option<String>),
}

fn bad_input(field: &EditField) -> Error {
    Error::State(trf!("Dieser Wert passt nicht zum Feld „{}“", "This value does not fit the field “{}”", field.name))
}

fn required_missing(field: &EditField) -> Error {
    Error::State(trf!("„{}“ ist ein Pflichtfeld", "“{}” is required", field.name))
}

/// A user reference for a site of `kind`.
pub fn user_value(kind: SiteKind, id: &str) -> Value {
    match kind {
        SiteKind::Cloud => json!({ "accountId": id }),
        SiteKind::Server => json!({ "name": id }),
    }
}

/// A rich text body for a site of `kind`: ADF (Cloud) or wiki markup (Server).
pub fn rich_value(kind: SiteKind, doc: &Value) -> Value {
    match kind {
        SiteKind::Cloud => richtext::doc_to_adf(doc),
        SiteKind::Server => Value::String(richtext::doc_to_wiki(doc)),
    }
}

/// Jira's format of a date and time (`2026-10-01T08:00:00.000+0200`).
pub fn jira_datetime(rfc3339: &str) -> Option<String> {
    let t = chrono::DateTime::parse_from_rfc3339(rfc3339.trim()).ok()?;
    Some(t.format("%Y-%m-%dT%H:%M:%S%.3f%z").to_string())
}

/// The value Jira expects for `field` on a site of `kind`, from what the user entered.
pub fn write_value(field: &EditField, kind: SiteKind, input: &FieldInput) -> Result<Value> {
    let empty_ok = |v: Value| if v.is_null() && field.required { Err(required_missing(field)) } else { Ok(v) };
    match (field.kind, input) {
        (EditKind::Text | EditKind::Url, FieldInput::Text(t)) => {
            let t = t.trim();
            if t.is_empty() {
                return empty_ok(Value::Null);
            }
            if field.id == "summary" && t.chars().count() > 255 {
                return Err(Error::State(
                    tr!("Der Titel darf höchstens 255 Zeichen lang sein", "The summary may be 255 characters at most")
                        .into(),
                ));
            }
            Ok(Value::String(t.to_owned()))
        }
        (EditKind::Rich, FieldInput::Doc(doc)) => {
            if richtext::doc_is_empty(doc) {
                return empty_ok(Value::Null);
            }
            Ok(rich_value(kind, doc))
        }
        (EditKind::Rich, FieldInput::Text(t)) => {
            if t.trim().is_empty() {
                return empty_ok(Value::Null);
            }
            Ok(super::jira::body_value(kind, t))
        }
        (EditKind::Number, FieldInput::Number(n)) => empty_ok(
            n.filter(|n| n.is_finite())
                .and_then(serde_json::Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::Null),
        ),
        (EditKind::Date, FieldInput::Date(d)) => match d.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            None => empty_ok(Value::Null),
            Some(d) if NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok() => Ok(Value::String(d.to_owned())),
            Some(_) => Err(bad_input(field)),
        },
        (EditKind::DateTime, FieldInput::Date(d)) => match d.as_deref().map(str::trim).filter(|d| !d.is_empty()) {
            None => empty_ok(Value::Null),
            Some(d) => jira_datetime(d).map(Value::String).ok_or_else(|| bad_input(field)),
        },
        (EditKind::Select, FieldInput::Choice(c)) => match c.as_deref().filter(|c| !c.is_empty()) {
            None => empty_ok(Value::Null),
            Some(id) => {
                if !field.allowed.is_empty() && !field.allowed.iter().any(|a| a.id == id) {
                    return Err(bad_input(field));
                }
                Ok(json!({ "id": id }))
            }
        },
        (EditKind::MultiSelect, FieldInput::Choices(ids)) => {
            if ids.is_empty() && field.required {
                return Err(required_missing(field));
            }
            if !field.allowed.is_empty() && ids.iter().any(|id| !field.allowed.iter().any(|a| &a.id == id)) {
                return Err(bad_input(field));
            }
            Ok(Value::Array(ids.iter().map(|id| json!({ "id": id })).collect()))
        }
        (EditKind::Cascade, FieldInput::Cascade(parent, child)) => match parent.as_deref().filter(|p| !p.is_empty()) {
            None => empty_ok(Value::Null),
            Some(p) => {
                let mut v = json!({ "id": p });
                if let Some(c) = child.as_deref().filter(|c| !c.is_empty()) {
                    v["child"] = json!({ "id": c });
                }
                Ok(v)
            }
        },
        (EditKind::User, FieldInput::User(u)) => match u.as_deref().filter(|u| !u.is_empty()) {
            None => empty_ok(Value::Null),
            Some(id) => Ok(user_value(kind, id)),
        },
        (EditKind::Users, FieldInput::Users(ids)) => {
            if ids.is_empty() && field.required {
                return Err(required_missing(field));
            }
            Ok(Value::Array(ids.iter().map(|id| user_value(kind, id)).collect()))
        }
        (EditKind::TimeTracking, FieldInput::Estimates(original, remaining)) => {
            let mut v = serde_json::Map::new();
            for (name, value) in [("originalEstimate", original), ("remainingEstimate", remaining)] {
                if let Some(t) = value.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
                    if parse_duration(t).is_none() {
                        return Err(Error::State(trf!(
                            "„{t}“ ist keine Dauer (z. B. 1h 30m, 45m, 2d)",
                            "“{t}” is not a duration (e.g. 1h 30m, 45m, 2d)"
                        )));
                    }
                    v.insert(name.into(), Value::String(t.split_whitespace().collect::<Vec<_>>().join(" ")));
                }
            }
            if v.is_empty() {
                return Err(bad_input(field));
            }
            Ok(Value::Object(v))
        }
        (EditKind::Labels, FieldInput::Labels(list)) => {
            let mut out: Vec<String> = vec![];
            for l in list.iter().map(|l| l.trim()).filter(|l| !l.is_empty()) {
                if l.contains(char::is_whitespace) {
                    return Err(Error::State(trf!(
                        "Labels dürfen keine Leerzeichen enthalten: „{l}“",
                        "Labels may not contain spaces: “{l}”"
                    )));
                }
                if !out.iter().any(|x| x == l) {
                    out.push(l.to_owned());
                }
            }
            if out.is_empty() && field.required {
                return Err(required_missing(field));
            }
            Ok(json!(out))
        }
        _ => Err(bad_input(field)),
    }
}

/// The input that writes `raw` (a field's value as Jira sent it) back: the undo of an edit.
pub fn input_from_raw(field: &EditField, raw: &Value) -> Option<FieldInput> {
    let ids = |v: &Value| -> Vec<String> { v.as_array().into_iter().flatten().map(|x| s(&x["id"])).collect() };
    let user_id = |v: &Value| parse_user(v).map(|u| u.id);
    Some(match field.kind {
        EditKind::Text | EditKind::Url => FieldInput::Text(raw.as_str().unwrap_or("").to_owned()),
        EditKind::Rich => FieldInput::Doc(match raw {
            Value::Object(_) => richtext::adf_to_doc(raw).doc,
            Value::String(t) => richtext::wiki_to_doc(t).doc,
            _ => richtext::text_to_doc(""),
        }),
        EditKind::Number => FieldInput::Number(raw.as_f64()),
        EditKind::Date => FieldInput::Date(raw.as_str().map(str::to_owned)),
        EditKind::DateTime => FieldInput::Date(raw.as_str().and_then(super::jira::parse_time)),
        EditKind::Select => FieldInput::Choice(raw.is_object().then(|| s(&raw["id"])).filter(|i| !i.is_empty())),
        EditKind::MultiSelect => FieldInput::Choices(ids(raw)),
        EditKind::Cascade => FieldInput::Cascade(
            raw.is_object().then(|| s(&raw["id"])).filter(|i| !i.is_empty()),
            raw["child"].is_object().then(|| s(&raw["child"]["id"])),
        ),
        EditKind::User => FieldInput::User(user_id(raw)),
        EditKind::Users => FieldInput::Users(raw.as_array().into_iter().flatten().filter_map(user_id).collect()),
        EditKind::Labels => FieldInput::Labels(names_of(raw)),
        EditKind::TimeTracking => FieldInput::Estimates(
            raw["originalEstimate"].as_str().map(str::to_owned),
            raw["remainingEstimate"].as_str().map(str::to_owned),
        ),
        EditKind::Unsupported => return None,
    })
}

/// A field's value as shown in a conflict (what is in Jira now).
pub fn conflict_shown(field: &EditField, raw: &Value, rendered: &Value) -> Option<Shown> {
    match field.kind {
        EditKind::Rich => Some(Shown::Html(body_html(rendered, raw))).filter(|_| !is_empty_value(raw)),
        EditKind::Select | EditKind::MultiSelect => {
            let list = if raw.is_array() { names_of(raw) } else { names_of(&json!([raw])) };
            (!list.is_empty()).then_some(Shown::Options(list))
        }
        EditKind::TimeTracking => {
            let list: Vec<String> = ["originalEstimate", "remainingEstimate"]
                .iter()
                .filter_map(|k| raw[*k].as_str().map(str::to_owned))
                .collect();
            (!list.is_empty()).then(|| Shown::Text(list.join(" / ")))
        }
        _ => shown_of(raw, &json!({}), rendered),
    }
}

/// The outcome of a checked edit.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum UpdateOutcome {
    /// Saved; `undo` writes the value before (`None` where it cannot be written back).
    Saved { undo: Option<FieldInput> },
    /// Someone changed the issue in Jira since it was loaded: nothing was saved.
    Conflict { updated: String, value: Option<Shown>, by: Option<User> },
}

/// A comment's body for a site of `kind` from the editor's document.
pub fn comment_body(kind: SiteKind, doc: &Value) -> Result<Value> {
    if richtext::doc_is_empty(doc) {
        return Err(Error::State(tr!("Der Kommentar ist leer", "The comment is empty").into()));
    }
    Ok(rich_value(kind, doc))
}

/// A stored body (ADF or wiki markup) as the editor's document.
pub fn body_to_doc(body: &Value) -> EditorDoc {
    match body {
        Value::Object(_) => richtext::adf_to_doc(body),
        Value::String(t) => richtext::wiki_to_doc(t),
        _ => EditorDoc { doc: richtext::text_to_doc(""), lossy: vec![] },
    }
}

/// `1h 30m`, `2d`, `45m`, `1.5h` in seconds (Jira's default of 8 h days and 5 day weeks).
pub fn parse_duration(text: &str) -> Option<i64> {
    let t = text.trim().to_lowercase().replace(',', ".");
    if t.is_empty() {
        return None;
    }
    let mut total = 0f64;
    let mut num = String::new();
    let mut any = false;
    for c in t.chars().chain(std::iter::once(' ')) {
        if c.is_ascii_digit() || c == '.' {
            num.push(c);
            continue;
        }
        if c.is_whitespace() && num.is_empty() {
            continue;
        }
        let unit = match c {
            'w' => 5.0 * 8.0 * 3600.0,
            'd' | 't' => 8.0 * 3600.0,
            'h' | 's' if c == 'h' => 3600.0,
            'm' => 60.0,
            ' ' if !num.is_empty() => 60.0,
            _ => return None,
        };
        let n: f64 = num.parse().ok()?;
        total += n * unit;
        num.clear();
        any = true;
    }
    (any && total >= 60.0).then_some(total.round() as i64)
}

// ------------------------------------------------------------------ the client

impl JiraClient {
    fn url_with(&self, path: &str, query: &[(&str, &str)]) -> Result<String> {
        let mut url =
            reqwest::Url::parse(&api_url(self.base(), self.kind(), path)).map_err(|e| Error::State(e.to_string()))?;
        {
            let mut q = url.query_pairs_mut();
            for (k, v) in query {
                q.append_pair(k, v);
            }
        }
        Ok(url.to_string())
    }

    fn check_key(key: &str) -> Result<()> {
        if super::is_key(key) {
            Ok(())
        } else {
            Err(Error::State(trf!("„{key}“ ist kein Issue-Schlüssel", "“{key}” is not an issue key")))
        }
    }

    /// The newest comments, `skip` of the newest left out (the pages loaded before).
    pub async fn comment_page(&self, key: &str, skip: usize, me: &User) -> Result<CommentPage> {
        Self::check_key(key)?;
        let max = PAGE_SIZE.to_string();
        let path = format!("issue/{key}/comment");
        let first = self
            .send_json(
                Method::GET,
                &self.url_with(
                    &path,
                    &[
                        ("orderBy", "-created"),
                        ("expand", "renderedBody"),
                        ("startAt", &skip.to_string()),
                        ("maxResults", &max),
                    ],
                )?,
                None,
            )
            .await?;
        let total = first["total"].as_u64().unwrap_or(0) as usize;
        // A Jira that ignores `orderBy` answers oldest first: the newest page is at the end.
        let list = first["comments"].as_array().cloned().unwrap_or_default();
        let ascending = list.len() > 1 && {
            let t = |c: &Value| super::jira::parse_time(c["created"].as_str().unwrap_or("")).unwrap_or_default();
            t(&list[0]) < t(&list[list.len() - 1])
        };
        let v = if ascending && total > PAGE_SIZE {
            let start = total.saturating_sub(skip + PAGE_SIZE);
            let n = (total - skip).clamp(1, PAGE_SIZE).to_string();
            self.send_json(
                Method::GET,
                &self.url_with(
                    &path,
                    &[("expand", "renderedBody"), ("startAt", &start.to_string()), ("maxResults", &n)],
                )?,
                None,
            )
            .await?
        } else {
            first
        };
        let mut page = parse_comments(&v, me);
        page.start = skip;
        page.total = total.max(page.items.len());
        Ok(page)
    }

    /// The newest worklogs, `skip` of the newest left out.
    pub async fn worklog_page(&self, key: &str, skip: usize, me: &User) -> Result<WorklogPage> {
        Self::check_key(key)?;
        let path = format!("issue/{key}/worklog");
        let probe = self.send_json(Method::GET, &self.url_with(&path, &[("maxResults", "0")])?, None).await?;
        let total = probe["total"].as_u64().unwrap_or(0) as usize;
        // Server answers all worklogs at once; Cloud pages oldest first.
        if probe["worklogs"].as_array().is_some_and(|a| a.len() >= total) && total > 0 {
            let mut page = parse_worklog_page(&probe, me);
            page.items = page.items.into_iter().skip(skip).take(PAGE_SIZE).collect();
            page.start = skip;
            page.total = total;
            return Ok(page);
        }
        let start = total.saturating_sub(skip + PAGE_SIZE);
        let n = (total.saturating_sub(skip)).clamp(1, PAGE_SIZE).to_string();
        let v = self
            .send_json(
                Method::GET,
                &self.url_with(&path, &[("startAt", &start.to_string()), ("maxResults", &n)])?,
                None,
            )
            .await?;
        let mut page = parse_worklog_page(&v, me);
        if page.items.len() > PAGE_SIZE {
            page.items.truncate(PAGE_SIZE);
        }
        page.start = skip;
        page.total = total.max(page.items.len());
        Ok(page)
    }

    /// Older history entries (Cloud's `changelog` endpoint; Server sends all with the issue).
    pub async fn history_page(&self, key: &str, skip: usize) -> Result<HistoryPage> {
        Self::check_key(key)?;
        if self.kind() == SiteKind::Server {
            let v = self
                .send_json(
                    Method::GET,
                    &self.url_with(&format!("issue/{key}"), &[("fields", "summary"), ("expand", "changelog")])?,
                    None,
                )
                .await?;
            let mut page = parse_history(&v["changelog"]);
            page.total = page.items.len();
            page.items = page.items.into_iter().skip(skip).take(PAGE_SIZE).collect();
            page.start = skip;
            return Ok(page);
        }
        let path = format!("issue/{key}/changelog");
        let probe = self.send_json(Method::GET, &self.url_with(&path, &[("maxResults", "1")])?, None).await?;
        let total = probe["total"].as_u64().unwrap_or(0) as usize;
        let start = total.saturating_sub(skip + PAGE_SIZE);
        let n = total.saturating_sub(skip).clamp(1, PAGE_SIZE).to_string();
        let v = self
            .send_json(
                Method::GET,
                &self.url_with(&path, &[("startAt", &start.to_string()), ("maxResults", &n)])?,
                None,
            )
            .await?;
        let mut page = parse_history(&v);
        page.start = skip;
        page.total = total;
        Ok(page)
    }

    /// The issue view: the issue with everything Jira's page shows, the newest comments, the
    /// worklogs, the remote links and what the user may do. Remote links and permissions that
    /// fail (an old Server, no permission) are left out; the issue itself must answer.
    pub async fn full(&self, key: &str) -> Result<IssueFull> {
        Self::check_key(key)?;
        let issue_url =
            self.url_with(&format!("issue/{key}"), &[("expand", VIEW_EXPAND), ("fields", "*all,-comment")])?;
        let perms_url = self.url_with(
            "mypermissions",
            &[
                ("issueKey", key),
                (
                    "permissions",
                    "ADD_COMMENTS,EDIT_OWN_COMMENTS,EDIT_ALL_COMMENTS,DELETE_OWN_COMMENTS,DELETE_ALL_COMMENTS,WORK_ON_ISSUES,ASSIGN_ISSUES,ASSIGNABLE_USER,TRANSITION_ISSUES",
                ),
            ],
        )?;
        let remote_url = api_url(self.base(), self.kind(), &format!("issue/{key}/remotelink"));
        let me_url = api_url(self.base(), self.kind(), "myself");
        let (issue, perms, remote, me) = tokio::join!(
            self.send_json(Method::GET, &issue_url, None),
            self.send_json(Method::GET, &perms_url, None),
            self.send_json(Method::GET, &remote_url, None),
            self.send_json(Method::GET, &me_url, None),
        );
        let issue = issue?;
        let me_json = me?;
        let me = parse_account(&me_json);
        let user = parse_user(&me_json).unwrap_or_else(|| User {
            id: me.id.clone(),
            name: me.display_name.clone(),
            ..Default::default()
        });
        let comments = match self.comment_page(key, 0, &user).await {
            Ok(page) => Some(page),
            Err(Error::Remote { status: 404 | 405, .. }) => None,
            Err(e) => return Err(e),
        };
        let worklogs = self.worklog_page(key, 0, &user).await.ok();
        let answers = Answers {
            issue: &issue,
            comments: &Value::Null,
            remote_links: &remote.unwrap_or(Value::Null),
            permissions: &perms.unwrap_or(Value::Null),
            me: &me,
        };
        let mut full = parse_full(&answers, self.site(), self.base(), self.kind())
            .ok_or_else(|| Error::not_found("issue", key))?;
        full.me = user;
        if let Some(c) = comments {
            full.comments = c;
        }
        if let Some(w) = worklogs {
            full.worklogs = w;
        }
        // The embedded changelog holds the oldest entries on Cloud: the newest come from its own endpoint.
        if self.kind() == SiteKind::Cloud
            && full.history.total > full.history.items.len()
            && let Ok(h) = self.history_page(key, 0).await
        {
            full.history = h;
        }
        Ok(full)
    }

    /// The issue's `updated`, one field as stored and as rendered (the state before an edit).
    pub async fn field_state(&self, key: &str, field: &str) -> Result<(String, Value, Value)> {
        Self::check_key(key)?;
        let url = self.url_with(
            &format!("issue/{key}"),
            &[("fields", &format!("updated,{field}")), ("expand", "renderedFields")],
        )?;
        let v = self.send_json(Method::GET, &url, None).await?;
        Ok((
            v["fields"]["updated"].as_str().unwrap_or("").to_owned(),
            v["fields"][field].clone(),
            v["renderedFields"][field].clone(),
        ))
    }

    /// Who changed the issue last (the newest history entry), for a conflict.
    async fn last_changer(&self, key: &str) -> Option<User> {
        let page = self.history_page(key, 0).await.ok()?;
        page.items.first().and_then(|h| h.author.clone())
    }

    /// Sets fields (`PUT issue/{key}`).
    pub async fn put_fields(&self, key: &str, fields: Value) -> Result<()> {
        Self::check_key(key)?;
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}"));
        self.send_json(Method::PUT, &url, Some(&json!({ "fields": fields }))).await?;
        Ok(())
    }

    /// Saves `input` into `field` when the issue still has `expected` as its `updated`; otherwise
    /// answers with the value Jira has now and saves nothing.
    pub async fn update_checked(
        &self,
        key: &str,
        field: &EditField,
        input: &FieldInput,
        expected: &str,
    ) -> Result<UpdateOutcome> {
        let value = write_value(field, self.kind(), input)?;
        let (updated, raw, rendered) = self.field_state(key, &field.id).await?;
        if !expected.is_empty() && updated != expected {
            return Ok(UpdateOutcome::Conflict {
                value: conflict_shown(field, &raw, &rendered),
                by: self.last_changer(key).await,
                updated,
            });
        }
        let undo = input_from_raw(field, &raw);
        self.put_fields(key, json!({ field.id.clone(): value })).await?;
        Ok(UpdateOutcome::Saved { undo })
    }

    /// Assigns the issue (`None`: unassigned) through its own endpoint (the „Assign“ permission,
    /// not „Edit“).
    pub async fn assign(&self, key: &str, user: Option<&str>) -> Result<()> {
        Self::check_key(key)?;
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}/assignee"));
        let body = match (self.kind(), user) {
            (SiteKind::Cloud, Some(id)) => json!({ "accountId": id }),
            (SiteKind::Cloud, None) => json!({ "accountId": Value::Null }),
            (SiteKind::Server, Some(id)) => json!({ "name": id }),
            (SiteKind::Server, None) => json!({ "name": Value::Null }),
        };
        self.send_json(Method::PUT, &url, Some(&body)).await?;
        Ok(())
    }

    /// Carries out a transition with the values of its screen and an optional comment.
    pub async fn do_transition(
        &self,
        key: &str,
        transition: &Transition,
        inputs: &[(String, FieldInput)],
        comment: Option<&Value>,
    ) -> Result<()> {
        Self::check_key(key)?;
        let mut fields = serde_json::Map::new();
        for f in transition.fields.iter() {
            match inputs.iter().find(|(id, _)| id == &f.id) {
                Some((_, input)) => {
                    let v = write_value(f, self.kind(), input)?;
                    if !v.is_null() {
                        fields.insert(f.id.clone(), v);
                    }
                }
                None if f.required && f.kind != EditKind::Unsupported && f.id != "comment" => {
                    return Err(required_missing(f));
                }
                None => {}
            }
        }
        let mut body = json!({ "transition": { "id": transition.id } });
        if !fields.is_empty() {
            body["fields"] = Value::Object(fields);
        }
        if let Some(doc) = comment.filter(|d| !richtext::doc_is_empty(d)) {
            body["update"] = json!({ "comment": [{ "add": { "body": rich_value(self.kind(), doc) } }] });
        }
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}/transitions"));
        self.send_json(Method::POST, &url, Some(&body)).await?;
        Ok(())
    }

    /// Adds a comment; returns its id.
    pub async fn comment_add(&self, key: &str, doc: &Value) -> Result<String> {
        Self::check_key(key)?;
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}/comment"));
        let v = self.send_json(Method::POST, &url, Some(&json!({ "body": comment_body(self.kind(), doc)? }))).await?;
        Ok(s(&v["id"]))
    }

    pub async fn comment_edit(&self, key: &str, id: &str, doc: &Value) -> Result<()> {
        Self::check_key(key)?;
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}/comment/{id}"));
        self.send_json(Method::PUT, &url, Some(&json!({ "body": comment_body(self.kind(), doc)? }))).await?;
        Ok(())
    }

    pub async fn comment_delete(&self, key: &str, id: &str) -> Result<()> {
        Self::check_key(key)?;
        let url = api_url(self.base(), self.kind(), &format!("issue/{key}/comment/{id}"));
        match self.send_json(Method::DELETE, &url, None).await {
            Err(Error::Remote { status: 404, .. }) => Ok(()),
            other => other.map(|_| ()),
        }
    }

    /// Users for a user field: assignable ones for the assignee, else any user (both flavors'
    /// parameters: Cloud `query`, Server `username`).
    pub async fn user_search(&self, key: &str, query: &str, assignable: bool) -> Result<Vec<User>> {
        let q = query.trim();
        let param = match self.kind() {
            SiteKind::Cloud => "query",
            SiteKind::Server => "username",
        };
        let url = if assignable {
            self.url_with("user/assignable/search", &[("issueKey", key), (param, q), ("maxResults", "20")])?
        } else {
            self.url_with(
                "user/search",
                &[(param, if q.is_empty() && self.kind() == SiteKind::Server { "." } else { q }), ("maxResults", "20")],
            )?
        };
        let v = self.send_json(Method::GET, &url, None).await?;
        Ok(v.as_array().into_iter().flatten().filter_map(parse_user).filter(|u| u.active).collect())
    }

    /// Whether `url` is on this site (the login is sent only there).
    pub fn on_site(&self, url: &str) -> bool {
        let (Ok(a), Ok(b)) = (reqwest::Url::parse(url), reqwest::Url::parse(self.base())) else { return false };
        a.scheme() == b.scheme()
            && a.host_str() == b.host_str()
            && a.port_or_known_default() == b.port_or_known_default()
    }

    /// An image or file: with the site's login on the site, without it anywhere else (public
    /// avatars). Returns the media type and the bytes, at most `limit` bytes.
    pub async fn bytes(&self, url: &str, limit: usize) -> Result<(String, Vec<u8>)> {
        let url = if url.starts_with('/') { format!("{}{url}", self.base()) } else { url.to_owned() };
        let parsed =
            reqwest::Url::parse(&url).map_err(|_| Error::State(tr!("Ungültige Adresse", "Invalid address").into()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(Error::State(tr!("Ungültige Adresse", "Invalid address").into()));
        }
        self.fetch_bytes(&url, self.on_site(&url), limit).await
    }
}

/// How the views name a user's initials (the avatar before it is loaded).
pub fn initials(name: &str) -> String {
    let parts: Vec<&str> = name.split_whitespace().collect();
    match parts.as_slice() {
        [] => String::new(),
        [one] => one.chars().take(2).collect::<String>().to_uppercase(),
        [first, .., last] => {
            format!("{}{}", first.chars().next().unwrap_or(' '), last.chars().next().unwrap_or(' ')).to_uppercase()
        }
    }
}

// ------------------------------------------------------------------ the offline copy

/// Copies not opened for this long are dropped.
const KEEP_FULL_DAYS: i64 = 90;

/// The last copy of an issue opened in full and when it was read from Jira.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CachedFull {
    pub issue: IssueFull,
    pub fetched_at: chrono::DateTime<chrono::Utc>,
}

impl crate::db::Database {
    /// Keeps the copy of an issue read in full (and its row in the list cache), drops old copies.
    pub fn issue_full_put(&self, full: &IssueFull, now: chrono::DateTime<chrono::Utc>) -> Result<()> {
        let data = serde_json::to_string(full)?;
        self.atomic(|| {
            self.conn().execute(
                "INSERT INTO issue_full (site, key, data, fetched_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (site, key) DO UPDATE SET data = ?3, fetched_at = ?4",
                rusqlite::params![full.site, full.key, data, crate::db::ts(now)],
            )?;
            self.conn().execute(
                "DELETE FROM issue_full WHERE fetched_at < ?1",
                [crate::db::ts(now - chrono::Duration::days(KEEP_FULL_DAYS))],
            )?;
            self.issue_put(&full.site, &full.brief(), now)
        })
    }

    /// The last copy of `key` read in full (of `site`, or of any site).
    pub fn issue_full_get(&self, site: Option<&str>, key: &str) -> Result<Option<CachedFull>> {
        use rusqlite::OptionalExtension;
        let row: Option<(String, String)> = self
            .conn()
            .query_row(
                "SELECT data, fetched_at FROM issue_full WHERE key = ?1 AND (?2 IS NULL OR site = ?2) ORDER BY fetched_at DESC LIMIT 1",
                rusqlite::params![key, site],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((data, at)) = row else { return Ok(None) };
        // A copy an older version wrote that does not read any more counts as none.
        let Ok(issue) = serde_json::from_str::<IssueFull>(&data) else { return Ok(None) };
        Ok(Some(CachedFull { issue, fetched_at: crate::db::parse_ts(&at)? }))
    }
}
