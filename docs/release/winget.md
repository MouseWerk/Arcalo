# winget

Package identifier: `MouseWerk.Arcalo`. Users install with `winget install MouseWerk.Arcalo` and update with
`winget upgrade MouseWerk.Arcalo` (the app also updates itself).

The manifests of the current release are in
[`packaging/winget/manifests/m/MouseWerk/Arcalo/1.8.0/`](../../packaging/winget/manifests/m/MouseWerk/Arcalo/1.8.0)
(version, installer, default locale en-US and a de-DE locale). The path mirrors the layout of
[microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs).

## First submission (once, by hand)

The automation can only update a package that already exists in winget-pkgs, so 1.8.0 goes in by hand.

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) with the account that will open the
   pull requests (MouseWerk or your personal account).
2. Check the installer hash still matches the release asset (it does unless the asset was replaced):

   ```powershell
   (Get-FileHash .\Arcalo_1.8.0_x64-setup.exe -Algorithm SHA256).Hash
   # or: winget hash .\Arcalo_1.8.0_x64-setup.exe
   ```

   Expected: `F52B1DA75688D4C918EBBF6333CA70FD07A43914D71EC8E7C317ED0F3F5A3B20`.
3. Validate and test on Windows (from a clone of this repository):

   ```powershell
   winget validate --manifest packaging\winget\manifests\m\MouseWerk\Arcalo\1.8.0
   winget settings --enable LocalManifestFiles   # once, in an admin shell
   winget install --manifest packaging\winget\manifests\m\MouseWerk\Arcalo\1.8.0
   ```

4. Submit, either way:
   - **wingetcreate** (`winget install Microsoft.WingetCreate`):

     ```powershell
     wingetcreate submit --token <classic PAT with public_repo> packaging\winget\manifests\m\MouseWerk\Arcalo\1.8.0
     ```

     It opens the pull request from your fork.
   - **By hand**: copy the four files into `manifests/m/MouseWerk/Arcalo/1.8.0/` of your fork, commit, and
     open a pull request against `microsoft/winget-pkgs` `master`, filling in the PR template checklist.
5. Review: the validation pipeline (installs the package in a sandbox, scans it) runs within about an hour and
   labels the pull request. A moderator then merges it, usually within a few days, sometimes one to two
   weeks for a new package. Answer review comments on the pull request; `Needs-Author-Feedback` closes it
   after a while without a reply. A first-time contributor also has to sign the Microsoft CLA in the PR.

Unsigned installers are accepted. The validation pipeline scans the installer with antivirus engines; if
one flags it (false positive), the pull request gets a label and a moderator asks for details.

## Automatic updates (every release after that)

The `winget` job of [`.github/workflows/release.yml`](../../.github/workflows/release.yml) runs after the release
is published and uses [vedantmgoyal9/winget-releaser](https://github.com/vedantmgoyal9/winget-releaser)
(Komac) to open a pull request with the new version, URL and hash in winget-pkgs. It copies the descriptions
and tags from the previous version in winget-pkgs, so edits to the locale files are made there (or in a
manual pull request), not in `packaging/winget`.

Setup:

1. Create a **classic** personal access token with the scope `public_repo`, for the account that owns the
   winget-pkgs fork (fine-grained tokens do not work for pull requests to other owners' repositories).
2. Repository secret `WINGET_TOKEN` = that token (Settings → Secrets and variables → Actions).
3. If the fork does not belong to the `MouseWerk` account: repository variable `WINGET_FORK_USER` = the
   account name that owns the fork.
4. Keep the fork: the action pushes a branch to it for every version. It does not need to be in sync.

Without `WINGET_TOKEN` the job only logs a notice. The `packaging/winget` folder stays as the reference of the
first submission; it does not need to be updated per release.

## Owner checklist

- [ ] Fork microsoft/winget-pkgs.
- [ ] On Windows: `winget validate` and a test install of `packaging/winget/.../1.8.0` (step 3 above).
- [ ] Submit 1.8.0 with `wingetcreate submit` or a manual pull request; sign the CLA in the PR.
- [ ] Wait for the merge (days, up to about two weeks); answer review comments.
- [ ] Then: classic PAT (`public_repo`) as secret `WINGET_TOKEN`; variable `WINGET_FORK_USER` if the fork
      is not under `MouseWerk`.
- [ ] After the next release: check the `winget` job of the Release run and the pull request it opened.
