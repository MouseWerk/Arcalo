//! User preferences beyond the connection settings: appearance, editor, notes, time
//! tracking, AI, notifications, privacy, start, language and keyboard shortcuts.
//!
//! Every struct is `#[serde(default)]` and every choice is a lenient enum (an unknown value
//! falls back to the default), so settings written by newer or older versions always load.
//! Ranges are enforced by [`crate::settings::Settings::normalize`].

use std::collections::BTreeMap;

use chrono::NaiveTime;
use serde::{Deserialize, Deserializer, Serialize};

/// A string enum that deserializes unknown values as its default.
macro_rules! choice {
    ($(#[$m:meta])* $name:ident { $($(#[$vm:meta])* $v:ident = $s:literal),+ $(,)? } default $d:ident) => {
        $(#[$m])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
        pub enum $name {
            $($(#[$vm])* #[serde(rename = $s)] $v,)+
        }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$v => $s,)+ }
            }
            pub fn parse(s: &str) -> Option<Self> {
                match s { $($s => Some($name::$v),)+ _ => None }
            }
        }
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let v = serde_json::Value::deserialize(d)?;
                Ok(v.as_str().and_then($name::parse).unwrap_or($name::$d))
            }
        }
    };
}

// ---------------------------------------------------------------- appearance

choice!(UiFont { System = "system", #[default] Inter = "inter" } default Inter);
choice!(EditorFont { #[default] Sans = "sans", Serif = "serif", Mono = "mono" } default Sans);
choice!(CodeFont { #[default] JetBrains = "jetbrains", System = "system" } default JetBrains);
choice!(Density { Compact = "compact", #[default] Normal = "normal", Comfortable = "comfortable" } default Normal);
choice!(LineWidth { Narrow = "narrow", #[default] Normal = "normal", Wide = "wide", Full = "full" } default Normal);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppearancePrefs {
    /// A preset name (`indigo`, `blue`, …) or `#rrggbb`.
    pub accent: String,
    pub ui_font: UiFont,
    pub editor_font: EditorFont,
    pub code_font: CodeFont,
    /// UI zoom in percent (90–125).
    pub ui_scale: u32,
    pub density: Density,
    pub line_width: LineWidth,
    pub reduce_motion: bool,
    /// Mica backdrop on Windows 11.
    pub mica: bool,
    /// Windows: own title bar (the tabs sit at the top edge, own window buttons) instead of the
    /// system one. Takes effect at the next start.
    pub custom_titlebar: bool,
}

impl Default for AppearancePrefs {
    fn default() -> Self {
        AppearancePrefs {
            accent: "indigo".into(),
            ui_font: UiFont::Inter,
            editor_font: EditorFont::Sans,
            code_font: CodeFont::JetBrains,
            ui_scale: 100,
            density: Density::Normal,
            line_width: LineWidth::Normal,
            reduce_motion: false,
            mica: true,
            custom_titlebar: true,
        }
    }
}

/// `#rrggbb` (lower case) or a known preset name; anything else is `None`.
pub fn normalize_accent(s: &str) -> Option<String> {
    const PRESETS: &[&str] = &["indigo", "blue", "teal", "green", "amber", "orange", "rose", "violet", "graphite"];
    let t = s.trim().to_ascii_lowercase();
    if PRESETS.contains(&t.as_str()) {
        return Some(t);
    }
    let hex = t.strip_prefix('#')?;
    match hex.len() {
        6 if hex.chars().all(|c| c.is_ascii_hexdigit()) => Some(format!("#{hex}")),
        3 if hex.chars().all(|c| c.is_ascii_hexdigit()) => {
            Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>()))
        }
        _ => None,
    }
}

// -------------------------------------------------------------------- editor

choice!(Spellcheck { #[default] De = "de", En = "en", DeEn = "de-en", Off = "off" } default De);
choice!(NewPageLocation { #[default] Top = "top", Current = "current", Inbox = "inbox" } default Top);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EditorPrefs {
    pub spellcheck: Spellcheck,
    /// Autosave delay after the last change (250–3000 ms).
    pub autosave_ms: u32,
    /// "…" → „…“, '…' → ‚…‘, " - " → " – ".
    pub smart_quotes: bool,
    /// Typing an opening bracket inserts the closing one.
    pub auto_pair: bool,
    /// Spaces per Tab in code blocks (2–8).
    pub tab_size: u32,
    pub code_line_numbers: bool,
    /// Preview of a linked page when hovering a `[[link]]`.
    pub hover_preview: bool,
    pub hover_delay_ms: u32,
    /// Heading markers at the right edge of a page.
    pub scroll_outline: bool,
    /// Icon of new pages (Lucide name); `None` = none.
    pub default_icon: Option<String>,
    pub new_page_location: NewPageLocation,
    /// Title of the page that collects new pages with [`NewPageLocation::Inbox`].
    pub inbox_title: String,
}

impl Default for EditorPrefs {
    fn default() -> Self {
        EditorPrefs {
            spellcheck: Spellcheck::De,
            autosave_ms: 450,
            smart_quotes: false,
            auto_pair: false,
            tab_size: 4,
            code_line_numbers: false,
            hover_preview: true,
            hover_delay_ms: 450,
            scroll_outline: true,
            default_icon: None,
            new_page_location: NewPageLocation::Top,
            inbox_title: "Inbox".into(),
        }
    }
}

// --------------------------------------------------------------------- notes

choice!(DailyTitle {
    /// 2026-09-24
    #[default] Iso = "iso",
    /// 24.09.2026
    De = "de",
    /// Mittwoch, 24.09.2026
    Long = "long",
} default Iso);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotesPrefs {
    pub daily_title: DailyTitle,
    /// Top-level page that holds the daily notes.
    pub daily_folder: String,
    /// Days pages stay in the trash (7–365).
    pub trash_retention_days: u32,
    /// Minutes between two automatic version snapshots of a page (5–60).
    pub version_interval_minutes: u32,
    /// Versions kept per page (5–500).
    pub max_versions: u32,
}

impl Default for NotesPrefs {
    fn default() -> Self {
        NotesPrefs {
            daily_title: DailyTitle::Iso,
            daily_folder: crate::notes::JOURNAL_TITLE.into(),
            trash_retention_days: 30,
            version_interval_minutes: 10,
            max_versions: 50,
        }
    }
}

const WEEKDAYS: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

impl DailyTitle {
    /// Title of the daily note of `date`.
    pub fn title(self, date: chrono::NaiveDate) -> String {
        use chrono::Datelike;
        match self {
            DailyTitle::Iso => date.format("%Y-%m-%d").to_string(),
            DailyTitle::De => date.format("%d.%m.%Y").to_string(),
            DailyTitle::Long => {
                format!("{}, {}", WEEKDAYS[date.weekday().num_days_from_monday() as usize], date.format("%d.%m.%Y"))
            }
        }
    }
}

// ---------------------------------------------------------------------- time

choice!(WeekStart { #[default] Monday = "monday", Sunday = "sunday" } default Monday);
choice!(RoundMode { #[default] Up = "up", Nearest = "nearest" } default Up);
choice!(HoursDisplay { #[default] Decimal = "decimal", Clock = "clock" } default Decimal);
choice!(CatsDelimiter { #[default] Semicolon = "semicolon", Comma = "comma", Tab = "tab" } default Semicolon);
choice!(CatsColumns {
    /// PERNR;WORKDATE;RPROJ;RNPLNR;VORNR;LSTAR;CATSHOURS;MEINH;LTXA1
    #[default] Standard = "standard",
    /// Without the WBS element (RPROJ).
    WithoutWbs = "without_wbs",
    /// WORKDATE first, PERNR second, RPROJ last.
    DateFirst = "date_first",
} default Standard);

impl CatsDelimiter {
    pub fn char(self) -> char {
        match self {
            CatsDelimiter::Semicolon => ';',
            CatsDelimiter::Comma => ',',
            CatsDelimiter::Tab => '\t',
        }
    }
}

impl CatsColumns {
    pub fn columns(self) -> &'static [&'static str] {
        match self {
            CatsColumns::Standard => {
                &["PERNR", "WORKDATE", "RPROJ", "RNPLNR", "VORNR", "LSTAR", "CATSHOURS", "MEINH", "LTXA1"]
            }
            CatsColumns::WithoutWbs => {
                &["PERNR", "WORKDATE", "RNPLNR", "VORNR", "LSTAR", "CATSHOURS", "MEINH", "LTXA1"]
            }
            CatsColumns::DateFirst => {
                &["WORKDATE", "PERNR", "RNPLNR", "VORNR", "LSTAR", "CATSHOURS", "MEINH", "LTXA1", "RPROJ"]
            }
        }
    }
}

/// Rounding of booked durations (bookings and timer stops).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Rounding {
    /// Step in minutes; 0 = off. Allowed: 0, 1, 5, 6, 10, 15.
    pub step_minutes: u32,
    pub mode: RoundMode,
    /// Bookings shorter than this are raised to it (0 = off).
    pub min_minutes: u32,
}

impl Default for Rounding {
    fn default() -> Self {
        Rounding { step_minutes: 0, mode: RoundMode::Up, min_minutes: 0 }
    }
}

pub const ROUNDING_STEPS: &[u32] = &[0, 1, 5, 6, 10, 15];

impl Rounding {
    /// Rounds a booked duration. 0 stays 0 (nothing booked); positive durations are rounded
    /// to the step (up, or to the nearest step but never to 0) and raised to the minimum.
    pub fn apply(&self, minutes: i64) -> i64 {
        if minutes <= 0 {
            return minutes.max(0);
        }
        let step = self.step_minutes as i64;
        let mut m = if step > 1 {
            match self.mode {
                RoundMode::Up => (minutes + step - 1) / step * step,
                RoundMode::Nearest => (((minutes + step / 2) / step) * step).max(step),
            }
        } else {
            minutes
        };
        m = m.max(self.min_minutes as i64);
        m
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct TimePrefs {
    pub week_start: WeekStart,
    pub rounding: Rounding,
    pub hours_display: HoursDisplay,
    /// Leistungsart used when a booking has none, per Netzplan number (`NP-8801` → `DEV`).
    pub default_leistungsart: BTreeMap<String, String>,
    pub cats_delimiter: CatsDelimiter,
    pub cats_columns: CatsColumns,
    /// Default file name of exports without extension; `{von}`, `{bis}`, `{format}`, `{kw}`, `{pernr}`.
    pub export_file_pattern: String,
}

impl Default for TimePrefs {
    fn default() -> Self {
        TimePrefs {
            week_start: WeekStart::Monday,
            rounding: Rounding::default(),
            hours_display: HoursDisplay::Decimal,
            default_leistungsart: BTreeMap::new(),
            cats_delimiter: CatsDelimiter::Semicolon,
            cats_columns: CatsColumns::Standard,
            export_file_pattern: DEFAULT_EXPORT_PATTERN.into(),
        }
    }
}

pub const DEFAULT_EXPORT_PATTERN: &str = "zeiten-{von}-{bis}";

impl TimePrefs {
    /// The default Leistungsart of a Netzplan (number compared case-insensitively).
    pub fn default_la_for(&self, netzplan_nr: &str) -> Option<&str> {
        self.default_leistungsart
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(netzplan_nr))
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }
}

// ------------------------------------------------------------------------ AI

/// A preset of the inline AI bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AiPreset {
    pub label: String,
    pub instruction: String,
}

/// Workspace tools; the system tools (`run_powershell`, `git`, `http_request`) must be
/// allowed explicitly.
pub const WORKSPACE_TOOLS: &[&str] = &["log_time", "search_workspace", "budget_status", "list_tasks", "time_summary"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiPrefs {
    /// 0.0–2.0.
    pub temperature: f32,
    /// Limit of answer tokens; `None` = the model's default.
    pub max_tokens: Option<u32>,
    /// Presets of the inline AI bar; `None` = the built-in ones.
    pub inline_presets: Option<Vec<AiPreset>>,
    /// Instruction of „Besprechung zusammenfassen“; `None` = the built-in one.
    pub meeting_template: Option<String>,
    /// Monthly cost limit in USD; warns at 80 %, blocks at 100 % unless overridden.
    pub monthly_cost_limit_usd: Option<f64>,
    /// Numbered sources `[1]` in answers.
    pub citations: bool,
    /// Show answers while they are generated.
    pub streaming: bool,
    /// Tools offered to the model.
    pub allowed_tools: Vec<String>,
}

impl Default for AiPrefs {
    fn default() -> Self {
        AiPrefs {
            temperature: 0.3,
            max_tokens: None,
            inline_presets: None,
            meeting_template: None,
            monthly_cost_limit_usd: None,
            citations: true,
            streaming: true,
            allowed_tools: WORKSPACE_TOOLS.iter().map(|s| (*s).to_owned()).collect(),
        }
    }
}

/// State of the monthly cost limit.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "level")]
pub enum CostLevel {
    Ok,
    /// At least 80 % used.
    Warning {
        fraction: f64,
    },
    /// Limit reached.
    Blocked {
        fraction: f64,
    },
}

pub fn cost_level(spent_usd: f64, limit_usd: Option<f64>) -> CostLevel {
    match limit_usd.filter(|l| *l > 0.0) {
        None => CostLevel::Ok,
        Some(limit) => {
            let fraction = spent_usd / limit;
            if fraction >= 1.0 {
                CostLevel::Blocked { fraction }
            } else if fraction >= 0.8 {
                CostLevel::Warning { fraction }
            } else {
                CostLevel::Ok
            }
        }
    }
}

// ------------------------------------------------------------- notifications

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NotificationPrefs {
    /// End-of-day reminder (its time is `reminder_time`).
    pub end_of_day: bool,
    /// Reminder when a timer still runs after 20:00.
    pub late_timer: bool,
    /// Budget warnings after bookings.
    pub budget: bool,
    pub backup_failed: bool,
    pub git_failed: bool,
    /// „Version X verfügbar“.
    pub updates: bool,
    /// No desktop notifications between `quiet_from` and `quiet_to`.
    pub quiet_hours: bool,
    pub quiet_from: String,
    pub quiet_to: String,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        NotificationPrefs {
            end_of_day: true,
            late_timer: true,
            budget: true,
            backup_failed: true,
            git_failed: true,
            updates: true,
            quiet_hours: false,
            quiet_from: "22:00".into(),
            quiet_to: "07:00".into(),
        }
    }
}

impl NotificationPrefs {
    /// Whether `t` lies in the quiet hours (the window may wrap midnight).
    pub fn is_quiet(&self, t: NaiveTime) -> bool {
        if !self.quiet_hours {
            return false;
        }
        let (Some(from), Some(to)) =
            (crate::desktop::parse_hhmm(&self.quiet_from), crate::desktop::parse_hhmm(&self.quiet_to))
        else {
            return false;
        };
        if from <= to { t >= from && t < to } else { t >= from || t < to }
    }
}

// ------------------------------------------------------------------- privacy

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct PrivacyPrefs {
    /// The assistant sees the open page.
    pub read_open_page: bool,
    /// Every request goes to the local model.
    pub local_only: bool,
}

impl Default for PrivacyPrefs {
    fn default() -> Self {
        PrivacyPrefs { read_open_page: true, local_only: false }
    }
}

// --------------------------------------------------------------------- start

choice!(StartOpen {
    /// The tabs of the last session.
    #[default] Tabs = "tabs",
    Dashboard = "dashboard",
    Daily = "daily",
} default Tabs);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct StartPrefs {
    pub open: StartOpen,
    pub restore_window: bool,
    /// Start hidden in the tray (minimized without a tray).
    pub minimized: bool,
}

impl Default for StartPrefs {
    fn default() -> Self {
        StartPrefs { open: StartOpen::Tabs, restore_window: true, minimized: false }
    }
}

// -------------------------------------------------------------------- locale

choice!(Language { #[default] De = "de", En = "en" } default De);
choice!(DateFormat { #[default] De = "de", Iso = "iso" } default De);

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LocalePrefs {
    pub language: Language,
    pub date_format: DateFormat,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn rounding_up_nearest_and_minimum() {
        let r = |step, mode, min| Rounding { step_minutes: step, mode, min_minutes: min };
        let up15 = r(15, RoundMode::Up, 0);
        assert_eq!([1, 15, 16, 44, 45, 46].map(|m| up15.apply(m)), [15, 15, 30, 45, 45, 60]);
        let near15 = r(15, RoundMode::Nearest, 0);
        assert_eq!([1, 7, 8, 22, 23, 52].map(|m| near15.apply(m)), [15, 15, 15, 15, 30, 45]);
        let near6 = r(6, RoundMode::Nearest, 0);
        assert_eq!([2, 3, 8, 9].map(|m| near6.apply(m)), [6, 6, 6, 12]);
        let off = Rounding::default();
        assert_eq!([0, 1, 37].map(|m| off.apply(m)), [0, 1, 37]);
        let one = r(1, RoundMode::Up, 0);
        assert_eq!(one.apply(37), 37);
        // Minimum booking and zero stays zero.
        let min = r(5, RoundMode::Up, 30);
        assert_eq!([0, 3, 31, 33].map(|m| min.apply(m)), [0, 30, 35, 35]);
        assert_eq!(r(0, RoundMode::Up, 10).apply(4), 10);
        assert_eq!(up15.apply(-5), 0);
    }

    #[test]
    fn unknown_choices_fall_back_to_defaults() {
        let a: AppearancePrefs =
            serde_json::from_str(r##"{"density":"riesig","line_width":"wide","accent":"#ff0000"}"##).unwrap();
        assert_eq!((a.density, a.line_width, a.ui_scale), (Density::Normal, LineWidth::Wide, 100));
        let t: TimePrefs = serde_json::from_str(r#"{"rounding":{"step_minutes":15},"week_start":42}"#).unwrap();
        assert_eq!((t.rounding.step_minutes, t.rounding.mode, t.week_start), (15, RoundMode::Up, WeekStart::Monday));
        assert_eq!(serde_json::to_string(&Spellcheck::DeEn).unwrap(), "\"de-en\"");
    }

    #[test]
    fn accent_normalization() {
        assert_eq!(normalize_accent(" Teal ").as_deref(), Some("teal"));
        assert_eq!(normalize_accent("#AbC").as_deref(), Some("#aabbcc"));
        assert_eq!(normalize_accent("#12345g"), None);
        assert_eq!(normalize_accent("red"), None);
    }

    #[test]
    fn daily_titles() {
        let d = NaiveDate::from_ymd_opt(2026, 9, 24).unwrap();
        assert_eq!(DailyTitle::Iso.title(d), "2026-09-24");
        assert_eq!(DailyTitle::De.title(d), "24.09.2026");
        assert_eq!(DailyTitle::Long.title(d), "Donnerstag, 24.09.2026");
    }

    #[test]
    fn cost_limit_levels_and_quiet_hours() {
        assert_eq!(cost_level(5.0, None), CostLevel::Ok);
        assert_eq!(cost_level(7.9, Some(10.0)), CostLevel::Ok);
        assert!(matches!(cost_level(8.0, Some(10.0)), CostLevel::Warning { .. }));
        assert!(matches!(cost_level(10.0, Some(10.0)), CostLevel::Blocked { .. }));
        assert_eq!(cost_level(10.0, Some(0.0)), CostLevel::Ok);
        let t = |h, m| NaiveTime::from_hms_opt(h, m, 0).unwrap();
        let mut n = NotificationPrefs { quiet_hours: true, ..Default::default() };
        assert!(n.is_quiet(t(23, 0)) && n.is_quiet(t(6, 59)) && !n.is_quiet(t(7, 0)) && !n.is_quiet(t(17, 30)));
        n.quiet_from = "12:00".into();
        n.quiet_to = "13:00".into();
        assert!(n.is_quiet(t(12, 30)) && !n.is_quiet(t(13, 0)));
        n.quiet_hours = false;
        assert!(!n.is_quiet(t(12, 30)));
    }

    #[test]
    fn default_leistungsart_lookup() {
        let t =
            TimePrefs { default_leistungsart: [("NP-8801".to_owned(), "DEV".to_owned())].into(), ..Default::default() };
        assert_eq!(t.default_la_for("np-8801"), Some("DEV"));
        assert_eq!(t.default_la_for("NP-9999"), None);
    }
}
