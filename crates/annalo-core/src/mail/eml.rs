//! `.eml` files (RFC 5322 + MIME) through `mail-parser`: encoded words in headers, charsets,
//! quoted-printable and base64 bodies, multipart trees. The text is the first plain-text body
//! (an HTML-only mail is turned into text); attachments keep their order (1-based indexes).

use chrono::{DateTime, TimeZone, Utc};
use mail_parser::{Address, MessageParser, MimeHeaders};

use super::{Mail, MailAttachment, MailSource, Parsed};

fn names(a: Option<&Address>) -> Vec<String> {
    a.map(|a| {
        a.iter()
            .map(|x| match (x.name(), x.address()) {
                (Some(n), _) if !n.trim().is_empty() => n.trim().to_owned(),
                (_, Some(e)) => e.trim().to_owned(),
                _ => String::new(),
            })
            .filter(|x| !x.is_empty())
            .collect()
    })
    .unwrap_or_default()
}

/// `Importance: high` / `X-Priority: 1 (Highest)` / `Priority: urgent` → 0 low, 1 normal, 2 high.
fn importance(msg: &mail_parser::Message) -> u8 {
    let raw = |h: &str| msg.header_raw(h).map(|v| v.trim().to_ascii_lowercase());
    if let Some(v) = raw("Importance") {
        return match v.as_str() {
            "high" | "hoch" => 2,
            "low" | "niedrig" => 0,
            _ => 1,
        };
    }
    if let Some(v) = raw("X-Priority") {
        return match v.chars().next() {
            Some('1' | '2') => 2,
            Some('4' | '5') => 0,
            _ => 1,
        };
    }
    match raw("Priority").as_deref() {
        Some("urgent") => 2,
        Some("non-urgent") => 0,
        _ => 1,
    }
}

/// Parses an `.eml` file; `None` when it is no message at all.
pub fn parse(bytes: &[u8]) -> Option<Parsed> {
    let msg = MessageParser::default().parse(bytes)?;
    // Something that is not a mail parses into an empty message.
    if msg.from().is_none() && msg.subject().is_none() && msg.date().is_none() {
        return None;
    }
    let (from_name, from_email) = msg
        .from()
        .and_then(|a| a.first())
        .map(|a| (a.name().unwrap_or("").to_owned(), a.address().unwrap_or("").to_owned()))
        .unwrap_or_default();
    let received: Option<DateTime<Utc>> = msg.date().and_then(|d| Utc.timestamp_opt(d.to_timestamp(), 0).single());
    let body = msg.body_text(0).map(|b| b.into_owned()).unwrap_or_default();
    let keywords = msg.keywords();
    let categories: Vec<String> = match (keywords.as_text_list(), keywords.as_text()) {
        (Some(l), _) => l.iter().map(|x| x.to_string()).collect(),
        (None, Some(t)) => vec![t.to_owned()],
        _ => vec![],
    }
    .iter()
    .flat_map(|k| k.split([',', ';']).map(|x| x.trim().to_owned()).collect::<Vec<_>>())
    .filter(|x| !x.is_empty())
    .collect();
    let mut attachments = vec![];
    let mut parts = vec![];
    for (i, part) in msg.attachments().enumerate() {
        let data = part.contents().to_vec();
        let name = match part.attachment_name() {
            Some(n) if !n.trim().is_empty() => n.trim().to_owned(),
            _ => match part.message().and_then(|m| m.subject()) {
                Some(s) => format!("{}.eml", s.trim()),
                None => format!("Anhang {}", i + 1),
            },
        };
        let disposition_inline = part.content_disposition().is_some_and(|d| d.is_inline());
        attachments.push(MailAttachment {
            index: i as u32 + 1,
            name,
            size: data.len() as u64,
            inline: part.content_id().is_some() && disposition_inline
                || part.content_id().is_some() && part.attachment_name().is_none(),
            file: String::new(),
        });
        parts.push(data);
    }
    let mail = Mail {
        source: MailSource::Eml,
        subject: msg.subject().unwrap_or("").to_owned(),
        from_name,
        from_email,
        to: names(msg.to()),
        cc: names(msg.cc()),
        received,
        conversation: msg
            .header("Thread-Topic")
            .and_then(|h| h.as_text())
            .or_else(|| msg.header_raw("Thread-Topic"))
            .map(|t| t.trim().to_owned())
            .unwrap_or_default(),
        importance: importance(&msg),
        categories,
        body,
        attachments,
        ..Default::default()
    };
    Some(Parsed { mail, parts })
}
