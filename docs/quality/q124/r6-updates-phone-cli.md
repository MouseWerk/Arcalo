# q124 round 6, hunt B: updates, the command line, the phone and its sync

Areas H6 and H7 of the [plan](plan.md), round 6. Branch `q124-r6b`. The earlier rounds of these areas
([r2-data-updates.md](r2-data-updates.md), [r2-work-phone.md](r2-work-phone.md), [r4-phone.md](r4-phone.md),
[r4-two-computers.md](r4-two-computers.md), [r4-settings.md](r4-settings.md),
[r4-failure-paths.md](r4-failure-paths.md)) fixed the restore of a newer backup, the return after failed starts, the
Git sync after a return, the phone's week and its settings saved during the start, and probed every database and
settings migration from populated old states; their tests still pass and those things were not hunted again. This
round looked at what travels between the phone and the desktop besides notes (bookings as chips, the desktop's
reference data), at the command line as a script uses it (exports run every week, typos, files written on Windows),
and at the updates of the desktop and the phone app.

Severity as in the plan. Findings: 2 high, 2 medium, 7 low; the high and medium ones are fixed at the root with
tests.

## Findings

### R6B-1 A booking made on the phone took the place of a desktop booking of the same day (high, fixed)

- Symptom: the phone books into the daily note as a chip that names its booking by id (`<time-entry id="3" …>`);
  the desktop shows such a chip as a booking from another device and offers „Erneut buchen“. The phone's ids count
  from 1 in its own database, the desktop's as well. When the phone's id was also the id of a desktop booking of
  that daily note (likely in the first weeks of using both, or a phone set up again), the desktop took the phone's
  chip for its own booking: it wrote that booking's hours, reference and text over the chip, and the phone's
  booking was never offered for booking (its hours were lost from the desktop's timesheet without a sign), and when
  the phone's chip stood first in the note, the desktop's own chip of that booking showed as a copy with „Buchen“,
  which books it a second time.
- Root cause: chip ids are row ids of two independent databases; `Database::chip_states` can tell a chip from
  another device only by an id it does not know.
- Fix: a companion app's database gives its new time entries ids of their own range once at its start
  (`Database::own_entry_ids`: a random multiple of 2^32 below 2^52 in `id_floor`, row `time_entries`; every insert
  takes `NEXT_ENTRY_ID`, the highest id + 1 but never below that floor). The desktop has no floor and counts on from
  its highest id as before, so its ids and a phone's never meet, and two phones meet with a chance of one in a
  million. Chips written by phones before this version keep their ids (see L7).
- Tests: `companion::tests::a_booking_made_on_the_phone_never_names_a_desktop_booking` (two desktop bookings in the
  daily note, the phone's booking, a timer over midnight and a booking put back; failed: the phone's first booking
  had the id of the desktop's and its chip was the desktop's linked booking); Android emulator suite
  `phone.test.js` „gives its bookings ids of their own“ (the real app's start sets the floor).

### R6B-2 `arcalo export --mark` exported every booking again, in a layout other than the settings' (high, fixed)

- Symptom: a script that runs `arcalo export --format cats --mark` every week (the use the option is for) wrote
  every booking ever made into each file, those marked as exported the weeks before included: uploaded to SAP, the
  hours were booked twice, three times. The file also ignored Settings → Zeiterfassung: the personnel number (empty
  unless `--pernr`), the separator, the column layout and the decimal point, so it did not match what the app
  writes and SAP's upload was set up for; the Jira format ignored the settings' issue map.
- Root cause: `time::export` of the command line read all entries and built `ExportOptions` with defaults; the app
  (`export_entries`) leaves exported entries out unless asked and takes the options from the settings.
- Fix: the command line leaves out entries marked as exported unless `--include-exported`, and takes the personnel
  number, the Jira map and the CATS layout from the settings; `--pernr` and `--jira-map` still win (docs/cli.md).
- Test: `cli::an_export_takes_the_settings_and_leaves_out_what_was_exported` (failed: no tab, no personnel
  number, and the second export held the first week's booking again).

### R6B-3 `arcalo timer start` and `arcalo time edit` took Vorgänge and Leistungsarten that do not exist (medium, fixed)

- Symptom: `arcalo zeit NP-1/9999 1h` is refused („nicht gefunden“, exit 2), but `arcalo timer start NP-1/9999`
  started a timer on a Vorgang the Netzplan does not have, `#XYZ` set an unknown Leistungsart, and `arcalo time
  edit 12 --vorgang 9999 --activity-type XYZ` changed a booking to both. Such bookings count on no Vorgang's budget
  and reach SAP's upload with a Vorgang or activity type SAP refuses. A Vorgang typed in another case (`np-1/1010`)
  was stored as typed, so budgets and exports did not match it either.
- Root cause: only `tracking::book_command` checked the reference; the timer and the edit of the command line
  passed the text to the database as it was (the app's dialogs offer only what exists).
- Fix: `tracking::known_vorgang` and `known_leistungsart` (the check of `/zeit`, with the stored spelling) for the
  `/zeit` line, `timer start` and a changed Vorgang or Leistungsart in `time edit`; a booking keeps its own values
  when they are not changed, also a Leistungsart deleted since.
- Test: `cli::the_timer_and_an_edit_take_only_known_vorgaenge_and_activity_types` (failed: the timer started on
  `NP-1/9999`, exit 0).

### R6B-4 Text from a file or a pipe on Windows was stored with its byte order mark and CRLF (medium, fixed)

- Symptom: `arcalo pages create Notiz --file notiz.md` with a file saved by Notepad or PowerShell
  (`Out-File`, `Set-Content -Encoding utf8` in Windows PowerShell 5) and `Get-Content … | arcalo pages append …
  --stdin` stored the text with a byte order mark and CRLF line ends. The page's properties were gone (the
  frontmatter did not start at the first character), the first heading showed with a stray character, and every
  line differed from what the editor and the Git sync write, which 1.19 had to repair once already for the notes of
  1.18.0 (migration 0037).
- Root cause: `pages::read_body` passed the text on as read; the vault import strips the mark and the CRs.
- Fix: the text of `--body`, `--file`, `--stdin` and the argument is stored as the app stores it: without the
  mark, with LF line ends (`as_stored`), for `pages create`, `append`, `replace` and `daily append`.
- Test: `cli::text_written_on_windows_is_stored_as_the_app_stores_it` (failed: the stored text kept the mark and
  the CRs).

### Low (listed, not fixed in this round)

- R6B-L1: `arcalo time list` (default range) and `arcalo time week` count the week from Monday, also with
  „Woche beginnt am“ Sonntag (as R2C-L5 for the status report).
- R6B-L2: the phone's booking form drops quote characters from the text (`Er sagte "ja"` is booked as
  `Er sagte ja`): the text is quoted for the `/zeit` line and the quotes inside are removed.
- R6B-L3: a phone booking edited or deleted on the phone after the desktop booked its chip („Erneut buchen“ gives
  the chip the desktop's id) changes only the phone's booking; the desktop keeps the booked values.
- R6B-L4: Projekte, Netzpläne, Vorgänge and Leistungsarten deleted on the desktop stay on the phone (the reference
  data is taken over by number, never removed); a booking on one of them is refused by „Erneut buchen“ on the
  desktop with „nicht gefunden“.
- R6B-L5: a conflict decided on the phone with the view opened before a booking or a stopped timer wrote its chip
  into the same daily note: the decided text has no chip (the booking stays, without a chip in the note).
- R6B-L6: `arcalo absences add 2026-12-31 2026-01-01` (the days the wrong way round) is refused with „Please choose
  a range of at most one year“ and exit code 3 (conflict) instead of naming the order (usage, 1).
- R6B-L7: chips written by phones before this version keep their small ids; one that names a desktop booking of
  its note keeps showing as that booking (R6B-1 holds for every booking made after the update).

## Looked at, no finding

- Phone sync: the reference data from the desktop's database copy (a copy of an older schema, a newer one, an
  encrypted one, none), appointments around today, bookings over midnight from the phone's timer, the booking form's
  `/zeit` line (texts with `#`, `@`, digits and quotes are quoted, so nothing in them is read as a command), the
  capture into a daily note pulled from the desktop, a daily note in conflict (the conflict view merges with the
  note as it is now), the settings sync between phone and desktop (secrets and per-device fields never travel).
- Phone updates: the feed (version, version code, package, HTTPS), the offer for another signer or package, the
  downloaded APK checked against the feed and the installed app.
- Desktop updates: version comparison (pre-releases, build metadata, `v`), the restart marker, the return to the
  previous version (round 2's fixes and tests).
- Command line: the page, task, time, timer, absence, settings, export and search commands with wrong or odd input
  (unknown pages and entries, dates that do not exist, a page moved into itself, a priority over 2, a duration over
  24 hours, a span over midnight that would end in the future, a range the wrong way round, an unknown or mistyped
  setting, an empty search, no running timer), their JSON errors and exit codes.

## Tests added

- Rust: `companion::tests::a_booking_made_on_the_phone_never_names_a_desktop_booking`; `cli` (in
  `crates/arcalo-cli/tests/cli.rs`): `an_export_takes_the_settings_and_leaves_out_what_was_exported`,
  `the_timer_and_an_edit_take_only_known_vorgaenge_and_activity_types`,
  `text_written_on_windows_is_stored_as_the_app_stores_it`.
- Android emulator: `phone.test.js` „gives its bookings ids of their own“.

No migration was added (the floor uses the `id_floor` table of migration 0035).
