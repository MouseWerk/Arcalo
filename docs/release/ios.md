# Releasing the iOS app

Owner decision (CLAUDE.md): the iPhone and iPad app ships through TestFlight and the App Store, with the Apple
Developer Program membership already paid for Arcalo Mail (the same team). How the app is built and what it does:
[../ios.md](../ios.md). Store texts: [../store/app-store.md](../store/app-store.md).

Never paste a key, a password, a certificate or a profile into a chat, an issue or a commit: they go into the
GitHub secrets of MouseWerk/Arcalo and an offline backup only.

## What CI does

`.github/workflows/ios.yml`, called by CI on every push and by the release with its tag:

| | Without the secrets | With the secrets |
|---|---|---|
| Every push | the iOS code linted for the device, the Xcode project generated, a debug build for the simulator checked on an iPhone, a 13" iPad Pro and an iPad mini, upright and sideways (artifacts `ios-simulator` with the screenshots, `ios-xcode-project`) | the same, plus the signed archive exported for App Store Connect (artifact `arcalo-ios`, the `.ipa`) |
| A release (`release.yml`) | the same as a push | the `.ipa` of the tag uploaded to TestFlight (needs the three App Store Connect secrets too) |

Without the secrets the signing steps are skipped with a notice; the job stays green. The version is the tag's
(`CFBundleShortVersionString` 1.22.0), the build number the workflow's run number (App Store Connect needs it to
grow). The iOS app is not attached to the GitHub release.

## Owner checklist (once)

1. **Apple Developer account:** the membership of Arcalo Mail (same team). Note the **Team ID**
   (developer.apple.com → Account → Membership details).
2. **App ID:** Certificates, Identifiers & Profiles → Identifiers → **+** → App IDs → App → description *Arcalo*,
   explicit bundle ID **`de.mousewerk.arcalo`**. Capabilities: none to add (background fetch, local notifications
   and the Keychain need no capability; there is no push server, no App Group, no iCloud).
3. **Distribution certificate:** the *Apple Distribution* certificate of Arcalo Mail's team serves this app too
   (one per team). Export it with its private key as a `.p12` (Keychain Access, or the OpenSSL steps in Arcalo
   Mail's docs/release-mobile.md) if it is not at hand as a file.
4. **Provisioning profile:** Profiles → **+** → Distribution → **App Store Connect** → App ID `de.mousewerk.arcalo`
   → the distribution certificate → name *Arcalo App Store* → download the `.mobileprovision`. A renewed
   certificate needs a new profile.
5. **App Store Connect app record:** appstoreconnect.apple.com → Apps → **+** → New App: platforms iOS, name
   *Arcalo* (if taken: *Arcalo Notes & Time*), primary language English (U.S.) with German as a localization,
   bundle ID `de.mousewerk.arcalo`, SKU `arcalo`, full access. The texts, the age rating (4+), the privacy answers
   (Data Not Collected) and the review notes are in [../store/app-store.md](../store/app-store.md).
6. **App Store Connect API key:** Users and Access → Integrations → App Store Connect API → Team Keys. The key of
   Arcalo Mail's CI (access *App Manager*) works for every app of the team; else **Generate API Key**, name *CI*,
   access *App Manager*, download the `.p8` (only once) and note the **Key ID** and the **Issuer ID**.
7. **GitHub secrets** (MouseWerk/Arcalo → Settings → Secrets and variables → Actions → New repository secret):

   | Secret | Value |
   |---|---|
   | `APPLE_TEAM_ID` | the Team ID (10 characters) |
   | `IOS_CERTIFICATE_BASE64` | `base64 -i distribution.p12` (macOS) or `base64 -w0 distribution.p12` (Linux) |
   | `IOS_CERTIFICATE_PASSWORD` | the password of the `.p12` |
   | `IOS_PROVISIONING_PROFILE_BASE64` | `base64 -i "Arcalo_App_Store.mobileprovision"` |
   | `APP_STORE_CONNECT_API_KEY_ID` | the Key ID |
   | `APP_STORE_CONNECT_ISSUER_ID` | the Issuer ID |
   | `APP_STORE_CONNECT_API_KEY_BASE64` | `base64 -i AuthKey_<KEYID>.p8` |

   The next push builds the signed `.ipa` (check: the run's artifact `arcalo-ios`); the next release uploads it to
   TestFlight.
8. **Privacy policy page** on the website (the App Store needs a URL): see the text in the store file.
9. **TestFlight:** after the first upload (processing takes 10 to 30 minutes), App Store Connect → TestFlight →
   add yourself as an internal tester; external testers need a short beta review.
10. **Screenshots** for the version page: 6.9" iPhone (1320 × 2868), 13" iPad (2064 × 2752); the simulator check's
    screenshots (artifact `ios-simulator`) show the layout, the store pictures are taken with sample notes.
11. **Submit for review** from the version page once TestFlight looks right.

## Manual checklist on a device (each release)

What the simulator cannot show; on an iPhone and an iPad (with a Magic Keyboard or trackpad if at hand):

- [ ] First start: the phone app on the iPhone, the full app on the iPad; nothing under the status bar, the
      notch or the home indicator, upright and sideways.
- [ ] iPad Split View: half and two thirds show the full app, a third and Slide Over the phone app; dragging the
      divider switches once it rests, typed text stays. Stage Manager: a resized window follows.
- [ ] Git sync: remote URL, token („Token speichern“ says „Im iOS-Schlüsselbund abgelegt“), „Verbindung testen“,
      „Jetzt synchronisieren“; the token is still there after a restart of the device.
- [ ] Background sync: with „Automatisch synchronisieren“ on, a change on the desktop arrives after the app was in
      the background for a while (Settings → Allgemein → Hintergrundaktualisierung on for Arcalo).
- [ ] A focus session's end: the notification with „+5 Min.“ and „Pause“ (both work without opening the app);
      the morning briefing's „Öffnen“.
- [ ] Files: insert an image and a PDF from Files and from iCloud Drive; export the time tracking to Files;
      „Öffnen“ on an attachment shows the share sheet (on the iPad in the middle of the window).
- [ ] Sharing to Arcalo: a `.md` file from Files („Teilen“ → Arcalo) opens a capture on the iPhone and lands in the
      Posteingang on the iPad; a shortcut with `arcalo://capture?text=Test`.
- [ ] Drag an image from Photos into a note on the iPad (Split View).
- [ ] Hardware keyboard: Cmd+K opens the palette, Cmd+click selects several pages in the tree, the arrow keys
      move in lists; trackpad hover tints rows.
- [ ] Apple Pencil in a drawing: pen strokes draw, the finger pans.
- [ ] Über Arcalo says that the App Store updates the app; no voice notes, no APK update anywhere.
