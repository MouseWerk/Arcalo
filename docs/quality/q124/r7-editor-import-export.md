# q124 round 7, hunt A: editor core with import, export and sharing

The editor (H1) and import, export and sharing (H5) gone through for what rounds 1 to 6 did not try (their findings in
`h1-editor.md`, `r2-editor-export.md`, `r5-features.md`, `r5-undo.md` and `r6-editor-import-export.md` were not
hunted again): about 170 constructs edited inside, by command and by typing into the page, and written from the
document alone (nested lists and tasks with marks, tables with marks, links, embeds and escaped pipes, callouts with
lists, block ids, footnotes, lists with letters and roman numerals, indented and tab-indented lines); the neighbours
of round 6's fixes (`flankedSpan`/`escapeSpans` in lists, tables, quotes, headings and code; abbreviations and letter
lists after text, in quotes and nested; line ends in list items, quotes, callouts and after hard breaks); every slash
command in a list item, a numbered item, a task, a table cell, a quote, a callout, a heading and a nested list; paste
of web, Google Docs, Confluence and Word HTML (nested lists with marks, tables with lists and headings in cells, code
blocks, images) and of Markdown as text, each undone again; an Obsidian vault with the link format „absolute“ and
„relative“ path; the Markdown export and the HTML share of pages with page embeds, images, drawings, files, footnotes
and section links. Branch `q124-r7a`. Severity as in the [plan](plan.md); text shown or saved changed counts as high.

Found: 1 high, 5 medium, 19 low.

## Findings

### R7A-1 A list with letters or roman numerals was written with numbers once edited (high)

- Symptom: `a. Angebot` / `b. Termin` (and `i.`/`ii.`/`iii.`, `A)`/`B)`, `I.`/`II.`) was shown as a list with its
  letters, but typing anywhere in it saved `1. Angebot` / `2. Termin`: the text of the file changed, and Obsidian,
  which reads such lines as text, then showed the numbers. Round 6 (R6A-2) kept these lists as lists; its test
  expected the numbers.
- Root cause: the list keeps its marker type (`type: "a"`) from reading, but `listMarker` (`sourceStyle.ts`) wrote
  every numbered item with its number.
- Fix: `listMarker` writes the item's letter or roman numeral for a list with a type (Tiptap's `getListMarker`), with
  the list's `.` or `)`. The test of round 6 now expects the letters. A list with letters also ends where its
  markers stop counting on (`letterListEnd`, `schema.ts`): Tiptap's tokenizer read `a.`/`b.` and an `i.`/`ii.` list
  after a blank line as one list, and an edit wrote `i.` as `c.` (found by the e2e test).
- Tests: `realWorldMarkdown.test.ts` („lists with letters or roman numerals keep their markers“), e2e
  `684-editor-import-export-r7` (first test).

### R7A-2 An indented line inside a paragraph got `&#32;` once the paragraph was edited (medium)

- Symptom: a paragraph with indented lines (`Adresse:` / `    Musterstraße 1`, poems, wrapped lines, text pasted from
  mails) was saved as `&#32;   Musterstraße 1` after one typed character. The look stays, but Obsidian's source mode,
  Git diffs and every other editor show the entity in the text.
- Root cause: `escapeLineStart` (`schema.ts`) wrote the first blank of every line with four columns of indentation as
  its entity, since such a line would start indented code. A line that continues a paragraph (after a line end or a
  line break) cannot start code, and the editor reads its blanks back as they are.
- Fix: the entity only for the paragraph's first line (`continued` lines and lines after a hard break stay as typed).
- Tests: `realWorldMarkdown.test.ts` („indented lines inside a paragraph keep their blanks“), e2e 684.

### R7A-3 An Obsidian vault's path links opened a new empty page instead of the imported note (medium)

- Symptom: with Obsidian's link format „absolute path“ or „relative path“ (and for any name two notes share) the notes
  link `[[Projekte/Alpha/Plan]]` and `[[../Alpha/Plan|Plan]]`. After the import these links were unresolved: no
  backlink on „Plan“, and following one created a new empty top-level page „Projekte/Alpha/Plan“.
- Root cause: links resolve by page title; the import renamed attachments by path (R6A-6) but left the path links to
  notes as they were.
- Fix: the import names the page in a path link to a note of the vault (relative to the vault or to the note, with or
  without `.md`): `[[Plan|Projekte/Alpha/Plan]]`, so the link shows what it showed (`NotePaths`,
  `retarget_wiki_links` in `vault.rs`). A name two notes share keeps its path (the title would name the first, see
  R7A-L15); file embeds and code stay as they are.
- Tests: `vault::tests::path_links_to_notes_name_the_page`, e2e 684.

### R7A-4 The Markdown export's links to titles with `:`, `/`, `?` led nowhere (medium)

- Symptom: a page „Meeting: Kunde X“ is exported as `Meeting- Kunde X.md` (Windows allows no `:`), but the links to
  it stayed `[[Meeting: Kunde X]]`. In Obsidian (and in Arcalo after importing the folder) every such link was
  unresolved, and following it created a new note. German titles with a colon („Meeting: …“, „Projekt: …“) are
  common.
- Root cause: the export wrote each note as it is; only canvas files had their note paths mapped (`with_paths`).
- Fix: in the export (not in the Markdown mirror, whose files must equal the pages), a link to a title whose file has
  another name names the file and keeps the title as its alias: `[[Meeting- Kunde X|Meeting: Kunde X]]`, `\|` in a
  table row; page embeds and section links name the file only.
- Tests: `vault::tests::export_links_name_the_files_of_titles_a_file_name_cannot_hold`, e2e 684.

### R7A-5 A pasted web table glued the list items and headings of a cell together (medium)

- Symptom: a table copied from Confluence, Jira or a web page with a bullet list in a cell (`Server`, `Clients`)
  pasted as `ServerClients`; a heading and the text under it (`Rollout`, `Phase 2`) as `RolloutPhase 2`.
- Root cause: `parseHtmlTable` (`paste.ts`) kept the lines of a cell apart only when it had a `<p>`, `<div>` or
  `<br>`; lists and headings fell back to the cell's bare text.
- Fix: lists, list items, headings, quotes and preformatted blocks start lines of their own too (`CELL_BLOCKS`).
- Tests: `paste.test.ts` („keeps the lines of a cell's lists and headings apart“), e2e 684.

### R7A-6 `/Hinweisbox` and `/Warnbox` wrote `[!note]` into a list item's line (medium)

- Symptom: in a list or task item, `/Hinweisbox` left `zwei[!note] ` in the item's line and no callout, `/Zitat` did
  nothing. In a paragraph with text before the caret the marker went after the text (`> eins zwei[!note] `), in a
  heading into the heading, and in a quote the quote was removed and `[!note]` stayed as text: no callout either way.
- Root cause: the commands chained `toggleBlockquote()` and `insertContent("[!note] ")` at the caret; the line of a list
  item starts the item and cannot be wrapped in a quote, the toggle failed, and Tiptap's chain still applied the
  insert. In a quote the toggle lifted it.
- Fix: `insertQuote` (`extensions.tsx`): where the line cannot be quoted the quote goes below it in the item; the
  marker goes at the start of the quote (before a heading as a line of its own); in a quote the callout commands add
  the marker, in a callout they change nothing.
- Tests: `slash.test.ts` („quote and callout commands in a list item“), e2e 684.

### Low (listed, not fixed in this round)

- R7A-L1: `**Hinweis:**text` (no bold in CommonMark: the closing `**` follows punctuation and precedes a letter) is
  written `\*\*Hinweis:\*\*text` once edited; same look.
- R7A-L2: a quote's blank line written `> ` (with a blank) is written `>` once edited.
- R7A-L3: `~~**s**~~` is written `**~~s~~**` once edited; same look.
- R7A-L4: an empty list item `-` is written `- ` once the list is edited.
- R7A-L5: an HTML comment on a line of its own inside a paragraph gets blank lines around it once edited; same look.
- R7A-L6: several blank lines between list items become one, and a list with one blank line between only some items
  (`1. a` / blank / `2. b` / `3. c`) gets one between all once edited.
- R7A-L7: `# x`, `- x` and `1. x` in a table cell are written `\# x`, `\- x`, `1\. x` once the table is edited (same
  look), and the table's rows are padded (`| - |` becomes `| --- |`), as R6A-L5.
- R7A-L8: inline code over a line end (`` `code ``/`` über` ``) is written on one line once edited; same look.
- R7A-L9: the blank line between a numbered item's text and a quote under it is dropped once edited; same look.
- R7A-L10: pasted HTML lists with checkboxes (`<input type="checkbox">`) become plain bullets, `<sub>`/`<sup>` lose their
  formatting (H₂O becomes H2O).
- R7A-L11: a list with letters of one item (after deleting the second, or pasted) is written `a. x` and read back as
  text, as Obsidian reads it.
- R7A-L12: a Word list with lettered sub-items (`a.`, `b.`) pastes with numbers.
- R7A-L13: HTML share: a local image that is not among the attachments shows `[Bild: …]` in English too; two page
  embeds in one line put a `<section>` into a `<p>` (browsers show it the same).
- R7A-L14: an Obsidian vault written with Markdown links (setting „Use [[Wikilinks]]“ off,
  `[Plan](Projekte/Plan.md)`): the links to notes are not followed after the import (they stay file links).
- R7A-L15: a path link to a name two notes share keeps its path and stays unresolved (two notes of one name: h2 L6).
- R7A-L16: Logseq namespaces (`Projekt___Unterseite.md`, `%2F`) and Notion's export ids (`Seite 1a2b….md`) stay in the
  titles, and Notion's Markdown links between pages are not followed; neither is offered as an import.
- R7A-L17: `/Zitat` and `/Hinweisbox` in a table cell write `> ` into the cell (a cell holds no quote).
- R7A-L18: plain text detected as Markdown turns a mail signature line `--` under „Viele Grüße“ into a heading (the
  paste hint „Als Text einfügen“ undoes it).
- R7A-L19: rows copied from Excel into an existing table's cell go into that one cell, joined with `<br>`.

## Looked at, no finding

- Round 6's fixes: `==` and `++` in list items, table cells, quotes, headings, bold, links and inline code, `==>`,
  `<==>`, `a==b==c`, `+++`; abbreviations in lists, quotes, after text and in tables; letter lists after text and
  nested in numbered items; line ends in list items, quotes, callouts and after hard breaks, typed into the page.
- Round trips of: nested bullet, numbered and task lists with bold, italic, code, strike, highlight, links, wiki links
  and tags; tasks with Obsidian Tasks dates and `@`/`#`; tables with marks, escaped pipes in code, wiki links and
  embeds, `<br>` and footnotes; tables, code and quotes in list items; callouts with lists and folded callouts; block
  ids on paragraphs, items and tables; inline footnotes; `$`-amounts and inline math; snake_case, `__init__.py`,
  Windows paths and UNC paths; setext headings, rules after text, escaped block markers (`1\.`, `\#`, `\-`, `\>`);
  a list numbered past 9.
- Long notes: the chunked lexing cuts only where nothing continues and lexes with one lexer (reference definitions
  after their use work).
- Paste: nested HTML lists with marks and links, Google Docs bold and italic spans, code blocks, headings, rules,
  images (web: link; inline data: dropped as before), Markdown as text (lists, fences, tables, callouts, wiki links),
  each undone to the note before.
- Slash commands: every block command in every context above gives Markdown that reads back the same.
- HTML share: page embeds with sections, images, files and footnotes (ids per embed), embed cycles, images in tasks,
  drawings, web and local links.
- Rename following and backlinks with `\|` aliases in tables and decomposed umlauts (already covered).

## Tests added

- UI: `realWorldMarkdown.test.ts` (R7A-1, R7A-2), `paste.test.ts` (R7A-5), `slash.test.ts` (R7A-6).
- Rust: `vault::tests::path_links_to_notes_name_the_page`,
  `vault::tests::export_links_name_the_files_of_titles_a_file_name_cannot_hold`.
- e2e: `684-editor-import-export-r7.test.js`.
