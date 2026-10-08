// `/zeit` chips and the bookings behind them (1.12).
//
// A chip shows its booking: the backend rewrites it when the entry is edited or deleted
// elsewhere (`state="deleted"`), and the link check here keeps it current otherwise (a note
// from a version or another device). A chip belongs to its booking once: copies (pasted twice,
// or into another note) show as not booked and can be booked on their own. Removing a booked
// chip removes its booking after an undo toast; the chip coming back (undo, paste after cut)
// keeps or restores it. Time is never deleted without the toast.

import { Node, mergeAttributes, type Editor } from "@tiptap/core";
import { NodeSelection, Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { decimal, fmtDate, fmtDayMonth, isoDay } from "../lib/format";
import { onI18nChange, t, type TKey } from "../lib/i18n";
import { timeTrackingEnabled } from "../lib/timetracking";
import { useApp } from "../store/app";
import { api } from "../lib/api";
import type { ChipLink, ChipState, TimeEntry, TimeEntryRow } from "../lib/types";
import { flushAllEditors } from "./saves";

/** How a chip shows: its booking, deleted, a copy without booking, no booking here, or not known yet. */
export type ChipStatus = "linked" | "deleted" | "copy" | "missing" | "unknown";

export interface ChipAttrs {
  entryId: number | string | null;
  hours: string;
  target: string;
  text: string;
  la: string;
  date: string;
  state: string;
}

/** Booked hours as stored in a chip („1,50“ or „1.5“) in the regional number format. */
export const chipHours = (h: unknown) => {
  const n = Number(String(h ?? "").replace(",", "."));
  return Number.isFinite(n) && String(h ?? "").trim() ? decimal(n, 2) : String(h ?? "");
};

/** Minutes of a chip's `hours` attribute. */
export const chipMinutes = (h: unknown) => {
  const n = Number(String(h ?? "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 60) : 0;
};

/** `hours` for a chip: two decimals with the separator the chip already uses (as the backend writes it). */
export function hoursAttr(minutes: number, like: string): string {
  const cents = Math.floor((minutes * 100 + 30) / 60);
  const point = like.includes(".") && !like.includes(",");
  return `${Math.floor(cents / 100)}${point ? "." : ","}${String(cents % 100).padStart(2, "0")}`;
}

const entityMap: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: unknown) => escapeHtml(String(s ?? "")).replace(/"/g, "&quot;");
const unescape = (s: string) => s.replace(/&(quot|amp|lt|gt|#39);/g, (_e, n: string) => entityMap[n]);

/** The chip's Markdown: attributes in a fixed order (the backend writes the same, `chips::render`). */
export function chipMarkdown(a: Partial<ChipAttrs>): string {
  let s = `<time-entry id="${escapeAttr(a.entryId ?? "")}" hours="${escapeAttr(a.hours)}" target="${escapeAttr(a.target)}"`;
  if (a.la) s += ` la="${escapeAttr(a.la)}"`;
  if (a.date) s += ` date="${escapeAttr(a.date)}"`;
  if (a.state) s += ` state="${escapeAttr(a.state)}"`;
  return `${s}>${escapeHtml(a.text ?? "")}</time-entry>`;
}

/** Reference of a booking as chips show it: `NP-8801/1020`. */
const rowTarget = (r: TimeEntryRow) => (r.vorgang_nr ? `${r.netzplan_nr}/${r.vorgang_nr}` : r.netzplan_nr);

/** The attributes that differ between a chip and its booking (none: the chip is current). */
export function staleAttrs(a: Partial<ChipAttrs>, row: TimeEntryRow): Partial<ChipAttrs> | null {
  const minutes = row.duration_minutes ?? 0;
  const next: Partial<ChipAttrs> = {};
  if (chipMinutes(a.hours) !== minutes) next.hours = hoursAttr(minutes, String(a.hours ?? ""));
  if ((a.target ?? "") !== rowTarget(row)) next.target = rowTarget(row);
  if ((a.la ?? "") !== (row.leistungsart ?? "")) next.la = row.leistungsart ?? "";
  const day = isoDay(new Date(row.start_time));
  if ((a.date ?? "") !== day) next.date = day;
  if ((a.text ?? "") !== row.description) next.text = row.description;
  return Object.keys(next).length ? next : null;
}

const idOf = (node: PMNode): number | null => {
  const n = Number(node.attrs.entryId);
  return Number.isInteger(n) && n > 0 ? n : null;
};

interface ChipAt {
  id: number | null;
  pos: number;
  node: PMNode;
}

export function chipsIn(doc: PMNode): ChipAt[] {
  const out: ChipAt[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "timeEntry") out.push({ id: idOf(node), pos, node });
    return node.isBlock || node.type.name !== "timeEntry";
  });
  return out;
}

/**
 * How each chip of a note shows, in document order: deleted chips by their mark; of the
 * others, the first of an entry is its booking (as the link check says), later ones are copies.
 */
export function chipStatuses(chips: { id: number | null; state?: string }[], links: ReadonlyMap<number, ChipLink>): ChipStatus[] {
  const seen = new Set<number>();
  return chips.map((c) => {
    if (c.state === "deleted") return "deleted";
    if (c.id == null) return "missing";
    if (seen.has(c.id)) return "copy";
    seen.add(c.id);
    const link = links.get(c.id);
    return link === "linked" ? "linked" : link === "elsewhere" ? "copy" : link === "missing" ? "missing" : "unknown";
  });
}

// ------------------------------------------------------------- link plugin

export const chipLinkKey = new PluginKey<LinkState>("timeChipLink");

type ChipEvent = { seq: number; kind: "removed"; id: number; node: PMNode } | { seq: number; kind: "appeared"; id: number };

interface LinkState {
  links: Map<number, ChipLink>;
  rows: Map<number, TimeEntryRow>;
  deco: DecorationSet;
  count: number;
  /**
   * Booked chips removed by user edits, and removed chips that came back, numbered: a dispatch
   * may apply several transactions (appended ones), the view handles each event once.
   */
  events: ChipEvent[];
  /** Removed booked chips and where they were, mapped through later edits („Rückgängig“). */
  parked: Map<number, { node: PMNode; pos: number }>;
}

/** Transactions of our own (attribute refreshes) and of reloads: no deletion follows from them. */
const OWN = "timeChipOwn";

function decorate(doc: PMNode, links: ReadonlyMap<number, ChipLink>): { deco: DecorationSet; count: number } {
  const chips = chipsIn(doc);
  const statuses = chipStatuses(chips.map((c) => ({ id: c.id, state: c.node.attrs.state })), links);
  const decos = chips.map((c, i) => Decoration.node(c.pos, c.pos + c.node.nodeSize, { "data-chip": statuses[i] }, { chipStatus: statuses[i] }));
  return { deco: DecorationSet.create(doc, decos), count: chips.length };
}

/** Whether a transaction inserted or changed a chip (a replaced slice holds one). */
function touchesChips(tr: Transaction): boolean {
  return tr.steps.some((step) => {
    const slice = (step as unknown as { slice?: { content: { descendants: (f: (n: PMNode) => boolean | void) => void } } }).slice;
    let found = false;
    slice?.content.descendants((n) => {
      if (n.type.name === "timeEntry") found = true;
      return !found;
    });
    return found;
  });
}

// Removing a booked chip, in the rich editor and in the Markdown source view alike.
// Bookings whose chip was removed: deleted when the toast closes, unless the chip is back.
const GRACE_MS = 7000;
const pendingDeletes = new Map<number, number>();
// Bookings deleted with their chip in this session: put back when the chip comes back.
const deletedWithChip = new Map<number, TimeEntry>();
// Chip ids in the open editors, rich and source (a chip pasted into another note keeps the booking).
const presentIn = new Map<object, Set<number>>();

const presentAnywhere = (id: number) => [...presentIn.values()].some((s) => s.has(id));

/** The chip ids an editor (`owner`) shows now; `null` when it closes. */
export function chipsPresent(owner: object, ids: Iterable<number> | null) {
  if (ids) presentIn.set(owner, new Set(ids));
  else presentIn.delete(owner);
}

/** Whether a chip `id` coming back matters: its booking is about to go, or went with it. */
export const chipAwaited = (id: number) => pendingDeletes.has(id) || deletedWithChip.has(id);

/** „1,5 h · NP-8801/1020 · Text“: a chip in toasts. */
export function describeChip(a: Partial<ChipAttrs>) {
  return `${chipHours(a.hours)} h · ${a.target ?? ""}${a.text ? " · " + a.text : ""}`;
}

/**
 * The booked chip `id` was removed from a note: its booking goes after the undo toast.
 * „Rückgängig“ keeps the booking and calls `putBack` to put the chip where it was.
 */
export function chipRemoved(id: number, a: Partial<ChipAttrs>, row: TimeEntryRow | undefined, putBack: () => void) {
  const s = useApp.getState();
  // Moved: pasted into another open note already, the booking goes along.
  if (pendingDeletes.has(id) || presentAnywhere(id)) return;
  if (row && (row.status_flag === "exported" || row.status_flag === "released")) {
    // Already in SAP (or released for it): the booking stays, the user is told.
    s.toast({ tone: "info", title: t("chip.keptExported"), detail: describeChip(a), key: `chip-${id}` });
    return;
  }
  const timer = window.setTimeout(async () => {
    pendingDeletes.delete(id);
    if (presentAnywhere(id)) return;
    try {
      deletedWithChip.set(id, await api.chipDelete(id));
      useApp.getState().bumpEntries();
    } catch (e) {
      useApp.getState().error(t("chip.deleteFailed"), e);
    }
  }, GRACE_MS);
  pendingDeletes.set(id, timer);
  s.toast({
    tone: "info",
    title: t("chip.bookingDeleted"),
    detail: describeChip(a),
    key: `chip-${id}`,
    urgent: true,
    timeout: GRACE_MS,
    action: {
      label: t("common.undo"),
      run: () => {
        cancelDelete(id);
        // The chip back where it was (the booking was not touched yet).
        if (!presentAnywhere(id)) putBack();
      },
    },
  });
}

function cancelDelete(id: number): boolean {
  const timer = pendingDeletes.get(id);
  if (timer == null) return false;
  clearTimeout(timer);
  pendingDeletes.delete(id);
  return true;
}

/** The rich editor's „Rückgängig“: the removed chip back where it was. */
function putBackIn(view: EditorView, id: number) {
  const removed = view.isDestroyed ? undefined : chipLinkKey.getState(view.state)?.parked.get(id);
  if (!removed) return;
  const pos = Math.min(removed.pos, view.state.doc.content.size);
  try {
    view.dispatch(view.state.tr.insert(pos, removed.node));
  } catch {
    /* the place is gone: the booking stays */
  }
}

/**
 * The chip `id` is in a note again: a pending deletion stops, a deleted booking comes back
 * (with its Jira worklog). `retarget` points the chip at the booking when it got another id.
 */
export async function chipReturned(id: number, retarget: (newId: number) => void) {
  const s = useApp.getState();
  if (cancelDelete(id)) {
    s.toast({ tone: "success", title: t("chip.bookingKept"), key: `chip-${id}`, timeout: 2500 });
    return;
  }
  const snapshot = deletedWithChip.get(id);
  if (!snapshot) return;
  deletedWithChip.delete(id);
  try {
    const back = await api.chipRestore(snapshot);
    s.bumpEntries();
    s.toast({ tone: "success", title: t("chip.bookingRestored"), key: `chip-${id}`, timeout: 2500 });
    // Its id was taken meanwhile: the chip points at the restored booking.
    if (back.id !== id) retarget(back.id);
  } catch (e) {
    s.error(t("chip.restoreFailed"), e);
  }
}

/** Keeps the chips of note `pageId` linked to their bookings (see the file comment). */
export function chipLinkPlugin(pageId: number) {
  return new Plugin<LinkState>({
    key: chipLinkKey,
    state: {
      init: (_, state) => ({ links: new Map(), rows: new Map(), ...decorate(state.doc, new Map()), events: [], parked: new Map() }),
      apply(tr, prev, oldState: EditorState, newState: EditorState) {
        const meta = tr.getMeta(chipLinkKey) as { links: Map<number, ChipLink>; rows: Map<number, TimeEntryRow> } | undefined;
        const links = meta?.links ?? prev.links;
        const rows = meta?.rows ?? prev.rows;
        if (!tr.docChanged && !meta) return prev;
        let next: { deco: DecorationSet; count: number };
        if (meta || touchesChips(tr)) next = decorate(newState.doc, links);
        else {
          const mapped = prev.deco.map(tr.mapping, newState.doc);
          next = mapped.find().length === prev.count ? { deco: mapped, count: prev.count } : decorate(newState.doc, links);
        }
        let parked = prev.parked;
        if (tr.docChanged && parked.size) parked = new Map([...parked].map(([id, r]) => [id, { ...r, pos: tr.mapping.map(r.pos, -1) }]));
        let events = prev.events;
        let seq = events.length ? events[events.length - 1].seq : 0;
        // Only a transaction that removed (fewer chips) or inserted chips can remove or bring one back.
        if (tr.docChanged && (next.count < prev.count || touchesChips(tr))) {
          const before = chipsIn(oldState.doc);
          const after = new Set(chipsIn(newState.doc).map((c) => c.id));
          const external = tr.getMeta("preventUpdate") || tr.getMeta(OWN);
          if (!external) {
            const statuses = chipStatuses(before.map((c) => ({ id: c.id, state: c.node.attrs.state })), prev.links);
            const removed = before.filter((c, i) => statuses[i] === "linked" && c.id != null && !after.has(c.id));
            if (removed.length) {
              parked = new Map(parked);
              for (const c of removed) parked.set(c.id!, { node: c.node, pos: tr.mapping.map(c.pos, -1) });
              events = [...events, ...removed.map((c): ChipEvent => ({ seq: ++seq, kind: "removed", id: c.id!, node: c.node }))];
            }
          }
          const appeared = [...after].filter((id): id is number => id != null && chipAwaited(id));
          if (appeared.length) events = [...events, ...appeared.map((id): ChipEvent => ({ seq: ++seq, kind: "appeared", id }))];
        }
        // A short log is enough: the view handles new events right after each dispatch.
        if (events.length > 20) events = events.slice(-20);
        return { links, rows, ...next, events, parked };
      },
    },
    props: {
      decorations: (state) => chipLinkKey.getState(state)?.deco,
    },
    view(view) {
      let timer = 0;
      let asked = "";
      let alive = true;
      const query = () => {
        const seen = new Set<number>();
        return chipsIn(view.state.doc)
          .filter((c) => c.id != null && c.node.attrs.state !== "deleted" && !seen.has(c.id) && (seen.add(c.id), true))
          .map((c) => ({ id: c.id!, target: String(c.node.attrs.target ?? "") }));
      };
      const refresh = (force = false, flush = false) => {
        if (!timeTrackingEnabled()) return;
        const chips = query();
        const key = JSON.stringify(chips);
        if (!force && key === asked) return;
        asked = key;
        clearTimeout(timer);
        timer = window.setTimeout(async () => {
          if (!chips.length) {
            if (chipLinkKey.getState(view.state)?.links.size && !view.isDestroyed) view.dispatch(view.state.tr.setMeta(chipLinkKey, { links: new Map(), rows: new Map() }).setMeta("addToHistory", false));
            return;
          }
          let states: ChipState[];
          try {
            // A chip pasted after a cut in another note: that note is saved first, so the
            // booking moves along instead of showing as a copy.
            if (flush) await flushAllEditors().catch(() => {});
            states = await api.chipStates(pageId, chips);
          } catch {
            return;
          }
          if (!alive || view.isDestroyed) return;
          const links = new Map(states.map((x) => [x.id, x.link] as const));
          const rows = new Map(states.filter((x) => x.row).map((x) => [x.id, x.row!] as const));
          const tr = view.state.tr.setMeta(chipLinkKey, { links, rows }).setMeta("addToHistory", false).setMeta(OWN, true);
          // A booking changed where the backend could not rewrite the note (an older version
          // restored, the command line): the chip takes over its current values.
          if (view.editable) {
            const statuses = chipStatuses(chipsIn(tr.doc).map((c) => ({ id: c.id, state: c.node.attrs.state })), links);
            chipsIn(tr.doc).forEach((c, i) => {
              const row = c.id != null && statuses[i] === "linked" ? rows.get(c.id) : undefined;
              const stale = row && staleAttrs(c.node.attrs as ChipAttrs, row);
              if (stale) tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, ...stale });
            });
          }
          view.dispatch(tr);
        }, 250);
      };
      const remember = () => chipsPresent(view, chipsIn(view.state.doc).flatMap((c) => (c.id != null ? [c.id] : [])));
      remember();
      refresh();
      // Entries changed (timesheet, another note, a timer): the link may have changed too.
      let version = useApp.getState().entriesVersion;
      const unsub = useApp.subscribe((st) => {
        if (st.entriesVersion === version) return;
        version = st.entriesVersion;
        refresh(true);
      });
      let handled = 0;
      return {
        update(v, prevState) {
          const st = chipLinkKey.getState(v.state);
          if (!st || v.state.doc === prevState.doc) return;
          remember();
          const fresh = st.events.filter((e) => e.seq > handled);
          if (fresh.length) handled = fresh[fresh.length - 1].seq;
          if (!timeTrackingEnabled()) return;
          for (const e of fresh) {
            if (e.kind === "removed") chipRemoved(e.id, e.node.attrs as ChipAttrs, st.rows.get(e.id), () => putBackIn(v, e.id));
            else
              void chipReturned(e.id, (newId) => {
                if (v.isDestroyed) return;
                const at = chipsIn(v.state.doc).find((c) => c.id === e.id);
                if (at) v.dispatch(v.state.tr.setNodeMarkup(at.pos, undefined, { ...at.node.attrs, entryId: newId }).setMeta("addToHistory", false).setMeta(OWN, true));
              });
          }
          refresh(false, fresh.some((e) => e.kind === "appeared"));
        },
        destroy() {
          alive = false;
          clearTimeout(timer);
          unsub();
          chipsPresent(view, null);
        },
      };
    },
  });
}

// ------------------------------------------------------------- the chip node

/** The chip's menu: the host (ChipHost.tsx) shows it at the chip. */
export interface ChipMenuRequest {
  anchor: Element;
  keyboard: boolean;
  status: ChipStatus;
  attrs: ChipAttrs;
  edit: () => void;
  book: () => void;
  remove: () => void;
}
export const CHIP_MENU_EVENT = "arcalo:chip-menu";
/** Opens the entry dialog for the booking of a chip (`detail`: entry id and the chip's page). */
export const EDIT_ENTRY_EVENT = "arcalo:edit-entry";

const STATUS_LABEL: Partial<Record<ChipStatus, TKey>> = { deleted: "chip.stateDeleted", copy: "chip.stateCopy", missing: "chip.stateMissing" };

const statusOf = (decorations: readonly Decoration[]): ChipStatus =>
  (decorations.find((d) => (d.spec as { chipStatus?: ChipStatus }).chipStatus)?.spec as { chipStatus?: ChipStatus } | undefined)?.chipStatus ?? "unknown";

// Chips drawn in open editors: drawn again when the language or time tracking changes.
const drawn = new Set<() => void>();
let watching = false;
function watchRedraw() {
  if (watching) return;
  watching = true;
  const all = () => drawn.forEach((f) => f());
  onI18nChange(all);
  let on = timeTrackingEnabled();
  useApp.subscribe(() => {
    if (timeTrackingEnabled() === on) return;
    on = !on;
    all();
  });
}

const CLOCK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>';

const chipDay = (date: string) => (/^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T12:00:00`) : null);

/** Fills the chip's element: hours, reference, Leistungsart, day, text and its state. */
export function renderChip(dom: HTMLElement, a: ChipAttrs, status: ChipStatus, timeOn = timeTrackingEnabled()) {
  const unbooked = timeOn && (status === "deleted" || status === "copy" || status === "missing");
  dom.className = `time-chip${unbooked ? ` time-chip--${status}` : ""}`;
  dom.replaceChildren();
  dom.insertAdjacentHTML("afterbegin", CLOCK_SVG);
  const part = (cls: string, text: string) => {
    const s = document.createElement("span");
    if (cls) s.className = cls;
    s.textContent = text;
    dom.append(s);
    return s;
  };
  part("time-chip-hours", `${chipHours(a.hours)} h`);
  part("time-chip-target", a.target);
  if (a.la) part("time-chip-la", a.la);
  const day = chipDay(a.date);
  if (day) part("time-chip-date", fmtDayMonth(day));
  if (a.text) part("time-chip-text", a.text);
  const label = unbooked ? STATUS_LABEL[status] : undefined;
  if (label) part("time-chip-state", t(label));
  chipTitle(dom, a, status, timeOn);
}

/** The chip's tooltip and accessible name (they follow switching time tracking on and off). */
export function chipTitle(dom: HTMLElement, a: ChipAttrs, status: ChipStatus, timeOn = timeTrackingEnabled()) {
  const unbooked = timeOn && (status === "deleted" || status === "copy" || status === "missing");
  const label = unbooked ? STATUS_LABEL[status] : undefined;
  const day = chipDay(a.date);
  // Time tracking off: a plain chip (neutral look in CSS), nothing about booking.
  const details = [`${chipHours(a.hours)} h`, a.target, a.la, day ? fmtDate(day) : "", a.text].filter(Boolean).join(" · ");
  dom.title = !timeOn ? t("tt.chip") : `${label ? t(label) + " – " : ""}${details}\n${t(unbooked ? "chip.hintUnbooked" : "ed.timeEntry")}`;
  dom.setAttribute("aria-label", `${label ? t(label) + ": " : ""}${details}`);
}

export const TimeEntryChip = Node.create<{ pageId: number | null }>({
  name: "timeEntry",
  group: "inline",
  inline: true,
  atom: true,

  addOptions() {
    return { pageId: null };
  },

  addAttributes() {
    // Copy and paste goes through HTML: every value travels as a data attribute.
    const attr = (name: string, html: string, fallback?: string) => ({
      default: name === "entryId" ? null : "",
      parseHTML: (el: HTMLElement) => el.getAttribute(html) ?? (fallback ? el.getAttribute(fallback) : null) ?? (name === "entryId" ? null : ""),
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] == null || attrs[name] === "" ? {} : { [html]: String(attrs[name]) }),
    });
    return {
      entryId: attr("entryId", "data-entry", "id"),
      hours: attr("hours", "data-hours"),
      target: attr("target", "data-target"),
      text: attr("text", "data-text"),
      la: attr("la", "data-la"),
      date: attr("date", "data-date"),
      state: attr("state", "data-state"),
    };
  },
  parseHTML() {
    return [{ tag: "time-entry" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs as ChipAttrs;
    return ["time-entry", mergeAttributes(HTMLAttributes, { class: "time-chip" }), `${a.hours} h · ${a.target}${a.text ? " · " + a.text : ""}`];
  },
  renderText({ node }) {
    const a = node.attrs as ChipAttrs;
    return `${chipHours(a.hours)} h ${a.target}${a.text ? " " + a.text : ""}`;
  },

  addProseMirrorPlugins() {
    return this.options.pageId != null ? [chipLinkPlugin(this.options.pageId)] : [];
  },

  addKeyboardShortcuts() {
    return {
      // A selected chip: Enter opens its menu (as a click does).
      Enter: ({ editor }) => {
        const sel = editor.state.selection;
        if (!(sel instanceof NodeSelection) || sel.node.type.name !== "timeEntry" || !timeTrackingEnabled()) return false;
        const dom = editor.view.nodeDOM(sel.from);
        if (!(dom instanceof HTMLElement)) return false;
        dom.dispatchEvent(new CustomEvent("chip-open", { detail: { keyboard: true } }));
        return true;
      },
    };
  },

  addNodeView() {
    const pageId = this.options.pageId;
    return ({ node, decorations, editor, getPos }) => {
      let current = node;
      let status = statusOf(decorations as readonly Decoration[]);
      const dom = document.createElement("span");
      dom.contentEditable = "false";
      const draw = () => renderChip(dom, current.attrs as ChipAttrs, status);
      draw();
      watchRedraw();
      drawn.add(draw);
      // The tooltip follows switching time tracking on and off (only the title: replacing the
      // content under the pointer would swallow the click).
      dom.addEventListener("mouseenter", () => chipTitle(dom, current.attrs as ChipAttrs, status));
      const open = (keyboard: boolean) => {
        if (!timeTrackingEnabled()) return;
        const request: ChipMenuRequest = {
          anchor: dom,
          keyboard,
          status,
          attrs: current.attrs as ChipAttrs,
          edit: () => {
            const id = idOf(current);
            if (id != null && pageId != null) window.dispatchEvent(new CustomEvent(EDIT_ENTRY_EVENT, { detail: { id, pageId } }));
          },
          book: () => void bookChip(editor, () => (typeof getPos === "function" ? getPos() : undefined), pageId),
          remove: () => {
            const pos = typeof getPos === "function" ? getPos() : undefined;
            if (pos == null) return;
            editor.chain().focus().deleteRange({ from: pos, to: pos + current.nodeSize }).run();
          },
        };
        window.dispatchEvent(new CustomEvent(CHIP_MENU_EVENT, { detail: request }));
      };
      dom.addEventListener("click", (e) => {
        e.preventDefault();
        open(e.detail === 0);
      });
      dom.addEventListener("chip-open", (e) => open(!!(e as CustomEvent<{ keyboard: boolean }>).detail?.keyboard));
      return {
        dom,
        update(next, decos) {
          if (next.type !== current.type) return false;
          current = next;
          status = statusOf(decos as readonly Decoration[]);
          draw();
          return true;
        },
        // Clicks open the menu; the editor still selects the chip on mousedown.
        stopEvent: () => false,
        ignoreMutation: () => true,
        destroy: () => void drawn.delete(draw),
      };
    };
  },

  markdownTokenizer: {
    name: "timeEntry",
    level: "inline",
    start: (src: string) => src.indexOf("<time-entry"),
    tokenize(src: string) {
      const m = /^<time-entry\s+([^>]*)>([^<]*)<\/time-entry>/.exec(src);
      if (!m) return undefined;
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = unescape(a[2]);
      return { type: "timeEntry", raw: m[0], attrs, text: m[2] };
    },
  },
  parseMarkdown: (token) => ({
    type: "timeEntry",
    attrs: {
      entryId: token.attrs.id || null,
      hours: token.attrs.hours ?? "",
      target: token.attrs.target ?? "",
      text: unescape(token.text ?? ""),
      la: token.attrs.la ?? "",
      date: token.attrs.date ?? "",
      state: token.attrs.state ?? "",
    },
  }),
  renderMarkdown: (node) => chipMarkdown((node.attrs ?? {}) as Partial<ChipAttrs>),
});

/** „Erneut buchen“ / „Buchen“: books the chip's values and links the chip to the new booking. */
async function bookChip(editor: Editor, getPos: () => number | undefined, pageId: number | null) {
  const pos = getPos();
  if (pos == null || pageId == null) return;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "timeEntry") return;
  const a = node.attrs as ChipAttrs;
  const s = useApp.getState();
  try {
    // The chip's earlier booking: a deleted one gives the new booking its Jira worklog back.
    const previous = Number(a.entryId) > 0 ? Number(a.entryId) : null;
    const out = await api.chipBook({ pageId, target: a.target, minutes: chipMinutes(a.hours), leistungsart: a.la || null, date: a.date || null, text: a.text, previous });
    s.bumpEntries();
    s.alerts(out.alerts);
    s.toast({ tone: "success", title: t("ne.booked", { h: chipHours(hoursAttr(out.entry.duration_minutes ?? 0, a.hours)) }), detail: `${out.reference}${out.entry.description ? " · " + out.entry.description : ""}` });
    if (editor.isDestroyed) return;
    // Found again where its view is now (the document may have changed meanwhile).
    const now = getPos();
    const here = now == null ? null : editor.state.doc.nodeAt(now);
    const at =
      now != null && here?.type.name === "timeEntry" && here.attrs.entryId === a.entryId ? { pos: now } : chipsIn(editor.state.doc).find((c) => c.node === node);
    if (!at) return;
    const attrs: ChipAttrs = {
      ...a,
      entryId: out.entry.id,
      hours: hoursAttr(out.entry.duration_minutes ?? 0, a.hours),
      target: out.reference || a.target,
      la: out.entry.leistungsart ?? "",
      date: isoDay(new Date(out.entry.start_time)),
      text: out.entry.description,
      state: "",
    };
    editor.view.dispatch(editor.state.tr.setNodeMarkup(at.pos, undefined, attrs).setMeta("addToHistory", false).setMeta(OWN, true));
  } catch (e) {
    s.error(t("chip.bookFailed"), e);
  }
}
