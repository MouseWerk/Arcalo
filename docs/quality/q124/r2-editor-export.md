# q124 round 2: editor core (H1) and import, export, sharing (H5)

Round 2 of H1 looked at angles round 1 did not (`h1-editor.md`): a Markdown round-trip property test over every block
type, nested in quotes, callouts and list items, with text in other scripts and tabs in code; copy and cut of mixed
content between notes; undo after the command line changed the open note. H5: an Obsidian vault with the hard parts,
its export, HTML sharing of every block type, a bookmarks HTML export and an `.eml`. Severity as in `plan.md`.

Result: 1 high, 5 medium (all fixed), 9 low (listed). Round 1's fixes hold (e2e `470-editor-core`, `smartPaste.test.ts`,
`markdownTyping.test.ts` pass).

Tests added: `ui/src/editor/roundtripProperty.test.ts` (property: parse, write, parse is lossless and stable for the
corpus, every block alone and 200 seeded random documents; plus „an edited list keeps its blocks“, the save path with
one edit), `ui/src/editor/shareEveryBlock.test.ts`, e2e `471-vault-edges`, `472-undo-external`,
`473-copy-between-notes`, `474-bookmark-html-edges`, `475-mail-eml-edges`.

All findings below concern a list (or quote) that is edited: an unedited block is saved as it was read, an edited one is
written from the editor's document.

## High

### R2A-1 Code under a numbered item gains a space per save, bullets under it nest deeper (high, fixed)

- Symptom: in `1. Klonen:` followed by a fence indented three spaces, every code line got one more leading space each
  time the list was edited and saved. `1. Süd` with two bullets indented four spaces under it (`    - a`, `    - b`):
  the second bullet became a child of the first, one level deeper per save. Both were already wrong in the editor after
  opening the note.
- Root cause: numbered lists went through Tiptap's own tokenizer (`@tiptap/extension-list`, `collectOrderedListItems`),
  which cuts an item's continuation lines by the width of the number without its `.`/`)` and then trims the first of
  them, so nested lines kept one column too many and the first nested line lost its indentation. Its reading of
  marked's item tokens also kept their text unparsed.
- Fix: `SourceOrderedList` (`schema.ts`) leaves numbered lists to marked (CommonMark) and keeps Tiptap's tokenizer only
  for lists marked does not know (letters, roman numerals); its items are parsed through ListItem as bullet items are.
- Tests: `roundtripProperty.test.ts` „code under a numbered item keeps its indentation“, „bullets indented four spaces
  under a numbered item stay siblings“, and the corpus file `github-contributing.md` in the property test.

## Medium

### R2A-2 A quote, callout or table first in a list item leaves the item; a rule under an item's text underlines it (medium, fixed)

- Symptom: `- > Zitat` with a second quote line, `- > [!note]` and `- | A | B |` tables were written with their further
  lines unindented: the quote ended the list, the table broke (`- ` alone, then the rows outside). `- a` with a rule
  `---` below it was written without the blank line, which makes `a` a heading; a numbered list under a quote in an item
  became part of the quote; two task lists in one item became one.
- Root cause: `renderListItem` (`sourceStyle.ts`) indented the lines of the first block only for a paragraph, and
  joined later blocks with a single line break except paragraphs. Tiptap's table renderer also starts with a blank line.
- Fix: the first block's further lines are indented like the nested blocks; a block after another one gets a blank line
  unless it is a list, code or a quote right under the item's text; the table renderer has no blank lines around it.
- Tests: `roundtripProperty.test.ts` „a quote, callout or table first in an item stays in the item“, „a rule under an
  item's text …“; the property test.

### R2A-3 A task's second line becomes a paragraph of its own (medium, fixed)

- Symptom: `- [ ] Zeile  ` with `  Umbruch` below it (a hard break, or any wrapped line) was read as two paragraphs in
  the task; once the list was edited a blank line was written between them, so in Obsidian the second line left the
  task's text.
- Root cause: `tokenizeTaskList` took only the marker line as the task's text and lexed every following line as nested
  blocks.
- Fix: lines right below the task that start no block (also unindented, lazy continuation) continue its text.
- Test: `roundtripProperty.test.ts` „a task's second line continues its text“.

### R2A-4 Tabs in code inside a list become spaces (medium, fixed)

- Symptom: Go code or a Makefile in a list item, or a list indented with tabs as Obsidian writes it, lost its tabs (four
  spaces each, plus one level of indentation) once the list was edited.
- Root cause: marked replaces every tab that indents a line inside a list item with four spaces before it cuts the item's
  indentation.
- Fix: `keepListTabs` (`schema.ts`) reads such items again with the indentation cut in columns (`listItemText`, CommonMark's
  rule: a tab inside the content stays); `itemStyle` no longer takes the indentation of fenced or indented code for the
  item's own.
- Test: `roundtripProperty.test.ts` „tabs in code inside a list stay tabs“, „indented code under a numbered item stays
  code“.

### R2A-5 Text after a block in a list item is escaped, more on every save; blank lines in its code collapse (medium, fixed)

- Symptom: `- ```sh … ```` followed by `  **fett** [[Seite]]` showed the Markdown as text and saved it as
  `\*\*fett\*\*`, with more backslashes each save. Two blank lines inside fenced code in a list item became one.
- Root cause: marked gives text after a block in a tight item as a `text` token, which Tiptap's list item takes as plain
  text unless it comes first; `collapseBlankLines` did not see a fence that follows a list marker (`- ```py`).
- Fix: such items get paragraph tokens (`keepListTabs`); the fence detection of `collapseBlankLines` looks behind list
  markers and `>`.
- Tests: `roundtripProperty.test.ts` „text after code in an item keeps its formatting“, „blank lines in code inside a
  list stay“.

### R2A-6 A table in a quote or callout gets bare `>` lines, more on every save (medium, fixed)

- Symptom: a quote holding a table was written with an empty `>` line before and after the table; with two tables the
  number of `>` lines grew on every save (visible as growing gaps in Obsidian).
- Root cause: Tiptap's table renderer returns the table with a blank line before and after it, which the quote prefixed.
- Fix: the table renderer (`renderTable`) returns the table alone; the blocks around it add their own spacing.
- Test: `roundtripProperty.test.ts` „a table in a quote gets no bare `>` lines“.

## Low (listed, not fixed)

- R2A-7: a numbered list as the first thing in a bullet item (`- 1. a`) is read as the text `1. a` (Tiptap's
  `isSameLineOrderedListToken`) and written `- 1\. a` once edited.
- R2A-8: a list with letters or roman numerals (`a. x`) is written with numbers (`1. x`) once edited.
- R2A-9: a tab in the text of a list item or a table cell is written as spaces once edited (not in code).
- R2A-10: `[TOC]` inside a list item swallows the block after it as plain text.
- R2A-11: a line break inside a paragraph (and between a callout's title and its first line) copied to another note,
  or cut and pasted back, comes back as a hard break (`  ` at the line's end): ProseMirror turns the newline of the
  copied HTML into a hard break. Same look in Arcalo and Obsidian, two more characters in the file.
- R2A-12: a mixed bullet/task list whose task has an unindented second line after a hard break writes a blank line
  between them once edited (the same as R2A-3 for tasks that marked reads inside a bullet list).
- R2A-13: an `.eml`'s text is quoted as it is, so its Markdown is read as such inside the quote (`# x` a heading,
  `- [ ] x` a checkbox, not a task of the task list, `[[x]]` a link).
- R2A-14: a template's frontmatter is dropped when a page is created from it (documented in `templates.rs`); Obsidian
  templates that set `tags:` for the new page lose them. Obsidian's `{{date:YYYY-MM-DD}}` stays as written.
- R2A-15: files and folders dropped onto the page tree are not imported (dropping on a pane stores them as attachments,
  PDFs open); not offered, not a defect.

## Checked without findings

The Obsidian vault (frontmatter with `aliases:` and list `tags:`, nested tags in text, embeds of files with spaces and
umlauts, Markdown images with `%20` paths, two notes and two different `Bild.png` of the same name in different
folders, CRLF with a BOM, Japanese folder and note names) imports with every page and file, shows its images and the
PDF, and exports the same notes and files again. Undo after the command line appended text or ticked a task off in the
open note takes back only the typing (also redo). Lists with tasks, a table with an escaped pipe in code, Go code with
tabs, callouts, quotes and text in other scripts copied or cut between notes arrive as the same Markdown. HTML sharing
of every block type shows each block as itself without Markdown syntax, keeps RTL, combining marks, CJK and tabs in
code. A bookmarks HTML export with entities, mixed-case tags, unclosed `<DT>`, empty folders and a `javascript:` link
reads correctly. An `.eml` with an encoded subject containing `[`, `]`, `#` and `|` and an RFC 2231 attachment name
with umlauts gives a task line with a clean link, a quoted note and the attachment under its name. Heading anchors are
compared NFC-normalized.
