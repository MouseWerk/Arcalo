# Bluesky and Mastodon: drafts

Status: drafted. Who acts: the owner creates the accounts (none exist yet) and posts by hand or with a
scheduler he controls. Owner approval needed. Same rules as for X (`../x-assets/draft.md`): no follow bots, no
mass replies, no repeated posts of the same link.

## Accounts

- **Bluesky:** handle `arcalo.mousewerk.de` (domain handle: one DNS TXT record `_atproto` on the website's
  domain, which proves the account belongs to the project). Display name `Arcalo`, avatar
  `../x-assets/avatar-400.png`, banner `../x-assets/banner-1500x500.png` (Bluesky crops to 3:1, the 1500 x 500
  banner fits).
- **Mastodon:** an instance whose rules allow project accounts. fosstodon.org is FOSS-focused and reviews sign-ups;
  its rules could not be read from here, so the owner reads https://fosstodon.org/about before applying. A
  general instance (mastodon.social) is the fallback. Add the website link to the profile and a
  `rel="me"` link on the website so the link shows as verified (website repo change, owner decision).
- Bio (both, 160 characters or fewer):

```
Notes, tasks, meetings and time tracking in one local-first desktop app. No account, no telemetry. Free and open source (MIT). Posts by the maker.
```

## Posts (one per day, start the day after the accounts exist)

Use the four X posts in `../x-assets/draft.md` (they fit Bluesky's 300 and Mastodon's 500 characters) with the
same images, and add alt text to every image:

- `thumb-1-launch.png`: "Arcalo with two notes side by side, a project page with its networks, and the
  assistant panel. Text: Notes, tasks, meetings and time in one app."
- `thumb-2-time.png`: "A meeting note with the line /time 1h Mapping workshop and Arcalo asking whether to book
  it on NP-8801/1020. Text: book time while you write, export to Jira, SAP CATS, CSV or JSON."
- `thumb-3-ai.png`: "Inline AI rewriting a sentence in a note, with Replace, Insert below and the model's token
  count and cost. Text: AI on the providers you choose."
- `thumb-4-meetings.png`: "A work week in the calendar with meetings from three calendars and the booked time
  next to them. Text: Outlook and ICS, no admin rights needed."

Note: `thumb-1-launch.png` and `thumb-3-ai.png` show a code block with the old name (`Get-Service -Name
'Annalo*'`). Fine for a post, but regenerate them with the current demo content before Product Hunt.

Release post for 1.22 (first post, Mastodon with hashtags, Bluesky without):

```
Arcalo 1.22 is out. Jira issues now open inside the app: description, fields, subtasks, comments, work log and
history, and you can edit what Jira lets you edit, with undo and a conflict check.

Free, open source, local-first, for Windows, macOS and Linux.
https://github.com/MouseWerk/Arcalo/releases/tag/v1.22.0

#Jira #OpenSource #LocalFirst #Productivity
```

Mastodon only (the Rust/Tauri crowd is there):

```
Arcalo is a local-first desktop app for notes, tasks, meetings and time tracking, built with Rust and Tauri 2.
One SQLite database, no account, no telemetry, AI only on providers you add. MIT.
https://github.com/MouseWerk/Arcalo

#Rust #Tauri #RustLang #LocalFirst #OpenSource
```

German post (both):

```
Arcalo gibt es auch auf Deutsch: Notizen, Aufgaben, Termine und Zeiterfassung in einer App auf deinem Rechner.
Mit /zeit buchst du in der Notiz, der Wochenzettel geht nach SAP CATS oder Jira. Kostenlos und Open Source.
https://arcalo.mousewerk.de/de/
```
