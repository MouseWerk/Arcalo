# q124 round 7, hunt C: work features, search, palette, assistant and settings

H3 and H4 gone through as a user would, looking for what the earlier rounds did not test (their findings in
`h3-work.md`, `h4-search-ai.md`, `r2-search-ai-perf.md`, `r2-work-phone.md`, `r3-*.md`, `r4-settings.md`,
`r5-features.md`, `r5-undo.md`, `r6-jira-calendar.md` and `q123/` are fixed and were not hunted again). H3: tasks,
meeting notes (follow-up mail, prep page, status report), the time-tracking exports and the start page; calendar
and Jira were hunted in round 6, and only its Jira fixes were checked for neighbouring cases. H4 was not hunted in
round 6 and got most of the time: the search after renames and deletes and with umlauts, the command palette and
the quick-search window, the assistant's stop, retry and errors, settings and their undo, and keyboard-only use.
Branch `q124-r7c`.

3 high, 11 medium, 15 low (1 of them fixed on the way).

## Findings

### R7C-1 Undoing the removal of an AI provider brings it back without its API key (high)

- Symptom: Settings → KI & Modelle, a provider with a key → „Entfernen“ → „Rückgängig“ in the toast. The provider
  was back, but without its key: every request failed with 401 until the key was found and pasted again. The same
  for a settings import or „Alles zurücksetzen“ that dropped a provider, and their undo.
- Root cause: `settings_save` deleted the key of every removed provider from the credential store with the save
  that removed it; the undo saves the old settings again, and the key was gone.
- Fix: the keys of removed providers are deleted once the change can no longer be undone (`after_undo_time`, one
  minute), and only when the provider was not saved again meanwhile; at quit the waiting ones are deleted.
- Test: e2e `740-settings-undo-keeps-data` (removed and taken back: both keys there; removed for good: its key goes
  after the undo time, the other stays).

### R7C-2 Choosing a chat retention deletes old chats at once, also when the change is taken back (medium)

- Symptom: Datenschutz → Chat-Verlauf „30 Tage“ → „Rückgängig“: the setting came back, every unpinned chat older
  than 30 days was gone for good. A chat deleted in the minute before (its toast offers „Rückgängig“) was purged
  as well, and its „Rückgängig“ then failed („ließ sich nicht wiederherstellen“).
- Root cause: `settings_save` ran `chats::prune` with the save; `chat_prune` purged every deleted chat, not only
  those past their undo time.
- Fix: a changed retention is applied once the change can no longer be undone (the start applies it as before);
  `chat_prune` keeps chats deleted in the last minute.
- Tests: e2e `740-settings-undo-keeps-data`, `chats::tests::retention_removes_old_unpinned_chats` (a chat deleted
  just now survives a cleanup).

### R7C-3 A chat deleted while it answers loses its last question; „Rückgängig“ brings it back without it (medium)

- Symptom: a question asked, the chat deleted in the history list while the answer streams in, then „Rückgängig“:
  the chat came back without the question and the answer so far (a first question: an empty chat named after it).
- Root cause: `deleteChat` deleted the conversation first and then stopped the answer; the send saved the question
  afterwards into the deleted conversation, which the core refused (only logged).
- Fix: an answer on its way is stopped and its question saved before the chat is deleted (`stopAndSettle`, with a
  session's `idle()`).
- Test: `chat.test.ts` („a chat deleted while it answers keeps its question“).

### R7C-4 „Im Chat-Fenster öffnen“ during an answer leaves a turn that streams for ever (medium)

- Symptom: with chats not saved (or before the first save), the panel's chat moved to the chat view while it
  answered: the view showed the answer as still streaming, empty, for good, and the answer was lost; the view's
  history held the question without an answer. The same from the chat view to the panel.
- Root cause: `adopt` copied the panel's turns with the streaming one, and the panel's `newChat` then cancelled the
  answer, which no longer wrote into either chat.
- Fix: an unsaved chat that answers is stopped and settled before it moves (`openChatView`, `openInPanel`); a saved
  one is mirrored live as before.
- Test: `chat.test.ts` („an unsaved chat moved to the chat view while it answers“).

### R7C-5 Stop before the first word sends an empty answer with every later question (medium)

- Symptom: „Stopp“ before the first word of an answer, then the next question: the request held an assistant message
  without content (`{"role":"assistant"}`). Providers that check the messages (OpenAI, Mistral, Anthropic behind
  LiteLLM) refuse it, and since a failure only takes the new question back, every later question of that chat
  failed, also after reopening it.
- Root cause: `send` kept a cancelled empty answer in the model history (`content: null`; „stopped while saving“:
  `""`), and saved it as part of the context.
- Fix: an answer stopped before its first word stays visible as stopped, but it and the question it leaves
  unanswered are taken out of the history and saved as not in context (`in_context: false`), as a failed one is.
- Test: `chat.test.ts` („a question stopped before the first word leaves no empty answer“).

### R7C-6 On a canvas the palette offers the editor's commands; „Präsentieren“ shows the board's JSON (medium)

- Symptom: with a canvas open, the palette (and the shortcuts) offered „Präsentieren“, „Quelltext umschalten“,
  „Volle Breite“, „Eigenschaft hinzufügen“ and „Zeichnung einfügen“. „Präsentieren“ (Strg+Umschalt+P) showed one
  slide with the canvas file's JSON; the others did nothing. „Nachfass-Mail“ took the canvas as a meeting note.
- Root cause: the commands were offered for every page tab; a canvas is a page tab whose view listens for none of
  them.
- Fix: `activeNoteId` (the active tab's page when it is a note) decides the editor's commands in the palette, the
  shortcuts and the follow-up mail.
- Test: e2e `741-palette-canvas-stale-hits`.

### R7C-7 The selection moves to another hit when pages found by meaning arrive (medium)

- Symptom: in the palette and the quick-search window, a hit chosen with the arrow keys was replaced by another
  page when the meaning results came in (a few hundred milliseconds later with a cloud embedding model); Enter
  opened that page.
- Root cause: the selection was an index; the merged list keeps only the first three exact hits in front, so a page
  found by meaning can land before the fourth.
- Fix: `followSelection` keeps the selected item selected (by its id) when the list changes under it; typing still
  selects the first.
- Test: `quicksearch.test.ts` („keeps the selected item selected“).

### R7C-8 Enter right after typing in the palette opens a hit of the query before (medium)

- Symptom: „Zebrafinken“ typed (its page found by content), then „ Käfig“ and Enter at once: the palette opened the
  page found for „Zebrafinken“ instead of creating „Zebrafinken Käfig“.
- Root cause: the palette showed the hits of the meaning search hook until the new query was answered; the sidebar
  and the quick-search window wait for the answer, the palette did not.
- Fix: the palette shows only hits answered for the query typed now.
- Test: e2e `741-palette-canvas-stale-hits`.

### R7C-9 A due phrase after a letter that grows when lower-cased crashes the app (high)

- Symptom: a task like `- [ ] İlkay Vertrag prüfen bis Übermorgen` (a Turkish İ, or a capital ẞ, before „bis“ and
  an umlaut after it) quit the app when the follow-up mail of its meeting note was made, or when a voice note's
  action items were read.
- Root cause: `voice::actions::parse_item` found „ bis “ in the lower-cased text and cut the original text at that
  byte offset; „İ“ lower-cased is a byte longer, so the cut fell inside „Ü“ (a panic, and the app is built to abort).
- Fix: the phrase is looked for in the ASCII lower case, which keeps every offset.
- Tests: `voice::actions::tests::a_due_phrase_after_letters_that_grow_lower_cased_is_cut_safely`,
  `meetwork::tests::followup_keeps_due_dates_in_words_links_and_sub_headings`.

### R7C-10 The follow-up mail drops a due date written in words (medium)

- Symptom: `- [ ] Angebot schicken bis 20.11.2026 @Anna` became the action „Angebot schicken“ for Anna with no due
  date: the date was taken out of the text and not shown anywhere.
- Root cause: `followup::extract` took the due date only from the task's `due:` token, not the one `parse_item`
  read from the words.
- Fix: the date read from the words is the action's due date when the task has no `due:`.
- Test: `meetwork::tests::followup_keeps_due_dates_in_words_links_and_sub_headings`.

### R7C-11 A bracket before a link garbles a result in the follow-up mail (medium)

- Symptom: „Budget [geschätzt] siehe [Doku](https://wiki/doku)“ was mailed as „Budget geschätzt] siehe [Doku“;
  a done task under „Ergebnisse“ with a link („[x] Release freigegeben ([Protokoll](…))“) was garbled the same way
  and then not recognized as a task, so it went into the results.
- Root cause: `followup::plain` paired the first `[` with the first `](`, and the task filter ran on the garbled text.
- Fix: each link's text starts at the `[` right before its `](`; task items are left out before the text is made
  plain (also `[X]`).
- Test: `meetwork::tests::followup_keeps_due_dates_in_words_links_and_sub_headings`.

### R7C-12 Decisions under a sub-heading are missing from the follow-up mail, the prep page and the status report (medium)

- Symptom: „## Entscheidungen“ with „### Backend“ and „### Frontend“ below it, each with its decisions: none of them
  was found (follow-up mail, „letzte Besprechung“ on the prep page, the status report). The same for results and
  open points.
- Root cause: `list_sections` started a new section at every heading, against its own documentation („up to the
  next heading of the same or a higher level“).
- Fix: `items_under` counts the items of sub-headings to their section; decisions keep the note's order.
- Test: `meetwork::tests::followup_keeps_due_dates_in_words_links_and_sub_headings`.

### R7C-13 Tasks in a Markdown example inside a code block are listed as tasks (medium)

- Symptom: a code block showing Markdown with a fenced block inside (the editor writes four backticks around code
  that holds three) closed at the inner fence: its `- [ ]` lines were listed in Aufgaben, the start page and the
  deadlines, and ticking one there rewrote the code. In meeting notes a `~~~` block holding ```` ``` ```` leaked its
  items into decisions and results.
- Root cause: `notes::fence_marker` knew only „starts with ```` ``` ```` or `~~~`“; a block closed at any such line.
  `meetwork::list_sections` flipped at every fence of either kind.
- Fix: `notes::Fence` and `CodeFences` follow CommonMark (a block ends at a fence of its character, at least as long,
  with nothing after it); tasks, links and tags, renames of links, meeting sections and decisions use it.
- Tests: `tasks::tests::tasks_in_longer_fences_are_code`, `meetwork::tests::sections_skip_code_in_longer_fences`.

### R7C-14 A private marker with umlauts written in capitals does not keep the page from a cloud embedding model (high)

- Symptom: with a text marker like „Ärztlich“ in Settings → Datenschutz and a page that writes „ÄRZTLICH“, the
  chat and the assistant kept the page local, but the meaning search sent its text to an embedding model in the
  cloud.
- Root cause: `rag::public_filter` compared with SQLite's `lower(p.content)`, which lower-cases ASCII only
  („ÄRZTLICH“ becomes „Ärztlich“, not „ärztlich“). Tags are stored lower-cased and were found.
- Fix: the marker is looked for also with its other letters in capitals (the form `lower` leaves of „ÄRZTLICH“ and
  „Ärztlich“).
- Test: `ai::rag::tests::markers_with_umlauts_in_capitals_keep_the_page_from_other_providers`.

### R7C-15 A decision tagged under the decision heading is listed twice in the status report (low, fixed)

- „## Entscheidungen“ / „- Go-Live #entscheidung“ gave „Go-Live #entscheidung“ and „Go-Live“ (`dedup` removes
  neighbours only). Fixed with R7C-12: tags are taken off the items and each decision counts once. Test:
  `meetwork::tests::decisions_tagged_under_the_decision_heading_count_once`.

### Low (listed, not fixed in this round)

- R7C-L1: the status report's „Per E-Mail“ cuts the Markdown at 1500 characters before it is encoded; a report
  under that makes a `mailto:` of 3000 to 4000 characters, which Windows and some mail programs cut without notice
  (the follow-up mail measures the encoded link, `MAILTO_MAX`). Copying the report works.
- R7C-L2: „Stopp“ while the cost limit dialog is open does not stop the question: „Trotzdem senden“ afterwards
  still sends it in full (marked stopped afterwards).
- R7C-L3: the undo toast of a settings change made before Settings was closed and opened again takes back the
  newer change of the same value as well (it uses the closed view's snapshot).
- R7C-L4: „Rückgängig“ of a change in a list (providers, backup targets, filing rules, prices) after another
  change in the same list does nothing, but says „Rückgängig gemacht“.
- R7C-L5: a settings export taken with „automatisch“ for the meaning search or the number format cannot set the
  importing computer back to automatic (`NULLABLE` in `settingsio.ts` lacks them; the meaning search reports a
  missing value).
- R7C-L6: „Eigenschaft hinzufügen“ in the source view does nothing, and its popup opens when the editor is shown
  again.
- R7C-L7: „Neue Seite“ in the quick-search window ignores Settings → Editor „Neue Seiten“ (folder) and the default
  icon (the palette follows them).
- R7C-L8: the quick-search window says „Gebucht“ for a `/zeit` line that was only queued (database busy) or was
  written to the daily note as text (`/zeit,` and `/zeitä…` look like bookings to the window, not to the core).
- R7C-L9: views opened by a shortcut (Aufgaben, Einstellungen, the daily note from the ribbon) leave the keyboard
  focus where it was; F6 reaches them.
- R7C-L10: the start page's chart of bookings by week starts the weeks on Monday also with weeks from Sunday.
- R7C-L11: the start page's Aufgaben widget marks „überfällig“ by the day it was drawn; open over midnight it keeps
  the day before until its data changes.
- R7C-L12: other fence readers (embeds, mentions, the merge, the activity feed, the capture) still end a block of
  four backticks at three.
- R7C-L13: a provider removed and the app killed (not quit) within the minute: its key stays in the credential
  store unused.
- R7C-L14: a private text marker with letters both upper and lower case beyond ASCII in one word („äRZTLICH“)
  is still missed by the embedding filter (R7C-14 covers all capitals and a capital first letter).

## Looked at, no finding

- Search: renames, moves, the trash and its restore, deletion for good (the index follows), umlauts and case
  (Äpfel, äpfel, apfel), prefixes, quotes, `-`, `*`, `:`, `(`, `NOT` and tokens that fold to nothing (no FTS5
  syntax error), snippets with multibyte text, private pages in the meaning search.
- Palette and quick search: every command id has a runner, time and AI commands hidden with their switches, split
  panes (commands reach the focused pane), the week proposal opening a timesheet that loads late.
- Assistant: retry after provider errors, „Neu generieren“, locking while it answers, the history after a stop.
- Voice notes: stop, transcription, summary into a page.
- Exports: CSV, JSON, SAP CATS (per-day rounding, quoting, decimal point), the Jira worklog file, the export
  dialog's local days over the clock change, „bereits exportiert“ left out; worktime, balance, vacation, budgets.
- Tasks: recurrence, ticking from the start page and from notifications (by text when the page changed), tasks of
  deleted pages and templates left out.
- Round 6's Jira fixes: an issue moved twice and moved back is followed by every old key (aliases, hours, the
  issue under its current key); a moved issue later deleted resolves to nothing.
- Keyboard: F6 through the regions, ticking a task with Space in Aufgaben, the palette and dialogs by keys.

## Tests added

- Rust: `voice::actions::tests::a_due_phrase_after_letters_that_grow_lower_cased_is_cut_safely`;
  `tasks::tests::tasks_in_longer_fences_are_code`; `meetwork::tests::followup_keeps_due_dates_in_words_links_and_sub_headings`,
  `decisions_tagged_under_the_decision_heading_count_once`, `sections_skip_code_in_longer_fences`;
  `chats::tests::retention_removes_old_unpinned_chats` (a chat deleted just now);
  `ai::rag::tests::markers_with_umlauts_in_capitals_keep_the_page_from_other_providers`;
  `issues::tests::an_issue_moved_twice_or_back_is_followed_by_every_old_key`.
- UI: `chat.test.ts` (R7C-3, R7C-4, R7C-5), `quicksearch.test.ts` (R7C-7).
- e2e: `740-settings-undo-keeps-data.test.js`, `741-palette-canvas-stale-hits.test.js`.
