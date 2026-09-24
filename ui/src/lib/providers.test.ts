import { describe, expect, it } from "vitest";
import { usableProvider, autoAssignTiers, fromPreset, localTierNotLocal, missingTiers, modelLabel, needsKey, PRESETS, priceFor, slug, tierRef, uniqueId, validateProvider } from "./providers";
import type { AiProvider, PriceRule, RouterConfig } from "./types";

const preset = (key: string) => PRESETS.find((p) => p.key === key)!;
const litellm: AiProvider = { id: "litellm", name: "LiteLLM", kind: "litellm", base_url: "http://127.0.0.1:4000", local: false, enabled: true, bypass_proxy: false, api_version: "", models: [] };
const ollama = fromPreset(preset("ollama"), [litellm]);
const openai = fromPreset(preset("openai"), [litellm, ollama]);
const router: RouterConfig = {
  local_model: "ollama/llama3.2",
  standard_model: "cloud-standard",
  reasoning_model: "cloud-reasoning",
  local_provider: "litellm",
  standard_provider: "litellm",
  reasoning_provider: "litellm",
  standard_threshold: 30,
  reasoning_threshold: 60,
  private_markers: [],
};

describe("providers", () => {
  it("creates providers from presets with unique ids, local ones without proxy", () => {
    expect(ollama).toMatchObject({ id: "ollama", kind: "ollama", base_url: "http://localhost:11434", local: true, bypass_proxy: true });
    expect(openai).toMatchObject({ id: "openai", kind: "openai", base_url: "https://api.openai.com/v1", local: false, bypass_proxy: false });
    expect(fromPreset(preset("ollama"), [ollama]).id).toBe("ollama-2");
    expect(fromPreset(preset("azure"), []).api_version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(uniqueId("", [])).toBe("anbieter");
    expect(slug("Größe & Straße")).toBe("grosse-strasse");
  });

  it("knows which providers need a key and checks addresses", () => {
    expect(needsKey(ollama)).toBe(false);
    expect(needsKey(litellm)).toBe(true);
    expect(needsKey({ kind: "openai", base_url: "http://localhost:1234/v1" })).toBe(false);
    expect(needsKey(openai)).toBe(true);
    expect(validateProvider({ ...openai, base_url: "api.openai.com" })).toMatch(/http/);
    expect(validateProvider(fromPreset(preset("azure"), []))).toMatch(/Azure/);
    expect(validateProvider(openai)).toBeNull();
  });

  it("finds a usable provider: one without key need, or with its key", () => {
    const view = (providers: AiProvider[], keys: string[]) => ({ settings: { providers } as never, provider_keys: keys });
    expect(usableProvider(view([litellm], []))).toBe(false);
    expect(usableProvider(view([litellm], ["litellm"]))).toBe(true);
    expect(usableProvider(view([litellm, ollama], []))).toBe(true);
    expect(usableProvider(view([litellm, { ...ollama, enabled: false }], []))).toBe(false);
  });

  it("labels models with their provider only when there are several", () => {
    expect(modelLabel([litellm], "litellm", "gpt")).toBe("gpt");
    expect(modelLabel([litellm, ollama], "ollama", "llama3.2")).toBe("llama3.2 · Ollama");
    expect(modelLabel([litellm, ollama], "", "x")).toBe("x · LiteLLM");
  });

  it("assigns tiers across providers: local to local providers, the rest to the cloud", () => {
    const lists = { litellm: [], ollama: ["llama3.2:latest", "nomic-embed-text"], openai: ["gpt-4o", "gpt-4o-mini", "o3", "text-embedding-3-small"] };
    const providers = [litellm, ollama, openai];
    expect(missingTiers(router, providers, lists)).toEqual([]);
    const moved = { ...router, local_provider: "ollama", standard_provider: "openai", reasoning_provider: "openai" };
    expect(missingTiers(moved, providers, lists)).toEqual(["local", "standard", "reasoning"]);
    const patch = autoAssignTiers(moved, providers, lists);
    expect(patch).toEqual({
      local_provider: "ollama",
      local_model: "llama3.2:latest",
      standard_provider: "openai",
      standard_model: "gpt-4o",
      reasoning_provider: "openai",
      reasoning_model: "o3",
    });
    const done = { ...moved, ...patch };
    expect(tierRef(done, "standard")).toEqual({ provider: "openai", model: "gpt-4o" });
    expect(missingTiers(done, providers, lists)).toEqual([]);
    // A switched-off provider counts as missing.
    expect(missingTiers(done, [litellm, { ...ollama, enabled: false }, openai], lists)).toEqual(["local"]);
  });

  it("with one LiteLLM server: maps placeholder tiers by name, never to an embedding model", () => {
    const lists = { litellm: ["azure-gpt-4o", "gpt-4o-mini", "o3-reasoning", "text-embedding-3"] };
    expect(autoAssignTiers(router, [litellm], lists)).toEqual({
      local_provider: "litellm",
      local_model: "gpt-4o-mini",
      standard_provider: "litellm",
      standard_model: "azure-gpt-4o",
      reasoning_provider: "litellm",
      reasoning_model: "o3-reasoning",
    });
    const ok = { ...router, standard_model: "firma" };
    expect(autoAssignTiers(ok, [litellm], { litellm: ["firma", "firma-embed"] })).toEqual({ local_provider: "litellm", local_model: "firma", reasoning_provider: "litellm", reasoning_model: "firma" });
  });

  it("warns when the local tier is on a provider that is not local", () => {
    expect(localTierNotLocal({ providers: [litellm, ollama], router })?.id).toBe("litellm");
    expect(localTierNotLocal({ providers: [litellm, ollama], router: { ...router, local_provider: "ollama" } })).toBeNull();
  });

  it("reads prices like the core: exact, longest prefix, provider rules first, local free", () => {
    const rules: PriceRule[] = [
      { provider: "", model: "gpt-4o*", input_per_mtok: 2.5, output_per_mtok: 10 },
      { provider: "", model: "gpt-4o-mini*", input_per_mtok: 0.15, output_per_mtok: 0.6 },
      { provider: "azure", model: "gpt-4o*", input_per_mtok: 5, output_per_mtok: 15 },
    ];
    expect(priceFor(rules, openai, "gpt-4o-mini-2024")).toEqual({ input: 0.15, output: 0.6 });
    expect(priceFor(rules, openai, "openai/gpt-4o")).toEqual({ input: 2.5, output: 10 });
    expect(priceFor(rules, { ...openai, id: "azure" }, "gpt-4o")).toEqual({ input: 5, output: 15 });
    expect(priceFor(rules, ollama, "gpt-4o")).toEqual({ input: 0, output: 0 });
    expect(priceFor(rules, openai, "unbekannt")).toBeNull();
  });
});
