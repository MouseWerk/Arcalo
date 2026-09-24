//! Titles of web pages for pasted links: `og:title`, else `<title>`, from at most the first
//! [`MAX_BYTES`] of an http(s) page, within [`TIMEOUT`]. The shell passes the HTTP client that
//! carries the network settings (proxy, extra CA).

use std::time::Duration;

use futures_util::StreamExt;

use crate::{Error, Result};

/// Whole request, headers and body.
pub const TIMEOUT: Duration = Duration::from_secs(4);
/// The title sits in the head; a page is not read further than this.
pub const MAX_BYTES: usize = 256 * 1024;
/// Longest title returned (characters).
const MAX_TITLE: usize = 300;

/// Fetches the title of `url` (http/https only); `None` when the page has none or is no HTML.
pub async fn fetch_title(client: &reqwest::Client, url: &str) -> Result<Option<String>> {
    fetch_title_with(client, url, TIMEOUT, MAX_BYTES).await
}

pub async fn fetch_title_with(
    client: &reqwest::Client,
    url: &str,
    timeout: Duration,
    max: usize,
) -> Result<Option<String>> {
    let parsed = reqwest::Url::parse(url).map_err(|e| Error::Parse(format!("URL: {e}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(Error::Parse("nur http- und https-Adressen".into()));
    }
    let work = async {
        let resp = client
            .get(parsed)
            .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5")
            .send()
            .await?;
        if !resp.status().is_success() {
            return Err(Error::State(format!("HTTP {}", resp.status().as_u16())));
        }
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !content_type.is_empty() && !content_type.contains("html") {
            return Ok(None);
        }
        let mut body = Vec::new();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            let room = max.saturating_sub(body.len());
            body.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if body.len() >= max || head_complete(&body) {
                break;
            }
        }
        Ok(parse_title(&decode(&body, &content_type)))
    };
    tokio::time::timeout(timeout, work).await.map_err(|_| Error::State("Zeitüberschreitung".into()))?
}

/// The head is complete once `</head>` or `<body` appeared (the title comes before).
fn head_complete(body: &[u8]) -> bool {
    let lower: Vec<u8> = body.iter().map(|b| b.to_ascii_lowercase()).collect();
    lower.windows(7).any(|w| w == b"</head>") || lower.windows(5).any(|w| w == b"<body")
}

/// Decodes the page: UTF-8, or Latin-1/Windows-1252 when the header or a `<meta charset>` says so.
pub fn decode(body: &[u8], content_type: &str) -> String {
    let head = String::from_utf8_lossy(&body[..body.len().min(4096)]).to_ascii_lowercase();
    let declared = charset_of(content_type).or_else(|| {
        let i = head.find("charset=")?;
        Some(
            head[i + 8..]
                .trim_start_matches(['"', '\''])
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
                .collect(),
        )
    });
    match declared.as_deref() {
        Some("iso-8859-1" | "latin1" | "windows-1252" | "cp1252" | "iso-8859-15") => {
            body.iter().map(|&b| b as char).collect()
        }
        _ => String::from_utf8_lossy(body).into_owned(),
    }
}

fn charset_of(content_type: &str) -> Option<String> {
    let i = content_type.find("charset=")?;
    Some(content_type[i + 8..].trim_matches(['"', '\'', ' ']).split(';').next().unwrap_or("").to_string())
        .filter(|s| !s.is_empty())
}

/// `og:title` (or `twitter:title`) of the page, else its `<title>`; entities decoded, whitespace collapsed.
pub fn parse_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for name in ["og:title", "twitter:title"] {
        if let Some(t) = meta_content(html, &lower, name) {
            return Some(t);
        }
    }
    let start = find_tag(&lower, "title", 0)?;
    let open_end = lower[start..].find('>')? + start + 1;
    let close =
        lower[open_end..].find("</title").map(|i| i + open_end).unwrap_or(html.floor_char_boundary(open_end + 2000));
    clean(&html[open_end..close])
}

/// Start of the next `<tag` (followed by whitespace, `>` or `/`) at or after `from`.
fn find_tag(lower: &str, tag: &str, mut from: usize) -> Option<usize> {
    let pat = format!("<{tag}");
    while let Some(i) = lower[from..].find(&pat) {
        let at = from + i;
        match lower.as_bytes().get(at + pat.len()) {
            Some(b' ' | b'\t' | b'\n' | b'\r' | b'>' | b'/') => return Some(at),
            _ => from = at + pat.len(),
        }
    }
    None
}

/// `content` of `<meta property="name">` / `<meta name="name">`, attributes in any order.
fn meta_content(html: &str, lower: &str, name: &str) -> Option<String> {
    let mut from = 0;
    while let Some(at) = find_tag(lower, "meta", from) {
        let end = lower[at..].find('>').map(|i| at + i)?;
        let attrs = attributes(&html[at + 5..end]);
        let is = attrs.iter().any(|(k, v)| (k == "property" || k == "name") && v.eq_ignore_ascii_case(name));
        if is && let Some(t) = attrs.iter().find(|(k, _)| k == "content").and_then(|(_, v)| clean(v)) {
            return Some(t);
        }
        from = end;
    }
    None
}

/// `key="value"`, `key='value'` and `key=value` pairs of a tag (keys lower-cased).
fn attributes(s: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i].is_whitespace() || chars[i] == '/') {
            i += 1;
        }
        let k0 = i;
        while i < chars.len() && !chars[i].is_whitespace() && chars[i] != '=' && chars[i] != '/' {
            i += 1;
        }
        let key: String = chars[k0..i].iter().collect::<String>().to_ascii_lowercase();
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i < chars.len() && chars[i] == '=' {
            i += 1;
            while i < chars.len() && chars[i].is_whitespace() {
                i += 1;
            }
            let value: String = if i < chars.len() && (chars[i] == '"' || chars[i] == '\'') {
                let q = chars[i];
                let v0 = i + 1;
                i = v0;
                while i < chars.len() && chars[i] != q {
                    i += 1;
                }
                let v = chars[v0..i.min(chars.len())].iter().collect();
                i += 1;
                v
            } else {
                let v0 = i;
                while i < chars.len() && !chars[i].is_whitespace() {
                    i += 1;
                }
                chars[v0..i].iter().collect()
            };
            if !key.is_empty() {
                out.push((key, value));
            }
        } else if !key.is_empty() {
            out.push((key, String::new()));
        } else {
            i += 1;
        }
    }
    out
}

/// Decodes entities, collapses whitespace, caps the length; `None` when empty.
fn clean(raw: &str) -> Option<String> {
    let text = decode_entities(raw);
    let t = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        return None;
    }
    Some(if t.chars().count() > MAX_TITLE {
        t.chars().take(MAX_TITLE - 1).chain(std::iter::once('…')).collect()
    } else {
        t
    })
}

/// Numeric entities and the named ones titles use.
pub fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i..];
        let end = tail[..tail.floor_char_boundary(12)].find(';');
        let decoded = end.and_then(|e| {
            let name = &tail[1..e];
            let c = if let Some(num) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
                u32::from_str_radix(num, 16).ok().and_then(char::from_u32)
            } else if let Some(num) = name.strip_prefix('#') {
                num.parse::<u32>().ok().and_then(char::from_u32)
            } else {
                match name {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    "auml" => Some('ä'),
                    "ouml" => Some('ö'),
                    "uuml" => Some('ü'),
                    "Auml" => Some('Ä'),
                    "Ouml" => Some('Ö'),
                    "Uuml" => Some('Ü'),
                    "szlig" => Some('ß'),
                    "ndash" => Some('–'),
                    "mdash" => Some('—'),
                    "hellip" => Some('…'),
                    "laquo" => Some('«'),
                    "raquo" => Some('»'),
                    "bdquo" => Some('„'),
                    "ldquo" => Some('“'),
                    "rdquo" => Some('”'),
                    "lsquo" => Some('‘'),
                    "rsquo" => Some('’'),
                    "middot" => Some('·'),
                    "euro" => Some('€'),
                    "copy" => Some('©'),
                    "reg" => Some('®'),
                    "trade" => Some('™'),
                    _ => None,
                }
            };
            c.map(|c| (c, e + 1))
        });
        match decoded {
            Some((c, len)) => {
                out.push(c);
                rest = &tail[len..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn multibyte_text_at_the_cut_points_does_not_panic() {
        // An entity window of 12 bytes ending inside „ä“.
        assert_eq!(parse_title("<title>Bau &Planungsamä Nord</title>").as_deref(), Some("Bau &Planungsamä Nord"));
        assert_eq!(decode_entities("&aaaaaaaaaaä;"), "&aaaaaaaaaaä;");
        // An unclosed title cut after 2000 bytes, inside „ä“.
        let html = format!("<title>{}äääää", "a".repeat(1999));
        let title = parse_title(&html).unwrap();
        assert!(title.starts_with("aaa"));
    }

    #[test]
    fn prefers_og_title() {
        let html = r#"<html><head><title>Startseite | Firma</title><meta content="Produkt &amp; Service" property="og:title"></head>"#;
        assert_eq!(parse_title(html).as_deref(), Some("Produkt & Service"));
    }

    #[test]
    fn reads_title_with_attributes_entities_and_whitespace() {
        let html = "<HTML><head><meta name=description content=x><TITLE data-x='1'>\n  Gr&uuml;&szlig;e &#8211; Wiki&#x21;\n </TITLE>";
        assert_eq!(parse_title(html).as_deref(), Some("Grüße – Wiki!"));
        assert_eq!(parse_title("<title></title><h1>x</h1>"), None);
        assert_eq!(parse_title("<p>kein Titel</p>"), None);
        // <titlebar> is not <title>.
        assert_eq!(parse_title("<titlebar>x</titlebar><title>Echt</title>").as_deref(), Some("Echt"));
        // Unknown entities stay.
        assert_eq!(parse_title("<title>A &foo; B & C</title>").as_deref(), Some("A &foo; B & C"));
    }

    #[test]
    fn caps_long_titles() {
        let t = parse_title(&format!("<title>{}</title>", "x".repeat(1000))).unwrap();
        assert_eq!(t.chars().count(), MAX_TITLE);
    }

    #[test]
    fn decodes_latin1_pages() {
        let body = b"<meta charset=\"iso-8859-1\"><title>M\xfcnchen</title>";
        assert_eq!(parse_title(&decode(body, "")).as_deref(), Some("München"));
        assert_eq!(
            parse_title(&decode(b"<title>M\xfcnchen</title>", "text/html; charset=windows-1252")).as_deref(),
            Some("München")
        );
        assert_eq!(parse_title(&decode("<title>München</title>".as_bytes(), "text/html")).as_deref(), Some("München"));
    }

    /// A one-shot HTTP server on 127.0.0.1 answering with `response` (after `delay`).
    async fn serve(response: Vec<u8>, delay: Duration) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                tokio::time::sleep(delay).await;
                let _ = sock.write_all(&response).await;
                let _ = sock.shutdown().await;
            }
        });
        format!("http://{addr}/seite")
    }

    fn http(content_type: &str, body: &[u8]) -> Vec<u8> {
        let mut r = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        r.extend_from_slice(body);
        r
    }

    #[tokio::test(flavor = "current_thread")]
    async fn fetches_the_title_from_a_server() {
        let url = serve(
            http("text/html; charset=utf-8", "<head><title>Lokale Seite</title></head><body>x</body>".as_bytes()),
            Duration::ZERO,
        )
        .await;
        assert_eq!(fetch_title(&reqwest::Client::new(), &url).await.unwrap().as_deref(), Some("Lokale Seite"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stops_after_the_byte_limit() {
        let mut body = b"<head>".to_vec();
        body.extend(std::iter::repeat_n(b' ', 4096));
        body.extend_from_slice(b"<title>zu spaet</title>");
        let url = serve(http("text/html", &body), Duration::ZERO).await;
        assert_eq!(fetch_title_with(&reqwest::Client::new(), &url, TIMEOUT, 1024).await.unwrap(), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn ignores_other_content_and_reports_errors() {
        let url = serve(http("application/pdf", b"%PDF-1.4 <title>x</title>"), Duration::ZERO).await;
        assert_eq!(fetch_title(&reqwest::Client::new(), &url).await.unwrap(), None);
        let url =
            serve(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_vec(), Duration::ZERO)
                .await;
        assert!(fetch_title(&reqwest::Client::new(), &url).await.is_err());
        let client = reqwest::Client::new();
        for bad in ["ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "kein url"] {
            assert!(fetch_title(&client, bad).await.is_err(), "{bad}");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn times_out() {
        let url = serve(http("text/html", b"<title>zu langsam</title>"), Duration::from_secs(3)).await;
        let started = std::time::Instant::now();
        let err =
            fetch_title_with(&reqwest::Client::new(), &url, Duration::from_millis(300), MAX_BYTES).await.unwrap_err();
        assert!(err.to_string().contains("Zeitüberschreitung"));
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
