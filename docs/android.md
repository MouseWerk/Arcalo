# Arcalo for Android (companion app)

The Android app is a companion to Arcalo on the desktop, not the whole desktop app on a phone. It shows
what matters during the day and keeps your notes in step with the desktop through the same Git repository.

Application id: `de.mousewerk.arcalo` (the identifier the desktop takes with 1.15, see
`docs/quality/plan115-rename.md`). Minimum Android version: 8.0 (API 26).

## What it does

| Screen | What you can do |
|---|---|
| **Heute** | Date, time booked today against the day's target (holidays and absences included) and this week, the running timer (pause, stop), today's meetings (from the desktop's calendars, see below), tasks due today or overdue, the way to the daily note. A notice when the last sync failed or a note needs merging. |
| **Erfassen** (the + in the tab bar) | A note or tasks into today's daily note or the inbox (due dates: today, tomorrow, next week, or typed like on the desktop: `due:morgen`, „bis Fr“), or a booking. |
| **Tagesnotiz** | The daily note of a day, read or edited, previous and next day. A day without a note shows „Tagesnotiz anlegen“: the phone creates a daily note only when you start one, so it does not meet the desktop's note of the same day as a conflict. A daily note pulled from the desktop becomes the phone's daily note of that day. |
| **Aufgaben** | Open tasks grouped like the desktop's task view (overdue, today, this week, later, no date), „Fällig“ (up to this week) and the tasks done in the last 14 days. One tap ticks a task off; a repeating task gets its next date in its note, as on the desktop. |
| **Zeit** | The timer (start on a reference, pause, stop, discard), a booking with the desktop's `/zeit` syntax built from a form (the references booked last as chips, Netzpläne and Vorgänge as suggestions, Leistungsart, description, today or yesterday; the line is shown before booking), and this week's bookings per day. |
| **Notizen** | Search, recently edited pages, the page tree; a page is shown rendered from its Markdown (tables, code, links, `/zeit` chips and due dates as small labels, embedded drawings and PDFs as a note that they show on the desktop) and edited as Markdown text. |
| **Einstellungen** | Git sync (remote URL, branch, author, access token, automatic sync, test, sync now, deletions held back, conflicts), appearance (system, light, dark), language (system, German, English), about. |

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
4. „Verbindung testen“ checks the URL and the token. „Jetzt synchronisieren“ clones the repository: the
   desktop's notes appear as pages, the Netzpläne and meetings are taken over.
5. Switch on „Automatisch synchronisieren“: the app syncs when it starts, every 15 minutes while it is open
   and when it comes back to the front (at most every two minutes).

Conflicts are handled like on the desktop: a note changed on both sides keeps the server's version in the
repository until you decide. The phone shows it under Einstellungen → Konflikte: „Zusammenführen“ when the
changes do not overlap, else „Überall meine“, „Überall andere“ or „Beide behalten“; spot by spot works on
the desktop. Many deletions at once are held back until you confirm („Löschungen übertragen“), as on the
desktop.

## How it is built

- **Same core, same shell.** The Android app is the Tauri shell (`src-tauri`) built for Android with
  `arcalo-core`. Desktop-only parts are not compiled for mobile: `appmenu`, `installer`, `jumplist`,
  `present`, `rebrand`, `rollback` (`#[cfg(desktop)]`), and `desktop`, `notifyact`, `updates`, `voice` are
  replaced by small stand-ins in `src-tauri/src/mobile/` (`#[cfg_attr(mobile, path = …)]`). The desktop-only
  crates (tray-dependent plugins, global shortcuts, updater, autostart, single instance, clipboard, Whisper,
  audio input) are target dependencies for non-mobile targets only. `run()` is the desktop's; the app's entry
  point is `mobile::run()` (`#[tauri::mobile_entry_point]`) with its own setup and the list of commands the
  phone uses.
- **UI.** `ui/src/mobile/` is a shell of its own (tab bar, screens, navigation with Android's back button
  through the browser history), loaded only on Android as a separate chunk; it uses the desktop's API
  wrappers, i18n catalogs (`mob.*` keys), design tokens, Markdown rendering, task and capture helpers.
  Editing a page is plain Markdown text in v1: the TipTap editor's menus, popovers and drag handles are
  built for a pointer and a keyboard.
- **Git without a git program.** The desktop runs the system `git`. A phone has none, so with the feature
  `embedded-git` (on for Android) the same git commands run on libgit2 (`crates/arcalo-core/src/gitlib.rs`):
  the sync code, its conflict handling and its guards are unchanged, and the sync's tests run on both
  (`ARCALO_TEST_EMBEDDED_GIT=1`). HTTPS uses OpenSSL, built from source like the SQLCipher encryption needs
  anyway; the certificates are the Android system's (`/system/etc/security/cacerts`, the updatable store of
  Android 14), else Mozilla's root store compiled in. The token is given to the server when it asks for
  credentials (HTTP Basic, `x-access-token`), never written to `.git/config`.
- **HTTP clients** (`network::client_for`) check certificates against Mozilla's root store on Android: the
  platform verifier of rustls needs the app's JVM context there.
- **Secrets.** `secrets.rs` has a Keystore backend on Android (`mobile/keystore.rs` and the Kotlin plugin
  `SecretsPlugin.kt` in `src-tauri/gen/android`).
- **Android project.** `src-tauri/gen/android` is generated by `cargo tauri android init` and committed as
  Tauri recommends, with the app's changes: the Keystore plugin, insets for the system bars and the keyboard,
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

## Limits of v1

- The first real build is the CI workflow: the Kotlin plugin, the insets and the libgit2/OpenSSL build for
  Android have been type-checked and unit-tested on the host, not run on a device yet.
- Bookings made on the phone reach the desktop's time tracking only through „Erneut buchen“ on their chip.
- Meetings and Netzpläne need „Datenbank mitsichern“ on the desktop; an encrypted database copy is skipped.
- HTTPS remotes only (no SSH keys on the phone); a pinned server key (Einstellungen → Netzwerk on the desktop)
  is not supported by the built-in git and refuses the connection.
- No app lock and no database encryption on the phone yet; the data lives in the app's private storage.
