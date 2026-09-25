// State of the first-run flow (intro, then the setup) and how it starts, pauses and ends.
// Only the main window hosts it; the capture, search and presenter windows never do.

import { create } from "zustand";
import { api } from "../lib/api";
import { openSettingsSection } from "../lib/calnav";
import { t } from "../lib/i18n";
import { useApp } from "../store/app";
import { STEP_SECTIONS, type StepId } from "./flow";
import { settled } from "./write";

/** fresh: first start; rerun: „Einführung erneut starten“; upgrade: from the 1.6 hint. */
export type FirstRunMode = "fresh" | "rerun" | "upgrade";

export interface FirstRunState {
  phase: "off" | "intro" | "intake";
  mode: FirstRunMode;
  step: StepId;
  /** Hidden while the user looks at a settings section („Mehr in den Einstellungen“). */
  paused: boolean;
  /** Choice of the workspace step in this run (for the summary). */
  workspace: "samples" | "import" | "empty" | null;
}

export const useFirstRun = create<FirstRunState>(() => ({ phase: "off", mode: "fresh", step: "language", paused: false, workspace: null }));

/** Plays the intro (or opens the setup directly) with the current settings prefilled. */
export function startFirstRun(mode: FirstRunMode, opts: { intake?: boolean; step?: StepId } = {}) {
  useApp.getState().set({ paletteOpen: false });
  useFirstRun.setState({ phase: opts.intake ? "intake" : "intro", mode, step: opts.step ?? "language", paused: false, workspace: null });
}

export const startIntake = () => useFirstRun.setState({ phase: "intake", paused: false });

/** Leaves the flow: the answers are saved already; the flags say the intro was seen. */
export async function finishFirstRun() {
  await settled();
  try {
    const view = await api.onboardingComplete();
    useApp.getState().set({ settings: view });
  } catch (e) {
    useApp.getState().error(t("fr.saveFailed"), e);
  }
  useFirstRun.setState({ phase: "off", paused: false });
}

/** „Mehr in den Einstellungen“: the flow steps aside, a toast brings it back on the same step. */
export function pauseForSettings(step: StepId) {
  const section = STEP_SECTIONS[step];
  if (!section) return;
  useFirstRun.setState({ paused: true, step });
  openSettingsSection(section);
  useApp.getState().toast({
    tone: "info",
    persistent: true,
    title: t("fr.paused"),
    detail: t("fr.pausedDetail"),
    action: { label: t("fr.resume"), run: resumeFirstRun },
  });
}

export function resumeFirstRun() {
  const st = useApp.getState();
  // The toast of the pause is gone once the flow is back.
  st.toasts.filter((x) => x.title === t("fr.paused")).forEach((x) => st.dismissToast(x.id));
  useFirstRun.setState({ paused: false });
}

/** At start: the intro on a fresh install, the one-time hint after an upgrade. */
export async function checkFirstRun(): Promise<"intro" | "hint" | null> {
  const status = await api.onboardingStatus().catch(() => null);
  if (!status) return null;
  if (status.intro) {
    // After „Einrichtung zurücksetzen“ the stored choices stay (no language guess).
    startFirstRun(status.existing ? "rerun" : "fresh");
    return "intro";
  }
  if (status.whats_new) {
    await api.onboardingHintShown().catch(() => {});
    useApp.getState().toast({
      tone: "info",
      persistent: true,
      title: t("fr.hint.title"),
      detail: t("fr.hint.detail"),
      action: { label: t("fr.hint.action"), run: () => startFirstRun("upgrade") },
    });
    return "hint";
  }
  return null;
}

/** Settings → Über: „Einrichtung zurücksetzen“ (flags only, after a confirmation). */
export async function resetOnboarding() {
  const st = useApp.getState();
  const ok = await st.confirm({ title: t("fr.reset.title"), message: t("fr.reset.message"), confirmLabel: t("fr.reset.confirm") });
  if (!ok) return;
  try {
    const view = await api.onboardingReset();
    useApp.getState().set({ settings: view });
    useApp.getState().toast({ tone: "success", title: t("fr.reset.done"), detail: t("fr.reset.doneDetail"), action: { label: t("fr.reset.now"), run: () => startFirstRun("rerun") } });
  } catch (e) {
    st.error(t("fr.saveFailed"), e);
  }
}
