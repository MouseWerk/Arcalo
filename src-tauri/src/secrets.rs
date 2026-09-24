//! Storage for secrets: the API keys of the AI providers, the Git access token and the proxy
//! password.
//!
//! Windows: Credential Manager, macOS: Keychain. Elsewhere (Linux
//! and other systems) the secrets are written to `secrets.json` in the app data directory
//! with owner-only permissions, one JSON field per secret.
//!
//! Portable mode: the credential store belongs to the user of the computer, not to the data
//! folder on the stick. A portable copy names its entries `<account>@<namespace>`
//! (`datadir::secret_namespace` of its data folder), so it neither reads nor overwrites the
//! secrets of an installed Annalo or of another portable copy. Secrets therefore do not travel
//! with the folder: on another computer they are entered once more (the settings say so).

use std::path::{Path, PathBuf};

const SERVICE: &str = "Annalo";

pub struct SecretStore {
    /// Credential account name (Windows/macOS).
    #[cfg_attr(not(any(windows, target_os = "macos")), allow(dead_code))]
    account: String,
    /// Field in the fallback file.
    #[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
    field: String,
    #[cfg_attr(any(windows, target_os = "macos"), allow(dead_code))]
    file: PathBuf,
}

impl SecretStore {
    fn named(data_dir: &Path, account: &str, field: &str) -> Self {
        SecretStore {
            account: account_name(account, data_dir, crate::portable::active()),
            field: field.into(),
            file: data_dir.join("secrets.json"),
        }
    }

    /// The LiteLLM API key: the key of the provider migrated from the LiteLLM settings.
    pub fn new(data_dir: &Path) -> Self {
        Self::named(data_dir, "litellm-api-key", "litellm_api_key")
    }

    /// The API key of the AI provider `id` (`[a-z0-9-]`); the provider `litellm` keeps the
    /// credential of earlier versions.
    pub fn provider(data_dir: &Path, id: &str) -> Self {
        if id == annalo_core::ai::provider::LEGACY_ID {
            return Self::new(data_dir);
        }
        Self::named(data_dir, &format!("ai-provider-{id}"), &format!("ai_provider_{}", id.replace('-', "_")))
    }

    /// The access token of the Git sync.
    pub fn git(data_dir: &Path) -> Self {
        Self::named(data_dir, "git-token", "git_token")
    }

    /// The password of the proxy (Settings → Netzwerk).
    pub fn proxy(data_dir: &Path) -> Self {
        Self::named(data_dir, annalo_core::network::PASSWORD_ACCOUNT, "proxy_password")
    }

    /// Human-readable name of the backend, shown in the settings.
    pub fn backend(&self) -> &'static str {
        let portable = crate::portable::active();
        if cfg!(windows) && portable {
            "Windows-Anmeldeinformationsverwaltung dieses Rechners (portabler Modus: nicht auf dem Datenträger)"
        } else if cfg!(windows) {
            "Windows-Anmeldeinformationsverwaltung"
        } else if cfg!(target_os = "macos") && portable {
            "macOS-Schlüsselbund dieses Rechners (portabler Modus: nicht auf dem Datenträger)"
        } else if cfg!(target_os = "macos") {
            "macOS-Schlüsselbund"
        } else {
            "Datei im App-Datenordner (nur für den Benutzer lesbar)"
        }
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub fn get(&self) -> Option<String> {
        keyring::Entry::new(SERVICE, &self.account).ok()?.get_password().ok().filter(|k| !k.is_empty())
    }

    #[cfg(any(windows, target_os = "macos"))]
    pub fn set(&self, key: Option<&str>) -> Result<(), String> {
        let entry = keyring::Entry::new(SERVICE, &self.account).map_err(|e| e.to_string())?;
        match key.filter(|k| !k.is_empty()) {
            Some(k) => entry.set_password(k).map_err(|e| e.to_string()),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(e.to_string()),
            },
        }
    }

    /// The stored secrets; `Err` when the file exists but cannot be read as such (damaged).
    #[cfg(not(any(windows, target_os = "macos")))]
    fn read_file(&self) -> Result<serde_json::Map<String, serde_json::Value>, ()> {
        let Ok(raw) = std::fs::read_to_string(&self.file) else { return Ok(Default::default()) };
        serde_json::from_str::<serde_json::Value>(&raw).ok().and_then(|v| v.as_object().cloned()).ok_or(())
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn get(&self) -> Option<String> {
        let _ = (SERVICE, &self.account);
        self.read_file().ok()?.get(&self.field)?.as_str().filter(|k| !k.is_empty()).map(str::to_owned)
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn set(&self, key: Option<&str>) -> Result<(), String> {
        let mut map = self.read_file().unwrap_or_else(|()| {
            // A damaged file is kept for a look, never silently overwritten.
            let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
            let _ = std::fs::rename(&self.file, self.file.with_extension(format!("json.broken-{stamp}")));
            Default::default()
        });
        match key.filter(|k| !k.is_empty()) {
            Some(k) => {
                map.insert(self.field.clone(), k.into());
            }
            None => {
                map.remove(&self.field);
            }
        }
        if map.is_empty() {
            return match std::fs::remove_file(&self.file) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            };
        }
        write_private(&self.file, serde_json::Value::Object(map).to_string().as_bytes()).map_err(|e| e.to_string())
    }
}

/// Writes `bytes` to `path` readable by the user only from the first byte on (never world
/// readable, not even briefly), through a synced temporary file and a rename, so a crash leaves
/// the old file or the new one, never half of it.
#[cfg(not(any(windows, target_os = "macos")))]
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let tmp = path.with_extension("json.part");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let res = (|| {
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    res
}

/// The credential's account name: a portable copy adds the namespace of its data folder.
fn account_name(account: &str, data_dir: &Path, portable: bool) -> String {
    if portable {
        format!("{account}@{}", annalo_core::datadir::secret_namespace(data_dir))
    } else {
        account.to_owned()
    }
}

#[cfg(test)]
mod namespace_tests {
    use super::*;

    #[test]
    fn portable_copies_use_their_own_credentials() {
        let a = std::env::temp_dir().join(format!("annalo-ns-a-{}", std::process::id()));
        let b = std::env::temp_dir().join(format!("annalo-ns-b-{}", std::process::id()));
        assert_eq!(account_name("git-token", &a, false), "git-token", "installed: as before");
        let pa = account_name("git-token", &a, true);
        assert!(pa.starts_with("git-token@") && pa.len() == "git-token@".len() + 12, "{pa}");
        assert_ne!(pa, account_name("git-token", &b, true));
        assert_eq!(pa, account_name("git-token", &a, true));
    }
}

#[cfg(all(test, not(any(windows, target_os = "macos"))))]
mod tests {
    use super::*;

    #[test]
    fn two_secrets_share_the_fallback_file() {
        let dir = std::env::temp_dir().join(format!("annalo-secrets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (ai, git) = (SecretStore::new(&dir), SecretStore::git(&dir));
        ai.set(Some("sk-1")).unwrap();
        git.set(Some("ghp-2")).unwrap();
        assert_eq!((ai.get().as_deref(), git.get().as_deref()), (Some("sk-1"), Some("ghp-2")));
        // One key per provider; the LiteLLM provider reads the key of earlier versions.
        let (openai, mistral) = (SecretStore::provider(&dir, "openai"), SecretStore::provider(&dir, "mistral-ai"));
        openai.set(Some("sk-o")).unwrap();
        assert_eq!(SecretStore::provider(&dir, "litellm").get().as_deref(), Some("sk-1"));
        assert_eq!((openai.get().as_deref(), mistral.get()), (Some("sk-o"), None));
        openai.set(None).unwrap();
        git.set(None).unwrap();
        assert_eq!((ai.get().as_deref(), git.get()), (Some("sk-1"), None));
        ai.set(None).unwrap();
        assert!(!dir.join("secrets.json").exists(), "empty file removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_file_is_private_and_a_damaged_one_is_kept() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("annalo-secrets2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = SecretStore::git(&dir);
        git.set(Some("ghp-1")).unwrap();
        let mode = std::fs::metadata(dir.join("secrets.json")).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        // Cut off by a crash in an earlier version: nothing is read, and nothing overwritten.
        std::fs::write(dir.join("secrets.json"), "{\"git-token\": \"ghp").unwrap();
        assert_eq!(git.get(), None);
        SecretStore::new(&dir).set(Some("sk-2")).unwrap();
        let broken =
            std::fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("broken"));
        assert!(broken, "the damaged file is kept");
        assert_eq!(SecretStore::new(&dir).get().as_deref(), Some("sk-2"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
