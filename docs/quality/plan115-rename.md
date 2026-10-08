# 1.15 plan: no "Annalo" left

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

## Tests

Migration from a real 1.14 layout (data folder, WebView storage, credentials incl. an encrypted workspace,
custom data dir via `location.json`, portable copy), idempotence, rollback, both-name readers, and the guards
(`ui/src/lib/branding.test.ts`, e2e 250, 113).

## Also in 1.15: flaky e2e on CI

CI run 167 (5bf6f52) failed once in e2e 144 „PDF highlight in English“ (`.pdf-hl-pop .pdf-hl-delete` not
clickable) and e2e 270 „a chip cut in the source view …“ (toast „Buchung mit dem Chip gelöscht“ not shown;
the next test failed as a consequence). Both passed in runs 163 and 166 and 3/3 locally; find the root cause
(screenshots of the failing run were not reachable from the cloud session).
