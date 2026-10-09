# Arcalo 1.16 – performance and robustness audit

Repo state: main at de27e1c (1.15.0). App: the prebuilt debug binary `q116/perf/bin/arcalo` (WebKitGTK, software
rendering under Xvfb :504, `WEBKIT_DISABLE_COMPOSITING_MODE=1`), 4 cores shared with other audit agents (load 1.3–1.9).
UI numbers are debug-build numbers and several times what a release build on a desktop shows; core numbers are given
for both the debug and the `--release` build where it matters. Single UI measurements vary by about ±15 %.

Workspace: the generator `crates/arcalo-core/tests/bigworkspace.rs` (6,190 pages, 21,139 links, 32,270 tasks,
13,531 chunks, 300 attachments, 2,000 issues, a 78 KB page) plus, seeded into a copy with SQL, 20,880 time entries
(about 10/workday for 2 years, plus 3 older years) and 7,704 calendar events over 3 years. Large pages (25 KB – 1 MB)
were created through `page_create`.

Scripts (scratchpad `q116/perf/scripts/`): `e2e/bench/bigworkspace.mjs` (unchanged, run as is), `pass2.mjs`
(idle CPU, timer, tree, views, 1 MB page, paste, switcher, export, 200 tabs, names), `scale.mjs` (page size scaling),
`probe.mjs` (where a keystroke goes), `rob.mjs` (full disk on a 30 MB tmpfs, read-only remount, missing attachments,
two instances), `pdf144.mjs` (e2e 144 timeline), `seed20k.py`. Core timings came from a temporary test file
(removed again). The repo is clean (`git status` empty), the release target folder, seed data and tmpfs are removed.

## Measurements

| What | Value (debug unless noted) | Target |
|---|---:|---:|
| Cold start, spawn → ready (first start of a copy) | 1.9–3.2 s; of it `feed::backfill` 1.1–1.3 s (also 1.2 s in release) | < 1.5 s debug, one-time work off the critical path |
| Warm start, spawn → ready | 1.76 s (DOMContentLoaded 0.47 s, ready 1.07 s) | < 1.5 s |
| CPU idle, no timer (60 s) | 0.8 % (app 0.3, WebKit 0.5); no IPC calls | < 1 % ✓ |
| CPU idle with a running timer (40–60 s) | **98.8–104 %** (WebKit 91–95 %) | < 2 % |
| … same, pulse animation of `.rec-dot` switched off | 8.5 % (1 Hz re-render of 3 timer displays) | < 2 % |
| Page switch (median of 10 small pages) | 245–344 ms | < 250 ms debug |
| Tab switch | 44–178 ms (median 58) | < 100 ms ✓ |
| Open the 78 KB page | 743–977 ms | < 800 ms |
| Typing latency small page / 78 KB page / plain input (median) | 32 / 43 / 4 ms (p95 49 / 59 / 6) | < 50 ms ✓ |
| Page size scaling 25 / 50 / 100 / 200 KB: open | 1.36 / 1.13 / 2.17 / 4.32 s | linear, < 1 s at 200 KB |
| … typing (median per key) | 55 / 48 / 90 / 128 ms | < 50 ms up to 200 KB |
| … to source view / source typing / back | 0.58/50/0.71 – 0.53/55/1.15 – 1.11/87/2.13 – 2.97/152/4.49 s·ms·s | < 0.5 s / 30 ms / 0.5 s |
| 1 MB page (118,254 DOM nodes): open | **35.1 s** | < 3 s |
| … typing median / p95 | **882 / 1,032 ms** | < 100 ms |
| … to source view / source typing / back to editor | **103.8 s / 686 ms / 33.9 s** | < 2 s / < 50 ms / < 3 s |
| … `page_save` (one edit) | 936–944 ms (IPC) | < 300 ms |
| Paste of 500 KB text into an empty page | **16.7 s** blocked UI; first `page_save` 20.3 s, `duplicates_for` 16.8 s | < 2 s |
| First save of a 500 KB page with 2,400 tasks (core) | **9.8–10.1 s release**, 44.4 s debug | < 300 ms release |
| … same text without task lines (core, release) | 175 ms | – |
| One-character edit of that page (core) | 105–110 ms release, 477 ms debug | < 50 ms release |
| `tags_suggest` per page open | 232 ms avg IPC (n = 25); core 170 ms debug, 76–85 ms release | < 20 ms |
| `page_schema` per page open | IPC avg 101 ms, max 322 ms for 0.1 ms of work | < 10 ms |
| Trivial reads during a page switch (`blocks_list` on an empty table, `leistungsarten_list`) | 74 / 82 ms avg IPC | < 10 ms |
| Week review (`week_review`, 20k bookings, 32k tasks) | 2,090 ms debug, **621 ms release** | < 100 ms release |
| Day review (`day_review`) | 1.3–1.7 s debug, 324 ms release, **1.39 MB** JSON | < 50 ms, < 100 KB |
| Tasks view (all tasks) | 1,153 ms to painted; `tasks_list` 5.2–6.1 MB, 625–1,402 ms IPC | < 300 ms, < 500 KB |
| Graph view | 1,110 ms; `graph_data` 2.3 MB, 450 ms (194 ms release) | < 600 ms |
| Issues page (2,000) | 716 ms; `jira_issues` 1.9 MB | < 500 ms |
| `workspace_tree` answer | 1.38 MB | < 300 KB |
| Calendar view (week) / timesheet | 153–191 ms / 78–268 ms | < 300 ms ✓ |
| Dashboard 15 widgets, backend / round trip | 97–137 / 103–162 ms | < 150 ms ✓ |
| Sidebar: expand all / collapse all / scroll | 115 ms / 93 ms / 16 ms per frame (virtual, 47 rows in the DOM) | ✓ |
| Quick switcher Ctrl+O / palette Ctrl+K, key → paint | 39 / 34 ms median; search 15 ms + meaning 55 ms | < 50 ms ✓ |
| Search core (`search_workspace`) | 53–90 ms IPC; FTS prefix of 1–2 letters 40–65 ms in optimized SQLite | < 50 ms |
| Vault export 6,142 files (27 MB) / CSV of 20,880 bookings | 1.03 s / 1.12 s | ✓ |
| Backup (101 MB incl. attachments) / a save during the backup | 2.5–3.3 s / 22 ms | ✓ |
| Memory: start / after 2 min usage loop (18 rounds) | 1,090 → 1,234 MB (app + WebKit) | flat after warm-up |
| Memory: 200 tabs open → all closed | 890 → 1,123 → **1,303 MB** (DOM back to 1,553 nodes, 0 editors) | back to ≈ start + 50 MB |
| 200 tabs: open one (first 20 / last 20) / Ctrl+W ×200 | 378 / 443 ms / 83 s (each close opens the neighbour) | – |
| Listeners on window/document/body after 200 tabs | net 0 (no leak) | ✓ |
| Full disk (30 MB tmpfs) | banner „Nicht gespeichert – Arcalo versucht es weiter“, toast, nothing lost, saved after space was freed | ✓ |
| Read-only data folder | start notice „Datenordner schreibgeschützt“, banner on edit | ✓ |
| Missing attachments | „Datei fehlt“ placeholders, no console errors | ✓ |
| Two instances, installed mode, no session D-Bus | **both stay running on one data folder** | second exits |
| Names: CON, NUL.txt, COM1, emoji/ZWJ, 400 chars, `..`, tab, `<>:?` | all accepted; blank title refused | ✓ |
| e2e 144: mark moves after the test's wait conditions hold | moved 225 px, 23–146 ms after „flash + page 2“ (8/8 runs) | 0 |

## Findings

Severity: High = users notice it in normal use or it costs seconds/a core; Medium = noticeable with large data or a
reliability gap; Low = edge case or hygiene. Expected gains are estimates from the measurements.

### P1 – High – A running timer keeps one CPU core busy

- Measurement: idle CPU 0.8 % without a timer, 98.8–104 % with one (WebKitWebProcess 91–95 %); with
  `.rec-dot { animation: none }` injected: 8.5 %. Three dots are on screen (status bar, sidebar dock, timesheet).
- Root cause: `ui/src/styles/app.css:343` `.rec-dot … animation: pulse 2s infinite` with
  `@keyframes pulse` on `box-shadow` (`app.css:345`). A box-shadow animation is never composited: every frame
  repaints (here the whole window, since nothing is composited; on WebView2/WKWebView still a main-thread paint 60×/s,
  GPU wake-ups and battery drain for as long as a timer runs, often all day). The same keyframes run in
  `.voice-dot` (`app.css:3161`), `.dw-next.live .dw-next-dot` (`dashboard.css:193`, during a meeting) and
  `.wn.live .dw-next-dot` (`workwidgets.css:107`). The remaining 8.5 %: `useTimerSeconds`
  (`ui/src/components/Sidebar.tsx:1250-1262`) re-renders each user (Shell `Shell.tsx:116`, the dock, timesheet,
  dashboard) every second.
- Fix: a static dot (or a pulse of `opacity`/`transform` on a pseudo-element, which composites, limited to a few
  cycles after start), no animation under `prefers-reduced-motion` and while the window is hidden or unfocused
  (`document.visibilityState`, `blur`); tick the clock text in one small component (or update a text node via ref)
  instead of re-rendering the dock/status bar; 1 Hz only when seconds are shown, else once a minute.
  Expected: < 1 % CPU with a timer.
- Guard: e2e budget test: start a timer, sample `/proc/<pid>/stat` of the app and its WebKit children for 30 s
  (as in `pass2.mjs` `cpuOver`) and assert < 5 %; a UI unit test that fails on `animation: … infinite` for
  properties other than `opacity`/`transform` in `ui/src/styles` (like the CSP and colour checks).

### P2 – High – Saving a page with many new tasks is cubic (10 s in release, writer lock held)

- Measurement (core, big workspace): first save of a 500 KB page with 2,400 tasks 9.8–10.1 s release / 44.4 s
  debug; the same text without task lines 175 ms; 100 KB with ~470 tasks 207 ms. In the app the 500 KB paste
  produced a 20.3 s `page_save`; every other write (autosave of other panes, timer, bookings) waits on the writer
  lock meanwhile.
- Root cause: `crates/arcalo-core/src/feed.rs:335-415` (`feed_tasks`, called from `feed_page_saved`
  `feed.rs:329` inside `save_page_content_at`). For every task text not on the old page it queries all
  `task_added` rows of this hour (`feed.rs:386-392`, a list that grows by one per inserted task) and then
  `stale.iter().find(|(_, title)| !texts.contains(..))` (`feed.rs:395`) where `texts` is a `Vec`: O(k·N) per task,
  O(N³) per save, plus O(N²) rows read. Hits pastes, a restored version, the Git sync taking a pulled note over,
  an AI insert of a long list, „Alle Markierungen übernehmen“ and imports of task-heavy notes.
- Fix: `texts` as a `HashSet`; read the hour's `task_added` rows once before the loop and keep them in memory
  (remove the one taken over); when one save adds more than ~20 tasks, record one aggregated activity
  („42 Aufgaben hinzugefügt“) instead of one row each. Expected: 500 KB first save ≈ 200 ms release.
- Guard: core test „a save that adds 3,000 tasks“ with a budget (< 1 s in a debug build) and a check that the
  activity feed holds at most one aggregated row for it.

### P3 – High – Large pages degrade linearly per keystroke and superlinearly on open/source switch

- Measurement: see the scaling rows. 1 MB: open 35 s, 882 ms per key, rich → source 104 s, 686 ms per key in the
  source view, back 34 s; a 500 KB paste blocks the UI 16.7 s. `probe.mjs` on 200 KB: one `insertText` costs
  6–18 ms in `applyTransaction` and 54–72 ms in `view.updateState`; with all 17 decoration props disabled
  `updateState` still takes 44–46 ms (the decorations are not the cause, they are incremental as documented);
  `appendTransaction` hooks are < 1 ms. A 1 MB textarea alone: 120–130 ms for the first value plus autosize,
  then 1 ms per update.
- Root cause: the editor renders every block of the note (118,254 DOM nodes at 1 MB) and each keystroke re-lays
  out and repaints the whole document (`ProseMirror` view update + layout of a non-contained flow; no
  `content-visibility` anywhere in `ui/src/styles`). The source view
  (`ui/src/editor/SourceEditor.tsx:200-206`) sets `height: auto` then reads `scrollHeight` on every change (two
  forced layouts of the full text), runs `markdownStats(splitFrontmatter(value).body)` and pushes it into the
  global store on every change (`SourceEditor.tsx:183-186`), and `chips.shown(value)` scans the whole text with a
  regex each time (`SourceEditor.tsx:132`, `sourceChips.ts:148`). The mode switch flushes, refetches and builds the
  other editor synchronously (`ui/src/views/PageView.tsx:102-119`). Pastes go through one `insertContent` of the
  whole parsed fragment.
- Fix: (1) `.ProseMirror > * { content-visibility: auto; contain-intrinsic-size: auto 3em; }` for long notes (class
  on the editor above e.g. 50 KB; WebView2 and WebKitGTK ≥ 2.42 support it; keep it off while printing) – expected
  5–10× on open and per key at 200 KB+; (2) source view: no autosize for long texts (a scrolling textarea of fixed
  height, or CodeMirror 6 which virtualizes lines), stats and chip scan debounced (300 ms, idle callback) like the
  outline already is (`NoteEditor.tsx:200-204`); (3) above ~300 KB: a notice and an offer to open the source view or
  split the note, and a paste of > 200 KB inserted in chunks across frames with a progress toast. Targets: typing
  < 50 ms up to 200 KB, < 100 ms at 1 MB.
- Guard: e2e budget on a generated 200 KB page (typing median < 80 ms debug, open < 2 s, source switch < 1.5 s),
  in the spirit of e2e 94; a unit test that `SourceEditor` does not call `markdownStats` synchronously per change.

### P4 – Medium – Week review is an N+1: seven day reviews, each loading all open tasks

- Measurement: `week_review` 621 ms release / 2,090 ms debug with 32k tasks and 20k bookings (UI command 2.09 s).
- Root cause: `crates/arcalo-core/src/weekreview.rs:360` calls `dayreview::day_review` for each of the 7 days;
  each one runs `db.list_tasks(TaskFilter { status: Open, due_before, .. })` (`dayreview.rs:465-466`), i.e. all
  open tasks with titles, sorted in Rust, only to keep `MAX_TASKS` and counts (`dayreview.rs:478-492`).
- Fix: in `day_review` count with SQL (`COUNT(*)` per due/overdue from `idx_tasks_open`) and fetch only
  `LIMIT MAX_TASKS`; in `week_review` read the open tasks once for the week and pass them to the days (or only the
  counts the week view uses). Expected: < 80 ms release.
- Guard: a budget test in `tests/bigworkspace.rs` (`week_review` < 300 ms in a debug build).

### P5 – Medium – Tag suggestions on every page open scan nearly the whole full-text index

- Measurement: `tags_suggest` 232 ms average IPC per page open (n = 25), core 170 ms debug / 76–85 ms release;
  the query matched 12,529 of 13,531 chunks for every sampled page.
- Root cause: `crates/arcalo-core/src/tagsuggest.rs:35-47` picks the 10 *most frequent* words of the page
  („umsetzung, konzept, bereits, budget“) and ORs them (`tagsuggest.rs:198-206`): the most common words of a
  workspace, so bm25 is computed for almost every chunk; plus a full `tag_counts()` per call
  (`tagsuggest.rs:226`). The UI asks on every open.
- Fix: choose words by rarity (document frequency from an `fts5vocab` table, skip words in > 5 % of chunks), cache
  the result per page and `data_version` (like the unlinked-mentions index), and ask only when the properties area is
  visible, after the page is idle for ~500 ms. Expected: < 10 ms, one fewer slow reader per page switch.
- Guard: core budget test on the big workspace (< 30 ms release / < 100 ms debug).

### P6 – Medium – Pure reads go through the writer connection

- Measurement: `page_schema` does 0.1 ms of work but averaged 101 ms (max 322 ms) over IPC during page switches.
- Root cause: `src-tauri/src/lib.rs:391-393` `page_schema` uses `state.db()` (the write lock) instead of
  `state.reader()`. Same for other reads found by scanning the commands: `time_chip_states` (`lib.rs:1344`, asked
  after every chip change), `attachments_list` (`files.rs:20`), `trash_list` (`lib.rs:494`), `mirror_status`
  (`lib.rs:1974`), `onboarding_status` (`lib.rs:3935`), `chat_list`/`chat_get` (`chats.rs:27,32`),
  `git_conflict_get` (`syncmerge.rs:223`); `export_entries` (`lib.rs:1481`) reads all entries under the write lock.
- Fix: `state.reader()` for these. Expected: page switch IPC tail −100 ms in the worst case; no read waits for a
  save (and none blocks the 5 s sampler that takes the writer lock while a timer runs, `lib.rs:3887-3892`).
- Guard: a shell test like the `client_for` check: commands whose names end in `_list/_get/_status/_schema/_states`
  must not call `state.db()` (allow-list for the few that write).

### P7 – Medium – Trivial reads queue behind slow ones during a page switch

- Measurement: `blocks_list` on an empty table 74 ms avg, `leistungsarten_list` 82 ms, `wbs_tree` 86 ms,
  `plugin:window|set_title` 106 ms avg (n = 44) while `tags_suggest`, `duplicates_for` (86 ms), `page_get` and
  dashboard data run.
- Root cause: synchronous database work runs inside `#[tauri::command(async)]` on the async runtime's worker threads
  (as many as cores) and shares three reader connections (`AppState::reader`, `lib.rs:267-279`); a page switch fires
  about ten reads at once, two of them slow (P5, `duplicates_for`). `set_title` is slow because the main thread is
  busy painting (software rendering).
- Fix: after P5, move heavy, non-urgent reads (tag suggestions, duplicate hints, mentions) to a low-priority
  connection/queue that runs after the page painted; cache `leistungsarten_list` and `wbs_tree` in the UI keyed by
  `wbsVersion` (as `zeit-source.tsx:20-38` already does for its own use); run DB commands via `spawn_blocking`.
  Expected: page switch 245–344 → ~200 ms debug.
- Guard: the bench's IPC summary as a CI budget: no IPC on a page switch slower than 150 ms in debug.

### P8 – Medium – Large JSON over IPC

- Measurement: `tasks_list` 5.2–6.1 MB (625–1,402 ms; tasks view 1.15 s), `graph_data` 2.3 MB (graph 1.1 s),
  `jira_issues` 1.9 MB, `workspace_tree` 1.38 MB (start and every tree refresh), `day_review` 1.39 MB.
- Root cause: views filter in the UI (`ui/src/lib/api.ts:69` `tasks_list` with an empty filter, documented in
  docs/performance.md „Not changed“); `day_review` caps tasks but not `pages` (`dayreview.rs:64`; the size here
  comes from all generated pages being created today, so real days are smaller).
- Fix: tasks view: page server-side (open first, `LIMIT` + offset or the filter in SQL, counts separately), send
  page titles once as a map instead of per task; graph: send node ids and link pairs as arrays (no repeated titles),
  titles from the store; tree: omit fields the tree does not render; cap `pages`/`files` in the day review with
  totals. Expected: tasks view < 400 ms, graph < 600 ms.
- Guard: bench assertion „no IPC answer larger than 1 MB“ on the big workspace.

### P9 – Medium – Start-up runs a 1.2 s history backfill before the window

- Measurement: `[startup]` marks: database open 101–108 ms, credential store 1,286–1,624 ms; core: `feed::backfill`
  1,097–1,282 ms (debug) and 1,226 ms (release) on the big workspace, 0.1 ms on later starts; every other start-up
  step ≤ 4 ms (`rebrand_classify` 39 ms once in release).
- Root cause: `src-tauri/src/lib.rs:4620` `feed::backfill(&db, …)` runs synchronously in `setup` before the main
  window is created (between „database open“ and „credential store“). It is one-time per workspace, but it is the
  start right after an upgrade or a vault import with thousands of pages, the start people judge.
- Fix: run it on a background thread after `window_ready` (it only adds history rows), emit `data://entries` when
  done. Also record warm-start phases after the window (remaining 1.76 s debug spawn → ready) to find the next item.
- Guard: start-up budget test reading the `[startup]` lines: „credential store“ − „database open“ < 300 ms on the big
  workspace.

### P10 – Medium – Two instances can run on one data folder (Linux without a session bus)

- Measurement: `rob.mjs` „two“: installed mode (no `ARCALO_DATA_DIR`), no reachable session D-Bus: the second start
  keeps running next to the first after 8 s.
- Root cause: the single-instance guard is only `tauri_plugin_single_instance` (`src-tauri/src/lib.rs:4382`),
  which on Linux needs D-Bus; the lock file exists only for portable mode (`src-tauri/src/portable.rs:48`
  `lock_instance`). Two processes then share caches (settings, mention index, semantic index) that assume one
  writer, and both run backups and syncs.
- Fix: take `portable::lock_instance` (an OS file lock on `<data dir>/.arcalo.lock`) in every mode as the second
  line of defence; when it is held, show the native message and exit. Debug test runs with `ARCALO_DATA_DIR` keep
  skipping it.
- Guard: extend the e2e two-instance check (or a shell test) to a run without a bus.

### P11 – Medium – Memory is not given back after many tabs

- Measurement: 200 tabs opened and closed: RSS 890 → 1,123 → 1,303 MB with 0 editors and the DOM back to 1,553
  nodes; usage loop 1,090 → 1,234 MB in 2 minutes, still rising (1.11 measured „level after the first rounds“).
  Listeners on window/document/body net 0, intervals stable.
- Root cause: not pinned down (WebKitGTK exposes no heap size to scripts); candidates are per-tab state kept for
  closed tabs (undo history, loaded docs, scroll and selection), the page cache in the store and WebKit's memory
  cache. Could also be lazy GC.
- Fix: take a heap snapshot with the Web Inspector before/after 200 tabs; bound per-tab caches to open tabs plus a
  small LRU; drop editor state on close.
- Guard: bench assertion: RSS after closing 200 tabs ≤ start + 150 MB.

### P12 – Low – Clock set back: no automatic backups, timer cannot be stopped

- Root cause: (a) `src-tauri/src/lib.rs:2052-2053`: a backup is due when `now − newest.created_at ≥ 24 h`; a
  backup stamped in the future (clock was ahead, then corrected) makes that negative, so no daily backup is made
  until real time passes that stamp (prune already protects the fresh file, `backup.rs:133-145`). (b)
  `crates/arcalo-core/src/timer.rs:174-176`: `stop_timer_in` refuses „Das Ende liegt vor dem Beginn“ when the
  clock moved behind the timer's start; the running timer blocks new timers and can only be discarded.
- Fix: (a) also due when the newest backup lies more than an hour in the future (log it); (b) stop at
  `max(at, start)` with 0 minutes and a hint, or offer the edit dialog.
- Guard: unit tests with a backup stamp tomorrow and a stop before the start.

### P13 – Low – The password-wrapped key file is written in place

- Root cause: `crates/arcalo-core/src/cipher.rs:750-753` (`WrappedKey::write`) and `:764-767` (`write_next`) use
  `fs::write` on the final name. Changing the password on a full disk or a crash mid-write truncates the only
  password-wrapped copy of the database key; the old password stops working too (the key in the credential store
  still opens the database on this computer, but not on another one or after the store is lost).
- Fix: `drawings::write_atomic` (temp file, `sync_all`, rename). Same for `gitsync::write_restored`
  (`gitsync.rs:1465-1468`) and the window state (`src-tauri/src/prefs.rs:173`, only cosmetic).
- Guard: a test that a failing write (read-only folder) leaves the previous file intact.

### P14 – Low – Pasted images: no fsync, and a torn file is never rewritten

- Root cause: `crates/arcalo-core/src/attachments.rs:186-191`: the content-hash file is written to `.tmp` and
  renamed without `sync_all`; after a power loss the name can exist with 0 bytes, and the next paste of the same
  image skips writing because `path.is_file()`.
- Fix: `write_atomic` (with `sync_all`) and treat an existing file whose size differs as missing.
- Guard: unit test with a zero-length file under the hash name.

### P15 – Low – Attachment names: weaker device-name rules than the export

- Root cause: `attachments.rs:229-233` reserves CON/PRN/AUX/NUL and COM/LPT+digit only; `vault.rs:495-505`
  also reserves `CONIN$`, `CONOUT$`, `COM¹²³`/`LPT¹²³` and a device name with trailing spaces before the dot
  (`CON .txt`). A file „CONIN$.txt“ dropped on Linux syncs into a folder Windows cannot open.
- Fix: share `vault::is_device_name` (trimmed stem) in `clean_name`.
- Guard: extend `clean_name` tests with the vault's cases.

### P16 – Low – Every save rewrites all task rows of the page

- Measurement: one-character edit of a 500 KB page 105–110 ms release (477 ms debug).
- Root cause: `crates/arcalo-core/src/tasks.rs:368-397` deletes and re-inserts every task row on each save (links,
  tags and chunks are diffed, tasks are not).
- Fix: diff by (ordinal, line, text, done, due, …) like `sync_rows`; skip when the task lines did not change.
- Guard: core budget test for a one-character save of a 500 KB note.

### P17 – Low – Short prefix searches compute bm25 for almost all chunks

- Measurement: `"a"*`, `"d"*` match ~12,500 chunks: 61–65 ms in optimized SQLite; `search_workspace` 53–90 ms IPC.
- Root cause: `crates/arcalo-core/src/search.rs:72-82` makes the last term a prefix query; the FTS tables have no
  prefix index (`notes_blocks_fts … tokenize = 'unicode61 remove_diacritics 2'`).
- Fix: `prefix='2 3'` on the FTS5 tables (new migration with rebuild) or note hits only from 3 characters on.
- Guard: core budget for a one-letter query.

### P18 – Medium – Flaky e2e 144 „PDF highlight in English“: the click lands while the viewer still scrolls

- Measurement (`pdf144.mjs`, 8 runs): after the link's mousedown the viewer jumps to page 2 (`goTo`, t ≈ 255–305 ms),
  the test's conditions (`.pdf-mark.is-flash` and page input „2“) hold at t ≈ 255–385 ms, and only then does the
  flash effect centre the highlight: the mark moves 225 px (238 → 463) at t ≈ 295–457 ms, 23–146 ms after the
  conditions hold. In one of 8 replays of the test's own sequence the mark was at 238 when the click started and at
  463 after it. The popover itself is `position: fixed` and stays clickable once it is open.
- Root cause: two scrolls in sequence in `ui/src/editor/PdfViewer.tsx`: the start page (`:323-329`, rAF after the
  document loads) and, 150 ms after `doc` and the highlights are there, `scrollIntoView({ block: "center" })` of the
  flashed mark (`:271-287`, retried every 100 ms). The test (`e2e/lib/linking-flows.js:231-235`) clicks the mark as
  soon as it is flashing and the page input says 2, i.e. inside that window. WebKitWebDriver computes the click
  point, then dispatches; when the scroll lands in between, the click hits the page, no popover opens and
  `.pdf-hl-pop .pdf-hl-delete` never becomes clickable. Slow CI machines widen the window (it opened once in run 167).
  Users see the same double jump (page top, then the highlight).
- Fix (app): when a highlight is given, scroll once to it as the start position (wait for the highlights, then
  centre the mark in the same frame as `goTo`), drop the delayed `scrollIntoView`, and mark the viewer as settled
  (`data-settled` on `.pdf-scroll`) once the start position is final; keep only the timer that clears the flash.
  Fix (test): wait for `.pdf-overlay .pdf-scroll[data-settled]` before clicking the mark; optionally a harness helper
  `clickStable(sel)` that waits until the element's rect is unchanged for two frames.
- Guard: e2e 143/144 assert that the mark's position does not change after `data-settled` (sample two frames), and
  the existing delete step then has no race.

## Verified without finding

- Idle without a timer: 0.8 % CPU, no IPC polling, three intervals, no listener growth on window/document/body.
- Full disk: save-failed banner and toast, edits kept and stored after space returns; backup and page creation fail
  with a clear message. Read-only folder: start notice and banner. Missing attachments: placeholders, no errors.
- Backups never block saves (a save during a backup: 22 ms). Exports: 6,142 files in 1 s, 20k bookings as CSV in 1.1 s.
- Network: connect timeouts per profile, AI streams with a 180 s idle timeout, link titles with their own timeout and
  size cap, git with 120 s.
- Sidebar tree is virtual (47 rows in the DOM for 6,190 pages); quick switcher and palette stay under 40 ms per key.
- Special titles (CON, NUL.txt, COM1, emoji with ZWJ, 400 characters, `..`, tab, `<>:?`) are accepted; the
  export's device-name handling is tested in `vault.rs`.

## Counts

High 3 (P1–P3), Medium 9 (P4–P11, P18), Low 6 (P12–P17); 18 in total.
