-- v8: indexes for frequent lookups; no data changes.
--
-- Page titles case-insensitively (`[[links]]`, `page_by_title`, unresolved links on every save),
-- activity rows by kind and title (task and file events) and by time entry (feed backfill).

CREATE INDEX idx_pages_title ON pages(title COLLATE NOCASE);
CREATE INDEX idx_activity_kind_title ON activity(kind, title);
CREATE INDEX idx_activity_entry ON activity(entry_id);
