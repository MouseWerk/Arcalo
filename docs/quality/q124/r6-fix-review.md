# q124 round 6, hunt D: review of the fixes of rounds 5 and 6

Round 5 (`10181bc1` to `e69a311d`) and round 6 hunt C (`719bac64` to `06cf1c4d`) merged 20 high and medium fixes.
This hunt reviews that range as code (`git diff 10181bc1 06cf1c4d -- crates src-tauri ui/src`), as round 5 hunt D
did for rounds 1 to 4: regressions a fix did not intend, two fixes that work against each other, paths a fix did not
reach, the error paths and the cost of the new code, migration `0043_issue_moved.sql`, and every changed assertion of
the tests. It also takes the open soak failure of e2e 37 (run 42465187284, 2026-11-08). Each suspected bug was first
shown by a failing test. Branch `q124-r6d`. Severity as in the [plan](plan.md).

## Findings

### R6D-1 A dropdown closed by itself when its trigger was moved by the page, not by the person (medium, fixed)

- Symptom: a dropdown opened while the content above it was still changing closed again at once. In the settings
  „KI & Modelle“ right after a provider was added, every provider is checked again: its status line switches
  between „Prüfe …“ and „Verbunden · 4 Modelle“, the row gets one line shorter or taller, and the tier dropdowns
  below move. The weekly soak of 2026-11-08 (run 42465187284, round 2) failed this way in `37-ai-providers` „tiers
  are assigned …“: „Anbieter für Lokales Modell did not open“, although R5D-4 had been meant to fix it. The failure
  screenshot shows the trigger centred in the settings' scroll area above its toast padding (130 px), where
  WebdriverIO's `waitForClickable` had scrolled it (`block: "center"`); its scroll is reported a frame later.
- Root cause: `Select` closed on any scroll of an area holding the trigger that found the trigger away from where
  the list was placed. R5D-4 made a scroll that did not move the trigger harmless, but a trigger moved by the page
  (content above changing height, without a scroll of its own) and then any scroll reported (the late one of the
  scroll into view, an area keeping its place) still closed the list. Only the person's own scrolling should close
  it; the other moves are the page's.
- Fix: the list closes when the person scrolls the area holding the trigger (a wheel or touch move in it within
  600 ms, kinetic scrolling included) or when the trigger leaves the visible part of the area; any other scroll
  places the list at the trigger again.
- Tests: `Select.test.ts` „follows the trigger through a scroll the person did not make, closes on one they make“
  (closed before the fix); e2e 681 „a dropdown follows its trigger when content above it changes, closes when the
  person scrolls“. The existing „closes on a scroll“ (the trigger scrolled out of view) and R5D-4's tests pass
  unchanged.

### R6D-2 Tasks naming a moved issue's old key were not ticked when the issue was done later (medium, fixed)

- Symptom: R6C-1 ticks the tasks written with the old key (`- [ ] PROJ-9 Docs`) when the sync that finds the move
  also finds the issue done. An issue moved while still open (the common case: moved first, finished later) and
  done in a later sync ticked only the tasks naming the new key; those naming the old key stayed open for good. The
  same when the issue view or the hover card found the move of an issue done meanwhile: the move was recorded and
  nothing ticked, and the next sync found the issue done already.
- Root cause: `issues_store` put only the issue's current key into `newly_done`; the old keys were added only in
  the sync that recorded the move. `put_fetched` (`jira_issue_fetch`, `jira_issue_detail`) stored the issue and
  the move without looking at its status.
- Fix: every key that becomes done brings its old keys (`issue_keys_of`) into `newly_done`; a single issue fetched
  on its own goes through `Database::issue_put_fetched`, which returns the keys to tick when it became done with
  that answer, and the command ticks them as the sync does (with „Erledigte Aufgaben abhaken“ on).
- Tests: `issues::tests::an_issue_done_after_its_move_ticks_the_tasks_of_its_old_key` (failed: `["NEW-6"]`
  instead of `["NEW-6", "PROJ-9"]`), `an_issue_fetched_alone_under_its_new_key_ticks_the_tasks_of_its_old_key`.

### R6D-3 A moved issue lost its note, part of its backlinks, its WBS and its booked hours (medium, fixed)

- Symptom: after `PROJ-9` moved to `NEW-6`, the issue view of `NEW-6` had no note („Notiz“ made a second page
  `NEW-6 …` next to the existing `PROJ-9 …` with `jira: PROJ-9`), listed none of the pages naming `PROJ-9`, showed
  „Gebucht“ without the bookings made under `PROJ-9` (the full view; the quick view counted them), and a booking on
  `NEW-6` no longer found the WBS learned or set for `PROJ-9`: `/zeit 1h NEW-6` asked for a reference again or
  booked on the new project's WBS.
- Root cause: R6C-1 made `issue_get` and the quick view's hours follow old keys; `issue_backlinks` (and with it
  `issue_note`), `issue_wbs_for` and the full view's hours (`issueview::view_of`) still asked for the one key.
- Fix: `Database::issue_aliases` gives an issue's keys (current first, from an old one too); the backlinks, the
  note, the WBS (own mappings of every key first, then the projects') and the booked minutes
  (`issue_booked_minutes`, used by both views) go over them. A note made from an old key is made for the current key.
- Tests: `issues::tests::a_moved_issue_keeps_its_note_backlinks_wbs_and_bookings` (failed: the note of `NEW-6`
  was `None`).

## Low findings (not fixed in this round)

- R6D-L1 Provider rows of „KI & Modelle“ change height while their status is checked again (the status line
  „Prüfe …“ is shorter than „Verbunden · 4 Modelle“ and the line with the address wraps differently): everything
  below jumps by a line, twice after every provider change. Harmless for dropdowns since R6D-1; a visible jitter.
- R6D-L2 `jira_full_worklog_add` takes the booking back when the post fails; a post Jira stored but whose answer
  was lost (a timeout) leaves the worklog without the booking, and trying again posts a second worklog.
- R6D-L3 A cached issue Jira answers with 404 is removed from `issues`, but its `issue_full` copy and the
  `issue_moved` rows pointing to it stay (a few rows; the issue view of the old key then shows the last copy).
- R6D-L4 `focus::book_session`: with rounding to the nearest step, a first session shorter than half a step
  books 1 minute (`max(1)`), which is not the rounded sum of its sessions: the next session rounds from the entry,
  and two 5-minute sessions with a 15-minute step book 0 minutes.
- R6D-L5 `block_restore` writes the appointment to Outlook again when the block had one, also when writing to
  Outlook was switched off between the delete and „Rückgängig“.
- R6D-L6 `demo::remove` goes by the stored page ids; a sample page deleted for good while it had the highest id
  hands its id to the next new page, which „Beispieldaten entfernen“ then moves to the trash (restorable there).

## Reviewed without finding

Migration `0043_issue_moved.sql` (next number, `IF NOT EXISTS`, older versions ignore the table; removed with its
site in `issues_remove_site`); no settings step in the range. The moved-issue sync (R6C-1/2): a key Jira answers
under another key is asked once and then dropped from the cache, a refused chunk costs at most 100 single requests
per sync, a search's copy of an issue wins over a refreshed one, chains of moves follow the newest key, a move back
removes the alias. `jira_duration` against `parse_duration` (every form the reader takes is written in Jira's
words; forms it refuses stay refused). The sprint pages (stop on `total`, an empty page or 2000 issues), ADF dates,
the Outlook all-day property (series, `EXDATE` and `RECURRENCE-ID` take the series' all-day form through `as_day`),
attachment folders and the cleanup of empty ones. Round 5: the shared day check (`useToday`: one timer for all
views, a day changed while nobody listened is taken at subscribe), the focus rounding (an entry the user changed is
rounded from its own value), the query sources (templates and filing folders, `ist nicht`), `clean_text` against
the PDF text layer (pdf.js puts a line break at each line end, e2e 680 checks it in the app), the undo of focus
blocks and highlights (focus sessions come back through `ON DELETE SET NULL`, an id taken meanwhile gives a new one),
the sample removal with and without stored ids, the settings writes on a worker (R5D-1) with `holdPending` (R5D-5)
and the merged writes of R5D-3. Every assertion changed in the tests of the range was kept, made stricter or
replaced by an equal one (`demo::tests` now finds the user's page among the trashed samples; the PDF test's input
has its hyphen at the line break, as the new rule needs).
