-- 1.19: the order of the children of every folder a bulk move changed, as it was before the
-- move (page ids, comma-separated). „Rückgängig“ puts the pages back in exactly that order, also
-- after a reorder of several pages within one folder.
CREATE TABLE IF NOT EXISTS move_undo_order (
    seq       INTEGER PRIMARY KEY,
    parent_id INTEGER,
    ids       TEXT NOT NULL DEFAULT ''
);
