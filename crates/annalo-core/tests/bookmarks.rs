//! Browser bookmarks: the file formats (fixtures in `tests/fixtures/bookmarks`, Firefox and
//! Safari built here) and the discovery of profiles below a fake home folder for each system.

use std::fs;
use std::path::{Path, PathBuf};

use annalo_core::bookmarks::discover::{self, Format};
use annalo_core::bookmarks::safari::FixtureNode::{Folder, Leaf, Proxy};
use annalo_core::bookmarks::{
    Node, Os, Roots, SkipReason, SourceStatus, Tree, chromium, firefox, html, parse_export, safari,
};

fn fixture(name: &str) -> String {
    fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bookmarks").join(name)).unwrap()
}

/// A fresh, empty folder (removed on drop).
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "annalo-bm-test-{tag}-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }
}
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// `title` for folders, `title <url>` for bookmarks, indented by depth.
fn outline(t: &Tree) -> Vec<String> {
    fn walk(n: &Node, depth: usize, out: &mut Vec<String>) {
        let pad = "  ".repeat(depth);
        match &n.url {
            Some(u) => out.push(format!("{pad}{} <{u}>", n.title)),
            None => {
                let role = n.role.as_deref().map(|r| format!(" [{r}]")).unwrap_or_default();
                out.push(format!("{pad}{}{role}", n.title));
                for c in &n.children {
                    walk(c, depth + 1, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    for r in &t.roots {
        walk(r, 0, &mut out);
    }
    out
}

fn reasons(t: &Tree) -> Vec<(String, SkipReason)> {
    t.skipped.iter().map(|s| (s.title.clone(), s.reason)).collect()
}

#[test]
fn chromium_json_with_nested_folders_umlauts_and_a_bookmarklet() {
    let t = chromium::parse(&fixture("chromium-Bookmarks.json")).unwrap();
    assert_eq!(
        outline(&t),
        [
            "Lesezeichenleiste [bar]",
            "  Jira <https://jira.firma.de/secure/Dashboard.jspa>",
            "  Arbeit",
            "    Fiori Launchpad <https://fiori.firma.de/sap/bc/ui2/flp>",
            "    Büro – Zeiterfassung <https://zeit.firma.de/büro?ä=1>",
            "    Überwachung",
            "      Grafana <https://grafana.firma.de/d/abc>",
            "Weitere Lesezeichen [other]",
            "  Handbuch (PDF) <file:///C:/Dokumente/Handbuch%20v2.pdf>",
        ]
    );
    assert_eq!(t.links, 5);
    assert_eq!(
        reasons(&t),
        [
            ("Seite übersetzen".to_owned(), SkipReason::Script),
            ("Einstellungen".to_owned(), SkipReason::Internal),
            ("Nur ein Bookmarklet".to_owned(), SkipReason::Script),
        ]
    );
    // 2024-01-01 in WebKit time.
    assert_eq!(t.roots[0].children[0].added, Some(1_704_067_200));
    // The JSON file also works as an export.
    assert_eq!(parse_export(&fixture("chromium-Bookmarks.json")).unwrap(), t);
}

#[test]
fn netscape_export_from_chrome() {
    let t = parse_export(&fixture("netscape-chrome.html")).unwrap();
    assert_eq!(
        outline(&t),
        [
            "Lesezeichenleiste [bar]",
            "  Jira <https://jira.firma.de/>",
            "  Team & Projekte",
            "    Wiki \"Team\" <https://wiki.firma.de/Spaces?x=1&y=2>",
            "    Outlook Web <https://outlook.office.com/mail/>",
            "tagesschau.de – Nachrichten <https://www.tagesschau.de/>",
        ]
    );
    assert_eq!(
        reasons(&t),
        [("Bookmarklet".to_owned(), SkipReason::Script), ("Flags".to_owned(), SkipReason::Internal)]
    );
    assert_eq!(t.roots[0].children[1].children[0].added, Some(1_704_067_201));
}

#[test]
fn netscape_export_from_firefox() {
    let t = parse_export(&fixture("netscape-firefox.html")).unwrap();
    assert_eq!(
        outline(&t),
        [
            "Mozilla Firefox",
            "  Hilfe erhalten <https://support.mozilla.org/de/products/firefox>",
            "Lesezeichen-Symbolleiste [bar]",
            "  GitLab <https://gitlab.firma.de/team>",
            "  Kunden",
            "    Kunde A – Größenübersicht <https://kunde-a.de/>",
            "Weitere Lesezeichen [other]",
            "  Intranet <http://intranet.local/>",
        ]
    );
    assert_eq!(
        reasons(&t),
        [("Meistbesucht".to_owned(), SkipReason::Internal), ("about:config".to_owned(), SkipReason::Internal)]
    );
}

#[test]
fn netscape_export_from_edge() {
    let t = html::parse(&fixture("netscape-edge.html"));
    assert_eq!(
        outline(&t),
        [
            "Favoritenleiste [bar]",
            "  Microsoft Azure <https://portal.azure.com/>",
            "  SAP",
            "    S/4HANA Fiori <https://s4.firma.de/sap/bc/ui2/flp?sap-client=100&sap-language=DE>",
            "Weitere Favoriten",
            "  Microsoft Learn <https://learn.microsoft.com/de-de/>",
        ]
    );
    assert_eq!(t.links, 3);
}

#[test]
fn other_files_are_refused() {
    assert!(parse_export("Hallo Welt").is_err());
    assert!(parse_export("{\"no\":1}").is_err());
}

fn write_places(path: &Path) {
    firefox::write_fixture(
        path,
        &[
            ("toolbar_____", "f-arbeit", 2, "Arbeit", None),
            ("f-arbeit", "b-jira", 1, "Jira – Übersicht", Some("https://jira.firma.de/")),
            ("f-arbeit", "s-1", 3, "", None),
            ("f-arbeit", "f-tief", 2, "Tief", None),
            ("f-tief", "b-wiki", 1, "Wiki", Some("https://wiki.firma.de/")),
            ("toolbar_____", "b-js", 1, "Bookmarklet", Some("javascript:void(0)")),
            ("toolbar_____", "b-news", 1, "Nachrichten", Some("https://news.de/")),
            ("menu________", "b-place", 1, "Meistbesucht", Some("place:sort=8")),
            ("menu________", "b-menu", 1, "Menüeintrag", Some("https://menu.de/")),
            ("unfiled_____", "b-other", 1, "Lose", Some("http://lose.de/")),
            ("tags________", "f-tag", 2, "ein-tag", None),
        ],
    )
    .unwrap();
}

#[test]
fn firefox_places_are_read_from_a_copy() {
    let dir = TempDir::new("ff");
    let places = dir.0.join("places.sqlite");
    write_places(&places);
    let before = fs::read(&places).unwrap();
    let t = firefox::read(&places).unwrap();
    assert_eq!(
        outline(&t),
        [
            "Lesezeichen-Symbolleiste [bar]",
            "  Arbeit",
            "    Jira – Übersicht <https://jira.firma.de/>",
            "    Tief",
            "      Wiki <https://wiki.firma.de/>",
            "  Nachrichten <https://news.de/>",
            "Lesezeichen-Menü [menu]",
            "  Menüeintrag <https://menu.de/>",
            "Weitere Lesezeichen [other]",
            "  Lose <http://lose.de/>",
        ]
    );
    assert_eq!(
        reasons(&t),
        [("Bookmarklet".to_owned(), SkipReason::Script), ("Meistbesucht".to_owned(), SkipReason::Internal)]
    );
    assert_eq!(t.roots[0].children[0].children[0].added, Some(1_704_067_201));
    assert_eq!(fs::read(&places).unwrap(), before, "the browser's file is untouched");
    assert!(!dir.0.join("places.sqlite-wal").exists());
}

#[test]
fn safari_binary_plist() {
    let dir = TempDir::new("safari");
    let path = dir.0.join("Bookmarks.plist");
    safari::write_fixture(
        &path,
        &[
            Proxy("History"),
            Folder(
                "BookmarksBar",
                vec![
                    Leaf("Apple", "https://www.apple.com/de/"),
                    Folder("Projekte", vec![Leaf("Größen", "https://groessen.de/")]),
                ],
            ),
            Folder("BookmarksMenu", vec![Leaf("Skript", "javascript:x()")]),
            Folder("com.apple.ReadingList", vec![Leaf("Später lesen", "https://lesen.de/")]),
        ],
    )
    .unwrap();
    let t = safari::read(&path).unwrap();
    assert_eq!(
        outline(&t),
        [
            "Favoriten [bar]",
            "  Apple <https://www.apple.com/de/>",
            "  Projekte",
            "    Größen <https://groessen.de/>",
            "Leseliste [reading]",
            "  Später lesen <https://lesen.de/>",
        ]
    );
    assert_eq!(reasons(&t), [("Skript".to_owned(), SkipReason::Script)]);
}

fn put(path: PathBuf, text: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, text).unwrap();
}

/// Chrome with three profiles (names from `Local State`), Edge, Opera (single profile), Arc
/// (Windows: below a versioned package folder) and Firefox, laid out for `os` below `home`.
fn fake_home(os: Os, home: &Path) -> Roots {
    let r = Roots::under(home);
    let bm = fixture("chromium-Bookmarks.json");
    let support = home.join("Library/Application Support");
    let (chrome, edge, opera, arc, ff) = match os {
        Os::Windows => (
            r.local.join("Google/Chrome/User Data"),
            r.local.join("Microsoft/Edge/User Data"),
            r.roaming.join("Opera Software/Opera Stable"),
            r.local.join("Packages/TheBrowserCompany.Arc_ttt1ap7aakyb4/LocalCache/Local/Arc/User Data"),
            r.roaming.join("Mozilla/Firefox"),
        ),
        Os::Mac => (
            support.join("Google/Chrome"),
            support.join("Microsoft Edge"),
            support.join("com.operasoftware.Opera"),
            support.join("Arc/User Data"),
            support.join("Firefox"),
        ),
        Os::Linux => (
            r.config.join("google-chrome"),
            r.config.join("microsoft-edge"),
            r.config.join("opera"),
            home.join("nope"),
            home.join(".mozilla/firefox"),
        ),
    };
    put(
        chrome.join("Local State"),
        r#"{"profile":{"info_cache":{"Default":{"name":"Arbeit"},"Profile 2":{"name":"Privat"},"Profile 10":{"name":"Test"}}}}"#,
    );
    put(chrome.join("Profile 10/Bookmarks"), &bm);
    put(chrome.join("Default/Bookmarks"), &bm);
    put(chrome.join("Profile 2/Bookmarks"), &bm);
    put(chrome.join("Guest Profile/Bookmarks"), &bm);
    put(chrome.join("Profile 3/Preferences"), "{}");
    put(edge.join("Default/Bookmarks"), "{ kaputt");
    put(opera.join("Bookmarks"), &bm);
    put(arc.join("Default/Bookmarks"), &bm);
    put(
        ff.join("profiles.ini"),
        "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n\n[Profile1]\nName=leer\nIsRelative=1\nPath=Profiles/leer\n",
    );
    fs::create_dir_all(ff.join("Profiles/abc.default-release")).unwrap();
    fs::create_dir_all(ff.join("Profiles/leer")).unwrap();
    write_places(&ff.join("Profiles/abc.default-release/places.sqlite"));
    if os == Os::Mac {
        fs::create_dir_all(home.join("Library/Safari")).unwrap();
        safari::write_fixture(
            &home.join("Library/Safari/Bookmarks.plist"),
            &[Folder("BookmarksBar", vec![Leaf("Apple", "https://apple.com/")])],
        )
        .unwrap();
    }
    r
}

fn summary(os: Os, roots: &Roots) -> Vec<String> {
    discover::sources(os, roots)
        .into_iter()
        .map(|s| {
            format!(
                "{}|{}|{}|{:?}|{}",
                s.location.browser, s.location.profile, s.location.profile_dir, s.status, s.count
            )
        })
        .collect()
}

#[test]
fn profiles_on_each_system_below_a_fake_home() {
    for os in [Os::Windows, Os::Mac, Os::Linux] {
        let home = TempDir::new("home");
        let roots = fake_home(os, &home.0);
        let mut want = vec![
            "chrome|Arbeit|Default|Ok|5",
            "chrome|Privat|Profile 2|Ok|5",
            "chrome|Test|Profile 10|Ok|5",
            "edge||Default|Error|0",
            "opera|||Ok|5",
        ];
        if os != Os::Linux {
            want.push("arc||Default|Ok|5");
        }
        want.push("firefox|default-release|abc.default-release|Ok|5");
        if os == Os::Mac {
            want.push("safari|||Ok|1");
        }
        assert_eq!(summary(os, &roots), want, "{os:?}");
        // Nothing of another system's layout is picked up.
        let other = if os == Os::Linux { Os::Windows } else { Os::Linux };
        assert!(discover::discover(other, &roots).is_empty(), "{os:?} files found as {other:?}");
    }
}

#[test]
fn a_source_is_read_by_its_id_only() {
    let home = TempDir::new("read");
    let roots = fake_home(Os::Linux, &home.0);
    let all = discover::discover(Os::Linux, &roots);
    let ff = all.iter().find(|l| l.format == Format::Firefox).unwrap();
    let (loc, tree) = discover::read_source(Os::Linux, &roots, &ff.id).unwrap();
    assert_eq!(loc.profile, "default-release");
    assert!(loc.default);
    assert_eq!(tree.links, 5);
    // A path that was not discovered is not read.
    let elsewhere = home.0.join("elsewhere.json");
    fs::write(&elsewhere, fixture("chromium-Bookmarks.json")).unwrap();
    assert!(discover::read_source(Os::Linux, &roots, &elsewhere.display().to_string()).is_err());
    let edge = all.iter().find(|l| l.browser == "edge").unwrap();
    assert!(discover::read_source(Os::Linux, &roots, &edge.id).is_err());
}

#[test]
fn safari_without_access_is_listed_with_the_hint() {
    let home = TempDir::new("tcc");
    let roots = Roots::under(&home.0);
    let dir = home.0.join("Library/Safari");
    fs::create_dir_all(&dir).unwrap();
    safari::write_fixture(&dir.join("Bookmarks.plist"), &[Folder("BookmarksBar", vec![Leaf("A", "https://a.de/")])])
        .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join("Bookmarks.plist"), fs::Permissions::from_mode(0o000)).unwrap();
        // root reads anything: the check only means something for a normal user.
        if fs::read(dir.join("Bookmarks.plist")).is_err() {
            let s = discover::sources(Os::Mac, &roots);
            assert_eq!(s.len(), 1);
            assert_eq!(s[0].status, SourceStatus::Permission);
            assert!(s[0].error.as_deref().unwrap().contains("Festplattenvollzugriff"));
        }
        fs::set_permissions(dir.join("Bookmarks.plist"), fs::Permissions::from_mode(0o644)).unwrap();
    }
    assert_eq!(discover::sources(Os::Mac, &roots)[0].count, 1);
}
