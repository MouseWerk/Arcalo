import { describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { SearchHit, SemanticResult, Settings } from "./types";

// A fake backend: exact hits at once, the list with meaning hits when `answer` is called.
const exactHit: SearchHit = { kind: "note", page_id: 1, title: "Angebot Schmidt", icon: null, snippet: "\u0002Angebot\u0003", score: 1 };
const similarHit: SearchHit = { kind: "similar", page_id: 2, title: "Dachsanierung", icon: null, passage: "Kostenvoranschlag für Kunde Müller", similarity: 0.82, score: 0.016 };
const semanticCalls: string[] = [];
let answer: ((r: SemanticResult) => void) | null = null;
vi.mock("./api", () => ({
  api: {
    search: async () => [exactHit],
    searchSemantic: (q: string) => {
      semanticCalls.push(q);
      return new Promise<SemanticResult>((ok) => (answer = ok));
    },
  },
  on: async () => () => {},
}));

const { isSimilar, setExactOnly, useExactOnly, useMeaningSearch } = await import("./meaningSearch");
const { quickItems } = await import("./quicksearch");
const { semanticSwitch } = await import("../views/settings/SearchSection");

type Seen = { hits: SearchHit[] | null; meaning: boolean; exact: boolean };

async function mount(query: string) {
  const seen: Seen[] = [];
  const Probe = () => {
    const exact = useExactOnly();
    const r = useMeaningSearch(query, 10, { enabled: true, exact, delay: 0 });
    seen.push({ ...r, exact });
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Probe)));
  return { seen, root };
}

describe("search with meaning", () => {
  it("shows the exact hits first, then the list with the meaning hits", async () => {
    setExactOnly(false);
    const { seen, root } = await mount("Angebot Müller");
    await vi.waitFor(() => expect(answer).not.toBeNull());
    expect(seen.at(-1)).toMatchObject({ hits: [exactHit], meaning: false });
    await act(async () => answer!({ hits: [exactHit, similarHit], meaning: true }));
    expect(seen.at(-1)).toMatchObject({ hits: [exactHit, similarHit], meaning: true });
    expect(seen.at(-1)!.hits!.filter(isSimilar).map((h) => h.passage)).toEqual(["Kostenvoranschlag für Kunde Müller"]);
    expect(semanticCalls).toEqual(["Angebot Müller"]);
    root.unmount();
  });

  it("keeps the exact hits when the answer has no meaning hits (off, offline)", async () => {
    answer = null;
    const { seen, root } = await mount("Rollout");
    await vi.waitFor(() => expect(answer).not.toBeNull());
    await act(async () => answer!({ hits: [], meaning: false }));
    expect(seen.at(-1)).toMatchObject({ hits: [exactHit], meaning: false });
    root.unmount();
  });

  it("„Nur exakt“ asks for exact hits only, and is one choice for every place", async () => {
    answer = null;
    semanticCalls.length = 0;
    setExactOnly(true);
    const { seen, root } = await mount("Angebot");
    await act(async () => new Promise((ok) => setTimeout(ok, 20)));
    expect(seen.at(-1)).toMatchObject({ hits: [exactHit], meaning: false, exact: true });
    expect(semanticCalls).toEqual([]);
    expect(localStorage.getItem("annalo.search.exactOnly")).toBe("1");
    // Switched back here: the meaning hits are asked for again.
    await act(async () => setExactOnly(false));
    await vi.waitFor(() => expect(semanticCalls).toEqual(["Angebot"]));
    expect(seen.at(-1)!.exact).toBe(false);
    root.unmount();
  });

  it("lists meaning hits in the quick search with their passage, once per page", () => {
    const hits: SearchHit[] = [exactHit, similarHit, { ...similarHit, kind: "similar", passage: "noch einmal" }];
    const items = quickItems("angebot", { hits, recent: [], timerRunning: false, lastRef: null });
    const similar = items.filter((i) => i.passage != null);
    expect(similar).toHaveLength(1);
    expect(similar[0]).toMatchObject({ id: "page-2", section: "Inhalte", passage: "Kostenvoranschlag für Kunde Müller", action: { type: "page", pageId: 2 } });
  });

  it("the switch in Settings → Suche is on by itself only with a local embedding model", () => {
    const base = {
      embedding_model: "nomic-embed-text",
      embedding_provider: "ollama",
      providers: [{ id: "ollama", name: "Ollama", local: true }, { id: "litellm", name: "LiteLLM", local: false }],
      search: { semantic: null },
    } as unknown as Settings;
    expect(semanticSwitch(base)).toMatchObject({ on: true, local: true, model: "nomic-embed-text", provider: "Ollama" });
    expect(semanticSwitch({ ...base, embedding_provider: "litellm" })).toMatchObject({ on: false, local: false });
    expect(semanticSwitch({ ...base, embedding_provider: "litellm", search: { semantic: true } })).toMatchObject({ on: true, local: false });
    expect(semanticSwitch({ ...base, search: { semantic: false } }).on).toBe(false);
    expect(semanticSwitch({ ...base, embedding_model: null })).toMatchObject({ on: false, model: null });
    // Settings from before 1.15 (no `search` yet) read as automatic.
    expect(semanticSwitch({ ...base, search: undefined } as unknown as Settings).on).toBe(true);
  });
});
