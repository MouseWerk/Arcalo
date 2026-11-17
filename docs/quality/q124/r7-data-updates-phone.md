# q124 round 7, hunt B: data safety, updates, the command line, the phone and its sync

Areas H2, H6 and H7 of the [plan](plan.md), round 7. Branch `q124-r7b`. H2 was not hunted in round 6, so this round
gave it most of the time: backups and their restore (old, partial, from a destination two computers share), the start-up
recovery, the encryption switched on, off and rekeyed with a populated database and a crash or a refused rename at each
step, the Markdown mirror and its way back (the README's import), the Git sync with conflicting edits, renames during an
open conflict and the user's own git configuration, the vault import as data. The earlier rounds of these areas
([h2-data.md](h2-data.md), [r2-data-updates.md](r2-data-updates.md), [r2-work-phone.md](r2-work-phone.md),
[r4-phone.md](r4-phone.md), [r4-two-computers.md](r4-two-computers.md), [r4-settings.md](r4-settings.md),
[r4-failure-paths.md](r4-failure-paths.md), [r5-long-running.md](r5-long-running.md),
[r6-updates-phone-cli.md](r6-updates-phone-cli.md)) were not hunted again; round 6's fixes (the phone's booking ids, the
command line's export and its checks) were checked for their neighbours, and two of the findings below are such
neighbours (R7B-3, R7B-9).

Severity as in the plan. Findings: 4 high, 8 medium, 16 low; the high and medium ones are fixed at the root with tests.

## Findings

### R7B-1 The start-up recovery could put another computer's workspace in place (high, fixed)

- Symptom: two computers (or two colleagues) back up to the same share, each into its own folder. When this computer's
  database could not be opened and the user chose „Letzte Sicherung wiederherstellen“ (or the restore on the key
  screen), the newest backup of any computer was put in place: the user got the other computer's notes and bookings
  instead of their own, and the dialog did not say whose backup it was.
- Root cause: `backupdest::recovery_sources` and `gather` listed every computer's folder of a destination
  (`list_remote`), and `restore_newest` took the newest of all.
- Fix: the recovery lists the local backups and only this computer's folder of each destination
  (`recovery_sources_for(data_dir, host)`, `host_folder(hostname())`).
- Tests: `the_start_up_recovery_restores_this_computers_backup_not_another_computers` (`tests/r7b_backup_mirror.rs`;
  failed: the other computer's backup was put in place); `restoring_verifies_the_checksum_and_copies_locally_first`
  now adds a newer backup of another computer and checks that it is left alone.

### R7B-2 Work done after a refused encryption switch was lost at the next start (high, fixed)

- Symptom: encryption switched on or off, or the key changed, then a restart. The export was written and verified, but
  the first rename of the swap was refused (on Windows a virus scanner or the indexer holding the file). The app said the
  database was not switched and is unchanged, opened it, and the user worked on. The next start resumed the swap with
  the export of the earlier start: everything done in between was left only in `workspace.db.cipher-old`, which the
  start after that deleted. A backup restored in between was undone the same way.
- Root cause: `cipher::run_pending_keys` returned the rename's error with `?` and left the marker at `Verified` with the
  export beside the database; a later start trusted that export.
- Fix: a refused rename before the database moved undoes the step (the export removed, the marker back at
  `Requested`; a refused WAL rename first puts the database back), and a `Verified` marker found at a later start with the
  database still in place exports again. The swap only ever uses an export of the same run.
- Test: `work_done_after_a_failed_encryption_swap_is_kept_at_the_next_start` (failed: the work done after the failed
  switch was gone, left only in `workspace.db.cipher-old`); the crash and key-change tests at every step still pass.

### R7B-3 A chip booked on the other computer was taken for a booking of this one (high, fixed)

- Symptom: round 6 (R6B-1) gave the phone's bookings ids of their own, but two desktops both count from 1. When the
  laptop's chip reached the office's daily note through the Git sync and its id was the id of an office booking of that
  note, the office took it for its own booking: the editor wrote the office booking's hours, reference and text over the
  laptop's chip, removing that chip deleted the office's booking, and with the laptop's chip first in the note the
  office's own chip showed as a copy with „Buchen“, which booked it a second time. Likely in the first weeks of using two
  computers.
- Root cause: chip ids are row ids of each workspace's own database; `Database::chip_states` and the editor could tell a
  chip of another device only by an id they do not know.
- Fix: chips name the workspace that booked them (`ws`, a random identity made once per workspace,
  `Database::chip_workspace`, written by the editor, the phone and „Erneut buchen“). A chip of another workspace is a
  booking from another device whatever its id: never linked, never a copy, never deletes a booking. Chips written
  before 1.23 have no `ws` and count as before (L15). An id floor for desktops as for the phone was not taken: the
  command line shows and takes booking ids (`arcalo time edit 12`).
- Tests: `a_chip_booked_on_another_desktop_never_names_a_booking_here` (`tests/r7b_sync.rs`; failed: the laptop's
  chip was the office's booking 1); `sourceChips.test.ts`; e2e `720-chips-two-desktops.test.js` (failed before the fix:
  the laptop's chip showed the office's booking, the office's own chip „Kopie, nicht gebucht“).

### R7B-4 A note next to a folder of its files was left out of the vault import (high, fixed)

- Symptom: `Reise.md` next to a folder `Reise/` holding only its images (Notion's export layout, often imported through
  Obsidian): after the import the page „Reise“ was missing, without a warning or a count of skipped files; its images
  were copied, but nothing showed them.
- Root cause: `vault::Walk::dir` took every folder's name as a folder note's, also folders of files only, which never
  become pages (`files_only`), so the note's text went nowhere.
- Fix: only folders that become pages take their note.
- Test: `a_note_next_to_a_folder_of_its_files_is_imported` (`tests/r7b_migrate_import.rs`; failed: the note was
  missing).

### R7B-5 A restored backup left the images its pages embed missing (medium, fixed)

- Symptom: a backup restored in Settings → Sicherung: an image a page of the backup embedded and that was later removed
  from the page (so it went to the file trash) showed as a broken image. The file was in the file trash and in the
  backup folder's `attachments`, but nothing brought it back, and the same start's trash purge could delete it.
- Root cause: `apply_pending_restore` and `restore_newest` swap the database file only; `bring_back_missing` ran only
  for a restored page version.
- Fix: both restores leave `restore-files.pending`; the start that opens the restored database, before the file trash
  is emptied, brings back the files the live pages embed (`backupdest::bring_back_files`: from the file trash, else from
  the backup folder's `attachments`, a drawing with its preview).
- Tests: `a_restored_backup_brings_back_the_files_its_pages_embed` (failed: the file stayed in the file trash),
  `a_restored_backup_takes_a_purged_file_from_the_backup_folders_attachments`.

### R7B-6 The Markdown copy imported back (the README's way) dropped or renamed pages (medium, fixed)

- Symptom: the mirror's README says to import the folder as an Obsidian vault to get the notes back. A page whose title
  starts with a dot („.NET Migration“) was dropped silently, titles a file name cannot hold came back changed („Q3: Ziele“
  as „Q3- Ziele“), and the links to them found nothing. The copies of the mirror on the backup destinations lacked those
  pages and the titles file.
- Root cause: the mirror wrote a dot-titled page as a hidden file, which the import, Obsidian and the destination copy
  skip; the import never read `.arcalo-titles.json`; the destination copy skipped every name with a leading dot.
- Fix: a leading dot is written as `_.NET Migration.md` (the titles file keeps the title, which also keeps a page titled
  „.git“ with subpages in the Git sync); the import gives pages the titles of `.arcalo-titles.json`; the destination copy
  carries the titles file.
- Tests: `a_markdown_copy_imported_as_a_vault_brings_back_every_page_under_its_title` (failed: „Q3: Ziele“ and
  „.NET Migration“ not back under their titles); `attachments_are_copied_incrementally_and_the_markdown_tree_mirrored`
  checks the titles file on the destination.

### R7B-7 A bare embed in an imported note showed the image of the folder above (medium, fixed)

- Symptom: with `Projekt/bild.png` and `Projekt/Unter/bild.png`, the note `Projekt/Unter/Notiz.md` (`![[bild.png]]`)
  showed the image of `Projekt/` after the import.
- Root cause: the second file was stored as `bild 2.png` for the notes of `Projekt`, and the rename was applied to every
  note below that folder, also those whose own folder has a `bild.png`.
- Fix: a bare name means the file of that name nearest to the note (`Names::bare_means`: no deeper folder on the note's
  path has one).
- Test: `a_bare_embed_keeps_the_file_of_its_own_folder_when_a_folder_above_has_one_of_that_name` (failed: „oben“).

### R7B-8 Obsidian links written with a path named no page after the import (medium, fixed)

- Symptom: Obsidian writes `[[Projekte/Plan]]` when two notes share a name, and for every link with the link format
  „Absolute path in vault“ or „Relative path to file“. After the import such a link named no page, and a click created a
  new empty page „Projekte/Plan“.
- Root cause: links resolve by title; the import rewrote file references but not note links.
- Fix: links whose path names an imported note (from the vault's root or the note's folder, with or without `.md`,
  keeping alias and heading) are rewritten to that page's title.
- Test: `links_with_a_vault_path_name_the_imported_page` (failed: `["Projekte/Plan"]` unresolved).

### R7B-9 `arcalo export --mark` marked bookings as exported before the export was written (medium, fixed)

- Symptom: a weekly script (round 6's R6B-2) whose output could not be written (a full disk, a closed pipe) ended with
  an error, but its bookings were already marked as exported: the next `--mark` left them out, so they never reached
  SAP or Jira.
- Root cause: `time::export` of the command line committed the marks before `print!` wrote the output (which panicked
  on the failed write); the app writes the file first.
- Fix: the output is written and flushed first (a failed write is an error, exit 4, „nothing marked as exported“), then
  the marks are committed, and only for entries still as they were written (an entry changed in the app meanwhile stays
  unmarked, is named, and goes into the next export).
- Test: `an_export_that_could_not_be_written_marks_nothing` (`crates/arcalo-cli/tests/cli.rs`, output to
  `/dev/full`; failed: the booking was marked).

### R7B-10 A page renamed while its conflict was open became two pages on the other computer (medium, fixed)

- Symptom: a conflict on „Notiz“ waiting on computer A, the page renamed (or moved by „Aufräumen“) before deciding.
  After A's sync, B kept „Notiz“ and got a second page „Notiz neu“ with A's undecided text; once A decided, B's page went
  to the trash with its versions and booking links.
- Root cause: `syncmerge::hold_paths` held the path recorded with the conflict at the server's version while the mirror
  wrote the page under its new name, so both were committed.
- Fix: the conflicted page is held at its current mirror path (`vault::page_paths`), with the server's text of the
  recorded path (`gitsync::Held`); the rename goes up as a rename and the undecided text stays here.
- Test: `syncmerge::tests::a_page_renamed_while_its_conflict_is_open_stays_one_page_on_the_other_computer` (failed:
  B had two pages).

### R7B-11 Different properties changed on two computers were a conflict of the whole front matter (medium, fixed)

- Symptom: the status changed on one computer (a card moved on a board) and the effort on the other: a conflict on the
  whole front matter. „Meine“ or „Andere“ lost one change, „Beide“ put a second front matter into the note's text.
- Root cause: `merge::blocks` made the front matter one block, and the merge works on whole blocks.
- Fix: `merge3` merges the front matter entry by entry (a key with its list or indented lines); only the same key
  changed differently is a conflict, of that entry alone, inside the front matter.
- Tests: `different_properties_changed_on_two_computers_merge` (`tests/r7b_sync.rs`; failed: one conflict on the
  whole front matter), `merge::tests::front_matter_merges_key_by_key`.

### R7B-12 Files the user's global git ignore names were never synced (medium, fixed)

- Symptom: with a global ignore file in the user's own git configuration (`core.excludesFile`, or git's default
  `~/.config/git/ignore`) holding common patterns like `*.log` or `build/`, an attached `server.log` or a page folder
  „Build“ with its subpages was never committed and never reached the other computers, without an error.
- Root cause: `git add -A` honours the user's excludes; `Git::command` overrides other user settings (`autocrlf`, hooks,
  signing) but not this one.
- Fix: every git command runs with `core.excludesFile` empty and the sync's adds use `--force` (libgit2:
  `IndexAddOption::FORCE`), so no ignore rule keeps a file of the mirror off.
- Test: `files_the_users_global_git_ignore_names_are_synced_too` (`tests/r7b_sync.rs`; failed:
  `attachments/server.log` not on the server).

### Low (listed, not fixed in this round)

- R7B-L1: a restore that fails at its last rename (`apply_pending_restore`, the backup into place after the database
  was moved aside) opens an empty workspace with a message that suggests the old state stayed; the next start retries
  and nothing is lost.
- R7B-L2: a backup stamped in the future (a clock that ran ahead) counts as the newest until the time catches up; the
  start-up recovery would take it.
- R7B-L3: the mirror chooses file and folder names apart: when only `X.md` is taken (two titles cut to the same 120
  characters, titles differing only in case), a page with subpages gets `X (2).md` beside the folder `X/`.
- R7B-L4: the mirror's time sheets round the hours per row (three 20-minute bookings make 0,99 h); with the English
  number format they use a decimal point under the German header with `;`.
- R7B-L5: a task ticked on one computer while a new task is added right below it on the other (or a repeating task's
  next occurrence) is a conflict: `merge::in_place` merges only regions of equal length.
- R7B-L6: `hold_paths` reads every recorded conflict, also of a page trashed meanwhile, until the UI prunes the list;
  the deletion's upload waits for that.
- R7B-L7: `vault::merge_titles` is a union: an entry removed on one side comes back when the other side changed the
  file too (it matters only if a later page takes that file name).
- R7B-L8: `arcalo export --jira-map` refuses a map file with a byte order mark (Windows PowerShell 5's
  `Set-Content -Encoding UTF8`).
- R7B-L9: `arcalo timer start NP-1 #DEV Fix #42 crash` (unquoted) drops `#42` from the text.
- R7B-L10: a vault imported into a workspace with a page of the same title, or imported twice: its `[[links]]` open the
  oldest page of that title.
- R7B-L11: on a case-insensitive file system, `Projekte/` next to `projekte.md` imports the note twice (as the folder
  page's text and as a page).
- R7B-L12: the bookmark import's overflow page escapes only `[`, `]` and `\` in link texts; `*`, `_` and `#word` in a
  title show formatted or as a tag.
- R7B-L13: a page titled „node_modules“ is in the Markdown copy but skipped by the import, as in a vault.
- R7B-L14: `arcalo export --json --mark` reports the number of entries to be marked; an entry changed during the export
  is named on stderr and not marked, so the real number can be lower.
- R7B-L15: chips written before 1.23, and a chip typed in the first moment after the start before the editor knows the
  workspace's identity, have no `ws`; such a chip of another computer can still be taken for a booking here (R7B-3 holds
  for every chip written after that).
- R7B-L16 (fixed, found by e2e 681 on CI): on a busy machine a dropdown stayed open when the person scrolled right
  after a scroll the page made (content above the trigger changing height). The list's new placement for the page's
  scroll rendered after the person's scroll and recorded where that left the trigger, so the person's scroll, reported
  after it, looked like one that did not move the trigger. A wheel or touch move after the list opened now always
  closes it; the rule for scrolls that did not move the trigger is kept for those made before it opened (R5D-4).

## Looked at, no finding

- Database migrations from populated 1.18-1.22 states: the releases' notes (schema 0041, settings version 19); 0042 and
  0043 add a column and a table only; each migration runs in one transaction with the `user_version` bump and the
  reindex flag; a newer schema is refused before anything is written. Settings step 19 → 20 (`target_history`) is
  idempotent, and an older version saving over newer settings keeps the version and the unknown key.
- Backups: the partial file and its rename, pruning of both prefixes and of the tagged pre-update backups, `restore_from`
  and its undo, the return to the previous version (database first, undone when the reinstall fails), `fetch_verified`
  (checksum, quick check, schema), a backup of an older schema (migrated at open, the id floor rebuilt by 0035), a vault
  import's marker inside a backup.
- Encryption: a crash at every step of switching on, off and rekeying, the fate of the next key, a plain backup restored
  over an encrypted database (encrypted again), a stale empty WAL after a crash between the renames.
- Mirror: the swap at every crash point (`.old` recovery, staging rebuilt, a foreign folder refused), renames, moves and
  deletions (no stale files: the copy is written in full), trashed pages, name clashes and reserved names, the time
  sheets' quoting and formula prefixes.
- Git sync, the app ended mid-sync: between the merge and its commit, between the pull record and the commit, during the
  fast-forward, after the merge commit before the push or the take-over (changes, new notes, deletions and moves
  returned); deciding a conflict and folding unpushed commits with a pull waiting. A move on one side and a delete on the
  other in both orders, with subpages; a rename there clashing with a new note here; a companion's shallow first sync
  and the libgit2 subset.
- Phone: the id floor after the highest booking is deleted, two phones, an iPad with the full app, a phone set up again;
  every insert through `NEXT_ENTRY_ID`; the reference data taken over only after a successful sync; a timer over
  midnight.
- Command line: `export` as CSV and JSON (running timers never exported or marked), `--mark` with `--include-exported`,
  Jira marking only mapped entries, `--to` including its day, `--pernr` over the setting; `tasks add` and `tasks edit`
  refuse line breaks; `time edit` refuses a running or exported entry; the lock while the app writes, exit codes.
- Vault import: attachments imported twice (not copied again), path embeds (R6A-6), byte order mark, CRLF and Windows-1252
  in notes, links and hidden folders, the batches and the clean-up of an import cut off. Bookmarks: Chromium's JSON with
  a byte order mark, other roots, empty folders, duplicates.
- Saves: killing the app during back-to-back saves (e2e 180) still leaves an intact database with the last acknowledged
  save.

## Tests added

- Rust, `arcalo-core`: `tests/r7b_backup_mirror.rs` (5 tests), `tests/r7b_sync.rs` (3), `tests/r7b_migrate_import.rs`
  (3), `merge::tests::front_matter_merges_key_by_key`; `arcalo`: `syncmerge::tests::a_page_renamed_while_its_conflict_is_open_stays_one_page_on_the_other_computer`;
  `arcalo-cli`: `an_export_that_could_not_be_written_marks_nothing`.
- UI: `sourceChips.test.ts` (a chip of another workspace names no booking), `Select.test.ts` (the person's scroll
  before the list was placed again for the page's).
- e2e: `720-chips-two-desktops.test.js`.

No migration and no settings step were added (the workspace identity is a meta row made when first asked for).
