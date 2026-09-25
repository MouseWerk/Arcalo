// Host of the first-run flow in the main window: the intro, then the setup, over the app.
// Keys stay inside (the app's shortcuts do not run behind it) and Tab cycles within it.

import { useEffect, useRef } from "react";
import { useApp } from "../store/app";
import { Intake } from "./Intake";
import { Intro } from "./Intro";
import { applyLanguage, osLanguage } from "./lang";
import { startIntake, useFirstRun } from "./state";

export function FirstRun() {
  const phase = useFirstRun((s) => s.phase);
  const paused = useFirstRun((s) => s.paused);
  const mode = useFirstRun((s) => s.mode);
  const lang = useApp((s) => s.settings?.settings.locale.language);
  const box = useRef<HTMLDivElement>(null);
  const langDone = useRef(false);
  const active = phase !== "off" && !paused;

  // First start: the OS language is the first guess (the language step can change it).
  useEffect(() => {
    if (phase === "off" || mode !== "fresh" || langDone.current || !lang) return;
    langDone.current = true;
    const os = osLanguage();
    if (os !== lang) void applyLanguage(os);
  }, [phase, mode, lang]);

  // The element that had the focus gets it back afterwards.
  useEffect(() => {
    if (!active) return;
    const prev = document.activeElement as HTMLElement | null;
    return () => prev?.focus?.();
  }, [active]);

  if (!active) return null;
  const onKey = (e: React.KeyboardEvent) => {
    const el = box.current;
    // A dialog opened from a step (provider, confirm) is portaled out and handles its own keys.
    if (!el || !el.contains(e.target as Node)) return;
    e.stopPropagation();
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
