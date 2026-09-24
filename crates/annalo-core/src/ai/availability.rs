//! Models the LiteLLM server actually offers. A tier's model that the server does not have
//! (a placeholder never changed in the settings, a renamed model group) is replaced by another
//! configured model the server has, so "Automatisch" does not fail on short questions. Private
//! content is the exception: it stays on the local model or is not sent at all.

use super::router::{RouteDecision, RouterConfig, Tier};

/// The configured models in the order they stand in for `tier`.
fn preference(config: &RouterConfig, tier: Tier) -> [&str; 3] {
    let (l, s, r) = (config.local_model.as_str(), config.standard_model.as_str(), config.reasoning_model.as_str());
    match tier {
        Tier::Local => [l, s, r],
        Tier::Standard => [s, r, l],
        Tier::Reasoning => [r, s, l],
    }
}

/// Embedding models cannot answer chat requests.
fn chat_capable(model: &str) -> bool {
    !model.to_lowercase().contains("embed")
}

/// A model the server offers that can stand in for `tier`, skipping `exclude`: first the other
/// configured models, then any chat model of the server.
pub fn fallback(config: &RouterConfig, tier: Tier, available: &[String], exclude: &[&str]) -> Option<String> {
    let usable = |m: &str| !m.is_empty() && !exclude.contains(&m) && available.iter().any(|a| a == m);
    preference(config, tier)
        .into_iter()
        .find(|m| usable(m))
        .map(str::to_owned)
        .or_else(|| available.iter().find(|m| chat_capable(m) && !exclude.contains(&m.as_str())).cloned())
}

/// Why a request must not leave the local model: a private marker or Settings → Datenschutz.
pub fn local_required(route: &RouteDecision, local_only: bool) -> bool {
    route.tier == Tier::Local && (local_only || route.reasons.iter().any(|r| r.starts_with("private marker")))
}

/// Checks `route` against the models the server offers (`available`, empty = unknown). Returns
/// the route to use, with the substitution among its reasons, or the message why none can be used.
pub fn resolve(
    config: &RouterConfig,
    route: &RouteDecision,
    available: &[String],
    local_only: bool,
) -> std::result::Result<RouteDecision, String> {
    if available.is_empty() || available.contains(&route.model) {
        return Ok(route.clone());
    }
    if local_required(route, local_only) {
        return Err(format!(
            "Das lokale Modell „{}“ gibt es auf dem LiteLLM-Server nicht. Vertrauliche Inhalte bleiben lokal: \
             wähle unter Einstellungen → KI & LiteLLM ein lokales Modell des Servers.",
            route.model
        ));
    }
    match fallback(config, route.tier, available, &[&route.model]) {
        Some(model) => {
            let mut out = route.clone();
            out.reasons.push(format!("„{}“ gibt es auf dem Server nicht → {model}", route.model));
            out.model = model;
            Ok(out)
        }
        None => Err(format!("Der LiteLLM-Server bietet kein Chat-Modell an (gewählt war „{}“).", route.model)),
    }
}

/// Whether a provider error means the server has no usable deployment of the requested model
/// (unknown name, or every deployment is cooling down after failures).
pub fn model_unavailable(status: u16, body: &str) -> bool {
    let b = body.to_lowercase();
    b.contains("no deployments available")
        || b.contains("invalid model name")
        || b.contains("model_not_found")
        || (status == 404 && b.contains("model"))
        || (b.contains("model") && b.contains("does not exist"))
}

/// The message shown when the server has no usable deployment of `model`.
pub fn unavailable_message(model: &str, body: &str) -> String {
    let detail: String = body.chars().take(300).collect();
    format!(
        "Der LiteLLM-Server hat für das Modell „{model}“ gerade keine erreichbare Instanz. Entweder fehlt es in der \
         LiteLLM-Konfiguration, oder alle Instanzen pausieren nach Fehlern (Cooldown, z. B. falscher Anbieter-Schlüssel \
         oder Ratenlimit). Wähle unter Einstellungen → KI & LiteLLM ein anderes Modell oder prüfe den Server.\n\nServer: {detail}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> RouterConfig {
        RouterConfig {
            local_model: "ollama/llama3.2".into(),
            standard_model: "gpt-firma".into(),
            reasoning_model: "cloud-reasoning".into(),
            ..Default::default()
        }
    }

    fn route(tier: Tier, model: &str, reasons: &[&str]) -> RouteDecision {
        RouteDecision { tier, model: model.into(), score: 0, reasons: reasons.iter().map(|r| r.to_string()).collect() }
    }

    fn models(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_missing_local_model_falls_back_to_a_configured_one_the_server_has() {
        let got = resolve(
            &config(),
            &route(Tier::Local, "ollama/llama3.2", &[]),
            &models(&["gpt-firma", "text-embedding-3"]),
            false,
        )
        .unwrap();
        assert_eq!(got.model, "gpt-firma");
        assert!(got.reasons.last().unwrap().contains("ollama/llama3.2"));
    }

    #[test]
    fn nothing_configured_exists_uses_a_chat_model_of_the_server() {
        let got = resolve(
            &config(),
            &route(Tier::Standard, "gpt-firma", &[]),
            &models(&["text-embedding-3", "azure-gpt-4o"]),
            false,
        )
        .unwrap();
        assert_eq!(got.model, "azure-gpt-4o", "embedding models are skipped");
    }

    #[test]
    fn present_models_and_unknown_lists_are_left_alone() {
        let r = route(Tier::Reasoning, "cloud-reasoning", &[]);
        assert_eq!(resolve(&config(), &r, &models(&["cloud-reasoning"]), false).unwrap(), r);
        assert_eq!(resolve(&config(), &r, &[], false).unwrap(), r);
    }

    #[test]
    fn private_content_never_leaves_the_local_model() {
        let r = route(Tier::Local, "ollama/llama3.2", &["private marker found: kept on the local model"]);
        assert!(resolve(&config(), &r, &models(&["gpt-firma"]), false).unwrap_err().contains("lokal"));
        let plain = route(Tier::Local, "ollama/llama3.2", &[]);
        assert!(resolve(&config(), &plain, &models(&["gpt-firma"]), true).is_err(), "Datenschutz: nur lokal");
    }

    #[test]
    fn recognizes_litellm_model_errors() {
        let body = r#"{"error":{"message":"No deployments available for selected model, Try again in 60 seconds. Passed model=gpt-4o","code":"429"}}"#;
        assert!(model_unavailable(429, body));
        assert!(model_unavailable(400, r#"{"error":{"message":"Invalid model name passed in model=foo"}}"#));
        assert!(!model_unavailable(401, r#"{"error":{"message":"Authentication Error, Invalid proxy server token"}}"#));
        assert!(unavailable_message("gpt-4o", body).contains("„gpt-4o“"));
    }

    #[test]
    fn fallback_skips_the_failed_model() {
        let got = fallback(&config(), Tier::Standard, &models(&["gpt-firma", "cloud-reasoning"]), &["gpt-firma"]);
        assert_eq!(got.as_deref(), Some("cloud-reasoning"));
        assert_eq!(fallback(&config(), Tier::Standard, &models(&["gpt-firma"]), &["gpt-firma"]), None);
    }
}
