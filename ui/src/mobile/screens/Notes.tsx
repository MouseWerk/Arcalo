// „Notizen“: search, recently edited pages and the page tree; a page opens for reading
// (Markdown rendered like the desktop's) and switches to editing its Markdown text.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, FileText, NotebookPen, Pencil, Search, TriangleAlert, X } from "lucide-react";
import { api } from "../../lib/api";
import { relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { Page, PageDoc, PageNode, SearchHit } from "../../lib/types";
import { errorText, useMobile } from "../context";
import { pageHtml, treeRows } from "../model";
import { Empty, Header, Notice, Section, Spinner } from "../ui";

export function NotesScreen() {
  const m = useMobile();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [recent, setRecent] = useState<Page[]>([]);
  const [tree, setTree] = useState<PageNode[] | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());

  useEffect(() => {
    let live = true;
    api.recentPages(6).then((p) => live && setRecent(p.filter((x) => !x.deleted_at))).catch(() => {});
    api.tree().then((n) => live && setTree(n)).catch((e) => m.toast("error", errorText(e)));
    return () => {
      live = false;
    };
  }, [m.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits(null);
      return;
    }
    const id = window.setTimeout(() => {
      api.search(q, 30).then(setHits).catch(() => setHits([]));
    }, 180);
    return () => window.clearTimeout(id);
  }, [query]);

  const rows = useMemo(() => (tree ? treeRows(tree, open) : []), [tree, open]);
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const pageHits = (hits ?? []).filter((h): h is Extract<SearchHit, { page_id: number }> => h.kind !== "time_entry");
  const seen = new Set<number>();
  const uniqueHits = pageHits.filter((h) => !seen.has(h.page_id) && !!seen.add(h.page_id));

  return (
    <div className="m-screen">
      <Header title={t("mob.notes.title")} />
      <div className="m-toolbar">
        <label className="m-search">
          <Search size={18} />
          <input type="search" value={query} placeholder={t("mob.notes.searchPlaceholder")} aria-label={t("mob.notes.search")} onChange={(e) => setQuery(e.target.value)} enterKeyHint="search" />
          {query && (
            <button type="button" className="m-icon-btn m-icon-btn-quiet" aria-label={t("common.clear")} onClick={() => setQuery("")}>
              <X size={18} />
            </button>
          )}
        </label>
      </div>
      <div className="m-scroll">
        {hits ? (
          uniqueHits.length ? (
            <Section flush>
              <ul className="m-list">
                {uniqueHits.map((h) => (
                  <li key={h.page_id}>
                    <button type="button" className="m-row" onClick={() => m.open({ kind: "page", id: h.page_id })}>
                      <span className="m-row-icon">
                        <FileText size={18} />
                      </span>
                      <span className="m-row-main">
                        <span className="m-row-title">{h.title}</span>
                        {h.kind === "note" && <span className="m-row-sub m-snippet">{h.snippet.replace(/<\/?mark>/g, "")}</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          ) : (
            <Empty text={t("mob.notes.noHits")} />
          )
        ) : !tree ? (
          <div className="m-loading">
            <Spinner />
          </div>
        ) : tree.length === 0 ? (
          <Empty icon={<FileText size={28} />} text={t("mob.notes.empty")} />
        ) : (
          <>
            <Section flush>
              <button type="button" className="m-row" onClick={() => m.open({ kind: "daily", date: dayKey(new Date()) })}>
                <span className="m-row-icon">
                  <NotebookPen size={18} />
                </span>
                <span className="m-row-main">
                  <span className="m-row-title">{t("mob.today.daily")}</span>
                </span>
                <ChevronRight size={18} className="m-chevron" />
              </button>
            </Section>
            {recent.length > 0 && (
              <Section title={t("mob.notes.recent")} flush>
                <ul className="m-list">
                  {recent.map((p) => (
                    <li key={p.id}>
                      <button type="button" className="m-row" onClick={() => m.open({ kind: "page", id: p.id })}>
                        <span className="m-row-icon">
                          <FileText size={18} />
                        </span>
                        <span className="m-row-main">
                          <span className="m-row-title">{p.title}</span>
                          <span className="m-row-sub">{relative(p.updated_at)}</span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Section>
            )}
            <Section title={t("mob.notes.all")} flush>
              <ul className="m-list m-tree">
                {rows.map((r) => (
                  <li key={r.node.id} className="m-tree-row" style={{ paddingInlineStart: `${r.depth * 16}px` }}>
                    {r.hasChildren ? (
                      <button type="button" className="m-icon-btn m-icon-btn-quiet m-tree-toggle" aria-expanded={r.open} aria-label={r.open ? t("mob.notes.collapse") : t("mob.notes.expand")} onClick={() => toggle(r.node.id)}>
                        {r.open ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </button>
                    ) : (
                      <span className="m-tree-spacer" />
                    )}
                    <button type="button" className="m-row m-tree-page" onClick={() => m.open({ kind: "page", id: r.node.id })}>
                      <span className="m-row-main">
                        <span className="m-row-title">{r.node.title}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function PageScreen({ id }: { id: number }) {
  const m = useMobile();
  const [doc, setDoc] = useState<PageDoc | null>(null);
  const [editing, setEditing] = useState(false);
  const [conflict, setConflict] = useState(false);

  useEffect(() => {
    let live = true;
    api.page(id).then((d) => live && setDoc(d)).catch((e) => m.toast("error", errorText(e)));
    api.gitConflicts().then((c) => live && setConflict(c.some((x) => x.page_id === id))).catch(() => {});
    return () => {
      live = false;
    };
  }, [id, m.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const canvas = doc?.kind === "canvas";
  return (
    <div className="m-screen">
      <Header
        title={doc?.title ?? ""}
        back="back"
        actions={
          doc && !canvas ? (
            <button type="button" className="m-icon-btn" aria-label={editing ? t("mob.notes.done") : t("mob.notes.edit")} onClick={() => setEditing((v) => !v)}>
              {editing ? <span className="m-head-text">{t("mob.notes.done")}</span> : <Pencil size={20} />}
            </button>
          ) : undefined
        }
      />
      {!doc ? (
        <div className="m-loading">
          <Spinner />
        </div>
      ) : (
        <PageBody doc={doc} editing={editing} conflict={conflict} onSaved={(content) => setDoc({ ...doc, content })} onDone={() => setEditing(false)} />
      )}
    </div>
  );
}

/** A page's text: rendered for reading, or its Markdown in a text field while editing (saved
 *  when leaving the field, after a pause in typing and with „Fertig“). */
export function PageBody(p: { doc: PageDoc; editing: boolean; conflict?: boolean; onSaved: (content: string) => void; onDone: () => void }) {
  const m = useMobile();
  const [text, setText] = useState(p.doc.content);
  const saved = useRef(p.doc.content);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!p.editing) {
      setText(p.doc.content);
      saved.current = p.doc.content;
    }
  }, [p.doc.content, p.editing]);

  const save = async (content: string) => {
    window.clearTimeout(timer.current);
    if (content === saved.current) return;
    try {
      await api.savePage(p.doc.id, content);
      saved.current = content;
      p.onSaved(content);
    } catch (e) {
      m.toast("error", t("mob.notes.saveFailed"), errorText(e));
    }
  };
  // Leaving editing saves.
  const wasEditing = useRef(p.editing);
  useEffect(() => {
    if (wasEditing.current && !p.editing) void save(text).then(() => m.refresh());
    wasEditing.current = p.editing;
  }, [p.editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const target = a.getAttribute("data-target");
    if (target) {
      api
        .resolvePage(target, false)
        .then((page) => (page ? m.open({ kind: "page", id: page.id }) : m.toast("info", t("mob.notes.linkMissing", { title: target }))))
        .catch(() => {});
      return;
    }
    const href = a.getAttribute("href");
    if (href && /^https?:\/\//.test(href)) void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(href)).catch(() => {});
  };

  if (p.doc.kind === "canvas") {
    return (
      <div className="m-scroll">
        <Empty icon={<FileText size={28} />} text={t("mob.notes.canvas")} />
      </div>
    );
  }
  if (p.editing) {
    return (
      <div className="m-editor">
        <textarea
          className="m-textarea m-editor-text"
          value={text}
          autoFocus
          spellCheck
          onChange={(e) => {
            const v = e.target.value;
            setText(v);
            window.clearTimeout(timer.current);
            timer.current = window.setTimeout(() => void save(v), 1500);
          }}
          onBlur={() => void save(text)}
          aria-label={p.doc.title}
        />
        <div className="m-editor-hint">{t("mob.notes.editHint")}</div>
      </div>
    );
  }
  return (
    <div className="m-scroll">
      {p.conflict && (
        <Notice tone="warning" icon={<TriangleAlert size={18} />}>
          {t("mob.notes.conflict")}
        </Notice>
      )}
      {p.doc.content.trim() ? (
        <div className="m-read" onClick={onClick} dangerouslySetInnerHTML={{ __html: pageHtml(p.doc.content) }} />
      ) : (
        <Empty text={t("mob.notes.emptyPage")} />
      )}
    </div>
  );
}
