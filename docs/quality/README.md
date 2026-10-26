# Quality passes

Plans and findings of the quality passes before each release: what was checked, what was found (with root
cause and fix), and what was deliberately left open and why.

| Release | Files |
|---------|-------|
| q122 | `q122/plan.md` (Arcalo Mail's guards ported, the e2e soak, the Android emulator suite, rounds and exit criterion), `q122/findings.md` |
| 1.12 | `plan112.md` (areas and status), `quality112-brief.md` (method and bar for every area), findings per area: `q112-notes.md`, `q112-time.md`, `q112-integrations.md`, `q112-ai.md`, `q112-data.md`, `q112-settings.md`, `q112-shell.md`, `q112-ci.md`; selected after-screenshots in `shots/` |
| 1.11 | `quality111-logic.md`, `translation111.md` |
| 1.10 | `plan110.md`, `quality110-findings.md` |
| 1.9 | `plan19.md`, `quality19-findings.md` |
| 1.8 | `quality18-findings.md`, `leftovers18.md`, `bugs-next.md` |

Feature ideas that came up during 1.12 and were left for a feature release: pinned tabs, recurring tasks,
bulk actions in Tasks, inline rename in the page tree, "follow system language", keeping the original
Markdown style (bullets, fences) on save.

## The `e2e soak` workflow

`.github/workflows/e2e-soak.yml` builds the app once and runs the whole desktop suite N times (input `rounds`,
default 5; weekly on Sundays on `main`), each round on a runner of its own. It fails on any single failed test,
writes the failed tests of each round to the job summary and uploads the screenshots, `FAIL-*.png` and the TAP
report of every failed round (artifacts `e2e-soak-failures-round-<n>`). A test that fails once in five runs is
a bug in the app or the test, not luck.

## The Android emulator suite

`e2e/android/` (job `android-e2e` in `ci.yml`): the debug APK on an emulator at 360x800 and 412x915 dp, the
layout and the platform's own UI measured on every screen (`e2e/lib/geometry.js`, `e2e/lib/stockui.js`), and a
screenshot tour in light and dark (artifact `android-screenshots`).

