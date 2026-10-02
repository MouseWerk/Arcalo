// The setup after the intro: a step list on the left (a compact bar in narrow windows), a
// progress bar, back / skip / next. Every step saves at once; „Fertig“ sums the answers up.

import { useEffect, useLayoutEffect, useRef } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { AnnaloLogo } from "../components/Logo";
import { useT } from "../lib/i18n";
import { useApp } from "../store/app";
import { STEPS, STEP_LABELS, nextStep, prevStep, progressOf, stepIndex, type StepId } from "./flow";
import { finishFirstRun, useFirstRun } from "./state";
import { AiStep, BackupStep, CalendarStep, DesktopStep, DoneStep, LanguageStep, SyncStep, ThemeStep, WorkStep, WorkspaceStep } from "./steps";
import { writeSettings } from "./write";
import { SecurityStep } from "./SecurityStep";

export function Intake() {
  const t = useT();
  const step = useFirstRun((s) => s.step);
  const view = useApp((s) => s.settings);
  const body = useRef<HTMLDivElement>(null);
  const seen = useRef(new Set<StepId>([step]));
  seen.current.add(step);
  const setStep = (next: StepId) => useFirstRun.setState({ step: next });
  const last = step === "done";
  const i = stepIndex(step);

  // A new step starts at its top, with the focus on its heading (screen readers read it).
  useLayoutEffect(() => {
    body.current?.scrollTo({ top: 0 });
    const h = body.current?.querySelector<HTMLElement>("[data-step-title]");
    h?.focus({ preventScroll: true });
  }, [step]);
  useEffect(() => {
    if (!view) void useApp.getState().refreshSettings();
  }, [view]);
  if (!view) return null;

  const next = () => (last ? void finishFirstRun() : setStep(nextStep(step)));
  const content = (() => {
    const p = { view, write: writeSettings };
    switch (step) {
      case "language":
        return <LanguageStep view={view} />;
      case "theme":
        return <ThemeStep {...p} />;
      case "work":
        return <WorkStep {...p} />;
      case "workspace":
        return <WorkspaceStep view={view} />;
      case "ai":
        return <AiStep {...p} />;
      case "calendar":
        return <CalendarStep {...p} />;
      case "sync":
        return <SyncStep {...p} />;
      case "backup":
        return <BackupStep {...p} />;
      case "security":
        return <SecurityStep />;
      case "desktop":
        return <DesktopStep {...p} />;
      case "done":
        return <DoneStep view={view} onEdit={setStep} />;
    }
  })();

  return (
    <div className="fr-intake" role="dialog" aria-modal="true" aria-label={t("fr.intake.label")}>
      <div className="fr-top" data-tauri-drag-region>
        <span className="fr-brand" data-tauri-drag-region>
          <AnnaloLogo size={18} />
          {t("fr.intake.title")}
        </span>
      </div>
      <div className="fr-card">
        <nav className="fr-rail" aria-label={t("fr.intake.steps")}>
          <ol>
            {STEPS.map((id, n) => {
              const done = n < i || (seen.current.has(id) && id !== step);
              return (
                <li key={id}>
                  <button type="button" className={`fr-rail-item ${id === step ? "now" : ""} ${done ? "done" : ""}`} aria-current={id === step ? "step" : undefined} onClick={() => setStep(id)} data-step={id}>
                    <span className="fr-rail-dot" aria-hidden>
                      {done ? <Check size={11} strokeWidth={3} /> : n + 1}
                    </span>
                    {t(STEP_LABELS[id])}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <div className="fr-main">
          <div className="fr-bar" role="progressbar" aria-label={t("fr.intake.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progressOf(step) * 100)}>
            <i style={{ width: `${Math.max(4, progressOf(step) * 100)}%` }} />
          </div>
          <div className="fr-compact" aria-hidden>
            {t("fr.stepOf", { n: i + 1, total: STEPS.length })} · {t(STEP_LABELS[step])}
          </div>
          <button type="button" className="fr-close icon-btn icon-btn-md" aria-label={t("fr.intake.close")} data-tooltip={t("fr.intake.close")} onClick={() => void finishFirstRun()}>
            <X size={15} strokeWidth={1.75} aria-hidden />
          </button>
          <div className="fr-body" ref={body}>
            {content}
          </div>
          <div className="fr-foot">
            <button type="button" className="btn btn-ghost btn-md" onClick={() => setStep(prevStep(step))} disabled={i === 0}>
              <ChevronLeft size={14} strokeWidth={2} aria-hidden />
              <span>{t("fr.back")}</span>
            </button>
            <span className="grow" />
            {!last && (
              <button type="button" className="btn btn-ghost btn-md fr-skip-step" onClick={() => setStep(nextStep(step))}>
                <span>{t("fr.skipStep")}</span>
              </button>
            )}
            <button type="button" className="btn btn-primary btn-md fr-next" onClick={next}>
              <span>{t(last ? "fr.start" : "fr.next")}</span>
              {!last && <ChevronRight size={14} strokeWidth={2} aria-hidden />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
