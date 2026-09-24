// Model names of the LiteLLM server and the router tiers (Settings → KI & LiteLLM).

import type { RouterConfig } from "./types";

/** Picks server models for the tiers whose model the server does not offer, by name hints. */
export function autoAssign(router: RouterConfig, models: string[]): Partial<RouterConfig> {
  const chat = models.filter((m) => !/embed/i.test(m));
  const find = (re: RegExp) => chat.find((m) => re.test(m));
  const standard = models.includes(router.standard_model) ? router.standard_model : (find(/standard|gpt-4o(?!-mini)|sonnet|default/i) ?? chat[0] ?? router.standard_model);
  const out: Partial<RouterConfig> = { standard_model: standard };
  if (!models.includes(router.local_model)) out.local_model = find(/ollama|local|lokal|mini|small|fast|schnell|haiku|llama|mistral|qwen|phi/i) ?? standard;
  if (!models.includes(router.reasoning_model)) out.reasoning_model = find(/reason|o1|o3|o4|opus|r1|think|large|pro/i) ?? standard;
  return out;
}
