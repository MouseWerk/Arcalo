// Start page widget „Briefing“: the Morgen-Briefing in short – counts per section, the meeting
// under way or next, and the first line of „Was heute wichtig ist“ (only the cached text: the
// widget never asks the assistant). Its data is the briefing's one call, loaded once the widget
// scrolls into view.

import { CalendarRange, Clock, ListChecks, Sparkles, Sun, Ticket, type LucideIcon } from "lucide-react";
import { api } from "../../../lib/api";
import { t } from "../../../lib/i18n";
import { briefingCounts, nextMeeting, openBriefing, shows, summaryLines } from "../../../lib/briefing";
import { hiddenCalendars, useHiddenCalendars } from "../../../lib/calvisibility";
import { hours } from "../../../lib/dayreview";
import { defineWidget } from "../define";
import { useLazyData } from "../data";
import { Loadable, hhmm } from "../common";
import type { Briefing } from "../../../lib/types";
import type { WidgetProps } from "../registry";

function Count({ icon: Icon, value, label, section }: { icon: LucideIcon; value: string; label: string; section: string }) {
  return (
    <button type="button" className="dw-bf-count" data-section={section} onClick={() => openBriefing()} aria-label={`${label}: ${value}`}>
      <Icon size={13} aria-hidden />
      <span className="dw-bf-value num">{value}</span>
      <span className="dw-bf-label">{label}</span>
    </button>
  );
}

function BriefingWidget({ widget }: WidgetProps) {
  const hidden = useHiddenCalendars();
  const { data, error, loading } = useLazyData<Briefing>(widget.id, () => api.briefing([...hiddenCalendars()]), {
    key: [...hidden].join(","),
    topics: ["tasks", "calendar", "entries", "sync", "absences"],
    every: 300_000,
  });
  return (
    <Loadable loading={loading && !data} error={error}>
      {() => {
        const b = data!;
        const c = briefingCounts(b);
        const next = nextMeeting(b);
        const line = b.summary ? summaryLines(b.summary.text)[0] : null;
        return (
          <div className="dw-bf">
            <div className="dw-bf-counts">
              {shows(b, "meetings") && <Count icon={CalendarRange} section="meetings" value={String(c.upcoming)} label={t("dash.bf.meetings")} />}
              {shows(b, "tasks") && <Count icon={ListChecks} section="tasks" value={String(c.tasks)} label={t("dash.bf.tasks")} />}
              {shows(b, "jira") && b.jira && <Count icon={Ticket} section="jira" value={String(c.jira)} label={t("dash.bf.jira")} />}
              {shows(b, "time") && b.time && <Count icon={Clock} section="time" value={hours(c.missing)} label={t("dash.bf.missing")} />}
            </div>
            <button type="button" className="dw-bf-next" onClick={() => openBriefing()}>
              <span className="dw-bf-next-label">{next ? t(new Date(next.start).getTime() <= Date.now() ? "brief.now" : "brief.next") : t("dash.bf.noNext")}</span>
              {next && (
                <span className="dw-bf-next-title ellipsis">
                  <span className="num">{hhmm(next.start)}</span> {next.title || t("cal.appointment")}
                </span>
              )}
            </button>
            {shows(b, "ai") && (
              <button type="button" className="dw-bf-ai" onClick={() => openBriefing()}>
                <Sparkles size={13} aria-hidden />
                <span className={line ? "ellipsis" : "ellipsis faint"}>{line ?? (b.ai_ready ? t("dash.bf.aiOpen") : t("dash.bf.noAi"))}</span>
              </button>
            )}
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "briefing",
  label: "dash.w.briefing",
  hint: "dash.w.briefingHint",
  group: "day",
  size: { w: 4, h: 6 },
  min: { w: 3, h: 5 },
  config: () => ({}),
  icon: Sun,
  look: "tiles",
  body: BriefingWidget,
  opener: () => () => openBriefing(),
});
