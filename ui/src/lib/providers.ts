// AI providers (Settings → KI): presets, ids, labels, tier assignment across providers and
// the price table. Pure functions; the settings page and the assistant use them.

import type { AiProvider, PriceRule, ProviderKind, RouterConfig, Settings, SettingsView, Tier } from "./types";

export const KIND_LABELS: Record<ProviderKind, string> = {
  litellm: "LiteLLM",
  openai: "OpenAI-kompatibel",
  azure: "Azure OpenAI",
  ollama: "Ollama",
};

export interface ProviderPreset {
  /** Stable key of the preset (menu, tests). */
  key: string;
  label: string;
  kind: ProviderKind;
  url: string;
  /** Runs on this machine: local and without proxy by default. */
  local?: boolean;
  hint: string;
}

export const OLLAMA_URL = "http://localhost:11434";

/** Presets of the „Anbieter hinzufügen“ menu. */
export const PRESETS: ProviderPreset[] = [
  { key: "ollama", label: "Ollama", kind: "ollama", url: OLLAMA_URL, local: true, hint: "Lokale Modelle, kein Schlüssel nötig." },
  { key: "lmstudio", label: "LM Studio", kind: "openai", url: "http://localhost:1234/v1", local: true, hint: "Lokaler Server von LM Studio (OpenAI-kompatibel)." },
  { key: "openai", label: "OpenAI", kind: "openai", url: "https://api.openai.com/v1", hint: "API-Schlüssel von platform.openai.com." },
  { key: "azure", label: "Azure OpenAI", kind: "azure", url: "https://RESSOURCE.openai.azure.com", hint: "Endpunkt der Ressource, API-Version und Deployment-Namen; Schlüssel als api-key." },
  { key: "mistral", label: "Mistral", kind: "openai", url: "https://api.mistral.ai/v1", hint: "API-Schlüssel von console.mistral.ai." },
  { key: "groq", label: "Groq", kind: "openai", url: "https://api.groq.com/openai/v1", hint: "API-Schlüssel von console.groq.com." },
  { key: "openrouter", label: "OpenRouter", kind: "openai", url: "https://openrouter.ai/api/v1", hint: "Viele Modelle über einen Schlüssel." },
  { key: "litellm", label: "LiteLLM", kind: "litellm", url: "http://localhost:4000", hint: "LiteLLM-Proxy mit Virtual Key oder Master Key." },
  { key: "custom", label: "Anderer OpenAI-kompatibler Server", kind: "openai", url: "https://", hint: "vLLM, llama.cpp, LocalAI, eigene Gateways …" },
];

/** Where the address of a kind points to. */
export const URL_HINTS: Record<ProviderKind, string> = {
  litellm: "Adresse des LiteLLM-Proxys, z. B. https://llm.firma.de",
  openai: "Basis-URL mit Version, z. B. https://api.openai.com/v1",
  azure: "Endpunkt der Ressource, z. B. https://firma.openai.azure.com",
  ollama: `Standard: ${OLLAMA_URL}`,
};

/** `[a-z0-9-]` from a name (as the core's `slug`). */
export function slug(s: string): string {
  const map: Record<string, string> = { ä: "a", ö: "o", ü: "u", ß: "ss" };
  let out = "";
  for (const c of s.trim().toLowerCase()) {
    const plain = map[c] ?? c;
    if (/^[a-z0-9]+$/.test(plain)) out += plain;
    else if (out && !out.endsWith("-")) out += "-";
  }
  return out.replace(/-+$/, "").slice(0, 40);
}

/** An id for a new provider named `name` that no other provider has. */
export function uniqueId(name: string, taken: string[]): string {
  const base = slug(name) || "anbieter";
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

/** A new provider from a preset (id unique among `existing`). */
export function fromPreset(p: ProviderPreset, existing: AiProvider[]): AiProvider {
  const name = p.key === "custom" ? "" : p.label;
  return {
    id: uniqueId(
      name || "server",
      existing.map((x) => x.id),
    ),
    name,
    kind: p.kind,
    base_url: p.key === "custom" ? "" : p.url,
    local: !!p.local,
    enabled: true,
    bypass_proxy: !!p.local,
    api_version: p.kind === "azure" ? "2024-10-21" : "",
    models: [],
  };
}

/** Whether `url` points at this machine. */
export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url.trim()).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1";
  } catch {
    return false;
  }
}

/** Whether requests need a key (as the core's `needs_key`). */
export function needsKey(p: Pick<AiProvider, "kind" | "base_url">): boolean {
  if (p.kind === "litellm") return true;
  if (p.kind === "ollama") return false;
  return !isLoopback(p.base_url);
}

/** Whether any switched-on provider can be asked (it needs no key or has one). */
export function usableProvider(view: Pick<SettingsView, "settings" | "provider_keys">): boolean {
  return view.settings.providers.some((p) => p.enabled && (!needsKey(p) || view.provider_keys.includes(p.id)));
}

/** Problems that keep the dialog from saving (empty = fine). */
export function validateProvider(p: AiProvider): string | null {
  const url = p.base_url.trim();
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return "Die Adresse muss mit http:// oder https:// beginnen.";
  if (p.kind === "azure" && /RESSOURCE/.test(url)) return "Trage den Endpunkt deiner Azure-Ressource ein.";
  return null;
}

export const providerName = (p: Pick<AiProvider, "name" | "kind">) => p.name.trim() || KIND_LABELS[p.kind];

/** The provider `id` ("" = the first one, as the core resolves it). */
export function findProvider(providers: AiProvider[], id: string | undefined): AiProvider | undefined {
  if (!id) return providers.find((p) => p.enabled) ?? providers[0];
  return providers.find((p) => p.id === id);
}

/** `model · Provider` when there is more than one provider, the model alone otherwise. */
export function modelLabel(providers: AiProvider[], providerId: string | undefined, model: string): string {
  if (providers.length <= 1) return model;
  const p = findProvider(providers, providerId);
  return p ? `${model} · ${providerName(p)}` : model;
}

const TIER_FIELDS = {
  local: ["local_provider", "local_model"],
  standard: ["standard_provider", "standard_model"],
  reasoning: ["reasoning_provider", "reasoning_model"],
} as const;

/** Provider id and model of a tier. */
export function tierRef(router: RouterConfig, tier: Tier): { provider: string; model: string } {
  const [p, m] = TIER_FIELDS[tier];
  return { provider: router[p] ?? "", model: router[m] };
}

/** The patch that sets a tier's provider and model. */
export function setTier(tier: Tier, provider: string, model: string): Partial<RouterConfig> {
  const [p, m] = TIER_FIELDS[tier];
  return { [p]: provider, [m]: model } as Partial<RouterConfig>;
}

const HINTS: Record<Tier, RegExp> = {
  local: /ollama|local|lokal|mini|small|fast|schnell|haiku|llama|mistral|qwen|phi|gemma/i,
  standard: /standard|gpt-4o(?!-mini)|gpt-4\.1(?!-)|sonnet|default|large|70b/i,
  reasoning: /reason|o1|o3|o4|opus|r1|think|large|pro/i,
};

/** Tiers whose model its provider does not list (known lists only). */
export function missingTiers(router: RouterConfig, providers: AiProvider[], lists: Record<string, string[]>): Tier[] {
  return (["local", "standard", "reasoning"] as Tier[]).filter((tier) => {
    const r = tierRef(router, tier);
    const p = findProvider(providers, r.provider);
    const list = p ? lists[p.id] : undefined;
    return !p || !p.enabled || !r.model || (!!list?.length && !list.includes(r.model));
  });
}

/**
 * Picks provider and model for the tiers whose model is missing: the local tier prefers
 * providers marked local, the others prefer cloud providers; within a provider name hints decide.
 */
export function autoAssignTiers(router: RouterConfig, providers: AiProvider[], lists: Record<string, string[]>): Partial<RouterConfig> {
  const out: Partial<RouterConfig> = {};
  const usable = providers.filter((p) => p.enabled && lists[p.id]?.length);
  const chat = (p: AiProvider) => lists[p.id].filter((m) => !/embed/i.test(m));
  const pick = (tier: Tier) => {
    const local = usable.filter((p) => p.local);
    const cloud = usable.filter((p) => !p.local);
    const order = tier === "local" ? [...local, ...cloud] : [...cloud, ...local];
    for (const p of order) {
      const m = chat(p).find((x) => HINTS[tier].test(x));
      if (m) return { provider: p.id, model: m };
    }
    const first = order.find((p) => chat(p).length);
    return first ? { provider: first.id, model: chat(first)[0] } : null;
  };
  for (const tier of missingTiers(router, providers, lists)) {
    const got = pick(tier);
    if (got) Object.assign(out, setTier(tier, got.provider, got.model));
  }
  return out;
}

/** Whether private content could reach a provider that is not marked local through the local tier. */
export function localTierNotLocal(settings: Pick<Settings, "providers" | "router">): AiProvider | null {
  const p = findProvider(settings.providers, settings.router.local_provider);
  return p && !p.local ? p : null;
}

/** Price per 1M tokens of a model on a provider (same rules as the core); null = unknown. */
export function priceFor(rules: PriceRule[], provider: AiProvider | undefined, model: string): { input: number; output: number } | null {
  if (provider?.local) return { input: 0, output: 0 };
  const own = rules.filter((r) => r.provider === provider?.id);
  const general = rules.filter((r) => !r.provider);
  const table = [...own, ...general];
  const exact = (m: string) => {
    const hit = table.find((r) => r.model === m);
    if (hit) return hit;
    let best: PriceRule | null = null;
    for (const r of table) {
      if (!r.model.endsWith("*")) continue;
      const pre = r.model.slice(0, -1);
      if (m.startsWith(pre) && (!best || pre.length > best.model.length - 1)) best = r;
    }
    return best;
  };
  const r = exact(model) ?? (model.includes("/") ? exact(model.slice(model.lastIndexOf("/") + 1)) : null);
  return r ? { input: r.input_per_mtok, output: r.output_per_mtok } : null;
}
