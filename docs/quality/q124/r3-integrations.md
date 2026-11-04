# q124 round 3, hunt D: integrations and numbers

Areas H3 (Jira, calendar feeds, time tracking and its exports) and H7 (the phone's numbers) of the
[plan](plan.md), from a property-based angle: generators of random cases and invariants checked against a
reference, instead of single examples. Branch `q124-r3d`. The fixes of [h3-work.md](h3-work.md) and
[r2-work-phone.md](r2-work-phone.md) still hold (their tests pass, and the generators below cover the same
ground: clock-change spans, day targets, target changes, the 29th to 31st, worklog edits while posting).

The generators use a small seeded random generator (`crates/arcalo-core/src/testrng.rs`): each case names its
seed, so a failure can be run again.

Severity as in the plan; wrong numbers and lost or duplicated worklogs count as high.

## Findings

### R3D-1 An edit made while other worklogs are being sent is lost in Jira (high)

- Symptom: after a batch of bookings with an issue key (a week proposal taken over, the app back online after a
  day offline), the runner sends their worklogs one after the other. A booking corrected while the ones before
  it were on their way (each up to the request's timeout) reached Jira with the old hours and was shown as sent
  („gebucht“); nothing sent the correction.
- Root cause: `jira::post_worklogs` read the due worklogs with their values once (`worklogs_due`) and posted
  those values after `worklog_claim`; an edit of a booking that was still `pending` changed nothing in its link,
  so the stale values were posted and the link became `posted`.
- Fix: `Database::worklog_claim` returns the worklog with the booking as it is at the claim (in the same
  connection as every edit), and the runner sends that.
- Test: `issues::tests::worklog_sync_never_posts_twice_or_loses_an_edit` (edits between listing and claim).

### R3D-2 A post whose answer was lost is posted a second time after an edit or a quit (high)

- Symptom: a worklog post that reached Jira but whose answer was lost (a timeout on a slow Server, the app quit
  during the post) was posted again, leaving two worklogs with the hours twice: when the booking was edited
  before the retry (the retry looked for a worklog with the new start or length, found none), when the booking
  was edited during the post and the app was then quit (the edit reset the retry count, so the next run posted
  without looking), and when an update of a worklog Jira had removed turned into a new post whose answer was
  lost (the next run updated the old id again, got 404 and posted once more). A worklog found by a retry but
  whose update then failed after Jira took it was not found again by the values it had before.
- Root cause: the retry looked for its worklog only by the booking's current values and only when
  `attempts > 0` or the state was `posting`; what a try had sent was not kept, and an edit cleared the signs
  that a try had happened.
- Fix: migration `0042_worklog_sent`: before a new worklog is posted, its start and length are kept
  (`sent_started`, `sent_minutes`) until Jira confirms it (`Database::worklog_record`, `Sending::Post`). Any
  worklog with such a record is a retry (`PendingWorklog::retry`), and the retry looks on the issue by the
  booking's values and by the sent ones. A worklog found is taken with its id kept first (`Sending::Found`),
  then updated with the booking's values (its comment included). The runner's logic moved into the core
  (`issues::send_worklog`, `issues::delete_worklog`), so the property test runs the same code as the app.
- Test: `issues::tests::worklog_sync_never_posts_twice_or_loses_an_edit`: 200 random sequences of bookings,
  edits (start, length, comment), deletions and restores, at random points also while a request is on its way
  and with the app quitting before or after a request; Jira fails 10 to 60 % of the calls, half of them after
  taking effect. Once Jira answers again, Jira has exactly one worklog per booking with its start, length and
  comment, and each booking knows its own.

### R3D-3 A booking deleted before Jira confirmed its worklog leaves that worklog in Jira (high)

- Symptom: a booking whose worklog post had timed out (stored in Jira, the answer lost), deleted before the
  retry, or deleted while its post was on its way and that post then failed after storing, left its worklog in
  Jira: the hours stayed booked on the issue for work that no longer existed.
- Root cause: deleting queued a worklog deletion only by a known worklog id; a post without a confirmed id had
  none, and a failed post of a deleted booking was simply dropped.
- Fix: such a deletion is queued without an id and with the sent values (`jira_worklog_deletes.worklog_id = ''`,
  `Database::worklog_queue_lookup_delete`, from `delete_booking` and from `worklog_failed` of a deleted
  booking); `issues::delete_worklog` looks the worklog up on the issue and removes it if Jira has it. A booking
  that comes back cancels it (`issue_relink`).
- Test: the property test above (deletions during and after unconfirmed posts).

### R3D-4 Two equal bookings on one issue could share one worklog (high)

- Symptom: two bookings on the same issue with the same start and length (`/zeit 30m PROJ-5 …` twice in a
  minute, or two bookings edited to the same slot), one of them retried after a failed post, took the other's
  worklog as its own: Jira had one worklog for two bookings, the hours of one were missing, and deleting either
  removed the other's hours.
- Root cause: `matching_worklog` took the first worklog with that start and length by the user, also one that
  belonged to another booking or to a deleted one queued for removal.
- Fix: the worklogs of the other bookings on the issue, of deleted ones and of those queued for deletion are
  never taken (`PendingWorklog::taken`, `matching_free_worklog`).
- Test: the property test above (bookings start on a few slots and have few lengths, so equal ones happen).

### R3D-5 On an issue with more than one page of worklogs a retry posts again (high)

- Symptom: on an issue many people book on (meetings, support; Jira Cloud gives at most 5000 worklogs per
  request), a retry of an unconfirmed post did not see the newest worklogs, which come last, and posted the
  worklog again.
- Root cause: `JiraClient::worklogs` read only the first page of `GET issue/{key}/worklog`.
- Fix: all pages are read (`worklog_page_next`: `startAt` plus the page's length while below `total`).
- Test: `issues::tests::the_worklogs_of_a_busy_issue_are_read_to_the_last_page`.

### R3D-6 Logging work in the issue view books twice after an error (high)

- Symptom: in the issue view („Arbeit protokollieren“ with „Auch in der Zeiterfassung buchen“), when Jira did
  not answer the refresh of the view after the booking (offline, a timeout, a 5xx), or the worklog post failed
  on a site that does not post bookings' worklogs, the form showed „Arbeit nicht protokolliert“ with the input
  kept, although the booking was made (and its worklog queued). Trying again, as the message invites, made a
  second booking and, once online, a second worklog.
- Root cause: `jira_full_worklog_add` booked first and then returned any later error; the reading of the view
  could fail after everything was done.
- Fix: on a site that does not post bookings' worklogs the worklog is posted first and the booking made only
  after it (a failed post books nothing); once the work is logged, a view that cannot be read falls back to the
  last copy with the error („Stand von …“), as opening the view does.
- Test: covered by the e2e Jira tests of the issue view (118, 105) for the paths that succeed; the order is in
  the command's code. Low-level parts: the property test above.

### R3D-7 A yearly task on a day of its month skips the date still ahead (medium)

- Symptom: `- [ ] Beitrag every:yearly,15 due:2026-01-10` got 15 January 2027 as its next date (and the
  repeat dialog's preview started there), skipping 15 January 2026; `monthly,15` from the 10th gives the 15th
  of the same month.
- Root cause: `Recurrence::step` checked for a day still ahead in the month only for monthly rules.
- Fix: monthly and yearly rules with a day take that day of the base's month first.
- Test: `recurrence::tests::random_rules_follow_their_definition`: 3000 random rules (days, weeks, weekdays,
  months and years with intervals and days, `until`), due dates and days of ticking off, against a brute-force
  expansion of the rule's definition: the next date is the first occurrence after the day it was done (none
  skipped, never back in time), the end is kept, and the preview equals ticking off one after the other.

### Low (listed, not fixed in this round)

- R3D-L1: booking ids are reused: after the newest booking is deleted, the next one takes its id. Bringing back
  an older deleted chip with that id („Erneut buchen“, undo after the next booking was also deleted) takes the
  newer booking's kept Jira link. Very rare; the property test leaves this case out.
- R3D-L2: the CSV export's `hours` column is rounded per row (three bookings of 20 minutes are 0.33 each, 0.99
  together) while CATS rounds per day (1.00); `duration_minutes` is exact.
- R3D-L3: an all-day series whose `UNTIL` is a UTC date-time (not conforming, DATE is required) compares the
  last day in UTC; in zones east of UTC its last day can be left out.
- R3D-L4: several `VEVENT`s with the same `UID` and no `RECURRENCE-ID` (broken feeds) keep only the last one.
- R3D-L5: `RDATE;VALUE=PERIOD` is not read.

## Looked at, no finding

- Numbers: `worktime::tests::every_view_counts_the_same_minutes`: random bookings over four weeks around a clock
  change in Europe/Berlin (up to 10 h, over midnight, at the skipped and the repeated hour), absences of each
  kind, half days, holidays (BY) and a target change from R2C-2: the bookings by local day equal
  `booked_by_day`, the day review of each day (bookings and target), the week review of each week (bookings and
  targets), the balance (booked, target, minutes), the phone's „Heute“ (day and week), the CSV and JSON totals
  and the CATS hours per day (the rounded day total). Also run with `TZ=Europe/Berlin` and
  `TZ=America/New_York`.
- ICS: `calsync::ics::tests::random_series_match_a_brute_force_expansion`: 400 random series (daily, weekly on
  chosen days, monthly with and without a day; INTERVAL, COUNT, UNTIL; Berlin, New York, UTC, an Outlook
  `VTIMEZONE` without a known name, floating, all day), with EXDATEs, moved and cancelled instances, in random
  windows, against an expansion written from RFC 5545: every occurrence once, at the right instant, none more.
- Jira errors: 401 (Cloud and Server wording), 403, 404, 429 and 503 with `Retry-After`, timeouts and proxy
  errors say what to do; the create-issue dialog and the worklog form keep their input on an error.
- Timesheet sums in the UI (`TimesheetView`, `catsGrid`, `weekGaps`) group by the local day of the start like
  the core.

## Tests added

- Rust: `issues::tests` (worklog sync property test, worklog paging), `recurrence::tests` (random rules),
  `calsync::ics::tests` (random series), `worktime::tests` (every view counts the same minutes);
  `testrng.rs` (seeded generator for the property tests).
