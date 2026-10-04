import { t } from "./i18n";

/**
 * Display preferences (Settings → Zeiterfassung, Sprache & Format), set by `applyPrefs`. Names
 * of days and months follow the display language (`lang`); the order of day, month and year
 * (`dateFormat`) and the decimal separator (`numberFormat`) are regional settings of their own.
 */
export interface FormatPrefs {
  /** 1 = weeks start on Monday, 0 = on Sunday. */
  weekStartsOn: 0 | 1;
  hours: "decimal" | "clock";
  /** 24.09.2026, 2026-09-24, 24/09/2026 or 09/24/2026. */
  dateFormat: "de" | "iso" | "en-gb" | "en-us";
  /** 1.234,5 (comma), 1,234.5 (point) or by the display language (auto: German comma, English point). */
  numberFormat: "auto" | "comma" | "point";
  lang: "de" | "en";
}
const prefs: FormatPrefs = { weekStartsOn: 1, hours: "decimal", dateFormat: "de", numberFormat: "auto", lang: "en" };
export const formatPrefs = (): Readonly<FormatPrefs> => prefs;
export function setFormatPrefs(p: Partial<FormatPrefs>) {
  Object.assign(prefs, p);
}

/** Locale for day and month names: the display language with the region's order. */
export function dateLocale(): string {
  const f = prefs.dateFormat;
  const region = f === "en-us" ? "US" : f === "en-gb" ? "GB" : f === "de" ? "DE" : prefs.lang === "de" ? "DE" : "GB";
  return `${prefs.lang}-${region}`;
}
/** Whether numbers use a decimal point: chosen, or by the display language („auto“). */
export const decimalPoint = () => prefs.numberFormat === "point" || (prefs.numberFormat === "auto" && prefs.lang === "en");
/** Locale for numbers (decimal and thousands separators only). */
export const numberLocale = () => (decimalPoint() ? "en-US" : "de-DE");

const numberFormats = new Map<string, Intl.NumberFormat>();
function nf(min: number, max: number) {
  const key = `${numberLocale()}|${min}|${max}`;
  let f = numberFormats.get(key);
  if (!f) numberFormats.set(key, (f = new Intl.NumberFormat(numberLocale(), { minimumFractionDigits: min, maximumFractionDigits: max })));
  return f;
}

export const h1 = (x: number) => nf(1, 1).format(x);
export const h2 = (x: number) => nf(2, 2).format(x);
export const int = (x: number) => nf(0, 0).format(x);
/** The regional decimal separator. */
export const decimalSep = () => (decimalPoint() ? "." : ",");
/** A number with up to `max` decimals in the regional notation: 1,5 or 1.5. */
export const decimal = (x: number, max = 2) => nf(0, max).format(x);
/** USD cost in the regional notation: 0,0024 $ or $0.0024 */
export const usd = (x: number) =>
  x.toLocaleString(numberLocale(), { style: "currency", currency: "USD", minimumFractionDigits: x < 0.1 ? 4 : 2, maximumFractionDigits: x < 0.1 ? 4 : 2 });
export const hoursFromMinutes = (m: number | null | undefined) => h2((m ?? 0) / 60);

/** Hours as set in the settings: "1,50" or "1:30". */
export function fmtHours(hours: number, style = prefs.hours): string {
  if (style === "clock") {
    const total = Math.round(hours * 60);
    const sign = total < 0 ? "−" : "";
    const m = Math.abs(total);
    return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
  }
  return h2(hours);
}
/** Minutes shown as hours in the configured style. */
export const fmtMinutes = (m: number | null | undefined, style = prefs.hours) => fmtHours((m ?? 0) / 60, style);

const pad2 = (n: number) => String(n).padStart(2, "0");

/** A day in the configured format: "24.09.2026", "2026-09-24", "24/09/2026" or "09/24/2026". */
export function fmtDate(d: Date | string, style = prefs.dateFormat): string {
  const x = typeof d === "string" ? new Date(d) : d;
  const [dd, mm, yy] = [pad2(x.getDate()), pad2(x.getMonth() + 1), x.getFullYear()];
  if (style === "iso") return isoDay(x);
  if (style === "en-gb") return `${dd}/${mm}/${yy}`;
  if (style === "en-us") return `${mm}/${dd}/${yy}`;
  return `${dd}.${mm}.${yy}`;
}

/** Day and month without the year: "24.09.", "09-24", "24/09" or "09/24". */
export function fmtDayMonth(d: Date, style = prefs.dateFormat): string {
  const [dd, mm] = [pad2(d.getDate()), pad2(d.getMonth() + 1)];
  if (style === "iso") return `${mm}-${dd}`;
  if (style === "en-gb") return `${dd}/${mm}`;
  if (style === "en-us") return `${mm}/${dd}`;
  return `${dd}.${mm}.`;
}

/** Date and time: "24.09.2026, 14:03". */
export const dateTime = (iso: string) => `${fmtDate(iso)}, ${time(iso)}`;

/**
 * A typed day: „1.10.2026“, „01.10.26“, „1.10.“ (this year), „2026-10-01“ or with slashes
 * („1/10/2026“ day first, „10/1/2026“ month first with the US date format) as YYYY-MM-DD; null
 * when it is no date.
 */
export function parseDayInput(text: string, now = new Date()): string | null {
  const s = text.trim();
  let y: number, m: number, d: number;
  const year = (v: string | undefined) => (v ? (v.length === 2 ? 2000 + +v : +v) : now.getFullYear());
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const de = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})?$/.exec(s);
  const slash = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(s);
  if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (de) [y, m, d] = [year(de[3]), +de[2], +de[1]];
  else if (slash && prefs.dateFormat === "en-us") [y, m, d] = [year(slash[3]), +slash[1], +slash[2]];
  else if (slash) [y, m, d] = [year(slash[3]), +slash[2], +slash[1]];
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
/** Day of the month as written after a weekday: „24.“ in German, „24“ in English. */
export const dayOfMonth = (d: Date) => (prefs.lang === "de" ? `${d.getDate()}.` : String(d.getDate()));
/** „24. Sep.“ / „24 Sept“, with the year when asked. */
export const dayMonthName = (d: Date, year = false) => d.toLocaleDateString(dateLocale(), { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
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

/** "Do., 24.09." / "Thu 24/09" – weekday in the display language, day and month in the regional order. */
export const dateShort = (iso: string) => {
  const d = new Date(iso);
  if (prefs.dateFormat === "iso") return `${weekdayShort(d)} ${isoDay(d)}`;
  const wd = d.toLocaleDateString(prefs.lang === "de" ? "de-DE" : "en-GB", { weekday: "short" });
  return prefs.lang === "de" ? `${wd}, ${fmtDayMonth(d)}` : `${wd} ${fmtDayMonth(d)}`;
};
/** "Donnerstag, 24. September 2026" / "Thursday, 24 September 2026". */
export const dateLong = (iso: string) =>
  prefs.dateFormat === "iso"
    ? `${new Date(iso).toLocaleDateString(dateLocale(), { weekday: "long" })}, ${isoDay(new Date(iso))}`
    : new Date(iso).toLocaleDateString(dateLocale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
/** Time of day, always 24 h: "14:03". */
export const time = (iso: string) => {
  const d = new Date(iso);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

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
    let hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if ((count.get(minute(d)) ?? 0) > 1) hm += `:${pad(d.getSeconds())}`;
    return d.toDateString() === now.toDateString() ? hm : `${fmtDayMonth(d)}, ${hm}`;
  });
}

export function relative(iso: string) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t("time.justNow");
  if (diff < 3600) return t("time.minutesAgo", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("time.hoursAgo", { n: Math.floor(diff / 3600) });
  if (diff < 7 * 86400) return t("time.daysAgo", { n: Math.floor(diff / 86400) });
  if (prefs.dateFormat === "iso") return isoDay(new Date(iso));
  return new Date(iso).toLocaleDateString(dateLocale(), { day: "numeric", month: "short", year: "numeric" });
}

/** File size, e.g. "812 KB" or "3,4 MB". */
export function fileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${int(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${h1(bytes / 1024 ** 2)} MB`;
  return `${h1(bytes / 1024 ** 3)} GB`;
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

const DURATION_UNITS: Record<string, number> = {
  h: 60, std: 60, stunde: 60, stunden: 60, hr: 60, hrs: 60, hour: 60, hours: 60,
  m: 1, min: 1, mins: 1, minute: 1, minuten: 1, minutes: 1,
};

/**
 * Minutes of a `/zeit` duration (`2,5h`, `2.5std`, `1h30m`, `90min`, `1:30`, units in German
 * and English, as `annalo_core::zeit::parse_duration` reads them); null when it is none or not
 * between 1 minute and 24 hours.
 */
export function parseDuration(s: string): number | null {
  // A unit may end with a dot (`90min.`, `2std.`).
  const v = s.trim().toLowerCase().replace(/,/g, ".").replace(/([a-z])\.$/, "$1");
  let minutes = 0;
  const clock = /^(\d+):(\d{1,2})$/.exec(v);
  if (clock) {
    if (+clock[2] >= 60 || +clock[1] > 24) return null;
    minutes = +clock[1] * 60 + +clock[2];
  } else {
    const parts = [...v.matchAll(/(\d+(?:\.\d+)?)([a-z]+)/g)];
    if (!parts.length || parts.map((p) => p[0]).join("") !== v) return null;
    for (const [, n, unit] of parts) {
      const f = DURATION_UNITS[unit];
      if (!f) return null;
      minutes += +n * f;
    }
  }
  minutes = Math.round(minutes);
  return minutes >= 1 && minutes <= 24 * 60 ? minutes : null;
}

/** Parses a typed duration into minutes: a number of hours ("1,5"), "1:30" or a `/zeit` duration ("90 min", "1h 30m", "1,5 Std."). */
export function parseDurationInput(s: string): number | null {
  const v = s.trim().toLowerCase().replace(/\s+/g, "");
  const hours = /^(\d+(?:[.,]\d+)?)$/.exec(v);
  if (hours) return Math.round(+hours[1].replace(",", ".") * 60);
  const clock = /^(\d+):(\d{1,2})$/.exec(v);
  if (clock) return +clock[1] * 60 + +clock[2];
  return parseDuration(v);
}

/** Days/hours without a trailing ",0" for whole numbers. */
export const compact = (x: number) => (Number.isInteger(x) ? String(x) : h1(x));

/** Parses typed numbers: "1.200,5" → 1200,5, "1,5" → 1,5; without a comma a single dot is the decimal point. Null if invalid. */
export function parseGermanNumber(s: string): number | null {
  let v = s.trim().replace(/[\s ']/g, "");
  // With the point as decimal separator, commas group thousands: "1,200.5".
  if (decimalPoint() && /^-?\d{1,3}(,\d{3})+(\.\d*)?$/.test(v)) v = v.replace(/,/g, "");
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

/** Whole hours a timer started at `start` has run by `now`, when that is more than `limit`
 *  (forgotten over night: the stop asks before booking it). */
export function longTimerHours(start: string, now: Date, limit = 12): number | null {
  const hours = (now.getTime() - new Date(start).getTime()) / 3_600_000;
  return hours > limit ? Math.floor(hours) : null;
}

/** „120 von 480 Dateien gelesen“ while a vault is imported. */
export function importProgress(p: { done: number; total: number; writing?: boolean }) {
  if (p.writing) return t("import.writing", { done: Math.min(p.done, p.total), n: p.total });
  return p.total > 0 ? t("import.progress", { done: Math.min(p.done, p.total), n: p.total }) : t("import.reading");
}

/** „12 Seiten, 3 Ordner, 2 Bilder, 4 Dateien übersprungen“ */
export function importSummary(r: { pages: number; folders: number; attachments: number; skipped: number }) {
  const parts = [t("import.pages", { n: r.pages }), t("import.folders", { n: r.folders })];
  if (r.attachments) parts.push(t("import.images", { n: r.attachments }));
  if (r.skipped) parts.push(t("import.skipped", { n: r.skipped }));
  return parts.join(", ");
}
