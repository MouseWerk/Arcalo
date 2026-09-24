//! Notes linked to a Vorgang: the `vorgang:` / `netzplan:` page property, its budget
//! and the time booked on it.
//!
//! ```text
//! ---
//! vorgang: NP-8801/1020      (or `netzplan: NP-8801` plus `vorgang: 1020`, or just `netzplan: NP-8801`)
//! ---
//! ```

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::{Error, Result};
use crate::model::TimeEntry;
use crate::tracking::{self, AlertLevel, Thresholds};

/// Entries shown on a page's work card.
const RECENT: usize = 10;

/// Top-level `key: value` lines of a YAML frontmatter block.
fn frontmatter_lines(markdown: &str) -> Vec<&str> {
    let Some(rest) = markdown.strip_prefix("---\n").or_else(|| markdown.strip_prefix("---\r\n")) else { return vec![] };
    let Some(end) = rest.lines().position(|l| l.trim_end() == "---") else { return vec![] };
    rest.lines().take(end).collect()
}

/// A scalar frontmatter property (key case-insensitive), unquoted; `None` when missing or empty.
pub fn frontmatter_value(markdown: &str, key: &str) -> Option<String> {
    frontmatter_lines(markdown).into_iter().find_map(|line| {
        let (k, v) = line.split_once(':')?;
        if line.starts_with([' ', '\t']) || !k.trim().eq_ignore_ascii_case(key) {
            return None;
        }
        yaml_scalar(v).filter(|v| !v.is_empty())
    })
}

/// A plain or quoted YAML scalar without its inline comment, trimmed. `None` for values the
/// UI's property parser keeps as raw YAML (flow collections, anchors, block scalars, `a: b`).
fn yaml_scalar(v: &str) -> Option<String> {
    let v = v.trim();
    // Only a comment may follow a closing quote.
    let rest_ok = |rest: &str| {
        let trimmed = rest.trim_start();
        trimmed.is_empty() || (trimmed.starts_with('#') && trimmed.len() < rest.len())
    };
    if let Some(body) = v.strip_prefix('"') {
        let mut out = String::new();
        let mut chars = body.char_indices();
        while let Some((i, c)) = chars.next() {
            match c {
                '\\' => match chars.next()?.1 {
                    'n' => out.push('\n'),
                    't' => out.push('\t'),
                    c => out.push(c),
                },
                '"' => return rest_ok(&body[i + 1..]).then(|| out.trim().to_owned()),
                c => out.push(c),
            }
        }
        return None;
    }
    if let Some(body) = v.strip_prefix('\'') {
        let mut out = String::new();
        let mut chars = body.char_indices().peekable();
        while let Some((i, c)) = chars.next() {
            if c != '\'' {
                out.push(c);
            } else if chars.peek().is_some_and(|&(_, n)| n == '\'') {
                chars.next();
                out.push('\'');
            } else {
                return rest_ok(&body[i + 1..]).then(|| out.trim().to_owned());
            }
        }
        return None;
    }
    // Unquoted: a comment starts at `#` after whitespace (or at the very start).
    let end = v
        .char_indices()
        .find(|&(i, c)| c == '#' && (i == 0 || v[..i].ends_with([' ', '\t'])))
        .map_or(v.len(), |(i, _)| i);
    let v = v[..end].trim();
    if v.starts_with(['[', ']', '{', '}', '&', '*', '!', '|', '>', '%', '@', '`'])
        || v.contains(": ")
        || v.ends_with(':')
    {
        return None;
    }
    Some(v.to_owned())
}

/// The WBS reference a page is linked to: `NP-8801/1020` or `NP-8801`.
pub fn page_reference(markdown: &str) -> Option<String> {
    let vorgang = frontmatter_value(markdown, "vorgang");
    let netzplan = frontmatter_value(markdown, "netzplan");
    match (vorgang, netzplan) {
        (Some(v), _) if v.contains('/') => Some(v),
        (Some(v), Some(n)) => Some(format!("{n}/{v}")),
        (v, n) => n.or(v),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PageWork {
    /// As written on the page.
    pub reference: String,
    /// Canonical `NP-8801/1020` once resolved.
    pub label: String,
    pub netzplan_id: Option<i64>,
    pub netzplan: Option<String>,
    pub vorgang: Option<String>,
    /// Description of the Vorgang (or the Netzplan).
    pub title: String,
    pub planned_hours: f64,
    pub booked_hours: f64,
    pub etc_hours: f64,
    pub eac_hours: f64,
    pub consumed: f64,
    pub level: AlertLevel,
    /// Latest bookings on the reference, newest first.
    pub entries: Vec<TimeEntry>,
    /// Hours booked from this page (any reference).
    pub page_hours: f64,
    /// Why the reference could not be resolved.
    pub error: Option<String>,
}

impl PageWork {
    fn unresolved(reference: String, error: String, page_hours: f64) -> Self {
        PageWork {
            label: reference.clone(),
            reference,
            netzplan_id: None,
            netzplan: None,
            vorgang: None,
            title: String::new(),
            planned_hours: 0.0,
            booked_hours: 0.0,
            etc_hours: 0.0,
            eac_hours: 0.0,
            consumed: 0.0,
            level: AlertLevel::Ok,
            entries: vec![],
            page_hours,
            error: Some(error),
        }
    }
}

impl Database {
    /// The reference of a page's `vorgang:` / `netzplan:` property.
    pub fn page_reference(&self, page_id: i64) -> Result<Option<String>> {
        let content: String = self
            .conn()
            .query_row("SELECT content FROM pages WHERE id = ?1", [page_id], |r| r.get(0))
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Error::not_found("page", page_id.to_string()),
                e => Error::Db(e),
            })?;
        Ok(page_reference(&content))
    }
}

/// Budget and recent bookings of the Vorgang a page is linked to; `None` without a link.
pub fn page_work(db: &Database, page_id: i64, t: &Thresholds) -> Result<Option<PageWork>> {
    let Some(reference) = db.page_reference(page_id)? else { return Ok(None) };
    let page_hours = db.page_booked_hours(page_id)?;
    let (np_ref, v_ref) = match reference.split_once('/') {
        Some((n, v)) => (n.trim().to_owned(), Some(v.trim().to_owned()).filter(|v| !v.is_empty())),
        None => (reference.trim().to_owned(), None),
    };
    let v_ref = v_ref.as_deref();
    let np = match db.netzplan_by_ref(&np_ref) {
        Ok(np) => np,
        Err(Error::NotFound { .. }) => {
            return Ok(Some(PageWork::unresolved(
                reference,
                format!("Netzplan „{np_ref}“ nicht gefunden"),
                page_hours,
            )));
        }
        Err(e) => return Err(e),
    };
    let vorgaenge = db.list_vorgaenge(np.id)?;
    let vorgang = match v_ref {
        None => None,
        Some(v) => match vorgaenge.iter().find(|x| x.vorgang_nr.eq_ignore_ascii_case(v)) {
            Some(found) => Some(found),
            // A Netzplan without modelled Vorgänge accepts free activity codes (like `/zeit`).
            None if vorgaenge.is_empty() => None,
            None => {
                let msg = format!("Vorgang „{}/{v}“ nicht gefunden", np.netzplan_nr);
                return Ok(Some(PageWork::unresolved(reference, msg, page_hours)));
            }
        },
    };
    let vorgang_nr = vorgang.map(|v| v.vorgang_nr.clone()).or_else(|| v_ref.map(str::to_owned));
    let status = tracking::budget_status(db, np.id, t)?;
    let s = match &vorgang_nr {
        Some(v) => status.iter().find(|s| s.vorgang_nr.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(v))),
        None => status.first(),
    };
    // A free activity code on a Netzplan without Vorgänge has no plan of its own.
    let (planned, booked, etc, eac, consumed, level) = match s {
        Some(s) => (s.planned_hours, s.booked_hours, s.etc_hours, s.eac_hours, s.consumed, s.level),
        None => {
            let booked = db.booked_hours(np.id, vorgang_nr.as_deref())?;
            (0.0, booked, 0.0, booked, 0.0, AlertLevel::Ok)
        }
    };
    Ok(Some(PageWork {
        label: match &vorgang_nr {
            Some(v) => format!("{}/{v}", np.netzplan_nr),
            None => np.netzplan_nr.clone(),
        },
        reference,
        netzplan_id: Some(np.id),
        netzplan: Some(np.netzplan_nr.clone()),
        title: vorgang.map(|v| v.description.clone()).unwrap_or_else(|| np.description.clone()),
        entries: db.recent_entries(np.id, vorgang_nr.as_deref(), RECENT)?,
        vorgang: vorgang_nr,
        planned_hours: planned,
        booked_hours: booked,
        etc_hours: etc,
        eac_hours: eac,
        consumed,
        level,
        page_hours,
        error: None,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tracking::{SlashContext, log_slash_command_in};
    use chrono::{TimeZone, Utc};

    #[test]
    fn reference_from_frontmatter() {
        assert_eq!(page_reference("---\nvorgang: NP-8801/1020\n---\nText").as_deref(), Some("NP-8801/1020"));
        assert_eq!(page_reference("---\nnetzplan: NP-8801\nVorgang: '1020'\n---\n").as_deref(), Some("NP-8801/1020"));
        assert_eq!(page_reference("---\ntags: [a]\nnetzplan: \"NP-8801\"\n---\n").as_deref(), Some("NP-8801"));
        assert_eq!(page_reference("---\nvorgang:\n---\n"), None);
        // Only the frontmatter counts, and nested keys are not top-level properties.
        assert_eq!(page_reference("vorgang: NP-8801/1020\n"), None);
        assert_eq!(page_reference("---\nmeta:\n  vorgang: NP-1/1\n---\n"), None);
        assert_eq!(page_reference("---\ntitle: x\n---\nvorgang: NP-1\n"), None);
        // Inline comments are not part of the value.
        assert_eq!(page_reference("---\nvorgang: NP-8801/1020 # Integration\n---\n").as_deref(), Some("NP-8801/1020"));
        assert_eq!(page_reference("---\nvorgang: \"NP-8801/1020\"  # x\n---\n").as_deref(), Some("NP-8801/1020"));
        assert_eq!(page_reference("---\nvorgang: # nur Kommentar\n---\n"), None);
    }

    #[test]
    fn scalar_values_match_the_property_parser() {
        let v = |s: &str| yaml_scalar(s);
        assert_eq!(v(" plain text ").as_deref(), Some("plain text"));
        assert_eq!(v("a#b").as_deref(), Some("a#b"));
        assert_eq!(v("x # c").as_deref(), Some("x"));
        assert_eq!(v("\"a # b\"").as_deref(), Some("a # b"));
        assert_eq!(v("\"say \\\"hi\\\"\"").as_deref(), Some("say \"hi\""));
        assert_eq!(v("'it''s'").as_deref(), Some("it's"));
        assert_eq!(v("'a' # c").as_deref(), Some("a"));
        // Raw YAML on the UI side: no value here either.
        for raw in ["[a, b]", "{a: 1}", "|", ">", "&anchor x", "*ref", "!tag x", "a: b", "\"open", "'x' y", "@x"] {
            assert_eq!(v(raw), None, "{raw}");
        }
    }

    #[test]
    fn work_card_budget_entries_and_page_hours() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_project("PRJ", "Rollout").unwrap();
        let np = db.create_netzplan(p.id, "NP-8801", "NP-8801-1020", "Integration", 10.0).unwrap();
        db.create_vorgang(np.id, "1020", "Systemintegration", 3.0, 4.0).unwrap();
        let page = db.create_page(None, "Integration", None).unwrap();
        assert_eq!(page_work(&db, page.id, &Thresholds::default()).unwrap(), None);

        db.save_page_content(page.id, "---\nvorgang: np-8801/1020\n---\nNotizen").unwrap();
        let t = Thresholds::default();
        let now = Utc.with_ymd_and_hms(2026, 9, 23, 15, 0, 0).unwrap();
        let tz = chrono::FixedOffset::east_opt(7200).unwrap();
        let linked = db.page_reference(page.id).unwrap();
        let ctx = SlashContext { default_ref: linked.as_deref(), page_id: Some(page.id) };
        log_slash_command_in(&db, "/zeit 2h a @22.09. @08:00", now, &tz, &t, ctx).unwrap();
        log_slash_command_in(&db, "/zeit NP-8801/1020 1h b", now, &tz, &t, SlashContext::default()).unwrap();

        let w = page_work(&db, page.id, &t).unwrap().unwrap();
        assert_eq!((w.label.as_str(), w.title.as_str()), ("NP-8801/1020", "Systemintegration"));
        assert_eq!((w.planned_hours, w.booked_hours, w.etc_hours), (4.0, 3.0, 1.0));
        assert_eq!(w.level, AlertLevel::Warning, "75 % consumed");
        assert_eq!(w.entries.iter().map(|e| e.description.as_str()).collect::<Vec<_>>(), ["b", "a"]);
        assert_eq!(w.page_hours, 2.0);

        db.save_page_content(page.id, "---\nvorgang: NP-8801/9999\n---\n").unwrap();
        let w = page_work(&db, page.id, &t).unwrap().unwrap();
        assert!(w.error.unwrap().contains("nicht gefunden"));
        db.save_page_content(page.id, "---\nnetzplan: NP-8801\n---\n").unwrap();
        let w = page_work(&db, page.id, &t).unwrap().unwrap();
        assert_eq!((w.label.as_str(), w.planned_hours, w.booked_hours), ("NP-8801", 10.0, 3.0));
    }
}
