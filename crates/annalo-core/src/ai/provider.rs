//! AI providers: where requests go. A LiteLLM proxy, any OpenAI-compatible endpoint (OpenAI,
//! Mistral, Groq, OpenRouter, vLLM, LM Studio …), Azure OpenAI or a local Ollama.
//!
//! Every provider speaks the OpenAI chat protocol; they differ only in the paths, the auth
//! header and (Ollama) a native model list and model download. Keys are not part of the
//! settings: the desktop shell keeps one credential per provider id.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::network::{NetworkSettings, ProxyMode};

/// The provider created from the settings of versions before providers existed
/// (`litellm_base_url`). Its key is the credential that held the LiteLLM token.
pub const LEGACY_ID: &str = "litellm";

/// Default address of a local Ollama.
pub const OLLAMA_URL: &str = "http://localhost:11434";

/// `api-version` used when an Azure provider has none.
pub const AZURE_API_VERSION: &str = "2024-10-21";

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    /// LiteLLM proxy: `<root>/v1/…`, bearer token, cost in a response header.
    #[default]
    Litellm,
    /// Azure OpenAI: `<endpoint>/openai/deployments/<deployment>/…?api-version=…` with an
    /// `api-key` header; the model name is the deployment name.
    Azure,
    /// Ollama: OpenAI-compatible `<root>/v1/…`, native `/api/tags` and `/api/pull`, no key.
    Ollama,
    /// Any OpenAI-compatible API; the base URL includes the version (`…/v1`). Unknown kinds
    /// (from a newer version) load as this.
    #[serde(other)]
    Openai,
}

impl ProviderKind {
    pub fn label(self) -> &'static str {
        match self {
            ProviderKind::Litellm => "LiteLLM",
            ProviderKind::Openai => "OpenAI-kompatibel",
            ProviderKind::Azure => "Azure OpenAI",
            ProviderKind::Ollama => "Ollama",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct AiProvider {
    /// Stable id (`[a-z0-9-]`): referenced by the tiers and the credential store.
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    /// Runs on this machine or in the own network: may receive content marked private
    /// (`#privat`, Settings → Datenschutz „Nur lokal“). Its requests cost nothing.
    pub local: bool,
    pub enabled: bool,
    /// Connect directly instead of through the proxy of Settings → Netzwerk (default for
    /// providers on this machine).
    pub bypass_proxy: bool,
    /// Azure OpenAI: the `api-version` query parameter.
    pub api_version: String,
    /// Model (Azure: deployment) names added by hand, for providers that do not list theirs.
    pub models: Vec<String>,
}

impl Default for AiProvider {
    fn default() -> Self {
        AiProvider {
            id: String::new(),
            name: String::new(),
            kind: ProviderKind::Openai,
            base_url: String::new(),
            local: false,
            enabled: true,
            bypass_proxy: false,
            api_version: String::new(),
            models: vec![],
        }
    }
}

/// Whether `url` points at this machine (`localhost`, `127.x`, `::1`).
pub fn is_loopback(url: &str) -> bool {
    let Ok(u) = reqwest::Url::parse(url.trim()) else { return false };
    let Some(host) = u.host_str().map(|h| h.trim_matches(['[', ']']).to_ascii_lowercase()) else { return false };
    host == "localhost"
        || host.ends_with(".localhost")
        || host.parse::<std::net::IpAddr>().is_ok_and(|ip| ip.is_loopback())
}

impl AiProvider {
    /// The provider migrated from `litellm_base_url`.
    pub fn litellm(base_url: &str) -> Self {
        AiProvider {
            id: LEGACY_ID.into(),
            name: "LiteLLM".into(),
            kind: ProviderKind::Litellm,
            base_url: base_url.trim().trim_end_matches('/').to_owned(),
            ..Default::default()
        }
    }

    /// A local Ollama at `base_url`.
    pub fn ollama(id: &str, base_url: &str) -> Self {
        AiProvider {
            id: id.into(),
            name: "Ollama".into(),
            kind: ProviderKind::Ollama,
            base_url: base_url.into(),
            local: true,
            bypass_proxy: true,
            ..Default::default()
        }
    }

    /// The base URL without the parts the client adds itself (`/v1` for LiteLLM and Ollama,
    /// `/openai` for Azure) and without a trailing slash.
    pub fn root(&self) -> String {
        let mut u = self.base_url.trim().trim_end_matches('/').to_owned();
        let strip: &[&str] = match self.kind {
            ProviderKind::Litellm => &["/v1"],
            ProviderKind::Ollama => &["/v1", "/api"],
            ProviderKind::Azure => &["/openai"],
            ProviderKind::Openai => &[],
        };
        for s in strip {
            if u.len() > s.len() && u[u.len() - s.len()..].eq_ignore_ascii_case(s) {
                u.truncate(u.len() - s.len());
                u = u.trim_end_matches('/').to_owned();
            }
        }
        u
    }

    fn api_version(&self) -> &str {
        match self.api_version.trim() {
            "" => AZURE_API_VERSION,
            v => v,
        }
    }

    /// `<…>/chat/completions` or `<…>/embeddings` for `model`.
    fn endpoint(&self, what: &str, model: &str) -> String {
        let root = self.root();
        match self.kind {
            ProviderKind::Litellm | ProviderKind::Ollama => format!("{root}/v1/{what}"),
            ProviderKind::Openai => format!("{root}/{what}"),
            ProviderKind::Azure => {
                let deployment = path_segment(model);
                format!("{root}/openai/deployments/{deployment}/{what}?api-version={}", self.api_version())
            }
        }
    }

    pub fn chat_url(&self, model: &str) -> String {
        self.endpoint("chat/completions", model)
    }

    pub fn embeddings_url(&self, model: &str) -> String {
        self.endpoint("embeddings", model)
    }

    /// The OpenAI-style model list; `None` for Azure (deployments cannot be listed with an API key).
    pub fn models_url(&self) -> Option<String> {
        let root = self.root();
        match self.kind {
            ProviderKind::Litellm | ProviderKind::Ollama => Some(format!("{root}/v1/models")),
            ProviderKind::Openai => Some(format!("{root}/models")),
            ProviderKind::Azure => None,
        }
    }

    /// Ollama's native API (`/api/tags`, `/api/pull`, `/api/version`).
    pub fn ollama_url(&self, path: &str) -> String {
        format!("{}/api/{path}", self.root())
    }

    /// Whether requests need a key: always for LiteLLM (virtual or master key), never for
    /// Ollama, for other APIs unless they run on this machine (LM Studio, vLLM).
    pub fn needs_key(&self) -> bool {
        match self.kind {
            ProviderKind::Litellm => true,
            ProviderKind::Ollama => false,
            _ => !is_loopback(&self.base_url),
        }
    }

    /// Adds the key: `api-key` for Azure, a bearer token otherwise.
    pub fn authorize(&self, req: reqwest::RequestBuilder, key: Option<&str>) -> reqwest::RequestBuilder {
        match (key.filter(|k| !k.is_empty()), self.kind) {
            (Some(k), ProviderKind::Azure) => req.header("api-key", k),
            (Some(k), _) => req.bearer_auth(k),
            (None, _) => req,
        }
    }

    /// The network settings for this provider: without proxy when it bypasses it.
    pub fn network(&self, net: &NetworkSettings) -> NetworkSettings {
        if self.bypass_proxy { NetworkSettings { mode: ProxyMode::None, ..net.clone() } } else { net.clone() }
    }

    /// Display name: the name, or the kind's label.
    pub fn display_name(&self) -> &str {
        match self.name.trim() {
            "" => self.kind.label(),
            n => n,
        }
    }
}

/// `s` percent-encoded for use as one URL path segment.
fn path_segment(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// `[a-z0-9-]` from a name: `Mistral AI` → `mistral-ai`.
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().to_lowercase().chars() {
        let plain = match c {
            'ä' => "a",
            'ö' => "o",
            'ü' => "u",
            'ß' => "ss",
            _ => "",
        };
        if !plain.is_empty() {
            out.push_str(plain);
        } else if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_end_matches('-').chars().take(40).collect()
}

/// Trims the providers, checks their addresses, gives each a unique id and a name, and drops
/// empty and duplicate hand-added model names.
pub fn normalize(list: Vec<AiProvider>) -> Result<Vec<AiProvider>> {
    let mut seen: Vec<String> = vec![];
    let mut out = vec![];
    for mut p in list {
        p.name = p.name.trim().to_owned();
        if p.name.is_empty() {
            p.name = p.kind.label().to_owned();
        }
        p.base_url = p.base_url.trim().trim_end_matches('/').to_owned();
        if p.kind == ProviderKind::Ollama && p.base_url.is_empty() {
            p.base_url = OLLAMA_URL.into();
        }
        let lower = p.base_url.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) || reqwest::Url::parse(&p.base_url).is_err()
        {
            return Err(Error::State(format!(
                "Die Adresse von „{}“ muss mit http:// oder https:// beginnen (z. B. https://api.openai.com/v1)",
                p.name
            )));
        }
        p.api_version = p.api_version.trim().to_owned();
        let mut models: Vec<String> = vec![];
        for m in p.models.iter().map(|m| m.trim()).filter(|m| !m.is_empty()) {
            if !models.iter().any(|x| x == m) {
                models.push(m.to_owned());
            }
        }
        p.models = models;
        let base = match slug(&p.id) {
            s if !s.is_empty() => s,
            _ => match slug(&p.name) {
                s if !s.is_empty() => s,
                _ => "anbieter".into(),
            },
        };
        let mut id = base.clone();
        let mut n = 2;
        while seen.contains(&id) {
            id = format!("{base}-{n}");
            n += 1;
        }
        seen.push(id.clone());
        p.id = id;
        out.push(p);
    }
    Ok(out)
}

/// Model names from an OpenAI-style `/models` answer (`{data: [{id}]}`) or Ollama's
/// `/api/tags` (`{models: [{name}]}`).
pub fn parse_model_list(v: &serde_json::Value) -> Vec<String> {
    let from = |arr: &serde_json::Value, key: &str| -> Vec<String> {
        arr.as_array()
            .map(|a| {
                a.iter().filter_map(|m| m[key].as_str().or_else(|| m["model"].as_str())).map(str::to_owned).collect()
            })
            .unwrap_or_default()
    };
    let mut out = from(&v["data"], "id");
    if out.is_empty() {
        out = from(&v["models"], "name");
    }
    out
}

/// One line of Ollama's `/api/pull` progress stream.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct PullProgress {
    pub status: String,
    #[serde(default)]
    pub total: Option<u64>,
    #[serde(default)]
    pub completed: Option<u64>,
    #[serde(default)]
    pub error: Option<String>,
}

/// The providers that are switched on, by id.
pub fn enabled_by_id(list: &[AiProvider]) -> HashMap<&str, &AiProvider> {
    list.iter().filter(|p| p.enabled).map(|p| (p.id.as_str(), p)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(kind: ProviderKind, url: &str) -> AiProvider {
        AiProvider { id: "x".into(), kind, base_url: url.into(), ..Default::default() }
    }

    #[test]
    fn endpoints_per_kind() {
        let l = p(ProviderKind::Litellm, "https://llm.firma.de/");
        assert_eq!(l.chat_url("m"), "https://llm.firma.de/v1/chat/completions");
        assert_eq!(l.models_url().unwrap(), "https://llm.firma.de/v1/models");
        let o = p(ProviderKind::Openai, "https://api.openai.com/v1");
        assert_eq!(o.chat_url("gpt-4o"), "https://api.openai.com/v1/chat/completions");
        assert_eq!(o.embeddings_url("e"), "https://api.openai.com/v1/embeddings");
        assert_eq!(o.models_url().unwrap(), "https://api.openai.com/v1/models");
        let ol = p(ProviderKind::Ollama, "http://localhost:11434/v1");
        assert_eq!(ol.chat_url("llama3.2"), "http://localhost:11434/v1/chat/completions");
        assert_eq!(ol.ollama_url("tags"), "http://localhost:11434/api/tags");
        let az =
            AiProvider { api_version: "".into(), ..p(ProviderKind::Azure, "https://firma.openai.azure.com/openai/") };
        assert_eq!(
            az.chat_url("gpt 4o"),
            format!(
                "https://firma.openai.azure.com/openai/deployments/gpt%204o/chat/completions?api-version={AZURE_API_VERSION}"
            )
        );
        assert_eq!(az.models_url(), None);
    }

    #[test]
    fn auth_header_style() {
        let http = reqwest::Client::new();
        let az = p(ProviderKind::Azure, "https://x.openai.azure.com");
        let r = az.authorize(http.get("http://x/"), Some("k1")).build().unwrap();
        assert_eq!(r.headers()["api-key"], "k1");
        assert!(r.headers().get("authorization").is_none());
        let o = p(ProviderKind::Openai, "https://api.openai.com/v1");
        let r = o.authorize(http.get("http://x/"), Some("k2")).build().unwrap();
        assert_eq!(r.headers()["authorization"], "Bearer k2");
        let r = o.authorize(http.get("http://x/"), Some("")).build().unwrap();
        assert!(r.headers().get("authorization").is_none());
    }

    #[test]
    fn loopback_and_keys() {
        assert!(is_loopback("http://localhost:11434"));
        assert!(is_loopback("http://127.0.0.1:1234/v1"));
        assert!(is_loopback("http://[::1]:8000"));
        assert!(!is_loopback("https://api.openai.com/v1"));
        assert!(!p(ProviderKind::Ollama, "http://gpu-server:11434").needs_key());
        assert!(p(ProviderKind::Litellm, "http://localhost:4000").needs_key());
        assert!(!p(ProviderKind::Openai, "http://localhost:1234/v1").needs_key());
        assert!(p(ProviderKind::Openai, "https://api.groq.com/openai/v1").needs_key());
    }

    #[test]
    fn local_providers_bypass_the_proxy() {
        let net = NetworkSettings { mode: ProxyMode::Manual, http_proxy: "proxy:8080".into(), ..Default::default() };
        let ollama = AiProvider::ollama("ollama", OLLAMA_URL);
        assert_eq!(ollama.network(&net).mode, ProxyMode::None);
        assert_eq!(ollama.network(&net).http_proxy, "proxy:8080", "only the mode changes");
        assert_eq!(AiProvider::litellm("http://127.0.0.1:4000").network(&net).mode, ProxyMode::Manual);
    }

    #[test]
    fn normalize_ids_names_and_urls() {
        let got = normalize(vec![
            AiProvider {
                name: " Mistral AI ".into(),
                base_url: "https://api.mistral.ai/v1/".into(),
                ..Default::default()
            },
            AiProvider {
                name: "Mistral AI".into(),
                base_url: "https://api.mistral.ai/v1".into(),
                ..Default::default()
            },
            AiProvider {
                kind: ProviderKind::Ollama,
                models: vec![" a ".into(), "a".into(), "".into()],
                ..Default::default()
            },
            AiProvider::litellm("http://localhost:4000"),
        ])
        .unwrap();
        let ids: Vec<&str> = got.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["mistral-ai", "mistral-ai-2", "ollama", LEGACY_ID]);
        assert_eq!(got[0].base_url, "https://api.mistral.ai/v1");
        assert_eq!((got[2].name.as_str(), got[2].base_url.as_str()), ("Ollama", OLLAMA_URL));
        assert_eq!(got[2].models, ["a"]);
        let bad = AiProvider { name: "X".into(), base_url: "ftp://x".into(), ..Default::default() };
        assert!(normalize(vec![bad]).unwrap_err().to_string().contains("„X“"));
        assert_eq!(slug("Größe & Straße"), "grosse-strasse");
    }

    #[test]
    fn unknown_kinds_load_as_openai_compatible() {
        let p: AiProvider =
            serde_json::from_str(r#"{"id":"a","kind":"anthropic-native","base_url":"https://x"}"#).unwrap();
        assert_eq!((p.kind, p.enabled, p.local), (ProviderKind::Openai, true, false));
    }

    #[test]
    fn model_lists_of_both_apis() {
        let openai = serde_json::json!({"data":[{"id":"gpt-4o"},{"id":"text-embedding-3-small"}]});
        assert_eq!(parse_model_list(&openai), ["gpt-4o", "text-embedding-3-small"]);
        let tags = serde_json::json!({"models":[{"name":"llama3.2:latest","size":1},{"model":"nomic-embed-text"}]});
        assert_eq!(parse_model_list(&tags), ["llama3.2:latest", "nomic-embed-text"]);
    }
}
