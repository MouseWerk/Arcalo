# Performance (1.11)

Measurements of Arcalo in a large workspace, what was slow, what changed, and how to run the
benchmark again.

## The workspace

`crates/arcalo-core/tests/bigworkspace.rs` generates it (deterministic, about 30 s in a debug
build): 5,000 pages in 50 folders (about 300 words, 4 links and 6 tasks each, frontmatter on
every fifth), one page of 10,000 words with tables, embeds and Mermaid diagrams, three years of
daily notes, two years of bookings (four per workday on 10 Netzpläne), 300 attachments, a canvas
of 200 cards, 2,000 Jira issues in 50 projects and three calendars with four appointments per
workday. In total 6,190 pages, about 20,000 links and 32,000 tasks; the database is 65 MB.

## How to run

```sh
# Core: generates the workspace into the folder (once) and times the main queries, plain and
# encrypted (SQLCipher).
ARCALO_BIG_DIR=/tmp/big cargo test -p arcalo-core --test bigworkspace big_workspace -- --ignored --nocapture

# EXPLAIN QUERY PLAN and timing of the queries in a file (separated by `;;`, parameters as a
# first line `--[…]`), with the SQLite build of the app.
ARCALO_BIG_DIR=/tmp/big ARCALO_BIG_SQL=queries.sql cargo test -p arcalo-core --test bigworkspace explain_queries -- --ignored --nocapture

# UI: starts the app (WebDriver, like the e2e tests) on a copy of the workspace and measures
# start, pages, typing, views, IPC and memory. Build the UI and the app first
# (`npm --prefix ui run build`, `cargo build -p arcalo --features custom-protocol`).
cd e2e && ARCALO_APP=$PWD/../target/debug/arcalo node bench/bigworkspace.mjs after
```

`e2e/lib/bigworkspace.js` builds the workspace on first use (cached in the temp folder,
`ARCALO_BIG_BASE` to choose) and hands each run a fresh copy. The UI benchmark records times in
the page (`performance.now()` up to the next painted frame), every IPC call with its duration and
answer size, and the app's resident memory with its WebKit processes. Its result is a JSON file
(`BENCH_OUT`, default the temp folder).

All numbers below are from **debug builds** (the app and the core tests; SQLite compiled
without optimization too) under Xvfb with WebKitGTK's software rendering, so absolute times are
several times what a release build on a desktop shows; the comparison before/after uses the same
conditions. Single measurements vary by about ±15 %.

## Before and after

| Metric | Before | After |
|---|---:|---:|
| Issues page with 2,000 issues, click to painted | 4,290 ms | 763 ms |
| Page switch (median of 10 small pages) | 417 ms | 282–291 ms |
| Start page, 15 widgets: data (backend / round trip) | 182–339 / 280–397 ms | 118–124 / 133–177 ms |
| Start page after a reload, painted after the data arrived (e2e 94, limit 150 ms) | 153–170 ms | 88–106 ms |
| Start page, 15 widgets in a new tab: painted after the data arrived | 28–140 ms | 26–45 ms |
| Kalender day markers (`daily_overview`, one week / six weeks, core) | 66 / 137 ms | 1.5 / 4.3 ms |
| Task counts of the suggestions (`suggestion_facts`, core) | 113 ms | 16 ms |
| Tag counts (core, plain / encrypted) | 64 / 343 ms | 17 / 16 ms |
| Sidebar tree (core, plain / encrypted) | 73 / 217 ms | 52 / 51 ms |
| Task list (core, plain / encrypted) | 260 / 731 ms | 232 / 232 ms |
| Unlinked mentions on 5,000 pages (unit test, budget 50 ms) | 77 ms | 55 ms first, < 50 ms repeated |
| Duplicate hint per page (IPC average during the run) | 266 ms | 88 ms |
| Graph view, click to first frame | 1,297 ms | 1,196 ms |

Unchanged within the noise: cold start to interactive 1.25–1.3 s (first contentful paint about the
same, DOMContentLoaded 0.5 s), warm start 1.2–1.3 s, opening the 10,000-word page 0.8–1.1 s,
typing latency (keypress to paint, median) 32 ms in a small page and 46–49 ms in the large page
against 4 ms in a plain text field, tab switch about 55 ms, sidebar scroll 8 ms per frame, task
list view 1.2 s (5 MB of tasks), canvas pan 23 ms per frame on average, backup 1.6 s, timesheet
80 ms.

Memory: 1.0–1.1 GB resident (app and WebKit processes) after start, 1.15–1.28 GB after three
minutes of the usage loop (pages, typing, Kalender, Issues, graph, new tabs; 17–26 rounds),
level after the first rounds. No listeners on window/document/body and no intervals stay behind
after page and view switches (checked by counting adds and removes).

Bundle: 2.6 MB of JavaScript before the first paint (824 KB gzip, 51 files), 11.2 MB in all;
the editor (500 KB) and the English strings (530 KB) are part of the start. Mermaid, KaTeX,
Excalidraw, PDF.js, the graph and the canvas load on demand.

## What was slow and what changed

- **Pages read with their Markdown.** Every check „is the page in the trash?“ in a join read the
  page row, and the rows carry the whole note. New index `idx_pages_meta` (migration 30, id first
  so it never drives a join on `deleted_at`) holds the page metadata: the tree, the duplicate
  list and the task list read it instead of the table. Counts of tasks and tags exclude trashed
  pages by the small trash index (`NOT IN (… deleted_at IS NOT NULL)`, the same rows since pages
  delete their tasks and tags with them).
- **Open tasks by due date.** `idx_tasks_open (done, due, page_id)` replaces `(done, due)`; the
  Kalender's per-day counts are one grouped query instead of loading every open task, and the
  suggestion counts come from the index alone.
- **The task list** reads the tasks without a join and attaches title and icon from one read of
  the live pages, sorted in Rust exactly like the former `ORDER BY` (a unit test compares both).
- **Tag suggestions** found linked pages by `lower(title)`, a scan of all pages; now by the
  existing `NOCASE` title index (the same matches: link targets are lower case).
- **Graph:** the backlink count per node was one query per node; now one read of the links.
- **One reader for everything.** All read commands shared one read connection, so a long read
  (tasks, graph, tag suggestions) made a page switch wait. Now three read connections (WAL).
- **SQLCipher:** with the default 2 MB page cache an encrypted workspace decrypted the same pages
  on every read; 16 MB per connection (filled only as pages are read).
- **Issues page:** 2,000 rows of about 30 elements each; from 300 issues on only the rows in view
  are rendered (per group, measured heights, like the task list).
- **The start page waited for a frame.** Its data was rendered in a scheduled task, after the
  next frame; while the window fades in after a start (each frame repaints everything when the
  WebView does not composite, 70 ms here) that cost one to two frames. The data now renders in the
  task it arrives in (`flushSync`), and the e2e 94 check has its margin back.
- **Restyling the whole app at start.** Density, fonts and theme were set on the document only
  when the settings arrived, which restyles every element (about 160 ms here) while the first
  views render. They are remembered for the next start and applied before the first render, so
  the settings find them in place.
- **Event subscriptions:** every `on(...)` was its own listen and unlisten call through the main
  thread (about 70 at a start, dozens per page switch); now one shell listener per event name,
  shared by all handlers in subscription order.
- **Unlinked mentions:** the title index of all pages is kept per connection until the database
  changes (`data_version` for other connections' commits, `total_changes` for its own), stop
  words are a set, and pages found by word prefix are matched before their links are read.

## Not changed

- Lazy loading the editor or the English strings would take the start bundle down by a third,
  but the editor is imported from about twenty places; left for a later release.
- Typing latency in the large page comes from ProseMirror's own update of a 10,000-word
  document; the decoration plugins already work incrementally.
- The canvas already moves one transformed layer and culls cards; the remaining frame time is
  software compositing under Xvfb.
- The tasks view loads all tasks (5 MB as JSON) and filters in the UI; changing that changes how
  the view works.

## Suche nach Bedeutung (1.15)

`ARCALO_BIG_DIR=/tmp/big cargo test -p arcalo-core --test bigworkspace semantic_search -- --ignored --nocapture`
gives every chunk of the large workspace (13,531 chunks) a 768-dimensional vector and times the
query side (debug build): the assistant's database scan (`rag::vector_top_k`) takes 272 ms; the
search's in-memory copy (`semantic::VectorIndex`, 8-bit unit vectors, 10.7 MB) loads once in
629 ms and then answers exact plus meaning hits in 174 ms, of which 83 ms are the exact FTS5
search; after an edit only the new chunk is read again (188 ms). The scan itself in an optimized
build: 1.6 ms for 13,531 chunks, 4.3 ms for 30,000, 14 ms for 60,000. The query's embedding
comes on top (a local Ollama answers a short query in a few tens of milliseconds; repeated
queries come from a cache).

## Long notes, page switches and large answers (1.17)

The findings P3, P7 and P8 of the 1.16 audit (`docs/quality/q116/perf-findings.md`). Measured with the
benchmark above on the large workspace (its 10,000-word page, 78 KB) and with a note of 200 KB and one of
1 MB built like a long working document (sections of paragraphs with bold text, links and tags, lists, tasks,
a table in every fourth section, a Mermaid diagram in every eighth, a page embed and an image in every tenth;
the generator of e2e 340), in the 1.16 build and the 1.17 build one after the other on a quiet machine (load
about 1). Debug builds, Xvfb, software rendering as above; typing is keypress to painted frame, median.

| Metric | 1.16 | 1.17 |
|---|---:|---:|
| 200 KB note: open (first time) | 1,308–1,388 ms | 1,088–1,253 ms |
| … typing (median) | 42–47 ms | 29–35 ms |
| … to the Markdown source view | 327–451 ms | 127–195 ms |
| … back to the visual editor | 1,079–1,389 ms | 925–973 ms |
| … typing in the source view (median) | 18–21 ms | 18–21 ms |
| … walks through the whole note per key (calls counted by e2e 340) | about 12 | 0 |
| … list items created when it opens / on the way to the source view | twice each / each once more | each once / none |
| 1 MB note: open (first time) | 5,204 ms | 4,901 ms |
| … typing (median) | 157 ms | 101 ms |
| … to the source view / back | 1,536–2,136 / 5,046–5,583 ms | 526–550 / 4,727–4,735 ms |
| Benchmark, 10,000-word page: open (first time) | 759 ms | 534–624 ms |
| … typing (median / p95) | 41 / 70 ms | 26–29 / 38–39 ms |
| … to the source view / back | 173–269 / 569–669 ms | 102–176 / 432–512 ms |
| Benchmark: reads of the WBS (`wbs_tree`) during the run | 16 (and 15 of the Leistungsarten) | 1 |
| Graph view, click to first frame | 1,004 ms | 944–965 ms |
| … its answer (`graph_data` / `graph_compact`) | 2.30 MB, 435 ms | 0.81 MB, 338–373 ms |
| Issues page with 2,000 issues | 630 ms | 581–605 ms |
| … its answer (`jira_issues` / `jira_issues_compact`) | 1.91 MB, 108–144 ms | 1.08 MB, 83–113 ms |
| Sidebar tree answer (`workspace_tree` / `workspace_tree_compact`, core) | 1.38 MB | 0.72 MB |
| Page switch, five small pages opened for the first time (median, three runs each) | 159–176 ms | 165–178 ms |

What changed:

- **Drawn once.** Tiptap's React binding gives the editor its node views again when the editor's content
  mounts (for React node views, which render through its portals; the app has none) and takes them away
  when it unmounts. ProseMirror drew the whole note anew each time: about 300 ms for the 200 KB note on
  opening, as much again on the way to the source view or when its tab closed, right before the editor was
  destroyed. The views given when the view is created now stay (`editor/stableViews.ts`).
- **No whole-note work per key.** Tiptap's code highlighting looked for every code block twice per
  transaction and highlighted all of them again when one changed; the chat times, the diagram blocks and
  their decorations were rebuilt; the time chips were listed twice; the table of contents read every heading;
  every diagram preview was told about the edit, which touched its DOM and made WebKit lay the note out once
  more inside the key (the forced layout of `scrollToSelection` went from 37–57 ms to under 1 ms at 1 MB).
  Each now follows the edit (`incremental.ts`: only the blocks a transaction touched) or skips edits that
  cannot concern it. e2e 340 counts walks through the whole document while a key is applied: none.
- **One read of the WBS.** Views and pickers that show projects, Netzpläne or Leistungsarten share one read
  per `wbsVersion` (`lib/wbsCache.ts`); the backend reports every change (`data://wbs`), also changes made
  outside the views, so the version no longer needs bumping by hand.
- **Slow reads of the opened page on their own connection.** Tag suggestions, duplicate hints and unlinked
  mentions run on a blocking thread with a fourth read connection (`background_read`): they hold neither a
  worker of the async runtime nor one of the three readers the next switch needs.
- **Compact answers.** The tree, the graph and the issue list come as rows and are decoded into the same
  objects (`lib/tree.ts`, `lib/graph.ts`, `lib/jira.ts`); the graph without the dates the view does not use,
  the issue list without the comments (the opened issue reads them with its view). The core benchmark prints
  both sizes (`core json …`).

Not changed:

- The way back from the source view parses the Markdown, builds the editor and lays out the note once
  (about 0.5, 0.35 and 0.35 s at 200 KB; linear). Keeping the visual editor alive while the source view is
  shown would avoid it, at the cost of a second editor per page in memory.
- Typing in the source view of a 1 MB note (87 ms per key) is WebKit laying out the text box; the default
  value React writes into a controlled text box per key costs 0.3 ms (an uncontrolled box was slower).
- The issue list keeps the descriptions (560 KB of the 1.08 MB here): its text search looks through them.

Budgets (min of several runs, `budget()` in `e2e/lib/harness.js`, 1.6 times on CI): e2e 340 opens the
200 KB note three times (open < 2.5 s, to the source view < 350 ms, back < 2.5 s) and checks that it is drawn
once and not again on the way to the source view, that typing walks through the whole note zero times,
typing in the source view (< 80 ms), that six views in new tabs read the WBS at most once and once more after
a change from outside, and that the tree and the graph load their compact rows (< 60 % and < 50 % of the
objects); e2e 103 that the issue list loads rows without comments and the opened issue still shows them; the
core benchmark keeps the compact answers under 60 % of the objects and the tree and graph under 1 MB.
