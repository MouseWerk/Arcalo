//! Desktop integration: tray icon, close to tray, quick-capture window,
//! native reminders and autostart. The decisions live in `annalo_core::desktop`;
//! this module only wires them to the window system.

use std::str::FromStr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use annalo_core::desktop::{self as core, CaptureOutcome};
use annalo_core::{Database, Error};
use chrono::{Local, NaiveDate, TimeDelta, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Modifiers, Shortcut};
use tauri_plugin_notification::NotificationExt;

use crate::{AppState, Result, lock};

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
}

const ROLES: [Role; 3] = [Role::Capture, Role::Palette, Role::Search];
const ROLE_NAMES: [&str; 3] = ["Schnellerfassung", "Befehlspalette", "Schnellsuche"];

#[derive(Clone)]
struct TrayHandles {
    tray: TrayIcon,
    stop: MenuItem<Wry>,
    resume: MenuItem<Wry>,
}

#[derive(Default)]
pub struct Desktop {
    tray: Mutex<Option<TrayHandles>>,
    /// Registered global shortcuts by [`Role`]: capture, palette, search.
    shortcuts: Mutex<[Option<Shortcut>; 3]>,
    /// A reminder was shown while the app was in the background: the next time the
    /// main window gets focus it opens the timesheet.
    pending_timesheet: AtomicBool,
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
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

// --------------------------------------------------------------------- tray

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Öffnen", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Timer stoppen", false, None::<&str>)?;
    let resume = MenuItem::with_id(app, "resume", "Zuletzt verwendet starten", false, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "Schnellerfassung", true, None::<&str>)?;
    let search = MenuItem::with_id(app, "search", "Suchen…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &search, &sep()?, &stop, &resume, &capture, &sep()?, &quit])?;
    // macOS: a menu bar extra opens its menu on click (the Dock icon shows the window).
    let mac = cfg!(target_os = "macos");
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Annalo")
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
    *lock(&desktop(app).tray) = Some(TrayHandles { tray, stop, resume });
    refresh_tray(app);
    Ok(())
}

fn on_menu(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_main(app),
        // The UI stops the timer so it can ask about idle time first.
        "stop" => {
            show_main(app);
            let _ = app.emit_to(MAIN, "tray://timer-stop", ());
        }
        "resume" => {
            if let Err(e) = resume_last(app) {
                notify(app, "Timer nicht gestartet", &e.to_string());
            }
        }
        "capture" => open_capture(app),
        "search" => open_search(app, false),
        "quit" => request_quit(app),
        _ => {}
    }
}

/// Starts a timer on the Netzplan/Vorgang of the most recent entry.
fn resume_last(app: &AppHandle) -> Result<()> {
    let state = app.state::<AppState>();
    {
        let db = state.db();
        let last = db.last_finished_entry()?.ok_or_else(|| Error::State("Noch keine Buchung vorhanden".into()))?;
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

/// Updates the tooltip (running timer) and which timer entry is enabled.
pub fn refresh_tray(app: &AppHandle) {
    crate::jumplist::refresh(app);
    let Some(state) = app.try_state::<AppState>() else { return };
    let (running, has_last) = {
        let db = state.db();
        let running = db.running_timer().ok().flatten().map(|e| {
            let nr = db.netzplan_by_id(e.netzplan_id).map(|n| n.netzplan_nr).unwrap_or_default();
            (core::timer_label(&nr, e.vorgang_nr.as_deref()), (Utc::now() - e.start_time).num_minutes())
        });
        (running, db.last_finished_entry().ok().flatten().is_some())
    };
    // Cloned out of the lock: tray calls wait for the main thread, which may want the lock.
    let handles = lock(&desktop(app).tray).clone();
    let Some(t) = handles else { return };
    let tip = core::tray_tooltip(running.as_ref().map(|(l, m)| (l.as_str(), *m)));
    let _ = t.tray.set_tooltip(Some(tip));
    let _ = t.stop.set_enabled(running.is_some());
    let _ = t.resume.set_enabled(running.is_none() && has_last);
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
        }
        // Leaving the app: the taskbar jump list shows the latest pages on the next right-click.
        (MAIN, WindowEvent::Focused(false)) => crate::jumplist::refresh(app),
        // Without close-to-tray the UI destroys the main window; a hidden capture window
        // must not keep the process alive then.
        (MAIN, WindowEvent::Destroyed) => app.exit(0),
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
        #[cfg(target_os = "macos")]
        let hide = true;
        #[cfg(not(target_os = "macos"))]
        let hide = desktop(&app).has_tray();
        let _ = if hide { w.hide() } else { w.minimize() };
    }
}

/// Quits after the UI has stored its edits.
#[tauri::command]
pub fn app_quit(app: AppHandle) {
    app.exit(0);
}

// ------------------------------------------------------------ quick capture

/// Shows the quick-capture window, creating it on first use.
pub fn open_capture(app: &AppHandle) {
    // Creating a webview from an event handler can deadlock on Windows; build it elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = show_capture(&app) {
            crate::devlog::error("desktop", format!("quick capture failed: {e}"));
        }
    });
}

/// A small undecorated window above all others (quick capture, quick search), loading the
/// UI bundle with `#<label>`. Created hidden on first use, then only shown and hidden.
struct Popup {
    label: &'static str,
    title: &'static str,
    size: (f64, f64),
    /// Transparent background: the page draws a rounded panel (not on macOS, which would need
    /// the private-API feature; there the panel fills the window).
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    transparent: bool,
}

fn show_popup(app: &AppHandle, p: &Popup) -> tauri::Result<()> {
    let w = match app.get_webview_window(p.label) {
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
                .visible(false);
            // macOS needs the private-API feature for transparent windows.
            #[cfg(not(target_os = "macos"))]
            let b = b.transparent(p.transparent);
            // Portable: the same webview profile as the main window, in the data folder.
            let webview_dir =
                app.try_state::<crate::AppState>().and_then(|s| crate::portable::webview_dir(&s.data_dir));
            let b = match webview_dir {
                Some(dir) => b.data_directory(dir),
                None => b,
            };
            b.build()?
        }
    };
    w.center()?;
    w.show()?;
    w.set_focus()?;
    let _ = app.emit_to(p.label, &format!("{}://shown", p.label), ());
    Ok(())
}

fn show_capture(app: &AppHandle) -> tauri::Result<()> {
    show_popup(
        app,
        &Popup { label: CAPTURE, title: "Schnellerfassung – Annalo", size: (620.0, 132.0), transparent: false },
    )
}

#[tauri::command]
pub fn capture_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(CAPTURE) {
        let _ = w.hide();
    }
}

// ------------------------------------------------------------- quick search

/// Shows the quick-search window; with `toggle` (the global shortcut) a search window that is
/// already in front is hidden instead.
pub fn open_search(app: &AppHandle, toggle: bool) {
    // Creating a webview from an event handler can deadlock on Windows; build it elsewhere.
    let app = app.clone();
    std::thread::spawn(move || {
        if toggle
            && let Some(w) = app.get_webview_window(SEARCH)
            && w.is_visible().unwrap_or(false)
            && w.is_focused().unwrap_or(false)
        {
            let _ = w.hide();
            return;
        }
        let popup = Popup { label: SEARCH, title: "Suchen – Annalo", size: (640.0, 420.0), transparent: true };
        if let Err(e) = show_popup(&app, &popup) {
            crate::devlog::error("desktop", format!("quick search failed: {e}"));
        }
    });
}

#[tauri::command]
pub fn search_hide(app: AppHandle) {
    if let Some(w) = app.get_webview_window(SEARCH) {
        let _ = w.hide();
    }
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
}

/// Hides the quick search, brings the main window to the front and lets it open `target`.
#[tauri::command]
pub fn search_open(app: AppHandle, target: SearchTarget) {
    search_hide(app.clone());
    show_main(&app);
    let _ = app.emit_to(MAIN, "search://open", target);
}

/// Starts a timer on the most recently booked Netzplan/Vorgang („Zuletzt verwendet starten“).
#[tauri::command]
pub fn timer_resume_last(app: AppHandle) -> Result<()> {
    resume_last(&app)
}

/// Books `/zeit` lines and appends everything else to today's daily note.
#[tauri::command]
pub fn capture_submit(app: AppHandle, state: State<AppState>, text: String) -> Result<CaptureOutcome> {
    let thresholds = state.settings().thresholds;
    let out = core::capture(&state.db(), &text, Utc::now(), &Local, &thresholds)?;
    if !out.bookings.is_empty() {
        let _ = app.emit("data://entries", ());
        refresh_tray(&app);
    }
    if let Some(a) = &out.appended {
        // Open editors of the daily note reload; task lists refresh.
        let _ = app.emit("data://tasks", a.page_id);
    }
    Ok(out)
}

/// Applies the global shortcuts by [`Role`]; `None` keeps a slot as it is, `Some("")` switches
/// it off. New shortcuts are registered before the old ones are released, so a failure (e.g. the
/// combination belongs to another program) keeps the previous shortcuts working. A shortcut
/// that moves between slots (swap) stays registered and only changes its role.
pub fn apply_shortcuts(app: &AppHandle, specs: [Option<&str>; 3]) -> std::result::Result<(), String> {
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
            return Err(format!("Tastenkürzel „{}“ ist nicht verfügbar: {e}", sc.into_string()));
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

fn check_distinct(slots: &[Option<Shortcut>; 3]) -> std::result::Result<(), String> {
    for i in 0..slots.len() {
        for j in i + 1..slots.len() {
            if slots[i].is_some() && slots[i] == slots[j] {
                return Err(format!("{} und {} brauchen verschiedene Tastenkürzel", ROLE_NAMES[i], ROLE_NAMES[j]));
            }
        }
    }
    Ok(())
}

/// Checks the shortcuts of the settings (capture, palette, search; `""` = off) before saving.
pub fn validate_shortcuts(specs: [&str; 3]) -> std::result::Result<(), String> {
    let mut parsed = [None; 3];
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
    let sc = Shortcut::from_str(&normalized).map_err(|e| format!("Tastenkürzel „{spec}“ ungültig: {e}"))?;
    if mac {
        if sc.mods.contains(Modifiers::ALT) && !sc.mods.intersects(Modifiers::CONTROL | Modifiers::SUPER) {
            return Err(format!("Tastenkürzel „{spec}“ nicht möglich: ⌥ ohne ⌘ oder Ctrl tippt Zeichen wie @ oder €"));
        }
    } else if sc.mods.contains(Modifiers::CONTROL | Modifiers::ALT) {
        return Err(format!(
            "Tastenkürzel „{spec}“ nicht möglich: Strg+Alt entspricht AltGr und wird zum Tippen von Zeichen wie @ oder € gebraucht"
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

// ---------------------------------------------------------------- reminders

pub fn notify(app: &AppHandle, title: &str, body: &str) {
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
    let filter = annalo_core::db::EntryFilter { from, to: Some(now + TimeDelta::days(1)), ..Default::default() };
    let booked: i64 = db.list_time_entries(&filter)?.iter().filter_map(|r| r.entry.duration_minutes).sum();
    let running = db.running_timer()?.map_or(0, |e| (now - e.start_time).num_minutes().max(0));
    Ok(booked + running)
}

/// Called every ~30 s: tray tooltip and reminder notifications.
pub fn periodic(app: &AppHandle) {
    refresh_tray(app);
    let state = app.state::<AppState>();
    let settings = state.settings();
    let now = Local::now().naive_local();
    let today = now.date().to_string();
    let (eod, late) = {
        let db = state.db();
        let eod = booked_today(&db)
            .ok()
            .and_then(|booked| core::end_of_day_reminder(now, &settings, booked, meta_date(&db, "reminder.day")));
        let running = db.running_timer().ok().flatten();
        let since = running.as_ref().map(|e| e.start_time.with_timezone(&Local).naive_local());
        let n = &settings.notifications;
        let late_allowed = n.late_timer && !n.is_quiet(now.time());
        let late =
            (late_allowed && core::late_timer_reminder(now, since, meta_date(&db, "late_timer.day"))).then(|| {
                let e = running.as_ref().expect("late reminder implies a running timer");
                let nr = db.netzplan_by_id(e.netzplan_id).map(|n| n.netzplan_nr).unwrap_or_default();
                let start = e.start_time.with_timezone(&Local).format("%H:%M");
                format!(
                    "{} läuft seit {start} Uhr – stoppen nicht vergessen.",
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
        notify(app, &msg, "Zur Zeiterfassung: Annalo öffnen");
        let focused = app.get_webview_window(MAIN).is_some_and(|w| w.is_focused().unwrap_or(false));
        if !focused {
            desktop(app).pending_timesheet.store(true, Ordering::Relaxed);
        }
    }
    if let Some(body) = late {
        notify(app, "Timer läuft noch", &body);
    }
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
    /// Portable mode: no autostart entry (it would point into the user profile).
    portable: bool,
}

#[tauri::command]
pub fn desktop_info(app: AppHandle) -> DesktopInfo {
    let d = desktop(&app);
    let portable = crate::portable::active();
    let autostart = app.try_state::<tauri_plugin_autostart::AutoLaunchManager>().map(|m| m.is_enabled());
    // Copied out: one lock per statement (temporaries live until its end).
    let slots = *lock(&d.shortcuts);
    DesktopInfo {
        autostart: !portable && matches!(autostart, Some(Ok(true))),
        autostart_available: !portable && matches!(autostart, Some(Ok(_))),
        portable,
        tray: d.has_tray(),
        capture_shortcut_active: slots[Role::Capture as usize].is_some(),
        palette_shortcut_active: slots[Role::Palette as usize].is_some(),
        search_shortcut_active: slots[Role::Search as usize].is_some(),
    }
}

#[tauri::command]
pub fn autostart_set(app: AppHandle, enabled: bool) -> Result<DesktopInfo> {
    if crate::portable::active() {
        return Err(Error::State(crate::portable::NOT_PORTABLE.into()));
    }
    let m = app.autolaunch();
    let res = if enabled { m.enable() } else { m.disable() };
    res.map_err(|e| Error::State(format!("Autostart konnte nicht geändert werden: {e}")))?;
    Ok(desktop_info(app))
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(parse_shortcut(annalo_core::settings::DEFAULT_CAPTURE_SHORTCUT).is_ok());
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
        assert!(validate_shortcuts(["Ctrl+Shift+Space", "", "Ctrl+Shift+O"]).is_ok());
        assert!(validate_shortcuts(["", "", ""]).is_ok());
        let e = validate_shortcuts(["Ctrl+Shift+Space", "Ctrl+Shift+O", " ctrl+shift+o "]).unwrap_err();
        assert!(e.contains("Befehlspalette und Schnellsuche"), "{e}");
        let e = validate_shortcuts(["Alt+Q", "", "Alt+Q"]).unwrap_err();
        assert!(e.contains("Schnellerfassung und Schnellsuche"), "{e}");
        assert!(validate_shortcuts(["", "", "Ctrl+Alt+F"]).unwrap_err().contains("AltGr"));
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
