// Right panel: assistant, outline and links of the active page.

import { useEffect, useState } from "react";
import { FileText, Image as ImageIcon, ListTree, Link2, Paperclip, PenTool, Sparkles } from "lucide-react";
import { useApp, type PanelTab } from "../store/app";
import { EmptyState } from "../components/ui";
import { PageIcon } from "../components/icons";
import { AssistantPanel } from "./AssistantPanel";
import { api } from "../lib/api";
import { linkContext } from "../components/linkContext";
import { outgoingLinks } from "../lib/links";
import { baseName, fileExtension, isImageName, isPdfName } from "../editor/fileEmbed";
import { openFile, openPdfViewer } from "../editor/files";

export function RightPanel() {
  const tab = useApp((s) => s.panelTab);
  const s = useApp.getState;
  const tabs: { id: PanelTab; label: string; icon: typeof Sparkles }[] = [
    { id: "assistant", label: "Assistent", icon: Sparkles },
    { id: "outline", label: "Gliederung", icon: ListTree },
    { id: "links", label: "Verknüpfungen", icon: Link2 },
  ];
  return (
    <aside className="panel" aria-label="Seitenpanel">
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
      </div>
    </aside>
  );
}

function OutlinePanel() {
  const outline = useApp((s) => s.outline);
  const doc = useApp((s) => s.activeDoc);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const scroll = useApp((s) => s.scrollToPos);
  const reading = useReadingHeading(outline.length, doc?.id);
  if (tab?.kind !== "page" || !doc) return <EmptyState icon={ListTree} title="Keine Seite geöffnet" />;
  if (!outline.length) return <EmptyState icon={ListTree} title="Keine Überschriften">Überschriften der Seite erscheinen hier.</EmptyState>;
  const min = Math.min(...outline.map((o) => o.level));
  return (
    <div className="outline-panel">
      <h3 className="panel-head">
        Gliederung <span className="faint">{outline.length}</span>
      </h3>
      <nav className="outline" aria-label="Gliederung">
        {outline.map((o, i) => (
          <button
            key={i}
            type="button"
            className={`outline-item ${o.level === min ? "top" : ""} ${i === reading ? "active" : ""}`}
            style={{ paddingLeft: 10 + (o.level - min) * 12 }}
            aria-current={i === reading ? "location" : undefined}
            onClick={() => scroll?.(o.pos)}
          >
            {o.text || <span className="faint">Ohne Titel</span>}
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
  const doc = useApp((s) => s.activeDoc);
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const pages = useApp((s) => s.pages);
  if (tab?.kind !== "page" || !doc) return <EmptyState icon={Link2} title="Keine Seite geöffnet" />;
  const { pages: unique, files } = outgoingLinks(doc.content);
  const find = (t: string) => [...pages.values()].find((p) => p.title.toLowerCase() === t.toLowerCase());
  const s = useApp.getState;
  return (
    <div className="links-panel">
      <h3>Rückverweise <span className="faint">{doc.backlinks.length}</span></h3>
      {doc.backlinks.length === 0 && <p className="faint small">Keine Seite verlinkt hierher.</p>}
      {doc.backlinks.map((b) => (
        <button key={b.page_id} type="button" className="link-row" onClick={() => s().openPage(b.page_id)}>
          <PageIcon name={b.icon} size={14} />
          <span className="link-row-text">
            <span>{b.title}</span>
            {b.context && <span className="faint small backlink-context">{linkContext(b.context, doc.title)}</span>}
          </span>
        </button>
      ))}
      <h3>Ausgehende Links <span className="faint">{unique.length}</span></h3>
      {unique.length === 0 && <p className="faint small">Diese Seite verlinkt keine anderen.</p>}
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
              {!p && <span className="faint small">Noch nicht angelegt</span>}
            </span>
          </button>
        );
      })}
      {files.length > 0 && (
        <>
          <h3>Anhänge <span className="faint">{files.length}</span></h3>
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
          <h3>Tags</h3>
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
