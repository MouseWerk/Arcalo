// What a click on an issue does (chips, the Issues page, widgets, the hover card).

import { openUrl } from "@tauri-apps/plugin-opener";
import { Copy, ExternalLink, FileText, PanelTop } from "lucide-react";
import type { MenuEntry } from "../components/ui";
import { useApp } from "../store/app";
import { t } from "./i18n";
import { jiraApi, useIssueIndex } from "./jira";
import { openIssueView } from "./issueFull";
import { copyText } from "./clipboard";

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

/** A click on an issue (chip, row, widget, plan block): the issue view; Ctrl/Cmd+click the
 *  browser; `note` (Shift+click in lists) the issue's note, in a new tab with `newTab`. */
export async function openIssue(key: string, opts: { browser?: boolean; note?: boolean; newTab?: boolean } = {}) {
  if (opts.browser) return openIssueInBrowser(key);
  if (opts.note) return openIssueNote(key, { newTab: opts.newTab });
  openIssueView(key);
}

export async function copyIssueKey(key: string) {
  try {
    await copyText(key);
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

/** The icon of „In der Issue-Ansicht öffnen“, the same on every button and menu item. */
export const ISSUE_VIEW_ICON = PanelTop;

/** The context menu of an issue in a list or widget, in the order of the buttons: the issue view,
 *  Jira, the note, the key. */
export function issueOpenMenu(i: { key: string; url?: string }): MenuEntry[] {
  return [
    { label: t("iv.openView"), icon: ISSUE_VIEW_ICON, onSelect: () => openIssueView(i.key) },
    { label: t("iv.openInJira"), icon: ExternalLink, onSelect: () => void openIssueInBrowser(i.key, i.url) },
    { label: t("jira.openNote"), icon: FileText, onSelect: () => void openIssueNote(i.key) },
    { label: t("jira.copyKey"), icon: Copy, onSelect: () => void copyIssueKey(i.key) },
  ];
}
