# Android findings, 1.18

Audit and fix pass of the Android companion app (owner: "the Android app needs to be so much better, and
support auto update"). Checked in the browser against the built UI with the IPC mocked
(`e2e/mobile/shots.mjs`): every main screen at 360x800 and 412x915 in light and dark, high contrast light and
dark at 412x915, 360x640, 430x932, landscape 800x360 and 915x412, tablets 800x1280 and 1280x800, Android's
font size emulated at 130 % and the on-screen keyboard as a shrunk viewport (MainActivity pads the WebView by
the keyboard's height): 120 screenshots per run. About 35 were looked at by hand (every screen at 360x800
light, the main ones in dark, contrast, landscape, tablet and at 130 %, every update state). The Rust side was
type-checked and clippy-checked for `aarch64-linux-android` with the C builds stubbed; Kotlin was reviewed
against the plugin API of Tauri 2.11.6. No device or emulator was available: what only a device shows is in
the manual checklist of docs/release/android.md.

| Id | Severity | Status |
|---|---|---|
| A1 | blocker | not fixed: owner's secrets (the app now explains it) |
| A2 | major | fixed in `3180abf`, `7f8503a` |
| A3 | major | fixed in `7f8503a` |
| A4 | major | fixed in `7f8503a` |
| A5 | major | fixed in `7f8503a` |
| A6 | major | fixed in `7f8503a` |
| A7 | minor | fixed in `7f8503a` |
| A8 | minor | fixed in `7f8503a` |
| A9 | minor | fixed in `7f8503a` |
| A10 | minor | fixed in `7f8503a` |
| A11 | minor | fixed in `7f8503a` |
| A12 | minor | fixed in `7f8503a` |
| A13 | minor | fixed in `7f8503a` |
| A14 | minor | fixed in `7f8503a` |
| A15 | minor | fixed in `7f8503a` |
| A16 | polish | fixed in `7f8503a` |
| A17 | minor | fixed in `7f8503a` |
| A18 | minor | moved to 1.19 |
| A19 | polish | moved to 1.19 |

## A1 Release APKs cannot update an installed app

- **Where:** `.github/workflows/android.yml` (signing), every release APK.
- **Reproduce:** the release runs of 1.16 and 1.17 annotate „the APK is signed with a debug key“. Install
  1.16, then 1.17: Android refuses („App not installed: package conflicts“).
- **Expected / actual:** a newer release installs over the old one / every CI runner creates a new debug
  key, so no two release APKs share a signing key.
- **Root cause:** confirmed: the four `ANDROID_*` secrets are not set.
- **Fix:** the release run warns instead of only noting it; `android-latest.json` carries the signing
  certificate and the app recognizes an update with another key before downloading it and explains what to
  do (sync, uninstall, install from the release page). The real fix is the release key (docs/release/android.md
  → Signing), which only the owner can create.
- **Test:** `update_android::tests::only_a_newer_version_with_a_higher_code_and_the_same_key_is_an_update`,
  `the_downloaded_apk_must_be_the_announced_one`; screenshot `24-update-blocked`.

## A2 No way to update the app

- **Where:** the app had no update path; docs said „the app never updates itself“.
- **Fix:** check at the start, daily and by hand; background download on Wi-Fi (resumable), minisign
  signature with the desktop's update key and the signed version, package, version code and signing key read
  by Android; notification and banner; one tap opens Android's installer, with the „Unbekannte Apps
  installieren“ permission flow. Release workflow signs the APK and writes `android-latest.json`.
- **Test:** `update_android::tests::*`, `update_feed::tests::files_are_verified_in_chunks_with_the_signed_version`,
  `mobile/model.test.ts` → updates, `shots.mjs` → `updates()` (banner, permission flow, the states).

## A3 Links in notes did nothing

- **Where:** Notizen → a page → a `[[link]]`.
- **Expected / actual:** opens the page / nothing happens.
- **Root cause:** confirmed: `page_resolve` is not in the Android app's command list; the error was
  swallowed by `.catch(() => {})`.
- **Fix:** registered. The browser check now fails for every command the UI invokes that Android does not
  register.
- **Test:** `shots.mjs` → `backButton()` (link), and the registered-command check of every run.

## A4 The back button quit the app or left the editor

- **Where:** every tab but Heute; the page editor.
- **Expected / actual:** back goes to Heute, then to the background; in the editor it ends editing / on a
  tab without opened screens the WebView had no history, so Android finished the activity (the app quit and
  started cold next time); in the editor back closed the page.
- **Root cause:** confirmed: navigation through `history.pushState` only covers screens opened above a tab.
- **Fix:** Tauri's back-button listener with `backAction` (edit mode, screen, Heute, background via
  `moveTaskToBack`).
- **Test:** `model.test.ts` → back button; `shots.mjs` → `backButton()` (fails on the 1.17 UI).

## A5 Typed text could be lost

- **Where:** the page and daily note editor.
- **Expected / actual:** text is saved / saved only 1.5 s after the last key; Android may end an app in the
  background before.
- **Fix:** saved when the app goes to the background and when the editor closes; back ends editing and saves.
- **Test:** `shots.mjs` → `backButton()` (save on back, save on hidden).

## A6 „Verwerfen“ discarded the running timer with one tap

- **Where:** Zeit → timer.
- **Fix:** the first tap asks („Timer wirklich verwerfen?“), a second within 3 s discards.
- **Test:** `shots.mjs` → `timerDiscard()`.

## A7 „Wie das System“ did not follow Android's dark mode while the app ran

- **Fix:** the theme is applied again when `prefers-color-scheme` changes.
- **Test:** manual (checklist); the code path is the desktop's `applyThemeState`.

## A8 The system bars followed Android's theme, not the app's

- **Where:** status and navigation bar area with the app in dark and Android in light (or the other way).
- **Fix:** `ShellPlugin.setBars`: the colors of the header and the tab bar behind the bars, icons light or
  dark after the app's theme.
- **Test:** manual (checklist).

## A9 Notices with a button squeezed their text into a narrow column

- **Where:** Einstellungen → „Löschungen übertragen“, the new permission notice; 360 to 412 px.
- **Fix:** the action sits below the text.
- **Test:** screenshot `21-update-permission`; width check of every run.

## A10 The running timer's time was cut off on Heute at 360 px

- **Fix:** the time moved into the title line; the reference and description may be cut.
- **Test:** screenshot `01-today-360x800`.

## A11 Large system fonts broke the layout

- **Where:** Heute („4,75 / h“ split), conflict buttons and form buttons wider than the screen.
- **Fix:** the week's total wraps below, numbers do not break, buttons wrap their label only when needed.
- **Test:** `shots.mjs` → `fontScale()` (failed with „wider than the screen“ before).

## A12 Tablets and landscape

- **Where:** 800x1280, 1280x800, 800x360, 915x412.
- **Expected / actual:** a readable column; the header and tab bar take a fair share / text lines over the
  whole width of a tablet; on a phone held sideways header and tab bar took 40 % of the height.
- **Fix:** the screens keep a column of `--m-content-max`; below 480 px height a lower header and a tab bar
  with icon and label side by side.
- **Test:** `shots.mjs` → `layouts()`.

## A13 SSH remotes on the phone

- **Where:** Einstellungen → Synchronisierung.
- **Expected / actual:** the phone says it needs HTTPS / the hint promised SSH (the desktop's text) and an SSH
  address failed with libgit2's „unsupported URL protocol“.
- **Fix:** the phone's own hint, saving an SSH address is refused with the reason, `mobile_sync` and the
  automatic sync check it.
- **Test:** manual (checklist).

## A14 Text shared to the app

- **Fix:** Arcalo is a share target for text; the capture opens with it (new).
- **Test:** `shots.mjs` → `shared()`.

## A15 Switch labels cut off

- **Where:** Einstellungen, 360 px („Updates auch über mobile Dat…“).
- **Fix:** the label of a switch row wraps.
- **Test:** screenshot `12-settings-end-360x800`.

## A16 Meeting titles cut to one line

- **Fix:** two lines before the title is cut.
- **Test:** screenshot `01-today-360x800`.

## A17 The browser check of the mobile UI no longer ran; the FileProvider shared too much

- **Where:** `e2e/mobile/shots.mjs` (fixtures for `workspace_tree` and `tasks_list` while the UI asks the
  compact commands: Notizen and Aufgaben stayed empty and the run stopped); `res/xml/file_paths.xml` (the
  template's `external-path "."`).
- **Fix:** fixtures of the compact commands, the run covers sizes, themes and the new checks; the
  FileProvider shares only `cache/updates/`.

## A18 Startup parses the desktop bundle

- **Where:** `ui/src/main.tsx` imports the desktop app statically, so a phone loads and parses the desktop's
  main chunk and stylesheet before the mobile chunk.
- **Status:** moved to 1.19: needs a separate mobile entry (Tauri's Android window URL) and a measurement on
  a device first.

## A19 Task checkboxes in a page are not tappable

- **Status:** moved to 1.19 (known limit of v1: tasks are ticked off under Aufgaben and on Heute).
