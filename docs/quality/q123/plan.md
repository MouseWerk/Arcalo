# q123 plan: images, presentation, drawings, Jira, every screen

Owner, 2026-10-29: working with images is poor (copy and paste elsewhere does not work), the presentation view has
many bugs (also with images), Mermaid cannot be typed into Excalidraw, the button that shows a Jira issue in the app
sits in different places, „wirklich alles testen, alle UIs und Systeme“. Then: „a full UI watch and fix run“.
Machinery and exit criterion as in `docs/quality/q122/plan.md`.

## Areas

| # | Area | Branch | Findings |
|---|------|--------|----------|
| 1 | Images in notes: copy, paste, drag, other programs | `q123-images` | `images.md` (8) |
| 2 | Presentation view | `q123-present` | `presentation.md` (P1–P20) |
| 3 | Drawings (Excalidraw) and Mermaid | `q123-draw` | `drawings.md` (D1–D3) |
| 4 | Jira UI, the issue view button everywhere | `q123-jira` | `jira.md` (J1–J15) |
| 5 | Every other screen: tour at 3 sizes, 4 themes, de/en | `q123-sweep` | `sweep.md` (S1–S14) |
| 6 | Second tour over the desktop app | `q123-ui2` | `round2-desktop.md` (R1–R17) |
| 7 | Phone and tablet app | `q123-phone2` | `round2-phone.md` (P1–P15) |

Found while merging and soaking, each fixed at the root:

- `datadir` test looked a constant up by its bare name; gitsync's namesake could win (CI red on `main`).
- Xvfb reset when the restarting app was its only client; the new process lost its display (e2e 137).
- A week across two months cut off the calendar heading in a narrow pane (e2e 371); a dialog whose form loads late
  lost the focus to a disabled button (e2e 412).
- macOS 14 runner images retired on 2 November 2026: CI and release on macOS 15.
- The command palette focused its field 10 ms late: the first keys after Strg+K were lost or went into the note; its
  way back then started at its own field (e2e 320).
- Play services restarting itself in the middle of the Android suite killed the app with it (font provider).
- e2e 321 clicked the previous page's editor during the tab switch; the Android tour measured the issue view during
  its opening slide.
- An arrow key before a Jira chip stepped over a word joiner and left the caret where it was (soak, e2e 104).
- A dropdown opened again right after choosing a new interface scale closed when the scale arrived: the webview's
  zoom also scrolls the settings to keep their place, and that scroll counted as the person's (soak, e2e 36;
  q122 F22 handled the resize only).

## Rounds

A round: the desktop suite 5 times (`e2e soak`), the whole CI (Linux with e2e, Windows, macOS, iOS, Android APK
and emulator). Clean when nothing needed a fix.

| Round | Commit | Soak (5x) | CI | Clean |
|-------|--------|-----------|----|-------|
| 1 | `abfa3465` | 41354633609 | 41354626309 | yes |
| 2 | `abfa3465` | 41362486922 | 41362487335 attempt 1 | yes |
| 3 | `abfa3465` | 41370358586 | 41362487335 attempt 2 | yes |

Earlier rounds on `1f299d6e`, `0f380d54`, `4b33fa84`, `06deb59f` and `d622f293` each ended with a finding above.

### More runs (owner: „Lasse noch paar Bug Runs laufen“)

| Commit | Runs | Result |
|--------|------|--------|
| `94d96ec3` | soak 41423114242 (10x), CI 41379048770 | soak clean; CI: e2e 320 deleted the wrong page (two quick-search opens applied out of order), fixed in `d7b688ae` |
| `d7b688ae` | soak 41441089945 (5x), 41454277402 (10x), CI 41437061084 attempts 1–3 | 14 of 15 clean, CI green 3 times; e2e 36: a dropdown closed by the scroll of a new scale, fixed in `5864a084` |
| `5864a084` | soak 41506318807 (10x), CI 41506310144 | soak clean; CI: the Linux runner's disk full while linking (debug info), fixed in `4c1163ba` |
| `4c1163ba` | CI 41519959719 attempts 1–2 | green both times (the app is the same as `5864a084`) |

## Not covered

- On real devices: Windows clipboard into Word, Outlook and Teams and Excel cells into a note (`images.md`); the
  presenter window on a second screen; phones and tablets.
- The iOS check photographs the start screen only.
- Image features that would be new: resize handles, alignment, a caption field, „Speichern unter“, „Ersetzen“.
