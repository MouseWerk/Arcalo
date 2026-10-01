//! The `Bookmarks` JSON file of Chromium browsers (Chrome, Edge, Brave, Vivaldi, Opera, Arc):
//! `{"roots": {"bookmark_bar": {…}, "other": {…}, "synced": {…}}}` with nodes of `type`
//! `folder` or `url`, and times in microseconds since 1601.

use serde_json::Value;

use super::{Collector, MAX_DEPTH, Node, Tree};

/// Seconds between 1601-01-01 (Windows/WebKit time) and 1970-01-01.
const WEBKIT_EPOCH_OFFSET: i64 = 11_644_473_600;

/// Unix seconds of a WebKit timestamp (microseconds since 1601, as a string or a number).
pub fn webkit_time(v: Option<&Value>) -> Option<i64> {
    let micros: i64 = match v? {
        Value::String(s) => s.trim().parse().ok()?,
        Value::Number(n) => n.as_i64()?,
        _ => return None,
    };
    (micros > 0).then(|| micros / 1_000_000 - WEBKIT_EPOCH_OFFSET).filter(|t| *t > 0)
}

/// Top folders in the order the browsers show them, with their role.
const ROOTS: [(&str, &str); 3] = [("bookmark_bar", "bar"), ("other", "other"), ("synced", "mobile")];

pub fn parse(json: &str) -> crate::Result<Tree> {
    let v: Value = serde_json::from_str(json.trim_start_matches('\u{feff}'))?;
    let Some(roots) = v.get("roots").and_then(Value::as_object) else {
        return Err(crate::Error::Parse(
            crate::tr!(
                "Keine Chromium-Lesezeichendatei („roots“ fehlt)",
                "Not a Chromium bookmarks file (“roots” is missing)"
            )
            .into(),
        ));
    };
    let mut c = Collector::default();
    let mut out = Vec::new();
    for (key, role) in ROOTS {
        if let Some(node) = roots.get(key) {
            out.extend(folder(&mut c, node, Some(role), 0));
        }
    }
    // Other roots some browsers add (Edge's workspaces, …), by name.
    for (key, node) in roots {
        if !ROOTS.iter().any(|(k, _)| k == key) && node.is_object() {
            out.extend(folder(&mut c, node, None, 0));
        }
    }
    Ok(c.finish(out))
}

fn folder(c: &mut Collector, v: &Value, role: Option<&str>, depth: usize) -> Option<Node> {
    if depth > MAX_DEPTH {
        return None;
    }
    let title = v.get("name").and_then(Value::as_str).unwrap_or_default();
    let mut f = Node::folder(title.trim(), role);
    f.added = webkit_time(v.get("date_added"));
    for child in v.get("children").and_then(Value::as_array).into_iter().flatten() {
        match child.get("type").and_then(Value::as_str) {
            Some("folder") => f.children.extend(folder(c, child, None, depth + 1)),
            Some("url") => {
                let url = child.get("url").and_then(Value::as_str).unwrap_or_default();
                let name = child.get("name").and_then(Value::as_str).unwrap_or_default();
                f.children.extend(c.link(name, url, webkit_time(child.get("date_added"))));
            }
            _ => {}
        }
    }
    Some(f)
}

/// Display names of a user data folder's profiles from its `Local State`
/// (`profile.info_cache.<folder>.name`).
pub fn profile_names(local_state: &str) -> std::collections::HashMap<String, String> {
    let v: Value = serde_json::from_str(local_state).unwrap_or(Value::Null);
    v.pointer("/profile/info_cache")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(dir, info)| {
                    let name = info.get("name").and_then(Value::as_str)?.trim();
                    (!name.is_empty()).then(|| (dir.clone(), name.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webkit_times_are_unix_seconds() {
        // 2024-01-01T00:00:00Z
        let v = Value::String("13348540800000000".into());
        assert_eq!(webkit_time(Some(&v)), Some(1_704_067_200));
        assert_eq!(webkit_time(Some(&Value::String("0".into()))), None);
        assert_eq!(webkit_time(None), None);
    }

    #[test]
    fn profile_names_come_from_local_state() {
        let names = profile_names(
            r#"{"profile":{"info_cache":{"Default":{"name":"Arbeit"},"Profile 1":{"name":"Privat"},"Profile 2":{}}}}"#,
        );
        assert_eq!(names.get("Default").map(String::as_str), Some("Arbeit"));
        assert_eq!(names.get("Profile 1").map(String::as_str), Some("Privat"));
        assert!(!names.contains_key("Profile 2"));
        assert!(profile_names("kaputt").is_empty());
    }
}
