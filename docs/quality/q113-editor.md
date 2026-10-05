# Q113 A1 Editor: findings

Method: round-trip of ten real-world files (GitHub READMEs of marked, ripgrep, express, fastapi, rust, VS Code,
awesome; Obsidian help pages on formatting and callouts; obsidian-releases with Windows line ends) through the
real schema, once as saved unedited and once with every block re-serialized, and the result compared byte for byte
and as rendered HTML (marked, GFM). App driven via the e2e harness on :451; screenshots in
`scratchpad/q113-shots/editor/` (260-*, after-preview-narrow-light/dark).

## Built

1. Keep the author's Markdown (sourceStyle.ts). Two layers, set up while parsing:
   - Source blocks: every top-level block keeps the text it was read from (`src`) and the blank lines before it
     (`gap`: count, hash of the block before, implicit empty paragraphs). A block that is still equal to the block
     as read (by identity or `Node.eq`, so undo counts too) is written as that text. Blank lines are written as in
     the file while the block before is the same one; "no blank line" only between two unchanged blocks. Line ends
     (CRLF), leading blank lines and the file's ending are kept by `textShape`/`withShape` in NoteEditor. A reload
     from another pane registers the reloaded blocks; `replaceChanged` diffs without the source attributes.
   - Source style (hidden attributes, like 1.12's `spacedBefore`): bullet marker per list, `1)` and lazy `1. 1. 1.`
     numbering, loose lists, nested indentation per item (tabs, four spaces) and indented continuation lines,
     fences (`~~~`, longer fences, indented code, the info string as written), `_x_`/`__x__`/`~x~`, setext headings
     and closing `##`, rule markup (`***`, `___`, `* * *`), link form (inline, `<…>`, bare, reference `[x][r]`,
     `[x][]`, `[x]` with the definitions kept as `refDefinition` blocks), unpadded tables (with their separator row
     while the columns and alignment match), backslash line breaks. New content uses the defaults. An `_x_` that
     would touch a letter after an edit is written `*x*` (an underscore inside a word is no emphasis).
2. Hover preview of `[[Seite#Abschnitt]]`, `[[Seite#^id]]` and `[[#Abschnitt]]` shows the section or block (from
   `page_embed`, the same extraction as `![[Seite#Abschnitt]]`), the card title reads „Seite › Abschnitt“ and opens
   the page at the section; a missing section shows the page start with a hint.
3. HTML export: headings get ids from their text (`page-12-über-uns`, numbered when repeated, `-h5` fallback for a
   heading without letters), `^id` blocks get `page-12-block-id` (the marker leaves the text); `[[#Abschnitt]]`,
   `[[#^id]]` and `[[Seite#Abschnitt]]` for the exported page link inside the file; a section of another page in the
   file is checked after all pages are rendered (`resolveSectionLinks`), else the page. Reference definitions are
   left out of the export. Same slug rules as section links (case, quotes and spaces folded).

## Fixed (found by the corpus)

1. HIGH  `[![Badge](b.svg)](url)` lost the link and `**[[Seite]]**` lost the bold on save: Tiptap applies marks
   only to text. Fix: marks are applied to inline atoms and rendered around them. Tests: corpus `linkedImage`,
   `boldWikiLink`.
2. HIGH  `[INSTALL.md](INSTALL.md)` became plain text `INSTALL.md` (text equal to target was written bare even
   when it is no URL). Fix: bare only for http(s)/ftp URLs and e-mail addresses. Test: `explicitSameText`.
3. HIGH  Tab-indented subtasks (`\t- [ ] b`, Obsidian's default) were corrupted to `   [ ] b`: Tiptap dedents by
   characters. Fix: own task list tokenizer counting columns. Tests: `tasksTab`, corpus obsidian-daily.
4. HIGH  A fence indented by one to three spaces (` ```js`) made the code block an escaped paragraph. Fix: read
   like any fence. Test: probe case, corpus.
5. MED   `\*\*x\*\*` was saved as `\**x*\*` (italic on the next load), `\**x*\*` as `\**x**`: escaping looked at
   single characters, not runs, and not at the neighbouring inline content. Fix: whole runs are escaped when they
   could open or close emphasis, node edges count as punctuation. Tests: `escaping` (3).
6. LOW   Trailing spaces on the last line of a list were dropped (marked trims list tokens): taken from the source.
7. LOW   Text written into an empty page (every new page) was saved without a final line end: the empty file's
   ending was kept as "none". Fix: an empty page's text ends like new content; an empty page saved empty stays as
   it was (integration, e2e 29). Test: corpus `text written into an empty page`.

## Corpus test

`ui/src/editor/corpus.test.ts` with `corpus/*.md` (7 files in the styles of Obsidian notes, GitHub README and
contributing guide, VS Code notes and minutes): each saved unedited is byte-identical, also lexed as a whole and
with CRLF and no final line end; an edit of one paragraph changes exactly that line; a reload and an undo keep the
file; 34 style cases pass both through the style layer alone (as if every block were edited) and unedited. The ten
downloaded real-world files (not committed, licences) are byte-identical unedited.

## Still normalized (only in an edited block; an unedited block stays as written)

- `**[x](u)**` becomes `[**x**](u)` (same rendering).
- A no-break space is written `&nbsp;`, other entities (`&copy;`, `&euro;`) as their characters.
- Blockquotes: `>` prefixes are written `> ` on every line (lazy continuation lines get one).
- Lists: the spacing after the marker (`-   x`) becomes one space; a list indented as a whole (`  * x`) is written
  at column 0; lazy continuation lines are written lazy unless the source indented them.
- Indented code after a list, or with blank first/last lines, is written fenced (indented would join the list).
- Tables: padded tables are re-padded; unpadded ones use `| a | b |` cells (not `|a|b|`).
- Reference-style images `![x][ref]` are written inline; duplicate definitions of one label keep the first.
- Blank lines that contain spaces are written empty; an empty task `- [ ]` gets a space after the box.
- Setext headings over two lines, and an edited heading whose underline length no longer matches, keep the
  stored underline.

## Performance (10,500-word page)

- vitest (happy-dom, median of 5): open 400-600 ms both before and after (noise), save 13-24 ms vs 50-92 ms
  before (unchanged blocks are copied), save after one edit 28-41 ms vs 49-80 ms.
- App (debug build, Xvfb, e2e harness): opens in 2.0-2.1 s, key latency median 57-64 ms; 1.12: ~2 s and 53-66 ms.
  e2e 57 passes. No regression.

## Visual pass (hover preview)

Light, dark, narrow window (960 px): page and section titles share the row and truncate each with an ellipsis (the
section takes at most 60 %), separator and section in muted tones, the „not found“ hint as a quiet note above the
page start. Tokens only (`--text-2/3`, `--bg-hover`, `--r-sm`, `--fs-xs`, `--fw-medium/normal`).

## Left

- Reference-style images and the forms listed above stay normalized in edited blocks.
- A section preview reads the saved page (an unsaved edit of the same page shows after its save, ~1 s).
