// Language of the first-run flow: the language suggested for this computer as the first guess,
// and switching the interface language live. A thin adapter over lib/language.

import { currentLang, type Lang } from "../lib/i18n";
import { detectLanguage, detectedLanguage, setLanguage } from "../lib/language";
import { writeSettings } from "./write";

export { detectLanguage };

/** The language of this computer (the badge on the language step). */
export const osLanguage = (): Lang => detectedLanguage();

export const uiLanguage = (): Lang => currentLang();

/** Switches the language everywhere at once and stores it after the flow's earlier answers. */
export function applyLanguage(lang: Lang): Promise<void> {
  return setLanguage(lang, (l) => writeSettings((s) => ({ ...s, locale: { ...s.locale, language: l } })));
}
