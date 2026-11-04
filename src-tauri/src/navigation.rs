//! The app's windows show the app and nothing else. A link the UI does not handle itself (in a
//! page preview, an AI summary, release notes, a slide) or a redirect would otherwise load the web
//! page in the app's window: the app was gone until a restart, text typed in the last second was
//! not saved, and a foreign page looked like the app. Such a navigation is refused and a web or
//! mail address opens in the default browser or mail program instead; so does a new window.

#[cfg(desktop)]
use tauri::webview::{NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Runtime, Url};

use crate::devlog;

/// Schemes of the app's own pages and files (`tauri://localhost`, the attachments, the PAC frame).
const APP_SCHEMES: [&str; 6] = ["tauri", "arcalo-asset", "arcalo-pac", "ipc", "asset", "about"];

/// Whether `url` is one of the app's own addresses. Windows and Android serve them as
/// `http(s)://<scheme>.localhost`; debug builds without `custom-protocol` load the dev server.
pub fn is_app_url(url: &Url, dev_url: Option<&Url>) -> bool {
    let scheme = url.scheme();
    if APP_SCHEMES.contains(&scheme) || scheme == "blob" {
        return true;
    }
    let host = url.host_str().unwrap_or_default();
    if matches!(scheme, "http" | "https")
        && let Some(sub) = host.strip_suffix(".localhost")
        && (sub == "tauri" || APP_SCHEMES.contains(&sub))
    {
        return true;
    }
    dev_url.is_some_and(|d| d.origin() == url.origin())
}

/// What a link to `url` that is not the app's own does: a web or mail address opens outside,
/// anything else (a file, a program's scheme) is refused. Tests set `ARCALO_TEST_OPEN_LOG` to a
/// file: the address is appended there instead.
fn open_outside<R: Runtime>(app: &AppHandle<R>, url: &Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        devlog::warn("nav", format!("link to “{}:” not opened", url.scheme()));
        return;
    }
    if let Ok(log) = std::env::var("ARCALO_TEST_OPEN_LOG") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log) {
            let _ = writeln!(f, "url\t{url}");
        }
        return;
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        devlog::warn("nav", format!("link not opened: {e}"));
    }
}

/// The dev server of a debug build without `custom-protocol` (none in a release).
fn dev_url<R: Runtime>(app: &AppHandle<R>) -> Option<Url> {
    if cfg!(feature = "custom-protocol") { None } else { app.config().build.dev_url.clone() }
}

/// For `on_navigation` of every window: the app's own addresses load, others open outside.
pub fn guard<R: Runtime>(app: AppHandle<R>) -> impl Fn(&Url) -> bool + Send + 'static {
    let dev = dev_url(&app);
    move |url: &Url| {
        if is_app_url(url, dev.as_ref()) {
            return true;
        }
        open_outside(&app, url);
        false
    }
}

/// For `on_new_window` (desktop): no window of the app opens a web page; it opens outside.
#[cfg(desktop)]
pub fn new_window<R: Runtime>(
    app: AppHandle<R>,
) -> impl Fn(Url, NewWindowFeatures) -> NewWindowResponse<R> + Send + 'static {
    move |url: Url, _features: NewWindowFeatures| {
        open_outside(&app, &url);
        NewWindowResponse::Deny
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_own_addresses_load_in_its_windows() {
        let u = |s: &str| Url::parse(s).unwrap();
        for ok in [
            "tauri://localhost/index.html#capture",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "http://arcalo-asset.localhost/foto.png",
            "arcalo-asset://localhost/foto.png",
            "arcalo-pac://localhost/index.html",
            "about:blank",
        ] {
            assert!(is_app_url(&u(ok), None), "{ok}");
        }
        for no in [
            "https://example.com/",
            "http://127.0.0.1:4878/x.html",
            "http://localhost:1420/",
            "http://evil.localhost/",
            "http://tauri.localhost.evil.com/",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "javascript:alert(1)",
        ] {
            assert!(!is_app_url(&u(no), None), "{no}");
        }
        // A debug build without the custom protocol loads the dev server.
        assert!(is_app_url(&u("http://localhost:1420/index.html"), Some(&u("http://localhost:1420"))));
        assert!(!is_app_url(&u("http://localhost:1421/"), Some(&u("http://localhost:1420"))));
    }
}
