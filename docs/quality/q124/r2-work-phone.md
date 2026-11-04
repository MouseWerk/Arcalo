# q124 round 2, hunt C: work features (H3) and the phone app (H7)

Areas H3 and H7 of the [plan](plan.md). Branch `q124-r2c`. Round 1 of H3 ([h3-work.md](h3-work.md)) fixed the
clock change spans, the month calendar's day targets and the monthly tasks from the 29th to 31st; its tests
(`tracking`, `calendar`, `taskedit`, `recurrence`, e2e `450-work-numbers`) still pass, so this round looked
elsewhere: the Jira worklog sync while bookings change, the balance over months with a changed target, the
exports' columns and texts, the ICS expansion, the budgets, the status report, and the phone's numbers against
the desktop's and against its own other tab.

Severity as in the plan; wrong numbers count as high.

## Findings

### R2C-1 A booking edited while its Jira worklog is being sent keeps the old hours in Jira (high)

- Symptom: `/zeit NP-8801/1020 45m PROJ-5 Review` posts a worklog right after the booking. Corrected to 60 min
  in the timesheet while that post was on its way (a second on Jira Cloud, up to the request's timeout on a slow
  Server), Jira kept 45 min and the timesheet showed the worklog as sent („gebucht“); nothing sent it again. The
  same for an edit during the update of a worklog posted earlier. Jira's hours (and every report built on them)
  stayed wrong without a sign.
- Root cause: an edit marks the worklog for an update only when it has a worklog id (`worklog_changed`,
  `booking_edited` via `entry_worklog`); during the first post there is none yet, so the edit was ignored. And
  `worklog_posted` set the state to `posted` unconditionally, overwriting the `pending` an edit during an update
  had set.
- Fix: an edit during a post (`worklog_state = 'posting'`) marks the worklog pending as well
  (`entry_worklog_site`, `worklog_changed`); `worklog_posted` records the id but keeps `pending` when an edit
  came in meanwhile, so the runner (which runs again when kicked while busy) updates the worklog with the new
  values.
- Test: `issues::tests::an_edit_while_its_worklog_is_being_posted_reaches_jira` (first post and update).

### R2C-2 Changing the target rewrites the balance of every past month (high)

- Symptom: someone booking exactly 8 h a day from January to March changes the daily target to 6 h on 1 April
  (Settings → Zeiterfassung, or „Soll je Wochentag“). The Gleitzeitsaldo jumped from 0 to +124 h: every past day
  was counted against 6 h. The week and day review, the timesheet's targets, the month calendar and the phone's
  „Heute“ of past days changed the same way; going from 6 h to 8 h made the past a deficit. Only setting a new
  „Stichtag“ with a hand-computed „Anfangssaldo“ avoided it.
- Root cause: `worktime::weekday_minutes` took the current settings for every day; the settings had no notion
  of when a target applied.
- Fix: `time.balance.target_history` keeps the target per weekday that applied up to each change
  (`TargetPeriod { until, minutes }`); `weekday_minutes` takes the period of the day, so every view (they all go
  through it, `DayTargets`, `balance`, the vacation account) keeps the past as it was. A save records the change
  (`record_target_change`, called by the settings page's save and `arcalo settings set`): the days up to
  yesterday keep the old target; a second change the same day (or its undo) keeps the target of before the first;
  the first setup and a workspace with nothing booked before today record nothing (`keeps_past`: the target is
  set, not changed; the e2e tests that set targets before booking keep working, `152-time-quality`, which books
  first, applies them to every day as a user would). The settings page cannot add to the
  history; it shows the last earlier target („Früheres Soll: Bis 31.03.2026 galten 40,00 h pro Woche …“) with
  „Für alle Tage übernehmen“ for a target that was simply wrong. Settings step 19 → 20 (`target-history`).
- Tests: `worktime::tests::a_changed_target_counts_from_its_day_and_past_months_keep_theirs` (January to March in
  Bavaria, the balance before and after, DayTargets, a second change, a later one, clearing, the setup,
  normalizing); `settings_migrate::tests::a_stored_target_applies_to_every_day_until_it_changes`; e2e
  `475-work-target-change` (the real app: last week keeps 8 h, next week 6 h, a draft cannot add periods, the
  settings row and its button).

### R2C-3 The phone's „Heute“ counts the week from Monday when the week starts on Sunday (medium)

- Symptom: with Settings → Zeiterfassung → „Woche beginnt am“ Sonntag, on a Sunday „Heute“ on the phone showed
  „Diese Woche“ as the whole Monday-to-Sunday (the past working week), while the „Zeit“ tab listed only that
  Sunday's bookings as this week; the two numbers on the same phone disagreed every Sunday to Saturday.
- Root cause: `companion::today` summed from the Monday of the day; the „Zeit“ tab (`weekEntries`) and the
  desktop use the setting.
- Fix: `companion::today` starts the week on the day the settings say.
- Test: `companion::tests::the_week_on_today_starts_on_the_day_the_settings_say`.

### Low (listed, not fixed in this round)

- R2C-L1: an edited booking is not rounded (Settings → Zeiterfassung → Rundung) while a new one from the same
  dialog is; 0:50 stays 0:50 after an edit, 1:00 when booked new with 15 minutes up.
- R2C-L2: SAP CATS's LTXA1 keeps the spreadsheet guard: a text starting with `-`, `+`, `=` or `@` gets a leading
  `'` in the upload (and is then 41 characters when it was cut to 40).
- R2C-L3: the Jira burn-down counts an issue resolved between local midnight and 01:00/02:00 (UTC still the day
  before) as resolved the day before.
- R2C-L4: a timer run over midnight is rounded per day: 23:59–00:01 with 15 minutes up books 2 × 15 minutes.
- R2C-L5: the status report's „Diese Woche“ is always the ISO week (Monday to Sunday), also with the week set to
  start on Sunday (its title is „KW n“, which is Monday-based).

## Looked at, no finding

- Exports: CATS with every delimiter, column preset and decimal setting, texts with the delimiter, quotes and
  line breaks; CSV and JSON with commas, quotes and newlines; Jira `started` and seconds; per-day rounding of
  CATS hours and the timesheet's CATS grid agree.
- Worklogs: retry adopts an interrupted post (`matching_worklog`, Server and Cloud account ids alike), deleted
  bookings and deleted worklogs (404 posts anew), a booking restored by undo.
- ICS: RRULE expansion (rrule crate) with zones, UNTIL in UTC and as a date, EXDATE in other zones and as dates,
  RECURRENCE-ID overrides moved into and out of the window, cancelled masters and instances, events without end.
- Budgets: Projekte (one grouped query) and the alerts (one query per Netzplan) count the same, Vorgänge matched
  without case.
- Phone: „Heute“'s day target is the desktop's (`gap_target`), the running timer counts like the desktop's; due
  tasks include today; the capture's task lines and due dates.

## Tests added

- Rust: `issues::tests` (worklog edits while sending), `worktime::tests` (target change), `settings_migrate`
  (step 19 → 20), `companion::tests` (week start on the phone).
- e2e: `475-work-target-change.test.js` (Europe/Berlin).
