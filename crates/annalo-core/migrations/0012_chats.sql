-- v12: the assistant's chat history.
--
-- One row per conversation and one per message, in the order they were sent (`seq`). A
-- message keeps what the model got (`role`, `content`, `tool_calls`, `tool_call_id`) and what
-- the panel showed (`display` for a user message with a short label, `tool` for a tool card,
-- `citations`, the route and the usage). `in_context = 0` marks messages of a failed turn: they
-- are shown again but never sent. A conversation that touched private content (a privacy
-- marker, Datenschutz „Nur lokal“) is `private`: it stays on the local model when continued.
-- `deleted_at` marks a conversation deleted in the last seconds (undo); it is purged on start.

CREATE TABLE IF NOT EXISTS chat_conversations (
    id            INTEGER PRIMARY KEY,
    title         TEXT    NOT NULL DEFAULT '',
    title_custom  INTEGER NOT NULL DEFAULT 0,       -- renamed by the user
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL,
    pinned        INTEGER NOT NULL DEFAULT 0,
    archived      INTEGER NOT NULL DEFAULT 0,
    private       INTEGER NOT NULL DEFAULT 0,
    provider      TEXT    NOT NULL DEFAULT '',      -- of the last answer
    model         TEXT    NOT NULL DEFAULT '',
    tier          TEXT    NOT NULL DEFAULT '',
    page_ids      TEXT    NOT NULL DEFAULT '[]',    -- JSON: pages sent as context
    deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    seq             INTEGER NOT NULL,
    role            TEXT    NOT NULL,               -- user, assistant, tool
    content         TEXT    NOT NULL DEFAULT '',
    display         TEXT,
    tool_calls      TEXT,                           -- JSON
    tool_call_id    TEXT,
    tool            TEXT,                           -- JSON: name, label, status, summary, output
    citations       TEXT,                           -- JSON: the retrieved sources, [n] = n-th
    provider        TEXT    NOT NULL DEFAULT '',
    model           TEXT    NOT NULL DEFAULT '',
    tier            TEXT    NOT NULL DEFAULT '',
    reasons         TEXT,                           -- JSON: the router's reasons
    meta            TEXT,                           -- JSON: model label, ttft, tokens/s, exact
    tokens          INTEGER NOT NULL DEFAULT 0,
    cost_usd        REAL    NOT NULL DEFAULT 0,
    error           TEXT,
    cancelled       INTEGER NOT NULL DEFAULT 0,
    in_context      INTEGER NOT NULL DEFAULT 1,
    page_title      TEXT,                           -- „In neue Seite einfügen“ (weekly report)
    created_at      TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_messages_seq ON chat_messages(conversation_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(
    content,
    content = 'chat_messages',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE OF content ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(chat_messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    INSERT INTO chat_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
