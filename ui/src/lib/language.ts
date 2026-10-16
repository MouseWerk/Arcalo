// The display language as a setting: the language suggested for this computer and a live
// switch. Saving the setting re-renders every window (`settings://changed` → `applyPrefs`) and
// makes the shell rebuild its tray, menus and jump list in the new language.

import { api } from "./api";
import { langFromLocale, langOf, setLang, type Lang, type LanguageChoice } from "./i18n";
import { useApp } from "../store/app";
import { writeSettings } from "./settingsWrite";

/** German when the first (preferred) of these locale tags is German, else English. */
export function langFromLocales(tags: readonly (string | null | undefined)[] | undefined): Lang {
  return langFromLocale(tags?.find((tag) => !!tag?.trim())?.trim());
}

/** The webview's preferred language (it follows the operating system's). */
export function webviewLanguage(): Lang {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return langFromLocales(nav ? (nav.languages?.length ? nav.languages : [nav.language]) : undefined);
}

let detected: Lang | null = null;

/**
 * The language to suggest for this computer: German when the operating system (or, failing
 * that, the webview) is set to German, else English.
 */
export async function detectLanguage(): Promise<Lang> {
  const os = await api.osLocale().catch(() => null);
  detected = os ? langFromLocale(os) : webviewLanguage();
  return detected;
}

/** The last `detectLanguage` result, or the webview's language before the first one. */
export const detectedLanguage = (): Lang => detected ?? webviewLanguage();

/** Stores the language in the settings (the other windows and the shell follow). */
async function saveLanguage(lang: LanguageChoice): Promise<void> {
  const view = useApp.getState().settings ?? (await api.settings());
  if (view.settings.locale.language === lang) return;
  // Only the language changes: a settings change saved meanwhile stays.
  await writeSettings((cur) => ({ ...cur, locale: { ...cur.locale, language: lang } }));
}

/**
 * Switches the display language everywhere and stores it; `save` replaces the plain settings
 * save (the first-run flow queues it behind its other answers).
 */
export async function setLanguage(lang: LanguageChoice, save: (lang: LanguageChoice) => Promise<unknown> = saveLanguage): Promise<void> {
  // Instant feedback in this window; the saved settings then reach the other windows and the shell.
  setLang(langOf(lang));
  await save(lang);
}
