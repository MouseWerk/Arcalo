// Data for the `/zeit` autocomplete: WBS options with remaining plan hours,
// recently booked references and Leistungsarten, cached until WBS or entries change.

import { Tag, Timer, History } from "lucide-react";
import { api } from "../lib/api";
import { h2 } from "../lib/format";
import { useApp } from "../store/app";
import { rankLeistungsarten, rankRefs, recentRefs, refOptions, remainingHint, type RefOption } from "./zeit-suggest";
import type { ZeitSuggestItem } from "./extensions";

interface ZeitData {
  options: RefOption[];
  recent: string[];
  las: [string, string][];
}

const RECENT_DAYS = 60;
const MAX_ITEMS = 30;

let cache: { key: string; data: Promise<ZeitData> } | null = null;

function load(): Promise<ZeitData> {
  const { wbsVersion, entriesVersion } = useApp.getState();
  const key = `${wbsVersion}:${entriesVersion}`;
  if (cache?.key === key) return cache.data;
  const data = (async () => {
    const since = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString();
    const [wbs, las, entries, budgets] = await Promise.all([
      api.wbs(),
      api.leistungsarten().catch(() => []),
      api.entries(since).catch(() => []),
      api.budgetsAll().catch(() => []),
    ]);
    const booked = new Map<string, number>();
    for (const b of budgets) booked.set(b.label.toLowerCase(), b.booked_hours);
    return { options: refOptions(wbs, (ref) => booked.get(ref.toLowerCase()) ?? null), recent: recentRefs(entries), las };
  })();
  cache = { key, data };
  // A failed load is retried next time.
  data.catch(() => cache?.data === data && (cache = null));
  return data;
}

/** Drops the cached data, e.g. when the quick-capture window (with its own store) is shown again. */
export function resetZeitCache() {
  cache = null;
}

const icon = (C: typeof Timer) => <C size={15} strokeWidth={1.75} />;

export async function zeitRefItems(query: string): Promise<ZeitSuggestItem[]> {
  const { options, recent } = await load();
  const recentSet = new Set(recent.map((r) => r.toLowerCase()));
  return rankRefs(options, query, recent)
    .slice(0, MAX_ITEMS)
    .map((o) => {
      const isRecent = recentSet.has(o.ref.toLowerCase());
      return {
        id: o.ref,
        title: o.title ? `${o.ref} · ${o.title}` : o.ref,
        subtitle: isRecent ? o.project : undefined,
        hint: remainingHint(o, h2),
        section: isRecent ? "Zuletzt gebucht" : o.project,
        icon: icon(isRecent ? History : Timer),
        insert: o.ref,
      };
    });
}

export async function zeitLaItems(query: string): Promise<ZeitSuggestItem[]> {
  const { las } = await load();
  return rankLeistungsarten(las, query).map(([code, desc]) => ({
    id: `la-${code}`,
    title: `#${code}`,
    subtitle: desc || undefined,
    section: "Leistungsart",
    icon: icon(Tag),
    insert: `#${code}`,
  }));
}
