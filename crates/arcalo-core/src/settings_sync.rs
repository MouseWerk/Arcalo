//! Settings across computers through the Git sync (opt-in: Einstellungen → Sicherung →
//! „Einstellungen synchronisieren“).
//!
//! The sync writes [`FILE`] into the repository: the settings that make sense on another
//! computer, one entry per setting (a top-level key, or a field of a section such as
//! `editor.tab_size`) with the time it was last changed here. On a pull the entries are merged
//! one by one, the later change wins ([`merge`]); the shell applies what came from the
//! server, logs it and keeps it for „Rückgängig“ ([`crate::db::Database::settings_sync_undo`]).
//!
//! Never in the file: secrets (any key that names a token, password, key, secret or
//! credential, at any depth, and URLs with a password; [`scrub`]), and what belongs to one
//! computer or one workspace ([`EXCLUDED`], [`EXCLUDED_FIELDS`]): folders and paths, window
//! and backdrop, devices, proxy and network, the update channel (admin policies), the Git
//! sync itself, AI connections and what names them (providers, the models of the tiers and of
//! the search by meaning, prices; their keys are per computer), Jira sites and calendars (their
//! tokens and addresses are secrets), the start page and links (they point to pages and
//! folders of this workspace), the first-run state and which sections a workspace shares.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::Database;
use crate::error::Result;
use crate::settings::Settings;

/// Name of the file in the repository.
pub const FILE: &str = "settings.json";

/// Top-level keys that never leave this computer.
pub const EXCLUDED: [&str; 27] = [
    "version",
    "workspace_scopes",
    "litellm_base_url",
    "providers",
    // They name providers and their models, which are set up per computer.
    "embedding_provider",
    "embedding_model",
    "prices",
    "backup_dir",
    "backup_targets",
    "markdown_mirror",
    "markdown_mirror_dir",
    "daily_template",
    "close_to_tray",
    "auto_update_check",
    "updates",
    "dev_log_verbose",
    "dev_log_level",
    "dev_log_json",
    "git_sync",
    "network",
    "dashboard",
    "quick_links",
    "calendar",
    "onboarding",
    "capture_shortcut",
    "search_shortcut",
    "palette_shortcut",
];

/// Fields of synced sections that belong to this computer or workspace.
pub const EXCLUDED_FIELDS: [&str; 19] = [
    "router.local_provider",
    "router.standard_provider",
    "router.reasoning_provider",
    "router.local_model",
    "router.standard_model",
    "router.reasoning_model",
    "appearance.window_effect",
    "appearance.window_opacity",
    "appearance.custom_titlebar",
    "appearance.ui_scale",
    "start.restore_window",
    "start.minimized",
    "voice.input_device",
    "voice.model",
    "voice.shortcut",
    "mail.shortcut",
    "capture.selection_shortcut",
    "jira.sites",
    "notes.daily_folder",
];

/// Sections synced field by field (structs; every other key is one entry).
pub const SECTIONS: [&str; 17] = [
    "router",
    "thresholds",
    "appearance",
    "editor",
    "notes",
    "time",
    "ai",
    "notifications",
    "privacy",
    "start",
    "locale",
    "capture",
    "mail",
    "voice",
    "jira",
    "briefing",
    "filing",
];

/// Whether a key names a secret: token, password, secret, credential, cookie, an API or
/// private key, or `key` itself. Checked on every key at every depth, in both directions.
pub fn is_secret_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase().replace(['-', ' '], "_");
    const WORDS: [&str; 10] = [
        "token",
        "password",
        "passwd",
        "secret",
        "credential",
        "cookie",
        "apikey",
        "api_key",
        "private_key",
        "auth_header",
    ];
    WORDS.iter().any(|w| n.contains(w))
        || n == "key"
        || n.ends_with("_key")
        || n.ends_with("key_id")
        || n == "authorization"
        || n == "pass"
        || n == "pin"
}

/// A URL with a password in it (`https://user:pass@host`).
fn has_userinfo_password(s: &str) -> bool {
    let Some((_, rest)) = s.split_once("://") else { return false };
    let host_part = rest.split(['/', '?', '#']).next().unwrap_or("");
    host_part.split_once('@').is_some_and(|(info, _)| info.contains(':'))
}

/// Removes every secret from `v` (see [`is_secret_name`]); strings with a password in a URL
/// become `null`.
pub fn scrub(v: &mut Value) {
    match v {
        Value::Object(map) => {
            map.retain(|k, _| !is_secret_name(k));
            for x in map.values_mut() {
                scrub(x);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(scrub),
        Value::String(s) if has_userinfo_password(s) => *v = Value::Null,
        _ => {}
    }
}

/// The settings that can be synced, one entry per setting (`key` or `section.field`),
/// without excluded keys and secrets.
pub fn entries(s: &Settings) -> BTreeMap<String, Value> {
    let v = serde_json::to_value(s).unwrap_or(Value::Null);
    entries_of(&v)
}

fn entries_of(v: &Value) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    for (k, x) in v.as_object().into_iter().flatten() {
        if EXCLUDED.contains(&k.as_str()) || is_secret_name(k) {
            continue;
        }
        match x.as_object() {
            Some(fields) if SECTIONS.contains(&k.as_str()) => {
                for (f, y) in fields {
                    let path = format!("{k}.{f}");
                    if EXCLUDED_FIELDS.contains(&path.as_str()) || is_secret_name(f) {
                        continue;
                    }
                    let mut y = y.clone();
                    scrub(&mut y);
                    out.insert(path, y);
                }
            }
            _ => {
                let mut y = x.clone();
                scrub(&mut y);
                out.insert(k.clone(), y);
            }
        }
    }
    out
}

/// Whether `path` may be synced at all (checked on everything that comes from the server).
pub fn syncable(path: &str) -> bool {
    let mut parts = path.splitn(2, '.');
    let top = parts.next().unwrap_or("");
    let field = parts.next();
    if top.is_empty() || EXCLUDED.contains(&top) || is_secret_name(top) {
        return false;
    }
    match field {
        Some(f) => {
            SECTIONS.contains(&top) && !EXCLUDED_FIELDS.contains(&path) && !is_secret_name(f) && !f.contains('.')
        }
        None => !SECTIONS.contains(&top),
    }
}

/// One synced setting: its value and when it was last changed (ms since the epoch, 0 =
/// never since the sync knows it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub value: Value,
    #[serde(default)]
    pub at: i64,
}

/// The file in the repository.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SyncFile {
    pub format: u32,
    /// Computer that wrote it last.
    pub host: String,
    pub settings: BTreeMap<String, Entry>,
}

impl SyncFile {
    /// Reads a file from the server: unreadable is empty, entries that may not be synced and
    /// secrets are dropped.
    pub fn parse(text: &str) -> SyncFile {
        let mut f: SyncFile = serde_json::from_str(text).unwrap_or_default();
        f.settings.retain(|k, _| syncable(k));
        for e in f.settings.values_mut() {
            scrub(&mut e.value);
        }
        f
    }

    pub fn to_text(&self) -> String {
        let mut f = self.clone();
        f.settings.retain(|k, _| syncable(k));
        for e in f.settings.values_mut() {
            scrub(&mut e.value);
        }
        serde_json::to_string_pretty(&f).unwrap_or_default() + "\n"
    }
}

/// This computer's file: its settings with the times they changed.
pub fn build(s: &Settings, stamps: &BTreeMap<String, i64>, host: &str) -> SyncFile {
    let settings = entries(s)
        .into_iter()
        .map(|(k, value)| {
            let at = stamps.get(&k).copied().unwrap_or(0);
            (k, Entry { value, at })
        })
        .collect();
    SyncFile { format: 1, host: host.to_owned(), settings }
}

/// Whether `theirs` replaces `mine`: it changed later, or this side never changed the
/// setting (time 0) and the server has another value. Equal times keep this side's value.
fn theirs_wins(mine: Option<&Entry>, theirs: &Entry) -> bool {
    match mine {
        None => true,
        Some(m) if m.value == theirs.value => false,
        Some(m) => theirs.at > m.at || (m.at == 0 && theirs.at == 0),
    }
}

/// Merges the server's file into this side's, setting by setting (the later change wins).
/// Returns the merged file and the settings taken from `theirs`.
pub fn merge(mine: &SyncFile, theirs: &SyncFile) -> (SyncFile, Vec<String>) {
    let mut out = mine.clone();
    let mut taken = vec![];
    for (k, t) in &theirs.settings {
        if !syncable(k) {
            continue;
        }
        if theirs_wins(mine.settings.get(k), t) {
            out.settings.insert(k.clone(), t.clone());
            taken.push(k.clone());
        } else if let Some(m) = out.settings.get_mut(k)
            && m.value == t.value
        {
            // The same value on both sides: the later time stays, so both files agree.
            m.at = m.at.max(t.at);
        }
    }
    out.format = 1;
    (out, taken)
}

/// [`merge`] on the texts the Git sync handles: `ours` merged with the server's (or the
/// working tree's) `theirs`. Used by [`crate::gitsync`].
pub fn merge_text(theirs: Option<&str>, ours: &str) -> String {
    let mine = SyncFile::parse(ours);
    match theirs {
        Some(t) => merge(&mine, &SyncFile::parse(t)).0.to_text(),
        None => mine.to_text(),
    }
}

/// A setting the last sync changed here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    pub key: String,
    pub before: Value,
    pub after: Value,
}

/// The last merge from the server (Einstellungen → Sicherung), with what it changed.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct LastMerge {
    /// ms since the epoch.
    pub at: i64,
    pub host: String,
    pub changes: Vec<Change>,
    pub undone: bool,
}

/// `s` with the server's entries that win (see [`merge`]) applied. Returns the new settings
/// (read leniently: a value this version cannot read keeps the current one), the changes
/// and the times to record for them.
pub fn apply(
    s: &Settings,
    stamps: &BTreeMap<String, i64>,
    theirs: &SyncFile,
) -> (Settings, Vec<Change>, BTreeMap<String, i64>) {
    let mine = build(s, stamps, "");
    let (_, taken) = merge(&mine, theirs);
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    let mut changes = vec![];
    let mut times = BTreeMap::new();
    for k in taken {
        let entry = &theirs.settings[&k];
        let before = mine.settings.get(&k).map(|e| e.value.clone()).unwrap_or(Value::Null);
        let mut candidate = v.clone();
        set_path(&mut candidate, &k, entry.value.clone());
        if serde_json::from_value::<Settings>(candidate.clone()).is_err() {
            continue;
        }
        v = candidate;
        times.insert(k.clone(), entry.at);
        if before != entry.value {
            changes.push(Change { key: k, before, after: entry.value.clone() });
        }
    }
    let next = serde_json::from_value(v).unwrap_or_else(|_| s.clone());
    (next, changes, times)
}

fn set_path(v: &mut Value, path: &str, x: Value) {
    match path.split_once('.') {
        Some((top, field)) => {
            if !v.get(top).is_some_and(Value::is_object) {
                v[top] = Value::Object(Default::default());
            }
            v[top][field] = x;
        }
        None => v[path] = x,
    }
}

/// `s` with the changes of a merge taken back.
pub fn undo(s: &Settings, changes: &[Change]) -> Settings {
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    for c in changes {
        let mut candidate = v.clone();
        set_path(&mut candidate, &c.key, c.before.clone());
        if serde_json::from_value::<Settings>(candidate.clone()).is_ok() {
            v = candidate;
        }
    }
    serde_json::from_value(v).unwrap_or_else(|_| s.clone())
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

const STAMPS: &str = "settings_stamps";
const LAST: &str = "settings_sync_last";

/// Records `at` for every synced setting that differs between `before` and `after` (called
/// by every settings save).
pub fn record_changes(db: &Database, before: &Settings, after: &Settings, at: i64) -> Result<()> {
    let (a, b) = (entries(before), entries(after));
    let changed: Vec<&String> = b.iter().filter(|(k, v)| a.get(*k) != Some(*v)).map(|(k, _)| k).collect();
    if changed.is_empty() {
        return Ok(());
    }
    let mut stamps = db.settings_stamps()?;
    for k in changed {
        stamps.insert(k.clone(), at);
    }
    db.meta_set(STAMPS, &serde_json::to_string(&stamps)?)
}

impl Database {
    /// When each synced setting was last changed here.
    pub fn settings_stamps(&self) -> Result<BTreeMap<String, i64>> {
        Ok(self.meta_get(STAMPS)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default())
    }

    /// This computer's [`FILE`].
    pub fn settings_sync_file(&self, host: &str) -> Result<String> {
        Ok(build(&self.load_settings()?, &self.settings_stamps()?, host).to_text())
    }

    /// Applies the server's file (after a sync): the settings that changed later there are
    /// taken, keep the server's times, and are remembered for „Rückgängig“. Returns the
    /// changes; the caller applies the new settings to the running app.
    pub fn settings_sync_apply(&self, text: &str) -> Result<(Settings, Vec<Change>)> {
        let theirs = SyncFile::parse(text);
        let s = self.load_settings()?;
        let (next, changes, times) = apply(&s, &self.settings_stamps()?, &theirs);
        if next != s {
            self.save_settings(&next)?;
        }
        // The server's times, not the time of this save: otherwise both sides would win in turn.
        let mut stamps = self.settings_stamps()?;
        stamps.extend(times);
        self.meta_set(STAMPS, &serde_json::to_string(&stamps)?)?;
        if !changes.is_empty() {
            let last = LastMerge { at: now_ms(), host: theirs.host.clone(), changes: changes.clone(), undone: false };
            self.meta_set(LAST, &serde_json::to_string(&last)?)?;
        }
        Ok((next, changes))
    }

    /// The last merge that changed settings here, if any.
    pub fn settings_sync_last(&self) -> Result<Option<LastMerge>> {
        Ok(self.meta_get(LAST)?.and_then(|t| serde_json::from_str(&t).ok()))
    }

    /// Takes the last merge back. The old values count as changed now, so the next sync
    /// carries them to the other computers.
    pub fn settings_sync_undo(&self) -> Result<Settings> {
        let Some(mut last) = self.settings_sync_last()?.filter(|l| !l.undone) else {
            return Err(crate::Error::State(crate::tr!("Nichts zum Rückgängigmachen", "Nothing to undo").into()));
        };
        let s = self.load_settings()?;
        let next = undo(&s, &last.changes);
        let before = self.settings_stamps()?;
        self.save_settings(&next)?;
        // Later than the server's change it takes back, even with a clock behind the server's.
        let mut stamps = self.settings_stamps()?;
        let now = now_ms();
        for c in &last.changes {
            let t = before.get(&c.key).copied().unwrap_or(0);
            stamps.insert(c.key.clone(), now.max(t + 1));
        }
        self.meta_set(STAMPS, &serde_json::to_string(&stamps)?)?;
        last.undone = true;
        self.meta_set(LAST, &serde_json::to_string(&last)?)?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn paths(v: &Value, prefix: &str, out: &mut Vec<String>) {
        match v {
            Value::Object(m) => {
                for (k, x) in m {
                    let p = if prefix.is_empty() { k.clone() } else { format!("{prefix}.{k}") };
                    out.push(p.clone());
                    paths(x, &p, out);
                }
            }
            Value::Array(a) => a.iter().for_each(|x| paths(x, prefix, out)),
            _ => {}
        }
    }

    /// Settings full of secrets in every place a key can sit.
    fn poisoned() -> Value {
        let mut v = serde_json::to_value(Settings::default()).unwrap();
        let secrets = serde_json::json!({
            "api_key": "sk-1", "token": "t", "access_token": "t", "password": "p", "proxy_password": "p",
            "client_secret": "s", "credential": "c", "credentials": {"user": "u"}, "key": "k",
            "private_key": "pk", "Auth-Header": "Bearer x", "cookie": "c", "aws_access_key_id": "AK",
            "url": "https://mia:geheim@jira.firma.de/rest"
        });
        for (k, x) in secrets.as_object().unwrap() {
            v[k] = x.clone();
            for sec in SECTIONS {
                v[sec][k] = x.clone();
                v[sec]["nested"] = serde_json::json!({ k: x.clone(), "list": [{ k: x.clone() }] });
            }
        }
        v
    }

    #[test]
    fn no_secret_can_ever_be_written() {
        let file = SyncFile {
            format: 1,
            host: "pc".into(),
            settings: entries_of(&poisoned()).into_iter().map(|(k, value)| (k, Entry { value, at: 1 })).collect(),
        };
        // Also entries handed in directly (a newer version's, a hand-edited file).
        let mut file = file;
        file.settings.insert("ai.api_key".into(), Entry { value: "sk".into(), at: 1 });
        file.settings.insert("token".into(), Entry { value: "t".into(), at: 1 });
        let text = file.to_text();
        let v: Value = serde_json::from_str(&text).unwrap();
        let mut all = vec![];
        paths(&v["settings"], "", &mut all);
        for p in &all {
            for seg in p.split('.') {
                assert!(!is_secret_name(seg), "secret key written: {p}");
            }
        }
        for word in ["sk-1", "geheim", "Bearer", "AK\""] {
            assert!(!text.contains(word), "secret value written: {word}");
        }
        // And nothing comes in that way.
        let back = SyncFile::parse(
            &serde_json::json!({"settings": {"git_sync.token": {"value": "x", "at": 9},
            "network": {"value": {}, "at": 9}, "editor.password": {"value": "p", "at": 9}}})
            .to_string(),
        );
        assert!(back.settings.is_empty(), "{back:?}");
    }

    #[test]
    fn real_settings_have_no_secret_names_and_machine_keys_stay_home() {
        let e = entries(&Settings::default());
        for k in e.keys() {
            assert!(k.split('.').all(|s| !is_secret_name(s)), "{k}");
            assert!(syncable(k), "{k}");
        }
        for k in [
            "backup_dir",
            "network",
            "git_sync",
            "updates",
            "voice.input_device",
            "appearance.window_effect",
            "providers",
        ] {
            assert!(!e.keys().any(|x| x == k || x.starts_with(&format!("{k}."))), "{k} synced");
        }
        assert!(e.contains_key("editor.tab_size") && e.contains_key("theme") && e.contains_key("keymap"));
        // Every section synced field by field is an object in the settings.
        let v = serde_json::to_value(Settings::default()).unwrap();
        for s in SECTIONS {
            assert!(v[s].is_object(), "{s}");
        }
        // Words that only look like secrets stay.
        for ok in ["keymap", "jira_issue_map", "monkey_mode", "author_name", "keywords"] {
            assert!(!is_secret_name(ok), "{ok}");
        }
    }

    #[test]
    fn provider_choices_stay_on_their_computer() {
        let mut a = Settings::default();
        a.router.standard_provider = "firma-ollama".into();
        a.router.standard_model = "llama3.3".into();
        a.embedding_provider = "firma-ollama".into();
        a.embedding_model = Some("nomic-embed-text".into());
        a.router.standard_threshold = 42;
        let keys: Vec<String> = entries(&a).into_keys().collect();
        for k in
            ["embedding_provider", "embedding_model", "prices", "router.standard_provider", "router.standard_model"]
        {
            assert!(!keys.contains(&k.to_owned()), "{k} synced");
            assert!(!syncable(k), "{k}");
        }
        // A file of 1.15 still carries them: the other computer keeps its own.
        let stamps: BTreeMap<String, i64> = keys.iter().map(|k| (k.clone(), 1_000)).collect();
        let mut file = build(&a, &stamps, "a");
        for (k, v) in [
            ("router.standard_provider", Value::from("firma-ollama")),
            ("embedding_provider", Value::from("firma-ollama")),
            ("embedding_model", Value::from("nomic-embed-text")),
        ] {
            file.settings.insert(k.into(), Entry { value: v, at: 1_000 });
        }
        let b = Settings::default();
        let (next, _, _) = apply(&b, &BTreeMap::new(), &SyncFile::parse(&file.to_text()));
        assert_eq!(next.router.standard_provider, b.router.standard_provider);
        assert_eq!(next.router.standard_model, b.router.standard_model);
        assert_eq!(
            (next.embedding_provider.as_str(), next.embedding_model.as_deref()),
            (b.embedding_provider.as_str(), None)
        );
        assert_eq!(next.router.standard_threshold, 42, "the rest of the router travels");
    }

    #[test]
    fn later_change_wins_per_setting() {
        let mut a = Settings::default();
        let mut b = Settings::default();
        a.editor.tab_size = 4;
        b.theme = "dark".into();
        let fa = build(&a, &BTreeMap::from([("editor.tab_size".into(), 100)]), "a");
        let fb = build(&b, &BTreeMap::from([("theme".into(), 200), ("editor.tab_size".into(), 50)]), "b");
        let (m, taken) = merge(&fa, &fb);
        assert_eq!(taken, ["theme"]);
        assert_eq!(m.settings["editor.tab_size"].value, 4);
        assert_eq!(m.settings["theme"].value, "dark");
        // The same from the other side gives the same result.
        let (m2, _) = merge(&fb, &fa);
        assert_eq!(m.settings, m2.settings);
        // Never changed on this side (time 0): the server's value is taken.
        let fresh = build(&Settings { theme: "light".into(), ..Default::default() }, &BTreeMap::new(), "c");
        let (_, taken) = merge(&fresh, &fb);
        assert!(taken.contains(&"theme".to_owned()));
    }

    #[test]
    fn apply_log_and_undo_in_the_database() {
        let db = Database::open_in_memory().unwrap();
        let mut s = db.load_settings().unwrap();
        s.editor.tab_size = 3;
        db.save_settings(&s).unwrap();
        let stamp = db.settings_stamps().unwrap()["editor.tab_size"];
        assert!(stamp > 0);
        let mut other = Settings::default();
        other.editor.tab_size = 8;
        other.theme = "dark".into();
        let server =
            build(&other, &BTreeMap::from([("editor.tab_size".into(), stamp + 1000), ("theme".into(), 5)]), "laptop");
        let (next, changes) = db.settings_sync_apply(&server.to_text()).unwrap();
        assert_eq!((next.editor.tab_size, next.theme.as_str()), (8, "dark"));
        let keys: Vec<&str> = changes.iter().map(|c| c.key.as_str()).collect();
        assert_eq!(keys, ["editor.tab_size", "theme"]);
        assert_eq!(db.settings_stamps().unwrap()["editor.tab_size"], stamp + 1000, "server's time kept");
        let last = db.settings_sync_last().unwrap().unwrap();
        assert_eq!((last.host.as_str(), last.changes.len()), ("laptop", 2));
        // A second apply of the same file changes nothing.
        assert!(db.settings_sync_apply(&server.to_text()).unwrap().1.is_empty());
        let back = db.settings_sync_undo().unwrap();
        assert_eq!((back.editor.tab_size, back.theme.as_str()), (3, "system"));
        assert!(db.settings_stamps().unwrap()["editor.tab_size"] > stamp + 1000, "the undo wins next time");
        assert!(db.settings_sync_undo().is_err());
    }
}
