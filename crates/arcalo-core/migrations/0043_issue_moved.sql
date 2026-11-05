-- Jira, 1.17: issues moved to another project (PROJ-1 became NEW-5).
--
-- Notes, tasks and bookings keep the key they were written with. A sync that finds a cached
-- issue under a new key records the old one here; the old key then shows the issue under its
-- new key (chips, hover card, issue view), and its tasks are ticked when the issue is done.

CREATE TABLE IF NOT EXISTS issue_moved (
    site    TEXT NOT NULL,
    old_key TEXT NOT NULL,
    new_key TEXT NOT NULL,
    PRIMARY KEY (site, old_key)
);
CREATE INDEX IF NOT EXISTS idx_issue_moved_new ON issue_moved(new_key);
