# Arcalo 1.10 quality round: findings

Scope: `git diff ff9edc1..HEAD` (targeted reads, data safety and security first) and a UI tour
(EN-light and DE-dark, 1480x920 and 900x600; settings Network / Sicherheit / Datenschutz /
Protokoll, grouped nav at 760/820/900/980/1100 px, mentions panel, duplicate compare, PDF
highlights, meeting prep, status report dialog, follow-up mail, graph filters). Console errors
during the tour: none. Status: F = fixed in this round, D = documented only.

## High

1. F — Rollback restored the program before the database (`src-tauri/src/rollback.rs:149`).
   Repro: a failed update whose pre-update backup cannot be copied back (disk full, file locked)
   after `reinstall` succeeded: the previous version starts on the database the new version
   migrated. Now the database goes first (`backup::restore_from` returns a `SetAside` that can
   be undone), then the program; a failed program swap puts the new database back. `restore_from`
   also undoes its renames when the copy fails (before, the workspace file was left missing).
   Tests: `backup::tests::tagged_backups_stay_out_of_the_rotation` (undo, failed copy),
   `rollback::tests::a_failed_program_swap_leaves_the_new_database_in_place`.
2. F — Any automatic lock lost unsaved editor input (`src-tauri/src/security.rs:465` `set_locked`,
   `tick`). Repro: type in a note, wait for the idle lock (or `applock_test_idle`): the lock screen
   unmounts the editor, its unmount flush is refused with `app-locked`, the last edit is lost. Only
   Settings → „Jetzt sperren“ flushed. Now every lock is two-phase: `applock://locking` → the main
   window runs `flushAllEditors` → `applock_flushed` locks (fallback after 3 s).
3. F — App-lock bypass: `applock_configure` was allowed while locked (`security.rs:420`, every
   `applock_*` command passed the guard). Any script in a locked window could set a new PIN (no old
   PIN asked) and unlock with it, or switch the lock off. Now refused while locked (test extended).
4. F — Presenter window kept showing slides and speaker notes while locked (`ui/src/main.tsx:89`,
   no lock gate). Now wrapped in `PopupLockGate`.

## Medium

5. F — Follow-up mail To list included the user (`src-tauri/src/meetwork.rs` `build_followup`,
   `outlook-mail.ps1` draft). Repro: an appointment where you are an attendee → „Nachfass-Mail“
   lists you. Now filtered by Outlook's CurrentUser (name, address, SMTP; in the draft script), the
   Jira accounts, the Git author e-mail and the new setting `mail.own_addresses` (Einstellungen →
   E-Mail „Eigene Adressen“; settings step 9 → 10 `own-addresses`). The meeting preparation's
   attendee list uses the same identities. Names match in both forms
   („Müller, Anna“ = „Anna Müller“). Test `followup_mail_leaves_out_the_users_own_addresses`.
6. F — Tidy-up / bulk-move undo reverted pages moved by hand since (`crates/annalo-core/src/filing/tidy.rs:434`).
   Migration 0027 records where the move put each page (`move_undo.new_parent`, `placed`); undo
   moves back only pages still there. Test `undo_leaves_pages_moved_by_hand_since`.
7. F — Multi-selection drop in the tree went to the folder end (`ui/src/components/Sidebar.tsx:459`,
   `move_pages` appended). New `move_pages_at(ids, parent, position)` / `pages_move { position }`;
   pages keep their order, same-folder pages are reordered. Test
   `moving_many_to_a_position_keeps_their_order_there`.
8. F — Canvas silently dropped edges whose cards are missing on the next save
   (`ui/src/lib/canvas/model.ts:99`). Repro: a canvas file merged from Git/Obsidian with an edge to a
   card that is not there; move any card: the edge is gone from the file. Hidden entries (dangling
   edges, nodes without id) are now kept under a private key and written back by `serializeCanvas`.
9. F — Series meeting notes flagged as duplicates (`crates/annalo-core/src/duplicates.rs:323`).
   Repro: „Weekly sync 2026-10-01“ shows „Similar page: Weekly sync 22.09. (100 % similar)“ —
   `normalize_title` strips dates, so every note of a series matches the previous one. Titles whose
   dates differ no longer count as a title match (text still does). Test in `normalizes_titles`.
10. F — Settings nav (`ui/src/styles/settings.css:283`, `SettingsView.tsx:148`): with all groups
   open it scrolled at 821–980 px (900: 798 px content in 738 px) although the comment promises a
   fit, and the fade edge was stale after a window resize (760/821/981 px: items below without
   `fade-bottom`): the effect that watches the list ran before the list existed (it renders only
   once the settings are loaded) and never attached. Tighter medium spacing (fits at 900: 738/738)
   and the watchers start when the list mounts (resize, group toggles, media-query changes). 1100 px fits; 760 px scrolls with fades, last
   item reachable.
11. F — Graph date filter: the EN placeholder „DD.MM.YYYY“ was cut („DD.MM.YYY“) in the 300 px
   panel (`ui/src/views/GraphView.tsx:410`); now one row per field with a From/To label. The layout
   worker had no error path (`GraphCanvas.tsx:427`): `startLayout` falls back to the main thread
   when the worker cannot start or errors, replaying the last init/params (2 vitests).
12. F — Generated block marker overlapped the first line of meeting prep / status report pages
   (`ui/src/styles/editor.css:1295`): `margin: 1.6em …` on an element with `font-size: 0` is 0.
13. D — Follow-up `mailto:` only takes attendees given as addresses; ICS attendees with a CN are
   stored by name only (`calsync/ics.rs:464`), so they are missing from the `mailto:` To (test 142
   expects exactly this). Suggest storing `Name <address>` for ICS attendees in 1.11.

## Low

14. F — EN UI showed „Umgebungsvariablen (…)“ / „Windows-Interneteinstellungen“ as the system
   proxy source (`crates/annalo-core/src/network.rs:694,735`).
15. F — Mentions could suggest titles a `[[link]]` cannot hold (`#`, `|`, `[`, `]`, `^` in titles of
   pages from before `clean_title`), e.g. „C# Grundlagen“ → `[[C# Grundlagen]]` links to „C“
   (`mentions.rs:404`). Such titles are skipped. Test `titles_a_link_cannot_hold_are_not_suggested`.
16. F — Diagnostics bundle: the settings redaction used a shorter secret list than the settings
   sync (`*_key`, `pin`, cookies, private keys were kept) and settings paths showed the home
   folder (`src-tauri/src/diagnostics.rs:16,82`).
17. F — While locked, the main window title kept the open page's name (taskbar, Alt+Tab).
18. D — `settings_get` stays allowed while locked (the lock screens need theme and language); it
   returns no secrets but names (Git author, own addresses, quick links). Acceptable; a reduced
   command for the lock screens would close it.
19. D — Duplicate merge undo restores the kept page's text from before the merge; edits made
   after the merge stay only as a page version (`duplicates.rs:567`). Not lost, but not merged.
20. D — The prep page opens with the generated block's start marker node-selected (blue outline).
21. D — A multi-line HTML comment in a note is masked only on its first line by the mention scan
   (`mentions.rs:327`); text inside later lines can be offered as a mention.

## Checked, no finding

- Encryption switch (`cipher.rs` `run_pending_with`): every crash point resumes or rolls back; the
  old file is kept until the second successful start; keys are read back after storing.
- Recovery screen: key checked against the file before it is stored; the hand-off key file is
  0600 and deleted after one read; backup restore keeps the current file as `.broken-…`.
- Backups with encryption: `VACUUM INTO` keeps the key; pre-update backups are encrypted.
- Settings migrations: fixtures 1.6–1.9 load without losing values; steps idempotent; the 1.9
  „accept invalid certificates“ is carried as the legacy flag (1.9 applied it to every service, so
  the copy for the `apply_to`-off services is faithful).
- Settings sync: secrets scrubbed at every depth in both directions, machine keys excluded.
- Linux secret migration: write, read back, compare, then remove from the file; repeatable.
- Per-host trust: pins only for the exact host, signature checks still delegated; every HTTP
  client goes through `network::client_for` (others are tests or the updater's loopback feed).
- Mail HTML: every note text is escaped (`<`, `>`, `&`, quotes); the draft goes via a JSON file.
- Log redaction: messages and fields redacted at write time and again for the bundle.
- SQLCipher's SQLite 3.51.3 vs the former 3.53.2: only `json_array_insert`/`jsonb_array_insert` are
  new (function lists of both amalgamations compared; same pragmas and keywords; same build
  flags); neither is used. Guard test `cipher::tests::no_sql_newer_than_the_bundled_sqlite`.
