// The setup steps after the intro and what each answer writes: pure functions on the settings,
// so the steps stay thin and the logic is tested (flow.test.ts).

import { langOf, type TKey } from "../lib/i18n";
import { PRESETS, autoAssignTiers, findProvider, fromPreset, OLLAMA_URL, providerName } from "../lib/providers";
import type { AiProvider, OllamaDetect, Settings } from "../lib/types";
import { timeTrackingOn } from "../lib/timetracking";

export const STEPS = ["language", "theme", "work", "workspace", "ai", "calendar", "sync", "backup", "security", "desktop", "done"] as const;
export type StepId = (typeof STEPS)[number];

/** Label in the stepper. */
export const STEP_LABELS: Record<StepId, TKey> = {
  language: "fr.step.language",
  theme: "fr.step.theme",
  work: "fr.step.work",
  workspace: "fr.step.workspace",
  ai: "fr.step.ai",
  calendar: "fr.step.calendar",
  sync: "fr.step.sync",
  backup: "fr.step.backup",
  security: "fr.step.security",
  desktop: "fr.step.desktop",
  done: "fr.step.done",
};

/** Settings section behind „Mehr in den Einstellungen“ (none for the language of the flow itself). */
export const STEP_SECTIONS: Partial<Record<StepId, string>> = {
  language: "locale",
  theme: "appearance",
  work: "time",
  ai: "ai",
  calendar: "calendar",
  sync: "backup",
  backup: "backup",
  security: "security",
  desktop: "desktop",
  workspace: "about",
};

export const stepIndex = (id: StepId) => STEPS.indexOf(id);
export const nextStep = (id: StepId): StepId => STEPS[Math.min(STEPS.length - 1, stepIndex(id) + 1)];
export const prevStep = (id: StepId): StepId => STEPS[Math.max(0, stepIndex(id) - 1)];
/** 0 on the first step, 1 on „Fertig“. */
export const progressOf = (id: StepId) => stepIndex(id) / (STEPS.length - 1);
export const isStep = (v: unknown): v is StepId => typeof v === "string" && (STEPS as readonly string[]).includes(v);

// ------------------------------------------------------------------ appearance

export type ThemeMode = Settings["theme"];

/** A theme card: sets the slot of its kind; with a fixed mode, the mode follows so the choice shows. */
export function withThemePick(s: Settings, def: { id: string; dark: boolean }): Settings {
  const appearance = { ...s.appearance, ...(def.dark ? { theme_dark: def.id } : { theme_light: def.id }) };
  const theme: ThemeMode = s.theme === "system" ? "system" : def.dark ? "dark" : "light";
  return { ...s, theme, appearance };
}

// ----------------------------------------------------------------------- work

/** Daily target in 0.25 h steps, 0.5–16 h (as the settings page allows). */
export const clampTarget = (h: number) => (Number.isFinite(h) ? Math.min(16, Math.max(0.5, Math.round(h * 4) / 4)) : 8);

export function withWorkday(s: Settings, day: number, on: boolean): Settings {
  const set = new Set(s.workdays);
  if (on) set.add(day);
  else set.delete(day);
  return { ...s, workdays: [...set].sort((a, b) => a - b) };
}

export const ROUNDING_STEPS = [0, 5, 6, 10, 15] as const;

export function withRounding(s: Settings, step: number, mode: "up" | "nearest" = s.time.rounding.mode): Settings {
  return { ...s, time: { ...s.time, rounding: { ...s.time.rounding, step_minutes: step, mode } } };
}

/** „Zeiterfassung mit SAP verwenden“: off hides the timesheet, projects and their commands. */
export const withTimeTracking = (s: Settings, on: boolean): Settings => ({ ...s, time: { ...s.time, enabled: on } });

/** Whether time tracking is on (the shared helper of lib/timetracking.ts). */
export { timeTrackingOn };

// ------------------------------------------------------------------------- AI

export type AiChoice = "none" | "local" | "company";

/** The LiteLLM provider of fresh settings: localhost:4000 without a key. It answers nobody. */
export function isUntouchedDefault(p: AiProvider, keys: string[]): boolean {
  return p.kind === "litellm" && /^https?:\/\/(localhost|127\.0\.0\.1):4000\/?$/i.test(p.base_url.trim()) && !keys.includes(p.id);
}

/** What the current settings amount to (for the prefilled AI step). */
export function aiChoiceOf(s: Settings, keys: string[]): AiChoice {
  const on = s.providers.filter((p) => p.enabled && !isUntouchedDefault(p, keys));
  if (!on.length) return "none";
  return on.every((p) => p.local) ? "local" : "company";
}

/** No AI: every provider is switched off (kept, so switching one on later is one click). */
export const withoutAi = (s: Settings): Settings => ({ ...s, providers: s.providers.map((p) => ({ ...p, enabled: false })) });

/**
 * A local Ollama: added (or switched on) first in the list, the unused default server switched off,
 * the local tier on it and the other tiers on its models where they point nowhere.
 */
export function withLocalModel(s: Settings, found: Pick<OllamaDetect, "url" | "models">, keys: string[]): Settings {
  let providers = s.providers.map((p) => (isUntouchedDefault(p, keys) ? { ...p, enabled: false } : p));
  let ollama = providers.find((p) => p.kind === "ollama");
  if (ollama) {
    ollama = { ...ollama, enabled: true, local: true };
    providers = [ollama, ...providers.filter((p) => p.id !== ollama!.id)];
  } else {
    const preset = PRESETS.find((p) => p.key === "ollama")!;
    ollama = { ...fromPreset(preset, providers), base_url: found.url || OLLAMA_URL };
    providers = [ollama, ...providers];
  }
  const chat = found.models.filter((m) => !/embed/i.test(m));
  let router = { ...s.router, local_provider: ollama.id, local_model: chat.includes(s.router.local_model) && s.router.local_provider === ollama.id ? s.router.local_model : (chat[0] ?? "") };
  router = { ...router, ...autoAssignTiers(router, providers, { [ollama.id]: found.models }) };
  return { ...s, providers, router, embedding_provider: s.embedding_provider && providers.some((p) => p.id === s.embedding_provider && p.enabled) ? s.embedding_provider : ollama.id };
}

/**
 * The company's server (LiteLLM, OpenAI-compatible, Azure) as edited in the provider dialog:
 * replaces the provider with its id or is added; the unused default is switched off; the standard
 * and reasoning tiers take its models where they point nowhere. The local tier is left alone:
 * private content must not move to a server by this choice.
 */
export function withCompanyProvider(s: Settings, p: AiProvider, models: string[], keys: string[]): Settings {
  const exists = s.providers.some((x) => x.id === p.id);
  let providers = exists ? s.providers.map((x) => (x.id === p.id ? { ...p, enabled: true } : x)) : [...s.providers, { ...p, enabled: true }];
  providers = providers.map((x) => (x.id !== p.id && isUntouchedDefault(x, keys) ? { ...x, enabled: false } : x));
  const auto = autoAssignTiers(s.router, providers, models.length ? { [p.id]: models } : {});
  const router = { ...s.router };
  for (const tier of ["standard", "reasoning"] as const) {
    const provider = auto[`${tier}_provider`];
    const model = auto[`${tier}_model`];
    if (provider && model) Object.assign(router, { [`${tier}_provider`]: provider, [`${tier}_model`]: model });
    else if (!findProvider(providers, router[`${tier}_provider`])?.enabled) Object.assign(router, { [`${tier}_provider`]: p.id });
  }
  return { ...s, providers, router };
}

/** The provider the company choice edits: the configured server, else the LiteLLM default. */
export function companyProvider(s: Settings, keys: string[]): AiProvider | null {
  return s.providers.find((p) => !p.local && p.enabled && !isUntouchedDefault(p, keys)) ?? s.providers.find((p) => p.kind === "litellm") ?? null;
}

// -------------------------------------------------------------------- summary

export interface SummaryRow {
  step: StepId;
  label: TKey;
  value: string;
}

export interface SummaryContext {
  t: (key: TKey, vars?: Record<string, string | number>) => string;
  /** Weekday names Monday first. */
  weekdays: string[];
  keys: string[];
  /** Autostart state (null: unknown). */
  autostart: boolean | null;
  /** Number of ICS calendars. */
  icsCount: number;
  /** The workspace choice made in this run, if any. */
  workspace: "samples" | "import" | "empty" | null;
  gitTokenSet: boolean;
  /** Step „Sicherheit“: encryption chosen (runs when the setup ends) and the app lock. */
  security?: { encrypt: boolean; encrypted: boolean; lock: boolean };
}

/** Hours with a decimal comma in German („7,5 h“). */
const hours = (h: number, lang: "de" | "en") => `${lang === "de" ? String(h).replace(".", ",") : String(h)} h`;

/** One line per step for the „Fertig“ page; each links back to its step. */
export function summaryRows(s: Settings, c: SummaryContext): SummaryRow[] {
  const { t } = c;
  const langChoice = s.locale?.language ?? "system";
  const lang = langOf(langChoice);
  const rows: SummaryRow[] = [];
  const name = lang === "en" ? "English" : "Deutsch";
  rows.push({ step: "language", label: "fr.sum.language", value: langChoice === "system" ? `${t("set.locale.followSystem")} (${name})` : name });
  const mode = s.theme === "system" ? t("set.appearance.system") : s.theme === "dark" ? t("set.appearance.dark") : t("set.appearance.light");
  rows.push({ step: "theme", label: "fr.sum.theme", value: mode });
  const days = s.workdays.map((d) => c.weekdays[d - 1]).filter(Boolean).join(", ");
  rows.push({
    step: "work",
    label: "fr.sum.work",
    value: timeTrackingOn(s)
      ? [days || t("fr.sum.noDays"), hours(s.daily_target_hours, lang), s.time.rounding.step_minutes ? t("fr.sum.rounding", { n: s.time.rounding.step_minutes }) : t("fr.sum.noRounding")].join(" · ")
      : t("fr.sum.noTime"),
  });
  rows.push({
    step: "workspace",
    label: "fr.sum.workspace",
    value: c.workspace === "samples" ? t("fr.ws.samples") : c.workspace === "import" ? t("fr.ws.import") : c.workspace === "empty" ? t("fr.ws.empty") : t("fr.sum.unchanged"),
  });
  const choice = aiChoiceOf(s, c.keys);
  const on = s.providers.filter((p) => p.enabled && !isUntouchedDefault(p, c.keys));
  rows.push({
    step: "ai",
    label: "fr.sum.ai",
    value: choice === "none" ? t("fr.ai.none") : `${t(choice === "local" ? "fr.ai.local" : "fr.ai.company")} · ${on.map(providerName).join(", ")}`,
  });
  const cal: string[] = [];
  if (s.calendar.outlook) cal.push("Outlook");
  if (c.icsCount) cal.push(t("fr.sum.ics", { n: c.icsCount }));
  rows.push({ step: "calendar", label: "fr.sum.calendar", value: cal.length ? cal.join(" · ") : t("fr.sum.off") });
  const g = s.git_sync;
  rows.push({ step: "sync", label: "fr.sum.sync", value: g.enabled ? `${g.remote_url || "–"} · ${g.branch}${c.gitTokenSet ? "" : ` · ${t("fr.sum.noToken")}`}` : t("fr.sum.off") });
  rows.push({
    step: "backup",
    label: "fr.sum.backup",
    value: [s.backup_dir ? s.backup_dir : t("fr.sum.defaultFolder"), t("fr.sum.keep", { n: s.backup_keep }), s.markdown_mirror ? t("fr.sum.mirror") : null].filter(Boolean).join(" · "),
  });
  const sec = c.security;
  rows.push({
    step: "security",
    label: "fr.sum.security",
    value:
      [sec?.encrypted ? t("fr.sum.encrypted") : sec?.encrypt ? t("fr.sum.encrypt") : null, sec?.lock ? t("fr.sum.lock") : null].filter(Boolean).join(" · ") || t("fr.sum.off"),
  });
  const desk = [
    c.autostart ? t("fr.sum.autostart") : null,
    s.close_to_tray ? t("fr.sum.tray") : null,
    s.capture_shortcut ? t("fr.sum.capture", { keys: s.capture_shortcut }) : t("fr.sum.noCapture"),
  ].filter(Boolean);
  rows.push({ step: "desktop", label: "fr.sum.desktop", value: desk.join(" · ") });
  return rows;
}
