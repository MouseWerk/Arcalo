# Arcalo 1.12 quality pass: common brief for every area agent

Goal set by the owner: the next release takes as long as it needs; the app must be as close to perfect as
possible in every area. 1.12 is a fix-and-polish release (no big new features). The Microsoft Store (MSIX)
build is developed in parallel by another agent; do not touch packaging/msix, the Store feature flag or the
release.yml Store job.

## Rules (in addition to agent-rules.md, which you must read first)
- Commits: author Maurice Kleindienst <kleindiema@gmail.com>, no co-author or session trailers, no model
  names, no emojis. No assistant attribution in code, comments, docs or commit messages.
- Work in your worktree branch only. Before finishing: `git merge main`, re-run the checks, report. Do not push.
- Numbering: migrations are positional; the latest is 0030_perf_indexes.sql, next free is 0031 (check main
  again before you add one; never fill a gap). Settings: SETTINGS_VERSION is 11 in
  crates/annalo-core/src/settings_migrate.rs; bump with a migration step only if needed. e2e test files go
  up to the highest number in e2e/tests; take the next free numbers (check main before merging).
- Release notes: docs/releases/v1.12.0.md ("## Improved", "## Fixed", "## Checklist for Windows (manual)";
  create the file if missing, keep entries the other agents added; merge conflicts there: keep both).
  Write user-facing lines only, concrete ("X now does Y"), English, as the existing notes do.
- UI texts: through the i18n catalogs (ui/src/locales/de.ts, en.ts; backend tr!/trf! pairs), German "du",
  glossary in ui/src/locales/glossary.json and docs/i18n.md; the translation check
  (ui/src/lib/translations.test.ts) must pass.
- No inline style/script in ui/index.html. Every HTTP client via network::client_for(Service).
- Prefer root-cause app fixes; change a test only if its expectation is outdated. Never skip or disable
  tests. "Flake" is not a root cause.
- Each fix gets a test where practical (Rust unit test, vitest, or e2e).

## Method
1. Audit your area thoroughly: read the code end to end, list user flows, edge cases (empty, huge, unicode,
   umlauts, offline, slow network, errors, concurrent edits, encrypted workspace, English and German UI,
   light/dark and a contrast theme, narrow/split panes, keyboard only, screen reader names), data integrity,
   error messages, performance hot spots.
2. Use the real app: build it (`npm --prefix ui run build`;
   `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 cargo build -p annalo --features custom-protocol`) and drive
   it through the e2e harness (e2e/lib/harness.js) under your own Xvfb DISPLAY; take screenshots and look at
   them critically.
3. Write findings to q112-<area>.md
   (severity, repro, root cause, fix, test) before and while fixing.
4. Fix everything you find that is in scope and safe; for anything large or risky, describe it in the
   report instead of half-doing it.
5. Checks before finishing: cargo fmt --check; cargo clippy --workspace --all-targets -D warnings;
   cargo test -p annalo-core -p annalo-cli; ui typecheck + vitest; the e2e files of your area plus any you
   touched (run each twice); a broader e2e sample around your changes.

## Report (concise)
Findings count by severity, what you fixed (one line each), what you left and why, tests added, check
results with numbers, migration/settings/e2e numbers used, commit hash.

## UI bar (owner: "really 100% UI improvement")
Every area agent also does a full visual pass of its area, not only bugs:
- Screenshot every view, dialog, menu, empty/loading/error state of your area in German and English,
  light, dark and one high-contrast theme, at 1280x800, a narrow split pane and 1920x1080. Look at each
  shot critically against the standard of Linear, Raycast, Things or Obsidian: alignment to the 4/8 px grid,
  consistent spacing, type scale and weights, icon sizes and stroke, button hierarchy (one primary action),
  truncation and wrapping of long German words, focus rings, hover/active/disabled states, motion that is
  short and calm, no layout jumps, empty states that say what to do next, error messages that say how to fix.
- Fix what looks off with the existing design tokens (ui/src/styles, tokens.css); do not invent one-off
  colors or sizes. If a token is missing, add it centrally.
- Put before/after screenshots for every visible change into
  q112-shots/<area>/
  (before-*.png, after-*.png) so the owner can review them.
