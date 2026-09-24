// Tooltips for every element with `data-tooltip` (side: `data-tooltip-side`, default below).
// A single element in <body> with a fixed position: it cannot be clipped by a scroll area or
// covered by the editor next to the sidebar, and it flips when there is no room.

const DELAY_MS = 450;
const GAP = 6;

export function installTooltips() {
  const tip = document.createElement("div");
  tip.className = "tooltip";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  let target: HTMLElement | null = null;
  let timer = 0;

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
    target = null;
    tip.classList.remove("on");
  };
  const show = (el: HTMLElement) => {
    const text = el.dataset.tooltip;
    if (!text) return;
    tip.textContent = text;
    place(el);
    tip.classList.add("on");
  };
  const enter = (el: HTMLElement | null) => {
    if (el === target) return;
    hide();
    if (!el) return;
    target = el;
    timer = window.setTimeout(() => target === el && el.isConnected && show(el), DELAY_MS);
  };

  document.addEventListener("pointerover", (e) => enter((e.target as Element | null)?.closest?.("[data-tooltip]") as HTMLElement | null), true);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", hide, true);
  document.addEventListener("scroll", hide, true);
  window.addEventListener("blur", hide);
  document.documentElement.addEventListener("pointerleave", hide);
  // Keyboard users: focus shows the tooltip too.
  document.addEventListener("focusin", (e) => {
    const el = (e.target as Element).closest?.("[data-tooltip]") as HTMLElement | null;
    if (el && el.matches(":focus-visible")) enter(el);
  });
  document.addEventListener("focusout", hide);
}
