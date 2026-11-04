# q124 H4: search, AI, settings, keyboard

Hunt over the full-text and meaning search, the quick-search window, the command palette, the assistant
against fake OpenAI-compatible providers, voice notes, the settings and the keyboard. Severity as in `plan.md`.

| Severity | Count |
|----------|-------|
| High | 2 |
| Medium | 0 |
| Low | 5 |

## H4-1 (high): „Erneut versuchen“ after a booking booked the time a second time

- Symptom: the assistant books time with a tool call (`log_time`), then the request for its answer after the
  tool fails (a provider error, a timeout, the network). The error offers „Erneut versuchen“; it asked the whole
  question again, the model called `log_time` again, and the time was booked twice. The card of the first
  booking went away with the retry, so nothing showed the duplicate. „Neu generieren“ of an answer that
  followed a booking did the same.
- Root cause: `send` in `ui/src/store/chat.ts` treated a question as one unit: on a failure it took the
  question and everything after it out of the model history (although the tool steps had run and were saved),
  and `regenerate` cut the chat before the question and sent it again.
- Fix: a failure only takes back what followed the last finished tool step (`keep`); the question, the calls
  and their results stay in the history, as they are saved. `regenerate` of a question with finished tool steps
  (`cutAfterTools`) cuts the turns, the history and the saved messages after the last step and continues from
  there (`send(..., resume)`): only the answer is asked again. A question without tool steps is asked again as
  before.
- Test: `e2e/tests/461-assistant-tool-retry.test.js` (retry and „Neu generieren“ book once, the request
  continues after the tool result, the step card stays, the saved chat holds the step once).

## H4-3 (high): bookings typed on a #privat page went to the cloud model

- Symptom: a `/zeit` line typed on a page marked private (`#privat`, front matter tags) keeps its page
  (`time_entries.page_id`). Its description is text of that page, but the assistant sent it to a provider that
  is not local: as a numbered source of an answer, in the result of `search_workspace`, `time_summary` (which
  the weekly status e-mail asks for) and `activity_log`, and in the week review's summary.
- Root cause: the privacy checks (`ai_chat`, `ai_run_workspace_tool`, `weekreview::is_private`) looked at the
  pages of note chunks and tasks only; a time entry's page was never asked.
- Fix: `privacy::entry_pages` and `privacy::entry_pages_between` give the pages of bookings; the sources of
  `ai_chat`, the time entry hits of `search_workspace`, the period of `time_summary` and `activity_log` and the
  week of the week review count them, so a private one keeps the conversation (or the summary) on the local
  model.
- Tests: `e2e/tests/463-private-bookings-ai.test.js` (route of the answer, markers on the tool results; a
  booking of no private page still goes to the cloud model), unit tests
  `privacy::bookings_typed_on_a_private_page_count_as_private` and
  `weekreview::a_booking_typed_on_a_private_page_keeps_the_summary_local`.

## Low

- H4-2: Settings → Tastatur did not report a command on the global quick-search shortcut (default
  Ctrl+Shift+O) or the voice note shortcut as a conflict (the global one takes the keys first, so the command
  never ran). Fixed on the way: `findConflicts` checks both (`keymap.test.ts`).
- H4-4: a tool step that never finished (the app closed meanwhile) showed „Unterbrochen“ in the English UI too.
  Fixed on the way (`chat.toolInterrupted`).
- H4-5: „strasse“ does not find „Straße“ and „GRÖSSE“ not „Größe“ (the FTS tokenizer folds diacritics but not
  ß to ss). Swiss spelling and capitals miss pages; typing ß finds them.
- H4-6: the palette offers „Seite „#Wichtig“ anlegen“ next to the tag result for a `#tag` query.
- H4-7: the citation chips' screen reader name is German in the English UI (`aria-label="Quelle n"` in
  `lib/citations.ts`); the visible text is the number only.

## Checked without findings

- Search: umlauts and case, decomposed umlauts, punctuation, quotes and FTS operators as plain text, a query
  of 3000 words and one of 20000 characters (exact and by meaning), renamed and trashed pages, title ranking
  (`e2e/tests/460-search-edges.test.js`).
- Palette: `#tag` opens the tag view, `/zeit` books (1,5h = 90 min) and a malformed line shows its error, the
  commands list without errors; Settings → Tastatur: a combo of another command is reported, Escape ends the
  recording, undo of a shortcut change restores the defaults.
- Settings: 45 switches over 14 sections saved at once and unchanged after a restart; no error toasts.
