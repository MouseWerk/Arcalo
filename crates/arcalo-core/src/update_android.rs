//! Updates of the Android companion app: the release feed `android-latest.json`, published next to
//! the desktop's `latest.json` in every release, and the checks before an APK is offered.
//!
//! The APK is signed twice: by Android's APK signature (the key that decides whether Android
//! installs it over the installed app) and by the release workflow with the same minisign key as
//! the desktop's updates (`src-tauri/updater.pub`). The app installs only a file whose minisign
//! signature matches the compiled-in key and names the announced version, whose package is the
//! app's own and whose version code is higher than the installed one. An APK signed with another
//! APK key (a debug-signed build, see docs/release/android.md) cannot replace the installed app;
//! it is recognized before the download and explained instead of failing in Android's installer.
//!
//! The desktop feed is left alone: `latest.json` keeps only the desktop platforms, so no updater
//! (Tauri's or the app's own) ever reads an entry it does not know.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::tr;
use crate::update_feed::FeedError;

/// The Android feed of the latest release on GitHub.
pub const FEED_URL: &str = "https://github.com/MouseWerk/Arcalo/releases/latest/download/android-latest.json";

/// The feed file's name in a release (the release workflow writes it).
pub const FEED_FILE: &str = "android-latest.json";

/// The application id of the companion app.
pub const PACKAGE: &str = "de.mousewerk.arcalo";

/// At most this often the app asks the feed by itself (it also asks at every start).
pub const CHECK_EVERY_HOURS: i64 = 24;

/// `android-latest.json`: the release's version, its APK and how that APK is signed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AndroidRelease {
    pub version: String,
    /// Android's version code of the APK (1.18.0 → 1018000, see [`version_code`]).
    pub version_code: u64,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    /// The application id inside the APK.
    pub package: String,
    pub url: String,
    /// Base64 of the APK's minisign `.sig` file (as the desktop's `latest.json` carries it).
    pub signature: String,
    /// Size of the APK in bytes.
    #[serde(default)]
    pub size: Option<u64>,
    /// SHA-256 of the APK's signing certificate (hex, as `apksigner --print-certs` prints it).
    #[serde(default)]
    pub signer: Option<String>,
}

/// Reads `android-latest.json`; a feed without a usable version, version code, package or HTTPS
/// address is invalid.
pub fn parse(text: &str) -> Result<AndroidRelease, FeedError> {
    let mut r: AndroidRelease =
        serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| FeedError::Invalid(e.to_string()))?;
    r.version = r.version.trim().trim_start_matches('v').to_string();
    if semver::Version::parse(&r.version).is_err() {
        return Err(FeedError::Invalid(format!("version {}", r.version)));
    }
    if r.version_code == 0 {
        return Err(FeedError::Invalid("version_code 0".into()));
    }
    if r.package.trim().is_empty() {
        return Err(FeedError::Invalid("no package".into()));
    }
    if !r.url.to_ascii_lowercase().starts_with("https://") {
        return Err(FeedError::Invalid(format!("url {}", r.url)));
    }
    r.signer = r.signer.as_deref().and_then(normalize_cert);
    Ok(r)
}

/// Asks `url` for the feed. No feed there (a release without an APK, HTTP 404) is
/// [`FeedError::Missing`].
pub async fn fetch(client: &reqwest::Client, url: &str) -> Result<AndroidRelease, FeedError> {
    let res = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|e| FeedError::of_reqwest(&e))?;
    match res.status().as_u16() {
        200..=299 => {}
        404 => return Err(FeedError::Missing),
        code => return Err(FeedError::Status(code)),
    }
    parse(&res.text().await.map_err(|e| FeedError::of_reqwest(&e))?)
}

/// Android's version code of `version` as the Tauri CLI computes it for the APK:
/// major × 1 000 000 + minor × 1 000 + patch (1.18.0 → 1018000).
pub fn version_code(version: &str) -> Option<u64> {
    let v = semver::Version::parse(version.trim().trim_start_matches('v')).ok()?;
    if v.minor >= 1000 || v.patch >= 1000 {
        return None;
    }
    Some(v.major * 1_000_000 + v.minor * 1_000 + v.patch)
}

/// A certificate digest as uppercase hex without separators (`ab:cd` and `ABCD` are the same);
/// `None` when it is not hex.
pub fn normalize_cert(raw: &str) -> Option<String> {
    let hex: String = raw.chars().filter(|c| !matches!(c, ':' | ' ' | '\t')).collect::<String>().to_ascii_uppercase();
    (!hex.is_empty() && hex.len().is_multiple_of(2) && hex.chars().all(|c| c.is_ascii_hexdigit())).then_some(hex)
}

/// The installed app, or a downloaded APK, as Android's package manager reads it.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageFacts {
    pub package: String,
    pub version_code: u64,
    #[serde(default)]
    pub version_name: String,
    /// SHA-256 of the signing certificate (uppercase hex), when Android names it.
    #[serde(default)]
    pub signer: Option<String>,
}

/// What a release means for the installed app.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Offer {
    /// Nothing newer.
    UpToDate,
    /// A newer version that can replace the installed app.
    Update,
    /// A newer version signed with another APK key: Android refuses to install it over this one.
    OtherSigner,
    /// The feed names another app (never offered).
    OtherPackage,
}

/// Whether `release` is an update for `installed`: the same package, a newer version and a higher
/// version code (Android never installs a lower or equal one over the app), and, when both are
/// known, the same signing certificate.
pub fn offer(installed: &PackageFacts, release: &AndroidRelease) -> Offer {
    if release.package != installed.package {
        return Offer::OtherPackage;
    }
    let newer = crate::update::is_newer(&installed.version_name, &release.version)
        || (installed.version_name.is_empty() && release.version_code > installed.version_code);
    if !newer || release.version_code <= installed.version_code {
        return Offer::UpToDate;
    }
    match (installed.signer.as_deref().and_then(normalize_cert), release.signer.as_deref()) {
        (Some(mine), Some(theirs)) if mine != theirs => Offer::OtherSigner,
        _ => Offer::Update,
    }
}

/// Why a downloaded APK is not offered for installation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApkProblem {
    /// Not the app's package.
    Package(String),
    /// Not the version code the feed announced, or not higher than the installed one.
    VersionCode(u64),
    /// Signed with another APK key than the installed app.
    Signer,
    /// Android cannot read the file as an app.
    Unreadable,
}

impl ApkProblem {
    pub fn message(&self) -> String {
        match self {
            ApkProblem::Package(_) | ApkProblem::VersionCode(_) | ApkProblem::Unreadable => tr!(
                "Die heruntergeladene Datei passt nicht zur App – sie wurde verworfen, es wurde nichts installiert",
                "The downloaded file does not match the app – it was discarded, nothing was installed"
            )
            .into(),
            ApkProblem::Signer => other_signer().into(),
        }
    }
}

/// The text for an update that is signed with another APK key than the installed app.
pub fn other_signer() -> &'static str {
    tr!(
        "Diese Version ist mit einem anderen App-Schlüssel signiert als die installierte App. Android installiert sie nur nach einer Deinstallation: synchronisiere zuerst, deinstalliere Arcalo und installiere die neue Version von der Release-Seite.",
        "This version is signed with another app key than the installed app. Android installs it only after an uninstall: sync first, uninstall Arcalo and install the new version from the release page."
    )
}

/// Checks the APK Android read (`apk`) against the release and the installed app.
pub fn check_apk(apk: &PackageFacts, release: &AndroidRelease, installed: &PackageFacts) -> Result<(), ApkProblem> {
    if apk.package.is_empty() {
        return Err(ApkProblem::Unreadable);
    }
    if apk.package != installed.package || apk.package != release.package {
        return Err(ApkProblem::Package(apk.package.clone()));
    }
    if apk.version_code != release.version_code || apk.version_code <= installed.version_code {
        return Err(ApkProblem::VersionCode(apk.version_code));
    }
    let cert = |f: &PackageFacts| f.signer.as_deref().and_then(normalize_cert);
    match (cert(apk), cert(installed)) {
        (Some(a), Some(i)) if a != i => Err(ApkProblem::Signer),
        _ => Ok(()),
    }
}

/// Whether the APK may be downloaded now: on an unmetered network (Wi-Fi) always, on mobile data
/// only when the user allowed it (in the settings, or for this one download).
pub fn may_download(metered: bool, allow_mobile_data: bool) -> bool {
    !metered || allow_mobile_data
}

/// Whether the daily check is due (`last` is the last check's time; none yet: due).
pub fn check_due(last: Option<chrono::DateTime<chrono::Utc>>, now: chrono::DateTime<chrono::Utc>) -> bool {
    match last {
        None => true,
        // A clock set back (a check "in the future") counts as due, so it never stops checking.
        Some(at) => now < at || now - at >= chrono::Duration::hours(CHECK_EVERY_HOURS),
    }
}

/// „Neu in Arcalo“ after an update of the app (the full app shows it, as the desktop does after its
/// first start): `seen` is the version the news was last shown for (none on the first start of an
/// app that never recorded one), `current` the version running now. Returns the version the
/// update came from while its news waits to be shown, and the version to record now (`None`:
/// nothing to store). A first start shows nothing and records the version, so a new install does
/// not greet with the news of every release.
pub fn whats_new_from(seen: Option<&str>, current: &str) -> (Option<String>, Option<String>) {
    let current = current.trim();
    match seen.map(str::trim).filter(|s| !s.is_empty()) {
        None => (None, Some(current.to_owned())),
        Some(s) if crate::update::is_newer(s, current) => (Some(s.to_owned()), None),
        Some(s) if s == current => (None, None),
        // An older version installed again: recorded, nothing to show.
        Some(_) => (None, Some(current.to_owned())),
    }
}

/// File names in the app's update folder: the APK of `version` and its part while downloading.
pub fn apk_name(version: &str) -> String {
    format!("Arcalo_{}_android.apk", version.trim().trim_start_matches('v'))
}

pub fn part_name(version: &str) -> String {
    format!("{}.part", apk_name(version))
}

/// Removes every file in `dir` that is not the APK (or its part) of `keep`: older downloads and
/// parts of a version that is no longer offered. Returns how many files went.
pub fn remove_stale(dir: &Path, keep: Option<&str>) -> usize {
    let keep: Vec<String> = keep.map(|v| vec![apk_name(v), part_name(v)]).unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter(|e| !keep.iter().any(|k| e.file_name().to_string_lossy() == k.as_str()))
        .filter(|e| std::fs::remove_file(e.path()).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};

    const CERT: &str =
        "3A:9F:00:12:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01";

    fn release(version: &str, code: u64) -> AndroidRelease {
        AndroidRelease {
            version: version.into(),
            version_code: code,
            notes: Some("## Improved\n\n- Faster".into()),
            pub_date: None,
            package: PACKAGE.into(),
            url: format!("https://github.com/MouseWerk/Arcalo/releases/download/v{version}/{}", apk_name(version)),
            signature: "c2ln".into(),
            size: Some(42),
            signer: normalize_cert(CERT),
        }
    }

    fn installed(version: &str, code: u64, signer: Option<&str>) -> PackageFacts {
        PackageFacts {
            package: PACKAGE.into(),
            version_code: code,
            version_name: version.into(),
            signer: signer.map(str::to_string),
        }
    }

    #[test]
    fn version_codes_follow_the_tauri_cli() {
        assert_eq!(version_code("1.15.0"), Some(1_015_000));
        assert_eq!(version_code("v1.18.2"), Some(1_018_002));
        assert_eq!(version_code("2.0.0"), Some(2_000_000));
        assert_eq!(version_code("1.1000.0"), None);
        assert_eq!(version_code("x"), None);
    }

    #[test]
    fn the_feed_is_read_and_checked() {
        let json = serde_json::to_string(&release("1.18.0", 1_018_000)).unwrap();
        let r = parse(&format!("\u{feff}{json}")).unwrap();
        assert_eq!(r.version, "1.18.0");
        assert_eq!(r.signer.as_deref(), normalize_cert(CERT).as_deref());
        // Fields the desktop feed does not have, and unknown ones, are fine; missing ones are not.
        let extra = json.replacen('{', r#"{"future":1,"#, 1);
        assert!(parse(&extra).is_ok());
        assert!(matches!(parse(r#"{"version":"1.18.0"}"#), Err(FeedError::Invalid(_))));
        let bad_version = json.replace("\"1.18.0\"", "\"next\"");
        assert!(matches!(parse(&bad_version), Err(FeedError::Invalid(_))));
        let http = json.replace("https://", "http://");
        assert!(matches!(parse(&http), Err(FeedError::Invalid(_))), "an APK only over HTTPS");
        let no_code = json.replace("1018000", "0");
        assert!(matches!(parse(&no_code), Err(FeedError::Invalid(_))));
    }

    #[test]
    fn certificates_compare_without_separators_and_case() {
        assert_eq!(normalize_cert("ab:cd 01"), Some("ABCD01".into()));
        assert_eq!(normalize_cert("abc"), None);
        assert_eq!(normalize_cert("zz"), None);
        assert_eq!(normalize_cert(""), None);
    }

    #[test]
    fn only_a_newer_version_with_a_higher_code_and_the_same_key_is_an_update() {
        let me = installed("1.17.0", 1_017_000, Some(CERT));
        assert_eq!(offer(&me, &release("1.18.0", 1_018_000)), Offer::Update);
        assert_eq!(offer(&me, &release("1.17.0", 1_017_000)), Offer::UpToDate);
        assert_eq!(offer(&me, &release("1.16.0", 1_016_000)), Offer::UpToDate, "never a downgrade");
        // A newer name with a code Android would refuse.
        assert_eq!(offer(&me, &release("1.18.0", 1_017_000)), Offer::UpToDate);
        let mut other = release("1.18.0", 1_018_000);
        other.package = "com.example".into();
        assert_eq!(offer(&me, &other), Offer::OtherPackage);
        let mut foreign = release("1.18.0", 1_018_000);
        foreign.signer = normalize_cert("00:11");
        assert_eq!(offer(&me, &foreign), Offer::OtherSigner);
        // Unknown on either side: the APK's own check after the download decides.
        let mut unsigned = release("1.18.0", 1_018_000);
        unsigned.signer = None;
        assert_eq!(offer(&me, &unsigned), Offer::Update);
        assert_eq!(offer(&installed("1.17.0", 1_017_000, None), &foreign), Offer::Update);
        // A release build is not moved to a pre-release.
        assert_eq!(offer(&me, &release("1.19.0-beta.1", 1_019_000)), Offer::UpToDate);
    }

    #[test]
    fn the_downloaded_apk_must_be_the_announced_one() {
        let me = installed("1.17.0", 1_017_000, Some(CERT));
        let r = release("1.18.0", 1_018_000);
        let apk = |package: &str, code: u64, signer: Option<&str>| PackageFacts {
            package: package.into(),
            version_code: code,
            version_name: "1.18.0".into(),
            signer: signer.map(str::to_string),
        };
        assert_eq!(check_apk(&apk(PACKAGE, 1_018_000, Some(&CERT.replace(':', ""))), &r, &me), Ok(()));
        assert_eq!(check_apk(&apk("", 0, None), &r, &me), Err(ApkProblem::Unreadable));
        assert_eq!(
            check_apk(&apk("com.evil", 1_018_000, Some(CERT)), &r, &me),
            Err(ApkProblem::Package("com.evil".into()))
        );
        assert_eq!(check_apk(&apk(PACKAGE, 1_017_500, Some(CERT)), &r, &me), Err(ApkProblem::VersionCode(1_017_500)));
        assert_eq!(check_apk(&apk(PACKAGE, 1_018_000, Some("00:11")), &r, &me), Err(ApkProblem::Signer));
        assert_eq!(
            check_apk(&apk(PACKAGE, 1_018_000, None), &r, &me),
            Ok(()),
            "Android's installer checks the key then"
        );
        assert!(ApkProblem::Signer.message().contains("Schlüssel") || ApkProblem::Signer.message().contains("key"));
    }

    #[test]
    fn downloads_wait_for_wifi_unless_mobile_data_is_allowed() {
        assert!(may_download(false, false));
        assert!(!may_download(true, false));
        assert!(may_download(true, true));
    }

    #[test]
    fn the_check_is_due_once_a_day_and_after_a_clock_set_back() {
        let now = Utc.with_ymd_and_hms(2026, 10, 11, 12, 0, 0).unwrap();
        assert!(check_due(None, now));
        assert!(!check_due(Some(now - chrono::Duration::hours(23)), now));
        assert!(check_due(Some(now - chrono::Duration::hours(24)), now));
        assert!(check_due(Some(now + chrono::Duration::hours(2)), now));
    }

    /// One answer per connection: the status and body of `/feed`, 404 for anything else.
    async fn serve(status: u16, body: String) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let mut buf = vec![0u8; 2048];
                let n = sock.read(&mut buf).await.unwrap_or(0);
                let feed = String::from_utf8_lossy(&buf[..n]).starts_with("GET /feed ");
                let (status, body) = if feed { (status, body.clone()) } else { (404, String::new()) };
                let head =
                    format!("HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(body.as_bytes()).await;
            }
        });
        base
    }

    #[tokio::test]
    async fn the_feed_is_fetched_and_a_release_without_apk_is_missing() {
        let client = reqwest::Client::new();
        let base = serve(200, serde_json::to_string(&release("1.18.0", 1_018_000)).unwrap()).await;
        assert_eq!(fetch(&client, &format!("{base}/feed")).await.unwrap().version_code, 1_018_000);
        assert_eq!(fetch(&client, &format!("{base}/other")).await, Err(FeedError::Missing));
        let broken = serve(200, "{".into()).await;
        assert!(matches!(fetch(&client, &format!("{broken}/feed")).await, Err(FeedError::Invalid(_))));
        let failing = serve(503, String::new()).await;
        assert_eq!(fetch(&client, &format!("{failing}/feed")).await, Err(FeedError::Status(503)));
    }

    #[test]
    fn stale_downloads_are_removed() {
        let dir = std::env::temp_dir().join(format!("arcalo-apk-stale-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for f in [apk_name("1.17.0"), part_name("1.18.0"), apk_name("1.18.0"), "junk.tmp".into()] {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        assert_eq!(remove_stale(&dir, Some("1.18.0")), 2);
        assert!(dir.join(apk_name("1.18.0")).is_file() && dir.join(part_name("1.18.0")).is_file());
        assert_eq!(remove_stale(&dir, None), 2);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn whats_new_waits_after_an_update_until_it_was_shown() {
        // The first start records the version and shows nothing.
        assert_eq!(whats_new_from(None, "1.21.0"), (None, Some("1.21.0".into())));
        assert_eq!(whats_new_from(Some(" "), "1.21.0"), (None, Some("1.21.0".into())));
        // After an update the news waits (also across later updates) until shown.
        assert_eq!(whats_new_from(Some("1.20.0"), "1.21.0"), (Some("1.20.0".into()), None));
        assert_eq!(whats_new_from(Some("1.20.0"), "1.22.1"), (Some("1.20.0".into()), None));
        // Shown: nothing more; an older version installed again is recorded.
        assert_eq!(whats_new_from(Some("1.21.0"), "1.21.0"), (None, None));
        assert_eq!(whats_new_from(Some("1.22.0"), "1.21.0"), (None, Some("1.21.0".into())));
    }
}
