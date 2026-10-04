# Arcalo 1.8 quality audit: findings

Scope: everything since the 1.6 README commit `4acd07b` (there is no `v1.6.0` tag; the last tag is `v1.5.0`). That is 255 files and about 29.5k lines. I reviewed Jira, voice notes, widgets, worktime and holidays, the rebrand and installer hooks, the briefing, and time blocks with the Outlook write queue. I also ran a UI tour with the e2e harness on DISPLAY :400:
- every main view and every settings section in EN-light at 1480x920;
- dashboard, Kalender, issues, review, briefing and all settings in DE-dark;
- 6 dense views at 900x600.

Screenshots are in `scratchpad/tour/shots/` (prefixes `en-`, `de-`, `small-`). Downscaled review sheets are in `scratchpad/tour/v/`. The tour script is `scratchpad/tour/tour.mjs`.

Console: `window.__annaloErrors` stayed empty in all three runs. No unhandled rejections or `console.error` output appeared in any view, including voice record and stop, the Jira sync and the briefing.

Counts: high 1, medium 4, low 12.

---

## HIGH

### H1. Focus-block free slots count colleagues' calendars as busy: no free slot all day when a colleague is out of office
- Area: time blocks / PlanPicker. `src-tauri/src/timeblocks.rs:88` (`active_sources`), `crates/annalo-core/src/timeblocks.rs:486-507` (`block_free_slots`, filter at :502).
- What: `block_free_slots` is called with every active source, including colleagues' shared calendars and Free/Busy-only calendars. Every non-`Free` event of those calendars counts as busy, including `Oof` and the all-day-long free/busy items that Outlook delivers as timed `midnight→midnight` blocks.
  - With one colleague "Abwesend" for the day, the picker offers nothing for that whole day.
  - A colleague's meetings also take slots away from the user.
- Reproduce: use the `e2e/lib/work-fixtures.js` team calendars (Jörg Weiß out of office today, Anna's "Vertriebsrunde"). Then call `invoke("block_free_slots", {date: today, minutes: 60})`.
  - Result: `[]`, even though the user's own calendar only has 06:10-07:10 and 08:30-09:00.
  - The next workday returns 08:00…17:00 slots. That probe result is in `shots/de-report-*.json`.
- Fix: use `calendar.booking_sources(...)` (own calendars) in `src-tauri/src/timeblocks.rs:88`, as `weekplan.rs` and `briefing.rs` do. If you prefer a dedicated "counts as my busy time" set, also skip `Busy::Oof`/free-busy items of non-own calendars. Add an e2e step with team calendars on.

## MEDIUM

### M1. Outlook write queue: a pending delete is overwritten by a new block that reuses the id, so the old appointment stays in Outlook forever
- Area: time blocks / Outlook write-back.
  - `crates/annalo-core/migrations/0015_focus_blocks.sql:18`: `id INTEGER PRIMARY KEY` without AUTOINCREMENT.
  - `crates/annalo-core/src/timeblocks.rs:377-386` (`block_enqueue` ON CONFLICT) and `:457-475` (`block_delete`).
- What: SQLite reuses the highest rowid after it is deleted. The outbox is keyed by `block_id`.
  - Delete the newest block while Outlook is closed (or before the flush ran). This queues `op='delete'` with its `entry_id`.
  - Then create a block. It gets the same id, and `block_enqueue(id, "upsert", None, None)` turns the row into `op='upsert'`.
  - The delete of the old appointment is lost. The old "Fokus: …" busy appointment stays in the user's Outlook calendar, and colleagues see it, with nothing left to clean it up.
  - The `uid` of the old appointment also stays in the row, so the calendar mirror keeps hiding it as an "own block" until that row goes.
- Reproduce (fixture log `ANNALO_OUTLOOK_WRITE_LOG` + `.offline` file):
  1. Create block A and let it be written.
  2. Create the `.offline` file, delete A, then create block B.
  3. Remove `.offline` and flush. The log shows no delete for A's `ARC-…` entry.
- Fix: make `focus_blocks.id` AUTOINCREMENT (new migration that copies the table). Or key the outbox by its own row id, with delete rows that never merge into upserts: allow several rows per block, and on conflict merge only same-op rows.

### M2. Deleting a block while its first Outlook write is in flight leaves an orphan appointment
- Area: `crates/annalo-core/src/timeblocks.rs:457-475` and `:547-603` (`block_outbox_apply`); `src-tauri/src/timeblocks.rs:108-127`.
- What: `flush_inner` reads the ops, then runs PowerShell for 2-10 s off the DB lock.
  - If the user deletes the brand-new block in that window, `block_delete` sees `outlook_entry_id == None`, drops the outbox row and deletes the block.
  - When the script returns, the result is applied with `UPDATE focus_blocks … WHERE id=?` (no row) and `DELETE FROM outbox … AND seq=?` (no row). The created appointment is never deleted.
  - The same happens on a script timeout (60 s) after Outlook did save: the retry creates a second appointment because no entry id was stored.
- Reproduce: create a block (Outlook write-back on) and delete it within a second or two. The fixture log shows an `upsert` with no later `delete`.
- Fix: in `block_outbox_apply`, when an upsert result arrives for a block that no longer exists, enqueue a `delete` with the returned entry id/global id instead of dropping it. For the timeout case, give the subject or a user property a block marker, and look the appointment up in the script before `Items.Add`.

### M3. Timesheet "Book meetings" offers colleagues' meetings from shared calendars (and "Book all…" books them)
- Area: `ui/src/views/TimesheetView.tsx:704` (uses `api.calendarEvents` = `active_sources`), `ui/src/lib/agenda.ts:259-271` (`unbooked` has no booking-calendar check).
- What: Outlook calendars have a per-calendar `booking` flag, and it defaults to off for shared calendars (`calsync/calendars.rs:311`). The week proposal, briefing and day review honour it through `booking_sources`, but the Timesheet card does not.
  - With Anna Müller's calendar shown, "Book meetings · 1 meeting this week not booked yet" lists her "Vertriebsrunde" (Fr 05:00-06:15) with Book and "Book all…".
  - Screenshot: `shots/en-timesheet.png`, bottom.
- Note: this predates 1.7 (`5667ea0`), but it hurts every user who turned on team calendars.
- Fix: filter by `settings.calendar` booking calendars in the UI. Or have the backend return `booking: bool` per event (or a `calendar_events_for_booking` command using `booking_sources`) and use it in `unbooked()`.

### M4. Jira worklogs are never corrected when the booked entry is edited or deleted
- Area: `crates/annalo-core/src/issues/mod.rs:1039-1109`, `migrations/0014_issues.sql:67` (`ON DELETE CASCADE`).
- What: a worklog is posted once (`worklog_state='posted'`, `worklog_id`). Afterwards, nothing reacts to changes of the time entry:
  - A changed duration or start, for example a correction in the timesheet, leaves the old worklog in Jira.
  - Deleting the entry cascades the link row away, so the app even forgets the worklog id. The Jira worklog stays.
  - Users routinely fix durations, so Jira and SAP/CATS diverge silently.
- Reproduce (fake Jira, `log_work: true`):
  1. Book `/zeit PROJ-123 1h`, wait for the post, then change the entry to 2 h in the timesheet.
  2. The fake Jira still has one worklog of 3600 s.
  3. Delete the entry: still one worklog.
- Fix: on entry update, when the link has a `worklog_id`, mark it `update_pending` and PUT `issue/{key}/worklog/{id}` with the new values. On delete, keep a tombstone row (no FK cascade) and DELETE the worklog. At minimum, show "posted to Jira, change it there" in the entry dialog.

## LOW

### L1. Vacation widget repeats the day: "Tomorrow · tomorrow" / "Morgen · morgen"
- `ui/src/components/dashboard/work.tsx:333`.
- `dayLabel()` already gives "Tomorrow", then `countdown()` adds "tomorrow".
- Screenshots: `shots/en-dash-work.png`, `shots/de-dash-work.png` (German Unity Day on 2 Oct).
- Fix: show the countdown only when `dayLabel` returned a date, or show the date plus the countdown.

### L2. Briefing overview: the "Unbooked hours" subtitle is cut off and the stat grid breaks 3+1 in small windows
- `ui/src/views/BriefingView.tsx:217/229`; text `brief.ov.missing` (en.ts:4694, de.ts:4691).
- "not booked on the last wo…" / "am letzten Arbeitstag nich…" is cut at 1480x920 with the assistant panel open.
- At 900x600 the four cards wrap into 3+1.
- Screenshots: `shots/en-briefing.png`, `shots/de-briefing.png`, `shots/small-briefing.png`.
- Fix: a shorter label ("unbooked yesterday" / "gestern offen", or the weekday name), and `container`-query to 2x2 below about 560 px of pane width.

### L3. Briefing "last workday" ignores holidays and absences
- `crates/annalo-core/src/briefing.rs:301-303`.
- `last_workday` only checks `weekday_minutes > 0`. On the Tuesday after Easter Monday, the time section and the "unbooked hours" card report Easter Monday (target 0, "holiday") instead of the Thursday before, so the real gap is hidden.
- `briefing_day` also uses `settings.workdays`, while `last_workday` uses `weekday_hours`, so the two disagree when per-weekday hours are set.
- Fix: skip holidays (`holidays_between`) and full absence days in `last_workday`, and use one workday definition (`weekday_minutes > 0`) in both places.

### L4. A failing saved Jira search empties its widget
- `crates/annalo-core/src/issues/mod.rs:692` (`UPDATE issues SET matches='[]'` for the whole site) together with `fetch_site` (`:576`, errors of non-`mine` searches are only collected).
- One transient failure of a saved JQL query (400/timeout) clears its matches, so its `jira_query` widget shows nothing until the next good sync. After 30 days those issues are deleted.
- Fix: for queries in `fetched.failed`, keep the stored ids in `matches` (merge the old match list for those ids) instead of resetting them.

### L5. Daily review says "all done" for meetings that are still upcoming
- `ui/src/views/DayReviewView.tsx:395`.
- At 05:30 with two meetings later today, the card reads "2 · all done" / "alles erledigt", while the rows below say "upcoming" / "steht an".
- Screenshots: `shots/en-review.png`, `shots/de-review.png`.
- Fix: count only past meetings for "all done" and show "n upcoming" otherwise.

### L6. Private appointments are offered for booking in English
- `ui/src/lib/agenda.ts:266` only skips `"Privater Termin"`. Line 224 and core `is_private_title` also know `"Private appointment"`.
- In an EN workspace, private Outlook appointments show up under "Book meetings".
- Fix: use the same two-title check (`e.title === "Privater Termin" || e.title === "Private appointment"`), or better a `private_placeholder` flag from the backend.

### L7. English workspace: the inbox page is called "Posteingang"
- The Notes board inbox widget in a fresh EN workspace says 'Quick captures sent to "Posteingang" arrive here.' (`shots/en-dash-notes.png`).
- `CapturePrefs::default()` uses `capture::inbox_title()` (`prefs.rs:656`). `tr!` is evaluated when the defaults are built, apparently before the UI language is applied.
- Fix: resolve an empty or default title at use time (`inbox_title()` when the stored value equals the other language's default), or build the defaults after `i18n::set_language`.

### L8. Voice note: the file name and the page title use different date formats
- `src-tauri/src/voice.rs:515` writes "Voice note 2026-10-02 05-31.flac", while `voice/mod.rs:76` titles the page "Voice note 02.10.2026 05:31".
- The audio embed shows the ISO name under the German-date title (`shots/en-voice-done.png`).
- Fix: use one format. The German date with `.`/`-` is filename-safe: "Sprachnotiz 02.10.2026 05-31.flac".

### L9. The "In use" badge on a voice model that is not downloaded
- Settings → Voice notes: "Small 465,0 MB · In Verwendung" appears with a "Laden" (download) button next to it (`shots/de-settings-voice.png`).
- "In use" reads as "available".
- Fix: "Ausgewählt – nicht geladen" / "Selected – not downloaded", with a warning tone, until the file exists.

### L10. Jira worklogs of a site whose "log work" was switched off stay pending and are all posted when it is switched on again
- `src-tauri/src/jira.rs:752` (`continue` without changing the state).
- Months-old bookings suddenly appear in Jira.
- Fix: when `log_work` is turned off, set the pending rows of that site to `none` (or ask on re-enable).

### L11. outlook.ps1 write mode edits appointments that sit in "Deleted Items"
- `crates/annalo-core/src/calsync/outlook.ps1:97-104`.
- `GetItemFromID` still finds an appointment the user deleted in Outlook (it moved to Deleted Items). The upsert updates it there and reports `ok`, so the block shows "written to Outlook" but nothing is in the calendar.
- Fix: check `$item.Parent.EntryID -eq $calendar.EntryID` (or that the parent is the default calendar). If it is not, treat the item as gone and `Items.Add` a new one.
- Related: `block_outbox_apply` (`timeblocks.rs:584-590`) overwrites a stored `outlook_entry_id` with NULL when the script answers ok without an entryId. Keep the old one with `COALESCE`.

### L12. Small window (900x600): the assistant panel stays open and leaves about 360 px for the view
- At 900 px the right panel (about 330 px) stays open on every view, so dashboard cards stack in a narrow column and the Kalender week has 40 px day columns (`v/s1.png`, from `shots/small-*.png`).
- Fix: auto-collapse the panel below about 1000 px of window width (it reopens with Ctrl+J), or overlay it there.

---

Checked and found sound (no finding):
- Jira tokens: credential store, `redact` on every logged error, Authorization header never logged, 401/403/CAPTCHA texts, retry/backoff.
- Jira tracking-off and not-configured gating in Settings, IssuesView and the block detail.
- Worklog no-double-post claim.
- Holiday tables (Easter algorithm, Buß- und Bettag, BE/MV/TH specials).
- Overtime balance logic.
- Rebrand classify, autostart and shortcut moves; NSIS hooks.
- Voice download (size + SHA-256 check before rename).
- Editor reload and merge on `data://pages`/`data://tasks` after Jira ticks and voice transcripts.
- Inbox move with the expected-text guard.
- Unhandled promises in the new UI code (all `.then` chains have a rejection handler).
