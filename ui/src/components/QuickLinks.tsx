// Links in the ribbon: web pages, tools, mail, local folders and programs, each with an icon,
// and groups of them (one icon that lists its entries in a popover next to the ribbon).
// Saved on their own (`quick_links_save`), like the start page's widgets.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowDown, ArrowRightLeft, ArrowUp, ExternalLink, FolderClosed, FolderOpen, Pencil, Plus, Trash2, Ungroup, type LucideIcon } from "lucide-react";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import type { QuickLink } from "../lib/types";
import { IconButton, useMenu, type MenuEntry, type MenuItem } from "./ui";
import { PageIcon } from "./icons";
import { t as tr, useT } from "../lib/i18n";
import { EntryDialog, iconOf, type EntryEdit } from "./LinkDialogs";
import { FILTER_FROM, OPEN_ALL_CONFIRM, colorHex, filterItems, groupChoices, isGroup, kindOf, moveItem, normalizeLinks, removeItem, shortUrl, webItems, type Loc } from "../lib/quicklinks";

export { guessIcon } from "./LinkDialogs";

/** One shared empty list: a new [] per render would look like a change and re-render forever. */
const NONE: QuickLink[] = [];
const s = useApp.getState;

/** The ribbon's links in today's shape (settings of any age). */
export function useQuickLinks(): QuickLink[] {
  const raw = useApp((st) => st.settings?.settings.quick_links ?? NONE);
  return useMemo(() => normalizeLinks(raw), [raw]);
}

export async function saveQuickLinks(next: QuickLink[]) {
  try {
    s().set({ settings: await api.saveQuickLinks(next) });
  } catch (e) {
    s().error(tr("links.saveFailed"), e);
  }
}

/** Opens (or starts) the link or app at `at`. */
export function openQuickLinkAt(at: Loc) {
  const call = at.group === null ? api.openQuickLink(at.index) : api.openQuickLink(at.group, at.index);
  return call.catch((e) => s().error(tr("links.openFailed"), e));
}

/** Opens every web link of the group at `index` (asks first above a handful). */
export async function openAllInGroup(index: number) {
  const g = normalizeLinks(s().settings?.settings.quick_links)[index];
  if (!isGroup(g)) return;
  const items = webItems(g);
  if (!items.length) return;
  if (items.length > OPEN_ALL_CONFIRM) {
    const ok = await s().confirm({ title: tr("links.openAllAsk", { n: items.length }), message: tr("links.openAllText", { name: g.name }), confirmLabel: tr("links.openAll", { n: items.length }) });
    if (!ok) return;
  }
  for (const i of items) await openQuickLinkAt({ group: index, index: i });
}

const GROUP_EVENT = "annalo:link-group";
/** Shows the popover of the group at `index` (command palette). */
export const openLinkGroup = (index: number) => window.dispatchEvent(new CustomEvent(GROUP_EVENT, { detail: index }));

type Drop = { into: number } | { before: number };

/** The links as icons in the ribbon, below its own actions; the name is the tooltip. */
export function QuickLinks() {
  const t = useT();
  const links = useQuickLinks();
  const [editing, setEditing] = useState<EntryEdit | null>(null);
  const [openGroup, setOpenGroup] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ from: number; dy: number; drop: Drop | null } | null>(null);
  const [took, setTook] = useState<number | null>(null);
  const [menu, openMenu, openMenuAt] = useMenu();
  const bar = useRef<HTMLDivElement>(null);
  const dragged = useRef(false);

  useEffect(() => {
    const on = (e: Event) => {
      const i = (e as CustomEvent<number>).detail;
      if (isGroup(normalizeLinks(s().settings?.settings.quick_links)[i])) setOpenGroup(i);
    };
    window.addEventListener(GROUP_EVENT, on);
    return () => window.removeEventListener(GROUP_EVENT, on);
  }, []);
  // A removed group closes its popover.
  useEffect(() => {
    if (openGroup !== null && !isGroup(links[openGroup])) setOpenGroup(null);
  }, [links, openGroup]);

  const addItem = (group: number | null) => setEditing({ kind: "item", at: null, link: { name: "", url: "", icon: "" }, group, allowGroup: group === null });
  const editAt = (at: Loc) => {
    setOpenGroup(null);
    const l = at.group === null ? links[at.index] : links[at.group]?.items?.[at.index];
    if (!l) return;
    setEditing(isGroup(l) ? { kind: "group", index: at.index } : { kind: "item", at, link: l, group: at.group, allowGroup: false });
  };
  const move = (from: Loc, to: Loc) => saveQuickLinks(moveItem(links, from, to));
  const removeGroup = async (i: number) => {
    const g = links[i];
    const n = g.items?.length ?? 0;
    if (n > 0 && !(await s().confirm({ title: t("links.removeGroup"), message: t("links.removeGroupAsk", { name: g.name, n }), confirmLabel: t("links.remove"), danger: true }))) return;
    saveQuickLinks(removeItem(links, { group: null, index: i }));
  };
  /** „Verschieben nach“: the ribbon and the other groups. */
  const moveTargets = (at: Loc): MenuItem[] => [
    ...(at.group !== null ? [{ label: t("links.ribbon"), icon: ArrowRightLeft, onSelect: () => move(at, { group: null, index: links.length }) }] : []),
    ...groupChoices(links)
      .filter((c) => c.index !== at.group)
      .map((c) => ({ label: c.name, icon: FolderClosed, onSelect: () => move(at, { group: c.index, index: links[c.index].items?.length ?? 0 }) })),
  ];

  const linkEntries = (i: number): MenuEntry[] => {
    const targets = moveTargets({ group: null, index: i });
    return [
      { label: t("links.open"), icon: ExternalLink, onSelect: () => openQuickLinkAt({ group: null, index: i }) },
      { label: t("links.editShort"), icon: Pencil, onSelect: () => editAt({ group: null, index: i }) },
      { label: t("links.up"), icon: ArrowUp, disabled: i === 0, onSelect: () => move({ group: null, index: i }, { group: null, index: i - 1 }) },
      { label: t("links.down"), icon: ArrowDown, disabled: i === links.length - 1, onSelect: () => move({ group: null, index: i }, { group: null, index: i + 2 }) },
      ...(targets.length ? [{ label: t("links.inGroup"), icon: FolderClosed, submenu: targets }] : []),
      "separator",
      { label: t("links.addAny"), icon: Plus, onSelect: () => addItem(null) },
      { label: t("links.remove"), icon: Trash2, danger: true, onSelect: () => saveQuickLinks(removeItem(links, { group: null, index: i })) },
    ];
  };
  const groupEntries = (i: number): MenuEntry[] => {
    const g = links[i];
    const web = webItems(g).length;
    return [
      { label: t("links.openGroup"), icon: FolderOpen, onSelect: () => setOpenGroup(i) },
      ...(web > 0 ? [{ label: t("links.openAll", { n: web }), icon: ExternalLink, onSelect: () => openAllInGroup(i) }] : []),
      { label: t("links.editGroup"), icon: Pencil, onSelect: () => editAt({ group: null, index: i }) },
      { label: t("links.up"), icon: ArrowUp, disabled: i === 0, onSelect: () => move({ group: null, index: i }, { group: null, index: i - 1 }) },
      { label: t("links.down"), icon: ArrowDown, disabled: i === links.length - 1, onSelect: () => move({ group: null, index: i }, { group: null, index: i + 2 }) },
      "separator",
      { label: t("links.add"), icon: Plus, onSelect: () => addItem(i) },
      {
        label: t("links.ungroup"),
        icon: Ungroup,
        disabled: !g.items?.length,
        onSelect: () => saveQuickLinks([...links.slice(0, i), ...(g.items ?? []), ...links.slice(i + 1)]),
      },
      { label: t("links.removeGroup"), icon: Trash2, danger: true, onSelect: () => removeGroup(i) },
    ];
  };

  /** Where a ribbon entry dragged from `from` would land at the pointer's height. */
  const dropAt = (y: number, from: number): Drop | null => {
    const buttons = [...(bar.current?.querySelectorAll<HTMLElement>(".quick-link[data-index]") ?? [])];
    for (const b of buttons) {
      const i = Number(b.dataset.index);
      const r = b.getBoundingClientRect();
      // The middle of a group takes the link in; its edges place it before or after.
      if (i !== from && isGroup(links[i]) && !isGroup(links[from]) && y > r.top + r.height * 0.22 && y < r.bottom - r.height * 0.22) return { into: i };
    }
    const hit = buttons.find((b) => {
      const r = b.getBoundingClientRect();
      return y < r.top + r.height / 2;
    });
    const before = hit ? Number(hit.dataset.index) : links.length;
    return before === from || before === from + 1 ? null : { before };
  };

  const onDown = (e: ReactPointerEvent<HTMLButtonElement>, from: number) => {
    if (e.button !== 0) return;
    const y0 = e.clientY;
    const x0 = e.clientX;
    let cur: { from: number; dy: number; drop: Drop | null } | null = null;
    const onMove = (ev: PointerEvent) => {
      if (!cur && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      cur = { from, dy: ev.clientY - y0, drop: dropAt(ev.clientY, from) };
      setDrag(cur);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (!cur) return;
      // The click that ends a drag does not open the link.
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      const d = cur.drop;
      if (!d) return;
      if ("into" in d) {
        move({ group: null, index: from }, { group: d.into, index: links[d.into].items?.length ?? 0 });
        const landed = from < d.into ? d.into - 1 : d.into;
        setTook(landed);
        setTimeout(() => setTook(null), 700);
      } else move({ group: null, index: from }, { group: null, index: d.before });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onKey = (e: React.KeyboardEvent<HTMLButtonElement>, i: number) => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const up = e.key === "ArrowUp";
      if (up ? i === 0 : i === links.length - 1) return;
      move({ group: null, index: i }, { group: null, index: up ? i - 1 : i + 2 });
      setTimeout(() => bar.current?.querySelector<HTMLElement>(`.quick-link[data-index="${up ? i - 1 : i + 1}"]`)?.focus(), 60);
    } else if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      e.preventDefault();
      openMenuAt(e.currentTarget, isGroup(links[i]) ? groupEntries(i) : linkEntries(i), { keyboard: true });
    } else if (isGroup(links[i]) && e.key === "ArrowRight") {
      e.preventDefault();
      setOpenGroup(i);
    }
  };

  // The indicator line for a reorder drop, between two icons.
  const lineTop = (() => {
    const d = drag?.drop;
    if (!d || !("before" in d) || !bar.current) return null;
    const btn = bar.current.querySelector<HTMLElement>(`.quick-link[data-index="${Math.min(d.before, links.length - 1)}"]`);
    if (!btn) return null;
    return d.before >= links.length ? btn.offsetTop + btn.offsetHeight + 2 : btn.offsetTop - 3;
  })();

  return (
    <div className={`quick-links${drag ? " dragging" : ""}`} role="group" aria-label={t("links.title")} ref={bar}>
      {links.map((l, i) => {
        const label = l.name || l.url;
        const group = isGroup(l);
        const n = l.items?.length ?? 0;
        const into = drag?.drop && "into" in drag.drop && drag.drop.into === i;
        const cls = [
          "icon-btn quick-link",
          group ? "quick-group" : "",
          openGroup === i ? "active" : "",
          drag?.from === i ? "drag-src" : "",
          into ? "drop-into" : "",
          took === i ? "took" : "",
        ].join(" ");
        return (
          <button
            key={`${i}-${group ? `g:${l.name}` : l.url}`}
            type="button"
            className={cls}
            data-index={i}
            aria-label={label}
            aria-haspopup={group ? "listbox" : undefined}
            aria-expanded={group ? openGroup === i : undefined}
            data-tooltip={into ? t("links.dropInto", { name: label }) : group ? `${label} · ${t("links.count", { n })}` : label}
            data-tooltip-side="right"
            style={drag?.from === i ? { transform: `translateY(${drag.dy}px)` } : undefined}
            onPointerDown={(e) => onDown(e, i)}
            onClick={() => {
              if (dragged.current) return;
              if (group) setOpenGroup((g) => (g === i ? null : i));
              else openQuickLinkAt({ group: null, index: i });
            }}
            onKeyDown={(e) => onKey(e, i)}
            onContextMenu={(e) => openMenu(e, group ? groupEntries(i) : linkEntries(i))}
          >
            <span className="quick-link-glyph" style={group && colorHex(l.color) ? { color: colorHex(l.color) } : undefined}>
              <PageIcon name={iconOf(l)} size={17} />
            </span>
            {group && (
              <span className="quick-group-count" aria-hidden>
                {n}
              </span>
            )}
          </button>
        );
      })}
      {lineTop !== null && <span className="quick-drop-line" style={{ top: lineTop }} aria-hidden />}
      <IconButton icon={Plus} label={t("links.addAny")} className="quick-link-add" tooltipSide="right" size="md" onClick={() => addItem(null)} />
      {menu}
      {openGroup !== null && isGroup(links[openGroup]) && (
        <LinkGroupPopover
          links={links}
          index={openGroup}
          onClose={(refocus) => {
            const i = openGroup;
            setOpenGroup(null);
            if (refocus) bar.current?.querySelector<HTMLElement>(`.quick-link[data-index="${i}"]`)?.focus();
          }}
          onEdit={(at) => {
            setOpenGroup(null);
            editAt(at);
          }}
          onAdd={() => {
            const i = openGroup;
            setOpenGroup(null);
            addItem(i);
          }}
          moveTargets={moveTargets}
        />
      )}
      {editing && (
        <EntryDialog
          links={links}
          edit={editing}
          onClose={() => setEditing(null)}
          onSave={(next) => {
            saveQuickLinks(next);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * The entries of a group next to its ribbon icon: arrows choose, Enter opens (Ctrl+Enter, Ctrl-
 * and middle-click keep the list open), Escape closes; typing filters longer lists.
 */
function LinkGroupPopover({
  links,
  index,
  onClose,
  onEdit,
  onAdd,
  moveTargets,
}: {
  links: QuickLink[];
  index: number;
  onClose: (refocus: boolean) => void;
  onEdit: (at: Loc) => void;
  onAdd: () => void;
  moveTargets: (at: Loc) => MenuItem[];
}) {
  const t = useT();
  const g = links[index];
  const items = g.items ?? [];
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [pos, setPos] = useState<{ x: number; y: number; side: "right" | "left" } | null>(null);
  const [menu, openMenu] = useMenu();
  const filtering = items.length > FILTER_FROM;
  const shown = useMemo(() => filterItems(items, filtering ? q : ""), [items, q, filtering]);
  const web = webItems(g).length;
  const anchor = () => document.querySelector<HTMLElement>(`.ribbon .quick-link[data-index="${index}"]`);

  // Next to the icon, top-aligned with it; moved up to stay inside the window, and to the
  // left of the icon when there is no room on the right.
  useLayoutEffect(() => {
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const a = anchor()?.getBoundingClientRect() ?? { left: 8, right: 56, top: 80, bottom: 112 };
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const right = a.right + 8 + w <= window.innerWidth - 8;
      const x = right ? a.right + 8 : Math.max(8, a.left - 8 - w);
      const y = Math.max(8, Math.min(a.top - 6, window.innerHeight - h - 8));
      setPos({ x, y, side: right ? "right" : "left" });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [index, shown.length]);

  useEffect(() => {
    setSel(0);
  }, [q, index]);
  // Focused once placed (a hidden element cannot take the focus).
  const placed = pos !== null;
  useEffect(() => {
    if (placed) (filtering ? input.current : ref.current?.querySelector<HTMLElement>(".link-pop-list"))?.focus();
  }, [filtering, index, placed]);
  useEffect(() => {
    ref.current?.querySelector(`[data-pos="${sel}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [sel]);

  const open = (pos: number, keep: boolean) => {
    const hit = shown[pos];
    if (!hit) return;
    openQuickLinkAt({ group: index, index: hit.index });
    if (!keep) onClose(false);
  };

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Element | null;
      if (!tgt || ref.current?.contains(tgt) || tgt.closest(".menu, .dialog, .overlay") || anchor()?.contains(tgt)) return;
      onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // A context menu or dialog opened from here handles its own keys.
      if (document.querySelector(".menu, .dialog")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        setSel((v) => (e.key === "ArrowDown" ? (v + 1) % shown.length : (v - 1 + shown.length) % shown.length));
      } else if (e.key === "Home" || e.key === "End") {
        if (filtering && document.activeElement === input.current) return;
        e.preventDefault();
        setSel(e.key === "Home" ? 0 : Math.max(0, shown.length - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        open(sel, e.ctrlKey || e.metaKey);
      } else if (e.key === "Tab") {
        onClose(false);
      } else if (filtering && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement !== input.current) {
        input.current?.focus();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  });

  const rowMenu = (i: number): MenuEntry[] => {
    const at = { group: index, index: i };
    const targets = moveTargets(at);
    return [
      { label: t("links.open"), icon: ExternalLink, onSelect: () => openQuickLinkAt(at) },
      { label: t("links.editShort"), icon: Pencil, onSelect: () => onEdit(at) },
      { label: t("links.up"), icon: ArrowUp, disabled: i === 0, onSelect: () => saveQuickLinks(moveItem(links, at, { group: index, index: i - 1 })) },
      { label: t("links.down"), icon: ArrowDown, disabled: i === items.length - 1, onSelect: () => saveQuickLinks(moveItem(links, at, { group: index, index: i + 2 })) },
      ...(targets.length ? [{ label: t("links.moveTo"), icon: ArrowRightLeft, submenu: targets }] : []),
      "separator",
      { label: t("links.remove"), icon: Trash2, danger: true, onSelect: () => saveQuickLinks(removeItem(links, at)) },
    ];
  };
  const color = colorHex(g.color);
  const footButton = (icon: LucideIcon, label: string, onClick: () => void, cls = "") => {
    const I = icon;
    return (
      <button type="button" className={`link-pop-action ${cls}`} onClick={onClick}>
        <I size={13} strokeWidth={1.9} aria-hidden />
        {label}
      </button>
    );
  };

  return createPortal(
    <div
      className={`link-pop side-${pos?.side ?? "right"}`}
      role="dialog"
      aria-label={g.name}
      ref={ref}
      style={pos ? { left: pos.x, top: pos.y } : { left: 0, top: 0, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="link-pop-head">
        <span className="link-pop-glyph" style={color ? { color, background: `color-mix(in srgb, ${color} 16%, transparent)` } : undefined}>
          <PageIcon name={iconOf(g)} size={15} />
        </span>
        <span className="link-pop-title">{g.name}</span>
        <span className="link-pop-count">{items.length}</span>
        <IconButton icon={Pencil} label={t("links.editGroup")} size="sm" onClick={() => onEdit({ group: null, index })} />
      </div>
      {filtering && (
        <div className="link-pop-filter">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("links.filter")} aria-label={t("links.filter")} spellCheck={false} />
        </div>
      )}
      <div className="link-pop-list" role="listbox" tabIndex={-1} aria-label={g.name} aria-activedescendant={shown[sel] ? `link-pop-${shown[sel].index}` : undefined}>
        {items.length === 0 && <div className="link-pop-empty">{t("links.itemsEmpty")}</div>}
        {items.length > 0 && shown.length === 0 && <div className="link-pop-empty">{t("links.noHits")}</div>}
        {shown.map(({ item, index: i }, p) => (
          <div
            key={`${i}-${item.url}`}
            id={`link-pop-${i}`}
            role="option"
            aria-selected={p === sel}
            data-pos={p}
            className={`link-pop-row${p === sel ? " sel" : ""}`}
            onMouseMove={() => p !== sel && setSel(p)}
            onMouseDown={(e) => e.button === 1 && e.preventDefault()}
            onClick={(e) => open(p, e.ctrlKey || e.metaKey)}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              open(p, true);
            }}
            onContextMenu={(e) => {
              setSel(p);
              openMenu(e, rowMenu(i));
            }}
          >
            <span className="link-pop-icon">
              <PageIcon name={iconOf(item)} size={15} />
            </span>
            <span className="link-pop-text">
              <span className="link-pop-name">{item.name || item.url}</span>
              <span className="link-pop-url">{shortUrl(item.url)}</span>
            </span>
            {kindOf(item) === "app" && <span className="link-pop-tag">{t("links.kindApp")}</span>}
          </div>
        ))}
      </div>
      <div className="link-pop-foot">
        {footButton(Plus, t("links.add"), onAdd)}
        <span className="grow" />
        {web > 1 && footButton(ExternalLink, t("links.openAll", { n: web }), () => void openAllInGroup(index), "link-pop-openall")}
      </div>
      {menu}
    </div>,
    document.body,
  );
}
