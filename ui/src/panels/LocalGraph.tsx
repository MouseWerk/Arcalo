// Local graph in the side panel: the active page and its neighbors up to 1–3 links away, with
// the interactions of the graph view; it follows the active page and keeps the positions of
// the nodes both pages share, so switching pages moves the graph instead of redrawing it.

import { useMemo, useRef, useState } from "react";
import { Maximize2, Network, Waypoints } from "lucide-react";
import { useApp } from "../store/app";
import { t, useT } from "../lib/i18n";
import { EmptyState, IconButton, Segmented, Spinner } from "../components/ui";
import { GraphCanvas, type GraphCanvasHandle } from "../components/graph/GraphCanvas";
import { openGraphNode, useGraphData, useGraphSettings } from "../components/graph/source";
import { buildModel, defaultDisplay, defaultFilter, folderPalette, nodeColors, pageKey } from "../lib/graph";

const FILTER = defaultFilter();
const DEPTH_KEY = "annalo.localGraphDepth";

function storedDepth(): 1 | 2 | 3 {
  try {
    const d = Number(localStorage.getItem(DEPTH_KEY));
    return d === 2 || d === 3 ? d : 1;
  } catch {
    return 1;
  }
}

export function LocalGraph() {
  useT();
  const doc = useApp((s) => s.activeDoc);
  const tab = useApp((s) => s.tabs.find((x) => x.id === s.activeTabId));
  const [depth, setDepth] = useState<1 | 2 | 3>(storedDepth);
  const { data } = useGraphData(FILTER);
  const canvas = useRef<GraphCanvasHandle>(null);
  const pageId = tab?.kind === "page" ? (tab.pageId ?? doc?.id ?? null) : null;
  const focus = pageId != null ? pageKey(pageId) : null;
  const display = useMemo(() => ({ ...defaultDisplay(), linkDistance: 0.35, repel: 0.6 }), []);
  const model = useMemo(
    () => (data && focus && data.nodes.some((n) => n.id === pageId) ? buildModel(data, { orphans: true, unresolved: true, tagNodes: false, depth }, focus) : null),
    [data, focus, depth, pageId],
  );
  // The color groups and folder colors of the graph view, so a page has the same color in both.
  const view = useGraphSettings();
  const folderColors = view?.display.folderColors ?? true;
  const palette = useMemo(() => (data && folderColors ? folderPalette(data.nodes) : null), [data, folderColors]);
  const groups = view?.groups;
  const colors = useMemo(() => (model ? nodeColors(model.nodes, groups ?? [], palette) : []), [model, groups, palette]);

  if (pageId == null) return <EmptyState icon={Network} title={t("panel.noPage")}>{t("panel.noPageHint")}</EmptyState>;
  if (!data)
    return (
      <div className="graph-loading">
        <Spinner />
      </div>
    );
  return (
    <div className="local-graph">
      <div className="local-graph-head">
        <span className="local-graph-depth">
          <span className="graph-label">{t("graph.depth")}</span>
          <Segmented
            label={t("graph.depth")}
            value={String(depth) as "1" | "2" | "3"}
            options={(["1", "2", "3"] as const).map((d) => ({ value: d, label: d }))}
            onChange={(v) => {
              const d = Number(v) as 1 | 2 | 3;
              setDepth(d);
              try {
                localStorage.setItem(DEPTH_KEY, String(d));
              } catch {
                // Not stored: the default comes back next time.
              }
            }}
          />
        </span>
        <span className="local-graph-actions">
          <IconButton icon={Maximize2} size="sm" label={t("graph.fit")} onClick={() => canvas.current?.fit()} />
          <IconButton icon={Waypoints} size="sm" label={t("graph.openFull")} onClick={() => useApp.getState().openTab({ kind: "graph" })} />
        </span>
      </div>
      {!model ? (
        <EmptyState icon={Network} title={t("graph.notInGraph")}>{t("graph.notInGraphHint")}</EmptyState>
      ) : (
        <div className="local-graph-stage">
          <GraphCanvas
            ref={canvas}
            model={model}
            colors={colors}
            display={display}
            current={model.index.get(focus!) ?? null}
            compact
            onOpen={(n, newTab) => void openGraphNode(n, newTab)}
            label={t("graph.localLabel", { title: doc?.title ?? "", n: model.nodes.length - 1 })}
          />
        </div>
      )}
    </div>
  );
}
