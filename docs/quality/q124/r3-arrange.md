# q124 round 3, hunt B: everything that edits or arranges content

Round 3 of the [plan](plan.md), branch `q124-r3b`. This hunt looked at what changes or arranges content other than
typing text: the page tree (drag and drop, multi-select, moves, „Aufräumen“, rename in place, delete with undo,
favorites, smart folders), tabs and split panes (open, close, drag between panes, pinned tabs, the layout after a
restart), the table and board of a page's subpages, the canvas, templates, the presentation, drawings and Mermaid,
images, embeds, the property editor, the outline and links panels and the graph. The question each time: can the
wrong page be changed, can undo bring back the wrong thing, can a change be lost when tabs switch or close, can two
panes on the same page drift apart.

Severity as in the plan. Findings: 1 high, 2 medium, 9 low; the high and medium ones (and one low) are fixed at the
root with tests.

## Findings

### R3B-1 A canvas open in two panes put back what the other pane had changed (high, fixed)

- Symptom: the same canvas side by side (Rechts daneben öffnen), a card deleted in the left pane: the right pane
  kept showing it. The next edit in the right pane (a card moved, a text typed, another card deleted) saved the right
  pane's whole board, so the card deleted on the left came back, cards moved or added there went back or vanished.
  The same happened with one pane: a canvas tab dragged to the other pane right after an edit could open with the
  board as stored before that edit (the save of the closed view still on its way), and the next edit wrote the old
  board. Undo in a pane after the board took over another change went back to a whole-board snapshot from before it,
  so it undid the other pane's change too.
- Root cause: `CanvasView` took over only `arcalo:reload-pages` (a sync, a version restored), not
  `arcalo:page-saved`, the event every other view of a page follows; its saves carry the whole JSON without a base,
  so the last view to save wins. The undo history holds whole-board snapshots.
- Fix: each canvas view has an instance id and sends it with its saves; another view of the same board takes the
  saved board over, or, with edits of its own not saved yet, merges card by card and connection by connection
  (`lib/canvas/merge.ts`: what one side changed is taken from it, a card both changed keeps this side's, a card one
  side deleted stays deleted unless the other changed it) and saves the result. The undo and redo states are rebased
  onto the new board with the same merge, so undo takes back only this pane's own steps. A board taken over after a
  sync or version restore goes through the same path.
- Tests: unit `lib/canvas/canvas.test.ts` („canvas merge (the same board in two panes)“: deletes, additions,
  both sides changed, order of added cards, undo after a rebase); e2e `540-arrange-panes` (failed: the right pane
  kept the deleted card; now a delete in each pane and an undo in the right one leave exactly the expected cards,
  stored and in both panes).

### R3B-2 After a rename elsewhere the open page kept its old title, icon and star (medium, fixed)

- Symptom: a page open in a tab and renamed in the sidebar (F2 or a double click), in another pane, in the title
  column of its parent's table, or taken back with „Rückgängig“: tab, tree and breadcrumbs showed the new title, the
  page's own title field the old one. The same for an icon changed in the sidebar and for the star („Favorit“) set or
  removed there. „Link kopieren“ in that page's menu copied `[[old title]]`, a link that no longer resolves.
- Root cause: `PageView` loads the page once and refreshes only text, tags and backlinks after a save or a rename
  elsewhere; title, icon and favorite of its `doc` were never updated from the tree.
- Fix: `PageView` follows the tree's title, icon and favorite of its page.
- Test: e2e `540-arrange-panes` („a page renamed in the sidebar shows its new title in its open tab“; failed: the
  field still said „Alter Name Baum“).

### R3B-3 A title typed and the tab closed with Ctrl+W was lost (medium, fixed)

- Symptom: click into a page's title, change it, press Ctrl+W: the tab closed and the page kept its old name.
- Root cause: the title (like a table cell being typed in and a property's name) stores its value when it loses the
  focus. Closing a tab by key unmounts the field while it still has the focus, and the title's blur handler never
  ran. (A property value typed and closed the same way was kept in the test also before the fix; the fix does not
  rely on which fields get a blur on removal.)
- Fix: `closeTab`, `closeOthers` and `closeAll` blur the focused element first when it is inside a tab they close
  (`blurClosing` in `store/app.ts`), so the field stores its value as on any other way out.
- Tests: unit `store/app.test.ts` („closing a tab first blurs its focused field…, not a field elsewhere“); e2e
  `540-arrange-panes` (title: failed before, the page kept „Titel Schliessen“; a property typed and Ctrl+W).

### R3B-4 A canvas below a page with a table or board showed as a row or card (low, fixed)

- Symptom: a canvas created or moved below a page that shows its subpages as a table or board appeared there as a
  row or a card in „Ohne Wert“. Dragging the card to a column showed „„Skizze“ → Fertig“ with „Rückgängig“ and then
  „Eigenschaft nicht gespeichert: Keine gültige Canvas-Datei“; the count said one page more. With a canvas before
  them in the folder, a card dropped onto another landed one place too early.
- Root cause: `page_collection(_view)` listed every child; a canvas has no frontmatter (the core refuses to write
  one, so nothing was damaged). The board's reorder passed the index among the rows to `page_move`, which counts all
  subpages.
- Fix: the core lists no canvas as a row; `moveRow` takes the place among all subpages of the tree. It also sorts
  the rows from the current ones, so a value just written by a drop on another column is not replaced by the row as
  it was before the drop.
- Tests: core `properties::tests::a_canvas_below_a_collection_is_no_row`; e2e `541-arrange-collections` (no card,
  canvas text unchanged, a card dropped onto another lands right before it with a canvas first in the folder).

## Low (listed, not fixed)

- L1 Moving the active tab to another pane makes the first tab of the old pane active, not its neighbour (closing a
  tab picks the neighbour).
- L2 The image menu acts on the position the image had when the menu opened: should the note change meanwhile (a save
  of another pane, the command line), „Größe“ or „Aus Notiz entfernen“ can act on a neighbouring node. Needs a change
  arriving within the seconds the menu is open.
- L3 Reordering table columns stores only the visible ones in `spalten`; a hidden column shown again goes to the end.
- L4 „Neue Seite aus Vorlage…“ from the palette always creates at the top level; Settings → Editor („Neue Seiten
  in…“: Inbox, current folder) is not applied as for other new pages.
- L5 „Rückgängig“ after deleting several pages in the sidebar restores them but does not reopen their tabs (deleting
  one page reopens it where it was shown).
- L6 A template whose file has Windows line ends (`---\r\n`) keeps its frontmatter in the new page.
- L7 Renaming a page in the title column of a table offers no „Rückgängig“ (the sidebar and the page title do).
- L8 A move that moved nothing clears „Rückgängig“ in the tree options although the core keeps the previous move's
  undo.
- L9 With a folder sorted by title in the sidebar, the board's card order still follows the stored page order, and
  reordering cards there changes nothing visible in the sidebar.

## Checked without findings

- Tree: drag and drop before, after and into pages (manual and sorted folders, „Ordner zuerst“), multi-select with
  Ctrl and Shift and its drag, moves into the own subtree (refused), delete with undo of one page and of a
  selection (positions kept), duplicate (after the page, with the last edits), favorites, „Aufräumen“ with undo
  (core tests and 121/386-388).
- Tabs and panes: open, close, duplicate, pin, drag within and between panes, „Andere/Alle Tabs schließen“, the
  layout after a restart, kept tabs keeping undo and scroll (31, 280, 320, 370, 380 run on this branch). Read in the
  code: a note open in two panes merges both sides' edits, a note moved to another pane right after typing takes over
  the closed editor's save. There is no „Tab wieder öffnen“ (Ctrl+Shift+T is the timer).
- Board and table: drag between columns several times (the card stays where it was dropped once every answer is
  in), undo of a drop, a cell cleared with Delete (undo toast), property edits through an open editor of the child
  (one writer), option renames.
- Templates with placeholders (stray and unknown braces, frontmatter dropped), embeds `![[…]]` (live, renamed with
  the page), unlinked mentions „Verlinken“ (refused when the text moved), the outline and links panels following the
  focused pane, presentation (flushes editors first).
