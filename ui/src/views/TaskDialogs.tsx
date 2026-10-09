// Dialogs of the task view: „Wiederholen“ (the repeat rule of one or many tasks) and „In Seite
// verschieben“ (tasks with their subtasks to the end of another page).

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dialog, Input, Segmented, Switch } from "../components/ui";
import { DateInput } from "../components/DateInput";
import { PageIcon } from "../components/icons";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import { fmtDayMonth, isoDay, addDays, weekdayLabels } from "../lib/format";
import { folderOptions, fuzzyScore } from "../lib/filing";
import { recurTokens } from "../lib/tasks";
import { t as tr, useT } from "../lib/i18n";
import type { Recurrence, Task } from "../lib/types";
import { isComposing, isKey } from "../lib/ime";

type Freq = "never" | Recurrence["unit"];

const UNIT_KEY = { day: "tasks.recur.unitDays", week: "tasks.recur.unitWeeks", month: "tasks.recur.unitMonths", year: "tasks.recur.unitYears" } as const;

/** „Wiederholen“: sets (or removes) the rule of `tasks`; `onSave` gets the rule, `null` for none. */
export function RecurDialog({ tasks, onClose, onSave }: { tasks: Task[]; onClose: () => void; onSave: (r: Recurrence | null) => void }) {
  useT();
  const first = tasks[0];
  const start = tasks.every((x) => JSON.stringify(x.recur ?? null) === JSON.stringify(first.recur ?? null)) ? first.recur : null;
  const [freq, setFreq] = useState<Freq>(start?.unit ?? "week");
  const [interval, setEvery] = useState(String(start?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(start?.weekdays ?? []);
  // Due on the 29th to 31st: the day is written into the rule, so a short month does not move
  // the later dates (`every:monthly,31`).
  const dueDay = Number(first.due?.slice(8) ?? 0);
  const [monthDay, setMonthDay] = useState(start?.month_day ? String(start.month_day) : !start && dueDay >= 29 ? String(dueDay) : "");
  const [whenDone, setWhenDone] = useState(start?.when_done ?? false);
  const [ends, setEnds] = useState(!!start?.until);
  const [until, setUntil] = useState(start?.until ?? isoDay(addDays(new Date(), 90)));
  const [preview, setPreview] = useState<string[] | null>(null);

  const n = Math.min(999, Math.max(1, Math.round(Number(interval)) || 1));
  const day = Math.round(Number(monthDay));
  const rule: Recurrence | null =
    freq === "never"
      ? null
      : {
          unit: freq,
          interval: n,
          weekdays: freq === "week" ? [...weekdays].sort((a, b) => a - b) : [],
          month_day: freq === "month" && day >= 1 && day <= 31 ? day : null,
          until: ends && until ? until : null,
          when_done: whenDone,
        };
  const key = JSON.stringify(rule);
  useEffect(() => {
    if (!rule) return setPreview(null);
    let alive = true;
    const id = window.setTimeout(() => {
      api.taskRecurPreview(rule, tasks.length === 1 ? first.due : null).then(
        (d) => alive && setPreview(d),
        () => alive && setPreview(null),
      );
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const names = weekdayLabels(1);
  const freqs: { value: Freq; label: string }[] = [
    { value: "never", label: tr("tasks.recur.never") },
    { value: "day", label: tr("tasks.recur.optDaily") },
    { value: "week", label: tr("tasks.recur.optWeekly") },
    { value: "month", label: tr("tasks.recur.optMonthly") },
    { value: "year", label: tr("tasks.recur.optYearly") },
  ];
  const save = () => {
    onClose();
    onSave(rule);
  };
  return (
    <Dialog
      open
      onClose={onClose}
      width={520}
      title={tr("tasks.recur.title")}
      description={tasks.length === 1 ? `„${first.text}“` : tr("tasks.recur.many", { n: tasks.length })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tr("common.cancel")}
          </Button>
          <Button variant="primary" onClick={save} data-testid="recur-save">
            {tr("common.save")}
          </Button>
        </>
      }
    >
      <div className="recur-form" onKeyDown={(e) => isKey(e, "Enter") && (e.target as HTMLElement).tagName === "INPUT" && (e.preventDefault(), save())}>
        <div className="recur-row" role="group" aria-labelledby="recur-freq-label">
          <span className="field-label" id="recur-freq-label">
            {tr("tasks.recur.freq")}
          </span>
          <Segmented value={freq} options={freqs} onChange={setFreq} label={tr("tasks.recur.freq")} />
        </div>
        {rule && (
          <>
            <div className="recur-row">
              <label className="field-label" htmlFor="recur-interval">
                {tr("tasks.recur.interval")}
              </label>
              <div className="recur-inline">
                <Input id="recur-interval" className="recur-num" type="number" min={1} max={999} value={interval} onChange={(e) => setEvery(e.target.value)} />
                <span>{tr(UNIT_KEY[rule.unit], { n })}</span>
              </div>
            </div>
            {rule.unit === "week" && (
              <div className="recur-row" role="group" aria-labelledby="recur-days-label">
                <span className="field-label" id="recur-days-label">
                  {tr("tasks.recur.weekdays")}
                </span>
                <div className="recur-days">
                  {names.map((name, d) => (
                    <button
                      key={d}
                      type="button"
                      className={`recur-day ${weekdays.includes(d) ? "on" : ""}`}
                      aria-pressed={weekdays.includes(d)}
                      onClick={() => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d]))}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <span className="field-hint">{tr("tasks.recur.weekdaysHint")}</span>
              </div>
            )}
            {rule.unit === "month" && (
              <div className="recur-row">
                <label className="field-label" htmlFor="recur-day">
                  {tr("tasks.recur.monthDay")}
                </label>
                <Input id="recur-day" className="recur-num" type="number" min={1} max={31} value={monthDay} onChange={(e) => setMonthDay(e.target.value)} />
                <span className="field-hint">{tr("tasks.recur.monthDayHint")}</span>
              </div>
            )}
            <div className="recur-row" role="group" aria-labelledby="recur-from-label">
              <span className="field-label" id="recur-from-label">
                {tr("tasks.recur.from")}
              </span>
              <Segmented
                value={whenDone ? "done" : "due"}
                options={[
                  { value: "due", label: tr("tasks.recur.fromDue") },
                  { value: "done", label: tr("tasks.recur.fromDone") },
                ]}
                onChange={(v) => setWhenDone(v === "done")}
                label={tr("tasks.recur.from")}
              />
              <span className="field-hint">{tr("tasks.recur.fromHint")}</span>
            </div>
            <div className="recur-row">
              <span className="field-label">{tr("tasks.recur.ends")}</span>
              <div className="recur-inline">
                <Switch checked={ends} onChange={setEnds} label={tr("tasks.recur.ends")} />
                {ends ? <DateInput value={until} onChange={setUntil} aria-label={tr("tasks.recur.ends")} /> : <span className="faint">{tr("tasks.recur.endsNever")}</span>}
              </div>
            </div>
            <div className="recur-preview" aria-live="polite">
              {preview == null ? " " : preview.length ? tr("tasks.recur.preview", { dates: preview.map((d) => fmtDayMonth(new Date(`${d}T12:00:00`))).join(", ") }) : tr("tasks.recur.previewEnded")}
            </div>
          </>
        )}
        <p className="recur-syntax field-hint">
          {tr("tasks.recur.syntax", { example: "\u0000" })
            .split("\u0000")
            .flatMap((part, i) => (i ? [<code key={i}>{rule ? recurTokens(rule) : tr("tasks.helpRecurExample")}</code>, part] : [part]))}
        </p>
      </div>
    </Dialog>
  );
}

/** „In Seite verschieben“: picks the page the tasks go to (fuzzy search over all pages). */
export function TaskMoveDialog({ count, exclude, onClose, onPick }: { count: number; exclude: number[]; onClose: () => void; onPick: (pageId: number, title: string) => void }) {
  useT();
  const tree = useApp((st) => st.tree);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  // Pages made elsewhere (the assistant, a sync) since the tree was read are targets too.
  useEffect(() => void useApp.getState().refreshTree(), []);
  const options = useMemo(() => folderOptions(tree).filter((o) => o.id != null && !exclude.includes(o.id)), [tree, exclude]);
  const hits = useMemo(() => {
    if (!q.trim()) return options.slice(0, 50);
    return options
      .map((o) => {
        const title = fuzzyScore(q, o.title);
        return { o, s: Math.max(title < 0 ? -1 : title + 5, fuzzyScore(q, o.path)) };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 50)
      .map((x) => x.o);
  }, [options, q]);
  useEffect(() => setCursor(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".move-opt.cursor")?.scrollIntoView({ block: "nearest" });
  }, [cursor]);
  const choose = (i: number) => {
    const o = hits[i];
    if (o?.id == null) return;
    onClose();
    onPick(o.id, o.title);
  };
  return (
    <Dialog open onClose={onClose} width={520} title={tr("tasks.move.title")} description={tr("tasks.move.desc", { n: count })}>
      <Input
        className="move-search"
        value={q}
        placeholder={tr("tasks.move.search")}
        aria-label={tr("tasks.move.search")}
        aria-controls="task-move-targets"
        aria-activedescendant={hits[cursor]?.id != null ? `task-move-${hits[cursor].id}` : undefined}
        data-autofocus
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (isComposing(e)) return;
          if (e.key === "ArrowDown") (e.preventDefault(), setCursor((c) => Math.min(c + 1, hits.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setCursor((c) => Math.max(c - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), choose(cursor));
        }}
      />
      <div className="move-list" role="listbox" id="task-move-targets" aria-label={tr("tasks.move.targets")} ref={list}>
        {hits.map((o, i) => (
          <div
            key={o.id}
            id={`task-move-${o.id}`}
            role="option"
            aria-selected={i === cursor}
            className={`move-opt ${i === cursor ? "cursor" : ""}`}
            data-id={o.id ?? ""}
            onMouseEnter={() => setCursor(i)}
            onClick={() => choose(i)}
          >
            <PageIcon name={o.icon} size={15} className="move-icon" />
            <span className="move-title">{o.title}</span>
            {o.depth > 0 && <span className="move-path">{o.path.slice(0, o.path.length - o.title.length - 3)}</span>}
          </div>
        ))}
        {hits.length === 0 && <div className="move-empty">{tr("tasks.move.none")}</div>}
      </div>
    </Dialog>
  );
}
