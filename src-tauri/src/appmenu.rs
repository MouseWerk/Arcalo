//! The macOS menu bar (German). Windows and Linux keep a window without a menu bar; the
//! module compiles everywhere so the regular builds check it, but only macOS installs it.
//!
//! The Edit menu uses the predefined items: they send the native selectors (`copy:`,
//! `paste:` …), without which ⌘C/⌘V/⌘Z would not work in the webview. Custom items emit
//! `menu://action` with the action name; the UI handles it like its own shortcuts.

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Wry};

use crate::desktop;

/// Menu item id → the `menu://action` payload the UI understands.
const ACTIONS: [(&str, &str); 4] =
    [("menu:settings", "settings"), ("menu:sidebar", "sidebar"), ("menu:focus", "focus"), ("menu:palette", "palette")];
const QUIT: &str = "menu:quit";
const WEBSITE: &str = "menu:website";
const WEBSITE_URL: &str = "https://github.com/MouseWerk/Annalo";

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);
    let about = AboutMetadata {
        name: Some("Annalo".into()),
        version: Some(app.package_info().version.to_string()),
        ..Default::default()
    };

    let app_menu = Submenu::with_items(
        app,
        "Annalo",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Über Annalo"), Some(about))?,
            &sep()?,
            &item("menu:settings", "Einstellungen …", Some("Cmd+,"))?,
            &sep()?,
            &PredefinedMenuItem::services(app, Some("Dienste"))?,
            &sep()?,
            &PredefinedMenuItem::hide(app, Some("Annalo ausblenden"))?,
            &PredefinedMenuItem::hide_others(app, Some("Andere ausblenden"))?,
            &PredefinedMenuItem::show_all(app, Some("Alle einblenden"))?,
            &sep()?,
            // Not the predefined quit (`terminate:`), which would skip storing open editors.
            &item(QUIT, "Annalo beenden", Some("Cmd+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Bearbeiten",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("Widerrufen"))?,
            &PredefinedMenuItem::redo(app, Some("Wiederholen"))?,
            &sep()?,
            &PredefinedMenuItem::cut(app, Some("Ausschneiden"))?,
            &PredefinedMenuItem::copy(app, Some("Kopieren"))?,
            &PredefinedMenuItem::paste(app, Some("Einsetzen"))?,
            &PredefinedMenuItem::select_all(app, Some("Alles auswählen"))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        "Ansicht",
        true,
        &[
            &item("menu:sidebar", "Seitenleiste ein-/ausblenden", Some("Cmd+\\"))?,
            &item("menu:focus", "Fokusmodus", Some("Cmd+."))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Fenster",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("Minimieren"))?,
            &PredefinedMenuItem::maximize(app, Some("Zoomen"))?,
            &PredefinedMenuItem::fullscreen(app, Some("Vollbild"))?,
            &sep()?,
            &PredefinedMenuItem::bring_all_to_front(app, Some("Alle nach vorne bringen"))?,
        ],
    )?;
    let help = Submenu::with_items(
        app,
        "Hilfe",
        true,
        &[
            // ⌘K stays with the window (it toggles the palette there).
            &item("menu:palette", "Befehlspalette", None)?,
            &item(WEBSITE, "Annalo auf GitHub", None)?,
        ],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &view, &window, &help])
}

/// Handles the app menu's own items; tray items (other ids) are left to the tray.
pub fn on_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    if id == QUIT {
        desktop::request_quit(app);
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
