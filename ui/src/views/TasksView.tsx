// Tasks across all notes (`- [ ] …`), grouped by due date. Toggling rewrites the
// checkbox in the page's Markdown; open editors of that page reload via data://tasks.
// Several tasks can be selected (Auswählen, Ctrl/Shift+click, Ctrl+A) and changed at once:
// done, due date, priority, repeat rule, move to another page, delete; each with one undo.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  CalendarClock,
  CalendarPlus,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  ChevronsUp,
  FileInput,
  Flag,
  ListChecks,
  Mail,
  MoreHorizontal,
  Repeat,
  RotateCcw,
  SquareDashedMousePointer,
  Trash2,
  X,
} from "lucide-react";
import { api } from "../lib/api";
import { openIfFileLink } from "../editor/files";
import { useApp } from "../store/app";
import { Badge, Button, EmptyState, IconButton, Segmented, Select, Skeleton, useMenu, type MenuEntry, type MenuItem } from "../components/ui";
import { openPlanPicker, setPlanData, type PlanItem } from "../lib/blocks";
import { PageIcon } from "../components/icons";
import { pickDate } from "../components/CalendarPopover";
import { flushAllEditors } from "../editor/NoteEditor";
import { TASK_GROUPS, nextMonday, recurLabel, selectClick, taskGroup, taskSegments } from "../lib/tasks";
import { addDays, fmtDayMonth, isoDay } from "../lib/format";
import { openMailLink } from "../lib/mail";
import { visibleRange } from "../lib/activity";
import type { Recurrence, Task, TaskChange, TaskEdit, TaskStatus } from "../lib/types";
import { t as tr, useT, withLabel } from "../lib/i18n";
import { RecurDialog, TaskMoveDialog } from "./TaskDialogs";

const STATUS: { value: TaskStatus; readonly label: string }[] = [
  withLabel({ value: "open" as TaskStatus }, "tasks.status.open"),
  withLabel({ value: "done" as TaskStatus }, "tasks.status.done"),
  withLabel({ value: "all" as TaskStatus }, "tasks.status.all"),
];

const key = (t: Task) => `${t.page_id}:${t.ordinal}`;

/** Lists with more tasks render only the rows in view (row heights measured as they appear). */
const VIRTUAL_TASKS = 300;
/** Height of a task row before it was measured (one line). */
const ROW_ESTIMATE = 36;
/** Pixels rendered above and below the view. */
const OVERSCAN_PX = 600;

const refOf = (t: Task) => ({ page_id: t.page_id, ordinal: t.ordinal, text: t.text });
const dayText = (iso: string) => fmtDayMonth(new Date(`${iso}T12:00:00`));

/** Where the keyboard goes in a row: its selection box while selecting, else its checkbox. */
const rowFocus = (li: Element | null | undefined) => li?.querySelector<HTMLElement>(".task-select") ?? li?.querySelector<HTMLElement>(".task-check");

function dueLabel(due: string, year: number) {
  const [y, m, d] = due.split("-");
  return `${d}.${m}.${Number(y) === year ? "" : y}`;
}

export function TasksView() {
  useT();
  const pages = useApp((s) => s.pages);
  const [status, setStatus] = useState<TaskStatus>("open");
  const [tag, setTag] = useState("");
  const [tags, setTags] = useState<[string, number][]>([]);
  const [list, setList] = useState<Task[] | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const [dialog, setDialog] = useState<{ kind: "recur" | "move"; tasks: Task[] } | null>(null);
  const [menu, openMenu, openMenuAt] = useMenu();
  const seq = useRef(0);
  const s = useApp.getState;

  const load = useCallback(() => {
    const n = ++seq.current;
    api
      .tasks({ status, tag: tag || null })
      .then((l) => n === seq.current && setList(l))
      .catch((e) => (setList([]), useApp.getState().error(tr("tasks.loadFailed"), e)));
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
    window.addEventListener("arcalo:page-saved", onSaved);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("arcalo:page-saved", onSaved);
    };
  }, [load]);

  const undo = (change: TaskChange) =>
    void api.tasksUndo(change).then(
      () => (s().toast({ tone: "info", title: tr("tasks.undone"), key: "tasks-undo" }), load()),
      (e) => (s().error(tr("tasks.undoFailed"), e), load()),
    );

  const toggle = async (t: Task) => {
    const k = key(t);
    setBusy((b) => new Set(b).add(k));
    setList((l) => l?.map((x) => (key(x) === k ? { ...x, done: !t.done } : x)) ?? l);
    try {
      // Pending edits first, so the ordinal matches what is stored.
      await flushAllEditors();
      const change = await api.tasksEdit([refOf(t)], { kind: "done", done: !t.done });
      // Done under „Offen“ (or a repeating one): the row leaves the list, the toast brings it
      // back (and takes the next occurrence away again).
      if (!t.done && (status === "open" || change.created.length))
        s().toast({
          tone: "success",
          title: tr("tasks.doneToast"),
          detail: change.created.length ? `${t.text} · ${tr("tasks.toast.next", { date: dayText(change.created[0]) })}` : t.text,
          key: `task-done-${k}`,
          action: { label: tr("common.undo"), run: () => undo(change) },
        });
    } catch (e) {
      s().error(tr("tasks.changeFailed"), e);
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
    if (openIfFileLink(target)) return;
    try {
      const page = await api.resolvePage(target, true);
      if (!page) return;
      if (!s().pages.has(page.id)) await s().refreshTree();
      s().openPage(page.id, { newTab });
    } catch (e) {
      s().error(tr("tasks.linkFailed"), e);
    }
  };

  /** Changes `tasks` at once, with one toast and one undo for all of them. */
  const run = async (tasks: Task[], edit: TaskEdit, title: (n: number) => string) => {
    if (!tasks.length) return;
    try {
      await flushAllEditors();
      const change = await api.tasksEdit(tasks.map(refOf), edit);
      const detail = [
        change.created.length === 1 ? tr("tasks.toast.next", { date: dayText(change.created[0]) }) : "",
        change.skipped ? tr("tasks.toast.skipped", { n: change.skipped }) : "",
      ]
        .filter(Boolean)
        .join(" · ");
      s().toast({ tone: "success", title: title(change.changed), detail: detail || undefined, key: "tasks-bulk", action: { label: tr("common.undo"), run: () => undo(change) } });
      // Lines come and go with these: the keys of the selection would name other tasks.
      if (edit.kind === "done" || edit.kind === "delete" || edit.kind === "move") setSel(new Set());
    } catch (e) {
      s().error(tr("tasks.changeFailed"), e);
    } finally {
      load();
    }
  };
  const setDone = (tasks: Task[], done: boolean) => run(tasks, { kind: "done", done }, (n) => tr(done ? "tasks.toast.done" : "tasks.toast.reopened", { n }));
  const setDue = (tasks: Task[], due: string | null) => run(tasks, { kind: "due", due }, (n) => tr("tasks.toast.due", { n }));
  const setPrio = (tasks: Task[], priority: number) => run(tasks, { kind: "priority", priority }, (n) => tr("tasks.toast.priority", { n }));
  const setRecur = (tasks: Task[], recur: Recurrence | null) => run(tasks, { kind: "recur", recur }, (n) => tr("tasks.toast.recur", { n }));
  const remove = (tasks: Task[]) => run(tasks, { kind: "delete" }, (n) => tr("tasks.toast.deleted", { n }));
  const moveTo = (tasks: Task[], pageId: number, title: string) => run(tasks, { kind: "move", page_id: pageId }, (n) => tr("tasks.toast.moved", { n, title }));

  const dueItems = (tasks: Task[], anchorEl: () => Element | null): MenuItem[] => {
    const today = new Date();
    return [
      { label: tr("tasks.act.dueToday"), icon: CalendarClock, onSelect: () => void setDue(tasks, isoDay(today)) },
      { label: tr("tasks.act.dueTomorrow"), onSelect: () => void setDue(tasks, isoDay(addDays(today, 1))) },
      { label: tr("tasks.act.dueNextWeek"), onSelect: () => void setDue(tasks, isoDay(nextMonday(today))) },
      {
        label: tr("tasks.act.duePick"),
        icon: CalendarPlus,
        onSelect: () => {
          const el = anchorEl();
          if (el) pickDate(el, tasks.length === 1 ? (tasks[0].due ?? undefined) : undefined, (iso) => void setDue(tasks, iso));
        },
      },
      { label: tr("tasks.act.dueRemove"), icon: X, disabled: !tasks.some((t) => t.due), onSelect: () => void setDue(tasks, null) },
    ];
  };
  const prioItems = (tasks: Task[]): MenuItem[] =>
    (
      [
        [2, "tasks.act.prioHigh"],
        [1, "tasks.act.prioMedium"],
        [0, "tasks.act.prioNone"],
      ] as const
    ).map(([p, label]) => ({ label: tr(label), checked: tasks.every((t) => t.priority === p), onSelect: () => void setPrio(tasks, p) }));
  /** The task menu: for the selection when the task is part of it, else for the task. */
  const menuFor = (t: Task | null, anchorEl: () => Element | null): MenuEntry[] => {
    const tasks = t && !sel.has(key(t)) ? [t] : selected;
    if (!tasks.length) return [];
    const allDone = tasks.every((x) => x.done);
    return [
      allDone ? { label: tr("tasks.act.reopen"), icon: RotateCcw, onSelect: () => void setDone(tasks, false) } : { label: tr("tasks.act.done"), icon: Check, onSelect: () => void setDone(tasks, true) },
      "separator",
      { label: tr("tasks.act.due"), icon: CalendarClock, submenu: dueItems(tasks, anchorEl) },
      { label: tr("tasks.act.priority"), icon: Flag, submenu: prioItems(tasks) },
      { label: tr("tasks.act.recur"), icon: Repeat, onSelect: () => setDialog({ kind: "recur", tasks }) },
      { label: tr("tasks.act.move"), icon: FileInput, onSelect: () => setDialog({ kind: "move", tasks }) },
      ...(tasks.length === 1 ? (["separator", { label: tr("tasks.act.openPage"), onSelect: () => s().openPage(tasks[0].page_id) }] as MenuEntry[]) : []),
      "separator",
      { label: tr("tasks.act.delete"), icon: Trash2, danger: true, shortcut: tr("sb.keyDelete"), onSelect: () => void remove(tasks) },
    ];
  };

  /** A click on a row (not on its controls): with Ctrl/Cmd or Shift, or while selecting, it selects. */
  const rowClick = (e: ReactMouseEvent, t: Task) => {
    const k = key(t);
    const range = e.shiftKey;
    if (!selecting && !range && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    setSelecting(true);
    setSel((cur) => selectClick(cur, order, k, anchor.current, range));
    if (!range) anchor.current = k;
  };
  const rowMenu = (e: ReactMouseEvent, t: Task, fromButton = false) => {
    const li = (e.currentTarget as HTMLElement).closest(".task-row");
    const items = menuFor(t, () => li);
    if (!items.length) return;
    if (fromButton) openMenuAt(e as unknown as Parameters<typeof openMenuAt>[0], items);
    else openMenu(e, items);
  };

  const now = new Date();
  const actions = useRef({ toggle, openLink, rowClick, rowMenu, recur: (t: Task) => setDialog({ kind: "recur", tasks: [t] }) });
  actions.current = { toggle, openLink, rowClick, rowMenu, recur: (t: Task) => setDialog({ kind: "recur", tasks: [t] }) };
  const groups = useMemo(() => {
    const today = new Date();
    return TASK_GROUPS.map((g) => ({ ...g, tasks: (list ?? []).filter((t) => taskGroup(t.due, today) === g.id) })).filter((g) => g.tasks.length);
  }, [list]);
  const open = list?.filter((t) => !t.done).length ?? 0;
  // The rows in the order shown (for Shift ranges, Ctrl+A and the arrows).
  const order = useMemo(() => groups.flatMap((g) => g.tasks.map(key)), [groups]);
  const byKey = useMemo(() => new Map((list ?? []).map((t) => [key(t), t])), [list]);
  const selected = useMemo(() => order.filter((k) => sel.has(k)).map((k) => byKey.get(k)!), [order, sel, byKey]);
  // Rows that left the list leave the selection.
  useEffect(() => {
    setSel((cur) => {
      const next = new Set([...cur].filter((k) => byKey.has(k)));
      return next.size === cur.size ? cur : next;
    });
  }, [byKey]);
  const endSelection = () => {
    setSelecting(false);
    setSel(new Set());
    anchor.current = null;
  };
  const toggleSelect = (t: Task, range: boolean) => {
    const k = key(t);
    setSel((cur) => selectClick(cur, order, k, anchor.current, range));
    if (!range) anchor.current = k;
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.matches("input:not([type=checkbox]), textarea, select, [contenteditable=true]");
    if (typing || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "a" && order.length) {
      e.preventDefault();
      setSelecting(true);
      setSel(new Set(order));
      return;
    }
    if (e.key === "Escape" && selecting && !document.querySelector(".menu, .dialog")) {
      e.preventDefault();
      endSelection();
      return;
    }
    const li = target.closest<HTMLElement>(".task-row[data-page]");
    if (!li) return;
    const k = `${li.dataset.page}:${li.dataset.ordinal}`;
    const t = byKey.get(k);
    if ((e.key === "Delete" || (e.key === "Backspace" && mod)) && selecting && selected.length) {
      e.preventDefault();
      void remove(selected);
    } else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && t) {
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const items = menuFor(t, () => li);
      if (items.length) openMenu({ clientX: r.left + 40, clientY: r.top + r.height / 2 }, items);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const rows = [...(scroller.current?.querySelectorAll<HTMLElement>(".task-row[data-page]") ?? [])];
      const i = rows.indexOf(li);
      const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      e.preventDefault();
      rowFocus(next)?.focus();
      if (e.shiftKey) {
        const nk = `${next.dataset.page}:${next.dataset.ordinal}`;
        setSelecting(true);
        setSel((cur) => new Set(cur).add(k).add(nk));
        anchor.current ??= k;
      }
    } else if (e.key === "x" && !mod && t && selecting) {
      e.preventDefault();
      toggleSelect(t, false);
    }
  };

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
    <div className="view-scroll" ref={scroller} onKeyDown={onKeyDown}>
      <div className="view narrow tasks-view">
        <header className="view-header">
          <div>
            <h1>{tr("tasks.title")}</h1>
            <div className="view-sub">{list ? tr("tasks.sub", { open, n: list.length }) : ""}</div>
          </div>
          <div className="view-actions">
            <Button
              variant={selecting ? "secondary" : "ghost"}
              icon={SquareDashedMousePointer}
              className="tasks-select-toggle"
              aria-pressed={selecting}
              title={tr("tasks.selectHint")}
              disabled={!list?.length}
              onClick={() => (selecting ? endSelection() : setSelecting(true))}
            >
              {tr("tasks.select")}
            </Button>
            <Segmented value={status} options={STATUS} onChange={setStatus} label={tr("tasks.statusFilter")} />
            <Select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={tr("tasks.tag")}>
              <option value="">{tr("tasks.allTags")}</option>
              {tags.map(([t]) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </Select>
          </div>
        </header>
        <div className="sr-only" role="status" aria-live="polite">
          {selecting ? tr("tasks.selected", { n: sel.size }) : ""}
        </div>
        {selecting && list && list.length > 0 && (
          <div className="task-bulk" role="toolbar" aria-label={tr("tasks.bulkBar")}>
            <div className="task-bulk-head">
              <span className="task-bulk-count num">{tr("tasks.selectedShort", { n: sel.size })}</span>
              <div className="task-bulk-end">
                <Button size="sm" variant="ghost" icon={CheckCheck} disabled={sel.size === order.length} onClick={() => setSel(new Set(order))}>
                  {tr("tasks.selectAll")}
                </Button>
                <IconButton icon={X} size="sm" label={tr("tasks.selectNone")} onClick={endSelection} />
              </div>
            </div>
            <div className="task-bulk-actions">
              {selected.length > 0 && selected.every((t) => t.done) ? (
                <Button size="sm" icon={RotateCcw} onClick={() => void setDone(selected, false)}>
                  {tr("tasks.act.reopen")}
                </Button>
              ) : (
                <Button size="sm" icon={Check} disabled={!selected.length} onClick={() => void setDone(selected, true)}>
                  {tr("tasks.act.done")}
                </Button>
              )}
              <Button size="sm" icon={CalendarClock} disabled={!selected.length} aria-haspopup="menu" onClick={(e) => openMenuAt(e, dueItems(selected, () => document.querySelector(".task-bulk-due")))} className="task-bulk-due">
                {tr("tasks.act.due")}
                <ChevronDown size={12} aria-hidden className="task-bulk-caret" />
              </Button>
              <Button size="sm" icon={Flag} disabled={!selected.length} aria-haspopup="menu" onClick={(e) => openMenuAt(e, prioItems(selected))}>
                {tr("tasks.act.priority")}
                <ChevronDown size={12} aria-hidden className="task-bulk-caret" />
              </Button>
              <Button size="sm" icon={Repeat} disabled={!selected.length} onClick={() => setDialog({ kind: "recur", tasks: selected })}>
                {tr("tasks.act.recur")}
              </Button>
              <Button size="sm" icon={FileInput} disabled={!selected.length} onClick={() => setDialog({ kind: "move", tasks: selected })} title={tr("tasks.act.move")}>
                {tr("tasks.act.moveShort")}
              </Button>
              <Button size="sm" variant="ghost" icon={Trash2} className="task-bulk-delete" disabled={!selected.length} onClick={() => void remove(selected)}>
                {tr("tasks.act.delete")}
              </Button>
            </div>
          </div>
        )}
        {!list ? (
          <Skeleton />
        ) : list.length === 0 ? (
          <EmptyState icon={ListChecks} title={status === "done" ? tr("tasks.noneDone") : tr("tasks.noneOpen")}>
            <span className="tasks-help">
              {tr("tasks.help1")} <code>{tr("tasks.helpExample")}</code>
            </span>
            <span className="tasks-help-syntax">
              {tr("tasks.helpDue")} <code>{tr("tasks.helpDueExample")}</code> · {tr("tasks.helpPrio")} <code>!!</code> {tr("tasks.prioHigh")}, <code>!</code> {tr("tasks.prioMedium")} · {tr("tasks.helpRecur")} <code>{tr("tasks.helpRecurExample")}</code>
            </span>
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
                        <TaskRow key={key(t)} task={t} group={g.id} busy={busy.has(key(t))} year={now.getFullYear()} act={actions} selecting={selecting} selected={sel.has(key(t))} onSelect={toggleSelect} />
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
      {menu}
      {dialog?.kind === "recur" && <RecurDialog tasks={dialog.tasks} onClose={() => setDialog(null)} onSave={(r) => void setRecur(dialog.tasks, r)} />}
      {dialog?.kind === "move" && (
        <TaskMoveDialog
          count={dialog.tasks.length}
          exclude={dialog.tasks.length && dialog.tasks.every((t) => t.page_id === dialog.tasks[0].page_id) ? [dialog.tasks[0].page_id] : []}
          onClose={() => setDialog(null)}
          onPick={(id, title) => void moveTo(dialog.tasks, id, title)}
        />
      )}
    </div>
  );
}

const planItem = (t: Task): PlanItem => ({ kind: "task", page_id: t.page_id, ordinal: t.ordinal, text: t.text, page_title: t.page_title });

interface TaskActions {
  toggle: (t: Task) => void;
  openLink: (target: string, newTab: boolean) => void;
  rowClick: (e: ReactMouseEvent, t: Task) => void;
  rowMenu: (e: ReactMouseEvent, t: Task, fromButton?: boolean) => void;
  recur: (t: Task) => void;
}

const TaskRow = memo(function TaskRow({
  task: t,
  group,
  busy,
  year,
  act,
  selecting,
  selected,
  onSelect,
}: {
  task: Task;
  group: string;
  busy: boolean;
  year: number;
  act: { current: TaskActions };
  selecting: boolean;
  selected: boolean;
  onSelect: (t: Task, range: boolean) => void;
}) {
  useT();
  const s = useApp.getState;
  const overdue = !t.done && group === "overdue";
  const recur = t.recur ? recurLabel(t.recur) : "";
  return (
    <li
      className={`task-row ${t.done ? "done" : ""} ${selected ? "selected" : ""}`}
      data-page={t.page_id}
      data-ordinal={t.ordinal}
      // Drag into the Kalender to plan it (open tasks only).
      draggable={!t.done && !selecting}
      onDragStart={(e) => setPlanData(e.dataTransfer, planItem(t))}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("input, button, a, [role=link]")) return;
        act.current.rowClick(e, t);
      }}
      onMouseDown={(e) => e.shiftKey && !(e.target as HTMLElement).closest("input, button") && e.preventDefault()}
      onContextMenu={(e) => act.current.rowMenu(e, t)}
    >
      {selecting && (
        <input
          type="checkbox"
          className="task-select"
          checked={selected}
          // The click (also Space) toggles, with Shift a range; the box shows the selection state.
          onClick={(e) => onSelect(t, e.shiftKey)}
          onChange={() => {}}
          aria-label={tr("tasks.selectTask", { text: t.text })}
        />
      )}
      <input
        type="checkbox"
        className="task-check"
        checked={t.done}
        aria-disabled={busy}
        onChange={() => !busy && act.current.toggle(t)}
        aria-label={t.done ? tr("tasks.reopen", { text: t.text }) : tr("tasks.complete", { text: t.text })}
      />
      <div className="task-main">
        <span className="task-text">
          {t.priority === 2 && <ChevronsUp size={14} strokeWidth={2.25} className="task-prio high" aria-label={tr("tasks.prioHighLabel")} />}
          {t.priority === 1 && <ChevronUp size={14} strokeWidth={2.25} className="task-prio medium" aria-label={tr("tasks.prioMediumLabel")} />}
          {taskSegments(t.text).map((seg, i) =>
            seg.kind === "link" ? (
              <span key={i} className="wikilink" data-target={seg.target} role="link" tabIndex={0} onClick={(e) => act.current.openLink(seg.target, e.ctrlKey || e.metaKey)} onKeyDown={(e) => e.key === "Enter" && act.current.openLink(seg.target, false)}>
                {seg.text}
              </span>
            ) : seg.kind === "mail" ? (
              <button key={i} type="button" className="mail-chip" title={tr("tasks.openMail", { text: seg.text })} onClick={() => void openMailLink(seg.id)}>
                <Mail size={12} strokeWidth={2} aria-hidden />
                <span>{tr("tasks.mail")}</span>
              </button>
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
          {recur && (
            <button type="button" className="task-recur" title={tr("tasks.recur.aria", { label: recur })} aria-label={tr("tasks.recur.aria", { label: recur })} onClick={() => act.current.recur(t)}>
              <Repeat size={12} aria-hidden />
              <span className="task-recur-label">{recur}</span>
            </button>
          )}
          {t.due && (
            <Badge tone={overdue ? "danger" : group === "today" && !t.done ? "warning" : "neutral"} title={overdue ? tr("tasks.overdue") : tr("tasks.due")}>
              <CalendarClock size={12} /> {dueLabel(t.due, year)}
            </Badge>
          )}
          {!t.done && <IconButton icon={CalendarPlus} size="sm" className="task-plan" label={tr("blocks.plan")} onClick={() => openPlanPicker(planItem(t))} />}
          <button type="button" className="task-page" onClick={(e) => s().openPage(t.page_id, { newTab: e.ctrlKey || e.metaKey })} title={tr("tasks.openPage", { title: t.page_title })}>
            <PageIcon name={t.page_icon} size={13} />
            <span className="task-page-label">{t.page_title}</span>
          </button>
          <IconButton icon={MoreHorizontal} size="sm" className="task-more" label={tr("tasks.more", { text: t.text })} aria-haspopup="menu" onClick={(e) => act.current.rowMenu(e, t, true)} />
        </span>
      </div>
    </li>
  );
});
