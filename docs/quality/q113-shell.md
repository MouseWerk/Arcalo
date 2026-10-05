# q113 A3: Shell

Scope (plan113.md, A3): pinned tabs, renaming in the page tree in place, the right panel's view strip as
one Tab stop, the Projekte table in narrow panes. Method: code read of store/app.ts (tabs, layout),
Workspace (tab bar), Sidebar (tree), RightPanel, ProjectsView; before/after shots of the real app under
Xvfb in annalo-dark, annalo-light and contrast-dark at 1280x800 and a split pane at 1100x800, German and
English (scratchpad/q113-shots/shell/, before-*/after-*/cmp-*).

## Built
1. Pinned tabs. `Tab.pinned` in the stored layout (localStorage, so restarts and split panes keep it;
   no settings or migration step). Pin/unpin from the tab menu („Tab anheften“ / „Nicht mehr
   anheften“), the palette (names the active tab) and the keymap command `pin_tab` (Settings → Tastatur;
   no default combo: no free combo fits, Ctrl+Shift+P presents and Ctrl+Shift+K is the usual global
   palette). Pinned tabs sit left in pin order (pinning appends to the group, unpinning puts the tab
   first after it, a tab dropped into the group lands after it, „Nach links/rechts“ stays inside the
   group), are compact (icon, title up to 8ch, a pin button in place of the close button that unpins;
   a hairline before the other tabs; icon only in a tab bar under 560 px), are named „…, angeheftet“
   for screen readers. „Andere Tabs schließen“, „Tabs rechts schließen“ and the new „Alle Tabs
   schließen“ skip them; a middle click does not close them (Ctrl+W, Entf and „Schließen“ do).
   Navigating from a pinned tab opens a new tab after the pinned ones (the pinned page keeps its place,
   as in Obsidian). Tests: store/app.test.ts, keymap.test.ts, e2e 280.
2. Rename in the tree. F2, „Umbenennen“ in the menu and a double click on the title turn the row's
   title into a field in place (the page is not opened by F2; a double click's first click opens it as
   a single click does). Enter saves through `page_rename` with links rewritten (as the title field
   does), the focus returns to the row, the toast „Umbenannt in „…““ names the rewritten links and
   „Rückgängig“ renames back (links too). Escape cancels; leaving the field saves a valid name and
   drops an invalid one. Empty and taken names (case-insensitive, as the core checks) give an inline
   message under the row (role=alert, aria-invalid, aria-describedby); `[ ] | # ^` are replaced while
   typing with the existing hint (role=status). Folders work the same (their subpages stay). The row
   stays rendered in a virtualized tree while renaming. Tests: lib/filing.test.ts (renameProblem),
   e2e 281.
3. Right panel view strip: roving tabindex (one Tab stop), arrows wrap, Home/End, named tablist,
   tabs with ids and aria-controls, the body is the tabpanel labelled by the selected tab. e2e 281.
4. Projekte table in narrow panes (SideScroll): a shadow on each edge that hides columns (on the left
   behind the pinned name column, new token `--scroll-shadow`, also derived in lib/themes.ts), a small
   round button at the header's right end that pages there, and the box becomes one Tab stop with a
   region name („weitere Spalten rechts …“) only while it scrolls, so the arrow keys scroll it. Tests:
   components/sideScroll.test.ts, e2e 281.

## Findings fixed on the way
1. MEDIUM (visual) Projekte in a very narrow split pane (about 200 px of table): the pinned 220 px name
   column filled the whole box, the other columns could never be seen, however far it scrolled. Fix:
   under a 520 px pane the name column gives up room (120 px). before/after: *-split-*.png.
2. LOW (visual) Projekte in a wide pane scrolled sideways by 14 px: the three row buttons (3 × 22 px plus
   cell padding) overflowed their 64 px column. Fix: 92 px for that column, minimum widths adjusted
   (name keeps 220 px). Test: e2e 281 (wide pane: nothing hidden, no extra Tab stop).

## Left as is (report)
- A double click on a tree title first opens the page (the single click), then renames; delaying every
  single click to tell them apart would make opening pages feel slow.
- Renaming several selected rows at once is not offered (F2 and the double click need one row).
- The pin shortcut has no default combo (see above); the palette and the menu show the combo once set.
