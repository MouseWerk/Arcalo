//! Auto-update: checks the GitHub release feed (`latest.json`), downloads the signed
//! installer and restarts into the new version. Only switched on when the build compiled in
//! the updater's public key (`ANNALO_UPDATER_PUBKEY`, set by the release workflow); other
//! builds never contact the update server. Nothing is installed without the user's click:
//! the UI asks, stores all open editors and only then calls [`update_install`].

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use annalo_core::Error;
use annalo_core::update as core;
use serde::Serialize;
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{Result, lock};

/// Public key of the signing keypair, compiled in by the release build.
pub fn pubkey() -> Option<&'static str> {
    core::configured_pubkey(option_env!("ANNALO_UPDATER_PUBKEY"))
}

/// The updater plugin, or `None` in builds without a key (the app then runs without it).
/// Endpoint and Windows install mode come from `plugins.updater` in `tauri.conf.json`.
pub fn plugin<R: Runtime>() -> Option<TauriPlugin<R, tauri_plugin_updater::Config>> {
    pubkey().map(|key| tauri_plugin_updater::Builder::new().pubkey(key).build())
}

#[derive(Default)]
pub struct Updates {
    /// The update found by the last check; installed on the user's click.
    pending: Mutex<Option<Update>>,
    installing: AtomicBool,
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

fn failed(what: &str, e: impl std::fmt::Display) -> Error {
    let err = Error::State(format!("{what}: {e}"));
    crate::devlog::error("update", err.to_string());
    err
}

#[tauri::command]
pub fn update_status(app: AppHandle, updates: State<Updates>) -> UpdateStatus {
    UpdateStatus {
        enabled: pubkey().is_some(),
        current_version: app.package_info().version.to_string(),
        available: lock(&updates.pending).as_ref().map(UpdateInfo::of),
        portable: crate::portable::active(),
    }
}

/// Asks the release feed for a newer version. Never installs anything.
#[tauri::command(async)]
pub async fn update_check(app: AppHandle, updates: State<'_, Updates>) -> Result<Option<UpdateInfo>> {
    if pubkey().is_none() {
        return Err(not_configured());
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
    let updater = app
        .updater_builder()
        .configure_client(move |b| network.apply(b))
        .on_before_exit(move || crate::prepare_exit(&handle))
        .build()
        .map_err(|e| failed("Update-Prüfung nicht möglich", e))?;
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
    if crate::portable::active() {
        // The installer would install Annalo into the user profile instead of updating the stick.
        return Err(Error::State(
            "Im portablen Modus wird nicht automatisch installiert – bitte die neue Version von der Release-Seite herunterladen"
                .into(),
        ));
    }
    let update = lock(&updates.pending).clone().ok_or_else(|| Error::State("Kein Update gefunden".into()))?;
    if updates.installing.swap(true, Ordering::SeqCst) {
        return Err(Error::State("Das Update wird bereits installiert".into()));
    }
    let res = download_and_install(&app, &update).await;
    updates.installing.store(false, Ordering::SeqCst);
    res?;
    // Not reached on Windows (the installer ends this process); elsewhere the new binary is in place.
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
    update.install(bytes).map_err(|e| failed("Installation fehlgeschlagen", e))
}
