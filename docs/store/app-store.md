# App Store: listing

For App Store Connect → Arcalo → the version page and App Information (English (U.S.) as the primary language,
German as a localization). Limits: name 30 characters, subtitle 30, promotional text 170, keywords 100 (comma
separated), description 4,000. The account, the certificates and TestFlight: [../release/ios.md](../release/ios.md).
What the app does on iPhone and iPad: [../ios.md](../ios.md). German texts use „du“ (docs/i18n.md).

- **Name:** Arcalo (if taken: Arcalo Notes & Time)
- **Bundle ID:** de.mousewerk.arcalo · **SKU:** arcalo
- **Primary category:** Productivity · **Secondary category:** Business
- **Devices:** iPhone and iPad (universal)
- **Age rating:** 4+ (no objectionable content of its own, not a web browser)
- **Price:** free, no in-app purchases
- **Support URL:** https://arcalo.mousewerk.de/
- **Marketing URL:** https://arcalo.mousewerk.de/
- **Privacy policy URL:** https://arcalo.mousewerk.de/privacy (the text below, on the website)
- **Copyright:** 2026 MouseWerk, Maurice Kleindienst
- **Screenshots:** iPhone 6.9" (1320 × 2868): Heute, Erfassen, Aufgaben, Zeit, Notizen; iPad 13" (2064 × 2752):
  the full app with a page and the sidebar, split panes, the calendar, the time sheet, the command palette. Taken
  in the simulator with sample notes, light and dark; the same pictures serve both languages.
- **Review notes:** see below.

## App Privacy (the privacy label)

**Data Not Collected.** Apple counts data as collected when it leaves the device so that the developer or a partner
can access it beyond serving the request. Arcalo has no server and no account with us, no analytics, no ads and no
crash upload. Notes go only to the Git repository the user sets up (GitHub, GitLab, Azure DevOps, Gitea), calendar
subscriptions only to their own addresses, and the optional assistant only to the AI provider the user configures,
at the user's direction.

**Export compliance:** answered in the app (`ITSAppUsesNonExemptEncryption` false in `src-tauri/Info.ios.plist`):
only the standard TLS of the system and of rustls; the database encryption of the desktop is not offered on iOS.

**Privacy manifest:** `src-tauri/ios/PrivacyInfo.xcprivacy` (no tracking, no collected data, the reasons for file
dates, the system's uptime, the app's preferences and the free disk space).

## Review notes (English, for App Review)

> Arcalo is a local-first notes, tasks and time tracking app. Everything works without an account: open „Notizen“
> (Notes) or, on iPad, the sidebar, and create pages, tasks and a daily note. The optional Git sync keeps notes in
> step with Arcalo on a desktop through the user's own Git repository (HTTPS with an access token); it is not needed
> for the review. The optional assistant is off until the user adds an AI provider. Background app refresh is used
> only for the Git sync when the user switched on automatic sync. On iPad the app shows the full desktop interface;
> in a narrow window (Slide Over, a third of Split View) it shows the phone interface.

## Privacy policy (for the website)

> Arcalo keeps your notes, tasks, calendar and time bookings on your device. We (MouseWerk) do not receive any of
> it: the app has no server and no account with us, no analytics, no advertising and no crash reports.
>
> The app connects only to services you set up yourself: your Git repository for the sync, the addresses of your
> calendar subscriptions, Jira or SAP if you book time there, and the AI provider you configure for the optional
> assistant. What it sends there is what you asked it to send. Access tokens and keys are kept in the iOS Keychain
> of your device.
>
> Notifications are created on your device. Removing the app deletes all its data from the device; what you synced
> stays in your own repository.
>
> Contact: MouseWerk, Maurice Kleindienst, https://arcalo.mousewerk.de/

## English

**Subtitle** (29 characters): Notes, tasks and time in sync

**Promotional text** (157 characters)

> Markdown notes with links, tasks, daily notes and time tracking. The full desktop app on your iPad, a calm
> companion on your iPhone. No account, no tracking.

**Keywords** (99 characters)

> notes,markdown,tasks,todo,daily note,time tracking,timesheet,git,obsidian,calendar,projects,offline

**Description**

> Arcalo brings your workday into one app: Markdown notes that link to each other, tasks, daily notes, meetings and
> time tracking. It is local-first: your notes live on your device, and nothing leaves it unless you set it up.
>
> ON IPAD: THE FULL APP
> • The same app as on the desktop: the page tree, tabs and split panes, backlinks and the command palette
> • Tasks with due dates and repeats, the task view, daily and weekly notes
> • Calendar subscriptions, meetings with their notes, focus blocks
> • Time tracking with /zeit lines, the timer, the time sheet and projects
> • Drawings with the Apple Pencil, drag and drop of images and files from other apps
> • Keyboard shortcuts with Cmd, trackpad and mouse; Split View, Slide Over and Stage Manager
>
> ON IPHONE: YOUR DAY AT A GLANCE
> • Today: booked time, the running timer, today's meetings and the tasks that are due
> • Quick capture of a note or a task into the daily note or the inbox
> • The daily note, your tasks and all notes to read and edit
> • Bookings with the timer or a /zeit line, shown on the desktop as chips in the daily note
>
> IN SYNC WITH YOUR DESKTOP
> • Arcalo for Windows, macOS and Linux and this app share one Git repository of yours (GitHub, GitLab, Azure
> DevOps, Gitea) over HTTPS with an access token
> • Conflicts are shown and merged, never silently overwritten
> • Syncs in the background when iOS allows
>
> PRIVATE BY DESIGN
> • No account, no telemetry, no ads, no server of ours
> • Tokens and keys in the iOS Keychain
> • An optional assistant on the AI provider you choose; off until you set one up
> • Light, dark and high-contrast themes, English and German
>
> Arcalo is open source (MIT license): https://github.com/MouseWerk/Arcalo

**What's New (first iOS release):** Arcalo is now on iPhone and iPad: the full app on the iPad, the companion
on the iPhone, in sync with the desktop through your Git repository.

## Deutsch

**Untertitel** (29 Zeichen): Notizen, Aufgaben, Zeit, Sync

**Werbetext** (157 Zeichen)

> Markdown-Notizen mit Links, Aufgaben, Tagesnotizen und Zeiterfassung. Die vollständige App auf deinem iPad, ein
> ruhiger Begleiter auf dem iPhone. Ohne Konto.

**Schlüsselwörter** (100 Zeichen)

> notizen,markdown,aufgaben,todo,tagesnotiz,zeiterfassung,stundenzettel,git,obsidian,kalender,projekte

**Beschreibung**

> Arcalo bringt deinen Arbeitstag in eine App: Markdown-Notizen, die aufeinander verlinken, Aufgaben,
> Tagesnotizen, Termine und Zeiterfassung. Arcalo arbeitet lokal: Deine Notizen liegen auf deinem Gerät, und nichts
> verlässt es, solange du es nicht einrichtest.
>
> AUF DEM IPAD: DIE VOLLSTÄNDIGE APP
> • Dieselbe App wie am Desktop: Seitenbaum, Tabs und geteilte Ansichten, Rückverweise und die Befehlspalette
> • Aufgaben mit Fälligkeit und Wiederholung, die Aufgabenansicht, Tages- und Wochennotizen
> • Kalender-Abos, Termine mit ihren Notizen, Fokuszeiten
> • Zeiterfassung mit /zeit-Zeilen, Timer, Stundenzettel und Projekten
> • Zeichnungen mit dem Apple Pencil, Bilder und Dateien per Drag & Drop aus anderen Apps
> • Tastenkürzel mit Cmd, Trackpad und Maus; Split View, Slide Over und Stage Manager
>
> AUF DEM IPHONE: DEIN TAG AUF EINEN BLICK
> • Heute: gebuchte Zeit, der laufende Timer, die Termine des Tages und fällige Aufgaben
> • Schnellerfassung einer Notiz oder Aufgabe in die Tagesnotiz oder den Posteingang
> • Tagesnotiz, Aufgaben und alle Notizen zum Lesen und Bearbeiten
> • Buchungen mit dem Timer oder einer /zeit-Zeile, am Desktop als Chips in der Tagesnotiz
>
> IM ABGLEICH MIT DEINEM DESKTOP
> • Arcalo für Windows, macOS und Linux und diese App teilen ein Git-Repository von dir (GitHub, GitLab, Azure
> DevOps, Gitea) über HTTPS mit Zugangstoken
> • Konflikte werden angezeigt und zusammengeführt, nie still überschrieben
> • Synchronisiert im Hintergrund, wenn iOS es erlaubt
>
> PRIVAT VON GRUND AUF
> • Kein Konto, keine Telemetrie, keine Werbung, kein Server von uns
> • Tokens und Schlüssel im iOS-Schlüsselbund
> • Ein optionaler Assistent beim KI-Anbieter deiner Wahl; aus, bis du einen einrichtest
> • Helles, dunkles und kontrastreiches Design, Deutsch und Englisch
>
> Arcalo ist Open Source (MIT-Lizenz): https://github.com/MouseWerk/Arcalo

**Neuerungen (erste iOS-Version):** Arcalo gibt es jetzt für iPhone und iPad: die vollständige App auf dem iPad,
der Begleiter auf dem iPhone, abgeglichen mit dem Desktop über dein Git-Repository.
