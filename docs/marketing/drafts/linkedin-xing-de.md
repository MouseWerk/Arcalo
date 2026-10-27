# LinkedIn und XING: Entwürfe (Deutsch)

Status: drafted. Wer handelt: der Owner, auf seinem eigenen LinkedIn- und XING-Profil, von Hand. Freigabe durch
den Owner nötig.

## Regeln

- Eigene Profile, eigene Stimme. Keine gekauften Reichweiten, keine Engagement-Gruppen ("Pods"), keine
  Massennachrichten an Kontakte, keine automatisierten Posts.
- LinkedIn zeigt Beiträge mit externem Link weniger an. Deshalb: Link in den ersten Kommentar, nicht in den
  Text (oder den Link im Text lassen und das in Kauf nehmen; beides ist erlaubt).
- Eine Variante pro Woche, nicht alle drei auf einmal. Gleichen Text nicht in Gruppen kopieren.
- Nichts behaupten, was die App nicht kann; keine Zahlen zu Nutzern oder Downloads, die nicht stimmen.

## Variante 1: der Freitag mit CATS (Problem zuerst)

Bild: `docs/marketing/x-assets/thumb-2-time.png` (1600 x 900). Der erste Absatz ist persönlich: nur so posten,
wenn er für dich stimmt, sonst anpassen.

```
Freitag, 16 Uhr. Die Stunden müssen ins CATS, und was war eigentlich am Dienstag?

Ich habe meine Woche lange aus Kalender, Notizen und Gedächtnis zusammengesucht. Deshalb habe ich Arcalo
gebaut: eine Desktop-App, in der Notizen, Aufgaben, Termine und Zeiterfassung zusammenliegen.

So sieht das aus:
• Du schreibst in der Besprechungsnotiz /zeit NP-8801/1020 2,5h #DEV Abstimmung, und die Zeit ist gebucht.
• „Woche vorschlagen“ macht aus Terminen, Fokuszeiten und bearbeiteten Seiten einen Entwurf, den du prüfst.
• Der Wochenzettel geht als Datei nach SAP CATS, als Jira-Worklogs, CSV oder JSON.

Alles liegt lokal auf deinem Rechner, ohne Konto und ohne Telemetrie. Kostenlos und Open Source (MIT), für
Windows, macOS und Linux.

Wie löst du den Freitag? Ich freue mich über Rückmeldungen, gerade von SAP- und Jira-Beratern.

#SAP #CATS #Zeiterfassung #Jira #OpenSource
```

Erster Kommentar: `Download und Code: https://github.com/MouseWerk/Arcalo · Website: https://arcalo.mousewerk.de/de/`

## Variante 2: Jira-Issues in der App (Release 1.22)

Bild: `docs/screenshots/jira-issues-dark.png` (später durch einen Screenshot des neuen Issue-Fensters ersetzen).

```
Neu in Arcalo 1.22: Jira-Issues öffnen sich direkt in der App.

Du klickst in einer Notiz auf PROJ-123 und siehst das Issue so, wie Jira es zeigt: Beschreibung, alle Felder,
Unteraufgaben, verknüpfte Issues, Anhänge, Kommentare, Work Log und Verlauf.

Und du kannst dort arbeiten:
• Felder, Zusammenfassung und Beschreibung ändern
• den Status wechseln, mit den Feldern, die der Schritt verlangt
• kommentieren, Zeit loggen und „Mir zuweisen“

Jede Änderung lässt sich rückgängig machen. Hat jemand das Issue inzwischen geändert, zeigt Arcalo beide Stände
und überschreibt nichts. Ohne Verbindung siehst du die letzte Kopie.

Funktioniert mit Jira Cloud und Jira Server / Data Center. Arcalo ist kostenlos, Open Source und speichert
alles lokal.

#Jira #Atlassian #Projektmanagement #OpenSource #Produktivität
```

Erster Kommentar: `Release-Notes: https://github.com/MouseWerk/Arcalo/releases/tag/v1.22.0`

## Variante 3: KI, aber auf deinen Bedingungen (Datenschutz-Blick)

Bild: `docs/marketing/x-assets/thumb-3-ai.png`.

```
Viele Unternehmen wollen KI nutzen, aber nicht jede Kundennotiz in eine fremde Cloud schicken.

In Arcalo, meiner Open-Source-App für Notizen, Aufgaben, Termine und Zeiterfassung, entscheidest du das selbst:
• Der Assistent nutzt nur die Anbieter, die du einträgst: Ollama lokal, euren LiteLLM-Proxy, Azure OpenAI
  oder einen OpenAI-kompatiblen Endpunkt.
• Notizen mit #privat gehen nur an ein Modell, das du als lokal markiert hast.
• Mit „KI verwenden“ aus sendet Arcalo gar nichts an einen KI-Dienst.
• Sprachnotizen werden auf deinem Rechner transkribiert.

Dazu: kein Konto, keine Telemetrie, eine Datenbank auf deinem Rechner, optional verschlüsselt. Proxy, PAC und
eigene Root-Zertifikate für Firmennetze sind eingebaut.

Wie geht ihr im Team mit KI und vertraulichen Notizen um?

#KI #Datenschutz #LocalFirst #OpenSource #Beratung
```

Erster Kommentar: `https://arcalo.mousewerk.de/de/`

## XING

XING zeigt Beiträge im eigenen Profil-Feed. Variante 1 passt dort am besten (Zielgruppe SAP-Berater in DACH).
Text von Variante 1 übernehmen, Hashtags auf drei kürzen (`#SAP #Zeiterfassung #OpenSource`), Link direkt in
den Text, Bild `thumb-2-time.png`. Nicht in XING-Gruppen posten, außer eine Gruppe erlaubt Tool-Vorstellungen
ausdrücklich (vorher die Gruppenregeln lesen).

## Zeitplan

- Variante 2: Mittwoch, 28. Oktober 2026, 8:30 Uhr (Release-Nachricht, solange 1.22 neu ist).
- Variante 1: Dienstag, 10. November 2026, 8:30 Uhr; XING am selben Tag.
- Variante 3: Dienstag, 24. November 2026, 8:30 Uhr.
