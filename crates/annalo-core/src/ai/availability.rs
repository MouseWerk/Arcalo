//! Models the providers actually offer, and where a request goes when its model cannot answer.
//! A tier's model that its provider does not have (a placeholder never changed in the settings,
//! a renamed model group) is replaced by another configured model, so "Automatisch" does not
//! fail on short questions; a provider that cannot be reached hands over to the next one.
//!
//! Private content (a privacy marker, or Settings → Datenschutz „Nur lokal“) is the exception:
//! it only goes to the model of the local tier or to providers marked local, or is not sent.

use std::collections::HashMap;

use super::provider::AiProvider;
use super::router::{ModelRef, RouteDecision, RouterConfig, Tier};

/// The configured providers and the models each one lists (empty = unknown: it does not list
/// them or could not be asked).
#[derive(Debug, Clone, Default)]
pub struct Catalog {
    pub providers: Vec<AiProvider>,
    pub models: HashMap<String, Vec<String>>,
}

impl Catalog {
    pub fn new(providers: Vec<AiProvider>, models: HashMap<String, Vec<String>>) -> Self {
        Catalog { providers, models }
    }

    /// The provider `id` if it is switched on.
    pub fn provider(&self, id: &str) -> Option<&AiProvider> {
        self.providers.iter().find(|p| p.enabled && p.id == id)
    }

    fn first_enabled(&self) -> Option<&AiProvider> {
        self.providers.iter().find(|p| p.enabled)
    }

    /// `r` with an empty provider (settings of older versions) resolved to the first provider.
    pub fn canonical(&self, r: ModelRef) -> ModelRef {
        if r.provider.is_empty()
            && let Some(p) = self.first_enabled()
        {
            return ModelRef { provider: p.id.clone(), ..r };
        }
        r
    }

    /// Display name of a provider (its id when unknown).
    pub fn name<'a>(&'a self, id: &'a str) -> &'a str {
        self.providers.iter().find(|p| p.id == id).map(AiProvider::display_name).unwrap_or(id)
    }

    fn listed(&self, id: &str) -> &[String] {
        self.models.get(id).map(Vec::as_slice).unwrap_or_default()
    }

    /// Whether `r` can be asked: its provider is on and lists the model (or lists nothing).
    pub fn offers(&self, r: &ModelRef) -> bool {
        let listed = self.listed(&r.provider);
        !r.model.is_empty() && self.provider(&r.provider).is_some() && (listed.is_empty() || listed.contains(&r.model))
    }

    /// `provider · model` for messages; the model alone when there is only one provider.
    pub fn label(&self, r: &ModelRef) -> String {
        if self.providers.len() <= 1 { r.model.clone() } else { format!("{} · {}", r.model, self.name(&r.provider)) }
    }
}

/// Models and providers a request must not go to (again).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Exclude {
    pub models: Vec<ModelRef>,
    /// Providers that could not be reached.
    pub providers: Vec<String>,
}

impl Exclude {
    fn blocks(&self, r: &ModelRef) -> bool {
        self.models.contains(r) || self.providers.contains(&r.provider)
    }
}

/// The configured models in the order they stand in for `tier`.
fn preference(config: &RouterConfig, tier: Tier) -> [ModelRef; 3] {
    let [l, s, r] = [Tier::Local, Tier::Standard, Tier::Reasoning].map(|t| config.tier_ref(t));
    match tier {
        Tier::Local => [l, s, r],
        Tier::Standard => [s, r, l],
        Tier::Reasoning => [r, s, l],
    }
}

/// Embedding models cannot answer chat requests.
fn chat_capable(model: &str) -> bool {
    super::capability::chat_capable(model, None)
}

/// Whether private content may go to `r`: the local tier's model (the user's explicit choice
/// for confidential content) or any model of a provider marked local.
pub fn private_allowed(config: &RouterConfig, catalog: &Catalog, r: &ModelRef) -> bool {
    catalog.provider(&r.provider).is_some_and(|p| p.local) || *r == catalog.canonical(config.tier_ref(Tier::Local))
}

/// A model that can stand in for `tier`, skipping `exclude`: first the other configured
/// models, then any chat model of a provider (the tier's own provider first). With `private`,
/// only models [`private_allowed`] qualify.
pub fn fallback(
    config: &RouterConfig,
    tier: Tier,
    catalog: &Catalog,
    exclude: &Exclude,
    private: bool,
) -> Option<ModelRef> {
    let usable =
        |r: &ModelRef| !exclude.blocks(r) && catalog.offers(r) && (!private || private_allowed(config, catalog, r));
    let prefs = preference(config, tier).map(|r| catalog.canonical(r));
    if let Some(r) = prefs.iter().find(|r| usable(r)) {
        return Some(r.clone());
    }
    let own = &prefs[0].provider;
    let mut order: Vec<&AiProvider> = catalog.providers.iter().filter(|p| p.enabled).collect();
    order.sort_by_key(|p| p.id != *own);
    order
        .into_iter()
        .flat_map(|p| catalog.listed(&p.id).iter().filter(|m| chat_capable(m)).map(|m| ModelRef::new(&p.id, m)))
        .find(|r| usable(r))
}

/// Why a request must not leave the local model: a private marker or Settings → Datenschutz.
pub fn local_required(route: &RouteDecision, local_only: bool) -> bool {
    route.tier == Tier::Local && (local_only || route.reasons.iter().any(|r| r.starts_with("private marker")))
}

/// Checks `route` against what the providers offer. Returns the route to use (provider filled
/// in, a substitution among its reasons) or the message why none can be used.
pub fn resolve(
    config: &RouterConfig,
    route: &RouteDecision,
    catalog: &Catalog,
    local_only: bool,
) -> std::result::Result<RouteDecision, String> {
    if catalog.first_enabled().is_none() {
        return Err("Kein KI-Anbieter eingerichtet: füge unter Einstellungen → KI einen Anbieter hinzu.".into());
    }
    let wanted = catalog.canonical(ModelRef::new(&route.provider, &route.model));
    let mut out = RouteDecision { provider: wanted.provider.clone(), ..route.clone() };
    let private = local_required(route, local_only);
    if catalog.offers(&wanted) && (!private || private_allowed(config, catalog, &wanted)) {
        return Ok(out);
    }
    let name = catalog.name(&wanted.provider);
    let why = if catalog.provider(&wanted.provider).is_none() {
        format!("Anbieter „{name}“ ist ausgeschaltet oder fehlt")
    } else {
        format!("„{}“ gibt es bei {name} nicht", wanted.model)
    };
    let exclude = Exclude { models: vec![wanted.clone()], providers: vec![] };
    match fallback(config, route.tier, catalog, &exclude, private) {
        Some(r) => {
            out.reasons.push(format!("{why} → {}", catalog.label(&r)));
            out.provider = r.provider;
            out.model = r.model;
            Ok(out)
        }
        None if private => Err(format!(
            "Das lokale Modell „{}“ gibt es auf dem {name}-Server nicht. Vertrauliche Inhalte bleiben lokal: \
             wähle unter Einstellungen → KI ein Modell für die Stufe Lokal oder markiere einen Anbieter als lokal.",
            wanted.model
        )),
        None => Err(format!("Kein KI-Anbieter bietet ein Chat-Modell an (gewählt war „{}“).", wanted.model)),
    }
}

/// Whether a provider error means the server has no usable deployment of the requested model
/// (unknown name, or every deployment is cooling down after failures).
pub fn model_unavailable(status: u16, body: &str) -> bool {
    let b = body.to_lowercase();
    b.contains("no deployments available")
        || b.contains("invalid model name")
        || b.contains("model_not_found")
        || b.contains("deploymentnotfound")
        || (status == 404 && b.contains("model"))
        || (b.contains("model") && (b.contains("does not exist") || b.contains("not found")))
}

/// Whether a request failed because the provider could not be reached at all (connection
/// refused, DNS, TLS, connect timeout): the next provider is tried, not another model here.
pub fn unreachable(e: &crate::Error) -> bool {
    matches!(e, crate::Error::Http(e) if e.is_connect() || (e.is_timeout() && !e.is_body()))
}

/// Longest cooldown worth waiting for on the same model; a longer one moves on to another model.
pub const MAX_COOLDOWN_WAIT_SECS: u64 = 10;

/// The seconds LiteLLM asks to wait when every deployment of a model group cools down after
/// failures („No deployments available for selected model, Try again in 5 seconds … cooldown_list=[…]“).
/// `None` for other errors, and for waits longer than [`MAX_COOLDOWN_WAIT_SECS`] (an unknown
/// model group or a long cooldown: another model answers sooner).
pub fn cooldown_wait(status: u16, body: &str) -> Option<u64> {
    let b = body.to_lowercase();
    if !(status == 429 || b.contains("cooldown_list")) || !b.contains("no deployments available") {
        return None;
    }
    let rest = &b[b.find("try again in ")? + "try again in ".len()..];
    let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let secs: u64 = digits.parse().ok()?;
    let unit = rest[digits.len()..].trim_start();
    (unit.starts_with("second") || unit.starts_with("sec"))
        .then_some(secs.max(1))
        .filter(|s| *s <= MAX_COOLDOWN_WAIT_SECS)
}

/// Whether the server rejects the tool definitions of the request. vLLM started without
/// `--enable-auto-tool-choice` answers 400 „"auto" tool choice requires --enable-auto-tool-choice
/// and --tool-call-parser to be set“ to every request with tools.
fn tools_rejected(b: &str) -> bool {
    b.contains("enable-auto-tool-choice")
        || b.contains("tool-call-parser")
        || b.contains("tool choice requires")
        || b.contains("tool_choice is not supported")
        || b.contains("tools are not supported")
        || b.contains("tool use is not supported")
}

/// What to do after a failed request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retry {
    /// The model rejects parameters of the request: repeat it on the same model without them.
    Without { tools: bool, temperature: bool },
    /// The model's deployments cool down for a few seconds: wait and ask the same model again.
    Wait { seconds: u64 },
    /// The model cannot answer right now (unknown, cooling down, its backend is down): try another.
    OtherModel,
    /// A real error (wrong key, bad request, cost limit): show it.
    No,
}

/// Classifies a provider error. The chat sends tools and a temperature, the rewrite requests do
/// not: a model (or LiteLLM without `drop_params`) that does not support them fails only in the
/// chat, so those are dropped first. Server errors (5xx: the model's backend is unreachable,
/// e.g. a local Ollama that is not running) move on to another model.
pub fn retry_for(status: u16, body: &str, has_tools: bool, has_temperature: bool) -> Retry {
    let b = body.to_lowercase();
    if has_tools && tools_rejected(&b) {
        return Retry::Without { tools: true, temperature: false };
    }
    let unsupported = b.contains("unsupportedparams")
        || b.contains("not support")
        || b.contains("unsupported")
        || b.contains("not supported")
        || b.contains("does not accept")
        || b.contains("drop_params");
    if unsupported {
        let tools = has_tools && (b.contains("tool") || b.contains("function"));
        let temperature = has_temperature && b.contains("temperature");
        if tools || temperature {
            return Retry::Without { tools, temperature };
        }
    }
    if let Some(seconds) = cooldown_wait(status, body) {
        return Retry::Wait { seconds };
    }
    if model_unavailable(status, body) || status >= 500 || status == 408 {
        return Retry::OtherModel;
    }
    Retry::No
}

/// A note for the answer when the request fell back from `from` to `to`, a model of the local
/// tier or of a local provider while `from` was not: usually a much smaller model, so the answer
/// may be weaker than usual. `None` when the fallback is of the same kind.
pub fn weaker_fallback_note(
    config: &RouterConfig,
    catalog: &Catalog,
    from: &ModelRef,
    to: &ModelRef,
) -> Option<String> {
    let local_tier = catalog.canonical(config.tier_ref(Tier::Local));
    let small = |r: &ModelRef| *r == local_tier || catalog.provider(&r.provider).is_some_and(|p| p.local);
    (small(to) && !small(from)).then(|| {
        format!(
            "Ausweichmodell „{}“ ist ein kleineres lokales Modell: die Antwort kann schwächer sein als mit „{}“",
            catalog.label(to),
            from.model
        )
    })
}

/// The message shown when the server has no usable deployment of `model`.
pub fn unavailable_message(model: &str, body: &str) -> String {
    let detail: String = body.chars().take(300).collect();
    format!(
        "Der KI-Server hat für das Modell „{model}“ gerade keine erreichbare Instanz. Entweder fehlt es in der \
         Konfiguration des Anbieters, oder alle Instanzen pausieren nach Fehlern (Cooldown, z. B. falscher Anbieter-Schlüssel \
         oder Ratenlimit). Wähle unter Einstellungen → KI ein anderes Modell oder prüfe den Server.\n\nServer: {detail}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::ProviderKind;

    fn config() -> RouterConfig {
        RouterConfig {
            local_model: "ollama/llama3.2".into(),
            standard_model: "gpt-firma".into(),
            reasoning_model: "cloud-reasoning".into(),
            ..Default::default()
        }
    }

    fn route(tier: Tier, model: &str, reasons: &[&str]) -> RouteDecision {
        RouteDecision {
            tier,
            provider: "litellm".into(),
            model: model.into(),
            score: 0,
            reasons: reasons.iter().map(|r| r.to_string()).collect(),
        }
    }

    fn models(m: &[&str]) -> Vec<String> {
        m.iter().map(|s| s.to_string()).collect()
    }

    /// Only the LiteLLM provider (settings migrated from an older version).
    fn litellm(m: &[&str]) -> Catalog {
        Catalog::new(
            vec![AiProvider::litellm("http://localhost:4000")],
            HashMap::from([("litellm".to_string(), models(m))]),
        )
    }

    /// An Ollama marked local and an OpenAI account.
    fn two() -> (RouterConfig, Catalog) {
        let config = RouterConfig {
            local_provider: "ollama".into(),
            local_model: "llama3.2".into(),
            standard_provider: "openai".into(),
            standard_model: "gpt-4o".into(),
            reasoning_provider: "openai".into(),
            reasoning_model: "o3".into(),
            ..Default::default()
        };
        let openai = AiProvider {
            id: "openai".into(),
            name: "OpenAI".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            ..Default::default()
        };
        let catalog = Catalog::new(
            vec![AiProvider::ollama("ollama", "http://localhost:11434"), openai],
            HashMap::from([
                ("ollama".to_string(), models(&["llama3.2", "qwen2.5", "nomic-embed-text"])),
                ("openai".to_string(), models(&["gpt-4o", "o3", "text-embedding-3-small"])),
            ]),
        );
        (config, catalog)
    }

    #[test]
    fn a_missing_local_model_falls_back_to_a_configured_one_the_server_has() {
        let got = resolve(
            &config(),
            &route(Tier::Local, "ollama/llama3.2", &[]),
            &litellm(&["gpt-firma", "text-embedding-3"]),
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
            &litellm(&["text-embedding-3", "azure-gpt-4o"]),
            false,
        )
        .unwrap();
        assert_eq!(got.model, "azure-gpt-4o", "embedding models are skipped");
    }

    #[test]
    fn unsupported_tools_or_temperature_are_dropped_first() {
        let body = r#"{"error":{"message":"litellm.UnsupportedParamsError: ollama does not support parameters: ['tools']. To drop these, set `litellm.drop_params=True`"}}"#;
        assert_eq!(retry_for(400, body, true, true), Retry::Without { tools: true, temperature: false });
        let body = "Unsupported value: 'temperature' does not support 0.3 with this model. Only the default (1) value is supported.";
        assert_eq!(retry_for(400, body, true, true), Retry::Without { tools: false, temperature: true });
        let body = "This model does not support function calling";
        assert_eq!(retry_for(400, body, true, true), Retry::Without { tools: true, temperature: false });
        // Ollama's own wording.
        let body = r#"{"error":"registry.ollama.ai/library/gemma:2b does not support tools"}"#;
        assert_eq!(retry_for(400, body, true, true), Retry::Without { tools: true, temperature: false });
        // Already without them: nothing left to drop.
        assert_eq!(retry_for(400, "This model does not support function calling", false, true), Retry::No);
    }

    #[test]
    fn unreachable_backends_try_another_model_real_errors_do_not() {
        assert_eq!(retry_for(500, "OllamaException - [Errno 111] Connection refused", true, true), Retry::OtherModel);
        assert_eq!(retry_for(429, "No deployments available for selected model", false, true), Retry::OtherModel);
        assert_eq!(
            retry_for(404, r#"{"error":"model \"x\" not found, try pulling it first"}"#, false, true),
            Retry::OtherModel
        );
        assert_eq!(retry_for(401, "Authentication Error, Invalid proxy server token passed", true, true), Retry::No);
        assert_eq!(retry_for(400, "context_length_exceeded", true, true), Retry::No);
    }

    #[test]
    fn a_short_litellm_cooldown_is_waited_out() {
        // Exactly as LiteLLM answered in the reported case.
        let body = r#"{"error":{"message":"No deployments available for selected model, Try again in 5 seconds. Passed model=vllmserver. pre-call-checks=False, cooldown_list=['a5b2301f82622b399c08055cfc4a8ca54ad899d7699f16d8fca8e89cefc957dd']","type":"None","param":"None","code":"429"}}"#;
        assert_eq!(cooldown_wait(429, body), Some(5));
        assert_eq!(retry_for(429, body, true, true), Retry::Wait { seconds: 5 });
        // A long cooldown or an unknown model group: another model answers sooner.
        let long = "No deployments available for selected model, Try again in 60 seconds. Passed model=gpt-4o";
        assert_eq!(cooldown_wait(429, long), None);
        assert_eq!(retry_for(429, long, false, true), Retry::OtherModel);
        assert_eq!(cooldown_wait(429, "No deployments available for selected model"), None);
        assert_eq!(cooldown_wait(429, "Rate limit reached. Try again in 5 seconds"), None);
        assert_eq!(cooldown_wait(429, "No deployments available, try again in 0 seconds"), Some(1));
        assert_eq!(cooldown_wait(429, "No deployments available, try again in 3 minutes"), None);
    }

    #[test]
    fn vllm_without_auto_tool_choice_is_repeated_without_tools() {
        let body = r#"{"error":{"message":"litellm.BadRequestError: Hosted_vllmException - \"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set. Received Model Group=vllmserver","code":"400"}}"#;
        assert_eq!(retry_for(400, body, true, true), Retry::Without { tools: true, temperature: false });
        // Without tools in the request the same text is a real error.
        assert_eq!(retry_for(400, body, false, true), Retry::No);
        let direct = r#"{"object":"error","message":"\"auto\" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set","type":"BadRequestError","code":400}"#;
        assert_eq!(retry_for(400, direct, true, false), Retry::Without { tools: true, temperature: false });
    }

    #[test]
    fn a_fallback_to_a_small_local_model_is_noted() {
        let (config, catalog) = two();
        let gpt = ModelRef::new("openai", "gpt-4o");
        let llama = ModelRef::new("ollama", "llama3.2");
        let note = weaker_fallback_note(&config, &catalog, &gpt, &llama).unwrap();
        assert!(note.contains("llama3.2") && note.contains("gpt-4o"), "{note}");
        assert_eq!(weaker_fallback_note(&config, &catalog, &gpt, &ModelRef::new("openai", "o3")), None);
        assert_eq!(weaker_fallback_note(&config, &catalog, &llama, &ModelRef::new("ollama", "qwen2.5")), None);
    }

    #[test]
    fn present_models_and_unknown_lists_are_left_alone() {
        let r = route(Tier::Reasoning, "cloud-reasoning", &[]);
        assert_eq!(resolve(&config(), &r, &litellm(&["cloud-reasoning"]), false).unwrap(), r);
        assert_eq!(resolve(&config(), &r, &litellm(&[]), false).unwrap(), r);
    }

    #[test]
    fn private_content_never_leaves_the_local_model() {
        let r = route(Tier::Local, "ollama/llama3.2", &["private marker found: kept on the local model"]);
        let err = resolve(&config(), &r, &litellm(&["gpt-firma"]), false).unwrap_err();
        assert!(err.contains("lokal") && err.contains("auf dem LiteLLM-Server"), "{err}");
        let plain = route(Tier::Local, "ollama/llama3.2", &[]);
        assert!(resolve(&config(), &plain, &litellm(&["gpt-firma"]), true).is_err(), "Datenschutz: nur lokal");
    }

    #[test]
    fn recognizes_model_errors() {
        let body = r#"{"error":{"message":"No deployments available for selected model, Try again in 60 seconds. Passed model=gpt-4o","code":"429"}}"#;
        assert!(model_unavailable(429, body));
        assert!(model_unavailable(400, r#"{"error":{"message":"Invalid model name passed in model=foo"}}"#));
        assert!(model_unavailable(404, r#"{"error":{"code":"DeploymentNotFound"}}"#));
        assert!(!model_unavailable(401, r#"{"error":{"message":"Authentication Error, Invalid proxy server token"}}"#));
        assert!(unavailable_message("gpt-4o", body).contains("„gpt-4o“"));
    }

    #[test]
    fn fallback_skips_the_failed_model() {
        let catalog = litellm(&["gpt-firma", "cloud-reasoning"]);
        let ex = |m: &str| Exclude { models: vec![ModelRef::new("litellm", m)], providers: vec![] };
        let got = fallback(&config(), Tier::Standard, &catalog, &ex("gpt-firma"), false);
        assert_eq!(got, Some(ModelRef::new("litellm", "cloud-reasoning")));
        assert_eq!(fallback(&config(), Tier::Standard, &litellm(&["gpt-firma"]), &ex("gpt-firma"), false), None);
    }

    #[test]
    fn routes_to_the_tiers_provider_and_old_settings_to_the_first() {
        let (config, catalog) = two();
        let r = RouteDecision { provider: "openai".into(), ..route(Tier::Standard, "gpt-4o", &[]) };
        assert_eq!(resolve(&config, &r, &catalog, false).unwrap().provider, "openai");
        // No provider (settings of an older version): the first provider.
        let r = RouteDecision { provider: "".into(), ..route(Tier::Local, "llama3.2", &[]) };
        assert_eq!(resolve(&config, &r, &catalog, false).unwrap().provider, "ollama");
        // A provider that is switched off hands over to the next configured model.
        let mut off = catalog.clone();
        off.providers[1].enabled = false;
        let r = RouteDecision { provider: "openai".into(), ..route(Tier::Standard, "gpt-4o", &[]) };
        let got = resolve(&config, &r, &off, false).unwrap();
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("ollama", "llama3.2"));
        assert!(got.reasons.last().unwrap().contains("ausgeschaltet"));
    }

    #[test]
    fn an_unreachable_provider_hands_over_to_the_next() {
        let (config, catalog) = two();
        let down = Exclude { models: vec![], providers: vec!["ollama".into()] };
        // Local tier on a stopped Ollama: the configured standard model elsewhere.
        assert_eq!(fallback(&config, Tier::Local, &catalog, &down, false), Some(ModelRef::new("openai", "gpt-4o")));
        // Both down: nothing left.
        let all = Exclude { models: vec![], providers: vec!["ollama".into(), "openai".into()] };
        assert_eq!(fallback(&config, Tier::Standard, &catalog, &all, false), None);
    }

    #[test]
    fn private_content_only_goes_to_local_providers() {
        let (config, catalog) = two();
        let private = route(Tier::Local, "llama3.2", &["private marker found: kept on the local model"]);
        let private = RouteDecision { provider: "ollama".into(), ..private };
        assert!(local_required(&private, false));
        assert_eq!(resolve(&config, &private, &catalog, false).unwrap().provider, "ollama");
        // Ollama down: never OpenAI, even though it is configured and reachable.
        let down = Exclude { models: vec![], providers: vec!["ollama".into()] };
        assert_eq!(fallback(&config, Tier::Local, &catalog, &down, true), None);
        // The local model missing on Ollama: another model of Ollama, not OpenAI.
        let mut missing = catalog.clone();
        missing.models.insert("ollama".into(), models(&["qwen2.5"]));
        let got = resolve(&config, &private, &missing, false).unwrap();
        assert_eq!((got.provider.as_str(), got.model.as_str()), ("ollama", "qwen2.5"));
        // „Nur lokal“ behaves the same without a marker.
        let plain = RouteDecision { provider: "ollama".into(), ..route(Tier::Local, "llama3.2", &[]) };
        assert_eq!(fallback(&config, Tier::Local, &catalog, &down, local_required(&plain, true)), None);
        // Without privacy the same failure may go to OpenAI.
        assert!(fallback(&config, Tier::Local, &catalog, &down, local_required(&plain, false)).is_some());
        // The local tier's own model is trusted (the user's explicit choice), other models of a
        // provider that is not marked local are not.
        assert!(private_allowed(&config, &catalog, &ModelRef::new("ollama", "llama3.2")));
        let cloud_local =
            RouterConfig { local_provider: "openai".into(), local_model: "gpt-4o".into(), ..config.clone() };
        assert!(private_allowed(&cloud_local, &catalog, &ModelRef::new("openai", "gpt-4o")));
        assert!(!private_allowed(&cloud_local, &catalog, &ModelRef::new("openai", "o3")));
    }

    #[test]
    fn no_provider_is_a_clear_error() {
        let empty = Catalog::default();
        assert!(
            resolve(&config(), &route(Tier::Standard, "x", &[]), &empty, false)
                .unwrap_err()
                .contains("Kein KI-Anbieter")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_errors_count_as_unreachable() {
        // A port nobody listens on.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let err = reqwest::Client::new().get(format!("http://127.0.0.1:{port}/v1/models")).send().await.unwrap_err();
        assert!(unreachable(&crate::Error::Http(err)));
        assert!(!unreachable(&crate::Error::Provider { status: 500, body: "x".into() }));
    }
}
