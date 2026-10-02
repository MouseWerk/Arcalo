// Right panel: assistant, outline and links of the active page.

import { lazy, Suspense, useEffect, useState } from "react";
import { FileText, Image as ImageIcon, ListTree, Link2, Network, Paperclip, PenTool, Sparkles } from "lucide-react";
import { useApp, type PanelTab } from "../store/app";
import { EmptyState } from "../components/ui";
import { PageIcon } from "../components/icons";
import { AssistantPanel } from "./AssistantPanel";
import { UnlinkedMentions } from "./Mentions";
import { api } from "../lib/api";
import { linkContext } from "../components/linkContext";
import { outgoingLinks, titleSet } from "../lib/links";
import { baseName, fileExtension, isImageName, isPdfName } from "../editor/fileEmbed";
import { openFile, openPdfViewer } from "../editor/files";
import { t as tr, useT } from "../lib/i18n";

// The local graph brings the canvas and the layout along: loaded with its tab.
const LocalGraph = lazy(() => import("./LocalGraph").then((m) => ({ default: m.LocalGraph })));

export function RightPanel() {
  useT();
  const tab = useApp((s) => s.panelTab);
  const s = useApp.getState;
  const tabs: { id: PanelTab; label: string; icon: typeof Sparkles }[] = [
    { id: "assistant", label: tr("panel.assistant"), icon: Sparkles },
    { id: "outline", label: tr("panel.outline"), icon: ListTree },
    { id: "links", label: tr("panel.links"), icon: Link2 },
    { id: "graph", label: tr("panel.graph"), icon: Network },
  ];
  return (
    <aside className="panel" aria-label={tr("panel.label")}>
      <div className="panel-tabs" role="tablist" data-tauri-drag-region>
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`panel-tab ${tab === t.id ? "active" : ""}`} title={t.label} onClick={() => s().set({ panelTab: t.id })}>
            <t.icon size={14} strokeWidth={1.75} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="panel-body">
        <div hidden={tab !== "assistant"} className="panel-fill">
          <AssistantPanel />
        </div>
        {tab === "outline" && <OutlinePanel />}
        {tab === "links" && <LinksPanel />}
        {tab === "graph" && (
          <Suspense fallback={<div className="view-loading" aria-busy="true" />}>
            <LocalGraph />
          </Suspense>
        )}
      </div>
    </aside>
  );
}

function OutlinePanel() {
  useT();
  const outline = useApp((s) => s.outline);
  const doc = useApp((s) => s.activeDoc);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const scroll = useApp((s) => s.scrollToPos);
  const reading = useReadingHeading(outline.length, doc?.id);
  if (tab?.kind !== "page" || !doc) return <EmptyState icon={ListTree} title={tr("panel.noPage")} />;
  if (!outline.length) return <EmptyState icon={ListTree} title={tr("panel.noHeadings")}>{tr("panel.noHeadingsText")}</EmptyState>;
  const min = Math.min(...outline.map((o) => o.level));
  return (
    <div className="outline-panel">
      <h3 className="panel-head">
        {tr("panel.outline")} <span className="faint">{outline.length}</span>
      </h3>
      <nav className="outline" aria-label={tr("panel.outline")}>
        {outline.map((o, i) => (
          <button
            key={i}
            type="button"
            className={`outline-item ${o.level === min ? "top" : ""} ${i === reading ? "active" : ""}`}
            style={{ paddingLeft: 10 + (o.level - min) * 12 }}
            aria-current={i === reading ? "location" : undefined}
            onClick={() => scroll?.(o.pos)}
          >
            {o.text || <span className="faint">{tr("common.untitled")}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

/** Index of the heading the reader is in (the last one above the upper third of the active page), or -1. */
function useReadingHeading(count: number, pageId: number | undefined) {
  const [reading, setReading] = useState(-1);
  useEffect(() => {
    const sc = document.querySelector<HTMLElement>(".pane.active .page-scroll");
    if (!sc || !count) return;
    const update = () => {
      const line = sc.getBoundingClientRect().top + sc.clientHeight / 3;
      const hs = [...sc.querySelectorAll<HTMLElement>(".ProseMirror :is(h1, h2, h3, h4, h5, h6)")];
      let i = -1;
      for (const [k, h] of hs.entries()) if (h.getBoundingClientRect().top <= line) i = k;
      setReading(i);
    };
    update();
    sc.addEventListener("scroll", update, { passive: true });
    return () => sc.removeEventListener("scroll", update);
  }, [count, pageId]);
  return reading;
}

function LinksPanel() {
  useT();
  const doc = useApp((s) => s.activeDoc);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const pages = useApp((s) => s.pages);
  if (tab?.kind !== "page" || !doc) return <EmptyState icon={Link2} title={tr("panel.noPage")} />;
  const titles = titleSet(pages);
  const { pages: unique, files } = outgoingLinks(doc.content, (t) => titles.has(t.toLowerCase()));
  const find = (t: string) => [...pages.values()].find((p) => p.title.toLowerCase() === t.toLowerCase());
  const s = useApp.getState;
  return (
    <div className="links-panel">
      <h3>{tr("panel.backlinks")} <span className="faint">{doc.backlinks.length}</span></h3>
      {doc.backlinks.length === 0 && <p className="faint small">{tr("panel.noBacklinks")}</p>}
      {doc.backlinks.map((b) => (
        <button key={b.page_id} type="button" className="link-row" onClick={() => s().openPage(b.page_id)}>
          <PageIcon name={b.icon} size={14} />
          <span className="link-row-text">
            <span>{b.title}</span>
            {b.context && <span className="faint small backlink-context">{linkContext(b.context, doc.title)}</span>}
          </span>
        </button>
      ))}
      <UnlinkedMentions pageId={doc.id} title={doc.title} />
      <h3>{tr("panel.outgoing")} <span className="faint">{unique.length}</span></h3>
      {unique.length === 0 && <p className="faint small">{tr("panel.noOutgoing")}</p>}
      {unique.map((t) => {
        const p = find(t);
        return (
          <button
            key={t}
            type="button"
            className={`link-row ${p ? "" : "unresolved"}`}
            onClick={async () => {
              const page = p ?? (await api.resolvePage(t, true));
              if (!page) return;
              if (!p) await s().refreshTree();
              s().openPage(page.id);
            }}
          >
            <PageIcon name={p?.icon} size={14} />
            <span className="link-row-text">
              <span>{t}</span>
              {!p && <span className="faint small">{tr("panel.notCreated")}</span>}
            </span>
          </button>
        );
      })}
      {files.length > 0 && (
        <>
          <h3>{tr("share.attachments")} <span className="faint">{files.length}</span></h3>
          {files.map((f) => {
            const Icon = isImageName(f) ? ImageIcon : fileExtension(f) === "excalidraw" ? PenTool : isPdfName(f) ? FileText : Paperclip;
            return (
              <button key={f} type="button" className="link-row" onClick={() => (isPdfName(f) ? openPdfViewer(f) : openFile(f))}>
                <Icon size={14} strokeWidth={1.75} />
                <span className="link-row-text">
                  <span>{baseName(f)}</span>
                </span>
              </button>
            );
          })}
        </>
      )}
      {doc.tags.length > 0 && (
        <>
          <h3>{tr("panel.tags")}</h3>
          <div className="tag-list">
            {doc.tags.map((t) => (
              <button key={t} type="button" className="tag-chip" onClick={() => s().openTab({ kind: "tag", tag: t })}>
                #{t}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
