# Roadmap

What could come next, checked against the code and `docs/releases/` (October 2026, 1.21.1). Releases stay
1.x. Short on purpose: an item moves into a release plan (`docs/quality/q<version>/plan.md`) when the owner
picks it.

## Next candidates

- **Microsoft 365 calendar (Graph).** Reading and writing appointments works with Outlook Classic on Windows
  (1.21). The new Outlook and macOS need a Microsoft 365 sign-in; left open in the 1.21 plan.
- **Recurring bookings.** A daily stand-up at 0.25 h on NP-…/0010, created as draft entries each week and
  confirmed in the week review.
- **The app's own pickers everywhere.** The design guard keeps out system selects, date pickers, dialogs and
  unstyled checkboxes. Still the platform's: the color pickers of the theme editor and the custom accent, the
  tag and widget suggestions (`datalist`) on the desktop. Replace them with the app's popovers, then extend
  `ui/src/lib/controls.test.ts`.
- **Jira guard findings.** The Jira files that were being rewritten in parallel to q122
  (`docs/quality/q122/findings.md`): fix after that merge.
- **Settings guard.** Every settings key comes from the start, is written at run time only, or has a step in
  `settings_migrate.rs` (as Arcalo Mail checks it). Today the fixtures of every release cover loading, not a
  key added without a step.
- **iOS on the emulator matrix.** The Android app runs on the emulator in CI (`e2e/android`); the iPhone and
  iPad app has a simulator build check only.

## Ongoing

- Manual checks on real Windows and macOS hardware for the tray, notifications, autostart, Outlook and the
  installers (`docs/testing/`); the e2e suite runs on Linux.

## Done (formerly on this list)

Graph view and canvas (1.3, 1.4), encryption at rest and app lock (1.10), the Android companion app with Git
sync and the iPhone and iPad app, calendar picker for daily notes, unlinked mentions, Outlook and ICS calendars,
the automatic Markdown mirror, smart folders (saved searches and task filters), the Markdown source mode, the
spellcheck language, the Jira worklog upload, auto-update from GitHub releases (code signing stays off the
table; the Microsoft Store build is the signed Windows path).
