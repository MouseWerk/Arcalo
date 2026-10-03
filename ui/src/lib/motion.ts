// Reduced motion: the system setting or the app's own switch (Einstellungen > Darstellung).
// CSS covers animations and transitions; code that animates (smooth scrolling, the graph)
// asks here.

export function reducedMotion(): boolean {
  if (typeof document !== "undefined" && document.documentElement.dataset.reduceMotion === "on") return true;
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The scroll behavior for scrollIntoView/scrollTo: instant when motion is reduced. */
export const scrollMotion = (): ScrollBehavior => (reducedMotion() ? "auto" : "smooth");
