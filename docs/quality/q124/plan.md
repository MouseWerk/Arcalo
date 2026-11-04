# q124 plan: bug hunts until no medium or high bug is found

Owner, 2026-11-03: „Run so many till we don't find medium to high bugs anymore“. After q123 (three clean rounds,
then more soak runs) the existing tests pass reliably; this round looks for what they do not cover. Each hunt
writes new tests against the real app, rates every finding, and fixes the medium and high ones at the root.

## Severity

| Level | Meaning | Examples |
|-------|---------|----------|
| High | Data lost or wrong, a crash, a security or privacy problem, the app unusable | an edit not saved, a booking with the wrong time, a secret in a log, a hang |
| Medium | A common flow broken or misleading, or a visible defect in a main view | a command that does nothing, a wrong number shown, a dialog that cannot be closed, cut text in a main view |
| Low | Rare, cosmetic or with an easy way around | a 2 px misalignment, an awkward wording, a delay under a second |

Low findings are listed, not required to be fixed in this round.

## Exit criterion

A full hunt round over every area below finds no medium or high bug, and the desktop soak (5 runs) and the whole CI
are green on the same commit. Any medium or high finding is fixed, and the next round starts.

## Areas

| # | Area |
|---|------|
| H1 | Editor core: typing, undo/redo, lists, tables, links and backlinks, slash menu, paste of text and HTML, the source view, large notes |
| H2 | Data safety: save, crash and restart, Git sync, backups and restore, encryption, the Markdown mirror, imports (Obsidian, bookmarks) |
| H3 | Work features: tasks, calendar and Outlook/ICS, meetings, time tracking and its exports (Jira, SAP CATS, CSV, JSON), projects, the start page |
| H4 | Search, quick search, command palette, AI chat and the assistant (fake providers), voice notes, settings and their undo, keyboard and accessibility |

## Rounds

| Round | Commit | Findings (high / medium / low) | Fixed in | Clean |
|-------|--------|--------------------------------|----------|-------|
| 1 | `27656808` | 8 / 5 / 24 (H1 0/3/7, H2 3/1/6, H3 3/1/6, H4 2/0/5) | `76e0d7cd`, `a78eacb6`, `cbfd1ffc` | no |
| 2 | `a08442c4` | 9 / 9 / 30 (A 1/5/9, B 2/2/6, C 2/1/5, D 4/1/10) | `8755b7c6`, `bb4119ca`, `522dd95b`, `e4ade9b0` | no |
| 3 | `ffd4bb06` | 11 / 7 / 24 (A 1/3/3, B 1/2/9, C 3/1/7, D 6/1/5) | `1131ec17`, `b61cacf3`, `4b0cb96c` | no |

Round 2 adds areas: H5 import, export and sharing; H6 updates, migrations from older versions and the CLI; H7 the
phone and tablet app; H8 performance with large data (10,000 pages, long notes, many bookings).
