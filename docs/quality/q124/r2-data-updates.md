# q124 round 2, hunt B: data safety (H2) and updates, migrations, the command line (H6)

Areas H2 and H6 of the [plan](plan.md), round 2. Branch `q124-r2b`. Round 1 of H2 ([h2-data.md](h2-data.md))
fixed four bugs in the Git sync's take-over; this round looked elsewhere: backups and their restore, the return
to the previous version after an update, the trash and attachments, the database and settings migrations of every
older release, the 1.15 rename leftovers and the command line.

Severity as in the plan. Findings: 2 high, 2 medium, 6 low; the high and medium ones are fixed at the root
with tests.

## Findings

### R2B-1 A backup of a newer Arcalo stopped every start after a restore (high, fixed)

- Symptom: after a return to an earlier version (Settings → Über, or the offer after two failed starts) the backup
  list in Settings → Sicherung shows the newer version's daily backups at the top; a destination shared with a
  computer on a newer version does the same. Restoring one of them („Wiederherstellen…“) was accepted, the app
  restarted and stopped at „Neuere Datenbank: Bitte Arcalo aktualisieren“ with „Beenden“ as the only way out, the
  workspace set aside as `workspace.db.before-restore-…`. The version that could open it had just been marked as
  never to be offered again. The start-up recovery of a damaged database („Letzte Sicherung wiederherstellen“) took
  such a backup the same way when it was the newest.
- Root cause: `backupdest::fetch_verified` (used by `stage_restore` and `restore_newest`) checked the checksum and
  `PRAGMA quick_check`, not the schema version; `Database::open` refuses a newer schema only at the next start, after
  the file was put in place.
- Fix: `backupdest::check_schema` refuses a backup whose `user_version` is above `db::schema_known()` before
  anything is staged or replaced, with a message that says why (the settings show it); the recovery skips it and
  takes the newest backup this version can open.
- Tests: `backupdest::tests::a_backup_of_a_newer_version_is_never_put_in_place` (failed: the newer backup was
  staged and put in place, and the recovery chose it); e2e `485-restore-newer-backup` (the built app: refused in
  the settings with nothing staged; the start-up recovery of a broken database opens the workspace's own backup).

### R2B-2 The return after two failed starts acted on updates it could not undo (medium, fixed)

- Symptom: after two failed starts in a row the app asks „Arcalo X konnte zweimal nicht starten – zu W
  zurückkehren? … Änderungen seit dem Update gehen verloren“. It asked also when no copy of the previous version
  had been kept (a Windows program folder that could not be copied): „Ja“ put the database of before the update
  back, every change since gone, and the failing version went on starting on it, now marked as bad. It asked as
  well for an update of months ago (the record stays until the next update): two failed starts with another cause
  (a crash of the system's WebView, a full disk) offered to put back the database of that day, and the question
  named no date.
- Root cause: `update_state::begin_start` offered the return whenever the rollback record named the running
  version; it did not check what Settings → Über checks (`RollbackRecord::can_return`: the backup and the copy of
  the previous version exist) and had no limit in time.
- Fix: the offer needs `can_return` and an update younger than `ROLLBACK_OFFER_DAYS` (7); the question names the
  date of the state it returns to. Settings → Über keeps offering the return with its date.
- Test: `update_state::tests::the_return_is_offered_only_when_it_returns_and_the_update_is_recent` (failed: the
  offer came without a copy and 90 days after the update); e2e `127-update-policy-rollback` (the offer after two
  failed starts of a fresh update) still passes.

### R2B-3 A file the Git server refused stopped every later sync, also after it was removed (medium, fixed)

- Symptom: a push the server refuses for a file in it (GitHub's „GH001: Large files detected“ for a file over
  100 MB, a size limit of a self-hosted server, a quota) stops the sync with the server's reason, as intended. The
  user then deletes the file (or the attachment, or switches the database copy off), and every later sync is still
  refused for the same file: no other computer gets anything from this one any more, and only a hand-made rewrite
  of the history in `git-sync` helps.
- Root cause: every commit is pushed with its files. The sync committed each state on top of the previous one, so
  the commit that held the file stayed among the commits the server does not have, and the server checks all of
  them, not only the newest state.
- Fix: when the server refuses a push (`refused_upload`: its hook, HTTP 413, a pack size limit; not a connection
  that failed), the commits the server does not have are folded into one with the same state (`gitsync::fold_unpushed`: `reset --soft` to the server's commit and one
  commit, also on libgit2) and the push is tried once more. Not while a pull waits to be taken over (its record
  names the commits before it), and not for a single commit. The file still there is refused again with its name;
  once it is gone, the push goes through.
- Tests: `gitsync::safety_tests::a_file_the_server_refuses_stops_the_sync_only_until_it_is_removed` (real git
  with a pre-receive hook that checks every pushed object, as GitHub does; failed: the sync after removing the file
  was refused again), `gitlib::tests` (the soft reset on libgit2); `a_push_the_server_refuses_shows_the_servers_reason`
  still passes.

### R2B-4 After a return to the previous version the Git sync pushed the old state over every computer (high, fixed)

- Symptom: a return to the version before an update (Settings → Über, or the offer after two failed starts) puts
  the database of before the update back. With the Git sync on, the next sync of the returned version committed that
  state as new work: every note changed since the update went back to its old text and every page created since was
  deleted, on the server and then on every other computer, including the changes the other computers had made
  themselves and this one had taken over. Nothing asked; the user had agreed to lose the changes on this computer
  only. (Above the mass-deletion guard's limit only the deletions stopped.)
- Root cause: `rollback::restore` put the backup in place with `backup::restore_from` but did not note the restore
  for the Git sync (`gitsync::mark_restored`), which the restore of a backup in Settings → Sicherung and the
  start-up recovery do since 1.12: the sync then compares with the server and asks before uploading.
- Fix: `rollback::restore` notes the restored pre-update backup for the Git sync once the return has gone through;
  the returned version (1.12 and later read the note) compares and asks as after any restore.
- Tests: `rollback::tests::a_failed_program_swap_leaves_the_new_database_in_place` (no note after a failed return,
  the note after one that went through; failed before), e2e `127-update-policy-rollback` (the note is there after
  the return after two failed starts).

## Low (listed, not fixed)

- L1. Restoring a page from the trash does not bring back attachments it embeds that were deleted meanwhile and
  lie in the file trash (restoring a version does, `bring_back_missing`). The attachment manager warns when a file
  is used by a page in the trash, and the file can be restored from the file trash by hand.
- L2. Renaming an attachment rewrites every page that embeds it, not the saved versions of those pages: restoring
  an older version embeds the old name, which no longer exists.
- L3. `arcalo settings set` writes the settings the command read when it started over the stored ones: a setting
  the app changes in the same few milliseconds is undone (the app saves whole sections the same way).
- L4. `arcalo pages create ""` ends with exit code 3 (conflict) instead of 1 (wrong input); `arcalo pages restore
  Kind` for a subpage trashed together with its page says „nicht gefunden“ instead of naming the page to restore
  (the app's trash offers only the page too).
- L5. A Windows computer whose copy of the old data folder failed at this start (1.15 migration, `Outcome::usable`
  gives the old folder) while an earlier copy exists: the command line uses the new folder (`app_dirs` looks only for
  a database there), the app the old one. Needs a failed copy after an older version wrote to the old folder.
- L6. A shared settings section („Für alle Arbeitsbereiche“) written by an older version on the same computer is
  taken over without the settings migration steps: keys it lacks fall back to their defaults in the other
  workspaces. Needs two versions on one computer (a portable copy next to the installed one).

## Probed without a finding

- Database migrations: an old workspace of every schema version with pages, subpages, tasks, links, a booking and
  settings (`a_populated_workspace_of_every_older_schema_upgrades_without_loss`), the line-end migration 0037, the
  page id floor 0035, the table rebuild of 0018; every foreign key to `pages` (a purge cascades or keeps bookings).
- Settings migrations: every step of `settings_migrate.rs` read for idempotency (a 1.9 that saves over newer
  settings drops `version`, the chain runs again without undoing a choice), the fixtures 1.6 to 1.18.
- The trash: a page trashed with its subpages, a subpage trashed before its page, restoring into a trashed or
  purged parent (to the top level), title and daily-note clashes on restore, emptying with subpages trashed
  separately, purge of a page whose files other pages embed (files are never deleted with pages).
- Backups: rotation (`prune`, both name prefixes, a clock that ran ahead), tagged pre-update backups, the
  interrupted backup (`.partial`), the restore's set-aside and undo, an encrypted workspace restored from a backup of
  before the encryption, the Markdown mirror's interrupted swap.
- The update path: feed parsing (unknown platforms, versions with `v`), a resumed download that the server answers
  with another range, the signature with the signed version, „Jetzt neu starten“ with unsaved edits (the editors
  are flushed first, e2e 126 and 376), the manual return in Settings → Über (names its date).
- The 1.15 rename: the 1.17 cleanup's conditions, legacy markers and environment variables (`ANNALO_DB` still
  names the database for the command line), the autostart and shortcut migration.
- The command line: the page, trash, settings, time and export subcommands with wrong input (unknown page, a move
  into itself, a malformed date, an unknown format or key), a database of a newer version (refused, exit 4), a
  file that is no database, a missing data folder (exit 2), JSON errors.
- Git sync push side: a push the server refuses names the server's reason; the authentication failure messages;
  a remote with rewritten history (merged from the common commit; without one this computer pushes to a branch of
  its own).

## Round 1 fixes

Round 1's tests (`syncmerge.rs`, `vault.rs`, e2e 462) pass on this branch.
