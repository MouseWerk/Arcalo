# q116 visual audit: findings

Build: prebuilt `q116/visual/bin/arcalo` (main, reports itself as 1.0.0). Driven with a copy of the e2e harness
(`q116/visual/walk/`, scripts `walk.mjs`, `fresh.mjs`, `w.js`, `seed.js`), Xvfb :503, own PIDs only.
Screenshots: `q116/visual/shots/` (prefix = `<lang>-<theme>-<width>-<screen>`; `onb-*` intro and setup,
`empty-*` fresh workspace, `aioff-*` "KI verwenden" off). DOM audit per screenshot (colored left bars and
borders, colored glows, outlines without focus, ellipsis without tooltip, sideways scrollbars, German left in
English, "Sie"): `q116/visual/audit-*.json`.

Seeded: the demo workspace plus a page with every block type (formatting, lists, tasks with due/prio/repeat,
quote, three callouts, table, code, Mermaid, query, page/image/PDF/drawing embeds), a very long page title,
bookings this and last week, the calendar fixtures (Outlook, Team ICS subscription, Projektplan ICS, a meeting
running now), a fake LiteLLM and a fake local embedding model (meaning search).

Coverage (each screen at least in German light, dark and high contrast dark at 1280x800 and English dark 1280 /
English light 1920; most also German light 900x700 and high contrast light 1920x1080):
start page (both boards, customize), tree and context menu, tabs and tab menu, editor (all blocks, bubble menu,
slash menu, table toolbar, page "more" menu, editor context menu), source view, split panes (page + tasks,
calendar, timesheet, many tabs), command palette and quick switcher (empty, query, no results), search sidebar
(exact, "ähnlich", no hits), calendar (day, work week, week, month, list, event detail), timesheet, projects,
tasks (+ context menu), week review, day review, briefing, activity, graph, chat view, assistant panel (answer,
outline, links, local graph), all 21 settings sections (top and bottom), help, focus dialog, week proposal,
trash, attachments, PDF viewer, delete confirmation and toast, canvas, drawing embed and editor, intro (5
scenes) and setup (7 steps) in de light 1280 / en dark 1920 / de contrast dark 900, fresh empty workspace
(every main view) in light and contrast dark, AI-off mode at 1280 and 1920.

Severity: **High** = rule violation or visibly broken/misleading on a main screen; **Medium** = clear polish
defect a demanding user notices; **Low** = small inconsistency.

---

## High

### V1 High: colored left bars in "Termine buchen" (timesheet) and the start page agenda
- Screen: Zeiterfassung > "Termine buchen" list; start page "Termine" widget rows; all themes, all sizes.
- Wrong: each meeting row starts with an 18 px (timesheet) / 16 px (widget) vertical bar in the calendar color
  in front of the time. CLAUDE.md: "No colored bars on the left side anywhere". The calendar's own list view
  already uses a round dot for the same information, so the app is also inconsistent with itself.
- Shot: `shots/en-light-1920-timesheet.png` (rows at y 818-941), `shots/de-light-1280-timesheet-bottom.png`.
- Files: `ui/src/styles/app.css:2116` `.ts-meeting-bar`, `app.css:2110` `.dw-agenda-bar`
  (`ui/src/views/TimesheetView.tsx:909`).
- Fix: use the 6-8 px round dot of `.calv-agenda-bar` (`app.css:1994`) for both; same size and alignment as the
  calendar list.

### V2 High: fresh install punishes day one again (regression of q115 finding 6)
- Screen: fresh workspace ("Leer" start), Zeiterfassung > Wochenübersicht and assistant panel; de light 1280,
  contrast dark 1280.
- Wrong: "Unter Soll: Mo 5. -8,00 h, Di 6. -8,00 h, Mi 7. -8,00 h, Do 8. -8,00 h" in red chips plus
  "Lücken füllen", and the assistant suggests "Lücken in der Zeiterfassung prüfen (Mo, Di, Mi, Do)" for days
  before Arcalo existed. Same red day cards in the week review and week proposal.
- Shot: `shots/empty-de-light-timesheet.png`, `shots/empty-de-contrast-dark-timesheet.png`,
  `shots/empty-de-light-weekreview.png`.
- Files: timesheet under-target row (`ui/src/views/TimesheetView.tsx`), suggestions
  (`ui/src/lib/suggestions.ts`), week review (`ui/src/lib/weekreview.ts`).
- Fix: count target hours only from the first day with any booking or from the install date (whichever is
  later); no gap suggestion before that day. Add the fresh-workspace case to the q115 e2e.

### V3 High: projects table is cut off with an overlapping scroll button
- Screen: Projekte; de/en, light/dark/contrast, 1280 with side panel and 900 without.
- Wrong: the Vorgänge table is wider than the card; the last column ("Rest") is cut mid-number ("0,", "24,"),
  a round ">" scroll button sits on top of the header cell, and the table scrolls sideways inside the card
  (audit: `div.table-wrap` 864 > 548 px). Looks broken rather than designed.
- Shot: `shots/de-dark-1280-projects.png`, `shots/de-dark-1280-projects-bottom.png`,
  `shots/de-light-900-projects.png`.
- Files: `ui/src/views/wbs.tsx`, `ui/src/views/ProjectsView.tsx`, `ui/src/styles/app.css` (`.vorgaenge`,
  `.side-scroll > .table-wrap`).
- Fix: below ~900 px of card width drop the low-priority columns (Termin/Puffer, Rest) into a second line or a
  container query layout; keep the side-scroll affordance outside the header row and fade the cut edge.

### V4 High: hard-coded German in the English UI
- Screen: English, PDF embed in a page ("3 Seiten · 1.7 kB"), tag view subtitle ("n Seiten").
- Wrong: mixed languages; the translation check does not catch template literals.
- Shot: `shots/en-light-1280-page-mid2.png` (`q116/visual/audit-en-light_1280x800-*.json`, "3 Seiten").
- Files: `ui/src/editor/fileEmbed.ts:207`, `ui/src/views/TagView.tsx:27`.
- Fix: `t("pdf.pages", { n })` / `t("tag.pages", { n })` with de/en plural entries.

### V5 High: calendar day headers spill out of the last column, stray tooltip
- Screen: Kalender work week at 1280 with side panel and at 900; de/en, all themes.
- Wrong: the Friday header's icon row (note, tasks, export) runs past the right edge and is clipped
  mid-icon; the booked-hours chips of Mo-Do show a trailing clipped glyph ("12,00 h ,"). The tooltip
  "Abwesenheit eintragen" / "Enter absence" stays visible over the header after switching the view with no
  pointer on it.
- Shot: `shots/de-dark-1280-calendar-workweek.png`, `shots/de-light-900-calendar-workweek.png`,
  `shots/en-dark-1280-calendar-workweek.png`.
- Files: `ui/src/styles/app.css:1839-1850` (`.calv-dayhead`, `.calv-dayhead-info`), tooltip trigger in
  `ui/src/lib/tooltip.ts`.
- Fix: in a narrow column (`container: calcol` already exists) collapse the day actions into one overflow
  button and drop the "h" unit; tooltips only on hover/`:focus-visible`, never on programmatic focus after a
  view switch.

## Medium

### V6 Medium: booked time in the calendar collapses to stray gray lines
- Screen: Kalender work week/week at 1280 (with panel) and 900.
- Wrong: the booked-time blocks next to the meetings shrink to 2 px vertical gray lines in every column
  (only the draft stripe is left), which reads as a rendering glitch. At 1920 the same blocks show as hatched
  "NP-88…" strips.
- Shot: `shots/de-dark-1280-calendar-workweek.png` (lines at x 471, 579, 687, 795),
  `shots/en-light-1920-calendar-workweek.png` for comparison.
- File: `ui/src/styles/app.css:1926-1947` (`.calv-entry`, `.status-draft` 2 px left gradient).
- Fix: give booked blocks a minimum width (e.g. 14 px) with only the hatch, or show them as a thin summary
  bar under the day header when the column is narrower than ~140 px.

### V7 Medium: calendar texts reduced to single letters
- Screen: Kalender month (1280 + panel), work week in split panes, start page timeline strip (all sizes).
- Wrong: month cells show "10:00 J…", "08:00 A…"; split-pane events "Ab…", "Jo…"; the start page day
  timeline shows chips "V", "…", "Ku…". None has a tooltip (audit: `calv-ev-title` truncated without title,
  25+ hits). The information is not readable at all.
- Shot: `shots/de-dark-1280-calendar-month.png`, `shots/de-dark-1280-split-page-calendar.png`,
  `shots/de-light-900-home.png`, `shots/en-light-1920-home.png`.
- Files: `ui/src/styles/app.css:1894-1904` (`.calv-ev-title`, `.calv-mev`), `ui/src/styles/dashboard.css:177`
  (`.dw-tl-ev`).
- Fix: in month cells below ~110 px hide the time and keep the dot + title; below ~40 px show dots only and
  rely on the day detail; timeline chips without room show no text (color only) and all get `data-tooltip`
  with title and time.

### V8 Medium: start page "Fällig"/"Aufgaben" widgets truncate the task, not the page
- Screen: Startseite Heute and Projekte boards; 900, 1280, 1920.
- Wrong: the task title is cut to 4-10 characters ("Überfällig…", "Überf…", "Morgen fäl…") while the source
  page and the "überfällig" chip keep their full width; the row with a priority chip ("hoch So., 11.10.")
  loses its title completely ("A"). The task is the content, the page is metadata.
- Shot: `shots/de-light-900-home-board2.png`, `shots/de-contrast-dark-1280-home.png`,
  `shots/en-dark-1280-home.png`.
- Files: `ui/src/styles/dashboard.css:116` (`.dw-task`), widget in `ui/src/components/dashboard/widgets/`.
- Fix: title `flex: 1 1 auto; min-width: 40%`, page name `flex: 0 1 auto; max-width: 40%`, chips `flex: none`;
  hide the page name first when narrow.

### V9 Medium: sideways scrollbars in split panes and widgets
- Screen: split view (page | tasks/calendar/timesheet), start page "Projekt" widget.
- Wrong: the left page pane shows a horizontal scrollbar under the editor (audit `div.page-scroll` 314 > 293,
  `div.editor-toolbar` 125 > 95); the tasks view in the right pane scrolls sideways (`div.view-scroll`
  394 > 293); the "Projekt" widget scrolls sideways and cuts "115 %", "120,0" at the right edge.
- Shot: `shots/de-dark-1280-split-page-calendar.png` (bottom of left pane), `shots/de-dark-1280-split-page-tasks.png`,
  `shots/de-light-900-home-board2.png`.
- Files: `ui/src/styles/editor.css` (inline code/`.page-scroll` min widths, toolbar), `ui/src/styles/app.css`
  (`.view-scroll` tasks header), `ui/src/styles/dashboard.css` (`.dw-body`).
- Fix: `overflow-wrap: anywhere` for inline code in narrow panes, toolbar overflow menu instead of scroll,
  wrap the tasks header controls, container query for the project widget rows.

### V10 Medium: page title breaks inside words in narrow panes
- Screen: split view, long title.
- Wrong: "Seitenübersc / hrift" and "Gestaltung / aller Blöcke" at 40 px size in a 300 px pane; broken
  mid-word without hyphen.
- Shot: `shots/de-dark-1280-split-tabs.png`, `shots/de-light-900-split-tabs.png`.
- File: `ui/src/styles/editor.css:22` (`.page-title`).
- Fix: `hyphens: auto` with `lang` set, `overflow-wrap: break-word` (not `anywhere`), and scale the title
  font with the pane width (`font-size: clamp(var(--fs-xl), 6cqi, var(--fs-title))`).

### V11 Medium: tab bar shows a half-faded ghost tab in narrow panes
- Screen: split view with several tabs.
- Wrong: next to the home button a 30 px fragment of a tab ("[." / "CAT…") is visible under the left fade
  mask, and the active tab shrinks to "Sehr …". Looks like a glitch rather than scrolled tabs.
- Shot: `shots/de-dark-1280-split-tabs.png`, `shots/de-light-900-split-tabs.png`.
- File: `ui/src/styles/app.css:364-366` (`.tabs.fade-left`).
- Fix: scroll the active tab fully into view with the neighbour either fully shown or fully hidden, or
  give tabs a min width (~96 px) and let the overflow chevron list the rest.

### V12 Medium: colored outline for "gap" days in "Zeit diese Woche"
- Screen: start page widget "Zeit diese Woche", dark 1920 (AI off) and others when a day is under target.
- Wrong: the bar track of a gap day gets a 1 px amber inset outline (`box-shadow: inset 0 0 0 1px
  var(--warning)`), a colored border as a state marker.
- Shot: `shots/aioff-de-dark-1920-home.png` (audit hit `span.dw-bar-track … rgb(251,191,36) inset`).
- File: `ui/src/styles/dashboard.css:235`.
- Fix: neutral treatment: warning-tinted track fill (`--warning-soft`) and the weekday label in warning
  text color; no outline.

### V13 Medium: tag suggestions use dashed accent borders on every page
- Screen: every page header ("Vorschlag: # architektur ×"), all themes; strongest in contrast dark (cyan).
- Wrong: accent-colored dashed chip borders (violet for new tags) above the content of almost every page -
  the "AI look" the design rules avoid, and visual noise at the top of every note.
- Shot: `shots/de-dark-1280-page-top.png`, `shots/de-contrast-dark-1280-page-top.png`,
  `shots/de-dark-1280-canvas-cards.png` (four chips).
- File: `ui/src/styles/editor.css:1311-1316`.
- Fix: neutral `--bg-hover` filled chips with `--text-2` and the accent only on hover; collapse to
  "2 Tag-Vorschläge" when more than two.

### V14 Medium: same week, opposite messages about "Lücken"
- Screen: start page "Zeit diese Woche" says "Keine Lücken"; week review and timesheet say "Mo 5. 3 Lücken,
  Di 6. 1 Lücke …" and "Ohne Buchung" for the same week; budget widget shows "Im Plan" next to amber
  "Aufgebraucht in 11 Tagen".
- Shot: `shots/en-light-1920-home.png` ("No gaps"), `shots/de-contrast-light-1920-weekreview.png`,
  `shots/aioff-de-dark-1920-home.png` (budget).
- Files: `ui/src/lib/workwidgets.ts`, `ui/src/lib/weekreview.ts`, locales `de.ts`/`en.ts`.
- Fix: one term per concept: "Lücke" = hours missing to target; unbooked meetings = "nicht gebuchte Termine".
  Budget badge follows the forecast (warning when it runs out before the plan end).

### V15 Medium: inconsistent hour formats on one screen
- Screen: week review / day review / timesheet / briefing.
- Wrong: "49,5 h" and "49,50 h", "0 h", "0,00 h" and "0:00 h" (focus) for the same unit, sometimes in one
  card row.
- Shot: `shots/de-dark-1280-weekreview.png`, `shots/de-dark-1280-dayreview.png`,
  `shots/de-dark-1280-timesheet.png`.
- Files: `ui/src/lib/format.ts` callers in `WeekReviewView.tsx`, `DayReviewView.tsx`, `TimesheetView.tsx`.
- Fix: one helper for hours (decimal with the locale's separator, two decimals in tables, one in summary
  tiles) and use it for focus time too.

### V16 Medium: timesheet entry descriptions cut to ~10 characters
- Screen: Zeiterfassung > entries, 1280 with panel and split pane.
- Wrong: "Schulungsun…", "Abstimmung …", "Datenmigrati…" without tooltip (audit: `span.entry-desc` 579 > 95
  px), while every row repeats an identical "Entwurf" badge.
- Shot: `shots/de-dark-1280-timesheet-bottom.png`.
- File: `ui/src/styles/app.css` (`.entry-desc`, entry row grid), `ui/src/views/TimesheetView.tsx`.
- Fix: description gets the flexible column, status badge only when it differs from the day's default
  (or as an icon), `title` on the description.

### V17 Medium: meaning search lists everything as "ähnlich" for nonsense queries
- Screen: search sidebar, query "qqqxyz": "9 Seiten · 9 nach Bedeutung", every page tagged "ähnlich"
  with unrelated snippets ("2026-10-09 []").
- Shot: `shots/de-dark-1280-search-empty.png`, `shots/de-light-1280-search-empty.png`.
- Files: `ui/src/components/Sidebar.tsx` (search results), `crates/arcalo-core/src/semantic.rs` (threshold).
- Fix: minimum similarity before a result is shown; with no exact hits and only weak meaning hits show
  "Keine Treffer" plus "Ähnliche Seiten anzeigen" collapsed. (The fake embedding model exaggerates the
  effect, but no threshold is visible.)

### V18 Medium: query block table shows raw Markdown and misaligned checkboxes
- Screen: page with a `query` block (tasks, table), all themes.
- Wrong: task cells show "[[Weekly sync 22.09.]]" and "[[PRJ-2026-X Rollout]]" literally; the checkbox
  column is ~60 px wide with the box top-aligned while the text is vertically centered.
- Shot: `shots/en-light-1920-page-mid2.png`, `shots/de-contrast-dark-1280-page-mid2.png`.
- Files: `ui/src/editor/` query renderer (`.qb`), `ui/src/styles/editor.css:1269` (`.qb-check`).
- Fix: render task text through the inline Markdown renderer used by the tasks view; checkbox column
  `width: 28px; vertical-align: middle`.

### V19 Medium: intro scene "Zeit" at 900 px falls apart
- Screen: intro scene 4, de contrast dark 900x700.
- Wrong: the note card sits top left, the chart card far lower right, a 100 px empty band between them;
  the composition no longer reads as one board.
- Shot: `shots/onb-de-contrast-dark-900-scene4.png`.
- File: `ui/src/styles/firstrun.css` (scene layout).
- Fix: below 1000 px stack the two cards with a fixed 16 px gap, centered, and scale the visual.

### V20 Medium: AI surfaces doubled in a fresh workspace without AI
- Screen: fresh workspace, chat view open: the chat view and the side panel both show "Keine KI verbunden …
  KI einrichten" (dashed box) plus AI suggestion chips; status bar "KI einrichten".
- Shot: `shots/empty-de-light-chat.png`, `shots/empty-de-light-timesheet.png`.
- Files: `ui/src/views/ChatView.tsx`, `ui/src/panels/` assistant empty state.
- Fix: one place for the setup hint (the view in focus); hide the panel's suggestions while no provider is
  configured.

### V21 Medium: truncation without tooltip in tree and search results
- Screen: tree, search sidebar, palette snippets, review stat subtitles ("3 nicht gebucht …").
- Wrong: audit found 80+ ellipses without `title`/`data-tooltip` (`span.tree-label`, `span.side-result-name`,
  `span.rv-stat-sub`, `span.select-label`, `span.pal-snippet`).
- Shot: `shots/de-dark-1280-dayreview.png` ("3 nicht gebucht …"), `shots/de-dark-1280-search-empty.png`.
- Files: `ui/src/components/Sidebar.tsx`, `ui/src/views/DayReviewView.tsx`, `ui/src/components/Select.tsx`.
- Fix: a shared `<Ellipsis>` that sets `data-tooltip` only when `scrollWidth > clientWidth`.

## Low

### V22 Low: Mermaid edge labels on gray boxes
- All themes: "ja"/"nein" labels sit on a light gray rectangle that matches neither light nor dark
  background. Shot: `shots/de-contrast-dark-1280-page-mid2.png`, `shots/en-light-1920-page-mid2.png`.
  Fix: set `edgeLabelBackground` in the Mermaid theme variables from `--bg-canvas`.

### V23 Low: URLs in settings render as "http: //127.0.0.1"
- AI providers, network proxy, backup paths: a visible gap after "http:" in the mono font (JetBrains Mono
  contextual alternates). Shot: `shots/de-dark-1280-settings-ai.png`, `shots/de-dark-1280-settings-network.png`.
  Fix: `font-variant-ligatures: none; font-feature-settings: "calt" 0` on settings mono text (as
  `app.css:3953` already does for JQL).

### V24 Low: search snippets mangle code
- "p.filter((x) ⇒ x.name.trim() ! "")": `!==` loses `==` (highlight syntax stripped) and `=>` is shown as an
  arrow. Shot: `shots/de-light-900-search-sidebar2.png`. File: plain-text snippet builder
  (`ui/src/lib/plaintext.ts`). Fix: skip Markdown inline stripping inside code spans/fences.

### V25 Low: theme picker marks the active theme twice
- Settings > Darstellung: "Aktiv" accent badge and a check mark on the light card, only the check mark on
  the dark card. Shot: `shots/en-light-1920-settings-appearance.png`,
  `shots/de-contrast-light-1920-settings-appearance.png`. Fix: keep the check mark only; the mode switch
  already says which one is in use.

### V26 Low: same action, different labels
- Week review "Zusammenfassen" vs day review "Zusammenfassung schreiben"; the day review's primary
  button wraps alone onto a second row at 1280 with panel. Shot: `shots/de-dark-1280-dayreview.png`,
  `shots/de-dark-1280-weekreview.png`. Fix: one label ("Zusammenfassen"), keep the toolbar on one row.

### V27 Low: timesheet toolbar wraps into three rows in a split pane
- Shot: `shots/de-dark-1280-split-page-timesheet.png`, `shots/de-light-900-split-page-timesheet.png`.
  Fix: put week navigation and actions in one row with an overflow menu below ~420 px.

### V28 Low: slash menu hints and subtitles cut without tooltip
- "```query" hint and "Live-Liste von Aufgaben, Seiten, Buch…" are clipped. Shot:
  `shots/de-light-1280-slash.png`, `shots/de-light-1280-slash-filtered.png`. Fix: two-line subtitle or
  `data-tooltip`.

### V29 Low: empty graph splits its message
- Fresh workspace graph: "Nichts anzuzeigen" at the top, the hint at the bottom of the canvas. Shot:
  `shots/empty-de-light-graph.png`. Fix: one centered empty state block.

### V30 Low: about page shows "Version 1.0.0"
- Settings > Über / "Neu in Arcalo": the build reports 1.0.0 (workspace version in `Cargo.toml` and
  `tauri.conf.json`); release builds set the real version, but dev and e2e screenshots used for the website
  will show 1.0.0. Shot: `shots/de-dark-1280-settings-about.png`.

---

## Checked and fine

- No accent borders, glows or left bars for selected/active/current states in the tree, tabs, palette,
  settings nav, segmented controls, task rows or calendar events (neutral tint; contrast themes add a
  neutral 1 px edge as designed). Callouts use a tinted background and an icon, the plain quote a thin gray
  line. Keyboard focus is neutral (`--border-focus`).
- No "Sie" form: the audit's hits are "sie/Sie" as third person at sentence start ("Sie bleiben auf diesem
  Computer").
- English UI: apart from V4 only user/fixture content is German (event titles, demo bookings, the fake
  model's answer text "Zusammenfassung …").
- Context menus, toasts, delete confirmation, focus dialog, week proposal, PDF viewer, attachments, trash,
  activity, briefing, chat view at 1280 and 1920 look consistent in all three themes.

Note: the working tree has an untracked `crates/arcalo-core/tests/zz_tmp_perf116.rs` that this audit did not
create (another q116 agent); this audit wrote nothing into the repo.
