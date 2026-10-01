// Callout types as typed after `[!`: Obsidian's English names, and German names for the same
// types. A German name is styled and labeled like its English type; the Markdown keeps what
// was typed.

/** German callout names → the English type they stand for. */
const GERMAN: Record<string, string> = {
  hinweis: "note",
  tipp: "tip",
  wichtig: "important",
  warnung: "warning",
  achtung: "caution",
  gefahr: "danger",
  fehler: "error",
  erfolg: "success",
  frage: "question",
  zitat: "quote",
  beispiel: "example",
  aufgabe: "todo",
  zusammenfassung: "summary",
};

/** The type a callout is styled and labeled as (lowercase; German names → English type). */
export const calloutType = (typed: string) => {
  const l = typed.toLowerCase();
  return GERMAN[l] ?? l;
};
