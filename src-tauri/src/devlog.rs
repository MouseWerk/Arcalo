//! Developer log (Settings → Protokoll), built on `tracing`: errors of commands, background
//! jobs and the UI, plus spans with timings around Git sync, AI requests, calendar and Jira
//! syncs, backups, database migrations and updates. One line per event in `logs/arcalo.log`
//! in the data folder (the viewer reads it), rotated at 1 MB (`arcalo.log.1` … `.3`).
//! Optionally the same events as JSON lines in `arcalo.jsonl` (same rotation), written by a
//! background thread (`tracing-appender`); the text file is written right away, so the viewer
//! and a panic never miss a line.
//!
//! Levels error … trace, set in Settings → Protokoll or by `ARCALO_LOG` (a level such as
//! `debug`, or directives such as `arcalo=trace,zbus=debug`; it wins over the setting;
//! `ANNALO_LOG` and the target names `annalo*` of 1.14 and earlier still work). Other crates log warnings and
//! errors only unless `ARCALO_LOG` names them.
//!
//! Every message and every field value is redacted before anything is written (known key
//! formats, `token=`/`password=` values, URLs with credentials, stored secrets); a field whose
//! name says it holds a secret is never written at all. Repeated messages are written once per
//! 10 s, UI messages at most 50 per minute.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use arcalo_core::gitsync;
use chrono::{DateTime, Local, SecondsFormat};
use serde::Serialize;
use tauri::{AppHandle, State};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Subscriber};
use tracing_subscriber::filter::{LevelFilter, Targets};
use tracing_subscriber::layer::Context;
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::{Layer, Registry, reload};

use crate::{AppState, Result, lock};

pub const DIR: &str = "logs";
pub const FILE: &str = "arcalo.log";
/// The optional JSON-lines file next to it.
pub const JSON_FILE: &str = "arcalo.jsonl";
/// Size at which a file is rotated.
const MAX_BYTES: u64 = 1024 * 1024;
/// Rotated files kept (`arcalo.log.1` … `.3`).
const KEEP: usize = 3;
/// Longer messages are cut.
const MAX_MESSAGE: usize = 4000;
const DEDUPE: Duration = Duration::from_secs(10);
const UI_PER_MINUTE: u32 = 50;
/// Overrides the level of Settings → Protokoll.
pub const ENV: &str = "ARCALO_LOG";
/// Targets of Arcalo's own code; everything else logs warnings and errors only.
const OWN: [&str; 3] = ["arcalo", "arcalo_lib", "arcalo_core"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Error = 1,
    Warn,
    Info,
    Debug,
    Trace,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Error => "ERROR",
            Level::Warn => "WARN",
            Level::Info => "INFO",
            Level::Debug => "DEBUG",
            Level::Trace => "TRACE",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        match s.trim().to_ascii_uppercase().as_str() {
            "ERROR" => Some(Level::Error),
            "WARN" | "WARNING" => Some(Level::Warn),
            "INFO" => Some(Level::Info),
            "DEBUG" => Some(Level::Debug),
            "TRACE" => Some(Level::Trace),
            _ => None,
        }
    }

    fn of(l: &tracing::Level) -> Level {
        match *l {
            tracing::Level::ERROR => Level::Error,
            tracing::Level::WARN => Level::Warn,
            tracing::Level::INFO => Level::Info,
            tracing::Level::DEBUG => Level::Debug,
            tracing::Level::TRACE => Level::Trace,
        }
    }

    fn filter(self) -> LevelFilter {
        match self {
            Level::Error => LevelFilter::ERROR,
            Level::Warn => LevelFilter::WARN,
            Level::Info => LevelFilter::INFO,
            Level::Debug => LevelFilter::DEBUG,
            Level::Trace => LevelFilter::TRACE,
        }
    }

    fn from_u8(v: u8) -> Level {
        match v {
            1 => Level::Error,
            2 => Level::Warn,
            4 => Level::Debug,
            5 => Level::Trace,
            _ => Level::Info,
        }
    }
}

/// The level of the settings: `dev_log_level`, else „Ausführliches Protokoll“ of earlier
/// versions (debug) or info.
pub fn level_of(settings: &arcalo_core::settings::Settings) -> Level {
    Level::parse(&settings.dev_log_level).unwrap_or(if settings.dev_log_verbose { Level::Debug } else { Level::Info })
}

/// The filter of `ARCALO_LOG`: a bare level applies to Arcalo's own code, directives
/// (`arcalo=trace,zbus=debug`) are taken as they are. `None`: not set or not understood.
pub fn env_filter(spec: &str) -> Option<(Targets, Level)> {
    let spec = alias_targets(spec.trim());
    let spec = spec.as_str();
    if spec.is_empty() {
        return None;
    }
    if let Some(level) = Level::parse(spec) {
        return Some((own_targets(level), level));
    }
    let targets: Targets = spec.parse().ok()?;
    let level = OWN
        .iter()
        .filter_map(|t| {
            let max = targets.iter().filter(|(target, _)| t.starts_with(target)).map(|(_, l)| l).max();
            max.or(targets.default_level())
        })
        .max()
        .and_then(|f| f.into_level())
        .map_or(Level::Info, |l| Level::of(&l));
    Some((targets, level))
}

/// The target names of 1.14 and earlier (`annalo`, `annalo_lib`, `annalo_core`) in directives
/// stand for the current ones: `annalo_core=debug` means `arcalo_core=debug`.
fn alias_targets(spec: &str) -> String {
    let legacy = arcalo_core::identity::legacy("arcalo");
    spec.split(',')
        .map(|d| {
            let d = d.trim();
            match d.strip_prefix(legacy.as_str()) {
                Some(rest) if rest.is_empty() || rest.starts_with(['_', ':', '=', '[']) => format!("arcalo{rest}"),
                _ => d.to_owned(),
            }
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn own_targets(level: Level) -> Targets {
    OWN.iter().fold(Targets::new().with_default(LevelFilter::WARN), |t, own| t.with_target(*own, level.filter()))
}

pub struct DevLog {
    dir: PathBuf,
    inner: Mutex<Inner>,
    /// The JSON-lines writer while that output is on.
    json: Mutex<Option<tracing_appender::non_blocking::NonBlocking>>,
    /// Flushes the JSON writer when dropped (at exit, or when the output is switched off).
    json_guard: Mutex<Option<tracing_appender::non_blocking::WorkerGuard>>,
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

static LOG: OnceLock<Arc<DevLog>> = OnceLock::new();
/// The level of Arcalo's own lines (the setting, or `ARCALO_LOG`).
static LEVEL: AtomicU8 = AtomicU8::new(Level::Info as u8);
static RELOAD: OnceLock<reload::Handle<Targets, Registry>> = OnceLock::new();
/// `ARCALO_LOG` as given at the start (it wins over the setting).
static ENV_SPEC: OnceLock<Option<String>> = OnceLock::new();
static SECRETS: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// The level lines are written at now.
pub fn level() -> Level {
    Level::from_u8(LEVEL.load(Ordering::Relaxed))
}

/// One line: the redacted message plus redacted fields (`key=value`).
struct Line<'a> {
    level: Level,
    source: &'a str,
    message: String,
    fields: Vec<(String, String)>,
    target: &'a str,
    spans: Vec<&'static str>,
}

impl DevLog {
    pub fn new(data_dir: &Path) -> Self {
        DevLog {
            dir: data_dir.join(DIR),
            inner: Mutex::new(Inner::default()),
            json: Mutex::new(None),
            json_guard: Mutex::new(None),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join(FILE)
    }

    /// Writes one line; `false` when it was dropped (dedupe, UI limit, below the level).
    /// `from_ui`: counts against the UI's rate limit.
    pub fn write(&self, level: Level, source: &str, message: &str, from_ui: bool, now: Instant) -> bool {
        let line = Line { level, source, message: message.to_owned(), fields: vec![], target: "arcalo", spans: vec![] };
        self.write_line(line, from_ui, now)
    }

    fn write_line(&self, line: Line, from_ui: bool, now: Instant) -> bool {
        if line.level > level() {
            return false;
        }
        let mut message = clean(&line.message);
        for (k, v) in &line.fields {
            let _ = write!(message, " {k}={v}");
        }
        // A field may complete a pattern (`token=` + value): the whole line once more.
        let message = redact(&message);
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
        let key = message.clone();
        if inner.recent.get(&key).is_some_and(|t| now.duration_since(*t) < DEDUPE) {
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
        inner.recent.insert(key, now);
        let source: String =
            line.source.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(16).collect();
        let source = if source.is_empty() { "core".to_owned() } else { source };
        let time = Local::now().to_rfc3339_opts(SecondsFormat::Millis, false);
        let text = format!("{time} {} [{source}] {}\n", line.level.as_str(), escape(&message));
        // Still under the lock: one writer rotates and appends at a time.
        let res = fs::create_dir_all(&self.dir).and_then(|_| {
            rotate(&self.dir, FILE, MAX_BYTES)?;
            OpenOptions::new().create(true).append(true).open(self.file())?.write_all(text.as_bytes())
        });
        match res {
            Ok(()) => inner.write_error = None,
            Err(e) => {
                eprintln!("developer log not written: {e}");
                inner.write_error = Some(arcalo_core::error::io_text(&e));
            }
        }
        drop(inner);
        if let Some(json) = lock(&self.json).as_mut() {
            let fields: serde_json::Map<String, serde_json::Value> =
                line.fields.iter().map(|(k, v)| (k.clone(), v.clone().into())).collect();
            let value = serde_json::json!({
                "time": time,
                "level": line.level.as_str(),
                "source": source,
                "target": line.target,
                "message": clean(&line.message),
                "fields": fields,
                "spans": line.spans,
            });
            let _ = json.write_all(format!("{value}\n").as_bytes());
        }
        true
    }

    /// Switches the JSON-lines output on or off (off flushes what is pending).
    pub fn set_json(&self, on: bool) {
        let mut json = lock(&self.json);
        if on == json.is_some() {
            return;
        }
        if on {
            let writer = Rotating { dir: self.dir.clone(), name: JSON_FILE, max: MAX_BYTES };
            let (nb, guard) = tracing_appender::non_blocking::NonBlockingBuilder::default()
                .lossy(false)
                .thread_name("arcalo-log-json")
                .finish(writer);
            *json = Some(nb);
            *lock(&self.json_guard) = Some(guard);
        } else {
            *json = None;
            drop(lock(&self.json_guard).take());
        }
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
        for path in files(&self.dir).into_iter().chain(json_files(&self.dir)) {
            fs::remove_file(path)?;
        }
        Ok(())
    }
}

/// A file in `dir` rotated by size (the JSON-lines output behind the background writer).
struct Rotating {
    dir: PathBuf,
    name: &'static str,
    max: u64,
}

impl Write for Rotating {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        fs::create_dir_all(&self.dir)?;
        rotate(&self.dir, self.name, self.max)?;
        OpenOptions::new().create(true).append(true).open(self.dir.join(self.name))?.write_all(buf)?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

// ------------------------------------------------------------------ tracing layer

/// Field values of a span or an event, already redacted.
#[derive(Default)]
struct Fields {
    message: Option<String>,
    source: Option<String>,
    ui: bool,
    list: Vec<(String, String)>,
}

/// Names that hold a secret: the value is never written.
fn secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["token", "password", "passwd", "secret", "api_key", "apikey", "authorization", "credential"]
        .iter()
        .any(|s| n.contains(s))
}

impl Fields {
    fn put(&mut self, field: &Field, value: String) {
        match field.name() {
            "message" => self.message = Some(value),
            "source" => self.source = Some(value),
            "ui" => self.ui = value == "true",
            name => {
                let value = if secret_name(name) { "***".to_owned() } else { clean(&value) };
                match self.list.iter_mut().find(|(k, _)| k == name) {
                    Some(slot) => slot.1 = value,
                    None => self.list.push((name.to_owned(), value)),
                }
            }
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, value.to_owned());
    }

    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        self.put(field, format!("{value:?}"));
    }
}

/// What a span keeps until it closes.
struct SpanData {
    fields: Fields,
    start: Instant,
}

/// Writes events (and the timing of closed spans) into a [`DevLog`].
pub struct DevLogLayer {
    log: Arc<DevLog>,
}

impl DevLogLayer {
    pub fn new(log: Arc<DevLog>) -> Self {
        DevLogLayer { log }
    }
}

impl<S> Layer<S> for DevLogLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        span.extensions_mut().insert(SpanData { fields, start: Instant::now() });
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(id) else { return };
        if let Some(data) = span.extensions_mut().get_mut::<SpanData>() {
            values.record(&mut data.fields);
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        let meta = event.metadata();
        let mut spans = vec![];
        let mut span_source = None;
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope {
                spans.push(span.name());
                if span_source.is_none() {
                    span_source = span.extensions().get::<SpanData>().and_then(|d| d.fields.source.clone());
                }
            }
        }
        spans.reverse();
        let source = fields.source.clone().or(span_source).unwrap_or_else(|| source_of(meta.target()));
        let line = Line {
            level: Level::of(meta.level()),
            source: &source,
            message: fields.message.take().unwrap_or_default(),
            fields: fields.list,
            target: meta.target(),
            spans,
        };
        self.log.write_line(line, fields.ui, Instant::now());
    }

    fn on_close(&self, id: Id, ctx: Context<'_, S>) {
        let Some(span) = ctx.span(&id) else { return };
        let ext = span.extensions();
        let Some(data) = ext.get::<SpanData>() else { return };
        let ms = data.start.elapsed().as_millis();
        let mut fields = vec![("elapsed_ms".to_owned(), ms.to_string())];
        fields.extend(data.fields.list.iter().cloned());
        let source = data.fields.source.clone().unwrap_or_else(|| source_of(span.metadata().target()));
        let parents = span.scope().skip(1).map(|s| s.name()).collect::<Vec<_>>();
        let line = Line {
            level: Level::of(span.metadata().level()),
            source: &source,
            message: format!("{} done", span.name()),
            fields,
            target: span.metadata().target(),
            spans: parents.into_iter().rev().collect(),
        };
        self.log.write_line(line, false, Instant::now());
    }
}

/// `arcalo_core::db` → `db`; other crates by their name.
fn source_of(target: &str) -> String {
    let mut parts = target.split("::");
    let krate = parts.next().unwrap_or_default();
    if OWN.contains(&krate) { parts.next().unwrap_or("core").to_owned() } else { krate.to_owned() }
}

/// `name`, `name.1` … in `dir` (newest first; only existing ones).
fn rotated(dir: &Path, name: &str) -> Vec<PathBuf> {
    std::iter::once(dir.join(name))
        .chain((1..=KEEP).map(|i| dir.join(format!("{name}.{i}"))))
        .filter(|p| p.is_file())
        .collect()
}

/// `arcalo.log`, `arcalo.log.1` … (newest first; only existing ones).
fn files(dir: &Path) -> Vec<PathBuf> {
    rotated(dir, FILE)
}

/// `arcalo.jsonl`, `arcalo.jsonl.1` …
fn json_files(dir: &Path) -> Vec<PathBuf> {
    rotated(dir, JSON_FILE)
}

/// Log files of 1.12 and earlier (`annalo.log`, `annalo.jsonl` and their rotations) take the
/// current names, so the viewer and the diagnostics keep the history. A name already in use
/// stays as it is (nothing is overwritten).
fn adopt_legacy(dir: &Path) {
    for (old, new) in
        [(arcalo_core::identity::legacy(FILE), FILE), (arcalo_core::identity::legacy(JSON_FILE), JSON_FILE)]
    {
        for suffix in std::iter::once(String::new()).chain((1..=KEEP).map(|i| format!(".{i}"))) {
            let (from, to) = (dir.join(format!("{old}{suffix}")), dir.join(format!("{new}{suffix}")));
            if from.is_file() && !to.exists() {
                let _ = fs::rename(&from, &to);
            }
        }
    }
}

/// Moves `name` to `.1` (and `.1` to `.2` …) once it has reached `max` bytes.
fn rotate(dir: &Path, name: &str, max: u64) -> std::io::Result<()> {
    let file = dir.join(name);
    if fs::metadata(&file).map(|m| m.len() < max).unwrap_or(true) {
        return Ok(());
    }
    let _ = fs::remove_file(dir.join(format!("{name}.{KEEP}")));
    for i in (1..KEEP).rev() {
        let from = dir.join(format!("{name}.{i}"));
        if from.is_file() {
            fs::rename(&from, dir.join(format!("{name}.{}", i + 1)))?;
        }
    }
    fs::rename(&file, dir.join(format!("{name}.1")))
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

/// Opens the log in `data_dir`, installs the `tracing` subscriber (level: `ARCALO_LOG`, else
/// info until the settings are read) and the hooks (command errors, panics).
pub fn init(data_dir: &Path) {
    adopt_legacy(&data_dir.join(DIR));
    let log = Arc::new(DevLog::new(data_dir));
    if LOG.set(log.clone()).is_err() {
        return;
    }
    let var = |name: &str| std::env::var(name).ok().filter(|s| !s.trim().is_empty());
    let spec = var(ENV).or_else(|| arcalo_core::identity::legacy_env(ENV).and_then(|l| var(&l)));
    let env = spec.as_deref().and_then(env_filter);
    if let (Some(s), None) = (&spec, &env) {
        eprintln!("{ENV}={s} not understood: use a level (error, warn, info, debug, trace) or directives");
    }
    let _ = ENV_SPEC.set(env.as_ref().and(spec));
    let (targets, level) = env.unwrap_or_else(|| (own_targets(Level::Info), Level::Info));
    LEVEL.store(level as u8, Ordering::Relaxed);
    let (filter, handle) = reload::Layer::new(targets);
    let _ = RELOAD.set(handle);
    let _ = tracing_subscriber::registry().with(filter).with(DevLogLayer::new(log)).try_init();
    arcalo_core::error::set_ui_hook(log_ui_error);
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".into());
        let at = info.location().map(|l| format!(" at {}:{}", l.file(), l.line())).unwrap_or_default();
        // Written right here: the process may end before any other thread runs.
        if let Some(log) = LOG.get() {
            log.write(Level::Error, "panic", &format!("{what}{at}"), false, Instant::now());
        }
        previous(info);
    }));
}

/// `ARCALO_LOG` as given at the start, when it overrides the setting.
pub fn env_override() -> Option<&'static str> {
    ENV_SPEC.get().and_then(|s| s.as_deref())
}

/// The level and the JSON output of the settings (the level unless `ARCALO_LOG` is set).
pub fn apply_settings(settings: &arcalo_core::settings::Settings) {
    if let Some(log) = LOG.get() {
        log.set_json(settings.dev_log_json);
    }
    if env_override().is_none() {
        set_level(level_of(settings));
    }
}

pub fn set_level(level: Level) {
    LEVEL.store(level as u8, Ordering::Relaxed);
    if let Some(handle) = RELOAD.get() {
        let _ = handle.reload(own_targets(level));
    }
}

/// The process ends: the JSON lines still queued are written.
pub fn shutdown() {
    if let Some(log) = LOG.get() {
        log.set_json(false);
    }
}

/// One event of Arcalo's own code (`source`: the area, shown in brackets).
fn emit(level: Level, source: &str, message: &str, echo: bool) {
    match level {
        Level::Error => tracing::error!(target: "arcalo", source, "{message}"),
        Level::Warn => tracing::warn!(target: "arcalo", source, "{message}"),
        Level::Info => tracing::info!(target: "arcalo", source, "{message}"),
        Level::Debug => tracing::debug!(target: "arcalo", source, "{message}"),
        Level::Trace => tracing::trace!(target: "arcalo", source, "{message}"),
    }
    if echo && level <= Level::Info && level <= self::level() {
        eprintln!("[{source}] {message}");
    }
}

pub fn error(source: &str, message: impl AsRef<str>) {
    emit(Level::Error, source, message.as_ref(), true);
}

pub fn warn(source: &str, message: impl AsRef<str>) {
    emit(Level::Warn, source, message.as_ref(), true);
}

pub fn info(source: &str, message: impl AsRef<str>) {
    emit(Level::Info, source, message.as_ref(), true);
}

pub fn debug(source: &str, message: impl AsRef<str>) {
    emit(Level::Debug, source, message.as_ref(), false);
}

/// Every error returned to the UI. A failure logged just before with its own source
/// (git, update, …) is not written a second time (same message).
fn log_ui_error(e: &arcalo_core::Error) {
    use arcalo_core::Error as E;
    let (level, source) = match e {
        E::NotFound { .. } | E::Parse(_) => (Level::Warn, "core"),
        E::Provider { .. } => (Level::Error, "ai"),
        E::Http(_) => (Level::Error, "net"),
        _ => (Level::Error, "core"),
    };
    // The full text (a file error's path and the system's own words), the UI may shorten it.
    emit(level, source, &e.detail(), false);
}

/// The redacted log lines (the current and the rotated files, oldest first) for the
/// diagnostics bundle.
pub fn bundle_files() -> Vec<(String, Vec<u8>)> {
    let Some(log) = LOG.get() else { return vec![] };
    let _guard = lock(&log.inner);
    files(&log.dir)
        .into_iter()
        .chain(json_files(&log.dir))
        .rev()
        .filter_map(|p| {
            let text = fs::read_to_string(&p).ok()?;
            // Written redacted already; once more with the secrets known now.
            let text: String = text.lines().map(|l| clean_line(l) + "\n").collect();
            Some((p.file_name()?.to_string_lossy().into_owned(), text.into_bytes()))
        })
        .collect()
}

/// [`clean`] without the length cut (a whole line of the file).
pub fn clean_line(line: &str) -> String {
    let mut text = line.to_owned();
    for s in lock(&SECRETS).iter() {
        text = text.replace(s.as_str(), "***");
    }
    redact(&text)
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
    /// The level lines are written at now (`ERROR` … `TRACE`).
    level: &'static str,
    /// `ARCALO_LOG`, when it overrides the setting.
    level_env: Option<&'static str>,
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
        write_error: LOG.get().and_then(|l| l.write_error()),
        level: level().as_str(),
        level_env: env_override(),
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
        .map_err(|e| arcalo_core::Error::State(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arcalo-devlog-{name}-{}", std::process::id()));
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
    fn log_files_of_annalo_take_the_new_names() {
        let dir = temp("legacy");
        let logs = dir.join(DIR);
        fs::create_dir_all(&logs).unwrap();
        for (name, text) in
            [("annalo.log", "neu"), ("annalo.log.2", "alt"), ("annalo.jsonl", "{}"), ("annalo.jsonl.1", "{\"a\":1}")]
        {
            fs::write(logs.join(name), text).unwrap();
        }
        // A file that already has the new name is not overwritten.
        fs::write(logs.join("arcalo.jsonl.1"), "behalten").unwrap();
        adopt_legacy(&logs);
        assert_eq!(fs::read_to_string(logs.join(FILE)).unwrap(), "neu");
        assert_eq!(fs::read_to_string(logs.join(format!("{FILE}.2"))).unwrap(), "alt");
        assert_eq!(fs::read_to_string(logs.join(JSON_FILE)).unwrap(), "{}");
        assert_eq!(fs::read_to_string(logs.join(format!("{JSON_FILE}.1"))).unwrap(), "behalten");
        assert!(!logs.join("annalo.log").exists() && !logs.join("annalo.log.2").exists());
        assert!(logs.join("annalo.jsonl.1").exists(), "kept rather than overwriting");
        // The viewer reads the history.
        assert_eq!(DevLog::new(&dir).read(10).len(), 2);
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
            rotate(&dir, FILE, 20).unwrap();
            assert!(!dir.join(FILE).exists());
        }
        assert!(!dir.join(format!("{FILE}.4")).exists());
        let first =
            |i: usize| fs::read_to_string(dir.join(format!("{FILE}.{i}"))).unwrap().lines().next().unwrap().to_owned();
        assert_eq!([first(1), first(2), first(3)], ["round 4", "round 3", "round 2"]);
        // Below the limit nothing moves.
        fs::write(dir.join(FILE), "x\n").unwrap();
        rotate(&dir, FILE, 20).unwrap();
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
    fn messages_are_cut_and_levels_filter() {
        let long = "ä".repeat(MAX_MESSAGE + 10);
        assert_eq!(clean(&long).chars().count(), MAX_MESSAGE + 1);
        let dir = temp("debug");
        let log = DevLog::new(&dir);
        // Other tests write info lines meanwhile: the level never goes below info here.
        set_level(Level::Info);
        assert!(!log.write(Level::Debug, "ai", "request", false, Instant::now()));
        set_level(Level::Debug);
        assert!(log.write(Level::Debug, "ai", "request", false, Instant::now()));
        assert!(!log.write(Level::Trace, "ai", "chunk", false, Instant::now()));
        set_level(Level::Trace);
        assert!(log.write(Level::Trace, "ai", "chunk", false, Instant::now()));
        set_level(Level::Info);
        assert_eq!(log.read(5)[0].level, "TRACE");
        assert_eq!(log.read(5)[1].level, "DEBUG");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn arcalo_log_takes_a_level_or_directives() {
        let (t, l) = env_filter("debug").unwrap();
        assert_eq!(l, Level::Debug);
        assert!(t.would_enable("arcalo_core::db", &tracing::Level::DEBUG));
        assert!(t.would_enable("arcalo_lib::devlog", &tracing::Level::DEBUG));
        assert!(!t.would_enable("arcalo_lib::devlog", &tracing::Level::TRACE));
        // Other crates stay at warnings unless named.
        assert!(!t.would_enable("zbus::connection", &tracing::Level::INFO));
        assert!(t.would_enable("hyper", &tracing::Level::WARN));
        let (t, l) = env_filter("arcalo_core=trace,zbus=debug").unwrap();
        assert_eq!(l, Level::Trace);
        assert!(t.would_enable("zbus::x", &tracing::Level::DEBUG));
        assert_eq!(env_filter(" TRACE ").unwrap().1, Level::Trace);
        // The target names of 1.14 and earlier stand for the current ones.
        let (t, l) = env_filter("annalo_core=trace, annalo_lib::devlog=debug,zbus=info").unwrap();
        assert_eq!(l, Level::Trace);
        assert!(t.would_enable("arcalo_core::db", &tracing::Level::TRACE));
        assert!(t.would_enable("arcalo_lib::devlog", &tracing::Level::DEBUG));
        assert!(!t.would_enable("arcalo_lib::updates", &tracing::Level::DEBUG));
        assert_eq!(alias_targets("annalo=debug,annalotte=info"), "arcalo=debug,annalotte=info");
        assert!(env_filter("").is_none());
        assert_eq!(Level::parse("warning"), Some(Level::Warn));
        assert!(Level::Error < Level::Trace);
    }

    /// Runs `f` with a subscriber that writes into a fresh log in `dir`.
    fn traced(dir: &Path, f: impl FnOnce()) -> Arc<DevLog> {
        let log = Arc::new(DevLog::new(dir));
        let subscriber = tracing_subscriber::registry().with(DevLogLayer::new(log.clone()));
        tracing::subscriber::with_default(subscriber, f);
        log
    }

    #[test]
    fn the_layer_redacts_every_message_and_field() {
        let dir = temp("layer-redact");
        remember_secret(Some("stored-proxy-pw-77"));
        let log = traced(&dir, || {
            let span =
                tracing::info_span!("git_sync", source = "git", url = "https://bob:hunter2@git.example.com/r.git");
            let _e = span.enter();
            tracing::warn!(token = "abc123secret", api_key = "k-9", "push to https://u:pw-in-url@h/x failed");
            tracing::error!(header = "Bearer eyJhbGciOiJIUzI1NiJ9.x", detail = "password=geheim42 user=bob", "auth");
            tracing::info!(note = "via proxy with stored-proxy-pw-77", "sk-proj-AbC123xyz rejected");
            tracing::info!(body = r#"{"access_token":"tok-55555","ok":true}"#, "response");
        });
        log.set_json(true);
        log.write(Level::Warn, "ui", "json token=json-secret-1", false, Instant::now());
        log.set_json(false);
        let text = fs::read_to_string(dir.join(DIR).join(FILE)).unwrap();
        let json = fs::read_to_string(dir.join(DIR).join(JSON_FILE)).unwrap();
        for secret in [
            "abc123secret",
            "k-9",
            "hunter2",
            "pw-in-url",
            "eyJhbGciOiJIUzI1NiJ9",
            "geheim42",
            "stored-proxy-pw-77",
            "AbC123xyz",
            "tok-55555",
            "json-secret-1",
        ] {
            assert!(!text.contains(secret), "{secret} in {text}");
            assert!(!json.contains(secret), "{secret} in {json}");
        }
        let entries = log.read(10);
        let warn = entries.iter().find(|e| e.level == "WARN" && e.source == "git").unwrap();
        assert!(warn.message.starts_with("push to https://***@h/x failed"), "{}", warn.message);
        assert!(warn.message.contains("token=***") && warn.message.contains("api_key=***"), "{}", warn.message);
        // The span's source applies to the events inside it.
        assert!(entries.iter().any(|e| e.message.contains("user=bob") && e.source == "git"));
        let line: serde_json::Value = serde_json::from_str(json.lines().next().unwrap()).unwrap();
        assert_eq!((line["level"].as_str(), line["source"].as_str()), (Some("WARN"), Some("ui")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn closed_spans_write_their_timing() {
        let dir = temp("layer-span");
        let log = traced(&dir, || {
            let span = tracing::info_span!("jira_sync", source = "jira", site = "s1");
            let _e = span.enter();
            std::thread::sleep(Duration::from_millis(25));
            tracing::info!(issues = 3, "fetched");
        });
        let entries = log.read(10);
        let done = entries.iter().find(|e| e.message.starts_with("jira_sync done")).expect("timing line");
        assert_eq!((done.level.as_str(), done.source.as_str()), ("INFO", "jira"));
        let ms: u64 = done
            .message
            .split_whitespace()
            .find_map(|w| w.strip_prefix("elapsed_ms="))
            .and_then(|v| v.parse().ok())
            .expect("elapsed_ms field");
        assert!(ms >= 25, "{ms}");
        assert!(done.message.contains("site=s1"), "{}", done.message);
        // Events name their area; the timing line comes after them.
        assert_eq!(entries[1].message, "fetched issues=3");
        assert_eq!(entries[1].source, "jira");
        // A debug span is not written at the info level.
        let quiet = traced(&dir, || {
            let _s = tracing::debug_span!("calendar_sync", source = "calendar").entered();
        });
        assert!(!quiet.read(10).iter().any(|e| e.message.starts_with("calendar_sync")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn sources_come_from_fields_spans_or_the_module() {
        assert_eq!(source_of("arcalo_core::db"), "db");
        assert_eq!(source_of("arcalo_lib::updates"), "updates");
        assert_eq!(source_of("arcalo"), "core");
        assert_eq!(source_of("zbus::conn"), "zbus");
        assert!(secret_name("git_token") && secret_name("Authorization") && !secret_name("site"));
    }

    #[test]
    fn json_lines_rotate_by_size() {
        let dir = temp("json-rotate");
        let mut w = Rotating { dir: dir.clone(), name: JSON_FILE, max: 5 };
        for i in 0..5 {
            w.write_all(format!("{{\"n\":{i}}}\n").as_bytes()).unwrap();
        }
        assert_eq!(json_files(&dir).len(), 4, "the current file and three old ones");
        let _ = fs::remove_dir_all(&dir);
    }
}
