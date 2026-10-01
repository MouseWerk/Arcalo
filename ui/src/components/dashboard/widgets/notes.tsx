// Notes widgets of the start page: Notizzettel (a scratchpad page with checkboxes), Posteingang
// (quick captures not filed yet), Vor einem Jahr (this day in earlier years and a random older
// note), Per Git-Sync geändert (what others changed) and Schreiben (words and new pages per
// day). Each registers itself (define.ts); their data comes from `dashboard_data`
// (annalo_core::dashboard::notes) once they scroll into view.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ArrowRightToLine, Check, FileText, GitPullRequestArrow, History, Inbox, NotebookPen, PenLine, Eye, Shuffle, StickyNote } from "lucide-react";
import { api } from "../../../lib/api";
import { useApp } from "../../../store/app";
import { fmtDate, int, isoDay, relative } from "../../../lib/format";
import { t, type TKey } from "../../../lib/i18n";
import { renderMarkdown } from "../../../lib/markdown";
import { configOf } from "../../../lib/dashboard";
import { openSettingsSection } from "../../../lib/calnav";
import { daySeed, firstLine, inboxDate, interactiveTasks, toggleTask, writingBars } from "../../../lib/dashnotes";
import type { Page } from "../../../lib/types";
import type { PageData } from "../../../lib/dashtypes";
import { Badge, Button, Dialog, IconButton, Segmented } from "../../ui";
import { PageIcon } from "../../icons";
import { reloadEditors } from "../../../editor/NoteEditor";
import { defineWidget, type SettingsProps } from "../define";
import { useBoard } from "../board";
import { useDash, useWidgetData } from "../data";
import { Empty, hhmm, Loadable, PageRows, s } from "../common";
import { PagePicker } from "../WidgetSettings";
import { bodyOf as stripFrontmatter } from "../pages";
import type { WidgetProps } from "../registry";

const opt = (value: string, label: TKey) => ({ value, label: t(label) });

// ------------------------------------------------------------------ Notizzettel

/**
 * A scratchpad on a page of its own (in backups and Git sync like every page), created with the
 * first words typed. Written as Markdown; „Ansicht“ shows it rendered with checkboxes to tick.
 */
function ScratchpadWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  const id = typeof c.page === "number" ? c.page : null;
  const { setConfig } = useBoard();
  const { data, error, loading } = useWidgetData<PageData>(widget);
  const exists = useApp((st) => (id != null ? !!st.pages.get(id) && !st.pages.get(id)!.deleted_at : false));
  const [text, setText] = useState<string | null>(null);
  const [view, setView] = useState(c.view === true);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const creating = useRef(false);
  const pageId = useRef(id);
  pageId.current = id;

  const save = async (v: string) => {
    try {
      if (pageId.current != null) {
        await api.savePage(pageId.current, v);
        reloadEditors([pageId.current]);
        return;
      }
      if (creating.current || !v.trim()) return;
      creating.current = true;
      // The first words create the page; a second scratchpad gets a title of its own.
      const base = t("dash.n.scratchTitle");
      const titles = new Set([...s().pages.values()].filter((p) => !p.deleted_at).map((p) => p.title));
      let title = base;
      for (let n = 2; titles.has(title); n++) title = `${base} ${n}`;
      const page = await api.createPage(title, null, "sticky-note", v);
      pageId.current = page.id;
      setConfig(widget.id, { page: page.id });
      void s().refreshTree();
    } catch (e) {
      s().error(t("dash.noteSaveFailed"), e);
    } finally {
      creating.current = false;
    }
  };
  const flush = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v != null) void save(v);
  };
  // The page changed elsewhere: take it over unless something is being typed here.
  useEffect(() => {
    if (pending.current == null && data) setText(data.content);
  }, [data]);
  useEffect(() => flush, []);

  const value = text ?? "";
  const html = useMemo(() => (view ? interactiveTasks(renderMarkdown(stripFrontmatter(value))) : ""), [view, value]);
  const offset = value.length - stripFrontmatter(value).length;
  const tick = (e: MouseEvent) => {
    const box = (e.target as HTMLElement).closest("input[data-task]") as HTMLInputElement | null;
    if (!box) return;
    const n = Number(box.dataset.task);
    // Task numbers count in the body; the frontmatter has no tasks.
    const next = value.slice(0, offset) + toggleTask(value.slice(offset), n, box.checked);
    setText(next);
    void save(next);
  };
  if (id != null && !exists && !loading && error)
    return (
      <Empty icon={StickyNote} action={<Button size="sm" onClick={() => setConfig(widget.id, { page: null })}>{t("dash.n.scratchNew")}</Button>}>
        {t("dash.n.scratchGone")}
      </Empty>
    );
  return (
    <Loadable loading={id != null && loading && text == null} error={undefined}>
      {() => (
        <div className="dw-note-wrap dw-scratch">
          {view ? (
            <div className="dw-md dw-note-preview" onClick={tick} dangerouslySetInnerHTML={{ __html: value.trim() ? html : `<p class="faint">${t("dash.noteEmpty")}</p>` }} />
          ) : (
            <textarea
              className="input dw-note"
              value={value}
              placeholder={t("dash.n.scratchPlaceholder")}
              aria-label={t("dash.w.scratchpad")}
              spellCheck
              onChange={(e) => {
                setText(e.target.value);
                pending.current = e.target.value;
                if (timer.current != null) window.clearTimeout(timer.current);
                timer.current = window.setTimeout(flush, 700);
              }}
              onBlur={flush}
            />
          )}
          <div className="dw-scratch-tools">
            {id != null && <IconButton icon={FileText} size="sm" label={t("dash.n.openPage")} onClick={(e) => s().openPage(id, { newTab: e.ctrlKey || e.metaKey })} />}
            <IconButton icon={view ? PenLine : Eye} size="sm" label={view ? t("dash.noteEdit") : t("dash.n.scratchView")} onClick={() => (flush(), setView(!view))} />
          </div>
        </div>
      )}
    </Loadable>
  );
}

defineWidget({
  kind: "scratchpad",
  label: "dash.w.scratchpad",
  hint: "dash.w.scratchpadHint",
  group: "pages",
  size: { w: 4, h: 7 },
  min: { w: 2, h: 3 },
  config: () => ({ page: null, view: false }),
  icon: StickyNote,
  look: "text",
  body: ScratchpadWidget,
  parts: (c) => (typeof c.page === "number" ? [{ kind: "page", id: c.page }] : []),
  opener: (w) => {
    const c = configOf(w);
    return typeof c.page === "number" ? () => s().openPage(c.page as number) : null;
  },
});

// ------------------------------------------------------------------ Posteingang

interface InboxItem {
  index: number;
  stamp: string;
  text: string;
}
interface InboxData {
  page_id: number | null;
  title: string;
  items: InboxItem[];
  total: number;
}

/** „23.09., 14:30“ in the chosen formats, the original text when it cannot be read. */
function stampLabel(stamp: string): string {
  const d = inboxDate(stamp);
  if (!d) return stamp;
  return isoDay(d) === isoDay(new Date()) ? hhmm(d) : `${fmtDate(d)} ${hhmm(d)}`;
}

function InboxWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<InboxData>(widget);
  const { refresh } = useDash();
  const [filing, setFiling] = useState<InboxItem | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const move = async (item: InboxItem, target: number | null) => {
    if (!data?.page_id) return;
    setBusy(item.index);
    try {
      const title = await api.dashboardInboxMove(data.page_id, item.index, item.text, target);
      reloadEditors(target != null ? [data.page_id, target] : [data.page_id]);
      refresh(["pages"]);
      void s().refreshTree();
      s().toast(
        title
          ? { tone: "success", title: t("dash.n.filed", { title }), action: { label: t("dash.open"), run: () => s().openPage(target!) } }
          : { tone: "success", title: t("dash.n.inboxDone") },
      );
    } catch (e) {
      s().error(t("dash.n.inboxFailed"), e);
      refresh(["pages"]);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        if (!d.items.length)
          return (
            <Empty icon={Inbox} action={<Button size="sm" variant="ghost" onClick={() => void api.captureShow()}>{t("dash.n.capture")}</Button>}>
              {t("dash.n.inboxEmpty", { title: d.title })}
            </Empty>
          );
        return (
          <div className="dw-inbox">
            <ul className="dw-list">
              {d.items.map((item) => (
                <li key={`${item.index}-${item.stamp}`} className="dw-inbox-item">
                  <button type="button" className="dw-row dw-inbox-text" title={item.text} onClick={(e) => d.page_id && s().openPage(d.page_id, { newTab: e.ctrlKey || e.metaKey })}>
                    <span className="ellipsis grow">{firstLine(item.text) || item.text}</span>
                    <span className="faint dw-when num">{stampLabel(item.stamp)}</span>
                  </button>
                  <span className="dw-inbox-actions">
                    <IconButton icon={ArrowRightToLine} size="sm" label={t("dash.n.fileInto")} disabled={busy != null} onClick={() => setFiling(item)} />
                    <IconButton icon={Check} size="sm" label={t("dash.n.markDone")} disabled={busy != null} onClick={() => void move(item, null)} />
                  </span>
                </li>
              ))}
            </ul>
            {d.total > d.items.length && (
              <button type="button" className="dw-row dw-more" onClick={() => d.page_id && s().openPage(d.page_id)}>
                {t("dash.more", { n: d.total - d.items.length })}
              </button>
            )}
            {filing && (
              <Dialog open onClose={() => setFiling(null)} title={t("dash.n.fileTitle")} description={firstLine(filing.text)} width={440}>
                <PagePicker
                  value={null}
                  exclude={d.page_id ? [d.page_id] : []}
                  label={t("dash.n.fileTarget")}
                  onChange={(id) => {
                    const item = filing;
                    setFiling(null);
                    if (id != null) void move(item, id);
                  }}
                />
              </Dialog>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "inbox",
  label: "dash.w.inbox",
  hint: "dash.w.inboxHint",
  group: "pages",
  size: { w: 4, h: 7 },
  min: { w: 3, h: 4 },
  config: () => ({}),
  icon: Inbox,
  look: "list",
  body: InboxWidget,
  parts: () => [{ kind: "inbox", limit: 20 }],
});

// ------------------------------------------------------------------ Vor einem Jahr

interface YearAgo {
  year: number;
  years_ago: number;
  daily: Page | null;
  pages: Page[];
}
interface ResurfaceData {
  date: string;
  years: YearAgo[];
  random: { page: Page; excerpt: string } | null;
  pool: number;
}

function ResurfaceWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<ResurfaceData>(widget);
  const { setConfig } = useBoard();
  const c = configOf(widget);
  const shuffle = () => setConfig(widget.id, { seed: Math.floor(Math.random() * 1e9) });
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        return (
          <div className="dw-resurface">
            <section aria-label={t("dash.n.onThisDay")}>
              <h3 className="dw-sub">{t("dash.n.onThisDay")}</h3>
              {d.years.length ? (
                d.years.map((y) => (
                  <div key={y.year} className="dw-year">
                    <div className="dw-year-head">
                      <span className="num">{y.year}</span>
                      <span className="faint small">{t("dash.n.yearsAgo", { n: y.years_ago })}</span>
                      {y.daily && (
                        <button type="button" className="dw-link dw-year-daily" onClick={(e) => s().openPage(y.daily!.id, { newTab: e.ctrlKey || e.metaKey })}>
                          {t("dash.n.dailyNote")}
                        </button>
                      )}
                    </div>
                    {y.pages.length > 0 && <PageRows pages={y.pages.slice(0, 4)} />}
                  </div>
                ))
              ) : (
                <div className="dw-quiet">{t("dash.n.nothingThisDay")}</div>
              )}
            </section>
            <section className="dw-random" aria-label={t("dash.n.random")}>
              <div className="dw-random-head">
                <h3 className="dw-sub">{t("dash.n.random")}</h3>
                {d.pool > 1 && <IconButton icon={Shuffle} size="sm" label={t("dash.n.shuffle")} onClick={shuffle} />}
              </div>
              {d.random ? (
                <button type="button" className="dw-random-card" onClick={(e) => s().openPage(d.random!.page.id, { newTab: e.ctrlKey || e.metaKey })}>
                  <span className="dw-random-title">
                    <PageIcon name={d.random.page.icon} size={14} />
                    <span className="ellipsis">{d.random.page.title}</span>
                    <span className="faint small dw-when">{relative(d.random.page.updated_at)}</span>
                  </span>
                  {d.random.excerpt && <span className="dw-random-text">{d.random.excerpt}</span>}
                </button>
              ) : (
                <div className="dw-quiet">{t("dash.n.randomNone")}</div>
              )}
            </section>
            {typeof c.seed === "number" && <span className="sr-only" aria-live="polite">{d.random?.page.title ?? ""}</span>}
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "resurface",
  label: "dash.w.resurface",
  hint: "dash.w.resurfaceHint",
  group: "pages",
  size: { w: 4, h: 8 },
  min: { w: 3, h: 5 },
  config: () => ({ seed: null }),
  icon: History,
  look: "list",
  body: ResurfaceWidget,
  // The same note all day; „Mischen“ stores another seed.
  parts: (c, ctx) => [{ kind: "resurface", seed: typeof c.seed === "number" ? c.seed : daySeed(ctx.today) }],
});

// ------------------------------------------------------------------ Per Git-Sync geändert

interface PulledItem {
  page_id: number;
  title: string;
  change: "changed" | "created" | "trashed" | "conflict";
  at: string;
  page: Page | null;
}
interface PulledData {
  enabled: boolean;
  configured: boolean;
  items: PulledItem[];
}

const CHANGE: Record<PulledItem["change"], { label: TKey; tone: "neutral" | "success" | "warning" | "danger" }> = {
  changed: { label: "dash.n.changed", tone: "neutral" },
  created: { label: "dash.n.created", tone: "success" },
  trashed: { label: "dash.n.trashed", tone: "neutral" },
  conflict: { label: "dash.n.conflict", tone: "warning" },
};

function SyncedWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<PulledData>(widget);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        if (!d.enabled)
          return (
            <Empty icon={GitPullRequestArrow} action={<Button size="sm" variant="ghost" onClick={() => openSettingsSection("backup")}>{t("dash.n.syncSetup")}</Button>}>
              {t("dash.n.syncOff")}
            </Empty>
          );
        if (!d.items.length) return <Empty icon={GitPullRequestArrow}>{t("dash.n.syncNone")}</Empty>;
        return (
          <ul className="dw-list">
            {d.items.map((it) => {
              const ch = CHANGE[it.change] ?? CHANGE.changed;
              return (
                <li key={it.page_id}>
                  <button type="button" className="dw-row" disabled={!it.page} onClick={(e) => it.page && s().openPage(it.page_id, { newTab: e.ctrlKey || e.metaKey })}>
                    <PageIcon name={it.page?.icon} size={14} />
                    <span className="ellipsis grow">{it.page?.title ?? it.title}</span>
                    {it.change !== "changed" && <Badge tone={ch.tone}>{t(ch.label)}</Badge>}
                    <span className="faint dw-when">{relative(it.at)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "synced",
  label: "dash.w.synced",
  hint: "dash.w.syncedHint",
  group: "pages",
  size: { w: 4, h: 7 },
  min: { w: 3, h: 4 },
  config: () => ({}),
  icon: GitPullRequestArrow,
  look: "list",
  body: SyncedWidget,
  parts: () => [{ kind: "pulled", limit: 12 }],
});

// ------------------------------------------------------------------ Schreiben

interface WritingData {
  days: { date: string; words: number; created: number }[];
  words: number;
  created: number;
  streak: number;
}

function WritingWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<WritingData>(widget);
  const { today } = useDash();
  const c = configOf(widget);
  return (
    <Loadable loading={loading} error={error}>
      {() => {
        const d = data!;
        const bars = writingBars(d.days, isoDay(today));
        const summary = bars.map((b) => `${fmtDate(`${b.date}T12:00:00`)}: ${t("dash.n.wordsN", { n: b.words })}`).join(", ");
        return (
          <div className="dw-writing">
            <div className="dw-writing-sum">
              <div>
                <span className="num dw-big">{int(d.words)}</span>
                <span className="faint">{t("dash.n.wordsIn", { n: c.days === 30 ? 30 : 14 })}</span>
              </div>
              <div className="faint small num">
                {t("dash.n.pagesCreated", { n: d.created })}
                {d.streak > 1 && ` · ${t("dash.n.streak", { n: d.streak })}`}
              </div>
            </div>
            <div className="dw-writing-bars" role="img" aria-label={`${t("dash.w.writing")}: ${summary}`}>
              {bars.map((b) => (
                <span key={b.date} className={`dw-writing-bar ${b.today ? "today" : ""} ${b.words ? "" : "zero"}`} title={`${fmtDate(`${b.date}T12:00:00`)} · ${t("dash.n.wordsN", { n: b.words })}${b.created ? ` · ${t("dash.n.pagesCreated", { n: b.created })}` : ""}`}>
                  <i style={{ height: `${Math.max(b.words ? 4 : 0, b.fill * 100)}%` }} />
                </span>
              ))}
            </div>
            <div className="dw-writing-axis faint small num" aria-hidden>
              <span>{fmtDate(`${bars[0]?.date}T12:00:00`).slice(0, 6)}</span>
              <span>{t("dash.today")}</span>
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

function WritingSettings({ config, set }: SettingsProps) {
  return (
    <div className="dws-row">
      <div className="dws-label">
        <span>{t("dash.n.period")}</span>
      </div>
      <div className="dws-control">
        <Segmented label={t("dash.n.period")} value={config.days === 30 ? "30" : "14"} options={[opt("14", "dash.n.days14"), opt("30", "dash.n.days30")]} onChange={(v) => set({ days: Number(v) })} />
      </div>
    </div>
  );
}

defineWidget({
  kind: "writing",
  label: "dash.w.writing",
  hint: "dash.w.writingHint",
  group: "pages",
  size: { w: 8, h: 7 },
  min: { w: 3, h: 5 },
  config: () => ({ days: 14 }),
  icon: NotebookPen,
  look: "bars",
  body: WritingWidget,
  settings: WritingSettings,
  parts: (c) => [{ kind: "writing", days: c.days === 30 ? 30 : 14 }],
  opener: () => () => s().openTab({ kind: "activity" }),
});
