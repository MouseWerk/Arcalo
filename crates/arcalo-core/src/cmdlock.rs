//! Terminal commands that are running (`arcalo pages list`, docs/cli.md), so an update waits for
//! them instead of ending them: the Windows setup ends every running `Arcalo.exe` of the user,
//! and a new version migrates the database on its first start.
//!
//! Each command holds a lock file `<pid> <command>.lock` in the folder [`DIR`] of the app's local
//! data folder (`%LOCALAPPDATA%\de.mousewerk.arcalo`, `~/Library/Application Support/…`,
//! `$XDG_DATA_HOME/…`: the same for the app and the command line, whatever workspace a command
//! names). The file is locked by the operating system while the command runs; a command that
//! crashed leaves a file nobody locks, which [`running`] removes. On a file system without locks
//! a file older than [`STALE_AFTER`] counts as left behind.

use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// The folder of the lock files in the app's local data folder.
pub const DIR: &str = "commands";

/// A lock file that cannot be locked (no file locks) and is older than this is left behind.
pub const STALE_AFTER: Duration = Duration::from_secs(12 * 60 * 60);

/// A lock file younger than this is never taken for left behind: its command may be between
/// creating the file and locking it.
const FRESH: Duration = Duration::from_secs(5);

/// How long an update waits for running commands before it goes on.
pub const WAIT_LIMIT: Duration = Duration::from_secs(120);

/// The lock of this process, held until it is dropped (the file goes with it).
#[derive(Debug)]
pub struct Held {
    file: Option<File>,
    path: PathBuf,
}

impl Drop for Held {
    fn drop(&mut self) {
        if let Some(file) = self.file.take() {
            let _ = file.unlock();
        }
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A command that is running.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Running {
    pub pid: u32,
    /// The command's words (`pages list`); never its arguments (a page's text, a path).
    pub command: String,
}

/// The file name of a command: `<pid> <command>.lock`, the command reduced to letters, digits,
/// `-` and single spaces.
pub fn file_name(pid: u32, command: &str) -> String {
    let words: Vec<String> = command
        .split_whitespace()
        .map(|w| w.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect::<String>())
        .filter(|w| !w.is_empty())
        .take(3)
        .collect();
    format!("{pid} {}.lock", words.join(" "))
}

fn parse_name(name: &str) -> Option<Running> {
    let stem = name.strip_suffix(".lock")?;
    let (pid, command) = stem.split_once(' ').unwrap_or((stem, ""));
    Some(Running { pid: pid.parse().ok()?, command: command.to_string() })
}

/// Marks this process as running `command` (its subcommand words) until the returned value is
/// dropped. An error means the mark could not be made; the command runs anyway.
pub fn hold(dir: &Path, command: &str) -> std::io::Result<Held> {
    std::fs::create_dir_all(dir)?;
    let path = dir.join(file_name(std::process::id(), command));
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path)?;
    match file.try_lock() {
        Ok(()) => Ok(Held { file: Some(file), path }),
        // No locks on this file system: the file alone marks it (its age decides when it is stale).
        Err(TryLockError::Error(e)) if e.kind() == std::io::ErrorKind::Unsupported => Ok(Held { file: None, path }),
        Err(TryLockError::Error(e)) => {
            let _ = std::fs::remove_file(&path);
            Err(e)
        }
        // This process marked itself already (a second mark of the same command).
        Err(TryLockError::WouldBlock) => Ok(Held { file: Some(file), path }),
    }
}

/// The commands running now. Files of commands that ended without removing them are removed.
pub fn running(dir: &Path) -> Vec<Running> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(r) = path.file_name().and_then(|n| n.to_str()).and_then(parse_name) else { continue };
        if r.pid == std::process::id() {
            continue;
        }
        let age = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| SystemTime::now().duration_since(t).ok());
        if age.is_some_and(|a| a < FRESH) {
            found.push(r);
            continue;
        }
        let Ok(file) = OpenOptions::new().read(true).write(true).open(&path) else { continue };
        let stale = match file.try_lock() {
            Ok(()) => {
                let _ = file.unlock();
                true
            }
            Err(TryLockError::WouldBlock) => false,
            Err(TryLockError::Error(_)) => age.is_some_and(|a| a >= STALE_AFTER),
        };
        drop(file);
        if stale {
            let _ = std::fs::remove_file(&path);
        } else {
            found.push(r);
        }
    }
    found.sort_by_key(|r| r.pid);
    found
}

/// After the wait limit with commands still running: whether the update goes on. On Windows the
/// setup would end every running `Arcalo.exe` of the user, so the update waits for the next quit
/// instead; elsewhere the program files are replaced beside the running command, which goes on.
pub fn install_after_limit(os: &str) -> bool {
    os != "windows"
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arcalo-cmdlock-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    fn age(path: &Path, by: Duration) {
        let file = OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - by).unwrap();
    }

    #[test]
    fn names_carry_the_command_words_only() {
        assert_eq!(file_name(42, "pages list"), "42 pages list.lock");
        assert_eq!(file_name(7, "  export-vault  "), "7 export-vault.lock");
        assert_eq!(file_name(7, "pages create ../x/äb"), "7 pages create xb.lock");
        assert_eq!(file_name(7, ""), "7 .lock");
        assert_eq!(parse_name("42 pages list.lock"), Some(Running { pid: 42, command: "pages list".into() }));
        assert_eq!(parse_name("7 .lock"), Some(Running { pid: 7, command: String::new() }));
        assert_eq!(parse_name("notes.txt"), None);
        assert_eq!(parse_name("x pages.lock"), None);
    }

    /// The lock is the operating system's: another handle (another process) cannot take it while
    /// it is held, and the file goes when the command ends.
    #[test]
    fn a_held_lock_is_seen_until_it_is_dropped() {
        let dir = scratch("held");
        let held = hold(&dir, "pages list").unwrap();
        let path = dir.join(file_name(std::process::id(), "pages list"));
        assert!(path.is_file());
        // `running` leaves out this process; a second handle stands in for the app.
        age(&path, Duration::from_secs(60));
        let other = OpenOptions::new().read(true).write(true).open(&path).unwrap();
        assert!(matches!(other.try_lock(), Err(TryLockError::WouldBlock)), "locked while held");
        drop(other);
        // Renamed to another process id: the scan sees it as running (it is locked).
        let as_other = dir.join("4000000000 pages list.lock");
        std::fs::rename(&path, &as_other).unwrap();
        assert_eq!(running(&dir), vec![Running { pid: 4_000_000_000, command: "pages list".into() }]);
        std::fs::rename(&as_other, &path).unwrap();
        drop(held);
        assert!(!path.exists(), "the file goes with the command");
        assert_eq!(running(&dir), vec![]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A command that crashed leaves its file unlocked: it is removed and does not hold up the
    /// update. A file just created (its command not locked yet) counts as running.
    #[test]
    fn a_file_left_behind_is_removed_and_a_fresh_one_counts() {
        let dir = scratch("stale");
        std::fs::create_dir_all(&dir).unwrap();
        let stale = dir.join("4000000001 tasks add.lock");
        std::fs::write(&stale, "").unwrap();
        age(&stale, Duration::from_secs(30));
        let fresh = dir.join("4000000002 info.lock");
        std::fs::write(&fresh, "").unwrap();
        std::fs::write(dir.join("readme.txt"), "not a lock").unwrap();
        assert_eq!(running(&dir), vec![Running { pid: 4_000_000_002, command: "info".into() }]);
        assert!(!stale.exists(), "the left-behind file is removed");
        assert!(dir.join("readme.txt").exists(), "other files stay");
        age(&fresh, Duration::from_secs(30));
        assert_eq!(running(&dir), vec![]);
        assert_eq!(running(&dir.join("missing")), vec![]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn only_windows_waits_for_the_next_quit_after_the_limit() {
        assert!(!install_after_limit("windows"));
        assert!(install_after_limit("macos"));
        assert!(install_after_limit("linux"));
    }
}
