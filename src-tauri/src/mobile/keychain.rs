//! Secrets on iOS: the Git access token (and every other secret the shared code keeps) as generic
//! passwords in the Keychain, service `Arcalo`, one item per account. The items are readable
//! after the first unlock since the start of the device (the background sync runs while it is
//! locked) and bound to this device: they are neither in a backup nor in iCloud Keychain.

use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::passwords::{self, PasswordOptions};

/// `errSecItemNotFound`.
const NOT_FOUND: i32 = -25300;

fn options(account: &str) -> PasswordOptions {
    PasswordOptions::new_generic_password(arcalo_core::identity::CREDENTIAL_SERVICE, account)
}

pub fn get(account: &str) -> Result<Option<String>, String> {
    match passwords::generic_password(options(account)) {
        Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned()).filter(|s| !s.is_empty())),
        Err(e) if e.code() == NOT_FOUND => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(account: &str, secret: &str) -> Result<(), String> {
    // Replaced as a whole, so an item of another accessibility never stays behind.
    delete(account)?;
    let mut options = options(account);
    let access =
        SecAccessControl::create_with_protection(Some(ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly), 0)
            .map_err(|e| e.to_string())?;
    options.set_access_control(access);
    passwords::set_generic_password_options(secret.as_bytes(), options).map_err(|e| e.to_string())
}

pub fn delete(account: &str) -> Result<(), String> {
    match passwords::delete_generic_password_options(options(account)) {
        Ok(()) => Ok(()),
        Err(e) if e.code() == NOT_FOUND => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
