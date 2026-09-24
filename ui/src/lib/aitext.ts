// Prompts and text helpers of the inline AI bar and the meeting summary.
// The shell wraps the instruction and the text (`ai_transform`); these only build the instruction.

export interface AiPreset {
  id: string;
  label: string;
  instruction: string;
}

export const AI_PRESETS: AiPreset[] = [
  { id: "improve", label: "Verbessern", instruction: "Verbessere den Text: klarer, flüssiger und präziser formuliert, gleicher Inhalt, ähnliche Länge." },
  { id: "shorten", label: "Kürzen", instruction: "Kürze den Text auf etwa die Hälfte. Behalte alle wichtigen Aussagen, Namen, Zahlen und Termine." },
  { id: "expand", label: "Ausführlicher", instruction: "Formuliere den Text ausführlicher: ergänze Erläuterungen und Zusammenhänge, aber erfinde keine Fakten." },
  { id: "translate", label: "Übersetzen DE↔EN", instruction: "Übersetze den Text: deutschen Text ins Englische, englischen Text ins Deutsche. Formatierung beibehalten." },
  { id: "bullets", label: "In Stichpunkte", instruction: "Fasse den Text als Markdown-Aufzählung (- …) mit kurzen Stichpunkten zusammen." },
  { id: "table", label: "Als Tabelle", instruction: "Stelle den Inhalt als Markdown-Tabelle mit Kopfzeile dar. Wähle sinnvolle Spalten." },
  { id: "spelling", label: "Rechtschreibung korrigieren", instruction: "Korrigiere nur Rechtschreibung, Grammatik und Zeichensetzung. Ändere weder Inhalt, Stil noch Formatierung." },
  { id: "friendly", label: "Freundlicher", instruction: "Formuliere den Text freundlicher und zugewandter, bei gleichem Inhalt." },
  { id: "formal", label: "Förmlicher", instruction: "Formuliere den Text förmlicher und sachlicher (Geschäftston, Sie-Form), bei gleichem Inhalt." },
];

/** The presets of the inline AI bar: the user's (Settings → KI) or the built-in ones. */
export function inlinePresets(custom?: { label: string; instruction: string }[] | null): AiPreset[] {
  if (!custom) return AI_PRESETS;
  return custom.filter((p) => p.label.trim() && p.instruction.trim()).map((p, i) => ({ id: `custom-${i}`, label: p.label.trim(), instruction: p.instruction.trim() }));
}

/** The instruction of a preset or free text (trimmed); null when empty. */
export function transformInstruction(presetOrText: string, presets: AiPreset[] = AI_PRESETS): string | null {
  const preset = presets.find((p) => p.id === presetOrText);
  if (preset) return preset.instruction;
  const t = presetOrText.trim();
  return t ? t : null;
}

/** Removes a fence the model put around the whole answer (```markdown … ```), also while it streams. */
export function cleanAiMarkdown(answer: string): string {
  const t = answer.trim();
  const m = /^```(markdown|md)?[ \t]*\n/i.exec(t);
  if (!m) return t;
  const body = t.slice(m[0].length);
  // Still streaming (no closing fence yet) or closed at the very end.
  const closed = /\n?```$/.exec(body);
  const inner = closed ? body.slice(0, closed.index) : body;
  if (inner.includes("\n```")) return t;
  return inner.trimEnd();
}

// ------------------------------------------------------------ meeting summary

export const SUMMARY_HEADINGS = ["Zusammenfassung", "Entscheidungen", "Aufgaben", "Offene Punkte"] as const;

/** The instruction for „Besprechung zusammenfassen“: the user's template or the built-in one. */
export function meetingSummaryInstruction(template?: string | null): string {
  if (template?.trim()) return template.trim();
  return [
    "Fasse die folgende Besprechungsnotiz zusammen. Gliedere die Antwort genau in diese vier Abschnitte und nichts sonst:",
    "",
    "## Zusammenfassung",
    "3–5 Sätze: Anlass, wichtigste Ergebnisse.",
    "",
    "## Entscheidungen",
    "Getroffene Entscheidungen als Aufzählung (- …). Gibt es keine, schreibe „- Keine“.",
    "",
    "## Aufgaben",
    "Jede Aufgabe als eigene Zeile im Format `- [ ] Text @Person due:JJJJ-MM-TT`.",
    "@Person nur, wenn eine verantwortliche Person genannt ist. due: mit Datum nur, wenn ein Termin genannt ist; relative Angaben („bis Freitag“) in ein Datum umrechnen.",
    "Priorität am Zeilenende mit !! (hoch) oder ! (mittel), nur wenn sie erkennbar ist. Gibt es keine Aufgaben, schreibe „- Keine“.",
    "",
    "## Offene Punkte",
    "Ungeklärte Fragen und Themen für das nächste Treffen als Aufzählung, sonst „- Keine“.",
    "",
    "Erfinde nichts: nur, was in der Notiz steht. Schreibe auf Deutsch.",
  ].join("\n");
}

export const summaryPageTitle = (title: string) => `${title} – Zusammenfassung`;

/** Content of the page „<Titel> – Zusammenfassung“, linked back to the meeting page. */
export function summaryPageContent(title: string, summary: string): string {
  return `Zusammenfassung von [[${title}]]\n\n${summary.trim()}\n`;
}

/** Minutes of a meeting from its notes: a time span („10:00–11:30“) or „Dauer: 90 min / 1,5 h“. */
export function meetingMinutes(body: string): number | null {
  const dur = /\bDauer\s*:?\s*(\d+(?:[.,]\d+)?)\s*(h|std\.?|stunden?|min(?:uten)?)\b/i.exec(body);
  if (dur) {
    const n = parseFloat(dur[1].replace(",", "."));
    const minutes = /^min/i.test(dur[2]) ? n : n * 60;
    return minutes > 0 && minutes <= 12 * 60 ? Math.round(minutes) : null;
  }
  const span = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:Uhr\s*)?(?:–|-|—|bis)\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(body);
  if (span) {
    const minutes = +span[3] * 60 + +span[4] - (+span[1] * 60 + +span[2]);
    return minutes > 0 && minutes <= 12 * 60 ? minutes : null;
  }
  return null;
}

/** `/zeit` duration: hours with a dot (`1.5h`), or minutes when not a quarter hour (`50m`). */
export function zeitDuration(minutes: number): string {
  if (minutes % 15 !== 0) return `${minutes}m`;
  return `${+(minutes / 60).toFixed(2)}h`;
}

/** „Buchungsvorschlag: `/zeit <ref> <dauer> <titel>`“ when the page has a Vorgang and a derivable duration. */
export function bookingSuggestion(reference: string | null, body: string, title: string): string | null {
  if (!reference) return null;
  const minutes = meetingMinutes(body);
  if (minutes == null) return null;
  const text = title.replace(/[`\n]/g, " ").trim();
  return `Buchungsvorschlag: \`/zeit ${reference} ${zeitDuration(minutes)} ${text}\``;
}
