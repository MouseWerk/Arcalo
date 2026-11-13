# q124 round 6, hunt A: editor core with import, export and sharing

The editor (H1) and import, export and sharing (H5) gone through with real-world material, looking for what rounds 1
to 5 did not test (their findings in `h1-editor.md`, `r2-editor-export.md`, `r5-features.md` and `r5-undo.md` were
not hunted again): about 80 constructs as Obsidian, Logseq, Typora, VS Code and GitHub write them, each opened and saved
unchanged, written from the document alone and edited in one place; everyday prose that looks like syntax (`C++`,
`a == b`, „ca. 5 Minuten“); paste from Excel, Word, Outlook and web pages; an Obsidian vault with two files of one
name and the path embeds Obsidian writes for them; the HTML share with scripts, event handlers and `javascript:` links
in notes. Branch `q124-r6a`. Severity as in the [plan](plan.md); text shown or saved changed counts as high.

Page exports are the HTML share, the print dialog („Als PDF speichern“) and the Markdown folder; there is no DOCX
export.

## Findings

### R6A-1 `C++` and `a == b` were read as underline and highlight, and an edit dropped the blanks next to them (high)

- Symptom: „C++ und C++ sind Sprachen“ showed as „C“ and an underlined „und C“; „Wenn a == b und c == d gilt“ as a
  highlighted „b und c“. Typing anywhere in the paragraph saved `C++und C++` and `a ==b und c== d`: the text was
  changed in the file. Every note with C++, `i++`, `==` comparisons or `++` in prose was affected.
- Root cause: Tiptap's tokenizers for `==highlight==` and `++underline++` took any two delimiters and trimmed the text
  between them; Markdown's flanking rules (no blank after the opening, none before the closing delimiter) were not
  applied. The serializer escaped every `==`.
- Fix: `flankedSpan` (`schema.ts`) reads both with CommonMark's flanking rules, also for the character before the
  span; the serializer escapes only a `==` or `++` that would open a span (`escapeSpans`). Underline comes from
  `@tiptap/extension-underline` (same version as in the starter kit) with that tokenizer.
- Tests: `realWorldMarkdown.test.ts` („== and ++ need flanking delimiters“), e2e `683-editor-real-world` (first test).

### R6A-2 A paragraph starting with an abbreviation became a list, and an edit wrote the abbreviation as a number (high)

- Symptom: „ca. 5 bis 10 Minuten“ was shown as a lettered list item „5 bis 10 Minuten“; typing in it saved
  `79. 5 bis 10 Minuten`. The same for „Fr. Müller“, „Mo. Termin“, „Dr. Schmidt“, „z. B.“, „i. A.“ and any one or two
  letters (or roman numerals) with a period at the start of a paragraph, a common start of German notes.
- Root cause: numbered lists with letters and roman numerals came from Tiptap's own tokenizer, which takes any one or
  two letters followed by `.` or `)` as a list marker. CommonMark and Obsidian have no such lists.
- Fix: such a list is read only with two or more items, all with letters, starting at `a`, `A`, `i` or `I`
  (`letterListToken`); anything else is text, as in Obsidian. The tokenizer also took „Fr. Müller“ with a numbered
  list below it for one list (found by the e2e test on CI).
- Tests: `realWorldMarkdown.test.ts` („a paragraph starting with an abbreviation is no list“), e2e 683.

### R6A-3 Numbered tasks lost their boxes and their state when the list was edited (high)

- Symptom: `1. [ ] Angebot schreiben` / `2. [x] Termin` (tasks in Obsidian) were shown without the boxes; an edit in
  the list saved `1. Angebot schreiben` / `2. Termin`. The tasks and whether they were done were gone from the file.
  Round 1 (H1-7) listed the escaped form `1. \[ ] a` as low; since the numbered lists are read by marked (R2A-1) the
  box was dropped entirely.
- Root cause: marked takes the box out of the item as a checkbox token; a numbered list item has no place for it.
- Fix: a numbered item keeps its box as text (`keepListTabs`), and it is written back unescaped.
- Tests: `realWorldMarkdown.test.ts` („numbered items with a box keep it“), e2e 683.

### R6A-4 A backslash at the end of a line was halved once the paragraph was edited (medium)

- Symptom: Obsidian and Typora display math with LaTeX line ends (`a &= b \\`) lost one backslash when the paragraph
  holding it was edited; the single `\` at the line end then reads as a Markdown line break, the formula breaks.
- Root cause: the serializer doubles a literal backslash only before ASCII punctuation, not before a line end.
- Fix: also before a line end (`escapeText`).
- Tests: `realWorldMarkdown.test.ts` („a backslash at the end of a line stays“), e2e 683.

### R6A-5 A single cell copied from Excel pasted as a table (medium)

- Symptom: copying one cell in Excel (or a web table, Google Sheets) and pasting it into a sentence inserted a table with
  an empty header row and the value in its one cell, instead of the value in the line.
- Root cause: the smart paste leaves tables of fewer than two cells to the normal paste, which pastes the HTML table.
- Fix: `singleCellTablesToHtml` (`paste.ts`, before the Word lists in `transformPastedHTML`) replaces a table of one
  cell by its content; the one-cell layout tables of mail signatures too.
- Tests: `smartPaste.test.ts` („pastes a single cell as its text …“), e2e 683.

### R6A-6 An Obsidian vault's path embeds of two files of one name could show the wrong file (medium)

- Symptom: with `Projekt A/assets/bild.png` and `Projekt B/assets/bild.png`, Obsidian writes the path:
  `![[Projekt B/assets/bild.png]]`. After the import a note outside `Projekt B` showed A's image for it, and a note in
  `Projekt B` that embeds `![[Projekt A/assets/bild.png]]` showed B's image.
- Root cause: the second file is stored as `bild 2.png`, and the notes were rewritten by folder alone: every reference
  to `bild.png` in the notes of `Projekt B` became `bild 2.png`, none outside.
- Fix: a reference with a path follows the file its path names (relative to the vault or to the note);
  bare names keep the folder rule (`replace_file_refs_where`, `names_folder` in `vault.rs`).
- Tests: `vault::tests::path_references_to_same_named_files_follow_their_path`, e2e 683.

### R6A-9 Typing in a paragraph with line ends made them hard breaks (medium)

- Symptom: in a paragraph written over several lines (`Zeile eins` / `Zeile zwei`, as Obsidian and most editors
  write prose and LaTeX), typing one character saved every line end of the paragraph as a hard break
  (`Zeile eins␣␣`): the file changed, and GitHub and other CommonMark tools then show line breaks where they joined
  the lines. A LaTeX `\\` at a line end lost a backslash again (R6A-4 in the app; found by the e2e test on CI).
- Root cause: ProseMirror reads typed text back from the page and, for a paragraph, turns each line end in it into the
  schema's line-break node, Tiptap's hard break. Tests that set the text through commands never took that path.
- Fix: typing is read back with the paragraph's line ends kept as text (a `domParser` in `MarkdownFidelity`,
  `schema.ts`); paste is unchanged.
- Tests: `realWorldMarkdown.test.ts` („typing in a paragraph with line ends keeps them“, through the page's DOM),
  e2e 683.

### R6A-7 A numbered list starting at 0 was renumbered from 1 once edited (low, fixed)

- `0. null` / `1. eins` became `1.` / `2.`: the start was read and written with `|| 1`. Test:
  `realWorldMarkdown.test.ts`.

### R6A-8 The HTML share said „Stand:“ in English too (low, fixed)

- The date line of a shared page was not translated; now `share.asOf`.

### Low (listed, not fixed in this round)

- R6A-L1: entities in an edited paragraph are written as their characters (`&copy;` as `©`, `&#x1F600;` as the emoji,
  `&amp;` as `&`); same text everywhere.
- R6A-L2: a `*` list directly followed by a `+` list gets a blank line between them once edited (as H1-4).
- R6A-L3: `1)`, `2)`, `10)` is renumbered `3)` once edited.
- R6A-L4: a nested quote right under a quote's line (`> a` / `> > b`), and a list or callout right under a callout's
  text, get a bare `>` line before them once edited; same look.
- R6A-L5: empty table cells are written `|  |` instead of as they were padded once the table is edited.
- R6A-L6: a loose list item with a fenced block after a blank line loses that blank line once edited (the list becomes
  tight).
- R6A-L7: a Logseq list indented with tabs under an item with `id::` properties is written with spaces and tabs mixed
  once edited; the nesting stays.
- R6A-L8: `- [X]` is written `- [x]` once the list is edited.
- R6A-L9: Obsidian comments `%%…%%` are shown as text and go into the HTML share; Obsidian hides them.
- R6A-L10: one column copied from Excel pastes as a one-column table; a copy with an empty last column keeps it.
- R6A-L11: Outlook's empty spacing paragraphs in a pasted mail become `&nbsp;` paragraphs.
- R6A-L12: an HTML table without `<th>` (Word, web pages) pastes with an empty header row, and its separator line can
  be wider than its rows.
- R6A-L13: Hugo's `+++` TOML front matter is read as text, not as front matter.
- R6A-L14: a list with letters that starts elsewhere than `a`/`i` (`c.`, `d.`) is text now (R6A-2), as in Obsidian.

## Looked at, no finding

- Round trips (unchanged, written from the document, one edit) of: Logseq `TODO`/`DONE` and `((block refs))`, Typora
  `$inline$` math, `~sub~`, `^sup^`, `<details>` and `<div align>` HTML blocks, GitHub alerts, reference links and their
  definitions, autolinks, `<kbd>`, setext headings, `***`/`___` rules, `*`/`+` bullets, `<!-- comments -->`,
  backslash line breaks, images with titles and `%20`, block ids `^abc` and `[[Seite#^abc]]`, `- [/]` and `- [-]`
  states, `key:: value` fields, dataview and mermaid fences, `![Bild|200](…)`, tables with alignment, escaped pipes in
  wiki-link aliases and code, `<br>` in cells, multi-paragraph and inline footnotes, front matter with `---` in the
  body, `{#id}` and closing hashes on headings, `_`/`__` emphasis next to snake_case, `~single~` strike, URLs with
  parentheses, `<a b.md>` links, indented code, `~~~` and four-backtick fences, tags with umlauts and digits, `$5`.
- HTML share: `<script>`, `onerror`, `onclick`, `<iframe>`, `<style>` and `javascript:` links are shown as text or
  dropped; the file's Content-Security-Policy allows no script; wiki links to headings and pages in the file, footnotes
  in order of reference, table alignment, entities.
- Paste: Excel rows with `|`, `*`, `[[`, quoted cells with line breaks; Word headings and colors; a GitHub code block
  from a browser; tab-separated logs (a code block); Markdown as plain text; a Teams meeting link.

## Tests added

- UI: `ui/src/editor/realWorldMarkdown.test.ts`; `smartPaste.test.ts` („pastes a single cell as its text …“).
- Rust: `vault::tests::path_references_to_same_named_files_follow_their_path`.
- e2e: `683-editor-real-world.test.js`.
