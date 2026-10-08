# q115: Intro, setup and the first screen

Scope: everything a new user sees on a fresh install, in order: the splash, the intro, the setup, the
first main window and the empty states of the main views (Startseite, Notizen, Aufgaben, Kalender,
Zeiterfassung, Chat). Method: a fresh data folder per run under Xvfb, German and English, light and
dark, 1280x800 and 1920x1080, plus a 900x700 window; every scene and step and the views after the
setup (scratchpad `intro-before/`, after the fixes `intro-after/`). Measured against the positioning
„Dein ganzer Arbeitstag. In einer App.“: notes, tasks, meetings and time in one place, AI optional,
SAP/CATS one part of it and not the identity.

## Findings (before)

1. Story. The welcome scene still says „Dein Arbeitstag an einem Ort“ and „Notizen, Projekte und
   Zeiterfassung“; the first main window says „Notizen, Projekte und Zeiterfassung an einem Ort“, the
   sample „Willkommen“ page „lokaler Arbeitsbereich für Notizen, Projekte und Zeiterfassung“ with
   „LiteLLM-Server verbinden“ as its first task. Tasks and meetings are missing from the story; SAP
   time booking and a server for the assistant read like the core.
2. Too long. Seven scenes (about 35 s), then eleven setup steps (language, theme, work, workspace, AI,
   calendar, Git sync, backup, security, desktop, done). Git, backups, security and the desktop are
   settings a new user does not need on the first minute; each has its section in the settings.
3. Asked twice. A setup closed or finished without answering „Arbeitsbereich“ ends on the old welcome
   choice („Wie möchtest du beginnen?“, three cards and „KI-Anbieter jetzt einrichten“) in an empty
   window: the same question again, after the setup.
4. AI pushed on everyone. The assistant panel is open on the first screen with „Keine KI verbunden …
   KI einrichten“ in a dashed box and suggestion chips; the status bar says „KI einrichten“; the welcome
   choice has „KI-Anbieter jetzt einrichten“. A user who chose „Keine KI“ in the setup sees all of it
   anyway. There is no way to use Arcalo without AI surfaces at all.
5. Empty, not helpful. After the setup the start page is empty (no pages, no hint what to do next);
   the tasks view explains the syntax with `due:2026-09-30 !!` and `every:weekly` in one long line.
6. Punished on day one. The timesheet of a fresh install marks Monday to Wednesday „−8.00 h“ in red
   (days before Arcalo was installed) and the assistant suggests „Lücken in der Zeiterfassung prüfen“.
7. Splash. The name under the mark is set in the fallback font (bold DejaVu; Inter is not loaded yet)
   and sits in a colored glow; the intro then starts with the same mark again, larger.
8. Repetition and noise in the setup. „Schritt 3 von 11“ is shown twice in narrow windows (compact
   line and step eyebrow); every step ends with „Mehr in den Einstellungen“ in accent color.
9. Small slips. The notes scene cuts „Angebot prüfen bis Fr“; the welcome pills wrap with „Lokal“ alone
   on a second row; the time scene's export chip says only „SAP CATS“; the scene captured as
   „01“ is never seen when the window is busy (4.6 s, the shortest).
10. 1920 px: the intro's copy and visual sit small in a large empty field; the setup card stays
    1100 px wide (fine), the first screen is the empty welcome choice.

No colored frames or left bars were found in the flow itself (choices use a neutral tint); the
assistant panel's empty state uses a dashed accent-tinted box, which goes with finding 4.

## Fixed (after)

Same screenshot set after the fixes in `intro-after/` (same file names; the scenes are now
`welcome`, `notes`, `meetings`, `time`, `local`, the steps `language` … `done`).

1. Story (1, 9): the intro has five scenes of 4.5 to 5 s (about 23 s instead of 35): „Dein ganzer
   Arbeitstag. In einer App.“ with the day on one board (note, tasks, meetings, hours, „KI optional“);
   notes that turn into tasks; every meeting with its note; time „wenn du sie brauchst“ with SAP CATS
   and Jira as export targets; local data with AI as an optional switch. The welcome choice, the
   sample „Willkommen“ page and the README tell the same story. Skippable (Esc, „Überspringen“),
   arrows and Space, reduced motion as still slides, unchanged.
2. Setup (2, 8): seven steps instead of eleven: language, theme, „Mit KI / Ohne KI“ (one sentence each;
   with AI the model can be picked or set up later), „Buchst du deine Zeit?“ (yes: working days,
   target, rounding; SAP CATS and Jira named as details for the settings), calendar (optional), how
   to start (sample content, empty, Obsidian import), done. Backups, Git sync, security and the
   desktop keep their defaults; „Fertig“ links to them („Später einrichten“). Narrow windows name
   the step once; „Mehr in den Einstellungen“ is a quiet neutral link.
3. First screen (3, 5): finishing the setup never leads to the welcome choice again (an unanswered
   start is an empty workspace); the side panel is closed; the start page shows „Erste Schritte“
   (first note, today's note, a task, then the calendar, the first booking or the assistant), which
   tick themselves off, hide when done and can be dismissed.
4. AI (4): „KI verwenden“ (setup, Settings → KI & Modelle, policy `AllowAi`): off, no assistant, chat,
   inline AI, summaries, AI widgets or commands, no „KI einrichten“ anywhere, no AI request.
5. Day one (6): days before the first start are not counted as missing time (timesheet, start page,
   suggestions).
6. Splash (7): the name in the system UI font, no glow, about 0.35 s shorter; a ready app is never
   held for more than 0.95 s after the window shows.
7. Empty states (5): the tasks view says the one line to type, the syntax below in small type.
