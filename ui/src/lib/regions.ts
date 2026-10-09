// F6 / Shift+F6: the focus jumps between the window's regions (ribbon, sidebar, the active pane,
// side panel, messages) instead of tabbing through every control on the way, as in browsers and
// Office. A message with „Rückgängig“ is reached this way before it closes (it waits while focused).

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

interface Region {
  root: string;
  /** Where the focus goes in it: the current place first (the caret, the current tree row). */
  target: (root: Element) => HTMLElement | null;
}

const visible = (el: Element | null): el is HTMLElement => el instanceof HTMLElement && el.offsetParent !== null;
const first = (root: Element | null, sel = FOCUSABLE) => [...(root?.querySelectorAll(sel) ?? [])].find(visible) ?? null;

export const REGIONS: Region[] = [
  { root: ".ribbon", target: (r) => first(r) },
  { root: ".sidebar", target: (r) => first(r, '.tree-row[tabindex="0"]') ?? first(r) },
  {
    root: ".workspace .pane.active",
    target: (r) => {
      const shown = r.querySelector(".pane-content:not([hidden])");
      return first(shown, ".ProseMirror, .source-text") ?? first(shown) ?? first(r);
    },
  },
  { root: ".app > .panel", target: (r) => first(r, '[role="tab"][aria-selected="true"]') ?? first(r) },
  // The newest message, at its action („Rückgängig“) when it has one.
  { root: ".toasts", target: (r) => first([...r.querySelectorAll(".toast")].at(-1) ?? null) },
];

/** Puts the focus into the active pane (after a layer over the window closed with nothing to return to). */
export function focusMain(doc: Document = document): HTMLElement | null {
  const pane = REGIONS[2];
  const el = doc.querySelector(pane.root);
  const target = el ? pane.target(el) : null;
  target?.focus({ preventScroll: true });
  return target;
}

/** Moves the focus to the next (`dir` 1) or previous (-1) region that has something to focus; returns it. */
export function cycleRegion(dir: 1 | -1, doc: Document = document): HTMLElement | null {
  const regions = REGIONS.map((r) => ({ ...r, el: doc.querySelector(r.root) }));
  const active = doc.activeElement;
  const at = regions.findIndex((r) => !!r.el && !!active && r.el.contains(active));
  for (let step = 1; step <= regions.length; step++) {
    const i = (((at < 0 ? (dir > 0 ? -1 : 0) : at) + dir * step) % regions.length + regions.length) % regions.length;
    const r = regions[i];
    const target = r.el ? r.target(r.el) : null;
    if (target) {
      target.focus({ preventScroll: true });
      return target;
    }
  }
  return null;
}
