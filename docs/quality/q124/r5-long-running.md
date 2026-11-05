# q124 round 5, hunt A: the app running for a long time, and time passing while it runs

Most tests start a fresh app and finish within minutes. This hunt looks at a window that stays open for days (in
the tray overnight): the date changing at midnight while views are open, the computer sleeping and waking up,
the scheduled jobs under a long uptime, and what hours of opening and closing notes and views leave behind.
Branch `q124-r5a`. Severity as in the [plan](plan.md).

How the app gets its clock: there is no test clock. The core reads `Local::now()` / `Utc::now()` where it needs
them and keeps the decisions in pure functions that take `now` (`backup::daily_due`, `briefing::new_day_check`,
`desktop::end_of_day_reminder`, `late_timer_reminder`, `dayreview::review_reminder`, …), which the Rust tests
drive with fixed times; the reminders have a test seam that runs them minutes ahead (`notify_test` `tick`). The
window computes „today“ from `new Date()`. For the e2e tests this hunt adds `e2e/lib/clock.js`:
`shiftWindowClock(app, ms)` puts the window's `Date` ahead of the real time (timers keep their pace, the core
keeps the real time), which is what a window left open overnight sees.

## Findings

### R5A-1 „Heute“ in the sidebar kept yesterday's hours after midnight (medium, fixed)

- Symptom: with the window open over midnight, the sidebar's „Heute 7,5 h“ (the hours booked today) still showed
  the day before the next morning, until a booking changed; only a restart or a new booking brought it to zero.
- Root cause: `TodayHours` (`components/Sidebar.tsx`) took the start of the day when it loaded and loaded again
  only when the entries changed.
- Fix: `lib/today.ts`, one check of the local day for the whole window (every 15 s while a view listens, and at
  once when the window is shown again or gets the focus, as after the computer woke up); `useToday()` re-renders
  on a new day. `TodayHours` loads for that day.
- Tests: e2e 660 („the views open in the evening show the new day the next morning“), `today.test.ts`.

### R5A-2 Task list, queries in notes and the Zeiterfassung stayed on the day they were opened (medium, fixed)

- Symptom: views kept open in a tab or a pane overnight showed the day before: the task list kept a task due
  yesterday under „Heute“ instead of „Überfällig“, a ```` ```query ```` block in an open note with
  `fällig: heute` (or `überfällig`, or a time range) still listed yesterday's result, and the Zeiterfassung
  marked yesterday as today and counted its gaps up to yesterday. The start page had its own check (once a
  minute), the other views none.
- Root cause: the task groups were computed only when the list changed, the query block ran again only on data
  events, and the other views read the date only when something else re-rendered them.
- Fix: the task list, the query block (runs again on a new day), the Zeiterfassung, the Tagesrückblick and
  Wochenrückblick (their „today“ and „this week“), the issues view, the table and board views of collections and
  the start page read the day from `useToday()`; the start page's own minute check is gone.
- Tests: e2e 660 (both tests: task list and query in split panes left untouched, the Zeiterfassung left open).

## Checked without a medium or high finding

- A long session (e2e 661): six rounds of opening six notes in tabs, the task list, Kalender, Zeiterfassung,
  Aktivität, Einstellungen and the start page, the palette, and closing everything again, after two warm-up
  rounds. Listeners on the window and the document, the handlers of the core's events (`window.__arcaloHandlers`
  under WebDriver), the core's event listeners, running intervals and DOM nodes came back to the same counts;
  the app process's memory stayed within 1 MB (274 MB).
- Scheduled jobs: the calendar refresh and the Jira sync are due by the time of their last attempt (wall clock),
  so after the computer slept each runs once when it wakes up, not once per missed interval; the backup is due
  by the age of the newest backup and the hourly Git sync runs in the same loop, catching up once within an hour
  of waking up; every request of these jobs has a total timeout (Jira, ICS, Git), so a stalled connection after
  waking up ends in an error the next round retries. Snoozed reminders that fell due during sleep come back
  once; the briefing's new-day check, the day review, the end-of-day and the late-timer reminders are once a
  day by stored day. In-memory logs (`rag` change log, held notifications, shown notifications, redaction
  secrets) are bounded.
- DST while open: the window's timer and the core's worked minutes count elapsed time, the day check and the
  task groups compare local dates (a clock change does not change the day, `today.test.ts`).

## Low (listed, not fixed)

- R5A-3 Kalender: left open on today's day or week over midnight it stays on the day shown (without the now line)
  until „Heute“; a Kalender tab opened again on a later day starts at the day last navigated to in this session
  (`session.anchor`), not at today.
- R5A-4 The start page's „Nächster Termin“ widget re-renders every second also while its tab is hidden or the
  window is in the tray (CPU only; the sidebar's timer tick stops while hidden).
- R5A-5 Focus sessions: the daily note's focus line is written between the evening time and midnight while the
  app runs; a day whose evening the computer slept through gets no line.
- R5A-6 Automatic meeting preparation remembers each meeting it tried (`TRIED`, for the session) and stores a
  `prep.auto.<key>` row per meeting for good; both grow by one per meeting.
- R5A-7 The end-of-day reminder counts a timer running since the day before fully as today's hours, so the
  reminder is not shown that day (the late-timer reminder reports the timer).
- R5A-8 The app lock's „after sleep“ is a gap of more than 90 s between two ticks of the sampler thread, which
  also runs the reminders; a reminder pass that waited more than 85 s (for the database during a long backup)
  would lock the app as after sleep. Not observed.
