//! The rename from Annalo to Arcalo (1.7).
//!
//! 1.7 kept the internal names (identifier, credential service, crates, variables); 1.15 renamed
//! those too, with a migration of their own ([`crate::identity`]).
//!
//! Moved at every start until nothing is left (each step looks for the old entry and does nothing
//! without it, so running it again is harmless):
//! - the autostart entry of the old name (Windows Run value `Annalo`, `~/Library/LaunchAgents/
//!   Annalo.plist`, `~/.config/autostart/Annalo.desktop`): removed, and the new one is written when
//!   the old one was on ([`take_legacy_autostart_file`]; Windows in the shell);
//! - Start menu and desktop shortcuts of the old name that the installer left next to new ones
//!   ([`remove_stale_shortcuts`]).
//!
//! Once per workspace: a notice „Annalo heißt jetzt Arcalo“ for workspaces from before 1.7
//! ([`Database::rebrand_classify`]).

use std::fs;
use std::path::{Path, PathBuf};

use crate::db::Database;
use crate::error::Result;

pub const OLD_NAME: &str = "Annalo";
pub const NEW_NAME: &str = "Arcalo";
/// Release notes of the rename, linked from the notice.
pub const RELEASE_NOTES_URL: &str = "https://github.com/MouseWerk/Arcalo/releases/tag/v1.7.0";

/// Meta row: `pending` (show the notice), `shown`, or `fresh` (a workspace started with 1.7).
const NOTICE: &str = "rebrand.notice";

impl Database {
    /// Records once whether this workspace was used before 1.7 (then the notice is pending).
    /// Runs at start before anything is saved: the meta row `onboarding.first_seen` (written at
    /// the first start of 1.6), stored settings, the welcome choice, pages or projects.
    pub fn rebrand_classify(&self) -> Result<()> {
        if self.meta_get(NOTICE)?.is_some() {
            return Ok(());
        }
        let settings_row: bool =
            self.conn().query_row("SELECT EXISTS(SELECT 1 FROM settings WHERE key = 'app')", [], |r| r.get(0))?;
        let existing = settings_row
            || self.meta_get("onboarding.first_seen")?.is_some()
            || self.meta_get("onboarded")?.is_some()
            || !self.list_projects()?.is_empty()
            || !self.page_tree()?.is_empty();
        self.meta_set(NOTICE, if existing { "pending" } else { "fresh" })
    }

    /// The notice is still to be shown.
    pub fn rebrand_notice_pending(&self) -> Result<bool> {
        Ok(self.meta_get(NOTICE)?.as_deref() == Some("pending"))
    }

    /// The notice was shown (it is shown once).
    pub fn rebrand_notice_shown(&self) -> Result<()> {
        self.meta_set(NOTICE, "shown")
    }
}

/// The file of the old autostart entry under `home` (as `auto-launch` wrote it for the old
/// name): a LaunchAgent on macOS, an XDG autostart entry elsewhere.
pub fn legacy_autostart_file(home: &Path, macos: bool) -> PathBuf {
    if macos {
        home.join("Library").join("LaunchAgents").join(format!("{OLD_NAME}.plist"))
    } else {
        home.join(".config").join("autostart").join(format!("{OLD_NAME}.desktop"))
    }
}

/// The old autostart file at `path`, if it is the app's own (it names the old app): `Some(on)`,
/// whether it is switched on (not hidden or disabled by the desktop's settings), so the new
/// entry is written only then.
pub fn legacy_autostart_state(path: &Path) -> Option<bool> {
    let text = fs::read_to_string(path).ok()?;
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let ours = text.lines().any(|l| l.trim() == format!("Name={OLD_NAME}"))
        || compact.contains(&format!("<key>Label</key><string>{OLD_NAME}</string>"));
    let off = compact.contains("Hidden=true")
        || compact.contains("X-GNOME-Autostart-enabled=false")
        || compact.contains("<key>Disabled</key><true/>");
    ours.then_some(!off)
}

/// [`legacy_autostart_state`], and the file removed.
pub fn take_legacy_autostart_file(path: &Path) -> Result<Option<bool>> {
    let Some(on) = legacy_autostart_state(path) else { return Ok(None) };
    fs::remove_file(path)?;
    Ok(Some(on))
}

/// Old shortcuts (Windows `.lnk`) next to new ones: in the Start menu's `programs` folder (in the
/// folder of the old name or at the top) and on the `desktop`. Each old one goes only when a new
/// one exists, so nobody is left without a shortcut; an emptied folder of the old name goes too.
/// Returns the files removed.
pub fn remove_stale_shortcuts(programs: &Path, desktop: &Path) -> Vec<PathBuf> {
    let old_lnk = format!("{OLD_NAME}.lnk");
    let new_lnk = format!("{NEW_NAME}.lnk");
    let new_in_menu = programs.join(NEW_NAME).join(&new_lnk).is_file() || programs.join(&new_lnk).is_file();
    let mut candidates = Vec::new();
    if new_in_menu {
        candidates.push(programs.join(OLD_NAME).join(&old_lnk));
        candidates.push(programs.join(&old_lnk));
    }
    if desktop.join(&new_lnk).is_file() {
        candidates.push(desktop.join(&old_lnk));
    }
    let removed: Vec<PathBuf> = candidates.into_iter().filter(|p| p.is_file() && fs::remove_file(p).is_ok()).collect();
    // Only while empty.
    let _ = fs::remove_dir(programs.join(OLD_NAME));
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("arcalo-rebrand-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_notice_is_for_workspaces_from_before_and_shown_once() {
        let fresh = Database::open_in_memory().unwrap();
        fresh.rebrand_classify().unwrap();
        assert!(!fresh.rebrand_notice_pending().unwrap(), "a new workspace gets no notice");
        // Pages written later do not change the classification.
        fresh.create_page(None, "Neu", None).unwrap();
        fresh.rebrand_classify().unwrap();
        assert!(!fresh.rebrand_notice_pending().unwrap());

        let used = Database::open_in_memory().unwrap();
        used.meta_set("onboarding.first_seen", "fresh").unwrap(); // started once with 1.6
        used.rebrand_classify().unwrap();
        assert!(used.rebrand_notice_pending().unwrap());
        used.rebrand_classify().unwrap();
        assert!(used.rebrand_notice_pending().unwrap(), "classifying again changes nothing");
        used.rebrand_notice_shown().unwrap();
        used.rebrand_classify().unwrap();
        assert!(!used.rebrand_notice_pending().unwrap(), "shown once");

        let notes = Database::open_in_memory().unwrap();
        notes.create_page(None, "Aus 1.5", None).unwrap();
        notes.rebrand_classify().unwrap();
        assert!(notes.rebrand_notice_pending().unwrap(), "a workspace from before 1.6 too");
    }

    #[test]
    fn the_old_autostart_file_is_taken_once_with_its_state() {
        let home = tmp("autostart");
        let linux = legacy_autostart_file(&home, false);
        assert!(linux.ends_with(".config/autostart/Annalo.desktop"));
        assert!(legacy_autostart_file(&home, true).ends_with("Library/LaunchAgents/Annalo.plist"));
        assert_eq!(take_legacy_autostart_file(&linux).unwrap(), None, "nothing there");

        fs::create_dir_all(linux.parent().unwrap()).unwrap();
        let entry = "[Desktop Entry]\nType=Application\nVersion=1.0\nName=Annalo\nComment=Annalostartup script\n\
                     Exec=/opt/Annalo.AppImage --minimized\nStartupNotify=false\nTerminal=false";
        fs::write(&linux, entry).unwrap();
        assert_eq!(take_legacy_autostart_file(&linux).unwrap(), Some(true));
        assert!(!linux.exists());
        assert_eq!(take_legacy_autostart_file(&linux).unwrap(), None, "idempotent");

        fs::write(&linux, format!("{entry}\nX-GNOME-Autostart-enabled=false")).unwrap();
        assert_eq!(take_legacy_autostart_file(&linux).unwrap(), Some(false), "switched off in the desktop");

        // Another program's file of the same name is left alone.
        fs::write(&linux, "[Desktop Entry]\nName=Annalo Tools\n").unwrap();
        assert_eq!(take_legacy_autostart_file(&linux).unwrap(), None);
        assert!(linux.exists());

        let mac = legacy_autostart_file(&home, true);
        fs::create_dir_all(mac.parent().unwrap()).unwrap();
        fs::write(
            &mac,
            "<?xml version=\"1.0\"?>\n<plist version=\"1.0\">\n  <dict>\n  <key>Label</key>\n  <string>Annalo</string>\n  \
             <key>ProgramArguments</key>\n  <array><string>/Applications/Annalo.app/Contents/MacOS/annalo</string></array>\n  \
             <key>RunAtLoad</key>\n  <true/>\n  </dict>\n</plist>",
        )
        .unwrap();
        assert_eq!(take_legacy_autostart_file(&mac).unwrap(), Some(true));
        assert!(!mac.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn old_shortcuts_go_only_next_to_new_ones() {
        let base = tmp("shortcuts");
        let (programs, desktop) = (base.join("Programs"), base.join("Desktop"));
        fs::create_dir_all(programs.join("Annalo")).unwrap();
        fs::create_dir_all(&desktop).unwrap();
        fs::write(programs.join("Annalo").join("Annalo.lnk"), b"alt").unwrap();
        fs::write(desktop.join("Annalo.lnk"), b"alt").unwrap();
        assert!(remove_stale_shortcuts(&programs, &desktop).is_empty(), "no new shortcuts yet: the old ones stay");
        assert!(programs.join("Annalo").join("Annalo.lnk").exists());

        fs::create_dir_all(programs.join("Arcalo")).unwrap();
        fs::write(programs.join("Arcalo").join("Arcalo.lnk"), b"neu").unwrap();
        let removed = remove_stale_shortcuts(&programs, &desktop);
        assert_eq!(removed, [programs.join("Annalo").join("Annalo.lnk")]);
        assert!(!programs.join("Annalo").exists(), "the emptied folder goes");
        assert!(desktop.join("Annalo.lnk").exists(), "no new desktop shortcut: the old one stays");

        fs::write(desktop.join("Arcalo.lnk"), b"neu").unwrap();
        assert_eq!(remove_stale_shortcuts(&programs, &desktop), [desktop.join("Annalo.lnk")]);
        assert!(remove_stale_shortcuts(&programs, &desktop).is_empty(), "idempotent");
        assert!(programs.join("Arcalo").join("Arcalo.lnk").exists() && desktop.join("Arcalo.lnk").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
