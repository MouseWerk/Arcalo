# q123: drawings (Excalidraw) and Mermaid

Owner report: "ich kann keine Mermaid einfügen in Excalidraw, also im Feld kann ich nicht tippen".

Tests: e2e `e2e/tests/412-drawing-inputs.test.js` (new), unit `ui/src/editor/drawing.test.ts`
("drawing editor bounds"). Existing coverage kept: e2e 29 (drawings), 124 (Mermaid in notes).

## D1. Nothing can be typed into Excalidraw's dialogs (Mermaid, command palette). FIXED

- Symptom: "Mermaid to Excalidraw" opens, the field shows the example, but keys do nothing; Ctrl+Enter
  does not insert. Same for Excalidraw's command palette (Ctrl+/) and every other Excalidraw dialog.
- Root cause: `DrawingEditor.tsx` makes the overlay modal with a `keydown` listener on `window`
  (capture) that calls `preventDefault()` and `stopImmediatePropagation()` for every key whose target
  is not inside `.drawing-overlay`, and moves the focus back to the canvas. Excalidraw's `Modal`
  renders through a portal into `div.excalidraw-modal-container` appended to `<body>`
  (`useCreatePortalContainer`), i.e. outside the overlay, so every key typed in its fields was dropped.
  The same guard also cleared the document selection when it was "outside" (the dialog's field).
- Reproduced: e2e 412 on the unfixed build: the field still held Excalidraw's example
  (`flowchart TD / A[Christmas] ...`) after typing.
- Fix: `inDrawing(root, node)` (`ui/src/editor/drawing.ts`) counts Excalidraw's modal container as part
  of the drawing; the key guard, the selection cleanup and the initial blur use it. App shortcuts still
  do not fire there: the overlay's React `onKeyDown` stops propagation for the portal too (asserted with
  Ctrl+K in the Mermaid field).
- Tests: e2e 412 "the Mermaid dialog takes typing and inserts the diagram" (type, preview renders under
  the CSP, Ctrl+Enter inserts, scene saved with the nodes and the arrow, note unchanged), "Esc in the
  Mermaid dialog closes only the dialog", "Excalidraw's command palette ... take keys"; unit test.

## D2. Links in the drawing editor could replace the app in its window. FIXED

- Symptom: the Mermaid dialog's syntax links (`<a href="https://mermaid.js.org/...">`, no target) and
  links in Excalidraw's help navigated the app's own WebView; a shape's link opened via
  `window.open` (`_self` for local-looking links).
- Root cause: no handling for links inside Excalidraw; the app has no navigation guard of its own.
- Fix: a click listener (capture) for anchors inside the drawing opens web and mail links with the
  opener plugin and never navigates; `onLinkOpen` for shape links: element links scroll to the
  element, web/mail links open outside, anything else is ignored.
- Tests: e2e 412 "links in Excalidraw's dialogs open in the browser, the app stays", the shape link part
  of the inputs test (handed to `xdg-open`, editor still open); unit test for `isExternalLink`.

## D3. Esc in a field of the drawing editor closed the whole editor. FIXED

- Symptom: Esc while editing a link (Ctrl+K), a frame name or in the canvas search, or with the context
  menu open, closed the drawing editor instead of only that field.
- Root cause: the overlay's Esc handler only knew text/line editing, new elements, dialogs, menus,
  popups and tools as "busy"; `editingFrame`, `showHyperlinkPopup === "editor"`, `contextMenu` and
  focused form fields were missing.
- Fix: Esc aimed at an input/textarea/select is left to it, and the missing states count as busy.
- Tests: e2e 412 (Esc in the search and in the frame name keeps the editor open).

## Checked, no change needed (covered by e2e 412 or existing tests)

- Text tool on the canvas incl. umlauts, font search in the font picker, stroke color as hex,
  link dialog, canvas search (Ctrl+F is Excalidraw's, not the app's), frame names.
- App shortcuts inside the drawing (Ctrl+K, Ctrl+N) do not fire; the note behind is never edited.
- Undo/redo (Ctrl+Z, Ctrl+Shift+Z), copy/paste of shapes inside a drawing.
- Saving while drawing, preview in the note after closing, reopening keeps the scene (e2e 29, 412).
- Mermaid in notes: slash menu insert, live preview while typing, error with source and recovery,
  Markdown saved (e2e 412); seven diagram types, theme, SVG/PNG export, HTML share, print and
  presentation (e2e 124).

## Not changed

- Excalidraw's own texts that are not translated upstream (e.g. the Mermaid field's English
  placeholder) stay as Excalidraw ships them.
- Excalidraw has no contrast theme; in the app's contrast mode the drawing uses light or dark like the
  app's base theme.
