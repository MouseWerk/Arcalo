# q124 round 7, hunt D: review of the round 6 fixes, and performance with large data

Round 6 (`e69a311d` to `beb4b57e`) merged 21 high and medium fixes. This hunt reviews that range as code
(`git diff e69a311d beb4b57e -- crates src-tauri ui/src`), as round 6 hunt D did for rounds 5 and 6: regressions a
fix did not intend, two fixes that work against each other, paths a fix did not reach, the error paths and the cost
of the new code, migration `0043_issue_moved.sql`, every changed assertion of the tests, and the open low findings of
round 6. It takes the failures of the scheduled `e2e soak` on main since then (run 43699151368, 2026-11-15: e2e 37 in
round 1, e2e 230 in round 2; e2e 37 also in run 43520172701 on `q124-r6d`). And it measures area H8, performance with
large data, on the very large workspace of round 2 (11,331 pages, a note of 20,000 lines, 50,084 bookings, 62,670
tasks) and on vaults of up to 10,000 notes, without the findings of [r2-search-ai-perf.md](r2-search-ai-perf.md).
Each finding was first shown by a failing test or a measurement. Branch `q124-r7d`. Severity as in the
[plan](plan.md).

Found: 1 high, 3 medium, 7 low.

## Findings

### R7D-1 Provider rows changed height while their connection was checked, the tier dropdowns jumped (medium, fixed)

- Symptom: after a provider is added or changed in „KI & Modelle“, every provider is checked again. Its status line
  („Prüfe…“, then „Verbunden · 4 Modelle“) decided whether the provider's address fitted on the line or wrapped below
  it, so each row got a line taller or shorter when its check answered, and everything below jumped, the tier
  dropdowns too. A click meant for „Anbieter für Lokales Modell“ landed next to it. This is round 6's R6D-L1; it is
  what failed the soak's e2e 37 twice since R6D-1 („Anbieter für Lokales Modell did not open“, runs 43520172701
  and 43699151368, round 1): the failure screenshot shows the OpenAI row with its address on a line of its own. In
  19 local runs of e2e 37 (alone, under full CPU load, after e2e 360) it passed: the soak's providers answer at
  other times.
- Root cause: `.provider-meta` (one line, the address cut with „…“) was overridden by `.set-row-desc { flex-wrap:
  wrap }` of the settings, a later stylesheet of the same specificity.
- Fix: the status line of a provider row stays one line (`.set-row-desc.provider-meta`); the address is cut with
  „…“ and shown in full in its tooltip, as intended.
- Tests: e2e 760 „a provider row keeps its height while its connection is checked again“ (a server that answers
  after 2.5 s; at 1480, 1100 and 900 px the row and the tier dropdown keep their place; failed at 1100 px: 122 px
  while checking, 144 px after).

### R7D-2 A vault with an image of the same name next to each note took minutes and held the database for seconds (high, fixed)

- Symptom: importing a vault whose notes each have their own `image.png` (the layout of Notion's Markdown export,
  and of many vaults with pasted images) got slower with every note, while each batch held the database and the app
  waited for it. Measured with `vault_import_large` (`ARCALO_IMPORT_IMAGES=1`, debug build):

  | Notes | Reading before / after | Writing before / after | Longest batch before / after |
  |---:|---:|---:|---:|
  | 1,000 | 1.3 s / 0.17 s | 6.3 s / 1.7 s | 0.68 s / 0.20 s |
  | 2,000 | 4.8 s / 0.30 s | 24.2 s / – | 1.34 s / – |
  | 4,000 | 16.4 s / 0.43 s | 90.6 s / 7.1 s | 2.54 s / 0.25 s |
  | 10,000 | – / 2.1 s | – / 18.2 s | – / 0.25 s |

  Quadratic: 10,000 notes, the size of H8, took about ten minutes, with the app waiting about 6 s for each batch.
- Root cause: two paths that compared each file with all before it. R6A made a reference with a path follow its
  file: since then every note was parsed once for every renamed file of the vault (before, a cheap folder check
  came first), so writing cost notes × renamed files. And storing a file under a free name tried `image.png`,
  `image 2.png` … from the start for each file, reading every earlier one of the same size.
- Fix: the renamed files are found by their old name and the folder a reference must come from (the note's folder
  and those above it for a bare name, the named folder for a path), so a note is checked against the files it can
  mean; the exact checks of R6A are unchanged. An import keeps per name the candidates it found taken (by size, the
  hash read once) and goes on where the last search stopped (`attachments::ImportNames`). Equal files are still
  stored once, also against files that were in the attachments folder before.
- Tests: `vault::tests::many_same_named_files_each_keep_their_note` (each note keeps its own image, equal bytes once,
  a file from before found again); R6A's `path_references_to_same_named_files_follow_their_path` unchanged; the
  measurement `bigworkspace.rs` `vault_import_large`.

### R7D-3 A command waiting for the database during a vault import waited for the whole import (medium, fixed)

- Symptom: the soak's e2e 230 failed in round 2 of run 43699151368: „the app waited 2206 ms for the database“ while
  4,000 notes were written in batches, meant to leave the database to the app between two batches.
- Root cause: a mutex is not fair. The import released the database after a batch and took it again at once for the
  next one; a command already waiting was woken but usually came too late, and waited for further batches, in the
  unit test for all of them.
- Fix: after each batch the import pauses for 5 ms, so a waiting command gets the database (50 ms per 2,000 pages).
- Tests: `vault::tests::the_app_gets_the_database_between_two_batches` (a thread asking for the database during an
  import of 1,200 notes; failed: `[0, 6]`, the second wait lasted all six batches). e2e 230 locally: longest wait
  563 to 584 ms (before 580 to 883 ms).

### R7D-4 „Anhänge verwalten“ with thousands of files took 10 seconds to show (medium, fixed)

- Symptom: after an import like R7D-2 the attachments folder holds thousands of files. The attachments view drew a
  row (thumbnail, buttons, usage) for each: with 10,000 files it showed after 9.9 s with 180,742 elements, and each
  filter or sort drew them all again.
- Root cause: the list was not windowed, unlike the task, activity and issue lists.
- Fix: from 300 files only the rows in view are drawn, with spacers of the measured heights of the others
  (`lib/groupWindow.ts`, as the Issues page); the rows carry `aria-rowindex`, the table `aria-rowcount`.
- Tests: e2e 760 „the attachments view opens quickly with 10,000 files“ (failed: 9,931 ms; now 1.3 s with 22 rows
  and 2,180 elements; scrolled to the end it shows the last file).

## Low findings (not fixed in this round)

- R7D-L1 The `==` and `++` escaping of R6A (`escapeSpans`, and `flankedSpan` when reading) looks for a closing
  delimiter after each opening one: a paragraph of 20,000 lines each with an unclosed `x ==y` takes 7.2 s to write
  (5,000 lines 0.45 s). Ordinary text stays linear: 20,000 lines of `a == b` 20 ms, of `C++` 14 ms.
- R7D-L2 `worklogs_taken` (worklogs of other bookings, never adopted for a retried one) asks for one key: a booking
  under a moved issue's new key, retried after a lost answer, may adopt the worklog of a booking with the same start
  and length made under the old key, and its own hours are not posted.
- R7D-L3 `Database::own_entry_ids` was inserted between the doc comment of `delete_time_entry` and its function:
  the comment „Deletes a booking …“ now describes `own_entry_ids`, and `delete_time_entry` has none.
- R7D-L4 More than 9,999 files of one name in a vault: the further ones are counted as skipped without a warning.
- R7D-L5 Every Git sync rewrites the whole Markdown mirror: 11,143 files, 1.7 to 2.4 s of writing in the very large
  workspace (without the database; reading it takes 0.4 s on the snapshot connection).
- R7D-L6 „Unbenutzte aufräumen“ lists every unused file with a checkbox, not windowed (10,000 after an import like
  R7D-2).
- R7D-L7 The import's waits for the database are bounded by one batch since R7D-3: about 0.25 s in a debug core
  build, 0.56 to 0.58 s in the app here; e2e 230 allows 1.5 s, which a slow runner may still reach.

## H8: performance with large data

The very large workspace of round 2 (`huge_workspace` in `crates/arcalo-core/tests/bigworkspace.rs`, see
[r2-search-ai-perf.md](r2-search-ai-perf.md) and `docs/performance.md`), debug builds under Xvfb with software
rendering on a shared machine with 4 CPUs. New measurements: `vault_import_large` (a vault of `ARCALO_IMPORT_NOTES`
notes like e2e 230, `ARCALO_IMPORT_IMAGES=1` with an image next to each) and `huge_sync_and_backup` (mirror, Git
sync into a local bare repository, backup, issue view backlinks).

| Measurement | Result |
|---|---:|
| Core: tree / search „abstimmung“ / open tasks / long note saved (one line) | 60 / 136 / 304 / 500 ms |
| Core: bookings of a year / export of a year (CATS, CSV, JSON) / week review / week proposal | 82 / 195–237 / 307 / 496 ms |
| Core: Markdown mirror (read / 11,143 files written) | 0.41 / 1.65–2.36 s |
| Core: Git sync first (11,483 files) / one note changed / nothing changed | 4.6 / 0.63 / 0.47 s |
| Core: backup (147 MB) | 0.76 s |
| Core: issue view backlinks over the moved keys / all issues | 70 / 23 ms |
| Core: vault import 4,000 / 10,000 notes, longest batch | 4.8 / 12.8 s, 0.30 s |
| Core: vault import, 10,000 notes each with `image.png` (R7D-2) | 2.1 s reading, 18.2 s writing, 0.25 s batch |
| App: cold start to ready / warm start | 1.9 / 1.4 s |
| App: sidebar with 11,331 pages scrolling | 16.2 ms per frame |
| App: 20,000-line note opened first / again; typing in it (median / p95) | 4.1 / 0.68 s; 60 / 69 ms |
| App: page switch / tab switch / palette search | 3–226 / 64–182 / 457–529 ms |
| App: calendar week / month, timesheet, Issues (2,000), tasks (62,670), graph | 175 / 41, 219, 545, 1,075, 1,315 ms |
| App: links panel of the 20,000-line note (400 links) | 182 ms |
| App: attachments view with 10,000 files (R7D-4) | 9.9 s before, 1.3 s after |
| App: elements during 10 rounds of the usage loop | 3,279 or 23,243, no growth |

The core numbers match round 2's within the noise. The element count of the usage loop alternates with the kept
editor of the 20,000-line note (about 20,000 elements) and does not grow; the benchmark's own end count (23,247 after
21 rounds, 1,791 after the first) is one of the two states. No hang and nothing quadratic left in the views measured.

## Reviewed without finding

Migration `0043_issue_moved.sql` (next number, `IF NOT EXISTS`, removed with its site). The moved issues of R6C-1/2
and R6D-2/3: chains and moves back (`issue_moved_record`), the old keys' projects for the chips, the keys ticked
when an issue becomes done in a sync or fetched alone (a hover card ticks once; the next sync finds it done), the
note, backlinks, WBS and booked minutes over `issue_aliases`; the cost: one indexed query per alias, the backlinks'
scan once per key (70 ms on 11,331 pages). The worklog of the issue view (R6C-3) books first and takes the booking
back when the post fails; for a site that posts bookings by itself (`logs_work`) the runner posts it, so there is
no second post in between. The
sprint pages, `jira_duration`, the attachment folders of the issue view (`forget_old_files` recursing, a folder per
address), the Outlook all-day property, the phone's booking ids (`NEXT_ENTRY_ID`, `own_entry_ids` once per start,
`INSERT OR IGNORE`), the command line's export defaults and checks, the CLI's line ends. In the UI: R6D-1's
`Select` (only the person's wheel or touch closes it), the soft line ends of paragraphs, the numbered tasks and
letter lists, `singleCellTablesToHtml`, `indexByKey`, the ResizeObserver trace (only under WebDriver). Every
assertion changed in the tests of the range was kept or made stricter; e2e 660 moved its day shift to the day of
its booking (the Sunday soak), with the same check.
