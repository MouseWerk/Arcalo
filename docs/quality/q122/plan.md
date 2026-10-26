# q122 plan: Arcalo held to Arcalo Mail's quality machinery

Owner, 2026-10-25: more speed, and Arcalo checked by the same machinery as the sister app Arcalo Mail, which
by now has more guards than Arcalo. This round ports them (Mail's `docs/quality/README.md` guard table and its
`q110` plan), runs each on `main`, fixes what they find at the root (one commit per guard, branch `qa`), adds
the e2e soak and the Android emulator suite, and refreshes `docs/ROADMAP.md`. Findings: `findings.md`.

Rounds running in parallel when this plan was written: `jira-modal` (the Jira code and the Issues UI) and the
website. The Jira files that round rewrites are checked after its merge (`findings.md`, J-items).

## Rules for every area

- The checks of `CLAUDE.md` green, every guard below green.
- Each fix with a test where practical; root causes, no retries, never skip or weaken a test.
- Screenshots looked at one by one; every picture shows the whole window or the whole phone screen.
- Migrations take the next number (latest on `main`: 0040, the gaps listed in `db.rs` stay free), settings
  changes a step (`SETTINGS_VERSION` 19).

## Exit criterion

**3 consecutive fully clean rounds.** A round: the full desktop e2e suite 5 times without a single failure
(`e2e soak`, input `rounds` 5), the Android emulator suite green (`android-e2e` in `ci.yml`: 360x800 and
412x915, light and dark), CI green on Linux, Windows, macOS, Android and iOS, the manual checklists of
`docs/testing/` for every area changed since the last round. A round is clean when it found nothing to fix; any
fix starts the count again.

| Round | Date | Soak (5x) | Android e2e | Findings | Clean |
|-------|------|-----------|-------------|----------|-------|
| 0 | 2026-10-25 | first soak 40215972409: rounds 2 and 5 red, the app was on the soak's PATH (workflow fixed) | CI 40171628604 to 40205555208: red (E1 to E4, harness) | guards on `main` F1–F17 and J1; CI red on `main` since 9d7bcb4 (F18, F19); F20, F21; emulator E1–E4 | no |
| 1 | 2026-10-25 | run 40220894425: 4 of 5 (round 2: `36-settings-layout` dropdown, F22) | CI 40210972539 and 40220891741: all 6 jobs green, emulator included | F22 | no |
| 2 | 2026-10-26 | run 40226519835: 5 of 5 (test-side wait, replaced); run 40278419585 on the `Select` fix: 5 of 5 | CI 40278415721: green but the emulator (splash 3.3 s against a 3 s bound on a cold emulator; the bound is now under the 8 s limit) | F22, F23 | no |
| 3 | 2026-10-26 | (run 40278419585 above is on the same app code) | CI 40285045771: all 6 jobs green, emulator included | none | first clean round (automated part) |

## Guards

Mail's guards and Arcalo's counterpart. Status: **ported** (new on `qa`), **extended** (Arcalo had a weaker
form), **present** (Arcalo had it), **n/a** (with the reason).

| Guard | Arcalo Mail | Arcalo | Status |
|-------|-------------|--------|--------|
| No glow or gradient frame for a state | `styles.test.ts` | `ui/src/styles/styles.test.ts` | ported (F1, F2) |
| Focus rings only on `:focus-visible` (outline and box-shadow) | `styles.test.ts` | `styles.test.ts` | ported (F3) |
| State selectors include `.open`, `.expanded`, `aria-expanded`, `data-selected` | `styles.test.ts` | `styles.test.ts` | extended |
| Dark and light define the same tokens; only tokens that exist | `styles.test.ts` | `styles.test.ts` | ported (F4, F5) |
| A `prefers-reduced-motion` block exists | `styles.test.ts` | `styles.test.ts` | ported |
| Accent frames, side bars, rings, faded text, inline styles, endless animations, weights, layers, radii | `styles.test.ts` | `styles.test.ts` | present |
| Contrast in every theme; 7:1 for text in the contrast themes | `contrast.test.ts` | `ui/src/lib/contrast.test.ts` | extended (F6) |
| Icon-only buttons have a name | `a11y-buttons.test.ts` | `a11y-buttons.test.ts` | present |
| Menu buttons say so: every menu opener, not only `openMenuAt` | `a11y-menus.test.ts` | `a11y-menus.test.ts` | extended (F7) |
| IME-safe Enter and Escape | `ime-guard.test.ts` | `ime-guard.test.ts` | present |
| No hard-coded UI text | `i18n-strings.test.ts` | `i18n-strings.test.ts` | present (Mail's extras are mail names) |
| One notation for keys, also „Strg + K“ | `keynotation.test.ts` | `shortcut.test.ts` | extended (F8) |
| No emojis in any text file | `emoji.test.ts` | `ui/src/lib/emoji.test.ts` | ported (F9) |
| No system select, date picker, `alert`/`confirm`/`prompt`; checkboxes drawn by the app; search fields without suggestions | `controls.test.ts` | `ui/src/lib/controls.test.ts` | ported (F10–F12); color pickers and desktop datalists: `docs/ROADMAP.md` |
| Commit rules (owner as author, no trailers) on every push | `scripts/commit-rules.mjs` | same, `ci.yml` | ported |
| Release notes: the three sections | `scripts/release-notes.test.mjs` | same, since 1.11 | ported (F13) |
| e2e: `guarded()`, no skips, the app only from the variable, no kill by name, reloads | `scripts/e2e-conventions.test.mjs` | same | extended (F14, F15) |
| Migrations positional | `guards.rs` | `db.rs` `migrations_are_positional` | ported (F16) |
| Every settings key with a step | `guards.rs` | – | open: `docs/ROADMAP.md` (the release fixtures cover loading) |
| Mail HTML in the sandboxed frame, secrets in settings, error texts through `tr!` | `mailhtml.test.ts`, `guards.rs` | `error.rs`, `network.rs`, `splash.test.ts` | n/a for mail HTML; the rest present |
| e2e soak: the suite 5 times on one build | `.github/workflows/e2e-soak.yml` | same; rounds side by side on runners of their own (one suite takes an hour) | ported |
| Android emulator: layout, stock UI, 130 % font, screenshot tour | `e2e/android/`, `lib/geometry.js`, `lib/stockui.js` | same, against the phone app (`ui/src/mobile`) | ported (F17) |

## Device and theme matrix

| Dimension | Values |
|-----------|--------|
| Android | emulator (API 34, Pixel 6 profile): 360x800 and 412x915 dp at 2x, portrait; font 100 % and 130 % |
| iOS | simulator build check (iPhone, two iPads) in `ios.yml` |
| Desktop | Linux e2e (WebKitGTK, 1480x920 and the tests' own sizes); Windows and macOS builds and their tests in CI; the manual checklists of `docs/testing/` |
| Themes | light, dark; contrast themes in the contrast test |
| Languages | de (du), en |

## Areas

| # | Area | Method | Bar | Status |
|---|------|--------|-----|--------|
| A1 | Guards | Port each applicable guard of Mail's table, run it on `main`, fix at the root | All green on `qa`; every exception listed with its reason and checked to still exist | done on `qa` (`findings.md`) |
| A2 | e2e soak | `e2e-soak.yml` with 5 rounds on `qa` (a pushed `soak/<name>` branch: a workflow can be dispatched only once it is on `main`) | 5 of 5 rounds clean | see round table |
| A3 | Android emulator | `android-e2e` on every push: `phone.test.js` (splash, layout, tab bar, screen ends, Leistungsart sheet, system bar colors in dark, 130 %, spinners, stock UI), `tour.test.js` (every screen, menu and sheet in light and dark, the bars' pixels) | green; the tour's pictures looked at | green since 40210972539 |
| A4 | Roadmap | Each item of `docs/ROADMAP.md` checked against the code and the release notes | done items moved out, real next candidates listed | done |

## TODO

- The Android suite in the soak (an input to run it N times), as in Mail's q110 TODO.
- J1 after the jira-modal merge.
