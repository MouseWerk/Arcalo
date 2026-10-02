//! Auto-update decisions that do not need the updater itself.
//!
//! The desktop shell only switches the updater on when the release build compiled in the
//! public key of the signing keypair (`ANNALO_UPDATER_PUBKEY`). Development and test builds
//! have no key: they never contact the update server.

use std::path::Path;

/// GitHub repository the releases are published to.
use crate::tr;

pub const REPOSITORY: &str = "MouseWerk/Arcalo";

/// Shown when a build has no update key.
pub const NOT_CONFIGURED: &str = "Automatische Updates sind in diesem Build nicht eingerichtet";

/// [`NOT_CONFIGURED`] in the display language.
pub fn not_configured() -> &'static str {
    tr!(NOT_CONFIGURED, "Automatic updates are not set up in this build")
}

/// The compiled-in public key, if it is usable: blank values count as "not configured".
pub fn configured_pubkey(raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|k| !k.is_empty())
}

/// Release page with the changelog of `version` (`1.2.0` or `v1.2.0`).
pub fn release_url(version: &str) -> String {
    let v = version.trim().trim_start_matches('v');
    format!("https://github.com/{REPOSITORY}/releases/tag/v{v}")
}

/// Whether `offered` (the feed's version) is an update for `current`: newer by semver precedence,
/// build metadata ignored. A release build is never moved to a pre-release; a pre-release build
/// takes a later pre-release or the final version. A version that does not parse is no update.
pub fn is_newer(current: &str, offered: &str) -> bool {
    let (Some(current), Some(offered)) = (parse(current), parse(offered)) else {
        return false;
    };
    if !offered.pre.is_empty() && current.pre.is_empty() {
        return false;
    }
    offered.cmp_precedence(&current).is_gt()
}

fn parse(version: &str) -> Option<semver::Version> {
    semver::Version::parse(version.trim().trim_start_matches('v')).ok()
}

/// Shown instead of installing in a portable copy.
pub const PORTABLE_MANUAL: &str = "Im portablen Modus wird nicht automatisch installiert – bitte die neue Version von der Release-Seite herunterladen";
/// Shown instead of installing when a package manager owns the installation (.deb, .rpm).
pub const PACKAGE_MANUAL: &str =
    "Arcalo ist als Paket installiert – bitte das neue Paket von der Release-Seite herunterladen";

/// Why this copy does not install updates itself (`None`: it does). A portable copy would be
/// installed into the user profile instead of updating its folder; a .deb or .rpm belongs to the
/// package manager (the feed's Linux file is the AppImage).
pub fn manual_update_reason(portable: bool, package: bool) -> Option<&'static str> {
    if portable {
        Some(tr!(
            PORTABLE_MANUAL,
            "Portable mode does not install automatically – please download the new version from the release page"
        ))
    } else if package {
        Some(tr!(
            PACKAGE_MANUAL,
            "Arcalo is installed as a package – please download the new package from the release page"
        ))
    } else {
        None
    }
}

/// A test run's stand-in (`ANNALO_UPDATE_ENDPOINT`, `ANNALO_UPDATE_PUBKEY`), honored only by
/// debug builds: a release build always asks the configured GitHub feed with its compiled-in key.
pub fn test_override(debug_build: bool, raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|v| debug_build && !v.is_empty())
}

/// File in the data folder written right before an update is installed; the next start reads it.
pub const RESTART_MARKER: &str = ".annalo-update";

/// The first start after an update was installed (or tried).
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
pub struct AfterUpdate {
    /// The version the update was to install.
    pub version: String,
    /// This start runs that version (otherwise the installer did not finish, e.g. UAC denied).
    pub installed: bool,
    /// The version the update came from (markers from before 1.9 have none).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
}

/// Notes that `version` is being installed over `from` (see [`take_restart_marker`]).
pub fn write_restart_marker(dir: &Path, version: &str, from: Option<&str>) -> std::io::Result<()> {
    let from = from.map(|f| format!("\nfrom={}", f.trim())).unwrap_or_default();
    std::fs::write(dir.join(RESTART_MARKER), format!("{}{from}", version.trim()))
}

/// Forgets the marker (the install failed and this process keeps running).
pub fn clear_restart_marker(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(RESTART_MARKER));
}

/// Reads and removes the marker at startup: whether this start follows an update.
pub fn take_restart_marker(dir: &Path, current: &str) -> Option<AfterUpdate> {
    let path = dir.join(RESTART_MARKER);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let mut lines = text.lines();
    let version = lines.next().unwrap_or_default().trim().trim_start_matches('v').to_string();
    let target = parse(&version)?;
    let installed = parse(current).is_some_and(|c| c.cmp_precedence(&target).is_eq());
    let from = lines
        .find_map(|l| l.trim().strip_prefix("from="))
        .map(|f| f.trim().trim_start_matches('v').to_string())
        .filter(|f| parse(f).is_some());
    Some(AfterUpdate { version, installed, from })
}

/// Whole download percentage, `None` while the size is unknown.
pub fn progress_percent(downloaded: u64, total: Option<u64>) -> Option<u8> {
    let total = total.filter(|t| *t > 0)?;
    Some((downloaded.min(total) * 100 / total) as u8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_needs_a_non_blank_key() {
        assert_eq!(configured_pubkey(None), None);
        assert_eq!(configured_pubkey(Some("")), None);
        assert_eq!(configured_pubkey(Some("  \n")), None);
        assert_eq!(configured_pubkey(Some(" dW50cnVzdGVk\n")), Some("dW50cnVzdGVk"));
    }

    #[test]
    fn release_links_use_the_tag() {
        let url = "https://github.com/MouseWerk/Arcalo/releases/tag/v1.2.0";
        assert_eq!(release_url("1.2.0"), url);
        assert_eq!(release_url("v1.2.0"), url);
    }

    #[test]
    fn progress_is_clamped_and_unknown_without_size() {
        assert_eq!(progress_percent(10, None), None);
        assert_eq!(progress_percent(10, Some(0)), None);
        assert_eq!(progress_percent(0, Some(200)), Some(0));
        assert_eq!(progress_percent(101, Some(200)), Some(50));
        assert_eq!(progress_percent(300, Some(200)), Some(100));
    }

    #[test]
    fn only_newer_versions_are_updates() {
        assert!(is_newer("1.5.0", "1.6.0"));
        assert!(is_newer("1.5.0", "v1.5.1"));
        assert!(is_newer("1.9.0", "1.10.0"), "numeric, not lexical");
        assert!(!is_newer("1.6.0", "1.6.0"));
        assert!(!is_newer("1.6.0", "1.5.9"), "never a downgrade");
        assert!(!is_newer("1.6.0+win", "1.6.0+mac"), "build metadata is no new version");
        assert!(!is_newer("1.6.0", "garbage"));
        assert!(!is_newer("", "1.6.0"));
    }

    #[test]
    fn pre_releases_only_for_pre_release_builds() {
        assert!(!is_newer("1.6.0", "1.7.0-beta.1"), "a release build stays on releases");
        assert!(is_newer("1.6.0-test.1", "1.6.0-test.2"));
        assert!(is_newer("1.6.0-test.2", "1.6.0-test.10"), "numeric identifiers compare as numbers");
        assert!(is_newer("1.6.0-beta.3", "1.6.0"), "the final version follows its pre-releases");
        assert!(!is_newer("1.6.0-test.2", "1.6.0-test.1"));
        assert!(!is_newer("1.6.0", "1.6.0-rc.1"));
    }

    #[test]
    fn portable_and_packaged_copies_do_not_install() {
        assert_eq!(manual_update_reason(false, false), None);
        assert_eq!(manual_update_reason(true, false), Some(PORTABLE_MANUAL));
        assert_eq!(manual_update_reason(false, true), Some(PACKAGE_MANUAL));
        // A portable folder wins: it is never installed into the profile.
        assert_eq!(manual_update_reason(true, true), Some(PORTABLE_MANUAL));
    }

    #[test]
    fn test_feed_only_in_debug_builds() {
        let url = "http://127.0.0.1:8123/latest.json";
        assert_eq!(test_override(true, Some(url)), Some(url));
        assert_eq!(test_override(true, Some(&format!(" {url}\n"))), Some(url));
        assert_eq!(test_override(false, Some(url)), None, "release builds cannot be redirected");
        assert_eq!(test_override(true, Some("  ")), None);
        assert_eq!(test_override(true, None), None);
    }

    #[test]
    fn restart_marker_is_read_once() {
        let dir = std::env::temp_dir().join(format!("annalo-update-marker-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(take_restart_marker(&dir, "1.6.0"), None);
        write_restart_marker(&dir, "1.6.0", None).unwrap();
        assert_eq!(
            take_restart_marker(&dir, "1.6.0"),
            Some(AfterUpdate { version: "1.6.0".into(), installed: true, from: None })
        );
        assert_eq!(take_restart_marker(&dir, "1.6.0"), None, "removed after reading");
        // The installer did not finish (UAC denied, cancelled): the old version starts again.
        write_restart_marker(&dir, "1.6.0", Some("1.5.0")).unwrap();
        assert_eq!(
            take_restart_marker(&dir, "1.5.0"),
            Some(AfterUpdate { version: "1.6.0".into(), installed: false, from: Some("1.5.0".into()) })
        );
        // A marker from before 1.9: only the version.
        std::fs::write(dir.join(RESTART_MARKER), "v1.6.0\n").unwrap();
        assert_eq!(
            take_restart_marker(&dir, "1.6.0"),
            Some(AfterUpdate { version: "1.6.0".into(), installed: true, from: None })
        );
        write_restart_marker(&dir, "1.6.0", None).unwrap();
        clear_restart_marker(&dir);
        assert_eq!(take_restart_marker(&dir, "1.6.0"), None);
        std::fs::write(dir.join(RESTART_MARKER), "not a version").unwrap();
        assert_eq!(take_restart_marker(&dir, "1.6.0"), None);
        assert!(!dir.join(RESTART_MARKER).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
