//! Updates of the Android companion app: checks `android-latest.json` at the start, once a day
//! and on „Nach Updates suchen“, downloads the APK in the background (on Wi-Fi unless mobile data
//! is allowed; an interrupted download continues where it stopped), checks it, and offers
//! „Update installieren“ (a notification and the banner on „Heute“). One tap hands the checked
//! APK to Android's installer, which asks the user to confirm: an app cannot install itself.
//!
//! Checked before the offer (`arcalo_core::update_android`): the minisign signature of the APK
//! with the desktop's update key, compiled in by the release build (`ARCALO_UPDATER_PUBKEY`;
//! other builds never ask), and that it names the announced version; the package, a higher
//! version code and the same APK signing key as the installed app, read from the APK by Android.
//! A file that fails any check is deleted; nothing unchecked is ever handed to the installer.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use arcalo_core::network::Service;
use arcalo_core::update_android::{self as core, AndroidRelease, ApkProblem, Offer};
use arcalo_core::update_feed::{self as feed, FeedError, Location, Step};
use arcalo_core::{tr, trf};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::{NotificationExt, PermissionState};

use super::android;
use crate::{AppState, Result, devlog, lock};

/// The event the UI listens to for every change of [`Status`].
const EVENT: &str = "apkupdate://status";
/// The device-local preferences and the last check (never synced: a phone's own choice).
const PREFS_FILE: &str = "android-update.json";
/// The notification of a ready update (a newer one replaces it).
const NOTIFICATION_ID: i32 = 4_118;
/// How often the background loop looks whether a check is due or Wi-Fi is back.
const LOOP_EVERY: Duration = Duration::from_secs(15 * 60);
/// The first check after the start, once the app has settled.
const FIRST_CHECK_AFTER: Duration = Duration::from_secs(20);

/// The compiled-in public key of the update signatures (release builds only).
pub fn pubkey() -> Option<&'static str> {
    arcalo_core::update::configured_pubkey(option_env!("ARCALO_UPDATER_PUBKEY"))
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Nothing to do (up to date, or not checked yet).
    #[default]
    Idle,
    Checking,
    Downloading,
    /// An update waits for Wi-Fi (or for a network at all).
    Waiting,
    /// Downloaded and checked: „Update installieren“.
    Ready,
    /// A newer version that cannot replace this app (another APK signing key).
    Blocked,
    /// The last check or download failed (`error` says why).
    Error,
}

/// The newer version on offer.
#[derive(Debug, Clone, Serialize)]
pub struct Offered {
    pub version: String,
    pub notes: Option<String>,
    pub size: Option<u64>,
    pub pub_date: Option<String>,
    /// The release page (for an update that has to be installed by hand).
    pub page: String,
}

/// What the UI shows under Einstellungen → Updates and in the banner on „Heute“.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Status {
    /// This build has an update key (release builds).
    pub configured: bool,
    pub current: String,
    pub phase: Phase,
    pub offered: Option<Offered>,
    pub downloaded: u64,
    pub total: Option<u64>,
    /// Waiting: the network is metered (mobile data), not offline.
    pub metered: bool,
    pub error: Option<String>,
    /// Why the offered version cannot be installed over this app.
    pub blocked: Option<String>,
    pub last_check: Option<DateTime<Utc>>,
    pub allow_mobile_data: bool,
}

/// Device-local choices and memory of the updater.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Prefs {
    #[serde(default)]
    allow_mobile_data: bool,
    #[serde(default)]
    last_check: Option<DateTime<Utc>>,
    /// The version the „Update bereit“ notification was shown for (once per version).
    #[serde(default)]
    notified: Option<String>,
}

/// The updater's state, managed by the app.
pub struct Updater {
    status: Mutex<Status>,
    release: Mutex<Option<AndroidRelease>>,
    busy: AtomicBool,
    pause: AtomicBool,
    prefs: Mutex<Prefs>,
    prefs_path: PathBuf,
    dir: PathBuf,
}

impl Updater {
    pub fn new(app: &AppHandle, data_dir: &Path) -> Updater {
        let prefs_path = data_dir.join(PREFS_FILE);
        let prefs: Prefs =
            std::fs::read_to_string(&prefs_path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        // The APK goes into the cache's `updates/` folder: the only place the FileProvider
        // (res/xml/file_paths.xml) hands to the installer.
        let cache = app.path().app_cache_dir().unwrap_or_else(|_| data_dir.join("cache"));
        let status = Status {
            configured: pubkey().is_some(),
            current: app.package_info().version.to_string(),
            last_check: prefs.last_check,
            allow_mobile_data: prefs.allow_mobile_data,
            ..Status::default()
        };
        Updater {
            status: Mutex::new(status),
            release: Mutex::new(None),
            busy: AtomicBool::new(false),
            pause: AtomicBool::new(false),
            prefs: Mutex::new(prefs),
            prefs_path,
            dir: cache.join("updates"),
        }
    }

    fn snapshot(&self) -> Status {
        lock(&self.status).clone()
    }

    fn save_prefs(&self) {
        let text = serde_json::to_string_pretty(&*lock(&self.prefs)).unwrap_or_default();
        let tmp = self.prefs_path.with_extension("json.tmp");
        let written = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, &self.prefs_path));
        if let Err(e) = written {
            devlog::warn("update", format!("update preferences not saved: {e}"));
        }
    }

    fn apk_path(&self, version: &str) -> PathBuf {
        self.dir.join(core::apk_name(version))
    }
}

/// Changes the status and tells the UI.
fn set(app: &AppHandle, f: impl FnOnce(&mut Status)) -> Status {
    let up = app.state::<Updater>();
    let snap = {
        let mut s = lock(&up.status);
        f(&mut s);
        s.clone()
    };
    let _ = app.emit(EVENT, &snap);
    snap
}

fn offered(r: &AndroidRelease) -> Offered {
    Offered {
        version: r.version.clone(),
        notes: r.notes.clone().filter(|n| !n.trim().is_empty()),
        size: r.size,
        pub_date: r.pub_date.clone(),
        page: arcalo_core::update::release_url(&r.version),
    }
}

fn fail(app: &AppHandle, message: String) -> Status {
    devlog::warn("update", &message);
    set(app, |s| {
        s.phase = Phase::Error;
        s.error = Some(message);
    })
}

/// Clears `busy` when the check or download ends, whichever way.
struct Busy<'a>(&'a AtomicBool);

impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Asks the feed and, for an update, downloads it when the network allows (`mobile_data`: this
/// once also on mobile data). Runs on a worker thread; a second call while one runs only answers
/// the status.
pub fn check(app: &AppHandle, manual: bool, mobile_data: bool) -> Status {
    let up = app.state::<Updater>();
    let Some(key) = pubkey() else {
        return up.snapshot();
    };
    if up.busy.swap(true, Ordering::SeqCst) {
        return up.snapshot();
    }
    let _busy = Busy(&up.busy);
    set(app, |s| {
        s.phase = Phase::Checking;
        s.error = None;
    });
    let state = app.state::<AppState>();
    let client = match crate::network::client_for(&state, &Service::Updates) {
        Ok(c) => c,
        Err(e) => return fail(app, e.to_string()),
    };
    let fetched = tauri::async_runtime::block_on(core::fetch(&client, core::FEED_URL));
    let now = Utc::now();
    {
        let mut prefs = lock(&up.prefs);
        prefs.last_check = Some(now);
    }
    up.save_prefs();
    set(app, |s| s.last_check = Some(now));
    let release = match fetched {
        Ok(r) => r,
        // The latest release has no APK (its build failed): nothing on offer, quietly.
        Err(FeedError::Missing) => {
            core::remove_stale(&up.dir, None);
            return set(app, |s| {
                s.phase = Phase::Idle;
                s.offered = None;
            });
        }
        Err(e) if !manual => {
            devlog::info("update", format!("update check failed: {}", e.message()));
            return set(app, |s| s.phase = if s.offered.is_some() { Phase::Waiting } else { Phase::Idle });
        }
        Err(e) => return fail(app, e.message()),
    };
    let installed = match android::installed() {
        Ok(i) => i,
        Err(e) => {
            return fail(app, trf!("Die App-Version ist nicht lesbar ({})", "The app version cannot be read ({})", e));
        }
    };
    match core::offer(&installed.facts, &release) {
        Offer::UpToDate | Offer::OtherPackage => {
            core::remove_stale(&up.dir, None);
            *lock(&up.release) = None;
            set(app, |s| {
                s.phase = Phase::Idle;
                s.offered = None;
                s.blocked = None;
            })
        }
        Offer::OtherSigner => {
            core::remove_stale(&up.dir, None);
            devlog::warn(
                "update",
                format!("{} is signed with another APK key than the installed app", release.version),
            );
            let o = offered(&release);
            *lock(&up.release) = None;
            set(app, |s| {
                s.phase = Phase::Blocked;
                s.offered = Some(o);
                s.blocked = Some(core::other_signer().into());
            })
        }
        Offer::Update => {
            core::remove_stale(&up.dir, Some(&release.version));
            *lock(&up.release) = Some(release.clone());
            let o = offered(&release);
            set(app, |s| {
                s.offered = Some(o);
                s.blocked = None;
            });
            // Downloaded before (an earlier start): checked again, then offered.
            let apk = up.apk_path(&release.version);
            if apk.is_file() {
                match accept(app, &apk, &release, &installed.facts, key) {
                    Ok(()) => return ready(app, &release),
                    Err(status) => return *status,
                }
            }
            let net = android::network().unwrap_or(android::Network { connected: true, metered: true });
            let allowed = lock(&up.prefs).allow_mobile_data || mobile_data;
            if !net.connected || !core::may_download(net.metered, allowed) {
                return set(app, |s| {
                    s.phase = Phase::Waiting;
                    s.metered = net.connected && net.metered;
                });
            }
            download(app, &client, &release, &installed.facts, key)
        }
    }
}

/// Downloads the APK of `release` (continuing an earlier part), checks it and offers it.
fn download(
    app: &AppHandle,
    client: &reqwest::Client,
    release: &AndroidRelease,
    installed: &arcalo_core::update_android::PackageFacts,
    key: &str,
) -> Status {
    let up = app.state::<Updater>();
    let part = up.dir.join(core::part_name(&release.version));
    let apk = up.apk_path(&release.version);
    up.pause.store(false, Ordering::SeqCst);
    set(app, |s| {
        s.phase = Phase::Downloading;
        s.metered = false;
        s.downloaded = 0;
        s.total = release.size;
    });
    devlog::info("update", format!("downloading the APK of {}", release.version));
    let mut last_percent = None;
    let step = tauri::async_runtime::block_on(feed::download(
        client,
        &Location::Http(release.url.clone()),
        &part,
        &up.pause,
        |done, total| {
            let percent = arcalo_core::update::progress_percent(done, total);
            if percent != last_percent {
                last_percent = percent;
                set(app, |s| {
                    s.downloaded = done;
                    s.total = total.or(release.size);
                });
            }
        },
    ));
    match step {
        Ok(Step::Done) => {}
        Ok(Step::Paused) => return set(app, |s| s.phase = Phase::Waiting),
        // A broken connection: the part stays, the next check continues it.
        Err(e @ (FeedError::Interrupted | FeedError::Timeout | FeedError::Connect)) => {
            devlog::info("update", format!("download interrupted, continues later: {}", e.message()));
            return set(app, |s| {
                s.phase = Phase::Waiting;
                s.error = Some(e.message());
            });
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            return fail(app, e.message());
        }
    }
    let size = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
    if release.size.is_some_and(|expected| expected != size) {
        let _ = std::fs::remove_file(&part);
        return fail(app, FeedError::Signature(format!("size {size}")).message());
    }
    if let Err(e) = std::fs::rename(&part, &apk) {
        let _ = std::fs::remove_file(&part);
        return fail(app, e.to_string());
    }
    match accept(app, &apk, release, installed, key) {
        Ok(()) => ready(app, release),
        Err(status) => *status,
    }
}

/// Checks a downloaded APK: the minisign signature with the update key and the signed version,
/// then package, version code and signing key as Android reads them. A file that fails is
/// deleted.
fn accept(
    app: &AppHandle,
    apk: &Path,
    release: &AndroidRelease,
    installed: &arcalo_core::update_android::PackageFacts,
    key: &str,
) -> std::result::Result<(), Box<Status>> {
    if let Err(e) = feed::verify_file(apk, &release.signature, key, &release.version) {
        let _ = std::fs::remove_file(apk);
        devlog::warn("update", format!("APK of {} rejected: {e:?}", release.version));
        return Err(Box::new(fail(app, e.message())));
    }
    let facts = android::archive(&apk.to_string_lossy()).unwrap_or_default();
    if let Err(problem) = core::check_apk(&facts, release, installed) {
        let _ = std::fs::remove_file(apk);
        devlog::warn("update", format!("APK of {} rejected: {problem:?}", release.version));
        return Err(Box::new(match problem {
            ApkProblem::Signer => set(app, |s| {
                s.phase = Phase::Blocked;
                s.blocked = Some(problem.message());
            }),
            _ => fail(app, problem.message()),
        }));
    }
    Ok(())
}

/// The update is ready: the banner, and the notification once per version.
fn ready(app: &AppHandle, release: &AndroidRelease) -> Status {
    let up = app.state::<Updater>();
    let status = set(app, |s| {
        s.phase = Phase::Ready;
        s.error = None;
        s.downloaded = s.total.unwrap_or(s.downloaded);
    });
    let first = lock(&up.prefs).notified.as_deref() != Some(release.version.as_str());
    if first {
        lock(&up.prefs).notified = Some(release.version.clone());
        up.save_prefs();
        notify_ready(app, &release.version);
    }
    status
}

fn notify_ready(app: &AppHandle, version: &str) {
    let n = app.notification();
    // Android 13+: notifications need the user's consent; asked once, when there is something to say.
    if matches!(n.permission_state(), Ok(PermissionState::Prompt | PermissionState::PromptWithRationale)) {
        let _ = n.request_permission();
    }
    let shown = n
        .builder()
        .id(NOTIFICATION_ID)
        .title(trf!("Arcalo {} ist bereit", "Arcalo {} is ready", version))
        .body(tr!("Öffne Arcalo und tippe auf „Update installieren“.", "Open Arcalo and tap “Install update”."))
        .auto_cancel()
        .show();
    if let Err(e) = shown {
        devlog::warn("update", format!("notification failed: {e}"));
    }
}

/// How „Update installieren“ went.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallOutcome {
    /// Android's installer is open.
    Started,
    /// The app may not install apps yet: the user allows it once in Android's settings.
    NeedsPermission,
}

/// Hands the checked APK to Android's installer (checked once more right before).
fn install(app: &AppHandle) -> Result<InstallOutcome> {
    let up = app.state::<Updater>();
    let not_ready = || arcalo_core::Error::State(tr!("Kein Update bereit", "No update is ready").into());
    let release = lock(&up.release).clone().ok_or_else(not_ready)?;
    let key = pubkey().ok_or_else(not_ready)?;
    let apk = up.apk_path(&release.version);
    if let Err(e) = feed::verify_file(&apk, &release.signature, key, &release.version) {
        let _ = std::fs::remove_file(&apk);
        let status = fail(app, e.message());
        return Err(arcalo_core::Error::State(status.error.unwrap_or_default()));
    }
    let out = android::install(&apk.to_string_lossy()).map_err(arcalo_core::Error::State)?;
    if out.started {
        devlog::info("update", format!("installer opened for {}", release.version));
        return Ok(InstallOutcome::Started);
    }
    match out.reason.as_deref() {
        Some("permission") => Ok(InstallOutcome::NeedsPermission),
        Some("missing") => {
            set(app, |s| s.phase = Phase::Idle);
            Err(arcalo_core::Error::State(
                tr!(
                    "Die Update-Datei fehlt – suche erneut nach Updates",
                    "The update file is missing – check for updates again"
                )
                .into(),
            ))
        }
        _ => Err(arcalo_core::Error::State(
            tr!("Android hat das Installationsprogramm nicht geöffnet", "Android did not open the installer").into(),
        )),
    }
}

/// Checks at the start (after a moment), then whenever a day has passed or Wi-Fi is back for a
/// waiting download.
pub fn spawn_scheduler(app: AppHandle) {
    if pubkey().is_none() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_AFTER);
        check(&app, false, false);
        loop {
            std::thread::sleep(LOOP_EVERY);
            let up = app.state::<Updater>();
            let waiting = up.snapshot().phase == Phase::Waiting;
            let allowed = lock(&up.prefs).allow_mobile_data;
            let online = android::network().is_ok_and(|n| n.connected && core::may_download(n.metered, allowed));
            if (waiting && online) || core::check_due(lock(&up.prefs).last_check, Utc::now()) {
                check(&app, false, false);
            }
        }
    });
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| arcalo_core::Error::State(e.to_string()))
}

/// The updater's status.
#[tauri::command]
pub fn apk_update_status(app: AppHandle) -> Status {
    app.state::<Updater>().snapshot()
}

/// „Nach Updates suchen“ (`manual`), or the check of the app's own schedule.
#[tauri::command]
pub async fn apk_update_check(app: AppHandle, manual: bool) -> Result<Status> {
    blocking(move || check(&app, manual, false)).await
}

/// Downloads the offered update now, also on mobile data (asked by the user).
#[tauri::command]
pub async fn apk_update_download(app: AppHandle) -> Result<Status> {
    blocking(move || check(&app, true, true)).await
}

/// „Update installieren“.
#[tauri::command]
pub async fn apk_update_install(app: AppHandle) -> Result<InstallOutcome> {
    blocking(move || install(&app)).await?
}

/// Opens Android's setting „Unbekannte Apps installieren“ for Arcalo; answers whether the app may
/// install now.
#[tauri::command]
pub async fn apk_update_allow_install() -> Result<bool> {
    blocking(android::open_install_settings).await?.map_err(arcalo_core::Error::State)
}

/// „Updates auch über mobile Daten laden“.
#[tauri::command]
pub fn apk_update_set_mobile_data(app: AppHandle, allow: bool) -> Status {
    let up = app.state::<Updater>();
    lock(&up.prefs).allow_mobile_data = allow;
    up.save_prefs();
    set(&app, |s| s.allow_mobile_data = allow)
}
