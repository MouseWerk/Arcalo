-- annalo:reindex
-- v4: task items (`- [ ] …`) of every page, derived from pages.content on save
-- like page_links/page_tags. The marker above makes the app re-index all pages.

CREATE TABLE tasks (
    page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    ordinal  INTEGER NOT NULL,              -- 0-based among the page's task items
    line     INTEGER NOT NULL,              -- 0-based line in the Markdown
    text     TEXT    NOT NULL,              -- without checkbox, due date and priority
    done     INTEGER NOT NULL DEFAULT 0,
    due      TEXT,                          -- YYYY-MM-DD
    priority INTEGER NOT NULL DEFAULT 0,    -- 0 none, 1 mittel (!), 2 hoch (!!)
    tags     TEXT    NOT NULL DEFAULT '',   -- own + page-level #tags, lower-cased, space-separated
    PRIMARY KEY (page_id, ordinal)
);
CREATE INDEX idx_tasks_done_due ON tasks(done, due);
