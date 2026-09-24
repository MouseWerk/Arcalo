//! Dynamic model router: picks a model tier from the prompt's complexity.
//!
//! The score is a transparent heuristic (length, code, reasoning verbs,
//! context size, tool use) so the UI can show *why* a model was chosen.
//! Content marked private is always kept on the local model.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Local runtime (Ollama / vLLM): free, private, fast for small tasks.
    Local,
    /// General-purpose cloud model.
    Standard,
    /// Strongest (and most expensive) reasoning model.
    Reasoning,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouterConfig {
    pub local_model: String,
    pub standard_model: String,
    pub reasoning_model: String,
    /// Scores at or above this go to the standard tier.
    pub standard_threshold: u32,
    /// Scores at or above this go to the reasoning tier.
    pub reasoning_threshold: u32,
    /// Markers that force local processing (case-insensitive).
    pub private_markers: Vec<String>,
}

impl Default for RouterConfig {
    fn default() -> Self {
        RouterConfig {
            local_model: "ollama/llama3.2".into(),
            standard_model: "cloud-standard".into(),
            reasoning_model: "cloud-reasoning".into(),
            standard_threshold: 30,
            reasoning_threshold: 60,
            private_markers: vec!["#privat".into(), "#private".into(), "#vertraulich".into(), "#confidential".into()],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RouteDecision {
    pub tier: Tier,
    pub model: String,
    pub score: u32,
    pub reasons: Vec<String>,
}

/// What the router looks at.
#[derive(Debug, Clone, Default)]
pub struct RouteInput<'a> {
    pub prompt: &'a str,
    /// Workspace context attached to the request (RAG chunks, active block).
    pub context: &'a [String],
    /// The request offers tools to the model.
    pub uses_tools: bool,
    /// Explicit user override, e.g. from `@local` / `@reasoning` in the chat box.
    pub force: Option<Tier>,
}

pub struct ModelRouter {
    pub config: RouterConfig,
}

const REASONING_HINTS: &[&str] = &[
    "analy",
    "architect",
    "architek",
    "design",
    "prove",
    "beweis",
    "refactor",
    "optimi",
    "plan",
    "strategy",
    "strategie",
    "compare",
    "vergleich",
    "why",
    "warum",
    "trade-off",
    "debug",
    "root cause",
    "ursache",
    "step by step",
    "schritt für schritt",
    "evaluate",
    "bewerte",
];

const SIMPLE_HINTS: &[&str] = &[
    "translate",
    "übersetze",
    "summari",
    "zusammenfass",
    "rephrase",
    "umformulier",
    "fix typo",
    "tippfehler",
    "format",
    "list",
    "liste",
];

impl ModelRouter {
    pub fn new(config: RouterConfig) -> Self {
        ModelRouter { config }
    }

    pub fn model_for(&self, tier: Tier) -> &str {
        match tier {
            Tier::Local => &self.config.local_model,
            Tier::Standard => &self.config.standard_model,
            Tier::Reasoning => &self.config.reasoning_model,
        }
    }

    pub fn route(&self, input: &RouteInput) -> RouteDecision {
        let mut reasons = vec![];
        let decide =
            |tier, score, reasons| RouteDecision { tier, model: self.model_for(tier).to_owned(), score, reasons };

        let lower = input.prompt.to_lowercase();
        let private = self.config.private_markers.iter().any(|m| {
            let m = m.to_lowercase();
            lower.contains(&m) || input.context.iter().any(|c| c.to_lowercase().contains(&m))
        });
        if private {
            reasons.push("private marker found: kept on the local model".into());
            return decide(Tier::Local, 0, reasons);
        }
        if let Some(tier) = input.force {
            reasons.push(format!("forced to {tier:?} by user"));
            return decide(tier, 0, reasons);
        }

        let mut score: i64 = 0;
        let prompt_tokens = super::metrics::estimate_tokens(input.prompt) as i64;
        let context_tokens: i64 = input.context.iter().map(|c| super::metrics::estimate_tokens(c) as i64).sum();

        let len_points = (prompt_tokens / 40).min(25);
        if len_points > 0 {
            score += len_points;
            reasons.push(format!("prompt ~{prompt_tokens} tokens (+{len_points})"));
        }
        let ctx_points = (context_tokens / 400).min(20);
        if ctx_points > 0 {
            score += ctx_points;
            reasons.push(format!("context ~{context_tokens} tokens (+{ctx_points})"));
        }
        if input.prompt.contains("```") || input.context.iter().any(|c| c.contains("```")) {
            score += 20;
            reasons.push("contains code (+20)".into());
        }
        let hits = REASONING_HINTS.iter().filter(|h| lower.contains(*h)).count() as i64;
        if hits > 0 {
            let p = (hits * 15).min(60);
            score += p;
            reasons.push(format!("{hits} reasoning cue(s) (+{p})"));
        }
        if SIMPLE_HINTS.iter().any(|h| lower.contains(h)) {
            score -= 15;
            reasons.push("simple transformation task (-15)".into());
        }
        if input.uses_tools {
            score += 10;
            reasons.push("tool use (+10)".into());
        }

        let score = score.max(0) as u32;
        let tier = if score >= self.config.reasoning_threshold {
            Tier::Reasoning
        } else if score >= self.config.standard_threshold {
            Tier::Standard
        } else {
            Tier::Local
        };
        decide(tier, score, reasons)
    }
}

/// Strips a leading `@local`, `@standard` or `@reasoning` override from a chat message.
pub fn parse_override(message: &str) -> (Option<Tier>, &str) {
    let trimmed = message.trim_start();
    for (tag, tier) in [("@local", Tier::Local), ("@standard", Tier::Standard), ("@reasoning", Tier::Reasoning)] {
        if let Some(rest) = trimmed.strip_prefix(tag)
            && (rest.is_empty() || rest.starts_with(char::is_whitespace))
        {
            return (Some(tier), rest.trim_start());
        }
    }
    (None, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route(prompt: &str, context: &[String], tools: bool) -> RouteDecision {
        ModelRouter::new(RouterConfig::default()).route(&RouteInput { prompt, context, uses_tools: tools, force: None })
    }

    #[test]
    fn simple_prompts_stay_local() {
        let d = route("Übersetze 'Netzplan' ins Englische", &[], false);
        assert_eq!(d.tier, Tier::Local);
        assert_eq!(d.model, "ollama/llama3.2");
    }

    #[test]
    fn complex_prompts_escalate() {
        let d = route(
            "Analysiere die Architektur und erkläre Schritt für Schritt warum der Refactor nötig ist",
            &[],
            false,
        );
        assert_eq!(d.tier, Tier::Reasoning, "{d:?}");

        let code = vec!["```rust\nfn main() {}\n```".to_string()];
        let d = route("What does this function return?", &code, true);
        assert_eq!(d.tier, Tier::Standard, "{d:?}");
    }

    #[test]
    fn private_content_is_never_sent_to_the_cloud() {
        let d = route("Analysiere und vergleiche die Gehälter #vertraulich", &[], true);
        assert_eq!(d.tier, Tier::Local);
        let ctx = vec!["#privat Notizen".to_string()];
        let d = ModelRouter::new(RouterConfig::default()).route(&RouteInput {
            prompt: "debug this",
            context: &ctx,
            uses_tools: false,
            force: Some(Tier::Reasoning),
        });
        assert_eq!(d.tier, Tier::Local, "privacy beats manual override");
    }

    #[test]
    fn overrides() {
        assert_eq!(parse_override("@reasoning why?"), (Some(Tier::Reasoning), "why?"));
        assert_eq!(parse_override("@localhost is down"), (None, "@localhost is down"));
    }
}
