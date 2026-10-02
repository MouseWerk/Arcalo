// Graph view (1.9): every page as a node, links and embeds as edges. Filters (tag, folder,
// Netzplan, Jira project, date range in SQL; orphans, unresolved links, daily notes, tag and
// file nodes, depth from a node in the view), color groups, display and forces, presets per
// workspace, search, „Als Liste anzeigen“ and PNG export.

import { useEffect, useMemo, useRef, useState } from "react";
import { Bookmark, Filter, ImageDown, List, Maximize2, Minus, Plus, Search, Trash2, Waypoints, X } from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import { t, useT } from "../lib/i18n";
import { int } from "../lib/format";
import { Button, EmptyState, IconButton, Input, Select, Spinner, Switch, useMenu } from "../components/ui";
import { DateInput } from "../components/DateInput";
import { GraphCanvas, type GraphCanvasHandle } from "../components/graph/GraphCanvas";
import { loadLayout, openGraphNode, saveLayout, useGraphData } from "../components/graph/source";
import {
  activeFilterCount,
  buildModel,
  defaultFilter,
  defaultSettings,
  folderPalette,
  GROUP_COLORS,
  listRows,
  nodeColors,
  normalizePresets,
  normalizeSettings,
  searchNodes,
  type GraphDisplay,
  type GraphFilter,
  type GraphOptions,
  type FolderPalette,
  type GraphPreset,
  type GraphSettings,
  type GroupColor,
  type GroupKind,
  type GroupRule,
  } from "../lib/graph";
import type { PageNode } from "../lib/types";

/** Settings of the last session (kept for reopening within the session). */
let lastSettings: GraphSettings | null = null;
let settingsTimer = 0;

function storeSettings(s: GraphSettings) {
  lastSettings = s;
  window.clearTimeout(settingsTimer);
  settingsTimer = window.setTimeout(() => void api.graphStateSet("view", s).catch(() => {}), 600);
}

const GRAPH_EXPORT_EVENT = "annalo:graph-export";

export function GraphView() {
  useT();
  const [settings, setSettings] = useState<GraphSettings | null>(lastSettings);
  const [presets, setPresets] = useState<GraphPreset[]>([]);
  const [seed, setSeed] = useState<Map<string, [number, number]> | null>(null);
  const [panel, setPanel] = useState(false);
  const [asList, setAsList] = useState(false);
  const [query, setQuery] = useState("");
  const [hitIdx, setHitIdx] = useState(0);
  const [anchor, setAnchor] = useState<string | null>(null);
  const canvas = useRef<GraphCanvasHandle>(null);
  const tree = useApp((s) => s.tree);

  useEffect(() => {
    let off = false;
    if (!lastSettings)
      void api
        .graphStateGet("view")
        .then((raw) => !off && setSettings((lastSettings = normalizeSettings(raw))))
        .catch(() => !off && setSettings((lastSettings = defaultSettings())));
    void api.graphStateGet("presets").then((raw) => !off && setPresets(normalizePresets(raw)), () => {});
    void loadLayout().then((m) => !off && setSeed(m));
    return () => {
      off = true;
    };
  }, []);

  const update = (patch: Partial<GraphSettings>) => {
    setSettings((s) => {
      const next = { ...(s ?? defaultSettings()), ...patch };
      storeSettings(next);
      return next;
    });
  };
  const setFilter = (p: Partial<GraphFilter>) => settings && update({ filter: { ...settings.filter, ...p } });
  const setOptions = (p: Partial<GraphOptions>) => settings && update({ options: { ...settings.options, ...p } });
  const setDisplay = (p: Partial<GraphDisplay>) => settings && update({ display: { ...settings.display, ...p } });

  const { data, error } = useGraphData(settings && seed ? settings.filter : null);
  // Choices for the filters come from the whole workspace.
  const { data: all } = useGraphData(settings && seed ? defaultFilter() : null);

  const model = useMemo(() => (data && settings ? buildModel(data, settings.options, settings.options.depth ? anchor : null) : null), [data, settings?.options, anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  const palette = useMemo(() => (settings?.display.folderColors && all ? folderPalette(all.nodes) : null), [all, settings?.display.folderColors]);
  const colors = useMemo(() => (model && settings ? nodeColors(model.nodes, settings.groups, palette) : []), [model, settings?.groups, palette]); // eslint-disable-line react-hooks/exhaustive-deps
  const hits = useMemo(() => (model ? searchNodes(model.nodes, query) : []), [model, query]);
  const hitSet = useMemo(() => (query.trim() ? new Set(hits) : null), [hits, query]);

  // Tests and scripts: export to a given path.
  useEffect(() => {
    const on = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (path) void exportPng(path);
    };
    window.addEventListener(GRAPH_EXPORT_EVENT, on);
    return () => window.removeEventListener(GRAPH_EXPORT_EVENT, on);
  });

  const exportPng = async (given?: string) => {
    const s = useApp.getState();
    try {
      const chosen = given ?? (await saveDialog({ defaultPath: "Graph.png", filters: [{ name: "PNG", extensions: ["png"] }] }));
      if (!chosen || !canvas.current) return;
      const file = chosen.toLowerCase().endsWith(".png") ? chosen : `${chosen}.png`;
      await api.writeDiagramFile(file, await canvas.current.exportPng(2));
      s.toast({ tone: "success", title: t("graph.exported"), detail: file });
    } catch (e) {
      s.error(t("graph.exportFailed"), e);
    }
  };

  const focusHit = (back = false) => {
    if (!model || !hits.length) return;
    const i = (hitIdx + (back ? hits.length - 1 : 0)) % hits.length;
    const idx = hits[i];
    setHitIdx(i + 1);
    setAnchor(model.nodes[idx].key);
    if (asList) setAsList(false);
    // The canvas may only now be shown.
    requestAnimationFrame(() => canvas.current?.focusNode(idx));
  };

  if (!settings || !seed) return <div className="view-loading" aria-busy="true" />;
  const f = settings.filter;
  const o = settings.options;
  const filters = activeFilterCount(f, o);
  const pages = model?.nodes.filter((n) => n.kind === "page").length ?? 0;
  const links = model ? model.edges.length / 2 : 0;
  const anchorNode = anchor && model ? model.nodes[model.index.get(anchor) ?? -1] : null;

  return (
    <div className="graph-view">
      <div className="graph-toolbar" role="toolbar" aria-label={t("graph.title")}>
        <div className="graph-title">
          <Waypoints size={16} strokeWidth={1.75} aria-hidden />
          <h1>{t("graph.title")}</h1>
          {model && <span className="graph-stats">{t("graph.stats", { pages: int(pages), links: int(links) })}</span>}
        </div>
        <div className="graph-search">
          <Search size={14} aria-hidden />
          <input
            className="graph-search-input"
            value={query}
            placeholder={t("graph.search")}
            aria-label={t("graph.search")}
            onChange={(e) => {
              setQuery(e.target.value);
              setHitIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                focusHit(e.shiftKey);
              } else if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query.trim() && <span className="graph-search-count">{t("graph.hits", { n: hits.length })}</span>}
        </div>
        <div className="graph-actions">
          <IconButton icon={Minus} label={t("graph.zoomOut")} onClick={() => canvas.current?.zoomBy(0.8)} disabled={asList} />
          <IconButton icon={Plus} label={t("graph.zoomIn")} onClick={() => canvas.current?.zoomBy(1.25)} disabled={asList} />
          <IconButton icon={Maximize2} label={t("graph.fit")} className="graph-fit" onClick={() => canvas.current?.fit()} disabled={asList} />
          <IconButton icon={ImageDown} label={t("graph.exportPng")} className="graph-export" onClick={() => void exportPng()} disabled={asList || !model} />
          <span className="graph-sep" />
          <Button variant={asList ? "primary" : "ghost"} size="sm" icon={List} className="graph-list-toggle" aria-label={t("graph.asList")} aria-pressed={asList} onClick={() => setAsList(!asList)}>
            <span className="graph-btn-label">{t("graph.asList")}</span>
          </Button>
          <Button variant={panel ? "secondary" : "ghost"} size="sm" icon={Filter} className="graph-panel-toggle" aria-label={t("graph.settings")} aria-expanded={panel} aria-controls="graph-panel" onClick={() => setPanel(!panel)}>
            <span className="graph-btn-label">{t("graph.settings")}</span>
            {filters > 0 && <span className="graph-badge">{filters}</span>}
          </Button>
        </div>
      </div>
      <div className="graph-body">
        <div className="graph-stage">
          {error != null && !data ? (
            <EmptyState icon={Waypoints} title={t("graph.failed")} />
          ) : !model ? (
            <div className="graph-loading">
              <Spinner />
              <span>{t("graph.loading")}</span>
            </div>
          ) : model.nodes.length === 0 ? (
            <EmptyState icon={Waypoints} title={t("graph.empty")}>
              {filters > 0 ? t("graph.emptyFiltered") : t("graph.emptyText")}
            </EmptyState>
          ) : asList ? (
            <GraphList model={model} />
          ) : (
            <>
              <GraphCanvas
                ref={canvas}
                model={model}
                colors={colors}
                display={settings.display}
                highlight={hitSet}
                seed={seed}
                onSettled={saveLayout}
                onOpen={(n, newTab) => void openGraphNode(n, newTab)}
                label={t("graph.canvasLabel", { pages: int(pages), links: int(links) })}
              />
              <Legend groups={settings.groups} palette={palette} />
              <p id="graph-keys-help" className="sr-only">
                {t("graph.keysHelp")}
              </p>
            </>
          )}
        </div>
        {panel && (
          <aside id="graph-panel" className="graph-panel" aria-label={t("graph.settings")}>
            <div className="graph-panel-head">
              <h2>{t("graph.settings")}</h2>
              <IconButton icon={X} label={t("common.close")} size="sm" onClick={() => setPanel(false)} />
            </div>
            <div className="graph-panel-body">
              <PanelSection title={t("graph.filters")} badge={filters || undefined}>
                <FilterControls filter={f} options={o} setFilter={setFilter} setOptions={setOptions} all={all} tree={tree} anchorLabel={anchorNode?.label ?? null} onClearAnchor={() => setAnchor(null)} />
                {filters > 0 && (
                  <Button variant="ghost" size="sm" className="graph-reset" onClick={() => update({ filter: { ...defaultFilter(), attachments: f.attachments }, options: { ...o, orphans: true, depth: 0 } })}>
                    {t("graph.resetFilters")}
                  </Button>
                )}
              </PanelSection>
              <PanelSection title={t("graph.groups")}>
                <GroupControls groups={settings.groups} onChange={(groups) => update({ groups })} />
                <label className="graph-row">
                  <span>{t("graph.folderColors")}</span>
                  <Switch label={t("graph.folderColors")} checked={settings.display.folderColors} onChange={(v) => setDisplay({ folderColors: v })} />
                </label>
              </PanelSection>
              <PanelSection title={t("graph.display")}>
                <label className="graph-row">
                  <span>{t("graph.sizeByLinks")}</span>
                  <Switch label={t("graph.sizeByLinks")} checked={settings.display.sizeByLinks} onChange={(v) => setDisplay({ sizeByLinks: v })} />
                </label>
                <Slider label={t("graph.nodeSize")} value={settings.display.nodeSize} min={0.5} max={2} step={0.05} onChange={(v) => setDisplay({ nodeSize: v })} />
                <Slider label={t("graph.linkWidth")} value={settings.display.linkWidth} min={0.25} max={3} step={0.05} onChange={(v) => setDisplay({ linkWidth: v })} />
                <label className="graph-row">
                  <span>{t("graph.animate")}</span>
                  <Switch label={t("graph.animate")} checked={settings.display.animate} onChange={(v) => setDisplay({ animate: v })} />
                </label>
              </PanelSection>
              <PanelSection title={t("graph.forces")}>
                <Slider label={t("graph.center")} value={settings.display.center} min={0} max={1} step={0.01} onChange={(v) => setDisplay({ center: v })} />
                <Slider label={t("graph.repel")} value={settings.display.repel} min={0} max={1} step={0.01} onChange={(v) => setDisplay({ repel: v })} />
                <Slider label={t("graph.linkDistance")} value={settings.display.linkDistance} min={0} max={1} step={0.01} onChange={(v) => setDisplay({ linkDistance: v })} />
              </PanelSection>
              <PanelSection title={t("graph.presets")}>
                <Presets
                  presets={presets}
                  onApply={(p) => update({ filter: p.filter, options: p.options, groups: p.groups })}
                  onChange={(list) => {
                    setPresets(list);
                    void api.graphStateSet("presets", list).catch((e) => useApp.getState().error(t("graph.presetFailed"), e));
                  }}
                  current={settings}
                />
              </PanelSection>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function PanelSection({ title, badge, children }: { title: string; badge?: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="graph-section">
      <button type="button" className="graph-section-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{title}</span>
        {badge != null && <span className="graph-badge">{badge}</span>}
      </button>
      {open && <div className="graph-section-body">{children}</div>}
    </section>
  );
}

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  const fill = ((value - min) / (max - min)) * 100;
  return (
    <label className="graph-slider">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        style={{ "--fill": `${fill}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}

/** Folders of the tree with their path, for the folder filter. */
function folderOptions(tree: PageNode[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const walk = (list: PageNode[], path: string) => {
    for (const p of list) {
      if (!p.children.length) continue;
      const here = path ? `${path}/${p.title}` : p.title;
      out.push({ value: String(p.id), label: here });
      walk(p.children, here);
    }
  };
  walk(tree, "");
  return out;
}

function FilterControls({
  filter: f,
  options: o,
  setFilter,
  setOptions,
  all,
  tree,
  anchorLabel,
  onClearAnchor,
}: {
  filter: GraphFilter;
  options: GraphOptions;
  setFilter: (p: Partial<GraphFilter>) => void;
  setOptions: (p: Partial<GraphOptions>) => void;
  all: ReturnType<typeof useGraphData>["data"];
  tree: PageNode[];
  anchorLabel: string | null;
  onClearAnchor: () => void;
}) {
  const choices = useMemo(() => {
    const tags = new Map<string, number>();
    const nps = new Set<string>();
    const jira = new Set<string>();
    for (const n of all?.nodes ?? []) {
      n.tags.forEach((x) => tags.set(x, (tags.get(x) ?? 0) + 1));
      n.netzplan.forEach((x) => nps.add(x));
      if (n.jira?.includes("-")) jira.add(n.jira.split("-")[0]);
    }
    return {
      tags: [...tags.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
      netzplan: [...nps].sort(),
      jira: [...jira].sort(),
    };
  }, [all]);
  const folders = useMemo(() => folderOptions(tree), [tree]);
  const none = { value: "", label: t("graph.any") };
  const addTag = (tag: string) => tag && !f.tags.includes(tag) && setFilter({ tags: [...f.tags, tag] });
  return (
    <div className="graph-filters">
      <div className="graph-field">
        <span className="graph-label">{t("graph.tags")}</span>
        {f.tags.length > 0 && (
          <div className="graph-chips">
            {f.tags.map((tag) => (
              <button key={tag} type="button" className="graph-chip" aria-label={t("graph.removeTag", { tag })} onClick={() => setFilter({ tags: f.tags.filter((x) => x !== tag) })}>
                #{tag}
                <X size={12} aria-hidden />
              </button>
            ))}
          </div>
        )}
        <Select
          className="graph-tag-select"
          aria-label={t("graph.addTag")}
          value=""
          placeholder={t("graph.addTag")}
          options={[{ value: "", label: t("graph.addTag") }, ...choices.tags.filter(([x]) => !f.tags.includes(x)).map(([x, n]) => ({ value: x, label: `#${x}`, description: String(n) }))]}
          onChange={(e) => addTag(e.target.value)}
        />
      </div>
      <div className="graph-field">
        <span className="graph-label">{t("graph.folder")}</span>
        <Select className="graph-folder-select" aria-label={t("graph.folder")} value={f.folder != null ? String(f.folder) : ""} options={[none, ...folders]} onChange={(e) => setFilter({ folder: e.target.value ? Number(e.target.value) : null })} />
      </div>
      {choices.netzplan.length > 0 && (
        <div className="graph-field">
          <span className="graph-label">{t("graph.netzplan")}</span>
          <Select aria-label={t("graph.netzplan")} value={f.netzplan ?? ""} options={[none, ...choices.netzplan.map((x) => ({ value: x, label: x }))]} onChange={(e) => setFilter({ netzplan: e.target.value || null })} />
        </div>
      )}
      {choices.jira.length > 0 && (
        <div className="graph-field">
          <span className="graph-label">{t("graph.jira")}</span>
          <Select aria-label={t("graph.jira")} value={f.jira_project ?? ""} options={[none, ...choices.jira.map((x) => ({ value: x, label: x }))]} onChange={(e) => setFilter({ jira_project: e.target.value || null })} />
        </div>
      )}
      <div className="graph-field">
        <span className="graph-label">{t("graph.dates")}</span>
        <Select
          aria-label={t("graph.dateField")}
          value={f.date_field}
          options={[
            { value: "modified", label: t("graph.modified") },
            { value: "created", label: t("graph.created") },
          ]}
          onChange={(e) => setFilter({ date_field: e.target.value === "created" ? "created" : "modified" })}
        />
        <div className="graph-dates">
          <DateInput aria-label={t("graph.from")} placeholder={t("graph.from")} value={f.from ?? ""} onChange={(v) => setFilter({ from: v || null })} />
          <span aria-hidden>–</span>
          <DateInput aria-label={t("graph.to")} placeholder={t("graph.to")} value={f.to ?? ""} onChange={(v) => setFilter({ to: v || null })} />
        </div>
      </div>
      <label className="graph-row">
        <span>{t("graph.orphans")}</span>
        <Switch label={t("graph.orphans")} checked={o.orphans} onChange={(v) => setOptions({ orphans: v })} />
      </label>
      <label className="graph-row">
        <span>{t("graph.unresolved")}</span>
        <Switch label={t("graph.unresolved")} checked={o.unresolved} onChange={(v) => setOptions({ unresolved: v })} />
      </label>
      <label className="graph-row">
        <span>{t("graph.daily")}</span>
        <Switch label={t("graph.daily")} checked={f.daily} onChange={(v) => setFilter({ daily: v })} />
      </label>
      <label className="graph-row">
        <span>{t("graph.tagNodes")}</span>
        <Switch label={t("graph.tagNodes")} checked={o.tagNodes} onChange={(v) => setOptions({ tagNodes: v })} />
      </label>
      <label className="graph-row">
        <span>{t("graph.attachments")}</span>
        <Switch label={t("graph.attachments")} checked={f.attachments} onChange={(v) => setFilter({ attachments: v })} />
      </label>
      <div className="graph-field">
        <span className="graph-label">{t("graph.depth")}</span>
        <Select
          aria-label={t("graph.depth")}
          value={String(o.depth)}
          options={[{ value: "0", label: t("graph.depthOff") }, ...[1, 2, 3, 4, 5].map((d) => ({ value: String(d), label: t("graph.depthN", { n: d }) }))]}
          onChange={(e) => setOptions({ depth: Number(e.target.value) })}
        />
        {o.depth > 0 &&
          (anchorLabel ? (
            <div className="graph-anchor">
              <span>{t("graph.anchor", { title: anchorLabel })}</span>
              <IconButton icon={X} size="sm" label={t("graph.clearAnchor")} onClick={onClearAnchor} />
            </div>
          ) : (
            <p className="graph-hint">{t("graph.anchorHint")}</p>
          ))}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<GroupKind, () => string> = { tag: () => t("graph.groupTag"), folder: () => t("graph.groupFolder"), query: () => t("graph.groupQuery") };

function GroupControls({ groups, onChange }: { groups: GroupRule[]; onChange: (g: GroupRule[]) => void }) {
  const [menu, , openAt] = useMenu();
  const set = (i: number, p: Partial<GroupRule>) => onChange(groups.map((g, j) => (j === i ? { ...g, ...p } : g)));
  const nextColor = (): GroupColor => GROUP_COLORS.find((c) => !groups.some((g) => g.color === c)) ?? GROUP_COLORS[groups.length % GROUP_COLORS.length];
  return (
    <div className="graph-groups">
      {groups.map((g, i) => (
        <div key={g.id} className="graph-group">
          <button
            type="button"
            className="graph-swatch"
            style={{ background: `var(--${g.color})` }}
            aria-label={t("graph.groupColor")}
            onClick={(e) =>
              openAt(
                e,
                GROUP_COLORS.map((c, k) => ({ label: t("graph.colorN", { n: k + 1 }), checked: c === g.color, onSelect: () => set(i, { color: c }) })),
              )
            }
          />
          <Select
            className="graph-group-kind"
            aria-label={t("graph.groupKind")}
            value={g.kind}
            options={(["tag", "folder", "query"] as GroupKind[]).map((k) => ({ value: k, label: KIND_LABEL[k]() }))}
            onChange={(e) => set(i, { kind: e.target.value as GroupKind })}
          />
          <Input
            className="graph-group-value"
            aria-label={t("graph.groupValue")}
            value={g.value}
            placeholder={g.kind === "tag" ? t("graph.groupTagHint") : g.kind === "folder" ? t("graph.groupFolderHint") : t("graph.groupQueryHint")}
            onChange={(e) => set(i, { value: e.target.value })}
          />
          <IconButton icon={Trash2} size="sm" label={t("graph.removeGroup")} onClick={() => onChange(groups.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button variant="ghost" size="sm" icon={Plus} className="graph-add-group" onClick={() => onChange([...groups, { id: `g${Date.now().toString(36)}`, kind: "tag", value: "", color: nextColor() }])}>
        {t("graph.addGroup")}
      </Button>
      {menu}
    </div>
  );
}

function Presets({ presets, current, onApply, onChange }: { presets: GraphPreset[]; current: GraphSettings; onApply: (p: GraphPreset) => void; onChange: (p: GraphPreset[]) => void }) {
  const [name, setName] = useState("");
  const add = () => {
    const n = name.trim();
    if (!n) return;
    const rest = presets.filter((p) => p.name.toLowerCase() !== n.toLowerCase());
    onChange([...rest, { id: `p${Date.now().toString(36)}`, name: n, filter: current.filter, options: current.options, groups: current.groups }]);
    setName("");
  };
  return (
    <div className="graph-presets">
      {presets.length === 0 && <p className="graph-hint">{t("graph.noPresets")}</p>}
      {presets.map((p) => (
        <div key={p.id} className="graph-preset">
          <button type="button" className="graph-preset-apply" onClick={() => onApply(p)}>
            <Bookmark size={13} aria-hidden />
            <span>{p.name}</span>
          </button>
          <IconButton icon={Trash2} size="sm" label={t("graph.deletePreset", { name: p.name })} onClick={() => onChange(presets.filter((x) => x.id !== p.id))} />
        </div>
      ))}
      <form
        className="graph-preset-new"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input value={name} placeholder={t("graph.presetName")} aria-label={t("graph.presetName")} onChange={(e) => setName(e.target.value)} />
        <Button type="submit" size="sm" variant="secondary" disabled={!name.trim()}>
          {t("graph.savePreset")}
        </Button>
      </form>
    </div>
  );
}

/** The legend: color groups, then the default folder colors. */
function Legend({ groups, palette }: { groups: GroupRule[]; palette: FolderPalette | null }) {
  const items: { color: GroupColor; label: string }[] = [
    ...groups.filter((g) => g.value.trim()).map((g) => ({ color: g.color, label: g.kind === "tag" ? `#${g.value.replace(/^#/, "")}` : g.value })),
    ...[...(palette?.colors.entries() ?? [])].map(([folder, color]) => ({ color, label: folder.split("/").pop() ?? folder })),
  ];
  if (!items.length) return null;
  return (
    <ul className="graph-legend" aria-label={t("graph.legend")}>
      {items.slice(0, 10).map((it, i) => (
        <li key={i}>
          <span className="graph-dot" style={{ background: `var(--${it.color})` }} aria-hidden />
          <span>{it.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** „Als Liste anzeigen“: the pages of the filtered graph, most linked first. */
function GraphList({ model }: { model: NonNullable<ReturnType<typeof buildModel>> }) {
  const rows = useMemo(() => listRows(model), [model]);
  const [limit, setLimit] = useState(300);
  return (
    <div className="graph-list" role="region" aria-label={t("graph.listLabel", { n: rows.length })}>
      <table>
        <thead>
          <tr>
            <th>{t("graph.colTitle")}</th>
            <th>{t("graph.colFolder")}</th>
            <th className="num">{t("graph.colLinks")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((n) => (
            <tr key={n.key}>
              <td>
                <button type="button" className="graph-list-open" onClick={(e) => void openGraphNode(n, e.ctrlKey || e.metaKey)}>
                  {n.label}
                </button>
              </td>
              <td className="faint">{n.page?.folder}</td>
              <td className="num">{n.degree}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && (
        <Button variant="ghost" size="sm" onClick={() => setLimit(limit + 500)}>
          {t("graph.more", { n: rows.length - limit })}
        </Button>
      )}
    </div>
  );
}
