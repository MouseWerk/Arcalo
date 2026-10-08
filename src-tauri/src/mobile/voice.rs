//! Android stand-in for `voice.rs`: no voice notes in the companion app.

use tauri::AppHandle;

pub fn shutdown(_app: &AppHandle) {}

pub fn model_source_url(_custom: &str) -> Option<String> {
    None
}
