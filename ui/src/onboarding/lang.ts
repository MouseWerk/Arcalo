// Language of the first-run flow: the OS locale as the first guess, and switching the interface
// language live. A thin adapter over `settings.locale.language` and lib/i18n: once a shared
// `setLanguage(lang)` exists, `applyLanguage` is the one place to call it from.

import type { Lang } from "../lib/i18n";
import { currentLang } from "../lib/i18n";
import { writeSettings } from "./write";

/** German for a German locale (de, de-AT, de-CH …), English for any other. */
export function languageFromLocales(locales: readonly string[] | undefined): Lang {
  const first = locales?.find((l) => !!l?.trim());
  if (!first) return "de";
  return /^de\b/i.test(first.trim()) ? "de" : "en";
}

/** The operating system's language as the webview reports it. */
export function osLanguage(): Lang {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return languageFromLocales(nav ? (nav.languages?.length ? nav.languages : [nav.language]) : undefined);
}

export const uiLanguage = (): Lang => currentLang();

/** Stores the language and applies it everywhere right away (settings → applyPrefs → setLang). */
export async function applyLanguage(lang: Lang): Promise<void> {
  await writeSettings((s) => ({ ...s, locale: { ...s.locale, language: lang } }));
}
