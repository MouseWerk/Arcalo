//! Auto-update: checks the GitHub release feed (`latest.json`), downloads the signed
//! installer and restarts into the new version. Only switched on when the build compiled in
//! the updater's public key (`ANNALO_UPDATER_PUBKEY`, set by the release workflow); other
//! builds never contact the update server. Nothing is installed without the user's click:
//! the UI asks, stores all open editors and only then calls [`update_install`].
//!
//! Debug builds take a test feed and key from `ANNALO_UPDATE_ENDPOINT` / `ANNALO_UPDATE_PUBKEY`
//! (end-to-end tests with a local server); release builds ignore both.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use annalo_core::Error;
use annalo_core::update::{self as core, AfterUpdate};
use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Error as UpdaterError, Update, UpdaterExt};

use crate::{Result, lock};

/// A download that receives nothing for this long is given up (a stalled proxy or connection).
const READ_TIMEOUT: Duration = Duration::from_secs(60);

fn test_var(name: &str) -> Option<String> {
    core::test_override(cfg!(debug_assertions), std::env::var(name).ok().as_deref()).map(str::to_string)
}

/// Public key of the signing keypair, compiled in by the release build.
pub fn pubkey() -> Option<&'static str> {
    static KEY: OnceLock<Option<String>> = OnceLock::new();
    KEY.get_or_init(|| {
        test_var("ANNALO_UPDATE_PUBKEY")
            .or_else(|| core::configured_pubkey(option_env!("ANNALO_UPDATER_PUBKEY")).map(str::to_string))
    })
    .as_deref()
}

/// The updater plugin, or `None` in builds without a key (the app then runs without it).
/// Endpoint and Windows install mode come from `plugins.updater` in `tauri.conf.json`.
pub fn plugin<R: Runtime>() -> Option<TauriPlugin<R, tauri_plugin_updater::Config>> {
    pubkey().map(|key| tauri_plugin_updater::Builder::new().pubkey(key).build())
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

#[derive(Default)]
pub struct Updates {
    /// The update found by the last check; installed on the user's click.
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
    /// This start follows an update (reported once to the UI).
    after: Mutex<Option<AfterUpdate>>,
}

impl Updates {
    pub fn after(after: Option<AfterUpdate>) -> Self {
        Updates { after: Mutex::new(after), ..Default::default() }
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
}

impl UpdateInfo {
    fn of(u: &Update) -> Self {
        UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone().filter(|b| !b.trim().is_empty()),
            date: u.date.map(|d| d.date().to_string()),
            url: core::release_url(&u.version),
        }
    }
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
    /// The first call after a start that followed an update: which version, and whether it runs now.
    restarted: Option<AfterUpdate>,
}

#[derive(Serialize, Clone)]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
    percent: Option<u8>,
}

fn not_configured() -> Error {
    Error::State(core::NOT_CONFIGURED.into())
}

/// What went wrong, in words a user can act on; the technical detail goes to the log.
fn reason(e: &UpdaterError) -> String {
    match e {
        UpdaterError::Reqwest(r) if r.is_timeout() => "Zeitüberschreitung – der Update-Server antwortet nicht".into(),
        UpdaterError::Reqwest(r) if r.is_connect() => {
            "Keine Verbindung zum Update-Server (offline, oder Proxy unter Einstellungen → Netzwerk prüfen)".into()
        }
        UpdaterError::Reqwest(r) if r.is_body() || r.is_decode() => "Die Verbindung wurde unterbrochen".into(),
        UpdaterError::Reqwest(r) => format!("Netzwerkfehler ({r})"),
        UpdaterError::ReleaseNotFound => "Der Update-Server hat keine Versionsinformation geliefert".into(),
        UpdaterError::Serialization(_) | UpdaterError::Semver(_) => "Die Versionsinformation ist ungültig".into(),
        UpdaterError::TargetNotFound(_) | UpdaterError::TargetsNotFound(_) => {
            "Für dieses System gibt es in dieser Version kein Update-Paket".into()
        }
        UpdaterError::Network(msg) => format!("Der Server hat die Datei nicht geliefert ({})", msg.trim_matches('`')),
        UpdaterError::Minisign(_)
        | UpdaterError::Base64(_)
        | UpdaterError::SignatureUtf8(_)
        | UpdaterError::SignedVersionMismatch { .. }
        | UpdaterError::MissingSignedVersion => {
            "Die Signatur des Updates ist ungültig – die Datei wurde verworfen, es wurde nichts installiert".into()
        }
        UpdaterError::Io(io) if io.kind() == std::io::ErrorKind::StorageFull => {
            "Nicht genug freier Speicherplatz".into()
        }
        UpdaterError::Io(io) if io.kind() == std::io::ErrorKind::PermissionDenied => {
            format!("Keine Schreibrechte für den Programmordner ({io})")
        }
        other => other.to_string(),
    }
}

fn failed(what: &str, e: UpdaterError) -> Error {
    crate::devlog::error("update", format!("{what}: {e} ({e:?})"));
    Error::State(format!("{what}: {}", reason(&e)))
}

#[tauri::command]
pub fn update_status(app: AppHandle, updates: State<Updates>) -> UpdateStatus {
    UpdateStatus {
        enabled: pubkey().is_some(),
        current_version: app.package_info().version.to_string(),
        available: lock(&updates.pending).as_ref().map(UpdateInfo::of),
        portable: crate::portable::active(),
        package: packaged(),
        restarted: lock(&updates.after).take(),
    }
}

/// Asks the release feed for a newer version. Never installs anything.
#[tauri::command(async)]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<Option<UpdateInfo>> {
    if pubkey().is_none() {
        return Err(not_configured());
    }
    if updates.installing.load(Ordering::SeqCst) {
        return Err(Error::State("Das Update wird gerade installiert".into()));
    }
    // Windows: the installer ends this process; the workspace is closed cleanly first.
    let handle = app.clone();
    // Proxy and extra CA (Settings → Netzwerk) for the check and the download.
    let network = {
        let state = app.state::<crate::AppState>();
        let settings = state.settings();
        let password = state.proxy_secret.get();
        annalo_core::network::Prepared::new(
            &settings.network,
            password.as_deref(),
            annalo_core::network::Purpose::Updates,
        )?
    };
    let mut builder = app
        .updater_builder()
        .version_comparator(|current, release| core::is_newer(&current.to_string(), &release.version.to_string()))
        .configure_client(move |b| network.apply(b).read_timeout(READ_TIMEOUT))
        .on_before_exit(move || {
            crate::prepare_exit(&handle);
            // What the plugin does by default: the tray icon goes, the windows hide.
            handle.cleanup_before_exit();
        });
    if let Some(url) = test_var("ANNALO_UPDATE_ENDPOINT") {
        let url = url.parse().map_err(|e| Error::State(format!("ANNALO_UPDATE_ENDPOINT: {e}")))?;
        builder = builder.endpoints(vec![url]).map_err(|e| failed("Update-Prüfung nicht möglich", e))?;
    }
    let updater = builder.build().map_err(|e| failed("Update-Prüfung nicht möglich", e))?;
    let found = updater.check().await.map_err(|e| failed("Update-Prüfung fehlgeschlagen", e))?;
    let info = found.as_ref().map(UpdateInfo::of);
    crate::devlog::debug(
        "update",
        format!("check done: {}", found.as_ref().map_or("up to date", |u| u.version.as_str())),
    );
    *lock(&updates.pending) = found;
    Ok(info)
}

/// Downloads (with `update://progress` events), verifies and installs the update found by
/// the last check, then restarts. The UI has stored all editors before calling this. On
/// Windows the NSIS installer runs passively and starts the new version itself.
#[tauri::command(async)]
pub async fn update_install(app: AppHandle, updates: State<'_, Updates>) -> Result<()> {
    if pubkey().is_none() {
        return Err(not_configured());
    }
    // A portable copy would be installed into the user profile instead of updating its folder.
    if let Some(why) = core::manual_update_reason(crate::portable::active(), packaged()) {
        return Err(Error::State(why.into()));
    }
    let update = lock(&updates.pending).clone().ok_or_else(|| Error::State("Kein Update gefunden".into()))?;
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::State("Das Update wird bereits installiert".into()));
    }
    let res = download_and_install(&app, &update).await;
    updates.installing.store(false, Ordering::SeqCst);
    res?;
    // Not reached on Windows (the installer ends this process); elsewhere the new binary is in place.
    crate::devlog::info("update", format!("installed {}, restarting", update.version));
    crate::restart(&app)
}

async fn download_and_install(app: &AppHandle, update: &Update) -> Result<()> {
    let (mut downloaded, mut reported) = (0u64, 0u64);
    let mut last = None;
    let bytes = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                let percent = core::progress_percent(downloaded, total);
                // One event per percent, or per 512 KiB while the size is unknown.
                if percent != last || (percent.is_none() && downloaded - reported >= 512 * 1024) {
                    (last, reported) = (percent, downloaded);
                    let _ = app.emit("update://progress", Progress { downloaded, total, percent });
                }
            },
            || {},
        )
        .await
        .map_err(|e| failed("Download fehlgeschlagen", e))?;
    // The next start shows its window (even when autostarted minimized) and says what happened.
    let dir = app.state::<crate::AppState>().data_dir.clone();
    if let Err(e) = core::write_restart_marker(&dir, &update.version) {
        crate::devlog::warn("update", format!("restart note not written: {e}"));
    }
    update.install(bytes).map_err(|e| {
        core::clear_restart_marker(&dir);
        // Windows: the installer could not be started after the workspace was closed for it.
        crate::resume_after_failed_exit(app);
        failed("Installation fehlgeschlagen", e)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_are_explained() {
        assert_eq!(reason(&UpdaterError::ReleaseNotFound), "Der Update-Server hat keine Versionsinformation geliefert");
        assert!(reason(&UpdaterError::TargetsNotFound(vec!["linux-x86_64".into()])).contains("kein Update-Paket"));
        assert_eq!(
            reason(&UpdaterError::Network("`Download request failed with status: 404 Not Found`".into())),
            "Der Server hat die Datei nicht geliefert (Download request failed with status: 404 Not Found)"
        );
        let mismatch = UpdaterError::SignedVersionMismatch { signed: "1.5.0".into(), announced: "1.6.0".into() };
        assert!(reason(&mismatch).contains("Signatur"));
        assert!(reason(&mismatch).contains("nichts installiert"));
        let full = UpdaterError::Io(std::io::Error::from(std::io::ErrorKind::StorageFull));
        assert_eq!(reason(&full), "Nicht genug freier Speicherplatz");
    }
}
