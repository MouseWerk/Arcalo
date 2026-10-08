//! Desktop integration: tray icon, close to tray, quick-capture window,
//! native reminders and autostart. The decisions live in `arcalo_core::desktop`;
//! this module only wires them to the window system.

use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use arcalo_core::calsync::tz::Zone;
use arcalo_core::capture::{self as cap, CaptureTarget, CaptureUndo, QueuedCapture};
use arcalo_core::desktop::{self as core, CaptureOutcome, CloseAction, Platform};
use arcalo_core::{Database, Error};
use chrono::{DateTime, Local, NaiveDate, TimeDelta, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_notification::NotificationExt;

use crate::{AppState, Result, lock};
use arcalo_core::{tr, trf};

/// Passed by the autostart entry: start hidden in the tray.
pub const MINIMIZED_ARG: &str = "--minimized";
pub const MAIN: &str = "main";
pub const CAPTURE: &str = "capture";
pub const SEARCH: &str = "search";

/// What a global shortcut does. The index is its slot in [`Desktop::shortcuts`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Capture = 0,
    Palette = 1,
    Search = 2,
    /// Quick capture with the selection or the clipboard text („Auswahl übernehmen“).
    Selection = 3,
    /// „Aktuelle E-Mail übernehmen“ (Outlook).
    Mail = 4,
    /// Sprachnotiz starten oder beenden.
    Voice = 5,
}

/// Number of global shortcut slots (one per [`Role`]).
pub const SLOTS: usize = 6;
const ROLES: [Role; SLOTS] = [Role::Capture, Role::Palette, Role::Search, Role::Selection, Role::Mail, Role::Voice];
/// The name of a shortcut's role (in messages about it).
fn role_name(i: usize) -> &'static str {
    match i {
        0 => tr!("Schnellerfassung", "Quick capture"),
        1 => tr!("Befehlspalette", "Command palette"),
        2 => tr!("Schnellsuche", "Quick search"),
        3 => tr!("Auswahl übernehmen", "Capture selection"),
        4 => tr!("E-Mail übernehmen", "Take over e-mail"),
        _ => tr!("Sprachnotiz", "Voice note"),
    }
}

#[derive(Clone)]
struct TrayHandles {
    tray: TrayIcon,
    /// „Timer stoppen“, „Timer pausieren“ and „Zuletzt verwendet starten“ (none while time
    /// tracking is off).
    timer: TimerItems,
    /// The menu was built for time tracking on (rebuilt when the setting changes).
    time: bool,
    /// The menu has „Aufnahme beenden“ (a voice note is being recorded).
    recording: bool,
    /// The menu was built for the app lock: only „Entsperren“ and „Beenden“.
    locked: bool,
}

#[derive(Default)]
pub struct Desktop {
    tray: Mutex<Option<TrayHandles>>,
    /// Registered global shortcuts by [`Role`]: capture, palette, search, selection, mail.
    shortcuts: Mutex<[Option<Shortcut>; SLOTS]>,
    /// A reminder was shown while the app was in the background: the next time the
    /// main window gets focus it opens the timesheet.
    pending_timesheet: AtomicBool,
    /// The last captures of this session (newest last), with what undo restores.
    captures: Mutex<Vec<(RecentCapture, CaptureUndo)>>,
    capture_seq: AtomicU64,
    /// When the capture window was asked to show, until its UI reports the first frame.
    capture_requested: Mutex<Option<Instant>>,
    /// Milliseconds from the request to the capture window's first frame, last time (0 = not yet).
    capture_open_ms: AtomicU64,
    /// The open popup (capture, search) was called up while another program had the focus: on
    /// macOS dismissing it hides Arcalo again, so that program gets the focus back.
    popup_from_other_app: AtomicBool,
    /// The capture window is created once the user is idle, not right after the start (the
    /// desktop portal hangs, see [`precreate_capture`]).
    capture_deferred: AtomicBool,
}

impl Desktop {
    pub fn has_tray(&self) -> bool {
        lock(&self.tray).is_some()
    }
}

fn desktop(app: &AppHandle) -> State<'_, Desktop> {
    app.state::<Desktop>()
}

pub fn show_main(app: &AppHandle) {
    // macOS: Arcalo may be hidden (a popup gave the focus back to another program).
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// --------------------------------------------------------------------- tray

/// The tray menu's entries in order (`-` is a separator): the timer entries only while time
/// tracking is on.
pub fn tray_entries(time: bool) -> Vec<&'static str> {
    let mut ids = vec!["open", "search", "briefing", "-"];
    if time {
        ids.extend(["stop", "pause", "resume"]);
    }
    ids.extend(["capture", "-", "quit"]);
    ids
}

/// The tray's timer entries: stop, pause/continue, start last used.
type TimerItems = Option<(MenuItem<Wry>, MenuItem<Wry>, MenuItem<Wry>)>;

fn pause_label(paused: bool) -> &'static str {
    if paused { tr!("Timer fortsetzen", "Resume timer") } else { tr!("Timer pausieren", "Pause timer") }
}

/// The tray menu in the current language for [`tray_entries`], with the timer entries
/// (disabled until `refresh_tray`).
fn tray_menu(app: &AppHandle, time: bool) -> tauri::Result<(Menu<Wry>, TimerItems)> {
    let menu = Menu::new(app)?;
    // App-Sperre: nothing that shows or changes notes.
    if crate::security::is_locked() {
        menu.append(&MenuItem::with_id(app, "unlock", tr!("Entsperren", "Unlock"), true, None::<&str>)?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(app, "quit", tr!("Beenden", "Quit"), true, None::<&str>)?)?;
        return Ok((menu, None));
    }
    let (mut stop, mut pause, mut resume) = (None, None, None);
    // Recording a voice note: the first entry stops it (never recording unnoticed).
    if crate::voice::is_recording(app) {
        menu.append(&MenuItem::with_id(
            app,
            "voice-stop",
            tr!("Aufnahme beenden", "Stop recording"),
            true,
            None::<&str>,
        )?)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    for id in tray_entries(time) {
        let label = match id {
            "-" => {
                menu.append(&PredefinedMenuItem::separator(app)?)?;
                continue;
            }
            "open" => tr!("Öffnen", "Open"),
            "search" => tr!("Suchen…", "Search…"),
            "briefing" => tr!("Morgen-Briefing", "Morning briefing"),
            "stop" => tr!("Timer stoppen", "Stop timer"),
            "pause" => pause_label(false),
            "resume" => tr!("Zuletzt verwendet starten", "Start last used"),
            "capture" => tr!("Schnellerfassung", "Quick capture"),
            _ => tr!("Beenden", "Quit"),
        };
        let timer = matches!(id, "stop" | "pause" | "resume");
        let item = MenuItem::with_id(app, id, label, !timer, None::<&str>)?;
        menu.append(&item)?;
        match id {
            "stop" => stop = Some(item),
            "pause" => pause = Some(item),
            "resume" => resume = Some(item),
            _ => {}
        }
    }
    Ok((menu, stop.zip(pause).zip(resume).map(|((a, b), c)| (a, b, c))))
}

fn time_tracking(app: &AppHandle) -> bool {
    app.try_state::<AppState>().is_none_or(|s| s.settings().time_tracking())
}

/// The display language changed: the tray menu, the macOS menu bar and the taskbar jump list
/// are built again in the new language.
pub fn relocalize(app: &AppHandle) {
    let handles = lock(&desktop(app).tray).clone();
    if let Some(t) = handles {
        let time = time_tracking(app);
        match tray_menu(app, time) {
            Ok((menu, timer)) => {
                let _ = t.tray.set_menu(Some(menu));
                let recording = crate::voice::is_recording(app);
                *lock(&desktop(app).tray) =
                    Some(TrayHandles { tray: t.tray, timer, time, recording, locked: crate::security::is_locked() });
            }
            Err(e) => crate::devlog::warn("desktop", format!("tray menu not rebuilt: {e}")),
        }
    }
    #[cfg(target_os = "macos")]
    match crate::appmenu::build(app) {
        Ok(menu) => {
            let _ = app.set_menu(menu);
        }
        Err(e) => crate::devlog::warn("desktop", format!("menu bar not rebuilt: {e}")),
    }
    refresh_tray(app);
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let time = time_tracking(app);
    let (menu, timer) = tray_menu(app, time)?;
    // macOS: a menu bar extra opens its menu on click (the Dock icon shows the window).
    let mac = cfg!(target_os = "macos");
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Arcalo")
        .show_menu_on_left_click(mac)
        .on_menu_event(on_menu)
        .on_tray_icon_event(move |tray, event| {
            if !mac
                && let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } =
                    event
            {
                show_main(tray.app_handle());
            }
        });
    if mac {
        // Monochrome template: macOS tints it for light/dark menu bars.
        builder = builder.icon(tauri::include_image!("icons/tray-template.png")).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    let tray = builder.build(app)?;
    let recording = crate::voice::is_recording(app);
    *lock(&desktop(app).tray) =
        Some(TrayHandles { tray, timer, time, recording, locked: crate::security::is_locked() });
    refresh_tray(app);
    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" | "unlock" => show_main(app),
        // A menu of before the lock (the tray is rebuilt right after locking).
        _ if crate::security::is_locked() && event.id().as_ref() != "quit" => show_main(app),
        // Left over from a menu built before time tracking was switched off.
        "stop" | "pause" | "resume" if !time_tracking(app) => {}
        // The UI stops the timer so it can ask about idle time first.
        "stop" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "tray://timer-stop", ());
        }
        "pause" => {
            let state = app.state::<AppState>();
            let paused = {
                let db = state.db();
                db.running_timer().ok().flatten().and_then(|e| db.pause_state(e.id).ok())
            };
            if let Some(p) = paused
                && let Err(e) = set_timer_paused(app, &state, p.paused_since.is_none())
            {
                notify(app, tr!("Timer nicht pausiert", "Timer not paused"), &e.to_string());
            }
        }
        "resume" => {
            if let Err(e) = resume_last(app) {
                notify(app, tr!("Timer nicht gestartet", "Timer not started"), &e.to_string());
            }
        }
        "capture" => open_capture(app, false),
        "voice-stop" => crate::voice::on_shortcut(app),
        "search" => open_search(app, false),
        "briefing" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "nav://briefing", ());
        }
        "quit" => request_quit(app),
        _ => {}
    }
}

/// Pauses (or continues) the running timer: the idle detection stops over the pause, the
/// tray and the windows learn about it.
pub fn set_timer_paused(app: &AppHandle, state: &AppState, paused: bool) -> Result<()> {
    let now = Utc::now();
    {
        let db = state.db();
        if paused {
            db.pause_timer(now)?
        } else {
            db.resume_timer(now)?
        };
    }
    lock(&state.idle).suspend(now);
    let _ = app.emit("data://entries", ());
    refresh_tray(app);
    Ok(())
}

/// Starts a timer on the Netzplan/Vorgang of the most recent entry.
fn resume_last(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    state.settings().require_time_tracking()?;
    {
        let db = state.db();
        let last = db
            .last_finished_entry()?
            .ok_or_else(|| Error::State(tr!("Noch keine Buchung vorhanden", "No time entry yet").into()))?;
        db.start_timer(
            last.netzplan_id,
            last.vorgang_nr.as_deref(),
            last.leistungsart.as_deref(),
            &last.description,
            Utc::now(),
        )?;
    }
    lock(&state.idle).reset();
    let _ = app.emit("data://entries", ());
    refresh_tray(app);
    Ok(())
}

/// Updates the tooltip (running timer) and which timer entry is enabled; rebuilds the menu
/// when time tracking was switched on or off.
pub fn refresh_tray(app: &AppHandle) {
    crate::jumplist::refresh(app);
    let Some(state) = app.try_state::<AppState>() else { return };
    let time = state.settings().time_tracking();
    rebuild_tray_menu(app, time);
    // Locked: the tooltip names no timer, task or recording.
    if crate::security::is_locked() {
        if let Some(t) = lock(&desktop(app).tray).clone() {
            let _ = t.tray.set_tooltip(Some(tr!("Arcalo – gesperrt", "Arcalo – locked")));
        }
        return;
    }
    if !time {
        // Nothing about a timer, also not one left running from before.
        if let Some(t) = lock(&desktop(app).tray).clone() {
            let tip = crate::voice::tray_tip(app, core::tray_tooltip(None));
            let _ = t.tray.set_tooltip(Some(crate::updates::tray_tip(app, tip)));
        }
        return;
    }
    let (running, has_last) = {
        let db = state.db();
        let running = db.running_timer().ok().flatten().map(|e| {
            let nr = db.netzplan_by_id(e.netzplan_id).map(|n| n.netzplan_nr).unwrap_or_default();
            let paused = db.pause_state(e.id).is_ok_and(|p| p.paused_since.is_some());
            let mut label = core::timer_label(&nr, e.vorgang_nr.as_deref());
            if paused {
                label = trf!("{label} (pausiert)", "{label} (paused)");
            }
            (label, db.timer_worked_minutes(&e, Utc::now()).unwrap_or(0), paused)
        });
        (running, db.last_finished_entry().ok().flatten().is_some())
    };
    // Cloned out of the lock: tray calls wait for the main thread, which may want the lock.
    let handles = lock(&desktop(app).tray).clone();
    let Some(t) = handles else { return };
    let tip = crate::voice::tray_tip(app, core::tray_tooltip(running.as_ref().map(|(l, m, _)| (l.as_str(), *m))));
    let _ = t.tray.set_tooltip(Some(crate::updates::tray_tip(app, tip)));
    if let Some((stop, pause, resume)) = &t.timer {
        let _ = stop.set_enabled(running.is_some());
        let _ = pause.set_enabled(running.is_some());
        let _ = pause.set_text(pause_label(running.as_ref().is_some_and(|r| r.2)));
        let _ = resume.set_enabled(running.is_none() && has_last);
    }
}

/// A new tray menu when the one shown was built for the other state of time tracking.
fn rebuild_tray_menu(app: &AppHandle, time: bool) {
    let Some(t) = lock(&desktop(app).tray).clone() else { return };
    let recording = crate::voice::is_recording(app);
    if t.time == time && t.recording == recording && t.locked == crate::security::is_locked() {
        return;
    }
    match tray_menu(app, time) {
        Ok((menu, timer)) => {
            if let Err(e) = t.tray.set_menu(Some(menu)) {
                crate::devlog::warn("desktop", format!("tray menu not rebuilt: {e}"));
                return;
            }
            if let Some(h) = lock(&desktop(app).tray).as_mut() {
                h.timer = timer;
                h.time = time;
                h.recording = recording;
                h.locked = crate::security::is_locked();
            }
        }
        Err(e) => crate::devlog::warn("desktop", format!("tray menu not rebuilt: {e}")),
    }
}

/// Asks the UI to store pending edits; it then calls `app_quit`.
pub fn request_quit(app: &AppHandle) {
    match app.get_webview_window(MAIN) {
        Some(_) => {
            let _ = app.emit_to(MAIN, "app://quit-requested", ());
        }
        None => app.exit(0),
    }
}

// ----------------------------------------------------------- window events

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let app = window.app_handle();
    match (window.label(), event) {
        (MAIN, WindowEvent::Focused(true)) => {
            if desktop(app).pending_timesheet.swap(false, Ordering::Relaxed) {
                let _ = app.emit_to(MAIN, "nav://timesheet", ());
            }
            crate::weekplan::on_focus(app);
            crate::dayreview::on_focus(app);
            crate::briefing::on_focus(app);
        }
        // Leaving the app: the taskbar jump list shows the latest pages on the next right-click.
        (MAIN, WindowEvent::Focused(false)) => crate::jumplist::refresh(app),
        // Without close-to-tray the UI destroys the main window; a hidden capture window
        // must not keep the process alive then. Closing it quits: a downloaded update installs.
        (MAIN, WindowEvent::Destroyed) => crate::updates::quit(app),
        #[cfg(any(windows, target_os = "macos"))]
        (CAPTURE | SEARCH, WindowEvent::Focused(false)) => {
            let _ = window.hide();
        }
        _ => {}
    }
}

/// Hides the main window to the tray (minimizes it when there is no tray icon). On macOS
/// it always hides: the Dock icon brings it back.
#[tauri::command]
pub fn window_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = match core::close_action(Platform::current(), true, desktop(&app).has_tray()) {
            CloseAction::Hide => w.hide(),
            CloseAction::Minimize | CloseAction::Quit => w.minimize(),
        };
    }
}

/// What closing the main window does (the UI stores the editors, then hides or quits).
#[tauri::command]
pub fn window_close_action(app: AppHandle, state: State<AppState>) -> CloseAction {
    let close_to_tray = state.settings().close_to_tray;
    core::close_action(Platform::current(), close_to_tray, desktop(&app).has_tray())
}

/// „Fenster schließen“ (macOS menu, ⇧⌘W): dismisses the popup in front, else closes the main
/// window the way its close button does (the UI stores the editors and hides it).
pub fn close_front_window(app: &AppHandle) {
    for label in [CAPTURE, SEARCH] {
        if app.get_webview_window(label).is_some_and(|w| w.is_focused().unwrap_or(false)) {
            hide_popup(app, label, true);
            return;
        }
    }
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.close();
    }
}

/// Quits after the UI has stored its edits.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    // A downloaded update is installed now (mode „automatisch“).
    crate::updates::quit(&app);
}

// ------------------------------------------------------------ quick capture

/// Shows the quick-capture window (created hidden at start, see [`precreate_capture`]).
/// `selection`: „Auswahl übernehmen“ – the window starts with the selection or clipboard text.
pub fn open_capture(app: &AppHandle, selection: bool) {
    // App-Sperre: the lock screen of the main window instead.
    if crate::security::is_locked() {
        show_main(app);
        return;
    }
    *lock(&desktop(app).capture_requested) = Some(Instant::now());
    // Creating a webview from an event handler can deadlock on Windows; build it elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = show_capture(&app, selection) {
            crate::devlog::error("desktop", format!("quick capture failed: {e}"));
        }
    });
}

const CAPTURE_POPUP: Popup =
    Popup { label: CAPTURE, title: "Schnellerfassung – Arcalo", size: (640.0, 148.0), transparent: true };

/// Creates the capture window hidden a moment after start, so the shortcut only has to show it
/// (created on first use it takes about half a second more).
///
/// Linux: creating a window reads the color scheme from the desktop portal on the main thread
/// (tao, up to 5 s). On a desktop whose portal hangs that froze the app right after it got ready,
/// so the portal is asked first, off the main thread: when it does not answer in time the window
/// is created once the user has been idle for a while ([`precreate_capture_when_idle`]), or on
/// first use, whichever comes first.
pub fn precreate_capture(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(1500));
        if !portal_answers() {
            crate::devlog::warn(
                "desktop",
                "the desktop portal does not answer: quick capture window prepared when idle",
            );
            desktop(&app).capture_deferred.store(true, Ordering::Relaxed);
            return;
        }
        prepare_capture(&app);
    });
}

fn prepare_capture(app: &AppHandle) {
    if app.get_webview_window(CAPTURE).is_none()
        && let Err(e) = popup_window(app, &CAPTURE_POPUP)
    {
        crate::devlog::warn("desktop", format!("quick capture window not prepared: {e}"));
    }
}

/// Idle this long before a deferred capture window is created (its main-thread pause then
/// meets nobody).
pub const CAPTURE_IDLE: Duration = Duration::from_secs(20);

/// Whether a deferred capture window is due: deferred, and no input for [`CAPTURE_IDLE`].
fn capture_due(deferred: bool, idle: Option<Duration>) -> bool {
    deferred && idle.is_some_and(|d| d >= CAPTURE_IDLE)
}

/// Called with the input idle time every few seconds (activity sampler).
pub fn precreate_capture_when_idle(app: &AppHandle, idle: Option<Duration>) {
    let d = desktop(app);
    if capture_due(d.capture_deferred.load(Ordering::Relaxed), idle) {
        d.capture_deferred.store(false, Ordering::Relaxed);
        let app = app.clone();
        // Not from the sampler's thread: building a webview there could deadlock on Windows.
        std::thread::spawn(move || prepare_capture(&app));
    }
}

/// How long the portal may take to refuse before it counts as hanging (tao waits 5 s).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const PORTAL_PATIENCE: Duration = Duration::from_millis(1000);

/// Whether the desktop portal answers the color-scheme read at once (an answer or a quick
/// refusal, such as no portal at all). Only a slow one blocks window creation.
#[cfg(target_os = "linux")]
fn portal_answers() -> bool {
    use dbus::arg::{RefArg, Variant};
    use dbus::blocking::Connection;
    let Ok(conn) = Connection::new_session() else { return true };
    let proxy =
        conn.with_proxy("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop", Duration::from_secs(5));
    let started = Instant::now();
    let res: std::result::Result<(Variant<Box<dyn RefArg>>,), dbus::Error> =
        proxy.method_call("org.freedesktop.portal.Settings", "Read", ("org.freedesktop.appearance", "color-scheme"));
    portal_fast(res.is_ok(), started.elapsed())
}

#[cfg(not(target_os = "linux"))]
fn portal_answers() -> bool {
    true
}

/// An answer counts however long it took (the portal runs now); an error only when it came quickly.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn portal_fast(answered: bool, took: Duration) -> bool {
    answered || took < PORTAL_PATIENCE
}

/// A small undecorated window above all others (quick capture, quick search), loading the
/// UI bundle with `#<label>`. Created hidden on first use, then only shown and hidden.
struct Popup {
    label: &'static str,
    title: &'static str,
    size: (f64, f64),
    /// Transparent background: the page draws a rounded panel (macOS: needs the
    /// `macos-private-api` feature, see Cargo.toml).
    transparent: bool,
}

fn popup_window(app: &AppHandle, p: &Popup) -> tauri::Result<tauri::WebviewWindow> {
    Ok(match app.get_webview_window(p.label) {
        Some(w) => w,
        None => {
            let b = WebviewWindowBuilder::new(app, p.label, WebviewUrl::App(format!("index.html#{}", p.label).into()))
                .title(p.title)
                .inner_size(p.size.0, p.size.1)
                .resizable(false)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .center()
                .visible(false)
                // Files dropped onto the page arrive as HTML drops (quick capture stores them).
                .disable_drag_drop_handler()
                .transparent(p.transparent);
            // No system shadow for the transparent popups; the panel has its own border. On
            // Windows 11 the shadow of an undecorated window comes with a thin frame around the
            // whole rectangle, which showed as a second edge around the rounded panel; on macOS
            // it is computed from the content and can stay a rectangle or the old size.
            let b = b.shadow(!p.transparent);
            // On every Space, also over a full-screen app (see `macos::float_over_spaces`).
            #[cfg(target_os = "macos")]
            let b = b.visible_on_all_workspaces(true);
            // Portable: the same webview profile as the main window, in the data folder.
            let webview_dir =
                app.try_state::<crate::AppState>().and_then(|s| crate::portable::webview_dir(&s.data_dir));
            let b = match webview_dir {
                Some(dir) => b.data_directory(dir),
                None => b,
            };
            let w = b.build()?;
            #[cfg(target_os = "macos")]
            macos::float_over_spaces(&w);
            w
        }
    })
}

/// Whether one of Arcalo's windows has the keyboard focus (Arcalo is the active program).
fn app_focused(app: &AppHandle) -> bool {
    app.webview_windows().values().any(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
}

/// Hides a popup. `dismissed` (Esc, stored, its shortcut again): on macOS a popup called up from
/// another program then hides Arcalo too, so that program gets the focus back.
/// Hides quick capture and quick search (the app locks).
pub fn hide_popups(app: &AppHandle) {
    for label in [CAPTURE, SEARCH] {
        hide_popup(app, label, false);
    }
}

fn hide_popup(app: &AppHandle, label: &str, dismissed: bool) {
    let Some(w) = app.get_webview_window(label) else { return };
    let focused = dismissed && w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false);
    let _ = w.hide();
    let from_other = desktop(app).popup_from_other_app.swap(false, Ordering::Relaxed);
    let hide_app = core::hide_app_after_popup(Platform::current(), from_other, focused);
    #[cfg(target_os = "macos")]
    if hide_app {
        let _ = app.hide();
    }
    #[cfg(not(target_os = "macos"))]
    let _ = hide_app;
}

fn show_popup(app: &AppHandle, p: &Popup) -> tauri::Result<tauri::WebviewWindow> {
    let w = popup_window(app, p)?;
    // Called up from another program (not when the popup is already in front).
    if !(w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false)) {
        desktop(app).popup_from_other_app.store(!app_focused(app), Ordering::Relaxed);
    }
    // macOS: Arcalo may be hidden (an earlier popup gave the focus back); the window must
    // appear and take the keyboard focus from the program in front.
    #[cfg(target_os = "macos")]
    let _ = app.show();
    center_on_primary(app, &w);
    w.show()?;
    w.set_focus()?;
    // Windows may refuse the foreground to a window shown from the background (focus-stealing
    // rules): ask again a few times until it has the focus.
    let retry = w.clone();
    std::thread::spawn(move || {
        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(70));
            if !retry.is_visible().unwrap_or(false) || retry.is_focused().unwrap_or(true) {
                break;
            }
            let _ = retry.set_focus();
        }
    });
    Ok(w)
}

/// Puts a popup in the middle of the primary screen (the main display), whatever screen the
/// main window is on. The popup first moves onto that screen, so its size follows the screen's
/// scaling before it is centred. Falls back to the current screen when there is none.
fn center_on_primary(app: &AppHandle, w: &tauri::WebviewWindow) {
    let Ok(Some(m)) = app.primary_monitor() else {
        let _ = w.center();
        return;
    };
    let (pos, size) = (m.position(), m.size());
    let _ = w.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));
    let Ok(outer) = w.outer_size() else {
        let _ = w.center();
        return;
    };
    let (x, y) = core::centered_in((pos.x, pos.y, size.width, size.height), (outer.width, outer.height));
    let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Payload of `capture://shown`.
#[derive(Clone, Serialize)]
struct CaptureShown {
    /// Opened by „Auswahl übernehmen“: `clipboard` goes into the field.
    selection: bool,
    /// The selection (X11) or the clipboard text at open time; offered as „Zwischenablage einfügen“.
    clipboard: Option<String>,
}

fn show_capture(app: &AppHandle, selection: bool) -> tauri::Result<()> {
    show_popup(app, &CAPTURE_POPUP)?;
    let clipboard = clipboard_text(selection);
    let _ = app.emit_to(CAPTURE, "capture://shown", CaptureShown { selection, clipboard });
    Ok(())
}

/// The text to take over: with `selection` on X11 the current selection (PRIMARY), else the
/// clipboard. At most 20 000 characters; `None` when empty or not text.
fn clipboard_text(selection: bool) -> Option<String> {
    let mut cb = arboard::Clipboard::new().ok()?;
    #[cfg(all(unix, not(target_os = "macos")))]
    if selection {
        use arboard::{GetExtLinux, LinuxClipboardKind};
        if let Ok(t) = cb.get().clipboard(LinuxClipboardKind::Primary).text()
            && !t.trim().is_empty()
        {
            return Some(t.chars().take(20_000).collect());
        }
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    let _ = selection;
    let t = cb.get_text().ok()?;
    (!t.trim().is_empty()).then(|| t.chars().take(20_000).collect())
}

/// Esc, or the capture was stored.
#[tauri::command]
pub fn capture_hide(app: AppHandle) {
    hide_popup(&app, CAPTURE, true);
}

/// Opens the capture window (command palette, tests).
#[tauri::command]
pub fn capture_show(app: AppHandle) {
    open_capture(&app, false);
}

/// The capture window painted its first frame after `capture://shown`: records how long the
/// shortcut took (Settings → Desktop, developer log).
#[tauri::command]
pub fn capture_ready(app: AppHandle) {
    let d = desktop(&app);
    if let Some(t) = lock(&d.capture_requested).take() {
        let ms = t.elapsed().as_millis() as u64;
        d.capture_open_ms.store(ms.max(1), Ordering::Relaxed);
        crate::devlog::debug("desktop", format!("quick capture shown after {ms} ms"));
    }
}

// ------------------------------------------------------------- quick search

/// Shows the quick-search window; with `toggle` (the global shortcut) a search window that is
/// already in front is hidden instead.
pub fn open_search(app: &AppHandle, toggle: bool) {
    if crate::security::is_locked() {
        show_main(app);
        return;
    }
    // Creating a webview from an event handler can deadlock on Windows; build it elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        if toggle
            && let Some(w) = app.get_webview_window(SEARCH)
            && w.is_visible().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
        {
            hide_popup(&app, SEARCH, true);
            return;
        }
        let popup = Popup { label: SEARCH, title: "Suchen – Arcalo", size: (640.0, 420.0), transparent: true };
        if let Err(e) = show_popup(&app, &popup) {
            crate::devlog::error("desktop", format!("quick search failed: {e}"));
        }
    });
}

/// Esc in the quick search.
#[tauri::command]
pub fn search_hide(app: AppHandle) {
    hide_popup(&app, SEARCH, true);
}

/// What the quick search asks the main window to open (event `search://open`).
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SearchTarget {
    Page {
        page_id: i64,
        #[serde(default)]
        new_tab: bool,
    },
    Timesheet,
    /// The main window stops the timer (it asks about idle time first).
    TimerStop,
    /// The Issues page (Jira).
    Issues,
    /// The note of an issue (`PROJ-123` typed into the quick search).
    Issue {
        key: String,
    },
    /// The graph view.
    Graph,
}

/// Hides the quick search, brings the main window to the front and lets it open `target`.
#[tauri::command]
pub fn search_open(app: AppHandle, target: SearchTarget) {
    hide_popup(&app, SEARCH, false);
    show_main(&app);
    let _ = app.emit_to(MAIN, "search://open", target);
}

/// Starts a timer on the most recently booked Netzplan/Vorgang („Zuletzt verwendet starten“).
#[tauri::command]
pub fn timer_resume_last(app: AppHandle) -> Result<()> {
    resume_last(&app)
}

/// A capture in the recent list of the capture window.
#[derive(Clone, Debug, Serialize)]
pub struct RecentCapture {
    pub id: u64,
    pub at: DateTime<Utc>,
    /// The page that received the text (`None`: only bookings).
    pub page_id: Option<i64>,
    /// Page title, or „Zeiterfassung“.
    pub title: String,
    /// The first line of the text.
    pub preview: String,
    pub bookings: usize,
    /// Undo (Ctrl+Z) works until then.
    pub undo_until: DateTime<Utc>,
}

/// What `capture_submit` returns: the outcome, and whether it waits in the queue instead.
#[derive(Serialize)]
pub struct Submitted {
    #[serde(flatten)]
    outcome: CaptureOutcome,
    /// The id in the recent list (undo).
    id: Option<u64>,
    /// The database could not take it now: it is stored and retried.
    queued: bool,
}

/// Recent captures kept for the capture window.
const RECENT: usize = 5;

/// Payload of `capture://stored` (main window: tree, open editors, toasts).
#[derive(Clone, Serialize)]
struct Stored {
    page_id: i64,
    title: String,
    created: bool,
    /// Stored from the queue, after an earlier failure.
    late: bool,
}

fn capture_options<'a>(settings: &'a arcalo_core::settings::Settings, zone: &'a Zone) -> cap::CaptureOptions<'a> {
    cap::CaptureOptions {
        inbox_title: &settings.capture.inbox_title,
        thresholds: &settings.thresholds,
        zone,
        book_time: settings.time_tracking(),
    }
}

/// Tells the windows what a capture changed.
fn announce(app: &AppHandle, out: &CaptureOutcome, late: bool) {
    if !out.bookings.is_empty() {
        let _ = app.emit("data://entries", ());
        refresh_tray(app);
    }
    if let Some(a) = &out.appended {
        // Open editors of the page reload; task lists refresh.
        let _ = app.emit("data://tasks", a.page_id);
        let stored = Stored { page_id: a.page_id, title: a.title.clone(), created: a.created, late };
        let _ = app.emit_to(MAIN, "capture://stored", stored);
    }
}

/// Test builds: `ARCALO_TEST_CAPTURE_BUSY=n` makes the first n captures fail as if the database
/// were locked (the queue is tested end to end with it).
fn simulated_busy() -> Option<Error> {
    #[cfg(debug_assertions)]
    {
        static LEFT: std::sync::OnceLock<std::sync::atomic::AtomicI64> = std::sync::OnceLock::new();
        let left = LEFT.get_or_init(|| {
            std::sync::atomic::AtomicI64::new(
                std::env::var("ARCALO_TEST_CAPTURE_BUSY").ok().and_then(|v| v.parse().ok()).unwrap_or(0),
            )
        });
        if left.fetch_sub(1, Ordering::Relaxed) > 0 {
            return Some(cap::busy_error());
        }
    }
    None
}

/// Books `/zeit` lines and puts everything else into `target` (default: today's daily note).
/// When the database cannot take it now (busy, storage), the capture is queued and retried.
#[tauri::command]
pub fn capture_submit(
    app: AppHandle,
    state: State<AppState>,
    text: String,
    target: Option<CaptureTarget>,
) -> Result<Submitted> {
    let settings = state.settings();
    let target = target.unwrap_or_default();
    let now = Utc::now();
    let zone = Zone::Local;
    let result = match simulated_busy() {
        Some(e) => Err(e),
        None => cap::capture_to(&state.db(), &text, &target, &capture_options(&settings, &zone), now, &Local),
    };
    match result {
        Ok((out, undo)) => {
            announce(&app, &out, false);
            let id = remember(&app, &text, &out, undo, now);
            Ok(Submitted { outcome: out, id: Some(id), queued: false })
        }
        Err(e) if cap::is_retryable(&e) => {
            let path = state.data_dir.join(cap::QUEUE_FILE);
            let mut queue = cap::load_queue(&path);
            queue.push(QueuedCapture { text, target, at: now, attempts: 1, error: e.to_string() });
            // Not even the queue file can be written: the window keeps the text and shows why.
            cap::save_queue(&path, &queue)?;
            crate::devlog::warn("desktop", format!("capture queued: {e}"));
            let _ = app.emit_to(MAIN, "capture://queued", e.to_string());
            schedule_retry(&app, Duration::from_secs(5));
            Ok(Submitted { outcome: CaptureOutcome { appended: None, bookings: vec![] }, id: None, queued: true })
        }
        Err(e) => Err(e),
    }
}

fn remember(app: &AppHandle, text: &str, out: &CaptureOutcome, undo: CaptureUndo, now: DateTime<Utc>) -> u64 {
    let d = desktop(app);
    let id = d.capture_seq.fetch_add(1, Ordering::Relaxed) + 1;
    let preview: String = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("").chars().take(90).collect();
    let recent = RecentCapture {
        id,
        at: now,
        page_id: out.appended.as_ref().map(|a| a.page_id),
        title: out
            .appended
            .as_ref()
            .map_or_else(|| tr!("Zeiterfassung", "Time tracking").to_owned(), |a| a.title.clone()),
        preview,
        bookings: out.bookings.len(),
        undo_until: now + TimeDelta::seconds(cap::UNDO_SECONDS),
    };
    let mut list = lock(&d.captures);
    list.push((recent, undo));
    let extra = list.len().saturating_sub(RECENT);
    list.drain(..extra);
    id
}

/// Retries the queued captures once after `delay` (the periodic tick retries too).
fn schedule_retry(app: &AppHandle, delay: Duration) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        retry_queue(&app);
    });
}

static RETRYING: AtomicBool = AtomicBool::new(false);

/// Stores queued captures. One whose page is gone goes to the inbox instead; one that cannot be
/// stored at all (a bad `/zeit` line) is reported with its full text, so nothing is lost silently.
pub fn retry_queue(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let path = state.data_dir.join(cap::QUEUE_FILE);
    if !path.exists() || RETRYING.swap(true, Ordering::Relaxed) {
        return;
    }
    let settings = state.settings();
    let zone = Zone::Local;
    let opts = capture_options(&settings, &zone);
    let mut left = vec![];
    for mut q in cap::load_queue(&path) {
        let first = cap::capture_to(&state.db(), &q.text, &q.target, &opts, q.at, &Local);
        let result = match first {
            Err(e) if !cap::is_retryable(&e) && !matches!(q.target, CaptureTarget::Inbox | CaptureTarget::Daily) => {
                cap::capture_to(&state.db(), &q.text, &CaptureTarget::Inbox, &opts, q.at, &Local)
            }
            other => other,
        };
        match result {
            Ok((out, undo)) => {
                announce(app, &out, true);
                remember(app, &q.text, &out, undo, q.at);
            }
            Err(e) if cap::is_retryable(&e) => {
                q.attempts += 1;
                q.error = e.to_string();
                left.push(q);
            }
            Err(e) => {
                crate::devlog::error("desktop", format!("queued capture not stored: {e}"));
                let _ = app.emit_to(MAIN, "capture://failed", (e.to_string(), q.text.clone()));
            }
        }
    }
    if let Err(e) = cap::save_queue(&path, &left) {
        crate::devlog::error("desktop", format!("capture queue not written: {e}"));
    }
    RETRYING.store(false, Ordering::Relaxed);
}

/// The appointment offered as target in the capture window.
#[derive(Serialize)]
pub struct MeetingTarget {
    key: String,
    title: String,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    note_page_id: Option<i64>,
}

/// What the capture window shows when it opens.
#[derive(Serialize)]
pub struct CaptureContext {
    meeting: Option<MeetingTarget>,
    recent: Vec<RecentCapture>,
    /// Captures waiting in the queue.
    queued: usize,
}

#[tauri::command(async)]
pub fn capture_context(app: AppHandle, state: State<AppState>) -> Result<CaptureContext> {
    let settings = state.settings();
    let meeting = if settings.capture.meeting_target {
        // Own calendars only by default: a colleague's meeting is not the one running for the user.
        let active = settings.calendar.booking_sources(arcalo_core::calsync::outlook::available());
        cap::current_meeting(&state.reader(), Utc::now(), &active)?.map(|e| MeetingTarget {
            key: e.key,
            title: e.event.title,
            start: e.event.start,
            end: e.event.end,
            note_page_id: e.note_page_id,
        })
    } else {
        None
    };
    let recent = lock(&desktop(&app).captures).iter().rev().map(|(r, _)| r.clone()).collect();
    let queued = cap::load_queue(&state.data_dir.join(cap::QUEUE_FILE)).len();
    Ok(CaptureContext { meeting, recent, queued })
}

/// Undoes the newest capture within [`cap::UNDO_SECONDS`]; returns it.
#[tauri::command]
pub fn capture_undo(app: AppHandle, state: State<AppState>) -> Result<RecentCapture> {
    let d = desktop(&app);
    let (recent, undo) = {
        let list = lock(&d.captures);
        let last = list.last().cloned();
        last.filter(|(r, _)| Utc::now() <= r.undo_until).ok_or_else(|| {
            Error::State(trf!(
                "Nur die letzte Erfassung der letzten {} s lässt sich rückgängig machen",
                "Only the last capture of the last {} s can be undone",
                cap::UNDO_SECONDS
            ))
        })?
    };
    cap::undo_capture(&state.db(), &undo)?;
    {
        // One step only: the captures before it stay (Ctrl+Z again does not reach them).
        let mut list = lock(&d.captures);
        list.retain(|(r, _)| r.id != recent.id);
        let now = Utc::now();
        for (r, _) in list.iter_mut() {
            r.undo_until = r.undo_until.min(now);
        }
    }
    if !undo.entry_ids.is_empty() {
        let _ = app.emit("data://entries", ());
        refresh_tray(&app);
    }
    if let Some(p) = &undo.page {
        let _ = app.emit("data://tasks", p.page_id);
        let _ = app.emit_to(MAIN, "capture://undone", (p.page_id, p.created));
    }
    Ok(recent)
}

/// Hides the capture window and opens `page_id` in the main window („Gespeichert in …“).
#[tauri::command]
pub fn capture_open(app: AppHandle, page_id: i64) {
    hide_popup(&app, CAPTURE, false);
    show_main(&app);
    let _ = app.emit_to(MAIN, "search://open", SearchTarget::Page { page_id, new_tab: false });
}

/// Applies the global shortcuts by [`Role`]; `None` keeps a slot as it is, `Some("")` switches
/// it off. New shortcuts are registered before the old ones are released, so a failure (e.g. the
/// combination belongs to another program) keeps the previous shortcuts working. A shortcut
/// that moves between slots (swap) stays registered and only changes its role.
pub fn apply_shortcuts(app: &AppHandle, specs: [Option<&str>; SLOTS]) -> std::result::Result<(), String> {
    let d = desktop(app);
    let old = *lock(&d.shortcuts);
    let mut new = old;
    for (slot, spec) in new.iter_mut().zip(specs) {
        match spec.map(str::trim) {
            None => {}
            Some("") => *slot = None,
            Some(s) => *slot = Some(parse_shortcut(s)?),
        }
    }
    check_distinct(&new)?;
    let gs = app.global_shortcut();
    let mut added: Vec<Shortcut> = Vec::new();
    // The slot lock is not held while (un)registering: the shortcut handler reads it.
    for sc in new.into_iter().flatten() {
        if old.contains(&Some(sc)) || added.contains(&sc) {
            continue;
        }
        if let Err(e) = gs.register(sc) {
            for a in added {
                let _ = gs.unregister(a);
            }
            return Err(trf!(
                "Tastenkürzel „{}“ ist nicht verfügbar: {e}",
                "The shortcut “{}” is not available: {e}",
                sc.into_string()
            ));
        }
        added.push(sc);
    }
    for sc in old.into_iter().flatten() {
        if !new.contains(&Some(sc)) {
            let _ = gs.unregister(sc);
        }
    }
    *lock(&d.shortcuts) = new;
    Ok(())
}

fn check_distinct(slots: &[Option<Shortcut>; SLOTS]) -> std::result::Result<(), String> {
    for i in 0..slots.len() {
        for j in i + 1..slots.len() {
            if slots[i].is_some() && slots[i] == slots[j] {
                return Err(trf!(
                    "{} und {} brauchen verschiedene Tastenkürzel",
                    "{} and {} need different shortcuts",
                    role_name(i),
                    role_name(j)
                ));
            }
        }
    }
    Ok(())
}

/// Checks the shortcuts of the settings (capture, palette, search, selection, mail; `""` = off) before saving.
pub fn validate_shortcuts(specs: [&str; SLOTS]) -> std::result::Result<(), String> {
    let mut parsed = [None; SLOTS];
    for (slot, spec) in parsed.iter_mut().zip(specs) {
        if !spec.trim().is_empty() {
            *slot = Some(parse_shortcut(spec)?);
        }
    }
    check_distinct(&parsed)
}

/// Parses `Ctrl+Shift+K`-style shortcuts (`Cmd`, `Command`, `Super`, `Meta` and `Win` all
/// mean the Command/Windows key). Combinations that type characters are refused, since the
/// global shortcut would swallow them: Ctrl+Alt is AltGr on German keyboards (`@`, `€`, `{` …),
/// on macOS Option without Cmd/Ctrl types them (⌥L = `@`).
pub fn parse_shortcut(spec: &str) -> std::result::Result<Shortcut, String> {
    parse_shortcut_for(spec, cfg!(target_os = "macos"))
}

fn parse_shortcut_for(spec: &str, mac: bool) -> std::result::Result<Shortcut, String> {
    let spec = spec.trim();
    // The plugin knows Cmd/Command/Super; other recorders write Meta or Win.
    let normalized = spec
        .split('+')
        .map(|t| match t.trim().to_ascii_lowercase().as_str() {
            "meta" | "win" => "Super",
            _ => t.trim(),
        })
        .collect::<Vec<_>>()
        .join("+");
    let sc = Shortcut::from_str(&normalized)
        .map_err(|e| trf!("Tastenkürzel „{spec}“ ungültig: {e}", "The shortcut “{spec}” is invalid: {e}"))?;
    if mac {
        if sc.mods.contains(Modifiers::ALT) && !sc.mods.intersects(Modifiers::CONTROL | Modifiers::SUPER) {
            return Err(trf!(
                "Tastenkürzel „{spec}“ nicht möglich: ⌥ ohne ⌘ oder Ctrl tippt Zeichen wie @ oder €",
                "The shortcut “{spec}” is not possible: ⌥ without ⌘ or Ctrl types characters like @ or €"
            ));
        }
    } else if sc.mods.contains(Modifiers::CONTROL | Modifiers::ALT) {
        return Err(trf!(
            "Tastenkürzel „{spec}“ nicht möglich: Strg+Alt entspricht AltGr und wird zum Tippen von Zeichen wie @ oder € gebraucht",
            "The shortcut “{spec}” is not possible: Ctrl+Alt is AltGr, which types characters like @ or €"
        ));
    }
    Ok(sc)
}

/// The role of a registered global shortcut.
pub fn shortcut_role(app: &AppHandle, shortcut: &Shortcut) -> Option<Role> {
    let d = app.try_state::<Desktop>()?;
    let slots = *lock(&d.shortcuts);
    ROLES.into_iter().find(|r| slots[*r as usize].as_ref() == Some(shortcut))
}

// -------------------------------------------------------------------- macOS

#[cfg(target_os = "macos")]
mod macos {
    use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

    /// Lets a popup appear on the current Space, also above a full-screen app, instead of
    /// switching to the desktop Space it was created on. (Tauri only offers „all Spaces“.)
    pub fn float_over_spaces(w: &tauri::WebviewWindow) {
        let Ok(ptr) = w.ns_window() else { return };
        // The pointer is not `Send`; the window lives as long as the app (popups are only hidden).
        let ptr = ptr as usize;
        let _ = w.run_on_main_thread(move || {
            // SAFETY: `ptr` is the popup's live NSWindow, used on the main thread.
            let ns = unsafe { &*(ptr as *const NSWindow) };
            ns.setCollectionBehavior(
                ns.collectionBehavior()
                    | NSWindowCollectionBehavior::CanJoinAllSpaces
                    | NSWindowCollectionBehavior::FullScreenAuxiliary,
            );
        });
    }
}

// ---------------------------------------------------------------- reminders

pub fn notify(app: &AppHandle, title: &str, body: &str) {
    // Locked: nothing about the content (timer, task, page) on the screen.
    let (title, body) =
        if crate::security::is_locked() { crate::security::locked_notification() } else { (title, body) };
    // Held back during a focus session and shown in its summary.
    if crate::focus::hold(app, title, body) {
        return;
    }
    if crate::notifyact::packaged_plain(app, title, body, false) {
        return;
    }
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::devlog::warn("desktop", format!("notification failed: {e}"));
    }
}

fn meta_date(db: &Database, key: &str) -> Option<NaiveDate> {
    db.meta_get(key).ok().flatten().and_then(|s| s.parse().ok())
}

/// Minutes booked today (local time), including a running timer.
fn booked_today(db: &Database) -> Result<i64> {
    let now = Utc::now();
    let midnight = Local::now().date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
    let from = Local.from_local_datetime(&midnight).earliest().map(|d| d.with_timezone(&Utc));
    let filter = arcalo_core::db::EntryFilter { from, to: Some(now + TimeDelta::days(1)), ..Default::default() };
    let booked: i64 = db.list_time_entries(&filter)?.iter().filter_map(|r| r.entry.duration_minutes).sum();
    let running = match db.running_timer()? {
        Some(e) => db.timer_worked_minutes(&e, now)?,
        None => 0,
    };
    Ok(booked + running)
}

/// Called every ~30 s: tray tooltip and reminder notifications.
pub fn periodic(app: &AppHandle) {
    refresh_tray(app);
    crate::focus::periodic(app);
    retry_queue(app);
    let state = app.state::<AppState>();
    let settings = state.settings();
    let now = Local::now().naive_local();
    let today = now.date().to_string();
    // Time tracking off: no reminder about unbooked hours or a running timer (the day review
    // reminder below stays; the week proposal checks the setting itself).
    let time = settings.time_tracking();
    let (eod, late) = if !time {
        (None, None)
    } else {
        let db = state.db();
        // Today's target: the weekday's, none on a public holiday or absence day, half on a half one.
        let base = (settings.daily_target_hours.max(0.0) * 60.0).round() as i64;
        let target = arcalo_core::worktime::gap_target(&db, now.date(), base).unwrap_or(base);
        let eod = booked_today(&db).ok().and_then(|booked| {
            core::end_of_day_reminder(now, &settings, booked, target, meta_date(&db, "reminder.day"))
        });
        let running = db.running_timer().ok().flatten();
        let since = running.as_ref().map(|e| e.start_time.with_timezone(&Local).naive_local());
        let n = &settings.notifications;
        let late_allowed = n.late_timer && !n.is_quiet(now.time());
        let late =
            (late_allowed && core::late_timer_reminder(now, since, meta_date(&db, "late_timer.day"))).then(|| {
                let e = running.as_ref().expect("late reminder implies a running timer");
                let nr = db.netzplan_by_id(e.netzplan_id).map(|n| n.netzplan_nr).unwrap_or_default();
                let local = e.start_time.with_timezone(&Local);
                // Left running from an earlier day: the date says so.
                let start = local.format(match (local.date_naive() < now.date(), arcalo_core::i18n::is_en()) {
                    (true, false) => "%d.%m. %H:%M",
                    (true, true) => "%b %-d, %H:%M",
                    (false, _) => "%H:%M",
                });
                trf!(
                    "{} läuft seit {start} Uhr – stoppen nicht vergessen.",
                    "{} has been running since {start} – remember to stop it.",
                    core::timer_label(&nr, e.vorgang_nr.as_deref())
                )
            });
        if eod.is_some() {
            let _ = db.meta_set("reminder.day", &today);
        }
        if late.is_some() {
            let _ = db.meta_set("late_timer.day", &today);
        }
        (eod, late)
    };
    if let Some(msg) = eod {
        notify(app, &msg, tr!("Zur Zeiterfassung: Arcalo öffnen", "To time tracking: open Arcalo"));
        let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
        if !focused {
            desktop(app).pending_timesheet.store(true, Ordering::Relaxed);
        }
    }
    if let Some(body) = late {
        notify(app, tr!("Timer läuft noch", "Timer still running"), &body);
    }
    crate::weekplan::periodic(app);
    crate::dayreview::periodic(app);
    crate::briefing::periodic(app);
    crate::meetwork::periodic(app);
    crate::notifyact::periodic(app);
}

// ---------------------------------------------------------------- autostart

#[derive(Serialize)]
pub struct DesktopInfo {
    autostart: bool,
    /// Autostart can be changed (the OS entry is readable).
    autostart_available: bool,
    tray: bool,
    capture_shortcut_active: bool,
    palette_shortcut_active: bool,
    search_shortcut_active: bool,
    selection_shortcut_active: bool,
    mail_shortcut_active: bool,
    voice_shortcut_active: bool,
    /// Milliseconds from the last capture request to its first frame (`None`: not opened yet).
    capture_open_ms: Option<u64>,
    /// Portable mode: no autostart entry (it would point into the user profile).
    portable: bool,
    /// The Microsoft Store build: autostart is the package's startup task (Task Manager shows it).
    store: bool,
    /// Entry ids of the tray menu shown now (`None`: no tray).
    tray_menu: Option<Vec<&'static str>>,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle) -> DesktopInfo {
    let d = desktop(&app);
    let portable = crate::portable::active();
    // The Store package: its startup task, not the Run key (a write there would stay inside the package).
    let store = crate::store::active();
    let autostart = if store {
        crate::store::autostart_enabled().map(|r| r.map_err(|_| ()))
    } else {
        app.try_state::<tauri_plugin_autostart::AutoLaunchManager>().map(|m| m.is_enabled().map_err(|_| ()))
    };
    // Copied out: one lock per statement (temporaries live until its end).
    let slots = *lock(&d.shortcuts);
    let tray_menu = lock(&d.tray).as_ref().map(|t| {
        let mut ids = tray_entries(t.time);
        if t.recording {
            ids.splice(0..0, ["voice-stop", "-"]);
        }
        ids
    });
    DesktopInfo {
        tray_menu,
        autostart: !portable && matches!(autostart, Some(Ok(true))),
        autostart_available: !portable && matches!(autostart, Some(Ok(_))),
        portable,
        store,
        tray: d.has_tray(),
        capture_shortcut_active: slots[Role::Capture as usize].is_some(),
        palette_shortcut_active: slots[Role::Palette as usize].is_some(),
        search_shortcut_active: slots[Role::Search as usize].is_some(),
        selection_shortcut_active: slots[Role::Selection as usize].is_some(),
        mail_shortcut_active: slots[Role::Mail as usize].is_some(),
        voice_shortcut_active: slots[Role::Voice as usize].is_some(),
        capture_open_ms: Some(d.capture_open_ms.load(Ordering::Relaxed)).filter(|ms| *ms > 0),
    }
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<DesktopInfo> {
    if crate::portable::active() {
        return Err(Error::State(crate::portable::not_portable().into()));
    }
    let res = if crate::store::active() {
        crate::store::set_autostart(enabled)
    } else {
        let m = app.autolaunch();
        if enabled { m.enable() } else { m.disable() }.map_err(|e| e.to_string())
    };
    res.map_err(|e| {
        Error::State(trf!("Autostart konnte nicht geändert werden: {e}", "Autostart could not be changed: {e}"))
    })?;
    Ok(desktop_info(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_capture_window_waits_for_a_hanging_portal_and_idle_time() {
        // An answer, or a quick refusal (no portal on the bus): created right after the start.
        assert!(portal_fast(true, Duration::from_millis(4000)));
        assert!(portal_fast(false, Duration::from_millis(20)));
        // A refusal after a long wait: the portal hangs, window creation would block.
        assert!(!portal_fast(false, Duration::from_millis(1500)));
        // Deferred: only once nobody has used the computer for a while.
        assert!(!capture_due(true, None));
        assert!(!capture_due(true, Some(Duration::from_secs(5))));
        assert!(capture_due(true, Some(CAPTURE_IDLE)));
        assert!(!capture_due(false, Some(Duration::from_secs(600))));
    }

    #[test]
    fn tray_has_timer_entries_only_with_time_tracking() {
        let on = tray_entries(true);
        assert_eq!(on, ["open", "search", "briefing", "-", "stop", "pause", "resume", "capture", "-", "quit"]);
        let off = tray_entries(false);
        assert_eq!(off, ["open", "search", "briefing", "-", "capture", "-", "quit"]);
    }

    #[test]
    fn shortcuts_parse_and_refuse_altgr() {
        let parse = |s| parse_shortcut_for(s, false);
        let sc = parse(" Ctrl+Shift+K ").unwrap();
        assert!(sc.mods.contains(Modifiers::CONTROL | Modifiers::SHIFT));
        assert!(parse("Alt+Space").is_ok());
        assert!(parse("Ctrl+Shift+Space").is_ok());
        for bad in ["Ctrl+Alt+K", "Alt+Ctrl+Space", "Ctrl+Alt+Shift+E"] {
            let e = parse(bad).unwrap_err();
            assert!(e.contains("AltGr"), "{bad}: {e}");
        }
        assert!(parse("Strg+Foo").unwrap_err().contains("ungültig"));
    }

    #[test]
    fn shortcuts_accept_the_command_key_under_every_name() {
        for mac in [false, true] {
            let super_k = parse_shortcut_for("Super+Shift+K", mac).unwrap();
            assert!(super_k.mods.contains(Modifiers::SUPER | Modifiers::SHIFT));
            for spec in ["Cmd+Shift+K", "Command+Shift+K", "Meta+Shift+K", "win+shift+k", " Cmd + Shift + K "] {
                assert_eq!(parse_shortcut_for(spec, mac), Ok(super_k), "{spec} (mac: {mac})");
            }
        }
        assert!(parse_shortcut(arcalo_core::settings::DEFAULT_CAPTURE_SHORTCUT).is_ok());
    }

    #[test]
    fn macos_refuses_option_alone_but_not_ctrl_option() {
        let parse = |s| parse_shortcut_for(s, true);
        assert!(parse("Ctrl+Alt+K").is_ok(), "no AltGr on a Mac");
        assert!(parse("Cmd+Alt+K").is_ok());
        for bad in ["Alt+L", "Alt+Shift+E", "Option+Space"] {
            assert!(parse(bad).unwrap_err().contains("⌥"), "{bad}");
        }
    }

    #[test]
    fn settings_shortcuts_must_differ() {
        assert!(validate_shortcuts(["Ctrl+Shift+Space", "", "Ctrl+Shift+O", "", "", ""]).is_ok());
        assert!(validate_shortcuts(["", "", "", "", "", ""]).is_ok());
        let e = validate_shortcuts(["Ctrl+Shift+Space", "Ctrl+Shift+O", " ctrl+shift+o ", "", "", ""]).unwrap_err();
        assert!(e.contains("Befehlspalette und Schnellsuche"), "{e}");
        let e = validate_shortcuts(["Alt+Q", "", "Alt+Q", "", "", ""]).unwrap_err();
        assert!(e.contains("Schnellerfassung und Schnellsuche"), "{e}");
        assert!(validate_shortcuts(["", "", "Ctrl+Alt+F", "", "", ""]).unwrap_err().contains("AltGr"));
        // „Auswahl übernehmen“ is a slot of its own: it must differ and follows the same rules.
        let e = validate_shortcuts(["Ctrl+Shift+Space", "", "", "ctrl+shift+space", "", ""]).unwrap_err();
        assert!(e.contains("Schnellerfassung und Auswahl übernehmen"), "{e}");
        assert!(validate_shortcuts(["", "", "", "Ctrl+Shift+Alt+C", "", ""]).unwrap_err().contains("AltGr"));
        assert!(validate_shortcuts(["Ctrl+Shift+Space", "", "Ctrl+Shift+O", "Ctrl+Shift+Y", "", ""]).is_ok());
        // The mail shortcut is the fifth slot and differs from all others.
        assert!(
            validate_shortcuts(["Ctrl+Shift+Space", "", "Ctrl+Shift+O", "Ctrl+Shift+Y", "Ctrl+Shift+M", ""]).is_ok()
        );
        let e = validate_shortcuts(["Ctrl+Shift+Space", "", "Ctrl+Shift+O", "", "ctrl+shift+space", ""]).unwrap_err();
        assert!(e.contains("Schnellerfassung und E-Mail übernehmen"), "{e}");
        let e = validate_shortcuts(["", "", "", "Ctrl+Shift+Y", "ctrl+shift+y", ""]).unwrap_err();
        assert!(e.contains("Auswahl übernehmen und E-Mail übernehmen"), "{e}");
        assert!(validate_shortcuts(["", "", "", "", "Ctrl+Alt+M", ""]).unwrap_err().contains("AltGr"));
        // The voice-note shortcut is the sixth slot.
        let e = validate_shortcuts(["", "", "", "", "Ctrl+Shift+M", "ctrl+shift+m"]).unwrap_err();
        assert!(e.contains("E-Mail übernehmen und Sprachnotiz"), "{e}");
        assert!(validate_shortcuts(["", "", "", "", "", "Ctrl+Shift+R"]).is_ok());
    }

    #[test]
    fn search_target_serializes_for_the_main_window() {
        let t = SearchTarget::Page { page_id: 7, new_tab: true };
        assert_eq!(serde_json::to_string(&t).unwrap(), r#"{"kind":"page","page_id":7,"new_tab":true}"#);
        let back: SearchTarget = serde_json::from_str(r#"{"kind":"page","page_id":3}"#).unwrap();
        assert_eq!(back, SearchTarget::Page { page_id: 3, new_tab: false });
        assert_eq!(serde_json::from_str::<SearchTarget>(r#"{"kind":"timer_stop"}"#).unwrap(), SearchTarget::TimerStop);
    }
}
