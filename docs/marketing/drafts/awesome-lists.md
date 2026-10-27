# Awesome lists: entry lines

Status: drafted. Who acts: the owner opens each pull request from his own GitHub account (one entry per PR,
following each list's rules). Owner approval needed per PR. Nothing here has been opened.

Arcalo facts the lists ask for (2026-10-27): MIT, Tauri 2 with a Rust core and a React/TypeScript UI, Windows,
macOS and Linux, repository created 2026-09-23 (the app is older; it was called Annalo until 1.6), 1 star,
about 180 installer downloads over the listed releases. Data is stored in a SQLite database (with a Markdown
mirror), not as plain Markdown files.

## Accepted candidates

### tehtbl/awesome-note-taking

- Rules (contributing.md, read 2026-10-27): format
  `- [icons] [Tool Name](URL) - Brief description ending with a period. `LICENSE` `Tech/Language``; pick one
  category; icons must be accurate; actively maintained (commit within 12 months). Sections are alphabetical.
- Category: **Open Source → Tauri**, first in the section (before "Char").
- Icon: the list's "database" icon (U+1F4D5, a closed red book), because Arcalo stores notes in SQLite. Not the
  sync icon (Git sync pushes a Markdown copy, it is not multi-device sync) and not the E2E icon (encryption is
  at rest, not end-to-end). Type the icon character where `{U+1F4D5}` stands; this repository keeps no emoji
  characters in its files.

```
- {U+1F4D5} [Arcalo](https://github.com/MouseWerk/Arcalo) - Local-first desktop app for linked Markdown notes, tasks, meetings and time tracking, with Obsidian vault import and optional AI on your own providers. `MIT` `Tauri/Rust+TypeScript`
```

PR title: `Add Arcalo to Tauri`

### brettkromkamp/awesome-knowledge-management

- Rules (CONTRIBUTING.md): first-hand experience, not a duplicate, format `- [Name](link) - Description`, add at
  the bottom of the category, useful PR title, commit body with a link to the repository.
- Category: **Platforms, Applications and Tools**, at the bottom.

```
- [Arcalo](https://github.com/MouseWerk/Arcalo) - A local-first desktop app that keeps linked Markdown notes, tasks, meetings and working hours together, imports Obsidian vaults and needs no account. MIT.
```

PR title: `Add Arcalo to Platforms, Applications and Tools`. Commit body: `https://github.com/MouseWerk/Arcalo`.

### mundimark/awesome-markdown-editors

- Rules (README, 2026 policy): new entries go to `UPCOMING.md` ("What's New in 2026?") first, in the best
  matching category. Format as the neighbouring entries.
- Category: `UPCOMING.md` → **Markdown Desktop Editors → Universal**, alphabetical (after "Binderus").

```
**Arcalo**
(web: [`arcalo.mousewerk.de`](https://arcalo.mousewerk.de/), open source @ github [`MouseWerk/Arcalo`](https://github.com/MouseWerk/Arcalo)) -
Local-first desktop app with a live-preview Markdown editor: `[[wiki links]]` with backlinks, tables, callouts, Mermaid, footnotes, Excalidraw drawings and a canvas, plus tasks, meetings and time tracking in the same app. Imports an Obsidian vault and exports everything back to Markdown files. No account, no telemetry. Built with Tauri 2 (Rust + React), MIT licensed, works on Windows, macOS and Linux.
```

PR title: `Add Arcalo (UPCOMING, Desktop/Universal)`

### pluja/awesome-privacy

- Rules (misc/Contributing.md): clear own-your-data policy; no user tracking on the project website (checked
  2026-10-27: arcalo.mousewerk.de loads no third-party scripts or analytics); open source preferred. Format
  `- [Service Name](link) - Little description`, one sentence that says what it does and what it replaces, with
  license and platform where it applies. Section entries are alphabetical.
- Section: **Notes and Tasks → Instead use**, after "AppFlowy".

```
- [Arcalo](https://github.com/MouseWerk/Arcalo) - Local-first desktop app for notes, tasks, meetings and time tracking that replaces Notion or OneNote for work notes, with no account, no telemetry and optional database encryption. MIT, Windows, macOS and Linux.
```

PR title: `Add Arcalo to Notes and Tasks`. Expect questions about the young project; answer them, do not argue.

### ever-co/awesome-time-tracking (low priority)

- The list is generated and maintained with the Ever Works directory platform and says it may contain
  AI-generated content; there is no CONTRIBUTING file and no stated submission route. Open one issue asking
  whether suggestions are welcome before sending anything.
- Section: **desktop-time-tracking-applications**, format as the neighbouring entries:

```
- [Arcalo](https://github.com/MouseWerk/Arcalo) - Local-first desktop app that books time from notes with /time and exports the weekly timesheet to SAP CATS, Jira worklogs, CSV or JSON, next to notes, tasks and meetings. `Open Source` `Desktop` `Timesheet` `Cross Platform`
```

(The list's entries also link a generated `([Read more](/details/...))` page; leave that out, the maintainers'
tooling adds it.)

## Rejected or not yet eligible

| List | Reason |
| --- | --- |
| [tauri-apps/awesome-tauri](https://github.com/tauri-apps/awesome-tauri) | `rejected`: its contributing guide says "Application submissions are not accepted anymore". |
| [rust-unofficial/awesome-rust](https://github.com/rust-unofficial/awesome-rust) | `rejected` for now: entries need more than 50 GitHub stars or 2,000 crates.io downloads (Arcalo: 1 star, not on crates.io). Revisit at 50 stars; entry then under Applications → Productivity: `[MouseWerk/Arcalo](https://github.com/MouseWerk/Arcalo) - Local-first desktop app for linked notes, tasks, meetings and time tracking with SAP CATS and Jira export [![CI](https://github.com/MouseWerk/Arcalo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MouseWerk/Arcalo/actions/workflows/ci.yml)` |
| [alexanderop/awesome-local-first](https://github.com/alexanderop/awesome-local-first) | `rejected`: "Contributions are closed. This repository no longer accepts pull requests or project submissions." |
| awesome-selfhosted | `rejected`: lists software you host on a server; Arcalo is a desktop app. |
| An "awesome Obsidian alternatives" list | none found that is maintained; tehtbl/awesome-note-taking covers that audience. |
