# Website draft: Jira → Issue-Ansicht

Text for the Jira page of the website docs (MouseWerk/annaloweb), to be placed there once the round that edits
the website now is merged. German first (the site's main language), English below. Screenshots to use:
`e2e/screenshots/146-issue-view-light.png`, `146-issue-view-dark.png`, `146-issue-view-transition.png`,
`153-issue-view-phone.png` (after a CI run of the branch; the run's artifact „e2e-screenshots“).

---

## Issue-Ansicht

Ein Klick auf ein Issue zeigt es vollständig, so wie Jira es zeigt, in einem Fenster über Arcalo. Du musst
Jira dafür nicht öffnen, und du bleibst, wo du warst: Esc schließt die Ansicht wieder.

### Öffnen

- **In einer Notiz:** Klick auf den Issue-Chip (`PROJ-123`). Strg+Klick (Mac: Cmd+Klick) öffnet das Issue im
  Browser.
- **In der Issue-Liste:** „Als Fenster öffnen“ in der Zeile oder im Kontextmenü, Doppelklick oder Umschalt+Eingabe.
  Ein Klick auf die Zeile klappt wie bisher die Kurzansicht auf; dort führt „Vollansicht“ in die Issue-Ansicht.
- **Auf der Startseite:** Klick auf ein Issue in den Jira-Widgets oder auf eine Jira-Fälligkeit. Das Kontextmenü
  hat „Im Browser öffnen“, „Notiz öffnen“ und „Schlüssel kopieren“.
- **Befehlspalette (Strg+K):** einen Schlüssel oder eine Jira-Adresse eintippen, oder „Issue öffnen…“ wählen und
  nach Schlüssel oder Titel suchen.
- Außerdem aus dem Briefing, den Fokusblöcken im Kalender, dem Issue-Schlüssel einer Buchung in der Zeiterfassung,
  Canvas-Karten und der Schnellsuche.

Verknüpfte Issues und Unteraufgaben öffnen sich in der Ansicht darüber; „Zurück“ führt zum vorigen Issue.

### Was du siehst

- **Kopf:** Projekt, übergeordnetes Issue oder Epic, Typ, Schlüssel, Titel und Status.
- **Beschreibung** so formatiert wie in Jira: Überschriften, Listen, Tabellen, Code, Panels, Zitate, Erwähnungen,
  Links und Bilder. Bilder und Anhänge lädt Arcalo mit deiner Jira-Anmeldung; sie steht nie in einer Adresse.
- **Details:** Bearbeiter und Autor mit Bild, Priorität, Labels, Komponenten, Versionen, Sprint, Story Points,
  Fälligkeit, Zeiterfassung (Schätzung, protokolliert, verbleibend als Balken), Erstellt, Geändert, Erledigt und
  jedes ausgefüllte eigene Feld unter seinem Namen aus Jira.
- **Inhalt:** Unteraufgaben mit Status, verknüpfte Issues nach Art der Verknüpfung, Anhänge als Vorschaubilder (zum
  Öffnen und Speichern) und Links (etwa Pull Requests).
- **Aktivität:** Kommentare (neueste oder älteste zuerst), Arbeitsprotokoll und Verlauf (welches Feld von was nach
  was). Bei vielen Einträgen lädt „Ältere laden“ weitere.
- **In Arcalo:** worauf du mit dem Issue buchst, wie viel schon gebucht ist, die Notiz zum Issue und „Als Aufgabe
  übernehmen“.

### Bearbeiten

Was Jira dir zu ändern erlaubt, ist zum Bearbeiten markiert (der Stift beim Überfahren); alles andere bleibt
nur lesbar, genau wie in Jira.

- **Titel:** draufklicken oder `e` drücken, Eingabe speichert.
- **Felder:** draufklicken; je nach Feld eine Auswahl, eine Personensuche, Labels, ein Datum oder eine Zahl.
  „Speichern“ oder Eingabe speichert, Esc bricht ab.
- **Beschreibung und Kommentare** mit Formatierung (fett, kursiv, Code, Links, Listen, Zitate, Codeblöcke).
  Strg+Eingabe speichert. Was der Editor nicht bearbeiten kann (zum Beispiel ein ausklappbarer Bereich oder ein
  Makro), bleibt unverändert erhalten.
- **Status:** über den Status oben oder `t`. Verlangt Jira beim Wechsel Angaben (etwa eine Lösung), fragt Arcalo
  sie ab; Pflichtfelder sind markiert.
- **Kommentare:** `c` springt ins Kommentarfeld. Eigene Kommentare kannst du bearbeiten und löschen.
- **Arbeit protokollieren:** Aufwand (`1h 30m`, `45m`, `2d`), Beginn und was gemacht wurde. Mit „Auch in der
  Zeiterfassung buchen“ entsteht dazu eine Buchung auf dem Netzplan/Vorgang des Issues; überträgt die Site Buchungen
  ohnehin nach Jira, entsteht trotzdem nur ein Eintrag im Arbeitsprotokoll.
- **Mir zuweisen** oben, wenn das Issue jemand anderem gehört.

Nach jeder Änderung bietet die Meldung „Rückgängig“ an, wo Jira es zulässt (auch für einen Statuswechsel, wenn
es den Weg zurück gibt).

### Wenn jemand anderes gleichzeitig ändert

Vor dem Speichern prüft Arcalo, ob das Issue seit dem Laden in Jira geändert wurde. Dann wird nichts überschrieben:
Du siehst, wer es geändert hat und was jetzt in Jira steht, und wählst „Neuen Stand zeigen“ oder „Meine Änderung
trotzdem speichern“.

### Ohne Verbindung

Ein Issue, das du schon einmal geöffnet hast, zeigt Arcalo auch offline, mit „Stand von …“ und nur zum Lesen.
Sobald Jira wieder erreichbar ist, holt „Erneut versuchen“ den aktuellen Stand.

### Tastenkürzel

| Taste | Wirkung |
|---|---|
| `e` | Titel bearbeiten |
| `c` | Kommentar schreiben |
| `t` | Status ändern |
| Strg+Eingabe | Beschreibung oder Kommentar speichern |
| Esc | Bearbeitung abbrechen, sonst die Ansicht schließen |
| Tab | durch die Ansicht gehen (der Fokus bleibt darin) |

### Auf dem Handy

In der vollständigen App auf dem Handy (Einstellungen → Darstellung → „Oberfläche auf Android“: „Vollständig“) öffnet sich die Issue-Ansicht bildschirmfüllend;
die Details stehen unter der Beschreibung.

### Jira Cloud und Jira Server/Data Center

Beides funktioniert gleich. Cloud speichert Texte im Atlassian Document Format, Server/Data Center als Wiki-Markup;
Arcalo schreibt jeweils das passende Format.

### Grenzen

- Den Sprint eines Issues änderst du auf dem Board in Jira, nicht in Arcalo.
- Textfarben in Beschreibungen zeigt Arcalo nicht; wer eine solche Beschreibung bearbeitet, wird vor dem Speichern
  darauf hingewiesen, dass die Farbe entfällt.
- Neue Anhänge und neue Verknüpfungen legst du in Jira an.

---

## Issue view

A click on an issue shows all of it, as Jira does, in a window over Arcalo. You do not need to open Jira, and you
stay where you were: Esc closes the view.

### Opening it

- **In a note:** click the issue chip (`PROJ-123`). Ctrl+click (Mac: Cmd+click) opens the issue in the browser.
- **In the Issues list:** “Open as window” on the row or in its context menu, a double click or Shift+Enter. A click
  on the row still opens the short view; its “Full view” leads to the issue view.
- **On the start page:** click an issue in the Jira widgets or a Jira due date. The context menu has “Open in
  browser”, “Open note” and “Copy key”.
- **Command palette (Ctrl+K):** type a key or a Jira address, or choose “Open issue…” and search by key or summary.
- Also from the briefing, focus blocks in the calendar, the issue key of a time entry, canvas cards and the quick search.

Linked issues and subtasks open on top; “Back” returns to the issue before.

### What you see

- **Header:** project, parent issue or epic, type, key, summary and status.
- **Description** formatted as in Jira: headings, lists, tables, code, panels, quotes, mentions, links and images.
  Images and attachments are loaded with your Jira login; it is never part of an address.
- **Details:** assignee and reporter with their pictures, priority, labels, components, versions, sprint, story
  points, due date, time tracking (estimate, logged and remaining as a bar), created, updated, resolved, and every
  custom field with a value under its name in Jira.
- **Content:** subtasks with their status, linked issues by link type, attachments as thumbnails (to open and save)
  and links (such as pull requests).
- **Activity:** comments (newest or oldest first), work log and history (which field changed from what to what).
  With many entries, “Load older” loads more.
- **In Arcalo:** where bookings with the issue go, how much is booked, the issue's note and “Add as task”.

### Editing

What Jira lets you change is marked for editing (the pencil on hover); everything else stays read only, just as
in Jira.

- **Summary:** click it or press `e`; Enter saves.
- **Fields:** click them; depending on the field a choice, a people search, labels, a date or a number. “Save” or
  Enter saves, Esc cancels.
- **Description and comments** with formatting (bold, italic, code, links, lists, quotes, code blocks). Ctrl+Enter
  saves. What the editor cannot edit (an expand or a macro, for example) is kept as it is.
- **Status:** with the status at the top or `t`. If Jira asks for something on the way (a resolution, for
  example), Arcalo asks for it; required fields are marked.
- **Comments:** `c` jumps to the comment box. You can edit and delete your own comments.
- **Log work:** time spent (`1h 30m`, `45m`, `2d`), start and what was done. With “Also book in time tracking” a time
  entry on the issue's network and activity is made too; if the site sends bookings to Jira anyway, the work log
  still gets only one entry.
- **Assign to me** at the top when the issue belongs to someone else.

After every change the message offers “Undo” where Jira allows it (a status change too, when there is a way back).

### When someone else changes it at the same time

Before saving, Arcalo checks whether the issue changed in Jira since it was loaded. Then nothing is overwritten:
you see who changed it and what Jira has now, and choose “Show the new state” or “Save mine anyway”.

### Without a connection

An issue you opened before is shown offline too, with “As of …” and read only. Once Jira can be reached again,
“Try again” loads the current state.

### Shortcuts

| Key | What it does |
|---|---|
| `e` | Edit the summary |
| `c` | Write a comment |
| `t` | Change the status |
| Ctrl+Enter | Save the description or comment |
| Esc | Cancel the edit, else close the view |
| Tab | Move through the view (the focus stays in it) |

### On a phone

In the full app on a phone (Settings → Appearance → “Interface on Android”: “Full”) the issue view fills the screen; the details follow
the description.

### Jira Cloud and Jira Server/Data Center

Both work the same. Cloud stores texts in the Atlassian Document Format, Server/Data Center as wiki markup; Arcalo
writes the right format for each.

### Limits

- The sprint of an issue is changed on the board in Jira, not in Arcalo.
- Arcalo does not show text colors in descriptions; editing such a description says before saving that the color
  is dropped.
- New attachments and new links are added in Jira.
