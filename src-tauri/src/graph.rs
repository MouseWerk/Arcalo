//! Graph view in the shell: the graph of the workspace under the view's filters, the part that
//! changed after a save or rename, and the view's stored state (layout, presets, display).
//! The logic lives in `annalo_core::graph`.

use annalo_core::graph::{GraphData, GraphFilter};
use tauri::State;

use crate::{AppState, Result};

#[tauri::command(async)]
pub fn graph_data(state: State<AppState>, filter: Option<GraphFilter>) -> Result<GraphData> {
    state.reader().graph_data(&filter.unwrap_or_default())
}

#[tauri::command(async)]
pub fn graph_patch(state: State<AppState>, ids: Vec<i64>, filter: Option<GraphFilter>) -> Result<GraphData> {
    state.reader().graph_patch(&ids, &filter.unwrap_or_default())
}

/// `layout` (node positions), `presets` (saved filters and groups) or `view` (the last settings).
#[tauri::command(async)]
pub fn graph_state_get(state: State<AppState>, key: String) -> Result<Option<serde_json::Value>> {
    state.reader().graph_state(&key)
}

#[tauri::command(async)]
pub fn graph_state_set(state: State<AppState>, key: String, value: serde_json::Value) -> Result<()> {
    state.db().set_graph_state(&key, &value)
}
