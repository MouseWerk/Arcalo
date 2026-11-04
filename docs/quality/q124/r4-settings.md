# q124 round 4, hunt D: behaviour under settings other than the defaults

Most tests run with the defaults: German, weeks from Monday, German dates and numbers, a time zone near
Central Europe at about 9:00 in the morning. This hunt runs the app with the other choices the settings offer and
with real time zones far from UTC: English with US and British dates, weeks from Sunday, hours as clock time, a
15-minute rounding, workdays Sunday to Thursday, an empty workspace instead of the demo, America/Los_Angeles
(UTC-8/-7) and Pacific/Kiritimati (UTC+14). Branch `q124-r4d`. Severity as in the [plan](plan.md); wrong dates
and numbers count as high.

## Findings

### R4D-1 West of UTC every due date showed the day before (high, fixed)

- Symptom: with the computer in a time zone west of UTC (all of the Americas), a task due on 4 November showed
  „11/03/2026“ as its due date in the morning briefing's overdue list; Jira due dates in the issues view, the
  issue preview, the start page's Jira widget and the briefing, the action items and follow-up date of a
  meeting's work, a sprint's end and the other days the backend sends as `YYYY-MM-DD` were one day early.
- Root cause: `fmtDate`, `dateShort`, `dateLong` and `relative` (`ui/src/lib/format.ts`) and the start page's
  `fmt` read a string with `new Date(s)`, and JavaScript reads a bare `2026-11-04` as midnight UTC, which is the
  evening before west of UTC. Callers that passed `${day}T12:00:00` were right; the others were not.
- Fix: `toDate` reads a bare day as that local day (at noon) and a timestamp as before; every formatter and the
  start page's `fmt` go through it, so no caller has to remember the noon suffix.
- Tests: `format.test.ts` „days west and east of UTC“ (four zones from UTC-10 to UTC+14), e2e 640 („an overdue
  task shows its own due date“, America/Los_Angeles, US dates).

### R4D-2 `/time` refused dates written with slashes (medium, fixed)

- Symptom: with US dates, `/time NP-8801/1020 1h Review @11/04/2026` was refused („Invalid date“), and so was
  `@04/11/2026` with British dates: the booking line took only `@2026-11-04`, `@04.11.2026` and `@04.11.`,
  although every date field of the app accepts the slash notation of the date format.
- Root cause: `zeit::parse_date` knew only the German and the ISO notation, and the backend did not know the
  date format of the settings.
- Fix: `i18n::set_date_format` (set with the language and the number format at start, on every settings save,
  in the CLI and on the phone) and `i18n::month_first`; `parse_date` reads `d/m/y`, `d/m/yy` and `d/m` (the most
  recent such day), month first with the US date format, as `parseDayInput` in the UI does.
- Tests: `zeit::tests::dates_with_slashes_follow_the_date_format`, e2e 640 („/time takes a date in the US
  order“, „… British order“).

### R4D-3 With weeks from Sunday the start page and the status report counted weeks from Monday (high, fixed)

- Symptom: with Settings → Zeiterfassung → week start Sunday, the start page's „This week“ widget showed Monday
  to Sunday (on a Sunday the week that ended that day, so its total and gaps were not those of the timesheet's
  week), the month calendar widget started its rows on Monday, the focus and week proposal widgets and the
  assistant's suggestions looked at the Monday week, the start page's week number on a Sunday was the one before
  the timesheet's, and the status report's „This week“ / „Last week“ and the start page's query lists with
  range „week“ covered Monday to Sunday.
- Root cause: `partsOf` (`ui/src/lib/dashboard.ts`), the calendar widget and the suggestions asked for
  `weekStart(today, 1)` (Monday) instead of the settings' week start; in the core `meetwork::status::resolve`,
  `dashboard::query::range_days` and the suggestions computed the Monday themselves.
- Fix: the start page uses `weekStart(today)` and `monthGrid` with the settings' week start; the week number is
  `shownWeek` as in the timesheet and the calendar. The core has `WeekStart::first_day`, used by the status
  report (its label „KW n“ names the ISO week of the Monday of a week from Sunday), the query ranges and the
  suggestions.
- Tests: `dashboard.test.ts` „counts the week and the month from Sunday …“, `meetwork::tests::periods`, e2e 640
  („the start page's week and month start on Sunday“).

### R4D-4 The English week review wrote days month first for every date format (medium, fixed)

- Symptom: in English the weekly review and its saved report wrote days as „Mon 10/05“ also with British
  dates, where 10/05 reads as 10 May.
- Root cause: `weekreview::day_label` used `%m/%d` for English.
- Fix: day and month in the order of the date format (`10/05` US, `05/10` British, `10-05` ISO, `05.10.`
  German).
- Test: `weekreview::tests::english_days_follow_the_date_format`.

### R4D-5 The weekly report command named the week before on a Sunday (low, fixed)

- „Weekly report“ in the palette took the ISO week of today; with weeks from Sunday, on a Sunday that is the
  week before the one the report covers (from that Sunday). It now names `shownWeek` of the week's start.

## Low (listed, not fixed)

- English installs start with German dates (24.09.2026) until Settings → Language & Format is changed; the
  first run does not take the date format from the system.
- The daily note title „long“ is „Wednesday, 24.09.2026“ in English: the date part stays German whatever the
  date format.
- Voice note actions recognise due dates in German and ISO notation and weekday names; „11/04“ or „November 4“
  spoken in English is not taken as a date (the task is made without a due date).
- The assistant's system prompt in German names the weekday in English („Heute ist Wednesday, …“, chrono's
  `%A`); only the model reads it.
- The Markdown mirror's monthly time CSV has German headers and dates but follows the number format for the
  hours, so in English it mixes `24.09.2026` with `1.50`.
- Number fields in the settings (target per weekday, vacation days) show `7.5` with a point in German.
- Time chips in notes show decimal hours (`1,50 h`) also with „hours as clock time“.
- The week review and the weekly bookings chart stay ISO weeks (Monday to Sunday) with weeks from Sunday; this
  is documented for the review, the chart labels them with ISO week numbers.
- The status report counts a Jira issue as done in the period by the day in Jira's own time zone.

## Checked without findings

- An empty workspace (no demo) in English with British dates, weeks from Sunday, hours as clock time, a
  15-minute rounding up and workdays Sunday to Thursday at UTC+14: the start page, daily note, calendar,
  timesheet (Sunday first, gaps on Sunday to Wednesday, none on Friday and Saturday), tasks, projects and
  the daily review are English; a 7-minute booking is booked as 15 minutes on the local day; a booking on an
  unknown network is refused in English (e2e 641).
- `/time 2,5h` and `2.5h` in both languages, rounding up and to the nearest step, the minimum booking.
- Day and week computations of the core: every local day comes from the time zone passed in (no `date()` in
  SQL, no UTC dates); the UI builds week numbers from local date parts.
- All-day appointments of ICS feeds keep their day in every zone (placed by the feed's zone).

## Tests added

- e2e 640 `640-settings-regions.test.js`: America/Los_Angeles, English, US dates, weeks from Sunday.
- e2e 641 `641-english-empty-east.test.js`: Pacific/Kiritimati, English, empty workspace, other settings.
- Unit: `format.test.ts`, `dashboard.test.ts`, `zeit::tests::dates_with_slashes_follow_the_date_format`,
  `meetwork::tests::periods`, `weekreview::tests::english_days_follow_the_date_format`.
