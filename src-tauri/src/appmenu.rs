//! The macOS menu bar, in the display language (rebuilt when it changes). Windows and Linux keep a window without a menu bar; the
//! module compiles everywhere so the regular builds check it, but only macOS installs it.
//!
//! The Edit menu uses the predefined items: they send the native selectors (`copy:`,
//! `paste:` …), without which ⌘C/⌘V/⌘Z would not work in the webview. Custom items emit
//! `menu://action` with the action name; the UI handles it like its own shortcuts.

use arcalo_core::tr;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

use crate::desktop;

/// Menu item id → the `menu://action` payload the UI understands.
const ACTIONS: [(&str, &str); 4] =
    [("menu:settings", "settings"), ("menu:sidebar", "sidebar"), ("menu:focus", "focus"), ("menu:palette", "palette")];
const QUIT: &str = "menu:quit";
const CLOSE_WINDOW: &str = "menu:close_window";
const WEBSITE: &str = "menu:website";
const WEBSITE_URL: &str = "https://github.com/MouseWerk/Arcalo";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata {
        name: Some("Arcalo".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "Arcalo",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(tr!("Über Arcalo", "About Arcalo")), Some(about))?,
            &sep()?,
            &item("menu:settings", tr!("Einstellungen…", "Settings…"), Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some(tr!("Dienste", "Services")))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some(tr!("Arcalo ausblenden", "Hide Arcalo")))?,
            &PredefinedMenuItem::hide_others(app, Some(tr!("Andere ausblenden", "Hide Others")))?,
            &PredefinedMenuItem::show_all(app, Some(tr!("Alle einblenden", "Show All")))?,
            &sep()?,
            // Not the predefined quit (`terminate:`), which would skip storing open editors.
            &item(QUIT, tr!("Arcalo beenden", "Quit Arcalo"), Some("Cmd+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        tr!("Bearbeiten", "Edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(tr!("Widerrufen", "Undo")))?,
            &PredefinedMenuItem::redo(app, Some(tr!("Wiederholen", "Redo")))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some(tr!("Ausschneiden", "Cut")))?,
            &PredefinedMenuItem::copy(app, Some(tr!("Kopieren", "Copy")))?,
            &PredefinedMenuItem::paste(app, Some(tr!("Einsetzen", "Paste")))?,
            &PredefinedMenuItem::select_all(app, Some(tr!("Alles auswählen", "Select All")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        tr!("Ansicht", "View"),
        true,
        &[
            &item("menu:sidebar", tr!("Seitenleiste ein-/ausblenden", "Toggle Sidebar"), Some("Cmd+\\"))?,
            &item("menu:focus", tr!("Fokusmodus", "Focus Mode"), Some("Cmd+."))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        tr!("Fenster", "Window"),
        true,
        &[
            // ⌘W stays with the window (it closes the tab there), as in Safari.
            &item(CLOSE_WINDOW, tr!("Fenster schließen", "Close Window"), Some("Cmd+Shift+W"))?,
            &PredefinedMenuItem::minimize(app, Some(tr!("Minimieren", "Minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(tr!("Zoomen", "Zoom")))?,
            &PredefinedMenuItem::fullscreen(app, Some(tr!("Vollbild", "Full Screen")))?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, Some(tr!("Alle nach vorne bringen", "Bring All to Front")))?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        tr!("Hilfe", "Help"),
        true,
        &[
            // ⌘K stays with the window (it toggles the palette there).
            &item("menu:palette", tr!("Befehlspalette", "Command Palette"), None)?,
            &item(WEBSITE, tr!("Arcalo auf GitHub", "Arcalo on GitHub"), None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}

/// Handles the app menu's own items; tray items (other ids) are left to the tray.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == QUIT {
        desktop::request_quit(app);
    } else if id == CLOSE_WINDOW {
        desktop::close_front_window(app);
    } else if id == WEBSITE {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app.opener().open_url(WEBSITE_URL, None::<&str>) {
            eprintln!("opening the website failed: {e}");
        }
    } else if let Some((_, action)) = ACTIONS.iter().find(|(item, _)| *item == id) {
        desktop::show_main(app);
        let _ = app.emit_to(desktop::MAIN, "menu://action", *action);
    }
}
