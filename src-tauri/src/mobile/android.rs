//! The app's Kotlin plugins around the WebView (`gen/android/.../ShellPlugin.kt`) and for its
//! updates (`UpdatePlugin.kt`): the colors behind the system bars, the back button at the root,
//! text shared to the app, the window and the device for the choice between the phone app and
//! the full app, files picked with Android's document picker, Android's proxy and the user's
//! certificates for the Git sync, what
//! Android knows about the installed app and a downloaded APK, the network, the permission to
//! install apps and the hand-over to Android's installer.
//!
//! Like the Keystore calls (`keystore.rs`) these block until Kotlin answers, and some answer only
//! after the user came back from a system screen: they run on worker threads, never on the main
//! thread.

use std::sync::OnceLock;

use arcalo_core::update_android::PackageFacts;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tauri::Wry;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

static SHELL: OnceLock<PluginHandle<Wry>> = OnceLock::new();
static UPDATE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

/// Package of the Kotlin plugins.
const PACKAGE: &str = "de.mousewerk.arcalo";

/// Registers both Kotlin plugins.
pub fn plugin() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("arcalo-android")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let _ = SHELL.set(api.register_android_plugin(PACKAGE, "ShellPlugin")?);
                let _ = UPDATE.set(api.register_android_plugin(PACKAGE, "UpdatePlugin")?);
            }
            #[cfg(not(target_os = "android"))]
            let _ = (api, PACKAGE);
            Ok(())
        })
        .build()
}

fn call<T: DeserializeOwned>(
    handle: &OnceLock<PluginHandle<Wry>>,
    command: &str,
    args: impl Serialize,
) -> Result<T, String> {
    let handle = handle.get().ok_or_else(|| "the Android plugins are not ready".to_owned())?;
    handle.run_mobile_plugin(command, args).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct NoArgs {}

#[derive(Serialize)]
struct PathArgs<'a> {
    path: &'a str,
}

// ------------------------------------------------------------------ window

#[derive(Deserialize)]
struct Shared {
    text: Option<String>,
}

/// Text shared to the app („Teilen“ → Arcalo) since the last call, once.
pub fn shared_text() -> Result<Option<String>, String> {
    let s: Shared = call(&SHELL, "sharedText", NoArgs {})?;
    Ok(s.text.filter(|t| !t.trim().is_empty()))
}

#[derive(Serialize)]
struct Bars<'a> {
    dark: bool,
    top: &'a str,
    bottom: &'a str,
}

/// The window colors behind the status bar (`top`) and the navigation bar (`bottom`), as
/// `#rrggbb`, and dark or light icons on them.
pub fn set_bars(dark: bool, top: &str, bottom: &str) -> Result<(), String> {
    call::<serde_json::Value>(&SHELL, "setBars", Bars { dark, top, bottom }).map(|_| ())
}

/// The app to the background (the back button on the start screen).
pub fn move_to_back() -> Result<(), String> {
    call::<serde_json::Value>(&SHELL, "moveToBack", NoArgs {}).map(|_| ())
}

/// What Android says about the app's window and the device, for the choice between the phone app
/// and the full app (`ui/src/lib/uimode.ts`, `DisplayFacts`). Sizes in dp.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct DisplayFacts {
    pub width: i32,
    pub height: i32,
    pub smallest_width: i32,
    pub pc: bool,
    pub desk: bool,
    pub freeform: bool,
    pub multi_window: bool,
    pub external: bool,
    pub mouse: bool,
    pub keyboard: bool,
    /// An iPad (iOS only, `ios.rs`): the full app goes by the window's width there.
    pub ipad: bool,
}

/// The window's size, its mode and display, a mouse and a keyboard (`ShellPlugin.display`).
pub fn display() -> Result<DisplayFacts, String> {
    call(&SHELL, "display", NoArgs {})
}

// ------------------------------------------------------------------- files

#[derive(Serialize)]
struct UriArgs<'a> {
    uri: &'a str,
}

#[derive(Serialize)]
struct CopyArgs<'a> {
    uri: &'a str,
    path: &'a str,
}

#[derive(Deserialize)]
struct Named {
    name: String,
}

/// The name Android shows for a file picked with its document picker (`content://…`).
pub fn uri_name(uri: &str) -> Result<String, String> {
    call::<Named>(&SHELL, "uriName", UriArgs { uri }).map(|n| n.name)
}

/// Copies the picked file at `uri` into the local file `path`.
pub fn copy_from_uri(uri: &str, path: &str) -> Result<(), String> {
    call::<serde_json::Value>(&SHELL, "copyFromUri", CopyArgs { uri, path }).map(|_| ())
}

/// Copies the local file `path` to the file at `uri` that the document picker created.
pub fn copy_to_uri(path: &str, uri: &str) -> Result<(), String> {
    call::<serde_json::Value>(&SHELL, "copyToUri", CopyArgs { uri, path }).map(|_| ())
}

#[derive(Serialize)]
struct OpenArgs<'a> {
    path: &'a str,
}

/// Opens an attachment with the app Android has for its type: a copy in the cache's `open`
/// folder (the only one the app hands to other apps besides the update, `res/xml/file_paths.xml`).
pub fn open_file(cache: &std::path::Path, file: &std::path::Path) -> Result<(), String> {
    let dir = cache.join("open");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let copy = dir.join(crate::picked::safe_name(&name));
    std::fs::copy(file, &copy).map_err(|e| e.to_string())?;
    call::<serde_json::Value>(&SHELL, "openFile", OpenArgs { path: &copy.to_string_lossy() }).map(|_| ())
}

// ----------------------------------------------------------------- network

/// `android.net.ProxyInfo` as the Kotlin plugin passes it on (all empty without a proxy).
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct ProxyFacts {
    host: Option<String>,
    port: i32,
    exclusions: String,
    pac: Option<String>,
}

/// Android's proxy (global, else the one of the network in use) as the system proxy of the
/// network settings.
pub fn system_proxy() -> Result<arcalo_core::network::SystemProxy, String> {
    let p: ProxyFacts = call(&SHELL, "proxy", NoArgs {})?;
    Ok(arcalo_core::network::android_proxy(p.host.as_deref(), p.port, &p.exclusions, p.pac.as_deref()))
}

#[derive(Deserialize)]
struct Pem {
    pem: String,
}

/// The CA certificates the user installed on the phone, as PEM (empty without any).
pub fn user_certificates() -> Result<String, String> {
    call::<Pem>(&SHELL, "userCertificates", NoArgs {}).map(|p| p.pem)
}

// ----------------------------------------------------------------- updates

/// The installed app as Android's package manager knows it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    #[serde(flatten)]
    pub facts: PackageFacts,
    /// May the app hand APKs to the installer („Unbekannte Apps installieren“)?
    pub can_install: bool,
}

pub fn installed() -> Result<Installed, String> {
    call(&UPDATE, "installed", NoArgs {})
}

/// A downloaded APK as Android reads it (an empty package when it cannot read it).
pub fn archive(path: &str) -> Result<PackageFacts, String> {
    call(&UPDATE, "archive", PathArgs { path })
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Network {
    pub connected: bool,
    pub metered: bool,
}

pub fn network() -> Result<Network, String> {
    call(&UPDATE, "network", NoArgs {})
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CanInstall {
    can_install: bool,
}

/// Opens Android's „Unbekannte Apps installieren“ page of the app; answers whether the app may
/// install now (after the user came back).
pub fn open_install_settings() -> Result<bool, String> {
    call::<CanInstall>(&UPDATE, "openInstallSettings", NoArgs {}).map(|c| c.can_install)
}

/// How the hand-over to the installer went.
#[derive(Debug, Clone, Deserialize)]
pub struct Install {
    pub started: bool,
    /// `permission`, `missing` or `installer` when it did not start.
    #[serde(default)]
    pub reason: Option<String>,
}

pub fn install(path: &str) -> Result<Install, String> {
    call(&UPDATE, "install", PathArgs { path })
}
