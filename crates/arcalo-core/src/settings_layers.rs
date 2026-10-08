//! Settings shared by every workspace on this computer, with per-workspace overrides.
//!
//! A workspace is a data folder ([`crate::datadir`]); its settings live in its database. A
//! few sections can instead be shared by every workspace on the computer: they are kept in
//! [`SHARED_FILE`] in the shared folder the shell sets at start ([`set_shared_dir`]: the app's
//! config folder, the folder next to `data/` in portable mode). Each workspace records per
//! section whether it uses the shared value or its own ([`Settings::workspace_scopes`]);
//! the effective value is the workspace's own when the section is „Nur dieser
//! Arbeitsbereich“, else the shared one.
//!
//! The workspace's database always holds the effective values, so everything that reads the
//! settings stays as it was: saving writes shared sections to the file as well
//! ([`store_shared`]), and the start takes over what another workspace changed meanwhile
//! ([`crate::db::Database::adopt_shared_settings`]).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Database;
use crate::error::Result;
use crate::settings::Settings;

/// Name of the shared file in the shared folder.
pub const SHARED_FILE: &str = "shared-settings.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// „Für alle Arbeitsbereiche“: the shared value.
    Global,
    /// „Nur dieser Arbeitsbereich“: the workspace's own value.
    Workspace,
}

/// A section that can be shared: its id (as in the settings menu) and the top-level keys of
/// [`Settings`] it covers.
pub struct Section {
    pub id: &'static str,
    pub keys: &'static [&'static str],
    /// Scope of a workspace that has not decided. The start page and the filing rules refer
    /// to pages of the workspace, so they stay with it unless shared on purpose.
    pub default: Scope,
}

pub const SECTIONS: [Section; 5] = [
    Section { id: "appearance", keys: &["theme", "appearance"], default: Scope::Global },
    Section {
        id: "ai",
        keys: &[
            "providers",
            "router",
            "auto_route",
            "embedding_model",
            "embedding_provider",
            "litellm_base_url",
            "prices",
        ],
        default: Scope::Global,
    },
    Section { id: "filing", keys: &["filing"], default: Scope::Workspace },
    Section { id: "jira", keys: &["jira"], default: Scope::Global },
    Section { id: "dashboard", keys: &["dashboard"], default: Scope::Workspace },
];

pub fn section(id: &str) -> Option<&'static Section> {
    SECTIONS.iter().find(|s| s.id == id)
}

/// The scope of section `id` in `s` (its decision, else the section's default).
pub fn scope_of(s: &Settings, id: &str) -> Scope {
    s.workspace_scopes.get(id).copied().or_else(|| section(id).map(|x| x.default)).unwrap_or(Scope::Workspace)
}

/// Every section's effective scope, for the settings page.
pub fn scopes(s: &Settings) -> BTreeMap<String, Scope> {
    SECTIONS.iter().map(|x| (x.id.to_owned(), scope_of(s, x.id))).collect()
}

/// Contents of [`SHARED_FILE`]: per section the values of its keys, and when they were written.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SharedFile {
    pub format: u32,
    pub sections: BTreeMap<String, BTreeMap<String, Value>>,
    /// Milliseconds since the epoch, per section.
    pub updated: BTreeMap<String, i64>,
}

static SHARED_DIR: RwLock<Option<PathBuf>> = RwLock::new(None);

/// Sets the shared folder (the shell, at start). `None`: nothing is shared (tests, tools).
pub fn set_shared_dir(dir: Option<PathBuf>) {
    *SHARED_DIR.write().unwrap_or_else(|e| e.into_inner()) = dir;
}

pub fn shared_dir() -> Option<PathBuf> {
    SHARED_DIR.read().unwrap_or_else(|e| e.into_inner()).clone()
}

/// The shared file in `dir`; missing or unreadable reads as empty.
pub fn read_shared(dir: &Path) -> SharedFile {
    std::fs::read_to_string(dir.join(SHARED_FILE)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

/// Writes the shared file via a temporary file (a crash never leaves half a file).
pub fn write_shared(dir: &Path, f: &SharedFile) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!("{SHARED_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_vec_pretty(f)?)?;
    std::fs::rename(&tmp, dir.join(SHARED_FILE))?;
    Ok(())
}

/// The values of `section`'s keys in `s`.
fn values_of(s: &Settings, section: &Section) -> BTreeMap<String, Value> {
    let v = serde_json::to_value(s).unwrap_or(Value::Null);
    section.keys.iter().filter_map(|k| v.get(*k).map(|x| ((*k).to_owned(), x.clone()))).collect()
}

/// `s` with `values` written over its keys (read leniently: a value this version cannot read
/// keeps the current one).
fn with_values(s: &Settings, values: &BTreeMap<String, Value>) -> Settings {
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    for (k, x) in values {
        let mut candidate = v.clone();
        candidate[k] = x.clone();
        if serde_json::from_value::<Settings>(candidate.clone()).is_ok() {
            v = candidate;
        }
    }
    serde_json::from_value(v).unwrap_or_else(|_| s.clone())
}

/// Writes the shared sections of `s` into `file`. Returns whether anything changed.
pub fn put_shared(file: &mut SharedFile, s: &Settings, now: i64) -> bool {
    let mut changed = false;
    file.format = 1;
    for sec in SECTIONS.iter().filter(|x| scope_of(s, x.id) == Scope::Global) {
        let values = values_of(s, sec);
        if file.sections.get(sec.id) != Some(&values) {
            file.sections.insert(sec.id.to_owned(), values);
            file.updated.insert(sec.id.to_owned(), now);
            changed = true;
        }
    }
    changed
}

/// Saves the shared sections of `s` to the shared file, if a shared folder is set. Failures
/// are not fatal (the workspace keeps the values); they show up in the next start's log.
pub fn store_shared(s: &Settings) {
    let Some(dir) = shared_dir() else { return };
    let mut file = read_shared(&dir);
    if put_shared(&mut file, s, crate::settings_sync::now_ms()) {
        let _ = write_shared(&dir, &file);
    }
}

/// Takes the shared values into `s` at start. `fresh`: the workspace has no stored settings
/// yet (a new data folder), so it takes every shared section. An existing workspace that
/// never decided keeps its own values when they differ from the shared ones (the section
/// becomes „Nur dieser Arbeitsbereich“): nothing changes silently on the update to 1.10.
/// Returns the ids of the sections taken over.
pub fn adopt(s: &mut Settings, file: &SharedFile, fresh: bool) -> Vec<String> {
    let mut taken = vec![];
    for sec in &SECTIONS {
        let Some(values) = file.sections.get(sec.id) else { continue };
        if scope_of(s, sec.id) != Scope::Global {
            continue;
        }
        let decided = s.workspace_scopes.contains_key(sec.id);
        let own = values_of(s, sec);
        if own == *values {
            continue;
        }
        if !decided && !fresh {
            s.workspace_scopes.insert(sec.id.to_owned(), Scope::Workspace);
            continue;
        }
        *s = with_values(s, values);
        taken.push(sec.id.to_owned());
    }
    taken
}

/// Changes the scope of section `id`. To „Für alle“: the shared value is taken when there is
/// one (else this workspace's value becomes the shared one with the next save); to „Nur
/// dieser“: the workspace keeps the value it has now.
pub fn set_scope(s: &mut Settings, id: &str, scope: Scope, file: &SharedFile) -> Result<()> {
    if section(id).is_none() {
        return Err(crate::Error::State(crate::trf!(
            "Abschnitt „{id}“ kann nicht geteilt werden",
            "Section “{id}” cannot be shared"
        )));
    }
    s.workspace_scopes.insert(id.to_owned(), scope);
    if scope == Scope::Global
        && let Some(values) = file.sections.get(id)
    {
        *s = with_values(s, values);
    }
    Ok(())
}

impl Database {
    /// At start: takes over the shared sections that another workspace changed since this
    /// one last saved (see [`adopt`]). Returns the ids taken.
    pub fn adopt_shared_settings(&self) -> Result<Vec<String>> {
        let Some(dir) = shared_dir() else { return Ok(vec![]) };
        let file = read_shared(&dir);
        let fresh =
            self.conn().query_row("SELECT COUNT(*) FROM settings WHERE key = 'app'", [], |r| r.get::<_, i64>(0))? == 0;
        let mut s = self.load_settings()?;
        let before = s.clone();
        let taken = adopt(&mut s, &file, fresh);
        if s != before {
            self.save_settings(&s)?;
        }
        Ok(taken)
    }

    /// Changes the scope of a section and saves (see [`set_scope`]).
    pub fn set_settings_scope(&self, id: &str, scope: Scope) -> Result<Settings> {
        let file = shared_dir().map(|d| read_shared(&d)).unwrap_or_default();
        let mut s = self.load_settings()?;
        set_scope(&mut s, id, scope, &file)?;
        self.save_settings(&s)?;
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dark() -> Settings {
        Settings { theme: "dark".into(), ..Default::default() }
    }

    #[test]
    fn effective_value_is_the_workspace_one_else_the_shared_one() {
        let mut file = SharedFile::default();
        // Workspace A shares its theme.
        assert!(put_shared(&mut file, &dark(), 1));
        assert_eq!(file.sections["appearance"]["theme"], "dark");
        // Start page and filing stay with the workspace by default.
        assert!(!file.sections.contains_key("dashboard") && !file.sections.contains_key("filing"));
        // A new workspace takes it.
        let mut b = Settings::default();
        assert_eq!(adopt(&mut b, &file, true), ["appearance"]);
        assert_eq!(b.theme, "dark");
        // An existing workspace with its own theme keeps it and decides „Nur dieser“.
        let mut c = Settings { theme: "light".into(), ..Default::default() };
        assert!(adopt(&mut c, &file, false).is_empty());
        assert_eq!((c.theme.as_str(), scope_of(&c, "appearance")), ("light", Scope::Workspace));
        // It switches to „Für alle“: the shared value wins.
        set_scope(&mut c, "appearance", Scope::Global, &file).unwrap();
        assert_eq!(c.theme, "dark");
        // Back to „Nur dieser“ and changed: the shared file does not follow.
        set_scope(&mut c, "appearance", Scope::Workspace, &file).unwrap();
        c.theme = "light".into();
        assert!(!put_shared(&mut file, &c, 2));
        assert_eq!(file.sections["appearance"]["theme"], "dark");
        // A workspace that decided „Für alle“ follows later changes of the others.
        b.workspace_scopes.insert("appearance".into(), Scope::Global);
        let mut a2 = dark();
        a2.appearance.accent = "teal".into();
        assert!(put_shared(&mut file, &a2, 3));
        assert_eq!(adopt(&mut b, &file, false), ["appearance"]);
        assert_eq!(b.appearance.accent, "teal");
        assert!(set_scope(&mut b, "network", Scope::Global, &file).is_err());
    }

    #[test]
    fn sections_name_real_keys_once() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        let mut seen = std::collections::HashSet::new();
        for s in &SECTIONS {
            for k in s.keys {
                assert!(v.get(*k).is_some(), "{} names unknown key {k}", s.id);
                assert!(seen.insert(*k), "{k} in two sections");
            }
        }
    }

    #[test]
    fn shared_file_round_trip_and_database() {
        let dir = std::env::temp_dir().join(format!("arcalo-layers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mut f = SharedFile::default();
        put_shared(&mut f, &dark(), 5);
        write_shared(&dir, &f).unwrap();
        assert_eq!(read_shared(&dir), f);
        assert_eq!(read_shared(&dir.join("missing")), SharedFile::default());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
