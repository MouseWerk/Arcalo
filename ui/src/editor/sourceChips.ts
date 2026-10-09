// `/zeit` chips in the Markdown source view (1.13). Removing a booked chip's text removes its
// booking like the rich editor does (the same undo toast, see timeChip.ts); the text coming back
// (undo in the text box, „Rückgängig“, paste after cut) keeps or restores it. Removals are found
// from the source diff when the view saves: chip ids present before and gone after.

import { useEffect, useRef } from "react";
import { api } from "../lib/api";
import type { ChipLink, TimeEntryRow } from "../lib/types";
import { timeTrackingEnabled } from "../lib/timetracking";
import { useApp } from "../store/app";
import { merge3 } from "../lib/merge3";
import { flushAllEditors } from "./saves";
import { chipAwaited, chipRemoved, chipReturned, chipsPresent, chipStatuses, type ChipAttrs } from "./timeChip";

/** A chip in Markdown: where it is (`start`..`end`), its id and attributes. */
export interface SourceChip {
  id: number | null;
  start: number;
  end: number;
  attrs: Partial<ChipAttrs>;
}

const entityMap: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", "#39": "'" };
const unescape = (s: string) => s.replace(/&(quot|amp|lt|gt|#39);/g, (_e, n: string) => entityMap[n]);

/** The chips of a note's Markdown, in order (read as the backend reads them, `chips::chips`). */
export function sourceChips(md: string): SourceChip[] {
  const out: SourceChip[] = [];
  if (!md.includes("<time-entry")) return out;
  const re = /<time-entry(\s[^>]*)?>([^<]*)<\/time-entry>/g;
  for (let m = re.exec(md); m; m = re.exec(md)) {
    const raw: Record<string, string> = {};
    for (const a of (m[1] ?? "").matchAll(/([A-Za-z0-9_]+)="([^"]*)"/g)) raw[a[1]] = unescape(a[2]);
    const n = Number(raw.id);
    out.push({
      id: Number.isInteger(n) && n > 0 ? n : null,
      start: m.index,
      end: m.index + m[0].length,
      attrs: { entryId: raw.id ?? null, hours: raw.hours ?? "", target: raw.target ?? "", la: raw.la ?? "", date: raw.date ?? "", state: raw.state ?? "", text: unescape(m[2]) },
    });
  }
  return out;
}

/** Ids of the chips in `md`. */
export const sourceChipIds = (md: string) => new Set(sourceChips(md).flatMap((c) => (c.id != null ? [c.id] : [])));

/**
 * What an edit from `before` to `after` did to the chips: booked chips (as `links` says) whose
 * id is gone, and ids that came back.
 */
export function chipDiff(before: string, after: string, links: ReadonlyMap<number, ChipLink>) {
  const old = sourceChips(before);
  const now = sourceChipIds(after);
  const statuses = chipStatuses(old.map((c) => ({ id: c.id, state: c.attrs.state })), links);
  const removed = old.filter((c, i) => statuses[i] === "linked" && c.id != null && !now.has(c.id));
  const had = new Set(old.map((c) => c.id));
  const appeared = [...now].filter((id) => !had.has(id));
  return { removed, appeared };
}

/** `md` with the first booked chip of `id` pointing at booking `to` instead. */
export function retargetChip(md: string, id: number, to: number): string {
  const c = sourceChips(md).find((x) => x.id === id && x.attrs.state !== "deleted");
  if (!c) return md;
  const head = md.slice(c.start, c.end).replace(/^(<time-entry\s[^>]*?\bid=")[^"]*"/, `$1${to}"`);
  return md.slice(0, c.start) + head + md.slice(c.end);
}

/** Where `at` in `a` is in `b` (one changed stretch between them; see `mapCaret`). */
type MapPos = (a: string, b: string, at: number) => number;

/**
 * Keeps the chips of the source view of page `pageId` linked to their bookings. `text()` is
 * the view's current text, `edit(next)` replaces it as an edit of the user (saved).
 * Call `checked` with the text being saved, `absorbed` when text of another pane came in.
 */
export function useSourceChips(pageId: number, text: () => string, edit: (next: string) => void, mapPos: MapPos) {
  const owner = useRef({}).current;
  const links = useRef(new Map<number, ChipLink>());
  const rows = useRef(new Map<number, TimeEntryRow>());
  // The text the chips were last compared with.
  const last = useRef(text());
  const timer = useRef<number | undefined>(undefined);
  const alive = useRef(true);
  const io = useRef({ text, edit, mapPos });
  io.current = { text, edit, mapPos };

  // Set while a refresh is due or asked: `links` may not know the latest bookings yet (a booking
  // restored a moment ago reads as missing until then).
  const stale = useRef(false);
  const generation = useRef(0);

  /** The links and booking rows of the chips in `texts` (an id's first chip is asked for). */
  const statesOf = async (texts: string[], flush: boolean) => {
    const seen = new Set<number>();
    const chips = texts
      .flatMap((md) => sourceChips(md))
      .filter((c) => c.id != null && c.attrs.state !== "deleted" && !seen.has(c.id) && (seen.add(c.id), true))
      .map((c) => ({ id: c.id!, target: String(c.attrs.target ?? "") }));
    if (!chips.length) return { links: new Map<number, ChipLink>(), rows: new Map<number, TimeEntryRow>() };
    // A chip pasted after a cut in another note: that note is saved first (see timeChip.ts).
    if (flush) await flushAllEditors().catch(() => {});
    const states = await api.chipStates(pageId, chips);
    return {
      links: new Map(states.map((x) => [x.id, x.link] as const)),
      rows: new Map(states.filter((x) => x.row).map((x) => [x.id, x.row!] as const)),
    };
  };

  const refresh = (flush = false) => {
    if (!timeTrackingEnabled()) return;
    window.clearTimeout(timer.current);
    const gen = ++generation.current;
    stale.current = true;
    timer.current = window.setTimeout(async () => {
      try {
        // The text compared last too: a chip removed in the text box but not saved yet stays
        // known, else the save after this refresh would not see its removal.
        const next = await statesOf([io.current.text(), last.current], flush);
        if (!alive.current || gen !== generation.current) return;
        links.current = next.links;
        rows.current = next.rows;
        stale.current = false;
      } catch {
        /* asked again at the next change */
      }
    }, 250);
  };

  useEffect(() => {
    alive.current = true;
    refresh();
    let version = useApp.getState().entriesVersion;
    const unsub = useApp.subscribe((st) => {
      if (st.entriesVersion === version) return;
      version = st.entriesVersion;
      refresh();
    });
    return () => {
      alive.current = false;
      window.clearTimeout(timer.current);
      unsub();
      chipsPresent(owner, null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  return {
    /** The text box shows `md` now (typed, merged, reloaded). */
    shown(md: string) {
      chipsPresent(owner, sourceChipIds(md), pageId);
    },
    /**
     * Text of another pane came in (`theirs`, changed from `base`): its chip changes are not
     * ours to act on (that pane did), so they count as compared already.
     */
    absorbed(base: string, theirs: string) {
      last.current = last.current === base ? theirs : merge3(base, last.current, theirs);
      refresh();
    },
    /** `md` is being saved: what the user's edits since the last save did to the chips. */
    checked(md: string) {
      const before = last.current;
      last.current = md;
      if (before === md || !timeTrackingEnabled()) return;
      const remove = (known: ReadonlyMap<number, ChipLink>, booked: ReadonlyMap<number, TimeEntryRow>) => {
        for (const c of chipDiff(before, md, known).removed) {
          const chip = before.slice(c.start, c.end);
          const at = io.current.mapPos(before, md, c.start);
          const base = md;
          chipRemoved(c.id!, c.attrs, booked.get(c.id!), () => {
            if (!alive.current) return;
            const cur = io.current.text();
            if (sourceChipIds(cur).has(c.id!)) return;
            const pos = Math.min(io.current.mapPos(base, cur, at), cur.length);
            io.current.edit(cur.slice(0, pos) + chip + cur.slice(pos));
          }, pageId);
        }
      };
      const { removed, appeared } = chipDiff(before, md, links.current);
      // The links may be behind (a refresh is due): the chips of `before` are asked for first,
      // else a chip cut right after its booking came back would keep a deleted-looking link.
      const gone = sourceChips(before).some((c) => c.id != null && !sourceChipIds(md).has(c.id));
      if (stale.current && gone)
        void statesOf([before], false).then(
          (s) => alive.current && remove(s.links, s.rows),
          () => alive.current && remove(links.current, rows.current),
        );
      else remove(links.current, rows.current);
      const back = appeared.filter(chipAwaited);
      for (const id of back)
        void chipReturned(id, (to) => {
          if (alive.current) io.current.edit(retargetChip(io.current.text(), id, to));
        });
      if (removed.length || appeared.length) refresh(back.length > 0 || appeared.length > 0);
    },
  };
}
