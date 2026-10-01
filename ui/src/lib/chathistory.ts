// The assistant's chat history: what a turn looks like in the panel, how a saved conversation
// becomes turns and model messages again, automatic titles and the groups of the history list.

import { fmtDate, formatPrefs, weekdayShort } from "./format";
import type { ChatConversation, ChatMessage, ChatRecord, ContextChunk, StoredChatRecord, Tier, ToolCall } from "./types";
import { t } from "./i18n";

export interface TurnMeta {
  model: string;
  tier: Tier;
  ttft: number | null;
  tps: number | null;
  tokens: number;
  cost: number;
  exact: boolean;
  reasons: string[];
}

/** How a question was asked: tools on or off, the page title an answer offers („Wochenbericht“). */
export interface AskOpts {
  tools?: boolean;
  pageTitle?: string;
  display?: string;
}

export type ToolStatus = "running" | "done" | "error" | "pending" | "rejected";

export type Turn =
  | {
      id: string;
      kind: "user";
      /** What the panel shows (a short label for a long generated prompt). */
      text: string;
      /** What the model got. */
      prompt: string;
      /** Messages of the model history before this question (a regenerate cuts there). */
      hist: number;
      /** Its position in the saved conversation, once saved. */
      seq?: number;
      opts?: AskOpts;
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming: boolean;
      meta?: TurnMeta;
      sources?: ContextChunk[];
      error?: string;
      cancelled?: boolean;
      /** The server pauses the model; the request is repeated at `until` (ms). */
      waiting?: { until: number; model: string };
      /** Offers „In neue Seite einfügen“ with this title (weekly report). */
      pageTitle?: string;
    }
  | { id: string; kind: "tool"; name: string; label: string; status: ToolStatus; summary?: string; output?: string; decide?: (ok: boolean) => void };

let counter = 0;
export const turnId = () => `t${Date.now().toString(36)}${(counter++).toString(36)}`;

const TIERS: Tier[] = ["local", "standard", "reasoning"];
const asTier = (t: string | undefined): Tier => (TIERS.includes(t as Tier) ? (t as Tier) : "standard");

/**
 * A saved conversation as panel turns and as the history the model gets: messages of failed
 * turns are shown but not sent, tool calls whose answers were never saved (the app closed
 * while a tool ran) get „Abgebrochen.“ so the history stays valid, and tool answers without
 * their call are left out.
 */
export function restoreChat(records: StoredChatRecord[]): { turns: Turn[]; history: ChatMessage[] } {
  const turns: Turn[] = [];
  const history: ChatMessage[] = [];
  // Calls of the last assistant message still waiting for their answer.
  let open: string[] = [];
  const closeCalls = () => {
    for (const id of open) history.push({ role: "tool", tool_call_id: id, content: "Abgebrochen." });
    open = [];
  };
  for (const m of records) {
    const inContext = m.in_context !== false;
    if (m.role === "user") {
      if (inContext) closeCalls();
      turns.push({
        id: `s${m.seq}`,
        kind: "user",
        text: m.display || m.content,
        prompt: m.content,
        hist: inContext ? history.length : history.length + open.length,
        seq: m.seq,
        opts: m.display ? { display: m.display } : undefined,
      });
      if (inContext) history.push({ role: "user", content: m.content });
    } else if (m.role === "assistant") {
      const calls = m.tool_calls?.length ? m.tool_calls : undefined;
      if (m.content || m.error || !calls)
        turns.push({
          id: `s${m.seq}`,
          kind: "assistant",
          text: m.content,
          streaming: false,
          error: m.error ?? undefined,
          cancelled: m.cancelled || undefined,
          sources: m.citations ?? undefined,
          pageTitle: m.page_title ?? undefined,
          meta: m.model
            ? {
                model: m.meta?.model ?? m.model,
                tier: asTier(m.tier),
                ttft: m.meta?.ttft ?? null,
                tps: m.meta?.tps ?? null,
                tokens: m.tokens ?? 0,
                cost: m.cost_usd ?? 0,
                exact: m.meta?.exact ?? true,
                reasons: m.reasons ?? [],
              }
            : undefined,
        });
      if (inContext) {
        closeCalls();
        history.push({ role: "assistant", content: m.content || null, tool_calls: calls });
        open = (calls ?? []).map((c: ToolCall) => c.id);
      }
    } else {
      const tool = m.tool;
      if (tool) {
        // A step that never finished (the app closed meanwhile) counts as failed.
        const finished = ["done", "error", "rejected"].includes(tool.status);
        turns.push({
          id: `s${m.seq}`,
          kind: "tool",
          name: tool.name,
          label: tool.label || tool.name,
          status: (finished ? tool.status : "error") as ToolStatus,
          summary: tool.summary,
          output: tool.output ?? (finished ? undefined : "Unterbrochen"),
        });
      }
      const id = m.tool_call_id ?? "";
      if (inContext && open.includes(id)) {
        history.push({ role: "tool", tool_call_id: id, content: m.content });
        open = open.filter((x) => x !== id);
      }
    }
  }
  closeCalls();
  return { turns, history };
}

const GREETING = /^(hallo|hi|hey|moin|servus|guten (morgen|tag|abend)|hello)\b[\s,.!:;-]*/i;
const POLITE = /^(kannst|könntest|würdest) du (mir )?(bitte )?|^bitte\s+|^please\s+|^can you (please )?|^could you (please )?/i;

/** A short title from the first question: no quotes, code, links or greeting; at most `max` characters, cut at a word. */
export function autoTitle(question: string, max = 48): string {
  const lines = question.split("\n");
  const own = lines.filter((l) => !/^\s*>/.test(l));
  let text = (own.some((l) => l.trim()) ? own : lines.map((l) => l.replace(/^\s*>\s?/, ""))).join(" ");
  text = text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/^@(local|standard|reasoning)\b/i, "")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/(?:www\.)?([^/\s]+)\S*/g, "$1")
    // Tags (also the privacy markers: the lock says it) are no part of a title.
    .replace(/(^|\s)#[\p{L}\p{N}_/-]+/gu, "$1")
    .replace(/[*_`#~=>]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(GREETING, "")
    .replace(POLITE, "")
    .trim();
  // The first sentence, when it says enough on its own.
  const first = /^(.{12,}?[.?!])(\s|$)/.exec(text)?.[1];
  if (first) text = first;
  text = text.replace(/[.!:;,]+$/, "");
  if (!text) return t("chat.newChat");
  if (text.length > max) {
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    text = `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export type HistoryGroupKey = "pinned" | "today" | "yesterday" | "week" | "older";
export interface HistoryGroup {
  key: HistoryGroupKey;
  items: ChatConversation[];
}

const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The groups of the history list in order: pinned, today, yesterday, the last 7 days, older (local days). */
export function groupConversations(list: ChatConversation[], now = new Date()): HistoryGroup[] {
  const today = dayStart(now);
  const yesterday = dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const week = dayStart(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
  const groups: Record<HistoryGroupKey, ChatConversation[]> = { pinned: [], today: [], yesterday: [], week: [], older: [] };
  for (const c of list) {
    if (c.pinned) {
      groups.pinned.push(c);
      continue;
    }
    const at = new Date(c.updated_at).getTime();
    const key: HistoryGroupKey = at >= today ? "today" : at >= yesterday ? "yesterday" : at >= week ? "week" : "older";
    groups[key].push(c);
  }
  return (Object.keys(groups) as HistoryGroupKey[]).filter((k) => groups[k].length).map((key) => ({ key, items: groups[key] }));
}

/** When a chat was last used: the time today, weekday and time this week, the day before („24.09.“). */
export function historyDate(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
  if (days <= 0) return time;
  if (days < 7) return `${weekdayShort(d)} ${time}`;
  if (d.getFullYear() === now.getFullYear() && formatPrefs().dateFormat !== "iso") return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  return fmtDate(d);
}

/** A search snippet as text parts; `hit` marks the matched words. */
export function snippetParts(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  for (const [i, part] of snippet.split(/[\u0002\u0003]/).entries()) if (part) out.push({ text: part.replace(/\s+/g, " "), hit: i % 2 === 1 });
  return out;
}

/** The record of a finished answer for the history. */
export function answerRecord(turn: Extract<Turn, { kind: "assistant" }>, route: { provider?: string; model?: string }, toolCalls?: ToolCall[]): ChatRecord {
  const m = turn.meta;
  return {
    role: "assistant",
    content: turn.text,
    tool_calls: toolCalls?.length ? toolCalls : null,
    citations: turn.sources?.length ? turn.sources : null,
    provider: route.provider ?? "",
    model: route.model ?? "",
    tier: m?.tier ?? "",
    reasons: m?.reasons ?? null,
    meta: m ? { model: m.model, ttft: m.ttft, tps: m.tps, exact: m.exact } : null,
    tokens: m?.tokens ?? 0,
    cost_usd: m?.cost ?? 0,
    error: turn.error ?? null,
    cancelled: !!turn.cancelled,
    page_title: turn.pageTitle ?? null,
  };
}

/** A conversation as Markdown for „Als Seite speichern“: questions as quotes, answers as they are. */
export function chatMarkdown(turns: Turn[], privateTag: string | null): string {
  const parts: string[] = [];
  for (const t of turns) {
    if (t.kind === "user") parts.push(t.text.split("\n").map((l) => `> ${l}`).join("\n"));
    else if (t.kind === "assistant" && t.text) parts.push(t.text.trim());
  }
  if (privateTag) parts.push(privateTag);
  return `${parts.join("\n\n")}\n`;
}
