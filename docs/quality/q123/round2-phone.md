# q123 round 2: the phone and tablet app watched

Owner, 2026-10-31: „a full UI watch and fix run“. This part: the phone app (`ui/src/mobile`) on Android and
iOS, and what the full app shows on a phone or iPad. The desktop app is another round's. Branch `q123-phone2`.

## Method

The pictures of CI run 41247262120 on `main` (the latest full run), looked at one by one: the Android tour
(`e2e/android/tour.test.js`, 360x800 and 412x915, light and dark, 19 stops each), the phone suite's pictures
(`phone.test.js`, also 130 % font) and the iOS simulator check (iPhone portrait and landscape, iPad mini and
iPad Pro 13 in both orientations). Light and dark were compared side by side; the colors of the system bars
and of the iOS safe areas were read from the pixels.

## Findings

| # | Symptom | Root cause | Fix | Test |
|---|---|---|---|---|
| P1 | The Android emulator job was red on `main` (41247262120): all nine phone tests at 360x800 failed, „timed out waiting for document.readyState“ after the first reload. | The suite started 8 s after `sys.boot_completed`, while the system still delivered BOOT_COMPLETED (40 s more on the runner). Google Play services missed a deadline then and was killed („bg anr“); Android killed the app with it, as the WebView used its font provider („depends on provider … in dying proc“). | `device.settle()`: `am wait-for-broadcast-idle` before the first start, in both suites. | the emulator job itself |
| P2 | With the keyboard up (Notizen → Suchen, every field on a tab) the tab bar rode on the keyboard; at 360 dp it switched to its sideways layout (icon beside label) and cut off „Zeit“ and „Notizen“, and the screen title shrank. | The compact layout for a phone held sideways was `@media (max-height: 480px)`; Android shrinks the WebView for the keyboard, so an upright phone with its keyboard matched it. The tab bar stayed in the layout above the keyboard. | The compact layout only `and (orientation: landscape)`. `MobileApp` notes the keyboard (visible height well under the screen's own, a text field focused; `keyboardUp`, `typesText` in `model.ts`, also iOS's visual viewport) and hides the tab bar meanwhile (`.m-typing`). | `model.test.ts`; tour: with the keyboard up the tab bar has no height and the title keeps its size |
| P3 | Schnellerfassung → Notiz: „Speichern“ lay half under the keyboard. | The note field kept its 8 lines, the form scrolled under the keyboard. | The capture's form is a column in which the field gives way down to two touch heights. | tour: „Speichern“ ends above the keyboard |
| P4 | With the Leistungsart sheet open, the status bar stayed bright above the dimmed screen, and the navigation bar under the sheet had the screen's color instead of the sheet's (light and dark, both sizes; iOS colors its safe areas from the same call). | The bar colors were set from the shell and the tab bar only, never for the scrim and the sheet. | `MobileApp` watches the body for sheets: status bar = the shell under the scrim (`blendHex`), navigation bar = the sheet's color; back to the screen's when it closes. | `model.test.ts`; the tour's bar check now expects the sheet's colors (`appBarColors`) on every sheet picture |
| P5 | „Fällig“ on Heute and under Aufgaben was always empty on the tour, the tasks showed „due:today“ as text and stood under „Ohne Datum“. | The tour's seed wrote `due:today`, which is no syntax (only ISO days); the due, overdue and priority states were never pictured. | Seed with ISO days (today, yesterday, later), a priority, a task without date, a done task and two bookings of the week. | the tour's pictures |
| P6 | The tour's „time-menu-standard“ picture showed the closed Zeit screen, not the Leistungsart sheet it was meant to show (and so the bar check of the first run of this round saw the screen's colors). | `menus()` took the picture after a fixed wait without checking that anything was drawn; the DOM had the sheet, the screen not yet. | `menus()` waits for a modal dialog or menu laid out with a size, as the sheet's own step does, and fails the part when nothing opens. | tour |
| P7 | The full app („Oberfläche auf Android: Vollständig“) on a phone was 515 px wide on a 360 px screen: the splash off center, the setup's cards and title cut off at the right edge. | Android's WebView widens the layout viewport to fit content wider than `width=device-width` unless the scale may not go below 1; the setup's two columns of cards were wider than the phone. | `minimum-scale=1.0` in the viewport of `index.html` and `mobile.html`. | `splash.test.ts` (both pages); tour: the full app's `innerWidth` is the screen's |
| P9 | The Git setup's title „Git-Synchronisierung einrichten“ reached the right edge of a 360 dp phone; with a larger system font it is cut to „…“. Headers without buttons kept only 8 px at their end. | Screen titles stay on one line with an ellipsis; the header's end padding is made for its buttons. | The setup's title wraps (balanced); a header without buttons keeps the screen's 16 px margin. | `phone.test.js`: at 130 % the setup's title is not cut |
| P8 | The full app on Android flashed a blue tap highlight on every tap, its start page and widgets glowed at their ends and showed the desktop's 10 px and 6 px scrollbars. | The touch rules lived only in the phone app's `mobile.css`. | `app.css`: under `platform-android` (Android and iOS) no tap highlight and `overscroll-behavior: contain`; on a touch screen without a mouse no scrollbars. | the tour's stock UI check on the full app's pictures |
| P10 | Changing the system's font size with Arcalo open (Einstellungen → Display → Schriftgröße) started the app over on Heute (an open screen such as the Git setup was gone), and afterwards Back closed the app instead of going back. On the emulator closing it ended in a native crash: `SIGABRT` „pthread_mutex_lock called on a destroyed mutex“ in `libEGL_emulation.so` (`eglDisplay::~eglDisplay` under `exit`), called from tao's event loop returning in `arcalo_lib::mobile::run` (run 41261179126, tombstone of pid 4574 at 01:54:02 and pid 6595 at 01:55:42, one per size). The phone suite's 130 % test hung at its second Back (`Runtime.evaluate: no answer`), its picture „font-130-gitsetup“ showed Heute, the failure picture the home screen. | `font_scale` is no change the manifest kept the activity for (`configChanges` without `fontScale`): Android made a new activity („finishDrawing of relaunch“) with a second WebView and the app from its start; the old WebView lived on unseen (the test went on driving it), and the Back handler (`onBackButtonPress`, registered with the first activity) was gone, so Back finished the activity and tao ended the process. The crash is the emulator's GL driver tearing down at `exit`; the bug is that the app was closed. | The manifest keeps the activity also for `fontScale`, `fontWeightAdjustment` and `layoutDirection` (with `locale`); `ShellPlugin` sets the WebView's text zoom from the font size at load and on every configuration change. | `phone.test.js`: at 130 % the title's text grows on the page the test drives, which is still the same page and shown; then the checks as before |
| P11 | The tour's full-app part failed in both sizes and themes: „timed out waiting for … .palette input“; its picture „full-app“ showed the full app's intro, the failure picture the setup's first step. | The full app's first run starts with the intro („Willkommen bei Arcalo“, about 23 s), not with the setup; the tour looked for the setup's close button once, found none, and pressed Strg+K, which the intro keeps to itself. When the intro had played through, the setup was open. | The tour waits for the intro, pictures it, skips it, pictures the setup, closes it and waits for the first run to end before it opens the palette. | tour: „full-app-intro“, „full-app-setup“ |
| P12 | The full app's setup on a 360 dp phone: the step's text, the language cards and „Weiter“ ran past the card's right edge (cut off); at 412 dp it fit. | The setup's column (`.fr-main`) had no column size, so its implicit `auto` column took the footer's minimum width (three buttons in one row, 112 px for „Weiter“, 20 px padding) and widened the step with it past the card. | `.fr-main` is one column as wide as the card; the footer may wrap; below 480 px narrower paddings and no minimum width for „Weiter“, so the three buttons stay in one row at 360 dp. | tour: no part of the setup past the card's edge |
| P13 | The full app on the emulator still showed the desktop's 10 px and 6 px scrollbars after P8 (start page, widgets; tour of run 41261179126, all four runs). | P8's rule sat under `@media (hover: none) and (pointer: coarse)`, which the Android emulator does not match. | The rule applies under `platform-android` alone, as the phone app's does under `html.mobile`. | the tour's stock UI check on the full app's pictures |

## Coverage added to the tour

The day note and the day before it (empty state with its button), the end of „Heute“, the note tree opened,
the search with hits and without, the Git setup (provider, a provider picked, the token step, Back step by
step) and its manual form, and, last, the full app („Oberfläche auf Android: Vollständig“) on the phone with
the 1.22 Jira issue view open: a fake Jira on the runner (`adb reverse`), the issue opened from the palette,
checked as `153-issue-view-phone` checks it on the desktop (fills the screen, no sideways scrolling, details
below the description, header buttons at least 44 px) and pictured with its details.

## Looked at, not changed

- Switching a phone to the full app opens the full app's setup (its data never went through it); the tour
  pictures it and closes it.
- The log of every reload shows „Cannot read properties of undefined (reading 'runCallback')“: an answer of
  the shell arriving for the page that was just replaced; nothing on the screen depends on it.

- English with the German date order reads „Saturday, 31. October 2026“: the regional date format is a
  setting of its own (`dateLocale`, en-DE), shared with the desktop.
- „Git-Synchronisierung einrichten…“ takes two lines at 360 dp; the button grows with it, nothing is cut.
- Settings scrolled: a section title under the header is cut by the header's edge, as any scrolled list.
- iOS: the safe areas have the app's colors in both orientations; the iPhone in landscape keeps the content
  clear of the Dynamic Island (insets 62 left and right).

## Not covered

- The iOS check pictures only the start screen (`ios.yml`); sheets, the keyboard and the other tabs on iOS
  are not pictured in CI. The keyboard and sheet fixes use the same code on iOS (visual viewport, `mobile_bars`).
- Real devices (notch cut-outs of other phones, gesture navigation versus three buttons, Samsung's keyboard).
