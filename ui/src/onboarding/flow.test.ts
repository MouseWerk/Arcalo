import { describe, expect, it } from "vitest";
import { noteSystemLang, translate, type TKey } from "../lib/i18n";
import type { AiProvider, Settings } from "../lib/types";
import {
  LATER, STEPS, STEP_LABELS, STEP_SECTIONS, aiChoiceOf, clampTarget, companyProvider, isStep, isUntouchedDefault, nextStep, prevStep, progressOf, summaryRows, timeTrackingOn,
  withAi, withCompanyProvider, withLocalModel, withRounding, withThemePick, withTimeTracking, withWorkday,
} from "./flow";
import { langFromLocales } from "../lib/language";

const litellm: AiProvider = { id: "litellm", name: "", kind: "litellm", base_url: "http://localhost:4000", local: false, enabled: true, bypass_proxy: false, api_version: "", models: [] };

/** The parts of fresh settings the flow touches. */
function fresh(): Settings {
  return {
    theme: "system",
    appearance: { theme_light: "annalo-light", theme_dark: "annalo-dark" },
    workdays: [1, 2, 3, 4, 5],
    daily_target_hours: 8,
    time: { enabled: true, rounding: { step_minutes: 0, mode: "up", min_minutes: 0 } },
    locale: { language: "de", date_format: "de" },
    providers: [litellm],
    router: {
      local_model: "ollama/llama3.2",
      standard_model: "",
      reasoning_model: "",
      local_provider: "litellm",
      standard_provider: "litellm",
      reasoning_provider: "litellm",
      standard_threshold: 30,
      reasoning_threshold: 60,
      private_markers: ["#privat"],
    },
    embedding_provider: "litellm",
    calendar: { outlook: false },
    git_sync: { enabled: false, remote_url: "", branch: "main" },
    backup_dir: null,
    backup_keep: 14,
    markdown_mirror: true,
    close_to_tray: true,
    capture_shortcut: "Ctrl+Shift+Space",
  } as unknown as Settings;
}

describe("first-run steps", () => {
  it("walks the steps in order and clamps at the ends", () => {
    expect(STEPS[0]).toBe("language");
    expect(STEPS.at(-1)).toBe("done");
    expect(nextStep("language")).toBe("theme");
    expect(prevStep("language")).toBe("language");
    expect(nextStep("done")).toBe("done");
    expect(prevStep("done")).toBe("workspace");
    // Short: language, theme, AI, time, calendar, start, done.
    expect(STEPS).toEqual(["language", "theme", "ai", "work", "calendar", "workspace", "done"]);
    expect(progressOf("language")).toBe(0);
    expect(progressOf("done")).toBe(1);
    expect(isStep("ai")).toBe(true);
    expect(isStep("nope")).toBe(false);
    // Every step has a label in both languages; every settings link names a real section.
    for (const s of STEPS) {
      expect(translate("de", STEP_LABELS[s])).not.toBe(STEP_LABELS[s]);
      expect(translate("en", STEP_LABELS[s])).not.toBe(STEP_LABELS[s]);
    }
    expect(Object.values(STEP_SECTIONS).every((x) => ["locale", "appearance", "time", "ai", "calendar", "about"].includes(x!))).toBe(true);
    // „Fertig“ links to what the setup leaves to the settings.
    expect(LATER.map((l) => l.section)).toEqual(["backup", "backup", "security", "desktop"]);
  });

  it("guesses the language from the OS locales", () => {
    expect(langFromLocales(["de-DE", "en-US"])).toBe("de");
    expect(langFromLocales(["de-AT"])).toBe("de");
    expect(langFromLocales(["en-GB", "de-DE"])).toBe("en");
    expect(langFromLocales(["fr-FR"])).toBe("en");
    expect(langFromLocales(["", "de"])).toBe("de");
    // Nothing to go by: English, the default language.
    expect(langFromLocales([])).toBe("en");
    expect(langFromLocales(undefined)).toBe("en");
  });

  it("theme cards set their slot; a fixed mode follows the card", () => {
    const s = fresh();
    const a = withThemePick(s, { id: "tokyo-night", dark: true });
    expect(a.theme).toBe("system");
    expect(a.appearance.theme_dark).toBe("tokyo-night");
    expect(a.appearance.theme_light).toBe("annalo-light");
    const b = withThemePick({ ...s, theme: "dark" }, { id: "github-light", dark: false });
    expect(b.theme).toBe("light");
    expect(b.appearance.theme_light).toBe("github-light");
  });

  it("work: time tracking switch, workdays, target and rounding", () => {
    const s = fresh();
    expect(timeTrackingOn(s)).toBe(true);
    expect(timeTrackingOn(withTimeTracking(s, false))).toBe(false);
    // Settings from before the switch count as on.
    expect(timeTrackingOn({ ...s, time: { ...s.time, enabled: undefined as unknown as boolean } })).toBe(true);
    expect(withWorkday(s, 6, true).workdays).toEqual([1, 2, 3, 4, 5, 6]);
    expect(withWorkday(s, 3, false).workdays).toEqual([1, 2, 4, 5]);
    expect(withWorkday(withWorkday(s, 7, true), 7, true).workdays).toEqual([1, 2, 3, 4, 5, 7]);
    expect(clampTarget(7.6)).toBe(7.5);
    expect(clampTarget(0)).toBe(0.5);
    expect(clampTarget(40)).toBe(16);
    expect(clampTarget(NaN)).toBe(8);
    const r = withRounding(s, 15, "nearest").time.rounding;
    expect(r).toEqual({ step_minutes: 15, mode: "nearest", min_minutes: 0 });
    expect(withRounding(s, 5).time.rounding.mode).toBe("up");
  });

  it("AI: „Ohne KI“ only switches AI off; the providers stay for „Mit KI“", () => {
    const s = withAi(fresh(), false);
    expect(s.ai.enabled).toBe(false);
    expect(s.providers).toEqual(fresh().providers);
    expect(withAi(s, true).ai.enabled).toBe(true);
    expect(withAi(s, true).providers).toEqual(fresh().providers);
    // The untouched default counts as nothing configured.
    expect(isUntouchedDefault(litellm, [])).toBe(true);
    expect(isUntouchedDefault(litellm, ["litellm"])).toBe(false);
    expect(aiChoiceOf(fresh(), [])).toBe("none");
    expect(aiChoiceOf(fresh(), ["litellm"])).toBe("company");
  });

  it("AI: a found Ollama becomes the local model and takes the empty tiers", () => {
    const s = withLocalModel(fresh(), { url: "http://localhost:11434", models: ["llama3.2", "nomic-embed-text"] }, []);
    expect(s.providers[0]).toMatchObject({ id: "ollama", kind: "ollama", local: true, enabled: true });
    expect(s.providers.find((p) => p.id === "litellm")?.enabled).toBe(false);
    expect(s.router.local_provider).toBe("ollama");
    expect(s.router.local_model).toBe("llama3.2");
    expect(s.router.standard_provider).toBe("ollama");
    expect(s.embedding_provider).toBe("ollama");
    expect(aiChoiceOf(s, [])).toBe("local");
    // Again: the existing Ollama is reused, not added twice.
    const again = withLocalModel(s, { url: "http://localhost:11434", models: ["llama3.2"] }, []);
    expect(again.providers.filter((p) => p.kind === "ollama")).toHaveLength(1);
    // A configured server stays switched on next to it.
    const both = withLocalModel(fresh(), { url: "", models: [] }, ["litellm"]);
    expect(both.providers.find((p) => p.id === "litellm")?.enabled).toBe(true);
    expect(both.providers[0].base_url).toBe("http://localhost:11434");
  });

  it("AI: the company server replaces the default and never takes the local tier", () => {
    const server: AiProvider = { ...litellm, base_url: "https://llm.firma.de" };
    const s = withCompanyProvider(fresh(), server, ["gpt-4o", "o3-mini", "text-embedding-3-small"], ["litellm"]);
    expect(s.providers).toHaveLength(1);
    expect(s.providers[0].base_url).toBe("https://llm.firma.de");
    expect(s.router.standard_model).toBe("gpt-4o");
    expect(s.router.reasoning_model).toBe("o3-mini");
    expect(s.router.local_provider).toBe("litellm");
    expect(s.router.local_model).toBe("ollama/llama3.2");
    // Another kind is added; the unused default is switched off.
    const azure: AiProvider = { ...litellm, id: "azure", kind: "azure", base_url: "https://firma.openai.azure.com", api_version: "2024-10-21" };
    const t = withCompanyProvider(fresh(), azure, [], []);
    expect(t.providers.map((p) => [p.id, p.enabled])).toEqual([
      ["litellm", false],
      ["azure", true],
    ]);
    expect(t.router.standard_provider).toBe("azure");
    expect(companyProvider(t, [])?.id).toBe("azure");
    expect(aiChoiceOf(t, [])).toBe("company");
  });
});

describe("first-run summary", () => {
  const ctx = (lang: "de" | "en") => ({
    t: (k: TKey, v?: Record<string, string | number>) => translate(lang, k, v),
    weekdays: lang === "de" ? ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"] : ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"],
    keys: [],
    icsCount: 0,
    workspace: null,
  });

  it("has one row per step before „Fertig“, in the chosen language", () => {
    const s = { ...fresh(), daily_target_hours: 7.5, ai: { enabled: true } } as Settings;
    const rows = summaryRows(s, ctx("de"));
    expect(rows.map((r) => r.step)).toEqual(STEPS.filter((x) => x !== "done"));
    const by = Object.fromEntries(rows.map((r) => [r.step, r.value]));
    expect(by.language).toBe("Deutsch");
    expect(by.work).toBe("Mo, Di, Mi, Do, Fr · 7,5 h · ohne Rundung");
    expect(by.ai).toBe("Mit KI · Modell später");
    expect(by.calendar).toBe("Aus");
    expect(by.workspace).toBe("unverändert");
    // „Ohne KI“, also when a policy decides it.
    expect(Object.fromEntries(summaryRows({ ...s, ai: { enabled: false } } as Settings, ctx("de")).map((r) => [r.step, r.value])).ai).toBe("Ohne KI");
    expect(Object.fromEntries(summaryRows(s, { ...ctx("de"), aiPolicyOff: true }).map((r) => [r.step, r.value])).ai).toBe("Ohne KI");
  });

  it("reflects the answers: English, no time tracking, Outlook, sample content", () => {
    const s = {
      ...fresh(),
      locale: { language: "en", date_format: "de" },
      time: { enabled: false, rounding: { step_minutes: 15, mode: "up", min_minutes: 0 } },
      calendar: { outlook: true },
    } as unknown as Settings;
    const by = Object.fromEntries(summaryRows(s, { ...ctx("en"), icsCount: 2, workspace: "samples" as const }).map((r) => [r.step, r.value]));
    expect(by.language).toBe("English");
    expect(by.work).toBe("No time tracking");
    expect(by.workspace).toBe("With sample content");
    expect(by.calendar).toBe("Outlook · 2 ICS");
    expect(by.ai).toBe("With AI · model later");
  });

  it("names „Wie das System“ with the language it stands for", () => {
    const s = { ...fresh(), locale: { language: "system", date_format: "de" } } as Settings;
    noteSystemLang("en");
    expect(summaryRows(s, ctx("en"))[0].value).toBe("Same as system (English)");
    noteSystemLang("de");
    expect(summaryRows(s, ctx("de"))[0].value).toBe("Wie das System (Deutsch)");
  });
});
