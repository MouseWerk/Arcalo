// What the iOS app (iPhone and iPad) does differently in the WebView (docs/ios.md). The WebView
// covers the whole window, under the status bar and the home indicator (src-tauri/src/mobile/ios.rs):
// the page asks for the whole viewport (`viewport-fit=cover`) and keeps its controls out of the
// safe-area insets itself (`env(safe-area-inset-*)`, the phone app's and the full app's styles).

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
