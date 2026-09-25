-- v9: calendar sync („Kalender“).
--
-- `calendar_events` holds the appointments of Outlook and the ICS sources, one row per
-- instance of a series. A sync replaces the rows of its source inside its window; the key of
-- an instance is (source, uid, instance), `instance` being the original start of an instance
-- of a series ('' for single appointments). Times are RFC 3339 in UTC.
--
-- `calendar_marks` keeps what the user decided about an appointment under its key
-- (`source|uid|instance`): the booked time entry, the meeting note, „nicht buchen“. It is
-- never touched by a sync. `title` (lower case) and `series` remember subject and series of a
-- booking for the next booking suggestion.
--
-- `calendar_sync` is the status of the last sync per source.

CREATE TABLE calendar_events (
    id          INTEGER PRIMARY KEY,
    source      TEXT    NOT NULL,
    uid         TEXT    NOT NULL,
    instance    TEXT    NOT NULL DEFAULT '',
    recurring   INTEGER NOT NULL DEFAULT 0,
    start_at    TEXT    NOT NULL,
    end_at      TEXT    NOT NULL,
    all_day     INTEGER NOT NULL DEFAULT 0,
    title       TEXT    NOT NULL DEFAULT '',
    location    TEXT    NOT NULL DEFAULT '',
    organizer   TEXT    NOT NULL DEFAULT '',
    attendees   TEXT    NOT NULL DEFAULT '[]',   -- JSON array of names
    body        TEXT,
    link        TEXT,
    busy        TEXT    NOT NULL DEFAULT 'busy', -- free, tentative, busy, oof, elsewhere
    private     INTEGER NOT NULL DEFAULT 0,
    categories  TEXT    NOT NULL DEFAULT '[]',
    UNIQUE (source, uid, instance)
);
CREATE INDEX idx_calendar_events_start ON calendar_events(start_at);
CREATE INDEX idx_calendar_events_source ON calendar_events(source, start_at);

CREATE TABLE calendar_marks (
    key          TEXT    PRIMARY KEY,
    skip         INTEGER NOT NULL DEFAULT 0,
    note_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL,
    entry_id     INTEGER REFERENCES time_entries(id) ON DELETE SET NULL,
    title        TEXT    NOT NULL DEFAULT '',
    series       TEXT    NOT NULL DEFAULT '',
    updated_at   TEXT    NOT NULL
);
CREATE INDEX idx_calendar_marks_series ON calendar_marks(series);
CREATE INDEX idx_calendar_marks_title ON calendar_marks(title);

CREATE TABLE calendar_sync (
    source       TEXT    PRIMARY KEY,
    synced_at    TEXT,
    attempted_at TEXT,
    error        TEXT,
    events       INTEGER NOT NULL DEFAULT 0
);
