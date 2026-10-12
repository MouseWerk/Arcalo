-- 1.19: notes taken over by the Git sync of 1.18.0 on Windows were stored with CRLF line ends
-- (the working tree had them; 1.18.1 keeps the stored text there). Every page whose text has a
-- CRLF gets LF line ends, once. Its text before is kept as a version („Versionen“ restores it);
-- pages without CRLF are not touched, so running this again changes nothing. The changed pages
-- are indexed anew (search, tasks, links) when the migrations are through; without a changed
-- page nothing is re-indexed. The page's time of change stays: the text reads the same.

INSERT INTO settings (key, value)
    SELECT 'meta.needs_reindex', '1'
    WHERE EXISTS (SELECT 1 FROM pages WHERE instr(content, char(13, 10)) > 0)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value;

INSERT INTO page_versions (page_id, content, created_at)
    SELECT id, content, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    FROM pages
    WHERE instr(content, char(13, 10)) > 0;

UPDATE pages SET content = replace(content, char(13, 10), char(10))
    WHERE instr(content, char(13, 10)) > 0;
