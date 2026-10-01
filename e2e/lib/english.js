// The app in English: a workspace whose settings say English before the first real start (so
// the demo is seeded in English), and a check for German words left in what the window shows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "./harness.js";

/**
 * Starts the app on a fresh workspace set to English, with the English demo. The data folder is
 * returned so the caller removes it.
 */
export async function launchEnglish(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "annalo-e2e-en-"));
  const env = { ANNALO_LOCALE: "en-US", ...(opts.env ?? {}) };
  // First start without the demo: only to store the language.
  let app = await launch({ demo: false, dataDir, env });
  const view = await app.invoke("settings_get");
  await app.invoke("settings_save", { settings: { ...view.settings, locale: { ...view.settings.locale, language: "en" } } });
  await app.close();
  app = await launch({ demo: true, dataDir, env, ...opts });
  return { app, dataDir };
}

/**
 * German words that do not occur in English UI text. Matched as whole words, case-sensitive;
 * any ä ö ü ß is reported as well.
 */
const GERMAN = [
  "Einstellungen", "Seite", "Seiten", "Unterseite", "Aufgabe", "Aufgaben", "Zeiterfassung", "Projekte", "Kalender",
  "Speichern", "Abbrechen", "Löschen", "Heute", "Gestern", "Morgen", "Woche", "Notiz", "Notizen", "Suche", "Suchen",
  "Anbieter", "Modell", "Eigenschaft", "Eigenschaften", "Vorlage", "Vorlagen", "Neue", "Neuer", "Neues", "nicht",
  "und", "oder", "mit", "für", "über", "auf", "werden", "wird", "keine", "kein", "Keine", "Kein", "Stunden", "Minuten",
  "Buchung", "Buchungen", "gebucht", "Datei", "Dateien", "Ordner", "Schließen", "Öffnen", "Bearbeiten", "Hinzufügen",
  "Entfernen", "Anzeigen", "Zurück", "Weiter", "Fertig", "Leer", "Alle", "Datum", "Uhrzeit", "Besprechung",
  "Rückblick", "Zeitleiste", "Wochenplan", "Papierkorb", "Sicherung", "Verlauf", "Tagesnotiz", "Fokus", "Sitzung",
  "Vorgang", "Vorgänge", "Netzplan", "Leistungsart", "Stichwort", "Erinnerung", "Benachrichtigungen", "Tastatur",
  "Darstellung", "Sprache", "Datenschutz", "Netzwerk", "Protokoll", "Über", "Verwaltung", "Anhänge", "Termine",
  "Zusammenfassung", "Assistent", "Ansicht", "Liste", "Tabelle", "Spalte", "Zeile", "Titel", "Symbol", "Farbe",
  "wählen", "anlegen", "ändern", "hinzufügen", "entfernen", "öffnen", "schließen", "bearbeiten", "Erledigt", "Offen",
  "Fällig", "fällig", "überfällig", "Später", "Priorität", "Hoch", "Mittel", "Niedrig", "Entwurf", "Freigegeben",
  // Weekdays ("Mo", "Fr", "Sa" read the same in English).
  "Di", "Mi", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag", "KW", "Uhr",
];
const WORD_RE = new RegExp(`(?<![\\p{L}\\d_-])(${GERMAN.join("|")})(?![\\p{L}\\d_-])`, "u");
const UMLAUT_RE = /[äöüÄÖÜß„]/;

/**
 * German words in the visible text and in the labels of the window (aria-label, title,
 * placeholder, tooltips), with a bit of context. `allow` lists regexes for texts that may stay
 * (proper names, user content a test typed in German on purpose).
 */
export async function germanLeftovers(app, allow = []) {
  const texts = await app.browser.execute(() => {
    const out = [];
    const visible = document.body.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
    for (const l of visible) out.push(`text: ${l}`);
    for (const el of document.querySelectorAll("[aria-label],[title],[placeholder],[data-tooltip],[aria-description]")) {
      for (const a of ["aria-label", "title", "placeholder", "data-tooltip", "aria-description"]) {
        const v = el.getAttribute(a);
        if (v && v.trim()) out.push(`${a}: ${v.trim()}`);
      }
    }
    return out;
  });
  const hits = new Set();
  for (const t of texts) {
    const body = t.slice(t.indexOf(": ") + 2);
    if (allow.some((r) => r.test(body))) continue;
    if (WORD_RE.test(body) || UMLAUT_RE.test(body)) hits.add(t.slice(0, 160));
  }
  return [...hits];
}
