//! The command `arcalo` in a terminal (docs/cli.md, "Where the program is"): the program on the
//! PATH, where that can be done safely.
//!
//! - Windows: the program folder on the user's `Path` (`HKCU\Environment`). The installer adds it
//!   on install and update and removes it on uninstall by starting the installed program with
//!   [`INTERNAL_ARG`] (installer/hooks.nsh); Settings → Desktop does the same for any copy (opt-in
//!   for a portable one). The value is read and written raw, not through the environment: its
//!   type (`REG_EXPAND_SZ`, so entries like `%USERPROFILE%\bin` stay unexpanded) and every other
//!   entry stay exactly as they are, at any length. Windows PowerShell's
//!   `[Environment]::GetEnvironmentVariable("Path", "User")` returns the expanded value and its
//!   `SetEnvironmentVariable` writes `REG_SZ`, which would freeze those entries; the NSIS string
//!   functions stop at 1024 (8192) characters. Never the machine `Path`.
//! - macOS: a link `/usr/local/bin/arcalo` to the program in the app bundle, made from the
//!   settings with the administrator prompt of macOS, never silently.
//! - Linux: the packages install `/usr/bin/arcalo`; the settings only show where the program is.
//! - Microsoft Store: the package's alias `Arcalo.exe` is on the PATH already.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::Result;
use arcalo_core::Error;
#[allow(unused_imports)]
use arcalo_core::{tr, trf};

/// `arcalo.exe --internal-path add|remove [<folder>]`: the installer's way to change the user's
/// `Path` (not a command of docs/cli.md). Without a folder: the program's own.
pub const INTERNAL_ARG: &str = "--internal-path";

/// Whether the command is available in a terminal, for Settings → Desktop.
#[derive(Debug, Serialize)]
pub struct CliPathInfo {
    /// `windows`, `macos` or `linux`.
    platform: &'static str,
    /// The program a terminal command starts.
    program: String,
    /// What is put on the PATH: the program folder (Windows) or the link (macOS).
    entry: Option<String>,
    /// `on`, `off`, `elsewhere` (macOS: the link names another program) or `managed` (the
    /// Microsoft Store alias; nothing to change).
    state: &'static str,
    /// Where the link of another program points (`elsewhere`).
    other: Option<String>,
    /// The switch can change it.
    changeable: bool,
    /// Why it cannot (shown instead of the switch).
    note: Option<String>,
}

#[tauri::command]
pub fn cli_path_info() -> CliPathInfo {
    info()
}

/// Puts the command on the PATH or takes it off. A cancelled password prompt (macOS) changes
/// nothing and is not an error.
#[tauri::command]
pub async fn cli_path_set(enabled: bool) -> Result<CliPathInfo> {
    // The macOS prompt waits for the user: off the main thread.
    tauri::async_runtime::spawn_blocking(move || set(enabled)).await.map_err(|e| Error::State(e.to_string()))??;
    Ok(info())
}

fn program() -> PathBuf {
    // An AppImage runs from a mount that changes with every start: the AppImage file is the program.
    #[cfg(target_os = "linux")]
    if let Some(appimage) = std::env::var_os("APPIMAGE").filter(|a| !a.is_empty()) {
        return PathBuf::from(appimage);
    }
    std::env::current_exe().unwrap_or_default()
}

#[cfg(windows)]
fn info() -> CliPathInfo {
    let program = program();
    let dir = program.parent().map(Path::to_path_buf).unwrap_or_default();
    let store = crate::store::active();
    let on =
        !store && user_path::read().is_ok_and(|value| path_list::contains(&value, &dir.to_string_lossy(), &env_lookup));
    CliPathInfo {
        platform: "windows",
        program: program.display().to_string(),
        entry: Some(dir.display().to_string()),
        state: if store {
            "managed"
        } else if on {
            "on"
        } else {
            "off"
        },
        other: None,
        changeable: !store,
        note: None,
    }
}

#[cfg(windows)]
fn set(enabled: bool) -> Result<()> {
    if crate::store::active() {
        return Err(Error::State(
            tr!("Im Store-Paket ist „arcalo“ schon verfügbar", "In the Store package “arcalo” is available already")
                .into(),
        ));
    }
    let dir = program().parent().map(Path::to_path_buf).unwrap_or_default();
    change_user_path(enabled, &dir)?;
    // The installed copy remembers the choice, so an update does not add the folder back.
    if !crate::portable::active() && user_path::installed_in(&dir, &env_lookup) {
        user_path::set_opted_out(!enabled).map_err(|e| Error::State(e.to_string()))?;
    }
    Ok(())
}

/// Adds `dir` to the user's `Path` or removes it. `Ok(false)`: nothing to do.
#[cfg(windows)]
fn change_user_path(add: bool, dir: &Path) -> Result<bool> {
    let Some(dir) = dir.to_str().filter(|d| !d.is_empty()) else {
        return Err(Error::State(
            tr!("Der Programmordner hat keinen gültigen Namen", "The program folder has no valid name").into(),
        ));
    };
    let changed = user_path::change(|value| {
        if add { path_list::add(value, dir, &env_lookup) } else { path_list::remove(value, dir, &env_lookup) }
    })
    .map_err(|e| {
        Error::State(trf!("Der Benutzerpfad (PATH) wurde nicht geändert: {}", "The user PATH was not changed: {}", e))
    })?;
    Ok(changed)
}

#[cfg(windows)]
fn env_lookup(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// `arcalo.exe --internal-path add|remove [<folder>]` (the installer): exit code 0 when the
/// `Path` is as asked (changed or already so), 1 for wrong arguments, 4 when it could not be changed.
pub fn internal(args: &[std::ffi::OsString]) -> std::process::ExitCode {
    let add = match args.first().and_then(|a| a.to_str()) {
        Some("add") => true,
        Some("remove") => false,
        _ => {
            eprintln!("usage: arcalo {INTERNAL_ARG} add|remove [<folder>]");
            return std::process::ExitCode::from(1);
        }
    };
    #[cfg(windows)]
    {
        let dir = match args.get(1) {
            Some(dir) => folder_arg(dir),
            None => program().parent().map(Path::to_path_buf).unwrap_or_default(),
        };
        // Switched off in the settings: install and update leave it off.
        if add && user_path::opted_out() {
            return std::process::ExitCode::SUCCESS;
        }
        match change_user_path(add, &dir) {
            Ok(_) => std::process::ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("{e}");
                std::process::ExitCode::from(4)
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = add;
        eprintln!("{INTERNAL_ARG} changes the Windows user Path only");
        std::process::ExitCode::from(1)
    }
}

/// The folder the installer named. NSIS quotes it (`"<folder>"`); a folder ending in a backslash
/// (`"D:\"`) reaches the program as `D:"`, since `\"` is a quote inside the argument for Windows'
/// argument parsing. A Windows path holds no `"`, so a trailing one is that quote.
#[cfg_attr(not(windows), allow(dead_code))]
fn folder_arg(arg: &std::ffi::OsStr) -> PathBuf {
    match arg.to_str().and_then(|s| s.strip_suffix('"')) {
        Some(s) => PathBuf::from(format!("{s}\\")),
        None => PathBuf::from(arg),
    }
}

/// The program runs from a place macOS gives it only for this start: the opened disk image
/// (`/Volumes/…`, gone after ejecting) or the read-only copy Gatekeeper starts an app from that
/// was opened in Downloads without being moved ("App Translocation"). Updates, the login item
/// and the terminal command need the app in a lasting place.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn temporary_place(program: &Path) -> bool {
    let p = program.to_string_lossy();
    p.contains("/AppTranslocation/") || p.starts_with("/Volumes/")
}

/// For the start: a notice when the app runs from a temporary place ([`temporary_place`]).
#[cfg(target_os = "macos")]
pub fn temporary_place_notice() -> Option<arcalo_core::datadir::Notice> {
    temporary_place(&program()).then(|| {
        arcalo_core::datadir::Notice::titled(
            "warning",
            tr!("Arcalo ist nicht installiert", "Arcalo is not installed"),
            tr!(
                "Arcalo läuft direkt aus dem Disk-Image oder aus „Downloads“. So funktionieren Updates, „Bei der \
                 Anmeldung starten“ und der Befehl „arcalo“ nicht. Beende Arcalo, zieh es in den Ordner „Programme“ \
                 und starte es von dort.",
                "Arcalo runs straight from the disk image or from Downloads, so updates, “Open at login” and the \
                 “arcalo” command do not work. Quit Arcalo, drag it into the Applications folder and start it \
                 from there."
            )
            .into(),
        )
    })
}

#[cfg(not(target_os = "macos"))]
pub fn temporary_place_notice() -> Option<arcalo_core::datadir::Notice> {
    None
}

#[cfg(target_os = "macos")]
fn info() -> CliPathInfo {
    let program = program();
    let link = mac::LINK.to_string();
    let base = |state, other, changeable, note| CliPathInfo {
        platform: "macos",
        program: program.display().to_string(),
        entry: Some(link.clone()),
        state,
        other,
        changeable,
        note,
    };
    let movable = mac::installable(&program);
    match mac::read(&program) {
        mac::Link::Ours => base("on", None, true, None),
        mac::Link::Missing => base("off", None, movable.is_ok(), movable.err()),
        mac::Link::Other(target) => base("elsewhere", Some(target), movable.is_ok(), movable.err()),
        mac::Link::File => base(
            "elsewhere",
            None,
            false,
            Some(trf!(
                "{} ist ein anderes Programm und wird nicht ersetzt.",
                "{} is another program and is not replaced.",
                mac::LINK
            )),
        ),
    }
}

#[cfg(target_os = "macos")]
fn set(enabled: bool) -> Result<()> {
    let program = program();
    let failed =
        |e: String| Error::State(trf!("Der Befehl wurde nicht eingerichtet: {}", "The command was not set up: {}", e));
    match (enabled, mac::read(&program)) {
        (true, mac::Link::Ours) | (false, mac::Link::Missing) => Ok(()),
        // Only a link of ours is removed; one to another program stays.
        (false, mac::Link::Other(_) | mac::Link::File) => Ok(()),
        (true, mac::Link::File) => Err(failed(trf!("{} ist ein anderes Programm", "{} is another program", mac::LINK))),
        (true, _) => {
            mac::installable(&program).map_err(failed)?;
            mac::install(&program).map_err(failed)
        }
        (false, mac::Link::Ours) => mac::uninstall().map_err(failed),
    }
}

#[cfg(target_os = "linux")]
fn info() -> CliPathInfo {
    let program = program();
    let on = std::env::var_os("PATH").is_some_and(|path| on_path(&program, &path, "arcalo"));
    CliPathInfo {
        platform: "linux",
        program: program.display().to_string(),
        entry: None,
        state: if on { "on" } else { "off" },
        other: None,
        changeable: false,
        note: None,
    }
}

#[cfg(target_os = "linux")]
fn set(_enabled: bool) -> Result<()> {
    Err(Error::State(
        tr!("Unter Linux richtet das Paket den Befehl ein", "On Linux the package sets up the command").into(),
    ))
}

/// A folder of `path` (a `PATH` value) holds `name` that is `program` (or a link to it).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn on_path(program: &Path, path: &std::ffi::OsStr, name: &str) -> bool {
    let Ok(program) = std::fs::canonicalize(program) else { return false };
    std::env::split_paths(path).any(|dir| std::fs::canonicalize(dir.join(name)).is_ok_and(|p| p == program))
}

/// The entries of a Windows `Path` value: `;`-separated, compared like Windows compares folders.
/// Everything but the entry added or removed stays byte for byte as it is. Tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub mod path_list {
    /// `value` names `dir` (in any case, with or without a trailing backslash, with variables
    /// such as `%LOCALAPPDATA%` expanded or not).
    pub fn contains(value: &str, dir: &str, lookup: &dyn Fn(&str) -> Option<String>) -> bool {
        let want = normalize(&expand(dir, lookup));
        !want.is_empty() && value.split(';').any(|entry| normalize(&expand(entry, lookup)) == want)
    }

    /// `value` with `dir` appended, or `None` when it names `dir` already.
    pub fn add(value: &str, dir: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        if contains(value, dir, lookup) {
            return None;
        }
        // A value ending in `;` keeps ending in one, so removing the entry gives it back as it was.
        Some(if value.is_empty() {
            dir.to_string()
        } else if value.ends_with(';') {
            format!("{value}{dir};")
        } else {
            format!("{value};{dir}")
        })
    }

    /// `value` without the entries that name `dir`, or `None` when there is none.
    pub fn remove(value: &str, dir: &str, lookup: &dyn Fn(&str) -> Option<String>) -> Option<String> {
        if !contains(value, dir, lookup) {
            return None;
        }
        let want = normalize(&expand(dir, lookup));
        let kept: Vec<&str> = value.split(';').filter(|entry| normalize(&expand(entry, lookup)) != want).collect();
        Some(kept.join(";"))
    }

    /// `%NAME%` replaced by the variable's value, as Windows expands a `REG_EXPAND_SZ`; an
    /// unknown variable stays as it is.
    pub fn expand(s: &str, lookup: &dyn Fn(&str) -> Option<String>) -> String {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(start) = rest.find('%') {
            out.push_str(&rest[..start]);
            let after = &rest[start + 1..];
            match after.find('%') {
                Some(end) if end > 0 => match lookup(&after[..end]) {
                    Some(v) => {
                        out.push_str(&v);
                        rest = &after[end + 1..];
                    }
                    None => {
                        // Not a variable: the second `%` may open the next one.
                        out.push('%');
                        out.push_str(&after[..end]);
                        rest = &after[end..];
                    }
                },
                _ => {
                    out.push('%');
                    rest = after;
                }
            }
        }
        out.push_str(rest);
        out
    }

    /// A folder as Windows compares it: no quotes, spaces or trailing separators, any case.
    fn normalize(entry: &str) -> String {
        let s = entry.trim();
        let s = s.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(s).trim();
        s.trim_end_matches(['\\', '/']).replace('/', "\\").to_lowercase()
    }

    /// A `REG_SZ`/`REG_EXPAND_SZ` value's bytes as text, without its terminating zeros. `None`
    /// for anything that would not be written back exactly (odd length, a zero inside, invalid
    /// UTF-16): such a value is left alone.
    pub fn decode(bytes: &[u8]) -> Option<String> {
        if !bytes.len().is_multiple_of(2) {
            return None;
        }
        let mut units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        while units.last() == Some(&0) {
            units.pop();
        }
        if units.contains(&0) {
            return None;
        }
        String::from_utf16(&units).ok()
    }

    /// `s` as the bytes of a registry string, with its terminating zero.
    pub fn encode(s: &str) -> Vec<u8> {
        s.encode_utf16().chain(std::iter::once(0)).flat_map(u16::to_le_bytes).collect()
    }
}

/// The user's `Path` in the registry (`HKCU\Environment`), read and written raw.
#[cfg(windows)]
mod user_path {
    use std::io;

    use winreg::enums::{HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ};
    use winreg::{RegKey, RegValue};

    use super::path_list;

    const KEY: &str = "Environment";
    const VALUE: &str = "Path";
    /// The installer's key (Tauri's NSIS template: `Software\<publisher>\<product>`, its default
    /// value the install folder). Removed by uninstalling with „App-Daten löschen“.
    const INSTALL_KEY: &str = "Software\\MouseWerk\\Arcalo";
    /// 0: the user switched the command off in the settings.
    const OPT_OUT: &str = "CommandLinePath";

    /// `dir` is the folder the installer installed into.
    pub fn installed_in(dir: &std::path::Path, lookup: &dyn Fn(&str) -> Option<String>) -> bool {
        let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(INSTALL_KEY, KEY_QUERY_VALUE) else {
            return false;
        };
        key.get_value::<String, _>("")
            .is_ok_and(|installed| path_list::contains(&installed, &dir.to_string_lossy(), lookup))
    }

    pub fn opted_out() -> bool {
        RegKey::predef(HKEY_CURRENT_USER)
            .open_subkey_with_flags(INSTALL_KEY, KEY_QUERY_VALUE)
            .and_then(|key| key.get_value::<u32, _>(OPT_OUT))
            .is_ok_and(|v| v == 0)
    }

    pub fn set_opted_out(off: bool) -> io::Result<()> {
        let (key, _) =
            RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(INSTALL_KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        if off {
            return key.set_value(OPT_OUT, &0u32);
        }
        match key.delete_value(OPT_OUT) {
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            r => r,
        }
    }

    pub fn read() -> io::Result<String> {
        let key = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(KEY, KEY_QUERY_VALUE)?;
        Ok(read_value(&key, VALUE)?.map(|(text, _)| text).unwrap_or_default())
    }

    /// Applies `f` to the value (`None` from `f`: unchanged) and tells running programs
    /// (Explorer, so new terminals) that the environment changed. `Ok(true)` when written.
    pub fn change(f: impl FnOnce(&str) -> Option<String>) -> io::Result<bool> {
        let (key, _) =
            RegKey::predef(HKEY_CURRENT_USER).create_subkey_with_flags(KEY, KEY_QUERY_VALUE | KEY_SET_VALUE)?;
        let changed = change_value(&key, VALUE, f)?;
        if changed {
            broadcast();
        }
        Ok(changed)
    }

    /// The text and type of a string value (`None`: there is none).
    fn read_value(key: &RegKey, name: &str) -> io::Result<Option<(String, winreg::enums::RegType)>> {
        let raw = match key.get_raw_value(name) {
            Ok(raw) => raw,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(e),
        };
        if raw.vtype != REG_SZ && raw.vtype != REG_EXPAND_SZ {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{name} is not a text value ({:?})", raw.vtype),
            ));
        }
        let text = path_list::decode(&raw.bytes)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, format!("{name} is not plain text")))?;
        Ok(Some((text, raw.vtype)))
    }

    /// `f` on the value `name` of `key`, written back with its own type (a new value: `REG_EXPAND_SZ`,
    /// as Windows creates the user's `Path`).
    pub(super) fn change_value(key: &RegKey, name: &str, f: impl FnOnce(&str) -> Option<String>) -> io::Result<bool> {
        let (current, vtype) = read_value(key, name)?.unwrap_or((String::new(), REG_EXPAND_SZ));
        let Some(next) = f(&current) else { return Ok(false) };
        key.set_raw_value(name, &RegValue { bytes: path_list::encode(&next), vtype })?;
        Ok(true)
    }

    /// `WM_SETTINGCHANGE` with "Environment", as the system's environment dialog sends it.
    fn broadcast() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
        };
        let area: Vec<u16> = "Environment".encode_utf16().chain(std::iter::once(0)).collect();
        let mut result = 0usize;
        // SAFETY: `area` is a zero-terminated UTF-16 string that outlives the call; a hung
        // window is skipped after the timeout (5 s, as the environment dialog waits).
        unsafe {
            SendMessageTimeoutW(
                HWND_BROADCAST,
                WM_SETTINGCHANGE,
                0,
                area.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                5000,
                &mut result,
            );
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        /// A key of its own (never the real `Environment`), removed again.
        struct TestKey(String, RegKey);
        impl TestKey {
            fn new() -> Self {
                let path = format!("Software\\arcalo-test-path-{}", std::process::id());
                let (key, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path).unwrap();
                TestKey(path, key)
            }
        }
        impl Drop for TestKey {
            fn drop(&mut self) {
                let _ = RegKey::predef(HKEY_CURRENT_USER).delete_subkey_all(&self.0);
            }
        }
        const DIR: &str = "C:\\Users\\a\\AppData\\Local\\Arcalo";
        fn none(_: &str) -> Option<String> {
            None
        }

        #[test]
        fn keeps_the_type_and_every_other_byte() {
            let t = TestKey::new();
            let long: String = (0..700).map(|i| format!("%USERPROFILE%\\tools\\t{i:04}")).collect::<Vec<_>>().join(";");
            assert!(long.len() > 8192);
            t.1.set_raw_value("Path", &RegValue { bytes: path_list::encode(&long), vtype: REG_EXPAND_SZ }).unwrap();
            assert!(change_value(&t.1, "Path", |v| path_list::add(v, DIR, &none)).unwrap());
            assert!(!change_value(&t.1, "Path", |v| path_list::add(v, DIR, &none)).unwrap(), "added once");
            let raw = t.1.get_raw_value("Path").unwrap();
            assert_eq!(raw.vtype, REG_EXPAND_SZ);
            assert_eq!(path_list::decode(&raw.bytes).unwrap(), format!("{long};{DIR}"));
            assert!(change_value(&t.1, "Path", |v| path_list::remove(v, DIR, &none)).unwrap());
            let raw = t.1.get_raw_value("Path").unwrap();
            assert_eq!((raw.vtype, raw.bytes), (REG_EXPAND_SZ, path_list::encode(&long)));
        }

        #[test]
        fn a_plain_string_stays_plain_and_a_missing_value_is_created_expandable() {
            let t = TestKey::new();
            t.1.set_value("Path", &"C:\\bin").unwrap();
            change_value(&t.1, "Path", |v| path_list::add(v, DIR, &none)).unwrap();
            assert_eq!(t.1.get_raw_value("Path").unwrap().vtype, REG_SZ);
            change_value(&t.1, "New", |v| path_list::add(v, DIR, &none)).unwrap();
            let raw = t.1.get_raw_value("New").unwrap();
            assert_eq!((raw.vtype, path_list::decode(&raw.bytes).unwrap()), (REG_EXPAND_SZ, DIR.to_string()));
        }

        #[test]
        fn another_value_type_is_left_alone() {
            let t = TestKey::new();
            t.1.set_value("Path", &7u32).unwrap();
            assert!(change_value(&t.1, "Path", |v| path_list::add(v, DIR, &none)).is_err());
            assert_eq!(t.1.get_value::<u32, _>("Path").unwrap(), 7);
        }
    }
}

/// The link `/usr/local/bin/arcalo` (the folder is on the PATH of every macOS shell).
#[cfg(target_os = "macos")]
mod mac {
    use std::path::{Path, PathBuf};
    use std::process::Command;

    use arcalo_core::{tr, trf};

    pub const LINK: &str = "/usr/local/bin/arcalo";
    const BIN: &str = "/usr/local/bin";

    pub enum Link {
        Missing,
        /// A link to this program.
        Ours,
        /// A link to something else (where it points).
        Other(String),
        /// A file that is not a link (another installation): never replaced.
        File,
    }

    pub fn read(program: &Path) -> Link {
        let link = Path::new(LINK);
        let Ok(meta) = std::fs::symlink_metadata(link) else { return Link::Missing };
        if !meta.file_type().is_symlink() {
            return Link::File;
        }
        let Ok(target) = std::fs::read_link(link) else { return Link::Missing };
        let resolved = if target.is_absolute() { target.clone() } else { Path::new(BIN).join(&target) };
        match (std::fs::canonicalize(&resolved), std::fs::canonicalize(program)) {
            (Ok(a), Ok(b)) if a == b => Link::Ours,
            _ => Link::Other(target.display().to_string()),
        }
    }

    /// A link to this copy would last: not one macOS runs from a temporary place (an app
    /// opened in Downloads runs "translocated"; one in the disk image is gone after ejecting).
    pub fn installable(program: &Path) -> Result<(), String> {
        if super::temporary_place(program) {
            return Err(tr!(
                "Zieh Arcalo zuerst in den Ordner „Programme“ und starte es von dort.",
                "Move Arcalo to the Applications folder first and start it from there."
            )
            .into());
        }
        Ok(())
    }

    pub fn install(program: &Path) -> Result<(), String> {
        let program =
            program.to_str().ok_or_else(|| tr!("Ungültiger Programmpfad", "Invalid program path").to_string())?;
        // Without a prompt where the folder is writable (Homebrew on Intel Macs makes it so).
        if direct(|| {
            if std::fs::symlink_metadata(LINK).is_ok_and(|m| m.file_type().is_symlink()) {
                std::fs::remove_file(LINK)?;
            }
            std::os::unix::fs::symlink(program, LINK)
        }) {
            return Ok(());
        }
        let shell = format!("/bin/mkdir -p {BIN} && /bin/ln -sfn {} {LINK}", super::sh_quote(program));
        admin(
            &shell,
            tr!(
                "Arcalo möchte den Befehl „arcalo“ im Terminal verfügbar machen.",
                "Arcalo wants to make the “arcalo” command available in the terminal."
            ),
        )
    }

    pub fn uninstall() -> Result<(), String> {
        if direct(|| std::fs::remove_file(LINK)) {
            return Ok(());
        }
        admin(
            &format!("/bin/rm -f {LINK}"),
            tr!(
                "Arcalo möchte den Befehl „arcalo“ aus dem Terminal entfernen.",
                "Arcalo wants to remove the “arcalo” command from the terminal."
            ),
        )
    }

    /// Done without administrator rights (`false`: needs them).
    fn direct(f: impl FnOnce() -> std::io::Result<()>) -> bool {
        PathBuf::from(BIN).is_dir() && f().is_ok()
    }

    /// `shell` as root after the system's password prompt. Cancelling it is not an error.
    fn admin(shell: &str, prompt: &str) -> Result<(), String> {
        let out = Command::new("/usr/bin/osascript")
            .arg("-e")
            .arg(super::admin_script(shell, prompt))
            .output()
            .map_err(|e| e.to_string())?;
        let stderr = String::from_utf8_lossy(&out.stderr);
        if out.status.success() || stderr.contains("(-128)") {
            return Ok(());
        }
        Err(trf!("osascript: {}", "osascript: {}", stderr.trim()))
    }
}

/// `s` as one argument of `/bin/sh`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The AppleScript that runs `shell` as root after the password prompt with `prompt`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn admin_script(shell: &str, prompt: &str) -> String {
    let quote = |s: &str| format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""));
    format!("do shell script {} with prompt {} with administrator privileges", quote(shell), quote(prompt))
}

#[cfg(test)]
mod tests {
    use super::path_list::{add, contains, decode, encode, expand, remove};
    use super::*;

    const DIR: &str = "C:\\Users\\Jörg Müller\\AppData\\Local\\Arcalo";

    fn vars(name: &str) -> Option<String> {
        match name.to_ascii_uppercase().as_str() {
            "LOCALAPPDATA" => Some("C:\\Users\\Jörg Müller\\AppData\\Local".into()),
            "USERPROFILE" => Some("C:\\Users\\Jörg Müller".into()),
            _ => None,
        }
    }

    #[test]
    fn adds_once_in_every_spelling() {
        assert_eq!(add("C:\\bin", DIR, &vars).as_deref(), Some(format!("C:\\bin;{DIR}").as_str()));
        assert_eq!(add("C:\\bin;", DIR, &vars).as_deref(), Some(format!("C:\\bin;{DIR};").as_str()));
        assert_eq!(add("", DIR, &vars).as_deref(), Some(DIR));
        for there in [
            DIR.to_string(),
            format!("{DIR}\\"),
            DIR.to_uppercase(),
            "%LOCALAPPDATA%\\Arcalo".into(),
            "%localappdata%\\arcalo\\".into(),
            format!("\"{DIR}\""),
            format!(" {DIR} "),
            "C:/Users/Jörg Müller/AppData/Local/Arcalo/".into(),
        ] {
            let value = format!("C:\\bin;{there};%USERPROFILE%\\go\\bin");
            assert!(contains(&value, DIR, &vars), "{there}");
            assert_eq!(add(&value, DIR, &vars), None, "{there}");
        }
        // The installer's own folder given with the variable, too.
        assert_eq!(add(DIR, "%LOCALAPPDATA%\\Arcalo\\", &vars), None);
        // Not a prefix match.
        assert!(!contains("C:\\Users\\Jörg Müller\\AppData\\Local\\Arcalo2", DIR, &vars));
        assert!(!contains("C:\\Users\\Jörg Müller\\AppData\\Local", DIR, &vars));
        assert!(!contains("", "", &vars));
    }

    #[test]
    fn removes_exactly_that_entry() {
        let value = format!("%USERPROFILE%\\bin;{DIR};C:\\Tools;;D:\\x\\");
        assert_eq!(remove(&value, DIR, &vars).unwrap(), "%USERPROFILE%\\bin;C:\\Tools;;D:\\x\\");
        assert_eq!(remove(&value, "C:\\Other", &vars), None);
        assert_eq!(remove(DIR, DIR, &vars).unwrap(), "");
        assert_eq!(remove(&format!("{DIR};"), DIR, &vars).unwrap(), "");
        assert_eq!(remove(&format!("a;%LOCALAPPDATA%\\Arcalo\\;b;{DIR}"), DIR, &vars).unwrap(), "a;b");
        // The Annalo folder of an update in place is its own entry.
        let annalo = "C:\\Users\\Jörg Müller\\AppData\\Local\\Annalo";
        assert_eq!(remove(&format!("{annalo};{DIR}"), DIR, &vars).unwrap(), annalo);
    }

    #[test]
    fn add_then_remove_gives_back_the_value() {
        for value in ["", "C:\\bin", "C:\\bin;", "%USERPROFILE%\\bin;;C:\\x"] {
            let added = add(value, DIR, &vars).unwrap();
            let back = remove(&added, DIR, &vars).unwrap();
            assert_eq!(back, value);
        }
    }

    #[test]
    fn a_long_path_stays_byte_exact() {
        let long: String =
            (0..900).map(|i| format!("%USERPROFILE%\\tools\\werkzeug-ä{i:04}")).collect::<Vec<_>>().join(";");
        assert!(long.len() > 16384);
        let added = add(&long, DIR, &vars).unwrap();
        assert!(added.starts_with(&long));
        assert_eq!(remove(&added, DIR, &vars).unwrap(), long);
        let bytes = encode(&long);
        assert_eq!(decode(&bytes).unwrap(), long);
        assert_eq!(encode(&decode(&bytes).unwrap()), bytes);
    }

    #[test]
    fn registry_text_round_trips_or_is_refused() {
        assert_eq!(decode(&encode("C:\\x;€")).as_deref(), Some("C:\\x;€"));
        assert_eq!(decode(&[]).as_deref(), Some(""));
        // Without a terminating zero, or with several.
        assert_eq!(decode(&[b'a', 0]).as_deref(), Some("a"));
        assert_eq!(decode(&[b'a', 0, 0, 0, 0, 0]).as_deref(), Some("a"));
        assert_eq!(decode(&[b'a', 0, 0]), None, "odd length");
        assert_eq!(decode(&[b'a', 0, 0, 0, b'b', 0]), None, "a zero inside");
        assert_eq!(decode(&[0x00, 0xD8, b'a', 0]), None, "an unpaired surrogate");
    }

    #[test]
    fn expands_known_variables_only() {
        assert_eq!(expand("%LOCALAPPDATA%\\Arcalo", &vars), "C:\\Users\\Jörg Müller\\AppData\\Local\\Arcalo");
        assert_eq!(expand("%NOPE%\\x;%USERPROFILE%", &vars), "%NOPE%\\x;C:\\Users\\Jörg Müller");
        assert_eq!(expand("50%;%USERPROFILE%", &vars), "50%;C:\\Users\\Jörg Müller");
        assert_eq!(expand("%%", &vars), "%%");
        assert_eq!(expand("a%", &vars), "a%");
    }

    #[test]
    fn finds_the_program_on_a_path() {
        let dir = tempfile::tempdir().unwrap();
        let program = dir.path().join("prog");
        std::fs::write(&program, "").unwrap();
        let bin = dir.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let path = std::env::join_paths([dir.path().join("none"), bin.clone()]).unwrap();
        assert!(!on_path(&program, &path, "arcalo"));
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&program, bin.join("arcalo")).unwrap();
            assert!(on_path(&program, &path, "arcalo"));
            assert!(!on_path(&dir.path().join("other"), &path, "arcalo"));
        }
    }

    #[test]
    fn macos_prompt_script_quotes_paths() {
        let shell = format!(
            "/bin/ln -sfn {} /usr/local/bin/arcalo",
            sh_quote("/Applications/Jörg's \"Apps\"/Arcalo.app/Contents/MacOS/arcalo")
        );
        assert_eq!(
            shell,
            "/bin/ln -sfn '/Applications/Jörg'\\''s \"Apps\"/Arcalo.app/Contents/MacOS/arcalo' /usr/local/bin/arcalo"
        );
        assert_eq!(
            admin_script(&shell, "Arcalo möchte „arcalo“"),
            "do shell script \"/bin/ln -sfn '/Applications/Jörg'\\\\''s \\\"Apps\\\"/Arcalo.app/Contents/MacOS/arcalo' /usr/local/bin/arcalo\" with prompt \"Arcalo möchte „arcalo“\" with administrator privileges"
        );
    }

    #[test]
    fn the_installers_folder_argument_loses_the_quote_of_a_trailing_backslash() {
        use std::ffi::OsStr;
        // `"D:\"` and `"C:\Users\Jörg Müller\Annalo\"` as Windows hands them to the program.
        assert_eq!(folder_arg(OsStr::new("D:\"")), PathBuf::from("D:\\"));
        assert_eq!(
            folder_arg(OsStr::new("C:\\Users\\Jörg Müller\\Annalo\"")),
            PathBuf::from("C:\\Users\\Jörg Müller\\Annalo\\")
        );
        assert_eq!(
            folder_arg(OsStr::new("C:\\Users\\Jörg Müller\\Annalo")),
            PathBuf::from("C:\\Users\\Jörg Müller\\Annalo")
        );
        // The entry it names is the one installed (a trailing backslash is the same folder).
        let installed = format!("C:\\bin;{DIR}");
        let named = folder_arg(OsStr::new(&format!("{DIR}\""))).to_string_lossy().into_owned();
        assert_eq!(remove(&installed, &named, &vars).as_deref(), Some("C:\\bin"));
    }

    #[test]
    fn a_disk_image_or_a_translocated_copy_is_a_temporary_place() {
        for p in [
            "/Volumes/Arcalo/Arcalo.app/Contents/MacOS/arcalo",
            "/private/var/folders/xy/T/AppTranslocation/0A1B-2C3D/d/Arcalo.app/Contents/MacOS/arcalo",
        ] {
            assert!(temporary_place(Path::new(p)), "{p}");
        }
        for p in [
            "/Applications/Arcalo.app/Contents/MacOS/arcalo",
            "/Users/jörg/Applications/Arcalo.app/Contents/MacOS/arcalo",
            "/Users/jörg/Downloads/Arcalo.app/Contents/MacOS/arcalo",
        ] {
            assert!(!temporary_place(Path::new(p)), "{p}");
        }
    }

    /// The .deb's maintainer scripts (installer/deb-*.sh) run with `/bin/sh` (dash on Debian and
    /// Ubuntu) against a root of their own (`$DPKG_ROOT`, as `dpkg --root` sets it).
    #[cfg(target_os = "linux")]
    mod deb_scripts {
        use std::os::unix::fs::symlink;
        use std::path::Path;
        use std::process::Command;

        fn run(script: &str, root: &Path, arg: &str) {
            let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("installer").join(script);
            let out = Command::new("/bin/sh").arg(&path).arg(arg).env("DPKG_ROOT", root).output().unwrap();
            assert!(out.status.success(), "{script} {arg}: {}", String::from_utf8_lossy(&out.stderr));
        }
        /// A root with `/usr/bin/arcalo` as the package installs it.
        fn root() -> tempfile::TempDir {
            let root = tempfile::tempdir().unwrap();
            std::fs::create_dir_all(root.path().join("usr/bin")).unwrap();
            std::fs::write(root.path().join("usr/bin/arcalo"), "#!/bin/sh\n").unwrap();
            root
        }
        fn link(root: &Path) -> std::path::PathBuf {
            root.join("usr/bin/annalo")
        }
        fn target(root: &Path) -> Option<String> {
            std::fs::read_link(link(root)).ok().map(|t| t.to_string_lossy().into_owned())
        }

        #[test]
        fn install_links_the_old_name_once_and_remove_or_purge_takes_it() {
            for last in ["remove", "purge"] {
                let r = root();
                run("deb-postinst.sh", r.path(), "configure");
                assert_eq!(target(r.path()).as_deref(), Some("arcalo"));
                // Again (reinstall, dpkg-reconfigure): no error, the same link.
                run("deb-postinst.sh", r.path(), "configure");
                assert_eq!(target(r.path()).as_deref(), Some("arcalo"));
                // An upgrade keeps it (the new postinst finds it in place).
                run("deb-postrm.sh", r.path(), "upgrade");
                assert_eq!(target(r.path()).as_deref(), Some("arcalo"));
                // dpkg removes /usr/bin/arcalo before postrm: the link points to nothing then.
                std::fs::remove_file(r.path().join("usr/bin/arcalo")).unwrap();
                run("deb-postrm.sh", r.path(), last);
                assert!(std::fs::symlink_metadata(link(r.path())).is_err(), "{last}");
                // purge after remove: nothing left to do.
                run("deb-postrm.sh", r.path(), "purge");
            }
        }

        #[test]
        fn another_program_under_the_old_name_stays() {
            // A file of its own.
            let r = root();
            std::fs::write(link(r.path()), "#!/bin/sh\necho mein annalo\n").unwrap();
            run("deb-postinst.sh", r.path(), "configure");
            run("deb-postrm.sh", r.path(), "remove");
            run("deb-postrm.sh", r.path(), "purge");
            assert_eq!(std::fs::read_to_string(link(r.path())).unwrap(), "#!/bin/sh\necho mein annalo\n");
            // A link to another program that exists.
            let r = root();
            std::fs::write(r.path().join("usr/bin/other"), "").unwrap();
            symlink("other", link(r.path())).unwrap();
            run("deb-postinst.sh", r.path(), "configure");
            assert_eq!(target(r.path()).as_deref(), Some("other"));
            run("deb-postrm.sh", r.path(), "remove");
            assert_eq!(target(r.path()).as_deref(), Some("other"));
            // A link to nothing is replaced (it names no program).
            let r = root();
            symlink("/opt/annalo/annalo", link(r.path())).unwrap();
            run("deb-postinst.sh", r.path(), "configure");
            assert_eq!(target(r.path()).as_deref(), Some("arcalo"));
        }

        #[test]
        fn the_scripts_are_posix_shell() {
            for script in ["deb-postinst.sh", "deb-postrm.sh"] {
                let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("installer").join(script);
                let text = std::fs::read_to_string(&path).unwrap();
                assert!(text.starts_with("#!/bin/sh\n"), "{script}");
                assert!(!text.contains("\r"), "{script}: CRLF");
                // `sh -n`: parses; dash, where installed, as Debian runs it.
                for shell in ["/bin/sh", "/bin/dash"] {
                    if Path::new(shell).exists() {
                        let ok = Command::new(shell).arg("-n").arg(&path).status().unwrap().success();
                        assert!(ok, "{shell} -n {script}");
                    }
                }
            }
        }
    }

    #[test]
    fn internal_argument_needs_add_or_remove() {
        assert_eq!(internal(&[]), std::process::ExitCode::from(1));
        assert_eq!(internal(&["list".into()]), std::process::ExitCode::from(1));
    }
}
