//! The assistant's chat history in the shell: IPC commands over `arcalo_core::chats`.
//! With Settings → Datenschutz „Chat-Verlauf: nicht speichern“ nothing is written.

use arcalo_core::Error;
use arcalo_core::chats::{Conversation, ConversationDoc, ConversationPatch, NewMessage};
use arcalo_core::prefs::ChatRetention;
use chrono::Utc;
use serde::Serialize;
use tauri::State;

use crate::AppState;

type Result<T> = std::result::Result<T, Error>;

fn saving(state: &AppState) -> bool {
    state.settings().ai.chat_history != ChatRetention::Off
}

/// Applies the retention setting (on start and when it changes).
pub fn prune(state: &AppState) {
    let retention = state.settings().ai.chat_history;
    if let Err(e) = state.db().chat_prune(retention, Utc::now()) {
        crate::devlog::warn("ai", format!("chat history cleanup failed: {e}"));
    }
}

#[tauri::command]
pub fn chat_list(state: State<AppState>, query: Option<String>, archived: Option<bool>) -> Result<Vec<Conversation>> {
    state.reader().chat_list(query.as_deref().unwrap_or(""), archived.unwrap_or(false), 500)
}

#[tauri::command]
pub fn chat_get(state: State<AppState>, id: i64) -> Result<ConversationDoc> {
    state.reader().chat_get(id)
}

/// A new conversation; `None` when chats are not saved.
#[tauri::command]
pub fn chat_create(state: State<AppState>, title: String) -> Result<Option<Conversation>> {
    if !saving(&state) {
        return Ok(None);
    }
    let private = state.settings().privacy.local_only;
    state.db().chat_create(&title, private, Utc::now()).map(Some)
}

#[derive(Serialize)]
pub struct Appended {
    conversation: Conversation,
    seqs: Vec<i64>,
}

/// Saves the messages of a finished turn; `None` when chats are not saved.
#[tauri::command]
pub fn chat_append(
    state: State<AppState>,
    id: i64,
    messages: Vec<NewMessage>,
    page_id: Option<i64>,
    private: Option<bool>,
) -> Result<Option<Appended>> {
    if !saving(&state) {
        return Ok(None);
    }
    let private = private.unwrap_or(false) || state.settings().privacy.local_only;
    let (conversation, seqs) = state.db().chat_append(id, &messages, page_id, private, Utc::now())?;
    Ok(Some(Appended { conversation, seqs }))
}

#[tauri::command]
pub fn chat_truncate(state: State<AppState>, id: i64, seq: i64) -> Result<usize> {
    state.db().chat_truncate(id, seq)
}

#[tauri::command]
pub fn chat_update(state: State<AppState>, id: i64, patch: ConversationPatch) -> Result<Conversation> {
    state.db().chat_update(id, &patch)
}

#[tauri::command]
pub fn chat_delete(state: State<AppState>, id: i64) -> Result<()> {
    state.db().chat_delete(id, Utc::now())
}

#[tauri::command]
pub fn chat_restore(state: State<AppState>, id: i64) -> Result<Conversation> {
    state.db().chat_restore(id)
}

#[tauri::command]
pub fn chat_delete_all(state: State<AppState>) -> Result<usize> {
    state.db().chat_delete_all()
}

#[tauri::command]
pub fn chat_duplicate(state: State<AppState>, id: i64, title: String) -> Result<Option<Conversation>> {
    if !saving(&state) {
        return Ok(None);
    }
    state.db().chat_duplicate(id, &title, Utc::now()).map(Some)
}
