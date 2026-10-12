# Arcalo for Android (companion app)

The Android app is a companion to Arcalo on the desktop, not the whole desktop app on a phone. It shows
what matters during the day and keeps your notes in step with the desktop through the same Git repository.

Application id: `de.mousewerk.arcalo` (the identifier the desktop takes with 1.15, see
`docs/quality/plan115-rename.md`). Minimum Android version: 8.0 (API 26).

## What it does

| Screen | What you can do |
|---|---|
| **Heute** | Date, time booked today against the day's target (holidays and absences included) and this week, the running timer (pause, stop), today's meetings (from the desktop's calendars, see below), tasks due today or overdue, the way to the daily note. A notice when the last sync failed or a note needs merging. |
| **Erfassen** (the + in the tab bar) | A note or tasks into today's daily note or the inbox (due dates: today, tomorrow, next week, or typed like on the desktop: `due:morgen`, „bis Fr“), or a booking. Text shared from another app („Teilen“ → Arcalo) opens it with that text. |
| **Tagesnotiz** | The daily note of a day, read or edited, previous and next day. A day without a note shows „Tagesnotiz anlegen“: the phone creates a daily note only when you start one, so it does not meet the desktop's note of the same day as a conflict. A daily note pulled from the desktop becomes the phone's daily note of that day. |
| **Aufgaben** | Open tasks grouped like the desktop's task view (overdue, today, this week, later, no date), „Fällig“ (up to this week) and the tasks done in the last 14 days. One tap ticks a task off; a repeating task gets its next date in its note, as on the desktop. |
| **Zeit** | The timer (start on a reference, pause, stop, discard after a second tap), a booking with the desktop's `/zeit` syntax built from a form (the references booked last as chips, Netzpläne and Vorgänge as suggestions, Leistungsart, description, today or yesterday; the line is shown before booking), and this week's bookings per day. |
| **Notizen** | Search, recently edited pages, the page tree; a page is shown rendered from its Markdown (tables, code, links, `/zeit` chips and due dates as small labels, embedded drawings and PDFs as a note that they show on the desktop) and edited as Markdown text. A tap on a task's box ticks it off (or opens it again) in the page, saved like an edit, so a change a sync brought meanwhile is merged; a repeating task gets its next date below it, as on the desktop. |
| **Einstellungen** | Git sync (remote URL, branch, author, access token, automatic sync, test, sync now, deletions held back, conflicts), appearance (system, light, dark, high contrast), language (system, German, English), updates, about. |

Android's back button (and gesture) closes the page editor first, then the open screen, then goes to Heute;
on Heute it sends the app to the background, as Android apps do, and never quits it.

Not in this version: AI, voice notes, Outlook and Jira, the start page boards, the projects view, canvas
and drawings (a canvas page shows a notice), templates, the calendar's own subscriptions, the app lock and
the database encryption.

## How bookings reach the desktop

The Git sync carries notes, not the database. A booking on the phone (a `/zeit` line or a stopped timer) is
stored in the phone's database and written into the daily note of its day as a time chip – the same
`<time-entry …>` Markdown the desktop's editor writes for a `/zeit` line. After the sync the desktop shows
the chip in that daily note as a booking from another device; „Erneut buchen“ on the chip books it into the
desktop's time tracking. The phone writes no `Zeiterfassung/*.csv` and never touches the database copy in the
repository (it syncs as a *companion*, see `SyncRequest::companion`), so the desktop's time sheets stay as the
desktop wrote them.

## Projects and meetings from the desktop

The WBS (projects, Netzpläne, Vorgänge, Leistungsarten) and the calendar live in the desktop's database.
When the desktop has „Datenbank mitsichern“ switched on (Einstellungen → Sicherung → Git), the repository
holds `arcalo-workspace.db`, a copy of the latest backup. After every sync the phone reads the WBS and the
meetings of the last week and the next 60 days from that copy (`companion::import_reference`); WBS entries
are matched by their numbers, so bookings made on the phone keep pointing at them. Without the copy the
„Zeit“ screen says where the Netzpläne come from, and „Heute“ shows no meetings. An encrypted database copy
cannot be read on the phone (its key stays on the desktop); it is skipped with a notice.

## Setting up the sync, step by step

1. On the desktop: Einstellungen → Sicherung → Git. Set up the sync to a repository on GitHub, GitLab,
   Azure DevOps or Gitea with an HTTPS remote URL (SSH is not available on the phone). Switch on
   „Datenbank mitsichern“ if the phone should see your Netzpläne and meetings. Sync once.
2. Create an access token that may read and write that repository:
   - GitHub: Settings → Developer settings → Fine-grained tokens, only this repository, „Contents: Read and
     write“.
   - GitLab: a project access token with `write_repository`.
   - Gitea / Azure DevOps: a personal access token with code read and write.
3. On the phone: Heute → the gear → Synchronisierung. Enter the same remote URL and branch as on the desktop,
   your name and e-mail for the commits, paste the token and tap „Token speichern“. The token goes into the
   Android Keystore (an AES key that never leaves it encrypts the token; only the encrypted value is kept in
   the app's private storage).
4. „Verbindung testen“ checks the URL and the token. „Jetzt synchronisieren“ takes over the repository's
   newest state (not its history, which holds every database copy the desktop synced): the desktop's notes
   appear as pages, the Netzpläne and meetings are taken over.
5. Switch on „Automatisch synchronisieren“: the app syncs when it starts, every 15 minutes while it is open
   and when it comes back to the front (at most every two minutes).

Conflicts are handled like on the desktop: a note changed on both sides keeps the server's version in the
repository until you decide. The phone shows it under Einstellungen → Konflikte: „Zusammenführen“ when the
changes do not overlap, else „Überall meine“, „Überall andere“ or „Beide behalten“; spot by spot works on
the desktop. Many deletions at once are held back until you confirm („Löschungen übertragen“), as on the
desktop.

A sync that Android ends in the middle (the app swiped away or stopped in the background), or one whose upload
fails after it took the desktop's changes, loses nothing: the next sync brings the desktop's changes again
instead of uploading the phone's older state over them, and git's lock files of an ended sync are removed at
once. A note being edited on the phone while a sync takes the desktop's text of it over keeps both: the
editor saves against the text it started from, and the two are merged.

## How it is built

- **Same core, same shell.** The Android app is the Tauri shell (`src-tauri`) built for Android with
  `arcalo-core`. Desktop-only parts are not compiled for mobile: `appmenu`, `installer`, `jumplist`,
  `present`, `rebrand`, `rollback` (`#[cfg(desktop)]`), and `desktop`, `notifyact`, `updates`, `voice` are
  replaced by small stand-ins in `src-tauri/src/mobile/` (`#[cfg_attr(mobile, path = …)]`). The desktop-only
  crates (tray-dependent plugins, global shortcuts, updater, autostart, single instance, clipboard, Whisper,
  audio input) are target dependencies for non-mobile targets only. `run()` is the desktop's; the app's entry
  point is `mobile::run()` (`#[tauri::mobile_entry_point]`) with its own setup and the list of commands the
  phone uses.
- **UI.** `ui/src/mobile/` is a shell of its own (tab bar, screens, Android's back button through Tauri's
  `onBackButtonPress`, see `backAction` in `mobile/model.ts`) with a page of its own: the Android window opens
  `mobile.html` (`src-tauri/tauri.android.conf.json`), whose entry `ui/src/mobile/main.tsx` loads the mobile
  shell, the design tokens and `mobile.css`, never the desktop app's bundle and stylesheets (1.19: 1.46 MB
  in 11 files at the start instead of 3.44 MB in 69, of it 36 KB of CSS instead of 499 KB); it uses the desktop's API
  wrappers, i18n catalogs (`mob.*` keys), design tokens, Markdown rendering, task and capture helpers.
  Editing a page is plain Markdown text in v1: the TipTap editor's menus, popovers and drag handles are
  built for a pointer and a keyboard.
- **Git without a git program.** The desktop runs the system `git`. A phone has none, so with the feature
  `embedded-git` (on for Android) the same git commands run on libgit2 (`crates/arcalo-core/src/gitlib.rs`):
  the sync code, its conflict handling and its guards are unchanged, and the sync's tests run on both
  (`ARCALO_TEST_EMBEDDED_GIT=1`). HTTPS uses OpenSSL, built from source like the SQLCipher encryption needs
  anyway; the certificates are the Android system's (`/system/etc/security/cacerts`, the updatable store of
  Android 14), else Mozilla's root store compiled in, plus the certificates the user installed
  (Einstellungen → Sicherheit → Verschlüsselung & Anmeldedaten): the app's network security config
  (`res/xml/network_security_config.xml`) trusts them, which is how Android lets an app accept a company
  proxy's own certificate, and `ShellPlugin.kt` (`userCertificates`, `AndroidCAStore` entries `user:…`)
  passes them to `gitlib::set_user_certificates`. The token is given to the server when it asks for
  credentials (HTTP Basic, `x-access-token`), never written to `.git/config`.
- **Proxy (1.19).** When the app has no proxy of its own (the network profile of the Git sync is in mode
  „System“, the default), the Git sync uses Android's proxy: `ConnectivityManager.getDefaultProxy` (the global
  proxy, else the one of the network in use, e.g. a Wi-Fi's own proxy) with its exclusions, read by
  `ShellPlugin.kt` (`proxy`) before each sync and every minute and set with `network::set_platform_proxy`;
  from there it takes the desktop's path (`git_network` → libgit2's proxy options). A PAC script runs in
  Android's own local proxy, which Android names as the proxy; a PAC address without it is logged and the
  connection is direct. libgit2 sends HTTPS through the proxy (`CONNECT`); a plain `http://` remote is
  reached directly.
- **HTTP clients** (`network::client_for`) check certificates against Mozilla's root store on Android: the
  platform verifier of rustls needs the app's JVM context there.
- **Secrets.** `secrets.rs` has a Keystore backend on Android (`mobile/keystore.rs` and the Kotlin plugin
  `SecretsPlugin.kt` in `src-tauri/gen/android`).
- **Window and updates.** `mobile/android.rs` talks to two more Kotlin plugins: `ShellPlugin.kt` (the
  colors behind the system bars after the app's theme, the app to the background on the root's back
  button, text shared to the app) and `UpdatePlugin.kt` (what Android knows about the installed app and a
  downloaded APK, metered network, the permission to install apps, the hand-over to the installer).
- **Android project.** `src-tauri/gen/android` is generated by `cargo tauri android init` and committed as
  Tauri recommends, with the app's changes: the Keystore, window and update plugins, the share target, insets for the system bars and the keyboard,
  window colors of the app, the launcher icon from the Arcalo mark, no backup of the app data (the Keystore
  key does not travel with a backup), release signing from `keystore.properties`.

## Building

CI builds the APK (`.github/workflows/android.yml`, see `docs/release/android.md`). Locally, with the Android
SDK, NDK and Java 17:

```
rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
export ANDROID_HOME=… NDK_HOME=…
cd src-tauri && cargo tauri android build --apk --target aarch64
cargo tauri android dev        # on a connected device or an emulator
```

The UI alone in a browser at phone size, with fixtures instead of the app (also the screenshot check):

```
npm --prefix ui run build
node e2e/mobile/shots.mjs --out /tmp/arcalo-shots
```

It taps through every screen at 360x800 and 412x915 in light and dark (and in high contrast, at 360x640,
430x932, in landscape, on tablets and with Android's font size at 130 %), checks touch targets, sideways
overflow, console errors, the back button, the update banner and its permission flow, shared text, the
keyboard and that every command the UI invokes is registered for Android. Look at the screenshots.

## Updates

The app updates itself from the GitHub release (`mobile/apkupdate.rs`, `arcalo_core::update_android`;
the release side is docs/release/android.md → Updates of the app):

1. It asks `android-latest.json` of the latest release at the start, then once a day while it runs, and on
   Einstellungen → Updates → „Nach Updates suchen“.
2. A newer version with a higher version code is downloaded in the background into the app's cache, on
   Wi-Fi only unless „Updates auch über mobile Daten laden“ is on or the user taps „Jetzt über mobile Daten
   laden“; an interrupted download continues where it stopped.
3. Before anything is offered: the minisign signature of the file with the update key compiled into the
   release build (the desktop's key) and the version named in it; the package, the version code and the
   signing certificate as Android reads them from the file. A file that fails is deleted.
4. „Version … ist bereit“: a notification and the banner on Heute with „Was ist neu“ (the release notes) and
   „Update installieren“. One tap opens Android's installer, which asks for confirmation; the first time
   Android also wants the permission „Unbekannte Apps installieren“ for Arcalo, which the app explains and
   opens. Notes, settings and the token stay (it is an update of the same app).
5. A version signed with another APK key (the debug-signed APKs before the release key) cannot be installed
   over the app; the app says so and links the release page instead of failing in the installer.

The preferences of the updater (mobile data, the last check) are in `android-update.json` in the app's data
folder: they belong to this phone and never sync.

## Limits of v1

- The Kotlin plugins (Keystore, window, updates) are reviewed against Tauri's plugin API but compiled only by
  the CI workflow; the Rust side is type-checked for Android on the host. None of it has run on a
  device yet: see the manual checklist in docs/release/android.md.
- Bookings made on the phone reach the desktop's time tracking only through „Erneut buchen“ on their chip.
- Meetings and Netzpläne need „Datenbank mitsichern“ on the desktop; an encrypted database copy is skipped.
- HTTPS remotes only (no SSH keys on the phone); a pinned server key (Einstellungen → Netzwerk on the desktop)
  is not supported by the built-in git and refuses the connection.
- No app lock and no database encryption on the phone yet; the data lives in the app's private storage.
