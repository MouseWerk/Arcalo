// The AI assistant: streaming chat over the configured AI providers with workspace context,
// sources, cost/speed metrics, approval-gated tools and the chat history. The conversation
// itself lives in `store/chat.ts`, so closing the panel loses nothing.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronDown, ClipboardType, Copy, FilePlus2, FileInput, FileText, History, Languages, Lightbulb, ListChecks, Lock, MessageSquarePlus, PencilLine, Plus, Quote, RefreshCw, Settings2, Sparkles, Square, Timer, WifiOff, Wrench, X } from "lucide-react";
import { api } from "../lib/api";
import { flushAllEditors, reloadEditors } from "../editor/NoteEditor";
import { t, useT, type TKey } from "../lib/i18n";
import { int } from "../lib/format";
import { modelLabel, usableProvider } from "../lib/providers";
import type { RouteDecision, Tier } from "../lib/types";
import type { Turn } from "../lib/chathistory";
import { IconButton, useMenu, type MenuEntry } from "../components/ui";
import { useApp } from "../store/app";
import { useTimeTracking } from "../lib/timetracking";
import { currentPage, ensureChatListeners, MAX_INPUT, newChat, regenerate, renameChat, sendChat, setTier, setUseTools, stopChat, useChat } from "../store/chat";
import { useSuggestions } from "./useSuggestions";
import { HistoryView } from "./assistant/HistoryView";
import { TurnView } from "./assistant/TurnView";
import { SUGGESTION_ICONS } from "./assistant/icons";
import { answerTitle, copyText } from "./assistant/actions";
import { scrollMotion } from "../lib/motion";

export { openSource } from "./assistant/TurnView";

/** Quick follow-ups under the last answer. */
const FOLLOW_UP_KEYS: TKey[] = ["assist.follow.shorter", "assist.follow.bullets", "assist.follow.table", "assist.follow.language"];
/** Follow-up questions in the display language (the answer follows the question's language). */
const followUps = () => FOLLOW_UP_KEYS.map((k) => t(k));
const tierKey: Record<Tier, "chat.tier.local" | "chat.tier.standard" | "chat.tier.reasoning"> = { local: "chat.tier.local", standard: "chat.tier.standard", reasoning: "chat.tier.reasoning" };

export function AssistantPanel() {
  useT();
  const historyOpen = useChat((s) => s.historyOpen);
  useEffect(() => ensureChatListeners(), []);

  // A palette question may arrive before this panel mounts; take it once idle.
  const pendingAsk = useApp((st) => st.pendingAsk);
  const busy = useChat((s) => s.busy);
  useEffect(() => {
    const q = useApp.getState().pendingAsk;
    if (!q || busy) return;
    useApp.getState().set({ pendingAsk: null });
    useChat.setState({ historyOpen: false });
    if (typeof q === "string") sendChat(q);
    else sendChat(q.text, { pageTitle: q.pageTitle, tools: q.tools, display: q.display });
  }, [pendingAsk, busy]);

  return (
    <div className="assistant">
      <ChatHeader />
      {historyOpen ? <HistoryView /> : <ChatBody />}
      {!historyOpen && <Composer />}
    </div>
  );
}

/** Title of the chat (rename by click or F2), the lock of a private chat, history and „Neuer Chat“. */
function ChatHeader() {
  const conversation = useChat((s) => s.conversation);
  const priv = useChat((s) => s.private);
  const historyOpen = useChat((s) => s.historyOpen);
  const hasTurns = useChat((s) => s.turns.length > 0);
  const [editing, setEditing] = useState(false);
  const title = conversation?.title || (hasTurns ? t("chat.unsavedTitle") : t("chat.newChat"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2" || historyOpen || !conversation) return;
      if (!(e.target instanceof Node) || !document.querySelector(".assistant")?.contains(e.target)) return;
      e.preventDefault();
      setEditing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [historyOpen, conversation]);
  return (
    <div className="assistant-head">
      <IconButton
        icon={History}
        label={historyOpen ? t("chat.backToChat") : t("chat.history")}
        size="md"
        active={historyOpen}
        aria-pressed={historyOpen}
        onClick={() => useChat.setState({ historyOpen: !historyOpen })}
      />
      {historyOpen ? (
        <span className="assistant-title">
          <span className="assistant-title-text">{t("chat.history")}</span>
        </span>
      ) : editing && conversation ? (
        <input
          className="assistant-title-input"
          defaultValue={conversation.title}
          aria-label={t("chat.renameChat")}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              setEditing(false);
              renameChat(e.currentTarget.value);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            setEditing(false);
            renameChat(e.currentTarget.value);
          }}
        />
      ) : (
        <button
          type="button"
          className="assistant-title"
          disabled={!conversation}
          title={conversation ? t("chat.renameHint") : undefined}
          aria-label={conversation ? `${title} – ${t("chat.renameChat")}` : undefined}
          onClick={() => setEditing(true)}
        >
          {priv && <Lock size={12} className="chat-lock" aria-label={t("chat.privateChat")} />}
          <span className="assistant-title-text">{title}</span>
        </button>
      )}
      {!historyOpen && priv && <span className="chat-private-badge" title={t("chat.privateHint")}>{t("chat.private")}</span>}
      <IconButton icon={Plus} label={t("assist.newChat")} size="md" onClick={() => newChat()} />
    </div>
  );
}

/** The messages, or the empty state with suggestions; follows the answer while you are at the end. */
function ChatBody() {
  const turns = useChat((s) => s.turns);
  const busy = useChat((s) => s.busy);
  const notice = useChat((s) => s.notice);
  const followTick = useChat((s) => s.followTick);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [away, setAway] = useState(false);
  const [menu, openMenu] = useMenu();
  const s = useApp.getState;

  const toEnd = (smooth = false) => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    setAway(false);
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? scrollMotion() : "auto" });
  };
  // A new question or an opened chat scrolls to the end; a growing answer only while at the end.
  useLayoutEffect(() => toEnd(), [followTick]);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [turns]);
  // Images, opened tool output and a wider panel change the height without new turns.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    return () => ro.disconnect();
  }, [turns.length === 0]);

  const lastUserIdx = turns.map((x) => x.kind).lastIndexOf("user");
  const last = turns[turns.length - 1];

  return (
    <div className="assistant-body">
      <div
        className="assistant-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          stick.current = atEnd;
          if (away === atEnd) setAway(!atEnd);
        }}
        onContextMenu={(e) => {
          const items = chatMenu(e.target as HTMLElement, turns, busy);
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
        <div className="assistant-content" ref={content}>
          {turns.length === 0 ? (
            <EmptyChat />
          ) : (
            <>
              {notice && (
                <div className="chat-notice" role="note">
                  <RefreshCw size={13} aria-hidden />
                  <span>{notice}</span>
                  <IconButton icon={X} label={t("chat.dismiss")} size="sm" onClick={() => useChat.setState({ notice: null })} />
                </div>
              )}
              <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions" aria-label={t("chat.messages")}>
                {turns.map((x, i) => (
                  <TurnView key={x.id} turn={x} last={i === turns.length - 1} busy={i >= lastUserIdx ? busy : false} editable={i === lastUserIdx && !busy} />
                ))}
              </div>
              {!busy && last?.kind === "assistant" && !last.error && (
                <div className="follow-ups" aria-label={t("chat.followUps")}>
                  {followUps().map((f) => (
                    <button key={f} type="button" className="follow-up" onClick={() => sendChat(t("assist.follow.ask", { f }))}>
                      {f}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {away && turns.length > 0 && (
        <button type="button" className="scroll-end" onClick={() => toEnd(true)} aria-label={t("chat.toEnd")}>
          <ArrowDown size={13} aria-hidden />
          <span>{t("chat.toEnd")}</span>
        </button>
      )}
      {menu}
    </div>
  );
}

/** Right-click in the chat: the selection, the message under the pointer, the chat. */
function chatMenu(target: HTMLElement, turns: Turn[], busy: boolean): MenuEntry[] {
  const s = useApp.getState;
  const out: MenuEntry[] = [];
  const selected = window.getSelection()?.toString().trim() ?? "";
  const copy = (text: string, what: string) => copyText(text, () => s().toast({ tone: "success", title: t("chat.copiedWhat", { what }) }));
  const setInput = (f: (v: string) => string) => {
    useChat.setState((st) => ({ input: f(st.input), focusTick: st.focusTick + 1 }));
  };
  if (selected) {
    out.push(
      { label: t("assist.copySelection"), icon: Copy, onSelect: () => copy(selected, t("chat.what.selection")) },
      { label: t("assist.quoteSelection"), icon: Quote, onSelect: () => setInput((v) => `${selected.split("\n").map((l) => `> ${l}`).join("\n")}\n\n${v}`) },
      "separator",
    );
  }
  const row = target.closest<HTMLElement>("[data-turn]");
  const id = row?.dataset.turn;
  const idx = turns.findIndex((x) => x.id === id);
  const turn = turns[idx];
  const page = currentPage();
  if (turn?.kind === "assistant" && turn.text && !turn.streaming) {
    out.push(
      { label: t("assist.copyAnswer"), icon: Copy, onSelect: () => copy(turn.text, t("chat.what.answer")) },
      { label: t("assist.copyPlain"), icon: ClipboardType, onSelect: () => copy(plainText(row) ?? turn.text, t("chat.what.text")) },
      ...(page
        ? [
            {
              label: t("assist.appendTo", { title: page.title }),
              icon: FileInput,
              onSelect: async () => {
                try {
                  await flushAllEditors();
                  const doc = await api.page(page.id);
                  await api.savePage(page.id, `${doc.content.trimEnd()}\n\n${turn.text.trim()}\n`);
                  reloadEditors([page.id]);
                  s().toast({ tone: "success", title: t("chat.appended", { title: page.title }) });
                } catch (err) {
                  s().error(t("chat.insertFailed"), err);
                }
              },
            } as MenuEntry,
          ]
        : []),
      {
        label: t("assist.saveAsPage"),
        icon: FilePlus2,
        onSelect: async () => {
          try {
            const p = await api.createPage(turn.pageTitle ?? answerTitle(turn.text), null, "sparkles", turn.text);
            await s().refreshTree();
            s().openPage(p.id, { newTab: true });
          } catch (err) {
            s().error(t("chat.pageFailed"), err);
          }
        },
      },
      "separator",
      { label: t("assist.regenerate"), icon: RefreshCw, disabled: busy || idx !== turns.length - 1, onSelect: () => regenerate(turn.id) },
      { label: t("assist.followUp"), icon: MessageSquarePlus, disabled: busy, submenu: followUps().map((f) => ({ label: f, onSelect: () => sendChat(t("assist.follow.ask", { f })) })) },
      "separator",
    );
  } else if (turn?.kind === "user") {
    out.push(
      { label: t("common.copy"), icon: Copy, onSelect: () => copy(turn.text, t("chat.what.message")) },
      { label: t("links.editShort"), icon: PencilLine, onSelect: () => setInput(() => turn.text) },
      { label: t("assist.resend"), icon: RefreshCw, disabled: busy, onSelect: () => sendChat(turn.prompt, { ...turn.opts }) },
      "separator",
    );
  }
  if (turns.length) out.push({ label: t("assist.newChat"), icon: Plus, onSelect: () => newChat() });
  while (out[out.length - 1] === "separator") out.pop();
  return out;
}

/** The answer as the user reads it, without the code boxes' labels and buttons. */
function plainText(row: HTMLElement | null): string | null {
  const prose = row?.querySelector<HTMLElement>(".prose-chat");
  if (!prose) return null;
  const heads = [...prose.querySelectorAll<HTMLElement>(".code-head")];
  for (const h of heads) h.hidden = true;
  const text = prose.innerText;
  for (const h of heads) h.hidden = false;
  return text.trim();
}

/** An empty chat: what the assistant can do, suggestions from the open page and the data, quick starts. */
function EmptyChat() {
  const settings = useApp((st) => st.settings);
  const activeDoc = useApp((st) => st.activeDoc);
  const activeTab = useApp((st) => st.tabs.find((x) => x.id === st.activeTabId));
  const page = activeTab?.kind === "page" && activeDoc && activeDoc.id === activeTab.pageId ? activeDoc : null;
  // Suggestions are shown in an empty chat of the visible assistant tab only.
  const shown = useApp((st) => st.panelOpen && st.panelTab === "assistant");
  const suggestions = useSuggestions(page, shown);
  const s = useApp.getState;
  // Time tracking off: the assistant does not offer to book time.
  const timeOn = useTimeTracking();
  const quick: { label: string; icon: typeof Timer; text: string }[] = [
    ...(timeOn ? [{ label: t("chat.quick.book"), icon: Timer, text: t("chat.quick.bookText") }] : []),
    { label: t("chat.quick.tasks"), icon: ListChecks, text: t("chat.quick.tasksText") },
    { label: t("chat.quick.ideas"), icon: Lightbulb, text: t("chat.quick.ideasText") },
    { label: t("chat.quick.translate"), icon: Languages, text: t("chat.quick.translateText") },
  ];
  return (
    <div className="assistant-empty">
      <div className="assistant-empty-icon">
        <Sparkles size={20} strokeWidth={1.5} />
      </div>
      <div className="assistant-empty-title">{t("chat.emptyTitle")}</div>
      <p className="faint">{t(timeOn ? "chat.emptyText" : "tt.chatEmptyText")}</p>
      {settings && !usableProvider(settings) && (
        <button type="button" className="setup-hint" onClick={() => s().openTab({ kind: "settings" })}>
          <Settings2 size={14} /> {t("chat.connectProvider")}
        </button>
      )}
      <div className="suggestions">
        {suggestions.map((q) => {
          const Icon = SUGGESTION_ICONS[q.kind];
          return (
            <button key={q.text} type="button" className="ai-suggestion" onClick={() => sendChat(q.text)}>
              <Icon size={14} strokeWidth={1.75} aria-hidden />
              <span>{q.text}</span>
            </button>
          );
        })}
      </div>
      <div className="quick-prompts" aria-label={t("chat.quickStart")}>
        {quick.map((q) => (
          <button
            key={q.label}
            type="button"
            className="quick-prompt"
            onClick={() => useChat.setState((st) => ({ input: q.text, focusTick: st.focusTick + 1 }))}
          >
            <q.icon size={12} strokeWidth={1.75} aria-hidden />
            <span>{q.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The question box: grows with the text, Enter sends, Shift+Enter breaks the line; page and model chips. */
function Composer() {
  const input = useChat((s) => s.input);
  const busy = useChat((s) => s.busy);
  const tier = useChat((s) => s.tier);
  const useTools = useChat((s) => s.useTools);
  const includePage = useChat((s) => s.includePage);
  const focusTick = useChat((s) => s.focusTick);
  const convId = useChat((s) => s.conversation?.id ?? null);
  const priv = useChat((s) => s.private);
  const settings = useApp((s) => s.settings);
  const activeDoc = useApp((st) => st.activeDoc);
  const activeTab = useApp((st) => st.tabs.find((x) => x.id === st.activeTabId));
  const page = activeTab?.kind === "page" && activeDoc && activeDoc.id === activeTab.pageId ? activeDoc : null;
  const shown = useApp((st) => st.panelOpen && st.panelTab === "assistant");
  const [preview, setPreview] = useState<RouteDecision | null>(null);
  const [offline, setOffline] = useState(() => typeof navigator !== "undefined" && navigator.onLine === false);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;

  useEffect(() => {
    const update = () => setOffline(navigator.onLine === false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  // As tall as the text up to a limit, then it scrolls (also for text put in by „Bearbeiten“).
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);
  // Back into the box after an answer or a new chat, unless the user went on elsewhere.
  useEffect(() => {
    const el = textarea.current;
    if (!focusTick || !el || !shown) return;
    const active = document.activeElement;
    if (!active || active === document.body || el.closest(".assistant")?.contains(active)) el.focus();
  }, [focusTick, shown]);
  useEffect(() => {
    if (!input.trim()) return setPreview(null);
    const timer = setTimeout(() => api.routePreview(input, useTools, tier, convId).then(setPreview).catch(() => {}), 250);
    return () => clearTimeout(timer);
  }, [input, tier, useTools, convId]);

  const router = settings?.settings.router;
  const providers = settings?.settings.providers ?? [];
  // The tier's model, with its provider when there are several.
  const tierModel = (provider: string | undefined, model: string | undefined) => (model ? modelLabel(providers, provider, model) : undefined);
  const tierOptions: { value: Tier | null; label: string; model?: string }[] = [
    { value: null, label: t("chat.tier.auto"), model: settings?.settings.auto_route === false ? tierModel(router?.standard_provider, router?.standard_model) : t("chat.tier.byTask") },
    { value: "local", label: t("chat.tier.local"), model: tierModel(router?.local_provider, router?.local_model) },
    { value: "standard", label: t("chat.tier.standard"), model: tierModel(router?.standard_provider, router?.standard_model) },
    { value: "reasoning", label: t("chat.tier.reasoning"), model: tierModel(router?.reasoning_provider, router?.reasoning_model) },
  ];
  const currentTier = tierOptions.find((o) => o.value === tier) ?? tierOptions[0];
  const tooLong = input.length > MAX_INPUT;
  const nearLimit = input.length > MAX_INPUT * 0.8;
  const send = () => {
    if (busy || tooLong || !input.trim()) return;
    const text = input;
    useChat.setState({ input: "" });
    sendChat(text);
  };

  return (
    <div className="composer">
      {offline && (
        <div className="composer-note" role="status">
          <WifiOff size={13} aria-hidden />
          <span>{t("chat.offline")}</span>
        </div>
      )}
      <div className={`composer-box ${tooLong ? "invalid" : ""}`}>
        <textarea
          ref={textarea}
          rows={1}
          value={input}
          placeholder={t("chat.placeholder")}
          aria-label={t("assist.inputLabel")}
          aria-invalid={tooLong || undefined}
          onChange={(e) => useChat.setState({ input: e.target.value })}
          onKeyDown={(e) => {
            // Enter during IME composition picks the candidate, it does not send.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
              e.preventDefault();
              send();
            } else if (e.key === "Escape" && busy) {
              e.preventDefault();
              stopChat();
            }
          }}
        />
        <div className="composer-bar">
          {page && (
            <button
              type="button"
              className={`context-chip ${includePage ? "" : "off"}`}
              aria-pressed={includePage}
              onClick={() => useChat.setState({ includePage: !includePage })}
              title={includePage ? t("chat.pageSent") : t("chat.pageNotSent")}
            >
              <FileText size={12} aria-hidden />
              <span>{page.title}</span>
              {includePage ? <X size={11} aria-hidden /> : <Plus size={11} aria-hidden />}
            </button>
          )}
          <button
            type="button"
            className="model-pill"
            aria-label={`${t("chat.modelChoice")}: ${currentTier.label}`}
            onClick={(e) =>
              openMenuAt(e, [
                ...tierOptions.map((o) => ({
                  label: `${o.label}${o.model ? ` · ${o.model}` : ""}`,
                  checked: o.value === tier,
                  onSelect: () => setTier(o.value),
                })),
                "separator" as const,
                { label: useTools ? t("assist.toolsOff") : t("assist.toolsOn"), icon: Wrench, onSelect: () => setUseTools(!useTools) },
                { label: t("chat.aiSettings"), icon: Settings2, onSelect: () => s().openTab({ kind: "settings" }) },
              ])
            }
          >
            {priv ? <Lock size={12} aria-hidden /> : <Sparkles size={12} aria-hidden />}
            <span className="model-pill-label">{priv ? t("chat.tier.local") : currentTier.label}</span>
            {!priv && currentTier.value && <span className="faint mono model-pill-model">{currentTier.model}</span>}
            {!priv && !currentTier.value && preview && (
              <span className="route-hint" title={preview.reasons.join("\n")}>
                <span className={`tier-dot tier-${preview.tier}`} /> {t(tierKey[preview.tier])}
              </span>
            )}
            <ChevronDown size={12} className="faint" aria-hidden />
          </button>
          <span className="grow" />
          {nearLimit && (
            <span className={`composer-count ${tooLong ? "over" : ""}`} aria-live="polite">
              {int(input.length)} / {int(MAX_INPUT)}
            </span>
          )}
          {busy ? (
            <button type="button" className="send-btn stop" aria-label={t("assist.stop")} title={t("chat.stopHint")} onClick={stopChat}>
              <Square size={11} fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="send-btn" aria-label={t("assist.send")} disabled={!input.trim() || tooLong} onClick={send}>
              <ArrowUp size={15} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </div>
      <div className="composer-foot faint">
        <span>{tooLong ? t("chat.tooLong", { max: int(MAX_INPUT) }) : t("chat.keysHint")}</span>
        {!useTools && <span>{t("chat.toolsOff")}</span>}
      </div>
      {menu}
    </div>
  );
}
