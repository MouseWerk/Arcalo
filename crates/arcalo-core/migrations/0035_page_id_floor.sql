-- Page ids are never used twice (1.16): SQLite hands out the highest id + 1, so after the newest
-- page was emptied from the trash its id came back for the next page, which then inherited
-- whatever the window had kept for that id (view modes, open tabs). The highest id ever used is
-- kept here; a new page takes the next one above it.

CREATE TABLE IF NOT EXISTS id_floor (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO id_floor (name, value) SELECT 'pages', COALESCE(MAX(id), 0) FROM pages;
CREATE TRIGGER IF NOT EXISTS pages_id_floor AFTER INSERT ON pages BEGIN
  UPDATE id_floor SET value = MAX(value, NEW.id) WHERE name = 'pages';
END;
