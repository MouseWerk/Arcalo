//! What a model can do besides chatting, as far as this session knows: whether it computes
//! embeddings, and which request parameters it rejected.
//!
//! A chat model must never be asked for embeddings. On a LiteLLM proxy that is more than a
//! wasted request: the failure (vLLM answers 404) counts against the model's deployment, and a
//! few of them put it into cooldown, so the chat request right after is refused with 429 „No
//! deployments available“. So a model is only used for embeddings when the provider reports it
//! as an embedding model (LiteLLM's `/model/info`, `model_info.mode`), or, when it does not
//! say, its name looks like one. What failed once is remembered for the session.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::router::ModelRef;
use crate::error::Error;

/// Parts of model names that mark an embedding model (lower case), anywhere in the name.
const EMBED_PARTS: &[&str] = &["embed", "bge", "nomic", "minilm", "mxbai", "arctic-embed", "jina-emb"];
/// Name tokens (split at `-`, `_`, `/`, `:`, `.`) that mark one: `multilingual-e5-large`, `gte-base`.
const EMBED_TOKENS: &[&str] = &["e5", "gte"];

/// Whether `model`'s name looks like an embedding model.
pub fn looks_like_embedding(model: &str) -> bool {
    let m = model.to_lowercase();
    EMBED_PARTS.iter().any(|p| m.contains(p))
        || m.split(|c: char| !c.is_ascii_alphanumeric()).any(|t| EMBED_TOKENS.contains(&t))
}

/// Whether `model` can compute embeddings: the provider's own word when it gives one
/// (`mode` from LiteLLM's `/model/info`), else its name.
pub fn embedding_capable(model: &str, mode: Option<&str>) -> bool {
    match mode {
        Some(m) => m.eq_ignore_ascii_case("embedding"),
        None => looks_like_embedding(model),
    }
}

/// Whether `model` can answer chat requests (the model lists mix both kinds).
pub fn chat_capable(model: &str, mode: Option<&str>) -> bool {
    match mode {
        Some(m) => !m.eq_ignore_ascii_case("embedding"),
        None => !looks_like_embedding(model),
    }
}

/// The modes LiteLLM's `/model/info` reports: `model_name` → `model_info.mode`, for the models
/// that have one (most setups leave it empty for chat models).
pub fn parse_model_modes(v: &Value) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for item in v["data"].as_array().into_iter().flatten() {
        let (Some(name), Some(mode)) = (item["model_name"].as_str(), item["model_info"]["mode"].as_str()) else {
            continue;
        };
        if !mode.trim().is_empty() {
            out.insert(name.to_owned(), mode.trim().to_lowercase());
        }
    }
    out
}

/// Whether an embedding request failed in a way that will not change by asking again: the
/// model has no embeddings (404, 400, „not found“, „not supported“). Timeouts, connection
/// errors, rate limits and rejected keys are passing or have their own message.
pub fn embedding_failure_lasting(e: &Error) -> bool {
    match e {
        Error::Provider { status: 0 | 401 | 403 | 408 | 429, .. } => false,
        Error::Provider { status, body } => {
            let b = body.to_lowercase();
            // 200: an answer that is no list of embeddings.
            matches!(status, 200 | 400 | 404 | 405 | 422 | 501)
                || b.contains("not found")
                || b.contains("does not support")
                || b.contains("not supported")
        }
        Error::Http(e) => e.is_decode(),
        Error::Json(_) => true,
        _ => false,
    }
}

/// Short German cause of a failed embedding request, for the settings and the answer's route info.
pub fn embedding_failure_text(e: &Error) -> String {
    match e {
        Error::Provider { status: 200, .. } | Error::Json(_) => "die Antwort ist keine Embedding-Liste".into(),
        Error::Provider { status, .. } if *status > 0 => format!("der KI-Server meldet Fehler {status}"),
        Error::Http(e) if e.is_decode() => "die Antwort ist keine Embedding-Liste".into(),
        e => e.to_string().chars().take(120).collect(),
    }
}

/// What this session learned about the models of the providers.
#[derive(Debug, Clone, Default)]
pub struct Capabilities {
    /// Per provider: the modes its `/model/info` reports (`None` entry = asked, nothing known).
    modes: HashMap<String, HashMap<String, String>>,
    embed_failed: HashMap<ModelRef, String>,
    embed_ok: HashSet<ModelRef>,
    /// Failures already mentioned in an answer (once per model and session).
    embed_told: HashSet<ModelRef>,
    no_tools: HashSet<ModelRef>,
    no_temperature: HashSet<ModelRef>,
}

impl Capabilities {
    /// Forgets everything (settings changed: a fixed server gets another chance).
    pub fn clear(&mut self) {
        *self = Self::default();
    }

    pub fn has_modes(&self, provider: &str) -> bool {
        self.modes.contains_key(provider)
    }

    pub fn set_modes(&mut self, provider: &str, modes: HashMap<String, String>) {
        self.modes.insert(provider.to_owned(), modes);
    }

    pub fn mode(&self, r: &ModelRef) -> Option<&str> {
        self.modes.get(&r.provider)?.get(&r.model).map(String::as_str)
    }

    /// Whether `r` may be asked for embeddings, or why not (German, for the settings).
    pub fn embedding_usable(&self, r: &ModelRef) -> std::result::Result<(), String> {
        if let Some(why) = self.embed_failed.get(r) {
            return Err(format!(
                "„{}“ liefert keine Embeddings ({why}). Die Suche nutzt nur Stichwörter, bis du ein anderes \
                 Embedding-Modell wählst oder die Einstellungen neu speicherst.",
                r.model
            ));
        }
        if self.embed_ok.contains(r) {
            return Ok(());
        }
        match self.mode(r) {
            Some(mode) if !embedding_capable(&r.model, Some(mode)) => Err(format!(
                "„{}“ ist laut Server kein Embedding-Modell (Typ „{mode}“). Die Suche nutzt nur Stichwörter.",
                r.model
            )),
            Some(_) => Ok(()),
            None if looks_like_embedding(&r.model) => Ok(()),
            None => Err(format!(
                "„{}“ ist kein Embedding-Modell (weder der Server noch der Name weist es als solches aus). \
                 Die Suche nutzt nur Stichwörter.",
                r.model
            )),
        }
    }

    /// Records a failed embedding request. Returns whether it is remembered (a lasting failure).
    pub fn embed_failed(&mut self, r: &ModelRef, e: &Error) -> bool {
        if !embedding_failure_lasting(e) {
            return false;
        }
        self.embed_ok.remove(r);
        self.embed_failed.insert(r.clone(), embedding_failure_text(e));
        true
    }

    pub fn embed_succeeded(&mut self, r: &ModelRef) {
        self.embed_failed.remove(r);
        self.embed_ok.insert(r.clone());
    }

    /// Whether the unusable embedding model `r` still has to be mentioned (the first time only).
    pub fn tell_once(&mut self, r: &ModelRef) -> bool {
        self.embed_told.insert(r.clone())
    }

    pub fn rejects_tools(&self, r: &ModelRef) -> bool {
        self.no_tools.contains(r)
    }

    pub fn rejects_temperature(&self, r: &ModelRef) -> bool {
        self.no_temperature.contains(r)
    }

    /// Remembers parameters `r` rejected, so the next request leaves them out from the start.
    pub fn rejected(&mut self, r: &ModelRef, tools: bool, temperature: bool) {
        if tools {
            self.no_tools.insert(r.clone());
        }
        if temperature {
            self.no_temperature.insert(r.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn r(m: &str) -> ModelRef {
        ModelRef::new("litellm", m)
    }

    #[test]
    fn names_of_embedding_models() {
        for m in [
            "text-embedding-3-small",
            "nomic-embed-text",
            "bge-m3",
            "BAAI/bge-large-en-v1.5",
            "intfloat/multilingual-e5-large",
            "all-minilm:latest",
            "mxbai-embed-large",
            "thenlper/gte-base",
            "firma-embed",
        ] {
            assert!(looks_like_embedding(m), "{m}");
        }
        for m in ["vllmserver", "gpt-4o", "gemma4:e2b", "llama3.2", "qwen2.5-coder", "o3", "mistral-large", "gpt-e5x"] {
            assert!(!looks_like_embedding(m), "{m}");
        }
    }

    #[test]
    fn the_servers_mode_wins_over_the_name() {
        assert!(embedding_capable("firma-vektoren", Some("embedding")));
        assert!(!embedding_capable("vllmserver", Some("chat")));
        assert!(!embedding_capable("vllmserver", None));
        assert!(!embedding_capable("embed-chat-special", Some("chat")));
        assert!(chat_capable("embed-chat-special", Some("chat")));
        assert!(!chat_capable("firma-vektoren", Some("embedding")));
        assert!(!chat_capable("nomic-embed-text", None));
    }

    #[test]
    fn reads_litellm_model_info() {
        let v = json!({"data": [
            {"model_name": "vllmserver", "litellm_params": {"model": "hosted_vllm/qwen"}, "model_info": {"id": "a5b2", "mode": null}},
            {"model_name": "firma-vektoren", "model_info": {"mode": "embedding"}},
            {"model_name": "gpt-4o", "model_info": {"mode": "chat"}},
            {"model_name": "broken"}
        ]});
        let modes = parse_model_modes(&v);
        assert_eq!(modes.len(), 2);
        assert_eq!(modes["firma-vektoren"], "embedding");
        assert_eq!(modes["gpt-4o"], "chat");
        assert!(parse_model_modes(&json!({"detail": "Not Found"})).is_empty());
    }

    #[test]
    fn a_chat_model_is_never_used_for_embeddings() {
        let mut caps = Capabilities::default();
        // Nothing known from the server: the name decides.
        let err = caps.embedding_usable(&r("vllmserver")).unwrap_err();
        assert!(err.contains("kein Embedding-Modell"), "{err}");
        assert!(caps.embedding_usable(&r("firma-embed")).is_ok());
        // The server's word.
        caps.set_modes(
            "litellm",
            HashMap::from([("firma-vektoren".into(), "embedding".into()), ("gpt-4o".into(), "chat".into())]),
        );
        assert!(caps.embedding_usable(&r("firma-vektoren")).is_ok());
        assert!(caps.embedding_usable(&r("gpt-4o")).unwrap_err().contains("Typ „chat“"));
        // A model with an unusual name that did embed (connection test, indexing) counts.
        caps.embed_succeeded(&r("vektoren-intern"));
        assert!(caps.embedding_usable(&r("vektoren-intern")).is_ok());
    }

    #[test]
    fn a_lasting_embedding_failure_is_remembered_once() {
        let mut caps = Capabilities::default();
        let not_found = Error::Provider {
            status: 404,
            body: "litellm.NotFoundError: OpenAIException - Error code: 404 - {'detail': 'Not Found'}".into(),
        };
        assert!(caps.embed_failed(&r("vllm-embed"), &not_found));
        let err = caps.embedding_usable(&r("vllm-embed")).unwrap_err();
        assert!(err.contains("Fehler 404"), "{err}");
        assert!(caps.tell_once(&r("vllm-embed")));
        assert!(!caps.tell_once(&r("vllm-embed")));
        // Passing problems are not remembered.
        let busy = Error::Provider { status: 429, body: "No deployments available, Try again in 5 seconds".into() };
        assert!(!caps.embed_failed(&r("other-embed"), &busy));
        assert!(
            !caps.embed_failed(&r("other-embed"), &Error::Provider { status: 0, body: "Zeitüberschreitung".into() })
        );
        assert!(caps.embedding_usable(&r("other-embed")).is_ok());
        // New settings: another chance.
        caps.clear();
        assert!(caps.embedding_usable(&r("vllm-embed")).is_ok());
    }

    #[test]
    fn rejected_parameters_are_remembered_per_model() {
        let mut caps = Capabilities::default();
        caps.rejected(&r("vllmserver"), true, false);
        assert!(caps.rejects_tools(&r("vllmserver")));
        assert!(!caps.rejects_temperature(&r("vllmserver")));
        assert!(!caps.rejects_tools(&ModelRef::new("ollama", "vllmserver")));
    }
}
