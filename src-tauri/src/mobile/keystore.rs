//! Secrets on Android: the Git access token (and every other secret the shared code keeps) in
//! the Android Keystore. The Kotlin part (`SecretsPlugin.kt` in `gen/android`) holds an AES key
//! that never leaves the Keystore and keeps only the encrypted values in the app's private
//! storage; nothing is written in plain text.
//!
//! The calls block until Kotlin answers, so they must never run on the main thread (the Kotlin
//! side runs there): the app's commands that touch secrets run on worker threads.

use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use tauri::Wry;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};

static HANDLE: OnceLock<PluginHandle<Wry>> = OnceLock::new();

/// Package and class of the Kotlin plugin.
const PACKAGE: &str = "de.mousewerk.arcalo";
const CLASS: &str = "SecretsPlugin";

/// Registers the Kotlin plugin; [`get`]/[`set`]/[`delete`] work once the app is set up.
pub fn plugin() -> TauriPlugin<Wry> {
    Builder::<Wry>::new("arcalo-secrets")
        .setup(|_app, api| {
            #[cfg(target_os = "android")]
            {
                let handle = api.register_android_plugin(PACKAGE, CLASS)?;
                let _ = HANDLE.set(handle);
            }
            #[cfg(not(target_os = "android"))]
            let _ = (api, PACKAGE, CLASS);
            Ok(())
        })
        .build()
}

#[derive(Serialize)]
struct Account<'a> {
    account: &'a str,
}

#[derive(Serialize)]
struct Put<'a> {
    account: &'a str,
    secret: &'a str,
}

#[derive(Deserialize)]
struct Got {
    secret: Option<String>,
}

fn handle() -> Result<&'static PluginHandle<Wry>, String> {
    HANDLE.get().ok_or_else(|| "the Android Keystore is not ready".to_owned())
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    let got: Got = handle()?.run_mobile_plugin("get", Account { account }).map_err(|e| e.to_string())?;
    Ok(got.secret.filter(|s| !s.is_empty()))
}

pub fn set(account: &str, secret: &str) -> Result<(), String> {
    let _: serde_json::Value =
        handle()?.run_mobile_plugin("set", Put { account, secret }).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete(account: &str) -> Result<(), String> {
    let _: serde_json::Value = handle()?.run_mobile_plugin("delete", Account { account }).map_err(|e| e.to_string())?;
    Ok(())
}
