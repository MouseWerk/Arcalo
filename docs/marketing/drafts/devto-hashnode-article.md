# dev.to / Hashnode article: draft

Status: drafted. Who acts: the owner, from his own dev.to account (and optionally Hashnode as a cross-post with
the dev.to URL as canonical). Owner approval needed.

## Rules that apply (checked 2026-10-27)

- dev.to: articles must not exist mainly to promote a business or product; a technical write-up about how you
  built something, with a link to it, is the normal form there. AI-assisted or AI-generated articles must say
  so, either with the tag `#abotwrotethis` or a sentence in the text, and the author must be able to stand
  behind every statement (https://dev.to/guidelines-for-ai-assisted-articles-on-dev). This draft was prepared
  with AI help: either rewrite it in your own words, or keep the disclosure line at the end.
- Hashnode: free blogs still work (some features moved to a paid plan in 2026). Publish there only as a
  cross-post and set the canonical URL to the dev.to article, so search engines do not see two originals.
- This Week in Rust does not accept LLM-written articles. Submit the article there only if the owner has
  rewritten it himself (then as "Observations/Thoughts" via a PR to the draft in
  https://github.com/rust-lang/this-week-in-rust). Project announcements are no longer taken by PR.

## Tags (dev.to allows four)

`rust`, `tauri`, `localfirst`, `productivity`

## Cover image

`docs/social-preview.png` (1280 x 640) or https://arcalo.mousewerk.de/og.png (1200 x 630). dev.to crops covers
to 1000 x 420; check the preview.

## Images in the text

- `docs/screenshots/split-view.png` after the introduction.
- `docs/screenshots/time-suggest.png` in the `/time` section.
- `docs/screenshots/settings-network.png` in the network section.

Upload them in the dev.to editor; do not hotlink raw.githubusercontent.com.

## Title

```
Building a local-first workday app with Rust and Tauri
```

## Article (about 1,200 words)

```markdown
For the last months I've been building Arcalo, a desktop app that keeps notes, tasks, meetings and working
hours in one place. It's free, MIT licensed, and it runs on Windows, macOS and Linux. This post is about the
technical choices behind it: why it's local-first, how the Rust side is organised, and a few problems that
turned out harder than expected.

![Two notes side by side with the assistant panel](split-view.png)

## Why local-first

The people I wrote it for are consultants: their notes are full of client names, budgets and meeting details,
and many of them work behind company proxies with rules about where data may go. A cloud workspace is a hard
sell there. So Arcalo has no account and no server. Everything lives in one SQLite database in the user
profile. The only network traffic is what the user sets up: their AI provider, their calendars, an optional
Git remote for backups, and update checks against GitHub releases.

Local-first also made the product simpler. There is no sync protocol to design, no multi-tenant backend to
secure, and no "is the server up?" state in the UI.

## The shape of the code

The repository is a Rust workspace with three parts:

- `arcalo-core`: all the logic (database, the `/time` parser, budgets, the critical path, exports, calendar
  sync, the AI client, search) with its tests.
- `src-tauri`: a thin Tauri 2 shell that wires state, IPC commands, events and OS integration.
- `arcalo-cli`: a command line client over the same core.

The UI is React with TipTap for the editor. It never touches the network or the filesystem directly; it calls
Tauri commands. That one rule pays off constantly: anything worth testing is a pure Rust function I can test
without a window, and the shell stays small enough to read.

## SQLite does a lot of the work

One database holds pages, page versions, tasks, time entries, the calendar cache, chat history and settings.
It runs in WAL mode, full-text search uses FTS5, and embeddings for search by meaning are stored as `f32`
BLOBs next to the pages. Encryption is optional and uses SQLCipher through `rusqlite`.

Backups use `VACUUM INTO`, which writes a consistent snapshot while the app keeps running. The snapshot is
written as `<name>.partial`, synced and only then renamed, so a half-written file never carries a backup's
name. Copies to a network share or a synced cloud folder follow the same pattern plus a SHA-256 file, and each
copy runs on its own watched thread: a share that hangs is given up after a minute instead of freezing the
app.

Because a database is opaque to other tools, every backup also refreshes a read-only Markdown copy of all pages
and a CSV of the bookings. That copy is what the optional Git sync pushes to the user's own repository.

## Booking time while you write

The feature people ask about most is `/time`. In any note you type:

    /time NP-8801/1020 2.5h #DEV System integration

and the time is booked on that network activity with that activity type, leaving a chip in the note. The
parser is a plain function in the core, so it has a long table of tests for relative days (`@yesterday`),
German and English words, and the edge cases people actually type.

![/time autocomplete in a note](time-suggest.png)

At the end of the week the timesheet exports to SAP CATS, Jira worklogs, CSV or JSON. The CATS export taught
me something about rounding: three bookings of 20 minutes on one day are 1 hour, but three times "0.33" is
0.99. The exporter rounds the running total of each day and writes the difference, so the rows read 0,33 +
0,34 + 0,33 and add up to exactly 1,00 in SAP. Nothing is uploaded automatically; the user imports the file.

## One HTTP client to rule them all

Company networks were the biggest source of bugs early on: proxies, PAC files, proxy authentication and
TLS-inspecting proxies with their own root CA. The fix was structural. Every outgoing HTTP client in the app
is built through one function that takes the network settings and the service it's for (an AI provider, the
updater, Jira, the calendar). It applies the proxy decision for that URL, the extra root certificates and the
timeouts. A test scans the code and fails if anything builds a `reqwest` client another way.

![Network and proxy settings](settings-network.png)

PAC files were the interesting part, because they are JavaScript and I didn't want a JS engine in the core
or `unsafe-eval` in the app's Content Security Policy. The UI evaluates the PAC script in a sandboxed iframe
served from its own URL scheme, with its own CSP, and the answers are stored per host. Git gets the same
decision through environment variables and a CA bundle, so the Git sync works behind the same proxy.

## Talking to Outlook without an app registration

Many of my users can't register an Azure app or get admin rights. Outlook Classic on Windows has a COM
interface that the signed-in user can already use, so Arcalo ships a small PowerShell script that reads the
calendars the user picks (including shared and sub-calendars) and, when the user switches it on, writes
changes to their own appointments back. Only changed fields are written, and if the same field changed in
Outlook meanwhile, the user picks which version wins. On macOS and Linux the calendar reads ICS only.

## AI, optional and on the user's terms

The assistant answers from the user's notes with cited sources, but it only talks to providers the user adds:
Ollama, LiteLLM, any OpenAI-compatible endpoint or Azure OpenAI. Notes tagged `#privat` only go to a provider
marked as local, also when a request falls back to another model. With "Use AI" off the backend refuses AI
requests altogether, so the switch is not just hidden UI. Voice notes are transcribed on the device with
whisper.cpp through `whisper-rs`.

## Testing the real app

Unit tests cover the core, but many bugs only show up with a real window, a real WebView and real timing. The
e2e suite starts the built app and drives it with WebdriverIO and `tauri-driver`; it has more than 200 test
files. Two habits helped: tests never kill processes by name (only the PID they started), and a flaky test is
fixed at its root rather than retried.

## What I'd do again, and what not

Again: keeping all logic in a plain Rust crate, and making cross-cutting rules (one HTTP client, no inline
scripts, translations for every string) into tests instead of review comments.

Not again: I renamed the app once (it was called Annalo until 1.6), and migrating data folders, credential
entries and identifiers in place cost more time than any feature.

## Try it

Arcalo is on GitHub at https://github.com/MouseWerk/Arcalo with installers for Windows, macOS and Linux. The
macOS build isn't notarized yet and the Windows installer isn't code-signed, so expect one warning on first
start. Issues and questions are welcome.

*This article was written with the help of AI and checked by me.* (Keep this line unless you rewrote the
article yourself.)
```

## Word count

About 1,200 words in the article block. Check after editing.
