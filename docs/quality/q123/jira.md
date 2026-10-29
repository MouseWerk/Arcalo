# q123: the Jira UI

Owner's report: „Positionierung des Show Jira Ticket in Software Button, Jira UI generell usw“. The button is the one
that opens an issue in Arcalo's own issue view („Issue-Ansicht“, 1.22), as opposed to „In Jira öffnen“ (the browser).

Method: the screenshots of the Jira e2e tests on `main` (103, 104, 105, 118, 146, 147, 153, 160; CI run 40473603181)
looked at one by one, every place that opens an issue read in the code, and a new test
(`e2e/tests/412-jira-ui-consistency.test.js`) that measures the fixed cases in the real app and takes the list, the
hover card and the issue view in light, dark, both contrast themes and at 900, 1480 and 1920 px, each run through the
layout audit (`e2e/lib/layout-audit.js`). The machine had too little disk for a local build next to the other runs, so
the e2e results come from CI.

## The button: where it is now

One component, `components/issue/IssueOpenButtons.tsx`: „In der Issue-Ansicht öffnen“ (icon `ISSUE_VIEW_ICON`, the
panel icon) first, then „In Jira öffnen“ (external link icon), the labels and icons of the issue view's own header and
of the menus (`issueOpenMenu`: issue view, Jira, note, key).

| Place | Before | Now |
|-------|--------|-----|
| Issues list, row actions | 5 icons (view, browser, note, copy, more) on hover, pushing the row 112 px left and covering the status | issue view, Jira, more, in room the row always keeps; shown on hover and keyboard focus, always on touch screens |
| Issues list, context menu | view, note, browser, copy | view, Jira, note, copy (the widgets' order) |
| Issues list, opened row | „Vollansicht“ | „In der Issue-Ansicht öffnen“, same icon |
| Hover card of a chip | only „Im Browser öffnen“; the issue view only by clicking the title | both buttons in the card's head, always in view; the title still opens the view |
| Briefing, issue rows | only „Im Browser öffnen“, and only when the issue had an address (rows of different widths) | both buttons on every row |
| Plan block (calendar) | „Issue öffnen“ | „In der Issue-Ansicht öffnen“ and „In Jira öffnen“, kept together when the row wraps |
| Booking's issue key (Zeiterfassung) | title „Als Fenster öffnen“ | title „In der Issue-Ansicht öffnen“ |
| Palette | „Issue öffnen…“, „Issue {key} öffnen“ | unchanged (commands, not buttons) |
| Issue view header while loading | only Close; „In Jira öffnen“ and „Weitere Aktionen“ appeared next to it once loaded | the same buttons at the same places from the start |

## Findings

| # | Symptom | Root cause | Fix | Test |
|---|---------|------------|-----|------|
| J1 | Issues list: on hover the row icons cover the status pill (`IN PROGRESS` cut under the issue view icon, 103 screenshot) | the actions (5 × 22 px + gaps, 126 px with the inset) are positioned absolutely; the row made room only with `padding-right: 112px` | three actions (view, Jira, more; note and copy are in the menu), `padding-right` sized for them | 412: status right edge left of the actions, at 900/1480/1920 px |
| J2 | Issues list: hovering a row moves its summary, sprint, assignee and status 112 px to the left | the room for the actions was added only on `:hover`/`:focus-within`/`.open` | the room is always kept; only the actions' opacity changes | 412: summary and status rects equal with and without hover |
| J3 | the issue view button had four names: „Als Fenster öffnen“ (it is no window), „Vollansicht“, „Issue öffnen“, „In der Issue-Ansicht öffnen“; the browser one two („Im Browser öffnen“, „In Jira öffnen“); the menu orders differed between the list and the widgets | each place had its own button | one label pair (`iv.openView`, `iv.openInJira`), one icon constant, one component, one menu order | 412: labels, order and icon in list, menu, opened row, hover card, plan block |
| J4 | hover card: the issue view could only be reached by knowing that the title is a link; the card was `role="tooltip"` with buttons in it | the card was built as a link preview with one browser button | both buttons in the head; `role="dialog"` named by the key | 412: buttons in the card, visible, click opens the view and closes the card |
| J5 | hover card above a chip near the bottom floated up to ~150 px away from the chip when the card was short | the top was computed from the maximum height (280 px), not the card's height | above the chip the card is anchored by its bottom edge | 412: card bottom 0–12 px above the chip |
| J6 | hover card: description excerpt with a blank line between every paragraph (104 screenshot), so only two lines of text fit | Jira's plain text has `\n\n` between paragraphs and the excerpt uses `pre-line` | runs of blank lines become one line break | 412: no blank line in the excerpt |
| J7 | issue view: the „In Arcalo“ values (Bucht auf, Gebucht) 16 px right of the details column | `.iv-fields.compact` gave that list a 96 px label column, the details 112 px (104 px below 1100 px) | the compact override removed | 412: left edge of „Bucht auf“'s value equals the details' |
| J8 | issue view: „Resolved 29 Sept / 2026 · Won't / Fix“ broken into two squeezed columns (147 screenshot) | date and resolution were two flex items of `.iv-value` with `overflow-wrap: anywhere` | one inline text | 412: the date's `<time>` is one line box |
| J9 | issue view: „Booked 0.50“ without unit | `fmtMinutes` (the number only) instead of `fmtDuration` (the app's one way to show hours) | `fmtDuration` there and in the list's opened row | 412 screenshots |
| J10 | a second Ctrl+Enter in the comment box while Jira answers posts the comment twice; the same for Enter in „Jira-Issue anlegen“ (two issues), the summary, a field, the description, a transition's comment and the work log | the handlers checked no running request; `busy` disabled only the button, and only a render later | `lib/singleFlight.ts`: a write runs once at a time, a second call is dropped | 412 with a slow fake Jira (`state.writeDelayMs`): one comment POST, one issue POST; `singleFlight.test.ts` |
| J11 | Zeiterfassung: a failed worklog badge drawn with a red frame | `border-color` mixed from `--danger` (a colored border for a state, against CLAUDE.md) | a danger tint, no frame | 118: border transparent, background tinted |
| J12 | issue view: the comment order („Neueste zuerst / Älteste zuerst“) as large as the tabs above it | the default `Segmented` size | the compact size in the list tools | 412 screenshots |

## Checked and fine

- Issue chips in notes (104 screenshots: at line start, mid-sentence, wrapped, in a heading, list, task and table,
  unknown keys dashed), dark theme.
- The issue view's sections, editing, transitions with a screen, comments, work log, history, conflicts, offline
  copy, 500 comments and 100 attachments, the phone sheet (146, 147, 153), contrast (146 checks 4.5:1).
- Jira settings (site dialog, certificate error, saved searches, sync), Server vs Cloud labels (105, 160).
- Start page widgets (103): rows open the view, the menu has the shared order now.
- Empty, error and offline states of the Issues list (104: banner with the cached issues).

## Not changed

- The hover card is still opened by the mouse only (chips are text decorations, not focusable); from the keyboard an
  issue opens with the palette („Issue öffnen…“, a typed key) or from the Issues list.
- The website text for 1.22 (`docs/quality/q122/website-jira-issue-view.md`) now names the new labels; the website
  itself is in its own repository.
