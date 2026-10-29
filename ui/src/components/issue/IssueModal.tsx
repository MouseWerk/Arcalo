// The issue view („Issue-Ansicht“): a Jira issue as Jira's own page shows it, in a modal over the
// app (a full-screen sheet on phones). Opened from a chip, a list row, a widget, the palette or a
// link inside another issue (they stack; „Zurück“ goes to the one before).
//
// The last copy shows at once (or a skeleton while there is none), then Jira's answer replaces it.
// Without a connection the copy stays, read-only, with „Stand von …“. Edits follow Jira's
// `editmeta`, save explicitly and can be undone where Jira allows; a change someone else made
// meanwhile is shown instead of overwritten (lib/issueFull.ts, src-tauri/src/issueview.rs).
//
// Keyboard: Esc closes, Tab stays inside, `e` edits the summary, `c` writes a comment, `t` changes
// the status; the focus goes back where it was when the view closes.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ChevronDown, Clock, Copy, Download, ExternalLink, Eye, FileText, History, ListPlus, MessageSquare, MoreHorizontal, Paperclip, Pencil, RefreshCw, ThumbsUp, Trash2, UserPlus, WifiOff, X } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Button, Dialog, IconButton, Segmented, useMenu, type MenuEntry } from "../ui";
import { DateInput, TimeInput } from "../DateInput";
import { useApp } from "../../store/app";
import { t } from "../../lib/i18n";
import { isComposing, isKey, isTab } from "../../lib/ime";
import { keys } from "../../lib/shortcut";
import { dateTime, fileSize, fmtDate, fmtDuration, isoDay, relative } from "../../lib/format";
import { TYPE_SVG, typeOf } from "../../lib/issueTypes";
import { addIssueTask, copyIssueKey, openIssueInBrowser, openIssueNote } from "../../lib/jiraActions";
import {
  PLACED_FIELDS,
  canDeleteComment,
  canEditComment,
  editable,
  fmtSeconds,
  fullApi,
  isImage,
  jiraIso,
  loadNewestFirst,
  ordered,
  saveNewestFirst,
  timeBar,
  useIssueModal,
  type Attachment,
  type EditField,
  type FieldInput,
  type FullView,
  type IssueFull,
  type IssueRef,
  type JComment,
  type Transition,
} from "../../lib/issueFull";
import { ConflictNotice, FieldControl, ShownValue, inputFilled, type Conflict } from "./editors";
import { Avatar, ImageViewer, JiraHtml, UserChip, followLink, loadImage, openImageViewer, useLazyImage } from "./media";
import { RichEditor, type RichEditorHandle } from "./RichEditor";
import { copyText } from "../../lib/clipboard";
import { useSingleFlight } from "../../lib/singleFlight";

const s = useApp.getState;

// ------------------------------------------------------------------ context

type SaveResult = { ok: true } | { conflict: Conflict } | { failed: true };

interface Ctx {
  view: FullView;
  issue: IssueFull;
  readOnly: boolean;
  setView: (v: FullView) => void;
  reload: () => void;
  save: (field: string, label: string, input: FieldInput, expected?: string) => Promise<SaveResult>;
  open: (key: string) => void;
  /** The field being edited (one at a time). */
  editing: string | null;
  setEditing: (id: string | null) => void;
}

const IssueCtx = createContext<Ctx | null>(null);
const useIssue = () => useContext(IssueCtx)!;

/** Jira's timestamp as „vor 2 Std.“ with the full date and time as its title. */
function When({ at }: { at: string }) {
  const iso = jiraIso(at);
  if (!iso) return null;
  return (
    <time dateTime={iso} title={dateTime(iso)}>
      {relative(iso)}
    </time>
  );
}

export function TypeGlyph({ name }: { name: string }) {
  const kind = typeOf(name);
  return <span className={`issue-type-icon issue-type-${kind}`} title={name} role="img" aria-label={name} dangerouslySetInnerHTML={{ __html: TYPE_SVG[kind] }} />;
}

function Status({ status }: { status: { name: string; category: string } }) {
  return <span className={`issue-status cat-${status.category}`}>{status.name}</span>;
}

// ------------------------------------------------------------------ the modal

/** Mounted once in the app; shows the issue on top of `useIssueModal`'s stack. */
export function IssueModal() {
  const stack = useIssueModal((st) => st.stack);
  const key = stack[stack.length - 1] ?? null;
  if (!key) return null;
  return createPortal(<IssueWindow key={key} issueKey={key} canGoBack={stack.length > 1} />, document.body);
}

function IssueWindow({ issueKey, canGoBack }: { issueKey: string; canGoBack: boolean }) {
  const [view, setViewState] = useState<FullView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const viewRef = useRef<FullView | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const setView = useCallback((v: FullView) => {
    viewRef.current = v;
    setViewState(v);
  }, []);
  const close = useIssueModal((st) => st.close);
  const back = useIssueModal((st) => st.back);
  const openKey = useIssueModal((st) => st.open);

  const load = useCallback(() => {
    setLoading(true);
    fullApi.load(issueKey).then(
      (v) => {
        setView(v);
        setError(null);
        setLoading(false);
      },
      (e) => {
        setLoading(false);
        if (!viewRef.current) setError(String(e));
        else s().error(t("iv.loadFailed"), e);
      },
    );
  }, [issueKey, setView]);

  useEffect(() => {
    let alive = true;
    fullApi.cached(issueKey).then((c) => alive && c && !viewRef.current && setView(c), () => {});
    load();
    return () => void (alive = false);
  }, [issueKey, load, setView]);

  // Focus: into the view, trapped there, back where it was when it closes.
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => box.current?.focus(), 20);
    return () => {
      window.clearTimeout(timer);
      if (prev?.isConnected) prev.focus({ preventScroll: true });
    };
  }, []);

  const save = useCallback(
    async (field: string, label: string, input: FieldInput, expected?: string): Promise<SaveResult> => {
      const current = viewRef.current;
      if (!current) return { failed: true };
      try {
        const r = await fullApi.update(issueKey, field, input, expected ?? current.issue.updated);
        if (r.outcome.outcome === "conflict") return { conflict: { field, updated: r.outcome.updated, value: r.outcome.value, by: r.outcome.by, input } };
        if (r.view) setView(r.view);
        const undo = r.outcome.undo;
        s().toast({
          tone: "success",
          key: `iv-${issueKey}-${field}`,
          title: t("iv.saved", { field: label }),
          action: undo
            ? {
                label: t("iv.undo"),
                run: async () => {
                  const now = viewRef.current;
                  if (!now) return;
                  try {
                    const u = await fullApi.update(issueKey, field, undo, now.issue.updated);
                    if (u.outcome.outcome === "conflict") s().toast({ tone: "warning", title: t("iv.undoConflict"), detail: label });
                    else if (u.view) (setView(u.view), s().toast({ tone: "info", key: `iv-${issueKey}-${field}`, title: t("iv.undone", { field: label }) }));
                  } catch (e) {
                    s().error(t("iv.saveFailed", { field: label }), e);
                  }
                },
              }
            : undefined,
        });
        return { ok: true };
      } catch (e) {
        s().error(t("iv.saveFailed", { field: label }), e);
        return { failed: true };
      }
    },
    [issueKey, setView],
  );

  // Keys on the window (bubbling, after the fields and editors had theirs): the focus may be on the
  // page after an edit closed, and Esc still closes the view.
  const live = useRef({ editing, view, close });
  live.current = { editing, view, close };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isComposing(e) || e.defaultPrevented) return;
      const el = box.current;
      if (!el) return;
      const target = e.target instanceof HTMLElement ? e.target : null;
      const typing = target?.closest("input, textarea, select, [contenteditable=true], .ProseMirror");
      // Something above the view (a menu, a dialog, the image viewer) handles its own keys.
      const above = [...document.querySelectorAll(".menu, .dialog, .iv-viewer, .select-pop, .calendar, .palette")].some((x) => !el.contains(x));
      if (above) return;
      const { editing: ed, view: v, close: shut } = live.current;
      if (isKey(e, "Escape")) {
        e.preventDefault();
        if (ed) setEditing(null);
        else shut();
        return;
      }
      // Shift+Tab arrives in WebKitGTK as ISO_Left_Tab, with an unidentified key: the code still says Tab.
      if (isTab(e)) {
        // The whole Tab order inside the view is ours: the browser's own order can leave it from an
        // element it counts differently (a scroll container, a hidden field row).
        const all = [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex], .ProseMirror")].filter(
          (x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.getClientRects().length > 0 && !x.closest("[hidden], [inert]"),
        );
        if (!all.length) return;
        const active = document.activeElement;
        e.preventDefault();
        let at = active instanceof HTMLElement ? all.indexOf(active) : -1;
        if (at < 0 && active && el.contains(active)) {
          // Focus on something outside the list (the view itself, a row): go on from its place.
          const after = all.findIndex((x) => !!(active.compareDocumentPosition(x) & Node.DOCUMENT_POSITION_FOLLOWING));
          at = after < 0 ? all.length : after;
          (e.shiftKey ? all[(at - 1 + all.length) % all.length] : all[at % all.length]).focus();
          return;
        }
        if (at < 0) (e.shiftKey ? all[all.length - 1] : all[0]).focus();
        else all[(at + (e.shiftKey ? all.length - 1 : 1)) % all.length].focus();
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey || !v || v.offline) return;
      if (e.key === "e" && editable(v.issue, "summary")) {
        e.preventDefault();
        setEditing("summary");
      } else if (e.key === "c" && v.issue.perms.comment) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("arcalo:issue-comment"));
      } else if (e.key === "t") {
        e.preventDefault();
        el.querySelector<HTMLButtonElement>(".iv-status-btn")?.click();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // An edit that closed hands the focus back to its value (not to the page behind).
  const lastEditing = useRef<string | null>(null);
  useEffect(() => {
    const prev = lastEditing.current;
    lastEditing.current = editing;
    if (!prev || editing) return;
    requestAnimationFrame(() => {
      const el = box.current;
      if (!el || el.contains(document.activeElement)) return;
      const back = el.querySelector<HTMLElement>(`[data-field="${prev}"] .iv-value.editable, [data-section="${prev}"] [aria-label], ${prev === "summary" ? ".iv-summary-btn" : "#none"}`);
      (back ?? el).focus({ preventScroll: true });
    });
  }, [editing]);

  const ctx: Ctx | null = view
    ? { view, issue: view.issue, readOnly: !!view.offline, setView, reload: load, save, open: openKey, editing, setEditing }
    : null;

  return (
    <div className="overlay iv-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={box} className="iv" role="dialog" aria-modal="true" aria-labelledby="iv-title" aria-busy={loading} tabIndex={-1} data-issue-view={issueKey}>
        {ctx ? (
          <IssueCtx.Provider value={ctx}>
            <Header canGoBack={canGoBack} onBack={back} onClose={close} loading={loading} />
            <div className="iv-scroll">
              <div className="iv-body">
                <main className="iv-main">
                  <Description />
                  <Environment />
                  <Subtasks />
                  <Links />
                  <Attachments />
                  <RemoteLinks />
                  <Tabs />
                </main>
                <aside className="iv-side" aria-label={t("iv.details")}>
                  <Details />
                </aside>
              </div>
            </div>
          </IssueCtx.Provider>
        ) : error ? (
          <ErrorState issueKey={issueKey} error={error} onRetry={load} onClose={close} />
        ) : (
          <SkeletonView issueKey={issueKey} onClose={close} />
        )}
      </div>
      <ImageViewer />
    </div>
  );
}

function SkeletonView({ issueKey, onClose }: { issueKey: string; onClose: () => void }) {
  return (
    <>
      <header className="iv-head">
        <div className="iv-crumbs">
          <span className="mono">{issueKey}</span>
        </div>
        {/* „In Jira öffnen“ and Close already where the loaded view has them: nothing jumps. */}
        <div className="iv-head-actions">
          <IconButton icon={ExternalLink} label={t("iv.openInJira")} onClick={() => void openIssueInBrowser(issueKey)} />
          <IconButton icon={MoreHorizontal} label={t("iv.more")} disabled />
          <IconButton icon={X} label={t("common.close")} onClick={onClose} />
        </div>
      </header>
      <h2 id="iv-title" className="sr-only">
        {issueKey}
      </h2>
      <div className="iv-skel" aria-label={t("common.loading")}>
        <span className="iv-skel-title" />
        <div className="iv-skel-body">
          <div className="iv-skel-main">
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
          <div className="iv-skel-side">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

function ErrorState({ issueKey, error, onRetry, onClose }: { issueKey: string; error: string; onRetry: () => void; onClose: () => void }) {
  return (
    <>
      <header className="iv-head">
        <div className="iv-crumbs">
          <span className="mono">{issueKey}</span>
        </div>
        <div className="iv-head-actions">
          <IconButton icon={X} label={t("common.close")} onClick={onClose} />
        </div>
      </header>
      <div className="iv-error" role="alert">
        <h2 id="iv-title">{t("iv.unavailable", { key: issueKey })}</h2>
        <p>{error}</p>
        <div className="iv-editor-actions">
          <Button icon={RefreshCw} onClick={onRetry}>
            {t("iv.retry")}
          </Button>
          <Button variant="ghost" icon={ExternalLink} onClick={() => void openIssueInBrowser(issueKey)}>
            {t("iv.openInJira")}
          </Button>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ header

function Header({ canGoBack, onBack, onClose, loading }: { canGoBack: boolean; onBack: () => void; onClose: () => void; loading: boolean }) {
  const { view, issue, readOnly, open, editing, setEditing, save, setView, reload } = useIssue();
  const [menu, , openMenuAt] = useMenu();
  const [transition, setTransition] = useState<Transition | null>(null);
  const [busy, setBusy] = useState(false);
  const summaryField = editable(issue, "summary");
  const once = useSingleFlight();

  const runTransition = (tr: Transition, inputs: [string, FieldInput][] = [], comment: unknown = null) => once(() => transitionNow(tr, inputs, comment));
  const transitionNow = async (tr: Transition, inputs: [string, FieldInput][], comment: unknown) => {
    setBusy(true);
    try {
      const before = issue.status.name;
      const r = await fullApi.transition(issue.key, tr.id, inputs, comment);
      setView(r.view);
      setTransition(null);
      s().toast({
        tone: "success",
        key: `iv-${issue.key}-status`,
        title: t("iv.moved", { key: issue.key, status: r.view.issue.status.name }),
        action: r.undo
          ? {
              label: t("iv.undo"),
              run: () =>
                void fullApi.transition(issue.key, r.undo!, [], null).then(
                  (u) => (setView(u.view), s().toast({ tone: "info", key: `iv-${issue.key}-status`, title: t("iv.moved", { key: issue.key, status: before }) })),
                  (e) => s().error(t("iv.transitionFailed"), e),
                ),
            }
          : undefined,
      });
    } catch (e) {
      s().error(t("iv.transitionFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const needsScreen = (tr: Transition) => tr.fields.some((f) => f.id !== "comment") || (tr.has_screen && tr.fields.length > 0);
  const statusItems = (): MenuEntry[] =>
    issue.transitions.length
      ? issue.transitions.map((tr) => ({ label: tr.name === tr.to.name ? tr.name : `${tr.name} → ${tr.to.name}`, onSelect: () => (needsScreen(tr) ? setTransition(tr) : void runTransition(tr)) }))
      : [{ label: t("iv.noTransitions"), disabled: true }];

  const assignMe = async () => {
    try {
      const r = await fullApi.assign(issue.key, null, false, issue.updated);
      if (r.outcome.outcome === "conflict") return s().toast({ tone: "warning", title: t("iv.conflict"), detail: t("iv.conflictReloadHint") });
      if (r.view) setView(r.view);
      const undo = r.outcome.undo;
      const before = undo?.t === "user" ? undo.v : null;
      s().toast({
        tone: "success",
        key: `iv-${issue.key}-assignee`,
        title: t("iv.assignedToMe", { key: issue.key }),
        action: {
          label: t("iv.undo"),
          run: () => void fullApi.assign(issue.key, before, before == null, r.view?.issue.updated ?? "").then((u) => u.view && setView(u.view), (e) => s().error(t("iv.assignFailed"), e)),
        },
      });
    } catch (e) {
      s().error(t("iv.assignFailed"), e);
    }
  };

  const moreItems = (): MenuEntry[] => [
    { label: view.note_page_id ? t("jira.openNote") : t("jira.createNote", { key: issue.key }), icon: FileText, onSelect: () => (useIssueModal.getState().close(), void openIssueNote(issue.key)) },
    { label: t("jira.copyKey"), icon: Copy, onSelect: () => void copyIssueKey(issue.key) },
    { label: t("iv.copyLink"), icon: Copy, onSelect: () => void copyText(issue.url).then(() => s().toast({ tone: "success", title: t("iv.linkCopied") }), (e) => s().error(t("common.copyFailed"), e)) },
    { label: t("jira.addTask"), icon: ListPlus, onSelect: () => void addIssueTask(issue.key) },
    "separator",
    { label: t("iv.reload"), icon: RefreshCw, onSelect: reload },
  ];

  const [summary, setSummary] = useState(issue.summary);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  useEffect(() => setSummary(issue.summary), [issue.summary]);
  const saveSummary = (expected?: string) =>
    once(async () => {
      if (summary.trim() === issue.summary) return setEditing(null);
      setBusy(true);
      const r = await save("summary", t("iv.f.summary"), { t: "text", v: summary }, expected);
      setBusy(false);
      if ("conflict" in r) setConflict(r.conflict);
      else if ("ok" in r) (setConflict(null), setEditing(null));
    });
  const meAssigned = issue.assignee?.id === issue.me.id;
  const crumbs: { key: string; type: string; label: string }[] = [];
  if (issue.parent) crumbs.push({ key: issue.parent.key, type: issue.parent.issue_type, label: issue.parent.summary });
  else if (issue.epic) crumbs.push({ key: issue.epic, type: "Epic", label: "" });

  return (
    <>
      <header className="iv-head">
        {canGoBack && <IconButton icon={ArrowLeft} label={t("iv.back")} onClick={onBack} />}
        <nav className="iv-crumbs" aria-label={t("iv.breadcrumb")}>
          <span className="iv-crumb-project ellipsis" title={issue.project.name}>
            {issue.project.name || issue.project.icon}
          </span>
          {crumbs.map((c) => (
            <span key={c.key} className="iv-crumb">
              <span className="iv-crumb-sep" aria-hidden>
                /
              </span>
              <button type="button" className="iv-crumb-link" title={c.label || c.key} onClick={() => open(c.key)}>
                <TypeGlyph name={c.type} />
                <span className="mono">{c.key}</span>
              </button>
            </span>
          ))}
          <span className="iv-crumb">
            <span className="iv-crumb-sep" aria-hidden>
              /
            </span>
            <TypeGlyph name={issue.issue_type.name} />
            <span className="mono iv-key">{issue.key}</span>
          </span>
        </nav>
        <div className="iv-head-actions">
          <button
            type="button"
            className={`iv-status-btn cat-${issue.status.category}`}
            aria-haspopup="menu"
            disabled={readOnly || busy || !issue.perms.transition}
            title={readOnly ? t("iv.readOnly") : `${t("iv.changeStatus")} (t)`}
            aria-label={t("iv.statusLabel", { status: issue.status.name })}
            onClick={(e) => openMenuAt(e, statusItems())}
          >
            <span>{issue.status.name}</span>
            {!readOnly && issue.perms.transition && <ChevronDown size={13} aria-hidden />}
          </button>
          {!readOnly && issue.perms.assign && issue.perms.assignable && !meAssigned && (
            <Button size="sm" variant="ghost" icon={UserPlus} className="iv-assign-me" onClick={() => void assignMe()}>
              {t("iv.assignMe")}
            </Button>
          )}
          <IconButton icon={ExternalLink} label={t("iv.openInJira")} onClick={() => void openIssueInBrowser(issue.key, issue.url)} />
          <IconButton aria-haspopup="menu" icon={MoreHorizontal} label={t("iv.more")} onClick={(e) => openMenuAt(e, moreItems())} />
          <IconButton icon={X} label={t("common.close")} onClick={onClose} />
        </div>
      </header>
      <div className="iv-titlebar">
        {editing === "summary" && summaryField ? (
          <div className="iv-summary-edit">
            <input
              className="input iv-summary-input"
              autoFocus
              value={summary}
              aria-label={t("iv.f.summary")}
              maxLength={255}
              onChange={(e) => setSummary(e.target.value)}
              onKeyDown={(e) => {
                if (isComposing(e)) return;
                if (isKey(e, "Enter")) (e.preventDefault(), void saveSummary());
                else if (isKey(e, "Escape")) (e.preventDefault(), e.stopPropagation(), setSummary(issue.summary), setConflict(null), setEditing(null));
              }}
            />
            <div className="iv-editor-actions">
              <Button size="sm" variant="primary" loading={busy} disabled={!summary.trim()} onClick={() => void saveSummary()}>
                {t("iv.save")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setSummary(issue.summary), setConflict(null), setEditing(null))}>
                {t("common.cancel")}
              </Button>
            </div>
            {conflict && <ConflictNotice conflict={conflict} issue={issue} onReload={() => (setConflict(null), setEditing(null), reload())} onOverwrite={() => void saveSummary(conflict.updated)} busy={busy} />}
          </div>
        ) : (
          <h2 id="iv-title" className="iv-summary">
            {summaryField && !readOnly ? (
              <button type="button" className="iv-summary-btn" title={`${t("iv.editSummary")} (e)`} onClick={() => setEditing("summary")}>
                {issue.summary}
              </button>
            ) : (
              issue.summary
            )}
          </h2>
        )}
        <div className="iv-subline">
          {view.site_name && (
            <span className="iv-site">
              <span className="iv-site-dot" style={{ background: view.site_color || "var(--text-3)" }} aria-hidden />
              {view.site_name}
            </span>
          )}
          <span className="faint">
            {t("iv.updated")} <When at={issue.updated} />
          </span>
          {loading && <span className="faint iv-refreshing">{t("iv.refreshing")}</span>}
        </div>
        {view.offline && (
          <div className="iv-offline" role="status">
            <WifiOff size={14} aria-hidden />
            <span>
              {t("iv.staleAt", { when: dateTime(view.fetched_at) })} · {view.offline}
            </span>
            <Button size="sm" variant="ghost" icon={RefreshCw} onClick={reload}>
              {t("iv.retry")}
            </Button>
          </div>
        )}
      </div>
      {transition && <TransitionDialog transition={transition} busy={busy} onCancel={() => setTransition(null)} onRun={(inputs, comment) => void runTransition(transition, inputs, comment)} />}
      {menu}
    </>
  );
}

// ------------------------------------------------------------------ transitions

function TransitionDialog({ transition, busy, onCancel, onRun }: { transition: Transition; busy: boolean; onCancel: () => void; onRun: (inputs: [string, FieldInput][], comment: unknown) => void }) {
  const { issue } = useIssue();
  const fields = transition.fields.filter((f) => f.id !== "comment" && f.kind !== "unsupported");
  const withComment = transition.fields.some((f) => f.id === "comment");
  const [values, setValues] = useState<Record<string, FieldInput | null>>(() => Object.fromEntries(fields.map((f) => [f.id, f.current])));
  const comment = useRef<RichEditorHandle>(null);
  const missing = fields.filter((f) => f.required && !inputFilled(f, values[f.id] ?? null));
  const run = () => {
    if (missing.length) return;
    const inputs = fields.filter((f) => values[f.id] != null).map((f) => [f.id, values[f.id]!] as [string, FieldInput]);
    onRun(inputs, withComment && comment.current && !comment.current.isEmpty() ? comment.current.json() : null);
  };
  return (
    <Dialog
      open
      onClose={onCancel}
      title={transition.name}
      description={t("iv.transitionTo", { key: issue.key, status: transition.to.name })}
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" loading={busy} disabled={missing.length > 0} onClick={run}>
            {transition.name}
          </Button>
        </>
      }
    >
      <div className="iv-screen">
        {fields.map((f) => (
          <div key={f.id} className="iv-screen-field" data-field={f.id}>
            <label className="iv-screen-label">
              {f.name}
              {f.required && (
                <span className="iv-required" aria-label={t("iv.required")}>
                  *
                </span>
              )}
            </label>
            <FieldControl bare issue={issue} field={f} value={values[f.id] ?? null} onChange={(v) => setValues((old) => ({ ...old, [f.id]: v }))} />
          </div>
        ))}
        {withComment && (
          <div className="iv-screen-field">
            <label className="iv-screen-label">{t("iv.comment")}</label>
            <RichEditor ref={comment} initial={null} compact label={t("iv.comment")} placeholder={t("iv.commentPh")} onSubmit={run} />
          </div>
        )}
        {missing.length > 0 && <div className="faint small">{t("iv.fillRequired", { fields: missing.map((f) => f.name).join(", ") })}</div>}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ main column

function Section({ title, count, icon: Icon, children, actions, id }: { title: string; count?: number; icon?: typeof Paperclip; children: React.ReactNode; actions?: React.ReactNode; id: string }) {
  return (
    <section className="iv-section" aria-labelledby={`iv-s-${id}`} data-section={id}>
      <div className="iv-section-head">
        <h3 id={`iv-s-${id}`}>
          {Icon && <Icon size={14} aria-hidden />}
          {title}
          {count != null && <span className="iv-count">{count}</span>}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Description() {
  const { issue, readOnly, editing, setEditing, save, reload } = useIssue();
  const f = editable(issue, "description");
  const [value, setValue] = useState<FieldInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const on = editing === "description" && !!f;
  const start = () => (setValue(f?.current ?? { t: "doc", v: null }), setConflict(null), setEditing("description"));
  const once = useSingleFlight();
  const commit = (expected?: string, input = value) =>
    once(async () => {
      if (!input) return;
      setBusy(true);
      const r = await save("description", t("iv.f.description"), input, expected);
      setBusy(false);
      if ("conflict" in r) setConflict(r.conflict);
      else if ("ok" in r) setEditing(null);
    });
  return (
    <Section
      id="description"
      title={t("iv.f.description")}
      actions={f && !readOnly && !on ? <IconButton icon={Pencil} size="sm" label={t("iv.editDescription")} onClick={start} /> : undefined}
    >
      {on && f ? (
        <>
          <FieldControl issue={issue} field={f} value={value} onChange={setValue} onSave={(v) => void commit(undefined, v ?? value)} onCancel={() => (setEditing(null), setConflict(null))} busy={busy} />
          {conflict && <ConflictNotice conflict={conflict} issue={issue} onReload={() => (setConflict(null), setEditing(null), reload())} onOverwrite={() => void commit(conflict.updated)} busy={busy} />}
        </>
      ) : issue.description_html.trim() ? (
        <JiraHtml html={issue.description_html} issue={issue} className="iv-description" />
      ) : f && !readOnly ? (
        <button type="button" className="iv-empty-edit" onClick={start}>
          {t("iv.addDescription")}
        </button>
      ) : (
        <p className="faint">{t("jira.noDescription")}</p>
      )}
    </Section>
  );
}

function Environment() {
  const { issue } = useIssue();
  if (!issue.environment_html.trim()) return null;
  return (
    <Section id="environment" title={t("iv.f.environment")}>
      <JiraHtml html={issue.environment_html} issue={issue} />
    </Section>
  );
}

function RefRow({ r, prefix }: { r: IssueRef; prefix?: string }) {
  const { open } = useIssue();
  return (
    <li>
      <button type="button" className="iv-ref" onClick={() => open(r.key)} title={`${r.key} ${r.summary}`}>
        {prefix && <span className="faint iv-ref-prefix">{prefix}</span>}
        <TypeGlyph name={r.issue_type} />
        <span className="mono iv-ref-key">{r.key}</span>
        <span className={`iv-ref-summary ellipsis ${r.status.category === "done" ? "done" : ""}`}>{r.summary}</span>
        {r.priority && <span className="faint small iv-ref-prio">{r.priority}</span>}
        <Status status={r.status} />
      </button>
    </li>
  );
}

function Subtasks() {
  const { issue } = useIssue();
  if (!issue.subtasks.length) return null;
  const done = issue.subtasks.filter((x) => x.status.category === "done").length;
  return (
    <Section id="subtasks" title={t("iv.subtasks")} count={issue.subtasks.length} actions={<span className="faint small">{t("iv.doneOf", { done, n: issue.subtasks.length })}</span>}>
      <div className="iv-progress" aria-hidden>
        <span style={{ width: `${(done / issue.subtasks.length) * 100}%` }} />
      </div>
      <ul className="iv-refs">
        {issue.subtasks.map((r) => (
          <RefRow key={r.key} r={r} />
        ))}
      </ul>
    </Section>
  );
}

function Links() {
  const { issue } = useIssue();
  if (!issue.links.length) return null;
  const n = issue.links.reduce((a, g) => a + g.issues.length, 0);
  return (
    <Section id="links" title={t("iv.links")} count={n}>
      {issue.links.map((g) => (
        <div key={g.label} className="iv-link-group">
          <h4>{g.label}</h4>
          <ul className="iv-refs">
            {g.issues.map((l) => (
              <RefRow key={l.link_id} r={l.issue} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

/** Attachments shown before „Alle zeigen“ (100 thumbnails would load at once otherwise). */
const ATTACH_FIRST = 24;

function AttachmentCard({ a }: { a: Attachment }) {
  const { issue } = useIssue();
  const image = isImage(a);
  const [ref, thumb] = useLazyImage(issue.site, image ? a.thumbnail || a.content : null);
  const [busy, setBusy] = useState(false);
  const open = async () => {
    if (image) {
      setBusy(true);
      try {
        openImageViewer(await loadImage(issue.site, a.content), a.filename);
      } catch (e) {
        s().error(t("iv.attachmentFailed", { name: a.filename }), e);
      } finally {
        setBusy(false);
      }
      return;
    }
    setBusy(true);
    await fullApi.attachment(issue.site, a.content, a.filename, null).catch((e) => s().error(t("iv.attachmentFailed", { name: a.filename }), e));
    setBusy(false);
  };
  const download = async () => {
    const target = await saveDialog({ defaultPath: a.filename }).catch(() => null);
    if (!target) return;
    setBusy(true);
    try {
      await fullApi.attachment(issue.site, a.content, a.filename, target);
      s().toast({ tone: "success", title: t("iv.saved2", { name: a.filename }) });
    } catch (e) {
      s().error(t("iv.attachmentFailed", { name: a.filename }), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="iv-att" data-attachment={a.id}>
      <button type="button" className="iv-att-thumb" ref={ref as React.RefObject<HTMLButtonElement>} aria-label={t("iv.openAttachment", { name: a.filename })} onClick={() => void open()} disabled={busy}>
        {thumb ? <img src={thumb} alt="" /> : <Paperclip size={18} aria-hidden />}
      </button>
      <div className="iv-att-meta">
        <span className="iv-att-name ellipsis" title={a.filename}>
          {a.filename}
        </span>
        <span className="faint small">
          {fileSize(a.size)}
          {a.created && (
            <>
              {" · "}
              <When at={a.created} />
            </>
          )}
        </span>
      </div>
      <IconButton icon={Download} size="sm" label={t("iv.download", { name: a.filename })} onClick={() => void download()} />
    </li>
  );
}

function Attachments() {
  const { issue } = useIssue();
  const [all, setAll] = useState(false);
  if (!issue.attachments.length) return null;
  const shown = all ? issue.attachments : issue.attachments.slice(0, ATTACH_FIRST);
  return (
    <Section id="attachments" title={t("iv.attachments")} icon={Paperclip} count={issue.attachments.length}>
      <ul className="iv-atts">
        {shown.map((a) => (
          <AttachmentCard key={a.id} a={a} />
        ))}
      </ul>
      {!all && issue.attachments.length > ATTACH_FIRST && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
          {t("iv.showAll", { n: issue.attachments.length })}
        </Button>
      )}
    </Section>
  );
}

function RemoteLinks() {
  const { issue } = useIssue();
  if (!issue.remote_links.length) return null;
  return (
    <Section id="remote" title={t("iv.remoteLinks")} count={issue.remote_links.length}>
      <ul className="iv-remotes">
        {issue.remote_links.map((l) => (
          <li key={l.id}>
            <button type="button" className="iv-remote" onClick={() => followLink(l.url)} title={l.url}>
              <ExternalLink size={13} aria-hidden />
              <span className="ellipsis">{l.title}</span>
              {l.relationship && <span className="faint small">{l.relationship}</span>}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ------------------------------------------------------------------ tabs

type TabId = "comments" | "worklog" | "history";

function Tabs() {
  const { issue } = useIssue();
  const [tab, setTab] = useState<TabId>("comments");
  useEffect(() => {
    const go = () => setTab("comments");
    window.addEventListener("arcalo:issue-comment", go);
    return () => window.removeEventListener("arcalo:issue-comment", go);
  }, []);
  const tabs: { id: TabId; label: string; count: number; icon: typeof Clock }[] = [
    { id: "comments", label: t("iv.comments"), count: issue.comments.total, icon: MessageSquare },
    { id: "worklog", label: t("iv.worklog"), count: issue.worklogs.total, icon: Clock },
    { id: "history", label: t("iv.history"), count: issue.history.total, icon: History },
  ];
  const keyNav = (e: React.KeyboardEvent, i: number) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.id);
    (e.currentTarget.parentElement?.querySelector(`[data-tab="${next.id}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <section className="iv-section iv-activity" aria-label={t("iv.activity")}>
      <div className="iv-tabs" role="tablist" aria-label={t("iv.activity")}>
        {tabs.map((x, i) => (
          <button key={x.id} type="button" role="tab" id={`iv-tab-${x.id}`} data-tab={x.id} aria-selected={tab === x.id} aria-controls={`iv-panel-${x.id}`} tabIndex={tab === x.id ? 0 : -1} className={`iv-tab ${tab === x.id ? "on" : ""}`} onClick={() => setTab(x.id)} onKeyDown={(e) => keyNav(e, i)}>
            <x.icon size={13} aria-hidden />
            {x.label}
            <span className="iv-count">{x.count}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`iv-panel-${tab}`} aria-labelledby={`iv-tab-${tab}`} className="iv-tabpanel">
        {tab === "comments" ? <Comments /> : tab === "worklog" ? <Worklogs /> : <HistoryList />}
      </div>
    </section>
  );
}

function Comments() {
  const { issue, readOnly, setView } = useIssue();
  const [newestFirst, setNewestFirst] = useState(loadNewestFirst);
  const [extra, setExtra] = useState<JComment[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDoc, setEditDoc] = useState<{ id: string; doc: unknown; lossy: string[] } | null>(null);
  const composer = useRef<RichEditorHandle>(null);
  const editor = useRef<RichEditorHandle>(null);
  useEffect(() => setExtra([]), [issue.updated]);
  useEffect(() => {
    const go = () => window.setTimeout(() => composer.current?.focus(), 30);
    window.addEventListener("arcalo:issue-comment", go);
    return () => window.removeEventListener("arcalo:issue-comment", go);
  }, []);
  const items = useMemo(() => [...issue.comments.items, ...extra], [issue.comments.items, extra]);
  const more = issue.comments.total - items.length;
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fullApi.comments(issue.key, items.length);
      setExtra((old) => [...old, ...page.items.filter((c) => !items.some((x) => x.id === c.id))]);
    } catch (e) {
      s().error(t("iv.loadFailed"), e);
    } finally {
      setLoadingMore(false);
    }
  };
  const once = useSingleFlight();
  const add = () => once(addNow);
  const addNow = async () => {
    const c = composer.current;
    if (!c || c.isEmpty()) return;
    setBusy(true);
    try {
      const r = await fullApi.commentAdd(issue.key, c.json());
      setView(r.view);
      setComposerKey((k) => k + 1);
      s().toast({
        tone: "success",
        key: `iv-${issue.key}-comment`,
        title: t("iv.commented"),
        action: { label: t("iv.undo"), run: () => void fullApi.commentDelete(issue.key, r.id).then(setView, (e) => s().error(t("iv.commentFailed"), e)) },
      });
    } catch (e) {
      s().error(t("iv.commentFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const [composerKey, setComposerKey] = useState(0);
  const startEdit = async (c: JComment) => {
    try {
      const d = await fullApi.bodyDoc(c.body);
      setEditDoc({ id: c.id, doc: d.doc, lossy: d.lossy });
      setEditingId(c.id);
    } catch (e) {
      s().error(t("iv.commentFailed"), e);
    }
  };
  const saveEdit = () => once(saveEditNow);
  const saveEditNow = async () => {
    if (!editingId || !editor.current || editor.current.isEmpty()) return;
    setBusy(true);
    try {
      setView(await fullApi.commentEdit(issue.key, editingId, editor.current.json()));
      setEditingId(null);
      s().toast({ tone: "success", title: t("iv.commentSaved") });
    } catch (e) {
      s().error(t("iv.commentFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: JComment) => {
    if (!(await s().confirm({ title: t("iv.deleteComment"), message: t("iv.deleteCommentQ"), confirmLabel: t("iv.delete"), danger: true }))) return;
    try {
      setView(await fullApi.commentDelete(issue.key, c.id));
      s().toast({ tone: "success", title: t("iv.commentDeleted") });
    } catch (e) {
      s().error(t("iv.commentFailed"), e);
    }
  };
  const list = ordered(items, newestFirst);
  const moreButton = more > 0 && (
    <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => void loadMore()} className="iv-more">
      {t("iv.olderComments", { n: more })}
    </Button>
  );
  return (
    <div className="iv-comments">
      <div className="iv-list-tools">
        <Segmented
          label={t("iv.order")}
          value={newestFirst ? "new" : "old"}
          onChange={(v) => (setNewestFirst(v === "new"), saveNewestFirst(v === "new"))}
          options={[
            { value: "new", label: t("iv.newestFirst") },
            { value: "old", label: t("iv.oldestFirst") },
          ]}
        />
      </div>
      {issue.perms.comment && !readOnly && (
        <div className="iv-composer">
          <Avatar user={issue.me} site={issue.site} />
          <div className="grow">
            <RichEditor key={composerKey} ref={composer} initial={null} compact label={t("iv.comment")} placeholder={t("iv.commentPh")} onSubmit={() => void add()} />
            <div className="iv-editor-actions">
              <Button size="sm" variant="primary" loading={busy} onClick={() => void add()}>
                {t("iv.addComment")}
              </Button>
              <span className="faint small">{t("iv.commentHint", { keys: keys("Mod Enter") })}</span>
            </div>
          </div>
        </div>
      )}
      {!newestFirst && moreButton}
      {list.length === 0 && <p className="faint">{t("iv.noComments")}</p>}
      <ol className="iv-thread">
        {list.map((c) => (
          <li key={c.id} className="iv-comment" data-comment={c.id}>
            <Avatar user={c.author} site={issue.site} />
            <div className="iv-comment-main">
              <div className="iv-comment-head">
                <b>{c.author?.name ?? t("iv.anonymous")}</b>
                <span className="faint small">
                  <When at={c.created} />
                  {c.updated && c.updated !== c.created && <> · {t("iv.edited")}</>}
                </span>
                <span className="grow" />
                {!readOnly && canEditComment(issue.perms, c) && editingId !== c.id && <IconButton icon={Pencil} size="sm" label={t("iv.editComment")} onClick={() => void startEdit(c)} />}
                {!readOnly && canDeleteComment(issue.perms, c) && <IconButton icon={Trash2} size="sm" label={t("iv.deleteComment")} onClick={() => void remove(c)} />}
              </div>
              {editingId === c.id && editDoc?.id === c.id ? (
                <div className="iv-editor">
                  {editDoc.lossy.length > 0 && <div className="iv-note small">{t("iv.lossy", { what: editDoc.lossy.join(", ") })}</div>}
                  <RichEditor ref={editor} initial={editDoc.doc} label={t("iv.editComment")} autofocus onSubmit={() => void saveEdit()} onCancel={() => setEditingId(null)} />
                  <div className="iv-editor-actions">
                    <Button size="sm" variant="primary" loading={busy} onClick={() => void saveEdit()}>
                      {t("iv.save")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <JiraHtml html={c.html} issue={issue} className="iv-comment-body" />
              )}
            </div>
          </li>
        ))}
      </ol>
      {newestFirst && moreButton}
    </div>
  );
}

function Worklogs() {
  const { issue, view, readOnly, setView } = useIssue();
  const [extra, setExtra] = useState<IssueFull["worklogs"]["items"]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setExtra([]), [issue.updated]);
  const items = [...issue.worklogs.items, ...extra];
  const more = issue.worklogs.total - items.length;
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fullApi.worklogs(issue.key, items.length);
      setExtra((old) => [...old, ...page.items.filter((w) => !items.some((x) => x.id === w.id))]);
    } catch (e) {
      s().error(t("iv.loadFailed"), e);
    } finally {
      setLoadingMore(false);
    }
  };
  return (
    <div className="iv-worklogs">
      {issue.perms.log_work && !readOnly && <WorklogForm view={view} onDone={setView} />}
      {items.length === 0 && <p className="faint">{t("iv.noWorklogs")}</p>}
      <ol className="iv-thread">
        {items.map((w) => (
          <li key={w.id} className="iv-comment" data-worklog={w.id}>
            <Avatar user={w.author} site={issue.site} />
            <div className="iv-comment-main">
              <div className="iv-comment-head">
                <b>{w.author?.name ?? t("iv.anonymous")}</b>
                <span className="iv-worklog-time">{w.time_spent || fmtSeconds(w.seconds)}</span>
                <span className="faint small">
                  <When at={w.started} />
                </span>
              </div>
              {w.comment && <div className="iv-worklog-comment">{w.comment}</div>}
            </div>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => void loadMore()} className="iv-more">
          {t("iv.olderWorklogs", { n: more })}
        </Button>
      )}
    </div>
  );
}

function WorklogForm({ view, onDone }: { view: FullView; onDone: (v: FullView) => void }) {
  const { issue } = view;
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const [duration, setDuration] = useState("");
  const [day, setDay] = useState(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  const [hm, setHm] = useState(`${pad(Math.max(0, now.getHours() - 1))}:${pad(now.getMinutes())}`);
  const [comment, setComment] = useState("");
  const [book, setBook] = useState(view.time_tracking && !!view.wbs);
  const [busy, setBusy] = useState(false);
  const once = useSingleFlight();
  const submit = () => once(submitNow);
  const submitNow = async () => {
    if (!duration.trim()) return;
    setBusy(true);
    try {
      const started = new Date(`${day}T${hm || "09:00"}:00`).toISOString();
      const r = await fullApi.worklogAdd(issue.key, started, duration, comment, book && view.time_tracking);
      onDone(r.view);
      setDuration("");
      setComment("");
      const worklog = r.worklog_id;
      s().toast({
        tone: "success",
        key: `iv-${issue.key}-worklog`,
        title: r.entry_id != null ? t("iv.workLoggedBooked", { time: duration }) : t("iv.workLogged", { time: duration }),
        action: worklog && r.entry_id == null ? { label: t("iv.undo"), run: () => void fullApi.worklogDelete(issue.key, worklog).then(onDone, (e) => s().error(t("iv.worklogFailed"), e)) } : undefined,
      });
      if (r.entry_id != null) s().bumpEntries();
    } catch (e) {
      s().error(t("iv.worklogFailed"), e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="iv-worklog-form"
      aria-label={t("iv.logWork")}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="iv-worklog-row">
        <label className="iv-mini-field">
          <span>{t("iv.duration")}</span>
          <input className="input" value={duration} placeholder={t("iv.durationPh")} aria-label={t("iv.duration")} onChange={(e) => setDuration(e.target.value)} />
        </label>
        <label className="iv-mini-field">
          <span>{t("iv.started")}</span>
          <span className="iv-row-controls">
            <DateInput value={day} aria-label={t("iv.startedDay")} onChange={setDay} />
            <TimeInput value={hm} aria-label={t("iv.startedTime")} onChange={setHm} />
          </span>
        </label>
      </div>
      <label className="iv-mini-field">
        <span>{t("iv.worklogComment")}</span>
        <input className="input" value={comment} aria-label={t("iv.worklogComment")} onChange={(e) => setComment(e.target.value)} />
      </label>
      <div className="iv-editor-actions">
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!duration.trim()}>
          {t("iv.logWork")}
        </Button>
        {view.time_tracking && (
          <label className="iv-check">
            <input type="checkbox" className="check" checked={book} onChange={(e) => setBook(e.target.checked)} />
            <span>{view.wbs ? t("iv.bookToo", { wbs: view.wbs }) : t("iv.bookTooNoWbs")}</span>
          </label>
        )}
      </div>
    </form>
  );
}

function HistoryList() {
  const { issue } = useIssue();
  const [extra, setExtra] = useState<IssueFull["history"]["items"]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  useEffect(() => setExtra([]), [issue.updated]);
  const items = [...issue.history.items, ...extra];
  const more = issue.history.total - items.length;
  const loadMore = async () => {
    setLoadingMore(true);
    try {
      const page = await fullApi.history(issue.key, items.length);
      setExtra((old) => [...old, ...page.items.filter((h) => !items.some((x) => x.id === h.id))]);
    } catch (e) {
      s().error(t("iv.loadFailed"), e);
    } finally {
      setLoadingMore(false);
    }
  };
  const cut = (v: string) => (v.length > 240 ? `${v.slice(0, 240)}…` : v);
  return (
    <div className="iv-history">
      {items.length === 0 && <p className="faint">{t("iv.noHistory")}</p>}
      <ol className="iv-thread">
        {items.map((h) => (
          <li key={h.id} className="iv-comment" data-history={h.id}>
            <Avatar user={h.author} site={issue.site} />
            <div className="iv-comment-main">
              <div className="iv-comment-head">
                <b>{h.author?.name ?? t("iv.anonymous")}</b>
                <span className="faint small">
                  <When at={h.created} />
                </span>
              </div>
              <ul className="iv-changes">
                {h.items.map((c, i) => (
                  <li key={i}>
                    <span className="iv-change-field">{c.field}</span>
                    <span className="iv-change-from">{c.from ? cut(c.from) : t("iv.none")}</span>
                    <span className="faint" aria-label={t("iv.changedTo")}>
                      →
                    </span>
                    <span className="iv-change-to">{c.to ? cut(c.to) : t("iv.none")}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ol>
      {more > 0 && (
        <Button size="sm" variant="ghost" loading={loadingMore} onClick={() => void loadMore()} className="iv-more">
          {t("iv.olderHistory", { n: more })}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ details

/** One row of the details: its value, editable in place where Jira allows it. */
function FieldRow({ id, label, children, empty }: { id: string; label: string; children?: React.ReactNode; empty?: boolean }) {
  const { issue, readOnly, editing, setEditing, save, reload } = useIssue();
  const f = editable(issue, id);
  const [value, setValue] = useState<FieldInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const on = editing === id && !!f && !readOnly;
  const start = () => (setValue(f?.current ?? null), setConflict(null), setEditing(id));
  const once = useSingleFlight();
  const commit = (expected?: string, input?: FieldInput | null) =>
    once(async () => {
      const v = input ?? value;
      if (!v || !f) return;
      setBusy(true);
      const r = await save(id, label, v, expected);
      setBusy(false);
      if ("conflict" in r) setConflict(r.conflict);
      else if ("ok" in r) (setConflict(null), setEditing(null));
    });
  const shown = empty ? <span className="faint">{t("iv.none")}</span> : children;
  return (
    <div className={`iv-field ${on ? "editing" : ""}`} data-field={id}>
      <dt>{label}</dt>
      <dd>
        {on && f ? (
          <>
            <FieldControl issue={issue} field={f} value={value} onChange={setValue} onSave={(v) => void commit(undefined, v)} onCancel={() => (setConflict(null), setEditing(null))} busy={busy} />
            {conflict && <ConflictNotice conflict={conflict} issue={issue} onReload={() => (setConflict(null), setEditing(null), reload())} onOverwrite={() => void commit(conflict.updated, conflict.input)} busy={busy} />}
          </>
        ) : f && !readOnly ? (
          <button type="button" className="iv-value editable" aria-label={t("iv.editField", { field: label })} onClick={start}>
            {shown}
            <Pencil size={12} className="iv-value-pen" aria-hidden />
          </button>
        ) : (
          <div className="iv-value">{shown}</div>
        )}
      </dd>
    </div>
  );
}

function Plain({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="iv-field">
      <dt>{label}</dt>
      <dd>
        <div className="iv-value">{children}</div>
      </dd>
    </div>
  );
}

const chips = (list: string[]) => (
  <span className="iv-chips">
    {list.map((x) => (
      <span key={x} className="iv-chip">
        {x}
      </span>
    ))}
  </span>
);

function Details() {
  const { issue, view, open } = useIssue();
  const placed = useMemo(() => new Set([...PLACED_FIELDS, "assignee", "reporter", "priority", "labels", "components", "fixVersions", "versions", "duedate", issue.story_points_field].filter(Boolean)), [issue.story_points_field]);
  const shownIds = new Set(issue.custom.map((c) => c.id));
  // Editable fields without a value: listed too, so they can be filled.
  const emptyEditable: EditField[] = issue.edit.filter((f) => !placed.has(f.id) && !shownIds.has(f.id) && editable(issue, f.id));
  const bar = timeBar(issue.time);
  const t3 = issue.time;
  return (
    <>
      <dl className="iv-fields">
        <FieldRow id="assignee" label={t("iv.f.assignee")}>
          <UserChip user={issue.assignee} site={issue.site} />
        </FieldRow>
        <FieldRow id="reporter" label={t("iv.f.reporter")}>
          <UserChip user={issue.reporter} site={issue.site} empty={t("iv.none")} />
        </FieldRow>
        <FieldRow id="priority" label={t("iv.f.priority")} empty={!issue.priority}>
          {issue.priority && <span className="iv-prio">{issue.priority.name}</span>}
        </FieldRow>
        <FieldRow id="labels" label={t("iv.f.labels")} empty={!issue.labels.length}>
          {chips(issue.labels)}
        </FieldRow>
        <FieldRow id="components" label={t("iv.f.components")} empty={!issue.components.length}>
          {chips(issue.components)}
        </FieldRow>
        <FieldRow id="fixVersions" label={t("iv.f.fixVersions")} empty={!issue.fix_versions.length}>
          {chips(issue.fix_versions)}
        </FieldRow>
        {(issue.affects_versions.length > 0 || editable(issue, "versions")) && (
          <FieldRow id="versions" label={t("iv.f.affectsVersions")} empty={!issue.affects_versions.length}>
            {chips(issue.affects_versions)}
          </FieldRow>
        )}
        {issue.sprints.length > 0 && <Plain label={t("iv.f.sprint")}>{<ShownValue value={{ t: "sprints", v: issue.sprints }} issue={issue} />}</Plain>}
        {(issue.story_points != null || (issue.story_points_field && editable(issue, issue.story_points_field))) && (
          <FieldRow id={issue.story_points_field || "story_points"} label={t("iv.f.storyPoints")} empty={issue.story_points == null}>
            <span className="tabular">{issue.story_points}</span>
          </FieldRow>
        )}
        <FieldRow id="duedate" label={t("iv.f.due")} empty={!issue.due_date}>
          {issue.due_date && <span className={`iv-due ${issue.due_date < isoDay(new Date()) && issue.status.category !== "done" ? "overdue" : ""}`}>{fmtDate(`${issue.due_date}T12:00:00`)}</span>}
        </FieldRow>
        {(bar || t3.original != null || t3.spent != null || editable(issue, "timetracking")) && (
          <FieldRow id="timetracking" label={t("iv.f.time")}>
            <div className="iv-time">
              {bar && (
                <div className={`iv-timebar ${bar.over ? "over" : ""}`} role="img" aria-label={t("iv.timeBar", { logged: t3.spent_text || fmtSeconds(t3.spent), remaining: t3.remaining_text || fmtSeconds(t3.remaining) })}>
                  <span className="iv-timebar-logged" style={{ width: `${bar.logged * 100}%` }} />
                  <span className="iv-timebar-left" style={{ width: `${bar.remaining * 100}%` }} />
                </div>
              )}
              <div className="iv-time-rows small">
                <span>
                  <span className="faint">{t("iv.timeLogged")}</span> <span className="iv-time-value">{t3.spent_text || fmtSeconds(t3.spent)}</span>
                </span>
                <span>
                  <span className="faint">{t("iv.timeRemaining")}</span> <span className="iv-time-value">{t3.remaining_text || fmtSeconds(t3.remaining)}</span>
                </span>
                <span>
                  <span className="faint">{t("iv.timeOriginal")}</span>{" "}
                  {t3.original != null ? (
                    <span className="iv-time-value">{t3.original_text || fmtSeconds(t3.original)}</span>
                  ) : (
                    <span className="iv-time-value">
                      <span aria-hidden="true">–</span>
                      <span className="sr-only">{t("iv.none")}</span>
                    </span>
                  )}
                </span>
              </div>
            </div>
          </FieldRow>
        )}
        {issue.custom.map((c) => (
          <FieldRow key={c.id} id={c.id} label={c.name}>
            <ShownValue value={c.value} issue={issue} onIssue={open} />
          </FieldRow>
        ))}
        {emptyEditable.map((f) => (
          <FieldRow key={f.id} id={f.id} label={f.name} empty />
        ))}
        <Plain label={t("iv.f.created")}>
          <When at={issue.created} />
        </Plain>
        <Plain label={t("iv.f.updated")}>
          <When at={issue.updated} />
        </Plain>
        {issue.resolved && (
          <Plain label={t("iv.f.resolved")}>
            {/* One text: the date and the resolution wrap as words, not as two squeezed columns. */}
            <span>
              <When at={issue.resolved} />
              {issue.resolution && <span className="faint"> · {issue.resolution}</span>}
            </span>
          </Plain>
        )}
      </dl>
      <div className="iv-counts">
        <span title={t("iv.watchers")}>
          <Eye size={13} aria-hidden /> <span className="sr-only">{t("iv.watchers")}</span>
          {issue.watchers}
        </span>
        <span title={t("iv.votes")}>
          <ThumbsUp size={13} aria-hidden /> <span className="sr-only">{t("iv.votes")}</span>
          {issue.votes}
        </span>
      </div>
      <div className="iv-arcalo">
        <h4>{t("iv.inArcalo")}</h4>
        {view.time_tracking && (
          <dl className="iv-fields">
            <Plain label={t("jira.col.wbs")}>{view.wbs ? <span className="mono">{view.wbs}</span> : <span className="faint">{t("jira.noWbs")}</span>}</Plain>
            {view.booked_minutes > 0 && <Plain label={t("jira.col.booked")}>{fmtDuration(view.booked_minutes)}</Plain>}
          </dl>
        )}
        <div className="iv-arcalo-actions">
          <Button size="sm" icon={FileText} onClick={() => (useIssueModal.getState().close(), void openIssueNote(issue.key))}>
            {view.note_page_id ? t("jira.openNote") : t("jira.createNote", { key: issue.key })}
          </Button>
          <Button size="sm" variant="ghost" icon={ListPlus} onClick={() => void addIssueTask(issue.key)}>
            {t("jira.addTask")}
          </Button>
        </div>
      </div>
    </>
  );
}
