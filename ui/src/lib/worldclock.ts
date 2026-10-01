// World clock of the „Uhr“ widget: the time zones to pick from, their city names, whether a
// locale writes 12 or 24 hours, and the time in another zone relative to the local one.

// Intl formatters are slow to create and the clock renders often: one per locale and options.
const formats = new Map<string, Intl.DateTimeFormat>();
function format(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) formats.set(key, (f = new Intl.DateTimeFormat(locale, opts)));
  return f;
}

const FALLBACK = ["UTC", "Europe/London", "Europe/Berlin", "Europe/Zurich", "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Australia/Sydney", "America/New_York", "America/Chicago", "America/Los_Angeles", "America/Sao_Paulo"];

/** Every IANA time zone the system knows (a short list where it cannot say). */
export function timeZones(): string[] {
  try {
    const all = Intl.supportedValuesOf("timeZone");
    return all.includes("UTC") ? all : ["UTC", ...all];
  } catch {
    return FALLBACK;
  }
}

/** „New York“ for `America/New_York`. */
export const cityOf = (zone: string) => (zone.split("/").pop() ?? zone).replace(/_/g, " ");

/** Whether `locale` writes the time with 12 hours (en-US) or 24 (de-DE, en-GB). */
export function uses12h(locale: string): boolean {
  try {
    return format(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
  } catch {
    return false;
  }
}

/** The wall clock of `zone` at `now`, as if it were UTC (ms). */
function wallMs(now: Date, zone: string): number {
  const parts = format("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(now);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"));
}

export interface ZoneTime {
  /** „16:30“ or „4:30 PM“. */
  time: string;
  /** Minutes ahead of the local time (negative: behind). */
  offset: number;
  /** The zone's day against the local one: -1 yesterday, 0 today, 1 tomorrow. */
  dayShift: number;
}

/** The time in `zone` at `now`, in `locale` with 12 or 24 hours; `localZone` for tests. */
export function zoneTime(now: Date, zone: string, locale: string, hour12: boolean, localZone?: string): ZoneTime {
  const time = format(locale, { timeZone: zone, hour: hour12 ? "numeric" : "2-digit", minute: "2-digit", hour12 }).format(now);
  const here = localZone ? wallMs(now, localZone) : Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const there = wallMs(now, zone);
  const offset = Math.round((there - here) / 60_000);
  const day = (ms: number) => Math.floor(ms / 86_400_000);
  return { time, offset, dayShift: day(there) - day(here) };
}

/** „+6 h“, „−1 h“, „+5:30 h“ or „±0 h“. */
export function offsetLabel(minutes: number): string {
  if (minutes === 0) return "±0 h";
  const sign = minutes > 0 ? "+" : "−";
  const m = Math.abs(minutes);
  return `${sign}${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, "0")}` : ""} h`;
}
