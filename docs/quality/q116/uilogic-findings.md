# q116 UI logic: findings (ui/src)

Scope: React UI logic (store, editor and source view, panes and tabs, palette and quick switcher, settings
with instant apply and undo, dashboards, calendar, time views, tasks, reviews, chat and assistant, search,
onboarding, AI-off mode, drag and drop, shortcuts, context menus, toasts and undo).

Method: code read (store/app.ts, App.tsx, PageView, NoteEditor, SourceEditor, saves.ts, Workspace,
CommandPalette, SettingsView + settingsApply, Sidebar, TasksView, Timesheet, Calendar, Day/Week review,
chat store, AssistantPanel/ChatView, Dashboard, BoardView, Canvas, FilingDialogs, first steps, aiswitch and
every AI surface), then each suspected bug driven in the prebuilt app (`bin/arcalo`) with the e2e harness on
Xvfb :502 (probe files `scratchpad/q116/uilogic/t/p1..p10.test.js`, logs `p*.log`, shots
`uilogic/shots/q116-*.png`) or a throwaway vitest against the store (removed again). Earlier quality docs
(q113-*, q115-intro, bugs-next) were read first; none of the findings below is listed there as fixed.
Nothing was committed; the working tree under `ui/` and `e2e/` is unchanged.

Counts: HIGH 2, MEDIUM 10, LOW 8 (20 confirmed), plus 8 suspected.

---

## Confirmed

### U1 HIGH: Global shortcuts and mouse back/forward act behind modal dialogs, the palette and the setup — fixed in 1.16 (e2e 320, keymap.test modalLayer)

Repro (p1): open a page with a subpage, „…“ → „Seite löschen“ (confirm dialog „… und 1 Unterseite
löschen?“ is open), press Ctrl+W: the tab behind the dialog closes (3 → 2 tabs), the dialog stays. Press
Ctrl+N: a page „Unbenannt“ is created and the other tab navigates to it, still behind the dialog. Same for
every keymap command (Ctrl+T, Ctrl+Shift+T stops the running timer, Alt+←/→, Ctrl+K over a dialog, …), for
the palette overlay (Ctrl+W closes the tab under it) and for the mouse back/forward buttons. The first-run
overlay only stops keys while the focus is inside it (FirstRun.tsx:23), so with the focus on `body` the same
happens behind the setup.

Root cause: `ui/src/App.tsx:256` (keydown) and `:277` (mouseup) run commands with no check for an open
modal (`[aria-modal=true]`, `.overlay`, `.fr-overlay`, `.presentation`) and ignore `e.defaultPrevented`
(only the `assistant` command looks at it, `:271`). Dialog (components/ui.tsx:208) only stops Escape and Tab.

Fix: in `onKey`/`onMouse` return early when `e.defaultPrevented` or when a modal layer is open
(`document.querySelector('[aria-modal="true"], .fr-overlay')`), except the commands that are meant to work
over the palette (`palette` toggling it closed). A helper `modalOpen()` next to `commandAllowed` in
keymap.ts keeps it testable.

Guarding test: keymap.test.ts `commandAllowed` with an open modal (pure); e2e: confirm dialog open, Ctrl+W
and Ctrl+N change nothing, Escape closes the dialog, then Ctrl+W closes the tab.

### U2 HIGH: Switching tabs throws away scroll position, caret, undo history and view state — fixed in 1.16 (lib/keepalive.ts, e2e 320)

Repro (p4): long page A scrolled to 3000 px, open page B in a new tab, click A's tab: A is at the top
(`scrollTop` 0). Type in A, switch to B and back, Ctrl+Z: nothing is undone (the history is gone). Tasks view
with „Erledigt“ chosen, switch to another tab and back: „Offen“ again. Same for back/forward in a tab.

Root cause: `ui/src/components/Workspace.tsx:156` keys `.pane-content` by tab id + location and renders only
the active tab, so every switch unmounts the view: NoteEditor (new TipTap instance, empty history, caret at
the start), PageView's `.page-scroll`, TasksView's `status`/`tag` state (TasksView.tsx:71-72), Timesheet's
week (TimesheetView.tsx:41). Nothing remembers per-tab view state (no scroll/selection store).

Fix (two steps): (1) a small per-tab view-state map in the store (`tabState[tab.id] = { scrollTop, selection,
filters }`), written on unmount / `scroll` (throttled) and restored after the editor's first layout
(PageView after `doc` is set, TasksView/Timesheet initial state); history entries carry the scroll offset too.
(2) For page tabs keep the last N (e.g. 5) editor instances mounted but hidden (`display:none`) per pane, so
undo history and caret survive like in Obsidian; or keep the ProseMirror `EditorState` (history included) in
the map and recreate the view from it.

Guarding test: e2e: scroll A, switch to B and back → same `scrollTop` (±1 line); type, switch, Ctrl+Z undoes
the typing; Tasks „Erledigt“ survives a switch. Unit test for the tab-state map (closing a tab drops it).

### U3 MEDIUM: Undo of an earlier settings change also reverts a later change of the same section — fixed in 1.16 (settingsApply revertPaths, e2e 321)

Repro (p3): Settings → Editor, switch on „Typografische Anführungszeichen“ (toast A), 2 s later switch on
„Klammern automatisch schließen“ (toast B). Click „Rückgängig“ on toast A: both are off again
(`smart_quotes false, auto_pair false`); toast B's change is gone without being undone by the user.

Root cause: `ui/src/views/SettingsView.tsx:313-315`: undo restores the whole top-level keys a burst touched
(`pick(b.before, keys)`, e.g. the whole `editor` object as it was before A). Any later change under the
same key is overwritten. (`continueBurst` in lib/settingsApply.ts also merges two different fields of one
section into one toast when they are changed within 1.5 s.)

Fix: keep per burst the deep paths it changed (diff of `before` and the state after it, leaf level) and undo
by writing back only those leaves into the current settings (`revertPaths(current, before, after)`); a leaf
changed again later by another burst is left alone (or the toast of the older burst is dropped when a newer
burst touches the same leaf). Bursts should continue only for the same leaf path, not the same top-level key.

Guarding test: settingsApply.test.ts `revertPaths` (two bursts on `editor.smart_quotes` and
`editor.auto_pair`, undo of the first keeps the second); e2e variant of the repro.

### U4 MEDIUM: During a focus session every „Rückgängig“ toast is swallowed for good — fixed in 1.16 (store toasts test)

Repro (p2, vitest): start a focus session (`focus_start`), delete the open page from „…“: no toast, no undo;
after the session ends (or is aborted) the summary lists only titles, the undo action is lost. Same for tree
rename, settings changes, task done, moves, booked time („Gebucht …“ success feedback). vitest: with
`focus.phase = "work"`, `toast({ action: Rückgängig })` → 0 visible toasts, held `["Seite gelöscht"]`.

Root cause: `ui/src/store/app.ts:519`: all non-danger, non-urgent toasts go to `heldToasts`; the summary
(lib/focus.ts:75 `sessionSummary`) keeps only `title`.

Fix: hold only notifications that are not the direct answer to a user action. Simplest: never hold toasts
with an `action` (undo) or with a `key` of an ongoing change; or mark user feedback toasts `urgent`
implicitly when they carry an action. Background notices (budget, backup, sync) stay held.

Guarding test: store/app.test.ts: during a work phase a toast with an action is shown, a plain info toast is
held.

### U5 MEDIUM: „KI verwenden“ off: the page menu still offers „Besprechung zusammenfassen“ and „KI einrichten“ — fixed in 1.16 (pv.summarize only with AI)

Repro (p2): switch AI off, open a page, „…“: the menu lists „Besprechung zusammenfassen“; choosing it opens
the dialog „Keine KI verbunden – … braucht Arcalo einen KI-Anbieter … KI einrichten“ (shot
`shots/q116-aioff-summary.png`). 1.15 promised no AI surfaces and no „KI einrichten“ anywhere when off; the
slash command of the same action is hidden (AI_SLASH), the menu item is not. e2e 287 does not open the page
menu.

Root cause: `ui/src/views/PageView.tsx:484` adds the item unconditionally.

Fix: `...(aiEnabled() ? [{ label: tr("pv.summarize"), … }] : [])` (PageHeader can read `useAi()`), and let
MeetingSummaryDialog render nothing when `!aiEnabled()`.

Guarding test: extend e2e 287 („the editor has no inline AI …“): the page menu has no „zusammenfassen“.

### U6 MEDIUM: Outline panel shows the headings of another page (source mode, canvas) — fixed in 1.16 (NoteEditor clears outline, SourceEditor sourceOutline, e2e 320)

Repro (p3): page A (rich, headings Alpha, Beta) open, outline panel visible; open page B (source mode,
heading Gamma) in a new tab: the panel shows „Gliederung 2 · Alpha · Beta“ for page B (shot
`shots/q116-outline-stale.png`); clicking an entry does nothing (`scrollToPos` is null).

Root cause: only NoteEditor publishes `outline` (`ui/src/editor/NoteEditor.tsx` `publishOutline`) and its
cleanup clears `editorStats`/`scrollToPos` but not `outline`; SourceEditor (and the canvas) never set it.
OutlinePanel (`ui/src/panels/RightPanel.tsx:83`) shows whatever is in the store as long as the active tab is
a page.

Fix: clear `outline` in the NoteEditor active-effect cleanup (together with `editorStats`), and publish an
outline from the source text in SourceEditor (headings parsed from the Markdown, `scrollToPos` = jump to the
line), or show „Gliederung im Quelltext nicht verfügbar“ there.

Guarding test: e2e: A with headings, B in source mode → panel shows B's headings (or the empty state), not A's.

### U7 MEDIUM: IME composition: Enter commits or submits in the middle of a word — fixed in 1.16 (lib/ime.ts everywhere, ime-guard.test, e2e 320)

Repro (p3, p8; synthetic keydown `{key: "Enter", isComposing: true, keyCode: 229}` as a Japanese/Chinese IME
sends it): page title → the title loses focus and is committed; tree rename (F2) → the field closes and the
name is saved; source editor at the end of `- eins` → `- eins\n- ` (a list item is continued instead of the
candidate being picked). By code the same in ChatView/AssistantPanel chat rename, HistoryView rename,
TaskDialogs, collection controls, CalendarBlocks etc. (96 Enter handlers; only CaptureApp/SearchApp use
`lib/ime.ts`). The handlers that do check use `!e.nativeEvent.isComposing` only (CommandPalette.tsx:405,
Sidebar.tsx:279, dashboard/day.tsx:203, InlineAiBar, TimesheetView/EntryDialog), which misses WebKit on
macOS: there the composition-ending Enter arrives after `compositionend` with `isComposing` false and
keyCode 229 (documented in lib/ime.ts).

Root cause: `ui/src/views/PageView.tsx:547`, `ui/src/components/Sidebar.tsx:1231`,
`ui/src/editor/SourceEditor.tsx:235` (+ the list above).

Fix: use `isComposing(e.nativeEvent)` from lib/ime.ts in every Enter/Escape handler of a text field (a lint
rule or a `onEnter(handler)` helper), including Escape (cancels the rename/title edit during composition).

Guarding test: ime.test.ts already covers the helper; add an e2e that dispatches the composing Enter on title,
tree rename and source view and asserts nothing happened; a grep test that `key === "Enter"` in a file with
an `<input`/`<textarea` goes through `isComposing`.

### U8 MEDIUM: Escape that closes the slash menu or the find bar also ends the focus mode — fixed in 1.16 (keyConsumed, e2e 320)

Repro (p5): Ctrl+. (focus mode), type `/`, Escape: the menu closes and the focus mode ends. Same with Ctrl+F,
Escape in the find bar. Users press Escape to dismiss a popup, not to leave the mode.

Root cause: `ui/src/App.tsx:260` ends the focus mode on any Escape that reaches `window` while the palette is
closed; the editor's suggestion popup, the find bar, the inline AI bar and the title field handle Escape
without `stopPropagation` and the check ignores `e.defaultPrevented`.

Fix: `if (e.key === "Escape" && st.focusMode && !st.paletteOpen && !e.defaultPrevented && !modalOpen())`, and
make the suggestion popup / find bar `preventDefault` their Escape (the find bar does already).

Guarding test: e2e: focus mode, slash menu, Escape → menu closed, still focus mode; second Escape ends it.

### U9 MEDIUM: „Rückgängig“ on a move toast undoes the latest move, not its own — fixed in 1.16 (move toast key move-undo)

Repro (p9, via the commands the toasts use): move page A into „Ordner Eins“ (toast 1 „1 Seite verschoben –
Rückgängig“), then B into „Ordner Zwei“ (toast 2). „Rückgängig“ of toast 1 runs `move_undo`: B goes back, A
stays in „Ordner Eins“; a second undo returns 0. Toast 1 still offers its undo while it would undo B.

Root cause: `ui/src/components/FilingDialogs.tsx:49` every toast calls `undoLastMove()`; the core keeps one
move only (`filing/tidy.rs:468 undo_last_move`).

Fix: give each toast the move it belongs to (a `move_id`/seq from `pages_move`) and let `move_undo(id)` refuse
when it is not the last one (toast says „Nur das letzte Verschieben kann rückgängig gemacht werden“), or
dismiss older move toasts (`key: "move-undo"`) when a new move happens. The `key` is the one-line UI fix.

Guarding test: e2e: two moves, the first toast is gone (or its undo refuses), the second undo puts B back.

### U10 MEDIUM: A purged page's id is reused and the new page inherits its view modes and tabs state — fixed in 1.16 (migration 0035_page_id_floor, db test)

Repro (p10): page id 15 in source mode and full width, delete it and empty it from the trash, create „Ganz neue
Seite“: it gets id 15 again and opens in source mode with full width. The same goes for anything the UI keys
by page id in localStorage (`arcalo.page-source`, `arcalo.page-full`, collapsed tree folders, smart-folder
and canvas prefs) and for in-memory caches (LinkPreview 10 s cache, chat `attachedPage`).

Root cause: `pages.id INTEGER PRIMARY KEY` without AUTOINCREMENT (`crates/arcalo-core/migrations/0001_init.sql:72`)
lets SQLite reuse the highest id after a purge; the UI's per-page stores (`ui/src/lib/pageModes.ts`) are never
cleaned on purge.

Fix: never reuse page ids (core: keep a high-water mark in a meta row and insert with `max(seq, max(id)) + 1`,
via a new positional migration), and drop per-page UI state when a page is purged (`page_purge` emits
`data://purged` → pageModes/collapsed remove the id).

Guarding test: core unit test: create, purge, create → new id > old id; e2e repro asserts the rich editor.

### U11 MEDIUM: Closing the palette or quick switcher drops the focus to the page body — fixed in 1.16 (palette restores focus, e2e 320)

Repro (p7): caret in the editor, Ctrl+K, Escape: `document.activeElement` is `BODY`; the same with Ctrl+O +
Escape and with a palette command that does not navigate (e.g. „Seitenleiste ein/aus“). Typing afterwards
goes nowhere; the user has to click back into the note.

Root cause: `ui/src/components/CommandPalette.tsx:105` `close()` only sets `paletteOpen: false`; the opener
is not remembered (Dialog and Menu do restore focus).

Fix: remember `document.activeElement` when the palette opens (effect on `open`), restore it on close unless
the command moved the focus (check `document.activeElement === document.body` after the command ran, next
frame).

Guarding test: e2e: editor focused → Ctrl+K → Escape → the ProseMirror has the focus with the same caret.

### U12 MEDIUM: Rich editor and source view differ: no failed-save state and fixed autosave in the source view — fixed in 1.16 (SaveFailed and saveDelay in the source view, e2e 321)

Repro (p9): source view, `test-disk-full` in the data folder, type: only the error toast; the rich editor
shows the „Wird erneut versucht“ pill (`.save-failed`, NoteEditor.tsx:741) and `data-save-status`, the source
view shows nothing and no status attribute. The source view also saves after a fixed 700 ms
(`SourceEditor.tsx:16`) and ignores Settings → Editor „Automatisch speichern nach“ (250-3000 ms) that the rich
editor follows (`saveDelay()`).

Root cause: `ui/src/editor/SourceEditor.tsx:16`, no `status` state in SourceEditor.

Fix: share the save loop (status, retry, delay) between both editors (a `useSaveLoop` hook in saves.ts) and
render the same pill in the source view.

Guarding test: e2e 29-style disk-full test for the source view (pill shown, retried, gone after the disk
frees); unit test that both use `saveDelay()`.

### U13 LOW: „KI verwenden“ off: Settings → Tastatur still lists „Assistent“ and „Chat öffnen“ — fixed in 1.16 (KeyboardSection filters AI_SHORTCUTS)

Repro (p5): AI off, Settings → Tastatur shows both commands with Ctrl+J / Ctrl+Shift+J; the shortcuts do
nothing (App ignores AI_SHORTCUTS). Time tracking off hides its timer shortcuts the same way.

Root cause: `ui/src/views/settings/KeyboardSection.tsx:36` filters only TIME_SHORTCUTS.

Fix: also filter `AI_SHORTCUTS` when `!aiOn(view)`.

Guarding test: e2e 287 settings check: no „Assistent“/„Chat“ row in Tastatur.

### U14 LOW: Start setting „Startseite“/„Tagesnotiz“ restores the last tabs and overwrites the active one — fixed in 1.16 (start page and daily note in their own tab)

Repro (p4): tabs [Undo A, Aufgaben (active)], Settings → Start → Öffnen „Startseite“, restart: tabs
[Undo A, Neuer Tab]; the old tabs are restored and the last active tab was navigated to the start page
(its location moved into the back history). With „Tagesnotiz“ the same happens with the daily note. README
says „open the last tabs, the start page or today's note“.

Root cause: `ui/src/store/app.ts` `loadLayout()` always restores the layout; `ui/src/App.tsx:80` /
`:77` then `openTab`/`openPage` navigates the active tab.

Fix: for `dashboard`/`daily` either start from an empty layout (pinned tabs kept) or open the start page /
daily note in a new tab (`{ newTab: true }`) so no restored tab is overwritten. Decide which; the second is
the minimal fix.

Guarding test: e2e restart test for both settings.

### U15 LOW: Undo of deleting the open page brings the page back but not its tab — fixed in 1.16 (deletePage undo reopens the tab, e2e 321)

Repro (p4): open page, „…“ → „Seite löschen“ → toast „Rückgängig“: the page is restored, its tab and its
back/forward entries are gone (the user sees another tab).

Root cause: `ui/src/views/PageView.tsx:721` undo calls `restorePage` only; `refreshTree` had dropped the tab
(`store/app.ts` refreshTree `alive`).

Fix: remember the tab (pane, index, history) before deleting and reopen it in the undo.

Guarding test: e2e: delete open page, undo → the page's tab is active again.

### U16 LOW: Delete in the page tree leaves the focus on `body` — fixed in 1.16 (tree Delete focuses the next row, e2e 321)

Repro (p9): focus a tree row, Delete: the page goes to the trash, `document.activeElement` is `BODY`;
keyboard users must Tab back into the tree.

Root cause: `ui/src/components/Sidebar.tsx:824` (`deletePage(n)` / `deleteSelection`) never moves the focus
to a neighbour row.

Fix: before deleting, compute the next (or previous) visible row and `focusRow()` it after `refreshTree`.

Guarding test: e2e 281-style: Delete on a row → the next row has the focus.

### U17 LOW: Dragging one page in the tree has no undo, dragging several has — fixed in 1.16 (single drop through movePages)

Confirmed by code: the multi-drop goes through `movePages` → `toastMoved` with „Rückgängig“
(FilingDialogs.tsx:43-58); the single drop calls `api.movePage` and `refreshTree` only
(`ui/src/components/Sidebar.tsx:560-571`), no toast, no undo. Single moves (the common case) cannot be undone.

Fix: route the single drop through `filingApi.movePages([id], …)` too (same undo record and toast).

Guarding test: e2e drag one page into a folder → toast with „Rückgängig“ → back in place.

### U18 LOW: German text in the English UI (tag view, PDF cards) — fixed in 1.16 (tag.count and file.pdfPages, i18n-strings GERMAN_WORDS)

Confirmed by code: `ui/src/views/TagView.tsx:27` writes „Seite/Seiten“ literally; `ui/src/editor/fileEmbed.ts:207`
writes „12 Seiten“ on PDF cards. Neither goes through the catalogs, so the English UI shows German, and the
translation check does not see it.

Fix: `t("tag.count", { n })` / `t("file.pdfPages", { n })` in de.ts and en.ts.

Guarding test: i18n-strings.test.ts: no German words in string literals outside locales (this pattern).

### U19 LOW: Shortcut hints ignore the user's keymap — fixed in 1.16 (firststeps command ids, firststeps.test)

Confirmed by code: „Erste Schritte“ shows fixed „Ctrl N“, „Ctrl Shift D“, „Ctrl J“ and „Ctrl K“
(`ui/src/onboarding/firststeps.ts:91-98`, FirstStepsCard.tsx:78), the daily note's calendar button says
„Ctrl Shift C“ (PageView.tsx:431), „Eigenschaft hinzufügen“ says „Ctrl ;“ (PageView.tsx:625), regardless of
Settings → Tastatur. Other places already use `hint(id)`.

Fix: `hint("new_page")`, `hint("daily_note")`, `hint("assistant")`, `hint("palette")`, `hint("calendar")`,
`hint("add_property")`; hide the hint when unbound.

Guarding test: firststeps.test.ts with a remapped keymap.

### U20 LOW: A second confirm replaces the first one, whose promise never settles (window close can get stuck) — fixed in 1.16 (store confirm test)

Repro (vitest against the store): `confirm(A)`, then `confirm(B)`, answer B: A stays pending forever. In the
app: closing the window while a save fails shows „Ungespeicherte Änderungen“ (`flushBeforeExit`); tray
„Beenden“ meanwhile asks again and replaces it; the first close handler waits forever with `closing = true`
(App.tsx `onCloseRequested`), so the window's close button does nothing any more after the user cancels.
Other overlapping confirms (large paste + delete, cost limit + anything) leave their awaiting code hanging.

Root cause: `ui/src/store/app.ts:272-288` `choose()` overwrites `confirmRequest` without resolving the
previous one.

Fix: resolve the previous request with "cancel" before setting the new one (or queue them).

Guarding test: store/app.test.ts: two confirms → the first resolves `false`.

---

## Suspected, not confirmed

- S1 Stale page in PageView callbacks: `onChange={(d) => setDoc({ ...doc, ...d })}` (`ui/src/views/PageView.tsx:278`) — fixed in 1.16 (setDoc from the newest page)
  spreads the `doc` of the render the click/blur happened in. `commitTitle` awaits `flushAllEditors()` (which
  updates `doc.content` via `onOwnSave`) and then calls `onChange({ title })` with the old content; in the
  source view the `[doc.content]` effect then shows the pre-save text until the `reloadEditors()` refetch
  lands (a flash; a keystroke in that window would be saved on top of the old text). Same pattern for the
  favorite and icon buttons when a save lands during their request. Fix: `setDoc((cur) => cur && { ...cur, ...d })`.
- S2 `settings://changed` refetch race (`ui/src/App.tsx:136`): two quick saves, the refetch started after the — fixed in 1.16 (an older settings answer is dropped)
  first resolves after the second save and is applied (`JSON` differs from the store) → the store (and the
  settings form) briefly flip back to the first state. Fix: ignore answers older than the latest own save
  (sequence number), or let the event carry the saved settings.
- S3 Stale results of fast input: AssistantPanel route preview (`panels/AssistantPanel.tsx:460`, no — fixed in 1.16 (sequence checks: sidebar search Enter, export preview, issues list, route preview)
  sequence check), Timesheet export preview (`views/TimesheetView.tsx:979`), IssuesView list on filter change
  (`views/IssuesView.tsx:87`), Sidebar search Enter opens the first hit of the previous query while the
  new one is still debounced (`components/Sidebar.tsx:279`).
- S4 Toast eviction: `toast()` keeps only the last three non-persistent toasts (`store/app.ts`), so a fourth — fixed in 1.16 (trimToasts keeps action toasts)
  quick message removes an older „Rückgängig“ (e.g. delete, then three settings changes). Consider keeping
  action toasts until their timeout.
- S5 Board view drag (`views/collection/BoardView.tsx` `onCardDown`): no `pointercancel` handler and no — fixed in 1.16 (BoardView pointercancel and Escape)
  Escape to cancel; a lost pointerup leaves the drag ghost and listeners until the next click.
- S6 `goDay` in the daily note header (`PageView.tsx` `goDay`) computes from the shown day; two quick clicks — fixed in 1.16 (pendingDay)
  both open the next day instead of moving two days.
- S7 Rename in the page title has no undo toast while the tree rename has one (inconsistent). — fixed in 1.16 (editor/rename.ts shared with the tree)
- S8 Canvas: Space with a focused button inside the canvas starts panning instead of pressing the button — fixed in 1.16 (Space on buttons in the canvas presses them)
  (`views/canvas/CanvasView.tsx:730`).
