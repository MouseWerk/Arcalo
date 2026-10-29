# q123 sweep: every view, menu and dialog photographed

Owner, 2026-10-29: „noch viele weitere Bugs überall ... also mal wirklich alles testen was es gibt und auch
alle UIs und Systeme“. This round covers everything except the areas other rounds took in parallel: images in
the editor, the presentation view, drawings (Excalidraw, Mermaid) and the Jira UI. Branch `q123-sweep`.

## Machinery

`e2e/tests/412-sweep-tour.test.js` visits, in each of six combinations, the start page, the sidebar (files,
search, favorites, tags, the new and tree menus, a page's context menu), a page with every block type (headings,
marks, lists, tasks, quote, callouts, foldable callout, columns, table of contents, code, table, rule, query,
footnote), the page menu, the slash menu, the table toolbar, the tab menu, a split pane, a table and a board of
child pages, the command palette (empty, with hits, without hits), the quick switcher, the sidebar search, the
calendar (day, work week, week, month, list), the date picker, Zeiterfassung and its export, projects, tasks,
graph, activity, briefing, daily review, chat, assistant, focus, the help menu, trash, attachments, week review,
templates, shortcuts, release notes, duplicates, status report, meeting preparation, tidy-up, bookmark import,
e-mail import, local graph, chat history, every settings section from top to bottom, the capture window and the
lock screen.

| Combination | Language | Theme | Size | Stops |
|---|---|---|---|---|
| de-light-1480 | de | Arcalo Hell | 1480x920 | all, capture, lock |
| de-dark-900 | de | Arcalo Dunkel | 900x700 | all |
| de-hcdark-1920 | de | Hoher Kontrast Dunkel | 1920x1080 | main views, four settings sections |
| en-hclight-1480 | en | High Contrast Light | 1480x920 | all, capture, lock |
| en-dark-900 | en | Arcalo Dark | 900x700 | main views, four settings sections |
| en-light-1920 | en | Arcalo Light | 1920x1080 | main views, four settings sections |

Every stop is photographed (`sweep-<combination>-<nr>-<stop>.png`) and checked by the layout audit
(`e2e/lib/layout-audit.js`: clipped text, controls out of their box, overlaps, sideways scrolling, dropdowns
too narrow); the English runs also by the German-word check. A stop that cannot be reached is a finding, and the
tour asserts at the end that there are none. What the audit reports by design (card buttons on several lines,
the scroll outline's marks, the page icon left of the title, the board's own scrolling) is listed with its reason
in the test. UI texts come from the catalogs (`e2e/lib/catalog.js`), so the same tour runs in both languages.

## Findings

| # | Symptom | Root cause | Fix | Test |
|---|---|---|---|---|
| S1 | The tooltip of „Weitere Aktionen“, the help button and the sidebar's menu buttons covered the first items of the menu they had just opened. | The pointer rests on the button after the click; the tooltip came back after its delay over the open menu. | `lib/tooltip.ts`: no tooltip for a menu opener (`aria-haspopup`) while a menu is open, and one already shown goes. | `tooltip.test.ts`; tour checks every menu it opens |
| S2 | „Fußnoten“ stood above a query block's result instead of above the footnotes. | Both are widgets at the same position (the result after the code block, the heading before the first footnote), both `side: -1`; the order then follows the plugins. | `editor/blocks.ts`: the heading is `side: 1`, it belongs to what follows. | tour (heading between query result and footnotes) |
| S3 | The table toolbar stood at the far right of the note, over the block above a narrow table. | It was placed at the end of the table node's element, the scroll wrapper as wide as the note. | `TableToolbar.tsx`: placed at the `<table>`, cut to the part the wrapper shows. | tour (toolbar ends where the table ends) |
| S4 | The quick switcher (Strg+O) offered „/zeit buchen · ? fragen · # Tag“, which it does not do. | The footer hint was shown in both palette modes. | `CommandPalette.tsx`: hint only in the full palette. | tour |
| S5 | In the calendar's day view (and with a long range title) the tools jumped from the right edge to the left. | The header wraps its tools onto a second row, where `space-between` puts them at the start. | `.calv-tools { margin-left: auto }`. | tour (tools end at the same x in every view) |
| S6 | A date picker opened with the mouse showed a frame around today. | The keyboard cursor `.cal-day.focus` was drawn whenever the picker had focus, also after a click (CLAUDE.md: focus only on `:focus-visible`). | Drawn only under `.calendar:focus-visible`. | `styles.test.ts` |
| S7 | A dark line ran through the release notes dialog (Linux); widgets showed a dark bar instead of the app's scrollbar. | `scrollbar-width: thin` hands the bar to the engine: WebKitGTK draws its own overlay bar, always visible and above dialogs; Chromium drops the app's `::-webkit-scrollbar` styles. | The six areas use a thin `::-webkit-scrollbar` (base.css). | `styles.test.ts` (no `scrollbar-width: thin`) |
| S8 | Settings → Darstellung: the editor font switch sat below its label at 1480 px with both side panels. | A row's label column wanted 200 px before the control could stay beside it. | `.set-row-text` basis 160 px. | tour (de-light-1480) |
| S9 | The network field of the timer cut „NP-8801 · Systemintegration ERP“ in a wide window while the description field was half empty. | Column weights 1.3 / 2 for network / description. | 1.6 / 1.4. | tour audit (dropdown too narrow) |
| S10 | Start page widget titles were cut („ZULETZT BE…“) in the default layout. | The hidden gear and menu buttons reserved their room in the header. | They lie over the header's end and get the card's background while shown (touch screens keep the old layout). | tour audit (clipped text) |
| S11 | Settings → Tastatur listed „Umschalt F10 oder ContextMenu“. | The key name table had no entry for the menu key. | „Menütaste“ / „Menu key“ (`lib/shortcut.ts`, catalogs). | `shortcut.test.ts` |
| S12 | Settings → Desktop said „Mit Windows starten“ on Linux. | Only macOS had its own wording. | „Bei der Anmeldung starten“ / „Start at login“ on Linux. | `13-desktop` (label), `400-android-full-app` (gone) |
| S14 | The status report dialog opened with the focus in „Name der Vorlage“ at its bottom. | `Dialog` focuses the first `input`; the fields above it (project, period, sections) are the app's own dropdown and buttons. | The project dropdown is marked `data-autofocus` (`Select` passes it on). | tour |
| S13 | Settings → Notizen: the path example read `C:\Users\du\Obsidian\Vault` („you“ in English). | The du-form had reached a user name. | `C:\Users\…\Obsidian\Vault`, like the calendar file example. | – (catalog text) |

## Looked at, not changed

- Release notes in a development build show `v1.0.0.md` („Annalo 1.0.0“, English): the build's version is
  1.0.0; a release shows its own notes. The notes files are English by design.
- The English daily-note folder is „Journal“ (`notes::JOURNAL_TITLE`, migrated settings keep it).
- Global shortcut fields show the stored form („Ctrl+Shift+O“); the tests and the settings file use it.
- A fresh workspace lists the default LiteLLM provider as „Keine Verbindung“ (no server configured yet).
- The board and wide collection tables scroll sideways inside their own area (by design).

## Notes for the other areas

- Presentation, drawings, Mermaid, images: nothing seen on the tour (their views were not opened).
- Jira: Settings → Jira was photographed with no site configured; nothing to report there.

## Runs

| Run | Result |
|---|---|
| local, 412 on `main` + tour | 6 combinations, 473 screenshots, findings S1–S13 |
| CI 40847542891 | Core red before the e2e step: `datadir` test red on `main` (fixed there, merged) |
| CI 40853105746 | all jobs green but Core: only 412 red (narrow settings not reached, release notes text, S14); S1–S13 confirmed in the screenshots |
