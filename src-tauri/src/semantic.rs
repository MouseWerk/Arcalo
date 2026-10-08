//! Suche nach Bedeutung in the shell (see `arcalo_core::semantic`): the background indexer that
//! embeds new and changed chunks with the embedding model of Settings → KI, the query
//! embedding, and Settings → Suche (switch, progress, „Index neu aufbauen“).
//!
//! The indexer wakes every few seconds and works only when something changed: a page got new
//! chunks (any save, import or deletion that left chunks without an embedding), the settings
//! chose another model, or a rebuild was asked for. It waits until typing pauses, embeds small
//! batches with a pause in between and keeps the database only for the short writes, so it
//! never holds up the editor. It resumes where it stopped: what is not embedded yet is simply
//! pending (`notes_blocks.vector_embedding IS NULL`).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use arcalo_core::ai::capability;
use arcalo_core::search::{self, SearchHit};
use arcalo_core::semantic::{self, Plan, Progress, VectorIndex};
use arcalo_core::{tr, trf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, Result, devlog, embedding_client, learn_modes, lock};

/// Chunks per embedding request: small, so one request stays short on a laptop's Ollama.
const BATCH: usize = 16;
/// Pause between two batches (the model and the database get a breather).
const BATCH_PAUSE: Duration = Duration::from_millis(150);
/// How often the indexer looks for work.
const TICK: Duration = Duration::from_secs(2);
/// New chunks are embedded once nothing changed for this long (not on every autosave).
const QUIET: Duration = Duration::from_secs(3);
/// After the model could not be reached: the next try.
const RETRY: Duration = Duration::from_secs(60);
/// A query waits this long for its embedding; then the exact hits stand alone.
const QUERY_TIMEOUT: Duration = Duration::from_secs(3);
/// Query embeddings kept (typing back and forth asks the model once per text).
const QUERY_CACHE: usize = 256;

#[derive(Default)]
pub struct Semantic {
    index: Mutex<VectorIndex>,
    status: Mutex<Status>,
    /// Run now (after „Index neu aufbauen“ cleared the vectors).
    wake: AtomicBool,
    /// Query embeddings by model key and text.
    queries: Mutex<HashMap<(String, String), Vec<f32>>>,
}

#[derive(Default, Clone)]
struct Status {
    running: bool,
    /// Why the last run stopped (German or English, as the UI language).
    error: Option<String>,
    /// The model could not be reached (offline): exact search only until it answers.
    offline: bool,
    progress: Progress,
    /// When the next try after an error is due.
    retry_at: Option<Instant>,
}

/// What Settings → Suche shows.
#[derive(Serialize, Clone)]
pub struct SemanticStatus {
    #[serde(flatten)]
    plan: Plan,
    running: bool,
    offline: bool,
    error: Option<String>,
    progress: Progress,
    /// Memory of the vectors of the search (bytes), once loaded.
    memory: usize,
}

fn status_of(app: &AppHandle) -> SemanticStatus {
    let state = app.state::<AppState>();
    let sem = app.state::<Semantic>();
    let settings = state.settings();
    let plan = semantic::plan(&settings);
    let st = lock(&sem.status).clone();
    let progress = if st.running {
        st.progress
    } else {
        let db = state.reader();
        let p = semantic::progress(&db, plan.local, &settings.router.private_markers).unwrap_or(st.progress);
        // Vectors of another model (just switched): nothing of them counts.
        match plan.index_key() {
            Some(key) if !semantic::index_matches(&db, &key).unwrap_or(true) => {
                Progress { total: p.total, ..Default::default() }
            }
            _ => p,
        }
    };
    let memory = sem.index.try_lock().map(|i| i.bytes()).unwrap_or_default();
    SemanticStatus { running: st.running, offline: st.offline, error: st.error, progress, memory, plan }
}

fn emit_status(app: &AppHandle) {
    let _ = app.emit("semantic://status", status_of(app));
}

fn set_status(app: &AppHandle, f: impl FnOnce(&mut Status)) {
    f(&mut lock(&app.state::<Semantic>().status));
    emit_status(app);
}

fn startup_delay() -> Duration {
    Duration::from_secs(
        std::env::var("ARCALO_SEMANTIC_DELAY_SECS").ok().and_then(|s| s.trim().parse().ok()).unwrap_or(10),
    )
}

/// Starts the background indexer.
pub fn spawn_indexer(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(startup_delay()).await;
        // What the last run saw: model, chunk generation, when the chunks last changed.
        let mut seen: Option<(String, u64)> = None;
        let mut changed_at = Instant::now() - QUIET;
        let mut last_generation = arcalo_core::ai::rag::chunk_generation();
        loop {
            let generation = arcalo_core::ai::rag::chunk_generation();
            if generation != last_generation {
                last_generation = generation;
                changed_at = Instant::now();
            }
            let plan = semantic::plan(&app.state::<AppState>().settings());
            let sem = app.state::<Semantic>();
            let wake = sem.wake.swap(false, Ordering::Relaxed);
            let (retry_at, failed) = {
                let st = lock(&sem.status);
                (st.retry_at, st.error.is_some() && !st.offline)
            };
            let retry_due = retry_at.is_some_and(|t| Instant::now() >= t)
                // A model that failed for good is asked again once the settings were saved (the
                // session forgets the failure then).
                || (failed
                    && embedding_client(&app.state::<AppState>())
                        .is_some_and(|(_, r)| lock(&app.state::<AppState>().caps).embedding_usable(&r).is_ok()));
            match plan.index_key().filter(|_| plan.active()) {
                None => {
                    if lock(&sem.status).running {
                        set_status(&app, |s| s.running = false);
                    }
                    seen = None;
                }
                Some(key) => {
                    let fresh = seen.as_ref() != Some(&(key.clone(), generation));
                    let model_changed = seen.as_ref().is_none_or(|(k, _)| *k != key);
                    let quiet = changed_at.elapsed() >= QUIET;
                    if wake || retry_due || model_changed || (fresh && quiet) {
                        if model_changed {
                            set_status(&app, |s| *s = Status::default());
                        }
                        seen = Some((key.clone(), generation));
                        run(&app, &plan, &key).await;
                    }
                }
            }
            tokio::time::sleep(TICK).await;
        }
    });
}

/// One indexing run: everything pending, in batches, until done, stopped or failed.
async fn run(app: &AppHandle, plan: &Plan, key: &str) {
    let state = app.state::<AppState>();
    let sem = app.state::<Semantic>();
    let settings = state.settings();
    let markers = settings.router.private_markers.clone();
    let Some((client, r)) = embedding_client(&state) else {
        lock(&sem.status).retry_at = None;
        return;
    };
    {
        let db = state.db();
        match semantic::ensure_index_model(&db, key) {
            Ok(true) => devlog::info("search", format!("search by meaning: new model {key}, vectors cleared")),
            Ok(false) => {}
            Err(e) => devlog::warn("search", format!("search index model not checked: {e}")),
        }
    }
    learn_modes(&state, &client).await;
    if let Err(why) = lock(&state.caps).embedding_usable(&r) {
        set_status(app, |s| {
            s.running = false;
            s.error = Some(why);
            s.retry_at = None;
        });
        return;
    }
    let progress = |db: &arcalo_core::Database| semantic::progress(db, plan.local, &markers).unwrap_or_default();
    let start = progress(&state.reader());
    if start.done >= start.total && start.total > 0 {
        set_status(app, |s| {
            s.running = false;
            s.progress = start;
            s.error = None;
            s.offline = false;
            s.retry_at = None;
        });
        return;
    }
    set_status(app, |s| {
        s.running = true;
        s.progress = start;
        s.error = None;
        s.retry_at = None;
    });
    let t0 = Instant::now();
    let mut embedded = 0usize;
    loop {
        // Settings changed meanwhile (another model, switched off): the next tick decides.
        let now = semantic::plan(&state.settings());
        if now.index_key().as_deref() != Some(key) || !now.active() {
            break;
        }
        if !plan.local
            && let Err(e) = crate::prefs::check_cost_limit(&state, false)
        {
            set_status(app, |s| {
                s.running = false;
                s.error = Some(e.to_string());
            });
            return;
        }
        let batch = match semantic::pending(&state.reader(), plan.local, &markers, BATCH) {
            Ok(b) => b,
            Err(e) => {
                devlog::warn("search", format!("search index: pending chunks not read: {e}"));
                break;
            }
        };
        if batch.is_empty() {
            break;
        }
        let texts: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let vectors = match tokio::time::timeout(Duration::from_secs(120), client.embed(&r.model, &texts)).await {
            Ok(Ok(v)) if v.len() == batch.len() => {
                lock(&state.caps).embed_succeeded(&r);
                v
            }
            Ok(Ok(v)) => {
                devlog::warn("search", format!("“{}” returned {} vectors for {} texts", r.model, v.len(), batch.len()));
                stop_failed(app, None, false);
                return;
            }
            Ok(Err(e)) => {
                let lasting = lock(&state.caps).embed_failed(&r, &e);
                devlog::warn("search", format!("search index: embedding with “{}” failed: {e}", r.model));
                let why = trf!(
                    "„{}“ liefert keine Embeddings ({}).",
                    "“{}” returns no embeddings ({}).",
                    r.model,
                    capability::embedding_failure_text(&e)
                );
                stop_failed(app, Some(why), !lasting);
                return;
            }
            Err(_) => {
                devlog::warn("search", format!("search index: “{}” did not answer in time", r.model));
                stop_failed(app, None, true);
                return;
            }
        };
        {
            let db = state.db();
            if !plan.local {
                let usage = arcalo_core::ai::metrics::embedding_usage(&r.model, &texts, &client.prices);
                let _ = db.record_ai_usage(&state.session_id, &usage);
            }
            for ((id, _), v) in batch.iter().zip(&vectors) {
                if let Err(e) = arcalo_core::ai::rag::store_embedding(&db, *id, v) {
                    devlog::warn("search", format!("search index: vector not stored: {e}"));
                }
            }
        }
        embedded += batch.len();
        let p = progress(&state.reader());
        set_status(app, |s| {
            s.progress = p;
            s.offline = false;
        });
        tokio::time::sleep(BATCH_PAUSE).await;
    }
    let p = progress(&state.reader());
    if embedded > 0 {
        devlog::info(
            "search",
            format!("search by meaning: {embedded} chunks embedded in {:.1?} ({}/{})", t0.elapsed(), p.done, p.total),
        );
    }
    set_status(app, |s| {
        s.running = false;
        s.progress = p;
    });
}

/// Stops a run after a failure: `retry` (offline, a timeout) tries again in a minute.
fn stop_failed(app: &AppHandle, why: Option<String>, retry: bool) {
    let why = why.unwrap_or_else(|| {
        tr!("Das Embedding-Modell antwortet nicht.", "The embedding model does not answer.").to_owned()
    });
    set_status(app, |s| {
        s.running = false;
        s.offline = retry;
        s.error = Some(why);
        s.retry_at = retry.then(|| Instant::now() + RETRY);
    });
}

/// The state of search by meaning for Settings → Suche.
#[tauri::command(async)]
pub fn semantic_status(app: AppHandle) -> SemanticStatus {
    status_of(&app)
}

/// „Index neu aufbauen“: the vectors go now, every chunk is embedded again in the background.
#[tauri::command(async)]
pub fn semantic_rebuild(app: AppHandle) -> Result<SemanticStatus> {
    semantic::rebuild(&app.state::<AppState>().db())?;
    devlog::info("search", "search by meaning: index cleared, rebuilding");
    app.state::<Semantic>().wake.store(true, Ordering::Relaxed);
    Ok(status_of(&app))
}

#[derive(Serialize)]
pub struct SemanticResult {
    hits: Vec<SearchHit>,
    /// Whether meaning hits were searched (false: exact hits only).
    meaning: bool,
}

/// The search with meaning: exact hits and pages found by meaning (see `arcalo_core::semantic`).
/// Exact hits only when search by meaning is off, the model is not reachable, the index is of
/// another model, or the query names a privacy marker and the model is not local.
#[tauri::command]
pub async fn search_semantic(
    state: State<'_, AppState>,
    sem: State<'_, Semantic>,
    query: String,
    limit: Option<usize>,
) -> Result<SemanticResult> {
    let limit = limit.unwrap_or(30).clamp(1, 200);
    let exact = || -> Result<SemanticResult> {
        Ok(SemanticResult { hits: search::search(&state.reader(), &query, limit)?, meaning: false })
    };
    let settings = state.settings();
    let plan = semantic::plan(&settings);
    let Some(key) = plan.index_key().filter(|_| plan.active()) else { return exact() };
    if query.trim().chars().count() < 3
        || !semantic::query_may_embed(&query, plan.local, &settings.router.private_markers)
        || !semantic::index_matches(&state.reader(), &key)?
    {
        return exact();
    }
    let Some((client, r)) = embedding_client(&state) else { return exact() };
    if lock(&state.caps).embedding_usable(&r).is_err() {
        return exact();
    }
    let cache_key = (key.clone(), query.trim().to_owned());
    let cached = lock(&sem.queries).get(&cache_key).cloned();
    let vector = match cached {
        Some(v) => v,
        None => {
            let text = query.trim().to_owned();
            match tokio::time::timeout(QUERY_TIMEOUT, client.embed(&r.model, std::slice::from_ref(&text))).await {
                Ok(Ok(mut v)) if !v.is_empty() => {
                    let v = v.swap_remove(0);
                    if !plan.local {
                        let usage = arcalo_core::ai::metrics::embedding_usage(&r.model, &[text], &client.prices);
                        let _ = state.db().record_ai_usage(&state.session_id, &usage);
                    }
                    let mut q = lock(&sem.queries);
                    if q.len() >= QUERY_CACHE {
                        q.clear();
                    }
                    q.insert(cache_key, v.clone());
                    v
                }
                Ok(Ok(_)) => return exact(),
                Ok(Err(e)) => {
                    devlog::debug("search", format!("query embedding with “{}” failed: {e}", r.model));
                    return exact();
                }
                Err(_) => return exact(),
            }
        }
    };
    let mut index = lock(&sem.index);
    let hits = semantic::search(&state.reader(), &mut index, &query, Some(&vector), limit)?;
    Ok(SemanticResult { hits, meaning: true })
}
