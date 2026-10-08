// The chat view: a plain chatbot in a tab of the main area, beside the assistant in the side
// panel. The chat list on the left (the same saved chats as the panel's history), the
// conversation in a reading column and a large composer below. „Mit meinen Notizen“ in the
// composer lets the answers use the notes (search, sources, tools) like the panel's assistant.
// In a narrow pane the list becomes a drawer.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Lightbulb, Lock, Mail, MessageSquareText, PanelLeft, PanelRight, PencilLine, Search, SquarePen, Wand2 } from "lucide-react";
import { t, useT, type TKey } from "../lib/i18n";
import { usableProvider } from "../lib/providers";
import { AiSetupNote } from "../components/AiNotes";
import { IconButton } from "../components/ui";
import { NavButtons } from "../components/ViewHeader";
import { useApp, type Tab } from "../store/app";
import { ensureChatListeners, openInPanel, viewChat } from "../store/chat";
import { ChatSessionContext } from "../panels/assistant/session";
import { HistoryView } from "../panels/assistant/HistoryView";
import { ChatBody, Composer } from "../panels/AssistantPanel";

/** Below this width the chat list is a drawer over the conversation. */
export const NARROW_CHAT = 760;
const LAST_KEY = "arcalo.chatView.last";
const LIST_KEY = "arcalo.chatView.list";

const readPref = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const writePref = (key: string, value: string | null) => {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
};

/** Starting points of an empty chat: plain ones, and one about the notes when they are on. */
export function suggestionKeys(notes: boolean): { label: TKey; text: TKey; icon: typeof Lightbulb }[] {
  return [
    { label: "chatv.sug.explain", text: "chatv.sug.explainText", icon: MessageSquareText },
    { label: "chatv.sug.improve", text: "chatv.sug.improveText", icon: Wand2 },
    { label: "chatv.sug.mail", text: "chatv.sug.mailText", icon: Mail },
    notes ? { label: "chatv.sug.notes", text: "chatv.sug.notesText", icon: Search } : { label: "chatv.sug.ideas", text: "chatv.sug.ideasText", icon: Lightbulb },
  ];
}

function Greeting() {
  const settings = useApp((st) => st.settings);
  const notes = viewChat.use((s) => s.notes);
  return (
    <div className="chat-greeting">
      <h1 className="chat-greeting-title">{t("chatv.greeting")}</h1>
      <p className="chat-greeting-text">{t(notes ? "chatv.greetingNotes" : "chatv.greetingPlain")}</p>
      {settings && !usableProvider(settings) && <AiSetupNote text={t("ai.setup.chat")} />}
      <div className="chat-chips" aria-label={t("chat.quickStart")}>
        {suggestionKeys(notes).map((s) => (
          <button key={s.label} type="button" className="chat-chip-btn" onClick={() => viewChat.use.setState((st) => ({ input: t(s.text), focusTick: st.focusTick + 1 }))}>
            <s.icon size={14} strokeWidth={1.75} aria-hidden />
            <span>{t(s.label)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The chat's title (rename by click or F2) with the lock of a private chat. */
function ChatTitle() {
  const conversation = viewChat.use((s) => s.conversation);
  const priv = viewChat.use((s) => s.private);
  const hasTurns = viewChat.use((s) => s.turns.length > 0);
  const [editing, setEditing] = useState(false);
  const title = conversation?.title || (hasTurns ? t("chat.unsavedTitle") : t("chat.newChat"));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2" || !conversation) return;
      if (!(e.target instanceof Node) || !document.querySelector(".chat-view-main")?.contains(e.target)) return;
      e.preventDefault();
      setEditing(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [conversation]);
  const done = (value: string) => {
    setEditing(false);
    void viewChat.rename(value);
  };
  return editing && conversation ? (
    <input
      className="assistant-title-input chat-view-title-input"
      defaultValue={conversation.title}
      aria-label={t("chat.renameChat")}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          done(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          setEditing(false);
        }
      }}
      onBlur={(e) => done(e.currentTarget.value)}
    />
  ) : (
    <span className="chat-view-title-wrap">
      <button
        type="button"
        className="assistant-title chat-view-title"
        disabled={!conversation}
        title={conversation ? t("chat.renameHint") : undefined}
        aria-label={conversation ? `${title} – ${t("chat.renameChat")}` : undefined}
        onClick={() => setEditing(true)}
      >
        {priv && <Lock size={12} className="chat-lock" aria-label={t("chat.privateChat")} />}
        <span className="assistant-title-text">{title}</span>
        {conversation && <PencilLine size={12} className="chat-view-title-pen" aria-hidden />}
      </button>
      {priv && (
        <span className="chat-private-badge" title={t("chat.privateHint")}>
          {t("chat.private")}
        </span>
      )}
    </span>
  );
}

export function ChatView({ tab }: { tab: Tab }) {
  useT();
  const root = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1200);
  const narrow = width < NARROW_CHAT;
  const [listWide, setListWide] = useState(() => readPref(LIST_KEY) !== "0");
  const [drawer, setDrawer] = useState(false);
  const listOpen = narrow ? drawer : listWide;
  const conversationId = viewChat.use((s) => s.conversation?.id ?? null);
  const hasTurns = viewChat.use((s) => s.turns.length > 0);
  const active = useApp((s) => s.tabs.some((x) => x.id === tab.id) && s.activeTabId === tab.id);

  useEffect(() => ensureChatListeners(), []);
  // Opened (the view loads on first use): straight into the composer.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      const box = root.current?.querySelector<HTMLTextAreaElement>(".composer textarea");
      const focus = document.activeElement;
      if (box && (!focus || focus === document.body || !root.current?.contains(focus))) box.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The chat shown last comes back after a restart.
  useEffect(() => {
    const last = Number(readPref(LAST_KEY));
    const st = viewChat.use.getState();
    if (last > 0 && !st.turns.length && !st.conversation) viewChat.open(last).catch(() => writePref(LAST_KEY, null));
  }, []);
  useEffect(() => {
    if (conversationId != null) writePref(LAST_KEY, String(conversationId));
    else if (hasTurns) writePref(LAST_KEY, null);
  }, [conversationId, hasTurns]);

  const toggleList = () => {
    if (narrow) setDrawer(!drawer);
    else {
      setListWide(!listWide);
      writePref(LIST_KEY, listWide ? "0" : "1");
    }
  };
  const newChat = () => {
    viewChat.newChat();
    if (narrow) setDrawer(false);
  };

  return (
    <ChatSessionContext.Provider value={viewChat}>
      <div className="vh chat-view-head">
        <NavButtons tab={tab} />
        <IconButton icon={PanelLeft} label={t(listOpen ? "chatv.hideList" : "chatv.showList")} active={listOpen} aria-pressed={listOpen} aria-controls="chat-view-list" onClick={toggleList} />
        <div className="vh-title chat-view-titlebar">
          <ChatTitle />
        </div>
        <div className="vh-actions">
          {hasTurns && <IconButton icon={PanelRight} label={t("chat.openInPanel")} onClick={() => void openInPanel({ from: viewChat })} />}
          <IconButton icon={SquarePen} label={t("chat.newChat")} onClick={newChat} />
        </div>
      </div>
      <div ref={root} className={`chat-view ${narrow ? "narrow" : ""} ${listOpen ? "list-open" : ""}`} onKeyDown={(e) => narrow && drawer && e.key === "Escape" && (e.preventDefault(), setDrawer(false))}>
        {listOpen && (
          <aside id="chat-view-list" className="chat-view-list" aria-label={t("chat.history")}>
            <button type="button" className="chat-view-new" onClick={newChat}>
              <SquarePen size={15} aria-hidden />
              <span>{t("chat.newChat")}</span>
            </button>
            <HistoryView compact onOpened={() => narrow && setDrawer(false)} />
          </aside>
        )}
        {narrow && drawer && <div className="chat-view-scrim" aria-hidden onClick={() => setDrawer(false)} />}
        <section className="chat-view-main" aria-label={t("tabs.chat")}>
          <ChatBody empty={<Greeting />} />
          <div className="chat-view-composer">
            <Composer shown={active} placeholder={t("chatv.placeholder")} />
          </div>
        </section>
      </div>
    </ChatSessionContext.Provider>
  );
}
