//! The workspace the command line works on: the app's (found the way the app finds it), or the
//! database named with `--db`. An encrypted workspace is opened with the key from the credential
//! store ([`crate::keystore`]). Writes run in one transaction that takes the write lock first and
//! record what they changed for the running app ([`Workspace::commit`]).

use std::path::{Path, PathBuf};
use std::time::Duration;

use arcalo_core::cipher::{self, FileState};
use arcalo_core::external::Change;
use arcalo_core::settings::Settings;
use arcalo_core::{Database, datadir, i18n, identity, trf};

use crate::keystore;
use crate::output::{Failure, Outcome};

/// How long a write waits while the app holds the database (its longest writes are the batches of
/// a vault import).
const BUSY_TIMEOUT: Duration = Duration::from_secs(15);

/// Where the workspace is.
#[derive(Debug, Clone)]
pub struct Location {
    pub data_dir: PathBuf,
    pub db: PathBuf,
    /// Named with `--db`: created when missing (as before 1.18), attachments next to the file.
    pub explicit: bool,
    /// The data folder of a portable copy (next to this program).
    pub portable: bool,
}

/// The app's folders on this platform, as Tauri names them: `<data>/<identifier>` and
/// `<config>/<identifier>` (`%APPDATA%` on Windows, `~/Library/Application Support` on macOS,
/// `$XDG_DATA_HOME` / `$XDG_CONFIG_HOME` on Linux).
fn app_dirs() -> (Option<PathBuf>, PathBuf) {
    let config = dirs::config_dir().map(|d| d.join(identity::IDENTIFIER));
    let base = dirs::data_dir().unwrap_or_else(|| PathBuf::from("."));
    let data = base.join(identity::IDENTIFIER);
    // The folder of 1.14 and earlier while the app could not copy it (it keeps using it then).
    let legacy = base.join(identity::LEGACY_IDENTIFIER);
    if !data.join(datadir::DB_FILE).is_file() && legacy.join(datadir::DB_FILE).is_file() {
        return (config, legacy);
    }
    (config, data)
}

/// The workspace to open: `--db`, else `--data-dir`, else the app's data folder (ARCALO_DATA_DIR,
/// a portable copy next to this program, `location.json`, the default folder).
pub fn locate(db: Option<PathBuf>, data_dir: Option<PathBuf>) -> Location {
    if let Some(db) = db.filter(|p| !p.as_os_str().is_empty()) {
        let data_dir = db.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new(".")).to_path_buf();
        return Location { data_dir, db, explicit: true, portable: false };
    }
    let portable = datadir::exe_dir(identity::env_os("ARCALO_EXE_DIR").map(PathBuf::from))
        .and_then(|exe| datadir::portable_data_dir(&exe));
    let env = data_dir.or_else(|| identity::env_os("ARCALO_DATA_DIR").map(PathBuf::from));
    let (config, default) = app_dirs();
    let is_portable = env.as_ref().is_none_or(|e| e.as_os_str().is_empty()) && portable.is_some();
    let dir = datadir::locate(env, portable, config.as_deref(), default);
    Location { db: dir.join(datadir::DB_FILE), data_dir: dir, explicit: false, portable: is_portable }
}

/// The language of messages until the settings are read: `ARCALO_LOCALE`, else the system's (as
/// the app's `os_locale`).
pub fn init_language() {
    let locale = identity::env("ARCALO_LOCALE").filter(|l| !l.trim().is_empty()).or_else(|| {
        #[cfg(any(windows, target_os = "macos"))]
        let tags: Vec<String> = sys_locale::get_locales().collect();
        #[cfg(not(any(windows, target_os = "macos")))]
        let tags = i18n::locales_from_env(|k| std::env::var(k).ok());
        i18n::preferred_locale(tags)
    });
    let lang = i18n::lang_of_locale(&locale.unwrap_or_default());
    i18n::set_system_lang(lang);
    i18n::set_lang(lang);
}

pub struct Workspace {
    pub db: Database,
    pub loc: Location,
    pub encrypted: bool,
    pub settings: Settings,
}

impl Workspace {
    /// Opens the workspace at `loc`. A missing one is created only for `--db` (or `create`).
    pub fn open(loc: Location, create: bool) -> Outcome<Workspace> {
        if !loc.explicit && !create && !loc.db.is_file() {
            return Err(Failure::NotFound(trf!(
                "Kein Arcalo-Arbeitsbereich in {}: Arcalo einmal starten oder mit --data-dir bzw. --db den Ort angeben",
                "No Arcalo workspace in {}: start Arcalo once or name the place with --data-dir or --db",
                loc.data_dir.display()
            )));
        }
        let encrypted = cipher::file_state(&loc.db) == FileState::Encrypted;
        if encrypted {
            cipher::quiet_log();
            let (key, _) =
                keystore::find(&loc.data_dir, &loc.db, loc.portable).map_err(|e| Failure::Other(e.to_string()))?;
            cipher::set_key(Some(key));
        } else if let Some(code) = identity::env("ARCALO_RECOVERY_KEY") {
            // As before 1.18: the recovery key in the environment is the key of this process.
            cipher::set_key(Some(cipher::DbKey::from_recovery_code(&code)?));
        }
        if let Some(parent) = loc.db.parent().filter(|p| !p.as_os_str().is_empty() && loc.explicit) {
            std::fs::create_dir_all(parent).map_err(|e| arcalo_core::Error::file(parent, e))?;
        }
        let db = Database::open(&loc.db)
            .map_err(|e| if e.is_busy() { Failure::Locked(e.to_string()) } else { Failure::Other(e.to_string()) })?;
        db.conn().busy_timeout(BUSY_TIMEOUT).map_err(arcalo_core::Error::from)?;
        let settings = db.load_settings().unwrap_or_default();
        i18n::set_lang(settings.locale.lang());
        i18n::set_number_format(settings.locale.number_format);
        Ok(Workspace { db, loc, encrypted, settings })
    }

    /// The attachments folder (next to the database).
    pub fn attachments_dir(&self) -> PathBuf {
        arcalo_core::attachments::dir(&self.loc.data_dir)
    }

    /// Runs `f` in one transaction that holds the write lock from the start and records the
    /// change it returns for the running app, in the same transaction.
    pub fn commit<T>(&self, f: impl FnOnce(&Database) -> arcalo_core::Result<(T, Change)>) -> Outcome<T> {
        Ok(self.db.atomic(|| {
            let (value, change) = f(&self.db)?;
            self.db.record_external_change(&change)?;
            Ok(value)
        })?)
    }
}
