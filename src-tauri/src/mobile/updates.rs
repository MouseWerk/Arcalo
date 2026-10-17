//! Mobile stand-in for `updates.rs`: the Android app's own updates are `apkupdate.rs` (an APK
//! from `android-latest.json`, installed by Android's installer after the user confirms); the iOS
//! app is updated by the App Store and asks no feed.

use tauri::AppHandle;

pub fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The feed the network test of „Updates“ asks (only in builds with the update key).
pub fn feed_url(_app: &AppHandle) -> Option<String> {
    #[cfg(target_os = "android")]
    return crate::mobile::apkupdate::pubkey().map(|_| arcalo_core::update_android::FEED_URL.to_string());
    #[cfg(not(target_os = "android"))]
    None
}

/// Where the release notes of `version` are read from (the desktop's address).
pub fn release_notes_url(version: &str) -> String {
    format!("https://raw.githubusercontent.com/{}/main/docs/releases/v{version}.md", arcalo_core::update::REPOSITORY)
}
