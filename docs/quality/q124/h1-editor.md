# q124 H1: editor core

Hunt over typing, undo/redo, lists, tables, links, the slash menu, paste, the source view and renames, against the
real app (e2e `470-editor-core.test.js`) and the editor schema (unit tests). Severity as in `plan.md`.

Result: 0 high, 3 medium (fixed), 7 low (listed).

## Medium

### H1-1 A list copied from Word or Outlook pastes as a table (medium, fixed)

- Symptom: a bulleted or numbered list copied from Word or Outlook became a two-column table with `·`, `o` or `1.`
  in the first column. Pasted without HTML (plain text) the same; with only the HTML it would have been paragraphs
  starting with `·&nbsp;&nbsp;…`.
- Root cause: Word writes list items as `•⇥Punkt` lines in the plain text, which the smart paste took as
  spreadsheet rows (`parseTsv`). Its HTML has no `<ul>`/`<ol>` either: the items are
  `<p style="mso-list:l0 level2 lfo1">` with the marker as text, which ProseMirror pastes as paragraphs.
- Fix: `paste.ts` recognizes rows whose first column is a list marker and does not take them as a table (plain text
  becomes a Markdown list, with HTML the HTML is pasted); `wordListsToHtml` turns Word's list paragraphs into nested
  `<ul>`/`<ol>` (levels, list ids, start numbers, marker removed) and runs as `transformPastedHTML` of the smart paste.
- Tests: `smartPaste.test.ts` (Word list with three levels and a numbered list, plain-text lists, a real two-column
  table stays a table); e2e `470-editor-core` „a list copied from Word pastes as a list with its levels“.

### H1-2 `- [ ] ` typed in Markdown gives a bullet with the text `[ ]`, saved as `- \[ ] …` (medium, fixed)

- Symptom: typing `- [ ] Milch` (or `[ ] ` as the next item of a bullet list) gave a bullet item whose text starts
  with `[ ]`; the file got `- \[ ] Milch`, so neither Arcalo nor Obsidian saw a task. Only `[ ] ` on an empty line
  worked.
- Root cause: TaskItem's input rule wraps the paragraph in a task list; inside a bullet item that wrapping is not
  allowed (a list item must start with a paragraph), so the rule did nothing.
- Fix: an input rule of the task list (`schema.ts`, `bulletToTaskRule`) turns the bullet item into a task item and
  splits the bullet list around it (bullets before and after stay bullets, nested items and callouts work).
  Backspace right after it gives the typed text back.
- Tests: `markdownTyping.test.ts`; e2e „`- [ ] ` typed in Markdown makes a task, also as the next item of a bullet
  list“.

### H1-3 `[[Seite]]` typed in full stays escaped text, not a link (medium, fixed)

- Symptom: typing `[[Architektur]]` without picking the page from the list saved `\[\[Architektur]]`: no link, no
  backlink, and literal brackets in Obsidian.
- Root cause: only the completion list inserted a wiki-link node; there was no rule for the closing `]]`, and the
  serializer escapes brackets in plain text.
- Fix: an input rule of the wiki link (`extensions.tsx`) turns `[[Ziel]]`, `[[Ziel#Abschnitt|Alias]]` and
  `[[#Abschnitt]]` into a link on the closing `]]`; not after `!` or `\`, not in code or a code span being typed.
- Tests: `markdownTyping.test.ts`; e2e „`[[Seite]]` typed in full is a link, not escaped text“.

## Low (listed, not fixed)

- H1-4: an edit of an ordered list that directly follows a bullet or task list (no blank line between them in the
  file) writes a blank line between the two lists. Same meaning in Markdown, but one more changed line in the file.
- H1-5: Backspace at the start of a heading joins it into the paragraph above (as ProseMirror does) instead of first
  turning it into text; undo brings it back.
- H1-6: the slash menu opens after ` /` in the middle of a sentence, so `ja /nein` or `de /en` followed by Enter
  inserts columns or a task list instead of a line break; Escape or a space avoids it.
- H1-7: an ordered task `1. [ ] a` (Obsidian reads it as a task) is shown as a numbered item with the text `[ ] a`
  and written `1. \[ ] a` once that list is edited.
- H1-8: a checkbox list pasted from a web page (`<input type=checkbox>`) becomes plain bullets.
- H1-9: `![[Seite]]` typed in full stays text; an embed comes only from the `![[` completion.
- H1-10: renaming a page also rewrites `[[links]]` inside a fenced code block that sits in a quote or callout
  (`> ````), because the fence detection of the rename does not look behind `>`.

## Checked without findings

Tab/Shift+Tab, Enter and Backspace at the edges of bullet, numbered and task lists; Tab through table cells with a
new row at the end, undo and redo (Ctrl+Shift+Z) of it; umlauts typed, undone and redone with Ctrl+Y; a note with
callout, nested tasks, table with an escaped alias pipe, footnote, highlight, code and tag to the source view and
back (the text there is the file, an edit afterwards changes one line); undo after a rename rewrote a link in the
open note (only the typing goes back, the new link stays); HTML from a browser and from Google Docs (no bold all
over, nested lists, links); Markdown round trips of 60 further constructs (all stable on a second pass).
