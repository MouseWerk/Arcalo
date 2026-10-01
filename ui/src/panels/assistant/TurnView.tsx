// One turn of the assistant chat: a question, an answer or a tool step. Turns are memoized:
// while an answer streams in, only that one renders again.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronRight, Copy, CornerDownLeft, FileInput, FilePlus2, FileText, Loader2, PencilLine, RefreshCw, Settings2, ShieldAlert, Timer, Wrench, X } from "lucide-react";
import { Button, IconButton } from "../../components/ui";
import { previewMarkdown } from "../../components/LinkPreview";
import { aiErrorSummary, routeNotes, waitText } from "../../lib/aierror";
import { citedNumbers, linkCitations } from "../../lib/citations";
import { renderChatMarkdown, renderChatMarkdownCached, renderMarkdown } from "../../lib/markdown";
import { h1, int, usd } from "../../lib/format";
import { t } from "../../lib/i18n";
import type { Turn } from "../../lib/chathistory";
import type { ContextChunk } from "../../lib/types";
import { revealText } from "../../editor/reveal";
import { useApp } from "../../store/app";
import { editAndResend, regenerate } from "../../store/chat";
import { TOOL_ICONS } from "./icons";
import { copyText, insertIntoPage, saveAnswerAsPage } from "./actions";

/** Characters of an answer rendered at a time; „Mehr anzeigen“ adds as many again. */
export const MAX_SHOWN = 100_000;

/** Opens a source: the page scrolled to the cited passage (flashed), or the timesheet. */
export function openSource(src: ContextChunk) {
  const s = useApp.getState();
  if (src.page_id == null) return s.openTab({ kind: "timesheet" });
  revealText(src.page_id, src.text, (id) => s.openPage(id)).catch(() => {});
}

const sourceLabel = (src: ContextChunk) => {
  const title = src.title ?? src.source.replace(/^Seite: /, "");
  return src.heading ? `${title} › ${src.heading}` : title;
};

/** Hover card of a citation chip, in the look of the link preview. */
function CiteCard({ src, n, rect, onEnter, onLeave }: { src: ContextChunk; n: number; rect: DOMRect; onEnter: () => void; onLeave: () => void }) {
  const W = Math.min(380, window.innerWidth - 16);
  const H = 260;
  const below = rect.bottom + 8 + H < window.innerHeight;
  const left = Math.max(8, Math.min(rect.left - 20, window.innerWidth - W - 8));
  const top = below ? rect.bottom + 6 : Math.max(8, rect.top - H - 6);
  const preview = previewMarkdown(src.text, 600);
  return createPortal(
    <div className="link-preview cite-card" role="tooltip" style={{ left, top, width: W, maxHeight: H }} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <button type="button" className="link-preview-title" onClick={() => openSource(src)}>
        <span className="cite cite-static">{n}</span>
        {src.page_id != null ? <FileText size={14} /> : <Timer size={14} />}
        <span className="cite-card-title">{sourceLabel(src)}</span>
      </button>
      <div className="prose prose-chat link-preview-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.text) }} />
      {preview.more && <div className="link-preview-fade" aria-hidden />}
    </div>,
    document.body,
  );
}

/** A failed request: the cause in plain words and what to do, „Erneut versuchen“; the server's message under „Details“. */
function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const e = aiErrorSummary(message);
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className="msg-error" role="alert">
      <div className="msg-error-head">
        <AlertTriangle size={14} aria-hidden />
        <span>{e.title}</span>
      </div>
      <div className="msg-error-hint">{offline ? t("chat.offlineHint") : e.hint}</div>
      <details className="msg-error-details">
        <summary>{t("chat.details")}</summary>
        <div className="mono">{message}</div>
      </details>
      <div className="msg-error-actions">
        {onRetry && (
          <Button size="sm" icon={RefreshCw} onClick={onRetry}>
            {t("chat.retry")}
          </Button>
        )}
        {e.settings && (
          <Button size="sm" variant="ghost" icon={Settings2} onClick={() => useApp.getState().openTab({ kind: "settings" })}>
            {t("chat.checkConnection")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** „Server kurz ausgelastet, neuer Versuch in 5 s“, counting down; Stop cancels the wait. */
function WaitNote({ until }: { until: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  return (
    <div className="msg-waiting" role="status">
      <Loader2 size={13} className="spin" />
      {waitText((until - now) / 1000)}
    </div>
  );
}

function dedupeSources(src: ContextChunk[]) {
  const seen = new Set<string>();
  return src.filter((x) => {
    if (!x || (x.page_id == null && x.time_entry_id == null)) return false;
    const k = x.page_id != null ? `p${x.page_id}` : `t${x.time_entry_id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** The question; the last one can be edited and sent again in its place. */
function UserTurn({ turn, editable }: { turn: Extract<Turn, { kind: "user" }>; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);
  const [copied, setCopied] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`;
  }, [draft, editing]);
  useEffect(() => {
    if (editing) {
      box.current?.focus();
      box.current?.setSelectionRange(draft.length, draft.length);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);
  if (editing)
    return (
      <div className="msg-user-wrap editing" data-turn={turn.id}>
        <textarea
          ref={box}
          className="msg-user-edit"
          value={draft}
          aria-label={t("chat.editQuestion")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              setEditing(false);
              editAndResend(turn.id, draft);
            }
          }}
        />
        <div className="msg-user-edit-actions">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            {t("chat.cancel")}
          </Button>
          <Button size="sm" variant="primary" icon={CornerDownLeft} disabled={!draft.trim()} onClick={() => (setEditing(false), editAndResend(turn.id, draft))}>
            {t("chat.resend")}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="msg-user-wrap" data-turn={turn.id}>
      <div className="msg-user">{turn.text}</div>
      <div className="msg-user-actions msg-actions">
        <IconButton
          icon={copied ? Check : Copy}
          label={t("chat.copy")}
          size="sm"
          tooltipSide="top"
          onClick={() => copyText(turn.text, () => (setCopied(true), window.setTimeout(() => setCopied(false), 1200)))}
        />
        {editable && (
          <IconButton
            icon={PencilLine}
            label={t("chat.editResend")}
            size="sm"
            tooltipSide="top"
            onClick={() => {
              setDraft(turn.text);
              setEditing(true);
            }}
          />
        )}
      </div>
    </div>
  );
}

function ToolTurn({ turn }: { turn: Extract<Turn, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICONS[turn.name] ?? Wrench;
  if (turn.status === "pending")
    return (
      <div className="tool-approval" role="alertdialog" aria-label={t("chat.approvalNeeded")}>
        <div className="tool-approval-head">
          <ShieldAlert size={15} aria-hidden />
          <span>{t("chat.approvalTitle", { tool: turn.label })}</span>
        </div>
        <pre className="tool-approval-cmd">{turn.summary}</pre>
        <div className="tool-approval-actions">
          <Button size="sm" variant="ghost" icon={X} onClick={() => turn.decide?.(false)}>
            {t("chat.reject")}
          </Button>
          <Button size="sm" variant="primary" icon={Check} onClick={() => turn.decide?.(true)}>
            {t("chat.run")}
          </Button>
        </div>
      </div>
    );
  const detail = turn.output ?? "";
  const expandable = !!detail && turn.status !== "running";
  return (
    <div className={`tool-step tool-${turn.status} ${open ? "open" : ""}`}>
      <button type="button" className="tool-step-head" aria-expanded={expandable ? open : undefined} disabled={!expandable} onClick={() => setOpen(!open)}>
        <span className="tool-step-icon">{turn.status === "running" ? <Loader2 size={13} className="spin" /> : <Icon size={13} />}</span>
        <span className="tool-step-label">{turn.label}</span>
        {turn.summary && <span className="tool-step-arg mono">{turn.summary}</span>}
        <span className="tool-step-state">
          {turn.status === "done" && <Check size={13} className="tool-ok" aria-label={t("chat.toolDone")} />}
          {turn.status === "rejected" && <span className="faint">{t("chat.rejected")}</span>}
          {turn.status === "error" && <span className="tool-err">{t("chat.toolFailed")}</span>}
          {expandable && <ChevronRight size={13} className="tool-step-chevron" aria-hidden />}
        </span>
      </button>
      {expandable && open && <pre className={`tool-output ${turn.status === "error" ? "tool-output-err" : ""}`}>{detail}</pre>}
    </div>
  );
}

function AnswerTurn({ turn, last, busy }: { turn: Extract<Turn, { kind: "assistant" }>; last: boolean; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const [limit, setLimit] = useState(MAX_SHOWN);
  const [cite, setCite] = useState<{ n: number; rect: DOMRect } | null>(null);
  const hideTimer = useRef<number | undefined>(undefined);
  const showTimer = useRef<number | undefined>(undefined);
  const prose = useRef<HTMLDivElement>(null);
  useEffect(
    () => () => {
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(showTimer.current);
    },
    [],
  );
  const m = turn.meta;
  const sources = turn.sources ?? [];
  const citeOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>(".cite[data-cite]") : null);
  const hideSoon = () => {
    window.clearTimeout(showTimer.current);
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setCite(null), 220);
  };
  // Cited sources first for the chips below the answer.
  const cited = citedNumbers(turn.text, sources.length);
  // A huge answer is shown shortened (rendering megabytes of Markdown freezes the window).
  const cut = turn.text.length > limit;
  const shown = cut ? turn.text.slice(0, limit) : turn.text;
  const copyLabel = t("chat.copyCode");
  const html = turn.streaming ? renderChatMarkdown(shown, copyLabel) : linkCitations(renderChatMarkdownCached(shown, copyLabel), sources.length);
  const chipSources = dedupeSources([...cited.map((n) => sources[n - 1]), ...sources]);
  const numberOf = (src: ContextChunk) => sources.indexOf(src) + 1;
  const retry = !busy && last ? () => regenerate(turn.id) : undefined;
  const pageTitleLabel = turn.pageTitle ? t("chat.insertNewPage") : t("chat.saveAsPage");
  return (
    <div className={`msg-ai ${last ? "last" : ""}`} data-turn={turn.id} aria-busy={turn.streaming || undefined}>
      {turn.error ? (
        <ErrorNote message={turn.error} onRetry={retry} />
      ) : turn.streaming && !turn.text && turn.waiting ? (
        <WaitNote until={turn.waiting.until} />
      ) : turn.streaming && !turn.text ? (
        <div className="thinking" role="status" aria-label={t("chat.thinking")}>
          <span />
          <span />
          <span />
        </div>
      ) : turn.text || !turn.cancelled ? (
        <div
          ref={prose}
          className={`prose prose-chat ${turn.streaming ? "streaming" : ""}`}
          dangerouslySetInnerHTML={{ __html: html }}
          onMouseOver={(e) => {
            const el = citeOf(e.target);
            if (!el) return;
            window.clearTimeout(hideTimer.current);
            window.clearTimeout(showTimer.current);
            const n = Number(el.dataset.cite);
            showTimer.current = window.setTimeout(() => el.isConnected && setCite({ n, rect: el.getBoundingClientRect() }), 180);
          }}
          onMouseOut={(e) => citeOf(e.target) && hideSoon()}
          onClick={(e) => {
            const copy = (e.target as HTMLElement).closest<HTMLElement>("[data-code-copy]");
            if (copy) {
              const code = copy.closest(".code-box")?.querySelector("code")?.textContent ?? "";
              copyText(code.replace(/\n$/, ""), () => {
                copy.classList.add("copied");
                window.setTimeout(() => copy.classList.remove("copied"), 1200);
              });
              return;
            }
            const el = citeOf(e.target);
            const src = el && sources[Number(el.dataset.cite) - 1];
            if (!src) return;
            e.preventDefault();
            e.stopPropagation();
            setCite(null);
            openSource(src);
          }}
          onKeyDown={(e) => {
            const el = citeOf(e.target);
            const src = el && sources[Number(el.dataset.cite) - 1];
            if (src && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              openSource(src);
            }
          }}
        />
      ) : null}
      {cite && sources[cite.n - 1] && <CiteCard src={sources[cite.n - 1]} n={cite.n} rect={cite.rect} onEnter={() => window.clearTimeout(hideTimer.current)} onLeave={hideSoon} />}
      {cut && (
        <div className="faint small msg-cut">
          <span>{t("chat.cut", { shown: limit.toLocaleString("de-DE"), total: turn.text.length.toLocaleString("de-DE") })}</span>
          <button type="button" className="link-btn" onClick={() => setLimit(limit + MAX_SHOWN)}>
            {t("chat.showMore")}
          </button>
        </div>
      )}
      {turn.cancelled && <div className="faint small msg-cancelled">{t("chat.cancelled")}</div>}
      {!turn.streaming && !turn.error && sources.length > 0 && chipSources.length > 0 && (
        <div className="sources">
          <span className="sources-label">{t("chat.sources")}</span>
          {chipSources.slice(0, 3).map((src) => (
            <button key={numberOf(src)} type="button" className="source" data-source={numberOf(src)} title={`[${numberOf(src)}] ${sourceLabel(src)}\n\n${src.text.slice(0, 300)}`} onClick={() => openSource(src)}>
              {src.page_id != null ? <FileText size={11} aria-hidden /> : <Timer size={11} aria-hidden />}
              <span>{src.source.replace(/^Seite: /, "")}</span>
            </button>
          ))}
        </div>
      )}
      {m && !turn.streaming && routeNotes(m.reasons).length > 0 && (
        <div className="msg-route-notes" role="note">
          {routeNotes(m.reasons).map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
      )}
      {!turn.streaming && !turn.error && (m || turn.text) && (
        <div className="msg-meta">
          {m && (
            <span className="msg-meta-stats">
              <span title={m.reasons.join("\n")}>
                <span className={`tier-dot tier-${m.tier}`} /> <span className="msg-meta-model">{m.model}</span>
              </span>
              {m.ttft != null && <span title={t("chat.ttft")}>{h1(m.ttft / 1000)} s</span>}
              {m.tps != null && <span title={t("chat.tps")}>{Math.round(m.tps)} t/s</span>}
              <span>
                {t("chat.tokens", { n: int(m.tokens) })}{m.exact ? "" : ` ${t("chat.estimated")}`}
              </span>
              {m.cost > 0 && <span>{usd(m.cost)}</span>}
            </span>
          )}
          {turn.text && (
            <span className="msg-actions">
              <IconButton
                icon={copied ? Check : Copy}
                label={t("chat.copy")}
                size="sm"
                tooltipSide="top"
                onClick={() => copyText(turn.text, () => (setCopied(true), window.setTimeout(() => setCopied(false), 1200)))}
              />
              <IconButton icon={FileInput} label={t("chat.insertIntoPage")} size="sm" tooltipSide="top" onClick={() => insertIntoPage(turn.text)} />
              <IconButton icon={FilePlus2} label={pageTitleLabel} size="sm" tooltipSide="top" onClick={() => saveAnswerAsPage(turn.text, turn.pageTitle)} />
              {retry && <IconButton icon={RefreshCw} label={t("chat.regenerate")} size="sm" tooltipSide="top" onClick={retry} />}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// Earlier turns keep their objects while an answer streams in, so only the streaming one renders.
export const TurnView = memo(function TurnView({ turn, last, busy, editable }: { turn: Turn; last: boolean; busy: boolean; editable: boolean }) {
  if (turn.kind === "user") return <UserTurn turn={turn} editable={editable} />;
  if (turn.kind === "tool") return <ToolTurn turn={turn} />;
  return <AnswerTurn turn={turn} last={last} busy={busy} />;
});
