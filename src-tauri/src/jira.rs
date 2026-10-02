//! Settings → Jira, the Issues page, issue chips and notes, the Sprint widget, the optional
//! worklogs and the assistant's Jira tools. The logic lives in `annalo_core::issues`.
//!
//! Tokens live in the credential store (`jira-<site id>`), never in the settings. Requests use the
//! HTTP client of the assistant's tools, so the proxy, extra CA and timeouts of Settings →
//! Netzwerk apply. A sync reads Jira without any database lock and then stores the result in one
//! short transaction; everything shown afterwards reads the cache (offline as well).

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use annalo_core::issues::jira::{self as core_jira, JiraClient};
use annalo_core::issues::{
    self as issues, BurnPoint, EntryIssue, Issue, IssueBacklink, IssueFilter, IssueProvider, IssueSettings, JiraSite,
    NewIssue, RemoteProject, SiteKind, SiteSync, Sprint, WbsMapping,
};
use annalo_core::model::{Page, TimeEntry};
use annalo_core::{Error, tr, trf};
use chrono::{DateTime, Local, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::secrets::SecretStore;
use crate::{AppState, Result, devlog, lock};

/// Sites being synced right now, whether the worklog runner is busy.
#[derive(Default)]
pub struct JiraSync {
    running: Mutex<HashSet<String>>,
    worklogs: AtomicBool,
    /// A booking arrived while the runner was busy: it runs once more.
    again: AtomicBool,
    /// Woken whenever a site sync ends (callers waiting for their turn).
    done: tokio::sync::Notify,
}

fn secret(state: &AppState, id: &str) -> SecretStore {
    SecretStore::jira(&state.data_dir, id)
}

fn token_missing(name: &str) -> Error {
    Error::State(trf!(
        "Für die Jira-Site „{name}“ ist kein Token gespeichert (Einstellungen → Jira)",
        "No token is stored for the Jira site “{name}” (Settings → Jira)"
    ))
}

/// A client for `site` with `token` (else the stored one), through the network settings.
fn client_with(state: &AppState, site: &JiraSite, token: Option<&str>, kind: SiteKind) -> Result<JiraClient> {
    if site.url.trim().is_empty() {
        return Err(Error::State(
            tr!("Die Adresse der Jira-Site fehlt", "The address of the Jira site is missing").into(),
        ));
    }
    let token = match token.map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) => t.to_owned(),
        None => secret(state, &site.id).get().ok_or_else(|| token_missing(&site.name))?,
    };
    if kind == SiteKind::Cloud && site.email.trim().is_empty() {
        return Err(Error::State(
            tr!(
                "Für Jira Cloud wird die E-Mail-Adresse des Kontos gebraucht",
                "Jira Cloud needs the e-mail address of the account"
            )
            .into(),
        ));
    }
    let (http, network_error, timeout) = {
        let ai = state.ai.read().unwrap_or_else(|e| e.into_inner());
        (ai.tools_http.clone(), ai.network_error.clone(), ai.settings.network.timeout())
    };
    let http = http.ok_or_else(|| {
        Error::State(network_error.unwrap_or_else(|| tr!("Kein Netzwerk-Client", "No network client").into()))
    })?;
    Ok(JiraClient::new(&site.id, &site.url, kind, &site.email, &token, http, timeout))
}

fn client(state: &AppState, site: &JiraSite) -> Result<JiraClient> {
    client_with(state, site, None, site.kind)
}

fn site_of(state: &AppState, id: &str) -> Result<JiraSite> {
    state.settings().jira.site(id).cloned().ok_or_else(|| Error::not_found("jira site", id))
}

/// The site an issue key belongs to: the cached issue's, else the site with its project, else
/// the first active site.
fn site_for_key(state: &AppState, key: &str) -> Result<JiraSite> {
    let settings = state.settings().jira;
    let cached = state.reader().issue_get(key)?.map(|i| i.site);
    let by_project = || {
        state
            .reader()
            .issue_projects()
            .ok()?
            .into_iter()
            .find(|(_, k, _)| k == issues::project_of(key))
            .map(|(s, _, _)| s)
    };
    let id = cached.or_else(by_project);
    id.and_then(|id| settings.site(&id).cloned()).or_else(|| settings.active().next().cloned()).ok_or_else(|| {
        Error::State(
            tr!("Keine Jira-Site eingerichtet (Einstellungen → Jira)", "No Jira site set up (Settings → Jira)").into(),
        )
    })
}

// ------------------------------------------------------------------ settings

#[derive(Serialize)]
pub struct SiteInfo {
    #[serde(flatten)]
    site: JiraSite,
    token_set: bool,
    sync: Option<SiteSync>,
    syncing: bool,
}

#[derive(Serialize)]
pub struct JiraStatus {
    sites: Vec<SiteInfo>,
    /// Where tokens are stored.
    secret_storage: &'static str,
    mappings: Vec<WbsMapping>,
    /// Cached projects (`site`, `key`, `name`).
    projects: Vec<(String, String, String)>,
}

fn status_of(app: &AppHandle) -> Result<JiraStatus> {
    let state = app.state::<AppState>();
    let settings = state.settings().jira;
    let db = state.reader();
    let syncs = db.issue_sync_status()?;
    let running = lock(&app.state::<JiraSync>().running).clone();
    let sites = settings
        .sites
        .iter()
        .map(|s| SiteInfo {
            token_set: secret(&state, &s.id).get().is_some(),
            sync: syncs.iter().find(|x| x.site == s.id).cloned(),
            syncing: running.contains(&s.id),
            site: s.clone(),
        })
        .collect();
    Ok(JiraStatus {
        sites,
        secret_storage: state.secrets.backend(),
        mappings: db.issue_wbs_list()?,
        projects: db.issue_projects()?,
    })
}

#[tauri::command(async)]
pub fn jira_status(app: AppHandle) -> Result<JiraStatus> {
    status_of(&app)
}

/// Saves only the Jira settings, changed by `f`.
fn save_jira(app: &AppHandle, f: impl FnOnce(&mut IssueSettings) -> Result<()>) -> Result<()> {
    let state = app.state::<AppState>();
    let mut settings = state.settings();
    f(&mut settings.jira)?;
    settings.jira = std::mem::take(&mut settings.jira).normalized();
    state.db().save_settings(&settings)?;
    state.ai.write().unwrap_or_else(|e| e.into_inner()).settings = settings;
    let _ = app.emit("settings://changed", ());
    Ok(())
}

/// Adds (empty id) or changes a site; a given token goes to the credential store. Syncs it.
#[tauri::command(async)]
pub fn jira_site_save(app: AppHandle, site: JiraSite, token: Option<String>) -> Result<JiraStatus> {
    let state = app.state::<AppState>();
    let current = state.settings().jira;
    let id = if site.id.is_empty() || current.site(&site.id).is_none() {
        if current.sites.len() >= issues::MAX_SITES {
            return Err(Error::State(trf!("Höchstens {} Jira-Sites", "At most {} Jira sites", issues::MAX_SITES)));
        }
        current.new_site_id(&site.name)
    } else {
        site.id.clone()
    };
    if let Some(t) = token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        devlog::remember_secret(Some(t));
        secret(&state, &id).set(Some(t)).map_err(Error::State)?;
    }
    let enabled = site.enabled;
    let log_work = site.log_work;
    save_jira(&app, |j| {
        let mut s = site;
        s.id = id.clone();
        if s.color.is_empty() {
            s.color = issues::PALETTE[j.sites.len() % issues::PALETTE.len()].into();
        }
        match j.sites.iter_mut().find(|x| x.id == id) {
            Some(x) => *x = s,
            None => j.sites.push(s),
        }
        Ok(())
    })?;
    if !log_work {
        state.db().worklogs_cancel_site(&id)?;
    }
    if enabled {
        spawn_sync(app.clone(), vec![id]);
    }
    status_of(&app)
}

/// Removes a site with its token, saved queries and cached issues.
#[tauri::command(async)]
pub fn jira_site_remove(app: AppHandle, id: String) -> Result<JiraStatus> {
    let state = app.state::<AppState>();
    save_jira(&app, |j| {
        j.sites.retain(|s| s.id != id);
        Ok(())
    })?;
    if let Err(e) = secret(&state, &id).set(None) {
        devlog::warn("jira", format!("token of the removed site not deleted: {e}"));
    }
    state.db().issues_remove_site(&id)?;
    let _ = app.emit("jira://synced", &id);
    status_of(&app)
}

#[derive(Serialize)]
pub struct TestResult {
    display_name: String,
    email: String,
    /// What the server says it is (`None` when it would not tell).
    detected: Option<SiteKind>,
    /// The kind the test logged in with.
    kind: SiteKind,
}

/// „Verbindung testen“: logs in with the given (or stored) token and names the account. The
/// server's own `serverInfo` decides Cloud or Server when it answers.
#[tauri::command]
pub async fn jira_test(app: AppHandle, site: JiraSite, token: Option<String>) -> Result<TestResult> {
    let state = app.state::<AppState>();
    let mut site = site;
    site.url = issues::normalize_url(&site.url);
    let probe = client_with(&state, &site, token.as_deref(), SiteKind::Server);
    let detected = match probe {
        Ok(c) => c.detect_kind().await.ok(),
        Err(_) => None,
    };
    let kind = detected.unwrap_or(site.kind);
    let c = client_with(&state, &site, token.as_deref(), kind)?;
    let me = c.whoami().await?;
    devlog::debug("jira", format!("{}: connection test as {}", site.url, me.display_name));
    Ok(TestResult { display_name: me.display_name, email: me.email, detected, kind })
}

/// Sets (or with an empty reference, removes) the WBS of an issue or project.
#[tauri::command(async)]
pub fn jira_wbs_set(app: AppHandle, kind: String, key: String, reference: String) -> Result<JiraStatus> {
    app.state::<AppState>().db().issue_wbs_set(&kind, &key, &reference, false)?;
    status_of(&app)
}

// ------------------------------------------------------------------ sync

fn start(app: &AppHandle, id: &str) -> bool {
    let fresh = lock(&app.state::<JiraSync>().running).insert(id.to_owned());
    if fresh {
        let _ = app.emit("jira://syncing", id);
    }
    fresh
}

fn finish(app: &AppHandle, id: &str) {
    let sync = app.state::<JiraSync>();
    lock(&sync.running).remove(id);
    sync.done.notify_waiters();
    let _ = app.emit("jira://synced", id);
}

/// Syncs one site: its searches, stored in one transaction; done issues tick their tasks.
/// A sync of the site already running: with `wait` this one follows it (the settings may have
/// changed since it started, e.g. right after saving the site), otherwise it is refused.
async fn sync_site(app: &AppHandle, id: &str, wait: bool) -> Result<usize> {
    loop {
        let sync = app.state::<JiraSync>();
        let mut done = std::pin::pin!(sync.done.notified());
        done.as_mut().enable();
        if start(app, id) {
            break;
        }
        if !wait {
            return Err(Error::State(
                tr!("Diese Jira-Site wird gerade synchronisiert", "This Jira site is syncing right now").into(),
            ));
        }
        done.await;
    }
    let outcome = sync_inner(app, id).await;
    let state = app.state::<AppState>();
    let now = Utc::now();
    match &outcome {
        Ok((n, account)) => {
            let _ = state.db().issue_sync_record(id, now, Ok((*n, account)));
            devlog::debug("jira", format!("{id}: {n} issues"));
        }
        Err(e) => {
            let msg = devlog::redact(&e.to_string());
            devlog::warn("jira", format!("{id}: {msg}"));
            let _ = state.db().issue_sync_record(id, now, Err(&msg));
        }
    }
    finish(app, id);
    outcome.map(|(n, _)| n)
}

async fn sync_inner(app: &AppHandle, id: &str) -> Result<(usize, String)> {
    let state = app.state::<AppState>();
    let settings = state.settings().jira;
    let site = settings.site(id).cloned().ok_or_else(|| Error::not_found("jira site", id))?;
    let c = client(&state, &site)?;
    let account = c.whoami().await?;
    let stale = state.reader().issues_open_keys(id)?;
    let mut fetched = issues::fetch_site(&c, &settings.searches(id), &stale).await?;
    // Custom priorities (no known name, icon or default id): their place in the site's order.
    if issues::needs_priority_order(&fetched)
        && let Ok(order) = c.priority_order().await
    {
        issues::apply_priority_order(&mut fetched, &issues::levels_by_order(&order));
    }
    for (q, e) in &fetched.failed {
        devlog::warn("jira", format!("{id}: query {q}: {}", devlog::redact(e)));
    }
    let out = state.db().issues_store(id, &fetched, Utc::now())?;
    if settings.tick_done_tasks && !out.newly_done.is_empty() {
        let pages = state.db().issues_tick_tasks(&out.newly_done)?;
        for p in pages {
            let _ = app.emit("data://tasks", p);
        }
    }
    Ok((out.issues, account.display_name))
}

async fn sync_ids(app: &AppHandle, ids: &[String], wait: bool) -> Vec<(String, Result<usize>)> {
    let mut out = vec![];
    for id in ids {
        out.push((id.clone(), sync_site(app, id, wait).await));
    }
    out
}

pub fn spawn_sync(app: AppHandle, ids: Vec<String>) {
    tauri::async_runtime::spawn(async move {
        sync_ids(&app, &ids, true).await;
    });
}

/// Syncs `site` (or every active site) now and waits, after a sync already running for it;
/// one site asked for: its error is the answer.
#[tauri::command]
pub async fn jira_sync_now(app: AppHandle, site: Option<String>) -> Result<JiraStatus> {
    let settings = app.state::<AppState>().settings().jira;
    let ids: Vec<String> = match &site {
        Some(s) => vec![s.clone()],
        None => settings.active().map(|s| s.id.clone()).collect(),
    };
    let mut errors: Vec<String> =
        sync_ids(&app, &ids, true).await.into_iter().filter_map(|(_, r)| r.err().map(|e| e.to_string())).collect();
    let status = status_of(&app)?;
    if site.is_some() && !errors.is_empty() {
        return Err(Error::State(errors.remove(0)));
    }
    Ok(status)
}

/// How long after the start the first sync runs: 15 s, or `ANNALO_JIRA_DELAY_SECS` (tests).
fn startup_delay() -> Duration {
    Duration::from_secs(std::env::var("ANNALO_JIRA_DELAY_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(15))
}

/// Background sync (every site whose last attempt is older than the interval) and worklogs.
pub fn spawn_scheduler(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(startup_delay()).await;
        loop {
            let state = app.state::<AppState>();
            let settings = state.settings().jira;
            let interval = chrono::TimeDelta::minutes(settings.sync_minutes as i64);
            let statuses = state.reader().issue_sync_status().unwrap_or_default();
            let now = Utc::now();
            let due: Vec<String> = settings
                .active()
                .filter(|s| secret(&state, &s.id).get().is_some())
                .filter(|s| {
                    statuses
                        .iter()
                        .find(|x| x.site == s.id)
                        .and_then(|x| x.attempted_at)
                        .is_none_or(|t| now - t >= interval)
                })
                .map(|s| s.id.clone())
                .collect();
            if !due.is_empty() {
                sync_ids(&app, &due, false).await;
            }
            run_worklogs(&app).await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        }
    });
}

// ------------------------------------------------------------------ cache reads

#[tauri::command(async)]
pub fn jira_issues(state: State<AppState>, filter: Option<IssueFilter>) -> Result<Vec<Issue>> {
    state.reader().issues_list(&filter.unwrap_or_default())
}

/// What a chip shows of an issue.
#[derive(Serialize)]
pub struct ChipIssue {
    key: String,
    site: String,
    summary: String,
    status: String,
    status_category: String,
    issue_type: String,
    priority: String,
    assignee: String,
    due_date: Option<String>,
    url: String,
    description: String,
}

/// The keys that become chips: the cached projects and what each issue shows.
#[derive(Serialize)]
pub struct IssueIndex {
    projects: Vec<String>,
    issues: Vec<ChipIssue>,
}

#[tauri::command(async)]
pub fn jira_index(state: State<AppState>) -> Result<IssueIndex> {
    let db = state.reader();
    let mut projects: Vec<String> = db.issue_project_keys()?.into_iter().collect();
    projects.sort();
    let issues = db
        .issues_list(&IssueFilter { all: true, ..Default::default() })?
        .into_iter()
        .map(|i| ChipIssue {
            description: i.description.chars().take(400).collect(),
            key: i.key,
            site: i.site,
            summary: i.summary,
            status: i.status,
            status_category: i.status_category,
            issue_type: i.issue_type,
            priority: i.priority,
            assignee: i.assignee,
            due_date: i.due_date,
            url: i.url,
        })
        .collect();
    Ok(IssueIndex { projects, issues })
}

#[derive(Serialize)]
pub struct IssueView {
    issue: Option<Issue>,
    backlinks: Vec<IssueBacklink>,
    note_page_id: Option<i64>,
    /// The WBS bookings with this key go to.
    wbs: Option<String>,
    /// Minutes booked with this key.
    booked_minutes: i64,
}

/// An issue with the pages naming it (the note first) and its WBS.
#[tauri::command(async)]
pub fn jira_issue_view(state: State<AppState>, key: String) -> Result<IssueView> {
    let db = state.reader();
    let backlinks = db.issue_backlinks(&key)?;
    let booked_minutes: i64 = db.conn().query_row(
        "SELECT IFNULL(SUM(e.duration_minutes), 0) FROM time_entry_issues l JOIN time_entries e ON e.id = l.entry_id WHERE l.issue_key = ?1",
        [&key],
        |r| r.get(0),
    )?;
    Ok(IssueView {
        issue: db.issue_get(&key)?,
        note_page_id: backlinks.iter().find(|b| b.note).map(|b| b.page_id),
        backlinks,
        wbs: db.issue_wbs_for(&key)?,
        booked_minutes,
    })
}

/// Asks Jira for one issue now and caches it (the hover card of a key not cached yet).
#[tauri::command]
pub async fn jira_issue_fetch(app: AppHandle, key: String) -> Result<Issue> {
    let state = app.state::<AppState>();
    let site = site_for_key(&state, &key)?;
    let issue = client(&state, &site)?.get(&key).await?;
    state.db().issue_put(&site.id, &issue, Utc::now())?;
    let _ = app.emit("jira://synced", &site.id);
    Ok(issue)
}

#[derive(Serialize)]
pub struct IssueNote {
    page: Page,
    created: bool,
}

/// The note page of an issue: „PROJ-123 Summary“ with `jira: PROJ-123`, created on first use.
#[tauri::command(async)]
pub fn jira_issue_note(state: State<AppState>, key: String) -> Result<IssueNote> {
    if !issues::is_key(&key) {
        return Err(Error::State(trf!("„{key}“ ist kein Issue-Schlüssel", "“{key}” is not an issue key")));
    }
    let db = state.db();
    if let Some(id) = db.issue_note(&key)? {
        return Ok(IssueNote { page: db.page(id)?, created: false });
    }
    let summary = db.issue_get(&key)?.map(|i| i.summary).unwrap_or_default();
    let title = format!("{key} {summary}");
    let page = db.atomic(|| {
        let page = db.create_page(None, &crate::unique_title(&db, title.trim())?, Some("ticket"))?;
        db.save_page_content(page.id, &format!("---\njira: {key}\n---\n\n"))?;
        // Jira/ABC Projekt/ABC-12 Titel (Settings → Ordner & Ablage).
        let info = annalo_core::filing::FileInfo {
            kind: annalo_core::filing::FileType::Jira,
            date: chrono::Local::now().date_naive(),
            group: Some(db.jira_group(&key)?),
        };
        db.file_page(page.id, &info)?;
        db.page(page.id)
    })?;
    Ok(IssueNote { page, created: true })
}

#[derive(Serialize)]
pub struct AddedTask {
    page_id: i64,
    title: String,
}

/// „Als Aufgabe übernehmen“: `- [ ] PROJ-123 Summary` in today's daily note.
#[tauri::command(async)]
pub fn jira_add_task(app: AppHandle, state: State<AppState>, key: String) -> Result<AddedTask> {
    let settings = state.settings();
    let summary = state.reader().issue_get(&key)?.map(|i| i.summary).unwrap_or_default();
    let zone = annalo_core::calsync::tz::Zone::Local;
    let opts = annalo_core::capture::CaptureOptions {
        inbox_title: &settings.capture.inbox_title,
        thresholds: &settings.thresholds,
        zone: &zone,
        book_time: false,
    };
    let text = format!("- [ ] {key} {summary}");
    let (out, _) = annalo_core::capture::capture_to(
        &state.db(),
        text.trim_end(),
        &annalo_core::capture::CaptureTarget::Daily,
        &opts,
        Utc::now(),
        &Local,
    )?;
    let appended = out.appended.ok_or_else(|| Error::State("nothing appended".into()))?;
    let _ = app.emit("data://tasks", appended.page_id);
    Ok(AddedTask { page_id: appended.page_id, title: appended.title })
}

/// The issue keys and worklog states of time entries.
#[tauri::command(async)]
pub fn jira_entry_issues(state: State<AppState>, entry_ids: Vec<i64>) -> Result<Vec<EntryIssue>> {
    let mut list = state.reader().issue_entries(&entry_ids)?;
    for e in &mut list {
        e.syncs = logs_work(&state, &e.site);
    }
    Ok(list)
}

// ------------------------------------------------------------------ create

/// Projects of a site for „Jira-Issue anlegen“: asked live, else the cached ones.
#[tauri::command]
pub async fn jira_projects(app: AppHandle, site: String) -> Result<Vec<RemoteProject>> {
    let state = app.state::<AppState>();
    let s = site_of(&state, &site)?;
    match client(&state, &s)?.projects().await {
        Ok(list) if !list.is_empty() => Ok(list),
        other => {
            let cached: Vec<RemoteProject> = state
                .reader()
                .issue_projects()?
                .into_iter()
                .filter(|(x, _, _)| *x == site)
                .map(|(_, key, name)| RemoteProject { key, name, issue_types: vec![] })
                .collect();
            match other {
                Err(e) if cached.is_empty() => Err(e),
                _ => Ok(cached),
            }
        }
    }
}

#[tauri::command]
pub async fn jira_issue_types(app: AppHandle, site: String, project: String) -> Result<Vec<String>> {
    let state = app.state::<AppState>();
    let s = site_of(&state, &site)?;
    let list = client(&state, &s)?.project_types(&project).await.unwrap_or_default();
    Ok(if list.is_empty() { vec!["Task".into(), "Bug".into(), "Story".into()] } else { list })
}

/// Creates an issue from a task; the description points back to the note.
#[tauri::command]
pub async fn jira_create_issue(
    app: AppHandle,
    site: String,
    project: String,
    issue_type: String,
    summary: String,
    page_id: Option<i64>,
) -> Result<Issue> {
    let state = app.state::<AppState>();
    let s = site_of(&state, &site)?;
    let summary = summary.trim().to_owned();
    if summary.is_empty() {
        return Err(Error::State(tr!("Der Titel fehlt", "The summary is missing").into()));
    }
    let note = page_id.and_then(|id| state.reader().page(id).ok()).map(|p| p.title);
    let description = match note {
        Some(t) => trf!("Angelegt aus der Notiz „{t}“ in Arcalo.", "Created from the note “{t}” in Arcalo."),
        None => tr!("Angelegt in Arcalo.", "Created in Arcalo.").to_owned(),
    };
    let c = client(&state, &s)?;
    let key =
        c.create(&NewIssue { project: project.clone(), issue_type, summary: summary.clone(), description }).await?;
    let issue = match c.get(&key).await {
        Ok(i) => i,
        Err(_) => Issue {
            site: s.id.clone(),
            url: core_jira::browse_url(&s.url, &key),
            summary,
            project_key: project,
            status_category: "new".into(),
            key: key.clone(),
            ..Default::default()
        },
    };
    state.db().issue_put(&s.id, &issue, Utc::now())?;
    devlog::debug("jira", format!("{}: created {key}", s.id));
    let _ = app.emit("jira://synced", &s.id);
    Ok(issue)
}

// ------------------------------------------------------------------ sprint

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct SprintView {
    site: String,
    project: String,
    /// Agile answered (a board of the project exists).
    available: bool,
    sprint: Option<Sprint>,
    burndown: Vec<BurnPoint>,
    /// When this was read from Jira (a cached view offline).
    read_at: Option<DateTime<Utc>>,
    error: Option<String>,
}

/// The project most of my issues are in.
fn main_project(state: &AppState, site: &str) -> Option<String> {
    let list = state
        .reader()
        .issues_list(&IssueFilter { site: site.into(), query: issues::MINE.into(), ..Default::default() })
        .ok()?;
    let mut count: HashMap<String, usize> = HashMap::new();
    for i in &list {
        *count.entry(i.project_key.clone()).or_default() += 1;
    }
    count.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(&a.0))).map(|(k, _)| k)
}

/// The active sprint of a project (default: the first site, the project of most of my issues),
/// with a burndown. Offline: the last view read, with the error.
#[tauri::command]
pub async fn jira_sprint(app: AppHandle, site: Option<String>, project: Option<String>) -> Result<SprintView> {
    let state = app.state::<AppState>();
    let settings = state.settings().jira;
    let s = match site.filter(|s| !s.is_empty()) {
        Some(id) => settings.site(&id).cloned(),
        None => settings.active().next().cloned(),
    };
    let Some(s) = s else { return Ok(SprintView::default()) };
    let Some(project) = project.filter(|p| !p.is_empty()).or_else(|| main_project(&state, &s.id)) else {
        return Ok(SprintView { site: s.id, ..Default::default() });
    };
    let meta = format!("jira.sprint.{}.{project}", s.id);
    let live = async { client(&state, &s)?.sprint(&project).await }.await;
    match live {
        Ok(sprint) => {
            let today = Local::now().date_naive();
            let burndown = sprint
                .as_ref()
                .and_then(|sp| {
                    let day = |t: &Option<String>| {
                        t.as_deref()
                            .and_then(|x| DateTime::parse_from_rfc3339(x).ok())
                            .map(|d| d.with_timezone(&Local).date_naive())
                    };
                    Some(issues::burndown(day(&sp.start)?, day(&sp.end)?, &sp.issues, today))
                })
                .unwrap_or_default();
            let view = SprintView {
                site: s.id.clone(),
                project,
                available: sprint.is_some(),
                sprint,
                burndown,
                read_at: Some(Utc::now()),
                error: None,
            };
            if let Ok(json) = serde_json::to_string(&view) {
                let _ = state.db().meta_set(&meta, &json);
            }
            Ok(view)
        }
        Err(e) => {
            let cached: Option<SprintView> =
                state.reader().meta_get(&meta).ok().flatten().and_then(|j| serde_json::from_str(&j).ok());
            let error = Some(e.to_string());
            Ok(match cached {
                Some(v) => SprintView { error, ..v },
                None => SprintView { site: s.id, project, error, ..Default::default() },
            })
        }
    }
}

// ------------------------------------------------------------------ worklogs

/// Posts due worklogs soon (after a booking with an issue key).
pub fn kick_worklogs(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        run_worklogs(&app).await;
    });
}

/// Posts the due worklogs, one runner at a time. A retry first looks for a worklog an
/// interrupted try left on the issue; an entry is never posted twice (`worklog_claim`).
async fn run_worklogs(app: &AppHandle) {
    let sync = app.state::<JiraSync>();
    if sync.worklogs.swap(true, Ordering::SeqCst) {
        sync.again.store(true, Ordering::SeqCst);
        return;
    }
    loop {
        post_worklogs(app).await;
        if !sync.again.swap(false, Ordering::SeqCst) {
            break;
        }
    }
    sync.worklogs.store(false, Ordering::SeqCst);
}

async fn post_worklogs(app: &AppHandle) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let mut changed = false;
    if settings.time_tracking() {
        let due = state.reader().worklogs_due(Utc::now()).unwrap_or_default();
        let mut accounts: HashMap<String, String> = HashMap::new();
        for p in due {
            let Some(site) = settings.jira.site(&p.site).filter(|s| s.enabled && s.log_work).cloned() else { continue };
            if !state.db().worklog_claim(p.entry_id).unwrap_or(false) {
                continue;
            }
            changed = true;
            let outcome: Result<String> = async {
                let c = client(&state, &site)?;
                // Posted before: the entry changed, its worklog follows.
                if let Some(id) = &p.worklog_id {
                    c.update_work(id, &p.work).await?;
                    return Ok(id.clone());
                }
                if p.retry {
                    let account = match accounts.get(&site.id) {
                        Some(a) => a.clone(),
                        None => {
                            let a = c.whoami().await?.id;
                            accounts.insert(site.id.clone(), a.clone());
                            a
                        }
                    };
                    let list = c.worklogs(&p.work.key).await?;
                    if let Some(w) = issues::matching_worklog(&list, &p.work, &account) {
                        return Ok(w.id.clone());
                    }
                }
                c.log_work(&p.work).await
            }
            .await;
            match outcome {
                Ok(id) => {
                    let _ = state.db().worklog_posted(p.entry_id, &id);
                    devlog::debug("jira", format!("{}: worklog {id} for entry {}", p.work.key, p.entry_id));
                }
                Err(e) => {
                    let msg = devlog::redact(&e.to_string());
                    devlog::warn("jira", format!("{}: worklog for entry {} failed: {msg}", p.work.key, p.entry_id));
                    let _ = state.db().worklog_failed(p.entry_id, &msg, Utc::now());
                }
            }
        }
        // Worklogs of deleted entries.
        let deletes = state.reader().worklog_deletes_due(Utc::now()).unwrap_or_default();
        for d in deletes {
            changed = true;
            let Some(site) = settings.jira.site(&d.site).filter(|s| s.enabled && s.log_work).cloned() else {
                // The site stopped logging work (or is gone): Jira keeps the worklog.
                let _ = state.db().worklog_deleted(d.id);
                continue;
            };
            let outcome = match client(&state, &site) {
                Ok(c) => c.delete_work(&d.issue_key, &d.worklog_id).await,
                Err(e) => Err(e),
            };
            match outcome {
                Ok(()) => {
                    let _ = state.db().worklog_deleted(d.id);
                    devlog::debug("jira", format!("{}: worklog {} deleted", d.issue_key, d.worklog_id));
                }
                Err(e) => {
                    let msg = devlog::redact(&e.to_string());
                    devlog::warn("jira", format!("{}: deleting worklog {} failed: {msg}", d.issue_key, d.worklog_id));
                    let _ = state.db().worklog_delete_failed(d.id, &msg, Utc::now());
                }
            }
        }
    }
    if changed {
        let _ = app.emit("jira://worklog", ());
    }
}

/// Whether changes of entries reach Jira on `site`: time tracking on, the site enabled and
/// logging work (Settings → Jira).
pub fn logs_work(state: &AppState, site: &str) -> bool {
    let settings = state.settings();
    settings.time_tracking() && settings.jira.site(site).is_some_and(|s| s.enabled && s.log_work)
}

/// An entry was edited: its posted worklog is updated when duration, start or comment changed.
pub fn after_entry_edit(app: &AppHandle, before: &TimeEntry, after: &TimeEntry) {
    if !issues::worklog_differs(before, after) {
        return;
    }
    let state = app.state::<AppState>();
    let Ok(Some((site, _, _))) = state.reader().entry_worklog(after.id) else { return };
    if logs_work(&state, &site) && state.db().worklog_changed(after.id).unwrap_or(false) {
        kick_worklogs(app.clone());
    }
}

/// Deletes an entry; its posted worklog is queued for deletion in Jira in the same
/// transaction (a failed deletion is retried). Returns whether one was queued.
pub fn delete_entry(state: &AppState, entry_id: i64) -> Result<bool> {
    let db = state.db();
    let site = db.entry_worklog(entry_id)?.map(|(site, _, _)| site);
    let queue = site.is_some_and(|s| logs_work(state, &s));
    db.atomic(|| {
        let queued = queue && db.worklog_queue_delete(entry_id)?;
        db.delete_time_entry(entry_id)?;
        Ok(queued)
    })
}

/// „Erneut versuchen“ on a failed worklog.
#[tauri::command]
pub async fn jira_worklog_retry(app: AppHandle, entry_id: i64) -> Result<()> {
    app.state::<AppState>().db().worklog_retry_now(entry_id)?;
    run_worklogs(&app).await;
    Ok(())
}

// ------------------------------------------------------------------ assistant

/// Compact form of an issue for the model.
fn brief(i: &Issue) -> serde_json::Value {
    serde_json::json!({
        "key": i.key, "summary": i.summary, "status": i.status, "priority": i.priority, "assignee": i.assignee,
        "type": i.issue_type, "sprint": i.sprint, "due": i.due_date, "updated": i.updated, "url": i.url,
    })
}

/// Sites a tool asks about: one named by id or name, else all active ones.
fn tool_sites(settings: &IssueSettings, wanted: &str) -> Vec<JiraSite> {
    let w = wanted.trim().to_lowercase();
    settings.active().filter(|s| w.is_empty() || s.id == w || s.name.to_lowercase() == w).cloned().collect()
}

/// The assistant's read-only Jira tools: live when Jira answers, else from the cache.
#[tauri::command]
pub async fn jira_tool(app: AppHandle, name: String, arguments: String) -> Result<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    settings.check_tool(&name)?;
    let args: serde_json::Value = serde_json::from_str(&arguments)?;
    let arg = |k: &str| args[k].as_str().unwrap_or_default().trim().to_owned();
    let out = match name.as_str() {
        "jira_search" => {
            let query = arg("query");
            let jql = core_jira::search_jql(&query);
            let mut found: Vec<Issue> = vec![];
            let mut offline = None;
            for s in tool_sites(&settings.jira, &arg("site")) {
                match async { client(&state, &s)?.search(&jql, 20).await }.await {
                    Ok(list) => {
                        let db = state.db();
                        for i in &list {
                            let _ = db.issue_put(&s.id, i, Utc::now());
                        }
                        found.extend(list);
                    }
                    Err(e) => offline = Some(e.to_string()),
                }
            }
            if found.is_empty() && offline.is_some() {
                // Offline: the cached issues whose key or text has every word.
                let words: Vec<String> = query.to_lowercase().split_whitespace().map(str::to_owned).collect();
                found = state
                    .reader()
                    .issues_list(&IssueFilter { all: true, ..Default::default() })?
                    .into_iter()
                    .filter(|i| {
                        let hay = format!("{} {} {}", i.key, i.summary, i.description).to_lowercase();
                        words.iter().all(|w| hay.contains(w))
                    })
                    .take(20)
                    .collect();
            }
            serde_json::json!({ "jql": jql, "issues": found.iter().map(brief).collect::<Vec<_>>(), "offline": offline })
                .to_string()
        }
        "jira_issue" => {
            let key = arg("key").to_uppercase();
            let live = match site_for_key(&state, &key) {
                Ok(s) => async { client(&state, &s)?.get(&key).await }.await.map(|i| (s.id, i)),
                Err(e) => Err(e),
            };
            let issue = match live {
                Ok((site, i)) => {
                    let _ = state.db().issue_put(&site, &i, Utc::now());
                    Some(i)
                }
                Err(_) => state.reader().issue_get(&key)?,
            };
            let issue = issue.ok_or_else(|| Error::not_found("issue", key.clone()))?;
            let mut v = brief(&issue);
            v["description"] = issue.description.chars().take(4000).collect::<String>().into();
            v["comments"] = serde_json::to_value(&issue.comments)?;
            v["reporter"] = issue.reporter.clone().into();
            v.to_string()
        }
        "jira_my_issues" => {
            let mut sites = vec![];
            for s in tool_sites(&settings.jira, &arg("site")) {
                let mine = state.reader().issues_list(&IssueFilter {
                    site: s.id.clone(),
                    query: issues::MINE.into(),
                    ..Default::default()
                })?;
                let sprint = jira_sprint(app.clone(), Some(s.id.clone()), None).await.ok().and_then(|v| v.sprint);
                let sprint = sprint.map(|sp| {
                    let done = sp.issues.iter().filter(|i| i.done()).count();
                    serde_json::json!({ "name": sp.name, "goal": sp.goal, "start": sp.start, "end": sp.end,
                        "issues": sp.issues.len(), "done": done, "open": sp.issues.iter().filter(|i| !i.done()).map(brief).collect::<Vec<_>>() })
                });
                sites.push(serde_json::json!({ "site": s.name, "my_open_issues": mine.iter().map(brief).collect::<Vec<_>>(), "sprint": sprint }));
            }
            serde_json::json!({ "sites": sites }).to_string()
        }
        other => {
            return Err(Error::State(trf!("„{other}“ ist kein Jira-Werkzeug", "“{other}” is not a Jira tool")));
        }
    };
    Ok(out)
}

/// A confirmed comment or status change of the assistant.
pub async fn run_write(app: &AppHandle, call: &annalo_core::ai::tools::SystemCall) -> Result<String> {
    use annalo_core::ai::tools::SystemCall;
    let state = app.state::<AppState>();
    let key = match call {
        SystemCall::JiraComment { key, .. } | SystemCall::JiraTransition { key, .. } => key.clone(),
        _ => return Err(Error::State("not a Jira call".into())),
    };
    let site = site_for_key(&state, &key)?;
    if !site.allow_writes {
        return Err(Error::State(trf!(
            "Die Jira-Site „{}“ erlaubt dem Assistenten keine Änderungen (Einstellungen → Jira)",
            "The Jira site “{}” does not allow the assistant to change issues (Settings → Jira)",
            site.name
        )));
    }
    let c = client(&state, &site)?;
    let out = match call {
        SystemCall::JiraComment { body, .. } => {
            c.comment(&key, body).await?;
            trf!("Kommentar zu {key} gespeichert.", "Comment on {key} saved.")
        }
        SystemCall::JiraTransition { status, .. } => {
            let now = c.transition(&key, status).await?;
            trf!("{key} ist jetzt „{now}“.", "{key} is now “{now}”.")
        }
        _ => unreachable!(),
    };
    if let Ok(i) = c.get(&key).await {
        let _ = state.db().issue_put(&site.id, &i, Utc::now());
        let _ = app.emit("jira://synced", &site.id);
    }
    Ok(out)
}
