import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/app.css";
import "./styles/editor.css";
import "./styles/prefs.css";
import "./styles/settings.css";
import "./styles/firstrun.css";
import "./styles/dashboard.css";
import "./styles/workwidgets.css";
import "./styles/a11y.css";
import { App } from "./App";
import { CaptureApp } from "./components/CaptureApp";
import { SearchApp } from "./components/SearchApp";
import { PresenterApp } from "./components/Presentation";
import { KeyGateApp } from "./components/KeyGateApp";
import { LockGate, PopupLockGate } from "./components/LockScreen";
import { initBackdrop } from "./lib/backdrop";
import { IS_MAC } from "./lib/platform";
import { splashShown, startSplash } from "./lib/splash";
import { trackModKey } from "./lib/modkey";
import { installTooltips } from "./lib/tooltip";
import { describeError, logUi } from "./lib/devlog";
import { applyBootAppearance, followLocale } from "./lib/prefs";
import { bootLang, setLang } from "./lib/i18n";

// The Android shell is loaded only there (a chunk of its own): the desktop bundle stays as it was.
const MobileApp = lazy(() => import("./mobile/MobileApp").then((m) => ({ default: m.MobileApp })));

// The quick-capture window loads the same bundle with `#capture` (or `?capture`),
// the quick-search window with `#search`.
const captureMode = location.hash === "#capture" || new URLSearchParams(location.search).has("capture");
const searchMode = !captureMode && (location.hash === "#search" || new URLSearchParams(location.search).has("search"));
// The presenter view of a presentation on a second monitor.
const presenterMode = location.hash === "#presenter";
// The recovery screen of an encrypted database whose key is missing (instead of the app).
const keygateMode = location.hash === "#keygate";
// The Android companion app (ui/src/mobile): its own shell with tabs; `?mobile` shows it in a
// browser for the screenshot check (e2e/mobile/shots.mjs).
const mobileMode = /\bAndroid\b/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mobile");

// The language the shell resolved („Wie das System“ included) holds from the first frame on.
const boot = bootLang();
if (boot) setLang(boot);
startSplash(captureMode || searchMode || presenterMode || keygateMode);
if (!mobileMode) {
  trackModKey();
  installTooltips();
}

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
  logUi("ERROR", `Unhandled rejection: ${describeError(e.reason)}`);
});
const origError = console.error;
console.error = (...args: unknown[]) => {
  w.__annaloErrors.push(args.map(String).join(" "));
  logUi("ERROR", args.map((a) => (a instanceof Error ? describeError(a) : typeof a === "string" ? a : describeError(a))).join(" "));
  origError(...args);
};

// Follow the OS theme until settings are loaded.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
// Windows 11: the window can have a Mica or Acrylic backdrop that the app lets show through.
if (mobileMode) {
  document.documentElement.classList.add("mobile");
  applyBootAppearance();
} else if (!captureMode && !searchMode && !presenterMode && !keygateMode) {
  initBackdrop();
  applyBootAppearance();
}
// Windows with the app's own title bar: the tab bar is the title bar, window buttons top right.
if (!mobileMode) {
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("window_frame"))
    .then((custom) => custom && !captureMode && !searchMode && !presenterMode && document.documentElement.classList.add("frame-custom"))
    .catch(() => {});
}
// macOS: the tab bar sits in the title bar (overlay); the chrome leaves room for the traffic lights.
if (IS_MAC && !captureMode) document.documentElement.classList.add("os-macos");

// The small windows follow the language and formats of the settings (the main window does so
// through its store).
if (captureMode || searchMode || presenterMode) followLocale();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {mobileMode ? (
      <Suspense fallback={null}>
        <MobileApp />
      </Suspense>
    ) : keygateMode ? (
      <KeyGateApp />
    ) : captureMode ? (
      <PopupLockGate>
        <CaptureApp />
      </PopupLockGate>
    ) : searchMode ? (
      <PopupLockGate>
        <SearchApp />
      </PopupLockGate>
    ) : presenterMode ? (
      // The presenter view shows the slides and their notes: covered while locked too.
      <PopupLockGate>
        <PresenterApp />
      </PopupLockGate>
    ) : (
      // App-Sperre: the lock screen instead of the app while locked.
      <LockGate>
        <App />
      </LockGate>
    )}
  </StrictMode>,
);

// The main window starts hidden and appears once the app script runs: the page and the splash
// styles are loaded by then, so there is no unstyled page and no white flash before the splash.
// (Not after a requestAnimationFrame: hidden webviews do not run frames.)
if (mobileMode) {
  splashShown();
} else if (!captureMode && !searchMode && !presenterMode && !keygateMode) {
  import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke("window_ready"))
    .catch(() => {})
    .finally(splashShown);
}
