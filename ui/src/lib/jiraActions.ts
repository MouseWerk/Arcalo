// What a click on an issue does (chips, the Issues page, widgets, the hover card).

import { openUrl } from "@tauri-apps/plugin-opener";
import { useApp } from "../store/app";
import { t } from "./i18n";
import { jiraApi, useIssueIndex } from "./jira";

const s = useApp.getState;

/** Opens the issue in the browser. */
export async function openIssueInBrowser(key: string, url?: string) {
  const target = url || useIssueIndex.getState().byKey.get(key)?.url;
  if (!target) return void s().toast({ tone: "warning", title: t("jira.noUrl", { key }) });
  await openUrl(target).catch((e) => s().error(t("jira.openFailed"), e));
}

/** Opens the issue's note page, created on first use („PROJ-123 Summary“ with `jira: PROJ-123`). */
export async function openIssueNote(key: string, opts: { newTab?: boolean } = {}) {
  try {
    const { page, created } = await jiraApi.note(key);
    if (created) await s().refreshTree();
    s().openPage(page.id, { newTab: opts.newTab });
    if (created) s().toast({ tone: "success", title: t("jira.noteCreated"), detail: page.title });
  } catch (e) {
    s().error(t("jira.noteFailed"), e);
  }
}

/** Chip click: the note page; Ctrl/Cmd+click: the browser. */
export async function openIssue(key: string, opts: { browser?: boolean; newTab?: boolean } = {}) {
  if (opts.browser) return openIssueInBrowser(key);
  return openIssueNote(key, opts);
}

export async function copyIssueKey(key: string) {
  try {
    await navigator.clipboard.writeText(key);
    s().toast({ tone: "success", title: t("jira.copied", { key }) });
  } catch (e) {
    s().error(t("jira.copyFailed"), e);
  }
}

/** „Als Aufgabe übernehmen“: a task with the key in today's daily note. */
export async function addIssueTask(key: string) {
  try {
    const r = await jiraApi.addTask(key);
    await s().refreshTree();
    s().toast({ tone: "success", title: t("jira.taskAdded", { key }), detail: r.title, action: { label: t("jira.openPage"), run: () => s().openPage(r.page_id) } });
  } catch (e) {
    s().error(t("jira.taskFailed"), e);
  }
}

/** Opens the Issues page. */
export const openIssuesView = () => s().openTab({ kind: "issues" });
