# Arcalo 1.13, B1: tasks (repeating tasks, bulk actions)

Severity: H = wrong data, M = wrong behavior with workaround, L = polish. Shots in the session scratchpad
`q113-shots/tasks/` (light 1280x800, dark, split pane).

| # | Sev | Finding | Root cause | Fix | Test |
|---|-----|---------|------------|-----|------|
| 1 | M | No repeating tasks: a weekly chore had to be copied by hand | not built | rule in the task line (`every:…`, `until:…`), parsed in `recurrence.rs`, stored in `tasks.recur` (migration 0033, re-index); ticking off adds the next occurrence below the task's subtasks (`taskedit.rs`, editor `recurTasks.ts`) | Rust `recurrence::tests`, `taskedit::tests`; vitest `recurTasks.test.ts`, `tasks.test.ts`; e2e 290 |
| 2 | M | Aufgaben could change one task at a time only (done) | not built | selection mode, bulk bar, task menu (right-click, „…“, ContextMenu/Shift+F10), one undo per action (`tasks_edit` / `tasks_undo`) | Rust `bulk_edit_and_undo`; e2e 291 |
| 3 | M | „Rückgängig“ after ticking off in Aufgaben unticked by ordinal only; with a repeating task it would have left the new occurrence behind | undo was a second `task_set_done(false)` | undo restores the touched pages from the change (only while nobody changed them since; otherwise an error toast, nothing restored) | e2e 290 |
| 4 | L | Moving tasks between notes lost the link of `/zeit` bookings until the target note was opened | bookings follow chips only through the editor's link check | the move updates `time_entries.page_id` of booked chips in the moved lines (and undo moves them back) | Rust `bulk_edit_and_undo` |
| 5 | L | Task rows had no keyboard path to actions other than the checkbox | — | arrows move between rows, Shift+arrow extends the selection, Ctrl+A, Delete, Escape, ContextMenu/Shift+F10 opens the task menu; the count is announced in a live region („3 Aufgaben ausgewählt“) | e2e 291 |
| 6 | L | Move dialog listed every page whatever was typed (first draft) | fuzzy score −1 plus the title bonus was positive | the bonus applies only to a match (as in „Verschieben nach …“) | e2e 291 |
| 7 | L | Pages created since the tree was read were missing as move targets | dialog read the cached tree | the dialog refreshes the tree when it opens | e2e 291 |

## Design decisions
- Syntax: `every:<rule>` as one word (written by the app: `daily`, `weekly`, `mo,we`, `2w,fr`, `monthly`, `monthly,31`, `3d`, `3m`, `yearly`, `,done`), optional `until:YYYY-MM-DD` (also `bis:`); `wdh:` is read as `every:`. Words after `every:` are read when the value alone is no rule (`every:jede Woche`, `every:alle 3 Tage`, `every:jeden Montag und Mittwoch`): the fewest words that make a rule, extended while each further word changes it; two-letter words (`so`, `do`) never extend it. Anything not understood stays text. No emoji are written; the Obsidian Tasks repeat marker (its emoji followed by `every week on Monday when done`) is read and kept as the user wrote it when a line is copied.
- Next date: from the due date by default (Obsidian Tasks' default); dates already past are skipped, so an overdue task gives one new task after today. `,done` (dialog „Ab Erledigung“) or a task without due date counts from the day it is ticked off. Monthly clamps to the last day of short months; the dialog writes the day (`monthly,31`) for a due date on the 29th to 31st so later months do not drift. Holidays are not considered (documented in the dialog).
- New occurrence: the same line (indent, marker, text, tags, priority, rule) right after the task's subtasks, open, with the next due date (added when there was none); without `/zeit` chips (the booking stays with the done task), block id and Obsidian done date. Subtasks are not copied. `until` reached: the task is done, nothing new.
- Editor: the tick is detected in `appendTransaction` (single `setNodeMarkup`/attr step on a task item, not undo/redo, reloads or other panes); the date comes from the core (`task_next_due`), the inserted item is marked as appended to the tick so one Ctrl+Z removes both. The Markdown source view is plain text: typing `[x]` there adds nothing.
- Bulk: refs are page/ordinal/text, found again by text when the page changed; tasks not found are skipped and reported in the toast. Move appends the tasks (unindented, with subtasks) at the end of the target page, right after a list there or after a blank line. Delete removes the subtasks too; their bookings stay in Zeiterfassung. Undo compares each page with the content the change left.
- The start page widgets and note queries tick off through `task_set_done`, which now also adds the next occurrence (no undo there, as before).

## Left open
- Windows contrast themes (forced colors) were not rendered here (WebKitGTK has no emulation); the new controls use native checkboxes, buttons and tokens only.
- Incoming links to a block id (`[[Seite#^id]]`) of a moved task still point to the old page.
