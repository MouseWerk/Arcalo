# Scoop, Chocolatey and AUR

Package files for 1.11.0, prepared from the release assets (hashes computed from the downloaded files):

| Manager | Files | Release asset | SHA-256 |
|---|---|---|---|
| Scoop | [`packaging/scoop/arcalo.json`](../../packaging/scoop/arcalo.json) | `Arcalo_1.11.0_x64-portable.zip` | `5b39fd4d8c5bcae0e6c755105d983b5baa590d3accc605ab9db9569c45af7d9e` |
| Chocolatey | [`packaging/chocolatey/arcalo/`](../../packaging/chocolatey/arcalo) | `Arcalo_1.11.0_x64-setup.exe` | `e30fe0d4f6727556a0f97ebc5628b012ce203c3e57ea8d2ae14bb4fc1abb12df` |
| AUR | [`packaging/aur/arcalo-bin/`](../../packaging/aur/arcalo-bin) | `Arcalo_1.11.0_amd64.deb` | `3db6b9a078977b1ba7bec029a09c69185b2508de93945f19ebc71195b2ae366f` |

winget is described in [winget.md](winget.md). None of the packages is published yet; the README lists no
package manager commands until they are.

## Scoop

`arcalo.json` installs the portable ZIP. The ZIP contains the `arcalo-portable` marker, so Arcalo keeps all data
in `data` next to `Arcalo.exe`; the manifest persists that folder, so it survives `scoop update` and
`scoop uninstall` (without `--purge`). Portable mode also turns off the self-update (Scoop updates it), autostart
and the jump list. There is no `bin` entry: `Arcalo.exe` is a GUI program, the Start menu shortcut is enough.
`checkver` reads the latest GitHub release and `autoupdate` builds the URL of the next ZIP.

**Extras does not take it yet.** The Extras package request form requires that the app is "reasonably well-known
and widely used (e.g. if it's a GitHub project, it should have at least 100 stars and/or 50 forks)", and a
package request issue has to be opened and accepted before a pull request. Arcalo has 1 star and no forks
(October 2026). Until then, a bucket of your own:

1. Create the repository `MouseWerk/scoop-bucket` from
   [ScoopInstaller/BucketTemplate](https://github.com/ScoopInstaller/BucketTemplate) ("Use this template"). It
   brings the layout (`bucket/`, `bin/` with the checkver and test scripts) and the Excavator workflow that runs
   `checkver -Update` on a schedule and commits new versions.
2. Copy `packaging/scoop/arcalo.json` to `bucket/arcalo.json`, adjust the template's README, commit and push.
3. Test on Windows:

   ```powershell
   scoop bucket add mousewerk https://github.com/MouseWerk/scoop-bucket
   scoop install mousewerk/arcalo
   scoop update arcalo; scoop uninstall arcalo
   ```

4. Users then install with the two first commands.

Once Arcalo meets the criteria: open a "Package Request" issue in
[ScoopInstaller/Extras](https://github.com/ScoopInstaller/Extras/issues/new/choose), wait for a maintainer to
accept it, then open the pull request with `bucket/arcalo.json` and comment `/verify` on it.

Pull request title (conventional, as the template asks): `arcalo: Add version 1.11.0`. Body:

```markdown
Closes #<package request issue>

Adds Arcalo, a local-first desktop app for notes, tasks and time tracking (MIT,
https://github.com/MouseWerk/Arcalo). The manifest installs the portable ZIP of the GitHub release;
the ZIP's marker file keeps all data in `data` next to the program, which is persisted.

- [x] Use conventional PR title: `<manifest-name[@version]|chore>: <general summary of the pull request>`
- [x] I have read the [Contributing Guide](https://github.com/ScoopInstaller/.github/blob/main/.github/CONTRIBUTING.md)
```

## Chocolatey

`packaging/chocolatey/arcalo/` holds `arcalo.nuspec` and `tools/chocolateyinstall.ps1` (downloads the setup
from the GitHub release, checks its SHA-256 and runs it with `/S`) and `tools/chocolateyuninstall.ps1` (runs the
uninstaller of the "Arcalo" entry with `/S`). No binaries are embedded, so no `VERIFICATION.txt` or
`LICENSE.txt` is needed. The nuspec has no e-mail address (rule CPMR0020) and takes the icon from jsDelivr, not
from raw.githubusercontent.com (CPMR0076).

The installer is per user: Chocolatey usually runs elevated, and Arcalo then goes to `%LOCALAPPDATA%` of the
account that ran `choco`. That is the normal case (an admin shell of your own account). The nuspec says so.

Steps:

1. Account on [community.chocolatey.org](https://community.chocolatey.org/account/Register); the account name
   goes into `<owners>` (now `MouseWerk`; change it if the account has another name).
2. Copy the API key from the account page, then once: `choco apikey --key <key> --source https://push.chocolatey.org/`.
3. On Windows, in `packaging\chocolatey\arcalo`:

   ```powershell
   choco pack
   choco install arcalo --source . -y          # test install from the local .nupkg (admin shell)
   choco uninstall arcalo -y
   choco push arcalo.1.11.0.nupkg --source https://push.chocolatey.org/
   ```

4. Moderation: the automatic validator, verifier (test install) and scan run first; then a human moderator
   reviews the first version, which can take days to weeks. Answer on the package page; later versions of an
   approved package are usually approved automatically.
5. Per release: change `<version>`, `<releaseNotes>`, the URL and `checksum64` (`Get-FileHash` of the new setup),
   `choco pack` and `choco push`.

## AUR (`arcalo-bin`)

`packaging/aur/arcalo-bin/` holds `PKGBUILD` and `.SRCINFO`. The package unpacks `data.tar` of the `.deb` into
`/usr` (program `/usr/bin/annalo` plus a symlink `/usr/bin/arcalo`, desktop file, icons), sets the empty
`Categories=` of the desktop file to `Office;`, and installs the MIT license from the tagged source. The
dependencies come from the libraries the binary links (`readelf -d`) and the `.deb`'s `Depends`
(`libwebkit2gtk-4.1-0`, `libgtk-3-0`, `libayatana-appindicator3-1`), mapped to Arch names; `git` (Git sync) and a
Secret Service provider (credentials) are optional.

Not tested here: `makepkg`, `namcap` and an install on Arch (no Arch system was available). The `package()`
step was run against the extracted `.deb` and produced the expected file list; the `.SRCINFO` was written by hand
in the `makepkg --printsrcinfo` format and checked against the PKGBUILD's values.

Steps:

1. On an Arch system: `cd packaging/aur/arcalo-bin && makepkg -si`, start Arcalo, then `namcap PKGBUILD` and
   `namcap arcalo-bin-1.11.0-1-x86_64.pkg.tar.zst`. If anything changes, regenerate with
   `makepkg --printsrcinfo > .SRCINFO`.
2. AUR account at [aur.archlinux.org](https://aur.archlinux.org/register), add an SSH public key in "My Account".
3. Publish (the AUR repository is created by the first push; it may contain only the package files):

   ```sh
   git clone ssh://aur@aur.archlinux.org/arcalo-bin.git
   cp packaging/aur/arcalo-bin/PKGBUILD packaging/aur/arcalo-bin/.SRCINFO arcalo-bin/
   cd arcalo-bin && git add PKGBUILD .SRCINFO && git commit -m "arcalo-bin 1.11.0-1" && git push
   ```

4. Per release: `pkgver`, `pkgrel=1`, both checksums (`updpkgsums`), new `.SRCINFO`, commit, push.
