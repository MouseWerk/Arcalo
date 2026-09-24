//! Templates: pages below the top-level page „Vorlagen“. Placeholders like
//! `{{datum}}` are filled in when a template is inserted or a page is created from it.

use std::collections::HashSet;

use chrono::{Datelike, NaiveDate, NaiveTime, Timelike};
use rusqlite::OptionalExtension;

use crate::db::Database;
use crate::error::{Error, Result};
use crate::model::{Page, PageNode};

/// Parent page that holds the templates.
pub const TEMPLATES_TITLE: &str = "Vorlagen";

/// Values for the placeholders of a template.
#[derive(Debug, Clone, PartialEq)]
pub struct TemplateVars {
    pub date: NaiveDate,
    pub time: NaiveTime,
    pub title: String,
}

const WEEKDAYS: [&str; 7] = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

fn value(key: &str, v: &TemplateVars) -> Option<String> {
    Some(match key.to_lowercase().as_str() {
        "datum" => v.date.format("%d.%m.%Y").to_string(),
        "date" => v.date.format("%Y-%m-%d").to_string(),
        "zeit" | "time" => format!("{:02}:{:02}", v.time.hour(), v.time.minute()),
        "titel" | "title" => v.title.clone(),
        "wochentag" | "weekday" => WEEKDAYS[v.date.weekday().num_days_from_monday() as usize].to_owned(),
        "kw" | "week" => v.date.iso_week().week().to_string(),
        _ => return None,
    })
}

/// Replaces `{{datum}}` (dd.mm.yyyy), `{{date}}` (yyyy-mm-dd), `{{zeit}}` (HH:MM),
/// `{{titel}}`, `{{wochentag}}` and `{{kw}}` (ISO week). Case and inner spaces
/// are ignored; unknown placeholders stay as they are.
pub fn apply_template(content: &str, vars: &TemplateVars) -> String {
    let mut out = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        // A stray `{{` (unclosed, or followed by another `{{` before its `}}`) stays literal,
        // so it cannot swallow a real placeholder behind it.
        let Some(end) = after.find("}}").filter(|&e| !after[..e].contains('\n') && !after[..e].contains("{{")) else {
            out.push_str("{{");
            rest = after;
            continue;
        };
        match value(after[..end].trim(), vars) {
            Some(v) => out.push_str(&v),
            None => out.push_str(&rest[start..start + 2 + end + 2]),
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    out
}

impl Database {
    fn find_templates_root(&self) -> Result<Option<Page>> {
        Ok(self
            .conn()
            .query_row(
                &format!(
                    "SELECT {} FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
                    crate::db::PAGE_COLS
                ),
                [TEMPLATES_TITLE],
                crate::db::map_page,
            )
            .optional()?)
    }

    /// The top-level „Vorlagen“ page, created on first use.
    pub fn templates_root(&self) -> Result<Page> {
        match self.find_templates_root()? {
            Some(p) => Ok(p),
            None => self.create_page(None, TEMPLATES_TITLE, Some("layout-template")),
        }
    }

    /// All pages below „Vorlagen“ (nested ones included), in tree order. Creates nothing.
    pub fn list_templates(&self) -> Result<Vec<Page>> {
        let Some(root) = self.find_templates_root()? else { return Ok(vec![]) };
        fn walk(nodes: &[PageNode], out: &mut Vec<Page>) {
            for n in nodes {
                out.push(n.page.clone());
                walk(&n.children, out);
            }
        }
        let mut out = vec![];
        if let Some(node) = self.page_tree()?.into_iter().find(|n| n.page.id == root.id) {
            walk(&node.children, &mut out);
        }
        Ok(out)
    }

    /// IDs of „Vorlagen“ itself and every live page below it. Creates nothing.
    pub fn template_page_ids(&self) -> Result<HashSet<i64>> {
        let Some(root) = self.find_templates_root()? else { return Ok(HashSet::new()) };
        let mut ids: HashSet<i64> = self.list_templates()?.into_iter().map(|p| p.id).collect();
        ids.insert(root.id);
        Ok(ids)
    }

    /// Whether `id` is a live page below „Vorlagen“.
    pub fn is_template(&self, id: i64) -> Result<bool> {
        Ok(self.list_templates()?.iter().any(|p| p.id == id))
    }

    /// Content of template page `id` with its placeholders filled in. Only pages listed by
    /// [`Database::list_templates`] qualify (not trashed ones, not arbitrary pages).
    /// Frontmatter of the template is dropped: it describes the template, not the new page.
    pub fn render_template(&self, id: i64, vars: &TemplateVars) -> Result<String> {
        if !self.is_template(id)? {
            return Err(Error::State("Diese Seite ist keine Vorlage (mehr)".into()));
        }
        let content = self.page_doc(id)?.content;
        Ok(apply_template(strip_frontmatter(&content), vars))
    }
}

fn strip_frontmatter(md: &str) -> &str {
    let Some(rest) = md.strip_prefix("---\n") else { return md };
    let first_is_key = rest.lines().next().is_some_and(|l| l.split_once(':').is_some_and(|(k, _)| !k.contains(' ')));
    match rest.find("\n---") {
        Some(end) if first_is_key => rest[end + 4..].trim_start_matches('\n'),
        _ => md,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars() -> TemplateVars {
        TemplateVars {
            date: NaiveDate::from_ymd_opt(2026, 9, 23).unwrap(),
            time: NaiveTime::from_hms_opt(9, 5, 0).unwrap(),
            title: "Jour fixe".into(),
        }
    }

    #[test]
    fn fills_all_placeholders() {
        let t = "# {{titel}}\n{{wochentag}}, {{datum}} ({{date}}) um {{zeit}}, KW {{kw}}";
        assert_eq!(apply_template(t, &vars()), "# Jour fixe\nMittwoch, 23.09.2026 (2026-09-23) um 09:05, KW 39");
    }

    #[test]
    fn tolerates_case_spaces_and_unknowns() {
        assert_eq!(apply_template("{{ Datum }} {{foo}} {{ offen", &vars()), "23.09.2026 {{foo}} {{ offen");
        assert_eq!(apply_template("{{\n}} {{kw}}", &vars()), "{{\n}} 39");
        assert_eq!(apply_template("ohne", &vars()), "ohne");
        assert_eq!(apply_template("a {{ b {{kw}} c", &vars()), "a {{ b 39 c", "stray braces keep the placeholder");
        assert_eq!(apply_template("{{{{kw}}}}", &vars()), "{{39}}");
        // ISO week: 1 Jan 2027 is a Friday in week 53 of 2026.
        let v = TemplateVars { date: NaiveDate::from_ymd_opt(2027, 1, 1).unwrap(), ..vars() };
        assert_eq!(apply_template("{{kw}} {{wochentag}}", &v), "53 Freitag");
    }

    #[test]
    fn templates_live_below_vorlagen() {
        let db = Database::open_in_memory().unwrap();
        assert!(db.list_templates().unwrap().is_empty());
        assert!(db.page_by_title(TEMPLATES_TITLE).unwrap().is_none(), "listing creates nothing");
        let root = db.templates_root().unwrap();
        assert_eq!(db.templates_root().unwrap().id, root.id, "created once");
        let t = db.create_page(Some(root.id), "Besprechung", None).unwrap();
        db.create_page(Some(t.id), "Variante", None).unwrap();
        db.create_page(None, "Andere", None).unwrap();
        let titles: Vec<_> = db.list_templates().unwrap().into_iter().map(|p| p.title).collect();
        assert_eq!(titles, ["Besprechung", "Variante"]);
        db.save_page_content(t.id, "---\ntags: [vorlage]\n---\n# {{titel}} am {{datum}}\n").unwrap();
        assert_eq!(db.render_template(t.id, &vars()).unwrap(), "# Jour fixe am 23.09.2026\n");
        let other = db.page_by_title("Andere").unwrap().unwrap();
        assert!(db.render_template(other.id, &vars()).is_err(), "not a template");
        assert!(db.render_template(root.id, &vars()).is_err(), "the root itself is no template");
        db.trash_page(t.id).unwrap();
        assert!(db.render_template(t.id, &vars()).is_err(), "trashed template");
    }
}
