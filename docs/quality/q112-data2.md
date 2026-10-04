# Arcalo 1.12, A5b Data follow-ups: findings

Severity: Critical / High / Medium / Low (as in q112-data.md).

E1 High - Git sync after restoring an older backup pushes the old state as new changes.
  Root cause: the restored database writes an older mirror; the sync commits mirror vs. working
  tree on top of the newer history and pushes it (fast-forward), so newer edits are reverted on the
  server without a word (history keeps them, nobody notices).
  Fix: restore (both paths: Settings restore and start-up recovery) writes `sync-after-restore.json`;
  the next sync compares the restored mirror with the newest server state and stops with a question
  when they differ: "Neueren Stand vom Server holen" (server notes taken over, the restored text stays
  as a page version; notes changed here and not in the server's history become conflicts; notes only
  here stay) or "Wiederhergestellten Stand hochladen" (committed on top of the newest server state;
  the server history keeps the newer one). No difference: no question.

E2 Medium - Files referenced only by old page versions or stored e-mails are listed as "unused" and
  offered by "Aufräumen"; deleting them breaks restoring such a version (image missing) and the
  e-mail link (file of the stored e-mail gone).
  Fix: the list knows `in_versions` and `mail`; stored e-mails count as used, version-only files get
  their own label/filter with the explanation and are not in "Aufräumen"; restoring a version brings
  files it needs back from the file trash.

E3 Medium - No way to change the database key (only decrypt + encrypt again, which writes a plain
  copy to disk). Fix: re-key through the same crash-safe switch (export with the new key, verify,
  two renames), new key kept as "next" in the credential store until the swap, wrapped password key
  re-wrapped; new recovery key shown/printed/saved before the restart.

E4 Medium - A vault import writes all pages in one transaction while holding the database lock: with
  20,000 notes the app waits for it (every command blocks), no progress in that phase, no cancel.
  Fix: pages are written in batches of 200 (lock released between batches), progress "Seiten anlegen",
  cancel between batches removes the partial import; a marker removes a partial import after a kill.

E5 Low - Database and file errors end with SQLite's / the OS's English text
  "(Error code 13: Insertion failed because database is full)" after the German message.
  Fix: technical text is separated ("Details:"), the toast shows it behind a "Details" toggle.

E6 Medium (Linux, broken portal) - quick capture pre-created 1.5 s after the first frame blocks the
  main thread 5 s (tao portal theme read). Fix: see report section.

## Status
All six fixed, with tests:
- E1: gitsync::{check_restore, pull_restored, advance_to_server, Restored marker}; shell run_git_sync_with +
  git_sync_now(after_restore); Settings → Sicherung row "Nach der Wiederherstellung" (two buttons, upload confirms
  with the number of notes deleted on the server); toast "Synchronisierung wartet auf deine Entscheidung" with
  "Entscheiden" (scrolls to the row); automatic syncs repeat the check without a new toast.
  Tests: core a_restored_backup_is_compared_with_the_server_first (bare remote, second computer, pull + upload),
  e2e 230 (restore via settings, restart, question, pull: newer notes back, restored text in versions, nothing pushed).
- E2: attachment_manager version_usage/mail_files/bring_back_missing; page_version_restore brings files back.
  Tests: core files_of_old_versions_and_stored_mails_are_not_unused, vitest attachments, e2e 230.
- E3: cipher Direction::Rekey, run_pending_keys, next_key_fate, WrappedKey next file; security.rs
  cipher_rekey_prepare/cipher_rekey/cipher_rekey_cancel, settle_next_key at start, keygate password tries the next
  wrapped key. Tests: core changing_the_key_survives_a_crash_at_every_step (5 kill points),
  a_key_change_without_the_new_key_rolls_back_and_backups_use_the_new_key; e2e 231 (UI, restart, old recovery key
  refused, new accepted, backup encrypted).
- E4: vault::apply_import_batched (200 per transaction), PENDING_IMPORT meta, discard_unfinished_import at start.
  Tests: core a_large_import_is_written_in_batches_and_can_be_stopped (autocommit between batches, cancel, kill);
  e2e 230: 4000 notes, database waits during the write max ~550 ms (one transaction before), cancel leaves nothing.
- E5: error::DETAILS separator for db/io/http texts; UI errorParts, toast "Details" toggle. Tests: core error tests,
  vitest aierror, e2e 230 (disk full).
- E6: portal probe off the main thread (dbus, 1 s patience for a refusal); hanging portal -> capture window created
  after 20 s input idle or on first use. Measured (debug build, Xvfb): lazy creation 738-855 ms (> 300 ms, so a
  normal desktop keeps pre-creating 1.5 s after the first frame; 68 still measures < 150 ms); with a hanging portal
  the main thread max wait after start 271 ms (old build 1485 ms = activation timeout, 5 s with tao's own timeout).
  Trade-off: on a broken-portal desktop the first open before the idle pre-creation takes ~2.3 s (portal wait).
  Tests: unit the_capture_window_waits_for_a_hanging_portal_and_idle_time; e2e 232 with a bus whose portal hangs.

Left: update rollback (rollback.rs restore_from) does not write the sync marker (the previous version it
reinstalls does not know it). Re-encrypting older backups with the new key is not done (documented in the dialog).
