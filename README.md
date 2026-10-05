<p align="center">
  <img src="docs/brand/annalo-icon-1024.png" width="112" alt="Arcalo logo">
</p>

<h1 align="center">Arcalo</h1>

<p align="center">
  <b>Take the notes. The timesheet follows.</b><br>
  Notes, time tracking and your own AI in one local-first desktop app, made for SAP project work.<br>
  Markdown notes with <code>[[links]]</code> like Obsidian · SAP PS and Jira time booking with <code>/time</code> · an assistant on <b>your</b> AI providers (LiteLLM, OpenAI-compatible, Azure, Ollama)
</p>

<p align="center">
  <a href="https://arcalo.mousewerk.de/"><b>Website</b></a> ·
  <a href="https://github.com/MouseWerk/Arcalo/releases/latest"><b>Download</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#a-quick-tour">Tour</a> ·
  <a href="https://arcalo.mousewerk.de/de/">Deutsch</a>
</p>

<p align="center">
  <a href="https://github.com/MouseWerk/Arcalo/actions/workflows/ci.yml"><img src="https://github.com/MouseWerk/Arcalo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/MouseWerk/Arcalo/releases/latest"><img src="https://img.shields.io/github/v/release/MouseWerk/Arcalo?label=release" alt="Latest release"></a>
  <a href="https://github.com/MouseWerk/Arcalo/releases"><img src="https://img.shields.io/github/downloads/MouseWerk/Arcalo/total?label=downloads" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/MouseWerk/Arcalo" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6b5bd6" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%C2%B7%20Rust%20%C2%B7%20React-2f2f3a" alt="Tauri 2, Rust, React">
</p>

<p align="center">
  <img src="docs/screenshots/split-view.png" alt="Arcalo: two notes side by side with the assistant panel" width="100%">
</p>

*Arcalo* comes from the Latin *arca*, the chest where the Romans kept their records: your notes and your working
hours, kept together. Up to version 1.6 the app was called Annalo; 1.7 updates an Annalo installation in place and
keeps its data, settings and credentials (see `docs/testing/rebrand-windows.md`).

Everything lives in one SQLite database on your computer. There is no cloud account and no telemetry. The only
network traffic is what you set up yourself: your AI providers, your calendars, an optional Git remote for backups,
and update checks against this repository's releases.

The app speaks English and German. It starts in your system's language (English for everything that is not German)
and switches live under Settings → Language & format.

## Why Arcalo

Written for SAP consultants and project people who spend the day in workshops, write everything down and owe a
timesheet at the end of the week.

- **The timesheet comes from your notes.** `/time NP-8801/1020 2.5h` in the meeting note books on the network
  and activity, with the remaining plan hours shown while you type. “Propose the week” drafts the rest from your
  meetings, focus sessions and edited pages; the week exports to SAP CATS, Jira worklogs, CSV or JSON.
- **SAP PS terms built in.** Networks, activities and activity types, budgets with ETC and EAC, the critical path,
  and budget warnings when a booking crosses a threshold.
- **Meetings next to booked time.** Outlook Classic (also shared and sub-calendars, no admin rights or app
  registration) and ICS calendars, with “Book time” and “Meeting note” on every meeting.
- **Jira in the same place.** Issues and saved searches offline, issue keys as live chips in notes, worklogs from
  `/time 1h PROJ-123`.
- **AI that stays where your company allows it.** Your LiteLLM, Azure OpenAI or OpenAI-compatible endpoint, or a
  local Ollama; `#privat` notes go only to the local model. Voice notes are transcribed on your computer.
- **Nothing leaves your machine unasked.** One local database, no account, no telemetry, optional encryption,
  backups and Git sync. Runs per user without admin rights, or portable from a USB stick.

### How it compares

- **Obsidian:** the same Markdown habits (`[[links]]`, callouts, Excalidraw drawings) and a vault import, plus
  time booking, timesheet, calendar and Jira in the app itself instead of plugins.
- **Notion and other cloud workspaces:** no account and no server; your client notes stay on your computer.
- **A spreadsheet or the CATS screen at 5 pm on Friday:** the hours are proposed from what you did and wrote that
  week, and you only review them.
- **Tempo or Jira time tracking alone:** bookings go to SAP networks and to Jira issues from the same note.

## Quick start

1. Download the installer for your system from the [Releases page](https://github.com/MouseWerk/Arcalo/releases/latest)
   (Windows, macOS, Linux; details under [Download](#download)) and start Arcalo.
2. The setup asks for language, working time, workspace (sample data, Obsidian import or empty), AI and calendar;
   every step can be skipped.
3. Open today's daily note (**Ctrl Shift D**), write down what you did and type `/time` to book it. More under
   [First steps](#first-steps), and on the [website](https://arcalo.mousewerk.de/).

**Contents:** [Why Arcalo](#why-arcalo) · [Quick start](#quick-start) · [Download](#download) · [Tour](#a-quick-tour) · [Features](#what-you-get) · [First steps](#first-steps) ·
[AI providers](#connecting-ai-providers) · [Proxy](#network-and-proxy) · [Customizing](#customizing) ·
[Your data](#your-data-is-safe) · [Git sync](#git-sync) · [Keyboard](#keyboard) · [Building](#building) ·
[Updates](#setting-up-automatic-updates) · [Tests](#tests)

## Download

Get the latest version from the [**Releases page**](https://github.com/MouseWerk/Arcalo/releases/latest).

| System | File | Notes |
|---|---|---|
| **Windows 10/11** (x64) | `Arcalo_<version>_x64-setup.exe` | Installs per user into `%LOCALAPPDATA%`, **no admin rights needed**. Updates itself. WebView2 is installed silently if it is missing |
| **Windows 10/11** portable | `Arcalo_<version>_x64-portable.zip` | Unpack anywhere (a USB stick) and start `Arcalo.exe`: all data stays in `data` next to it, nothing is written to the user profile (no autostart, no jump list). Updates: unpack the new ZIP over the folder. API keys and tokens are kept in each computer's Credential Manager, not on the stick |
| **macOS 11+** Apple Silicon | `Arcalo_<version>_aarch64.dmg` | Drag into *Applications*. Updates itself. Not notarized: see [macOS](#macos) for the one-time Gatekeeper step |
| **macOS 11+** Intel | `Arcalo_<version>_x64.dmg` | Same as above |
| **Linux** (x64) | `Arcalo_<version>_amd64.AppImage` | Any distribution: `chmod +x Arcalo_*.AppImage && ./Arcalo_*.AppImage`. Updates itself in place, like Windows and macOS |
| **Linux** (x64) | `Arcalo_<version>_amd64.deb` | Debian/Ubuntu: `sudo apt install ./Arcalo_*.deb`. Shows new versions with “Open release page”; the package manager installs them |

The first start plays a short intro (about half a minute, skippable with Esc) and then walks through a setup that
writes your answers straight into the settings: language, theme, working time and whether you book time at all,
workspace (sample data, Obsidian import or empty), AI, calendar, Git sync, backups and desktop. Settings → About →
“Replay the introduction” plays it again.

## A quick tour

### Notes that link to each other

Live-preview Markdown editing, with `[[wiki links]]`, backlinks, tags, tables, tasks and a page tree. Hovering a link
shows a preview of the linked page.

<p align="center">
  <img src="docs/screenshots/note-dark.png" width="49%" alt="A note in dark mode">
  <img src="docs/screenshots/link-preview.png" width="49%" alt="Hover preview of a [[link]]">
</p>
<p align="center">
  <img src="docs/screenshots/table-toolbar.png" width="49%" alt="Table editing toolbar">
  <img src="docs/screenshots/versions-diff.png" width="49%" alt="Version history with a diff against now">
</p>

### Tables, boards and page layouts

Give the subpages of a page typed properties (select, number, date, person, …) and show them as a sortable,
filterable table or as a Kanban board: drag a card to another column and its status changes. Notes get foldable
sections, columns, a live table of contents and footnotes, all plain Markdown that Obsidian reads too.

<p align="center">
  <img src="docs/screenshots/board-view.png" width="49%" alt="Subpages as a Kanban board">
  <img src="docs/screenshots/table-view.png" width="49%" alt="Subpages as a table with typed properties">
</p>
<p align="center"><img src="docs/screenshots/editor-blocks.png" width="90%" alt="Table of contents, columns, foldable callouts and footnotes"></p>

### Present, focus, look back

Any note becomes a full-screen presentation, split at `---`, with speaker notes and a presenter view. Focus sessions
book their time on an activity by themselves, and the timeline answers “What did I do on Tuesday?”. At the end of
the day the daily review puts it on one page: pages edited, hours per WBS against your target with the gaps, tasks
done and overdue, meetings booked or not, focus sessions and files. One click writes it into the daily note, and a
local model (never a cloud provider) can add a short summary.

<p align="center">
  <img src="docs/screenshots/presentation.png" width="49%" alt="A note as a presentation">
  <img src="docs/screenshots/activity-feed.png" width="49%" alt="Timeline of yesterday with pages, tasks and focus">
</p>
<p align="center"><img src="docs/screenshots/day-review-dark.png" width="90%" alt="Daily review of a Wednesday: hours per WBS with the unbooked gap, meetings not booked yet, edited pages and tasks"></p>

### A start page you arrange yourself

The start page is a set of boards in a twelve-column grid, shown as tabs. “Today” opens with the daily overview:
today's meetings on a timeline with the next one, a countdown and its “Join” button, hours booked against your
target, the timer, due tasks you tick off right there, focus sessions and quick actions. Other widgets show the next
meetings per calendar, the week per day or WBS, budgets with a forecast of when they run out, a project, recent and
pinned pages, an embedded page, the timeline, links, the week proposal, a clock and the last workday's review.

“Customize” lets you drag and resize widgets (also with the keyboard), set them up and duplicate them, add them from a
searchable gallery, start from the templates “Day start”, “Project lead” or “Minimal”, and export or import a board.
The “Query” widget is your own: pages, tasks, bookings or meetings filtered like `#project status: open` or
`due: week prio>=1`, shown as a list, table, number or bar chart.

<p align="center"><img src="docs/screenshots/dashboard.png" width="90%" alt="Start page: the Today widget with the meeting running now, due tasks, timer, meetings, time this week, budgets and recent pages"></p>

### More widgets, in five sizes

1.7 adds widgets for the working day: your **overtime balance** (booked hours against the target of every
day, with an opening balance), **vacation** with days left, taken and planned and the public holidays of every
German state, **deadlines** from open tasks and date properties, **flagged Outlook e-mails** (Windows, Outlook
Classic), the **next meeting** with a live countdown and “Join”, **team availability** from your colleagues'
calendars, **charts** over a page's table or your bookings, an **activity heatmap**, a **Kanban mini-board**,
a **scratchpad**, the **inbox**, **“A year ago”**, **writing stats**, more time zones in the **clock**, a
**checklist** and the state of **backups and Git sync**. Every widget comes in five sizes (keys 1 to 5 in
edit mode), and a board exports to a `.dashboard.json` file that others can import; credentials are never
written into it.

<p align="center"><img src="docs/screenshots/dashboard-widgets-dark.png" width="90%" alt="Start page with the overtime balance, vacation, the next meeting with a countdown, hours per activity as a bar chart, deadlines and team availability"></p>

<p align="center"><img src="docs/screenshots/balance-vacation-dark.png" width="60%" alt="Overtime balance of +11.75 h and the vacation account with days left, taken and planned and the next public holiday"></p>

### Time tracking with `/time`

Type `/time NP-8801/1020 2.5h #DEV System integration` in any note. Network, activity and activity type
autocomplete, with the remaining plan hours shown. (`/zeit` works as well, in both languages.) A page linked to an
activity shows a work card with budget, ETC and a timer. The weekly timesheet exports to SAP CATS, Jira, CSV or JSON.

Time tracking is optional. If you do not book time, switch off “Use time tracking” (in the first-run setup or under
Settings → Time tracking): the timesheet, projects, timer, `/time`, budgets, the week proposal, the booking parts of
the Calendar, start page and daily review, the assistant's time tools and every reminder about bookings disappear,
and nothing runs in the background for them. Arcalo is then a notes, calendar and AI app. Booked time stays in the
workspace and is back as soon as you switch it on again.

<p align="center">
  <img src="docs/screenshots/time-suggest.png" width="49%" alt="/time autocomplete with recently booked activities and the hours left">
  <img src="docs/screenshots/page-work-card.png" width="49%" alt="Work card on a page linked to an activity">
</p>
<p align="center">
  <img src="docs/screenshots/timesheet-dark.png" width="49%" alt="Weekly timesheet">
  <img src="docs/screenshots/projects-dark.png" width="49%" alt="Projects with budget, EAC and critical path">
</p>

### Jira, Cloud and Server

Settings → Jira connects Jira Cloud (Atlassian e-mail and API token) or Jira Server / Data Center (personal
access token); the token lives in the Windows Credential Manager or the macOS Keychain. Your open issues and
saved JQL searches sync in the background and stay available offline. The **Issues** page groups them by
site, project, status, sprint or priority; an opened issue shows its description, the last comments, the
pages that name it and the activity it books on. A key such as `PROJ-123` in a note becomes a live chip with
type, status and title and a hover card. `/time 1h PROJ-123 Fix login` books on the issue's activity and can
post a worklog to Jira. There are widgets for your issues, a saved search and the active sprint.

<p align="center">
  <img src="docs/screenshots/jira-issues-dark.png" width="59%" alt="The Issues page with an opened bug: details, description, a comment and the page that names it">
  <img src="docs/screenshots/jira-chip-dark.png" width="39%" alt="An issue key in a note as a chip with its hover card">
</p>

### Voice notes

Record from the ribbon, the command palette, `/voice` in a note, a meeting in the calendar or a global
shortcut. whisper.cpp transcribes on your computer (German or English, models Base, Small or Large v3 Turbo,
downloaded once from your administrator's address, the `whisper-models-v1` release on GitHub or Hugging
Face, each checked against its SHA-256); the audio is kept as FLAC and never uploaded. “Summarize” adds a
summary, decisions and the action items as real tasks with `@Person` and `due:`; `#privat` notes stay on the
local model.

<p align="center"><img src="docs/screenshots/voice-note-dark.png" width="70%" alt="A voice note with the audio file, the collapsed transcript, a summary, a decision, two tasks and an open point"></p>

### AI that stays on your server

The assistant answers from your notes and cites its sources: hovering `[1]` shows the passage. Every chat is saved
as it goes and can be picked up later from the history, which searches titles and messages. Inline AI rewrites
selected text. Meeting notes turn into decisions and tasks. `/time 1h Mapping workshop` on a page without an
activity asks the AI which activity the time belongs to and books only after you confirm.

<p align="center">
  <img src="docs/screenshots/cite-preview.png" width="49%" alt="Answer with a cited source">
  <img src="docs/screenshots/assistant-history-dark.png" width="49%" alt="Chat history: pinned, today, yesterday, last 7 days and older">
</p>
<p align="center">
  <img src="docs/screenshots/inline-ai-preview.png" width="49%" alt="Inline AI on a selection">
  <img src="docs/screenshots/meeting-summary.png" width="49%" alt="Meeting summary with decisions, tasks and open points">
</p>
<p align="center"><img src="docs/screenshots/smart-time-confirm.png" width="70%" alt="Smart /time asks before booking"></p>

### Meetings next to your booked time

The Calendar (Ctrl Shift E) shows your meetings from Outlook Classic or any ICS calendar next to the time you booked:
day, work week, week, month and a list. Outlook is not limited to the default calendar: sub-calendars, further and
shared mailboxes, PST files, calendars colleagues share with you, rooms and groups can be added, each in its own
color. The legend above the grid hides or shows a calendar in the view, and a meeting that is in two calendars
appears once.

<p align="center"><img src="docs/screenshots/calendar-week.png" width="90%" alt="Calendar work week with three calendars in the legend, meetings and the booked time as a lane next to them"></p>

Click a meeting and “Book time” opens the entry prefilled with its day, time, length and subject; the WBS of the last
meeting of the same series or subject is suggested. “Meeting note” creates a note with date, attendees and the
meeting link. The join button finds Teams, Zoom, Webex, Google Meet and other links also in the meeting's
description, behind company link protection such as Microsoft Safe Links or Proofpoint. Meetings you do not book can
be marked “Don't book”, and the timesheet lists the week's meetings that are not booked yet.

<p align="center">
  <img src="docs/screenshots/calendar-meeting.png" width="49%" alt="A meeting with its Teams join button, Book time and Meeting note">
  <img src="docs/screenshots/outlook-calendars.png" width="49%" alt="Choose calendars: the default calendar, a sub-calendar, a colleague's shared calendar, a free/busy calendar and a room">
</p>

“Propose the week” turns the week's meetings, focus sessions and page editing into a timesheet draft that you check
by day and take over in one go. Every line says where it comes from and how sure Arcalo is about the activity (“like
last week”, “Page … belongs to NP-8801/1030”); an activity you change is remembered for that page or meeting series.
Meetings from calendars that colleagues shared are left out unless you switch “Use for booking suggestions” on for
that calendar.

<p align="center"><img src="docs/screenshots/week-proposal-dark.png" width="90%" alt="Propose the week: proposals by day with source, time, length, WBS and a confidence badge"></p>

An e-mail becomes a task or a note in two clicks: select it in Outlook Classic and choose “Take over current e-mail”
(palette or your own global shortcut), drop an `.eml`/`.msg` file onto the window or paste the header lines of a
forwarded mail. The task gets a due date and priority, the note the sender, date, text and the attachments you
ticked; both carry an e-mail chip that opens the mail again in Outlook.

<p align="center"><img src="docs/screenshots/mail-to-task.png" width="70%" alt="Take over e-mail: a mail from Outlook becomes a task with due date, priority and an attachment"></p>

### Quick capture and link groups

Ctrl Shift Space opens a small capture window from any program, always in the middle of the primary screen. Text goes
into today's daily note, the “Inbox”, the note of the meeting running now or, after `>`, any page. Several lines,
tasks with a due date (`todo … by Fri`), `[[links]]`, `#tags` and `/time` work there too. Links and apps in the
ribbon can be grouped behind one icon.

<p align="center">
  <img src="docs/screenshots/capture-picker.png" width="49%" alt="Quick capture: the page picker after typing >order">
  <img src="docs/screenshots/capture-task.png" width="49%" alt="Quick capture into a page with a task due on Friday">
</p>
<p align="center"><img src="docs/screenshots/link-group-dark.png" width="90%" alt="A link group “SAP” opened next to the ribbon"></p>

**Bookmarks from your browser.** “Import bookmarks” (in “Add app / link”, the ribbon's context menu, the command
palette and Settings → Startup) reads the bookmarks of Chrome, Edge, Brave, Vivaldi, Opera, Arc, Chromium, Firefox and
Safari on Windows, macOS and Linux, every profile with its name, or a browser's HTML export (chosen or dropped onto
the dialog). The browsers' files are only read. Pick folders and links in a tree; folders of the bookmarks bar become
link groups, its links ribbon links, and whatever does not fit the ribbon (40 entries, 60 per group) or you send there
becomes a Markdown page under “Bookmarks”. Links already in the ribbon are skipped, so importing again adds only what
is new, and the toast's “Undo” takes the whole import back. Safari needs Full Disk Access for Arcalo; without it,
export the bookmarks in Safari and import the HTML file.

<p align="center"><img src="docs/screenshots/bookmark-import.png" width="90%" alt="Import bookmarks: the bookmarks bar, an existing group and a new group with a preview of the ribbon"></p>

### Tasks, daily notes and quick search

Tasks from all notes are grouped by due date. The daily-notes calendar shows which days have a note and the booked
hours per day. The global quick search (Ctrl Shift O) works from any program.

<p align="center">
  <img src="docs/screenshots/tasks-view.png" width="32%" alt="Tasks across all notes">
  <img src="docs/screenshots/daily-calendar.png" width="32%" alt="Calendar of daily notes with booked hours">
  <img src="docs/screenshots/quick-search.png" width="32%" alt="Global quick search">
</p>

### Made to fit you

20 themes (Nord, Catppuccin, Dracula, Solarized, Gruvbox, Tokyo Night, GitHub, Rosé Pine, Everforest, high contrast
and more) plus your own, accent colors, fonts, density, English or German and rebindable shortcuts. On Windows 11 the
window can let the desktop show through with Mica or Acrylic, and an opacity slider sets how much the theme covers
it. The settings also cover proxy and certificates for company networks and Git backup.

<p align="center">
  <img src="docs/screenshots/theme-picker.png" width="49%" alt="Theme picker">
  <img src="docs/screenshots/theme-tokyo-night.png" width="49%" alt="Arcalo in the Tokyo Night theme">
</p>
<p align="center">
  <img src="docs/screenshots/settings-backdrop-dark.png" width="49%" alt="Window backdrop Mica or Acrylic with the opacity slider">
  <img src="docs/screenshots/settings-network.png" width="49%" alt="Network and proxy settings">
</p>

## What you get

**Notes**
- Live-preview Markdown editor: headings, lists, task lists, tables, code blocks with syntax highlighting, highlights, links
- `[[Wiki links]]` with autocomplete; clicking a missing page creates it; renames rewrite links everywhere
- Backlinks under every page and in the side panel, outline, tags (`#tag`) with a tag view
- Daily notes (Ctrl Shift D) with previous/next day navigation, optionally from a template; a calendar (Ctrl Shift C, right-click on the ribbon's daily-note button) shows which days have a note and the booked hours per day against the daily target
- Tasks across all notes (Ctrl Shift A): `- [ ] Send offer due:2026-09-30 !!` (also `due:tomorrow`, `by Fri`, `next week`; Obsidian's calendar marker is read too; `!!` = high, `!` = medium), grouped into overdue, today, this week, later and no date, filterable by status and tag, checked off right in the list
- Repeating tasks: `every:daily`, `every:weekly`, `every:mo,we`, `every:monthly` (`every:monthly,31`), `every:3d`, `every:2w`, also in words (`every:jede Woche`, `every:alle 3 Tage`), with `,done` to count from the day it was done and `until:2026-12-31` as the end; Obsidian Tasks' repeat marker is read in imported notes. Ticking one off (task list, start page, editor) adds the next occurrence right below with the next due date (past dates are skipped; holidays are not considered); one undo takes both back. „Wiederholen…“ in the task menu edits the rule
- Bulk actions in Aufgaben: „Auswählen“, Ctrl/Shift+click, Ctrl+A or Shift+arrows select tasks; then done/reopen, due date (today, tomorrow, next week, a date, none), priority, repeat rule, move to another page (with subtasks; `/zeit` bookings move along) or delete, each with one undo; right-click or „…“ opens the same actions for one task
- Images: paste or drop screenshots into a note; they are stored under `attachments/` and embedded as `![[name.png]]`
- Files: drop or paste any file (PDF, Word, Excel, archives, …, up to 100 MB) into a note, or `/Insert file`; it is copied to `attachments/` and embedded as `![[Offer.pdf]]`. Other files show as a chip with type, name and size that opens in its app; PDFs show their first page and open in a built-in viewer (pages, zoom, search, works offline)
- Templates: pages under “Templates” with `{{date}}`, `{{time}}`, `{{title}}`, `{{weekday}}`, `{{week}}` (the German `{{datum}}`, `{{zeit}}`, `{{titel}}`, `{{wochentag}}`, `{{kw}}` work too); `/Insert template` or “New page from template…” in the palette
- Drawings: `/Drawing` opens an Excalidraw whiteboard (shapes, arrows, text, frames, images; works offline). It is stored as `attachments/<name>.excalidraw` with an SVG preview and embedded as `![[name.excalidraw]]`, the Obsidian Excalidraw syntax. Click the preview to edit it
- Layout blocks: `/Toggle` (a foldable callout, Obsidian's `> [!note]- Title`), two and three columns (stacked in narrow panes), `/Table of contents` (live list of the page's headings, `[TOC]`) and `/Footnote` (`[^1]` with hover preview, click to jump, a footnotes list with back-links)
- Smart paste: rows from Excel or Google Sheets become a table, a Teams chat copy a clean list, a stack trace or log a code block, a pasted URL a link with the page's title; “Paste as text” undoes it, Ctrl Shift V always pastes plain text
- Share a page as one self-contained HTML file (page menu → “Share as HTML file…”, optionally with its subpages): images inlined, small attachments embedded, readable in light and dark, loads nothing from the internet
- Editor toolbar above every note (headings, formatting, links, lists, Insert, Tools, AI) and tools: find and replace (Ctrl H), change case, sort lines, remove duplicate lines, move blocks (Alt Up/Down), statistics
- Right-click an image: full view, size, open, show in folder, copy, remove. Right-click a page in the tree: new page beside, from template, duplicate, icon, move, copy link/title/Markdown
- Slash menu (`/`), formatting toolbar on selection, a table toolbar (rows, columns, header) while the cursor is in a table, find in page (Ctrl F)
- Version history: “Versions…” in the page menu lists earlier states (kept 30 days) with a diff against now, and restores them
- Tabs, favorites, a drag-and-drop page tree, a command palette (Ctrl K) and a quick switcher (Ctrl O)
- Links and apps in the ribbon (“Add app / link”): web pages, folders, `mailto:` and programs, each with an icon, and groups of them (one icon with a count; a click lists the entries next to the ribbon, arrows and Enter open them, longer groups filter as you type). Drag a link onto a group to move it in, drag icons to reorder; right-click for edit, move, remove and “Open all links”
- “Import bookmarks” from Chrome, Edge, Brave, Vivaldi, Opera, Arc, Chromium, Firefox and Safari or an HTML export: folders become link groups or Markdown pages, duplicates are skipped, one “Undo” takes it back
- Import an Obsidian vault (folders, frontmatter, links, tags and images kept), export everything back to Markdown files
- English and German side by side: both property names (`activity:` / `vorgang:`, `network:` / `netzplan:`, `properties:`, `view:`), both date words (`due:tomorrow` / `fällig:morgen`) and both block markers (`<!-- columns -->` / `<!-- spalten -->`) are read everywhere. Existing notes are never rewritten; new content uses the language you chose

**Time tracking**
- Type `/time NP-8801/1020 2.5h #DEV System integration` in any note and press Enter. It books the time and leaves a chip in the note. `/zeit` is the same command; relative days work too (`@yesterday`, `@mon`)
- `/time` autocompletes: network/activity (recently booked first, with the remaining plan hours) and, after `#`, the activity type
- Link a note to an activity with the property `activity: NP-8801/1020` (or `network: NP-8801`): the page shows a work card with budget, ETC, the latest bookings and a timer button, and `/time 1.5h Alignment` there books on that activity
- Timer with idle detection (inactive time can be subtracted), quick booking, manual entries
- Weekly timesheet with a grid per network/activity, release workflow, and export to SAP CATS, Jira worklogs, CSV or JSON
- “Propose the week”: a timesheet draft of the week from meetings, unbooked focus sessions and page editing, around what is already booked and capped at the daily target; reviewed by day (source, time, length, text, activity with confidence and reason) and taken over in one go as drafts. An activity you change is remembered per page and meeting series; a reminder on the last workday afternoon points to open days
- Daily review (ribbon, palette, the daily note's review link, the Calendar's day header): one day's pages, hours per WBS against the target with the unbooked gaps, tasks, meetings with their booking state, focus sessions and files; every row leads to its place. “Add to daily note” writes (and on repeat replaces) a compact block in the daily note; “Write summary” runs only on a provider marked local. Optional reminder at the end of the workday
- Projects view: budget, booked hours, remaining effort (ETC), forecast (EAC), critical path and float, as tables
- Budget warnings when a booking pushes a network or activity over its thresholds
- Optional: with Settings → Time tracking → “Use time tracking” off, everything about booking time is gone (timesheet, projects, timer, `/time`, budgets, booking in the Calendar, time widgets, reminders, the assistant's time tools); booked time is kept and comes back when you switch it on

**Calendar**
- Outlook Classic on Windows: reads the calendars you choose of the Outlook that is signed in, through its COM interface (a bundled PowerShell script); no admin rights and no app registration needed. Settings → Calendar → “Choose calendars” lists the default calendar, sub-calendars, further and shared mailboxes, PST files, calendars colleagues shared with you (also free/busy only, shown without subjects), rooms and groups, each with its own color, its sync status and a switch “Use for booking suggestions” (off for calendars shared by others). “Open a person's calendar” adds a colleague's calendar by name or address. A calendar that cannot be opened says why and does not stop the others
- A legend hides or shows calendars in the view (they keep syncing); a meeting in two calendars appears once, from your own calendar, with “Also in: …”
- ICS: subscribe to a published calendar (Outlook on the web/Exchange “Publish calendar”, Google, Nextcloud, …) or add an `.ics` file; series, exceptions and Windows time zones are understood. Subscription addresses are kept in the credential store
- Day, work week, week, month and list with week numbers; meetings as calm tinted blocks in their calendar's color, overlapping meetings side by side, past, running, booked, tentative and free/busy states at a glance; booked time as a lane next to them; daily note, due tasks and booked hours in each day's header
- Join links: Teams (also `teams.cloud.microsoft`), Zoom, Webex, Google Meet, Jitsi, Whereby, Chime, BlueJeans, RingCentral and others, found in the location, the link fields and the description, also behind Microsoft Safe Links, Proofpoint or Google redirects
- “Book time” from a meeting (prefilled, WBS remembered per series or subject), “Meeting note”, “Don't book”; booked meetings get a check mark
- Background sync every 15 minutes (Settings → Calendar); private appointments keep only their time unless you allow more; the assistant does not see your appointments
- Start page widgets “Today” and “Meetings”, and “Book meetings” in the timesheet

**E-mail as a task or note**
- “Take over current e-mail”: the mails selected in Outlook Classic (or the open one) through a second bundled PowerShell script; Exchange senders are resolved to their SMTP address
- `.eml` and `.msg` files dropped anywhere on the window, and pasted Outlook header blocks (From:/Sent:/To:/Subject: or Von:/Gesendet:/An:/Betreff:)
- Task (current page, daily note, another page or the new note; due date with Today/Tomorrow/Fri/Next week; priority from the importance) and/or note below “Emails” with from/to/date/subject, the text as a quote and the chosen attachments; activity and Outlook categories optional
- The link is `[E-mail: Subject (Sender, Date)](annalo-mail://id)`, shown as a chip that opens the mail in Outlook (or the stored `.eml`/`.msg`); the Markdown export writes the text only
- Mail texts stay local: notes are tagged with the privacy marker, and “Suggest task” only uses a provider marked local

**Desktop**
- Tray icon: open, stop the timer or restart the last booking, quick capture, quit; the tooltip shows the running timer (`NP-8801/1020 · 01:23`)
- Startup animation: the logo draws itself while the app loads (Settings → Appearance → Startup animation)
- Developer log: errors of the app, the AI, Git sync, backups and updates are written to `logs/arcalo.log` in the data folder (rotated at 1 MB, secrets redacted) and shown under Settings → Logs (filter, copy, clear, open folder); About shows the errors of the last 7 days
- Taskbar jump list (Windows, right-click the taskbar button): today's note, new page, quick capture, search, stop the running timer or start the last one, and the recently edited pages
- Custom title bar on Windows: the tabs sit at the top edge like in Obsidian, with the app's own window buttons (Settings → Appearance switches back to the system title bar)
- Window backdrop on Windows 11: Mica or Acrylic (off by default) with an opacity slider (40–100 %), applied live and with every theme; Windows 10, macOS and Linux keep a solid window
- Closing hides the window to the tray (Settings → Desktop), start with Windows (minimized), one instance per workspace
- Quick capture (Ctrl Shift Space, global): a small window that appears instantly with the cursor in the field, in the middle of the primary screen. Text goes into today's daily note, the “Inbox” page (each capture with date and time), any page (`>` opens a picker, “New page: Title” or Ctrl Enter creates one) or – while a calendar meeting runs – its meeting note (“Now: …”); Tab switches the target. Several lines with Shift Enter, `todo …` / `- [ ] …` as a task (`by Fri`, `due:tomorrow` set the due date), `[[` and `#` complete links and tags, `/time …` books time. Pasted links get their page title, pasted images and dropped files become attachments. “Saved to …” links to the page; Esc keeps the draft, Ctrl Z takes the last capture back (30 s), the last five are listed. “Capture selection” (second shortcut, off by default) starts it with the marked text (Linux) or the clipboard. Settings → Desktop → Quick capture
- Quick search (Ctrl Shift O, global, or “Search…” in the tray): a small window above all programs, on the primary screen, that finds pages, passages and bookings, opens today's daily note, creates a page, starts/stops the timer or books `/time …`; Enter opens the result in the main window
- Start page: boards of widgets as tabs (“Today” and “Projects” to start with), arranged with the mouse or the keyboard, templates, export and import, and your own “Query” widgets
- End-of-day reminder on workdays when less than the daily target is booked (default 17:30), and once when a timer is still running after 20:00

**Assistant**
- Streams answers from your AI providers; knows the open page and searches notes and time logs (keyword + semantic)
- Model routing: local, standard and reasoning models; `#privat` content always stays on the local model
- Can book time, search and check budgets; system tools (PowerShell, git, HTTP) only run after you approve them
- “Write weekly report” (Ctrl K) drafts this week's status e-mail from your bookings and done tasks; “Insert into new page” saves it as “Weekly report, week nn”
- Inline AI: select text and press Ctrl J (or “AI” in the formatting toolbar, `/Edit with AI` for the current block): Improve, Shorten, Translate DE↔EN, Bullet points, As a table, … or your own instruction; the result streams into a preview and replaces the text (one Ctrl Z undoes it) or goes below it
- “Summarize the meeting” (page menu, `/Summary`): summary, decisions, tasks (`- [ ] … @Person due:…`) and open points, inserted at the end of the page or saved as a new page; on a page with `activity:` and a time span (`10:00–11:30`) it adds a `/time` booking suggestion
- Answers cite their sources as numbered chips `[1]`: hovering shows the cited passage, clicking opens the page, scrolls to the paragraph and briefly highlights it (the source chips under the answer do the same)
- Smart `/time`: `/time 2h worked on the interface mapping` on a page without `activity:` asks the AI for the activity and shows “Book on NP-8801/1020 · System integration (DEV)?” with the reason – Enter books, Tab picks another reference, Esc cancels (also in quick capture). Nothing is booked without confirmation
- Suggestions from what is going on (the open page, due tasks, gaps in the week's bookings, budget warnings), follow-ups under every answer, and a right-click menu: copy, append the answer to the open page, save as page, regenerate, edit a question
- Shows sources, time to first token, tokens/s, tokens and cost per answer and per session
- Chat history: every chat is saved as it goes (a stopped answer with what arrived) and titled from its first question. The history button in the panel's header (or “Search chat history” in Ctrl K) lists chats by today, yesterday, last 7 days and older with their model and date, pinned ones on top; it searches titles and messages, and pins, renames (F2), duplicates, saves as a page or deletes them (Del, with “Undo”). An old chat opens as it was, with sources, tool steps and costs, and goes on with the whole conversation; the panel says when the model changed. Closing the side panel keeps a running answer
- Private chats: a chat that touched `#privat` content (or ran with “Local model only”) is marked with a lock and stays on the local model when continued, also for questions without the marker; a page saved from it carries the marker. Chats live only in the local database and are part of every backup. Settings → Privacy → “Keep chats” keeps them all, 90 or 30 days (pinned ones stay) or does not save them, and “Delete all chats” removes them
- Answers fit the panel at any width: long links, words and paths wrap, code blocks scroll in their own box with the language and a copy button, tables scroll sideways. Each answer has copy, insert into the open page, save as page and regenerate; the last question can be edited and sent again. The composer grows with the text (Enter sends, Shift Enter breaks the line, Esc stops), with chips for the page context and the model

## First steps

<img src="docs/screenshots/first-run-intro.png" width="42%" align="right" alt="The intro on first start: the scene about time tracking">

1. **Install and start.** A short intro shows what Arcalo does, then the setup asks for language, theme, working time
   (and whether you book time in SAP), workspace, AI (none, a local Ollama found automatically, or your company's
   server with a connection test), calendar, Git sync, backups and desktop. Every answer is saved at once, every step
   can be skipped and changed later under Settings. Settings → About has “Replay the introduction” (also in the
   command palette) and “Reset setup”, which only forgets that the intro was seen, never your notes
2. **Look around the demo workspace.** Press **Ctrl K** for the command palette, **Ctrl O** to jump to a page and
   **Ctrl Shift D** for today's daily note
3. **Coming from Obsidian?** Use “Import Obsidian vault” in the command palette. Folders, frontmatter, links,
   tags and images are kept
4. **Book your first time.** Type `/time` in a note, or start the timer with **Ctrl Shift T**
5. **Behind a company proxy?** Settings → Network, see [below](#network-and-proxy)

<br clear="right">

<p align="center"><img src="docs/screenshots/first-run-setup-dark.png" width="70%" alt="Setup step “How do you work?”: book time or just notes, workdays, daily target and rounding"></p>

## Connecting AI providers

Settings → **AI & models** → **AI providers**. Any number of providers, in order of preference:

| Kind | Address | Key |
|---|---|---|
| **LiteLLM** | the proxy root, e.g. `https://llm.your-company.com` | virtual key or master key (bearer) |
| **OpenAI-compatible** | the base URL with version: OpenAI `https://api.openai.com/v1`, Mistral `https://api.mistral.ai/v1`, Groq `https://api.groq.com/openai/v1`, OpenRouter `https://openrouter.ai/api/v1`, LM Studio `http://localhost:1234/v1`, vLLM, llama.cpp … | bearer, optional on localhost |
| **Azure OpenAI** | the resource endpoint, e.g. `https://company.openai.azure.com`; plus the **API version** (default `2024-10-21`) and the **Deployments** (the model names are the deployment names). Requests go to `/openai/deployments/<deployment>/chat/completions?api-version=…` with an `api-key` header | `api-key` |
| **Ollama** | `http://localhost:11434` (found automatically when it runs) | none |

- Keys are stored per provider in the Windows Credential Manager or the macOS Keychain, never in the database, the settings or their export
- **Local provider** marks a provider that runs on this machine or in your own network: it may receive private content and costs nothing.
  **Bypass proxy** connects directly (default for addresses on localhost)
- **Test connection** in the provider dialog checks reachability, the key, a short chat, tool support and embeddings, each with its own result.
  For Ollama, **Download model** pulls a model (`/api/pull`) with progress
- **Models**: each tier (*Local / fast*, *Standard*, *Reasoning*) and the embeddings pick a provider and a model from its list;
  the embedding picker offers only embedding models (LiteLLM: `mode: embedding`, otherwise recognized by name) and
  “None (keyword search only)”
- **Prices**: an editable table (per 1M input/output tokens) for providers that do not report costs; LiteLLM reports its own, local providers are free

Settings of earlier versions become one LiteLLM provider with the same address, models and token. Changes apply immediately.
A tier whose model its provider does not offer is flagged with “Assign automatically”; requests fall back to another configured
model, a short LiteLLM cooldown (“Try again in 5 seconds”) is waited out on the same model (shown in the assistant, Stop ends
it), a model whose deployments stay unavailable or whose backend fails is retried on another one (a smaller local fallback is
said in the answer), and an unreachable provider hands over to the next. `#privat` content and Settings → Privacy “Local model
only” only ever go to the local tier's model or to providers marked local, never to a cloud fallback; semantic search does not
send private pages to an embedding model that is not local.
`config/litellm.config.example.yaml` shows a matching LiteLLM configuration.

## Network and proxy

Settings → **Network** applies to every outgoing connection: the AI providers, the assistant's HTTP tool, the Git
sync and the updater (each can be excluded under “Apply to”).

- **Proxy mode**: *No proxy*, *System* (Windows: the WinINet settings of the current user, including the exception
  list and `<local>`; elsewhere `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`), *Manual* (HTTP, HTTPS and SOCKS
  proxy as `host:port` or URL) or *PAC*
- **Bypass the proxy for**: `host` (and its subdomains), `*.domain` / `.domain` (subdomains only), IPs, CIDR ranges
  (`10.0.0.0/8`), `<local>` (names without a dot) and `*`
- **Proxy login**: user name in the settings, password in the Windows Credential Manager / macOS Keychain (Basic auth)
- **Additional root certificate**: a PEM (also bundles) or DER file of a company root CA, e.g. for TLS-inspecting
  proxies; the page shows the number of certificates, the first subject and its expiry. “Accept invalid
  certificates” exists for troubleshooting only and shows a warning while it is on
- **Test connection** requests the AI server's model list with the entered (also unsaved) values and shows whether the
  request went direct or through which proxy, and how long it took

PAC files are JavaScript. The core does not embed a JS engine: the UI evaluates `FindProxyForURL` in a sandboxed frame
(own `annalo-pac:` scheme, opaque origin, no access to the app) for the AI server, GitHub (updates) and the Git
remote when the settings are saved or tested and at every start, and stores the answers. Limitations: no DNS
(`isInNet` only matches IP addresses, `dnsResolve` only returns IP literals, `myIpAddress()` is `127.0.0.1`), and
other hosts (the assistant's HTTP tool) use the answer for the AI server. Git receives the proxy through
`http_proxy`/`https_proxy`/`no_proxy` and the CA through `http.sslCAInfo` (extra CA plus the system bundle); Git for
Windows verifies with the Windows certificate store (schannel), so install the root CA there.

## Customizing

Settings are grouped (General, Work, AI, System) and searchable. Besides the connections they cover:

| Section | What |
|---|---|
| Appearance | light/dark, 20 color themes and your own, accent color (presets or any hex; lightness is adjusted for WCAG contrast in both modes), UI/editor/code fonts, scale 90–125 %, density, line width, reduced motion, startup animation, window backdrop Mica or Acrylic with an opacity slider (Windows 11), custom title bar with the tabs at the top edge (Windows, like Obsidian; the system title bar is one switch away) |
| Language & format | English or German for the whole app, live: menus, tray, messages, notifications and what Arcalo writes into new notes; date format |
| Startup | open the last tabs, the start page or today's note; remember window size and position; start minimized; import bookmarks |
| Keyboard | rebind every in-app shortcut, with conflict detection (commands, editor keys, global shortcuts); Ctrl+Alt is rejected (AltGr) |
| Editor | spell check language, autosave delay, typographic quotes, closing brackets, Tab width and line numbers in code blocks, link hover preview, scroll outline, icon and location of new pages |
| Notes | daily note title (`2026-09-24`, `24.09.2026`, `Thursday, 24.09.2026`) and folder, trash retention, version interval and count |
| Time tracking | use time tracking at all, week start, rounding (1/5/6/10/15 min, up or nearest) and minimum for bookings and timer stops, hours as `1,50` or `1:30`, default activity type per network, CATS separator and column order, export file name |
| Calendar | Outlook calendars (choose, color, booking suggestions), ICS subscriptions and files, sync interval, privacy of appointments |
| AI & models | providers, model tiers, embeddings, prices, temperature, answer length, streaming, citations, allowed tools (system tools off by default), monthly cost limit (warning at 80 %, blocked at 100 % unless sent anyway), inline AI actions, meeting summary template |
| Privacy | private tags, whether the assistant sees the open page, local model only, how long chats are kept, “Delete all chats” |
| Notifications | each reminder and notice on/off, quiet hours for desktop notifications |
| Manage | export all settings to JSON (never tokens or passwords), import with a preview of the changes, reset one section or everything |
| About | version and updates, data folder (“Change location”), “Replay the introduction”, “Reset setup” |

## Building

Prerequisites: Rust (the version in `rust-toolchain.toml` is picked automatically; MSVC on Windows), Node 22, on Windows the
WebView2 runtime (preinstalled on Windows 11), on Linux the WebKitGTK 4.1 development packages
(`libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev`).

```sh
npm ci --prefix ui
cargo install tauri-cli --version "^2"
cd src-tauri
cargo tauri dev      # run with hot reload
cargo tauri build    # installer/packages in target/release/bundle (NSIS on Windows, deb/AppImage on Linux)
```

Data lives in `%APPDATA%\app.annalo.desktop\` (`workspace.db`); Settings → About → “Change location” moves it
(avoid OneDrive/Dropbox and network folders for the database; backups there are fine). The first start offers a small
demo workspace. The database is backed up daily into `backups` there (or a folder chosen under Settings → Backup), and
deleted pages stay in the trash for 30 days. Each backup also refreshes a read-only Markdown copy of all pages (with
images) and the bookings as `Zeiterfassung/YYYY-MM.csv` (Excel-ready) in `backups/markdown` (configurable under
Settings → Backup).

## macOS

Releases contain `Arcalo_<version>_aarch64.dmg` (Apple Silicon) and `Arcalo_<version>_x64.dmg` (Intel), macOS 11
or newer. Open the disk image and drag **Arcalo** into *Applications*.

The app is **ad-hoc signed but not notarized**, so Gatekeeper blocks the first start (“cannot be opened because the
developer cannot be verified” or “is damaged”). Once, either:

- in Finder, right-click (Ctrl-click) *Arcalo* in *Applications* → **Open** → **Open**
  (on macOS 15: System Settings → Privacy & Security → “Open Anyway”), or
- in the Terminal: `xattr -cr "/Applications/Arcalo.app"`

On macOS the app follows the platform conventions: a menu bar in the app's language (⌘, settings, ⌘\ sidebar, ⌘.
focus mode), the tab bar sits in the title bar, and every in-app shortcut uses ⌘ instead of Ctrl. Closing the window
(the red button or ⇧⌘W) saves your edits and keeps Arcalo running in the Dock with its timers and reminders; a click on
the Dock icon brings the window back, ⌘Q quits cleanly, ⌘W closes the current tab. Quick capture defaults to ⌘⇧Space;
quick capture and quick search appear on the current Space, also over a full-screen app, and hand the focus back
when they close. “Open at login” adds a LaunchAgent. API keys and the Git token are kept in the login keychain; idle
detection uses CoreGraphics (no permission needed), usage statistics record the frontmost app's name.

Build locally on a Mac (Xcode command line tools, Rust, Node 22): `cd src-tauri && cargo tauri build --bundles app,dmg`.

**Developer ID signing and notarization (optional).** With an Apple Developer account the release workflow signs and
notarizes automatically once these repository secrets exist (without them it stays ad-hoc signed):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the “Developer ID Application” certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | the certificate name, e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | the Apple ID e-mail (for notarization) |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID (appleid.apple.com → Sign-In and Security) |
| `APPLE_TEAM_ID` | the 10-character team ID (developer.apple.com → Membership) |

The first three sign the app; with all six it is also notarized and stapled, and the `xattr` step is no longer needed.

## Setting up automatic updates

The app updates itself from GitHub releases: at start, every 6 hours (Settings → About → “Check for updates
automatically”) and via “Check for updates now” it reads
`https://github.com/MouseWerk/Arcalo/releases/latest/download/latest.json`. A newer version shows a toast
“Version X available” with “Install and restart” and the release notes (“What's new?”); nothing is installed
without that click. Before installing, all open editors are saved and a running backup is finished; the signed NSIS
installer then runs passively and restarts the app (on macOS the signed `.app.tar.gz` replaces the app bundle, on
Linux the signed AppImage replaces itself, then it restarts). The `.deb` shows the same message with “Open release
page” instead, and the portable ZIP is updated by hand. If an update cannot be installed (offline, a proxy that does
not answer, a signature that does not match, a full disk, an installer blocked by policy), Arcalo says so in plain
words and keeps your workspace open.

Updates must be signed. The public key is committed (`src-tauri/updater.pub`) and compiled into release builds;
the updater is **only active in builds made by the release workflow with the signing secrets**. Local and CI builds show
“Automatic updates are not set up in this build” and never contact the update server. One-time setup on
GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full content of the private key file (`annalo-updater.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Then every tag `vX.Y.Z` produces a signed installer (Windows), signed update archives (macOS), a signed AppImage
(Linux) and `latest.json` (`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`, `linux-x86_64`). To rotate the key,
generate a new pair with `cargo tauri signer generate -w annalo-updater.key`, replace `src-tauri/updater.pub` and both
secrets; apps installed with the old key must be updated once by hand.

## Your data is safe

- **Local first.** Everything is in one SQLite database (`workspace.db`) in your user profile. Nothing leaves the
  computer unless you set it up
- **Daily backups** of the database and the attachments into `backups` (folder configurable), with a readable **Markdown copy** of all
  pages, images and bookings (`Zeiterfassung/YYYY-MM.csv`, Excel-ready)
- **Network and cloud destinations**: Settings → Backup → “Additional backup destinations” copies every backup in the
  background to further folders, such as `\\server\share\Arcalo`, a mapped drive, `/Volumes/NAS` or a OneDrive or
  Nextcloud folder, each computer into its own subfolder with a SHA-256 checksum. Copies are written under a temporary
  name and renamed when complete, so a synced cloud folder never uploads half a file. “Test now” checks a destination.
  A share that is offline or hangs never holds up the app; Arcalo retries quietly and only warns after a day. Backups
  from the destinations can be restored from the same page (“Restore…”), and the start-up recovery finds them too.
  Arcalo never stores share passwords
- **Trash** keeps deleted pages for 30 days. **Version history** keeps earlier states of every page, with a diff
- **Git sync** pushes the Markdown copy to your own private repository (see below)
- **Secrets** (AI provider keys, Git token, proxy password, calendar subscription addresses) are stored in the Windows Credential Manager or the macOS
  Keychain, on Linux in the Secret Service (GNOME Keyring, KWallet; without one in `secrets.json` in the data folder,
  readable only by your user, as Settings → Privacy shows). They are never written to the
  database, settings exports, backups or logs
- **Chats** with the assistant stay in the local database and follow Settings → Privacy → “Keep chats”
- **Export** everything back to plain Markdown files at any time

## Git sync

Settings → **Backup** → “Git sync” pushes the Markdown copy (pages, images, `Zeiterfassung/*.csv`) to a Git
repository, for example on GitHub, GitLab or Azure DevOps. It needs Git installed ([git-scm.com](https://git-scm.com)).

<p align="center"><img src="docs/screenshots/settings-git-sync.png" width="70%" alt="Git sync settings"></p>

1. Create an empty private repository and enter its **Remote URL** (and the branch, default `main`)
2. HTTPS: create a personal access token with write access to the repository and save it under **Access token**. It is
   stored in the Windows Credential Manager and sent to Git only through environment variables, never on the command
   line, in `.git/config` or in any log. SSH URLs (`git@github.com:…`) use your system's SSH keys and agent instead
3. **Test connection** runs `git ls-remote`; **Sync now** syncs immediately
4. Choose when to sync: **With every backup** (daily and “Back up now”) or **Hourly**

Every sync commits only when something changed. The working copy lives in `git-sync` in the data folder. Optionally
the latest database backup is committed as `annalo-workspace.db` (“Include the database”; this grows the repository
quickly, and GitHub rejects files over 100 MB). If the branch on the server contains a different history (for example
another computer's or an unrelated project), nothing there is overwritten: the commit goes to the branch
`annalo-sync-<computer name>` and the settings say so. A new computer with the same remote continues the existing
history. Failures appear as a notification and in the status line.

**Several computers**: notes another computer pushed are taken over into your workspace with the next sync (earlier
states stay in the version history). A note changed on both computers is not overwritten: both versions are kept, the
page shows “Conflict”, and merging opens a view with both versions side by side, paragraph by paragraph. Changes made
on one side only are merged automatically; for the rest you pick “Mine”, “Theirs”, “Both” or write the text yourself.
“Apply” saves the result and syncs it.

**Restore**: “Restore from Git…” clones the repository and imports it as a new top-level page “Git import <date>”
(images included); existing pages are left alone.

## Tests

```sh
cargo test -p annalo-core      # core: parser, CPM, budgets, exports, FTS, RAG, notes, vault, settings
e2e/run.sh                     # end-to-end: drives the real desktop app via WebDriver (Linux, Xvfb)
```

The end-to-end suite starts the actual app binary under `tauri-driver`, with a fresh data directory per test file,
and a fake LiteLLM server for the assistant tests. The harness runs the app in German (`ANNALO_LOCALE=de-DE`, which
stands in for the system language; tests 81–83 check the English UI) and sets `ANNALO_SKIP_ONBOARDING=1` (honored by
debug builds only) so the first-run intro stays away; `launch({ onboarding: true })` lets it run (tests 88–90). It
also saves screenshots of every screen (dark and light) to `e2e/screenshots/`. The apps of a test file share a D-Bus
session bus of their own with no services on it (no keyring, desktop portal or notification service, whatever the
machine runs), and `xdg-open` only records what the app would open (`app.opened()`), so no browser or file manager
starts. A start that takes more than 10 s prints the app's start-up timing (`ANNALO_STARTUP_TIMING=1`, debug builds).

The README screenshots come from `e2e/readme-shots-16.test.js`: the app in English with English sample content (a
week of meetings in three Outlook calendars, bookings, focus sessions, chats and browser bookmarks from fixtures),
in light and dark. Run it after building the app with `ANNALO_SHOTS=<folder>` and `ANNALO_APP=<binary>`;
`ANNALO_SCENES=calendar,dashboard,…` takes only some scenes. `e2e/readme-shots.test.js` and
`e2e/readme-shots-15.test.js` are the German sets of earlier releases.

## Repository layout

| Path | Contents |
|---|---|
| `crates/annalo-core` | Rust core: SQLite + FTS5 store, documents/links/tags, `/time` parser, time tracking, budgets, CPM, exports, idle detection (Win32), AI clients, router, RAG, tools, calendars, backups, vault import/export |
| `crates/annalo-cli` | `annalo` command line on the same database |
| `src-tauri` | Tauri v2 desktop shell: IPC commands, credential storage, global shortcuts, tray, quick capture, reminders, activity sampler, updater |
| `ui` | React + TypeScript + TipTap frontend (Vite), Lucide icons; the English and German texts in `ui/src/locales` |
| `e2e` | WebdriverIO end-to-end tests against the desktop app |
| `docs/ARCHITECTURE.md` | Design notes |

## Keyboard

All in-app shortcuts can be changed under Settings → Keyboard (the defaults are listed here). On macOS use ⌘ where the table says Ctrl (the app shows ⌘⇧⌥⌃ glyphs there); Ctrl Tab stays Ctrl Tab.

| Keys | Action |
|---|---|
| Ctrl K / Alt Space (global, configurable) | Command palette, search, `/time …`, `? question` |
| Ctrl Shift Space (global) | Quick capture (Tab: target, `>`: page, Ctrl Z: undo the last capture) |
| Ctrl Shift O (global, configurable) | Quick search window |
| Ctrl O | Quick switcher |
| Ctrl N | New page |
| Ctrl Shift D | Today's daily note |
| Ctrl Shift C | Calendar of daily notes |
| Ctrl Shift E | Calendar (meetings and booked time); inside it ← → move, T today, D/A/W/M/L change the view (day, work week, week, month, list) |
| Ctrl Shift A | Tasks |
| Ctrl Shift T | Start/stop timer |
| Ctrl J | Assistant; with text selected in a note: inline AI |
| Ctrl F | Find in page |
| Ctrl W / Ctrl Tab | Close / switch tab |
| Ctrl \ / Ctrl Shift \ | Toggle sidebar / side panel |
| Ctrl . | Focus mode |
| Ctrl , | Settings |

## Releasing

Push an annotated tag. The tag message becomes the release notes, and the tag sets the version:

```sh
git tag -a v1.1.0 -m "What's new …" && git push origin v1.1.0
```

Or, without a local tag: write the notes to `docs/releases/v1.1.0.md`, then GitHub → **Actions → Release → Run
workflow** with the version `1.1.0`. The workflow creates the annotated tag itself.

The [Release workflow](.github/workflows/release.yml) builds Windows, Linux and both macOS variants, signs the update
files and publishes everything together with `latest.json` on the Releases page.
