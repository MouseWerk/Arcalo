# Arcalo 1.12 quality pass, A5 Data: findings

Severity: Critical (data lost/corrupted silently), High (data at risk, or silent wrong state),
Medium (confusing/wrong message, recoverable), Low (polish).

## Open / in progress

D1 High - Restoring a plain backup into an encrypted workspace leaves it unencrypted.
  Repro: encrypt the database, restore a backup from before the encryption (Settings → Sicherung).
  Root cause: the encryption state is only the file's bytes; apply_pending_restore / restore_newest
  put the plain file in place and nothing re-encrypts it; Settings → Sicherheit just shows "aus".
  Fix: when the replaced database was encrypted and the restored one is plain, request the
  encryption (cipher::request) so the same start encrypts it before opening.

D2 High - Edits of a closed editor whose save failed are lost.
  Repro: data folder read-only/disk full, type in a note (toast "Speichern fehlgeschlagen"),
  switch page or close the tab. The retry timer lives in the destroyed editor; the text is gone.
  Fix: keep failed saves of closed editors (saves.ts), retry them, flushAllEditors waits for and
  reports them (quit asks), editors showing the page take the text over when it lands.

D3 High - Select all + type (or paste over) inside the 10-minute snapshot window loses the
  previous text once the editor is closed (no version holds it).
  Fix: a save that removes most of a page (more than half and at least 200 characters) always
  snapshots the previous content first.

D4 Medium - A backup killed or failing mid-write leaves a truncated arcalo-*.db that counts as
  the newest backup (listed, counted by retention, copied to destinations, first candidate of
  the start-up recovery).
  Fix: VACUUM INTO a .partial file, fsync, rename; stale .partial files removed.

D5 Medium - Database error messages say what happened but not what to do (disk full,
  read-only, locked, damaged).
  Fix: db_text adds the remedy.

D6 Medium - The mass-deletion guard relies on git's rename detection default; with
  diff.renames=false in the user's git config, an "Aufräumen" of >10 pages is blocked as a mass
  deletion. Fix: pass -M explicitly.

D7 Low - Cancelling a vault import shows the German "Import abgebrochen" in the English UI.

D8 Low - Restoring an encrypted backup without the key reports "Die Datenbank ist beschädigt"
  instead of "encrypted, key missing".

D9 Medium (test gap) - No test upgrades a populated database from every older schema; the
  brief's "fixtures for 1.0, 1.5, 1.9 in e2e" do not exist (only settings JSON for 1.6–1.9).

## Status (end of pass)
Fixed: D1 (backupdest::keep_encrypted + cipher test), D2 (saves.ts keepUnsaved/takeUnsaved, NoteEditor +
SourceEditor, persistent "Nicht gespeichert" pill, e2e 180), D3 (versions::removes_most + test), D4
(backup::vacuum_into partial + test), D5 (db_text remedies + test), D6 (diff -M in the sync guard + test),
D7, D9 (db test over every schema 1..22 with data). D8 dropped: a missing key already says so.
Verified: SIGKILL during 200 KB saves -> integrity ok, last acknowledged save complete (e2e 180).
Left: a restored older backup + sync pushes the older state as new changes (server history keeps it);
files referenced only by old versions or mail_links count as unused; a huge vault import holds the write
lock in one transaction; no key rotation (only encrypt/decrypt).

## Checked, fine
- atomic(): failed commit rolls back, nested savepoints; WAL + synchronous=NORMAL (process kill
  safe; power loss may lose the last commit, file stays consistent).
- Encryption switch: marker file, verify, two renames, kill hooks tested.
- Trash: subtree stamps, restore to top level, title clash, purge detaches separate children.
- Mirror file names: Windows device names (also with dots), 120 chars / 200 bytes, case-insensitive
  uniqueness; git core.longpaths.
