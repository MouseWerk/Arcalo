# Arcalo for iPhone and iPad

One app for both. On the iPhone it is the companion of the phone app on Android: it shows what matters during
the day and keeps your notes in step with the desktop through the same Git repository. On the iPad (and in every
iPad window that is not narrow) it shows the full desktop app. It ships through TestFlight and the App Store, with
the Apple developer team of Arcalo Mail (owner decision, CLAUDE.md); the release side is
[release/ios.md](release/ios.md), the store texts are in [store/](store/).

Bundle id: `de.mousewerk.arcalo` (the application id of Android and the identifier of the desktop). Minimum
system: iOS and iPadOS 16. Universal (iPhone and iPad, `TARGETED_DEVICE_FAMILY` 1,2), every orientation on the
iPad, Split View, Slide Over and Stage Manager with freely sized windows (no `UIRequiresFullScreen`).

## Phone app or full app

The window opens the phone app's page (`mobile.html`, `src-tauri/tauri.ios.conf.json`), which asks which interface
fits (`ui/src/lib/uiswitch.ts`) and goes over to the full app's page (`index.html`) when that one fits, as on
Android (docs/android.md, „Phone app or full app“). iOS names only the device (`android_display` answers with
`ipad`, from `UIDevice.userInterfaceIdiom`, `src-tauri/src/mobile/ios.rs`); the sizes are the WebView's
(`withViewport`). The decision (`ui/src/lib/uimode.ts`, tested in `uimode.test.ts`):

| Situation | Interface |
|---|---|
| iPad, window at least 500 pt wide (full screen, half of Split View, two thirds, a Stage Manager window) | full app |
| iPad, a narrow window (Slide Over, a third of Split View, a narrow Stage Manager window; 320 to about 440 pt) | phone app |
| iPhone, upright and sideways (also the largest ones: the shorter side stays below 600 pt) | phone app |
| Einstellungen → Darstellung → „Oberfläche auf iPhone und iPad“: „Telefon“ or „Vollständig“ | that one |

On the iPad the full app stays until the window is 48 pt below its line; the page follows its own `resize`, so
dragging the Split View divider or resizing a Stage Manager window switches once the window rests. Before the page
goes over, the unsaved text is stored, as on Android.

## What works on iOS, and what is hidden

The shell registers the shared command list (`commands()` in `src-tauri/src/lib.rs`) on iOS as on Android; the
UI asks `app_capabilities` once (`platform: "ios"`, `Capabilities::ios()` in `src-tauri/src/platform.rs`: Android's
capabilities without the APK updates) and hides what does not exist instead of failing.

| Feature | iOS | How |
|---|---|---|
| Notes, tasks, daily notes, calendar, time tracking, projects, split panes, the file sidebar, the assistant | yes (full app) | as on Android's full app |
| Phone app (Heute, Erfassen, Tagesnotiz, Aufgaben, Zeit, Notizen, Einstellungen) | yes | `ui/src/mobile/`, the same as on Android |
| Git sync | yes, as a companion | libgit2 (`embedded-git`), HTTPS with an access token through the system's TLS (Secure Transport, the device's trust settings), see „Data“ below |
| Secrets (Git token, AI keys, proxy password, calendar addresses, Jira tokens) | iOS Keychain | `src-tauri/src/mobile/keychain.rs`: generic passwords, service `Arcalo`, readable after the first unlock, this device only (not in backups or iCloud Keychain) |
| Files: insert, import, export | yes | the system's document picker (the dialog plugin); `file://` addresses outside the sandbox are read and written inside their security scope (`picked.rs`, `ios::with_scope`) |
| „Öffnen“ on an attachment | the share sheet | `UIActivityViewController` with a copy: another app, „In Dateien sichern“, AirDrop, print; on the iPad a popover in the middle of the window |
| Sharing to Arcalo | text and Markdown files, `arcalo://capture?text=…` | a `.md` or `.txt` file shared to Arcalo („Teilen“ → Arcalo, „Öffnen in“) or a shortcut that opens `arcalo://capture?text=…`: the phone app opens a capture with the text, the full app puts it into the Posteingang (`lib/iosShare.ts`) |
| Drag and drop of files and images from other apps | yes (iPad) | WebKit hands the dropped files to the page; the editor, the workspace and the canvas take `DataTransfer.files` as in a browser |
| Notifications | yes, with buttons | `UNUserNotificationCenter` directly (`ios.rs`); the permission is asked with the first one. End of a focus session: „+5 Min.“ and „Pause“ (in the background); morning briefing: „Öffnen“ |
| Background sync | yes | `BGAppRefreshTask` `de.mousewerk.arcalo.sync` (where Android has none and syncs while open): asked for again after each run, at the earliest after 15 minutes; iOS decides when. It runs the open app's sync for at most 25 s |
| Proxy | the Wi-Fi's | `CFNetworkCopySystemProxySettings` for mode „System“ of the network settings (HTTPS proxy and its exceptions; a PAC address is shown, not evaluated, as on Android) |
| Safe areas | yes | the WebView fills the window's safe area (Auto Layout on `safeAreaLayoutGuide`, `ios::fit_webview`), so neither page, nor a dialog or overlay of it, reaches under the status bar, the notch, the home indicator or the rounded corners; the margins take the colors of the page's edges and the status bar's text the theme (`mobile_bars`; the phone app's header and tab bar, the full app's top and bottom edge, `lib/ios.ts` `followBars`). The pages' `env(safe-area-inset-*)` padding stays as a second line |
| Hardware keyboard and trackpad | yes | the iPad reports itself as a Mac to the WebView, so the shortcuts use Cmd as on macOS (`lib/platform.ts`, `IS_MAC`): Cmd+K the palette, Cmd+click selects in the tree. Hover styles apply to a connected trackpad or mouse (`(any-hover: hover)`, `lib/hoverMedia.ts`) |
| Apple Pencil | in drawings | Excalidraw switches to pen mode with the first Pencil stroke (pressure, the finger pans); the canvas boards take the Pencil as a pointer |
| Updates | App Store / TestFlight | no self-update (App Store rules): `androidUpdater` is off, the APK commands are not even registered on iOS (`#[cfg(target_os = "android")]`); Über Arcalo says that the App Store updates the app |
| Voice notes | hidden (`voice: false`) | see below |
| Command line, tray, global shortcuts, autostart, quick-capture and search windows, presenter window, window frame | hidden | do not exist on iOS |
| Local folders (data folder, backups and their destinations, Markdown copy, Obsidian vaults, calendar files, CA files, „Im Ordner zeigen“), programs as quick links, PAC scripts | hidden | the app sees only its sandbox; files go through the document picker |
| Database encryption and the app lock | hidden | as on Android; the data lives in the app's sandbox, which iOS encrypts with the device's passcode (Data Protection) |
| Outlook (COM, PowerShell), the desktop's shell integrations | hidden | Windows only |

**Voice notes are not in 1.x.** Whisper would run on the iPad (whisper.cpp has Metal and CPU paths), but not
as the desktop builds it: `whisper-rs-sys` decides Apple specifics with the build host's `cfg` instead of the
target's (it links `ggml-blas` for every build on a Mac host and takes the macOS branch for the iOS target), the
desktop's recording uses `cpal` without an `AVAudioSession`, the models are 75 MB to 1.5 GB (the medium model
alone is near the memory iOS allows an app on most iPhones before it ends it), and a recording stops when the app
goes to the background unless it holds the audio background mode, which App Review accepts only for audio the
user hears. Android hides voice notes for the same reasons of size and background. They need a build of their own
(a fixed `whisper-rs-sys` or whisper.cpp's own XCFramework, `AVAudioSession`, small models only); until then
`voice` is false and the ribbon, the palette and the settings show none of it.

## Data: the iPad syncs as a companion, with a database of its own

Decision: the iPad (and the iPhone) is a normal device with its own database, and its Git sync runs as a
*companion* (`SyncRequest::companion`), as Android's full app does. It is not a full sync peer of the desktop.

- **What syncs both ways:** the notes (pages, daily notes, tasks in them, attachments). The iPad edits them in the
  full editor; conflicts are handled as on the desktop.
- **What the iPad takes from the desktop:** projects, Netzpläne, Vorgänge, Leistungsarten and the meetings, read
  from the desktop's database copy in the repository (`arcalo-workspace.db`, „Datenbank mitsichern“) after every
  sync (`companion::import_reference`).
- **What stays on the iPad:** its own database (settings, calendar subscriptions, time bookings, the assistant's
  chats). Bookings reach the desktop's time tracking as time chips in the daily note („Erneut buchen“), as on
  Android.

Why not a full peer: the database copy in the repository is one binary SQLite file written by one desktop; Git
cannot merge two versions of it, so a second writer would overwrite the desktop's projects and time sheets (or
the other way round) at every sync, and the `Zeiterfassung/*.csv` files are the desktop's export of its own
bookings. A full peer needs a merge of the database by rows, which the desktop does not have either between two
desktops. The companion keeps the desktop's data as the desktop wrote it, which is safe, and needs no new sync
format.

## How it is built

- **Same core, same shell.** The iOS app is the Tauri shell (`src-tauri`) built for iOS with `arcalo-core` and
  `embedded-git` (`src-tauri/Cargo.toml`, `[target.'cfg(target_os = "ios")'.dependencies]`). The mobile parts are
  shared with Android (`src-tauri/src/mobile/`, `#[cfg(mobile)]`); where Android asks a Kotlin plugin
  (`android.rs`), iOS calls UIKit, BackgroundTasks, UserNotifications and CFNetwork through the Objective-C runtime
  (`objc2`, `ios.rs`), so the generated Xcode project needs no Swift of its own. `#[cfg(target_os = "ios")]` marks
  each difference: the Keychain instead of the Keystore (`secrets.rs`, `Kind::Keychain`), the device name
  (`ios-<model>-<id>`, `gitsync::device_name`), the share sheet instead of Android's „Öffnen mit“, the system's
  TLS instead of the CA bundle Android's libgit2 needs (`gitlib::init_tls` is Android's), no APK updater.
- **Tauri's notification plugin is not used on iOS:** it keeps the notifications of the running process in a map
  and stops the app when a notification of an earlier start is tapped (`notificationsMap[…]!` in its Swift
  handler). `ios.rs` posts them itself and owns the notification center's delegate.
- **The WebView's content process** can be ended by iOS when memory runs low in the background; the page then
  loads again (`on_web_content_process_terminate`) instead of staying blank.
- **The Xcode project** (`src-tauri/gen/apple`) is generated on the macOS runner, as for Arcalo Mail: `cargo tauri
  ios init --ci`, then `scripts/ios-project.py` puts in what Arcalo changes: the app icon and the launch screen
  (`src-tauri/ios/Assets.xcassets`, `LaunchScreen.storyboard`, made from the Arcalo mark by
  `scripts/ios-icons.py`: the full square of the brand icon's gradient, as iOS rounds the corners itself and the
  App Store refuses transparency), the privacy manifest (`src-tauri/ios/PrivacyInfo.xcprivacy`), the permission
  texts in German and English (`src-tauri/ios/*.lproj/InfoPlist.strings`) and the universal device family. The
  rest of the Info.plist comes from `src-tauri/Info.ios.plist` (background fetch and the task's identifier, the
  `arcalo` URL scheme, Markdown and text documents, local network, export compliance), which `cargo tauri ios
  build` merges in. The macOS `Info.plist` (the microphone of the voice notes) is left out of the iOS build. The
  generated project is the CI artifact `ios-xcode-project`; it is not committed, because Tauri's template changes
  with the CLI and a project made on Linux could not be checked.

## Building

CI (`.github/workflows/ios.yml`, called by `ci.yml` and `release.yml`) on a macOS runner:

1. `cargo clippy -p arcalo --lib --target aarch64-apple-ios -- -D warnings`: the iOS code, for the device.
2. The Xcode project as above, then a debug build for the simulator, unsigned:
   `cargo tauri ios build --target aarch64-sim --debug --no-sign`.
3. The simulator check (`scripts/ios-smoke.sh`): the runner's newest iPhone Pro, 13" iPad Pro and iPad mini (of
   the newest iOS runtime), each upright and sideways. The app is started with `ARCALO_SMOKE=1` (debug builds only; sideways
   with `ARCALO_SMOKE_ORIENTATION=landscape`: an iPhone window turns with `requestGeometryUpdate`); 10 and 20
   seconds after the start it runs `src-tauri/src/mobile/ios_smoke.js` in the WebView, adds the window's size,
   its safe-area insets and the WebView's frame, and writes the result to `smoke.json` in its data folder. An
   iPad turns only with the device (an app that supports multitasking cannot turn its window), so the script
   rotates the simulated device (Simulator's „Rotate Left“) before the sideways start. `scripts/ios-smoke-check.py`
   fails the job when the iPhone does not show the phone app or an iPad not the full app (with its ribbon), when
   the window is not in the expected orientation, when the WebView reaches outside the safe area, when the page
   overflows sideways, when a fixed control (not in a scrolling area) sits inside the page's own insets, or when
   the console has errors. The screenshots and reports are the artifact `ios-simulator`.
4. With the Apple secrets: the signed archive for App Store Connect (artifact `arcalo-ios`) and, for a release,
   the upload to TestFlight ([release/ios.md](release/ios.md)).

Locally on a Mac with Xcode, the iOS targets and XcodeGen:

```
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
brew install xcodegen
cd src-tauri
mv Info.plist Info.macos.plist.off      # the macOS microphone text stays out of the iOS app
cargo tauri ios init && python3 ../scripts/ios-project.py && (cd gen/apple && xcodegen generate)
cargo tauri ios dev                      # in a simulator or on a connected device
mv Info.macos.plist.off Info.plist
```

The phone app's browser check (`node e2e/mobile/shots.mjs`, docs/android.md) covers the phone screens on iOS too;
the full app with mobile capabilities is covered by `e2e/tests/400-android-full-app.test.js`.

## Limits of 1.x

- The simulator check covers the start, the choice of the interface and the geometry; a device is needed for the
  Keychain under Data Protection, the background sync (the simulator never runs a `BGAppRefreshTask` on its own),
  notifications and their buttons, the share sheet, files from iCloud Drive, Pencil and a hardware keyboard. The
  manual checklist is in [release/ios.md](release/ios.md).
- Shortcuts that iPadOS keeps for itself (Cmd+Tab, Cmd+Space, Cmd+H) do not reach the app; the others go to the
  WebView as on a Mac. Holding Cmd shows no list of the app's shortcuts (no `UIKeyCommand`s); the palette lists
  them.
- No share extension: sharing a web page or a selection from another app needs one (an extension target with an
  App Group and a provisioning profile of its own). Files and `arcalo://capture?text=…` work without it.
- HTTPS remotes only (no SSH keys), a pinned server key is refused, and the extra CA of the network profile is not
  used: a company CA is installed and trusted in iOS's settings (Allgemein → Info → Zertifikatsvertrauenseinstellungen).
- Voice notes, the database encryption and the app lock are not in 1.x (above).
