//! What the updater remembers between starts, outside the database (a rollback restores the
//! database, and these facts must survive it): skipped and bad versions, „Später erinnern“,
//! the health of the last starts, and the rollback record of the last update.
//!
//! The health check: every start writes „starting <version>“ early, and „healthy“ once the
//! window has loaded on an opened and migrated database. A start that finds „starting“ of its
//! own version counts a failed start. After [`FAILURES_BEFORE_ROLLBACK`] failed starts in a
//! row of a version that an update just installed, the next start offers to return to the
//! previous version.

use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Folder (in the data folder) with the downloads, the state and the rollback copy.
pub const UPDATES_DIR: &str = "updates";
const STATE_FILE: &str = "state.json";
/// Written at every start, see the module docs.
pub const HEALTH_FILE: &str = ".arcalo-health";
/// Folder with the copy of the previous version and the record.
pub const ROLLBACK_DIR: &str = "rollback";
const RECORD_FILE: &str = "rollback.json";

/// Failed starts in a row before the rollback is offered.
pub const FAILURES_BEFORE_ROLLBACK: u32 = 2;

fn parse(v: &str) -> Option<semver::Version> {
    semver::Version::parse(v.trim().trim_start_matches('v')).ok()
}

fn same(a: &str, b: &str) -> bool {
    parse(a).is_some_and(|x| parse(b).is_some_and(|y| x.cmp_precedence(&y).is_eq()))
}

fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UpdateState {
    /// „Diese Version überspringen“: not offered again (a newer one is).
    pub skipped: Option<String>,
    /// „Später erinnern“: no hint and no install before this time.
    pub remind_after: Option<DateTime<Utc>>,
    /// Versions that did not start and were rolled back: never offered again.
    pub bad_versions: Vec<String>,
    /// The version whose „Neu in …“ was shown after its update.
    pub whats_new_seen: Option<String>,
}

impl UpdateState {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(UPDATES_DIR).join(STATE_FILE)
    }

    pub fn load(data_dir: &Path) -> UpdateState {
        std::fs::read_to_string(Self::path(data_dir))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        write_atomic(&Self::path(data_dir), &serde_json::to_string_pretty(self).unwrap_or_default())
    }

    /// Records a version that did not start (after a rollback).
    pub fn mark_bad(&mut self, version: &str) {
        let v = version.trim().trim_start_matches('v').to_string();
        if !self.bad_versions.iter().any(|b| same(b, &v)) {
            self.bad_versions.push(v);
        }
    }
}

/// What to do with the version a feed offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    Offer,
    UpToDate,
    /// Above the organization's `PinnedVersion`.
    AbovePin,
    /// Rolled back after failed starts.
    Bad,
    Skipped,
    /// „Später erinnern“ is still running.
    Snoozed,
}

/// Whether `offered` is offered to a copy running `current`.
pub fn verdict(current: &str, offered: &str, pinned: Option<&str>, state: &UpdateState, now: DateTime<Utc>) -> Verdict {
    if !crate::update::is_newer(current, offered) {
        return Verdict::UpToDate;
    }
    let off = parse(offered);
    if let (Some(pin), Some(off)) = (pinned.and_then(parse), &off)
        && off.cmp_precedence(&pin).is_gt()
    {
        return Verdict::AbovePin;
    }
    if state.bad_versions.iter().any(|b| same(b, offered)) {
        return Verdict::Bad;
    }
    // The skipped version, and anything not newer than it.
    if let (Some(skip), Some(off)) = (state.skipped.as_deref().and_then(parse), &off)
        && !off.cmp_precedence(&skip).is_gt()
    {
        return Verdict::Skipped;
    }
    if state.remind_after.is_some_and(|t| t > now) {
        return Verdict::Snoozed;
    }
    Verdict::Offer
}

// ------------------------------------------------------------------ health

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Health {
    version: String,
    healthy: bool,
    #[serde(default)]
    failures: u32,
}

/// What the start found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StartCheck {
    /// The last start of this version was healthy (or it is the first one).
    Normal,
    /// Earlier starts of this version did not get far; not enough to offer a rollback (or no
    /// rollback possible).
    Failed { failures: u32 },
    /// Offer to return from `to` (this version) to `from`.
    OfferRollback { from: String, to: String, failures: u32 },
}

/// Called early at every start: counts the failed starts of `version` and writes „starting“.
pub fn begin_start(data_dir: &Path, version: &str, record: Option<&RollbackRecord>) -> StartCheck {
    let path = data_dir.join(HEALTH_FILE);
    // The marker of 1.14 and earlier (old name) counts until the new one is written.
    let legacy = data_dir.join(crate::identity::legacy(HEALTH_FILE));
    let read = |p: &Path| std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str::<Health>(&t).ok());
    let last = read(&path).or_else(|| read(&legacy));
    let _ = std::fs::remove_file(&legacy);
    let failures = match &last {
        Some(h) if same(&h.version, version) && !h.healthy => h.failures + 1,
        _ => 0,
    };
    let health = Health { version: version.to_string(), healthy: false, failures };
    let _ = write_atomic(&path, &serde_json::to_string(&health).unwrap_or_default());
    match record {
        Some(r) if failures >= FAILURES_BEFORE_ROLLBACK && same(&r.to, version) => {
            StartCheck::OfferRollback { from: r.from.clone(), to: r.to.clone(), failures }
        }
        _ if failures > 0 => StartCheck::Failed { failures },
        _ => StartCheck::Normal,
    }
}

/// The window loaded on an opened and migrated database.
pub fn mark_healthy(data_dir: &Path, version: &str) {
    let health = Health { version: version.to_string(), healthy: true, failures: 0 };
    let _ = write_atomic(&data_dir.join(HEALTH_FILE), &serde_json::to_string(&health).unwrap_or_default());
}

/// „Nein“ to the rollback: counting starts again (the question comes back after more failures).
pub fn reset_failures(data_dir: &Path, version: &str) {
    let health = Health { version: version.to_string(), healthy: false, failures: 0 };
    let _ = write_atomic(&data_dir.join(HEALTH_FILE), &serde_json::to_string(&health).unwrap_or_default());
}

// ------------------------------------------------------------------ rollback record

/// What kind of copy of the previous version was kept.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CopyKind {
    /// No copy (a platform or install where none can be made): only the database returns.
    None,
    /// Windows per-user install: the program folder, copied.
    WindowsDir,
    /// macOS: the previous `.app` as `.tar.gz`.
    MacApp,
    /// Linux: the previous AppImage file.
    AppImage,
    /// Test runs (debug builds): nothing to put back.
    Test,
}

/// Written before an update is installed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RollbackRecord {
    pub from: String,
    pub to: String,
    /// The database backup `pre-update-<from>-<to>`.
    pub backup: Option<PathBuf>,
    /// The copy of the previous version.
    pub copy: Option<PathBuf>,
    pub kind: CopyKind,
    pub created: DateTime<Utc>,
}

impl RollbackRecord {
    pub fn path(data_dir: &Path) -> PathBuf {
        data_dir.join(ROLLBACK_DIR).join(RECORD_FILE)
    }

    pub fn load(data_dir: &Path) -> Option<RollbackRecord> {
        std::fs::read_to_string(Self::path(data_dir)).ok().and_then(|t| serde_json::from_str(&t).ok())
    }

    pub fn save(&self, data_dir: &Path) -> std::io::Result<()> {
        write_atomic(&Self::path(data_dir), &serde_json::to_string_pretty(self).unwrap_or_default())
    }

    /// Removes the record and the copy (after a rollback, or when a newer update replaces it).
    pub fn clear(data_dir: &Path) {
        let dir = data_dir.join(ROLLBACK_DIR);
        let _ = std::fs::remove_dir_all(dir);
    }

    /// The record belongs to the version running now (the update installed it).
    pub fn applies_to(&self, current: &str) -> bool {
        same(&self.to, current)
    }

    /// „Zur vorherigen Version zurückkehren“ is possible: the record is for this version and
    /// the copy of the previous one (and the database backup) still exist.
    pub fn can_return(&self, current: &str) -> bool {
        let backup = self.backup.as_ref().is_some_and(|b| b.is_file());
        let copy = match self.kind {
            CopyKind::Test => true,
            CopyKind::None => false,
            _ => self.copy.as_ref().is_some_and(|c| c.exists()),
        };
        self.applies_to(current) && backup && copy
    }
}

/// Folder for the copy of `version`.
pub fn copy_dir(data_dir: &Path, version: &str) -> PathBuf {
    data_dir.join(ROLLBACK_DIR).join(version.trim().trim_start_matches('v'))
}

/// File name of the database backup written before the update from `from` to `to`.
pub fn pre_update_backup_name(from: &str, to: &str) -> String {
    let v = |s: &str| {
        s.trim().trim_start_matches('v').replace(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-'), "_")
    };
    format!("{}pre-update-{}-{}.db", crate::backup::PREFIX, v(from), v(to))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Duration;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("arcalo-upstate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn pin_skip_bad_and_remind_later() {
        let now = Utc::now();
        let mut s = UpdateState::default();
        assert_eq!(verdict("1.9.0", "1.9.1", None, &s, now), Verdict::Offer);
        assert_eq!(verdict("1.9.1", "1.9.1", None, &s, now), Verdict::UpToDate);
        assert_eq!(verdict("1.9.0", "1.9.5", Some("1.9.4"), &s, now), Verdict::AbovePin, "never above the pin");
        assert_eq!(verdict("1.9.0", "1.9.4", Some("1.9.4"), &s, now), Verdict::Offer, "the pinned version itself");
        assert_eq!(verdict("1.9.0", "1.9.1", Some("garbage"), &s, now), Verdict::Offer, "an invalid pin is no pin");
        s.skipped = Some("1.9.1".into());
        assert_eq!(verdict("1.9.0", "1.9.1", None, &s, now), Verdict::Skipped);
        assert_eq!(verdict("1.9.0", "1.9.2", None, &s, now), Verdict::Offer, "the next newer version shows again");
        s.skipped = None;
        s.remind_after = Some(now + Duration::days(1));
        assert_eq!(verdict("1.9.0", "1.9.1", None, &s, now), Verdict::Snoozed);
        assert_eq!(verdict("1.9.0", "1.9.1", None, &s, now + Duration::days(2)), Verdict::Offer, "tomorrow is over");
        s.remind_after = None;
        s.mark_bad("v1.9.1");
        s.mark_bad("1.9.1");
        assert_eq!(s.bad_versions, ["1.9.1"]);
        assert_eq!(verdict("1.9.0", "1.9.1", None, &s, now), Verdict::Bad);
        assert_eq!(verdict("1.9.0", "1.9.2", None, &s, now), Verdict::Offer);
    }

    #[test]
    fn state_survives_a_restart() {
        let dir = tmp("state");
        assert_eq!(UpdateState::load(&dir), UpdateState::default());
        let s = UpdateState { skipped: Some("2.0.0".into()), bad_versions: vec!["1.9.1".into()], ..Default::default() };
        s.save(&dir).unwrap();
        assert_eq!(UpdateState::load(&dir), s);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn record(dir: &Path, kind: CopyKind) -> RollbackRecord {
        let backup = dir.join(pre_update_backup_name("1.9.0", "1.9.1"));
        std::fs::write(&backup, b"db").unwrap();
        RollbackRecord {
            from: "1.9.0".into(),
            to: "1.9.1".into(),
            backup: Some(backup),
            copy: None,
            kind,
            created: Utc::now(),
        }
    }

    #[test]
    fn two_failed_starts_offer_the_rollback() {
        let dir = tmp("health");
        let r = record(&dir, CopyKind::Test);
        // First start of the new version.
        assert_eq!(begin_start(&dir, "1.9.1", Some(&r)), StartCheck::Normal);
        // It crashed before „healthy“: the next start counts one failure.
        assert_eq!(begin_start(&dir, "1.9.1", Some(&r)), StartCheck::Failed { failures: 1 });
        // Twice in a row: the third start asks.
        assert_eq!(
            begin_start(&dir, "1.9.1", Some(&r)),
            StartCheck::OfferRollback { from: "1.9.0".into(), to: "1.9.1".into(), failures: 2 }
        );
        // „Nein“: counting starts again.
        reset_failures(&dir, "1.9.1");
        assert_eq!(begin_start(&dir, "1.9.1", Some(&r)), StartCheck::Failed { failures: 1 });
        // A healthy start clears it.
        mark_healthy(&dir, "1.9.1");
        assert_eq!(begin_start(&dir, "1.9.1", Some(&r)), StartCheck::Normal);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn failures_without_a_record_or_of_another_version_offer_nothing() {
        let dir = tmp("health2");
        for _ in 0..3 {
            begin_start(&dir, "1.9.1", None);
        }
        assert_eq!(begin_start(&dir, "1.9.1", None), StartCheck::Failed { failures: 3 });
        let mut r = record(&dir, CopyKind::Test);
        r.to = "1.9.2".into();
        assert_eq!(
            begin_start(&dir, "1.9.1", Some(&r)),
            StartCheck::Failed { failures: 4 },
            "the record is for another version"
        );
        // Another version (the old one started again): its count starts at zero.
        assert_eq!(begin_start(&dir, "1.9.0", None), StartCheck::Normal);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn return_needs_the_record_the_backup_and_the_copy() {
        let dir = tmp("record");
        let mut r = record(&dir, CopyKind::AppImage);
        assert!(!r.can_return("1.9.1"), "no copy");
        let copy = copy_dir(&dir, "1.9.0").join("Arcalo.AppImage");
        std::fs::create_dir_all(copy.parent().unwrap()).unwrap();
        std::fs::write(&copy, b"elf").unwrap();
        r.copy = Some(copy);
        assert!(r.can_return("1.9.1"));
        assert!(!r.can_return("1.9.0"), "only the version the update installed");
        assert!(!RollbackRecord { kind: CopyKind::None, ..r.clone() }.can_return("1.9.1"));
        r.save(&dir).unwrap();
        assert_eq!(RollbackRecord::load(&dir), Some(r.clone()));
        RollbackRecord::clear(&dir);
        assert_eq!(RollbackRecord::load(&dir), None);
        assert!(!copy_dir(&dir, "1.9.0").exists());
        assert_eq!(pre_update_backup_name("v1.9.0", "1.9.1-beta.1"), "arcalo-pre-update-1.9.0-1.9.1-beta.1.db");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
