// Proxy auto-config (PAC): the standard helper functions and the evaluation of
// `FindProxyForURL`. PAC files are JavaScript; the core has no JS engine, so the UI runs them
// in a sandboxed frame (`annalo-pac:` scheme, opaque origin, no IPC) and hands the answers
// to the shell (`network.pac_results`, host → answer).
//
// Limitations (documented in the settings): no DNS – `dnsResolve` only returns IP literals,
// `isInNet` only matches hosts given as IPs, `isResolvable` is always true, `myIpAddress` is
// 127.0.0.1. The answer is computed for the hosts the app talks to when the settings are
// saved or tested; other hosts (assistant HTTP tool) use the answer for the LiteLLM host.

/** The standard PAC helper functions as plain JavaScript (evaluated together with the PAC). */
export const PAC_HELPERS = String.raw`
function isPlainHostName(host) { return String(host).indexOf(".") < 0; }
function dnsDomainIs(host, domain) {
  host = String(host).toLowerCase(); domain = String(domain).toLowerCase();
  return host.length >= domain.length && host.substring(host.length - domain.length) === domain;
}
function localHostOrDomainIs(host, hostdom) {
  host = String(host).toLowerCase(); hostdom = String(hostdom).toLowerCase();
  return host === hostdom || (host.indexOf(".") < 0 && hostdom.indexOf(host + ".") === 0);
}
function isResolvable(host) { return true; }
function __ipv4(s) {
  var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || ""));
  if (!m) return null;
  var n = 0;
  for (var i = 1; i <= 4; i++) { var p = +m[i]; if (p > 255) return null; n = n * 256 + p; }
  return n;
}
function convert_addr(ip) { var n = __ipv4(ip); return n === null ? 0 : n; }
function dnsResolve(host) { return __ipv4(host) === null ? null : String(host); }
function dnsResolveEx(host) { var r = dnsResolve(host); return r === null ? "" : r; }
function myIpAddress() { return "127.0.0.1"; }
function myIpAddressEx() { return "127.0.0.1"; }
function isInNet(host, pattern, mask) {
  var h = __ipv4(host), p = __ipv4(pattern), m = __ipv4(mask);
  if (h === null || p === null || m === null) return false;
  function and(a, b) { var r = 0, bit = 1; for (var i = 0; i < 32; i++) { if ((a % 2) && (b % 2)) r += bit; a = Math.floor(a / 2); b = Math.floor(b / 2); bit *= 2; } return r; }
  return and(h, m) === and(p, m);
}
function dnsDomainLevels(host) { return String(host).split(".").length - 1; }
function shExpMatch(str, shexp) {
  var re = "^" + String(shexp).replace(/[.+^$(){}|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(re).test(String(str));
}
var __days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
var __months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
function __now(args) { var d = new Date(); var gmt = args.length && args[args.length - 1] === "GMT"; return { d: d, gmt: gmt }; }
function weekdayRange() {
  var a = Array.prototype.slice.call(arguments), t = __now(a);
  if (t.gmt) a.pop();
  var day = t.gmt ? t.d.getUTCDay() : t.d.getDay();
  var w1 = __days.indexOf(String(a[0]).toUpperCase()), w2 = a.length > 1 ? __days.indexOf(String(a[1]).toUpperCase()) : w1;
  if (w1 < 0 || w2 < 0) return false;
  return w1 <= w2 ? day >= w1 && day <= w2 : day >= w1 || day <= w2;
}
function timeRange() {
  var a = Array.prototype.slice.call(arguments), t = __now(a);
  if (t.gmt) a.pop();
  var h = t.gmt ? t.d.getUTCHours() : t.d.getHours(), m = t.gmt ? t.d.getUTCMinutes() : t.d.getMinutes(), s = t.gmt ? t.d.getUTCSeconds() : t.d.getSeconds();
  var now = h * 3600 + m * 60 + s, from, to;
  if (a.length === 1) { from = a[0] * 3600; to = from + 3599; }
  else if (a.length === 2) { from = a[0] * 3600; to = a[1] * 3600 - 1; }
  else if (a.length === 4) { from = a[0] * 3600 + a[1] * 60; to = a[2] * 3600 + a[3] * 60 - 1; }
  else if (a.length === 6) { from = a[0] * 3600 + a[1] * 60 + a[2]; to = a[3] * 3600 + a[4] * 60 + a[5]; }
  else return false;
  return from <= to ? now >= from && now <= to : now >= from || now <= to;
}
function dateRange() {
  var a = Array.prototype.slice.call(arguments), t = __now(a);
  if (t.gmt) a.pop();
  var d = t.d;
  var cur = { y: t.gmt ? d.getUTCFullYear() : d.getFullYear(), m: t.gmt ? d.getUTCMonth() : d.getMonth(), d: t.gmt ? d.getUTCDate() : d.getDate() };
  function val(x) {
    if (typeof x === "number") return x > 31 ? { y: x } : { d: x };
    var i = __months.indexOf(String(x).toUpperCase()); return i >= 0 ? { m: i } : {};
  }
  var vals = a.map(val);
  if (vals.length === 1) {
    var v = vals[0];
    return (v.d === undefined || v.d === cur.d) && (v.m === undefined || v.m === cur.m) && (v.y === undefined || v.y === cur.y);
  }
  if (vals.length === 0 || vals.length % 2 !== 0) return false;
  var half = vals.length / 2, lo = {}, hi = {};
  for (var i = 0; i < half; i++) { Object.assign(lo, vals[i]); Object.assign(hi, vals[half + i]); }
  var f = { y: lo.y !== undefined, m: lo.m !== undefined, d: lo.d !== undefined };
  function num(v) { return (f.y ? v.y * 10000 : 0) + (f.m ? v.m * 100 : 0) + (f.d ? v.d : 0); }
  var now = num(cur), from = num(lo), to = num(hi);
  return from <= to ? now >= from && now <= to : now >= from || now <= to;
}
function alert() {}
`;

/** Script that defines the helpers, the PAC and returns `FindProxyForURL(url, host)`. */
export function pacProgram(pac: string, url: string, host: string): string {
  return `${PAC_HELPERS}\n${pac}\n;return FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(host)});`;
}

/** Host of a URL, lower case, without brackets; null for an invalid URL. */
export function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Evaluates a PAC here (tests, and environments whose CSP allows it). The app itself uses
 * {@link evaluatePacSandboxed}.
 */
export function evaluatePac(pac: string, url: string): string {
  const host = hostOf(url) ?? "";
  return String(new Function(pacProgram(pac, url, host))());
}

/** The URLs whose PAC answers are stored: `*` = the LiteLLM URL (default for other hosts). */
export function pacTargets(litellmUrl: string, others: string[]): { key: string; url: string }[] {
  // As a browser would pass it: normalized, with a path ("http://host:4000/").
  const norm = (u: string) => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  litellmUrl = norm(litellmUrl);
  others = others.map(norm);
  const out: { key: string; url: string }[] = [{ key: "*", url: litellmUrl }];
  for (const u of others) {
    const h = hostOf(u);
    if (h && !out.some((o) => o.key === h)) out.push({ key: h, url: u });
  }
  const main = hostOf(litellmUrl);
  if (main && !out.some((o) => o.key === main)) out.push({ key: main, url: litellmUrl });
  return out;
}

/** Update feed host (the updater's endpoint in tauri.conf.json). */
export const UPDATE_URL = "https://github.com/";

type Waiter = { resolve: (v: string) => void; reject: (e: Error) => void };

/** The sandbox frame, created on first use. */
let frame: { el: HTMLIFrameElement; ready: Promise<void>; waiters: Map<number, Waiter> } | null = null;
let nextId = 1;

async function sandboxUrl(): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  return convertFileSrc("index.html", "annalo-pac");
}

async function sandbox() {
  if (frame) return frame;
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("aria-hidden", "true");
  el.tabIndex = -1;
  el.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden;left:-10px;top:-10px";
  const waiters = new Map<number, Waiter>();
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((r) => (readyResolve = r));
  window.addEventListener("message", (e) => {
    if (e.source !== el.contentWindow) return;
    const d = e.data as { ready?: boolean; id?: number; ok?: boolean; value?: string; error?: string };
    if (d?.ready) return readyResolve();
    const w = d?.id != null ? waiters.get(d.id) : undefined;
    if (!w) return;
    waiters.delete(d.id!);
    if (d.ok) w.resolve(String(d.value));
    else w.reject(new Error(d.error ?? "PAC-Fehler"));
  });
  el.src = await sandboxUrl();
  document.body.appendChild(el);
  frame = { el, ready, waiters };
  return frame;
}

/** Evaluates `FindProxyForURL` for each URL in the sandboxed frame (5 s timeout each). */
export async function evaluatePacSandboxed(pac: string, urls: string[]): Promise<string[]> {
  const f = await sandbox();
  await Promise.race([f.ready, new Promise((_, rej) => setTimeout(() => rej(new Error("PAC-Auswertung nicht verfügbar")), 5000))]);
  return Promise.all(
    urls.map(
      (url) =>
        new Promise<string>((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => {
            f.waiters.delete(id);
            reject(new Error("PAC-Auswertung dauert zu lange"));
          }, 5000);
          f.waiters.set(id, {
            resolve: (v) => (clearTimeout(timer), resolve(v)),
            reject: (e) => (clearTimeout(timer), reject(e)),
          });
          f.el.contentWindow?.postMessage({ id, code: pacProgram(pac, url, hostOf(url) ?? "") }, "*");
        }),
    ),
  );
}

/** Answers for all targets: `{ "*": "PROXY p:8080", "github.com": "DIRECT", … }`. */
export async function resolvePac(pac: string, litellmUrl: string, others: string[]): Promise<Record<string, string>> {
  const targets = pacTargets(litellmUrl, others);
  const answers = await evaluatePacSandboxed(pac, targets.map((t) => t.url));
  return Object.fromEntries(targets.map((t, i) => [t.key, answers[i]]));
}
