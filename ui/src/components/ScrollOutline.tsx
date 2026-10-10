// Scroll outline at the right edge of long notes: heading marks, the visible part, click to jump.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { scrollMotion } from "../lib/motion";

interface Mark {
  top: number; // 0..1 of the document height
  level: number;
  text: string;
  el: HTMLElement;
}

/** Positions (0..1) of headings in a scroll container; exported for tests. */
export function markPositions(headingTops: number[], scrollHeight: number): number[] {
  return headingTops.map((t) => (scrollHeight > 0 ? Math.min(1, Math.max(0, t / scrollHeight)) : 0));
}

type View = { top: number; height: number };
const sameView = (v: View, top: number, height: number): View => (v.top === top && v.height === height ? v : { top, height });

export function ScrollOutline({ scrollRef }: { scrollRef: RefObject<HTMLElement | null> }) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const [view, setView] = useState({ top: 0, height: 1 });
  const [long, setLong] = useState(false);
  const pending = useRef<number | undefined>(undefined);

  const measure = useCallback(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const total = sc.scrollHeight;
    setLong(total > sc.clientHeight * 1.3);
    setView((v) => sameView(v, sc.scrollTop / total, sc.clientHeight / total));
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    const hs = [...sc.querySelectorAll<HTMLElement>(".ProseMirror h1, .ProseMirror h2, .ProseMirror h3")];
    const tops = markPositions(
      hs.map((h) => h.getBoundingClientRect().top - base),
      total,
    );
    const next = hs.map((h, i) => ({ top: tops[i], level: Number(h.tagName[1]), text: h.textContent ?? "", el: h }));
    // Typing mostly moves nothing: no new marks, no render.
    setMarks((cur) => (cur.length === next.length && cur.every((m, i) => m.top === next[i].top && m.level === next[i].level && m.text === next[i].text && m.el === next[i].el) ? cur : next));
  }, [scrollRef]);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const soon = () => {
      window.clearTimeout(pending.current);
      pending.current = window.setTimeout(measure, 150);
    };
    const onScroll = () => setView({ top: sc.scrollTop / sc.scrollHeight, height: sc.clientHeight / sc.scrollHeight });
    measure();
    sc.addEventListener("scroll", onScroll, { passive: true });
    const ro = new ResizeObserver(soon);
    ro.observe(sc);
    if (sc.firstElementChild) ro.observe(sc.firstElementChild);
    const mo = new MutationObserver(soon);
    mo.observe(sc, { childList: true, subtree: true, characterData: true });
    return () => {
      sc.removeEventListener("scroll", onScroll);
      ro.disconnect();
      mo.disconnect();
      window.clearTimeout(pending.current);
    };
  }, [scrollRef, measure]);

  if (!long) return null;
  const sc = scrollRef.current;
  const jump = (fraction: number) => sc?.scrollTo({ top: fraction * sc.scrollHeight - sc.clientHeight / 2, behavior: scrollMotion() });
  // The heading the reader is in: the last one above the upper third of the view.
  const reading = marks.filter((m) => m.top <= view.top + view.height / 3).pop();
  return (
    <div
      className="scroll-outline"
      aria-hidden
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest(".so-mark")) return;
        const r = e.currentTarget.getBoundingClientRect();
        jump((e.clientY - r.top) / r.height);
      }}
    >
      <div className="so-view" style={{ top: `${view.top * 100}%`, height: `${Math.max(view.height * 100, 3)}%` }} />
      {marks.map((m, i) => (
        <button
          key={i}
          type="button"
          tabIndex={-1}
          className={`so-mark l${m.level} ${m === reading ? "on" : ""}`}
          style={{ top: `${m.top * 100}%` }}
          aria-label={m.text}
          data-tooltip={m.text}
          data-tooltip-side="left"
          onClick={() => m.el.scrollIntoView({ behavior: scrollMotion(), block: "start" })}
        />
      ))}
    </div>
  );
}
