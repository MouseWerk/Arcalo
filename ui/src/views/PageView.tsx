// A note: title, icon, properties, editor and backlinks.

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Eye, FileCode2, Minimize2, MoveHorizontal, CalendarDays, ChevronLeft, ChevronRight, Columns2, History, Printer, CornerDownRight, FileText, Hash, KanbanSquare, Link2, List, MoreHorizontal, NotebookPen, Plus, PencilLine, Presentation, Share2, SmilePlus, Star, Table2, Trash2 } from "lucide-react";
import { startPresentation } from "../components/Presentation";
import { api } from "../lib/api";
import { ConflictBanner } from "./ConflictView";
import { useApp, type Tab } from "../store/app";
import { ViewHeader } from "../components/ViewHeader";
import { ScrollOutline } from "../components/ScrollOutline";
import { MEETING_SUMMARY_EVENT, NoteEditor, flushAllEditors, reloadEditors, type NoteEditorHandle } from "../editor/NoteEditor";
import { splitFrontmatter } from "../editor/extensions";
import { parseFrontmatter } from "../lib/frontmatter";
import { PAGE_ICONS, PageIcon, iconLabel } from "../components/icons";
import { Button, EmptyState, IconButton, Spinner, useMenu } from "../components/ui";
import { addDays, dateLong, isoDay, relative } from "../lib/format";
import { linkContext } from "../components/linkContext";
import type { PageDoc } from "../lib/types";
import { restorePage } from "./TrashView";
import { SourceEditor } from "../editor/SourceEditor";
import { PAGE_COMMAND_EVENT, pageMode, setPageMode, togglePageSource, usePageMode, type PageCommand } from "../lib/pageModes";
import { ADD_PROPERTY_EVENT, PropertyEditor, WorkCard, pageReference, type FolderSchema } from "./PageProperties";
import { CollectionView } from "./collection/CollectionView";
import { FRONTMATTER_EVENT, registerFrontmatterOwner } from "./collection/write";
import { isManagedKey, parseSchema, parseView, setView, type ViewType } from "../lib/collection";
import { VersionsDialog } from "./VersionsDialog";
import { sharePageAsHtml } from "../editor/shareHtml";
import { openCalendar } from "../components/CalendarPopover";
import { MeetingSummaryDialog } from "./MeetingSummaryDialog";
import { keys } from "../lib/shortcut";
import { hint, withHint } from "../lib/keymap";

export function PageView({ pageId, tab, active }: { pageId: number; tab: Tab; active: boolean }) {
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
    window.addEventListener("annalo:page-saved", onSaved);
    return () => {
      alive = false;
      window.removeEventListener(FRONTMATTER_EVENT, onFm);
      window.removeEventListener("annalo:page-saved", onSaved);
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

  // Slash „/Zusammenfassung“ in this page's editor.
  useEffect(() => {
    const onSummary = (e: Event) => (e as CustomEvent<{ id: number }>).detail.id === pageId && setSummaryOpen(true);
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
    const onSaved = (e: Event) => (e as CustomEvent<{ id: number }>).detail.id === pageId && refresh();
    const onReload = (e: Event) => {
      const ids = (e as CustomEvent<{ ids?: number[] }>).detail?.ids;
      if (!ids || ids.includes(pageId)) refresh();
    };
    window.addEventListener("annalo:page-saved", onSaved);
    window.addEventListener("annalo:reload-pages", onReload);
    return () => {
      window.removeEventListener("annalo:page-saved", onSaved);
      window.removeEventListener("annalo:reload-pages", onReload);
    };
  }, [pageId]);

  const openLink = useCallback(async (target: string, newTab: boolean) => {
    try {
      await handle.current?.flush();
      const page = await api.resolvePage(target, true);
      if (!page) return;
      if (!useApp.getState().pages.has(page.id)) await useApp.getState().refreshTree();
      useApp.getState().openPage(page.id, { newTab: newTab && !altKey.current, split: altKey.current });
    } catch (e) {
      useApp.getState().error("Link konnte nicht geöffnet werden", e);
    }
  }, []);
  const openTag = useCallback((tag: string) => useApp.getState().openTab({ kind: "tag", tag }, { newTab: true }), []);
  // Alt+click on a link opens it in the pane to the right.
  const altKey = useRef(false);
  useEffect(() => {
    const track = (e: MouseEvent) => (altKey.current = e.altKey);
    window.addEventListener("mousedown", track, true);
    return () => window.removeEventListener("mousedown", track, true);
  }, []);

  if (missing)
    return (
      <>
        <ViewHeader tab={tab} title="Seite nicht gefunden" />
        <EmptyState icon={FileText} title="Seite nicht gefunden">Sie wurde vermutlich gelöscht.</EmptyState>
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
        onChange={(d) => setDoc({ ...doc, ...d })}
        onSummary={() => setSummaryOpen(true)}
        toolbarSlot={setToolbarSlot}
        full={full}
        source={source}
        // Table and board views are offered for pages with subpages (or a view already set up).
        viewType={source || (!hasChildren && parseView(fm).type === "liste" && !parseSchema(fm)) ? null : parseView(fm).type}
        onViewType={(t) => changeFm(setView(fmRef.current, { ...parseView(fmRef.current), type: t }))}
      >
        <ConflictBanner pageId={doc.id} />
        {!source && <Properties doc={doc} fm={fm} typed={!!folder?.defs.length} onAdd={() => setAddingProp(true)} />}
        {!source && <PropertyEditor
          fm={fm}
          adding={addingProp}
          onAdded={() => setAddingProp(false)}
          folder={folder}
          parentId={parentId}
          onChange={changeFm}
        />}
        {reference && <WorkCard pageId={doc.id} reference={reference} title={doc.title} />}
        {switching ? (
          // Between the two editors while the page is fetched: typing here would be lost.
          <div className="editor-switching" aria-busy="true" />
        ) : source ? (
          <SourceEditor
            key={`source-${doc.id}`}
            active={active}
            doc={doc}
            onSaved={(d) => {
              setDoc((cur) => (cur ? { ...cur, tags: d.tags, backlinks: d.backlinks, unresolved_links: d.unresolved_links, updated_at: d.updated_at } : d));
              setFm(splitFrontmatter(d.content).frontmatter);
              if (activeRef.current) useApp.getState().set({ activeDoc: d });
            }}
          />
        ) : (
        <NoteEditor
          onFrontmatter={setFm}
          key={doc.id}
          active={active}
          doc={doc}
          onSaved={(d) => {
            setDoc((cur) => (cur ? { ...cur, tags: d.tags, backlinks: d.backlinks, unresolved_links: d.unresolved_links, updated_at: d.updated_at } : d));
            if (activeRef.current) useApp.getState().set({ activeDoc: d });
          }}
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
  const toolbarOn = useApp((st) => st.settings?.settings.editor?.toolbar ?? true);
  const [title, setTitle] = useState(doc.title);
  const [iconOpen, setIconOpen] = useState(false);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [menu, , openMenuAt] = useMenu();
  const s = useApp.getState;
  useEffect(() => setTitle(doc.title), [doc.title]);

  const commitTitle = async () => {
    const t = title.trim();
    if (!t || t === doc.title) return setTitle(doc.title);
    try {
      // All editors: a pending autosave elsewhere would write the old [[links]] back.
      await flushAllEditors();
      const n = await api.renamePage(doc.id, t, true);
      onChange({ title: t });
      reloadEditors();
      await s().refreshTree();
      if (n > 0) s().toast({ tone: "info", title: "Umbenannt", detail: `Links in ${n} ${n === 1 ? "Seite" : "Seiten"} aktualisiert` });
    } catch (e) {
      setTitle(doc.title);
      s().error("Umbenennen nicht möglich", e);
    }
  };

  const daily = doc.daily_date ? new Date(doc.daily_date + "T12:00:00") : null;
  const goDay = async (delta: number) => {
    const p = await api.dailyNote(isoDay(addDays(daily!, delta)));
    await s().refreshTree();
    s().openPage(p.id);
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
          <IconButton icon={ChevronLeft} label="Vorheriger Tag" size="md" onClick={() => goDay(-1)} />
          <IconButton icon={CalendarDays} label={`Kalender (${keys("Mod Shift C")})`} size="md" onClick={(e) => openCalendar(e.currentTarget, doc.daily_date ?? undefined)} />
          <IconButton icon={ChevronRight} label="Nächster Tag" size="md" onClick={() => goDay(1)} />
        </>
      )}
      <IconButton
        icon={source ? Eye : FileCode2}
        label={withHint(source ? "Normaler Editor" : "Markdown-Quelltext", "toggle_source")}
        active={source}
        size="md"
        onClick={() => togglePageSource(doc.id)}
      />
      <IconButton
        icon={full ? Minimize2 : MoveHorizontal}
        label={withHint(full ? "Normale Breite" : "Volle Breite", "full_width")}
        active={full}
        size="md"
        onClick={() => setPageMode("full", doc.id, !full)}
      />
      <IconButton
        icon={Star}
        label={doc.favorite ? "Lesezeichen entfernen" : "Lesezeichen setzen"}
        active={doc.favorite}
        className={doc.favorite ? "star-on" : ""}
        size="md"
        onClick={async () => {
          try {
            await api.setFavorite(doc.id, !doc.favorite);
            onChange({ favorite: !doc.favorite });
            s().refreshTree();
          } catch (e) {
            s().error("Lesezeichen konnte nicht gesetzt werden", e);
          }
        }}
      />
      <IconButton
        icon={MoreHorizontal}
        label="Weitere Aktionen"
        size="md"
        onClick={(e) =>
          openMenuAt(e, [
            { label: "Umbenennen", icon: PencilLine, onSelect: () => titleInput.current?.select() },
            { label: "Symbol ändern", icon: SmilePlus, onSelect: () => setIconOpen(true) },
            { label: "Rechts daneben öffnen", icon: Columns2, onSelect: () => s().splitTab(tab.id) },
            { label: "Link kopieren", icon: Link2, onSelect: () => navigator.clipboard.writeText(`[[${doc.title}]]`) },
            { label: "Präsentieren", icon: Presentation, shortcut: hint("present"), onSelect: () => void startPresentation(doc.id) },
            { label: "Drucken / als PDF", icon: Printer, onSelect: () => printActivePane() },
            { label: "Als HTML-Datei teilen…", icon: Share2, onSelect: () => sharePageAsHtml(doc.id, false) },
            ...(s().pages.get(doc.id)?.children.length
              ? [{ label: "Mit Unterseiten als HTML teilen…", icon: Share2, onSelect: () => sharePageAsHtml(doc.id, true) }]
              : []),
            { label: "Versionen…", icon: History, onSelect: () => setVersionsOpen(true) },
            { label: "Besprechung zusammenfassen", icon: NotebookPen, onSelect: onSummary },
            { label: "Unterseite anlegen", icon: CornerDownRight, onSelect: () => createSubpage(doc.id) },
            ...(viewType === null
              ? []
              : [
                  viewType !== "tabelle" ? { label: "Als Tabelle anzeigen", icon: Table2, onSelect: () => onViewType("tabelle") } : null,
                  viewType !== "board" ? { label: "Als Board anzeigen", icon: KanbanSquare, onSelect: () => onViewType("board") } : null,
                  viewType !== "liste" ? { label: "Als Liste anzeigen", icon: List, onSelect: () => onViewType("liste") } : null,
                ].filter((x) => x !== null)),
            "separator",
            { label: "Seite löschen", icon: Trash2, danger: true, onSelect: () => deletePage(doc) },
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
              {source && <div className="vh-mode">Markdown-Quelltext</div>}
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
              <button type="button" className="page-icon-btn" aria-label="Symbol ändern" onClick={() => setIconOpen((v) => !v)}>
                <PageIcon name={doc.icon} size={26} />
              </button>
              <textarea
                ref={titleInput}
                className="page-title"
                rows={1}
                value={title}
                spellCheck={false}
                aria-label="Seitentitel"
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, " "))}
                onBlur={commitTitle}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.target as HTMLTextAreaElement).blur();
                    root.current?.querySelector<HTMLElement>(".ProseMirror")?.focus();
                  }
                  if (e.key === "Escape") setTitle(doc.title);
                }}
              />
            </div>
            {daily && <div className="page-subtitle">{dateLong(daily.toISOString())}</div>}
            {iconOpen && (
              <div className="icon-picker" role="listbox" aria-label="Symbol wählen">
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
                        s().error("Symbol konnte nicht geändert werden", e);
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
  const { body } = splitFrontmatter(doc.content);
  // Inline #tags are already clickable in the text; only show the others (frontmatter tags).
  const lower = body.toLowerCase();
  // A `tags:` property shows its own chips below: do not repeat them here.
  const hasTagsProp = parseFrontmatter(fm).some((p) => /^tags?$/i.test(p.key));
  const extraTags = hasTagsProp ? [] : doc.tags.filter((t) => !lower.includes(`#${t.toLowerCase()}`));
  return (
    <div className="props">
      <span className="prop faint">Bearbeitet {relative(doc.updated_at)}</span>
      {extraTags.map((t) => (
        <button key={t} type="button" className="tag-chip" onClick={() => useApp.getState().openTab({ kind: "tag", tag: t }, { newTab: true })}>
          <Hash size={11} />
          {t}
        </button>
      ))}
      {!typed && !parseFrontmatter(fm).some((p) => (p.key || p.value.trim()) && !isManagedKey(p.key)) && (
        <button type="button" className="prop-add" onClick={onAdd} title={`Eigenschaft hinzufügen (${keys("Mod ;")})`}>
          <Plus size={13} /> Eigenschaft hinzufügen
        </button>
      )}
    </div>
  );
}

function Backlinks({ doc }: { doc: PageDoc }) {
  if (!doc.backlinks.length) return null;
  return (
    <section className="backlinks" aria-label="Rückverweise">
      <h2>
        <Link2 size={14} /> Verlinkt von {doc.backlinks.length} {doc.backlinks.length === 1 ? "Seite" : "Seiten"}
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
    .finally(() => setTimeout(() => window.print(), 50));
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

export async function createSubpage(parentId: number | null, title = "Unbenannt") {
  const s = useApp.getState();
  try {
    const parent = parentId ?? (await newPageParent());
    const icon = s.settings?.settings.editor?.default_icon ?? "file-text";
    const p = await api.createPage(title, parent, icon);
    await s.refreshTree();
    s.openPage(p.id);
    setTimeout(() => document.querySelector<HTMLTextAreaElement>(".pane.active .page-title")?.select(), 120);
  } catch (e) {
    s.error("Seite konnte nicht angelegt werden", e);
  }
}

export async function deletePage(page: { id: number; title: string }) {
  const s = useApp.getState();
  const kids = s.pages.get(page.id)?.children.length ?? 0;
  const days = s.settings?.settings.notes?.trash_retention_days ?? 30;
  const message = kids
    ? `„${page.title}“ und ${kids} ${kids === 1 ? "Unterseite" : "Unterseiten"} werden in den Papierkorb verschoben. Nach ${days} Tagen werden sie endgültig gelöscht.`
    : `„${page.title}“ wird in den Papierkorb verschoben. Nach ${days} Tagen wird die Seite endgültig gelöscht.`;
  // A single page just moves to the trash (undo in the toast); only subtrees ask first.
  if (kids && !(await s.confirm({ title: "Seite löschen?", message, confirmLabel: "Löschen", danger: true }))) return;
  try {
    await api.deletePage(page.id);
    await s.refreshTree();
    s.toast({ tone: "info", title: "Seite gelöscht", detail: `„${page.title}“ liegt im Papierkorb`, action: { label: "Rückgängig", run: () => restorePage(page.id, page.title) } });
  } catch (e) {
    s.error("Seite konnte nicht gelöscht werden", e);
  }
}

export function NewPageButton() {
  return <Button icon={FileText} onClick={() => createSubpage(null)}>Neue Seite</Button>;
}
