# Newsletters and showcases

Who acts: the owner. Owner approval needed.

## Changelog News

Status: drafted. Checked 2026-10-27 (https://changelog.com/news/submit): sign in, then a form with URL, title
and "What's interesting about it?" (Markdown). Own work may be submitted. Not wanted: how-tos and tutorials,
commercial products, reader-hostile sites. Arcalo is free and open source, so it fits if the text says what is
newsworthy.

- When: after the Show HN (from 4 November 2026).
- URL: https://github.com/MouseWerk/Arcalo
- Title:

```
Arcalo: a local-first desktop app for notes, tasks, meetings and time tracking
```

- What's interesting about it:

```
Arcalo is an MIT-licensed desktop app (Rust core, Tauri 2 shell, React UI) that puts Markdown notes, tasks,
Outlook/ICS meetings and time tracking into one local SQLite database, with no account and no telemetry. It
books time from a line in a note and exports SAP CATS upload files and Jira worklogs. A few engineering choices may interest developers: every HTTP client goes through one
function that a test enforces, PAC proxy scripts run in a sandboxed iframe so the CSP stays without
unsafe-eval, and Outlook is read through COM via a bundled PowerShell script, so no Azure app registration is
needed. 1.22 adds an in-app Jira issue view with editing, undo and conflict detection.
```

## This Week in Rust

Status: checked. Project announcements are no longer accepted by pull request; articles go to "Observations/
Thoughts" or "Rust Walkthroughs" via a PR to the current draft in rust-lang/this-week-in-rust. LLM-written
articles are not accepted. Next step: only if the owner rewrites the dev.to article himself, submit that link
under "Observations/Thoughts" (one line: `[Building a local-first workday app with Rust and Tauri](<dev.to
URL>)`).

## Console.dev

Status: `rejected`. Console features tools whose primary user is a developer; Arcalo's users are consultants
and knowledge workers.

## Tauri showcase

Status: checked. tauri.app has no app showcase page, and awesome-tauri no longer accepts applications (see
`awesome-lists.md`). The Tauri Discord (https://discord.com/invite/tauri) may have a showcase channel; the owner
checks its channel rules after joining and posts there once, only if the channel exists and allows it:

```
Arcalo, a local-first desktop app for notes, tasks, meetings and time tracking, built on Tauri 2 (Rust core,
React + TipTap UI). Windows, macOS and Linux, MIT. Some Tauri-specific bits: a custom URI scheme with its own
CSP for sandboxed PAC evaluation, tauri-driver e2e tests over 200 files, and the updater with signed AppImage,
NSIS and app bundles. https://github.com/MouseWerk/Arcalo
```
