-- Link and tag suggestions, duplicate hints and PDF highlights (1.10).
-- arcalo:reindex (aliases and the duplicate index are derived from every page's content)

-- `aliases:` of a page's frontmatter (lower-cased), so unlinked mentions find a page by them.
CREATE TABLE IF NOT EXISTS page_aliases (
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    alias   TEXT    NOT NULL,
    PRIMARY KEY (page_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_page_aliases_alias ON page_aliases(alias);

-- Terms the user does not want suggested as a link on a page („Ignorieren“), lower-cased.
CREATE TABLE IF NOT EXISTS mention_ignores (
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    term    TEXT    NOT NULL,
    PRIMARY KEY (page_id, term)
);

-- Tag suggestions dismissed on a page.
CREATE TABLE IF NOT EXISTS tag_dismissals (
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    tag     TEXT    NOT NULL,
    PRIMARY KEY (page_id, tag)
);

-- Duplicate index: a MinHash signature of the word 3-grams of each note (updated on save) and
-- its LSH bands, so the candidates of one page are an indexed lookup, not a scan of all pages.
CREATE TABLE IF NOT EXISTS page_minhash (
    page_id  INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
    sig      BLOB    NOT NULL,
    shingles INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS page_minhash_bands (
    band    INTEGER NOT NULL,
    page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY (band, page_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_minhash_bands_page ON page_minhash_bands(page_id);

-- Pairs the user marked as no duplicates (`a < b`).
CREATE TABLE IF NOT EXISTS duplicate_ignores (
    a INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    b INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
    PRIMARY KEY (a, b)
);

-- Highlights in PDF attachments, by the attachment's file name. `rects` is a JSON list of
-- [x, y, w, h] in fractions of the page (independent of the zoom).
CREATE TABLE IF NOT EXISTS pdf_highlights (
    id         INTEGER PRIMARY KEY,
    attachment TEXT    NOT NULL,
    page       INTEGER NOT NULL,
    rects      TEXT    NOT NULL,
    text       TEXT    NOT NULL,
    color      TEXT    NOT NULL,
    note       TEXT    NOT NULL DEFAULT '',
    created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pdf_highlights_attachment ON pdf_highlights(attachment, page);
