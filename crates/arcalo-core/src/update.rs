//! Auto-update decisions that do not need the updater itself.
//!
//! The desktop shell only switches the updater on when the release build compiled in the
//! public key of the signing keypair (`ARCALO_UPDATER_PUBKEY`). Development and test builds
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

/// Why the program files of this copy cannot be replaced by the copy itself (macOS, Linux AppImage).
/// Found before anything is downloaded: such a copy offers the release page instead of an update
/// that would fail at every quit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Blocked {
    /// macOS runs the app from a temporary read-only copy (App Translocation: started from the
    /// Downloads folder or a disk image without being moved into Applications).
    Translocated,
    /// The program is on a read-only volume (a mounted disk image, a write-protected drive).
    ReadOnly,
    /// No write permission for the folder of the AppImage.
    NotWritable,
    /// Linux: the program was not started as an AppImage (an unpacked AppImage, an own build).
    #[serde(rename = "no_appimage")]
    NoAppImage,
}

impl Blocked {
    /// The name the UI and test runs use (`translocated`, `read_only`, …).
    pub fn parse(raw: &str) -> Option<Blocked> {
        match raw.trim() {
            "translocated" => Some(Blocked::Translocated),
            "read_only" => Some(Blocked::ReadOnly),
            "not_writable" => Some(Blocked::NotWritable),
            "no_appimage" => Some(Blocked::NoAppImage),
            _ => None,
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            Blocked::Translocated => tr!(
                "macOS startet Arcalo aus einem schreibgeschützten Zwischenordner, weil die App nicht im Ordner „Programme“ liegt – zieh Arcalo nach „Programme“ und starte es von dort, dann installieren sich Updates selbst",
                "macOS runs Arcalo from a read-only temporary folder because the app is not in the Applications folder – move Arcalo to Applications and start it from there, then updates install themselves"
            ),
            Blocked::ReadOnly => tr!(
                "Arcalo liegt auf einem schreibgeschützten Laufwerk und kann sich nicht selbst aktualisieren – bitte die neue Version von der Release-Seite herunterladen",
                "Arcalo is on a read-only drive and cannot update itself – please download the new version from the release page"
            ),
            Blocked::NotWritable => tr!(
                "Keine Schreibrechte für den Ordner der AppImage-Datei – bitte die neue AppImage von der Release-Seite herunterladen",
                "No write permission for the folder of the AppImage – please download the new AppImage from the release page"
            ),
            Blocked::NoAppImage => tr!(
                "Arcalo wurde nicht als AppImage gestartet und kann sich nicht selbst aktualisieren – bitte die neue Version von der Release-Seite herunterladen",
                "Arcalo was not started as an AppImage and cannot update itself – please download the new version from the release page"
            ),
        }
    }
}

/// Whether the running copy can replace its own program files. `os` is `std::env::consts::OS`;
/// `program` the `.app` bundle (macOS) or the AppImage file (Linux; `None`: not started as an
/// AppImage); `write_probe` the error of creating a file next to it (`None`: that worked).
/// Windows installs through the NSIS installer of the user's own program folder: never blocked.
/// On macOS a folder without write permission is not blocking (the install asks for an
/// administrator's password); a read-only volume is.
pub fn install_blocked(os: &str, program: Option<&Path>, write_probe: Option<std::io::ErrorKind>) -> Option<Blocked> {
    use std::io::ErrorKind;
    match (os, program) {
        ("macos", Some(bundle)) if bundle.components().any(|c| c.as_os_str() == "AppTranslocation") => {
            Some(Blocked::Translocated)
        }
        ("macos", Some(_)) => (write_probe == Some(ErrorKind::ReadOnlyFilesystem)).then_some(Blocked::ReadOnly),
        ("linux", None) => Some(Blocked::NoAppImage),
        ("linux", Some(_)) => match write_probe {
            Some(ErrorKind::ReadOnlyFilesystem) => Some(Blocked::ReadOnly),
            Some(ErrorKind::PermissionDenied) => Some(Blocked::NotWritable),
            _ => None,
        },
        _ => None,
    }
}

/// A test run's stand-in (`ARCALO_UPDATE_ENDPOINT`, `ARCALO_UPDATE_PUBKEY`), honored only by
/// debug builds: a release build always asks the configured GitHub feed with its compiled-in key.
pub fn test_override(debug_build: bool, raw: Option<&str>) -> Option<&str> {
    raw.map(str::trim).filter(|v| debug_build && !v.is_empty())
}

/// File in the data folder written right before an update is installed; the next start reads it
/// (also under its old name `.annalo-update`, which 1.14 writes before installing 1.15).
pub const RESTART_MARKER: &str = ".arcalo-update";

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
    let _ = std::fs::remove_file(dir.join(crate::identity::legacy(RESTART_MARKER)));
}

/// Reads and removes the marker at startup: whether this start follows an update.
pub fn take_restart_marker(dir: &Path, current: &str) -> Option<AfterUpdate> {
    let legacy = dir.join(crate::identity::legacy(RESTART_MARKER));
    let path = [dir.join(RESTART_MARKER), legacy.clone()].into_iter().find(|p| p.is_file())?;
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&legacy);
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
    fn patch_releases_compare_as_numbers() {
        assert!(is_newer("1.18.0", "1.18.1"));
        assert!(is_newer("1.18.1", "1.18.10"));
        assert!(is_newer("1.18.9", "1.18.10"));
        assert!(!is_newer("1.18.10", "1.18.9"));
        assert!(!is_newer("1.18.10", "1.18.1"));
        assert!(!is_newer("1.18.1", "v1.18.1"));
        assert!(!is_newer("1.18.1", "1.18.1-rc.1"), "never back to a pre-release");
        assert!(!is_newer("1.18.0", "1.18.1-rc.1"), "a release build is not offered a pre-release");
        assert!(is_newer("1.18.1-rc.1", "1.18.1"));
        assert!(is_newer("1.18.1-rc.2", "1.18.1-rc.10"));
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
    fn copies_that_cannot_replace_themselves_are_found() {
        use std::io::ErrorKind::{Other, PermissionDenied, ReadOnlyFilesystem};
        let app = Path::new("/Applications/Arcalo.app");
        assert_eq!(install_blocked("macos", Some(app), None), None);
        // /Applications without write permission: the install asks for the password.
        assert_eq!(install_blocked("macos", Some(app), Some(PermissionDenied)), None);
        let translocated = Path::new("/private/var/folders/x/T/AppTranslocation/1F2E/d/Arcalo.app");
        assert_eq!(install_blocked("macos", Some(translocated), Some(ReadOnlyFilesystem)), Some(Blocked::Translocated));
        let dmg = Path::new("/Volumes/Arcalo/Arcalo.app");
        assert_eq!(install_blocked("macos", Some(dmg), Some(ReadOnlyFilesystem)), Some(Blocked::ReadOnly));
        assert_eq!(install_blocked("macos", None, None), None, "not in a bundle (a build of its own)");

        let appimage = Path::new("/home/u/Apps/Arcalo_1.18.0_amd64.AppImage");
        assert_eq!(install_blocked("linux", Some(appimage), None), None);
        assert_eq!(install_blocked("linux", Some(appimage), Some(PermissionDenied)), Some(Blocked::NotWritable));
        assert_eq!(install_blocked("linux", Some(appimage), Some(ReadOnlyFilesystem)), Some(Blocked::ReadOnly));
        assert_eq!(install_blocked("linux", Some(appimage), Some(Other)), None, "tried, and explained if it fails");
        assert_eq!(install_blocked("linux", None, None), Some(Blocked::NoAppImage));
        assert_eq!(install_blocked("windows", None, Some(PermissionDenied)), None);

        for b in [Blocked::Translocated, Blocked::ReadOnly, Blocked::NotWritable, Blocked::NoAppImage] {
            let name = serde_json::to_value(b).unwrap();
            assert_eq!(Blocked::parse(name.as_str().unwrap()), Some(b));
            assert!(!b.message().is_empty());
        }
        assert_eq!(Blocked::parse("deb"), None);
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
        let dir = std::env::temp_dir().join(format!("arcalo-update-marker-{}", std::process::id()));
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
        // 1.14 writes the marker under its old name before it installs 1.15.
        std::fs::write(dir.join(".annalo-update"), "1.15.0\nfrom=1.14.1").unwrap();
        assert_eq!(
            take_restart_marker(&dir, "1.15.0"),
            Some(AfterUpdate { version: "1.15.0".into(), installed: true, from: Some("1.14.1".into()) })
        );
        assert!(!dir.join(".annalo-update").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
