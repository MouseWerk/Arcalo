# Reddit: drafts

Who acts: the owner, from his own Reddit account, posted by hand. Owner approval needed for every post. No
second account, no asking others to upvote, no cross-posting the same text to several subs on one day, and stay
in the thread to answer.

Reddit could not be read from this environment (it blocks automated access), so the rules below come from the
subreddits' wikis as quoted in search results and from third-party rule trackers, dated where known. The owner
re-reads each sidebar and pinned post right before posting; if anything differs, the sidebar wins.

Account note: several subs filter posts from new or low-activity accounts and judge self-promotion against the
account's history (Reddit's own guideline: well under 10 % of activity about your own things). If the owner's
account is new or quiet, take part in these subs for a few weeks first, without mentioning Arcalo.

## Overview

| Subreddit | Status | Reason / next step |
| --- | --- | --- |
| r/rust | drafted | Self-promotion is judged against a bar that an open-source project under an OSI license or a blog post about your experience with Rust can meet (r/rust wiki). Post the technical article, not an ad. |
| r/SideProject | drafted | Made for sharing side projects and asking for feedback; no explicit rule found against it. |
| r/de_EDV | drafted, ask mods first | German IT sub; no clear written rule on self-promotion (tracker, September 2026). Send the modmail below first. |
| r/SAP | drafted modmail only | No clear written rule; "unclear communities enforce norms through removals" (tracker, August 2026). Ask the mods before any post. |
| r/jira | drafted modmail only | Same as r/SAP (tracker, August 2026). Ask first. |
| r/productivity | `rejected` | "No Advertising" rule bars self-promotion in any form, even when someone asks for recommendations (rule trackers quoting the sidebar, July 2026). |
| r/opensource | `rejected` | New rules from 24 October 2026: no projects that use or are intended for AI, and promoted projects need about a year of active maintenance, several contributors and an existing community; posters need a year-old active account. Arcalo has an optional AI assistant, one maintainer and a young repository. |
| r/ObsidianMD | `rejected` | Rule "Don't shill"; Obsidian's community code of conduct (which covers its official channels) says promotional content must be relevant to Obsidian, meaning it supports or integrates with Obsidian. Arcalo is a separate app. Only if someone explicitly asks for an alternative with time tracking may the owner answer, saying he made it. |
| r/selfhosted | `rejected` | For software you host on a server; mobile apps only as companions to a self-hosted backend, and projects younger than three months go to the Friday megathread. Arcalo is a desktop app. |

## r/rust

- When: one week after the dev.to article is up (so it is not the same day as Show HN). Proposed: Tuesday
  10 November 2026, 16:00 CET.
- Type: link post to the dev.to article. Flair, if required: the one for blog posts / projects.
- Condition: the owner has read and stands behind the article; if it was not rewritten, it carries the
  AI-assistance line (see `devto-hashnode-article.md`). Expect questions about it.

Title:

```
Building a local-first desktop app with Rust and Tauri: one HTTP client, SQLite everywhere, and Outlook via COM
```

First comment (by the owner):

```
Author here. Arcalo is MIT licensed (https://github.com/MouseWerk/Arcalo). The parts I'd most like feedback on
from this sub: keeping all logic in a plain core crate with a thin Tauri shell, enforcing "one way to build an
HTTP client" with a test, and doing backups with VACUUM INTO plus write-then-rename. Happy to go into details.
```

## r/SideProject

- When: Thursday 12 November 2026, 15:00 CET.
- Type: text post with two or three images (`docs/screenshots/split-view.png`,
  `docs/screenshots/timesheet-dark.png`, `docs/screenshots/calendar-week.png`).
- The first paragraph is personal; the owner adjusts it so it is true for him.

Title:

```
I built a local-first desktop app that keeps my notes, tasks, meetings and timesheet in one place
```

Text:

```
My week used to be spread over a notes app, a task app, Outlook and a spreadsheet for the hours I book into
SAP and Jira on Friday. So I built Arcalo, a desktop app for Windows, macOS and Linux that keeps all of it
together on my own computer.

- Markdown notes with [[links]]; an Obsidian vault imports as it is
- tasks in notes, a projects view with budgets
- meetings from Outlook Classic or ICS next to the booked time
- "/time 2.5h" in a note books time; the week exports to SAP CATS, Jira, CSV or JSON
- Jira issues open and can be edited inside the app (new in 1.22)
- optional AI on providers you add (Ollama, LiteLLM, OpenAI-compatible, Azure), or none

No account, no telemetry, free and MIT licensed. Built with Rust and Tauri.

What I'd like feedback on: is the first start understandable without reading anything? And for those who track
time: what would you need before you'd switch?

Code and downloads: https://github.com/MouseWerk/Arcalo
```

## r/de_EDV

Modmail first (owner, by hand):

```
Hallo Mod-Team,

ich habe eine kostenlose Open-Source-Desktop-App (MIT) für Notizen, Aufgaben, Termine und Zeiterfassung
geschrieben, mit Export nach SAP CATS und Jira. Darf ich sie hier einmal vorstellen und um Feedback bitten? Wenn
ja: gibt es dafür einen bestimmten Flair oder Tag? Wenn nein, ist das auch in Ordnung.

Danke und Gruß
Maurice
```

Post, only after a yes:

Titel:

```
Ich habe eine lokale Desktop-App für Notizen, Aufgaben, Termine und Zeiterfassung gebaut (Open Source) – Feedback?
```

Text:

```
Moin, ich arbeite viel mit SAP und Jira und hatte meine Woche über vier Tools verteilt. Daraus ist Arcalo
entstanden: eine Desktop-App für Windows, macOS und Linux, die Notizen, Aufgaben, Termine und Zeiterfassung
zusammenhält.

- Markdown-Notizen mit [[Links]], Obsidian-Vaults lassen sich importieren
- Termine aus Outlook Classic (ohne Adminrechte, ohne App-Registrierung) und ICS-Kalendern
- /zeit 2,5h in einer Notiz bucht Zeit; der Wochenzettel geht nach SAP CATS, Jira, CSV oder JSON
- Jira-Issues öffnest und bearbeitest du direkt in der App
- KI optional, nur bei Anbietern, die du einträgst (z. B. Ollama lokal), oder gar nicht

Kein Konto, keine Telemetrie, die Daten liegen lokal. Proxy, PAC und eigene Root-Zertifikate für Firmennetze
sind eingebaut. Kostenlos, MIT-Lizenz.

Mich interessiert vor allem: Was fehlt euch, damit so etwas im Firmenumfeld durchgeht?

https://github.com/MouseWerk/Arcalo
```

(The first sentence of the post is personal; the owner adjusts it so it is true for him.)

## r/SAP and r/jira: modmail only

```
Hi mods,

I wrote a free, open-source (MIT) desktop app that books time from notes and exports the week to SAP CATS
[r/jira: and Jira worklogs, and opens Jira issues inside the app]. Would a single post asking this community
for feedback be okay here, and if so, with which flair? If it's not a fit, no problem.

Thanks,
Maurice
```

If they agree, adapt the r/SideProject text and lead with the SAP CATS export (r/SAP) or the Jira issue window
(r/jira). Post at most once per sub.
