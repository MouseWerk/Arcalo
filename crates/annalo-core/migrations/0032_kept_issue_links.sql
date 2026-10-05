-- Jira, 1.13: a deleted booking keeps its issue link for a while.
--
-- When the booking comes back (its chip back by undo after the toast closed, „Erneut buchen“ on
-- a chip marked deleted), it takes the link back: a queued deletion of its worklog is cancelled,
-- and a worklog Jira already removed is posted once more under its new id. So a booking never
-- ends up with two worklogs, an orphaned one, or none. Rows older than 30 days are dropped.

CREATE TABLE IF NOT EXISTS time_entry_issues_deleted (
    entry_id      INTEGER PRIMARY KEY,
    issue_key     TEXT    NOT NULL,
    site          TEXT    NOT NULL DEFAULT '',
    worklog_state TEXT    NOT NULL DEFAULT 'none',
    worklog_id    TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    netzplan_id   INTEGER NOT NULL,
    vorgang_nr    TEXT,
    deleted_at    TEXT    NOT NULL
);
