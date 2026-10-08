# Working on Arcalo

Arcalo (formerly Annalo) is a local-first Tauri v2 desktop app: Rust workspace (`crates/annalo-core`,
`src-tauri`), React + TipTap UI in `ui/`, e2e tests with WebdriverIO + tauri-driver in `e2e/`. Read
`docs/ARCHITECTURE.md` and `README.md` first. Website: separate repo MouseWerk/annaloweb (Astro, Cloudflare),
live at https://arcalo.mousewerk.de.

## Owner decisions (standing)

- Commits are authored as `Maurice Kleindienst <kleindiema@gmail.com>`. No co-author or session trailers, no
  assistant or model names in commits, code, comments or docs.
- No 2.0 for now; releases are 1.x. Code signing certificates are off the table (no paid certificate); the
  Microsoft Store build (MSIX, signed by the Store) is the free signed Windows path; winget is fine.
- App language: German uses "du". Glossary: `ui/src/locales/glossary.json`, rules in `docs/i18n.md`.
- Encryption is off by default; settings apply instantly with undo; Git sign-in is not offered.
- Ctrl/Cmd+click in the tree selects; pages are filed in year/month folders, existing pages move only via
  "Aufräumen". Whisper models are downloaded from GitHub (release `whisper-models-v1`, keep it).
- No pull requests unless asked. No force push, branch deletion or history rewrite without an explicit request.
- Never commit the update-signing private key. Secrets only in the OS credential store.

## Code rules

- Match the surrounding style and comment density. No emojis anywhere.
- No inline `<style>`/`<script>` in `ui/index.html` (CSP; a test checks it).
- Every HTTP client goes through `network::client_for(Service)` (a test checks it).
- UI texts go through the i18n catalogs (`ui/src/locales/de.ts`, `en.ts`; backend `tr!`/`trf!` pairs); the
  translation check `ui/src/lib/translations.test.ts` must pass.
- Use the design tokens in `ui/src/styles` (tokens.css); no one-off colors or sizes.
- No accent-colored borders, outlines, left bars, glows or gradient borders for selected, active or current
  states (the "AI look"); show them with a quiet neutral background tint and text weight or color. Keyboard
  focus stays visible, but only on `:focus-visible` and in a neutral style. No colored bars on the left side
  anywhere either (cards, toasts, notices, callouts, nav, outline); use a tinted background and an icon. A plain
  blockquote may keep a thin neutral gray line. Applies to the app and the website. Quality bar:
  Obsidian/Linear-level polish in light, dark and contrast themes, 900–1920 px and split panes.
- Migrations in `crates/annalo-core/migrations` are positional: take the next number, never fill a gap.
  Settings changes need a step in `crates/annalo-core/src/settings_migrate.rs` (`SETTINGS_VERSION`).
- Release notes: `docs/releases/v<version>.md` with "## Improved", "## Fixed" and
  "## Checklist for Windows (manual)"; user-facing lines only.

## Checks

```
cargo fmt --all --check
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo clippy --workspace --all-targets -- -D warnings
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo test -p annalo-core -p annalo -p annalo-cli
npm --prefix ui run typecheck && npm --prefix ui test
```

e2e: the app embeds the UI at compile time, so build first:

```
npm --prefix ui run build
CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build -p annalo --features custom-protocol
cd e2e && ANNALO_APP="$PWD/../target/debug/annalo" node --test --test-concurrency=1 tests/<file>.test.js
```

Pass the app only via `ANNALO_APP`. Never kill processes by name or pattern (other runs may share the
machine); kill only PIDs you started. Prefer root-cause fixes; never skip or weaken a test.

## Development on macOS

See `docs/dev-setup-macos.md`. e2e tests do not run natively on macOS; use `e2e/docker/run.sh` or CI.

## Release

Push to `main` first, then run the Release workflow (`release.yml`, input `version`, e.g. `1.12.0`). Then
update the website (changelog, version, screenshots). Quality plans and findings per release are in
`docs/quality/`.
