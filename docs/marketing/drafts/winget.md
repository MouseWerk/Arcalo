# winget-pkgs: first submission of 1.22.0

Status: drafted. Who acts: the owner (fork of microsoft/winget-pkgs, the pull request, the Microsoft CLA, a
Windows machine for `winget validate` and a test install). winget is approved by the owner.

Checked 2026-10-27: `MouseWerk.Arcalo` is not in microsoft/winget-pkgs (no folder, no open or closed PR for
"Arcalo"). The PR template still asks for manifest schema 1.12.0.

## Manifests

`docs/marketing/winget/manifests/m/MouseWerk/Arcalo/1.22.0/` (four files, same layout as winget-pkgs):

- `MouseWerk.Arcalo.yaml` (version)
- `MouseWerk.Arcalo.installer.yaml`: NSIS (`nullsoft`), per user, `ProductCode: Arcalo`
- `MouseWerk.Arcalo.locale.en-US.yaml` (default locale, updated description with the Jira issue view and
  Obsidian import)
- `MouseWerk.Arcalo.locale.de-DE.yaml`

Installer: https://github.com/MouseWerk/Arcalo/releases/download/v1.22.0/Arcalo_1.22.0_x64-setup.exe

SHA256: `00AA14C46DB6C5D5793A66B69527ADE378742BA2A0C282E31B4CD365D0977B59`

The hash was computed from the release asset downloaded on 2026-10-27 (19,146,414 bytes) and matches the digest
GitHub reports for the asset. All four files validate against the winget 1.12.0 JSON schemas.

These replace the 1.11.0 set in `packaging/winget` for the first submission, as `docs/release/winget.md`
recommends ("If a newer release is out before the first submission, submit that one instead"). After the
merge, the release workflow's `winget` job keeps later versions up to date once `WINGET_TOKEN` is set.

## Steps (on Windows, from a clone of this branch)

```powershell
winget validate --manifest docs\marketing\winget\manifests\m\MouseWerk\Arcalo\1.22.0
winget settings --enable LocalManifestFiles   # once, in an admin shell
winget install --manifest docs\marketing\winget\manifests\m\MouseWerk\Arcalo\1.22.0
winget uninstall MouseWerk.Arcalo             # check the uninstall entry is found
wingetcreate submit --token <classic PAT with public_repo> docs\marketing\winget\manifests\m\MouseWerk\Arcalo\1.22.0
```

## PR title and body

Title: `New package: MouseWerk.Arcalo version 1.22.0`

```markdown
## Description

New package: MouseWerk.Arcalo version 1.22.0 (Arcalo, a local-first desktop app for notes, tasks, meetings
and time tracking; MIT, https://github.com/MouseWerk/Arcalo). Per-user NSIS installer from the GitHub
release, no admin rights needed. Submitted by the author.

## Checklist

- [ ] Signed the [Contributor License Agreement](https://cla.opensource.microsoft.com)
- [ ] Linked to an issue (if applicable)

## Manifest Checklist

- [ ] Checked that there aren't other open [pull requests](https://github.com/microsoft/winget-pkgs/pulls) for the same manifest update/change
- [ ] This PR only modifies one (1) manifest
- [ ] Validated manifest locally with `winget validate --manifest <path>`
- [ ] Tested manifest locally with `winget install --manifest <path>`
- [ ] Manifest conforms to the [1.12 schema](https://github.com/microsoft/winget-pkgs/tree/master/doc/manifest/schema/1.12.0)
```

Tick each box only when it is true. Expect the validation pipeline within about an hour and a moderator merge
within days to two weeks; the unsigned installer is accepted, an antivirus false positive gets a label and a
question.

## After the merge

- README download table: add `winget install MouseWerk.Arcalo` (owner decision; it is a website/README change).
- Then wingetly.io and similar catalogs pick the package up by themselves.
