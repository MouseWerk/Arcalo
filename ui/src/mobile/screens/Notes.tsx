// „Notizen“: search, recently edited pages and the page tree; a page opens for reading
// (Markdown rendered like the desktop's) and switches to editing its Markdown text.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, ChevronRight, FileText, NotebookPen, Pencil, Search, TriangleAlert, X } from "lucide-react";
import { api } from "../../lib/api";
import { relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { Page, PageDoc, PageNode, SearchHit } from "../../lib/types";
import { onFlush } from "../../lib/flush";
import { errorText, useBackLayer, useMobile } from "../context";
import { mayRepeat, pageHtml, toggleTask, treeRows, withNextOccurrence } from "../model";
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
        <PageBody doc={doc} editing={editing} conflict={conflict} onSaved={(content) => setDoc((d) => (d && d.id === doc.id ? { ...d, content } : d))} onDone={() => setEditing(false)} />
      )}
    </div>
  );
}

/** A page's text: rendered for reading, or its Markdown in a text field while editing (saved
 *  when leaving the field, after a pause in typing and with „Fertig“). A save names the text it
 *  started from, so a change a sync took over meanwhile is merged, never overwritten. */
/**
 * The task box a tap meant: the box itself, or the space around it in its row (the box is small;
 * a tap up to the touch size around it counts, the task's text and links do not).
 */
function taskBoxAt(e: MouseEvent<HTMLDivElement>): HTMLInputElement | null {
  const el = e.target as HTMLElement;
  if (el instanceof HTMLInputElement && el.type === "checkbox") return el;
  const li = el.closest("li");
  const box = li?.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
  if (!box || el.closest("a") || el !== li) return null;
  const r = box.getBoundingClientRect();
  const reach = Math.max(0, (TOUCH - r.width) / 2);
  return e.clientX >= r.left - reach && e.clientX <= r.right + reach ? box : null;
}
/** The touch size (--touch-min). */
const TOUCH = 44;

export function PageBody(p: { doc: PageDoc; editing: boolean; conflict?: boolean; onSaved: (content: string) => void; onDone: () => void }) {
  const m = useMobile();
  // The props and context of the latest render: a save that ends after the screen moved on (the
  // pause in typing, the app going to the background, the screen closing) reports to them.
  const props = useRef(p);
  props.current = p;
  const ctx = useRef(m);
  ctx.current = m;
  const [text, setText] = useState(p.doc.content);
  // The page as stored when this editor last saw it: the base of the next save.
  const saved = useRef(p.doc.content);
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef<number | undefined>(undefined);
  const saving = useRef<Promise<void>>(Promise.resolve());
  // Saves started and on their way: a read of the page from before one of them is outdated.
  const saves = useRef(0);
  const inFlight = useRef(0);
  const missed = useRef(false);

  // The page as stored now, shown when nothing typed waits for its save (else that save merges
  // both). Read by the editor itself: a read the screen started before a save may arrive after it.
  const reread = () => {
    if (inFlight.current > 0) {
      missed.current = true;
      return;
    }
    const at = saves.current;
    api
      .page(props.current.doc.id)
      .then((d) => {
        if (saves.current !== at || inFlight.current > 0) return;
        if (d.content === saved.current || latest.current !== saved.current) return;
        saved.current = d.content;
        latest.current = d.content;
        setText(d.content);
      })
      .catch(() => {});
  };
  // The page changed under the editor (a sync took the server's text over).
  useEffect(() => {
    if (p.doc.content !== saved.current) reread();
  }, [p.doc.content]); // eslint-disable-line react-hooks/exhaustive-deps

  // One save after the other, each from the base the one before left.
  const save = (content: string) => {
    window.clearTimeout(timer.current);
    saves.current += 1;
    inFlight.current += 1;
    const run = saving.current.then(async () => {
      if (content === saved.current) return;
      const { doc, onSaved } = props.current;
      try {
        const res = await api.savePage(doc.id, content, saved.current);
        const stored = res.merged ?? content;
        if (res.merged === undefined || latest.current === content) {
          saved.current = stored;
          // Merged with the change made elsewhere: shown here as stored.
          if (res.merged !== undefined) {
            latest.current = stored;
            setText(stored);
          }
        } else {
          // Typed on meanwhile: the next save merges that with what is stored now.
          saved.current = content;
        }
        onSaved(stored);
      } catch (e) {
        ctx.current.toast("error", t("mob.notes.saveFailed"), errorText(e));
      }
    });
    saving.current = run.finally(() => {
      inFlight.current -= 1;
      // A change seen while the save was on its way is read again now.
      if (inFlight.current === 0 && missed.current) {
        missed.current = false;
        reread();
      }
    });
    return saving.current;
  };
  // Leaving editing saves.
  const wasEditing = useRef(p.editing);
  useEffect(() => {
    if (wasEditing.current && !p.editing) void save(latest.current).then(() => ctx.current.refresh());
    wasEditing.current = p.editing;
  }, [p.editing]); // eslint-disable-line react-hooks/exhaustive-deps
  // Android's back button ends editing first (and saves), the next one leaves the page.
  useBackLayer(p.editing, p.onDone);
  // Typed text is never lost: saved when the app goes to the background (Android may end it
  // there without notice) and when the screen closes before the pause in typing ran out.
  useEffect(() => {
    const onHidden = () => document.visibilityState === "hidden" && void save(latest.current);
    document.addEventListener("visibilitychange", onHidden);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      if (latest.current !== saved.current) void save(latest.current);
    };
  }, [p.doc.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // Stored before the app switches to the full app on a larger window (lib/uiswitch.ts). A save
  // that failed (it only shows a message) or text typed on meanwhile keeps the phone app.
  useEffect(
    () =>
      onFlush(
        async () => {
          await save(latest.current);
          if (latest.current !== saved.current) throw new Error(t("ne.changesNotSaved"));
        },
        () => latest.current !== saved.current,
      ),
    [p.doc.id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // A task's box ticked in the page (A19): the line changes in the page's text, saved like a
  // typed edit (with the text it started from, so a sync's change meanwhile is merged). A
  // repeating task gets its next occurrence below it, as on the desktop.
  const tick = async (index: number) => {
    const start = latest.current;
    let out = toggleTask(start, index);
    const gone = () => {
      ctx.current.toast("error", t("mob.notes.taskGone"));
      reread();
    };
    if (!out) return gone();
    let next = out.md;
    if (out.done && mayRepeat(out.text)) {
      const due = await api.taskNextDue(out.text).catch(() => null);
      // The page changed while the date was asked for (a sync): ticked off on that text.
      if (latest.current !== start) {
        const again = toggleTask(latest.current, index);
        if (!again || again.text !== out.text || !again.done) return gone();
        out = again;
      }
      next = due ? withNextOccurrence(out.md, out.line, due) : out.md;
    }
    latest.current = next;
    setText(next);
    await save(next);
    ctx.current.refresh();
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const box = taskBoxAt(e);
    if (box) {
      e.preventDefault();
      void tick([...e.currentTarget.querySelectorAll('input[type="checkbox"]')].indexOf(box));
      return;
    }
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
          data-flush
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
      {text.trim() ? (
        <div className="m-read" onClick={onClick} dangerouslySetInnerHTML={{ __html: pageHtml(text) }} />
      ) : (
        <Empty text={t("mob.notes.emptyPage")} />
      )}
    </div>
  );
}
