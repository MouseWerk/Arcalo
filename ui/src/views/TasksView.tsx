// Tasks across all notes (`- [ ] …`), grouped by due date. Toggling rewrites the
// checkbox in the page's Markdown; open editors of that page reload via data://tasks.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, ChevronUp, ChevronsUp, ListChecks } from "lucide-react";
import { api } from "../lib/api";
import { useApp } from "../store/app";
import { Badge, EmptyState, Segmented, Select, Spinner } from "../components/ui";
import { PageIcon } from "../components/icons";
import { flushAllEditors } from "../editor/NoteEditor";
import { TASK_GROUPS, taskGroup, taskSegments } from "../lib/tasks";
import type { Task, TaskStatus } from "../lib/types";

const STATUS: { value: TaskStatus; label: string }[] = [
  { value: "open", label: "Offen" },
  { value: "done", label: "Erledigt" },
  { value: "all", label: "Alle" },
];

const key = (t: Task) => `${t.page_id}:${t.ordinal}`;

function dueLabel(due: string, now: Date) {
  const [y, m, d] = due.split("-");
  return `${d}.${m}.${Number(y) === now.getFullYear() ? "" : y}`;
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
  const groups = useMemo(() => {
    const today = new Date();
    return TASK_GROUPS.map((g) => ({ ...g, tasks: (list ?? []).filter((t) => taskGroup(t.due, today) === g.id) })).filter((g) => g.tasks.length);
  }, [list]);
  const open = list?.filter((t) => !t.done).length ?? 0;

  return (
    <div className="view-scroll">
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
            Aufgaben sind Listenpunkte wie <code>- [ ] Angebot senden 📅 2026-09-30 !!</code> in beliebigen Seiten. <code>!!</code> = hoch, <code>!</code> = mittel.
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.id} className={`task-group task-group-${g.id}`} aria-label={g.label}>
              <h2 className="task-group-title">
                {g.label} <span className="faint">{g.tasks.length}</span>
              </h2>
              <ul className="task-list">
                {g.tasks.map((t) => {
                  const overdue = !t.done && g.id === "overdue";
                  return (
                    <li key={key(t)} className={`task-row ${t.done ? "done" : ""}`} data-page={t.page_id} data-ordinal={t.ordinal}>
                      <input
                        type="checkbox"
                        className="task-check"
                        checked={t.done}
                        aria-disabled={busy.has(key(t))}
                        onChange={() => !busy.has(key(t)) && toggle(t)}
                        aria-label={t.done ? `„${t.text}“ wieder öffnen` : `„${t.text}“ erledigen`}
                      />
                      <div className="task-main">
                        <span className="task-text">
                          {t.priority === 2 && <ChevronsUp size={14} strokeWidth={2.25} className="task-prio high" aria-label="Priorität hoch" />}
                          {t.priority === 1 && <ChevronUp size={14} strokeWidth={2.25} className="task-prio medium" aria-label="Priorität mittel" />}
                          {taskSegments(t.text).map((seg, i) =>
                            seg.kind === "link" ? (
                              <span key={i} className="wikilink" data-target={seg.target} role="link" tabIndex={0} onClick={(e) => openLink(seg.target, e.ctrlKey || e.metaKey)} onKeyDown={(e) => e.key === "Enter" && openLink(seg.target, false)}>
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
                            <Badge tone={overdue ? "danger" : g.id === "today" && !t.done ? "warning" : "neutral"} title={overdue ? "Überfällig" : "Fällig"}>
                              <CalendarClock size={12} /> {dueLabel(t.due, now)}
                            </Badge>
                          )}
                          <button type="button" className="task-page" onClick={(e) => s().openPage(t.page_id, { newTab: e.ctrlKey || e.metaKey })} title={`${t.page_title} öffnen`}>
                            <PageIcon name={t.page_icon} size={13} />
                            {t.page_title}
                          </button>
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
