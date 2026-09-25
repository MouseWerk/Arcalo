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
    AiPrefs, AppearancePrefs, CapturePrefs, EditorPrefs, LocalePrefs, NotesPrefs, NotificationPrefs, PrivacyPrefs,
    ROUNDING_STEPS, StartOpen, StartPrefs, TimePrefs,
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
    /// Calendar sync: Outlook, ICS files and subscriptions (subscription URLs live in the credential store).
    pub calendar: crate::calsync::CalendarSettings,
    /// Quick capture: default target, inbox page, „Auswahl übernehmen“, auto-hide.
    pub capture: CapturePrefs,
    /// „E-Mail als Aufgabe / Notiz“: parent of mail notes, global shortcut, attachment default.
    pub mail: crate::mail::MailSettings,
}

/// A link in the ribbon: a web address, `mailto:`, a local folder or file, a program, or a
/// group of such links (shown as one icon that opens a list of them).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct QuickLink {
    pub name: String,
    /// The address or path (empty for a group).
    #[serde(default)]
    pub url: String,
    /// Name of a page icon (`globe`, `folder`, …).
    #[serde(default)]
    pub icon: String,
    /// Link, program or group; links saved before groups existed have none (= link).
    #[serde(default, skip_serializing_if = "LinkKind::is_link")]
    pub kind: LinkKind,
    /// A group's icon color (`blau`, `grün`, …; empty = like the other ribbon icons).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub color: String,
    /// A group's links and programs, in order (groups do not nest).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<QuickLink>,
}

/// What a ribbon entry is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkKind {
    /// A program, started directly.
    App,
    Group,
    /// Unknown kinds (e.g. from a newer version) open like a link.
    #[default]
    #[serde(other)]
    Link,
}

impl LinkKind {
    pub fn is_link(&self) -> bool {
        *self == LinkKind::Link
    }
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
            let path = if rest.starts_with('/') && rest.as_bytes().get(2) == Some(&b':') { &rest[1..] } else { rest };
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
/// At most this many links in one group.
pub const MAX_GROUP_ITEMS: usize = 60;

/// Group colors (the option colors of collections).
pub const LINK_COLORS: [&str; 9] = ["grau", "braun", "orange", "gelb", "grün", "blau", "lila", "rosa", "rot"];

/// A trimmed link or program with an address (the name falls back to the address).
fn normalize_link(l: QuickLink) -> Option<QuickLink> {
    let url = l.url.trim().to_owned();
    if url.is_empty() {
        return None;
    }
    let name = match l.name.trim() {
        "" => url.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/').to_owned(),
        n => n.to_owned(),
    };
    Some(QuickLink { name, url, icon: l.icon.trim().to_owned(), kind: l.kind, color: String::new(), items: vec![] })
}

/// Trimmed links with an address; the name falls back to the address. Groups keep their
/// (possibly empty) list; a group inside a group (only by hand-edited settings) hands its
/// links to the outer one.
pub fn normalize_quick_links(links: Vec<QuickLink>) -> Vec<QuickLink> {
    links
        .into_iter()
        .filter_map(|l| {
            if l.kind != LinkKind::Group {
                return normalize_link(l);
            }
            let items = l
                .items
                .into_iter()
                .flat_map(|i| if i.kind == LinkKind::Group { i.items } else { vec![i] })
                .filter(|i| i.kind != LinkKind::Group)
                .filter_map(normalize_link)
                .take(MAX_GROUP_ITEMS)
                .collect();
            let name = match l.name.trim() {
                "" => "Gruppe".to_owned(),
                n => n.to_owned(),
            };
            let color = l.color.trim();
            let color = if LINK_COLORS.contains(&color) { color.to_owned() } else { String::new() };
            Some(QuickLink {
                name,
                url: String::new(),
                icon: l.icon.trim().to_owned(),
                kind: LinkKind::Group,
                color,
                items,
            })
        })
        .take(MAX_QUICK_LINKS)
        .collect()
}

/// The link at `index` in the ribbon, or item `item` of the group there.
pub fn quick_link_at(links: &[QuickLink], index: usize, item: Option<usize>) -> Option<&QuickLink> {
    let top = links.get(index)?;
    match (item, top.kind) {
        (Some(i), LinkKind::Group) => top.items.get(i),
        (None, LinkKind::Group) | (Some(_), _) => None,
        (None, _) => Some(top),
    }
}

/// Width of a widget of the start page before 1.6: one, two or all four columns.
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

/// A widget of the start page before 1.6 (one list, three widths). The start page moves the
/// list onto a board of the grid ([`Dashboard::boards`]) with the same widgets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LegacyWidget {
    pub id: String,
    /// One of [`LEGACY_WIDGET_KINDS`]; unknown kinds are dropped by [`Dashboard::normalized`].
    pub kind: String,
    pub size: WidgetSize,
}

/// A widget on a board: its place in the grid (`x`, `w` in columns of [`GRID_COLUMNS`], `y`,
/// `h` in rows) and its own settings (their shape belongs to the UI).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Widget {
    /// Stable id within the board (keys, the text of a „Notiz“).
    pub id: String,
    /// One of [`WIDGET_KINDS`]; unknown kinds are dropped by [`Dashboard::normalized`].
    pub kind: String,
    #[serde(default)]
    pub x: u32,
    #[serde(default)]
    pub y: u32,
    #[serde(default = "one")]
    pub w: u32,
    #[serde(default = "one")]
    pub h: u32,
    /// Own title instead of the widget's name.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub title: String,
    #[serde(default, skip_serializing_if = "serde_json::Value::is_null")]
    pub config: serde_json::Value,
}

fn one() -> u32 {
    1
}

/// One start page („Heute“, „Projekte“, …), shown as a tab.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Board {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub widgets: Vec<Widget>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Dashboard {
    /// 2 since 1.6 (boards in a grid); 0 before.
    pub version: u32,
    pub boards: Vec<Board>,
    /// Id of the board shown.
    pub active: String,
    /// Texts of the „Notiz“ widgets, by widget id.
    pub notes: BTreeMap<String, String>,
    /// Before 1.6: the one widget list (`None`: the start page was never saved) …
    #[serde(skip_serializing_if = "Option::is_none")]
    pub widgets: Option<Vec<LegacyWidget>>,
    /// … and the text of its „Notiz“.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

/// Widget kinds of the grid (1.6): Heute, Termine, Aufgaben, Zeit diese Woche, Budget, Projekt,
/// Zuletzt bearbeitet, Lesezeichen, Angeheftet, Notiz, Seite einbetten, Abfrage, Aktivität,
/// Fokus, Links, Wochenvorschlag, Uhr, Tagesrückblick, KI-Vorschläge, Timer, Kalender.
/// The UI keeps the same list (`WIDGET_KINDS` in `lib/dashboard.ts`).
pub const WIDGET_KINDS: [&str; 21] = [
    "today",
    "agenda",
    "tasks",
    "week",
    "budget",
    "project",
    "recent",
    "favorites",
    "pinned",
    "note",
    "embed",
    "query",
    "activity",
    "focus",
    "links",
    "proposal",
    "clock",
    "review",
    "suggestions",
    "timer",
    "calendar",
];

/// Widget kinds of the list before 1.6.
pub const LEGACY_WIDGET_KINDS: [&str; 10] =
    ["today", "week", "budgets", "recent", "favorites", "timer", "note", "calendar", "focus", "agenda"];

/// At most this many boards …
pub const MAX_BOARDS: usize = 12;
/// … and widgets per board (and in the old list).
pub const MAX_WIDGETS: usize = 40;
/// Columns of the grid.
pub const GRID_COLUMNS: u32 = 12;
/// Tallest widget (rows).
const MAX_WIDGET_ROWS: u32 = 30;
/// Lowest row a widget may start in.
const MAX_ROW: u32 = 600;
/// Largest settings of one widget (bytes of JSON); bigger ones are dropped.
pub const MAX_WIDGET_CONFIG: usize = 16_000;

/// Longest scratch note kept (characters).
pub const MAX_NOTE_CHARS: usize = 20_000;

fn truncate_chars(s: &str, n: usize) -> String {
    if s.chars().count() > n { s.chars().take(n).collect() } else { s.to_owned() }
}

/// `raw` trimmed (or `fallback` when empty), with `-2`, `-3`, … when taken.
fn unique_id(seen: &mut std::collections::HashSet<String>, raw: &str, fallback: &str) -> String {
    let base = if raw.trim().is_empty() { fallback.to_owned() } else { raw.trim().to_owned() };
    let mut id = base.clone();
    let mut n = 2;
    while !seen.insert(id.clone()) {
        id = format!("{base}-{n}");
        n += 1;
    }
    id
}

impl Dashboard {
    /// Drops unknown kinds, gives boards and widgets unique non-empty ids, keeps every widget
    /// inside the grid, and caps the counts, the settings of a widget and the notes.
    pub fn normalized(mut self) -> Self {
        if let Some(list) = &mut self.widgets {
            list.retain(|w| LEGACY_WIDGET_KINDS.contains(&w.kind.as_str()));
            list.truncate(MAX_WIDGETS);
            let mut seen = std::collections::HashSet::new();
            for w in list.iter_mut() {
                w.id = unique_id(&mut seen, &w.id, &w.kind);
            }
        }
        self.note = truncate_chars(&self.note, MAX_NOTE_CHARS);
        self.boards.truncate(MAX_BOARDS);
        let mut board_ids = std::collections::HashSet::new();
        for (i, b) in self.boards.iter_mut().enumerate() {
            b.id = unique_id(&mut board_ids, &b.id, &format!("board-{}", i + 1));
            b.name = truncate_chars(b.name.trim(), 40);
            if b.name.is_empty() {
                b.name = "Board".into();
            }
            b.widgets.retain(|w| WIDGET_KINDS.contains(&w.kind.as_str()));
            b.widgets.truncate(MAX_WIDGETS);
            let mut seen = std::collections::HashSet::new();
            for w in &mut b.widgets {
                w.id = unique_id(&mut seen, &w.id, &w.kind);
                w.w = w.w.clamp(1, GRID_COLUMNS);
                w.h = w.h.clamp(1, MAX_WIDGET_ROWS);
                w.x = w.x.min(GRID_COLUMNS - w.w);
                w.y = w.y.min(MAX_ROW);
                w.title = truncate_chars(w.title.trim(), 60);
                let too_big = serde_json::to_string(&w.config).map_or(true, |s| s.len() > MAX_WIDGET_CONFIG);
                if !w.config.is_object() || too_big {
                    w.config = serde_json::Value::Null;
                }
            }
        }
        if !self.boards.is_empty() {
            self.version = self.version.max(2);
            if !self.boards.iter().any(|b| b.id == self.active) {
                self.active = self.boards[0].id.clone();
            }
            // Notes of widgets that are gone go with them.
            let ids: std::collections::HashSet<&str> =
                self.boards.iter().flat_map(|b| b.widgets.iter().map(|w| w.id.as_str())).collect();
            self.notes.retain(|k, _| ids.contains(k.as_str()));
        }
        self.notes.retain(|k, _| !k.trim().is_empty());
        while self.notes.len() > MAX_BOARDS * MAX_WIDGETS {
            let first = self.notes.keys().next().cloned().unwrap_or_default();
            self.notes.remove(&first);
        }
        for v in self.notes.values_mut() {
            *v = truncate_chars(v, MAX_NOTE_CHARS);
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
            calendar: crate::calsync::CalendarSettings::default(),
            capture: CapturePrefs::default(),
            mail: crate::mail::MailSettings::default(),
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
        let c = &mut self.capture;
        c.inbox_title = crate::notes::clean_title(&c.inbox_title);
        if c.inbox_title.is_empty() {
            c.inbox_title = d.capture.inbox_title;
        }
        c.selection_shortcut = c.selection_shortcut.trim().to_owned();
        c.auto_hide_ms = c.auto_hide_ms.min(10_000);
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
        for (v, def) in [
            (&mut nt.quiet_from, &d.notifications.quiet_from),
            (&mut nt.quiet_to, &d.notifications.quiet_to),
            (&mut nt.day_review_time, &d.notifications.day_review_time),
        ] {
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
        self.calendar = std::mem::take(&mut self.calendar).normalized();
        self.mail = std::mem::take(&mut self.mail).normalized();
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
        Ok(self.load_settings_checked()?.0)
    }

    /// [`Database::load_settings`] and the settings that could not be read (their defaults
    /// are used; see [`Database::parse_settings_lenient`]).
    pub fn load_settings_checked(&self) -> Result<(Settings, Vec<String>)> {
        let raw: Option<String> =
            self.conn().query_row("SELECT value FROM settings WHERE key = ?1", [KEY], |r| r.get(0)).optional()?;
        // Unchanged JSON (the usual case, e.g. on every page save) is not parsed again.
        if let (Some(json), Some((cached, s))) = (&raw, &*self.settings_cache.borrow())
            && json == cached
        {
            return Ok((s.clone(), vec![]));
        }
        let (mut s, bad) = match &raw {
            Some(json) => Self::parse_settings_lenient(json),
            None => (Settings::default(), vec![]),
        };
        s.dashboard = s.dashboard.normalized();
        // Only settings that parsed cleanly are kept: the caller must learn about unreadable ones.
        *self.settings_cache.borrow_mut() = raw.filter(|_| bad.is_empty()).map(|json| (json, s.clone()));
        Ok((s, bad))
    }

    /// Parses stored settings JSON; see [`Database::parse_settings_lenient`].
    pub fn parse_settings(json: &str) -> Result<Settings> {
        Ok(Self::parse_settings_lenient(json).0)
    }

    /// Parses stored settings JSON key by key (and one level deeper): a value of the wrong
    /// type (hand-edited, from another version) falls back to its default instead of making
    /// all settings unreadable. Returns the keys that were dropped (`*` for unreadable JSON).
    /// Settings from before the start preferences keep „Tagesnotiz beim Start öffnen“
    /// (`open_daily_on_start` → `start.open = daily`).
    pub fn parse_settings_lenient(json: &str) -> (Settings, Vec<String>) {
        use serde_json::Value;
        let value = match serde_json::from_str::<Value>(json) {
            Ok(v @ Value::Object(_)) => v,
            _ => return (Settings::default(), vec!["*".into()]),
        };
        let fits = |v: &Value| serde_json::from_value::<Settings>(v.clone()).is_ok();
        let mut bad = vec![];
        let merged = if fits(&value) {
            value.clone()
        } else {
            let mut base = serde_json::to_value(Settings::default()).unwrap_or(Value::Null);
            for (k, v) in value.as_object().into_iter().flatten() {
                let mut candidate = base.clone();
                candidate[k] = v.clone();
                if fits(&candidate) {
                    base = candidate;
                    continue;
                }
                match (v.as_object(), base.get(k).is_some_and(Value::is_object)) {
                    (Some(fields), true) => {
                        for (k2, v2) in fields {
                            let mut candidate = base.clone();
                            candidate[k][k2] = v2.clone();
                            if fits(&candidate) {
                                base = candidate;
                            } else {
                                bad.push(format!("{k}.{k2}"));
                            }
                        }
                    }
                    _ => bad.push(k.clone()),
                }
            }
            base
        };
        let mut s: Settings = serde_json::from_value(merged).unwrap_or_default();
        Self::upgrade_settings(&value, &mut s);
        (s, bad)
    }

    fn upgrade_settings(value: &serde_json::Value, s: &mut Settings) {
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
    fn settings_with_a_wrong_value_keep_the_rest() {
        let json = r#"{"theme":"dark","backup_keep":"viele","idle_threshold_minutes":7,
            "appearance":{"mica":"ja","custom_titlebar":false},"providers":[]}"#;
        let (s, bad) = Database::parse_settings_lenient(json);
        assert_eq!(bad, ["appearance.mica", "backup_keep"]);
        assert_eq!((s.theme.as_str(), s.idle_threshold_minutes), ("dark", 7));
        assert_eq!(s.backup_keep, Settings::default().backup_keep);
        assert!(!s.appearance.custom_titlebar);
        assert_eq!(s.appearance.mica, AppearancePrefs::default().mica);
        let (d, bad) = Database::parse_settings_lenient("{kaputt");
        assert_eq!((bad, d.backup_keep), (vec!["*".to_owned()], Settings::default().backup_keep));
        // Stored like that, the database still opens.
        let db = Database::open_in_memory().unwrap();
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [json]).unwrap();
        assert_eq!(db.load_settings().unwrap().idle_threshold_minutes, 7);
    }

    #[test]
    fn quick_link_targets() {
        let t = |u: &str| QuickLink { url: u.into(), ..Default::default() }.target();
        assert_eq!(t("jira.firma.de"), LinkTarget::Url("https://jira.firma.de".into()));
        assert_eq!(t("mailto:team@firma.de"), LinkTarget::Url("mailto:team@firma.de".into()));
        assert_eq!(t("msteams://teams.microsoft.com/l/x"), LinkTarget::Url("msteams://teams.microsoft.com/l/x".into()));
        assert_eq!(t("C:\\Projekte"), LinkTarget::Path("C:\\Projekte".into()));
        assert_eq!(t("\\\\server\\share"), LinkTarget::Path("\\\\server\\share".into()));
        assert_eq!(t("/home/anna/Dokumente"), LinkTarget::Path("/home/anna/Dokumente".into()));
        assert_eq!(t("file:///C:/Daten/Plan.xlsx"), LinkTarget::Path("C:/Daten/Plan.xlsx".into()));
        assert_eq!(t("file:///home/anna/a%20b"), LinkTarget::Path("/home/anna/a b".into()));
        // A multibyte character before the colon (used to panic on a byte-offset slice).
        assert_eq!(t("file://é:xy"), LinkTarget::Path("é:xy".into()));
        assert_eq!(t("file://C:/x"), LinkTarget::Path("C:/x".into()));
    }

    #[test]
    fn quick_links_are_trimmed_and_named() {
        let got = normalize_quick_links(vec![
            QuickLink {
                name: "  ".into(),
                url: " https://jira.firma.de/ ".into(),
                icon: "bug".into(),
                ..Default::default()
            },
            QuickLink { name: "Leer".into(), url: "  ".into(), ..Default::default() },
            QuickLink { name: " SAP ".into(), url: "C:\\SAP".into(), ..Default::default() },
        ]);
        assert_eq!(got.len(), 2);
        assert_eq!((got[0].name.as_str(), got[0].url.as_str()), ("jira.firma.de", "https://jira.firma.de/"));
        assert_eq!(got[1].name, "SAP");
    }

    #[test]
    fn old_quick_links_load_as_links_and_save_unchanged() {
        // Saved by 1.4: no kind, no items.
        let json = r#"{"quick_links":[{"name":"Jira","url":"jira.firma.de","icon":"ticket"}]}"#;
        let (s, bad) = Database::parse_settings_lenient(json);
        assert!(bad.is_empty());
        assert_eq!(s.quick_links[0].kind, LinkKind::Link);
        assert!(s.quick_links[0].items.is_empty());
        // Written back in the same shape (older versions read it as before).
        assert_eq!(
            serde_json::to_string(&s.quick_links[0]).unwrap(),
            r#"{"name":"Jira","url":"jira.firma.de","icon":"ticket"}"#
        );
        // A kind from a newer version opens like a link.
        let l: QuickLink = serde_json::from_str(r#"{"name":"x","url":"y","kind":"widget"}"#).unwrap();
        assert_eq!(l.kind, LinkKind::Link);
    }

    #[test]
    fn quick_link_groups_are_normalized() {
        let link = |n: &str, u: &str| QuickLink { name: n.into(), url: u.into(), ..Default::default() };
        let group = |n: &str, items: Vec<QuickLink>| QuickLink {
            name: n.into(),
            kind: LinkKind::Group,
            items,
            ..Default::default()
        };
        let mut inner = group("Innen", vec![link("A", "a.de")]);
        inner.url = "ignored".into();
        let mut g = group(" Tools ", vec![link("", " https://x.de/ "), link("Leer", ""), inner]);
        g.color = "blau".into();
        g.url = "https://ignored".into();
        let mut odd = group("", vec![]);
        odd.color = "#123456".into();
        let got = normalize_quick_links(vec![g, odd, link("Solo", "solo.de")]);
        assert_eq!(got.len(), 3);
        assert_eq!((got[0].name.as_str(), got[0].url.as_str(), got[0].color.as_str()), ("Tools", "", "blau"));
        let names: Vec<_> = got[0].items.iter().map(|i| i.name.as_str()).collect();
        assert_eq!(names, ["x.de", "A"]);
        assert!(got[0].items.iter().all(|i| i.kind == LinkKind::Link && i.items.is_empty()));
        // An empty group stays (it is filled next); unknown colors are dropped.
        assert_eq!((got[1].name.as_str(), got[1].color.as_str(), got[1].items.len()), ("Gruppe", "", 0));
        assert_eq!(got[2].kind, LinkKind::Link);
        // Round trip through JSON keeps groups, programs and order.
        let mut app = link("Rechner", "/usr/bin/calc");
        app.kind = LinkKind::App;
        let mut all = got.clone();
        all[0].items.push(app);
        let back: Vec<QuickLink> = serde_json::from_str(&serde_json::to_string(&all).unwrap()).unwrap();
        assert_eq!(back, all);
        assert_eq!(quick_link_at(&all, 0, Some(2)).map(|l| l.kind), Some(LinkKind::App));
        assert_eq!(quick_link_at(&all, 0, None), None, "a group itself is not opened");
        assert_eq!(quick_link_at(&all, 2, None).map(|l| l.name.as_str()), Some("Solo"));
        assert_eq!(quick_link_at(&all, 2, Some(0)), None);
        assert_eq!(quick_link_at(&all, 9, None), None);
    }

    #[test]
    fn dashboard_and_search_shortcut_default_for_old_settings() {
        let db = Database::open_in_memory().unwrap();
        // Settings saved before the dashboard and the quick search existed.
        db.save_settings(&Settings::default()).unwrap();
        db.conn().execute(r#"UPDATE settings SET value = '{"theme":"dark","capture_shortcut":"Alt+Q"}'"#, []).unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!(s.search_shortcut, DEFAULT_SEARCH_SHORTCUT);
        // Never saved: no boards and no old list (the start page shows its default boards).
        assert_eq!(s.dashboard, Dashboard::default());
        assert!(s.dashboard.widgets.is_none() && s.dashboard.boards.is_empty());
        // Saving other settings keeps it that way.
        db.save_settings(&s).unwrap();
        assert!(db.load_settings().unwrap().dashboard.widgets.is_none());
        // An explicitly empty old list stays empty; "" switches the search shortcut off.
        db.conn()
            .execute(r#"UPDATE settings SET value = '{"search_shortcut":"","dashboard":{"widgets":[]}}'"#, [])
            .unwrap();
        let s = db.load_settings().unwrap();
        assert_eq!(
            (s.search_shortcut.as_str(), s.dashboard.widgets.as_ref().map(Vec::len), s.dashboard.note.as_str()),
            ("", Some(0), "")
        );
    }

    #[test]
    fn old_dashboard_list_is_normalized_and_kept_for_the_move() {
        let db = Database::open_in_memory().unwrap();
        let json = r#"{"dashboard":{"note":"Hallo","widgets":[
            {"id":"a","kind":"today","size":"l"},
            {"id":"a","kind":"week","size":"s"},
            {"id":"","kind":"timer","size":"xl"},
            {"id":"x","kind":"wetter","size":"m"}]}}"#;
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [json]).unwrap();
        let d = db.load_settings().unwrap().dashboard;
        assert_eq!((d.version, d.note.as_str()), (0, "Hallo"));
        let got: Vec<_> = d.widgets.unwrap().iter().map(|w| (w.id.clone(), w.kind.clone(), w.size)).collect();
        assert_eq!(
            got,
            [
                ("a".to_owned(), "today".to_owned(), WidgetSize::Large),
                ("a-2".to_owned(), "week".to_owned(), WidgetSize::Small),
                ("timer".to_owned(), "timer".to_owned(), WidgetSize::Medium)
            ]
        );
        // Sizes serialize with their short names.
        let s = serde_json::to_string(&LegacyWidget { id: "t".into(), kind: "today".into(), size: WidgetSize::Small })
            .unwrap();
        assert_eq!(s, r#"{"id":"t","kind":"today","size":"s"}"#);
    }

    #[test]
    fn boards_are_normalized_on_load() {
        let db = Database::open_in_memory().unwrap();
        let big = "x".repeat(MAX_WIDGET_CONFIG + 10);
        let json = serde_json::json!({"dashboard": {
            "version": 2,
            "active": "weg",
            "notes": {"n": "Merkzettel", "alt": "vergessen"},
            "boards": [
                {"id": "heute", "name": "  Heute  ", "widgets": [
                    {"id": "n", "kind": "note", "x": 11, "y": 0, "w": 4, "h": 5},
                    {"id": "n", "kind": "agenda", "x": 0, "y": 2, "w": 40, "h": 0, "config": {"days": 3}},
                    {"id": "q", "kind": "query", "config": [1, 2]},
                    {"id": "b", "kind": "budget", "config": {"big": big}},
                    {"id": "w", "kind": "wetter"}
                ]},
                {"id": "heute", "name": "", "widgets": []}
            ]
        }});
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [json.to_string()]).unwrap();
        let d = db.load_settings().unwrap().dashboard;
        assert_eq!(
            (d.boards[0].name.as_str(), d.boards[1].id.as_str(), d.boards[1].name.as_str()),
            ("Heute", "heute-2", "Board")
        );
        assert_eq!(d.active, "heute", "an unknown board falls back to the first");
        let w: Vec<_> =
            d.boards[0].widgets.iter().map(|w| (w.id.as_str(), w.kind.as_str(), w.x, w.y, w.w, w.h)).collect();
        assert_eq!(
            w,
            [
                ("n", "note", 8, 0, 4, 5),
                ("n-2", "agenda", 0, 2, 12, 1),
                ("q", "query", 0, 0, 1, 1),
                ("b", "budget", 0, 0, 1, 1)
            ]
        );
        assert_eq!(d.boards[0].widgets[1].config, serde_json::json!({"days": 3}));
        assert!(d.boards[0].widgets[2].config.is_null(), "settings must be an object");
        assert!(d.boards[0].widgets[3].config.is_null(), "too large settings are dropped");
        // The note of a widget that is gone is dropped too.
        assert_eq!(d.notes.keys().collect::<Vec<_>>(), ["n"]);
        // Round trip: nothing changes on the second pass, empty fields are left out.
        assert_eq!(d.clone().normalized(), d);
        let text = serde_json::to_string(&d).unwrap();
        assert!(!text.contains("\"widgets\":null") && !text.contains("\"note\":\"\""), "{text}");
        let many = Dashboard {
            boards: (0..20)
                .map(|i| Board {
                    id: format!("b{i}"),
                    name: "B".into(),
                    widgets: (0..50)
                        .map(|j| Widget {
                            id: format!("w{j}"),
                            kind: "clock".into(),
                            x: 0,
                            y: 0,
                            w: 1,
                            h: 1,
                            title: String::new(),
                            config: serde_json::Value::Null,
                        })
                        .collect(),
                })
                .collect(),
            ..Default::default()
        }
        .normalized();
        assert_eq!((many.boards.len(), many.boards[0].widgets.len(), many.version), (MAX_BOARDS, MAX_WIDGETS, 2));
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
        s.notifications.day_review_time = "17.30 Uhr".into();
        s.start.open = StartOpen::Daily;
        s.normalize();
        assert_eq!((s.appearance.ui_scale, s.appearance.accent.as_str()), (125, "#aabbcc"));
        assert_eq!((s.editor.autosave_ms, s.notes.trash_retention_days), (250, 7));
        assert_eq!(s.notes.daily_folder, "Journal");
        assert_eq!(s.time.rounding.step_minutes, 0);
        assert_eq!(s.time.default_leistungsart.get("NP-1").map(String::as_str), Some("DEV"));
        assert_eq!((s.ai.temperature, s.ai.allowed_tools.clone()), (2.0, vec!["git".to_owned()]));
        assert_eq!(s.notifications.quiet_from, "22:00");
        assert_eq!(s.notifications.day_review_time, "17:30");
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
