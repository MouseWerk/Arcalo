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

| F18 | e2e on `main` (CI red since 9d7bcb4) | `harness.js` `app.reload()`: without a hash WebDriver passes `null`, the page got `#null` and a capture window reloaded as the main window (`68-capture-window`: „draft lost on reload“) | the hash is set only when given |
| F19 | e2e on `main`: UI audit | `371-ui-audit`: the start page's task checkbox (`.dw-check`, 15x15 px) too small to hit; it showed once its fixture task (due 2026-10-20) became overdue | a 22 px target around the 15 px box (`::before`), the row unchanged |
| F20 | phone, found by the browser check (`e2e/mobile/shots.mjs`, not in CI) | Git setup went blank after its first step: `useEffect(() => ref.current?.scrollTo(…))` returned the promise Chromium's `scrollTo` gives back, and React called it as the cleanup | braces; `ui/src/lib/effects.test.ts` refuses effects that return a DOM call on a ref |
| F21 | e2e in CI (2 of 3 runs): `407-calendar-entries` „Enter in the panel: end not written“ | a new appointment changes its key when Outlook has it; the Kalender then moved the focus to the panel's title, out of the time field being typed in, and the typed end was lost | the focus stays where it is inside the panel |
| F22 | soak round 2 (1 of 5): `36-settings-layout` „the dropdown“ | the scale chosen with Enter reaches the window a moment later (the webview's zoom); the window's resize closed the list the test had just opened with Space | the test waits for the zoom before it opens the list again (a list closing on a window resize stays as designed) |

## Android emulator

| # | Where | Finding | Fix |
|---|-------|---------|-----|
| E1 | start | the splash stayed its full 8 s on every start: the phone app never marked `body.ready` (the browser check removes the splash under WebDriver and did not see it) | `MobileApp` marks it once the settings are loaded; a guard in `splash.test.ts`, the time measured on the emulator |
| E2 | Aufgaben, Notizen, Erfassen | the desktop's 10 px scrollbar gutter and the stretch at the ends of every scrolling screen | overlay scrollbars and `overscroll-behavior: contain` in the phone app |
| E3 | Zeit, Erfassen (Buchung) | Leistungsart as a `<select>` (Android's picker dialog); the reference with a `datalist` (Android's suggestion strip) | the app's sheet (`Choice`) and its own suggestion list (F10, F17); their rows without the stock button look and not selectable as text |
| E4 | every screen in the dark theme | the status and navigation bars stay in the light window color: both Kotlin plugins were registered under one Tauri plugin, the second replaced the first, and every `ShellPlugin` call (bar colors, shared text, Back at the root, the window's facts, the document picker, the proxy) answered „No command … found for plugin UpdatePlugin“ | each Kotlin plugin under a Tauri plugin of its own (`mobile/android.rs`); the emulator test measures the bars' pixels against the app's colors |

## Left for after the jira-modal merge

The Jira files were being rewritten by the parallel round `jira-modal`; the guards ran on them too.

| # | Guard | Where | What to do |
|---|-------|-------|------------|
| J1 | controls: every checkbox drawn by the app | `ui/src/components/dashboard/jira.tsx` (column choice of the Jira widget) | class `check`, then drop the file from `JIRA_IN_PROGRESS` in `ui/src/lib/controls.test.ts` |

`crates/arcalo-core/src/issues/`, `src-tauri/src/jira.rs`, `ui/src/views/IssuesView.tsx` and
`ui/src/editor/issueChips.ts`: no finding of the new guards.
