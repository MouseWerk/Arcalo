/** Display preferences (Settings → Zeiterfassung, Sprache & Format), set by `applyPrefs`. */
export interface FormatPrefs {
  /** 1 = weeks start on Monday, 0 = on Sunday. */
  weekStartsOn: 0 | 1;
  hours: "decimal" | "clock";
  dateFormat: "de" | "iso";
  lang: "de" | "en";
}
const prefs: FormatPrefs = { weekStartsOn: 1, hours: "decimal", dateFormat: "de", lang: "de" };
export const formatPrefs = (): Readonly<FormatPrefs> => prefs;
export function setFormatPrefs(p: Partial<FormatPrefs>) {
  Object.assign(prefs, p);
}
/** Locale for dates (numbers stay German: decimal comma). */
const dateLocale = () => (prefs.lang === "en" ? "en-GB" : "de-DE");

const nf1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("de-DE", { maximumFractionDigits: 0 });

export const h1 = (x: number) => nf1.format(x);
export const h2 = (x: number) => nf2.format(x);
export const int = (x: number) => nf0.format(x);
/** USD cost in German notation: 0,0024 $ */
export const usd = (x: number) => x.toLocaleString("de-DE", { style: "currency", currency: "USD", minimumFractionDigits: x < 0.1 ? 4 : 2, maximumFractionDigits: x < 0.1 ? 4 : 2 });
export const hoursFromMinutes = (m: number | null | undefined) => nf2.format((m ?? 0) / 60);

/** Hours as set in the settings: "1,50" or "1:30". */
export function fmtHours(hours: number, style = prefs.hours): string {
  if (style === "clock") {
    const total = Math.round(hours * 60);
    const sign = total < 0 ? "−" : "";
    const m = Math.abs(total);
    return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  }
  return nf2.format(hours);
}
/** Minutes shown as hours in the configured style. */
export const fmtMinutes = (m: number | null | undefined, style = prefs.hours) => fmtHours((m ?? 0) / 60, style);

/** A day in the configured format: "24.09.2026" or "2026-09-24". */
export function fmtDate(d: Date | string, style = prefs.dateFormat): string {
  const x = typeof d === "string" ? new Date(d) : d;
  if (style === "iso") return isoDay(x);
  return `${String(x.getDate()).padStart(2, "0")}.${String(x.getMonth() + 1).padStart(2, "0")}.${x.getFullYear()}`;
}

/** A typed day: „1.10.2026“, „01.10.26“, „1.10.“ (this year) or „2026-10-01“ as YYYY-MM-DD; null when it is no date. */
export function parseDayInput(text: string, now = new Date()): string | null {
  const t = text.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(t);
  if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (de) [y, m, d] = [de[3] ? (de[3].length === 2 ? 2000 + +de[3] : +de[3]) : now.getFullYear(), +de[2], +de[1]];
  else return null;
  const x = new Date(y, m - 1, d);
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? isoDay(x) : null;
}

/** A typed time of day: „9“, „930“, „9:30“, „9.30“ or „09:30“ as HH:MM (24 h); null when it is no time. */
export function parseTimeInput(text: string): string | null {
  const m = /^(\d{1,2})(?:[:.]?(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const h = +m[1];
  const min = m[2] ? +m[2] : 0;
  return h < 24 && min < 60 ? `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` : null;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export const isoWeekday = (d: Date) => ((d.getDay() + 6) % 7) + 1;

/** Two-letter weekday names in display order (week start from the settings). */
export function weekdayLabels(startsOn: 0 | 1 = prefs.weekStartsOn, lang = prefs.lang): string[] {
  const names = lang === "en" ? ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] : ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
  return startsOn === 1 ? names : [names[6], ...names.slice(0, 6)];
}
/** Short weekday name of a date. */
export const weekdayShort = (d: Date, lang = prefs.lang) => weekdayLabels(1, lang)[isoWeekday(d) - 1];

/** "1:30" style duration for timers. */
export function clock(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

export const dateShort = (iso: string) =>
  prefs.dateFormat === "iso"
    ? `${weekdayShort(new Date(iso))} ${isoDay(new Date(iso))}`
    : new Date(iso).toLocaleDateString(dateLocale(), { weekday: "short", day: "2-digit", month: "2-digit" });
export const dateLong = (iso: string) =>
  prefs.dateFormat === "iso"
    ? `${new Date(iso).toLocaleDateString(dateLocale(), { weekday: "long" })}, ${isoDay(new Date(iso))}`
    : new Date(iso).toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
export const time = (iso: string) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

/**
 * Main labels of the version list: the time, with seconds when two versions share a minute,
 * and the date for versions from other days ("21.09., 14:03").
 */
export function versionTimes(isos: string[], now = new Date()): string[] {
  const pad = (n: number) => String(n).padStart(2, "0");
  const dates = isos.map((iso) => new Date(iso));
  const minute = (d: Date) => `${d.toDateString()} ${d.getHours()}:${d.getMinutes()}`;
  const count = new Map<string, number>();
  for (const d of dates) count.set(minute(d), (count.get(minute(d)) ?? 0) + 1);
  return dates.map((d) => {
    let t = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if ((count.get(minute(d)) ?? 0) > 1) t += `:${pad(d.getSeconds())}`;
    return d.toDateString() === now.toDateString() ? t : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}., ${t}`;
  });
}

export function relative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "gerade eben";
  if (diff < 3600) return `vor ${Math.floor(diff / 60)} Min.`;
  if (diff < 86400) return `vor ${Math.floor(diff / 3600)} Std.`;
  if (diff < 7 * 86400) return `vor ${Math.floor(diff / 86400)} Tagen`;
  if (prefs.dateFormat === "iso") return isoDay(new Date(iso));
  return new Date(iso).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

/** File size, e.g. "812 KB" or "3,4 MB". */
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${nf0.format(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${nf1.format(bytes / 1024 ** 2)} MB`;
  return `${nf1.format(bytes / 1024 ** 3)} GB`;
}

/** Local date as YYYY-MM-DD. */
export function isoDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 00:00 local of the first day (Monday, or Sunday per the settings) of the week containing `d`. */
export function weekStart(d: Date, startsOn: 0 | 1 = prefs.weekStartsOn) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  const day = (x.getDay() + 7 - startsOn) % 7;
  x.setDate(x.getDate() - day);
  return x;
}
export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export function isoWeek(d: Date) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y.getTime()) / 86400000 + 1) / 7);
}

/** Parses "1:30", "1,5", "90m", "2h" into minutes. */
export function parseDurationInput(s: string): number | null {
  const v = s.trim().toLowerCase().replace(",", ".");
  let m: RegExpMatchArray | null;
  if ((m = v.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*m(in)?$/))) return Math.round(+m[1]);
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*h?$/))) return Math.round(+m[1] * 60);
  return null;
}

/** Days/hours without a trailing ",0" for whole numbers. */
export const compact = (x: number) => (Number.isInteger(x) ? String(x) : nf1.format(x));

/** Parses German numbers: "1.200,5" → 1200,5, "1,5" → 1,5; without a comma a single dot is the decimal point. Null if invalid. */
export function parseGermanNumber(s: string): number | null {
  let v = s.trim().replace(/[\s ']/g, "");
  if (v.includes(",")) {
    if (v.indexOf(",") !== v.lastIndexOf(",")) return null;
    if (v.includes(".") && !/^-?\d{1,3}(\.\d{3})*,\d*$/.test(v)) return null;
    v = v.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(v)) {
    v = v.replace(/\./g, "");
  }
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** „1 Seite, 2 Ordner, 3 Bilder, 1 Datei übersprungen“ */
export function importSummary(r: { pages: number; folders: number; attachments: number; skipped: number }) {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const parts = [n(r.pages, "Seite", "Seiten"), n(r.folders, "Ordner", "Ordner")];
  if (r.attachments) parts.push(n(r.attachments, "Bild", "Bilder"));
  if (r.skipped) parts.push(`${n(r.skipped, "Datei", "Dateien")} übersprungen`);
  return parts.join(", ");
}
