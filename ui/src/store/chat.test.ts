// The assistant's conversation store against a fake IPC layer: turns are saved in order, a
// regenerate replaces the answer (also in the saved chat), a reply after „Neuer Chat“ goes to
// the old chat only, an opened chat continues with its history, and nothing is saved when
// chats are not kept.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatConversation, ChatMessage, ChatRecord } from "../lib/types";

type Call = { id: number; messages: ChatRecord[] };
const fake = {
  saving: true,
  nextId: 1,
  appends: [] as Call[],
  truncates: [] as [number, number][],
  requests: [] as { messages: ChatMessage[]; conversationId: number | null }[],
  seqs: new Map<number, number>(),
  /** Holds the next answer until `release()`. */
  hold: null as null | { release: () => void },
};
const conv = (id: number, title: string): ChatConversation => ({
  id,
  title,
  title_custom: false,
  created_at: "2026-10-01T08:00:00Z",
  updated_at: "2026-10-01T08:00:00Z",
  pinned: false,
  archived: false,
  private: false,
  provider: "litellm",
  model: "firma-standard",
  tier: "standard",
  page_ids: [],
  messages: 0,
  snippet: null,
});
vi.mock("../lib/api", () => ({
  api: {
    chatCreate: async (title: string) => (fake.saving ? conv(fake.nextId++, title) : null),
    chatAppend: async (id: number, messages: ChatRecord[]) => {
      if (!fake.saving) return null;
      fake.appends.push({ id, messages });
      const start = fake.seqs.get(id) ?? 0;
      fake.seqs.set(id, start + messages.length);
      return { conversation: conv(id, "x"), seqs: messages.map((_, i) => start + i) };
    },
    chatTruncate: async (id: number, seq: number) => {
      fake.truncates.push([id, seq]);
      fake.seqs.set(id, seq);
      return 1;
    },
    chatGet: async (id: number) => ({
      conversation: { ...conv(id, "Alt"), model: "altes-modell" },
      messages: [
        { id: 1, seq: 0, created_at: "", role: "user", content: "Alte Frage" },
        { id: 2, seq: 1, created_at: "", role: "assistant", content: "Alte Antwort", model: "altes-modell", tier: "standard" },
      ],
    }),
    chat: async (a: { messages: ChatMessage[]; conversationId: number | null }) => {
      fake.requests.push({ messages: structuredClone(a.messages), conversationId: a.conversationId });
      if (fake.hold) await new Promise<void>((r) => (fake.hold!.release = r));
      const last = [...a.messages].reverse().find((m) => m.role === "user")?.content;
      return {
        completion: { content: `Antwort auf ${last}`, tool_calls: [], finish_reason: "stop", usage: { model: "firma-standard", prompt_tokens: 10, completion_tokens: 5, cost_usd: 0.001, ttft_ms: 100, tokens_per_second: 50 }, exact_usage: true },
        route: { tier: "standard", provider: "litellm", model: "firma-standard", score: 0, reasons: [] },
        context: [],
        meter: {},
        private: false,
      };
    },
    cancelChat: async () => {},
    routePreview: async () => null,
  },
  errorText: (e: unknown) => String(e),
  on: async () => () => {},
}));

const { useApp } = await import("./app");
const chat = await import("./chat");
const settle = () => new Promise((r) => setTimeout(r, 0));
const roles = (call: Call) => call.messages.map((m) => `${m.role}:${m.content}`);

beforeEach(() => {
  chat.newChat();
  fake.saving = true;
  fake.appends = [];
  fake.truncates = [];
  fake.requests = [];
  fake.hold = null;
  useApp.setState({ settings: { settings: { providers: [{ id: "litellm", name: "LiteLLM" }], router: { standard_provider: "litellm", standard_model: "firma-standard" }, ai: { chat_history: "all" } } } as never });
});

describe("chat store", () => {
  it("saves each turn in order with an automatic title", async () => {
    await chat.sendChat("Hallo! Wie ist der Stand?");
    await chat.sendChat("Und weiter?");
    await settle();
    const st = chat.useChat.getState();
    expect(st.conversation?.id).toBeGreaterThan(0);
    expect(st.turns.map((t) => t.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(fake.appends.map(roles)).toEqual([
      ["user:Hallo! Wie ist der Stand?", "assistant:Antwort auf Hallo! Wie ist der Stand?"],
      ["user:Und weiter?", "assistant:Antwort auf Und weiter?"],
    ]);
    expect(fake.appends[0].messages[1]).toMatchObject({ model: "firma-standard", provider: "litellm", tokens: 15, cost_usd: 0.001 });
    expect(fake.requests[1].conversationId).toBe(st.conversation?.id);
    expect(fake.requests[1].messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  it("regenerate replaces the last answer, in the panel and in the saved chat", async () => {
    await chat.sendChat("Erste Frage");
    await chat.sendChat("Zweite Frage");
    await settle();
    const last = chat.useChat.getState().turns.at(-1)!;
    await chat.regenerate(last.id);
    await settle();
    const st = chat.useChat.getState();
    expect(st.turns.map((t) => (t.kind === "user" ? t.text : t.kind))).toEqual(["Erste Frage", "assistant", "Zweite Frage", "assistant"]);
    expect(fake.truncates).toEqual([[st.conversation!.id, 2]]);
    expect(fake.requests.at(-1)!.messages.map((m) => `${m.role}:${m.content}`)).toEqual(["user:Erste Frage", "assistant:Antwort auf Erste Frage", "user:Zweite Frage"]);
  });

  it("edit and resend drops what followed the question", async () => {
    await chat.sendChat("Frage A");
    await settle();
    const user = chat.useChat.getState().turns[0];
    await chat.editAndResend(user.id, "Frage B");
    await settle();
    const st = chat.useChat.getState();
    expect(st.turns.map((t) => (t.kind === "user" ? t.text : t.kind))).toEqual(["Frage B", "assistant"]);
    expect(fake.truncates.at(-1)).toEqual([st.conversation!.id, 0]);
    expect(fake.requests.at(-1)!.messages).toEqual([{ role: "user", content: "Frage B" }]);
  });

  it("a reply after „Neuer Chat“ is saved to the old chat and not shown", async () => {
    fake.hold = { release: () => {} };
    const pending = chat.sendChat("Langsame Frage");
    await new Promise((r) => setTimeout(r, 10));
    const old = chat.useChat.getState().conversation!.id;
    chat.newChat();
    fake.hold.release();
    await pending;
    await settle();
    const st = chat.useChat.getState();
    expect(st.turns).toEqual([]);
    expect(st.conversation).toBeNull();
    expect(st.busy).toBe(false);
    expect(fake.appends.at(-1)!.id).toBe(old);
    expect(roles(fake.appends.at(-1)!)).toEqual(["user:Langsame Frage", "assistant:Antwort auf Langsame Frage"]);
    expect(fake.appends.at(-1)!.messages[1].cancelled).toBe(true);
  });

  it("an opened chat continues with its history and says that the model changed", async () => {
    await chat.openChat(7);
    let st = chat.useChat.getState();
    expect(st.turns.map((t) => t.kind)).toEqual(["user", "assistant"]);
    expect(st.notice).toMatch(/altes-modell.*firma-standard/);
    await chat.sendChat("Neue Frage");
    await settle();
    st = chat.useChat.getState();
    expect(fake.requests.at(-1)!.conversationId).toBe(7);
    expect(fake.requests.at(-1)!.messages.map((m) => m.content)).toEqual(["Alte Frage", "Alte Antwort", "Neue Frage"]);
    expect(fake.appends.at(-1)!.id).toBe(7);
  });

  it("saves nothing when chats are not kept", async () => {
    fake.saving = false;
    await chat.sendChat("Geheim");
    await settle();
    expect(chat.useChat.getState().conversation).toBeNull();
    expect(chat.useChat.getState().turns.length).toBe(2);
    expect(fake.appends).toEqual([]);
    expect(fake.requests.at(-1)!.conversationId).toBeNull();
  });
});
