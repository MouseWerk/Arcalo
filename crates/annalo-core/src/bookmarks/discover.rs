//! Where the browsers keep their bookmarks on Windows, macOS and Linux, and which profiles
//! exist. Discovery works on a set of base folders ([`Roots`]) and an [`Os`], so the layout of
//! every system can be checked against a fake home folder.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::{Tree, chromium, firefox, safari};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Windows,
    Mac,
    Linux,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(windows) {
            Os::Windows
        } else if cfg!(target_os = "macos") {
            Os::Mac
        } else {
            Os::Linux
        }
    }
}

/// The base folders the browsers' paths start from.
#[derive(Debug, Clone, PartialEq)]
pub struct Roots {
    pub home: PathBuf,
    /// Windows `%LOCALAPPDATA%`.
    pub local: PathBuf,
    /// Windows `%APPDATA%` (Roaming).
    pub roaming: PathBuf,
    /// Linux `$XDG_CONFIG_HOME` (`~/.config`).
    pub config: PathBuf,
}

/// Debug builds and tests: a fake home folder with the browsers' files below it (the Windows
/// folders as `AppData/Local` and `AppData/Roaming`, the Linux ones in `.config`).
pub const TEST_HOME_ENV: &str = "ANNALO_TEST_HOME";

impl Roots {
    /// Everything below `home`, in each system's default places.
    pub fn under(home: impl Into<PathBuf>) -> Roots {
        let home = home.into();
        Roots {
            local: home.join("AppData").join("Local"),
            roaming: home.join("AppData").join("Roaming"),
            config: home.join(".config"),
            home,
        }
    }

    /// The folders of the user running the app (or of [`TEST_HOME_ENV`] in debug builds).
    pub fn from_env() -> Option<Roots> {
        let var = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
        if cfg!(debug_assertions)
            && let Some(home) = var(TEST_HOME_ENV)
        {
            return Some(Roots::under(home));
        }
        let home = if cfg!(windows) { var("USERPROFILE").or_else(|| var("HOME")) } else { var("HOME") }?;
        let mut r = Roots::under(&home);
        if let Some(p) = var("LOCALAPPDATA") {
            r.local = p;
        }
        if let Some(p) = var("APPDATA") {
            r.roaming = p;
        }
        if let Some(p) = var("XDG_CONFIG_HOME") {
            r.config = p;
        }
        Some(r)
    }
}

/// Which base folder a path starts at.
#[derive(Debug, Clone, Copy)]
enum Base {
    Local,
    Roaming,
    /// macOS `~/Library/Application Support`.
    Support,
    Config,
    Home,
}

impl Base {
    fn path(self, r: &Roots) -> PathBuf {
        match self {
            Base::Local => r.local.clone(),
            Base::Roaming => r.roaming.clone(),
            Base::Support => r.home.join("Library").join("Application Support"),
            Base::Config => r.config.clone(),
            Base::Home => r.home.clone(),
        }
    }
}

type Places = &'static [(Os, Base, &'static str)];

/// The Chromium browsers: id, name and their user data folders (`*` at the end of a part
/// matches the rest of a folder name).
const CHROMIUM: [(&str, &str, Places); 8] = [
    (
        "chrome",
        "Google Chrome",
        &[
            (Os::Windows, Base::Local, "Google/Chrome/User Data"),
            (Os::Mac, Base::Support, "Google/Chrome"),
            (Os::Linux, Base::Config, "google-chrome"),
            (Os::Linux, Base::Home, ".var/app/com.google.Chrome/config/google-chrome"),
        ],
    ),
    (
        "edge",
        "Microsoft Edge",
        &[
            (Os::Windows, Base::Local, "Microsoft/Edge/User Data"),
            (Os::Mac, Base::Support, "Microsoft Edge"),
            (Os::Linux, Base::Config, "microsoft-edge"),
            (Os::Linux, Base::Home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
        ],
    ),
    (
        "brave",
        "Brave",
        &[
            (Os::Windows, Base::Local, "BraveSoftware/Brave-Browser/User Data"),
            (Os::Mac, Base::Support, "BraveSoftware/Brave-Browser"),
            (Os::Linux, Base::Config, "BraveSoftware/Brave-Browser"),
            (Os::Linux, Base::Home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
        ],
    ),
    (
        "vivaldi",
        "Vivaldi",
        &[
            (Os::Windows, Base::Local, "Vivaldi/User Data"),
            (Os::Mac, Base::Support, "Vivaldi"),
            (Os::Linux, Base::Config, "vivaldi"),
        ],
    ),
    (
        "opera",
        "Opera",
        &[
            (Os::Windows, Base::Roaming, "Opera Software/Opera Stable"),
            (Os::Mac, Base::Support, "com.operasoftware.Opera"),
            (Os::Linux, Base::Config, "opera"),
        ],
    ),
    (
        "opera-gx",
        "Opera GX",
        &[
            (Os::Windows, Base::Roaming, "Opera Software/Opera GX Stable"),
            (Os::Mac, Base::Support, "com.operasoftware.OperaGX"),
        ],
    ),
    (
        "arc",
        "Arc",
        &[
            (Os::Windows, Base::Local, "Packages/TheBrowserCompany.Arc_*/LocalCache/Local/Arc/User Data"),
            (Os::Mac, Base::Support, "Arc/User Data"),
        ],
    ),
    (
        "chromium",
        "Chromium",
        &[
            (Os::Windows, Base::Local, "Chromium/User Data"),
            (Os::Mac, Base::Support, "Chromium"),
            (Os::Linux, Base::Config, "chromium"),
            (Os::Linux, Base::Home, "snap/chromium/common/chromium"),
        ],
    ),
];

/// Firefox's folders with `profiles.ini`.
const FIREFOX: Places = &[
    (Os::Windows, Base::Roaming, "Mozilla/Firefox"),
    (Os::Mac, Base::Support, "Firefox"),
    (Os::Linux, Base::Home, ".mozilla/firefox"),
    (Os::Linux, Base::Home, "snap/firefox/common/.mozilla/firefox"),
    (Os::Linux, Base::Home, ".var/app/org.mozilla.firefox/.mozilla/firefox"),
];

/// The file format of a source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Chromium,
    Firefox,
    Safari,
}

/// A bookmarks file of one browser profile.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Location {
    /// Stable id for [`read_source`]: the file's path.
    pub id: String,
    /// `chrome`, `edge`, `brave`, `vivaldi`, `opera`, `opera-gx`, `arc`, `chromium`, `firefox`, `safari`.
    pub browser: String,
    pub browser_name: String,
    /// The profile's display name (`Local State`, `profiles.ini`); empty where there is one.
    pub profile: String,
    /// The profile's folder name (`Default`, `Profile 1`, `abcd.default-release`).
    pub profile_dir: String,
    /// The profile the browser starts with.
    pub default: bool,
    pub format: Format,
    pub path: PathBuf,
}

/// The folders `rel` (below `base`) names, with `*` matching the rest of a folder name.
fn expand(base: PathBuf, rel: &str) -> Vec<PathBuf> {
    let mut out = vec![base];
    for part in rel.split('/') {
        out = out
            .into_iter()
            .flat_map(|p| match part.strip_suffix('*') {
                None => vec![p.join(part)],
                Some(prefix) => {
                    let mut hits: Vec<PathBuf> = std::fs::read_dir(&p)
                        .into_iter()
                        .flatten()
                        .flatten()
                        .filter(|e| e.file_name().to_string_lossy().starts_with(prefix))
                        .map(|e| e.path())
                        .collect();
                    hits.sort();
                    hits
                }
            })
            .collect();
    }
    out.into_iter().filter(|p| p.is_dir()).collect()
}

fn places(os: Os, roots: &Roots, list: Places) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    for (o, base, rel) in list {
        if *o == os {
            for p in expand(base.path(roots), rel) {
                if !out.contains(&p) {
                    out.push(p);
                }
            }
        }
    }
    out
}

/// Sort key of Chromium profile folders: `Default`, `Profile 1`, `Profile 2` …, then the rest.
fn profile_order(dir: &str) -> (u8, u32, String) {
    if dir == "Default" {
        return (0, 0, String::new());
    }
    match dir.strip_prefix("Profile ").and_then(|n| n.parse().ok()) {
        Some(n) => (1, n, String::new()),
        None => (2, 0, dir.to_owned()),
    }
}

/// Every browser profile with a bookmarks file, browser by browser.
pub fn discover(os: Os, roots: &Roots) -> Vec<Location> {
    let mut out = Vec::new();
    for (id, name, list) in CHROMIUM {
        for data in places(os, roots, list) {
            let names = std::fs::read_to_string(data.join("Local State"))
                .map(|s| chromium::profile_names(&s))
                .unwrap_or_default();
            // Opera keeps a single profile directly in its folder.
            let single = data.join("Bookmarks");
            if single.is_file() {
                out.push(location(id, name, "", "", true, Format::Chromium, single));
            }
            let mut dirs: Vec<String> = std::fs::read_dir(&data)
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.path().join("Bookmarks").is_file())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|d| d != "System Profile" && d != "Guest Profile")
                .collect();
            dirs.sort_by_key(|d| profile_order(d));
            for dir in dirs {
                let profile = names.get(&dir).cloned().unwrap_or_default();
                out.push(location(
                    id,
                    name,
                    &profile,
                    &dir,
                    dir == "Default",
                    Format::Chromium,
                    data.join(&dir).join("Bookmarks"),
                ));
            }
        }
    }
    for base in places(os, roots, FIREFOX) {
        let Ok(ini) = std::fs::read_to_string(base.join("profiles.ini")) else { continue };
        for p in firefox::profiles(&base, &ini) {
            let places = p.dir.join("places.sqlite");
            if places.is_file() {
                let dir = p.dir.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                out.push(location("firefox", "Firefox", &p.name, &dir, p.default, Format::Firefox, places));
            }
        }
    }
    if os == Os::Mac {
        let plist = roots.home.join("Library").join("Safari").join("Bookmarks.plist");
        // Without „Festplattenvollzugriff“ even looking at the file fails: Safari is listed
        // then too, with the hint how to allow it.
        if present(&plist) {
            out.push(location("safari", "Safari", "", "", true, Format::Safari, plist));
        }
    }
    out
}

/// Whether `p` exists or cannot be looked at (anything but „not found“).
fn present(p: &Path) -> bool {
    !matches!(std::fs::metadata(p), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
}

fn location(
    browser: &str,
    browser_name: &str,
    profile: &str,
    dir: &str,
    default: bool,
    format: Format,
    path: PathBuf,
) -> Location {
    Location {
        id: path.display().to_string(),
        browser: browser.to_owned(),
        browser_name: browser_name.to_owned(),
        profile: profile.to_owned(),
        profile_dir: dir.to_owned(),
        default,
        format,
        path,
    }
}

/// Whether a source could be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SourceStatus {
    Ok,
    /// The browser holds the file (Firefox on Windows while it runs).
    Locked,
    /// The system refuses access (Safari without „Festplattenvollzugriff“).
    Permission,
    Error,
}

/// A profile with how many bookmarks it holds, for choosing.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Source {
    #[serde(flatten)]
    pub location: Location,
    pub status: SourceStatus,
    /// Bookmarks that can be imported (0 when the file could not be read).
    pub count: usize,
    /// Why it could not be read.
    pub error: Option<String>,
}

/// Reads one location.
pub fn read_location(loc: &Location) -> Result<Tree> {
    match loc.format {
        Format::Chromium => {
            let text = std::fs::read_to_string(&loc.path).map_err(|e| Error::file(&loc.path, e))?;
            chromium::parse(&text)
        }
        Format::Firefox => firefox::read(&loc.path),
        Format::Safari => safari::read(&loc.path),
    }
}

/// Every source with its count (reads each file once).
pub fn sources(os: Os, roots: &Roots) -> Vec<Source> {
    discover(os, roots)
        .into_iter()
        .map(|location| match read_location(&location) {
            Ok(t) => Source { location, status: SourceStatus::Ok, count: t.links, error: None },
            Err(e) => {
                let text = e.to_string();
                let status = if text == firefox::LOCKED {
                    SourceStatus::Locked
                } else if text == safari::NO_ACCESS {
                    SourceStatus::Permission
                } else {
                    SourceStatus::Error
                };
                Source { location, status, count: 0, error: Some(text) }
            }
        })
        .collect()
}

/// The tree of the source `id` (only paths found by [`discover`] are read).
pub fn read_source(os: Os, roots: &Roots, id: &str) -> Result<(Location, Tree)> {
    let loc = discover(os, roots)
        .into_iter()
        .find(|l| l.id == id)
        .ok_or_else(|| Error::State("Diese Lesezeichen sind nicht mehr da. Die Liste der Browser neu laden.".into()))?;
    let tree = read_location(&loc)?;
    Ok((loc, tree))
}
