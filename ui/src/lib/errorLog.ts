// Runtime errors of a window, collected so end-to-end tests can assert a clean console; they also
// go to the developer log (Settings → Protokoll). Installed by each entry (main.tsx, mobile/main.tsx).
import { describeError, logUi } from "./devlog";

export function collectErrors() {
  const w = window as unknown as { __arcaloErrors: string[] };
  w.__arcaloErrors = [];
  const resizeTrace = navigator.webdriver ? traceResizeObservers() : null;
  window.addEventListener("error", (e) => {
    // Which observers ran in the frame of a „ResizeObserver loop“, and what they changed.
    w.__arcaloErrors.push(resizeTrace && /ResizeObserver loop/.test(String(e.message)) ? `${e.message} [${resizeTrace().join("; ")}]` : String(e.message));
    logUi("ERROR", e.error ? describeError(e.error) : `${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    w.__arcaloErrors.push(String(e.reason));
    logUi("ERROR", `Unhandled rejection: ${describeError(e.reason)}`);
  });
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    w.__arcaloErrors.push(args.map(String).join(" "));
    logUi("ERROR", args.map((a) => (a instanceof Error ? describeError(a) : typeof a === "string" ? a : describeError(a))).join(" "));
    origError(...args);
  };
}

/** A short name of an element for the trace: its tag and first classes. */
function nameOf(n: Node): string {
  const el = n instanceof Element ? n : n.parentElement;
  if (!el) return n.nodeName;
  const cls = [...el.classList].slice(0, 2).join(".");
  return `${el.localName}${cls ? `.${cls}` : ""}`;
}

/**
 * Under WebDriver only: records the ResizeObserver callbacks of the current frame with what each
 * changed in the document (also in the microtasks it queued, where React renders a store update).
 * Returns the reader of the records.
 */
function traceResizeObservers(): (() => string[]) | null {
  const Native = window.ResizeObserver;
  if (!Native) return null;
  const ran: string[] = [];
  let frame = 0;
  const changes = new MutationObserver(() => {});
  const start = () => changes.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start();
  class Traced extends Native {
    constructor(callback: ResizeObserverCallback) {
      super((entries, observer) => {
        changes.takeRecords();
        callback(entries, observer);
        const sync = changes.takeRecords();
        const what = [...new Set(entries.map((e) => nameOf(e.target)))].join(",");
        queueMicrotask(() => {
          const all = [...sync, ...changes.takeRecords()];
          const changed = [...new Set(all.map((r) => `${r.type === "attributes" ? `@${r.attributeName}` : r.type} ${nameOf(r.target)}`))].slice(0, 4);
          ran.push(changed.length ? `${what} -> ${changed.join(", ")}` : what);
        });
        if (!frame) frame = requestAnimationFrame(() => ((frame = 0), (ran.length = 0)));
      });
    }
  }
  window.ResizeObserver = Traced;
  return () => [...ran];
}
