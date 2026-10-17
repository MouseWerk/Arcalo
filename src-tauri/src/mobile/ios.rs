//! iOS (iPhone and iPad): UIKit, BackgroundTasks and CFNetwork through the Objective-C runtime, so
//! the generated Xcode project needs no Swift of its own (docs/ios.md). Where Android has a Kotlin
//! plugin (`android.rs`), iOS has a function here:
//!
//! - **The device.** Whether it is an iPad (`UIDevice.userInterfaceIdiom`), for the choice between
//!   the phone app and the full app (`ui/src/lib/uimode.ts`); the sizes come from the WebView.
//! - **The WebView.** It fills the window's safe area, so no page, dialog or overlay reaches under
//!   the status bar, the notch or the home indicator; the margins take the page's colors.
//! - **Files.** The document picker answers with `file://` addresses outside the app's sandbox:
//!   they are read and written inside `startAccessingSecurityScopedResource` ([`with_scope`]).
//! - **The share sheet.** „Öffnen“ on an attachment shows `UIActivityViewController` with a copy:
//!   another app, „In Dateien sichern“, AirDrop, print ([`share_file`]).
//! - **Shared to the app.** A text or Markdown file opened with Arcalo („Teilen“ → Arcalo, „Öffnen
//!   in“) and `arcalo://capture?text=…` (Shortcuts) arrive as `RunEvent::Opened` ([`opened`]); the
//!   phone app opens a capture with the text, as on Android.
//! - **Background sync.** A `BGAppRefreshTask`, registered before the launch ends and asked for
//!   again after every run (at the earliest after 15 minutes; iOS decides when, often hours
//!   later). It runs the same sync as the timer of the open app for at most 25 seconds.
//! - **Notifications.** Posted to `UNUserNotificationCenter` directly (the permission is asked
//!   with the first one). The end of a focus session carries „+5 Min.“ and „Pause“, which act in
//!   the background, the morning briefing „Öffnen“; a delegate hands the pressed button to
//!   [`super::notification_action`] and shows notifications while the app is in front, too.
//! - **Proxy.** The proxy of the Wi-Fi in use (`CFNetworkCopySystemProxySettings`) for the Git
//!   sync's mode „System“, as Android's.
//! - **Simulator check** (debug builds started with `ARCALO_SMOKE=1`): the geometry of the page
//!   as JSON in the data folder, read by .github/workflows/ios.yml.

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use block2::{Block, RcBlock};
use dispatch2::DispatchQueue;
use objc2::encode::{Encode, Encoding};
use objc2::msg_send;
use objc2::rc::{Retained, autoreleasepool};
use objc2::runtime::{AnyClass, AnyObject, Bool, NSObject};
use objc2::{ClassType, define_class};
use tauri::{AppHandle, Manager};

use crate::{AppState, devlog, lock};

/// The background task's identifier (also in `Info.ios.plist`, BGTaskSchedulerPermittedIdentifiers).
const TASK: &str = "de.mousewerk.arcalo.sync";
/// Background app refresh gives about 30 seconds.
const BACKGROUND_BUDGET: Duration = Duration::from_secs(25);
/// The earliest next background sync.
const NEXT_SYNC_SECS: f64 = 15.0 * 60.0;
/// `UIUserInterfaceIdiomPad`.
const IDIOM_PAD: isize = 1;
/// `UIScrollViewContentInsetAdjustmentNever`.
const INSETS_NEVER: isize = 2;
/// The scheme of `arcalo://capture?text=…` (CFBundleURLTypes in `Info.ios.plist`).
const SCHEME: &str = "arcalo";
/// The most text taken from a file shared to the app.
const SHARED_MAX: u64 = 256 * 1024;

static APP: OnceLock<AppHandle> = OnceLock::new();
static IPAD: AtomicBool = AtomicBool::new(false);
/// Text shared to the app and not taken by the UI yet (the newest last).
static SHARED: Mutex<Vec<String>> = Mutex::new(Vec::new());

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct CGRect {
    origin: CGPoint,
    size: CGSize,
}

// SAFETY: the layouts are those of CoreGraphics on 64-bit iOS (CGFloat is a double).
unsafe impl Encode for CGPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
// SAFETY: as above.
unsafe impl Encode for CGSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
// SAFETY: as above.
unsafe impl Encode for CGRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[CGPoint::ENCODING, CGSize::ENCODING]);
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct UIEdgeInsets {
    top: f64,
    left: f64,
    bottom: f64,
    right: f64,
}

// SAFETY: the layout of UIKit's UIEdgeInsets on 64-bit iOS.
unsafe impl Encode for UIEdgeInsets {
    const ENCODING: Encoding =
        Encoding::Struct("UIEdgeInsets", &[f64::ENCODING, f64::ENCODING, f64::ENCODING, f64::ENCODING]);
}

fn class(name: &CStr) -> Option<&'static AnyClass> {
    AnyClass::get(name)
}

/// An `NSString`.
fn ns_string(s: &str) -> Retained<AnyObject> {
    let c = CString::new(s.replace('\0', "")).unwrap_or_default();
    // SAFETY: a valid C string; the class method returns an autoreleased string, retained here.
    unsafe { msg_send![class(c"NSString").expect("Foundation"), stringWithUTF8String: c.as_ptr()] }
}

/// The text of an `NSString` (none for nil).
fn rust_string(s: *mut AnyObject) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // SAFETY: `s` is an NSString; UTF8String lives as long as the string.
    let p: *const std::ffi::c_char = unsafe { msg_send![s, UTF8String] };
    (!p.is_null()).then(|| unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

fn shared_application() -> *mut AnyObject {
    match class(c"UIApplication") {
        // SAFETY: the shared application exists once UIKit runs.
        Some(c) => unsafe { msg_send![c, sharedApplication] },
        None => std::ptr::null_mut(),
    }
}

/// The app's window in front (main thread).
fn key_window() -> *mut AnyObject {
    let app = shared_application();
    if app.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: on the main thread; `windows` is an NSArray of UIWindow.
    unsafe {
        let windows: *mut AnyObject = msg_send![app, windows];
        if windows.is_null() {
            return std::ptr::null_mut();
        }
        let count: usize = msg_send![windows, count];
        for i in 0..count {
            let w: *mut AnyObject = msg_send![windows, objectAtIndex: i];
            let key: bool = msg_send![w, isKeyWindow];
            if key {
                return w;
            }
        }
        msg_send![windows, firstObject]
    }
}

/// The view controller on top, to present a sheet from (main thread).
fn top_controller() -> *mut AnyObject {
    let window = key_window();
    if window.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: on the main thread; walks `presentedViewController` up from the root.
    unsafe {
        let mut vc: *mut AnyObject = msg_send![window, rootViewController];
        while !vc.is_null() {
            let next: *mut AnyObject = msg_send![vc, presentedViewController];
            if next.is_null() {
                break;
            }
            vc = next;
        }
        vc
    }
}

// ---------------------------------------------------------------------------- start

/// In the app's setup, on the main thread: the device, the WebView, the background sync's
/// first request and the notification buttons.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    if let Some(device) = class(c"UIDevice") {
        // SAFETY: on the main thread (Tauri's setup).
        let idiom: isize = unsafe {
            let current: *mut AnyObject = msg_send![device, currentDevice];
            msg_send![current, userInterfaceIdiom]
        };
        IPAD.store(idiom == IDIOM_PAD, Ordering::Relaxed);
    }
    if let Some(w) = app.get_webview_window("main") {
        fit_webview(&w);
    }
    schedule_background();
    register_categories();
    smoke::start(app);
}

/// The WebView fills the safe area of the window (Auto Layout on the safe-area guide): nothing
/// of either page, its dialogs and overlays included, sits under the status bar, the notch, the
/// home indicator or the rounded corners, upright and sideways. Around it the window shows the
/// app's background ([`set_bars`]).
pub fn fit_webview(w: &tauri::WebviewWindow) {
    let done = w.with_webview(|pw| {
        let webview = pw.inner() as *mut AnyObject;
        if webview.is_null() {
            return;
        }
        // SAFETY: `inner` is the WKWebView, on the main thread (with_webview runs there); the
        // documented UIView and NSLayoutAnchor API.
        unsafe {
            let scroll: *mut AnyObject = msg_send![webview, scrollView];
            if !scroll.is_null() {
                let _: () = msg_send![scroll, setContentInsetAdjustmentBehavior: INSETS_NEVER];
            }
            let parent: *mut AnyObject = msg_send![webview, superview];
            if parent.is_null() {
                devlog::warn("ios", "the WebView has no superview, not fitted to the safe area");
                return;
            }
            if let Some(color_class) = class(c"UIColor") {
                let color: *mut AnyObject = msg_send![color_class, colorNamed: &*ns_string("LaunchBackground")];
                if !color.is_null() {
                    let _: () = msg_send![parent, setBackgroundColor: color];
                }
            }
            let guide: *mut AnyObject = msg_send![parent, safeAreaLayoutGuide];
            let _: () = msg_send![webview, setTranslatesAutoresizingMaskIntoConstraints: false];
            let pairs: [(*mut AnyObject, *mut AnyObject); 4] = [
                (msg_send![webview, topAnchor], msg_send![guide, topAnchor]),
                (msg_send![webview, bottomAnchor], msg_send![guide, bottomAnchor]),
                (msg_send![webview, leadingAnchor], msg_send![guide, leadingAnchor]),
                (msg_send![webview, trailingAnchor], msg_send![guide, trailingAnchor]),
            ];
            for (a, b) in pairs {
                let c: *mut AnyObject = msg_send![a, constraintEqualToAnchor: b];
                let _: () = msg_send![c, setActive: true];
            }
        }
    });
    if let Err(e) = done {
        devlog::warn("ios", format!("WebView not fitted to the safe area: {e}"));
    }
}

/// The tag of the view under the home indicator ([`set_bars`]).
const BOTTOM_TAG: isize = 0xA2C0;

/// The margins around the WebView follow the app's theme (`#rrggbb`, from the pages through
/// `mobile_bars`): `top` behind the status bar and at the sides, `bottom` under the home indicator
/// (the phone app's tab bar); the status bar's text is dark or light after the theme.
pub fn set_bars(app: &AppHandle, dark: bool, top: &str, bottom: &str) {
    fn rgb(hex: &str) -> Option<(f64, f64, f64)> {
        let h = hex.trim().trim_start_matches('#');
        let v = u32::from_str_radix(h, 16).ok().filter(|_| h.len() == 6)?;
        Some((((v >> 16) & 0xff) as f64 / 255.0, ((v >> 8) & 0xff) as f64 / 255.0, (v & 0xff) as f64 / 255.0))
    }
    let (Some(top), Some(bottom)) = (rgb(top), rgb(bottom)) else { return };
    let Some(w) = app.get_webview_window("main") else { return };
    let _ = w.with_webview(move |pw| {
        let webview = pw.inner() as *mut AnyObject;
        let (Some(color_class), Some(view_class)) = (class(c"UIColor"), class(c"UIView")) else { return };
        if webview.is_null() {
            return;
        }
        // SAFETY: on the main thread; the documented UIColor, UIView, NSLayoutAnchor and UIWindow API.
        unsafe {
            let color = |(r, g, b): (f64, f64, f64)| -> *mut AnyObject {
                msg_send![color_class, colorWithRed: r, green: g, blue: b, alpha: 1.0f64]
            };
            let parent: *mut AnyObject = msg_send![webview, superview];
            if !parent.is_null() {
                let _: () = msg_send![parent, setBackgroundColor: color(top)];
                let mut below: *mut AnyObject = msg_send![parent, viewWithTag: BOTTOM_TAG];
                if below.is_null() {
                    let view: *mut AnyObject = msg_send![view_class, new];
                    let _: () = msg_send![view, setTag: BOTTOM_TAG];
                    let _: () = msg_send![view, setTranslatesAutoresizingMaskIntoConstraints: false];
                    let _: () = msg_send![parent, addSubview: view];
                    let guide: *mut AnyObject = msg_send![parent, safeAreaLayoutGuide];
                    let pairs: [(*mut AnyObject, *mut AnyObject); 4] = [
                        (msg_send![view, topAnchor], msg_send![guide, bottomAnchor]),
                        (msg_send![view, bottomAnchor], msg_send![parent, bottomAnchor]),
                        (msg_send![view, leadingAnchor], msg_send![parent, leadingAnchor]),
                        (msg_send![view, trailingAnchor], msg_send![parent, trailingAnchor]),
                    ];
                    for (a, b) in pairs {
                        let c: *mut AnyObject = msg_send![a, constraintEqualToAnchor: b];
                        let _: () = msg_send![c, setActive: true];
                    }
                    // `new` returned it retained; the parent keeps it now.
                    let _ = Retained::from_raw(view);
                    below = view;
                }
                let _: () = msg_send![below, setBackgroundColor: color(bottom)];
            }
            let window: *mut AnyObject = msg_send![webview, window];
            if !window.is_null() {
                // UIUserInterfaceStyleDark / Light: the status bar's text after the theme.
                let _: () = msg_send![window, setOverrideUserInterfaceStyle: if dark { 2isize } else { 1isize }];
            }
        }
    });
}

/// Whether this is an iPad (the full app's choice uses the window's width there).
pub fn is_ipad() -> bool {
    IPAD.load(Ordering::Relaxed)
}

/// The facts the UI chooses the interface with: the sizes come from the WebView itself.
pub fn display() -> super::android::DisplayFacts {
    super::android::DisplayFacts { ipad: is_ipad(), ..Default::default() }
}

// ---------------------------------------------------------------------------- files

/// Runs `f` with the local path of a `file://` address the document picker gave, inside its
/// security scope (outside the sandbox the address only works within it). A plain path is used
/// as it is.
pub fn with_scope<T>(address: &str, f: impl FnOnce(&Path) -> T) -> Result<T, String> {
    let address = address.trim();
    if !address.starts_with("file:") {
        return Ok(f(Path::new(address)));
    }
    let url_class = class(c"NSURL").ok_or("Foundation is missing")?;
    autoreleasepool(|_| {
        // SAFETY: the documented NSURL API; the scope is ended below whenever it was started.
        unsafe {
            let url: *mut AnyObject = msg_send![url_class, URLWithString: &*ns_string(address)];
            if url.is_null() {
                return Err(format!("not a file address: {address}"));
            }
            let path: *mut AnyObject = msg_send![url, path];
            let path = rust_string(path).filter(|p| !p.is_empty()).ok_or("the address names no file")?;
            let scoped: bool = msg_send![url, startAccessingSecurityScopedResource];
            let out = f(Path::new(&path));
            if scoped {
                let _: () = msg_send![url, stopAccessingSecurityScopedResource];
            }
            Ok(out)
        }
    })
}

/// Shows the share sheet with a copy of `file` (in the cache's `open` folder): another app,
/// saving it in Files, AirDrop, printing.
pub fn share_file(cache: &Path, file: &Path) -> Result<(), String> {
    let dir = cache.join("open");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    let copy = dir.join(crate::picked::safe_name(&name));
    std::fs::copy(file, &copy).map_err(|e| e.to_string())?;
    let path = copy.to_string_lossy().into_owned();
    DispatchQueue::main().exec_async(move || {
        autoreleasepool(|_| {
            if let Err(e) = present_share(&path) {
                devlog::warn("ios", format!("share sheet not shown: {e}"));
            }
        })
    });
    Ok(())
}

fn present_share(path: &str) -> Result<(), String> {
    let (Some(url_class), Some(array_class), Some(sheet_class)) =
        (class(c"NSURL"), class(c"NSArray"), class(c"UIActivityViewController"))
    else {
        return Err("UIKit is missing".into());
    };
    let top = top_controller();
    if top.is_null() {
        return Err("no window".into());
    }
    // SAFETY: the documented UIActivityViewController API, on the main thread. On the iPad the
    // sheet is a popover and needs a source (the middle of the window), else UIKit stops the app.
    unsafe {
        let url: *mut AnyObject = msg_send![url_class, fileURLWithPath: &*ns_string(path)];
        let items: *mut AnyObject = msg_send![array_class, arrayWithObject: url];
        let allocated: *mut AnyObject = msg_send![sheet_class, alloc];
        let sheet: *mut AnyObject = msg_send![
            allocated,
            initWithActivityItems: items,
            applicationActivities: std::ptr::null_mut::<AnyObject>()
        ];
        let sheet = Retained::from_raw(sheet).ok_or("no share sheet")?;
        let popover: *mut AnyObject = msg_send![&*sheet, popoverPresentationController];
        if !popover.is_null() {
            let view: *mut AnyObject = msg_send![top, view];
            let bounds: CGRect = msg_send![view, bounds];
            let mid = CGRect {
                origin: CGPoint { x: bounds.size.width / 2.0, y: bounds.size.height / 2.0 },
                size: CGSize::default(),
            };
            let _: () = msg_send![popover, setSourceView: view];
            let _: () = msg_send![popover, setSourceRect: mid];
            // No arrow: the sheet stands in the middle.
            let _: () = msg_send![popover, setPermittedArrowDirections: 0usize];
        }
        let no_completion: Option<&Block<dyn Fn()>> = None;
        let _: () = msg_send![top, presentViewController: &*sheet, animated: true, completion: no_completion];
    }
    Ok(())
}

// ---------------------------------------------------------------------------- shared to the app

/// Addresses iOS opened the app with: `arcalo://capture?text=…`, or a file shared to it (a copy
/// in the app's Inbox folder, or a security-scoped address of a file opened in place).
pub fn opened(urls: &[tauri::Url]) {
    for url in urls {
        let text = match url.scheme() {
            SCHEME => url.query_pairs().find(|(k, _)| k == "text").map(|(_, v)| v.into_owned()),
            "file" => match with_scope(url.as_str(), read_shared) {
                Ok(Ok(t)) => Some(t),
                Ok(Err(e)) | Err(e) => {
                    devlog::warn("ios", format!("shared file not read: {e}"));
                    None
                }
            },
            other => {
                devlog::info("ios", format!("opened with an address of scheme {other}, ignored"));
                None
            }
        };
        if let Some(t) = text.filter(|t| !t.trim().is_empty()) {
            devlog::info("ios", format!("{} characters shared to the app", t.chars().count()));
            lock(&SHARED).push(t);
        }
    }
}

/// The text of a shared file (UTF-8, at most [`SHARED_MAX`] bytes).
fn read_shared(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(SHARED_MAX).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "not a text file".to_owned())
}

/// The text shared to the app since the last call, once (several are joined).
pub fn shared_text() -> Option<String> {
    let mut list = lock(&SHARED);
    if list.is_empty() {
        return None;
    }
    Some(std::mem::take(&mut *list).join("\n\n"))
}

// ---------------------------------------------------------------------------- notifications

/// `UNNotificationDefaultActionIdentifier`: the notification itself was tapped.
const DEFAULT_ACTION: &str = "com.apple.UNNotificationDefaultActionIdentifier";
/// `UNNotificationActionOptionForeground`.
const OPTION_FOREGROUND: usize = 1 << 2;
/// `UNNotificationPresentationOptionSound | List | Banner`.
const PRESENT: usize = (1 << 1) | (1 << 3) | (1 << 4);
/// `UNAuthorizationOptionBadge | Sound | Alert`.
const AUTHORIZE: usize = (1 << 0) | (1 << 1) | (1 << 2);

define_class!(
    // SAFETY: NSObject has no subclassing requirements; no Drop.
    #[unsafe(super(NSObject))]
    #[name = "ArcaloNotificationDelegate"]
    /// The notification center's delegate: the pressed buttons, and notifications shown while
    /// the app is in front.
    struct NotificationDelegate;

    impl NotificationDelegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(&self, _center: *mut AnyObject, _note: *mut AnyObject, done: *mut Block<dyn Fn(usize)>) {
            // SAFETY: the system hands a valid block.
            if let Some(done) = unsafe { done.as_ref() } {
                done.call((PRESENT,));
            }
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(&self, _center: *mut AnyObject, response: *mut AnyObject, done: *mut Block<dyn Fn()>) {
            // SAFETY: `response` is a UNNotificationResponse.
            let action = unsafe {
                if response.is_null() {
                    None
                } else {
                    let id: *mut AnyObject = msg_send![response, actionIdentifier];
                    rust_string(id)
                }
            };
            if let Some(action) = action {
                let action = if action == DEFAULT_ACTION { "tap".to_owned() } else { action };
                // Off the main thread: the actions touch the database and the timer.
                std::thread::spawn(move || {
                    if let Some(app) = APP.get() {
                        super::notification_action(app, &action);
                    }
                });
            }
            // SAFETY: the system hands a valid block.
            if let Some(done) = unsafe { done.as_ref() } {
                done.call(());
            }
        }
    }
);

thread_local! {
    /// The delegate (the center keeps it weakly), main thread only.
    static DELEGATE: RefCell<Option<Retained<AnyObject>>> = const { RefCell::new(None) };
}

/// The buttons of the notifications (categories) and the delegate; in the setup, on the main
/// thread.
fn register_categories() {
    let (Some(center_class), Some(action_class), Some(category_class), Some(set_class), Some(array_class)) = (
        class(c"UNUserNotificationCenter"),
        class(c"UNNotificationAction"),
        class(c"UNNotificationCategory"),
        class(c"NSSet"),
        class(c"NSArray"),
    ) else {
        return;
    };
    autoreleasepool(|_| {
        // SAFETY: the documented UserNotifications API (iOS 10+), on the main thread.
        unsafe {
            let action = |id: &str, title: &str, options: usize| -> *mut AnyObject {
                msg_send![action_class, actionWithIdentifier: &*ns_string(id), title: &*ns_string(title), options: options]
            };
            let empty: *mut AnyObject = msg_send![array_class, array];
            let category = |id: &str, actions: &[*mut AnyObject]| -> *mut AnyObject {
                let list: *mut AnyObject =
                    msg_send![array_class, arrayWithObjects: actions.as_ptr(), count: actions.len()];
                msg_send![
                    category_class,
                    categoryWithIdentifier: &*ns_string(id),
                    actions: list,
                    intentIdentifiers: empty,
                    options: 0usize
                ]
            };
            let categories = [
                category(
                    crate::notifyact::CATEGORY_FOCUS,
                    &[
                        action(crate::notifyact::ACTION_EXTEND, arcalo_core::tr!("+5 Min.", "+5 min"), 0),
                        action(crate::notifyact::ACTION_PAUSE, arcalo_core::tr!("Pause", "Break"), 0),
                    ],
                ),
                category(
                    crate::notifyact::CATEGORY_BRIEFING,
                    &[action(crate::notifyact::ACTION_OPEN, arcalo_core::tr!("Öffnen", "Open"), OPTION_FOREGROUND)],
                ),
            ];
            let list: *mut AnyObject =
                msg_send![array_class, arrayWithObjects: categories.as_ptr(), count: categories.len()];
            let set: *mut AnyObject = msg_send![set_class, setWithArray: list];
            let center: *mut AnyObject = msg_send![center_class, currentNotificationCenter];
            let _: () = msg_send![center, setNotificationCategories: set];
            let delegate: Retained<AnyObject> = msg_send![NotificationDelegate::class(), new];
            let _: () = msg_send![center, setDelegate: &*delegate];
            DELEGATE.with(|d| *d.borrow_mut() = Some(delegate));
        }
    });
}

/// Shows a notification now; `category` names its buttons. The first one asks for the
/// permission, and is shown when it was given.
pub fn notify(title: &str, body: &str, category: Option<&'static str>) {
    let Some(center_class) = class(c"UNUserNotificationCenter") else { return };
    let (title, body) = (title.to_owned(), body.to_owned());
    let asked = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
        if granted.as_bool() {
            autoreleasepool(|_| post(&title, &body, category));
        } else {
            devlog::info("ios", "notification not shown: not allowed");
        }
    });
    // SAFETY: the documented authorization call (iOS 10+); it answers at once once decided and
    // copies the block. It may be used from any thread.
    unsafe {
        let center: *mut AnyObject = msg_send![center_class, currentNotificationCenter];
        let _: () = msg_send![center, requestAuthorizationWithOptions: AUTHORIZE, completionHandler: &*asked];
    }
}

fn post(title: &str, body: &str, category: Option<&str>) {
    let (Some(center_class), Some(content_class), Some(request_class), Some(uuid_class)) = (
        class(c"UNUserNotificationCenter"),
        class(c"UNMutableNotificationContent"),
        class(c"UNNotificationRequest"),
        class(c"NSUUID"),
    ) else {
        return;
    };
    // SAFETY: the documented UserNotifications API; it may be used from any thread.
    unsafe {
        let content: Retained<AnyObject> = msg_send![content_class, new];
        let _: () = msg_send![&*content, setTitle: &*ns_string(title)];
        let _: () = msg_send![&*content, setBody: &*ns_string(body)];
        if let Some(c) = category {
            let _: () = msg_send![&*content, setCategoryIdentifier: &*ns_string(c)];
        }
        if let Some(sound_class) = class(c"UNNotificationSound") {
            let sound: *mut AnyObject = msg_send![sound_class, defaultSound];
            let _: () = msg_send![&*content, setSound: sound];
        }
        let uuid: Retained<AnyObject> = msg_send![uuid_class, new];
        let id: *mut AnyObject = msg_send![&*uuid, UUIDString];
        let request: *mut AnyObject = msg_send![
            request_class,
            requestWithIdentifier: id,
            content: &*content,
            trigger: std::ptr::null_mut::<AnyObject>()
        ];
        let center: *mut AnyObject = msg_send![center_class, currentNotificationCenter];
        let no_handler: Option<&Block<dyn Fn(*mut AnyObject)>> = None;
        let _: () = msg_send![center, addNotificationRequest: request, withCompletionHandler: no_handler];
    }
}

// ---------------------------------------------------------------------------- background sync

/// Registers the background sync; before the launch ends (`mobile::run`, before Tauri starts).
pub fn register_background() {
    let Some(scheduler_class) = class(c"BGTaskScheduler") else { return };
    autoreleasepool(|_| {
        let handler = RcBlock::new(|task: *mut AnyObject| run_task(task));
        // SAFETY: the documented registration of BGTaskScheduler (iOS 13+); a nil queue runs the
        // handler on a background queue.
        let ok: bool = unsafe {
            let scheduler: *mut AnyObject = msg_send![scheduler_class, sharedScheduler];
            msg_send![
                scheduler,
                registerForTaskWithIdentifier: &*ns_string(TASK),
                usingQueue: std::ptr::null_mut::<AnyObject>(),
                launchHandler: &*handler
            ]
        };
        if !ok {
            devlog::warn("ios", "background sync not registered (Info.plist)");
        }
    });
}

/// Asks iOS for the next background sync (replaces an earlier request).
pub fn schedule_background() {
    let (Some(scheduler_class), Some(request_class), Some(date_class)) =
        (class(c"BGTaskScheduler"), class(c"BGAppRefreshTaskRequest"), class(c"NSDate"))
    else {
        return;
    };
    autoreleasepool(|_| {
        // SAFETY: the documented request API (iOS 13+); a refused request (Background App
        // Refresh switched off, the simulator) only means no background sync.
        unsafe {
            let allocated: *mut AnyObject = msg_send![request_class, alloc];
            let request: *mut AnyObject = msg_send![allocated, initWithIdentifier: &*ns_string(TASK)];
            let Some(request) = Retained::from_raw(request) else { return };
            let when: *mut AnyObject = msg_send![date_class, dateWithTimeIntervalSinceNow: NEXT_SYNC_SECS];
            let _: () = msg_send![&*request, setEarliestBeginDate: when];
            let scheduler: *mut AnyObject = msg_send![scheduler_class, sharedScheduler];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let ok: bool = msg_send![scheduler, submitTaskRequest: &*request, error: &mut error];
            if !ok {
                let why: *mut AnyObject =
                    if error.is_null() { std::ptr::null_mut() } else { msg_send![error, localizedDescription] };
                devlog::info("ios", format!("background sync not scheduled: {}", rust_string(why).unwrap_or_default()));
            }
        }
    });
}

/// The system runs the background task: one sync (when it is set up), then the next request.
fn run_task(task: *mut AnyObject) {
    // SAFETY: `task` is the BGTask the system hands to the launch handler.
    let Some(task) = (unsafe { Retained::retain(task) }) else { return };
    let finished = std::sync::Arc::new(AtomicBool::new(false));
    let complete = {
        let task = task.clone();
        let finished = finished.clone();
        move |success: bool| {
            if !finished.swap(true, Ordering::SeqCst) {
                // SAFETY: completing the task the system handed over, once.
                let _: () = unsafe { msg_send![&*task, setTaskCompletedWithSuccess: success] };
            }
        }
    };
    // Out of time: the task ends; the sync stops where iOS suspends it, and the next one picks
    // up from there (an interrupted sync loses nothing, docs/android.md).
    let on_expiry = complete.clone();
    let expire = RcBlock::new(move || on_expiry(false));
    // SAFETY: setExpirationHandler: copies the block.
    let _: () = unsafe { msg_send![&*task, setExpirationHandler: &*expire] };
    schedule_background();
    let ok = background_sync();
    complete(ok);
}

/// The sync of the background task, within [`BACKGROUND_BUDGET`]. `true` when it ran through or
/// had nothing to do.
fn background_sync() -> bool {
    // The task may come before Tauri's setup ended (a launch in the background).
    let mut waited = Duration::ZERO;
    let app = loop {
        if let Some(app) = APP.get() {
            break app.clone();
        }
        if waited >= Duration::from_secs(10) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
        waited += Duration::from_millis(250);
    };
    let gs = app.state::<AppState>().settings().git_sync;
    if !gs.enabled || gs.remote_url.trim().is_empty() || super::https_only(&gs.remote_url).is_err() {
        return true;
    }
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let res = super::sync_and_import(&app, false, None);
        if let Err(e) = &res {
            devlog::warn("ios", format!("background sync failed: {e}"));
        }
        let _ = tx.send(res.is_ok());
    });
    rx.recv_timeout(BACKGROUND_BUDGET.saturating_sub(waited)).unwrap_or(false)
}

// ---------------------------------------------------------------------------- proxy

#[link(name = "CFNetwork", kind = "framework")]
unsafe extern "C" {
    /// Returns a retained CFDictionary (toll-free bridged to NSDictionary), or null.
    fn CFNetworkCopySystemProxySettings() -> *mut AnyObject;
}

/// The HTTPS proxy of the network in use, with its exceptions and a PAC address.
pub fn system_proxy() -> arcalo_core::network::SystemProxy {
    autoreleasepool(|_| {
        // SAFETY: the copy is owned here (released by `Retained`); the keys are those of
        // CFNetwork's proxy dictionary.
        unsafe {
            let Some(dict) = Retained::from_raw(CFNetworkCopySystemProxySettings()) else {
                return arcalo_core::network::android_proxy(None, 0, "", None);
            };
            let get = |key: &str| -> *mut AnyObject { msg_send![&*dict, objectForKey: &*ns_string(key)] };
            let number = |key: &str| -> i32 {
                let n = get(key);
                if n.is_null() { 0 } else { msg_send![n, intValue] }
            };
            let host = if number("HTTPSEnable") != 0 { rust_string(get("HTTPSProxy")) } else { None };
            let port = number("HTTPSPort");
            let mut exceptions = Vec::new();
            let list = get("ExceptionsList");
            if !list.is_null() {
                let count: usize = msg_send![list, count];
                for i in 0..count {
                    let item: *mut AnyObject = msg_send![list, objectAtIndex: i];
                    exceptions.extend(rust_string(item));
                }
            }
            let pac =
                if number("ProxyAutoConfigEnable") != 0 { rust_string(get("ProxyAutoConfigURLString")) } else { None };
            let mut p =
                arcalo_core::network::android_proxy(host.as_deref(), port, &exceptions.join(","), pac.as_deref());
            p.source = arcalo_core::tr!("iOS (WLAN)", "iOS (Wi-Fi)").into();
            p
        }
    })
}

// ---------------------------------------------------------------------------- simulator check

/// The simulator check of CI (debug builds only, `ARCALO_SMOKE=1`): the page's geometry
/// (`ios_smoke.js`) twice, 10 and 20 seconds after the start, as `smoke.json` in the data folder;
/// with `ARCALO_SMOKE_ORIENTATION=landscape` the window turns to landscape first.
mod smoke {
    use super::*;

    const SCRIPT: &str = include_str!("ios_smoke.js");

    pub fn start(app: &AppHandle) {
        if !cfg!(debug_assertions) || std::env::var("ARCALO_SMOKE").ok().as_deref() != Some("1") {
            return;
        }
        let landscape_wanted = std::env::var("ARCALO_SMOKE_ORIENTATION").ok().as_deref() == Some("landscape");
        let app = app.clone();
        std::thread::spawn(move || {
            // The window turns once it is on screen (an iPhone; an iPad turns with the device,
            // which the workflow rotates).
            if landscape_wanted {
                std::thread::sleep(Duration::from_secs(2));
                DispatchQueue::main().exec_async(|| autoreleasepool(|_| landscape()));
            }
            for round in 1..=2u32 {
                std::thread::sleep(Duration::from_secs(10));
                let Some(w) = app.get_webview_window("main") else { continue };
                let native = native_geometry(&w);
                let dir = app.state::<AppState>().data_dir.clone();
                let res = w.eval_with_callback(SCRIPT, move |out| write(&dir, round, &out, &native));
                if let Err(e) = res {
                    devlog::warn("ios", format!("simulator check not run: {e}"));
                }
            }
        });
    }

    /// The window's size and safe-area insets and the WebView's frame in it, in points.
    fn native_geometry(w: &tauri::WebviewWindow) -> serde_json::Value {
        let (tx, rx) = std::sync::mpsc::channel();
        let _ = w.with_webview(move |pw| {
            let webview = pw.inner() as *mut AnyObject;
            if webview.is_null() {
                return;
            }
            // SAFETY: on the main thread; the documented UIView and UIWindow API.
            let out = unsafe {
                let window: *mut AnyObject = msg_send![webview, window];
                if window.is_null() {
                    return;
                }
                let insets: UIEdgeInsets = msg_send![window, safeAreaInsets];
                let wb: CGRect = msg_send![window, bounds];
                let bounds: CGRect = msg_send![webview, bounds];
                let none: *mut AnyObject = std::ptr::null_mut();
                let frame: CGRect = msg_send![webview, convertRect: bounds, toView: none];
                serde_json::json!({
                    "window": { "width": wb.size.width, "height": wb.size.height },
                    "insets": { "top": insets.top, "left": insets.left, "bottom": insets.bottom, "right": insets.right },
                    "webview": { "x": frame.origin.x, "y": frame.origin.y, "width": frame.size.width, "height": frame.size.height },
                })
            };
            let _ = tx.send(out);
        });
        rx.recv_timeout(Duration::from_secs(5)).unwrap_or(serde_json::Value::Null)
    }

    fn write(dir: &Path, round: u32, out: &str, native: &serde_json::Value) {
        // The result of the script, a JSON string, comes JSON-encoded once more.
        let text = serde_json::from_str::<String>(out).unwrap_or_else(|_| out.to_owned());
        let mut report: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::json!({ "raw": text }));
        report["round"] = round.into();
        report["ipad"] = is_ipad().into();
        report["native"] = native.clone();
        if let Some(e) = lock(&ORIENTATION_ERROR).clone() {
            report["orientationError"] = e.into();
        }
        let file: PathBuf = dir.join("smoke.json");
        let _ = std::fs::write(&file, serde_json::to_vec_pretty(&report).unwrap_or_default());
        devlog::info("ios", format!("simulator check {round}: {report}"));
    }

    /// Why the window did not turn (the error of `requestGeometryUpdate`).
    static ORIENTATION_ERROR: Mutex<Option<String>> = Mutex::new(None);

    /// Turns the window to landscape (`requestGeometryUpdate`, iOS 16+).
    fn landscape() {
        /// `UIInterfaceOrientationMaskLandscape`.
        const LANDSCAPE: usize = (1 << 3) | (1 << 4);
        let Some(prefs_class) = class(c"UIWindowSceneGeometryPreferencesIOS") else { return };
        let window = key_window();
        if window.is_null() {
            return;
        }
        // SAFETY: the documented scene API of iOS 16, on the main thread.
        unsafe {
            let scene: *mut AnyObject = msg_send![window, windowScene];
            if scene.is_null() {
                return;
            }
            let allocated: *mut AnyObject = msg_send![prefs_class, alloc];
            let prefs: *mut AnyObject = msg_send![allocated, initWithInterfaceOrientations: LANDSCAPE];
            let Some(prefs) = Retained::from_raw(prefs) else { return };
            let failed = RcBlock::new(|error: *mut AnyObject| {
                let why: *mut AnyObject =
                    if error.is_null() { std::ptr::null_mut() } else { msg_send![error, localizedDescription] };
                let why = rust_string(why).unwrap_or_default();
                devlog::warn("ios", format!("the window did not turn: {why}"));
                *lock(&ORIENTATION_ERROR) = Some(why);
            });
            let root: *mut AnyObject = msg_send![window, rootViewController];
            if !root.is_null() {
                let _: () = msg_send![root, setNeedsUpdateOfSupportedInterfaceOrientations];
            }
            let _: () = msg_send![scene, requestGeometryUpdateWithPreferences: &*prefs, errorHandler: &*failed];
        }
    }
}
