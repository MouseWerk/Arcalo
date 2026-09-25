// „E-Mail als Aufgabe / Notiz“: types and IPC wrappers of the mail commands
// (src-tauri/src/mail.rs) and the pure helpers of the dialog (tested in mail.test.ts).

import { invoke } from "@tauri-apps/api/core";
import { addDays, isoDay } from "./format";
import type { Page } from "./types";
import { useApp } from "../store/app";

export type MailSource = "outlook" | "eml" | "msg" | "text";

export interface MailAttachment {
  /** 1-based position in the mail. */
  index: number;
  name: string;
  size: number;
  /** An image of the text (logo, signature): not offered by default. */
  inline: boolean;
  file: string;
}

export interface Mail {
  source: MailSource;
  entry_id: string;
  store_id: string;
  file: string;
  file_name: string;
  subject: string;
  from_name: string;
  from_email: string;
  to: string[];
  cc: string[];
  /** RFC 3339 UTC. */
  received: string | null;
  conversation: string;
  /** 0 low, 1 normal, 2 high. */
  importance: number;
  categories: string[];
  body: string;
  truncated: boolean;
  attachments: MailAttachment[];
}

export type TaskTarget = { kind: "daily" } | { kind: "page"; id: number } | { kind: "note" };

export interface MailImportRequest {
  mail: Mail;
  task: { target: TaskTarget; text: string; due: string | null; priority: number } | null;
  note: { parent: string; title: string } | null;
  vorgang: string;
  tags: string[];
  attachments: number[];
}

export interface MailCreated {
  link: string | null;
  task_page: Page | null;
  note_page: Page | null;
  attachments: string[];
}

export interface MailLink {
  id: string;
  source: MailSource;
  subject: string;
  sender: string;
  sender_email: string;
  received: string | null;
  file: string;
  vorgang: string;
}

export interface MailStatus {
  outlook_available: boolean;
  /** Model of the local tier when its provider is marked local; null hides „Aufgabe vorschlagen“. */
  local_ai: string | null;
}

export const mailApi = {
  status: () => invoke<MailStatus>("mail_status"),
  outlookCurrent: () => invoke<Mail[]>("mail_outlook_current"),
  /** A dropped .eml/.msg: raw bytes as the body, the name as a header (like attachment_store). */
  parseFile: async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return invoke<Mail>("mail_parse_file", bytes, { headers: { "x-annalo-name": encodeURIComponent(file.name || "E-Mail.eml") } });
  },
  parseText: (text: string) => invoke<Mail | null>("mail_parse_text", { text }),
  import: (request: MailImportRequest) => invoke<MailCreated>("mail_import", { request }),
  linkInfo: (id: string) => invoke<MailLink>("mail_link_info", { id }),
  open: (id: string) => invoke<void>("mail_open", { id }),
  suggest: (requestId: string, mail: Mail) => invoke<{ task: string; due: string | null }>("mail_suggest", { requestId, mail }),
};

/** Files taken as mails: `.eml` and Outlook's `.msg`. */
export const isMailFile = (name: string) => /\.(eml|msg)$/i.test(name.trim());

/** The id of an `annalo-mail://<id>` link, else null. */
export function mailLinkId(href: string | null | undefined): string | null {
  const m = /^annalo-mail:\/\/([0-9a-z]+)\/?$/i.exec((href ?? "").trim());
  return m ? m[1].toLowerCase() : null;
}

/** Whether pasted text looks like the header block of a mail (Von:/From: plus Betreff:/Subject: or a date). */
export function looksLikeHeaderBlock(text: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/^[>*\s]+/, "").replace(/\*\*/g, ""));
  const has = (re: RegExp) => lines.some((l) => re.test(l));
  return has(/^(von|from):\s*\S/i) && (has(/^(betreff|subject):/i) || has(/^(gesendet|sent|datum|date):\s*\S/i));
}

/** Reply and forward prefixes (AW:, RE:, WG:, FW:, Fwd:, TR:, …), also repeated, are no task. */
export function cleanSubject(subject: string): string {
  let s = subject.trim();
  for (;;) {
    const next = s.replace(/^(aw|re|wg|fw|fwd|tr|sv|vs|antw|r)\s*(\[\d+\])?\s*:\s*/i, "").trim();
    if (next === s) return s;
    s = next;
  }
}

/** Task priority (0 none, 1 mittel, 2 hoch) from Outlook's importance. */
export const priorityFromImportance = (importance: number) => (importance >= 2 ? 2 : 0);

export type DueChoice = "today" | "tomorrow" | "friday" | "next_week";

export const DUE_CHOICES: { id: DueChoice; label: string }[] = [
  { id: "today", label: "Heute" },
  { id: "tomorrow", label: "Morgen" },
  { id: "friday", label: "Fr" },
  { id: "next_week", label: "Nächste Woche" },
];

/** The day of a quick choice: Friday is this week's (next week's from Saturday on), „Nächste Woche“ is next Monday. */
export function dueFor(choice: DueChoice, now = new Date()): string {
  const dow = now.getDay(); // 0 Sunday … 6 Saturday
  switch (choice) {
    case "today":
      return isoDay(now);
    case "tomorrow":
      return isoDay(addDays(now, 1));
    case "friday":
      return isoDay(addDays(now, dow <= 5 ? 5 - dow : 6));
    case "next_week":
      return isoDay(addDays(now, ((8 - dow) % 7) || 7));
  }
}

/** `Müller, Anna <anna@example.com>` or whichever part is known. */
export function senderLabel(m: Pick<Mail, "from_name" | "from_email">): string {
  const n = m.from_name.trim();
  const e = m.from_email.trim();
  if (n && e && n.toLowerCase() !== e.toLowerCase()) return `${n} <${e}>`;
  return n || e || "Unbekannter Absender";
}

/** The first lines of the text for the preview (at most `max` characters, blank runs collapsed). */
export function preview(body: string, max = 1200): string {
  const t = body.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()} …` : t;
}

/** The attachments offered: real files first; inline images only when asked. */
export function offeredAttachments(m: Mail, withInline: boolean): MailAttachment[] {
  return m.attachments.filter((a) => withInline || !a.inline);
}

/** Opens a linked mail (`annalo-mail://<id>`): in Outlook, or the stored file in its app. */
export async function openMailLink(id: string) {
  const s = useApp.getState();
  try {
    const info = await mailApi.linkInfo(id).catch(() => null);
    await mailApi.open(id);
    s.toast({ tone: "success", title: info?.source === "outlook" ? "E-Mail in Outlook geöffnet" : "E-Mail geöffnet", detail: info?.subject || undefined });
  } catch (e) {
    s.error("E-Mail nicht geöffnet", e);
  }
}
