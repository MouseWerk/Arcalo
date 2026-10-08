//! User preferences beyond the connection settings: appearance, editor, notes, time
//! tracking, AI, notifications, privacy, start, language and keyboard shortcuts.
//!
//! Every struct is `#[serde(default)]` and every choice is a lenient enum (an unknown value
//! falls back to the default), so settings written by newer or older versions always load.
//! Ranges are enforced by [`crate::settings::Settings::normalize`].

use crate::{tr, trf};
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
        #[cfg(test)]
        impl schemars::JsonSchema for $name {
            fn schema_name() -> String {
                stringify!($name).into()
            }
            fn json_schema(_: &mut schemars::r#gen::SchemaGenerator) -> schemars::schema::Schema {
                schemars::schema::SchemaObject {
                    instance_type: Some(schemars::schema::InstanceType::String.into()),
                    enum_values: Some(vec![$(serde_json::Value::from($s)),+]),
                    ..Default::default()
                }
                .into()
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
choice!(WindowEffect { #[default] None = "none", Mica = "mica", Acrylic = "acrylic" } default None);

/// Lowest backdrop opacity: below it the backdrop shows so strongly that text loses contrast.
pub const WINDOW_OPACITY_MIN: u32 = 40;
pub const WINDOW_OPACITY_DEFAULT: u32 = 80;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct AppearancePrefs {
    /// `theme` (the color theme's own accent), a preset name (`indigo`, `blue`, …) or `#rrggbb`.
    pub accent: String,
    /// Color theme shown in light mode: a built-in id (`arcalo-light`, `nord-light`, …) or the
    /// id of a custom theme. Unknown ids show the default theme.
    pub theme_light: String,
    /// Color theme shown in dark mode.
    pub theme_dark: String,
    /// Themes made in Settings → Darstellung or imported from a theme file.
    pub custom_themes: Vec<CustomTheme>,
    pub ui_font: UiFont,
    pub editor_font: EditorFont,
    pub code_font: CodeFont,
    /// UI zoom in percent (90–125).
    pub ui_scale: u32,
    pub density: Density,
    pub line_width: LineWidth,
    pub reduce_motion: bool,
    /// Backdrop of the window on Windows 11 (Mica or Acrylic). Off by default: behind a bright
    /// desktop it washes out the sidebar (older settings are switched off once, see
    /// `Database::migrate_appearance_defaults`). Settings before 1.6 stored `mica: bool`, which
    /// becomes this when they are loaded.
    pub window_effect: WindowEffect,
    /// How much the theme's background covers the backdrop, in percent
    /// ([`WINDOW_OPACITY_MIN`]–100; at 100 the backdrop is not visible).
    pub window_opacity: u32,
    /// Windows: own title bar (the tabs sit at the top edge, own window buttons) instead of the
    /// system one. Takes effect at the next start.
    pub custom_titlebar: bool,
    /// The animated logo while the app starts.
    pub startup_animation: bool,
}

impl Default for AppearancePrefs {
    fn default() -> Self {
        AppearancePrefs {
            accent: ACCENT_THEME.into(),
            theme_light: DEFAULT_THEME_LIGHT.into(),
            theme_dark: DEFAULT_THEME_DARK.into(),
            custom_themes: Vec::new(),
            ui_font: UiFont::Inter,
            editor_font: EditorFont::Sans,
            code_font: CodeFont::JetBrains,
            ui_scale: 100,
            density: Density::Normal,
            line_width: LineWidth::Normal,
            reduce_motion: false,
            window_effect: WindowEffect::None,
            window_opacity: WINDOW_OPACITY_DEFAULT,
            custom_titlebar: true,
            startup_animation: true,
        }
    }
}

/// Accent value that uses the color theme's own accent.
pub const ACCENT_THEME: &str = "theme";
pub const DEFAULT_THEME_LIGHT: &str = "arcalo-light";
pub const DEFAULT_THEME_DARK: &str = "arcalo-dark";
/// Ids of the built-in themes in 1.14 and earlier: still read, as the current ones (settings of
/// other computers on those versions, exported settings, older backups).
pub const LEGACY_THEME_IDS: [(&str, &str); 2] =
    [("annalo-light", DEFAULT_THEME_LIGHT), ("annalo-dark", DEFAULT_THEME_DARK)];
/// At most this many custom themes are kept.
pub const MAX_CUSTOM_THEMES: usize = 40;
const MAX_THEME_NAME: usize = 60;

/// `#rrggbb` (lower case) or a known preset name; anything else is `None`.
pub fn normalize_accent(s: &str) -> Option<String> {
    const PRESETS: &[&str] =
        &[ACCENT_THEME, "indigo", "blue", "teal", "green", "amber", "orange", "rose", "violet", "graphite"];
    let t = s.trim().to_ascii_lowercase();
    if PRESETS.contains(&t.as_str()) {
        return Some(t);
    }
    normalize_hex(&t)
}

/// `#rgb` / `#rrggbb` (any case, `#` required) as lower-case `#rrggbb`.
pub fn normalize_hex(s: &str) -> Option<String> {
    let t = s.trim().to_ascii_lowercase();
    let hex = t.strip_prefix('#')?;
    match hex.len() {
        6 if hex.chars().all(|c| c.is_ascii_hexdigit()) => Some(format!("#{hex}")),
        3 if hex.chars().all(|c| c.is_ascii_hexdigit()) => {
            Some(format!("#{}", hex.chars().flat_map(|c| [c, c]).collect::<String>()))
        }
        _ => None,
    }
}

/// A theme id as stored: trimmed, the default when empty or absurdly long, the built-in themes'
/// ids of 1.14 and earlier as the current ones.
pub fn normalize_theme_id(id: &str, default: &str) -> String {
    let t = id.trim();
    if t.is_empty() || t.len() > 64 {
        return default.to_owned();
    }
    LEGACY_THEME_IDS.iter().find(|(old, _)| *old == t).map_or(t, |(_, new)| new).to_owned()
}

/// The main colors of a custom theme; the UI derives the remaining tokens (hover, strong
/// borders, soft tints, shadows) from them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct ThemeColors {
    /// Page and editor background.
    pub background: String,
    /// Sidebar, ribbon and tab bar.
    pub surface: String,
    pub text: String,
    /// Secondary text (descriptions, hints).
    pub muted: String,
    pub border: String,
    pub accent: String,
    pub success: String,
    pub warning: String,
    pub danger: String,
}

impl ThemeColors {
    /// Every color as lower-case `#rrggbb`; the name of the first invalid one otherwise.
    pub fn normalized(mut self) -> std::result::Result<Self, &'static str> {
        for (name, value) in [
            ("background", &mut self.background),
            ("surface", &mut self.surface),
            ("text", &mut self.text),
            ("muted", &mut self.muted),
            ("border", &mut self.border),
            ("accent", &mut self.accent),
            ("success", &mut self.success),
            ("warning", &mut self.warning),
            ("danger", &mut self.danger),
        ] {
            *value = normalize_hex(value).ok_or(name)?;
        }
        Ok(self)
    }
}

/// A color theme made by the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct CustomTheme {
    /// `custom-…`; assigned when saved if missing, foreign or taken.
    #[serde(default)]
    pub id: String,
    pub name: String,
    /// Shown in dark mode (and listed with the dark themes).
    pub dark: bool,
    pub colors: ThemeColors,
}

impl CustomTheme {
    /// Trimmed name, normalized colors; `None` when a color is unusable.
    fn normalized(mut self) -> Option<Self> {
        self.colors = self.colors.normalized().ok()?;
        self.name = self.name.trim().chars().take(MAX_THEME_NAME).collect::<String>().trim_end().to_owned();
        if self.name.is_empty() {
            self.name = "Eigenes Theme".into();
        }
        self.id = self.id.trim().to_owned();
        Some(self)
    }
}

/// Custom themes as saved: unusable ones dropped, at most [`MAX_CUSTOM_THEMES`], ids unique
/// (`custom-N` for missing, foreign or duplicate ones).
pub fn normalize_custom_themes(themes: Vec<CustomTheme>) -> Vec<CustomTheme> {
    let mut out: Vec<CustomTheme> =
        themes.into_iter().filter_map(CustomTheme::normalized).take(MAX_CUSTOM_THEMES).collect();
    let mut seen = std::collections::HashSet::new();
    let mut renumber = Vec::new();
    for (i, t) in out.iter().enumerate() {
        let valid = t.id.len() > "custom-".len()
            && t.id.len() <= 64
            && t.id.starts_with("custom-")
            && t.id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !valid || !seen.insert(t.id.clone()) {
            renumber.push(i);
        }
    }
    let mut n = 1;
    for i in renumber {
        while seen.contains(&format!("custom-{n}")) {
            n += 1;
        }
        out[i].id = format!("custom-{n}");
        seen.insert(out[i].id.clone());
    }
    out
}

/// Marker of an exported theme file.
pub const THEME_FILE_FORMAT: &str = "arcalo-theme";
/// [`THEME_FILE_FORMAT`] of files exported by 1.14 and earlier (still read).
pub const LEGACY_THEME_FILE_FORMAT: &str = "annalo-theme";

#[derive(Serialize)]
struct ThemeFile<'a> {
    format: &'static str,
    version: u32,
    name: &'a str,
    dark: bool,
    colors: &'a ThemeColors,
}

/// A theme as a `.json` file: `{ format: "arcalo-theme", version: 1, name, dark, colors }`
/// (without the id, which is local to one installation).
pub fn theme_file_json(t: &CustomTheme) -> String {
    let file = ThemeFile { format: THEME_FILE_FORMAT, version: 1, name: &t.name, dark: t.dark, colors: &t.colors };
    serde_json::to_string_pretty(&file).unwrap_or_default() + "\n"
}

/// Reads a theme file. Refuses other files, newer versions and missing or invalid colors;
/// without `dark` the background decides. The result has no id yet.
pub fn parse_theme_file(json: &str) -> std::result::Result<CustomTheme, String> {
    let value: serde_json::Value = serde_json::from_str(json)
        .map_err(|_| tr!("Die Datei ist kein gültiges JSON", "The file is not valid JSON").to_owned())?;
    if !value
        .get("format")
        .and_then(|f| f.as_str())
        .is_some_and(|f| f == THEME_FILE_FORMAT || f == LEGACY_THEME_FILE_FORMAT)
    {
        return Err(tr!("Keine Arcalo-Theme-Datei", "Not an Arcalo theme file").into());
    }
    if value.get("version").and_then(|v| v.as_u64()).unwrap_or(0) > 1 {
        return Err(tr!(
            "Die Theme-Datei stammt aus einer neueren Arcalo-Version",
            "The theme file comes from a newer Arcalo version"
        )
        .into());
    }
    let colors: ThemeColors = serde_json::from_value(value.get("colors").cloned().unwrap_or_default())
        .map_err(|e| trf!("Farben unvollständig: {e}", "Colors incomplete: {e}"))?;
    let colors = colors.normalized().map_err(|name| trf!("Ungültige Farbe „{name}“", "Invalid color “{name}”"))?;
    let name = value.get("name").and_then(|n| n.as_str()).unwrap_or_default().to_owned();
    let dark = value.get("dark").and_then(|d| d.as_bool()).unwrap_or_else(|| is_dark(&colors.background));
    CustomTheme { id: String::new(), name, dark, colors }
        .normalized()
        .ok_or_else(|| tr!("Ungültige Farben", "Invalid colors").to_owned())
}

/// Whether a `#rrggbb` color is dark (WCAG relative luminance below 0.18).
fn is_dark(hex: &str) -> bool {
    let channel = |i: usize| u8::from_str_radix(hex.get(i..i + 2).unwrap_or("00"), 16).unwrap_or(0) as f64 / 255.0;
    let lin = |v: f64| if v <= 0.03928 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    0.2126 * lin(channel(1)) + 0.7152 * lin(channel(3)) + 0.0722 * lin(channel(5)) < 0.18
}

// -------------------------------------------------------------------- editor

choice!(Spellcheck { #[default] De = "de", En = "en", DeEn = "de-en", Off = "off" } default De);
choice!(NewPageLocation { #[default] Top = "top", Current = "current", Inbox = "inbox" } default Top);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
    /// Formatting toolbar above notes.
    pub toolbar: bool,
    /// „Nicht verlinkte Erwähnungen“ in the links panel.
    pub link_suggestions: bool,
    /// Dotted underline under unlinked page titles in the editor (click links them).
    pub mention_hints: bool,
    /// Tag suggestions under the page properties.
    pub tag_suggestions: bool,
    /// „Ähnliche Seite“ hint in the page header.
    pub duplicate_hints: bool,
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
            toolbar: true,
            link_suggestions: true,
            mention_hints: false,
            tag_suggestions: true,
            duplicate_hints: true,
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
const WEEKDAYS_EN: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

impl DailyTitle {
    /// Title of the daily note of `date`.
    pub fn title(self, date: chrono::NaiveDate) -> String {
        use chrono::Datelike;
        match self {
            DailyTitle::Iso => date.format("%Y-%m-%d").to_string(),
            DailyTitle::De => date.format("%d.%m.%Y").to_string(),
            DailyTitle::Long => {
                let days = if crate::i18n::is_en() { WEEKDAYS_EN } else { WEEKDAYS };
                format!("{}, {}", days[date.weekday().num_days_from_monday() as usize], date.format("%d.%m.%Y"))
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

// Decimal separator of the CATS hours: comma (SAP default in German), point, or as the number
// format (Settings → Sprache und Region) writes numbers.
choice!(CatsDecimal { #[default] Comma = "comma", Point = "point", Number = "number" } default Comma);

impl CatsDecimal {
    /// Whether CATS hours are written with a decimal point.
    pub fn point(self, locale: &LocalePrefs) -> bool {
        match self {
            CatsDecimal::Comma => false,
            CatsDecimal::Point => true,
            CatsDecimal::Number => match locale.number_format {
                Some(f) => f == NumberFormat::Point,
                None => locale.lang() == Language::En,
            },
        }
    }
}

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
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct TimePrefs {
    /// „Zeiterfassung verwenden“: off hides the timesheet, projects and their commands.
    pub enabled: bool,
    pub week_start: WeekStart,
    pub rounding: Rounding,
    pub hours_display: HoursDisplay,
    /// Leistungsart used when a booking has none, per Netzplan number (`NP-8801` → `DEV`).
    pub default_leistungsart: BTreeMap<String, String>,
    pub cats_delimiter: CatsDelimiter,
    pub cats_columns: CatsColumns,
    /// Decimal separator of the hours in the CATS file and „Für CATS kopieren“.
    pub cats_decimal: CatsDecimal,
    /// Default file name of exports without extension; `{von}`, `{bis}`, `{format}`, `{kw}`, `{pernr}`.
    pub export_file_pattern: String,
    /// Overtime balance, vacation account and public holidays.
    pub balance: crate::worktime::BalancePrefs,
    /// Start of the working hours (local `HH:MM`): the free slots of „Im Kalender planen…“ lie
    /// inside `work_start..work_end`.
    pub work_start: String,
    /// End of the working hours (local `HH:MM`).
    pub work_end: String,
}

impl Default for TimePrefs {
    fn default() -> Self {
        TimePrefs {
            enabled: true,
            week_start: WeekStart::Monday,
            rounding: Rounding::default(),
            hours_display: HoursDisplay::Decimal,
            default_leistungsart: BTreeMap::new(),
            cats_delimiter: CatsDelimiter::Semicolon,
            cats_columns: CatsColumns::Standard,
            cats_decimal: CatsDecimal::Comma,
            export_file_pattern: DEFAULT_EXPORT_PATTERN.into(),
            balance: crate::worktime::BalancePrefs::default(),
            work_start: DEFAULT_WORK_START.into(),
            work_end: DEFAULT_WORK_END.into(),
        }
    }
}

pub const DEFAULT_WORK_START: &str = "08:00";
pub const DEFAULT_WORK_END: &str = "18:00";

pub const DEFAULT_EXPORT_PATTERN: &str = "zeiten-{von}-{bis}";

impl TimePrefs {
    /// The working hours: `work_start..work_end`, or 08:00–18:00 when they are unreadable or
    /// the end is not after the start.
    pub fn work_hours(&self) -> (NaiveTime, NaiveTime) {
        let parse = |s: &str| crate::desktop::parse_hhmm(s);
        match (parse(&self.work_start), parse(&self.work_end)) {
            (Some(a), Some(b)) if a < b => (a, b),
            _ => (
                NaiveTime::from_hms_opt(8, 0, 0).unwrap_or_default(),
                NaiveTime::from_hms_opt(18, 0, 0).unwrap_or_default(),
            ),
        }
    }

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
#[cfg_attr(test, derive(schemars::JsonSchema))]
pub struct AiPreset {
    pub label: String,
    pub instruction: String,
}

/// Workspace tools; the system tools (`run_powershell`, `git`, `http_request`) must be
/// allowed explicitly.
pub const WORKSPACE_TOOLS: &[&str] =
    &["log_time", "search_workspace", "budget_status", "list_tasks", "time_summary", "activity_log"];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct AiPrefs {
    /// „KI verwenden“: off, Arcalo shows no AI anywhere and sends nothing to an AI or embedding
    /// provider; the providers and models stay configured for when it is switched on again.
    pub enabled: bool,
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
    /// How long the assistant's conversations are kept.
    pub chat_history: ChatRetention,
}

choice!(
    /// Chat history: kept, kept for 90 or 30 days after the last message (pinned
    /// conversations stay), or not saved at all.
    ChatRetention { #[default] All = "all", Days90 = "90", Days30 = "30", Off = "off" } default All
);

impl ChatRetention {
    /// Days a conversation is kept after its last message; `None` = no limit.
    pub fn days(self) -> Option<i64> {
        match self {
            ChatRetention::Days90 => Some(90),
            ChatRetention::Days30 => Some(30),
            ChatRetention::All | ChatRetention::Off => None,
        }
    }
}

impl Default for AiPrefs {
    fn default() -> Self {
        AiPrefs {
            enabled: true,
            temperature: 0.3,
            max_tokens: None,
            inline_presets: None,
            meeting_template: None,
            monthly_cost_limit_usd: None,
            citations: true,
            streaming: true,
            allowed_tools: WORKSPACE_TOOLS.iter().map(|s| (*s).to_owned()).collect(),
            chat_history: ChatRetention::All,
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

// ------------------------------------------------------------------- capture

choice!(CaptureDefault {
    /// Today's daily note.
    #[default] Daily = "daily",
    /// The inbox page („Posteingang“).
    Inbox = "inbox",
    /// The page chosen last in this session (the daily note until one was chosen).
    Last = "last",
} default Daily);

/// Quick capture (Settings → Desktop → Schnellerfassung).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct CapturePrefs {
    /// Where a capture goes when the window opens.
    pub default_target: CaptureDefault,
    /// Title of the page that collects captures with a timestamp.
    pub inbox_title: String,
    /// Global shortcut „Auswahl übernehmen“: opens quick capture with the selection (Linux) or
    /// the clipboard text; `""` = off.
    pub selection_shortcut: String,
    /// Hide the window this long after „Gespeichert in …“ (0–10000 ms).
    pub auto_hide_ms: u32,
    /// Offer the meeting running now (or started less than 15 minutes ago) as target.
    pub meeting_target: bool,
}

impl Default for CapturePrefs {
    fn default() -> Self {
        CapturePrefs {
            default_target: CaptureDefault::Daily,
            inbox_title: crate::capture::inbox_title().into(),
            selection_shortcut: String::new(),
            auto_hide_ms: 1200,
            meeting_target: true,
        }
    }
}

// ------------------------------------------------------------- notifications

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
    /// „Woche vorschlagen“ on the last workday of the week from 14:00 when days are open.
    pub week_proposal: bool,
    /// „Tagesrückblick ansehen“ once a workday at `day_review_time` (off by default).
    pub day_review: bool,
    /// `HH:MM` (local time) of the day review reminder.
    pub day_review_time: String,
    /// Tasks due today, from 09:00 on a day (with „Erledigt“, „Schlummern“ and „Öffnen“).
    pub task_due: bool,
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
            week_proposal: true,
            day_review: false,
            day_review_time: "17:30".into(),
            task_due: true,
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
#[cfg_attr(test, derive(schemars::JsonSchema))]
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

// -------------------------------------------------------------------- search

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct SearchPrefs {
    /// „Suche nach Bedeutung“: the search also finds pages by meaning (`crate::semantic`).
    /// `None` = automatic: on when the embedding model runs on a local provider.
    pub semantic: Option<bool>,
}

// --------------------------------------------------------------------- start

choice!(StartOpen {
    /// The tabs of the last session.
    #[default] Tabs = "tabs",
    Dashboard = "dashboard",
    Daily = "daily",
} default Tabs);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
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
// The stored choice of Settings → Sprache & Format: a language, or the system's. „Wie das
// System“ is the default of new installs since 1.13; settings of earlier versions keep the
// language they had (settings step `language-choice`).
choice!(LanguageChoice {
    /// The operating system's language, read at every start (German for German, else English).
    #[default] System = "system",
    De = "de",
    En = "en",
} default System);
choice!(DateFormat { #[default] De = "de", Iso = "iso", EnGb = "en-gb", EnUs = "en-us" } default De);
choice!(NumberFormat { #[default] Comma = "comma", Point = "point" } default Comma);

impl LanguageChoice {
    /// The language this choice stands for on this computer.
    pub fn resolve(self) -> Language {
        match self {
            LanguageChoice::System => crate::i18n::system_lang(),
            LanguageChoice::De => Language::De,
            LanguageChoice::En => Language::En,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct LocalePrefs {
    /// The chosen display language; [`LocalePrefs::lang`] is the one in effect.
    pub language: LanguageChoice,
    pub date_format: DateFormat,
    /// Decimal comma (28,00) or point (28.00); `None`: as the display language writes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number_format: Option<NumberFormat>,
}

impl LocalePrefs {
    /// The display language in effect („Wie das System“ resolved).
    pub fn lang(&self) -> Language {
        self.language.resolve()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn cats_decimal_defaults_to_comma_and_can_follow_the_number_format() {
        let t: TimePrefs = serde_json::from_str("{}").unwrap();
        assert_eq!(t.cats_decimal, CatsDecimal::Comma, "settings of 1.11 keep the comma");
        let de = LocalePrefs { language: LanguageChoice::De, ..Default::default() };
        let en = LocalePrefs { language: LanguageChoice::En, ..Default::default() };
        let point = LocalePrefs { number_format: Some(NumberFormat::Point), ..de.clone() };
        assert!(!CatsDecimal::Comma.point(&en) && CatsDecimal::Point.point(&de));
        assert_eq!([de, en, point].map(|l| CatsDecimal::Number.point(&l)), [false, true, true]);
        assert_eq!(serde_json::from_str::<CatsDecimal>("\"unknown\"").unwrap(), CatsDecimal::Comma);
    }

    #[test]
    fn number_format_is_kept_and_unset_by_default() {
        let l: LocalePrefs = serde_json::from_str(r#"{"language":"en","number_format":"point"}"#).unwrap();
        assert_eq!(l.number_format, Some(NumberFormat::Point));
        assert_eq!(serde_json::to_value(&l).unwrap()["number_format"], "point");
        let l: LocalePrefs = serde_json::from_str(r#"{"language":"en"}"#).unwrap();
        assert_eq!(l.number_format, None);
        assert!(serde_json::to_value(&l).unwrap().get("number_format").is_none());
    }

    #[test]
    fn language_choice_defaults_to_the_system_and_resolves_per_computer() {
        assert_eq!(LocalePrefs::default().language, LanguageChoice::System);
        let l: LocalePrefs = serde_json::from_str(r#"{"language":"system"}"#).unwrap();
        assert_eq!(serde_json::to_value(&l).unwrap()["language"], "system");
        // Stored languages stay; an unknown value counts as the system's.
        assert_eq!(serde_json::from_str::<LanguageChoice>("\"de\"").unwrap(), LanguageChoice::De);
        assert_eq!(serde_json::from_str::<LanguageChoice>("\"fr\"").unwrap(), LanguageChoice::System);
        for system in [Language::De, Language::En] {
            crate::i18n::with_system_lang(system, || {
                assert_eq!(LanguageChoice::System.resolve(), system);
                assert_eq!(LanguageChoice::De.resolve(), Language::De);
                assert_eq!(LanguageChoice::En.resolve(), Language::En);
                // The number format „as the language writes it“ follows the resolved language.
                let sys = LocalePrefs::default();
                assert_eq!(CatsDecimal::Number.point(&sys), system == Language::En);
            });
        }
    }

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

    fn colors() -> ThemeColors {
        ThemeColors {
            background: "#FFF".into(),
            surface: "#f4f4f5".into(),
            text: "#18181b".into(),
            muted: "#6b6b74".into(),
            border: "#e4e4e7".into(),
            accent: "#6366f1".into(),
            success: "#157034".into(),
            warning: "#a14a08".into(),
            danger: "#dc2626".into(),
        }
    }

    #[test]
    fn appearance_defaults_and_older_settings() {
        let d = AppearancePrefs::default();
        assert_eq!(
            (d.accent.as_str(), d.theme_light.as_str(), d.theme_dark.as_str()),
            ("theme", "arcalo-light", "arcalo-dark")
        );
        assert!(d.window_effect == WindowEffect::None && d.custom_themes.is_empty());
        assert_eq!(d.window_opacity, WINDOW_OPACITY_DEFAULT);
        // Settings from before themes load with the new fields at their defaults.
        let old: AppearancePrefs = serde_json::from_str(r#"{"accent":"teal","density":"compact"}"#).unwrap();
        assert_eq!((old.accent.as_str(), old.theme_dark.as_str()), ("teal", "arcalo-dark"));
        // An effect this version does not know (a newer one, a typo) is no effect.
        let odd: AppearancePrefs = serde_json::from_str(r#"{"window_effect":"blur"}"#).unwrap();
        assert_eq!(odd.window_effect, WindowEffect::None);
        assert_eq!(normalize_accent(" THEME ").as_deref(), Some("theme"));
        assert_eq!(normalize_theme_id("  ", DEFAULT_THEME_DARK), "arcalo-dark");
        assert_eq!(normalize_theme_id(" nord-dark ", DEFAULT_THEME_DARK), "nord-dark");
        assert_eq!(normalize_theme_id("annalo-light", DEFAULT_THEME_DARK), "arcalo-light", "ids of 1.14");
        assert_eq!(normalize_theme_id(" annalo-dark", DEFAULT_THEME_LIGHT), "arcalo-dark");
    }

    #[test]
    fn custom_themes_are_validated_and_get_unique_ids() {
        let t = |id: &str, name: &str| CustomTheme { id: id.into(), name: name.into(), dark: false, colors: colors() };
        let mut broken = t("custom-x", "Kaputt");
        broken.colors.text = "schwarz".into();
        let out = normalize_custom_themes(vec![
            t("custom-a", "  Papier  "),
            t("custom-a", "Doppelt"),
            t("", ""),
            t("nord-light", "Fremd"),
            broken,
        ]);
        assert_eq!(
            out.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(),
            ["custom-a", "custom-1", "custom-2", "custom-3"]
        );
        assert_eq!((out[0].name.as_str(), out[2].name.as_str()), ("Papier", "Eigenes Theme"));
        assert_eq!(out[0].colors.background, "#ffffff");
        let many = (0..60).map(|i| t(&format!("custom-{i}"), "x")).collect();
        assert_eq!(normalize_custom_themes(many).len(), MAX_CUSTOM_THEMES);
    }

    #[test]
    fn theme_files_round_trip_and_are_checked() {
        let theme = CustomTheme { id: "custom-7".into(), name: "Papier".into(), dark: false, colors: colors() };
        let json = theme_file_json(&theme);
        assert!(json.contains(r#""format": "arcalo-theme""#));
        assert!(!json.contains("custom-7"), "ids are local to one installation");
        let back = parse_theme_file(&json).unwrap();
        assert_eq!((back.id.as_str(), back.name.as_str(), back.dark), ("", "Papier", false));
        assert_eq!(back.colors, colors().normalized().unwrap());

        assert!(parse_theme_file("nicht json").unwrap_err().contains("JSON"));
        assert!(parse_theme_file(r#"{"format":"arcalo-settings","version":1}"#).unwrap_err().contains("Keine"));
        assert!(parse_theme_file(&json.replace(r#""version": 1"#, r#""version": 2"#)).unwrap_err().contains("neueren"));
        assert!(parse_theme_file(&json.replace("#18181b", "#18181")).unwrap_err().contains("text"));
        assert!(parse_theme_file(&json.replace(r#""danger""#, r#""gefahr""#)).unwrap_err().contains("unvollständig"));
        // Without "dark" the background decides.
        let file = serde_json::json!({
            "format": "arcalo-theme",
            "version": 1,
            "name": "Nacht",
            "colors": {"background":"#1e1e2e","surface":"#181825","text":"#cdd6f4","muted":"#a6adc8","border":"#313244","accent":"#cba6f7","success":"#a6e3a1","warning":"#f9e2af","danger":"#f38ba8"}
        });
        assert!(parse_theme_file(&file.to_string()).unwrap().dark);
        // Files exported by 1.14 and earlier.
        let old = file.to_string().replace("arcalo-theme", "annalo-theme");
        assert_eq!(parse_theme_file(&old).unwrap().name, "Nacht");
    }

    #[test]
    fn daily_titles() {
        let d = NaiveDate::from_ymd_opt(2026, 9, 24).unwrap();
        assert_eq!(DailyTitle::Iso.title(d), "2026-09-24");
        assert_eq!(DailyTitle::De.title(d), "24.09.2026");
        assert_eq!(DailyTitle::Long.title(d), "Donnerstag, 24.09.2026");
        crate::i18n::with_lang(super::Language::En, || assert_eq!(DailyTitle::Long.title(d), "Thursday, 24.09.2026"));
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
