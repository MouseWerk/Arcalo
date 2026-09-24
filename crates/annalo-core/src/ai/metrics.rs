//! Token counters, cost estimation and streaming latency metrics.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Price per million tokens in USD.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ModelPrice {
    pub input_per_mtok: f64,
    pub output_per_mtok: f64,
}

/// Model-name → price rules. A rule matches by exact name or, when it ends in
/// `*`, by prefix. Prices change often, so they live in user config; the
/// defaults only mark local runtimes as free.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceTable {
    pub rules: Vec<(String, ModelPrice)>,
}

impl Default for PriceTable {
    fn default() -> Self {
        let free = ModelPrice { input_per_mtok: 0.0, output_per_mtok: 0.0 };
        PriceTable {
            rules: ["ollama/*", "ollama_chat/*", "hosted_vllm/*", "vllm/*", "local/*"]
                .into_iter()
                .map(|p| (p.to_owned(), free))
                .collect(),
        }
    }
}

impl PriceTable {
    pub fn price(&self, model: &str) -> Option<ModelPrice> {
        // Exact matches win over prefixes; longer prefixes over shorter ones.
        if let Some((_, p)) = self.rules.iter().find(|(k, _)| k == model) {
            return Some(*p);
        }
        self.rules
            .iter()
            .filter_map(|(k, p)| k.strip_suffix('*').filter(|pre| model.starts_with(pre)).map(|pre| (pre.len(), *p)))
            .max_by_key(|(len, _)| *len)
            .map(|(_, p)| p)
    }

    /// Cost in USD, or `None` if the model has no known price.
    pub fn cost(&self, model: &str, prompt_tokens: u64, completion_tokens: u64) -> Option<f64> {
        self.price(model).map(|p| {
            (prompt_tokens as f64 * p.input_per_mtok + completion_tokens as f64 * p.output_per_mtok) / 1_000_000.0
        })
    }
}

/// Rough token estimate (~4 characters per token) for live counters before
/// the provider reports exact usage.
pub fn estimate_tokens(text: &str) -> u64 {
    let chars = text.chars().count() as u64;
    chars.div_ceil(4)
}

/// Measures one streamed completion: TTFT and decode speed.
#[derive(Debug, Clone)]
pub struct StreamTimer {
    started: Instant,
    first_token: Option<Instant>,
    last_token: Option<Instant>,
    chunks: u64,
}

impl Default for StreamTimer {
    fn default() -> Self {
        Self::start()
    }
}

impl StreamTimer {
    pub fn start() -> Self {
        Self::start_at(Instant::now())
    }

    pub fn start_at(at: Instant) -> Self {
        StreamTimer { started: at, first_token: None, last_token: None, chunks: 0 }
    }

    /// Call for every content chunk received.
    pub fn on_token_at(&mut self, at: Instant) {
        self.first_token.get_or_insert(at);
        self.last_token = Some(at);
        self.chunks += 1;
    }

    pub fn on_token(&mut self) {
        self.on_token_at(Instant::now());
    }

    pub fn ttft(&self) -> Option<Duration> {
        self.first_token.map(|t| t - self.started)
    }

    /// Decode speed in tokens/second, measured from the first to the last
    /// token. `completion_tokens` should be the provider's count when known,
    /// otherwise the number of chunks is used.
    pub fn tokens_per_second(&self, completion_tokens: Option<u64>) -> Option<f64> {
        let (first, last) = (self.first_token?, self.last_token?);
        let secs = (last - first).as_secs_f64();
        let tokens = completion_tokens.unwrap_or(self.chunks);
        // The first token arrives at `first`, so the window covers tokens - 1 intervals.
        (secs > 0.0 && tokens > 1).then(|| (tokens - 1) as f64 / secs)
    }

    /// Live speed while streaming, for the top bar monitor.
    pub fn live_tokens_per_second(&self, now: Instant) -> Option<f64> {
        let first = self.first_token?;
        let secs = (now - first).as_secs_f64();
        (secs > 0.0 && self.chunks > 1).then(|| (self.chunks - 1) as f64 / secs)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct UsageRecord {
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
    pub ttft_ms: Option<f64>,
    pub tokens_per_second: Option<f64>,
}

/// Running totals for the current chat session (top bar counters).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionMeter {
    pub requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub cost_usd: f64,
    pub last_ttft_ms: Option<f64>,
    pub last_tokens_per_second: Option<f64>,
}

impl SessionMeter {
    pub fn add(&mut self, u: &UsageRecord) {
        self.requests += 1;
        self.prompt_tokens += u.prompt_tokens;
        self.completion_tokens += u.completion_tokens;
        self.cost_usd += u.cost_usd;
        self.last_ttft_ms = u.ttft_ms.or(self.last_ttft_ms);
        self.last_tokens_per_second = u.tokens_per_second.or(self.last_tokens_per_second);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn price_rules() {
        let mut t = PriceTable::default();
        t.rules.push(("openai/*".into(), ModelPrice { input_per_mtok: 1.0, output_per_mtok: 2.0 }));
        t.rules.push(("openai/big".into(), ModelPrice { input_per_mtok: 10.0, output_per_mtok: 20.0 }));
        assert_eq!(t.cost("ollama/llama3.2", 5000, 5000), Some(0.0));
        assert_eq!(t.cost("openai/small", 1_000_000, 500_000), Some(2.0));
        assert_eq!(t.cost("openai/big", 1_000_000, 0), Some(10.0));
        assert_eq!(t.cost("unknown", 1, 1), None);
    }

    #[test]
    fn stream_timer() {
        let t0 = Instant::now();
        let mut s = StreamTimer::start_at(t0);
        assert_eq!(s.tokens_per_second(None), None);
        s.on_token_at(t0 + Duration::from_millis(250));
        for i in 1..=50 {
            s.on_token_at(t0 + Duration::from_millis(250 + i * 20));
        }
        assert_eq!(s.ttft(), Some(Duration::from_millis(250)));
        // 50 intervals over 1s.
        assert!((s.tokens_per_second(None).unwrap() - 50.0).abs() < 1e-6);
        assert!((s.tokens_per_second(Some(101)).unwrap() - 100.0).abs() < 1e-6);
    }

    #[test]
    fn meter_accumulates() {
        let mut m = SessionMeter::default();
        let u = UsageRecord {
            model: "m".into(),
            prompt_tokens: 10,
            completion_tokens: 5,
            cost_usd: 0.5,
            ttft_ms: Some(120.0),
            tokens_per_second: None,
        };
        m.add(&u);
        m.add(&UsageRecord { ttft_ms: None, tokens_per_second: Some(42.0), ..u });
        assert_eq!((m.requests, m.prompt_tokens, m.completion_tokens), (2, 20, 10));
        assert_eq!((m.cost_usd, m.last_ttft_ms, m.last_tokens_per_second), (1.0, Some(120.0), Some(42.0)));
        assert_eq!(estimate_tokens("abcdefgh1"), 3);
    }
}
