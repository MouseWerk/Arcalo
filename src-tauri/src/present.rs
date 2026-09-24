//! Presentation mode: the main window goes full screen (and back to where it was afterwards);
//! with a second monitor the slides move there and the presenter view („Referentenansicht“)
//! opens as its own window (label `presenter`, `index.html#presenter`) on the first one.

use std::sync::Mutex;

use annalo_core::Error;
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewUrl, WebviewWindowBuilder};

use crate::lock;

type Result<T> = std::result::Result<T, Error>;

const MAIN: &str = "main";
pub const PRESENTER: &str = "presenter";

/// Where the main window was before the presentation.
struct Saved {
    fullscreen: bool,
    maximized: bool,
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    /// The slides were moved to another monitor.
    moved: bool,
}

static SAVED: Mutex<Option<Saved>> = Mutex::new(None);

fn state_err(e: tauri::Error) -> Error {
    Error::State(e.to_string())
}

#[derive(Serialize)]
pub struct PresentInfo {
    /// Connected monitors (the presenter view gets its own window with two or more).
    monitors: usize,
}

/// Full screen for the slides; remembers the window's state for [`presentation_end`].
#[tauri::command]
pub fn presentation_begin(app: AppHandle) -> Result<PresentInfo> {
    let w = app.get_webview_window(MAIN).ok_or_else(|| Error::State("Hauptfenster fehlt".into()))?;
    {
        let mut saved = lock(&SAVED);
        if saved.is_none() {
            *saved = Some(Saved {
                fullscreen: w.is_fullscreen().unwrap_or(false),
                maximized: w.is_maximized().unwrap_or(false),
                position: w.outer_position().unwrap_or_default(),
                size: w.inner_size().unwrap_or_default(),
                moved: false,
            });
        }
    }
    w.set_fullscreen(true).map_err(state_err)?;
    let monitors = w.available_monitors().map(|m| m.len()).unwrap_or(1);
    Ok(PresentInfo { monitors })
}

/// Leaves full screen, closes the presenter window and puts the main window back.
#[tauri::command]
pub fn presentation_end(app: AppHandle) -> Result<()> {
    if let Some(p) = app.get_webview_window(PRESENTER) {
        let _ = p.close();
    }
    let Some(w) = app.get_webview_window(MAIN) else { return Ok(()) };
    let saved = lock(&SAVED).take();
    let _ = w.set_fullscreen(false);
    if let Some(s) = saved {
        if s.moved {
            let _ = w.set_position(Position::Physical(s.position));
            let _ = w.set_size(Size::Physical(s.size));
        }
        if s.maximized {
            let _ = w.maximize();
        }
        if s.fullscreen {
            let _ = w.set_fullscreen(true);
        }
    }
    let _ = w.set_focus();
    Ok(())
}

/// Opens the presenter view as a window when a second monitor is there: the slides move to the
/// other monitor, the presenter window takes the one the app was on. `false` with one monitor
/// (the UI shows the presenter view as an overlay then).
#[tauri::command]
pub async fn presenter_open(app: AppHandle) -> Result<bool> {
    let w = app.get_webview_window(MAIN).ok_or_else(|| Error::State("Hauptfenster fehlt".into()))?;
    let monitors = w.available_monitors().map_err(state_err)?;
    if monitors.len() < 2 {
        return Ok(false);
    }
    if let Some(p) = app.get_webview_window(PRESENTER) {
        let _ = p.set_focus();
        return Ok(true);
    }
    let current = w.current_monitor().map_err(state_err)?;
    let same =
        |m: &tauri::Monitor| current.as_ref().is_some_and(|c| c.position() == m.position() && c.size() == m.size());
    let Some(other) = monitors.iter().find(|m| !same(m)) else { return Ok(false) };
    let home = current.unwrap_or_else(|| monitors[0].clone());
    // Slides on the other monitor.
    let _ = w.set_fullscreen(false);
    w.set_position(Position::Physical(*other.position())).map_err(state_err)?;
    w.set_fullscreen(true).map_err(state_err)?;
    if let Some(s) = lock(&SAVED).as_mut() {
        s.moved = true;
    }
    let scale = home.scale_factor();
    let pos = home.position().to_logical::<f64>(scale);
    let size = home.size().to_logical::<f64>(scale);
    let p = WebviewWindowBuilder::new(&app, PRESENTER, WebviewUrl::App("index.html#presenter".into()))
        .title("Referentenansicht – Annalo")
        .position(pos.x + 40.0, pos.y + 40.0)
        .inner_size((size.width - 80.0).max(800.0), (size.height - 80.0).max(560.0))
        .build()
        .map_err(state_err)?;
    let _ = p.maximize();
    let _ = p.set_focus();
    Ok(true)
}

/// Closes the presenter window; the slides stay full screen where they are.
#[tauri::command]
pub fn presenter_close(app: AppHandle) {
    if let Some(p) = app.get_webview_window(PRESENTER) {
        let _ = p.close();
    }
}
