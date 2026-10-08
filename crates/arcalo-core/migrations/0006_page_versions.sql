-- v6: earlier states of a page („Versionen“). A snapshot holds the content a page had
-- before a save; `versions.rs` decides when one is taken and prunes old ones.

CREATE TABLE page_versions (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX idx_page_versions_page ON page_versions(page_id, created_at);
