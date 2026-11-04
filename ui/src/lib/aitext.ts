import { Marked, type Token } from "marked";
import { t, type TKey } from "./i18n";
import { zeitCommand } from "../editor/zeit-suggest";
// Prompts and text helpers of the inline AI bar and the meeting summary.
// The shell wraps the instruction and the text (`ai_transform`); these only build the instruction.

export interface AiPreset {
  id: string;
  label: string;
  instruction: string;
}

const preset = (id: string): AiPreset => ({ id, label: t(`aitext.${id}` as TKey), instruction: t(`aitext.${id}.prompt` as TKey) });

/** The built-in presets of the inline AI bar, in the display language. */
export const aiPresets = (): AiPreset[] => ["improve", "shorten", "expand", "translate", "bullets", "table", "spelling", "friendly", "formal"].map(preset);

/** The presets of the inline AI bar: the user's (Settings → KI) or the built-in ones. */
export function inlinePresets(custom?: { label: string; instruction: string }[] | null): AiPreset[] {
  if (!custom) return aiPresets();
  return custom.filter((p) => p.label.trim() && p.instruction.trim()).map((p, i) => ({ id: `custom-${i}`, label: p.label.trim(), instruction: p.instruction.trim() }));
}

/** On an empty line there is nothing to rewrite: the bar writes new text, the page is context. */
export const writePresets = (): AiPreset[] => ["write-continue", "write-outline", "write-tasks", "write-summary", "write-next"].map(preset);

/** Wraps a request to write new text: `<text>` then holds the page as context, not text to change. */
export function writeInstruction(instruction: string): string {
  return `${instruction.trim()}\n\n${t("aitext.writeContext")}`;
}

/** The instruction of a preset or free text (trimmed); null when empty. */
export function transformInstruction(presetOrText: string, presets: AiPreset[] = aiPresets()): string | null {
  const found = presets.find((p) => p.id === presetOrText);
  if (found) return found.instruction;
  const text = presetOrText.trim();
  return text ? text : null;
}

/** Removes a fence the model put around the whole answer (```markdown … ```), also while it streams. */
export function cleanAiMarkdown(answer: string): string {
  return withoutRemoteImages(unfence(answer.trim()));
}

function unfence(t: string): string {
  const m = /^```(markdown|md)?[ \t]*\n/i.exec(t);
  if (!m) return t;
  const body = t.slice(m[0].length);
  // Still streaming (no closing fence yet) or closed at the very end.
  const closed = /\n?```$/.exec(body);
  const inner = closed ? body.slice(0, closed.index) : body;
  if (inner.includes("\n```")) return t;
  return inner.trimEnd();
}

const LOCAL = /^\s*(?:data:|blob:|arcalo-asset:|http:\/\/arcalo-asset\.localhost\/|#)/i;
const remoteSrc = (url: string) => /^\s*(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url) && !LOCAL.test(url);
const lexer = new Marked({ gfm: true });

/**
 * A model's answer before it goes into a page: an image from another server becomes a link to it
 * (`![a](https://…)` → `[a](https://…)`, also as a reference or as raw `<img>`), outside code. Shown
 * in a page, the image would be fetched at once, and its address can carry what the model read (a
 * private note, steered by text in a mail, a Jira issue or a web page). The page's own Markdown
 * parser finds the images, so every form it shows as an image is caught.
 */
export function withoutRemoteImages(md: string): string {
  if (!/!\[|<im/i.test(md)) return md;
  const swaps: [string, string][] = [];
  const walk = (tokens: Token[] | undefined) => {
    for (const tok of tokens ?? []) {
      if (tok.type === "image" && remoteSrc(tok.href)) {
        const label = (tok.text.trim() || tok.href).replace(/[[\]]/g, "");
        swaps.push([tok.raw, `[${label}](<${tok.href.replace(/[<>\s]/g, encodeURIComponent)}>)`]);
        continue;
      }
      if (tok.type === "html" && /<im(?:g|age)\b/i.test(tok.raw)) swaps.push([tok.raw, rawImages(tok.raw)]);
      const t = tok as Token & { tokens?: Token[]; items?: { tokens: Token[] }[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };
      walk(t.tokens);
      for (const item of t.items ?? []) walk(item.tokens);
      for (const cell of t.header ?? []) walk(cell.tokens);
      for (const row of t.rows ?? []) for (const cell of row) walk(cell.tokens);
    }
  };
  walk(lexer.lexer(md));
  let out = md;
  let from = 0;
  for (const [raw, swap] of swaps) {
    const at = out.indexOf(raw, from);
    if (at < 0) continue;
    out = out.slice(0, at) + swap + out.slice(at + raw.length);
    from = at + swap.length;
  }
  return out;
}

/** Raw `<img … src="remote">` (also `<image>`, which HTML reads as `<img>`) → `[alt](<remote>)`. */
function rawImages(html: string): string {
  return html.replace(/<im(?:g|age)\b[^>]*>/gi, (tag) => {
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const url = src ? (src[1] ?? src[2] ?? src[3] ?? "") : "";
    if (!url || !remoteSrc(url)) return tag;
    const alt = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const label = (alt?.[1] ?? alt?.[2] ?? "").trim() || url;
    return `[${label.replace(/[[\]]/g, "")}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)`;
  });
}


// ------------------------------------------------------------ meeting summary

/** The instruction for „Besprechung zusammenfassen“: the user's template or the built-in one. */
export function meetingSummaryInstruction(template?: string | null): string {
  if (template?.trim()) return template.trim();
  return t("aitext.summaryPrompt");
}

export const summaryPageTitle = (title: string) => t("aitext.summaryTitle", { title });

/** Content of the page „<Titel> – Zusammenfassung“, linked back to the meeting page. */
export function summaryPageContent(title: string, summary: string): string {
  return `${t("aitext.summaryOf", { link: `[[${title}]]` })}\n\n${summary.trim()}\n`;
}

/**
 * Minutes of a meeting from its notes: a time span („10:00–11:30“, „10:00 bis 11:30“, „10:00 to
 * 11:30“) or „Dauer: 90 min / 1,5 h“ („Duration: 1.5 h“).
 */
export function meetingMinutes(body: string): number | null {
  const dur = /\b(?:Dauer|Duration)\s*:?\s*(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|std\.?|stunden?|min(?:uten|utes)?)\b/i.exec(body);
  if (dur) {
    const n = parseFloat(dur[1].replace(",", "."));
    const minutes = /^min/i.test(dur[2]) ? n : n * 60;
    return minutes > 0 && minutes <= 12 * 60 ? Math.round(minutes) : null;
  }
  const span = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\s*(?:Uhr\s*)?(?:–|-|—|bis|to)\s*([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(body);
  if (span) {
    const minutes = +span[3] * 60 + +span[4] - (+span[1] * 60 + +span[2]);
    return minutes > 0 && minutes <= 12 * 60 ? minutes : null;
  }
  return null;
}

/** `/zeit` duration: hours with a dot (`1.5h`), or minutes when not a quarter hour (`50m`). */
export function zeitDuration(minutes: number): string {
  if (minutes % 15 !== 0) return `${minutes}m`;
  return `${+(minutes / 60).toFixed(2)}h`;
}

/** „Buchungsvorschlag: `/zeit <ref> <dauer> <titel>`“ when the page has a Vorgang and a derivable duration. */
export function bookingSuggestion(reference: string | null, body: string, title: string): string | null {
  if (!reference) return null;
  const minutes = meetingMinutes(body);
  if (minutes == null) return null;
  const text = title.replace(/[`\n]/g, " ").trim();
  return `${t("aitext.bookingSuggestion")} \`${zeitCommand()} ${reference} ${zeitDuration(minutes)} ${text}\``;
}
