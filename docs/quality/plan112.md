# 1.12 plan: quality in every area

Owner: also "really 100% UI improvement": every area agent does a visual pass (brief, UI bar), plus A9.

Brief for all agents: quality112-brief.md. At most 2 worktree agents at once. DISPLAY per agent: :430 onwards.

| # | Area | Status |
|---|------|--------|
| S | Microsoft Store (MSIX) build | merged 3fc483e, pushed; MSIX build/install/start/uninstall green on Windows CI (run 124), WACK pending; plus e33b492 (Neu in Arcalo filter) |
| A1 | Notes and editor (TipTap, links, embeds, tables, Markdown round trip, templates, properties, queries, Mermaid) | merged bb95e4c, pushed (14 fixes) |
| A2 | Time tracking: /zeit, timer, timesheet, CATS export, Kalender, absences, balance, week proposal, day review | merged 48d846f, pushed (16 fixes) |
| A2b | Time follow-ups: /zeit chip and booking stay linked (edit/delete either side), timer pause and midnight split, CATS decimal separator option | merged 81c17fb, pushed (migration 0031, e2e 220) |
| A3 | Integrations: Jira, Outlook/ICS, mail and follow-up, meeting prep, status report | merged c85f9a2, pushed (18 fixes) |
| A4 | AI: assistant/chat, inline AI, briefing, voice notes and whisper models, providers | merged 9ef5893, pushed (11 fixes) |
| A5 | Data: storage, encryption, backups and targets, trash, versions, Markdown mirror, Git sync, import, attachments, migrations | merged 638a4a3, pushed (8 fixes) |
| A5b | Data follow-ups: Git sync after restoring an older backup (don't push the old state as new), attachments used only by old versions/mails not 'unused', change encryption key, huge vault import without one long write lock, SQLite English text in German error toast; + lazy quick-capture window | merged, pushed (6 fixes, e2e 230-232) |
| A6 | Settings, security (app lock, secrets), updates, network/proxy, onboarding, company policies | merged f6e6809, pushed (12 fixes); + f8caa96 cargo fetch before UI build in release |
| A7 | Shell and views: sidebar, tabs, panes, search/palette, start page widgets, graph, canvas, tasks, projects, issues; visual and a11y across themes | merged 9d89341, pushed (14 fixes) |
| A8 | CI reliability: Linux e2e 55 and 14, ~30 s app start on GitHub runners; also: editor loses the text selection right after a note opens (seen in e2e 16 and 170, worked around in 170 only) — find the root cause in the app | merged 8690d08, pushed (selection fix, private D-Bus in e2e, no xdg-open, CI concurrency); confirm on next CI run |
| A9 | UI design system pass: every view side by side, tokens, type scale, spacing, icons, motion, consistency across views; final visual polish after A1–A8 | merged (12 fixes, tokens consolidated, e2e 240) |
| F | Final: full e2e, CI green (Linux, Windows, macOS), release notes, release 1.12.0, website update | in progress: full e2e + CI |
