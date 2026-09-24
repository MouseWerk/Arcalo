//! Markdown mirror: after each backup the whole workspace is written as plain
//! Markdown files (the vault export, with images) plus the time entries as monthly
//! CSV files, so the notes stay readable without the app.
//!
//! There is one mirror folder, updated in place: the new state is built in a
//! staging folder next to it and swapped in with two renames (old → `.name.old`,
//! staging → name), so the folder is always either the previous or the new
//! complete state. A folder is only ever replaced when it is empty or carries the
//! mirror's `README.txt`, never a folder with other contents.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Local, TimeZone, Utc};
use serde::{Deserialize, Serialize};

use crate::db::{Database, EntryFilter};
use crate::error::{Error, Result};
use crate::export::field;
use crate::model::{StatusFlag, TimeEntryRow};
use crate::vault;

/// Marker file at the root of a mirror.
pub const README_NAME: &str = "README.txt";
/// First line of [`README_NAME`]; identifies a folder as a mirror that may be replaced.
pub(crate) const MARKER: &str = "Annalo – Markdown-Kopie";
/// Folder for the monthly time-entry CSV files.
pub const TIME_DIR: &str = "Zeiterfassung";

const README: &str = "Annalo – Markdown-Kopie\r
\r
Dieser Ordner ist eine schreibgeschützte Kopie des Arbeitsbereichs, damit die\r
Notizen auch ohne Annalo lesbar bleiben. Er wird bei jeder Sicherung\r
vollständig neu erzeugt: Änderungen hier gehen dabei verloren.\r
\r
- Jede Seite ist eine Markdown-Datei (.md), Unterseiten liegen im gleichnamigen Ordner.\r
- Eingebettete Bilder, Zeichnungen und Dateien liegen in attachments/.\r
- Zeiterfassung/JJJJ-MM.csv enthält die abgeschlossenen Buchungen je Monat\r
  (Semikolon getrennt, Dezimalkomma, UTF-8 – lässt sich direkt in Excel öffnen).\r
\r
Wiederherstellen: die Datenbank aus einer Sicherung (annalo-….db) verwenden,\r
oder diesen Ordner in Annalo als Obsidian-Vault importieren.\r
";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MirrorReport {
    pub path: String,
    /// Markdown files written.
    pub pages: usize,
    /// Monthly CSV files written.
    pub csv_files: usize,
    pub created_at: DateTime<Local>,
}

/// Rebuilds the mirror at `target` from `db` (attachments from `attachments_dir`).
/// `offset` decides the local day and month of each booking.
pub fn write_mirror<Tz: TimeZone>(
    db: &Database,
    target: &Path,
    attachments_dir: &Path,
    offset: &Tz,
) -> Result<MirrorReport>
where
    Tz::Offset: std::fmt::Display,
{
    write_snapshot(&MirrorSnapshot::read(db)?, target, attachments_dir, offset)
}

/// What the mirror holds, read from the database in one consistent state. Writing it
/// ([`write_snapshot`]) needs no database, so the files are written while saves go on.
pub struct MirrorSnapshot {
    vault: vault::VaultSnapshot,
    rows: Vec<TimeEntryRow>,
}

impl MirrorSnapshot {
    pub fn read(db: &Database) -> Result<Self> {
        db.read_snapshot(|db| {
            Ok(MirrorSnapshot {
                vault: vault::VaultSnapshot::read(db)?,
                rows: db.list_time_entries(&EntryFilter::default())?,
            })
        })
    }
}

/// [`write_mirror`] from a [`MirrorSnapshot`].
pub fn write_snapshot<Tz: TimeZone>(
    snap: &MirrorSnapshot,
    target: &Path,
    attachments_dir: &Path,
    offset: &Tz,
) -> Result<MirrorReport>
where
    Tz::Offset: std::fmt::Display,
{
    let (pages, csv_files) = replace_dir(target, |dir| {
        let pages = vault::export_snapshot(&snap.vault, dir, attachments_dir)?;
        let months = time_entries_csv(&snap.rows, offset);
        if !months.is_empty() {
            let out = dir.join(TIME_DIR);
            fs::create_dir_all(&out)?;
            for (month, csv) in &months {
                fs::write(out.join(format!("{month}.csv")), csv)?;
            }
        }
        fs::write(dir.join(README_NAME), README)?;
        Ok((pages, months.len()))
    })?;
    Ok(MirrorReport { path: target.display().to_string(), pages, csv_files, created_at: Local::now() })
}

/// True when `dir` holds a mirror written by [`write_mirror`].
pub fn is_mirror(dir: &Path) -> bool {
    fs::read_to_string(dir.join(README_NAME)).is_ok_and(|s| s.starts_with(MARKER))
}

/// Held while a mirror folder is swapped, and by readers that need one complete state
/// (the Git sync copies the mirror under it), so a reader never sees the gap between the
/// two renames or a half-removed old folder.
static SWAP: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Blocks mirror swaps until the guard is dropped.
pub fn hold_swaps() -> std::sync::MutexGuard<'static, ()> {
    SWAP.lock().unwrap_or_else(|e| e.into_inner())
}

/// Sibling paths used while swapping: `.name.staging` and `.name.old`.
fn siblings(target: &Path) -> Result<(PathBuf, PathBuf)> {
    let invalid = || Error::State(format!("Ungültiger Ordner für die Markdown-Kopie: {}", target.display()));
    let parent = target.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(invalid)?;
    let name = target.file_name().and_then(|n| n.to_str()).ok_or_else(invalid)?;
    Ok((parent.join(format!(".{name}.staging")), parent.join(format!(".{name}.old"))))
}

/// Fills a fresh staging folder with `fill` and swaps it in for `target`.
/// If `fill` fails, `target` is left untouched. A `target` that exists but is neither
/// empty nor a mirror is refused, so a wrongly chosen folder is never replaced.
pub fn replace_dir<T>(target: &Path, fill: impl FnOnce(&Path) -> Result<T>) -> Result<T> {
    let (staging, old) = siblings(target)?;
    // An interrupted swap left the previous mirror as `.old`: put it back first.
    if !target.exists() && old.is_dir() {
        let _swap = hold_swaps();
        fs::rename(&old, target)?;
    }
    if target.exists() {
        if !target.is_dir() {
            return Err(Error::State(format!("{} ist kein Ordner", target.display())));
        }
        let empty = fs::read_dir(target)?.next().is_none();
        if !empty && !is_mirror(target) {
            return Err(Error::State(format!(
                "Der Ordner {} ist nicht leer und keine Markdown-Kopie von Annalo – bitte einen leeren Ordner wählen",
                target.display()
            )));
        }
    }
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    fs::create_dir_all(&staging)?;
    let value = match fill(&staging) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };
    let _swap = hold_swaps();
    if old.exists() {
        fs::remove_dir_all(&old)?;
    }
    let had_old = target.exists();
    if had_old && let Err(e) = fs::rename(target, &old) {
        let _ = fs::remove_dir_all(&staging);
        return Err(Error::State(format!(
            "Markdown-Kopie nicht ersetzt (Ordner in Benutzung?): {}: {e}",
            target.display()
        )));
    }
    if let Err(e) = fs::rename(&staging, target) {
        if had_old {
            let _ = fs::rename(&old, target);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(e.into());
    }
    if had_old {
        // A leftover `.old` is removed by the next run.
        let _ = fs::remove_dir_all(&old);
    }
    Ok(value)
}

fn german_hours(minutes: i64) -> String {
    format!("{:.2}", minutes as f64 / 60.0).replace('.', ",")
}

fn status_de(s: StatusFlag) -> &'static str {
    match s {
        StatusFlag::Running => "läuft",
        StatusFlag::Draft => "Entwurf",
        StatusFlag::Released => "freigegeben",
        StatusFlag::Exported => "exportiert",
    }
}

/// Finished time entries as one CSV per local month (`YYYY-MM`, oldest first), ready for a
/// German Excel: UTF-8 BOM, `;` separated, decimal comma, CRLF line ends.
pub fn time_entries_csv<Tz: TimeZone>(rows: &[TimeEntryRow], offset: &Tz) -> Vec<(String, String)>
where
    Tz::Offset: std::fmt::Display,
{
    const HEAD: &str =
        "Datum;Beginn;Ende;Stunden;Projekt;Netzplan;PSP-Element;Vorgang;Leistungsart;Beschreibung;Status\r\n";
    let mut sorted: Vec<&TimeEntryRow> = rows
        .iter()
        .filter(|r| r.entry.status_flag != StatusFlag::Running && r.entry.duration_minutes.is_some())
        .collect();
    sorted.sort_by_key(|r| (r.entry.start_time, r.entry.id));
    let mut months: BTreeMap<String, String> = BTreeMap::new();
    for r in sorted {
        let e = &r.entry;
        let minutes = e.duration_minutes.unwrap_or(0);
        let start = e.start_time.with_timezone(offset);
        let end_utc: DateTime<Utc> = e.end_time.unwrap_or(e.start_time + chrono::Duration::minutes(minutes));
        let end = end_utc.with_timezone(offset);
        let out = months.entry(start.format("%Y-%m").to_string()).or_insert_with(|| format!("\u{FEFF}{HEAD}"));
        let cols = [
            start.format("%d.%m.%Y").to_string(),
            start.format("%H:%M").to_string(),
            end.format("%H:%M").to_string(),
            german_hours(minutes),
            r.project_code.clone(),
            r.netzplan_nr.clone(),
            r.wbs_element.clone(),
            e.vorgang_nr.clone().unwrap_or_default(),
            e.leistungsart.clone().unwrap_or_default(),
            e.description.clone(),
            status_de(e.status_flag).to_owned(),
        ];
        let line: Vec<String> = cols.iter().map(|c| field(c, ';')).collect();
        out.push_str(&line.join(";"));
        out.push_str("\r\n");
    }
    months.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{EntrySource, TimeEntry};
    use chrono::FixedOffset;

    fn tmp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("annalo-mirror-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        v.sort();
        v
    }

    fn write_marker(dir: &Path, extra: &str) -> Result<()> {
        fs::write(dir.join(README_NAME), README)?;
        fs::write(dir.join(extra), extra)?;
        Ok(())
    }

    #[test]
    fn swap_replaces_mirror_and_keeps_it_on_failure() {
        let base = tmp("swap");
        let target = base.join("markdown");

        // First run creates the folder.
        replace_dir(&target, |d| write_marker(d, "a.md")).unwrap();
        assert_eq!(names(&target), ["README.txt", "a.md"]);
        // Second run replaces it completely; no staging or old folder is left behind.
        replace_dir(&target, |d| write_marker(d, "b.md")).unwrap();
        assert_eq!(names(&target), ["README.txt", "b.md"]);
        assert_eq!(names(&base), ["markdown"]);

        // A failing build leaves the previous mirror as it was.
        let err = replace_dir(&target, |d| {
            fs::write(d.join("halb.md"), "x")?;
            Err::<(), _>(Error::State("kaputt".into()))
        });
        assert!(err.is_err());
        assert_eq!(names(&target), ["README.txt", "b.md"]);
        assert_eq!(names(&base), ["markdown"]);

        // An interrupted swap (only `.old` left) is recovered before the next run.
        fs::rename(&target, base.join(".markdown.old")).unwrap();
        fs::create_dir_all(base.join(".markdown.staging")).unwrap();
        let seen = replace_dir(&target, |d| {
            let _ = fs::read_dir(d)?; // staging starts empty
            assert!(names(d).is_empty());
            write_marker(d, "c.md")
        });
        assert!(seen.is_ok());
        assert_eq!(names(&target), ["README.txt", "c.md"]);
        assert_eq!(names(&base), ["markdown"]);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn swap_refuses_foreign_folders() {
        let base = tmp("foreign");
        let target = base.join("Dokumente");
        fs::create_dir_all(&target).unwrap();
        fs::write(target.join("Steuer.pdf"), "wichtig").unwrap();
        let err = replace_dir(&target, |d| write_marker(d, "a.md")).unwrap_err().to_string();
        assert!(err.contains("nicht leer"), "{err}");
        assert_eq!(names(&target), ["Steuer.pdf"]);
        assert_eq!(names(&base), ["Dokumente"], "no staging folder left");

        // An empty folder may be used.
        let empty = base.join("leer");
        fs::create_dir_all(&empty).unwrap();
        replace_dir(&empty, |d| write_marker(d, "a.md")).unwrap();
        assert!(is_mirror(&empty));
        let _ = fs::remove_dir_all(&base);
    }

    fn row(id: i64, start: (u32, u32, u32), minutes: Option<i64>, status: StatusFlag, desc: &str) -> TimeEntryRow {
        let start = Utc.with_ymd_and_hms(2026, start.0, start.1, start.2, 0, 0).unwrap();
        TimeEntryRow {
            entry: TimeEntry {
                id,
                netzplan_id: 1,
                vorgang_nr: Some("1020".into()),
                leistungsart: Some("DEV".into()),
                start_time: start,
                end_time: minutes.map(|m| start + chrono::Duration::minutes(m)),
                duration_minutes: minutes,
                description: desc.into(),
                status_flag: status,
                source: EntrySource::Manual,
                page_id: None,
            },
            project_code: "PRJ-2026-X".into(),
            netzplan_nr: "NP-8801".into(),
            wbs_element: "NP-8801-1020".into(),
        }
    }

    #[test]
    fn csv_per_month_for_german_excel() {
        let cet = FixedOffset::east_opt(2 * 3600).unwrap();
        let rows = [
            row(2, (9, 22, 7), Some(90), StatusFlag::Released, "Review; Teil \"2\""),
            // 23:30 UTC on 30 Sep is 1 Oct locally.
            row(3, (9, 30, 22), Some(450), StatusFlag::Draft, "=SUMME(A1)"),
            row(1, (9, 21, 6), Some(30), StatusFlag::Exported, "Agenda"),
            row(4, (9, 23, 8), None, StatusFlag::Running, "läuft"),
        ];
        let out = time_entries_csv(&rows, &cet);
        assert_eq!(out.iter().map(|(m, _)| m.as_str()).collect::<Vec<_>>(), ["2026-09", "2026-10"]);
        let sep = &out[0].1;
        assert!(sep.starts_with("\u{FEFF}Datum;Beginn;Ende;Stunden;"), "BOM and header");
        let lines: Vec<&str> = sep.trim_end().split("\r\n").collect();
        assert_eq!(lines.len(), 3, "running timer left out: {lines:?}");
        assert_eq!(lines[1], "21.09.2026;08:00;08:30;0,50;PRJ-2026-X;NP-8801;NP-8801-1020;1020;DEV;Agenda;exportiert");
        assert_eq!(
            lines[2],
            "22.09.2026;09:00;10:30;1,50;PRJ-2026-X;NP-8801;NP-8801-1020;1020;DEV;\"Review; Teil \"\"2\"\"\";freigegeben"
        );
        let oct: Vec<&str> = out[1].1.trim_end().split("\r\n").collect();
        assert_eq!(oct[1], "01.10.2026;00:00;07:30;7,50;PRJ-2026-X;NP-8801;NP-8801-1020;1020;DEV;'=SUMME(A1);Entwurf");
        assert!(time_entries_csv(&[], &cet).is_empty());
    }

    #[test]
    fn writes_pages_csv_and_readme() {
        let base = tmp("full");
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 40.0).unwrap();
        db.insert_time_entry(&crate::model::NewTimeEntry {
            netzplan_id: np.id,
            vorgang_nr: None,
            leistungsart: None,
            start_time: Utc.with_ymd_and_hms(2026, 9, 22, 8, 0, 0).unwrap(),
            duration_minutes: 60,
            description: "Test".into(),
            source: EntrySource::Manual,
            page_id: None,
        })
        .unwrap();
        let page = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(page.id, "Hallo ![[bild.png]]").unwrap();
        let att = base.join("att");
        fs::create_dir_all(&att).unwrap();
        fs::write(att.join("bild.png"), [1u8, 2, 3]).unwrap();

        let target = base.join("markdown");
        let r = write_mirror(&db, &target, &att, &Utc).unwrap();
        assert_eq!((r.pages, r.csv_files), (1, 1));
        assert!(is_mirror(&target));
        assert_eq!(fs::read_to_string(target.join("Notiz.md")).unwrap(), "Hallo ![[bild.png]]");
        assert_eq!(fs::read(target.join("attachments/bild.png")).unwrap(), [1u8, 2, 3]);
        let csv = fs::read_to_string(target.join("Zeiterfassung/2026-09.csv")).unwrap();
        assert!(csv.contains("22.09.2026;08:00;09:00;1,00;"), "{csv}");

        // Renamed page: the old file disappears on the next run.
        db.rename_page(page.id, "Umbenannt").unwrap();
        write_mirror(&db, &target, &att, &Utc).unwrap();
        assert!(!target.join("Notiz.md").exists());
        assert!(target.join("Umbenannt.md").exists());
        let _ = fs::remove_dir_all(&base);
    }
}
