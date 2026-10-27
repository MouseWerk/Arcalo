# 1.20 plan

Started by the owner on 2026-10-12. Items are added as they are decided.

## The full app on large Android screens

The Android app shows the full desktop app instead of the phone app when it runs on a large screen: a
tablet, Android's desktop mode (desktop windowing, an external display), and Google's upcoming desktop
version of Android (Android on PCs). Phones keep the phone app.

- **Choosing the interface.** Today the Android window always opens `mobile.html`
  (`src-tauri/tauri.android.conf.json`). It should pick at start, from the window size and the device
  (e.g. at least 600 dp on the shorter side, a desktop or freeform window, a mouse and keyboard), between
  `mobile.html` and the desktop `index.html`, and follow when a window is resized or moved to another display
  (with unsaved text stored first). A setting overrides it („Automatisch / Telefon / Vollständig“).
- **What the full app does on Android.** Everything that works there: notes, tasks, calendar, time
  tracking, the assistant, Git sync, split panes, the file sidebar, keyboard shortcuts, drag and drop.
  Desktop-only parts are hidden or replaced, never broken: tray, global shortcuts, autostart, the command
  line and PATH, the desktop updater (the Android update path is used), local folders outside the app's
  storage (the Android document picker instead), whisper models if too heavy.
- **Input.** Mouse, trackpad, keyboard and touch together: hover states, right click and long press for
  menus, keyboard focus, scrolling with a wheel, resizing panes by touch.
- **Same data.** Both interfaces use the same workspace on the device; switching never loses or duplicates
  anything.
- **Tests.** The interface choice as unit tests (sizes, modes, setting); the full app's Android build in
  CI; screenshots of the full app at tablet sizes (portrait and landscape) and in a desktop window, and a
  manual checklist for a tablet, a phone in desktop mode on an external display, and an Android PC when
  available.

## Setting up Git sync

Decided by the owner on 2026-10-13: a guided setup instead of the form; sign-in stays token-only (no
browser sign-in, the standing rule holds).

- **Provider first.** GitHub, GitLab, Gitea/Forgejo, Bitbucket or another server; the address field
  understands what people paste (`https://github.com/user/repo`, `.git` or not, `git@` SSH addresses with a
  clear note that HTTPS is needed, a repository page URL).
- **Token made easy.** A button opens the provider's token page with the needed scopes preselected where
  the provider supports it (GitHub fine-grained or classic `repo`, GitLab `read_repository`/`write_repository`,
  Gitea `repository`), with one sentence per provider on what to tick; the token goes into the OS credential
  store as today.
- **Pick or create the repository.** With the token, Arcalo lists the user's repositories to pick from, or
  creates a new private one (name proposed, e.g. „arcalo-notizen“); an existing repository with other content
  is explained before the first sync (adopt and merge, never overwrite).
- **Check before saving.** Reach the server, the token's rights (read and write), the branch, and say in
  plain words what is wrong (token expired, missing write right, repository not found, proxy or
  certificate) with the fix.
- **Same on the phone.** The phone app's Git sync setup uses the same steps in its own layout.
- **Tests.** Fake provider servers for GitHub, GitLab and Gitea APIs; unit tests for URL parsing and error
  mapping; e2e for the wizard (pick, create, errors); no real internet in tests.
