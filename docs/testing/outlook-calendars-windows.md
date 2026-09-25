# Outlook calendar selection: manual check on Windows

The e2e tests replace the Outlook script with a fixture. This list checks the script against a
real Outlook Classic (Microsoft 365 or Exchange, cached mode on and off) before a release.
Keep Einstellungen → Protokoll open with „Ausführliches Protokoll“ on; every step should leave no
error there except the ones expected below.

## Setup

- Windows 10 or 11, Outlook Classic signed in, Annalo 1.6 installed (not as administrator).
- A test profile with: your mailbox with a sub-calendar („Projekt X“ under Kalender), a second
  mailbox, a PST file with a calendar, a colleague's calendar shared with full details, a
  colleague who shares only free/busy, a room mailbox, optionally a Microsoft 365 group.
- Start with a data folder of 1.5 in which the default calendar was synced and at least one
  meeting is booked, has a meeting note and one is marked „nicht buchen“.

## Upgrade

1. Start 1.6 on the 1.5 data folder. Einstellungen → Kalender: „Outlook-Kalender lesen“ is on,
   the default calendar is ticked with its old color. The Kalender shows the booked meeting with
   its check mark, the meeting note opens, „nicht buchen“ is still set, „Zeit buchen“ suggests
   the Vorgang of last time.

## Discovery

2. „Kalender suchen“ (runs by itself on the first visit). Within about a minute the list shows:
   - „Kalender“ with the badge „Standard“ and your address; „Projekt X“ below it.
   - The second mailbox (badge „Postfach“, or no badge if it is a second account of yours).
   - The PST calendar (badge „Datei“, owner = the PST's display name).
   - The colleague's calendar from „Freigegebene Kalender“/„Shared Calendars“ (badge
     „Freigegeben“, owner = the colleague).
   - The free/busy-only colleague (badges „Freigegeben“ and „nur Frei/Gebucht“).
   - The room (badge „Raum“) and the group (badge „Gruppe“) if they are in the navigation pane.
3. No Outlook window appears; if Outlook shows „Ein Programm versucht, auf
   E-Mail-Adressinformationen zuzugreifen“, allow it and search again.
4. Close Outlook completely and search again: Outlook starts in the background, the list is the
   same.
5. „Kalender einer Person öffnen“ with the colleague's address who is not in the navigation
   pane: the calendar appears; with a made-up name the row says the address book does not know
   it.

## Selection and sync

6. Tick „Projekt X“, the colleague's calendar and the room. Each row shows „n Termine ·
   synchronisiert …“ after a few seconds; the numbers match what Outlook shows for the next 90
   days. The Outlook status row says „4 Kalender · … Termine“.
7. Change a color with the swatch. The Kalender shows the new color at once.
8. Tick the free/busy-only colleague: the row syncs, the Kalender shows blocks titled
   „Beschäftigt“, „Mit Vorbehalt“ or „Abwesend“, the detail says „Nur Frei/Gebucht freigegeben“.
9. Ask a colleague to remove your permission (or pick a calendar you cannot open): its row shows
   „Kein Zugriff auf diesen Kalender …“, every other row still syncs, the Kalender banner names
   the calendar.
10. A meeting you and the colleague attend appears once, in your default calendar's color; its
    detail says „Auch in: <Kollegin> – Kalender“.

## Booking proposals and the rest

11. „Woche vorschlagen“ for last week: meetings from your own calendars are proposed, meetings
    that are only in the colleague's calendar are not. Switch „Buchungsvorschläge“ on for the
    colleague's calendar: they are proposed; switch it off again.
12. Tagesrückblick of a day with a colleague-only meeting: it is not listed (booking proposals
    off).
13. During a meeting in the colleague's calendar only, open the quick capture: no „Jetzt:“ offer.
    During one of your own meetings: „Jetzt: …“ is offered.
14. Legend in the Kalender: hide the room; its meetings disappear in the Kalender and in the
    start page's „Termine“, the settings still show it ticked and it keeps syncing. Show it again.

## Regional formats and restart

15. Switch Windows to English (United States) date and time formats, restart Annalo, sync all:
    the same numbers of appointments.
16. Restart Annalo: the selection, colors and „Buchungsvorschläge“ switches are kept; the list
    shows the stored calendars until „Kalender suchen“ runs again.
