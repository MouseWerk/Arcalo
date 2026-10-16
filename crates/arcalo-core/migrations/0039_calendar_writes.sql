-- Appointments created, changed, moved and deleted in the Kalender and written to Outlook (1.21).
--
-- `calendar_events` keeps what Arcalo needs to write an Outlook appointment back: its EntryID
-- (`entry_id`), Outlook's `LastModificationTime` (`modified`, RFC 3339 UTC), its MeetingStatus
-- (`meeting`: 0 appointment, 1 organized by the user, 3 received) and whether it has attendees
-- besides the organizer (`has_attendees`). Rows of ICS sources leave them empty.
--
-- `calendar_outbox` holds the Outlook writes still to do, one waiting row per appointment:
-- `create` (a new appointment, found again by its `marker`, stamped on it as the user property
-- `ArcaloEntry`, so a write whose answer got lost adds no second one), `update` (a patch of the
-- changed `fields` only, with the values Arcalo last saw of them in `seen`: Outlook compares them
-- before saving, a field changed there too is a conflict) and `delete` (to Outlook's Deleted
-- Items; `deleted_id` is the item there, so „Rückgängig“ can move it back with a `restore`).
-- `seq` is bumped by every change (a write answered late is not lost), `send` says the user
-- confirmed sending the update of an organized meeting to its attendees. `state` is `pending`,
-- `conflict` (`conflict` holds Outlook's values) or `done` (a delete kept a day for its undo;
-- `snapshot` is the appointment as it was shown). Outlook is never started for a write.

ALTER TABLE calendar_events ADD COLUMN entry_id TEXT;
ALTER TABLE calendar_events ADD COLUMN modified TEXT;
ALTER TABLE calendar_events ADD COLUMN meeting INTEGER NOT NULL DEFAULT 0;
ALTER TABLE calendar_events ADD COLUMN has_attendees INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS calendar_outbox (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    marker      TEXT    NOT NULL,                   -- arcalo-entry-<hex>
    source      TEXT    NOT NULL,                   -- outlook | outlook:<hash>
    op          TEXT    NOT NULL,                   -- create | update | delete | restore
    uid         TEXT,                               -- the appointment's uid (none for a create)
    entry_id    TEXT,
    fields      TEXT    NOT NULL DEFAULT '{}',      -- changed fields: title, start, end, location
    seen        TEXT    NOT NULL DEFAULT '{}',      -- the values Arcalo last saw of them
    send        INTEGER NOT NULL DEFAULT 0,
    seq         INTEGER NOT NULL DEFAULT 1,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try    TEXT,
    state       TEXT    NOT NULL DEFAULT 'pending', -- pending | conflict | done
    error       TEXT,
    conflict    TEXT,
    deleted_id  TEXT,
    snapshot    TEXT,
    created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_calendar_outbox_uid ON calendar_outbox(source, uid);
CREATE INDEX IF NOT EXISTS idx_calendar_outbox_marker ON calendar_outbox(marker);
