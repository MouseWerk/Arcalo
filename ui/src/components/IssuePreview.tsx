// Hovering an issue chip (`PROJ-123` in a note) shows a card like the page-link preview: type,
// key, status, summary, assignee, due date and the start of the description.

import { useEffect, useRef, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useApp } from "../store/app";
import { jiraApi, useIssueIndex, type ChipIssue } from "../lib/jira";
import { openIssueInBrowser, openIssueNote } from "../lib/jiraActions";
import { TYPE_SVG, typeOf } from "../lib/issueTypes";
import { fmtDate } from "../lib/format";
import { t } from "../lib/i18n";
import { isKey } from "../lib/ime";

const editorPrefs = () => useApp.getState().settings?.settings.editor;

interface Shown {
  key: string;
  rect: DOMRect;
  issue: ChipIssue | null;
  error: string | null;
}

export function IssuePreview() {
  const [shown, setShown] = useState<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const hideTimer = useRef<number | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const chipOf = (el: EventTarget | null) => (el instanceof Element ? el.closest<HTMLElement>(".ProseMirror [data-issue]") : null);
    const onOver = (e: MouseEvent) => {
      if (card.current?.contains(e.target as Node)) return void window.clearTimeout(hideTimer.current);
      const chip = chipOf(e.target);
      if (!chip || editorPrefs()?.hover_preview === false) return;
      const key = chip.dataset.issue!;
      window.clearTimeout(hideTimer.current);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        if (!chip.isConnected || !chip.matches(":hover")) return;
        // The whole chip (icon, key and tail) is the anchor.
        const parts = [...(chip.closest(".ProseMirror")?.querySelectorAll<HTMLElement>(`[data-issue="${key}"]`) ?? [])].filter((p) => Math.abs(p.getBoundingClientRect().top - chip.getBoundingClientRect().top) < 4);
        const rect = parts.length ? parts.map((p) => p.getBoundingClientRect()).reduce((a, b) => new DOMRect(Math.min(a.left, b.left), Math.min(a.top, b.top), Math.max(a.right, b.right) - Math.min(a.left, b.left), Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top))) : chip.getBoundingClientRect();
        let issue: ChipIssue | null = useIssueIndex.getState().byKey.get(key) ?? null;
        let error: string | null = null;
        if (!issue) {
          try {
            issue = await jiraApi.fetch(key);
          } catch (err) {
            error = String(err);
          }
        }
        if (chip.matches(":hover")) setShown({ key, rect, issue, error });
      }, editorPrefs()?.hover_delay_ms ?? 450);
    };
    const onOut = (e: MouseEvent) => {
      const from = chipOf(e.target) ?? (card.current?.contains(e.target as Node) ? card.current : null);
      if (!from) return;
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
      hideTimer.current = window.setTimeout(() => setShown(null), 220);
    };
    const hide = () => {
      window.clearTimeout(timer.current);
      setShown(null);
    };
    const onKey = (e: KeyboardEvent) => isKey(e, "Escape") && hide();
    const onDown = (e: MouseEvent) => !card.current?.contains(e.target as Node) && hide();
    window.addEventListener("mouseover", onOver);
    window.addEventListener("mouseout", onOut);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("mouseover", onOver);
      window.removeEventListener("mouseout", onOut);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("mousedown", onDown);
      window.clearTimeout(timer.current);
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  if (!shown) return null;
  const W = 380;
  const H = 280;
  const below = shown.rect.bottom + 8 + H < window.innerHeight;
  const left = Math.max(8, Math.min(shown.rect.left, window.innerWidth - W - 8));
  const top = below ? shown.rect.bottom + 6 : Math.max(8, shown.rect.top - H - 6);
  const i = shown.issue;
  const kind = typeOf(i?.issue_type ?? "");
  const excerpt = i?.description ? (i.description.length > 320 ? `${i.description.slice(0, 320).trimEnd()}…` : i.description) : "";
  return (
    <div ref={card} className="link-preview issue-preview" role="tooltip" style={{ left, top, width: W, maxHeight: H }} onMouseLeave={() => (hideTimer.current = window.setTimeout(() => setShown(null), 220))}>
      <div className="issue-preview-head">
        <span className={`issue-type-icon issue-type-${kind}`} dangerouslySetInnerHTML={{ __html: TYPE_SVG[kind] }} aria-hidden />
        <span className="mono issue-preview-key">{shown.key}</span>
        {i && <span className={`issue-status cat-${i.status_category}`}>{i.status}</span>}
        <span className="grow" />
        {i && (
          <button type="button" className="issue-preview-open" title={t("jira.openBrowser")} aria-label={t("jira.openBrowser")} onClick={() => (void openIssueInBrowser(shown.key, i.url), setShown(null))}>
            <ExternalLink size={13} />
          </button>
        )}
      </div>
      {i ? (
        <>
          <button type="button" className="link-preview-title issue-preview-title" onClick={(e) => (void openIssueNote(shown.key, { newTab: e.ctrlKey || e.metaKey }), setShown(null))}>
            {i.summary}
          </button>
          <dl className="issue-preview-meta">
            <dt>{t("jira.col.assignee")}</dt>
            <dd>{i.assignee || t("jira.unassigned")}</dd>
            {i.due_date && (
              <>
                <dt>{t("jira.col.due")}</dt>
                <dd>{fmtDate(i.due_date)}</dd>
              </>
            )}
            {i.priority && (
              <>
                <dt>{t("jira.col.priority")}</dt>
                <dd>{i.priority}</dd>
              </>
            )}
          </dl>
          {excerpt ? <div className="issue-preview-desc">{excerpt}</div> : <div className="link-preview-empty">{t("jira.noDescription")}</div>}
        </>
      ) : (
        <div className="link-preview-empty">{shown.error ? t("jira.previewOffline", { key: shown.key }) : t("jira.notSynced", { key: shown.key })}</div>
      )}
    </div>
  );
}
