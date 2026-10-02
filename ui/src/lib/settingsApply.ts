// Settings apply at once: every change is saved right away (typing is saved once it pauses),
// with an „Rückgängig“ toast per change. These are the pure parts: which keys a change
// touched, what restores them, which changes count as destructive (a longer undo window), and
// the checks of fields that apply on blur or Enter.

import type { Settings } from "./types";

/** Top-level keys whose values differ between `a` and `b`. */
export function changedKeys(a: Settings, b: Settings): (keyof Settings)[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Settings)[]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

/** The values of `keys` in `s` (a patch that restores them). */
export function pick(s: Settings, keys: readonly (keyof Settings)[]): Partial<Settings> {
  const out: Partial<Settings> = {};
  for (const k of keys) (out as Record<string, unknown>)[k] = structuredClone(s[k]);
  return out;
}

/** One change for the undo toast: keystrokes in the same field within `gap` ms are one. */
export interface Burst {
  id: number;
  keys: string;
  /** The settings before the change. */
  before: Settings;
  /** Last edit (ms). */
  at: number;
  /** Every key the change touched. */
  touched: Set<keyof Settings>;
}

export const BURST_GAP = 1500;

/** The burst `patch` belongs to: `prev` when it continues it, else a new one from `before`. */
export function continueBurst(prev: Burst | null, patch: Partial<Settings>, before: Settings, now: number, nextId: number): Burst {
  const keys = Object.keys(patch).sort().join(",");
  if (prev && prev.keys === keys && now - prev.at <= BURST_GAP) {
    prev.at = now;
    return prev;
  }
  return { id: nextId, keys, before, at: now, touched: new Set(Object.keys(patch) as (keyof Settings)[]) };
}

/**
 * Changes that take something away (switching time tracking or the Git sync off, removing an AI
 * provider or a backup target, resetting a section): they still apply at once, with a longer
 * time to undo them.
 */
export function isDestructive(before: Settings, after: Settings): boolean {
  if (before.time?.enabled && after.time && !after.time.enabled) return true;
  if (before.git_sync?.enabled && after.git_sync && !after.git_sync.enabled) return true;
  if ((after.providers?.length ?? 0) < (before.providers?.length ?? 0)) return true;
  const targets = (s: Settings) => s.backup_targets?.destinations?.length ?? 0;
  if (targets(after) < targets(before)) return true;
  if (before.markdown_mirror && after.markdown_mirror === false) return true;
  return false;
}

/**
 * The part of the settings that cannot be stored yet because a field it needs is still empty
 * (a proxy profile in mode manual without an address, or PAC without its script; a filing rule, a price
 * row, an AI preset or a Jira search not filled in yet, which the core would drop): the form shows it, its save waits for the field.
 */
export function waitsForField(s: Settings): "network" | "filing" | "prices" | "ai" | "jira" | null {
  for (const n of s.network?.profiles ?? []) {
    if (n.mode === "manual" && ![n.http_proxy, n.https_proxy, n.socks_proxy].some((x) => x?.trim())) return "network";
    if (n.mode === "pac" && !n.pac_url?.trim()) return "network";
  }
  if (s.filing?.rules?.some((r) => !r.key?.trim().replace(/^#+/, "") || !r.folder?.trim())) return "filing";
  // A new row of the price table, an inline AI preset or a saved Jira search still being filled in.
  if (s.prices?.some((r) => !r.model?.trim())) return "prices";
  if (s.ai?.inline_presets?.some((p) => !p.label?.trim() || !p.instruction?.trim())) return "ai";
  if (s.jira?.queries?.some((q) => !q.jql?.trim())) return "jira";
  return null;
}

/** Milliseconds an undo toast stays: longer for destructive changes. */
export const undoTimeout = (destructive: boolean) => (destructive ? 15000 : 7000);

export type FieldError = "url" | "time" | "number" | null;

/** An address with `http(s)://` (or a host that gets it), or empty when allowed. */
export function checkUrl(v: string, opts: { empty?: boolean; schemes?: string[] } = {}): FieldError {
  const s = v.trim();
  if (!s) return opts.empty === false ? "url" : null;
  const schemes = opts.schemes ?? ["http", "https"];
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/\s?#]+)(.*)$/i.exec(s);
  if (!m) return "url";
  if (!schemes.includes(m[1].toLowerCase())) return "url";
  const host = m[2].replace(/^[^@]*@/, "");
  if (!/^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(:\d{1,5})?$/i.test(host)) return "url";
  if (/\s/.test(m[3])) return "url";
  return null;
}

/** A proxy: `host:port` or an address with one of `schemes`; empty is allowed (no proxy). */
export function checkProxy(v: string, schemes = ["http", "https"]): FieldError {
  const s = v.trim();
  if (!s) return null;
  if (s.includes("://")) return checkUrl(s, { schemes });
  return /^[a-z0-9.-]+(:\d{1,5})?$/i.test(s) ? null : "url";
}

/** `HH:MM` (24 hours). */
export function checkTime(v: string): FieldError {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? null : "time";
}

// ------------------------------------------------------------------ menu

/** Groups of the settings menu that are collapsed (kept per viewer in this browser storage). */
const COLLAPSED_KEY = "annalo.settings.navCollapsed";

export function loadCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const v: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveCollapsed(c: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...c]));
  } catch {
    // Storage blocked: the menu just forgets it.
  }
}

/** `c` with `group` toggled. */
export function toggled(c: Set<string>, group: string): Set<string> {
  const next = new Set(c);
  if (next.has(group)) next.delete(group);
  else next.add(group);
  return next;
}
