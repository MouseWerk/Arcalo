//! Settings → Protokoll „Diagnosepaket erstellen“: one zip for a bug report with the version
//! and the system, the effective settings (redacted, no secrets), the newest log files
//! (redacted once more) and the database schema version. The user picks where it goes.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use tauri::{AppHandle, State};

use crate::{AppState, Result, devlog, secrets};
use annalo_core::Error;

/// Names of setting fields whose value is never put into the bundle (a secret may hide in an
/// address or a header, too).
fn secret_key(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["token", "password", "passwd", "secret", "api_key", "apikey", "credential", "authorization", "header"]
        .iter()
        .any(|s| k.contains(s))
        // The settings sync's wider list (`*_key`, `pin`, cookies, private keys) as well.
        || annalo_core::settings_sync::is_secret_name(key)
}

/// Redacts a settings value: secret-looking keys become `***`, every string goes through the
/// log's redaction (credentials in URLs, key formats, `token=` values).
pub fn redact_settings(v: &mut Value) {
    match v {
        Value::Object(map) => {
            for (k, val) in map.iter_mut() {
                if secret_key(k) && !matches!(val, Value::Bool(_) | Value::Null) {
                    *val = Value::String("***".into());
                } else {
                    redact_settings(val);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(redact_settings),
        Value::String(s) => *s = devlog::clean_line(s),
        _ => {}
    }
}

/// The home folder in paths becomes `~` (the user name is not needed for a bug report).
fn without_home(text: &str) -> String {
    let home = std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).unwrap_or_default();
    if home.len() <= 1 {
        return text.to_owned();
    }
    // Also as written in JSON (Windows paths with escaped backslashes).
    text.replace(&home, "~").replace(&home.replace('\\', "\\\\"), "~")
}

/// The operating system's name and version as far as it tells.
fn os_version() -> String {
    #[cfg(target_os = "linux")]
    {
        let release = std::fs::read_to_string("/etc/os-release").unwrap_or_default();
        let pretty =
            release.lines().find_map(|l| l.strip_prefix("PRETTY_NAME=")).map(|s| s.trim_matches('"').to_owned());
        let kernel = std::fs::read_to_string("/proc/sys/kernel/osrelease").unwrap_or_default();
        format!("{} (kernel {})", pretty.unwrap_or_else(|| "Linux".into()), kernel.trim())
    }
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        let get = |name: &str| key.as_ref().ok().and_then(|k| k.get_value::<String, _>(name).ok()).unwrap_or_default();
        format!("{} {} (build {})", get("ProductName"), get("DisplayVersion"), get("CurrentBuild"))
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers").arg("-productVersion").output();
        format!("macOS {}", out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default())
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    std::env::consts::OS.to_owned()
}

/// A short name of the system for the issue forms of „Feedback geben“ and „Fehler melden“
/// ("Windows 11 24H2", "macOS 15.1", "Ubuntu 24.04.1 LTS"): no edition, build or kernel.
pub fn os_name() -> String {
    #[cfg(target_os = "linux")]
    {
        pretty_name(&std::fs::read_to_string("/etc/os-release").unwrap_or_default()).unwrap_or_else(|| "Linux".into())
    }
    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_LOCAL_MACHINE;
        let key = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        let get = |name: &str| key.as_ref().ok().and_then(|k| k.get_value::<String, _>(name).ok()).unwrap_or_default();
        windows_name(&get("CurrentBuild"), &get("DisplayVersion"))
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("sw_vers").arg("-productVersion").output();
        let version = out.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned()).unwrap_or_default();
        format!("macOS {version}").trim_end().to_owned()
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    std::env::consts::OS.to_owned()
}

/// `PRETTY_NAME` of an os-release file.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn pretty_name(os_release: &str) -> Option<String> {
    os_release
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))
        .map(|s| s.trim().trim_matches('"').to_owned())
        .filter(|s| !s.is_empty())
}

/// Windows 11 still calls itself „Windows 10“ in `ProductName`; the build tells them apart.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_name(build: &str, display_version: &str) -> String {
    let major = if build.trim().parse::<u32>().is_ok_and(|b| b >= 22000) { "11" } else { "10" };
    format!("Windows {major} {}", display_version.trim()).trim_end().to_owned()
}

/// The entries of the bundle (name, bytes).
pub fn contents(
    info: Value,
    settings: &annalo_core::settings::Settings,
    logs: Vec<(String, Vec<u8>)>,
) -> Vec<(String, Vec<u8>)> {
    let mut settings = serde_json::to_value(settings).unwrap_or(Value::Null);
    redact_settings(&mut settings);
    let pretty = |v: &Value| serde_json::to_vec_pretty(v).unwrap_or_default();
    let mut out = vec![
        ("info.json".to_owned(), pretty(&info)),
        // Folders in the settings name the user, too.
        ("settings.json".to_owned(), without_home(&String::from_utf8_lossy(&pretty(&settings))).into_bytes()),
        (
            "README.txt".to_owned(),
            b"Arcalo diagnostics bundle: version and system (info.json), the effective settings without \
              secrets (settings.json) and the newest developer log files (logs/). Credentials are removed.\n"
                .to_vec(),
        ),
    ];
    out.extend(logs.into_iter().map(|(name, bytes)| (format!("logs/{name}"), bytes)));
    out
}

pub fn write_zip(path: &Path, entries: &[(String, Vec<u8>)]) -> std::io::Result<()> {
    let tmp = path.with_extension("zip.part");
    let res = (|| {
        let mut zip = zip::ZipWriter::new(std::fs::File::create(&tmp)?);
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, bytes) in entries {
            zip.start_file(name.as_str(), opts).map_err(std::io::Error::other)?;
            zip.write_all(bytes)?;
        }
        zip.finish().map_err(std::io::Error::other)?.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// Writes the bundle to `path` (from the save dialog); returns the path written.
#[tauri::command(async)]
pub fn diagnostics_bundle(app: AppHandle, state: State<AppState>, path: PathBuf) -> Result<String> {
    let path =
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("zip")) { path } else { path.with_extension("zip") };
    let settings = state.settings();
    let schema = state.reader().schema_version().ok();
    let info = json!({
        "app": "Arcalo",
        "version": crate::updates::current_version(&app),
        "build": if cfg!(debug_assertions) { "debug" } else { "release" },
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "os_version": os_version(),
        "portable": crate::portable::active(),
        "language": if annalo_core::i18n::is_en() { "en" } else { "de" },
        "data_dir": without_home(&state.data_dir.display().to_string()),
        "schema_version": schema,
        "credential_store": secrets::kind(),
        "log_level": devlog::level().as_str(),
        "log_level_env": devlog::env_override(),
        "created": chrono::Local::now().to_rfc3339(),
    });
    let logs = devlog::bundle_files()
        .into_iter()
        .map(|(n, b)| (n, without_home(&String::from_utf8_lossy(&b)).into_bytes()))
        .collect();
    write_zip(&path, &contents(info, &settings, logs)).map_err(|e| Error::file(&path, e))?;
    devlog::info("core", format!("diagnostics bundle written: {}", without_home(&path.display().to_string())));
    Ok(path.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn the_bundle_holds_info_settings_and_logs_but_no_secrets() {
        let mut settings = annalo_core::settings::Settings::default();
        settings.git_sync.remote_url = "https://bob:ghp_supersecret123@github.com/x/y.git".into();
        settings.network.profiles[0].http_proxy = "http://proxyuser:proxy-pass-9@proxy:8080".into();
        settings.litellm_base_url = "https://llm.example.com/v1?api_key=sk-hidden-777".into();
        let info = json!({ "version": "1.10.0", "schema_version": 21 });
        let logs = vec![("arcalo.log".to_owned(), b"2026-10-01T10:00:00.000+02:00 INFO [git] ok\n".to_vec())];
        let entries = contents(info, &settings, logs);
        let names: Vec<&str> = entries.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["info.json", "settings.json", "README.txt", "logs/arcalo.log"]);
        let all: String = entries.iter().map(|(_, b)| String::from_utf8_lossy(b).into_owned()).collect();
        for secret in ["ghp_supersecret123", "proxy-pass-9", "sk-hidden-777"] {
            assert!(!all.contains(secret), "{secret}");
        }
        let s: Value = serde_json::from_slice(&entries[1].1).unwrap();
        assert_eq!(s["git_sync"]["remote_url"], "https://***@github.com/x/y.git");
        assert!(all.contains("\"schema_version\": 21"));

        // Written as a real zip.
        let dir = std::env::temp_dir().join(format!("annalo-diag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("diag.zip");
        write_zip(&file, &entries).unwrap();
        let mut zip = zip::ZipArchive::new(std::fs::File::open(&file).unwrap()).unwrap();
        let mut text = String::new();
        zip.by_name("logs/arcalo.log").unwrap().read_to_string(&mut text).unwrap();
        assert!(text.contains("[git] ok"));
        assert!(!dir.join("diag.zip.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_system_name_is_short() {
        assert_eq!(windows_name("26100", "24H2"), "Windows 11 24H2");
        assert_eq!(windows_name("19045", "22H2"), "Windows 10 22H2");
        assert_eq!(windows_name("", ""), "Windows 10");
        let release = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nID=ubuntu\n";
        assert_eq!(pretty_name(release).as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(pretty_name("ID=arch\n"), None);
    }

    #[test]
    fn secret_looking_keys_are_hidden_whatever_their_value() {
        let mut v =
            json!({ "jira": [{ "api_token": "plain", "site": "x" }], "headers": "X-Key: 1", "use_token": true });
        redact_settings(&mut v);
        assert_eq!(v, json!({ "jira": [{ "api_token": "***", "site": "x" }], "headers": "***", "use_token": true }));
    }
}
