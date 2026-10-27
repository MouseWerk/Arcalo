# 1.15 plan: weekly review, search by meaning, no "Annalo" left

Order: the two features first (in parallel), then the rename on top of them (it touches almost every file,
so it goes last to avoid conflicts).

## Feature: Wochenrückblick (weekly review)

Like the daily review, for a week (Mon–Sun, the user's targets per weekday, holidays and absences): booked
time against target per day and in total, done and open tasks, meetings, pages worked on, focus blocks;
optional AI summary (respects #privat and the provider routing). „Als Wochenbericht speichern“ writes a page
(template-able, in the year/month folders) that can be shared or exported. Entry points: start page widget or
action, palette, Kalender week header, the daily review. Previous/next week, works without time tracking
(then no time part) and without AI.

## Feature: Suche nach Bedeutung (semantic search)

Search finds notes without the exact words („Angebot Müller“ -> „Kostenvoranschlag für Kunde Müller“), using
the embeddings the assistant already builds; local by default when an Ollama embedding model is available,
otherwise the configured provider only if allowed (#privat pages are never sent to a cloud provider). Results
mix exact and meaning matches with a clear label, in the search sidebar and the quick switcher/palette. Index
builds in the background, incremental, with progress and a switch in Settings; works offline with exact search
only.


Owner decision: every remaining "Annalo"/"annalo" goes, with a migration helper so existing installs keep
their data, credentials and settings. New app identifier: `de.mousewerk.arcalo` (was `app.annalo.desktop`).
Start after the 1.14.1 hotfix is merged (the update code is shared).

Inventory (2026-10-08): about 2250 occurrences in 406 files of the app, 127 in 38 files of the website. The
1.7 rename and the 1.13 branding pass already covered product name, installer folder, Start menu, autostart,
backups, portable markers, log names and the Git author (see docs/ARCHITECTURE.md "Names kept from Annalo").

## Identity (needs the migration helper)

| What | Today | Migration |
|---|---|---|
| Tauri identifier | `app.annalo.desktop` | Before the WebView exists: move or copy data, config, local (EBWebView), cache and WebKit folders to `de.mousewerk.arcalo`; respect `location.json`; keep the old folder until verified; marker for idempotence; rollback must still find the backup |
| Credential service | `Annalo` (all secrets incl. `db-key`, `db-key-next`, `app-lock-pin`) | Copy each account to `Arcalo`, read back and compare, keep reading `Annalo` as fallback; delete old entries only in a later release |
| Binary | `annalo` / `annalo.exe` | NSIS hooks: Run value path, uninstall `MainBinaryName`, delete old exe, re-stamp AUMID on shortcuts; Linux symlink `/usr/bin/annalo`; CLI alias |
| Markers | `.annalo-update`, `.annalo-health`, `data/.annalo.lock`, `.annalo-move-tmp` | Read both names during the transition |
| Backup destinations | host folder fallback `annalo`, probes `.annalo-probe-*` | Scan both folders |
| macOS MDM domain | `app.annalo.desktop.plist` | Read both, new first |
| MSIX | `ExcludedDirectory …\app.annalo.desktop` | List both folders |
| Git sync | `annalo-workspace.db`, marker `# Annalo Git-Synchronisierung`, `annalo-sync-` | Recognise both until all computers are updated |
| Formats | `annalo-settings`, `annalo-theme`, `annalo-dashboard`, `annalo-mail://`, theme ids `annalo-light/-dark`, ICS UIDs `annalo-…` | Write new ids, read old ones permanently; settings step for theme ids; keep or map ICS UIDs |
| Env vars | `ANNALO_DATA_DIR`, `ANNALO_SECRET_STORE`, `ANNALO_LOCALE`, `ANNALO_SHARED_SETTINGS_DIR`, `ANNALO_STARTUP`, `ANNALO_DB` | `ARCALO_*` first, `ANNALO_*` fallback; test-only vars renamed outright |
| localStorage | about 40 `annalo.*` keys | Copy to `arcalo.*` once on UI boot |

Expected one-time effects: macOS asks again for microphone and notifications; pinned taskbar shortcuts may
need re-pinning; admins re-issue MDM profiles.

## Code-level (rename outright)

Crates `annalo-core`, `annalo-cli`, `annalo` / `annalo_lib` (keep old tracing targets as aliases in the log
filter), npm package names, DOM events `annalo:*`, window globals `__annalo*`, drag MIME types, URI schemes
`annalo-asset:` / `annalo-pac:` and header `x-annalo-name`, thread names, CI artifact `annalo-macos`,
`ANNALO_UPDATER_PUBKEY` (CI and code together), e2e `ANNALO_APP`, brand files `docs/brand/annalo-*`,
`config/annalo.config.example.json`. Visible leftovers: dashboard export file name `annalo-….dashboard.json`
and `app: "annalo"`; the branding guard must also check lower-case `annalo` in UI literals.

## Keep on purpose

Redirects `MouseWerk/Annalo` -> `Arcalo` (never create a new repo with that name), `annalo.mousewerk.de` and
`/AnnaloWeb`; the website's former-name FAQ and `alternateName`; release notes as history; the update
signing key (unchanged).

## Website and owner

Website: package name, `annalo-theme` storage key (read-old fallback, privacy pages, tests), data paths in
docs and privacy pages (also stale `annalo.log`), shot scripts' env names. Owner: rename the GitHub repo
`MouseWerk/annaloweb` and the Cloudflare worker `annaloweb` (domains move with it).

## Status of the rename (done in the app repo)

Done, as specified above; details in docs/ARCHITECTURE.md „Names kept from Annalo“:

- Identity: identifier `de.mousewerk.arcalo`; folders copied at start before the WebView exists
  (`identity.rs` in core and shell: staging, verify, marker `.arcalo-migrated.json`, old folders kept,
  copied again with the newer folder kept aside when an older version wrote to the old workspace,
  old folder used for that start when a copy fails). Credentials: every known account copied to
  `Arcalo`, read back and compared, noted in `credentials-moved.json`; `Annalo` read until then and
  kept. localStorage copied once on UI boot (`ui/src/lib/legacy.ts`). Settings step 16 „theme-ids“.
- Binary `arcalo`/`arcalo.exe`: NSIS hooks (old exe closed and removed, Run value, Start menu,
  desktop and pinned taskbar shortcuts retargeted and stamped with the new AUMID, old folders removed
  with „App-Daten löschen“), deb link `/usr/bin/annalo`, AUR links, macOS link
  `Contents/MacOS/annalo` (1.14's updater restarts that path), CLI also as `annalo`.
- Read both / write new: markers, MDM domain, MSIX excluded folders, Git sync marker and database
  copy, formats, `ANNALO_*` variables (test-only ones renamed), log filter aliases.
- Code-level renames: crates, npm packages, DOM events, globals, MIME types, URI schemes and header,
  thread names, CI artifact, `ARCALO_UPDATER_PUBKEY`, brand files, config example, e2e `ARCALO_APP`.
- Kept: synthetic ICS UIDs `annalo-…` (stable ids), the update feed fallbacks, the signing key, the
  pinned Chocolatey icon URL, release notes and findings as history.
- Tests: core `identity` (1.14 layout, WebView2 storage, location.json, merge, failure, rollback,
  idempotence), shell `secrets` (take-over, fallback, encrypted workspace, portable namespace),
  `installer` (1.14 bundle restart path), `portable` (old lock), mail/theme/settings readers, UI
  `legacy.test.ts`, the guards (`branding.test.ts` any spelling, e2e 250) and e2e 288 (a 1.14 layout:
  pages, settings, encrypted workspace, secret, WebView storage, update marker, location.json).

Open for the owner: the website (repo and worker rename), the Windows/macOS manual checks in the
release notes (taskbar pin, AUMID, macOS link in the signed bundle). Owner decision: 1.17 deletes the
old folders and credential entries. Before deleting, 1.17 must refuse while any `location.json`,
`backup_dir`, `markdown_mirror_dir` or backup destination points into an old folder (1.15.1 rewrites
`location.json`; see docs/quality/q116/core-findings.md C2).
Done in 1.17: `crates/arcalo-core/src/identity/cleanup.rs` (folders) and `secrets::remove_legacy` (credential
entries), with these and further refusals; see docs/ARCHITECTURE.md „Names kept from Annalo“.

## Tests

Migration from a real 1.14 layout (data folder, WebView storage, credentials incl. an encrypted workspace,
custom data dir via `location.json`, portable copy), idempotence, rollback, both-name readers, and the guards
(`ui/src/lib/branding.test.ts`, e2e 250, 113).

## Also in 1.15: flaky e2e on CI

CI run 167 (5bf6f52) failed once in e2e 144 „PDF highlight in English“ (`.pdf-hl-pop .pdf-hl-delete` not
clickable) and e2e 270 „a chip cut in the source view …“ (toast „Buchung mit dem Chip gelöscht“ not shown;
the next test failed as a consequence). Both passed in runs 163 and 166 and 3/3 locally; find the root cause
(screenshots of the failing run were not reachable from the cloud session).

270 failed again in run 172. Root cause: the source view decided on a removed chip with link
states that were up to about 300 ms behind (refresh debounce plus IPC); a chip cut right after its booking
came back still read as missing, so its booking was never deleted. Fixed: while a refresh is due, the chips
of the text before the edit are asked for first. 144 is still open.
