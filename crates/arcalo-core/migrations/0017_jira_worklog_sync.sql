-- Jira, 1.8: worklogs follow their time entries, and priority colors in any language.
--
-- `time_entry_issues` rows with a `worklog_id` go back to `pending` when the entry's duration,
-- start or comment changes: the posted worklog is then updated instead of posted again.
-- `jira_worklog_deletes` keeps the worklogs of deleted entries until Jira removed them (the
-- entry row and its link are gone by then).
-- `issues.priority_level` is the priority as a level 1 (lowest) to 5 (highest), 0 unknown,
-- worked out from Jira's priority id, icon or order, so localized and custom names get colors.

CREATE TABLE IF NOT EXISTS jira_worklog_deletes (
    id          INTEGER PRIMARY KEY,
    site        TEXT    NOT NULL,
    issue_key   TEXT    NOT NULL,
    worklog_id  TEXT    NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    next_try    TEXT,
    error       TEXT
);

ALTER TABLE issues ADD COLUMN priority_level INTEGER NOT NULL DEFAULT 0;

-- Issues cached before: their level by the name (the next sync brings id and icon).
UPDATE issues SET priority_level = CASE lower(trim(priority))
    WHEN 'highest' THEN 5 WHEN 'blocker' THEN 5 WHEN 'höchste' THEN 5
    WHEN 'high' THEN 4 WHEN 'critical' THEN 4 WHEN 'hoch' THEN 4 WHEN 'kritisch' THEN 4
    WHEN 'medium' THEN 3 WHEN 'major' THEN 3 WHEN 'mittel' THEN 3 WHEN 'normal' THEN 3
    WHEN 'low' THEN 2 WHEN 'minor' THEN 2 WHEN 'niedrig' THEN 2 WHEN 'gering' THEN 2
    WHEN 'lowest' THEN 1 WHEN 'trivial' THEN 1 WHEN 'niedrigste' THEN 1
    ELSE 0 END;
