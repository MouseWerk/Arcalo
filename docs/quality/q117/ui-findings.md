# UI findings, 1.17

Focused audit of the 1.16 changes (keep-alive tabs, tab strip, reviews, start page, Kalender,
Projekte, Settings → Tastatur, shortcut notation, English texts) against
`design/principles.md` and `quality/perfection-pass.md`. Screenshots and layout checks come from
`e2e/tests/371-ui-audit.test.js`: start page, Zeiterfassung, Kalender, Wochenrückblick,
Tagesrückblick, Aufgaben, Projekte, Settings → Tastatur and a note with tags, a query and many
tabs, in Arcalo Hell, Arcalo Dunkel, Hoher Kontrast Hell and Hoher Kontrast Dunkel at 900, 1280
and 1920 px and split at 1280 px, plus English at 1280 px and split at 900 px: about 160 images.
The layout check (clipped labels, controls outside their box, overlaps, sideways scrolling) runs
on every one of them; about 20 across all themes, widths, the split and English were looked at by
hand, plus close-ups of the tab strip, the toolbar and the start page cards. The audit workspace
has no calendar source, so Kalender's day heads are checked by e2e 360 (with events).

| Id | Severity | Status |
|---|---|---|
| U1 | major | fixed in `f26f57e` |
| U2 | minor | fixed in `f26f57e` |
| U3 | minor | fixed in `f26f57e` |
| U4 | minor | fixed in `f26f57e` |
| U5 | polish | fixed in `f26f57e` |
| U6 | polish | fixed in `f26f57e` |
| U7 | polish | fixed in `f26f57e` |
| U8 | minor | fixed in `7275ac2` |
| U9 | major | fixed in `07765fd` |
| U10 | polish | not fixed: intended |
| U11 | polish | not fixed: intended |
| U12 | polish | not fixed: owner's call |
| U13 | minor | fixed in `c216e82` |
| U14 | minor | fixed in `c216e82` (test only) |

## U1 A palette command that shows the other pane's tab jumps back

- **Where:** command palette with the window split (`components/CommandPalette.tsx`).
- **Reproduce:** split the window, open Kalender in the right pane, click into the left pane's
  note, Strg+K → „Kalender“.
- **Expected / actual:** the right pane is active and shows Kalender / the right pane lights up
  for a frame, then the left pane is active again (keys and the next palette command go there).
- **Root cause:** confirmed. Since 1.16 the palette gives the focus back to where it was when it
  closes; that element is in the left pane, and focusing a pane makes it the active one.
- **Fix:** no focus return when the element it came from is in a pane that is no longer active.
- **Test:** `e2e/tests/372-ui-audit-fixes.test.js` „a palette command that shows the other pane's
  tab keeps that pane active“ (fails without the fix).

## U2 Kalender: today's head wraps on a Saturday

- **Where:** Kalender → Arbeitswoche at 1280 px with the side panel, `styles/app.css` (day head).
- **Reproduce:** on a Saturday (the work week shows today as a sixth column) or with six
  workdays; a daily note and bookings today.
- **Expected / actual:** note, hours and review on one row / the review chip on a second row
  (the 1.16 test passed on weekdays only).
- **Root cause:** confirmed: six columns leave about 73 px for three chips that need 78 px.
- **Fix:** below 100 px the chips move closer together and into the head's padding.
- **Test:** `e2e/tests/360-visual-regressions.test.js` now runs with six workdays including
  today, so it checks six columns on every day of the week (fails without the fix).

## U3 Note toolbar cut in half in a narrow pane

- **Where:** a note in a split pane at 900 or 1280 px with the side panel
  (`editor/EditorToolbar.tsx`, `styles/editor.css`).
- **Expected / actual:** buttons hidden past the edge are hinted / the AI button shows half,
  squeezed against „Markdown-Quelltext“.
- **Root cause:** confirmed: when even the essential groups do not fit, the toolbar scrolls
  sideways without a scrollbar and without a hint.
- **Fix:** a fade at each edge that hides buttons (as the tab strip has), following the scroll.
- **Test:** `e2e/tests/372-ui-audit-fixes.test.js` „the note's toolbar fades out …“.

## U4 Projekte: the project menu outside its card

- **Where:** Projekte in a pane of about 300 px (split, or 900 px with the side panel).
- **Expected / actual:** „Netzplan“ and „…“ (Projektaktionen) reachable / the card cuts off „…“
  and the right part of „Netzplan“.
- **Root cause:** confirmed: the head row (code, name, button, menu) does not wrap.
- **Fix:** the head row wraps; on wide panes nothing changes.
- **Test:** `e2e/tests/372-ui-audit-fixes.test.js` „a project's actions and a Vorgang's booked
  hours stay inside a narrow card“.

## U5 Projekte: booked hours run under the next column

- **Where:** the Vorgang table in a narrow card, „12,00 / 16,00 h gebucht“ under the name.
- **Root cause:** confirmed: the line inherits `nowrap` from the number style.
- **Fix:** it wraps in the name column.
- **Test:** same test as U4.

## U6 Start page: „von 40,00 h“ breaks before „h“

- **Where:** „Zeit diese Woche“ in a narrow pane (split at 1280 px with the side panel).
- **Fix:** the target stays on one line; the gap badge moves to a line of its own.
- **Test:** `e2e/tests/372-ui-audit-fixes.test.js` „… the week's hours on the start page stay on
  one line …“.

## U7 Kalender: the week review button is 17 px high

- **Where:** the icon next to „KW 41“ when its label is hidden (panes below 900 px).
- **Fix:** at least 22 px high.
- **Test:** same test as U6.

## U8 English: literal „take over“ phrases

- **Where:** `ui/src/locales/en.ts` (week proposal „Take all over“ / „Take {n} over“, „Take from
  the ribbon…“, „Take colors from“, „Take theirs“, „Taken from here automatically“, „takes them
  over“, „takes the summary along“, „take everything“, „Take the Teams … link“, „Take folders and
  links“) and the week proposal reason „last taken to“ (`crates/arcalo-core/src/weekplan.rs`).
- **Root cause:** the glossary forbids „take over“ only as adjacent words.
- **Fix:** „Apply all“, „Apply {n}“, „Add from the ribbon…“, „Copy colors from“, „Use theirs“,
  „Applied automatically from …“, „Import …“, „Include …“, „last booked to“.
- **Test:** `ui/src/lib/translations.test.ts` rule „take-over“ (also split around its object).

## U9 Kept tabs moved in the document on every switch

- **Where:** `lib/keepalive.ts`, `components/Workspace.tsx`.
- **Root cause:** confirmed: the kept places were rendered most recent first, so React moved the
  hidden views on every tab switch (131 moves in 40 switches between five tabs). A moved view
  loses its scroll offsets and selection for a moment, reloads frames and fires its observers.
- **Fix:** stable order: a place shown again stays where it is; a new place goes first; the
  least recently shown one is dropped beyond five.
- **Test:** `ui/src/lib/keepalive.test.ts` (order and a rendered pane with a mutation observer),
  `e2e/tests/370-kept-tabs-order.test.js` (40 switches, markers, scroll, caret, undo).

## U10 Tab strip: the next tab fades out at the right edge

- **Status:** not fixed: intended (1.16 design: a fade where tabs are hidden, the list button
  opens all of them).

## U11 Page icon left of a wide page's title

- **Status:** not fixed: intended (the icon hangs left of the title column at 1920 px).

## U12 Zeiterfassung: today's column tinted with the accent

- **Where:** the week table in dark themes.
- **Status:** not fixed: a background tint (no frame), as the 1.16 contrast pass set it for
  today markers; whether today should use the neutral tint is the owner's call.

## U13 A dropdown opened with the keyboard takes the option under a resting pointer

- **Where:** every dropdown (`components/Select.tsx`), e.g. Settings → Darstellung → Skalierung.
- **Reproduce:** leave the mouse where the list will open, focus the dropdown, press ↓.
- **Expected / actual:** the selected option („100 %“) is active / the option under the pointer
  („95 %“); Enter then picks it. Found as a flaky e2e 36 that failed only on a display where an
  earlier test had left the pointer there.
- **Root cause:** confirmed: WebKit reports a mouse move when the list appears under the
  pointer, and every mouse move over an option highlighted it.
- **Fix:** only a move to another position highlights an option.
- **Test:** `ui/src/components/Select.test.ts` „keeps the selected option active when the list
  opens under a pointer that does not move“ (fails without the fix); e2e 36 passes on that display.

## U14 e2e 330 failed on weekends

- **Where:** `e2e/tests/330-visual-polish.test.js` „German shortcut names, today's marker and one
  hour format“.
- **Root cause:** confirmed: on a Saturday the day review has no target („kein Arbeitstag“), the
  test expected „x,xx h / y,yy h“. The app is right.
- **Fix:** the test makes today a workday for that check (and restores the workdays), so it
  checks the target format on every day.
