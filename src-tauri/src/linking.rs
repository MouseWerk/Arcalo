//! Link and tag suggestions, duplicate hints and PDF highlights (`arcalo_core::mentions`,
//! `tagsuggest`, `duplicates`, `pdfmarks`). The AI tag suggestions go through the router like
//! every other AI call: a page with a privacy marker (`#privat`) stays on the local model.

use arcalo_core::ai::client::ChatRequest;
use arcalo_core::ai::privacy;
use arcalo_core::duplicates::{DuplicateHint, DuplicatePair, MergeOutcome};
use arcalo_core::error::Error;
use arcalo_core::mentions::MentionReport;
use arcalo_core::pdfmarks::{self, NewHighlight, PdfHighlight};
use arcalo_core::tagsuggest::{self, TagSuggestion};
use arcalo_core::tr;
use tauri::{AppHandle, State};

use crate::{AppState, Result, background_read};

// ------------------------------------------------------------------ mentions

#[tauri::command]
pub async fn mentions_get(app: AppHandle, page_id: i64) -> Result<MentionReport> {
    background_read(app, move |db| db.unlinked_mentions(page_id)).await
}

/// Links the mention at byte `start` (or all mentions) of page `target` in page `source`.
#[tauri::command(async)]
pub fn mentions_link(state: State<AppState>, source: i64, target: i64, start: Option<usize>) -> Result<usize> {
    state.db().link_mentions(source, target, start)
}

#[tauri::command(async)]
pub fn mentions_ignore(state: State<AppState>, page_id: i64, term: String) -> Result<()> {
    state.db().ignore_mention(page_id, &term)
}

// ------------------------------------------------------------------ tags

#[tauri::command]
pub async fn tags_suggest(app: AppHandle, page_id: i64) -> Result<Vec<TagSuggestion>> {
    background_read(app, move |db| db.tag_suggestions(page_id)).await
}

#[tauri::command(async)]
pub fn tags_dismiss(state: State<AppState>, page_id: i64, tag: String) -> Result<()> {
    state.db().dismiss_tag(page_id, &tag)
}

/// „Tags mit KI vorschlagen“: title, the first 800 characters and the 200 most used tags go
/// to the model; it answers with tags of that vocabulary and at most two new ones.
#[tauri::command]
pub async fn tags_suggest_ai(app: AppHandle, state: State<'_, AppState>, page_id: i64) -> Result<Vec<TagSuggestion>> {
    if !state.clients().iter().any(|(_, c)| c.has_key() || !c.provider().needs_key()) {
        return Err(Error::State(
            tr!("Keine KI verbunden (API-Schlüssel fehlt)", "No AI connected (API key missing)").into(),
        ));
    }
    crate::prefs::check_cost_limit(&state, false)?;
    let (doc, vocabulary) = {
        let db = state.db();
        (db.page_doc(page_id)?, db.tag_vocabulary(tagsuggest::AI_VOCABULARY)?)
    };
    let messages = tagsuggest::ai_messages(&doc.page.title, &doc.content, &vocabulary);
    // The whole page and its tags decide the route: `#privat` anywhere keeps it local.
    let context = vec![doc.content.clone(), privacy::tag_text(&doc.tags)];
    let route = crate::route_for(&state, &doc.page.title, &context, false, None);
    let req = ChatRequest {
        model: route.model.clone(),
        messages,
        tools: vec![],
        temperature: Some(0.1),
        max_tokens: Some(120),
    };
    let request_id = format!("tags-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default());
    let (completion, _, _) = crate::complete_routed(&app, &state, &request_id, req, route).await?;
    let have = doc.tags.into_iter().collect();
    Ok(tagsuggest::parse_ai_tags(&completion.content, &vocabulary, &have))
}

// ------------------------------------------------------------------ duplicates

#[tauri::command]
pub async fn duplicates_for(app: AppHandle, page_id: i64) -> Result<Vec<DuplicateHint>> {
    background_read(app, move |db| db.duplicate_hints(page_id)).await
}

#[tauri::command(async)]
pub fn duplicates_all(state: State<AppState>) -> Result<Vec<DuplicatePair>> {
    state.reader().all_duplicates()
}

#[tauri::command(async)]
pub fn duplicates_ignore(state: State<AppState>, a: i64, b: i64) -> Result<()> {
    state.db().ignore_duplicate(a, b)
}

#[tauri::command(async)]
pub fn pages_merge(state: State<AppState>, keep: i64, other: i64) -> Result<MergeOutcome> {
    state.db().merge_pages(keep, other)
}

#[tauri::command(async)]
pub fn pages_merge_undo(state: State<AppState>) -> Result<Vec<i64>> {
    state.db().undo_merge()
}

// ------------------------------------------------------------------ PDF highlights

#[tauri::command(async)]
pub fn pdf_highlights_list(state: State<AppState>, name: String) -> Result<Vec<PdfHighlight>> {
    state.reader().pdf_highlights(&name)
}

#[tauri::command(async)]
pub fn pdf_highlight_add(state: State<AppState>, highlight: NewHighlight) -> Result<PdfHighlight> {
    state.db().add_pdf_highlight(&highlight)
}

#[tauri::command(async)]
pub fn pdf_highlight_update(
    state: State<AppState>,
    id: i64,
    color: Option<String>,
    note: Option<String>,
) -> Result<PdfHighlight> {
    state.db().update_pdf_highlight(id, color.as_deref(), note.as_deref())
}

#[tauri::command(async)]
pub fn pdf_highlight_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().delete_pdf_highlight(id)
}

/// The Markdown of one highlight (a quote with its link) or, with `all`, of every highlight
/// of the file (a summary block).
#[tauri::command(async)]
pub fn pdf_highlight_markdown(state: State<AppState>, name: String, id: Option<i64>) -> Result<String> {
    let db = state.reader();
    match id {
        Some(id) => Ok(pdfmarks::quote_markdown(&db.pdf_highlight(id)?)),
        None => {
            let all = db.pdf_highlights(&name)?;
            if all.is_empty() {
                return Err(Error::State(tr!("Keine Markierungen in diesem PDF", "No highlights in this PDF").into()));
            }
            Ok(pdfmarks::summary_markdown(&name, &all))
        }
    }
}

/// Appends Markdown to a page that is not open in an editor.
#[tauri::command(async)]
pub fn page_append(state: State<AppState>, page_id: i64, markdown: String) -> Result<()> {
    state.db().append_to_page(page_id, &markdown)
}
