# 1.21 plan

Started by the owner on 2026-10-15: appointments can be created, changed, moved and deleted in the Kalender,
and Outlook changes with them.

## Owner decisions (2026-10-16)

- **Write path:** Outlook Classic on Windows through its COM object model, like reading today: no sign-in, no
  app registration, no admin rights. A Microsoft 365 sign-in (Graph) for the new Outlook and macOS is not part
  of 1.21 and stays open.
- **What can be changed:** own appointments without attendees, wherever they were created, and meetings the
  user organizes. Changing an organized meeting with attendees asks before Outlook sends the update to them
  („Aktualisierung an 3 Teilnehmende senden?“); without that confirmation nothing is saved. Meetings received
  from others stay read-only.
- **Attendees, Teams link, series:** not edited in Arcalo. „In Outlook öffnen“ shows the appointment in an
  Outlook window for that. Series are read-only.
- **Target calendar:** the default Outlook calendar, changeable in the settings to another own calendar.
- **Defaults taken from the plan's recommendations:** a closed Outlook is never started, changes wait in a
  queue (as for focus blocks); a field changed in Outlook and in Arcalo at the same time asks („Outlook-Version
  übernehmen“ / „Meine Änderung behalten“), different fields never conflict; writing is off for existing
  installations (a switch under Settings → Kalender and an offer on first use); delete goes to Outlook's
  Deleted Items with „Rückgängig“; the assistant creates no appointments; no Outlook category on entries
  (only a hidden marker); without Outlook Classic (macOS, Linux, new Outlook) „Neuer Termin“ is not offered
  and the setting says why.

## Design

Built on the focus block machinery of 1.8 (`timeblocks.rs`, `calsync/outlookwrite.rs`, `outlook.ps1 -Mode
write`, the outbox of migrations 0015/0018).

- **Data:** migration `0039_calendar_writes.sql`: `calendar_events` gains `entry_id`, `modified`, `meeting`
  (Outlook MeetingStatus) and `has_attendees`; a new `calendar_outbox` (marker, source, op create/update/delete,
  uid, entry_id, changed fields, the values Arcalo last saw, seq, attempts, next_try, state, error). Settings
  step 18 → 19: `entries_outlook` (off), `entry_target` (`outlook`), `entry_minutes` (30).
- **Core:** `calsync/writes.rs` with create/update/delete/resolve, the outbox (merging changes into a waiting
  op, dropping an op that returns to the old values), the overlay shown in the Kalender before Outlook has
  the change, and `editable` with a reason for the UI. Writes are patches of the fields the user changed, so
  redacted titles and missing texts are never written.
- **Script:** `outlook.ps1` reads `LastModificationTime`; write mode handles appointment ops in the default or
  a chosen own calendar, finds an item by EntryID or the marker `ArcaloEntry` (no duplicate after a lost
  answer), compares the last seen values before saving (conflict), never starts Outlook; `.Send()` only for
  an organized meeting whose update the user confirmed; new `-Mode show` for „In Outlook öffnen“.
- **Shell:** `src-tauri/src/calwrite.rs` (commands, flush and scheduler like focus blocks, one shared lock for
  all Outlook writes, flush before each Outlook sync).
- **UI:** create by dragging over an empty stretch of a day, a double click or `N`; edit, move and resize
  editable appointments; pending and conflict states with a quiet tint and an icon; undo toasts; settings
  group „Termine anlegen“; palette „Neuer Termin…“.
- **Tests:** core tests with a fake Outlook writer (create, lost answer, change during a write, conflict,
  delete, undo, read-only kinds, send confirmation for organized meetings), parser and script string tests, the
  settings step, a stateful Outlook fixture, e2e 407, layout in light, dark and contrast themes, a manual
  Windows checklist.
