//! Settings → Sicherheit: the encrypted database (key in the credential store, the recovery
//! screen at the start, switching on and off) and the app lock (PIN, Windows Hello, Touch ID).
//!
//! The database key is read before the database is opened ([`prepare`]). When the file is
//! encrypted and the key is missing or wrong (a new computer, a restored disk image, a portable
//! copy on another computer), a small window asks for the recovery key or the password
//! ([`show_keygate`]); the key is then stored and Arcalo starts again. No other part of the app
//! runs meanwhile (no backups, no sync, no schedulers).
//!
//! The app lock hides the windows behind the lock screen and refuses the app's commands while
//! locked ([`guard`]); quick capture and quick search show the main window's lock screen instead,
//! the tray offers only „Entsperren“ and „Beenden“, notifications say nothing about their content.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};

use annalo_core::applock::{self, LockConfig};
use annalo_core::cipher::{self, Access, DbKey, Direction, FileState, Migration, NextKey, WrappedKey};
use annalo_core::{Error, Result, datadir};
use annalo_core::{tr, trf};
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, Wry};

use crate::secrets::SecretStore;
use crate::{AppState, devlog, lock};

/// What a command refused while locked answers (the UI waits for the unlock instead).
pub const LOCKED_ERROR: &str = "app-locked";
/// The window of the recovery screen.
pub const KEYGATE: &str = "keygate";
/// The key for the next start only (entered on the recovery screen without „merken“).
const HANDOFF: &str = "db-key.handoff";

// ------------------------------------------------------------ database key

fn stored_key(dir: &Path) -> Option<DbKey> {
    SecretStore::db_key(dir).get().and_then(|h| DbKey::from_hex(&h))
}

/// The new key of a key change that has not become the key yet.
fn next_key(dir: &Path) -> Option<DbKey> {
    SecretStore::db_key_next(dir).get().and_then(|h| DbKey::from_hex(&h))
}

fn drop_next_key(dir: &Path) {
    if let Err(e) = SecretStore::db_key_next(dir).set(None) {
        devlog::warn("cipher", format!("new key of a key change not removed: {e}"));
    }
    WrappedKey::remove_next(dir);
}

/// After the switch: the new key of a key change becomes the key (stored, password file
/// replaced) once it opens the database; dropped when the change was rolled back. Returns the
/// key the database needs now.
fn settle_next_key(dir: &Path, key: Option<DbKey>) -> Option<DbKey> {
    let Some(next) = next_key(dir) else { return key };
    match cipher::next_key_fate(dir, &next) {
        NextKey::Promote => {
            // Stored first; the next entry goes only then (a failure here repeats at the next start).
            match store_key(dir, &next) {
                Ok(()) => {
                    if let Err(e) = WrappedKey::promote_next(dir) {
                        devlog::error("cipher", format!("password file of the new key not put in place: {e}"));
                    }
                    drop_next_key(dir);
                    devlog::info("cipher", "new database key stored");
                }
                Err(e) => devlog::error("cipher", format!("new database key not stored, kept for the next start: {e}")),
            }
            cipher::set_key(Some(next.clone()));
            Some(next)
        }
        NextKey::Keep => key,
        NextKey::Drop => {
            drop_next_key(dir);
            key
        }
    }
}

/// The key handed over by the recovery screen for this start only (read once, then deleted).
fn take_handoff(dir: &Path) -> Option<DbKey> {
    let path = dir.join(HANDOFF);
    let hex = std::fs::read_to_string(&path).ok()?;
    let _ = cipher::secure_delete(&path);
    DbKey::from_hex(&hex)
}

fn write_handoff(dir: &Path, key: &DbKey) -> Result<()> {
    use std::io::Write;
    let path = dir.join(HANDOFF);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&path)?;
    f.write_all(key.to_hex().as_bytes())?;
    f.sync_all()?;
    Ok(())
}

/// Stores `key` in the credential store and reads it back (a store that drops it silently
/// would lock the user out at the next start).
fn store_key(dir: &Path, key: &DbKey) -> Result<()> {
    let store = SecretStore::db_key(dir);
    store.set(Some(key.to_hex().as_str())).map_err(Error::State)?;
    if store.get().and_then(|h| DbKey::from_hex(&h)).as_ref() != Some(key) {
        return Err(Error::State(
            tr!(
                "Der Schlüssel konnte nicht im Schlüsselspeicher abgelegt werden",
                "The key could not be saved in the credential store"
            )
            .into(),
        ));
    }
    Ok(())
}

/// Before the database is opened: reads the key, finishes a requested switch, and tells whether
/// the database can be opened.
pub struct Prepared {
    /// Shown in the app once it runs (a finished or failed switch).
    pub notice: Option<datadir::Notice>,
    /// The recovery screen is needed (missing or wrong key).
    pub blocked: Option<Access>,
}

pub fn prepare(dir: &Path) -> Prepared {
    let key = take_handoff(dir).or_else(|| stored_key(dir));
    cipher::set_key(key.clone());
    let mut notice = None;
    match cipher::run_pending_keys(dir, key.as_ref(), next_key(dir).as_ref(), &|_| false) {
        Ok(Some(o)) if o.direction == Direction::Rekey => {
            devlog::info("cipher", "database key changed");
            notice = Some(datadir::Notice::titled(
                "info",
                tr!("Schlüssel gewechselt", "Key changed"),
                tr!(
                    "Die Datenbank ist jetzt mit dem neuen Schlüssel verschlüsselt. Der alte Wiederherstellungsschlüssel \
                     öffnet sie nicht mehr; Sicherungen von vor dem Wechsel brauchen weiterhin den alten.",
                    "The database is now encrypted with the new key. The old recovery key no longer opens it; backups \
                     from before the change still need the old one."
                )
                .into(),
            ));
        }
        Ok(Some(o)) => {
            let encrypted = o.direction == Direction::Encrypt;
            devlog::info("cipher", format!("database {}", if encrypted { "encrypted" } else { "decrypted" }));
            notice = Some(if encrypted {
                datadir::Notice::titled(
                    "info",
                    tr!("Datenbank verschlüsselt", "Database encrypted"),
                    tr!(
                        "Die Datenbank ist jetzt verschlüsselt. Die unverschlüsselte Kopie wird beim nächsten Start sicher gelöscht.",
                        "The database is now encrypted. The unencrypted copy is securely deleted at the next start."
                    )
                    .into(),
                )
            } else {
                datadir::Notice::titled(
                    "info",
                    tr!("Verschlüsselung entfernt", "Encryption removed"),
                    tr!(
                        "Die Datenbank ist wieder unverschlüsselt. Die verschlüsselte Kopie wird beim nächsten Start gelöscht.",
                        "The database is unencrypted again. The encrypted copy is deleted at the next start."
                    )
                    .into(),
                )
            });
        }
        Ok(None) => {}
        Err(e) => {
            devlog::error("cipher", format!("switching the encryption failed, database unchanged: {e}"));
            notice = Some(datadir::Notice::titled(
                "error",
                tr!("Verschlüsselung nicht umgestellt", "Encryption not switched"),
                trf!(
                    "Die Datenbank wurde nicht umgestellt und ist unverändert: {e}",
                    "The database was not switched and is unchanged: {e}"
                ),
            ));
        }
    }
    let key = settle_next_key(dir, key);
    let access = cipher::access(&dir.join(datadir::DB_FILE), key.as_ref());
    if access == Access::Unlocked {
        devlog::debug("cipher", "encrypted database, key found");
    }
    Prepared { notice, blocked: matches!(access, Access::MissingKey | Access::WrongKey).then_some(access) }
}

/// The database opened: after a switch, the previous file goes at the second successful start.
pub fn opened(dir: &Path) {
    match cipher::confirm_open(dir) {
        Ok(true) => devlog::info("cipher", "previous database file of the switch overwritten and deleted"),
        Ok(false) => {}
        Err(e) => devlog::warn("cipher", format!("previous database file not deleted: {e}")),
    }
}

// ------------------------------------------------------- recovery screen

pub struct KeyGate {
    dir: PathBuf,
    reason: Access,
}

/// Opens the recovery screen instead of the app.
pub fn show_keygate(app: &AppHandle, dir: &Path, reason: Access) {
    devlog::error("cipher", format!("encrypted database cannot be opened: {reason:?}"));
    app.manage(KeyGate { dir: dir.to_path_buf(), reason });
    let built = WebviewWindowBuilder::new(app, KEYGATE, WebviewUrl::App("index.html#keygate".into()))
        .title("Arcalo")
        .inner_size(620.0, 680.0)
        .min_inner_size(460.0, 520.0)
        .center()
        .build();
    if let Err(e) = built {
        crate::recovery::show(
            app,
            dir,
            crate::recovery::Failure::Database(format!("{}: {e}", cipher::missing_key_text())),
        );
    }
}

#[derive(Serialize)]
pub struct GateStatus {
    reason: Access,
    /// A password-wrapped key lies in the data folder.
    password: bool,
    portable: bool,
    store: &'static str,
    data_dir: String,
    /// Backups the start-up recovery could restore (a damaged file looks like a wrong key).
    backups: usize,
    lang: &'static str,
}

fn gate(app: &AppHandle) -> Result<State<'_, KeyGate>> {
    app.try_state::<KeyGate>().ok_or_else(|| Error::State("no recovery screen".into()))
}

fn lang_code() -> &'static str {
    if annalo_core::i18n::is_en() { "en" } else { "de" }
}

#[tauri::command]
pub fn keygate_status(app: AppHandle) -> Result<GateStatus> {
    let g = gate(&app)?;
    Ok(GateStatus {
        reason: g.reason,
        password: WrappedKey::read(&g.dir).is_some(),
        portable: crate::portable::active(),
        store: SecretStore::db_key(&g.dir).backend(),
        data_dir: g.dir.display().to_string(),
        backups: crate::recovery::backup_count(&g.dir),
        lang: lang_code(),
    })
}

/// The key from the recovery key or the password; it must open the database.
fn key_from(dir: &Path, method: &str, secret: &str) -> Result<DbKey> {
    let key = match method {
        "password" => {
            let key = WrappedKey::read(dir)
                .ok_or_else(|| Error::State(tr!("Kein Passwort eingerichtet", "No password set up").into()))?
                .unwrap_key(secret)?;
            // A key change cut off between the switch and replacing the password file.
            let next = std::fs::read(dir.join(cipher::WRAPPED_NEXT_FILE))
                .ok()
                .and_then(|b| serde_json::from_slice::<WrappedKey>(&b).ok())
                .and_then(|w| w.unwrap_key(secret).ok());
            match next {
                Some(n) if !cipher::key_opens(&dir.join(datadir::DB_FILE), &key) => n,
                _ => key,
            }
        }
        _ => DbKey::from_recovery_code(secret)?,
    };
    if !cipher::key_opens(&dir.join(datadir::DB_FILE), &key) {
        return Err(Error::State(cipher::wrong_key_text()));
    }
    Ok(key)
}

/// „Öffnen“ on the recovery screen: checks the key, keeps it (in the credential store, or for
/// the next start only) and starts again.
#[tauri::command(async)]
pub fn keygate_unlock(app: AppHandle, method: String, secret: String, remember: bool) -> Result<()> {
    let dir = gate(&app)?.dir.clone();
    let key = key_from(&dir, &method, &secret)?;
    if remember {
        store_key(&dir, &key)?;
    } else {
        write_handoff(&dir, &key)?;
    }
    devlog::info("cipher", format!("database key entered ({method}, remembered: {remember}), restarting"));
    crate::portable::unlock_instance();
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(400));
        app2.restart();
    });
    Ok(())
}

/// „Letzte Sicherung wiederherstellen“: the newest backup replaces the database, then a restart.
#[tauri::command(async)]
pub fn keygate_restore(app: AppHandle) -> Result<String> {
    let dir = gate(&app)?.dir.clone();
    crate::recovery::restore_and_restart(&app, &dir)
}

#[tauri::command]
pub fn keygate_quit(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn keygate_open_folder(app: AppHandle) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = gate(&app)?.dir.clone();
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| Error::State(e.to_string()))
}

// --------------------------------------------------- encryption settings

#[derive(Serialize)]
pub struct CipherStatus {
    state: FileState,
    /// A key is in the credential store (also after decrypting: older encrypted backups need it).
    key_stored: bool,
    store: &'static str,
    /// Linux without a Secret Service: the key lies next to the database (protects less).
    store_file: bool,
    portable: bool,
    password: bool,
    pending: Option<Migration>,
    /// The previous file of a switch waits for the next start.
    old_left: bool,
    mirror: bool,
    git_sync: bool,
    /// Local backups from before the encryption.
    plain_backups: usize,
}

#[tauri::command]
pub fn cipher_status(state: State<AppState>) -> CipherStatus {
    let dir = &state.data_dir;
    let s = state.settings();
    let store = SecretStore::db_key(dir);
    CipherStatus {
        state: cipher::file_state(&dir.join(datadir::DB_FILE)),
        key_stored: store.get().is_some(),
        store: store.backend(),
        store_file: matches!(crate::secrets::kind(), crate::secrets::Kind::File { .. }),
        portable: crate::portable::active(),
        password: WrappedKey::read(dir).is_some(),
        pending: cipher::read_marker(dir),
        old_left: cipher::old_left(dir),
        mirror: s.markdown_mirror,
        git_sync: s.git_sync.enabled,
        plain_backups: cipher::plain_backups(&state.backup_dir()).len(),
    }
}

/// The recovery key of the database key (a new key is created and stored first when there is
/// none yet and `create` is set).
#[tauri::command]
pub fn cipher_recovery_key(state: State<AppState>, create: bool) -> Result<String> {
    let dir = &state.data_dir;
    let key = match stored_key(dir) {
        Some(k) => k,
        None if create => {
            let k = DbKey::generate()?;
            store_key(dir, &k)?;
            devlog::info("cipher", "database key created and stored");
            k
        }
        None => return Err(Error::State(cipher::missing_key_text())),
    };
    Ok(key.recovery_code())
}

/// „Als Datei speichern“: the recovery key as a text file with a short explanation.
#[tauri::command]
pub fn cipher_recovery_save(path: String, code: String) -> Result<()> {
    DbKey::from_recovery_code(&code)?;
    let text = trf!(
        "Arcalo – Wiederherstellungsschlüssel\n\n{code}\n\nDamit öffnet Arcalo die verschlüsselte Datenbank und ihre Sicherungen, \
         wenn der Schlüssel auf einem Rechner fehlt. Bewahre diese Datei getrennt vom Rechner auf \
         (Passwortmanager, Ausdruck im Schrank). Wer ihn hat, kann die Datenbank lesen.\n",
        "Arcalo – recovery key\n\n{code}\n\nWith it, Arcalo opens the encrypted database and its backups when the key \
         is missing on a computer. Keep this file away from the computer (password manager, a printout in a drawer). \
         Whoever has it can read the database.\n"
    );
    let p = PathBuf::from(path.trim());
    std::fs::write(&p, text).map_err(|e| Error::file(&p, e))
}

/// „Datenbank verschlüsseln“ / „Entschlüsseln“: asks for the switch and restarts; the next start
/// carries it out before the database is opened.
#[tauri::command]
pub fn cipher_switch(app: AppHandle, state: State<AppState>, encrypt: bool) -> Result<()> {
    let dir = state.data_dir.clone();
    if stored_key(&dir).is_none() && cipher::key().is_none() {
        return Err(Error::State(cipher::missing_key_text()));
    }
    let direction = if encrypt { Direction::Encrypt } else { Direction::Decrypt };
    cipher::request(&dir, direction, Utc::now())?;
    devlog::info("cipher", format!("{direction:?} requested, restarting"));
    if let Err(e) = crate::restart(&app) {
        cipher::cancel_request(&dir);
        return Err(e);
    }
    Ok(())
}

/// „Schlüssel wechseln“, first step: a new key, kept next to the current one in the credential
/// store until the switch. Returns its recovery key (the same one when asked again before the
/// restart, so a printed copy stays valid).
#[tauri::command(async)]
pub fn cipher_rekey_prepare(state: State<'_, AppState>) -> Result<String> {
    let dir = &state.data_dir;
    if cipher::file_state(&dir.join(datadir::DB_FILE)) != FileState::Encrypted {
        return Err(Error::State(tr!("Die Datenbank ist nicht verschlüsselt", "The database is not encrypted").into()));
    }
    let current = cipher::key().ok_or_else(|| Error::State(cipher::missing_key_text()))?;
    if let Some(next) = next_key(dir).filter(|k| *k != current) {
        return Ok(next.recovery_code());
    }
    let next = DbKey::generate()?;
    let store = SecretStore::db_key_next(dir);
    store.set(Some(next.to_hex().as_str())).map_err(Error::State)?;
    if next_key(dir).as_ref() != Some(&next) {
        return Err(Error::State(
            tr!(
                "Der neue Schlüssel konnte nicht im Schlüsselspeicher abgelegt werden",
                "The new key could not be saved in the credential store"
            )
            .into(),
        ));
    }
    devlog::info("cipher", "new database key created for a key change");
    Ok(next.recovery_code())
}

/// „Schlüssel wechseln“: asks for the change and restarts; the next start re-encrypts the database
/// with the new key before opening it. With a password file, `password` re-wraps the new key.
#[tauri::command(async)]
pub fn cipher_rekey(app: AppHandle, state: State<'_, AppState>, password: Option<String>) -> Result<()> {
    let dir = state.data_dir.clone();
    let current = cipher::key().ok_or_else(|| Error::State(cipher::missing_key_text()))?;
    let next = next_key(&dir)
        .filter(|k| *k != current)
        .ok_or_else(|| Error::State(tr!("Kein neuer Schlüssel vorbereitet", "No new key prepared").into()))?;
    if let Some(wrapped) = WrappedKey::read(&dir) {
        let password = password.filter(|p| !p.is_empty()).ok_or_else(|| {
            Error::Parse(tr!("Gib das Passwort des Schlüssels ein", "Enter the password of the key").into())
        })?;
        if wrapped.unwrap_key(&password)? != current {
            return Err(Error::State(tr!("Das Passwort ist falsch", "The password is wrong").into()));
        }
        WrappedKey::wrap(&next, &password, cipher::WRAP_COST)?.write_next(&dir)?;
    }
    cipher::request(&dir, Direction::Rekey, Utc::now())?;
    devlog::info("cipher", "key change requested, restarting");
    if let Err(e) = crate::restart(&app) {
        cipher::cancel_request(&dir);
        return Err(e);
    }
    Ok(())
}

/// The key change dialog closed without changing: the prepared key is dropped.
#[tauri::command]
pub fn cipher_rekey_cancel(state: State<AppState>) {
    let dir = &state.data_dir;
    if !cipher::read_marker(dir).is_some_and(|m| m.direction == Direction::Rekey && m.step != cipher::Step::Swapped) {
        drop_next_key(dir);
    }
}

/// „Schlüssel mit Passwort schützen“: stores the key wrapped with `password` in the data folder
/// (`None` removes it).
#[tauri::command(async)]
pub fn cipher_password(state: State<'_, AppState>, password: Option<String>) -> Result<()> {
    let dir = &state.data_dir;
    match password.filter(|p| !p.is_empty()) {
        None => WrappedKey::remove(dir),
        Some(p) => {
            if p.chars().count() < 10 {
                return Err(Error::Parse(
                    tr!("Das Passwort braucht mindestens 10 Zeichen", "The password needs at least 10 characters")
                        .into(),
                ));
            }
            let key =
                cipher::key().or_else(|| stored_key(dir)).ok_or_else(|| Error::State(cipher::missing_key_text()))?;
            WrappedKey::wrap(&key, &p, cipher::WRAP_COST)?.write(dir)
        }
    }
}

/// Deletes the previous file of a switch now (instead of at the next start).
#[tauri::command]
pub fn cipher_drop_old(state: State<AppState>) -> Result<()> {
    cipher::drop_old(&state.data_dir)
}

/// Deletes the local backups from before the encryption (overwritten first).
#[tauri::command]
pub fn cipher_drop_plain_backups(state: State<AppState>) -> Result<usize> {
    let files = cipher::plain_backups(&state.backup_dir());
    for f in &files {
        cipher::secure_delete(f)?;
        let _ = std::fs::remove_file(annalo_core::backupdest::sum_path(f));
    }
    devlog::info("cipher", format!("{} unencrypted local backups deleted", files.len()));
    Ok(files.len())
}

// --------------------------------------------------------------- app lock

struct LockState {
    /// A PIN is stored (cached: the credential store is not asked every few seconds).
    has_pin: bool,
    last_tick: Option<SystemTime>,
    /// Debug builds: the idle time the next check sees (end-to-end tests).
    fake_idle: Option<Duration>,
}

static LOCKED: AtomicBool = AtomicBool::new(false);
static LOCK: Mutex<LockState> = Mutex::new(LockState { has_pin: false, last_tick: None, fake_idle: None });

pub fn is_locked() -> bool {
    LOCKED.load(Ordering::SeqCst)
}

/// A clock jump this large between two checks (every 5 s) means the computer slept.
const SLEEP_GAP: Duration = Duration::from_secs(90);

/// Commands the lock screens use; everything else waits for the unlock. Changing the lock
/// itself (a new PIN, switching it off) needs the unlocked app.
fn allowed(cmd: &str) -> bool {
    (cmd.starts_with("applock_") && cmd != "applock_configure")
        || cmd.starts_with("keygate_")
        || matches!(
            cmd,
            "window_ready"
                | "window_frame"
                | "window_hide"
                | "window_close_action"
                | "window_state_save"
                | "app_quit"
                | "devlog_write"
                | "settings_get"
                | "capture_show"
                | "capture_hide"
                | "search_hide"
        )
}

/// Wraps the app's command handler: while locked, other commands are refused.
pub fn guard<F>(inner: F) -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static
where
    F: Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static,
{
    move |invoke| {
        if is_locked() && !allowed(invoke.message.command()) {
            invoke.resolver.reject(LOCKED_ERROR);
            return true;
        }
        inner(invoke)
    }
}

/// At the start, once the database is open: locked from the first frame when the lock is on.
pub fn init_lock(app: &AppHandle) {
    let state = app.state::<AppState>();
    let config = state.db().applock_config();
    let has_pin = SecretStore::app_lock_pin(&state.data_dir).get().is_some();
    lock(&LOCK).has_pin = has_pin;
    if config.enabled() && has_pin {
        LOCKED.store(true, Ordering::SeqCst);
        devlog::info("applock", "locked at start");
    }
}

fn set_locked(app: &AppHandle, locked: bool) {
    if !locked {
        PENDING.store(false, Ordering::SeqCst);
    }
    if LOCKED.swap(locked, Ordering::SeqCst) == locked {
        return;
    }
    devlog::info("applock", if locked { "locked" } else { "unlocked" });
    if locked {
        crate::desktop::hide_popups(app);
        // The taskbar and the window switcher show the title: no page name while locked (the
        // app sets it again once it is back).
        if let Some(w) = app.get_webview_window(crate::desktop::MAIN) {
            let _ = w.set_title("Arcalo");
        }
    }
    let _ = app.emit("applock://changed", locked);
    crate::desktop::refresh_tray(app);
    if !locked {
        crate::desktop::show_main(app);
    }
}

/// A lock is asked for and waits for the main window to save what is being edited.
static PENDING: AtomicBool = AtomicBool::new(false);
/// How long the main window gets to save before the lock comes anyway.
const FLUSH_WAIT: Duration = Duration::from_secs(3);

/// Every lock (idle time, sleep, „Jetzt sperren“): the main window first saves its open editors
/// (`applock://locking`, answered by [`applock_flushed`]), because the lock screen unmounts
/// them and their saves would be refused once locked. Without an answer the lock comes after
/// [`FLUSH_WAIT`] anyway.
fn request_lock(app: &AppHandle) {
    if is_locked() || PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let asked = app.get_webview_window(crate::desktop::MAIN).is_some()
        && app.emit_to(crate::desktop::MAIN, "applock://locking", ()).is_ok();
    if !asked {
        PENDING.store(false, Ordering::SeqCst);
        set_locked(app, true);
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FLUSH_WAIT);
        if PENDING.swap(false, Ordering::SeqCst) {
            devlog::warn("applock", "the main window did not confirm its saves, locking anyway");
            set_locked(&app, true);
        }
    });
}

/// The main window saved its editors: the requested lock comes now.
#[tauri::command]
pub fn applock_flushed(app: AppHandle) {
    if PENDING.swap(false, Ordering::SeqCst) {
        set_locked(&app, true);
    }
}

/// Every few seconds: locks after the idle time or after the computer slept.
pub fn tick(app: &AppHandle, idle: Option<Duration>) {
    let now = SystemTime::now();
    let (slept, fake, has_pin) = {
        let mut l = lock(&LOCK);
        let slept = l.last_tick.and_then(|t| now.duration_since(t).ok()).is_some_and(|d| d > SLEEP_GAP);
        l.last_tick = Some(now);
        (slept, l.fake_idle.take(), l.has_pin)
    };
    if is_locked() || !has_pin {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else { return };
    let config = state.db().applock_config();
    if !config.enabled() {
        return;
    }
    let idle = fake.or(idle);
    let by_idle = config.idle_limit().is_some_and(|limit| idle.is_some_and(|d| d >= limit));
    let by_sleep = config.on_sleep && slept;
    if by_idle || by_sleep {
        devlog::info("applock", if by_idle { "idle time reached" } else { "the computer slept" });
        request_lock(app);
    }
}

#[derive(Serialize)]
pub struct LockStatus {
    config: LockConfig,
    has_pin: bool,
    locked: bool,
    /// Seconds until the next PIN is accepted.
    wait_secs: u64,
    failures: u32,
    /// `windows_hello`, `touch_id` or none.
    os_auth: Option<&'static str>,
    /// The database is encrypted: the recovery key resets a forgotten PIN.
    encrypted: bool,
    theme: String,
    lang: &'static str,
}

fn status_of(state: &AppState) -> LockStatus {
    let db = state.db();
    let attempts = db.applock_attempts();
    LockStatus {
        config: db.applock_config(),
        has_pin: lock(&LOCK).has_pin,
        locked: is_locked(),
        wait_secs: attempts.remaining(Utc::now()).as_secs_f64().ceil() as u64,
        failures: attempts.failures,
        os_auth: os::available(),
        encrypted: cipher::file_state(&state.data_dir.join(datadir::DB_FILE)) == FileState::Encrypted,
        theme: serde_json::to_value(state.settings().theme)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_default(),
        lang: lang_code(),
    }
}

#[tauri::command]
pub fn applock_status(state: State<AppState>) -> LockStatus {
    status_of(&state)
}

/// Saves the lock's settings; `pin` sets a new PIN (needed to switch the lock on). Switching
/// it off deletes the PIN.
#[tauri::command(async)]
pub fn applock_configure(
    app: AppHandle,
    state: State<'_, AppState>,
    config: LockConfig,
    pin: Option<String>,
) -> Result<LockStatus> {
    let store = SecretStore::app_lock_pin(&state.data_dir);
    if let Some(pin) = pin.filter(|p| !p.is_empty()) {
        let hash = applock::hash_pin(&pin)?;
        store.set(Some(&hash)).map_err(Error::State)?;
        lock(&LOCK).has_pin = true;
    }
    if config.enabled() && !lock(&LOCK).has_pin {
        return Err(Error::State(tr!("Bitte zuerst eine PIN festlegen", "Please set a PIN first").into()));
    }
    if !config.enabled() {
        store.set(None).map_err(Error::State)?;
        lock(&LOCK).has_pin = false;
    }
    {
        let db = state.db();
        db.set_applock_config(&config)?;
        db.set_applock_attempts(&Default::default())?;
    }
    devlog::info("applock", format!("configured: {:?}", config.mode));
    crate::desktop::refresh_tray(&app);
    Ok(status_of(&state))
}

#[derive(Serialize)]
pub struct UnlockReply {
    ok: bool,
    wait_secs: u64,
    failures: u32,
}

/// „Entsperren“ with the PIN. Wrong PINs make the next attempt wait longer (also across starts).
#[tauri::command(async)]
pub fn applock_unlock(app: AppHandle, state: State<'_, AppState>, pin: String) -> Result<UnlockReply> {
    let now = Utc::now();
    let mut attempts = state.db().applock_attempts();
    let wait = attempts.remaining(now);
    if !wait.is_zero() {
        return Ok(UnlockReply { ok: false, wait_secs: wait.as_secs_f64().ceil() as u64, failures: attempts.failures });
    }
    let hash = SecretStore::app_lock_pin(&state.data_dir).get().unwrap_or_default();
    if applock::verify_pin(&pin, &hash) {
        state.db().set_applock_attempts(&Default::default())?;
        set_locked(&app, false);
        return Ok(UnlockReply { ok: true, wait_secs: 0, failures: 0 });
    }
    attempts.failed(now);
    state.db().set_applock_attempts(&attempts)?;
    devlog::warn("applock", format!("wrong PIN ({} in a row)", attempts.failures));
    Ok(UnlockReply {
        ok: false,
        wait_secs: applock::wait_after(attempts.failures).as_secs(),
        failures: attempts.failures,
    })
}

fn os_reason() -> &'static str {
    tr!("Arcalo entsperren", "Unlock Arcalo")
}

/// „Mit Windows Hello“ / „Mit Touch ID“.
#[tauri::command(async)]
pub fn applock_unlock_os(app: AppHandle, state: State<'_, AppState>) -> Result<bool> {
    if !os::verify(&app, os_reason()) {
        return Ok(false);
    }
    state.db().set_applock_attempts(&Default::default())?;
    set_locked(&app, false);
    Ok(true)
}

/// „Sperre zurücksetzen“ (PIN forgotten): with the system's sign-in, or with the recovery key
/// of the encrypted database. Switches the lock off and deletes the PIN.
#[tauri::command(async)]
pub fn applock_reset(app: AppHandle, state: State<'_, AppState>, recovery: Option<String>) -> Result<()> {
    let ok = match recovery.filter(|r| !r.trim().is_empty()) {
        Some(code) => {
            let key = DbKey::from_recovery_code(&code)?;
            let current = cipher::key().ok_or_else(|| Error::State(cipher::missing_key_text()))?;
            if key != current {
                return Err(Error::State(cipher::wrong_key_text()));
            }
            true
        }
        None => os::verify(&app, os_reason()),
    };
    if !ok {
        return Err(Error::State(tr!("Nicht bestätigt", "Not confirmed").into()));
    }
    SecretStore::app_lock_pin(&state.data_dir).set(None).map_err(Error::State)?;
    lock(&LOCK).has_pin = false;
    {
        let db = state.db();
        let mut c = db.applock_config();
        c.mode = applock::LockMode::Off;
        db.set_applock_config(&c)?;
        db.set_applock_attempts(&Default::default())?;
    }
    devlog::warn("applock", "lock reset (PIN forgotten)");
    set_locked(&app, false);
    Ok(())
}

/// „Jetzt sperren“ (command palette, tray).
#[tauri::command]
pub fn applock_lock_now(app: AppHandle, state: State<AppState>) -> Result<()> {
    if !state.db().applock_config().enabled() || !lock(&LOCK).has_pin {
        return Err(Error::State(tr!("Die App-Sperre ist aus", "The app lock is off").into()));
    }
    request_lock(&app);
    Ok(())
}

/// The lock screen of a small window: brings the main window (and its lock screen) forward.
#[tauri::command]
pub fn applock_show_main(app: AppHandle) {
    crate::desktop::hide_popups(&app);
    crate::desktop::show_main(&app);
}

/// End-to-end tests (debug builds): the next check sees `seconds` without input and runs now.
#[tauri::command]
pub fn applock_test_idle(app: AppHandle, seconds: u64) -> Result<()> {
    if !cfg!(debug_assertions) {
        return Err(Error::State("debug builds only".into()));
    }
    lock(&LOCK).fake_idle = Some(Duration::from_secs(seconds));
    tick(&app, None);
    Ok(())
}

/// The text of a notification while locked: nothing about its content.
pub fn locked_notification() -> (&'static str, &'static str) {
    ("Arcalo", tr!("Neue Benachrichtigung – zum Ansehen entsperren", "New notification – unlock to see it"))
}

// ---------------------------------------------------------- system sign-in

/// Windows Hello and Touch ID (or the Mac's password): the system asks, Arcalo only gets yes or no.
mod os {
    use tauri::AppHandle;

    #[cfg(windows)]
    pub fn available() -> Option<&'static str> {
        use windows::Security::Credentials::UI::{UserConsentVerifier, UserConsentVerifierAvailability};
        let a = UserConsentVerifier::CheckAvailabilityAsync().and_then(|op| op.get()).ok()?;
        (a == UserConsentVerifierAvailability::Available).then_some("windows_hello")
    }

    #[cfg(windows)]
    pub fn verify(app: &AppHandle, reason: &str) -> bool {
        use tauri::Manager;
        use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier};
        use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
        use windows::core::{HSTRING, factory};
        let message = HSTRING::from(reason);
        // For the main window, so the prompt comes up in front of it.
        let hwnd = app.get_webview_window(crate::desktop::MAIN).and_then(|w| w.hwnd().ok());
        let result = match hwnd {
            Some(hwnd) => factory::<UserConsentVerifier, IUserConsentVerifierInterop>().and_then(|interop| {
                let op: windows_future::IAsyncOperation<UserConsentVerificationResult> =
                    unsafe { interop.RequestVerificationForWindowAsync(hwnd, &message)? };
                op.get()
            }),
            None => UserConsentVerifier::RequestVerificationAsync(&message).and_then(|op| op.get()),
        };
        match result {
            Ok(r) => r == UserConsentVerificationResult::Verified,
            Err(e) => {
                crate::devlog::warn("applock", format!("Windows Hello failed: {e}"));
                false
            }
        }
    }

    #[cfg(target_os = "macos")]
    pub fn available() -> Option<&'static str> {
        use objc2_local_authentication::{LAContext, LAPolicy};
        let ctx = unsafe { LAContext::new() };
        unsafe { ctx.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthenticationWithBiometrics) }
            .is_ok()
            .then_some("touch_id")
    }

    #[cfg(target_os = "macos")]
    pub fn verify(_app: &AppHandle, reason: &str) -> bool {
        use block2::RcBlock;
        use objc2::runtime::Bool;
        use objc2_foundation::{NSError, NSString};
        use objc2_local_authentication::{LAContext, LAPolicy};
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        let reply: RcBlock<dyn Fn(Bool, *mut NSError)> = RcBlock::new(move |ok: Bool, _err: *mut NSError| {
            let _ = tx.send(ok.as_bool());
        });
        let ctx = unsafe { LAContext::new() };
        // Touch ID, or the Mac's password when the finger is not recognized.
        unsafe {
            ctx.evaluatePolicy_localizedReason_reply(
                LAPolicy::DeviceOwnerAuthentication,
                &NSString::from_str(reason),
                &reply,
            )
        };
        rx.recv_timeout(std::time::Duration::from_secs(180)).unwrap_or(false)
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn available() -> Option<&'static str> {
        None
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    pub fn verify(_app: &AppHandle, _reason: &str) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_screens_keep_only_their_own_commands() {
        for ok in ["applock_unlock", "applock_status", "keygate_unlock", "window_ready", "settings_get", "capture_show"]
        {
            assert!(allowed(ok), "{ok}");
        }
        for no in [
            "page_get",
            "workspace_tree",
            "search",
            "cipher_status",
            "backup_restore",
            "chat_send",
            "settings_save",
            // A new PIN or switching the lock off from behind the lock screen.
            "applock_configure",
        ] {
            assert!(!allowed(no), "{no}");
        }
    }

    #[test]
    fn locked_notifications_hide_their_content() {
        let (title, body) = locked_notification();
        assert_eq!(title, "Arcalo");
        assert!(!body.is_empty());
    }

    #[test]
    fn the_handoff_key_is_read_once() {
        let dir = std::env::temp_dir().join(format!("annalo-handoff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let key = DbKey::generate().unwrap();
        write_handoff(&dir, &key).unwrap();
        assert_eq!(take_handoff(&dir), Some(key));
        assert_eq!(take_handoff(&dir), None);
        assert!(!dir.join(HANDOFF).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
