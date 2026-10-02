//! Update policies an organization sets for its installations (docs/admin/updates.md): the
//! update mode, its own update source, whether GitHub may be asked, a version cap, an install
//! window and the check interval. Read at start from the Windows registry
//! (`HKLM\Software\Policies\MouseWerk\Arcalo` over `HKCU\…`), macOS managed preferences and a
//! `policy.json` next to the executable or in a system folder. A managed value overrides the
//! user's setting, which Settings then shows locked.

use std::path::{Path, PathBuf};

use chrono::{NaiveTime, Timelike};
use serde::{Deserialize, Serialize};

use crate::trf;

/// What the app does about new versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum UpdateMode {
    /// Check, download in the background, install when the app quits.
    #[default]
    Auto,
    /// Check and show the new version; installing needs a click.
    Notify,
    /// No automatic checks (a policy: no checks at all).
    Off,
}

impl UpdateMode {
    pub fn parse(s: &str) -> Option<UpdateMode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "auto" | "automatic" => Some(UpdateMode::Auto),
            "notify" | "manual" => Some(UpdateMode::Notify),
            "off" | "disabled" | "none" => Some(UpdateMode::Off),
            _ => None,
        }
    }
}

/// `18:00-07:00`: installs happen only in this time of day (it may span midnight).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(into = "String")]
pub struct InstallWindow {
    pub start: NaiveTime,
    pub end: NaiveTime,
}

impl InstallWindow {
    /// `HH:MM-HH:MM` (also with an en dash or spaces). Equal ends are no window.
    pub fn parse(raw: &str) -> Option<InstallWindow> {
        let raw = raw.replace(['–', '—'], "-");
        let (a, b) = raw.split_once('-')?;
        let t = |s: &str| NaiveTime::parse_from_str(s.trim(), "%H:%M").ok();
        let (start, end) = (t(a)?, t(b)?);
        (start != end).then_some(InstallWindow { start, end })
    }

    pub fn contains(&self, at: NaiveTime) -> bool {
        let at = NaiveTime::from_hms_opt(at.hour(), at.minute(), 0).unwrap_or(at);
        if self.start < self.end { self.start <= at && at < self.end } else { at >= self.start || at < self.end }
    }

    pub fn label(&self) -> String {
        format!("{}–{}", self.start.format("%H:%M"), self.end.format("%H:%M"))
    }
}

impl From<InstallWindow> for String {
    fn from(w: InstallWindow) -> String {
        w.label()
    }
}

/// A policy value as the registry, a plist or JSON stores it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Text(String),
    Number(i64),
    Bool(bool),
}

/// The managed values; `None` = not managed (the user's setting applies).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Policy {
    pub update_mode: Option<UpdateMode>,
    pub update_url: Option<String>,
    pub allow_github_fallback: Option<bool>,
    pub pinned_version: Option<String>,
    pub install_window: Option<InstallWindow>,
    pub check_interval_hours: Option<u32>,
    /// Where the values came from (registry key, file), for the log and Settings.
    pub origins: Vec<String>,
    /// Values that were ignored, with the reason.
    pub warnings: Vec<String>,
}

/// The check interval allowed (hours).
pub const INTERVAL_HOURS: std::ops::RangeInclusive<u32> = 1..=168;

impl Policy {
    /// Reads named values (case does not matter; unknown names are ignored, invalid values warned).
    pub fn from_values(origin: &str, values: impl IntoIterator<Item = (String, Value)>) -> Policy {
        let mut p = Policy::default();
        let mut any = false;
        for (name, value) in values {
            let text = match &value {
                Value::Text(s) => s.trim().to_string(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
            };
            let bad = |p: &mut Policy| {
                p.warnings.push(trf!("{}: {} = „{}“ ungültig", "{}: {} = “{}” invalid", origin, name, text))
            };
            match name.trim().to_ascii_lowercase().as_str() {
                "updatemode" => match UpdateMode::parse(&text) {
                    Some(m) => p.update_mode = Some(m),
                    None => bad(&mut p),
                },
                "updateurl" => p.update_url = Some(text).filter(|t| !t.is_empty()),
                "allowgithubfallback" => match value {
                    Value::Bool(b) => p.allow_github_fallback = Some(b),
                    Value::Number(n) => p.allow_github_fallback = Some(n != 0),
                    Value::Text(_) => match text.to_ascii_lowercase().as_str() {
                        "1" | "true" | "yes" | "on" => p.allow_github_fallback = Some(true),
                        "0" | "false" | "no" | "off" => p.allow_github_fallback = Some(false),
                        _ => bad(&mut p),
                    },
                },
                "pinnedversion" => {
                    let v = text.trim_start_matches('v');
                    if v.is_empty() {
                    } else if semver::Version::parse(v).is_ok() {
                        p.pinned_version = Some(v.to_string());
                    } else {
                        bad(&mut p);
                    }
                }
                "installwindow" => match InstallWindow::parse(&text) {
                    Some(w) => p.install_window = Some(w),
                    None if text.is_empty() => {}
                    None => bad(&mut p),
                },
                "checkintervalhours" => match text.parse::<u32>() {
                    Ok(h) => p.check_interval_hours = Some(h.clamp(*INTERVAL_HOURS.start(), *INTERVAL_HOURS.end())),
                    Err(_) => bad(&mut p),
                },
                _ => continue,
            }
            any = true;
        }
        if any {
            p.origins.push(origin.to_string());
        }
        p
    }

    /// A `policy.json`: an object with the names of the docs (`"UpdateMode": "notify"`).
    pub fn from_json(origin: &str, text: &str) -> Result<Policy, String> {
        let v: serde_json::Value =
            serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("{origin}: {e}"))?;
        let obj = v.as_object().ok_or_else(|| format!("{origin}: not an object"))?;
        Ok(Policy::from_values(
            origin,
            obj.iter().filter_map(|(k, v)| {
                let value = match v {
                    serde_json::Value::String(s) => Value::Text(s.clone()),
                    serde_json::Value::Bool(b) => Value::Bool(*b),
                    serde_json::Value::Number(n) => Value::Number(n.as_i64()?),
                    _ => return None,
                };
                Some((k.clone(), value))
            }),
        ))
    }

    /// A macOS managed preferences plist (a configuration profile's payload).
    pub fn from_plist(origin: &str, bytes: &[u8]) -> Result<Policy, String> {
        let v = plist::Value::from_reader(std::io::Cursor::new(bytes)).map_err(|e| format!("{origin}: {e}"))?;
        let dict = v.as_dictionary().ok_or_else(|| format!("{origin}: not a dictionary"))?;
        Ok(Policy::from_values(
            origin,
            dict.iter().filter_map(|(k, v)| {
                let value = match v {
                    plist::Value::String(s) => Value::Text(s.clone()),
                    plist::Value::Boolean(b) => Value::Bool(*b),
                    plist::Value::Integer(i) => Value::Number(i.as_signed()?),
                    _ => return None,
                };
                Some((k.clone(), value))
            }),
        ))
    }

    /// `self` over `lower`: each value of `self` wins, the rest comes from `lower`.
    pub fn over(self, lower: Policy) -> Policy {
        Policy {
            update_mode: self.update_mode.or(lower.update_mode),
            update_url: self.update_url.or(lower.update_url),
            allow_github_fallback: self.allow_github_fallback.or(lower.allow_github_fallback),
            pinned_version: self.pinned_version.or(lower.pinned_version),
            install_window: self.install_window.or(lower.install_window),
            check_interval_hours: self.check_interval_hours.or(lower.check_interval_hours),
            origins: self.origins.into_iter().chain(lower.origins).collect(),
            warnings: self.warnings.into_iter().chain(lower.warnings).collect(),
        }
    }

    /// Merges sources given from the highest to the lowest priority.
    pub fn merge(layers: impl IntoIterator<Item = Policy>) -> Policy {
        layers
            .into_iter()
            .fold(None::<Policy>, |acc, p| {
                Some(match acc {
                    Some(high) => high.over(p),
                    None => p,
                })
            })
            .unwrap_or_default()
    }

    /// The names of the managed fields (Settings locks them).
    pub fn managed(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.update_mode.is_some() {
            out.push("mode");
        }
        if self.update_url.is_some() {
            out.push("source");
        }
        if self.allow_github_fallback.is_some() {
            out.push("github");
        }
        if self.pinned_version.is_some() {
            out.push("pinned");
        }
        if self.install_window.is_some() {
            out.push("window");
        }
        if self.check_interval_hours.is_some() {
            out.push("interval");
        }
        out
    }
}

/// The file name of a policy file.
pub const POLICY_FILE: &str = "policy.json";

/// The `policy.json` files, from the highest priority: next to the executable, then the
/// system folder (`%ProgramData%\MouseWerk\Arcalo`, `/Library/Application Support/MouseWerk/Arcalo`,
/// `/etc/arcalo`).
pub fn policy_files(exe_dir: Option<&Path>, system_dir: Option<&Path>) -> Vec<PathBuf> {
    exe_dir.into_iter().chain(system_dir).map(|d| d.join(POLICY_FILE)).collect()
}

/// The system folder for policy files on this platform.
pub fn system_policy_dir() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("ProgramData").map(|d| PathBuf::from(d).join("MouseWerk").join("Arcalo"))
    } else if cfg!(target_os = "macos") {
        Some(PathBuf::from("/Library/Application Support/MouseWerk/Arcalo"))
    } else {
        Some(PathBuf::from("/etc/arcalo"))
    }
}

/// Reads the policy files that exist (unreadable ones become warnings), highest priority first.
pub fn read_files(paths: &[PathBuf]) -> Vec<Policy> {
    paths
        .iter()
        .filter_map(|p| {
            let text = std::fs::read_to_string(p).ok()?;
            Some(
                Policy::from_json(&p.display().to_string(), &text)
                    .unwrap_or_else(|e| Policy { warnings: vec![e], ..Default::default() }),
            )
        })
        .collect()
}

/// The user's update settings (Settings → Über).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(default)]
pub struct UpdatePrefs {
    pub mode: UpdateMode,
    /// Own update source: a `latest.json` URL or a folder; blank = GitHub.
    pub source_url: String,
    /// Ask GitHub when the own source fails.
    pub allow_github_fallback: bool,
    pub check_interval_hours: u32,
    /// „Jetzt neu starten“ opens the same tabs again.
    pub restore_session: bool,
}

impl Default for UpdatePrefs {
    fn default() -> Self {
        UpdatePrefs {
            mode: UpdateMode::Auto,
            source_url: String::new(),
            allow_github_fallback: true,
            check_interval_hours: 6,
            restore_session: true,
        }
    }
}

/// What applies: the policy's values over the user's settings.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Effective {
    pub mode: UpdateMode,
    /// A policy switched updates off: not even a manual check.
    pub disabled: bool,
    pub source_url: Option<String>,
    pub allow_github_fallback: bool,
    pub pinned_version: Option<String>,
    pub install_window: Option<InstallWindow>,
    pub check_interval_hours: u32,
    pub managed: Vec<&'static str>,
}

/// `auto_check` is the setting from before 1.9 („Automatisch nach Updates suchen“): off means
/// no automatic checks, whatever the mode says.
pub fn effective(policy: &Policy, prefs: &UpdatePrefs, auto_check: bool) -> Effective {
    let user_mode = if auto_check { prefs.mode } else { UpdateMode::Off };
    let mode = policy.update_mode.unwrap_or(user_mode);
    Effective {
        mode,
        disabled: policy.update_mode == Some(UpdateMode::Off),
        source_url: policy
            .update_url
            .clone()
            .or_else(|| Some(prefs.source_url.trim().to_string()).filter(|s| !s.is_empty())),
        allow_github_fallback: policy.allow_github_fallback.unwrap_or(prefs.allow_github_fallback),
        pinned_version: policy.pinned_version.clone(),
        install_window: policy.install_window,
        check_interval_hours: policy
            .check_interval_hours
            .unwrap_or(prefs.check_interval_hours)
            .clamp(*INTERVAL_HOURS.start(), *INTERVAL_HOURS.end()),
        managed: policy.managed(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(h: u32, m: u32) -> NaiveTime {
        NaiveTime::from_hms_opt(h, m, 0).unwrap()
    }

    #[test]
    fn install_window_may_span_midnight() {
        let night = InstallWindow::parse("18:00-07:00").unwrap();
        assert!(
            night.contains(t(18, 0))
                && night.contains(t(23, 59))
                && night.contains(t(0, 0))
                && night.contains(t(6, 59))
        );
        assert!(!night.contains(t(7, 0)) && !night.contains(t(12, 0)) && !night.contains(t(17, 59)));
        let lunch = InstallWindow::parse(" 12:00 – 13:30 ").unwrap();
        assert!(
            lunch.contains(t(12, 0))
                && lunch.contains(t(13, 29))
                && !lunch.contains(t(13, 30))
                && !lunch.contains(t(11, 0))
        );
        assert_eq!(lunch.label(), "12:00–13:30");
        assert_eq!(InstallWindow::parse("08:00-08:00"), None);
        assert_eq!(InstallWindow::parse("25:00-07:00"), None);
        assert_eq!(InstallWindow::parse("abends"), None);
    }

    fn reg(pairs: &[(&str, Value)]) -> Vec<(String, Value)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    #[test]
    fn hklm_wins_over_hkcu_and_files_fill_the_rest() {
        let hklm = Policy::from_values(
            r"HKLM\Software\Policies\MouseWerk\Arcalo",
            reg(&[("UpdateMode", Value::Text("notify".into())), ("AllowGitHubFallback", Value::Number(0))]),
        );
        let hkcu = Policy::from_values(
            r"HKCU\Software\Policies\MouseWerk\Arcalo",
            reg(&[
                ("UpdateMode", Value::Text("auto".into())),
                ("UpdateUrl", Value::Text(r"\\server\share\arcalo".into())),
                ("CheckIntervalHours", Value::Number(2)),
            ]),
        );
        let file = Policy::from_json(
            "policy.json",
            r#"{"updatemode":"off","PinnedVersion":"v1.9.4","InstallWindow":"18:00-07:00","CheckIntervalHours":12,"Other":1}"#,
        )
        .unwrap();
        let p = Policy::merge([hklm, hkcu, file]);
        assert_eq!(p.update_mode, Some(UpdateMode::Notify), "HKLM wins");
        assert_eq!(p.allow_github_fallback, Some(false));
        assert_eq!(p.update_url.as_deref(), Some(r"\\server\share\arcalo"), "HKCU fills what HKLM leaves");
        assert_eq!(p.check_interval_hours, Some(2), "HKCU over the file");
        assert_eq!(p.pinned_version.as_deref(), Some("1.9.4"), "the file fills the rest");
        assert_eq!(p.install_window, InstallWindow::parse("18:00-07:00"));
        assert_eq!(p.origins.len(), 3);
        assert_eq!(p.managed(), ["mode", "source", "github", "pinned", "window", "interval"]);
        assert_eq!(Policy::merge([]), Policy::default());
    }

    #[test]
    fn invalid_values_are_warned_and_ignored() {
        let p = Policy::from_json(
            "policy.json",
            r#"{"UpdateMode":"sometimes","PinnedVersion":"neu","InstallWindow":"nachts","CheckIntervalHours":0,"AllowGitHubFallback":"vielleicht"}"#,
        )
        .unwrap();
        assert_eq!(p.update_mode, None);
        assert_eq!(p.pinned_version, None);
        assert_eq!(p.install_window, None);
        assert_eq!(p.allow_github_fallback, None);
        assert_eq!(p.check_interval_hours, Some(1), "clamped to an hour");
        assert_eq!(p.warnings.len(), 4);
        assert!(Policy::from_json("x", "[1]").is_err());
        assert!(Policy::from_json("x", "{").is_err());
        let empty = Policy::from_json("x", "{}").unwrap();
        assert!(empty.origins.is_empty() && empty.managed().is_empty());
    }

    #[test]
    fn managed_preferences_plist() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>UpdateMode</key><string>notify</string>
<key>AllowGitHubFallback</key><false/>
<key>CheckIntervalHours</key><integer>24</integer>
</dict></plist>"#;
        let p = Policy::from_plist("app.annalo.desktop.plist", xml).unwrap();
        assert_eq!(p.update_mode, Some(UpdateMode::Notify));
        assert_eq!(p.allow_github_fallback, Some(false));
        assert_eq!(p.check_interval_hours, Some(24));
    }

    #[test]
    fn policy_files_next_to_the_exe_win() {
        let dir = std::env::temp_dir().join(format!("annalo-policy-{}", std::process::id()));
        let (exe, sys) = (dir.join("exe"), dir.join("sys"));
        std::fs::create_dir_all(&exe).unwrap();
        std::fs::create_dir_all(&sys).unwrap();
        std::fs::write(exe.join(POLICY_FILE), r#"{"UpdateMode":"notify"}"#).unwrap();
        std::fs::write(sys.join(POLICY_FILE), r#"{"UpdateMode":"off","UpdateUrl":"https://corp/arcalo"}"#).unwrap();
        let p = Policy::merge(read_files(&policy_files(Some(&exe), Some(&sys))));
        assert_eq!(p.update_mode, Some(UpdateMode::Notify));
        assert_eq!(p.update_url.as_deref(), Some("https://corp/arcalo"));
        std::fs::write(exe.join(POLICY_FILE), "{broken").unwrap();
        let p = Policy::merge(read_files(&policy_files(Some(&exe), Some(&sys))));
        assert_eq!(p.update_mode, Some(UpdateMode::Off), "a broken file is skipped");
        assert_eq!(p.warnings.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn policy_values_override_the_settings() {
        let prefs = UpdatePrefs { source_url: " https://mine/latest.json ".into(), ..Default::default() };
        let e = effective(&Policy::default(), &prefs, true);
        assert_eq!(e.mode, UpdateMode::Auto);
        assert!(!e.disabled && e.managed.is_empty());
        assert_eq!(e.source_url.as_deref(), Some("https://mine/latest.json"));
        assert_eq!(e.check_interval_hours, 6);
        assert_eq!(effective(&Policy::default(), &prefs, false).mode, UpdateMode::Off, "the old switch still works");
        let policy = Policy {
            update_mode: Some(UpdateMode::Off),
            update_url: Some(r"\\srv\arcalo".into()),
            allow_github_fallback: Some(false),
            check_interval_hours: Some(24),
            ..Default::default()
        };
        let e = effective(&policy, &prefs, true);
        assert!(e.disabled && e.mode == UpdateMode::Off);
        assert_eq!(e.source_url.as_deref(), Some(r"\\srv\arcalo"));
        assert!(!e.allow_github_fallback);
        assert_eq!(e.check_interval_hours, 24);
        let user_interval = UpdatePrefs { check_interval_hours: 0, ..Default::default() };
        assert_eq!(effective(&Policy::default(), &user_interval, true).check_interval_hours, 1);
    }
}
