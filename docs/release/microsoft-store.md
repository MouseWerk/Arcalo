# Microsoft Store

Arcalo has no code-signing certificate, so the installer and the portable ZIP trigger SmartScreen ("Windows
protected your PC", unknown publisher). The Microsoft Store is the free way to a signed Windows install: individual
developers register without a fee, and the Store re-signs every MSIX package it publishes with a Microsoft
certificate. This page is the owner's checklist for the first submission and every release after it, and documents
how the Store build differs from the installer build.

## What is built

| | Installer / portable (`release.yml` → `build`) | Microsoft Store (`release.yml` → `store`) |
|---|---|---|
| Binary | `cargo tauri build` | `cargo build --release -p arcalo --features custom-protocol,store` |
| Package | NSIS `Arcalo_<v>_x64-setup.exe`, `Arcalo_<v>_x64-portable.zip` | `Arcalo_<v>_x64.msix` (packaging/msix/pack.ps1) |
| Signature | none (SmartScreen warns) | none on GitHub; the Store signs what it publishes |
| Updates | own updater (latest.json, rollback, install on quit) | Microsoft Store only |
| Autostart | Run key (`HKCU\...\Run`) | the package's startup task `ArcaloStartup` |
| Notification buttons | `arcalo-notify:` written to `HKCU\Software\Classes` | `arcalo-notify:` declared in the manifest |
| Portable mode | marker file next to the exe | off |
| Data | `%APPDATA%\de.mousewerk.arcalo` | the same folder (not virtualized, see below) |

The Store build is selected twice: at build time by the cargo feature `store`, and at run time by the package
identity (`GetCurrentPackageFullName` in `src-tauri/src/store.rs`). A regular binary that someone packs into an MSIX
therefore behaves like the Store build too. Debug builds pretend with `ARCALO_STORE=1` (the e2e test
`e2e/tests/150-store-build.test.js`).

In the Store build:

- **Updates:** no update check, no download, no install on quit, no rollback, no "Neu in Arcalo" after an update
  of the app's own updater (the Store updates the package, usually in the background). Settings → Über → Updates
  shows "Updates kommen über den Microsoft Store" and a button that opens the Store's downloads and updates page
  (`ms-windows-store://downloadsandupdates`). The organization's update policy (docs/admin/updates.md) is still read
  but has nothing to steer; organizations control Store updates with the Store's own policies.
- **Portable mode** is off (the program folder is the read-only package).
- **Autostart** (Settings → Desktop "Mit Windows starten", the first-run setup) switches the startup task
  through `Windows.ApplicationModel.StartupTask`. The task starts Arcalo without arguments; the app recognizes the
  start at sign-in from its activation kind and starts hidden in the tray as with `--minimized`. When the user
  turns the entry off in Windows Settings → Apps → Autostart (or Task Manager), Windows does not let the app turn it
  on again; the switch then says where to do it.
- **Notifications** use the package's app id (toasts under another id fail in a packaged process); the buttons
  come back through the declared `arcalo-notify:` protocol, as with the installer.
- **Taskbar:** the process keeps the package's app id (no `SetCurrentProcessExplicitAppUserModelID`); the jump
  list entries start Arcalo through its execution alias `Arcalo.exe` (a link into the package folder would start
  it without its package identity).
- **The rename from Annalo** (`rebrand.rs`, the NSIS hooks) does not apply: the package never had the old name, and
  the entries of an installed copy are left alone. The 1.15 copy of the old identifier's folders
  (`app.annalo.desktop` → `de.mousewerk.arcalo`, `identity.rs`) does run: the manifest excludes both from write
  virtualization, so the package sees the installer's real folders.
- **Global shortcuts, tray, quick capture, voice notes** work as in the installer build (full-trust Win32 process;
  the manifest declares the microphone so Windows privacy settings list Arcalo).

### Data folder and MSIX virtualization

A packaged desktop app's new files under `%APPDATA%`/`%LOCALAPPDATA%` normally go to a private per-package folder
that other programs cannot see and that Windows deletes with the package. For a notes app that would hide the data
from backups and lose it on uninstall, and the installer and Store versions would see different workspaces.
`AppxManifest.xml` therefore declares the restricted capability `unvirtualizedResources` and switches write
virtualization off: on Windows 11 only for `%APPDATA%\de.mousewerk.arcalo` and `%LOCALAPPDATA%\de.mousewerk.arcalo`
(the WebView profile), on Windows 10 (1903 or later, the package's minimum) for AppData as a whole. Consequences:

- The Store version opens the same workspace as an installed copy; both share the single-instance lock, so only
  one runs at a time. Uninstalling the Store version keeps the data (as the NSIS uninstaller does).
- Folders the user picks (data folder elsewhere, backup destinations, Markdown mirror, Git sync, attachments) are
  outside AppData and never virtualized. The log (`logs/`), whisper models (`models/`) and backups in the data
  folder follow the data folder.
- Registry writes to HKCU stay virtualized; the Store build writes none (no Run key, no URL class). Policies under
  `HKCU\Software\Policies` and `HKLM` are read normally.

If certification rejects `unvirtualizedResources`, removing it (and the two `FileSystemWriteVirtualization`
elements) keeps the app working, but its data then lives in
`%LOCALAPPDATA%\Packages\<package family name>\LocalCache\Roaming\de.mousewerk.arcalo` and is removed with the
package: tell users to choose a data folder in Settings → Daten before uninstalling.

## Requirements (researched October 2026)

- **Packaging:** a Win32 app in an MSIX declares `EntryPoint="Windows.FullTrustApplication"` and the restricted
  capability `runFullTrust`. The fourth part of the package version is reserved for the Store and must be `0`
  (`1.12.0` → `1.12.0.0`). Store submissions do not have to be signed; the Store re-signs MSIX packages after
  certification. `.msixupload` matters for UWP apps (symbols); a plain `.msix` is accepted for desktop apps, so the
  release attaches `Arcalo_<v>_x64.msix`.
  Sources: [App package requirements for MSIX](https://learn.microsoft.com/windows/apps/publish/publish-your-app/msix/app-package-requirements),
  [Desktop app extensions (startup task, protocol, alias)](https://learn.microsoft.com/windows/apps/desktop/modernize/desktop-to-uwp-extensions),
  [Understanding how packaged desktop apps run](https://learn.microsoft.com/windows/msix/desktop/desktop-to-uwp-behind-the-scenes),
  [Flexible virtualization](https://learn.microsoft.com/windows/msix/desktop/flexible-virtualization).
- **Tooling:** MakeAppx and MakePri from the Windows SDK, which is installed on the GitHub `windows-latest` images;
  `pack.ps1` takes the newest SDK it finds. Microsoft's newer `winapp` CLI ([microsoft/winappCli](https://github.com/microsoft/winappCli))
  wraps the same tools but is in preview, so the workflow calls the SDK tools directly. Tauri v2 has no MSIX bundle
  target (its Windows bundles are NSIS and MSI), so the package is built from the plain release binary; the
  frontend is embedded with the `custom-protocol` feature, and WebView2's loader is linked statically.
- **Policies** ([Microsoft Store Policies](https://learn.microsoft.com/windows/apps/publish/store-policies)):
  10.2.2 forbids changing the described functionality by downloading code, and an app updater in a Store package
  would install a second, unpackaged copy beside it (also 10.2.3), so updates come only through the Store. 10.5.1
  requires a privacy policy URL when the app transmits personal information (Arcalo connects to services the user
  sets up: AI providers, Jira, calendars, Git). 10.14: an individual account fits a single developer; a publisher
  name that reads like a company may lead certification to ask for a company account (see step 1).
- **WebView2:** part of Windows 10 (since 2021 updates) and Windows 11; the package does not bundle or bootstrap it.
  Minimum OS in the manifest: Windows 10 1903 (`10.0.18362.0`), the first version with `unvirtualizedResources`.
- **Registration:** free for individual developers since September 2025, with an ID and selfie check
  ([Windows Developer Blog](https://blogs.windows.com/windowsdeveloper/2025/09/10/free-developer-registration-for-individual-developers-on-microsoft-store/)).
- **Automation:** the Microsoft Store Developer CLI (`msstore`, [microsoft/msstore-cli](https://github.com/microsoft/msstore-cli))
  publishes an `.msix` through the Partner Center API with Microsoft Entra ID (Azure AD) app credentials; the action
  [microsoft/microsoft-store-apppublisher](https://github.com/microsoft/microsoft-store-apppublisher) installs it on
  a runner.

## First submission (once, by hand)

### 1. Register in Partner Center

1. Open [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com) and choose to register as an
   **individual** developer. Sign in with the personal Microsoft account that should own the app (it cannot be moved
   to another account type later).
2. Verify your identity: scan a government ID and take a selfie. No fee, no credit card.
3. Fill in the publisher display name. This is what the Store shows as the publisher and what goes into
   `PublisherDisplayName`. "Maurice Kleindienst" is the safe choice for an individual account; "MouseWerk" may be
   questioned in certification because policy 10.14 asks for a company account when a reasonable customer would read
   the publisher name as a business.

### 2. Reserve the name

Partner Center → **Apps and games** → **New product** → **MSIX or PWA app** → name **Arcalo** → **Reserve product
name**. (If it is taken, reserve "Arcalo Notes" or similar; the display name in the manifest must match a
reserved name, so change `DisplayName`/`ShortName` in `packaging/msix/AppxManifest.xml` too.)

### 3. Read the package identity

In the new product: **Product management** → **Product identity**. Copy:

| Partner Center | Example | Repository variable |
|---|---|---|
| Package/Identity/Name | `12345MouseWerk.Arcalo` | `STORE_IDENTITY_NAME` |
| Package/Identity/Publisher | `CN=1A2B3C4D-…` | `STORE_PUBLISHER` |
| Package/Properties/PublisherDisplayName | `Maurice Kleindienst` | `STORE_PUBLISHER_DISPLAY_NAME` |
| Store ID (top of the page, 12 characters) | `9NXXXXXXXXXX` | `STORE_PRODUCT_ID` (only for the automation) |

### 4. Set the repository variables

GitHub → MouseWerk/Arcalo → Settings → Secrets and variables → Actions → **Variables** → New repository variable:
`STORE_IDENTITY_NAME`, `STORE_PUBLISHER`, `STORE_PUBLISHER_DISPLAY_NAME` (exactly as copied, the publisher with
`CN=`). These are not secret. Until they are set, the release workflow's job "Build (Microsoft Store)" prints a
notice and builds nothing.

### 5. Build the package

Run the release (tag `v1.12.0`, or Actions → Release → Run workflow). The release then has
`Arcalo_1.12.0_x64.msix` attached. It is unsigned on purpose: users cannot install it from GitHub, it is only for
Partner Center. (To build it on a Windows machine instead: `npm --prefix ui run build`,
`cargo build --release -p arcalo --features custom-protocol,store`, then
`./packaging/msix/pack.ps1 -Exe target/release/arcalo.exe -Version 1.12.0 -IdentityName … -Publisher … -PublisherDisplayName … -OutDir dist`.)

Before the first upload, run the Windows App Certification Kit once on a Windows PC (below).

### 6. Create the submission

Partner Center → the product → **Start your submission**:

- **Pricing and availability:** Markets: all (or the ones you want); Visibility: public; Pricing: **Free**; Free
  trial: none.
- **Properties:** Category **Productivity** (subcategory none or "Notes"); Privacy policy URL:
  **https://arcalo.mousewerk.de/privacy-app** (the app's privacy page; German:
  https://arcalo.mousewerk.de/de/datenschutz-app; the site's general policy is `/privacy`). Website:
  https://arcalo.mousewerk.de; support contact: the GitHub issues page
  https://github.com/MouseWerk/Arcalo/issues. Product declarations: no accessibility claim unless tested; "This app
  depends on non-Microsoft drivers or NT services": no. System requirements: minimum 4 GB memory recommended,
  keyboard and mouse.
  The privacy page currently says the update check goes to GitHub; add a sentence that the Microsoft Store version
  does not check for updates itself (the Store updates it).
- **Age ratings:** the IARC questionnaire. Answers for Arcalo: category "Productivity/utility"; no violence, sex,
  drugs, gambling; **user-generated content shared with others: no** (notes stay local); **the app allows users to
  interact or exchange content: no**; **shares location: no**; **digital purchases: no**; unrestricted internet
  access: **yes** (links open in the browser; AI providers and web pages the user adds). Expected rating: 3+/USK 0
  (IARC may add "Unrestricted Internet").
- **Packages:** upload `Arcalo_1.12.0_x64.msix`. Device families: Windows 10/11 Desktop only.
- **Store listings:** add **English (United States)** and **German (Germany)** (the manifest declares en-US and
  de-DE). Texts below. Screenshots: at least 1, up to 10, PNG, **1366 x 768 or larger** (up to 3840 x 2160),
  each under 50 MB; four or more recommended. Use the light and dark theme, the start page, a note with links,
  the week view with `/time` bookings, the Kalender. The README screenshots (docs/screenshots) are a start but take
  fresh ones at 1920 x 1080 from the Store build. Optional: 1:1 box art 1080 x 1080 or 2160 x 2160 (the icon from
  docs/brand/arcalo-icon-1024.png on the dark background) and a 9:16 poster 720 x 1080.
- **Submission options → Notes for certification:** paste the text below.
- **Restricted capabilities:** Partner Center asks why the package declares `runFullTrust` and
  `unvirtualizedResources`; paste the justification below.

Submit. Certification usually takes one to three business days; the result and any report come by e-mail and in
Partner Center.

#### Certification notes (paste into "Notes for certification")

```
Arcalo is a desktop notes, tasks and time tracking app (Win32, built with Tauri/WebView2). No account or sign-in
is needed: start the app, the first-run setup asks for a language and theme, and all features work offline.
Optional integrations (Jira, AI providers, calendars, Git sync) need the tester's own servers and can be skipped.

The app does not update itself in this Store version: the in-app updater is compiled out and Settings > About >
Updates points to the Microsoft Store. Data is stored locally in %APPDATA%\de.mousewerk.arcalo.
Source code: https://github.com/MouseWerk/Arcalo
```

#### Restricted capability justification

```
runFullTrust: Arcalo is a classic Win32 desktop application (Rust, Tauri, Microsoft Edge WebView2) packaged with
the Desktop Bridge. It needs full trust for its tray icon, system-wide keyboard shortcuts for quick capture and
search, microphone recording for local speech-to-text, the Windows credential store for API keys, and reading and
writing user-chosen folders (backups, Markdown export, Git sync).

unvirtualizedResources: Arcalo keeps the user's notes database in %APPDATA%\de.mousewerk.arcalo, the same folder its
non-Store version uses. File-system write virtualization is turned off only for that folder (and the WebView2
profile in %LOCALAPPDATA%\de.mousewerk.arcalo) so that users who move from the downloadable version keep their
workspace, backup tools see the database, and the notes are not deleted when the app is uninstalled.
```

#### Store listing texts

English (United States):

- **Product name:** Arcalo
- **Short description:** Local-first notes, tasks and time tracking with SAP and Jira booking, calendar and optional AI.
- **Description:**

  ```
  Arcalo is a desktop app for Markdown notes that link to each other, tasks, daily notes and time tracking.

  - Notes with links, backlinks, tags, tables, boards and a graph of how everything connects
  - Tasks and daily notes in one place, with a start page you arrange yourself
  - Type /time in any note to book hours on an SAP PS activity or a Jira issue; export the weekly timesheet
    to SAP CATS, Jira, CSV or JSON
  - Meetings from Outlook and other calendars next to your booked time
  - Voice notes transcribed on your computer
  - AI from your own provider or a local model, only when you turn it on
  - Quick capture and search from anywhere with a global shortcut

  All data stays in one database on your computer: no account, no telemetry. Git sync and backups are optional.
  Arcalo is open source (github.com/MouseWerk/Arcalo).
  ```

- **What's new in this version:** the first line of the release notes (docs/releases/v<version>.md).
- **Keywords (up to 7):** notes, markdown, time tracking, timesheet, SAP, Jira, tasks

German (Germany):

- **Produktname:** Arcalo
- **Kurzbeschreibung:** Lokale Notizen, Aufgaben und Zeiterfassung mit Buchung auf SAP und Jira, Kalender und optionaler KI.
- **Beschreibung:**

  ```
  Arcalo ist eine Desktop-App für verknüpfte Markdown-Notizen, Aufgaben, Tagesnotizen und Zeiterfassung.

  - Notizen mit Links, Rückverweisen, Tags, Tabellen, Boards und einem Graphen der Zusammenhänge
  - Aufgaben und Tagesnotizen an einem Ort, mit einer Startseite, die du selbst zusammenstellst
  - Mit /zeit in einer beliebigen Notiz buchst du Stunden auf einen SAP-PS-Vorgang oder ein Jira-Issue; den
    Wochenzettel exportierst du nach SAP CATS, Jira, CSV oder JSON
  - Termine aus Outlook und anderen Kalendern neben der gebuchten Zeit
  - Sprachnotizen, auf deinem Rechner transkribiert
  - KI deines eigenen Anbieters oder ein lokales Modell, nur wenn du sie einschaltest
  - Schnellerfassung und Suche von überall mit einem globalen Tastenkürzel

  Alle Daten bleiben in einer Datenbank auf deinem Rechner: kein Konto, keine Telemetrie. Git-Sync und
  Sicherungen sind optional. Arcalo ist Open Source (github.com/MouseWerk/Arcalo).
  ```

- **Neuigkeiten in dieser Version:** die erste Zeile der Versionshinweise.
- **Suchbegriffe:** Notizen, Markdown, Zeiterfassung, Stundenzettel, SAP, Jira, Aufgaben

## Windows App Certification Kit (WACK)

CI runs WACK when the runner image has it (job "Windows installer", step "Windows App Certification Kit", report
in the artifact `arcalo-msix-test`); the GitHub images do not always include it. Locally, on Windows 10/11 with the
Windows SDK (the kit is the "Windows App Certification Kit" feature of the SDK installer):

```powershell
# An elevated PowerShell, in the repository after building the Store binary:
./packaging/msix/pack.ps1 -Exe target/release/arcalo.exe -Version 1.12.0 -OutDir dist `
  -IdentityName MouseWerk.Arcalo.Test -Publisher "CN=Arcalo Test" -PublisherDisplayName "MouseWerk"
& "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe" reset
& "${env:ProgramFiles(x86)}\Windows Kits\10\App Certification Kit\appcert.exe" test `
  -appxpackagepath dist\Arcalo_1.12.0_x64.msix -reportoutputpath dist\wack.xml
```

Or start "Windows App Cert Kit" from the Start menu → Validate Store App → choose the `.msix`. The report lists
each test with PASS/FAIL; the package does not need to be signed for WACK.

To install a test package by hand, sign it with a self-signed certificate whose subject equals `-Publisher` and
trust that certificate under Local Machine → Trusted People (the CI step "Pack the MSIX" shows the commands), then
`Add-AppxPackage dist\Arcalo_1.12.0_x64.msix`.

## Every release after the first

The tag builds `Arcalo_<v>_x64.msix` with the identity variables (job "Build (Microsoft Store)"). Then either:

- **By hand:** Partner Center → the product → **Update** (a new submission copies the last one) → Packages: remove
  the old package, upload the new `.msix` from the GitHub release → Store listings: "What's new in this version" in
  both languages → Submit. Customers get the update through the Store after certification.
- **Automatically:** create a Microsoft Entra ID (Azure AD) application for the Partner Center API: Partner Center →
  Account settings → User management → **Microsoft Entra applications** → create or add an application with the
  **Manager** role, then create a client secret (note its expiry). Add the repository **secrets**
  `PARTNER_CENTER_TENANT_ID`, `PARTNER_CENTER_SELLER_ID` (Account settings → Legal info → Seller ID),
  `PARTNER_CENTER_CLIENT_ID`, `PARTNER_CENTER_CLIENT_SECRET`, and the **variable** `STORE_PRODUCT_ID` (the Store
  ID). The job then runs `msstore publish Arcalo_<v>_x64.msix --appId <Store ID>` and leaves the submission as a
  **draft** (finish "What's new" and submit in Partner Center). With the variable `STORE_SUBMIT_COMMIT=true` it
  submits for certification right away.

The Store version must not be older than what the Store already has: the package version comes from the tag, so a
re-run of a release uploads the same version again (Partner Center rejects a lower one).

Unverified until the first CI and certification runs: the MSIX build, installation and launch run only on the
Windows runner (CI job "Windows installer"); whether certification accepts `unvirtualizedResources` (fallback
above); the startup task and toasts under the package identity were written against the Windows API documentation
and are checked by hand on a Windows PC after installing a test package (Settings → Desktop → "Mit Windows starten",
sign out and in; a task reminder with its buttons).
