# 1.13 plan

Owner's choice (2026-10-05): the leftovers from 1.12 (A), the small features found during the 1.12 pass (B),
and the remaining "Annalo" traces in the app (C). Method and bar as in `quality112-brief.md` (incl. the UI bar);
rules in `CLAUDE.md`. Next free migration: 0032. e2e numbers per package below. Release only after a fully
green CI run; release notes in `docs/releases/v1.13.0.md`.

| # | Package | Items | e2e | Status |
|---|---------|-------|-----|--------|
| C | Branding | every user-visible "Annalo" (intro animation, splash, logo mark, window/tray titles, installer and uninstaller texts, notifications, About, file names offered to the user, help texts); keep internal names (crate names, credential service "Annalo", data folder ids) where changing them would break existing installs | 250+ | merged 8d21402 (splash spells Arcalo, branding guards e2e 250) |
| A1 | Editor | hover preview of `[[Seite#Abschnitt]]` opens at the section; HTML share export resolves same-page links `[[#Abschnitt]]` with heading anchors; keep the author's Markdown style on save (bullet marker `*`/`-`/`+`, `~~~` vs backtick fences, `_x_` vs `*x*`, setext headings) where the source used it | 260+ | merged b763e4b |
| A2 | Time and Jira | deleting a `/zeit` chip in the Markdown source view removes its booking like the rich editor (with the same undo toast); a booking restored after the undo toast closed keeps its Jira worklog link (no duplicate worklog, no lost link) | 270+ | merged 84ec87c (migration 0032) |
| A3 | Shell | Projekte table in narrow panes shows that more columns follow (scroll shadow/hint); right panel tab strip is one roving Tab stop with arrow keys; pinned tabs (pin/unpin, kept left, survive restart, not closed by "close others"); rename a page inline in the tree (F2, double click on the title, Enter/Escape) without opening it | 280+ | merged 6b4c43c |
| B1 | Tasks | recurring tasks (daily, weekly on chosen weekdays, monthly, every n days; next occurrence created when done; Markdown syntax that stays readable in other tools, as plain text such as `every monday` (no emoji markers)), bulk actions in Aufgaben (select several: done, move to page, set due date, undo) | 290+ | merged c4b05c1 (migration 0033) |
| B2 | Language | Settings → Sprache & Format: "Wie das System" follows the OS language at every start (and the system language changes are picked up), besides Deutsch and English | 300+ | merged 53cce2f (settings step 13) |
| F | Final | full local e2e, CI green, release 1.13.0, website changelog | | integration fixes 2eca808; CI runs 152/153/155 flaky or date-dependent tests fixed at the root (e2e 47 sync status wait, start page drop used a stale drag state, harness waitFor re-looks up stale elements, e2e 152 week switch, e2e 63 standup on Tuesday); CI run 156 fully green (Linux 784 e2e, Windows incl. MSIX + WACK, macOS); released as 1.13.0; website repositioned and changelog updated |
