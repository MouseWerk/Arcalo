//! Notifications with buttons: tasks due today („Erledigt“, „Schlummern“ 10 min / 1 h /
//! tomorrow, „Öffnen“), the morning briefing („Öffnen“), the end of a focus session („+5 Min“,
//! „Pause“, „Öffnen“) and a downloaded update („Jetzt neu starten“, „Später“). Clicking the
//! notification itself opens the matching place.
//!
//! Every button is an `arcalo-notify:` address ([`url`]), handled by [`dispatch`]:
//! - Windows: a toast with protocol activation. The scheme is registered for the user
//!   (HKCU\Software\Classes); Windows starts Arcalo with the address, the single-instance plugin
//!   hands it to the running app (or the first start picks it up). This also works from the
//!   Action Center after the toast left the screen, and needs no COM server, which an unpackaged
//!   per-user NSIS install could not keep registered reliably. Portable copies register nothing
//!   and show plain notifications.
//! - Linux: freedesktop actions (notify-rust); a thread waits for the click.
//! - macOS: plain notifications through the plugin (clicking brings Arcalo to the front).
//!
//! A snoozed reminder is stored in the database (meta `notify.snoozes`) and shown again when
//! its time has come, also after a restart. Debug builds with `ANNALO_NOTIFY_TEST` set show
//! nothing on the desktop and accept simulated clicks ([`notify_test`]) for the tests.

use std::sync::Mutex;

use annalo_core::{Database, Error, tr, trf};
use chrono::{DateTime, Local, NaiveTime, TimeDelta, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

use crate::{AppState, lock};

type Result<T> = std::result::Result<T, Error>;

pub const SCHEME: &str = "arcalo-notify";
const SNOOZES_KEY: &str = "notify.snoozes";
const DUE_KEY: &str = "notify.task_due";
const UPDATE_KEY: &str = "notify.update_ready";
const TEST_ENV: &str = "ANNALO_NOTIFY_TEST";
/// Tasks due today are announced from this time on.
const DUE_FROM: (u32, u32) = (9, 0);
/// At most this many task reminders at once (the rest waits for the task view).
const DUE_MAX: usize = 5;

/// What a notification is about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Subject {
    Task { page_id: i64, ordinal: i64, text: String },
    Briefing,
    Focus,
    Update { version: String },
}

/// A button (or the click on the notification: [`Act::Open`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Act {
    Open,
    Done,
    Snooze10,
    Snooze60,
    SnoozeTomorrow,
    Extend,
    Pause,
    Restart,
    Later,
}

const ACTS: [Act; 9] = [
    Act::Open,
    Act::Done,
    Act::Snooze10,
    Act::Snooze60,
    Act::SnoozeTomorrow,
    Act::Extend,
    Act::Pause,
    Act::Restart,
    Act::Later,
];

impl Act {
    pub fn id(self) -> &'static str {
        match self {
            Act::Open => "open",
            Act::Done => "done",
            Act::Snooze10 => "snooze10",
            Act::Snooze60 => "snooze60",
            Act::SnoozeTomorrow => "snooze-tomorrow",
            Act::Extend => "extend",
            Act::Pause => "pause",
            Act::Restart => "restart",
            Act::Later => "later",
        }
    }

    fn parse(s: &str) -> Option<Act> {
        ACTS.into_iter().find(|a| a.id() == s)
    }

    pub fn label(self) -> &'static str {
        match self {
            Act::Open => tr!("Öffnen", "Open"),
            Act::Done => tr!("Erledigt", "Done"),
            Act::Snooze10 => tr!("10 Min.", "10 min"),
            Act::Snooze60 => tr!("1 Std.", "1 hr"),
            Act::SnoozeTomorrow => tr!("Morgen", "Tomorrow"),
            Act::Extend => tr!("+5 Min.", "+5 min"),
            Act::Pause => tr!("Pause", "Break"),
            Act::Restart => tr!("Jetzt neu starten", "Restart now"),
            Act::Later => tr!("Später", "Later"),
        }
    }
}

/// A notification with its buttons.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Note {
    pub subject: Subject,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub silent: bool,
}

impl Note {
    pub fn task(page_id: i64, ordinal: i64, text: &str, page_title: &str) -> Note {
        let body = if page_title.is_empty() {
            text.to_owned()
        } else {
            trf!("{text} – auf „{page_title}“", "{text} – on “{page_title}”")
        };
        Note {
            subject: Subject::Task { page_id, ordinal, text: text.to_owned() },
            title: tr!("Aufgabe heute fällig", "Task due today").into(),
            body,
            silent: false,
        }
    }

    pub fn briefing(body: &str) -> Note {
        Note {
            subject: Subject::Briefing,
            title: tr!("Morgen-Briefing", "Morning briefing").into(),
            body: body.into(),
            silent: false,
        }
    }

    pub fn focus_end(body: String) -> Note {
        Note { subject: Subject::Focus, title: tr!("Pause", "Break").into(), body, silent: true }
    }

    pub fn update_ready(version: &str) -> Note {
        Note {
            subject: Subject::Update { version: version.into() },
            title: trf!("Arcalo {version} ist bereit", "Arcalo {version} is ready"),
            body: tr!(
                "Das Update ist geladen und wird beim Neustart installiert.",
                "The update is downloaded and installs on the next restart."
            )
            .into(),
            silent: false,
        }
    }

    /// The buttons, in order (Windows shows up to five).
    pub fn actions(&self) -> Vec<Act> {
        match self.subject {
            Subject::Task { .. } => vec![Act::Done, Act::Snooze10, Act::Snooze60, Act::SnoozeTomorrow, Act::Open],
            Subject::Briefing => vec![Act::Open],
            Subject::Focus => vec![Act::Extend, Act::Pause, Act::Open],
            Subject::Update { .. } => vec![Act::Restart, Act::Later],
        }
    }

    /// What clicking the notification itself does.
    fn click(&self) -> Act {
        match self.subject {
            Subject::Update { .. } => Act::Later,
            _ => Act::Open,
        }
    }
}

// ------------------------------------------------------------------ addresses

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `arcalo-notify:?a=done&k=task&p=12&o=3&t=Angebot%20senden`
pub fn url(subject: &Subject, act: Act) -> String {
    let mut q = vec![("a", act.id().to_owned())];
    match subject {
        Subject::Task { page_id, ordinal, text } => q.extend([
            ("k", "task".into()),
            ("p", page_id.to_string()),
            ("o", ordinal.to_string()),
            ("t", text.clone()),
        ]),
        Subject::Briefing => q.push(("k", "briefing".into())),
        Subject::Focus => q.push(("k", "focus".into())),
        Subject::Update { version } => q.extend([("k", "update".into()), ("v", version.clone())]),
    }
    let query: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", encode(v))).collect();
    format!("{SCHEME}:?{}", query.join("&"))
}

/// The subject and button of an address (also with `//` after the scheme, as some shells add).
pub fn parse_url(s: &str) -> Option<(Subject, Act)> {
    let rest = s.trim().strip_prefix(SCHEME)?.strip_prefix(':')?;
    let query = rest.trim_start_matches('/').strip_prefix('?')?;
    let mut get = std::collections::HashMap::new();
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=')?;
        get.insert(k, decode(v)?);
    }
    let act = Act::parse(get.get("a")?)?;
    let subject = match get.get("k")?.as_str() {
        "task" => Subject::Task {
            page_id: get.get("p")?.parse().ok()?,
            ordinal: get.get("o")?.parse().ok()?,
            text: get.get("t")?.clone(),
        },
        "briefing" => Subject::Briefing,
        "focus" => Subject::Focus,
        "update" => Subject::Update { version: get.get("v")?.clone() },
        _ => return None,
    };
    Some((subject, act))
}

/// The address among command-line arguments (Windows starts Arcalo with it).
pub fn from_args<S: AsRef<str>>(args: &[S]) -> Option<(Subject, Act)> {
    args.iter().find_map(|a| parse_url(a.as_ref()))
}

/// Whether `arg` is such an address (a restart must not repeat the click).
pub fn is_activation(arg: &std::ffi::OsStr) -> bool {
    arg.to_str().is_some_and(|a| a.starts_with(SCHEME))
}

// ------------------------------------------------------------------ snooze

/// When a snoozed reminder comes back.
pub fn snooze_until<Tz: TimeZone>(act: Act, now: DateTime<Tz>) -> Option<DateTime<Utc>> {
    let at = match act {
        Act::Snooze10 => now.clone() + TimeDelta::minutes(10),
        Act::Snooze60 => now.clone() + TimeDelta::hours(1),
        Act::SnoozeTomorrow => {
            let morning = now.date_naive().succ_opt()?.and_time(NaiveTime::from_hms_opt(DUE_FROM.0, DUE_FROM.1, 0)?);
            now.timezone().from_local_datetime(&morning).earliest()?
        }
        _ => return None,
    };
    Some(at.with_timezone(&Utc))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Snoozed {
    pub note: Note,
    pub until: DateTime<Utc>,
}

pub fn snoozes(db: &Database) -> Vec<Snoozed> {
    db.meta_get(SNOOZES_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

fn save_snoozes(db: &Database, list: &[Snoozed]) -> Result<()> {
    db.meta_set(SNOOZES_KEY, &serde_json::to_string(list)?)
}

/// Stores `note` until `until`; an earlier snooze of the same subject is replaced.
pub fn snooze(db: &Database, note: Note, until: DateTime<Utc>) -> Result<()> {
    let mut list = snoozes(db);
    list.retain(|s| s.note.subject != note.subject);
    list.push(Snoozed { note, until });
    save_snoozes(db, &list)
}

fn unsnooze(db: &Database, subject: &Subject) -> Result<()> {
    let mut list = snoozes(db);
    let before = list.len();
    list.retain(|s| &s.note.subject != subject);
    if list.len() != before { save_snoozes(db, &list) } else { Ok(()) }
}

/// The reminders whose time has come (taken out of the list).
pub fn take_due(db: &Database, now: DateTime<Utc>) -> Result<Vec<Note>> {
    let (due, rest): (Vec<Snoozed>, Vec<Snoozed>) = snoozes(db).into_iter().partition(|s| s.until <= now);
    if !due.is_empty() {
        save_snoozes(db, &rest)?;
    }
    Ok(due.into_iter().map(|s| s.note).collect())
}

// ------------------------------------------------------------------ task reminders

#[derive(Debug, Default, Serialize, Deserialize)]
struct Reminded {
    day: String,
    keys: Vec<String>,
}

fn task_key(page_id: i64, text: &str) -> String {
    format!("{page_id}:{text}")
}

/// Open tasks due on `today` not announced yet today (and not snoozed); marks them announced.
pub fn due_tasks(db: &Database, today: &str) -> Result<Vec<Note>> {
    let filter = annalo_core::tasks::TaskFilter { due_before: Some(today.into()), ..Default::default() };
    let mut reminded: Reminded = db
        .meta_get(DUE_KEY)?
        .and_then(|s| serde_json::from_str(&s).ok())
        .filter(|r: &Reminded| r.day == today)
        .unwrap_or_default();
    reminded.day = today.into();
    let snoozed = snoozes(db);
    let mut out = vec![];
    for t in db.list_tasks(&filter)? {
        if t.done || t.due.as_deref() != Some(today) || out.len() >= DUE_MAX {
            continue;
        }
        let key = task_key(t.page_id, &t.text);
        let is_snoozed =
            snoozed.iter().any(|s| matches!(&s.note.subject, Subject::Task { page_id, text, .. } if *page_id == t.page_id && *text == t.text));
        if reminded.keys.contains(&key) || is_snoozed {
            continue;
        }
        reminded.keys.push(key);
        out.push(Note::task(t.page_id, t.ordinal, &t.text, &t.page_title));
    }
    if !out.is_empty() {
        db.meta_set(DUE_KEY, &serde_json::to_string(&reminded)?)?;
    }
    Ok(out)
}

/// Every ~30 s (with the other reminders): snoozed reminders that are due, and the tasks due
/// today from 09:00 on. `force`: regardless of the time of day (tests).
pub fn periodic_at(app: &AppHandle, now: DateTime<Local>, force: bool) {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let n = &settings.notifications;
    if n.is_quiet(now.time()) && !force {
        return;
    }
    let (back, due) = {
        let db = state.db();
        let back = take_due(&db, now.with_timezone(&Utc)).unwrap_or_default();
        // A task done meanwhile is not brought back.
        let open = |subject: &Subject| match subject {
            Subject::Task { page_id, text, .. } => {
                let f = annalo_core::tasks::TaskFilter { page_id: Some(*page_id), ..Default::default() };
                db.list_tasks(&f).is_ok_and(|ts| ts.iter().any(|t| !t.done && &t.text == text))
            }
            _ => true,
        };
        let back: Vec<Note> = back.into_iter().filter(|b| open(&b.subject)).collect();
        let from = NaiveTime::from_hms_opt(DUE_FROM.0, DUE_FROM.1, 0).unwrap_or_default();
        let due = if n.task_due && (force || now.time() >= from) {
            due_tasks(&db, &now.date_naive().to_string()).unwrap_or_else(|e| {
                crate::devlog::warn("notify", format!("due tasks not read: {e}"));
                vec![]
            })
        } else {
            vec![]
        };
        (back, due)
    };
    for note in back.into_iter().chain(due) {
        show(app, note);
    }
}

pub fn periodic(app: &AppHandle) {
    periodic_at(app, Local::now(), false);
}

/// A downloaded update: once per version (Settings → Benachrichtigungen „Updates“).
pub fn update_ready(app: &AppHandle, version: &str) {
    let state = app.state::<AppState>();
    if !state.settings().notifications.updates {
        return;
    }
    {
        let db = state.db();
        if db.meta_get(UPDATE_KEY).ok().flatten().as_deref() == Some(version) {
            return;
        }
        let _ = db.meta_set(UPDATE_KEY, version);
    }
    show(app, Note::update_ready(version));
}

// ------------------------------------------------------------------ showing

/// Shown notifications (newest last) for the test seam.
static SHOWN: Mutex<Vec<Note>> = Mutex::new(Vec::new());

fn test_mode() -> bool {
    cfg!(debug_assertions) && std::env::var_os(TEST_ENV).is_some()
}

/// Shows `note` with its buttons (held back during a focus session like every notification).
pub fn show(app: &AppHandle, note: Note) {
    // App-Sperre: a notification without content and without buttons (they would act unlocked).
    if crate::security::is_locked() {
        crate::devlog::debug("notify", "shown without content (locked)");
        if !test_mode() {
            let (title, body) = crate::security::locked_notification();
            crate::desktop::notify(app, title, body);
        }
        return;
    }
    if crate::focus::hold(app, &note.title, &note.body) {
        return;
    }
    crate::devlog::debug("notify", format!("shown: {}", url(&note.subject, note.click())));
    {
        let mut shown = lock(&SHOWN);
        if shown.len() >= 50 {
            shown.remove(0);
        }
        shown.push(note.clone());
    }
    if test_mode() {
        return;
    }
    #[cfg(target_os = "linux")]
    if linux::show(app, &note).is_ok() {
        return;
    }
    #[cfg(windows)]
    if win::show(app, &note).is_ok() {
        return;
    }
    plain(app, &note);
}

/// Title and text only (macOS, portable Windows, or when the richer way failed).
fn plain(app: &AppHandle, note: &Note) {
    let mut b = app.notification().builder().title(&note.title).body(&note.body);
    if note.silent {
        b = b.silent();
    }
    if let Err(e) = b.show() {
        crate::devlog::warn("notify", format!("notification failed: {e}"));
    }
}

/// The Windows toast: text, buttons and the click as protocol activations.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn toast_xml(note: &Note) -> String {
    fn esc(s: &str) -> String {
        s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
    }
    let audio = if note.silent { r#"<audio silent="true"/>"# } else { "" };
    let actions: String = note
        .actions()
        .into_iter()
        .map(|a| {
            format!(
                r#"<action content="{}" activationType="protocol" arguments="{}"/>"#,
                esc(a.label()),
                esc(&url(&note.subject, a))
            )
        })
        .collect();
    format!(
        r#"<toast activationType="protocol" launch="{}"><visual><binding template="ToastGeneric"><text>{}</text><text>{}</text></binding></visual>{audio}<actions>{actions}</actions></toast>"#,
        esc(&url(&note.subject, note.click())),
        esc(&note.title),
        esc(&note.body)
    )
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;

    /// Freedesktop notification with actions; a thread waits for the click or the close.
    pub fn show(app: &AppHandle, note: &Note) -> std::result::Result<(), String> {
        let mut n = notify_rust::Notification::new();
        n.appname("Arcalo").summary(&note.title).body(&note.body);
        // „default“: the click on the notification itself.
        n.action("default", note.click().label());
        for a in note.actions() {
            n.action(&url(&note.subject, a), a.label());
        }
        if note.silent {
            n.hint(notify_rust::Hint::SuppressSound(true));
        }
        let handle = n.show().map_err(|e| e.to_string())?;
        let (app, subject, click) = (app.clone(), note.subject.clone(), note.click());
        std::thread::spawn(move || {
            handle.wait_for_action(|id| {
                let hit = match id {
                    "default" => Some((subject, click)),
                    "__closed" => None,
                    other => parse_url(other),
                };
                if let Some((subject, act)) = hit {
                    activate(&app, subject, act, true);
                }
            })
        });
        Ok(())
    }
}

#[cfg(windows)]
mod win {
    use super::*;
    use windows::Data::Xml::Dom::XmlDocument;
    use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
    use windows::core::HSTRING;

    static REGISTERED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

    /// `arcalo-notify:` for this user, pointing at this program (installed copies only).
    pub fn register(exe: &std::path::Path) -> std::io::Result<()> {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hkcu.create_subkey(format!(r"Software\Classes\{SCHEME}"))?;
        key.set_value("", &"URL:Arcalo notification")?;
        key.set_value("URL Protocol", &"")?;
        let (cmd, _) = key.create_subkey(r"shell\open\command")?;
        cmd.set_value("", &format!("\"{}\" \"%1\"", exe.display()))?;
        REGISTERED.store(true, std::sync::atomic::Ordering::Relaxed);
        Ok(())
    }

    pub fn show(app: &AppHandle, note: &Note) -> windows::core::Result<()> {
        if !REGISTERED.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(windows::core::Error::from(windows::Win32::Foundation::E_FAIL));
        }
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(toast_xml(note)))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(app.config().identifier.as_str()))?
            .Show(&toast)
    }
}

/// At the start (Windows, installed copies): the scheme points at this program.
pub fn register(app: &AppHandle) {
    #[cfg(windows)]
    if !crate::portable::active() && std::env::var_os("ANNALO_DATA_DIR").is_none() {
        match tauri::process::current_binary(&app.env()) {
            Ok(exe) => {
                if let Err(e) = win::register(&exe) {
                    crate::devlog::warn("notify", format!("{SCHEME}: not registered: {e}"));
                }
            }
            Err(e) => crate::devlog::warn("notify", format!("{SCHEME}: no program path: {e}")),
        }
    }
    let _ = app;
}

// ------------------------------------------------------------------ handling a click

/// A click arrived (button, notification, Windows protocol activation). `ready`: the UI
/// listens already (false during a first start, then opening waits for it).
pub fn activate(app: &AppHandle, subject: Subject, act: Act, ready: bool) {
    // A button of a notification shown before the lock: only the lock screen.
    if crate::security::is_locked() {
        crate::desktop::show_main(app);
        return;
    }
    if let Err(e) = handle(app, &subject, act, ready) {
        crate::desktop::notify(app, tr!("Aktion fehlgeschlagen", "Action failed"), &e.to_string());
    }
}

/// [`dispatch`] with its outcome in the log.
fn handle(app: &AppHandle, subject: &Subject, act: Act, ready: bool) -> Result<String> {
    dispatch(app, subject, act, ready)
        .inspect(|what| crate::devlog::info("notify", format!("notification action: {what}")))
        .inspect_err(|e| {
            crate::devlog::warn("notify", format!("notification action {} failed: {}", act.id(), e.detail()))
        })
}

/// Runs `act` on `subject`; returns what was done (for the log).
pub fn dispatch(app: &AppHandle, subject: &Subject, act: Act, ready: bool) -> Result<String> {
    let state = app.state::<AppState>();
    match (subject, act) {
        (Subject::Task { page_id, ordinal, text }, Act::Done) => {
            {
                let db = state.db();
                db.set_task_done(*page_id, *ordinal, true, Some(text))?;
                unsnooze(&db, subject)?;
            }
            let _ = app.emit("data://tasks", *page_id);
            Ok(format!("task {page_id}/{ordinal} done"))
        }
        (Subject::Task { page_id, ordinal, text }, Act::Snooze10 | Act::Snooze60 | Act::SnoozeTomorrow) => {
            let until = snooze_until(act, Local::now()).ok_or_else(|| Error::State("snooze".into()))?;
            let title = state.reader().page(*page_id).map(|p| p.title).unwrap_or_default();
            snooze(&state.db(), Note::task(*page_id, *ordinal, text, &title), until)?;
            Ok(format!(
                "task {page_id}/{ordinal} snoozed until {}",
                until.with_timezone(&Local).format("%Y-%m-%d %H:%M")
            ))
        }
        (Subject::Task { page_id, .. }, _) => {
            crate::jumplist::run(app, crate::jumplist::Action::Page(*page_id), ready);
            Ok(format!("page {page_id} opened"))
        }
        (Subject::Briefing, _) => {
            crate::briefing::open(app, ready);
            Ok("briefing opened".into())
        }
        (Subject::Focus, Act::Extend) => {
            crate::focus::extend(app, 5.0)?;
            Ok("focus extended by 5 min".into())
        }
        (Subject::Focus, Act::Pause) => {
            crate::focus::take_break(app)?;
            Ok("focus break".into())
        }
        (Subject::Focus, _) => {
            crate::desktop::show_main(app);
            Ok("focus opened".into())
        }
        (Subject::Update { version }, Act::Restart) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let updates = app.state::<crate::updates::Updates>();
                if let Err(e) = crate::updates::update_restart_now(app.clone(), updates).await {
                    crate::devlog::warn("update", format!("restart from the notification: {e}"));
                    crate::desktop::show_main(&app);
                    let _ = app.emit("update://state", ());
                }
            });
            Ok(format!("update {version}: restart"))
        }
        (Subject::Update { version }, _) => Ok(format!("update {version}: later")),
    }
}

// ------------------------------------------------------------------ test seam

/// Debug builds with `ANNALO_NOTIFY_TEST`: `shown` (the notifications so far), `activate`
/// (`arg`: an address, as if clicked), `due_check` (the task reminders regardless of the
/// time), `tick` (`arg`: minutes ahead; snoozed reminders due by then come back), `snoozes`,
/// `show` (`arg`: `briefing` or `update`, a sample notification).
#[tauri::command]
pub fn notify_test(app: AppHandle, op: String, arg: Option<String>) -> Result<serde_json::Value> {
    if !test_mode() {
        return Err(Error::State("not available".into()));
    }
    let view = |n: &Note| {
        let actions: Vec<_> = n
            .actions()
            .into_iter()
            .map(|a| serde_json::json!({ "id": a.id(), "label": a.label(), "url": url(&n.subject, a) }))
            .collect();
        serde_json::json!({ "subject": n.subject, "title": n.title, "body": n.body, "click": url(&n.subject, n.click()), "actions": actions })
    };
    Ok(match op.as_str() {
        "shown" => lock(&SHOWN).iter().map(view).collect(),
        "activate" => {
            let (subject, act) =
                arg.as_deref().and_then(parse_url).ok_or_else(|| Error::State("bad address".into()))?;
            serde_json::Value::String(handle(&app, &subject, act, true)?)
        }
        "due_check" => {
            periodic_at(&app, Local::now(), true);
            serde_json::Value::Null
        }
        "tick" => {
            let minutes: i64 = arg.and_then(|a| a.parse().ok()).unwrap_or(0);
            periodic_at(&app, Local::now() + TimeDelta::minutes(minutes), false);
            serde_json::Value::Null
        }
        "snoozes" => serde_json::to_value(snoozes(&app.state::<AppState>().reader()))?,
        "show" => {
            match arg.as_deref() {
                Some("briefing") => show(&app, Note::briefing(tr!("3 Termine, 2 Aufgaben", "3 meetings, 2 tasks"))),
                Some("update") => show(&app, Note::update_ready("9.9.9")),
                _ => return Err(Error::State("unknown sample".into())),
            }
            serde_json::Value::Null
        }
        _ => return Err(Error::State(format!("unknown op {op}"))),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task() -> Subject {
        Subject::Task { page_id: 12, ordinal: 3, text: "Angebot & „Preis“ senden?".into() }
    }

    #[test]
    fn addresses_round_trip_for_every_button() {
        for subject in [task(), Subject::Briefing, Subject::Focus, Subject::Update { version: "1.10.1".into() }] {
            for act in ACTS {
                let u = url(&subject, act);
                assert!(u.starts_with("arcalo-notify:?a="), "{u}");
                assert!(!u.contains(' ') && !u.contains('"'), "{u}");
                assert_eq!(parse_url(&u), Some((subject.clone(), act)), "{u}");
            }
        }
        // Shells and browsers may add slashes after the scheme.
        let u = url(&Subject::Briefing, Act::Open).replace("arcalo-notify:", "arcalo-notify://");
        assert_eq!(parse_url(&u), Some((Subject::Briefing, Act::Open)));
        for bad in [
            "arcalo-notify:",
            "arcalo-notify:?a=nuke&k=task",
            "arcalo-notify:?a=done&k=task&p=x&o=1&t=a",
            "https://x",
            "arcalo-notify:?a=open&k=briefing&t=%zz",
        ] {
            assert_eq!(parse_url(bad), None, "{bad}");
        }
        let args = ["C:\\Arcalo\\arcalo.exe".to_string(), url(&task(), Act::Done)];
        assert_eq!(from_args(&args), Some((task(), Act::Done)));
        assert!(is_activation(std::ffi::OsStr::new(&args[1])) && !is_activation(std::ffi::OsStr::new("--minimized")));
    }

    #[test]
    fn each_kind_offers_its_buttons() {
        let ids = |n: Note| n.actions().into_iter().map(Act::id).collect::<Vec<_>>();
        assert_eq!(ids(Note::task(1, 0, "x", "P")), ["done", "snooze10", "snooze60", "snooze-tomorrow", "open"]);
        assert_eq!(ids(Note::briefing("b")), ["open"]);
        assert_eq!(ids(Note::focus_end("f".into())), ["extend", "pause", "open"]);
        assert_eq!(ids(Note::update_ready("2.0.0")), ["restart", "later"]);
        assert!(Note::focus_end("f".into()).silent);
        // The Windows toast: every button and the click activate the app by protocol.
        let xml = toast_xml(&Note::task(12, 3, "Angebot & „Preis“ senden?", "Kunde <X>"));
        assert_eq!(xml.matches(r#"activationType="protocol""#).count(), 6, "{xml}");
        assert!(xml.contains("Angebot &amp; „Preis“ senden?") && xml.contains("Kunde &lt;X&gt;"), "{xml}");
        assert!(xml.contains(&format!(r#"arguments="{}""#, url(&task(), Act::Done).replace('&', "&amp;"))), "{xml}");
        assert!(toast_xml(&Note::focus_end("f".into())).contains(r#"<audio silent="true"/>"#));
    }

    #[test]
    fn snooze_times() {
        let tz = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let now = tz.with_ymd_and_hms(2026, 10, 2, 16, 45, 0).unwrap();
        let at = |a| snooze_until(a, now).unwrap().with_timezone(&tz).format("%d. %H:%M").to_string();
        assert_eq!(at(Act::Snooze10), "02. 16:55");
        assert_eq!(at(Act::Snooze60), "02. 17:45");
        assert_eq!(at(Act::SnoozeTomorrow), "03. 09:00");
        assert_eq!(snooze_until(Act::Done, now), None);
    }

    #[test]
    fn snoozes_persist_replace_and_come_back_when_due() {
        let path = std::env::temp_dir().join(format!("annalo-snooze-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let t0 = Utc.with_ymd_and_hms(2026, 10, 2, 10, 0, 0).unwrap();
        {
            let db = Database::open(&path).unwrap();
            let note = Note::task(12, 3, "Angebot", "Kunde");
            snooze(&db, note.clone(), t0 + TimeDelta::minutes(10)).unwrap();
            // Snoozed again: one entry, the new time.
            snooze(&db, note, t0 + TimeDelta::hours(1)).unwrap();
            snooze(&db, Note::briefing("b"), t0 + TimeDelta::minutes(5)).unwrap();
            assert_eq!(snoozes(&db).len(), 2);
        }
        // A restart: the database is opened again.
        let db = Database::open(&path).unwrap();
        assert_eq!(snoozes(&db).len(), 2);
        let back = take_due(&db, t0 + TimeDelta::minutes(30)).unwrap();
        assert_eq!(back.iter().map(|n| n.subject.clone()).collect::<Vec<_>>(), [Subject::Briefing]);
        assert_eq!(snoozes(&db).len(), 1);
        assert!(take_due(&db, t0 + TimeDelta::minutes(59)).unwrap().is_empty());
        let back = take_due(&db, t0 + TimeDelta::hours(1)).unwrap();
        assert!(matches!(&back[0].subject, Subject::Task { page_id: 12, .. }));
        assert!(snoozes(&db).is_empty());
        unsnooze(&db, &Subject::Briefing).unwrap();
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn tasks_due_today_are_announced_once() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Kunde X", None).unwrap();
        db.save_page_content(p.id, "- [ ] Angebot due:2026-10-02 !\n- [ ] Morgen due:2026-10-03\n- [x] Fertig due:2026-10-02\n- [ ] Alt due:2026-09-01")
            .unwrap();
        let first = due_tasks(&db, "2026-10-02").unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].subject, Subject::Task { page_id: p.id, ordinal: 0, text: "Angebot".into() });
        assert!(first[0].body.contains("Kunde X"));
        assert!(due_tasks(&db, "2026-10-02").unwrap().is_empty(), "once a day");
        // A snoozed one is not announced again by the daily check.
        snooze(&db, Note::task(p.id, 1, "Morgen", ""), Utc::now() + TimeDelta::hours(1)).unwrap();
        assert!(due_tasks(&db, "2026-10-03").unwrap().is_empty());
        unsnooze(&db, &Subject::Task { page_id: p.id, ordinal: 1, text: "Morgen".into() }).unwrap();
        assert_eq!(due_tasks(&db, "2026-10-03").unwrap().len(), 1, "the next day starts fresh");
    }
}
