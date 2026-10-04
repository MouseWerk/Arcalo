// Ranking of the command palette: a subsequence match that prefers prefix and word-start hits.
// German spellings without umlauts find the umlaut ones and back: „ubersicht“ and „uebersicht“
// both find „Übersicht“, „strasse“ finds „Straße“.

/** Lower case without accents, ß as ss: „Übersicht“ → „ubersicht“. */
export const foldPlain = (s: string) => s.toLowerCase().replace(/ß/g, "ss").normalize("NFD").replace(/\p{M}/gu, "");

/** Lower case with umlauts written out: „Übersicht“ → „uebersicht“. */
export const foldWritten = (s: string) =>
  foldPlain(s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue"));

/** Score of `q` in `text` for already folded strings (0 = no match). */
function score(t: string, q: string): number {
  const i = t.indexOf(q);
  if (i === 0) return 100 - t.length / 100;
  if (i > 0) return (/[\s\-_/.]/.test(t[i - 1]) ? 80 : 60) - t.length / 100;
  let ti = 0;
  for (const c of q) {
    ti = t.indexOf(c, ti);
    if (ti < 0) return 0;
    ti++;
  }
  return 20 - t.length / 100;
}

/** Subsequence match score of `q` in `text`, case, accents and umlaut spelling ignored (0 = none). */
export function fuzzy(text: string, q: string): number {
  if (!q) return 1;
  return Math.max(score(foldPlain(text), foldPlain(q)), score(foldWritten(text), foldWritten(q)));
}
