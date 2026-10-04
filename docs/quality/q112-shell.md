# q112 A7: app shell and views

Method: code read of Shell, Ribbon, WindowControls, Workspace (tabs/panes), Sidebar (tree), CommandPalette,
ui.tsx (Menu, Dialog, Segmented, IconButton), tooltip.ts, store/app.ts (tabs, toasts, layout restore),
a11y.css, TasksView, IssuesView, GraphView/GraphCanvas, Dashboard (aria), plus the real app under Xvfb :436
(DE light/dark/contrast-dark, EN, 900/1280/1920 px, split panes, zoom 150 %). Screenshots: q112-shots/shell/.

## Findings (severity, repro, root cause, fix, test)

1. HIGH (a11y) Context menus were unusable with a screen reader: arrows only moved a CSS highlight, focus
   stayed on the trigger, so nothing was announced; checked items had no state; Tab left the menu open.
   Root cause: Menu handled keys on window and never moved focus. Fix: keyboard navigation focuses the item,
   focus returns to the opener before the action runs and on Escape/Tab/close (layout-effect cleanup,
   before the DOM is removed); menuitemcheckbox + aria-checked; role=separator; Home/End; Tab closes.
   Test: components/menuFocus.test.ts; e2e 200 (menu from the tree via Shift+F10).
2. HIGH (a11y, WCAG 2.2.1) Toasts closed after 3–8 s even while pointed at or focused; the undo button of
   „Seite gelöscht“ could vanish under the pointer / during Tab navigation. Fix: store holdToasts(); the
   Toasts host holds while hovered or focus-within and restarts with at least 1.5 s; manual close clears
   the timer. Test: store/app.test.ts (fake timers), e2e 200 (toast stays 8.5 s under the pointer).
3. MEDIUM Palette did not find umlaut titles typed without umlauts („ubersicht“, „uebersicht“, „strasse“
   found nothing, offered „Seite anlegen“). Fix: lib/fuzzy.ts folds case/accents/ß and the written-out
   umlaut spelling; same ranking otherwise. Test: lib/fuzzy.test.ts, e2e 200.
4. MEDIUM (a11y) Palette: input was not a combobox, no aria-activedescendant (selection never announced),
   Tab moved focus into the app behind the modal. Fix: combobox/listbox wiring with option ids,
   presentation roles for section wrappers, Tab kept in the dialog. Test: e2e 200.
5. MEDIUM (a11y) Tab bar: role=tablist sat on the whole bar (buttons +, split, panel inside a tablist),
   every tab's close button was its own Tab stop, tab names included „Tab schließen“, no Home/End.
   Fix: tablist on .tabs with a name, aria-label per tab, close button tabIndex -1 (Delete and the menu
   close), Home/End. Test: e2e 200.
6. MEDIUM (visual) Tabs in a narrow pane shrank to one letter („K.“, „J.“): 72 px minimum, of which
   ~45 px were icon, gaps and an invisible close button. Fix: 104 px minimum, the close button lies over
   the title end (title fades under it on hover), only the active tab reserves room. before/after:
   *-tabs-overflow.png.
7. MEDIUM Page tree: dragging a page onto its own subpage showed a valid drop marker, then failed with
   „Verschieben fehlgeschlagen“. Fix: filing.isWithin; no drop target inside the dragged page(s).
   Test: lib/filing.test.ts.
8. MEDIUM Page tree keyboard: Shift+Arrow only ever added rows (going back did not shrink the range),
   no Delete key, no F2, no Ctrl+A; a multi-selection could only be moved, not deleted.
   Fix: range from the anchor, Ctrl+A selects all visible rows, F2 = Umbenennen, Entf (Cmd+Backspace on
   macOS) moves to the trash (one page: as before with undo; several: one confirmation, one undo toast),
   „N Seiten löschen“ in the selection menu, shortcuts shown in the menu. Test: e2e 200.
9. LOW (a11y) Sidebar pane tabs (Dateien/Suche/Lesezeichen/Tags): four Tab stops, no arrows, unnamed
   tablist. Fix: roving tabindex, arrows/Home/End, name; the search pane no longer steals the focus from
   the tab row. Test: e2e 200.
10. LOW (a11y) Segmented (radiogroup) was a row of Tab stops without arrow keys (all views and dialogs).
    Fix: roving tabindex + arrows. Test: menuFocus.test.ts.
11. LOW (contrast themes) forced-color-adjust is inherited: inside selected tree rows (multi-select),
    options, tabs, aria-current items, faint/child text kept author colors on Highlight. Fix: a11y.css
    gives HighlightText to the children of every highlighted state.
12. LOW Tasks: finishing a task under „Offen“ removed it with no way back. Fix: toast „Aufgabe erledigt“
    with Rückgängig. The status filter had no accessible name. Test: e2e 200.
13. LOW Sidebar search: when all hits were time entries with time tracking off it showed „0 Seiten“ and no
    empty message; the result count is now a status (announced).
14. LOW Ribbon view buttons expose aria-current="page" for the open view.

## Checked, no change needed
Dialog focus trap and restore; tooltips (focus-visible shows, any key hides, flip at edges); graph has a
keyboard model, live region and list alternative; dashboard edit mode has keyboard moves and live region;
Issues rows are buttons with aria-expanded; layout restore drops tabs of deleted pages; window controls
named; reduced motion handled globally (prefs.css + base.css); zoom 150 % at 1280 px keeps everything
reachable (sidebar auto-hides).

## Left out (report)
- Tab pinning does not exist (feature, not a fix): no pinned state in Tab/layout.
- Recurring tasks and bulk actions in the Tasks view do not exist (features).
- Inline rename inside the tree row: F2 opens the page with the title selected instead (existing flow).
- Projects table (836 px min) scrolls sideways in narrow panes; the cut-off last column has no fade hint.
- Page header toolbar in a 450 px pane at 900 px window clips one icon (editor area, other agent).
- Forced colors cannot be emulated in WebKitGTK; contrast checked with the contrast-dark theme and CSS.
