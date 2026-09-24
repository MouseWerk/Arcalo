-- v3: deleting a page moves it (with its subtree) to the trash. `deleted_at`
-- (RFC 3339 with milliseconds) marks trashed pages; pages trashed together share the value.

ALTER TABLE pages ADD COLUMN deleted_at TEXT;
CREATE INDEX idx_pages_deleted ON pages(deleted_at) WHERE deleted_at IS NOT NULL;

-- A trashed daily note must not block a new note for the same day.
DROP INDEX idx_pages_daily;
CREATE UNIQUE INDEX idx_pages_daily ON pages(daily_date) WHERE daily_date IS NOT NULL AND deleted_at IS NULL;
