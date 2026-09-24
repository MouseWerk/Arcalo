-- Annalo schema v1. Applied inside a single transaction by db::migrate.

CREATE TABLE projects (
    id           INTEGER PRIMARY KEY,
    project_code TEXT    NOT NULL UNIQUE,          -- Level 1: Projekt-ID, e.g. PRJ-2026-X
    name         TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE netzplaene (
    id            INTEGER PRIMARY KEY,
    project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    netzplan_nr   TEXT    NOT NULL UNIQUE,         -- Level 2: Netzplan, e.g. NP-8801
    wbs_element   TEXT    NOT NULL,                -- PSP-Element, e.g. NP-8801-1020
    description   TEXT    NOT NULL DEFAULT '',
    planned_hours REAL    NOT NULL DEFAULT 0 CHECK (planned_hours >= 0)
);
CREATE INDEX idx_netzplaene_project ON netzplaene(project_id);

-- Level 3: Vorgänge (activities) of a Netzplan, including the precedence
-- relations needed for the critical path calculation.
CREATE TABLE vorgaenge (
    id             INTEGER PRIMARY KEY,
    netzplan_id    INTEGER NOT NULL REFERENCES netzplaene(id) ON DELETE CASCADE,
    vorgang_nr     TEXT    NOT NULL,               -- e.g. 1020 or ACT-001
    description    TEXT    NOT NULL DEFAULT '',
    duration_days  REAL    NOT NULL DEFAULT 0 CHECK (duration_days >= 0),
    planned_hours  REAL    NOT NULL DEFAULT 0 CHECK (planned_hours >= 0),
    remaining_hours REAL,                          -- manual ETC override; NULL = derive
    UNIQUE (netzplan_id, vorgang_nr)
);

CREATE TABLE vorgang_links (
    predecessor_id INTEGER NOT NULL REFERENCES vorgaenge(id) ON DELETE CASCADE,
    successor_id   INTEGER NOT NULL REFERENCES vorgaenge(id) ON DELETE CASCADE,
    PRIMARY KEY (predecessor_id, successor_id),
    CHECK (predecessor_id <> successor_id)
);

-- Level 4: Leistungsarten (activity types).
CREATE TABLE leistungsarten (
    code        TEXT PRIMARY KEY,                  -- e.g. DEV, CONSULTING
    description TEXT NOT NULL DEFAULT ''
);
INSERT INTO leistungsarten (code, description) VALUES
    ('DEV', 'Entwicklung'),
    ('CONSULTING', 'Beratung'),
    ('PM', 'Projektmanagement'),
    ('TEST', 'Test & Qualitätssicherung');

CREATE TABLE time_entries (
    id               INTEGER PRIMARY KEY,
    netzplan_id      INTEGER NOT NULL REFERENCES netzplaene(id) ON DELETE RESTRICT,
    vorgang_nr       TEXT,
    leistungsart     TEXT    REFERENCES leistungsarten(code),
    start_time       TEXT    NOT NULL,             -- RFC 3339, UTC
    end_time         TEXT,                         -- NULL while a timer is running
    duration_minutes INTEGER CHECK (duration_minutes IS NULL OR duration_minutes >= 0),
    description      TEXT    NOT NULL DEFAULT '',
    status_flag      TEXT    NOT NULL DEFAULT 'draft'
                     CHECK (status_flag IN ('running', 'draft', 'released', 'exported')),
    source           TEXT    NOT NULL DEFAULT 'manual'
                     CHECK (source IN ('manual', 'timer', 'slash', 'auto'))
);
CREATE INDEX idx_time_entries_netzplan ON time_entries(netzplan_id, vorgang_nr);
CREATE INDEX idx_time_entries_start ON time_entries(start_time);
-- At most one running timer at a time.
CREATE UNIQUE INDEX idx_time_entries_single_running
    ON time_entries(status_flag) WHERE status_flag = 'running';

CREATE TABLE pages (
    id         INTEGER PRIMARY KEY,
    parent_id  INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    title      TEXT    NOT NULL,
    icon       TEXT,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_pages_parent ON pages(parent_id, position);

CREATE TABLE notes_blocks (
    id               INTEGER PRIMARY KEY,
    page_id          INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    position         INTEGER NOT NULL DEFAULT 0,
    block_type       TEXT    NOT NULL DEFAULT 'paragraph',
    content_markdown TEXT    NOT NULL DEFAULT '',
    vector_embedding BLOB                          -- little-endian f32[]; NULL = not indexed yet
);
CREATE INDEX idx_notes_blocks_page ON notes_blocks(page_id, position);

-- Full-text search over blocks (external content table kept in sync by triggers).
CREATE VIRTUAL TABLE notes_blocks_fts USING fts5(
    content_markdown,
    content = 'notes_blocks',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_blocks_ai AFTER INSERT ON notes_blocks BEGIN
    INSERT INTO notes_blocks_fts(rowid, content_markdown) VALUES (new.id, new.content_markdown);
END;
CREATE TRIGGER notes_blocks_ad AFTER DELETE ON notes_blocks BEGIN
    INSERT INTO notes_blocks_fts(notes_blocks_fts, rowid, content_markdown)
    VALUES ('delete', old.id, old.content_markdown);
END;
CREATE TRIGGER notes_blocks_au AFTER UPDATE OF content_markdown ON notes_blocks BEGIN
    INSERT INTO notes_blocks_fts(notes_blocks_fts, rowid, content_markdown)
    VALUES ('delete', old.id, old.content_markdown);
    INSERT INTO notes_blocks_fts(rowid, content_markdown) VALUES (new.id, new.content_markdown);
END;
-- Stale embeddings must be recomputed after the text changes.
CREATE TRIGGER notes_blocks_invalidate_embedding AFTER UPDATE OF content_markdown ON notes_blocks
WHEN old.content_markdown <> new.content_markdown BEGIN
    UPDATE notes_blocks SET vector_embedding = NULL WHERE id = new.id;
END;

-- Full-text search over time log descriptions.
CREATE VIRTUAL TABLE time_entries_fts USING fts5(
    description,
    content = 'time_entries',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
CREATE TRIGGER time_entries_ai AFTER INSERT ON time_entries BEGIN
    INSERT INTO time_entries_fts(rowid, description) VALUES (new.id, new.description);
END;
CREATE TRIGGER time_entries_ad AFTER DELETE ON time_entries BEGIN
    INSERT INTO time_entries_fts(time_entries_fts, rowid, description)
    VALUES ('delete', old.id, old.description);
END;
CREATE TRIGGER time_entries_au AFTER UPDATE OF description ON time_entries BEGIN
    INSERT INTO time_entries_fts(time_entries_fts, rowid, description)
    VALUES ('delete', old.id, old.description);
    INSERT INTO time_entries_fts(rowid, description) VALUES (new.id, new.description);
END;

-- AI usage ledger for the token/cost counters.
CREATE TABLE ai_usage (
    id                INTEGER PRIMARY KEY,
    session_id        TEXT    NOT NULL,
    model             TEXT    NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_usd          REAL    NOT NULL,
    ttft_ms           REAL,
    tokens_per_second REAL,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX idx_ai_usage_session ON ai_usage(session_id);
