# q116 – Accessibility, keyboard and text audit (1.15.0, main de27e1c)

Scope: keyboard reach and focus handling, screen reader semantics, contrast in light, dark and the
built-in themes, and every German and English UI text (`ui/src/locales/de.ts` and `en.ts`, 5982 keys
each, plus the 1203 backend `tr!`/`trf!` pairs).

Method:
- Code read of `components/ui.tsx` (Dialog, Menu), `Shell.tsx` (toasts, confirm), `App.tsx` and
  `lib/keymap.ts`/`lib/shortcut.ts`, `KeyboardSection.tsx`, the calendar, timesheet, week review,
  dashboard, editor suggestion popups, onboarding, and `src-tauri/src/appmenu.rs`.
- The real app (prebuilt binary `q116/a11y/bin/arcalo`) under my own Xvfb `:505` with the e2e harness's
  environment (`appEnv`). I used my own launcher, which kills only the PIDs it started. I ran it twice:
  German with the demo workspace, then English with onboarding. I recorded Tab walks, the focused
  element after each step, ARIA attributes, headings and tables in each view. Two ICS fixtures from
  `e2e/lib/calendar-fixtures.js` filled the calendar. Scripts and screenshots are in `q116/a11y/`.
- Contrast was computed with `lib/color.ts` `contrast()` over `themeTokens()` of every
  `BUILTIN_THEMES` entry, loaded through Vite's SSR loader (`q116/a11y/contrast.mjs`). These are cases
  `contrast.test.ts` does not cover.
- Text scans in Python over both catalogs and the backend pairs (`q116/a11y/chk.py`), for the cases
  `translations.test.ts` does not catch.

The existing guards are good, and nothing here repeats what they already enforce: icon-only button
names, hard-coded strings, the glossary, typography, the address form, base text contrast,
forced-colors, the palette combobox and the tree keyboard. Findings marked "seen" were reproduced in
the app. Findings marked "code" are confirmed from the source only (macOS, IME). "calc" means
computed.

Severity: **High** = blocks a feature for keyboard or screen reader users, or risks data loss.
**Medium** = clear WCAG AA failure or significant friction in a core flow. **Low** = polish or
consistency.

---

## Accessibility (screen readers, semantics, contrast)

### A1 – High – Editor suggestion menus are silent for screen readers (seen)
- Where: `ui/src/editor/suggestion-popup.tsx` (`role="listbox"`, options with `aria-selected`) and
  the TipTap suggestion plugins for slash, `[[`, `#` and `/zeit` in `editor/extensions.tsx` and
  `schema.ts`.
- What: while the slash menu is open and the user arrows through it, the focused `.ProseMirror` has
  no `aria-expanded`, `aria-controls` or `aria-activedescendant`, and options have no ids
  (checked live: all null). No live region announces the chosen item. A screen reader user types `/`
  or `[[` and hears nothing; they cannot tell what Enter will insert. That makes slash commands, page
  links, tags and `/zeit` bookings practically unusable for them.
- Fix: while a suggestion is open, set `aria-expanded="true"`, `aria-controls=<listbox id>`,
  `aria-autocomplete="list"` and `aria-activedescendant=<option id>` on the editor DOM (an
  `editorProps.attributes` function, or a small plugin view that writes them). Give each option
  `id="sugg-<n>"`. As a fallback for WebKitGTK, mirror the chosen title into a polite sr-only region.
- Test: an e2e test types `/` and ArrowDown in a note, then asserts that the editor's
  `aria-activedescendant` points to the option with `aria-selected="true"` and that `aria-expanded` is
  true; after Escape it is false. Add a unit test of the attribute helper.

### A2 – Medium – Dialogs announce only their title; the confirm is not an alertdialog (seen)
- Where: `components/ui.tsx` `Dialog` (`role="dialog" aria-label={title}`) and `Shell.tsx`
  `ConfirmHost`.
- What: the description and the message (`<p class="dialog-text">`) are not linked. „Papierkorb
  leeren?“ was announced without „Das kann nicht rückgängig gemacht werden.“ (live:
  `aria-describedby=null`). The title is a `div`, not a heading.
- Fix: render the title as an `h2` with an id and use `aria-labelledby`. Give `.dialog-desc` and the
  body text an id and set `aria-describedby`. `ConfirmHost` gets `role="alertdialog"`. Add a `role`
  prop to Dialog.
- Test: a unit test (testing-library) renders `<Dialog description>` and checks that
  `aria-describedby` resolves to the text. An e2e test checks that the trash confirm has
  `role=alertdialog` and that its description contains „rückgängig“.

### A3 – Medium – Repeated identical control names in lists (seen)
- Where:
  - `views/TimesheetView.tsx:658`: every entry checkbox is „Auswählen“, and every entry menu is
    „Aktionen“ (`ribbon.actions`).
  - `views/CalendarView.tsx:588`: one „Tagesrückblick“ button per day; `:559` „Tagesnotiz öffnen“ per
    day.
  - The `time.selectDay` checkbox per day, and the trash rows („Wiederherstellen“, „Endgültig
    löschen“).
- What: a screen reader's list of buttons or form fields shows five identical „Tagesrückblick“
  entries and n identical „Auswählen“ entries, with no way to tell them apart.
- Fix (new keys with placeholders):
  - `time.selectEntry`: de „{wbs}, {time} auswählen“, en "Select {wbs}, {time}"
  - `time.entryActions`: de „Aktionen für {wbs}, {time}“, en "Actions for {wbs}, {time}"
  - `calv.reviewDay`: de „Tagesrückblick für {day}“, en "Daily review for {day}"
  - `calv.openDailyDay`: de „Tagesnotiz vom {day} öffnen“, en "Open the daily note of {day}"
  - `time.selectDayN`: de „{day} auswählen“, en "Select {day}"
  - `trash.restoreOne`: de „„{title}“ wiederherstellen“, en "Restore “{title}”"
  - `trash.deleteOne`: de „„{title}“ endgültig löschen“, en "Delete “{title}” for good"
- Test: extend `a11y-buttons.test.ts` with a rule: an `aria-label`/`label` without a placeholder on
  a button or checkbox rendered inside `.map(` fails, unless allow-listed. As an e2e check, collect
  the accessible names of `.pane.active button` in the calendar and timesheet and assert there are
  no duplicates, apart from an allow-list (Close).

### A4 – Medium – Calendar events do not say their day (seen)
- Where: `views/CalendarView.tsx` week and day grid (`.calv-col`, `evLabel()`).
- What: the event button is named „Jour fixe Änderungen, 10:00–11:00“. The column has no role or
  label, so in week view nothing tells which day an event is on. Selecting an event does not expose
  the state either: no `aria-pressed`/`aria-expanded` on `.calv-ev.selected` (seen).
- Fix: give the day columns `role="group" aria-label="Montag, 5. Oktober"`, or put the weekday into
  `evLabel` („Mo., 5. Okt., 10:00–11:00“). Event buttons get `aria-expanded={selected}` and
  `aria-controls` pointing to the detail aside.
- Test: an e2e test (calendar fixtures) checks that the first event's accessible name, or its group,
  contains the weekday, and that `aria-expanded` turns true after Enter.

### A5 – Medium – The shortcut recorder hides the current combination (code + seen)
- Where: `views/settings/KeyboardSection.tsx`, `aria-label={t("keys.record", …)}` on the recorder
  button whose content is the `<kbd>`s.
- What: `aria-label` replaces the content, so a screen reader hears „Tastenkürzel für
  „Befehlspalette“ ändern“ but never „Ctrl K“. The keyboard settings cannot be reviewed without
  sight. While recording („Tasten drücken…“) nothing is announced either.
- Fix: keep the label and add the value: `keys.recordValue` de „Tastenkürzel für „{command}“: {keys}.
  Zum Ändern drücken.“, en "Shortcut of “{command}”: {keys}. Press to change."; when unbound,
  `{keys}` = `keys.none`. Put `aria-live="polite"` on the recorder text while recording.
- Test: a unit test renders KeyboardSection and checks that the accessible name of
  `[data-command=palette]` contains `comboLabel("Ctrl+K")`.

### A6 – Medium – Timesheet week table lacks table semantics (seen)
- Where: `views/TimesheetView.tsx` Wochenübersicht table, and the two tables in `ProjectsView`.
- What: there is no caption or label. The WBS code is a `td`, so rows have no header. `th` have no
  `scope`. „LA“ is never expanded, and „Mo 5.“ is read as „Mo 5 Punkt“. The Summe row starts with a
  `td`. Under-target sums are shown in red (other cues exist in the chip row above).
- Fix: add `aria-label={t("time.weekTable")}` (de „Wochenübersicht nach Netzplan und Tag“, en "Week
  by network and day"). The first cell of every row becomes `<th scope="row">` and the head cells
  `scope="col"`. Write „LA“ as `<abbr title={t("time.activityType")}>` (Leistungsart / activity
  type). Day heads get `aria-label` with the full date („Montag, 5. Oktober“).
- Test: an e2e or unit test checks that `thead th[scope=col]` count = columns and that each `tbody
  tr` has a `th[scope=row]`.

### A7 – Medium – „Today“ markers fail AA in the default light theme and 3 more (calc) — fixed in 1.16 (--accent-fill/--on-accent, contrast.test)
- Where: `styles/app.css:524/526` `.cal-day.today .cal-num`, `:1844` `.calv-dayhead.today .calv-dn`,
  `:1961` `.calv-mcell.today .calv-mday`, `:3580` `.graph-badge` and `:1544` `.sb-focus-held`. All are
  `color: var(--text-inverse)` on `background: var(--accent)`, at 10–12 px.
- What: Arcalo Hell (tokens.css) 4.47:1, Solarized Light 3.68, Rosé Pine Dawn 3.79, Everforest Light
  3.27. Other accent presets are not checked at all. `contrast.test.ts` only checks white on
  `--accent-strong`.
- Fix: use `--accent-strong` as the fill (white on it is already guaranteed), or derive a
  `--on-accent` token with `ensureContrast`.
- Test: add `--text-inverse on --accent` (or the new pair) at 4.5 to `failures()` in
  `contrast.test.ts`, across themes and presets.

### A8 – Medium – Text dimmed with opacity drops below AA (calc + seen) — fixed in 1.16 (styles.test faded text)
- Where and values (light / dark; worst built-in theme):
  - `dashboard.css:117` `.dw-task.done { opacity: .45 }`, done tasks on the start page: text-2 2.14 /
    2.53 (Everforest Light 1.96).
  - `app.css:522` `.cal-day.outside { opacity: .45 }`, days of the neighbouring month in the date
    picker (they are clickable): 2.92 / 3.87.
  - `app.css:103` and `settings.css:15`, the tabs and header of an inactive split pane at .72:
    text-3 2.96 / 4.10.
  - `app.css:2082/2173/2533/3419/3442`, switched-off calendar sources, week-proposal rows, Outlook
    calendars, „Aufräumen“ rows and filing rules at .55–.72: text-2 2.90 / 3.45.
  - `settings.css:382`, the „Wiederherstellen“ button in the backup list at .55 until hover: text
    3.94 (Catppuccin Latte 2.58).
- What: these rows stay readable content, and are not disabled controls, so 1.4.3 applies.
- Fix: replace opacity with `color: var(--text-3)` (already AA) plus a strike-through or icon for the
  state. Keep opacity for icons only. The backup restore button stays at full color (or shows on row
  focus-within, as row actions do).
- Test: in `styles.test.ts`, fail on `opacity: 0.[0-7]` in rules whose selector does not contain
  `:disabled`, `disabled`, `drag`, an icon class, or an allow-list entry.

### A9 – Medium – The focus ring loses contrast on the current row in light themes (calc) — fixed in 1.16 (focus ring on tinted rows, contrast.test)
- Where: `--border-focus` (tokens.css comment: „3:1 on every surface“) on `.tree-row.active`,
  `.settings-nav-item.active` and other rows with `--bg-current` over `--bg-sidebar`.
- What: Arcalo Hell 2.58:1; Catppuccin Latte 2.72, Solarized Light 2.64, Gruvbox Light 2.66, GitHub
  Light 2.71, Rosé Pine Dawn 2.78, Everforest Light 2.77, Rosé Pine 2.92. The focused current tree
  row is the most common focus position.
- Fix: darken `--border-focus` in light themes (for example #6f6f78 in tokens.css, derived in
  `themes.ts`) until it reaches 3:1 on `--bg-current` over sidebar and canvas.
- Test: in `contrast.test.ts`, check `--border-focus` against every SURFACE and every TINT over it at
  3:1.

### A10 – Low – Menu buttons do not say they open a menu (code)
- Where: about 15 `IconButton`s that call `openMenuAt`/`setMenu` without `aria-haspopup`/
  `aria-expanded`: `Updates.tsx:334`, `Dashboard.tsx:306/640/664`, `Sidebar.tsx:1144`,
  `TimesheetView.tsx:679`, `PageView.tsx:466`, `JiraSection.tsx:260`, `CalendarSection.tsx:142`,
  `AttachmentsView.tsx:307`, `BoardView.tsx:184`, `IssuesView.tsx:265`, `ProjectsView.tsx:94/170`,
  `HistoryView.tsx:244`, `CanvasView.tsx:1015`. Only 16 places set it.
- Fix: an `IconButton` prop `menu` that sets `aria-haspopup="menu"` and `aria-expanded`, or let
  `openMenuAt(e, …)` set both on `e.currentTarget` and clear them on close.
- Test: an AST test: a JSX element whose `onClick` calls `openMenuAt` or `setMenu` must carry
  `aria-haspopup`.

### A11 – Low – Heading structure (seen)
- What: the start page has no `h1`; its first heading is the widget „Heute“ (h2), and „Guten
  Morgen“ is a `div`. Dialog titles are not headings (A2). Week review and the briefing put the
  count into the heading text („Termine0“, read as „Termine null“).
- Fix: an `h1` (sr-only if needed) with the board name on the start page, and the count in a
  separate `span aria-label` outside the `h2`, or „Termine (0)“.
- Test: an e2e check per view (start page, calendar, timesheet, review, briefing): exactly one
  visible `h1` inside `.pane.active`.

### A12 – Low – The start page week bars are buttons with `role="listitem"` (seen)
- Where: the `button.dw-bar-col` of „Zeit diese Woche“ (component `components/dashboard/time.tsx`).
- What: the role override removes the button role, so screen readers do not announce them as
  activatable.
- Fix: wrap each button in `<div role="listitem">`, or drop the list roles.
- Test: an AST rule in `a11y-buttons.test.ts`: no `role` other than button/tab/menuitem*/option/
  switch/radio on a `<button>`.

### A13 – Low – Run-together accessible names (seen)
- What: names built from adjacent spans have no separator. Onboarding language radios read „Same as
  systemTakes the operating system's…“ and the rail „1Language“. The week review day tile reads „Mo
  5. 3 h fehlen 5 h / 8 h 3 h fehlen“; its warning `svg` has `aria-label` but no `role="img"`, and the
  action („Tagesrückblick öffnen“) is only in `title`.
- Fix: description through `aria-describedby`; step number `aria-hidden`; tile `aria-label` „Mo., 5.
  Okt.: 5 von 8 Std., 3 Std. fehlen – Tagesrückblick öffnen“; give the svg `aria-hidden`.
- Test: an e2e check that the accessible names of `.fr-choice` contain no lowercase-uppercase join
  (`/[a-z][A-Z]/`).

### A14 – Low – Toasts sit in two nested live regions (code)
- Where: `Shell.tsx` `Toasts`: the container has `aria-live="polite"`, and each toast has
  `role="alert"` or `"status"`.
- What: some screen readers (NVDA, VoiceOver) announce a toast twice.
- Fix: drop `aria-live` on the container, or the roles on the items.
- Test: a unit test: `.toasts` has no `aria-live` when its children carry `role`.

### A15 – Low – Sidebar tabs and editor tabs have no tabpanel (seen)
- What: `.side-tabs [role=tab]` and `.tabs [role=tab]` have no `aria-controls` and no
  `role="tabpanel"` (only the side panel does).
- Fix: `aria-controls` to the sidebar body and `role="tabpanel" aria-labelledby` on `.pane-body`.

### A16 – Low – Field and control borders are below 3:1 (calc, 1.4.11)
- What: `--border-strong` on the canvas is 1.55–2.36:1 in every theme except the two high-contrast
  ones. Inputs, selects and the segmented control are hard to find for low-vision users.
- Fix: accept this as a design choice and point to „Hoher Kontrast“ in the docs, or give
  `.input/.select` a `--border-field` token at 3:1.

### A17 – Low – Warning fill and star below 3:1 in three light themes (calc)
- What: `--warning-fill`/`--star` on raised: Catppuccin Latte 2.42, Rosé Pine Dawn 2.16, Everforest
  Light 2.21 (budget bars, favourite star).
- Fix: run `ensureContrast(…, 3)` for these two tokens in `themes.ts`.

### A18 – Low – Citation chips show focus with an accent fill (code)
- Where: `app.css:1235` `.cite:hover, .cite:focus-visible { background: var(--accent); color: #fff;
  outline: none }`.
- What: this goes against the focus rule (neutral ring, no accent for states), and white on `--accent`
  is 4.47 in light.
- Fix: `.cite:focus-visible { outline: var(--focus-ring) }`; hover a neutral tint.

---

## Keyboard

### K1 – High – Irreversible confirmations focus the destructive button (seen)
- Where: `Shell.tsx` `ConfirmHost`: the confirm button always has `data-autofocus`, also when
  `danger`.
- What: Papierkorb → „Papierkorb leeren“ → Enter opens „Papierkorb leeren? … kann nicht rückgängig
  gemacht werden“ with the focus on „Leeren“ (seen). A second Enter, or a held Enter, deletes all
  pages for good. The same applies to every `danger` confirm.
- Fix: when `req.danger`, put `data-autofocus` on Cancel. Enter then cancels, and Tab or a click is
  needed to confirm.
- Test: an e2e test in the trash: open the confirm and assert that `document.activeElement` is the
  cancel button; Enter closes it and the pages are still there.

### K2 – Medium – Closing the command palette loses the focus (seen)
- Where: `components/CommandPalette.tsx` (open/close via `paletteOpen`).
- What: focus on a tree row → Ctrl+K → Esc leaves `document.activeElement = body`. The next Tab
  starts at the ribbon, and from the editor the caret position is gone.
- Fix: remember `document.activeElement` when the palette opens and restore it on close, unless the
  chosen command moved the focus (as `Dialog` does).
- Test: extend `e2e/tests/200-shell-keyboard.test.js`: focus a tree row, Ctrl+K, Escape, and the
  same row is active again.

### K3 – Medium – Calendar event details: focus is not moved, then lost (seen)
- Where: `views/CalendarView.tsx` (`onSelect` and the `aside.calv-detail`).
- What: Enter on an event opens the detail, but the focus stays on the event. The detail is 15 Tab
  presses away (behind all other events). Esc inside the detail closes it, and the focus falls to
  `body`.
- Fix: on selection by keyboard, focus the detail heading (`tabIndex=-1`). On close, return the focus
  to the event button (by key). Escape from the detail returns there too. The same applies to
  `BlockDetail`.
- Test: an e2e test (fixtures): Enter on an event makes `activeElement` sit inside `.calv-detail`;
  Escape puts it on `.calv-ev[data-key=…]`.

### K4 – Medium – IME and dead keys: Enter/Esc submit or close during composition (code)
- Where: `lib/ime.ts` says that WebKit (macOS) sends the composing Enter/Esc with `isComposing=false`
  and `keyCode 229`, but only CaptureApp, SearchApp and AssistantPanel use `isComposing()`.
  - These check only `e.nativeEvent.isComposing`, so macOS WebKit gets through: `CommandPalette:405`,
    `Sidebar:279`, `dashboard/day.tsx:203`, `TimesheetView:332/354/797`, `WeekProposal:105`,
    `TurnView:176`, `InlineAiBar:206`.
  - These have no check at all on text inputs: `CreateIssueDialog:120`, `Sidebar:1231` (rename),
    `Dashboard:246/443`, `Templates:151`, `LinkDialogs:280`, `FilingDialogs:225`,
    `EditorToolbar:253`, `NoteEditor:766/790/856`, `Focus:275/349`, `QuickLinks:406`,
    `Gallery:163`, `WidgetSettings:448`, `collection/controls:206/332/534`, `CollectionView:517`,
    `CalendarBlocks:246`, `PdfViewer:500`.
  - Every Escape handler: `Dialog`, `Menu`, the palette, CalendarPopover, ImageViewer.
- What: a Japanese, Chinese or Korean user who confirms a composition with Enter submits the field
  (renames the page with half-typed text, creates the Jira issue, adds the task). Esc to cancel a
  composition closes the dialog. The same holds for dead keys on a Mac.
- Fix: use `isComposing(e.nativeEvent)` everywhere: an early `if (isComposing(e.nativeEvent))
  return;` in each handler, and in Dialog and Menu's window listeners.
- Test: an AST test (like `a11y-buttons.test.ts`): every `key === "Enter"` or `"Escape"` comparison
  in a handler attached to an `input`, `textarea`, `Input` or `TextArea` (or a window keydown
  listener in Dialog and Menu) must be preceded by `isComposing(` in the same function. Plus an e2e
  test: dispatch `keydown {key:"Enter", keyCode:229}` in the tree rename field; the name is
  unchanged.

### K5 – Medium – Shortcut hints name US keys that German keyboards do not have there (seen)
- Where: `lib/keymap.ts` NAMED (`Backslash`, `BracketLeft`/`Right` by position) and `comboLabel`.
- What: „Seitenleiste ausblenden (Ctrl \)“ is really Strg+# on a German keyboard. A synthetic
  `keydown {key:"#", code:"Backslash", ctrlKey}` toggled the sidebar (seen), while Ctrl+AltGr+ß
  (the real `\`) is rejected as AltGr. The same applies to „Seitenpanel (Ctrl Shift \)“ (Strg+⇧+#).
  On a German Mac, back/forward ⌘[ / ⌘] are ⌘Ü / ⌘+ by position. Users cannot find these shortcuts
  from the hint.
- Fix: label positional keys by the layout. Use `navigator.keyboard.getLayoutMap()` where available.
  Otherwise, when the UI language or OS layout is German, show `#`, `Ü`, `+` (a table in `keymap.ts`).
  Also make the settings recorder display the pressed key's `e.key`.
- Test: a unit test in `keymap.test.ts`: `comboLabel("Ctrl+\\", { layout: "de" })` gives „Strg #“,
  and `comboLabel("Ctrl+[", mac, "de")` gives „⌘Ü“.

### K6 – Medium – macOS: find and replace is ⌘H, which hides the app (code)
- Where: `editor/NoteEditor.tsx:693–701` (`k === "h"` with metaKey), the hints
  `keys("Mod H")` in `NoteEditor.tsx:778` and `EditorToolbar.tsx:137`, and
  `src-tauri/src/appmenu.rs:42` (`PredefinedMenuItem::hide`, ⌘H).
- What: on a Mac the app menu takes ⌘H („Arcalo ausblenden“) before the web view sees it. Replace
  never opens, the window disappears, and the tooltip advertises „⌘H“.
- Fix: on macOS use ⌥⌘F for replace (the Apple convention, as in Xcode and Pages) and show it in both
  places. Keep Ctrl+H elsewhere.
- Test: a unit test of a `replaceCombo(mac)` helper, and that the toolbar menu's shortcut on mac
  is „⌥⌘F“.

### K7 – Medium – macOS: the next/previous tab hint is ⌘⇥, which is the app switcher (code)
- Where: `lib/keymap.ts` COMMANDS `next_tab: "Ctrl+Tab"`, `prev_tab: "Ctrl+Shift+Tab"`, and no
  MAC_DEFAULTS entry. `comboLabel` maps Ctrl to ⌘ on a Mac.
- What: Settings → Tastatur and tooltips show „⌘ ⇥“ and „⌘ ⇧ ⇥“; macOS takes ⌘⇥ for the app
  switcher. Real ⌃⇥ works, because ctrlKey also counts, but nothing says so.
- Fix: `MAC_DEFAULTS.next_tab = "Ctrl+Shift+]"` and `prev_tab = "Ctrl+Shift+["` (⌘⇧] / ⌘⇧[ as in
  Safari, Finder and Xcode), or teach `comboLabel` to show ⌃ for Tab combos.
- Test: in `keymap.test.ts`, no default on mac formats to a system-reserved combo (⌘⇥, ⌘H, ⌘M, ⌘Q,
  ⌘Space, ⌘⌥Esc). Keep a `MAC_RESERVED` table and use it in `findConflicts` too.

### K8 – Medium – No way to jump between regions; toast actions are out of reach (seen + code)
- What: there is no F6 / Shift+F6 cycle and no skip link. The Tab order is ribbon (20 stops), then
  the sidebar header, filter, tree, row actions and footer, then the tab bar, toolbar (14) and
  content, then the side panel. Toasts with „Rückgängig“ (7 s) render at the end of the DOM, so they
  are practically unreachable before they vanish (they pause only on hover or focus).
- Fix: add F6 / Shift+F6 to cycle focus through ribbon, sidebar (current tree row), active pane
  (editor caret or first control), side panel, and the newest toast. Add a keymap command
  `focus_toasts` or let F6 include the toast stack, and hold the toasts while focus is in them.
- Test: an e2e test where F6 from the editor lands in the side panel, then the ribbon, then the
  sidebar's current row; after deleting a page, F6 reaches the „Rückgängig“ toast.

### K9 – Medium – Help → „Tastenkürzel“ lists only the rebindable commands (seen)
- Where: `components/Help.tsx` `showShortcuts` opens Settings → Tastatur, which lists `COMMANDS` only.
- What: much keyboard handling is undocumented in the app:
  - Editor keys (Strg+B/I/E, Strg+F/H, Alt+Enter, slash, `[[`, `#`).
  - Tree keys (F2, Entf, Shift+arrows, Strg+A, Shift+F10).
  - Calendar keys (←/→/PageUp/PageDown, T, D/A/W/M/L, Esc).
  - Dashboard edit mode (arrows, Shift+arrows, 1–5, Strg+D, Entf).
  - Focus blocks, graph keys, chat history keys and palette prefixes.
  Some appear only as `aria-description` or as a tooltip. „Shortcut list in help matches reality“
  therefore does not hold.
- Fix: add a read-only group „Weitere Tastenkürzel“ below the commands in Settings → Tastatur,
  generated from one table (`lib/keyhelp.ts`) that the handlers also import (calendar `keyAction`,
  dashboard and blocks keys). Group headings: Editor, Seitenbaum, Kalender, Startseite, Graph.
- Test: a unit test asserts that every key handled in `agenda.keyAction`, the dashboard `keyDown` and
  blocks `key` appears in `keyhelp.ts`. An e2e test asserts that Settings → Tastatur shows „F2“ and
  „Umbenennen“.

### K10 – Low – Splitters cannot be used with the keyboard (code)
- Where: `components/Resizer.tsx`: `role="separator"` without `tabIndex`, `aria-valuenow` or key
  handling.
- What: sidebar width, side panel width and split panes can only be changed by dragging
  (WCAG 2.1.1).
- Fix: `tabIndex=0`, ←/→ by 16 px (Shift: 64 px), Home/End or Enter to reset (`onReset`), and
  `aria-valuenow/min/max` in px.
- Test: a unit test: ArrowRight on the separator calls `onResize(16)` and `onEnd`.

### K11 – Low – Editor toolbar: 14 tab stops in a `role="toolbar"` (seen)
- Where: `editor/EditorToolbar.tsx`.
- What: every button is `tabIndex=0`. The ARIA toolbar pattern expects one tab stop with ←/→ between
  buttons. From the tab bar to the text takes 14 Tabs.
- Fix: roving `tabIndex` inside `.editor-toolbar` (the same helper as `Segmented`), Home/End, and the
  last-focused button remembered.
- Test: an e2e test: Tab into the toolbar, ArrowRight twice, Tab, and the focus is in the editor.

### K12 – Low – Onboarding setup: Esc, focus after closing, radios (seen)
- Where: `onboarding/Intake.tsx` (no Escape handling), `steps.tsx` choice cards.
- What:
  - The intro offers „Überspringen Esc“, but in the setup (`aria-modal` dialog) Esc does nothing.
  - After closing the setup, the focus falls to `body`.
  - Each `role=radio` card is a tab stop (3 stops, no arrow keys).
- Fix: Esc = „Später einrichten“ (answers are kept, `fr.pausedDetail`); return the focus to the
  element that opened it, or to the start page heading; roving radios with arrows.
- Test: e2e test 300 (onboarding): Escape in the setup closes it, the answers are kept, and
  `activeElement` is not `body`.

### K13 – Low – The image full view takes no focus (code)
- Where: `editor/imageMenu.tsx` `ImageViewer`.
- What: `role="dialog"` without `aria-modal`, initial focus, trap or focus return; Tab moves through
  the page under the overlay. (PdfViewer does this right.)
- Fix: focus the close button on open, trap Tab, `aria-modal="true"`, and restore the focus on close.

### K14 – Low – A Dialog without a field or primary button leaves the focus behind it (code)
- Where: `components/ui.tsx:204–206`; the focus moves only to
  `[data-autofocus], input, textarea, select, button.btn-primary`.
- What: in an info-only dialog the focus stays on the page behind it. The trap catches the first Tab,
  but screen readers do not enter the dialog.
- Fix: fall back to the dialog element (`tabIndex=-1`) or its close button.

### K15 – Low – macOS menu key equivalents ignore Settings → Tastatur (code)
- Where: `src-tauri/src/appmenu.rs:69–70` (`Cmd+\`, `Cmd+.` fixed) and `App.tsx:181`.
- What: if the user moves „Seitenleiste umschalten“ or „Fokusmodus“ to another combo, ⌘\ and ⌘.
  still run them, and a command bound to ⌘\ never fires. The conflict check does not know about
  these.
- Fix: rebuild the menu from the effective keymap (`settings_changed`), or treat them as reserved
  on mac in `findConflicts`.

### K16 – Low – Small keymap inconsistencies (code)
- What:
  - Settings → Tastatur hides the timer shortcuts when time tracking is off, but lists
    Assistent/Chat when AI is off (they do nothing then, `App.tsx` AI_SHORTCUTS).
  - Default combos that common Windows IMEs take are not flagged: Ctrl+Shift+F
    (Simplified/Traditional in Microsoft Pinyin), Ctrl+. (Chinese/English punctuation).
- Fix: filter AI_SHORTCUTS like TIME_SHORTCUTS, and add an IME note to `findConflicts` („wird von
  manchen Eingabemethoden belegt“ / "used by some input methods").

---

## Texts (German and English)

### T1 – Medium – Key names: „Ctrl/Shift“ in German, three spellings side by side (seen) — fixed in 1.16 (keyName, shortcut.test, glossary)
- What: `formatShortcut`/`comboLabel` write `Ctrl` and `Shift` in every German tooltip, menu and
  setting („Neue Seite (Ctrl N)“, the settings search „Ctrl F“). German keyboards say Strg and ⇧ or
  Umschalt, and the catalog already has `keys.ctrl` „Strg“ (used only in the quick capture window).
  German catalog texts mix „Ctrl+Alt“, „Strg+D“, „Umschalt+Enter“, „Eingabe öffnet“ and „Enter
  speichert“. In English the separator varies: „Shift Enter“ (`assist.keys`, `chat.keysHint`) vs
  „Shift+Enter“ (`cap.hint.empty`). `keys.problem.altgr` en says „on German keyboards“ while
  `set.capture.shortcutDesc` says „on many keyboards“.
- Fix: `formatShortcut` takes the modifier names from the catalog (`keys.ctrl` Strg/Ctrl,
  `keys.shift` Umschalt/Shift, `keys.alt` Alt/Alt, `keys.enter` Eingabe/Enter, `keys.delete`
  Entf/Delete). In German, „Eingabe“ is the key name and „Enter“ goes. New wording:
  - `set.keys.commandsDesc` de „Klicken und die neue Kombination drücken. Entf = aus, Esc =
    abbrechen. Strg+Alt geht nicht (AltGr).“ / en unchanged.
  - `set.capture.shortcutDesc` de „Ins Feld klicken und die Tasten drücken, z. B.
    Strg+Umschalt+Leertaste. Strg+Alt geht nicht – das ist AltGr auf deutschen Tastaturen. Entf =
    aus.“ / en "Click the field and press the keys, e.g. Ctrl+Shift+Space. Ctrl+Alt does not work –
    it is AltGr on many keyboards. Delete = off."
  - `keys.problem.altgr` de „Strg+Alt ist AltGr auf deutschen Tastaturen und nicht erlaubt“ / en
    "Ctrl+Alt is AltGr on many keyboards and not allowed"
  - `keys.problem.modifier` de „Bitte mit Strg oder Alt kombinieren“ / en unchanged
  - `set.ai.presetsDesc` de „Die Schaltflächen der KI-Leiste ({keys} bei markiertem Text): Name und
    Anweisung.“ / en "The buttons of the AI bar ({keys} on selected text): name and instruction."
    (`{keys}` = `keys("Mod J")`, which is also right on a Mac)
  - `assist.keys`, `chat.keysHint` de „Eingabe zum Senden · Umschalt+Eingabe für eine neue Zeile“ /
    en "Enter to send · Shift+Enter for a new line"
  - `cap.hint.empty` de „Eingabe speichert · Umschalt+Eingabe neue Zeile · Esc schließt“
  - the same „Enter“ → „Eingabe“ change in `cap.hint.lines`, `cap.hint.linesZeit` and
    `chat.historyKeys`
- Test: a translations.test rule: in de texts, `\b(Ctrl|Shift)\b` is forbidden (glossary entries
  `forbiddenDe: ["Ctrl", "Shift"]`), and „Enter“ is allowed only inside code spans. A `shortcut.test.ts`
  case: `formatShortcut("Ctrl+Shift+D")` in German gives „Strg+Umschalt+D“.

### T2 – Medium – „taken over“ is a literal „übernommen“ (18 texts) — fixed in 1.16 (glossary taken over)
- Where: en `set.git.restoredPulled`, `bm.skippedTitle`, `vault.cancelledDesc`, `mail.importFailed`,
  `mail.importing`, `onb.importText`, `app.keptTitle`, `wp.applyFailed`, `voice.set.importFailed`,
  `voice.set.imported`, `settings.synced`, `set.git.syncSettingsDesc`, `set.git.lastMergeText`,
  `time.meetingsAllTitle`, and backend `identity.rs:439/451/452`, `gitsync.rs:1222/1643/1648`.
- New en (de unchanged):
  - `set.git.restoredPulled` "Newer state pulled in"
  - `bm.skippedTitle` "Only web addresses (http, https) and files are imported. Skipped: …"
  - `vault.cancelledDesc` "Nothing was imported."
  - `mail.importFailed` "E-mail not imported"
  - `mail.importing` "Importing…"
  - `onb.importText` "Folders, [[links]], #tags, properties and images are imported."
  - `app.keptTitle` "Deletions on the server not applied here"
  - `wp.applyFailed` "Proposals not applied"
  - `voice.set.importFailed` "Model file not imported"
  - `voice.set.imported` "Model file checked and imported"
  - `settings.synced` one "{n} setting applied from another computer", other "{n} settings applied
    from another computer"
  - `set.git.syncSettingsDesc` "… and applies changes from other computers …"
  - `set.git.lastMergeText` "{when} from {host}: {n} setting(s) applied ({keys})", in both plural forms
  - `time.meetingsAllTitle` "… and book them in one go"
  - `identity.rs:439` "Data folder not moved"
  - `identity.rs:451` "Data of the older version kept"
  - `identity.rs:452` "… that data was kept. …"
  - `gitsync.rs:1222` "{pulled} {noun} pulled from the server"
  - `gitsync.rs:1643/1648` "{taken} applied"
- Test: glossary `forbiddenEn: ["taken over", "taking over", "takes over"]` (concept „übernehmen“:
  import, apply, keep).

### T3 – Medium – Error messages: five patterns and several without a subject — fixed in 1.16 (translations.test error-title)
- What: of the 240 error keys, about 88 are „X nicht …“, 55 „ließ sich nicht / konnte nicht“, 44
  „fehlgeschlagen“ and 11 „nicht möglich“. English mixes „X not saved“, „Could not open X“ and „The X
  could not be …“. Some say neither what nor where:
  - `dash.loadFailed` de „Nicht geladen“ → „Widget nicht geladen“ / en "Widget not loaded"
  - `olcal.saveFailed` de „Nicht gespeichert“ → „Kalendereinstellung nicht gespeichert“ / en
    "Calendar setting not saved"
  - `palette.focusNoteFailed`, `dash.focusNoteFailed` de „Nicht eingetragen“ → „Fokussitzung nicht in
    die Tagesnotiz eingetragen“ / en "Focus session not added to the daily note"
  - `canvas.openFailed` de „Konnte nicht geöffnet werden“ → „Link oder Datei ließ sich nicht öffnen“ /
    en "Could not open the link or file"
  - `set.data.discardFailed` de „Nicht verworfen“ → „Umzug des Datenordners nicht abgebrochen“ / en
    "Data folder move not cancelled"
  - `tasks.undoFailed` de „Nicht rückgängig gemacht“ → „Aufgabe nicht wiederhergestellt“ / en "Task
    not restored"
  - `voice.failed` de „Kein Transkript“ → „Sprachnotiz nicht transkribiert“ / en "Voice note not
    transcribed"
  - `mob.notes.saveFailed` en "Could not save" → "Note not saved" (de „Nicht gespeichert“ → „Notiz
    nicht gespeichert“)
- Rule for i18n.md: toast titles are „<Ding> nicht <Partizip>“ / "<Thing> not <participle>"; the
  cause goes in the detail. Bring the „ließ sich nicht öffnen“ family in line over time (en "Could
  not open …" → "… not opened").
- Test: a translations.test rule: `*Failed` keys must not start with „Nicht“/"Not"/"Could not" and
  must not be just „Fehler“/"Error".

### T4 – Medium – Durations shown five ways (seen) — fixed in 1.16 (fmtDuration, format.test hours)
- What, for the same week:
  - start page „27,0 von 40,0 h“ and „0,00 h / 8,00 h“
  - timesheet „27,00 h“ and „14,50“
  - week review „27 h / 40 h“ and Fokus „0:00 h“
  - projects „14,5 h“
  „0:00 h“ comes from two private `hm()` helpers (`lib/dayreview.ts:24`, `lib/focus.ts:42`) that
  ignore the „Stunden als“ setting (`prefs.hours`) and mix clock and unit.
- Fix: one formatter (`fmtHours`/`fmtMinutes`) everywhere, with an explicit precision per place
  (sums: as set; tiles: 1 decimal). Remove both `hm()` helpers; clock style writes „0:45“ without
  „h“, decimal style „0,75 h“.
- Test: a unit test that `lib/dayreview.ts` and `lib/focus.ts` export no own formatter, plus a grep
  test: no `` `${…}:${…} h` `` template in `ui/src`.

### T5 – Medium – Two commands are both „Kalender“ — fixed in 1.16 (keymap.test unique labels)
- Where: `cmd.calendar` „Kalender“ / "Calendar" (opens the date picker for daily notes, Ctrl+Shift+C)
  vs `cmd.calendarView` „Kalender öffnen“ / "Open calendar" (Ctrl+Shift+E). In the ribbon:
  „Kalender (Ctrl Shift C)“ next to „Kalender: Termine und gebuchte Zeit (Ctrl Shift E)“.
- What: in Settings → Tastatur and in the palette the user cannot tell which is which.
- Fix: `cmd.calendar` de „Tagesnotiz eines Tages öffnen“ / en "Open a daily note by date";
  `cmd.calendarView` de „Kalender“ / en "Calendar"; ribbon label of the chevron = `cmd.calendar`.
- Test: a unit test: the labels of COMMANDS are unique in both languages.

### T6 – Low – Ellipsis with and without a space (46 vs 94 texts) — fixed in 1.16 (translations.test final ellipsis)
- What: menu items „Lesezeichen importieren …“, „Board exportieren …“ and „Auswählen …“ against
  „Neue Seite aus Vorlage…“ and „Verschieben nach…“. Progress texts „Wird synchronisiert …“ against
  „Prüfe…“. The macOS menu has „Einstellungen …“ / "Settings …". The same split appears in English.
- Fix: a rule in i18n.md: an ellipsis at the end of a menu item, button, placeholder or progress text
  has no space („Board exportieren…“, „Wird synchronisiert…“); a space only where whole words are
  left out inside running text. Change the texts listed in `q116/a11y/ellipsis-space.txt` (88 de and en catalog texts) and
  `appmenu.rs:38`.
- Test: a translations.test typography rule: `\w …$` fails.

### T7 – Low – Date ranges in four formats (seen) — fixed in 1.16 (weekRange in time tracking, weekreview.test)
- What: calendar „5.–9. Oktober 2026“, week review „5.–11. Oktober 2026“, timesheet „5. Okt. – 11.
  Okt. 2026“, activity „05.10.2026 – 09.10.2026“.
- Fix: use `weekRange()` from `lib/weekreview.ts` for every week heading. Use `fmtDate` ranges only
  where the user's date format is wanted (activity filter).
- Test: a unit test: Timesheet and Activity headings call `weekRange`; snapshot test of the 4
  headings.

### T8 – Low – „Rechner“ (52) and „Computer“ (20) for the same thing — fixed in 1.16 (glossary Rechner)
- Example: „auf diesem Rechner“ (AI hints, onboarding) vs „auf diesem Computer“ (calendar intro,
  `settings.synced`, Git texts). English always says computer.
- Fix: glossary entry: concept computer, de „Computer“ (or „Rechner“, owner's choice), forbidden the
  other; change the 20 (or 52) texts accordingly.
- Test: the glossary entry itself.

### T9 – Low – English calls the time tracking view „timesheet“ (8 texts) — fixed in 1.16 (glossary timesheet)
- Where: `dash.weekOpen`, `dash.hoursLabel`, `dash.timerEmpty`, `brief.timesheet`,
  `cmd.weekProposalSub`, `set.time.useDesc`, `fr.work.hidden`, `tt.setUseDescOff`. The ribbon and the
  view say „Time tracking“.
- Fix (en):
  - `dash.weekOpen` "Open the week in time tracking"
  - `dash.hoursLabel` "{booked} of {target} booked, open time tracking"
  - `dash.timerEmpty` "No bookings yet. Start a timer in time tracking."
  - `brief.timesheet` "Time tracking"
  - `cmd.weekProposalSub` "Draft bookings from meetings, focus sessions and pages"
  - replace „the timesheet“ with „time tracking“ in the three settings texts
- Test: glossary `forbiddenEn: ["timesheet*", "Timesheet*"]`.

### T10 – Low – „Propose (the) week“, „Derive tasks“ — fixed in 1.16 (glossary week proposal, extract tasks)
- What: literal translations, and „Propose week“ (`dash.act.week`) vs „Propose the week“
  (`cmd.weekProposal`, `wp.title`).
- Fix (en): `dash.act.week`, `cmd.weekProposal`, `wp.title`, `set.notify.weekProposal` "Plan the
  week's bookings"; `aitext.write-tasks`, `chat.quick.tasks` "Extract tasks"; `aitext.write-tasks.prompt`
  "Extract the open tasks from …"; `wp.nothing` "Nothing to plan". de unchanged.

### T11 – Low – The German default daily-note folder is „Journal“ (seen) — fixed in 1.16 (settings step 17 daily-folder, settings_migrate test)
- Where: `crates/arcalo-core/src/notes.rs:18` `JOURNAL_TITLE = "Journal"`, `settings.rs`
  `daily_folder`. The tree and the graph legend show „Journal“.
- What: the glossary forbids „Journal*“ in German (daily note = Tagesnotiz).
- Fix (needs an owner decision): new German installs get „Tagesnotizen“, English ones „Journal“.
  Existing folders stay („existing pages move only via Aufräumen“). Otherwise add an exception to the
  glossary note.

### T12 – Low – Missing plural and a double period (seen) — fixed in 1.16 (graph plurals, sentences(), count placeholders in translations.test)
- `graph.stats` / `graph.canvasLabel` „{pages} Seiten · {links} Verknüpfungen“ shows „1 Seiten“ and
  „1 Verknüpfungen“ for a filtered graph. Make both plurals, with two keys (`graph.pages`,
  `graph.links`): de one „{n} Seite“, other „{n} Seiten“; one „{n} Verknüpfung“, other „{n}
  Verknüpfungen“; en "{n} page"/"{n} pages", "{n} link"/"{n} links".
- The graph's live region reads „Jour fixe 22.09.. 3 Verknüpfungen“ (title ending in „.“ plus „. “).
  Join with „ – “ or skip the period after a title that ends in punctuation.
- Test: `translations.test` COUNT_NEVER_ONE must not list placeholders other than `n`/`count`, and
  graph a11y unit test with title „X.“.

### T13 – Low – Briefing tile „0 / von 0 heute“ — fixed in 1.16 (brief.ov.meetings)
- Where: `brief.ov.meetings` de „von {n} heute“ / en "of {n} today", below the big number.
- What: it reads as „0 von 0 heute“, and it is unclear whether the big number means meetings left or
  done.
- Fix: de „noch offen, {n} heute insgesamt“ / en "still ahead, {n} today in total" (or follow the
  tasks tile: „heute fällig“).

### T14 – Low – English weekday abbreviations „Mo, Tu, We“ — fixed in 1.16 (weekdayLabels Mon/Tue)
- Where: start page week bars and gap chips („Mo 3.0 h“), `fr.v.mo`–`fr.v.fr`.
- Fix: en "Mon, Tue, Wed, Thu, Fri, Sat, Sun" (Intl `weekday: "short"` with `en-GB` gives exactly
  these); de stays „Mo, Di …“.

---

## Counts

| Severity | Accessibility | Keyboard | Texts | Total |
|---|---|---|---|---|
| High | 1 (A1) | 1 (K1) | 0 | 2 |
| Medium | 8 (A2–A9) | 8 (K2–K9) | 5 (T1–T5) | 21 |
| Low | 9 (A10–A18) | 7 (K10–K16) | 9 (T6–T14) | 25 |
| **Total** | 18 | 16 | 14 | **48** |

## Checked and fine (no finding)
- Focus is visible on `:focus-visible` everywhere in the Tab walk (70 stops on the start page, all
  with a neutral ring; inputs use the halo).
- Tree: one tab stop, F2 rename and Esc return, Shift+F10 menu with focus return.
- Tabs: arrow keys, Home and Entf.
- Side panel and sidebar: tab lists with roving `tabIndex`.
- Select: combobox and listbox with `aria-activedescendant`.
- Date picker: role grid with arrow keys.
- Dashboard edit mode: arrows, 1–5, Strg+D and Entf, with live announcements.
- Focus blocks: keyboard move and resize.
- Graph: `role=application` with announcements and an „Als Liste anzeigen“ alternative.
- Intro: Pause button, `aria-current=step`, live scene announcement.
- Chat log: `role=log`.
- `Dialog`: focus trap and return.
- The address form („du“), quotes, dashes, units, glossary terms and the ellipsis character pass in
  both catalogs and the backend pairs. No typos or doubled words were found by the scans.

## Note on the working tree
`git status` shows changes I did not make (from the parallel q116 runs): `M
crates/arcalo-core/src/lib.rs`, `?? crates/arcalo-core/src/zz_probe.rs` and `??
crates/arcalo-core/tests/zz_tmp_perf116.rs`. This audit wrote only to the scratchpad.
