-- v10: „Woche vorschlagen“ remembers the WBS the user chose for a proposal.
--
-- When the user changes the WBS of a proposed booking and takes it over, the choice is kept
-- per page (`kind = 'page'`, `key` = page id, `page_id` set so the row goes with the page) and
-- per text (`kind = 'text'`, `key` = the proposal's text in lower case, e.g. a focus goal).
-- Appointments keep theirs in `calendar_marks` (series and subject of the linked booking).
-- `link_ref` is the page's own `vorgang:` property at that time: once the page is linked to
-- another Vorgang, the property wins again.

CREATE TABLE wbs_memory (
    kind         TEXT    NOT NULL CHECK (kind IN ('page', 'text')),
    key          TEXT    NOT NULL,
    page_id      INTEGER REFERENCES pages(id) ON DELETE CASCADE,
    netzplan_id  INTEGER NOT NULL REFERENCES netzplaene(id) ON DELETE CASCADE,
    vorgang_nr   TEXT,
    leistungsart TEXT,
    link_ref     TEXT    NOT NULL DEFAULT '',
    updated_at   TEXT    NOT NULL,
    PRIMARY KEY (kind, key)
);
