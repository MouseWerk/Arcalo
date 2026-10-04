# Arcalo 1.11 – Übersetzungsprüfung: die 30 wichtigsten Korrekturen

Umfang der Durchsicht: alle 5 508 Schlüssel in de.ts (und en.ts), alle 1 069 tr!/trf!-Paare in
crates/ und src-tauri/ (Fehlermeldungen, Benachrichtigungen, Tray, Menüs, erzeugte Seiten,
KI-Anweisungen) und die Release-Highlights. Geändert: 262 deutsche und 61 englische
Katalogtexte, 47 deutsche und 25 englische Rust-Texte, 2 Highlight-Texte.

Entscheidung Anrede: **du** (Mehrheit in de.ts; 31 Texte in Sicherheit, Updates, Zugangsdaten
und Mail-Einstellungen sagten „Sie“).

| # | Schlüssel / Ort | Vorher | Nachher | Warum |
|---|---|---|---|---|
| 1 | lock.sub | Geben Sie Ihre PIN ein, um fortzufahren. | Gib deine PIN ein, um fortzufahren. | Anrede (einheitlich „du“, 31 Texte) |
| 2 | sec.key.text, sec.lock.desc, sec.db.* | Sichern Sie diesen Schlüssel jetzt … / bis Sie die PIN eingeben … mit Ihren Notizen | Sichere diesen Schlüssel jetzt … / bis du die PIN eingibst … mit deinen Notizen | Anrede |
| 3 | upd.rollbackWarning, upd.policyOff, updates.rs | Alles, was Sie seit dem Update geändert haben … / Updates sind von Ihrer Organisation abgeschaltet | Alles, was du seit dem Update geändert hast … / Deine Organisation hat Updates abgeschaltet | Anrede |
| 4 | error.rs (IsADirectory) | Ein Ordner wurde erwartet, eine Datei gefunden | Eine Datei wurde erwartet, aber es ist ein Ordner | Bedeutung war vertauscht (EN: a file was expected) |
| 5 | slash.ai | KI bearbeiten | Mit KI bearbeiten | Sinnfehler (bearbeitet wird der Text, nicht die KI) |
| 6 | briefing.rs, meetwork/prep.rs, Highlights 1.9 | 3 Vorgänge in Jira / Keine passenden Vorgänge. / Jira-Vorgänge | 3 Issues in Jira / Keine passenden Issues. / Jira-Issues | Begriff 1.11: Jira = Issue, Vorgang = SAP |
| 7 | time.keptOnDelete | {n} exportierter bzw. laufender bleibt erhalten. | {n} exportierter oder laufender Eintrag bleibt erhalten. | Substantiv fehlte |
| 8 | secrets.moved | {n} Zugangsdatum aus secrets.json … übernommen | {n} Eintrag mit Zugangsdaten aus secrets.json … übernommen | „Zugangsdatum“ ist kein Singular von „Zugangsdaten“ |
| 9 | coll.err.noOption (other) | {names} sind keine Option | {names} sind keine Optionen | Numerus |
| 10 | review.upcoming | {n} steht an | {n} anstehend | Kongruenz bei n > 1 |
| 11 | links.count, bm.done, set.git.deleteText u. a. (42 Texte) | {n} Einträge (auch bei 1) | { one: „{n} Eintrag“, other: „{n} Einträge“ } | Pluralformen, wo eine Zahl steht |
| 12 | net.caCount | {n} Zertifikat(e) | 1 Zertifikat / {n} Zertifikate | Plural statt Klammer-Notbehelf |
| 13 | cmd.localGraphSub | Die aktive Seite und ihre Nachbarn in der Seitenleiste | … im Seitenpanel | Falscher Ort (Seitenleiste = links) |
| 14 | set.editor.linkSuggestionsDesc | Zeigt im Seitenbereich „Links“ … | Zeigt im Seitenpanel „Verknüpfungen“ … | Name des Panels wie in der Oberfläche |
| 15 | 24 Backend-Meldungen | … unter Einstellungen → KI | … unter Einstellungen → KI & Modelle | Abschnitt heißt wie im Einstellungsmenü |
| 16 | aitext.*.prompt (7 Anweisungen) | Verbessere den Text: … gleicher Inhalt, ähnliche Länge. | … Behalte die Sprache des Textes bei. | Deutsche Anweisung übersetzte englische Texte ungewollt (EN hatte den Satz) |
| 17 | olcal.peopleHint | … einer Kollegin oder eines Kollegen, die ihren Kalender freigegeben haben (nicht im Navigationsbereich …) | … einer Person, die dir ihren Kalender freigegeben hat (wenn er nicht im Navigationsbereich von Outlook steht) | Grammatik (Numerus, Bezug) |
| 18 | bm.desc.target | Ordner werden Gruppen, Links der Lesezeichenleiste einzelne Links. | Ordner werden zu Gruppen, Links der Lesezeichenleiste zu einzelnen Links. | Grammatik |
| 19 | set.git.remoteDesc | HTTPS mit Zugangstoken, oder SSH … bzw. den SSH-Agent des Systems | HTTPS mit Zugangstoken oder SSH … bzw. den SSH-Agenten des Systems | Komma vor „oder“; schwache Deklination |
| 20 | set.ai.streamingDesc, mailset.privateDesc, gitsync.rs, recovery.rs u. a. | Aus: die Antwort erscheint erst … | Aus: Die Antwort erscheint erst … | Großschreibung nach Doppelpunkt vor ganzem Satz |
| 21 | bm.role.menu, bm.fileDrop, calv.settings, work.w.team, net.useDefault, weekplan.rs | Lesezeichen-Menü, Lesezeichen-Datei, Kalender-Einstellungen, Team-Verfügbarkeit, Standard-Profil, Fokus-Sitzung | Lesezeichenmenü, Lesezeichendatei, Kalendereinstellungen, Teamverfügbarkeit, Standardprofil, Fokussitzung | Zusammenschreibung |
| 22 | notifyact.rs, tb.statsDetail, fr.sum.rounding | 10 Min / 1 Std / Lesezeit {minutes} min | 10 Min. / 1 Std. / Lesezeit {minutes} Min. | Abkürzungen mit Punkt |
| 23 | coll.clickSorts, draw.*, file.clickOpen, resizer.title (8 Texte) | Klicken sortiert / {name} – klicken zum Öffnen | Zum Sortieren klicken / {name} – zum Öffnen klicken | Natürliche Wortstellung |
| 24 | brief.s.ai (+ KI-Anweisung) | Was ist heute wichtig | Was heute wichtig ist | Überschrift als Aussage, nicht als Frage ohne Fragezeichen |
| 25 | tb.sortAz / tb.sortZa | Zeilen sortieren A–Z | Zeilen A–Z sortieren | Wortstellung (Menüpunkt) |
| 26 | fl.test.stays | Keine Regel und keine Art passt | Keine Regel und keine Art passen | Kongruenz |
| 27 | settings.noHits | Nichts weiter gefunden für „{query}“. | Keine weiteren Treffer für „{query}“. | Natürliche UI-Sprache |
| 28 | dash.set.unpin, chat.unpin | „{title}“ lösen / Lösen | „{title}“ nicht mehr anheften / Nicht mehr anheften | Gegenstück zu „Anheften“ |
| 29 | voice.set.modelDesc, voice.set.recDesc, brief.whenDesc, assist.tool.search, fr.s.notes.text | Backups und Git-Sync / Tray-Symbol / das Tray / Workspace durchsuchen / Backlinks | Sicherungen und Git-Synchronisierung / Symbol im Infobereich / den Infobereich / Arbeitsbereich durchsuchen / Rückverweise | Glossar |
| 30 | en.ts, Rust EN | Day review (7×), network plan (6×), Dashboard, Away, Capture e-mail, Email, „Settings → AI“ | Daily review, network, Start page, Out of office, Take over e-mail, E-mail, „Settings → AI & models“ | Englische Begriffe vereinheitlicht |

Weitere Beispiele: fr.lang.title „Welche Sprache sprichst du?“ → „Welche Sprache möchtest du
verwenden?“; jira.col.reporter „Melder“ → „Autor“ (Jira-Begriff); mw.sr.custom „Frei“ →
„Eigener Zeitraum“; time.print/pv.print „… / als PDF“ → „… / als PDF speichern“;
tasks.prioHighLabel „Priorität hoch“ → „Hohe Priorität“; demo „## Beschlüsse“ →
„## Entscheidungen“ (wie die Besprechungsvorlage).
