//! The main window's backdrop (Settings → Darstellung „Hintergrundeffekt“): Mica or Acrylic on
//! Windows 11. The window is transparent only where an effect is possible, so the backdrop
//! never shows the bare desktop: Windows 10, macOS and Linux keep an opaque window and offer
//! no effect. The UI paints the theme over the effect at the chosen opacity (`lib/backdrop.ts`).

use annalo_core::prefs::WindowEffect;
use serde::Serialize;

/// Test-only: reports both effects as available and the chosen one as active without touching
/// the window, so the UI's backdrop styles can be checked where no effect exists (Linux e2e).
const SIMULATE_ENV: &str = "ANNALO_TEST_BACKDROP";

/// What the window offers and shows, for the UI.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Backdrop {
    /// Effects this system can show (`mica`, `acrylic`); empty: the window is always opaque.
    pub effects: Vec<&'static str>,
    /// The effect the window shows now (`none` when off or not available).
    pub active: &'static str,
}

/// Windows build number (0 elsewhere).
#[cfg(windows)]
fn windows_build() -> u32 {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: `info` is a valid, correctly sized OSVERSIONINFOW.
    if unsafe { RtlGetVersion(&mut info) } == 0 { info.dwBuildNumber } else { 0 }
}

#[cfg(not(windows))]
fn windows_build() -> u32 {
    0
}

fn simulated() -> bool {
    std::env::var_os(SIMULATE_ENV).is_some_and(|v| v == "1")
}

/// Effects a Windows build can show. Mica: Windows 11 (22000+). Acrylic only where Windows
/// draws it as a system backdrop (22523+); the older way lags while the window is dragged.
/// Windows 10 gets none (and an opaque window).
pub fn effects_for_build(build: u32) -> Vec<WindowEffect> {
    let mut out = vec![];
    if build >= 22000 {
        out.push(WindowEffect::Mica);
    }
    if build >= 22523 {
        out.push(WindowEffect::Acrylic);
    }
    out
}

/// Effects of this system (both when simulated).
pub fn supported() -> Vec<WindowEffect> {
    if simulated() { vec![WindowEffect::Mica, WindowEffect::Acrylic] } else { effects_for_build(windows_build()) }
}

/// Whether the window must be created transparent (an effect is possible here). Not when only
/// simulated: there nothing would fill the transparent window.
#[cfg(windows)]
pub fn transparent_window() -> bool {
    !simulated() && !effects_for_build(windows_build()).is_empty()
}

/// The effect shown for a setting: the setting when this system has it, else none.
pub fn resolve(setting: WindowEffect, supported: &[WindowEffect]) -> WindowEffect {
    if supported.contains(&setting) { setting } else { WindowEffect::None }
}

pub fn state(setting: WindowEffect) -> Backdrop {
    let supported = supported();
    Backdrop { effects: supported.iter().map(|e| e.as_str()).collect(), active: resolve(setting, &supported).as_str() }
}

/// The native effect for the window (the Mica variant follows the app's theme).
#[cfg(windows)]
fn native(effect: WindowEffect, dark: Option<bool>) -> Option<tauri::window::Effect> {
    use tauri::window::Effect;
    match (effect, dark) {
        (WindowEffect::None, _) => None,
        (WindowEffect::Mica, None) => Some(Effect::Mica),
        (WindowEffect::Mica, Some(true)) => Some(Effect::MicaDark),
        (WindowEffect::Mica, Some(false)) => Some(Effect::MicaLight),
        (WindowEffect::Acrylic, _) => Some(Effect::Acrylic),
    }
}

/// The effect the window was created with (its theme is not known yet).
#[cfg(windows)]
pub fn initial(setting: WindowEffect) -> Option<tauri::utils::config::WindowEffectsConfig> {
    if !transparent_window() {
        return None;
    }
    let effect = resolve(setting, &supported());
    *APPLIED.lock().unwrap_or_else(|e| e.into_inner()) = Some(effect);
    Some(tauri::utils::config::WindowEffectsConfig { effects: vec![native(effect, None)?], ..Default::default() })
}

/// The last effect applied to the main window, so a change of kind clears the old one first.
#[cfg(windows)]
static APPLIED: std::sync::Mutex<Option<WindowEffect>> = std::sync::Mutex::new(None);

/// Shows `setting` (or nothing) on the window, in the variant for a dark or light theme.
pub fn apply(window: &tauri::WebviewWindow, setting: WindowEffect, dark: bool) -> Backdrop {
    let state = state(setting);
    #[cfg(windows)]
    if transparent_window() {
        let effect = resolve(setting, &supported());
        let mut applied = APPLIED.lock().unwrap_or_else(|e| e.into_inner());
        // Only `None` clears an effect (an empty effect list leaves the old one on).
        if *applied != Some(effect) {
            let _ = window.set_effects(None::<tauri::utils::config::WindowEffectsConfig>);
        }
        let set = |e: tauri::window::Effect| {
            let _ = window
                .set_effects(tauri::utils::config::WindowEffectsConfig { effects: vec![e], ..Default::default() });
        };
        // Acrylic takes its light or dark look from the window's dark-mode flag, which the Mica
        // variant sets (`set_theme` would also switch the page's color scheme, and with it
        // „System“ would stop following Windows).
        if effect == WindowEffect::Acrylic
            && let Some(variant) = native(WindowEffect::Mica, Some(dark))
        {
            set(variant);
        }
        if let Some(e) = native(effect, Some(dark)) {
            set(e);
        }
        *applied = Some(effect);
    }
    let _ = (window, dark);
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn effects_by_windows_build() {
        // Windows 10, Linux and macOS (build 0): no effect, the window stays opaque.
        assert!(effects_for_build(0).is_empty());
        assert!(effects_for_build(19045).is_empty());
        // Windows 11 21H2: Mica; Acrylic from the build that draws it as a system backdrop.
        assert_eq!(effects_for_build(22000), [WindowEffect::Mica]);
        assert_eq!(effects_for_build(22631), [WindowEffect::Mica, WindowEffect::Acrylic]);
    }

    #[test]
    fn a_setting_the_system_lacks_shows_nothing() {
        let win11 = effects_for_build(22631);
        assert_eq!(resolve(WindowEffect::Acrylic, &win11), WindowEffect::Acrylic);
        assert_eq!(resolve(WindowEffect::Mica, &effects_for_build(19045)), WindowEffect::None);
        assert_eq!(resolve(WindowEffect::Acrylic, &effects_for_build(22000)), WindowEffect::None);
        assert_eq!(resolve(WindowEffect::None, &win11), WindowEffect::None);
    }
}
