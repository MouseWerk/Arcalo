// „Jira-Issue anlegen“: site, project and issue type for a task; the summary comes from the task
// (editable), the description names the note. The new key is appended to the task.

import { useEffect, useMemo, useState } from "react";
import { useApp } from "../store/app";
import { t } from "../lib/i18n";
import { jiraApi, type RemoteProject } from "../lib/jira";
import { CREATE_ISSUE_EVENT, type CreateIssueRequest } from "../editor/taskIssue";
import { Button, Dialog, Field, Input, Select } from "./ui";
import { isKey } from "../lib/ime";

const LAST = "arcalo.jira.lastCreate";
function last(): { site?: string; project?: string; type?: string } {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "{}");
  } catch {
    return {};
  }
}

export function CreateIssueHost() {
  const [req, setReq] = useState<CreateIssueRequest | null>(null);
  useEffect(() => {
    const on = (e: Event) => setReq((e as CustomEvent<CreateIssueRequest>).detail);
    window.addEventListener(CREATE_ISSUE_EVENT, on);
    return () => window.removeEventListener(CREATE_ISSUE_EVENT, on);
  }, []);
  return req ? <CreateIssueDialog req={req} onClose={() => setReq(null)} /> : null;
}

function CreateIssueDialog({ req, onClose }: { req: CreateIssueRequest; onClose: () => void }) {
  const all = useApp((st) => st.settings?.settings.jira?.sites);
  const sites = useMemo(() => (all ?? []).filter((x) => x.enabled), [all]);
  const remembered = last();
  const [site, setSite] = useState(sites.find((s) => s.id === remembered.site)?.id ?? sites[0]?.id ?? "");
  const [projects, setProjects] = useState<RemoteProject[] | null>(null);
  const [project, setProject] = useState("");
  const [types, setTypes] = useState<string[]>([]);
  const [type, setType] = useState("");
  const [summary, setSummary] = useState(req.summary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = useApp.getState;

  useEffect(() => {
    if (!site) return;
    setProjects(null);
    jiraApi.projects(site).then(
      (list) => {
        setProjects(list);
        setProject((p) => (list.some((x) => x.key === p) ? p : list.find((x) => x.key === remembered.project)?.key ?? list[0]?.key ?? ""));
      },
      (e) => (setProjects([]), setError(String(e))),
    );
  }, [site]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!site || !project) return;
    jiraApi.issueTypes(site, project).then(
      (list) => {
        setTypes(list);
        setType((x) => (list.includes(x) ? x : list.includes(remembered.type ?? "") ? remembered.type! : list.find((n) => /^(task|aufgabe)$/i.test(n)) ?? list[0] ?? ""));
      },
      () => setTypes([]),
    );
  }, [site, project]); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async () => {
    if (!site || !project || !type || !summary.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const issue = await jiraApi.create(site, project, type, summary.trim(), req.pageId);
      try {
        localStorage.setItem(LAST, JSON.stringify({ site, project, type }));
      } catch {
        /* not kept */
      }
      req.apply(issue.key);
      s().toast({ tone: "success", title: t("jira.created", { key: issue.key }), detail: issue.summary });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("jira.createTitle")}
      description={t("jira.createDesc")}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={!project || !type || !summary.trim()} onClick={() => void create()}>
            {t("jira.createButton")}
          </Button>
        </>
      }
    >
      {sites.length > 1 && (
        <Field label={t("jira.f.site")}>
          <Select aria-label={t("jira.f.site")} value={site} onChange={(e) => setSite(e.target.value)} options={sites.map((x) => ({ value: x.id, label: x.name }))} />
        </Field>
      )}
      <div className="jira-create-row">
        <Field label={t("jira.f.project")}>
          <Select aria-label={t("jira.f.project")} value={project} disabled={!projects?.length} onChange={(e) => setProject(e.target.value)} options={(projects ?? []).map((p) => ({ value: p.key, label: p.name ? `${p.key} · ${p.name}` : p.key }))} placeholder={projects ? t("jira.noProjects") : t("dash.loading")} />
        </Field>
        <Field label={t("jira.col.type")}>
          <Select aria-label={t("jira.col.type")} value={type} disabled={!types.length} onChange={(e) => setType(e.target.value)} options={types.map((x) => ({ value: x, label: x }))} />
        </Field>
      </div>
      <Field label={t("jira.summary")}>
        <Input value={summary} aria-label={t("jira.summary")} onChange={(e) => setSummary(e.target.value)} data-autofocus onKeyDown={(e) => isKey(e, "Enter") && void create()} />
      </Field>
      {error && <div className="jira-test-result bad">{error}</div>}
    </Dialog>
  );
}
