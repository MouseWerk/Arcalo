//! The key of an encrypted workspace, read where the app keeps it (the app's `secrets.rs`, which
//! writes it): the credential store under the service `Arcalo` (Windows Credential Manager, macOS
//! keychain, the Secret Service on Linux), else `secrets.json` in the data folder (Linux without a
//! Secret Service, `ARCALO_SECRET_STORE=file`). A portable copy names its entries
//! `<account>@<namespace of the data folder>`. An entry not taken over from the service of 1.14
//! and earlier (`Annalo`) is still read there. Read only: the command line never writes secrets.

use std::path::Path;

use arcalo_core::cipher::{DbKey, WrappedKey};
use arcalo_core::{Error, Result, datadir, identity, tr};

/// The secrets file in the data folder (fields named like the accounts, with `_`).
const FILE: &str = "secrets.json";

/// Where a key came from (for `arcalo info`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    CredentialStore,
    RecoveryKey,
    Password,
}

/// The key that opens the encrypted database at `db`: `ARCALO_RECOVERY_KEY`, then the password
/// file with `ARCALO_DB_PASSWORD`, then the credential store's key and the new key of a key change
/// that has not been completed (the app completes it at its next start).
pub fn find(data_dir: &Path, db: &Path, portable: bool) -> Result<(DbKey, Source)> {
    let mut tried = false;
    if let Some(code) = identity::env("ARCALO_RECOVERY_KEY") {
        let key = DbKey::from_recovery_code(&code)?;
        if arcalo_core::cipher::key_opens(db, &key) {
            return Ok((key, Source::RecoveryKey));
        }
        tried = true;
    }
    if let Some(password) = std::env::var("ARCALO_DB_PASSWORD").ok().filter(|p| !p.is_empty())
        && let Some(wrapped) = WrappedKey::read(data_dir)
    {
        let key = wrapped.unwrap_key(&password)?;
        if arcalo_core::cipher::key_opens(db, &key) {
            return Ok((key, Source::Password));
        }
        tried = true;
    }
    for (account, field) in [("db-key", "db_key"), ("db-key-next", "db_key_next")] {
        if let Some(key) = read(data_dir, account, field, portable).and_then(|h| DbKey::from_hex(&h)) {
            if arcalo_core::cipher::key_opens(db, &key) {
                return Ok((key, Source::CredentialStore));
            }
            tried = true;
        }
    }
    let text = if tried { arcalo_core::cipher::wrong_key_text() } else { arcalo_core::cipher::missing_key_text() };
    Err(Error::State(format!(
        "{text}. {}",
        tr!(
            "Arcalo einmal auf diesem Computer öffnen (es speichert den Schlüssel im Schlüsselspeicher) oder den Wiederherstellungsschlüssel in ARCALO_RECOVERY_KEY angeben",
            "Open Arcalo once on this computer (it keeps the key in the credential store) or give the recovery key in ARCALO_RECOVERY_KEY"
        )
    )))
}

/// The secret `account` of the data folder, `None` when it is not stored.
fn read(data_dir: &Path, account: &str, field: &str, portable: bool) -> Option<String> {
    let account =
        if portable { format!("{account}@{}", datadir::secret_namespace(data_dir)) } else { account.to_owned() };
    let file = || from_file(data_dir, field);
    if identity::env("ARCALO_SECRET_STORE").is_some_and(|v| v.trim().eq_ignore_ascii_case("file")) {
        return file();
    }
    #[cfg(any(windows, target_os = "macos", target_os = "linux"))]
    {
        let moved = taken_over(data_dir, &account);
        let found = with_timeout(move || {
            let get = |service: &str| keyring::Entry::new(service, &account).and_then(|e| e.get_password()).ok();
            get(identity::CREDENTIAL_SERVICE)
                .or_else(|| (!moved).then(|| get(identity::LEGACY_CREDENTIAL_SERVICE)).flatten())
                .filter(|s| !s.is_empty())
        });
        // Linux keeps a secret in the file while no Secret Service answers (and until it moved).
        if found.is_some() || cfg!(not(target_os = "linux")) {
            return found;
        }
    }
    file()
}

fn from_file(data_dir: &Path, field: &str) -> Option<String> {
    let raw = std::fs::read_to_string(data_dir.join(FILE)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get(field)?.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Whether the app took the entry over from the old service name (`credentials-moved.json`).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn taken_over(data_dir: &Path, account: &str) -> bool {
    std::fs::read(data_dir.join(datadir::CREDENTIALS_MOVED))
        .ok()
        .and_then(|b| serde_json::from_slice::<Vec<String>>(&b).ok())
        .is_some_and(|done| done.iter().any(|a| a == account))
}

/// Runs a credential store lookup on a thread of its own: a Secret Service that does not answer
/// (a hanging D-Bus) must not hold the command up (the app gives it 3 s as well).
#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
fn with_timeout(f: impl FnOnce() -> Option<String> + Send + 'static) -> Option<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new().name("credential-store".into()).spawn(move || tx.send(f())).ok()?;
    rx.recv_timeout(std::time::Duration::from_secs(3)).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_file_holds_the_key_when_no_credential_store_is_used() {
        let dir = std::env::temp_dir().join(format!("arcalo-cli-keystore-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(FILE), r#"{"db_key": "abc", "db_key_next": ""}"#).unwrap();
        assert_eq!(from_file(&dir, "db_key").as_deref(), Some("abc"));
        assert_eq!(from_file(&dir, "db_key_next"), None);
        assert_eq!(from_file(&dir.join("missing"), "db_key"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
