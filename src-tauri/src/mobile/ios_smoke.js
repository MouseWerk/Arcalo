// The simulator check of the iOS app (debug builds started with ARCALO_SMOKE=1, see
// `mobile/ios.rs` and .github/workflows/ios.yml): what the page shows and whether it fits. Runs in
// the WebView and returns one JSON string; the workflow fails on sideways overflow, on fixed
// controls inside the safe-area insets, on errors in the console, and on an iPad that does not show
// the full app.
(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const probe = document.createElement("div");
  probe.style.cssText =
    "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
    "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const inset = {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
  probe.remove();
  const page = location.pathname.split("/").pop() || "index.html";
  const phone = document.documentElement.classList.contains("mobile") || page === "mobile.html";
  // Content that scrolls may pass under the insets; fixed chrome (tab bar, ribbon, headers) may not.
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const s = getComputedStyle(p);
      const scrollY = /(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 1;
      const scrollX = /(auto|scroll)/.test(s.overflowX) && p.scrollWidth > p.clientWidth + 1;
      if (scrollY || scrollX) return true;
    }
    return false;
  };
  const describe = (el, r) => {
    const name = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 40);
    const cls = typeof el.className === "string" ? el.className.split(/\s+/).slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${name}" at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`;
  };
  const bad = [];
  const controls = document.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [role='tab'], [role='menuitem']");
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const st = getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) continue;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
    if (inScroller(el)) continue;
    const outside = r.top < inset.top - 0.5 || r.left < inset.left - 0.5 || r.right > vw - inset.right + 0.5 || r.bottom > vh - inset.bottom + 0.5;
    if (outside) bad.push(describe(el, r));
  }
  // Why a reading looks the way it does: whether the app finished its start (`body.ready`, App.tsx,
  // MobileApp.tsx), how long the page has been loaded, the first-start overlay's phase, and how
  // often the page went over between the phone and the full app (lib/uiswitch.ts).
  let switches = null;
  try {
    switches = JSON.parse(sessionStorage.getItem("arcalo.uiswitch.times") || "[]").length;
  } catch {
    /* no session storage */
  }
  const overlay = document.querySelector(".fr-overlay");
  const width = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  return JSON.stringify({
    page,
    ready: !!document.body && document.body.classList.contains("ready"),
    loadedMs: Math.round(performance.now()),
    firstRun: overlay ? (overlay.className.match(/fr-phase-(\w+)/) || [])[1] || "on" : null,
    switches,
    ui: phone ? "phone" : "full",
    ribbon: !!document.querySelector(".ribbon"),
    viewport: { width: vw, height: vh },
    inset,
    overflowX: Math.max(0, Math.round(width - vw)),
    insideInsets: bad.slice(0, 20),
    errors: (window.__arcaloErrors || []).map(String).slice(0, 20),
  });
})();
