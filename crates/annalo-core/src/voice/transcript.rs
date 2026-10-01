//! The transcript: Whisper's segments, merged into paragraphs with their start time and written
//! as a collapsed callout (`> [!note]- Transkript · 12:34 · Deutsch`), plus the plain text with
//! timestamps that the summary gets.

use serde::{Deserialize, Serialize};

use crate::tr;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Transcript {
    pub segments: Vec<Segment>,
    /// Detected or chosen language (`de`, `en`, …).
    pub language: Option<String>,
    /// Length of the recording.
    pub duration_ms: i64,
}

/// `65_000` → `01:05`, `3_725_000` → `1:02:05`.
pub fn timestamp(ms: i64) -> String {
    let s = ms.max(0) / 1000;
    let (h, m, s) = (s / 3600, s / 60 % 60, s % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m:02}:{s:02}") }
}

/// Whisper's markers for no speech (`[Musik]`, `(applause)`, `[BLANK_AUDIO]`, `*Lachen*`).
fn is_noise(text: &str) -> bool {
    let t = text.trim();
    t.is_empty()
        || (t.starts_with('[') && t.ends_with(']'))
        || (t.starts_with('(') && t.ends_with(')'))
        || (t.len() > 2 && t.starts_with('*') && t.ends_with('*'))
}

/// One line of text: whitespace and line breaks collapsed.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Segments merged into paragraphs: a paragraph ends at a sentence end once it covers
/// `max_ms`, or at a pause of more than 2 s. Noise markers are left out.
pub fn paragraphs(segments: &[Segment], max_ms: i64) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    let mut open = false;
    for seg in segments.iter().filter(|s| !is_noise(&s.text)) {
        let text = one_line(&seg.text);
        if let Some(last) = out.last_mut().filter(|_| open)
            && seg.start_ms - last.end_ms <= 2000
        {
            last.text.push(' ');
            last.text.push_str(&text);
            last.end_ms = seg.end_ms;
        } else {
            out.push(Segment { start_ms: seg.start_ms, end_ms: seg.end_ms, text });
        }
        let last = out.last().expect("pushed above");
        let sentence_end = last.text.ends_with(['.', '!', '?', '…']);
        open = !(sentence_end && last.end_ms - last.start_ms >= max_ms);
    }
    out
}

fn language_name(code: &str) -> String {
    match code {
        "de" => tr!("Deutsch", "German").into(),
        "en" => tr!("Englisch", "English").into(),
        other => other.to_uppercase(),
    }
}

/// The transcript as a collapsed callout: title with length and language, then one paragraph per
/// line with its start time in bold. An empty transcript says so.
pub fn to_markdown(t: &Transcript) -> String {
    let mut title = vec![tr!("Transkript", "Transcript").to_owned(), timestamp(t.duration_ms)];
    if let Some(lang) = &t.language {
        title.push(language_name(lang));
    }
    let mut out = format!("> [!note]- {}\n", title.join(" · "));
    let paras = paragraphs(&t.segments, 30_000);
    if paras.is_empty() {
        out.push_str(&format!("> *{}*\n", tr!("Keine Sprache erkannt.", "No speech detected.")));
        return out;
    }
    for (i, p) in paras.iter().enumerate() {
        if i > 0 {
            out.push_str(">\n");
        }
        out.push_str(&format!("> **{}** {}\n", timestamp(p.start_ms), p.text));
    }
    out
}

/// Plain text with timestamps (`[00:12] …`), the input of the summary.
pub fn plain_text(t: &Transcript) -> String {
    paragraphs(&t.segments, 30_000)
        .iter()
        .map(|p| format!("[{}] {}", timestamp(p.start_ms), p.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `01:05`, `1:02:05` or `65` (seconds) → milliseconds.
fn parse_timestamp(s: &str) -> Option<i64> {
    let parts: Vec<i64> = s.split(':').map(|p| p.trim().parse::<i64>().ok()).collect::<Option<_>>()?;
    let secs = match parts.as_slice() {
        [s] => *s,
        [m, s] => m * 60 + s,
        [h, m, s] => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(secs * 1000)
}

/// A transcript given as text (the test hook `ANNALO_TEST_TRANSCRIPT`, imported transcripts):
/// lines `[00:12] Text` or `00:12 Text`; lines without a time follow 5 s after the previous one.
pub fn parse_text(text: &str, duration_ms: i64) -> Vec<Segment> {
    let mut out: Vec<Segment> = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let (start, rest) = match line.strip_prefix('[').and_then(|l| l.split_once(']')) {
            Some((ts, rest)) => (parse_timestamp(ts), rest.trim()),
            None => match line.split_once(' ') {
                Some((ts, rest)) if ts.contains(':') => (parse_timestamp(ts), rest.trim()),
                _ => (None, line),
            },
        };
        let start = start.unwrap_or_else(|| out.last().map_or(0, |s| s.start_ms + 5000));
        if let Some(prev) = out.last_mut() {
            prev.end_ms = start.max(prev.start_ms);
        }
        out.push(Segment { start_ms: start, end_ms: start + 5000, text: rest.to_owned() });
    }
    if let Some(last) = out.last_mut()
        && duration_ms > last.start_ms
    {
        last.end_ms = duration_ms;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(a: i64, b: i64, t: &str) -> Segment {
        Segment { start_ms: a, end_ms: b, text: t.into() }
    }

    #[test]
    fn timestamps() {
        assert_eq!(timestamp(0), "00:00");
        assert_eq!(timestamp(65_400), "01:05");
        assert_eq!(timestamp(3_725_000), "1:02:05");
        assert_eq!(parse_timestamp("1:02:05"), Some(3_725_000));
        assert_eq!(parse_timestamp("x"), None);
    }

    #[test]
    fn markdown_is_a_collapsed_callout_with_timestamps() {
        let t = Transcript {
            segments: vec![
                seg(0, 4000, " Guten Morgen zusammen."),
                seg(4000, 9000, " [Musik]"),
                seg(9000, 12_000, " Wir starten mit dem Budget"),
                seg(12_000, 40_000, "und dem Termin.\n"),
                seg(45_000, 50_000, "Anna übernimmt das Angebot."),
            ],
            language: Some("de".into()),
            duration_ms: 51_000,
        };
        assert_eq!(
            to_markdown(&t),
            "> [!note]- Transkript · 00:51 · Deutsch\n\
             > **00:00** Guten Morgen zusammen.\n\
             >\n\
             > **00:09** Wir starten mit dem Budget und dem Termin.\n\
             >\n\
             > **00:45** Anna übernimmt das Angebot.\n"
        );
        assert_eq!(
            plain_text(&t),
            "[00:00] Guten Morgen zusammen.\n[00:09] Wir starten mit dem Budget und dem Termin.\n[00:45] Anna übernimmt das Angebot."
        );
        let empty = Transcript { segments: vec![seg(0, 1000, "[BLANK_AUDIO]")], language: None, duration_ms: 1000 };
        assert_eq!(to_markdown(&empty), "> [!note]- Transkript · 00:01\n> *Keine Sprache erkannt.*\n");
    }

    #[test]
    fn paragraphs_end_at_sentences_after_the_limit() {
        let segs: Vec<_> = (0..8).map(|i| seg(i * 5000, i * 5000 + 5000, "Satz.")).collect();
        let p = paragraphs(&segs, 15_000);
        assert_eq!(p.len(), 3);
        assert_eq!((p[0].start_ms, p[0].end_ms), (0, 15_000));
        assert_eq!(p[2].text, "Satz. Satz.");
    }

    #[test]
    fn english_titles() {
        crate::i18n::with_lang(crate::prefs::Language::En, || {
            let t =
                Transcript { segments: vec![seg(0, 2000, "Hello.")], language: Some("en".into()), duration_ms: 2000 };
            assert!(to_markdown(&t).starts_with("> [!note]- Transcript · 00:02 · English\n> **00:00** Hello."));
        });
    }

    #[test]
    fn text_transcripts_are_parsed() {
        let s = parse_text("[00:00] Hallo\n00:07 Zweiter Punkt\nDritter\n\n", 20_000);
        assert_eq!(s, [seg(0, 7000, "Hallo"), seg(7000, 12_000, "Zweiter Punkt"), seg(12_000, 20_000, "Dritter")]);
    }
}
