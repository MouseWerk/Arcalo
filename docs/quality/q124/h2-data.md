# q124 H2: data safety

Area: saving, crash and restart, the database and its migrations, Git sync, backups and restore,
encryption, the Markdown mirror, attachments, the trash, imports, the data folder, the command line
next to the running app. Severity scale and exit criterion: `plan.md`.

Findings: 3 high, 1 medium, 6 low. All high and medium ones are fixed at the root with tests.

Tests added: Rust `src-tauri/src/syncmerge.rs` (`titles_the_file_names_cannot_hold_reach_the_other_computer`,
`a_page_deleted_there_with_its_subpages_is_taken_over`, `a_subpage_edited_here_stays_when_its_page_was_deleted_there`,
`a_page_emptied_there_keeps_its_subpages`, `the_first_subpage_of_an_empty_page_reaches_the_other_computer`,
`a_subpage_moved_out_before_its_page_was_deleted_stays`; real git on a
bare repository, two and three computers), `crates/arcalo-core/src/vault.rs`
(`the_mirror_keeps_the_titles_file_names_cannot_hold`), e2e `e2e/tests/462-sync-structure.test.js` (the built app
against a bare repository changed by a second clone).

Probed without a finding: typing in a note the command line trashes or renames meanwhile (the typing lands in
the page, the tab follows), an Obsidian vault with odd names (NFC and NFD „Müller“, `a:b`, `a|b`, `#`, `[x]`,
`CON`, a trailing dot, 120 umlauts, a folder note next to a folder differing in case, an empty note) imported
and exported again, the three-way merge of editor saves, backups of an encrypted database, the data folder
move's file list, the trash and the file trash, migrations with table rebuilds, two computers creating the same
title (a conflict, nothing lost), a note emptied on one computer and edited on the other (the edit wins), and
the existing sync e2e tests (20, 46, 47, 230, 302, 304) on the fixed build.

## H2-1. A page deleted with its subpages on another computer stopped every later take-over. HIGH, FIXED

- Symptom: computer A deletes a page that has a subpage (or empties the text of a page with subpages, which
  removes its file and keeps its folder). On computer B the next Git sync fails to take the server's notes over
  („„Kind“ liegt bereits im Papierkorb“ in the log); the pull stays waiting and every later sync fails the same
  way, so B takes nothing over from the server any more. When B had edited the subpage (the server keeps such an
  edit: „the edit wins“), or when only the parent's text was emptied, B trashed the subpages with their parent,
  and B's next sync deleted them on the server and on every other computer.
- Root cause: `syncmerge::apply` took a deleted note over with `trash_page`, which trashes the whole subtree.
  The subpage's own deletion, later in the same pull, then failed on a page already in the trash (the whole
  take-over is one transaction, so it was rolled back every time); and subpages the server still has (edited here,
  or the parent only lost its text) went to the trash with the parent.
- Fix: a deletion of a page already trashed with its parent in this pull is skipped; a page whose subpages stay
  (`keeps_subpages`: a subpage with a note that this pull neither deletes nor moves away) stays as their folder
  page: its text is kept as a version and the page emptied, as on the server.
- Tests: `a_page_deleted_there_with_its_subpages_is_taken_over` (failed with the error above),
  `a_subpage_edited_here_stays_when_its_page_was_deleted_there` (both orders of syncing; failed: the edited subpage
  ended in the trash on both computers), `a_page_emptied_there_keeps_its_subpages` (failed: `trashed: [Eltern]`
  with both subpages); e2e 462.

## H2-2. The first subpage of an empty page stopped every later take-over, or took the page's place. HIGH, FIXED

- Symptom: a new, empty page („Projekte“) gets its first subpage on computer A. With text in the subpage, the
  next sync on computer B fails („Die übergeordnete Seite liegt im Papierkorb“) and keeps failing, as in H2-1.
  With an empty subpage, B renames its „Projekte“ to „Erstes“ and moves it to the top; B's next sync sends that
  back, and A then trashes its „Projekte“ (a folder page whose subpages all went).
- Root cause: an empty page without subpages is written as an empty `Projekte.md`; with a subpage it is a folder
  only, so the file goes and `Projekte/Erstes.md` comes. B took the deletion over first (trashing the page) and
  then created the subpage below the trashed page (`folder_page` found it by its old file). And
  `gitsync::note_renames` paired the deleted and the added empty file as a rename (identical texts), so the page
  became its own subpage.
- Fix: a page whose file the server deleted stays as a folder when this pull brings a note below it
  (`arriving_below`); `folder_page` never returns a page in the trash; empty notes count as moved only under
  their own file name (a page moved by „Aufräumen“ keeps its id, an empty page is never taken for another one).
- Tests: `the_first_subpage_of_an_empty_page_reaches_the_other_computer` (with and without text in the
  subpage; failed with the error above, and with „Projekte“ renamed); e2e 462.

## H2-3. A subpage moved out of a page that was then deleted went to the trash everywhere. HIGH, FIXED

- Symptom: on computer A a subpage is moved out of its page (into another page) and the old page is deleted
  afterwards („keep this one, delete the rest“). On computer B the moved subpage ends in the trash, and B's next
  sync deletes it on the server and on A.
- Root cause: the pull lists the changes by path; the old page's deletion („Alt.md“) comes before the subpage's
  move („Ziel/Behalten.md“), and trashing the old page took the subpage, still below it here, along. The move then
  moved a page in the trash.
- Fix: before a page from the server's deletions is trashed, the pages below it that this pull moves elsewhere are
  taken out (`release_moving`); their own change then puts them in place. (Taking all moves first instead created a
  second page for a new folder page that the move needs, so the order stays.)
- Test: `a_subpage_moved_out_before_its_page_was_deleted_stays` (failed: „Behalten“ in B's trash).

## H2-4. Titles a file name cannot hold changed on every other computer, and links to them broke. MEDIUM, FIXED

- Symptom: a page „Q3: Ziele“ (also „Was tun?“, „A/B-Test“, „Version 2.“, a title longer than 120 characters,
  a folder page „Ablage: 2026“) is „Q3- Ziele“ on every other computer that syncs through Git. Links `[[Q3: Ziele]]`
  find nothing there; following one creates a second, empty page that the sync carries back as „Q3- Ziele (2)“.
- Root cause: the Markdown mirror names files with `vault::file_name` (characters Windows forbids become `-`,
  trailing dots and spaces go, long titles are cut). The other computer creates the page from the file name
  (`syncmerge::apply`, `stem`) and has no other source for the title.
- Fix: the mirror writes `.arcalo-titles.json` (path → title) for every file or folder whose name does not hold
  its page's title (`vault::titles_file`), only when a page needs it. A pulled page, a folder page and a moved or
  renamed page take the title from it (when the file name still fits the title). After every sync,
  `syncmerge::take_over_titles` gives the listed title to a page that carries another one at that path: pages
  taken over before the file existed, and renames that keep the file name („Q3: Ziele“ → „Q3? Ziele“).
  `vault::pulled_titles` uses only entries this computer's mirror does not name the same way, so a rename made
  here while the sync ran stays. The working tree keeps the file when the mirror has none (a computer without such
  titles), and a file changed on both sides is merged path by path (`vault::merge_titles`).
- Tests: `titles_the_file_names_cannot_hold_reach_the_other_computer` (a new computer, a computer that took the
  pages over before, a rename that keeps the file name, new titled pages on two computers at once, then four
  syncs that change and commit nothing), `the_mirror_keeps_the_titles_file_names_cannot_hold`; e2e 462 (a title
  from the other computer arrives, the link resolves, the tree shows it).

## Low (listed, not fixed)

- L1. A rename that changes only the case of a title („notiz“ → „Notiz“) does not reach the other computers: the
  sync compares file names without case (`names_title`), as it must for Windows and macOS.
- L2. A folder page renamed on one computer while the other adds a subpage below it: after two rounds both
  computers have the renamed folder and a folder of the old name with the new subpage. Nothing is lost.
- L3. A move on one computer against a rename or a delete of the same page on the other: the rename wins and the
  move is dropped, or the page goes to the trash on both (the delete covered the old place). The text is never
  lost; the page is in the trash for 30 days.
- L4. The app starting after an update and a command run at the same instant can both start the same migration
  (`Database::migrate` reads the version outside its deferred transaction); the second can fail once (busy, or the
  step already applied). Found by reading, not reproduced.
- L5. Titles file: renaming the only titled page to exactly its file name's form („Q3: Ziele“ → „Q3- Ziele“)
  leaves the old entry in the working tree, and the next sync gives the old title back.
- L6. An Obsidian import keeps two notes of one name in different folders as two pages of the same title; links
  to that name go to the first.
