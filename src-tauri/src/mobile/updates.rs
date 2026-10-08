//! Android stand-in for `updates.rs`: the companion app is updated as an APK (later through a
//! store), never by itself.

use tauri::AppHandle;

pub fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

pub fn feed_url(_app: &AppHandle) -> Option<String> {
    None
}

/// Where the release notes of `version` are read from (the desktop's address).
pub fn release_notes_url(version: &str) -> String {
    format!("https://raw.githubusercontent.com/{}/main/docs/releases/v{version}.md", annalo_core::update::REPOSITORY)
}
