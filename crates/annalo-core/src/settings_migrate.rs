//! Versions of the stored settings and the ordered steps between them.
//!
//! The settings are one JSON object (`settings` table, key `app`). Since 1.10 it carries a
//! top-level `version`; settings of 1.9 and older have none and count as version 0. On load,
//! every step from the stored version up to [`SETTINGS_VERSION`] runs once on the raw JSON,
//! before the lenient per-key parsing ([`crate::db::Database::parse_settings_lenient`]); the
//! shell writes the result back at start ([`crate::db::Database::migrate_settings`]) and logs
//! what the steps did.
//!
//! Rules for a step: it works on the JSON (never on the parsed struct, so keys this version
//! does not know stay), it is idempotent (a 1.9 that saved over 1.10 settings drops
//! `version`, and the chain runs again), and it changes nothing that is already in the new
//! shape. Settings of a newer version (higher `version`) are not touched.
//!
//! The per-database fixes of 1.3 and later that depend on a flag in the database rather than
//! on the settings themselves (`migrate_palette_default`, `migrate_appearance_defaults`,
//! `migrate_activity_tool`) stay where they are: running them again on settings a user has
//! changed since would undo a choice.

use serde_json::{Map, Value};

use crate::ai::provider::{AiProvider, LEGACY_ID};
use crate::prefs::{StartOpen, StartPrefs, WindowEffect};

/// Version written by this release.
pub const SETTINGS_VERSION: u32 = 8;

/// One step `from → from + 1`: changes the settings object and says what it did (`None`:
/// nothing to do for these settings).
pub struct Step {
    pub from: u32,
    pub name: &'static str,
    pub run: fn(&mut Map<String, Value>) -> Option<String>,
}

/// The chain, in order. `STEPS[i].from == i`.
pub const STEPS: [Step; SETTINGS_VERSION as usize] = [
    Step { from: 0, name: "start-open", run: start_open },
    Step { from: 1, name: "ai-providers", run: ai_providers },
    Step { from: 2, name: "window-effect", run: window_effect },
    Step { from: 3, name: "calendar-list", run: calendar_list },
    Step { from: 4, name: "dashboard-clean", run: dashboard_clean },
    Step { from: 5, name: "log-level-and-due-tasks", run: log_level_and_due_tasks },
    Step { from: 6, name: "network-profiles", run: network_profiles },
    Step { from: 7, name: "meeting-prep", run: meeting_prep },
];

/// What [`migrate`] did.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Migration {
    /// Stored version (0 when there was none).
    pub from: u32,
    /// Version afterwards (the stored one when it is newer than this release).
    pub to: u32,
    /// One line per step that changed something: `name: what`.
    pub notes: Vec<String>,
}

impl Migration {
    pub fn ran(&self) -> bool {
        self.to > self.from
    }
}

/// The version stored in `value` (0 for settings without one; unreadable counts as 0).
pub fn stored_version(value: &Value) -> u32 {
    value.get("version").and_then(Value::as_u64).map_or(0, |v| v.min(u32::MAX as u64) as u32)
}

/// Runs the steps from the stored version up to [`SETTINGS_VERSION`] and sets `version`.
/// Values that are not objects are left alone (the parser falls back to the defaults).
pub fn migrate(value: &mut Value) -> Migration {
    let from = stored_version(value);
    let Some(obj) = value.as_object_mut() else { return Migration { from, to: from, notes: vec![] } };
    let mut notes = vec![];
    for step in STEPS.iter().skip(from as usize) {
        if let Some(note) = (step.run)(obj) {
            notes.push(format!("{}: {note}", step.name));
        }
    }
    let to = from.max(SETTINGS_VERSION);
    obj.insert("version".into(), Value::from(to));
    Migration { from, to, notes }
}

/// `target` with the keys of `fresh` written over it; keys only `target` has stay (they may
/// come from a newer version).
fn overlay(target: &mut Value, fresh: Value) {
    match (target.as_object_mut(), fresh) {
        (Some(t), Value::Object(f)) => {
            for (k, v) in f {
                t.insert(k, v);
            }
        }
        (_, fresh) => *target = fresh,
    }
}

/// 0 → 1: settings from before the start preferences keep „Tagesnotiz beim Start öffnen“
/// (`open_daily_on_start` becomes `start.open = daily`).
fn start_open(s: &mut Map<String, Value>) -> Option<String> {
    if s.contains_key("start") || s.get("open_daily_on_start").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let start = StartPrefs { open: StartOpen::Daily, ..Default::default() };
    s.insert("start".into(), serde_json::to_value(start).ok()?);
    Some("open_daily_on_start → start.open = daily".into())
}

/// 1 → 2: settings from before AI providers: the LiteLLM server becomes the one provider, its
/// token stays where it is (the credential of the provider `litellm`), tiers without a
/// provider and the embeddings use it.
fn ai_providers(s: &mut Map<String, Value>) -> Option<String> {
    if s.contains_key("providers") {
        return None;
    }
    let url = s
        .get("litellm_base_url")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| crate::settings::DEFAULT_LITELLM_URL.to_owned());
    s.insert("providers".into(), serde_json::to_value(vec![AiProvider::litellm(&url)]).ok()?);
    if let Some(router) = s.get_mut("router").and_then(Value::as_object_mut) {
        for key in ["local_provider", "standard_provider", "reasoning_provider"] {
            let empty = router.get(key).and_then(Value::as_str).is_none_or(|p| p.trim().is_empty());
            if empty {
                router.insert(key.into(), Value::from(LEGACY_ID));
            }
        }
    }
    s.insert("embedding_provider".into(), Value::from(LEGACY_ID));
    Some(format!("LiteLLM server {url} → provider {LEGACY_ID}"))
}

/// 2 → 3: settings from before the backdrop choice (1.6): the Mica switch becomes the
/// effect; the old key goes.
fn window_effect(s: &mut Map<String, Value>) -> Option<String> {
    let a = s.get_mut("appearance")?.as_object_mut()?;
    let mica = a.remove("mica")?;
    if !a.contains_key("window_effect") && mica.as_bool() == Some(true) {
        a.insert("window_effect".into(), serde_json::to_value(WindowEffect::Mica).ok()?);
        return Some("appearance.mica → window_effect = mica".into());
    }
    Some("appearance.mica removed".into())
}

/// 3 → 4: settings of 1.5 know only the default Outlook calendar: it gets its entry in the
/// calendar list (with the color it had), sources get clean ids.
fn calendar_list(s: &mut Map<String, Value>) -> Option<String> {
    let cal = s.get_mut("calendar")?;
    let parsed: crate::calsync::CalendarSettings = serde_json::from_value(cal.clone()).ok()?;
    let fresh = serde_json::to_value(parsed.normalized()).ok()?;
    let before = cal.clone();
    overlay(cal, fresh);
    (*cal != before).then(|| "calendar list normalized".into())
}

/// 4 → 5: the start page's boards cleaned once (ids, grid bounds, sizes); the start page
/// itself keeps them clean from now on.
fn dashboard_clean(s: &mut Map<String, Value>) -> Option<String> {
    let d = s.get_mut("dashboard")?;
    let parsed: crate::settings::Dashboard = serde_json::from_value(d.clone()).ok()?;
    let fresh = serde_json::to_value(parsed.normalized()).ok()?;
    let before = d.clone();
    overlay(d, fresh);
    (*d != before).then(|| "start page boards cleaned".into())
}

/// 5 → 6: the developer log's level (1.10) follows the old switch (on: `debug`; off stays
/// empty, which means `info`), and reminders of due tasks start on, as for new settings.
fn log_level_and_due_tasks(s: &mut Map<String, Value>) -> Option<String> {
    let mut notes = vec![];
    if !s.contains_key("dev_log_level") && s.get("dev_log_verbose").and_then(Value::as_bool) == Some(true) {
        s.insert("dev_log_level".into(), Value::from("debug"));
        notes.push("dev_log_verbose → dev_log_level = debug");
    }
    if let Some(n) = s.get_mut("notifications").and_then(Value::as_object_mut)
        && !n.contains_key("task_due")
    {
        n.insert("task_due".into(), Value::Bool(true));
        notes.push("notifications.task_due = true");
    }
    (!notes.is_empty()).then(|| notes.join(", "))
}

/// The network fields of 1.9 that move into the default profile unchanged.
const PROFILE_FIELDS: [&str; 9] = [
    "mode",
    "http_proxy",
    "https_proxy",
    "socks_proxy",
    "no_proxy",
    "pac_url",
    "pac_results",
    "proxy_user",
    "extra_ca_path",
];

/// 6 → 7: the single network setting becomes the profile „Standard“ with the same behavior.
/// The global „accept invalid certificates“ stays on that profile as a legacy flag (shown as
/// „unsicher“) instead of being dropped; connections that did not use the settings
/// (`apply_to` off: the program's default, i.e. the system proxy) are routed to a copy of it
/// in mode `system`.
fn network_profiles(s: &mut Map<String, Value>) -> Option<String> {
    let net = s.get_mut("network")?.as_object_mut()?;
    if net.contains_key("profiles") {
        return None;
    }
    let mut profile = Map::new();
    profile.insert("id".into(), Value::from(crate::network::DEFAULT_PROFILE));
    profile.insert("name".into(), Value::from("Standard"));
    for k in PROFILE_FIELDS {
        if let Some(v) = net.remove(k) {
            profile.insert(k.into(), v);
        }
    }
    if let Some(t) = net.remove("timeout_secs") {
        profile.insert("connect_timeout_secs".into(), t);
    }
    let mut notes = vec!["network → profile Standard".to_owned()];
    if net.remove("accept_invalid_certs").and_then(|v| v.as_bool()) == Some(true) {
        profile.insert("legacy_accept_invalid_certs".into(), Value::Bool(true));
        notes.push("accept_invalid_certs kept as legacy flag (unsicher)".into());
    }
    let apply_to = net.remove("apply_to");
    let off: Vec<&str> = ["ai", "git", "updates", "tools"]
        .into_iter()
        .filter(|k| apply_to.as_ref().and_then(|a| a.get(*k)).and_then(Value::as_bool) == Some(false))
        .collect();
    let mut profiles = vec![Value::Object(profile.clone())];
    let mut routes = Map::new();
    if !off.is_empty() {
        let mut sys = profile;
        sys.insert("id".into(), Value::from("standard-system"));
        sys.insert("name".into(), Value::from("Standard (System)"));
        sys.insert("mode".into(), Value::from("system"));
        profiles.push(Value::Object(sys));
        for k in &off {
            let groups: &[&str] = match *k {
                "ai" => &["ai"],
                "git" => &["git_sync"],
                "updates" => &["updates", "release_notes", "voice_models"],
                _ => &["http_tool", "link_preview", "jira", "ics"],
            };
            for g in groups {
                routes.insert((*g).into(), Value::from("standard-system"));
            }
        }
        notes.push(format!("apply_to off for {} → profile Standard (System)", off.join(", ")));
    }
    net.insert("profiles".into(), Value::Array(profiles));
    if !routes.is_empty() {
        net.insert("routes".into(), Value::Object(routes));
    }
    Some(notes.join(", "))
}

/// 7 → 8: „Besprechung vorbereiten“ by itself (1.10) starts off, 30 minutes before.
fn meeting_prep(s: &mut Map<String, Value>) -> Option<String> {
    let b = s.get_mut("briefing").and_then(Value::as_object_mut)?;
    let mut notes = vec![];
    if !b.contains_key("prep_auto") {
        b.insert("prep_auto".into(), Value::Bool(false));
        notes.push("briefing.prep_auto = false");
    }
    if !b.contains_key("prep_minutes") {
        b.insert("prep_minutes".into(), Value::from(crate::briefing::PREP_MINUTES));
        notes.push("briefing.prep_minutes = 30");
    }
    (!notes.is_empty()).then(|| notes.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::settings::Settings;

    const FIXTURES: [(&str, &str); 4] = [
        ("1.6", include_str!("../tests/fixtures/settings/1.6.json")),
        ("1.7", include_str!("../tests/fixtures/settings/1.7.json")),
        ("1.8", include_str!("../tests/fixtures/settings/1.8.json")),
        ("1.9", include_str!("../tests/fixtures/settings/1.9.json")),
    ];

    #[test]
    fn steps_are_ordered_and_complete() {
        for (i, s) in STEPS.iter().enumerate() {
            assert_eq!(s.from as usize, i, "step {} out of order", s.name);
        }
        assert_eq!(STEPS.len() as u32, SETTINGS_VERSION);
        assert_eq!(Settings::default().version, SETTINGS_VERSION);
    }

    #[test]
    fn fixtures_of_every_release_load_without_losing_a_value() {
        for (name, json) in FIXTURES {
            let raw: Value = serde_json::from_str(json).unwrap();
            let (s, bad) = Database::parse_settings_lenient(json);
            assert!(bad.is_empty(), "{name}: unreadable {bad:?}");
            assert_eq!(s.version, SETTINGS_VERSION, "{name}");
            // Values the user chose survive.
            assert_eq!(s.theme, raw["theme"].as_str().unwrap(), "{name}");
            assert_eq!(s.editor.tab_size as u64, raw["editor"]["tab_size"].as_u64().unwrap(), "{name}");
            assert_eq!(s.backup_keep as u64, raw["backup_keep"].as_u64().unwrap(), "{name}");
            assert_eq!(s.keymap.get("open_daily").map(String::as_str), Some("Ctrl+Shift+D"), "{name}");
            // Running the chain again changes nothing.
            let mut once = raw.clone();
            migrate(&mut once);
            let mut twice = once.clone();
            let m = migrate(&mut twice);
            assert_eq!(once, twice, "{name}: not idempotent");
            assert!(!m.ran() && m.notes.is_empty(), "{name}: {m:?}");
        }
    }

    #[test]
    fn sections_of_later_releases_start_at_their_defaults() {
        let d = Settings::default();
        // 1.6 had no backup targets, voice, Jira, briefing or filing yet.
        let s = Database::parse_settings(FIXTURES[0].1).unwrap();
        assert_eq!((&s.jira, &s.briefing, &s.filing), (&d.jira, &d.briefing, &d.filing));
        assert_eq!(s.appearance.window_effect, WindowEffect::Mica, "1.6 chose Mica");
        // The default Outlook calendar has its entry in the list.
        assert!(!s.calendar.outlook_calendars.is_empty());
        // 1.8 had Jira but no filing.
        let s = Database::parse_settings(FIXTURES[2].1).unwrap();
        assert_eq!(s.jira.sites.len(), 1);
        assert_eq!(s.filing, d.filing);
        // 1.9: only the 1.10 steps have something to do (and the version is added).
        let mut v: Value = serde_json::from_str(FIXTURES[3].1).unwrap();
        let mut before = v.clone();
        let m = migrate(&mut v);
        assert_eq!(
            m.notes,
            [
                "log-level-and-due-tasks: notifications.task_due = true",
                "network-profiles: network → profile Standard",
                "meeting-prep: briefing.prep_auto = false, briefing.prep_minutes = 30"
            ]
        );
        v.as_object_mut().unwrap().remove("version");
        before["notifications"]["task_due"] = Value::Bool(true);
        before["briefing"]["prep_auto"] = Value::Bool(false);
        before["briefing"]["prep_minutes"] = Value::from(30);
        assert_eq!(v["network"]["profiles"][0]["http_proxy"], before["network"]["http_proxy"]);
        v.as_object_mut().unwrap().remove("network");
        before.as_object_mut().unwrap().remove("network");
        assert_eq!(v, before);
        // The verbose log of 1.9 becomes the level „debug“; off keeps the default.
        let mut v = serde_json::json!({"version": 5, "dev_log_verbose": true, "notifications": {"task_due": false}});
        migrate(&mut v);
        assert_eq!(
            (v["dev_log_level"].as_str(), v["notifications"]["task_due"].as_bool()),
            (Some("debug"), Some(false))
        );
        let s = Database::parse_settings(r#"{"dev_log_verbose": false}"#).unwrap();
        assert_eq!(s.dev_log_level, "");
    }

    #[test]
    fn shapes_from_before_1_6_upgrade_step_by_step() {
        // 1.2: only the LiteLLM address and „Tagesnotiz beim Start öffnen“.
        let old = r#"{"litellm_base_url": "https://llm.firma.de", "open_daily_on_start": true,
            "router": {"local_model": "llama", "standard_model": "gpt-4o", "reasoning_model": "o3"},
            "appearance": {"mica": true, "accent": "theme"}}"#;
        let mut v: Value = serde_json::from_str(old).unwrap();
        let m = migrate(&mut v);
        let names: Vec<&str> = m.notes.iter().map(|n| n.split(':').next().unwrap()).collect();
        assert_eq!(names, ["start-open", "ai-providers", "window-effect"]);
        let s = Database::parse_settings(old).unwrap();
        assert_eq!(s.start.open, StartOpen::Daily);
        assert_eq!(s.providers.len(), 1);
        assert_eq!(s.providers[0].base_url, "https://llm.firma.de");
        assert_eq!((s.router.standard_provider.as_str(), s.embedding_provider.as_str()), (LEGACY_ID, LEGACY_ID));
        assert_eq!(s.router.standard_model, "gpt-4o");
        assert_eq!(s.appearance.window_effect, WindowEffect::Mica);
        // Mica switched off before 1.6: the key goes, the effect stays at its default.
        let mut v = serde_json::json!({"appearance": {"mica": false}});
        migrate(&mut v);
        assert_eq!(v["appearance"], serde_json::json!({}));
        // A set start preference is not overwritten by the old flag.
        let s = Database::parse_settings(r#"{"open_daily_on_start": true, "start": {"open": "tabs"}}"#).unwrap();
        assert_eq!(s.start.open, StartOpen::Tabs);
    }

    #[test]
    fn the_network_setting_becomes_the_default_profile() {
        use crate::network::{DEFAULT_PROFILE, ProxyMode, ProxyProfile, Service};
        // 1.9 fixture: a manual proxy.
        let s = Database::parse_settings(FIXTURES[3].1).unwrap();
        assert_eq!(s.network.profiles.len(), 1);
        let p = s.network.standard();
        assert_eq!((p.id.as_str(), p.name.as_str()), (DEFAULT_PROFILE, "Standard"));
        assert_eq!((p.mode, p.http_proxy.as_str()), (ProxyMode::Manual, "http://proxy.firma.de:8080"));
        assert_eq!((p.connect_timeout_secs, p.read_timeout_secs, p.legacy_accept_invalid_certs), (30, 0, false));
        assert!(s.network.routes.is_empty() && s.network.trusted_hosts.is_empty());

        // Every field of the old shape, the global certificate switch and `apply_to`.
        let mut old = serde_json::json!({"network": {
            "mode": "pac", "http_proxy": "", "https_proxy": "", "socks_proxy": "", "no_proxy": "*.intra",
            "pac_url": "http://wpad/proxy.pac", "pac_results": {"*": "PROXY p:3128"}, "proxy_user": "max",
            "extra_ca_path": "C:\\ca.pem", "accept_invalid_certs": true, "timeout_secs": 12,
            "apply_to": {"ai": true, "git": false, "updates": true, "tools": false}}});
        let m = migrate(&mut old);
        assert!(m.notes.iter().any(|n| n.contains("legacy flag")), "{m:?}");
        let net = &old["network"];
        assert!(
            net.get("mode").is_none() && net.get("accept_invalid_certs").is_none() && net.get("apply_to").is_none()
        );
        let s = Database::parse_settings(&old.to_string()).unwrap();
        let std = s.network.standard();
        let expected = ProxyProfile {
            mode: ProxyMode::Pac,
            no_proxy: "*.intra".into(),
            pac_url: "http://wpad/proxy.pac".into(),
            pac_results: [("*".to_owned(), "PROXY p:3128".to_owned())].into(),
            proxy_user: "max".into(),
            extra_ca_path: Some("C:\\ca.pem".into()),
            connect_timeout_secs: 12,
            legacy_accept_invalid_certs: true,
            ..Default::default()
        };
        assert_eq!(std, &expected);
        // Connections that did not use the settings go through a copy in mode `system`.
        let sys = s.network.profile("standard-system").unwrap();
        assert_eq!(
            sys,
            &ProxyProfile { id: sys.id.clone(), name: sys.name.clone(), mode: ProxyMode::System, ..expected }
        );
        for (service, profile) in [
            (Service::GitSync, "standard-system"),
            (Service::Jira("j".into()), "standard-system"),
            (Service::Ics("c".into()), "standard-system"),
            (Service::LinkPreview, "standard-system"),
            (Service::HttpTool, "standard-system"),
            (Service::Updates, DEFAULT_PROFILE),
            (Service::Ai { id: "litellm".into(), local: false }, DEFAULT_PROFILE),
        ] {
            assert_eq!(s.network.route_of(&service).unwrap_or(DEFAULT_PROFILE), profile, "{service:?}");
        }
        // Idempotent: the new shape is left alone.
        let mut again = old.clone();
        assert!(network_profiles(again.as_object_mut().unwrap()).is_none());
        assert_eq!(again, old);
        // Settings without a network section keep the defaults.
        let mut none = serde_json::json!({"theme": "dark"});
        migrate(&mut none);
        assert!(none.get("network").is_none());
    }

    #[test]
    fn newer_settings_are_left_alone_and_keep_their_keys() {
        let json = r#"{"version": 99, "theme": "dark", "hologram": {"depth": 3},
            "editor": {"tab_size": 4, "ligatures": "auto"}, "appearance": {"mica": true}}"#;
        let mut v: Value = serde_json::from_str(json).unwrap();
        let m = migrate(&mut v);
        assert_eq!((m.from, m.to), (99, 99));
        assert!(v["appearance"].get("mica").is_some(), "a step of an older version did not run");
        let s = Database::parse_settings(json).unwrap();
        assert_eq!(s.version, 99);
        // Saved and loaded again, the newer keys are still there (see `save_settings`).
        let db = Database::open_in_memory().unwrap();
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [json]).unwrap();
        let mut s = db.load_settings().unwrap();
        s.theme = "light".into();
        db.save_settings(&s).unwrap();
        let raw: String =
            db.conn().query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).unwrap();
        let raw: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(raw["hologram"]["depth"], 3);
        assert_eq!(raw["editor"]["ligatures"], "auto");
        assert_eq!(raw["theme"], "light");
        assert_eq!(raw["version"], 99);
    }

    #[test]
    fn migrate_settings_writes_back_once() {
        let db = Database::open_in_memory().unwrap();
        db.conn().execute("INSERT INTO settings (key, value) VALUES ('app', ?1)", [FIXTURES[0].1]).unwrap();
        let m = db.migrate_settings().unwrap();
        assert!(m.ran() && !m.notes.is_empty());
        let raw: String =
            db.conn().query_row("SELECT value FROM settings WHERE key = 'app'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored_version(&serde_json::from_str(&raw).unwrap()), SETTINGS_VERSION);
        assert!(!db.migrate_settings().unwrap().ran());
        // A fresh database has nothing to migrate.
        assert!(!Database::open_in_memory().unwrap().migrate_settings().unwrap().ran());
    }

    // ------------------------------------------------------------ JSON Schema

    /// The schema of the stored settings (generated from the types and their doc comments).
    fn schema() -> Value {
        serde_json::to_value(schemars::schema_for!(Settings)).unwrap()
    }

    /// Checks `v` against `schema` (the subset schemars writes: types, properties, items,
    /// additionalProperties, enum, const, $ref, anyOf/oneOf/allOf, minimum). Collects the
    /// paths that do not fit.
    fn validate(v: &Value, schema: &Value, root: &Value, path: &str, out: &mut Vec<String>) {
        if schema == &Value::Bool(true) || schema.as_object().is_some_and(|o| o.is_empty()) {
            return;
        }
        if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
            let name = r.trim_start_matches("#/definitions/");
            return validate(v, &root["definitions"][name], root, path, out);
        }
        for all in schema.get("allOf").and_then(Value::as_array).into_iter().flatten() {
            validate(v, all, root, path, out);
        }
        for key in ["anyOf", "oneOf"] {
            if let Some(options) = schema.get(key).and_then(Value::as_array) {
                let fits = options.iter().any(|o| {
                    let mut e = vec![];
                    validate(v, o, root, path, &mut e);
                    e.is_empty()
                });
                if !fits {
                    out.push(format!("{path}: none of {key}"));
                }
            }
        }
        if let Some(e) = schema.get("enum").and_then(Value::as_array)
            && !e.contains(v)
        {
            out.push(format!("{path}: {v} not in enum"));
        }
        if let Some(c) = schema.get("const")
            && c != v
        {
            out.push(format!("{path}: {v} is not {c}"));
        }
        if let Some(t) = schema.get("type") {
            let types: Vec<&str> = match t {
                Value::String(s) => vec![s.as_str()],
                Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
                _ => vec![],
            };
            let ok = types.iter().any(|t| match *t {
                "object" => v.is_object(),
                "array" => v.is_array(),
                "string" => v.is_string(),
                "boolean" => v.is_boolean(),
                "null" => v.is_null(),
                "integer" => v.is_i64() || v.is_u64(),
                "number" => v.is_number(),
                _ => true,
            });
            if !ok {
                out.push(format!("{path}: {v} is not {types:?}"));
                return;
            }
        }
        if let (Some(min), Some(n)) = (schema.get("minimum").and_then(Value::as_f64), v.as_f64())
            && n < min
        {
            out.push(format!("{path}: {n} < {min}"));
        }
        if let Some(obj) = v.as_object() {
            let props = schema.get("properties").and_then(Value::as_object);
            for (k, x) in obj {
                let p = format!("{path}.{k}");
                match (props.and_then(|p| p.get(k)), schema.get("additionalProperties")) {
                    (Some(s), _) => validate(x, s, root, &p, out),
                    (None, Some(Value::Bool(false))) => out.push(format!("{p}: not allowed")),
                    (None, Some(extra)) => validate(x, extra, root, &p, out),
                    (None, None) => {}
                }
            }
        }
        if let (Some(items), Some(schema)) = (v.as_array(), schema.get("items")) {
            for (i, x) in items.iter().enumerate() {
                validate(x, schema, root, &format!("{path}[{i}]"), out);
            }
        }
    }

    fn check(v: &Value) -> Vec<String> {
        let root = schema();
        let mut out = vec![];
        validate(v, &root, &root, "$", &mut out);
        out
    }

    #[test]
    fn schema_is_documented_and_current() {
        let text = serde_json::to_string_pretty(&schema()).unwrap() + "\n";
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/settings.schema.json");
        if std::env::var_os("ANNALO_WRITE_SCHEMA").is_some() {
            std::fs::write(path, &text).unwrap();
        }
        let stored = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            stored == text,
            "docs/settings.schema.json is out of date: run `ANNALO_WRITE_SCHEMA=1 cargo test -p annalo-core schema_is`"
        );
        // Every top-level setting is described.
        let s = schema();
        for (k, p) in s["properties"].as_object().unwrap() {
            assert!(p.get("description").is_some(), "{k} has no doc comment");
        }
    }

    #[test]
    fn defaults_and_fixtures_fit_the_schema() {
        assert_eq!(check(&serde_json::to_value(Settings::default()).unwrap()), Vec::<String>::new());
        for (name, json) in FIXTURES {
            let s = Database::parse_settings(json).unwrap();
            assert_eq!(check(&serde_json::to_value(&s).unwrap()), Vec::<String>::new(), "{name}");
            // The stored fixtures themselves are valid settings of their time.
            let raw: Value = serde_json::from_str(json).unwrap();
            assert_eq!(check(&raw), Vec::<String>::new(), "{name} raw");
        }
        // And wrong values are found.
        let bad = serde_json::json!({"theme": 3, "editor": {"tab_size": "vier"}, "workdays": ["Mo"]});
        assert_eq!(check(&bad).len(), 3, "{:?}", check(&bad));
    }
}
