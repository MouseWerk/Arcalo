# q123: working with images in notes

Owner, 2026-10-29: „wie man mit Bildern arbeiten kann ist irgendwie schlecht, richtig wieder kopieren und
irgendwo anders einfügen geht nicht“. Branch `q123-images`. Every finding was reproduced in the real app with
the real keys (WebDriver Ctrl+C/Ctrl+V on the X clipboard, `e2e/tests/430-images-copy-paste.test.js`), the
clipboard's formats read back by a real paste into a scratch text field.

## Findings

### I1 Copied image comes back without its size, with the file name as caption

- Symptom: select an image (`![[x.png|480]]`), Ctrl+C, Ctrl+V in another note (or the same, a cell, a callout,
  a drop from the other split pane): the paste is `![[x.png|x.png]]`, shown at its original size with the
  name as caption. Drawings came back as `![x](…excalidraw.svg)`, an image of the preview.
- Root cause: Tiptap reads every node attribute from the element's attribute of the same name unless the
  attribute has its own `parseHTML`, and that value overrides the rule's `getAttrs`. The embed's `<img>`
  carries `alt` (the name, or the caption) besides `data-alt`, so `alt` won. The drawing's rule lost against
  the Markdown image's `img[src]`, which comes earlier in the schema.
- Fix: `embedAttrs` (`ui/src/editor/fileEmbed.ts`): name and alt are read from `data-embed`/`data-drawing`
  and `data-alt` only; both rules get priority 60.
- Tests: `imageClipboard.test.ts` (copy → paste round trip of embeds with size, size×height, caption,
  drawings, Markdown images, web images); e2e 430 tests 1 and 2 (other note, table cell: same file, no new
  file in `attachments/`).

### I2 A copied Markdown image pastes as the app's own address

- Symptom: `![Plan](attachments/c3d4.png)` copied and pasted became `![Plan](arcalo-asset://localhost/c3d4.png)`
  (Windows: `http://arcalo-asset.localhost/…`), which breaks in Obsidian, the Markdown mirror and on the other
  system after a Git sync. Copied as plain text it was missing entirely.
- Root cause: the rendered `src` is the resolved address and was parsed back as is; the image node had no
  `renderText`.
- Fix: `MarkdownImage` writes the original path as `data-src` and reads it back first; `renderText` writes the
  Markdown. The HTML export strips `data-src`.
- Tests: `imageClipboard.test.ts`, `shareHtml.test.ts`.

### I3 Other programs got nothing they could show

- Symptom: an image or a text with images copied into a mail, Word, a browser or a chat: broken image, the
  clipboard's HTML pointed at `arcalo-asset:`, which only the app can load.
- Root cause: the clipboard HTML is the editor's own rendering.
- Fix (`ui/src/editor/imageClipboard.ts`): a copy serializer (`clipboardSerializer`) puts the stored images'
  bytes as `data:` addresses into the copied HTML (also for drags). A copy must be written while the key is
  handled, so the bytes are read when images get selected (`readForCopy`, cached up to 64 MB, images over
  10 MB keep their address). A single selected image is additionally offered as PNG through the web
  clipboard (`copyFormats`, HTML + text + image in one item); where the web clipboard refuses (WebKitGTK for
  WebDriver's keys), ProseMirror's copy stays. A paste in a note still takes the image by its name
  (`data-embed`, `data-src`), so no file is stored twice.
- Tests: `imageClipboard.test.ts`; e2e 430 tests 1 and 4 (clipboard HTML carries `data:image/png`, text is
  `![[name|480]]`).

### I4 The clipboard's image won over its content

- Symptom: pasting a copy from a note that also carries the image (I3), or Excel/Word/Outlook content (their
  clipboard holds a picture of the selection besides HTML and text): the picture was stored as a new
  attachment and the table or text was lost. The capture window did the same.
- Root cause: every paste handler (`AttachmentDrop`, smart paste, the large-paste check, the capture window)
  took `clipboardData.files` first.
- Fix: `filesToStore` (`ui/src/lib/pasted.ts`): files count only when there is no HTML that is the content
  (copied in a note, or with text or a table); a browser's „Bild kopieren“ (HTML with only an `<img>`), a
  screenshot and files from the file manager are stored as before. Used for paste and drop.
- Tests: `pasted.test.ts`, `imageClipboard.test.ts` (Excel table with its picture becomes a table; a drop from
  the other pane is not stored again); e2e 430 test 3 (capture window gets `![[name|480]]`, no new file).

### I5 Images in pasted HTML as `data:` addresses were dropped

- Symptom: HTML from a web page or mail with inline images (`<img src="data:image/png;base64,…">`): the images
  disappeared without a word.
- Root cause: Tiptap's image rule skips `data:` sources (`allowBase64` off, rightly: they would land in the
  Markdown).
- Fix: `pasteDataImages`: such images are stored as attachments first and the HTML is then pasted with them as
  embeds (not in code blocks, not with Ctrl+Shift+V).
- Test: `imageClipboard.test.ts`.

### I6 „Bild kopieren“ in the image menu

- Symptom: copied PNG only; pasted in a note it became a new file without its size. SVG could not be copied
  (`createImageBitmap` cannot decode SVG).
- Fix: the menu copies like Ctrl+C (I3: image, HTML and text in one item); when the web clipboard refuses, the
  app copies the image as before. `toPng` draws non-PNG images from a `data:` address (CSP allows no `blob:`
  images).
- Test: e2e 430 test 5.

### I7 Image embeds in link previews, dashboards and canvas cards showed as „!name.png“

- Symptom: the hover preview of a note with an image showed a link `!90afd339d079f1a1.png` (in a table cell
  a link „480“).
- Root cause: `renderMarkdown` turned every `[[…]]` into a link and left the `!`; the escaped `\|` of a table
  cell was not understood.
- Fix: image embeds become `<img>` with their width (address added after sanitizing; the sanitizer allows no
  app addresses), other embeds links; `\|` accepted.
- Tests: `chatmarkdown.test.ts`; e2e 430 test 7 (screenshot `430-hover-preview`).

### I8 HTML export lost Markdown images of the attachments folder

- Symptom: „Als HTML-Datei teilen“ of `![Plan](attachments/bild.png)` (Obsidian's standard link format) showed
  „[Bild fehlt: bild.png]“.
- Root cause: the export's resolver kept the folder in the name, the app's resolves by file name.
- Fix: same rule as `attachmentUrl`. Test: `shareHtml.test.ts`.

## Checked, no fault found

Cut and paste (moves the embed), Delete/Backspace on a selected image and Ctrl+Z, size menu and its undo
(e2e 430 tests 4, 6), pasted image after the first note is deleted and the app reloaded (test 8; attachments
are only removed in „Anhänge“), Markdown mirror and vault export (they copy every referenced file by name),
pasted screenshots and files (e2e 10, 70).

## Not done here

- Resize handles, alignment, a caption field, „Speichern unter…“ and „Ersetzen…“ do not exist; sizes are set
  in the menu, captions as `![[x.png|Text]]`. New features, for the owner to decide.
- HEIC/HEIF and AVIF are stored as file chips, not shown as images (WebView support differs per system).
- Windows (manual): Ctrl+C on a selected image, paste into Word, Outlook and Teams (expected: the image);
  copy text with an image, paste into Outlook (expected: text and image); Excel cells pasted into a note
  (expected: a table, not a picture).
