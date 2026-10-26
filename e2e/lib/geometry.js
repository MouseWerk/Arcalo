// Geometry of a phone screen, measured in the page of the Android app over the WebView's DevTools
// socket (e2e/android/cdp.js), as Arcalo Mail measures its own. Every check is a self-contained
// function (it runs in the page, so it uses nothing from this file) that returns plain data;
// `problems` turns the data into readable failures, empty when the screen is right.
//
// What a phone screen must be:
// - as wide as the viewport, nothing wider (no sideways scrolling of the page);
// - nothing tappable under the status bar or the navigation bar (`insets` in CSS pixels);
// - spinners small and round, never a long line across the screen;
// - every tab of the tab bar on screen, each at least 44 px wide and high;
// - the end of a scrolled screen clear of the tab bar (the last row can be tapped).

/** The page side of `layout`: width, overflow and what can be tapped inside the insets. */
export function measureLayout(insets) {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const visible = (el) => {
    const s = getComputedStyle(el);
    if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const describe = (el) => {
    const r = el.getBoundingClientRect();
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return { what: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}${label ? ` "${label}"` : ""}`, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const INTERACTIVE = "button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=link], [role=menuitem], [role=switch], [role=checkbox], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
  // Sideways: the document and every visible element that reaches past the right edge without
  // a container that scrolls sideways around it.
  const scrollsX = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if ((s.overflowX === "auto" || s.overflowX === "scroll" || s.overflowX === "hidden" || s.overflowX === "clip") && p !== document.documentElement && p !== document.body) return true;
    }
    return false;
  };
  const wide = [];
  for (const el of document.body.querySelectorAll("*")) {
    if (wide.length >= 8) break;
    if (el.closest("#splash")) continue;
    const r = el.getBoundingClientRect();
    if ((r.right > W + 1 || r.left < -1) && r.width > 0 && visible(el) && !scrollsX(el)) wide.push(describe(el));
  }
  // What a finger reaches inside the insets: the topmost element at points across the bands.
  const inInsets = [];
  const seen = new Set();
  const scrollsY = (el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
  // Content may scroll under a bar as long as it can be scrolled out from under it: only what
  // stays there at the end of its scrolling counts (a scrolling area itself is no target).
  const stuck = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (scrollsY(p)) return p.scrollTop + p.clientHeight >= p.scrollHeight - 1 && p.scrollTop <= 0 ? true : p.scrollTop + p.clientHeight >= p.scrollHeight - 1 ? "end" : false;
    }
    return true;
  };
  const probe = (x, y, band) => {
    const hit = document.elementFromPoint(x, y);
    const target = hit?.closest(INTERACTIVE);
    if (!target || seen.has(target) || target.closest("#splash")) return;
    if (scrollsY(target)) return;
    const s = stuck(target);
    // At the top band only content at the start of its scrolling is stuck, at the bottom only
    // content at the end.
    if (s === false || (s === "end" && band === "top")) return;
    seen.add(target);
    inInsets.push({ band, ...describe(target) });
  };
  const bands = [
    ["top", 0, insets.top, 0, W],
    ["bottom", H - insets.bottom, H, 0, W],
    ["left", 0, H, 0, insets.left],
    ["right", 0, H, W - insets.right, W],
  ];
  for (const [band, y0, y1, x0, x1] of bands) {
    if (y1 - y0 < 1 || x1 - x0 < 1) continue;
    for (let y = y0 + 0.5; y < y1; y += Math.max(1, Math.min(6, (y1 - y0) / 3))) {
      for (let x = x0 + 0.5; x < x1; x += Math.max(1, Math.min(8, (x1 - x0) / 3))) probe(x, y, band);
    }
  }
  // Cut off at the top: content above the screen that its container cannot scroll back to (a
  // centered box taller than its scrolling parent).
  const cut = [];
  for (const el of document.body.querySelectorAll("button, input, h1, h2, label, p")) {
    if (cut.length >= 5) break;
    if (el.closest("#splash, [aria-hidden=true]") || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.top >= -1) continue;
    let p = el.parentElement;
    while (p && !(p.scrollHeight > p.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
    const offscreenByScroll = p && p.scrollTop > 0 && p.getBoundingClientRect().top - r.top <= p.scrollTop + 1;
    if (!offscreenByScroll && !el.closest("[inert]")) cut.push(describe(el));
  }
  // The screen's root boxes: the app shell, the screen shown and the tab bar.
  const roots = [];
  for (const sel of [".m-app", ".m-screen", ".m-tabbar"]) {
    for (const el of document.querySelectorAll(sel)) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      roots.push({ sel, left: Math.round(r.left), width: Math.round(r.width) });
    }
  }
  return {
    viewport: { w: W, h: H },
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
    wide,
    cut,
    inInsets,
    roots,
  };
}

/** Problems of a `measureLayout` result. */
export function layoutProblems(m) {
  const out = [];
  const W = m.viewport.w;
  if (m.docWidth > W + 1) out.push(`the page is ${m.docWidth} px wide in a ${W} px viewport (sideways scrolling)`);
  if (m.bodyWidth > W + 1) out.push(`the body is ${m.bodyWidth} px wide in a ${W} px viewport`);
  for (const w of m.wide) out.push(`reaches past the screen: ${w.what} at x=${w.x} w=${w.w}`);
  for (const r of m.roots) if (Math.abs(r.width - W) > 1 || Math.abs(r.left) > 1) out.push(`${r.sel} is ${r.width} px wide at x=${r.left}, the viewport ${W} px`);
  if (!m.roots.some((r) => r.sel === ".m-app")) out.push("the app (.m-app) is not visible");
  for (const c of m.cut) out.push(`cut off above the screen, out of reach: ${c.what} at y=${c.y}`);
  for (const i of m.inInsets) out.push(`tappable inside the ${i.band} inset: ${i.what} at y=${i.y} h=${i.h}`);
  return out;
}

/** Starts recording every spinner the page shows (call once per page load). */
export function recordSpinners() {
  if (window.__spinnerLog) return;
  window.__spinnerLog = [];
  // A progress bar (the booked share of the day) is no spinner, nor is the start-up logo.
  const SEL = ".m-spinner, .spinner, .m-spin svg, [class*='spinner'], [class*='loader']";
  const sample = () => {
    for (const el of document.querySelectorAll(SEL)) {
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const cls = typeof el.className === "string" ? el.className : el.getAttribute("class") || "";
      const key = `${el.tagName.toLowerCase()}.${cls.trim().split(/\s+/).join(".")}|${Math.round(r.width)}x${Math.round(r.height)}`;
      if (window.__spinnerLog.length < 200 && !window.__spinnerLog.some((x) => x.key === key)) {
        window.__spinnerLog.push({ key, cls, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10, splash: el.classList.contains("splash-mark") });
      }
    }
  };
  window.__spinnerTimer = setInterval(sample, 40);
  // As an init script it runs before the document has its root element.
  const watch = () => {
    sample();
    new MutationObserver(sample).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
  };
  if (document.documentElement) watch();
  else document.addEventListener("DOMContentLoaded", watch, { once: true });
}

/** The spinners recorded so far. */
export function recordedSpinners() {
  return window.__spinnerLog ?? [];
}

/** Problems of the recorded spinners: larger than an icon, or not square. */
export function spinnerProblems(list, { max = 48, splashMax = 160 } = {}) {
  const out = [];
  for (const s of list) {
    const limit = s.splash ? splashMax : max;
    if (s.w > limit || s.h > limit) out.push(`spinner ${s.key} is ${s.w}×${s.h} px (at most ${limit})`);
    if (Math.abs(s.w - s.h) > 2) out.push(`spinner ${s.key} is not square: ${s.w}×${s.h} px`);
  }
  return out;
}

/** The tab bar: each tab's box, and the viewport. */
export function measureTabbar() {
  const bar = document.querySelector(".m-tabbar");
  if (!bar) return { bar: null, tabs: [], w: window.innerWidth, h: window.innerHeight };
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return { bar: box(bar), tabs: [...bar.querySelectorAll(".m-tab")].map(box), w: window.innerWidth, h: window.innerHeight };
}

export function tabbarProblems(m, count = 5) {
  if (!m.bar) return ["no tab bar"];
  const out = [];
  if (m.tabs.length !== count) out.push(`${m.tabs.length} tabs in the tab bar, expected ${count}`);
  for (const t of m.tabs) {
    if (t.x < -1 || t.x + t.w > m.w + 1) out.push(`tab "${t.label}" reaches past the screen (x=${t.x} w=${t.w})`);
    if (t.w < 44 || t.h < 44) out.push(`tab "${t.label}" is ${t.w}×${t.h} px (at least 44×44)`);
  }
  if (m.bar.y + m.bar.h > m.h + 1) out.push(`the tab bar ends at ${m.bar.y + m.bar.h} px, below the ${m.h} px viewport`);
  return out;
}

/** Scrolls the screen's scrolling area to its end and returns its last tappable element and the
 *  top of the tab bar (or of the screen's bottom bar). */
export function measureScreenEnd() {
  const scroller = [...document.querySelectorAll(".m-app *")].find((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.getBoundingClientRect().height > 200);
  if (!scroller) return { scrolls: false };
  scroller.scrollTop = scroller.scrollHeight;
  const items = [...scroller.querySelectorAll("button, a[href], input, textarea, [role=button], [role=checkbox]")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const last = items[items.length - 1];
  const bar = document.querySelector(".m-tabbar");
  const barTop = bar && bar.getBoundingClientRect().height > 0 ? bar.getBoundingClientRect().top : window.innerHeight;
  const r = last?.getBoundingClientRect();
  return { scrolls: true, last: last ? { what: (last.getAttribute("aria-label") || last.textContent || last.tagName).trim().slice(0, 40), bottom: Math.round(r.bottom) } : null, barTop: Math.round(barTop) };
}

export function screenEndProblems(m) {
  if (!m.scrolls || !m.last) return [];
  return m.last.bottom > m.barTop + 1 ? [`the last item at the end of the screen ("${m.last.what}", bottom ${m.last.bottom}) lies under the tab bar (top ${m.barTop})`] : [];
}
