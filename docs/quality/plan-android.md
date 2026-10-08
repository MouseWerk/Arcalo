# Plan: Arcalo for Android (companion app)

Owner decision: a companion app, not the desktop app on a phone. Phone-first screens Heute,
Schnellerfassung, Tagesnotiz, Aufgaben, Zeit, Notizen, Einstellungen; sync through the existing Git sync; no
AI, voice notes, Outlook/Jira, start page boards, projects view or canvas/drawings in v1. Application id
`de.mousewerk.arcalo` from the start. What the app does and how: docs/android.md; build and signing:
docs/release/android.md.

## Status (first version, 2026-10-08)

Done and checked on the build machine (no Android SDK there):

| Part | State | How it was checked |
|---|---|---|
| Shell for Android (`cfg(desktop)` gating, `mobile/` entry point and commands, stand-ins) | done | `cargo check` and `cargo clippy -D warnings` of the library for `aarch64-linux-android` (C code stubbed, Rust fully type-checked); desktop `cargo clippy --workspace --all-targets` and all tests unchanged |
| Desktop-only crates as non-mobile target dependencies | done | the desktop build and its tests; Cargo.lock only gains git2/libgit2 and the Android-only crates |
| Git sync on libgit2 (`gitlib.rs`, `embedded-git`) | done | every sync test (`gitsync::tests`, `gitsync::safety_tests`: bare remotes, divergent edits, conflicts, foreign history, first sync of a new computer, mass deletions, mirror swaps, settings file, restore check) on libgit2 with `ANNALO_TEST_EMBEDDED_GIT=1`; repositories it writes are read by the system git in the same tests |
| Companion sync (no database copy, no time sheets from the phone) | done | `a_companion_keeps_the_desktops_database_copy_and_time_sheets` on both backends |
| Bookings as chips, „Heute“, recent references, daily note adoption, WBS and meetings from the database copy (`companion.rs`) | done | unit tests in `companion.rs` |
| Secrets in the Android Keystore (`mobile/keystore.rs`, `SecretsPlugin.kt`) | done | type-checked (Rust); Kotlin not compiled yet |
| HTTPS certificates on Android (rustls: Mozilla roots; libgit2: system store, else Mozilla roots) | done | type-checked |
| Mobile UI (`ui/src/mobile/`, `styles/mobile.css`, `mob.*` texts) | done | typecheck, unit tests (`mobile/model.test.ts`), translation and style guards, browser check `e2e/mobile/shots.mjs` (390x844, light and dark, touch targets ≥ 44 px, no console errors) |
| Android project (`src-tauri/gen/android`) | generated, adapted | not built yet |
| CI workflow `android.yml` (APK, release key or debug key) | added | first run on GitHub |

## Not verified without an Android build

The CI workflow is the first real build. Things to watch in its first runs and on a device:

1. The C builds for Android: SQLCipher with vendored OpenSSL, aws-lc (rustls), libgit2 with OpenSSL,
   zlib. All use the NDK's clang through the environment `cargo tauri android build` sets.
2. The Kotlin plugin `SecretsPlugin` (registered by name from Rust), the window insets in `MainActivity`,
   ProGuard keeping the plugin classes in the release build.
3. libgit2's HTTPS on a device: the CA bundle written from `/system/etc/security/cacerts`, proxies, timeouts,
   a GitHub fine-grained token (credentials callback with `x-access-token`).
4. Calls into the Keystore come from worker threads (the app's commands are async); a call from Tauri's
   event loop thread should still answer (the Kotlin side runs on Android's UI thread), the setup avoids it.
5. The back button through the WebView history, the keyboard over the capture and edit fields, the app
   killed in the background while a sync runs (git locks older than 120 s are removed by the next sync).

## Next steps

1. First CI run: fix what the Android build finds; install the APK on a phone and an emulator, go through
   the checklist in docs/release/android.md.
2. Create the release key and the four secrets (docs/release/android.md), then add the APK to
   `release.yml` with the release version and the website download.
3. Desktop: take bookings from phone chips over automatically (a chip of another device with a booking
   marker could be booked by the sync instead of by „Erneut buchen“), or carry bookings in a file of their
   own in the repository.
4. App lock (biometric) and the database encryption on the phone; secrets then also guard the key.
5. A touch editor (TipTap with a reduced toolbar) once the reading/editing flow is proven; interactive task
   checkboxes in the reader.
6. Notifications: due tasks and the running timer; a home-screen widget for „Heute“.
7. The 1.15 rename (`plan115-rename.md`): the Android id already is `de.mousewerk.arcalo`; credential
   service names on Android start fresh (no migration needed).
