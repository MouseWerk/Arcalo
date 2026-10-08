-- arcalo:reindex
-- Tasks, 1.13: the repeat rule of a task (`every:weekly`, `every:mo,we until:2026-12-31`), as
-- written by `Recurrence::tokens`. Derived from the page like the other columns; the marker above
-- re-indexes all pages so existing rules are found.

ALTER TABLE tasks ADD COLUMN recur TEXT;
