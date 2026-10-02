-- Folders & filing (1.9): where the pages the app creates go, folder sort and colors, and the
-- undo of the last bulk move (tidy-up, „Verschieben nach …“).
--
-- `file_type` marks a page the app filed (journal, meeting, voice, jira, mail, bookmarks,
-- inbox) with the date (`file_date`, YYYY-MM-DD) and the group (`file_group`: a meeting
-- series or a Jira project folder) its folder follows. `system_folder` marks a folder the
-- filing created or adopted (the type, or `rule` for a folder of a rule) and `system_key` its
-- place in the scheme (`root`, `y2026`, `m2026-10`, `w2026-40`, `g:<group>`), so a folder is
-- found again after a language switch. Existing pages are never moved here.

ALTER TABLE pages ADD COLUMN file_type TEXT;
ALTER TABLE pages ADD COLUMN file_date TEXT;
ALTER TABLE pages ADD COLUMN file_group TEXT;
ALTER TABLE pages ADD COLUMN system_folder TEXT;
ALTER TABLE pages ADD COLUMN system_key TEXT;

UPDATE pages SET file_type = 'journal', file_date = daily_date WHERE daily_date IS NOT NULL;
UPDATE pages SET file_type = 'meeting', file_date = substr(created_at, 1, 10)
 WHERE file_type IS NULL AND id IN (SELECT note_page_id FROM calendar_marks WHERE note_page_id IS NOT NULL);

-- Sort and color of a folder's children; page_id 0 is the top level.
CREATE TABLE IF NOT EXISTS folder_prefs (
    page_id       INTEGER PRIMARY KEY,
    sort          TEXT    NOT NULL DEFAULT 'manual',   -- manual | name | modified | created
    folders_first INTEGER NOT NULL DEFAULT 0,
    color         TEXT                                 -- accent | info | success | warning | danger | violet | muted
);
CREATE TRIGGER IF NOT EXISTS folder_prefs_purge AFTER DELETE ON pages BEGIN
    DELETE FROM folder_prefs WHERE page_id = OLD.id;
END;

-- The last bulk move, for „Rückgängig“: where each page was, and the folders it created.
CREATE TABLE IF NOT EXISTS move_undo (
    seq          INTEGER PRIMARY KEY,
    page_id      INTEGER NOT NULL,
    old_parent   INTEGER,
    old_position INTEGER NOT NULL DEFAULT 0,
    created      INTEGER NOT NULL DEFAULT 0,           -- 1: a folder this move created
    label        TEXT    NOT NULL DEFAULT ''           -- tidy | move
);
