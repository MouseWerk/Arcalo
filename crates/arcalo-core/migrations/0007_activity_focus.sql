-- v7: the activity feed („Aktivität“) and focus sessions („Fokus“).
--
-- `activity` is a journal of what happened in the workspace. Edits of one page are merged per
-- hour (`count` edits, `amount` characters changed); `feed.rs` writes it. Older history is
-- derived once from pages, versions, time entries and attachments (`feed.since` marks where the
-- journal starts, so the backfill never duplicates what was written here).

CREATE TABLE activity (
    id          INTEGER PRIMARY KEY,
    at          TEXT    NOT NULL,              -- RFC 3339, UTC
    kind        TEXT    NOT NULL,              -- see feed::Kind
    page_id     INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    entry_id    INTEGER,                       -- time entry (kept when the entry is deleted)
    netzplan_id INTEGER REFERENCES netzplaene(id) ON DELETE SET NULL,
    vorgang_nr  TEXT,
    title       TEXT    NOT NULL DEFAULT '',   -- page title, task text, file name, description
    detail      TEXT    NOT NULL DEFAULT '',
    amount      INTEGER NOT NULL DEFAULT 0,    -- characters changed, minutes or a count
    count       INTEGER NOT NULL DEFAULT 1,    -- merged events (edits within the hour)
    people      TEXT    NOT NULL DEFAULT ''    -- @mentions and owner, lower-cased, space-separated
);
CREATE INDEX idx_activity_at ON activity(at);
CREATE INDEX idx_activity_page ON activity(page_id, kind, at);

-- A focus session (Pomodoro). One runs at a time; a finished one books its minutes on the
-- Vorgang (a draft time entry, `entry_id`), a break follows until `break_until`.
CREATE TABLE focus_sessions (
    id              INTEGER PRIMARY KEY,
    netzplan_id     INTEGER REFERENCES netzplaene(id) ON DELETE SET NULL,
    vorgang_nr      TEXT,
    reference       TEXT    NOT NULL DEFAULT '',   -- as shown: NP-8801/1020
    goal            TEXT    NOT NULL DEFAULT '',
    started_at      TEXT    NOT NULL,
    planned_minutes REAL    NOT NULL CHECK (planned_minutes > 0),
    break_minutes   INTEGER NOT NULL DEFAULT 5,
    ended_at        TEXT,
    status          TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'aborted')),
    worked_minutes  INTEGER NOT NULL DEFAULT 0,
    booked_minutes  INTEGER NOT NULL DEFAULT 0,
    entry_id        INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    break_until     TEXT
);
CREATE UNIQUE INDEX idx_focus_single_running ON focus_sessions(status) WHERE status = 'running';
CREATE INDEX idx_focus_started ON focus_sessions(started_at);

INSERT INTO settings (key, value) VALUES ('meta.feed.since', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(key) DO NOTHING;
