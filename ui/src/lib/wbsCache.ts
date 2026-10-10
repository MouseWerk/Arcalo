// The WBS (projects, Netzpläne, Vorgänge) and the Leistungsarten, read once and shared by every view
// and editor that shows them until they change: the backend reports each change (`data://wbs`,
// whoever made it), which bumps `wbsVersion`. Before, each page switch read both again for the
// page's properties and chips, queued behind the page's other reads.

import { api } from "./api";
import { useApp } from "../store/app";
import type { ProjectTree } from "./types";

function versioned<T>(load: () => Promise<T>) {
  let cache: { version: number; data: Promise<T> } | null = null;
  return {
    get(): Promise<T> {
      const version = useApp.getState().wbsVersion;
      if (cache?.version === version) return cache.data;
      const entry = { version, data: load() };
      cache = entry;
      // A failed read is tried again next time.
      entry.data.catch(() => cache === entry && (cache = null));
      return entry.data;
    },
    reset() {
      cache = null;
    },
  };
}

const tree = versioned<ProjectTree[]>(() => api.wbs());
const las = versioned<[string, string][]>(() => api.leistungsarten());

/** Projects → Netzpläne → Vorgänge, as of the current `wbsVersion`. */
export const wbsTree = () => tree.get();
/** The Leistungsarten (code, description), as of the current `wbsVersion`. */
export const leistungsarten = () => las.get();

/** Drops both, e.g. when the quick-capture window (with its own store) is shown again. */
export function resetWbsCache() {
  tree.reset();
  las.reset();
}
