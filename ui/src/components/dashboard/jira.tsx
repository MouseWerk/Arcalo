// Jira widgets of the start page: „Meine Issues“ (the default search), „Jira-Suche“ (one saved
// JQL search each; title, columns and count are its settings) and „Sprint“ (the active sprint
// with a small burndown; without Agile it says so quietly). Their settings fields are here too,
// so the widget framework only needs to know the kinds.

import { useCallback, useEffect, useState } from "react";
import { Settings2, Ticket } from "lucide-react";
import { on } from "../../lib/api";
import { configOf } from "../../lib/dashboard";
import { fmtDate, isoDay } from "../../lib/format";
import { t, type TKey } from "../../lib/i18n";
import { burndownPaths, columnsOf, JIRA_COLUMNS, jiraApi, overdue, type Issue, type JiraColumn, type SprintView } from "../../lib/jira";
import { openIssue } from "../../lib/jiraActions";
import { setPlanData } from "../../lib/blocks";
import { openSettingsSection } from "../../lib/calnav";
import { useApp } from "../../store/app";

const NO_QUERIES: never[] = [];
import { Button, Input, Select } from "../ui";
import { TYPE_SVG, typeOf } from "../../lib/issueTypes";
import { Empty, Loadable, More, s } from "./common";
import type { WidgetProps } from "./registry";

type Config = Record<string, unknown>;

/** Cached issues of a search, reloaded after every sync. */
function useIssues(query: string, site: string, limit: number) {
  const [state, setState] = useState<{ list: Issue[] | null; error?: string }>({ list: null });
  const load = useCallback(() => {
    jiraApi.issues({ query, site }).then(
      (list) => setState({ list }),
      (e) => setState({ list: [], error: String(e) }),
    );
  }, [query, site]);
  useEffect(() => {
    load();
    const off = on("jira://synced", load);
    return () => void off.then((f) => f());
  }, [load]);
  return { ...state, shown: state.list?.slice(0, limit) ?? [] };
}

function Cell({ issue, col, today }: { issue: Issue; col: JiraColumn; today: string }) {
  switch (col) {
    case "status":
      return <span className={`issue-status cat-${issue.status_category}`}>{issue.status}</span>;
    case "priority":
      return issue.priority ? <span className={`issue-prio prio-${issue.priority.toLowerCase()}`}>{issue.priority}</span> : null;
    case "assignee":
      return issue.assignee ? <span className="faint ellipsis dwj-assignee">{issue.assignee}</span> : null;
    case "due":
      return issue.due_date ? <span className={`issue-due ${overdue(issue, today) ? "overdue" : ""}`}>{fmtDate(issue.due_date)}</span> : null;
    case "type":
      return <span className="faint">{issue.issue_type}</span>;
    case "sprint":
      return issue.sprint ? <span className="faint ellipsis">{issue.sprint}</span> : null;
  }
}

function IssueRows({ issues, columns }: { issues: Issue[]; columns: JiraColumn[] }) {
  const today = isoDay(new Date());
  return (
    <ul className="dw-list dwj-list">
      {issues.map((i) => {
        const kind = typeOf(i.issue_type);
        return (
          <li key={`${i.site}:${i.key}`}>
            <button type="button" className="dw-row dwj-row" data-issue-row={i.key} title={`${i.key} ${i.summary}`} draggable onDragStart={(e) => setPlanData(e.dataTransfer, { kind: "issue", key: i.key, summary: i.summary })} onClick={(e) => void openIssue(i.key, { browser: e.ctrlKey || e.metaKey, newTab: e.shiftKey })}>
              <span className={`issue-type-icon issue-type-${kind}`} dangerouslySetInnerHTML={{ __html: TYPE_SVG[kind] }} aria-hidden />
              <span className="mono dwj-key">{i.key}</span>
              <span className="grow ellipsis">{i.summary}</span>
              <span className="dwj-cells">
                {columns.map((c) => (
                  <Cell key={c} issue={i} col={c} today={today} />
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function NoSite() {
  return (
    <Empty
      icon={Ticket}
      action={
        <Button size="sm" icon={Settings2} onClick={() => openSettingsSection("jira")}>
          {t("jira.setUp")}
        </Button>
      }
    >
      {t("jira.w.noSite")}
    </Empty>
  );
}

const hasSites = () => (useApp.getState().settings?.settings.jira?.sites.length ?? 0) > 0;

export function JiraMineWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const limit = Number(c.limit ?? 8);
  const { list, error, shown } = useIssues("mine", String(c.site ?? ""), limit);
  useApp((st) => st.settings?.settings.jira?.sites.length);
  if (!hasSites()) return <NoSite />;
  return (
    <Loadable loading={!list} error={error}>
      {() =>
        shown.length ? (
          <>
            <IssueRows issues={shown} columns={columnsOf(c.columns, ["status"])} />
            {list!.length > shown.length && <More n={list!.length - shown.length} onClick={() => s().openTab({ kind: "issues" })} />}
          </>
        ) : (
          <Empty icon={Ticket}>{t("jira.w.mineEmpty")}</Empty>
        )
      }
    </Loadable>
  );
}

export function JiraQueryWidget({ widget, openSettings }: WidgetProps) {
  const c = configOf(widget);
  const queries = useApp((st) => st.settings?.settings.jira?.queries ?? NO_QUERIES);
  const query = queries.find((q) => q.id === c.query);
  const limit = Number(c.limit ?? 8);
  const { list, error, shown } = useIssues(query?.id ?? "-", "", limit);
  if (!hasSites()) return <NoSite />;
  if (!query)
    return (
      <Empty icon={Ticket} action={<Button size="sm" onClick={openSettings}>{t("jira.w.pickQuery")}</Button>}>
        {queries.length ? t("jira.w.noQuery") : t("jira.w.noQueries")}
      </Empty>
    );
  return (
    <Loadable loading={!list} error={error}>
      {() =>
        shown.length ? (
          <>
            <IssueRows issues={shown} columns={columnsOf(c.columns, ["status", "assignee"])} />
            {list!.length > shown.length && <More n={list!.length - shown.length} onClick={() => s().openTab({ kind: "issues" })} />}
          </>
        ) : (
          <Empty icon={Ticket}>{t("jira.w.queryEmpty")}</Empty>
        )
      }
    </Loadable>
  );
}

function Burndown({ view }: { view: SprintView }) {
  const W = 300;
  const H = 90;
  const p = burndownPaths(view.burndown, W, H);
  if (!p.actual && !p.ideal) return null;
  const first = view.burndown[0];
  const last = view.burndown[view.burndown.length - 1];
  return (
    <figure className="dwj-burn" aria-label={t("jira.w.burndown")}>
      <svg viewBox={`-4 -4 ${W + 8} ${H + 8}`} preserveAspectRatio="none" role="img" aria-label={t("jira.w.burndown")}>
        <line x1={0} y1={H} x2={W} y2={H} className="dwj-axis" />
        <path d={p.ideal} className="dwj-ideal" vectorEffect="non-scaling-stroke" />
        {p.actual && <path d={p.actual} className="dwj-actual" vectorEffect="non-scaling-stroke" />}
        {p.today != null && <line x1={p.today} y1={0} x2={p.today} y2={H} className="dwj-today" vectorEffect="non-scaling-stroke" />}
      </svg>
      <figcaption className="dwj-burn-axis faint">
        <span>{fmtDate(first.date)}</span>
        <span className="dwj-legend">
          <i className="dwj-key-actual" /> {t("jira.w.open")} <i className="dwj-key-ideal" /> {t("jira.w.ideal")}
        </span>
        <span>{fmtDate(last.date)}</span>
      </figcaption>
    </figure>
  );
}

export function JiraSprintWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const [view, setView] = useState<SprintView | null>(null);
  const [error, setError] = useState<string>();
  const site = String(c.site ?? "");
  const project = String(c.project ?? "");
  const load = useCallback(() => {
    jiraApi.sprint(site || null, project || null).then(
      (v) => (setView(v), setError(undefined)),
      (e) => setError(String(e)),
    );
  }, [site, project]);
  useEffect(() => {
    load();
    const off = on("jira://synced", load);
    return () => void off.then((f) => f());
  }, [load]);
  if (!hasSites()) return <NoSite />;
  return (
    <Loadable loading={!view && !error} error={error}>
      {() => {
        const v = view!;
        const sp = v.sprint;
        if (!sp)
          return (
            <Empty icon={Ticket}>
              {v.error ? t("jira.w.sprintOffline") : v.available || !v.project ? t("jira.w.noSprint") : t("jira.w.noAgile", { project: v.project })}
            </Empty>
          );
        const done = sp.issues.filter((i) => i.status_category === "done").length;
        const open = sp.issues.filter((i) => i.status_category !== "done");
        const pct = sp.issues.length ? Math.round((done / sp.issues.length) * 100) : 0;
        return (
          <div className="dwj-sprint">
            <div className="dwj-sprint-head">
              <div className="dwj-sprint-name ellipsis" title={sp.goal || sp.name}>
                {sp.name}
              </div>
              <div className="faint small">
                {t("jira.w.sprintDone", { done, n: sp.issues.length, pct })}
                {sp.end && ` · ${t("jira.w.sprintEnds", { date: fmtDate(sp.end) })}`}
              </div>
              <div className="dwj-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t("jira.w.progress")}>
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
            {v.burndown.length > 1 && <Burndown view={v} />}
            {v.error && <div className="faint small dwj-stale">{t("jira.w.stale")}</div>}
            <IssueRows issues={open.slice(0, 12)} columns={["status", "assignee"]} />
          </div>
        );
      }}
    </Loadable>
  );
}

// ------------------------------------------------------------------ settings

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="dws-row">
      <div className="dws-label">
        <span>{label}</span>
      </div>
      <div className="dws-control">{children}</div>
    </div>
  );
}

function Columns({ value, onChange }: { value: JiraColumn[]; onChange: (v: JiraColumn[]) => void }) {
  return (
    <div className="dws-checks">
      {JIRA_COLUMNS.map((col) => (
        <label key={col} className="dws-check">
          <input type="checkbox" checked={value.includes(col)} onChange={(e) => onChange(e.target.checked ? JIRA_COLUMNS.filter((x) => x === col || value.includes(x)).slice(0, 4) : value.filter((x) => x !== col))} />
          <span>{t(`jira.col.${col}` as TKey)}</span>
        </label>
      ))}
    </div>
  );
}

/** The settings fields of the Jira widgets (WidgetSettings shows them below the name). */
export function JiraWidgetFields({ kind, c, set }: { kind: string; c: Config; set: (patch: Config) => void }) {
  const jira = useApp((st) => st.settings?.settings.jira);
  const sites = jira?.sites ?? [];
  const limit = (
    <Field label={t("dash.set.count")}>
      <Select aria-label={t("dash.set.count")} value={String(c.limit ?? 8)} onChange={(e) => set({ limit: Number(e.target.value) })} options={[3, 5, 8, 10, 15, 20].map((n) => ({ value: String(n), label: String(n) }))} />
    </Field>
  );
  const siteField = sites.length > 1 && (
    <Field label={t("jira.f.site")}>
      <Select aria-label={t("jira.f.site")} value={String(c.site ?? "")} onChange={(e) => set({ site: e.target.value })} options={[{ value: "", label: t("jira.w.allSites") }, ...sites.map((x) => ({ value: x.id, label: x.name }))]} />
    </Field>
  );
  switch (kind) {
    case "jira":
      return (
        <>
          {siteField}
          <Field label={t("jira.w.columns")}>
            <Columns value={columnsOf(c.columns, ["status"])} onChange={(columns) => set({ columns })} />
          </Field>
          {limit}
        </>
      );
    case "jira_query":
      return (
        <>
          <Field label={t("jira.w.query")}>
            <Select
              aria-label={t("jira.w.query")}
              value={String(c.query ?? "")}
              onChange={(e) => set({ query: e.target.value })}
              options={[{ value: "", label: t("jira.w.pickQuery") }, ...(jira?.queries ?? []).map((q) => ({ value: q.id, label: q.name }))]}
            />
          </Field>
          <Field label={t("jira.w.columns")}>
            <Columns value={columnsOf(c.columns, ["status", "assignee"])} onChange={(columns) => set({ columns })} />
          </Field>
          {limit}
        </>
      );
    case "jira_sprint":
      return (
        <>
          {siteField}
          <Field label={t("jira.f.project")}>
            <Input value={String(c.project ?? "")} aria-label={t("jira.f.project")} placeholder={t("jira.w.projectAuto")} className="mono" onChange={(e) => set({ project: e.target.value.trim().toUpperCase() })} />
          </Field>
        </>
      );
    default:
      return null;
  }
}
