// Lazy rendering of heavy blocks in notes (page embeds, diagrams, queries): each renders when it
// scrolls into view (or near it), not when the page opens. Printing (PDF export) renders all of
// them first and waits for them.

type Render = () => Promise<void> | void;

const pending = new Map<Element, Render>();
let observer: IntersectionObserver | null = null;

function io(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const run = pending.get(e.target);
        pending.delete(e.target);
        observer?.unobserve(e.target);
        void run?.();
      }
    },
    { rootMargin: "300px 0px" },
  );
  return observer;
}

/** Calls `render` once `el` is near the viewport; returns a function that cancels it. */
export function whenVisible(el: Element, render: Render): () => void {
  const o = io();
  if (!o) {
    void render();
    return () => {};
  }
  pending.set(el, render);
  o.observe(el);
  return () => {
    pending.delete(el);
    o.unobserve(el);
  };
}

/** Work started by renders that printing waits for (diagrams, embeds). */
const busy = new Set<Promise<unknown>>();

/** Registers a render in progress (printing waits for it). */
export function track<T>(p: Promise<T>): Promise<T> {
  busy.add(p);
  const done = () => busy.delete(p);
  p.then(done, done);
  return p;
}

/** Sent before printing: blocks switch to their print look (light diagrams, expanded embeds). */
export const PRINT_PREPARE_EVENT = "arcalo:print-prepare";

/** Renders everything still waiting for the viewport and waits for all renders (max `ms`). */
export async function renderAllNow(ms = 8000): Promise<void> {
  window.dispatchEvent(new CustomEvent(PRINT_PREPARE_EVENT));
  const deadline = Date.now() + ms;
  // Embeds render nested blocks: repeat until nothing is left.
  for (let round = 0; round < 6 && Date.now() < deadline; round++) {
    const runs = [...pending.entries()].filter(([el]) => el.isConnected);
    for (const [el] of runs) {
      pending.delete(el);
      observer?.unobserve(el);
    }
    const started = runs.map(([, run]) => Promise.resolve(run()));
    const all = Promise.allSettled([...started, ...busy]);
    await Promise.race([all, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
    if (!pending.size && !busy.size) break;
  }
}
