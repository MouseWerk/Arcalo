-- v14: issue trackers (Jira Cloud and Server/Data Center) read offline.
--
-- `issues` caches what a sync found per site: one row per issue with the fields the Issues
-- page, the widgets, the chips in notes and the assistant show. `matches` (JSON) names the
-- searches that found the issue in the last sync (`mine` = the default search, else the id of a
-- saved JQL query); an issue that no search finds any more keeps its row with `[]` (chips in
-- notes still resolve it) until `seen_at` is 30 days old.
-- `issue_projects` are the projects of the cached issues: only their keys turn `PROJ-123` in a
-- note into a chip. `issue_sync` is the status of the last sync per site.
-- `issue_wbs_map` maps an issue (`kind = issue`) or a whole project (`kind = project`) to a
-- Netzplan/Vorgang reference; `learned` marks a mapping taken from the first booking.
-- `time_entry_issues` links a time entry to the issue key it was booked with, and holds the
-- state of the Jira worklog posted for it (`worklog_id` once posted: never posted twice).

CREATE TABLE IF NOT EXISTS issues (
    site            TEXT    NOT NULL,
    key             TEXT    NOT NULL,
    remote_id       TEXT    NOT NULL DEFAULT '',
    summary         TEXT    NOT NULL DEFAULT '',
    status          TEXT    NOT NULL DEFAULT '',
    status_category TEXT    NOT NULL DEFAULT 'new',   -- new | indeterminate | done
    priority        TEXT    NOT NULL DEFAULT '',
    assignee        TEXT    NOT NULL DEFAULT '',
    reporter        TEXT    NOT NULL DEFAULT '',
    issue_type      TEXT    NOT NULL DEFAULT '',
    project_key     TEXT    NOT NULL DEFAULT '',
    project_name    TEXT    NOT NULL DEFAULT '',
    sprint          TEXT    NOT NULL DEFAULT '',
    sprint_state    TEXT    NOT NULL DEFAULT '',
    due_date        TEXT,
    updated         TEXT,
    resolved        TEXT,
    url             TEXT    NOT NULL DEFAULT '',
    description     TEXT    NOT NULL DEFAULT '',
    comments        TEXT    NOT NULL DEFAULT '[]',    -- JSON: the last comments
    matches         TEXT    NOT NULL DEFAULT '[]',    -- JSON: searches that found it
    seen_at         TEXT    NOT NULL,
    PRIMARY KEY (site, key)
);
CREATE INDEX IF NOT EXISTS idx_issues_key ON issues(key);

CREATE TABLE IF NOT EXISTS issue_projects (
    site TEXT NOT NULL,
    key  TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (site, key)
);

CREATE TABLE IF NOT EXISTS issue_sync (
    site         TEXT PRIMARY KEY,
    synced_at    TEXT,
    attempted_at TEXT,
    error        TEXT,
    issues       INTEGER NOT NULL DEFAULT 0,
    account      TEXT    NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS issue_wbs_map (
    kind       TEXT    NOT NULL,                      -- issue | project
    key        TEXT    NOT NULL,                      -- PROJ-123 or PROJ
    reference  TEXT    NOT NULL,                      -- NP-8801/1020 or NP-8801
    learned    INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL,
    PRIMARY KEY (kind, key)
);

CREATE TABLE IF NOT EXISTS time_entry_issues (
    entry_id      INTEGER PRIMARY KEY REFERENCES time_entries(id) ON DELETE CASCADE,
    issue_key     TEXT    NOT NULL,
    site          TEXT    NOT NULL DEFAULT '',
    worklog_state TEXT    NOT NULL DEFAULT 'none',    -- none | pending | posting | posted | failed
    worklog_id    TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    next_try      TEXT,
    error         TEXT
);
CREATE INDEX IF NOT EXISTS idx_time_entry_issues_key ON time_entry_issues(issue_key);
CREATE INDEX IF NOT EXISTS idx_time_entry_issues_state ON time_entry_issues(worklog_state);
