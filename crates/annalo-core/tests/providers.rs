//! The AI client against fake Ollama, OpenAI-compatible and Azure servers: paths, auth
//! headers, model lists, costs and Ollama's model download.

use std::sync::{Arc, Mutex};

use annalo_core::ai::client::{AiClient, ChatMessage, ChatRequest};
use annalo_core::ai::metrics::{PriceTable, default_price_rules};
use annalo_core::ai::provider::{AiProvider, ProviderKind};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const STREAM: &str = concat!(
    "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n",
    "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":1000000,\"completion_tokens\":1000000}}\n\n",
    "data: [DONE]\n\n",
);

/// Answers every request by path; returns the base URL and the raw requests seen.
async fn fake(route: fn(&str) -> (u16, &'static str, String)) -> (String, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(vec![]));
    let log = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let mut buf = vec![0u8; 64 * 1024];
            let mut req = Vec::new();
            loop {
                let n = sock.read(&mut buf).await.unwrap();
                req.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&req);
                if let Some(idx) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap())
                        })
                        .unwrap_or(0usize);
                    if req.len() >= idx + 4 + len || n == 0 {
                        break;
                    }
                }
            }
            let raw = String::from_utf8_lossy(&req).into_owned();
            let path = raw.split_whitespace().nth(1).unwrap_or_default().to_owned();
            log.lock().unwrap().push(raw);
            let (status, ctype, body) = route(&path);
            let resp = format!(
                "HTTP/1.1 {status} X\r\ncontent-type: {ctype}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
            sock.shutdown().await.unwrap();
        }
    });
    (format!("http://{addr}"), seen)
}

fn req(model: &str) -> ChatRequest {
    ChatRequest { model: model.into(), messages: vec![ChatMessage::user("Hallo")], ..Default::default() }
}

#[tokio::test(flavor = "current_thread")]
async fn ollama_lists_natively_chats_openai_style_and_costs_nothing() {
    let (url, seen) = fake(|path| match path {
        "/api/tags" => (200, "application/json", r#"{"models":[{"name":"llama3.2:latest"},{"name":"nomic-embed-text"}]}"#.into()),
        "/v1/chat/completions" => (200, "text/event-stream", STREAM.into()),
        "/api/pull" => (
            200,
            "application/x-ndjson",
            "{\"status\":\"pulling manifest\"}\n{\"status\":\"downloading\",\"total\":100,\"completed\":40}\n{\"status\":\"success\"}\n".into(),
        ),
        _ => (404, "text/plain", "not found".into()),
    })
    .await;
    let mut client =
        AiClient::for_provider(AiProvider::ollama("ollama", &format!("{url}/v1")), None, reqwest::Client::new());
    client.prices = PriceTable::from_rules(&default_price_rules(), "ollama");
    assert_eq!(client.models().await.unwrap(), ["llama3.2:latest", "nomic-embed-text"]);
    let c = client.chat_stream(&req("llama3.2:latest"), None, |_| {}).await.unwrap();
    assert_eq!(c.content, "OK");
    assert_eq!(c.usage.cost_usd, 0.0, "local providers are free");
    let mut progress = vec![];
    client.ollama_pull("qwen2.5", None, |p| progress.push((p.status.clone(), p.completed))).await.unwrap();
    assert_eq!(progress[1], ("downloading".to_string(), Some(40)));
    let seen = seen.lock().unwrap();
    assert!(seen[0].starts_with("GET /api/tags"));
    assert!(seen[1].starts_with("POST /v1/chat/completions"));
    assert!(seen.iter().all(|r| !r.to_ascii_lowercase().contains("authorization:")), "no key");
    assert!(seen[2].contains("\"model\":\"qwen2.5\""));
}

#[tokio::test(flavor = "current_thread")]
async fn openai_compatible_costs_come_from_the_price_table() {
    let (url, seen) = fake(|path| match path {
        "/v1/models" => (200, "application/json", r#"{"data":[{"id":"gpt-4o-mini"}]}"#.into()),
        "/v1/chat/completions" => (200, "text/event-stream", STREAM.into()),
        _ => (404, "text/plain", String::new()),
    })
    .await;
    let provider = AiProvider {
        id: "openai".into(),
        kind: ProviderKind::Openai,
        base_url: format!("{url}/v1"),
        models: vec!["mein-finetune".into()],
        ..Default::default()
    };
    let mut client = AiClient::for_provider(provider, Some("sk-o".into()), reqwest::Client::new());
    client.prices = PriceTable::from_rules(&default_price_rules(), "openai");
    assert_eq!(client.models().await.unwrap(), ["gpt-4o-mini", "mein-finetune"], "listed plus hand-added");
    let c = client.chat_stream(&req("gpt-4o-mini"), None, |_| {}).await.unwrap();
    // 1M input at 0.15 + 1M output at 0.60.
    assert!((c.usage.cost_usd - 0.75).abs() < 1e-9, "{}", c.usage.cost_usd);
    assert!(seen.lock().unwrap()[1].to_ascii_lowercase().contains("authorization: bearer sk-o"));
}

#[tokio::test(flavor = "current_thread")]
async fn azure_uses_deployments_api_version_and_api_key() {
    let (url, seen) = fake(|path| {
        if path.starts_with("/openai/deployments/firma-gpt4o/chat/completions?api-version=2024-06-01") {
            (200, "text/event-stream", STREAM.into())
        } else {
            (404, "application/json", r#"{"error":{"code":"DeploymentNotFound"}}"#.into())
        }
    })
    .await;
    let provider = AiProvider {
        id: "azure".into(),
        kind: ProviderKind::Azure,
        base_url: url,
        api_version: "2024-06-01".into(),
        models: vec!["firma-gpt4o".into()],
        ..Default::default()
    };
    let client = AiClient::for_provider(provider, Some("az-key".into()), reqwest::Client::new());
    assert_eq!(client.models().await.unwrap(), ["firma-gpt4o"], "deployments are entered by hand");
    client.chat_stream(&req("firma-gpt4o"), None, |_| {}).await.unwrap();
    let raw = seen.lock().unwrap()[0].to_ascii_lowercase();
    assert!(raw.contains("api-key: az-key") && !raw.contains("authorization:"), "{raw}");
    let err = client.chat_stream(&req("fehlt"), None, |_| {}).await.unwrap_err();
    assert!(matches!(err, annalo_core::Error::Provider { status: 404, .. }));
}
