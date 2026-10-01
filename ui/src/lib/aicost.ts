// Monthly AI cost limit (Settings → KI): a warning from 80 %, and at 100 % the shell refuses
// requests until the user sends one anyway.

import { errorText } from "./api";
import { useApp } from "../store/app";
import { t } from "./i18n";

/** Starts of the shell's error when the limit is reached, in both languages (see src-tauri/src/prefs.rs). */
export const COST_LIMIT_PREFIXES = ["KI-Kostenlimit erreicht", "AI cost limit reached"];

export const isCostLimit = (e: unknown) => COST_LIMIT_PREFIXES.some((p) => errorText(e).includes(p));

/** Asks whether to send despite the limit. */
export function confirmOverLimit(e: unknown): Promise<boolean> {
  return useApp.getState().confirm({
    title: t("ai.cost.reachedMonthly"),
    message: t("ai.cost.ask", { msg: errorText(e) }),
    confirmLabel: t("ai.cost.sendAnyway"),
  });
}

let warnedAt = 0;
/** Toast once per 10 % step above 80 % of the limit. */
export function warnCost(fraction: number | null | undefined) {
  if (fraction == null || fraction < 0.8) return;
  const step = Math.floor(fraction * 10);
  if (step <= warnedAt) return;
  warnedAt = step;
  useApp.getState().toast({
    tone: fraction >= 1 ? "danger" : "warning",
    title: fraction >= 1 ? t("ai.cost.reached") : t("ai.cost.used", { percent: Math.round(fraction * 100) }),
    detail: t("ai.cost.where"),
  });
}

/** Runs `send`; when the limit blocks it, asks and runs it again with the override. */
export async function withCostLimit<T>(send: (override: boolean) => Promise<T>): Promise<T> {
  try {
    return await send(false);
  } catch (e) {
    if (!isCostLimit(e) || !(await confirmOverLimit(e))) throw e;
    return send(true);
  }
}

/** Whether answers are shown while they stream (Settings → KI). */
export const streamingOn = () => useApp.getState().settings?.settings.ai?.streaming !== false;
