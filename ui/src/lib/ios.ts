// What the iOS app (iPhone and iPad) does differently in the WebView (docs/ios.md). The WebView fills
// the window's safe area (src-tauri/src/mobile/ios.rs); the margins around it take the page's colors
// (`followBars`). Should a WebView reach under the bars anyway, the page asks for the whole viewport
// (`viewport-fit=cover`) and keeps its controls out of the safe-area insets
// (`env(safe-area-inset-*)`, the phone app's and the full app's styles).


/** iOS's WebView: an iPhone or iPad user agent, or an iPad that asks for desktop pages (it then
 *  reports a Mac with a touch screen). */
export function isIosWebView(nav: Pick<Navigator, "userAgent" | "maxTouchPoints"> = navigator): boolean {
  return /\b(iPhone|iPad|iPod)\b/.test(nav.userAgent) || (/\bMacintosh\b/.test(nav.userAgent) && (nav.maxTouchPoints ?? 0) > 1);
}

/** The viewport content with `viewport-fit=cover` (once). */
export function coverViewport(content: string): string {
  if (/viewport-fit\s*=/.test(content)) return content.replace(/viewport-fit\s*=\s*[a-z-]+/, "viewport-fit=cover");
  return content.trim() ? `${content.trim().replace(/,\s*$/, "")}, viewport-fit=cover` : "viewport-fit=cover";
}

/** The page fills the whole window; its styles keep clear of the insets. */
export function fitIosViewport(doc: Document = document): void {
  const meta = doc.querySelector<HTMLMetaElement>("meta[name='viewport']");
  if (meta) meta.content = coverViewport(meta.content);
  doc.documentElement.classList.add("platform-ios");
}

/** A computed CSS color as `#rrggbb` (as `cssHex` of the phone app, mobile/model.ts, which this
 *  small module does not load). */
function hex(color: string): string | null {
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(color.trim().toLowerCase());
  if (!rgb) return /^#[0-9a-f]{6}$/i.test(color.trim()) ? color.trim().toLowerCase() : null;
  return `#${rgb
    .slice(1, 4)
    .map((n) => Math.max(0, Math.min(255, Math.round(Number(n)))).toString(16).padStart(2, "0"))
    .join("")}`;
}

/** The first opaque background color at a point of the page (up the tree from the element there). */
function backgroundAt(x: number, y: number, doc: Document = document): string | null {
  for (let el = doc.elementFromPoint(x, y); el; el = el.parentElement) {
    const c = getComputedStyle(el).backgroundColor;
    if (c && !/^rgba\(.*,\s*0\)$|^transparent$/.test(c)) return c;
  }
  return getComputedStyle(doc.body).backgroundColor || null;
}

/** The margins around the WebView (status bar, home indicator; src-tauri/src/mobile/ios.rs) take
 *  the colors of the page's top and bottom edge, in every theme; the status bar's text follows the
 *  theme. Returns the clean-up. */
export function followBars(send: (dark: boolean, top: string, bottom: string) => void): () => void {
  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const top = hex(backgroundAt(window.innerWidth / 2, 1) ?? "");
      const bottom = hex(backgroundAt(window.innerWidth / 2, window.innerHeight - 1) ?? "") ?? top;
      if (top && bottom) send(document.documentElement.dataset.theme === "dark", top, bottom);
    });
  };
  apply();
  const watch = new MutationObserver(apply);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-theme-id"] });
  window.addEventListener("resize", apply);
  return () => {
    watch.disconnect();
    window.removeEventListener("resize", apply);
    cancelAnimationFrame(frame);
  };
}
