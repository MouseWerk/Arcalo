# Architecture

## Layers

```
 ui/ (React + TipTap, WebView2)      ── invoke()/listen() ──▶  src-tauri (IPC commands, state, secrets, sampler)
                                                                    │
 crates/annalo-cli ─────────────────────────────────────────────────┤
                                                                    ▼
                                             crates/annalo-core
            ┌─────────┬──────────┬───────────┬──────────┬──────────┬───────────────┐
            │ db      │ zeit     │ tracking  │ netzplan │ export   │ ai::{client,  │
            │ search  │ (parser) │ (budget)  │ (CPM)    │          │ provider,rag, │
            │ graph   │          │ activity  │          │          │ router, tools}│
            └─────────┴──────────┴───────────┴──────────┴──────────┴───────────────┘
                      SQLite (WAL, FTS5, f32 BLOB embeddings)     AI providers (HTTP/SSE)
```

All logic lives in `annalo-core` and is tested there; the shell only wires state,
events and OS integration. The UI never talks to the network or the filesystem directly.

## Data model (`crates/annalo-core/migrations/0001_init.sql`)

| Table | Purpose |
|---|---|
| `projects` | Level 1: `project_code` (e.g. `PRJ-2026-X`) |
| `netzplaene` | Level 2: `netzplan_nr`, `wbs_element` (PSP-Element), `planned_hours` |
| `vorgaenge` + `vorgang_links` | Level 3: activities with duration, plan hours, optional manual remaining estimate, and precedence links for CPM |
| `leistungsarten` | Level 4: activity types (`DEV`, `CONSULTING`, `PM`, `TEST`) |
| `time_entries` | `netzplan_id`, `vorgang_nr`, `leistungsart`, `start_time`, `end_time`, `duration_minutes`, `description`, `status_flag` (`running`/`draft`/`released`/`exported`), `source`, `page_id` (the note a `/zeit` line was typed in, v5; cleared when the page is purged). A partial unique index allows only one running timer |
| `pages` | Page tree; `content` holds the page as one Markdown document (v2). `daily_date` marks daily notes, `favorite` pins pages, `deleted_at` marks pages in the trash (v3) |
| `notes_blocks` | Derived chunk index (split at headings, ~1200 chars) rebuilt on every save; `vector_embedding` is a little-endian `f32` BLOB. Unchanged chunks keep their embedding |
| `page_links`, `page_tags` | Outgoing `[[links]]` (lower-cased targets, so links to not-yet-existing pages resolve later) and `#tags`, for backlinks and the tag view |
| `tasks` | Task items (`- [ ] …` outside code blocks) per page: ordinal, line, text, done, due date (`due:YYYY-MM-DD` / `due:YYYY-MM-DD`), priority (`!!` hoch, `!` mittel), tags. Rebuilt with links and tags on every save; checking a task off rewrites exactly that checkbox and saves the page |
| `pages_fts` | FTS5 over page titles (title hits rank first in search) |
| `page_versions` | Earlier contents of a page (v6): `page_id` (cascade on purge), `content`, `created_at` |
| `settings` | Application settings as JSON. The API keys of the AI providers are **not** stored here; the shell keeps them in the Windows Credential Manager / macOS Keychain |
| `notes_blocks_fts`, `time_entries_fts` | FTS5 external-content indexes (unicode61, diacritics removed), kept in sync by triggers |
| `ai_usage` | Per-request tokens, cost, TTFT and tokens/s |

Migrations are numbered and tracked through `PRAGMA user_version`; a database newer than
the binary is refused rather than modified.

Migration v2 converts the old block model: blocks are concatenated into
`pages.content`, then every page is re-indexed (chunks, links, tags).

## Data safety

- **Trash** (`trash.rs`): deleting a page sets `deleted_at` on it and its subtree (one shared stamp, so
  subpages trashed earlier stay separate entries). Every normal query (tree, search, links, tags, RAG,
  export) skips trashed pages. Restoring puts a page back under its parent, or at the top level if the
  parent is gone; title and daily-note clashes are resolved. Entries older than 30 days are purged on start.
- **Backups** (`backup.rs`): `VACUUM INTO` writes a consistent snapshot `annalo-YYYYMMDD-HHMMSS.db`;
  older files beyond `backup_keep` (default 14) are deleted. The shell backs up on start when the newest
  backup is older than 24 h and re-checks hourly, into `backup_dir` or `<data dir>/backups`.
- **Markdown mirror** (`mirror.rs`): after each successful backup (with `markdown_mirror`, default on) the shell
  writes the vault export plus `Zeiterfassung/YYYY-MM.csv` (BOM, `;`, decimal comma) and a `README.txt` marker into
  `markdown_mirror_dir` or `<backup dir>/markdown`. It is built in `.markdown.staging` and swapped in by renaming the old
  folder to `.markdown.old`; an interrupted swap is recovered on the next run. A non-empty folder without the marker is
  never replaced. Failures are recorded (`mirror.error` meta row) and shown in the settings; they do not fail the backup.
- **Git sync** (`gitsync.rs`): the mirror is swapped atomically, so it cannot hold a repository. The sync keeps its own
  working tree `<data dir>/git-sync`, brings it to the mirror's state like rsync (removals first, `.git`, `.gitattributes`,
  `README.md` and `annalo-workspace.db` kept), `git add -A`, commits only staged changes and pushes `HEAD:refs/heads/<branch>`.
  A fresh working tree adopts the remote history only when its `.gitattributes` carries the sync's marker. A rejected push
  is rebased onto the remote when the histories are related; otherwise (or on a conflict) it goes to `annalo-sync-<host>`.
  The system `git` runs without a shell (`CREATE_NO_WINDOW` on Windows), with `GIT_TERMINAL_PROMPT=0` and a 120 s
  timeout. The HTTPS token comes from the credential store (account `git-token`) and is passed as
  `GIT_CONFIG_KEY_n=http.extraHeader` (`Authorization: Basic base64(x-access-token:TOKEN)`), only to HTTP(S) remotes;
  git's stderr and every recorded error are redacted. Runs after `run_backup` (mode `with_backup`) or in the scheduler
  thread (mode `hourly`, mirror refreshed first); outcomes are kept in `gitsync.*` meta rows and emitted as
  `gitsync://done` / `gitsync://failed`.
- **Versions** (`versions.rs`): a save stores the page's previous content as a snapshot when the newest
  snapshot is at least 10 minutes old (one per editing session, not per autosave). Restoring a version and
  rename link rewrites in other pages always snapshot first; „Jetzt Version sichern“ (`page_snapshot`)
  stores the current state. At most 50 per page; older than 30 days are pruned on start. A restore saves
  through `save_page_content`, so search, links, tags and tasks follow. The dialog shows a line diff (LCS).
- **Data folder** (`datadir.rs`): `ANNALO_DATA_DIR` wins, then `<app config dir>/location.json`
  (`{"data_dir": "…"}`), then the app data folder. „Speicherort ändern…“ checkpoints the WAL
  (`wal_checkpoint(TRUNCATE)`) while holding the database lock, copies `workspace.db` (+ `-wal`/`-shm`),
  `attachments/` and `backups/` (never over an existing workspace), writes `location.json` and restarts.
  A data folder on a UNC path or inside OneDrive/Dropbox gets a persistent warning at start
  (`data_dir_status`, queried by the UI once it is ready, so the warning cannot be missed).
- **Single instance**: a second launch only focuses the running window (tauri-plugin-single-instance),
  so two processes never write one workspace. Test runs with `ANNALO_DATA_DIR` skip the check.
- **Close to tray / quit**: with `close_to_tray` the UI flushes its editors and calls `window_hide`;
  „Beenden“ in the tray emits `app://quit-requested`, the UI flushes (asking if that fails) and calls
  `app_quit`. Without it the UI destroys the main window and the shell exits.

## Desktop integration (`desktop.rs` in core and shell)

- Tray menu (Öffnen, Timer stoppen / Zuletzt verwendet starten, Schnellerfassung, Beenden); the
  activity sampler refreshes the tooltip and checks reminders every 30 s.
- Quick capture: a second, undecorated always-on-top window (label `capture`, `index.html#capture`)
  created on first use by the global shortcut (`capture_shortcut`, default Ctrl+Shift+Space – Ctrl+Alt
  is AltGr on German keyboards). The palette's global shortcut is `palette_shortcut` (default Alt+Space,
  empty = off); both are re-registered when the settings are saved. `capture_submit` books `/zeit` lines and appends the rest to today's
  daily note (`desktop::capture`, all or nothing).
- Global shortcuts live in three slots (capture, palette, `search_shortcut`, default Ctrl+Shift+O);
  `apply_shortcuts` registers new ones before releasing old ones, refuses duplicates across slots and
  rolls back on failure.
- Quick search: a transparent, undecorated window (label `search`, `index.html#search`, 640×420) built
  by the same popup code as the capture window, opened by the shortcut or the tray („Suchen…“). It uses
  `search_workspace` plus quick actions (`ui/src/lib/quicksearch.ts`); a chosen result goes through
  `search_open`, which hides it, shows the main window and emits `search://open` (`{kind:"page", page_id, new_tab}`,
  `timesheet`, `timer_stop`) to it. `/zeit …` is booked via `capture_submit`. The query is kept for 60 s.
- Start page: `settings.dashboard` (`{ widgets: [{ id, kind, size: "s"|"m"|"l" }], note }`, normalized on load:
  unknown kinds dropped, ids made unique) is saved by `dashboard_save` only; `settings_save` keeps the stored
  dashboard. The grid has four columns (s = 1, m = 2, l = all) and falls back to two and one via `@container pane`.
- Reminders: `end_of_day_reminder` and `late_timer_reminder` are pure functions of time, settings,
  booked minutes and the last notified day (kept in `settings` meta rows). Desktop notifications cannot
  report clicks, so after an end-of-day reminder the next focus of the main window opens the timesheet.

## Auto-update (`updates.rs` in the shell, `update.rs` in core)

- `tauri-plugin-updater` is registered only when the build compiled in `ANNALO_UPDATER_PUBKEY`
  (`option_env!`; `build.rs` re-runs when it changes). Without it `update_status` reports `enabled: false`,
  `update_check`/`update_install` refuse, and nothing contacts the network (dev, CI and e2e builds).
- Endpoint and Windows `installMode: passive` live in `plugins.updater` of `tauri.conf.json`. The release
  workflow (`.github/workflows/release.yml`, on `v*` tags) sets the version from the tag, turns on
  `createUpdaterArtifacts` and publishes the signed installers with `latest.json` via `tauri-action`.
- The UI (`components/Updates.tsx`) checks 20 s after start and every 6 h when `auto_update_check` is on, and
  on „Jetzt nach Updates suchen“. Installing always needs a click: editors are flushed (`lib/exit.ts`, shared
  with quit/close), the download reports `update://progress`, and `prepare_exit` closes the workspace and
  releases the single-instance lock right before the NSIS installer takes over and relaunches the app.

## Network (`network.rs` in core and shell)

- One decision per URL: `ProxyPlan` (modes none/system/manual/PAC) with a `NoProxy` matcher (host and subdomains,
  `*.domain`/`.domain`, globs such as `10.*`, IPs, CIDR, `<local>`, `*`). System mode reads the WinINet values of
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` on Windows (`parse_wininet` is a pure function
  of the registry strings) and the proxy environment variables elsewhere.
- `Prepared` resolves the settings once (CA file read and parsed, plan built) and applies them to any
  `reqwest::ClientBuilder`: connect timeout, `tls_certs_merge` (platform verifier plus the extra roots),
  `danger_accept_invalid_certs` when switched on, and a `Proxy::custom` that asks the plan (credentials in the proxy URL
  → Basic auth). The clients of the AI providers and the HTTP tool client live in `AiRuntime` and are rebuilt with it on every
  settings save, API-key or proxy-password change; the updater gets it through `configure_client` for check and
  download; the connection test builds one from unsaved settings and reports the proxy the plan chose.
- Git: `git_network` turns the plan for the remote URL into `http_proxy`/`https_proxy`/`no_proxy` (or removes the proxy
  variables and sets `NO_PROXY=*` for a direct remote), `http.sslCAInfo` (a bundle of the extra CA and the system CAs,
  not on Windows where Git uses schannel) and `http.sslVerify=false` when invalid certificates are accepted, all via
  `GIT_CONFIG_*`; the proxy password is redacted from git's output.
- PAC: the UI evaluates the script (`ui/src/lib/pac.ts`, standard helpers without DNS) in an iframe served by the
  `annalo-pac:` scheme with `sandbox="allow-scripts"` and its own CSP that allows `eval`; the app's CSP stays without
  `unsafe-eval`. Answers are stored per host in `network.pac_results` (`*` = LiteLLM host, used for other hosts; every AI provider host has its own) on
  save, test and start.
- The proxy password lives in the credential store (account `proxy-password`), never in the settings or exports.

## Preferences (`prefs.rs` in core, `ui/src/lib/{prefs,i18n,keymap,color}.ts`)

- Every preference struct is `#[serde(default)]`, choices are lenient enums (unknown values load as the default), and
  `Settings::normalize` clamps ranges on save/import. `parse_settings` migrates `open_daily_on_start` to
  `start.open = daily` for settings written before the start preferences.
- Core behavior: rounding/minimum and the default Leistungsart per Netzplan apply in `log_slash_command_in`, manual
  entries and `stop_timer`; the daily note title format and folder in `daily_note` (lookup stays by `daily_date`); trash
  retention in `purge_expired_trash`; snapshot interval and max versions in `versions.rs`; CATS separator and column
  presets in `export.rs`; the allowed tools filter the tool definitions and are enforced again before a tool runs; the
  monthly cost limit sums `ai_usage` since the first of the month (warning ≥ 80 %, refusal ≥ 100 % unless
  `override_limit`); quiet hours and the reminder toggles gate the desktop notifications.
- UI: `applyPrefs` runs on every settings change (store subscription) and sets `data-*` attributes (density, line
  width, fonts, reduced motion) used by `styles/prefs.css`, the accent tokens (`color.ts` derives
  `--accent`/`--accent-strong`/`--accent-soft`/`--accent-text` per mode with WCAG contrast ≥ 4.5 for text and white on
  buttons, ≥ 3 for UI accents), the webview zoom, the language (`i18n.ts`, typed German/English dictionary) and the
  keymap (`keymap.ts`: commands, defaults, recording from key events with AltGr protection, conflicts with other
  commands, editor keys and global shortcuts). The App's keydown handler looks commands up in the keymap.
- Color themes (`ui/src/lib/themes.ts`): `settings.theme` picks the mode (system/light/dark), `appearance.theme_light` /
  `theme_dark` the theme per mode (built-in id or `custom-…`, unknown ids show Annalo). A theme is nine main colors
  (`ThemeColors`: background, surface, text, muted, border, accent, success, warning, danger) plus optional tuning;
  `themeTokens` derives the full token set of `tokens.css` (hover/selection tints, strong borders, raised surfaces, soft
  status colors, shadows) and raises text/muted/status colors that miss 4.5:1 / 3:1. The active theme's CSS goes into
  one `<style id="annalo-theme">` (`:root:root`, empty for the Annalo themes, which are `tokens.css`), followed by the
  accent on top (`accent: "theme"` = the theme's own; high contrast keeps its accent). `data-theme` follows the
  theme's kind, `data-theme-id` names it; the splash remembers its background, text and accent. `themes.test.ts` checks
  the contrast of every built-in theme. Custom themes live in `appearance.custom_themes` (normalized in core: valid
  hex colors, unique `custom-N` ids, at most 40); the theme file is `{format: "annalo-theme", version: 1, name, dark,
  colors}` (`theme_export` / `theme_file_read`, checked by `prefs::parse_theme_file`).
- Mica (Windows 11) is off by default; `migrate_appearance_defaults` switches it off once for settings saved with the
  old default (and turns the old default accent `indigo` into `theme`). When on, sidebar and ribbon are the theme's
  sidebar color at 93 %.
- Dropdowns are `components/Select.tsx` (combobox + listbox in a portal) with the API of a controlled `<select>`; the
  e2e harness `app.select(selector, value)` opens it and clicks the option.
- Settings export writes `{format: "annalo-settings", version, settings}`; the import is validated against the
  current settings in the UI (`settingsio.ts`: same keys and types, unknown or mistyped fields skipped with a warning),
  previewed as a diff and saved through `settings_save`. `settings://changed` is emitted on every save so the UI
  follows changes made elsewhere.

## Notes model

- The editor (TipTap/ProseMirror) loads and saves Markdown via `@tiptap/markdown`. Custom nodes serialize to portable syntax:
  `[[Target#Heading|Alias]]` for links and `<time-entry id=… hours=… target=…>text</time-entry>` for booked time.
- YAML frontmatter is split off before editing and re-attached on save, so imported Obsidian notes keep their properties.
  The property editor under the title (`ui/src/lib/frontmatter.ts`) reads `key: value`, dates and lists; anything more complex
  stays a raw YAML row and is written back verbatim. Its edits go through the editor's save path (one writer per page).
- A `vorgang:` / `netzplan:` property links a page to the WBS (`pagework.rs`): the work card shows budget, ETC and recent
  bookings, and `/zeit` lines without a reference on that page book on it.
- Autosave runs 450 ms (Settings → Editor, 250–3000 ms) after the last change and on window blur. Renames rewrite `[[links]]` in every referencing page.
- Images live as files in `<data_dir>/attachments/`, named by the first 16 hex digits of their SHA-256 (same image, same file),
  and are embedded Obsidian-style as `![[name.png|300]]`. The shell serves them through the `annalo-asset:` URI scheme, which
  only answers plain file names inside that folder (no separators, `..` or hidden files; canonical path checked). Regular
  `![alt](https://…)` images load directly (CSP `img-src https:`). Vault import copies images by name; export writes the embedded ones to `attachments/`.
- Drawings (`drawings.rs`, `ui/src/editor/drawing.ts`, `DrawingEditor.tsx`) are Excalidraw scenes `<name>.excalidraw` in the same
  folder plus a rendered preview `<name>.excalidraw.svg`, embedded as `![[name.excalidraw]]` like the Obsidian Excalidraw plugin
  does; vault import/export and the mirror carry both files. Scene and preview are written atomically (temp file + rename) on
  every autosave (800 ms) and when the overlay closes. Excalidraw is a lazy chunk; its fonts are copied from the npm package to
  `ui/public/excalidraw-assets/` at build time (`ui/scripts/excalidraw-assets.mjs`, without the 13 MB CJK font Xiaolai) and
  `window.EXCALIDRAW_ASSET_PATH` points there. Excalidraw still lists its CDN (esm.sh) as a second font source; the CSP blocks
  it, so nothing is fetched from the network. CSP `connect-src 'self'` is needed because the SVG export `fetch`es those bundled
  fonts to inline them into the preview (the asset protocol allows `font-src data:` for that). Excalidraw would subset those
  fonts with WebAssembly in a worker; the CSP allows neither (`worker-src 'none'`, no `unsafe-eval`), so previews carry the
  whole font files (a few 10 kB each).
- Files (`attachments.rs`: `clean_name`, `store_file`, `import_file`; `ui/src/editor/fileEmbed.ts`, `files.tsx`): any other file
  is embedded as `![[Angebot.pdf]]`. `![[x]]` counts as a file when the name has an extension of 1–10 ASCII letters/digits with a
  letter, other than `md` (`attachments::file_extension`, mirrored in the UI's `fileExtension`), so `![[Notiz]]` and `![[Version 1.2]]`
  stay note embeds; such embeds are not page links (`notes::wiki_links`) and travel with vault import/export and the mirror.
  Files keep their sanitized name (last path component, reserved/control characters replaced, Windows device names suffixed,
  at most 150 bytes); a name taken by other bytes gets ` 2`, ` 3`, …, identical bytes reuse the file. Limit 100 MB
  (`MAX_FILE_BYTES`; images sent base64 stay at 50 MB).
  - Drop and paste: the main window has Tauri's native file-drop handler disabled (it swallows HTML5 drag and drop on Windows),
    so files dropped from Explorer/Finder arrive as `File` objects without a path. `AttachmentDrop` stores images as before
    (content-hash names) and any other file through `attachment_store`: the raw bytes are the IPC body (no base64), the name
    comes percent-encoded in the `x-annalo-name` header. „Datei einfügen“ uses the dialog plugin and `attachment_import`, which
    copies by path (streamed, temp file + rename) without loading the file into the webview.
  - A click on a chip opens the file with the default app (`attachment_open`); programs and scripts (`attachments::is_executable`)
    are only shown in the file manager, never started.
  - PDFs (`ui/src/lib/pdf.ts`, `PdfViewer.tsx`): pdf.js (`pdfjs-dist`, legacy build for older WebViews) is a lazy chunk loaded
    when a PDF card scrolls into view or the viewer opens. It runs without a web worker: the worker module is preloaded as
    `globalThis.pdfjsWorker`, so pdf.js uses its main-thread "fake worker" and never tries `new Worker` (CSP `worker-src 'none'`
    stays). The PDF's bytes come through IPC (`attachment_read`, a raw `ipc::Response`), not `fetch`, so `connect-src` needs no
    `annalo-asset:`; the asset protocol still serves `.pdf` as `application/pdf` and every non-image type as
    `application/octet-stream`. The standard fonts and the JavaScript image-decoder fallbacks are copied to `ui/public/pdfjs/` at
    build time (`ui/scripts/pdfjs-assets.mjs`); the WebAssembly decoders are left out (no `wasm-unsafe-eval`), as are the CJK CMaps.
    First pages are cached per name as canvases (up to 24).
- Templates are the pages below the top-level page „Vorlagen“ (`templates.rs`); placeholders are filled by `apply_template`.
  The daily note uses `settings.daily_template` when set.

## Typed properties and table/board views (`properties.rs`, `ui/src/lib/collection.ts`, `ui/src/views/collection/`)

The child pages of a page share a schema; the page itself can show them as a table or a board below its
text (like an inline database). Everything is plain frontmatter, so it syncs and exports as Markdown:

```yaml
# parent page
eigenschaften:
  status: {typ: auswahl, optionen: {Offen: grau, In Arbeit: blau, Fertig: grün}}
  themen: {typ: mehrfachauswahl, optionen: {UI: lila, API: orange}}
  aufwand: zahl
  fällig: datum
  wer: person
  erledigt: checkbox
  quelle: link
ansicht:
  typ: board                      # liste | tabelle | board; just `ansicht: tabelle` without settings
  sortierung: {feld: fällig, richtung: auf}          # auf | ab; feld `titel` is the page title
  filter: [{feld: status, op: ist nicht, wert: Fertig}, {feld: fällig, op: vor, wert: heute}]
  spalten: [titel, status, fällig]                   # column order (table)
  ausgeblendet: [quelle]                             # hidden columns
  breiten: {titel: 260, status: 140}                 # column widths in px
  gruppierung: status                                # board columns
  karten: [fällig, wer]                              # properties on board cards
  eingeklappt: [Fertig, ""]                          # collapsed board columns ("" = „Ohne Wert“)

# child page
status: In Arbeit
themen: [UI, API]
aufwand: 2.5
fällig: 2026-10-01
wer: Anna
erledigt: false
quelle: "[[Konzept]]"
```

- Types: `text`, `auswahl`, `mehrfachauswahl`, `zahl`, `datum`, `person`, `checkbox`, `link` (English names such as
  `select`, `number`, `date`, `url` are read too). A property is either its bare type or a flow map with `typ` and, for
  selects, `optionen` (name → color, or a plain list: colors then follow the order). Colors: `grau braun orange gelb grün
  blau lila rosa rot`. Property names follow the property editor's key rules (no colon, no leading YAML indicator), so
  they are written unquoted; option names and values are quoted only when YAML would read them differently.
- The YAML subset is the same in the core and the UI (`properties.rs` `parse_entries`/`parse_inline`, `ui/src/lib/yaml.ts`):
  scalars, flow lists and maps, indented block lists and maps. Writing is canonical (one line per property, flow style for
  settings) and round-trip tested in both; keys of `ansicht:` this version does not know are written back unchanged, all
  other frontmatter lines keep their original text. `ansicht` without settings is removed again for the plain list.
- Values are validated, never rewritten: a value that does not fit (`aufwand: viel`, an unknown option, `fällig: 30.02.`)
  is shown as written with a red wavy underline and the reason as tooltip; the core reports it as `Cell.error`. Numbers
  accept German input (`1,5`, `1.234,5`) and are stored as YAML numbers (`1.5`); dates are `YYYY-MM-DD` and shown German.
  Pages without a schema keep the free-text property editor; properties of the children that the schema does not know
  appear as text columns and can be typed from the column menu.
- Core: `Schema::from_markdown`, `validate`, `page_cells`, `matches` (filters, `heute` for dates) and
  `Database::page_collection` (children in sidebar order with frontmatter and typed cells), `page_schema` (the parent's
  schema for a page's property editor), `known_persons` (person values and `@Name` mentions, most used first) and
  `pages_with_property`. The workspace search reads `status:Offen` terms for properties a schema defines (`*`/`~` in the
  value: contains) and narrows the other terms' hits to those pages.
- Writes: an edit changes only that page's frontmatter (`ui/src/views/collection/write.ts`). A page shown in an editor
  pane is written through that editor (`registerFrontmatterOwner`, the same path as the property editor), so body and
  properties never overwrite each other; otherwise all editors are flushed, the page is read, only the block is replaced
  and saved, and `annalo:page-saved` updates open panes. The parent's own schema and view settings go through its
  editor. Card order in a board column is the folder's page order (`page_move`), i.e. the sidebar order.
- Table: its own scroll box (header and title column sticky, sideways scrolling in narrow panes); folders above 80 pages
  render only the visible rows plus a margin. WebKit anchors the scroll position when rows are swapped and ignores
  `overflow-anchor`, so the table restores the position it had before each commit. Keyboard: arrows, Tab, Home/End move
  between cells, Enter/F2 edits (Ctrl+Enter on a title opens the page in a new tab), typing starts editing, Delete clears, Escape leaves.

## Large workspaces

- `page_tree` groups the rows by parent in one `HashMap` pass and moves them into their nodes: O(n)
  instead of a filter per parent (O(n²) with a clone per node). A core test builds 5,000 pages in well
  under 200 ms in a debug build.
- The sidebar renders the visible rows flat (`aria-level`), each a memoized component; switching tabs
  re-renders only the old and the new active row. Folders of an imported vault and the „Journal“ start
  collapsed (`annalo.collapsed` in localStorage).

## Key algorithms

- **`/zeit` parser** (`zeit.rs`): tokenizer with straight and typographic quotes; the
  reference `NP/Vorgang` or a WBS element; durations in h/m/`h:mm`; options `#LA`, `@date`, `@hh:mm`.
  "Today" without a start time books the block as ending now; past days default to 08:00 local.
- **Budget / ETC** (`tracking.rs`): per Vorgang ETC = manual remaining estimate or
  `max(plan − booked, 0)`; Netzplan ETC = sum of its Vorgänge; EAC = booked + ETC.
  Levels: warning ≥ 75 %, critical ≥ 90 % or EAC > plan, exceeded when booked > plan.
- **CPM** (`netzplan.rs`): Kahn topological sort (cycle detection), forward pass FAZ/FEZ,
  backward pass SAZ/SEZ, GP = SAZ − FAZ, FP = min(FAZ of successors) − FEZ, and one walked critical path.
- **Transformations** (`ai/transform.rs`, `ai_transform`): inline AI and meeting summaries send only the instruction and the text (no retrieval, no tools), streamed like chat answers. The page's content and tags go to the router as context, so `#privat` pages stay local. The answer is inserted as Markdown through the editor's parser in one undoable transaction (`ui/src/editor/ai-insert.ts`).
- **Router** (`ai/router.rs`): transparent score (prompt/context length, code, reasoning
  cues, tool use, minus simple transformations) → local / standard / reasoning tier.
  Privacy markers override everything, including manual overrides.
- **RAG** (`ai/rag.rs`): exact cosine scan over stored embeddings fused with FTS5 BM25
  hits (reciprocal rank fusion), so exact identifiers like `NP-8801` are always found.
  Template pages (the „Vorlagen“ subtree) are never retrieved.
- **Citations** (`ai/rag.rs`, `ui/src/lib/citations.ts`, `ui/src/editor/reveal.ts`): `format_context` numbers the retrieved chunks `[1]`, `[2]` … with page title and heading path
  (derived from the headings of the page's earlier chunks) and asks the model to cite with `[n]`. `ai_chat` returns the chunks in that order (`page_id`, `block_id`, text, `heading`),
  so `[n]` is `context[n - 1]`. The UI turns `[n]` into chips (outside code and links); a click runs `revealText`: open the page, wait for its registered editor,
  search the chunk's first sentence, paragraph start or heading in the text blocks (wiki links by label), select it, scroll it to the middle and flash it (`.cite-flash` decoration).
- **Smart `/zeit`** (`ai/zeitguess.rs`, `zeit_suggest_ai`): a `/zeit` line whose first argument is a duration, on a page without `vorgang:`, is matched by the model. The prompt
  lists the bookable references (recently booked first, with their Leistungsarten and descriptions) and asks for strict JSON `{reference, leistungsart, confidence, reason}`.
  The answer is validated against the database (unknown references are rejected, unknown Leistungsarten dropped) and turned into a complete `/zeit` line, which the UI books only
  after the user confirmed it. The page's content and tags go to the router, so `#privat` pages stay local. Without an API token the booking error is shown with a hint.
- **Time summary** (`report.rs`): finished entries of local days `from..=to` grouped per Netzplan/Vorgang
  (hours, deduplicated descriptions) plus a total per day; offered to the assistant as the `time_summary` tool.
- **Streaming** (`ai/client.rs`): SSE decoder tolerant of split chunks and keep-alives;
  tool-call deltas are merged by index; `stream_options.include_usage` for exact counts,
  LiteLLM's `x-litellm-response-cost` header preferred for cost, the price table as fallback, 0 for local providers.

## AI providers (`ai/provider.rs`, `ai/availability.rs`, shell `AiRuntime`)

- `settings.providers`: `{id, name, kind, base_url, local, enabled, bypass_proxy, api_version, models}` in order of preference.
  Kinds: `litellm` (`<root>/v1/…`, bearer), `openai` (any OpenAI-compatible API, base URL with version, `…/chat/completions`,
  bearer), `azure` (`<endpoint>/openai/deployments/<deployment>/…?api-version=…`, `api-key` header, deployments listed by
  hand in `models` because an API key cannot list them) and `ollama` (`<root>/v1/…` for chat and embeddings, native
  `/api/tags`, `/api/version`, `/api/pull`, no key). Unknown kinds load as `openai`. `normalize` checks the addresses and gives
  every provider a unique `[a-z0-9-]` id.
- Keys: one credential per provider id (account `ai-provider-<id>`); the provider `litellm` keeps the account of the earlier
  single LiteLLM token (`litellm-api-key`), so nothing has to be re-entered. Keys of removed providers are deleted on save.
- Migration: settings without `providers` (1.2 and older) get one provider `litellm` from `litellm_base_url`, and the tiers and
  the embedding model point at it. `litellm_base_url` stays as a mirror of that provider's address (`Settings::sync_legacy`):
  when only the old field changed (older versions, scripts), it moves the provider; otherwise the provider's address wins.
- Tiers: `router.{local,standard,reasoning}_provider` + `_model`, `embedding_provider` + `embedding_model`; `""` = the first
  provider. `RouteDecision.provider` names the provider a request went to.
- `AiRuntime` holds one `AiClient` per enabled provider, each with its key, its price table (`PriceTable::from_rules`:
  rules for this provider, then general ones, plus free local runtimes) and its HTTP client: `bypass_proxy` uses the network
  settings with mode `none` (default for addresses on localhost), otherwise Settings → Netzwerk applies as for everything else.
- `Catalog`: the model list of every enabled provider, asked in parallel (10 s each), cached 5 minutes (failures 30 s).
  `resolve` replaces a model its provider does not list; `complete_routed` retries without tools/temperature when a model
  rejects them, on another model after a model error or 5xx, and on the next provider when one cannot be reached
  (`unreachable`: connect error or connect timeout), at most 5 attempts.
- Privacy: content with a private marker or with Datenschutz „Nur lokal“ (`local_required`) only goes to the local tier's
  configured model or to providers marked `local` (`private_allowed`), in `resolve` and in every fallback; when none is left the
  request is refused with a message instead of going to a cloud provider. The query embedding of a private question and the
  embeddings of pages carrying a private marker (`rag::pending_public_blocks`) are not sent to an embedding provider that is
  not local; with „Nur lokal“ such a provider does not index at all.
- Settings → KI (`AiProvidersSection.tsx`, `ProviderDialog.tsx`): the status of every provider (`ai_provider_models`, works for
  unsaved providers), an offer to add an Ollama found at `http://localhost:11434` (`ollama_detect`), the dialog's
  step-by-step test (`ai_provider_test`: reach, auth, chat, tools, embeddings; nothing is recorded as usage), `ollama_pull`
  with `ai://pull` progress events, the tier pickers and the price table.

## How the concept spec maps to this implementation

| Spec | Implementation | Notes |
|---|---|---|
| WinUI 3 **or** Tauri v2 (Rust core) | Tauri v2 | One Rust core shared by the desktop app, the CLI and the tests. Mica is set through `windowEffects` |
| Win2D, 120/240 Hz | WebView2 (GPU-composited) | Animations use compositor-friendly properties and run at the display refresh rate. There is no custom Win2D render loop |
| SQLite + FTS5 + vector extension | SQLite (bundled) + FTS5 + BLOB embeddings with exact cosine scan | `sqlite-vss` is deprecated and not bundled. An exact scan is fast enough for personal workspaces. `sqlite-vec` is the upgrade path for very large corpora |
| < 5 ms cold start | The core opens the DB, runs queries and exits in ~6 ms (release CLI, Linux) | The desktop app's cold start is dominated by WebView2 initialisation, typically around a few hundred ms. That has not been measured here |
| Win32 hooks for idle and active window | `GetLastInputInfo` and `GetForegroundWindow` sampled every 5 s | No global keyboard/mouse hooks: same result, far less invasive |
| Export SAP PS (CATS), Jira, JSON, CSV | `export.rs` | CATS as an upload file (CATSDB field names). Jira as payloads for `POST /rest/api/3/issue/{key}/worklog`. Nothing is uploaded automatically |
| Function calling: PowerShell, Git, REST | `ai/tools.rs` | Every system call needs explicit user approval. git is limited to read-only subcommands, and options that execute programs are rejected |
| Database views | Timesheet (week grid + entries), Projects (tables with budget, ETC, critical path) | Graphical network diagrams and graph views were dropped in favour of tables |

## Verification status

- `annalo-core`: unit and integration tests (including fake LiteLLM, Ollama, OpenAI-compatible and Azure servers); `cargo clippy` clean.
- End-to-end: `e2e/run.sh` builds the desktop app with the production frontend embedded and drives it through
  WebDriver (`tauri-driver` + WebKitWebDriver under Xvfb): notes, links, rename, tags, palette, tabs, find,
  daily notes, `/zeit`, timer, timesheet, export, projects, settings (LiteLLM URL, token, models), the assistant
  (streaming, tool calls, approvals, cancel), embeddings, vault import/export, and screenshots in both themes.
- The Windows build (WebView2, Credential Manager, Win32 idle probe) is built in CI on `windows-latest`.
- The macOS build (WKWebView, Keychain, CoreGraphics idle probe, menu bar, title bar overlay, Dock reopen) is
  linted and bundled in CI on `macos-14` (Apple Silicon); release builds add the Intel app by cross-compiling.
  macOS-only code paths (`cfg(target_os = "macos")`) are compiled only there. The menu bar (`appmenu.rs`) is
  compiled on every platform and installed only on macOS.
