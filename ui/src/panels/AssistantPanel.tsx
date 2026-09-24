// The AI assistant: streaming chat over the configured AI providers with workspace context,
// sources, cost/speed metrics and approval-gated tools.

import { streamingOn, warnCost, withCostLimit } from "../lib/aicost";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, CalendarRange, Check, ChevronDown, Copy, FilePlus2, FileText, Gauge, GitBranch, Globe, ListChecks, Loader2, Plus, Search, Settings2, ShieldAlert, Sparkles, Square, Terminal, Timer, Wrench, X, AlertTriangle, ClipboardType, FileInput, MessageSquarePlus, PencilLine, Quote, RefreshCw, History } from "lucide-react";
import { api, errorText, on } from "../lib/api";
import { aiErrorSummary } from "../lib/aierror";
import { renderMarkdown } from "../lib/markdown";
import { citedNumbers, linkCitations } from "../lib/citations";
import { revealText } from "../editor/reveal";
import { previewMarkdown } from "../components/LinkPreview";
import { useApp } from "../store/app";
import { Button, IconButton, useMenu, type MenuEntry } from "../components/ui";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { h1, usd } from "../lib/format";
import { modelLabel, usableProvider } from "../lib/providers";
import type { ChatMessage, ContextChunk, RouteDecision, StreamEvent, Tier, ToolCall } from "../lib/types";
import type { SuggestionKind } from "../lib/suggestions";
import { useSuggestions } from "./useSuggestions";

type Turn =
  | { id: string; kind: "user"; text: string }
  | {
      id: string;
      kind: "assistant";
      text: string;
      streaming: boolean;
      meta?: { model: string; tier: Tier; ttft: number | null; tps: number | null; tokens: number; cost: number; exact: boolean; reasons: string[] };
      sources?: ContextChunk[];
      error?: string;
      cancelled?: boolean;
      /** Offers „In neue Seite einfügen“ with this title (weekly report). */
      pageTitle?: string;
    }
  | { id: string; kind: "tool"; name: string; label: string; status: "running" | "done" | "error" | "pending" | "rejected"; summary?: string; output?: string; decide?: (ok: boolean) => void };

const TOOL_META: Record<string, { label: string; icon: typeof Search }> = {
  log_time: { label: "Zeit buchen", icon: Timer },
  search_workspace: { label: "Workspace durchsuchen", icon: Search },
  budget_status: { label: "Budget abfragen", icon: Gauge },
  list_tasks: { label: "Aufgaben abfragen", icon: ListChecks },
  time_summary: { label: "Zeitübersicht abfragen", icon: CalendarRange },
  activity_log: { label: "Aktivität abfragen", icon: History },
  run_powershell: { label: "PowerShell ausführen", icon: Terminal },
  git: { label: "Git-Befehl", icon: GitBranch },
  http_request: { label: "HTTP-Anfrage", icon: Globe },
};

const SUGGESTION_ICON: Record<SuggestionKind, typeof Search> = {
  page: FileText,
  tasks: ListChecks,
  time: Timer,
  budget: Gauge,
  report: CalendarRange,
  plan: Sparkles,
};

/** Quick follow-ups under the last answer. */
const FOLLOW_UPS = ["Kürzer", "Als Stichpunkte", "Als Tabelle", "Auf Englisch"];

const uid = () => Math.random().toString(36).slice(2, 10);
const tierLabel: Record<Tier, string> = { local: "Lokal", standard: "Standard", reasoning: "Reasoning" };

export function AssistantPanel() {
  const settings = useApp((s) => s.settings);
  const activeDoc = useApp((s) => s.activeDoc);
  const activeTab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tier, setTier] = useState<Tier | null>(() => (localStorage.getItem("annalo.tier") as Tier | null) || null);
  const [useTools, setUseTools] = useState(() => localStorage.getItem("annalo.tools") !== "0");
  const [includePage, setIncludePage] = useState(true);
  const [preview, setPreview] = useState<RouteDecision | null>(null);
  const history = useRef<ChatMessage[]>([]);
  const requestId = useRef<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [menu, openMenu, openMenuAt] = useMenu();
  const s = useApp.getState;

  const pageContext = activeTab?.kind === "page" && activeDoc && activeDoc.id === activeTab.pageId ? activeDoc : null;
  const suggestions = useSuggestions(pageContext);

  const update = (id: string, patch: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? ({ ...t, ...patch } as Turn) : t)));

  // Stream deltas into the current assistant turn, batched per frame.
  useEffect(() => {
    let buffer = "";
    let frame = 0;
    let target: string | null = null;
    const un = on<{ request_id: string; event: StreamEvent }>("ai://stream", ({ request_id, event }) => {
      if (request_id !== requestId.current) return;
      // Settings → KI „Antworten live anzeigen“ off: the answer appears when complete.
      if (event.type === "delta" && streamingOn()) {
        buffer += event.text;
        target = request_id;
        if (!frame)
          frame = requestAnimationFrame(() => {
            frame = 0;
            const chunk = buffer;
            buffer = "";
            setTurns((ts) => {
              const last = ts[ts.length - 1];
              if (!last || last.kind !== "assistant" || !target) return ts;
              return [...ts.slice(0, -1), { ...last, text: last.text + chunk }];
            });
          });
      }
    });
    const un2 = on("ai://meter", (m) => s().set({ meter: m as never }));
    return () => {
      un.then((f) => f());
      un2.then((f) => f());
      cancelAnimationFrame(frame);
    };
  }, [s]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);

  // A palette question may arrive before this panel mounts; take it once idle.
  const pendingAsk = useApp((st) => st.pendingAsk);
  useEffect(() => {
    const q = s().pendingAsk;
    if (!q || busy) return;
    s().set({ pendingAsk: null });
    if (typeof q === "string") send(q);
    else send(q.text, { pageTitle: q.pageTitle, tools: q.tools, display: q.display });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk, busy]);

  useEffect(() => {
    if (!input.trim()) return setPreview(null);
    const t = setTimeout(() => api.routePreview(input, useTools, tier).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [input, tier, useTools]);

  const runTools = async (calls: ToolCall[]): Promise<ChatMessage[]> => {
    const results: ChatMessage[] = [];
    for (const c of calls) {
      const id = uid();
      const meta = TOOL_META[c.function.name];
      setTurns((ts) => [...ts, { id, kind: "tool", name: c.function.name, label: meta?.label ?? c.function.name, status: "running" }]);
      try {
        const plan = await api.planTool(c.function.name, c.function.arguments);
        let out: string;
        if (plan.risk === "workspace") {
          out = await api.runWorkspaceTool(c.function.name, c.function.arguments);
          if (c.function.name === "log_time") {
            try {
              s().alerts(JSON.parse(out).alerts ?? []);
            } catch {
              /* ignore */
            }
            s().bumpEntries();
          }
          update(id, { status: "done", summary: summarizeArgs(c) });
        } else {
          const ok = await new Promise<boolean>((resolve) => update(id, { status: "pending", summary: plan.summary, decide: resolve }));
          if (!ok) {
            update(id, { status: "rejected", decide: undefined });
            out = "Der Nutzer hat die Ausführung abgelehnt.";
          } else {
            update(id, { status: "running", decide: undefined });
            out = await api.runSystemTool(plan.call);
            update(id, { status: "done", output: out });
          }
        }
        results.push({ role: "tool", tool_call_id: c.id, content: out });
      } catch (e) {
        update(id, { status: "error", output: errorText(e) });
        results.push({ role: "tool", tool_call_id: c.id, content: `Fehler: ${errorText(e)}` });
      }
    }
    return results;
  };

  async function send(textArg?: string, opts: { pageTitle?: string; tools?: boolean; display?: string } = {}) {
    const text = (textArg ?? input).trim();
    const tools = opts.tools ?? useTools;
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    stick.current = true;
    setTurns((ts) => [...ts, { id: uid(), kind: "user", text: opts.display ?? text }]);
    const turnStart = history.current.length;
    history.current.push({ role: "user", content: text });
    try {
      for (let round = 0; round < 5; round++) {
        const aid = uid();
        const rid = crypto.randomUUID();
        requestId.current = rid;
        setTurns((ts) => [...ts, { id: aid, kind: "assistant", text: "", streaming: true, pageTitle: opts.pageTitle }]);
        const out = await withCostLimit((overrideLimit) =>
          api.chat({ requestId: rid, messages: history.current, useTools: tools, tier, pageId: includePage && pageContext ? pageContext.id : null, overrideLimit }),
        );
        warnCost(out.cost_warning);
        const c = out.completion;
        requestId.current = null;
        update(aid, {
          text: c.content,
          streaming: false,
          cancelled: c.finish_reason === "cancelled",
          // All of them, in order: `[n]` in the answer is `sources[n - 1]`.
          sources: out.context,
          meta: {
            // With several providers: `model · Provider`.
            model: modelLabel(s().settings?.settings.providers ?? [], out.route.provider, out.route.model),
            tier: out.route.tier,
            ttft: c.usage.ttft_ms,
            tps: c.usage.tokens_per_second,
            tokens: c.usage.prompt_tokens + c.usage.completion_tokens,
            cost: c.usage.cost_usd,
            exact: c.exact_usage,
            reasons: out.route.reasons,
          },
        });
        s().set({ meter: out.meter });
        history.current.push({ role: "assistant", content: c.content || null, tool_calls: c.tool_calls.length ? c.tool_calls : undefined });
        if (!c.tool_calls.length || c.finish_reason === "cancelled") break;
        if (!c.content) setTurns((ts) => ts.filter((t) => t.id !== aid));
        history.current.push(...(await runTools(c.tool_calls)));
      }
    } catch (e) {
      requestId.current = null;
      setTurns((ts) => {
        const last = ts[ts.length - 1];
        if (last?.kind === "assistant" && last.streaming) return [...ts.slice(0, -1), { ...last, streaming: false, error: errorText(e) }];
        return [...ts, { id: uid(), kind: "assistant", text: "", streaming: false, error: errorText(e) }];
      });
      history.current.length = turnStart;
    } finally {
      setBusy(false);
      textarea.current?.focus();
    }
  }

  const stop = () => requestId.current && api.cancelChat(requestId.current);
  // Right-click in the chat: the selection, the message under the pointer, the chat.
  const chatMenu = (target: HTMLElement): MenuEntry[] => {
    const out: MenuEntry[] = [];
    const selected = window.getSelection()?.toString().trim() ?? "";
    const copy = (text: string, what: string) =>
      navigator.clipboard.writeText(text).then(
        () => s().toast({ tone: "success", title: `${what} kopiert` }),
        (err) => s().error("Kopieren nicht möglich", err),
      );
    if (selected) {
      out.push(
        { label: "Auswahl kopieren", icon: Copy, onSelect: () => copy(selected, "Auswahl") },
        {
          label: "Auswahl zitieren",
          icon: Quote,
          onSelect: () => {
            setInput((v) => `${selected.split("\n").map((l) => `> ${l}`).join("\n")}\n\n${v}`);
            textarea.current?.focus();
          },
        },
        "separator",
      );
    }
    const id = target.closest<HTMLElement>("[data-turn]")?.dataset.turn;
    const turn = turns.find((t) => t.id === id);
    const idx = turns.findIndex((t) => t.id === id);
    if (turn?.kind === "assistant" && turn.text && !turn.streaming) {
      const plain = target.closest<HTMLElement>("[data-turn]")?.querySelector<HTMLElement>(".prose-chat")?.innerText ?? turn.text;
      const lastUser = [...turns.slice(0, idx)].reverse().find((t) => t.kind === "user");
      out.push(
        { label: "Antwort kopieren (Markdown)", icon: Copy, onSelect: () => copy(turn.text, "Antwort") },
        { label: "Als reinen Text kopieren", icon: ClipboardType, onSelect: () => copy(plain, "Text") },
        ...(pageContext
          ? [
              {
                label: `An „${pageContext.title}“ anhängen`,
                icon: FileInput,
                onSelect: async () => {
                  try {
                    await flushAllEditors();
                    const doc = await api.page(pageContext.id);
                    await api.savePage(pageContext.id, `${doc.content.trimEnd()}\n\n${turn.text.trim()}\n`);
                    reloadEditors([pageContext.id]);
                    s().toast({ tone: "success", title: `An „${pageContext.title}“ angehängt` });
                  } catch (err) {
                    s().error("Anhängen nicht möglich", err);
                  }
                },
              } as MenuEntry,
            ]
          : []),
        {
          label: "Als neue Seite speichern",
          icon: FilePlus2,
          onSelect: async () => {
            const title = turn.pageTitle ?? (turn.text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 60) || "Antwort");
            try {
              const p = await api.createPage(title, null, "sparkles", turn.text);
              await s().refreshTree();
              s().openPage(p.id, { newTab: true });
            } catch (err) {
              s().error("Seite nicht angelegt", err);
            }
          },
        },
        "separator",
        { label: "Neu generieren", icon: RefreshCw, disabled: busy || !lastUser || idx !== turns.length - 1, onSelect: () => lastUser && send((lastUser as { text: string }).text) },
        { label: "Nachfragen", icon: MessageSquarePlus, disabled: busy, submenu: FOLLOW_UPS.map((f) => ({ label: f, onSelect: () => send(`${f}, bitte.`) })) },
        "separator",
      );
    } else if (turn?.kind === "user") {
      out.push(
        { label: "Kopieren", icon: Copy, onSelect: () => copy(turn.text, "Nachricht") },
        {
          label: "Bearbeiten",
          icon: PencilLine,
          onSelect: () => {
            setInput(turn.text);
            textarea.current?.focus();
          },
        },
        { label: "Erneut senden", icon: RefreshCw, disabled: busy, onSelect: () => send(turn.text) },
        "separator",
      );
    }
    if (turns.length) out.push({ label: "Neuer Chat", icon: Plus, onSelect: () => newChat() });
    while (out[out.length - 1] === "separator") out.pop();
    return out;
  };

  const newChat = () => {
    if (busy) stop();
    history.current = [];
    setTurns([]);
  };

  const router = settings?.settings.router;
  const providers = settings?.settings.providers ?? [];
  // The tier's model, with its provider when there are several.
  const tierModel = (provider: string | undefined, model: string | undefined) => (model ? modelLabel(providers, provider, model) : undefined);
  const tierOptions: { value: Tier | null; label: string; model?: string }[] = [
    { value: null, label: "Automatisch", model: settings?.settings.auto_route === false ? tierModel(router?.standard_provider, router?.standard_model) : "nach Aufgabe" },
    { value: "local", label: "Lokal", model: tierModel(router?.local_provider, router?.local_model) },
    { value: "standard", label: "Standard", model: tierModel(router?.standard_provider, router?.standard_model) },
    { value: "reasoning", label: "Reasoning", model: tierModel(router?.reasoning_provider, router?.reasoning_model) },
  ];
  const currentTier = tierOptions.find((o) => o.value === tier) ?? tierOptions[0];

  return (
    <div className="assistant">
      <div className="assistant-head">
        <button
          type="button"
          className="model-pill"
          onClick={(e) =>
            openMenuAt(
              e,
              [
                ...tierOptions.map((o) => ({
                  label: `${o.label}${o.model ? ` · ${o.model}` : ""}`,
                  checked: o.value === tier,
                  onSelect: () => {
                    setTier(o.value);
                    o.value ? localStorage.setItem("annalo.tier", o.value) : localStorage.removeItem("annalo.tier");
                  },
                })),
                "separator" as const,
                {
                  label: useTools ? "Werkzeuge deaktivieren" : "Werkzeuge aktivieren",
                  icon: Wrench,
                  onSelect: () => {
                    setUseTools(!useTools);
                    localStorage.setItem("annalo.tools", useTools ? "0" : "1");
                  },
                },
                { label: "KI-Einstellungen", icon: Settings2, onSelect: () => s().openTab({ kind: "settings" }) },
              ],
            )
          }
        >
          <Sparkles size={13} />
          <span>{currentTier.label}</span>
          {currentTier.value && <span className="faint mono">{currentTier.model}</span>}
          <ChevronDown size={13} className="faint" />
        </button>
        <span className="grow" />
        <IconButton icon={Plus} label="Neuer Chat" size="md" onClick={newChat} />
      </div>

      <div
        className="assistant-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        onContextMenu={(e) => {
          const items = chatMenu(e.target as HTMLElement);
          if (!items.length) return;
          e.preventDefault();
          openMenu(e, items);
        }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest<HTMLElement>("a[data-wikilink]");
          if (a) {
            e.preventDefault();
            api.resolvePage(a.dataset.target!, false).then((p) => p && s().openPage(p.id, { newTab: e.ctrlKey || e.metaKey }));
          }
        }}
      >
        {turns.length === 0 ? (
          <div className="assistant-empty">
            <div className="assistant-empty-icon">
              <Sparkles size={20} strokeWidth={1.5} />
            </div>
            <div className="assistant-empty-title">Wie kann ich helfen?</div>
            <p className="faint">Ich kenne deine Notizen, Projekte und Zeitbuchungen und kann für dich buchen.</p>
            {settings && !usableProvider(settings) && (
              <button type="button" className="setup-hint" onClick={() => s().openTab({ kind: "settings" })}>
                <Settings2 size={14} /> KI-Anbieter in den Einstellungen verbinden
              </button>
            )}
            <div className="suggestions">
              {suggestions.map((q) => {
                const Icon = SUGGESTION_ICON[q.kind];
                return (
                  <button key={q.text} type="button" className="ai-suggestion" onClick={() => send(q.text)}>
                    <Icon size={14} strokeWidth={1.75} aria-hidden />
                    <span>{q.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            {turns.map((t) => (
              <TurnView key={t.id} turn={t} />
            ))}
            {!busy && turns[turns.length - 1]?.kind === "assistant" && !(turns[turns.length - 1] as { error?: string }).error && (
              <div className="follow-ups" aria-label="Nachfragen">
                {FOLLOW_UPS.map((f) => (
                  <button key={f} type="button" className="follow-up" onClick={() => send(`${f}, bitte.`)}>
                    {f}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      <div className="composer">
        {pageContext && (
          <div className="composer-context">
            <button type="button" className={`context-chip ${includePage ? "" : "off"}`} onClick={() => setIncludePage(!includePage)} title={includePage ? "Seite wird mitgesendet" : "Seite wird nicht mitgesendet"}>
              <FileText size={12} />
              <span>{pageContext.title}</span>
              {includePage ? <X size={11} /> : <Plus size={11} />}
            </button>
            {preview && (
              <span className="route-hint" title={preview.reasons.join("\n")}>
                <span className={`tier-dot tier-${preview.tier}`} /> {tierLabel[preview.tier]}
              </span>
            )}
          </div>
        )}
        <div className="composer-box">
          <textarea
            ref={textarea}
            rows={1}
            value={input}
            placeholder="Frage stellen oder Aufgabe beschreiben…"
            aria-label="Nachricht an den Assistenten"
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <button type="button" className="send-btn stop" aria-label="Antwort stoppen" onClick={stop}>
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" aria-label="Senden" disabled={!input.trim()} onClick={() => send()}>
              <ArrowUp size={15} strokeWidth={2.25} />
            </button>
          )}
        </div>
        <div className="composer-foot faint">
          <span>Enter senden · Shift Enter neue Zeile</span>
          {!useTools && <span>Werkzeuge aus</span>}
        </div>
      </div>
      {menu}
    </div>
  );
}

function summarizeArgs(c: ToolCall) {
  try {
    const a = JSON.parse(c.function.arguments);
    return a.command ?? a.query ?? a.netzplan ?? (a.from && a.to ? `${a.from} – ${a.to}` : "");
  } catch {
    return "";
  }
}

/** Opens a source: the page scrolled to the cited passage (flashed), or the timesheet. */
export function openSource(src: ContextChunk) {
  const s = useApp.getState();
  if (src.page_id == null) return s.openTab({ kind: "timesheet" });
  revealText(src.page_id, src.text, (id) => s.openPage(id)).catch(() => {});
}

const sourceLabel = (src: ContextChunk) => {
  const title = src.title ?? src.source.replace(/^Seite: /, "");
  return src.heading ? `${title} › ${src.heading}` : title;
};

/** Hover card of a citation chip, in the look of the link preview. */
function CiteCard({ src, n, rect, onEnter, onLeave }: { src: ContextChunk; n: number; rect: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const W = 380;
  const H = 260;
  const below = rect.bottom + 8 + H < window.innerHeight;
  const left = Math.max(8, Math.min(rect.left - 20, window.innerWidth - W - 8));
  const top = below ? rect.bottom + 6 : Math.max(8, rect.top - H - 6);
  const preview = previewMarkdown(src.text, 600);
  return createPortal(
    <div className="link-preview cite-card" role="tooltip" style={{ left, top, width: W, maxHeight: H }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button type="button" className="link-preview-title" onClick={() => openSource(src)}>
        <span className="cite cite-static">{n}</span>
        {src.page_id != null ? <FileText size={14} /> : <Timer size={14} />}
        <span className="cite-card-title">{sourceLabel(src)}</span>
      </button>
      <div className="prose prose-chat link-preview-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text) }} />
      {preview.more && <div className="link-preview-fade" aria-hidden />}
    </div>,
    document.body,
  );
}

/** A failed request: the cause in plain words and what to do; the server's message under „Details“. */
function ErrorNote({ message }: { message: string }) {
  const e = aiErrorSummary(message);
  return (
    <div className="msg-error" role="alert">
      <div className="msg-error-head">
        <AlertTriangle size={14} aria-hidden />
        <span>{e.title}</span>
      </div>
      <div className="msg-error-hint">{e.hint}</div>
      <details className="msg-error-details">
        <summary>Details</summary>
        <div className="mono">{message}</div>
      </details>
      {e.settings && (
        <Button size="sm" icon={Settings2} onClick={() => useApp.getState().openTab({ kind: "settings" })}>
          Verbindung prüfen
        </Button>
      )}
    </div>
  );
}

function TurnView({ turn }: { turn: Turn }) {
  const s = useApp.getState;
  const [copied, setCopied] = useState(false);
  const [cite, setCite] = useState<{ n: number; rect: DOMRect } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const showTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(showTimer.current);
    },
    [],
  );
  if (turn.kind === "user") return <div className="msg-user" data-turn={turn.id}>{turn.text}</div>;

  if (turn.kind === "tool") {
    const Icon = TOOL_META[turn.name]?.icon ?? Wrench;
    if (turn.status === "pending")
      return (
        <div className="tool-approval" role="alertdialog" aria-label="Freigabe erforderlich">
          <div className="tool-approval-head">
            <ShieldAlert size={15} />
            <span>{turn.label}: Freigabe erforderlich</span>
          </div>
          <pre className="tool-approval-cmd">{turn.summary}</pre>
          <div className="tool-approval-actions">
            <Button size="sm" variant="ghost" onClick={() => turn.decide?.(false)}>
              Ablehnen
            </Button>
            <Button size="sm" variant="primary" onClick={() => turn.decide?.(true)}>
              Ausführen
            </Button>
          </div>
        </div>
      );
    return (
      <div className={`tool-step tool-${turn.status}`}>
        <span className="tool-step-icon">{turn.status === "running" ? <Loader2 size={13} className="spin" /> : <Icon size={13} />}</span>
        <span className="tool-step-label">{turn.label}</span>
        {turn.summary && <span className="tool-step-arg mono">{turn.summary}</span>}
        {turn.status === "done" && <Check size={13} className="tool-ok" />}
        {turn.status === "rejected" && <span className="faint">abgelehnt</span>}
        {turn.status === "error" && <span className="tool-err">{turn.output}</span>}
        {turn.status === "done" && turn.output && <pre className="tool-output">{turn.output}</pre>}
      </div>
    );
  }

  const m = turn.meta;
  const sources = turn.sources ?? [];
  const citeOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>(".cite[data-cite]") : null);
  const hideSoon = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCite(null), 220);
  };
  // Cited sources first for the chips below the answer.
  const cited = citedNumbers(turn.text, sources.length);
  const chipSources = dedupeSources([...cited.map((n) => sources[n - 1]), ...sources]);
  const numberOf = (src: ContextChunk) => sources.indexOf(src) + 1;
  return (
    <div className="msg-ai" data-turn={turn.id}>
      {turn.error ? (
        <ErrorNote message={turn.error} />
      ) : turn.streaming && !turn.text ? (
        <div className="thinking">
          <span />
          <span />
          <span />
        </div>
      ) : (
        <div
          className={`prose prose-chat ${turn.streaming ? "streaming" : ""}`}
          dangerouslySetInnerHTML={{ __html: turn.streaming ? renderMarkdown(turn.text) : linkCitations(renderMarkdown(turn.text), sources.length) }}
          onMouseOver={(e) => {
            const el = citeOf(e.target);
            if (!el) return;
            window.clearTimeout(hideTimer.current);
            window.clearTimeout(showTimer.current);
            const n = Number(el.dataset.cite);
            showTimer.current = window.setTimeout(() => el.isConnected && setCite({ n, rect: el.getBoundingClientRect() }), 180);
          }}
          onMouseOut={(e) => citeOf(e.target) && hideSoon()}
          onClick={(e) => {
            const el = citeOf(e.target);
            const src = el && sources[Number(el.dataset.cite) - 1];
            if (!src) return;
            e.preventDefault();
            e.stopPropagation();
            setCite(null);
            openSource(src);
          }}
          onKeyDown={(e) => {
            const el = citeOf(e.target);
            const src = el && sources[Number(el.dataset.cite) - 1];
            if (src && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              openSource(src);
            }
          }}
        />
      )}
      {cite && sources[cite.n - 1] && (
        <CiteCard src={sources[cite.n - 1]} n={cite.n} rect={cite.rect} onEnter={() => window.clearTimeout(hideTimer.current)} onLeave={hideSoon} />
      )}
      {turn.cancelled && <div className="faint small">Abgebrochen</div>}
      {!turn.streaming && !turn.error && turn.sources && turn.sources.length > 0 && (
        <div className="sources">
          <span className="sources-label">Quellen</span>
          {chipSources.slice(0, 3).map((src) => (
            <button
              key={numberOf(src)}
              type="button"
              className="source"
              data-source={numberOf(src)}
              title={`[${numberOf(src)}] ${sourceLabel(src)}\n\n${src.text.slice(0, 300)}`}
              onClick={() => openSource(src)}
            >
              {src.page_id != null ? <FileText size={11} /> : <Timer size={11} />}
              {src.source.replace(/^Seite: /, "")}
            </button>
          ))}
        </div>
      )}
      {m && !turn.streaming && (
        <div className="msg-meta">
          <span className="msg-meta-stats">
            <span title={m.reasons.join("\n")}>
              <span className={`tier-dot tier-${m.tier}`} /> {m.model}
            </span>
            {m.ttft != null && <span title="Zeit bis zum ersten Token">{h1(m.ttft / 1000)} s</span>}
            {m.tps != null && <span title="Tokens pro Sekunde">{Math.round(m.tps)} t/s</span>}
            <span>
              {m.tokens.toLocaleString("de-DE")} Tokens{m.exact ? "" : " (geschätzt)"}
            </span>
            {m.cost > 0 && <span>{usd(m.cost)}</span>}
          </span>
          <span className="msg-actions">
          <IconButton
            icon={copied ? Check : Copy}
            label="Kopieren"
            size="sm"
            tooltipSide="top"
            onClick={() => {
              navigator.clipboard.writeText(turn.text);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          />
          <IconButton
            icon={FilePlus2}
            label={turn.pageTitle ? "In neue Seite einfügen" : "Als Seite speichern"}
            size="sm"
            tooltipSide="top"
            onClick={async () => {
              const title = turn.pageTitle ?? (turn.text.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "").slice(0, 60) || "Antwort");
              try {
                const p = await api.createPage(title, null, turn.pageTitle ? "file-text" : "sparkles", turn.text);
                await s().refreshTree();
                s().openPage(p.id, { newTab: true });
              } catch (e) {
                s().error("Seite nicht angelegt", e);
              }
            }}
          />
          </span>
        </div>
      )}
    </div>
  );
}

function dedupeSources(src: ContextChunk[]) {
  const seen = new Set<string>();
  return src.filter((x) => {
    if (x.page_id == null && x.time_entry_id == null) return false;
    const k = x.page_id != null ? `p${x.page_id}` : `t${x.time_entry_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
