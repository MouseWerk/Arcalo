//! Storage for secrets: the API keys of the AI providers, the Git access token and the proxy
//! password.
//!
//! Windows: Credential Manager, macOS: Keychain. Elsewhere (Linux
//! and other systems) the secrets are written to `secrets.json` in the app data directory
//! with owner-only permissions, one JSON field per secret.

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
        SecretStore { account: account.into(), field: field.into(), file: data_dir.join("secrets.json") }
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
        if cfg!(windows) {
            "Windows-Anmeldeinformationsverwaltung"
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

    #[cfg(not(any(windows, target_os = "macos")))]
    fn read_file(&self) -> serde_json::Map<String, serde_json::Value> {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|v| v.as_object().cloned())
            .unwrap_or_default()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn get(&self) -> Option<String> {
        let _ = (SERVICE, &self.account);
        self.read_file().get(&self.field)?.as_str().filter(|k| !k.is_empty()).map(str::to_owned)
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn set(&self, key: Option<&str>) -> Result<(), String> {
        let mut map = self.read_file();
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
        std::fs::write(&self.file, serde_json::Value::Object(map).to_string()).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
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
}
