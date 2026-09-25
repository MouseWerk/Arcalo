// Widgets of pages: Zuletzt bearbeitet, Lesezeichen, Angeheftet, Notiz, Seite einbetten and
// Aktivität.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Activity as ActivityIcon, CheckSquare, Clock3, Eye, FileText, Paperclip, PenLine, Pin, Star, Target } from "lucide-react";
import { api } from "../../lib/api";
import { useApp } from "../../store/app";
import { relative } from "../../lib/format";
import { t } from "../../lib/i18n";
import { renderMarkdown } from "../../lib/markdown";
import { describe, groupOf } from "../../lib/activity";
import { configOf } from "../../lib/dashboard";
import type { Activity, Page } from "../../lib/types";
import type { PageData } from "../../lib/dashtypes";
import { Button, IconButton } from "../ui";
import { PageIcon } from "../icons";
import { reloadEditors } from "../../editor/NoteEditor";
import { useBoard } from "./board";
import { useDash, useWidgetData } from "./data";
import { Empty, Loadable, PageRows, s } from "./common";
import type { WidgetProps } from "./registry";

export function RecentWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<Page[]>(widget);
  const wide = widget.w >= 4;
  return <Loadable loading={loading} error={error}>{() => (data!.length ? <PageRows pages={data!} when={wide} /> : <Empty icon={FileText}>{t("dash.recentEmpty")}</Empty>)}</Loadable>;
}

export function FavoritesWidget() {
  const pages = useApp((st) => st.pages);
  const favs = useMemo(() => [...pages.values()].filter((p) => p.favorite && !p.deleted_at).sort((a, b) => a.title.localeCompare(b.title, "de")), [pages]);
  if (!favs.length) return <Empty icon={Star}>{t("dash.favoritesEmpty")}</Empty>;
  return <PageRows pages={favs.slice(0, 20)} />;
}

export function PinnedWidget({ widget, openSettings }: WidgetProps) {
  const pages = useApp((st) => st.pages);
  const ids = (configOf(widget).pages as number[] | undefined) ?? [];
  const list = ids.map((id) => pages.get(id)).filter((p): p is NonNullable<typeof p> => !!p && !p.deleted_at);
  if (!list.length)
    return (
      <Empty icon={Pin} action={<Button size="sm" onClick={openSettings}>{t("dash.pinPages")}</Button>}>
        {t("dash.pinnedEmpty")}
      </Empty>
    );
  return <PageRows pages={list} />;
}

/** Markdown without its frontmatter block. */
export const bodyOf = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

/** Opens a clicked `[[Seite]]` link of rendered Markdown. */
async function followLink(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const target = a.getAttribute("data-target");
  if (target) {
    const page = await api.resolvePage(target, false).catch(() => null);
    if (page) s().openPage(page.id, { newTab: e.ctrlKey || e.metaKey });
    else s().toast({ tone: "info", title: t("dash.linkMissing", { title: target }) });
    return;
  }
  const href = a.getAttribute("href");
  if (href && /^(https?:|mailto:)/.test(href)) {
    openUrl(href).catch(() => {});
  }
}

export function NoteWidget({ widget }: WidgetProps) {
  const c = configOf(widget);
  if (c.mode === "page" && typeof c.page === "number") return <PageNote widget={widget} />;
  return <TextNote id={widget.id} />;
}

/** The scratch text, saved with the start page (after a pause in typing). */
function TextNote({ id }: { id: string }) {
  const { notes, setNote } = useBoard();
  const stored = notes[id] ?? "";
  const [text, setText] = useState(stored);
  const [preview, setPreview] = useState(false);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const flush = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v != null) setNote(id, v);
  };
  // Another window changed it: take it over unless something is being typed here.
  useEffect(() => {
    if (pending.current == null) setText(stored);
  }, [stored]);
  useEffect(() => flush, []);
  return (
    <div className="dw-note-wrap">
      {preview ? (
        <div className="dw-md dw-note-preview" onClick={followLink} dangerouslySetInnerHTML={{ __html: text.trim() ? renderMarkdown(text) : `<p class="faint">${t("dash.noteEmpty")}</p>` }} />
      ) : (
        <textarea
          className="input dw-note"
          value={text}
          placeholder={t("dash.notePlaceholder")}
          aria-label={t("dash.w.note")}
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            pending.current = e.target.value;
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 600);
          }}
          onBlur={flush}
        />
      )}
      <IconButton className="dw-note-toggle" icon={preview ? PenLine : Eye} size="sm" label={preview ? t("dash.noteEdit") : t("dash.notePreview")} onClick={() => (flush(), setPreview(!preview))} />
    </div>
  );
}

/** A page as the note: its text is edited here and saved to the page. */
function PageNote({ widget }: { widget: WidgetProps["widget"] }) {
  const { data, error, loading } = useWidgetData<PageData>(widget);
  const [text, setText] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | null>(null);
  const id = configOf(widget).page as number;
  const flush = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const v = pending.current;
    pending.current = null;
    if (v == null) return;
    api.savePage(id, v).then(
      () => reloadEditors([id]),
      (e) => s().error(t("dash.noteSaveFailed"), e),
    );
  };
  useEffect(() => {
    if (pending.current == null && data) setText(data.content);
  }, [data]);
  useEffect(() => flush, []);
  return (
    <Loadable loading={loading && text == null} error={error}>
      {() => (
        <textarea
          className="input dw-note"
          value={text ?? ""}
          aria-label={t("dash.noteOf", { title: data?.title ?? "" })}
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            pending.current = e.target.value;
            if (timer.current != null) window.clearTimeout(timer.current);
            timer.current = window.setTimeout(flush, 800);
          }}
          onBlur={flush}
        />
      )}
    </Loadable>
  );
}

export function EmbedWidget({ widget, openSettings }: WidgetProps) {
  const c = configOf(widget);
  const { data, error, loading } = useWidgetData<PageData>(widget);
  const html = useMemo(() => (data ? renderMarkdown(bodyOf(data.content)) : ""), [data]);
  if (typeof c.page !== "number")
    return (
      <Empty icon={FileText} action={<Button size="sm" onClick={openSettings}>{t("dash.pickPage")}</Button>}>
        {t("dash.embedEmpty")}
      </Empty>
    );
  return (
    <Loadable loading={loading} error={error}>
      {() => (
        <div className="dw-embed">
          <button type="button" className="dw-embed-title" onClick={(e) => s().openPage(data!.id, { newTab: e.ctrlKey || e.metaKey })}>
            <PageIcon name={data!.icon} size={14} />
            <span className="ellipsis">{data!.title}</span>
            <span className="faint small">{relative(data!.updated_at)}</span>
          </button>
          {bodyOf(data!.content).trim() ? <div className="dw-md" onClick={followLink} dangerouslySetInnerHTML={{ __html: html }} /> : <div className="dw-quiet">{t("dash.embedBlank")}</div>}
          {data!.truncated && <div className="faint small">{t("dash.embedCut")}</div>}
        </div>
      )}
    </Loadable>
  );
}

const KIND_ICON = { pages: FileText, tasks: CheckSquare, time: Clock3, files: Paperclip, focus: Target, system: ActivityIcon } as const;

export function ActivityWidget({ widget }: WidgetProps) {
  const { data, error, loading } = useWidgetData<Activity[]>(widget);
  const { refresh } = useDash();
  useEffect(() => {
    // Relative times age; a light reload every few minutes keeps „vor 2 Min.“ honest.
    const id = window.setInterval(() => refresh(["pages"]), 5 * 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);
  return (
    <Loadable loading={loading} error={error}>
      {() =>
        data!.length ? (
          <ul className="dw-list dw-feed">
            {data!.map((a) => {
              const d = describe(a);
              const Icon = KIND_ICON[groupOf(a.kind)];
              return (
                <li key={a.id}>
                  <button type="button" className="dw-row dw-feed-row" disabled={a.page_id == null && a.kind !== "entry_created"} onClick={(e) => (a.page_id != null ? s().openPage(a.page_id, { newTab: e.ctrlKey || e.metaKey }) : s().openTab({ kind: "timesheet" }))}>
                    <span className={`dw-feed-icon k-${groupOf(a.kind)}`} aria-hidden>
                      <Icon size={13} />
                    </span>
                    <span className="dw-feed-text">
                      <span className="ellipsis">
                        <span className="faint">{d.verb}</span> {d.title}
                      </span>
                    </span>
                    <span className="faint dw-when">{relative(a.at)}</span>
                  </button>
                </li>
              );
            })}
            <li>
              <button type="button" className="dw-row dw-more" onClick={() => s().openTab({ kind: "activity" })}>
                {t("dash.feedAll")}
              </button>
            </li>
          </ul>
        ) : (
          <Empty icon={ActivityIcon}>{t("dash.feedEmpty")}</Empty>
        )
      }
    </Loadable>
  );
}
