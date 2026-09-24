// Which rows of a long list to render for a scroll position.

export interface ListView {
  /** Scroll offset into the list (negative while the list starts below the top of its scroller). */
  top: number;
  /** Height of the visible area. */
  height: number;
  rowH: number;
}

/**
 * Indexes of the rows to render: those in view with `overscan` rows around them, plus `extra`
 * rows that must exist wherever they are (dragged, focused); ascending, each once.
 */
export function treeWindow(count: number, view: ListView, extra: number[] = [], overscan = 20): number[] {
  const first = Math.max(0, Math.floor(view.top / view.rowH) - overscan);
  const last = Math.min(count, Math.max(first, Math.ceil((view.top + view.height) / view.rowH) + overscan));
  const out: number[] = [];
  for (let i = first; i < last; i++) out.push(i);
  const outside = [...new Set(extra)].filter((e) => e >= 0 && e < count && (e < first || e >= last));
  return outside.length ? [...out, ...outside].sort((a, b) => a - b) : out;
}
