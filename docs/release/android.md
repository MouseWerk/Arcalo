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

## Releases (once the APK is verified on devices)

The APK is not part of `release.yml` yet. To attach it to a release, the Android job moves into the release
workflow (or `release.yml` calls `android.yml` with `workflow_call`) and:

1. builds with the release version: `cargo tauri android build --apk … --config '{"version":"<version>"}'`
   (the version code follows the version: 1.15.0 → 1015000);
2. requires the four secrets (a release is never debug-signed);
3. uploads `Arcalo_<version>_android.apk` and its `.sha256` to the release next to the desktop installers;
4. the website links the APK under „Android (Begleit-App)“ with the signer's fingerprint.

The desktop's update feed (`latest.json`) stays without the APK: Android updates come from the release page
(later from a store), the app never updates itself.

## Checklist for a new Android build (manual)

- Install the APK on a phone (Android 8 or newer): opens without errors, the tab bar sits above the
  navigation bar, the keyboard does not cover the capture field.
- Einstellungen → Synchronisierung: remote URL, token, „Verbindung testen“, „Jetzt synchronisieren“: the
  desktop's notes appear; with „Datenbank mitsichern“ on the desktop, Netzpläne under Zeit and meetings under
  Heute.
- Book `/zeit` on the phone, sync, sync the desktop: the chip is in the daily note, „Erneut buchen“ books it.
- Edit the same note on both sides, sync both: the conflict shows on the phone and can be decided.
- Close and reopen the app: the token is still set (Android Keystore).
- Light, dark and system theme; German and English.
