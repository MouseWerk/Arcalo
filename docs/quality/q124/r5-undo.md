# q124 round 5, hunt C: undo and every destructive action

Every action that deletes, overwrites or moves user data, checked for an undo or a confirmation that says exactly
what happens, and for an undo that brings back exactly the state before (content, place, links, bookings, the
Jira and Outlook side), also after another action in between, applied twice or to the wrong item. Inventory:
pages (one, a selection, a subtree; from the sidebar and the page), the trash (restore, purge, empty), the file
trash and the attachment manager, versions, „Zusammenführen“ of duplicates, „Aufräumen“ and bulk moves, tasks
(single and bulk: done, due, priority, move, delete), bookings (one, a selection, the phone), the timer
(discard), `/zeit` chips, focus blocks, Outlook appointments, PDF highlights, chats (one, all), canvas cards,
table cells and schema, page properties, the dashboard (boards, widgets), sidebar links and their groups, the
status report templates, the bookmark import, „Beispieldaten entfernen“, projects, Netzplan, Vorgang and
Leistungsarten, calendar sources, Jira sites, comments and worklogs, voice recordings and models, settings
(changes, section reset, „Für alle Tage übernehmen“, the settings sync's undo). Branch `q124-r5c`. The findings of
the earlier rounds (`r3-arrange.md` L5, L7, L8; `r2-data-updates.md` L1; `r3-integrations.md` R3D-L1) were not
hunted again.

Severity as in the [plan](plan.md): data lost without a way back, or an undo that restores something wrong, is
high; a missing undo or confirmation on a common destructive action is medium.

## Findings

### R5C-1 „Beispieldaten entfernen“ deleted the user's own pages that share a sample's title, for good (high)

- Symptom: a workspace started with the samples; the user writes a page of their own named „Besprechung“,
  „Meeting“, „Projekte“, „Willkommen“ or „Wissensbasis“ (common titles) and later removes the samples in
  Settings → Notizen. The page is gone: not in the trash, no undo. The same for every sample page the user had
  written into (their text in „Willkommen“ or „Architektur“). The confirmation said only that the sample pages
  are deleted.
- Root cause: `demo::remove` told sample pages by their title alone and removed them with `delete_page`, which
  bypasses the trash.
- Fix: the seed stores the ids of the sample pages (`meta.demo_pages`); the removal takes only those (samples
  seeded before go by title and the sample's icon) and moves them to the trash with one stamp, so whatever was
  written into them can be restored. Settings text and toast say so.
- Tests: core `remove_keeps_user_pages_with_sample_titles_and_trashes_the_samples` (failed: the user's
  „Besprechung“ and „Projekte“ deleted), `samples_seeded_without_their_ids_are_told_by_title_and_icon`; e2e
  `662-undo-destructive` (first test).

### R5C-2 „Rückgängig“ after deleting a focus block brought it back unbooked and without its focus time (high)

- Symptom: a focus block that „Woche vorschlagen“ had booked („Gebucht“), or that focus sessions were started
  from („Fokussiert 50 min“), deleted in the Kalender and taken back with „Rückgängig“: the block came back without
  „Gebucht“ and without the focus time; the next „Woche vorschlagen“ proposed it for booking again (a second
  booking of the same hour).
- Root cause: the undo created a new block from the fields the view had (title, times, link, reference); the
  link to the booking (`focus_blocks.entry_id`) and the sessions' `block_id` (set to NULL by the delete) were
  lost.
- Fix: `block_delete` returns what the block was (`DeletedBlock`: its fields, the booking, the sessions started
  from it, whether it was in Outlook); the new `block_restore` puts it back with them (a booking deleted or taken
  by another block meanwhile is not linked) and writes its Outlook appointment again.
- Tests: core `timeblocks::tests::a_deleted_block_comes_back_with_its_booking_and_focus_time`; e2e
  `662-undo-destructive` (failed: `entry_id` null after the undo).

### R5C-3 A PDF highlight was deleted with one click, its note with it, without undo (medium)

- Symptom: „Markierung löschen“ in a highlight's popover deleted it at once: no question, no „Rückgängig“; the
  note written to it was lost and the links to it in notes (`[[Datei.pdf#page=3&hl=7|S. 3]]`) found nothing (or,
  once the id was handed out again, another highlight).
- Fix: the delete returns the highlight; a toast offers „Rückgängig“, which puts it back with its note under its
  id while that is free (`restore_pdf_highlight`), so the links find it again.
- Tests: core `pdfmarks::tests::a_deleted_highlight_comes_back_with_its_note_and_id`; e2e `662-undo-destructive`
  (third test).

## Low

- R5C-L1 Ctrl+Z outside the editor and the canvas takes nothing back (a page deleted in the sidebar, a moved
  page, a changed setting): only the toast's „Rückgängig“ does, for its seven seconds (and the trash, „Letztes
  Aufräumen rückgängig machen“, the versions afterwards). Nothing disagrees, there is just no keyboard way.
- R5C-L2 A page restored from the trash after a new daily note for the same day was made meanwhile (deleted by
  mistake, then „Heute“ opened) comes back as a plain page „… 2“; the new, empty note stays the daily note.
- R5C-L3 Status report templates (Meetings → Statusbericht) are deleted with one click, without question or undo;
  the form still holds the template's values, so „Als Vorlage speichern“ makes it again.
- R5C-L4 A sidebar link is removed from its context menu without question or undo (a group with links asks).
- R5C-L5 A downloaded or imported voice model is deleted with one click (it can be downloaded again).
- R5C-L6 A Leistungsart in Settings → Zeiterfassung is deleted with one click, without question or undo.
- R5C-L7 A widget removed from its menu outside the edit mode is gone with its settings, without undo (in the
  edit mode „Abbrechen“ brings it back).
- R5C-L8 A note typed into a highlight's popover and the trash icon clicked right away: the note's save (on blur)
  and the delete race; the save may report „Markierung nicht gespeichert“, and the undo brings the highlight back
  without the last typing.
- R5C-L9 „Rückgängig“ of a new Jira comment deletes it without asking also when it was edited in the seconds
  since.
- R5C-L10 „Rückgängig“ of a bookmark import puts back the sidebar links of before the import, also a link added
  in the seconds since.

## Checked without findings

- Pages: delete of one page with undo (position, parent, tags, links and backlinks, properties, the tab back in
  its pane), a page typed into and deleted at once (the typing is saved and comes back), a subtree (asks, with the
  number of subpages), a selection (asks; one undo for all), restore into a trashed or purged parent (to the top
  level), title clashes on restore (renamed, said in the toast), purge and empty (ask, say „endgültig“; attachments
  stay), versions (restore asks; the current text is kept as a version first, so the restore can be undone).
- „Zusammenführen“ and its undo (also after a restart, also after an edit of the kept page: three-way merge),
  „Aufräumen“ and bulk moves (undo after a restart, pages moved by hand since stay, created folders go only when
  empty).
- Tasks: undo of one and of a selection is all or nothing (refused when a page changed meanwhile), open editors
  reload; bookings moved with their chips come back.
- Bookings: one and a selection ask (naming the Jira worklogs deleted with them); exported ones are refused; the
  phone asks with a second tap; the timer's „Verwerfen“ asks; `/zeit` chips removed: the booking goes only after
  the toast, „Rückgängig“ keeps it.
- Outlook appointments (delete with undo, which restores the item), calendar sources and Jira sites (ask, say what
  stays), projects, Netzplan and Vorgang (ask; projects with bookings are refused).
- Chats: delete with undo (60 s, also with a second delete in between), „Alle Chats löschen“ asks.
- Canvas: card delete and Ctrl+Z (also in two panes), table cells (undo toast per cell), the table schema
  (values stay in the pages).
- Attachments: delete asks (naming the pages that use the file), undo takes the newest file of that name from the
  file trash; the file trash restores and purges (asks).
- Settings: every change with undo, section reset with undo, „Für alle Tage übernehmen“ with undo, the settings
  sync's „Abgleich rückgängig machen“ (round 4).
- Toast „Rückgängig“ cannot run twice (the toast closes on the click); a newer move replaces the older move's undo
  toast (its undo would take back the newer one).

## Tests added

- e2e `662-undo-destructive`: sample removal with a user page titled like a sample, a booked focus block deleted
  and taken back, a PDF highlight with a note deleted and taken back, a page typed into and deleted at once.
- Core: `demo::tests::remove_keeps_user_pages_with_sample_titles_and_trashes_the_samples`,
  `demo::tests::samples_seeded_without_their_ids_are_told_by_title_and_icon`,
  `timeblocks::tests::a_deleted_block_comes_back_with_its_booking_and_focus_time`,
  `pdfmarks::tests::a_deleted_highlight_comes_back_with_its_note_and_id`.
