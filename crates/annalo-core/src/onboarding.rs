//! First start: the intro and the setup that follows it (UI `ui/src/onboarding/`).
//!
//! A fresh install plays the intro and asks the setup questions; every answer is written to the
//! settings right away. Workspaces that existed before the intro (an upgrade to 1.6) are not
//! interrupted: they get a one-time hint („Neu in 1.6: Einführung ansehen“) instead.
//!
//! Which case applies is decided once, at the first start of a version with the intro, and kept
//! in the meta row `onboarding.first_seen` (`fresh` or `existing`; `reset` after „Einrichtung
//! zurücksetzen“: the intro plays again, but the workspace is not treated as a new one). Completing (or closing) the
//! setup stores `onboarding.completed_version` and `completed_at` in the settings, so the flags
//! travel with the workspace (also in portable mode, where the database sits next to the exe).

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::settings::Settings;

/// The intro that is shown now. Stored as `completed_version` when the setup is done.
pub const INTRO_VERSION: &str = "1.6.0";

const FIRST_SEEN: &str = "onboarding.first_seen";
const WHATS_NEW: &str = "onboarding.whats_new";

/// Settings part: which intro was completed and when (RFC 3339, UTC).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct OnboardingState {
    pub completed_version: Option<String>,
    pub completed_at: Option<String>,
}

/// What the main window shows at start.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OnboardingStatus {
    /// Play the intro and the setup (fresh install, not completed).
    pub intro: bool,
    /// Show the one-time hint about the intro (an upgraded workspace).
    pub whats_new: bool,
    /// The workspace existed before the intro (upgrade) or its setup was reset: the intro keeps
    /// the stored choices (no guess of the language from the OS).
    pub existing: bool,
    pub completed_version: Option<String>,
    pub completed_at: Option<String>,
}

/// The decision, as a pure function: `first_seen` is the recorded classification, `hint_shown`
/// whether the hint was shown before, `skip` the test switch (`ANNALO_SKIP_ONBOARDING`).
pub fn decide(state: &OnboardingState, first_seen: Option<&str>, hint_shown: bool, skip: bool) -> (bool, bool) {
    if skip || state.completed_version.is_some() {
        return (false, false);
    }
    match first_seen {
        Some("existing") => (false, !hint_shown),
        _ => (true, false),
    }
}

impl Database {
    /// Records once whether this workspace existed before the intro: stored settings, the
    /// answered welcome choice, pages or projects. Runs at start, before anything is saved.
    pub fn onboarding_classify(&self) -> Result<()> {
        if self.meta_get(FIRST_SEEN)?.is_some() {
            return Ok(());
        }
        let settings_row: bool =
            self.conn().query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'app')", [], |r| r.get(0))?;
        let existing = settings_row
            || self.meta_get("onboarded")?.is_some()
            || !self.list_projects()?.is_empty()
            || !self.page_tree()?.is_empty();
        self.meta_set(FIRST_SEEN, if existing { "existing" } else { "fresh" })
    }

    pub fn onboarding_status(&self, skip: bool) -> Result<OnboardingStatus> {
        let state = self.load_settings()?.onboarding;
        let first_seen = self.meta_get(FIRST_SEEN)?;
        let hint_shown = self.meta_get(WHATS_NEW)?.is_some();
        let (intro, whats_new) = decide(&state, first_seen.as_deref(), hint_shown, skip);
        Ok(OnboardingStatus {
            intro,
            whats_new,
            existing: matches!(first_seen.as_deref(), Some("existing" | "reset")),
            completed_version: state.completed_version,
            completed_at: state.completed_at,
        })
    }

    /// The setup was finished or closed: the intro is not shown again by itself.
    pub fn onboarding_complete(&self, now: DateTime<Utc>) -> Result<Settings> {
        let mut s = self.load_settings()?;
        s.onboarding = OnboardingState {
            completed_version: Some(INTRO_VERSION.into()),
            completed_at: Some(now.to_rfc3339_opts(SecondsFormat::Secs, true)),
        };
        self.save_settings(&s)?;
        Ok(s)
    }

    /// The hint for an upgraded workspace was shown (it is shown once).
    pub fn onboarding_hint_shown(&self) -> Result<()> {
        self.meta_set(WHATS_NEW, INTRO_VERSION)
    }

    /// „Einrichtung zurücksetzen“: only the flags. The next start plays the intro again (with the
    /// stored settings prefilled); notes, settings and data stay as they are.
    pub fn onboarding_reset(&self) -> Result<Settings> {
        let mut s = self.load_settings()?;
        s.onboarding = OnboardingState::default();
        self.save_settings(&s)?;
        self.meta_set(FIRST_SEEN, "reset")?;
        self.conn()
            .execute("DELETE FROM settings WHERE key IN (?1, 'meta.onboarded')", [format!("meta.{WHATS_NEW}")])?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decide_covers_fresh_upgrade_done_and_skip() {
        let open = OnboardingState::default();
        let done = OnboardingState { completed_version: Some(INTRO_VERSION.into()), completed_at: None };
        assert_eq!(decide(&open, Some("fresh"), false, false), (true, false));
        assert_eq!(decide(&open, None, false, false), (true, false));
        assert_eq!(decide(&open, Some("reset"), true, false), (true, false));
        assert_eq!(decide(&open, Some("existing"), false, false), (false, true));
        assert_eq!(decide(&open, Some("existing"), true, false), (false, false));
        assert_eq!(decide(&done, Some("fresh"), false, false), (false, false));
        assert_eq!(decide(&open, Some("fresh"), false, true), (false, false));
    }

    #[test]
    fn a_fresh_workspace_plays_the_intro_until_completed() {
        let db = Database::open_in_memory().unwrap();
        db.onboarding_classify().unwrap();
        let st = db.onboarding_status(false).unwrap();
        assert!(st.intro && !st.whats_new && !st.existing);
        // A page created meanwhile does not turn it into an upgrade: the decision is kept.
        db.create_page(None, "Notiz", None).unwrap();
        db.onboarding_classify().unwrap();
        assert!(db.onboarding_status(false).unwrap().intro);
        let now = "2026-09-25T08:00:00Z".parse().unwrap();
        let s = db.onboarding_complete(now).unwrap();
        assert_eq!(s.onboarding.completed_version.as_deref(), Some(INTRO_VERSION));
        assert_eq!(s.onboarding.completed_at.as_deref(), Some("2026-09-25T08:00:00Z"));
        let st = db.onboarding_status(false).unwrap();
        assert!(!st.intro && !st.whats_new);
        assert_eq!(st.completed_version.as_deref(), Some(INTRO_VERSION));
    }

    #[test]
    fn an_existing_workspace_gets_the_hint_once_and_reset_brings_the_intro_back() {
        let db = Database::open_in_memory().unwrap();
        let mut s = db.load_settings().unwrap();
        s.daily_target_hours = 7.5;
        db.save_settings(&s).unwrap();
        db.meta_set("onboarded", "1").unwrap();
        db.onboarding_classify().unwrap();
        let st = db.onboarding_status(false).unwrap();
        assert!(!st.intro && st.whats_new && st.existing);
        db.onboarding_hint_shown().unwrap();
        assert!(!db.onboarding_status(false).unwrap().whats_new);
        // Test runs switch everything off.
        assert!(!db.onboarding_status(true).unwrap().intro);

        db.onboarding_complete(Utc::now()).unwrap();
        let s = db.onboarding_reset().unwrap();
        assert_eq!(s.onboarding, OnboardingState::default());
        // Other settings stay; only the flags are gone.
        assert_eq!(s.daily_target_hours, 7.5);
        assert_eq!(db.meta_get("onboarded").unwrap(), None);
        let st = db.onboarding_status(false).unwrap();
        assert!(st.intro && st.existing && !st.whats_new);
    }

    #[test]
    fn pages_or_projects_count_as_an_existing_workspace() {
        let db = Database::open_in_memory().unwrap();
        db.create_page(None, "Alt", None).unwrap();
        db.onboarding_classify().unwrap();
        assert!(db.onboarding_status(false).unwrap().existing);
    }
}
