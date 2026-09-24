// Search in the PDF viewer: hits per text item of the pages' text content (pdf.js), which is
// what the text layer shows, so every hit can be highlighted where it is.

/** One search hit: page (1-based), text item of that page, and which match within the item. */
export interface PdfHit {
  page: number;
  item: number;
  n: number;
}

/** Start offsets of `query` in `text` (case-insensitive, not overlapping). */
export function matchOffsets(text: string, query: string): number[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const t = text.toLowerCase();
  // Lower-casing may change the length of rare characters; then the offsets would not fit.
  if (t.length !== text.length) return [];
  const out: number[] = [];
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) out.push(i);
  return out;
}

/** Every hit of `query` in the pages' text items, in reading order. */
export function findHits(pages: string[][], query: string): PdfHit[] {
  const out: PdfHit[] = [];
  pages.forEach((items, p) => items.forEach((text, item) => matchOffsets(text, query).forEach((_, n) => out.push({ page: p + 1, item, n }))));
  return out;
}
