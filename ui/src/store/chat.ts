// The assistant's conversation, outside of React: it keeps running and stays as it is when the
// side panel is closed, switched to another tab or the focus mode hides it. Every finished turn
// is saved to the chat history (unless Settings → Datenschutz says not to save chats); an old
// chat opens with its messages and is continued with the current settings.

import { create } from "zustand";
import { api, errorText, on } from "../lib/api";
import { streamingOn, warnCost, withCostLimit } from "../lib/aicost";
import { answerRecord, autoTitle, chatMarkdown, restoreChat, turnId, type AskOpts, type Turn } from "../lib/chathistory";
import { modelLabel } from "../lib/providers";
import { t } from "../lib/i18n";
import type { ChatConversation, ChatMessage, ChatRecord, StreamEvent, Tier, ToolCall } from "../lib/types";
import { useApp } from "./app";

export type { Turn } from "../lib/chathistory";

export const TOOL_LABELS: Record<string, string> = {
  log_time: "Zeit buchen",
  search_workspace: "Workspace durchsuchen",
  budget_status: "Budget abfragen",
  list_tasks: "Aufgaben abfragen",
  time_summary: "Zeitübersicht abfragen",
  activity_log: "Aktivität abfragen",
  run_powershell: "PowerShell ausführen",
  git: "Git-Befehl",
  http_request: "HTTP-Anfrage",
};

/** Longest question (characters); the composer says so before. */
export const MAX_INPUT = 100_000;

const pref = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const savePref = (key: string, value: string | null) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

export interface ChatState {
  turns: Turn[];
  busy: boolean;
  /** The saved conversation (null until the first question is saved, or when chats are not saved). */
  conversation: ChatConversation | null;
  /** The conversation touched private content. */
  private: boolean;
  /** Said once when an old chat is continued with another model. */
  notice: string | null;
  historyOpen: boolean;
  /** Bumped when the saved list changed (the history view reloads). */
  listVersion: number;
  /** Bumped to scroll to the end (a new question). */
  followTick: number;
  /** Bumped to put the focus back into the composer. */
  focusTick: number;
  input: string;
  tier: Tier | null;
  useTools: boolean;
  includePage: boolean;
}

export const useChat = create<ChatState>(() => ({
  turns: [],
  busy: false,
  conversation: null,
  private: false,
  notice: null,
  historyOpen: false,
  listVersion: 0,
  followTick: 0,
  focusTick: 0,
  input: "",
  tier: (pref("annalo.tier") as Tier | null) || null,
  useTools: pref("annalo.tools") !== "0",
  includePage: true,
}));

const get = useChat.getState;
const set = useChat.setState;

// The model's view of the conversation; „Neuer Chat“ and opening a chat replace the array, so
// a send can tell whether its chat is still the current one.
let history: ChatMessage[] = [];
let requestId: string | null = null;
// Every send belongs to a run; „Stoppen“, „Neuer Chat“ and opening a chat end it.
let run = 0;
// Tool calls waiting for the user's approval: ended runs reject them.
const approvals = new Set<(ok: boolean) => void>();
// The send that owns `busy` (a send of an abandoned chat no longer clears it).
let activeSend: object | null = null;

export function setTier(tier: Tier | null) {
  set({ tier });
  savePref("annalo.tier", tier);
}
export function setUseTools(on: boolean) {
  set({ useTools: on });
  savePref("annalo.tools", on ? "1" : "0");
}

/** The open page the assistant may read: the active tab's page, once loaded. */
export function currentPage() {
  const s = useApp.getState();
  const tab = s.tabs.find((x) => x.id === s.activeTabId);
  return tab?.kind === "page" && s.activeDoc && s.activeDoc.id === tab.pageId ? s.activeDoc : null;
}

const saving = () => (useApp.getState().settings?.settings.ai.chat_history ?? "all") !== "off";

const updateTurn = (id: string, patch: Partial<Turn>) => set((st) => ({ turns: st.turns.map((x) => (x.id === id ? ({ ...x, ...patch } as Turn) : x)) }));

// Stream deltas into the current assistant turn, batched per frame. Only into a turn that is
// still streaming for the same request: a batch left over when the complete answer arrives
// is dropped (it would show the answer twice).
let stream = { buffer: "", frame: 0, rid: null as string | null };
const endStream = () => {
  cancelAnimationFrame(stream.frame);
  stream = { buffer: "", frame: 0, rid: null };
};
const patchStreaming = (f: (last: Extract<Turn, { kind: "assistant" }>) => Turn) =>
  set((st) => {
    const last = st.turns[st.turns.length - 1];
    if (!last || last.kind !== "assistant" || !last.streaming) return st;
    return { turns: [...st.turns.slice(0, -1), f(last)] };
  });

let listening = false;
/** Listens for streamed answers and the session meter (once, for the app's lifetime). */
export function ensureChatListeners() {
  if (listening) return;
  listening = true;
  on<{ request_id: string; event: StreamEvent }>("ai://stream", ({ request_id, event }) => {
    if (request_id !== requestId) return;
    if (event.type === "waiting") {
      const waiting = { until: Date.now() + event.seconds * 1000, model: event.model };
      patchStreaming((last) => ({ ...last, waiting }));
      return;
    }
    // Settings → KI „Antworten live anzeigen“ off: the answer appears when complete.
    if (event.type !== "delta" || !streamingOn()) return;
    if (stream.rid !== request_id) {
      cancelAnimationFrame(stream.frame);
      stream = { buffer: "", frame: 0, rid: request_id };
    }
    stream.buffer += event.text;
    if (!stream.frame)
      stream.frame = requestAnimationFrame(() => {
        const { buffer: chunk, rid } = stream;
        stream.frame = 0;
        stream.buffer = "";
        if (!chunk || rid !== requestId) return;
        patchStreaming((last) => ({ ...last, text: last.text + chunk, waiting: undefined }));
      });
  }).catch(() => {
    listening = false;
  });
  on("ai://meter", (m) => useApp.getState().set({ meter: m as never })).catch(() => {});
}

function summarizeArgs(c: ToolCall) {
  try {
    const a = JSON.parse(c.function.arguments);
    return a.command ?? a.query ?? a.netzplan ?? (a.from && a.to ? `${a.from} – ${a.to}` : "");
  } catch {
    return "";
  }
}

/** Runs the tool calls of an answer; returns the model's results and the records to save. */
async function runTools(calls: ToolCall[], live: () => boolean): Promise<{ results: ChatMessage[]; records: ChatRecord[] }> {
  const s = useApp.getState;
  const results: ChatMessage[] = [];
  const records: ChatRecord[] = [];
  for (const c of calls) {
    // Stopped: the remaining calls are answered without running them.
    if (!live()) {
      results.push({ role: "tool", tool_call_id: c.id, content: "Abgebrochen." });
      continue;
    }
    const id = turnId();
    const name = c.function.name;
    const label = TOOL_LABELS[name] ?? name;
    set((st) => ({ turns: [...st.turns, { id, kind: "tool", name, label, status: "running" }] }));
    let card: { status: "done" | "error" | "rejected"; summary?: string; output?: string };
    let out: string;
    try {
      const plan = await api.planTool(name, c.function.arguments);
      if (plan.risk === "workspace") {
        out = await api.runWorkspaceTool(name, c.function.arguments);
        if (name === "log_time") {
          try {
            s().alerts(JSON.parse(out).alerts ?? []);
          } catch {
            /* ignore */
          }
          s().bumpEntries();
        }
        card = { status: "done", summary: summarizeArgs(c) };
      } else {
        const ok = await new Promise<boolean>((resolve) => {
          const decide = (v: boolean) => {
            approvals.delete(decide);
            resolve(v);
          };
          approvals.add(decide);
          if (!live()) decide(false);
          else updateTurn(id, { status: "pending", summary: plan.summary, decide });
        });
        if (!ok) {
          out = "Der Nutzer hat die Ausführung abgelehnt.";
          card = { status: "rejected", summary: plan.summary };
        } else {
          updateTurn(id, { status: "running", decide: undefined });
          out = await api.runSystemTool(plan.call);
          card = { status: "done", summary: plan.summary, output: out };
        }
      }
    } catch (e) {
      out = `Fehler: ${errorText(e)}`;
      card = { status: "error", output: errorText(e) };
    }
    updateTurn(id, { ...card, decide: undefined });
    results.push({ role: "tool", tool_call_id: c.id, content: out });
    records.push({ role: "tool", content: out, tool_call_id: c.id, tool: { name, label, ...card } });
  }
  return { results, records };
}

/** Saves records of conversation `id` in order (one save at a time). */
let saveChain: Promise<unknown> = Promise.resolve();
function save(id: number | null, records: ChatRecord[], pageId: number | null, priv: boolean, onSaved?: (seqs: number[]) => void) {
  if (id == null || !records.length) return saveChain;
  const batch = records.splice(0);
  saveChain = saveChain
    .then(() => api.chatAppend(id, batch, pageId, priv))
    .then((r) => {
      if (!r) return;
      onSaved?.(r.seqs);
      if (get().conversation?.id === id) set({ conversation: r.conversation, private: r.conversation.private || get().private });
      set((st) => ({ listVersion: st.listVersion + 1 }));
    })
    .catch((e) => console.warn("chat not saved", e));
  return saveChain;
}

/** The saved conversation of the current chat, created with the first question. */
async function ensureConversation(title: string, current: () => boolean): Promise<number | null> {
  const conv = get().conversation;
  if (conv) return conv.id;
  if (!saving()) return null;
  try {
    const created = await api.chatCreate(autoTitle(title));
    if (!created) return null;
    if (current()) set((st) => ({ conversation: created, private: st.private || created.private }));
    set((st) => ({ listVersion: st.listVersion + 1 }));
    return created.id;
  } catch (e) {
    console.warn("chat not saved", e);
    return null;
  }
}

export interface SendOpts extends AskOpts {
  /** Replaces the page context of the composer (null: none). */
  pageId?: number | null;
}

/** Asks `text` in the current chat and runs the tool rounds of the answer. */
export async function sendChat(textArg: string, opts: SendOpts = {}) {
  const text = textArg.trim();
  const st = get();
  if (!text || st.busy) return;
  const tools = opts.tools ?? st.useTools;
  const page = opts.pageId !== undefined ? opts.pageId : st.includePage ? (currentPage()?.id ?? null) : null;
  const me = {};
  activeSend = me;
  const myRun = run;
  const live = () => run === myRun;
  // The chat this send writes to; „Neuer Chat“ starts another one.
  const chat = history;
  const current = () => history === chat;
  const user: Extract<Turn, { kind: "user" }> = {
    id: turnId(),
    kind: "user",
    text: opts.display ?? text,
    prompt: text,
    hist: chat.length,
    opts: { tools: opts.tools, pageTitle: opts.pageTitle, display: opts.display },
  };
  set((s) => ({ busy: true, turns: [...s.turns, user], followTick: s.followTick + 1, notice: s.turns.length ? s.notice : null }));
  chat.push({ role: "user", content: text });
  const turnStart = user.hist;
  const convId = await ensureConversation(opts.display ?? text, current);
  const userRecord: ChatRecord = { role: "user", content: text, display: opts.display ?? null };
  const pending: ChatRecord[] = [userRecord];
  let priv = st.private;
  const onSaved = (seqs: number[]) => {
    if (user.seq != null || !seqs.length) return;
    user.seq = seqs[0];
    if (current()) updateTurn(user.id, { seq: seqs[0] });
  };
  try {
    // Stopped while the chat was being saved: nothing was asked yet.
    if (!live() || !current()) {
      const cancelled: Turn = { id: turnId(), kind: "assistant", text: "", streaming: false, cancelled: true };
      if (current()) set((s) => ({ turns: [...s.turns, cancelled] }));
      pending.push({ role: "assistant", content: "", cancelled: true });
      chat.push({ role: "assistant", content: "" });
      return;
    }
    for (let round = 0; round < 5; round++) {
      const aid = turnId();
      const rid = crypto.randomUUID();
      requestId = rid;
      set((s) => ({ turns: [...s.turns, { id: aid, kind: "assistant", text: "", streaming: true, pageTitle: opts.pageTitle }] }));
      const out = await withCostLimit((overrideLimit) =>
        api.chat({ requestId: rid, messages: chat, useTools: tools, tier: get().tier, pageId: page, overrideLimit, conversationId: convId }),
      );
      const c = out.completion;
      priv = priv || !!out.private;
      const label = modelLabel(useApp.getState().settings?.settings.providers ?? [], out.route.provider, out.route.model);
      const done: Extract<Turn, { kind: "assistant" }> = {
        id: aid,
        kind: "assistant",
        text: c.content,
        streaming: false,
        cancelled: c.finish_reason === "cancelled" || !live() || undefined,
        // All of them, in order: `[n]` in the answer is `sources[n - 1]`.
        sources: out.context,
        pageTitle: opts.pageTitle,
        meta: {
          model: label,
          tier: out.route.tier,
          ttft: c.usage.ttft_ms,
          tps: c.usage.tokens_per_second,
          tokens: c.usage.prompt_tokens + c.usage.completion_tokens,
          cost: c.usage.cost_usd,
          exact: c.exact_usage,
          reasons: out.route.reasons,
        },
      };
      // Stopped: tool calls of this answer are not run (and not kept in the history).
      const keepCalls = live() && c.finish_reason !== "cancelled" && c.tool_calls.length > 0;
      pending.push(answerRecord(done, out.route, keepCalls ? c.tool_calls : undefined));
      // A new chat meanwhile: this answer belongs to the old one (saved there, not shown).
      if (!current()) {
        save(convId, pending, page, priv, onSaved);
        return;
      }
      warnCost(out.cost_warning);
      if (requestId === rid) requestId = null;
      endStream();
      updateTurn(aid, done);
      if (priv && !get().private) set({ private: true });
      useApp.getState().set({ meter: out.meter });
      if (!live() && c.tool_calls.length) {
        chat.push({ role: "assistant", content: c.content || "" });
        break;
      }
      chat.push({ role: "assistant", content: c.content || null, tool_calls: c.tool_calls.length ? c.tool_calls : undefined });
      if (!keepCalls) break;
      if (!c.content) set((s) => ({ turns: s.turns.filter((x) => x.id !== aid) }));
      const { results, records } = await runTools(c.tool_calls, live);
      pending.push(...records);
      // The calls the run did not get to are answered in the history (and restored as such).
      if (!current()) {
        save(convId, pending, page, priv, onSaved);
        return;
      }
      chat.push(...results);
      save(convId, pending, page, priv, onSaved);
      if (!live()) break;
    }
  } catch (e) {
    const message = errorText(e);
    // The failed turn is shown again but never sent.
    if (pending.includes(userRecord)) userRecord.in_context = false;
    pending.push({ role: "assistant", content: "", error: message, in_context: false });
    if (current()) {
      requestId = null;
      endStream();
      set((s) => {
        const last = s.turns[s.turns.length - 1];
        if (last?.kind === "assistant" && last.streaming) return { turns: [...s.turns.slice(0, -1), { ...last, streaming: false, error: message }] };
        return { turns: [...s.turns, { id: turnId(), kind: "assistant", text: "", streaming: false, error: message }] };
      });
      chat.splice(turnStart);
    }
  } finally {
    save(convId, pending, page, priv, onSaved);
    if (activeSend === me) {
      activeSend = null;
      set((s) => ({ busy: false, focusTick: s.focusTick + 1 }));
    }
  }
}

/** Ends the running answer: cancels the request and rejects waiting tool approvals. */
export function stopChat() {
  run++;
  const rid = requestId;
  if (rid) api.cancelChat(rid).catch(() => {});
  for (const decide of [...approvals]) decide(false);
}

/** Leaves the current chat (a reply on its way is saved to it, not shown). */
function leave() {
  if (get().busy || approvals.size) stopChat();
  requestId = null;
  endStream();
  history = [];
  activeSend = null;
}

export function newChat() {
  leave();
  set((s) => ({ busy: false, turns: [], conversation: null, private: false, notice: null, historyOpen: false, focusTick: s.focusTick + 1 }));
}

/** Opens a saved chat to read and continue it; says when another model will answer now. */
export async function openChat(id: number) {
  const doc = await api.chatGet(id);
  leave();
  const { turns, history: h } = restoreChat(doc.messages);
  history = h;
  set((s) => ({
    busy: false,
    turns,
    conversation: doc.conversation,
    private: doc.conversation.private,
    notice: modelNotice(doc.conversation),
    historyOpen: false,
    followTick: s.followTick + 1,
    focusTick: s.focusTick + 1,
  }));
}

/** „Mit … geführt, neue Antworten kommen von …“ when the tier's model changed since. */
export function modelNotice(conv: ChatConversation): string | null {
  const settings = useApp.getState().settings?.settings;
  if (!settings || !conv.model) return null;
  const tier = (get().tier ?? conv.tier ?? "standard") as Tier;
  const r = settings.router as unknown as Record<string, string | undefined>;
  const provider = r[`${tier}_provider`] || settings.providers[0]?.id || "";
  const model = r[`${tier}_model`];
  if (!model) return null;
  const same = model === conv.model && (!conv.provider || !provider || provider === conv.provider);
  if (same) return null;
  const providers = settings.providers ?? [];
  return t("chat.modelChanged", { old: modelLabel(providers, conv.provider, conv.model), now: modelLabel(providers, provider, model) });
}

/** Cuts the chat before the question `user` (turns, model history and the saved messages). */
async function cutBefore(userId: string) {
  // The question's place in the saved chat is known once its turn is saved.
  await saveChain;
  const st = get();
  const idx = st.turns.findIndex((x) => x.id === userId);
  const user = st.turns[idx];
  if (user?.kind !== "user") return;
  history.splice(user.hist);
  set({ turns: st.turns.slice(0, idx) });
  if (st.conversation && user.seq != null) await api.chatTruncate(st.conversation.id, user.seq).catch((e) => console.warn("chat not cut", e));
}

/** The question an answer (or a failed request) belongs to. */
function questionOf(turnIdArg: string) {
  const turns = get().turns;
  const idx = turns.findIndex((x) => x.id === turnIdArg);
  for (let i = idx; i >= 0; i--) {
    const x = turns[i];
    if (x.kind === "user") return x;
  }
  return null;
}

/** „Neu generieren“ / „Erneut versuchen“: asks the question of `turnIdArg` again in its place. */
export async function regenerate(turnIdArg: string) {
  if (get().busy) return;
  const user = questionOf(turnIdArg);
  if (!user) return;
  await cutBefore(user.id);
  await sendChat(user.prompt, { ...user.opts });
}

/** Sends an edited question in place of `userId` (and drops what followed it). */
export async function editAndResend(userId: string, text: string) {
  const user = get().turns.find((x) => x.id === userId);
  if (get().busy || user?.kind !== "user" || !text.trim()) return;
  await cutBefore(user.id);
  await sendChat(text, { tools: user.opts?.tools });
}

export async function renameChat(title: string) {
  const conv = get().conversation;
  if (!conv || !title.trim()) return;
  const updated = await api.chatUpdate(conv.id, { title });
  if (get().conversation?.id === updated.id) set({ conversation: updated });
  set((s) => ({ listVersion: s.listVersion + 1 }));
}

/** Deletes a saved chat with „Rückgängig“ in the toast; the open one is left for a new chat. */
export async function deleteChat(conv: ChatConversation) {
  const s = useApp.getState();
  try {
    await api.chatDelete(conv.id);
  } catch (e) {
    s.error(t("chat.deleteFailed"), e);
    return;
  }
  const wasOpen = get().conversation?.id === conv.id;
  if (wasOpen) {
    leave();
    set({ turns: [], conversation: null, private: false, notice: null });
  }
  set((st) => ({ listVersion: st.listVersion + 1 }));
  s.toast({
    tone: "info",
    title: t("chat.deleted", { title: conv.title || t("chat.untitled") }),
    action: {
      label: t("chat.undo"),
      run: async () => {
        try {
          await api.chatRestore(conv.id);
          set((st) => ({ listVersion: st.listVersion + 1 }));
          if (wasOpen && !get().turns.length) await openChat(conv.id);
        } catch (e) {
          useApp.getState().error(t("chat.restoreFailed"), e);
        }
      },
    },
  });
}

/** „Duplizieren“: a copy to continue separately, opened. */
export async function duplicateChat(conv: ChatConversation) {
  try {
    const copy = await api.chatDuplicate(conv.id, t("chat.copyTitle", { title: conv.title || t("chat.untitled") }));
    if (!copy) return;
    set((st) => ({ listVersion: st.listVersion + 1 }));
    await openChat(copy.id);
  } catch (e) {
    useApp.getState().error(t("chat.duplicateFailed"), e);
  }
}

/** The tag a page made from a private chat carries, so it stays private there too. */
export function privateTag(): string {
  const markers = useApp.getState().settings?.settings.router.private_markers ?? [];
  const m = markers.map((x) => x.trim()).find((x) => x.startsWith("#") && x.length > 1);
  return m ?? "#privat";
}

/** „Als Seite speichern“ of a whole chat. */
export async function saveChatAsPage(conv: ChatConversation) {
  const s = useApp.getState();
  try {
    const turns = get().conversation?.id === conv.id ? get().turns : restoreChat((await api.chatGet(conv.id)).messages).turns;
    const p = await api.createPage(conv.title || t("chat.untitled"), null, "sparkles", chatMarkdown(turns, conv.private ? privateTag() : null));
    await s.refreshTree();
    s.openPage(p.id, { newTab: true });
  } catch (e) {
    s.error(t("chat.pageFailed"), e);
  }
}

/** The history list opened with the search focused (command palette „Chat-Verlauf durchsuchen“). */
export function showHistory(open = true) {
  useApp.getState().set({ panelOpen: true, panelTab: "assistant" });
  set({ historyOpen: open });
}

/** „Alle Chats löschen“ (Settings → Datenschutz). */
export async function deleteAllChats() {
  const n = await api.chatDeleteAll();
  if (get().conversation) {
    leave();
    set({ turns: [], conversation: null, private: false, notice: null, busy: false });
  }
  set((st) => ({ listVersion: st.listVersion + 1 }));
  return n;
}

/** For tests: the model history of the current chat. */
export const chatHistoryForTests = () => history;
