// The display language as a setting: the language suggested for this computer and a live
// switch. Saving the setting re-renders every window (`settings://changed` → `applyPrefs`) and
// makes the shell rebuild its tray, menus and jump list in the new language.

import { api } from "./api";
import { langFromLocale, setLang, type Lang } from "./i18n";
import { useApp } from "../store/app";

/**
 * The language to suggest for this computer: German when the operating system (or, failing
 * that, the webview) is set to German, else English.
 */
export async function detectLanguage(): Promise<Lang> {
  const os = await api.osLocale().catch(() => null);
  if (os) return langFromLocale(os);
  const tags = typeof navigator !== "undefined" ? [...(navigator.languages ?? []), navigator.language] : [];
  return tags.some((tag) => langFromLocale(tag) === "de") ? "de" : "en";
}

/** Switches the display language everywhere and stores it. */
export async function setLanguage(lang: Lang): Promise<void> {
  // Instant feedback in this window; the saved settings then reach the other windows and the shell.
  setLang(lang);
  const s = useApp.getState();
  const view = s.settings ?? (await api.settings());
  if (view.settings.locale.language === lang) return;
  const saved = await api.saveSettings({ ...view.settings, locale: { ...view.settings.locale, language: lang } });
  s.set({ settings: saved });
}
