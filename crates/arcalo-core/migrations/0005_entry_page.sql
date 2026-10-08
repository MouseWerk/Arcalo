-- v5: the page a time entry was booked from (`/zeit` in a note). Kept when the page is
-- purged from the trash, only the link is cleared.

ALTER TABLE time_entries ADD COLUMN page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL;
CREATE INDEX idx_time_entries_page ON time_entries(page_id);
