//! Jira as an [`IssueProvider`]: Jira Cloud (REST v3, e-mail and API token as Basic auth,
//! descriptions in the Atlassian Document Format) and Jira Server/Data Center (REST v2,
//! personal access token as Bearer, wiki markup). Sprints come from the Agile REST API where it
//! exists (both flavors); without it a sprint is simply `None`.
//!
//! Searches page through the results (Cloud: `nextPageToken` of `/search/jql`, Server: `startAt`).
//! A 429 or 503 is retried after `Retry-After` (or 1, 2, 4 s), at most three times. Errors are
//! worded for the user in both languages: token refused (401), no permission (403), a Server
//! account locked behind a CAPTCHA, not found (404), offline.

use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, NaiveDate, Utc};
use reqwest::{Method, StatusCode};
use serde_json::{Value, json};

use super::{
    Account, Issue, IssueComment, IssueProvider, MAX_COMMENTS, MAX_DESCRIPTION, NewIssue, RemoteProject, RemoteWorklog,
    SiteKind, Sprint, WorkLog, normalize_url, worklog_seconds,
};
use crate::error::{Error, Result};
use crate::{tr, trf};

/// Fields asked for in searches (the sprint field is added once known).
pub const FIELDS: &str =
    "summary,status,priority,assignee,reporter,issuetype,project,duedate,updated,resolutiondate,description,comment";
/// Issues per page of a search.
const PAGE: usize = 100;
/// Retries of a rate-limited request.
const RETRIES: u32 = 3;

pub struct JiraClient {
    site: String,
    base: String,
    kind: SiteKind,
    /// The `Authorization` header.
    auth: String,
    http: reqwest::Client,
    timeout: Duration,
    /// Base of the backoff (1 s; tests shorten it).
    pub backoff: Duration,
    /// The id of the sprint field (`customfield_…`), once asked; `Some(None)` = there is none.
    sprint_field: Mutex<Option<Option<String>>>,
}

/// The `Authorization` header of a site: Cloud `Basic base64(email:token)`, Server `Bearer token`.
pub fn auth_header(kind: SiteKind, email: &str, token: &str) -> String {
    match kind {
        SiteKind::Cloud => {
            format!(
                "Basic {}",
                base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", email.trim(), token.trim()))
            )
        }
        SiteKind::Server => format!("Bearer {}", token.trim()),
    }
}

/// `{base}/rest/api/3/{path}` (Cloud) or `…/2/…` (Server).
pub fn api_url(base: &str, kind: SiteKind, path: &str) -> String {
    let v = match kind {
        SiteKind::Cloud => 3,
        SiteKind::Server => 2,
    };
    format!("{}/rest/api/{v}/{}", normalize_url(base), path.trim_start_matches('/'))
}

/// `{base}/rest/agile/1.0/{path}`.
pub fn agile_url(base: &str, path: &str) -> String {
    format!("{}/rest/agile/1.0/{}", normalize_url(base), path.trim_start_matches('/'))
}

/// The browser address of an issue.
pub fn browse_url(base: &str, key: &str) -> String {
    format!("{}/browse/{key}", normalize_url(base))
}

/// Where the next page of a search starts.
#[derive(Debug, Clone, PartialEq)]
pub enum PageAt {
    /// Server: `startAt`.
    Start(usize),
    /// Cloud: `nextPageToken` (`None` = first page).
    Token(Option<String>),
}

/// One page of a search: Cloud `GET /rest/api/3/search/jql`, Server `GET /rest/api/2/search`.
pub fn search_url(base: &str, kind: SiteKind, jql: &str, fields: &str, at: &PageAt, max: usize) -> String {
    let path = match kind {
        SiteKind::Cloud => "search/jql",
        SiteKind::Server => "search",
    };
    let mut url = reqwest::Url::parse(&api_url(base, kind, path))
        .unwrap_or_else(|_| reqwest::Url::parse("http://invalid/").unwrap());
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("jql", jql).append_pair("fields", fields).append_pair("maxResults", &max.to_string());
        match at {
            PageAt::Start(n) => {
                q.append_pair("startAt", &n.to_string());
            }
            PageAt::Token(Some(t)) => {
                q.append_pair("nextPageToken", t);
            }
            PageAt::Token(None) => {}
        }
    }
    url.to_string()
}

/// A JQL string literal.
pub fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `key in (A-1, B-2)`.
pub fn keys_jql(keys: &[&str]) -> String {
    let list: Vec<&str> = keys.iter().copied().filter(|k| super::is_key(k)).collect();
    format!("key in ({}) ORDER BY key", list.join(", "))
}

/// A full-text search.
pub fn text_jql(text: &str) -> String {
    format!("text ~ {} ORDER BY updated DESC", quote(text.trim()))
}

/// What the assistant (or a search box) typed as JQL: JQL stays, a key finds that issue, other
/// text is searched in the issues' texts.
pub fn search_jql(input: &str) -> String {
    let t = input.trim();
    if super::is_key(t) {
        return format!("key = {t}");
    }
    let lower = format!(" {} ", t.to_lowercase());
    let jql =
        ["=", "~", " in (", " order by ", " and ", " or ", " is ", "currentuser()"].iter().any(|m| lower.contains(m));
    if jql { t.to_owned() } else { text_jql(t) }
}

/// Jira's timestamps (`2026-09-30T10:15:30.000+0200`) as RFC 3339 in UTC.
pub fn parse_time(s: &str) -> Option<String> {
    let t = s.trim();
    let parsed =
        DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f%z").or_else(|_| DateTime::parse_from_rfc3339(t)).ok()?;
    Some(parsed.with_timezone(&Utc).to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
}

/// An id Jira sends as text or as a number.
fn id_text(v: &Value) -> String {
    v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string())).unwrap_or_default()
}

/// The ids of `GET priority` in the instance's order (highest first).
pub fn parse_priorities(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().map(|p| id_text(&p["id"])).filter(|id| !id.is_empty()).collect()).unwrap_or_default()
}

/// The worklog `started` Jira wants: `2026-10-01T08:00:00.000+0000`.
pub fn worklog_started(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%S%.3f+0000").to_string()
}

/// Plain text of an Atlassian Document Format value (Cloud descriptions and comments).
pub fn adf_to_text(v: &Value) -> String {
    fn walk(v: &Value, out: &mut String, list: &mut Vec<Option<usize>>) {
        let kind = v["type"].as_str().unwrap_or("");
        match kind {
            "text" => out.push_str(v["text"].as_str().unwrap_or("")),
            "hardBreak" => out.push('\n'),
            "mention" | "emoji" | "status" | "date" => {
                let a = &v["attrs"];
                let s = a["text"].as_str().or(a["shortName"].as_str()).unwrap_or("");
                out.push_str(s);
            }
            "inlineCard" | "blockCard" => out.push_str(v["attrs"]["url"].as_str().unwrap_or("")),
            "rule" => out.push_str("\n---\n"),
            _ => {
                let is_list = matches!(kind, "bulletList" | "orderedList");
                if is_list {
                    list.push((kind == "orderedList").then_some(1));
                }
                if kind == "listItem" {
                    let depth = list.len().saturating_sub(1);
                    out.push_str(&"  ".repeat(depth));
                    match list.last_mut() {
                        Some(Some(n)) => {
                            out.push_str(&format!("{n}. "));
                            *n += 1;
                        }
                        _ => out.push_str("- "),
                    }
                }
                if let Some(children) = v["content"].as_array() {
                    for c in children {
                        walk(c, out, list);
                    }
                }
                if is_list {
                    list.pop();
                    if list.is_empty() && !out.ends_with("\n\n") {
                        out.push('\n');
                    }
                }
                match kind {
                    "paragraph" | "heading" | "codeBlock" | "blockquote" | "panel" | "tableRow" => {
                        if !out.ends_with('\n') {
                            out.push('\n');
                        }
                        if list.is_empty() {
                            out.push('\n');
                        }
                    }
                    "tableCell" | "tableHeader" => out.push_str(" | "),
                    _ => {}
                }
            }
        }
    }
    let mut out = String::new();
    walk(v, &mut out, &mut vec![]);
    tidy(&out)
}

/// Runs of blank lines become one; trimmed.
fn tidy(s: &str) -> String {
    let mut out = String::new();
    let mut blank = 0;
    for line in s.lines() {
        let l = line.trim_end();
        if l.trim().is_empty() {
            blank += 1;
            if blank > 1 {
                continue;
            }
        } else {
            blank = 0;
        }
        out.push_str(l);
        out.push('\n');
    }
    out.trim().to_owned()
}

/// Plain text of Jira wiki markup (Server descriptions): headings, macros, links and emphasis
/// marks are dropped, the words stay.
pub fn wiki_to_text(s: &str) -> String {
    let mut out = String::new();
    for line in s.lines() {
        let mut l = line.trim_end().to_owned();
        // `h1. Title`
        if l.len() > 3 && l.starts_with('h') && l.as_bytes()[1].is_ascii_digit() && l[2..].starts_with(". ") {
            l = l[4..].to_owned();
        }
        // `{code:java}`, `{noformat}`, `{quote}`, `{panel:title=x}`, `{color:red}`.
        let mut t = String::new();
        let mut rest = l.as_str();
        while let Some(i) = rest.find('{') {
            t.push_str(&rest[..i]);
            match rest[i..].find('}') {
                Some(j) if rest[i + 1..i + j].chars().all(|c| c.is_ascii_alphanumeric() || ":=#|".contains(c)) => {
                    rest = &rest[i + j + 1..];
                }
                _ => {
                    t.push('{');
                    rest = &rest[i + 1..];
                }
            }
        }
        t.push_str(rest);
        // `[text|url]` → text, `[url]` → url.
        let mut u = String::new();
        let mut rest = t.as_str();
        while let Some(i) = rest.find('[') {
            u.push_str(&rest[..i]);
            match rest[i..].find(']') {
                Some(j) => {
                    let inner = &rest[i + 1..i + j];
                    u.push_str(inner.split('|').next().unwrap_or(inner));
                    rest = &rest[i + j + 1..];
                }
                None => {
                    u.push_str(&rest[i..]);
                    rest = "";
                }
            }
        }
        u.push_str(rest);
        // `*bold*`, `_italic_` at word edges.
        let words: Vec<String> = u
            .split(' ')
            .map(|w| {
                let mut w = w.to_owned();
                for m in ['*', '_', '+', '-'] {
                    if w.len() > 2 && w.starts_with(m) && w.ends_with(m) {
                        w = w[1..w.len() - 1].to_owned();
                    }
                }
                w
            })
            .collect();
        out.push_str(&words.join(" "));
        out.push('\n');
    }
    tidy(&out)
}

/// A description or comment body: ADF (Cloud v3), wiki markup (Server v2) or nothing.
fn body_text(v: &Value) -> String {
    match v {
        Value::String(s) => wiki_to_text(s),
        Value::Object(_) => adf_to_text(v),
        _ => String::new(),
    }
}

/// The body of a text field for this flavor: ADF for Cloud, a string for Server.
pub fn body_value(kind: SiteKind, text: &str) -> Value {
    match kind {
        SiteKind::Server => Value::String(text.to_owned()),
        SiteKind::Cloud => {
            let paragraphs: Vec<Value> = text
                .split("\n\n")
                .filter(|p| !p.trim().is_empty())
                .map(|p| {
                    let mut content = vec![];
                    for (i, line) in p.lines().enumerate() {
                        if i > 0 {
                            content.push(json!({ "type": "hardBreak" }));
                        }
                        if !line.is_empty() {
                            content.push(json!({ "type": "text", "text": line }));
                        }
                    }
                    json!({ "type": "paragraph", "content": content })
                })
                .collect();
            json!({ "type": "doc", "version": 1, "content": paragraphs })
        }
    }
}

/// Name and state of the newest sprint in a sprint field: objects (Cloud, newer Servers) or the
/// `…Sprint@1a[id=1,state=ACTIVE,name=Sprint 4,…]` strings of older Servers. An active sprint wins.
pub fn parse_sprint(v: &Value) -> (String, String) {
    let list: Vec<(String, String)> = match v {
        Value::Array(a) => a
            .iter()
            .filter_map(|s| match s {
                Value::Object(o) => Some((
                    o.get("name").and_then(Value::as_str).unwrap_or("").to_owned(),
                    o.get("state").and_then(Value::as_str).unwrap_or("").to_lowercase(),
                )),
                Value::String(s) => {
                    let inner = s.split_once('[').map(|(_, r)| r.trim_end_matches(']')).unwrap_or(s);
                    let mut name = String::new();
                    let mut state = String::new();
                    // `name` may hold commas: it runs up to the next `,key=`.
                    let parts: Vec<&str> = inner.split(',').collect();
                    let mut i = 0;
                    while i < parts.len() {
                        if let Some((k, val)) = parts[i].split_once('=') {
                            let mut val = val.to_owned();
                            while i + 1 < parts.len() && !parts[i + 1].contains('=') {
                                i += 1;
                                val.push(',');
                                val.push_str(parts[i]);
                            }
                            match k.trim() {
                                "name" => name = val,
                                "state" => state = val.to_lowercase(),
                                _ => {}
                            }
                        }
                        i += 1;
                    }
                    Some((name, state))
                }
                _ => None,
            })
            .filter(|(n, _)| !n.is_empty() && n != "<null>")
            .collect(),
        _ => vec![],
    };
    list.iter().find(|(_, s)| s == "active").or(list.last()).cloned().unwrap_or_default()
}

/// An issue of a search or of `GET issue/{key}` (both flavors).
pub fn parse_issue(v: &Value, site: &str, base: &str, sprint_field: Option<&str>) -> Option<Issue> {
    let key = v["key"].as_str()?.to_owned();
    let f = &v["fields"];
    let name = |o: &Value| o["displayName"].as_str().or(o["name"].as_str()).unwrap_or("").to_owned();
    let mut comments: Vec<IssueComment> = f["comment"]["comments"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|c| IssueComment {
                    author: name(&c["author"]),
                    created: c["created"].as_str().and_then(parse_time).unwrap_or_default(),
                    body: body_text(&c["body"]),
                })
                .collect()
        })
        .unwrap_or_default();
    if comments.len() > MAX_COMMENTS {
        comments.drain(..comments.len() - MAX_COMMENTS);
    }
    let category = f["status"]["statusCategory"]["key"].as_str().unwrap_or("new");
    let category = if super::CATEGORIES.contains(&category) { category } else { "new" };
    let (sprint, sprint_state) = sprint_field.map(|id| parse_sprint(&f[id])).unwrap_or_default();
    let mut description = body_text(&f["description"]);
    if description.chars().count() > MAX_DESCRIPTION {
        description = description.chars().take(MAX_DESCRIPTION).collect::<String>() + "…";
    }
    Some(Issue {
        site: site.to_owned(),
        url: browse_url(base, &key),
        remote_id: v["id"].as_str().unwrap_or("").to_owned(),
        summary: f["summary"].as_str().unwrap_or("").to_owned(),
        status: f["status"]["name"].as_str().unwrap_or("").to_owned(),
        status_category: category.to_owned(),
        priority: f["priority"]["name"].as_str().unwrap_or("").to_owned(),
        priority_level: super::priority_level(
            f["priority"]["name"].as_str().unwrap_or(""),
            &id_text(&f["priority"]["id"]),
            f["priority"]["iconUrl"].as_str().unwrap_or(""),
        ),
        priority_id: id_text(&f["priority"]["id"]),
        assignee: name(&f["assignee"]),
        reporter: name(&f["reporter"]),
        issue_type: f["issuetype"]["name"].as_str().unwrap_or("").to_owned(),
        project_key: f["project"]["key"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| super::project_of(&key).to_owned()),
        project_name: f["project"]["name"].as_str().unwrap_or("").to_owned(),
        sprint,
        sprint_state,
        due_date: f["duedate"].as_str().filter(|d| NaiveDate::parse_from_str(d, "%Y-%m-%d").is_ok()).map(str::to_owned),
        updated: f["updated"].as_str().and_then(parse_time),
        resolved: f["resolutiondate"].as_str().and_then(parse_time),
        description,
        comments,
        matches: vec![],
        key,
    })
}

/// One page of a search: the issues and where the next page starts (`None` = last page).
pub fn parse_search_page(
    v: &Value,
    kind: SiteKind,
    at: &PageAt,
    site: &str,
    base: &str,
    sprint_field: Option<&str>,
) -> (Vec<Issue>, Option<PageAt>) {
    let list: Vec<Issue> = v["issues"]
        .as_array()
        .map(|a| a.iter().filter_map(|i| parse_issue(i, site, base, sprint_field)).collect())
        .unwrap_or_default();
    let next = match (kind, at) {
        (SiteKind::Cloud, _) => match v["nextPageToken"].as_str() {
            Some(t) if !t.is_empty() && v["isLast"].as_bool() != Some(true) && !list.is_empty() => {
                Some(PageAt::Token(Some(t.to_owned())))
            }
            _ => None,
        },
        (SiteKind::Server, _) => {
            let start = if let PageAt::Start(s) = at { *s } else { 0 };
            let total = v["total"].as_u64().unwrap_or(0) as usize;
            let next = start + list.len();
            (!list.is_empty() && next < total).then_some(PageAt::Start(next))
        }
    };
    (list, next)
}

/// The id of the sprint field in `GET field`.
pub fn sprint_field_of(fields: &Value) -> Option<String> {
    fields.as_array()?.iter().find_map(|f| {
        let custom = f["schema"]["custom"].as_str().unwrap_or("");
        (custom == "com.pyxis.greenhopper.jira:gh-sprint").then(|| f["id"].as_str().map(str::to_owned)).flatten()
    })
}

/// The account of `GET myself`.
pub fn parse_account(v: &Value) -> Account {
    Account {
        display_name: v["displayName"].as_str().unwrap_or("").to_owned(),
        id: v["accountId"].as_str().or(v["name"].as_str()).or(v["key"].as_str()).unwrap_or("").to_owned(),
        email: v["emailAddress"].as_str().unwrap_or("").to_owned(),
    }
}

/// The worklogs of `GET issue/{key}/worklog`.
pub fn parse_worklogs(v: &Value) -> Vec<RemoteWorklog> {
    v["worklogs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|w| {
                    let started = w["started"].as_str().and_then(parse_time)?;
                    Some(RemoteWorklog {
                        id: w["id"].as_str().map(str::to_owned).or_else(|| w["id"].as_i64().map(|n| n.to_string()))?,
                        started: DateTime::parse_from_rfc3339(&started).ok()?.with_timezone(&Utc),
                        seconds: w["timeSpentSeconds"].as_i64().unwrap_or(0),
                        author: w["author"]["accountId"]
                            .as_str()
                            .or(w["author"]["name"].as_str())
                            .unwrap_or("")
                            .to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The first message of Jira's error body (`errorMessages`, then `errors`).
fn jira_message(body: &str) -> Option<String> {
    let v: Value = serde_json::from_str(body).ok()?;
    if let Some(m) = v["errorMessages"].as_array().and_then(|a| a.iter().find_map(Value::as_str)) {
        return Some(m.to_owned());
    }
    v["errors"].as_object().and_then(|o| o.iter().next().map(|(k, m)| format!("{k}: {}", m.as_str().unwrap_or(""))))
}

/// The user's message for a failed request.
pub fn status_error(status: u16, denied_reason: Option<&str>, body: &str) -> Error {
    let detail = jira_message(body).map(|m| format!(" ({m})")).unwrap_or_default();
    let msg = if denied_reason.is_some_and(|r| r.to_ascii_uppercase().contains("CAPTCHA")) {
        tr!(
            "Jira hat das Konto nach mehreren Fehlversuchen gesperrt (CAPTCHA). Einmal im Browser bei Jira anmelden und das CAPTCHA lösen, dann erneut versuchen.",
            "Jira locked the account after failed logins (CAPTCHA). Log in to Jira once in the browser and solve the CAPTCHA, then try again."
        )
        .to_owned()
    } else {
        match status {
            401 => tr!(
                "Jira hat die Anmeldung abgelehnt (401). E-Mail-Adresse und API-Token (Cloud) bzw. das persönliche Zugriffstoken (Server) prüfen.",
                "Jira refused the login (401). Check the e-mail address and API token (Cloud) or the personal access token (Server)."
            )
            .to_owned(),
            403 => trf!(
                "Keine Berechtigung in Jira (403){detail}. Das Konto darf das nicht sehen oder ändern.",
                "No permission in Jira (403){detail}. The account may not see or change this."
            ),
            404 => trf!(
                "Nicht gefunden (404){detail}. Adresse der Jira-Site und Schlüssel prüfen.",
                "Not found (404){detail}. Check the Jira site address and the key."
            ),
            400 => trf!("Jira hat die Anfrage abgelehnt (400){detail}.", "Jira rejected the request (400){detail}."),
            429 => tr!(
                "Jira begrenzt gerade die Anfragen (429). Später erneut versuchen.",
                "Jira is limiting requests right now (429). Try again later."
            )
            .to_owned(),
            s => trf!("Jira antwortet mit Fehler {s}{detail}.", "Jira answered with error {s}{detail}."),
        }
    };
    Error::Provider { status, body: msg }
}

/// The user's message when Jira cannot be reached.
pub fn network_error(e: &reqwest::Error) -> Error {
    if e.is_timeout() {
        Error::State(
            tr!(
                "Jira antwortet nicht (Zeitüberschreitung). Netzwerk oder Proxy prüfen.",
                "Jira does not answer (timeout). Check the network or proxy."
            )
            .into(),
        )
    } else if e.is_connect() || e.is_request() {
        Error::State(
            tr!(
                "Jira ist nicht erreichbar – offline oder falsche Adresse? Die zuletzt geladenen Issues bleiben sichtbar.",
                "Jira cannot be reached – offline or wrong address? The issues loaded last stay visible."
            )
            .into(),
        )
    } else {
        Error::State(trf!("Verbindung zu Jira fehlgeschlagen: {e}", "Connection to Jira failed: {e}"))
    }
}

/// How long to wait before retry `attempt` (0-based) of a rate-limited request.
pub fn retry_after(header: Option<&str>, attempt: u32, base: Duration) -> Duration {
    header
        .and_then(|h| h.trim().parse::<u64>().ok())
        .map(|s| Duration::from_secs(s.min(60)))
        .unwrap_or_else(|| base * 2u32.pow(attempt))
}

impl JiraClient {
    pub fn new(
        site: &str,
        base: &str,
        kind: SiteKind,
        email: &str,
        token: &str,
        http: reqwest::Client,
        timeout: Duration,
    ) -> Self {
        JiraClient {
            site: site.to_owned(),
            base: normalize_url(base),
            kind,
            auth: auth_header(kind, email, token),
            http,
            timeout,
            backoff: Duration::from_secs(1),
            sprint_field: Mutex::new(None),
        }
    }

    pub fn kind(&self) -> SiteKind {
        self.kind
    }

    /// Sends a request; retries 429 and 503; turns error answers into readable errors.
    async fn send(&self, method: Method, url: &str, body: Option<&Value>) -> Result<Value> {
        let mut attempt = 0;
        loop {
            let mut req = self
                .http
                .request(method.clone(), url)
                .header(reqwest::header::AUTHORIZATION, &self.auth)
                .header(reqwest::header::ACCEPT, "application/json")
                .header("X-Atlassian-Token", "no-check")
                .timeout(self.timeout);
            if let Some(b) = body {
                req = req.json(b);
            }
            let resp = req.send().await.map_err(|e| network_error(&e))?;
            let status = resp.status();
            if (status == StatusCode::TOO_MANY_REQUESTS || status == StatusCode::SERVICE_UNAVAILABLE)
                && attempt < RETRIES
            {
                let wait =
                    retry_after(resp.headers().get("retry-after").and_then(|h| h.to_str().ok()), attempt, self.backoff);
                tokio::time::sleep(wait).await;
                attempt += 1;
                continue;
            }
            let denied =
                resp.headers().get("x-authentication-denied-reason").and_then(|h| h.to_str().ok()).map(str::to_owned);
            let text = resp.text().await.map_err(|e| network_error(&e))?;
            if !status.is_success() {
                return Err(status_error(status.as_u16(), denied.as_deref(), &text));
            }
            // A login page instead of JSON: a proxy or SSO in between.
            if text.trim_start().starts_with('<') {
                return Err(Error::State(
                    tr!(
                        "Jira hat eine Webseite statt Daten geliefert – Adresse prüfen (Anmeldeseite oder Proxy dazwischen?).",
                        "Jira sent a web page instead of data – check the address (login page or proxy in between?)."
                    )
                    .into(),
                ));
            }
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|e| {
                Error::Parse(trf!("Unerwartete Antwort von Jira: {e}", "Unexpected answer from Jira: {e}"))
            });
        }
    }

    async fn get_json(&self, url: &str) -> Result<Value> {
        self.send(Method::GET, url, None).await
    }

    /// The server's own word on its kind (`GET serverInfo`): `Cloud`, `Server` or `DataCenter`.
    pub async fn detect_kind(&self) -> Result<SiteKind> {
        let v = self.get_json(&api_url(&self.base, SiteKind::Server, "serverInfo")).await?;
        Ok(match v["deploymentType"].as_str() {
            Some(d) if d.eq_ignore_ascii_case("cloud") => SiteKind::Cloud,
            _ => SiteKind::Server,
        })
    }

    /// The sprint field id, asked once per client.
    async fn sprint_field(&self) -> Option<String> {
        if let Some(known) = self.sprint_field.lock().unwrap_or_else(|e| e.into_inner()).clone() {
            return known;
        }
        let found = match self.get_json(&api_url(&self.base, self.kind, "field")).await {
            Ok(v) => sprint_field_of(&v),
            Err(_) => None,
        };
        *self.sprint_field.lock().unwrap_or_else(|e| e.into_inner()) = Some(found.clone());
        found
    }

    async fn fields(&self) -> (String, Option<String>) {
        let sprint = self.sprint_field().await;
        let fields = match &sprint {
            Some(id) => format!("{FIELDS},{id}"),
            None => FIELDS.to_owned(),
        };
        (fields, sprint)
    }

    async fn issue_types(&self, project: &str) -> Result<Vec<String>> {
        let v = self.get_json(&api_url(&self.base, self.kind, &format!("project/{project}"))).await?;
        Ok(v["issueTypes"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|t| t["subtask"].as_bool() != Some(true))
                    .filter_map(|t| t["name"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The types an issue of `project` can have (no sub-tasks).
    pub async fn project_types(&self, project: &str) -> Result<Vec<String>> {
        self.issue_types(project).await
    }

    /// The priority ids of the instance, highest first (custom priorities get their level by
    /// this order).
    pub async fn priority_order(&self) -> Result<Vec<String>> {
        Ok(parse_priorities(&self.get_json(&api_url(&self.base, self.kind, "priority")).await?))
    }
}

impl IssueProvider for JiraClient {
    fn site(&self) -> &str {
        &self.site
    }

    async fn whoami(&self) -> Result<Account> {
        let v = self.get_json(&api_url(&self.base, self.kind, "myself")).await?;
        Ok(parse_account(&v))
    }

    async fn search(&self, query: &str, limit: usize) -> Result<Vec<Issue>> {
        let (fields, sprint) = self.fields().await;
        let mut at = match self.kind {
            SiteKind::Cloud => PageAt::Token(None),
            SiteKind::Server => PageAt::Start(0),
        };
        let mut out = vec![];
        loop {
            let max = PAGE.min(limit.saturating_sub(out.len())).max(1);
            let url = search_url(&self.base, self.kind, query, &fields, &at, max);
            let v = self.get_json(&url).await?;
            let (list, next) = parse_search_page(&v, self.kind, &at, &self.site, &self.base, sprint.as_deref());
            out.extend(list);
            match next {
                Some(n) if out.len() < limit => at = n,
                _ => break,
            }
        }
        out.truncate(limit);
        Ok(out)
    }

    async fn get(&self, key: &str) -> Result<Issue> {
        if !super::is_key(key) {
            return Err(Error::State(trf!("„{key}“ ist kein Issue-Schlüssel", "“{key}” is not an issue key")));
        }
        let (fields, sprint) = self.fields().await;
        let mut url = reqwest::Url::parse(&api_url(&self.base, self.kind, &format!("issue/{key}")))
            .map_err(|e| Error::State(e.to_string()))?;
        url.query_pairs_mut().append_pair("fields", &fields);
        let v = self.get_json(url.as_str()).await?;
        parse_issue(&v, &self.site, &self.base, sprint.as_deref()).ok_or_else(|| Error::not_found("issue", key))
    }

    async fn projects(&self) -> Result<Vec<RemoteProject>> {
        let v = match self.kind {
            SiteKind::Cloud => {
                self.get_json(&api_url(&self.base, self.kind, "project/search?maxResults=100")).await?["values"].clone()
            }
            SiteKind::Server => self.get_json(&api_url(&self.base, self.kind, "project")).await?,
        };
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| {
                        Some(RemoteProject {
                            key: p["key"].as_str()?.to_owned(),
                            name: p["name"].as_str().unwrap_or("").to_owned(),
                            issue_types: vec![],
                        })
                    })
                    .collect()
            })
            .unwrap_or_default())
    }

    async fn create(&self, new: &NewIssue) -> Result<String> {
        let mut fields = json!({
            "project": { "key": new.project },
            "issuetype": { "name": new.issue_type },
            "summary": new.summary.chars().take(250).collect::<String>(),
        });
        if !new.description.trim().is_empty() {
            fields["description"] = body_value(self.kind, &new.description);
        }
        let v = self
            .send(Method::POST, &api_url(&self.base, self.kind, "issue"), Some(&json!({ "fields": fields })))
            .await?;
        v["key"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| Error::Parse(tr!("Jira hat keinen Schlüssel zurückgegeben", "Jira returned no key").into()))
    }

    async fn comment(&self, key: &str, body: &str) -> Result<()> {
        let url = api_url(&self.base, self.kind, &format!("issue/{key}/comment"));
        self.send(Method::POST, &url, Some(&json!({ "body": body_value(self.kind, body) }))).await?;
        Ok(())
    }

    async fn transition(&self, key: &str, to: &str) -> Result<String> {
        let url = api_url(&self.base, self.kind, &format!("issue/{key}/transitions"));
        let v = self.get_json(&url).await?;
        let want = to.trim().to_lowercase();
        let list = v["transitions"].as_array().cloned().unwrap_or_default();
        let found = list.iter().find(|t| {
            t["name"].as_str().is_some_and(|n| n.to_lowercase() == want)
                || t["to"]["name"].as_str().is_some_and(|n| n.to_lowercase() == want)
        });
        let Some(t) = found else {
            let names: Vec<&str> =
                list.iter().filter_map(|t| t["to"]["name"].as_str().or(t["name"].as_str())).collect();
            return Err(Error::State(trf!(
                "{key} kann nicht nach „{to}“ wechseln (möglich: {})",
                "{key} cannot move to “{to}” (possible: {})",
                names.join(", ")
            )));
        };
        let id =
            t["id"].as_str().map(str::to_owned).or_else(|| t["id"].as_i64().map(|n| n.to_string())).unwrap_or_default();
        self.send(Method::POST, &url, Some(&json!({ "transition": { "id": id } }))).await?;
        Ok(t["to"]["name"].as_str().or(t["name"].as_str()).unwrap_or(to).to_owned())
    }

    async fn log_work(&self, work: &WorkLog) -> Result<String> {
        let url = api_url(&self.base, self.kind, &format!("issue/{}/worklog", work.key));
        let mut body =
            json!({ "started": worklog_started(work.started), "timeSpentSeconds": worklog_seconds(work.minutes) });
        if !work.comment.trim().is_empty() {
            body["comment"] = body_value(self.kind, &work.comment);
        }
        let v = self.send(Method::POST, &url, Some(&body)).await?;
        v["id"].as_str().map(str::to_owned).or_else(|| v["id"].as_i64().map(|n| n.to_string())).ok_or_else(|| {
            Error::Parse(tr!("Jira hat keine Worklog-ID zurückgegeben", "Jira returned no worklog id").into())
        })
    }

    async fn worklogs(&self, key: &str) -> Result<Vec<RemoteWorklog>> {
        let v = self.get_json(&api_url(&self.base, self.kind, &format!("issue/{key}/worklog"))).await?;
        Ok(parse_worklogs(&v))
    }

    async fn update_work(&self, id: &str, work: &WorkLog) -> Result<()> {
        let url = api_url(&self.base, self.kind, &format!("issue/{}/worklog/{id}", work.key));
        let mut body =
            json!({ "started": worklog_started(work.started), "timeSpentSeconds": worklog_seconds(work.minutes) });
        body["comment"] = body_value(self.kind, work.comment.trim());
        self.send(Method::PUT, &url, Some(&body)).await?;
        Ok(())
    }

    async fn delete_work(&self, key: &str, id: &str) -> Result<()> {
        let url = api_url(&self.base, self.kind, &format!("issue/{key}/worklog/{id}"));
        match self.send(Method::DELETE, &url, None).await {
            Err(Error::Provider { status: 404, .. }) => Ok(()),
            other => other.map(|_| ()),
        }
    }

    async fn sprint(&self, project: &str) -> Result<Option<Sprint>> {
        let boards = match self.get_json(&agile_url(&self.base, &format!("board?projectKeyOrId={project}"))).await {
            Ok(v) => v,
            // No Agile here (or no permission for it): no sprint.
            Err(Error::Provider { status: 404 | 403, .. }) => return Ok(None),
            Err(e) => return Err(e),
        };
        let (fields, sprint_field) = self.fields().await;
        for b in boards["values"].as_array().into_iter().flatten().filter(|b| b["type"].as_str() != Some("kanban")) {
            let Some(id) = b["id"].as_i64() else { continue };
            let sprints = match self.get_json(&agile_url(&self.base, &format!("board/{id}/sprint?state=active"))).await
            {
                Ok(v) => v,
                Err(Error::Provider { status: 400 | 404, .. }) => continue,
                Err(e) => return Err(e),
            };
            let Some(s) = sprints["values"].as_array().and_then(|a| a.first()).cloned() else { continue };
            let sid = s["id"].as_i64().unwrap_or_default();
            let mut url = reqwest::Url::parse(&agile_url(&self.base, &format!("sprint/{sid}/issue")))
                .map_err(|e| Error::State(e.to_string()))?;
            url.query_pairs_mut().append_pair("fields", &fields).append_pair("maxResults", "200");
            let v = self.get_json(url.as_str()).await?;
            let issues = v["issues"]
                .as_array()
                .map(|a| {
                    a.iter().filter_map(|i| parse_issue(i, &self.site, &self.base, sprint_field.as_deref())).collect()
                })
                .unwrap_or_default();
            return Ok(Some(Sprint {
                id: sid,
                name: s["name"].as_str().unwrap_or("").to_owned(),
                goal: s["goal"].as_str().unwrap_or("").to_owned(),
                board: b["name"].as_str().unwrap_or("").to_owned(),
                start: s["startDate"].as_str().and_then(parse_time),
                end: s["endDate"].as_str().and_then(parse_time),
                issues,
            }));
        }
        Ok(None)
    }
}
