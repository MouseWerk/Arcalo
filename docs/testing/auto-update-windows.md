# Auto-update: manual checklist (Windows, macOS, Linux)

The automated tests cover the update logic against a local feed (`e2e/tests/95-update-feed.test.js`) and a real
AppImage update on Linux (section „Linux“ below). What only a real machine shows is listed here. Run it before
publishing a release that changes the update path, and at least once per minor release.

Up to 1.6 the app was called Annalo: its files are named `Annalo_…`. The update from 1.6 to 1.7 (the rename)
has its own checklist in `rebrand-windows.md`.

Since 1.9 the default mode is „Automatisch“ (background download, install on quit). Sections 1–8 test the
click-to-install flow: set Settings → Über → Updates to „Nur benachrichtigen“ first. The automatic flow, the
rollback after failed starts, organization policies and „Diese Version überspringen“ have their checklist in
`docs/releases/v1.9.0.md`; the background is in `docs/admin/updates.md`.

## Before you start

- A signed release of the **previous** version installed (e.g. 1.5.0), and the **new** version published as a
  GitHub release with `latest.json` (or a draft release plus a test feed, see „Test feed“).
- Settings → Über shows „Automatische Updates“ with the switch „Automatisch nach Updates suchen“. If it says
  „nicht eingerichtet“, the build has no update key: that build cannot be used for these tests.
- Keep the log open: Settings → Über → „Protokoll“ (or `arcalo.log` in the data folder). Every failed check,
  download or install is logged with source `update` and the technical detail.
- Note for each row: pass/fail, version before/after, and anything the user saw that was unclear.

## Windows

### 1. Per-user install (the default installer)

1. Install 1.5.0 with the normal setup (no admin prompt; lands in `%LOCALAPPDATA%\Programs\Arcalo`).
2. Start Arcalo, open a note, type a sentence and **do not wait** for the save indicator.
3. Settings → Über → „Jetzt nach Updates suchen“. Expected: toast „Version 1.6.0 verfügbar“, „Was ist neu?“
   shows the release notes.
4. Click „Installieren und neu starten“. Expected: „Offene Notizen werden gespeichert …“, then the progress bar
   with percent and size, then „wird installiert“. The window disappears, the tray icon disappears (no dead
   icon left in the notification area), the installer runs with its progress window only (passive mode) and
   Arcalo starts again by itself.
5. After the restart: toast „Arcalo wurde auf Version 1.6.0 aktualisiert“, Settings → Über shows 1.6.0, the
   sentence from step 2 is in the note, the tabs are restored.
6. Start menu entry and desktop shortcut still start Arcalo; there is only one entry in „Apps & Features“.

### 2. Per-machine install

1. Install 1.5.0 for all users (e.g. deployed by IT into `C:\Program Files\Arcalo`).
2. Run the update as in 1. Expected: the updater's installer is per-user; check what happens and record it:
   either the per-machine copy is updated (with a UAC prompt), or a second per-user copy is installed.
   A second copy is a bug report (two entries in „Apps & Features“, two start menu entries).

### 3. Running with unsaved text

1. Type into a note, into a page title and into the quick capture window (leave it open), and start a timer.
2. Install the update from the toast.
3. Expected: nothing typed is lost after the restart; the timer is still running (or stopped with its time
   booked, as after a normal quit). If a note could not be saved, a dialog „Nicht gespeicherte Änderungen“
   asks before anything is downloaded; „Abbrechen“ keeps the app running and the toast offers the update again.

### 4. UAC prompt denied

Only with a per-machine copy (2.) or when the installer asks for admin rights.

1. Install the update and click „Nein“ in the UAC prompt.
2. Expected: Arcalo either stays open with „Installation fehlgeschlagen“ and keeps saving normally (type a note,
   restart Arcalo by hand, the note is there), or it has closed and, when started by hand, shows the warning
   „Update auf Version 1.6.0 nicht installiert“ and runs 1.5.0 without data loss.
3. Check that the tray icon and the global shortcuts work again after that start.

### 5. The update toast while offline

1. Disconnect the network (flight mode or unplug), start Arcalo, wait 30 s.
2. Expected: no toast and no error for the automatic check (it stays quiet); the log has „Update-Prüfung
   fehlgeschlagen“.
3. Settings → Über → „Jetzt nach Updates suchen“. Expected: „Keine Verbindung zum Update-Server (offline, oder
   Proxy unter Einstellungen → Netzwerk prüfen)“.
4. Start the download, then disconnect halfway. Expected: after at most a minute „Download fehlgeschlagen: Die
   Verbindung wurde unterbrochen“ (or „Zeitüberschreitung“), the toast offers the update again, nothing changed.

### 6. Corporate proxy with its own CA

1. Behind a TLS-inspecting proxy: Settings → Netzwerk, proxy mode (system, manual or PAC) and „Eigenes
   Zertifikat (CA)“ set, „Verbindung testen“ passes.
2. Check for updates and install. Expected: check and download go through the proxy (proxy log), no certificate
   error. With the CA file removed: a clear certificate error, not a hang.
3. With a proxy that needs a password (stored under Einstellungen → Netzwerk): the check works without asking.

### 7. Portable copy

1. Unpack the 1.5.0 portable ZIP to a USB stick or a folder, start `Arcalo.exe`.
2. Expected: the toast says „Portabler Modus: das ZIP von der Release-Seite über den Ordner entpacken.“ and the
   button is „Neue Version herunterladen“, which opens the release page. Nothing is installed, nothing appears
   under `%LOCALAPPDATA%\Programs`.
3. Unpack the 1.6.0 ZIP over the folder; `data\` stays; start: notes are there, version 1.6.0.

### 8. Autostart and „Minimiert starten“

1. Enable „Mit dem System starten“ and „Minimiert starten“, sign out and in again (Arcalo starts in the tray).
2. Open the window from the tray and install the update.
3. Expected: after the restart the window is **visible** (not hidden in the tray) with the „aktualisiert“ toast.
   The next login starts minimized again.

## macOS

### 9. From /Applications

1. Copy 1.5.0 from the DMG to `/Applications`, start it (right-click → Öffnen for an ad-hoc signed build).
2. Install the update from the toast. Expected: progress, then Arcalo quits and starts again within a few
   seconds as 1.6.0 with the „aktualisiert“ toast; the Dock icon stays; notes intact.
3. Finder → Programme → Arcalo → Informationen shows 1.6.0. With a Developer ID build: no Gatekeeper prompt
   after the update.

### 10. From ~/Downloads (App Translocation)

1. Start 1.5.0 directly from `~/Downloads` (or from the mounted DMG) without moving it.
2. Install the update. Expected: record what happens. A translocated app runs from a random read-only path, so
   replacing it fails: Arcalo must show „Installation fehlgeschlagen“ with a readable reason and keep running
   normally (type a note, quit, start again: the note is there). It must not end up without an app.
3. Move Arcalo to `/Applications`, start it from there, update: works as in 9.

### 11. Intel and Apple Silicon

Repeat 9 once on each architecture (or Intel under Rosetta is **not** enough: the x64 build must be tested on
an Intel Mac or its feed entry `darwin-x86_64` checked by downloading and running it).

## Linux

### 12. AppImage (updates itself)

Verified for 1.6.0 with two debug AppImages (1.6.0-test.1 to 1.6.0-test.2, throwaway key, local feed via
`ANNALO_UPDATE_ENDPOINT`): tampered file, cut download and offline check left the AppImage unchanged; the real
update replaced it in place, relaunched it past the single-instance lock, and the text typed right before the
click was saved. Repeat with the real release:

1. `chmod +x Arcalo_1.5.x_amd64.AppImage` in a folder you own (e.g. `~/Apps`), start it, type a note.
2. Install the update from the toast. Expected: the AppImage file is replaced in place (same name, still
   executable) and Arcalo starts again as the new version with the „aktualisiert“ toast; the note is there.
3. An AppImage in a folder you cannot write to (e.g. `/opt` owned by root): „Installation fehlgeschlagen: Keine
   Schreibrechte …“ and Arcalo keeps running.

### 13. .deb

1. Install the .deb, start Arcalo. Expected: the toast says „Als Paket installiert: das neue Paket von der
   Release-Seite installieren.“ with „Release-Seite öffnen“; no install button.
2. `sudo apt install ./Arcalo_1.6.0_amd64.deb` while Arcalo runs, then restart it: version 1.6.0, notes intact.

## Test feed

Since 1.14.1 the app installs the verified file itself (`src-tauri/src/installer.rs`) instead of handing it to the
updater plugin, whose release builds refused the internal hand-over with „The configured updater endpoint must
use a secure protocol like `https`“ (1.12 to 1.14.0). Debug builds never showed it, so the in-app install must be
checked with a **release** build at least once per release: install the previous release, then update to the new
one from Settings → Über. The installer's command line is in the log (`update`: „starting …-installer.exe /P
/UPDATE /R /ARGS“).

To test an update without publishing: a debug build honors `ANNALO_UPDATE_ENDPOINT` (a `latest.json` URL, `http`
allowed) and `ANNALO_UPDATE_PUBKEY` (base64 public key of a throwaway key from
`cargo tauri signer generate -w <tmp>/key --ci`). Release builds ignore both and always ask the GitHub feed with
the key compiled in. Never use the release signing key for tests.

The published feed must contain, per release: `version`, `notes`, `pub_date` (RFC 3339) and the platforms
`windows-x86_64` (the NSIS `…_x64-setup.exe`), `darwin-aarch64` and `darwin-x86_64` (`….app.tar.gz`) and
`linux-x86_64` (`…_amd64.AppImage`), each with the content of its `.sig` file and a URL under
`https://github.com/MouseWerk/Arcalo/releases/download/v<version>/`.

Debug builds also take `ANNALO_UPDATE_CURRENT` (the version the copy pretends to run, e.g. `1.8.5`),
`ANNALO_UPDATE_FAKE_INSTALL=1` (an install writes `updates/fake-install.json` instead of running the installer),
`ANNALO_TEST_FAIL_START=1` (the start ends right after the health marker, like a crash) and
`ANNALO_TEST_ROLLBACK_ANSWER=yes|no` (answers the rollback question without the native dialog); see
`e2e/tests/126-update-background.test.js` and `127-update-policy-rollback.test.js`.
