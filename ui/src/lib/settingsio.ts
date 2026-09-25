// Settings import: validates an exported settings file against the current settings (same
// keys, same types), and lists what an import would change.

import type { Settings } from "./types";
import { t } from "./i18n";

export const EXPORT_FORMAT = "annalo-settings";
export const EXPORT_VERSION = 1;

/** Objects whose keys are data (user-chosen), not settings names. */
const RECORDS = new Set(["jira_issue_map", "keymap", "network.pac_results", "time.default_leistungsart"]);

export interface ImportResult {
  settings: Settings | null;
  /** Fields that were skipped (unknown or with the wrong type). */
  warnings: string[];
  error: string | null;
}

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function mergeValue(path: string, cur: unknown, inc: unknown, warnings: string[]): unknown {
  const ck = kind(cur);
  const ik = kind(inc);
  if (RECORDS.has(path)) {
    if (ik !== "object") {
      warnings.push(t("sio.object", { path }));
      return cur;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(inc as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else warnings.push(t("sio.text", { path: `${path}.${k}` }));
    }
    return out;
  }
  if (ck === "object") {
    if (ik !== "object") {
      warnings.push(t("sio.object", { path }));
      return cur;
    }
    const out: Record<string, unknown> = { ...(cur as Record<string, unknown>) };
    for (const [k, v] of Object.entries(inc as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k;
      if (!(k in out)) {
        warnings.push(t("sio.unknown", { path: p }));
        continue;
      }
      out[k] = mergeValue(p, out[k], v, warnings);
    }
    return out;
  }
  // Optional values (null now) take any value of a plain type or null.
  if (ck === "null") {
    if (["string", "number", "boolean", "null", "array", "object"].includes(ik)) return inc;
    warnings.push(t("sio.invalid", { path }));
    return cur;
  }
  if (inc === null) {
    // Nullable fields that are set now (reminder_time, embedding_model, …) may be switched off.
    if (NULLABLE.has(path)) return null;
    warnings.push(t("sio.missing", { path }));
    return cur;
  }
  if (ck === "array") {
    if (ik !== "array") {
      warnings.push(t("sio.list", { path }));
      return cur;
    }
    const sample = (cur as unknown[])[0];
    if (sample !== undefined && (inc as unknown[]).some((x) => kind(x) !== kind(sample))) {
      warnings.push(t("sio.listType", { path }));
      return cur;
    }
    return inc;
  }
  if (ck !== ik) {
    warnings.push(ck === "number" ? t("sio.number", { path }) : ck === "boolean" ? t("sio.boolean", { path }) : t("sio.text", { path }));
    return cur;
  }
  if (ik === "number" && !Number.isFinite(inc as number)) {
    warnings.push(t("sio.nan", { path }));
    return cur;
  }
  return inc;
}

/** Fields that may be null (None in Rust). */
const NULLABLE = new Set([
  "embedding_model",
  "pernr",
  "backup_dir",
  "markdown_mirror_dir",
  "daily_template",
  "reminder_time",
  "palette_shortcut",
  "network.extra_ca_path",
  "editor.default_icon",
  "ai.max_tokens",
  "ai.inline_presets",
  "ai.meeting_template",
  "ai.monthly_cost_limit_usd",
]);

/**
 * Parses an exported file (`{ format, version, settings }`, or a bare settings object) and
 * merges it into `current`: unknown keys and values of the wrong type are skipped with a
 * warning; the result always has the full, current shape.
 */
export function parseSettingsImport(text: string, current: Settings): ImportResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { settings: null, warnings: [], error: t("sio.notJson") };
  }
  if (kind(raw) !== "object") return { settings: null, warnings: [], error: t("sio.noSettings") };
  let obj = raw as Record<string, unknown>;
  if ("format" in obj || "settings" in obj) {
    if (obj.format !== EXPORT_FORMAT) return { settings: null, warnings: [], error: t("sio.notAnnalo") };
    if (typeof obj.version === "number" && obj.version > EXPORT_VERSION) return { settings: null, warnings: [], error: t("sio.newer") };
    if (kind(obj.settings) !== "object") return { settings: null, warnings: [], error: t("sio.noSettings") };
    obj = obj.settings as Record<string, unknown>;
  }
  const known = Object.keys(obj).filter((k) => k in current);
  if (known.length === 0) return { settings: null, warnings: [], error: t("sio.noKnown") };
  const warnings: string[] = [];
  const settings = mergeValue("", current, obj, warnings) as Settings;
  return { settings, warnings, error: null };
}

export interface Change {
  path: string;
  from: unknown;
  to: unknown;
}

/** Leaf differences between two settings objects (lists and records compared as a whole per key). */
export function settingsDiff(a: unknown, b: unknown, path = ""): Change[] {
  if (kind(a) === "object" && kind(b) === "object" && !RECORDS.has(path)) {
    const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
    return [...keys].sort().flatMap((k) => settingsDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], path ? `${path}.${k}` : k));
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ path, from: a, to: b }];
}

/** Short display of a value in the diff preview. */
export function showValue(v: unknown): string {
  if (v === null || v === undefined) return "–";
  if (typeof v === "boolean") return v ? "an" : "aus";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}
