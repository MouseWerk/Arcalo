// Host of the first-run flow in the main window: the intro, then the setup, over the app.
// Keys stay inside (the app's shortcuts do not run behind it) and Tab cycles within it.

import { useEffect, useRef } from "react";
import { Intake } from "./Intake";
import { Intro } from "./Intro";
import { finishFirstRun, startIntake, useFirstRun } from "./state";
import { focusMain } from "../lib/regions";
import { isComposing } from "../lib/ime";

export function FirstRun() {
  const phase = useFirstRun((s) => s.phase);
  const paused = useFirstRun((s) => s.paused);
  const box = useRef<HTMLDivElement>(null);
  const active = phase !== "off" && !paused;

  // The element that had the focus gets it back afterwards; at the first start (nothing had it)
  // the page behind does, so the next Tab does not start at the window's edge.
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => {
      if (prev && prev !== document.body && prev.isConnected) prev.focus();
      else requestAnimationFrame(() => focusMain());
    };
  }, [active]);

  if (!active) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const el = box.current;
    // A dialog opened from a step (provider, confirm) is portaled out and handles its own keys.
    if (!el || !el.contains(e.target as Node)) return;
    e.stopPropagation();
    // Escape in the setup is „Einrichtung beenden“: the answers so far are kept (each step saves).
    if (e.key === "Escape" && phase === "intake" && !e.defaultPrevented && !isComposing(e)) {
      e.preventDefault();
      void finishFirstRun();
      return;
    }
    if (e.key !== "Tab") return;
    const all = [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href], [tabindex]")].filter(
      (x) => x.tabIndex >= 0 && !(x as HTMLButtonElement).disabled && x.offsetParent !== null,
    );
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (e.shiftKey && document.activeElement === first) (e.preventDefault(), last.focus());
    else if (!e.shiftKey && document.activeElement === last) (e.preventDefault(), first.focus());
  };
  return (
    <div ref={box} className={`fr-overlay fr-phase-${phase}`} onKeyDown={onKey}>
      {phase === "intro" ? <Intro onDone={startIntake} /> : <Intake />}
    </div>
  );
}
