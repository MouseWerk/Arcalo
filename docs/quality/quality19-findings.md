# Arcalo 1.9 quality round: findings

Scope: diff 37b5618 (1.8.0) .. HEAD (filing and smart folders, embeds/queries/Mermaid, update system 2.0,
graph, canvas, Ctrl+click selection, winget). UI tour: EN-light and DE-dark at 1480x920, graph/canvas/tidy/
filing settings/briefing at 900 px. Console errors collected after each view: none in either mode.

Line numbers refer to the code after the fixes unless noted as "(before)".

## High

H1. Canvas Git conflict merged as raw text, can store broken JSON (known item 4). FIXED
- src-tauri/src/syncmerge.rs:254 (`git_conflict_resolve`), ui/src/views/ConflictView.tsx.
- Repro: Git sync on; edit a canvas here and on a second clone; sync. The conflict view shows the JSON
  block merge; "Übernehmen" (or "Beide" at a spot) saves conflict-merged text into a canvas page
  (`save_page_content` did not validate). The board then opens empty (see H2) and the next edit
  overwrites both versions.
- Fix: the conflict view detects a canvas (`canvas` flag in `ConflictView`) and offers "Meine behalten",
  "Andere übernehmen", "Beide behalten" (new command `git_conflict_keep_both`: the server's board becomes
  "<Titel> (Server)" next to it); `git_conflict_resolve` refuses invalid canvas JSON; the canvas shows
  the conflict banner. Rust unit test + e2e 132.

H2. An unreadable canvas opens as an empty board and the next edit overwrites it. FIXED
- ui/src/views/canvas/CanvasView.tsx:194/222, ui/src/lib/canvas/model.ts (`parseCanvas` returned an empty
  doc for unparseable text, the board was editable, any change saved `{nodes:[],edges:[]}` over it).
- Repro: any canvas whose stored content is not JSON (pulled broken file, conflict text, manual edit of
  the mirror). Open it: empty board; add a card: the old content is gone (only a version snapshot left).
- Fix: `isReadableCanvas`; such a canvas shows "Diese Canvas ist nicht lesbar" and is never saved over.
  Also: a non-conflict pull of an unreadable `.canvas` no longer replaces a readable one
  (syncmerge.rs:112).

## Medium

M1. Canvas save failure is never retried for the same text. FIXED
- ui/src/views/canvas/CanvasView.tsx:169 (before: `savedText` set before the save succeeded, so after a
  failed save the next `save()` saw `text === savedText` and returned; the change was never stored).
- Fix: `savedText` is restored on failure.

M2. Task lists in page embeds and canvas note cards render with a bullet and the text on its own line.
FIXED
- ui/src/styles/editor.css:1208 (the rules targeted `ul[data-type=taskList]`, which `shareHtml` renames to
  `ul.tasks`). Repro: `![[Seite]]` of a page with `- [ ] x`; same in a canvas note card.

M3. Canvas note card shows the title twice (known item 3). FIXED
- ui/src/editor/embedView.ts:240, ui/src/editor/embedSyntax.ts (`withoutTitleHeading`, unit tested).
  Repro: note "Release Plan" starting with "# Release Plan" as a card.

M4. Local graph uses folder colors only (known item 2). FIXED
- ui/src/panels/LocalGraph.tsx:41; settings now shared via ui/src/components/graph/source.ts
  (`useGraphSettings`, `publishGraphSettings`), also honours "Farben nach oberstem Ordner" off.

M5. Briefing: "Als Nächstes"/"Next" badge runs into "Beitreten"/"Join" at ~900 px (known item 1). FIXED
- ui/src/styles/app.css:3642. The title button could not shrink below its min-content (long or unbreakable
  title), pushing the badge over the action column. Now the title wraps (`overflow-wrap:anywhere`) and
  the badge moves below it. Verified with "Quartalsplanungsbesprechung-Produktmanagement-..." at 900 px.

M6. Update install races a stalled background download. FIXED
- src-tauri/src/updates.rs:612. `update_install` paused the background download, waited 5 s, then started
  its own download into the same `.part` file even if the first was still running (stalled chunk).
  Now it refuses with "Der Download läuft noch – bitte gleich noch einmal versuchen" and un-pauses.

M7. i18n: filing examples show German month names in English (EN tour: "Example: Journal / 2026 / 10 –
Oktober"). FIXED
- ui/src/views/settings/FilingSection.tsx: used the webview's `Intl` (WebKitGTK fell back to German);
  now the same fixed names as the core (`filing::month_name`).

## Low

L1. Rollback restores the program before the database; if the database copy then fails, the previous
program starts on the migrated database. src-tauri/src/rollback.rs:150. Deferred: rename+copy of one file,
very unlikely to fail; reordering needs a way back for the program as well.
L2. `undo_last_move` also moves back a page the user moved by hand after the bulk move (move_undo is not
cleared by single moves). crates/annalo-core/src/filing/tidy.rs:434. Deferred (undo is offered right after
the move only).
L3. Dropping a multi-selection before/after a row puts the pages at the end of that parent, not at the
drop position. ui/src/components/Sidebar.tsx:457. Deferred.
L4. `parseCanvas` drops edges whose nodes are missing and nodes without a string id; the next save
removes them from the file. ui/src/lib/canvas/model.ts:112. Deferred (invalid JSON Canvas anyway).
L5. Graph filter date inputs clip their placeholder ("DD.MM.YYY") in the 280 px panel.
ui/src/styles/app.css:3427. Deferred (cosmetic).
L6. Graph layout worker has no `onerror` fallback (a CSP block would leave the graph unlaid out).
ui/src/components/graph/GraphCanvas.tsx:427. CSP `worker-src` covers `tauri://localhost/workers/` and
`http://tauri.localhost/workers/`, matching vite's `workers/` output; no change.
L7. Under the e2e X server (compositing off) a 1 px vertical line of the settings nav shows through the
tidy-up dialog. `elementsFromPoint` shows the dialog on top: a WebKitGTK paint artifact, not app code.

Checked without findings: CSP for Mermaid (strict security level, inline SVG styles allowed by
`style-src 'unsafe-inline'`), secrets (only test fixtures), time tracking off (`from: entries` queries show
the off note), tidy-up apply/undo in one transaction, `move_pages` never moves into itself, update
download resume (200 vs 206) and signature check, backup tagging/restore keeps the current file aside.
