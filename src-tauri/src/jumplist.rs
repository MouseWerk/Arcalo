//! Taskbar jump list (Windows): right-clicking the taskbar button offers today's note, a new
//! page, quick capture, search, the timer and the recently edited pages. Each entry starts the
//! app with `--jump=<action>`; the running instance receives it through the single-instance
//! plugin (a first start picks it up in `setup`).
//!
//! Parsing and running the actions is platform independent; only Windows has a jump list.

use std::sync::Mutex;

use annalo_core::desktop as core;
use annalo_core::prefs::Language;
use tauri::{AppHandle, Emitter, Manager};

use crate::desktop::{self, MAIN, SearchTarget};
use crate::{AppState, lock};

const PREFIX: &str = "--jump=";

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Today,
    NewPage,
    Capture,
    Search,
    Timer,
    Page(i64),
}

impl Action {
    #[cfg_attr(not(windows), allow(dead_code))]
    fn arg(&self) -> String {
        let name = match self {
            Action::Today => "today".to_string(),
            Action::NewPage => "new-page".to_string(),
            Action::Capture => "capture".to_string(),
            Action::Search => "search".to_string(),
            Action::Timer => "timer".to_string(),
            Action::Page(id) => format!("page:{id}"),
        };
        format!("{PREFIX}{name}")
    }
}

/// The jump-list action among command-line arguments, if any.
pub fn parse<S: AsRef<str>>(args: &[S]) -> Option<Action> {
    args.iter().find_map(|a| {
        Some(match a.as_ref().strip_prefix(PREFIX)? {
            "today" => Action::Today,
            "new-page" => Action::NewPage,
            "capture" => Action::Capture,
            "search" => Action::Search,
            "timer" => Action::Timer,
            other => Action::Page(other.strip_prefix("page:")?.parse().ok()?),
        })
    })
}

/// An action that arrived before the main window listened for it (first start).
static PENDING: Mutex<Option<Action>> = Mutex::new(None);

/// Runs a jump-list action. Page actions go through the main window; `ready` is false while
/// the UI of a first start is still loading, then the action waits for `jump_take`.
pub fn run(app: &AppHandle, action: Action, ready: bool) {
    match action {
        Action::Capture => desktop::open_capture(app),
        Action::Search => desktop::open_search(app, false),
        Action::Timer if !timer_running(app) => {
            if let Err(e) = desktop::timer_resume_last(app.clone()) {
                desktop::notify(app, "Timer nicht gestartet", &e.to_string());
            }
        }
        a if !ready => *lock(&PENDING) = Some(a),
        a => {
            desktop::show_main(app);
            match a {
                // The UI stops the timer so it can ask about idle time first.
                Action::Timer => {
                    let _ = app.emit_to(MAIN, "tray://timer-stop", ());
                }
                Action::Page(page_id) => {
                    let _ = app.emit_to(MAIN, "search://open", SearchTarget::Page { page_id, new_tab: false });
                }
                Action::Today => {
                    let _ = app.emit_to(MAIN, "menu://action", "today");
                }
                Action::NewPage => {
                    let _ = app.emit_to(MAIN, "menu://action", "new_page");
                }
                Action::Capture | Action::Search => {}
            }
        }
    }
}

/// The main window is listening: runs an action that arrived during the first start.
#[tauri::command]
pub fn jump_take(app: AppHandle) {
    let pending = lock(&PENDING).take();
    if let Some(a) = pending {
        run(&app, a, true);
    }
}

fn timer_running(app: &AppHandle) -> bool {
    app.try_state::<AppState>().is_some_and(|s| s.db().running_timer().ok().flatten().is_some())
}

/// One entry of the jump list.
#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub title: String,
    pub action: Action,
}

/// What the jump list shows: the tasks and the recently edited pages.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Content {
    pub tasks: Vec<Entry>,
    pub recent_title: String,
    pub recent: Vec<Entry>,
}

/// The jump list for the current language, timer and pages.
pub fn content(lang: Language, timer: Option<&str>, has_last: bool, recent: &[(i64, String)]) -> Content {
    let de = lang == Language::De;
    let t = |de_text: &str, en_text: &str| if de { de_text.to_string() } else { en_text.to_string() };
    let mut tasks = vec![
        Entry { title: t("Heutige Notiz", "Today's note"), action: Action::Today },
        Entry { title: t("Neue Seite", "New page"), action: Action::NewPage },
        Entry { title: t("Schnellerfassung", "Quick capture"), action: Action::Capture },
        Entry { title: t("Suchen…", "Search…"), action: Action::Search },
    ];
    match timer {
        Some(label) => tasks.push(Entry {
            title: if de { format!("Timer stoppen ({label})") } else { format!("Stop timer ({label})") },
            action: Action::Timer,
        }),
        None if has_last => {
            tasks.push(Entry { title: t("Letzten Timer starten", "Start last timer"), action: Action::Timer })
        }
        None => {}
    }
    Content {
        tasks,
        recent_title: t("Zuletzt bearbeitet", "Recently edited"),
        recent: recent.iter().map(|(id, title)| Entry { title: title.clone(), action: Action::Page(*id) }).collect(),
    }
}

/// The last content handed to Windows (updates only when something changed).
static SHOWN: Mutex<Option<Content>> = Mutex::new(None);

/// Brings the jump list up to date (timer, language, recent pages). Cheap when nothing changed.
pub fn refresh(app: &AppHandle) {
    // A portable copy writes nothing into the user profile (the jump list lives there).
    if !cfg!(windows) || crate::portable::active() {
        return;
    }
    let Some(state) = app.try_state::<AppState>() else { return };
    let lang = state.settings().locale.language;
    let c = {
        let db = state.db();
        let timer = db.running_timer().ok().flatten().map(|e| {
            let nr = db.netzplan_by_id(e.netzplan_id).map(|n| n.netzplan_nr).unwrap_or_default();
            core::timer_label(&nr, e.vorgang_nr.as_deref())
        });
        let has_last = db.last_finished_entry().ok().flatten().is_some();
        let recent: Vec<(i64, String)> =
            db.recent_pages(6).unwrap_or_default().into_iter().map(|p| (p.id, p.title)).collect();
        content(lang, timer.as_deref(), has_last, &recent)
    };
    {
        let mut shown = lock(&SHOWN);
        if shown.as_ref() == Some(&c) {
            return;
        }
        *shown = Some(c.clone());
    }
    // COM wants the (STA) main thread.
    let _ = app.run_on_main_thread(move || {
        #[cfg(windows)]
        if let Err(e) = win::apply(&c) {
            eprintln!("jump list: {e}");
            *lock(&SHOWN) = None;
        }
        let _ = &c;
    });
}

/// Windows: the process uses the app ID of the installer's shortcuts, so the taskbar button,
/// the pinned shortcut and the jump list belong together. Must run before the first window.
pub fn set_app_id(identifier: &str) {
    #[cfg(windows)]
    win::set_app_id(identifier);
    let _ = identifier;
}

#[cfg(windows)]
mod win {
    use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
    use windows::Win32::System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, CoTaskMemAlloc};
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{HSTRING, Interface, PWSTR, Result};

    use super::{Content, Entry};

    pub fn set_app_id(identifier: &str) {
        let _ = unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(identifier)) };
    }

    /// A shell link that starts this program with the entry's argument.
    fn link(exe: &HSTRING, e: &Entry) -> Result<IShellLinkW> {
        unsafe {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.SetPath(exe)?;
            link.SetArguments(&HSTRING::from(e.action.arg()))?;
            link.SetIconLocation(exe, 0)?;
            link.SetDescription(&HSTRING::from(e.title.as_str()))?;
            // The visible title is a property of the link (VT_LPWSTR).
            let store: IPropertyStore = link.cast()?;
            let wide: Vec<u16> = e.title.encode_utf16().chain([0]).collect();
            let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
            if mem.is_null() {
                return Err(windows::core::Error::from(windows::Win32::Foundation::E_OUTOFMEMORY));
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
            let mut pv = PROPVARIANT::default();
            (*pv.Anonymous.Anonymous).vt = VT_LPWSTR;
            (*pv.Anonymous.Anonymous).Anonymous.pwszVal = PWSTR(mem);
            let set = store.SetValue(&PKEY_Title, &pv).and_then(|_| store.Commit());
            let _ = PropVariantClear(&mut pv);
            set?;
            Ok(link)
        }
    }

    fn collection(exe: &HSTRING, entries: &[Entry]) -> Result<IObjectArray> {
        unsafe {
            let items: IObjectCollection = CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
            for e in entries {
                items.AddObject(&link(exe, e)?)?;
            }
            items.cast()
        }
    }

    pub fn apply(c: &Content) -> Result<()> {
        let exe = std::env::current_exe()
            .map_err(|e| windows::core::Error::new(windows::Win32::Foundation::E_FAIL, e.to_string()))?;
        let exe = HSTRING::from(exe.as_os_str());
        unsafe {
            let list: ICustomDestinationList = CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            let mut slots = 0u32;
            // Entries the user removed from the list are not added again.
            let removed: IObjectArray = list.BeginList(&mut slots)?;
            let removed_args = removed_arguments(&removed);
            let keep = |e: &&Entry| !removed_args.contains(&e.action.arg());
            let recent: Vec<Entry> = c.recent.iter().filter(keep).cloned().collect();
            if !recent.is_empty() {
                list.AppendCategory(&HSTRING::from(c.recent_title.as_str()), &collection(&exe, &recent)?)?;
            }
            list.AddUserTasks(&collection(&exe, &c.tasks)?)?;
            list.CommitList()
        }
    }

    fn removed_arguments(removed: &IObjectArray) -> Vec<String> {
        let mut out = Vec::new();
        unsafe {
            for i in 0..removed.GetCount().unwrap_or(0) {
                let Ok(link) = removed.GetAt::<IShellLinkW>(i) else { continue };
                let mut buf = [0u16; 512];
                if link.GetArguments(&mut buf).is_ok() {
                    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                    out.push(String::from_utf16_lossy(&buf[..end]));
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_round_trip() {
        for a in [Action::Today, Action::NewPage, Action::Capture, Action::Search, Action::Timer, Action::Page(42)] {
            assert_eq!(parse(&["C:\\annalo.exe".to_string(), a.arg()]), Some(a));
        }
        assert_eq!(parse(&["annalo", "--minimized"]), None);
        assert_eq!(parse(&["annalo", "--jump=page:x"]), None);
        assert_eq!(parse(&["annalo", "--jump=unknown"]), None);
    }

    #[test]
    fn timer_entry_follows_the_timer() {
        let running = content(Language::De, Some("NP-8801/1020"), true, &[]);
        assert_eq!(running.tasks.last().unwrap().title, "Timer stoppen (NP-8801/1020)");
        let idle = content(Language::En, None, true, &[(7, "Architektur".into())]);
        assert_eq!(idle.tasks.last().unwrap().title, "Start last timer");
        assert_eq!(idle.recent, vec![Entry { title: "Architektur".into(), action: Action::Page(7) }]);
        assert_eq!(content(Language::De, None, false, &[]).tasks.len(), 4, "no timer entry without bookings");
    }
}
