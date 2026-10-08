// The chat history's helpers: titles, the groups of the list, restoring a saved chat.

import { describe, expect, it } from "vitest";
import { autoTitle, chatMarkdown, groupConversations, historyDate, restoreChat, snippetParts, type Turn } from "./chathistory";
import type { ChatConversation, StoredChatRecord } from "./types";

const conv = (id: number, updated: string, extra: Partial<ChatConversation> = {}): ChatConversation => ({
  id,
  title: `Chat ${id}`,
  title_custom: false,
  created_at: updated,
  updated_at: updated,
  pinned: false,
  archived: false,
  private: false,
  provider: "",
  model: "",
  tier: "",
  page_ids: [],
  messages: 2,
  snippet: null,
  ...extra,
});

describe("autoTitle", () => {
  it("takes the first sentence of the question, without greeting and politeness", () => {
    expect(autoTitle("Hallo! Kannst du mir bitte den Stand im Projekt Atlas zusammenfassen? Danke.")).toBe("Den Stand im Projekt Atlas zusammenfassen?");
    expect(autoTitle("Wie ist der Stand im Projekt?")).toBe("Wie ist der Stand im Projekt?");
    expect(autoTitle("buche 2 h auf NP-8801/1040")).toBe("Buche 2 h auf NP-8801/1040");
  });
  it("cuts long questions at a word and drops quotes, code, links and markup", () => {
    const t = autoTitle("Bitte erkläre mir ausführlich die Architektur der Middleware zwischen ERP und Shop inklusive aller Schnittstellen");
    expect(t.length).toBeLessThanOrEqual(48);
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/);
    expect(autoTitle("> zitierter Text\n\nWas bedeutet das?")).toBe("Was bedeutet das?");
    expect(autoTitle("Was macht das?\n```ts\nconst x = 1;\n```")).toBe("Was macht das?");
    expect(autoTitle("Siehe [[Architektur|die Architektur]] und https://www.example.com/a/b?c=1")).toBe("Siehe die Architektur und example.com");
    expect(autoTitle("**Wichtig:** #privat Gehalt")).toBe("Wichtig: Gehalt");
    expect(autoTitle("#privat Wie hoch war meine Gehaltserhöhung?")).toBe("Wie hoch war meine Gehaltserhöhung?");
    expect(autoTitle("@reasoning Warum ist das so")).toBe("Warum ist das so");
  });
  it("never returns an empty title", () => {
    expect(autoTitle("   ")).toBe("Neuer Chat");
    expect(autoTitle("```\ncode\n```")).toBe("Neuer Chat");
    const word = "x".repeat(300);
    expect(autoTitle(word).length).toBe(48);
  });
});

describe("groupConversations", () => {
  const now = new Date(2026, 9, 1, 15, 0);
  it("puts pinned chats first, then today, yesterday, the last 7 days and older (local days)", () => {
    const list = [
      conv(1, new Date(2026, 9, 1, 9, 0).toISOString()),
      conv(2, new Date(2026, 9, 1, 0, 5).toISOString()),
      conv(3, new Date(2026, 8, 30, 23, 59).toISOString()),
      conv(4, new Date(2026, 8, 25, 8, 0).toISOString()),
      conv(5, new Date(2026, 8, 24, 8, 0).toISOString()),
      conv(6, new Date(2025, 0, 1).toISOString(), { pinned: true }),
    ];
    const groups = groupConversations(list, now);
    expect(groups.map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
      ["pinned", [6]],
      ["today", [1, 2]],
      ["yesterday", [3]],
      ["week", [4]],
      ["older", [5]],
    ]);
    expect(groupConversations([], now)).toEqual([]);
  });
  it("the last 7 days end at the start of the sixth day before today, across a month end", () => {
    const at = new Date(2026, 10, 2, 8, 0);
    const list = [conv(1, new Date(2026, 9, 27, 0, 0).toISOString()), conv(2, new Date(2026, 9, 26, 23, 59).toISOString()), conv(3, new Date(2026, 10, 1, 23, 0).toISOString())];
    expect(groupConversations(list, at).map((g) => [g.key, g.items.map((c) => c.id)])).toEqual([
      ["yesterday", [3]],
      ["week", [1]],
      ["older", [2]],
    ]);
  });
  it("dates: time today, weekday this week, day before", () => {
    expect(historyDate(new Date(2026, 9, 1, 9, 5).toISOString(), now)).toBe("09:05");
    expect(historyDate(new Date(2026, 8, 29, 18, 30).toISOString(), now)).toMatch(/^\S+ 18:30$/);
    expect(historyDate(new Date(2026, 8, 2, 8, 0).toISOString(), now)).toBe("02.09.");
    expect(historyDate(new Date(2025, 11, 24, 8, 0).toISOString(), now)).toBe("24.12.2025");
  });
  it("splits search snippets into hits", () => {
    expect(snippetParts("Der \u0002Go-Live\u0003 ist im \u0002Oktober\u0003.")).toEqual([
      { text: "Der ", hit: false },
      { text: "Go-Live", hit: true },
      { text: " ist im ", hit: false },
      { text: "Oktober", hit: true },
      { text: ".", hit: false },
    ]);
  });
});

const rec = (seq: number, r: Partial<StoredChatRecord>): StoredChatRecord => ({ id: seq + 1, seq, created_at: "2026-10-01T08:00:00Z", role: "user", content: "", ...r }) as StoredChatRecord;

describe("restoreChat", () => {
  it("restores turns and the model history of a chat with tools, a failed turn and a stopped answer", () => {
    const call = { id: "call_1", type: "function" as const, function: { name: "log_time", arguments: "{}" } };
    const { turns, history } = restoreChat([
      rec(0, { role: "user", content: "Erstelle den Wochenbericht …", display: "Wochenbericht KW 40" }),
      rec(1, { role: "assistant", content: "", tool_calls: [call], model: "m", tier: "standard" }),
      rec(2, { role: "tool", content: "{\"ok\":true}", tool_call_id: "call_1", tool: { name: "log_time", label: "Zeit buchen", status: "done", summary: "/zeit 1h" } }),
      rec(3, { role: "assistant", content: "Gebucht [1].", model: "m", provider: "litellm", tier: "standard", tokens: 50, cost_usd: 0.001, meta: { model: "m · LiteLLM", ttft: 300, tps: 40, exact: true }, citations: [{ source: "Seite: A", page_id: 1, text: "x", score: 1, block_id: 1, time_entry_id: null }], reasons: ["r"] }),
      rec(4, { role: "user", content: "Noch was", in_context: false }),
      rec(5, { role: "assistant", content: "", error: "Server nicht erreichbar", in_context: false }),
      rec(6, { role: "user", content: "Und?" }),
      rec(7, { role: "assistant", content: "Halb", cancelled: true, model: "m", tier: "local" }),
    ]);
    expect(turns.map((x) => x.kind)).toEqual(["user", "tool", "assistant", "user", "assistant", "user", "assistant"]);
    const first = turns[0] as Extract<Turn, { kind: "user" }>;
    expect([first.text, first.prompt, first.seq, first.hist]).toEqual(["Wochenbericht KW 40", "Erstelle den Wochenbericht …", 0, 0]);
    const answer = turns[2] as Extract<Turn, { kind: "assistant" }>;
    expect(answer.meta).toEqual({ model: "m · LiteLLM", tier: "standard", ttft: 300, tps: 40, tokens: 50, cost: 0.001, exact: true, reasons: ["r"] });
    expect(answer.sources?.length).toBe(1);
    expect((turns[4] as Extract<Turn, { kind: "assistant" }>).error).toBe("Server nicht erreichbar");
    expect((turns[6] as Extract<Turn, { kind: "assistant" }>).cancelled).toBe(true);
    // The failed turn is not sent again; a regenerate of it cuts where it started.
    expect(history.map((m) => `${m.role}:${m.content ?? ""}`)).toEqual([
      "user:Erstelle den Wochenbericht …",
      "assistant:",
      'tool:{"ok":true}',
      "assistant:Gebucht [1].",
      "user:Und?",
      "assistant:Halb",
    ]);
    expect((turns[3] as Extract<Turn, { kind: "user" }>).hist).toBe(4);
    expect((turns[5] as Extract<Turn, { kind: "user" }>).hist).toBe(4);
  });

  it("answers tool calls that were never saved and drops answers without their call", () => {
    const calls = [
      { id: "a", type: "function" as const, function: { name: "git", arguments: "{}" } },
      { id: "b", type: "function" as const, function: { name: "git", arguments: "{}" } },
    ];
    const { turns, history } = restoreChat([
      rec(0, { role: "user", content: "git status" }),
      rec(1, { role: "assistant", content: "", tool_calls: calls }),
      rec(2, { role: "tool", content: "ok", tool_call_id: "a", tool: { name: "git", label: "Git-Befehl", status: "running" } }),
      rec(3, { role: "tool", content: "verwaist", tool_call_id: "zzz" }),
      rec(4, { role: "user", content: "weiter" }),
    ]);
    expect(history.map((m) => [m.role, m.tool_call_id ?? null, m.content])).toEqual([
      ["user", null, "git status"],
      ["assistant", null, null],
      ["tool", "a", "ok"],
      ["tool", "b", "Abgebrochen."],
      ["user", null, "weiter"],
    ]);
    const tool = turns.find((x) => x.kind === "tool") as Extract<Turn, { kind: "tool" }>;
    expect([tool.status, tool.output]).toEqual(["error", "Unterbrochen"]);
    expect((turns[turns.length - 1] as Extract<Turn, { kind: "user" }>).hist).toBe(4);
    // At the end too.
    const open = restoreChat([rec(0, { role: "user", content: "x" }), rec(1, { role: "assistant", content: "", tool_calls: [calls[0]] })]);
    expect(open.history.at(-1)).toEqual({ role: "tool", tool_call_id: "a", content: "Abgebrochen." });
  });

  it("makes Markdown of a chat, private ones tagged", () => {
    const turns: Turn[] = [
      { id: "1", kind: "user", text: "Frage\nzweite Zeile", prompt: "Frage", hist: 0 },
      { id: "2", kind: "assistant", text: "## Antwort\n\nText", streaming: false },
    ];
    expect(chatMarkdown(turns, null)).toBe("> Frage\n> zweite Zeile\n\n## Antwort\n\nText\n");
    expect(chatMarkdown(turns, "#privat").trimEnd().endsWith("#privat")).toBe(true);
  });
});
