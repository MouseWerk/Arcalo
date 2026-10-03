//! Graph view (1.9): pages as nodes, `[[links]]` and `![[embeds]]` as edges, from the link index
//! (`page_links`, one row per page and lower-cased target title) in one call. The filters of the
//! view that narrow the pages (tag, folder subtree, Netzplan, Jira project, created/modified
//! range, daily notes) run in SQL; `graph_patch` answers the same question for a few pages
//! after a save or rename, so the view updates without loading the whole graph again.
//!
//! Left out: deleted pages, folders of the filing, pages below the templates folder and pure
//! folders (no text, only children, and nothing links to them). A link to a page outside the result is no edge; a link to
//! no page at all is an unresolved link (a ghost node in the view), a link to a file
//! (`[[Angebot.pdf]]`, `![[bild.png]]`) an attachment edge.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;

/// Which date the date range of [`GraphFilter`] looks at.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphDateField {
    Created,
    #[default]
    Modified,
}

/// The filters of the graph view that narrow its pages. Empty fields do not filter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct GraphFilter {
    /// Pages with any of these tags (a tag also matches its subtags: `projekt` → `projekt/x`).
    pub tags: Vec<String>,
    /// Only this page and the pages below it in the tree.
    pub folder: Option<i64>,
    /// A Netzplan number (from `vorgang:`/`netzplan:` in the frontmatter or a booking).
    pub netzplan: Option<String>,
    /// A Jira project key (`ABC` for a page with `jira: ABC-12`).
    pub jira_project: Option<String>,
    pub date_field: GraphDateField,
    /// `YYYY-MM-DD`, inclusive.
    pub from: Option<String>,
    pub to: Option<String>,
    /// Daily notes on or off.
    pub daily: bool,
    /// File nodes for attachments (embeds and file links).
    pub attachments: bool,
}

impl Default for GraphFilter {
    fn default() -> Self {
        Self {
            tags: vec![],
            folder: None,
            netzplan: None,
            jira_project: None,
            date_field: GraphDateField::Modified,
            from: None,
            to: None,
            daily: true,
            attachments: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: i64,
    pub title: String,
    pub icon: Option<String>,
    pub parent_id: Option<i64>,
    /// Titles of the folders above the page, `Projekte/Kunde X` (empty at the top level).
    pub folder: String,
    pub tags: Vec<String>,
    pub netzplan: Vec<String>,
    /// The `jira:` issue key of an issue note.
    pub jira: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub daily: bool,
    /// Pages linking here and links going out, across the whole workspace.
    pub links_in: u32,
    pub links_out: u32,
}

/// A link (or page embed) from one page to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphLink {
    pub from: i64,
    pub to: i64,
}

/// A link to a page that does not exist; `key` is the lower-cased title, `title` as written.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphGhost {
    pub from: i64,
    pub key: String,
    pub title: String,
}

/// An attachment a page embeds or links.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphFile {
    pub from: i64,
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub links: Vec<GraphLink>,
    pub unresolved: Vec<GraphGhost>,
    pub files: Vec<GraphFile>,
    /// `graph_patch` only: asked-for pages that are gone or no longer match the filter.
    pub removed: Vec<i64>,
}

/// Which pages a query covers: all that match, or the matching ones among some.
enum Scope<'a> {
    All,
    Only(&'a [i64]),
}

fn id_list(ids: &[i64]) -> String {
    ids.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
}

impl Database {
    /// The graph of the workspace under `filter`: nodes, links between them, unresolved links
    /// and (when asked for) attachments.
    pub fn graph_data(&self, filter: &GraphFilter) -> Result<GraphData> {
        self.graph_query(filter, Scope::All)
    }

    /// The part of the graph that changed when `ids` were saved, renamed, moved or deleted:
    /// those pages and the pages linking to their (current) titles, each with all its outgoing
    /// links. The view replaces the outgoing links of every returned node and drops the
    /// `removed` ones; the caller adds the pages that linked to an old title.
    pub fn graph_patch(&self, ids: &[i64], filter: &GraphFilter) -> Result<GraphData> {
        let mut affected: Vec<i64> = ids.to_vec();
        {
            let mut title =
                self.conn().prepare_cached("SELECT title FROM pages WHERE id = ?1 AND deleted_at IS NULL")?;
            let mut linking = self.conn().prepare_cached("SELECT from_page FROM page_links WHERE target = ?1")?;
            for id in ids {
                let Some(t) = title.query_row([id], |r| r.get::<_, String>(0)).ok() else { continue };
                for from in linking.query_map([t.to_lowercase()], |r| r.get::<_, i64>(0))? {
                    affected.push(from?);
                }
            }
        }
        affected.sort_unstable();
        affected.dedup();
        let mut data = self.graph_query(filter, Scope::Only(&affected))?;
        let present: HashSet<i64> = data.nodes.iter().map(|n| n.id).collect();
        data.removed = affected.into_iter().filter(|id| !present.contains(id)).collect();
        Ok(data)
    }

    fn graph_query(&self, f: &GraphFilter, scope: Scope) -> Result<GraphData> {
        let conn = self.conn();
        // Every live page with its parent and title: folder paths and title lookups.
        let mut all: HashMap<i64, (Option<i64>, String)> = HashMap::new();
        {
            let mut st = conn.prepare("SELECT id, parent_id, title FROM pages WHERE deleted_at IS NULL")?;
            for row in
                st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?)))?
            {
                let (id, parent, title) = row?;
                all.insert(id, (parent, title));
            }
        }

        let mut conds: Vec<String> = vec![];
        let mut args: Vec<String> = vec![];
        let mut arg = |v: String| {
            args.push(v);
            format!("?{}", args.len())
        };
        if !f.tags.is_empty() {
            let mut any = vec![];
            for tag in &f.tags {
                let tag = tag.trim().trim_start_matches('#').to_lowercase();
                if tag.is_empty() {
                    continue;
                }
                let a = arg(tag.clone());
                let b = arg(format!("{tag}/%"));
                any.push(format!("t.tag = {a} OR t.tag LIKE {b}"));
            }
            if !any.is_empty() {
                conds.push(format!(
                    "EXISTS (SELECT 1 FROM page_tags t WHERE t.page_id = p.id AND ({}))",
                    any.join(" OR ")
                ));
            }
        }
        if let Some(folder) = f.folder {
            conds.push(format!(
                "p.id IN (WITH RECURSIVE sub(id) AS (SELECT {folder} UNION ALL
                   SELECT c.id FROM pages c JOIN sub ON c.parent_id = sub.id WHERE c.deleted_at IS NULL) SELECT id FROM sub)"
            ));
        }
        if let Some(nr) = f.netzplan.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let a = arg(nr.to_owned());
            conds.push(format!(
                "p.id IN ({} SELECT id FROM np WHERE nr = {a} COLLATE NOCASE)",
                crate::filing::NETZPLAN_CTE
            ));
        }
        if let Some(proj) = f.jira_project.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            let a = arg(proj.to_owned());
            conds.push(format!("p.id IN ({} SELECT id FROM jp WHERE proj = upper({a}))", crate::filing::JIRA_CTE));
        }
        let col = match f.date_field {
            GraphDateField::Created => "p.created_at",
            GraphDateField::Modified => "p.updated_at",
        };
        if let Some(from) = f.from.as_deref().filter(|s| !s.is_empty()) {
            let a = arg(from.to_owned());
            conds.push(format!("substr({col}, 1, 10) >= {a}"));
        }
        if let Some(to) = f.to.as_deref().filter(|s| !s.is_empty()) {
            let a = arg(to.to_owned());
            conds.push(format!("substr({col}, 1, 10) <= {a}"));
        }
        if !f.daily {
            conds.push("p.daily_date IS NULL".into());
        }
        if let Scope::Only(ids) = scope {
            conds.push(format!("p.id IN ({})", id_list(ids)));
        }
        let tpl = crate::templates::TEMPLATES_TITLE;
        let tpl_en = crate::templates::TEMPLATES_TITLE_EN;
        let sql = format!(
            "WITH RECURSIVE tpl(id) AS (
                SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL
                   AND title IN ('{tpl}' COLLATE NOCASE, '{tpl_en}' COLLATE NOCASE)
                UNION ALL SELECT c.id FROM pages c JOIN tpl ON c.parent_id = tpl.id
             )
             SELECT p.id, p.parent_id, p.title, p.icon, p.created_at, p.updated_at, p.daily_date IS NOT NULL,
                    (SELECT COUNT(*) FROM page_links l WHERE l.from_page = p.id)
               FROM pages p
              WHERE p.deleted_at IS NULL AND p.system_folder IS NULL AND p.id NOT IN (SELECT id FROM tpl)
                AND NOT (p.content = '' AND EXISTS (SELECT 1 FROM pages c WHERE c.parent_id = p.id AND c.deleted_at IS NULL)
                         AND NOT EXISTS (SELECT 1 FROM page_links l WHERE l.target = lower(p.title)))
                {}
              ORDER BY p.id",
            conds.iter().map(|c| format!("AND ({c})")).collect::<String>()
        );
        let mut nodes: Vec<GraphNode> = {
            let mut st = conn.prepare(&sql)?;
            let rows = st.query_map(rusqlite::params_from_iter(args.iter()), |r| {
                Ok(GraphNode {
                    id: r.get(0)?,
                    parent_id: r.get(1)?,
                    title: r.get(2)?,
                    icon: r.get(3)?,
                    created_at: r.get(4)?,
                    updated_at: r.get(5)?,
                    daily: r.get(6)?,
                    links_out: r.get::<_, i64>(7)? as u32,
                    folder: String::new(),
                    tags: vec![],
                    netzplan: vec![],
                    jira: None,
                    links_in: 0,
                })
            })?;
            rows.collect::<rusqlite::Result<_>>()?
        };
        let included: HashSet<i64> = nodes.iter().map(|n| n.id).collect();
        let in_scope = match scope {
            Scope::All => String::new(),
            Scope::Only(ids) => format!("WHERE {{col}} IN ({})", id_list(ids)),
        };
        let scoped = |col: &str| in_scope.replace("{col}", col);

        // Tags, Netzplans and Jira keys of the pages, one query each.
        let mut tags: HashMap<i64, Vec<String>> = HashMap::new();
        for row in conn
            .prepare(&format!("SELECT page_id, tag FROM page_tags {} ORDER BY tag", scoped("page_id")))?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, tag) = row?;
            tags.entry(id).or_default().push(tag);
        }
        let mut netzplan: HashMap<i64, Vec<String>> = HashMap::new();
        for row in conn
            .prepare(&format!(
                "{} SELECT DISTINCT id, upper(nr) FROM np {} ORDER BY 2",
                crate::filing::NETZPLAN_CTE,
                scoped("id")
            ))?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, nr) = row?;
            if !nr.is_empty() {
                netzplan.entry(id).or_default().push(nr);
            }
        }
        let mut jira: HashMap<i64, String> = HashMap::new();
        for row in conn
            .prepare(&format!("{} SELECT id, k FROM j {}", crate::filing::JIRA_CTE, scoped("id")))?
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        {
            let (id, k) = row?;
            let key = k.lines().next().unwrap_or("").trim().trim_matches(['"', '\'']).trim().to_uppercase();
            if !key.is_empty() {
                jira.insert(id, key);
            }
        }

        // Pages linking to each title (Rust's lower-casing like the targets): per node for a
        // patch of a few pages, else from one read of the links instead of one query per node.
        if let Scope::Only(_) = scope {
            let mut st = conn.prepare_cached(
                "SELECT COUNT(DISTINCT l.from_page) FROM page_links l JOIN pages s ON s.id = l.from_page AND s.deleted_at IS NULL
                  WHERE l.target = ?1 AND l.from_page <> ?2",
            )?;
            for n in &mut nodes {
                n.links_in =
                    st.query_row(rusqlite::params![n.title.to_lowercase(), n.id], |r| r.get::<_, i64>(0))? as u32;
            }
        } else {
            let mut from: HashMap<String, HashSet<i64>> = HashMap::new();
            let mut st = conn.prepare_cached(
                "SELECT l.target, l.from_page FROM page_links l
                  WHERE l.from_page NOT IN (SELECT id FROM pages WHERE deleted_at IS NOT NULL)",
            )?;
            for row in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
                let (target, page) = row?;
                from.entry(target).or_default().insert(page);
            }
            for n in &mut nodes {
                n.links_in = from
                    .get(&n.title.to_lowercase())
                    .map_or(0, |set| set.len() - usize::from(set.contains(&n.id))) as u32;
            }
        }
        for n in &mut nodes {
            n.folder = folder_path(&all, n.parent_id);
            n.tags = tags.remove(&n.id).unwrap_or_default();
            n.netzplan = netzplan.remove(&n.id).unwrap_or_default();
            n.jira = jira.remove(&n.id);
        }

        // Edges from the included pages. The target is found by its title through the
        // NOCASE title index; a title beyond ASCII is matched like the index (Rust lower case).
        let by_lower: HashMap<String, i64> = {
            let mut m: HashMap<String, i64> = HashMap::new();
            for (id, (_, title)) in &all {
                m.entry(title.to_lowercase()).and_modify(|e| *e = (*e).min(*id)).or_insert(*id);
            }
            m
        };
        let mut links = vec![];
        let mut unresolved = vec![];
        let mut files = vec![];
        let mut ghost_sources: HashSet<i64> = HashSet::new();
        {
            let mut st = conn.prepare(&format!(
                "SELECT l.from_page, l.target,
                        (SELECT MIN(t.id) FROM pages t WHERE t.title = l.target COLLATE NOCASE AND t.deleted_at IS NULL)
                   FROM page_links l {} ORDER BY l.from_page, l.target",
                scoped("l.from_page")
            ))?;
            let rows =
                st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?)))?;
            for row in rows {
                let (from, target, to) = row?;
                if !included.contains(&from) {
                    continue;
                }
                match to.or_else(|| by_lower.get(&target).copied()) {
                    Some(to) if to == from => {}
                    // A page outside the scope of a patch may still be in the view.
                    Some(to) if included.contains(&to) || matches!(scope, Scope::Only(_)) => {
                        links.push(GraphLink { from, to })
                    }
                    Some(_) => {}
                    None if crate::attachment_manager::is_file_link(&target) => {
                        if f.attachments {
                            let name = target.rsplit(['/', '\\']).next().unwrap_or(&target).to_owned();
                            files.push(GraphFile { from, name });
                        }
                    }
                    None => {
                        ghost_sources.insert(from);
                        unresolved.push(GraphGhost { from, title: target.clone(), key: target });
                    }
                }
            }
        }
        // Unresolved links keep the spelling of their note (the index has it lower-cased).
        if !ghost_sources.is_empty() {
            let mut st = conn.prepare_cached("SELECT content FROM pages WHERE id = ?1")?;
            let mut spelled: HashMap<i64, HashMap<String, String>> = HashMap::new();
            for id in &ghost_sources {
                let content: String = st.query_row([id], |r| r.get(0))?;
                let m = crate::notes::wiki_links(&content).into_iter().map(|t| (t.to_lowercase(), t)).collect();
                spelled.insert(*id, m);
            }
            for g in &mut unresolved {
                if let Some(t) = spelled.get(&g.from).and_then(|m| m.get(&g.key)) {
                    g.title = t.clone();
                }
            }
        }
        if f.attachments {
            let mut st = conn.prepare(&format!(
                "SELECT id, content FROM pages p {} {} (instr(content, '![[') > 0 OR instr(content, '](') > 0)",
                scoped("p.id"),
                if in_scope.is_empty() { "WHERE" } else { "AND" }
            ))?;
            for row in st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
                let (from, content) = row?;
                if !included.contains(&from) {
                    continue;
                }
                for name in crate::attachment_manager::referenced_files(&content) {
                    if !files.iter().any(|x: &GraphFile| x.from == from && x.name.eq_ignore_ascii_case(&name)) {
                        files.push(GraphFile { from, name });
                    }
                }
            }
        }
        Ok(GraphData { nodes, links, unresolved, files, removed: vec![] })
    }

    /// A stored part of the graph view's state (`layout`, `presets`, `view`), per workspace.
    pub fn graph_state(&self, key: &str) -> Result<Option<serde_json::Value>> {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = self
            .conn()
            .query_row("SELECT value FROM settings WHERE key = ?1", [format!("graph.{}", state_key(key)?)], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
    }

    pub fn set_graph_state(&self, key: &str, value: &serde_json::Value) -> Result<()> {
        self.conn().execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![format!("graph.{}", state_key(key)?), serde_json::to_string(value)?],
        )?;
        Ok(())
    }
}

fn state_key(key: &str) -> Result<&str> {
    match key {
        "layout" | "presets" | "view" => Ok(key),
        _ => Err(crate::error::Error::State(format!("unknown graph state {key}"))),
    }
}

/// `Projekte/Kunde X`: the titles of the folders above a page.
fn folder_path(all: &HashMap<i64, (Option<i64>, String)>, mut parent: Option<i64>) -> String {
    let mut parts: Vec<&str> = vec![];
    while let Some(p) = parent {
        let Some((up, title)) = all.get(&p) else { break };
        parts.push(title);
        parent = *up;
        if parts.len() > 64 {
            break;
        }
    }
    parts.reverse();
    parts.join("/")
}

#[cfg(test)]
mod tests;
