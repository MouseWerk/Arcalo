//! Voice notes: recording settings, the Whisper model registry and its downloads, the audio
//! files (16 kHz mono, stored as FLAC), the transcript as Markdown and the action items of a
//! summary. Recording and transcription themselves run in the shell (microphone, whisper.cpp);
//! everything here is plain logic and tested without a microphone or a model.
//!
//! A voice note is a page „Sprachnotiz 01.10.2026 14:30“ (or the meeting's note, or the page the
//! recording was started on) with a block: heading, the audio embed `![[….flac]]`, and the
//! transcript as a collapsed callout. While the transcription runs the block holds a status line
//! (see [`pending_block`]) that [`finish_block`] replaces.

pub mod actions;
pub mod audio;
pub mod download;
pub mod models;
pub mod transcript;

use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::db::Database;
use crate::error::Result;
use crate::model::Page;
use crate::{tr, trf};

/// Settings → Sprachnotizen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct VoiceSettings {
    /// Whisper model id (`base`, `small`, `large-v3-turbo-q5`, see [`models::MODELS`]).
    pub model: String,
    /// Admin source tried before the defaults: an `https://` address or a folder (UNC share,
    /// mounted drive, `file://`) holding the model files under their usual names. `""` = none.
    pub source_url: String,
    /// `auto` (German or English, detected), `de` or `en`.
    pub language: String,
    /// Name of the input device (`""` = the system default).
    pub input_device: String,
    /// Windows: record the system audio too (WASAPI loopback), e.g. the other side of a call.
    pub system_audio: bool,
    /// Summarize with the configured AI right after the transcription.
    pub auto_summary: bool,
    /// Keep the audio file once the transcript is written.
    pub keep_audio: bool,
    /// Global shortcut that starts or stops a recording (`""` = off).
    pub shortcut: String,
}

impl Default for VoiceSettings {
    fn default() -> Self {
        Self {
            model: models::DEFAULT_MODEL.into(),
            source_url: String::new(),
            language: "auto".into(),
            input_device: String::new(),
            system_audio: false,
            auto_summary: false,
            keep_audio: true,
            shortcut: String::new(),
        }
    }
}

impl VoiceSettings {
    /// The language passed to Whisper: `None` lets it detect German or English.
    pub fn whisper_language(&self) -> Option<&'static str> {
        match self.language.as_str() {
            "de" => Some("de"),
            "en" => Some("en"),
            _ => None,
        }
    }
}

/// Title of a new voice-note page: „Sprachnotiz 01.10.2026 14:30“ / “Voice note 01.10.2026 14:30”.
pub fn page_title(local: chrono::NaiveDateTime) -> String {
    let when = local.format("%d.%m.%Y %H:%M");
    trf!("Sprachnotiz {when}", "Voice note {when}")
}

/// Name of the audio file (without extension), the page title's date with file-safe `-` in the
/// time: „Sprachnotiz 01.10.2026 14-30“.
pub fn audio_base(local: chrono::NaiveDateTime) -> String {
    let when = local.format("%d.%m.%Y %H-%M");
    trf!("Sprachnotiz {when}", "Voice note {when}")
}

/// The status line of a block whose transcript is still being written; `token` makes it unique
/// on the page so [`finish_block`] finds exactly this one.
pub fn pending_line(token: &str) -> String {
    trf!("*Transkription läuft … ({token})*", "*Transcribing … ({token})*")
}

/// The block added to a page when a recording stops: heading with the time, the audio embed
/// (none when the audio is not kept) and the status line.
pub fn pending_block(local: chrono::NaiveDateTime, audio: Option<&str>, token: &str) -> String {
    let heading = trf!("## Sprachnotiz {}", "## Voice note {}", local.format("%H:%M"));
    let mut out = format!("{heading}\n\n");
    if let Some(name) = audio {
        out.push_str(&format!("![[{name}]]\n\n"));
    }
    out.push_str(&pending_line(token));
    out.push('\n');
    out
}

/// Appends `block` to `content` with one blank line between.
pub fn append_block(content: &str, block: &str) -> String {
    let body = content.trim_end();
    if body.is_empty() { block.to_owned() } else { format!("{body}\n\n{block}") }
}

/// Puts `replacement` where the status line of `token` is; appended at the end when the line
/// was edited away in the meantime.
pub fn finish_block(content: &str, token: &str, replacement: &str) -> String {
    let line = pending_line(token);
    let replacement = replacement.trim_end();
    if let Some(at) = content.find(&line) {
        let mut out = String::with_capacity(content.len() + replacement.len());
        out.push_str(&content[..at]);
        out.push_str(replacement);
        out.push_str(&content[at + line.len()..]);
        return out;
    }
    append_block(content, &format!("{replacement}\n"))
}

/// Removes the audio embed of `name` (the audio was not kept): its own line goes, with one blank line.
pub fn remove_embed(content: &str, name: &str) -> String {
    let embed = format!("![[{name}]]");
    let mut out: Vec<&str> = Vec::new();
    let mut skip_blank = false;
    for line in content.split('\n') {
        if line.trim() == embed {
            skip_blank = true;
            continue;
        }
        if skip_blank && line.trim().is_empty() {
            skip_blank = false;
            continue;
        }
        skip_blank = false;
        out.push(line);
    }
    out.join("\n")
}

/// Where the transcript of the voice note with the audio `name` is: the byte range of the
/// transcript callout (`> [!note]- Transkript …` and its `>` lines) after the embed, or an empty
/// range right after the embed when there is none. `None` without the embed.
pub fn transcript_range(content: &str, name: &str) -> Option<std::ops::Range<usize>> {
    let embed = format!("![[{name}]]");
    let mut offset = 0;
    let mut lines = content.split_inclusive('\n').peekable();
    // The embed's own line.
    loop {
        let line = lines.next()?;
        offset += line.len();
        if line.trim() == embed {
            break;
        }
    }
    let after_embed = offset;
    let mut start = None;
    let mut end = offset;
    for line in lines {
        let t = line.trim();
        match start {
            None if t.is_empty() => {}
            None if is_transcript_head(t) => start = Some(offset),
            None => break,
            Some(_) if t.starts_with('>') => {}
            Some(_) => break,
        }
        offset += line.len();
        if start.is_some() {
            end = offset;
        }
    }
    match start {
        Some(s) => Some(s..end),
        None => Some(after_embed..after_embed),
    }
}

/// The first line of a transcript callout (in either language), or the status line of one being
/// written.
fn is_transcript_head(line: &str) -> bool {
    let head = line.trim_start_matches('>').trim();
    let title = head.strip_prefix("[!note]-").or_else(|| head.strip_prefix("[!note]")).map(str::trim);
    title.is_some_and(|t| t.starts_with("Transkript") || t.starts_with("Transcript"))
}

/// „Neu transkribieren“: the transcript of the voice note with the audio `name` gives way to the
/// status line of `token` ([`finish_block`] puts the new one there). `None` without the embed.
pub fn begin_again(content: &str, name: &str, token: &str) -> Option<String> {
    let r = transcript_range(content, name)?;
    let line = pending_line(token);
    let mut out = String::with_capacity(content.len() + line.len() + 2);
    out.push_str(&content[..r.start]);
    if r.is_empty() {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push('\n');
        out.push_str(&line);
        out.push('\n');
        if !content[r.end..].is_empty() && !content[r.end..].starts_with('\n') {
            out.push('\n');
        }
    } else {
        out.push_str(&line);
        out.push('\n');
    }
    out.push_str(&content[r.end..]);
    Some(out)
}

/// A recording left in `<data>/voice/` by a crash or a forced quit („unfertige Aufnahme“).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Unfinished {
    /// File name in the voice folder (`rec-….wav`).
    pub name: String,
    pub duration_ms: i64,
    /// When it was last written (RFC 3339): about when the recording ended.
    pub modified: chrono::DateTime<chrono::Utc>,
}

/// The unfinished recordings in `dir`, oldest first; `busy` names files still in use (the
/// running recording, transcriptions that read them). Files without any audio are removed.
pub fn unfinished(dir: &std::path::Path, busy: &[String]) -> Vec<Unfinished> {
    let Ok(entries) = std::fs::read_dir(dir) else { return vec![] };
    let mut out: Vec<Unfinished> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if !name.to_lowercase().ends_with(".wav") || busy.contains(&name) {
                return None;
            }
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            let samples = audio::wav_samples(meta.len());
            if samples == 0 {
                let _ = std::fs::remove_file(e.path());
                return None;
            }
            let modified =
                meta.modified().map(chrono::DateTime::<chrono::Utc>::from).unwrap_or_else(|_| chrono::Utc::now());
            Some(Unfinished { name, duration_ms: i64::from(samples) * 1000 / i64::from(audio::RATE), modified })
        })
        .collect();
    out.sort_by(|a, b| a.modified.cmp(&b.modified).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Whether `name` is a plain file name of the voice folder (no path, a WAV).
pub fn is_recording_name(name: &str) -> bool {
    !name.is_empty()
        && !name.contains(['/', '\\', ':'])
        && !name.starts_with('.')
        && name.to_lowercase().ends_with(".wav")
}

/// Title of the page new voice notes go below (top level, created on first use).
pub fn parent_title() -> &'static str {
    tr!("Sprachnotizen", "Voice notes")
}

impl Database {
    /// The top-level page „Sprachnotizen“, created when missing.
    pub fn voice_parent(&self) -> Result<i64> {
        let title = parent_title();
        let found = self
            .conn()
            .query_row(
                "SELECT id FROM pages WHERE parent_id IS NULL AND deleted_at IS NULL AND title = ?1 COLLATE NOCASE ORDER BY id LIMIT 1",
                [title],
                |r| r.get::<_, i64>(0),
            )
            .optional()?;
        match found {
            Some(id) => Ok(id),
            None => Ok(self.create_page(None, title, Some("mic"))?.id),
        }
    }

    /// Adds the pending block of a stopped recording to `page_id`, or to a new page „Sprachnotiz
    /// <date time>“ below [`Database::voice_parent`]. Returns the page.
    pub fn voice_begin(
        &self,
        page_id: Option<i64>,
        local: chrono::NaiveDateTime,
        audio: Option<&str>,
        token: &str,
    ) -> Result<Page> {
        let block = pending_block(local, audio, token);
        let page = match page_id {
            Some(id) => self.page_doc(id)?.page,
            None => {
                let base = page_title(local);
                let mut title = base.clone();
                let mut n = 2;
                while self.page_by_title(&title)?.is_some() {
                    title = format!("{base} ({n})");
                    n += 1;
                }
                self.create_page(None, &title, Some("mic"))?
            }
        };
        let content = self.page_doc(page.id)?.content;
        self.save_page_content(page.id, &append_block(&content, &block))?;
        if page_id.is_none() {
            // Sprachnotizen/2026/10 – Oktober (Settings → Ordner & Ablage).
            let info =
                crate::filing::FileInfo { kind: crate::filing::FileType::Voice, date: local.date(), group: None };
            self.file_page(page.id, &info)?;
            return self.page(page.id);
        }
        Ok(page)
    }

    /// Puts `markdown` (the transcript, or why there is none) where the status line of `token`
    /// is, and removes the embed of `drop_audio` when the audio is not kept.
    pub fn voice_finish(&self, page_id: i64, token: &str, markdown: &str, drop_audio: Option<&str>) -> Result<()> {
        let content = self.page_doc(page_id)?.content;
        let mut next = finish_block(&content, token, markdown);
        if let Some(name) = drop_audio {
            next = remove_embed(&next, name);
        }
        self.save_page_content(page_id, &next)
    }

    /// „Neu transkribieren“: puts the status line of `token` where the transcript of the voice
    /// note with the audio `name` is on `page_id`. Returns the page and the transcript replaced.
    pub fn voice_again(&self, page_id: i64, name: &str, token: &str) -> Result<(Page, String)> {
        let doc = self.page_doc(page_id)?;
        let previous = transcript_range(&doc.content, name).map(|r| doc.content[r].to_owned()).unwrap_or_default();
        let next = begin_again(&doc.content, name, token).ok_or_else(|| {
            crate::error::Error::State(
                tr!("Die Aufnahme steht nicht mehr auf der Seite", "The recording is no longer on the page").into(),
            )
        })?;
        self.save_page_content(page_id, &next)?;
        Ok((doc.page, previous))
    }

    /// Appends a summary (see [`actions::summary_block`]); returns the number of tasks in it.
    pub fn voice_append_summary(&self, page_id: i64, summary: &str, today: chrono::NaiveDate) -> Result<usize> {
        let block = actions::summary_block(summary, today);
        let content = self.page_doc(page_id)?.content;
        self.save_page_content(page_id, &append_block(&content, &block))?;
        Ok(crate::tasks::parse_tasks(&block).len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at() -> chrono::NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 10, 1).unwrap().and_hms_opt(14, 30, 0).unwrap()
    }

    #[test]
    fn defaults_and_language() {
        let s = VoiceSettings::default();
        assert_eq!(s.model, "small");
        assert!(s.keep_audio && !s.auto_summary);
        assert_eq!(s.whisper_language(), None);
        assert_eq!(VoiceSettings { language: "en".into(), ..s }.whisper_language(), Some("en"));
        // Older settings without the section get the defaults.
        let parsed: VoiceSettings = serde_json::from_str(r#"{"model":"base"}"#).unwrap();
        assert_eq!(parsed.language, "auto");
        assert!(parsed.keep_audio);
    }

    #[test]
    fn pending_block_is_replaced_by_the_transcript() {
        {
            assert_eq!(page_title(at()), "Sprachnotiz 01.10.2026 14:30");
            assert_eq!(audio_base(at()), "Sprachnotiz 01.10.2026 14-30", "the title's date, file-safe");
            let block = pending_block(at(), Some("Sprachnotiz.flac"), "a1");
            assert_eq!(block, "## Sprachnotiz 14:30\n\n![[Sprachnotiz.flac]]\n\n*Transkription läuft … (a1)*\n");
            let page = append_block("# Jour fixe\n\nNotizen\n\n", &block);
            assert!(page.starts_with("# Jour fixe\n\nNotizen\n\n## Sprachnotiz 14:30"));
            let done = finish_block(&page, "a1", "> [!quote]- Transkript\n> Hallo\n");
            assert!(done.contains("![[Sprachnotiz.flac]]\n\n> [!quote]- Transkript\n> Hallo\n"));
            assert!(!done.contains("läuft"));
            // The status line was deleted: the transcript goes to the end.
            let gone = finish_block("# Notiz\n", "a1", "Text");
            assert_eq!(gone, "# Notiz\n\nText\n");
            assert_eq!(remove_embed(&done, "Sprachnotiz.flac").matches("flac").count(), 0);
            assert!(remove_embed(&done, "Sprachnotiz.flac").contains("## Sprachnotiz 14:30\n\n> [!quote]-"));
        }
    }

    #[test]
    fn transcribing_again_replaces_the_transcript() {
        let page = "# Jour fixe\n\n## Sprachnotiz 14:30\n\n![[a.flac]]\n\n> [!note]- Transkript · 00:12 · Deutsch\n> **00:00** Hallo\n>\n> **00:05** Welt\n\n## Zusammenfassung\nKurz.\n";
        let next = begin_again(page, "a.flac", "r1").unwrap();
        assert_eq!(
            next,
            "# Jour fixe\n\n## Sprachnotiz 14:30\n\n![[a.flac]]\n\n*Transkription läuft … (r1)*\n\n## Zusammenfassung\nKurz.\n"
        );
        let done = finish_block(&next, "r1", "> [!note]- Transcript · 00:12 · English\n> **00:00** Hello\n");
        assert!(done.contains(
            "![[a.flac]]\n\n> [!note]- Transcript · 00:12 · English\n> **00:00** Hello\n\n## Zusammenfassung"
        ));
        // The English callout is found too (a second run).
        assert!(
            begin_again(&done, "a.flac", "r2")
                .unwrap()
                .contains("![[a.flac]]\n\n*Transkription läuft … (r2)*\n\n## Zusammenfassung")
        );
        // No transcript yet (it failed): the status line goes right after the embed.
        let bare = "## Sprachnotiz 14:30\n\n![[a.flac]]\n\nNotiz";
        assert_eq!(
            begin_again(bare, "a.flac", "r3").unwrap(),
            "## Sprachnotiz 14:30\n\n![[a.flac]]\n\n*Transkription läuft … (r3)*\n\nNotiz"
        );
        assert_eq!(
            begin_again("![[a.flac]]", "a.flac", "r4").unwrap(),
            "![[a.flac]]\n\n*Transkription läuft … (r4)*\n"
        );
        // Another embed or none: nothing.
        assert!(begin_again(bare, "b.flac", "r5").is_none());
        // Text after the embed that is no transcript stays.
        let other = "![[a.flac]]\n\n> [!tip] Hinweis\n";
        assert_eq!(transcript_range(other, "a.flac"), Some(12..12));
    }

    #[test]
    fn unfinished_recordings_are_listed() {
        let dir = std::env::temp_dir().join(format!("annalo-voice-unfinished-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rec-a.wav"), vec![0u8; 44 + 32_000]).unwrap();
        std::fs::write(dir.join("rec-b.wav"), vec![0u8; 44 + 16_000]).unwrap();
        std::fs::write(dir.join("rec-empty.wav"), vec![0u8; 44]).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        let list = unfinished(&dir, &["rec-b.wav".to_owned()]);
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].name.as_str(), list[0].duration_ms), ("rec-a.wav", 1000));
        assert!(!dir.join("rec-empty.wav").exists(), "nothing recorded: removed");
        assert_eq!(unfinished(&dir, &[]).len(), 2);
        assert!(is_recording_name("rec-a.wav"));
        assert!(!is_recording_name("../rec-a.wav") && !is_recording_name("notes.txt") && !is_recording_name(""));
        std::fs::remove_dir_all(&dir).unwrap();
        assert!(unfinished(&dir, &[]).is_empty());
    }

    #[test]
    fn voice_notes_go_below_their_parent_and_get_the_transcript() {
        let db = Database::open_in_memory().unwrap();
        let page = db.voice_begin(None, at(), Some("Sprachnotiz 2026-10-01 14-30.flac"), "t1").unwrap();
        assert_eq!(page.title, "Sprachnotiz 01.10.2026 14:30");
        assert_eq!(db.page_path(page.id).unwrap(), "Sprachnotizen / 2026 / 10 – Oktober");
        let parent = db.voice_parent().unwrap();
        assert_eq!(
            db.page(page.parent_id.unwrap()).unwrap().parent_id.and_then(|y| db.page(y).unwrap().parent_id),
            Some(parent)
        );
        // A second one in the same minute gets its own title.
        let second = db.voice_begin(None, at(), None, "t2").unwrap();
        assert_eq!(second.title, "Sprachnotiz 01.10.2026 14:30 (2)");
        assert_eq!(second.parent_id, page.parent_id);

        db.voice_finish(
            page.id,
            "t1",
            "> [!note]- Transkript\n> **00:00** Hallo\n",
            Some("Sprachnotiz 2026-10-01 14-30.flac"),
        )
        .unwrap();
        let content = db.page_doc(page.id).unwrap().content;
        assert!(content.contains("> **00:00** Hallo"));
        assert!(!content.contains(".flac") && !content.contains("läuft"));

        let summary = "## Zusammenfassung\nKurz.\n\n## Aufgaben\n- Anna: Angebot schicken bis 05.10.2026\n";
        assert_eq!(db.voice_append_summary(page.id, summary, at().date()).unwrap(), 1);
        let content = db.page_doc(page.id).unwrap().content;
        assert!(content.contains("### Aufgaben\n- [ ] Angebot schicken @Anna due:2026-10-05"), "{content}");

        // Into an existing page (a meeting note): appended.
        let meeting = db.create_page(None, "Jour fixe", None).unwrap();
        db.save_page_content(meeting.id, "# Agenda\n").unwrap();
        db.voice_begin(Some(meeting.id), at(), None, "t3").unwrap();
        assert_eq!(
            db.page_doc(meeting.id).unwrap().content,
            "# Agenda\n\n## Sprachnotiz 14:30\n\n*Transkription läuft … (t3)*\n"
        );
    }
}
