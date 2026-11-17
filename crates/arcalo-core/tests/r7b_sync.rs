//! q124 round 7 (hunt B): the Git sync between computers and the phone's chips.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use arcalo_core::Database;
use arcalo_core::chips::{ChipLink, ChipQuery, chips};
use arcalo_core::companion;
use arcalo_core::gitsync::{self, Git, GitSyncSettings, SyncRequest};
use arcalo_core::merge::merge3;
use arcalo_core::tracking::Thresholds;
use chrono::{DateTime, FixedOffset, Local, NaiveDate, Utc};

/// A fresh, empty folder (removed on drop).
struct TempDir(PathBuf);
impl TempDir {
    fn new(tag: &str) -> TempDir {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let p = std::env::temp_dir().join(format!(
            "arcalo-r7b-sync-{tag}-{}-{}",
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

fn tz() -> FixedOffset {
    FixedOffset::east_opt(2 * 3600).unwrap()
}

fn at(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
}

fn wbs(db: &Database) {
    let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
    let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
    db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 6.0).unwrap();
}

/// Two desktops (office and laptop) share their notes through the Git sync; bookings stay in each
/// computer's database. Both count their booking ids from 1, so the laptop's chip in the daily
/// note that reaches the office names an office booking of the same note: the office takes it
/// for its own booking (the editor writes that booking's values over it, removing the chip
/// deletes the office's booking, and the office's own chip after it shows as a copy).
#[test]
fn a_chip_booked_on_another_desktop_never_names_a_booking_here() {
    let t = Thresholds::default();
    let now = at("2026-11-16T15:00:00+02:00");
    let day = NaiveDate::from_ymd_opt(2026, 11, 16).unwrap();
    let office = Database::open_in_memory().unwrap();
    wbs(&office);
    let mine = companion::book(&office, "/zeit NP-8801/1020 2h Workshop im Büro", now, &tz(), &t).unwrap().entry;
    let laptop = Database::open_in_memory().unwrap();
    wbs(&laptop);
    let theirs = companion::book(&laptop, "/zeit NP-8801 30m Abends am Laptop", now, &tz(), &t).unwrap().entry;

    // The sync brings the laptop's chip into the office's daily note (the merge of both notes).
    let laptop_note = laptop.page_doc(laptop.daily_note(day).unwrap().id).unwrap().content;
    let chip = chips(&laptop_note).into_iter().find(|c| c.entry_id() == Some(theirs.id)).unwrap();
    let office_day = office.daily_note(day).unwrap();
    let merged = format!("{}\n{}\n", &laptop_note[chip.range.clone()], office.page_doc(office_day.id).unwrap().content);
    office.save_page_content(office_day.id, &merged).unwrap();

    let q = ChipQuery {
        id: theirs.id,
        target: chip.attr("target").unwrap().to_owned(),
        ws: chip.attr("ws").map(Into::into),
    };
    let state = office.chip_states(office_day.id, &[q]).unwrap().remove(0);
    assert_eq!(
        state.link,
        ChipLink::Missing,
        "the laptop's chip (id {}, „Abends am Laptop“) is shown as the office's booking {} („{}“)",
        theirs.id,
        mine.id,
        state.row.map(|r| r.entry.description).unwrap_or_default()
    );
}

/// A board card's properties changed on two computers, a different property on each (the status
/// moved on the office's board, the effort entered on the laptop): both changes belong to the
/// merged note, as with two different lines of the text. The front matter is one block for the
/// merge, so this is a conflict of the whole front matter: „Meine“ or „Andere“ loses one change,
/// and „Beide“ writes two front matters, the second one into the text of the note.
#[test]
fn different_properties_changed_on_two_computers_merge() {
    let base = "---\nstatus: Offen\naufwand: 1\nfällig: 2026-11-20\n---\n# Karte\n\nText\n";
    let office = "---\nstatus: In Arbeit\naufwand: 1\nfällig: 2026-11-20\n---\n# Karte\n\nText\n";
    let laptop = "---\nstatus: Offen\naufwand: 3\nfällig: 2026-11-20\n---\n# Karte\n\nText\n";
    let m = merge3(Some(base), office, laptop);
    assert_eq!(
        m.merged().as_deref(),
        Some("---\nstatus: In Arbeit\naufwand: 3\nfällig: 2026-11-20\n---\n# Karte\n\nText\n"),
        "{} conflict(s): {:?}",
        m.conflicts,
        m.chunks
    );
}

fn git_available() -> bool {
    Command::new("git").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(["-c", "user.name=Test", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"])
        .args(args)
        .current_dir(dir)
        .output()
        .unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

fn write(p: &Path, content: &[u8]) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, content).unwrap();
}

/// The user's own git configuration names a global ignore file (`core.excludesFile`, or git's
/// default `~/.config/git/ignore`), as many developers have: `*.log`, `*.zip`, `build/`, `tmp/`.
/// The sync's `git add -A` honours it, so an attached log file or a page folder of such a name
/// is never committed: it silently never reaches the other computers, and the note there links
/// a file that does not exist.
#[test]
fn files_the_users_global_git_ignore_names_are_synced_too() {
    if !git_available() {
        eprintln!("git not available, skipped");
        return;
    }
    let base = TempDir::new("ignore");
    let (src, repo, bare) = (base.0.join("mirror"), base.0.join("git-sync"), base.0.join("remote.git"));
    sh(&base.0, &["init", "-q", "--bare", bare.to_str().unwrap()]);
    write(&src.join(arcalo_core::mirror::README_NAME), "Arcalo – Markdown-Kopie".as_bytes());
    write(&src.join("Fehler.md"), b"Siehe ![](attachments/server.log)\n");
    write(&src.join("attachments/server.log"), b"ERROR 42\n");
    write(&src.join("Build.md"), b"# Build\n");
    write(&src.join("build/Pipeline.md"), b"Schritte der Pipeline\n");
    // The user's global git configuration with its ignore file.
    let home = base.0.join("home");
    write(&home.join("ignore"), b"*.log\nbuild/\n");
    write(&home.join("gitconfig"), format!("[core]\n\texcludesFile = {}\n", home.join("ignore").display()).as_bytes());
    let settings =
        GitSyncSettings { enabled: true, remote_url: bare.to_str().unwrap().to_owned(), ..Default::default() };
    let network = arcalo_core::network::GitNetwork {
        env: vec![("GIT_CONFIG_GLOBAL".into(), Some(home.join("gitconfig").display().to_string()))],
        ..Default::default()
    };
    let git = Git::new(None, &settings.remote_url).with_network(network);
    let out = gitsync::sync(
        &git,
        &SyncRequest {
            repo: &repo,
            source: &src,
            database: None,
            settings: &settings,
            host: "pc1",
            now: Local::now(),
            hold: &[],
            allow_deletions: false,
            settings_file: None,
            companion: false,
        },
    )
    .unwrap();
    assert!(out.committed, "{out:?}");
    let files = sh(&bare, &["ls-tree", "-r", "--name-only", "main"]);
    for f in ["Fehler.md", "attachments/server.log", "build/Pipeline.md"] {
        assert!(files.lines().any(|l| l == f), "{f} is not on the server: {files}");
    }
}
