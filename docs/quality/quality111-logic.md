# Quality 1.11 – logic errors and bugs

Scope: correctness across the app (known open items of 1.8–1.10 first, then a review of the core
domains and of classic bug classes). Every fix has a regression test (Rust unit, vitest or e2e
148/149). Status: F = fixed, D = documented/deferred, OK = checked, no finding.

## Known open items

- 1.8 L1–L12, M1/M2: all fixed in main already (verified in code: last_workday, Jira matches,
  private EN title, inbox title, voice file name, log_work cancel, outlook.ps1 Deleted Items +
  COALESCE, focus_block_outbox AUTOINCREMENT).
- 1.9 L1–L6: all fixed in main already (rollback order, move_undo `placed`, multi-drop position,
  `KEPT` canvas entries, graph date filter, worker fallback).
- 1.10 #13 F (ICS attendees with a name missing from `mailto:`), #19 F (merge undo), #20 F (prep
  page marker selected), #21 F (multi-line HTML comments), #18 D (by design: lock screens need
  theme and language; no secrets returned).
- Canvas Git conflict as raw JSON: no remaining path in the conflict flow (ConflictView canvas
  branch, banner, pull without conflict, resolve validation, keep-both; canvases have no versions
  dialog). The one place a canvas' JSON still reached the screen was the start page's random
  note (F, below).

## Fixes, ranked

1. F high – Links/embeds in table cells: the editor writes `[[Seite\|Alias]]` and
   `![[bild.png\|200]]` in cells; core read the target as `Seite\` / `bild.png\` (`notes.rs`
   wiki_links + replace_link_target, `attachments.rs` embeds, `attachment_manager.rs`
   embed_refs). Effects: no backlink, rename did not update the link, and the image counted as
   unused in Anhänge verwalten (cleanup could remove a used file). New `notes::link_target_len`;
   migration 0029 re-indexes once. Tests `links_in_table_cells_and_tilde_fences`, e2e 149.
2. F high (Windows) – Mirror file names: `NUL.txt` became `nul.txt_.md`, still the device NUL
   (Windows reserves the name before the first dot); COM¹–³, LPT¹–³, CONIN$/CONOUT$ missing.
   Now `nul_.txt.md`. Also capped at 200 bytes: 120 CJK/emoji characters exceeded the 255-byte
   name limit of Linux/macOS (mirror write failed). `vault.rs` file_name. Table test + e2e 149.
3. F high – ICS: `DURATION:P999999999999D` (or a far DTEND) panicked in `Duration::days` /
   date addition and stopped the calendar sync; `UTC+€1` panicked in `tz.rs` byte slicing.
   try_* durations, lengths clamped to 10 years, ASCII check. Tests in ics.rs, tz.rs.
4. F medium – Follow-up `mailto:` lacked ICS attendees given with a CN. ICS attendees are
   stored `Name <address>`; `calsync::attendee_name` for every display (notes, prep, dashboard
   query, calendar detail, follow-up chips); `mailto:` takes bare addresses (RFC 6068); the
   Outlook draft gets name + address; meeting prep searches notes by name forms and address. e2e 141/142 updated (pass), unit tests.
5. F medium – Kalender month and list views did not show focus blocks. `dayItems`/`monthCells`
   with blocks, block lines open the block detail. vitest + e2e 148.
6. F medium – Free slots fixed to 08:00–18:00: new `time.work_start`/`time.work_end`
   (Settings → Zeiterfassung → Arbeitszeit, validated, settings step 10→11 „work-hours“,
   schema updated); invalid or reversed hours fall back to 08–18. Rust table test incl. Berlin
   zone, vitest, e2e 148.
7. F medium – CATS export: per-row rounding to 0,01 h made day totals drift (3 × 20 min =
   0,99 h). Rows now carry the difference of the rounded running day total. Property test over
   1–90 min × 7 rows.
8. F medium – Timer across sleep: the idle accumulator only trusted the OS idle time; a sleep
   the OS does not count was booked as work. Gaps of > 12 samples (min 1 min) count as idle
   (opt-in via `sampled_every`, set by the app). Test with both OS behaviours.
9. F medium – Jira: a worklog deleted in Jira made every later entry change fail hourly
   (PUT 404). `issues::update_or_post` posts anew on 404. Test with the fake provider.
10. F medium (Windows/macOS) – Git sync runs with `core.longpaths=true` (deep notes > 260
    chars failed with Git for Windows) and `core.precomposeunicode=true`.
11. F medium – Decomposed titles (macOS file names, NFD) never matched typed `[[Müller]]` and
    could share a mirror file with the NFC page. `nfc.rs` (generated canonical pairs for Latin,
    Greek, Cyrillic) in `clean_title`. Tests.
12. F low/medium – Duplicate merge undo dropped edits made after the merge (kept only as a
    version). Undo now 3-way merges (after-merge → current, before) and falls back to the old
    behaviour on a conflict; 1.10 undo records still load.
13. F low – Mention scan masked only the first line of a multi-line `<!-- … -->`.
14. F low – `~~~` fences: tasks and links inside were counted (parse_tasks, prose_lines,
    replace_link_target only knew ```` ``` ````), and a ```` ``` ```` inside `~~~` flipped state.
15. F low – Quick links: `file://server/share/x` became `server/share/x`, `%C3%BC` stayed
    escaped. UNC and full percent-decoding.
16. F low – Capture due dates „bis 5.1.“ in December gave a past date (voice notes already
    rolled over). Same rule now.
17. F low – Start page random note showed a canvas' raw JSON as its excerpt.
18. F low – Local graph labels clipped at the panel edge: `placeLabel` keeps them inside
    (shortened only when wider than the panel). vitest.
19. F low – Prep/status page opened with the generated block's start marker node-selected.
20. F low – Unhandled rejections without feedback: update pause, open capture, ignore
    duplicate, retry backup destinations, load Leistungsarten now toast an error.
21. F low – Random note seed: the day after the switch to summer time had the previous day's
    seed (hours instead of calendar days).
22. F low – Dashboard query `date_cell` sliced bytes 0..10 of any string (char boundary panic
    possible); now `get(..10)`.

## Test runs

- cargo fmt, clippy -D warnings: clean. cargo test: 705/706 core (only the pre-existing timing test, passes with CI=1), 54 shell + integration ok.
- vitest 928/928 (105 files), typecheck ok.
- e2e 148, 149 (new), 81–83, 116, 117, 133–145: all pass (141 failed once on the prep attendee search, fixed).

## Checked, no finding

- Rounding (`Rounding::apply`), `/zeit` across midnight (clamped to today) and DST gaps
  (`local_to_utc`), balance with half days and comp days, `booked_by_day` with a running timer.
- ICS expansion: EXDATE in other zones, RECURRENCE-ID by instant, UNTIL as date/UTC, all-day
  DST, RDATE; Outlook dedupe by uid+start with ranks.
- Settings sync merge (later change wins, equal values keep the later stamp, scrub both ways),
  mirror swap under the lock, update verdict / health / rollback record.
- Day arithmetic in core uses dates + `day_start`; UI 24h-ms math only in seeds/labels (one
  fixed above).
- unwrap/expect in production code: only invariant ones (bookmark stack guarded by len,
  `and_hms_opt(0,0,0)`, fixed holidays).
- Number inputs accept the decimal comma; selects use `Number()` on fixed values.

## Deferred

- `mention_scan_is_fast_on_5k_pages` fails locally (69 ms vs 50 ms budget) on this machine
  before and after these changes (same timing with the 1.10 mentions.rs); CI uses 250 ms.
  Performance is the other agent's scope.
- Save-dialog default names in the UI (Mermaid/canvas/HTML export) do not suffix device names;
  the OS dialog validates them, nothing is written wrongly.
- 1.10 #18 `settings_get` while locked (by design).
- Migration numbering: 0029 is appended after 0027 (0028 is left for the parallel agent); when
  both merge, 0028 must come before 0029 in `MIGRATIONS`.
