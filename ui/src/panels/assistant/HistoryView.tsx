// The chat history in the assistant panel and in the chat view's list: search, groups by day,
// pin, rename, delete with undo, save as page and duplicate. ↑/↓ choose, Enter opens, F2
// renames, Delete deletes. Both lists show the same saved chats.

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, FilePlus2, Lock, Maximize2, MessageSquare, MoreHorizontal, PanelRight, PencilLine, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { api } from "../../lib/api";
import { groupConversations, historyDate, snippetParts, type HistoryGroupKey } from "../../lib/chathistory";
import { t } from "../../lib/i18n";
import type { ChatConversation } from "../../lib/types";
import { IconButton, useMenu, type MenuEntry } from "../../components/ui";
import { useApp } from "../../store/app";
import { deleteChat, duplicateChat, openChatView, openInPanel, renameChatById, saveChatAsPage, togglePinChat } from "../../store/chat";
import { useSession } from "./session";
import { isComposing } from "../../lib/ime";

const GROUP_LABEL: Record<HistoryGroupKey, () => string> = {
  pinned: () => t("chat.group.pinned"),
  today: () => t("chat.group.today"),
  yesterday: () => t("chat.group.yesterday"),
  week: () => t("chat.group.week"),
  older: () => t("chat.group.older"),
};

const tierOf = (tier: string) => (["local", "standard", "reasoning"].includes(tier) ? tier : "standard");

/**
 * `compact`: the chat view's list column (titles and dates; the search is not focused on
 * opening); `onOpened` runs after a chat was opened from the list.
 */
export function HistoryView({ compact = false, onOpened }: { compact?: boolean; onOpened?: () => void } = {}) {
  const session = useSession();
  const listVersion = session.use((s) => s.listVersion);
  const currentId = session.use((s) => s.conversation?.id ?? null);
  const saving = useApp((s) => (s.settings?.settings.ai.chat_history ?? "all") !== "off");
  const [query, setQuery] = useState("");
  const [list, setList] = useState<ChatConversation[] | null>(null);
  const [active, setActive] = useState(0);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [menu, openMenu, openMenuAt] = useMenu();
  const search = useRef<HTMLInputElement>(null);
  const listEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!compact) search.current?.focus();
  }, [compact]);
  useEffect(() => {
    let alive = true;
    const timer = window.setTimeout(
      () =>
        api
          .chatList(query)
          .then((l) => alive && setList(l))
          .catch((e) => alive && (setList([]), useApp.getState().error(t("chat.listFailed"), e))),
      query ? 120 : 0,
    );
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [query, listVersion]);

  const groups = useMemo(() => groupConversations(list ?? []), [list]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const index = Math.min(active, Math.max(0, flat.length - 1));
  const selected = flat[index];
  useEffect(() => {
    if (!selected) return;
    document.getElementById(`chat-h-${selected.id}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const open = (c: ChatConversation) =>
    session
      .open(c.id)
      .then(() => onOpened?.())
      .catch((e) => useApp.getState().error(t("chat.openFailed"), e));
  const togglePin = async (c: ChatConversation) => {
    try {
      await togglePinChat(c);
    } catch (e) {
      useApp.getState().error(t("chat.updateFailed"), e);
    }
  };
  const rename = async (c: ChatConversation, title: string) => {
    setRenaming(null);
    if (!title.trim() || title.trim() === c.title) return;
    try {
      await renameChatById(c, title);
    } catch (e) {
      useApp.getState().error(t("chat.updateFailed"), e);
    }
  };
  const remove = (c: ChatConversation) => {
    deleteChat(c);
    listEl.current?.focus();
  };
  const items = (c: ChatConversation): MenuEntry[] => [
    { label: t("chat.open"), icon: MessageSquare, onSelect: () => open(c) },
    session.id === "panel"
      ? { label: t("chat.openInView"), icon: Maximize2, onSelect: () => void openChatView({ id: c.id }) }
      : { label: t("chat.openInPanel"), icon: PanelRight, onSelect: () => void openInPanel({ id: c.id }) },
    { label: t("chat.rename"), icon: PencilLine, shortcut: "F2", onSelect: () => setRenaming(c.id) },
    { label: c.pinned ? t("chat.unpin") : t("chat.pin"), icon: c.pinned ? PinOff : Pin, onSelect: () => togglePin(c) },
    { label: t("chat.saveChatAsPage"), icon: FilePlus2, onSelect: () => saveChatAsPage(c) },
    { label: t("chat.duplicate"), icon: Copy, onSelect: () => duplicateChat(c, session) },
    "separator",
    { label: t("chat.delete"), icon: Trash2, shortcut: "Entf", danger: true, onSelect: () => remove(c) },
  ];

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (isComposing(e)) return;
    if (renaming != null) return;
    const inSearch = e.target === search.current;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!flat.length) return;
      const next = e.key === "ArrowDown" ? Math.min(flat.length - 1, index + 1) : Math.max(0, index - 1);
      setActive(next);
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      open(selected);
    } else if (e.key === "F2" && selected) {
      e.preventDefault();
      setRenaming(selected.id);
    } else if (e.key === "Delete" && selected && (!inSearch || !query)) {
      e.preventDefault();
      remove(selected);
    } else if (e.key === "Home" && !inSearch) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && !inSearch) {
      e.preventDefault();
      setActive(flat.length - 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else if (session.id === "panel") session.use.setState({ historyOpen: false });
    }
  };

  return (
    <div className={`chat-history ${compact ? "compact" : ""}`} onKeyDown={onKeyDown}>
      <div className="chat-history-search">
        <Search size={14} aria-hidden />
        <input
          ref={search}
          type="search"
          value={query}
          placeholder={t("chat.searchPlaceholder")}
          aria-label={t("chat.searchHistory")}
          aria-controls="chat-history-list"
          aria-activedescendant={selected ? `chat-h-${selected.id}` : undefined}
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
        />
        {query && <IconButton icon={X} label={t("chat.clearSearch")} size="sm" onClick={() => (setQuery(""), search.current?.focus())} />}
      </div>
      {!saving && <div className="chat-history-note">{t("chat.notSaving")}</div>}
      <div ref={listEl} id="chat-history-list" className="chat-history-list" role="listbox" aria-label={t("chat.history")} tabIndex={0} aria-activedescendant={selected ? `chat-h-${selected.id}` : undefined}>
        {list && !flat.length && (
          <div className="chat-history-empty">
            <MessageSquare size={18} strokeWidth={1.5} aria-hidden />
            <span>{query ? t("chat.noHits", { q: query }) : t("chat.noChats")}</span>
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key} className="chat-history-group" role="group" aria-label={GROUP_LABEL[g.key]()}>
            <div className="chat-history-group-label" aria-hidden>
              {GROUP_LABEL[g.key]()}
            </div>
            {g.items.map((c) => {
              const i = flat.indexOf(c);
              return (
                <div
                  key={c.id}
                  id={`chat-h-${c.id}`}
                  role="option"
                  aria-selected={i === index}
                  aria-current={c.id === currentId || undefined}
                  className={`chat-history-row ${i === index ? "active" : ""} ${c.id === currentId ? "current" : ""}`}
                  onMouseMove={() => i !== index && setActive(i)}
                  onClick={() => renaming !== c.id && open(c)}
                  onContextMenu={(e) => {
                    setActive(i);
                    openMenu(e, items(c));
                  }}
                >
                  <div className="chat-history-main">
                    {renaming === c.id ? (
                      <input
                        className="chat-history-rename"
                        defaultValue={c.title}
                        aria-label={t("chat.rename")}
                        autoFocus
                        onFocus={(e) => e.currentTarget.select()}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (isComposing(e)) return;
                          if (e.key === "Enter") rename(c, e.currentTarget.value);
                          else if (e.key === "Escape") {
                            setRenaming(null);
                            listEl.current?.focus();
                          }
                        }}
                        onBlur={(e) => rename(c, e.currentTarget.value)}
                      />
                    ) : (
                      <span className="chat-history-title">
                        {c.private && <Lock size={12} className="chat-lock" aria-label={t("chat.private")} />}
                        <span className="chat-history-title-text">{c.title || t("chat.untitled")}</span>
                      </span>
                    )}
                    {c.snippet && (
                      <span className="chat-history-snippet">
                        {snippetParts(c.snippet).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                      </span>
                    )}
                    {!compact && (
                    <span className="chat-history-meta">
                      {c.model && (
                        <span className="chat-chip" title={c.provider ? `${c.model} · ${c.provider}` : c.model}>
                          <span className={`tier-dot tier-${tierOf(c.tier)}`} />
                          <span className="chat-chip-text">{c.model}</span>
                        </span>
                      )}
                      <span className="chat-history-date">{historyDate(c.updated_at)}</span>
                    </span>
                    )}
                  </div>
                  <div className="chat-history-actions">
                    {c.pinned && <Pin size={12} className="chat-pin-mark" aria-label={t("chat.pinned")} />}
                    <IconButton
                      icon={c.pinned ? PinOff : Pin}
                      label={c.pinned ? t("chat.unpin") : t("chat.pin")}
                      size="sm"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        togglePin(c);
                      }}
                    />
                    <IconButton aria-haspopup="menu"
                      icon={MoreHorizontal}
                      label={t("chat.more")}
                      size="sm"
                      tabIndex={-1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActive(i);
                        openMenuAt(e, items(c));
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      {!compact && <div className="chat-history-foot faint">{t("chat.historyKeys")}</div>}
      {menu}
    </div>
  );
}
