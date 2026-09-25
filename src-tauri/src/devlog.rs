//! Developer log (Settings → Protokoll): errors of commands, background jobs and the UI as
//! one line each in `logs/annalo.log` in the data folder. Rotated at 1 MB (`annalo.log.1`
//! … `.3`). Credentials are redacted before anything is written. Repeated messages are
//! written once per 10 s, UI messages at most 50 per minute.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use annalo_core::gitsync;
use chrono::{DateTime, Local, SecondsFormat};
use serde::Serialize;
use tauri::{AppHandle, State};

use crate::{AppState, Result, lock};

pub const DIR: &str = "logs";
pub const FILE: &str = "annalo.log";
/// Size at which the file is rotated.
const MAX_BYTES: u64 = 1024 * 1024;
/// Rotated files kept (`annalo.log.1` … `.3`).
const KEEP: usize = 3;
/// Longer messages are cut.
const MAX_MESSAGE: usize = 4000;
const DEDUPE: Duration = Duration::from_secs(10);
const UI_PER_MINUTE: u32 = 50;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    Error,
    Warn,
    Info,
    Debug,
}

impl Level {
    fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
        }
    }

    fn parse(s: &str) -> Option<Level> {
        match s.trim().to_ascii_uppercase().as_str() {
            "ERROR" => Some(Level::Error),
            "WARN" | "WARNING" => Some(Level::Warn),
            "INFO" => Some(Level::Info),
            "DEBUG" => Some(Level::Debug),
            _ => None,
        }
    }
}

pub struct DevLog {
    dir: PathBuf,
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Message → when it was last written (for the 10 s dedupe).
    recent: HashMap<String, Instant>,
    /// Start of the current minute window and UI lines written in it.
    ui_window: Option<(Instant, u32)>,
    /// Why the last line could not be written (shown in Settings → Protokoll).
    write_error: Option<String>,
}

static LOG: OnceLock<DevLog> = OnceLock::new();
/// Settings → Protokoll „Ausführliches Protokoll“: debug lines are written too.
static VERBOSE: AtomicBool = AtomicBool::new(false);
static SECRETS: Mutex<Vec<String>> = Mutex::new(Vec::new());

impl DevLog {
    pub fn new(data_dir: &Path) -> Self {
        DevLog { dir: data_dir.join(DIR), inner: Mutex::new(Inner::default()) }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// Writes one line; `false` when it was dropped (dedupe, UI limit, debug while not verbose).
    /// `from_ui`: counts against the UI's rate limit.
    pub fn write(&self, level: Level, source: &str, message: &str, from_ui: bool, now: Instant) -> bool {
        if level == Level::Debug && !VERBOSE.load(Ordering::Relaxed) {
            return false;
        }
        let message = clean(message);
        // From the panic hook: the panicking thread may hold the lock already.
        let mut inner = if std::thread::panicking() {
            match self.inner.try_lock() {
                Ok(g) => g,
                Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return false,
            }
        } else {
            lock(&self.inner)
        };
        if inner.recent.get(&message).is_some_and(|t| now.duration_since(*t) < DEDUPE) {
            return false;
        }
        if from_ui {
            let (start, count) = match inner.ui_window {
                Some((start, count)) if now.duration_since(start) < Duration::from_secs(60) => (start, count),
                _ => (now, 0),
            };
            if count >= UI_PER_MINUTE {
                return false;
            }
            inner.ui_window = Some((start, count + 1));
        }
        if inner.recent.len() > 256 {
            inner.recent.retain(|_, t| now.duration_since(*t) < DEDUPE);
        }
        inner.recent.insert(message.clone(), now);
        let source: String =
            source.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(16).collect();
        let line = format!(
            "{} {} [{}] {}\n",
            Local::now().to_rfc3339_opts(SecondsFormat::Millis, false),
            level.as_str(),
            if source.is_empty() { "core" } else { &source },
            escape(&message)
        );
        // Still under the lock: one writer rotates and appends at a time.
        let res = fs::create_dir_all(&self.dir).and_then(|_| {
            rotate(&self.dir, MAX_BYTES)?;
            OpenOptions::new().create(true).append(true).open(self.file())?.write_all(line.as_bytes())
        });
        match res {
            Ok(()) => inner.write_error = None,
            Err(e) => {
                eprintln!("developer log not written: {e}");
                inner.write_error = Some(annalo_core::error::io_text(&e));
            }
        }
        true
    }

    /// Why the log could not be written the last time, if it could not.
    pub fn write_error(&self) -> Option<String> {
        lock(&self.inner).write_error.clone()
    }

    /// The newest `limit` entries (newest first), from the current and the rotated files.
    pub fn read(&self, limit: usize) -> Vec<Entry> {
        let _guard = lock(&self.inner);
        let mut out = Vec::new();
        for path in files(&self.dir) {
            let Ok(text) = fs::read_to_string(&path) else { continue };
            for line in text.lines().rev().filter(|l| !l.trim().is_empty()) {
                if out.len() >= limit {
                    return out;
                }
                out.push(parse_line(line));
            }
        }
        out
    }

    pub fn clear(&self) -> std::io::Result<()> {
        let _guard = lock(&self.inner);
        for path in files(&self.dir) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

/// `annalo.log`, `annalo.log.1` … (newest first; only existing ones).
fn files(dir: &Path) -> Vec<PathBuf> {
    std::iter::once(dir.join(FILE))
        .chain((1..=KEEP).map(|i| dir.join(format!("{FILE}.{i}"))))
        .filter(|p| p.is_file())
        .collect()
}

/// Moves `annalo.log` to `.1` (and `.1` to `.2` …) once it has reached `max` bytes.
fn rotate(dir: &Path, max: u64) -> std::io::Result<()> {
    let file = dir.join(FILE);
    if fs::metadata(&file).map(|m| m.len() < max).unwrap_or(true) {
        return Ok(());
    }
    let _ = fs::remove_file(dir.join(format!("{FILE}.{KEEP}")));
    for i in (1..KEEP).rev() {
        let from = dir.join(format!("{FILE}.{i}"));
        if from.is_file() {
            fs::rename(&from, dir.join(format!("{FILE}.{}", i + 1)))?;
        }
    }
    fs::rename(&file, dir.join(format!("{FILE}.1")))
}

/// Stored credentials (API key, Git token, proxy password) are replaced wherever they appear.
pub fn remember_secret(secret: Option<&str>) {
    let Some(s) = secret.map(str::trim).filter(|s| s.len() >= 6) else { return };
    let mut known = lock(&SECRETS);
    if !known.iter().any(|k| k == s) {
        known.push(s.to_owned());
    }
}

/// Redacted, trimmed and cut to [`MAX_MESSAGE`] characters.
fn clean(message: &str) -> String {
    let mut text = message.trim().to_owned();
    for s in lock(&SECRETS).iter() {
        text = text.replace(s.as_str(), "***");
    }
    let text = redact(&text);
    match text.char_indices().nth(MAX_MESSAGE) {
        Some((i, _)) => format!("{}…", &text[..i]),
        None => text,
    }
}

/// One entry per line: backslashes and line breaks are escaped.
fn escape(s: &str) -> String {
    s.replace('\\', "\\\\").replace('\r', "").replace('\n', "\\n")
}

fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some(other) => out.push(other),
            None => out.push('\\'),
        }
    }
    out
}

/// Removes credentials: lines with `Authorization`/`extraHeader` and `user:pass@` in URLs
/// (as for git's output), bearer tokens, API keys (`sk-…`, `ghp_…`, `github_pat_…`, …) and
/// values of `token=`, `password=`, `secret=` and similar.
pub fn redact(text: &str) -> String {
    let text = gitsync::redact(text, None);
    let text = redact_after(&text, &["bearer "], |_| true);
    let text = redact_prefixed(&text);
    redact_assignments(&text)
}

fn token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '+' | '/' | '=')
}

/// Replaces the token following each (case-insensitive) `marker` with `***`.
fn redact_after(text: &str, markers: &[&str], boundary: impl Fn(&str) -> bool) -> String {
    let lower = text.to_ascii_lowercase();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    while pos < text.len() {
        let hit = markers.iter().filter_map(|m| lower[pos..].find(m).map(|i| (pos + i, m.len()))).min();
        let Some((at, len)) = hit else { break };
        let start = at + len;
        let end = text[start..].find(|c: char| !token_char(c)).map_or(text.len(), |i| start + i);
        out.push_str(&text[pos..start]);
        if end > start && boundary(&text[..at]) {
            out.push_str("***");
        } else {
            out.push_str(&text[start..end]);
        }
        pos = end.max(start);
    }
    out.push_str(&text[pos.min(text.len())..]);
    out
}

/// Known key formats: OpenAI-style `sk-…`, GitHub `ghp_…`/`github_pat_…`, GitLab `glpat-…`, Slack `xox?-…`.
fn redact_prefixed(text: &str) -> String {
    const PREFIXES: [&str; 10] =
        ["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxb-", "xoxp-"];
    // Only at the start of a word („task-list“ is no key).
    redact_after(text, &PREFIXES, |before| !before.ends_with(|c: char| c.is_ascii_alphanumeric()))
}

/// `token=abc`, `password: abc`, `"api_key":"abc"` → the value becomes `***`.
fn redact_assignments(text: &str) -> String {
    const KEYS: [&str; 7] = ["token", "password", "passwd", "secret", "api_key", "apikey", "api-key"];
    let lower = text.to_ascii_lowercase();
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0;
    let mut i = 0;
    while i < text.len() {
        let Some(key) = KEYS.iter().find(|k| lower[i..].starts_with(*k)) else {
            i += text[i..].chars().next().map_or(1, char::len_utf8);
            continue;
        };
        let word_start = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let mut j = i + key.len();
        // Optional closing quote of a JSON key, spaces, then `=` or `:`.
        if bytes.get(j) == Some(&b'"') || bytes.get(j) == Some(&b'\'') {
            j += 1;
        }
        while bytes.get(j) == Some(&b' ') {
            j += 1;
        }
        if !word_start || !matches!(bytes.get(j), Some(b'=') | Some(b':')) {
            i += key.len();
            continue;
        }
        j += 1;
        while bytes.get(j) == Some(&b' ') {
            j += 1;
        }
        if bytes.get(j) == Some(&b'"') || bytes.get(j) == Some(&b'\'') {
            j += 1;
        }
        let end = text[j..].find(|c: char| c.is_whitespace() || matches!(c, '&' | '"' | '\'' | ',' | ';' | '}' | ')'));
        let end = end.map_or(text.len(), |e| j + e);
        out.push_str(&text[pos..j]);
        if end > j {
            out.push_str("***");
        }
        pos = end;
        i = end.max(j);
    }
    out.push_str(&text[pos..]);
    out
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Entry {
    /// RFC 3339 with the local offset; empty for lines not written by this module.
    pub time: String,
    pub level: String,
    pub source: String,
    pub message: String,
}

/// `2026-09-24T14:05:03.123+02:00 ERROR [git] message`; other lines become INFO entries.
fn parse_line(line: &str) -> Entry {
    let parsed = (|| {
        let (time, rest) = line.split_once(' ')?;
        DateTime::parse_from_rfc3339(time).ok()?;
        let (level, rest) = rest.split_once(' ')?;
        let level = Level::parse(level)?;
        let rest = rest.strip_prefix('[')?;
        let (source, message) = rest.split_once("] ").or_else(|| rest.strip_suffix(']').map(|s| (s, "")))?;
        Some(Entry {
            time: time.to_owned(),
            level: level.as_str().to_owned(),
            source: source.to_owned(),
            message: unescape(message),
        })
    })();
    parsed.unwrap_or_else(|| Entry {
        time: String::new(),
        level: "INFO".into(),
        source: String::new(),
        message: line.to_owned(),
    })
}

// ------------------------------------------------------------------ global log

/// Opens the log in `data_dir` and installs the hooks (command errors, panics).
pub fn init(data_dir: &Path, verbose: bool) {
    let _ = LOG.set(DevLog::new(data_dir));
    set_verbose(verbose);
    annalo_core::error::set_ui_hook(log_ui_error);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        write(Level::Error, "panic", &format!("{what}{at}"), false);
        previous(info);
    }));
}

pub fn set_verbose(on: bool) {
    VERBOSE.store(on, Ordering::Relaxed);
}

fn write(level: Level, source: &str, message: &str, echo: bool) {
    let Some(log) = LOG.get() else { return };
    if log.write(level, source, message, false, Instant::now()) && echo && level != Level::Debug {
        eprintln!("[{source}] {message}");
    }
}

pub fn error(source: &str, message: impl AsRef<str>) {
    write(Level::Error, source, message.as_ref(), true);
}

pub fn warn(source: &str, message: impl AsRef<str>) {
    write(Level::Warn, source, message.as_ref(), true);
}

pub fn info(source: &str, message: impl AsRef<str>) {
    write(Level::Info, source, message.as_ref(), true);
}

pub fn debug(source: &str, message: impl AsRef<str>) {
    write(Level::Debug, source, message.as_ref(), false);
}

/// Every error returned to the UI. A failure logged just before with its own source
/// (git, update, …) is not written a second time (same message).
fn log_ui_error(e: &annalo_core::Error) {
    use annalo_core::Error as E;
    let (level, source) = match e {
        E::NotFound { .. } | E::Parse(_) => (Level::Warn, "core"),
        E::Provider { .. } => (Level::Error, "ai"),
        E::Http(_) => (Level::Error, "net"),
        _ => (Level::Error, "core"),
    };
    // The full text (a file error's path and the system's own words), the UI may shorten it.
    write(level, source, &e.detail(), false);
}

// ------------------------------------------------------------------ commands

fn log_dir(state: &AppState) -> PathBuf {
    state.data_dir.join(DIR)
}

/// A line from the UI (window errors, rejected promises, `console.error`, error toasts);
/// these count against the UI's limit of 50 lines per minute.
#[tauri::command]
pub fn devlog_write(level: String, source: Option<String>, message: String) {
    let level = Level::parse(&level).unwrap_or(Level::Info);
    let source = source.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "ui".into());
    if let Some(log) = LOG.get() {
        log.write(level, &source, &message, true, Instant::now());
    }
}

#[tauri::command]
pub fn devlog_read(limit: Option<usize>) -> Vec<Entry> {
    LOG.get().map(|l| l.read(limit.unwrap_or(500).clamp(1, 5000))).unwrap_or_default()
}

#[derive(Serialize)]
pub struct Stats {
    /// ERROR lines of the last 7 days.
    errors_week: usize,
    dir: String,
    /// The log file cannot be written (full or read-only disk, permissions).
    write_error: Option<String>,
}

#[tauri::command]
pub fn devlog_stats(state: State<AppState>) -> Stats {
    let since = Local::now() - chrono::TimeDelta::days(7);
    let errors_week = devlog_read(Some(5000))
        .iter()
        .filter(|e| e.level == "ERROR")
        .filter(|e| DateTime::parse_from_rfc3339(&e.time).is_ok_and(|t| t >= since))
        .count();
    Stats {
        errors_week,
        dir: log_dir(&state).display().to_string(),
        write_error: LOG.get().and_then(DevLog::write_error),
    }
}

#[tauri::command]
pub fn devlog_clear() -> Result<()> {
    if let Some(log) = LOG.get() {
        log.clear()?;
    }
    Ok(())
}

/// Opens the log folder in the file manager.
#[tauri::command]
pub fn devlog_open_folder(app: AppHandle, state: State<AppState>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let dir = log_dir(&state);
    fs::create_dir_all(&dir)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| annalo_core::Error::State(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("annalo-devlog-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_parses_and_reads_newest_first() {
        let dir = temp("read");
        let log = DevLog::new(&dir);
        let now = Instant::now();
        assert!(log.write(Level::Error, "git", "push failed\nzweite Zeile \\n", false, now));
        assert!(log.write(Level::Warn, "ai", "slow", false, now));
        let entries = log.read(10);
        assert_eq!(entries.len(), 2);
        assert_eq!(
            (entries[0].level.as_str(), entries[0].source.as_str(), entries[0].message.as_str()),
            ("WARN", "ai", "slow")
        );
        assert_eq!(entries[1].message, "push failed\nzweite Zeile \\n");
        assert!(DateTime::parse_from_rfc3339(&entries[1].time).is_ok());
        assert_eq!(log.read(1).len(), 1);
        log.clear().unwrap();
        assert!(log.read(10).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn foreign_lines_are_kept_as_info() {
        let e = parse_line("thread 'main' panicked");
        assert_eq!((e.level.as_str(), e.time.as_str(), e.message.as_str()), ("INFO", "", "thread 'main' panicked"));
        let e = parse_line("2026-09-24T14:05:03.123+02:00 ERROR [ui] ] x");
        assert_eq!((e.source.as_str(), e.message.as_str()), ("ui", "] x"));
        assert_eq!(parse_line("2026-09-24T14:05:03.123+02:00 BOGUS [ui] x").level, "INFO");
    }

    #[test]
    fn repeats_and_ui_floods_are_dropped() {
        let dir = temp("limit");
        let log = DevLog::new(&dir);
        let t0 = Instant::now();
        assert!(log.write(Level::Error, "core", "same", false, t0));
        assert!(!log.write(Level::Error, "git", "same", false, t0 + Duration::from_secs(5)));
        assert!(log.write(Level::Error, "core", "same", false, t0 + Duration::from_secs(11)));
        let written = (0..80).filter(|i| log.write(Level::Error, "ui", &format!("ui {i}"), true, t0)).count();
        assert_eq!(written, 50);
        assert!(log.write(Level::Error, "ui", "next minute", true, t0 + Duration::from_secs(61)));
        // Other sources are not limited by the UI's budget.
        assert!(log.write(Level::Error, "core", "backend", false, t0));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rotates_and_keeps_three_old_files() {
        let dir = temp("rotate");
        fs::create_dir_all(&dir).unwrap();
        for round in 0..5 {
            fs::write(dir.join(FILE), format!("round {round}\n").repeat(10)).unwrap();
            rotate(&dir, 20).unwrap();
            assert!(!dir.join(FILE).exists());
        }
        assert!(!dir.join(format!("{FILE}.4")).exists());
        let first =
            |i: usize| fs::read_to_string(dir.join(format!("{FILE}.{i}"))).unwrap().lines().next().unwrap().to_owned();
        assert_eq!([first(1), first(2), first(3)], ["round 4", "round 3", "round 2"]);
        // Below the limit nothing moves.
        fs::write(dir.join(FILE), "x\n").unwrap();
        rotate(&dir, 20).unwrap();
        assert!(dir.join(FILE).exists());
        assert_eq!(files(&dir).len(), 4);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_file_rotates_on_write() {
        let dir = temp("rotate-write");
        let log = DevLog::new(&dir);
        fs::create_dir_all(dir.join(DIR)).unwrap();
        fs::write(dir.join(DIR).join(FILE), vec![b'a'; MAX_BYTES as usize]).unwrap();
        assert!(log.write(Level::Info, "core", "after rotation", false, Instant::now()));
        assert_eq!(fs::metadata(dir.join(DIR).join(format!("{FILE}.1"))).unwrap().len(), MAX_BYTES);
        assert_eq!(log.read(5)[0].message, "after rotation");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn secrets_are_redacted() {
        let cases = [
            ("401 from https://user:hunter2@example.com/x.git", "401 from https://***@example.com/x.git"),
            ("Authorization: Bearer abc.def", "[Zeile mit Zugangsdaten entfernt]"),
            ("header Bearer eyJhbGciOi.x-y", "header Bearer ***"),
            ("key sk-proj-AbC123_xyz rejected", "key sk-*** rejected"),
            ("ghp_abcdef123456 and github_pat_11ABC_def", "ghp_*** and github_pat_***"),
            ("glpat-abcdEFG1234", "glpat-***"),
            ("GET /x?token=abc123&page=2", "GET /x?token=***&page=2"),
            ("password = geheim; user=bob", "password = ***; user=bob"),
            (r#"{"api_key":"k-1","model":"m"}"#, r#"{"api_key":"***","model":"m"}"#),
            ("access_token: xyz", "access_token: ***"),
        ];
        for (input, expected) in cases {
            assert_eq!(redact(input), expected, "{input}");
        }
        // Words that only look similar stay.
        for text in ["task-list risk-free", "Tokens: 1200 verbraucht", "API-Token fehlt", "Passwort falsch"] {
            assert_eq!(redact(text), text);
        }
        // Stored credentials without a known format.
        remember_secret(Some("  plain-litellm-key-42 "));
        remember_secret(Some("x"));
        assert_eq!(clean("proxy said plain-litellm-key-42 is invalid (x)"), "proxy said *** is invalid (x)");
    }

    #[test]
    fn messages_are_cut_and_debug_needs_verbose() {
        let long = "ä".repeat(MAX_MESSAGE + 10);
        assert_eq!(clean(&long).chars().count(), MAX_MESSAGE + 1);
        let dir = temp("debug");
        let log = DevLog::new(&dir);
        set_verbose(false);
        assert!(!log.write(Level::Debug, "ai", "request", false, Instant::now()));
        set_verbose(true);
        assert!(log.write(Level::Debug, "ai", "request", false, Instant::now()));
        set_verbose(false);
        assert_eq!(log.read(5)[0].level, "DEBUG");
        let _ = fs::remove_dir_all(&dir);
    }
}
