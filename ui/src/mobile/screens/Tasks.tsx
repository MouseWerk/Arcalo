// „Aufgaben“: open tasks grouped by due date like the desktop's task view, ticked off with one
// tap (a repeating task gets its next date in the note, as on the desktop).

import { useEffect, useState } from "react";
import { Check, ListChecks, Plus, Repeat } from "lucide-react";
import { api } from "../../lib/api";
import { addDays, fmtDate, isoDay } from "../../lib/format";
import { t } from "../../lib/i18n";
import { recurLabel, taskSegments, TASK_GROUPS } from "../../lib/tasks";
import type { Task } from "../../lib/types";
import { errorText, useMobile } from "../context";
import { noonOf, taskSections, type TaskFilter } from "../model";
import { Empty, Header, Segmented, Spinner } from "../ui";

export function TasksScreen() {
  const m = useMobile();
  const [filter, setFilter] = useState<TaskFilter>("open");
  const [tasks, setTasks] = useState<Task[] | null>(null);

  useEffect(() => {
    let live = true;
    const since = isoDay(addDays(new Date(), -14));
    const req = filter === "done" ? api.tasks({ status: "done", changed_since: since }) : api.tasks({ status: "open" });
    req.then((list) => live && setTasks(list)).catch((e) => m.toast("error", errorText(e)));
    return () => {
      live = false;
    };
  }, [filter, m.version]); // eslint-disable-line react-hooks/exhaustive-deps

  const sections = tasks ? taskSections(tasks, filter) : [];
  const groupLabel = (g: string) => TASK_GROUPS.find((x) => x.id === g)?.label ?? "";
  const emptyText = filter === "done" ? t("mob.tasks.emptyDone") : filter === "due" ? t("mob.tasks.emptyDue") : t("mob.tasks.empty");
  return (
    <div className="m-screen">
      <Header
        title={t("mob.tasks.title")}
        actions={
          <button type="button" className="m-icon-btn" onClick={() => m.open({ kind: "capture", mode: "task" })} aria-label={t("mob.tasks.add")}>
            <Plus size={22} />
          </button>
        }
      />
      <div className="m-toolbar">
        <Segmented
          label={t("mob.tasks.filter")}
          value={filter}
          onChange={setFilter}
          options={[
            { value: "open", label: t("mob.tasks.open") },
            { value: "due", label: t("mob.tasks.dueSoon") },
            { value: "done", label: t("mob.tasks.done") },
          ]}
        />
      </div>
      <div className="m-scroll">
        {!tasks ? (
          <div className="m-loading">
            <Spinner />
          </div>
        ) : sections.length === 0 ? (
          <Empty icon={<ListChecks size={28} />} text={emptyText} />
        ) : (
          sections.map((s) => (
            <section key={s.group} className="m-section">
              {filter !== "done" && (
                <div className="m-section-head">
                  <h2 className={s.group === "overdue" ? "m-section-title m-overdue" : "m-section-title"}>{groupLabel(s.group)}</h2>
                  <span className="m-section-aside num">{s.tasks.length}</span>
                </div>
              )}
              <ul className="m-card m-card-flush m-list">
                {s.tasks.map((task) => (
                  <TaskRow key={`${task.page_id}:${task.ordinal}:${task.text}`} task={task} showPage />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** One task: the check button (44 px), its text with links and tags, due date, page, rule. */
export function TaskRow({ task, showPage = true }: { task: Task; showPage?: boolean }) {
  const m = useMobile();
  const [done, setDone] = useState(task.done);
  const [busy, setBusy] = useState(false);
  const today = isoDay(new Date());
  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    const next = !done;
    setDone(next);
    try {
      const nextDue = next && task.recur ? await api.taskNextDue(task.text).catch(() => null) : null;
      await api.setTaskDone(task.page_id, task.ordinal, next, task.text);
      m.toast("success", nextDue ? t("mob.tasks.nextToast", { date: fmtDate(noonOf(nextDue)) }) : next ? t("mob.tasks.doneToast") : t("mob.tasks.open"));
      window.setTimeout(() => m.refresh(), 600);
    } catch (e) {
      setDone(!next);
      m.toast("error", t("mob.tasks.failed"), errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const overdue = !!task.due && task.due < today && !done;
  return (
    <li className={done ? "m-task done" : "m-task"}>
      <button type="button" className="m-check-hit" role="checkbox" aria-checked={done} aria-label={done ? t("mob.tasks.uncheck") : t("mob.tasks.check")} onClick={() => void toggle()}>
        <span className={done ? "m-task-check on" : "m-task-check"}>{done && <Check size={14} strokeWidth={3} />}</span>
      </button>
      <button type="button" className="m-task-body" onClick={() => m.open({ kind: "page", id: task.page_id })}>
        <span className="m-task-text">
          {taskSegments(task.text).map((s, i) =>
            s.kind === "text" ? (
              <span key={i}>{s.text}</span>
            ) : (
              <span key={i} className={s.kind === "tag" ? "m-tag" : "m-link"}>
                {s.text}
              </span>
            ),
          )}
        </span>
        <span className="m-task-meta">
          {task.due && <span className={overdue ? "m-overdue" : undefined}>{task.due === today ? t("mob.daily.today") : fmtDate(noonOf(task.due))}</span>}
          {task.recur && (
            <span className="m-task-recur">
              <Repeat size={12} />
              {recurLabel(task.recur)}
            </span>
          )}
          {showPage && <span className="m-task-page">{task.page_title}</span>}
        </span>
      </button>
    </li>
  );
}
