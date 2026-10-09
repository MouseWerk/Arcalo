// „Erste Schritte“ on the start page (see firststeps.ts): each step opens what it names.

import { CalendarCheck2, CalendarRange, Check, ChevronRight, FilePlus2, ListChecks, Sparkles, Timer, X, type LucideIcon } from "lucide-react";
import { IconButton } from "../components/ui";
import { openAssistant, openToday } from "../components/Ribbon";
import { createSubpage } from "../views/PageView";
import { openSettingsSection } from "../lib/calnav";
import { useT } from "../lib/i18n";
import { hint } from "../lib/keymap";
import { keyChips } from "../lib/shortcut";
import { useApp } from "../store/app";
import { firstSteps, followFirstStep, hideFirstSteps, useFirstSteps, type FirstStepId } from "./firststeps";

const ICONS: Record<FirstStepId, LucideIcon> = { note: FilePlus2, today: CalendarCheck2, task: ListChecks, calendar: CalendarRange, time: Timer, ai: Sparkles, aiSetup: Sparkles };

const RUN: Record<FirstStepId, () => void> = {
  note: () => void createSubpage(null),
  today: () => void openToday(),
  task: () => useApp.getState().openTab({ kind: "tasks" }),
  calendar: () => openSettingsSection("calendar"),
  time: () => useApp.getState().openTab({ kind: "timesheet" }),
  ai: () => openAssistant(),
  aiSetup: () => openSettingsSection("ai"),
};

export function FirstSteps() {
  const t = useT();
  const stored = useFirstSteps((st) => st.stored);
  const view = useApp((st) => st.settings);
  const pages = useApp((st) => st.pages);
  if (!stored || stored.hidden) return null;
  const steps = firstSteps(view, pages.values(), stored);
  const left = steps.filter((x) => !x.done).length;
  if (!left) return null;
  return (
    <section className="first-steps" aria-labelledby="first-steps-title">
      <header className="first-steps-head">
        <div>
          <h2 id="first-steps-title">{t("fs.title")}</h2>
          <p>{t("fs.lead", { n: left })}</p>
        </div>
        <IconButton icon={X} size="sm" label={t("fs.hide")} onClick={hideFirstSteps} />
      </header>
      <ol className="first-steps-list">
        {steps.map((x) => (
          <li key={x.id}>
            <button
              type="button"
              className={`first-step ${x.done ? "done" : ""}`}
              data-step={x.id}
              onClick={() => {
                followFirstStep(x.id);
                RUN[x.id]();
              }}
            >
              <span className="first-step-icon" aria-hidden>
                {x.done ? <Check size={14} strokeWidth={2.6} /> : <Icon of={x.id} />}
              </span>
              <span className="first-step-text">
                <span className="first-step-title">
                  {t(x.title)}
                  {x.done && <span className="sr-only"> ({t("fs.done")})</span>}
                </span>
                <span className="first-step-sub">{t(x.text)}</span>
              </span>
              {/* The shortcut of Settings → Tastatur (none when it was removed there). */}
              {x.command && hint(x.command) && (
                <span className="keys first-step-keys" aria-hidden>
                  {keyChips(hint(x.command)).map((k, i) => (
                    <kbd key={`${k}-${i}`}>{k}</kbd>
                  ))}
                </span>
              )}
              <ChevronRight size={14} className="first-step-go" aria-hidden />
            </button>
          </li>
        ))}
      </ol>
      {hint("palette") && <p className="first-steps-foot">{t("fs.palette", { keys: hint("palette") })}</p>}
    </section>
  );
}

function Icon({ of }: { of: FirstStepId }) {
  const I = ICONS[of];
  return <I size={15} strokeWidth={1.8} />;
}
