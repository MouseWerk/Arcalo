// „Tagesrückblick“: the Markdown block written into the daily note (idempotent: marked with
// HTML comments and replaced on every write), the numbers the view shows, and whether a local
// model can write the summary.

import { addDays, isoDay, time } from "./format";
import type { AiProvider, DayReview, MeetingState, ReviewMeeting, ReviewTask } from "./types";

/** Markers around the generated block (kept verbatim by the editor, like `<!-- spalten -->`). */
export const REVIEW_OPEN = "<!-- rückblick -->";
export const REVIEW_CLOSE = "<!-- /rückblick -->";
export const REVIEW_HEADING = "## Rückblick";

const nf = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 });
/** Minutes as hours: `390` → „6,5 h“. */
export const hours = (minutes: number) => `${nf.format(Math.round((minutes / 60) * 100) / 100)} h`;
/** Minutes as „1:05 h“ (short spans: meetings, gaps, focus). */
export const hm = (minutes: number) => `${Math.floor(Math.max(0, minutes) / 60)}:${String(Math.max(0, minutes) % 60).padStart(2, "0")} h`;

export const MEETING_LABEL: Record<MeetingState, string> = {
  booked: "gebucht",
  open: "nicht gebucht",
  skipped: "nicht buchen",
  upcoming: "steht an",
  free: "frei",
};

/** The day before or after `iso` (YYYY-MM-DD). */
export const shiftDay = (iso: string, delta: number) => isoDay(addDays(new Date(`${iso}T12:00:00`), delta));

/** A provider that may write the summary: switched on and marked local. */
export const localProviders = (providers: AiProvider[] | undefined) => (providers ?? []).filter((p) => p.enabled && p.local);

/** Share of the target booked, 0..1 (1 without a target once something is booked). */
export function progress(r: DayReview): number {
  const t = r.time;
  if (t.target_minutes <= 0) return t.booked_minutes > 0 ? 1 : 0;
  return Math.min(1, t.booked_minutes / t.target_minutes);
}

/** Meetings that still need a booking. */
export const openMeetings = (r: DayReview) => r.meetings.filter((m) => m.state === "open");

/** Plain text for a Markdown line: no line breaks, no stray `[[`, no leading list/heading marker. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** A page as a wiki link, or plain when it is gone (link characters removed either way). */
function pageRef(title: string, gone: boolean): string {
  const t = inline(title).replace(/[[\]|#^]/g, " ").replace(/\s+/g, " ").trim();
  return gone || !t ? t : `[[${t}]]`;
}

function meetingLine(m: ReviewMeeting): string {
  const when = m.all_day ? "ganztägig" : time(m.start);
  return `${inline(m.title) || "Termin"} ${when} (${MEETING_LABEL[m.state]})`;
}

const taskTexts = (tasks: ReviewTask[], max = 5) => {
  const names = tasks.slice(0, max).map((t) => inline(t.text));
  if (tasks.length > max) names.push(`+${tasks.length - max}`);
  return names.join(", ");
};

/**
 * Summary text as it goes into the note: task checkboxes become plain bullets (the review must
 * not add tasks to the daily note), headings become bold lines.
 */
export function cleanSummary(text: string): string {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^(\s*[-*+]\s+)\[[ xX]\]\s*/, "$1").replace(/^#{1,6}\s+(.*)$/, "**$1**"))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The block for the daily note, markers included. */
export function reviewMarkdown(r: DayReview, summary?: string | null): string {
  const out: string[] = [REVIEW_OPEN, "", REVIEW_HEADING, ""];
  const t = r.time;
  let zeit = `**Zeit:** ${hours(t.booked_minutes)} gebucht`;
  if (t.target_minutes > 0) zeit = `**Zeit:** ${hours(t.booked_minutes)} von ${hours(t.target_minutes)} gebucht${t.missing_minutes > 0 ? `, ${hours(t.missing_minutes)} fehlen` : ""}`;
  if (t.running_minutes > 0) zeit += `, Timer läuft (${hm(t.running_minutes)})`;
  out.push(zeit, "");
  if (t.items.length) {
    for (const w of t.items) out.push(`- ${w.label}${w.title ? ` ${inline(w.title)}` : ""}: ${hours(w.minutes)}`);
    out.push("");
  }
  if (t.gaps.length) out.push(`**Lücken:** ${t.gaps.map((g) => `${time(g.start)}–${time(g.end)}`).join(", ")}`, "");
  if (r.meetings.length) out.push(`**Termine:** ${r.meetings.map(meetingLine).join(" · ")}`, "");
  const pages = r.pages.filter((p) => !(p.daily && p.page_id === r.daily_note_id));
  if (pages.length) {
    const list = pages.map((p) => `${pageRef(p.title, p.gone)}${p.created ? " (neu)" : ""}`);
    out.push(`**Seiten:** ${list.join(" · ")}`, "");
  }
  const k = r.tasks;
  if (k.done_total || k.added_total || k.due_total || k.overdue_total) {
    const parts: string[] = [];
    if (k.done_total) parts.push(`${k.done_total} erledigt (${taskTexts(k.done)})`);
    const fresh = k.added.filter((x) => !x.done);
    if (fresh.length) parts.push(`${fresh.length} neu`);
    if (k.due_total) parts.push(`${k.due_total} heute fällig`);
    if (k.overdue_total) parts.push(`${k.overdue_total} überfällig`);
    out.push(`**Aufgaben:** ${parts.join(" · ")}`, "");
  }
  if (r.focus.sessions.length) {
    const n = r.focus.sessions.length;
    out.push(`**Fokus:** ${n} ${n === 1 ? "Sitzung" : "Sitzungen"}, ${hm(r.focus.minutes)}`, "");
  }
  if (r.files.length) out.push(`**Dateien:** ${r.files.map((f) => inline(f.name)).join(", ")}`, "");
  const text = summary ? cleanSummary(summary) : "";
  if (text) out.push("**Zusammenfassung**", "", text, "");
  out.push(REVIEW_CLOSE);
  return out.join("\n");
}

/** Where the block stands in `content`: [start, end) of its lines, or null. */
export function findReviewBlock(content: string): [number, number] | null {
  const open = content.indexOf(REVIEW_OPEN);
  if (open < 0) return null;
  const close = content.indexOf(REVIEW_CLOSE, open);
  if (close < 0) return null;
  const start = content.lastIndexOf("\n", open - 1) + 1;
  const nl = content.indexOf("\n", close);
  return [start, nl < 0 ? content.length : nl + 1];
}

/**
 * `content` with `block` in place of the existing review block, or appended at the end (after
 * one blank line). Writing the same day twice replaces the block; nothing else changes.
 */
export function upsertReviewBlock(content: string, block: string): string {
  const at = findReviewBlock(content);
  if (at) {
    const [a, b] = at;
    return `${content.slice(0, a)}${block}\n${content.slice(b)}`;
  }
  const head = content.replace(/\s+$/, "");
  return head ? `${head}\n\n${block}\n` : `${block}\n`;
}
