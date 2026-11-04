# q124 round 2, hunt D: search, AI, settings and performance with large data

Areas H4 (search, the assistant and the other AI requests, the meaning search, settings, the app lock) and H8
(performance with large data) of the [plan](plan.md). Branch `q124-r2d`. Round 1's H4-1 (tool retry booked
twice) and H4-3 (private bookings to the cloud) were not hunted again; their tests (461, 463) still pass.
Severity as in the plan.

FINDINGS_TABLE

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
  which grows with the square of the note.
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

PERF_SECTION

## Low

LOW_LIST
