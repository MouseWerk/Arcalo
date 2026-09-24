//! End-to-end test of the AI client against a minimal fake proxy.

use annalo_core::ai::client::{AiClient, ChatMessage, ChatRequest, StreamEvent};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

async fn fake_proxy(body: &'static str, extra_headers: &'static str) -> (String, tokio::task::JoinHandle<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = vec![0u8; 64 * 1024];
        let mut req = Vec::new();
        // Read until the JSON body is complete (headers + Content-Length).
        loop {
            let n = sock.read(&mut buf).await.unwrap();
            req.extend_from_slice(&buf[..n]);
            let text = String::from_utf8_lossy(&req);
            if let Some(idx) = text.find("\r\n\r\n") {
                let len = text
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                if req.len() >= idx + 4 + len {
                    break;
                }
            }
        }
        let resp = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n{extra_headers}connection: close\r\n\r\n{body}"
        );
        sock.write_all(resp.as_bytes()).await.unwrap();
        sock.shutdown().await.unwrap();
        String::from_utf8_lossy(&req).into_owned()
    });
    (format!("http://{addr}"), handle)
}

#[tokio::test(flavor = "current_thread")]
async fn streams_deltas_and_reports_usage_and_cost() {
    let body = concat!(
        "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Netz\"}}]}\n\n",
        ": keep-alive\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\"plan\"}}]}\n\n",
        "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
        "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":21,\"completion_tokens\":2}}\n\n",
        "data: [DONE]\n\n",
    );
    let (url, server) = fake_proxy(body, "x-litellm-response-cost: 0.0042\r\n").await;
    let client = AiClient::new(url, Some("sk-test".into()));
    let req = ChatRequest {
        model: "cloud-standard".into(),
        messages: vec![ChatMessage::user("Was ist ein Netzplan?")],
        ..Default::default()
    };
    let mut deltas = vec![];
    let c = client
        .chat_stream(&req, None, |e| {
            if let StreamEvent::Delta { text, .. } = e {
                deltas.push(text)
            }
        })
        .await
        .unwrap();

    assert_eq!(deltas, ["Netz", "plan"]);
    assert_eq!(c.content, "Netzplan");
    assert_eq!(c.finish_reason.as_deref(), Some("stop"));
    assert_eq!((c.usage.prompt_tokens, c.usage.completion_tokens), (21, 2));
    assert_eq!(c.usage.cost_usd, 0.0042, "LiteLLM's cost header wins");
    assert!(c.usage.ttft_ms.is_some());

    let raw = server.await.unwrap();
    assert!(raw.starts_with("POST /v1/chat/completions"));
    assert!(raw.to_ascii_lowercase().contains("authorization: bearer sk-test"));
    assert!(raw.contains("\"stream\":true") && raw.contains("\"include_usage\":true"));
}

#[tokio::test(flavor = "current_thread")]
async fn surfaces_provider_errors() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let (mut sock, _) = listener.accept().await.unwrap();
        let mut buf = [0u8; 4096];
        let _ = sock.read(&mut buf).await;
        let body = "{\"error\":\"model not found\"}";
        let resp =
            format!("HTTP/1.1 404 Not Found\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        sock.write_all(resp.as_bytes()).await.unwrap();
    });
    let client = AiClient::new(format!("http://{addr}"), None);
    let err = client
        .chat_stream(
            &ChatRequest { model: "nope".into(), messages: vec![ChatMessage::user("hi")], ..Default::default() },
            None,
            |_| {},
        )
        .await
        .unwrap_err();
    assert!(matches!(err, annalo_core::Error::Provider { status: 404, .. }), "{err}");
}

/// A server that answers every connection with `response` (status line and headers included).
async fn fake_raw(response: String) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let response = response.clone();
            tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(response.as_bytes()).await;
                let _ = sock.shutdown().await;
            });
        }
    });
    format!("http://{addr}")
}

fn hello() -> ChatRequest {
    ChatRequest { model: "m".into(), messages: vec![ChatMessage::user("hi")], ..Default::default() }
}

#[tokio::test(flavor = "current_thread")]
async fn a_server_that_never_answers_times_out() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    // Accepts every connection and keeps it open without a word.
    tokio::spawn(async move {
        let mut held = vec![];
        while let Ok((sock, _)) = listener.accept().await {
            held.push(sock);
        }
    });
    let mut client = AiClient::new(format!("http://{addr}"), None);
    client.first_byte_timeout = std::time::Duration::from_millis(300);
    client.request_timeout = std::time::Duration::from_millis(300);
    let err = client.chat_stream(&hello(), None, |_| {}).await.unwrap_err().to_string();
    assert!(err.contains("Zeitüberschreitung"), "{err}");
    let err = client.models().await.unwrap_err().to_string();
    assert!(err.contains("Zeitüberschreitung"), "{err}");
}

#[tokio::test(flavor = "current_thread")]
async fn garbage_truncated_and_empty_streams_are_not_answers() {
    // A captive portal's login page with status 200.
    let html = "<html><body>Bitte im Hotel-WLAN anmelden</body></html>";
    let url = fake_raw(format!(
        "HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{html}",
        html.len()
    ))
    .await;
    let err = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap_err().to_string();
    assert!(err.contains("Keine Antwort im erwarteten Format") && err.contains("Hotel-WLAN"), "{err}");

    let sse =
        |body: &str| format!("HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\nconnection: close\r\n\r\n{body}");
    // Cut off mid-answer: what arrived is kept and marked.
    let url = fake_raw(sse("data: {\"choices\":[{\"delta\":{\"content\":\"Halb\"}}]}\n\n")).await;
    let c = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap();
    assert!(c.content.starts_with("Halb") && c.content.contains("unvollständig"), "{}", c.content);
    assert_eq!(c.finish_reason.as_deref(), Some("incomplete"));

    // One broken event does not cost the answer.
    let url = fake_raw(sse(concat!(
        "data: {\"choices\":[{\"delta\":{\"content\":\"Gut\"}}]}\n\n",
        "data: {kaputt\n\n",
        "data: {\"choices\":[{\"delta\":{\"content\":\" so\"},\"finish_reason\":\"stop\"}]}\n\n",
        "data: [DONE]\n\n"
    )))
    .await;
    let c = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap();
    assert_eq!(c.content, "Gut so");
    assert_eq!(c.warnings.len(), 1);

    // Nothing at all.
    let url =
        fake_raw(sse("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")).await;
    let err = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap_err().to_string();
    assert!(err.starts_with("Leere Antwort"), "{err}");
    let url = fake_raw(sse("")).await;
    let err = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap_err().to_string();
    assert!(err.contains("brach während der Antwort ab"), "{err}");

    // A backend that ignores `stream` and sends the whole answer as JSON.
    let json = r#"{"choices":[{"message":{"role":"assistant","content":"Ganz"},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}"#;
    let url = fake_raw(format!(
        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{json}",
        json.len()
    ))
    .await;
    let c = AiClient::new(url, None).chat_stream(&hello(), None, |_| {}).await.unwrap();
    assert_eq!((c.content.as_str(), c.usage.prompt_tokens), ("Ganz", 3));
}
