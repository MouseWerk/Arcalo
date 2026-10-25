-- The issue view: the last copy of an issue opened in full (`issues::view::IssueFull` as JSON), per
-- site and key. Shown read-only with „Stand von …“ while Jira cannot be reached. Removed with its
-- site and when not opened for 90 days.
CREATE TABLE issue_full (
    site TEXT NOT NULL,
    key TEXT NOT NULL,
    data TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (site, key)
);
