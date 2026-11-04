# q124 round 2, hunt B: data safety (H2) and updates, migrations, the command line (H6)

Areas H2 and H6 of the [plan](plan.md), round 2. Branch `q124-r2b`. Round 1 of H2 ([h2-data.md](h2-data.md))
fixed four bugs in the Git sync's take-over; this round looked elsewhere: backups and their restore, the return
to the previous version after an update, the trash and attachments, the database and settings migrations of every
older release, the 1.15 rename leftovers and the command line.

Severity as in the plan.

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

## Low (listed, not fixed)

## Probed without a finding

## Round 1 fixes
