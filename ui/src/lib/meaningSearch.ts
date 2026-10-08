// Suche nach Bedeutung in the search sidebar and the palette: the exact hits show at once, the
// list with the pages found by meaning replaces them as soon as the query's embedding is there
// (a local model answers in a few milliseconds, a missing one never holds up the exact hits).
// „Nur exakte Treffer“ is one choice for both places, kept per device.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import type { SearchHit } from "./types";

const KEY = "annalo.search.exactOnly";
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
let exactOnly = read();

/** „Nur exakte Treffer“ as stored (the quick search window reads it at each search). */
export const exactOnlyPref = read;

export function setExactOnly(v: boolean) {
  exactOnly = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {
    /* private window: kept for this session */
  }
  for (const l of listeners) l();
}

/** „Nur exakte Treffer“ (shared by the sidebar and the palette). */
export function useExactOnly(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => exactOnly,
  );
}

export type PageHit = Extract<SearchHit, { page_id: number }>;

/** Whether a hit was found by meaning, not by its words. */
export const isSimilar = (h: SearchHit): h is Extract<SearchHit, { kind: "similar" }> => h.kind === "similar";

/**
 * Hits for `query` (`null` while there is none): exact ones first, then the list with meaning
 * hits unless `exact` is set. `meaning` says whether the last answer searched by meaning.
 */
export function useMeaningSearch(query: string, limit: number, opts: { enabled: boolean; exact: boolean; delay: number }) {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [meaning, setMeaning] = useState(false);
  const { enabled, exact, delay } = opts;
  useEffect(() => {
    if (!enabled) {
      setHits(null);
      setMeaning(false);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .search(query, limit)
        .then((h) => {
          if (!alive) return;
          setHits(h);
          setMeaning(false);
          if (exact) return;
          api
            .searchSemantic(query, limit)
            .then((r) => {
              if (!alive || !r.meaning) return;
              setHits(r.hits);
              setMeaning(true);
            })
            .catch(() => {});
        })
        .catch(() => {});
    }, delay);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, limit, enabled, exact, delay]);
  return { hits, meaning };
}
