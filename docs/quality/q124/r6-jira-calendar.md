# q124 round 6, hunt C: Jira and calendar end to end

Every Jira and calendar flow gone through as a user would, against the fake servers, looking for what the earlier
rounds did not test (their findings in `q123/jira.md`, `r2-work-phone.md`, `r3-integrations.md` and
`r4-failure-paths.md` are fixed and were not hunted again): issues moved between projects and deleted, the issue
view's custom fields, rich text and estimates, attachments, worklogs logged in the view, sprints, Server and
Cloud, two sites; calendar feeds written by Outlook and Exchange, all-day and multi-day appointments, bookings and
meeting notes from appointments. Branch `q124-r6c`.

`fake-jira.js` learned `move(key, project)` (the issue gets the next key there; the old key still finds it, as in
Jira) and `remove(key)`; like Jira, a `key in (…)` naming a key it does not know now fails as a whole (400).

## Findings

### R6C-1 An issue moved to another project drops out of the Issues list, and its old key stays stale (high)

- Symptom: after `PROJ-123` was moved to `NEW-2` in Jira (still assigned to me), every sync dropped it from „Meine
  Issues“, the widgets and the count. Notes, tasks and bookings still name `PROJ-123`: its chip kept the old status
  for good, and its task was never ticked when the issue was done.
- Root cause: the sync asks again for cached open issues no search found (`key in (PROJ-123, …)`); Jira answers a
  moved key with the issue under its new key. `fetch_site` put that answer over the copy the default search had
  found, clearing its searches (so the issue left every list), and nothing tied the old key to the new one: the old
  row stayed open, was asked for on every sync and never became done.
- Fix: a refreshed issue never replaces one a search found; a cached key Jira does not answer under its own key is
  asked for alone (`GET issue/{key}`), and one that answers under another key is recorded as moved (migration
  `0043_issue_moved.sql`, `Database::issue_moved_record`, also when the hover card loads an old key). The old key
  then resolves to the issue under its new key (`issue_get`, the chip index, the hover card shows the new key, the
  issue's booked hours count bookings under both keys), its project stays a chip project, and its tasks are ticked
  with the issue.
- Tests: `issues::tests::moved_and_deleted_issues_are_followed_by_their_old_keys`, `jira.test.ts` („moved
  issues“), e2e `682-jira-moved-issues` (list, tasks, issue view, chip and card of the old key).

### R6C-2 One deleted issue stops the refresh of up to 49 other cached issues (medium)

- Symptom: once an issue in the cache was deleted in Jira (or its permission withdrawn), other cached issues no
  search finds any more (reassigned, done) stayed as they were: their status never changed, and their tasks were
  never ticked when they were done.
- Root cause: they are asked for in chunks of 50 with `key in (…)`; Jira refuses the whole query when one key does
  not exist, and the error was ignored for the whole chunk, on every sync.
- Fix: the keys of a refused or incomplete chunk are asked for one by one (at most 100 per sync); a 404 removes the
  deleted issue from the cache, so the next `key in (…)` works again.
- Tests: the same Rust test and e2e 682 (OPS-7 is done and ticked although PROJ-125 was deleted; the next sync asks
  for none of them again).

### R6C-3 Logging work in the issue view with a booking reads the comment as a command; trying again posts twice (high)

- Symptom: „Arbeit protokollieren“ with „Auch in der Zeiterfassung buchen“ booked the comment as part of a
  `/zeit` line: `Fix #2` set the Leistungsart `2` (or failed: unknown), `mit @Tom` failed as a date, `@14:00` moved
  the booking's start, two quoted words failed. On a site that does not send bookings' worklogs, the worklog was
  posted first and the booking failed after it: the view said it failed, kept the input, and „Arbeit
  protokollieren“ again posted a second worklog. The same after the post for every other booking error (no WBS, a
  Leistungsart that no longer exists).
- Root cause: `jira_full_worklog_add` built `/zeit {minutes}m {key} {comment}` and booked it with the command
  parser, after the post.
- Fix: `tracking::log_slash_command_as` books the comment as text; the view books first and then posts, and a post
  that fails takes the booking back.
- Tests: `issues::tests::a_worklog_comment_booked_along_stays_text`, e2e 682 (a failed post books nothing; then one
  booking with the comment as its text, no Leistungsart, the given start, and one worklog it knows).

### R6C-4 The Sprint widget counts at most the first 50 issues of a sprint (medium)

- Symptom: for a sprint with more than 50 issues the widget's numbers and its burndown were too low.
- Root cause: `sprint/{id}/issue` was read once with `maxResults=200`; Jira's Agile API gives at most 50 per
  request.
- Fix: the issues are read page by page (`startAt`, `total`), up to 2000.
- Test: `issues::tests::the_sprint_reads_every_page_of_its_issues` (120 issues, 50 per page).

### R6C-5 An all-day appointment written by Outlook with times is a 24-hour meeting (medium)

- Symptom: Exchange and Outlook may write an all-day appointment as midnight to midnight with times
  (`DTSTART;TZID=W. Europe Standard Time:20261030T000000`), marked all day only by `X-MICROSOFT-CDO-ALLDAYEVENT`.
  The day review counted 24 hours of meetings, the week proposal offered to book it, the booking dialog proposed
  24 hours and the meeting note said „00:00–00:00“.
- Root cause: `ics::parse` knew all-day appointments only by `VALUE=DATE`.
- Fix: with Outlook's all-day property, a start and end at midnight (in their zone, or a UTC time at local
  midnight) are dates; a series of them (with EXDATEs given as times) is an all-day series.
- Test: `calsync::ics::tests::outlook_all_day_appointments_written_with_times_are_all_day` (four days over the end
  of October, in UTC, a weekly series with an excluded day, a timed one from midnight that stays timed).

### R6C-6 Estimates are sent to Jira as typed, also where Jira reads them differently (medium)

- Symptom: the issue view accepts estimates like `2t` (Tage), `1,5h` and `90` (minutes), as the worklog form does;
  Jira refused the first two („Invalid time duration“) and reads a number without unit in its own default unit,
  which a company may have set to hours (90 hours).
- Root cause: `write_value` checked the text with the app's reader and then sent the text unchanged.
- Fix: `view::jira_duration` writes what the app read in Jira's words (`2d`, `1.5h`, `90m`, `1h 30m`).
- Test: `issues::view_tests::estimates_are_edited_as_jira_words_them`.

### R6C-7 Attachments of the same name overwrite each other; one still open cannot be opened again (medium)

- Symptom: opening an attachment saves a copy in `jira-files/<site>/<name>` and opens it. Two attachments named
  alike (`image.png`, `report.xlsx` of two issues) overwrote each other; on Windows an attachment still open in its
  app (Excel and Word lock the file) failed to open a second time, and so did any other one of the same name
  („ließ sich nicht speichern“).
- Fix: a folder per attachment (named from its address), and a copy whose bytes are already there is not written
  again; old copies are removed with the folders they leave empty.
- Test: `issueview::tests::attachments_of_the_same_name_get_their_own_folder`.

### R6C-8 A date in a Cloud description is lost in the list and the hover card (low, fixed)

- `adf_to_text` read a `date` node's text, which it does not have (only a timestamp): „Fällig am “ with nothing
  after it in the Issues list's excerpt and the hover card, and the editor labeled the kept node „date“. Now the
  day (`2026-11-05`). Test: `issues::tests::bodies_and_accounts`.

### Low (listed, not fixed in this round)

- R6C-L1: an estimate cannot be removed in the issue view: both fields empty is refused, one empty keeps Jira's
  value.
- R6C-L2: a board with parallel active sprints: the Sprint widget shows the first.
- R6C-L3: two sites with the same project key (a move from Server to Cloud with both connected): chips, the issue
  view and worklogs take the cached issue of the site whose id sorts first.
- R6C-L4: the timesheet's issue chip of a booking made before its issue was moved shows the old key (the worklog
  reaches the moved issue: Jira takes old keys).
- R6C-L5: saving a description drops an emoji's `id` (a custom emoji shows as its short name in Jira) and a table's
  `layout` and `width` (it falls back to the default width).
- R6C-L6: the meeting note of a single appointment moved to another day keeps the old date in its properties.
- R6C-L7: work logged in the issue view from 23:30 for an hour is booked from 00:00 (the booking's start is clamped
  to the day the work ended).
- R6C-L8: work logged directly from the issue view (no booking) whose answer is lost (a timeout after Jira took
  it): trying again posts a second worklog; bookings' worklogs are found again (R3D-2), these are not.

## Looked at, no finding

- Jira: custom fields of every schema type in display and edit (select, multi-select, cascading, user, users,
  labels, number, date, date-time, URL, text area, read-only), editmeta-less fields, ADF round trip of every node
  type (tables with spans, panels, mentions, emoji, media single and group, code with language, expand, status,
  date, inline cards, decisions), wiki markup on Server, links, sub-tasks, parents and epics, worklogs of Server
  and Cloud accounts, PAT and API token, a context path on Server, two sites side by side (searches, chips, the
  worklog runner per site, removing one site).
- Calendar: Outlook's Windows zone names with and without `VTIMEZONE`, recurring meetings moved and cancelled
  (keys by the original instance, so bookings, notes and „nicht buchen“ stay with them), the week view's
  side-by-side layout and the all-day row, multi-day appointments over a month's end in the month grid,
  bookings from an appointment (prefill, WBS hint, the link), meeting notes and prep pages.

## Tests added

- Rust: `issues::tests::moved_and_deleted_issues_are_followed_by_their_old_keys`,
  `a_worklog_comment_booked_along_stays_text`, `the_sprint_reads_every_page_of_its_issues`,
  `bodies_and_accounts` (date node); `issues::view_tests::estimates_are_edited_as_jira_words_them`;
  `calsync::ics::tests::outlook_all_day_appointments_written_with_times_are_all_day`;
  `issueview::tests::attachments_of_the_same_name_get_their_own_folder`.
- UI: `jira.test.ts` („moved issues“).
- e2e: `682-jira-moved-issues.test.js`.
