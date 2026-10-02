//! App-Sperre: when Arcalo locks (at the start, after minutes without input, after the computer
//! slept), the PIN as an Argon2id hash, and the growing wait after wrong PINs.
//!
//! The configuration and the count of wrong attempts are kept in the database (`meta.applock`,
//! `meta.applock.attempts`), the PIN hash in the credential store (the desktop shell). The lock
//! is a privacy screen for the running app: it hides the notes and refuses the app's commands
//! while locked. It does not encrypt anything; that is the job of the database encryption
//! (see [`crate::cipher`]).

use std::time::Duration;

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::tr;

const CONFIG_KEY: &str = "applock";
const ATTEMPTS_KEY: &str = "applock.attempts";
/// Shortest PIN.
pub const MIN_PIN: usize = 4;
/// Longest PIN (a passphrase is fine, but not a novel).
pub const MAX_PIN: usize = 64;
/// Wrong PINs before the first wait.
pub const FREE_ATTEMPTS: u32 = 3;
/// The longest wait between attempts.
pub const MAX_WAIT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LockMode {
    #[default]
    Off,
    /// Locked at every start.
    Start,
    /// At the start and after `idle_minutes` without input (and after sleep, if detected).
    Idle,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LockConfig {
    pub mode: LockMode,
    /// Minutes without keyboard or mouse input before locking (mode `Idle`).
    pub idle_minutes: u32,
    /// Lock after the computer slept (noticed by a jump of the clock between two checks).
    pub on_sleep: bool,
    /// Offer Windows Hello / Touch ID next to the PIN.
    pub os_auth: bool,
}

impl Default for LockConfig {
    fn default() -> Self {
        LockConfig { mode: LockMode::Off, idle_minutes: 10, on_sleep: true, os_auth: false }
    }
}

impl LockConfig {
    pub fn normalize(&mut self) {
        self.idle_minutes = self.idle_minutes.clamp(1, 240);
    }

    pub fn enabled(&self) -> bool {
        self.mode != LockMode::Off
    }

    /// Minutes without input after which to lock (`None`: not by idle time).
    pub fn idle_limit(&self) -> Option<Duration> {
        (self.mode == LockMode::Idle).then(|| Duration::from_secs(u64::from(self.idle_minutes) * 60))
    }
}

/// Wrong attempts so far (reset by a correct PIN or another way of unlocking).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Attempts {
    pub failures: u32,
    pub last: Option<DateTime<Utc>>,
}

/// The wait after `failures` wrong attempts: none for the first [`FREE_ATTEMPTS`], then 5 s,
/// doubling each time, at most [`MAX_WAIT`].
pub fn wait_after(failures: u32) -> Duration {
    if failures < FREE_ATTEMPTS {
        return Duration::ZERO;
    }
    let doublings = (failures - FREE_ATTEMPTS).min(16);
    Duration::from_secs(5u64 << doublings).min(MAX_WAIT)
}

impl Attempts {
    /// How long until the next attempt is accepted.
    pub fn remaining(&self, now: DateTime<Utc>) -> Duration {
        let Some(last) = self.last else { return Duration::ZERO };
        let wait = wait_after(self.failures);
        let passed = (now - last).to_std().unwrap_or(Duration::ZERO);
        wait.saturating_sub(passed)
    }

    pub fn failed(&mut self, now: DateTime<Utc>) {
        self.failures = self.failures.saturating_add(1);
        self.last = Some(now);
    }
}

/// Checks the form of a new PIN.
pub fn check_new_pin(pin: &str) -> Result<()> {
    let n = pin.chars().count();
    if n < MIN_PIN {
        return Err(Error::Parse(
            tr!("Die PIN braucht mindestens 4 Zeichen", "The PIN needs at least 4 characters").into(),
        ));
    }
    if n > MAX_PIN {
        return Err(Error::Parse(tr!("Die PIN ist zu lang", "The PIN is too long").into()));
    }
    Ok(())
}

fn hasher() -> argon2::Argon2<'static> {
    // OWASP's recommendation for Argon2id: 19 MiB, 2 passes, 1 lane.
    let params = argon2::Params::new(19 * 1024, 2, 1, None).unwrap_or_default();
    argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
}

/// The PIN as an Argon2id hash in the PHC format (`$argon2id$v=19$…`), with a random salt.
pub fn hash_pin(pin: &str) -> Result<String> {
    check_new_pin(pin)?;
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| Error::State(e.to_string()))?;
    let salt = SaltString::encode_b64(&salt).map_err(|e| Error::State(e.to_string()))?;
    Ok(hasher().hash_password(pin.as_bytes(), &salt).map_err(|e| Error::State(e.to_string()))?.to_string())
}

/// Whether `pin` matches `hash` (from [`hash_pin`]).
pub fn verify_pin(pin: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| hasher().verify_password(pin.as_bytes(), &h).is_ok())
}

impl Database {
    pub fn applock_config(&self) -> LockConfig {
        self.meta_get(CONFIG_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn set_applock_config(&self, c: &LockConfig) -> Result<()> {
        let mut c = c.clone();
        c.normalize();
        self.meta_set(CONFIG_KEY, &serde_json::to_string(&c)?)
    }

    pub fn applock_attempts(&self) -> Attempts {
        self.meta_get(ATTEMPTS_KEY).ok().flatten().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
    }

    pub fn set_applock_attempts(&self, a: &Attempts) -> Result<()> {
        self.meta_set(ATTEMPTS_KEY, &serde_json::to_string(a)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_are_hashed_with_argon2id_and_verified() {
        assert!(hash_pin("123").is_err(), "too short");
        let h = hash_pin("4711").unwrap();
        assert!(h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"), "{h}");
        assert!(!h.contains("4711"));
        assert!(verify_pin("4711", &h));
        assert!(!verify_pin("4712", &h));
        assert!(!verify_pin("4711", "not a hash"));
        // A random salt: the same PIN hashes differently.
        assert_ne!(h, hash_pin("4711").unwrap());
    }

    #[test]
    fn wrong_pins_make_the_wait_grow_up_to_a_limit() {
        assert_eq!(wait_after(0), Duration::ZERO);
        assert_eq!(wait_after(2), Duration::ZERO);
        assert_eq!(wait_after(3), Duration::from_secs(5));
        assert_eq!(wait_after(4), Duration::from_secs(10));
        assert_eq!(wait_after(6), Duration::from_secs(40));
        assert_eq!(wait_after(20), MAX_WAIT);
        assert_eq!(wait_after(u32::MAX), MAX_WAIT);
        let t0 = Utc::now();
        let mut a = Attempts::default();
        for _ in 0..3 {
            assert_eq!(a.remaining(t0), Duration::ZERO);
            a.failed(t0);
        }
        assert_eq!(a.remaining(t0), Duration::from_secs(5));
        assert_eq!(a.remaining(t0 + chrono::TimeDelta::seconds(3)), Duration::from_secs(2));
        assert_eq!(a.remaining(t0 + chrono::TimeDelta::seconds(9)), Duration::ZERO);
    }

    #[test]
    fn the_configuration_and_attempts_survive_in_the_database() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.applock_config(), LockConfig::default());
        assert!(!db.applock_config().enabled());
        let c = LockConfig { mode: LockMode::Idle, idle_minutes: 0, on_sleep: false, os_auth: true };
        db.set_applock_config(&c).unwrap();
        let back = db.applock_config();
        assert_eq!(back.idle_minutes, 1, "clamped");
        assert_eq!(back.idle_limit(), Some(Duration::from_secs(60)));
        let mut a = Attempts::default();
        a.failed(Utc::now());
        db.set_applock_attempts(&a).unwrap();
        assert_eq!(db.applock_attempts().failures, 1);
    }
}
