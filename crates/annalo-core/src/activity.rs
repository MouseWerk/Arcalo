//! Idle detection and active-window tracking.
//!
//! The OS-specific part is the [`ActivityProbe`] trait; on Windows it is
//! backed by `GetLastInputInfo` and `GetForegroundWindow`, on macOS by
//! CoreGraphics' event-source idle time and `NSWorkspace`. The bookkeeping
//! ([`IdleAccumulator`], [`WindowUsage`]) is platform independent and fed by
//! periodic samples from the shell (e.g. every 5 s).

use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowInfo {
    pub title: String,
    /// Executable name, e.g. `Code.exe`.
    pub process: String,
}

pub trait ActivityProbe: Send + Sync {
    /// Time since the last keyboard or mouse input.
    fn idle_duration(&self) -> Option<Duration>;
    /// The window that currently has focus.
    fn foreground_window(&self) -> Option<WindowInfo>;
}

/// Probe for platforms without an implementation; reports nothing.
pub struct NullProbe;

impl ActivityProbe for NullProbe {
    fn idle_duration(&self) -> Option<Duration> {
        None
    }
    fn foreground_window(&self) -> Option<WindowInfo> {
        None
    }
}

/// The best probe for the current platform.
pub fn system_probe() -> Box<dyn ActivityProbe> {
    #[cfg(windows)]
    {
        Box::new(win32::Win32Probe)
    }
    #[cfg(target_os = "macos")]
    {
        Box::new(macos::MacProbe)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Box::new(NullProbe)
    }
}

/// Accumulates idle time while a timer runs. Idle stretches shorter than
/// `threshold` count as work (reading, thinking); longer ones are subtracted
/// in full, from the last input on.
#[derive(Debug, Clone)]
pub struct IdleAccumulator {
    threshold: chrono::Duration,
    total: chrono::Duration,
    idle_since: Option<DateTime<Utc>>,
}

impl IdleAccumulator {
    /// Changes the threshold for idle periods that start from now on.
    pub fn set_threshold(&mut self, threshold: Duration) {
        self.threshold = chrono::Duration::from_std(threshold).unwrap_or(self.threshold);
    }

    pub fn new(threshold: Duration) -> Self {
        IdleAccumulator {
            threshold: chrono::Duration::from_std(threshold).unwrap_or(chrono::Duration::MAX),
            total: chrono::Duration::zero(),
            idle_since: None,
        }
    }

    /// Feeds one sample: at `now` the user has been idle for `idle_for`.
    pub fn observe(&mut self, now: DateTime<Utc>, idle_for: Duration) {
        let idle_for = chrono::Duration::from_std(idle_for).unwrap_or(chrono::Duration::zero());
        let last_input = now - idle_for;
        if idle_for >= self.threshold {
            // Keep the earliest start if the idle stretch was already known.
            self.idle_since.get_or_insert(last_input);
        } else if let Some(start) = self.idle_since.take() {
            // Input resumed; the idle stretch ended at the last input.
            self.total += (last_input - start).max(chrono::Duration::zero());
        }
    }

    /// True while the user is currently away.
    pub fn is_idle(&self) -> bool {
        self.idle_since.is_some()
    }

    /// Idle time so far, including an ongoing idle stretch up to `now`.
    pub fn idle_total(&self, now: DateTime<Utc>) -> chrono::Duration {
        self.total + self.idle_since.map_or(chrono::Duration::zero(), |s| (now - s).max(chrono::Duration::zero()))
    }

    pub fn idle_minutes(&self, now: DateTime<Utc>) -> i64 {
        self.idle_total(now).num_minutes()
    }

    pub fn reset(&mut self) {
        self.total = chrono::Duration::zero();
        self.idle_since = None;
    }
}

/// Time spent per foreground application, for automatic booking suggestions.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WindowUsage {
    per_process: HashMap<String, u64>,
}

impl WindowUsage {
    /// Credits `interval` to the focused window unless the user is idle.
    pub fn record(&mut self, window: Option<&WindowInfo>, idle: bool, interval: Duration) {
        if let (Some(w), false) = (window, idle) {
            *self.per_process.entry(w.process.clone()).or_default() += interval.as_secs();
        }
    }

    /// (process, seconds), most used first.
    pub fn top(&self, n: usize) -> Vec<(String, u64)> {
        let mut v: Vec<_> = self.per_process.iter().map(|(k, v)| (k.clone(), *v)).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v.truncate(n);
        v
    }
}

#[cfg(windows)]
mod win32 {
    use super::*;
    use windows_sys::Win32::Foundation::{CloseHandle, HWND};
    use windows_sys::Win32::System::SystemInformation::GetTickCount;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    };

    pub struct Win32Probe;

    impl ActivityProbe for Win32Probe {
        fn idle_duration(&self) -> Option<Duration> {
            let mut info = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            // SAFETY: `info` is a valid, correctly sized LASTINPUTINFO.
            if unsafe { GetLastInputInfo(&mut info) } == 0 {
                return None;
            }
            // SAFETY: no preconditions. Tick counts wrap after ~49 days; wrapping_sub handles it.
            let now = unsafe { GetTickCount() };
            Some(Duration::from_millis(u64::from(now.wrapping_sub(info.dwTime))))
        }

        fn foreground_window(&self) -> Option<WindowInfo> {
            // SAFETY: plain Win32 calls; every buffer is sized from the API's own length report.
            unsafe {
                let hwnd: HWND = GetForegroundWindow();
                if hwnd.is_null() {
                    return None;
                }
                let len = GetWindowTextLengthW(hwnd);
                let mut buf = vec![0u16; len.max(0) as usize + 1];
                let copied = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
                let title = String::from_utf16_lossy(&buf[..copied.max(0) as usize]);

                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, &mut pid);
                let mut process = String::new();
                let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if !handle.is_null() {
                    let mut path = vec![0u16; 1024];
                    let mut size = path.len() as u32;
                    if QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut size) != 0 {
                        let full = String::from_utf16_lossy(&path[..size as usize]);
                        process = full.rsplit('\\').next().unwrap_or(&full).to_owned();
                    }
                    CloseHandle(handle);
                }
                Some(WindowInfo { title, process })
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod macos {
    //! Plain C/Objective-C runtime calls instead of a binding crate: two framework
    //! functions and five messages are all the probe needs.
    use super::*;
    use std::ffi::{CStr, c_char, c_void};

    type Id = *mut c_void;
    type Sel = *const c_void;

    /// `kCGEventSourceStateCombinedSessionState`
    const COMBINED_SESSION_STATE: i32 = 0;
    /// `kCGAnyInputEventType` (`~0`)
    const ANY_INPUT_EVENT: u32 = u32::MAX;

    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    // NSWorkspace lives in AppKit; linking it makes sure the class is registered.
    #[link(name = "AppKit", kind = "framework")]
    unsafe extern "C" {}

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
        fn objc_autoreleasePoolPush() -> *mut c_void;
        fn objc_autoreleasePoolPop(pool: *mut c_void);
    }

    /// Sends a message without arguments that returns an object (or a C string).
    ///
    /// # Safety
    /// `receiver` must be nil or a valid object that responds to `selector` with a
    /// pointer-sized return value.
    unsafe fn send(receiver: Id, selector: &CStr) -> Id {
        if receiver.is_null() {
            return std::ptr::null_mut();
        }
        // SAFETY: objc_msgSend must be called through the exact prototype of the method
        // (here `id (*)(id, SEL)`), which is what the caller guarantees.
        unsafe {
            let f = std::mem::transmute::<unsafe extern "C" fn(), unsafe extern "C" fn(Id, Sel) -> Id>(objc_msgSend);
            f(receiver, sel_registerName(selector.as_ptr()))
        }
    }

    /// Reads an `NSString` as UTF-8.
    ///
    /// # Safety
    /// `string` must be nil or a valid `NSString`.
    unsafe fn string(string: Id) -> Option<String> {
        // SAFETY: `UTF8String` returns a NUL-terminated buffer owned by the string (or the
        // current autorelease pool), valid until the pool is drained.
        unsafe {
            let utf8 = send(string, c"UTF8String") as *const c_char;
            (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
        }
    }

    pub struct MacProbe;

    impl ActivityProbe for MacProbe {
        fn idle_duration(&self) -> Option<Duration> {
            // SAFETY: a pure query without pointers; needs no special permission.
            let secs = unsafe { CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT) };
            (secs.is_finite() && secs >= 0.0).then(|| Duration::from_secs_f64(secs))
        }

        /// The frontmost application. Window titles would need the accessibility
        /// permission, so the title is the application name as well.
        fn foreground_window(&self) -> Option<WindowInfo> {
            // SAFETY: every message goes to nil or to an object of the documented class
            // (NSWorkspace → NSRunningApplication → NSString/NSURL), all returning objects.
            // The pool releases the autoreleased results of this background thread.
            unsafe {
                let pool = objc_autoreleasePoolPush();
                let workspace = send(objc_getClass(c"NSWorkspace".as_ptr()), c"sharedWorkspace");
                let app = send(workspace, c"frontmostApplication");
                let name = string(send(app, c"localizedName"));
                let exe = string(send(send(app, c"executableURL"), c"lastPathComponent"));
                objc_autoreleasePoolPop(pool);
                let process = exe.or_else(|| name.clone())?;
                Some(WindowInfo { title: name.unwrap_or_else(|| process.clone()), process })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn short_pauses_count_as_work_long_ones_are_subtracted() {
        let t0 = Utc.with_ymd_and_hms(2026, 9, 23, 9, 0, 0).unwrap();
        let at = |min: i64| t0 + chrono::Duration::minutes(min);
        let m = |min: u64| Duration::from_secs(min * 60);
        let mut acc = IdleAccumulator::new(m(5));

        acc.observe(at(10), m(3)); // short pause
        acc.observe(at(20), m(0));
        assert_eq!(acc.idle_minutes(at(20)), 0);

        acc.observe(at(30), m(6)); // away since 09:24
        assert!(acc.is_idle());
        acc.observe(at(40), m(16)); // still away
        assert_eq!(acc.idle_minutes(at(40)), 16);
        acc.observe(at(50), m(2)); // input at 09:48 → idle 09:24..09:48
        assert!(!acc.is_idle());
        assert_eq!(acc.idle_minutes(at(60)), 24);
    }

    #[test]
    fn window_usage_ignores_idle_samples() {
        let code = WindowInfo { title: "main.rs".into(), process: "Code.exe".into() };
        let teams = WindowInfo { title: "Call".into(), process: "Teams.exe".into() };
        let mut u = WindowUsage::default();
        let s = Duration::from_secs(5);
        u.record(Some(&code), false, s);
        u.record(Some(&code), false, s);
        u.record(Some(&teams), false, s);
        u.record(Some(&teams), true, s);
        u.record(None, false, s);
        assert_eq!(u.top(5), vec![("Code.exe".into(), 10), ("Teams.exe".into(), 5)]);
    }

    /// The probes run in CI on every platform: they must answer (or decline) without crashing.
    #[test]
    fn system_probe_answers() {
        let probe = system_probe();
        let idle = probe.idle_duration();
        let _ = probe.foreground_window();
        #[cfg(target_os = "macos")]
        assert!(idle.is_some(), "CoreGraphics reports the idle time");
        let _ = idle;
    }
}
