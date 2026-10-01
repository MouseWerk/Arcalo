# macOS: manual checklist

The macOS window behaviour cannot be tested in the Linux e2e runs. Go through this list on a real Mac
(Apple Silicon and, for releases, Intel) with the bundled app from `cargo tauri build` (not `cargo run`:
the Dock, the LaunchAgent and the private API behave differently for an unbundled binary).

Prepare: a workspace with a few pages, the menu bar icon visible, Settings → Desktop with the default
shortcuts (quick capture ⇧⌘Space, quick search ⇧⌘O). Note the build and macOS version in the result.

## Closing and quitting

- [ ] Type in a page, then click the red button at once. The window disappears, the Dock icon keeps its
      running dot, the menu bar still shows Annalo while it is active.
- [ ] Click the Dock icon: the window comes back in front with the text you typed.
- [ ] ⇧⌘W (Fenster → „Fenster schließen“) hides the window the same way; the Dock icon brings it back.
- [ ] ⌘W closes the current tab only, the window stays.
- [ ] With the window hidden, open Annalo again from Launchpad or Finder: the window comes back (no second instance).
- [ ] Settings → Desktop has no „Beim Schließen …“ switch on the Mac.
- [ ] Type in a page, press ⌘Q at once: Annalo quits. Start it again: the text is there.
- [ ] Hide the window, then quit from the menu bar icon („Beenden“) and from the Dock menu („Beenden“).
      Both quit; after a restart nothing is lost and no „database locked“ or recovery dialog appears.
- [ ] Hide the menu bar icon (hold ⌘ and drag it out of the menu bar, or a menu bar manager): closing still
      hides the window and the Dock icon brings it back.

## Quick capture

- [ ] From Safari (Annalo's window hidden): ⇧⌘Space opens the capture window in front, with the cursor in
      the field. Type a line, Enter: it is stored, the window goes away and Safari has the keyboard focus
      again (type in its address bar without clicking).
- [ ] Same with Annalo's main window visible behind Safari: after Esc, Safari has the focus again.
- [ ] From Annalo itself (main window focused): ⇧⌘Space, Esc: the main window has the focus again.
- [ ] Put Safari or Keynote in full screen (its own Space): ⇧⌘Space opens the capture window over it,
      without switching Spaces. Esc returns to the full-screen app.
- [ ] Switch to another desktop Space: the capture window opens there, not on the Space Annalo was started on.
- [ ] Typing: umlauts with a German keyboard (ä ö ü ß), with ⌥U then U on a US layout (ü), and a word with
      the Japanese or Chinese input method: Enter commits the composition and does not store the capture;
      Esc during the composition cancels it and does not close the window.
- [ ] ⌘V pastes, ⌘Z undoes typing, ⌘A selects all in the field.
- [ ] „Auswahl übernehmen“ (set a shortcut, e.g. ⇧⌘Y): copy text in another app with ⌘C, press the
      shortcut: the capture window opens with that text.
- [ ] Click into another app while the capture window is open: it goes away; the other app keeps the focus.

## Quick search

- [ ] ⇧⌘O from another app opens the search in front with the cursor in the field; ⇧⌘O again or Esc closes
      it and the other app has the focus again.
- [ ] Choosing a page opens it in Annalo's main window, which comes to the front (also when it was hidden).
- [ ] Opens over a full-screen app on its own Space.

## Rounded windows

- [ ] Quick capture and quick search in light and dark theme, on a light and on a dark desktop picture:
      only the rounded panel is visible. No dark or white square corners, no rectangle or shadow box
      behind or around the panel, also after the capture window grew (several lines, recent captures)
      and shrank again.
- [ ] Menus, popovers, toasts and dialogs in the main window have clean rounded corners; blurred
      backgrounds (dialog backdrop, toolbars) are blurred.

## Menu bar and shortcuts

- [ ] Copy, paste, cut, undo, redo and select all work in text fields and in the editor, by keyboard and
      through the „Bearbeiten“ menu.
- [ ] ⌘, opens the settings, ⌘\\ toggles the sidebar, ⌘. the focus mode.
- [ ] Tooltips, the palette and Settings → Tastatur show ⌘ ⌥ ⇧ ⌃ glyphs, never „Ctrl“ or „Strg“.
- [ ] The tab bar sits in the title bar; the traffic lights do not overlap tabs or the ribbon, and the
      window can be dragged by the empty tab bar.
- [ ] The menu bar icon is monochrome and follows light/dark menu bars.

## Updates and start

- [ ] With an update available: Settings → Über → install. Annalo stores the editors, installs, quits and
      starts the new version by itself; the new version opens the same workspace without a recovery dialog.
- [ ] Autostart on: a LaunchAgent for Annalo exists in `~/Library/LaunchAgents`. Log out and in: Annalo runs
      in the Dock without a window; a click on the Dock icon shows it. Autostart off removes the entry.
- [ ] Start-up recovery dialog (e.g. data folder not writable): „Beenden“ ends Annalo; nothing keeps
      running in the Dock.
