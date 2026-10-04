-- Pauses of the running timer (1.12): „Timer pausieren“ adds a row, „Fortsetzen“ closes it
-- (end_time NULL while paused). The paused time is not booked; the rows go with the entry
-- when the timer is stopped or discarded.
CREATE TABLE timer_pauses (
    id         INTEGER PRIMARY KEY,
    entry_id   INTEGER NOT NULL REFERENCES time_entries(id) ON DELETE CASCADE,
    start_time TEXT    NOT NULL,             -- RFC 3339, UTC
    end_time   TEXT                          -- NULL while paused
);
CREATE INDEX idx_timer_pauses_entry ON timer_pauses(entry_id);
