-- v2: a page is one Markdown document (Obsidian-style). notes_blocks becomes a
-- derived chunk index (FTS + embeddings) that is rebuilt whenever a page is saved.

ALTER TABLE pages ADD COLUMN content TEXT NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN daily_date TEXT;           -- YYYY-MM-DD for daily notes
ALTER TABLE pages ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX idx_pages_daily ON pages(daily_date) WHERE daily_date IS NOT NULL;

UPDATE pages SET content = COALESCE((
    SELECT group_concat(content_markdown, char(10) || char(10))
    FROM (SELECT content_markdown FROM notes_blocks b WHERE b.page_id = pages.id ORDER BY b.position, b.id)
), '');

-- Chunks are regenerated from page content by the application after migrating.
DELETE FROM notes_blocks;

-- Outgoing [[wiki links]]; `target` is the lower-cased link title so links to
-- pages that do not exist yet resolve once the page is created.
CREATE TABLE page_links (
    from_page INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    target    TEXT    NOT NULL,
    PRIMARY KEY (from_page, target)
);
CREATE INDEX idx_page_links_target ON page_links(target);

CREATE TABLE page_tags (
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL,
    PRIMARY KEY (page_id, tag)
);
CREATE INDEX idx_page_tags_tag ON page_tags(tag);

-- Page titles are searchable too.
CREATE VIRTUAL TABLE pages_fts USING fts5(
    title,
    content = 'pages',
    content_rowid = 'id',
    tokenize = 'unicode61 remove_diacritics 2'
);
INSERT INTO pages_fts(rowid, title) SELECT id, title FROM pages;
CREATE TRIGGER pages_fts_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;
CREATE TRIGGER pages_fts_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title) VALUES ('delete', old.id, old.title);
END;
CREATE TRIGGER pages_fts_au AFTER UPDATE OF title ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title) VALUES ('delete', old.id, old.title);
    INSERT INTO pages_fts(rowid, title) VALUES (new.id, new.title);
END;

-- Key/value application settings (JSON values). Secrets are not stored here.
CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
