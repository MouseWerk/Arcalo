//! Client for a LiteLLM proxy (OpenAI-compatible `/v1/chat/completions`).

use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::metrics::{PriceTable, StreamTimer, UsageRecord, estimate_tokens};
use crate::error::{Error, Result};

/// A stream that delivers nothing for this long is treated as dead.
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

impl ChatMessage {
    fn text(role: &str, content: impl Into<String>) -> Self {
        ChatMessage { role: role.into(), content: Some(content.into()), tool_calls: vec![], tool_call_id: None }
    }
    pub fn system(c: impl Into<String>) -> Self {
        Self::text("system", c)
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self::text("user", c)
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Self::text("assistant", c)
    }
    pub fn tool_result(tool_call_id: impl Into<String>, c: impl Into<String>) -> Self {
        ChatMessage { tool_call_id: Some(tool_call_id.into()), ..Self::text("tool", c) }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    #[serde(rename = "type", default = "function_type")]
    pub kind: String,
    pub function: FunctionCall,
}

fn function_type() -> String {
    "function".into()
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct FunctionCall {
    pub name: String,
    /// JSON-encoded arguments, as produced by the model.
    pub arguments: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ChatRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    /// OpenAI-style tool definitions.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "type")]
pub enum StreamEvent {
    /// A piece of assistant text, with the live decode speed.
    Delta { text: String, tokens_per_second: Option<f64> },
    /// First token arrived.
    FirstToken { ttft_ms: f64 },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Completion {
    pub content: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish_reason: Option<String>,
    pub usage: UsageRecord,
    /// Whether token counts came from the provider (`false` = estimated).
    pub exact_usage: bool,
}

pub struct LiteLlmClient {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
    pub prices: PriceTable,
}

impl LiteLlmClient {
    /// `base_url` is the proxy root, e.g. `http://localhost:4000`.
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self::with_http(base_url, api_key, reqwest::Client::new())
    }

    /// With a configured HTTP client (proxy, extra CA, timeouts: [`crate::network::http_client`]).
    pub fn with_http(base_url: impl Into<String>, api_key: Option<String>, http: reqwest::Client) -> Self {
        LiteLlmClient {
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            api_key,
            http,
            prices: PriceTable::default(),
        }
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        let req = self.http.post(format!("{}{path}", self.base_url));
        match &self.api_key {
            Some(k) => req.bearer_auth(k),
            None => req,
        }
    }

    async fn check(resp: reqwest::Response) -> Result<reqwest::Response> {
        if resp.status().is_success() {
            return Ok(resp);
        }
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        Err(Error::Provider { status, body })
    }

    /// Streams a chat completion, calling `on_event` for every delta. When
    /// `cancel` becomes true the stream is dropped and the partial answer is
    /// returned with `finish_reason = "cancelled"`.
    pub async fn chat_stream(
        &self,
        req: &ChatRequest,
        cancel: Option<&std::sync::atomic::AtomicBool>,
        mut on_event: impl FnMut(StreamEvent),
    ) -> Result<Completion> {
        let mut body = serde_json::to_value(req)?;
        body["stream"] = json!(true);
        body["stream_options"] = json!({ "include_usage": true });

        let timer_start = Instant::now();
        let cancelled = || cancel.is_some_and(|c| c.load(std::sync::atomic::Ordering::Relaxed));
        // Resolves once the user cancels; polled so a stalled request or a model
        // that is still thinking can be stopped too.
        let wait_cancel = || async {
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                if cancelled() {
                    return;
                }
            }
        };
        let mut acc = StreamAccumulator::new(StreamTimer::start_at(timer_start));

        let send = self.post("/v1/chat/completions").json(&body).send();
        let resp = tokio::select! {
            r = send => Self::check(r?).await?,
            _ = wait_cancel() => {
                acc.finish_reason = Some("cancelled".into());
                return Ok(acc.finish(&req.model, &req.messages, None, &self.prices));
            }
        };
        // LiteLLM reports its own cost calculation in this header.
        let header_cost = resp
            .headers()
            .get("x-litellm-response-cost")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<f64>().ok());

        let mut decoder = SseDecoder::default();
        let mut stream = resp.bytes_stream();
        // One waiter for the whole stream: recreating it per chunk would restart its
        // timer every time and never fire while chunks keep arriving.
        let cancel_wait = wait_cancel();
        tokio::pin!(cancel_wait);
        'outer: loop {
            let chunk = tokio::select! {
                c = tokio::time::timeout(STREAM_IDLE_TIMEOUT, stream.next()) => match c {
                    Ok(Some(c)) => c,
                    Ok(None) => break,
                    Err(_) => return Err(Error::Provider { status: 0, body: "Keine Antwort vom Modell (Zeitüberschreitung)".into() }),
                },
                _ = &mut cancel_wait => {
                    acc.finish_reason = Some("cancelled".into());
                    break;
                }
            };
            for data in decoder.push(&chunk?) {
                if data == "[DONE]" {
                    break 'outer;
                }
                acc.apply(&serde_json::from_str(&data)?, &mut on_event);
            }
        }
        Ok(acc.finish(&req.model, &req.messages, header_cost, &self.prices))
    }

    /// Embeds a batch of texts via `/v1/embeddings`.
    pub async fn embed(&self, model: &str, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        #[derive(Deserialize)]
        struct Item {
            index: usize,
            embedding: Vec<f32>,
        }
        #[derive(Deserialize)]
        struct Resp {
            data: Vec<Item>,
        }
        let resp =
            Self::check(self.post("/v1/embeddings").json(&json!({ "model": model, "input": inputs })).send().await?)
                .await?;
        let mut data = resp.json::<Resp>().await?.data;
        data.sort_by_key(|i| i.index);
        if data.len() != inputs.len() {
            return Err(Error::Provider {
                status: 200,
                body: format!("expected {} embeddings, got {}", inputs.len(), data.len()),
            });
        }
        Ok(data.into_iter().map(|i| i.embedding).collect())
    }

    /// Lists the models the proxy exposes.
    pub async fn models(&self) -> Result<Vec<String>> {
        let mut req = self.http.get(format!("{}/v1/models", self.base_url));
        if let Some(k) = &self.api_key {
            req = req.bearer_auth(k);
        }
        let v: Value = Self::check(req.send().await?).await?.json().await?;
        Ok(v["data"]
            .as_array()
            .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_owned)).collect())
            .unwrap_or_default())
    }
}

/// Splits a byte stream into Server-Sent-Event `data:` payloads.
#[derive(Debug, Default)]
pub struct SseDecoder {
    buf: Vec<u8>,
    data: Vec<String>,
}

impl SseDecoder {
    /// Feeds bytes; returns the payloads of every event completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.buf.extend_from_slice(bytes);
        let mut events = vec![];
        while let Some(nl) = self.buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = self.buf.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim_end_matches(['\n', '\r']);
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                self.data.push(rest.strip_prefix(' ').unwrap_or(rest).to_owned());
            }
            // Comments (":") and other fields (event:, id:, retry:) are ignored.
        }
        events
    }
}

/// Folds OpenAI-style stream chunks into a [`Completion`].
pub struct StreamAccumulator {
    timer: StreamTimer,
    content: String,
    tool_calls: Vec<ToolCall>,
    finish_reason: Option<String>,
    usage: Option<(u64, u64)>,
}

impl StreamAccumulator {
    pub fn new(timer: StreamTimer) -> Self {
        StreamAccumulator { timer, content: String::new(), tool_calls: vec![], finish_reason: None, usage: None }
    }

    pub fn apply(&mut self, chunk: &Value, on_event: &mut impl FnMut(StreamEvent)) {
        if let Some(u) = chunk.get("usage").filter(|u| !u.is_null()) {
            self.usage = Some((u["prompt_tokens"].as_u64().unwrap_or(0), u["completion_tokens"].as_u64().unwrap_or(0)));
        }
        let Some(choice) = chunk["choices"].get(0) else { return };
        if let Some(r) = choice["finish_reason"].as_str() {
            self.finish_reason = Some(r.to_owned());
        }
        let delta = &choice["delta"];
        if let Some(text) = delta["content"].as_str().filter(|t| !t.is_empty()) {
            let first = self.timer.ttft().is_none();
            let now = Instant::now();
            self.timer.on_token_at(now);
            if first && let Some(t) = self.timer.ttft() {
                on_event(StreamEvent::FirstToken { ttft_ms: t.as_secs_f64() * 1000.0 });
            }
            self.content.push_str(text);
            on_event(StreamEvent::Delta {
                text: text.to_owned(),
                tokens_per_second: self.timer.live_tokens_per_second(now),
            });
        }
        if let Some(calls) = delta["tool_calls"].as_array() {
            for c in calls {
                let idx = c["index"].as_u64().unwrap_or(self.tool_calls.len() as u64) as usize;
                while self.tool_calls.len() <= idx {
                    self.tool_calls.push(ToolCall {
                        id: String::new(),
                        kind: function_type(),
                        function: FunctionCall::default(),
                    });
                }
                let tc = &mut self.tool_calls[idx];
                if let Some(id) = c["id"].as_str() {
                    tc.id = id.to_owned();
                }
                if let Some(name) = c["function"]["name"].as_str() {
                    tc.function.name.push_str(name);
                }
                if let Some(args) = c["function"]["arguments"].as_str() {
                    tc.function.arguments.push_str(args);
                }
            }
        }
    }

    pub fn finish(
        self,
        model: &str,
        messages: &[ChatMessage],
        header_cost: Option<f64>,
        prices: &PriceTable,
    ) -> Completion {
        let exact = self.usage.is_some();
        let (prompt_tokens, completion_tokens) = self.usage.unwrap_or_else(|| {
            let prompt: u64 = messages.iter().filter_map(|m| m.content.as_deref()).map(estimate_tokens).sum();
            (prompt, estimate_tokens(&self.content))
        });
        let cost_usd = header_cost.or_else(|| prices.cost(model, prompt_tokens, completion_tokens)).unwrap_or(0.0);
        Completion {
            usage: UsageRecord {
                model: model.to_owned(),
                prompt_tokens,
                completion_tokens,
                cost_usd,
                ttft_ms: self.timer.ttft().map(|d| d.as_secs_f64() * 1000.0),
                tokens_per_second: self.timer.tokens_per_second(exact.then_some(completion_tokens)),
            },
            content: self.content,
            // Some backends (Ollama, Gemini through LiteLLM) send no call id; the tool results
            // must refer to one, so each call gets its own. Calls without a name are dropped.
            tool_calls: self
                .tool_calls
                .into_iter()
                .filter(|c| !c.function.name.is_empty())
                .enumerate()
                .map(|(i, mut c)| {
                    if c.id.is_empty() {
                        c.id = format!("call_{i}");
                    }
                    c
                })
                .collect(),
            finish_reason: self.finish_reason,
            exact_usage: exact,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_decoder_handles_split_chunks_and_comments() {
        let mut d = SseDecoder::default();
        assert!(d.push(b": keep-alive\n\ndata: {\"a\"").is_empty());
        assert_eq!(d.push(b":1}\r\n\r\ndata: [DONE]\n"), vec!["{\"a\":1}".to_string()]);
        assert_eq!(d.push(b"\n"), vec!["[DONE]".to_string()]);
    }

    #[test]
    fn accumulates_text_tool_calls_and_usage() {
        let chunks = [
            json!({"choices":[{"delta":{"role":"assistant","content":""}}]}),
            json!({"choices":[{"delta":{"content":"Hallo"}}]}),
            json!({"choices":[{"delta":{"content":" Welt"}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"log_time","arguments":"{\"com"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"mand\":\"/zeit\"}"}}]},"finish_reason":"tool_calls"}]}),
            json!({"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}),
        ];
        let mut acc = StreamAccumulator::new(StreamTimer::start());
        let mut events = vec![];
        for c in &chunks {
            acc.apply(c, &mut |e| events.push(e));
        }
        let c = acc.finish("ollama/llama3.2", &[], None, &PriceTable::default());
        assert_eq!(c.content, "Hallo Welt");
        assert_eq!(c.tool_calls[0].function.name, "log_time");
        assert_eq!(c.tool_calls[0].function.arguments, "{\"command\":\"/zeit\"}");
        assert_eq!(c.finish_reason.as_deref(), Some("tool_calls"));
        assert_eq!((c.usage.prompt_tokens, c.usage.completion_tokens, c.usage.cost_usd), (12, 7, 0.0));
        assert!(c.exact_usage);
        assert!(matches!(events[0], StreamEvent::FirstToken { .. }));
        assert_eq!(events.iter().filter(|e| matches!(e, StreamEvent::Delta { .. })).count(), 2);
    }

    #[test]
    fn tool_calls_without_an_id_get_one() {
        let chunks = [
            json!({"choices":[{"delta":{"tool_calls":[{"function":{"name":"search_notes","arguments":"{}"}}]}}]}),
            json!({"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"budget_status","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}),
        ];
        let mut acc = StreamAccumulator::new(StreamTimer::start());
        for c in &chunks {
            acc.apply(c, &mut |_| {});
        }
        let c = acc.finish("ollama/llama3.2", &[], None, &PriceTable::default());
        let ids: Vec<&str> = c.tool_calls.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids, ["call_0", "call_1"]);
    }

    #[test]
    fn message_serialization_matches_openai_shape() {
        let m = serde_json::to_value(ChatMessage::tool_result("call_1", "ok")).unwrap();
        assert_eq!(m, json!({"role":"tool","content":"ok","tool_call_id":"call_1"}));
    }
}
