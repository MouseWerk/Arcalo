//! Which content is private, for every AI entry point.
//!
//! A page is private when one of the router's privacy markers (`#privat`, `#vertraulich`, …)
//! is among its tags (front matter `tags:` included) or anywhere in its text. The router only
//! sees text: every request therefore carries, next to a page's content, its tags as `#tag`
//! ([`page_context`]), and a tool result that contains text of a private page carries a marker
//! ([`mark_tool_result`]), so the conversation that follows stays on the local model.
//! Settings → Datenschutz „Nur lokal“ keeps everything local anyway.

use std::collections::HashSet;

use crate::db::Database;
use crate::error::Result;

/// The markers, lower-cased, without empty ones.
pub fn normalize(markers: &[String]) -> Vec<String> {
    markers.iter().map(|m| m.trim().to_lowercase()).filter(|m| !m.is_empty() && m != "#").collect()
}

/// Whether `text` contains one of the (normalized) markers.
fn has_marker(text: &str, markers: &[String]) -> bool {
    let lower = text.to_lowercase();
    markers.iter().any(|m| lower.contains(m.as_str()))
}

/// Whether page `id` is private (see the module docs). Unknown pages are not.
pub fn page_is_private(db: &Database, id: i64, markers: &[String]) -> Result<bool> {
    let markers = normalize(markers);
    if markers.is_empty() {
        return Ok(false);
    }
    let tags: Vec<String> = db.page_tags(id)?.into_iter().map(|t| format!("#{}", t.to_lowercase())).collect();
    if tags.iter().any(|t| markers.iter().any(|m| t == m || t.trim_start_matches('#') == m.as_str())) {
        return Ok(true);
    }
    let content: Option<String> = db
        .conn()
        .query_row("SELECT content FROM pages WHERE id = ?1", [id], |r| r.get(0))
        .map(Some)
        .or_else(|e| if matches!(e, rusqlite::Error::QueryReturnedNoRows) { Ok(None) } else { Err(e) })?;
    Ok(content.is_some_and(|c| has_marker(&c, &markers)))
}

/// The private ones among `ids`.
pub fn private_pages(db: &Database, ids: impl IntoIterator<Item = i64>, markers: &[String]) -> Result<HashSet<i64>> {
    let mut out = HashSet::new();
    for id in ids {
        if !out.contains(&id) && page_is_private(db, id, markers)? {
            out.insert(id);
        }
    }
    Ok(out)
}

/// What the router has to see of page `id` when its text goes into a request: the content
/// and the tags as `#tag` (front matter tags are not in the text as `#tag`).
pub fn page_context(db: &Database, id: i64) -> Result<Vec<String>> {
    let doc = db.page_doc(id)?;
    Ok(vec![doc.content, tag_text(&doc.tags)])
}

/// `#a #b` for the router.
pub fn tag_text(tags: &[String]) -> String {
    tags.iter().map(|t| format!("#{t}")).collect::<Vec<_>>().join(" ")
}

/// A tool result with text of private pages gets the first marker appended, so the router
/// keeps the conversation that carries it on the local model.
pub fn mark_tool_result(out: String, has_private: bool, markers: &[String]) -> String {
    match normalize(markers).first() {
        Some(m) if has_private => format!("{out}\n\n[Enthält vertrauliche Inhalte: {m}]"),
        _ => out,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::router::{ModelRouter, RouteInput, RouterConfig, Tier};

    fn markers() -> Vec<String> {
        RouterConfig::default().private_markers
    }

    #[test]
    fn front_matter_tags_inline_tags_and_text_markers_count() {
        let db = Database::open_in_memory().unwrap();
        let fm = db.create_page(None, "Gehalt", None).unwrap();
        db.save_page_content(fm.id, "---\ntags: [privat]\n---\nMein Gehalt ist 5000 EUR.").unwrap();
        let inline = db.create_page(None, "Diagnose", None).unwrap();
        db.save_page_content(inline.id, "#vertraulich\n\nBefund").unwrap();
        let custom = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(custom.id, "Dies ist nur lokal zu lesen.").unwrap();
        let open = db.create_page(None, "Offen", None).unwrap();
        db.save_page_content(open.id, "Nichts Geheimes").unwrap();
        let m = markers();
        assert!(page_is_private(&db, fm.id, &m).unwrap());
        assert!(page_is_private(&db, inline.id, &m).unwrap());
        assert!(!page_is_private(&db, custom.id, &m).unwrap());
        assert!(page_is_private(&db, custom.id, &["nur lokal".into()]).unwrap());
        assert!(!page_is_private(&db, open.id, &m).unwrap());
        assert!(!page_is_private(&db, 999, &m).unwrap());
        assert_eq!(private_pages(&db, [fm.id, open.id, inline.id], &m).unwrap().len(), 2);

        // The open page's context routes a front-matter-private page to the local model.
        let router = ModelRouter::new(RouterConfig::default());
        let ctx = page_context(&db, fm.id).unwrap();
        let d = router.route(&RouteInput {
            prompt: "Was steht auf der offenen Seite?",
            context: &ctx,
            uses_tools: false,
            force: Some(Tier::Standard),
        });
        assert_eq!(d.tier, Tier::Local);
    }

    #[test]
    fn embeddings_skip_every_block_of_a_private_page() {
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Notiz", None).unwrap();
        db.save_page_content(p.id, "## Eins\n\nErster Absatz\n\n## Zwei\n\nNur lokal lesen").unwrap();
        let q = db.create_page(None, "Frei", None).unwrap();
        db.save_page_content(q.id, "Öffentlich").unwrap();
        let public = crate::ai::rag::pending_public_blocks(&db, 50, &["nur lokal".into()]).unwrap();
        assert!(public.iter().all(|(_, t)| !t.contains("Absatz") && !t.contains("lesen")), "{public:?}");
        assert!(public.iter().any(|(_, t)| t.contains("Öffentlich")));
    }

    #[test]
    fn marked_tool_results_route_locally() {
        // The search tool's snippet of a #privat page does not contain the marker itself.
        let db = Database::open_in_memory().unwrap();
        let p = db.create_page(None, "Diagnose", None).unwrap();
        db.save_page_content(p.id, "#privat\n\n## Befund\n\nArzttermin Kardiologie Befund unauffällig").unwrap();
        let hits = crate::search::search(&db, "Kardiologie", 10).unwrap();
        let ids = hits.iter().filter_map(|h| match h {
            crate::search::SearchHit::Page { page_id, .. } | crate::search::SearchHit::Note { page_id, .. } => {
                Some(*page_id)
            }
            _ => None,
        });
        let private = private_pages(&db, ids, &markers()).unwrap();
        assert!(private.contains(&p.id));
        let router = ModelRouter::new(RouterConfig::default());
        let json = serde_json::to_string(&hits).unwrap();
        let out = mark_tool_result(json, !private.is_empty(), &markers());
        let d = router.route(&RouteInput {
            prompt: "Wann war mein Termin?",
            context: &[out],
            uses_tools: true,
            force: Some(Tier::Standard),
        });
        assert_eq!(d.tier, Tier::Local);
        assert_eq!(mark_tool_result("x".into(), false, &markers()), "x");
    }
}
