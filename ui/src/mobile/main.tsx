// The Android companion app's own entry (`mobile.html`, the Android window's address in
// src-tauri/tauri.android.conf.json): the phone loads the mobile shell and what it uses, never the
// desktop app's bundle and stylesheets (q118 A18). The desktop entry is `ui/src/main.tsx`.
import "../lib/storageBoot";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "../styles/tokens.css";
import "../styles/base.css";
import { MobileApp } from "./MobileApp";
import { collectErrors } from "../lib/errorLog";
import { splashShown, startSplash } from "../lib/splash";
import { applyBootAppearance } from "../lib/prefs";
import { bootLang, setLang } from "../lib/i18n";

const boot = bootLang();
if (boot) setLang(boot);
startSplash(false);
collectErrors();

// Follow the system's theme until the settings are loaded.
document.documentElement.dataset.theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
document.documentElement.classList.add("mobile");
applyBootAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <MobileApp />
  </StrictMode>,
);
splashShown();
