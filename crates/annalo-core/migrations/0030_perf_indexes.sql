-- Indexes for large workspaces (1.11); no data changes.
--
-- Page metadata without the content: the tree, the task list, the duplicate and graph lists
-- read the pages from this narrow copy instead of the rows that carry the Markdown. It starts
-- with the id, so a join on `deleted_at` never takes it as the driving index. Open tasks by due
-- date with their page: the counts of the suggestions, the calendar and the start page come
-- from the index alone (it also serves the old `(done, due)` lookups).

CREATE INDEX IF NOT EXISTS idx_pages_meta ON pages(
    id, deleted_at, parent_id, title, icon, position, updated_at, favorite, daily_date, kind, created_at, system_folder
);
CREATE INDEX IF NOT EXISTS idx_tasks_open ON tasks(done, due, page_id);
DROP INDEX IF EXISTS idx_tasks_done_due;
