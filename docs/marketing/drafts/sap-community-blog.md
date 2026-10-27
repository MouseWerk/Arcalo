# SAP Community blog: draft (German and English)

Status: drafted, needs the owner's rewrite. Who acts: the owner, with his own SAP Community (SAP Universal ID)
account. Owner approval needed.

## Rules that apply (SAP Community Rules of Engagement, read 2026-10-27,
https://pages.community.sap.com/resources/rules-of-engagement)

- Content must be about SAP products and associated technologies. This post is about CATS time entry; the tool
  is the example, not the topic. Keep it that way when editing.
- "It is prohibited to use external links to market your company or products." So: one link to the GitHub
  repository at the end, stated plainly as "I wrote this tool", no website link, no download buttons, no
  "try it now".
- One blog post at a time in moderation. Publish the English version first; post the German one only after the
  first is through, and only if a German version adds something (SAP Community is mainly English; a German post
  is possible through the language selector, but reaches fewer readers).
- Generative AI: SAP Community has separate "Guidelines for content created with generative AI"; an older page
  says AI-written blogs are rejected. This draft was prepared with AI help, so the owner rewrites it in his own
  words and checks every SAP statement against his own system before submitting.
- Tags: SAP S/4HANA, SAP ERP, "Cross-Application Time Sheet" (CATS) if offered as a managed tag; plus "Project
  System" (PS). Do not use the "SAP Community" tag (reserved for posts about the community itself).

## Images

- `docs/screenshots/time-suggest.png`: `/time` with network and activity autocomplete and remaining plan hours.
- `docs/screenshots/timesheet-dark.png`: the weekly grid per network/activity.
- `docs/screenshots/week-proposal-dark.png`: the week proposal.
- A screenshot of an exported CATS file opened in a text editor (to be made; use the demo data, never real
  personnel numbers).

---

## English

### Title

```
SAP CATS time booking from your notes: a file format walkthrough
```

### Text

```markdown
Most consultants I know book their hours into CATS once a week, on Friday afternoon, from memory and a
calendar. The information was there all week, in meeting notes and to-do lists, just not in a form CATS can
take. This post shows how I approach that gap: booking in the notes as you write, and producing a file that
fits the CATS data structure. I built a small open-source desktop tool for it, but the ideas apply to any
spreadsheet or script.

**1. Book where the work is written down.**
A booking needs four things that a PS consultant already knows: the network, the activity, the activity
type and the hours. In my notes a booking is one line, for example

    /time NP-8801/1020 2.5h #DEV System integration

which means network NP-8801, activity 1020, activity type DEV, 2.5 hours, short text "System integration".
Writing it next to the meeting note means the short text is already there and the date is the day of the
note.

**2. Use the CATS field names.**
The export writes one row per booking with field names from the CATS database table CATSDB:

| Field | Meaning |
|---|---|
| PERNR | personnel number |
| WORKDATE | date, YYYYMMDD |
| RPROJ | WBS element (optional) |
| RNPLNR | network |
| VORNR | activity |
| LSTAR | activity type |
| CATSHOURS | hours |
| MEINH | unit (H) |
| LTXA1 | short text, at most 40 characters |

Separator (semicolon, comma or tab), column order and the decimal separator are settings, because every
upload report I have seen expects something slightly different. LTXA1 is cut to 40 characters, since longer
texts are rejected or silently truncated.

**3. Make the hours add up per day.**
Three bookings of 20 minutes on one day are one hour. Rounded one by one they become 0.33 + 0.33 + 0.33 =
0.99 h, and the daily total in CATS is off. The export rounds the running total of each day and writes the
difference, so the rows become 0.33 + 0.34 + 0.33 = 1.00.

**4. Get it into SAP the way your system allows.**
How a file gets into CATS depends on your landscape. Many companies have their own upload report, often built
on BAPI_CATIMESHEETMGR_INSERT, or an LSMW object; ask your SAP team which columns it expects and set the
export to match. Where there is no upload at all, a clipboard copy of the week (network, activity, activity
type and hours per day) can be pasted into the CATS entry grid. Nothing is sent to SAP automatically; you
always see the data before it goes in.

**5. Let the week propose itself, then check it.**
Meetings from the calendar, focus sessions and the pages you edited can be turned into a draft timesheet for
the week. Each line says where it comes from and how sure the tool is about the activity; an activity you
correct is remembered for that meeting series. Nothing is booked without your confirmation.

The tool I use for this is Arcalo, a local-first desktop app I wrote (MIT licensed, no account, data stays on
your computer). The code, including the CATS exporter, is here: https://github.com/MouseWerk/Arcalo

I'm interested in how others handle the Friday CATS session, and which upload formats your systems expect.
```

---

## Deutsch

### Titel

```
SAP-CATS-Zeiten aus den eigenen Notizen buchen: das Dateiformat Schritt für Schritt
```

### Text

```markdown
Die meisten Beraterinnen und Berater, die ich kenne, buchen ihre Stunden einmal pro Woche in CATS, am
Freitagnachmittag, aus dem Gedächtnis und dem Kalender. Die Informationen waren die ganze Woche da, in
Besprechungsnotizen und Aufgabenlisten, nur nicht in einer Form, die CATS annimmt. Hier zeige ich, wie ich
diese Lücke schließe: buchen, während du schreibst, und eine Datei erzeugen, die zur CATS-Datenstruktur passt.
Ich habe dafür ein kleines Open-Source-Desktop-Tool gebaut, die Ideen funktionieren aber auch mit einer
Tabelle oder einem Skript.

**1. Dort buchen, wo die Arbeit aufgeschrieben wird.**
Eine Buchung braucht vier Dinge, die du als PS-Berater ohnehin kennst: Netzplan, Vorgang, Leistungsart und
Stunden. In meinen Notizen ist eine Buchung eine Zeile, zum Beispiel

    /zeit NP-8801/1020 2,5h #DEV Systemintegration

also Netzplan NP-8801, Vorgang 1020, Leistungsart DEV, 2,5 Stunden, Kurztext „Systemintegration“. Steht die
Zeile neben der Besprechungsnotiz, ist der Kurztext schon da und das Datum ist der Tag der Notiz.

**2. Die CATS-Feldnamen verwenden.**
Der Export schreibt eine Zeile pro Buchung mit den Feldnamen der CATS-Tabelle CATSDB:

| Feld | Bedeutung |
|---|---|
| PERNR | Personalnummer |
| WORKDATE | Datum, JJJJMMTT |
| RPROJ | PSP-Element (optional) |
| RNPLNR | Netzplan |
| VORNR | Vorgang |
| LSTAR | Leistungsart |
| CATSHOURS | Stunden |
| MEINH | Einheit (H) |
| LTXA1 | Kurztext, höchstens 40 Zeichen |

Trennzeichen (Semikolon, Komma oder Tab), Spaltenreihenfolge und Dezimaltrennzeichen sind einstellbar, weil
jeder Upload-Report, den ich gesehen habe, etwas anderes erwartet. LTXA1 wird auf 40 Zeichen gekürzt, da
längere Texte abgelehnt oder stillschweigend abgeschnitten werden.

**3. Die Stunden pro Tag aufgehen lassen.**
Drei Buchungen à 20 Minuten an einem Tag sind eine Stunde. Einzeln gerundet werden daraus 0,33 + 0,33 + 0,33
= 0,99 h, und die Tagessumme in CATS stimmt nicht. Der Export rundet deshalb die laufende Summe des Tages und
schreibt die Differenz: 0,33 + 0,34 + 0,33 = 1,00.

**4. So nach SAP bringen, wie dein System es erlaubt.**
Wie eine Datei in CATS kommt, hängt von deiner Systemlandschaft ab. Viele Unternehmen haben einen eigenen
Upload-Report, oft auf Basis von BAPI_CATIMESHEETMGR_INSERT, oder ein LSMW-Objekt; frag dein SAP-Team, welche
Spalten es erwartet, und stell den Export passend ein. Gibt es keinen Upload, kannst du eine
Zwischenablage-Kopie der Woche (Netzplan, Vorgang, Leistungsart und Stunden pro Tag) in das
CATS-Erfassungsraster einfügen. Nichts geht automatisch an SAP; du siehst die Daten immer, bevor sie
hineingehen.

**5. Die Woche vorschlagen lassen und dann prüfen.**
Termine aus dem Kalender, Fokuszeiten und die Seiten, die du bearbeitet hast, werden zu einem Entwurf des
Wochenzettels. Jede Zeile sagt, woher sie kommt und wie sicher das Tool beim Vorgang ist; einen Vorgang, den
du korrigierst, merkt es sich für diese Terminserie. Gebucht wird nur, was du bestätigst.

Das Tool, das ich dafür nutze, ist Arcalo, eine Local-first-Desktop-App, die ich geschrieben habe
(MIT-Lizenz, kein Konto, die Daten bleiben auf deinem Rechner). Der Code, auch der CATS-Export, liegt hier:
https://github.com/MouseWerk/Arcalo

Mich interessiert, wie ihr den Freitag mit CATS löst und welche Upload-Formate eure Systeme erwarten.
```

## Before submitting (owner)

- Check in your own SAP system: the field names, that LTXA1 is 40 characters, and how your upload report or
  the CATS entry screen takes the clipboard copy. Remove any sentence you cannot confirm.
- Use demo data only in screenshots (the demo workspace's NP-8801), never a real personnel number.
