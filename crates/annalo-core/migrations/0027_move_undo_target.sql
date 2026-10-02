-- Where a bulk move put each page (1.10): „Rückgängig“ moves back only the pages that are still
-- there, not the ones moved by hand since.
ALTER TABLE move_undo ADD COLUMN new_parent INTEGER;
ALTER TABLE move_undo ADD COLUMN placed INTEGER NOT NULL DEFAULT 0;  -- 1: new_parent is recorded
