// Runs one `ai_transform` request and collects its streamed text (inline AI bar, meeting summary).

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorText, on } from "./api";
import { cleanAiMarkdown } from "./aitext";
import { useApp } from "../store/app";
import type { ChatOutcome, StreamEvent, Tier } from "./types";
import { streamingOn, warnCost, withCostLimit } from "./aicost";

export interface TransformMeta {
  model: string;
  tier: Tier;
  cost: number;
  tokens: number;
  exact: boolean;
  reasons: string[];
}

export interface TransformState {
  /** The answer so far (outer code fence removed). */
  text: string;
  busy: boolean;
  error: string | null;
  cancelled: boolean;
  meta: TransformMeta | null;
}

const IDLE: TransformState = { text: "", busy: false, error: null, cancelled: false, meta: null };

export function useAiTransform() {
  const [state, setState] = useState<TransformState>(IDLE);
  const requestId = useRef<string | null>(null);
  const raw = useRef("");

  useEffect(() => {
    let frame = 0;
    const un = on<{ request_id: string; event: StreamEvent }>("ai://stream", ({ request_id, event }) => {
      if (request_id !== requestId.current || event.type !== "delta") return;
      raw.current += event.text;
      // Settings → KI „Antworten live anzeigen“ off: only the finished answer is shown.
      if (!streamingOn()) return;
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (request_id === requestId.current) setState((s) => ({ ...s, text: cleanAiMarkdown(raw.current) }));
        });
    });
    return () => {
      un.then((f) => f());
      cancelAnimationFrame(frame);
      // Unmounted while streaming: stop the request.
      if (requestId.current) api.cancelChat(requestId.current).catch(() => {});
      requestId.current = null;
    };
  }, []);

  /** Runs another streaming request the same way (e.g. the day review's local summary). */
  const runWith = useCallback(async (call: (requestId: string, overrideLimit: boolean) => Promise<ChatOutcome>) => {
    if (requestId.current) await api.cancelChat(requestId.current).catch(() => {});
    const rid = crypto.randomUUID();
    requestId.current = rid;
    raw.current = "";
    setState({ ...IDLE, busy: true });
    try {
      const out = await withCostLimit((overrideLimit) => call(rid, overrideLimit));
      warnCost(out.cost_warning);
      if (requestId.current !== rid) return;
      const c = out.completion;
      useApp.getState().set({ meter: out.meter });
      setState({
        text: cleanAiMarkdown(c.content),
        busy: false,
        error: null,
        cancelled: c.finish_reason === "cancelled",
        meta: {
          model: out.route.model,
          tier: out.route.tier,
          cost: c.usage.cost_usd,
          tokens: c.usage.prompt_tokens + c.usage.completion_tokens,
          exact: c.exact_usage,
          reasons: out.route.reasons,
        },
      });
    } catch (e) {
      if (requestId.current !== rid) return;
      setState((s) => ({ ...s, busy: false, error: errorText(e) }));
    } finally {
      if (requestId.current === rid) requestId.current = null;
    }
  }, []);

  const run = useCallback(
    (instruction: string, text: string, pageId: number | null) => runWith((requestId, overrideLimit) => api.transform({ requestId, instruction, text, pageId, overrideLimit })),
    [runWith],
  );

  const cancel = useCallback(() => {
    if (requestId.current) api.cancelChat(requestId.current).catch(() => {});
  }, []);

  const reset = useCallback(() => {
    if (requestId.current) api.cancelChat(requestId.current).catch(() => {});
    requestId.current = null;
    setState(IDLE);
  }, []);

  return { ...state, run, runWith, cancel, reset };
}
