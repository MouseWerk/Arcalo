//! Application settings, stored as JSON in the workspace database.
//! Secrets (the API keys of the AI providers) are deliberately not part of this struct;
//! the desktop shell keeps them in the OS credential store.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};

use crate::ai::metrics::{PriceRule, default_price_rules, normalize_price_rules};
use crate::ai::provider::{self, AiProvider, LEGACY_ID};
use crate::ai::router::RouterConfig;
use crate::db::Database;
use crate::error::Result;
use crate::gitsync::GitSyncSettings;
use crate::network::NetworkSettings;
use crate::prefs::{
    AiPrefs, AppearancePrefs, EditorPrefs, LocalePrefs, NotesPrefs, NotificationPrefs, PrivacyPrefs, ROUNDING_STEPS,
    StartOpen, StartPrefs, TimePrefs,
};
use crate::tracking::Thresholds;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Root URL of the LiteLLM proxy, e.g. `https://llm.example.com`. Kept in step with the
    /// address of the provider [`LEGACY_ID`] for older versions and scripts (see [`Settings::sync_legacy`]).
    pub litellm_base_url: String,
    /// AI providers in order of preference; keys live in the credential store, one per id.
    pub providers: Vec<AiProvider>,
    /// Provider and model per tier.
    pub router: RouterConfig,
    /// Route by prompt complexity; when off, `router.standard_model` is always used.
    pub auto_route: bool,
    /// Embedding model for semantic search; `None` = keyword search only.
    pub embedding_model: Option<String>,
    /// Provider of the embedding model; `""` = the first provider.
    pub embedding_provider: String,
    /// Prices per 1M tokens for providers that do not report costs (LiteLLM does; local
    /// providers are free).
    pub prices: Vec<PriceRule>,
    /// Extra instructions appended to the assistant's system prompt.
    pub assistant_instructions: String,
    pub thresholds: Thresholds,
    /// Pauses longer than this are offered for subtraction when a timer stops.
    pub idle_threshold_minutes: u64,
    /// SAP personnel number for CATS exports.
    pub pernr: Option<String>,
    /// `NP-8801/1020` or `NP-8801` → Jira issue key.
    pub jira_issue_map: HashMap<String, String>,
    /// `system`, `light` or `dark`.
    pub theme: String,
    /// Open today's daily note on start.
    pub open_daily_on_start: bool,
    /// Target working hours per workday; days below it are flagged in the timesheet.
    pub daily_target_hours: f64,
    /// Workdays as ISO weekday numbers (1 = Monday … 7 = Sunday).
    pub workdays: Vec<u32>,
    /// Folder for automatic backups; `None` = `backups` in the data folder.
    pub backup_dir: Option<String>,
    /// Number of backups kept; older ones are deleted.
    pub backup_keep: usize,
    /// After every backup, write the workspace as Markdown files (+ time entries as CSV).
    pub markdown_mirror: bool,
    /// Folder of the Markdown mirror; `None` = `markdown` in the backup folder.
    pub markdown_mirror_dir: Option<String>,
    /// Template page for new daily notes; `None` = built-in sections.
    pub daily_template: Option<i64>,
    /// Closing the main window hides it to the tray instead of quitting.
    pub close_to_tray: bool,
    /// End-of-day reminder as `HH:MM` (local time); `None` = off.
    pub reminder_time: Option<String>,
    /// Global shortcut for the quick-capture window, e.g. `Ctrl+Shift+Space`.
    pub capture_shortcut: String,
    /// Global shortcut that brings up the command palette, e.g. `Ctrl+Shift+K`; `None` or `""` = off
    /// (the default: Ctrl+K works inside the app).
    pub palette_shortcut: Option<String>,
    /// Look for a new release at start and every few hours (only in builds with an update
    /// key). Updates are never installed without the user's click.
    pub auto_update_check: bool,
    /// Developer log (Settings → Protokoll): also write debug lines (AI requests, syncs, backups).
    pub dev_log_verbose: bool,
    /// Push the Markdown mirror to a Git remote (the access token lives in the credential store).
    pub git_sync: GitSyncSettings,
    /// Proxy, extra root CA and timeouts (the proxy password lives in the credential store).
    pub network: NetworkSettings,
    pub appearance: AppearancePrefs,
    pub editor: EditorPrefs,
    pub notes: NotesPrefs,
    pub time: TimePrefs,
    pub ai: AiPrefs,
    pub notifications: NotificationPrefs,
    pub privacy: PrivacyPrefs,
    pub start: StartPrefs,
    pub locale: LocalePrefs,
    /// In-app shortcuts that differ from the defaults: command id → `Ctrl+Shift+D` (`""` = off).
    pub keymap: BTreeMap<String, String>,
    /// Global shortcut of the quick-search window (Spotlight-like), e.g. `Ctrl+Shift+O`; `""` = off.
    pub search_shortcut: String,
    /// Widgets of the start page (and of new tabs).
    pub dashboard: Dashboard,
    /// Links at the top of the sidebar (web pages, tools, folders).
    pub quick_links: Vec<QuickLink>,
}

/// A link in the sidebar: a web address, `mailto:` or a local folder or file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QuickLink {
    pub name: String,
    pub url: String,
    /// Name of a page icon (`globe`, `folder`, …).
    #[serde(default)]
    pub icon: String,
}

/// Where a quick link leads.
#[derive(Debug, Clone, PartialEq)]
pub enum LinkTarget {
    /// Opened by the default app for the scheme (browser, mail, Teams, …).
    Url(String),
    /// A local folder or file, opened in the file manager or its app.
    Path(String),
}

impl QuickLink {
    /// A web address (with or without scheme), another scheme such as `mailto:`, or a local path.
    pub fn target(&self) -> LinkTarget {
        let u = self.url.trim();
        let lower = u.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("file://") {
            let rest = &u[u.len() - rest.len()..];
            // file:///C:/x → C:/x, file:///home/x → /home/x
            let path = if rest.len() > 3 && rest.as_bytes()[2] == b':' { &rest[1..] } else { rest };
            return LinkTarget::Path(path.replace("%20", " "));
        }
        let drive = u.len() > 2 && u.as_bytes()[1] == b':' && matches!(u.as_bytes()[2], b'\\' | b'/');
        if drive || u.starts_with("\\\\") || u.starts_with('/') || u.starts_with("~/") {
            return LinkTarget::Path(u.to_owned());
        }
        let has_scheme = lower
            .split_once(':')
            .is_some_and(|(s, _)| !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)));
        if has_scheme { LinkTarget::Url(u.to_owned()) } else { LinkTarget::Url(format!("https://{u}")) }
    }
}

/// At most this many links: the sidebar is for the handful used every day.
pub const MAX_QUICK_LINKS: usize = 40;

/// Trimmed links with an address; the name falls back to the address.
pub fn normalize_quick_links(links: Vec<QuickLink>) -> Vec<QuickLink> {
    links
        .into_iter()
        .filter_map(|l| {
            let url = l.url.trim().to_owned();
            if url.is_empty() {
                return None;
            }
            let name = match l.name.trim() {
                "" => url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_owned(),
                n => n.to_owned(),
            };
            Some(QuickLink { name, url, icon: l.icon.trim().to_owned() })
        })
        .take(MAX_QUICK_LINKS)
        .collect()
}

/// Width of a dashboard widget in the start page's grid: one, two or all four columns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum WidgetSize {
    #[serde(rename = "s")]
    Small,
    #[serde(rename = "l")]
    Large,
    /// Unknown sizes (e.g. from a newer version) fall back to medium.
    #[serde(rename = "m", other)]
    Medium,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Widget {
    /// Stable id within the dashboard (drag & drop, keys).
    pub id: String,
    /// One of [`WIDGET_KINDS`]; unknown kinds are dropped by [`Dashboard::normalized`].
    pub kind: String,
    pub size: WidgetSize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Dashboard {
    pub widgets: Vec<Widget>,
    /// Scratch text of the „Notiz“ widget.
    pub note: String,
}

/// Widget kinds of the start page: Heute, Woche, Budgets, Zuletzt bearbeitet, Lesezeichen,
/// Timer, Notiz, Kalender, Fokus.
pub const WIDGET_KINDS: [&str; 9] =
    ["today", "week", "budgets", "recent", "favorites", "timer", "note", "calendar", "focus"];

/// At most this many widgets are kept.
pub const MAX_WIDGETS: usize = 24;

/// Longest scratch note kept (characters).
pub const MAX_NOTE_CHARS: usize = 20_000;

impl Default for Dashboard {
    fn default() -> Self {
        let w = |kind: &str, size| Widget { id: kind.into(), kind: kind.into(), size };
        Dashboard {
            widgets: vec![
                w("today", WidgetSize::Medium),
                w("week", WidgetSize::Medium),
                w("timer", WidgetSize::Small),
                w("budgets", WidgetSize::Small),
                w("recent", WidgetSize::Medium),
            ],
            note: String::new(),
        }
    }
}

impl Dashboard {
    /// Drops unknown kinds, gives every widget a unique non-empty id, caps the count and the note.
    pub fn normalized(mut self) -> Self {
        let mut seen = std::collections::HashSet::new();
        self.widgets.retain(|w| WIDGET_KINDS.contains(&w.kind.as_str()));
        self.widgets.truncate(MAX_WIDGETS);
        for w in &mut self.widgets {
            let base = if w.id.trim().is_empty() { w.kind.clone() } else { w.id.trim().to_owned() };
            let mut id = base.clone();
            let mut n = 2;
            while !seen.insert(id.clone()) {
                id = format!("{base}-{n}");
                n += 1;
            }
            w.id = id;
        }
        if self.note.chars().count() > MAX_NOTE_CHARS {
            self.note = self.note.chars().take(MAX_NOTE_CHARS).collect();
        }
        self
    }
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            litellm_base_url: DEFAULT_LITELLM_URL.into(),
            providers: vec![AiProvider::litellm(DEFAULT_LITELLM_URL)],
            router: RouterConfig::default(),
            auto_route: true,
            embedding_model: None,
            embedding_provider: LEGACY_ID.into(),
            prices: default_price_rules(),
            assistant_instructions: String::new(),
            thresholds: Thresholds::default(),
            idle_threshold_minutes: 5,
            pernr: None,
            jira_issue_map: HashMap::new(),
            theme: "system".into(),
            open_daily_on_start: false,
            daily_target_hours: 8.0,
            workdays: vec![1, 2, 3, 4, 5],
            backup_dir: None,
            backup_keep: 14,
            markdown_mirror: true,
            markdown_mirror_dir: None,
            daily_template: None,
            close_to_tray: cfg!(windows),
            reminder_time: Some("17:30".into()),
            capture_shortcut: DEFAULT_CAPTURE_SHORTCUT.into(),
            palette_shortcut: None,
            auto_update_check: true,
            dev_log_verbose: false,
            git_sync: GitSyncSettings::default(),
            search_shortcut: DEFAULT_SEARCH_SHORTCUT.into(),
            dashboard: Dashboard::default(),
            quick_links: vec![],
            network: NetworkSettings::default(),
            appearance: AppearancePrefs::default(),
            editor: EditorPrefs::default(),
            notes: NotesPrefs::default(),
            time: TimePrefs::default(),
            ai: AiPrefs::default(),
            notifications: NotificationPrefs::default(),
            privacy: PrivacyPrefs::default(),
            start: StartPrefs::default(),
            locale: LocalePrefs::default(),
            keymap: BTreeMap::new(),
        }
    }
}

/// Address of the LiteLLM proxy in fresh settings.
const DEFAULT_LITELLM_URL: &str = "http://localhost:4000";

impl Settings {
    /// Keeps `litellm_base_url` and the provider [`LEGACY_ID`] in step. Older versions and
    /// scripts only know the old field: when it changed since `previous` and the provider's
    /// address did not, the old field wins; otherwise the provider's address is copied into it.
    pub fn sync_legacy(&mut self, previous: &Settings) {
        let old = |s: &Settings| s.providers.iter().find(|p| p.id == LEGACY_ID).map(|p| p.base_url.clone());
        let before = old(previous);
        let url = self.litellm_base_url.trim().trim_end_matches('/').to_owned();
        let Some(p) = self.providers.iter_mut().find(|p| p.id == LEGACY_ID) else { return };
        if url != previous.litellm_base_url.trim().trim_end_matches('/')
            && before.as_deref() == Some(p.base_url.as_str())
        {
            p.base_url = url;
        }
        self.litellm_base_url = p.base_url.clone();
    }

    /// Checks and cleans the AI providers, fills tiers without a provider and cleans the price
    /// table. Used when saving.
    pub fn normalize_ai(&mut self) -> Result<()> {
        self.providers = provider::normalize(std::mem::take(&mut self.providers))?;
        if let Some(first) = self.providers.first().map(|p| p.id.clone()) {
            self.router.fill_providers(&first);
            if self.embedding_provider.trim().is_empty() {
                self.embedding_provider = first;
            }
        }
        self.embedding_provider = self.embedding_provider.trim().to_owned();
        self.prices = normalize_price_rules(std::mem::take(&mut self.prices));
        if let Some(p) = self.providers.iter().find(|p| p.id == LEGACY_ID) {
            self.litellm_base_url = p.base_url.clone();
        }
        Ok(())
    }

    /// Clamps numbers to their ranges and replaces unusable values with defaults. Used when
    /// saving and importing; loading keeps what is stored.
    pub fn normalize(&mut self) {
        let d = Settings::default();
        let a = &mut self.appearance;
        a.accent = crate::prefs::normalize_accent(&a.accent).unwrap_or(d.appearance.accent);
        a.ui_scale = a.ui_scale.clamp(90, 125);
        a.theme_light = crate::prefs::normalize_theme_id(&a.theme_light, &d.appearance.theme_light);
        a.theme_dark = crate::prefs::normalize_theme_id(&a.theme_dark, &d.appearance.theme_dark);
        a.custom_themes = crate::prefs::normalize_custom_themes(std::mem::take(&mut a.custom_themes));
        let e = &mut self.editor;
        e.autosave_ms = e.autosave_ms.clamp(250, 3000);
        e.tab_size = e.tab_size.clamp(2, 8);
        e.hover_delay_ms = e.hover_delay_ms.clamp(0, 3000);
        e.default_icon = e.default_icon.take().map(|i| i.trim().to_owned()).filter(|i| !i.is_empty());
        e.inbox_title = e.inbox_title.trim().to_owned();
        if e.inbox_title.is_empty() {
            e.inbox_title = d.editor.inbox_title;
        }
        let n = &mut self.notes;
        n.daily_folder = n.daily_folder.trim().to_owned();
        if n.daily_folder.is_empty() {
            n.daily_folder = d.notes.daily_folder;
        }
        n.trash_retention_days = n.trash_retention_days.clamp(7, 365);
        n.version_interval_minutes = n.version_interval_minutes.clamp(5, 60);
        n.max_versions = n.max_versions.clamp(5, 500);
        let t = &mut self.time;
        if !ROUNDING_STEPS.contains(&t.rounding.step_minutes) {
            t.rounding.step_minutes = 0;
        }
        t.rounding.min_minutes = t.rounding.min_minutes.min(240);
        t.default_leistungsart = std::mem::take(&mut t.default_leistungsart)
            .into_iter()
            .map(|(k, v)| (k.trim().to_owned(), v.trim().to_uppercase()))
            .filter(|(k, v)| !k.is_empty() && !v.is_empty())
            .collect();
        t.export_file_pattern = t.export_file_pattern.trim().to_owned();
        if t.export_file_pattern.is_empty() {
            t.export_file_pattern = d.time.export_file_pattern;
        }
        let ai = &mut self.ai;
        ai.temperature = if ai.temperature.is_finite() { ai.temperature.clamp(0.0, 2.0) } else { d.ai.temperature };
        ai.max_tokens = ai.max_tokens.filter(|m| *m > 0).map(|m| m.clamp(16, 200_000));
        ai.monthly_cost_limit_usd = ai.monthly_cost_limit_usd.filter(|l| l.is_finite() && *l > 0.0);
        if let Some(p) = &mut ai.inline_presets {
            p.retain(|x| !x.label.trim().is_empty() && !x.instruction.trim().is_empty());
        }
        ai.meeting_template = ai.meeting_template.take().filter(|t| !t.trim().is_empty());
        let known = crate::ai::tools::definitions();
        ai.allowed_tools.retain(|t| known.iter().any(|d| d["function"]["name"] == t.as_str()));
        ai.allowed_tools.dedup();
        let nt = &mut self.notifications;
        for (v, def) in
            [(&mut nt.quiet_from, &d.notifications.quiet_from), (&mut nt.quiet_to, &d.notifications.quiet_to)]
        {
            *v = match crate::desktop::parse_hhmm(v.trim()) {
                Some(t) => t.format("%H:%M").to_string(),
                None => def.clone(),
            };
        }
        self.keymap = std::mem::take(&mut self.keymap)
            .into_iter()
            .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
            .filter(|(k, _)| !k.is_empty())
            .collect();
        // Kept for older versions, which read only this flag.
        self.open_daily_on_start = self.start.open == StartOpen::Daily;
    }

    /// The settings of one section reset to their defaults (`Abschnitt zurücksetzen`).
    /// Unknown sections are an error.
    pub fn reset_section(&mut self, section: &str) -> Result<()> {
        let d = Settings::default();
        match section {
            "network" => self.network = d.network,
            "appearance" => {
                // Custom themes are the user's work, not a setting: they stay.
                let custom = std::mem::take(&mut self.appearance.custom_themes);
                self.appearance = AppearancePrefs { custom_themes: custom, ..d.appearance };
                self.theme = d.theme;
            }
            "editor" => self.editor = d.editor,
            "notes" => {
                self.notes = d.notes;
                self.daily_template = d.daily_template;
            }
            "time" => {
                self.time = d.time;
                self.idle_threshold_minutes = d.idle_threshold_minutes;
                self.daily_target_hours = d.daily_target_hours;
                self.workdays = d.workdays;
                self.thresholds = d.thresholds;
            }
            "ai" => {
                self.ai = d.ai;
                self.auto_route = d.auto_route;
                self.assistant_instructions = d.assistant_instructions;
                self.router.standard_threshold = d.router.standard_threshold;
                self.router.reasoning_threshold = d.router.reasoning_threshold;
                self.prices = d.prices;
            }
            "notifications" => {
                self.notifications = d.notifications;
                self.reminder_time = d.reminder_time;
            }
            "privacy" => {
                self.privacy = d.privacy;
                self.router.private_markers = d.router.private_markers;
            }
            "start" => {
                self.start = d.start;
                self.open_daily_on_start = d.open_daily_on_start;
            }
            "locale" => self.locale = d.locale,
            "keyboard" => self.keymap = d.keymap,
            other => return Err(crate::error::Error::State(format!("Unbekannter Abschnitt „{other}“"))),
        }
        Ok(())
    }
}

/// Ctrl+Alt+… is AltGr on German keyboards, so the default avoids it.
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_CAPTURE_SHORTCUT: &str = "Ctrl+Shift+Space";
/// macOS: Command is the primary modifier (⌃Space and ⌘Space switch input source/Spotlight).
#[cfg(target_os = "macos")]
pub const DEFAULT_CAPTURE_SHORTCUT: &str = "Cmd+Shift+Space";

/// Quick search. Not Ctrl+Shift+F: that is the sidebar search inside the app.
#[cfg(not(target_os = "macos"))]
pub const DEFAULT_SEARCH_SHORTCUT: &str = "Ctrl+Shift+O";
#[cfg(target_os = "macos")]
pub const DEFAULT_SEARCH_SHORTCUT: &str = "Cmd+Shift+O";

/// The former default palette shortcut. It opened the Windows window menu, so it is now off
/// by default; [`Database::migrate_palette_default`] clears it from saved settings once.
const OLD_PALETTE_DEFAULT: &str = "Alt+Space";

const KEY: &str = "app";

impl Database {
    pub fn load_settings(&self) -> Result<Settings> {
        let raw: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
        let mut s: Settings = match raw {
            Some(json) => Self::parse_settings(&json)?,
            None => Settings::default(),
        };
        s.dashboard = s.dashboard.normalized();
        Ok(s)
    }

    /// Parses stored settings JSON; settings from before the start preferences keep
    /// „Tagesnotiz beim Start öffnen“ (`open_daily_on_start` → `start.open = daily`).
    pub fn parse_settings(json: &str) -> Result<Settings> {
        let value: serde_json::Value = serde_json::from_str(json)?;
        let mut s: Settings = serde_json::from_value(value.clone())?;
        if value.get("start").is_none() && s.open_daily_on_start {
            s.start.open = StartOpen::Daily;
        }
        // Settings from before AI providers: the LiteLLM server becomes the one provider, its
        // token stays where it is (the credential of the provider `litellm`).
        if value.get("providers").is_none() {
            s.providers = vec![AiProvider::litellm(&s.litellm_base_url)];
            s.router.fill_providers(LEGACY_ID);
            s.embedding_provider = LEGACY_ID.into();
        }
        Ok(s)
    }

    pub fn save_settings(&self, s: &Settings) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![KEY, serde_json::to_string(s)?],
        )?;
        Ok(())
    }

    /// Earlier versions saved `Alt+Space` as the palette shortcut with any settings change,
    /// so an explicit choice cannot be told apart: switch it off once.
    pub fn migrate_palette_default(&self) -> Result<()> {
        const FLAG: &str = "palette_default_off";
        if self.meta_get(FLAG)?.is_some() {
            return Ok(());
        }
        let raw: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
        if raw.is_some() {
            let mut s = self.load_settings()?;
            if s.palette_shortcut.as_deref() == Some(OLD_PALETTE_DEFAULT) {
                s.palette_shortcut = None;
                self.save_settings(&s)?;
            }
        }
        self.meta_set(FLAG, "1")
    }

    /// Annalo 1.3, once: Mica was on by default and washed out the sidebar behind bright
    /// desktops, so saved settings that still have it on (the old default) switch it off; the
    /// old default accent `indigo` becomes `theme` (the same color in the Annalo theme, and
    /// the matching accent in every other theme).
    pub fn migrate_appearance_defaults(&self) -> Result<()> {
        const FLAG: &str = "appearance_defaults_1_3";
        if self.meta_get(FLAG)?.is_some() {
            return Ok(());
        }
        let raw: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
        if raw.is_some() {
            let mut s = self.load_settings()?;
            let before = s.appearance.clone();
            s.appearance.mica = false;
            if s.appearance.accent == "indigo" {
                s.appearance.accent = crate::prefs::ACCENT_THEME.into();
            }
            if s.appearance != before {
                self.save_settings(&s)?;
            }
        }
        self.meta_set(FLAG, "1")
    }

    /// Settings saved before the activity feed allow the read-only `activity_log` tool once, so
    /// „Was habe ich am Dienstag gemacht?“ works without a trip to the settings.
    pub fn migrate_activity_tool(&self) -> Result<()> {
        const FLAG: &str = "activity_tool_on";
        if self.meta_get(FLAG)?.is_some() {
            return Ok(());
        }
        let raw: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
        if raw.is_some() {
            let mut s = self.load_settings()?;
            if !s.ai.allowed_tools.iter().any(|t| t == "activity_log") {
                s.ai.allowed_tools.push("activity_log".into());
                self.save_settings(&s)?;
            }
        }
        self.meta_set(FLAG, "1")
    }

    /// Internal flags kept next to the settings (e.g. whether sample data was seeded).
    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [format!("meta.{key}")], |r| r.get(0))
            .optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![format!("meta.{key}"), value],
        )?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_and_defaults_for_missing_fields() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.load_settings().unwrap(), Settings::default());
        let s = Settings {
            litellm_base_url: "https://llm.firma.de".into(),
            router: RouterConfig { standard_model: "gpt-firma".into(), ..Default::default() },
            ..Default::default()
        };
        db.save_settings(&s).unwrap();
        assert_eq!(db.load_settings().unwrap(), s);

        // Older settings JSON without newer fields still loads.
        db.conn().execute("UPDATE settings SET value = '{\"theme\":\"dark\"}'", []).unwrap();
        let loaded = db.load_settings().unwrap();
        assert_eq!(loaded.theme, "dark");
        assert_eq!(loaded.idle_threshold_minutes, 5);
        assert_eq!((loaded.backup_dir, loaded.backup_keep), (None, 14));
        assert_eq!((loaded.markdown_mirror, loaded.markdown_mirror_dir), (true, None), "mirror on by default");
        assert_eq!(loaded.reminder_time.as_deref(), Some("17:30"));
        assert_eq!(loaded.capture_shortcut, DEFAULT_CAPTURE_SHORTCUT);
        assert_eq!(loaded.palette_shortcut, None, "the palette shortcut is off by default");
        assert!(loaded.auto_update_check, "update checks are on by default");
        assert_eq!(loaded.git_sync, GitSyncSettings::default(), "git sync off by default");
        assert!(!loaded.git_sync.enabled && loaded.git_sync.branch == "main");
        // Partial git_sync objects fill the rest with defaults.
        db.conn()
            .execute("UPDATE settings SET value = '{\"git_sync\":{\"enabled\":true,\"mode\":\"hourly\"}}'", [])
            .unwrap();
        let gs = db.load_settings().unwrap().git_sync;
        assert!(gs.enabled && gs.mode == crate::gitsync::SyncMode::Hourly && gs.branch == "main");
        // An explicit null switches the reminder off.
        db.conn().execute("UPDATE settings SET value = '{\"reminder_time\":null}'", []).unwrap();
        assert_eq!(db.load_settings().unwrap().reminder_time, None);
        db.conn().execute("UPDATE settings SET value = '{\"palette_shortcut\":null}'", []).unwrap();
        assert_eq!(db.load_settings().unwrap().palette_shortcut, None);
    }

    #[test]
    fn litellm_settings_become_a_provider() {
        let db = Database::open_in_memory().unwrap();
        // Settings of version 1.2: one LiteLLM server, models per tier, no providers.
        let old = r##"{"litellm_base_url":"https://llm.firma.de","embedding_model":"firma-embed",
            "router":{"local_model":"firma-schnell","standard_model":"firma-standard","reasoning_model":"firma-reasoning",
            "standard_threshold":30,"reasoning_threshold":60,"private_markers":["#privat"]}}"##;
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [old]).unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!(s.providers.len(), 1);
        let p = &s.providers[0];
        assert_eq!(
            (p.id.as_str(), p.kind, p.base_url.as_str()),
            (LEGACY_ID, crate::ai::ProviderKind::Litellm, "https://llm.firma.de")
        );
        assert!(p.enabled && !p.local && !p.bypass_proxy);
        use crate::ai::router::{ModelRef, Tier};
        assert_eq!(s.router.tier_ref(Tier::Standard), ModelRef::new(LEGACY_ID, "firma-standard"));
        assert_eq!(s.router.tier_ref(Tier::Local), ModelRef::new(LEGACY_ID, "firma-schnell"));
        assert_eq!((s.embedding_provider.as_str(), s.embedding_model.as_deref()), (LEGACY_ID, Some("firma-embed")));
        assert_eq!(s.prices, default_price_rules(), "the built-in price table");
        // Saved and loaded again: unchanged.
        db.save_settings(&s).unwrap();
        assert_eq!(db.load_settings().unwrap(), s);
        // A list of providers is kept as it is, even an empty one.
        db.conn().execute(r#"UPDATE settings SET value = '{"providers":[]}'"#, []).unwrap();
        assert!(db.load_settings().unwrap().providers.is_empty());
    }

    #[test]
    fn the_old_url_field_and_the_provider_stay_in_step() {
        let prev = Settings::default();
        // A script (or an older version) changes only the old field: it wins.
        let mut s = Settings { litellm_base_url: "http://127.0.0.1:4999".into(), ..prev.clone() };
        s.sync_legacy(&prev);
        assert_eq!(s.providers[0].base_url, "http://127.0.0.1:4999");
        // The settings page changes the provider: the old field follows.
        let mut s = prev.clone();
        s.providers[0].base_url = "https://llm.firma.de".into();
        s.sync_legacy(&prev);
        assert_eq!(s.litellm_base_url, "https://llm.firma.de");
        // Without the LiteLLM provider the old field is left alone.
        let mut s = Settings { providers: vec![], litellm_base_url: "http://x".into(), ..prev.clone() };
        s.sync_legacy(&prev);
        assert_eq!(s.litellm_base_url, "http://x");
    }

    #[test]
    fn normalize_ai_fills_providers_and_checks_addresses() {
        let mut s = Settings::default();
        s.providers.insert(0, AiProvider::ollama("", "http://localhost:11434/"));
        s.router.local_provider = "".into();
        s.embedding_provider = " ".into();
        s.normalize_ai().unwrap();
        assert_eq!(s.providers[0].id, "ollama");
        assert_eq!(s.providers[0].base_url, "http://localhost:11434");
        assert_eq!((s.router.local_provider.as_str(), s.embedding_provider.as_str()), ("ollama", "ollama"));
        assert_eq!(s.router.standard_provider, LEGACY_ID, "set tiers are kept");
        s.providers[1].base_url = "llm.firma.de".into();
        assert!(s.normalize_ai().is_err());
    }

    #[test]
    fn quick_link_targets() {
        let t = |u: &str| QuickLink { name: String::new(), url: u.into(), icon: String::new() }.target();
        assert_eq!(t("jira.firma.de"), LinkTarget::Url("https://jira.firma.de".into()));
        assert_eq!(t("mailto:team@firma.de"), LinkTarget::Url("mailto:team@firma.de".into()));
        assert_eq!(t("msteams://teams.microsoft.com/l/x"), LinkTarget::Url("msteams://teams.microsoft.com/l/x".into()));
        assert_eq!(t("C:\\Projekte"), LinkTarget::Path("C:\\Projekte".into()));
        assert_eq!(t("\\\\server\\share"), LinkTarget::Path("\\\\server\\share".into()));
        assert_eq!(t("/home/anna/Dokumente"), LinkTarget::Path("/home/anna/Dokumente".into()));
        assert_eq!(t("file:///C:/Daten/Plan.xlsx"), LinkTarget::Path("C:/Daten/Plan.xlsx".into()));
        assert_eq!(t("file:///home/anna/a%20b"), LinkTarget::Path("/home/anna/a b".into()));
    }

    #[test]
    fn quick_links_are_trimmed_and_named() {
        let got = normalize_quick_links(vec![
            QuickLink { name: "  ".into(), url: " https://jira.firma.de/ ".into(), icon: "bug".into() },
            QuickLink { name: "Leer".into(), url: "  ".into(), icon: String::new() },
            QuickLink { name: " SAP ".into(), url: "C:\\SAP".into(), icon: String::new() },
        ]);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].name.as_str(), got[0].url.as_str()), ("jira.firma.de", "https://jira.firma.de/"));
        assert_eq!(got[1].name, "SAP");
    }

    #[test]
    fn dashboard_and_search_shortcut_default_for_old_settings() {
        let db = Database::open_in_memory().unwrap();
        // Settings saved before the dashboard and the quick search existed.
        db.save_settings(&Settings::default()).unwrap();
        db.conn().execute(r#"UPDATE settings SET value = '{"theme":"dark","capture_shortcut":"Alt+Q"}'"#, []).unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!(s.search_shortcut, DEFAULT_SEARCH_SHORTCUT);
        assert_eq!(s.dashboard, Dashboard::default());
        let kinds: Vec<_> = s.dashboard.widgets.iter().map(|w| w.kind.as_str()).collect();
        assert_eq!(kinds, ["today", "week", "timer", "budgets", "recent"]);
        assert!(kinds.iter().all(|k| WIDGET_KINDS.contains(k)));
        // An explicitly empty dashboard stays empty; "" switches the search shortcut off.
        db.conn()
            .execute(r#"UPDATE settings SET value = '{"search_shortcut":"","dashboard":{"widgets":[]}}'"#, [])
            .unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!((s.search_shortcut.as_str(), s.dashboard.widgets.len(), s.dashboard.note.as_str()), ("", 0, ""));
    }

    #[test]
    fn dashboard_is_normalized_on_load() {
        let db = Database::open_in_memory().unwrap();
        let json = r#"{"dashboard":{"note":"Hallo","widgets":[
            {"id":"a","kind":"today","size":"l"},
            {"id":"a","kind":"week","size":"s"},
            {"id":"","kind":"timer","size":"xl"},
            {"id":"x","kind":"wetter","size":"m"}]}}"#;
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [json]).unwrap();
        let d = db.load_settings().unwrap().dashboard;
        assert_eq!(d.note, "Hallo");
        let got: Vec<_> = d.widgets.iter().map(|w| (w.id.as_str(), w.kind.as_str(), w.size)).collect();
        assert_eq!(
            got,
            [
                ("a", "today", WidgetSize::Large),
                ("a-2", "week", WidgetSize::Small),
                ("timer", "timer", WidgetSize::Medium)
            ]
        );
        let many = Dashboard {
            widgets: (0..40)
                .map(|i| Widget { id: format!("w{i}"), kind: "note".into(), size: WidgetSize::Small })
                .collect(),
            note: "x".repeat(MAX_NOTE_CHARS + 5),
        }
        .normalized();
        assert_eq!((many.widgets.len(), many.note.len()), (MAX_WIDGETS, MAX_NOTE_CHARS));
        // Sizes serialize with their short names.
        let s =
            serde_json::to_string(&Widget { id: "t".into(), kind: "today".into(), size: WidgetSize::Small }).unwrap();
        assert_eq!(s, r#"{"id":"t","kind":"today","size":"s"}"#);
    }

    #[test]
    fn new_preferences_default_and_migrate() {
        let db = Database::open_in_memory().unwrap();
        // Settings of an older version: everything new gets its default.
        db.conn()
            .execute("INSERT INTO settings (key, value) VALUES ('app', '{\"theme\":\"light\",\"open_daily_on_start\":true}')", [])
            .unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!(s.start.open, StartOpen::Daily, "the old start flag carries over");
        assert_eq!(s.network, NetworkSettings::default());
        assert_eq!(s.network.mode, crate::network::ProxyMode::System);
        assert!(s.network.apply_to.ai && s.network.apply_to.git && !s.network.accept_invalid_certs);
        assert_eq!((s.editor.autosave_ms, s.editor.smart_quotes, s.editor.tab_size), (450, false, 4));
        assert_eq!(
            (s.notes.trash_retention_days, s.notes.version_interval_minutes, s.notes.max_versions),
            (30, 10, 50)
        );
        assert_eq!(s.notes.daily_folder, "Journal");
        assert_eq!(s.time.rounding, crate::prefs::Rounding::default());
        assert_eq!(s.time.rounding.apply(7), 7, "no rounding by default");
        assert_eq!(s.ai.allowed_tools, crate::prefs::WORKSPACE_TOOLS, "system tools are off by default");
        assert!(s.ai.citations && s.ai.streaming && s.ai.monthly_cost_limit_usd.is_none());
        assert!(s.notifications.end_of_day && !s.notifications.quiet_hours);
        assert!(s.privacy.read_open_page && !s.privacy.local_only);
        assert_eq!(s.locale.language, crate::prefs::Language::De);
        assert!(s.keymap.is_empty());
        // Once the start preferences exist, the old flag no longer decides.
        db.conn()
            .execute(
                "UPDATE settings SET value = '{\"open_daily_on_start\":true,\"start\":{\"open\":\"dashboard\"}}'",
                [],
            )
            .unwrap();
        assert_eq!(db.load_settings().unwrap().start.open, StartOpen::Dashboard);
        // Partial nested objects fill the rest.
        db.conn()
            .execute(
                "UPDATE settings SET value = '{\"time\":{\"rounding\":{\"step_minutes\":15}},\"network\":{\"mode\":\"manual\"}}'",
                [],
            )
            .unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!((s.time.rounding.step_minutes, s.time.hours_display), (15, crate::prefs::HoursDisplay::Decimal));
        assert_eq!((s.network.mode, s.network.timeout_secs), (crate::network::ProxyMode::Manual, 30));
    }

    #[test]
    fn normalize_clamps_and_reset_restores_sections() {
        let mut s = Settings::default();
        s.appearance.ui_scale = 300;
        s.appearance.accent = "#ABC".into();
        s.editor.autosave_ms = 10;
        s.notes.trash_retention_days = 1;
        s.notes.daily_folder = "  ".into();
        s.time.rounding.step_minutes = 7;
        s.time.default_leistungsart.insert(" NP-1 ".into(), " dev ".into());
        s.ai.temperature = 9.0;
        s.ai.allowed_tools = vec!["git".into(), "rm_rf".into()];
        s.notifications.quiet_from = "25:00".into();
        s.start.open = StartOpen::Daily;
        s.normalize();
        assert_eq!((s.appearance.ui_scale, s.appearance.accent.as_str()), (125, "#aabbcc"));
        assert_eq!((s.editor.autosave_ms, s.notes.trash_retention_days), (250, 7));
        assert_eq!(s.notes.daily_folder, "Journal");
        assert_eq!(s.time.rounding.step_minutes, 0);
        assert_eq!(s.time.default_leistungsart.get("NP-1").map(String::as_str), Some("DEV"));
        assert_eq!((s.ai.temperature, s.ai.allowed_tools.clone()), (2.0, vec!["git".to_owned()]));
        assert_eq!(s.notifications.quiet_from, "22:00");
        assert!(s.open_daily_on_start);
        s.prices.clear();
        s.providers.push(AiProvider::ollama("ollama", provider::OLLAMA_URL));
        s.reset_section("ai").unwrap();
        assert_eq!(s.ai, AiPrefs::default());
        assert_eq!(s.prices, default_price_rules(), "prices are AI preferences");
        assert_eq!(s.providers.len(), 2, "providers are connection settings and stay");
        s.reset_section("appearance").unwrap();
        assert_eq!(s.appearance, AppearancePrefs::default());
        assert!(s.reset_section("gibt-es-nicht").is_err());
    }

    #[test]
    fn old_alt_space_default_is_switched_off_once() {
        let db = Database::open_in_memory().unwrap();
        let s = Settings { palette_shortcut: Some(OLD_PALETTE_DEFAULT.into()), ..Default::default() };
        db.save_settings(&s).unwrap();
        db.migrate_palette_default().unwrap();
        assert_eq!(db.load_settings().unwrap().palette_shortcut, None);
        // Chosen again afterwards: kept.
        db.save_settings(&s).unwrap();
        db.migrate_palette_default().unwrap();
        assert_eq!(db.load_settings().unwrap().palette_shortcut.as_deref(), Some(OLD_PALETTE_DEFAULT));
        // Other shortcuts are never touched.
        let db = Database::open_in_memory().unwrap();
        let s = Settings { palette_shortcut: Some("Ctrl+Shift+K".into()), ..Default::default() };
        db.save_settings(&s).unwrap();
        db.migrate_palette_default().unwrap();
        assert_eq!(db.load_settings().unwrap(), s);
    }

    #[test]
    fn mica_and_old_accent_default_are_migrated_once() {
        let db = Database::open_in_memory().unwrap();
        // Settings saved by 1.2: Mica on (its old default) and the old default accent.
        let old = r#"{"theme":"dark","appearance":{"accent":"indigo","mica":true,"density":"compact"}}"#;
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [old]).unwrap();
        db.migrate_appearance_defaults().unwrap();
        let s = db.load_settings().unwrap();
        assert!(!s.appearance.mica);
        assert_eq!((s.appearance.accent.as_str(), s.appearance.density), ("theme", crate::prefs::Density::Compact));
        assert_eq!((s.theme.as_str(), s.appearance.theme_dark.as_str()), ("dark", "annalo-dark"));
        // Switched on again afterwards: kept.
        let mut on = s.clone();
        on.appearance.mica = true;
        on.appearance.accent = "indigo".into();
        db.save_settings(&on).unwrap();
        db.migrate_appearance_defaults().unwrap();
        assert_eq!(db.load_settings().unwrap(), on);
        // A chosen accent is never touched; a fresh workspace has nothing to migrate.
        let db = Database::open_in_memory().unwrap();
        let mut teal = Settings::default();
        teal.appearance.accent = "teal".into();
        db.save_settings(&teal).unwrap();
        db.migrate_appearance_defaults().unwrap();
        assert_eq!(db.load_settings().unwrap(), teal);
        let fresh = Database::open_in_memory().unwrap();
        fresh.migrate_appearance_defaults().unwrap();
        assert_eq!(fresh.load_settings().unwrap(), Settings::default());
    }

    #[test]
    fn appearance_reset_keeps_custom_themes_and_normalize_checks_them() {
        let mut s = Settings::default();
        let colors = crate::prefs::ThemeColors {
            background: "#FDF6E3".into(),
            surface: "#eee8d5".into(),
            text: "#073642".into(),
            muted: "#586e75".into(),
            border: "#d9d2c0".into(),
            accent: "#268bd2".into(),
            success: "#5f7a00".into(),
            warning: "#9a6500".into(),
            danger: "#c42e2b".into(),
        };
        s.appearance.custom_themes =
            vec![crate::prefs::CustomTheme { id: String::new(), name: " Sand ".into(), dark: false, colors }];
        s.appearance.theme_light = " ".into();
        s.appearance.theme_dark = "nord-dark".into();
        s.normalize();
        let t = &s.appearance.custom_themes[0];
        assert_eq!((t.id.as_str(), t.name.as_str(), t.colors.background.as_str()), ("custom-1", "Sand", "#fdf6e3"));
        assert_eq!(
            (s.appearance.theme_light.as_str(), s.appearance.theme_dark.as_str()),
            ("annalo-light", "nord-dark")
        );
        s.reset_section("appearance").unwrap();
        assert_eq!(s.appearance.theme_dark, "annalo-dark");
        assert_eq!(s.appearance.custom_themes.len(), 1);
    }

    #[test]
    fn the_activity_tool_is_allowed_once_for_older_settings() {
        let db = Database::open_in_memory().unwrap();
        let mut s = Settings::default();
        s.ai.allowed_tools = vec!["list_tasks".into()];
        db.save_settings(&s).unwrap();
        db.migrate_activity_tool().unwrap();
        assert_eq!(db.load_settings().unwrap().ai.allowed_tools, ["list_tasks", "activity_log"]);
        // Switched off afterwards: stays off.
        db.save_settings(&s).unwrap();
        db.migrate_activity_tool().unwrap();
        assert_eq!(db.load_settings().unwrap().ai.allowed_tools, ["list_tasks"]);
    }
}
