//! Auto-update. Checks the feed sources (an organization's server or share first, then the
//! GitHub release feed, see `annalo_core::update_feed`), downloads the update in the
//! background (resumable, pausable) and checks its signature against the compiled-in key,
//! whatever the source. In the mode „automatisch“ the update is installed when the app quits
//! (or on „Jetzt neu starten“); „nur benachrichtigen“ installs on the user's click, as before
//! 1.9. Before installing, the database is backed up and a copy of the running version kept
//! for the rollback (`rollback.rs`). Only switched on when the build compiled in the
//! updater's public key (`ANNALO_UPDATER_PUBKEY`); other builds never contact a server.
//!
//! The installation itself is `installer.rs`: it does with the verified file what the updater
//! plugin's install does (NSIS in passive update mode on Windows, replacing the bundle or the
//! AppImage elsewhere), without the plugin's own feed check. The plugin is still registered
//! for its configuration and target names; it never fetches anything.
//!
//! The Microsoft Store build (`store.rs`) has none of this: the Store updates the package, so
//! there is no key, no check, no download, no install on quit and no rollback.
//!
//! Debug builds take a test feed, key and version from `ANNALO_UPDATE_ENDPOINT`,
//! `ANNALO_UPDATE_PUBKEY` and `ANNALO_UPDATE_CURRENT` (end-to-end tests with a local server);
//! release builds ignore them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use crate::installer::{self, InstallError};
use crate::{Result, lock, rollback};
use annalo_core::Error;
use annalo_core::network::Service;
use annalo_core::update::{self as core, AfterUpdate};
use annalo_core::update_feed::{self as feed, FeedError, Location, Source};
use annalo_core::update_policy::{Effective, UpdateMode};
use annalo_core::update_state::{self as st, RollbackRecord, UpdateState, Verdict};
use annalo_core::{tr, trf};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Stage file of a verified download (`updates/` in the data folder).
const STAGED_FILE: &str = "staged.json";

fn test_var(name: &str) -> Option<String> {
    core::test_override(cfg!(debug_assertions), std::env::var(name).ok().as_deref()).map(str::to_string)
}

/// Public key of the signing keypair, compiled in by the release build.
pub fn pubkey() -> Option<&'static str> {
    if crate::store::active() {
        return None;
    }
    static KEY: OnceLock<Option<String>> = OnceLock::new();
    KEY.get_or_init(|| {
        test_var("ANNALO_UPDATE_PUBKEY")
            .or_else(|| core::configured_pubkey(option_env!("ANNALO_UPDATER_PUBKEY")).map(str::to_string))
    })
    .as_deref()
}

/// The updater plugin, or `None` in builds without a key (the app then runs without it).
/// The Windows install mode comes from `plugins.updater` in `tauri.conf.json`.
pub fn plugin<R: Runtime>() -> Option<TauriPlugin<R, tauri_plugin_updater::Config>> {
    pubkey().map(|key| tauri_plugin_updater::Builder::new().pubkey(key).build())
}

/// The version this copy runs (debug builds: `ANNALO_UPDATE_CURRENT` stands in for it).
pub fn current_version(app: &AppHandle) -> String {
    test_var("ANNALO_UPDATE_CURRENT").unwrap_or_else(|| app.package_info().version.to_string())
}

/// Installed through a package manager (.deb, .rpm): updates come from the release page.
/// Debug builds pretend with `ANNALO_UPDATE_BUNDLE=deb` (tests).
fn packaged() -> bool {
    use tauri::utils::config::BundleType;
    if let Some(bundle) = test_var("ANNALO_UPDATE_BUNDLE") {
        return matches!(bundle.as_str(), "deb" | "rpm");
    }
    matches!(tauri::utils::platform::bundle_type(), Some(BundleType::Deb | BundleType::Rpm))
}

/// The keys of `latest.json` this copy takes (`windows-x86_64-nsis`, `windows-x86_64`).
fn targets() -> Vec<String> {
    use tauri::utils::config::BundleType;
    let installer = match tauri::utils::platform::bundle_type() {
        Some(BundleType::Nsis) => Some("nsis"),
        Some(BundleType::Msi) => Some("msi"),
        Some(BundleType::AppImage) => Some("appimage"),
        Some(BundleType::App) => Some("app"),
        _ => None,
    };
    feed::targets(&tauri_plugin_updater::target().unwrap_or_default(), installer)
}

/// The update found by the last check.
#[derive(Clone, Debug)]
struct Offer {
    version: String,
    notes: Option<String>,
    date: Option<String>,
    signature: String,
    location: Location,
    source: String,
}

/// A downloaded and verified update file, waiting to be installed.
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Staged {
    version: String,
    signature: String,
    path: PathBuf,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    #[default]
    Idle,
    Downloading,
    Paused,
    Ready,
    Failed,
}

#[derive(Clone, Debug, Default, Serialize)]
struct DownloadState {
    phase: Phase,
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
    error: Option<String>,
}

#[derive(Default)]
pub struct Updates {
    offer: Mutex<Option<Offer>>,
    staged: Mutex<Option<Staged>>,
    download: Mutex<DownloadState>,
    pause: AtomicBool,
    downloading: AtomicBool,
    installing: AtomicBool,
    /// The quit already installed (or decided not to): the exit event does nothing more.
    quit_handled: AtomicBool,
    /// This start follows an update (reported once to the UI).
    after: Mutex<Option<AfterUpdate>>,
    /// This start follows a rollback (reported once).
    rolled_back: Mutex<Option<rollback::Notice>>,
}

impl Updates {
    pub fn after(after: Option<AfterUpdate>, rolled_back: Option<rollback::Notice>) -> Self {
        Updates { after: Mutex::new(after), rolled_back: Mutex::new(rolled_back), ..Default::default() }
    }
}

#[derive(Serialize, Clone)]
pub struct UpdateInfo {
    version: String,
    /// Release notes (Markdown) from `latest.json`.
    notes: Option<String>,
    date: Option<String>,
    /// Release page with the full changelog.
    url: String,
    /// Where `latest.json` came from (an internal share, GitHub).
    source: String,
}

impl UpdateInfo {
    fn of(o: &Offer) -> Self {
        UpdateInfo {
            version: o.version.clone(),
            notes: o.notes.clone(),
            date: o.date.clone(),
            url: core::release_url(&o.version),
            source: o.source.clone(),
        }
    }
}

#[derive(Serialize)]
struct RollbackInfo {
    from: String,
    to: String,
    created: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct UpdateStatus {
    /// The build has an update key: checking and installing work.
    enabled: bool,
    current_version: String,
    /// Found by an earlier check and not installed yet.
    available: Option<UpdateInfo>,
    /// Portable copy: a new version is downloaded from the release page, not installed.
    portable: bool,
    /// Installed as .deb/.rpm: the new package comes from the release page, not installed.
    package: bool,
    /// The Microsoft Store build: the Store updates it (`enabled` is false).
    store: bool,
    /// The first call after a start that followed an update: which version, and whether it runs now.
    restarted: Option<AfterUpdate>,
    /// What applies (the policy's values over the settings), and which fields are managed.
    policy: Effective,
    /// Where the policy came from (registry key, file).
    policy_origins: Vec<String>,
    /// The install window allows installing now.
    install_now: bool,
    skipped: Option<String>,
    remind_after: Option<DateTime<Utc>>,
    bad_versions: Vec<String>,
    whats_new_seen: Option<String>,
    download: DownloadState,
    /// A downloaded, verified update waits for the quit.
    ready: Option<String>,
    /// „Zur vorherigen Version zurückkehren“ is possible.
    rollback: Option<RollbackInfo>,
    /// Reported once after a rollback.
    rolled_back: Option<rollback::Notice>,
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

fn not_configured() -> Error {
    if crate::store::active() {
        return Error::State(crate::store::updates_from_store().into());
    }
    Error::State(core::not_configured().into())
}

fn install_failed(what: &str, e: &InstallError) -> Error {
    crate::devlog::error("update", format!("{what}: {e:?}"));
    Error::State(format!("{what}: {}", e.message()))
}

fn feed_failed(what: &str, e: &FeedError) -> Error {
    crate::devlog::error("update", format!("{what}: {e:?}"));
    Error::State(format!("{what}: {}", e.message()))
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.clone()
}

fn updates_dir(app: &AppHandle) -> PathBuf {
    data_dir(app).join(st::UPDATES_DIR)
}

/// The policy's values over the user's settings.
fn effective(app: &AppHandle) -> Effective {
    let settings = app.state::<crate::AppState>().settings();
    annalo_core::update_policy::effective(crate::policy::get(), &settings.updates, settings.auto_update_check)
}

fn install_window_open(eff: &Effective) -> bool {
    eff.install_window.is_none_or(|w| w.contains(chrono::Local::now().time()))
}

/// The client of `service` (the feed and downloads, or release notes) with its profile of
/// Settings → Netzwerk.
fn http_client(app: &AppHandle, service: Service) -> Result<reqwest::Client> {
    crate::network::client_for(&app.state::<crate::AppState>(), &service)
}

/// The first feed address on the network (the per-service test of Settings → Netzwerk).
pub fn feed_url(app: &AppHandle) -> Option<String> {
    sources(&effective(app)).into_iter().find_map(|s| match s {
        Source::Url(u) => Some(u),
        Source::Folder(_) => None,
    })
}

/// Where the release notes of `version` are read from.
pub fn release_notes_url(version: &str) -> String {
    format!("https://raw.githubusercontent.com/{}/main/docs/releases/v{version}.md", core::REPOSITORY)
}

fn sources(eff: &Effective) -> Vec<Source> {
    let github: Vec<String> = match test_var("ANNALO_UPDATE_ENDPOINT") {
        Some(url) => vec![url],
        None => feed::GITHUB_FEEDS.iter().map(|s| s.to_string()).collect(),
    };
    feed::sources(eff.source_url.as_deref(), eff.allow_github_fallback, &github)
}

fn state_changed(app: &AppHandle) {
    let _ = app.emit("update://state", ());
    crate::desktop::refresh_tray(app);
}

/// The tray tooltip's line about a running download or a ready update.
pub fn tray_tip(app: &AppHandle, base: String) -> String {
    let Some(updates) = app.try_state::<Updates>() else { return base };
    let d = lock(&updates.download).clone();
    let version = lock(&updates.offer).as_ref().map(|o| o.version.clone()).unwrap_or_default();
    match d.phase {
        Phase::Downloading => match d.percent {
            Some(p) => trf!("{base}\nUpdate {version}: {p} %", "{base}\nUpdate {version}: {p} %"),
            None => trf!("{base}\nUpdate {version} wird geladen", "{base}\nDownloading update {version}"),
        },
        Phase::Paused => trf!("{base}\nUpdate {version} pausiert", "{base}\nUpdate {version} paused"),
        Phase::Ready => trf!("{base}\nUpdate {version} bereit", "{base}\nUpdate {version} ready"),
        _ => base,
    }
}

/// At start: a verified download of an earlier session is still waiting (unless it is old).
pub fn load_staged(app: &AppHandle) {
    // A data folder shared with an installed copy may hold its download: not this copy's.
    if pubkey().is_none() {
        return;
    }
    let dir = updates_dir(app);
    let staged: Option<Staged> =
        std::fs::read_to_string(dir.join(STAGED_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok());
    let current = current_version(app);
    match staged {
        Some(s) if s.path.is_file() && core::is_newer(&current, &s.version) => {
            *lock(&app.state::<Updates>().staged) = Some(s);
        }
        Some(s) => {
            let _ = std::fs::remove_file(&s.path);
            let _ = std::fs::remove_file(dir.join(STAGED_FILE));
        }
        None => {}
    }
}

#[tauri::command]
pub fn update_status(app: AppHandle, updates: State<Updates>) -> UpdateStatus {
    let eff = effective(&app);
    let state = UpdateState::load(&data_dir(&app));
    let current = current_version(&app);
    let staged = lock(&updates.staged).clone();
    let offer = lock(&updates.offer).clone();
    let ready =
        staged.as_ref().filter(|s| offer.as_ref().is_some_and(|o| o.version == s.version)).map(|s| s.version.clone());
    let rollback = RollbackRecord::load(&data_dir(&app))
        .filter(|r| !crate::store::active() && r.can_return(&current))
        .map(|r| RollbackInfo { from: r.from, to: r.to, created: r.created });
    UpdateStatus {
        enabled: pubkey().is_some(),
        current_version: current,
        available: offer.as_ref().map(UpdateInfo::of),
        portable: crate::portable::active(),
        package: packaged(),
        store: crate::store::active(),
        restarted: lock(&updates.after).take(),
        install_now: install_window_open(&eff),
        policy: eff,
        policy_origins: crate::policy::get().origins.clone(),
        skipped: state.skipped,
        remind_after: state.remind_after.filter(|t| *t > Utc::now()),
        bad_versions: state.bad_versions,
        whats_new_seen: state.whats_new_seen,
        download: lock(&updates.download).clone(),
        ready,
        rollback,
        rolled_back: lock(&updates.rolled_back).take(),
    }
}

/// Asks the feed sources for a newer version. In the mode „automatisch“ a new version starts
/// downloading in the background; nothing is installed here. `manual`: the user clicked
/// „Jetzt nach Updates suchen“ (that also ends a running „Später erinnern“).
#[tauri::command(async)]
#[tracing::instrument(name = "update_check", skip_all, fields(source = "update"))]
pub async fn update_check(
    app: AppHandle,
    updates: State<'_, Updates>,
    manual: Option<bool>,
) -> Result<Option<UpdateInfo>> {
    if pubkey().is_none() {
        return Err(not_configured());
    }
    let eff = effective(&app);
    if eff.disabled {
        return Err(Error::State(
            tr!("Deine Organisation hat Updates abgeschaltet", "Updates are turned off by your organization").into(),
        ));
    }
    if updates.installing.load(Ordering::SeqCst) {
        return Err(Error::State(tr!("Das Update wird gerade installiert", "The update is being installed").into()));
    }
    let what = tr!("Update-Prüfung fehlgeschlagen", "Update check failed");
    let list = sources(&eff);
    if list.is_empty() {
        return Err(Error::State(format!(
            "{what}: {}",
            tr!("Keine Update-Quelle eingerichtet", "No update source is set up")
        )));
    }
    let client = http_client(&app, Service::Updates)?;
    let found = match feed::fetch(&client, &list).await {
        Ok(found) => found,
        Err(errors) => {
            for (source, e) in &errors {
                crate::devlog::warn("update", format!("{}: {e:?}", source.label()));
            }
            let first = errors.into_iter().next().map(|(_, e)| e).unwrap_or(FeedError::Missing);
            return Err(feed_failed(what, &first));
        }
    };
    let dir = data_dir(&app);
    let mut state = UpdateState::load(&dir);
    if manual == Some(true) && state.remind_after.take().is_some() {
        let _ = state.save(&dir);
    }
    let current = current_version(&app);
    let m = &found.manifest;
    let verdict = st::verdict(&current, &m.version, eff.pinned_version.as_deref(), &state, Utc::now());
    crate::devlog::debug("update", format!("check via {}: {} is {verdict:?}", found.source.label(), m.version));
    if verdict != Verdict::Offer {
        *lock(&updates.offer) = None;
        state_changed(&app);
        return Ok(None);
    }
    let entry = feed::platform(m, &targets()).ok_or_else(|| feed_failed(what, &FeedError::NoPlatform))?;
    let offer = Offer {
        version: m.version.trim().trim_start_matches('v').to_string(),
        notes: m.notes.clone().filter(|n| !n.trim().is_empty()),
        date: m.pub_date.as_deref().and_then(|d| d.get(..10)).map(str::to_string),
        signature: entry.signature.clone(),
        location: feed::locate(&found.source, &entry.url),
        source: if found.source.is_github() { "GitHub".into() } else { found.source.label() },
    };
    let info = UpdateInfo::of(&offer);
    let changed = lock(&updates.offer).as_ref().is_none_or(|o| o.version != offer.version);
    *lock(&updates.offer) = Some(offer);
    if changed {
        let staged = lock(&updates.staged).clone();
        let ready = staged.as_ref().is_some_and(|s| s.version == info.version);
        *lock(&updates.download) =
            DownloadState { phase: if ready { Phase::Ready } else { Phase::Idle }, ..Default::default() };
    }
    let can_install = core::manual_update_reason(crate::portable::active(), packaged()).is_none();
    if eff.mode == UpdateMode::Auto && can_install {
        start_download(&app);
    }
    state_changed(&app);
    Ok(Some(info))
}

/// Starts (or resumes) the background download of the offered update.
fn start_download(app: &AppHandle) {
    let updates = app.state::<Updates>();
    if updates.installing.load(Ordering::SeqCst) || updates.downloading.swap(true, Ordering::SeqCst) {
        return;
    }
    updates.pause.store(false, Ordering::SeqCst);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let res = ensure_staged(&app).await;
        let updates = app.state::<Updates>();
        updates.downloading.store(false, Ordering::SeqCst);
        match res {
            Ok(Some(s)) => {
                crate::devlog::info("update", format!("{} downloaded and verified", s.version));
                crate::notifyact::update_ready(&app, &s.version);
            }
            Ok(None) => crate::devlog::debug("update", "download paused"),
            Err(e) => {
                crate::devlog::warn("update", format!("background download: {e}"));
                lock(&updates.download).error = Some(e.to_string());
                lock(&updates.download).phase = Phase::Failed;
            }
        }
        state_changed(&app);
    });
}

/// „Fortsetzen“ after a pause or a failed download.
#[tauri::command]
pub fn update_download(app: AppHandle, updates: State<Updates>) -> Result<()> {
    if lock(&updates.offer).is_none() {
        return Err(Error::State(tr!("Kein Update gefunden", "No update found").into()));
    }
    if let Some(why) = core::manual_update_reason(crate::portable::active(), packaged()) {
        return Err(Error::State(why.into()));
    }
    start_download(&app);
    Ok(())
}

/// „Pausieren“: the download stops after the current chunk; the part file stays.
#[tauri::command]
pub fn update_pause(updates: State<Updates>) {
    updates.pause.store(true, Ordering::SeqCst);
}

/// Downloads (resuming a part) and verifies the offered update; `None` when paused.
#[tracing::instrument(name = "update_download", skip_all, fields(source = "update"))]
async fn ensure_staged(app: &AppHandle) -> Result<Option<Staged>> {
    let updates = app.state::<Updates>();
    let offer = lock(&updates.offer)
        .clone()
        .ok_or_else(|| Error::State(tr!("Kein Update gefunden", "No update found").into()))?;
    if let Some(s) = lock(&updates.staged).clone().filter(|s| s.version == offer.version && s.path.is_file()) {
        *lock(&updates.download) = DownloadState { phase: Phase::Ready, ..Default::default() };
        return Ok(Some(s));
    }
    let key = pubkey().ok_or_else(not_configured)?;
    let dir = updates_dir(app);
    let part = dir.join(format!("{}.part", offer.version));
    let what = tr!("Download fehlgeschlagen", "Download failed");
    *lock(&updates.download) = DownloadState { phase: Phase::Downloading, ..Default::default() };
    state_changed(app);
    let client = http_client(app, Service::Updates)?;
    let (mut last, mut reported, mut tray) = (None, 0u64, None::<u8>);
    let step = feed::download(&client, &offer.location, &part, &updates.pause, |downloaded, total| {
        let percent = core::progress_percent(downloaded, total);
        // One event per percent, or per 512 KiB while the size is unknown.
        if percent != last || (percent.is_none() && downloaded - reported >= 512 * 1024) {
            (last, reported) = (percent, downloaded);
            *lock(&updates.download) =
                DownloadState { phase: Phase::Downloading, downloaded, total, percent, error: None };
            let _ = app.emit("update://progress", Progress { downloaded, total, percent });
            if percent.map(|p| p / 10) != tray {
                tray = percent.map(|p| p / 10);
                crate::desktop::refresh_tray(app);
            }
        }
    })
    .await
    .map_err(|e| {
        *lock(&updates.download) =
            DownloadState { phase: Phase::Failed, error: Some(e.message()), ..Default::default() };
        feed_failed(what, &e)
    })?;
    if step == feed::Step::Paused {
        lock(&updates.download).phase = Phase::Paused;
        return Ok(None);
    }
    let bytes = std::fs::read(&part)?;
    if let Err(e) = feed::verify(&bytes, &offer.signature, key, &offer.version) {
        // A tampered or broken file is never kept, nor resumed.
        let _ = std::fs::remove_file(&part);
        *lock(&updates.download) =
            DownloadState { phase: Phase::Failed, error: Some(e.message()), ..Default::default() };
        return Err(feed_failed(what, &e));
    }
    let path = dir.join(format!("{}.update", offer.version));
    std::fs::rename(&part, &path)?;
    // Older downloads go.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let ours = p == path;
            if !ours && p.extension().is_some_and(|x| x == "update" || x == "part") {
                let _ = std::fs::remove_file(p);
            }
        }
    }
    let staged = Staged { version: offer.version.clone(), signature: offer.signature.clone(), path };
    let _ = std::fs::write(dir.join(STAGED_FILE), serde_json::to_string(&staged).unwrap_or_default());
    *lock(&updates.staged) = Some(staged.clone());
    *lock(&updates.download) = DownloadState { phase: Phase::Ready, percent: Some(100), ..Default::default() };
    Ok(Some(staged))
}

/// Downloads (if needed), verifies and installs the offered update, then restarts. The UI has
/// stored all editors before calling this. On Windows the NSIS installer runs passively and
/// starts the new version itself.
#[tauri::command(async)]
pub async fn update_install(app: AppHandle, updates: State<'_, Updates>) -> Result<()> {
    if pubkey().is_none() {
        return Err(not_configured());
    }
    // A portable copy would be installed into the user profile instead of updating its folder.
    if let Some(why) = core::manual_update_reason(crate::portable::active(), packaged()) {
        return Err(Error::State(why.into()));
    }
    if lock(&updates.offer).is_none() {
        return Err(Error::State(tr!("Kein Update gefunden", "No update found").into()));
    }
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::State(
            tr!("Das Update wird bereits installiert", "The update is already being installed").into(),
        ));
    }
    let res = async {
        if !install_window_open(&effective(&app)) {
            return Err(Error::State(outside_window(&effective(&app))));
        }
        // A background download may be running: it is paused and continued here.
        if updates.downloading.load(Ordering::SeqCst) {
            updates.pause.store(true, Ordering::SeqCst);
            for _ in 0..100 {
                if !updates.downloading.load(Ordering::SeqCst) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        // Still running (a stalled chunk): never two downloads into the same part file.
        if updates.downloading.swap(true, Ordering::SeqCst) {
            updates.pause.store(false, Ordering::SeqCst);
            return Err(Error::State(
                tr!(
                    "Der Download läuft noch – bitte gleich noch einmal versuchen",
                    "The download is still running – please try again in a moment"
                )
                .into(),
            ));
        }
        updates.pause.store(false, Ordering::SeqCst);
        let staged = ensure_staged(&app).await;
        updates.downloading.store(false, Ordering::SeqCst);
        let staged = staged?.ok_or_else(|| Error::State(tr!("Download pausiert", "Download paused").into()))?;
        install(&app, &staged, true).await
    }
    .await;
    updates.installing.store(false, Ordering::SeqCst);
    if res.is_err() {
        state_changed(&app);
    }
    res?;
    // Not reached on Windows (the installer ends this process); elsewhere the new binary is in place.
    crate::devlog::info("update", "installed, restarting");
    crate::restart(&app)
}

fn outside_window(eff: &Effective) -> String {
    let w = eff.install_window.map(|w| w.label()).unwrap_or_default();
    trf!("Deine Organisation erlaubt Updates nur zwischen {}", "Your organization allows updates only between {}", w)
}

/// „Jetzt neu starten“ on the hint of a downloaded update.
#[tauri::command(async)]
pub async fn update_restart_now(app: AppHandle, updates: State<'_, Updates>) -> Result<()> {
    let staged = lock(&updates.staged).clone().ok_or_else(|| {
        Error::State(tr!("Das Update ist noch nicht geladen", "The update has not been downloaded yet").into())
    })?;
    if !install_window_open(&effective(&app)) {
        return Err(Error::State(outside_window(&effective(&app))));
    }
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::State(
            tr!("Das Update wird bereits installiert", "The update is already being installed").into(),
        ));
    }
    updates.quit_handled.store(true, Ordering::SeqCst);
    let res = install(&app, &staged, true).await;
    updates.installing.store(false, Ordering::SeqCst);
    if let Err(e) = res {
        updates.quit_handled.store(false, Ordering::SeqCst);
        return Err(e);
    }
    if rollback::fake_install() {
        app.exit(0);
        return Ok(());
    }
    crate::restart(&app)
}

/// The quit installs a waiting update (mode „automatisch“, inside the install window, not
/// snoozed or skipped). Returns whether one was installed.
fn install_on_quit(app: &AppHandle) -> bool {
    let Some(updates) = app.try_state::<Updates>() else { return false };
    if updates.quit_handled.swap(true, Ordering::SeqCst) || pubkey().is_none() {
        return false;
    }
    let Some(staged) = lock(&updates.staged).clone().filter(|s| s.path.is_file()) else { return false };
    let eff = effective(app);
    if eff.mode != UpdateMode::Auto || core::manual_update_reason(crate::portable::active(), packaged()).is_some() {
        return false;
    }
    if !install_window_open(&eff) {
        crate::devlog::info("update", format!("{} waits for the install window", staged.version));
        return false;
    }
    let state = UpdateState::load(&data_dir(app));
    let current = current_version(app);
    let verdict = st::verdict(&current, &staged.version, eff.pinned_version.as_deref(), &state, Utc::now());
    if verdict != Verdict::Offer {
        crate::devlog::info("update", format!("{} not installed on quit: {verdict:?}", staged.version));
        return false;
    }
    if updates.installing.swap(true, Ordering::SeqCst) {
        return false;
    }
    crate::devlog::info("update", format!("installing {} on quit", staged.version));
    let res = tauri::async_runtime::block_on(install(app, &staged, false));
    updates.installing.store(false, Ordering::SeqCst);
    match res {
        Ok(()) => true,
        Err(e) => {
            crate::devlog::error("update", format!("install on quit failed: {e}"));
            false
        }
    }
}

/// „Beenden“ (tray, ⌘Q, the menu) after the UI stored its editors: installs a waiting update,
/// then ends the app. On Windows the installer ends this process itself.
pub fn quit(app: &AppHandle) {
    install_on_quit(app);
    app.exit(0);
}

/// The process ends without the UI's quit (macOS: Dock „Beenden“, logging out). Replacing the
/// bundle or the AppImage takes a moment and is done here; the Windows installer is not
/// started during a shutdown (the update stays ready for the next quit).
pub fn on_exit(app: &AppHandle) {
    if cfg!(windows) {
        return;
    }
    install_on_quit(app);
}

/// Backs up the database, keeps the running version, notes the restart, then installs the
/// verified file (`installer.rs`). `restart`: the Windows installer starts the new version.
#[tracing::instrument(name = "update_install", skip_all, fields(source = "update", version = %staged.version, restart))]
async fn install(app: &AppHandle, staged: &Staged, restart: bool) -> Result<()> {
    let what = tr!("Installation fehlgeschlagen", "Installation failed");
    let key = pubkey().ok_or_else(not_configured)?;
    let bytes = std::fs::read(&staged.path)?;
    // Checked again: the file waited in the data folder since its download.
    feed::verify(&bytes, &staged.signature, key, &staged.version).map_err(|e| feed_failed(what, &e))?;
    let dir = data_dir(app);
    let from = current_version(app);
    let backup = pre_update_backup(app, &from, &staged.version);
    rollback::keep_previous(&dir, &from, &staged.version, backup);
    // The next start shows its window (even when autostarted minimized) and says what happened.
    if let Err(e) = core::write_restart_marker(&dir, &staged.version, Some(&from)) {
        crate::devlog::warn("update", format!("restart note not written: {e}"));
    }
    if rollback::fake_install() {
        let note = serde_json::json!({ "version": staged.version, "from": from, "restart": restart });
        std::fs::write(dir.join(st::UPDATES_DIR).join("fake-install.json"), note.to_string())?;
        return Ok(());
    }
    let target = installer::Target::current(app, &staged.version, restart).map_err(|e| {
        core::clear_restart_marker(&dir);
        install_failed(what, &e)
    })?;
    let handle = app.clone();
    // Windows: once the installer is written, the workspace is closed and the tray icon goes
    // right before it starts; a started installer ends this process.
    installer::install(&bytes, &target, move || {
        crate::prepare_exit(&handle);
        handle.cleanup_before_exit();
    })
    .map_err(|e| {
        core::clear_restart_marker(&dir);
        // Windows: the installer could not be started after the workspace was closed for it.
        crate::resume_after_failed_exit(app);
        install_failed(what, &e)
    })
}

/// `arcalo-pre-update-<from>-<to>.db` in the backup folder (not counted by the rotation).
fn pre_update_backup(app: &AppHandle, from: &str, to: &str) -> Option<PathBuf> {
    let state = app.state::<crate::AppState>();
    let name = st::pre_update_backup_name(from, to);
    let tag = format!("{}pre-update-", annalo_core::backup::PREFIX);
    let dir = state.backup_dir();
    let db = state.db();
    match annalo_core::backup::backup_named(&db, &dir, &name, &tag, 2) {
        Ok(p) => Some(p),
        Err(e) => {
            crate::devlog::error("update", format!("backup before the update failed: {e}"));
            None
        }
    }
}

/// „Diese Version überspringen“: not offered again (the next newer one is); the download goes.
#[tauri::command]
pub fn update_skip(app: AppHandle, updates: State<Updates>, version: String) -> Result<()> {
    let dir = data_dir(&app);
    let mut state = UpdateState::load(&dir);
    state.skipped = Some(version.trim().trim_start_matches('v').to_string());
    state.save(&dir)?;
    updates.pause.store(true, Ordering::SeqCst);
    if let Some(s) = lock(&updates.staged).take() {
        let _ = std::fs::remove_file(&s.path);
        let _ = std::fs::remove_file(updates_dir(&app).join(STAGED_FILE));
    }
    let _ = std::fs::remove_file(updates_dir(&app).join(format!("{}.part", version.trim())));
    *lock(&updates.offer) = None;
    *lock(&updates.download) = DownloadState::default();
    crate::devlog::info("update", format!("version {version} skipped"));
    state_changed(&app);
    Ok(())
}

/// „Rückgängig“ for a skipped version, and the end of „Später erinnern“.
#[tauri::command]
pub fn update_unskip(app: AppHandle) -> Result<()> {
    let dir = data_dir(&app);
    let mut state = UpdateState::load(&dir);
    state.skipped = None;
    state.remind_after = None;
    state.save(&dir)?;
    state_changed(&app);
    Ok(())
}

/// „Später erinnern“: no hint and no install for `days` days (a downloaded file stays).
#[tauri::command]
pub fn update_remind(app: AppHandle, updates: State<Updates>, days: u32) -> Result<DateTime<Utc>> {
    let dir = data_dir(&app);
    let mut state = UpdateState::load(&dir);
    let at = Utc::now() + chrono::Duration::days(days.clamp(1, 30) as i64);
    state.remind_after = Some(at);
    state.save(&dir)?;
    updates.pause.store(true, Ordering::SeqCst);
    *lock(&updates.offer) = None;
    *lock(&updates.download) = DownloadState::default();
    state_changed(&app);
    Ok(at)
}

/// The „Neu in …“ dialog of `version` was shown.
#[tauri::command]
pub fn update_whats_new_seen(app: AppHandle, version: String) -> Result<()> {
    let dir = data_dir(&app);
    let mut state = UpdateState::load(&dir);
    state.whats_new_seen = Some(version);
    state.save(&dir)?;
    Ok(())
}

/// „Zur vorherigen Version zurückkehren“ (Settings → Über).
#[tauri::command]
pub fn update_rollback(app: AppHandle) -> Result<()> {
    if crate::store::active() {
        return Err(not_configured());
    }
    let current = current_version(&app);
    rollback::return_now(&app, &data_dir(&app), &current)?;
    // Test runs go on in this process with the restored database.
    *lock(&app.state::<Updates>().rolled_back) = rollback::take_notice(&data_dir(&app));
    state_changed(&app);
    Ok(())
}

/// The release notes of `version` from the repository (versions whose notes the app does not bundle).
#[tauri::command(async)]
pub async fn update_release_notes(app: AppHandle, version: String) -> Result<String> {
    let v = version.trim().trim_start_matches('v');
    if semver::Version::parse(v).is_err() {
        return Err(Error::State(format!("version {version}")));
    }
    let url = release_notes_url(v);
    let res = http_client(&app, Service::ReleaseNotes)?.get(&url).send().await?;
    if !res.status().is_success() {
        return Err(Error::State(trf!("Keine Versionshinweise für {} gefunden", "No release notes found for {}", v)));
    }
    Ok(res.text().await?)
}

/// The window loaded on an opened and migrated database: this version starts fine.
pub fn mark_healthy(app: &AppHandle) {
    if crate::store::active() {
        return;
    }
    if let Some(state) = app.try_state::<crate::AppState>() {
        st::mark_healthy(&state.data_dir, &current_version(app));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_feeds_match_the_config() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let endpoints: Vec<&str> =
            conf["plugins"]["updater"]["endpoints"].as_array().unwrap().iter().filter_map(|e| e.as_str()).collect();
        assert_eq!(endpoints, feed::GITHUB_FEEDS);
    }
}
