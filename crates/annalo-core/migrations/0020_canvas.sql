-- Canvas pages (1.9): `kind` is NULL for a note (Markdown) and 'canvas' for an infinite board
-- whose content is a JSON Canvas document (jsoncanvas.org), stored exactly as written.

ALTER TABLE pages ADD COLUMN kind TEXT;
