// Runtime errors of a window, collected so end-to-end tests can assert a clean console; they also
// go to the developer log (Settings → Protokoll). Installed by each entry (main.tsx, mobile/main.tsx).
import { describeError, logUi } from "./devlog";

export function collectErrors() {
  const w = window as unknown as { __arcaloErrors: string[] };
  w.__arcaloErrors = [];
  window.addEventListener("error", (e) => {
    w.__arcaloErrors.push(String(e.message));
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
