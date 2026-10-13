// The Android app's phone entry (`mobile.html`, the Android window's address in
// src-tauri/tauri.android.conf.json): the phone loads the mobile shell and what it uses, never the
// desktop app's bundle and stylesheets (q118 A18). The desktop entry is `ui/src/main.tsx`.
//
// On a large screen (a tablet, desktop mode, an external display, Android on a PC) or with the
// setting „Oberfläche: Vollständig“ the page goes over to the full app (`index.html`, 1.20) before
// the mobile shell loads, and later follows the window (lib/uiswitch.ts).
import "../lib/storageBoot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles/tokens.css";
import "../styles/base.css";
import { collectErrors } from "../lib/errorLog";
import { splashShown, startSplash } from "../lib/splash";
import { applyBootAppearance } from "../lib/prefs";
import { bootLang, setLang } from "../lib/i18n";
import { bootInterface, followInterface } from "../lib/uiswitch";
import { flushAll } from "../lib/flush";

const boot = bootLang();
if (boot) setLang(boot);
startSplash(false);
collectErrors();

// Follow the system's theme until the settings are loaded.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.classList.add("mobile");
applyBootAppearance();

// The browser check (e2e/mobile/shots.mjs) opens this page without Android: it stays the phone app.
const android = /\bAndroid\b/.test(navigator.userAgent);
if (!android || (await bootInterface("phone")) === "phone") {
  const { MobileApp } = await import("./MobileApp");
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <MobileApp />
    </StrictMode>,
  );
  splashShown();
  if (android) followInterface("phone", () => flushAll());
}
