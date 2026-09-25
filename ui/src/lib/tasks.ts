// Task view helpers: due-date groups and [[link]]/#tag segments of a task text.

import { addDays, isoDay, weekStart } from "./format";

export type TaskGroup = "overdue" | "today" | "week" | "later" | "none";

export const TASK_GROUPS: { id: TaskGroup; label: string }[] = [
  { id: "overdue", label: "Überfällig" },
  { id: "today", label: "Heute" },
  { id: "week", label: "Diese Woche" },
  { id: "later", label: "Später" },
  { id: "none", label: "Ohne Datum" },
];

/** Group of a due date (`YYYY-MM-DD`) relative to `now`; the week ends on Sunday. */
export function taskGroup(due: string | null, now: Date): TaskGroup {
  if (!due) return "none";
  const today = isoDay(now);
  if (due < today) return "overdue";
  if (due === today) return "today";
  return due <= isoDay(addDays(weekStart(now), 6)) ? "week" : "later";
}

export type TaskSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; text: string; target: string }
  | { kind: "tag"; text: string; tag: string }
  | { kind: "mail"; text: string; id: string };

/** Splits a task text into plain text, `[[links]]` (alias shown), `#tags` (same rules as the core) and links to e-mails (`[E-Mail: …](annalo-mail://id)`). */
export function taskSegments(text: string): TaskSegment[] {
  const out: TaskSegment[] = [];
  const push = (t: string) => {
    if (!t) return;
    const last = out[out.length - 1];
    if (last?.kind === "text") last.text += t;
    else out.push({ kind: "text", text: t });
  };
  const re = /\[\[([^\]]+?)\]\]|\[([^[\]]*)\]\(annalo-mail:\/\/([0-9a-z]+)\/?\)|(^|[\s(])#([\p{L}\p{N}_\-/]+)/giu;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(text.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] != null) {
      const inner = m[1];
      const target = inner.split(/[|#]/)[0].trim();
      const alias = inner.includes("|") ? inner.slice(inner.indexOf("|") + 1) : inner;
      if (target) out.push({ kind: "link", text: alias, target });
      else push(m[0]);
      continue;
    }
    if (m[3] != null) {
      out.push({ kind: "mail", text: m[2], id: m[3].toLowerCase() });
      continue;
    }
    push(m[4]);
    const tag = m[5].replace(/[-/]+$/, "");
    if (!tag || /^\d+$/.test(tag)) {
      push(`#${m[5]}`);
      continue;
    }
    out.push({ kind: "tag", text: `#${tag}`, tag: tag.toLowerCase() });
    push(m[5].slice(tag.length));
  }
  push(text.slice(at));
  return out;
}
