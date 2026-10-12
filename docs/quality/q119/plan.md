# 1.19 plan

Decided by the owner on 2026-10-12. Each item gets a test; the findings files of this release record what
was done and what moved on.

## Owner decisions

- **WebView2 in the Windows installer.** Switch `bundle.windows.webviewInstallMode` from
  `downloadBootstrapper` to `embedBootstrapper` (about +2 MB): no download through the installer's own HTTP
  client, which may not handle a proxy. Offline without WebView2 still needs the full runtime and stays a
  known limit.
- **Android: Git sync through the system proxy.** When the app has no proxy of its own, the phone's Git sync
  uses Android's proxy (system or Wi-Fi), and user-installed certificates where Android allows it.
- **Updates wait for terminal commands.** A running `arcalo <command>` holds a lock file; installing an
  update (Windows NSIS passive mode, macOS and Linux replacement) waits for it with a visible hint and a
  time limit, instead of ending the command.
- **„Alte Daten aufgeräumt“ notice.** Review its wording and the 10 s delay with the owner in the UI pass.
- **Today's column in Zeiterfassung.** The accent tint goes; today is shown like other current states, with
  a neutral tint and text weight (design rule in CLAUDE.md).
- **The visual editor stays alive behind the source view.** Switching to Markdown source and back keeps the
  editor instance (undo history, scroll, selection) instead of rebuilding it; measure memory on long notes.
- **Jira descriptions load lazily.** Lists load summaries only; a description loads when an issue opens.
- **Automatic release when CI is green.** A release starts by itself after CI passed on `main` when
  `docs/releases/v<version>.md` exists for a version that has no tag yet; nothing else releases on its own.

## Carried over

- **Android update feed.** The release workflow skipped `android-latest.json` for 1.18.1 because it could
  not read the APK's signer; make the step show its error and read the certificate reliably. Needs the
  owner's `ANDROID_*` secrets to be useful (A1).
- **Android start without the desktop bundle** (A18) and **tappable task checkboxes in a page** (A19).
- **Line ends of notes taken over by 1.18.0 on Windows** are normalized once.
- **Unexplained single failure of e2e 72** (fallback to the small local model) under load: root cause.
- **e2e 150** leaves its `/tmp/arcalo-e2e-store-*` folder behind.

## File explorer sidebar

Comes from the sidebar audit (`docs/quality/q119/sidebar.md`) once the owner has chosen the items.
