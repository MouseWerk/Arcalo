-- Jira, 1.19: searches load the list fields only; an issue's description and comments are loaded
-- when it is opened. `detail_at` is when they were loaded; it is cleared when a sync finds the issue
-- changed in Jira (they are shown until the issue is opened again). Rows cached before keep their
-- description and load it anew when opened.

ALTER TABLE issues ADD COLUMN detail_at TEXT;
