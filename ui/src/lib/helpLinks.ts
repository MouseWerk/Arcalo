// Where „Hilfe & Doku“ and „Feedback geben“ lead: the user documentation on the website (in the
// UI language) and the issue forms of the repository. A domain or path change is one line here.

import type { Lang } from "./i18n";

/** The website with the documentation (English under /docs/, German under /de/docs/). */
export const SITE_URL = "https://arcalo.mousewerk.de";

/** „Neues Issue“ of the repository; the forms live in .github/ISSUE_TEMPLATE. */
export const ISSUES_URL = "https://github.com/MouseWerk/Arcalo/issues/new";

/** Documentation pages the app links to (paths below /docs/, the same in both languages). */
export const DOC_PAGES = {
  home: "",
  shortcuts: "workspace/shortcuts",
  troubleshooting: "help/troubleshooting",
  updates: "getting-started/updates",
  aiProviders: "ai/providers",
  network: "data/network",
  backups: "data/backups",
  encryption: "data/encryption",
  gitSync: "data/git-sync",
  calendars: "meetings/calendars",
} as const;

export type HelpTopic = keyof typeof DOC_PAGES;

/** The documentation page of `topic` in `lang` (German pages under /de/). */
export function docsUrl(topic: HelpTopic, lang: Lang): string {
  const page = DOC_PAGES[topic];
  return `${SITE_URL}${lang === "de" ? "/de" : ""}/docs/${page ? `${page}/` : ""}`;
}

/** The two issue forms: an idea or feedback, and a bug report. */
export type IssueKind = "feedback" | "bug";

const TEMPLATES: Record<IssueKind, string> = { feedback: "feedback.yml", bug: "bug_report.yml" };

/**
 * The issue form of `kind`, with the fields `version` and `os` filled in. Nothing else goes
 * along: no note content, no settings, no logs.
 */
export function issueUrl(kind: IssueKind, info: { version: string; os: string }): string {
  const params: [string, string][] = [["template", TEMPLATES[kind]]];
  if (info.version.trim()) params.push(["version", info.version.trim()]);
  if (info.os.trim()) params.push(["os", info.os.trim()]);
  return `${ISSUES_URL}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;
}
