// Loads what the assistant's suggestions are built from (tasks, this week's bookings, budget
// warnings, the open page's Vorgang). Reloaded when entries or the open page change, and only
// while the suggestions are shown: a hidden assistant does no work on every page switch.

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { addDays, isoDay, weekStart } from "../lib/format";
import { weekBars } from "../lib/dashboard";
import { buildSuggestions, type Suggestion } from "../lib/suggestions";
import { useApp } from "../store/app";
import type { PageDoc } from "../lib/types";

const FALLBACK: Suggestion[] = buildSuggestions({ now: new Date(), page: null, overdue: 0, dueToday: 0, openTasks: 0, gapDays: [], budget: null, hasBookings: false });

/** Pause after a page change before loading (a tab switch changes the page twice). */
const SETTLE_MS = 250;

export function useSuggestions(page: PageDoc | null, shown = true): Suggestion[] {
  const entriesVersion = useApp((s) => s.entriesVersion);
  const settings = useApp((s) => s.settings?.settings);
  const [list, setList] = useState<Suggestion[]>(FALLBACK);
  const pageId = page?.id ?? null;
  const pageTitle = page?.title ?? null;
  useEffect(() => {
    if (!shown) return;
    let alive = true;
    const timer = window.setTimeout(async () => {
      if (!alive) return;
      const now = new Date();
      const today = isoDay(now);
      const monday = weekStart(now);
      const [open, days, tree, work, pageTasks] = await Promise.all([
        api.tasks({ status: "open" }).catch(() => []),
        api.dailyOverview(isoDay(monday), isoDay(addDays(monday, 6))).catch(() => []),
        api.wbs().catch(() => []),
        pageId != null ? api.pageWork(pageId).catch(() => null) : Promise.resolve(null),
        pageId != null ? api.tasks({ status: "open", page_id: pageId }).catch(() => []) : Promise.resolve([]),
      ]);
      const week = weekBars(days, monday, settings?.daily_target_hours ?? 8, settings?.workdays ?? [1, 2, 3, 4, 5], now);
      // The most critical budget warning, by name.
      const ids = tree.flatMap((p) => p.netzplaene.map((n) => n.id)).slice(0, 12);
      const budgets = (await Promise.all(ids.map((id) => api.budget(id).catch(() => [])))).flat();
      const rank = { critical: 2, warning: 1, ok: 0 } as Record<string, number>;
      const worst = budgets.filter((b) => b.level !== "ok").sort((a, b) => (rank[b.level] ?? 0) - (rank[a.level] ?? 0) || b.consumed - a.consumed)[0];
      const next = buildSuggestions({
        now,
        page: pageTitle != null ? { title: pageTitle, openTasks: pageTasks.length, reference: work?.reference ?? null } : null,
        overdue: open.filter((t) => t.due && t.due < today).length,
        dueToday: open.filter((t) => t.due === today).length,
        openTasks: open.length,
        gapDays: week.bars.filter((b) => b.gap > 0).map((b) => b.label),
        budget: worst?.label ?? null,
        hasBookings: week.bookedMinutes > 0,
      });
      if (alive) setList(next);
    }, SETTLE_MS);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [shown, pageId, pageTitle, entriesVersion, settings?.daily_target_hours, settings?.workdays]);
  return list;
}
