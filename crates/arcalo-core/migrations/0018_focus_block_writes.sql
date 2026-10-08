-- Outlook writes of focus blocks with ids that are never reused.
--
-- The rowid of a deleted block can come back for the next block, so the queue no longer goes
-- by `block_id`: every block gets a random `marker` (stamped on its Outlook appointment, so a
-- write that was answered late or not at all finds the appointment again instead of adding a
-- second one), and the queue rows get their own AUTOINCREMENT id. A `delete` is a row of its
-- own that no later change merges into; it keeps the EntryID (and the marker) of the
-- appointment although the block is gone.

ALTER TABLE focus_blocks ADD COLUMN marker TEXT;
UPDATE focus_blocks SET marker = 'arcalo-' || lower(hex(randomblob(16))) WHERE marker IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_blocks_marker ON focus_blocks(marker);

CREATE TABLE focus_block_outbox_new (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    marker     TEXT    NOT NULL,                    -- focus_blocks.marker (the block may be gone)
    op         TEXT    NOT NULL,                    -- upsert | delete
    entry_id   TEXT,
    uid        TEXT,                                -- delete: the synced copy stays hidden until it is gone
    seq        INTEGER NOT NULL DEFAULT 1,          -- bumped by every change (a write answered late is not lost)
    attempts   INTEGER NOT NULL DEFAULT 0,
    next_try   TEXT,
    error      TEXT
);

-- A pending delete never takes the marker of a block that got its id later.
INSERT INTO focus_block_outbox_new (marker, op, entry_id, uid, seq, attempts, next_try, error)
SELECT CASE WHEN o.op = 'upsert' AND b.marker IS NOT NULL THEN b.marker
            ELSE 'arcalo-' || lower(hex(randomblob(16))) END,
       o.op, o.entry_id, o.uid, MAX(o.seq, 1), o.attempts, o.next_try, o.error
  FROM focus_block_outbox o LEFT JOIN focus_blocks b ON b.id = o.block_id
 ORDER BY o.block_id;

DROP TABLE focus_block_outbox;
ALTER TABLE focus_block_outbox_new RENAME TO focus_block_outbox;
CREATE INDEX IF NOT EXISTS idx_focus_block_outbox_marker ON focus_block_outbox(marker, op);
