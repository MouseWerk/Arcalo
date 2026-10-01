//! The assistant's chat history (`chat_conversations`, `chat_messages`, v12).
//!
//! The panel saves every turn when it is finished (a stopped answer with what arrived, a failed
//! one with its error): the messages the model got and what the panel showed, so an old chat
//! opens exactly as it was and can be continued. Conversations are listed newest first, pinned
//! ones on top, and searched by title and by the text of the questions and answers
//! (`chat_messages_fts`).
//!
//! Privacy: a conversation that touched private content is marked `private` and stays on the
//! local model when it is continued (`ai_chat` checks the flag). Chats live only in the
//! database: no assistant tool and no retrieval reads them, and they are part of every backup
//! like the pages. Settings → Datenschutz „Chat-Verlauf“ keeps them forever, 90 or 30 days
//! after their last message (pinned ones stay) or does not save them at all.

use std::collections::HashMap;

use chrono::{DateTime, Duration, Utc};
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::db::{Database, parse_ts, ts};
use crate::error::{Error, Result};
use crate::prefs::ChatRetention;
use crate::search::fts_query;

/// Longest title kept (characters).
pub const TITLE_MAX: usize = 80;
/// A deleted conversation can be brought back for this long; later deletes and the start purge it.
pub const UNDO_SECS: i64 = 60;
/// Highlight markers around a search hit in [`Conversation::snippet`].
pub const HIT_START: char = '\u{2}';
pub const HIT_END: char = '\u{3}';

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Conversation {
    pub id: i64,
    pub title: String,
    /// Renamed by the user (an automatic title is never put over it).
    pub title_custom: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub pinned: bool,
    pub archived: bool,
    pub private: bool,
    /// Provider, model and tier of the last answer.
    pub provider: String,
    pub model: String,
    pub tier: String,
    /// Pages sent as context, in the order they were first sent.
    pub page_ids: Vec<i64>,
    /// Questions and answers (tool steps not counted).
    pub messages: i64,
    /// For a search: the best matching passage, the hit between [`HIT_START`] and [`HIT_END`].
    pub snippet: Option<String>,
}

/// A saved message.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StoredMessage {
    pub id: i64,
    pub seq: i64,
    #[serde(flatten)]
    pub message: NewMessage,
    pub created_at: DateTime<Utc>,
}

/// A message to save. `role` is `user`, `assistant` or `tool`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct NewMessage {
    pub role: String,
    pub content: String,
    /// What the panel showed for a user message instead of the prompt (e.g. „Wochenbericht KW 40“).
    pub display: Option<String>,
    pub tool_calls: Option<Value>,
    pub tool_call_id: Option<String>,
    /// The tool card: name, label, status, summary, output.
    pub tool: Option<Value>,
    /// The retrieved sources of an answer (`[n]` is the n-th).
    pub citations: Option<Value>,
    pub provider: String,
    pub model: String,
    pub tier: String,
    pub reasons: Option<Value>,
    /// Model label, time to first token, tokens per second, exact usage.
    pub meta: Option<Value>,
    pub tokens: i64,
    pub cost_usd: f64,
    pub error: Option<String>,
    pub cancelled: bool,
    /// `false` for the messages of a failed turn: shown, never sent again.
    pub in_context: bool,
    pub page_title: Option<String>,
}

impl Default for NewMessage {
    fn default() -> Self {
        NewMessage {
            role: "user".into(),
            content: String::new(),
            display: None,
            tool_calls: None,
            tool_call_id: None,
            tool: None,
            citations: None,
            provider: String::new(),
            model: String::new(),
            tier: String::new(),
            reasons: None,
            meta: None,
            tokens: 0,
            cost_usd: 0.0,
            error: None,
            cancelled: false,
            in_context: true,
            page_title: None,
        }
    }
}

/// What changes with an update; `None` keeps the field.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct ConversationPatch {
    pub title: Option<String>,
    pub pinned: Option<bool>,
    pub archived: Option<bool>,
}

/// A saved conversation with its messages.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ConversationDoc {
    pub conversation: Conversation,
    pub messages: Vec<StoredMessage>,
}

fn clean_title(title: &str) -> String {
    let flat = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= TITLE_MAX {
        return flat;
    }
    let cut: String = flat.chars().take(TITLE_MAX - 1).collect();
    format!("{}…", cut.trim_end())
}

fn json(v: &Option<Value>) -> Option<String> {
    v.as_ref().filter(|v| !v.is_null()).map(|v| v.to_string())
}

fn parse_json(s: Option<String>) -> Option<Value> {
    s.and_then(|s| serde_json::from_str(&s).ok())
}

const CONVERSATION_COLUMNS: &str =
    "c.id, c.title, c.title_custom, c.created_at, c.updated_at, c.pinned, c.archived, c.private,
     c.provider, c.model, c.tier, c.page_ids,
     (SELECT COUNT(*) FROM chat_messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant'))";

fn conversation_row(r: &Row) -> rusqlite::Result<Conversation> {
    let page_ids: String = r.get(11)?;
    Ok(Conversation {
        id: r.get(0)?,
        title: r.get(1)?,
        title_custom: r.get(2)?,
        created_at: parse_ts(&r.get::<_, String>(3)?)?,
        updated_at: parse_ts(&r.get::<_, String>(4)?)?,
        pinned: r.get(5)?,
        archived: r.get(6)?,
        private: r.get(7)?,
        provider: r.get(8)?,
        model: r.get(9)?,
        tier: r.get(10)?,
        page_ids: serde_json::from_str(&page_ids).unwrap_or_default(),
        messages: r.get(12)?,
        snippet: None,
    })
}

impl Database {
    /// The conversation `id` (not one deleted a moment ago).
    pub fn chat_conversation(&self, id: i64) -> Result<Conversation> {
        self.conn()
            .query_row(
                &format!(
                    "SELECT {CONVERSATION_COLUMNS} FROM chat_conversations c WHERE c.id = ?1 AND c.deleted_at IS NULL"
                ),
                [id],
                conversation_row,
            )
            .optional()?
            .ok_or_else(|| Error::not_found("chat", id.to_string()))
    }

    /// Starts a conversation titled `title` (whitespace collapsed, at most [`TITLE_MAX`] characters).
    pub fn chat_create(&self, title: &str, private: bool, now: DateTime<Utc>) -> Result<Conversation> {
        let title = clean_title(title);
        self.conn().execute(
            "INSERT INTO chat_conversations (title, created_at, updated_at, private) VALUES (?1, ?2, ?2, ?3)",
            params![title, ts(now), private],
        )?;
        self.chat_conversation(self.conn().last_insert_rowid())
    }

    /// Appends `messages` to conversation `id` (in order) and records what the turn touched: the
    /// model of its last answer, the page sent as context, private content. Returns the
    /// conversation and the sequence numbers of the new messages.
    pub fn chat_append(
        &self,
        id: i64,
        messages: &[NewMessage],
        page_id: Option<i64>,
        private: bool,
        now: DateTime<Utc>,
    ) -> Result<(Conversation, Vec<i64>)> {
        self.atomic(|| {
            let conv = self.chat_conversation(id)?;
            let conn = self.conn();
            let mut seq: i64 = conn.query_row(
                "SELECT COALESCE(MAX(seq), -1) FROM chat_messages WHERE conversation_id = ?1",
                [id],
                |r| r.get(0),
            )?;
            let mut seqs = Vec::with_capacity(messages.len());
            let mut st = conn.prepare_cached(
                "INSERT INTO chat_messages (conversation_id, seq, role, content, display, tool_calls, tool_call_id, tool,
                   citations, provider, model, tier, reasons, meta, tokens, cost_usd, error, cancelled, in_context,
                   page_title, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
            )?;
            for m in messages {
                seq += 1;
                st.execute(params![
                    id,
                    seq,
                    m.role,
                    m.content,
                    m.display,
                    json(&m.tool_calls),
                    m.tool_call_id,
                    json(&m.tool),
                    json(&m.citations),
                    m.provider,
                    m.model,
                    m.tier,
                    json(&m.reasons),
                    json(&m.meta),
                    m.tokens,
                    m.cost_usd,
                    m.error,
                    m.cancelled,
                    m.in_context,
                    m.page_title,
                    ts(now),
                ])?;
                seqs.push(seq);
            }
            let answered = messages.iter().rev().find(|m| m.role == "assistant" && !m.model.is_empty());
            let (provider, model, tier) = match answered {
                Some(m) => (m.provider.clone(), m.model.clone(), m.tier.clone()),
                None => (conv.provider.clone(), conv.model.clone(), conv.tier.clone()),
            };
            let mut pages = conv.page_ids.clone();
            if let Some(p) = page_id.filter(|p| !pages.contains(p)) {
                pages.push(p);
            }
            conn.execute(
                "UPDATE chat_conversations SET updated_at = ?2, provider = ?3, model = ?4, tier = ?5, page_ids = ?6,
                   private = private OR ?7
                 WHERE id = ?1",
                params![id, ts(now), provider, model, tier, serde_json::to_string(&pages)?, private],
            )?;
            Ok((self.chat_conversation(id)?, seqs))
        })
    }

    /// Removes the messages from `seq` on (a regenerated answer, an edited question).
    pub fn chat_truncate(&self, id: i64, seq: i64) -> Result<usize> {
        Ok(self
            .conn()
            .execute("DELETE FROM chat_messages WHERE conversation_id = ?1 AND seq >= ?2", params![id, seq])?)
    }

    /// The conversation with its messages in order.
    pub fn chat_get(&self, id: i64) -> Result<ConversationDoc> {
        let conversation = self.chat_conversation(id)?;
        let mut st = self.conn().prepare_cached(
            "SELECT id, seq, role, content, display, tool_calls, tool_call_id, tool, citations, provider, model, tier,
               reasons, meta, tokens, cost_usd, error, cancelled, in_context, page_title, created_at
             FROM chat_messages WHERE conversation_id = ?1 ORDER BY seq",
        )?;
        let messages = st
            .query_map([id], |r| {
                Ok(StoredMessage {
                    id: r.get(0)?,
                    seq: r.get(1)?,
                    message: NewMessage {
                        role: r.get(2)?,
                        content: r.get(3)?,
                        display: r.get(4)?,
                        tool_calls: parse_json(r.get(5)?),
                        tool_call_id: r.get(6)?,
                        tool: parse_json(r.get(7)?),
                        citations: parse_json(r.get(8)?),
                        provider: r.get(9)?,
                        model: r.get(10)?,
                        tier: r.get(11)?,
                        reasons: parse_json(r.get(12)?),
                        meta: parse_json(r.get(13)?),
                        tokens: r.get(14)?,
                        cost_usd: r.get(15)?,
                        error: r.get(16)?,
                        cancelled: r.get(17)?,
                        in_context: r.get(18)?,
                        page_title: r.get(19)?,
                    },
                    created_at: parse_ts(&r.get::<_, String>(20)?)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ConversationDoc { conversation, messages })
    }

    /// Renames, pins or archives a conversation. A rename is the user's title from then on;
    /// none of these counts as activity (the conversation keeps its place in the list).
    pub fn chat_update(&self, id: i64, patch: &ConversationPatch) -> Result<Conversation> {
        self.chat_conversation(id)?;
        let conn = self.conn();
        if let Some(title) = &patch.title {
            let title = clean_title(title);
            if !title.is_empty() {
                conn.execute(
                    "UPDATE chat_conversations SET title = ?2, title_custom = 1 WHERE id = ?1",
                    params![id, title],
                )?;
            }
        }
        if let Some(p) = patch.pinned {
            conn.execute("UPDATE chat_conversations SET pinned = ?2 WHERE id = ?1", params![id, p])?;
        }
        if let Some(a) = patch.archived {
            conn.execute("UPDATE chat_conversations SET archived = ?2 WHERE id = ?1", params![id, a])?;
        }
        self.chat_conversation(id)
    }

    /// Marks conversation `id` private (never undone: what was said stays private).
    pub fn chat_mark_private(&self, id: i64) -> Result<()> {
        self.conn().execute("UPDATE chat_conversations SET private = 1 WHERE id = ?1", [id])?;
        Ok(())
    }

    /// Whether conversation `id` is private (also while it waits for its undo).
    pub fn chat_is_private(&self, id: i64) -> Result<bool> {
        Ok(self
            .conn()
            .query_row("SELECT private FROM chat_conversations WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// The conversations, pinned ones first, then by their last message. With `query`: those
    /// whose title or messages contain it (every word, the last one as a prefix), each with the
    /// best matching passage. Archived ones only with `archived`.
    pub fn chat_list(&self, query: &str, archived: bool, limit: usize) -> Result<Vec<Conversation>> {
        let mut st = self.conn().prepare_cached(&format!(
            "SELECT {CONVERSATION_COLUMNS} FROM chat_conversations c
             WHERE c.deleted_at IS NULL AND (?1 OR c.archived = 0)
             ORDER BY c.pinned DESC, c.updated_at DESC, c.id DESC"
        ))?;
        let all = st.query_map([archived], conversation_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
        let Some(fts) = fts_query(query) else {
            return Ok(all.into_iter().take(limit).collect());
        };
        let mut snippets: HashMap<i64, String> = HashMap::new();
        let mut hits = self.conn().prepare_cached(
            "SELECT m.conversation_id, snippet(chat_messages_fts, 0, char(2), char(3), '…', 12)
             FROM chat_messages_fts JOIN chat_messages m ON m.id = chat_messages_fts.rowid
             WHERE chat_messages_fts MATCH ?1 AND m.role IN ('user', 'assistant')
             ORDER BY bm25(chat_messages_fts) LIMIT 2000",
        )?;
        for row in hits.query_map([&fts], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, snippet) = row?;
            snippets.entry(id).or_insert(snippet);
        }
        let words: Vec<String> = query.split_whitespace().map(fold).collect();
        Ok(all
            .into_iter()
            .filter_map(|mut c| {
                let title = fold(&c.title);
                let in_title = words.iter().all(|w| title.contains(w.as_str()));
                match snippets.remove(&c.id) {
                    Some(s) => c.snippet = Some(s),
                    None if in_title => {}
                    None => return None,
                }
                Some(c)
            })
            .take(limit)
            .collect())
    }

    /// Deletes conversation `id`; [`Database::chat_restore`] brings it back for [`UNDO_SECS`].
    /// Conversations deleted earlier than that are removed for good.
    pub fn chat_delete(&self, id: i64, now: DateTime<Utc>) -> Result<()> {
        self.chat_purge_deleted(now - Duration::seconds(UNDO_SECS))?;
        let n = self.conn().execute(
            "UPDATE chat_conversations SET deleted_at = ?2 WHERE id = ?1 AND deleted_at IS NULL",
            params![id, ts(now)],
        )?;
        if n == 0 {
            return Err(Error::not_found("chat", id.to_string()));
        }
        Ok(())
    }

    /// Undoes [`Database::chat_delete`].
    pub fn chat_restore(&self, id: i64) -> Result<Conversation> {
        self.conn().execute("UPDATE chat_conversations SET deleted_at = NULL WHERE id = ?1", [id])?;
        self.chat_conversation(id)
    }

    /// Removes conversations deleted before `before` for good (all deleted ones on start).
    pub fn chat_purge_deleted(&self, before: DateTime<Utc>) -> Result<usize> {
        Ok(self.conn().execute(
            "DELETE FROM chat_conversations WHERE deleted_at IS NOT NULL AND deleted_at <= ?1",
            [ts(before)],
        )?)
    }

    /// „Alle Chats löschen“: every conversation, pinned and private ones included.
    pub fn chat_delete_all(&self) -> Result<usize> {
        self.atomic(|| {
            let n = self.conn().execute("DELETE FROM chat_conversations", [])?;
            // Nothing of the old texts stays in the search index's pages.
            self.conn().execute("INSERT INTO chat_messages_fts(chat_messages_fts) VALUES ('optimize')", [])?;
            Ok(n)
        })
    }

    /// A copy of conversation `id` to continue separately („Duplizieren“); it keeps the
    /// private flag and the pages, and is the newest conversation.
    pub fn chat_duplicate(&self, id: i64, title: &str, now: DateTime<Utc>) -> Result<Conversation> {
        self.atomic(|| {
            let src = self.chat_conversation(id)?;
            let conn = self.conn();
            conn.execute(
                "INSERT INTO chat_conversations (title, title_custom, created_at, updated_at, private, provider, model, tier, page_ids)
                 VALUES (?1, 1, ?2, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    clean_title(title),
                    ts(now),
                    src.private,
                    src.provider,
                    src.model,
                    src.tier,
                    serde_json::to_string(&src.page_ids)?
                ],
            )?;
            let copy = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO chat_messages (conversation_id, seq, role, content, display, tool_calls, tool_call_id, tool,
                   citations, provider, model, tier, reasons, meta, tokens, cost_usd, error, cancelled, in_context,
                   page_title, created_at)
                 SELECT ?2, seq, role, content, display, tool_calls, tool_call_id, tool, citations, provider, model, tier,
                   reasons, meta, tokens, cost_usd, error, cancelled, in_context, page_title, created_at
                 FROM chat_messages WHERE conversation_id = ?1 ORDER BY seq",
                params![id, copy],
            )?;
            self.chat_conversation(copy)
        })
    }

    /// Applies the retention of Settings → Datenschutz: removes conversations whose last message
    /// is older than the limit (pinned ones stay) and those deleted before `now`. Returns how
    /// many conversations went.
    pub fn chat_prune(&self, retention: ChatRetention, now: DateTime<Utc>) -> Result<usize> {
        let mut n = self.chat_purge_deleted(now)?;
        if let Some(days) = retention.days() {
            n += self.conn().execute(
                "DELETE FROM chat_conversations WHERE pinned = 0 AND updated_at < ?1",
                [ts(now - Duration::days(days))],
            )?;
        }
        Ok(n)
    }
}

/// Lower-cased, for the title match.
fn fold(s: &str) -> String {
    s.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use serde_json::json;

    fn t(min: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 9, 1, 8, 0, 0).unwrap() + Duration::minutes(min)
    }

    fn user(text: &str) -> NewMessage {
        NewMessage { role: "user".into(), content: text.into(), ..Default::default() }
    }

    fn answer(text: &str, model: &str) -> NewMessage {
        NewMessage {
            role: "assistant".into(),
            content: text.into(),
            provider: "litellm".into(),
            model: model.into(),
            tier: "standard".into(),
            tokens: 120,
            cost_usd: 0.0012,
            reasons: Some(json!(["prompt ~10 tokens"])),
            citations: Some(json!([{ "source": "Seite: Architektur", "page_id": 3, "text": "Go-Live" }])),
            ..Default::default()
        }
    }

    #[test]
    fn create_append_get_and_continue() {
        let db = Database::open_in_memory().unwrap();
        let c = db.chat_create("  Wie ist der\nStand im Projekt?  ", false, t(0)).unwrap();
        assert_eq!(c.title, "Wie ist der Stand im Projekt?");
        assert_eq!((c.messages, c.private, c.title_custom), (0, false, false));

        let tool_calls =
            json!([{ "id": "call_1", "type": "function", "function": { "name": "log_time", "arguments": "{}" } }]);
        let (c, seqs) = db
            .chat_append(
                c.id,
                &[
                    user("Buche 1 h"),
                    NewMessage { role: "assistant".into(), tool_calls: Some(tool_calls.clone()), ..answer("", "m1") },
                    NewMessage {
                        role: "tool".into(),
                        content: "{\"ok\":true}".into(),
                        tool_call_id: Some("call_1".into()),
                        tool: Some(json!({ "name": "log_time", "status": "done" })),
                        ..Default::default()
                    },
                ],
                Some(7),
                false,
                t(1),
            )
            .unwrap();
        assert_eq!(seqs, [0, 1, 2]);
        let (c, seqs) = db.chat_append(c.id, &[answer("Erledigt.", "m2")], Some(7), false, t(2)).unwrap();
        assert_eq!(seqs, [3]);
        assert_eq!((c.model.as_str(), c.provider.as_str(), c.tier.as_str()), ("m2", "litellm", "standard"));
        assert_eq!(c.page_ids, [7], "a page is recorded once");
        assert_eq!(c.messages, 3, "tool steps are not counted");
        assert_eq!(c.updated_at, t(2));

        let doc = db.chat_get(c.id).unwrap();
        let roles: Vec<&str> = doc.messages.iter().map(|m| m.message.role.as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "tool", "assistant"]);
        assert_eq!(doc.messages[1].message.tool_calls, Some(tool_calls));
        assert_eq!(doc.messages[2].message.tool_call_id.as_deref(), Some("call_1"));
        assert_eq!(doc.messages[3].message.cost_usd, 0.0012);
        assert_eq!(doc.messages[3].message.citations.as_ref().unwrap()[0]["page_id"], 3);

        // Regenerating the last answer replaces it.
        assert_eq!(db.chat_truncate(c.id, 3).unwrap(), 1);
        let (_, seqs) = db.chat_append(c.id, &[answer("Neu.", "m2")], None, false, t(3)).unwrap();
        assert_eq!(seqs, [3]);
        assert_eq!(db.chat_get(c.id).unwrap().messages.last().unwrap().message.content, "Neu.");
    }

    #[test]
    fn a_failed_turn_and_a_stopped_answer_are_kept() {
        let db = Database::open_in_memory().unwrap();
        let c = db.chat_create("Frage", false, t(0)).unwrap();
        db.chat_append(
            c.id,
            &[
                NewMessage { in_context: false, ..user("Frage") },
                NewMessage {
                    role: "assistant".into(),
                    error: Some("Server nicht erreichbar".into()),
                    in_context: false,
                    ..Default::default()
                },
                user("Nochmal"),
                NewMessage { cancelled: true, ..answer("Halbe Ant", "m") },
            ],
            None,
            false,
            t(1),
        )
        .unwrap();
        let m = db.chat_get(c.id).unwrap().messages;
        assert!(!m[0].message.in_context && !m[1].message.in_context);
        assert_eq!(m[1].message.error.as_deref(), Some("Server nicht erreichbar"));
        assert!(m[3].message.cancelled && m[3].message.in_context);
    }

    #[test]
    fn rename_pin_archive_and_list_order() {
        let db = Database::open_in_memory().unwrap();
        let a = db.chat_create("Alt", false, t(0)).unwrap();
        let b = db.chat_create("Neu", false, t(10)).unwrap();
        let ids = |q: &str, archived: bool| -> Vec<i64> {
            db.chat_list(q, archived, 100).unwrap().iter().map(|c| c.id).collect()
        };
        assert_eq!(ids("", false), [b.id, a.id], "newest first");
        let a2 = db.chat_update(a.id, &ConversationPatch { pinned: Some(true), ..Default::default() }).unwrap();
        assert!(a2.pinned);
        assert_eq!(a2.updated_at, a.updated_at, "pinning is no activity");
        assert_eq!(ids("", false), [a.id, b.id], "pinned first");
        let r = db
            .chat_update(b.id, &ConversationPatch { title: Some(" Mein   Titel ".into()), ..Default::default() })
            .unwrap();
        assert_eq!((r.title.as_str(), r.title_custom), ("Mein Titel", true));
        let r = db.chat_update(b.id, &ConversationPatch { title: Some("  ".into()), ..Default::default() }).unwrap();
        assert_eq!(r.title, "Mein Titel", "an empty title is ignored");
        db.chat_update(b.id, &ConversationPatch { archived: Some(true), ..Default::default() }).unwrap();
        assert_eq!(ids("", false), [a.id]);
        assert_eq!(ids("", true), [a.id, b.id]);
        let long = db.chat_create(&"x".repeat(200), false, t(20)).unwrap();
        assert_eq!(long.title.chars().count(), TITLE_MAX);
        assert!(long.title.ends_with('…'));
        assert!(db.chat_update(9999, &ConversationPatch::default()).is_err());
    }

    #[test]
    fn delete_with_undo_and_delete_all() {
        let db = Database::open_in_memory().unwrap();
        let a = db.chat_create("Eins", false, t(0)).unwrap();
        let b = db.chat_create("Zwei", true, t(1)).unwrap();
        db.chat_append(a.id, &[user("Text eins")], None, false, t(1)).unwrap();
        db.chat_delete(a.id, t(2)).unwrap();
        assert!(db.chat_get(a.id).is_err());
        assert_eq!(db.chat_list("", true, 10).unwrap().len(), 1);
        assert!(db.chat_list("eins", true, 10).unwrap().is_empty(), "a deleted chat is not found");
        assert_eq!(db.chat_restore(a.id).unwrap().id, a.id);
        assert_eq!(db.chat_get(a.id).unwrap().messages.len(), 1, "undo brings the messages back");

        // A later delete purges what was deleted more than a minute before.
        db.chat_delete(a.id, t(3)).unwrap();
        db.chat_delete(b.id, t(10)).unwrap();
        assert!(db.chat_restore(a.id).is_err(), "gone for good");
        assert_eq!(db.chat_restore(b.id).unwrap().id, b.id);
        let n: i64 = db.conn().query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 0, "messages go with their conversation");

        db.chat_create("Drei", false, t(11)).unwrap();
        db.chat_update(b.id, &ConversationPatch { pinned: Some(true), ..Default::default() }).unwrap();
        assert_eq!(db.chat_delete_all().unwrap(), 2);
        assert!(db.chat_list("", true, 10).unwrap().is_empty());
    }

    #[test]
    fn private_flag_is_sticky_and_copied() {
        let db = Database::open_in_memory().unwrap();
        let c = db.chat_create("Gehalt", false, t(0)).unwrap();
        assert!(!db.chat_is_private(c.id).unwrap());
        let (c, _) = db.chat_append(c.id, &[user("#privat Gehalt")], None, true, t(1)).unwrap();
        assert!(c.private);
        let (c, _) = db.chat_append(c.id, &[user("Und weiter?")], None, false, t(2)).unwrap();
        assert!(c.private, "a later public turn does not clear it");
        let other = db.chat_create("Anderes", false, t(3)).unwrap();
        db.chat_mark_private(other.id).unwrap();
        assert!(db.chat_is_private(other.id).unwrap());
        assert!(!db.chat_is_private(424242).unwrap());
        let copy = db.chat_duplicate(c.id, "Gehalt (Kopie)", t(4)).unwrap();
        assert!(copy.private);
        assert_eq!(db.chat_get(copy.id).unwrap().messages.len(), 2);
        assert_eq!(db.chat_list("", false, 1).unwrap()[0].id, copy.id, "the copy is the newest");
    }

    #[test]
    fn retention_removes_old_unpinned_chats() {
        let db = Database::open_in_memory().unwrap();
        let old = db.chat_create("Alt", false, t(0)).unwrap();
        let pinned = db.chat_create("Angeheftet", false, t(0)).unwrap();
        db.chat_update(pinned.id, &ConversationPatch { pinned: Some(true), ..Default::default() }).unwrap();
        let recent = db.chat_create("Neu", false, t(0) + Duration::days(80)).unwrap();
        let now = t(0) + Duration::days(100);
        assert_eq!(db.chat_prune(ChatRetention::All, now).unwrap(), 0);
        assert_eq!(db.chat_prune(ChatRetention::Off, now).unwrap(), 0, "„nicht speichern“ keeps what is there");
        assert_eq!(db.chat_prune(ChatRetention::Days90, now).unwrap(), 1);
        let left: Vec<i64> = db.chat_list("", true, 10).unwrap().iter().map(|c| c.id).collect();
        assert_eq!(left, [pinned.id, recent.id]);
        assert!(!left.contains(&old.id));
        assert_eq!(db.chat_prune(ChatRetention::Days30, now).unwrap(), 0, "the recent chat is 20 days old");
        assert_eq!(db.chat_prune(ChatRetention::Days30, now + Duration::days(11)).unwrap(), 1);
    }

    #[test]
    fn search_finds_titles_and_messages_with_a_snippet() {
        let db = Database::open_in_memory().unwrap();
        let a = db.chat_create("Budget Netzplan", false, t(0)).unwrap();
        let b = db.chat_create("Release planen", false, t(1)).unwrap();
        db.chat_append(
            b.id,
            &[user("Wann ist der Go-Live?"), answer("Der Go-Live ist am 1. Oktober geplant.", "m")],
            None,
            false,
            t(2),
        )
        .unwrap();
        db.chat_append(
            a.id,
            &[NewMessage { role: "tool".into(), content: "Oktober im Werkzeug".into(), ..Default::default() }],
            None,
            false,
            t(3),
        )
        .unwrap();
        let hits = db.chat_list("oktober", false, 10).unwrap();
        assert_eq!(hits.len(), 1, "tool output is not searched");
        assert_eq!(hits[0].id, b.id);
        let snippet = hits[0].snippet.as_deref().unwrap();
        assert!(snippet.contains("\u{2}Oktober\u{3}"), "{snippet}");
        // Prefix, umlaut-insensitive and title matches.
        assert_eq!(db.chat_list("Okt", false, 10).unwrap().len(), 1);
        let t_hits = db.chat_list("netzplan", false, 10).unwrap();
        assert_eq!((t_hits.len(), t_hits[0].id, t_hits[0].snippet.clone()), (1, a.id, None));
        assert!(db.chat_list("gibtsnicht", false, 10).unwrap().is_empty());
        // Operators are literal.
        assert!(db.chat_list("\"Go-Live\" OR", false, 10).is_ok());
    }
}
