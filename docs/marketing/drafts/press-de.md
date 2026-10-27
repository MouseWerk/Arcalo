# Deutsche Tech-Presse: Themenvorschlag per E-Mail

Status: drafted. Wer handelt: der Owner, von seiner eigenen Adresse (support@mousewerk.de oder privat), einzeln
an jede Redaktion, nicht als Sammelmail und nicht in BCC. Freigabe durch den Owner nötig. Höchstens einmal
nachfassen, frühestens nach zwei Wochen.

## Wege (geprüft 2026-10-27)

| Wo | Weg | Hinweis |
| --- | --- | --- |
| heise (Download-Portal) | Entwicklerkonto, siehe `directories-other.md` | Für die Redaktion (heise online, c't) gibt es Kontaktformulare; ein reines App-Release ist dort selten ein Thema. Erst nach Resonanz (Show HN, Product Hunt) anfragen. |
| t3n | redaktion@t3n.de (Themenvorschläge laut Presseseite), presse@t3n.de für Presseanfragen an t3n | Passt zum Blickwinkel „Arbeiten/Produktivität ohne Cloud“. |
| ComputerBase | News-Tipp-Formular oder redaktion@computerbase.de; Pressemitteilungen nur an presse@computerbase.de | Downloads-Bereich ohne Selbsteintrag. |
| Golem.de | Adresse im Impressum/Kontakt von golem.de prüfen (konnte von hier nicht gelesen werden) | Eher Thema für einen Bericht über Open-Source-Tools; nicht für jedes Release anschreiben. |
| CHIP | keine Einreichung gefunden | siehe `directories-other.md` |

Pressematerial: https://arcalo.mousewerk.de/de/press/ (Texte, Fakten, Logos, Screenshots 1.22.0 hell und dunkel).

## E-Mail (Vorlage, für jede Redaktion anpassen)

Betreff:

```
Themenvorschlag: Arcalo – Open-Source-App für Notizen und Zeiterfassung mit SAP-CATS-Export, ohne Cloud
```

Text:

```
Hallo [Name oder „liebe Redaktion“],

ich bin Maurice Kleindienst aus Kassel und entwickle Arcalo, eine kostenlose Open-Source-Desktop-App (MIT) für
Windows, macOS und Linux. Sie richtet sich an Menschen, deren Arbeitstag aus Besprechungen, Notizen und einem
Stundenzettel besteht, etwa in SAP- und Jira-Projekten.

Was Arcalo von anderen Notiz-Apps unterscheidet:
- Zeit wird direkt in der Notiz gebucht (/zeit 2,5h), der Wochenzettel geht als Datei nach SAP CATS, als
  Jira-Worklogs, CSV oder JSON.
- Termine aus Outlook Classic (ohne Adminrechte und ohne App-Registrierung) und ICS-Kalendern stehen neben der
  gebuchten Zeit; eigene Termine lassen sich in Arcalo anlegen und nach Outlook zurückschreiben.
- Seit Version 1.22 (27. Oktober 2026) öffnen sich Jira-Issues in der App und lassen sich dort bearbeiten.
- Kein Konto, keine Telemetrie, alle Daten in einer lokalen Datenbank, optional verschlüsselt. KI ist optional
  und läuft nur über Anbieter, die man selbst einträgt (z. B. Ollama lokal), oder gar nicht.

Pressematerial mit Screenshots: https://arcalo.mousewerk.de/de/press/
Code und Downloads: https://github.com/MouseWerk/Arcalo

Für einen Test richte ich gern eine Demo-Umgebung ein oder beantworte Fragen. Ehrlich dazu: Der
Windows-Installer ist nicht signiert, die macOS-Version nicht notarisiert.

Viele Grüße
Maurice Kleindienst
Mousewerk, Kassel
[Telefon, falls gewünscht]
```

## Zeitpunkt

Nach Show HN und Product Hunt (ab 18. November 2026), damit es etwas zu berichten gibt, und nicht in der
Woche vor Weihnachten.
