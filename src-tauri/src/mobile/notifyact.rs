//! Mobile stand-in for `notifyact.rs`. Android shows notifications without buttons; iOS gives the
//! end of a focus session „+5 Min.“ and „Pause“ and the morning briefing „Öffnen“ (`ios.rs`, the
//! buttons are handled by [`super::notification_action`]).

use tauri::AppHandle;

use arcalo_core::tr;

/// The buttons of a focus session's end (iOS category and its actions).
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const CATEGORY_FOCUS: &str = "focus-end";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const ACTION_EXTEND: &str = "focus-extend";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const ACTION_PAUSE: &str = "focus-pause";
/// The button of the morning briefing.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const CATEGORY_BRIEFING: &str = "briefing";
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub const ACTION_OPEN: &str = "open";

/// A notification (the desktop's carries the buttons' subject as well).
#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub title: String,
    pub body: String,
    /// Its buttons where the system shows them (iOS).
    #[cfg_attr(not(target_os = "ios"), allow(dead_code))]
    pub category: Option<&'static str>,
}

impl Note {
    pub fn briefing(body: &str) -> Note {
        Note {
            title: tr!("Morgen-Briefing", "Morning briefing").into(),
            body: body.into(),
            category: Some(CATEGORY_BRIEFING),
        }
    }

    pub fn focus_end(body: String) -> Note {
        Note { title: tr!("Pause", "Break").into(), body, category: Some(CATEGORY_FOCUS) }
    }
}

pub fn show(app: &AppHandle, note: Note) {
    #[cfg(target_os = "ios")]
    {
        let _ = app;
        crate::mobile::ios::notify(&note.title, &note.body, note.category);
    }
    #[cfg(not(target_os = "ios"))]
    crate::desktop::notify(app, &note.title, &note.body);
}

pub fn is_activation(_arg: &std::ffi::OsStr) -> bool {
    false
}
