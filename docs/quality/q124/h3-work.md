# q124 hunt H3: work features

Area H3 of the [plan](plan.md): tasks, calendar and ICS, meetings, time tracking and its exports, projects, the
start page and the reviews. Branch `q124-h3`. Read first: the core tests of `tracking`, `zeit`, `timer`,
`worktime`, `export`, `recurrence`, `taskedit`, `calsync::ics`, `weekplan`, `weekreview`, and the e2e tests of
time tracking, tasks and the calendar (152, 290, 310, 411 and others). The hunt looked for what they do not
cover: clock changes (25 Oct, 29 Mar) in Europe/Berlin, the numbers each view shows against the target, and the
paths that compute the same thing twice (editor and task view, calendar and timesheet).

Severity as in the plan; wrong numbers and dates count as high.

## Findings

### H3-1 A `/zeit` time span over a clock change books the wall-clock length (high)

- Symptom: `/zeit NP-8801/1020 01:00-04:00 Migration @25.10.2026` booked 3 h; the clock ran 4 h (03:00 summer
  time became 02:00). On 29 March the same span booked 3 h for 2 h of work. A night shift `22:00-04:00` over the
  change was off by an hour the same way. The timer and the manual entry book the real time, so the same work
  gave different hours depending on how it was entered, and the export (SAP CATS, Jira, CSV) carried the wrong
  number.
- Root cause: `zeit::parse` turned the span into minutes by subtracting the two wall-clock times
  (`span_minutes`); `tracking::book_command` then placed the start in the user's zone and added those minutes.
- Fix: the parsed command keeps the span's end (`ZeitCommand::end`); `book_command` places start and end in the
  user's zone on the booking's day (the end on the next day when it is not after the start) and books the
  minutes between the two instants. An empty span in real time (inside the skipped hour) is refused like an
  empty one.
- Tests: `tracking::tests::a_time_span_over_the_clock_change_books_the_real_length` (Europe/Berlin: 25 Oct 240,
  overnight 420, 29 Mar 120, an ordinary day 90); e2e `450-work-numbers` test 1 (the real app in Europe/Berlin).

### H3-2 The month calendar marks vacation days and holidays red and short Fridays as missed (medium)

- Symptom: in the calendar popover („Tagesnotiz eines Tages“) and the start page's calendar widget, a past
  vacation day, a public holiday or a sick day without bookings was tinted red („unter dem Soll“), a half
  vacation day with 4 h booked as well, and a Friday with its own target of 5 h (Settings → Zeiterfassung →
  „Soll je Wochentag“) reached was red too. The timesheet, the start page's balance and the reviews showed no
  gap on the same days.
- Root cause: `dayTone` (`ui/src/lib/calendar.ts`) compared each day with the general daily target and the
  workdays from the settings; the day overview it reads (`calendar::daily_overview`) had no target. Every other
  view uses `worktime::DayTargets` (weekday targets, holidays of the state, absences, the day the workspace was
  set up).
- Fix: `DayOverview` carries `target_minutes` from `DayTargets`; `dayTone` compares with that target (a day
  without one is never below it, a reached own target is met), and the popover's bar fills against it.
- Tests: `calendar::tests::the_target_of_each_day_follows_holidays_absences_and_weekday_targets`;
  `calendar.test.ts` („tints past days below their own target“); e2e `450-work-numbers` test 2 (overview
  numbers and the tint of the cells for a vacation Monday, a short Friday and two days below the target).

### H3-3 A monthly task from the 29th to 31st loses its day when ticked off in the editor (high)

- Symptom: `- [ ] Miete every:monthly due:2026-01-31` ticked off in the note's editor (or on the phone) got
  `every:monthly due:2026-02-28`, so the next one was due on 28 March, then on the 28th forever. Ticked off in
  the task view the same task got `every:monthly,31 due:2026-02-28` and came back to the 31st in March.
- Root cause: since 1.13 the task view (`taskedit::next_line`) writes the series' day into the rule; the
  editor (`recurTasks.ts`) and the phone's note view (`withNextOccurrence`) add the next occurrence themselves
  and asked the core only for the date (`task_next_due`).
- Fix: `taskedit::next_occurrence_of` (command `task_next`) returns the date and, when the rule has to keep its
  day, the rule as written and the rule to write; both editors replace it. The core's rule for this
  (`pinned_rule`) is shared with the task view.
- Tests: `taskedit::tests::the_editors_get_the_rule_of_the_next_occurrence_as_the_task_view_writes_it` (applied
  to the line, it equals the task view's line); `recurTasks.test.ts`, `mobile/model.test.ts`; e2e
  `450-work-numbers` test 3.

### H3-4 An overdue monthly task from the 31st skips to the 28th (high)

- Symptom: a task `every:monthly due:2026-01-31` ticked off on 3 November (anywhere) got the next due date
  28 November instead of 30 November; a yearly task from 29 February ticked off years later landed on the 28th
  of a leap year. The repeat dialog's preview showed 28 Feb, 28 Mar, 28 Apr for a rule that, once written,
  gives 28 Feb, 31 Mar, 30 Apr.
- Root cause: `Recurrence::next_due` skipped the past occurrences with the rule as written; each step took the
  day of the previous (clamped) date. The day was kept only for the rule written into the next occurrence.
- Fix: `next_due` steps with the pinned rule (`Recurrence::pinned`) of its base date; the preview carries the
  pinned rule from one occurrence to the next.
- Tests: `recurrence::tests::a_series_from_the_31st_keeps_its_day_while_skipping_past_dates`.

### Low (listed, not fixed in this round)

- H3-L1: `ZoneRules::to_utc` (a time zone defined only by a `VTIMEZONE`, e.g. Outlook's „(UTC+01:00)
  Amsterdam, …“) takes a time in the skipped hour (02:30 on 29 March) as 01:30, an hour before the gap; the
  IANA zones take it after the gap. Appointments at that hour are very rare.
- H3-L2: an ICS `DURATION` in days (`P1D`) on a timed appointment is added as 24 hours; over a clock change the
  appointment ends an hour early or late (RFC 5545 counts nominal days).
- H3-L3: the entry dialog's duration accepts `1:75` as 2 h 15 min (`parseDurationInput` does not check the
  minutes), while `/zeit` refuses it.
- H3-L4: the week review's table counts today's full target in the day's and the week's difference while the
  day is still running (−8 h at 9:00); the balance counts today only once its target is reached.
- H3-L5: the day and week review's „missing“ leave a running timer out, while the balance and the charts
  count its minutes so far.
- H3-L6: a running timer's total is cut to whole minutes, its booking rounds the seconds (29 min shown, 30 min
  booked after 29:40).

## Tests added

- Rust: `tracking` (clock change spans), `calendar` (day targets), `taskedit` (next occurrence for the
  editors), `recurrence` (pinned skipping and preview).
- UI: `calendar.test.ts`, `recurTasks.test.ts`, `mobile/model.test.ts` (and the existing mobile note tests on
  the new command).
- e2e: `450-work-numbers.test.js` (Europe/Berlin).
