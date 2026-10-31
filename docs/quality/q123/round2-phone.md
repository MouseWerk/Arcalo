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
| P6 | The tour's „time-menu-standard“ picture showed the closed Zeit screen, not the Leistungsart sheet it was meant to show. | `menus()` took the picture after a fixed wait, without checking that anything opened. | `menus()` waits for the opener's `aria-expanded` or a modal dialog or menu, and fails the part when nothing opens. | tour |

## Coverage added to the tour

The day note and the day before it (empty state with its button), the end of „Heute“, the note tree opened,
the search with hits and without, the Git setup (provider, a provider picked, the token step, Back step by
step) and its manual form, and, last, the full app („Oberfläche auf Android: Vollständig“) on the phone with
the 1.22 Jira issue view open: a fake Jira on the runner (`adb reverse`), the issue opened from the palette,
checked as `153-issue-view-phone` checks it on the desktop (fills the screen, no sideways scrolling, details
below the description, header buttons at least 44 px) and pictured with its details.

## Looked at, not changed

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
