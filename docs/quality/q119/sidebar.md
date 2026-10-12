# 1.19 file explorer sidebar

From the sidebar audit of 2026-10-12 (414- and 5,050-page workspaces, screenshots at 900/1280/1920 px in
light, dark and contrast). The owner chose on 2026-10-12: fix every bug and polish problem; add navigation,
the better filter, more actions for a selection, dragging into the editor and panes, and more options for
creating things. No remake: the four tabs stay. No indent guides.

## Bugs

1. Opening a page expands its ancestors but does not scroll the tree to it (`Sidebar.tsx`, the reveal
   effect only edits `collapsed`); also for pages opened in a split pane.
2. The multi-select bar is translucent (`--bg-current`), its count is cut ("4 au…" at 1280 px, gone at
   900 px), and the rows jump down when it appears.
3. Clicking a filed folder (Tagesnotizen, a year, a month) opens an empty system page and does not expand it.
4. In folders sorted by name or date, drop before/after and „Nach oben/unten“ are offered but do nothing.
5. The filter keeps the old scroll position; Enter in the filter opens nothing.
6. New folders start expanded (only collapsed ids are stored); revealing expands ancestors for good; ids of
   deleted pages are never pruned.
7. „Lesezeichen“ and „Favoriten“ name the same thing; „Letztes Aufräumen rückgängig machen“ also undoes
   plain moves.
8. „Nach oben/unten“, „Eine Ebene höher“ and „Auf die oberste Ebene“ have no undo (one path through
   `pages_move` for all moves).
9. Accessibility: `aria-selected="false"` on every row, no `aria-setsize`/`aria-posinset`, no typeahead, the
   context menu inside `role=tree`, Ctrl+Space missing from the key help, smart folders, bookmarks and tags
   without the tree keyboard model.
10. Truncated titles have no tooltip.
11. Build: `arcalo-cli` also builds a binary named `arcalo` and overwrites the app in `target/debug`, which
    hangs e2e runs.

## Polish

- Open and selected rows differ by 0.02 alpha only; the contrast themes show the same ring for both.
- Drop-inside uses an accent tint and an accent ring; the before/after line is accent-coloured and not
  indented to the drop depth. Neutral, as the design rules require.
- Deep levels: 14 px per level as an inline style (make it a token); the sidebar is capped at 216 px at
  900 px.
- Hover actions squeeze the label; the inline rename field is narrow for long titles.
- The context menu is nearly window height (the icon picker as a popover instead of a submenu).
- During onboarding the empty sidebar still shows collapse-all and options.

## Features

- **Navigation:** „Im Baum zeigen“ with a shortcut and automatic reveal on open (pages open in other panes
  marked); filed folders toggle on click; new folders start collapsed (store expanded ids); auto-expand
  and auto-scroll while dragging; typeahead; a muted child count on folders.
- **Filter:** highlighted matches, path matching („Kunde/Angebot“), fuzzy matching, Enter opens the first
  hit, scroll reset.
- **Selection actions:** favourite, colour, tag, duplicate and export for several pages at once, besides
  move and delete. Ctrl/Cmd+click keeps selecting.
- **Drag and drop:** a page dragged into the editor inserts a `[[link]]`, onto a pane opens it there, onto
  the empty tree area moves it to the top level; undo for every move.
- **Creating:** the „Neu“ entries offer every kind the app has (page, canvas, drawing, from a template,
  and whatever else exists), in the toolbar, the context menu and the empty tree area, with the target
  folder preselected.

Nothing here moves pages on its own: „Aufräumen“ stays the only bulk path.
