//! 1.17: the folders of the old identifier go once their copy is in use (owner decision; 1.15 and
//! 1.16 kept them for a return to an older version).
//!
//! [`run`] deletes a folder of the old identifier only when all of this holds, and otherwise keeps
//! it as it is and says why ([`Reason`]):
//!
//! - this copy is installed (a portable copy writes nothing into the user profile it runs on);
//! - the migration of this start found the pair done ([`Status::Done`]): a folder copied or copied
//!   again at this start is deleted at a later one, after a start that worked in the new folder;
//! - the marker in the new folder names exactly this folder (a workspace set up on its own never
//!   took anything from an old folder that showed up later), no copy is unfinished there, the new
//!   folder holds the workspace when the old one held one, and the old database is the one copied;
//! - nothing in use points into it: the data and config folders of this start, `location.json`
//!   (`data_dir`, `pending_move`), the backup folder, the Markdown copy, every backup destination,
//!   the extra root certificate, the program folder, and the rollback to the version before the
//!   update while that one is older than 1.15 (it reads the old folder);
//! - no move of the workspace runs in it and no process holds its single-instance lock;
//! - it holds no symbolic link (the copy skipped them: what they point to was never taken over)
//!   and no file changed after the copy (an older version started on it again).
//!
//! The folder is renamed to `<identifier>.removing` first and then deleted: an older version
//! started meanwhile finds either the whole folder or none, and a deletion cut off (a crash, the
//! app closed) is finished at the next start. Only the exact folders of the old identifier and
//! that name are ever deleted; symbolic links inside are removed as links, never followed.
//!
//! What was removed is recorded in [`LOG_FILE`] in the config folder, with what the user has not
//! been told yet ([`take_notice`]). The credential store's entries of the old service name are
//! removed by the shell (`secrets.rs`) once no folder of the old identifier is left.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde::{Deserialize, Serialize};

use super::{IDENTIFIER, LEGACY_IDENTIFIER, MARKER, Mode, Outcome, PARTIAL, STAGING_SUFFIX, Status};
use crate::settings::Settings;
use crate::trf;

/// What the cleanup did, in the config folder (per computer, never synced or moved with the data).
pub const LOG_FILE: &str = "legacy-cleanup.json";
/// Suffix of an old folder while it is being deleted.
const REMOVING_SUFFIX: &str = ".removing";
/// The single-instance lock in a data folder (`portable.rs` in the shell; 1.14 used the old name).
const LOCK_FILE: &str = ".arcalo.lock";
/// The first version that reads the folders of the new identifier.
const FIRST_NEW_VERSION: semver::Version = semver::Version::new(1, 15, 0);

/// This start, as far as the cleanup needs it.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// The data folder in use.
    pub data_dir: &'a Path,
    /// The config folder in use (`location.json`).
    pub config_dir: Option<&'a Path>,
    /// The settings of the open workspace (`None`: not readable; then nothing is deleted).
    pub settings: Option<&'a Settings>,
    /// The folder of the running program.
    pub exe_dir: Option<&'a Path>,
    /// This copy runs portable.
    pub portable: bool,
    /// The version running now (the rollback record's `to`).
    pub version: &'a str,
}

/// Why a folder of the old identifier is kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    /// A portable copy leaves the user profile it runs on alone.
    Portable,
    /// The settings of the workspace could not be read (they may name a folder inside).
    NoSettings,
    /// The migration of this start did not find the pair done (copied now, copied again, failed).
    NotDone(String),
    /// The new folder's marker does not name this folder (a workspace set up on its own).
    NotRecorded,
    /// A copy into the new folder is unfinished.
    Unfinished,
    /// The old folder holds a workspace, the new one none.
    NoWorkspace,
    /// The old database changed after the copy.
    Changed,
    /// The version before the update is older than 1.15 and can still be returned to.
    Rollback(String),
    /// Something of this start points into the folder: what, and the path.
    InUse { what: &'static str, path: PathBuf },
    /// A move of the workspace runs in it.
    Moving,
    /// Another process holds the single-instance lock in it.
    Locked,
    /// A symbolic link (the folder itself or one inside).
    Link(PathBuf),
    /// A file changed after the copy.
    Newer(PathBuf),
    /// Deleting failed.
    Failed(String),
}

impl Reason {
    /// A line for the developer log.
    pub fn describe(&self) -> String {
        match self {
            Reason::Portable => "a portable copy leaves the user profile alone".into(),
            Reason::NoSettings => "the settings of the workspace are not readable".into(),
            Reason::NotDone(s) => format!("not taken over at an earlier start ({s}); checked again at the next start"),
            Reason::NotRecorded => format!("the new folder's {MARKER} does not name it (never taken over)"),
            Reason::Unfinished => "a copy into the new folder is unfinished".into(),
            Reason::NoWorkspace => "it holds a workspace and the new folder none".into(),
            Reason::Changed => "its database changed after the copy".into(),
            Reason::Rollback(v) => format!("a return to {v} (which reads it) is still possible"),
            Reason::InUse { what, path } => format!("{what} points into it ({})", path.display()),
            Reason::Moving => "a move of the workspace runs in it".into(),
            Reason::Locked => "another process holds its lock (an older version running?)".into(),
            Reason::Link(p) => format!("symbolic link {} (not followed, not copied)", p.display()),
            Reason::Newer(p) => format!("{} changed after the copy", p.display()),
            Reason::Failed(e) => format!("not deleted: {e}"),
        }
    }
}

/// What happened to one folder of the old identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    Removed { files: usize, bytes: u64 },
    Kept(Reason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Folder {
    pub path: PathBuf,
    pub step: Step,
}

impl Folder {
    /// A line for the developer log.
    pub fn describe(&self) -> String {
        match &self.step {
            Step::Removed { files, bytes } => {
                format!("{} deleted ({files} files, {bytes} bytes; its copy is in use)", self.path.display())
            }
            Step::Kept(r) => format!("{} kept: {}", self.path.display(), r.describe()),
        }
    }
}

/// Deletes the folders of the old identifier whose copy is in use (see the module docs). Only
/// pairs that are copied ([`Mode::Copy`]) count; caches were renamed, not copied.
pub fn run(outcomes: &[Outcome], ctx: &Context) -> Vec<Folder> {
    let mut out = Vec::new();
    for o in outcomes.iter().filter(|o| o.pair.mode == Mode::Copy) {
        // A deletion cut off at an earlier start.
        let removing = removing_path(&o.pair.from);
        if fs::symlink_metadata(&removing).is_ok() {
            out.push(Folder { path: removing.clone(), step: finish(&removing, o) });
        }
        if fs::symlink_metadata(&o.pair.from).is_err() {
            continue;
        }
        let step = match check(o, outcomes, ctx) {
            Ok(()) => remove(&o.pair.from, recorded_at(o)),
            Err(reason) => Step::Kept(reason),
        };
        out.push(Folder { path: o.pair.from.clone(), step });
    }
    out
}

/// Whether a folder of the old identifier is left (the credential store's old entries stay
/// while one is: an older version started on it would need them).
pub fn legacy_left(outcomes: &[Outcome]) -> bool {
    outcomes.iter().filter(|o| o.pair.mode == Mode::Copy).any(|o| {
        fs::symlink_metadata(&o.pair.from).is_ok() || fs::symlink_metadata(removing_path(&o.pair.from)).is_ok()
    })
}

fn removing_path(from: &Path) -> PathBuf {
    from.with_file_name(format!("{LEGACY_IDENTIFIER}{REMOVING_SUFFIX}"))
}

/// When the copy was made (the marker's time), `None` when the marker does not tell.
fn recorded_at(o: &Outcome) -> Option<SystemTime> {
    let record = super::read_record(&o.pair.to)?;
    let at = chrono::DateTime::parse_from_rfc3339(&record.at).ok()?;
    Some(SystemTime::from(at.with_timezone(&chrono::Utc)))
}

/// The marker of the new folder names `from`: the copy was made from it.
fn recorded(o: &Outcome) -> bool {
    super::read_record(&o.pair.to).is_some_and(|r| !r.from.is_empty() && Path::new(&r.from) == o.pair.from)
}

fn check(o: &Outcome, outcomes: &[Outcome], ctx: &Context) -> Result<(), Reason> {
    let (from, to) = (&o.pair.from, &o.pair.to);
    if ctx.portable {
        return Err(Reason::Portable);
    }
    if fs::symlink_metadata(from).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Reason::Link(from.clone()));
    }
    if o.status != Status::Done {
        return Err(Reason::NotDone(status_name(&o.status)));
    }
    if !recorded(o) {
        return Err(Reason::NotRecorded);
    }
    let staging = to.with_file_name(format!("{IDENTIFIER}{STAGING_SUFFIX}"));
    if to.join(PARTIAL).exists() || staging.exists() {
        return Err(Reason::Unfinished);
    }
    let db = crate::datadir::DB_FILE;
    if from.join(db).is_file() && !to.join(db).is_file() {
        return Err(Reason::NoWorkspace);
    }
    if ctx.settings.is_none() {
        return Err(Reason::NoSettings);
    }
    if let Some(v) = rollback_to_old_version(ctx) {
        return Err(Reason::Rollback(v));
    }
    if let Some((what, path)) = references(outcomes, ctx).into_iter().find(|(_, p)| inside(p, from)) {
        return Err(Reason::InUse { what, path });
    }
    if let Some(stamp) = super::read_record(to).and_then(|r| r.stamp)
        && super::db_stamp(from).as_ref() != Some(&stamp)
    {
        return Err(Reason::Changed);
    }
    let staging = crate::datadir::STAGING_DIR;
    if [staging.to_owned(), super::legacy(staging)].iter().any(|s| from.join(s).exists()) {
        return Err(Reason::Moving);
    }
    if locked(from) {
        return Err(Reason::Locked);
    }
    Ok(())
}

fn status_name(s: &Status) -> String {
    match s {
        Status::Nothing => "nothing to take over".into(),
        Status::Done => "done".into(),
        Status::Copied { .. } => "copied at this start".into(),
        Status::Refreshed { .. } => "copied again at this start".into(),
        Status::Moved => "moved".into(),
        Status::Failed(e) => format!("failed: {e}"),
    }
}

/// The version before the update when it is older than 1.15 and a return to it is possible.
fn rollback_to_old_version(ctx: &Context) -> Option<String> {
    let record = crate::update_state::RollbackRecord::load(ctx.data_dir)?;
    let from = semver::Version::parse(record.from.trim().trim_start_matches('v')).ok()?;
    (from < FIRST_NEW_VERSION && record.can_return(ctx.version)).then(|| record.from.clone())
}

/// Every path this start uses or points to, with what it is (for the log).
fn references(outcomes: &[Outcome], ctx: &Context) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = vec![("the data folder in use", ctx.data_dir.to_path_buf())];
    let mut configs: Vec<&Path> = Vec::new();
    if let Some(c) = ctx.config_dir {
        out.push(("the config folder in use", c.to_path_buf()));
        configs.push(c);
    }
    configs.extend(outcomes.iter().filter(|o| o.pair.mode == Mode::Copy).map(|o| o.pair.to.as_path()));
    for dir in configs {
        if let Some(loc) = crate::datadir::read_location_file(dir) {
            out.push(("location.json (data_dir)", PathBuf::from(loc.data_dir.trim())));
            if let Some(p) = loc.pending_move {
                out.push(("location.json (pending_move)", PathBuf::from(p.trim())));
            }
        }
    }
    let mut add = |what: &'static str, path: Option<&str>| {
        if let Some(p) = path.map(str::trim).filter(|p| !p.is_empty()) {
            out.push((what, PathBuf::from(p)));
        }
    };
    if let Some(s) = ctx.settings {
        add("the backup folder", s.backup_dir.as_deref());
        add("the Markdown copy", s.markdown_mirror_dir.as_deref());
        for d in &s.backup_targets.destinations {
            add("a backup destination", Some(&d.path));
        }
        for p in &s.network.profiles {
            add("the extra root certificate of a network profile", p.extra_ca_path.as_deref());
        }
    }
    let registry = crate::backupdest::read_registry(ctx.data_dir);
    add("the backup folder (registry)", registry.local_dir.as_deref());
    for d in &registry.destinations {
        add("a backup destination (registry)", Some(&d.path));
    }
    if let Some(r) = crate::update_state::RollbackRecord::load(ctx.data_dir).filter(|r| r.applies_to(ctx.version)) {
        for p in r.backup.iter().chain(r.copy.iter()) {
            out.push(("the rollback of the last update", p.clone()));
        }
    }
    if let Some(e) = ctx.exe_dir {
        out.push(("the program folder", e.to_path_buf()));
    }
    out.retain(|(_, p)| !p.as_os_str().is_empty());
    out
}

/// Whether `path` is `folder` or lies inside it: by its spelling (`.` and `..` resolved, without
/// case on Windows and macOS) and, where the paths exist, after symbolic links are resolved (a
/// link elsewhere that leads into the folder counts).
pub fn inside(path: &Path, folder: &Path) -> bool {
    if path.as_os_str().is_empty() {
        return false;
    }
    if lexical(path).starts_with(&lexical(folder)) {
        return true;
    }
    match (resolved(path), folder.canonicalize()) {
        (Some(p), Ok(f)) => lexical(&p).starts_with(&lexical(&f)),
        _ => false,
    }
}

/// The components of `path` with `.` and `..` resolved by spelling.
fn lexical(path: &Path) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            c => {
                let s = c.as_os_str().to_string_lossy();
                parts.push(if cfg!(any(windows, target_os = "macos")) { s.to_lowercase() } else { s.into_owned() });
            }
        }
    }
    parts
}

/// `path` with its nearest existing ancestor's symbolic links resolved.
fn resolved(path: &Path) -> Option<PathBuf> {
    let mut rest = Vec::new();
    let mut at = path;
    loop {
        if let Ok(real) = at.canonicalize() {
            return Some(rest.iter().rev().fold(real, |p, c| p.join(c)));
        }
        rest.push(at.file_name()?.to_owned());
        at = at.parent()?;
    }
}

/// Another process holds the single-instance lock of the folder (this name or the old one).
fn locked(dir: &Path) -> bool {
    [LOCK_FILE.to_owned(), super::legacy(LOCK_FILE)].iter().any(|name| {
        let path = dir.join(name);
        if !path.is_file() {
            return false;
        }
        // Opened without creating or truncating: the lock file stays as it is.
        let Ok(file) = fs::OpenOptions::new().write(true).open(&path) else { return false };
        matches!(file.try_lock(), Err(fs::TryLockError::WouldBlock))
    })
}

/// Files and bytes of a folder; a symbolic link or a file changed after `since` stops it.
fn scan(dir: &Path, since: SystemTime) -> Result<(usize, u64), Reason> {
    let (mut files, mut bytes) = (0, 0);
    let entries = fs::read_dir(dir).map_err(|e| Reason::Failed(crate::Error::file(dir, e).to_string()))?;
    for entry in entries {
        let entry = entry.map_err(|e| Reason::Failed(crate::Error::file(dir, e).to_string()))?;
        let path = entry.path();
        // Not followed: the type of the entry itself.
        let kind = entry.file_type().map_err(|e| Reason::Failed(crate::Error::file(&path, e).to_string()))?;
        if kind.is_symlink() {
            return Err(Reason::Link(path));
        }
        if kind.is_dir() {
            let (f, b) = scan(&path, since)?;
            files += f;
            bytes += b;
            continue;
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| Reason::Failed(crate::Error::file(&path, e).to_string()))?;
        // A time that cannot be read counts as newer: kept rather than guessed.
        if !meta.modified().is_ok_and(|m| m <= since) {
            return Err(Reason::Newer(path));
        }
        files += 1;
        bytes += meta.len();
    }
    Ok((files, bytes))
}

/// Deletes a checked folder: scanned (no link, nothing newer than the copy), renamed aside, deleted.
fn remove(from: &Path, since: Option<SystemTime>) -> Step {
    let Some(since) = since else { return Step::Kept(Reason::NotRecorded) };
    let (files, bytes) = match scan(from, since) {
        Ok(n) => n,
        Err(reason) => return Step::Kept(reason),
    };
    let removing = removing_path(from);
    // In use (an open file on Windows): the rename fails and nothing is touched.
    if let Err(e) = fs::rename(from, &removing) {
        return Step::Kept(Reason::Failed(crate::Error::file(from, e).to_string()));
    }
    match fs::remove_dir_all(&removing) {
        Ok(()) => Step::Removed { files, bytes },
        Err(e) => Step::Kept(Reason::Failed(crate::Error::file(&removing, e).to_string())),
    }
}

/// Finishes a deletion cut off at an earlier start: only a folder of that exact name, not a link,
/// next to a new folder whose marker names the old one.
fn finish(removing: &Path, o: &Outcome) -> Step {
    if fs::symlink_metadata(removing).is_ok_and(|m| !m.is_dir()) {
        return Step::Kept(Reason::Link(removing.to_path_buf()));
    }
    if !recorded(o) {
        return Step::Kept(Reason::NotRecorded);
    }
    let (files, bytes) = count(removing);
    match fs::remove_dir_all(removing) {
        Ok(()) => Step::Removed { files, bytes },
        Err(e) => Step::Kept(Reason::Failed(crate::Error::file(removing, e).to_string())),
    }
}

/// Files and bytes below `dir` (links not followed, not counted).
fn count(dir: &Path) -> (usize, u64) {
    let Ok(entries) = fs::read_dir(dir) else { return (0, 0) };
    entries.flatten().fold((0, 0), |(f, b), e| match e.file_type() {
        Ok(t) if t.is_dir() => {
            let (f2, b2) = count(&e.path());
            (f + f2, b + b2)
        }
        Ok(t) if t.is_file() => (f + 1, b + e.metadata().map_or(0, |m| m.len())),
        _ => (f, b),
    })
}

// ------------------------------------------------------------------ the record

/// [`LOG_FILE`]: what was removed, and what the user has not been told yet.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Log {
    /// Folders deleted (path, bytes, when).
    pub removed: Vec<Removed>,
    /// The folders kept at the last run, with the reason.
    pub kept: Vec<Kept>,
    /// Accounts whose entry of the old service name was removed from the credential store.
    pub credentials: Vec<String>,
    /// No entry of the old service name is left for an account taken over: not looked at again.
    pub credentials_done: bool,
    pub last_run: Option<String>,
    /// Removed since the user was last told.
    pub untold: Option<Cleaned>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Removed {
    pub path: String,
    pub bytes: u64,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Kept {
    pub path: String,
    pub reason: String,
}

/// What a notice tells.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Cleaned {
    pub folders: usize,
    pub credentials: usize,
    pub bytes: u64,
}

pub fn read_log(config_dir: &Path) -> Log {
    fs::read(config_dir.join(LOG_FILE)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_log(config_dir: &Path, log: &Log) -> crate::Result<()> {
    let path = config_dir.join(LOG_FILE);
    let tmp = config_dir.join(format!(".{LOG_FILE}.part"));
    fs::create_dir_all(config_dir).map_err(|e| crate::Error::file(config_dir, e))?;
    fs::write(&tmp, serde_json::to_vec_pretty(log)?)
        .and_then(|()| fs::rename(&tmp, &path))
        .map_err(|e| crate::Error::file(&path, e))
}

/// Records a run: the folders, the credential entries removed (`credentials`) and whether none is
/// left (`credentials_done`). What was removed is added to what the user has not been told yet.
pub fn record(
    config_dir: &Path,
    folders: &[Folder],
    credentials: &[String],
    credentials_done: bool,
    now: chrono::DateTime<chrono::Utc>,
) -> crate::Result<Log> {
    let mut log = read_log(config_dir);
    let at = now.to_rfc3339();
    let mut fresh = Cleaned::default();
    log.kept.clear();
    for f in folders {
        let path = f.path.display().to_string();
        match &f.step {
            Step::Removed { bytes, .. } => {
                // A deletion finished at a later start is one folder, not two.
                let name = f.path.with_file_name(LEGACY_IDENTIFIER).display().to_string();
                if !log.removed.iter().any(|r| r.path == name) {
                    fresh.folders += 1;
                }
                fresh.bytes += bytes;
                log.removed.retain(|r| r.path != name);
                log.removed.push(Removed { path: name, bytes: *bytes, at: at.clone() });
            }
            Step::Kept(r) => log.kept.push(Kept { path, reason: r.describe() }),
        }
    }
    fresh.credentials = credentials.len();
    log.credentials.extend(credentials.iter().cloned());
    log.credentials_done |= credentials_done;
    log.last_run = Some(at);
    if fresh != Cleaned::default() {
        let mut untold = log.untold.take().unwrap_or_default();
        untold.folders += fresh.folders;
        untold.credentials += fresh.credentials;
        untold.bytes += fresh.bytes;
        log.untold = Some(untold);
    }
    write_log(config_dir, &log)?;
    Ok(log)
}

/// The notice about what was removed, once: taken from the record (`None` when there is nothing
/// to tell or the record cannot be written, so it is never shown twice).
pub fn take_notice(config_dir: &Path) -> Option<String> {
    let mut log = read_log(config_dir);
    let cleaned = log.untold.take()?;
    write_log(config_dir, &log).ok()?;
    Some(notice_text(&cleaned))
}

fn notice_text(c: &Cleaned) -> String {
    let en = crate::i18n::is_en();
    let folders = match (c.folders, en) {
        (1, false) => "1 alter Ordner".to_owned(),
        (n, false) => format!("{n} alte Ordner"),
        (1, true) => "1 old folder".to_owned(),
        (n, true) => format!("{n} old folders"),
    };
    let credentials = match (c.credentials, en) {
        (1, false) => "1 alter Eintrag mit Zugangsdaten".to_owned(),
        (n, false) => format!("{n} alte Einträge mit Zugangsdaten"),
        (1, true) => "1 old credential entry".to_owned(),
        (n, true) => format!("{n} old credential entries"),
    };
    let what = match (c.folders, c.credentials) {
        (0, _) => credentials,
        (_, 0) => folders,
        _ => trf!("{folders} und {credentials}", "{folders} and {credentials}"),
    };
    let freed = if c.bytes > 0 { trf!(", {} frei geworden", ", {} freed", size_text(c.bytes)) } else { String::new() };
    trf!(
        "Seit dem Umzug in die neuen Ordner (Version 1.15) lagen die Daten doppelt vor. Gelöscht: {what}{freed}. Deine Notizen, Einstellungen und Zugangsdaten sind unverändert da.",
        "Since the move to the new folders (version 1.15) the data was kept twice. Deleted: {what}{freed}. Your notes, settings and credentials are unchanged."
    )
}

/// A size as the UI writes it (`812 KB`, `3,4 MB`).
fn size_text(bytes: u64) -> String {
    const K: f64 = 1024.0;
    let b = bytes as f64;
    if bytes < 1024 {
        format!("{bytes} B")
    } else if b < K * K {
        format!("{} KB", (b / K).round())
    } else if b < K * K * K {
        format!("{} MB", crate::i18n::decimal(format!("{:.1}", b / (K * K))))
    } else {
        format!("{} GB", crate::i18n::decimal(format!("{:.1}", b / (K * K * K))))
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::{layout_114, put};
    use super::super::{COMPARE_BYTES, Pair, migrate, pairs};
    use super::*;
    use crate::backupdest::Destination;
    use crate::datadir::DB_FILE;
    use crate::db::Database;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("arcalo-cleanup-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn context<'a>(data_dir: &'a Path, config_dir: &'a Path, settings: &'a Settings) -> Context<'a> {
        Context {
            data_dir,
            config_dir: Some(config_dir),
            settings: Some(settings),
            exe_dir: None,
            portable: false,
            version: "1.17.0",
        }
    }

    /// An install of 1.14 on Linux: data (with WebKitGTK's storage) in `share`, the config in
    /// `config`, the cache in `cache`.
    struct Install {
        base: PathBuf,
        share: PathBuf,
        config: PathBuf,
        pairs: Vec<Pair>,
        page: i64,
    }

    impl Install {
        fn new(name: &str) -> Install {
            let base = tmp(name);
            let (share, config, cache) = (base.join("share"), base.join("config"), base.join("cache"));
            let (_, page) = layout_114(&share);
            put(&config.join(LEGACY_IDENTIFIER).join("window.json"), br#"{"width":1280}"#);
            put(&cache.join(LEGACY_IDENTIFIER).join("WebKit/x"), b"c");
            let pairs = pairs(&[(share.clone(), Mode::Copy), (config.clone(), Mode::Copy), (cache, Mode::Move)]);
            Install { base, share, config, pairs, page }
        }
        /// Taken over by a start of 1.15 or later (copied; the cleanup waits for the next start).
        fn taken_over(name: &str) -> Install {
            let i = Install::new(name);
            let first = i.start(&Settings::default());
            assert!(first.iter().all(|f| matches!(f.step, Step::Kept(Reason::NotDone(_)))), "{first:?}");
            assert!(i.old().join(DB_FILE).is_file());
            i
        }
        fn old(&self) -> PathBuf {
            self.share.join(LEGACY_IDENTIFIER)
        }
        fn old_config(&self) -> PathBuf {
            self.config.join(LEGACY_IDENTIFIER)
        }
        fn new_data(&self) -> PathBuf {
            self.share.join(IDENTIFIER)
        }
        fn new_config(&self) -> PathBuf {
            self.config.join(IDENTIFIER)
        }
        /// A start: the migration, then the cleanup as the shell runs it.
        fn start(&self, settings: &Settings) -> Vec<Folder> {
            self.start_as(Some(settings), None, None, false)
        }
        /// A start with other settings (`None`: unreadable), data folder, program folder or a
        /// portable copy.
        fn start_as(
            &self,
            settings: Option<&Settings>,
            data_dir: Option<&Path>,
            exe_dir: Option<&Path>,
            portable: bool,
        ) -> Vec<Folder> {
            let outcomes = migrate(&self.pairs);
            let (data, config) = (self.new_data(), self.new_config());
            let ctx = Context {
                data_dir: data_dir.unwrap_or(&data),
                config_dir: Some(&config),
                settings,
                exe_dir,
                portable,
                version: "1.17.0",
            };
            run(&outcomes, &ctx)
        }
    }

    impl Drop for Install {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    fn kept(out: &[Folder], path: &Path) -> Reason {
        match out.iter().find(|f| f.path == path).map(|f| f.step.clone()) {
            Some(Step::Kept(r)) => r,
            other => panic!("{} not kept: {other:?} in {out:?}", path.display()),
        }
    }

    fn removed(out: &[Folder]) -> Vec<PathBuf> {
        out.iter().filter(|f| matches!(f.step, Step::Removed { .. })).map(|f| f.path.clone()).collect()
    }

    fn content(dir: &Path, id: i64) -> String {
        Database::open(dir.join(DB_FILE)).unwrap().page_doc(id).unwrap().content
    }

    #[test]
    fn a_114_install_taken_over_loses_its_old_folders_at_the_next_start() {
        let i = Install::taken_over("happy");
        let out = i.start(&Settings::default());
        let mut gone = removed(&out);
        gone.sort();
        assert_eq!(gone, [i.old_config(), i.old()], "{out:?}");
        let bytes: u64 = out
            .iter()
            .map(|f| match f.step {
                Step::Removed { bytes, .. } => bytes,
                Step::Kept(_) => 0,
            })
            .sum();
        assert!(bytes > COMPARE_BYTES, "the large file counted: {bytes}");
        assert!(!i.old().exists() && !i.old_config().exists());
        assert!(!removing_path(&i.old()).exists(), "nothing left aside");
        // The workspace and everything else of the new folders is intact.
        assert_eq!(content(&i.new_data(), i.page), "geschrieben mit 1.14");
        for f in
            ["attachments/bild.png", "secrets.json", "localstorage/tauri_localhost_0.localstorage", "big/large.bin"]
        {
            assert!(i.new_data().join(f).is_file(), "{f}");
        }
        assert!(i.new_config().join("window.json").is_file());
        assert!(i.base.join("cache").join(IDENTIFIER).join("WebKit/x").is_file(), "the moved cache stays");
        assert!(!legacy_left(&migrate(&i.pairs)));
        // Idempotent: nothing left to do, and the new folders stay as they are.
        assert_eq!(i.start(&Settings::default()), []);
        assert_eq!(content(&i.new_data(), i.page), "geschrieben mit 1.14");
    }

    #[test]
    fn webview2_storage_of_the_old_identifier_goes_with_its_folder() {
        // Windows: data and config in Roaming, the WebView's profile in Local.
        let base = tmp("webview2");
        let (roaming, local) = (base.join("Roaming"), base.join("Local"));
        layout_114(&roaming);
        put(&local.join(LEGACY_IDENTIFIER).join("EBWebView/Default/Local Storage/leveldb/000003.log"), b"tabs");
        put(&local.join(LEGACY_IDENTIFIER).join("EBWebView/Default/Cache/Cache_Data/data_0"), b"cache");
        let pairs = pairs(&[
            (roaming.clone(), Mode::Copy),
            (roaming.clone(), Mode::Copy),
            (local.clone(), Mode::Copy),
            (local.clone(), Mode::Move),
        ]);
        let (data, settings) = (roaming.join(IDENTIFIER), Settings::default());
        run(&migrate(&pairs), &context(&data, &data, &settings));
        let out = run(&migrate(&pairs), &context(&data, &data, &settings));
        assert_eq!(removed(&out).len(), 2, "{out:?}");
        assert!(!local.join(LEGACY_IDENTIFIER).exists() && !roaming.join(LEGACY_IDENTIFIER).exists());
        assert!(local.join(IDENTIFIER).join("EBWebView/Default/Local Storage/leveldb/000003.log").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn an_encrypted_workspace_still_opens_with_its_key_afterwards() {
        use crate::cipher::{self, DbKey};
        let base = tmp("encrypted");
        let old = base.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(&old).unwrap();
        let plain = base.join("plain.db");
        let db = Database::open(&plain).unwrap();
        db.create_page(None, "Geheim", None).unwrap();
        drop(db);
        let key = DbKey::generate().unwrap();
        cipher::export(&plain, None, &old.join(DB_FILE), Some(&key)).unwrap();
        fs::remove_file(&plain).unwrap();
        let pairs = pairs(&[(base.clone(), Mode::Copy)]);
        let (new, settings) = (base.join(IDENTIFIER), Settings::default());
        run(&migrate(&pairs), &context(&new, &new, &settings));
        assert_eq!(removed(&run(&migrate(&pairs), &context(&new, &new, &settings))), [old]);
        assert!(cipher::key_opens(&new.join(DB_FILE), &key), "the copy opens with the key");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_custom_data_folder_from_location_json_is_never_touched() {
        let i = Install::new("custom");
        let custom = i.base.join("Daten auf D");
        fs::create_dir_all(&custom).unwrap();
        let db = Database::open(custom.join(DB_FILE)).unwrap();
        let page = db.create_page(None, "Eigene", None).unwrap();
        drop(db);
        crate::datadir::write_location(&i.old_config(), &custom).unwrap();
        let (config, settings) = (i.new_config(), Settings::default());
        run(&migrate(&i.pairs), &context(&custom, &config, &settings));
        let out = run(&migrate(&i.pairs), &context(&custom, &config, &settings));
        assert_eq!(removed(&out).len(), 2, "{out:?}");
        assert_eq!(crate::datadir::read_location(&config), Some(custom.clone()));
        assert_eq!(Database::open(custom.join(DB_FILE)).unwrap().page(page.id).unwrap().title, "Eigene");
    }

    #[test]
    fn location_json_pointing_into_an_old_folder_keeps_it() {
        let i = Install::taken_over("location");
        let old = i.old();
        // Spelled another way than the folder (the migration rewrites only the plain spelling).
        let odd = i.new_data().join("..").join(LEGACY_IDENTIFIER).join("Unterordner");
        crate::datadir::write_location(&i.new_config(), &odd).unwrap();
        let out = i.start(&Settings::default());
        assert!(matches!(kept(&out, &old), Reason::InUse { what: "location.json (data_dir)", .. }), "{out:?}");
        // A pending move into it as well.
        crate::datadir::write_pending_move(&i.new_config(), Path::new(""), &odd).unwrap();
        let out = i.start(&Settings::default());
        assert!(matches!(kept(&out, &old), Reason::InUse { what: "location.json (pending_move)", .. }), "{out:?}");
        assert!(old.join(DB_FILE).is_file());
        // Back to the default folder: deleted.
        crate::datadir::write_location(&i.new_config(), Path::new("")).unwrap();
        assert!(removed(&i.start(&Settings::default())).contains(&old));
    }

    #[test]
    fn paths_inside_by_spelling_or_through_a_link() {
        let i = Install::taken_over("inside");
        let old = i.old();
        assert!(inside(&old.join("a/../b"), &old) && inside(&old, &old));
        assert!(!inside(&i.new_data(), &old) && !inside(Path::new(""), &old));
        assert!(!inside(&i.share.join(format!("{LEGACY_IDENTIFIER}2")), &old), "a sibling with a longer name");
        #[cfg(unix)]
        {
            let link = i.base.join("Verknüpfung");
            std::os::unix::fs::symlink(&old, &link).unwrap();
            assert!(inside(&link.join("backups"), &old));
            assert!(inside(&link.join("neu/tiefer"), &old), "not existing yet below the link");
            let settings =
                Settings { backup_dir: Some(link.join("backups").display().to_string()), ..Default::default() };
            let out = i.start(&settings);
            assert!(matches!(kept(&out, &old), Reason::InUse { what: "the backup folder", .. }), "{out:?}");
            assert!(old.join(DB_FILE).is_file());
        }
    }

    #[test]
    fn settings_and_backup_destinations_pointing_into_an_old_folder_keep_it() {
        let i = Install::taken_over("settings");
        let old = i.old();
        let inner = old.join("Sicherungen").display().to_string();
        let dest = |path: &str| crate::backupdest::BackupTargets {
            destinations: vec![Destination { path: path.into(), enabled: false, ..Default::default() }],
            ..Default::default()
        };
        let mut ca = Settings::default();
        ca.network.profiles[0].extra_ca_path = Some(old.join("firma.pem").display().to_string());
        let cases: Vec<(&str, Settings)> = vec![
            ("the backup folder", Settings { backup_dir: Some(inner.clone()), ..Default::default() }),
            ("the Markdown copy", Settings { markdown_mirror_dir: Some(inner.clone()), ..Default::default() }),
            ("a backup destination", Settings { backup_targets: dest(&inner), ..Default::default() }),
            ("the extra root certificate of a network profile", ca),
        ];
        for (what, settings) in cases {
            let out = i.start(&settings);
            assert!(matches!(kept(&out, &old), Reason::InUse { what: w, .. } if w == what), "{what}: {out:?}");
        }
        // The backup registry (read at start before the database) too.
        let reg = crate::backupdest::Registry { local_dir: Some(inner.clone()), ..Default::default() };
        crate::backupdest::write_registry(&i.new_data(), &reg).unwrap();
        let out = i.start(&Settings::default());
        assert!(matches!(kept(&out, &old), Reason::InUse { what: "the backup folder (registry)", .. }), "{out:?}");
        crate::backupdest::write_registry(&i.new_data(), &Default::default()).unwrap();
        // Unreadable settings: kept, they might name it.
        let out = i.start_as(None, None, None, false);
        assert_eq!(kept(&out, &old), Reason::NoSettings);
        assert!(old.join(DB_FILE).is_file());
        assert!(removed(&i.start(&Settings::default())).contains(&old));
    }

    #[test]
    fn the_data_folder_in_use_inside_an_old_folder_keeps_it() {
        let i = Install::taken_over("in-use");
        let old = i.old();
        let out = i.start_as(Some(&Settings::default()), Some(&old), None, false);
        assert!(matches!(kept(&out, &old), Reason::InUse { what: "the data folder in use", .. }), "{out:?}");
        assert!(old.join(DB_FILE).is_file());
    }

    #[test]
    fn a_portable_copy_touches_nothing() {
        let i = Install::taken_over("portable");
        let out = i.start_as(Some(&Settings::default()), None, None, true);
        assert_eq!(kept(&out, &i.old()), Reason::Portable);
        assert_eq!(kept(&out, &i.old_config()), Reason::Portable);
        // An installed copy whose program sits inside the old folder (a portable layout put there).
        let exe = i.old().join("Arcalo");
        let out = i.start_as(Some(&Settings::default()), None, Some(&exe), false);
        assert!(matches!(kept(&out, &i.old()), Reason::InUse { what: "the program folder", .. }), "{out:?}");
        assert!(i.old().join(DB_FILE).is_file());
    }

    #[test]
    fn a_running_older_version_or_a_move_in_it_keeps_it() {
        let i = Install::new("locked");
        // 1.14 locks `.annalo.lock` while it runs (the file is older than the copy).
        let lock = i.old().join(".annalo.lock");
        fs::write(&lock, b"").unwrap();
        i.start(&Settings::default());
        let held = fs::OpenOptions::new().write(true).open(&lock).unwrap();
        held.try_lock().unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &i.old()), Reason::Locked);
        drop(held);
        // A move of the workspace out of it, not finished.
        let staging = i.old().join(crate::datadir::STAGING_DIR);
        fs::create_dir_all(&staging).unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &i.old()), Reason::Moving);
        fs::remove_dir(&staging).unwrap();
        assert!(removed(&i.start(&Settings::default())).contains(&i.old()));
    }

    #[test]
    fn an_unfinished_copy_or_a_missing_workspace_keeps_it() {
        let i = Install::taken_over("unfinished");
        let old = i.old();
        fs::write(i.new_data().join(PARTIAL), b"").unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &old), Reason::Unfinished);
        fs::remove_file(i.new_data().join(PARTIAL)).unwrap();
        let staging = i.share.join(format!("{IDENTIFIER}{STAGING_SUFFIX}"));
        fs::create_dir_all(&staging).unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &old), Reason::Unfinished);
        fs::remove_dir(&staging).unwrap();
        // The new folder lost its workspace (deleted by hand): the old one is the only one.
        fs::rename(i.new_data().join(DB_FILE), i.base.join("weg.db")).unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &old), Reason::NoWorkspace);
        assert!(old.join(DB_FILE).is_file());
    }

    #[test]
    fn an_old_folder_never_taken_over_is_kept() {
        // A workspace set up with 1.15 on its own; an older version started later made the old folder.
        let base = tmp("own");
        let new = base.join(IDENTIFIER);
        fs::create_dir_all(&new).unwrap();
        Database::open(new.join(DB_FILE)).unwrap();
        let pairs = pairs(&[(base.clone(), Mode::Copy)]);
        migrate(&pairs);
        let (old, _) = layout_114(&base);
        let settings = Settings::default();
        let out = run(&migrate(&pairs), &context(&new, &new, &settings));
        assert_eq!(kept(&out, &old), Reason::NotRecorded);
        assert!(legacy_left(&migrate(&pairs)));
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_changed_old_database_or_a_newer_file_keeps_it() {
        let i = Install::taken_over("newer");
        let old = i.old();
        // Checked by the cleanup itself (the migration of the next start would copy again).
        let outcomes = migrate(&i.pairs);
        std::thread::sleep(std::time::Duration::from_millis(20));
        let db = Database::open(old.join(DB_FILE)).unwrap();
        db.save_page_content(i.page, "weiter in 1.14").unwrap();
        db.checkpoint().unwrap();
        drop(db);
        let (data, config, settings) = (i.new_data(), i.new_config(), Settings::default());
        assert_eq!(kept(&run(&outcomes, &context(&data, &config, &settings)), &old), Reason::Changed);
        // Copied again; then a file written after that copy.
        i.start(&settings);
        assert_eq!(content(&data, i.page), "weiter in 1.14");
        let later = old.join("attachments/neu.png");
        put(&later, b"png");
        let future = SystemTime::now() + std::time::Duration::from_secs(3600);
        fs::File::options().write(true).open(&later).unwrap().set_modified(future).unwrap();
        assert_eq!(kept(&i.start(&settings), &old), Reason::Newer(later.clone()));
        assert!(later.is_file() && old.join(DB_FILE).is_file());
    }

    #[test]
    fn a_return_to_114_that_is_still_possible_keeps_it() {
        use crate::update_state::{CopyKind, RollbackRecord};
        let i = Install::taken_over("rollback");
        // 1.14 wrote the backup before the update into its own folder.
        let backup = i.old().join("backups/arcalo-pre-update-1.14.1-1.15.0.db");
        let record = |from: &str, to: &str| RollbackRecord {
            from: from.into(),
            to: to.into(),
            backup: Some(backup.clone()),
            copy: None,
            kind: CopyKind::Test,
            created: chrono::Utc::now(),
        };
        record("1.14.1", "1.17.0").save(&i.new_data()).unwrap();
        assert_eq!(kept(&i.start(&Settings::default()), &i.old()), Reason::Rollback("1.14.1".into()));
        // From 1.16: no return into the old folder, but the backup there is still the way back.
        record("1.16.0", "1.17.0").save(&i.new_data()).unwrap();
        let out = i.start(&Settings::default());
        assert!(
            matches!(kept(&out, &i.old()), Reason::InUse { what: "the rollback of the last update", .. }),
            "{out:?}"
        );
        // The record of an earlier update (to another version) no longer counts.
        record("1.14.1", "1.15.0").save(&i.new_data()).unwrap();
        assert!(removed(&i.start(&Settings::default())).contains(&i.old()));
    }

    #[cfg(unix)]
    #[test]
    fn links_are_never_followed() {
        let i = Install::taken_over("links");
        let outside = i.base.join("Fotos");
        put(&outside.join("urlaub.jpg"), b"jpg");
        let link = i.old().join("attachments/fotos");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        // The old config folder itself a link to a folder elsewhere.
        let elsewhere = i.base.join("anderswo");
        fs::rename(i.old_config(), &elsewhere).unwrap();
        std::os::unix::fs::symlink(&elsewhere, i.old_config()).unwrap();
        let out = i.start(&Settings::default());
        assert_eq!(kept(&out, &i.old()), Reason::Link(link.clone()));
        assert_eq!(kept(&out, &i.old_config()), Reason::Link(i.old_config()));
        assert!(elsewhere.join("window.json").is_file() && outside.join("urlaub.jpg").is_file());
        // Without the inner link the data folder goes; the files the link pointed to stay, and so
        // does the folder behind the other link.
        fs::remove_file(&link).unwrap();
        let out = i.start(&Settings::default());
        assert_eq!(removed(&out), [i.old()]);
        assert!(outside.join("urlaub.jpg").is_file() && elsewhere.join("window.json").is_file());
    }

    #[test]
    fn a_deletion_cut_off_is_finished_at_the_next_start() {
        let i = Install::taken_over("cut-off");
        // Cut off after the rename (the app closed): the folder lies aside, half deleted.
        let aside = removing_path(&i.old());
        fs::rename(i.old(), &aside).unwrap();
        fs::remove_file(aside.join(DB_FILE)).unwrap();
        assert!(legacy_left(&migrate(&i.pairs)));
        let out = i.start(&Settings::default());
        assert!(removed(&out).contains(&aside), "{out:?}");
        assert!(!aside.exists() && i.new_data().join(DB_FILE).is_file());
        // A folder of that name next to a workspace that never took anything over stays.
        let base = tmp("cut-off-own");
        let new = base.join(IDENTIFIER);
        fs::create_dir_all(&new).unwrap();
        Database::open(new.join(DB_FILE)).unwrap();
        let pairs = pairs(&[(base.clone(), Mode::Copy)]);
        migrate(&pairs);
        let other = removing_path(&base.join(LEGACY_IDENTIFIER));
        put(&other.join("x"), b"x");
        let settings = Settings::default();
        let out = run(&migrate(&pairs), &context(&new, &new, &settings));
        assert_eq!(kept(&out, &other), Reason::NotRecorded);
        assert!(other.join("x").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn the_user_is_told_once_with_the_size() {
        let i = Install::taken_over("notice");
        let cfg = i.new_config();
        let first = i.start(&Settings::default());
        record(&cfg, &first, &["git-token".into(), "db-key".into()], true, chrono::Utc::now()).unwrap();
        let log = read_log(&cfg);
        assert_eq!(log.removed.len(), 2);
        assert!(log.credentials_done && log.credentials.len() == 2);
        let text = take_notice(&cfg).unwrap();
        assert!(text.contains("Gelöscht: 2 alte Ordner und 2 alte Einträge mit Zugangsdaten, "), "{text}");
        assert!(text.contains(" MB frei geworden."), "{text}");
        assert_eq!(take_notice(&cfg), None, "once");
        // Nothing removed: nothing to tell.
        record(&cfg, &i.start(&Settings::default()), &[], true, chrono::Utc::now()).unwrap();
        assert_eq!(take_notice(&cfg), None);
        let en = crate::i18n::with_lang(crate::prefs::Language::En, || {
            notice_text(&Cleaned { folders: 1, credentials: 0, bytes: 3 * 1024 * 1024 + 400 * 1024 })
        });
        assert!(en.contains("Deleted: 1 old folder, 3.4 MB freed."), "{en}");
        assert_eq!(size_text(3 * 1024 * 1024 + 400 * 1024), "3,4 MB");
        assert_eq!(size_text(812 * 1024), "812 KB");
        assert_eq!(size_text(1000), "1000 B");
    }
}
