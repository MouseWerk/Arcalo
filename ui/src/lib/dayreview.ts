// „Tagesrückblick“: the Markdown block written into the daily note (idempotent: marked with
// HTML comments and replaced on every write), the numbers the view shows, and whether a local
// model can write the summary.

import { addDays, decimal, isoDay, time } from "./format";
import type { AiProvider, DayReview, MeetingState, ReviewMeeting, ReviewTask } from "./types";
import { t, type TKey } from "./i18n";

/** Markers around the generated block (kept verbatim by the editor, like `<!-- spalten -->`). */
export const REVIEW_OPEN = "<!-- rückblick -->";
export const REVIEW_CLOSE = "<!-- /rückblick -->";
/** The heading of the block, in the display language (the markers find the block). */
export const reviewHeading = () => `## ${t("review.heading")}`;

/** Minutes as hours: `390` → „6,5 h“. */
export const hours = (minutes: number) => `${decimal(Math.round((minutes / 60) * 100) / 100)} h`;
/** Minutes as „1:05 h“ (short spans: meetings, gaps, focus). */
export const hm = (minutes: number) => `${Math.floor(Math.max(0, minutes) / 60)}:${String(Math.max(0, minutes) % 60).padStart(2, "0")} h`;

export const MEETING_LABEL: Record<MeetingState, TKey> = {
  booked: "review.meeting.booked",
  open: "review.meeting.open",
  skipped: "review.meeting.skipped",
  upcoming: "review.meeting.upcoming",
  free: "review.meeting.free",
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
  const when = m.all_day ? t("cal.allDay") : time(m.start);
  return `${inline(m.title) || t("cal.appointment")} ${when} (${t(MEETING_LABEL[m.state])})`;
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
  const out: string[] = [REVIEW_OPEN, "", reviewHeading(), ""];
  const tm = r.time;
  const label = (key: TKey) => `**${t(key)}:**`;
  let zeit = `${label("review.md.time")} ${t("review.md.booked", { h: hours(tm.booked_minutes) })}`;
  if (tm.target_minutes > 0) {
    zeit = `${label("review.md.time")} ${t("review.md.bookedOf", { h: hours(tm.booked_minutes), target: hours(tm.target_minutes) })}`;
    if (tm.missing_minutes > 0) zeit += `, ${t("review.md.missing", { h: hours(tm.missing_minutes) })}`;
  }
  if (tm.running_minutes > 0) zeit += `, ${t("review.md.running", { time: hm(tm.running_minutes) })}`;
  out.push(zeit, "");
  if (tm.items.length) {
    for (const w of tm.items) out.push(`- ${w.label}${w.title ? ` ${inline(w.title)}` : ""}: ${hours(w.minutes)}`);
    out.push("");
  }
  if (tm.gaps.length) out.push(`${label("review.md.gaps")} ${tm.gaps.map((g) => `${time(g.start)}–${time(g.end)}`).join(", ")}`, "");
  if (r.meetings.length) out.push(`${label("review.md.meetings")} ${r.meetings.map(meetingLine).join(" · ")}`, "");
  const pages = r.pages.filter((p) => !(p.daily && p.page_id === r.daily_note_id));
  if (pages.length) {
    const list = pages.map((p) => `${pageRef(p.title, p.gone)}${p.created ? ` (${t("review.md.new")})` : ""}`);
    out.push(`${label("review.md.pages")} ${list.join(" · ")}`, "");
  }
  const k = r.tasks;
  if (k.done_total || k.added_total || k.due_total || k.overdue_total) {
    const parts: string[] = [];
    if (k.done_total) parts.push(`${t("review.md.done", { n: k.done_total })} (${taskTexts(k.done)})`);
    const fresh = k.added.filter((x) => !x.done);
    if (fresh.length) parts.push(t("review.md.added", { n: fresh.length }));
    if (k.due_total) parts.push(t("review.md.dueToday", { n: k.due_total }));
    if (k.overdue_total) parts.push(t("review.md.overdue", { n: k.overdue_total }));
    out.push(`${label("review.md.tasks")} ${parts.join(" · ")}`, "");
  }
  if (r.focus.sessions.length) {
    const n = r.focus.sessions.length;
    out.push(`${label("review.md.focus")} ${t("review.md.sessions", { n })}, ${hm(r.focus.minutes)}`, "");
  }
  if (r.files.length) out.push(`${label("review.md.files")} ${r.files.map((f) => inline(f.name)).join(", ")}`, "");
  const text = summary ? cleanSummary(summary) : "";
  if (text) out.push(`**${t("review.md.summary")}**`, "", text, "");
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
