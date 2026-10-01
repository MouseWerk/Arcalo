// Issues: the Jira issues of every site (my open issues and the saved JQL searches), read from
// the offline cache, filterable by site, project, status, sprint and priority, grouped, and
// searchable. A row opens the issue: description, last comments, the pages that name it, its WBS.

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, Copy, ExternalLink, FileText, ListPlus, MoreHorizontal, RefreshCw, Search, Settings2, Ticket, WifiOff } from "lucide-react";
import { on } from "../lib/api";
import { useApp } from "../store/app";

const NO_QUERIES: never[] = [];
import { Badge, Button, EmptyState, IconButton, Input, Select, Spinner, useMenu, type MenuEntry } from "../components/ui";
import { PageIcon } from "../components/icons";
import { fmtDate, fmtMinutes, isoDay, relative } from "../lib/format";
import { t, useT, type TKey } from "../lib/i18n";
import { emptyIssueQuery, filterIssues, GROUP_BYS, groupIssues, jiraApi, overdue, valuesOf, type GroupBy, type Issue, type IssueQuery, type IssueView, type JiraStatus } from "../lib/jira";
import { addIssueTask, copyIssueKey, openIssueInBrowser, openIssueNote } from "../lib/jiraActions";
import { openSettingsSection } from "../lib/calnav";
import { TYPE_SVG, typeOf } from "../editor/issueChips";
import { useTimeTracking } from "../lib/timetracking";

const PREF = "annalo.issues.view";
interface ViewPref {
  group: GroupBy;
  search: string;
}
function loadPref(): ViewPref {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) ?? "{}");
    return { group: GROUP_BYS.includes(v.group) ? v.group : "project", search: typeof v.search === "string" ? v.search : "mine" };
  } catch {
    return { group: "project", search: "mine" };
  }
}

export function TypeIcon({ type }: { type: string }) {
  const kind = typeOf(type);
  return <span className={`issue-type-icon issue-type-${kind}`} title={type} dangerouslySetInnerHTML={{ __html: TYPE_SVG[kind] }} />;
}

export function StatusPill({ issue }: { issue: Pick<Issue, "status" | "status_category"> }) {
  return <span className={`issue-status cat-${issue.status_category}`}>{issue.status}</span>;
}

export function issueMenu(i: Issue): MenuEntry[] {
  return [
    { label: t("jira.openNote"), icon: FileText, onSelect: () => void openIssueNote(i.key) },
    { label: t("jira.openBrowser"), icon: ExternalLink, onSelect: () => void openIssueInBrowser(i.key, i.url) },
    { label: t("jira.copyKey"), icon: Copy, onSelect: () => void copyIssueKey(i.key) },
    "separator",
    { label: t("jira.addTask"), icon: ListPlus, onSelect: () => void addIssueTask(i.key) },
  ];
}

export function IssuesView() {
  useT();
  const s = useApp.getState;
  const [status, setStatus] = useState<JiraStatus | null>(null);
  const [list, setList] = useState<Issue[] | null>(null);
  const [pref, setPrefState] = useState(loadPref);
  const [q, setQ] = useState<IssueQuery>(emptyIssueQuery);
  const [open, setOpen] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [menu, , openMenuAt] = useMenu();
  const queries = useApp((st) => st.settings?.settings.jira?.queries ?? NO_QUERIES);

  const setPref = (p: Partial<ViewPref>) =>
    setPrefState((old) => {
      const next = { ...old, ...p };
      try {
        localStorage.setItem(PREF, JSON.stringify(next));
      } catch {
        /* not kept */
      }
      return next;
    });

  const load = useCallback(() => {
    jiraApi.status().then(setStatus, () => {});
    jiraApi
      .issues({ query: pref.search === "all" ? "" : pref.search })
      .then(setList)
      .catch((e) => (setList([]), s().error(t("jira.loadFailed"), e)));
  }, [pref.search, s]);

  useEffect(() => {
    load();
    const offs = [on("jira://synced", load), on("jira://syncing", () => jiraApi.status().then(setStatus, () => {}))];
    return () => offs.forEach((u) => u.then((f) => f()));
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    try {
      setStatus(await jiraApi.syncNow());
      load();
    } catch (e) {
      s().error(t("jira.syncFailed"), e);
    } finally {
      setSyncing(false);
    }
  };

  const sites = status?.sites ?? [];
  const siteName = (id: string) => sites.find((x) => x.id === id)?.name ?? id;
  const siteColor = (id: string) => sites.find((x) => x.id === id)?.color ?? "var(--accent)";
  const shown = useMemo(() => filterIssues(list ?? [], q), [list, q]);
  const groups = useMemo(() => groupIssues(shown, pref.group, { site: siteName, empty: t(`jira.group.none.${pref.group}` as TKey) }), [shown, pref.group, sites]); // eslint-disable-line react-hooks/exhaustive-deps
  const today = isoDay(new Date());
  const lastSync = sites.map((x) => x.sync?.synced_at).filter(Boolean).sort().pop() ?? null;
  const failing = sites.filter((x) => x.enabled && x.sync?.error);
  const anySyncing = syncing || sites.some((x) => x.syncing);

  if (status && sites.length === 0)
    return (
      <div className="view-scroll">
        <div className="view issues-view">
          <EmptyState
            icon={Ticket}
            title={t("jira.emptyTitle")}
            action={
              <Button variant="primary" icon={Settings2} onClick={() => openSettingsSection("jira")}>
                {t("jira.setUp")}
              </Button>
            }
          >
            {t("jira.emptyText")}
          </EmptyState>
        </div>
      </div>
    );

  const filter = (field: keyof IssueQuery, label: TKey, values: string[], name: (v: string) => string = (v) => v) =>
    values.length > 1 || q[field] ? (
      <Select
        aria-label={t(label)}
        className={`issues-filter ${q[field] ? "on" : ""}`}
        value={q[field]}
        onChange={(e) => setQ({ ...q, [field]: e.target.value })}
        options={[{ value: "", label: t(label) }, ...values.map((v) => ({ value: v, label: name(v) }))]}
      />
    ) : null;

  return (
    <div className="view-scroll">
      <div className="view issues-view">
        <header className="view-header">
          <div>
            <h1>{t("jira.title")}</h1>
            <div className="view-sub">
              {list ? t("jira.sub", { n: shown.length }) : ""}
              {lastSync && <span className="faint"> · {t("jira.syncedAt", { when: relative(lastSync) })}</span>}
            </div>
          </div>
          <div className="view-actions">
            <Select
              aria-label={t("jira.search")}
              value={pref.search}
              onChange={(e) => setPref({ search: e.target.value })}
              options={[{ value: "mine", label: t("jira.mine") }, ...queries.map((x) => ({ value: x.id, label: x.name })), { value: "all", label: t("jira.allSearches") }]}
            />
            <Select aria-label={t("jira.groupBy")} value={pref.group} onChange={(e) => setPref({ group: e.target.value as GroupBy })} options={GROUP_BYS.map((g) => ({ value: g, label: t(`jira.group.${g}` as TKey) }))} />
            <Button icon={RefreshCw} loading={anySyncing} onClick={() => void sync()}>
              {t("jira.refresh")}
            </Button>
          </div>
        </header>

        {failing.length > 0 && (
          <div className="issues-banner" role="status">
            <WifiOff size={15} aria-hidden />
            <div>
              {failing.map((x) => (
                <div key={x.id}>
                  <b>{x.name}:</b> {x.sync!.error}
                </div>
              ))}
              {lastSync && <div className="faint small">{t("jira.offlineHint", { when: relative(lastSync) })}</div>}
            </div>
          </div>
        )}

        <div className="issues-toolbar">
          <div className="issues-search">
            <Search size={14} aria-hidden />
            <Input value={q.text} placeholder={t("jira.searchPh")} aria-label={t("jira.searchPh")} onChange={(e) => setQ({ ...q, text: e.target.value })} />
          </div>
          {filter("site", "jira.f.site", valuesOf(list ?? [], "site"), siteName)}
          {filter("project", "jira.f.project", valuesOf(list ?? [], "project_key"))}
          {filter("status", "jira.f.status", valuesOf(list ?? [], "status"))}
          {filter("sprint", "jira.f.sprint", valuesOf(list ?? [], "sprint"))}
          {filter("priority", "jira.f.priority", valuesOf(list ?? [], "priority"))}
          {(q.text || q.site || q.project || q.status || q.sprint || q.priority) && (
            <Button variant="ghost" size="sm" onClick={() => setQ(emptyIssueQuery())}>
              {t("jira.clearFilters")}
            </Button>
          )}
        </div>

        {!list ? (
          <Spinner />
        ) : shown.length === 0 ? (
          <EmptyState icon={CheckSquare} title={list.length ? t("jira.noMatch") : t("jira.none")}>
            {list.length ? t("jira.noMatchText") : t("jira.noneText")}
          </EmptyState>
        ) : (
          groups.map((g) => (
            <section key={g.id} className="issues-group" aria-label={g.label || t("jira.title")}>
              {g.label && (
                <h2 className="issues-group-title">
                  {pref.group === "site" && <span className="issues-site-dot" style={{ background: siteColor(g.id) }} aria-hidden />}
                  <span>{g.label}</span> <span className="faint">{g.issues.length}</span>
                </h2>
              )}
              <ul className="issues-list">
                {g.issues.map((i) => (
                  <li key={`${i.site}:${i.key}`} className={`issue-row ${open === i.key ? "open" : ""} ${i.status_category === "done" ? "done" : ""}`} data-issue-row={i.key}>
                    <div
                      className="issue-row-main"
                      role="button"
                      tabIndex={0}
                      aria-expanded={open === i.key}
                      onClick={() => setOpen(open === i.key ? null : i.key)}
                      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), setOpen(open === i.key ? null : i.key))}
                      onContextMenu={(e) => openMenuAt(e, issueMenu(i))}
                    >
                      {sites.length > 1 && <span className="issues-site-dot" style={{ background: siteColor(i.site) }} title={siteName(i.site)} aria-hidden />}
                      <TypeIcon type={i.issue_type} />
                      <span className="issue-key mono">{i.key}</span>
                      <span className="issue-summary ellipsis">{i.summary}</span>
                      <span className="issue-meta">
                        {i.sprint && pref.group !== "sprint" && <span className="issue-sprint faint ellipsis">{i.sprint}</span>}
                        {i.priority && <span className={`issue-prio prio-${i.priority.toLowerCase()}`}>{i.priority}</span>}
                        {i.due_date && <span className={`issue-due ${overdue(i, today) ? "overdue" : ""}`}>{fmtDate(i.due_date)}</span>}
                        {i.assignee && <span className="issue-assignee ellipsis" title={i.assignee}>{i.assignee}</span>}
                        <StatusPill issue={i} />
                      </span>
                    </div>
                    <span className="issue-actions">
                      <IconButton icon={ExternalLink} size="sm" label={t("jira.openBrowser")} onClick={() => void openIssueInBrowser(i.key, i.url)} />
                      <IconButton icon={FileText} size="sm" label={t("jira.openNote")} onClick={(e) => void openIssueNote(i.key, { newTab: e.ctrlKey || e.metaKey })} />
                      <IconButton icon={Copy} size="sm" label={t("jira.copyKey")} onClick={() => void copyIssueKey(i.key)} />
                      <IconButton icon={MoreHorizontal} size="sm" label={t("jira.more", { key: i.key })} onClick={(e) => openMenuAt(e, issueMenu(i))} />
                    </span>
                    {open === i.key && <IssueDetail issue={i} />}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
      {menu}
    </div>
  );
}

/** The issue opened in the list: description, last comments, pages naming it, WBS. */
function IssueDetail({ issue }: { issue: Issue }) {
  const [view, setView] = useState<IssueView | null>(null);
  const timeOn = useTimeTracking();
  const pages = useApp((st) => st.pages);
  useEffect(() => {
    jiraApi.view(issue.key).then(setView, () => {});
  }, [issue.key, pages]);
  const s = useApp.getState;
  return (
    <div className="issue-detail">
      <div className="issue-detail-main">
        <dl className="issue-facts">
          <dt>{t("jira.col.type")}</dt>
          <dd>{issue.issue_type || "–"}</dd>
          <dt>{t("jira.col.reporter")}</dt>
          <dd>{issue.reporter || "–"}</dd>
          <dt>{t("jira.col.assignee")}</dt>
          <dd>{issue.assignee || t("jira.unassigned")}</dd>
          {issue.updated && (
            <>
              <dt>{t("jira.col.updated")}</dt>
              <dd>{relative(issue.updated)}</dd>
            </>
          )}
          {timeOn && (
            <>
              <dt>{t("jira.col.wbs")}</dt>
              <dd className="mono">{view?.wbs ?? <span className="faint">{t("jira.noWbs")}</span>}</dd>
              {!!view?.booked_minutes && (
                <>
                  <dt>{t("jira.col.booked")}</dt>
                  <dd>{fmtMinutes(view.booked_minutes)}</dd>
                </>
              )}
            </>
          )}
        </dl>
        {issue.description ? <div className="issue-desc">{issue.description}</div> : <div className="faint small">{t("jira.noDescription")}</div>}
        {issue.comments.length > 0 && (
          <div className="issue-comments">
            <h3>{t("jira.comments")}</h3>
            {issue.comments.map((c, n) => (
              <div key={n} className="issue-comment">
                <div className="issue-comment-head">
                  <b>{c.author}</b> <span className="faint small">{c.created ? relative(c.created) : ""}</span>
                </div>
                <div className="issue-comment-body">{c.body}</div>
              </div>
            ))}
          </div>
        )}
      </div>
      <aside className="issue-detail-side">
        <div className="issue-detail-buttons">
          <Button size="sm" icon={FileText} onClick={() => void openIssueNote(issue.key)}>
            {view?.note_page_id ? t("jira.openNote") : t("jira.createNote", { key: issue.key })}
          </Button>
          <Button size="sm" variant="ghost" icon={ListPlus} onClick={() => void addIssueTask(issue.key)}>
            {t("jira.addTask")}
          </Button>
        </div>
        <h3>{t("jira.backlinks")}</h3>
        {!view ? (
          <Spinner size={14} />
        ) : view.backlinks.length === 0 ? (
          <div className="faint small">{t("jira.noBacklinks", { key: issue.key })}</div>
        ) : (
          <ul className="issue-backlinks">
            {view.backlinks.map((b) => (
              <li key={b.page_id}>
                <button type="button" className="dw-row" onClick={(e) => s().openPage(b.page_id, { newTab: e.ctrlKey || e.metaKey })}>
                  <PageIcon name={b.icon} size={14} />
                  <span className="ellipsis">{b.title}</span>
                  {b.note && <Badge tone="accent">{t("jira.noteBadge")}</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
