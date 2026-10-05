// Language of the first-run flow: the language suggested for this computer as the first guess,
// and switching the interface language live. A thin adapter over lib/language.

import { currentLang, systemLang, type Lang, type LanguageChoice } from "../lib/i18n";
import { detectLanguage, setLanguage } from "../lib/language";
import { writeSettings } from "./write";

export { detectLanguage };

/** The language of this computer (what „Wie das System“ stands for on the language step). */
export const osLanguage = (): Lang => systemLang();

export const uiLanguage = (): Lang => currentLang();

/** Switches the language everywhere at once and stores it after the flow's earlier answers. */
export function applyLanguage(lang: LanguageChoice): Promise<void> {
  return setLanguage(lang, (l) => writeSettings((s) => ({ ...s, locale: { ...s.locale, language: l } })));
}
