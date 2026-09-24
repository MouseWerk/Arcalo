import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/editor.css";
import "./styles/prefs.css";
import { App } from "./App";
import { CaptureApp } from "./components/CaptureApp";
import { SearchApp } from "./components/SearchApp";
import { IS_MAC } from "./lib/platform";
import { startSplash } from "./lib/splash";
import { describeError, logUi } from "./lib/devlog";

// The quick-capture window loads the same bundle with `#capture` (or `?capture`),
// the quick-search window with `#search`.
const captureMode = location.hash === "#capture" || new URLSearchParams(location.search).has("capture");
const searchMode = !captureMode && (location.hash === "#search" || new URLSearchParams(location.search).has("search"));

startSplash(captureMode || searchMode);

// Collect runtime errors so end-to-end tests can assert a clean console; they also go to
// the developer log (Settings → Protokoll).
const w = window as unknown as { __annaloErrors: string[] };
w.__annaloErrors = [];
window.addEventListener("error", (e) => {
  w.__annaloErrors.push(String(e.message));
  logUi("ERROR", e.error ? describeError(e.error) : `${e.message} (${e.filename}:${e.lineno})`);
});
window.addEventListener("unhandledrejection", (e) => {
  w.__annaloErrors.push(String(e.reason));
  logUi("ERROR", `Unbehandelte Ablehnung: ${describeError(e.reason)}`);
});
const origError = console.error;
console.error = (...args: unknown[]) => {
  w.__annaloErrors.push(args.map(String).join(" "));
  logUi("ERROR", args.map((a) => (a instanceof Error ? describeError(a) : typeof a === "string" ? a : describeError(a))).join(" "));
  origError(...args);
};

// Follow the OS theme until settings are loaded.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
// Windows 11: the window has a Mica backdrop that the chrome lets show through.
import("@tauri-apps/api/core")
  .then(({ invoke }) => invoke<boolean>("window_backdrop"))
  .then((mica) => mica && !captureMode && !searchMode && document.documentElement.classList.add("os-windows"))
  .catch(() => {});
// Windows with the app's own title bar: the tab bar is the title bar, window buttons top right.
import("@tauri-apps/api/core")
  .then(({ invoke }) => invoke<boolean>("window_frame"))
  .then((custom) => custom && !captureMode && !searchMode && document.documentElement.classList.add("frame-custom"))
  .catch(() => {});
// macOS: the tab bar sits in the title bar (overlay); the chrome leaves room for the traffic lights.
if (IS_MAC && !captureMode) document.documentElement.classList.add("os-macos");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {captureMode ? <CaptureApp /> : searchMode ? <SearchApp /> : <App />}
  </StrictMode>,
);
