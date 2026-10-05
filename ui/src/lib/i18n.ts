// Display language: English (default) and German. The strings live in `ui/src/locales/`
// (`en.ts` is the source of the key type, `de.ts` must have the same keys). Dates and numbers
// do not follow the display language but the regional settings (`format.ts`).
//
// `t(key, vars)` translates in the current language: `{name}` is replaced by `vars.name`, and a
// plural entry (`{ one, other }`) picks its form by `vars.n` with Intl.PluralRules.
// Components call `useT()`, which re-renders them when the language changes (the separate
// windows follow through `settings://changed` → `applyPrefs` → `setLang`).

import { useMemo, useSyncExternalStore } from "react";
import { en, type Msg } from "../locales/en";
import { de } from "../locales/de";

/**
 * Strings added as `[Deutsch, English]` pairs, the format before the catalogs: they join both
 * catalogs, so code written against the old dictionary keeps working. New strings go into
 * `locales/en.ts` and `locales/de.ts`.
 */
const ENTRIES = {} as const satisfies Record<string, readonly [string, string]>;

export type TKey = keyof typeof en | keyof typeof ENTRIES;
export type Lang = "de" | "en";
export type TVars = Record<string, string | number>;

const pairs = (i: 0 | 1) => Object.fromEntries(Object.entries(ENTRIES as Record<string, readonly [string, string]>).map(([k, v]) => [k, v[i]]));

export const DICTS: Record<Lang, Record<TKey, Msg>> = { en: { ...en, ...pairs(1) }, de: { ...de, ...pairs(0) } };

/** The setting Settings → Sprache & Format stores: a language or „Wie das System“. */
export type LanguageChoice = "system" | Lang;

/** "de" for a German locale tag („de“, „de-AT“, „de_CH.UTF-8“), else "en" (as the shell reads them). */
export const langFromLocale = (tag: string | undefined | null): Lang => (/^de(?:$|[-_.@])/i.test(tag?.trim() ?? "") ? "de" : "en");

/**
 * The display language the shell resolved before the page loaded (an initialization script of
 * the main window sets it): the splash and the first frame are in it, before the settings arrive.
 */
export function bootLang(): Lang | null {
  const v = typeof window === "undefined" ? undefined : (window as { __ARCALO_LANG__?: unknown }).__ARCALO_LANG__;
  return v === "de" || v === "en" ? v : null;
}

let lang: Lang = bootLang() ?? "en";
let version = 0;
const listeners = new Set<() => void>();

export const currentLang = () => lang;

let system: Lang | null = null;

/** Notes the system language as the shell read it at start (`system_language` of the settings). */
export function noteSystemLang(l: string | null | undefined) {
  if (l === "de" || l === "en") system = l;
}

/** The language „Wie das System“ stands for: the shell's reading, else the webview's. */
export function systemLang(): Lang {
  if (system) return system;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return langFromLocale(nav?.languages?.[0] ?? nav?.language);
}

/** The display language a stored choice stands for („Wie das System“ resolved). */
export const langOf = (choice: string | null | undefined): Lang => (choice === "de" || choice === "en" ? choice : systemLang());

/** Switches the language (and re-renders every component using `useT`). */
export function setLang(l: Lang) {
  const next: Lang = l === "de" ? "de" : "en";
  if (typeof document !== "undefined") document.documentElement.lang = next;
  if (next === lang) return;
  lang = next;
  refreshI18n();
}

/** Calls `f` after the language (or the shortcut hints) changed; returns the unsubscribe. */
export function onI18nChange(f: () => void): () => void {
  listeners.add(f);
  return () => void listeners.delete(f);
}

/** Re-renders `useT` components (language or shortcut hints changed). */
export function refreshI18n() {
  version++;
  listeners.forEach((f) => f());
}

const plurals: Partial<Record<Lang, Intl.PluralRules>> = {};
const pluralRules = (l: Lang) => (plurals[l] ??= new Intl.PluralRules(l));

export function translate(l: Lang, key: TKey, vars?: TVars): string {
  const msg: Msg | undefined = DICTS[l][key] ?? DICTS.en[key];
  if (msg === undefined) return key;
  let s: string;
  if (typeof msg === "string") s = msg;
  else {
    const n = Number(vars?.n ?? vars?.count ?? 0);
    s = pluralRules(l).select(n) === "one" ? msg.one : msg.other;
  }
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** Translation in the current language (outside React, or in event handlers). */
export const t = (key: TKey, vars?: TVars) => translate(lang, key, vars);

const otherTexts = new Map<string, Map<string, string>>();
/**
 * `text` (a catalog text in the current language under one of the key `prefix`es) in the other
 * language, or `""`: command palette and slash menu find a command by either name.
 */
export function inOtherLanguage(text: string, prefix: string): string {
  const id = `${lang}|${prefix}`;
  let m = otherTexts.get(id);
  if (!m) {
    m = new Map();
    const other: Lang = lang === "en" ? "de" : "en";
    for (const k of Object.keys(DICTS.en) as TKey[]) if (k.startsWith(prefix)) m.set(translate(lang, k), translate(other, k));
    otherTexts.set(id, m);
  }
  return m.get(text) ?? "";
}

/** Whether a key exists (for keys built at run time). */
export const hasKey = (key: string): key is TKey => key in DICTS.en;

/**
 * `fields` plus a `label` that is translated whenever it is read: for option lists defined
 * once at module level (`[withLabel({ value: "all" }, "att.kind.all"), …]`).
 */
export function withLabel<T extends object>(fields: T, key: TKey): T & { readonly label: string } {
  return Object.defineProperty({ ...fields }, "label", { get: () => t(key), enumerable: true }) as T & { readonly label: string };
}

const subscribe = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

/**
 * `t` for components: re-renders when the language or the shortcut hints change. The function
 * is new after every change, so memos that list it as a dependency are computed again.
 */
export function useT() {
  const v = useSyncExternalStore(subscribe, () => version);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => ((key: TKey, vars?: TVars) => translate(lang, key, vars)) as typeof t, [v]);
}

/** The current language for components (re-renders on a switch). */
export function useLang(): Lang {
  useSyncExternalStore(subscribe, () => version);
  return lang;
}
