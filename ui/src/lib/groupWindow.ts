// Long grouped lists (the Issues page): per group only the rows in view are rendered, with
// spacers of the (measured) heights of the others, like the task list. Rows tell their real
// height once rendered (an opened issue grows); unmeasured rows count with an estimate.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { visibleRange } from "./activity";

export interface GroupWindow {
  from: number;
  to: number;
  /** Height of the spacer before the rendered rows. */
  before: number;
  /** Height of the spacer after them. */
  after: number;
}

/**
 * The rows of one group to render: `heights` of all its rows, `groupTop` where the group's list
 * starts in the scroller (`null`: not placed yet, nothing rendered), the visible part of the
 * scroller and the margin rendered beyond it.
 */
export function groupWindow(heights: number[], groupTop: number | null, viewTop: number, viewHeight: number, overscan: number): GroupWindow {
  const offsets: number[] = [];
  let y = 0;
  for (const h of heights) {
    offsets.push(y);
    y += h;
  }
  const lo = groupTop == null ? y : viewTop - groupTop - overscan;
  const hi = groupTop == null ? -1 : viewTop - groupTop + viewHeight + overscan;
  const [from, to] = hi < 0 || lo > y ? [0, 0] : visibleRange(offsets, y, Math.max(0, lo), hi - Math.max(0, lo), 0);
  return { from, to, before: offsets[from] ?? y, after: y - (offsets[to] ?? y) };
}

/**
 * Windowing for grouped lists in one scroller. `enabled` false renders everything. Rows are
 * found by `rowSelector` and named by `rowKey` (the same key `windowOf` gets).
 */
export function useGroupWindow(enabled: boolean, rowSelector: string, rowKey: (el: HTMLElement) => string, estimate: number, overscan = 600) {
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const lists = useRef(new Map<string, HTMLElement>());
  const [view, setView] = useState<{ top: number; height: number; tops: Record<string, number> }>({ top: 0, height: 1000, tops: {} });
  const measure = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    const tops: Record<string, number> = {};
    for (const [id, el] of lists.current) tops[id] = el.getBoundingClientRect().top - base;
    setView({ top: sc.scrollTop, height: sc.clientHeight, tops });
  }, []);
  useEffect(() => {
    const sc = scroller.current;
    if (!enabled || !sc) return;
    let frame = 0;
    const schedule = () => (frame ||= requestAnimationFrame(() => ((frame = 0), measure())));
    measure();
    sc.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(sc);
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [enabled, measure]);
  // WebKit anchors the scroll position to a row when the rendered rows change (overflow-anchor
  // is not supported there): the position before the commit is the one to keep.
  const beforeCommit = useRef(0);
  beforeCommit.current = scroller.current?.scrollTop ?? 0;
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (sc && enabled && sc.scrollTop !== beforeCommit.current) sc.scrollTop = beforeCommit.current;
  });
  // Rendered rows tell their real height (with the list's gap); a changed one moves the rows after it.
  useLayoutEffect(() => {
    if (!enabled) return;
    let changed = false;
    const gaps = new Map<Element, number>();
    for (const el of scroller.current?.querySelectorAll<HTMLElement>(rowSelector) ?? []) {
      const list = el.parentElement;
      let gap = list ? gaps.get(list) : 0;
      if (list && gap === undefined) {
        gap = parseFloat(getComputedStyle(list).rowGap) || 0;
        gaps.set(list, gap);
      }
      const k = rowKey(el);
      const h = el.offsetHeight + (gap ?? 0);
      if (el.offsetHeight && heights.current.get(k) !== h) {
        heights.current.set(k, h);
        changed = true;
      }
    }
    if (changed) measure();
  });
  /** Registers the list element of group `id`. */
  const listRef = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) lists.current.set(id, el);
      else lists.current.delete(id);
    },
    [],
  );
  /** The rows of group `id` (by key) to render; `first`: the first group (placed from the start). */
  const windowOf = (id: string, keys: string[], first: boolean): GroupWindow => {
    if (!enabled) return { from: 0, to: keys.length, before: 0, after: 0 };
    const top = view.tops[id] ?? (first ? view.top : null);
    return groupWindow(keys.map((k) => heights.current.get(k) ?? estimate), top, view.top, view.height, overscan);
  };
  return { scroller, listRef, windowOf };
}
