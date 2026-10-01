// The glyph of an issue type (chips, the Issues page, widgets, the hover card): plain SVG
// strings, so the views using them do not load the editor.

const svg = (body: string) =>
  `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** A small glyph per issue type (Jira's own colors in CSS). */
export function typeOf(issueType: string): "bug" | "story" | "epic" | "task" | "subtask" | "other" {
  const t = issueType.toLowerCase();
  if (/bug|fehler|defect/.test(t)) return "bug";
  if (/story|anforderung/.test(t)) return "story";
  if (/epic/.test(t)) return "epic";
  if (/sub|unteraufgabe/.test(t)) return "subtask";
  if (/task|aufgabe/.test(t)) return "task";
  return "other";
}

export const TYPE_SVG: Record<ReturnType<typeof typeOf>, string> = {
  bug: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/>'),
  story: svg('<path d="M6 3h12v18l-6-4.5L6 21z"/>'),
  epic: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  task: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>'),
  subtask: svg('<rect x="3" y="3" width="18" height="18" rx="4"/><path d="M9 8v5h6"/>'),
  other: svg('<circle cx="12" cy="12" r="8"/>'),
};
