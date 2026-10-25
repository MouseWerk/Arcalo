//! The issue view („Issue-Ansicht“): one Jira issue with everything Jira's own page shows, opened as
//! a modal (a full-screen sheet on phones), and its edits: fields Jira allows to edit (`editmeta`),
//! status changes with their screens, comments, worklogs and „Mir zuweisen“. The logic lives in
//! `arcalo_core::issues::view`.
//!
//! Every read is stored as the issue's offline copy (`issue_full`) and refreshes its row of the
//! list cache; without a connection the last copy is shown read-only with the time it was read.
//! Every edit is checked against the issue's `updated` first: someone else's change is shown, never
//! overwritten. Images and files load through the site's client (its proxy and certificates); the
//! login is sent only to the site itself, never in an address.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};

use arcalo_core::issues::view::{
    CommentPage, FieldInput, HistoryPage, IssueFull, UpdateOutcome, User, WorklogPage, parse_duration,
};
use arcalo_core::issues::{self as issues, IssueProvider, JiraSite, WorkLog};
use arcalo_core::{Error, tr, trf};
use base64::Engine;
use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::jira::{client, site_for_key, site_of};
use crate::{AppState, Result, devlog};

/// Images and avatars kept in memory (data URLs), newest last.
const IMAGE_CACHE: usize = 300;
/// The largest image shown inline …
const IMAGE_LIMIT: usize = 10_000_000;
/// … and the largest attachment opened or saved.
const FILE_LIMIT: usize = 200_000_000;

/// The issue view as the modal shows it: the issue, how fresh it is, and Arcalo's side of it.
#[derive(Serialize)]
pub struct FullView {
    issue: IssueFull,
    /// When this copy was read from Jira.
    fetched_at: DateTime<Utc>,
    /// Jira could not be reached (or refused): the copy is the last one read, shown read-only.
    offline: Option<String>,
    site_name: String,
    site_color: String,
    note_page_id: Option<i64>,
    /// The WBS bookings with this key go to.
    wbs: Option<String>,
    booked_minutes: i64,
    /// Time tracking is on (a worklog can also be booked).
    time_tracking: bool,
    /// Bookings with this key post their worklog to Jira (Settings → Jira).
    logs_work: bool,
}

fn view_of(state: &AppState, issue: IssueFull, fetched_at: DateTime<Utc>, offline: Option<String>) -> Result<FullView> {
    let db = state.reader();
    let settings = state.settings();
    let site = settings.jira.site(&issue.site).cloned().unwrap_or_default();
    let booked_minutes: i64 = db.conn().query_row(
        "SELECT IFNULL(SUM(e.duration_minutes), 0) FROM time_entry_issues l JOIN time_entries e ON e.id = l.entry_id WHERE l.issue_key = ?1",
        [&issue.key],
        |r| r.get(0),
    )?;
    Ok(FullView {
        note_page_id: db.issue_note(&issue.key)?,
        wbs: db.issue_wbs_for(&issue.key)?,
        booked_minutes,
        time_tracking: settings.time_tracking(),
        logs_work: issues::logs_work(&settings, &issue.site),
        site_name: site.name,
        site_color: site.color,
        issue,
        fetched_at,
        offline,
    })
}

/// Reads the issue from Jira, stores it as the offline copy and returns the view.
async fn fetch(app: &AppHandle, site: &JiraSite, key: &str) -> Result<FullView> {
    let state = app.state::<AppState>();
    let issue = client(&state, site)?.full(key).await?;
    let now = Utc::now();
    state.db().issue_full_put(&issue, now)?;
    let _ = app.emit("jira://issue", key);
    view_of(&state, issue, now, None)
}

/// The site an issue belongs to, the cached view's when there is one.
fn site_of_view(state: &AppState, key: &str) -> Result<JiraSite> {
    match state.reader().issue_full_get(None, key)? {
        Some(c) => site_of(state, &c.issue.site).or_else(|_| site_for_key(state, key)),
        None => site_for_key(state, key),
    }
}

fn check_key(key: &str) -> Result<String> {
    let key = key.trim().to_uppercase();
    if issues::is_key(&key) {
        Ok(key)
    } else {
        Err(Error::State(trf!("„{key}“ ist kein Issue-Schlüssel", "“{key}” is not an issue key")))
    }
}

/// The last copy read, at once (the modal shows it while Jira is asked).
#[tauri::command(async)]
pub fn jira_full_cached(app: AppHandle, key: String) -> Result<Option<FullView>> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let Some(c) = state.reader().issue_full_get(None, &key)? else { return Ok(None) };
    Ok(Some(view_of(&state, c.issue, c.fetched_at, None)?))
}

/// The issue from Jira. Not reachable: the last copy with the error (read-only), else the error.
#[tauri::command]
pub async fn jira_full(app: AppHandle, key: String) -> Result<FullView> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    match fetch(&app, &site, &key).await {
        Ok(v) => Ok(v),
        Err(e) => {
            devlog::warn("jira", format!("{key}: issue view: {}", devlog::redact(&e.to_string())));
            match state.reader().issue_full_get(Some(&site.id), &key)? {
                Some(c) => view_of(&state, c.issue, c.fetched_at, Some(e.to_string())),
                None => Err(e),
            }
        }
    }
}

/// An older page of comments (`skip`: how many of the newest are shown already).
#[tauri::command]
pub async fn jira_full_comments(app: AppHandle, key: String, skip: usize) -> Result<CommentPage> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    let c = client(&state, &site)?;
    let me = me_of(&state, &key, &c).await?;
    c.comment_page(&key, skip, &me).await
}

#[tauri::command]
pub async fn jira_full_worklogs(app: AppHandle, key: String, skip: usize) -> Result<WorklogPage> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    let c = client(&state, &site)?;
    let me = me_of(&state, &key, &c).await?;
    c.worklog_page(&key, skip, &me).await
}

#[tauri::command]
pub async fn jira_full_history(app: AppHandle, key: String, skip: usize) -> Result<HistoryPage> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    client(&state, &site)?.history_page(&key, skip).await
}

/// The user of the token (from the offline copy, else asked).
async fn me_of(state: &AppState, key: &str, c: &issues::jira::JiraClient) -> Result<User> {
    if let Some(cached) = state.reader().issue_full_get(Some(c.site()), key)?
        && !cached.issue.me.id.is_empty()
    {
        return Ok(cached.issue.me);
    }
    let a = c.whoami().await?;
    Ok(User { id: a.id, name: a.display_name, ..Default::default() })
}

/// The copy the edit is made against: its editmeta decides what may be written.
fn shown_copy(state: &AppState, key: &str) -> Result<IssueFull> {
    state.reader().issue_full_get(None, key)?.map(|c| c.issue).ok_or_else(|| {
        Error::State(
            tr!(
                "Das Issue ist nicht geladen. Neu laden und erneut versuchen.",
                "The issue is not loaded. Reload and try again."
            )
            .into(),
        )
    })
}

/// The outcome of an edit: what Jira answered, and the issue read again after a save.
#[derive(Serialize)]
pub struct EditResult {
    outcome: UpdateOutcome,
    view: Option<FullView>,
}

/// Saves one field when the issue still has `expected` as its `updated` (else a conflict with the
/// value in Jira now). `undo` in the answer writes the value before.
#[tauri::command]
pub async fn jira_full_update(
    app: AppHandle,
    key: String,
    field: String,
    input: FieldInput,
    expected: String,
) -> Result<EditResult> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let copy = shown_copy(&state, &key)?;
    let meta = copy.editable(&field).cloned().ok_or_else(|| {
        Error::State(trf!(
            "Jira erlaubt nicht, „{field}“ zu ändern (keine Berechtigung oder nicht auf der Maske)",
            "Jira does not allow to change “{field}” (no permission or not on the screen)"
        ))
    })?;
    let site = site_of(&state, &copy.site)?;
    let outcome = client(&state, &site)?.update_checked(&key, &meta, &input, &expected).await?;
    let view = match &outcome {
        UpdateOutcome::Saved { .. } => {
            devlog::debug("jira", format!("{key}: {field} saved"));
            Some(fetch(&app, &site, &key).await?)
        }
        UpdateOutcome::Conflict { .. } => None,
    };
    let _ = app.emit("jira://synced", &site.id);
    Ok(EditResult { outcome, view })
}

/// „Mir zuweisen“ (or, with `user`, assigning someone; `None` and `unassign`: nobody), checked
/// against `expected` like every edit.
#[tauri::command]
pub async fn jira_full_assign(
    app: AppHandle,
    key: String,
    user: Option<String>,
    unassign: Option<bool>,
    expected: String,
) -> Result<EditResult> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let copy = shown_copy(&state, &key)?;
    let site = site_of(&state, &copy.site)?;
    let c = client(&state, &site)?;
    let target = match (user.filter(|u| !u.is_empty()), unassign.unwrap_or(false)) {
        (Some(u), _) => Some(u),
        (None, true) => None,
        (None, false) => Some(me_of(&state, &key, &c).await?.id),
    };
    let (updated, raw, _) = c.field_state(&key, "assignee").await?;
    if !expected.is_empty() && updated != expected {
        let value = issues::view::parse_user(&raw).map(|u| issues::view::Shown::Users(vec![u]));
        return Ok(EditResult { outcome: UpdateOutcome::Conflict { updated, value, by: None }, view: None });
    }
    let before = issues::view::parse_user(&raw).map(|u| u.id);
    c.assign(&key, target.as_deref()).await?;
    let view = fetch(&app, &site, &key).await?;
    let _ = app.emit("jira://synced", &site.id);
    Ok(EditResult { outcome: UpdateOutcome::Saved { undo: Some(FieldInput::User(before)) }, view: Some(view) })
}

#[derive(Serialize)]
pub struct TransitionResult {
    view: FullView,
    /// A transition back to the status before, without a screen to fill (the undo), if Jira has one.
    undo: Option<String>,
}

/// Changes the status by the transition `id`, with the values of its screen and an optional comment.
#[tauri::command]
pub async fn jira_full_transition(
    app: AppHandle,
    key: String,
    id: String,
    inputs: Vec<(String, FieldInput)>,
    comment: Option<Value>,
) -> Result<TransitionResult> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let copy = shown_copy(&state, &key)?;
    let site = site_of(&state, &copy.site)?;
    let t = copy.transitions.iter().find(|t| t.id == id).cloned().ok_or_else(|| {
        Error::State(
            tr!(
                "Dieser Statuswechsel ist nicht mehr möglich. Neu laden.",
                "This status change is no longer possible. Reload."
            )
            .into(),
        )
    })?;
    client(&state, &site)?.do_transition(&key, &t, &inputs, comment.as_ref()).await?;
    devlog::debug("jira", format!("{key}: moved to {}", t.to.name));
    let view = fetch(&app, &site, &key).await?;
    let back = &copy.status.name;
    let undo = view
        .issue
        .transitions
        .iter()
        .find(|x| &x.to.name == back && !x.fields.iter().any(|f| f.required && f.id != "comment"))
        .map(|x| x.id.clone());
    let _ = app.emit("jira://synced", &site.id);
    Ok(TransitionResult { view, undo })
}

#[derive(Serialize)]
pub struct CommentResult {
    view: FullView,
    id: String,
}

/// Adds a comment (the editor's document; ADF on Cloud, wiki markup on Server).
#[tauri::command]
pub async fn jira_full_comment_add(app: AppHandle, key: String, doc: Value) -> Result<CommentResult> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    let id = client(&state, &site)?.comment_add(&key, &doc).await?;
    Ok(CommentResult { view: fetch(&app, &site, &key).await?, id })
}

#[tauri::command]
pub async fn jira_full_comment_edit(app: AppHandle, key: String, id: String, doc: Value) -> Result<FullView> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    client(&state, &site)?.comment_edit(&key, &id, &doc).await?;
    fetch(&app, &site, &key).await
}

#[tauri::command]
pub async fn jira_full_comment_delete(app: AppHandle, key: String, id: String) -> Result<FullView> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    client(&state, &site)?.comment_delete(&key, &id).await?;
    fetch(&app, &site, &key).await
}

#[derive(Serialize)]
pub struct WorklogResult {
    view: FullView,
    /// The worklog posted directly (deleted again by its undo).
    worklog_id: Option<String>,
    /// The booking made in Arcalo's time tracking (its worklog goes out with it when the site logs work).
    entry_id: Option<i64>,
}

/// Logs work: `book` also books it in the time tracking on the issue's WBS. When the site posts
/// worklogs of bookings, the booking's worklog is the one (never posted twice); otherwise the
/// worklog is posted here and the booking only names the issue.
#[tauri::command]
pub async fn jira_full_worklog_add(
    app: AppHandle,
    key: String,
    started: DateTime<Utc>,
    duration: String,
    comment: String,
    book: bool,
) -> Result<WorklogResult> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    let seconds = parse_duration(&duration).ok_or_else(|| {
        Error::State(trf!(
            "„{duration}“ ist keine Dauer (z. B. 1h 30m, 45m, 2d)",
            "“{duration}” is not a duration (e.g. 1h 30m, 45m, 2d)"
        ))
    })?;
    let minutes = (seconds + 30) / 60;
    let settings = state.settings();
    let mut entry_id = None;
    if book {
        settings.require_time_tracking()?;
        let text = comment.split_whitespace().collect::<Vec<_>>().join(" ");
        let line = format!("/zeit {minutes}m {key} {text}");
        let out = {
            let db = state.db();
            let ctx = arcalo_core::tracking::SlashContext { default_ref: None, page_id: None };
            let end = started + chrono::Duration::minutes(minutes);
            arcalo_core::tracking::log_slash_command_in(&db, line.trim(), end, &Local, &settings.thresholds, ctx)?
        };
        entry_id = Some(out.entry.id);
        let _ = app.emit("data://entries", ());
    }
    let mut worklog_id = None;
    if book && issues::logs_work(&settings, &site.id) {
        // The booking's worklog goes out now, so the view read below shows it.
        crate::jira::run_worklogs(&app).await;
    } else {
        let id = client(&state, &site)?
            .log_work(&WorkLog { key: key.clone(), started, minutes, comment: comment.trim().to_owned() })
            .await?;
        if let Some(e) = entry_id {
            // The booking knows its worklog: it is never posted again.
            state.db().worklog_posted(e, &id)?;
        }
        worklog_id = Some(id);
    }
    let view = fetch(&app, &site, &key).await?;
    Ok(WorklogResult { view, worklog_id, entry_id })
}

/// Deletes a worklog posted from the view (its undo).
#[tauri::command]
pub async fn jira_full_worklog_delete(app: AppHandle, key: String, id: String) -> Result<FullView> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    client(&state, &site)?.delete_work(&key, &id).await?;
    fetch(&app, &site, &key).await
}

/// Users for a user field (`assignable`: who may be assignee).
#[tauri::command]
pub async fn jira_full_users(app: AppHandle, key: String, query: String, assignable: bool) -> Result<Vec<User>> {
    let key = check_key(&key)?;
    let state = app.state::<AppState>();
    let site = site_of_view(&state, &key)?;
    client(&state, &site)?.user_search(&key, &query, assignable).await
}

/// A stored body (ADF or wiki markup) as the editor's document, with what the editor cannot keep.
#[tauri::command(async)]
pub fn jira_body_doc(body: Value) -> issues::richtext::EditorDoc {
    issues::view::body_to_doc(&body)
}

// ------------------------------------------------------------------ images and files

#[derive(Default)]
struct Images {
    by_url: HashMap<String, String>,
    order: VecDeque<String>,
}

fn images() -> &'static Mutex<Images> {
    static CACHE: OnceLock<Mutex<Images>> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

/// An image of the issue (inline image, thumbnail, avatar) as a data URL, through the site's
/// client; kept in memory for the next view.
#[tauri::command]
pub async fn jira_image(app: AppHandle, site: String, url: String) -> Result<String> {
    if let Some(hit) = crate::lock(images()).by_url.get(&url).cloned() {
        return Ok(hit);
    }
    let state = app.state::<AppState>();
    let s = site_of(&state, &site)?;
    let (mime, bytes) = client(&state, &s)?.bytes(&url, IMAGE_LIMIT).await?;
    let mime = if mime.starts_with("image/") { mime } else { sniff_image(&bytes).to_owned() };
    if !mime.starts_with("image/") || mime.contains("svg") {
        // An SVG could carry scripts; anything else is no image.
        return Err(Error::State(tr!("Kein Bild", "Not an image").into()));
    }
    let data = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    let mut cache = crate::lock(images());
    cache.by_url.insert(url.clone(), data.clone());
    cache.order.push_back(url);
    while cache.order.len() > IMAGE_CACHE {
        if let Some(old) = cache.order.pop_front() {
            cache.by_url.remove(&old);
        }
    }
    Ok(data)
}

/// The image type of `bytes` by their first bytes (a server that sends no type).
fn sniff_image(bytes: &[u8]) -> &'static str {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        [0xFF, 0xD8, 0xFF, ..] => "image/jpeg",
        [b'G', b'I', b'F', b'8', ..] => "image/gif",
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => "image/webp",
        _ => "application/octet-stream",
    }
}

/// Copies opened more than a week ago are removed (they were opened in their app already).
fn forget_old_files(dir: &std::path::Path) {
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// A file name that is safe on every system.
fn safe_name(name: &str) -> String {
    let cleaned: String =
        name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c }).collect();
    let cleaned = cleaned.trim().trim_matches('.').to_owned();
    if cleaned.is_empty() { "attachment".into() } else { cleaned.chars().take(120).collect() }
}

/// An attachment: saved to `target` (chosen by the user), or into a temporary folder and opened
/// with its app (programs and scripts are only shown in the file manager). Returns the path.
#[tauri::command]
pub async fn jira_attachment(
    app: AppHandle,
    site: String,
    url: String,
    filename: String,
    target: Option<String>,
) -> Result<String> {
    use tauri_plugin_opener::OpenerExt;
    let state = app.state::<AppState>();
    let s = site_of(&state, &site)?;
    let (_, bytes) = client(&state, &s)?.bytes(&url, FILE_LIMIT).await?;
    let name = safe_name(&filename);
    let path = match target.filter(|t| !t.trim().is_empty()) {
        Some(t) => std::path::PathBuf::from(t),
        None => {
            let dir = state.data_dir.join("jira-files").join(&s.id);
            std::fs::create_dir_all(&dir).map_err(|e| Error::State(e.to_string()))?;
            forget_old_files(&dir);
            dir.join(&name)
        }
    };
    std::fs::write(&path, &bytes).map_err(|e| {
        Error::State(trf!("„{name}“ ließ sich nicht speichern: {e}", "“{name}” could not be saved: {e}"))
    })?;
    if path.starts_with(state.data_dir.join("jira-files")) {
        #[cfg(mobile)]
        {
            let cache = app.path().app_cache_dir().map_err(|e| Error::State(e.to_string()))?;
            #[cfg(target_os = "android")]
            let opened = crate::mobile::android::open_file(&cache, &path);
            #[cfg(target_os = "ios")]
            let opened = crate::mobile::ios::share_file(&cache, &path);
            opened.map_err(|e| {
                Error::State(trf!("„{name}“ ließ sich nicht öffnen: {e}", "“{name}” could not be opened: {e}"))
            })?;
        }
        #[cfg(desktop)]
        {
            let opened = if arcalo_core::attachments::is_executable(&name) {
                app.opener().reveal_item_in_dir(&path)
            } else {
                app.opener().open_path(path.display().to_string(), None::<&str>)
            };
            opened.map_err(|e| {
                Error::State(trf!("„{name}“ ließ sich nicht öffnen: {e}", "“{name}” could not be opened: {e}"))
            })?;
        }
    }
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_and_image_types() {
        assert_eq!(safe_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(safe_name("re:port?.pdf"), "re_port_.pdf");
        assert_eq!(safe_name("  "), "attachment");
        assert_eq!(sniff_image(&[0x89, b'P', b'N', b'G', 1]), "image/png");
        assert_eq!(sniff_image(b"<svg"), "application/octet-stream");
    }
}
