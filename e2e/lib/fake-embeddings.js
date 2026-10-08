// A deterministic "embedding model" for the fake AI servers: one dimension per concept, so
// words of the same meaning land on the same axis the way a real model places them close
// together („Angebot“ and „Kostenvoranschlag“, „Urlaub“ and „Ferien“). A small constant keeps
// every vector non-zero; the second half carries a weak hash of the text so unrelated texts
// differ a little. Pass it as `embed` to `startFakeOpenAI` / `startFakeLiteLLM`.

const CONCEPTS = [
  ["angebot", "kostenvoranschlag", "offerte", "quote", "offer", "estimate"],
  ["müller", "mueller", "miller"],
  ["urlaub", "ferien", "holiday", "vacation"],
  ["server", "datenbank", "database"],
  ["kunde", "kunden", "customer", "client"],
  ["gehalt", "gehälter", "gehaltsrunde", "salary"],
  ["zander", "geheimprojekt"],
];

export function meaningVector(text) {
  const lower = String(text).toLowerCase();
  const v = CONCEPTS.map((words) => words.filter((w) => lower.includes(w)).length);
  v.push(0.05);
  let h = 7;
  for (const ch of lower) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  for (let i = 0; i < 4; i++) v.push(((h >> i) % 5) / 200);
  return v;
}
