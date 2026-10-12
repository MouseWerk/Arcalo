# Android APK

The workflow `.github/workflows/android.yml` builds the companion app (docs/android.md) as one universal APK
for arm64, armv7 and x86_64 on every push to `main` that touches `src-tauri`, `crates`, `ui` or the workflow,
and by hand (Actions → Android → Run workflow). The APK is attached to the run as the artifact
`arcalo-android-apk` (`Arcalo_<commit>_android.apk`).

Before the APK the workflow runs the sync's tests on libgit2 (the phone's git), so a change that breaks the
phone's sync fails there first.

## Signing

Android installs an update of an app only when it is signed with the same key as the installed one. The
release key is created once and kept forever; losing it means users have to uninstall the app (and lose its
local data) to install a newer one.

Without the secrets below the workflow signs with a debug key and says so in a notice: such an APK installs
for a test, but a later release APK cannot update it.

### Create the key (once)

With the `keytool` of a JDK (17 or newer):

```
keytool -genkeypair -v \
  -keystore arcalo-release.jks \
  -alias arcalo \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Maurice Kleindienst, O=MouseWerk, C=DE"
```

`keytool` asks for the keystore password and the key password (use two long random passwords, e.g. from a
password manager). Keep `arcalo-release.jks` and both passwords in the password manager and a second safe
place. Never commit the file (`*.jks` and `keystore.properties` are ignored in `src-tauri/gen/android`).

The certificate's fingerprint (for app stores and for checking a downloaded APK later):

```
keytool -list -v -keystore arcalo-release.jks -alias arcalo | grep SHA256
```

### Add the four repository secrets

GitHub → the repository → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE` | the keystore as Base64: `base64 -w0 arcalo-release.jks` (Linux), `base64 -i arcalo-release.jks` (macOS), `[Convert]::ToBase64String([IO.File]::ReadAllBytes("arcalo-release.jks"))` (PowerShell) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `arcalo` |
| `ANDROID_KEY_PASSWORD` | the key password |

The next run signs with this key (the log says „Signing with the release key.“). The key file and
`keystore.properties` exist only in the runner's temporary folder during the build and are removed at the
end.

Check a signed APK:

```
apksigner verify --print-certs Arcalo_<commit>_android.apk
```

The SHA-256 of the signer must be the fingerprint above.

**Until the four secrets exist, no installed APK can be updated.** Each CI run makes a new debug key, and
Android installs a newer APK over the app only with the same key. The release APKs so far were debug-signed
(1.16 and 1.17 for certain; from 1.18 on the release run warns „Debug-signed release APK“). The app recognizes
such an update before the
download and explains it (synchronize, uninstall, install the new version from the release page). Once the
release key is in place, the first release-signed APK has to be installed that way one last time; from then
on the app updates itself.

## Releases

`release.yml` calls `android.yml` with the tag: the APK is built with the release version (the version code
follows it: 1.18.0 → 1018000) and attached to the release as `Arcalo_<version>_android.apk`. The APK is not
advertised on the website or in the README (owner decision); the release page and the app's own update
carry it.

## Updates of the app

The app checks for a new version itself (src-tauri/src/mobile/apkupdate.rs, docs/android.md → Updates):

1. **Signature.** With the secret `TAURI_SIGNING_PRIVATE_KEY` (the desktop's update key, the same secret and
   password the desktop builds use), `android.yml` compiles the public key `src-tauri/updater.pub` into a
   release APK (`ARCALO_UPDATER_PUBKEY`, as the desktop) and signs the APK with
   `cargo tauri signer sign --app-version <version>`: `Arcalo_<version>_android.apk.sig`, a minisign
   signature whose signed comment names the version. Builds without the key (pushes to `main`) never check
   for updates.
2. **Feed.** The publish job of `release.yml` writes `android-latest.json` next to `latest.json`:
   version, version code, package and signing certificate (package and version code read with `aapt2`; the
   certificate's SHA-256 from the APK Signing Block, v3 before v2, by `scripts/apk-signer.mjs`, compared with
   `apksigner`, whose output and errors the log shows; 1.18.1 had no feed because build-tools 37's
   `apksigner` prints „V2 Signer: certificate SHA-256 digest“ instead of „Signer #1 …“), the APK's address and
   size, its signature and the release notes. The feed is written for a debug-signed APK too (no `ANDROID_*`
   secrets): the app compares the certificate with its own and explains instead of offering an update from
   another key. When the certificate or the package cannot be read, a warning says so and there is no
   Android feed. A file of its own rather than an
   `android` entry in `latest.json`: the desktop's feed is read by Tauri's updater and by the app's own
   updater (`update_feed.rs`, which requires `url` and `signature` in every platform entry), and both stay
   untouched by fields only Android needs; a release whose APK failed has no Android feed and the phones
   simply see nothing new.
3. **On the phone.** The app asks
   `https://github.com/MouseWerk/Arcalo/releases/latest/download/android-latest.json`, compares the version
   and version code with the installed app and the signing certificate with its own, downloads on Wi-Fi
   (an interrupted download continues), checks the minisign signature with the compiled-in key and the
   signed version, lets Android read package, version code and certificate from the file, and only then
   offers „Update installieren“. A file that fails a check is deleted. The installer is Android's own
   (`ACTION_VIEW` on a FileProvider address in the app's cache); Android asks the user to confirm, and once
   for the permission „Unbekannte Apps installieren“ for Arcalo.

## Checklist for Android (manual)

Before or after a release, on a phone with Android 8 or newer (and, if at hand, Android 14/15):

- Install the APK: opens without errors, the tab bar sits above the navigation bar, status and navigation bar
  have the app's colors in light, dark and with „Hoher Kontrast“, also when the app's theme differs from
  Android's; switching Android's dark mode while „Wie das System“ is chosen changes the app.
- The keyboard does not cover the capture field, the page editor or the token field.
- Back button and back gesture: in the page editor back ends editing (the text is kept), then closes the page,
  on another tab goes to Heute, on Heute sends the app to the background; reopening shows the same state.
- A link `[[…]]` in a note opens that page.
- Share text or a link from the browser to Arcalo: the capture opens with it.
- Zeit → „Verwerfen“ asks before it discards the running timer.
- Android's font size at the largest step: nothing is cut off or wider than the screen; landscape and a tablet.
- Einstellungen → Synchronisierung: remote URL, token, „Verbindung testen“, „Jetzt synchronisieren“: the
  desktop's notes appear; with „Datenbank mitsichern“ on the desktop, Netzpläne under Zeit and meetings under
  Heute. An SSH address is refused with the message that the phone needs HTTPS.
- Book `/zeit` on the phone, sync, sync the desktop: the chip is in the daily note, „Erneut buchen“ books it.
- Edit the same note on both sides, sync both: the conflict shows on the phone and can be decided.
- Close and reopen the app: the token is still set (Android Keystore).
- German and English.

Updates (needs two release-signed versions, e.g. a test tag; see „Signing“):

- Install version N. Einstellungen → Updates shows „Arcalo ist aktuell“ and the time of the last check.
- Publish N+1. On Wi-Fi the app downloads it within a minute of its start (or with „Nach Updates suchen“);
  the notification „Arcalo N+1 ist bereit“ appears (Android 13+: allow notifications when asked) and Heute
  shows „Update installieren“ with „Was ist neu“.
- On mobile data only: „Version N+1 wird im WLAN geladen“; „Jetzt über mobile Daten laden“ downloads it;
  with „Updates auch über mobile Daten laden“ it downloads by itself.
- Airplane mode during the download, then back: the download continues where it stopped.
- „Update installieren“ the first time: the notice „Arcalo darf noch keine Apps installieren“, „Einstellung
  öffnen“ leads to „Unbekannte Apps installieren“; after allowing it and coming back the installer opens.
  Confirm: the app restarts as N+1 with its data, token and settings.
- A debug-signed APK as N+1 (or N): the app explains the other signing key instead of offering the update.

