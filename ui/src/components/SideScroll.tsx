// A table that scrolls sideways in a narrow pane: a shadow on each edge that hides columns, a
// small button that pages to the right, and one Tab stop so the arrow keys scroll it.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";

/** Which edges of a sideways-scrolling box hide content. */
export function scrollEdges(el: { scrollLeft: number; clientWidth: number; scrollWidth: number }) {
  return { left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 };
}

export function SideScroll({ label, moreLabel, className = "", children }: { label: string; moreLabel: string; className?: string; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const next = scrollEdges(el);
      setEdges((e) => (e.left === next.left && e.right === next.right ? e : next));
    };
    const schedule = () => (frame ||= requestAnimationFrame(update));
    update();
    const ro = new ResizeObserver(schedule);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    el.addEventListener("scroll", schedule, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      el.removeEventListener("scroll", schedule);
    };
  }, []);
  const scrolls = edges.left || edges.right;
  return (
    <div className={`side-scroll ${edges.left ? "more-left" : ""} ${edges.right ? "more-right" : ""} ${className}`}>
      <div
        ref={box}
        className="table-wrap"
        // Only a box that scrolls is a stop of its own (the arrow keys scroll it then).
        tabIndex={scrolls ? 0 : undefined}
        role={scrolls ? "region" : undefined}
        aria-label={scrolls ? label : undefined}
      >
        {children}
      </div>
      {edges.right && (
        <button
          type="button"
          className="side-scroll-more"
          aria-label={moreLabel}
          title={moreLabel}
          // The pointer's way to the hidden columns; the keyboard scrolls the box itself.
          tabIndex={-1}
          onClick={() => box.current?.scrollBy({ left: Math.max(120, box.current.clientWidth * 0.6), behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })}
        >
          <ChevronRight size={14} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
