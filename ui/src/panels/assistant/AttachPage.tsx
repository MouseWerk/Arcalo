// „Seite anhängen“ in the chat view's composer: a page chosen by typing part of its title (the
// recently edited pages before typing). The page goes along with the next questions.

import { useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { api } from "../../lib/api";
import { t } from "../../lib/i18n";
import { useApp } from "../../store/app";
import { PageIcon } from "../../components/icons";
import type { Page } from "../../lib/types";

/** Pages whose title contains `query` (title starts first), at most `limit`. */
export function matchPages<P extends { id: number; title: string; deleted_at?: string | null }>(pages: Iterable<P>, query: string, limit = 8): P[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const out: P[] = [];
  for (const p of pages) {
    if (p.deleted_at || !p.title.toLowerCase().includes(needle)) continue;
    out.push(p);
  }
  const starts = (p: P) => Number(!p.title.toLowerCase().startsWith(needle));
  return out.sort((a, b) => starts(a) - starts(b) || a.title.localeCompare(b.title)).slice(0, limit);
}

export function AttachPage({ onPick, icon: Icon }: { onPick: (id: number) => void; icon: LucideIcon }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [recent, setRecent] = useState<Page[]>([]);
  const pages = useApp((s) => s.pages);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    api.recentPages(6).then(setRecent).catch(() => setRecent([]));
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("pointerdown", away);
    return () => window.removeEventListener("pointerdown", away);
  }, [open]);
  const hits = useMemo(() => (q.trim() ? matchPages(pages.values(), q) : recent.map((p) => pages.get(p.id) ?? p)), [q, pages, recent]);
  const index = Math.min(active, Math.max(0, hits.length - 1));
  const pick = (id: number) => {
    setOpen(false);
    setQ("");
    onPick(id);
  };
  return (
    <span className="attach-page">
      <button
        ref={button}
        type="button"
        className="context-chip attach-btn"
        aria-expanded={open}
        aria-haspopup="listbox"
        title={t("chatv.attachHint")}
        aria-label={t("chatv.attach")}
        onClick={() => setOpen(!open)}
      >
        <Icon size={12} aria-hidden />
        <span>{t("chatv.attach")}</span>
      </button>
      {open && (
        <div ref={box} className="attach-pop" role="dialog" aria-label={t("chatv.attach")}>
          <input
            autoFocus
            className="attach-search"
            value={q}
            placeholder={t("chatv.attachSearch")}
            aria-label={t("chatv.attachSearch")}
            aria-controls="attach-list"
            onChange={(e) => (setQ(e.target.value), setActive(0))}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                setActive(Math.max(0, Math.min(hits.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))));
              } else if (e.key === "Enter" && hits[index]) {
                e.preventDefault();
                pick(hits[index].id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                button.current?.focus();
              }
            }}
          />
          <div id="attach-list" className="attach-list" role="listbox" aria-label={t("chatv.attach")}>
            {!q.trim() && hits.length > 0 && <div className="attach-label">{t("chatv.recent")}</div>}
            {hits.map((p, i) => (
              <button key={p.id} type="button" role="option" aria-selected={i === index} className={`attach-row ${i === index ? "active" : ""}`} onMouseMove={() => setActive(i)} onClick={() => pick(p.id)}>
                <PageIcon name={p.icon} size={14} />
                <span className="attach-title">{p.title}</span>
              </button>
            ))}
            {q.trim() && !hits.length && <div className="attach-empty">{t("chatv.noPages")}</div>}
          </div>
        </div>
      )}
    </span>
  );
}
