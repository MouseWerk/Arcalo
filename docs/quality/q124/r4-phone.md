# q124 round 4, hunt A: the Android emulator's failures and the phone app

Round 4 of the [plan](plan.md), branch `q124-r4a`. The job „Android emulator (phone screens)“ failed once and passed
on a rerun in three runs of round 3, and each time it was put down to a flaky emulator. This hunt read the logs, the
logcat and the pictures of each failure, found two causes (one in the app, one in the harness) and fixed both; then
it looked at the phone app (`ui/src/mobile`) for more: offline edits and their sync, the settings, the tabs with
many items, Back, and typing in every form.

Severity as in the plan.

## The three failures

| Run | What failed | What the pictures and the log show |
|-----|-------------|------------------------------------|
| 41800159272, attempt 1 (`q124-r3b`) | 412×915: „opens the settings“ and „keeps every label whole at 130 %“ (no `[aria-label="Einstellungen"]`) | Every picture of the 412×915 part is in English („Booked today“, „Quick capture“, „Activity type“), although the suite had saved German 4 s after the start; the settings button is there, labeled „Settings“. The save (09:04:38.3) fell into the 3 s after the start at 09:04:34.5 in which the app reads its AI keys from the Keystore (`arcalo-secrets get` 09:04:37.5 to 38.1). → R4A-1 |
| 41804267003, attempt 1 (`q124-r3a`) | tour 360×800 light: „daily“, „settings“, „gitsetup“, „full-app-jira“ (no „Tagesnotiz“, no „Einstellungen“) | The same: the tour's pictures in English, the language saved 5 s after the start, the keys read in between. → R4A-1. The job also stood still for eleven minutes between two tours (412×915 light passed at 09:48:50, the next start at 09:58:47). → R4A-H1 |
| 41804267003, attempt 2 | 412×915: the same two tests as in 41800159272 | R4A-1 again; and eleven and a half minutes between the tours 360×800 dark (11:52:56) and 412×915 light (12:04:32). → R4A-H1 |
| 41770239960 (`q124-r2a`, cancelled) | tour 412×915 light: the same four parts | R4A-1: the language saved at 04:26:21.6, the keys read from 04:26:17.8 on. |

Every failure is R4A-1; none was the emulator being slow. The pictures of all three also show a heads-up banner
„Enable Google Play services“ over the app's header (R4A-H2).

## Findings

### R4A-1 A setting saved in the first seconds after the start was taken back (medium, fixed)

- Symptom: on the phone, a setting saved while the app read its AI keys (about 3 s after every start, longer on a
  slow phone, where the Keystore answers on the busy main thread) was taken back in the running app: the language
  chosen went back to the system's, a theme back to the one before. The saved value was in the database, but the app
  showed and used the old one until the next start, and the next save from the settings screen (which sends what the
  screen shows) wrote the old value back for good. On the desktop the same could happen when a proxy password or an
  API key was stored while settings were being saved.
- Root cause: `spawn_ai_keys` (mobile), `refresh` after `api_key_set`, `provider_key_set` and `proxy_password_set`
  called `rebuild_ai(&state, state.settings())`: they read the running settings, then the keys (slow), then replaced
  the AI runtime, settings included. A `settings_save` in between was overwritten with the settings read before it.
  `dashboard_save`, `quick_links_save`, `save_calendar` and `save_jira` read, changed and stored the settings in the
  same way, unguarded against a save running at the same time (the phone runs `mobile_settings_save` off the
  command thread).
- Fix: `AppState::settings_write`, held by every change of the running settings from reading them to taking over
  the new ones: `settings_save` (to its `rebuild_ai`), `refresh_ai` (the rebuild after a key changed, now reading the
  settings under the lock) and `update_settings` (the four partial saves).
- Tests: `phone.test.js` „keeps a saved setting while the app reads its keys again“ (twelve rounds of a key stored
  at the same time as a save; the app must have the saved theme after each); `app.js` checks after every start of the
  suites that the app kept the saved language and theme, and names it when not (the steps after failed with a
  missing German label).

### R4A-2 The Schnellerfassung lost its text with Back (medium, fixed)

- Symptom: a note or task typed into the Schnellerfassung was gone after Back (Android's back gesture from the
  screen's edge, easy to make by accident), after the close button, and after Android ended the app in the
  background (to look something up in another app). The desktop's capture window keeps such a draft, also across a
  restart.
- Root cause: the phone's `CaptureScreen` kept the text in its state only.
- Fix: the capture keeps a draft of a note or task (text, kind, target, due choice) in the workspace's database,
  as the desktop's does (`mobile_capture_draft_get`/`_set` over `capture::load_draft`/`save_draft`, `draftSaver`):
  stored while typing, at once when the app goes to the background or the capture closes, opened again with the
  next capture, removed when it is saved or emptied. Text shared from another app comes first.
- Tests: `model.test.ts` (`captureDraft`, `restoreCapture`); `phone.test.js` „keeps the capture's text after Back
  until it is saved“.

### R4A-H1 The emulator suite stood still for eleven minutes between two starts (harness, fixed)

- Symptom: in both attempts of 41804267003 one tour started eleven minutes after the one before ended; with two of
  them a run reaches the job's limit.
- Root cause: `device.fresh()` ran `am force-stop` and `pm clear`, which only start removing the app's task; the
  removal ends about a second later („Destroy timeout of remove-task, attempt to kill Task“). An `am start -W` in
  that second started the new process into the dying task, which killed it („Killing 7909 … remove task“, „failed
  to attach“), and `am start -W` waited until the system started the activity again by itself, 11:32 later.
- Fix: when `pm clear` met the activity still exiting („Force removing ActivityRecord{… t10 f} isExiting“), `fresh()`
  waits until the system reports that task removed („Destroy timeout of remove-task … #10“); without an exiting
  activity the task is gone at once. `dumpsys activity` does not list a task while it is being removed, so a first
  attempt that looked there let the same stall through (run 41851198571, 15:35:08). `start()` gives
  `am start -W` the same 60 s as the rest of the start: a launch that never completes fails with what the device
  says instead of holding the suite.

### R4A-H2 A system banner lay over the app on the pictures (harness, fixed)

- The suites switch Play services off; apps that need it then post „Enable Google Play services“ as a heads-up
  banner over the top of the screen, on the pictures of all three runs. The suites switch heads-up banners off
  (`heads_up_notifications_enabled 0`); the notice stays in the shade.

## Low (listed, not fixed)

- R4A-L1: the booking form (Zeit, Schnellerfassung → Buchung) is not kept like a draft: Back loses the reference,
  duration and text typed.
- R4A-L2: the keyboard's action key does not submit the booking form or the Git form (they are no `<form>`): the
  user taps „Buchen“ or „Speichern“ after closing the keyboard.
- R4A-L3: the settings screen's Git fields keep what they showed when the screen opened; a sync that changed the
  Git settings meanwhile shows only after the screen is opened again.

## Looked at, no finding

- Offline edits and the sync after: a page edited without a network saves with the text it started from, the sync
  merges a change made elsewhere meanwhile (`PageBody`); a sync while editing reads the page again only when nothing
  typed waits for its save.
- Back: an edit mode, the Leistungsart sheet, the Git setup's steps, a stacked screen, then „Heute“, then the
  background; never quits the app.
- Aufgaben, Zeit, Notizen and Heute with many items (the suites' 14 tasks, the week's bookings, the note tree): the
  lists scroll, the end clears the tab bar, every row keeps its touch size.
