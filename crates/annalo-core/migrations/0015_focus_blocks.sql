-- v15: time blocking („Fokusblöcke“).
--
-- `focus_blocks` are stretches of time planned in the Kalender, optionally linked to a task
-- (page and ordinal, the task text to find it again when lines move), a Jira issue or a page,
-- and to a Netzplan/Vorgang. Times are RFC 3339 in UTC. `outlook_entry_id` is the EntryID of
-- the appointment written to the default Outlook calendar (Settings → Kalender), `outlook_uid`
-- the id the calendar sync gives that appointment (its global id, else the EntryID): the synced
-- copy is shown as the block, never as a meeting. `entry_id` is the time entry „Woche
-- vorschlagen“ booked from the block (it is not proposed again).
--
-- `focus_block_outbox` holds the Outlook writes still to do, one per block (`upsert` or
-- `delete`; a delete keeps the EntryID because the block row is gone). Outlook is never
-- started for a write: while it is closed the writes wait and are retried.
--
-- `focus_sessions.block_id` names the block a focus session was started from.

CREATE TABLE IF NOT EXISTS focus_blocks (
    id               INTEGER PRIMARY KEY,
    title            TEXT    NOT NULL DEFAULT '',
    start_at         TEXT    NOT NULL,
    end_at           TEXT    NOT NULL,
    link_kind        TEXT    NOT NULL DEFAULT '',   -- '' | task | issue | page
    page_id          INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    task_ordinal     INTEGER,
    task_text        TEXT,
    issue_key        TEXT,
    netzplan_id      INTEGER REFERENCES netzplaene(id) ON DELETE SET NULL,
    vorgang_nr       TEXT,
    outlook_entry_id TEXT,
    outlook_uid      TEXT,
    entry_id         INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    created_at       TEXT    NOT NULL,
    updated_at       TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_focus_blocks_start ON focus_blocks(start_at);
CREATE INDEX IF NOT EXISTS idx_focus_blocks_outlook ON focus_blocks(outlook_uid);

CREATE TABLE IF NOT EXISTS focus_block_outbox (
    block_id   INTEGER PRIMARY KEY,
    op         TEXT    NOT NULL,                    -- upsert | delete
    entry_id   TEXT,
    uid        TEXT,                                   -- delete: the synced copy stays hidden until it is gone
    seq        INTEGER NOT NULL DEFAULT 0,             -- bumped by every change (a write answered late is not lost)
    attempts   INTEGER NOT NULL DEFAULT 0,
    next_try   TEXT,
    error      TEXT
);

ALTER TABLE focus_sessions ADD COLUMN block_id INTEGER REFERENCES focus_blocks(id) ON DELETE SET NULL;
