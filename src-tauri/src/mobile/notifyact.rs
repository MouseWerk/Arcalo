//! Android stand-in for `notifyact.rs`: notifications without action buttons.

use tauri::AppHandle;

use arcalo_core::tr;

/// A notification (the desktop's carries the buttons' subject as well).
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
}

impl Note {
    pub fn briefing(body: &str) -> Note {
        Note { title: tr!("Morgen-Briefing", "Morning briefing").into(), body: body.into() }
    }

    pub fn focus_end(body: String) -> Note {
        Note { title: tr!("Pause", "Break").into(), body }
    }
}

pub fn show(app: &AppHandle, note: Note) {
    crate::desktop::notify(app, &note.title, &note.body);
}

pub fn is_activation(_arg: &std::ffi::OsStr) -> bool {
    false
}
