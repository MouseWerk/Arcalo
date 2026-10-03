// Smart meeting work (1.10): „Besprechung vorbereiten“ (the buttons on a meeting and the toast
// when a meeting was prepared by itself), the dialog „Statusbericht“ (scope, period, sections,
// templates; then open, PDF, Markdown or mail) and the dialog „Nachfass-Mail“ (Outlook draft,
// else the mail program, or text/HTML to copy). The pages and mails come from the core.

import { useEffect, useMemo, useState } from "react";
import { create } from "zustand";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ClipboardCopy, ClipboardList, FileDown, FileText, Mail, Printer, RefreshCw, Save, Sparkles, Trash2 } from "lucide-react";
import { api, on } from "../lib/api";
import { useApp } from "../store/app";
import { t, useT } from "../lib/i18n";
import { fmtDate } from "../lib/format";
import { attendeeName } from "../lib/agenda";
import { hiddenCalendars } from "../lib/calvisibility";
import {
  PERIODS,
  REPORT_SECTIONS,
  clipForMailto,
  mailRoute,
  mailtoUrl,
  markdownFileName,
  meetApi,
  newRequest,
  periodValid,
  requestOf,
  scopeKey,
  scopeList,
  stripFrontMatter,
  toggleSection,
  type FollowUpView,
  type PeriodKind,
  type ReportRequest,
  type ReportSection,
  type ReportTemplate,
  type Scope,
  type ScopeChoices,
  type ScopeKind,
  type StatusOutcome,
} from "../lib/meetwork";
import type { Page } from "../lib/types";
import type { TKey } from "../lib/i18n";
import { Badge, Button, Dialog, Field, Input, Segmented, Switch } from "./ui";
import { Select, type SelectOption } from "./Select";
import { DateInput } from "./DateInput";
import { flushAllEditors } from "../editor/saves";
import { reloadEditors } from "../editor/NoteEditor";

const s = () => useApp.getState();

// ------------------------------------------------------------------ state

interface MwState {
  /** Prep requests under way, by appointment key. */
  busy: string[];
  /** Prep pages known per appointment (refreshed after a prep). */
  pages: Record<string, number | null>;
  followUp: number | null;
  report: { scope?: Scope; kind?: ScopeKind } | null;
  set: (p: Partial<MwState>) => void;
}

const useMw = create<MwState>((set) => ({ busy: [], pages: {}, followUp: null, report: null, set: (p) => set(p) }));
const mw = useMw.getState;

/** Opens „Nachfass-Mail“ for a meeting note. */
export function openFollowUp(pageId: number) {
  mw().set({ followUp: pageId });
}

/** Opens „Statusbericht“ with a scope chosen already, or the first scope of a kind (the
 * Issues view: a Jira project; Projekte: a Netzplan). */
export function openStatusReport(scope?: Scope | ScopeKind) {
  mw().set({ report: typeof scope === "string" ? { kind: scope } : { scope } });
}

/** Opens a page once it is in the tree. */
async function openPageNow(page: Page, newTab = true) {
  if (!s().pages.has(page.id)) await s().refreshTree();
  s().openPage(page.id, { newTab });
}

/** „Besprechung vorbereiten“: writes or refreshes the prep page and opens it. */
export async function prepareMeeting(key: string, opts: { open?: boolean } = {}) {
  if (mw().busy.includes(key)) return;
  mw().set({ busy: [...mw().busy, key] });
  try {
    // What the user typed on an open prep page is saved first: the refresh keeps it.
    await flushAllEditors().catch(() => {});
    const r = await meetApi.prepare(crypto.randomUUID(), key, true);
    mw().set({ pages: { ...mw().pages, [key]: r.page.id } });
    if (!r.created) reloadEditors([r.page.id]);
    if (opts.open !== false) await openPageNow(r.page);
    else await s().refreshTree();
    s().toast({ tone: "success", title: t(r.created ? "mw.prep.created" : "mw.prep.updated"), detail: r.page.title });
    if (r.ai.error) s().toast({ tone: "warning", title: t("mw.prep.noAi"), detail: r.ai.error });
  } catch (e) {
    s().error(t("mw.prep.failed"), e);
  } finally {
    mw().set({ busy: mw().busy.filter((k) => k !== key) });
  }
}

/** The palette: the prep page in front is refreshed, else the next meeting of today is prepared. */
export async function prepareFromPalette() {
  const tab = s().tabs.find((x) => x.id === s().activeTabId);
  if (tab?.kind === "page" && tab.pageId != null) {
    const key = await meetApi.prepKey(tab.pageId).catch(() => null);
    if (key) return prepareMeeting(key);
  }
  try {
    const b = await api.briefing([...hiddenCalendars()]);
    const key = b.next_meeting;
    if (!key) return s().toast({ tone: "info", title: t("mw.prep.noMeeting") });
    await prepareMeeting(key);
  } catch (e) {
    s().error(t("mw.prep.failed"), e);
  }
}

/** The palette: „Nachfass-Mail“ for the page in front. */
export function followUpFromPalette() {
  const tab = s().tabs.find((x) => x.id === s().activeTabId);
  if (tab?.kind === "page" && tab.pageId != null) openFollowUp(tab.pageId);
  else s().toast({ tone: "info", title: t("mw.fu.openNote") });
}

/** The prep page of an appointment (loaded once per key, updated after a prep). */
function usePrepPage(key: string): number | null {
  const known = useMw((st) => st.pages[key]);
  useEffect(() => {
    if (known !== undefined) return;
    let live = true;
    void meetApi
      .prepPage(key)
      .then((id) => live && mw().set({ pages: { ...mw().pages, [key]: id } }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key, known]);
  return known ?? null;
}

/** „Vorbereiten“ and „Vorbereitung öffnen“ on a meeting (calendar detail, next-meeting widget). */
export function PrepActions({ eventKey, size = "md", compact = false }: { eventKey: string; size?: "sm" | "md"; compact?: boolean }) {
  const t = useT();
  const page = usePrepPage(eventKey);
  const busy = useMw((st) => st.busy.includes(eventKey));
  if (compact)
    return page != null ? (
      <Button size={size} variant="ghost" icon={FileText} className="mw-prep-open" onClick={() => s().openPage(page, { newTab: true })}>
        {t("mw.prep.page")}
      </Button>
    ) : (
      <Button size={size} variant="ghost" icon={ClipboardList} className="mw-prep-btn" loading={busy} onClick={() => void prepareMeeting(eventKey)} title={t("mw.prep.hint")}>
        {t("mw.prep.button")}
      </Button>
    );
  return (
    <>
      <Button size={size} variant="secondary" icon={page != null ? RefreshCw : ClipboardList} className="mw-prep-btn" loading={busy} onClick={() => void prepareMeeting(eventKey)} title={t("mw.prep.hint")}>
        {page != null ? t("mw.prep.refresh") : t("mw.prep.button")}
      </Button>
      {page != null && (
        <Button size={size} variant="ghost" icon={FileText} className="mw-prep-open" onClick={() => s().openPage(page, { newTab: true })}>
          {t("mw.prep.open")}
        </Button>
      )}
    </>
  );
}

/** Mounted once: the dialogs and the toast of a meeting prepared by itself. */
export function MeetingWorkHost() {
  const followUp = useMw((st) => st.followUp);
  const report = useMw((st) => st.report);
  useEffect(() => {
    const off = on<{ key: string; page: Page }>("prep://created", ({ key, page }) => {
      mw().set({ pages: { ...mw().pages, [key]: page.id } });
      void s().refreshTree();
      s().toast({ tone: "info", title: t("mw.prep.auto"), detail: page.title, action: { label: t("mw.prep.open"), run: () => s().openPage(page.id, { newTab: true }) } });
    });
    // After a meeting summary: offer the follow-up mail.
    const offer = (e: Event) => {
      const id = (e as CustomEvent<number>).detail;
      s().toast({ tone: "info", title: t("mw.fu.offer"), action: { label: t("mw.fu.title"), run: () => openFollowUp(id) } });
    };
    window.addEventListener("annalo:offer-followup", offer);
    return () => {
      void off.then((f) => f());
      window.removeEventListener("annalo:offer-followup", offer);
    };
  }, []);
  return (
    <>
      {followUp != null && <FollowUpDialog pageId={followUp} onClose={() => mw().set({ followUp: null })} />}
      {report && <StatusReportDialog initial={report.scope} kind={report.kind} onClose={() => mw().set({ report: null })} />}
    </>
  );
}

// ------------------------------------------------------------------ follow-up mail

async function copyHtml(html: string, text: string) {
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard.write) {
      await navigator.clipboard.write([new ClipboardItem({ "text/html": new Blob([html], { type: "text/html" }), "text/plain": new Blob([text], { type: "text/plain" }) })]);
    } else {
      await navigator.clipboard.writeText(html);
    }
    s().toast({ tone: "success", title: t("mw.fu.copiedHtml") });
  } catch (e) {
    s().error(t("mw.fu.copyFailed"), e);
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    s().toast({ tone: "success", title: t("mw.fu.copiedText") });
  } catch (e) {
    s().error(t("mw.fu.copyFailed"), e);
  }
}

function FollowUpDialog({ pageId, onClose }: { pageId: number; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<FollowUpView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"ai" | "outlook" | null>(null);
  // Outlook failed (new Outlook, not installed): the mail program instead.
  const [fallback, setFallback] = useState(false);
  useEffect(() => {
    meetApi.followUp(pageId).then(setView, (e) => setError(String(e)));
  }, [pageId]);
  const f = view?.followup;
  const route = view && !fallback ? mailRoute(view) : "mailto";
  const polish = async () => {
    setBusy("ai");
    try {
      setView(await meetApi.polish(crypto.randomUUID(), pageId));
    } catch (e) {
      s().error(t("mw.fu.aiFailed"), e);
    } finally {
      setBusy(null);
    }
  };
  const outlook = async () => {
    if (!view) return;
    setBusy("outlook");
    try {
      await meetApi.draft(view.followup.to, view.followup.subject, view.html);
      s().toast({ tone: "success", title: t("mw.fu.drafted"), detail: t("mw.fu.draftedHint") });
      onClose();
    } catch (e) {
      setFallback(true);
      s().error(t("mw.fu.outlookFailed"), e);
    } finally {
      setBusy(null);
    }
  };
  const date = f?.date ? fmtDate(f.date) : null;
  return (
    <Dialog open onClose={onClose} title={t("mw.fu.title")} description={f ? (date ? `${f.meeting} · ${date}` : f.meeting) : undefined} width={720}>
      {error && <div className="mw-error">{error}</div>}
      {!view && !error && <div className="mw-loading faint">{t("common.loading")}</div>}
      {view && f && (
        <div className="mw-fu">
          <div className="mw-fu-head">
            <span className="mw-fu-label">{t("mw.fu.to")}</span>
            <span className="mw-fu-to">
              {f.to.length ? f.to.map((a) => <span key={a} className="mw-chip" title={a}>{attendeeName(a)}</span>) : <span className="faint">{t("mw.fu.noAttendees")}</span>}
            </span>
            <span className="mw-fu-label">{t("mw.fu.subject")}</span>
            <span className="mw-fu-subject">{f.subject}</span>
          </div>
          {f.private && (
            <div className="mw-fu-private">
              <Badge tone="info">{t("mw.privateBadge")}</Badge> <span className="faint small">{t("mw.privateHint")}</span>
            </div>
          )}
          <div className="mw-fu-preview" lang={f.lang}>
            {f.intro && <p className={f.polished ? "mw-fu-intro polished" : "mw-fu-intro"}>{f.intro}</p>}
            {f.results.length > 0 && (
              <section>
                <h4>{t("mw.fu.results")}</h4>
                <ul>{f.results.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </section>
            )}
            {f.decisions.length > 0 && (
              <section>
                <h4>{t("mw.fu.decisions")}</h4>
                <ul>{f.decisions.map((r, i) => <li key={i}>{r}</li>)}</ul>
              </section>
            )}
            {f.actions.length > 0 && (
              <section>
                <h4>{t("mw.fu.actions")}</h4>
                <table className="mw-fu-actions">
                  <tbody>
                    {f.actions.map((a, i) => (
                      <tr key={i} className={a.done ? "done" : ""}>
                        <td>{a.text}</td>
                        <td>{a.owner ?? "–"}</td>
                        <td className="num">{a.due ? fmtDate(a.due) : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}
            {!f.results.length && !f.decisions.length && !f.actions.length && <p className="faint">{t("mw.fu.empty")}</p>}
          </div>
          {route === "mailto" && <p className="mw-fu-note faint small">{view.outlook ? t("mw.fu.fallbackHint") : t("mw.fu.noOutlook")} {view.mailto_truncated && t("mw.fu.truncated")}</p>}
          <div className="mw-fu-actions-row">
            <Button icon={Sparkles} loading={busy === "ai"} onClick={() => void polish()} className="mw-fu-polish">
              {t("mw.fu.polish")}
            </Button>
            <span className="grow" />
            <Button variant="ghost" icon={ClipboardCopy} className="mw-fu-copy-text" onClick={() => void copyText(view.text)}>
              {t("mw.fu.copyText")}
            </Button>
            <Button variant="ghost" icon={ClipboardCopy} className="mw-fu-copy-html" onClick={() => void copyHtml(view.html, view.text)}>
              {t("mw.fu.copyHtml")}
            </Button>
            {route === "outlook" ? (
              <Button variant="primary" icon={Mail} loading={busy === "outlook"} className="mw-fu-outlook" onClick={() => void outlook()}>
                {t("mw.fu.outlook")}
              </Button>
            ) : (
              <Button variant="primary" icon={Mail} className="mw-fu-mailto" data-href={view.mailto} onClick={() => void openUrl(view.mailto).catch((e) => s().error(t("mw.fu.mailtoFailed"), e))}>
                {t("mw.fu.mailto")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ status report

const PERIOD_LABEL: Record<PeriodKind, TKey> = {
  this_week: "mw.sr.thisWeek",
  last_week: "mw.sr.lastWeek",
  month: "mw.sr.month",
  last_month: "mw.sr.lastMonth",
  custom: "mw.sr.custom",
};
const SECTION_LABEL: Record<ReportSection, TKey> = {
  summary: "mw.sr.s.summary",
  hours: "mw.sr.s.hours",
  jira: "mw.sr.s.jira",
  notes: "mw.sr.s.notes",
  deadlines: "mw.sr.s.deadlines",
  risks: "mw.sr.s.risks",
};

/** Waits until the page's editor is in the active pane (for printing it). */
async function untilShown(title: string) {
  for (let i = 0; i < 40; i++) {
    const pane = document.querySelector(".pane.active");
    const input = pane?.querySelector<HTMLInputElement | HTMLTextAreaElement>(".page-title, textarea.page-title, input.page-title");
    if (pane?.querySelector(".ProseMirror") && (!input || input.value === title || pane.textContent?.includes(title))) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** PDF of a report: opens it and prints the pane („Als PDF speichern“ in the dialog). */
export async function reportPdf(page: Page) {
  await openPageNow(page, false);
  await untilShown(page.title);
  const { printActivePane } = await import("../views/PageView");
  printActivePane();
}

/** Markdown of a report into a .md file the user picks. */
export async function reportMarkdown(page: Pick<Page, "id" | "title">) {
  try {
    const path = await saveDialog({ defaultPath: markdownFileName(page.title), filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    await meetApi.writeMarkdown(page.id, path);
    s().toast({ tone: "success", title: t("mw.sr.mdSaved"), detail: path });
  } catch (e) {
    s().error(t("mw.sr.mdFailed"), e);
  }
}

/** A report as a mail: an Outlook draft (rendered page), else the mail program with the text. */
export async function reportMail(page: Page) {
  try {
    if (await meetApi.draftAvailable()) {
      const { exportPagesHtml } = await import("../editor/shareHtml");
      const { html } = await exportPagesHtml(page.id, false);
      await meetApi.draft([], page.title, html);
      s().toast({ tone: "success", title: t("mw.fu.drafted"), detail: t("mw.fu.draftedHint") });
      return;
    }
    const md = stripFrontMatter(await meetApi.markdownText(page.id));
    const { text, cut } = clipForMailto(md, 1500, t("mw.sr.mailCut"));
    await openUrl(mailtoUrl([], page.title, text));
    if (cut) s().toast({ tone: "info", title: t("mw.fu.truncated") });
  } catch (e) {
    s().error(t("mw.fu.outlookFailed"), e);
  }
}

function StatusReportDialog({ initial, kind, onClose }: { initial?: Scope; kind?: ScopeKind; onClose: () => void }) {
  const t = useT();
  const [choices, setChoices] = useState<ScopeChoices | null>(null);
  const [templates, setTemplates] = useState<ReportTemplate[]>([]);
  const [req, setReq] = useState<ReportRequest | null>(initial ? newRequest(initial, true) : null);
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<StatusOutcome | null>(null);
  useEffect(() => {
    void meetApi.scopes().then((c) => {
      setChoices(c);
      const all = scopeList(c);
      const first = all.find((x) => x.kind === kind) ?? all[0];
      setReq((r) => r ?? (first ? newRequest(first, true) : null));
    }, (e) => s().error(t("mw.sr.failed"), e));
    void meetApi.templates().then(setTemplates).catch(() => {});
  }, [t, kind]);
  const scopes = useMemo(() => (choices ? scopeList(choices) : []), [choices]);
  const scopeOptions: SelectOption[] = useMemo(() => {
    if (!choices) return [];
    const group = (list: Scope[], label: string) => list.map((x, i) => ({ value: scopeKey(x), label: x.label, ...(i === 0 ? { group: label } : {}) }));
    const extra = req && !scopes.some((x) => scopeKey(x) === scopeKey(req.scope)) ? [{ value: scopeKey(req.scope), label: req.scope.label }] : [];
    return [...extra, ...group(choices.netzplaene, t("mw.sr.g.netzplan")), ...group(choices.jira, t("mw.sr.g.jira")), ...group(choices.folders, t("mw.sr.g.folder")), ...group(choices.tags, t("mw.sr.g.tag"))];
  }, [choices, scopes, req, t]);
  const patch = (p: Partial<ReportRequest>) => setReq((r) => (r ? { ...r, ...p } : r));
  const create = async () => {
    if (!req) return;
    setBusy(true);
    try {
      await flushAllEditors().catch(() => {});
      const r = await meetApi.report(crypto.randomUUID(), req);
      if (!r.created) reloadEditors([r.page.id]);
      setDone(r);
      await s().refreshTree();
      if (r.ai.error) s().toast({ tone: "warning", title: t("mw.sr.noAi"), detail: r.ai.error });
    } catch (e) {
      s().error(t("mw.sr.failed"), e);
    } finally {
      setBusy(false);
    }
  };
  const saveTemplate = async () => {
    if (!req) return;
    try {
      const list = await meetApi.saveTemplate({ id: template, name: name || req.scope.label, scope: req.scope, period: req.period.kind === "custom" ? "this_week" : req.period.kind, sections: req.sections, ai: req.ai });
      setTemplates(list);
      const saved = list.find((x) => x.id === template) ?? list[list.length - 1];
      if (saved) setTemplate(saved.id);
      s().toast({ tone: "success", title: t("mw.sr.templateSaved"), detail: saved?.name });
    } catch (e) {
      s().error(t("common.notSaved"), e);
    }
  };
  const removeTemplate = async () => {
    if (!template) return;
    setTemplates(await meetApi.deleteTemplate(template));
    setTemplate("");
  };
  if (done) {
    const page = done.page;
    return (
      <Dialog open onClose={onClose} title={t("mw.sr.title")} width={560}>
        <div className="mw-sr-done">
          <div className="mw-sr-done-title">
            <FileText size={16} aria-hidden />
            <span className="ellipsis">{page.title}</span>
            <Badge tone="success">{t(done.created ? "mw.sr.created" : "mw.sr.updated")}</Badge>
          </div>
          <p className="faint small">{t("mw.sr.doneHint")}</p>
          <div className="mw-sr-exports">
            <Button variant="primary" icon={FileText} className="mw-sr-open" onClick={() => (onClose(), void openPageNow(page))}>
              {t("mw.sr.open")}
            </Button>
            <Button icon={Printer} className="mw-sr-pdf" onClick={() => (onClose(), void reportPdf(page))}>
              {t("mw.sr.pdf")}
            </Button>
            <Button icon={FileDown} className="mw-sr-md" onClick={() => void reportMarkdown(page)}>
              {t("mw.sr.markdown")}
            </Button>
            <Button icon={Mail} className="mw-sr-mail" onClick={() => void reportMail(page)}>
              {t("mw.sr.mail")}
            </Button>
          </div>
        </div>
      </Dialog>
    );
  }
  const templateOptions: SelectOption[] = [{ value: "", label: t("mw.sr.noTemplate") }, ...templates.map((x) => ({ value: x.id, label: x.name }))];
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("mw.sr.title")}
      description={t("mw.sr.desc")}
      width={600}
      footer={
        <>
          <Button variant="ghost" icon={Save} className="mw-sr-save-template" disabled={!req} onClick={() => void saveTemplate()}>
            {template ? t("mw.sr.updateTemplate") : t("mw.sr.saveTemplate")}
          </Button>
          <span className="grow" />
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" className="mw-sr-create" loading={busy} disabled={!req || !periodValid(req.period)} onClick={() => void create()}>
            {t("mw.sr.create")}
          </Button>
        </>
      }
    >
      {!choices && <div className="mw-loading faint">{t("common.loading")}</div>}
      {choices && !scopes.length && !req && <div className="mw-empty faint">{t("mw.sr.noScopes")}</div>}
      {req && (
        <div className="mw-sr">
          {templates.length > 0 && (
            <Field label={t("mw.sr.template")}>
              <span className="mw-sr-template-row">
                <Select
                  value={template}
                  options={templateOptions}
                  aria-label={t("mw.sr.template")}
                  className="mw-sr-template"
                  onChange={(e) => {
                    const v = e.target.value;
                    setTemplate(v);
                    const x = templates.find((y) => y.id === v);
                    if (x) {
                      setReq(requestOf(x));
                      setName(x.name);
                    }
                  }}
                />
                {template && <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void removeTemplate()} aria-label={t("mw.sr.deleteTemplate")} />}
              </span>
            </Field>
          )}
          <Field label={t("mw.sr.scope")}>
            <Select value={scopeKey(req.scope)} options={scopeOptions} aria-label={t("mw.sr.scope")} className="mw-sr-scope" onChange={(e) => {
              const v = e.target.value;
              const x = scopes.find((y) => scopeKey(y) === v);
              if (x) patch({ scope: x });
            }} />
          </Field>
          <div className="field">
            <span className="field-label">{t("mw.sr.period")}</span>
            <span className="field-control mw-sr-period">
              <Segmented label={t("mw.sr.period")} value={req.period.kind} options={PERIODS.map((p) => ({ value: p, label: t(PERIOD_LABEL[p]) }))} onChange={(kind) => patch({ period: { ...req.period, kind } })} />
            </span>
          </div>
          {req.period.kind === "custom" && (
            <div className="mw-sr-custom">
              <Field label={t("mw.sr.from")}>
                <DateInput value={req.period.from ?? ""} onChange={(from) => patch({ period: { ...req.period, from } })} aria-label={t("mw.sr.from")} />
              </Field>
              <Field label={t("mw.sr.to")}>
                <DateInput value={req.period.to ?? ""} onChange={(to) => patch({ period: { ...req.period, to } })} aria-label={t("mw.sr.to")} />
              </Field>
            </div>
          )}
          <div className="field">
            <span className="field-label">{t("mw.sr.sections")}</span>
            <div className="mw-sr-sections" role="group" aria-label={t("mw.sr.sections")}>
              {REPORT_SECTIONS.map((id) => {
                const on = req.sections.includes(id);
                return (
                  <button key={id} type="button" className={`mw-chip-toggle ${on ? "on" : ""}`} aria-pressed={on} data-section={id} onClick={() => patch({ sections: toggleSection(req.sections, id, !on) })}>
                    {t(SECTION_LABEL[id])}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mw-sr-ai">
            <Switch checked={req.ai && req.sections.includes("summary")} disabled={!req.sections.includes("summary")} onChange={(ai) => patch({ ai })} label={t("mw.sr.ai")} />
            <span>
              {t("mw.sr.ai")}
              <span className="faint small"> · {t("mw.sr.aiHint")}</span>
            </span>
          </div>
          <Field label={t("mw.sr.templateName")}>
            <Input value={name} placeholder={req.scope.label} onChange={(e) => setName(e.target.value)} className="mw-sr-name" />
          </Field>
        </div>
      )}
    </Dialog>
  );
}
