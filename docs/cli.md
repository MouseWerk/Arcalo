# Command line

`arcalo` works on the same workspace as the app: pages, daily notes, tasks, tags, links, search, the
calendar, time tracking, projects, attachments, the trash and the settings. It reads and changes
everything the app does, through the same functions (crate `arcalo-cli` on top of `arcalo-core`), so a
page created, renamed or deleted here behaves exactly like one changed in the app: links follow a rename,
deleted pages go to the trash, edits keep versions, tasks are rewritten in their notes.

It is made for people, scripts and AI agents with a terminal. Every command can print JSON (`--json`),
exit codes are stable, and it is safe to run while the app is open: the app shows the changes within a
second, without a restart, and typing in an open note is never lost.

- [Where the program is](#where-the-program-is)
- [Which workspace](#which-workspace)
- [Naming pages and tasks](#naming-pages-and-tasks)
- [Commands](#commands)
- [JSON output](#json-output)
- [Errors and exit codes](#errors-and-exit-codes)
- [While the app runs](#while-the-app-runs)
- [Using Arcalo from an AI agent](#using-arcalo-from-an-ai-agent)

## Where the program is

The app's own program is the command line: started with a command (`arcalo pages list`) it runs that
command and ends, without opening a window. Started without one (or with the app's own arguments, such as
`--minimized`) it starts the app as usual.

| Install | Program | On the PATH |
|---|---|---|
| Windows (installer) | `%LOCALAPPDATA%\Arcalo\arcalo.exe` (an update of Annalo 1.6 keeps `%LOCALAPPDATA%\Annalo\arcalo.exe`) | yes, the program folder on the user's `Path` (from 1.18) |
| Windows (Microsoft Store) | the alias `Arcalo.exe` | yes |
| Windows (portable ZIP) | `Arcalo.exe` in the unpacked folder; it uses the portable `data` folder next to it | no (on request in the settings) |
| Windows (Scoop) | the shim `arcalo` | yes |
| macOS | `/Applications/Arcalo.app/Contents/MacOS/arcalo` | on request in the settings: `/usr/local/bin/arcalo` |
| Linux (.deb, AUR) | `/usr/bin/arcalo` | yes |
| Linux (AppImage) | the AppImage itself: `./Arcalo_1.18.0_amd64.AppImage pages list` | no |
| From source | `cargo run -p arcalo-cli -- pages list`, or `cargo install --path crates/arcalo-cli` | `~/.cargo/bin` |

Settings → Desktop → „Befehlszeile“ shows whether `arcalo` works in a terminal and which program it starts.

**Windows (installer).** Installing and every update put the program folder onto the user's `Path`
(`HKCU\Environment`, never the machine's), once: an entry that is already there in any spelling (another case, a
trailing backslash, `%LOCALAPPDATA%\Arcalo`) is kept and not added again. The rest of the value stays exactly as it
was, also a long one and its `%VARIABLES%`. Uninstalling removes that entry and nothing else; an update keeps it.
New terminals find `arcalo` at once; a terminal open during the install needs to be opened again. A silent install
(`/S`) does the same. To keep the program off the `Path`, switch „Befehl „arcalo“ im Terminal verfügbar machen“ off
in the settings (Desktop → Befehlszeile): the entry goes, and updates leave it off until you switch it on again
(the choice is kept in `HKCU\Software\MouseWerk\Arcalo`, value `CommandLinePath` = 0, and goes with „App-Daten
löschen“ when uninstalling).

**Windows (portable ZIP).** A portable copy leaves no traces on the computer, so it changes nothing by itself. The
same switch in its settings puts its folder on the user's `Path` (and takes it off again before you delete the
folder).

**macOS.** Nothing is changed without asking. Settings → Desktop → „Befehl „arcalo“ im Terminal verfügbar machen“
creates the link `/usr/local/bin/arcalo` to the program in the app bundle; macOS asks for an administrator's
password (unless `/usr/local/bin` is writable for you). Switching it off removes the link, only when it points to
this app. Start the app from the Applications folder first: a copy started from the disk image or from Downloads runs
from a temporary place that would leave the link pointing nowhere. By hand:

```sh
sudo ln -s /Applications/Arcalo.app/Contents/MacOS/arcalo /usr/local/bin/arcalo
```

**Linux.** The packages install `/usr/bin/arcalo`. An AppImage is called by its path, or linked into a folder on
your `PATH` by hand: `ln -s ~/Apps/Arcalo.AppImage ~/.local/bin/arcalo`.

Windows starts `arcalo.exe` like a windowed program: a script or an agent that reads its output gets it
as usual, but typed into PowerShell or the command prompt the prompt comes back before the output. There,
pipe it: `arcalo pages list | Out-String` (PowerShell) or `arcalo pages list | more` (cmd).

The program of 1.14 and earlier is still installed as `annalo` (Linux) and behaves the same.

## Which workspace

Without options the command line opens the workspace the app uses, found the way the app finds it:

1. `--data-dir <folder>` or the environment variable `ARCALO_DATA_DIR`,
2. a portable copy: the `data` folder next to the program (marker `arcalo-portable`),
3. the folder `location.json` names (Settings → Sicherung → „Speicherort ändern…“), when it holds a
   workspace; a move chosen there but not done yet stays for the app's next start,
4. the app's default folder: `%APPDATA%\de.mousewerk.arcalo` (Windows),
   `~/Library/Application Support/de.mousewerk.arcalo` (macOS), `~/.local/share/de.mousewerk.arcalo`
   (Linux).

`--db <file>` (or `ARCALO_DB`) names a database file directly, as in 1.17 and earlier; attachments are
then next to that file and a missing file is created. Without `--db` a missing workspace is an error
(exit code 2), never created. `arcalo info` shows which workspace is used.

An encrypted workspace (Settings → Sicherheit) is opened with the key the app keeps in the credential
store (Windows Credential Manager, macOS keychain, the Secret Service on Linux, else `secrets.json`;
a portable copy's own entries). Without it the command fails with a message saying so (exit code 4).
Other ways to give the key: `ARCALO_RECOVERY_KEY=<recovery key>`, or `ARCALO_DB_PASSWORD=<password>`
when a password was set for the key.

Messages follow the workspace's language (Settings → Sprache): German or English. JSON keys and error
codes are always English.

## Naming pages and tasks

A page is named by

- its id: `id:42` (a plain `42` too, unless a page is titled „42“),
- its exact title, in any case: `"Weekly sync"`,
- its path, the titles from the top level down: `"Projekte/Alpha/Weekly sync"`.

A title several pages have (month folders of different years, an imported vault) is refused with
exit code 1 and the list of matches (ids and paths); name one by id or path. Commands about the trash
(`pages restore`, `pages purge`) look in the trash.

A task is named by its page and its number among the page's tasks, as `tasks list` prints them:
`arcalo tasks done "Weekly sync" 2`. Numbers start at 0. With `--expect "<text>"` the command is refused
(exit code 3) when that task has another text by now, for example because the page changed since it was
listed; the task with that text is used when it is the only one.

Dates: `YYYY-MM-DD`, `today`, `yesterday`, `tomorrow` (also `heute`, `gestern`, `morgen`).

## Commands

Global options: `--json`, `--db <file>`, `--data-dir <folder>`, `--help`, `--version`. Text to write is
given as one quoted argument, or with `--body "<markdown>"`, `--file <path>` or `--stdin`.

### Workspace

| Command | What it does |
|---|---|
| `arcalo info` | Version, data folder, database, encrypted, portable, schema version, language, counts |
| `arcalo search <words…> [--limit 20]` | Full-text search over notes, page titles and time entries |

### Pages

| Command | What it does |
|---|---|
| `pages list [--parent <page>] [--trash]` | All pages in tree order, the children of one, or the trash |
| `pages tree [<page>]` | The tree, from the top or below a page |
| `pages show <page> [--meta]` | The Markdown (with `--json`: page, content, tags, links, backlinks) |
| `pages create <title> [--parent <page>] [--body/--file/--stdin] [--icon <name>]` | A new page; a taken title gets a number, as in the app (`Notes 2`) |
| `pages append <page> "<markdown>"` | Text at the end (below a list it continues the list) |
| `pages replace <page> [--whole]` | New text; the properties (frontmatter) stay unless `--whole` or the text brings its own |
| `pages props <page>` | The properties |
| `pages set <page> <key> <value>` / `pages unset <page> <key>` | Set or remove a property; a list as `[a, b]` |
| `pages rename <page> <title> [--keep-links]` | Rename; `[[links]]` in other pages follow (they keep a version) |
| `pages move <page> --to <page or /> [--position <n>]` | Below another page (`/`: the top level) |
| `pages duplicate <page> [--title <title>]` | A copy next to it |
| `pages delete <page>` | To the trash, with its subpages |
| `pages restore <page>` | Back from the trash |
| `pages purge <page> [--now]` | Delete for good from the trash; `--now` also a page outside it |
| `pages versions <page>` / `pages version <id>` | Earlier versions / the Markdown of one |
| `pages restore-version <page> <id>` | A version back (the current text becomes a version first) |
| `pages links <page>` / `pages backlinks <page>` | Pages it links to (`page`, `missing` or `file`) / pages linking to it |

### Daily notes

| Command | What it does |
|---|---|
| `daily show [--date <day>]` | The day's note (created as when the app opens it: Journal folder, template) |
| `daily create [--date <day>]` | Create it (or return the existing one) |
| `daily append "<markdown>" [--date <day>] [--section <name>]` | Below „Notizen“ / „Notes“, as quick capture writes, or another `## section`; else at the end |

### Tasks

| Command | What it does |
|---|---|
| `tasks list [--status open\|done\|all] [--due <day>] [--due-before <day>] [--overdue] [--tag <tag>] [--page <page>] [--limit <n>]` | Open first, by due date and priority |
| `tasks add "<text>" [--page <page> \| --daily <day>] [--due <day>] [--priority 0-2]` | A `- [ ]` item on a page, or in the daily note (default: today's) |
| `tasks done <page> <n>` / `tasks undone <page> <n>` | Check off (a repeating task gets its next occurrence) / open again |
| `tasks edit <page> <n> [--text …] [--due <day>\|none] [--priority …] [--repeat <rule>\|none] [--move-to <page>]` | Change it; what is not given stays |
| `tasks delete <page> <n>` | Delete it with its subtasks |

### Tags, calendar

| Command | What it does |
|---|---|
| `tags list` / `tags pages <tag>` | Tags with page counts / pages with a tag |
| `calendar events [--from <day>] [--to <day>]` | Appointments of the active calendars as last synced (default: 7 days) |
| `calendar today` | Today's appointments |

### Time tracking

| Command | What it does |
|---|---|
| `zeit <reference> <duration> [#LA] [text…]` | Book like `/zeit` in a note: `arcalo zeit NP-8801/1020 2.5h #DEV Integration` |
| `timer start <reference> [#LA] [text…]` / `timer stop [--idle <min>]` / `timer status` | The timer |
| `time list [--from <day>] [--to <day>]` | Time entries (default: this week) |
| `time edit <id> [--duration 1:30] [--start HH:MM] [--description …] [--vorgang <nr>\|none] [--activity-type <LA>\|none]` | Change an entry; a posted Jira worklog follows |
| `time delete <id>` | Delete an entry (its chip in the note says so) |
| `time week [--date <day>]` | Booked and target hours per day |
| `absences list [--from] [--to]` / `absences add <from> [<to>] [--kind vacation\|sick\|comp\|other] [--half] [--note …]` / `absences delete <from> [<to>]` | Absences (a range gets the working days) and public holidays |
| `export --format cats\|jira\|csv\|json [--from] [--to] [--pernr] [--jira-map <file>] [--mark]` | Export entries |
| `budget <netzplan>` / `schedule <netzplan>` | Budget with ETC and EAC / critical path |

### Projects

| Command | What it does |
|---|---|
| `project list` | Projects with Netzpläne and Vorgänge |
| `project add <code> <name>` / `project edit <code> --name …` / `project delete <code>` | Projects (one with booked time is kept) |
| `project add-netzplan <project> <nr> <wbs> [--description] [--hours]` / `edit-netzplan <nr> […]` / `delete-netzplan <nr>` | Netzpläne |
| `project add-vorgang <netzplan> <nr> [--description] [--days] [--hours] [--after 1010,1020]` / `edit-vorgang <np/nr> […] [--remaining <h>\|none]` / `delete-vorgang <np/nr>` | Vorgänge |

### Attachments, trash, settings, vault

| Command | What it does |
|---|---|
| `attachments list` | Files with size and the pages that embed them |
| `attachments add <file> [--page <page>]` | Copy a file in; with `--page` its `![[embed]]` goes at the page's end |
| `attachments export <name> <file or folder>` | Copy a file out |
| `trash list` / `trash empty` | The trash / delete everything in it for good |
| `settings get [<key>]` / `settings set <key> <value>` | Read or change a setting by its key (`editor.autosave_ms`); the value as JSON or text, checked and cleaned like a save in the app |
| `import <folder>` / `export-vault <folder>` | Import or write an Obsidian vault |
| `demo` | Sample data in an empty workspace |

API keys, tokens and other secrets are not settings: they stay in the credential store and are changed
in the app only.

## JSON output

With `--json` every command prints exactly one JSON value on stdout. Fields are only ever added, never
renamed or removed. Times carry the local offset (`2026-10-11T09:30:00+02:00`), days are `YYYY-MM-DD`.

A **page** (`pages create`, `list`, `move`, `restore`, …):

```json
{
  "id": 42, "title": "Weekly sync", "path": "Projekte/Alpha/Weekly sync", "parent_id": 7,
  "icon": "file-text", "kind": "note", "daily_date": null, "favorite": false,
  "updated_at": "2026-10-11T09:30:00+02:00"
}
```

`kind` is `note` or `canvas`; `daily_date` is set for a daily note; `deleted_at` is added for a page in
the trash. `pages show` and `daily show` add `content` (the Markdown), `tags`, `links` (link targets as
written), `unresolved_links` and `backlinks` (`[{ "id", "title", "context" }]`). `pages tree` nests pages
with `children`.

A **task** (`tasks list`, `add`, `done`, `edit`):

```json
{
  "page_id": 42, "page_title": "Weekly sync", "page_path": "Projekte/Alpha/Weekly sync",
  "ordinal": 2, "line": 14, "text": "Angebot schicken #kunde", "done": false,
  "due": "2026-10-20", "priority": 2, "tags": ["kunde"], "recur": "every:weekly"
}
```

A **time entry** (`time list`, `time edit`, `zeit` as `{ "entry": …, "alerts": […] }`, `timer start`):

```json
{
  "id": 7, "reference": "NP-8801/1020", "project": "PRJ-2026-X", "netzplan": "NP-8801", "vorgang": "1020",
  "activity_type": "DEV", "start": "2026-10-09T08:00:00+02:00", "end": "2026-10-09T09:30:00+02:00",
  "minutes": 90, "description": "Integration", "status": "draft", "page_id": null
}
```

`status` is `running`, `draft`, `released` or `exported`.

Others: `pages delete` → `{ "trashed": 2, "page": … }`; `pages purge`, `trash empty` → `{ "purged": n }`;
`pages rename` → `{ "page": …, "links_updated": n }`; `pages versions` →
`[{ "id", "page_id", "created_at", "size", "preview" }]`; `pages links` →
`[{ "target", "kind", "page" }]`; `pages props` → an object of the properties; `tasks delete` →
`{ "deleted": n }`; `tags list` → `[{ "tag", "pages" }]`; `search` →
`[{ "kind": "page"|"note"|"similar"|"time_entry", "page", "snippet", "entry_id", "reference", "score" }]`;
`calendar` → `[{ "key", "source", "title", "start", "end", "all_day", "location", "organizer", "attendees",
"link", "busy", "recurring", "note_page_id", "entry_id", "skip" }]`; `time week` →
`{ "from", "to", "booked_minutes", "target_minutes", "days": [{ "date", "booked_minutes",
"target_minutes", "holiday", "absence" }] }`; `absences list` → `{ "absences", "holidays", "state" }`;
`attachments list` → `[{ "name", "kind", "size", "modified", "used_in": [{ "id", "title", "trashed" }] }]`;
`settings get` → the value; `settings set` → `{ "key", "value" }` (the value as stored after checking);
`timer status` → `{ "running", "entry", "minutes" }`; `project list` → projects with `netzplaene` and
`vorgaenge`; `budget`, `schedule`, `import` → the app's own objects; `info` →
`{ "version", "data_dir", "database", "portable", "encrypted", "schema_version", "language",
"time_tracking", "counts": { "pages", "trash", "tags", "tasks_open", "tasks_done", "time_entries",
"projects", "attachments" } }`.

## Errors and exit codes

| Code | Meaning | JSON `code` |
|---|---|---|
| 0 | Done | |
| 1 | Usage: an unknown command or option, a wrong value, a page name that fits several pages | `usage`, `ambiguous` |
| 2 | Not found: a page, task, entry, version, setting or the workspace | `not_found` |
| 3 | Conflict or locked: the workspace refuses the change as it is now (a title taken, a task changed meanwhile, a running or exported entry, booked time), or the database stayed busy for 15 s | `conflict`, `locked` |
| 4 | Anything else: a file that cannot be read or written, an encrypted workspace without its key | `error` |

Errors go to stderr: in text mode as `Fehler: …` / `Error: …` in the workspace's language; with `--json`
as one object:

```json
{"error": {"code": "ambiguous", "exit_code": 1, "message": "“Notizen” fits 2 pages: name one with id:… or its path",
  "matches": [{"id": 12, "path": "Kunde A/Notizen", …}, {"id": 31, "path": "Kunde B/Notizen", …}]}}
```

## While the app runs

- **Writes wait for the app.** Every change runs in one transaction that takes the database's write lock
  first; while the app writes, the command waits (up to 15 s, then exit code 3). The app's own writes
  wait for the command the same way. Reads never wait (the database runs in WAL mode).
- **The app shows changes at once.** Each command records what it changed in the same transaction
  (`arcalo_core::external`). The app notices other processes' commits within a second
  (`PRAGMA data_version`) and reloads what the command named: the tree, the task view, open notes,
  bookings, projects, absences and settings (applied as if saved in the app).
- **Typing is never lost.** An open note reloads like it does for another pane: text typed but not
  saved yet is merged with the command's change. A note saved by the app after the command wrote is
  merged on save too (the editor sends the text it started from), so neither side's change is
  overwritten; where both changed the same paragraph differently, both versions stay.
- **Versions.** Before a command changes a page's text, the text is kept as a version (Versionen in the
  app), unless one was kept in the last minute, so a burst of commands keeps the state from before the
  first. Restoring that version takes the command's changes back.

## Using Arcalo from an AI agent

Give the agent a terminal and tell it about the program, for example in its instructions:

```text
Arcalo (my notes, tasks and time tracking) has a command line: `arcalo`. Always use --json and parse
stdout; errors are JSON on stderr with an exit code (1 usage, 2 not found, 3 conflict, 4 other).
Pages are named id:<n>, by exact title, or by path. `arcalo --help` and `arcalo <command> --help`
list everything. Prefer id:<n> once you know a page's id.
```

Typical workflows:

```sh
# Where am I, what is there?
arcalo --json info
arcalo --json pages tree
arcalo --json search "Angebot Müller"

# Read a page, add to it, file the result
arcalo --json pages show "Projekte/Alpha/Weekly sync"
arcalo --json pages append id:42 "- Entscheidung: Variante B"
arcalo --json pages create "Protokoll 11.10." --parent "Projekte/Alpha" --stdin < protokoll.md

# Today
arcalo --json daily show
arcalo --json daily append "- 14:00 Anruf Müller: Angebot bis Freitag"
arcalo --json tasks list --due today
arcalo --json tasks list --overdue
arcalo --json tasks add "Angebot an Müller schicken" --page id:42 --due tomorrow --priority 2
arcalo --json tasks done id:42 3 --expect "Angebot an Müller schicken"

# Meetings and time
arcalo --json calendar today
arcalo --json zeit NP-8801/1020 1.5h "#DEV" "Workshop Schnittstellen"
arcalo --json time week

# Clean up
arcalo --json pages rename "Entwurf" "Konzept v2"
arcalo --json pages delete "Alter Entwurf"     # to the trash, can be restored
arcalo --json pages purge "Alter Entwurf"      # for good
```

Shell quoting: write Markdown with real line breaks in a quoted argument, or pass it on stdin
(`--stdin`) or from a file (`--file`), which keeps any text exactly as it is.

Everything the command line does is done as the user: there is no separate permission. Deleting for good
(`pages purge`, `trash empty`) cannot be undone except from a backup.
