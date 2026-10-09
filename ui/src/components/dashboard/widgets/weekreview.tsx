// Start page widget „Diese Woche“: the Wochenrückblick in short – booked against the week's
// target with a bar per day (without time tracking: the days' meetings), meetings, tasks done
// and pages worked on, and the way to the full review and the saved report. Its data is the
// review's one call, loaded once the widget scrolls into view.

import { CalendarCheck, CalendarRange, CheckSquare, FileText } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { fmtDuration, isoDay } from "../../../lib/format";
import { openDayReview } from "../../../lib/reviewnav";
import { dayOff, dayProgress, dayShort, mondayOf, openWeekReview, weekApi, weekProgress, type WeekReview } from "../../../lib/weekreview";
import { useApp } from "../../../store/app";
import { Progress } from "../../ui";
import { defineWidget } from "../define";
import { useLazyData } from "../data";
import { Loadable } from "../common";
import type { WidgetProps } from "../registry";

function WeekReviewWidget({ widget }: WidgetProps) {
  const t = useT();
  const monday = mondayOf(isoDay(new Date()));
  const { data, error, loading } = useLazyData<WeekReview>(widget.id, () => weekApi.review(monday), {
    key: monday,
    topics: ["entries", "tasks", "pages", "calendar", "focus", "absences"],
    every: 300_000,
  });
  return (
    <Loadable loading={loading && !data} error={error}>
      {() => {
        const r = data!;
        const tm = r.time;
        const today = isoDay(new Date());
        const maxMeetings = Math.max(1, ...r.days.map((d) => d.meetings));
        return (
          <div className="dw-wr">
            {!r.without_time && (
              <button type="button" className="dw-wr-time" onClick={() => openWeekReview(monday)}>
                <span className="dw-wr-value num">
                  {fmtDuration(tm.booked_minutes)}
                  {tm.target_minutes > 0 && <span className="dw-wr-of"> / {fmtDuration(tm.target_minutes)}</span>}
                </span>
                <Progress value={weekProgress(r)} tone={tm.target_minutes > 0 && tm.booked_minutes >= tm.target_minutes ? "success" : "accent"} />
                <span className="dw-wr-sub">{tm.missing_minutes > 0 ? t("week.missing", { h: fmtDuration(tm.missing_minutes) }) : tm.target_minutes > 0 ? t("review.targetReached") : t("week.noTarget")}</span>
              </button>
            )}
            <div className="dw-wr-days" role="group" aria-label={t("week.daysLabel")}>
              {r.days.map((d) => {
                const share = r.without_time ? d.meetings / maxMeetings : dayProgress(d);
                const label = r.without_time ? t("week.dayMeetings", { day: dayShort(d.date), n: d.meetings }) : `${dayShort(d.date)}: ${fmtDuration(d.booked_minutes)} / ${fmtDuration(d.target_minutes)}${dayOff(d) ? ` · ${dayOff(d)}` : ""}`;
                return (
                  <button
                    key={d.date}
                    type="button"
                    className={`dw-wr-day ${d.future ? "future" : ""} ${d.date === today ? "today" : ""} ${d.missing_minutes > 0 ? "short" : ""}`}
                    onClick={() => openDayReview(d.date)}
                    data-tooltip={label}
                    aria-label={label}
                  >
                    <span className="dw-wr-bar" aria-hidden>
                      <span style={{ height: `${Math.max(share * 100, d.booked_minutes || d.meetings ? 6 : 0)}%` }} />
                    </span>
                    <span className="dw-wr-day-name">{dayShort(d.date).split(" ")[0]}</span>
                  </button>
                );
              })}
            </div>
            <div className="dw-wr-counts">
              <span className="dw-wr-count">
                <CalendarRange size={12} aria-hidden />
                <span className="num">{r.meetings.length}</span> {t("review.md.meetings")}
              </span>
              <span className="dw-wr-count">
                <CheckSquare size={12} aria-hidden />
                <span className="num">{r.tasks.done_total}</span> {t("review.done")}
              </span>
              <span className="dw-wr-count">
                <FileText size={12} aria-hidden />
                <span className="num">{r.pages_total}</span> {t("review.md.pages")}
              </span>
            </div>
            <div className="dw-wr-links">
              <button type="button" className="dw-link" onClick={() => openWeekReview(monday)}>
                {t("week.openReview")}
              </button>
              {r.report_page_id != null && (
                <button type="button" className="dw-link" onClick={() => useApp.getState().openPage(r.report_page_id!)}>
                  {t("week.openReport")}
                </button>
              )}
            </div>
          </div>
        );
      }}
    </Loadable>
  );
}

defineWidget({
  kind: "week_review",
  label: "dash.w.weekReview",
  hint: "dash.w.weekReviewHint",
  group: "day",
  size: { w: 4, h: 7 },
  min: { w: 3, h: 6 },
  config: () => ({}),
  icon: CalendarCheck,
  look: "bars",
  body: WeekReviewWidget,
  opener: () => () => openWeekReview(),
});
