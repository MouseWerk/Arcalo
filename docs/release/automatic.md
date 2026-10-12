# Automatic release

The workflow `.github/workflows/auto-release.yml` starts the release by itself: after CI passed for a push to
`main`, it releases the version of the newest `docs/releases/v<version>.md` when that version has no tag yet. The
release itself is the usual one: `auto-release.yml` calls `release.yml` (as a reusable workflow) with the version and
the commit CI tested, `release.yml` creates the annotated tag `v<version>` on that commit with the notes file as its
message, and builds and publishes as for „Run workflow“.

## When it releases

All of these must hold, else the run ends with a notice and nothing happens:

- The CI run finished successfully (a failed or cancelled run, e.g. one superseded by a newer push, never releases).
- It ran for a **push** to **`main`** of this repository (not a pull request, a tag or another branch).
- The commit it tested is still the head of `main` (`git ls-remote`): a run for an older commit never releases,
  the run for the newest one decides.
- The newest `docs/releases/v<major>.<minor>.<patch>.md` (by version, not by date) is newer than every release
  tag `v<major>.<minor>.<patch>`, and its own tag does not exist. Only that newest file counts: an older notes file
  without a tag is ignored, and a version lower than the newest tag is never released. Pre-release names
  (`v1.20.0-rc.1.md`) and other tags (`whisper-models-v1`) do not count.
- The repository variable `AUTO_RELEASE` is not `false`.

The choice is `scripts/release-pick.mjs`, tested by `scripts/release-pick.test.mjs` (CI runs it).

## Never twice

- The runs of `auto-release.yml` form one queue (`concurrency: auto-release`, never cancelled): a second green
  run starts after the first one's release and finds its tag.
- `release.yml` refuses an existing tag when it is called by the automatic release (by hand, „Run workflow“ still
  builds an existing tag again to repair a failed release).
- The tag is pushed with the workflow's own token, which starts no other workflow, so the tag push does not
  start `release.yml` a second time.

## Releasing

1. Write `docs/releases/v<version>.md` (`## Improved`, `## Fixed`, `## Checklist for Windows (manual)`), commit
   it together with the last changes or after them, and push to `main`.
2. CI runs; when it passes, „Auto release“ starts and calls the release. Its runs are under Actions → Auto
   release; the release itself appears as the job „Release“ there.
3. Then the website (changelog, version, screenshots), as before.

Do not push a notes file of the next version before the release is meant to happen: the first green CI after it
releases.

## Switching it off

GitHub → Settings → Secrets and variables → Actions → Variables → **New repository variable** `AUTO_RELEASE` with
the value `false`. Deleting the variable (or any other value) switches it on again. While it is off, release with
a tag or Actions → Release → Run workflow, as before.

## A failed release

The tag exists then, so the automatic release does not try again. Fix the cause and run Actions → Release → Run
workflow with the same version: it builds the existing tag again.
