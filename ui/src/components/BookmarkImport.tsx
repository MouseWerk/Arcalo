// „Lesezeichen importieren“: browser bookmarks (or an HTML export) into the ribbon, in three
// steps: the source, a tree to choose from, and where everything goes (groups, ribbon links,
// pages) with a preview of the ribbon. The import can be undone from its toast.
// Entry points: „App / Link hinzufügen“, the ribbon's context menu, the palette and settings.

import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { create } from "zustand";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, ChevronRight, ChevronsDownUp, ChevronsUpDown, FileText, FileUp, FolderClosed, Link2, Lock, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import type { QuickLink } from "../lib/types";
import { Button, Dialog, Input, Segmented, Spinner } from "./ui";
import { PageIcon } from "./icons";
import { t as tr, useT, type TKey } from "../lib/i18n";
import { fmtDate } from "../lib/format";
import { filingApi } from "../lib/filing";
import { colorHex, isGroup, normalizeLinks } from "../lib/quicklinks";
import {
  MAX_GROUP,
  MAX_RIBBON,
  allLeaves,
  bookmarkIcon,
  bookmarksApi,
  checkState,
  indexTree,
  isBookmarksFile,
  pageMarkdown,
  planImport,
  toggleEntry,
  visibleFor,
  type BmLocation,
  type BmNode,
  type BmSource,
  type BmTree,
  type Dest,
  type Plan,
  type TreeIndex,
} from "../lib/bookmarks";
import { isComposing } from "../lib/ime";

const useBmDialog = create<{ open: boolean }>(() => ({ open: false }));

/** Opens „Lesezeichen importieren“. */
export const openBookmarkImport = () => useBmDialog.setState({ open: true });

/** Mounted once in the main window. */
export function BookmarkImportHost() {
  const open = useBmDialog((st) => st.open);
  return open ? <BookmarkImportDialog onClose={() => useBmDialog.setState({ open: false })} /> : null;
}

const s = useApp.getState;

/** Browser badges: a letter on the browser's color (no logos). */
const BADGE: Record<string, { letter: string; color: string }> = {
  chrome: { letter: "C", color: "#1a73e8" },
  edge: { letter: "E", color: "#0c8484" },
  brave: { letter: "B", color: "#fb542b" },
  vivaldi: { letter: "V", color: "#ef3939" },
  opera: { letter: "O", color: "#ff1b2d" },
  "opera-gx": { letter: "GX", color: "#c4123c" },
  arc: { letter: "A", color: "#3139fb" },
  chromium: { letter: "C", color: "#5f6368" },
  firefox: { letter: "F", color: "#e66000" },
  safari: { letter: "S", color: "#0a84ff" },
};

function BrowserBadge({ browser }: { browser: string }) {
  const b = BADGE[browser];
  if (!b) {
    return (
      <span className="bm-badge file" aria-hidden>
        <FileText size={15} strokeWidth={1.75} />
      </span>
    );
  }
  return (
    <span className="bm-badge" style={{ background: b.color }} aria-hidden>
      {b.letter}
    </span>
  );
}

/** A top folder by the browser's own (localized) name, or by its role where it has none. */
const roleTitle = (n: BmNode) => n.title || (n.role ? tr(`bm.role.${n.role}` as TKey) : "");

/** What was read: from a browser profile or a file. */
interface Loaded {
  browser: string;
  label: string;
  tree: BmTree;
}

const sourceLabel = (l: Pick<BmLocation, "browser_name" | "profile" | "profile_dir">) => {
  const p = l.profile || (l.profile_dir && l.profile_dir !== "Default" ? l.profile_dir : "");
  return p ? `${l.browser_name} · ${p}` : l.browser_name;
};

type Step = 0 | 1 | 2;

function BookmarkImportDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [step, setStep] = useState<Step>(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [split, setSplit] = useState(false);
  const [overflow, setOverflow] = useState<"pages" | "drop">("pages");
  const [dest, setDest] = useState<Record<string, Dest>>({});
  const [busy, setBusy] = useState(false);
  const raw = useApp((st) => st.settings?.settings.quick_links);
  const existing = useMemo(() => normalizeLinks(raw), [raw]);
  const idx = useMemo(() => (loaded ? indexTree(loaded.tree, roleTitle) : null), [loaded]);
  const plan = useMemo(() => (idx ? planImport(idx, sel, existing, { split, overflow, dest, topName: t("bm.top") }) : null), [idx, sel, existing, split, overflow, dest, t]);

  const take = (l: Loaded) => {
    setLoaded(l);
    const i = indexTree(l.tree, roleTitle);
    // The bookmarks bar is preselected (what most people want in the ribbon); else nothing.
    const bar = i.roots.map((r) => i.entries.get(r)!).find((e) => e.node.role === "bar");
    setSel(new Set(bar ? bar.leaves : []));
    setDest({});
    setStep(1);
  };

  const titles = [t("bm.step.source"), t("bm.step.select"), t("bm.step.target")];
  const desc = [t("bm.desc.source"), t("bm.desc.select"), t("bm.desc.target")][step];
  const total = idx ? allLeaves(idx).length : 0;

  const doImport = async () => {
    if (!plan || !loaded) return;
    setBusy(true);
    try {
      await runImport(plan, existing, loaded.label);
      onClose();
    } catch (e) {
      s().error(t("bm.importFailed"), e);
    } finally {
      setBusy(false);
    }
  };

  const nothing = !!plan && plan.newLinks === 0 && plan.pages.length === 0;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("bm.title")}
      description={desc}
      width={step === 0 ? 620 : 820}
      footer={
        <>
          <ol className="bm-steps" aria-label={t("bm.title")}>
            {titles.map((x, i) => (
              <li key={x} className={i === step ? "on" : i < step ? "done" : ""} aria-current={i === step ? "step" : undefined}>
                <span className="bm-step-n">{i + 1}</span>
                {x}
              </li>
            ))}
          </ol>
          <span className="grow" />
          {step > 0 && (
            <Button variant="ghost" onClick={() => setStep((step - 1) as Step)}>
              {t("bm.back")}
            </Button>
          )}
          {step === 0 && (
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          )}
          {step === 1 && (
            <Button variant="primary" className="bm-next" disabled={sel.size === 0} onClick={() => setStep(2)}>
              {t("bm.next")}
            </Button>
          )}
          {step === 2 && (
            <Button variant="primary" className="bm-do-import" disabled={nothing || busy} loading={busy} onClick={doImport}>
              {t("bm.import")}
            </Button>
          )}
        </>
      }
    >
      <div className={`bm-import bm-step-${step}`}>
        {step === 0 && <SourceStep onLoaded={take} />}
        {step === 1 && loaded && idx && <SelectStep loaded={loaded} idx={idx} sel={sel} setSel={setSel} total={total} />}
        {step === 2 && plan && (
          <TargetStep
            plan={plan}
            existing={existing}
            split={split}
            setSplit={setSplit}
            overflow={overflow}
            setOverflow={setOverflow}
            setDest={(key, d) => setDest((x) => ({ ...x, [key]: d }))}
          />
        )}
      </div>
    </Dialog>
  );
}

/** Creates the pages, saves the ribbon and offers „Rückgängig“. */
async function runImport(plan: Plan, before: QuickLink[], label: string) {
  const created: number[] = [];
  // Folders the filing created for the pages (Settings → Ordner & Ablage), removed by the undo.
  const folders: number[] = [];
  let parentTitle = tr("bm.pageParent");
  const undoPages = async () => {
    for (const id of [...created].reverse()) await api.deletePage(id).catch(() => {});
    for (const id of [...folders].reverse()) await api.deletePage(id).catch(() => {});
    if (created.length || folders.length) await s().refreshTree();
  };
  try {
    if (plan.pages.length) {
      const intro = tr("bm.pageIntro", { source: label, date: fmtDate(new Date()) });
      for (const p of plan.pages) {
        const made = await filingApi.createFiled("bookmarks", p.title, "link", pageMarkdown(p.items, intro));
        created.push(made.page.id);
        folders.push(...made.folders);
      }
      await s().refreshTree();
      const first = s().pages.get(created[0]);
      parentTitle = first?.parent_id != null ? (s().pages.get(first.parent_id)?.title ?? parentTitle) : tr("fl.topLevel");
    }
    if (plan.newLinks > 0) s().set({ settings: await api.saveQuickLinks(plan.links) });
  } catch (e) {
    await undoPages();
    throw e;
  }
  const parts = [
    plan.newLinks ? tr("bm.doneRibbon", { n: plan.newLinks }) : "",
    plan.pages.length ? tr("bm.donePages", { n: plan.pages.length, parent: parentTitle }) : "",
    plan.duplicates ? tr("bm.doneDup", { n: plan.duplicates }) : "",
  ].filter(Boolean);
  s().toast({
    tone: "success",
    title: tr("bm.done", { n: plan.newLinks + plan.pages.reduce((n, p) => n + p.items.length, 0) }),
    detail: parts.join(" · "),
    action: {
      label: tr("bm.undo"),
      run: () =>
        void (async () => {
          try {
            if (plan.newLinks > 0) s().set({ settings: await api.saveQuickLinks(before) });
            await undoPages();
            s().toast({ tone: "info", title: tr("bm.undone") });
          } catch (e) {
            s().error(tr("links.saveFailed"), e);
          }
        })(),
    },
  });
}

// ------------------------------------------------------------------ step 1: source

function SourceStep({ onLoaded }: { onLoaded: (l: Loaded) => void }) {
  const t = useT();
  const [sources, setSources] = useState<BmSource[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const load = () => {
    setSources(null);
    setError(null);
    bookmarksApi
      .sources()
      .then(setSources)
      .catch((e) => {
        setSources([]);
        setError(String(e));
      });
  };
  useEffect(load, []);

  const readSource = async (src: BmSource) => {
    setReading(src.id);
    setError(null);
    try {
      const r = await bookmarksApi.read(src.id);
      onLoaded({ browser: src.browser, label: sourceLabel(r.source), tree: r.tree });
    } catch (e) {
      setError(String(e));
    } finally {
      setReading(null);
    }
  };
  const readFile = async (name: string, read: () => Promise<BmTree>) => {
    setReading("file");
    setError(null);
    try {
      onLoaded({ browser: "file", label: name, tree: await read() });
    } catch (e) {
      setError(String(e));
    } finally {
      setReading(null);
    }
  };
  const pick = async () => {
    const p = await openFileDialog({ multiple: false, directory: false, filters: [{ name: t("bm.fileFilter"), extensions: ["html", "htm"] }] }).catch(() => null);
    if (typeof p === "string") void readFile(p.split(/[\\/]/).pop() ?? p, () => bookmarksApi.readFile(p));
  };
  const onDrop = (e: ReactDragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag(false);
    const f = [...(e.dataTransfer?.files ?? [])][0];
    if (!f) return;
    if (!isBookmarksFile(f.name)) {
      setError(t("bm.notBookmarks"));
      return;
    }
    void readFile(f.name, async () => bookmarksApi.readText(await f.text()));
  };

  const status = (src: BmSource) => {
    if (src.status === "locked") return { icon: Lock, text: t("bm.locked") };
    if (src.status === "permission") return { icon: ShieldAlert, text: t("bm.permission") };
    if (src.status === "error") return { icon: AlertTriangle, text: t("bm.unreadable") };
    return null;
  };

  return (
    <div className="bm-sources">
      <div className="bm-section-head">
        <span>{t("bm.found")}</span>
        <button type="button" className="bm-link-btn" onClick={load} disabled={sources === null}>
          <RefreshCw size={12} strokeWidth={2} aria-hidden />
          {t("bm.reload")}
        </button>
      </div>
      {sources === null && (
        <div className="bm-loading">
          <Spinner />
          {t("bm.searching")}
        </div>
      )}
      {sources && sources.length === 0 && (
        <div className="bm-empty">
          <div className="bm-empty-title">{t("bm.none")}</div>
          <div className="bm-empty-text">{t("bm.noneText")}</div>
        </div>
      )}
      {sources && sources.length > 0 && (
        <div className="bm-source-list" role="list">
          {sources.map((src) => {
            const st = status(src);
            const disabled = src.status !== "ok" || src.count === 0 || reading !== null;
            return (
              <div role="listitem" key={src.id}>
                <button
                  type="button"
                  className={`bm-source${src.status !== "ok" ? " blocked" : ""}`}
                  data-browser={src.browser}
                  disabled={disabled}
                  title={src.error ?? src.path}
                  onClick={() => readSource(src)}
                >
                  <BrowserBadge browser={src.browser} />
                  <span className="bm-source-text">
                    <span className="bm-source-name">{src.browser_name}</span>
                    <span className="bm-source-profile">
                      {src.profile || (src.profile_dir && src.profile_dir !== "Default" ? src.profile_dir : t("bm.profileDefault"))}
                      {src.profile && src.profile_dir && <span className="faint"> · {src.profile_dir}</span>}
                    </span>
                  </span>
                  {st ? (
                    <span className={`bm-source-status ${src.status}`}>
                      <st.icon size={13} strokeWidth={2} aria-hidden />
                      {st.text}
                    </span>
                  ) : (
                    <span className="bm-source-count">{t("bm.count", { n: src.count })}</span>
                  )}
                  {reading === src.id ? <Spinner size={14} /> : <ChevronRight size={15} className="bm-source-go" aria-hidden />}
                </button>
                {src.status === "permission" && <div className="bm-source-hint">{src.error}</div>}
              </div>
            );
          })}
        </div>
      )}
      <div
        className={`bm-drop${drag ? " over" : ""}`}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          e.stopPropagation();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <FileUp size={18} strokeWidth={1.75} aria-hidden className="bm-drop-icon" />
        <div className="bm-drop-text">
          <Button size="sm" className="bm-pick-file" onClick={pick} disabled={reading !== null} loading={reading === "file"}>
            {t("bm.file")}
          </Button>
          <span className="faint">{drag ? t("bm.dropHere") : t("bm.fileDrop")}</span>
        </div>
      </div>
      {error && (
        <div className="bm-error" role="alert">
          <AlertTriangle size={14} strokeWidth={2} aria-hidden />
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ step 2: selection

function SelectStep({ loaded, idx, sel, setSel, total }: { loaded: Loaded; idx: TreeIndex; sel: Set<string>; setSel: (s: Set<string>) => void; total: number }) {
  const t = useT();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(idx.roots));
  const [focus, setFocus] = useState<string>(idx.order[0] ?? "");
  const list = useRef<HTMLDivElement>(null);
  const visible = useMemo(() => visibleFor(idx, q), [idx, q]);
  // Rows: everything below open folders (a search opens everything it shows).
  const rows = useMemo(() => {
    const out: string[] = [];
    const walk = (id: string) => {
      if (visible && !visible.has(id)) return;
      out.push(id);
      const e = idx.entries.get(id)!;
      if (e.folder && (visible || open.has(id))) e.children.forEach(walk);
    };
    idx.roots.forEach(walk);
    return out;
  }, [idx, open, visible]);
  const focused = rows.includes(focus) ? focus : (rows[0] ?? "");
  const toggle = (id: string) => setSel(toggleEntry(idx, id, sel, visible));
  const setOpenTo = (id: string, v: boolean) =>
    setOpen((o) => {
      const n = new Set(o);
      if (v) n.add(id);
      else n.delete(id);
      return n;
    });
  const focusRow = (id: string) => {
    setFocus(id);
    requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)?.focus());
  };
  const skipped = loaded.tree.skipped;
  const by = (r: string) => skipped.filter((x) => x.reason === r).length;
  const shownLeaves = visible ? [...visible].filter((id) => !idx.entries.get(id)!.folder) : allLeaves(idx);

  const onKey = (e: ReactKeyboardEvent, id: string) => {
    if (isComposing(e)) return;
    const e0 = idx.entries.get(id)!;
    const i = rows.indexOf(id);
    const isOpen = !!visible || open.has(id);
    switch (e.key) {
      case "ArrowDown":
        if (i < rows.length - 1) focusRow(rows[i + 1]);
        break;
      case "ArrowUp":
        if (i > 0) focusRow(rows[i - 1]);
        break;
      case "Home":
        focusRow(rows[0]);
        break;
      case "End":
        focusRow(rows[rows.length - 1]);
        break;
      case "ArrowRight":
        if (e0.folder && !isOpen) setOpenTo(id, true);
        else if (e0.folder && e0.children.length) focusRow(rows[i + 1]);
        break;
      case "ArrowLeft":
        if (e0.folder && isOpen && !visible) setOpenTo(id, false);
        else if (e0.parent) focusRow(e0.parent);
        break;
      case " ":
      case "Enter":
        toggle(id);
        break;
      case "*":
        setOpen(new Set(idx.order.filter((x) => idx.entries.get(x)!.folder)));
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="bm-select">
      <div className="bm-select-bar">
        <span className="bm-select-source">
          <BrowserBadge browser={loaded.browser} />
          <span className="bm-select-label">{loaded.label}</span>
        </span>
        <span className="bm-search">
          <Search size={13} strokeWidth={2} aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("bm.filter")} aria-label={t("bm.filter")} spellCheck={false} data-autofocus />
        </span>
        <span className="bm-select-tools">
          <button type="button" className="bm-link-btn bm-all" onClick={() => setSel(new Set([...sel, ...shownLeaves]))}>
            {t("bm.all")}
          </button>
          <button
            type="button"
            className="bm-link-btn bm-none"
            onClick={() => {
              const n = new Set(sel);
              shownLeaves.forEach((l) => n.delete(l));
              setSel(n);
            }}
          >
            {t("bm.noneSel")}
          </button>
          <button
            type="button"
            className="bm-icon-btn"
            aria-label={t("bm.expandAll")}
            data-tooltip={t("bm.expandAll")}
            onClick={() => setOpen(new Set(idx.order.filter((x) => idx.entries.get(x)!.folder)))}
          >
            <ChevronsUpDown size={14} strokeWidth={1.9} aria-hidden />
          </button>
          <button type="button" className="bm-icon-btn" aria-label={t("bm.collapseAll")} data-tooltip={t("bm.collapseAll")} onClick={() => setOpen(new Set())}>
            <ChevronsDownUp size={14} strokeWidth={1.9} aria-hidden />
          </button>
        </span>
      </div>
      <div className="bm-tree" role="tree" aria-multiselectable="true" aria-label={loaded.label} ref={list}>
        {idx.roots.length === 0 && (
          <div className="bm-empty">
            <div className="bm-empty-title">{t("bm.emptyTree")}</div>
            <div className="bm-empty-text">{t("bm.emptyTreeText")}</div>
          </div>
        )}
        {idx.roots.length > 0 && rows.length === 0 && <div className="bm-empty-text bm-nohits">{t("bm.noHits")}</div>}
        {rows.map((id) => {
          const e = idx.entries.get(id)!;
          const state = checkState(e, sel, visible);
          const isOpen = !!visible || open.has(id);
          const n = visible ? e.leaves.filter((l) => visible.has(l)).length : e.leaves.length;
          return (
            <div
              key={id}
              role="treeitem"
              data-id={id}
              aria-level={e.depth + 1}
              aria-expanded={e.folder ? isOpen : undefined}
              aria-checked={state === "some" ? "mixed" : state === "all"}
              aria-selected={state === "all"}
              tabIndex={id === focused ? 0 : -1}
              className={`bm-row${e.folder ? " folder" : ""}${state !== "none" ? " checked" : ""}`}
              style={{ paddingLeft: 8 + e.depth * 18 }}
              onKeyDown={(ev) => onKey(ev, id)}
              onFocus={() => setFocus(id)}
              onClick={() => toggle(id)}
            >
              {e.folder ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className={`bm-twisty${isOpen ? " open" : ""}`}
                  aria-label={isOpen ? t("bm.collapse") : t("bm.expand")}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (!visible) setOpenTo(id, !isOpen);
                  }}
                >
                  <ChevronRight size={13} strokeWidth={2} aria-hidden />
                </button>
              ) : (
                <span className="bm-twisty-gap" />
              )}
              <span className={`bm-check ${state}`} aria-hidden>
                {state === "all" && (
                  <svg viewBox="0 0 12 12" width="10" height="10">
                    <path d="M2.5 6.3 5 8.6 9.6 3.6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
                {state === "some" && <span className="bm-check-dash" />}
              </span>
              <span className="bm-row-icon">{e.folder ? <FolderClosed size={14} strokeWidth={1.75} /> : <PageIcon name={iconFor(e.node.url ?? "")} size={14} />}</span>
              <span className="bm-row-title">{e.title}</span>
              {e.folder ? (
                <span className="bm-row-count">{n}</span>
              ) : (
                <span className="bm-row-url" title={e.node.added ? `${e.node.url}\n${t("bm.added", { date: fmtDate(new Date(e.node.added * 1000)) })}` : e.node.url}>
                  {hostOf(e.node.url ?? "")}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="bm-select-foot">
        <span className="bm-selected" aria-live="polite">
          {t("bm.selected", { n: sel.size, total })}
        </span>
        {skipped.length > 0 && (
          <span className="bm-skipped" title={t("bm.skippedTitle", { script: by("script"), internal: by("internal"), other: by("other") })}>
            {t("bm.skipped", { n: skipped.length })}
          </span>
        )}
        {loaded.tree.truncated && <span className="bm-skipped">{t("bm.truncated")}</span>}
      </div>
    </div>
  );
}

const iconCache = new Map<string, string>();
/** The icon the import will choose, cached per address for long lists. */
const iconFor = (url: string) => {
  let v = iconCache.get(url);
  if (v === undefined) iconCache.set(url, (v = bookmarkIcon(url)));
  return v;
};

const hostOf = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === "file:" ? decodeURIComponent(u.pathname.split("/").pop() || url) : u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

// ------------------------------------------------------------------ step 3: destination

function TargetStep({
  plan,
  existing,
  split,
  setSplit,
  overflow,
  setOverflow,
  setDest,
}: {
  plan: Plan;
  existing: QuickLink[];
  split: boolean;
  setSplit: (v: boolean) => void;
  overflow: "pages" | "drop";
  setOverflow: (v: "pages" | "drop") => void;
  setDest: (key: string, d: Dest) => void;
}) {
  const t = useT();
  const over = plan.units.some((u) => u.over);
  const hasSub = plan.units.some((u) => u.kind === "group" && u.items.some((i) => i.sub.length > 0)) || plan.units.some((u) => u.name.includes(" / "));
  return (
    <div className="bm-target">
      <div className="bm-target-main">
        <div className="bm-options">
          {hasSub && (
            <div className="bm-option">
              <span className="bm-option-label">{t("bm.sub")}</span>
              <Segmented
                label={t("bm.sub")}
                value={split ? "split" : "flat"}
                options={[
                  { value: "flat", label: t("bm.subFlat") },
                  { value: "split", label: t("bm.subSplit") },
                ]}
                onChange={(v) => setSplit(v === "split")}
              />
            </div>
          )}
          {over && (
            <div className="bm-option">
              <span className="bm-option-label">{t("bm.rest")}</span>
              <Segmented
                label={t("bm.rest")}
                value={overflow}
                options={[
                  { value: "pages", label: t("bm.restPages") },
                  { value: "drop", label: t("bm.restDrop") },
                ]}
                onChange={setOverflow}
              />
            </div>
          )}
        </div>
        {over && (
          <div className="bm-note warn" role="status">
            <AlertTriangle size={14} strokeWidth={2} aria-hidden />
            <span>
              {overflow === "pages"
                ? t("bm.overPages", { max: MAX_RIBBON, group: MAX_GROUP, n: plan.overflow })
                : t("bm.overDrop", { max: MAX_RIBBON, group: MAX_GROUP, n: plan.dropped })}
            </span>
          </div>
        )}
        <div className="bm-units" role="list" aria-label={t("bm.units")}>
          {plan.units.map((u) => (
            <div key={u.key} role="listitem" className={`bm-unit${u.dest === "page" ? " to-page" : ""}${u.over ? " over" : ""}`} data-key={u.key}>
              <span className="bm-unit-icon">{u.dest === "page" ? <FileText size={15} strokeWidth={1.75} /> : u.kind === "group" ? <FolderClosed size={15} strokeWidth={1.75} /> : <Link2 size={15} strokeWidth={1.75} />}</span>
              <span className="bm-unit-text">
                <span className="bm-unit-name">{u.name}</span>
                <span className="bm-unit-meta">
                  {u.dest === "page"
                    ? t("bm.unitPage", { n: u.items.length })
                    : u.kind === "group"
                      ? u.merge !== null
                        ? t("bm.unitMerge", { n: u.inRibbon })
                        : t("bm.unitGroup", { n: u.inRibbon })
                      : t("bm.unitLinks", { n: u.inRibbon })}
                  {u.dest !== "page" && u.toPage > 0 && <span className="bm-chip warn">{t("bm.chipPage", { n: u.toPage })}</span>}
                  {u.dropped > 0 && <span className="bm-chip danger">{t("bm.chipDropped", { n: u.dropped })}</span>}
                  {u.duplicates > 0 && <span className="bm-chip">{t("bm.chipDup", { n: u.duplicates })}</span>}
                </span>
              </span>
              <span className="bm-unit-dest">
                <Segmented
                  label={t("bm.destLabel", { name: u.name })}
                  value={u.dest}
                  options={[
                    { value: "ribbon", label: t("bm.destRibbon") },
                    { value: "page", label: t("bm.destPage") },
                  ]}
                  onChange={(d) => setDest(u.key, d)}
                />
              </span>
            </div>
          ))}
        </div>
        <div className="bm-summary">
          {plan.newLinks === 0 && plan.pages.length === 0 ? (
            <span>{t("bm.nothing")}</span>
          ) : (
            <span>
              {[
                plan.newEntries ? t("bm.sumEntries", { n: plan.newEntries }) : "",
                plan.newLinks ? t("bm.sumLinks", { n: plan.newLinks }) : "",
                plan.pages.length ? t("bm.sumPages", { n: plan.pages.length, parent: t("bm.pageParent") }) : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
          {plan.duplicates > 0 && <span className="bm-summary-dup">{t("bm.sumDup", { n: plan.duplicates })}</span>}
        </div>
      </div>
      <RibbonPreview links={plan.links} existing={existing.length} />
    </div>
  );
}

/** The ribbon after the import: the entries there (muted) and the new ones. */
function RibbonPreview({ links, existing }: { links: QuickLink[]; existing: number }) {
  const t = useT();
  return (
    <div className="bm-preview" aria-label={t("bm.preview")}>
      <div className="bm-preview-head">{t("bm.preview")}</div>
      <div className="bm-preview-strip" role="list">
        {links.length === 0 && <span className="bm-preview-empty">–</span>}
        {links.map((l, i) => {
          const group = isGroup(l);
          const fresh = i >= existing;
          const color = group ? colorHex(l.color) : undefined;
          return (
            <span
              key={`${i}-${l.name}`}
              role="listitem"
              className={`bm-preview-icon${fresh ? " new" : ""}${group ? " group" : ""}`}
              data-tooltip={group ? `${l.name} · ${t("links.count", { n: l.items?.length ?? 0 })}` : l.name}
              data-tooltip-side="left"
              aria-label={l.name}
            >
              <span style={color ? { color } : undefined}>
                <PageIcon name={l.icon || (group ? "folder" : "globe")} size={15} />
              </span>
              {group && <span className="bm-preview-count">{l.items?.length ?? 0}</span>}
            </span>
          );
        })}
      </div>
      <div className={`bm-preview-slots${links.length >= MAX_RIBBON ? " full" : ""}`}>{t("bm.slots", { n: links.length, max: MAX_RIBBON })}</div>
    </div>
  );
}
