// The intro that plays on first start: a welcome and six feature scenes (about 35 s), each with
// a headline, one sentence and a visual. Auto-advances with a progress bar per scene; arrow
// keys move, Space pauses, Esc or „Überspringen“ go to the setup. Hovering the scene or keyboard
// focus on it or its progress pauses the countdown (a scene's own entrance still completes).
// Reduced motion shows static slides that fade.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play } from "lucide-react";
import { ArcaloLogo } from "../components/Logo";
import { useT, type TKey } from "../lib/i18n";
import { useApp } from "../store/app";
import { AiVisual, CalendarVisual, CaptureVisual, LocalVisual, NotesVisual, TimeVisual, WelcomeVisual } from "./scenes";

interface Scene {
  id: string;
  eyebrow: TKey;
  title: TKey;
  text: TKey;
  ms: number;
}

export const SCENES: Scene[] = [
  { id: "welcome", eyebrow: "fr.s.welcome.eyebrow", title: "fr.s.welcome.title", text: "fr.s.welcome.text", ms: 4600 },
  { id: "notes", eyebrow: "fr.s.notes.eyebrow", title: "fr.s.notes.title", text: "fr.s.notes.text", ms: 5000 },
  { id: "time", eyebrow: "fr.s.time.eyebrow", title: "fr.s.time.title", text: "fr.s.time.text", ms: 5400 },
  { id: "ai", eyebrow: "fr.s.ai.eyebrow", title: "fr.s.ai.title", text: "fr.s.ai.text", ms: 5000 },
  { id: "calendar", eyebrow: "fr.s.calendar.eyebrow", title: "fr.s.calendar.title", text: "fr.s.calendar.text", ms: 5000 },
  { id: "capture", eyebrow: "fr.s.capture.eyebrow", title: "fr.s.capture.title", text: "fr.s.capture.text", ms: 5000 },
  { id: "local", eyebrow: "fr.s.local.eyebrow", title: "fr.s.local.title", text: "fr.s.local.text", ms: 5000 },
];

/** Reduced motion: the OS setting or Settings → Darstellung. */
export function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.reduceMotion === "on") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

export function Intro({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [focusIn, setFocusIn] = useState(false);
  const reduced = useRef(prefersReducedMotion()).current;
  const root = useRef<HTMLDivElement>(null);
  const shortcut = useApp((s) => s.settings?.settings.capture_shortcut ?? "");
  const paused = userPaused || hover || focusIn;
  const scene = SCENES[index];
  const last = index === SCENES.length - 1;

  const go = (i: number) => setIndex(Math.max(0, Math.min(SCENES.length - 1, i)));
  const next = () => (last ? onDone() : go(index + 1));

  useEffect(() => {
    root.current?.focus();
  }, []);

  // The visuals are drawn for 560 x 420 and scaled to the space the window leaves them.
  const box = useRef<ResizeObserver | null>(null);
  const fit = useCallback((el: HTMLDivElement | null) => {
    box.current?.disconnect();
    if (!el) return;
    const apply = () => {
      const s = Math.min(el.clientWidth / 600, el.clientHeight / 450, 1.25);
      el.style.setProperty("--s", String(Math.max(0.3, s)));
    };
    apply();
    box.current = new ResizeObserver(apply);
    box.current.observe(el);
  }, []);

  // The countdown runs in JS (reduced motion shortens every CSS animation to nothing): the bar of
  // the current scene is scaled per frame, and pausing keeps the elapsed time.
  const bar = useRef<HTMLElement>(null);
  const nextRef = useRef(next);
  nextRef.current = next;
  const elapsed = useRef(0);
  useEffect(() => {
    elapsed.current = 0;
  }, [index]);
  useEffect(() => {
    if (paused) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      const p = Math.min(1, elapsed.current / scene.ms);
      if (bar.current) bar.current.style.transform = `scaleX(${p})`;
      if (p >= 1) nextRef.current();
      else frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, index, scene.ms]);

  // Keyboard focus on the scene or its progress pauses (a mouse click on a segment does not).
  const onFocus = (e: React.FocusEvent) => setFocusIn((e.target as HTMLElement).matches(":focus-visible"));
  const onBlur = (e: React.FocusEvent) => !e.currentTarget.contains(e.relatedTarget as Node) && setFocusIn(false);

  const onKey = (e: React.KeyboardEvent) => {
    const onButton = (e.target as HTMLElement).closest("button");
    if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      next();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      go(index - 1);
    } else if (e.key === " " && !onButton) {
      e.preventDefault();
      setUserPaused((p) => !p);
    }
  };

  const Visual = {
    welcome: WelcomeVisual,
    notes: NotesVisual,
    time: TimeVisual,
    ai: AiVisual,
    calendar: CalendarVisual,
    capture: () => <CaptureVisual shortcut={shortcut} />,
    local: LocalVisual,
  }[scene.id]!;

  return (
    <div
      ref={root}
      className={`fr-intro ${paused ? "fr-paused" : ""} ${reduced ? "fr-reduced" : ""}`}
      data-scene={scene.id}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-roledescription={t("fr.intro.role")}
      aria-label={t("fr.intro.label")}
      onKeyDown={onKey}
    >
      <header className="fr-top" data-tauri-drag-region>
        <span className="fr-brand" data-tauri-drag-region>
          <ArcaloLogo size={18} />
          Arcalo
        </span>
        <button type="button" className="fr-skip" onClick={onDone}>
          {t("fr.intro.skip")}
          <kbd>Esc</kbd>
        </button>
      </header>

      <div
        className="fr-stage"
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {/* Keyed: every scene starts its motion from the beginning. */}
        <section key={scene.id} className={`fr-scene fr-scene-${scene.id}`} aria-labelledby="fr-scene-title">
          <div className="fr-copy">
            <div className="fr-eyebrow">
              <span className="fr-count">{String(index + 1).padStart(2, "0")}</span>
              {t(scene.eyebrow)}
            </div>
            <h1 id="fr-scene-title" className="fr-title">
              {t(scene.title)}
            </h1>
            <p className="fr-text">{t(scene.text)}</p>
          </div>
          {/* Pointing at the visual pauses (a pointer that merely rests there from the start does not). */}
          <div className="fr-visual" aria-hidden ref={fit} onMouseMove={() => !hover && setHover(true)} onMouseLeave={() => setHover(false)}>
            <div className="frv-canvas">
              <Visual />
            </div>
          </div>
        </section>
      </div>

      <footer className="fr-bottom">
        <div
          className="fr-progress"
          role="group"
          aria-label={t("fr.intro.progress")}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          {SCENES.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`fr-seg ${i < index ? "done" : i === index ? "now" : ""}`}
              aria-label={t("fr.intro.goto", { n: i + 1, title: t(s.title) })}
              aria-current={i === index ? "step" : undefined}
              onClick={() => go(i)}
            >
              <i ref={i === index ? bar : undefined} style={i === index ? undefined : { transform: `scaleX(${i < index ? 1 : 0})` }} />
            </button>
          ))}
        </div>
        <div className="fr-controls">
          <button type="button" className="fr-round" aria-label={t("fr.intro.prev")} data-tooltip={t("fr.intro.prev")} onClick={() => go(index - 1)} disabled={index === 0}>
            <ChevronLeft size={16} strokeWidth={2} />
          </button>
          <button
            type="button"
            className="fr-round"
            aria-label={t(userPaused ? "fr.intro.play" : "fr.intro.pause")}
            aria-pressed={userPaused}
            data-tooltip={t(userPaused ? "fr.intro.play" : "fr.intro.pause")}
            onClick={() => setUserPaused(!userPaused)}
          >
            {userPaused ? <Play size={15} strokeWidth={2} /> : <Pause size={15} strokeWidth={2} />}
          </button>
          <button type="button" className="fr-round" aria-label={t("fr.intro.next")} data-tooltip={t("fr.intro.next")} onClick={next}>
            <ChevronRight size={16} strokeWidth={2} />
          </button>
          {paused && (
            <span className="fr-paused-note" aria-hidden>
              {t("fr.intro.paused")}
            </span>
          )}
          <span className="grow" />
          <button type="button" className="btn btn-primary btn-md fr-setup" onClick={onDone}>
            <span>{t(last ? "fr.intro.setupNow" : "fr.intro.setup")}</span>
            <ChevronRight size={14} strokeWidth={2.2} aria-hidden />
          </button>
        </div>
        <div className="sr-only" aria-live="polite">
          {t("fr.intro.status", { n: index + 1, total: SCENES.length, title: t(scene.title) })}
        </div>
      </footer>
    </div>
  );
}
