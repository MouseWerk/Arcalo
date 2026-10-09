// Tooltips for every element with `data-tooltip` (side: `data-tooltip-side`, default below).
// A single element in <body> with a fixed position: it cannot be clipped by a scroll area or
// covered by the editor next to the sidebar, and it flips when there is no room.
// Text cut with an ellipsis or a line clamp shows in full the same way, only while it is cut:
// the text of `data-tooltip-full` on an ancestor (a meeting: title and time), else the cut text.

const DELAY_MS = 450;
const GAP = 6;

/** Whether `el` cuts its text (ellipsis or line clamp) right now. */
export function cutsText(el: Element): boolean {
  if (!(el instanceof HTMLElement) || !el.textContent?.trim()) return false;
  const cs = getComputedStyle(el);
  const clamps = cs.textOverflow === "ellipsis" || (cs.webkitLineClamp !== "" && cs.webkitLineClamp !== "none");
  return clamps && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1);
}

/** The full text for a pointer over `from` when the text there is cut, or null. Elements with a
 *  native `title` keep that one. */
export function cutText(from: Element | null): { el: HTMLElement; text: string } | null {
  const full = from?.closest?.("[data-tooltip-full]") as HTMLElement | null;
  if (full) {
    // Cut, or left out for want of room (a narrow chip that shows its color only).
    const cut = cutsText(full) || [...full.querySelectorAll("*")].some((e) => cutsText(e) || (!!e.textContent?.trim() && e.getClientRects().length === 0));
    return cut && full.dataset.tooltipFull ? { el: full, text: full.dataset.tooltipFull } : null;
  }
  let el = from;
  for (let i = 0; el && i < 3; i++, el = el.parentElement) {
    if (el.closest("[title]")) return null;
    if (cutsText(el)) return { el: el as HTMLElement, text: el.textContent!.replace(/\s+/g, " ").trim() };
  }
  return null;
}

export function installTooltips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer = 0;
  let watch = 0;
  // When a key that moves the focus was last pressed: only such a focus change shows a tooltip,
  // not a view that focuses a control of its own after it opened.
  let navKeyAt = 0;

  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let side = el.dataset.tooltipSide ?? "bottom";
    // Flip when the preferred side has no room.
    if (side === "bottom" && r.bottom + GAP + t.height > vh) side = "top";
    else if (side === "top" && r.top - GAP - t.height < 0) side = "bottom";
    else if (side === "right" && r.right + GAP + t.width > vw) side = "left";
    else if (side === "left" && r.left - GAP - t.width < 0) side = "right";
    let x: number;
    let y: number;
    if (side === "bottom" || side === "top") {
      x = r.left + r.width / 2 - t.width / 2;
      y = side === "bottom" ? r.bottom + GAP : r.top - GAP - t.height;
    } else {
      x = side === "right" ? r.right + GAP : r.left - GAP - t.width;
      y = r.top + r.height / 2 - t.height / 2;
    }
    x = Math.max(8, Math.min(vw - t.width - 8, x));
    y = Math.max(8, Math.min(vh - t.height - 8, y));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };

  const hide = () => {
    window.clearTimeout(timer);
    window.clearInterval(watch);
    target = null;
    tip.classList.remove("on");
  };
  /** Whether the tooltip of `el` still belongs on screen: under the pointer or keyboard focus. */
  const wanted = (el: HTMLElement) => el.isConnected && (el.matches(":hover") || el.contains(document.activeElement) && !!document.activeElement?.matches(":focus-visible"));
  let pending = "";
  const show = (el: HTMLElement) => {
    const text = el.dataset.tooltip ?? pending;
    if (!text) return;
    tip.textContent = text;
    place(el);
    tip.classList.add("on");
    // A view that re-renders under a still pointer, or removes the element, sends no event that
    // ends the hover: check while the tooltip shows.
    window.clearInterval(watch);
    watch = window.setInterval(() => {
      if (target !== el || !wanted(el)) hide();
    }, 300);
  };
  const enter = (el: HTMLElement | null, text = "") => {
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    pending = text;
    timer = window.setTimeout(() => target === el && el.isConnected && show(el), DELAY_MS);
  };

  document.addEventListener(
    "pointerover",
    (e) => {
      const from = e.target as Element | null;
      const own = from?.closest?.("[data-tooltip]") as HTMLElement | null;
      if (own) return enter(own);
      const cut = cutText(from);
      enter(cut?.el ?? null, cut?.text);
    },
    true,
  );
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener(
    "keydown",
    (e) => {
      if (/^(Tab|Arrow|Home|End|PageUp|PageDown|F6)/.test(e.key)) navKeyAt = performance.now();
      hide();
    },
    true,
  );
  // Only a scroll that moves the target hides it (not the editor loading next to the sidebar).
  document.addEventListener(
    "scroll",
    (e) => {
      const from = e.target;
      if (target && (from === document || (from instanceof Node && from.contains(target)))) hide();
    },
    true,
  );
  window.addEventListener("blur", hide);
  document.documentElement.addEventListener("pointerleave", hide);
  // Keyboard users: focus moved by a key shows the tooltip too.
  document.addEventListener("focusin", (e) => {
    const el = (e.target as Element).closest?.("[data-tooltip]") as HTMLElement | null;
    if (el && el.matches(":focus-visible") && performance.now() - navKeyAt < 1000) enter(el);
  });
  // Only when the target loses focus: a field elsewhere (the editor of a page that is still
  // opening) taking or dropping focus leaves the tooltip of the hovered button alone.
  document.addEventListener("focusout", (e) => {
    if (target && e.target instanceof Node && e.target.contains(target)) hide();
  });
}
