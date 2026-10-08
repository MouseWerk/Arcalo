// The assistant's conversations, outside of React: they keep running and stay as they are when
// the side panel is closed, switched to another tab or the focus mode hides it. There are two
// sessions over the one chat history: the side panel's assistant and the chat view (a tab in
// the main area, a plain chatbot unless „Mit meinen Notizen“ is on). Every finished turn is
// saved to the chat history (unless Settings → Datenschutz says not to save chats); an old chat
// opens with its messages and is continued with the current settings. A saved chat open in
// both sessions is the same chat: what one of them adds shows in the other one, too.

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { api, errorText, on } from "../lib/api";
import { streamingOn, warnCost, withCostLimit } from "../lib/aicost";
import { answerRecord, autoTitle, chatMarkdown, restoreChat, turnId, type AskOpts, type Turn } from "../lib/chathistory";
import { modelLabel } from "../lib/providers";
import { t, type TKey } from "../lib/i18n";
import type { ChatConversation, ChatMessage, ChatRecord, StreamEvent, Tier, ToolCall } from "../lib/types";
import { useApp } from "./app";
import { jiraApi } from "../lib/jira";
import { aiEnabled } from "../lib/aiswitch";

export type { Turn } from "../lib/chathistory";

const TOOL_KEYS: Record<string, TKey> = {
  log_time: "assist.tool.logTime",
  search_workspace: "assist.tool.search",
  budget_status: "assist.tool.budget",
  list_tasks: "assist.tool.tasks",
  time_summary: "assist.tool.time",
  activity_log: "assist.tool.activity",
  run_powershell: "assist.tool.powershell",
  git: "assist.tool.git",
  http_request: "assist.tool.http",
  jira_search: "assist.tool.jiraSearch",
  jira_issue: "assist.tool.jiraIssue",
  jira_my_issues: "assist.tool.jiraMine",
  jira_comment: "assist.tool.jiraComment",
  jira_transition: "assist.tool.jiraTransition",
};
/** A tool's name in the display language (unknown tools as named). */
export const toolLabel = (name: string) => (TOOL_KEYS[name] ? t(TOOL_KEYS[name]) : name);

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

/** Where a conversation is shown: the assistant in the side panel or the chat view. */
export type SessionId = "panel" | "view";

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
  /** Bumped when the saved list changed (the history lists reload). */
  listVersion: number;
  /** Bumped to scroll to the end (a new question). */
  followTick: number;
  /** Bumped to put the focus back into the composer. */
  focusTick: number;
  input: string;
  tier: Tier | null;
  useTools: boolean;
  /** Panel: the open page goes along. */
  includePage: boolean;
  /** The answers may use the notes: search, sources and the tools. Always on in the panel. */
  notes: boolean;
  /** Chat view: the page attached as context. */
  attachedPage: number | null;
}

/** One place a conversation is shown, with its own current chat. */
export interface ChatSession {
  id: SessionId;
  use: UseBoundStore<StoreApi<ChatState>>;
  /** Asks `text` in the current chat and runs the tool rounds of the answer. */
  send: (text: string, opts?: SendOpts) => Promise<void>;
  /** Ends the running answer: cancels the request and rejects waiting tool approvals. */
  stop: () => void;
  newChat: () => void;
  /** Opens a saved chat to read and continue it. */
  open: (id: number) => Promise<void>;
  /** „Neu generieren“ / „Erneut versuchen“: asks the question of `turnId` again in its place. */
  regenerate: (turnId: string) => Promise<void>;
  /** Sends an edited question in place of `userId` (and drops what followed it). */
  editAndResend: (userId: string, text: string) => Promise<void>;
  rename: (title: string) => Promise<void>;
  /** Takes over the chat of `from` (its turns, model history and saved conversation). */
  adopt: (from: ChatSession, quiet?: boolean) => void;
  /** Leaves the current chat without a trace (it was deleted). */
  clear: () => void;
  /** The model's view of the current chat. */
  history: () => ChatMessage[];
}

export interface SendOpts extends AskOpts {
  /** Replaces the page context of the composer (null: none). */
  pageId?: number | null;
}

/** The open page the assistant may read: the active tab's page, once loaded. */
export function currentPage() {
  const s = useApp.getState();
  const tab = s.tabs.find((x) => x.id === s.activeTabId);
  return tab?.kind === "page" && s.activeDoc && s.activeDoc.id === tab.pageId ? s.activeDoc : null;
}

const saving = () => (useApp.getState().settings?.settings.ai.chat_history ?? "all") !== "off";

const sessions: ChatSession[] = [];

/** Every history list reloads (the panel's and the chat view's). */
function bumpList() {
  for (const s of sessions) s.use.setState((st) => ({ listVersion: st.listVersion + 1 }));
}

/** Applies `f` to the conversation `id` wherever it is open. */
function patchConversation(id: number, f: (c: ChatConversation) => ChatConversation) {
  for (const s of sessions) {
    const c = s.use.getState().conversation;
    if (c?.id === id) s.use.setState({ conversation: f(c) });
  }
}

/** Saves records of conversation `id` in order (one save at a time, for all sessions). */
let saveChain: Promise<unknown> = Promise.resolve();
function save(id: number | null, records: ChatRecord[], pageId: number | null, priv: boolean, onSaved?: (seqs: number[]) => void) {
  if (id == null || !records.length) return saveChain;
  const batch = records.splice(0);
  saveChain = saveChain
    .then(() => api.chatAppend(id, batch, pageId, priv))
    .then((r) => {
      if (!r) return;
      onSaved?.(r.seqs);
      for (const s of sessions) {
        const st = s.use.getState();
        if (st.conversation?.id === id) s.use.setState({ conversation: r.conversation, private: r.conversation.private || st.private });
      }
      bumpList();
    })
    .catch((e) => console.warn("chat not saved", e));
  return saveChain;
}

function summarizeArgs(c: ToolCall) {
  try {
    const a = JSON.parse(c.function.arguments);
    return a.command ?? a.query ?? a.netzplan ?? (a.from && a.to ? `${a.from} – ${a.to}` : "");
  } catch {
    return "";
  }
}

/** „Mit … geführt, neue Antworten kommen von …“ when the tier's model changed since. */
function noticeFor(conv: ChatConversation, chosen: Tier | null): string | null {
  const settings = useApp.getState().settings?.settings;
  if (!settings || !conv.model) return null;
  const tier = (chosen ?? conv.tier ?? "standard") as Tier;
  const r = settings.router as unknown as Record<string, string | undefined>;
  const provider = r[`${tier}_provider`] || settings.providers[0]?.id || "";
  const model = r[`${tier}_model`];
  if (!model) return null;
  const same = model === conv.model && (!conv.provider || !provider || provider === conv.provider);
  if (same) return null;
  const providers = settings.providers ?? [];
  return t("chat.modelChanged", { old: modelLabel(providers, conv.provider, conv.model), now: modelLabel(providers, provider, model) });
}

/** What a send of a session uses: the notes and tools, and the page that goes along. */
export function sendScope(id: SessionId, st: Pick<ChatState, "notes" | "useTools" | "includePage" | "attachedPage">, openPage: number | null, opts: Pick<SendOpts, "tools" | "pageId"> = {}) {
  const notes = id === "panel" || st.notes;
  const tools = notes && (opts.tools ?? st.useTools);
  const page = opts.pageId !== undefined ? opts.pageId : id === "panel" ? (st.includePage ? openPage : null) : st.attachedPage;
  return { notes, tools, page };
}

/**
 * Whether `to` should take over the chat of `from`: the same saved conversation, `to` is not
 * answering itself and does not show `from`'s turns already. When `from` just finished an
 * answer it takes it over in any case (the model history is complete only then).
 */
export function shouldMirror(from: Pick<ChatState, "conversation" | "turns">, to: Pick<ChatState, "conversation" | "turns" | "busy">, finished = false) {
  return !!from.conversation && to.conversation?.id === from.conversation.id && !to.busy && (finished || to.turns !== from.turns);
}

function createSession(id: SessionId): ChatSession {
  const use = create<ChatState>(() => ({
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
    tier: (pref("arcalo.tier") as Tier | null) || null,
    useTools: pref("arcalo.tools") !== "0",
    includePage: true,
    notes: id === "panel" || pref("arcalo.chatNotes") === "1",
    attachedPage: null,
  }));
  const get = use.getState;
  const set = use.setState;

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

  const updateTurn = (tid: string, patch: Partial<Turn>) => set((st) => ({ turns: st.turns.map((x) => (x.id === tid ? ({ ...x, ...patch } as Turn) : x)) }));

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
  const onStream = (request_id: string, event: StreamEvent) => {
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
  };
  streamHandlers.push(onStream);

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
      const tid = turnId();
      const name = c.function.name;
      const label = toolLabel(name);
      set((st) => ({ turns: [...st.turns, { id: tid, kind: "tool", name, label, status: "running" }] }));
      let card: { status: "done" | "error" | "rejected"; summary?: string; output?: string };
      let out: string;
      try {
        const plan = await api.planTool(name, c.function.arguments);
        if (plan.risk === "workspace") {
          // Jira tools ask Jira (async, with the cache as fallback); the others read the workspace.
          out = name.startsWith("jira_") ? await jiraApi.tool(name, c.function.arguments) : await api.runWorkspaceTool(name, c.function.arguments);
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
            else updateTurn(tid, { status: "pending", summary: plan.summary, decide });
          });
          if (!ok) {
            out = t("assist.toolRejected");
            card = { status: "rejected", summary: plan.summary };
          } else {
            updateTurn(tid, { status: "running", decide: undefined });
            out = await api.runSystemTool(plan.call);
            card = { status: "done", summary: plan.summary, output: out };
          }
        }
      } catch (e) {
        out = `Fehler: ${errorText(e)}`;
        card = { status: "error", output: errorText(e) };
      }
      updateTurn(tid, { ...card, decide: undefined });
      results.push({ role: "tool", tool_call_id: c.id, content: out });
      records.push({ role: "tool", content: out, tool_call_id: c.id, tool: { name, label, ...card } });
    }
    return { results, records };
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
      bumpList();
      return created.id;
    } catch (e) {
      console.warn("chat not saved", e);
      return null;
    }
  }

  async function send(textArg: string, opts: SendOpts = {}) {
    const text = textArg.trim();
    const st = get();
    if (!text || st.busy || busyElsewhere(session)) return;
    const scope = sendScope(id, st, id === "panel" ? (currentPage()?.id ?? null) : null, opts);
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
    const page = scope.page;
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
          api.chat({ requestId: rid, messages: chat, useTools: scope.tools, tier: get().tier, pageId: page, overrideLimit, conversationId: convId, notes: scope.notes }),
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

  function stop() {
    run++;
    const rid = requestId;
    if (rid) api.cancelChat(rid).catch(() => {});
    for (const decide of [...approvals]) decide(false);
  }

  /** Leaves the current chat (a reply on its way is saved to it, not shown). */
  function leave() {
    if (get().busy || approvals.size) stop();
    requestId = null;
    endStream();
    history = [];
    activeSend = null;
  }

  function newChat() {
    leave();
    set((s) => ({ busy: false, turns: [], conversation: null, private: false, notice: null, historyOpen: false, focusTick: s.focusTick + 1 }));
  }

  async function open(cid: number) {
    const doc = await api.chatGet(cid);
    leave();
    const { turns, history: h } = restoreChat(doc.messages);
    history = h;
    set((s) => ({
      busy: false,
      turns,
      conversation: doc.conversation,
      private: doc.conversation.private,
      notice: noticeFor(doc.conversation, s.tier),
      historyOpen: false,
      followTick: s.followTick + 1,
      focusTick: s.focusTick + 1,
    }));
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

  async function regenerate(turnIdArg: string) {
    if (get().busy || busyElsewhere(session)) return;
    const user = questionOf(turnIdArg);
    if (!user) return;
    await cutBefore(user.id);
    await send(user.prompt, { ...user.opts });
  }

  async function editAndResend(userId: string, text: string) {
    const user = get().turns.find((x) => x.id === userId);
    if (get().busy || busyElsewhere(session) || user?.kind !== "user" || !text.trim()) return;
    await cutBefore(user.id);
    await send(text, { tools: user.opts?.tools });
  }

  async function rename(title: string) {
    const conv = get().conversation;
    if (!conv || !title.trim()) return;
    const updated = await api.chatUpdate(conv.id, { title });
    patchConversation(updated.id, () => updated);
    bumpList();
  }

  function adopt(from: ChatSession, quiet = false) {
    if (from === session) return;
    const src = from.use.getState();
    if (!quiet) leave();
    else {
      requestId = null;
      endStream();
    }
    // Its own array: a send here must not write into the other session's chat.
    history = [...from.history()];
    set((s) => ({
      turns: src.turns,
      conversation: src.conversation,
      private: src.private,
      notice: quiet ? s.notice : src.notice,
      busy: false,
      historyOpen: false,
      followTick: quiet ? s.followTick : s.followTick + 1,
      focusTick: quiet ? s.focusTick : s.focusTick + 1,
    }));
  }

  function clear() {
    leave();
    set({ busy: false, turns: [], conversation: null, private: false, notice: null });
  }

  const session: ChatSession = { id, use, send, stop, newChat, open, regenerate, editAndResend, rename, adopt, clear, history: () => history };
  sessions.push(session);
  // A saved chat open in both sessions: the other one shows what this one adds (live while
  // the answer streams in) and continues with the same history.
  use.subscribe((st, prev) => {
    const finished = prev.busy && !st.busy;
    if (!finished && st.turns === prev.turns && st.conversation === prev.conversation && st.private === prev.private) return;
    for (const other of sessions) {
      if (other !== session && shouldMirror(st, other.use.getState(), finished)) other.adopt(session, true);
    }
  });
  return session;
}

// Stream listeners of the sessions (one `ai://stream` subscription for all of them).
const streamHandlers: ((requestId: string, event: StreamEvent) => void)[] = [];

/** The side panel's assistant. */
export const panelChat = createSession("panel");
/** The chat view in the main area. */
export const viewChat = createSession("view");

export const sessionById = (id: SessionId) => (id === "panel" ? panelChat : viewChat);
export const otherSession = (s: ChatSession) => (s === panelChat ? viewChat : panelChat);

/** The other session answering in the same saved chat right now (this one waits for it). */
export function busyElsewhere(s: ChatSession): ChatSession | null {
  const conv = s.use.getState().conversation;
  const other = otherSession(s);
  const o = other.use.getState();
  return conv && o.busy && o.conversation?.id === conv.id ? other : null;
}

// The panel's session under the names the panel and the rest of the app have always used.
export const useChat = panelChat.use;
export const sendChat = (text: string, opts?: SendOpts) => panelChat.send(text, opts);
export const stopChat = () => panelChat.stop();
export const newChat = () => panelChat.newChat();
export const openChat = (id: number) => panelChat.open(id);
export const regenerate = (turnIdArg: string) => panelChat.regenerate(turnIdArg);
export const editAndResend = (userId: string, text: string) => panelChat.editAndResend(userId, text);
export const renameChat = (title: string) => panelChat.rename(title);
/** „Mit … geführt, neue Antworten kommen von …“ (the panel's model choice). */
export const modelNotice = (conv: ChatConversation) => noticeFor(conv, panelChat.use.getState().tier);

/** The model choice and the tools switch hold for the panel and the chat view alike. */
export function setTier(tier: Tier | null) {
  for (const s of sessions) s.use.setState({ tier });
  savePref("arcalo.tier", tier);
}
export function setUseTools(on: boolean) {
  for (const s of sessions) s.use.setState({ useTools: on });
  savePref("arcalo.tools", on ? "1" : "0");
}
/** Chat view: „Mit meinen Notizen“. */
export function setNotes(on: boolean) {
  viewChat.use.setState({ notes: on });
  savePref("arcalo.chatNotes", on ? "1" : "0");
}

let listening = false;
/** Listens for streamed answers and the session meter (once, for the app's lifetime). */
export function ensureChatListeners() {
  if (listening) return;
  listening = true;
  on<{ request_id: string; event: StreamEvent }>("ai://stream", ({ request_id, event }) => {
    for (const h of streamHandlers) h(request_id, event);
  }).catch(() => {
    listening = false;
  });
  on("ai://meter", (m) => useApp.getState().set({ meter: m as never })).catch(() => {});
}

/** Renames a saved chat (from a history list); open in a session, it shows there at once. */
export async function renameChatById(conv: ChatConversation, title: string) {
  const updated = await api.chatUpdate(conv.id, { title });
  patchConversation(conv.id, () => updated);
  bumpList();
  return updated;
}

/** Pins or unpins a saved chat. */
export async function togglePinChat(conv: ChatConversation) {
  await api.chatUpdate(conv.id, { pinned: !conv.pinned });
  patchConversation(conv.id, (c) => ({ ...c, pinned: !conv.pinned }));
  bumpList();
}

/** Deletes a saved chat with „Rückgängig“ in the toast; where it was open a new chat starts. */
export async function deleteChat(conv: ChatConversation) {
  const s = useApp.getState();
  try {
    await api.chatDelete(conv.id);
  } catch (e) {
    s.error(t("chat.deleteFailed"), e);
    return;
  }
  const openIn = sessions.filter((x) => x.use.getState().conversation?.id === conv.id);
  for (const x of openIn) x.clear();
  bumpList();
  s.toast({
    tone: "info",
    title: t("chat.deleted", { title: conv.title || t("chat.untitled") }),
    action: {
      label: t("chat.undo"),
      run: async () => {
        try {
          await api.chatRestore(conv.id);
          bumpList();
          for (const x of openIn) if (!x.use.getState().turns.length) await x.open(conv.id);
        } catch (e) {
          useApp.getState().error(t("chat.restoreFailed"), e);
        }
      },
    },
  });
}

/** „Duplizieren“: a copy to continue separately, opened in `into`. */
export async function duplicateChat(conv: ChatConversation, into: ChatSession = panelChat) {
  try {
    const copy = await api.chatDuplicate(conv.id, t("chat.copyTitle", { title: conv.title || t("chat.untitled") }));
    if (!copy) return;
    bumpList();
    await into.open(copy.id);
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
    const open = sessions.find((x) => x.use.getState().conversation?.id === conv.id);
    const turns = open ? open.use.getState().turns : restoreChat((await api.chatGet(conv.id)).messages).turns;
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
  panelChat.use.setState({ historyOpen: open });
}

const focusComposer = (scope: string) => setTimeout(() => document.querySelector<HTMLTextAreaElement>(`${scope} .composer textarea`)?.focus(), 50);

/**
 * Opens the chat view (focusing its tab when one is open): with a saved chat, with the chat of
 * `from` (the panel's „Im Chat-Fenster öffnen“) or as it was.
 */
export async function openChatView(opts: { id?: number; from?: ChatSession; fresh?: boolean } = {}) {
  // „KI verwenden“ off: there is no chat view (a shortcut or link does nothing).
  if (!aiEnabled()) return;
  useApp.getState().openTab({ kind: "chat" });
  try {
    if (opts.fresh) viewChat.newChat();
    else if (opts.from) {
      const unsaved = !opts.from.use.getState().conversation;
      viewChat.adopt(opts.from);
      // An unsaved chat moves (there is nothing to keep both in step with).
      if (unsaved) opts.from.newChat();
    } else if (opts.id != null && viewChat.use.getState().conversation?.id !== opts.id) await viewChat.open(opts.id);
  } catch (e) {
    useApp.getState().error(t("chat.openFailed"), e);
  }
  focusComposer(".chat-view");
}

/** Opens a chat of the chat view in the side panel's assistant. */
export async function openInPanel(opts: { id?: number; from?: ChatSession }) {
  const s = useApp.getState();
  s.set({ panelOpen: true, panelTab: "assistant" });
  try {
    if (opts.from) {
      const unsaved = !opts.from.use.getState().conversation;
      panelChat.adopt(opts.from);
      if (unsaved) opts.from.newChat();
    } else if (opts.id != null && panelChat.use.getState().conversation?.id !== opts.id) await panelChat.open(opts.id);
  } catch (e) {
    s.error(t("chat.openFailed"), e);
  }
  focusComposer(".assistant");
}

/** „Alle Chats löschen“ (Settings → Datenschutz). */
export async function deleteAllChats() {
  const n = await api.chatDeleteAll();
  for (const s of sessions) if (s.use.getState().conversation) s.clear();
  bumpList();
  return n;
}

/** For tests: the model history of the panel's chat. */
export const chatHistoryForTests = () => panelChat.history();
