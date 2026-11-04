# q124 round 2, hunt D: search, AI, settings and performance with large data

Areas H4 (search, the assistant and the other AI requests, the meaning search, settings, the app lock) and H8
(performance with large data) of the [plan](plan.md). Branch `q124-r2d`. Round 1's H4-1 (tool retry booked
twice) and H4-3 (private bookings to the cloud) were not hunted again; their tests (461, 463) still pass.
Severity as in the plan.

| Severity | Count | Findings |
|----------|-------|----------|
| High | 4 | R2D-1, R2D-2, R2D-5, R2D-6 |
| Medium | 1 | R2D-4 |
| Low | 10 | R2D-3 (fixed), L1 to L9 |

All high and medium findings are fixed at the root with a test. Round 1's fixes hold: `461-assistant-tool-retry`
and `463-private-bookings-ai` pass on this branch.

Tests added: Rust `meetwork::tests::status_report_with_text_of_a_private_page_stays_local`, a case in
`briefing::tests::the_whole_briefing_from_the_stores`, `merge::tests::long_notes_changed_far_apart_merge_quickly`,
`merge::tests::myers_pairs_a_longest_common_subsequence`, a case in
`ai::client::tests::an_empty_answer_is_an_error_in_the_ui_language`; UI `lib/security.test.ts` („commands refused
while locked“); e2e `530-private-question-embedding`, `531-lock-during-answer` (fails on the old build: „the answer
finished during the lock was not saved“); the benchmark `huge_workspace` in `crates/arcalo-core/tests/bigworkspace.rs`.

## Findings

### R2D-1 The status report's summary went to a cloud model with text of private pages (high)

- Symptom: „Statusbericht“ of a folder, a tag, a Netzplan or a Jira project with „KI-Zusammenfassung“ sent its
  decisions, noted risks and deadlines to the standard (cloud) model although they came from a private page:
  a note changed in the period that is private by its front matter (`tags: [privat]`, no `#privat` in the
  text), and the due tasks of a `#privat` note not changed in the period (every page of the scope gives its
  deadlines and overdue tasks).
- Root cause: `meetwork::status::build` looked for a marker in the text of the pages changed in the period
  only (`marked(content)`); the tags of a page and the pages that gave only tasks were never asked.
- Fix: the report collects the pages whose text it uses (changed pages, pages with a deadline or an overdue
  task) and asks `privacy::private_pages` (tags, front matter included, and text), as the meeting preparation
  does.
- Test: `meetwork::tests::status_report_with_text_of_a_private_page_stays_local`.

### R2D-2 The morning briefing sent tasks of private pages to a cloud model (high)

- Symptom: „Was heute wichtig ist“ lists the overdue and due tasks for the model. A task without a marker of
  its own on a page that is private (by its tags or a `#privat` elsewhere in its text) went to the cloud model.
- Root cause: `briefing::build` checked the task's text and the task's own tags, not its page.
- Fix: the pages of the tasks in the briefing go through `privacy::private_pages` as well.
- Test: `briefing::tests` (the case after „a #privat task keeps the text local“).

### R2D-3 A question about an open private page went to a cloud embedding model (low)

- Symptom: with a `#privat` page open (Datenschutz „Geöffnete Seite mitsenden“ on), the answer stayed on the
  local model, but the question was embedded for the search by a cloud embedding model first. The same for a
  follow-up in a conversation whose earlier turns carried a marker while the chat history is off.
- Root cause: `ai_chat` decided about the query embedding from the question's text, the saved conversation and
  „Nur lokal“ only; the open page and the earlier messages were looked at later, for the route.
- Fix: the open page (`privacy::page_is_private`) and the earlier messages count for the embedding as well.
- Test: `e2e/tests/530-private-question-embedding.test.js`.

### R2D-4 The provider test failed a thinking model in the English UI (medium)

- Symptom: Settings → KI → a provider → „Testen“ with a model that spends its 16 test tokens on thinking (qwen3,
  deepseek-r1, gpt-oss on Ollama) shows the chat step as failed („Empty answer from the AI server“) and skips the
  tools step in the English UI; in German it passes. Two step texts were German in the English UI.
- Root cause: the shell recognized the empty answer by its German text (`starts_with("Leere Antwort")`).
- Fix: `AiClient::is_empty_answer` knows both texts; the step texts go through `tr!`.
- Test: `ai::client::tests` (the empty-answer test, English case).

### R2D-5 Merging a long note changed far apart took gigabytes and seconds (high)

- Symptom: a note of 20,000 lines changed in two places far apart on the other side (a log edited on two
  computers and synced, or the page changed by the tasks view, a chip or the CLI while it is open and then
  saved from the editor) made the merge build a table of the common blocks of every pair: 400 million cells
  (1.6 GB) and many seconds, while the save holds the database's write lock.
- Root cause: `merge::lcs` filled a dynamic-programming table of the middle between the common start and end,
  which grows with the square of the note. Measured with the old code in a release build: 2.1 s and 1.6 GB for one
  side of a note of 20,000 blocks (the merge compares both sides), about ten times the time in a debug build; a note
  of 40,000 blocks needs 6.4 GB.
- Fix: middles over 4 million cells use Myers' shortest edit script (cost grows with the differences, not with
  the note); beyond 2,000 differences the blocks found once on each side pair the rest (patience diff), with
  `lcs` again between them.
- Tests: `merge::tests::long_notes_changed_far_apart_merge_quickly` (20,000 lines, changes at both ends and in
  the middle, a deletion, 3,000 blocks added: under 2 s in a debug build, the same result),
  `merge::tests::myers_pairs_a_longest_common_subsequence`.

### R2D-6 Locking while the assistant answered stopped the chat history for the session (high)

- Symptom: „Jetzt sperren“, the idle lock or the computer sleeping while an answer was on its way: after the
  unlock the answer was shown, but neither it nor any later answer of the session reached the chat history
  (the conversations were there, empty, after a restart).
- Root cause: a command refused while locked never settled (`call` in `lib/api.ts`, `meetwork.ts`,
  `weekreview.ts`). The chat store saves one turn after the other on a promise chain; the save refused
  behind the lock never ended, so every later save waited behind it. The settings writes have the same chain.
- Fix: `callUnlocked` (`lib/security.ts`): a command refused while locked (it never ran) waits for the unlock
  (`applock://changed`, or the status when the unlock came first) and is sent then.
- Tests: `ui/src/lib/security.test.ts` („commands refused while locked“), `e2e/tests/531-lock-during-answer.test.js`.

## H8: performance with large data

The very large workspace: the benchmark's large workspace plus 5,000 pages (11,331 in all), a folder chain 40
levels deep, a note of 20,000 lines (1.2 MB, sections, lists, 400 tasks, links and tags), 48,000 more bookings
(50,088 in all, 17,266 in the last year) and 62,670 tasks. Generated by `huge_workspace` in
`crates/arcalo-core/tests/bigworkspace.rs` (`ARCALO_HUGE_DIR`); the UI benchmark runs on it with
`ARCALO_BIG_BASE=<folder> BENCH_LARGE_TITLE="Sehr lange Notiz" BENCH_LARGE_END="Abschnitt 399"
BENCH_LARGE_MIN_TEXT=40 node bench/bigworkspace.mjs`. Debug builds under Xvfb with software rendering on a
machine shared with three other builds (load 10 to 13 on 4 CPUs), so absolute times are several times a desktop's.

| Measurement | Result |
|---|---:|
| Core: tree / search „abstimmung“ / search in every booking text / open tasks | 69 / 148 / 146 / 332 ms |
| Core: bookings of a week / of a year | 1 / 84 ms |
| Core: export of a year (17,266 bookings) CATS / CSV / JSON | 202 / 199 / 248 ms |
| Core: time summary of a year / all budgets / week review / day review | 195 / 40 / 336 / 86 ms |
| Core: week proposal / WBS hints of 60 appointments | 481 / 342 ms |
| Core: saving the 20,000-line note (one line changed) | 420–520 ms |
| App: cold start to ready / warm start | 1.9 / 1.0 s |
| App: sidebar with 11,331 pages (virtual) scrolling | 16.5 ms per frame |
| App: opening the 20,000-line note first / again | 5.0 / 0.8–0.9 s |
| App: typing in it (median / p95) | 60 / 90 ms |
| App: page switch (median of 10) / tab switch | 130 / 100 ms |
| App: palette search / timesheet week / calendar week | 0.5–0.6 s / 319 ms / 249 ms |
| App: tasks view (62,670 tasks, 5.3 MB) / graph | 1.26 / 1.6 s |

No hang and nothing quadratic in the views; the quadratic merge (R2D-5) was the one. The first opening of the
20,000-line note is the linear cost of building and laying out a 1.2 MB document that `docs/performance.md` names
for the 1 MB note (4.9 s there in 1.17); it is listed below (L6).

## Low

- R2D-3 (fixed, see above).
- L1: a note can make the assistant book time. Retrieved text, the open page and tool results go into the request
  without a word that they are data, and `log_time` runs without a confirmation (a step card shows the booking, a
  draft). With an issue key of a site that logs work, the Jira worklog follows by itself. Not silent, so low; a
  confirmation for bookings the user did not ask for would need a design decision.
- L2: the version dialog and the conflict view compare a long note with many changes by a set comparison above 4
  million line pairs (`lib/linediff.ts`): the added lines are listed at the end, not where they are.
- L3: saving the 20,000-line note takes 0.4–0.5 s in a debug build (chunks, tasks, aliases and duplicate hashes
  of the whole note) and holds the write lock meanwhile; typing is not blocked.
- L4: „Index neu aufbauen“ or another embedding model chosen while a batch of the background indexer is on its
  way: the batch's vectors are stored after the clear (once per change, same model only for the rebuild); the
  assistant's `ai_index_pending` next to the background indexer embeds the same chunks twice.
- L5: the WBS hint of an appointment and the week proposal look up bookings by description without an index
  (`description = ? COLLATE NOCASE`, about 6 ms per appointment at 50,000 bookings in a debug build).
- L6: opening a 20,000-line note for the first time takes about 5 s here (see H8); the same note opens again in
  under a second (the editor is kept).
- L7: the provider test reports a wrong address (an OpenAI-compatible URL without `/v1`) as a failed „Zugang“ step
  with „HTTP 404“; the address hint is shown, but the step names the key.
- L8: the palette's search answers in 0.5–0.6 s per query on 11,331 pages here (debug build, loaded machine).
- L9: the benchmark's count of event listeners (adds minus removes, all targets) grows by about 3,800 per round of
  the usage loop while the DOM does not grow; listeners of removed elements count there without leaking, so this
  is no finding by itself.
