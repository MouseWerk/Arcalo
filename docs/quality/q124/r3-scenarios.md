# q124 round 3, hunt A: scenarios across features

Round 3 of the [plan](plan.md), hunt A. Branch `q124-r3a`. Instead of one feature at a time, this hunt plays
through the work of a consultant in a German company end to end in the real app (Europe/Berlin) and checks every
number, file and screen on the way: a week of daily notes with `/zeit` bookings, meetings from an ICS calendar
with a prep page and a meeting note, tasks written in notes, ticked off in the task view and repeated, a Jira
worklog, then Friday's week review, timesheet, calendar, CSV, SAP CATS and the assistant's tools against what was
booked; a daily note kept open in one pane while its link target is renamed, its booking corrected and its task
ticked off elsewhere; a restart with the timer running and a restore of the morning's backup; and an office
computer and a laptop sharing their notes through a Git repository, going on with each other's work.

There is no test clock in the app, so the week is last week, written up from its daily notes.

The fixes of rounds 1 and 2 on these paths (the clock change spans, the day targets, the monthly tasks, the
worklog edits, the target history, the restore with Git) still hold: their tests pass and the scenarios cross
them without a finding.

Severity as in the plan.

## Findings

### R3A-1 `/zeit` written up later in an earlier day's daily note books on today (high)

- Symptom: on Friday, writing up the week in Tuesday's daily note, `/zeit NP-6000/20 30m Nachtrag Telefonat`
  booked the half hour on Friday. The chip in Tuesday's note said „04.11.“, the toast only „0,50 h gebucht“;
  Tuesday's hours in the timesheet, the week review and the SAP CATS export missed it, Friday's had it twice
  over the target. The booking was on the wrong day unless every line carried `@date`.
- Root cause: `tracking::log_slash_command_in` parsed the line with today as the default date; the page the
  line was typed in was only used for the default reference and the chip link, never for its day.
- Fix: a line without a date typed in the daily note of an earlier day books on that day
  (`zeit::parse_for_day`, the note's `daily_date` from `log_slash_command_in`); a date in the line still wins,
  `@heute` included; today's note and other pages book as before. The chip carries that day.
- Tests: `tracking::tests::a_line_without_a_date_in_an_earlier_daily_note_books_on_that_day`; e2e
  `600-scenario-work-week` („a /zeit without a date written up later in Tuesday's daily note books on Tuesday“,
  and the week's numbers after it).

### R3A-2 The second computer makes a second daily note beside the one it took over (medium)

- Symptom: the office computer wrote today's daily note and synced. The laptop took it over („2026-11-04“ under
  Tagesnotizen), but „Heute“ (Ctrl Shift D, the start page, quick capture, focus and mail tasks into the daily
  note) opened a new empty daily note of the same title beside it. The day's notes were then split over two
  pages, and the next sync carried the second one back to the office.
- Root cause: the repository carries the note's text, not its daily mark (`pages.daily_date`); pages taken over
  are plain pages, and `Database::daily_note` only looked for the mark. The phone already adopted such a page
  (`companion::daily`), the desktop did not.
- Fix: daily notes taken over are marked as the daily notes of their days when they arrive
  (`Database::adopt_daily_notes` from `syncmerge::apply`: title in the settings' format or the ISO date, the day
  without a daily note), and `daily_note` adopts one taken over before (`daily_note_found`, now also the phone's).
- Tests: `notes::tests::a_daily_note_from_another_computer_becomes_the_daily_note_here`; e2e
  `601-scenario-two-computers`.

### R3A-3 The second computer makes a second meeting note and prep page for the same appointment (medium)

- Symptom: the office wrote the meeting note of „Abstimmung Schnittstelle“ (with a decision) and its prep page
  (with a question below the generated part). On the laptop, with the same calendar, „Notiz zur Besprechung“
  created „Abstimmung Schnittstelle 04.11.2026 2“, empty, and „Besprechung vorbereiten“ „Vorbereitung … 2“;
  the notes written in the office were not found from the appointment, and both computers ended up with two
  notes per meeting.
- Root cause: the link from appointment to note (`calendar_marks.note_page_id`) and to prep page (meta
  `prep.page.<key>`) is local; the pages taken over carry no link, and both functions only numbered the title
  past them.
- Fix: before numbering, `calendar_meeting_note` takes a page of that title whose front matter names the
  appointment's day and time (`datum`/`date`, `uhrzeit`/`time`) and that is no other appointment's note;
  `meeting_prep_write` takes a page of that title whose generated part names the appointment's day and time and
  that belongs to no other appointment. Both link it then. A page of the same title about something else stays.
- Tests: `calsync::tests::a_meeting_note_from_another_computer_is_the_note_of_its_appointment_here` (two
  appointments of the same subject on one day, opened in the other order), the prep part of
  `meetwork::tests` (prep page refreshed on a second database); e2e `601-scenario-two-computers`.

### R3A-4 A computer without bookings takes the other computer's time sheets off the server (medium)

- Symptom: after the laptop's first sync, `Zeiterfassung/2026-11.csv` of the office computer was gone from the
  repository (the commit deleted it); the office's next sync put it back, the laptop's next one deleted it again.
  The repository's README promises the time sheets per month; with two computers it held them only every other
  sync.
- Root cause: the sync makes its working tree a copy of this computer's mirror; the mirror of a computer without
  bookings has no `Zeiterfassung/`, so the folder counted as removed. Only a companion device protected it.
- Fix: time sheets are never removed by the sync (`protected` keeps `Zeiterfassung/` for every computer);
  this computer's months are added and updated by `sync_time_sheets`.
- Tests: `gitsync::tests::another_computers_time_sheets_stay_and_this_ones_months_are_written`; e2e
  `601-scenario-two-computers`.

### Low (listed, not fixed in this round)

- R3A-L1: two computers that both book in the same month write the same `Zeiterfassung/JJJJ-MM.csv`; the last
  sync's wins (the bookings themselves stay in each computer's database and backups). A time sheet of a month
  whose bookings were all deleted later stays on the server.
- R3A-L2: time entry ids are reused (`time_entries.id` without `AUTOINCREMENT`): after deleting the newest
  booking, the next one gets its id. A chip whose booking was deleted elsewhere (another computer's note, a
  restored note) can then find the new booking: shown as booked elsewhere, or moved to it when its target
  matches and the new one's chip is gone.
- R3A-L3: on a second desktop, the first computer's chips show as bookings from another device; „Erneut
  buchen“ books them there as well, so both computers' exports carry the same work if both export it.

## Looked at, no finding

- The week's numbers agree everywhere: the week review (booked, target, missing, per WBS), the month calendar
  (`daily_overview`), the timesheet's grid and total, the CSV, SAP CATS per day with PERNR, the assistant's
  `time_summary` and `list_tasks`, the Jira worklog (seconds and start of Thursday's booking), and this week's
  start page widget beside the daily note it is booked in (it follows the booking without a reload).
- Meetings: six appointments of the ICS series and single event in the week, the review booked from its meeting
  note shows as booked with its note in the week review; the open task of the meeting note is in the task list.
- A weekly task ticked off in the task view gets its next occurrence (the next Friday from today), counts in this
  week's review, and the old one keeps its due date.
- An open note in one pane: a rename in the other pane, a correction of its booking and a task ticked off in the
  task view show in it without a reload, and typing on never writes the old link, hours or checkbox back.
- A restart with the timer running keeps the timer, the note and its chip; restoring the morning's backup gives
  the morning's bookings, notes and tasks and no timer.
- Two computers: the laptop's rename of a linked page, its edit of the daily note and its ticked task reach the
  office; the office's booking stays its own and linked to its chip.
- The week proposal of a finished week proposes nothing booked already.

## Tests added

- Rust: `tracking::tests` (earlier daily note), `notes::tests` (daily note taken over), `calsync::tests` (meeting
  note taken over), `meetwork::tests` (prep page taken over), `gitsync::tests` (time sheets).
- e2e: `600-scenario-work-week.test.js` (the week, Friday's numbers, the assistant's tools, the start page beside
  the note), `601-scenario-two-computers.test.js` (office and laptop through Git), `602-scenario-open-notes.test.js`
  (open note while others change it, restart with the timer, restore).
