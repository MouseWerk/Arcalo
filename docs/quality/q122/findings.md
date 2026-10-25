# q122: findings of the guards

What the guards ported from Arcalo Mail (`plan.md`, „Guards“) found when they first ran on `main` (9d7bcb4,
2026-10-25). Each guard and its fixes are one commit on `qa`.

## Fixed on `qa`

| # | Guard | Where | Fix |
|---|-------|-------|-----|
| F1 | design: no glow for a state | `app.css` `.calv-ev.live .calv-ev-time::before` | the live meeting's dot without the colored halo |
| F2 | design: no glow or ring for a state | `editor.css` `.textLayer .highlight.selected` | the current PDF hit is a stronger tint, without the orange ring |
| F3 | design: focus rings only on `:focus-visible` | `.input`, `.prop-key`, `.prop-value-input`, `.coll-input .prop-value-input`, `.m-input`, `.m-textarea` | `:focus-visible` (text fields match it on every focus, so nothing changes for them; the ring no longer shows on a click into anything else with these classes) |
| F4 | design: only tokens that exist | `app.css` (2x), `workwidgets.css`: `--fs-3xs` | the token was never defined, so the badges took the inherited size: `--fs-3xs: 9px` in `tokens.css` |
| F5 | design: only tokens that exist | `dashboard.css` `.dw-random-card`: `--bg` | `--bg-raised` (the card had no background) |
| F6 | contrast 7:1 in the high contrast themes | `contrast-light` and `contrast-dark`: `--danger` 6.5 and 6.6 on sidebar, raised and overlay surfaces | `#9a001c` and `#ff8585` |
| F7 | menu buttons say so | `Dashboard.tsx` (board options), `Workspace.tsx` (all tabs), `PageProperties.tsx` (2x property menu), `CanvasView.tsx` (export), `TableView.tsx` (column menu) | `aria-haspopup="menu"`; the guard now finds every `…Menu(` opener, not only `openMenuAt` |
| F8 | key notation | – | green; the check now also refuses „Strg + K“ |
| F9 | no emojis | `feed.rs`, `taskedit.rs`, `tests/fuzz.rs`, `mobile/model.test.ts`, `q116/core-findings.md` | escapes (`\u{2705}`) in tests; the task format's done marker U+2705 stays where a note quotes it (listed in the guard) |
| F10 | controls: no system select | `mobile/screens/Time.tsx` Leistungsart (`<select>`, Android's picker dialog) | `Choice` in `mobile/ui.tsx`: a sheet of the options from the bottom, closed by Back |
| F11 | controls: every checkbox drawn by the app | `KeyGateApp.tsx`, `WidgetSettings.tsx` (3x), `workSettings.tsx` (2x), `collection/controls.tsx`, `SecuritySection.tsx`, the scratch pad's tasks (`dashnotes.ts`) | class `check`; the `accent-color` rules for the stock boxes removed |
| F12 | controls: search fields without suggestions | `mobile/screens/GitSetup.tsx`, `mobile/screens/Notes.tsx`, `panels/assistant/HistoryView.tsx` | `autoComplete`, `autoCorrect`, `autoCapitalize` off, `spellCheck={false}` |
| F13 | release notes | v1.14.1 and v1.15.1 have no item under „Improved“; v1.15.1 quotes the done marker U+2705 | the rule: a patch release may leave „Improved“ empty; the notes before 1.11 (the rule came then) are published as they are |
| F14 | e2e conventions: no kill by name | `harness.js` `close()` and 9 test files: `pkill -f "$APP"` (also the apps of other runs on the machine) | tauri-driver and every app a test starts run in a process group of their own (`startProcess`); `close()`, `app.kill()` and `stopStarted()` signal only those groups |
| F15 | e2e conventions: `guarded()` | `highlight-shots`, three `readme-shots`, `301-instance-lock` | wrapped; `guarded` takes the options of node:test |
| F16 | migrations positional | – | green; the gaps 0016, 0021–0025 and 0028 are listed and stay free |
| F17 | phone (stock UI, found reading the screens for the emulator tour) | `mobile/screens/Time.tsx` reference field with a `datalist` (Android's suggestion strip) | the matching references in the app's own list below the field |

## Left for after the jira-modal merge

The Jira files were being rewritten by the parallel round `jira-modal`; the guards ran on them too.

| # | Guard | Where | What to do |
|---|-------|-------|------------|
| J1 | controls: every checkbox drawn by the app | `ui/src/components/dashboard/jira.tsx` (column choice of the Jira widget) | class `check`, then drop the file from `JIRA_IN_PROGRESS` in `ui/src/lib/controls.test.ts` |

`crates/arcalo-core/src/issues/`, `src-tauri/src/jira.rs`, `ui/src/views/IssuesView.tsx` and
`ui/src/editor/issueChips.ts`: no finding of the new guards.

## Android emulator

See `plan.md`, round table; each finding is listed here with its fix once the emulator suite has run.
