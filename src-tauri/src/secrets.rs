//! Storage for secrets: the API keys of the AI providers, the Git access token, the proxy
//! password, the addresses of calendar subscriptions and the Jira tokens.
//!
//! Windows: Credential Manager, macOS: Keychain, Linux: the Secret Service (GNOME Keyring,
//! KWallet, KeePassXC) over D-Bus, Android: the Android Keystore (`mobile/keystore.rs`). Only
//! when no Secret Service answers (a headless machine, a desktop without a keyring,
//! `ANNALO_SECRET_STORE=file`) and on other systems, the secrets are written to `secrets.json`
//! in the app data directory with owner-only permissions, one JSON field per secret;
//! Settings → Datenschutz says which store is used and why.
//!
//! Linux before 1.10 always used the file: on the first start with a Secret Service its entries
//! are moved over ([`migrate`]): each one is written, read back and compared, and only then
//! removed from the file; the file goes once it is empty. A crash in between repeats the step
//! on the next start. A secret not moved yet is still read from the file.
//!
//! Portable mode: the credential store belongs to the user of the computer, not to the data
//! folder on the stick. A portable copy names its entries `<account>@<namespace>`
//! (`datadir::secret_namespace` of its data folder), so it neither reads nor overwrites the
//! secrets of an installed copy or of another portable copy. Secrets therefore do not travel
//! with the folder: on another computer they are entered once more (the settings say so).

use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

/// Service name of every entry in the credential store. It stays "Annalo" after the rename to
/// Arcalo (1.7): the API keys, tokens and passwords saved by earlier versions live under it, and
/// a new name would make them look lost. Users never see it outside the system's own credential
/// manager. Do not change it without a migration of all entries.
const SERVICE: &str = "Annalo";
const FILE: &str = "secrets.json";
/// `ANNALO_SECRET_STORE=file`: keep the file even when a Secret Service runs.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
const FORCE_ENV: &str = "ANNALO_SECRET_STORE";

type Res<T> = std::result::Result<T, String>;

/// The store this machine uses (decided once per process).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Kind {
    /// Windows Credential Manager or the macOS keychain.
    Native,
    /// Linux: the Secret Service over D-Bus.
    SecretService,
    /// `secrets.json` (0600); `reason`: why no Secret Service is used (the system's words).
    File { reason: Option<String> },
    /// Android: encrypted with a key of the Android Keystore.
    #[cfg(target_os = "android")]
    Keystore,
}

static KIND: OnceLock<Kind> = OnceLock::new();
static MIGRATED: Mutex<Option<Migration>> = Mutex::new(None);

/// The store of this process: the Secret Service is asked once (with a timeout).
pub fn kind() -> &'static Kind {
    KIND.get_or_init(detect)
}

fn detect() -> Kind {
    // Unit tests never touch the user's real keyring.
    if cfg!(test) {
        return Kind::File { reason: Some("test".into()) };
    }
    if cfg!(any(windows, target_os = "macos")) {
        return Kind::Native;
    }
    #[cfg(target_os = "linux")]
    {
        choose(std::env::var(FORCE_ENV).ok().as_deref(), probe)
    }
    #[cfg(target_os = "android")]
    {
        Kind::Keystore
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    Kind::File { reason: None }
}

/// The Linux choice: the Secret Service when `probe` reaches it, else the file. `forced` is
/// `ANNALO_SECRET_STORE` (`file` keeps the file).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn choose(forced: Option<&str>, probe: impl FnOnce() -> Res<()>) -> Kind {
    if forced.map(str::trim).is_some_and(|f| f.eq_ignore_ascii_case("file")) {
        return Kind::File { reason: Some(format!("{FORCE_ENV}=file")) };
    }
    match probe() {
        Ok(()) => Kind::SecretService,
        Err(e) => Kind::File { reason: Some(e) },
    }
}

/// Looks up an entry that never exists: „not found“ means the Secret Service answers. In a
/// thread with a timeout, so a hanging D-Bus never blocks the start.
#[cfg(target_os = "linux")]
fn probe() -> Res<()> {
    let (tx, rx) = std::sync::mpsc::channel();
    let spawned = std::thread::Builder::new().name("secret-probe".into()).spawn(move || {
        let res = keyring::Entry::new(SERVICE, "annalo-probe").and_then(|e| e.get_password().map(drop));
        let _ = tx.send(match res {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        });
    });
    if let Err(e) = spawned {
        return Err(e.to_string());
    }
    rx.recv_timeout(std::time::Duration::from_secs(3))
        .unwrap_or_else(|_| Err("the Secret Service did not answer within 3 s".into()))
}

/// One place secrets can be kept. `account` names the entry in a credential store, `field`
/// the same secret in the file.
pub trait Backend {
    fn get(&self, account: &str, field: &str) -> Res<Option<String>>;
    fn set(&self, account: &str, field: &str, secret: &str) -> Res<()>;
    fn delete(&self, account: &str, field: &str) -> Res<()>;
}

/// The OS credential store (Credential Manager, Keychain, Secret Service).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub struct Keyring;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl Backend for Keyring {
    fn get(&self, account: &str, _field: &str) -> Res<Option<String>> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(k) => Ok(Some(k).filter(|k| !k.is_empty())),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, _field: &str, secret: &str) -> Res<()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        entry.set_password(secret).map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str, _field: &str) -> Res<()> {
        let entry = keyring::Entry::new(SERVICE, account).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

/// `secrets.json` in the data folder, readable by the user only.
pub struct SecretFile {
    pub path: PathBuf,
}

type Fields = serde_json::Map<String, serde_json::Value>;

impl SecretFile {
    /// The stored secrets; `Err` when the file exists but cannot be read as such (damaged).
    fn read(&self) -> std::result::Result<Fields, ()> {
        let Ok(raw) = std::fs::read_to_string(&self.path) else { return Ok(Default::default()) };
        serde_json::from_str::<serde_json::Value>(&raw).ok().and_then(|v| v.as_object().cloned()).ok_or(())
    }

    /// Writes `map`; an empty one removes the file.
    fn write(&self, map: Fields) -> Res<()> {
        if map.is_empty() {
            return match std::fs::remove_file(&self.path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(e.to_string()),
            };
        }
        write_private(&self.path, serde_json::Value::Object(map).to_string().as_bytes()).map_err(|e| e.to_string())
    }

    fn update(&self, f: impl FnOnce(&mut Fields)) -> Res<()> {
        let mut map = self.read().unwrap_or_else(|()| {
            // A damaged file is kept for a look, never silently overwritten.
            let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
            let _ = std::fs::rename(&self.path, self.path.with_extension(format!("json.broken-{stamp}")));
            Default::default()
        });
        f(&mut map);
        self.write(map)
    }
}

impl Backend for SecretFile {
    fn get(&self, _account: &str, field: &str) -> Res<Option<String>> {
        let map = self.read().map_err(|()| format!("{FILE} is damaged"))?;
        Ok(map.get(field).and_then(|v| v.as_str()).filter(|k| !k.is_empty()).map(str::to_owned))
    }

    fn set(&self, _account: &str, field: &str, secret: &str) -> Res<()> {
        self.update(|m| {
            m.insert(field.into(), secret.into());
        })
    }

    fn delete(&self, _account: &str, field: &str) -> Res<()> {
        if !self.path.exists() {
            return Ok(());
        }
        self.update(|m| {
            m.remove(field);
        })
    }
}

pub struct SecretStore {
    /// Credential account name (credential stores).
    account: String,
    /// Field in the file.
    field: String,
    file: SecretFile,
}

impl SecretStore {
    fn named(data_dir: &Path, account: &str, field: &str) -> Self {
        SecretStore {
            account: account_name(account, data_dir, crate::portable::active()),
            field: field.into(),
            file: SecretFile { path: data_dir.join(FILE) },
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

    /// The proxy password of the network profile `id` (the default profile keeps the
    /// credential of earlier versions).
    pub fn proxy_profile(data_dir: &Path, id: &str) -> Self {
        if id == annalo_core::network::DEFAULT_PROFILE {
            return Self::proxy(data_dir);
        }
        Self::named(
            data_dir,
            &annalo_core::network::password_account(id),
            &format!("proxy_password_{}", id.replace('-', "_")),
        )
    }

    /// The address of the ICS subscription `id` (Settings → Kalender): it may carry a secret token.
    pub fn calendar(data_dir: &Path, id: &str) -> Self {
        Self::named(data_dir, &format!("calendar-ics-{id}"), &format!("calendar_ics_{id}"))
    }

    /// The API token (Cloud) or personal access token (Server) of the Jira site `id` (Settings → Jira).
    pub fn jira(data_dir: &Path, id: &str) -> Self {
        Self::named(data_dir, &format!("jira-{id}"), &format!("jira_{}", id.replace('-', "_")))
    }

    /// The key of the encrypted database (hex; Settings → Sicherheit). Per computer: a portable
    /// copy elsewhere opens with the recovery key or the password (`cipher::WrappedKey`).
    pub fn db_key(data_dir: &Path) -> Self {
        Self::named(data_dir, "db-key", "db_key")
    }

    /// The new key of a key change (Settings → Sicherheit → „Schlüssel wechseln“) until the
    /// database is switched to it; then it becomes [`SecretStore::db_key`].
    pub fn db_key_next(data_dir: &Path) -> Self {
        Self::named(data_dir, "db-key-next", "db_key_next")
    }

    /// The Argon2id hash of the app lock's PIN (never the PIN itself).
    pub fn app_lock_pin(data_dir: &Path) -> Self {
        Self::named(data_dir, "app-lock-pin", "app_lock_pin")
    }

    /// Human-readable name of the backend, shown in the settings.
    pub fn backend(&self) -> &'static str {
        label(kind(), crate::portable::active())
    }

    pub fn get(&self) -> Option<String> {
        match kind() {
            Kind::File { .. } => self.file.get(&self.account, &self.field).ok().flatten(),
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            Kind::Native => Keyring.get(&self.account, &self.field).ok().flatten(),
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            Kind::SecretService => layered_get(&Keyring, &self.file, &self.account, &self.field),
            #[cfg(target_os = "android")]
            Kind::Keystore => crate::mobile::keystore::get(&self.account).ok().flatten(),
            #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
            _ => None,
        }
    }

    pub fn set(&self, key: Option<&str>) -> Res<()> {
        let key = key.filter(|k| !k.is_empty());
        match kind() {
            Kind::File { .. } => put(&self.file, &self.account, &self.field, key),
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            Kind::Native => put(&Keyring, &self.account, &self.field, key),
            #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
            Kind::SecretService => layered_set(&Keyring, &self.file, &self.account, &self.field, key),
            #[cfg(target_os = "android")]
            Kind::Keystore => match key {
                Some(k) => crate::mobile::keystore::set(&self.account, k),
                None => crate::mobile::keystore::delete(&self.account),
            },
            #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
            _ => Err("no credential store".into()),
        }
    }
}

fn put(b: &dyn Backend, account: &str, field: &str, key: Option<&str>) -> Res<()> {
    match key {
        Some(k) => b.set(account, field, k),
        None => b.delete(account, field),
    }
}

/// The Secret Service first; a secret not moved over yet is still read from the file.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn layered_get(store: &dyn Backend, file: &SecretFile, account: &str, field: &str) -> Option<String> {
    match store.get(account, field) {
        Ok(Some(k)) => Some(k),
        _ => file.get(account, field).ok().flatten(),
    }
}

/// Writes into the Secret Service; a copy left in the file goes (it would be stale).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn layered_set(store: &dyn Backend, file: &SecretFile, account: &str, field: &str, key: Option<&str>) -> Res<()> {
    put(store, account, field, key)?;
    file.delete(account, field)
}

fn label(kind: &Kind, portable: bool) -> &'static str {
    match kind {
        Kind::Native if cfg!(windows) && portable => annalo_core::tr!(
            "Windows-Anmeldeinformationsverwaltung dieses Rechners (portabler Modus: nicht auf dem Datenträger)",
            "Windows Credential Manager of this computer (portable mode: not on the drive)"
        ),
        Kind::Native if cfg!(windows) => "Windows-Anmeldeinformationsverwaltung",
        Kind::Native if portable => annalo_core::tr!(
            "macOS-Schlüsselbund dieses Rechners (portabler Modus: nicht auf dem Datenträger)",
            "macOS keychain of this computer (portable mode: not on the drive)"
        ),
        Kind::Native => annalo_core::tr!("macOS-Schlüsselbund", "macOS keychain"),
        Kind::SecretService if portable => annalo_core::tr!(
            "Schlüsselbund dieses Rechners (Secret Service; portabler Modus: nicht auf dem Datenträger)",
            "Keyring of this computer (Secret Service; portable mode: not on the drive)"
        ),
        Kind::SecretService => {
            annalo_core::tr!("Schlüsselbund des Systems (Secret Service)", "System keyring (Secret Service)")
        }
        Kind::File { .. } => annalo_core::tr!(
            "Datei im App-Datenordner (nur für den Benutzer lesbar)",
            "File in the app data folder (readable by the user only)"
        ),
        #[cfg(target_os = "android")]
        Kind::Keystore => annalo_core::tr!("Android-Schlüsselspeicher (Keystore)", "Android Keystore"),
    }
}

// ------------------------------------------------------------------ migration

/// What [`migrate`] did.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Migration {
    /// Secrets moved into the credential store.
    pub moved: usize,
    /// Fields left in the file (unknown, or not read back the same); the file stays then.
    pub kept: Vec<String>,
    /// The file could not be read or rewritten.
    pub error: Option<String>,
}

/// The account of a field of the file (the reverse of the constructors above; ids never
/// contain `_`).
// The file-to-keyring move only runs on Linux (the tests run it everywhere).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn account_of_field(field: &str) -> Option<String> {
    Some(match field {
        "litellm_api_key" => "litellm-api-key".into(),
        "git_token" => "git-token".into(),
        "proxy_password" => annalo_core::network::PASSWORD_ACCOUNT.into(),
        "db_key" => "db-key".into(),
        "app_lock_pin" => "app-lock-pin".into(),
        f => {
            if let Some(id) = f.strip_prefix("ai_provider_") {
                format!("ai-provider-{}", id.replace('_', "-"))
            } else if let Some(id) = f.strip_prefix("calendar_ics_") {
                format!("calendar-ics-{id}")
            } else if let Some(id) = f.strip_prefix("proxy_password_") {
                annalo_core::network::password_account(&id.replace('_', "-"))
            } else if let Some(id) = f.strip_prefix("jira_") {
                format!("jira-{}", id.replace('_', "-"))
            } else {
                return None;
            }
        }
    })
}

/// Moves the secrets of `file` into `store`: each one is written, read back and compared, and
/// only then removed from the file; the file is deleted once empty. Repeating it is harmless.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn migrate(file: &SecretFile, store: &dyn Backend, data_dir: &Path, portable: bool) -> Migration {
    let mut out = Migration::default();
    if !file.path.exists() {
        return out;
    }
    let Ok(map) = file.read() else {
        out.error = Some(format!("{FILE} is damaged"));
        return out;
    };
    let mut left = Fields::new();
    for (field, value) in map {
        let Some(secret) = value.as_str().filter(|s| !s.is_empty()) else { continue };
        let account = account_of_field(&field).map(|a| account_name(&a, data_dir, portable));
        let moved = account.is_some_and(|a| {
            store.set(&a, &field, secret).is_ok() && store.get(&a, &field).ok().flatten().as_deref() == Some(secret)
        });
        if moved {
            out.moved += 1;
        } else {
            out.kept.push(field.clone());
            left.insert(field, value);
        }
    }
    if let Err(e) = file.write(left) {
        out.error = Some(e);
    }
    out
}

/// At the start: decides the store and, with the Secret Service, moves the file's secrets over.
pub fn init(data_dir: &Path) {
    let kind = kind();
    match kind {
        Kind::File { reason: Some(r) } if cfg!(target_os = "linux") => {
            crate::devlog::info("secrets", format!("no Secret Service ({r}): secrets stay in {FILE}"))
        }
        _ => crate::devlog::debug("secrets", format!("credential store: {kind:?}")),
    }
    if *kind == Kind::SecretService {
        #[cfg(target_os = "linux")]
        {
            let file = SecretFile { path: data_dir.join(FILE) };
            let m = migrate(&file, &Keyring, data_dir, crate::portable::active());
            if m.moved > 0 || !m.kept.is_empty() {
                crate::devlog::info(
                    "secrets",
                    format!("{} secrets moved from {FILE} into the Secret Service, {} kept", m.moved, m.kept.len()),
                );
            }
            if let Some(e) = &m.error {
                crate::devlog::warn("secrets", format!("{FILE} not cleaned up: {e}"));
            }
            *crate::lock(&MIGRATED) = Some(m);
        }
    }
    let _ = data_dir;
}

/// Settings → Datenschutz: where the secrets are kept and why.
#[derive(Debug, Serialize)]
pub struct SecretStatus {
    #[serde(flatten)]
    kind: Kind,
    label: &'static str,
    /// `secrets.json` still exists next to a credential store (secrets not moved yet).
    file_left: bool,
    migration: Option<Migration>,
    portable: bool,
}

#[tauri::command]
pub fn secrets_status(state: tauri::State<crate::AppState>) -> SecretStatus {
    let portable = crate::portable::active();
    let kind = kind().clone();
    SecretStatus {
        file_left: !matches!(kind, Kind::File { .. }) && state.data_dir.join(FILE).exists(),
        label: label(&kind, portable),
        kind,
        migration: crate::lock(&MIGRATED).clone(),
        portable,
    }
}

/// Writes `bytes` to `path` readable by the user only from the first byte on (never world
/// readable, not even briefly), through a synced temporary file and a rename, so a crash leaves
/// the old file or the new one, never half of it.
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
    fn the_service_name_survives_the_rename() {
        // Entries saved by Annalo 1.6 and earlier are found only under this name.
        assert_eq!(SERVICE, "Annalo");
    }

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

#[cfg(test)]
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
        // Calendar subscription addresses (they may carry a token) are secrets of their own.
        let cal = SecretStore::calendar(&dir, "s1");
        cal.set(Some("https://outlook.office365.com/owa/calendar/x/y/calendar.ics?token=1")).unwrap();
        assert_eq!(cal.get().as_deref(), Some("https://outlook.office365.com/owa/calendar/x/y/calendar.ics?token=1"));
        assert_eq!(SecretStore::calendar(&dir, "s2").get(), None);
        cal.set(None).unwrap();
        ai.set(None).unwrap();
        assert!(!dir.join("secrets.json").exists(), "empty file removed");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[cfg(unix)]
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

    /// A credential store in memory; `broken` refuses every write, `lossy` reads back
    /// something else.
    #[derive(Default)]
    struct Mem {
        entries: std::cell::RefCell<std::collections::HashMap<String, String>>,
        broken: bool,
        lossy: bool,
    }

    impl Backend for Mem {
        fn get(&self, account: &str, _field: &str) -> Res<Option<String>> {
            let v = self.entries.borrow().get(account).cloned();
            Ok(if self.lossy { v.map(|s| format!("{s}x")) } else { v })
        }
        fn set(&self, account: &str, _field: &str, secret: &str) -> Res<()> {
            if self.broken {
                return Err("locked".into());
            }
            self.entries.borrow_mut().insert(account.into(), secret.into());
            Ok(())
        }
        fn delete(&self, account: &str, _field: &str) -> Res<()> {
            self.entries.borrow_mut().remove(account);
            Ok(())
        }
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("annalo-secrets-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_secret_service_is_used_only_when_it_answers() {
        assert_eq!(choose(None, || Ok(())), Kind::SecretService);
        assert_eq!(choose(Some(""), || Ok(())), Kind::SecretService);
        // CI: no D-Bus session, no keyring daemon.
        let no_bus = choose(None, || Err("DBus error: no session bus".into()));
        assert_eq!(no_bus, Kind::File { reason: Some("DBus error: no session bus".into()) });
        // Forced: the probe is not even asked.
        let forced = choose(Some(" FILE "), || panic!("probed"));
        assert_eq!(forced, Kind::File { reason: Some("ANNALO_SECRET_STORE=file".into()) });
        // The UI reads the kind and the reason.
        assert_eq!(serde_json::to_value(&no_bus).unwrap()["kind"], "file");
        assert_eq!(serde_json::to_value(Kind::SecretService).unwrap()["kind"], "secret_service");
        // Unit tests themselves never reach the user's keyring.
        assert!(matches!(kind(), Kind::File { .. }));
    }

    #[test]
    fn the_file_is_moved_into_the_keyring_verified_and_deleted() {
        let dir = temp("migrate");
        let file = SecretFile { path: dir.join(FILE) };
        let fields = serde_json::json!({
            "litellm_api_key": "sk-legacy",
            "git_token": "ghp_abc",
            "proxy_password": "pw-123456",
            "ai_provider_mistral_ai": "mk-1",
            "calendar_ics_s1": "https://x/cal.ics?token=1",
            "jira_site_2": "jt-2",
        });
        std::fs::write(&file.path, fields.to_string()).unwrap();
        let store = Mem::default();
        let m = migrate(&file, &store, &dir, false);
        assert_eq!((m.moved, m.kept.len(), m.error.clone()), (6, 0, None));
        assert!(!file.path.exists(), "the empty file is deleted");
        {
            let e = store.entries.borrow();
            let got = |k: &str| e.get(k).map(String::as_str);
            assert_eq!(got("litellm-api-key"), Some("sk-legacy"));
            assert_eq!(got("git-token"), Some("ghp_abc"));
            assert_eq!(got(annalo_core::network::PASSWORD_ACCOUNT), Some("pw-123456"));
            assert_eq!(got("ai-provider-mistral-ai"), Some("mk-1"));
            assert_eq!(got("calendar-ics-s1"), Some("https://x/cal.ics?token=1"));
            assert_eq!(got("jira-site-2"), Some("jt-2"));
        }
        // Idempotent: a second start finds nothing to do.
        assert_eq!(migrate(&file, &store, &dir, false), Migration::default());
        // The accounts are the ones the stores ask for afterwards.
        for (s, want) in [
            (SecretStore::provider(&dir, "mistral-ai"), "mk-1"),
            (SecretStore::jira(&dir, "site-2"), "jt-2"),
            (SecretStore::calendar(&dir, "s1"), "https://x/cal.ics?token=1"),
            (SecretStore::proxy(&dir), "pw-123456"),
        ] {
            assert_eq!(layered_get(&store, &file, &s.account, &s.field).as_deref(), Some(want));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_or_wrong_read_back_keeps_the_file() {
        let dir = temp("keep");
        let file = SecretFile { path: dir.join(FILE) };
        std::fs::write(&file.path, r#"{"git_token":"ghp_abc","unknown_thing":"x1234567"}"#).unwrap();
        // Locked keyring: nothing moved, nothing lost.
        let locked = Mem { broken: true, ..Default::default() };
        assert_eq!(migrate(&file, &locked, &dir, false).moved, 0);
        assert_eq!(file.get("", "git_token").unwrap().as_deref(), Some("ghp_abc"));
        // A store that reads back something else: the file keeps the secret.
        let lossy = Mem { lossy: true, ..Default::default() };
        assert_eq!(migrate(&file, &lossy, &dir, false).moved, 0);
        assert_eq!(file.get("", "git_token").unwrap().as_deref(), Some("ghp_abc"));
        // A working store moves the known field; the unknown one stays in the file.
        let ok = Mem::default();
        let m = migrate(&file, &ok, &dir, false);
        assert_eq!((m.moved, m.kept), (1, vec!["unknown_thing".to_string()]));
        assert_eq!(file.get("", "git_token").unwrap(), None);
        assert_eq!(file.get("", "unknown_thing").unwrap().as_deref(), Some("x1234567"));
        // Damaged: reported and left alone.
        std::fs::write(&file.path, "{\"git").unwrap();
        assert!(migrate(&file, &ok, &dir, false).error.is_some());
        assert!(file.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn portable_copies_migrate_into_their_namespace() {
        let dir = temp("portable");
        let file = SecretFile { path: dir.join(FILE) };
        std::fs::write(&file.path, r#"{"git_token":"ghp_abc"}"#).unwrap();
        let store = Mem::default();
        assert_eq!(migrate(&file, &store, &dir, true).moved, 1);
        let key = account_name("git-token", &dir, true);
        assert!(key.starts_with("git-token@"));
        assert_eq!(store.entries.borrow().get(&key).map(String::as_str), Some("ghp_abc"));
        assert!(!store.entries.borrow().contains_key("git-token"), "the installed copy's entry is untouched");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_keyring_wins_and_a_stale_file_copy_goes_on_write() {
        let dir = temp("layered");
        let file = SecretFile { path: dir.join(FILE) };
        let store = Mem::default();
        file.set("", "git_token", "old").unwrap();
        // Not moved yet: still found.
        assert_eq!(layered_get(&store, &file, "git-token", "git_token").as_deref(), Some("old"));
        layered_set(&store, &file, "git-token", "git_token", Some("new")).unwrap();
        assert_eq!(layered_get(&store, &file, "git-token", "git_token").as_deref(), Some("new"));
        assert!(!file.path.exists(), "the stale copy is removed");
        layered_set(&store, &file, "git-token", "git_token", None).unwrap();
        assert_eq!(layered_get(&store, &file, "git-token", "git_token"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
