# q123 round 2: the desktop app watched again

Owner, after round 1 (images, presentation, drawings, Jira, sweep; all merged on `main` 17c38bc1): „a full UI
watch and fix run“. Branch `q123-ui2`. This round photographs what the first tour (`412-sweep-tour`) left out,
looks at every screenshot one by one and fixes what is wrong at the root.

## Machinery

`e2e/tests/440-sweep-tour-more.test.js`, on the machinery of `e2e/lib/tour.js` (photograph a stop, run the layout
audit, in English also the German-word check; a stop that cannot be reached or that Esc does not close is a
finding; every finding is asserted at the end). Stops:

- Presentation: every slide type (title, lists with a numbered list, an image alone, two images side by side,
  long code, a table with a right-aligned column, Mermaid, callout with quote and tasks, a drawing, the end),
  the controls, Beamer (title, table, diagram), the presenter overlay with and without notes, the right-click.
- Images in a note: natural size, 240/480/720, a caption, side by side, in a table cell, a drawing and a PDF
  card; the image menu and its size submenu, the full screen viewer, the menu of an image in a table cell; the
  drawing embed on hover, the Excalidraw editor, its tools menu and Mermaid dialog; the PDF card, its menu, the
  viewer and its search; the hover preview of a linked note with images.
- Jira against `e2e/lib/fake-jira.js`: the Issues list (plain, row hover, row menu), the issue view (with Tab
  through it), a chip's hover card, a task's menu and the create dialog, Settings → Jira with a site.
- Context menus: the daily note button of the ribbon (calendar), a start page tab, a task, an attachment, a
  board card, the canvas.
- The graph with its settings panel, a search and as a list.
- The voice bar (recording, paused, done; a WAV file stands in for the microphone, `e2e/lib/voice.js`), the
  update toast and its release notes (a local feed, `e2e/lib/update-feed.js`), the intro and every setup step,
  the capture window (its own window).

| Combination | Language | Theme | Size | Stops |
|---|---|---|---|---|
| de-light-1480 | de | Arcalo Hell | 1480x920 | all |
| de-dark-900 | de | Arcalo Dunkel | 900x700 | all |
| de-hcdark-1920 | de | Hoher Kontrast Dunkel | 1920x1080 | all but voice, update, intro, capture |
| en-hclight-1480 | en | High Contrast Light | 1480x920 | all |
| en-dark-900 | en | Arcalo Dark | 900x700 | all but voice, update, intro, capture |
| en-light-1920 | en | Arcalo Light | 1920x1080 | all |

## Findings

| # | Symptom | Root cause | Fix | Test |
|---|---|---|---|---|
| R1 | Slides: the „1.“ of a numbered list stood left of the slide's title (the text column). | `.slide-content ul, ol { padding-left: 1.3em }` is less than an outside marker „1.“ plus its gap. | Lists on slides get 1.6em (tasks and the table of contents follow). | 440 (list padding on every slide) |
| R2 | A column right-aligned in the Markdown (`---:`) was left-aligned on slides, in link previews, the start page and chat answers; the editor showed it right. | marked writes `align="right"`, a presentational hint that loses to `.prose th, .prose td { text-align: left }`. | `.prose :is(th, td)[align=right/center]` rules. | `styles.test.ts`; 440 (slide 6) |
| R3 | A drawing (or any image without a width) on a slide stayed at its pixel size: a 240 px sketch was a sixth of the slide, a third of the note. | `SlideView.fit` enlarged only images with a width (`![[x\|480]]`) by the slide factor 1.6. | Every image is enlarged from its natural width by the same factor, capped by the slide as before. | 440 (slide 9 drawing > 350 design px); 420 unchanged |
| R4 | Presenter view in a window up to 1100 px: the current slide ran under the next slide's preview, the „Aktuelle Folie“ and „Nächste Folie“ labels were gone. | In the one-column layout the grid rows shrank to the window: both columns have `min-height: 0`, and the labels (`overflow: hidden` in a flex column) shrank to 0 px. | One column: rows as high as their content (`grid-auto-rows: max-content`, `min-height: auto`), the view scrolls; labels `flex: none`. | 440 (no overlap, labels at least 10 px, 900 px runs) |
| R5 | Presenter labels: „2 / 10  · Ziele“ but „Nächste Folie ·  Folie 3“, the dot with a different gap on each side. | Literal spaces in text nodes plus the flex `gap`. | The dot is its own element; only the gap spaces the parts. | 440 (gaps equal) |
| R6 | Presenter, slide without notes: the hint's „> [!notiz]“ broke after the „>“. | Inline code wraps like text. | The hint's code pieces do not wrap. | 440 |
| R7 | Hover preview of a note with images (also start page and canvas cards): images on separate lines in the note stood in one row in the preview. | `renderMarkdown` turned `![[bild.png]]` into raw `<img>`; a line starting with a tag is an HTML block, not a paragraph, so the next image ran into its line. | Image embeds go through Markdown as images with a placeholder address and get the stored image after sanitizing; paragraphs stay paragraphs, two on one line stay side by side. | `chatmarkdown.test.ts`; 440 (hover preview) |
| R8 | Issues list: the summaries of „OPS · Operations“ started 7 px left of those of „PROJ · Portal“. | Each group is a grid of its own; the key column was `min-width: 7ch`, „PROJ-123“ has 8. | The key column gets the longest shown key's width in every group (`--issue-key-w`). | 440 (one left edge for all summaries) |
| R9 | „Jira-Issue anlegen“: the „Titel“ label sat 3 px under the row of „Projekt“ and „Typ“. | The dialog spacing rule was `.field + .field`; a row of two fields is no `.field`. | A shared `.field-row` (two fields side by side) counts as a field for the spacing. | 440 (gap at least 10 px) |
| R10 | The update toast and the voice bar covered each other (900–1480 px). | Both are fixed at the bottom, the toasts on the right, the bar in the middle, without knowing of each other. | The bar publishes its height (`--voice-bar-h`); while it is shown the toasts stand above it. | 440 (toast above the bar) |
| R11 | Update toast: the „…“ button (remind tomorrow, next week, skip) was named „Später“, like the close button next to it. | Its label was `upd.later`. | „Weitere Optionen“, as on the same menu in the status bar. | 440 (button names unique) |
| R12 | Release notes dialog: the notes' „Neu“ (22 px) was larger than the dialog's title (15 px). | The notes are `.prose`, whose `h2` is the editor's heading size. | Headings inside `.update-notes` are section headings (base size, semibold). | `styles.test.ts`; 440 (heading smaller than title) |
| R13 | A toast covered the end of the Issues list's row menu and of the canvas menu. | `--z-menu` (70) was below `--z-toast` (80); selects (90) were already above. | Menus at 85: above toasts, below selects. | `styles.test.ts`; 440 checks that nothing covers an open menu or dialog |
| R14 | Settings → Jira (English): the JQL example in the empty field read „project = PROJ AND sprint in oper“. | The field's basis was 220 px; the English „Add“ button fit beside it and squeezed it. | Basis 320 px: the button wraps first. | 440 placeholder audit |
| R15 | PDF viewer at 900 px (English): the search field read „Search in the Pl“. | Below 1000 px the field was 90 px, enough for „Im PDF suchen“ only. | 112 px (also in a narrow PDF tab). | 440 placeholder audit |
| R16 | Issues list at 900 px: the search field read „Schlüssel, Titel, Bearbeiter suchen“ without its end. | The German text is 227 px, the field 216 px next to the three filters. | „Schlüssel, Titel oder Bearbeiter“ (the magnifier says „suchen“). | 440 placeholder audit |
| R17 | Anhänge, a drawing's menu: „Bearbeiten“ (in Arcalo) and „Mit Standard-App öffnen“ (another program) had the same external-link icon; a PDF's „Ansehen“ too. | One icon for the first item whatever it does. | „Ansehen“ the eye (as in a note's file menu), „Bearbeiten“ the pen; „Öffnen“ in another program keeps the external-link icon. | 440 (the first two items differ) |

The tour also checks on every stop: what is on top is not covered by something else (R13), no empty field's
placeholder is cut (R14, R15), Esc closes what a stop opened, and Tab stays inside the issue view, the create
dialog and the release notes.

## Looked at, not changed

- PDF search: with a PDF whose standard font is not embedded and has no width table (the e2e fixture), pdf.js
  measures the text item about 2.9 times too wide, so the hit is drawn right of the word. A real PDF (written
  by LibreOffice) highlights exactly; this is pdf.js' text layer, not the viewer.
- Right-click on plain text or a link in a note shows the system menu; the app has menus for images, files,
  PDFs and tasks only. A right-click in a presentation goes back a slide (tested). Of the ribbon only „Heutige
  Tagesnotiz“ has a right-click (the calendar).
- `![[bild.png|Text]]` is the image's alt text, not a visible caption (as in Obsidian).
- The audio player of a voice note is WebKitGTK's own control (grey bar); Windows shows WebView2's.
- A ribbon button clicked and then followed by Esc shows its focus ring: the engine's `:focus-visible` rule
  after keyboard use. The contrast themes draw a neutral ring for selected rows on purpose.
- A toast stays above the full-window intro and can cover its scene bar; it does not happen in normal use
  (the tour closes the toasts first).
- A slide without a heading is called „Folie n“, so the presenter label reads „3 / 10 · Folie 3“.
- Excalidraw's own dialogs (Mermaid, help, the library) look as upstream ships them.

## Runs

| Run | Result |
|---|---|
| local, 440 on `main` and while fixing (four runs) | R1 to R17; a few stops first aimed at menus that do not exist (see „Looked at, not changed“) |
| local, 440 with the fixes | 7/7 tests, no findings; 420, 43, 32 and 412-jira-ui-consistency green |
