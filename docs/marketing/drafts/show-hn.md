# Show HN: draft

Status: drafted. Who acts: the owner, from his own Hacker News account, posted by hand. Owner approval needed.

## Rules that apply (read 2026-10-27, https://news.ycombinator.com/showhn.html)

- Show HN is for something you made that people can try. Arcalo qualifies: free download, no sign-up.
- The poster must have built it and be around to answer comments. Plan two to three hours after posting.
- A routine version release is not a Show HN. This is Arcalo's first Show HN (no earlier HN post for "Arcalo",
  "Annalo" or the repo URL in the HN search on 2026-10-27), so the post is about the app, not about 1.22.
- Do not ask anyone to upvote or comment, not even friends or colleagues, and do not share the HN link with
  such a request. Do not repost the same link if it does not take off; HN allows one more try after some time
  only if the post got no attention, and moderators can be asked by e-mail (hn@ycombinator.com).
- Title: no superlatives, no exclamation marks, no "the best". Plain description.

## Timing

A Tuesday to Thursday, 8:00 to 9:30 US Eastern (14:00 to 15:30 in Germany after 1 November 2026, when both are
on winter time). Proposed: Tuesday 3 November 2026, 8:30 ET / 14:30 CET. Not on the day of a big tech event.

## Link

https://github.com/MouseWerk/Arcalo

(The repository rather than the website: HN readers want the code, the README has the screenshots and the
download table.)

## Title (80 characters max)

```
Show HN: Arcalo – local-first notes, tasks and time tracking in Rust and Tauri
```

(78 characters. The longer variant with "meetings" is 83 characters and does not fit.)

## Text field

Leave the text field empty when the URL is given (HN shows the URL; the explanation goes in the first comment).

## First comment (post right after submitting)

```
Hi HN, I'm Maurice. [Owner: one true sentence about your work, e.g. the kind of SAP/Jira projects.] My week
used to be spread over four tools: notes in one app, tasks in another, Outlook for meetings, and a spreadsheet for the hours that end up
in SAP CATS on Friday afternoon. Arcalo is the desktop app I built to keep all of that in one place, on my
own computer.

What it does:

- Markdown notes with [[links]], backlinks, tags, tables, callouts, Mermaid, drawings and a canvas. An
  Obsidian vault (including .canvas files) imports as it is, and everything exports back to plain Markdown.
- Tasks that live in notes (due dates, repeat rules) and a projects view with budget, ETC/EAC and the
  critical path.
- Meetings from Outlook Classic (via COM, no admin rights or app registration) and any ICS calendar. On
  Windows with Outlook Classic you can also create and change your own appointments in Arcalo and they are
  written back to Outlook; that is off until you switch it on.
- Time booking while you write: "/time NP-8801/1020 2.5h #DEV Integration" in any note books the time. The
  week exports to an SAP CATS upload file, Jira worklogs, CSV or JSON. "Propose the week" drafts a timesheet
  from meetings, focus sessions and the pages you edited, and you confirm it.
- New in 1.22: Jira issues open in a window inside the app with description, fields, subtasks, links,
  attachments, comments, work log and history, and you can edit what Jira lets you edit, with undo and a
  conflict check.
- An optional assistant on the AI providers you add yourself: Ollama, LiteLLM, any OpenAI-compatible
  endpoint or Azure OpenAI. Notes tagged #privat only ever go to a model you marked as local. With "Use AI"
  off nothing is sent to any AI service. Voice notes are transcribed locally with whisper.cpp.

What it does not do: there is no account, no server of mine, no telemetry. Data is one SQLite database
(optionally encrypted with SQLCipher) plus a Markdown mirror for backups and an optional Git sync to your
own repository. Network traffic is only what you configure: AI providers, calendars, Git, and update checks
against GitHub releases.

Stack: a Rust workspace (a core crate with all logic and tests, a thin Tauri 2 shell, a CLI) and a React +
TipTap UI. Every outgoing HTTP client is built through one function so the proxy, PAC and company root CA
settings apply everywhere, and a test fails if code builds a client another way. PAC scripts run in a
sandboxed iframe on their own scheme, so the app's CSP stays without unsafe-eval. The e2e suite drives the
real app with WebdriverIO and tauri-driver.

Honest caveats: the macOS builds are not notarized (there is a one-time Gatekeeper step in the README), and
the Windows installer is not code-signed, so SmartScreen may warn. The UI is English and German. Outlook
write-back needs Outlook Classic on Windows; on macOS and Linux the calendar reads ICS only.

It's MIT licensed. Installers for Windows, macOS and Linux are on the releases page. I'd especially like to
hear from people who book time into SAP or Jira, and from anyone who has opinions about the Obsidian import.
```

## Answers to prepare (likely questions)

- "Why not an Obsidian plugin?" Time booking, the CATS export, the Outlook bridge and the Jira window need a
  database, background sync and OS integration that do not fit well in a plugin; the notes stay
  Obsidian-compatible Markdown.
- "Why SQLite and not files?" One transactional store for pages, versions, bookings, the calendar cache and
  search (FTS5 and embeddings); the Markdown mirror and the export keep the data readable outside the app.
- "Is it vibe-coded / AI-written?" Answer truthfully, in your own words, how the app was built and tested.
- "Business model?" It's free and MIT; say plainly what you plan (or that you have no plans).
- "Signing?" No paid certificate. The Microsoft Store build (signed by the Store) is the signed Windows path;
  name it only once the Store listing is public. winget: say "submitted" only after the PR is open.

## Screenshots

None can be attached on HN. Make sure the README's first image (`docs/screenshots/split-view.png`) loads fast;
it does on GitHub.
