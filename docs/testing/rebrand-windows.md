# Manual test: the update from Annalo 1.6 to Arcalo 1.7

Arcalo 1.7 is Annalo under a new name. The update must look like any other update: no second
installation, no lost data, passwords or tokens, no dead shortcut or autostart entry. These steps
need real systems (installer, credential store, autostart); e2e 113 covers what runs headless
(names in the UI, the one-time notice, a 1.6 data folder, credentials, old backups).

## What stays and what changes

| | Stays (so 1.6 data is found) | Changes |
|---|---|---|
| Identifier | `app.annalo.desktop`: data folder (`%APPDATA%\app.annalo.desktop`, `~/Library/Application Support/app.annalo.desktop`, `~/.local/share/app.annalo.desktop`), WebView2 profile, macOS bundle id, keychain access, the updater's target | |
| Credentials | service name `Annalo` in the Credential Manager / Keychain (`src-tauri/src/secrets.rs`) | |
| Windows install folder | an existing `%LOCALAPPDATA%\Annalo` (and `annalo.exe` in it) is updated in place | a fresh install goes to `%LOCALAPPDATA%\Arcalo` |
| Windows entries | | Apps & features „Arcalo“ (publisher MouseWerk), Start menu `Arcalo\Arcalo.lnk`, desktop `Arcalo.lnk`, autostart value `Arcalo`; the `Annalo` ones are removed |
| macOS | the app keeps its place: an updated `Annalo.app` stays `Annalo.app` in Finder | menu bar, About, Dock menu, windows and notifications say Arcalo; a new download is `Arcalo.app` |
| Linux | the AppImage file keeps its file name (it replaces itself); the binary stays `/usr/bin/annalo` | the .deb package is `arcalo` (replaces `annalo`), menu entry „Arcalo“ |
| Backups | `annalo-….db` are listed, restored and pruned | new backups are `arcalo-….db` |
| Portable | `annalo-portable`, `data/.annalo-portable` still switch portable mode on | the ZIP has `Arcalo.exe` and `arcalo-portable` |

The installer part is in `src-tauri/installer/hooks.nsh`, the start-up part in
`crates/annalo-core/src/rebrand.rs` and `src-tauri/src/rebrand.rs` (log source `rebrand` in
Settings → Über → Protokoll).

## Preparation

- A signed 1.6.x build installed the normal way and a signed 1.7.0 build with `latest.json` (or a
  debug build with `ANNALO_UPDATE_ENDPOINT`, see `auto-update-windows.md`).
- In 1.6: a few notes, an AI provider with an API key, a Git sync token, one calendar subscription,
  Settings → Desktop → autostart on, a desktop shortcut (setup option), the app pinned to the
  taskbar, two backups (Settings → Sicherung → „Jetzt sichern“).
- Note the data folder (Settings → Über) and the install folder (`%LOCALAPPDATA%\Annalo` by default).

## Windows: installer 1.6 → 1.7 through the updater

1. In Annalo 1.6: Settings → Über → „Nach Updates suchen“ → install 1.7.0. The installer runs
   passive, Annalo closes and Arcalo starts by itself.
2. Window title, tray tooltip, tray menu and Settings → Über say **Arcalo 1.7.0**. A notice
   „Annalo heißt jetzt Arcalo“ appears once; „Versionshinweise“ opens the 1.7.0 release page.
   Quit and start again: no notice.
3. Notes, settings, the theme and the data folder are unchanged; Settings → KI still shows the key
   as set, Git sync pushes without asking for the token, the calendar subscription syncs.
4. Apps & features: exactly one entry **Arcalo** (version 1.7.0, publisher MouseWerk), no „Annalo“.
5. Start menu: „Arcalo“ (in the folder „Arcalo“); no „Annalo“ folder or entry. Desktop: the shortcut
   is now named **Arcalo** and starts the app. The taskbar pin still starts the app (its tooltip
   may still read „Annalo“ until it is pinned again).
6. Explorer: the program is still in `%LOCALAPPDATA%\Annalo\annalo.exe`; there is no
   `%LOCALAPPDATA%\Arcalo` folder. `regedit`: `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Annalo`
   and `HKCU\Software\annalo` are gone; `…\Uninstall\Arcalo` and `HKCU\Software\MouseWerk\Arcalo` exist.
7. Task Manager → Autostart: **Arcalo** (enabled), no „Annalo“. `regedit` `HKCU\…\CurrentVersion\Run`
   has `Arcalo` = `…\Annalo\annalo.exe --minimized`. Sign out and in: Arcalo starts in the tray.
   The log has „autostart entry „Annalo“ renamed to „Arcalo““ once.
8. Repeat with autostart disabled in Task Manager before the update: afterwards neither „Annalo“
   nor „Arcalo“ is enabled, and Settings → Desktop shows autostart off.
9. Jump list (right-click the taskbar icon): the entries work; the app is grouped with its pin
   (same AppUserModelID `app.annalo.desktop`).
10. Settings → Sicherung: the old `annalo-….db` backups are listed with the new `arcalo-….db` one;
    restore an old one: the app restarts with that state.
11. Uninstall Arcalo from Apps & features (keep the data): the program folder, the Start menu entry,
    the desktop shortcut and the autostart value go; the data folder stays. Install 1.7 again: the
    notes are there, no notice (it was shown).

## Windows: setup by hand over 1.6

1. With Annalo 1.6 running, start `Arcalo_1.7.0_x64-setup.exe` by double-click. The setup offers
   to close Annalo; accept. Keep the suggested folder.
2. Same checks as steps 2–7 above (the setup's own Start menu and desktop options apply).
3. Again from 1.6, but choose another folder in the setup (e.g. `C:\Tools\Arcalo`): Arcalo goes
   there, `annalo.exe` and `uninstall.exe` are removed from `%LOCALAPPDATA%\Annalo` (the folder
   goes when empty), the Start menu and desktop shortcut point to the new folder, autostart starts
   the new `annalo.exe`.

## Windows: portable ZIP

1. Unpack the 1.6 portable ZIP into a folder, start `Annalo.exe`, write a note, quit.
2. Unpack the 1.7 ZIP over the same folder: the folder now has `Annalo.exe`, `Arcalo.exe`,
   `annalo-portable`, `arcalo-portable`, `LIESMICH.txt` and `data`.
3. Start `Arcalo.exe`: portable mode (Settings → Über), the note is there, nothing is written to
   `%APPDATA%` or the registry (no autostart, no shortcuts touched).
4. `Annalo.exe` is the old 1.6: starting it refuses the newer database („neueren Arcalo-Version“
   in its own words) without touching it. Delete `Annalo.exe` and `annalo-portable`; `Arcalo.exe`
   still starts portable.

## macOS (Apple Silicon or Intel)

1. Annalo 1.6 in `/Applications/Annalo.app`, autostart on (Settings → Desktop), a Git token and
   an AI key set (Keychain).
2. Update from Settings → Über. After the restart: the menu bar shows **Arcalo** (Über Arcalo,
   Arcalo ausblenden, Arcalo beenden), the window and Dock menu say Arcalo, the notice appears once.
3. Finder: the app is still `/Applications/Annalo.app` (the updater replaces the bundle in place;
   its name is not changed while it runs). The Keychain asks for nothing new; keys and tokens work.
4. `~/Library/LaunchAgents/`: `Arcalo.plist` (pointing into the running bundle), no `Annalo.plist`.
   Log out and in: the app starts in the menu bar.
5. Optional: quit, rename `Annalo.app` to `Arcalo.app` in Finder, start it: everything is still
   there (same bundle id); the autostart entry is rewritten to the new path at that start.
6. Fresh download next to an old copy: dragging `Arcalo.app` from the 1.7 disk image creates a
   second app beside `Annalo.app` (same bundle id, same data). Delete `Annalo.app`.

## Linux

AppImage:
1. Run `Annalo_1.6.x_amd64.AppImage` from `~/Apps`, autostart on (`~/.config/autostart/Annalo.desktop`).
2. Update from Settings → Über: the file `Annalo_1.6.x_amd64.AppImage` is replaced in place (same
   file name) and restarts as Arcalo 1.7.0; the notice appears once.
3. `~/.config/autostart/`: `Arcalo.desktop` with `Exec=` the same AppImage path, no `Annalo.desktop`.
   An autostart switched off in the desktop's settings (`Hidden=true` or
   `X-GNOME-Autostart-enabled=false`) is removed and not switched on.
4. Secrets (`secrets.json` in the data folder) and notes are unchanged.

.deb:
1. With the `annalo` 1.6 package installed: `sudo apt install ./Arcalo_1.7.0_amd64.deb`. apt removes
   `annalo` and installs `arcalo` in one step (`Conflicts`/`Replaces: annalo`); `dpkg -i` does the same.
2. The application menu shows **Arcalo** once (`/usr/share/applications/Arcalo.desktop`), no Annalo;
   `/usr/bin/annalo` starts it; the data folder (`~/.local/share/app.annalo.desktop`) is unchanged.
