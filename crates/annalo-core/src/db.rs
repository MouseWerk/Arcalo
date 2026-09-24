//! Embedded SQLite store.
//!
//! One file per workspace, WAL mode, foreign keys on. Schema changes are
//! numbered migrations tracked through `PRAGMA user_version`.

use std::collections::HashMap;
use std::path::Path;

use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OptionalExtension, Row, params};

use crate::error::{Error, Result};
use crate::model::*;

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/0001_init.sql"),
    include_str!("../migrations/0002_documents.sql"),
    include_str!("../migrations/0003_trash.sql"),
    include_str!("../migrations/0004_tasks.sql"),
    include_str!("../migrations/0005_entry_page.sql"),
    include_str!("../migrations/0006_page_versions.sql"),
    include_str!("../migrations/0007_activity_focus.sql"),
    include_str!("../migrations/0008_lookup_indexes.sql"),
];

/// A migration with this marker adds a derived page index; every page is re-indexed after it ran.
const REINDEX_MARKER: &str = "-- annalo:reindex";

/// Settings key of the flag that a re-index is pending. It is set in the same transaction as
/// the migration that needs it and cleared with the re-index, so a crash in between re-runs it.
const NEEDS_REINDEX: &str = "needs_reindex";

pub(crate) const PAGE_COLS: &str = "id, parent_id, title, icon, position, updated_at, favorite, daily_date, deleted_at";

pub(crate) fn map_page(r: &Row) -> rusqlite::Result<Page> {
    Ok(Page {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        title: r.get(2)?,
        icon: r.get(3)?,
        position: r.get(4)?,
        updated_at: r.get(5)?,
        favorite: r.get(6)?,
        daily_date: r.get(7)?,
        deleted_at: r.get(8)?,
    })
}

/// Part of the error for a database written by a newer Annalo (start-up tells it apart).
pub const NEWER_SCHEMA: &str = "neueren Annalo-Version";

pub struct Database {
    conn: Connection,
    /// Nesting depth of [`Database::atomic`] (0: no savepoint of ours is open).
    depth: std::sync::atomic::AtomicUsize,
    /// The stored settings JSON and what it parsed to: a save reads the settings (version
    /// policy), and parsing them each time costs more than the save itself for small pages.
    pub(crate) settings_cache: std::cell::RefCell<Option<(String, crate::settings::Settings)>>,
}

pub(crate) fn ts(t: DateTime<Utc>) -> String {
    t.to_rfc3339_opts(SecondsFormat::Secs, true)
}

pub(crate) fn parse_ts(s: &str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.with_timezone(&Utc))
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e)))
}

/// Turns a foreign-key violation on delete into a readable message.
fn booked_guard(e: rusqlite::Error, what: &str) -> Error {
    match e {
        rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => {
            Error::State(format!("{what} hat gebuchte Zeiten und kann nicht gelöscht werden"))
        }
        other => Error::Db(other),
    }
}

/// Booked minutes of one Netzplan, see [`Database::booked_minutes_all`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BookedMinutes {
    pub total: i64,
    /// By Vorgang number in ASCII lower case.
    pub by_vorgang: HashMap<String, i64>,
}

impl BookedMinutes {
    /// Minutes booked on the Vorgang `nr` (compared like `COLLATE NOCASE`).
    pub fn vorgang(&self, nr: &str) -> i64 {
        self.by_vorgang.get(&nr.to_ascii_lowercase()).copied().unwrap_or(0)
    }
}

/// Filter for [`Database::list_time_entries`]. `None` fields do not filter.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct EntryFilter {
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
    pub netzplan_id: Option<i64>,
    pub status: Option<StatusFlag>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA temp_store = MEMORY;",
        )?;
        let mut db = Database { conn, depth: Default::default(), settings_cache: Default::default() };
        db.migrate()?;
        Ok(db)
    }

    /// A second, read-only connection to the workspace at `path` (already opened and migrated
    /// by [`Database::open`]). In WAL mode it reads the last committed state while the main
    /// connection writes, so long reads (lists, the Markdown mirror) never wait for a save
    /// and a save never waits for them. Refuses a database this build cannot read.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self> {
        use rusqlite::OpenFlags;
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.execute_batch("PRAGMA temp_store = MEMORY;")?;
        let db = Database { conn, depth: Default::default(), settings_cache: Default::default() };
        if db.schema_version()? != MIGRATIONS.len() {
            return Err(Error::State("Datenbank noch nicht auf dem aktuellen Stand".into()));
        }
        Ok(db)
    }

    /// Runs `f` inside one read transaction, so everything it reads is one consistent state
    /// (the Markdown mirror reads the tree, all pages and all time entries).
    pub fn read_snapshot<T>(&self, f: impl FnOnce(&Self) -> Result<T>) -> Result<T> {
        if !self.conn.is_autocommit() {
            return f(self);
        }
        self.conn.execute_batch("BEGIN DEFERRED")?;
        let res = f(self);
        let _ = self.conn.execute_batch("COMMIT");
        res
    }

    fn migrate(&mut self) -> Result<()> {
        let current = self.schema_version()?;
        if current > MIGRATIONS.len() {
            return Err(Error::State(format!(
                "Die Datenbank stammt von einer {NEWER_SCHEMA} (Schema v{current}, diese kennt v{}). Bitte Annalo aktualisieren.",
                MIGRATIONS.len()
            )));
        }
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(current) {
            // v2 turned blocks into a derived chunk index (and created the settings table);
            // build it (and later derived indexes) from page content.
            let reindex = i >= 1 && (i == 1 || sql.contains(REINDEX_MARKER));
            let tx = self.conn.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", (i + 1) as i64)?;
            if reindex {
                tx.execute(
                    "INSERT INTO settings (key, value) VALUES (?1, '1')
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    [format!("meta.{NEEDS_REINDEX}")],
                )?;
            }
            tx.commit()?;
        }
        if MIGRATIONS.len() >= 2 && self.meta_get(NEEDS_REINDEX)?.is_some() {
            self.atomic(|| {
                self.reindex_all()?;
                self.conn.execute("DELETE FROM settings WHERE key = ?1", [format!("meta.{NEEDS_REINDEX}")])?;
                Ok(())
            })?;
        }
        Ok(())
    }

    pub fn schema_version(&self) -> Result<usize> {
        let v: i64 = self.conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        Ok(v.max(0) as usize)
    }

    /// Runs `f` atomically. Uses SAVEPOINTs, so calls may nest (e.g. a vault
    /// import that saves many pages).
    ///
    /// The outermost savepoint commits on release. When that fails (disk full, I/O error,
    /// locked file) everything since the savepoint is rolled back and the error returned:
    /// the connection never stays inside a transaction, where later saves would look
    /// successful but never be committed.
    pub fn atomic<T>(&self, f: impl FnOnce() -> Result<T>) -> Result<T> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let outermost = self.depth.load(Ordering::Relaxed) == 0;
        if outermost && !self.conn.is_autocommit() {
            // Someone left a transaction open (it can only be a failed one): never build on it.
            eprintln!("annalo: open transaction found outside of atomic(), rolled back");
            let _ = self.conn.execute_batch("ROLLBACK");
        }
        let name = format!("sp{}", SEQ.fetch_add(1, Ordering::Relaxed));
        self.conn.execute_batch(&format!("SAVEPOINT {name}"))?;
        self.depth.fetch_add(1, Ordering::Relaxed);
        let res = f().and_then(|v| self.conn.execute_batch(&format!("RELEASE {name}")).map(|_| v).map_err(Into::into));
        self.depth.fetch_sub(1, Ordering::Relaxed);
        if res.is_err() {
            // SQLite may already have rolled the whole transaction back (then the savepoint is
            // gone); an outermost one must end outside any transaction either way.
            let _ = self.conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"));
            if outermost && !self.conn.is_autocommit() {
                let _ = self.conn.execute_batch("ROLLBACK");
            }
        }
        res
    }

    /// Escape hatch for modules that run their own queries (search, RAG).
    pub fn conn(&self) -> &Connection {
        &self.conn
    }

    // ---------------------------------------------------------------- projects

    pub fn create_project(&self, project_code: &str, name: &str) -> Result<Project> {
        self.conn.execute("INSERT INTO projects (project_code, name) VALUES (?1, ?2)", params![project_code, name])?;
        self.project_by_id(self.conn.last_insert_rowid())
    }

    fn map_project(r: &Row) -> rusqlite::Result<Project> {
        Ok(Project { id: r.get(0)?, project_code: r.get(1)?, name: r.get(2)?, created_at: r.get(3)? })
    }

    pub fn project_by_id(&self, id: i64) -> Result<Project> {
        self.conn
            .query_row("SELECT id, project_code, name, created_at FROM projects WHERE id = ?1", [id], Self::map_project)
            .optional()?
            .ok_or_else(|| Error::not_found("project", id.to_string()))
    }

    pub fn project_by_code(&self, code: &str) -> Result<Project> {
        self.conn
            .query_row(
                "SELECT id, project_code, name, created_at FROM projects WHERE project_code = ?1 COLLATE NOCASE",
                [code],
                Self::map_project,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("project", code))
    }

    pub fn list_projects(&self) -> Result<Vec<Project>> {
        let mut st = self
            .conn
            .prepare_cached("SELECT id, project_code, name, created_at FROM projects ORDER BY project_code")?;
        let rows = st.query_map([], Self::map_project)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    // -------------------------------------------------------------- netzpläne

    pub fn create_netzplan(
        &self,
        project_id: i64,
        netzplan_nr: &str,
        wbs_element: &str,
        description: &str,
        planned_hours: f64,
    ) -> Result<Netzplan> {
        self.conn.execute(
            "INSERT INTO netzplaene (project_id, netzplan_nr, wbs_element, description, planned_hours)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![project_id, netzplan_nr, wbs_element, description, planned_hours],
        )?;
        self.netzplan_by_id(self.conn.last_insert_rowid())
    }

    const NETZPLAN_COLS: &'static str = "id, project_id, netzplan_nr, wbs_element, description, planned_hours";

    fn map_netzplan(r: &Row) -> rusqlite::Result<Netzplan> {
        Ok(Netzplan {
            id: r.get(0)?,
            project_id: r.get(1)?,
            netzplan_nr: r.get(2)?,
            wbs_element: r.get(3)?,
            description: r.get(4)?,
            planned_hours: r.get(5)?,
        })
    }

    pub fn netzplan_by_id(&self, id: i64) -> Result<Netzplan> {
        self.conn
            .query_row(
                &format!("SELECT {} FROM netzplaene WHERE id = ?1", Self::NETZPLAN_COLS),
                [id],
                Self::map_netzplan,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("netzplan", id.to_string()))
    }

    /// Resolves a Netzplan by its number or by its WBS (PSP) element.
    pub fn netzplan_by_ref(&self, reference: &str) -> Result<Netzplan> {
        self.conn
            .query_row(
                &format!(
                    "SELECT {} FROM netzplaene
                     WHERE netzplan_nr = ?1 COLLATE NOCASE OR wbs_element = ?1 COLLATE NOCASE
                     ORDER BY netzplan_nr = ?1 COLLATE NOCASE DESC LIMIT 1",
                    Self::NETZPLAN_COLS
                ),
                [reference],
                Self::map_netzplan,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("netzplan", reference))
    }

    pub fn list_netzplaene(&self, project_id: Option<i64>) -> Result<Vec<Netzplan>> {
        let rows = match project_id {
            Some(p) => self
                .conn
                .prepare_cached(&format!(
                    "SELECT {} FROM netzplaene WHERE project_id = ?1 ORDER BY netzplan_nr",
                    Self::NETZPLAN_COLS
                ))?
                .query_map([p], Self::map_netzplan)?
                .collect::<rusqlite::Result<_>>()?,
            None => self
                .conn
                .prepare_cached(&format!("SELECT {} FROM netzplaene ORDER BY netzplan_nr", Self::NETZPLAN_COLS))?
                .query_map([], Self::map_netzplan)?
                .collect::<rusqlite::Result<_>>()?,
        };
        Ok(rows)
    }

    // --------------------------------------------------------------- vorgänge

    pub fn create_vorgang(
        &self,
        netzplan_id: i64,
        vorgang_nr: &str,
        description: &str,
        duration_days: f64,
        planned_hours: f64,
    ) -> Result<Vorgang> {
        self.conn.execute(
            "INSERT INTO vorgaenge (netzplan_id, vorgang_nr, description, duration_days, planned_hours)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![netzplan_id, vorgang_nr, description, duration_days, planned_hours],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Vorgang {
            id,
            netzplan_id,
            vorgang_nr: vorgang_nr.to_owned(),
            description: description.to_owned(),
            duration_days,
            planned_hours,
            remaining_hours: None,
            predecessors: vec![],
        })
    }

    pub fn link_vorgaenge(&self, predecessor_id: i64, successor_id: i64) -> Result<()> {
        self.conn.execute(
            "INSERT OR IGNORE INTO vorgang_links (predecessor_id, successor_id) VALUES (?1, ?2)",
            params![predecessor_id, successor_id],
        )?;
        Ok(())
    }

    pub fn set_remaining_hours(&self, vorgang_id: i64, remaining: Option<f64>) -> Result<()> {
        let n = self
            .conn
            .execute("UPDATE vorgaenge SET remaining_hours = ?2 WHERE id = ?1", params![vorgang_id, remaining])?;
        if n == 0 {
            return Err(Error::not_found("vorgang", vorgang_id.to_string()));
        }
        Ok(())
    }

    pub fn list_vorgaenge(&self, netzplan_id: i64) -> Result<Vec<Vorgang>> {
        let mut st = self.conn.prepare_cached(
            "SELECT id, netzplan_id, vorgang_nr, description, duration_days, planned_hours, remaining_hours
             FROM vorgaenge WHERE netzplan_id = ?1 ORDER BY vorgang_nr",
        )?;
        let mut rows: Vec<Vorgang> = st
            .query_map([netzplan_id], |r| {
                Ok(Vorgang {
                    id: r.get(0)?,
                    netzplan_id: r.get(1)?,
                    vorgang_nr: r.get(2)?,
                    description: r.get(3)?,
                    duration_days: r.get(4)?,
                    planned_hours: r.get(5)?,
                    remaining_hours: r.get(6)?,
                    predecessors: vec![],
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let mut links = self.conn.prepare_cached(
            "SELECT l.successor_id, l.predecessor_id FROM vorgang_links l
             JOIN vorgaenge v ON v.id = l.successor_id WHERE v.netzplan_id = ?1
             ORDER BY l.predecessor_id",
        )?;
        for link in links.query_map([netzplan_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (succ, pred) = link?;
            if let Some(v) = rows.iter_mut().find(|v| v.id == succ) {
                v.predecessors.push(pred);
            }
        }
        Ok(rows)
    }

    pub fn update_project(&self, id: i64, name: &str) -> Result<()> {
        self.conn.execute("UPDATE projects SET name = ?2 WHERE id = ?1", params![id, name.trim()])?;
        Ok(())
    }

    /// Deletes a project with its Netzpläne. Refused while time entries reference them.
    pub fn delete_project(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM projects WHERE id = ?1", [id]).map_err(|e| booked_guard(e, "Projekt"))?;
        Ok(())
    }

    pub fn update_netzplan(&self, id: i64, wbs_element: &str, description: &str, planned_hours: f64) -> Result<()> {
        self.conn.execute(
            "UPDATE netzplaene SET wbs_element = ?2, description = ?3, planned_hours = ?4 WHERE id = ?1",
            params![id, wbs_element.trim(), description.trim(), planned_hours],
        )?;
        Ok(())
    }

    pub fn delete_netzplan(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM netzplaene WHERE id = ?1", [id]).map_err(|e| booked_guard(e, "Netzplan"))?;
        Ok(())
    }

    pub fn update_vorgang(
        &self,
        id: i64,
        description: &str,
        duration_days: f64,
        planned_hours: f64,
        remaining_hours: Option<f64>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE vorgaenge SET description = ?2, duration_days = ?3, planned_hours = ?4, remaining_hours = ?5 WHERE id = ?1",
            params![id, description.trim(), duration_days, planned_hours, remaining_hours],
        )?;
        Ok(())
    }

    pub fn delete_vorgang(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM vorgaenge WHERE id = ?1", [id])?;
        Ok(())
    }

    pub fn list_leistungsarten(&self) -> Result<Vec<(String, String)>> {
        let mut st = self.conn.prepare_cached("SELECT code, description FROM leistungsarten ORDER BY code")?;
        let rows = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    pub fn upsert_leistungsart(&self, code: &str, description: &str) -> Result<()> {
        let code = code.trim().to_uppercase();
        if code.is_empty() || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return Err(Error::State("Leistungsart: nur Buchstaben, Ziffern und _".into()));
        }
        self.conn.execute(
            "INSERT INTO leistungsarten (code, description) VALUES (?1, ?2)
             ON CONFLICT(code) DO UPDATE SET description = excluded.description",
            params![code, description.trim()],
        )?;
        Ok(())
    }

    pub fn delete_leistungsart(&self, code: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM leistungsarten WHERE code = ?1", [code])
            .map_err(|e| booked_guard(e, "Leistungsart"))?;
        Ok(())
    }

    pub fn leistungsart_exists(&self, code: &str) -> Result<bool> {
        Ok(self
            .conn
            .query_row("SELECT 1 FROM leistungsarten WHERE code = ?1", [code], |_| Ok(()))
            .optional()?
            .is_some())
    }

    // ----------------------------------------------------------- time entries

    const ENTRY_COLS: &'static str = "e.id, e.netzplan_id, e.vorgang_nr, e.leistungsart, e.start_time, e.end_time,
         e.duration_minutes, e.description, e.status_flag, e.source, e.page_id";

    fn map_entry(r: &Row) -> rusqlite::Result<TimeEntry> {
        let status: String = r.get(8)?;
        let source: String = r.get(9)?;
        Ok(TimeEntry {
            id: r.get(0)?,
            netzplan_id: r.get(1)?,
            vorgang_nr: r.get(2)?,
            leistungsart: r.get(3)?,
            start_time: parse_ts(&r.get::<_, String>(4)?)?,
            end_time: r.get::<_, Option<String>>(5)?.as_deref().map(parse_ts).transpose()?,
            duration_minutes: r.get(6)?,
            description: r.get(7)?,
            // The CHECK constraints guarantee these parse.
            status_flag: StatusFlag::parse(&status).unwrap_or(StatusFlag::Draft),
            source: EntrySource::parse(&source).unwrap_or(EntrySource::Manual),
            page_id: r.get(10)?,
        })
    }

    pub fn time_entry(&self, id: i64) -> Result<TimeEntry> {
        self.conn
            .query_row(
                &format!("SELECT {} FROM time_entries e WHERE e.id = ?1", Self::ENTRY_COLS),
                [id],
                Self::map_entry,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("time entry", id.to_string()))
    }

    pub fn insert_time_entry(&self, e: &NewTimeEntry) -> Result<TimeEntry> {
        if e.duration_minutes < 0 {
            return Err(Error::State("Die Dauer darf nicht negativ sein".into()));
        }
        let end = e.start_time + chrono::Duration::minutes(e.duration_minutes);
        self.conn.execute(
            "INSERT INTO time_entries
               (netzplan_id, vorgang_nr, leistungsart, start_time, end_time, duration_minutes, description, status_flag, source, page_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'draft', ?8, ?9)",
            params![
                e.netzplan_id,
                e.vorgang_nr,
                e.leistungsart,
                ts(e.start_time),
                ts(end),
                e.duration_minutes,
                e.description,
                e.source.as_str(),
                e.page_id
            ],
        )?;
        let entry = self.time_entry(self.conn.last_insert_rowid())?;
        self.feed_entry("entry_created", &entry, Utc::now())?;
        Ok(entry)
    }

    /// The most recently started entry that is not running (for „Zuletzt verwendet starten“).
    pub fn last_finished_entry(&self) -> Result<Option<TimeEntry>> {
        Ok(self
            .conn
            .query_row(
                &format!(
                    "SELECT {} FROM time_entries e WHERE e.status_flag <> 'running' ORDER BY e.start_time DESC, e.id DESC LIMIT 1",
                    Self::ENTRY_COLS
                ),
                [],
                Self::map_entry,
            )
            .optional()?)
    }

    pub fn running_timer(&self) -> Result<Option<TimeEntry>> {
        Ok(self
            .conn
            .query_row(
                &format!("SELECT {} FROM time_entries e WHERE e.status_flag = 'running'", Self::ENTRY_COLS),
                [],
                Self::map_entry,
            )
            .optional()?)
    }

    pub fn start_timer(
        &self,
        netzplan_id: i64,
        vorgang_nr: Option<&str>,
        leistungsart: Option<&str>,
        description: &str,
        at: DateTime<Utc>,
    ) -> Result<TimeEntry> {
        if let Some(t) = self.running_timer()? {
            return Err(Error::State(format!("Es läuft bereits ein Timer (Eintrag #{})", t.id)));
        }
        self.conn.execute(
            "INSERT INTO time_entries (netzplan_id, vorgang_nr, leistungsart, start_time, description, status_flag, source)
             VALUES (?1, ?2, ?3, ?4, ?5, 'running', 'timer')",
            params![netzplan_id, vorgang_nr, leistungsart, ts(at), description],
        )?;
        self.time_entry(self.conn.last_insert_rowid())
    }

    /// Stops the running timer. `idle_minutes` is subtracted from the booked
    /// duration (idle detection); the wall-clock end time is kept.
    pub fn stop_timer(&self, at: DateTime<Utc>, idle_minutes: i64) -> Result<TimeEntry> {
        let running = self.running_timer()?.ok_or_else(|| Error::State("Es läuft kein Timer".into()))?;
        if at < running.start_time {
            return Err(Error::State("Das Ende liegt vor dem Beginn".into()));
        }
        let minutes = ((at - running.start_time).num_seconds() as f64 / 60.0).round() as i64;
        // Rounding (Settings → Zeiterfassung) applies to what is booked; nothing booked stays nothing.
        let rounding = self.load_settings().map(|s| s.time.rounding).unwrap_or_default();
        let booked = rounding.apply((minutes - idle_minutes.max(0)).max(0));
        self.conn.execute(
            "UPDATE time_entries SET end_time = ?2, duration_minutes = ?3, status_flag = 'draft' WHERE id = ?1",
            params![running.id, ts(at), booked],
        )?;
        let entry = self.time_entry(running.id)?;
        if booked > 0 {
            self.feed_entry("entry_created", &entry, at)?;
        }
        Ok(entry)
    }

    pub fn discard_timer(&self) -> Result<()> {
        self.conn.execute("DELETE FROM time_entries WHERE status_flag = 'running'", [])?;
        Ok(())
    }

    /// Edits a finished time entry. Exported entries are locked.
    pub fn update_time_entry(
        &self,
        id: i64,
        vorgang_nr: Option<&str>,
        leistungsart: Option<&str>,
        start_time: DateTime<Utc>,
        duration_minutes: i64,
        description: &str,
    ) -> Result<TimeEntry> {
        let e = self.time_entry(id)?;
        match e.status_flag {
            StatusFlag::Running => {
                return Err(Error::State("Der Eintrag läuft noch – zuerst den Timer stoppen".into()));
            }
            StatusFlag::Exported => {
                return Err(Error::State("Exportierte Einträge können nicht geändert werden".into()));
            }
            _ => {}
        }
        // A timer that ran over night may have booked more than a day: other fields of such an
        // entry can still be edited, and its duration corrected.
        let unchanged = e.duration_minutes == Some(duration_minutes);
        if !unchanged && !(1..=24 * 60).contains(&duration_minutes) {
            return Err(Error::State(
                "Die Dauer muss zwischen 1 Minute und 24 Stunden liegen (längere Zeiten auf mehrere Tage verteilen)"
                    .into(),
            ));
        }
        let end = start_time + chrono::Duration::minutes(duration_minutes);
        self.conn.execute(
            "UPDATE time_entries SET vorgang_nr = ?2, leistungsart = ?3, start_time = ?4, end_time = ?5,
                    duration_minutes = ?6, description = ?7 WHERE id = ?1",
            params![id, vorgang_nr, leistungsart, ts(start_time), ts(end), duration_minutes, description],
        )?;
        let entry = self.time_entry(id)?;
        self.feed_entry("entry_changed", &entry, Utc::now())?;
        Ok(entry)
    }

    /// Deletes a booking. An exported one is already in the time system and stays; a running
    /// one is stopped (or discarded) first.
    pub fn delete_time_entry(&self, id: i64) -> Result<()> {
        let status: Option<String> =
            self.conn.query_row("SELECT status_flag FROM time_entries WHERE id = ?1", [id], |r| r.get(0)).optional()?;
        match status.as_deref() {
            Some("exported") => Err(Error::State(
                "Exportierte Einträge können nicht gelöscht werden – sie sind bereits im Zeiterfassungssystem".into(),
            )),
            Some("running") => Err(Error::State("Der Eintrag läuft noch – zuerst den Timer stoppen".into())),
            _ => {
                self.conn.execute("DELETE FROM time_entries WHERE id = ?1", [id])?;
                Ok(())
            }
        }
    }

    pub fn set_entry_status(&self, ids: &[i64], status: StatusFlag) -> Result<usize> {
        if status == StatusFlag::Running {
            return Err(Error::State("Einträge können nicht auf „läuft“ gesetzt werden".into()));
        }
        self.atomic(|| {
            let mut n = 0;
            let mut st = self.conn.prepare_cached(
                "UPDATE time_entries SET status_flag = ?2 WHERE id = ?1 AND status_flag <> 'running'",
            )?;
            let mut changed = Vec::new();
            for id in ids {
                if st.execute(params![id, status.as_str()])? > 0 {
                    changed.push(*id);
                    n += 1;
                }
            }
            self.feed_status(&changed, status, Utc::now())?;
            Ok(n)
        })
    }

    pub fn list_time_entries(&self, f: &EntryFilter) -> Result<Vec<TimeEntryRow>> {
        // Only the filters that are set go into the query, so SQLite can use the index on
        // start_time (`?1 IS NULL OR …` hides it from the planner).
        let mut conds: Vec<&str> = vec![];
        let mut args: Vec<rusqlite::types::Value> = vec![];
        if let Some(from) = f.from {
            conds.push("e.start_time >= ?");
            args.push(ts(from).into());
        }
        if let Some(to) = f.to {
            conds.push("e.start_time < ?");
            args.push(ts(to).into());
        }
        if let Some(np) = f.netzplan_id {
            conds.push("e.netzplan_id = ?");
            args.push(np.into());
        }
        if let Some(status) = f.status {
            conds.push("e.status_flag = ?");
            args.push(status.as_str().to_owned().into());
        }
        let filter = if conds.is_empty() { String::new() } else { format!("WHERE {}", conds.join(" AND ")) };
        let mut st = self.conn.prepare_cached(&format!(
            "SELECT {}, p.project_code, n.netzplan_nr, n.wbs_element
             FROM time_entries e
             JOIN netzplaene n ON n.id = e.netzplan_id
             JOIN projects p ON p.id = n.project_id
             {filter}
             ORDER BY e.start_time, e.id",
            Self::ENTRY_COLS
        ))?;
        let rows = st
            .query_map(rusqlite::params_from_iter(args), |r| {
                Ok(TimeEntryRow {
                    entry: Self::map_entry(r)?,
                    project_code: r.get(11)?,
                    netzplan_nr: r.get(12)?,
                    wbs_element: r.get(13)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Booked hours (finished entries only) on a Netzplan, optionally for one Vorgang.
    pub fn booked_hours(&self, netzplan_id: i64, vorgang_nr: Option<&str>) -> Result<f64> {
        let minutes: i64 = match vorgang_nr {
            Some(v) => self.conn.query_row(
                "SELECT COALESCE(SUM(duration_minutes), 0) FROM time_entries
                 WHERE netzplan_id = ?1 AND status_flag <> 'running' AND vorgang_nr = ?2 COLLATE NOCASE",
                params![netzplan_id, v],
                |r| r.get(0),
            )?,
            None => self.conn.query_row(
                "SELECT COALESCE(SUM(duration_minutes), 0) FROM time_entries
                 WHERE netzplan_id = ?1 AND status_flag <> 'running'",
                [netzplan_id],
                |r| r.get(0),
            )?,
        };
        Ok(minutes as f64 / 60.0)
    }

    /// Booked minutes (finished entries only) of every Netzplan in one grouped query: the
    /// total and per Vorgang number (keys in ASCII lower case, matching like `COLLATE NOCASE`).
    pub fn booked_minutes_all(&self) -> Result<HashMap<i64, BookedMinutes>> {
        let mut st = self.conn.prepare_cached(
            "SELECT netzplan_id, vorgang_nr, SUM(duration_minutes) FROM time_entries
             WHERE status_flag <> 'running' GROUP BY netzplan_id, vorgang_nr",
        )?;
        let mut out: HashMap<i64, BookedMinutes> = HashMap::new();
        for row in st.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0)))
        })? {
            let (np, vorgang, minutes) = row?;
            let b = out.entry(np).or_default();
            b.total += minutes;
            if let Some(v) = vorgang {
                *b.by_vorgang.entry(v.to_ascii_lowercase()).or_default() += minutes;
            }
        }
        Ok(out)
    }

    /// All Vorgänge by Netzplan (each list like [`Database::list_vorgaenge`]), in two queries.
    pub fn vorgaenge_by_netzplan(&self) -> Result<HashMap<i64, Vec<Vorgang>>> {
        let mut st = self.conn.prepare_cached(
            "SELECT id, netzplan_id, vorgang_nr, description, duration_days, planned_hours, remaining_hours
             FROM vorgaenge ORDER BY netzplan_id, vorgang_nr",
        )?;
        let mut out: HashMap<i64, Vec<Vorgang>> = HashMap::new();
        let mut at: HashMap<i64, (i64, usize)> = HashMap::new();
        for v in st.query_map([], |r| {
            Ok(Vorgang {
                id: r.get(0)?,
                netzplan_id: r.get(1)?,
                vorgang_nr: r.get(2)?,
                description: r.get(3)?,
                duration_days: r.get(4)?,
                planned_hours: r.get(5)?,
                remaining_hours: r.get(6)?,
                predecessors: vec![],
            })
        })? {
            let v = v?;
            let list = out.entry(v.netzplan_id).or_default();
            at.insert(v.id, (v.netzplan_id, list.len()));
            list.push(v);
        }
        let mut links = self
            .conn
            .prepare_cached("SELECT successor_id, predecessor_id FROM vorgang_links ORDER BY predecessor_id")?;
        for link in links.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            let (succ, pred) = link?;
            if let Some((np, i)) = at.get(&succ)
                && let Some(v) = out.get_mut(np).and_then(|l| l.get_mut(*i))
            {
                v.predecessors.push(pred);
            }
        }
        Ok(out)
    }

    /// The latest finished entries on a Netzplan (optionally one Vorgang), newest first.
    pub fn recent_entries(&self, netzplan_id: i64, vorgang_nr: Option<&str>, limit: usize) -> Result<Vec<TimeEntry>> {
        let mut st = self.conn.prepare_cached(&format!(
            "SELECT {} FROM time_entries e
             WHERE e.netzplan_id = ?1 AND e.status_flag <> 'running' AND (?2 IS NULL OR e.vorgang_nr = ?2 COLLATE NOCASE)
             ORDER BY e.start_time DESC, e.id DESC LIMIT ?3",
            Self::ENTRY_COLS
        ))?;
        let rows = st
            .query_map(params![netzplan_id, vorgang_nr, limit as i64], Self::map_entry)?
            .collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// Hours booked from one page (`/zeit` in that note).
    pub fn page_booked_hours(&self, page_id: i64) -> Result<f64> {
        let minutes: i64 = self.conn.query_row(
            "SELECT COALESCE(SUM(duration_minutes), 0) FROM time_entries WHERE page_id = ?1 AND status_flag <> 'running'",
            [page_id],
            |r| r.get(0),
        )?;
        Ok(minutes as f64 / 60.0)
    }

    // ------------------------------------------------------------------ pages

    pub fn create_page(&self, parent_id: Option<i64>, title: &str, icon: Option<&str>) -> Result<Page> {
        let title = crate::notes::clean_title(title);
        if title.is_empty() {
            return Err(Error::State("Der Titel darf nicht leer sein".into()));
        }
        if let Some(p) = parent_id
            && self.page(p)?.deleted_at.is_some()
        {
            return Err(Error::State("Die übergeordnete Seite liegt im Papierkorb".into()));
        }
        let position: i64 = self.conn.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM pages WHERE parent_id IS ?1 AND deleted_at IS NULL",
            [parent_id],
            |r| r.get(0),
        )?;
        self.conn.execute(
            "INSERT INTO pages (parent_id, title, icon, position) VALUES (?1, ?2, ?3, ?4)",
            params![parent_id, title, icon, position],
        )?;
        let page = self.page(self.conn.last_insert_rowid())?;
        self.feed_page_created(page.id, &page.title, Utc::now())?;
        Ok(page)
    }

    pub fn rename_page(&self, id: i64, title: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE pages SET title = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?1",
            params![id, crate::notes::clean_title(title)],
        )?;
        Ok(())
    }

    /// Deletes a page and its subtree permanently, bypassing the trash
    /// (the UI uses [`Database::trash_page`]).
    pub fn delete_page(&self, id: i64) -> Result<()> {
        self.conn.execute("DELETE FROM pages WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Pages outside the trash.
    pub fn list_pages(&self) -> Result<Vec<Page>> {
        let mut st = self
            .conn
            .prepare_cached(&format!("SELECT {PAGE_COLS} FROM pages WHERE deleted_at IS NULL ORDER BY position, id"))?;
        let rows = st.query_map([], map_page)?.collect::<rusqlite::Result<_>>()?;
        Ok(rows)
    }

    /// The whole page hierarchy, for the sidebar. Linear in the number of pages: the rows are
    /// grouped by parent once, then moved (not cloned) into their nodes.
    pub fn page_tree(&self) -> Result<Vec<PageNode>> {
        let pages = self.list_pages()?;
        let ids: std::collections::HashSet<i64> = pages.iter().map(|p| p.id).collect();
        // Siblings keep the query order (position, id). A parent outside the list cannot occur
        // for live pages (trashing takes the subtree along); such rows are left out, as before.
        let mut children: HashMap<Option<i64>, Vec<Page>> = HashMap::new();
        for p in pages {
            let parent = p.parent_id.filter(|id| ids.contains(id));
            if p.parent_id.is_some() && parent.is_none() {
                continue;
            }
            children.entry(parent).or_default().push(p);
        }
        fn build(parent: Option<i64>, children: &mut HashMap<Option<i64>, Vec<Page>>) -> Vec<PageNode> {
            let Some(pages) = children.remove(&parent) else { return vec![] };
            pages
                .into_iter()
                .map(|p| {
                    let kids = build(Some(p.id), children);
                    PageNode { page: p, children: kids }
                })
                .collect()
        }
        Ok(build(None, &mut children))
    }

    // --------------------------------------------------------------- ai usage

    pub fn record_ai_usage(&self, session_id: &str, u: &crate::ai::metrics::UsageRecord) -> Result<()> {
        self.conn.execute(
            "INSERT INTO ai_usage (session_id, model, prompt_tokens, completion_tokens, cost_usd, ttft_ms, tokens_per_second)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                session_id,
                u.model,
                u.prompt_tokens as i64,
                u.completion_tokens as i64,
                u.cost_usd,
                u.ttft_ms,
                u.tokens_per_second
            ],
        )?;
        Ok(())
    }

    /// Cost in USD of all AI requests since `from` (the monthly cost limit).
    pub fn ai_cost_since(&self, from: DateTime<Utc>) -> Result<f64> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(SUM(cost_usd), 0) FROM ai_usage WHERE created_at >= ?1",
            [from.format("%Y-%m-%dT%H:%M:%SZ").to_string()],
            |r| r.get(0),
        )?)
    }

    /// (prompt tokens, completion tokens, cost in USD) for one AI session.
    pub fn ai_session_totals(&self, session_id: &str) -> Result<(u64, u64, f64)> {
        Ok(self.conn.query_row(
            "SELECT COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0), COALESCE(SUM(cost_usd), 0)
             FROM ai_usage WHERE session_id = ?1",
            [session_id],
            |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64, r.get(2)?)),
        )?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    pub(crate) fn seeded() -> (Database, Netzplan) {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ-2026-X", "Annalo Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Systemintegration", 40.0).unwrap();
        (db, np)
    }

    #[test]
    fn pending_reindex_survives_a_crash() {
        let path = std::env::temp_dir().join(format!("annalo-reindex-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let db = Database::open(&path).unwrap();
            assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len());
            assert!(db.meta_get(NEEDS_REINDEX).unwrap().is_none(), "cleared after the first open");
            let p = db.create_page(None, "Liste", None).unwrap();
            db.save_page_content(p.id, "- [ ] offen\n").unwrap();
            // As if the app died after the marker migration committed, before the re-index ran.
            db.conn().execute("DELETE FROM tasks", []).unwrap();
            db.meta_set(NEEDS_REINDEX, "1").unwrap();
        }
        let db = Database::open(&path).unwrap();
        let tasks = db.list_tasks(&Default::default()).unwrap();
        assert_eq!(tasks.iter().map(|t| t.text.as_str()).collect::<Vec<_>>(), ["offen"]);
        assert!(db.meta_get(NEEDS_REINDEX).unwrap().is_none());
        drop(db);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }

    #[test]
    fn migrates_and_resolves_references() {
        let (db, np) = seeded();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len());
        assert_eq!(db.netzplan_by_ref("np-8801").unwrap().id, np.id);
        assert_eq!(db.netzplan_by_ref("NP-8801-1020").unwrap().id, np.id);
        assert!(matches!(db.netzplan_by_ref("NP-0000"), Err(Error::NotFound { .. })));
    }

    #[test]
    fn timer_lifecycle_subtracts_idle_time() {
        let (db, np) = seeded();
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        db.start_timer(np.id, Some("1020"), Some("DEV"), "Integration", t0).unwrap();
        assert!(db.start_timer(np.id, None, None, "", t0).is_err(), "only one timer may run");
        let e = db.stop_timer(t0 + chrono::Duration::minutes(95), 5).unwrap();
        assert_eq!(e.duration_minutes, Some(90));
        assert_eq!(e.status_flag, StatusFlag::Draft);
        assert!(db.running_timer().unwrap().is_none());
        assert!((db.booked_hours(np.id, Some("1020")).unwrap() - 1.5).abs() < 1e-9);
    }

    #[test]
    fn a_failed_commit_leaves_no_open_transaction() {
        let path = std::env::temp_dir().join(format!("annalo-commitfail-{}.db", std::process::id()));
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
        let (keep, lost) = {
            let db = Database::open(&path).unwrap();
            let p = db.create_page(None, "Seite", None).unwrap();
            // A foreign key checked only at commit: the commit (RELEASE) itself fails.
            db.conn().execute_batch("PRAGMA defer_foreign_keys = ON").unwrap();
            let err = db.atomic(|| {
                db.save_page_content(p.id, "verloren")?;
                db.conn().execute("INSERT INTO page_links (from_page, target) VALUES (999999, 'x')", [])?;
                Ok(())
            });
            assert!(err.is_err());
            assert!(db.conn().is_autocommit(), "transaction rolled back, not left open");
            // Later saves are committed for real.
            db.save_page_content(p.id, "gespeichert").unwrap();
            let q = db.create_page(None, "Neu", None).unwrap();

            // Disk full: the database may not grow any further.
            let pages: i64 = db.conn().pragma_query_value(None, "page_count", |r| r.get(0)).unwrap();
            db.conn().execute_batch(&format!("PRAGMA max_page_count = {pages}")).unwrap();
            let big = "x".repeat(200_000);
            assert!(db.atomic(|| db.save_page_content(q.id, &big)).is_err());
            assert!(db.conn().is_autocommit());
            db.conn().execute_batch("PRAGMA max_page_count = 1073741823").unwrap();
            db.rename_page(q.id, "Neu umbenannt").unwrap();
            (p.id, q.id)
        };
        let db = Database::open(&path).unwrap();
        assert_eq!(db.page_doc(keep).unwrap().content, "gespeichert");
        assert_eq!(db.page(lost).unwrap().title, "Neu umbenannt");
        drop(db);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }

    #[test]
    fn an_overnight_timer_entry_can_still_be_edited() {
        let (db, np) = seeded();
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        db.start_timer(np.id, None, None, "vergessen", t0).unwrap();
        let e = db.stop_timer(t0 + chrono::Duration::hours(50), 0).unwrap();
        assert_eq!(e.duration_minutes, Some(3000));
        // Other fields change, the duration stays.
        let e = db.update_time_entry(e.id, None, None, t0, 3000, "über Nacht").unwrap();
        assert_eq!(e.description, "über Nacht");
        assert!(db.update_time_entry(e.id, None, None, t0, 2000, "x").is_err(), "still more than a day");
        assert_eq!(db.update_time_entry(e.id, None, None, t0, 480, "korrigiert").unwrap().duration_minutes, Some(480));
    }

    #[test]
    fn exported_and_running_entries_are_not_deleted() {
        let (db, np) = seeded();
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        let running = db.start_timer(np.id, None, None, "läuft", t0).unwrap();
        let err = db.delete_time_entry(running.id).unwrap_err().to_string();
        assert!(err.contains("zuerst den Timer stoppen"), "{err}");
        let done = db.stop_timer(t0 + chrono::Duration::minutes(30), 0).unwrap();
        db.set_entry_status(&[done.id], StatusFlag::Exported).unwrap();
        let err = db.delete_time_entry(done.id).unwrap_err().to_string();
        assert!(err.contains("Exportierte Einträge"), "{err}");
        assert!(db.time_entry(done.id).is_ok());
        db.set_entry_status(&[done.id], StatusFlag::Draft).unwrap();
        db.delete_time_entry(done.id).unwrap();
        assert!(db.time_entry(done.id).is_err());
    }

    #[test]
    fn v1_blocks_are_migrated_into_documents() {
        let path = std::env::temp_dir().join(format!("annalo-mig-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(MIGRATIONS[0]).unwrap();
            c.pragma_update(None, "user_version", 1i64).unwrap();
            c.execute("INSERT INTO pages (id, title) VALUES (1, 'Alt')", []).unwrap();
            c.execute("INSERT INTO pages (id, title) VALUES (2, 'Ziel')", []).unwrap();
            c.execute(
                "INSERT INTO notes_blocks (page_id, position, content_markdown) VALUES (1, 1, 'zweiter Absatz [[Ziel]]'), (1, 0, '# Kopf')",
                [],
            )
            .unwrap();
        }
        let db = Database::open(&path).unwrap();
        assert_eq!(db.schema_version().unwrap(), MIGRATIONS.len());
        assert_eq!(db.page_doc(1).unwrap().content, "# Kopf\n\nzweiter Absatz [[Ziel]]");
        assert_eq!(db.page_doc(2).unwrap().backlinks.len(), 1);
        assert!(!crate::search::search(&db, "Absatz", 5).unwrap().is_empty());
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn reindex_migrations_index_existing_pages() {
        let path = std::env::temp_dir().join(format!("annalo-mig-tasks-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let before = MIGRATIONS.iter().position(|m| m.contains(REINDEX_MARKER)).unwrap();
        {
            let c = Connection::open(&path).unwrap();
            for m in &MIGRATIONS[..before] {
                c.execute_batch(m).unwrap();
            }
            c.pragma_update(None, "user_version", before as i64).unwrap();
            c.execute("INSERT INTO pages (id, title, content) VALUES (1, 'Alt', '- [ ] offen due:2026-10-01')", [])
                .unwrap();
        }
        let db = Database::open(&path).unwrap();
        let tasks = db.list_tasks(&crate::tasks::TaskFilter::default()).unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].due.as_deref(), Some("2026-10-01"));
        drop(db);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn deleting_booked_wbs_is_refused_and_entries_are_editable() {
        let (db, np) = seeded();
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        let e = db
            .insert_time_entry(&NewTimeEntry {
                netzplan_id: np.id,
                vorgang_nr: None,
                leistungsart: Some("DEV".into()),
                start_time: t0,
                duration_minutes: 60,
                description: "x".into(),
                source: EntrySource::Manual,
                page_id: None,
            })
            .unwrap();
        assert!(db.delete_netzplan(np.id).unwrap_err().to_string().contains("gebuchte Zeiten"));
        assert!(db.delete_leistungsart("DEV").is_err());
        let e2 = db.update_time_entry(e.id, Some("1020"), Some("PM"), t0, 90, "y").unwrap();
        assert_eq!((e2.duration_minutes, e2.vorgang_nr.as_deref()), (Some(90), Some("1020")));
        db.set_entry_status(&[e.id], StatusFlag::Exported).unwrap();
        assert!(db.update_time_entry(e.id, None, None, t0, 30, "z").is_err());
    }

    #[test]
    fn page_tree_nests_children() {
        let db = Database::open_in_memory().unwrap();
        let root = db.create_page(None, "Workspace", None).unwrap();
        let child = db.create_page(Some(root.id), "Meeting Notes", None).unwrap();
        db.create_page(Some(child.id), "2026-09-23", None).unwrap();
        let tree = db.page_tree().unwrap();
        assert_eq!(tree.len(), 1);
        assert_eq!(tree[0].children[0].children[0].page.title, "2026-09-23");
    }

    #[test]
    fn page_tree_is_linear_for_large_workspaces() {
        let db = Database::open_in_memory().unwrap();
        // 50 folders with 99 pages each (5,000 pages), inserted directly to keep setup fast.
        db.atomic(|| {
            for f in 0..50i64 {
                db.conn.execute(
                    "INSERT INTO pages (title, position) VALUES (?1, ?2)",
                    params![format!("Ordner {f}"), f],
                )?;
                let parent = db.conn.last_insert_rowid();
                for i in 0..99i64 {
                    db.conn.execute(
                        "INSERT INTO pages (parent_id, title, position) VALUES (?1, ?2, ?3)",
                        params![parent, format!("Seite {f}-{i}"), i],
                    )?;
                }
            }
            Ok(())
        })
        .unwrap();
        let t = std::time::Instant::now();
        let tree = db.page_tree().unwrap();
        let took = t.elapsed();
        assert_eq!(tree.len(), 50);
        assert_eq!(tree.iter().map(|n| n.children.len()).sum::<usize>(), 4950);
        assert_eq!(tree[3].children[7].page.title, "Seite 3-7", "siblings keep their order");
        // The old filter-per-parent build took seconds here in debug builds.
        assert!(took < std::time::Duration::from_millis(200), "page_tree took {took:?}");
    }

    #[test]
    fn entry_filters_match_filtering_all_entries() {
        let (db, np) = seeded();
        let p = db.project_by_code("PRJ-2026-X").unwrap();
        let other = db.create_netzplan(p.id, "NP-8802", "NP-8802-1", "Zweiter", 10.0).unwrap();
        let t0 = Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap();
        for i in 0..12i64 {
            let e = db
                .insert_time_entry(&NewTimeEntry {
                    netzplan_id: if i % 3 == 0 { other.id } else { np.id },
                    vorgang_nr: None,
                    leistungsart: None,
                    start_time: t0 + chrono::Duration::days(i),
                    duration_minutes: 30,
                    description: format!("e{i}"),
                    source: EntrySource::Manual,
                    page_id: None,
                })
                .unwrap();
            if i % 2 == 0 {
                db.set_entry_status(&[e.id], StatusFlag::Released).unwrap();
            }
        }
        let all = db.list_time_entries(&EntryFilter::default()).unwrap();
        assert_eq!(all.len(), 12);
        let from = Some(t0 + chrono::Duration::days(3));
        let to = Some(t0 + chrono::Duration::days(9));
        for from in [None, from] {
            for to in [None, to] {
                for netzplan_id in [None, Some(np.id)] {
                    for status in [None, Some(StatusFlag::Released)] {
                        let f = EntryFilter { from, to, netzplan_id, status };
                        let want: Vec<i64> = all
                            .iter()
                            .filter(|r| from.is_none_or(|t| r.entry.start_time >= t))
                            .filter(|r| to.is_none_or(|t| r.entry.start_time < t))
                            .filter(|r| netzplan_id.is_none_or(|n| r.entry.netzplan_id == n))
                            .filter(|r| status.is_none_or(|s| r.entry.status_flag == s))
                            .map(|r| r.entry.id)
                            .collect();
                        let got: Vec<i64> = db.list_time_entries(&f).unwrap().iter().map(|r| r.entry.id).collect();
                        assert_eq!(got, want, "{f:?}");
                    }
                }
            }
        }
        assert_eq!(db.list_netzplaene(None).unwrap().len(), 2);
        assert_eq!(db.list_netzplaene(Some(p.id)).unwrap().len(), 2);
        assert!(db.list_netzplaene(Some(p.id + 1)).unwrap().is_empty());
    }

    #[test]
    fn vorgaenge_of_all_netzplaene_match_one_by_one() {
        let (db, np) = seeded();
        let p = db.project_by_code("PRJ-2026-X").unwrap();
        let other = db.create_netzplan(p.id, "NP-8802", "NP-8802-1", "Zweiter", 10.0).unwrap();
        let a = db.create_vorgang(np.id, "1020", "B", 1.0, 2.0).unwrap();
        let b = db.create_vorgang(np.id, "1010", "A", 1.0, 2.0).unwrap();
        let c = db.create_vorgang(np.id, "1030", "C", 1.0, 2.0).unwrap();
        db.create_vorgang(other.id, "9", "X", 1.0, 2.0).unwrap();
        db.link_vorgaenge(b.id, c.id).unwrap();
        db.link_vorgaenge(a.id, c.id).unwrap();
        let all = db.vorgaenge_by_netzplan().unwrap();
        for n in [np.id, other.id] {
            assert_eq!(all[&n], db.list_vorgaenge(n).unwrap());
        }
        assert_eq!(all[&np.id][2].predecessors, [a.id, b.id]);
    }

    #[test]
    fn a_read_only_connection_sees_commits_and_cannot_write() {
        let path = std::env::temp_dir().join(format!("annalo-reader-{}.db", std::process::id()));
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
        let db = Database::open(&path).unwrap();
        let reader = Database::open_read_only(&path).unwrap();
        let p = db.create_page(None, "Neu", None).unwrap();
        db.save_page_content(p.id, "gespeichert").unwrap();
        assert_eq!(reader.page_doc(p.id).unwrap().content, "gespeichert");
        assert!(reader.create_page(None, "Nicht", None).is_err());
        // One consistent state inside a snapshot, the newest one after it.
        reader
            .read_snapshot(|r| {
                assert_eq!(r.list_pages()?.len(), 1);
                db.create_page(None, "Später", None)?;
                assert_eq!(r.list_pages()?.len(), 1);
                Ok(())
            })
            .unwrap();
        assert_eq!(reader.list_pages().unwrap().len(), 2);
        // A backup through the read-only connection.
        let dir = std::env::temp_dir().join(format!("annalo-reader-bak-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let info = crate::backup::backup_to(&reader, &dir, 2).unwrap();
        assert_eq!(Database::open(&info.path).unwrap().list_pages().unwrap().len(), 2);
        drop((db, reader));
        let _ = std::fs::remove_dir_all(&dir);
        for ext in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", path.display()));
        }
    }

    #[test]
    fn cached_settings_follow_every_change() {
        let db = Database::open_in_memory().unwrap();
        let mut s = db.load_settings().unwrap();
        s.notes.max_versions = 7;
        db.save_settings(&s).unwrap();
        assert_eq!(db.load_settings().unwrap().notes.max_versions, 7);
        assert_eq!(db.load_settings().unwrap().notes.max_versions, 7, "from the cache");
        // Changed behind its back (another connection, a migration): read again.
        db.conn()
            .execute("UPDATE settings SET value = json_set(value, '$.notes.max_versions', 9) WHERE key = 'app'", [])
            .unwrap();
        assert_eq!(db.load_settings().unwrap().notes.max_versions, 9);
        // Unreadable settings are reported every time, not hidden by the cache.
        db.conn().execute("UPDATE settings SET value = '[1]' WHERE key = 'app'", []).unwrap();
        assert!(!db.load_settings_checked().unwrap().1.is_empty());
        assert!(!db.load_settings_checked().unwrap().1.is_empty());
    }
}
