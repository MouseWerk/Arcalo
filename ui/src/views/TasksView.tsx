// Tasks across all notes (`- [ ] …`), grouped by due date. Toggling rewrites the
// checkbox in the page's Markdown; open editors of that page reload via data://tasks.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronUp, ChevronsUp, ListChecks } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, EmptyState, Segmented, Select, Spinner } from "../components/ui";
import { PageIcon } from "../components/icons";
import { flushAllEditors } from "../editor/NoteEditor";
import { TASK_GROUPS, taskGroup, taskSegments } from "../lib/tasks";
import { visibleRange } from "../lib/activity";
import type { Task, TaskStatus } from "../lib/types";

const STATUS: { value: TaskStatus; label: string }[] = [
  { value: "open", label: "Offen" },
  { value: "done", label: "Erledigt" },
  { value: "all", label: "Alle" },
];

const key = (t: Task) => `${t.page_id}:${t.ordinal}`;

/** Lists with more tasks render only the rows in view (row heights measured as they appear). */
const VIRTUAL_TASKS = 300;
/** Height of a task row before it was measured (one line). */
const ROW_ESTIMATE = 36;
/** Pixels rendered above and below the view. */
const OVERSCAN_PX = 600;

function dueLabel(due: string, year: number) {
  const [y, m, d] = due.split("-");
  return `${d}.${m}.${Number(y) === year ? "" : y}`;
}

export function TasksView() {
  const pages = useApp((s) => s.pages);
  const [status, setStatus] = useState<TaskStatus>("open");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<[string, number][]>([]);
  const [list, setList] = useState<Task[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const s = useApp.getState;

  const load = useCallback(() => {
    const n = ++seq.current;
    api
      .tasks({ status, tag: tag || null })
      .then((l) => n === seq.current && setList(l))
      .catch((e) => (setList([]), useApp.getState().error("Aufgaben konnten nicht geladen werden", e)));
  }, [status, tag]);

  useEffect(load, [load, pages]);
  useEffect(() => {
    api.tags().then(setTags).catch(() => {});
  }, [pages]);
  // Edits in an editor change tasks too; refetch shortly after saves.
  useEffect(() => {
    let t: number | undefined;
    const onSaved = () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 300);
    };
    window.addEventListener("annalo:page-saved", onSaved);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("annalo:page-saved", onSaved);
    };
  }, [load]);

  const toggle = async (t: Task) => {
    const k = key(t);
    setBusy((b) => new Set(b).add(k));
    setList((l) => l?.map((x) => (key(x) === k ? { ...x, done: !t.done } : x)) ?? l);
    try {
      // Pending edits first, so the ordinal matches what is stored.
      await flushAllEditors();
      await api.setTaskDone(t.page_id, t.ordinal, !t.done, t.text);
    } catch (e) {
      s().error("Aufgabe konnte nicht geändert werden", e);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        n.delete(k);
        return n;
      });
      load();
    }
  };

  const openLink = async (target: string, newTab: boolean) => {
    try {
      const page = await api.resolvePage(target, true);
      if (!page) return;
      if (!s().pages.has(page.id)) await s().refreshTree();
      s().openPage(page.id, { newTab });
    } catch (e) {
      s().error("Link konnte nicht geöffnet werden", e);
    }
  };

  const now = new Date();
  const actions = useRef({ toggle, openLink });
  actions.current = { toggle, openLink };
  const groups = useMemo(() => {
    const today = new Date();
    return TASK_GROUPS.map((g) => ({ ...g, tasks: (list ?? []).filter((t) => taskGroup(t.due, today) === g.id) })).filter((g) => g.tasks.length);
  }, [list]);
  const open = list?.filter((t) => !t.done).length ?? 0;

  // ---- long lists: per group only the rows in view, with spacers of the (measured) heights of the others.
  const virtual = (list?.length ?? 0) > VIRTUAL_TASKS;
  const scroller = useRef<HTMLDivElement>(null);
  const heights = useRef(new Map<string, number>());
  const lists = useRef(new Map<string, HTMLUListElement>());
  const [view, setView] = useState<{ top: number; height: number; tops: Record<string, number>; v: number }>({ top: 0, height: 1000, tops: {}, v: 0 });
  const measure = useCallback(() => {
    const sc = scroller.current;
    if (!sc) return;
    const base = sc.getBoundingClientRect().top - sc.scrollTop;
    const tops: Record<string, number> = {};
    for (const [id, ul] of lists.current) tops[id] = ul.getBoundingClientRect().top - base;
    setView((cur) => ({ top: sc.scrollTop, height: sc.clientHeight, tops, v: cur.v + 1 }));
  }, []);
  useEffect(() => {
    const sc = scroller.current;
    if (!virtual || !sc) return;
    let frame = 0;
    const schedule = () => (frame ||= requestAnimationFrame(() => ((frame = 0), measure())));
    measure();
    sc.addEventListener("scroll", schedule, { passive: true });
    const ro = new ResizeObserver(schedule);
    ro.observe(sc);
    return () => {
      cancelAnimationFrame(frame);
      sc.removeEventListener("scroll", schedule);
      ro.disconnect();
    };
  }, [virtual, measure]);
  // WebKit anchors the scroll position to a row when the rendered rows change (overflow-anchor
  // is not supported there): the position before the commit is the one to keep.
  const beforeCommit = useRef(0);
  beforeCommit.current = scroller.current?.scrollTop ?? 0;
  useLayoutEffect(() => {
    const sc = scroller.current;
    if (sc && virtual && sc.scrollTop !== beforeCommit.current) sc.scrollTop = beforeCommit.current;
  });
  // Rendered rows tell their real height; a changed one moves the rows after it.
  useLayoutEffect(() => {
    if (!virtual) return;
    let changed = false;
    for (const el of scroller.current?.querySelectorAll<HTMLElement>(".task-row[data-page]") ?? []) {
      const k = `${el.dataset.page}:${el.dataset.ordinal}`;
      const h = el.offsetHeight;
      if (h && heights.current.get(k) !== h) {
        heights.current.set(k, h);
        changed = true;
      }
    }
    if (changed) measure();
  });
  /** Rows of a group to render, and the heights of the spacers before and after them. */
  const windowOf = (id: string, tasks: Task[]): { from: number; to: number; before: number; after: number } => {
    if (!virtual) return { from: 0, to: tasks.length, before: 0, after: 0 };
    const offsets: number[] = [];
    let y = 0;
    for (const t of tasks) {
      offsets.push(y);
      y += heights.current.get(key(t)) ?? ROW_ESTIMATE;
    }
    // Not placed yet: only the first group, from its start.
    const top = view.tops[id] ?? (id === groups[0]?.id ? view.top : null);
    const lo = top == null ? y : view.top - top - OVERSCAN_PX;
    const hi = top == null ? -1 : view.top - top + view.height + OVERSCAN_PX;
    const [from, to] = hi < 0 || lo > y ? [0, 0] : visibleRange(offsets, y, Math.max(0, lo), hi - Math.max(0, lo), 0);
    return { from, to, before: offsets[from] ?? y, after: y - (offsets[to] ?? y) };
  };

  return (
    <div className="view-scroll" ref={scroller}>
      <div className="view narrow tasks-view">
        <header className="view-header">
          <div>
            <h1>Aufgaben</h1>
            <div className="view-sub">{list ? `${open} offen · ${list.length} ${list.length === 1 ? "Aufgabe" : "Aufgaben"}` : ""}</div>
          </div>
          <div className="view-actions">
            <Segmented value={status} options={STATUS} onChange={setStatus} />
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag">
              <option value="">Alle Tags</option>
              {tags.map(([t]) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </Select>
          </div>
        </header>
        {!list ? (
          <Spinner />
        ) : list.length === 0 ? (
          <EmptyState icon={ListChecks} title={status === "done" ? "Keine erledigten Aufgaben" : "Keine offenen Aufgaben"}>
            Aufgaben sind Listenpunkte wie <code>- [ ] Angebot senden due:2026-09-30 !!</code> in beliebigen Seiten. <code>!!</code> = hoch, <code>!</code> = mittel.
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.id} className={`task-group task-group-${g.id}`} aria-label={g.label}>
              <h2 className="task-group-title">
                {g.label} <span className="faint">{g.tasks.length}</span>
              </h2>
              <ul
                className="task-list"
                ref={(el) => {
                  if (el) lists.current.set(g.id, el);
                  else lists.current.delete(g.id);
                }}
              >
                {(() => {
                  const w = windowOf(g.id, g.tasks);
                  return (
                    <>
                      {w.before > 0 && <li className="task-spacer" aria-hidden style={{ height: w.before }} />}
                      {g.tasks.slice(w.from, w.to).map((t) => (
                        <TaskRow key={key(t)} task={t} group={g.id} busy={busy.has(key(t))} year={now.getFullYear()} act={actions} />
                      ))}
                      {w.after > 0 && <li className="task-spacer" aria-hidden style={{ height: w.after }} />}
                    </>
                  );
                })()}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

interface TaskActions {
  toggle: (t: Task) => void;
  openLink: (target: string, newTab: boolean) => void;
}

const TaskRow = memo(function TaskRow({ task: t, group, busy, year, act }: { task: Task; group: string; busy: boolean; year: number; act: { current: TaskActions } }) {
  const s = useApp.getState;
  const overdue = !t.done && group === "overdue";
  return (
    <li className={`task-row ${t.done ? "done" : ""}`} data-page={t.page_id} data-ordinal={t.ordinal}>
      <input
        type="checkbox"
        className="task-check"
        checked={t.done}
        aria-disabled={busy}
        onChange={() => !busy && act.current.toggle(t)}
        aria-label={t.done ? `„${t.text}“ wieder öffnen` : `„${t.text}“ erledigen`}
      />
      <div className="task-main">
        <span className="task-text">
          {t.priority === 2 && <ChevronsUp size={14} strokeWidth={2.25} className="task-prio high" aria-label="Priorität hoch" />}
          {t.priority === 1 && <ChevronUp size={14} strokeWidth={2.25} className="task-prio medium" aria-label="Priorität mittel" />}
          {taskSegments(t.text).map((seg, i) =>
            seg.kind === "link" ? (
              <span key={i} className="wikilink" data-target={seg.target} role="link" tabIndex={0} onClick={(e) => act.current.openLink(seg.target, e.ctrlKey || e.metaKey)} onKeyDown={(e) => e.key === "Enter" && act.current.openLink(seg.target, false)}>
                {seg.text}
              </span>
            ) : seg.kind === "tag" ? (
              <span key={i} className="tag" role="link" tabIndex={0} onClick={() => s().openTab({ kind: "tag", tag: seg.tag }, { newTab: true })} onKeyDown={(e) => e.key === "Enter" && s().openTab({ kind: "tag", tag: seg.tag }, { newTab: true })}>
                {seg.text}
              </span>
            ) : (
              <span key={i}>{seg.text}</span>
            ),
          )}
        </span>
        <span className="task-meta">
          {t.due && (
            <Badge tone={overdue ? "danger" : group === "today" && !t.done ? "warning" : "neutral"} title={overdue ? "Überfällig" : "Fällig"}>
              <CalendarClock size={12} /> {dueLabel(t.due, year)}
            </Badge>
          )}
          <button type="button" className="task-page" onClick={(e) => s().openPage(t.page_id, { newTab: e.ctrlKey || e.metaKey })} title={`${t.page_title} öffnen`}>
            <PageIcon name={t.page_icon} size={13} />
            <span className="task-page-label">{t.page_title}</span>
          </button>
        </span>
      </div>
    </li>
  );
});
