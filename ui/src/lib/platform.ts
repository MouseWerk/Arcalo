// The operating system the UI runs on. Synchronous (the WebView reports it), so labels and
// keyboard hints can be built while rendering.

/** Runs on macOS (WKWebView reports `MacIntel` on Apple Silicon, too). */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

/** Runs on Linux (there the selection can be taken over without copying it first). */
export const IS_LINUX = !IS_MAC && typeof navigator !== "undefined" && /Linux/i.test(navigator.platform || navigator.userAgent || "");
