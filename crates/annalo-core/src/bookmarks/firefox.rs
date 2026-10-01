//! Firefox: the profiles from `profiles.ini`, and the bookmarks in a profile's
//! `places.sqlite` (`moz_bookmarks` joined with `moz_places`). Firefox keeps the database open
//! (and locked) while it runs, so it is read from a copy, together with its write-ahead log
//! where the newest changes may still be.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};

use super::{Collector, MAX_DEPTH, Node, Tree};
use crate::{Error, Result};

/// A profile listed in `profiles.ini`.
#[derive(Debug, Clone, PartialEq)]
pub struct Profile {
    pub name: String,
    pub dir: PathBuf,
    /// The profile Firefox starts with.
    pub default: bool,
}

/// The profiles of `profiles.ini` in `base` (relative paths resolved against it).
pub fn profiles(base: &Path, ini: &str) -> Vec<Profile> {
    let mut sections: Vec<(String, HashMap<String, String>)> = Vec::new();
    for line in ini.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') || line.is_empty() {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            sections.push((name.to_owned(), HashMap::new()));
        } else if let (Some((k, v)), Some((_, map))) = (line.split_once('='), sections.last_mut()) {
            map.insert(k.trim().to_owned(), v.trim().to_owned());
        }
    }
    // Newer Firefox marks the default per installation ([Install…] Default=Profiles/x).
    let install_defaults: Vec<&str> = sections
        .iter()
        .filter(|(s, _)| s.starts_with("Install"))
        .filter_map(|(_, m)| m.get("Default").map(String::as_str))
        .collect();
    sections
        .iter()
        .filter(|(s, _)| s.starts_with("Profile"))
        .filter_map(|(_, m)| {
            let path = m.get("Path")?;
            let relative = m.get("IsRelative").is_none_or(|v| v == "1");
            let dir = if relative { base.join(path.replace('\\', "/")) } else { PathBuf::from(path) };
            let default = install_defaults.contains(&path.as_str())
                || (install_defaults.is_empty() && m.get("Default").is_some_and(|v| v == "1"));
            Some(Profile { name: m.get("Name").cloned().unwrap_or_else(|| path.clone()), dir, default })
        })
        .collect()
}

/// A copy of a file (and its `-wal` log) in a temp folder, removed again on drop.
struct TempCopy {
    dir: PathBuf,
    file: PathBuf,
}

impl Drop for TempCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn copy_for_reading(src: &Path) -> Result<TempCopy> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "annalo-bookmarks-{}-{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&dir).map_err(|e| Error::file(&dir, e))?;
    let copy = TempCopy { file: dir.join("places.sqlite"), dir };
    std::fs::copy(src, &copy.file).map_err(|e| locked_or(src, e))?;
    let wal = PathBuf::from(format!("{}-wal", src.display()));
    if wal.is_file() {
        std::fs::copy(&wal, copy.dir.join("places.sqlite-wal")).map_err(|e| locked_or(&wal, e))?;
    }
    Ok(copy)
}

/// The message for a file Firefox keeps locked (Windows: sharing violation), else the I/O error.
fn locked_or(path: &Path, e: std::io::Error) -> Error {
    // ERROR_SHARING_VIOLATION, ERROR_LOCK_VIOLATION
    if matches!(e.raw_os_error(), Some(32 | 33)) && cfg!(windows) {
        return Error::State(locked().into());
    }
    Error::file(path, e)
}

/// Shown when the database cannot be read because Firefox holds it.
pub fn locked() -> &'static str {
    crate::tr!(
        "Firefox hält die Lesezeichen gesperrt. Firefox schließen und erneut versuchen.",
        "Firefox keeps its bookmarks locked. Close Firefox and try again."
    )
}

/// Reads the bookmarks of `places` (a profile's `places.sqlite`) from a copy.
pub fn read(places: &Path) -> Result<Tree> {
    let copy = copy_for_reading(places)?;
    let conn =
        Connection::open_with_flags(&copy.file, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
    let tree = parse(&conn).map_err(|e| match e {
        Error::Db(rusqlite::Error::SqliteFailure(f, _))
            if matches!(f.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked) =>
        {
            Error::State(locked().into())
        }
        other => other,
    });
    drop(conn);
    tree
}

/// One row of `moz_bookmarks`.
struct Row {
    id: i64,
    kind: i64,
    title: String,
    added: Option<i64>,
    guid: String,
    url: Option<String>,
}

/// The top folders of Firefox by their fixed ids, in the order of its library window (named by
/// their role in the display language; the database only has internal names).
const ROOTS: [(&str, &str); 4] =
    [("toolbar_____", "bar"), ("menu________", "menu"), ("unfiled_____", "other"), ("mobile______", "mobile")];

/// The bookmark tree of an open `places.sqlite`.
pub fn parse(conn: &Connection) -> Result<Tree> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.type, b.parent, b.title, b.dateAdded, b.guid, p.url
         FROM moz_bookmarks b LEFT JOIN moz_places p ON b.fk = p.id
         ORDER BY b.parent, b.position",
    )?;
    let mut children: HashMap<i64, Vec<Row>> = HashMap::new();
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(2)?,
            Row {
                id: r.get(0)?,
                kind: r.get(1)?,
                title: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                // Microseconds since 1970.
                added: r.get::<_, Option<i64>>(4)?.map(|t| t / 1_000_000),
                guid: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                url: r.get(6)?,
            },
        ))
    })?;
    let mut by_guid: HashMap<String, i64> = HashMap::new();
    for row in rows {
        let (parent, row) = row?;
        by_guid.insert(row.guid.clone(), row.id);
        children.entry(parent).or_default().push(row);
    }
    let mut c = Collector::default();
    let mut roots = Vec::new();
    for (guid, role) in ROOTS {
        let Some(id) = by_guid.get(guid) else { continue };
        let mut f = Node::folder("", Some(role));
        f.children = build(&mut c, &children, *id, 0);
        roots.push(f);
    }
    Ok(c.finish(roots))
}

fn build(c: &mut Collector, children: &HashMap<i64, Vec<Row>>, parent: i64, depth: usize) -> Vec<Node> {
    if depth > MAX_DEPTH {
        return vec![];
    }
    let mut out = Vec::new();
    for row in children.get(&parent).into_iter().flatten() {
        match row.kind {
            // Bookmark (a `place:` query is skipped as a browser page).
            1 => out.extend(row.url.as_deref().and_then(|u| c.link(&row.title, u, row.added))),
            // Folder.
            2 => {
                let mut f = Node::folder(row.title.trim(), None);
                f.added = row.added;
                f.children = build(c, children, row.id, depth + 1);
                out.push(f);
            }
            // 3 = separator.
            _ => {}
        }
    }
    out
}

/// A `places.sqlite` with Firefox's tables and the given bookmarks, for tests (here and in the
/// app's): `(parent guid, guid, type, title, url)`, in position order.
#[doc(hidden)]
pub fn write_fixture(path: &Path, entries: &[(&str, &str, i64, &str, Option<&str>)]) -> Result<()> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR);
         CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER,
           position INTEGER, title LONGVARCHAR, dateAdded INTEGER, lastModified INTEGER, guid TEXT);
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (1, 2, 0, 0, '', 'root________');
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (2, 2, 1, 0, 'menu', 'menu________');
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (3, 2, 1, 1, 'toolbar', 'toolbar_____');
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (4, 2, 1, 2, 'tags', 'tags________');
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (5, 2, 1, 3, 'unfiled', 'unfiled_____');
         INSERT INTO moz_bookmarks (id, type, parent, position, title, guid) VALUES (6, 2, 1, 4, 'mobile', 'mobile______');",
    )?;
    let mut position: HashMap<String, i64> = HashMap::new();
    for (i, (parent, guid, kind, title, url)) in entries.iter().enumerate() {
        let parent_id: i64 = conn.query_row("SELECT id FROM moz_bookmarks WHERE guid = ?1", [parent], |r| r.get(0))?;
        let fk = match url {
            Some(u) => {
                conn.execute("INSERT INTO moz_places (url, title) VALUES (?1, ?2)", [u, title])?;
                Some(conn.last_insert_rowid())
            }
            None => None,
        };
        let pos = position.entry((*parent).to_owned()).or_insert(0);
        conn.execute(
            "INSERT INTO moz_bookmarks (type, fk, parent, position, title, dateAdded, guid) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![kind, fk, parent_id, *pos, title, 1_704_067_200_000_000i64 + i as i64 * 1_000_000, guid],
        )?;
        *pos += 1;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_ini_with_install_default() {
        let ini = "[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\nLocked=1\n\n[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/xyz.default\nDefault=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n[Profile2]\nName=Arbeit\nIsRelative=0\nPath=/srv/ff/arbeit\n\n[General]\nStartWithLastProfile=1\nVersion=2\n";
        let p = profiles(Path::new("/home/u/.mozilla/firefox"), ini);
        assert_eq!(p.len(), 3);
        assert_eq!(p[0].name, "default");
        assert!(!p[0].default, "the install default wins over Default=1");
        assert_eq!(p[1].dir, Path::new("/home/u/.mozilla/firefox/Profiles/abc.default-release"));
        assert!(p[1].default);
        assert_eq!(p[2].dir, Path::new("/srv/ff/arbeit"));
    }
}
