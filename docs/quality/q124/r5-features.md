# q124 round 5, hunt B: features earlier hunts barely touched

This hunt went through the README's feature list and the command palette for what q123 and q124 rounds 1 to 4 did
not cover, and checked that results are correct and complete, not only that the views render: query blocks and the
„Abfrage“ widget (every source, the filters, sort, group and ranges), smart folders and the tag view, focus
sessions and their bookings, PDF highlights and taking them into a note, the activity feed, the graph's links,
orphans and filters, page versions, the word count, mail-to-task, voice notes and link titles. Branch `q124-r5b`.
Severity as in the [plan](plan.md); wrong results and lost data count as high.

## Findings

### R5B-1 Focus sessions on one entry rounded it up once per session (high, fixed)

- Symptom: with rounding on (Settings → Zeiterfassung, e.g. 15 minutes up), four focus sessions of 25 minutes on
  the same Vorgang and goal booked 2:00 h instead of 1:45 h; three one-minute sessions booked 0:30 h instead of
  0:15 h. Every session after the first rounded the already rounded total up again, so the draft that goes to
  CATS or Jira grew with each session.
- Root cause: `focus::book_session` added the session's minutes to the entry's (rounded) duration and rounded the
  sum again.
- Fix: the entry grows from the sum of its sessions' own minutes (`focus_sessions.booked_minutes`) while its
  duration is still the rounded sum; an entry the user corrected keeps the correction as before.
- Tests: `focus::tests::rounding_applies_once_to_the_sessions_of_an_entry`, e2e 680 („focus sessions extending
  one entry round its total once“).

### R5B-2 Queries listed templates and the filing's folders as pages (high, fixed)

- Symptom: a query block or „Abfrage“ widget over pages (`#projekt status: offen`) listed the template „Projekt“
  from „Vorlagen“ as a project, and a plain page query or count also listed the year and month folders of the
  filing. The task source left templates out, the page source did not.
- Root cause: `dashboard::query::pages` filtered only on `deleted_at`.
- Fix: the page source leaves out the templates page with everything below it and the filing's folders, as the
  task lists, the graph and the smart folders do.
- Tests: `dashboard::tests::query_pages_leave_out_templates_and_filing_folders`, e2e 680 („query blocks: …“).

### R5B-3 `status!=offen` in a task query listed the open tasks (high, fixed)

- Symptom: `from: tasks` with `status!=offen` (or `status is not done`) gave the open tasks, the opposite of what
  was asked; `status!=erledigt` was right only by chance.
- Root cause: only `status ist …` set the status of the database query; `ist nicht` fell through to a field the
  task rows do not have, which every row passes.
- Fix: `ist nicht` asks for the other status (`ist nicht alle` for none).
- Tests: `dashboard::tests::query_tasks_status_is_not`, e2e 680.

### R5B-4 A PDF highlight joined words at every hyphen before a blank (medium, fixed)

- Symptom: highlighting „Haus- und Gartenarbeit“ in a PDF stored and quoted „Hausund Gartenarbeit“; every German
  enumeration with a hyphen („Ein- oder Ausgang“) was changed in the highlight list and in the quote taken into
  the note.
- Root cause: `pdfmarks::clean_text` collapsed all whitespace first and then joined any lower-case `x- y`, so it
  could not tell a word broken at the end of a line from a hyphen within the line.
- Fix: a word is joined only where the hyphen ends a line (the selection's text has a line break there).
- Tests: `pdfmarks::tests::a_hyphen_within_a_line_stays`, e2e 680 („PDF highlights keep the selected text, …“:
  also the quote with its link back in a note and a rename of the PDF moving highlight and link).

### Low

- R5B-5 Word count: the status bar counts every blank-separated piece („–“, „|“, an emoji) as a word, the
  Statistics dialog (`textStats` in `editor/tools.ts`) only runs of letters and digits, so the two can differ by a
  few words for the same note.
- R5B-6 The graph's date range compares the UTC day of `created_at`/`updated_at` with local dates: a page edited
  between local midnight and the UTC offset (0:00 to 1:00/2:00 in Germany) falls on the day before.
- R5B-7 A query block sorted in the note (`sort: due`) sorts the first 200 rows the backend returns; with more
  matches the top of the list can be missing rows.
- R5B-8 A query block open over midnight keeps „heute“/„überfällig“ of the day before until data changes.
- R5B-9 The tag view and the smart folder „Tags“ match a tag exactly, while the graph's tag filter also takes the
  subtags (`projekt` → `projekt/x`).
- R5B-10 The activity feed stores people separated by blanks: `owner: Max Muster` becomes the two people „max“ and
  „muster“ in the person filter.
- R5B-11 `#hashtags` in the quoted text of a mail note become tags of the note (a signature's `#WeAreHiring`).
- R5B-12 The HTML share of a query chart heads its first column with the stored German field name (`fällig`) also
  in English.

## Checked without findings

The query sources' other filters (due buckets, priority words and numbers, page, tags, entries by range, group and
status, meetings by calendar and days, English field names and operators), ticking a task in a query and the
refresh after changes; smart folders (recent, favorites, unfiled, orphans with non-ASCII titles, Jira and Netzplan
groups); the activity feed's merging of edits per hour, task added/done and the take-back of an unchecked task;
the graph's links, unresolved links and links in; page versions (snapshot interval, big removals, restore with
undo, rename keeping the rewritten pages); a PDF highlight's quote, its link back and a rename of the PDF; voice
action items and their dates; mail task lines and their place in an „Aufgaben“ section; link titles behind a
sign-in.
