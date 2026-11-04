# q124 round 4, hunt B: two computers, every feature

Round 4 of the [plan](plan.md), hunt B. Branch `q124-r4b`. Rounds 1 to 3 found sync bugs feature by feature
(subpages, titles, daily notes, meeting notes, time sheets; [h2-data.md](h2-data.md),
[r2-data-updates.md](r2-data-updates.md), [r3-scenarios.md](r3-scenarios.md)). This hunt went through every kind of
data with two (and three) computers sharing one workspace through Git sync: what the code and the README intend to
travel, what each computer keeps for itself, and what happens when both computers change the same thing before they
sync. Method: Rust tests with real git on a bare repository (`src-tauri/src/syncmerge.rs`, as the earlier rounds),
and the built app on two data folders against one bare repository (e2e `603-two-computers-features`).

Severity as in the plan. Findings: 1 high, 3 medium, 8 low; the high and medium ones are fixed at the root with
tests.

## Findings

### R4B-1 A drawing renamed on one computer while the other drew on it lost the strokes (high, fixed)

- Symptom: the office computer renames „Skizze.excalidraw“ to „Plan.excalidraw“ in the attachment manager (the
  notes that embed it are rewritten); the laptop, not synced yet, draws on the same drawing. After the syncs both
  computers show the old drawing in the note, the server has only „Plan.excalidraw“ with the old strokes, and the
  laptop's strokes are left as „Skizze.excalidraw“ on the laptop alone, linked by no note („Unbenutzte aufräumen“
  offers to delete it). The same for any attachment changed on one computer and renamed on the other. A note the
  laptop wrote meanwhile that embeds the old name kept embedding it: the file came back on the server under the old
  name, beside the renamed one.
- Root cause: the merge (`gitsync::merge_remote`) sees the rename as a deletion of the old name and a new file. A
  deletion there of a file changed here keeps this side's file under the old name; the notes now embed the new name,
  so the next mirror no longer carries the old file and the sync took it off the server. Notes of this computer were
  only relinked for files kept twice (`keep_both_files`), never for a rename.
- Fix: `gitsync::follow_file_renames` finds the server's renames (the old name gone, a new one with the old content)
  of files this computer still has. A file changed here goes to the new name with this computer's content (a
  drawing with its preview); this computer's notes that link the old name follow (`relink_notes`, without putting
  the names on the kept list), and the shell renames the file here (`FileRename`, `apply_file_renames`).
- Test: `syncmerge::tests::a_drawing_edited_here_follows_its_rename_there` (a drawing changed here, a picture
  embedded by a new note here; failed: the note showed the old drawing on both computers, the laptop's strokes gone
  from the server); e2e `603-two-computers-features`.

### R4B-2 Links to a page the other computer renamed pointed nowhere (medium, fixed)

- Symptom: the office renames „Konzept“ to „Konzept 2026“ (its links follow); the laptop, not synced yet, writes
  `[[Konzept]]` in a new page or in a page that becomes a conflict. After the syncs the link is unresolved on both
  computers; following it creates a new, empty „Konzept“, which the next sync carries to the office.
- Root cause: a rename taken over from the server (`syncmerge::apply`: a moved note, a renamed folder, a title from
  the titles file) renamed the page with `rename_page`, which rewrites no links. The pages that came with the
  server's text have the other computer's links already, but the pages written here since do not.
- Fix: after the take-over, links to the old title are rewritten in every page that did not come with the server's
  text (`Database::relink`, shared with `rename_page_linked`; the text before is a version), unless a page of the old
  title still exists. A conflict's own text follows too. The next sync uploads the rewritten pages.
- Test: `syncmerge::tests::links_written_here_follow_a_rename_there` (a link with alias and heading, one in code that
  stays, a conflict; failed: the new page kept `[[Konzept]]` on both computers); e2e `603-two-computers-features`.

### R4B-3 A computer with another daily note format made a second daily note of the day (medium, fixed)

- Symptom: the office titles its daily notes „04.11.2026“ (Einstellungen → Notizen), the laptop „2026-11-04“ (the
  default), or both use „Mittwoch, 04.11.2026“ in different languages. The laptop takes the office's note over, but
  „Heute“ (and everything that writes into today's note: quick capture, mail tasks, focus) creates a second note of
  the same day beside it, which the next sync carries back to the office. R3A-2 fixed this only for computers with
  the same format.
- Root cause: `daily_title_date` and `daily_note_found` recognised a daily note by this computer's format and the
  ISO date only.
- Fix: every format of either language counts (`DailyTitle::every_title`: ISO, `04.11.2026`, the long one in German
  and English, the weekday checked against the date).
- Tests: `notes::tests::a_daily_note_of_a_computer_with_another_title_format_is_the_daily_note_here`,
  `syncmerge::tests::a_daily_note_in_another_title_format_is_the_daily_note_here` (failed: a second note
  „2026-11-04“); e2e `603-two-computers-features`.

### R4B-4 Neighbouring lines changed on two computers were a conflict that undid one change (medium, fixed)

- Symptom: the office ticks „Bericht“ in a task list, the laptop ticks „Anruf“ on the next line (or edits the
  paragraph right below a task the office ticked). The conflict view showed one undecided block with both lines:
  „Meine“ or „Andere“ undid the other computer's tick, „Beide“ doubled the list. The README promises that changes
  made on one side only are merged by themselves.
- Root cause: `merge::merge3` anchors on base blocks unchanged on both sides; neighbouring blocks changed on
  different sides form one region without an anchor, and a region changed on both sides was one conflict.
- Fix: such a region is merged block by block when neither side added or removed a block there and each block was
  changed on one side only (or identically); otherwise it stays one conflict. The editor's three-way merge of its
  saves uses the same function and gains the same.
- Tests: `merge::tests::neighbouring_blocks_changed_on_different_sides_merge` (failed: one conflict); e2e
  `603-two-computers-features` (the view needs no decision, „Übernehmen“ gives both ticks on both computers).

### Low (listed, not fixed)

- R4B-L1: a page restored from the trash on one computer arrives on the other as a new page; the other computer's
  copy (trashed when it took the deletion over) stays in its trash with its versions and the link of its bookings.
  Restoring that one as well gives „Notiz 2“.
- R4B-L2: an attachment renamed and changed on one computer while the other changed it too: the second computer's
  version stays under the old name, used by no note (only a pure rename is followed, R4B-1).
- R4B-L3: an attachment deleted on one computer (moved to the file trash) while the other changed it: the first
  computer's next merge takes it off the server again; it returns with the second computer's next sync. Nothing is
  lost; two extra commits.
- R4B-L4: settings sync („Einstellungen synchronisieren“) decides by each computer's clock: of two changes of the
  same setting within the clocks' difference, the one of the computer whose clock runs ahead wins; a clock far ahead
  wins until a change made later than its time.
- R4B-L5: each computer keeps favorites, page icons, the order of pages in a folder (pages of another computer come
  last, so a board's card order differs), folder colors, PDF highlights, the assistant's chats, page versions, the
  trash and its decisions about appointments. Intended (the repository carries the Markdown copy), but the README
  did not say so; it does now. A quote of a PDF highlight (`hl=` in its link) opens the page without the highlight
  on the other computer.
- R4B-L6: a note changed on both computers is always a conflict, also when its block merge needs no decision
  (R4B-4 and other one-sided changes): the user opens the view and applies.
- R4B-L7: „Datenbank mitsichern“ on two computers: each writes its own database copy over the other's
  `arcalo-workspace.db`; the repository holds the last syncing computer's database only.
- R4B-L8: today's daily note created on both computers before either synced is a conflict, also when one side holds
  only the untouched template.

## Probed without a finding

- Tasks: the same task ticked on both computers (the same text, no conflict), a repeating task ticked on both on the
  same day (the same next occurrence), a task ticked on one and the note edited elsewhere on the other (block merge).
- Board and table pages: the schema, the view settings and the values are front matter and travel with the text; a
  value changed on one computer and the body on the other merge by block. Canvas: travels as `.canvas`, a conflict
  is decided whole (existing tests); note cards follow renames like links (R4B-2 uses the same rewrite).
- Templates (pages below „Vorlagen“/„Templates“), smart folders (computed from the pages), tags (in the text), Jira
  issue notes (found by their `jira:` property, not by a local link), meeting notes and prep pages (R3A-3).
- Filing: the year and month folders of the other computer are adopted by title (both languages), no second
  „2026“ or „11 – November“.
- Bookings and the timer stay per computer by design; the time sheets as in R3A-4 and R3A-L1.
- Encryption on one computer only (read, not run): the mirror and the repository hold plain Markdown either way; the
  key never reaches the sync.
- Different versions: an older computer drops files it does not know (the titles file, the kept list), as accepted
  in rounds 1 and 2; the newer one puts them back. The new rename handling needs nothing from the other computer.
- Three computers: a rename on one and links written on the other two (each relinks its own pages when it takes
  the rename over).

## Tests added

- Rust: `syncmerge::tests` (`a_drawing_edited_here_follows_its_rename_there`,
  `links_written_here_follow_a_rename_there`, `a_daily_note_in_another_title_format_is_the_daily_note_here`),
  `notes::tests::a_daily_note_of_a_computer_with_another_title_format_is_the_daily_note_here`,
  `merge::tests::neighbouring_blocks_changed_on_different_sides_merge`.
- e2e: `603-two-computers-features.test.js` (office and laptop through a bare repository: daily note formats, a
  rename against a new link, a drawing renamed against new strokes, neighbouring ticks).
