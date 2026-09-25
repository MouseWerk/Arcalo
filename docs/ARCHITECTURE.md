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
| `activity` | Activity feed (v7): `at`, `kind`, optional `page_id`/`entry_id`/`netzplan_id`/`vorgang_nr`, `title`, `detail`, `amount` (characters, minutes or a count), `count` (merged edits), `people` |
| `focus_sessions` | Focus sessions (v7): Vorgang, goal, start, planned minutes (fractional), break, status (`running`/`done`/`aborted`, one running at a time), worked and booked minutes, the booked `entry_id`, `break_until` |
| `calendar_events` | Appointments of the calendar sources (v9), one row per instance: `source` (`outlook`, `ics:<id>`), `uid`, `instance` (original start of an instance of a series, `''` for single appointments; unique with source and uid), start/end (UTC), all-day, title, place, organizer, attendees and categories (JSON), optional text and meeting link, busy state, private flag |
| `calendar_marks` | What the user decided about an appointment (v9), by key `source\|uid\|instance`: `skip` („nicht buchen“), `note_page_id` (meeting note, set null on purge), `entry_id` (booked entry, set null on delete), subject and series of the booking for the WBS suggestion. Never touched by a sync |
| `calendar_sync` | Status of the last sync per source (v9): last success, last attempt, error, number of events |

Migrations are numbered and tracked through `PRAGMA user_version`; a database newer than
the binary is refused rather than modified.

Migration v2 converts the old block model: blocks are concatenated into
`pages.content`, then every page is re-indexed (chunks, links, tags).
Migration v9 adds the calendar tables above (no data changes).
Migration v8 only adds lookup indexes: page titles (`COLLATE NOCASE`), activity by `(kind, title)`
and by `entry_id`.

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
  Only a complete mirror is synced: a source that is not a folder with the mirror's `README.txt` marker (drive not
  connected, a foreign folder the mirror refused) is refused before git runs, and a folder vanishing while it is read is an
  error, never an empty listing. `mirror::replace_dir` swaps under `mirror::hold_swaps`, and the sync copies the mirror under
  the same lock; the shell also runs the mirror refresh of a backup under `git_lock` and passes the real mirror result to the
  sync (a failed mirror is written again by the sync, which then fails with its message).
  A fresh working tree adopts the remote history only when its `.gitattributes` carries the sync's marker. Adopting merges
  (`adopt_tree`, first sync of a new computer): the server's files stay, files only this computer has are added, a note
  both have with different text keeps the server's version and comes back as a conflict (base `None`), and notes only the
  server has come back with `mine: None`, so the shell creates them as pages (subpages below the page created for their
  folder). Mass-deletion guard (`mass_deletion`): a commit that deletes more than 10 tracked notes, or 3 and more than a
  fifth of them, is refused (staged changes reset) with an error starting with `GUARD_PREFIX`; `git_sync_status` reports
  `blocked_deletions` and Settings → Sicherung offers „Löschungen übertragen“ (`git_sync_now` with `allowDeletions`, after a
  confirmation). The other direction: `syncmerge::apply` does not trash pages when the server deleted that many at once
  (`Pulled.kept`, a warning toast; the next sync uploads them again). Git lock files older than the 120 s timeout are removed
  before a sync (`remove_stale_locks`, logged). A rejected push
  is merged with the remote when the histories are related (merge commit „Abgleich mit dem Server …“, file by file against
  the merge base; a fast-forward when this side has nothing new); unrelated histories go to `annalo-sync-<host>`. Files only
  the server changed take the server's state; a note changed on both sides differently keeps the server's version in the
  repository and comes back as a `RemoteChange` with `conflict` (base, mine, theirs); non-notes and deletions keep this
  side. The shell (`syncmerge.rs`) maps paths to pages with `vault::page_paths` (the export's naming, case-insensitive) and
  takes pulled notes over through `save_page_content` after a snapshot (new files become pages below the page of their
  folder, deletions go to the trash, attachments the repository has and the data folder lacks are copied). A note edited
  here since the mirror was written, or changed on both sides, becomes a conflict in the meta row `gitsync.conflicts`
  (page, path, base, theirs; mine is the page itself): the page is marked („Konflikt“ banner, dot in the tree), and until
  it is merged its path is held at the committed (server) version in the working tree (`SyncRequest::hold`), so nothing
  is overwritten on either side. The conflict view (tab kind `conflict`) shows `merge::merge3` of base, current content
  and theirs: blocks of whole lines (heading, list item with continuation lines, paragraph, fenced code, front matter,
  blank lines attached to the block before), matched by LCS against the base; one-sided and identical changes merge by
  themselves, different changes are conflicts decided per block (Meine / Andere / Beide / own text, `ui/src/lib/conflict.ts`).
  „Übernehmen“ (`git_conflict_resolve`) snapshots, saves, closes the conflict and syncs; `gitsync://pulled` tells the UI
  which editors to reload.
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
- **Portable mode** (`datadir::portable_data_dir`, shell `portable.rs`): a file `annalo-portable` next to the executable
  (or `data/.annalo-portable`) puts everything in `<exe dir>/data` (`ANNALO_EXE_DIR` stands in for the executable's folder in
  tests; `ANNALO_DATA_DIR` still wins); `location.json` is ignored and „Speicherort ändern“ refused. Nothing is written into
  the user profile: no autostart entry (`autostart_set` refuses, the switch explains why), no taskbar jump list, the
  webview profile in `data/webview`, and updates are downloaded from the release page instead of installed
  (`update_install` refuses; the UI shows „Neue Version herunterladen“). Secrets stay in the OS credential store, which
  belongs to the user and not to the stick: a portable copy names its entries `<account>@<12 hex of the data path's
  SHA-256>` (`datadir::secret_namespace`), so it never reads or overwrites an installed copy's secrets; they are entered
  again on another computer (an encrypted file on the stick would need a password prompt at every start). The release
  workflow publishes `Annalo_<version>_x64-portable.zip` (Annalo.exe, marker, LIESMICH.txt) next to the installer; it is
  not part of `latest.json`.
- **Data folder** (`datadir.rs`): `ANNALO_DATA_DIR` wins, then `<app config dir>/location.json`
  (`{"data_dir": "…"}`), then the app data folder. „Speicherort ändern…“ checkpoints the WAL
  (`wal_checkpoint(TRUNCATE)`) while holding the database lock, copies `workspace.db` (+ `-wal`/`-shm`),
  `attachments/`, `backups/`, the file trash `trash/`, `logs/` and the Git sync's working tree `git-sync/` (never over an
  existing workspace; `git-sync-export` is written anew by every sync), writes `location.json` and restarts.
  A data folder on a UNC path or inside OneDrive/Dropbox gets a persistent warning at start
  (`data_dir_status`, queried by the UI once it is ready, so the warning cannot be missed).
- **Single instance**: a second launch only focuses the running window (tauri-plugin-single-instance),
  so two processes never write one workspace. Test runs with `ANNALO_DATA_DIR` skip the check. A portable copy locks
  `data/.annalo.lock` instead (`portable::lock_instance`): the plugin is keyed by the app identifier, which the installed
  copy shares, so both may run side by side on their own data.
- **Transactions** (`Database::atomic`): savepoints that nest; when the outermost release (the commit) fails (disk full,
  I/O error, locked file), everything since the savepoint is rolled back and the error returned, so the connection never
  stays inside a transaction where later saves would look successful without being committed. An open transaction found at
  the start of an outermost `atomic` is rolled back.
- **Start-up failures** (shell `recovery.rs`): a data folder that cannot be created, a database that cannot be opened
  (damaged, not a database, locked, read-only storage: `Error::is_storage`) or one of a newer schema (`db::NEWER_SCHEMA`)
  show a native dialog instead of a panic without a window: „Letzte Sicherung wiederherstellen“ (only for a damaged
  database with backups in `<data dir>/backups`: `backup::restore_latest` keeps the broken files as
  `workspace.db.broken-<stamp>` and copies the newest backup, then restarts), „Ordner öffnen“, „Beenden“. Settings are read
  key by key (`parse_settings_lenient`, one level deep): a value of the wrong type falls back to its default, the raw JSON
  is kept in the meta row `settings.broken` and a notice names the keys. A data folder that opens but cannot be written, and
  network settings that cannot be applied, are start notices (`DataDirStatus.notice` with a `title`).
  The schema version is checked before the journal mode is set, so a newer database is not written at all. The dialog's
  text goes to the developer log; „Beenden“ and „Ordner öffnen“ end with exit code 1. Debug builds skip the dialog when
  `ANNALO_TEST_RECOVERY_CHOICE` (`restore`, `open`, `quit`) is set and take that answer once the event loop runs
  (e2e `60-startup-recovery`: the app is started without WebDriver, then again under it on the restored folder).
- **History**: activity, AI usage and finished focus sessions older than 400 days are pruned on start
  (`prune_history`); purging a page clears the texts of its activity rows (title, task text, mentions).
- **Close to tray / quit**: with `close_to_tray` the UI flushes its editors and calls `window_hide`;
  „Beenden“ in the tray emits `app://quit-requested`, the UI flushes (asking if that fails) and calls
  `app_quit`. Without it the UI destroys the main window and the shell exits.

## Activity, focus sessions and presentations (`feed.rs`, `focus.rs`; shell `feed.rs`, `focus.rs`, `present.rs`)

- **Activity feed**: the store writes events itself – `create_page` (`page_created`), `save_page_content_at`
  (`page_edited`, merged per page and UTC hour into one row with `count` edits and `amount` characters changed = the longer
  differing middle after the common prefix/suffix; a page created within the hour takes its first edits), tasks added and checked
  off (parsed from the old and new Markdown; an event of the hour whose text is gone takes the new text, so typing a task gives one
  event; unchecking within the hour removes the check-off), `insert_time_entry`/`stop_timer` (`entry_created`), `update_time_entry`
  (`entry_changed`) and `set_entry_status` (one `entry_released`/`entry_exported` event per call). The shell adds files (once per
  name), backups and Git syncs. `@name` mentions (not in code or `/zeit` lines) and `owner:`/`verantwortlich:`/`person:` go to
  `people`; a page's `vorgang:` to `netzplan_id`/`vorgang_nr`. Migration v7 stores `feed.since`; `feed::backfill` derives the
  history before it once at start (pages, edit sessions and task changes between version snapshots, time entries, attachment
  mtimes) and skips what the journal already has. `feed::list` filters by range, kinds, project/Netzplan/Vorgang, person and search
  words (all must match); `feed::summary` counts pages, tasks, booked minutes (from `time_entries`) and focus sessions. The assistant's
  read-only `activity_log` tool (`describe_days`) lists the events of local days; settings from before it allow it once
  (`migrate_activity_tool`).
- **Focus sessions**: `focus::start` resolves the reference like `/zeit`; the UI counts down and calls `focus_finish` at the end,
  `focus::state` completes a session that ran out while the app was closed (also every 30 s in the shell's reminder loop). A
  completed session books `max(1, round(planned))` minutes, an aborted one the minutes so far when asked. The entry is a draft
  `timer` entry on the Vorgang with the goal as description; a later session of the same local day with the same Vorgang and goal
  extends it: the session's minutes are added to the entry's current duration (a correction by hand stays; rounding applies),
  the start stays and the end follows. While a session is in its work phase the shell holds desktop
  notifications back (`focus::hold` in `desktop::notify`) and the UI holds non-error toasts and budget alerts (`heldToasts`); both
  are summed up in the message after the session. The end is announced as a silent notification „Pause“. `focus::write_daily_line`
  writes or replaces „Fokus heute: …“ in the daily note, on demand or once after the reminder time (default 18:00).
- **Presentation** (`ui/src/lib/slides.ts`, `components/Presentation.tsx`): slides are split at horizontal rules outside code
  fences (`---` directly under text is a setext heading and does not split), without rules at level-1 headings. Speaker notes are
  `> [!notiz]` callouts (also `[!notes]`, `[!speaker]`, `[!sprecher]`) and paragraphs starting with `Notiz:`. A slide is rendered
  with `marked` + DOMPurify into a 1600 px wide stage with the box's aspect, scaled to the box; content that does not fit is scaled
  down further (binary search, never cut). Embeds become placeholders filled after rendering (images, drawing previews, PDF first
  pages, file chips). `presentation_begin`/`presentation_end` switch the main window to full screen and back; with two monitors
  `presenter_open` moves the slides to the other monitor and opens the presenter window (`index.html#presenter`, capability
  `presenter`), which mirrors the deck through `presentation://state` and steers it with `presentation://nav`.
  Code blocks (slides and speaker notes) are highlighted like the editor's (`languages::highlightCodeBlocks`, lazy grammars
  loaded first); the Beamer look sets light `--code-*` tokens.

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

## Calendar sync (`calsync/` in core, `calsync.rs` in the shell, `ui/src/views/CalendarView.tsx`)

- Sources (Settings → Kalender, `settings.calendar`): Outlook Classic (Windows) and ICS subscriptions or files. A
  subscription's address may carry a secret token: it lives in the credential store (account `calendar-ics-<id>`,
  `SecretStore::calendar`), the settings keep only id, name, kind, file path, color and the switch. The source list is
  saved by its own commands (`calendar_source_add/update/remove`); `settings_save` keeps the stored list like it keeps
  the dashboard, and re-syncs when Outlook is switched on or the window or privacy rules change.
- Outlook (`calsync/outlook.rs`, `outlook.ps1`): the script is embedded with `include_str!` (so every build carries
  it), written to `<data>/scripts/outlook-calendar.ps1` when it differs and run with `powershell.exe -NoProfile
  -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File …` (no console window, 120 s timeout, off the async
  runtime) as the user: `New-Object -ComObject Outlook.Application` → `GetNamespace("MAPI").GetDefaultFolder(9)` →
  `Items.Sort("[Start]")`, `IncludeRecurrences = $true`, `Restrict("[Start] < 'to' AND [End] > 'from'")`. Outlook
  reads Restrict dates in the user's regional format, so the shell formats them from `HKCU\Control Panel\International`
  (`sShortDate`, `sShortTime`, AM/PM; `restrict_value` is a tested pure function) and the script checks every item
  against the real range again; if Restrict fails or finds nothing it walks the sorted items. Dates are written with the
  invariant culture (`StartUTC` + `Z`, local start/end for all-day), the output is one line of JSON in ASCII (other
  characters as `\uXXXX`, the script file itself is ASCII: Windows PowerShell reads BOM-less scripts as ANSI). Private
  appointments (sensitivity private/confidential) lose everything but their time unless allowed; the text is read only
  for „Termintext übernehmen“ (kept) or „Besprechungslinks“ (only `https://` addresses leave the script, the core keeps
  one meeting link). Declined and cancelled meetings are left out. Errors come back as codes (`not_installed`,
  `new_outlook`, `server_exec`, `constrained`, `folder`, `com`) and become German messages that point to ICS where
  COM cannot work. For development and tests `ANNALO_OUTLOOK_FIXTURE` (a JSON file) replaces the script, only with
  `ANNALO_TEST_FIXTURES=1`.
- ICS (`calsync/ics.rs`): line unfolding on the bytes (a fold inside a UTF-8 character heals), parameters with quotes,
  TEXT escapes, lenient components. Zones (`calsync/tz.rs`): IANA names (also behind a `/mozilla.org/…/` path), the
  Windows ids Outlook writes (CLDR `windowsZones` table, e.g. `W. Europe Standard Time` → `Europe/Berlin`), fixed
  offsets, and for anything else the file's `VTIMEZONE` (STANDARD/DAYLIGHT rules expanded to transitions 1970–2100;
  Outlook's 1601 start is moved). Series are expanded with the `rrule` crate in wall-clock time of their zone (a
  meeting at 10:00 stays at 10:00 across DST; `UNTIL` in UTC is converted to wall time first), then placed in UTC;
  `RDATE`, `EXDATE` (date-times and whole days), `RECURRENCE-ID` overrides (moved or `STATUS:CANCELLED`) and overrides
  whose original lies outside the expansion are handled. Floating times and all-day dates use the local zone; all-day
  events are stored as local midnights with an exclusive end. Subscriptions are fetched with the tools HTTP client (proxy,
  CA and timeout of Settings → Netzwerk, „Anwenden auf“ tools), `webcal://` becomes `https://`, at most 30 MB, and
  errors never contain the address.
- Sync (`calsync.rs`): a scheduler task (first run 20 s after start, `ANNALO_CALENDAR_DELAY_SECS` for tests, then every
  minute) syncs each active source whose last attempt is older than the interval (default 15 min); „Jetzt
  synchronisieren“ runs it at once. One sync per source at a time. The source is read and parsed without any database
  lock; then one transaction replaces the source's events that overlap the window (default 30 days back, 90 ahead)
  and records the status. `calendar://syncing`/`calendar://synced` tell the UI.
- Privacy: appointments are local data. No assistant tool reads them (a core test checks the tool definitions).
- UI: `lib/agenda.ts` (tested) has the ranges (day, work week from the configured workdays, week, 6-week month, 14-day
  list), the overlap layout (groups of overlapping items, first free column, a minimum height), month cells with
  „+n weitere“, the booking prefill and the booked detection (linked entry, or a finished entry overlapping the
  meeting that carries its subject). Booking opens the timesheet's `EntryDialog` with a prefill and links the new
  entry (`calendar_link_entry`); the next booking of the same series or subject gets that WBS
  (`calendar_wbs_hint`). `calendar_meeting_note` creates the note below „Besprechungen“ (frontmatter with date, time,
  place, organizer, attendees and the remembered `vorgang:`), from the template „Besprechung“ when there is one.

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
- Layout blocks (`ui/src/editor/blocks.ts`, round-trip cases in `roundtrip.test.ts`), all plain Markdown that other tools show
  sensibly: foldable callouts are Obsidian's `> [!note]- Titel` (collapsed) / `> [!note]+ Titel` (expanded), the chevron rewrites
  the marker; columns are ordinary Markdown between HTML comments on their own lines (`<!-- spalten -->`, `<!-- spalte -->`
  between columns, `<!-- /spalten -->`; nestable, markers inside code fences ignored), which Obsidian and GitHub hide, so the
  columns read one after another there; the table of contents is a `[TOC]` line (Typora/MkDocs marker), rendered live from the
  headings; footnotes are `[^1]` / `[^1]: Text` (continuation lines indented by four spaces), numbered by first reference, a
  definition directly under another stays without blank line. Vault import/export and the mirror copy the text unchanged.
- Smart paste (`ui/src/editor/paste.ts` classifiers, `smartPaste.ts`): TSV or an HTML `<table>` becomes a table (first row
  header), Teams chat copies (`[10:32] Name`, `[Datum Zeit] Name: Text`, `Name 10:32`, name line + time line) a list
  `**Name** (10:32): Text` (the time is shown muted), a stack trace (Java, .NET, Python, JavaScript) or a log with timestamps
  and levels a code block, a lone URL on an empty selection a link whose text becomes the page title (`link_title`:
  `annalo_core::linktitle`, the tools HTTP client with the network settings, http/https only, 4 s, at most 256 KB, `og:title`
  before `<title>`, the URL when there is none). A hint „Als Text einfügen“ undoes it into a plain paste; Ctrl+Shift+V and
  pastes copied inside the editor are never converted, files stay with `AttachmentDrop`.
- „Als HTML-Datei teilen…“ (`ui/src/editor/shareHtml.ts`, `ui/src/lib/htmlExport.ts`): the page (optionally with its
  subpages and a table of contents) is rendered by a headless editor with the same schema, then made static: images and
  drawing previews as data URIs, attachments up to 1 MB as embedded download links and larger ones by name (both also
  listed under „Anhänge“), `[[links]]` as anchors when the target page is in the file and as text otherwise, callouts
  (foldable ones as `<details>`), footnotes at the end with back-links, highlighted code. Inline CSS with the reading
  typography (light, dark via `prefers-color-scheme`, print rules), system fonts, a CSP meta that allows only `data:`
  images, so the file loads nothing from elsewhere; web images become links. `html_file_write` only writes `.html`/`.htm`.
- YAML frontmatter is split off before editing and re-attached on save, so imported Obsidian notes keep their properties.
  The property editor under the title (`ui/src/lib/frontmatter.ts`) reads `key: value`, dates and lists; anything more complex
  stays a raw YAML row and is written back verbatim. Its edits go through the editor's save path (one writer per page).
- A `vorgang:` / `netzplan:` property links a page to the WBS (`pagework.rs`): the work card shows budget, ETC and recent
  bookings, and `/zeit` lines without a reference on that page book on it.
- Autosave runs 450 ms (Settings → Editor, 250–3000 ms) after the last change and on window blur. Renames rewrite `[[links]]` in every referencing page
  (`replace_link_target`; fenced and inline code stay as written, like `wiki_links` ignores them).
- Titles (`notes::clean_title`, applied by `create_page`, `rename_page`, `rename_page_linked` and the shell's `unique_title`):
  `[` `]` become `(` `)`, `|` `#` `^` their full-width forms `｜` `＃` `＾`, line breaks spaces, so every title can be linked. The
  title field applies the same rule while typing (`cleanTitleChars` in `ui/src/lib/links.ts`) and says so under the title.
- Images live as files in `<data_dir>/attachments/`, named by the first 16 hex digits of their SHA-256 (same image, same file),
  and are embedded Obsidian-style as `![[name.png|300]]`. The shell serves them through the `annalo-asset:` URI scheme, which
  only answers plain file names inside that folder (no separators, `..` or hidden files; canonical path checked). Regular
  `![alt](https://…)` images load directly (CSP `img-src https:`). Vault import copies images by name; export writes every
  referenced file (`attachment_manager::export_files`: embeds, `[[file.ext]]` and `[text](file)` links, drawing previews) to `attachments/`.
- Vault import (`vault::plan_import` + `apply_import`, shell `vault_import`): the files are read and attachments copied
  off the main thread without the database lock (`vault://progress` events every 25 files, `vault_import_cancel` stops at
  the next file), then the pages are created in one transaction. Notes that are not UTF-8 are read as Windows-1252, notes
  above 2 MB are cut with a note (both listed in `ImportReport.warnings`). An attachment whose name is taken by other bytes
  is stored under a free name (`import_file`) and the embeds of the notes in its folder (the parent of an attachment-only
  folder like `assets/`) are rewritten.
- Drawings (`drawings.rs`, `ui/src/editor/drawing.ts`, `DrawingEditor.tsx`) are Excalidraw scenes `<name>.excalidraw` in the same
  folder plus a rendered preview `<name>.excalidraw.svg`, embedded as `![[name.excalidraw]]` like the Obsidian Excalidraw plugin
  does; vault import/export and the mirror carry both files. Scene and preview are written atomically (temp file + rename) on
  every autosave (800 ms) and when the overlay closes. Excalidraw is a lazy chunk; its fonts are copied from the npm package to
  `ui/public/excalidraw-assets/` at build time (`ui/scripts/excalidraw-assets.mjs`, without the 13 MB CJK font Xiaolai) and
  `window.EXCALIDRAW_ASSET_PATH` points there. Excalidraw still lists its CDN (esm.sh) as a second font source; the CSP blocks
  it, so nothing is fetched from the network. CSP `connect-src 'self'` is needed because the SVG export `fetch`es those bundled
  fonts to inline them into the preview (the asset protocol allows `font-src data:` for that). Excalidraw would subset those
  fonts with WebAssembly in a worker; the CSP allows neither (`worker-src` names only pdf.js's worker file, no `unsafe-eval`), so previews carry the
  whole font files (a few 10 kB each).
- Files (`attachments.rs`: `clean_name`, `store_file`, `import_file`; `ui/src/editor/fileEmbed.ts`, `files.tsx`): any other file
  is embedded as `![[Angebot.pdf]]`. `![[x]]` counts as a file when the name has an extension of 1–10 ASCII letters/digits with a
  letter, other than `md` (`attachments::file_extension`, mirrored in the UI's `fileExtension`), so `![[Notiz]]` and `![[Version 1.2]]`
  stay note embeds; such embeds are not page links (`notes::wiki_links`) and travel with vault import/export and the mirror.
  A plain `[[Angebot.pdf]]` link (`attachment_manager::is_file_link`, UI `isFileLinkTarget`) is a file link unless a page has
  that title: it is never an unresolved link (`unresolved_links`), the editor shows it with the file's icon (missing files
  marked) and opens it like the embed, the links panel lists it under „Anhänge“, the hover preview skips it and the HTML
  export carries it like a file embed.
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
    when a PDF card scrolls into view or the viewer opens. Parsing runs in one shared Web Worker: `scripts/pdfjs-assets.mjs`
    copies the worker to `public/pdfjs/pdf.worker.js` (a `.js` name, so every WebView serves it as JavaScript), and the CSP
    allows exactly that file (`worker-src tauri://localhost/pdfjs/pdf.worker.js http://tauri.localhost/pdfjs/pdf.worker.js`);
    Excalidraw's subsetting worker stays refused as before. Should the worker not start, pdf.js parses in the main thread by
    itself. The PDF's bytes come through IPC (`attachment_read`, a raw `ipc::Response`), not `fetch`; the asset protocol
    still serves `.pdf` as `application/pdf` and every non-image type as `application/octet-stream`. The standard fonts,
    the CMaps (`cmaps/*.bcmap`, `cMapPacked`, for Chinese/Japanese/Korean text in fonts that are not embedded) and the
    JavaScript image-decoder fallbacks are copied to `ui/public/pdfjs/` at build time; the WebAssembly decoders are left out
    (no `wasm-unsafe-eval`). First pages are cached per name as canvases (up to 24).
  - Viewer: every page is a sized placeholder (first page's size, the real sizes follow in the background); pages within
    one viewport height render (a render is cancelled when its page leaves that band), pages beyond three viewport heights
    release canvas, text layer and the page's parsed resources. A pdf.js `TextLayer` over each rendered page (CSS after
    `pdf_viewer.css`, `--total-scale-factor` on the page) makes text selectable; search (`lib/pdfsearch.ts`) numbers every
    hit by page, text item and match and wraps them in `.highlight` spans (current one `.selected`), with next/previous.
    The viewer opens as an overlay from a note or in a tab (`kind: "pdf"`, file name in `tag`): PDFs dropped on the tab bar
    or on a pane without a note are stored and opened there.
- Attachment manager (`attachment_manager.rs`, `views/AttachmentsView.tsx`, tab kind `attachments`): lists the attachments
  folder (drawing previews with their scene) with kind, size, modification time and usage. Usage is one query over pages
  whose content contains `[[` or `](` (trashed pages included and marked), parsed for `![[name]]`, `![[name|…]]`,
  `![[name#page=N]]`, links to files `[[name.ext]]` (a name with a file extension) and `![alt](path/name)` / `[text](path/name)`
  to local files (percent-decoded), matched case-insensitively. Rename checks the new name
  like `clean_name` (same extension, drawings keep `.excalidraw`, no collision in any case), renames the file (a drawing
  with its preview) and rewrites every reference (folder prefix, anchor and alias kept; image links re-encoded) in every
  page through `save_page_content` after `store_version`, all or nothing (files are renamed back on failure); editors
  reload via `data://pages`. Delete moves files to `<data dir>/trash/files/<timestamp>/` (restore, purge, expiry with the
  page trash retention; listed in the trash view); „Unbenutzte aufräumen“ offers files no page (not even a trashed one) uses.
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
- Database commands are `#[tauri::command(async)]` (or `spawn_blocking`): they run off the main thread,
  which handles the window (`set_title`, drag, focus) and never waits for the database. Pure reads
  (`page_get`, `workspace_tree`, lists, search, budgets) use a second, read-only connection
  (`Database::open_read_only`, `AppState::reader`): in WAL mode it sees the last committed state and
  neither waits for a save nor holds one up. The two locks are never held together. Backups
  (`VACUUM INTO`), the Markdown mirror and the vault export open a read-only connection of their own:
  the mirror and the export read the tree, all contents (one `SELECT id, content`) and the time entries
  in one read transaction (`MirrorSnapshot`, `VaultSnapshot`), then write the files without any
  database lock. The scheduler's first backup check runs 3 minutes after the start
  (`ANNALO_BACKUP_DELAY_SECS` for tests).
- `page_save` returns `SavedPage` (tags, unresolved links, `updated_at`), not the page: the editor has
  the content and a save does not change backlinks. A save writes only what changed: chunk rows whose
  text is still on the page keep their row, search entry and embedding; links and tags are diffed.
  Unresolved links are found with one indexed query (`idx_pages_title`, `title COLLATE NOCASE IN (…)`)
  plus one pass over all titles only for non-ASCII targets. `latest_version` reads only the time, and
  parsed settings are cached by their JSON (`Database::settings_cache`).
- Batch reads for views that listed per Netzplan: `netzplan_overview` (budget and schedule of every
  Netzplan; booked hours in one grouped query, Vorgänge in two), `budgets_all` (dashboard, `/zeit`
  completion) and `suggestion_facts` (counts of open, overdue and due tasks and the most critical
  budget, for the assistant's suggestions). `page_collection` sends each child's frontmatter only (the
  views derive the cells). Filters of `list_time_entries` and `list_tasks` are built from the set
  fields so SQLite uses the indexes; `time_entries` without a range returns the last 366 days.

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
  rejects them (also vLLM's 400 without `--enable-auto-tool-choice`; remembered per model for the session), waits out a
  short LiteLLM cooldown (`cooldown_wait`: 429 „No deployments available … Try again in N seconds“, N ≤ 10, twice per model,
  a `waiting` stream event, cancellable) before moving on, on another model after a model error or 5xx, and on the next
  provider when one cannot be reached (`unreachable`: connect error or connect timeout), at most 6 attempts. A fallback to
  the local tier's model or a local provider adds a visible note (`weaker_fallback_note`).
- Embeddings (`ai::capability`): only a model the provider reports as an embedding model (LiteLLM `/model/info`,
  `model_info.mode`) or, when it does not say, whose name looks like one (embed, bge, e5, gte, nomic, minilm, mxbai) is asked;
  a chat model never is (on LiteLLM its 404 counts against the model and puts it into cooldown for the chat right after).
  A lasting failure (4xx, not found) is remembered per provider and model until the settings change; the query then uses
  keyword search only, noted once in the answer and in Settings → KI (`ai_embedding_status`). The assistant's request
  carries one system message (prompt, open page, sources), as the inline AI's does.
- Privacy: content with a private marker or with Datenschutz „Nur lokal“ (`local_required`) only goes to the local tier's
  configured model or to providers marked `local` (`private_allowed`), in `resolve` and in every fallback; when none is left the
  request is refused with a message instead of going to a cloud provider. The query embedding of a private question and the
  embeddings of pages carrying a private marker (`rag::pending_public_blocks`) are not sent to an embedding provider that is
  not local; with „Nur lokal“ such a provider does not index at all.
- Private pages (`ai::privacy`): a page is private when a marker is among its tags (front matter `tags:` included) or in its
  text. Every request carries next to a page's content its tags as `#tag` (`privacy::tag_text`: the open page in `ai_chat`,
  `ai_transform`, `zeit_suggest_ai`); retrieved chunks of a private page add a marker line; a workspace tool result
  (`search_workspace`, `list_tasks`, `activity_log`) with text of a private page gets `[Enthält vertrauliche Inhalte: <marker>]`
  appended (`mark_tool_result`), so the follow-up turn that carries it routes to the local model. `pending_public_blocks`
  skips every block of a page whose text contains a marker. Embedding indexing checks the monthly cost limit (not for local
  providers) and records its usage (`metrics::embedding_usage`, estimated tokens).
- Timeouts and broken answers (`ai/client.rs`): a chat must start answering within `first_byte_timeout` (120 s; 60 s in the
  provider test) and send something every 180 s; model lists and version checks use the network timeout, embeddings four
  times that (at least 2 min). A 200 answer that is not `text/event-stream` is refused (a WLAN login page) unless it is a
  complete JSON chat answer (backends that ignore `stream`); an unreadable event is skipped with a warning (logged with
  provider and model); a stream that ends without `[DONE]` or a finish reason keeps what arrived, marked „Antwort
  unvollständig“ (`finish_reason: incomplete`); an empty answer is an error and not billed. Tool-call indexes above 63 are
  ignored. Network settings that cannot be applied (a missing CA file) leave no client: requests fail with „Netzwerkeinstellungen
  ungültig: …“ instead of bypassing proxy and certificates.
- Errors (`error.rs`): every message is German and complete (`Error::State` shows its text only, so re-wrapping adds no
  prefix); I/O and SQLite errors name the cause (`io_text`, disk full, read-only, locked, damaged). File operations attach
  the path (`Error::File { path, dir, source }` through `IoAt::at` / `Error::with_path`, `error::copy_file` names the side
  that failed, `attachments::existing` a missing attachment): „Datei nicht gefunden: …“, „Keine Berechtigung für den Ordner
  …“; a file whose folder is missing names that folder. The developer log gets `Error::detail` (plus the OS text), toasts
  shorten long paths in the middle (`shortenPaths` in `api.ts`, full text as tooltip). Request errors keep
  reqwest's cause chain and name proxy, certificate, timeout or an interrupted answer (`http_text`, read by
  `ui/src/lib/aierror.ts`).
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
| Function calling: PowerShell, Git, REST | `ai/tools.rs` | Every system call needs explicit user approval and runs off the async runtime with a 120 s timeout. git is limited to read-only subcommands with a neutral configuration (no system/global config, pager, hooks, fsmonitor, external diff or global attributes; `--no-textconv --no-ext-diff`); a repository whose own config names textconv/diff drivers, filters, fsmonitor, aliases or includes is refused |
| Database views | Timesheet (week grid + entries), Projects (tables with budget, ETC, critical path) | Graphical network diagrams and graph views were dropped in favour of tables |

## Verification status

- `annalo-core`: unit and integration tests (including fake LiteLLM, Ollama, OpenAI-compatible and Azure servers); `cargo clippy` clean.
- End-to-end: `e2e/run.sh` builds the desktop app with the production frontend embedded and drives it through
  WebDriver (`tauri-driver` + WebKitWebDriver under Xvfb): notes, links, rename, tags, palette, tabs, find,
  daily notes, `/zeit`, timer, timesheet, export, projects, settings (LiteLLM URL, token, models), the assistant
  (streaming, tool calls, approvals, cancel), embeddings, vault import/export, and screenshots in both themes.
- The Windows build (WebView2, Credential Manager, Win32 idle probe) is built in CI on `windows-latest`.
- Outlook Classic: the script's output parsing, the Restrict date format and the privacy rules are unit-tested and the
  e2e tests run the Outlook source from a fixture; the COM script itself needs a Windows computer with Outlook Classic.
- The macOS build (WKWebView, Keychain, CoreGraphics idle probe, menu bar, title bar overlay, Dock reopen) is
  linted and bundled in CI on `macos-14` (Apple Silicon); release builds add the Intel app by cross-compiling.
  macOS-only code paths (`cfg(target_os = "macos")`) are compiled only there. The menu bar (`appmenu.rs`) is
  compiled on every platform and installed only on macOS.
