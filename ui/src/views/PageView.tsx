// A note: title, icon, properties, editor and backlinks.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FileCode2, Minimize2, MoveHorizontal, CalendarDays, ChevronLeft, ChevronRight, Columns2, History, Printer, CornerDownRight, FileText, Hash, KanbanSquare, Link2, List, MoreHorizontal, NotebookPen, Plus, PencilLine, Presentation, Share2, SmilePlus, Star, Sunset, Table2, Trash2, Reply, FileDown } from "lucide-react";
import { openFollowUp, reportMarkdown } from "../components/MeetingWork";
import { startPresentation } from "../components/Presentation";
import { api } from "../lib/api";
import { openIfFileLink } from "../editor/files";
import { openAtAnchor } from "../editor/reveal";
import { ConflictBanner } from "./ConflictView";
import { useApp, type Tab } from "../store/app";
import { ViewHeader } from "../components/ViewHeader";
import { ScrollOutline } from "../components/ScrollOutline";
import { MEETING_SUMMARY_EVENT, NoteEditor, flushAllEditors, type NoteEditorHandle } from "../editor/NoteEditor";
import { splitFrontmatter } from "../editor/extensions";
import { parseFrontmatter } from "../lib/frontmatter";
import { cleanTitleChars } from "../lib/links";
import { PAGE_ICONS, PageIcon, iconLabel } from "../components/icons";
import { Button, EmptyState, IconButton, Spinner, useMenu } from "../components/ui";
import { addDays, dateLong, isoDay, relative } from "../lib/format";
import { linkContext } from "../components/linkContext";
import type { PageDoc, SavedPage } from "../lib/types";
import { restorePage } from "./TrashView";
import { SourceEditor } from "../editor/SourceEditor";
import { PAGE_COMMAND_EVENT, pageMode, setPageMode, togglePageSource, usePageMode, type PageCommand } from "../lib/pageModes";
import { useTimeTracking } from "../lib/timetracking";
import { ADD_PROPERTY_EVENT, PropertyEditor, WorkCard, pageReference, type FolderSchema } from "./PageProperties";
import { CollectionView } from "./collection/CollectionView";
import { FRONTMATTER_EVENT, registerFrontmatterOwner } from "./collection/write";
import { isManagedKey, parseSchema, parseView, setView, type ViewType } from "../lib/collection";
import { VersionsDialog } from "./VersionsDialog";
import { DuplicateHint } from "./DuplicateHint";
import { TagSuggestions } from "./TagSuggestions";
import { useMentionHints } from "../editor/mentionHints";
import { sharePageAsHtml } from "../editor/shareHtml";
import { openCalendar } from "../components/CalendarPopover";
import { MeetingSummaryDialog } from "./MeetingSummaryDialog";
import { renamePageWithUndo } from "../editor/rename";
import { aiEnabled } from "../lib/aiswitch";
import { consumeKey, hint, withHint } from "../lib/keymap";
import { withSaved } from "../lib/pagesave";
import { openDayReview } from "../lib/reviewnav";
import { t as tr, useT } from "../lib/i18n";
import { isComposing } from "../lib/ime";
import { SHOWN_PLACE } from "../lib/keepalive";

export function PageView({ pageId, tab, active }: { pageId: number; tab: Tab; active: boolean }) {
  useT();
  const [doc, setDoc] = useState<PageDoc | null>(null);
  const [missing, setMissing] = useState(false);
  // The frontmatter as the editor holds it (it saves it with the body).
  const [fm, setFm] = useState("");
  const fmRef = useRef(fm);
  fmRef.current = fm;
  // The schema of the folder this page is in (its parent's `eigenschaften:`).
  const [folder, setFolder] = useState<FolderSchema | null>(null);
  const [addingProp, setAddingProp] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const closeSummary = useCallback(() => setSummaryOpen(false), []);
  const getEditor = useCallback(() => handle.current?.editor ?? null, []);
  const flushEditor = useCallback(async () => handle.current?.flush(), []);
  const pages = useApp((s) => s.pages);
  const handle = useRef<NoteEditorHandle | null>(null);
  // The editor toolbar sits in the header row, where the page's small title was.
  const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  // The Markdown this page's editor stored last: its own save event needs no reload.
  const ownSave = useRef<string | null>(null);
  // A save of this pane: tags, unresolved links and time change; backlinks do not.
  const onOwnSave = useCallback((saved: SavedPage & { content: string }) => {
    ownSave.current = saved.content;
    setDoc((cur) => (cur ? withSaved(cur, saved, saved.content) : cur));
  }, []);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setMissing(false);
    api
      .page(pageId)
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setFm(splitFrontmatter(d.content).frontmatter);
        if (activeRef.current) useApp.getState().set({ activeDoc: d });
        // Created elsewhere (another window, quick capture, the assistant): the tab and the tree
        // take their titles from the tree, so load it.
        if (!useApp.getState().pages.has(d.id)) useApp.getState().refreshTree();
      })
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
      handle.current?.flush().catch(() => {});
    };
  }, [pageId]);

  // Full width and Markdown source mode, per page. Switching the mode saves every editor
  // first; the other editor then starts from the page as stored after that, fetched before
  // it is shown (never from the content this view loaded earlier).
  const full = usePageMode("full", pageId);
  const wantSource = usePageMode("source", pageId);
  const [source, setSource] = useState(wantSource);
  const switching = source !== wantSource;
  useEffect(() => {
    if (!switching) return;
    let alive = true;
    flushAllEditors()
      .catch(() => {})
      .then(() => api.page(pageId))
      .then((d) => {
        if (!alive) return;
        setDoc(d);
        setFm(splitFrontmatter(d.content).frontmatter);
        setSource(wantSource);
      })
      .catch(() => alive && setMissing(true));
    return () => {
      alive = false;
    };
  }, [switching, wantSource, pageId]);

  // Frontmatter changes from the table/board or a property menu go through this page's editor.
  // Only once the page is loaded: before that, the frontmatter here is not the page's yet.
  const sourceMode = source || switching;
  const loaded = doc?.id === pageId;
  useEffect(() => {
    if (sourceMode || !loaded) return;
    return registerFrontmatterOwner(pageId, {
      shown: () => (root.current?.getClientRects().length ?? 0) > 0,
      get: () => fmRef.current,
      set: (next) => {
        fmRef.current = next;
        setFm(next);
        handle.current?.setFrontmatter(next);
      },
    });
  }, [pageId, sourceMode, loaded]);

  const parentId = useApp((st) => st.pages.get(pageId)?.parent_id ?? null);
  const hasChildren = useApp((st) => (st.pages.get(pageId)?.children.length ?? 0) > 0);
  const parentTitle = useApp((st) => (parentId != null ? (st.pages.get(parentId)?.title ?? "") : ""));
  useEffect(() => {
    if (parentId == null) return setFolder(null);
    let alive = true;
    const load = () =>
      api
        .pageSchema(pageId)
        .then((r) => alive && setFolder(r ? { parentId: r[0], parentTitle, defs: r[1].props } : null))
        .catch(() => {});
    load();
    // The parent's schema changed (its pane, a table, a property menu).
    const onFm = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; fm: string }>).detail;
      if (d.id !== parentId) return;
      const defs = parseSchema(d.fm);
      setFolder(defs ? { parentId, parentTitle, defs } : null);
    };
    const onSaved = (e: Event) => (e as CustomEvent<{ id: number }>).detail.id === parentId && load();
    window.addEventListener(FRONTMATTER_EVENT, onFm);
    window.addEventListener("arcalo:page-saved", onSaved);
    return () => {
      alive = false;
      window.removeEventListener(FRONTMATTER_EVENT, onFm);
      window.removeEventListener("arcalo:page-saved", onSaved);
    };
  }, [pageId, parentId, parentTitle]);

  useEffect(() => {
    if (!active) return;
    const onCmd = (e: Event) => {
      const cmd = (e as CustomEvent<PageCommand>).detail;
      if (cmd === "source") togglePageSource(pageId);
      else setPageMode("full", pageId, !pageMode("full", pageId));
    };
    window.addEventListener(PAGE_COMMAND_EVENT, onCmd);
    return () => window.removeEventListener(PAGE_COMMAND_EVENT, onCmd);
  }, [active, pageId]);

  // Palette „Eigenschaft hinzufügen“ / Ctrl+; acts on the focused pane's page.
  useEffect(() => {
    if (!active) return;
    const onAdd = () => setAddingProp(true);
    window.addEventListener(ADD_PROPERTY_EVENT, onAdd);
    return () => window.removeEventListener(ADD_PROPERTY_EVENT, onAdd);
  }, [active]);

  // Slash „/Zusammenfassung“ in this page's editor (sent from the editor's element).
  useEffect(() => {
    const onSummary = (e: Event) => (e as CustomEvent<{ id: number }>).detail.id === pageId && e.target instanceof Node && !!root.current?.contains(e.target) && setSummaryOpen(true);
    window.addEventListener(MEETING_SUMMARY_EVENT, onSummary);
    return () => window.removeEventListener(MEETING_SUMMARY_EVENT, onSummary);
  }, [pageId]);

  // The focused pane drives the outline, links panel and assistant context.
  useEffect(() => {
    if (active && doc) useApp.getState().set({ activeDoc: doc });
  }, [active, doc]);

  // Another pane changed this page (or a rename rewrote links): refresh tags and backlinks.
  useEffect(() => {
    const refresh = () =>
      api.page(pageId).then((fresh) => setDoc((cur) => (cur ? { ...cur, tags: fresh.tags, backlinks: fresh.backlinks, unresolved_links: fresh.unresolved_links, content: fresh.content, updated_at: fresh.updated_at } : cur))).catch(() => {});
    const onSaved = (e: Event) => {
      const d = (e as CustomEvent<{ id: number; content?: string }>).detail;
      if (d.id === pageId && d.content !== ownSave.current) refresh();
    };
    const onReload = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
      if (!ids || ids.includes(pageId)) refresh();
    };
    window.addEventListener("arcalo:page-saved", onSaved);
    window.addEventListener("arcalo:reload-pages", onReload);
    return () => {
      window.removeEventListener("arcalo:page-saved", onSaved);
      window.removeEventListener("arcalo:reload-pages", onReload);
    };
  }, [pageId]);

  // Dotted hints under unlinked titles (Settings → Editor), refreshed after each save.
  const hintsOn = useApp((st) => !!st.settings?.settings.editor?.mention_hints);
  useMentionHints(doc?.id, doc?.updated_at, hintsOn && !source);

  const openLink = useCallback(async (target: string, newTab: boolean, anchor?: string | null) => {
    if (openIfFileLink(target)) return;
    try {
      await handle.current?.flush();
      const page = await api.resolvePage(target, true);
      if (!page) return;
      if (!useApp.getState().pages.has(page.id)) await useApp.getState().refreshTree();
      const opts = { newTab: newTab && !altKey.current, split: altKey.current };
      // `[[Seite#Abschnitt]]` / `[[Seite#^id]]`: scrolled to that heading or block.
      await openAtAnchor(page.id, anchor ?? null, (id) => useApp.getState().openPage(id, opts));
    } catch (e) {
      useApp.getState().error(tr("pv.linkFailed"), e);
    }
  }, []);
  const openTag = useCallback((tag: string) => useApp.getState().openTab({ kind: "tag", tag }, { newTab: true }), []);
  // Alt+click on a link opens it in the pane to the right.
  const altKey = useRef(false);
  const timeOn = useTimeTracking();
  useEffect(() => {
    const track = (e: MouseEvent) => (altKey.current = e.altKey);
    window.addEventListener("mousedown", track, true);
    return () => window.removeEventListener("mousedown", track, true);
  }, []);

  if (missing)
    return (
      <>
        <ViewHeader tab={tab} title={tr("pv.notFound")} />
        <EmptyState icon={FileText} title={tr("pv.notFound")}>{tr("pv.notFoundText")}</EmptyState>
      </>
    );
  if (!doc)
    return (
      <>
        <ViewHeader tab={tab} title={pages.get(pageId)?.title ?? ""} />
        <div className="center-fill"><Spinner /></div>
      </>
    );

  const reference = pageReference(fm);
  // Frontmatter edits of this page: through the editor's save path, so body and properties never overwrite each other.
  const changeFm = (next: string) => {
    fmRef.current = next;
    setFm(next);
    handle.current?.setFrontmatter(next);
  };
  const node = pages.get(doc.id);
  const crumbs: { id: number; title: string }[] = [];
  for (let p = node?.parent_id != null ? pages.get(node.parent_id) : undefined; p; p = p.parent_id != null ? pages.get(p.parent_id) : undefined) crumbs.unshift(p);

  return (
    <div className="page-view" ref={root}>
      <PageHeader
        tab={tab}
        root={root}
        doc={doc}
        crumbs={crumbs}
        // From the newest page (a save may have landed while the title or a button waited).
        onChange={(d) => setDoc((cur) => cur && { ...cur, ...d })}
        onSummary={() => setSummaryOpen(true)}
        toolbarSlot={setToolbarSlot}
        full={full}
        source={source}
        // Table and board views are offered for pages with subpages (or a view already set up).
        viewType={source || (!hasChildren && parseView(fm).type === "liste" && !parseSchema(fm)) ? null : parseView(fm).type}
        onViewType={(t) => changeFm(setView(fmRef.current, { ...parseView(fmRef.current), type: t }))}
      >
        <ConflictBanner pageId={doc.id} />
        {!source && <DuplicateHint page={{ id: doc.id, title: doc.title }} savedAt={doc.updated_at} />}
        {!source && <Properties doc={doc} fm={fm} typed={!!folder?.defs.length} onAdd={() => setAddingProp(true)} />}
        {!source && <PropertyEditor
          fm={fm}
          adding={addingProp}
          onAdded={() => setAddingProp(false)}
          folder={folder}
          parentId={parentId}
          onChange={changeFm}
        />}
        {!source && <TagSuggestions pageId={doc.id} tags={doc.tags} fm={fm} onFm={changeFm} />}
        {reference && timeOn && <WorkCard pageId={doc.id} reference={reference} title={doc.title} />}
        {switching ? (
          // Between the two editors while the page is fetched: typing here would be lost.
          <div className="editor-switching" aria-busy="true" />
        ) : source ? (
          <SourceEditor
            key={`source-${doc.id}`}
            active={active}
            doc={doc}
            onSaved={(d) => {
              onOwnSave(d);
              setFm(splitFrontmatter(d.content).frontmatter);
            }}
          />
        ) : (
        <NoteEditor
          onFrontmatter={setFm}
          key={doc.id}
          active={active}
          doc={doc}
          onSaved={onOwnSave}
          onOpenLink={openLink}
          onOpenTag={openTag}
          handleRef={(h) => (handle.current = h)}
          toolbarSlot={toolbarSlot}
        />
        )}
        {!source && <CollectionView pageId={doc.id} fm={fm} onFm={changeFm} />}
        <Backlinks doc={doc} />
        <MeetingSummaryDialog open={summaryOpen} page={doc} reference={reference} getEditor={getEditor} flush={flushEditor} onClose={closeSummary} />
      </PageHeader>
    </div>
  );
}

function PageHeader({
  tab,
  root,
  doc,
  crumbs,
  onChange,
  onSummary,
  toolbarSlot,
  full,
  source,
  viewType,
  onViewType,
  children,
}: {
  viewType: ViewType | null;
  onViewType: (t: ViewType) => void;
  tab: Tab;
  root: React.RefObject<HTMLDivElement | null>;
  doc: PageDoc;
  crumbs: { id: number; title: string }[];
  onChange: (d: Partial<PageDoc>) => void;
  onSummary: () => void;
  toolbarSlot: (el: HTMLDivElement | null) => void;
  full: boolean;
  source: boolean;
  children: React.ReactNode;
}) {
  useT();
  const toolbarOn = useApp((st) => st.settings?.settings.editor?.toolbar ?? true);
  const [title, setTitle] = useState(doc.title);
  // `[ ] | # ^` were typed and replaced (they belong to the link syntax).
  const [titleHint, setTitleHint] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  useEffect(() => setTitle(doc.title), [doc.title]);

  const commitTitle = async () => {
    setTitleHint(false);
    const t = title.trim();
    if (!t || t === doc.title) return setTitle(doc.title);
    try {
      // As in the tree: links follow, and the toast takes it back.
      await renamePageWithUndo(doc.id, doc.title, t);
      onChange({ title: t });
    } catch (e) {
      setTitle(doc.title);
      s().error(tr("page.renameFailed"), e);
    }
  };

  const daily = doc.daily_date ? new Date(doc.daily_date + "T12:00:00") : null;
  const goDay = async (delta: number) => {
    // Quick clicks add up: from the day still being opened, not the one shown.
    const day = isoDay(addDays(pendingDay.day ? new Date(`${pendingDay.day}T12:00:00`) : daily!, delta));
    pendingDay.day = day;
    try {
      const p = await api.dailyNote(day);
      if (pendingDay.day !== day) return;
      await s().refreshTree();
      s().openPage(p.id);
    } finally {
      if (pendingDay.day === day) pendingDay.day = null;
    }
  };

  const titleInput = useRef<HTMLTextAreaElement>(null);
  const scrollBox = useRef<HTMLDivElement>(null);
  const showOutline = useApp((st) => st.settings?.settings.editor?.scroll_outline !== false);
  // The title wraps like a heading instead of scrolling sideways.
  const fitTitle = () => {
    const el = titleInput.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(fitTitle, [title]);
  useEffect(() => {
    const el = titleInput.current;
    if (!el) return;
    // Only a new width changes the wrapping; fitting changes the height, which must not re-trigger.
    let width = el.clientWidth;
    let frame = 0;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitTitle);
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, []);
  const actions = (
    <>
      {daily && (
        <>
          <IconButton icon={ChevronLeft} label={tr("pv.prevDay")} size="md" onClick={() => goDay(-1)} />
          <IconButton icon={CalendarDays} label={hint("calendar") ? tr("pv.calendar", { keys: hint("calendar") }) : tr("cmd.calendar")} size="md" onClick={(e) => openCalendar(e.currentTarget, doc.daily_date ?? undefined)} />
          <IconButton icon={ChevronRight} label={tr("pv.nextDay")} size="md" onClick={() => goDay(1)} />
        </>
      )}
      <IconButton
        icon={source ? Eye : FileCode2}
        label={withHint(source ? tr("pv.normalEditor") : tr("editor.source"), "toggle_source")}
        active={source}
        size="md"
        onClick={() => togglePageSource(doc.id)}
      />
      <IconButton
        icon={full ? Minimize2 : MoveHorizontal}
        label={withHint(full ? tr("pv.normalWidth") : tr("pv.fullWidth"), "full_width")}
        active={full}
        size="md"
        onClick={() => setPageMode("full", doc.id, !full)}
      />
      <IconButton
        icon={Star}
        label={doc.favorite ? tr("pv.unbookmark") : tr("pv.bookmark")}
        active={doc.favorite}
        className={doc.favorite ? "star-on" : ""}
        size="md"
        onClick={async () => {
          try {
            await api.setFavorite(doc.id, !doc.favorite);
            onChange({ favorite: !doc.favorite });
            s().refreshTree();
          } catch (e) {
            s().error(tr("sb.favoriteFailed"), e);
          }
        }}
      />
      <IconButton aria-haspopup="menu"
        icon={MoreHorizontal}
        label={tr("pv.more")}
        size="md"
        onClick={(e) =>
          openMenuAt(e, [
            { label: tr("att.renameButton"), icon: PencilLine, onSelect: () => titleInput.current?.select() },
            { label: tr("sb.changeIcon"), icon: SmilePlus, onSelect: () => setIconOpen(true) },
            { label: tr("sb.openRight"), icon: Columns2, onSelect: () => s().splitTab(tab.id) },
            { label: tr("pv.copyLink"), icon: Link2, onSelect: () => navigator.clipboard.writeText(`[[${doc.title}]]`) },
            { label: tr("cmd.present"), icon: Presentation, shortcut: hint("present"), onSelect: () => void startPresentation(doc.id) },
            { label: tr("pv.print"), icon: Printer, onSelect: () => printActivePane() },
            { label: tr("mw.pv.markdown"), icon: FileDown, onSelect: () => void reportMarkdown(doc) },
            { label: tr("mw.pv.followUp"), icon: Reply, onSelect: () => openFollowUp(doc.id) },
            { label: tr("pv.shareHtml"), icon: Share2, onSelect: () => sharePageAsHtml(doc.id, false) },
            ...(s().pages.get(doc.id)?.children.length
              ? [{ label: tr("pv.shareHtmlTree"), icon: Share2, onSelect: () => sharePageAsHtml(doc.id, true) }]
              : []),
            { label: tr("pv.versions"), icon: History, onSelect: () => setVersionsOpen(true) },
            // „KI verwenden“ off: no AI entries in the menu either.
            ...(aiEnabled() ? [{ label: tr("pv.summarize"), icon: NotebookPen, onSelect: onSummary }] : []),
            { label: tr("pv.newSubpage"), icon: CornerDownRight, onSelect: () => createSubpage(doc.id) },
            ...(viewType === null
              ? []
              : [
                  viewType !== "tabelle" ? { label: tr("pv.asTable"), icon: Table2, onSelect: () => onViewType("tabelle") } : null,
                  viewType !== "board" ? { label: tr("pv.asBoard"), icon: KanbanSquare, onSelect: () => onViewType("board") } : null,
                  viewType !== "liste" ? { label: tr("pv.asList"), icon: List, onSelect: () => onViewType("liste") } : null,
                ].filter((x) => x !== null)),
            "separator",
            { label: tr("pv.delete"), icon: Trash2, danger: true, onSelect: () => deletePage(doc) },
          ])
        }
      />
    </>
  );

  return (
    <>
      <ViewHeader
        tab={tab}
        crumbs={crumbs.map((c) => (
          <span key={c.id} className="crumb">
            <button type="button" onClick={(e) => s().openPage(c.id, { newTab: e.ctrlKey || e.metaKey })}>{c.title}</button>
            <span className="crumb-sep">/</span>
          </span>
        ))}
        title={doc.title}
        // The toolbar's slot stays mounted: the editor portals into it and unmounts after the header
        // has switched to the source mode label.
        center={
          toolbarOn || source ? (
            <div className="vh-center">
              {toolbarOn && <div className="vh-toolbar" ref={toolbarSlot} hidden={source} />}
              {source && <div className="vh-mode">{tr("editor.source")}</div>}
            </div>
          ) : undefined
        }
        actions={actions}
      />
      <div className="page-scroll-wrap">
      <div className="page-scroll" ref={scrollBox}>
        <div className={`page ${full ? "page-full" : ""}`}>
          <header className="page-header">
            <div className="page-title-row">
              <button type="button" className="page-icon-btn" aria-label={tr("sb.changeIcon")} onClick={() => setIconOpen((v) => !v)}>
                <PageIcon name={doc.icon} size={26} />
              </button>
              <textarea
                ref={titleInput}
                className="page-title"
                rows={1}
                value={title}
                spellCheck={false}
                aria-label={tr("pv.titleAria")}
                onChange={(e) => {
                  const typed = e.target.value.replace(/\n/g, " ");
                  const clean = cleanTitleChars(typed);
                  setTitle(clean);
                  if (clean !== typed) setTitleHint(true);
                }}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (isComposing(e)) return;
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLTextAreaElement).blur();
                    root.current?.querySelector<HTMLElement>(".ProseMirror")?.focus();
                  }
                  // Escape takes back the typing (and is not passed on to end the focus mode).
                  if (e.key === "Escape" && title !== doc.title) (consumeKey(e), setTitle(doc.title));
                }}
              />
            </div>
            {titleHint && (
              <div className="page-subtitle page-title-hint" role="status">
                {tr("pv.titleHint")}
              </div>
            )}
            {daily && (
              <div className="page-subtitle">
                {dateLong(daily.toISOString())}
                <button type="button" className="page-review-link" onClick={(e) => openDayReview(doc.daily_date!, { newTab: e.ctrlKey || e.metaKey })} title={tr("pv.reviewTip")}>
                  <Sunset size={12} aria-hidden />
                  {tr("pv.review")}
                </button>
              </div>
            )}
            {iconOpen && (
              <div className="icon-picker" role="listbox" aria-label={tr("pv.chooseIcon")}>
                {Object.entries(PAGE_ICONS).map(([name, Icon]) => (
                  <button
                    key={name}
                    type="button"
                    aria-label={iconLabel(name)}
                    title={iconLabel(name)}
                    className={doc.icon === name ? "on" : ""}
                    onClick={async () => {
                      try {
                        await api.setIcon(doc.id, name);
                        onChange({ icon: name });
                        setIconOpen(false);
                        s().refreshTree();
                      } catch (e) {
                        s().error(tr("sb.iconFailed"), e);
                      }
                    }}
                  >
                    <Icon size={18} strokeWidth={1.75} />
                  </button>
                ))}
              </div>
            )}
            {menu}
            <VersionsDialog page={doc} open={versionsOpen} onClose={() => setVersionsOpen(false)} />
          </header>
          {children}
        </div>
      </div>
      {showOutline && <ScrollOutline scrollRef={scrollBox} />}
      </div>
    </>
  );
}

function Properties({ doc, fm, typed, onAdd }: { doc: PageDoc; fm: string; typed: boolean; onAdd: () => void }) {
  useT();
  const { body } = splitFrontmatter(doc.content);
  // Inline #tags are already clickable in the text; only show the others (frontmatter tags).
  const lower = body.toLowerCase();
  // A `tags:` property shows its own chips below: do not repeat them here.
  const hasTagsProp = parseFrontmatter(fm).some((p) => /^tags?$/i.test(p.key));
  const extraTags = hasTagsProp ? [] : doc.tags.filter((t) => !lower.includes(`#${t.toLowerCase()}`));
  return (
    <div className="props">
      <span className="prop faint">{tr("pv.edited", { when: relative(doc.updated_at) })}</span>
      {extraTags.map((t) => (
        <button key={t} type="button" className="tag-chip" onClick={() => useApp.getState().openTab({ kind: "tag", tag: t }, { newTab: true })}>
          <Hash size={11} />
          {t}
        </button>
      ))}
      {!typed && !parseFrontmatter(fm).some((p) => (p.key || p.value.trim()) && !isManagedKey(p.key)) && (
        <button type="button" className="prop-add" onClick={onAdd} title={withHint(tr("props.add"), "add_property")}>
          <Plus size={13} /> {tr("props.add")}
        </button>
      )}
    </div>
  );
}

function Backlinks({ doc }: { doc: PageDoc }) {
  useT();
  if (!doc.backlinks.length) return null;
  return (
    <section className="backlinks" aria-label={tr("pv.backlinks")}>
      <h2>
        <Link2 size={14} /> {tr("pv.linkedFrom", { n: doc.backlinks.length })}
      </h2>
      {doc.backlinks.map((b) => (
        <button key={b.page_id} type="button" className="backlink" onClick={(e) => useApp.getState().openPage(b.page_id, { newTab: e.ctrlKey || e.metaKey })}>
          <span className="backlink-title">
            <PageIcon name={b.icon} size={14} /> {b.title}
          </span>
          {b.context && <span className="backlink-context">{linkContext(b.context, doc.title)}</span>}
        </button>
      ))}
    </section>
  );
}

/** Prints the focused pane only (the print stylesheet hides everything else); "Als PDF speichern" in the dialog. */
export function printActivePane() {
  flushAllEditors()
    .catch(() => {})
    // Embeds, diagrams (light) and queries not yet scrolled into view render first.
    .then(() => preparePrint())
    .catch(() => {})
    .finally(() => setTimeout(() => window.print(), 50));
}

/** Renders the lazy blocks of the open pages for printing; diagrams light until it is over. */
async function preparePrint() {
  const pane = document.querySelector(SHOWN_PLACE) ?? document;
  if (!pane.querySelector(".page-embed, .rich-preview")) return;
  const [{ renderAllNow }, { setPrintTheme }] = await Promise.all([import("../editor/lazyRender"), import("../editor/mermaid")]);
  setPrintTheme(true);
  // Back to the app's theme after printing (or with the next click where `afterprint` is missing).
  const reset = () => {
    window.removeEventListener("afterprint", reset);
    window.removeEventListener("pointerdown", reset, true);
    setPrintTheme(false);
  };
  window.addEventListener("afterprint", reset);
  window.addEventListener("pointerdown", reset, true);
  await renderAllNow();
}

/** Parent of a new top-level „Neue Seite“ per Settings → Editor (top level, current folder, inbox). */
async function newPageParent(): Promise<number | null> {
  const s = useApp.getState();
  const e = s.settings?.settings.editor;
  if (e?.new_page_location === "current") {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab?.kind === "page" && tab.pageId != null ? (s.pages.get(tab.pageId)?.parent_id ?? null) : null;
  }
  if (e?.new_page_location === "inbox") {
    const title = e.inbox_title?.trim() || "Inbox";
    const top = s.tree.find((n) => n.parent_id == null && n.title.toLowerCase() === title.toLowerCase());
    if (top) return top.id;
    return (await api.createPage(title, null, "list-todo")).id;
  }
  return null;
}

export async function createSubpage(parentId: number | null, title = tr("page.untitled")) {
  const s = useApp.getState();
  try {
    const parent = parentId ?? (await newPageParent());
    const icon = s.settings?.settings.editor?.default_icon ?? "file-text";
    const p = await api.createPage(title, parent, icon);
    await s.refreshTree();
    s.openPage(p.id);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>(`${SHOWN_PLACE} .page-title`)?.select(), 120);
  } catch (e) {
    s.error(tr("page.createFailed"), e);
  }
}

/** The daily note the previous/next buttons are opening (several clicks before it shows). */
const pendingDay: { day: string | null } = { day: null };

export async function deletePage(page: { id: number; title: string }) {
  const s = useApp.getState();
  const kids = s.pages.get(page.id)?.children.length ?? 0;
  const days = s.settings?.settings.notes?.trash_retention_days ?? 30;
  const message = kids ? tr("pv.deleteTree", { title: page.title, n: kids, days }) : tr("pv.deleteOne", { title: page.title, days });
  // A single page just moves to the trash (undo in the toast); only subtrees ask first.
  if (kids && !(await s.confirm({ title: tr("pv.deleteTitle"), message, confirmLabel: tr("common.delete"), danger: true }))) return;
  // The pane that shows the page: „Rückgängig“ brings its tab back there.
  const shownIn = s.panes.find((p) => p.tabs.some((t) => t.id === p.activeTabId && t.kind === "page" && t.pageId === page.id))?.id;
  const undo = async () => {
    if (!(await restorePage(page.id, page.title)) || !shownIn) return;
    const st = useApp.getState();
    if (st.panes.some((p) => p.id === shownIn)) st.focusPane(shownIn);
    st.openPage(page.id, { newTab: true });
  };
  try {
    await api.deletePage(page.id);
    await s.refreshTree();
    s.toast({ tone: "info", title: tr("pv.deleted"), detail: tr("pv.inTrash", { title: page.title }), action: { label: tr("common.undo"), run: () => void undo() } });
  } catch (e) {
    s.error(tr("pv.deleteFailed"), e);
  }
}

export function NewPageButton() {
  useT();
  return <Button icon={FileText} onClick={() => createSubpage(null)}>{tr("sidebar.newPage")}</Button>;
}
