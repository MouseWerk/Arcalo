// Layout audit for a view: finds clipped text, controls that overflow their box, overlapping
// controls and button labels that wrap. Runs in the page; returns a list of problems.
export function auditLayout(rootSelector) {
  const root = document.querySelector(rootSelector);
  if (!root) return [`root ${rootSelector} not found`];
  const out = [];
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const name = (el) => {
    const cls = typeof el.className === "string" ? el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    const text = (el.getAttribute("aria-label") || el.textContent || el.value || el.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 40);
    return `${el.tagName.toLowerCase()}${cls ? "." + cls : ""} "${text}"`;
  };
  // Scroll containers clip on purpose; only report what sticks out of a non-scrolling parent.
  const clips = (el) => {
    const s = getComputedStyle(el);
    return /(auto|scroll)/.test(s.overflowX + s.overflowY);
  };
  const controls = [...root.querySelectorAll("button, input, select, textarea, [role=switch], [role=tab], [role=radio], a[href], .seg, .badge, label")].filter(visible);
  // 1. Text that does not fit (clipped or ellipsized) in controls and labels.
  for (const el of root.querySelectorAll("button, label, .badge, .seg button, [role=tab], th, td, .row-label, .field-label, .stat-label, .stat-value, h1, h2, h3, .card-head, .settings-row-label, .settings-nav-item")) {
    if (!visible(el) || el.matches(".accent-custom")) continue;
    if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflow !== "visible") out.push(`clipped: ${name(el)} (${el.scrollWidth}>${el.clientWidth})`);
  }
  // 2. Controls sticking out of their nearest non-scrolling ancestor box (up to the root).
  for (const el of controls) {
    // The custom-color swatch hides its native color input on purpose.
    if (el.closest(".accent-custom")) continue;
    const r = el.getBoundingClientRect();
    let p = el.parentElement;
    while (p && p !== root.parentElement) {
      if (clips(p)) break;
      const s = getComputedStyle(p);
      if (s.display !== "contents" && s.position !== "static" || p.classList.contains("card") || p === root) {
        const pr = p.getBoundingClientRect();
        if (r.right > pr.right + 1.5 || r.left < pr.left - 1.5) {
          out.push(`overflows ${name(p)}: ${name(el)} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(pr.left)}–${Math.round(pr.right)})`);
        }
        break;
      }
      p = p.parentElement;
    }
  }
  // 3. Overlapping controls (not nested in each other).
  const boxes = controls.map((el) => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i];
      const [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (a.tagName === "LABEL" && (a.control === b || a.htmlFor && a.htmlFor === b.id)) continue;
      if (b.tagName === "LABEL" && (b.control === a || b.htmlFor && b.htmlFor === a.id)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) out.push(`overlap: ${name(a)} × ${name(b)} (${Math.round(w)}×${Math.round(h)})`);
    }
  }
  // 4. Buttons whose label wraps onto a second line, or controls squeezed below 20px.
  for (const el of controls) {
    if (el.tagName !== "BUTTON" && el.getAttribute("role") !== "tab") continue;
    const s = getComputedStyle(el);
    const lh = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.3;
    const r = el.getBoundingClientRect();
    const text = el.textContent.trim();
    if (text && r.height > lh * 2 + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + 2) out.push(`wraps: ${name(el)} (h ${Math.round(r.height)})`);
    if (r.width < 18 || r.height < 18) out.push(`tiny: ${name(el)} (${Math.round(r.width)}×${Math.round(r.height)})`);
  }
  // 5. Scroll areas that scroll sideways: content is cut off at the right edge.
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (!visible(el) || el.closest(".table-wrap") || el.matches(".settings-nav, .tabs, .table-wrap")) continue;
    const s = getComputedStyle(el);
    if (/(auto|scroll|hidden)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4 && !el.matches("input, select, textarea, .entry-desc, .ellipsis, .accent-custom") && s.textOverflow !== "ellipsis") {
      const edge = el.getBoundingClientRect().right;
      const culprits = [...el.querySelectorAll("*")].filter((c) => visible(c) && c.getBoundingClientRect().right > edge + 1 && ![...c.children].some((k) => k.getBoundingClientRect().right > edge + 1));
      out.push(`cut sideways: ${name(el)} (${el.scrollWidth}>${el.clientWidth}) by ${culprits.slice(0, 3).map(name).join(", ")}`);
    }
  }
  // 6. Dropdowns too narrow for their selected value.
  const ctx = document.createElement("canvas").getContext("2d");
  for (const el of root.querySelectorAll("select")) {
    if (!visible(el)) continue;
    const s = getComputedStyle(el);
    ctx.font = `${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
    const text = el.selectedOptions[0]?.textContent ?? "";
    const room = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
    if (ctx.measureText(text).width > room + 1) out.push(`select too narrow: ${name(el)} "${text}" (${Math.round(ctx.measureText(text).width)}>${Math.round(room)})`);
  }
  return [...new Set(out)];
}
