# Q112 A1 Notes and editor: findings

Method: round-trip probe (75 extra Markdown constructs through the real schema, twice), code read of
NoteEditor save/merge path, schema serializer, wiki links, reveal; app driven via e2e harness on :430.

## Fixed

1. HIGH  Same-page links `[[#Abschnitt]]` / `[[#^id]]` (Obsidian) were not parsed: shown as text and saved
   escaped as `\[\[#Abschnitt]]`, i.e. the link was destroyed on the first edit of the page.
   Fix: tokenizer accepts an empty target with anchor; label shows the section; click scrolls there.
   Test: roundtrip `wikiSamePage`.
2. HIGH  `[[Seite#Abschnitt]]` and `[[Seite#^blockid]]` opened the page at the top: the anchor was never passed
   on. Fix: `onOpen(target, newTab, anchor)` -> PageView opens the page and `openAtAnchor` scrolls to and flashes
   the heading / block (reveal.ts `locateAnchor`). Test: reveal.test `locateAnchor` (3).
3. HIGH  Link destinations in angle brackets (`[x](<Ordner/Mein Plan.md>)`, URLs with spaces) lost the
   brackets on save and became plain text `\[x\](...)` on the second save. Fix: `linkDestination` writes `<…>`
   when needed; LINK_RE reads it. Test: roundtrip `linkAngle`.
4. MED   `|` inside inline code in a table cell was written unescaped, splitting the cell into two columns in
   every GFM reader (and here after reload). Fix: escaped as `\|` in cells. Test: `tableCodePipe`.
5. MED   Inline code containing backticks (`` `` a ` b `` ``) was written with a single backtick fence, unstable:
   the second save corrupted it. Fix: code mark bracketed with sentinels, fence chosen from the text
   (`codeSpan`). Test: `codeBackticks`.
6. MED   HTML entities: `&nbsp;` / `&copy;` / `&#124;` showed literally and were saved as `&amp;nbsp;` (visible text
   in Obsidian/GitHub afterwards). Fix: entities decoded on parse; no-break space written back as `&nbsp;`.
   Tests: `entityNbsp`, entities (2).
7. MED   The blank line between frontmatter and text was removed on every save (diff noise in mirror/git sync
   for imported Obsidian/Hugo notes). Fix: `splitFrontmatter` returns the gap, `joinFrontmatter` puts it back.
   Test: splitFrontmatter gap test.
8. LOW   Table column widths: cells with links were padded 2 chars too wide (sentinels counted), alignment rows
   grew wider than their column (`:---` vs `---`), cells with inline code too narrow. Own `renderTable`.
   Tests: `tableLinkWidth`, `tableAlignWidth`.

9. HIGH  Markdown pasted as plain text (from a .md file, VS Code, an AI chat) was inserted as literal lines and then
   saved escaped (`\- a`, `\# Titel`). Fix: `isMarkdownText` (paste.ts) + `markdownContent` (smartPaste.ts): parsed
   and inserted formatted; "Als Text einfügen" undoes it; web/Office HTML, single list-like lines and prose with
   stars stay normal pastes. Tests: smartPaste (3).
10. MED  No keyboard way to follow a link in the editor (mouse only). Fix: Alt+Enter follows the wiki/web/mail link at
   the caret, Ctrl+Alt+Enter in a new tab (Obsidian's binding). Tests: reveal.test linkAtCaret, e2e 151.
11. MED  A task list right after a bullet list was saved with a blank line between (one loose list for every other
   reader; file changed on first edit). Fix: TIGHT_MARK between adjacent bullet/task lists (also nested/in callouts).
   Tests: bulletsThenTasks (3). Integration: a blank line the author wrote there is kept (spacedBefore on the
   second list, from the source), so an unedited page saves unchanged. Tests: bulletsBlankTasks (4), e2e 57.
12. LOW  Find in page: typing a query highlighted matches off screen without scrolling there. Fix: first match
   scrolled into view (block: nearest). Test: e2e 151.
13. LOW  UI: toolbar paragraph style cut to "Übersch…" in panes under 1040 px (fixed 100/104 px width). Fix: width
   auto from the select's sizer (widest option, no jump). Shots: before/after-de-top.png, compare-top.png. e2e 151.
14. LOW  a11y: the toolbar's AI button had no accessible name when its label is hidden (narrow panes). Fix aria-label.

## Checked, no change needed
- Two panes on the same page: 3-way merge path (merge3) and e2e 49 cover it. External file change via the mirror:
  the mirror is export-only; external changes arrive through git sync (`data://pages` -> reload/absorb).
- Rename rewrites `[[Old#H|A]]`, `![[Old]]`, frontmatter links; code ignored (core tests).
- Unresolved link click creates and opens the page; hover preview, slash menu, bubble toolbar, source mode, split pane,
  dark / contrast-dark / contrast-light, EN UI: screenshots before-*/after-* in q112-shots/notes, no defects beyond above.
- Large page (10,500 words): opens in ~2 s (debug build, Xvfb), key latency median 53-66 ms vs 26 ms on a small page;
  profile: state.apply 3 ms, view update ~21 ms (WebKit layout); plugin views and decorations are cheap.
  content-visibility made WebKitGTK slower (59 ms), so not applied.

## Normalizations kept (meaning unchanged, documented, not fixed)
- `~~~` fences become ```` ``` ````, `*`/`+` bullets `-`, `_x_`/`__x__` become `*x*`/`**x**`, setext headings ATX,
  `***`/`___` rules `---`, `~x~` becomes `~~x~~`, reference links become inline, `<url>` autolinks bare,
  loose lists tight, trailing `##` on headings dropped, CRLF -> LF, runs of blank lines collapse (by design).
  Changing these means replacing Tiptap's list/heading serializers; risky for 1.12, listed for later.
- `&copy;` is written back as `©` (only `&nbsp;` is kept as entity because it is invisible).

## Left / limitations
- Hover preview of `[[Seite#Abschnitt]]` shows the page from the top (not the section).
- HTML share export renders `[[#Abschnitt]]` as text (no in-file heading anchors yet).
- Contrast-dark theme: the editor placeholder is #d6d6d6 on black, close to body text; a theme-token question for the
  themes owner, left as is.
- Bubble toolbar is placed under the sticky toolbar when the selection is scrolled out above (edge case).
