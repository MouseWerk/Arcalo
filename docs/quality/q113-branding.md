# 1.13 package C: Branding (Annalo → Arcalo)

Goal: no place where a user can still see „Annalo“, except the one-time notice „Annalo heißt jetzt
Arcalo“ for upgraders. Method: the real app on a fresh data folder (first run and a normal start,
German and English), the start-up animation grabbed from the X display every 100 ms, the intro
scenes and setup steps, Settings; then every source of visible text (UI catalogs, backend `tr!`
pairs, `ui/index.html`, installer hooks and art, bundle metadata, notifications, tray, window
titles, export metadata, help links). Screenshots: `q113-shots/branding/` in the scratchpad
(before-*/after-*, frame sheets).

## Findings

| # | Sev | Where | What | Fix | Test |
|---|-----|-------|------|-----|------|
| 1 | High | Start-up animation (`ui/index.html`) | Under the logo the letters `A n n a l o` came in one by one on every start (the owner's report). The splash markup was written before the rename and never touched by it. | The letters spell `Arcalo` (same count, same timing). | `branding.test.ts` (index.html text, splash word), `250-branding` (splash word in the running app) |
| 2 | Medium | Settings → Protokoll, data folder | The developer log was `logs/annalo.log` / `annalo.jsonl`, named in the settings texts and visible in the data folder and the diagnostics ZIP. The level variable was `ANNALO_LOG`. | Files are `arcalo.log` / `arcalo.jsonl`; files of earlier versions (with rotations) are renamed at start, never overwriting. `ARCALO_LOG` is read first, `ANNALO_LOG` still works. e2e, CI (Store job log check) and docs follow. | `devlog::log_files_of_annalo_take_the_new_names`, `250-branding` |
| 3 | Medium | Settings → Sicherung → Git, every sync commit | The default Git author stored by 1.6 (`Annalo`) and the default e-mail `annalo@localhost` (still the default until now) were shown in the settings fields and written into each commit. | Default e-mail `arcalo@localhost`; settings step 11 → 12 `git-author` replaces exactly the old defaults (an author entered by hand stays). `SETTINGS_VERSION` 12, schema regenerated. | `settings_migrate::the_git_author_of_annalo_becomes_arcalo` |
| 4 | Low | Windows installer, „Details anzeigen“ | Updating an installation from before 1.7 listed „Annalo found in …“ and „Removing the entries of Annalo“. | „Earlier version found in …“, „Removing the entries of the earlier version“. | `branding.test.ts` (DetailPrint lines) |
| 5 | Low (internal) | Logo component | `AnnaloLogo` / class `annalo-logo` (code only; the vector is already the Arcalo mark). | `ArcaloLogo` / `arcalo-logo`. | `branding.test.ts` (no Annalo in UI sources) |
| 6 | Low (internal) | Catalog key `sio.notAnnalo` | Key name only (the text already said Arcalo). | `sio.notSettingsFile`. | translation check |

## Checked and fine

- Logo mark: the path in `Logo.tsx`, the splash, the intro (`scenes.tsx`), `ui/public/icon.svg`,
  `docs/brand/*.svg` and the website's `public/favicon.svg` are the same vector; `src-tauri/icons/*`
  (PNG, ICO, ICNS, Store logos, tray template), the installer header and sidebar (drawn by
  `make-art.py` with „Arcalo“) and the website icons show the same A mark. No old mark anywhere.
- Window titles (`index.html`, main, recovery, presenter view, lock, rollback dialogs), tray tooltip
  and menu, Linux notifications (`appname("Arcalo")`), Windows toasts (Start menu shortcut name),
  `Info.plist`, `tauri.conf.json` (`productName`, NSIS start menu folder, deb `conflicts`/`replaces`
  the old package), help and website links (`MouseWerk/Arcalo`), HTML export `generator`, Git sync
  README, Markdown mirror README, backup and settings export file names (`arcalo-…`), About,
  lock screen, onboarding and all intro scenes in German and English.

## Kept on purpose (internal)

See docs/ARCHITECTURE.md, „Names kept from Annalo“: app identifier `app.annalo.desktop`, crate and
binary names, the credential store service `Annalo`, Git sync marker, `annalo-workspace.db` and
fallback branch (shared with computers on older versions; the file name appears in the Git
settings text and is allow-listed in the guard), legacy markers, `annalo-mail://` links, URL
schemes, the settings export format id, DOM event and `localStorage` names, theme ids, `ANNALO_*`
variables, the old repository URLs as update feed fallbacks, `docs/brand/annalo-*` file names
(packaging scripts and pinned package URLs).

## Guards

- `ui/src/lib/branding.test.ts`: UI catalogs (only `rebrand.*` may say Annalo), Rust string
  literals outside tests (allow-list with reasons), UI sources (JSX text and literals),
  `index.html` text and splash word, bundle metadata and installer detail lines.
- `e2e/tests/250-branding.test.js`: in the running app, every text node and the user-facing
  attributes (title, aria-*, placeholder, alt, tooltip, value) of the splash, every intro scene and
  setup step (German, English), the home view and every Settings section; window title; log file name.

## Noted, not in scope

- A first run with an English system (`ANNALO_LOCALE=en-US`) still shows the German welcome screen;
  „Wie das System“ is package B2.
