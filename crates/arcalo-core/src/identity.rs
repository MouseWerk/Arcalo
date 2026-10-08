//! The rename of the internal names from Annalo to Arcalo (1.15).
//!
//! 1.7 renamed what users see; the internal names stayed until 1.15: the app identifier
//! `app.annalo.desktop` (data, config, WebView and cache folders, Windows toasts, the macOS bundle
//! id), the credential store's service `Annalo`, file markers, formats and the `ANNALO_*`
//! variables. This module holds the old names in one place and moves what existing installs keep
//! under them:
//!
//! - [`migrate`] copies the folders of the old identifier to the new one before the WebView
//!   exists (the shell calls it first thing at start). Each pair is copied into a staging folder,
//!   compared with the original (every file's size, small and top-level files byte for byte) and
//!   only then renamed into place, with a marker ([`MARKER`]) that makes the next start skip it.
//!   The old folder stays as it is: an older version started again (a rollback, a reinstall)
//!   finds its data, and the update's backups keep their paths. When that older version wrote to
//!   the old workspace after the copy, the next start copies it again and keeps the folder of
//!   the new name beside it ([`Status::Refreshed`]). A pair that fails is used from the old
//!   folder for that start ([`Outcome::usable`]) and tried again at the next one.
//! - [`env_os`] reads `ARCALO_<name>` and falls back to `ANNALO_<name>`.
//! - [`legacy`] gives the old spelling of a marker or file name (`.arcalo-update` →
//!   `.annalo-update`) for readers that look for both.
//!
//! The credential store's entries are copied in the shell (`secrets.rs`), which owns the store.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, IoAt, Result, copy_file};
use crate::{tr, trf};

/// The app identifier from 1.15 on (folders, Windows toasts, macOS bundle id).
pub const IDENTIFIER: &str = "de.mousewerk.arcalo";
/// The app identifier of 1.14 and earlier.
pub const LEGACY_IDENTIFIER: &str = "app.annalo.desktop";
/// Service name of the entries in the credential store from 1.15 on.
pub const CREDENTIAL_SERVICE: &str = "Arcalo";
/// Service name of the credential store's entries of 1.14 and earlier (read as a fallback; the
/// entries are not deleted in 1.15).
pub const LEGACY_CREDENTIAL_SERVICE: &str = "Annalo";
/// Prefix of the environment variables.
pub const ENV_PREFIX: &str = "ARCALO_";
/// Prefix of the environment variables of 1.14 and earlier.
pub const LEGACY_ENV_PREFIX: &str = "ANNALO_";
/// The lower-case name in markers and file names (`.arcalo-update`).
const NAME: &str = "arcalo";
const LEGACY_NAME: &str = "annalo";

/// The old spelling of a marker or file name: `.arcalo-update` → `.annalo-update`.
pub fn legacy(name: &str) -> String {
    name.replace(NAME, LEGACY_NAME)
}

/// The variable `name` (`ARCALO_DATA_DIR`), or its old spelling (`ANNALO_DATA_DIR`) when only
/// that is set.
pub fn env_os(name: &str) -> Option<OsString> {
    std::env::var_os(name).or_else(|| legacy_env(name).and_then(std::env::var_os))
}

/// [`env_os`] as text (`None` when not set or not Unicode).
pub fn env(name: &str) -> Option<String> {
    env_os(name).and_then(|v| v.into_string().ok())
}

/// `ARCALO_X` → `ANNALO_X`.
pub fn legacy_env(name: &str) -> Option<String> {
    name.strip_prefix(ENV_PREFIX).map(|rest| format!("{LEGACY_ENV_PREFIX}{rest}"))
}

// ------------------------------------------------------------------ folders

/// Marker written into a folder of the new identifier once its copy is complete.
pub const MARKER: &str = ".arcalo-migrated.json";
/// Suffix of the staging folder next to the new folder while a copy runs.
const STAGING_SUFFIX: &str = ".migrating";

/// How a folder of the old identifier is taken over.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Copied, verified and kept (data, config, WebView storage).
    Copy,
    /// Renamed when the new folder does not exist yet; nothing happens otherwise (caches).
    Move,
}

/// A folder of the old identifier and the one of the new identifier beside it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pair {
    pub from: PathBuf,
    pub to: PathBuf,
    pub mode: Mode,
}

/// The pairs under the base folders (`%APPDATA%`, `~/.local/share`, `~/Library/Caches`, …):
/// `<base>/app.annalo.desktop` → `<base>/de.mousewerk.arcalo`. A base listed twice (the data and
/// config folders are one on Windows and macOS) counts once, with [`Mode::Copy`] winning.
pub fn pairs(bases: &[(PathBuf, Mode)]) -> Vec<Pair> {
    let mut out: Vec<Pair> = Vec::new();
    for (base, mode) in bases {
        let from = base.join(LEGACY_IDENTIFIER);
        match out.iter_mut().find(|p| p.from == from) {
            Some(p) if *mode == Mode::Copy => p.mode = Mode::Copy,
            Some(_) => {}
            None => out.push(Pair { from, to: base.join(IDENTIFIER), mode: *mode }),
        }
    }
    out
}

/// What happened to one pair.
#[derive(Debug, Clone, PartialEq)]
pub enum Status {
    /// No folder of the old identifier.
    Nothing,
    /// Copied at an earlier start (the marker is there).
    Done,
    /// Copied now: files and bytes; `kept`: entries the new folder already had (left as they were).
    Copied { files: usize, bytes: u64, kept: Vec<String> },
    /// The older version wrote to the old workspace after the copy: copied again; the folder of
    /// the new name from before is kept at `aside`.
    Refreshed { files: usize, aside: PathBuf },
    /// A cache folder renamed.
    Moved,
    /// Not taken over; the old folder is used for now (see [`Outcome::usable`]).
    Failed(String),
}

#[derive(Debug, Clone, PartialEq)]
pub struct Outcome {
    pub pair: Pair,
    pub status: Status,
}

impl Outcome {
    /// The folder to use at this start: the old one only when its copy failed.
    pub fn usable(&self) -> &Path {
        match self.status {
            Status::Failed(_) if self.pair.from.is_dir() => &self.pair.from,
            _ => &self.pair.to,
        }
    }
}

/// What the marker records.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
struct Record {
    from: String,
    at: String,
    /// The old workspace's database at the time of the copy (to notice an older version
    /// writing to it afterwards); `None` when the old folder held no workspace.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    stamp: Option<Vec<FileStamp>>,
}

/// Size and modification time of one file of the database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileStamp {
    name: String,
    len: u64,
    modified_ns: u128,
}

/// The database files of a workspace in `dir` (main file and WAL), `None` without a workspace.
fn db_stamp(dir: &Path) -> Option<Vec<FileStamp>> {
    let main = crate::datadir::DB_FILE;
    if !dir.join(main).is_file() {
        return None;
    }
    let names = [main.to_owned(), format!("{main}-wal")];
    let stamp = names
        .iter()
        .filter_map(|name| {
            let meta = fs::metadata(dir.join(name)).ok()?;
            let modified_ns = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_nanos());
            Some(FileStamp { name: name.clone(), len: meta.len(), modified_ns })
        })
        .collect();
    Some(stamp)
}

fn read_record(to: &Path) -> Option<Record> {
    serde_json::from_slice(&fs::read(to.join(MARKER)).ok()?).ok()
}

fn write_record(to: &Path, record: &Record) -> Result<()> {
    let path = to.join(MARKER);
    let tmp = to.join(format!("{MARKER}.part"));
    fs::write(&tmp, serde_json::to_vec_pretty(record)?).and_then(|()| fs::rename(&tmp, &path)).at(&path)
}

/// Takes over every pair (see the module docs). Never deletes or changes anything in the old
/// folders.
pub fn migrate(pairs: &[Pair]) -> Vec<Outcome> {
    pairs.iter().map(|p| Outcome { pair: p.clone(), status: migrate_one(p) }).collect()
}

fn migrate_one(pair: &Pair) -> Status {
    if !pair.from.is_dir() {
        return Status::Nothing;
    }
    if pair.mode == Mode::Move {
        if pair.to.exists() {
            return Status::Done;
        }
        return match fs::rename(&pair.from, &pair.to) {
            Ok(()) => Status::Moved,
            // A cache: starting without it is fine.
            Err(e) => Status::Failed(Error::file(&pair.from, e).to_string()),
        };
    }
    let mut aside = None;
    if let Some(record) = read_record(&pair.to) {
        let now = db_stamp(&pair.from);
        if record.stamp.is_none() || record.stamp == now {
            return Status::Done;
        }
        // The old workspace changed after the copy: an older version ran on it again.
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let target = pair.to.with_file_name(format!("{IDENTIFIER}.{stamp}"));
        if let Err(e) = fs::rename(&pair.to, &target) {
            return Status::Failed(Error::file(&pair.to, e).to_string());
        }
        aside = Some(target);
    }
    match copy_verified(&pair.from, &pair.to) {
        Ok((files, bytes, kept)) => match aside {
            Some(aside) => Status::Refreshed { files, aside },
            None => Status::Copied { files, bytes, kept },
        },
        Err(e) => {
            // The folder set aside goes back, so nothing is lost.
            if let Some(a) = aside
                && !pair.to.exists()
            {
                let _ = fs::rename(&a, &pair.to);
            }
            Status::Failed(e.to_string())
        }
    }
}

/// Copies `from` into a staging folder, verifies it, renames it to `to` (or merges it into an
/// existing `to` without overwriting) and writes the marker. Returns files, bytes and the
/// entries `to` already had.
fn copy_verified(from: &Path, to: &Path) -> Result<(usize, u64, Vec<String>)> {
    let staging = to.with_file_name(format!("{IDENTIFIER}{STAGING_SUFFIX}"));
    if staging.exists() {
        fs::remove_dir_all(&staging).at(&staging)?; // left over from an interrupted start
    }
    let before = db_stamp(from);
    let result = (|| {
        let (files, bytes) = copy_tree(from, &staging, Path::new(""))?;
        verify(from, &staging, Path::new(""))?;
        if db_stamp(from) != before {
            return Err(Error::State(
                tr!(
                    "Die Datenbank wurde während des Kopierens geändert (läuft noch eine ältere Version?)",
                    "The database changed while it was copied (is an older version still running?)"
                )
                .into(),
            ));
        }
        let kept = commit(&staging, to)?;
        write_record(
            to,
            &Record { from: from.display().to_string(), at: chrono::Utc::now().to_rfc3339(), stamp: before.clone() },
        )?;
        Ok((files, bytes, kept))
    })();
    let _ = fs::remove_dir_all(&staging);
    result
}

/// Renames the staging folder to `to`; when `to` exists already (something created it before the
/// copy), each entry is moved in only where `to` has none.
fn commit(staging: &Path, to: &Path) -> Result<Vec<String>> {
    if !to.exists() {
        fs::rename(staging, to).at(to)?;
        return Ok(Vec::new());
    }
    let mut kept = Vec::new();
    for entry in fs::read_dir(staging).at(staging)?.flatten() {
        let target = to.join(entry.file_name());
        if target.exists() {
            kept.push(entry.file_name().to_string_lossy().into_owned());
        } else {
            fs::rename(entry.path(), &target).at(&target)?;
        }
    }
    Ok(kept)
}

/// WebView caches that are not copied (they are rebuilt): Chromium's (WebView2, below
/// `EBWebView`) and WebKitGTK's.
const SKIPPED: [&str; 12] = [
    "Cache",
    "Code Cache",
    "GPUCache",
    "DawnCache",
    "DawnGraphiteCache",
    "DawnWebGPUCache",
    "GraphiteDawnCache",
    "GrShaderCache",
    "ShaderCache",
    "Crashpad",
    "WebKitCache",
    "CacheStorage",
];

/// Whether the entry `name` below `rel` is left out of the copy: WebView caches (only inside the
/// WebView's own folders, never a user's folder of that name), staging folders and this marker.
fn skipped(rel: &Path, name: &str) -> bool {
    if rel.as_os_str().is_empty() && (name == MARKER || name.ends_with(STAGING_SUFFIX)) {
        return true;
    }
    let in_webview = rel.components().next().is_some_and(|c| c.as_os_str() == "EBWebView");
    let top_webkit = rel.as_os_str().is_empty() && matches!(name, "WebKitCache" | "CacheStorage");
    (in_webview && SKIPPED.contains(&name)) || top_webkit
}

/// Copies regular files and folders (symlinks are skipped). Returns files and bytes.
fn copy_tree(src: &Path, dst: &Path, rel: &Path) -> Result<(usize, u64)> {
    fs::create_dir_all(dst).at(dst)?;
    let (mut files, mut bytes) = (0, 0);
    for entry in fs::read_dir(src).at(src)?.flatten() {
        let name = entry.file_name();
        if skipped(rel, &name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type().at(entry.path())?;
        let to = dst.join(&name);
        if kind.is_dir() {
            let (f, b) = copy_tree(&entry.path(), &to, &rel.join(&name))?;
            files += f;
            bytes += b;
        } else if kind.is_file() {
            bytes += copy_file(&entry.path(), &to)?;
            files += 1;
        }
    }
    Ok((files, bytes))
}

/// Files compared byte for byte: everything at the top level (the database, `secrets.json`,
/// `location.json`, markers) and every file up to this size.
const COMPARE_BYTES: u64 = 1024 * 1024;

/// Every file of `src` is in `dst` with the same size; top-level and small files with the same
/// content.
fn verify(src: &Path, dst: &Path, rel: &Path) -> Result<()> {
    for entry in fs::read_dir(src).at(src)?.flatten() {
        let name = entry.file_name();
        if skipped(rel, &name.to_string_lossy()) {
            continue;
        }
        let kind = entry.file_type().at(entry.path())?;
        let copy = dst.join(&name);
        if kind.is_dir() {
            verify(&entry.path(), &copy, &rel.join(&name))?;
        } else if kind.is_file() {
            let len = entry.metadata().at(entry.path())?.len();
            let same = fs::metadata(&copy).is_ok_and(|m| m.len() == len)
                && ((!rel.as_os_str().is_empty() && len > COMPARE_BYTES) || same_content(&entry.path(), &copy)?);
            if !same {
                return Err(Error::State(trf!(
                    "Die Kopie von {} stimmt nicht mit dem Original überein",
                    "The copy of {} differs from the original",
                    entry.path().display()
                )));
            }
        }
    }
    Ok(())
}

fn same_content(a: &Path, b: &Path) -> Result<bool> {
    let (mut fa, mut fb) = (fs::File::open(a).at(a)?, fs::File::open(b).at(b)?);
    let (mut ba, mut bb) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = read_full(&mut fa, &mut ba).at(a)?;
        let m = read_full(&mut fb, &mut bb).at(b)?;
        if n != m || ba[..n] != bb[..m] {
            return Ok(false);
        }
        if n == 0 {
            return Ok(true);
        }
    }
}

fn read_full(f: &mut fs::File, buf: &mut [u8]) -> std::io::Result<usize> {
    let mut n = 0;
    while n < buf.len() {
        match f.read(&mut buf[n..])? {
            0 => break,
            k => n += k,
        }
    }
    Ok(n)
}

/// A line for the developer log about one pair (`None` when there was nothing to do).
pub fn describe(o: &Outcome) -> Option<String> {
    let (from, to) = (o.pair.from.display(), o.pair.to.display());
    Some(match &o.status {
        Status::Nothing | Status::Done => return None,
        Status::Copied { files, bytes, kept } if kept.is_empty() => {
            format!("{from} copied to {to} ({files} files, {bytes} bytes); the old folder is kept")
        }
        Status::Copied { files, bytes, kept } => format!(
            "{from} copied to {to} ({files} files, {bytes} bytes; kept what was there already: {}); the old folder is kept",
            kept.join(", ")
        ),
        Status::Refreshed { files, aside } => format!(
            "{from} was used by an older version after the copy: copied again ({files} files); the previous {to} is kept as {}",
            aside.display()
        ),
        Status::Moved => format!("{from} moved to {to}"),
        Status::Failed(e) => format!("{from} not taken over ({e}); it is used as it is for now"),
    })
}

/// The notice for the user after [`migrate`], if one is due: a data folder copied again or one
/// that could not be taken over (the first copy itself needs no notice).
pub fn notice(outcomes: &[Outcome]) -> Option<crate::datadir::Notice> {
    let workspace =
        |p: &Pair| p.from.join(crate::datadir::DB_FILE).is_file() || p.to.join(crate::datadir::DB_FILE).is_file();
    for o in outcomes.iter().filter(|o| o.pair.mode == Mode::Copy && workspace(&o.pair)) {
        match &o.status {
            Status::Failed(e) => {
                return Some(crate::datadir::Notice::titled(
                    "warning",
                    tr!("Datenordner nicht übernommen", "Data folder not taken over"),
                    trf!(
                        "Der Datenordner {} konnte nicht in den neuen Ordner {} kopiert werden ({e}). Arcalo arbeitet vorerst im bisherigen Ordner weiter und versucht es beim nächsten Start noch einmal.",
                        "The data folder {} could not be copied to the new folder {} ({e}). Arcalo keeps working in the previous folder for now and tries again at the next start.",
                        o.pair.from.display(),
                        o.pair.to.display()
                    ),
                ));
            }
            Status::Refreshed { aside, .. } => {
                return Some(crate::datadir::Notice::titled(
                    "info",
                    tr!("Daten der älteren Version übernommen", "Data of the older version taken over"),
                    trf!(
                        "Nach der Rückkehr zur älteren Version wurde dort weitergearbeitet: diese Daten wurden übernommen. Der Stand von vorher liegt unverändert in {}.",
                        "Work continued in the older version after going back to it: that data was taken over. The state from before is kept unchanged in {}.",
                        aside.display()
                    ),
                ));
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("arcalo-identity-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn put(path: &Path, body: &[u8]) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    /// A data folder as 1.14 left it on Linux (data, WebKitGTK storage and caches in one folder).
    fn layout_114(base: &Path) -> (PathBuf, i64) {
        let old = base.join(LEGACY_IDENTIFIER);
        fs::create_dir_all(&old).unwrap();
        let db = Database::open(old.join(crate::datadir::DB_FILE)).unwrap();
        let page = db.create_page(None, "Notiz aus 1.14", None).unwrap();
        db.save_page_content(page.id, "geschrieben mit 1.14").unwrap();
        drop(db);
        put(&old.join("attachments/bild.png"), &[1, 2, 3]);
        put(&old.join("backups/arcalo-pre-update-1.14.1-1.15.0.db"), b"SQLite format 3");
        put(&old.join("secrets.json"), br#"{"db_key":"00ff"}"#);
        put(&old.join(".annalo-update"), br#"{"version":"1.15.0"}"#);
        put(&old.join("localstorage/tauri_localhost_0.localstorage"), b"annalo.sidebar=true");
        put(&old.join("WebKitCache/Version 16/blob"), b"cache");
        put(&old.join("attachments/Cache/eigene.txt"), b"a folder of the user");
        put(&old.join("big/large.bin"), &vec![7u8; (COMPARE_BYTES + 10) as usize]);
        (old, page.id)
    }

    #[test]
    fn names_and_variables_have_their_old_spelling() {
        assert_eq!(legacy(".arcalo-update"), ".annalo-update");
        assert_eq!(legacy("data/.arcalo.lock"), "data/.annalo.lock");
        assert_eq!(legacy_env("ARCALO_DATA_DIR").as_deref(), Some("ANNALO_DATA_DIR"));
        assert_eq!(legacy_env("HOME"), None);
        // A variable of its own: only the old name is set in this process.
        let (new, old) = ("ARCALO_IDENTITY_TEST_ONLY", "ANNALO_IDENTITY_TEST_ONLY");
        assert_eq!(env(new), None);
        // SAFETY: no other test reads or writes these two variables.
        unsafe { std::env::set_var(old, "alt") };
        assert_eq!(env(new).as_deref(), Some("alt"), "the old name still works");
        unsafe { std::env::set_var(new, "neu") };
        assert_eq!(env(new).as_deref(), Some("neu"), "the new name wins");
        unsafe {
            std::env::remove_var(new);
            std::env::remove_var(old);
        }
    }

    #[test]
    fn pairs_are_per_base_folder_once() {
        let (a, b) = (PathBuf::from("/r"), PathBuf::from("/c"));
        let p = pairs(&[(a.clone(), Mode::Move), (a.clone(), Mode::Copy), (b.clone(), Mode::Move)]);
        assert_eq!(
            p,
            [
                Pair { from: a.join("app.annalo.desktop"), to: a.join("de.mousewerk.arcalo"), mode: Mode::Copy },
                Pair { from: b.join("app.annalo.desktop"), to: b.join("de.mousewerk.arcalo"), mode: Mode::Move },
            ]
        );
    }

    #[test]
    fn a_114_data_folder_is_copied_verified_and_kept() {
        let base = tmp("copy");
        let (old, id) = layout_114(&base);
        let pair = pairs(&[(base.clone(), Mode::Copy)]);
        let out = migrate(&pair);
        let Status::Copied { files, kept, .. } = &out[0].status else { panic!("{:?}", out[0].status) };
        assert!(*files >= 8 && kept.is_empty(), "{files} {kept:?}");
        let new = base.join(IDENTIFIER);
        assert_eq!(out[0].usable(), new);
        let db = Database::open(new.join(crate::datadir::DB_FILE)).unwrap();
        assert_eq!(db.page_doc(id).unwrap().content, "geschrieben mit 1.14");
        drop(db);
        for f in [
            "attachments/bild.png",
            "backups/arcalo-pre-update-1.14.1-1.15.0.db",
            "secrets.json",
            ".annalo-update",
            "localstorage/tauri_localhost_0.localstorage",
            "attachments/Cache/eigene.txt",
            "big/large.bin",
        ] {
            assert_eq!(fs::read(new.join(f)).unwrap(), fs::read(old.join(f)).unwrap(), "{f}");
        }
        assert!(!new.join("WebKitCache").exists(), "caches are rebuilt");
        assert!(new.join(MARKER).is_file());
        assert!(!base.join(format!("{IDENTIFIER}{STAGING_SUFFIX}")).exists(), "no staging folder left");
        // The old folder is untouched (an older version still finds everything).
        assert!(old.join(crate::datadir::DB_FILE).is_file() && old.join("WebKitCache/Version 16/blob").is_file());

        // Idempotent: the next start does nothing, and keeps what the new version wrote.
        fs::write(new.join("neu.txt"), b"1.15").unwrap();
        assert_eq!(migrate(&pair)[0].status, Status::Done);
        assert!(new.join("neu.txt").is_file());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn webview2_caches_are_left_out_but_its_storage_is_copied() {
        let base = tmp("webview2");
        let old = base.join(LEGACY_IDENTIFIER);
        put(&old.join("EBWebView/Default/Local Storage/leveldb/000003.log"), b"annalo.tabs");
        put(&old.join("EBWebView/Default/Cache/Cache_Data/data_0"), b"cache");
        put(&old.join("EBWebView/Default/Code Cache/js/index"), b"cache");
        let out = migrate(&pairs(&[(base.clone(), Mode::Copy)]));
        assert!(matches!(out[0].status, Status::Copied { .. }), "{:?}", out[0].status);
        let new = base.join(IDENTIFIER);
        assert!(new.join("EBWebView/Default/Local Storage/leveldb/000003.log").is_file());
        assert!(!new.join("EBWebView/Default/Cache").exists() && !new.join("EBWebView/Default/Code Cache").exists());
        assert_eq!(notice(&out), None, "no workspace: nothing to tell");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_config_folder_with_location_json_points_to_the_custom_data_folder() {
        let base = tmp("location");
        let custom = base.join("Daten auf D");
        crate::datadir::write_location(&base.join(LEGACY_IDENTIFIER), &custom).unwrap();
        fs::create_dir_all(&custom).unwrap();
        Database::open(custom.join(crate::datadir::DB_FILE)).unwrap();
        migrate(&pairs(&[(base.clone(), Mode::Copy)]));
        let start = crate::datadir::prepare(None, Some(&base.join(IDENTIFIER)), base.join(IDENTIFIER));
        assert_eq!(
            start,
            crate::datadir::Startup { dir: custom.clone(), notice: None },
            "the custom folder stays in use"
        );
        assert!(custom.join(crate::datadir::DB_FILE).is_file(), "and is not copied");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_new_folder_that_exists_already_is_merged_without_overwriting() {
        let base = tmp("merge");
        let (_, id) = layout_114(&base);
        let new = base.join(IDENTIFIER);
        put(&new.join("EBWebView/Default/x"), b"neu");
        put(&new.join("secrets.json"), b"{}");
        let out = migrate(&pairs(&[(base.clone(), Mode::Copy)]));
        let Status::Copied { kept, .. } = &out[0].status else { panic!("{:?}", out[0].status) };
        assert_eq!(kept, &["secrets.json"]);
        assert_eq!(fs::read(new.join("secrets.json")).unwrap(), b"{}", "never overwritten");
        assert_eq!(
            Database::open(new.join(crate::datadir::DB_FILE)).unwrap().page_doc(id).unwrap().content,
            "geschrieben mit 1.14"
        );
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn a_failed_copy_keeps_using_the_old_folder_and_is_tried_again() {
        let base = tmp("fail");
        let (old, _) = layout_114(&base);
        // The new folder's place is taken by a file: nothing can be put there.
        fs::write(base.join(IDENTIFIER), b"im Weg").unwrap();
        let pair = pairs(&[(base.clone(), Mode::Copy)]);
        let out = migrate(&pair);
        assert!(matches!(out[0].status, Status::Failed(_)), "{:?}", out[0].status);
        assert_eq!(out[0].usable(), old);
        let n = notice(&out).unwrap();
        assert_eq!(n.kind, "warning");
        assert!(old.join(crate::datadir::DB_FILE).is_file());
        assert!(!base.join(format!("{IDENTIFIER}{STAGING_SUFFIX}")).exists());
        fs::remove_file(base.join(IDENTIFIER)).unwrap();
        assert!(matches!(migrate(&pair)[0].status, Status::Copied { .. }), "the next start copies");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn work_in_the_older_version_after_a_rollback_is_taken_over_again() {
        let base = tmp("rollback");
        let (old, id) = layout_114(&base);
        let pair = pairs(&[(base.clone(), Mode::Copy)]);
        migrate(&pair);
        let new = base.join(IDENTIFIER);
        fs::write(new.join("von-1.15.txt"), b"x").unwrap();
        // Back on 1.14 (the rollback reinstalled it): it writes to the old folder.
        std::thread::sleep(std::time::Duration::from_millis(20));
        let db = Database::open(old.join(crate::datadir::DB_FILE)).unwrap();
        db.save_page_content(id, "weiter in 1.14").unwrap();
        db.checkpoint().unwrap();
        drop(db);
        let out = migrate(&pair);
        let Status::Refreshed { aside, .. } = &out[0].status else { panic!("{:?}", out[0].status) };
        assert!(aside.join("von-1.15.txt").is_file(), "the state of 1.15 is kept");
        assert_eq!(
            Database::open(new.join(crate::datadir::DB_FILE)).unwrap().page_doc(id).unwrap().content,
            "weiter in 1.14"
        );
        assert_eq!(notice(&out).unwrap().kind, "info");
        assert_eq!(migrate(&pair)[0].status, Status::Done, "once");
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn caches_are_moved_only_when_the_new_one_is_missing() {
        let base = tmp("cache");
        put(&base.join(LEGACY_IDENTIFIER).join("WebKit/x"), b"c");
        let pair = pairs(&[(base.clone(), Mode::Move)]);
        assert_eq!(migrate(&pair)[0].status, Status::Moved);
        assert!(base.join(IDENTIFIER).join("WebKit/x").is_file());
        assert_eq!(migrate(&pair)[0].status, Status::Nothing);
        let _ = fs::remove_dir_all(&base);
    }
}
