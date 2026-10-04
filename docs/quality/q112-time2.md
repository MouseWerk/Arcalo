# Arcalo 1.12, A2b: time tracking follow-ups (findings / design)

Severity: H = wrong data, M = wrong behavior with workaround, L = polish.

| # | Sev | Finding | Root cause | Fix | Test |
|---|-----|---------|------------|-----|------|
| 1 | H | Deleting a /zeit chip keeps its booking (time booked that the note no longer shows) | chip and entry not linked after booking | chip removal deletes the booking after an undo toast (deferred, cut/paste and editor undo keep it) | e2e 220, vitest |
| 2 | H | Editing/deleting a booking (timesheet, Kalender, dialog) leaves the chip with stale hours/WBS | no link back from entry to note | backend rewrites the chip in the page (values, `state="deleted"`), open editors reload | Rust chips tests, e2e 220 |
| 3 | M | Copied chip looks booked but is not (or shares one booking) | duplicates of one entry id | second occurrence / chip of another page shows "Kopie - nicht gebucht" with "Buchen" | vitest, e2e |
| 4 | M | Timer has no pause | - | pause/resume (timer widgets, tray, shortcut), pauses not booked | Rust, e2e |
| 5 | H | Timer over midnight books everything on its start day | single entry | split into one booking per local day, after pauses and idle/sleep | Rust |
| 6 | M | CATS copy/file always use decimal comma | hard-coded | setting Komma / Punkt / Wie Zahlenformat | Rust + vitest |
| 7 | M | Copy/paste of a chip inside the editor gave an empty chip (no hours, reference, text) | renderHTML wrote only `id`, attrs parsed from HTML were empty | attributes travel as data-* | vitest |
| 8 | L | Chip content redrawn on hover swallowed clicks | mouseenter re-render | hover updates only the title | e2e 220 |

## Design decisions
- Chip Markdown: `<time-entry id hours target la date state>` (fixed attribute order, written the same by backend `chips::render` and editor `chipMarkdown`; old chips stay byte for byte until their booking changes). `state="deleted"` marks a booking deleted elsewhere.
- Backend rewrites the first non-deleted chip of an entry on its page when the entry is edited (`update_time_entry`) or deleted (`delete_time_entry`), emits `data://pages`; open editors merge it like any external change. Works for the Markdown mirror and Git sync (the DB content is what is exported) and encrypted workspaces (plain DB writes).
- Link: a chip is the booking's chip if it is the first (non-deleted) chip with that id on the entry's page. Copies (second occurrence, or a chip of an entry linked to another note that still has it) show "Kopie, nicht gebucht". A chip cut from one note and pasted into another takes its entry along (only if the reference matches, so ids from another device's note never claim an unrelated entry).
- Removing a booked chip: undo toast (7 s, urgent so focus sessions show it); booking deleted when it closes unless the chip is back in any open editor (editor undo, paste). After deletion, the chip coming back (Ctrl+Z) restores the booking with the same id. Exported/released bookings are never deleted this way (info toast).
- Timer pauses: table `timer_pauses` (migration 0031). Stop splits the run per local day (`timer::split_run`, DST safe), subtracting pauses and, when chosen, the idle stretches (IdleAccumulator now keeps intervals; pause/resume closes an idle stretch and suspends sleep detection). Each day's booking is rounded on its own.
- CATS decimal: `time.cats_decimal` = comma | point | number (default comma, missing field = comma: no settings migration).

## Left open
- Chip removal in source mode (Markdown source editor) does not delete the booking (the chip just goes; booking stays).
- A booking restored after the toast closed loses its Jira worklog link (the worklog deletion was already queued).
- Before screenshots of the old chip were not retaken (old chip = green pill with hours, reference, text only).
