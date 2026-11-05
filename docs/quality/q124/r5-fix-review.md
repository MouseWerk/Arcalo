# q124 round 5, hunt D: review of the fixes of rounds 1 to 4

Rounds 1 to 4 merged 66 high and medium fixes between `27656808` and `10181bc1`, made by four hunters in parallel.
This hunt reviews that range as code (`git diff 27656808 10181bc1 -- crates src-tauri ui/src`): regressions a fix
did not intend, two fixes that work against each other, paths a fix did not reach, the error paths and the cost of
the new code, the new migration and settings step, and every changed assertion of the tests. Each suspected bug was
first shown by a failing test. Branch `q124-r5d`. Severity as in the [plan](plan.md); a fix that broke an earlier
behaviour counts at the severity of that behaviour.

## Findings

### R5D-1 A settings change taken over in the background could hang the app for good (high, fixed)

- Symptom: the whole app stopped answering (window, tray, every command) and had to be ended, when a settings
  change made outside the window was taken over while the window stored a setting or a key: the command line
  (`arcalo settings set capture_shortcut …`), a settings sync that brought another language or switched time
  tracking (with a tray icon), and at the same time a save from the window (the start page's scratch note,
  a quick link, a switch in the settings, an API key).
- Root cause: two fixes together. R4C-1/R4A-1 made every settings write hold `AppState::settings_write`.
  `settings_save` holds it while it registers changed global shortcuts and rebuilds the tray menu, and both run
  on the main thread: called from a background thread (the command line's watcher, the Git sync's settings
  take-over) it waits for the main thread with the lock held. `settings_save`, `dashboard_save`,
  `quick_links_save`, `api_key_set`, `provider_key_set`, `settings_scope_set` and `settings_sync_undo` were
  commands without `async`, which Tauri runs on the main thread: one of them arriving then waited for the lock
  on the main thread, and neither side went on. Before the lock, nothing waited.
- Fix: those seven commands run on a worker (`#[tauri::command(async)]`), like every other command that writes
  settings: no settings write waits for the lock on the main thread any more, so the main thread is free for the
  shortcut and tray work of the write that holds it.
- Tests: e2e 681 „the app keeps answering when the command line changes a shortcut while the window stores a
  key“ (sixteen shortcut changes on the command line while the window stores keys without a pause). Before the
  fix the app hung in the first round: the main thread in `api_key_set` → `refresh_ai` waiting for the lock, the
  command line's watcher in `settings_save` → `apply_shortcuts` waiting for the main thread.

### R5D-2 A model's answer could still load an image from another server through its styles (high, fixed)

- Symptom: the guard of R3C-1 (no answer of a model may load anything by itself, as an image address can carry
  what the model read) let three forms through: `image-set("https://…" 1x)` (and `-webkit-image-set`, which take a
  plain string, no `url(`), a CSS escape (`u\72l(https://…)` is `url(` to the browser) in a `style` attribute of
  the summaries, reviews, the briefing and the inline AI bar, and the same in the style sheet of a diagram in the
  chat (Mermaid takes `%%{init: {"themeCSS": …}}%%` from the answer unchecked). A `style` attribute without the
  word `background` in the answer was not even looked at.
- Root cause: `withoutRemoteLoads` only searched for `url(` and `@import` (`image-set` only in attributes), and its
  quick check skipped answers with a `style` attribute.
- Fix: every loading form counts (`url(`, `image(`, `image-set(`, `cross-fade`, `src(`, `@import`, and any escape):
  a `style` attribute with one goes, a style sheet has its escapes read first and the loading functions removed,
  and the presentation attributes of SVG (`fill`, `filter`, `mask`, …) may only point inside the diagram
  (`url(#arrow)`).
- Tests: `airemote.test.ts` „styles of an answer load nothing either, also with image-set or escapes“.

### R5D-3 Three settings saves still took back what was stored meanwhile (medium, fixed)

- Symptom: the class of R4C-1 in the paths it did not reach. At the start, with a PAC proxy, the app evaluates the
  PAC script (seconds, over the network) and saved the settings it read at the start with the answers: a setting
  changed in those seconds went back. Reordering the briefing's sections and „Umwandeln“ of a legacy proxy
  profile saved the window's copy as a whole, taking back a change of the core the window had not received yet
  (a calendar discovery, „Termine in Outlook eintragen“).
- Root cause: `refreshPac` (`App.tsx`), `saveSections` (`BriefingView.tsx`) and the conversion in
  `NetworkSection.tsx` called `api.saveSettings` with the whole object and without the copy it was made from,
  so `settings_save` could not merge (`merge_change`).
- Fix: they go through `writeSettings` (after the writes before them, with the copy as `base`); the PAC answers
  are put onto the settings as they are when the save runs.
- Tests: `settingsWrite.test.ts` „api.saveSettings is called only by writeSettings and the setup's writer“.

### R5D-4 A dropdown below the fold closed again the moment it opened (medium, fixed)

- Symptom: a dropdown that had to be scrolled into view and was opened in the same moment closed by itself: a field
  reached with Tab below the visible part of the settings and opened with Space, and every WebDriver click on such a
  dropdown. Found as the CI failure of this branch (run 41985351160, attempt 1): `37-ai-providers` „… Anbieter für
  Lokales Modell did not open“; the tier dropdown was 992 px down (below the window), WebDriver scrolled it into view
  and clicked, and the list was gone again. Not caused by R5D-1: the commands moving to a worker only shifted the
  timing so that the scroll was reported after the list opened.
- Root cause: `Select` closes on a scroll of an area holding the trigger (so a list does not float away from it).
  The browser reports a scroll in the next frame; a scroll made just before the click arrived after the list had
  opened and closed it, although the trigger had not moved since.
- Fix: the list keeps where the trigger was when it was placed and closes only on a scroll that moved the trigger.
- Tests: `Select.test.ts` „stays open through a scroll reported after it opened that did not move the trigger“ (the
  existing „closes on a scroll“ now moves the trigger, as its text says); e2e 681 „a dropdown scrolled into view and
  opened in the same moment stays open“ (closed in round 0 before the fix).

## Low findings (not fixed in this round)

- R5D-L1 `settings_scope_set`, `settings_sync_undo`, the settings take-over of a Git sync and the command line's
  take-over read and store the database's settings before they take the lock, then call `settings_save` with the
  whole object (`base` none): a write landing in that millisecond is taken back.
- R5D-L2 `settings_save` merges a window's change onto the running settings, not onto the database's: a value the
  command line stored and the watcher has not taken over yet (up to one poll) is overwritten by any save from
  the window or by `change_settings`.
- R5D-L3 `merge_titles` (Git sync) keeps every path of both sides: when both computers changed the titles file, a
  title removed on one (a page renamed to the form its file name has, e.g. „Q3: Ziele“ to „Q3- Ziele“) comes
  back with the other's entry and `take_over_titles` renames the page back.
- R5D-L4 The desktop capture window stores its draft with `capture_draft_set` as an async command; a draft write
  still on its way when the capture is saved (Enter within a few milliseconds of the 400 ms delay) can land after
  the removal and bring the text back with the next capture.
- R5D-L5 `syncmerge::keeps_subpages` and `release_moving` read the whole page list once per page the server
  deleted: a pull that deletes a large folder on a workspace of 10,000 pages costs seconds (quadratic).
- R5D-L6 `mergeCanvas` places the cards the other pane added with a search through the list per card
  (cubic in the number of added cards); harmless at the board sizes in use.
- R5D-L7 The phone's settings screen still saves the whole object (`mobile_settings_save`, no `base`); the phone
  has no background settings write today, so nothing is taken back yet.

## Reviewed without finding

The worklog state machine (R2C-1, R3D-1..5: claim, record, posted while edited, lookup deletions, relink with
`sent_*`), migration `0042_worklog_sent.sql` (next number, nullable columns, older versions ignore them) and
settings step 19 → 20 (`target_history`, empty for stored settings: the current target applies to every day as
before), `record_target_change` with the command line and the settings sync, the recurrence changes with their
property test, the Markdown round trip and Word list paste, `toDate` (R4D-1) against the other date parses of the
UI (the remaining `new Date(…)` read timestamps, not bare days), the rollback offer, the ICS cut-off check, the
capture drafts on the phone, and every assertion changed in the tests of the range (each one kept or made
stricter; none removed without a replacement).
