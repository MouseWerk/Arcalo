# Updates in organizations

This page is for administrators who roll out Arcalo (1.9 and later) on many machines: how
updates arrive, how to serve them from your own server or network share, and how to control
them with policies.

## How updates work

- Arcalo checks for a new version shortly after the start and then every 6 hours (configurable).
- Mode **automatic** (default): the update downloads in the background (pausable; an
  interrupted download resumes where it stopped), is checked against Arcalo's signature, and
  installs when the user quits Arcalo (tray „Quit“, ⌘Q, closing the last window). The status
  bar says „Update 1.9.1 ready – installs when you quit Arcalo“ with „Restart now“ and „Later“.
  - Windows: the NSIS installer runs in passive update mode after Arcalo has saved and closed
    its workspace. During a Windows shutdown or logoff the installer is not started; the
    downloaded update stays ready and installs at the next quit.
  - macOS: the app bundle is replaced (also when quitting from the Dock or logging out).
  - Linux: the AppImage replaces itself. A .deb (or .rpm) installation only shows the notice;
    the package manager installs the new package.
  - Portable copies never install themselves; they offer the release page.
- Mode **notify**: Arcalo shows the new version; the user clicks „Install and restart“.
- Mode **off**: no automatic checks (users can still check by hand, unless a policy switches
  updates off).
- Users can **skip a version** (a newer one is offered again) or be **reminded tomorrow / next
  week**. Settings → About shows a skipped version with „Undo“.

### Signatures

Every update file is verified with the public key built into Arcalo, whatever the source
(GitHub, your server, a share). A file that does not match is discarded and nothing is
installed. A mirror can therefore deliver the files but cannot change them. The signed
version in the signature must match the version `latest.json` announces.

### Before an update is installed

1. The database is backed up as `arcalo-pre-update-<from>-<to>.db` in the backup folder
   (Settings → Backup; default `backups` in the data folder). These backups are not part of the
   normal rotation; the two newest are kept.
2. A copy of the running version is kept in `<data folder>/rollback/<version>`:
   - Windows (per-user install): a copy of the program folder.
   - macOS: the previous `Arcalo.app` as `Arcalo.app.tar.gz`.
   - Linux AppImage: the previous AppImage file.
   - .deb, portable: no copy (only the database can go back).

### Rollback when a new version does not start

Every start writes „starting <version>“ into the data folder early, and „healthy“ once the
window has loaded on the opened and migrated database. If the version an update just installed
fails to get there twice in a row, the third start asks — in a small native dialog, before the
database is opened — „Arcalo 1.9.1 could not start twice – return to 1.9.0?“. „Yes“ restores the
pre-update database backup, puts the previous version back, starts it, and records 1.9.1 as a bad
version that is never offered again. „No“ keeps going (the question returns after two more
failures).

While the copy exists, Settings → About also offers „Return to version 1.9.0“ by hand, with a
warning: everything changed in the database since the update is lost. The database file of the
failed version is kept as `workspace.db.before-rollback-<time>` next to the database.

**Limits.** The check runs inside Arcalo's own startup. A version that fails before that point —
a missing system library, a crash while the runtime or the WebView starts, a damaged program
file that does not even run — never reaches it; then install the previous version from the
release page (or your share) by hand and restore the `arcalo-pre-update-…` backup under
Settings → Backup. Windows' list of installed programs keeps showing the newer version number
after a rollback until the next update. The rollback does not undo changes made outside the
database (attachments, Markdown mirror, Git sync).

## Your own update source

Settings → About → Update source (or the policy `UpdateUrl`) takes:

- a URL of a `latest.json` (or of the folder holding it) on an internal web server:
  `https://intranet.example/arcalo/latest.json`
- a network folder with `latest.json` and the files: `\\server\share\arcalo`
  (also mapped drives, `/Volumes/arcalo`, `file:///srv/arcalo`).

Arcalo asks your source first. GitHub is the fallback when your source cannot be reached,
unless the policy `AllowGitHubFallback` is `0`/`false`. Proxy and extra root CA from Settings →
Network apply to all update requests.

### Mirroring a release

`scripts/mirror-release.py` (Python 3, standard library only) downloads a release's
`latest.json` and its update files and rewrites the file URLs:

```sh
# Latest release to a share (file names relative to latest.json):
python3 scripts/mirror-release.py --dest \\server\share\arcalo
# A specific release, Windows only, served by a web server:
python3 scripts/mirror-release.py --tag v1.9.1 --dest D:\www\arcalo \
  --base-url https://intranet.example/arcalo/ --platform windows-x86_64 --platform windows-x86_64-nsis
```

`latest.json` is written last, so clients never see a version whose files are not there yet.
`--prune` removes files the new `latest.json` no longer lists. Run it after you have tested a
release; until then clients keep the version your share offers.

## Policies

Policies are read at every start. Higher sources win per value:

1. Windows registry `HKEY_LOCAL_MACHINE\Software\Policies\MouseWerk\Arcalo`
2. Windows registry `HKEY_CURRENT_USER\Software\Policies\MouseWerk\Arcalo`
3. macOS managed preferences (configuration profile) for the domain `app.annalo.desktop`
   (`/Library/Managed Preferences/<user>/app.annalo.desktop.plist`, then
   `/Library/Managed Preferences/app.annalo.desktop.plist`)
4. `policy.json` next to the executable (`Arcalo.exe`; on macOS `Arcalo.app/Contents/MacOS`)
5. `policy.json` in the system folder: `%ProgramData%\MouseWerk\Arcalo` (Windows),
   `/Library/Application Support/MouseWerk/Arcalo` (macOS), `/etc/arcalo` (Linux)

| Key | Type | Values |
|---|---|---|
| `UpdateMode` | string | `auto`, `notify` or `off` (`off`: no checks at all, also not by hand) |
| `UpdateUrl` | string | URL of a `latest.json`, or a folder / UNC path |
| `AllowGitHubFallback` | DWORD / bool | `1` (default) or `0`: ask GitHub when `UpdateUrl` fails |
| `PinnedVersion` | string | e.g. `1.9.4`: never offer a version above it |
| `InstallWindow` | string | e.g. `18:00-07:00` (local time, may span midnight): install only then; outside it the update waits and „Restart now“ is not offered |
| `CheckIntervalHours` | DWORD / number | 1–168 |

Settings → About shows „Managed by your organization“ with the source of the policy and locks
the managed fields. Invalid values are ignored and logged (Settings → Log, category „update“).
The same sources also carry the network policies (`NetworkRoute.<service>`,
`LockNetworkProfiles`): see docs/admin/network.md.

### Registry example (.reg)

```reg
Windows Registry Editor Version 5.00

[HKEY_LOCAL_MACHINE\Software\Policies\MouseWerk\Arcalo]
"UpdateMode"="auto"
"UpdateUrl"="\\\\server\\share\\arcalo"
"AllowGitHubFallback"=dword:00000000
"PinnedVersion"="1.9.4"
"InstallWindow"="18:00-07:00"
"CheckIntervalHours"=dword:0000000c
```

Group Policy: create the same values under Computer Configuration → Preferences → Windows
Settings → Registry.

### policy.json example

```json
{
  "UpdateMode": "notify",
  "UpdateUrl": "https://intranet.example/arcalo/latest.json",
  "AllowGitHubFallback": false,
  "PinnedVersion": "1.9.4",
  "InstallWindow": "12:00-13:30",
  "CheckIntervalHours": 24
}
```

### macOS configuration profile payload

```xml
<dict>
  <key>PayloadType</key><string>app.annalo.desktop</string>
  <key>UpdateMode</key><string>auto</string>
  <key>UpdateUrl</key><string>https://intranet.example/arcalo/</string>
  <key>AllowGitHubFallback</key><false/>
  <key>CheckIntervalHours</key><integer>12</integer>
</dict>
```

## Files in the data folder

| Path | Content |
|---|---|
| `updates/<version>.part` | a download in progress (resumed with an HTTP Range request or from the file's offset) |
| `updates/<version>.update`, `updates/staged.json` | the verified download waiting for the quit |
| `updates/state.json` | skipped version, „remind me later“, rolled-back versions |
| `.annalo-health` | the health marker of the last start |
| `.annalo-update` | written right before an install; the next start says „Updated to …“ |
| `rollback/` | the copy of the previous version and its record |
