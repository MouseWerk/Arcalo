// „Intelligente Ordner“ above the page tree: virtual, read-only lists computed by the core in
// SQL (recently edited, favorites, without folder, orphans, by tag, by Jira project, by
// Netzplan). Each expands to its pages (grouped ones to their groups first); the section can be
// collapsed and hidden (tree options).

import { useEffect, useState } from "react";
import { ChevronRight, Clock, Hash, Inbox, Network, Star, Ticket, Unlink } from "lucide-react";
import { useApp } from "../store/app";
import { useT, type TKey } from "../lib/i18n";
import { PageIcon } from "./icons";
import { filingApi, type SmartCounts, type SmartGroup, type SmartKind, type SmartPage } from "../lib/filing";

const OPEN_KEY = "arcalo.smart.open";
const COLLAPSED_KEY = "arcalo.smart.collapsed";
export const SMART_HIDDEN_KEY = "arcalo.smart.hidden";
export const SMART_EVENT = "arcalo:smart-folders";

const KINDS: { kind: SmartKind; icon: typeof Clock; grouped?: boolean }[] = [
  { kind: "recent", icon: Clock },
  { kind: "favorites", icon: Star },
  { kind: "unfiled", icon: Inbox },
  { kind: "orphans", icon: Unlink },
  { kind: "tags", icon: Hash, grouped: true },
  { kind: "jira", icon: Ticket, grouped: true },
  { kind: "netzplan", icon: Network, grouped: true },
];

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private window */
  }
};

export const smartHidden = () => read(SMART_HIDDEN_KEY) === "1";
export function setSmartHidden(hidden: boolean) {
  write(SMART_HIDDEN_KEY, hidden ? "1" : "0");
  window.dispatchEvent(new Event(SMART_EVENT));
}

export function SmartFolders() {
  const t = useT();
  const tree = useApp((s) => s.tree);
  const [hidden, setHidden] = useState(smartHidden);
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSED_KEY) !== "0");
  const [open, setOpen] = useState<Set<string>>(() => new Set(JSON.parse(read(OPEN_KEY) ?? "[]") as string[]));
  const [counts, setCounts] = useState<SmartCounts | null>(null);
  const [pages, setPages] = useState<Record<string, SmartPage[]>>({});
  const [groups, setGroups] = useState<Record<string, SmartGroup[]>>({});

  useEffect(() => {
    const on = () => setHidden(smartHidden());
    window.addEventListener(SMART_EVENT, on);
    return () => window.removeEventListener(SMART_EVENT, on);
  }, []);

  // The lists follow the tree (new, moved, renamed, trashed pages); fetched while shown.
  useEffect(() => {
    if (hidden || collapsed) return;
    let live = true;
    const timer = setTimeout(() => {
      filingApi.smartCounts().then((c) => live && setCounts(c), () => {});
      for (const id of open) {
        const [kind, key] = id.split(":", 2) as [SmartKind, string | undefined];
        const grouped = KINDS.find((k) => k.kind === kind)?.grouped;
        if (grouped && key == null) filingApi.smartGroups(kind).then((g) => live && setGroups((x) => ({ ...x, [id]: g })), () => {});
        else filingApi.smartPages(kind, key ?? null).then((p) => live && setPages((x) => ({ ...x, [id]: p })), () => {});
      }
    }, 150);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tree, hidden, collapsed, open]);

  if (hidden) return null;
  const toggle = (id: string) => {
    const next = new Set(open);
    next.has(id) ? next.delete(id) : next.add(id);
    setOpen(next);
    write(OPEN_KEY, JSON.stringify([...next]));
  };
  const flip = () => {
    setCollapsed(!collapsed);
    write(COLLAPSED_KEY, collapsed ? "0" : "1");
  };
  const openPage = (id: number, e: React.MouseEvent) => useApp.getState().openPage(id, { newTab: e.ctrlKey || e.metaKey, split: e.altKey });

  const pageList = (id: string, depth: number) => {
    const list = pages[id];
    if (!list) return null;
    if (!list.length) return <div className="smart-empty" style={{ paddingLeft: 10 + depth * 14 }}>{t("fl.smart.empty")}</div>;
    return list.map((p) => (
      <button key={p.id} type="button" className="smart-row smart-page" style={{ paddingLeft: 10 + depth * 14 }} onClick={(e) => openPage(p.id, e)} title={p.title}>
        <PageIcon name={p.icon} size={14} className="tree-icon" />
        <span className="tree-label">{p.title}</span>
      </button>
    ));
  };

  return (
    <section className="smart-folders" aria-label={t("fl.smart")}>
      <button type="button" className="smart-head" aria-expanded={!collapsed} onClick={flip}>
        <ChevronRight size={12} className={`chev ${collapsed ? "" : "open"}`} />
        <span>{t("fl.smart")}</span>
      </button>
      {!collapsed && (
        <div className="smart-body">
          {KINDS.map(({ kind, icon: Icon, grouped }) => {
            const id = kind;
            const isOpen = open.has(id);
            const n = counts?.[kind];
            return (
              <div key={kind} className="smart-folder" data-kind={kind}>
                <button type="button" className="smart-row smart-kind" aria-expanded={isOpen} onClick={() => toggle(id)}>
                  <ChevronRight size={12} className={`chev ${isOpen ? "open" : ""}`} />
                  <Icon size={14} className="smart-icon" aria-hidden />
                  <span className="tree-label">{t(`fl.smart.${kind}` as TKey)}</span>
                  {n != null && <span className="smart-count">{n}</span>}
                </button>
                {isOpen && !grouped && pageList(id, 1)}
                {isOpen &&
                  grouped &&
                  (groups[id]?.length === 0 ? (
                    <div className="smart-empty" style={{ paddingLeft: 24 }}>{t("fl.smart.empty")}</div>
                  ) : (
                    groups[id]?.map((g) => {
                      const gid = `${kind}:${g.key}`;
                      const gOpen = open.has(gid);
                      return (
                        <div key={gid} className="smart-group">
                          <button type="button" className="smart-row smart-kind" style={{ paddingLeft: 24 }} aria-expanded={gOpen} onClick={() => toggle(gid)}>
                            <ChevronRight size={12} className={`chev ${gOpen ? "open" : ""}`} />
                            <span className="tree-label">{g.label}</span>
                            <span className="smart-count">{g.count}</span>
                          </button>
                          {gOpen && pageList(gid, 2)}
                        </div>
                      );
                    })
                  ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
