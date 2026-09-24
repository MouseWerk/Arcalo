<p align="center">
  <img src="docs/brand/annalo-icon-1024.png" width="112" alt="Annalo logo">
</p>

<h1 align="center">Annalo</h1>

<p align="center">
  <b>Notes, time tracking and your own AI in one local-first desktop app.</b><br>
  Markdown notes with <code>[[links]]</code> like Obsidian · SAP PS time booking with <code>/zeit</code> · an assistant on <b>your</b> LiteLLM server
</p>

<p align="center">
  <a href="https://github.com/mauricekleindienst/annalo/actions/workflows/ci.yml"><img src="https://github.com/mauricekleindienst/annalo/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/mauricekleindienst/annalo/releases/latest"><img src="https://img.shields.io/github/v/release/mauricekleindienst/annalo?label=release" alt="Latest release"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6b5bd6" alt="Platforms">
  <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%C2%B7%20Rust%20%C2%B7%20React-2f2f3a" alt="Tauri 2, Rust, React">
</p>

<p align="center">
  <img src="docs/screenshots/split-view.png" alt="Annalo: two notes side by side with the side panel" width="100%">
</p>

*Annalo* comes from the Latin *annales*, the year-by-year record of what happened: your notes and your working
hours, kept together.

Everything lives in one SQLite database on your computer. There is no cloud account and no telemetry. The only
network traffic is what you set up yourself: your LiteLLM server, an optional Git remote for backups, and update checks
against this repository's releases.

**Contents:** [Download](#download) · [Tour](#a-quick-tour) · [Features](#what-you-get) · [First steps](#first-steps) ·
[LiteLLM](#connecting-your-litellm-server) · [Proxy](#netzwerk--proxy) · [Customizing](#anpassen) ·
[Your data](#your-data-is-safe) · [Git sync](#git-synchronisierung) · [Keyboard](#keyboard) · [Building](#building) ·
[Updates](#automatische-updates-einrichten) · [Tests](#tests)

## Download

Get the latest version from the [**Releases page**](https://github.com/mauricekleindienst/annalo/releases/latest).

| System | File | Notes |
|---|---|---|
| **Windows 10/11** (x64) | `Annalo_<version>_x64-setup.exe` | Installs per user into `%LOCALAPPDATA%`, **no admin rights needed**. Updates itself. WebView2 is installed silently if it is missing |
| **macOS 11+** Apple Silicon | `Annalo_<version>_aarch64.dmg` | Drag into *Programme*. Not notarized: see [macOS](#macos) for the one-time Gatekeeper step |
| **macOS 11+** Intel | `Annalo_<version>_x64.dmg` | Same as above |
| **Linux** (x64) | `Annalo_<version>_amd64.deb` | Debian/Ubuntu: `sudo apt install ./Annalo_*.deb` |
| **Linux** (x64) | `Annalo_<version>_amd64.AppImage` | Any distribution: `chmod +x Annalo_*.AppImage && ./Annalo_*.AppImage` |

The first start opens a short onboarding (language, theme, LiteLLM server) and seeds a small demo workspace to try
things out.

## A quick tour

### Notes that link to each other

Live-preview Markdown editing, with `[[wiki links]]`, backlinks, tags, tables, tasks and a page tree. Hovering a link
shows a preview of the linked page.

<p align="center">
  <img src="docs/screenshots/dark-02-page.png" width="49%" alt="A note in dark mode">
  <img src="docs/screenshots/link-preview.png" width="49%" alt="Hover preview of a [[link]]">
</p>
<p align="center">
  <img src="docs/screenshots/table-toolbar.png" width="49%" alt="Table editing toolbar">
  <img src="docs/screenshots/versions-diff.png" width="49%" alt="Version history with diff">
</p>

### Your own start page

Widgets for today's tasks, booked hours this week, budget warnings, recent pages, bookmarks, the timer, a note and the
calendar. You can arrange and resize them with drag and drop.

<p align="center"><img src="docs/screenshots/dashboard.png" width="90%" alt="Start page with widgets"></p>

### Time tracking with `/zeit`

Type `/zeit NP-8801/1020 2.5h #DEV Systemintegration` in any note. Netzplan, Vorgang and Leistungsart autocomplete,
with the remaining plan hours shown. A page linked to a Vorgang shows a work card with budget, ETC and a timer. The
weekly timesheet exports to SAP CATS, Jira, CSV or JSON.

<p align="center">
  <img src="docs/screenshots/zeit-suggest.png" width="49%" alt="/zeit autocomplete">
  <img src="docs/screenshots/page-work-card.png" width="49%" alt="Work card on a page linked to a Vorgang">
</p>
<p align="center">
  <img src="docs/screenshots/dark-06-timesheet.png" width="49%" alt="Weekly timesheet">
  <img src="docs/screenshots/dark-07-projects.png" width="49%" alt="Projects with budget, EAC and critical path">
</p>

### AI that stays on your server

The assistant answers from your notes and cites its sources: hovering `[1]` shows the passage. Inline AI rewrites
selected text. Meeting notes turn into decisions and tasks. `/zeit 2h habe am Interface-Mapping gearbeitet` asks the
AI which Vorgang the time belongs to and books only after you confirm.

<p align="center">
  <img src="docs/screenshots/cite-preview.png" width="49%" alt="Answer with cited sources">
  <img src="docs/screenshots/inline-ai-preview.png" width="49%" alt="Inline AI on a selection">
</p>
<p align="center">
  <img src="docs/screenshots/meeting-summary.png" width="49%" alt="Meeting summary">
  <img src="docs/screenshots/smart-zeit-confirm.png" width="49%" alt="Smart /zeit asks before booking">
</p>

### Tasks, calendar and quick search

Tasks from all notes are grouped by due date. The calendar shows your daily notes and booked hours per day. The global
quick search (Ctrl Shift O) works from any program.

<p align="center">
  <img src="docs/screenshots/tasks-view.png" width="32%" alt="Tasks across all notes">
  <img src="docs/screenshots/calendar.png" width="32%" alt="Calendar of daily notes">
  <img src="docs/screenshots/quick-search.png" width="32%" alt="Global quick search">
</p>

### Made to fit you

Light or dark mode, any accent color, fonts, density, language (German/English) and rebindable shortcuts. The
settings also cover proxy and certificates for company networks and Git backup.

<p align="center">
  <img src="docs/screenshots/settings-appearance-teal.png" width="32%" alt="Appearance settings">
  <img src="docs/screenshots/settings-network.png" width="32%" alt="Network and proxy settings">
  <img src="docs/screenshots/settings-git-sync.png" width="32%" alt="Git sync settings">
</p>

## What you get

**Notes**
- Live-preview Markdown editor: headings, lists, task lists, tables, code blocks with syntax highlighting, highlights, links
- `[[Wiki links]]` with autocomplete; clicking a missing page creates it; renames rewrite links everywhere
- Backlinks under every page and in the side panel, outline, tags (`#tag`) with a tag view
- Daily notes (Ctrl Shift D) with previous/next day navigation, optionally from a template; a calendar (Ctrl Shift C, right-click on the ribbon's daily-note button) shows which days have a note and the booked hours per day against the daily target
- Tasks across all notes (Ctrl Shift A): `- [ ] Angebot senden 📅 2026-09-30 !!` (also `due:2026-09-30`; `!!` = hoch, `!` = mittel), grouped into Überfällig / Heute / Diese Woche / Später / Ohne Datum, filterable by status and tag, checked off right in the list
- Images: paste or drop screenshots into a note; they are stored under `attachments/` and embedded as `![[name.png]]`
- Templates: pages under „Vorlagen“ with `{{datum}}`, `{{date}}`, `{{zeit}}`, `{{titel}}`, `{{wochentag}}`, `{{kw}}`; `/Vorlage einfügen` or „Neue Seite aus Vorlage…“ in the palette
- Slash menu (`/`), formatting toolbar on selection, a table toolbar (rows, columns, header) while the cursor is in a table, find in page (Ctrl F)
- Version history: „Versionen…“ in the page menu lists earlier states (kept 30 days) with a diff against now, and restores them
- Tabs, favorites, a drag-and-drop page tree, a command palette (Ctrl K) and a quick switcher (Ctrl O)
- Import an Obsidian vault (folders, frontmatter, links, tags and images kept), export everything back to Markdown files

**Time tracking**
- Type `/zeit NP-8801/1020 2.5h #DEV Systemintegration` in any note and press Enter. It books the time and leaves a chip in the note
- `/zeit` autocompletes: Netzplan/Vorgang (recently booked first, with the remaining plan hours) and, after `#`, the Leistungsart
- Link a note to a Vorgang with the property `vorgang: NP-8801/1020` (or `netzplan: NP-8801`): the page shows a work card with budget, ETC, the latest bookings and a timer button, and `/zeit 1.5h Abstimmung` there books on that Vorgang
- Timer with idle detection (inactive time can be subtracted), quick booking, manual entries
- Weekly timesheet with a grid per Netzplan/Vorgang, release workflow, and export to SAP CATS, Jira worklogs, CSV or JSON
- Projects view: budget, booked hours, remaining effort (ETC), forecast (EAC), critical path and float, as tables
- Budget warnings when a booking pushes a Netzplan or Vorgang over its thresholds

**Desktop**
- Tray icon: open, stop the timer or restart the last booking, quick capture, quit; the tooltip shows the running timer (`NP-8801/1020 · 01:23`)
- Startup animation: the logo draws itself while the app loads (Settings → Darstellung → Startanimation)
- Developer log: errors of the app, the AI, Git sync, backups and updates are written to `logs/annalo.log` in the data folder (rotated at 1 MB, secrets redacted) and shown under Settings → Protokoll (filter, copy, clear, open folder); "Über" shows the errors of the last 7 days
- Taskbar jump list (Windows, right-click the taskbar button): Heutige Notiz, Neue Seite, Schnellerfassung, Suchen…, stop the running timer or start the last one, and the recently edited pages
- Own title bar on Windows: the tabs sit at the top edge like in Obsidian, with the app's own window buttons (Settings → Darstellung switches back to the system title bar)
- Closing hides the window to the tray (Settings → Desktop), start with Windows (minimized), one instance per workspace
- Quick capture (Ctrl Shift Space, global): one line into today's daily note, `todo …` / `- [ ] …` as a task, `/zeit …` books time
- Quick search (Ctrl Shift O, global, or „Suchen…“ in the tray): a small window above all programs that finds pages, passages and bookings, opens today's daily note, creates a page, starts/stops the timer or books `/zeit …`; Enter opens the result in the main window
- Start page with widgets: Heute (due tasks, quick add to the daily note), Woche (booked vs. target per day, gaps), Budgets, Zuletzt bearbeitet, Lesezeichen, Timer, Notiz and Kalender. „Anpassen“ adds, removes, reorders (drag & drop or arrow buttons) and resizes them
- End-of-day reminder on workdays when less than the daily target is booked (default 17:30), and once when a timer is still running after 20:00

**Assistant**
- Streams answers from your LiteLLM server; knows the open page and searches notes and time logs (keyword + semantic)
- Model routing: local, standard and reasoning models; `#privat` content always stays on the local model
- Can book time, search and check budgets; system tools (PowerShell, git, HTTP) only run after you approve them
- „Wochenbericht erstellen“ (Ctrl K) drafts this week's status e-mail from your bookings and done tasks; „In neue Seite einfügen“ saves it as „Wochenbericht KW nn“
- Inline AI: select text and press Ctrl J (or „KI“ in the formatting toolbar, `/KI bearbeiten` for the current block): Verbessern, Kürzen, Übersetzen DE↔EN, In Stichpunkte, Als Tabelle, … or your own instruction; the result streams into a preview and replaces the text (one Ctrl Z undoes it) or goes below it
- „Besprechung zusammenfassen“ (page menu, `/Zusammenfassung`): Zusammenfassung, Entscheidungen, Aufgaben (`- [ ] … @Person 📅 …`) and Offene Punkte, inserted at the end of the page or saved as „<Titel> – Zusammenfassung“; on a page with `vorgang:` and a time span (`10:00–11:30`) it adds a `/zeit` booking suggestion
- Answers cite their sources as numbered chips `[1]`: hovering shows the cited passage, clicking opens the page, scrolls to the paragraph and briefly highlights it (the „Quellen“ chips do the same)
- Smart `/zeit`: `/zeit 2h habe am Interface-Mapping gearbeitet` on a page without `vorgang:` asks the AI for the Vorgang and shows „Buchen auf NP-8801/1020 · Systemintegration (DEV)?“ with the reason – Enter books, Tab picks another reference, Esc cancels (also in quick capture). Nothing is booked without confirmation
- Shows sources, time to first token, tokens/s, tokens and cost per answer and per session

## First steps

<img src="docs/screenshots/onboarding.png" width="42%" align="right" alt="Onboarding">

1. **Install and start.** The onboarding asks for language, theme and (optionally) your LiteLLM server. You can skip
   anything and change it later under Settings
2. **Look around the demo workspace.** Press **Ctrl K** for the command palette, **Ctrl O** to jump to a page and
   **Ctrl Shift D** for today's daily note
3. **Coming from Obsidian?** Use „Obsidian-Vault importieren…“ in the command palette. Folders, frontmatter, links,
   tags and images are kept
4. **Book your first time.** Type `/zeit` in a note, or start the timer with **Ctrl Shift T**
5. **Behind a company proxy?** Settings → Netzwerk, see [below](#netzwerk--proxy)

<br clear="right">

## Connecting your LiteLLM server

Settings → **KI & LiteLLM**:

1. **Server-URL**: e.g. `https://llm.your-company.com`
2. **API-Token**: your LiteLLM virtual key or master key. It is stored in the Windows Credential Manager or the macOS Keychain, never in the database or the settings
3. **Testen** lists the server's models; pick the models for *Lokal*, *Standard*, *Reasoning* and (optionally) *Embeddings*

Changes apply immediately, with no restart. A tier whose model the server does not offer (the defaults are placeholders)
is flagged there with „Automatisch zuordnen“; requests fall back to a model the server has, and a model whose deployments are
cooling down („No deployments available for selected model“) is retried once on another one. `#privat` content never falls
back to a cloud model. `config/litellm.config.example.yaml` shows a matching proxy configuration.

## Netzwerk & Proxy

Settings → **Netzwerk** applies to every outgoing connection: the LiteLLM server, the assistant's HTTP tool, the Git
sync and the updater (each can be excluded under „Anwenden auf“).

- **Proxy-Modus**: *Kein Proxy*, *System* (Windows: the WinINet settings of the current user, including the exception
  list and `<local>`; elsewhere `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`), *Manuell* (HTTP, HTTPS and SOCKS
  proxy as `host:port` or URL) or *PAC*
- **Ohne Proxy erreichen**: `host` (and its subdomains), `*.domain` / `.domain` (subdomains only), IPs, CIDR ranges
  (`10.0.0.0/8`), `<local>` (names without a dot) and `*`
- **Anmeldung**: user name in the settings, password in the Windows Credential Manager / macOS Keychain (Basic auth)
- **Zusätzliches Stammzertifikat**: a PEM (also bundles) or DER file of a company root CA, e.g. for TLS-inspecting
  proxies; the page shows the number of certificates, the first subject and its expiry. „Ungültige Zertifikate
  akzeptieren“ exists for troubleshooting only and shows a warning while it is on
- **Verbindung testen** requests `<LiteLLM>/v1/models` with the entered (also unsaved) values and shows whether the
  request went direct or through which proxy, and how long it took

PAC files are JavaScript. The core does not embed a JS engine: the UI evaluates `FindProxyForURL` in a sandboxed frame
(own `annalo-pac:` scheme, opaque origin, no access to the app) for the LiteLLM host, GitHub (updates) and the Git
remote when the settings are saved or tested and at every start, and stores the answers. Limitations: no DNS
(`isInNet` only matches IP addresses, `dnsResolve` only returns IP literals, `myIpAddress()` is `127.0.0.1`), and
other hosts (the assistant's HTTP tool) use the answer for the LiteLLM host. Git receives the proxy through
`http_proxy`/`https_proxy`/`no_proxy` and the CA through `http.sslCAInfo` (extra CA plus the system bundle); Git for
Windows verifies with the Windows certificate store (schannel), so install the root CA there.

## Anpassen

Settings are grouped (Allgemein, Arbeiten, KI, System) and searchable. Besides the connections they cover:

| Section | What |
|---|---|
| Darstellung | light/dark, accent color (presets or any hex; lightness is adjusted for WCAG contrast in both modes), UI/editor/code fonts, scale 90–125 %, density, line width, reduced motion, Mica (Windows 11), own title bar with the tabs at the top edge (Windows, like Obsidian; the system title bar is one switch away) |
| Sprache & Format | German or English for settings, ribbon, sidebar, tabs, status bar and commands (longer help texts, dialogs and AI prompts stay German), date format |
| Start | open the last tabs, the start page or today's note; remember window size and position; start minimized |
| Tastatur | rebind every in-app shortcut, with conflict detection (commands, editor keys, global shortcuts); Ctrl+Alt is rejected (AltGr) |
| Editor | spell check language, autosave delay, typographic quotes („…“ ‚…‘ –), closing brackets, Tab width and line numbers in code blocks, link hover preview, scroll outline, icon and location of new pages |
| Notizen | daily note title (`2026-09-24`, `24.09.2026`, `Donnerstag, 24.09.2026`) and folder, trash retention, version interval and count |
| Zeiterfassung | week start, rounding (1/5/6/10/15 min, up or nearest) and minimum for bookings and timer stops, hours as `1,50` or `1:30`, default Leistungsart per Netzplan, CATS separator and column order, export file name |
| KI | temperature, answer length, streaming, citations, allowed tools (system tools off by default), monthly cost limit (warning at 80 %, blocked at 100 % unless sent anyway), inline AI actions, meeting summary template |
| Datenschutz | private tags, whether the assistant sees the open page, local model only |
| Benachrichtigungen | each reminder and notice on/off, quiet hours for desktop notifications |
| Verwaltung | export all settings to JSON (never tokens or passwords), import with a preview of the changes, reset one section or everything |

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

Data lives in `%APPDATA%\app.annalo.desktop\` (`workspace.db`); Settings → Annalo → „Speicherort ändern…“ moves it
(avoid OneDrive/Dropbox and network folders for the database; backups there are fine). The first start seeds a small demo workspace.
The database is backed up daily into `backups` there (or a folder chosen under Settings → Sicherung), and deleted
pages stay in the trash for 30 days. Each backup also refreshes a read-only Markdown copy of all pages (with images) and
the bookings as `Zeiterfassung/YYYY-MM.csv` (Excel-ready) in `backups/markdown` (configurable under Settings → Sicherung).

## macOS

Releases contain `Annalo_<version>_aarch64.dmg` (Apple Silicon) and `Annalo_<version>_x64.dmg` (Intel), macOS 11
or newer. Open the disk image and drag **Annalo** into *Programme*.

The app is **ad-hoc signed but not notarized**, so Gatekeeper blocks the first start („kann nicht geöffnet werden, da
der Entwickler nicht verifiziert werden kann“ or „ist beschädigt“). Once, either:

- in Finder, right-click (Ctrl-click) *Annalo* in *Programme* → **Öffnen** → **Öffnen**
  (on macOS 15: System Settings → Datenschutz & Sicherheit → „Dennoch öffnen“), or
- in the Terminal: `xattr -cr "/Applications/Annalo.app"`

On macOS the app follows the platform conventions: a German menu bar (⌘, settings, ⌘\ sidebar, ⌘. focus mode, ⌘Q
quits after saving the open editors), the tab bar sits in the title bar, closing the window keeps the app running in
the Dock and the menu bar (a click on the Dock icon brings the window back; Settings → Desktop to turn this off), and
every in-app shortcut uses ⌘ instead of Ctrl. Quick capture defaults to ⌘⇧Space. „Bei der Anmeldung starten“ adds a
LaunchAgent. The LiteLLM API key and the Git token are kept in the login keychain; idle detection uses CoreGraphics
(no permission needed), usage statistics record the frontmost app's name.

Build locally on a Mac (Xcode command line tools, Rust, Node 22): `cd src-tauri && cargo tauri build --bundles app,dmg`.

**Developer ID signing and notarization (optional).** With an Apple Developer account the release workflow signs and
notarizes automatically once these repository secrets exist (without them it stays ad-hoc signed):

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | the „Developer ID Application“ certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `APPLE_CERTIFICATE_PASSWORD` | the password chosen when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | the certificate name, e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | the Apple ID e-mail (for notarization) |
| `APPLE_PASSWORD` | an app-specific password for that Apple ID (appleid.apple.com → Anmelden und Sicherheit) |
| `APPLE_TEAM_ID` | the 10-character team ID (developer.apple.com → Membership) |

The first three sign the app; with all six it is also notarized and stapled, and the `xattr` step is no longer needed.

## Automatische Updates einrichten

The app updates itself from GitHub releases: at start, every 6 hours (Settings → Über → „Automatisch nach Updates
suchen“) and via „Jetzt nach Updates suchen“ it reads
`https://github.com/mauricekleindienst/annalo/releases/latest/download/latest.json`. A newer version shows a toast
„Version X verfügbar“ with „Installieren und neu starten“ and the release notes („Was ist neu?“); nothing is installed
without that click. Before installing, all open editors are saved; the signed NSIS installer then runs passively and
restarts the app (on macOS the signed `.app.tar.gz` replaces the app bundle, then it restarts).

Updates must be signed. The public key is committed (`src-tauri/updater.pub`) and compiled into release builds;
the updater is **only active in builds made by the release workflow with the signing secrets**. Local and CI builds show
„Automatische Updates sind in diesem Build nicht eingerichtet“ and never contact the update server. One-time setup on
GitHub → the repository → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | the full content of the private key file (`annalo-updater.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |

Then every tag `vX.Y.Z` produces a signed installer (Windows), signed update archives (macOS) and `latest.json`
(`windows-x86_64`, `darwin-aarch64`, `darwin-x86_64`). To rotate the key, generate a new pair with
`cargo tauri signer generate -w annalo-updater.key`, replace `src-tauri/updater.pub` and both secrets; apps installed
with the old key must be updated once by hand.

## Your data is safe

- **Local first.** Everything is in one SQLite database (`workspace.db`) in your user profile. Nothing leaves the
  computer unless you set it up
- **Daily backups** of the database into `backups` (folder configurable), with a readable **Markdown copy** of all
  pages, images and bookings (`Zeiterfassung/YYYY-MM.csv`, Excel-ready)
- **Trash** keeps deleted pages for 30 days. **Version history** keeps earlier states of every page, with a diff
- **Git sync** pushes the Markdown copy to your own private repository (see below)
- **Secrets** (LiteLLM key, Git token, proxy password) are stored in the Windows Credential Manager or the macOS
  Keychain (on Linux in `secrets.json` in the data folder, readable only by your user). They are never written to the
  database, settings exports or logs
- **Export** everything back to plain Markdown files at any time

## Git-Synchronisierung

Settings → **Sicherung** → „Git-Synchronisierung“ pushes the Markdown copy (pages, images, `Zeiterfassung/*.csv`) to a
Git repository, for example on GitHub, GitLab or Azure DevOps. It needs Git installed ([git-scm.com](https://git-scm.com)).

1. Create an empty private repository and enter its **Remote-URL** (and the branch, default `main`)
2. HTTPS: create a personal access token with write access to the repository and save it under **Zugangstoken**. It is
   stored in the Windows Credential Manager and sent to Git only through environment variables, never on the command
   line, in `.git/config` or in any log. SSH URLs (`git@github.com:…`) use your system's SSH keys and agent instead
3. **Verbindung testen** runs `git ls-remote`; **Jetzt synchronisieren** syncs immediately
4. Choose when to sync: **Mit jeder Sicherung** (daily and „Jetzt sichern“) or **Stündlich**

Every sync commits only when something changed („Sicherung 24.09.2026 14:05 – 3 Dateien geändert“). The working copy
lives in `git-sync` in the data folder. Optionally the latest database backup is committed as `annalo-workspace.db`
(this grows the repository quickly; GitHub rejects files over 100 MB). If the branch on the server contains a
different history (for example another computer's or an unrelated project), nothing there is overwritten: the commit
goes to the branch `annalo-sync-<computer name>` and the settings say so. A new computer with the same remote continues
the existing history. Failures appear as a notification and in the status line.

**Restore**: „Aus Git wiederherstellen…“ clones the repository and imports it as a new top-level page
„Git-Import <Datum>“ (images included); existing pages are left alone.

## Tests

```sh
cargo test -p annalo-core      # core: parser, CPM, budgets, exports, FTS, RAG, notes, vault, settings
e2e/run.sh                     # end-to-end: drives the real desktop app via WebDriver (Linux, Xvfb)
```

The end-to-end suite starts the actual app binary under `tauri-driver`, with a fresh data directory per test file,
and a fake LiteLLM server for the assistant tests. It also saves screenshots of every screen (dark and light) to `e2e/screenshots/`.

## Repository layout

| Path | Contents |
|---|---|
| `crates/annalo-core` | Rust core: SQLite + FTS5 store, documents/links/tags, `/zeit` parser, time tracking, budgets, CPM, exports, idle detection (Win32), LiteLLM client, router, RAG, tools, vault import/export |
| `crates/annalo-cli` | `annalo` command line on the same database |
| `src-tauri` | Tauri v2 desktop shell: IPC commands, credential storage, global shortcuts, tray, quick capture, reminders, activity sampler |
| `ui` | React + TypeScript + TipTap frontend (Vite), Lucide icons |
| `e2e` | WebdriverIO end-to-end tests against the desktop app |
| `docs/ARCHITECTURE.md` | Design notes |

## Keyboard

All in-app shortcuts can be changed under Settings → Tastatur (the defaults are listed here). On macOS use ⌘ where the table says Ctrl (the app shows ⌘⇧⌥⌃ glyphs there); Ctrl Tab stays Ctrl Tab.

| Keys | Action |
|---|---|
| Ctrl K / Alt Space (global, configurable) | Command palette, search, `/zeit …`, `? question` |
| Ctrl Shift Space (global) | Quick capture |
| Ctrl Shift O (global, configurable) | Quick search window |
| Ctrl O | Quick switcher |
| Ctrl N | New page |
| Ctrl Shift D | Today's daily note |
| Ctrl Shift C | Calendar of daily notes |
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
archives and publishes everything together with `latest.json` on the Releases page.
